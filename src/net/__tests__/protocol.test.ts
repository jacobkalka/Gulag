import { describe, expect, it } from 'vitest';
import { buildSublevel9 } from '@/game/world/sublevel9';
import { GameSim } from '@/game/sim/GameSim';
import { PLAYLISTS } from '@/data/playlists';
import { BTN, emptyInput, type PlayerInput } from '@/game/sim/types';
import { ByteReader, ByteWriter } from '../codec';
import {
  MSG,
  applySelf,
  compactEvents,
  decodeInputs,
  decodeSnapshot,
  encodeInputs,
  encodeSnapshot,
  isRoomCode,
  normalizeRoomCode,
  quantizeInput,
  randomRoomCode,
} from '../protocol';

const map = buildSublevel9();

describe('codec', () => {
  it('round-trips primitive types and grows its buffer', () => {
    const w = new ByteWriter(4);
    w.u8(200).i8(-100).u16(60000).i16(-30000).u32(4000000000).f32(1.5).f64(Math.PI).q8(0.5, 1).str('Hëllo');
    const r = new ByteReader(w.finish());
    expect(r.u8()).toBe(200);
    expect(r.i8()).toBe(-100);
    expect(r.u16()).toBe(60000);
    expect(r.i16()).toBe(-30000);
    expect(r.u32()).toBe(4000000000);
    expect(r.f32()).toBe(1.5);
    expect(r.f64()).toBe(Math.PI);
    expect(r.q8(1)).toBeCloseTo(0.5, 2);
    expect(r.str()).toBe('Hëllo');
    expect(r.remaining).toBe(0);
  });
  it('throws on truncated packets instead of reading garbage', () => {
    const r = new ByteReader(new Uint8Array([1, 2]));
    expect(() => r.u32()).toThrow();
  });
});

describe('inputs', () => {
  it('round-trip exactly after quantization', () => {
    const inputs: PlayerInput[] = [1, 2, 3].map((i) =>
      quantizeInput({ seq: 100 + i, mx: 0.33 * i - 0.5, mz: 1, yaw: 12.345 * i, pitch: -0.4, buttons: BTN.FIRE | BTN.ADS, slot: i % 2, viewTick: 1234.56, life: 3 }),
    );
    const pkt = encodeInputs(inputs, 87);
    const r = new ByteReader(pkt);
    expect(r.u8()).toBe(MSG.INPUT);
    const out = decodeInputs(r);
    expect(out.rtt).toBe(87);
    expect(out.inputs).toEqual(inputs);
  });
  it('sanitizes hostile values', () => {
    const bad = { ...emptyInput(1), mx: 50, mz: NaN, yaw: Infinity, pitch: 99, slot: 7, viewTick: -5 };
    const r = new ByteReader(encodeInputs([bad], 0));
    r.u8();
    const [inp] = decodeInputs(r).inputs;
    expect(inp.mx).toBe(1);
    expect(inp.mz).toBe(0);
    expect(inp.yaw).toBe(0);
    expect(inp.pitch).toBeLessThanOrEqual(1.5);
    expect(inp.slot).toBe(-1);
    expect(inp.viewTick).toBe(0);
    expect(inp.life).toBeUndefined();
  });
});

describe('snapshots', () => {
  it('round-trip world state and the full self state', () => {
    const sim = new GameSim(map, PLAYLISTS['2v2'].rules, 5);
    for (let i = 0; i < 4; i++) sim.addPlayer({ id: i, team: (i % 2) as 0 | 1, name: `p${i}`, bot: false });
    sim.start();
    const inputs = new Map<number, PlayerInput>();
    for (let t = 0; t < 400; t++) {
      sim.step((p) => {
        const inp = { ...emptyInput(t + 1, p.yaw + 0.01, 0.1), mz: 1, mx: p.id % 2 ? 1 : -1, buttons: t > 300 ? BTN.FIRE : 0 };
        inputs.set(p.id, inp);
        return inp;
      });
    }
    const self = sim.player(1)!;
    const pkt = encodeSnapshot(sim.tick, sim.round, sim.players, sim.grenades, self, self.lastInputSeq);
    expect(pkt.byteLength).toBeLessThan(600);
    const r = new ByteReader(pkt);
    expect(r.u8()).toBe(MSG.SNAPSHOT);
    const snap = decodeSnapshot(r);
    expect(snap.tick).toBe(sim.tick);
    expect(snap.ack).toBe(self.lastInputSeq);
    expect(snap.selfId).toBe(1);
    expect(snap.round.phase).toBe(sim.round.phase);
    expect(snap.round.score).toEqual(sim.round.score);
    expect(snap.players).toHaveLength(4);
    for (const sp of snap.players) {
      const p = sim.player(sp.id)!;
      expect(sp.x).toBeCloseTo(p.x, 4);
      expect(sp.z).toBeCloseTo(p.z, 4);
      expect(sp.alive).toBe(p.alive);
      expect(sp.team).toBe(p.team);
      expect(sp.weapon).toBe(p.weapons[p.slot].id);
    }
    // the self state restores everything that affects prediction
    const copy = { ...self, weapons: [{ ...self.weapons[0] }, { ...self.weapons[1] }] as typeof self.weapons };
    copy.x = copy.y = copy.z = 0;
    copy.weapons[0].mag = 0;
    applySelf(copy, snap.self!);
    expect(copy.x).toBe(self.x);
    expect(copy.z).toBe(self.z);
    expect(copy.weapons).toEqual(self.weapons);
    expect(copy.shotCount).toBe(self.shotCount);
    expect(copy.life).toBe(self.life);
    expect(copy.fireCd).toBeCloseTo(self.fireCd, 5);
  });
});

describe('room codes', () => {
  it('generates unambiguous six-character codes', () => {
    for (let i = 0; i < 50; i++) {
      const c = randomRoomCode();
      expect(isRoomCode(c)).toBe(true);
      expect(c).not.toMatch(/[01IO]/);
    }
    expect(normalizeRoomCode(' ab-c 2x9q ')).toBe('ABC2X9');
  });
  it('compacts event floats', () => {
    const [e] = compactEvents([{ type: 'land', player: 1, speed: 6.123456789 }]);
    expect(e).toEqual({ type: 'land', player: 1, speed: 6.123 });
  });
});
