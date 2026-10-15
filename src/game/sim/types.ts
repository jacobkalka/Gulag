import type { Loadout } from '@/data/progression';
import type { Hitbox } from '@/data/weapons';
import type { Surface } from '@/game/world/mapTypes';

// Simulation state shared by the host (authoritative), the predicting client and bots.

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const BTN = {
  JUMP: 1,
  CROUCH: 2,
  SPRINT: 4,
  FIRE: 8,
  ADS: 16,
  RELOAD: 32,
  MELEE: 64,
  SWAP: 128,
  LETHAL: 256,
  TACTICAL: 512,
  INTERACT: 1024,
  INSPECT: 2048,
  FLASHLIGHT: 4096,
} as const;

export interface PlayerInput {
  seq: number;
  /** Strafe axis, -1 (left) .. 1 (right). */
  mx: number;
  /** Forward axis, -1 (back) .. 1 (forward). */
  mz: number;
  yaw: number;
  pitch: number;
  buttons: number;
  /** Desired weapon slot (0 primary, 1 secondary). */
  slot: number;
  /** Fractional host tick the client was rendering remote players at (lag compensation). */
  viewTick: number;
  /**
   * Life counter (0..254) the input was produced for. Aim from inputs made before the sender
   * saw a respawn is ignored so the spawn orientation sticks. Omitted = always apply (bots).
   */
  life?: number;
}

export function emptyInput(seq = 0, yaw = 0, pitch = 0, slot = 0): PlayerInput {
  return { seq, mx: 0, mz: 0, yaw, pitch, buttons: 0, slot, viewTick: 0 };
}

export interface WeaponRT {
  id: string;
  mag: number;
  reserve: number;
}

export interface PlayerStats {
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  headshots: number;
  shots: number;
  hits: number;
  captures: number;
  roundsWon: number;
}

export function emptyStats(): PlayerStats {
  return { kills: 0, deaths: 0, assists: 0, damage: 0, headshots: 0, shots: 0, hits: 0, captures: 0, roundsWon: 0 };
}

export interface PlayerState {
  id: number;
  team: 0 | 1;
  name: string;
  bot: boolean;
  connected: boolean;
  alive: boolean;
  hp: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  /** 0 = standing, 1 = fully crouched (smoothed). */
  crouch: number;
  grounded: boolean;
  slideT: number;
  slideCd: number;
  mantleT: number;
  mantleFrom: [number, number, number];
  mantleTo: [number, number, number];
  sprinting: boolean;
  /** 1 while sprinting; decays at 1/sprintToFire before firing is allowed. */
  sprintBlend: number;
  ads: number;
  slot: 0 | 1;
  weapons: [WeaponRT, WeaponRT];
  fireCd: number;
  burstLeft: number;
  reloadT: number;
  reloadTotal: number;
  /** 0 magazine, 1 empty magazine, 2 per-round. */
  reloadKind: number;
  swapT: number;
  meleeT: number;
  meleeHitDone: boolean;
  bloom: number;
  shotCount: number;
  recoilIdx: number;
  lastShotT: number;
  /** Button state from the previous processed input (edge detection). */
  prevButtons: number;
  spawnProt: number;
  sinceHurt: number;
  /** Seconds left in which a jump still works after walking off a ledge. */
  coyoteT: number;
  /** Seconds left in which a jump press made in the air fires on landing. */
  jumpBufT: number;
  /** Player declared touchpad input mode (host applies the touchpad tuning from weapons.ts). */
  touchpad: boolean;
  /** Weapon-mounted flashlight on (toggled with the flashlight key; seen by everyone). */
  flashlight: boolean;
  lethals: number;
  tacticals: number;
  flash: number;
  stats: PlayerStats;
  /** Damage received this life, per attacker id (assists). */
  damageFrom: Record<number, number>;
  lastInputSeq: number;
  loadout: Loadout;
  /** Seconds since death (spectating). */
  deadT: number;
  /** Who killed this player (for the kill cam / spectate). */
  killedBy: number;
  /** Incremented on every spawn (wraps at 255). */
  life: number;
}

export type RoundPhase = 'warmup' | 'countdown' | 'live' | 'overtime' | 'roundEnd' | 'matchEnd';

export interface CaptureState {
  active: boolean;
  /** Team currently owning progress (-1 none). */
  team: -1 | 0 | 1;
  progress: number;
  contested: boolean;
}

export interface RoundState {
  phase: RoundPhase;
  /** Seconds left in the current phase (live: round clock). */
  timer: number;
  round: number;
  score: [number, number];
  capture: CaptureState;
  /** Winner of the last finished round (-1 draw). */
  lastWinner: -1 | 0 | 1;
  lastReason: 'elimination' | 'capture' | 'draw' | '';
  matchWinner: -1 | 0 | 1;
  /** Team wearing the black-and-red soldiers this match (the other wears woodland camo). */
  skinTeam: 0 | 1;
}

export interface ShotTrace {
  shooter: number;
  weapon: string;
  ox: number;
  oy: number;
  oz: number;
  ex: number;
  ey: number;
  ez: number;
  /** Surface normal at the end point (zero if it hit a player or nothing). */
  nx: number;
  ny: number;
  nz: number;
  surface: Surface | 'flesh' | 'none';
  hitPlayer: number;
  pellet: number;
  /** Shooter's shot number (matches the 'fire' event). */
  shot: number;
}

export type GameEvent =
  | { type: 'shot'; trace: ShotTrace; /** Client only: the tracer was already drawn by prediction. */ impactOnly?: boolean }
  | { type: 'fire'; shooter: number; weapon: string; /** shooter's shot number */ n: number }
  | { type: 'damage'; attacker: number; victim: number; amount: number; hitbox: Hitbox; x: number; y: number; z: number; weapon: string; killed: boolean }
  | { type: 'kill'; killer: number; victim: number; weapon: string; headshot: boolean; assister: number }
  | { type: 'reload'; player: number; weapon: string; duration: number; kind: number }
  | { type: 'swap'; player: number; slot: number }
  | { type: 'melee'; player: number; hit: boolean }
  | { type: 'jump'; player: number }
  | { type: 'land'; player: number; speed: number }
  | { type: 'roundStart'; round: number }
  | { type: 'roundLive'; round: number }
  | { type: 'overtime'; round: number }
  | { type: 'roundEnd'; round: number; winner: -1 | 0 | 1; reason: string }
  | { type: 'matchEnd'; winner: -1 | 0 | 1 }
  | { type: 'capture'; team: 0 | 1 }
  | { type: 'spawn'; player: number }
  | { type: 'grenade'; owner: number; kind: 'frag' | 'flash'; x: number; y: number; z: number }
  | { type: 'explode'; owner: number; kind: 'frag' | 'flash'; x: number; y: number; z: number };

export interface GrenadeState {
  id: number;
  owner: number;
  kind: 'frag' | 'flash';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  fuse: number;
}
