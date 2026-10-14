import { WEAPONS, WEAPON_INDEX } from '@/data/weapons';
import type { PlaylistId } from '@/data/playlists';
import type { Loadout } from '@/data/progression';
import type { BotDifficulty } from '@/game/bots/BotBrain';
import type { GameEvent, GrenadeState, PlayerInput, PlayerState, PlayerStats, RoundPhase, RoundState } from '@/game/sim/types';
import { ByteReader, ByteWriter } from './codec';

// Wire protocol between the host (authoritative simulation) and clients.
//
// Unreliable, unordered channel ('u'), binary:
//   client -> host  INPUT     the newest inputs, each sent 3x for loss tolerance
//   host -> client  SNAPSHOT  30 Hz world state + the receiver's full prediction state
//   both            PING/PONG round-trip measurement
// Reliable, ordered channel ('r'), JSON: room lobby, match start, game events, roster, chat.

export const PROTOCOL_VERSION = 1;

export const MSG = { INPUT: 1, SNAPSHOT: 2, PING: 3, PONG: 4 } as const;

/** Snapshots go out every SNAPSHOT_EVERY ticks (60 Hz sim -> 30 Hz snapshots). */
export const SNAPSHOT_EVERY = 2;
/** How many recent inputs each input packet carries. */
export const INPUT_REDUNDANCY = 3;
export const NO_PLAYER = 255;
/** Input life value meaning "apply aim regardless of respawns". */
const ANY_LIFE = 255;

// ------------------------------------------------------------------ inputs

/** Rounds input values to what survives the wire so client prediction uses identical numbers. */
export function quantizeInput(inp: PlayerInput): PlayerInput {
  inp.mx = Math.round(clamp1(inp.mx) * 127) / 127;
  inp.mz = Math.round(clamp1(inp.mz) * 127) / 127;
  inp.yaw = Math.fround(inp.yaw);
  inp.pitch = Math.fround(inp.pitch);
  inp.viewTick = Math.fround(inp.viewTick);
  inp.buttons &= 0xffff;
  return inp;
}

export function encodeInputs(inputs: PlayerInput[], rttMs: number): Uint8Array {
  const w = new ByteWriter(16 + inputs.length * 20);
  w.u8(MSG.INPUT).u16(rttMs).u8(inputs.length);
  for (const i of inputs) {
    w.u32(i.seq).i8(clamp1(i.mx) * 127).i8(clamp1(i.mz) * 127).f32(i.yaw).f32(i.pitch).u16(i.buttons).u8(i.slot < 0 ? 255 : i.slot).f32(i.viewTick).u8(i.life ?? ANY_LIFE);
  }
  return w.finish();
}

/** Decodes and sanitizes an input packet (never trust the sender). */
export function decodeInputs(r: ByteReader): { rtt: number; inputs: PlayerInput[] } {
  const rtt = r.u16();
  const n = Math.min(r.u8(), 8);
  const inputs: PlayerInput[] = [];
  for (let k = 0; k < n; k++) {
    const seq = r.u32();
    const mx = r.i8() / 127;
    const mz = r.i8() / 127;
    const yaw = finite(r.f32());
    const pitch = Math.max(-1.5, Math.min(1.5, finite(r.f32())));
    const buttons = r.u16();
    const slotRaw = r.u8();
    const viewTick = Math.max(0, finite(r.f32()));
    const lifeRaw = r.u8();
    inputs.push({
      seq, mx: clamp1(mx), mz: clamp1(mz), yaw, pitch, buttons, slot: slotRaw === 0 || slotRaw === 1 ? slotRaw : -1, viewTick,
      life: lifeRaw === ANY_LIFE ? undefined : lifeRaw,
    });
  }
  return { rtt, inputs };
}

// ------------------------------------------------------------------ snapshots

/** Per-player state everyone receives (render + HUD). */
export interface SnapPlayer {
  id: number;
  alive: boolean;
  connected: boolean;
  grounded: boolean;
  sprinting: boolean;
  team: 0 | 1;
  bot: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  crouch: number;
  ads: number;
  hp: number;
  slot: 0 | 1;
  weapon: string;
  flash: number;
  slideT: number;
  mantleT: number;
  reloadT: number;
  reloadTotal: number;
  meleeT: number;
  swapT: number;
  spawnProt: number;
  deadT: number;
  killedBy: number;
  shotCount: number;
}

/** The receiving client's own full simulation state (for reconciliation). */
export type SelfState = Pick<
  PlayerState,
  | 'x' | 'y' | 'z' | 'vx' | 'vy' | 'vz'
  | 'yaw' | 'pitch' | 'crouch' | 'slideT' | 'slideCd' | 'mantleT' | 'sprintBlend' | 'ads' | 'fireCd'
  | 'reloadT' | 'reloadTotal' | 'swapT' | 'meleeT' | 'bloom' | 'lastShotT' | 'spawnProt' | 'sinceHurt'
  | 'hp' | 'flash' | 'deadT'
  | 'shotCount' | 'recoilIdx' | 'prevButtons'
  | 'burstLeft' | 'reloadKind' | 'lethals' | 'tacticals' | 'slot' | 'life'
  | 'grounded' | 'sprinting' | 'alive' | 'meleeHitDone'
  | 'mantleFrom' | 'mantleTo' | 'weapons' | 'lastInputSeq'
>;

const SELF_F64 = ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const;
const SELF_F32 = [
  'yaw', 'pitch', 'crouch', 'slideT', 'slideCd', 'mantleT', 'sprintBlend', 'ads', 'fireCd',
  'reloadT', 'reloadTotal', 'swapT', 'meleeT', 'bloom', 'lastShotT', 'spawnProt', 'sinceHurt',
  'hp', 'flash', 'deadT',
] as const;
const SELF_U16 = ['shotCount', 'recoilIdx', 'prevButtons'] as const;
const SELF_U8 = ['burstLeft', 'reloadKind', 'lethals', 'tacticals', 'slot', 'life'] as const;

export interface Snapshot {
  tick: number;
  /** Last input sequence the host processed for the receiver. */
  ack: number;
  /** Receiver's player id (NO_PLAYER when spectating). */
  selfId: number;
  self: SelfState | null;
  round: RoundState;
  players: SnapPlayer[];
  grenades: GrenadeState[];
}

const PHASES: RoundPhase[] = ['warmup', 'countdown', 'live', 'overtime', 'roundEnd', 'matchEnd'];
const REASONS: RoundState['lastReason'][] = ['', 'elimination', 'capture', 'draw'];

function weaponIndex(id: string): number {
  return WEAPON_INDEX[id] ?? 0;
}
function weaponId(idx: number): string {
  return WEAPONS[idx]?.id ?? WEAPONS[0].id;
}

export function encodeSnapshot(tick: number, round: RoundState, players: PlayerState[], grenades: GrenadeState[], self: PlayerState | null, ack: number): Uint8Array {
  const w = new ByteWriter(256 + players.length * 48);
  w.u8(MSG.SNAPSHOT).u32(tick).u32(ack).u8(self ? self.id : NO_PLAYER);
  if (self) writeSelf(w, self);
  // round
  const c = round.capture;
  w.u8(PHASES.indexOf(round.phase)).f32(round.timer).u8(round.round).u8(round.score[0]).u8(round.score[1]);
  w.u8((c.active ? 1 : 0) | (c.contested ? 2 : 0) | ((c.team + 1) << 2)).f32(c.progress);
  w.i8(round.lastWinner).u8(Math.max(0, REASONS.indexOf(round.lastReason))).i8(round.matchWinner);
  // players
  w.u8(players.length);
  for (const p of players) {
    const flags =
      (p.alive ? 1 : 0) | (p.connected ? 2 : 0) | (p.grounded ? 4 : 0) | (p.sprinting ? 8 : 0) | (p.team ? 16 : 0) | (p.bot ? 32 : 0);
    w.u8(p.id).u8(flags).f32(p.x).f32(p.y).f32(p.z);
    w.i16(p.vx * 100).i16(p.vy * 100).i16(p.vz * 100);
    w.f32(p.yaw).i16(p.pitch * 10000);
    w.q8(p.crouch, 1).q8(p.ads, 1).u8(Math.ceil(Math.max(0, p.hp))).u8(p.slot).u8(weaponIndex(p.weapons[p.slot].id)).q8(p.flash, 1);
    w.q8(p.slideT, 2.55).q8(p.mantleT, 2.55).q8(p.reloadT, 5.1).q8(p.reloadTotal, 5.1).q8(p.meleeT, 2.55).q8(p.swapT, 2.55).q8(p.spawnProt, 10.2);
    w.q8(Math.min(p.deadT, 25.5), 25.5).i8(p.killedBy).u16(p.shotCount);
  }
  // grenades
  w.u8(grenades.length);
  for (const g of grenades) {
    w.u16(g.id).u8(g.owner).u8(g.kind === 'frag' ? 0 : 1).f32(g.x).f32(g.y).f32(g.z).f32(g.vx).f32(g.vy).f32(g.vz).f32(g.fuse);
  }
  return w.finish();
}

function writeSelf(w: ByteWriter, p: PlayerState): void {
  for (const k of SELF_F64) w.f64(p[k]);
  for (const k of SELF_F32) w.f32(p[k]);
  for (const k of SELF_U16) w.u16(p[k]);
  for (const k of SELF_U8) w.u8(p[k]);
  w.u8((p.grounded ? 1 : 0) | (p.sprinting ? 2 : 0) | (p.alive ? 4 : 0) | (p.meleeHitDone ? 8 : 0));
  for (const v of p.mantleFrom) w.f32(v);
  for (const v of p.mantleTo) w.f32(v);
  for (const wr of p.weapons) w.u8(weaponIndex(wr.id)).u8(wr.mag).u16(wr.reserve);
  w.u32(p.lastInputSeq);
}

function readSelf(r: ByteReader): SelfState {
  const s = {} as Record<string, unknown>;
  for (const k of SELF_F64) s[k] = r.f64();
  for (const k of SELF_F32) s[k] = r.f32();
  for (const k of SELF_U16) s[k] = r.u16();
  for (const k of SELF_U8) s[k] = r.u8();
  const f = r.u8();
  s.grounded = (f & 1) !== 0;
  s.sprinting = (f & 2) !== 0;
  s.alive = (f & 4) !== 0;
  s.meleeHitDone = (f & 8) !== 0;
  s.mantleFrom = [r.f32(), r.f32(), r.f32()];
  s.mantleTo = [r.f32(), r.f32(), r.f32()];
  s.weapons = [0, 1].map(() => {
    const id = weaponId(r.u8());
    const mag = r.u8();
    const reserve = r.u16();
    return { id, mag, reserve };
  });
  s.lastInputSeq = r.u32();
  if (s.slot !== 0 && s.slot !== 1) s.slot = 0;
  return s as unknown as SelfState;
}

/** Copies an authoritative self state onto a player (deep-copies the arrays). */
export function applySelf(p: PlayerState, s: SelfState): void {
  for (const k of SELF_F64) p[k] = s[k];
  for (const k of SELF_F32) p[k] = s[k];
  for (const k of SELF_U16) p[k] = s[k];
  p.burstLeft = s.burstLeft;
  p.reloadKind = s.reloadKind;
  p.lethals = s.lethals;
  p.tacticals = s.tacticals;
  p.slot = s.slot;
  p.life = s.life;
  p.grounded = s.grounded;
  p.sprinting = s.sprinting;
  p.alive = s.alive;
  p.meleeHitDone = s.meleeHitDone;
  p.mantleFrom = [...s.mantleFrom] as [number, number, number];
  p.mantleTo = [...s.mantleTo] as [number, number, number];
  p.weapons = [{ ...s.weapons[0] }, { ...s.weapons[1] }];
  p.lastInputSeq = s.lastInputSeq;
}

export function decodeSnapshot(r: ByteReader): Snapshot {
  const tick = r.u32();
  const ack = r.u32();
  const selfId = r.u8();
  const self = selfId !== NO_PLAYER ? readSelf(r) : null;
  const phase = PHASES[r.u8()] ?? 'live';
  const timer = r.f32();
  const roundNo = r.u8();
  const score: [number, number] = [r.u8(), r.u8()];
  const cb = r.u8();
  const progress = r.f32();
  const lastWinner = r.i8() as -1 | 0 | 1;
  const lastReason = REASONS[r.u8()] ?? '';
  const matchWinner = r.i8() as -1 | 0 | 1;
  const round: RoundState = {
    phase,
    timer,
    round: roundNo,
    score,
    capture: { active: (cb & 1) !== 0, contested: (cb & 2) !== 0, team: (((cb >> 2) & 3) - 1) as -1 | 0 | 1, progress },
    lastWinner,
    lastReason,
    matchWinner,
  };
  const n = r.u8();
  const players: SnapPlayer[] = [];
  for (let i = 0; i < n; i++) {
    const id = r.u8();
    const f = r.u8();
    const x = r.f32();
    const y = r.f32();
    const z = r.f32();
    const vx = r.i16() / 100;
    const vy = r.i16() / 100;
    const vz = r.i16() / 100;
    const yaw = r.f32();
    const pitch = r.i16() / 10000;
    const crouch = r.q8(1);
    const ads = r.q8(1);
    const hp = r.u8();
    const slot = (r.u8() === 1 ? 1 : 0) as 0 | 1;
    const weapon = weaponId(r.u8());
    const flash = r.q8(1);
    players.push({
      id, alive: (f & 1) !== 0, connected: (f & 2) !== 0, grounded: (f & 4) !== 0, sprinting: (f & 8) !== 0,
      team: (f & 16 ? 1 : 0) as 0 | 1, bot: (f & 32) !== 0,
      x, y, z, vx, vy, vz, yaw, pitch, crouch, ads, hp, slot, weapon, flash,
      slideT: r.q8(2.55), mantleT: r.q8(2.55), reloadT: r.q8(5.1), reloadTotal: r.q8(5.1), meleeT: r.q8(2.55), swapT: r.q8(2.55),
      spawnProt: r.q8(10.2), deadT: r.q8(25.5), killedBy: r.i8(), shotCount: r.u16(),
    });
  }
  const ng = r.u8();
  const grenades: GrenadeState[] = [];
  for (let i = 0; i < ng; i++) {
    grenades.push({
      id: r.u16(), owner: r.u8(), kind: r.u8() === 0 ? 'frag' : 'flash',
      x: r.f32(), y: r.f32(), z: r.f32(), vx: r.f32(), vy: r.f32(), vz: r.f32(), fuse: r.f32(),
    });
  }
  return { tick, ack, selfId, self, round, players, grenades };
}

export function encodePing(t: number, kind: typeof MSG.PING | typeof MSG.PONG): Uint8Array {
  return new ByteWriter(9).u8(kind).f64(t).finish();
}

// ------------------------------------------------------------------ reliable messages (JSON)

export interface RoomMember {
  pid: string;
  name: string;
  level: number;
  team: 0 | 1;
  ready: boolean;
  host: boolean;
  ping: number;
}

export interface RoomState {
  code: string;
  playlist: PlaylistId;
  fillBots: boolean;
  difficulty: BotDifficulty;
  phase: 'lobby' | 'match';
  members: RoomMember[];
}

export interface MatchPlayerInfo {
  id: number;
  /** Peer id of the human controlling this player (null for bots). */
  pid: string | null;
  name: string;
  team: 0 | 1;
  bot: boolean;
  loadout: Loadout;
}

export interface MatchStart {
  matchId: string;
  playlist: PlaylistId;
  seed: number;
  tick: number;
  players: MatchPlayerInfo[];
}

export interface RosterEntry {
  id: number;
  name: string;
  team: 0 | 1;
  bot: boolean;
  connected: boolean;
  ping: number;
  loadout: Loadout;
  stats: PlayerStats;
}

export interface ChatLine {
  from: string;
  name: string;
  text: string;
  system?: boolean;
}

export type HostMsg =
  | { t: 'room'; room: RoomState }
  | { t: 'reject'; reason: string }
  | { t: 'kick'; reason: string }
  | { t: 'chat'; line: ChatLine }
  | { t: 'start'; match: MatchStart }
  | { t: 'ev'; tick: number; events: GameEvent[] }
  | { t: 'roster'; players: RosterEntry[] }
  | { t: 'lobby' };

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; level: number; loadout: Loadout }
  | { t: 'ready'; ready: boolean }
  | { t: 'team'; team: 0 | 1 }
  | { t: 'loadout'; loadout: Loadout }
  | { t: 'chat'; text: string }
  | { t: 'rtt'; ms: number }
  | { t: 'leave' };

/** Rounds floats in event payloads to 3 decimals to keep JSON small. */
export function compactEvents(events: GameEvent[]): GameEvent[] {
  return events.map((e) => roundDeep(e) as GameEvent);
}

function roundDeep(v: unknown): unknown {
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 1000) / 1000;
  if (Array.isArray(v)) return v.map(roundDeep);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = roundDeep(x);
    return o;
  }
  return v;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Six-character room code without ambiguous glyphs (0/O, 1/I). */
export function randomRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

export function normalizeRoomCode(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

export function isRoomCode(s: string): boolean {
  return s.length === 6 && [...s].every((c) => CODE_ALPHABET.includes(c));
}

function clamp1(v: number): number {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}
function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}
