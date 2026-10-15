import type { MapDef } from '@/game/world/mapTypes';
import { CollisionWorld, OPAQUE } from '@/game/world/collision';
import type { MatchRules } from '@/data/playlists';
import { damageAt, getWeapon, hitboxMultiplier, touchpadForgiveness, type Hitbox } from '@/data/weapons';
import { DEFAULT_LOADOUT, type Loadout } from '@/data/progression';
import { HEALTH, regenAmount } from '@/data/gameplay';
import { Rng } from '@/shared/rng';
import { DT, TICK_RATE, BTN, emptyStats, type GameEvent, type GrenadeState, type PlayerInput, type PlayerState, type RoundState, type ShotTrace } from './types';
import { MOVE, eyeHeight, stepMovement } from './movement';
import { activeWeapon, spreadDirection, stepWeapon, type FireRequest } from './weaponLogic';
import { PoseHistory, rayVsBody, type BodyPose } from './hitboxes';

export interface SimPlayerConfig {
  id: number;
  team: 0 | 1;
  name: string;
  bot: boolean;
  loadout?: Loadout;
  /** Touchpad input mode (lower hip spread, hit forgiveness). */
  touchpad?: boolean;
}

export const MAX_RANGE = 160;
const LAG_COMP_MAX_TICKS = Math.round(0.25 * TICK_RATE);
const MELEE_DAMAGE = 60;
const MELEE_BACKSTAB = 120;

export function makePlayer(cfg: SimPlayerConfig): PlayerState {
  const lo = cfg.loadout ?? DEFAULT_LOADOUT;
  return {
    id: cfg.id, team: cfg.team, name: cfg.name, bot: cfg.bot, connected: true, alive: false, hp: HEALTH.max,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, crouch: 0, grounded: true,
    slideT: 0, slideCd: 0, mantleT: 0, mantleFrom: [0, 0, 0], mantleTo: [0, 0, 0],
    sprinting: false, sprintBlend: 0, ads: 0, slot: 0,
    weapons: [
      { id: lo.primary, mag: getWeapon(lo.primary).magSize, reserve: getWeapon(lo.primary).reserve },
      { id: lo.secondary, mag: getWeapon(lo.secondary).magSize, reserve: getWeapon(lo.secondary).reserve },
    ],
    fireCd: 0, burstLeft: 0, reloadT: 0, reloadTotal: 0, reloadKind: 0, swapT: 0, meleeT: 0, meleeHitDone: true,
    bloom: 0, shotCount: 0, recoilIdx: 0, lastShotT: -10, prevButtons: 0, spawnProt: 0, sinceHurt: 99, coyoteT: 0, jumpBufT: 0, touchpad: !!cfg.touchpad,
    lethals: 1, tacticals: 1, flash: 0, stats: emptyStats(), damageFrom: {}, lastInputSeq: 0, loadout: { ...lo },
    deadT: 0, killedBy: -1, life: 0,
  };
}

/**
 * Movement + weapon state for one player and one tick. Shared by the host simulation and the
 * client's prediction so both evolve the local player identically.
 */
export function stepPlayerCore(p: PlayerState, inp: PlayerInput, world: CollisionWorld, frozen: boolean, combat: boolean, now: number, events: GameEvent[]): FireRequest | null {
  const w = activeWeapon(p);
  const mv = stepMovement(p, inp, world, DT, frozen, w);
  if (mv.jumped) events.push({ type: 'jump', player: p.id });
  if (mv.landed > 4) events.push({ type: 'land', player: p.id, speed: mv.landed });
  return stepWeapon(p, inp, DT, frozen || !combat, now, events);
}

/** End-of-tick bookkeeping (edge detection state, timers, health regen). */
export function finishPlayerStep(p: PlayerState, inp: PlayerInput): void {
  p.prevButtons = inp.buttons;
  p.lastInputSeq = inp.seq;
  if (p.spawnProt > 0) p.spawnProt -= DT;
  if (p.flash > 0) p.flash = Math.max(0, p.flash - DT / 2.6);
  p.sinceHurt += DT;
  if (p.alive && p.hp < HEALTH.max) p.hp = Math.min(HEALTH.max, p.hp + regenAmount(p.sinceHurt, DT));
}

export function isFrozen(phase: RoundState['phase']): boolean {
  return phase === 'countdown' || phase === 'roundEnd' || phase === 'matchEnd' || phase === 'warmup';
}

export function isCombat(phase: RoundState['phase']): boolean {
  return phase === 'live' || phase === 'overtime';
}

export function poseOf(p: PlayerState): BodyPose {
  return { x: p.x, y: p.y, z: p.z, crouch: p.crouch, slide: p.slideT > 0, yaw: p.yaw };
}

export class GameSim {
  readonly world: CollisionWorld;
  readonly players: PlayerState[] = [];
  readonly grenades: GrenadeState[] = [];
  readonly history = new Map<number, PoseHistory>();
  events: GameEvent[] = [];
  tick = 0;
  round: RoundState = {
    phase: 'warmup',
    timer: 0,
    round: 0,
    score: [0, 0],
    capture: { active: false, team: -1, progress: 0, contested: false },
    lastWinner: -1,
    lastReason: '',
    matchWinner: -1,
  };
  private rng: Rng;
  private nextGrenadeId = 1;
  private spawnOrder: [number[], number[]] = [[], []];
  /** When false, rounds never end on elimination (sandbox / tests). */
  eliminationEnabled = true;

  constructor(
    readonly map: MapDef,
    readonly rules: MatchRules,
    seed = 1,
    world?: CollisionWorld,
  ) {
    this.world = world ?? CollisionWorld.fromMap(map, rules.mapTags);
    this.rng = new Rng(seed);
  }

  get time(): number {
    return this.tick * DT;
  }

  player(id: number): PlayerState | undefined {
    return this.players.find((p) => p.id === id);
  }

  addPlayer(cfg: SimPlayerConfig): PlayerState {
    const existing = this.player(cfg.id);
    if (existing) return existing;
    const p = makePlayer(cfg);
    this.players.push(p);
    this.history.set(p.id, new PoseHistory(64));
    // late joiners wait for the next round as spectators
    if (this.round.phase === 'countdown') this.spawnPlayer(p, this.teamCount(p.team) - 1);
    return p;
  }

  removePlayer(id: number): void {
    const p = this.player(id);
    if (!p) return;
    p.connected = false;
    p.alive = false;
  }

  setLoadout(id: number, l: Loadout): void {
    const p = this.player(id);
    if (!p) return;
    p.loadout = { ...l };
    // during the countdown the change applies immediately
    if (this.round.phase === 'countdown' && p.alive) this.giveWeapons(p);
  }

  private teamCount(team: 0 | 1): number {
    return this.players.filter((p) => p.team === team && p.connected).length;
  }

  start(): void {
    this.round.score = [0, 0];
    this.round.round = 0;
    for (const p of this.players) p.stats = emptyStats();
    this.startRound();
  }

  private giveWeapons(p: PlayerState): void {
    const pr = getWeapon(p.loadout.primary);
    const se = getWeapon(p.loadout.secondary);
    p.weapons = [
      { id: pr.id, mag: pr.magSize, reserve: pr.reserve },
      { id: se.id, mag: se.magSize, reserve: se.reserve },
    ];
    p.slot = 0;
    p.lethals = p.loadout.lethal && p.loadout.lethal !== 'none' ? 1 : 0;
    p.tacticals = p.loadout.tactical && p.loadout.tactical !== 'none' ? 1 : 0;
    p.reloadT = 0;
    p.swapT = 0;
    p.fireCd = 0;
    p.burstLeft = 0;
  }

  private spawnPlayer(p: PlayerState, idx: number): void {
    const spawns = this.map.spawns.filter((s) => s.team === p.team);
    const order = this.spawnOrder[p.team];
    const s = spawns[order.length ? order[idx % order.length] : idx % spawns.length] ?? spawns[0];
    p.x = s.pos[0];
    p.y = s.pos[1];
    p.z = s.pos[2];
    p.vx = p.vy = p.vz = 0;
    p.yaw = s.yaw;
    p.pitch = 0;
    p.alive = p.connected;
    p.hp = HEALTH.max;
    p.crouch = 0;
    p.grounded = true;
    p.slideT = 0;
    p.mantleT = 0;
    p.ads = 0;
    p.sprinting = false;
    p.sprintBlend = 0;
    p.bloom = 0;
    p.flash = 0;
    p.meleeT = 0;
    p.sinceHurt = 99;
    p.damageFrom = {};
    p.deadT = 0;
    p.killedBy = -1;
    p.spawnProt = this.rules.spawnProtection + this.rules.countdown;
    p.life = (p.life + 1) % 255; // 255 is reserved on the wire for "any life"
    this.giveWeapons(p);
    this.history.get(p.id)?.clear();
    this.events.push({ type: 'spawn', player: p.id });
  }

  private startRound(): void {
    this.round.round += 1;
    this.round.phase = 'countdown';
    this.round.timer = this.rules.countdown;
    this.round.capture = { active: false, team: -1, progress: 0, contested: false };
    this.grenades.length = 0;
    for (const team of [0, 1] as const) {
      const n = this.map.spawns.filter((s) => s.team === team).length;
      const order = Array.from({ length: n }, (_, i) => i);
      // keep a fair arrangement: center-out ordering with a little shuffle each round
      order.sort((a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2) + (this.rng.next() - 0.5) * 0.5);
      this.spawnOrder[team] = order;
    }
    const counters = [0, 0];
    for (const p of this.players) {
      if (!p.connected) continue;
      this.spawnPlayer(p, counters[p.team]++);
    }
    this.events.push({ type: 'roundStart', round: this.round.round });
  }

  private endRound(winner: -1 | 0 | 1, reason: RoundState['lastReason']): void {
    if (this.round.phase === 'roundEnd' || this.round.phase === 'matchEnd') return;
    this.round.phase = 'roundEnd';
    this.round.timer = this.rules.roundEndDelay;
    this.round.lastWinner = winner;
    this.round.lastReason = reason;
    this.round.capture.active = false;
    if (winner === 0 || winner === 1) {
      this.round.score[winner] += 1;
      for (const p of this.players) if (p.team === winner && p.connected) p.stats.roundsWon += 1;
    }
    this.events.push({ type: 'roundEnd', round: this.round.round, winner, reason });
  }

  /** Advances the simulation by one tick. `inputFor` supplies each connected player's input. */
  step(inputFor: (p: PlayerState) => PlayerInput | null): void {
    this.events = [];
    this.tick += 1;
    const now = this.time;
    const r = this.round;
    // ---- phase timers
    if (r.phase === 'countdown') {
      r.timer -= DT;
      if (r.timer <= 0) {
        r.phase = 'live';
        r.timer = this.rules.roundTime;
        this.events.push({ type: 'roundLive', round: r.round });
      }
    } else if (r.phase === 'live') {
      r.timer -= DT;
      if (r.timer <= 0) {
        r.phase = 'overtime';
        r.timer = 0;
        r.capture.active = true;
        this.events.push({ type: 'overtime', round: r.round });
      }
    } else if (r.phase === 'overtime') {
      r.timer += DT;
      if (r.timer >= this.rules.overtimeLimit && !r.capture.contested && r.capture.progress <= 0) this.suddenDeath();
    } else if (r.phase === 'roundEnd') {
      r.timer -= DT;
      if (r.timer <= 0) {
        const winner = r.score[0] >= this.rules.roundsToWin ? 0 : r.score[1] >= this.rules.roundsToWin ? 1 : -1;
        if (winner >= 0) {
          r.phase = 'matchEnd';
          r.matchWinner = winner as 0 | 1;
          this.events.push({ type: 'matchEnd', winner: winner as 0 | 1 });
        } else this.startRound();
      }
    }
    const frozen = isFrozen(r.phase);
    const combat = isCombat(r.phase);

    // ---- players
    for (const p of this.players) {
      if (!p.connected) continue;
      const inp = inputFor(p);
      if (!p.alive) {
        p.deadT += DT;
        if (inp) {
          p.prevButtons = inp.buttons;
          p.lastInputSeq = inp.seq;
        }
        continue;
      }
      if (!inp) continue;
      const fire = stepPlayerCore(p, inp, this.world, frozen, combat, now, this.events);
      if (fire) this.resolveShot(p, fire);
      this.stepMelee(p);
      if (combat && p.meleeT <= 0 && p.swapT <= 0) this.tryThrow(p, inp);
      finishPlayerStep(p, inp);
    }
    this.separatePlayers();
    this.stepGrenades();
    for (const p of this.players) this.history.get(p.id)?.push(this.tick, poseOf(p), p.alive);

    // ---- win conditions
    if (combat && this.eliminationEnabled) {
      const alive = [0, 0];
      const present = [0, 0];
      for (const p of this.players) {
        if (!p.connected) continue;
        present[p.team]++;
        if (p.alive) alive[p.team]++;
      }
      if (present[0] > 0 && present[1] > 0) {
        if (alive[0] === 0 && alive[1] === 0) this.endRound(-1, 'draw');
        else if (alive[0] === 0) this.endRound(1, 'elimination');
        else if (alive[1] === 0) this.endRound(0, 'elimination');
      }
    }
    if (r.phase === 'overtime') this.stepCapture();
  }

  /** Overtime ran out with nobody on the point: more survivors wins, then more total health. */
  private suddenDeath(): void {
    const alive = [0, 0];
    const hp = [0, 0];
    for (const p of this.players) {
      if (!p.alive) continue;
      alive[p.team]++;
      hp[p.team] += p.hp;
    }
    let winner: -1 | 0 | 1 = -1;
    if (alive[0] !== alive[1]) winner = alive[0] > alive[1] ? 0 : 1;
    else if (Math.abs(hp[0] - hp[1]) > 1) winner = hp[0] > hp[1] ? 0 : 1;
    this.endRound(winner, winner < 0 ? 'draw' : 'elimination');
  }

  private stepCapture(): void {
    const c = this.round.capture;
    const cp = this.map.capture;
    const rad = this.rules.captureRadius;
    const inside = [0, 0];
    for (const p of this.players) {
      if (!p.alive) continue;
      if (Math.hypot(p.x - cp.pos[0], p.z - cp.pos[2]) <= rad && Math.abs(p.y - cp.pos[1]) < 2) inside[p.team]++;
    }
    c.contested = inside[0] > 0 && inside[1] > 0;
    const rate = DT / this.rules.captureTime;
    if (c.contested) return;
    const team = inside[0] > 0 ? 0 : inside[1] > 0 ? 1 : -1;
    if (team < 0) {
      c.progress = Math.max(0, c.progress - DT * 0.08);
      if (c.progress === 0) c.team = -1;
      return;
    }
    if (c.team === -1 || c.team === team) {
      c.team = team as 0 | 1;
      c.progress += rate * (1 + 0.3 * (inside[team] - 1));
    } else {
      c.progress -= rate * 2;
      if (c.progress <= 0) {
        c.progress = 0;
        c.team = team as 0 | 1;
      }
    }
    if (c.progress >= 1 && c.team >= 0) {
      c.progress = 1;
      for (const p of this.players) {
        if (p.alive && p.team === c.team && Math.hypot(p.x - cp.pos[0], p.z - cp.pos[2]) <= rad) p.stats.captures += 1;
      }
      this.events.push({ type: 'capture', team: c.team });
      this.endRound(c.team, 'capture');
    }
  }

  private separatePlayers(): void {
    const r2 = MOVE.radius * 2;
    for (let i = 0; i < this.players.length; i++) {
      const a = this.players[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < this.players.length; j++) {
        const b = this.players[j];
        if (!b.alive || Math.abs(a.y - b.y) > 1.6) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= r2 || d < 1e-4) continue;
        const push = (r2 - d) * 0.5;
        const nx = dx / d;
        const nz = dz / d;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        this.world.resolveCylinder(a, MOVE.radius, MOVE.standH, MOVE.step);
        this.world.resolveCylinder(b, MOVE.radius, MOVE.standH, MOVE.step);
      }
    }
  }

  /** Pose of `target` as the shooter saw it (lag compensation), or current. */
  private targetPose(target: PlayerState, viewTick: number, out: BodyPose): boolean {
    if (viewTick > 0 && viewTick < this.tick) {
      const t = Math.max(viewTick, this.tick - LAG_COMP_MAX_TICKS);
      const hist = this.history.get(target.id);
      if (hist && hist.sample(t, out)) return true;
    }
    if (!target.alive) return false;
    Object.assign(out, poseOf(target));
    return true;
  }

  private resolveShot(p: PlayerState, f: FireRequest): void {
    const w = f.weapon;
    const ox = p.x;
    const oy = p.y + eyeHeight(p);
    const oz = p.z;
    const pellets = w.pellets ?? 1;
    const dmgBy = new Map<number, { amount: number; hitbox: Hitbox; x: number; y: number; z: number; head: boolean }>();
    const pose: BodyPose = { x: 0, y: 0, z: 0, crouch: 0, slide: false, yaw: 0 };
    let anyHit = false;
    const inflate = p.touchpad ? touchpadForgiveness() : 0;
    for (let k = 0; k < pellets; k++) {
      const [dx, dy, dz] = spreadDirection(f.yaw, f.pitch, f.spread, f.seed, k, w.pelletSpread ?? 0);
      const wall = this.world.raycast(ox, oy, oz, dx, dy, dz, MAX_RANGE, OPAQUE);
      let maxT = wall ? wall.t : MAX_RANGE;
      let victim: PlayerState | null = null;
      let hitbox: Hitbox = 'chest';
      for (const t of this.players) {
        if (t === p || !t.connected) continue;
        if (t.team === p.team && !this.rules.friendlyFire) continue;
        if (!this.targetPose(t, f.viewTick, pose)) continue;
        if (!t.alive) continue;
        const h = rayVsBody(ox, oy, oz, dx, dy, dz, maxT, pose, inflate);
        if (h && h.t < maxT) {
          maxT = h.t;
          victim = t;
          hitbox = h.hitbox;
        }
      }
      const ex = ox + dx * maxT;
      const ey = oy + dy * maxT;
      const ez = oz + dz * maxT;
      const trace: ShotTrace = {
        shooter: p.id, weapon: w.id, ox, oy, oz, ex, ey, ez,
        nx: 0, ny: 0, nz: 0, surface: 'none', hitPlayer: -1, pellet: k, shot: p.shotCount,
      };
      if (victim) {
        trace.surface = 'flesh';
        trace.hitPlayer = victim.id;
        anyHit = true;
        const amount = damageAt(w, maxT) * hitboxMultiplier(w, hitbox);
        const prev = dmgBy.get(victim.id);
        if (prev) {
          prev.amount += amount;
          if (hitbox === 'head') prev.head = true;
        } else dmgBy.set(victim.id, { amount, hitbox, x: ex, y: ey, z: ez, head: hitbox === 'head' });
      } else if (wall) {
        trace.nx = wall.nx;
        trace.ny = wall.ny;
        trace.nz = wall.nz;
        trace.surface = wall.surface;
      }
      this.events.push({ type: 'shot', trace });
    }
    if (anyHit) p.stats.hits += 1;
    for (const [vid, d] of dmgBy) {
      const v = this.player(vid);
      if (v) this.applyDamage(p, v, d.amount, d.head ? 'head' : d.hitbox, w.id, d.x, d.y, d.z);
    }
  }

  applyDamage(attacker: PlayerState | null, victim: PlayerState, amount: number, hitbox: Hitbox, weapon: string, x: number, y: number, z: number): void {
    if (!victim.alive || amount <= 0) return;
    if (victim.spawnProt > 0) return;
    const dealt = Math.min(victim.hp, amount);
    victim.hp -= amount;
    victim.sinceHurt = 0;
    const aid = attacker ? attacker.id : -1;
    if (attacker && attacker !== victim) {
      victim.damageFrom[aid] = (victim.damageFrom[aid] ?? 0) + dealt;
      attacker.stats.damage += Math.round(dealt);
    }
    const killed = victim.hp <= 0;
    this.events.push({ type: 'damage', attacker: aid, victim: victim.id, amount: Math.round(amount), hitbox, x, y, z, weapon, killed });
    if (killed) this.kill(attacker, victim, weapon, hitbox === 'head');
  }

  private kill(attacker: PlayerState | null, victim: PlayerState, weapon: string, headshot: boolean): void {
    victim.alive = false;
    victim.hp = 0;
    victim.deadT = 0;
    victim.killedBy = attacker ? attacker.id : -1;
    victim.stats.deaths += 1;
    victim.ads = 0;
    victim.sprinting = false;
    let assister = -1;
    if (attacker && attacker !== victim && attacker.team !== victim.team) {
      attacker.stats.kills += 1;
      if (headshot) attacker.stats.headshots += 1;
      let best = 24;
      for (const [k, v] of Object.entries(victim.damageFrom)) {
        const id = Number(k);
        if (id === attacker.id) continue;
        if (v > best) {
          best = v;
          assister = id;
        }
      }
      if (assister >= 0) {
        const a = this.player(assister);
        if (a && a.team === attacker.team) a.stats.assists += 1;
        else assister = -1;
      }
    }
    this.events.push({ type: 'kill', killer: attacker ? attacker.id : -1, victim: victim.id, weapon, headshot, assister });
  }

  private stepMelee(p: PlayerState): void {
    if (p.meleeT <= 0 || p.meleeHitDone) return;
    // hit lands ~0.18 s into the swing
    if (p.meleeT > 0.44) return;
    p.meleeHitDone = true;
    const ox = p.x;
    const oy = p.y + eyeHeight(p) - 0.1;
    const oz = p.z;
    const dx = -Math.sin(p.yaw) * Math.cos(p.pitch);
    const dy = Math.sin(p.pitch);
    const dz = -Math.cos(p.yaw) * Math.cos(p.pitch);
    const wall = this.world.raycast(ox, oy, oz, dx, dy, dz, 2.0, OPAQUE);
    const maxT = wall ? wall.t : 2.0;
    let best: PlayerState | null = null;
    let bestT = maxT;
    for (const t of this.players) {
      if (t === p || !t.alive || (t.team === p.team && !this.rules.friendlyFire)) continue;
      // generous melee: test a slightly fat ray by checking a few offsets
      for (const off of [0, 0.25, -0.25]) {
        const h = rayVsBody(ox, oy + off * 0.5, oz, dx, dy, dz, bestT, poseOf(t));
        if (h && h.t < bestT) {
          bestT = h.t;
          best = t;
        }
      }
    }
    this.events.push({ type: 'melee', player: p.id, hit: !!best });
    if (best) {
      // backstab: attacker roughly behind the victim
      const vf = [-Math.sin(best.yaw), -Math.cos(best.yaw)];
      const toA = [p.x - best.x, p.z - best.z];
      const l = Math.hypot(toA[0], toA[1]) || 1;
      const behind = (vf[0] * toA[0] + vf[1] * toA[1]) / l < -0.5;
      this.applyDamage(p, best, behind ? MELEE_BACKSTAB : MELEE_DAMAGE, 'chest', 'melee', best.x, best.y + 1.2, best.z);
    }
  }

  private tryThrow(p: PlayerState, inp: PlayerInput): void {
    const lethal = (inp.buttons & BTN.LETHAL) !== 0 && (p.prevButtons & BTN.LETHAL) === 0;
    const tactical = (inp.buttons & BTN.TACTICAL) !== 0 && (p.prevButtons & BTN.TACTICAL) === 0;
    let kind: 'frag' | 'flash' | null = null;
    if (lethal && p.lethals > 0 && p.loadout.lethal === 'frag') {
      kind = 'frag';
      p.lethals--;
    } else if (tactical && p.tacticals > 0 && p.loadout.tactical === 'flash') {
      kind = 'flash';
      p.tacticals--;
    }
    if (!kind) return;
    const cp = Math.cos(p.pitch);
    const dx = -Math.sin(p.yaw) * cp;
    const dy = Math.sin(p.pitch);
    const dz = -Math.cos(p.yaw) * cp;
    const speed = kind === 'frag' ? 15 : 17;
    const ey = p.y + eyeHeight(p) - 0.15;
    const g: GrenadeState = {
      id: this.nextGrenadeId++, owner: p.id, kind,
      x: p.x + dx * 0.4, y: ey, z: p.z + dz * 0.4,
      vx: dx * speed + p.vx * 0.5, vy: dy * speed + 3.2, vz: dz * speed + p.vz * 0.5,
      fuse: kind === 'frag' ? 2.4 : 1.7,
    };
    this.grenades.push(g);
    this.events.push({ type: 'grenade', owner: p.id, kind, x: g.x, y: g.y, z: g.z });
  }

  private stepGrenades(): void {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= DT;
      g.vy -= 20 * DT;
      const len = Math.hypot(g.vx, g.vy, g.vz) * DT;
      if (len > 1e-5) {
        const hit = this.world.raycast(g.x, g.y, g.z, g.vx * DT, g.vy * DT, g.vz * DT, 1, OPAQUE);
        if (hit) {
          g.x = hit.x + hit.nx * 0.06;
          g.y = hit.y + hit.ny * 0.06;
          g.z = hit.z + hit.nz * 0.06;
          const vn = g.vx * hit.nx + g.vy * hit.ny + g.vz * hit.nz;
          g.vx = (g.vx - 2 * vn * hit.nx) * 0.42;
          g.vy = (g.vy - 2 * vn * hit.ny) * 0.42;
          g.vz = (g.vz - 2 * vn * hit.nz) * 0.42;
          if (hit.ny > 0.7 && Math.abs(g.vy) < 1.2) {
            g.vy = 0;
            g.vx *= 0.8;
            g.vz *= 0.8;
          }
        } else {
          g.x += g.vx * DT;
          g.y += g.vy * DT;
          g.z += g.vz * DT;
        }
      }
      if (g.fuse <= 0) {
        this.explode(g);
        this.grenades.splice(i, 1);
      }
    }
  }

  private explode(g: GrenadeState): void {
    this.events.push({ type: 'explode', owner: g.owner, kind: g.kind, x: g.x, y: g.y, z: g.z });
    const owner = this.player(g.owner) ?? null;
    for (const t of this.players) {
      if (!t.alive) continue;
      const ty = t.y + 1.0;
      const d = Math.hypot(t.x - g.x, ty - g.y, t.z - g.z);
      if (g.kind === 'frag') {
        if (d > 6.5) continue;
        if (owner && t.team === owner.team && t !== owner && !this.rules.friendlyFire) continue;
        if (!this.world.lineOfSight(g.x, g.y + 0.1, g.z, t.x, ty, t.z)) continue;
        const dmg = 140 * Math.pow(Math.max(0, 1 - d / 6.5), 1.3);
        this.applyDamage(owner, t, dmg, 'chest', 'frag', t.x, ty, t.z);
      } else {
        if (d > 20) continue;
        const ey = t.y + eyeHeight(t);
        if (!this.world.lineOfSight(g.x, g.y + 0.1, g.z, t.x, ey, t.z)) continue;
        const fx = -Math.sin(t.yaw) * Math.cos(t.pitch);
        const fy = Math.sin(t.pitch);
        const fz = -Math.cos(t.yaw) * Math.cos(t.pitch);
        const to = [(g.x - t.x) / d, (g.y - ey) / d, (g.z - t.z) / d];
        const facing = Math.max(0, fx * to[0] + fy * to[1] + fz * to[2]);
        const amt = Math.min(1, (1 - d / 20) * (0.35 + 0.9 * facing) * 1.3);
        t.flash = Math.max(t.flash, amt);
      }
    }
  }

  /** Teams' alive counts (HUD). */
  aliveCounts(): [number, number] {
    const c: [number, number] = [0, 0];
    for (const p of this.players) if (p.alive) c[p.team]++;
    return c;
  }
}
