import { describe, expect, it } from 'vitest';
import { GameSim } from '@/game/sim/GameSim';
import { PLAYLISTS } from '@/data/playlists';
import { buildSublevel9 } from '@/game/world/sublevel9';
import { BTN, DT, emptyInput, type PlayerInput, type PlayerState } from '@/game/sim/types';
import { HEALTH, regenAmount } from '@/data/gameplay';
import { INPUT_TUNING, getWeapon, touchpadHipMul } from '@/data/weapons';
import { currentSpread } from '@/game/sim/weaponLogic';
import { MOVE, stepMovement } from '@/game/sim/movement';
import { rayVsBody } from '@/game/sim/hitboxes';

const map = buildSublevel9();

function liveSim(): GameSim {
  const sim = new GameSim(map, PLAYLISTS['1v1'].rules, 7);
  sim.addPlayer({ id: 0, team: 0, name: 'A', bot: false });
  sim.addPlayer({ id: 1, team: 1, name: 'B', bot: false });
  sim.start();
  const idle = (p: PlayerState) => emptyInput(sim.tick, p.yaw);
  for (let i = 0; i < 60 * (PLAYLISTS['1v1'].rules.countdown + 0.1); i++) sim.step(idle);
  for (const p of sim.players) p.spawnProt = 0;
  return sim;
}

describe('health regeneration (host simulation)', () => {
  it('waits for the delay, then refills smoothly to full; damage resets the timer', () => {
    const sim = liveSim();
    const idle = (p: PlayerState) => emptyInput(sim.tick, p.yaw);
    const b = sim.player(1)!;
    sim.applyDamage(sim.player(0)!, b, 70, 'chest', 'halberd', b.x, b.y, b.z);
    expect(b.hp).toBeCloseTo(30);
    for (let i = 0; i < 60 * (HEALTH.regenDelay - 0.2); i++) sim.step(idle);
    expect(b.hp).toBeCloseTo(30, 5);
    // more damage before the delay ends restarts the wait
    sim.applyDamage(sim.player(0)!, b, 5, 'chest', 'halberd', b.x, b.y, b.z);
    for (let i = 0; i < 60 * (HEALTH.regenDelay - 0.2); i++) sim.step(idle);
    expect(b.hp).toBeCloseTo(25, 5);
    // then it ramps up: still climbing a moment later, full a few seconds after that
    let prev = b.hp;
    const samples: number[] = [];
    for (let i = 0; i < 60 * (HEALTH.regenTime + HEALTH.regenEaseIn + 1); i++) {
      sim.step(idle);
      samples.push(b.hp - prev);
      prev = b.hp;
    }
    expect(b.hp).toBe(HEALTH.max);
    // smooth: no single tick adds more than the full-speed rate
    expect(Math.max(...samples)).toBeLessThanOrEqual((HEALTH.max / HEALTH.regenTime) * DT + 1e-6);
  });
  it('regenAmount eases in and is zero before the delay', () => {
    expect(regenAmount(HEALTH.regenDelay - 0.01, DT)).toBe(0);
    const early = regenAmount(HEALTH.regenDelay + 0.05, DT);
    const late = regenAmount(HEALTH.regenDelay + 2, DT);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(late);
  });
});

describe('input-mode tuning', () => {
  it('touchpad hip fire is ~0.45x the mouse spread; ADS is unchanged', () => {
    const sim = liveSim();
    const p = sim.player(0)!;
    const w = getWeapon('halberd');
    p.vx = p.vz = 0;
    p.ads = 0;
    p.touchpad = false;
    const mouseHip = currentSpread(p, w);
    p.touchpad = true;
    const padHip = currentSpread(p, w);
    expect(padHip / mouseHip).toBeCloseTo(touchpadHipMul(), 5);
    p.ads = 1;
    const padAds = currentSpread(p, w);
    p.touchpad = false;
    expect(currentSpread(p, w)).toBeCloseTo(padAds, 6);
  });
  it('the host clamps the touchpad multiplier to 0.4-0.5', () => {
    const saved = INPUT_TUNING.touchpad.hipSpreadMul;
    INPUT_TUNING.touchpad.hipSpreadMul = 0.05;
    expect(touchpadHipMul()).toBe(0.4);
    INPUT_TUNING.touchpad.hipSpreadMul = 0.9;
    expect(touchpadHipMul()).toBe(0.5);
    INPUT_TUNING.touchpad.hipSpreadMul = saved;
  });
  it('hit forgiveness widens hitboxes a little', () => {
    const pose = { x: 0, y: 0, z: -10, crouch: 0, slide: false, yaw: 0 };
    // a ray passing 0.23 m beside the torso capsule axis (radius 0.21) misses without forgiveness
    expect(rayVsBody(0.23, 1.2, 0, 0, 0, -1, 50, pose)).toBeNull();
    expect(rayVsBody(0.23, 1.2, 0, 0, 0, -1, 50, pose, 0.035)).not.toBeNull();
  });
});

describe('movement feel', () => {
  function runner(): { sim: GameSim; p: PlayerState; step: (inp: Partial<PlayerInput>, n?: number) => void } {
    const sim = liveSim();
    const p = sim.player(0)!;
    // face the longest clear lane from the spawn so sprints and slides have room
    let best = 0;
    for (let i = 0; i < 32; i++) {
      const yaw = (i / 32) * Math.PI * 2;
      const hit = sim.world.raycast(p.x, p.y + 0.6, p.z, -Math.sin(yaw), 0, -Math.cos(yaw), 60);
      const d = hit ? hit.t : 60;
      if (d > best) {
        best = d;
        p.yaw = yaw;
      }
    }
    let seq = 1;
    let prev = 0;
    const step = (inp: Partial<PlayerInput>, n = 1) => {
      for (let i = 0; i < n; i++) {
        const full: PlayerInput = { ...emptyInput(seq++, p.yaw), ...inp };
        stepMovement(p, full, sim.world, DT, false, getWeapon(p.weapons[p.slot].id));
        prev = full.buttons;
        p.prevButtons = prev;
      }
    };
    return { sim, p, step };
  }
  it('reaches walk speed quickly and stops without ice-skating', () => {
    const { p, step } = runner();
    p.vx = p.vz = 0;
    step({ mz: 1 }, 6); // 0.1 s
    const w = getWeapon(p.weapons[p.slot].id);
    expect(Math.hypot(p.vx, p.vz)).toBeGreaterThan(MOVE.walk * w.move * 0.85);
    step({ mz: 0 }, 6);
    expect(Math.hypot(p.vx, p.vz)).toBeLessThan(0.3);
  });
  it('is about 25% faster than before', () => {
    expect(MOVE.walk / 4.6).toBeGreaterThan(1.2);
    expect(MOVE.walk / 4.6).toBeLessThan(1.3);
    expect(MOVE.sprint / 6.7).toBeGreaterThan(1.2);
    expect(MOVE.sprint / 6.7).toBeLessThan(1.3);
  });
  it('a slide keeps the sprint momentum (plus a small boost)', () => {
    const { p, step } = runner();
    step({ mz: 1, buttons: BTN.SPRINT }, 30);
    const before = Math.hypot(p.vx, p.vz);
    expect(p.sprinting).toBe(true);
    step({ mz: 1, buttons: BTN.SPRINT | BTN.CROUCH }, 1);
    expect(p.slideT).toBeGreaterThan(0);
    expect(Math.hypot(p.vx, p.vz)).toBeGreaterThanOrEqual(Math.max(before, MOVE.slideSpeed) - 0.2);
    // a jump out of the slide carries its speed
    step({ mz: 1, buttons: BTN.CROUCH }, 6);
    const sliding = Math.hypot(p.vx, p.vz);
    step({ mz: 1, buttons: BTN.JUMP }, 1);
    expect(p.grounded).toBe(false);
    expect(Math.hypot(p.vx, p.vz)).toBeGreaterThan(sliding * 0.9);
  });
  it('buffers a jump pressed just before landing', () => {
    const { p, step } = runner();
    step({}, 2);
    step({ buttons: BTN.JUMP }, 1);
    step({}, 1);
    expect(p.grounded).toBe(false);
    // fall until just above the floor, press jump while still airborne
    let guard = 0;
    while (!(p.vy < 0 && p.y - 0 < 0.25) && guard++ < 200) step({}, 1);
    expect(p.grounded).toBe(false);
    step({ buttons: BTN.JUMP }, 1);
    step({}, 20);
    // it jumped again on touchdown: we are airborne or have already landed a second time
    expect(guard).toBeLessThan(200);
  });
});
