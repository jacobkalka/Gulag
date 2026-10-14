import type { GameSim } from '@/game/sim/GameSim';
import { BTN, DT, type GameEvent, type PlayerInput, type PlayerState } from '@/game/sim/types';
import { eyeHeight } from '@/game/sim/movement';
import { activeWeapon, recoilKick } from '@/game/sim/weaponLogic';
import { OPAQUE } from '@/game/world/collision';
import { DEG, angleDiff, clamp, wrapAngle } from '@/shared/math';
import { Rng } from '@/shared/rng';
import type { CoverSpot, NavGrid } from './NavGrid';

// Bot AI: perceives enemies like a player would (view cone + line of sight, gunfire,
// damage), aims with reaction time and settling error, fights from cover and peeks.

export type BotDifficulty = 'recruit' | 'regular' | 'veteran';

const DIFF: Record<BotDifficulty, { reaction: number; aimErr: number; settle: number; turn: number; head: number; comp: number; strafe: number; fov: number; nade: number }> = {
  recruit: { reaction: 0.62, aimErr: 7.5, settle: 1.25, turn: 230, head: 0.05, comp: 0.35, strafe: 0.45, fov: 105, nade: 0.2 },
  regular: { reaction: 0.4, aimErr: 4.6, settle: 0.8, turn: 360, head: 0.14, comp: 0.62, strafe: 0.75, fov: 118, nade: 0.5 },
  veteran: { reaction: 0.25, aimErr: 2.8, settle: 0.5, turn: 560, head: 0.28, comp: 0.85, strafe: 1.0, fov: 130, nade: 0.85 },
};

/** Frag launch model mirrored from GameSim.tryThrow (speed, upward boost, gravity). */
const FRAG_SPEED = 15;
const FRAG_UP = 3.2;
const GRAVITY = 20;

type State = 'idle' | 'roam' | 'engage' | 'cover' | 'peek' | 'hunt' | 'objective';

interface Mem {
  x: number;
  y: number;
  z: number;
  lastSeen: number;
  firstSeen: number;
  visible: boolean;
}

/** Strategic points of interest for Sublevel 9 (x, z), roughly ordered west → east. */
const POIS: [number, number][] = [
  [-14, 2.5], [-14, -2.5], [-11, 9], [-5, 8], [-6, 15.5], [-11, -8.2], [-8, -15.8], [-5, 3], [-5, -3],
  [0, 8.2], [0, 15.5], [0, -6.8], [0, -15.8], [0, 0],
  [5, 3], [5, -3], [5, 8], [6, 15.5], [8, -15.8], [11, -8.2], [11, 9], [14, 2.5], [14, -2.5],
];

export class BotBrain {
  readonly diff: (typeof DIFF)[BotDifficulty];
  private rng: Rng;
  state: State = 'idle';
  private mem = new Map<number, Mem>();
  private target = -1;
  private path: { x: number; y: number; z: number }[] = [];
  private pathIdx = 0;
  private goal: { x: number; y: number; z: number } | null = null;
  private repathT = 0;
  private yaw = 0;
  private pitch = 0;
  private errYaw = 0;
  private errPitch = 0;
  private aimHead = false;
  private strafeDir = 1;
  private strafeT = 0;
  private crouchT = 0;
  private cover: CoverSpot | null = null;
  private stateT = 0;
  private peekCount = 0;
  private perceiveT: number;
  private stuckT = 0;
  private stuckCount = 0;
  private unstickT = 0;
  private unstickDir: [number, number] = [0, 0];
  private lastPos = { x: 0, z: 0 };
  private triggerT = 0;
  private burstT = 0;
  private wantJump = false;
  private seq = 0;
  private lane: number;
  private poiIdx = -1;
  private lookAround = 0;
  /** Seconds until the bot will consider another grenade. */
  private nadeCd: number;
  private nadePlan: { yaw: number; pitch: number; t: number } | null = null;
  /** Grenades thrown (diagnostics/tests). */
  thrown = 0;

  constructor(readonly id: number, difficulty: BotDifficulty = 'regular', seed = 1) {
    this.diff = DIFF[difficulty];
    this.rng = new Rng(seed * 977 + id * 131);
    this.perceiveT = (id % 6) * 0.017;
    this.lane = id;
    this.nadeCd = 6 + this.rng.next() * 6;
  }

  /**
   * Solves a launch pitch that lands a frag near the target point with a clear arc (sampled
   * against level geometry), preferring flat throws. Null when there is no good throw.
   */
  private planThrow(sim: GameSim, me: PlayerState, tx: number, ty: number, tz: number): { yaw: number; pitch: number } | null {
    const ox = me.x;
    const oy = me.y + eyeHeight(me) - 0.15;
    const oz = me.z;
    const dx = tx - ox;
    const dz = tz - oz;
    const d = Math.hypot(dx, dz);
    if (d < 6 || d > 22) return null;
    const ux = dx / d;
    const uz = dz / d;
    const dh = ty + 0.3 - oy;
    for (let pitch = -0.3; pitch <= 1.15; pitch += 0.025) {
      const vh = FRAG_SPEED * Math.cos(pitch);
      const vy = FRAG_SPEED * Math.sin(pitch) + FRAG_UP;
      const T = d / vh;
      const y = vy * T - 0.5 * GRAVITY * T * T;
      if (Math.abs(y - dh) > 0.7) continue;
      let px = ox;
      let py = oy;
      let pz = oz;
      let clear = true;
      for (let i = 1; i <= 12 && clear; i++) {
        const t = ((T * i) / 12) * 0.94;
        const nx = ox + ux * vh * t;
        const ny = oy + vy * t - 0.5 * GRAVITY * t * t;
        const nz = oz + uz * vh * t;
        clear = sim.world.lineOfSight(px, py, pz, nx, ny, nz);
        px = nx;
        py = ny;
        pz = nz;
      }
      if (clear) return { yaw: Math.atan2(-dx, -dz), pitch };
    }
    return null;
  }

  /** Debug snapshot of the brain's state. */
  debugInfo(): string {
    const g = this.goal ? `${this.goal.x.toFixed(1)},${this.goal.z.toFixed(1)}` : '-';
    return `${this.state} tgt${this.target} path${this.pathIdx}/${this.path.length} goal(${g}) cover${this.cover ? `${this.cover.x},${this.cover.z}` : '-'}`;
  }

  /** Feed simulation events (damage taken, gunfire heard). */
  observe(events: GameEvent[], sim: GameSim, me: PlayerState): void {
    for (const e of events) {
      if (e.type === 'damage' && e.victim === me.id && e.attacker >= 0) {
        const a = sim.player(e.attacker);
        if (a && a.alive) this.remember(a, sim.time, false);
      } else if (e.type === 'fire' && e.shooter !== me.id) {
        const a = sim.player(e.shooter);
        if (!a || a.team === me.team || !a.alive) continue;
        const d = Math.hypot(a.x - me.x, a.z - me.z);
        if (d < 28) this.remember(a, sim.time, false, d * 0.08);
      } else if (e.type === 'roundStart') {
        this.mem.clear();
        this.target = -1;
        this.state = 'idle';
        this.path = [];
        this.goal = null;
        this.cover = null;
        this.poiIdx = -1;
      }
    }
  }

  private remember(a: PlayerState, now: number, visible: boolean, noise = 0): void {
    const m = this.mem.get(a.id);
    const nx = a.x + (this.rng.next() - 0.5) * noise;
    const nz = a.z + (this.rng.next() - 0.5) * noise;
    if (m) {
      m.x = nx;
      m.y = a.y;
      m.z = nz;
      m.lastSeen = now;
      m.visible = visible || m.visible;
    } else this.mem.set(a.id, { x: nx, y: a.y, z: nz, lastSeen: now, firstSeen: now, visible });
  }

  private perceive(sim: GameSim, me: PlayerState): void {
    const ey = me.y + eyeHeight(me);
    const now = sim.time;
    const prevVisible = new Set<number>();
    for (const [id, m] of this.mem) {
      if (m.visible) prevVisible.add(id);
      m.visible = false;
    }
    for (const e of sim.players) {
      if (!e.alive || e.team === me.team) continue;
      const dx = e.x - me.x;
      const dz = e.z - me.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 60) continue;
      const ang = Math.abs(angleDiff(this.yaw, Math.atan2(-dx, -dz)));
      const inFov = ang < (this.diff.fov * DEG) / 2 || dist < 3.5;
      if (!inFov) continue;
      const th = e.y + eyeHeight(e) - 0.05;
      const tc = e.y + eyeHeight(e) * 0.72;
      const seen = sim.world.lineOfSight(me.x, ey, me.z, e.x, th, e.z) || sim.world.lineOfSight(me.x, ey, me.z, e.x, tc, e.z);
      if (!seen) continue;
      let m = this.mem.get(e.id);
      if (!m) {
        m = { x: e.x, y: e.y, z: e.z, lastSeen: now, firstSeen: now, visible: true };
        this.mem.set(e.id, m);
      } else {
        // re-acquiring after losing track for a while costs a fresh reaction time
        if (!prevVisible.has(e.id) && now - m.lastSeen > 0.4) m.firstSeen = now;
        m.x = e.x;
        m.y = e.y;
        m.z = e.z;
        m.lastSeen = now;
        m.visible = true;
      }
    }
  }

  private pickTarget(sim: GameSim, me: PlayerState): number {
    let best = -1;
    let bestScore = Infinity;
    for (const [id, m] of this.mem) {
      const e = sim.player(id);
      if (!e || !e.alive) {
        this.mem.delete(id);
        continue;
      }
      if (!m.visible) continue;
      const d = Math.hypot(e.x - me.x, e.z - me.z);
      const score = d - (id === this.target ? 4 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  think(sim: GameSim, nav: NavGrid, me: PlayerState): PlayerInput {
    const now = sim.time;
    const phase = sim.round.phase;
    const w = activeWeapon(me);
    const inp: PlayerInput = { seq: ++this.seq, mx: 0, mz: 0, yaw: me.yaw, pitch: me.pitch, buttons: 0, slot: me.slot, viewTick: 0 };
    if (!me.alive) return inp;
    if (phase === 'countdown' || phase === 'warmup') {
      this.yaw = me.yaw;
      this.pitch = 0;
      // glance around during the countdown
      this.lookAround += DT;
      inp.yaw = this.yaw + Math.sin(this.lookAround * 0.9 + this.id) * 0.25;
      return inp;
    }
    if (phase !== 'live' && phase !== 'overtime') return inp;

    this.perceiveT -= DT;
    if (this.perceiveT <= 0) {
      this.perceiveT = 0.1;
      this.perceive(sim, me);
    }
    this.target = this.pickTarget(sim, me);
    const tgt = this.target >= 0 ? sim.player(this.target)! : null;
    const tm = tgt ? this.mem.get(tgt.id)! : null;
    this.stateT += DT;

    // ---- decide
    const lowHp = me.hp < 45;
    const reloading = me.reloadT > 0;
    const mag = me.weapons[me.slot].mag;
    let next: State;
    if (tgt && tm) {
      const dist = Math.hypot(tgt.x - me.x, tgt.z - me.z);
      if ((lowHp || (reloading && dist > 5) || mag === 0) && this.state !== 'cover' && this.state !== 'peek') next = 'cover';
      else if (this.state === 'cover' || this.state === 'peek') next = this.state;
      else next = 'engage';
    } else {
      const recent = [...this.mem.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
      if (this.state === 'cover' || this.state === 'peek') next = this.state;
      else if (recent && now - recent.lastSeen < 6) next = 'hunt';
      else if (phase === 'overtime') next = 'objective';
      else next = 'roam';
    }
    if (next !== this.state) {
      this.state = next;
      this.stateT = 0;
      if (next === 'cover') {
        this.cover = this.findCover(sim, nav, me, tgt);
        this.peekCount = 0;
        if (this.cover) this.setGoal(nav, me, this.cover);
        else this.state = 'engage';
      }
      if (next === 'engage' && tgt) {
        // fresh acquisition: big initial aim error, decide head or body
        this.errYaw = (this.rng.next() * 2 - 1) * this.diff.aimErr * DEG;
        this.errPitch = (this.rng.next() * 2 - 1) * this.diff.aimErr * 0.6 * DEG;
        this.aimHead = this.rng.chance(this.diff.head);
      }
    }

    // ---- grenades: flush out an enemy who just broke line of sight behind cover
    this.nadeCd -= DT;
    if (!this.nadePlan && this.nadeCd <= 0 && me.lethals > 0 && me.loadout.lethal === 'frag' && (this.state === 'cover' || this.state === 'hunt' || this.state === 'peek')) {
      this.nadeCd = 1.2;
      const lk = [...this.mem.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
      if (lk && !lk.visible && now - lk.lastSeen < 4 && this.rng.chance(this.diff.nade)) {
        const plan = this.planThrow(sim, me, lk.x, lk.y, lk.z);
        if (plan) {
          this.nadePlan = { ...plan, t: 0 };
          this.nadeCd = 12 + this.rng.next() * 10;
        }
      }
    }

    // ---- behaviors
    let moveX = 0;
    let moveZ = 0;
    let lookYaw = this.yaw;
    let lookPitch = this.pitch;
    let fire = false;
    let ads = false;
    let crouch = false;
    let sprint = false;
    const ey = me.y + eyeHeight(me);

    const aimAt = (t: PlayerState) => {
      const th = this.aimHead ? t.y + eyeHeight(t) + 0.02 : t.y + eyeHeight(t) * 0.74;
      const dx = t.x - me.x;
      const dy = th - ey;
      const dz = t.z - me.z;
      const hd = Math.hypot(dx, dz);
      lookYaw = Math.atan2(-dx, -dz) + this.errYaw;
      lookPitch = Math.atan2(dy, hd) + this.errPitch;
      // settle aim error over time
      const k = Math.exp((-DT * 3) / this.diff.settle);
      this.errYaw *= k;
      this.errPitch *= k;
      return hd;
    };

    const shootLogic = (_t: PlayerState, dist: number, canSee: boolean) => {
      if (!canSee || !tm) return;
      ads = dist > 6 || w.class === 'sniper' || w.class === 'marksman';
      const reacted = now - tm.firstSeen > this.diff.reaction;
      const aimErr = Math.hypot(angleDiff(this.yaw, lookYaw - this.errYaw), this.pitch - (lookPitch - this.errPitch));
      const tol = Math.max(1.2 * DEG, Math.atan2(0.28, dist)) + (this.diff.aimErr * 0.15 * DEG);
      if (!reacted || aimErr > tol * 2.2) return;
      if (w.class === 'sniper' && me.ads < 0.95) return;
      if (w.fireMode === 'auto') {
        // burst control at range
        if (dist > 18) {
          this.burstT += DT;
          if (this.burstT > 0.45) {
            if (this.burstT > 0.72) this.burstT = 0;
            return;
          }
        }
        fire = true;
      } else {
        this.triggerT -= DT;
        if (this.triggerT <= 0 && me.fireCd <= 0) {
          fire = true;
          this.triggerT = 60 / w.rpm + 0.05 + this.rng.next() * 0.08;
        }
      }
    };

    if (this.state === 'engage' && tgt && tm) {
      const dist = aimAt(tgt);
      shootLogic(tgt, dist, tm.visible);
      // strafe (ADAD) with random timing, crouch now and then
      this.strafeT -= DT;
      if (this.strafeT <= 0) {
        this.strafeT = 0.35 + this.rng.next() * 0.8;
        this.strafeDir = this.rng.chance(0.5) ? 1 : -1;
        if (this.rng.chance(0.25 * this.diff.strafe)) this.crouchT = 0.6 + this.rng.next() * 0.8;
      }
      if (this.crouchT > 0) {
        this.crouchT -= DT;
        crouch = true;
      }
      const rx = Math.cos(this.yaw);
      const rz = -Math.sin(this.yaw);
      moveX += rx * this.strafeDir * this.diff.strafe;
      moveZ += rz * this.strafeDir * this.diff.strafe;
      const prefer = w.class === 'shotgun' ? 4 : w.class === 'smg' || w.class === 'pistol' ? 8 : w.class === 'sniper' ? 22 : 14;
      const fx = (tgt.x - me.x) / Math.max(1, dist);
      const fz = (tgt.z - me.z) / Math.max(1, dist);
      if (dist > prefer + 4) {
        moveX += fx * 0.9;
        moveZ += fz * 0.9;
      } else if (dist < prefer * 0.4 && w.class === 'sniper') {
        moveX -= fx;
        moveZ -= fz;
      }
      if (mag === 0 && me.weapons[me.slot].reserve === 0) inp.slot = me.slot === 0 ? 1 : 0;
    } else if (this.state === 'cover' && this.cover) {
      const c = this.cover;
      const arrived = Math.hypot(c.x - me.x, c.z - me.z) < 0.45;
      if (!arrived) {
        const mv = this.followPath(nav, me);
        moveX = mv[0];
        moveZ = mv[1];
        if (tgt && tm && tm.visible) {
          const dist = aimAt(tgt);
          shootLogic(tgt, dist, true);
        } else {
          lookYaw = Math.atan2(-moveX, -moveZ);
          lookPitch = 0;
        }
        if (this.stateT > 4) this.state = 'engage';
      } else {
        crouch = c.kind === 'low';
        if (mag < w.magSize * 0.6 && me.weapons[me.slot].reserve > 0 && !reloading) inp.buttons |= BTN.RELOAD;
        // face toward the threat
        const lk = tm ?? [...this.mem.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
        if (lk) {
          lookYaw = Math.atan2(-(lk.x - me.x), -(lk.z - me.z));
          lookPitch = 0;
        }
        if ((me.hp > 70 || this.stateT > 3.5) && !reloading && this.stateT > 1.2) {
          this.state = 'peek';
          this.stateT = 0;
          this.peekCount++;
          this.strafeDir = this.peekSide(sim, me, c);
        }
      }
    } else if (this.state === 'peek' && this.cover) {
      const c = this.cover;
      const t = this.stateT;
      if (c.kind === 'low') crouch = t > 1.3;
      else {
        const rx = -c.nz;
        const rz = c.nx;
        const out = t < 0.9 ? 1 : -1;
        moveX = rx * this.strafeDir * out * 0.85;
        moveZ = rz * this.strafeDir * out * 0.85;
      }
      if (tgt && tm) {
        const dist = aimAt(tgt);
        shootLogic(tgt, dist, tm.visible);
      } else {
        const lk = [...this.mem.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
        if (lk) lookYaw = Math.atan2(-(lk.x - me.x), -(lk.z - me.z));
      }
      if (t > 1.9) {
        if (this.peekCount >= 3 || (me.hp > 80 && !tgt)) {
          this.state = 'hunt';
          this.cover = null;
        } else {
          this.state = 'cover';
          this.stateT = 0;
        }
      }
    } else if (this.state === 'hunt') {
      const lk = [...this.mem.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
      if (lk) {
        this.setGoal(nav, me, lk);
        const mv = this.followPath(nav, me);
        moveX = mv[0];
        moveZ = mv[1];
        const dist = Math.hypot(lk.x - me.x, lk.z - me.z);
        lookYaw = dist > 2 ? Math.atan2(-(lk.x - me.x), -(lk.z - me.z)) : this.yaw + 1.2 * DT;
        lookPitch = 0;
        ads = dist < 15;
        if (dist < 1.2) this.mem.clear();
      }
    } else if (this.state === 'objective') {
      const cp = sim.map.capture.pos;
      const g = { x: cp[0] + Math.sin(this.id * 2.1) * 1.2, y: cp[1], z: cp[2] + Math.cos(this.id * 2.1) * 1.2 };
      this.setGoal(nav, me, g);
      const mv = this.followPath(nav, me);
      moveX = mv[0];
      moveZ = mv[1];
      const d = Math.hypot(g.x - me.x, g.z - me.z);
      if (d > 1.5) {
        lookYaw = Math.atan2(-moveX, -moveZ);
        sprint = d > 6;
      } else {
        crouch = this.rng.chance(0.02) ? !crouch : crouch;
        lookYaw = this.yaw + 0.8 * DT;
      }
      lookPitch = 0;
    } else {
      // roam between points of interest, heading toward the enemy side over time
      if (!this.goal || Math.hypot(this.goal.x - me.x, this.goal.z - me.z) < 1.2 || this.poiIdx < 0) {
        this.poiIdx = this.nextPoi(me, sim);
        const p = POIS[this.poiIdx];
        this.setGoal(nav, me, { x: p[0], y: 0, z: p[1] });
      }
      const mv = this.followPath(nav, me);
      moveX = mv[0];
      moveZ = mv[1];
      if (Math.hypot(moveX, moveZ) > 0.1) lookYaw = Math.atan2(-moveX, -moveZ);
      lookPitch = 0;
      sprint = true;
      if (mag < w.magSize && !reloading && me.weapons[me.slot].reserve > 0 && mag < w.magSize * 0.5) inp.buttons |= BTN.RELOAD;
    }

    // a planned throw overrides aim: line it up, then pull the pin
    let throwNow = false;
    if (this.nadePlan) {
      const pl = this.nadePlan;
      pl.t += DT;
      lookYaw = pl.yaw;
      lookPitch = pl.pitch;
      fire = false;
      ads = false;
      sprint = false;
      if (pl.t > 0.25 && Math.abs(angleDiff(this.yaw, pl.yaw)) < 0.06 && Math.abs(this.pitch - pl.pitch) < 0.06) {
        throwNow = true;
        this.nadePlan = null;
        this.thrown++;
      } else if (pl.t > 1.5) this.nadePlan = null;
    }

    // ---- turn toward desired view with a capped rate (and recoil)
    const maxTurn = this.diff.turn * DEG * DT;
    const dyaw = clamp(angleDiff(this.yaw, lookYaw), -maxTurn, maxTurn);
    this.yaw = wrapAngle(this.yaw + dyaw * (Math.abs(dyaw) < maxTurn ? 0.6 : 1));
    this.pitch = clamp(this.pitch + clamp(lookPitch - this.pitch, -maxTurn, maxTurn) * 0.6, -1.3, 1.3);
    if (fire && me.fireCd <= DT) {
      const k = recoilKick(w, me.recoilIdx + 1, (me.id * 7919 + (me.shotCount + 1) * 104729) >>> 0, me.ads);
      this.pitch += k.pitch * (1 - this.diff.comp);
      this.yaw += k.yaw * (1 - this.diff.comp);
    }

    // ---- stuck detection & escalating recovery
    const want = Math.hypot(moveX, moveZ) > 0.2;
    if (this.unstickT > 0) {
      // walk toward the nearest open nav node for a moment, then re-plan
      this.unstickT -= DT;
      moveX = this.unstickDir[0];
      moveZ = this.unstickDir[1];
      if (this.unstickT <= 0) {
        this.path = [];
        this.repathT = 0;
        this.goal = null;
      }
    } else if (want) {
      const moved = Math.hypot(me.x - this.lastPos.x, me.z - this.lastPos.z);
      this.stuckT = moved < 0.6 * DT ? this.stuckT + DT : Math.max(0, this.stuckT - DT * 2);
      if (this.stuckT > 0.5) {
        this.stuckT = 0;
        this.stuckCount++;
        this.repathT = 0;
        this.strafeDir = -this.strafeDir;
        if (this.stuckCount % 2 === 1) this.wantJump = true;
        else {
          const n = nav.nodes[nav.nearest(me.x, me.y, me.z)];
          // pick a neighbor away from walls (highest clearance) to back out toward
          let best = n;
          for (const l of n.links) if (nav.nodes[l].clearance > best.clearance) best = nav.nodes[l];
          const dx = best.x - me.x + (this.rng.next() - 0.5) * 0.6;
          const dz = best.z - me.z + (this.rng.next() - 0.5) * 0.6;
          const l = Math.hypot(dx, dz) || 1;
          this.unstickDir = [dx / l, dz / l];
          this.unstickT = 0.5;
        }
      }
    } else this.stuckT = 0;
    if (Math.hypot(me.x - this.lastPos.x, me.z - this.lastPos.z) > 0.05) this.stuckCount = Math.max(0, this.stuckCount - DT);
    this.lastPos.x = me.x;
    this.lastPos.z = me.z;

    // ---- emit input
    const ml = Math.hypot(moveX, moveZ);
    if (ml > 0.05) {
      const nx = moveX / Math.max(1, ml);
      const nz = moveZ / Math.max(1, ml);
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      const rx = Math.cos(this.yaw);
      const rz = -Math.sin(this.yaw);
      inp.mz = nx * fx + nz * fz;
      inp.mx = nx * rx + nz * rz;
    }
    inp.yaw = this.yaw;
    inp.pitch = this.pitch;
    if (fire) inp.buttons |= BTN.FIRE;
    if (throwNow) inp.buttons |= BTN.LETHAL;
    if (ads) inp.buttons |= BTN.ADS;
    if (crouch) inp.buttons |= BTN.CROUCH;
    if (sprint && inp.mz > 0.7 && !fire && !ads) inp.buttons |= BTN.SPRINT;
    if (this.wantJump) {
      inp.buttons |= BTN.JUMP;
      this.wantJump = false;
    }
    return inp;
  }

  private nextPoi(me: PlayerState, sim: GameSim): number {
    // early in the round: head out along an assigned lane; later: anywhere, biased to the enemy half
    const enemySign = me.team === 0 ? 1 : -1;
    const t = sim.round.phase === 'live' ? sim.rules.roundTime - sim.round.timer : 60;
    const cands = POIS.map((p, i) => ({ i, p })).filter(({ i }) => i !== this.poiIdx);
    let best = cands[0].i;
    let bestS = -Infinity;
    for (const { i, p } of cands) {
      const d = Math.hypot(p[0] - me.x, p[1] - me.z);
      const laneBias = t < 12 ? -Math.abs(((i + this.lane * 5) % POIS.length) - POIS.length / 2) * 0.3 : 0;
      const adv = p[0] * enemySign * (t < 25 ? 0.15 : 0.06);
      const s = adv + laneBias - Math.abs(d - 9) * 0.25 + this.rng.next() * 2.2;
      if (s > bestS) {
        bestS = s;
        best = i;
      }
    }
    return best;
  }

  private setGoal(nav: NavGrid, me: PlayerState, g: { x: number; y: number; z: number }): void {
    const changed = !this.goal || Math.hypot(this.goal.x - g.x, this.goal.z - g.z) > 1.0;
    this.repathT -= DT;
    if (!changed && this.repathT > 0 && this.path.length) return;
    this.goal = { x: g.x, y: g.y, z: g.z };
    this.repathT = 1.4 + this.rng.next() * 0.4;
    const a = nav.nearest(me.x, me.y, me.z);
    const b = nav.nearest(g.x, g.y, g.z);
    const ids = nav.findPath(a, b);
    if (!ids) {
      this.path = [];
      return;
    }
    this.path = nav.smooth(ids);
    this.pathIdx = this.path.length > 1 ? 1 : 0;
  }

  /** Returns a world-space move vector toward the next waypoint. */
  private followPath(nav: NavGrid, me: PlayerState): [number, number] {
    void nav;
    if (!this.path.length) {
      if (this.goal) {
        const dx = this.goal.x - me.x;
        const dz = this.goal.z - me.z;
        const l = Math.hypot(dx, dz) || 1;
        return [dx / l, dz / l];
      }
      return [0, 0];
    }
    while (this.pathIdx < this.path.length - 1) {
      const wp = this.path[this.pathIdx];
      if (Math.hypot(wp.x - me.x, wp.z - me.z) < 0.55 && Math.abs(wp.y - me.y) < 1.2) this.pathIdx++;
      else break;
    }
    const wp = this.path[this.pathIdx];
    const dx = wp.x - me.x;
    const dz = wp.z - me.z;
    const l = Math.hypot(dx, dz);
    if (l < 0.15) return [0, 0];
    return [dx / l, dz / l];
  }

  private findCover(sim: GameSim, nav: NavGrid, me: PlayerState, threat: PlayerState | null): CoverSpot | null {
    if (!threat) return null;
    const tey = threat.y + eyeHeight(threat);
    let best: CoverSpot | null = null;
    let bestS = Infinity;
    let checked = 0;
    // nearest cover spots first
    const cands = nav.cover
      .map((c) => ({ c, d: Math.hypot(c.x - me.x, c.z - me.z) }))
      .filter((o) => o.d < 13 && Math.abs(o.c.y - me.y) < 1.2)
      .sort((a, b) => a.d - b.d);
    for (const { c, d } of cands) {
      if (checked++ > 36) break;
      // cover must face the threat (threat on the obstacle side)
      const tx = threat.x - c.x;
      const tz = threat.z - c.z;
      const tl = Math.hypot(tx, tz) || 1;
      if ((tx / tl) * c.nx + (tz / tl) * c.nz > -0.2) continue;
      const hide = c.kind === 'low' ? c.y + 1.0 : c.y + 1.6;
      if (sim.world.raycast(threat.x, tey, threat.z, c.x - threat.x, hide - tey, c.z - threat.z, 1, OPAQUE) === null) continue;
      // don't run past the enemy to get there
      const towardThreat = ((c.x - me.x) * tx + (c.z - me.z) * tz) / tl;
      const s = d + Math.max(0, -towardThreat) * 0.2 + Math.max(0, towardThreat) * 1.5;
      if (s < bestS) {
        bestS = s;
        best = c;
      }
    }
    return best;
  }

  /** Which way to strafe out of high cover (+1 right / -1 left of the cover normal). */
  private peekSide(sim: GameSim, me: PlayerState, c: CoverSpot): number {
    const rx = -c.nz;
    const rz = c.nx;
    for (const side of [1, -1]) {
      const px = c.x + rx * side * 0.9;
      const pz = c.z + rz * side * 0.9;
      if (!sim.world.raycast(px, me.y + 1.5, pz, -c.nx, 0, -c.nz, 1.2, OPAQUE)) return side;
    }
    return this.rng.chance(0.5) ? 1 : -1;
  }
}
