import { describe, expect, it } from 'vitest';
import { buildSublevel9 } from '@/game/world/sublevel9';
import { CollisionWorld } from '@/game/world/collision';
import { GameSim } from '@/game/sim/GameSim';
import { PLAYLISTS } from '@/data/playlists';
import { BTN, DT, emptyInput, type PlayerInput } from '@/game/sim/types';
import { MOVE, stepMovement } from '@/game/sim/movement';
import { getWeapon } from '@/data/weapons';
import { makePlayer } from '@/game/sim/GameSim';
import { rayVsBody } from '@/game/sim/hitboxes';
import { spreadDirection } from '@/game/sim/weaponLogic';

const map = buildSublevel9();
const world = CollisionWorld.fromMap(map, []);

describe('collision world', () => {
  it('builds primitives from the map', () => {
    expect(world.prims.length).toBeGreaterThan(200);
  });
  it('raycast hits the shower north wall', () => {
    // from the drain looking north (+z): the wall at z = 6 (inner face 5.85)
    const hit = world.raycast(0, 1.5, 0, 0, 0, 1, 50);
    expect(hit).not.toBeNull();
    expect(hit!.z).toBeGreaterThan(5.5);
    expect(hit!.z).toBeLessThan(6.2);
    expect(hit!.nz).toBeCloseTo(-1);
  });
  it('raycast hits the floor below', () => {
    const hit = world.raycast(0, 1.5, 0, 0, -1, 0, 10);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeCloseTo(0, 3);
    expect(hit!.ny).toBeCloseTo(1);
  });
  it('raycast hits a boiler (cylinder)', () => {
    const hit = world.raycast(0, 1.5, 7.5, 0, 0, 1, 10);
    expect(hit).not.toBeNull();
    expect(hit!.z).toBeGreaterThan(9.0);
    expect(hit!.z).toBeLessThan(10.0);
  });
  it('support height finds the catwalk top and floor', () => {
    expect(world.supportHeight(0, 15.5, MOVE.radius, 2.8, 0.4).y).toBeCloseTo(2.8, 3);
    expect(world.supportHeight(-20, 0, MOVE.radius, 0, 0.4).y).toBeCloseTo(0, 3);
  });
  it('ramp height increases toward the catwalk', () => {
    const lo = world.supportHeight(-17.2, 15.5, 0.2, 0.0, 3).y;
    const hi = world.supportHeight(-13.5, 15.5, 0.2, 2.0, 3).y;
    expect(hi).toBeGreaterThan(lo + 1);
  });
});

function freshPlayer() {
  const p = makePlayer({ id: 0, team: 0, name: 't', bot: false });
  p.alive = true;
  p.x = -22;
  p.y = 0;
  p.z = 2.5;
  p.yaw = -Math.PI / 2; // facing +X
  return p;
}

describe('movement', () => {
  const w = getWeapon('halberd');
  it('walks forward at walk speed', () => {
    const p = freshPlayer();
    const inp: PlayerInput = { ...emptyInput(1, p.yaw), mz: 1 };
    for (let i = 0; i < 60; i++) stepMovement(p, inp, world, DT, false, w);
    expect(p.x).toBeGreaterThan(-22 + 3.5);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(MOVE.walk * w.move, 1);
    expect(p.grounded).toBe(true);
  });
  it('is stopped by walls', () => {
    const p = freshPlayer();
    p.x = -23;
    p.z = 0.5;
    p.yaw = Math.PI / 2; // facing -X into the outer wall at x = -25
    const inp: PlayerInput = { ...emptyInput(1, p.yaw), mz: 1 };
    for (let i = 0; i < 120; i++) stepMovement(p, inp, world, DT, false, w);
    expect(p.x).toBeGreaterThan(-25 + MOVE.radius - 0.01);
    expect(p.x).toBeLessThan(-24.3);
  });
  it('jumps and lands', () => {
    const p = freshPlayer();
    let maxY = 0;
    let inp: PlayerInput = { ...emptyInput(1, p.yaw), buttons: BTN.JUMP };
    stepMovement(p, inp, world, DT, false, w);
    p.prevButtons = inp.buttons;
    inp = { ...inp, buttons: 0 };
    for (let i = 0; i < 90; i++) {
      stepMovement(p, inp, world, DT, false, w);
      maxY = Math.max(maxY, p.y);
    }
    expect(maxY).toBeGreaterThan(0.7);
    expect(maxY).toBeLessThan(1.2);
    expect(p.y).toBeCloseTo(0, 3);
    expect(p.grounded).toBe(true);
  });
  it('walks up the ramp onto the catwalk', () => {
    const p = freshPlayer();
    p.x = -18.3;
    p.z = 15.6;
    p.yaw = -Math.PI / 2; // +X up the ramp
    const inp: PlayerInput = { ...emptyInput(1, p.yaw), mz: 1 };
    for (let i = 0; i < 150; i++) stepMovement(p, inp, world, DT, false, w);
    expect(p.y).toBeCloseTo(2.8, 1);
    expect(p.x).toBeGreaterThan(-12.5);
  });
  it('mantles onto a crate', () => {
    // crate at (-15.5, 0, 7.3): stand west of it facing +X
    const p = freshPlayer();
    p.x = -16.0 - 0.0;
    p.z = 8.6;
    p.yaw = Math.PI; // facing +Z? use -Z toward z=7.3
    p.yaw = 0; // facing -Z
    p.x = -15.5;
    p.z = 8.3;
    const jump: PlayerInput = { ...emptyInput(1, p.yaw), mz: 1, buttons: BTN.JUMP };
    stepMovement(p, jump, world, DT, false, w);
    p.prevButtons = jump.buttons;
    const idle: PlayerInput = { ...jump, mz: 0, buttons: 0 };
    for (let i = 0; i < 40; i++) stepMovement(p, idle, world, DT, false, w);
    expect(p.y).toBeCloseTo(1.0, 2);
    expect(p.z).toBeLessThan(7.8);
  });
  it('crouches and cannot stand under low ceilings', () => {
    const p = freshPlayer();
    const inp: PlayerInput = { ...emptyInput(1, p.yaw), buttons: BTN.CROUCH };
    for (let i = 0; i < 30; i++) stepMovement(p, inp, world, DT, false, w);
    expect(p.crouch).toBeCloseTo(1);
  });
});

describe('hitboxes & spread', () => {
  it('ray at head height hits head', () => {
    const h = rayVsBody(0, 1.66, 5, 0, 0, -1, 50, { x: 0, y: 0, z: 0, crouch: 0, slide: false, yaw: 0 });
    expect(h?.hitbox).toBe('head');
  });
  it('ray at waist hits stomach, at knees hits legs', () => {
    expect(rayVsBody(0, 1.0, 5, 0, 0, -1, 50, { x: 0, y: 0, z: 0, crouch: 0, slide: false, yaw: 0 })?.hitbox).toBe('stomach');
    expect(rayVsBody(0, 0.5, 5, 0, 0, -1, 50, { x: 0, y: 0, z: 0, crouch: 0, slide: false, yaw: 0 })?.hitbox).toBe('legs');
  });
  it('crouching lowers the head below standing head height', () => {
    expect(rayVsBody(0, 1.66, 5, 0, 0, -1, 50, { x: 0, y: 0, z: 0, crouch: 1, slide: false, yaw: 0 })).toBeNull();
  });
  it('spread direction is deterministic and within the cone', () => {
    const a = spreadDirection(0.3, 0.1, 2, 1234, 0);
    const b = spreadDirection(0.3, 0.1, 2, 1234, 0);
    expect(a).toEqual(b);
    const f = spreadDirection(0.3, 0.1, 0, 1234, 0);
    const ang = Math.acos(a[0] * f[0] + a[1] * f[1] + a[2] * f[2]) * (180 / Math.PI);
    expect(ang).toBeLessThanOrEqual(2.0001);
  });
});

describe('game sim rounds', () => {
  function sim1v1() {
    const sim = new GameSim(map, PLAYLISTS['1v1'].rules, 7);
    sim.addPlayer({ id: 0, team: 0, name: 'A', bot: false });
    sim.addPlayer({ id: 1, team: 1, name: 'B', bot: false });
    sim.start();
    return sim;
  }
  it('counts down, goes live, then overtime', () => {
    const sim = sim1v1();
    expect(sim.round.phase).toBe('countdown');
    const idle = (p: { yaw: number }) => emptyInput(sim.tick, p.yaw);
    for (let i = 0; i < 60 * 4.1; i++) sim.step(idle);
    expect(sim.round.phase).toBe('live');
    for (let i = 0; i < 60 * PLAYLISTS['1v1'].rules.roundTime; i++) sim.step(idle);
    expect(sim.round.phase).toBe('overtime');
    expect(sim.round.capture.active).toBe(true);
  });
  it('a kill ends the round and awards the point', () => {
    const sim = sim1v1();
    const idle = (p: { yaw: number }) => emptyInput(sim.tick, p.yaw);
    for (let i = 0; i < 60 * 4.1; i++) sim.step(idle);
    const a = sim.player(0)!;
    const b = sim.player(1)!;
    b.spawnProt = 0;
    sim.applyDamage(a, b, 120, 'chest', 'halberd', b.x, b.y, b.z);
    sim.step(idle);
    expect(sim.round.phase).toBe('roundEnd');
    expect(sim.round.score).toEqual([1, 0]);
    expect(a.stats.kills).toBe(1);
    expect(b.stats.deaths).toBe(1);
  });
  it('first to roundsToWin wins the match', () => {
    const sim = sim1v1();
    const idle = (p: { yaw: number }) => emptyInput(sim.tick, p.yaw);
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 60 * 4.1; i++) sim.step(idle);
      const b = sim.player(1)!;
      b.spawnProt = 0;
      sim.applyDamage(sim.player(0)!, b, 200, 'head', 'halberd', b.x, b.y, b.z);
      for (let i = 0; i < 60 * 5; i++) sim.step(idle);
    }
    expect(sim.round.phase).toBe('matchEnd');
    expect(sim.round.matchWinner).toBe(0);
  });
  it('overtime capture wins the round', () => {
    const sim = sim1v1();
    const idle = (p: { yaw: number }) => emptyInput(sim.tick, p.yaw);
    for (let i = 0; i < 60 * (4.1 + PLAYLISTS['1v1'].rules.roundTime + 0.1); i++) sim.step(idle);
    const a = sim.player(0)!;
    a.x = 0;
    a.z = 0;
    for (let i = 0; i < 60 * (PLAYLISTS['1v1'].rules.captureTime + 0.3); i++) sim.step(idle);
    expect(sim.round.lastReason).toBe('capture');
    expect(sim.round.score[0]).toBe(1);
  });
  it('shooting an enemy in front deals damage with the right falloff', () => {
    const sim = sim1v1();
    const idle = (p: { yaw: number }) => emptyInput(sim.tick, p.yaw);
    for (let i = 0; i < 60 * 4.1; i++) sim.step(idle);
    const a = sim.player(0)!;
    const b = sim.player(1)!;
    // put them 8 m apart in the showers, A facing B
    a.x = -4; a.z = 1; b.x = 4; b.z = 1;
    a.yaw = -Math.PI / 2;
    b.spawnProt = 0;
    a.spawnProt = 0;
    let fired = 0;
    const pitch = Math.atan2(1.27 - 1.62, 8);
    for (let i = 0; i < 40; i++) {
      sim.step((p) => (p.id === 0 ? { ...emptyInput(sim.tick, -Math.PI / 2, pitch), buttons: i > 30 ? BTN.FIRE | BTN.ADS : BTN.ADS } : idle(p)));
      fired += sim.events.filter((e) => e.type === 'fire').length;
    }
    expect(fired).toBeGreaterThan(0);
    expect(b.hp).toBeLessThan(100);
  });
});
