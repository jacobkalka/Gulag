// Procedural sound synthesis. Every sound in the game is generated here at load time with
// OfflineAudioContext — no audio files are downloaded (and nothing needs licensing).

export type SynthFn = (ctx: OfflineAudioContext, rnd: () => number) => void;

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number, rnd: () => number, color: 'white' | 'pink' | 'brown' = 'white'): AudioBuffer {
  const len = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const b = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = b.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = rnd() * 2 - 1;
    if (color === 'white') d[i] = w;
    else if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return b;
}

/** Noise burst through a filter with an envelope. */
function noiseHit(
  ctx: OfflineAudioContext,
  rnd: () => number,
  o: { t?: number; dur: number; type: BiquadFilterType; f: number; q?: number; f2?: number; gain: number; attack?: number; decay: number; color?: 'white' | 'pink' | 'brown'; dest?: AudioNode },
): void {
  const t0 = o.t ?? 0;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, o.dur + 0.05, rnd, o.color ?? 'white');
  const f = ctx.createBiquadFilter();
  f.type = o.type;
  f.frequency.setValueAtTime(o.f, t0);
  if (o.f2) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + o.dur);
  f.Q.value = o.q ?? 0.7;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(o.gain, t0 + (o.attack ?? 0.001));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + (o.attack ?? 0.001) + o.decay);
  src.connect(f).connect(g).connect(o.dest ?? ctx.destination);
  src.start(t0);
  src.stop(t0 + o.dur + 0.05);
}

function tone(
  ctx: OfflineAudioContext,
  o: { t?: number; type?: OscillatorType; f: number; f2?: number; dur: number; gain: number; attack?: number; dest?: AudioNode; detune?: number },
): void {
  const t0 = o.t ?? 0;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f, t0);
  if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(10, o.f2), t0 + o.dur);
  if (o.detune) osc.detune.value = o.detune;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(o.gain, t0 + (o.attack ?? 0.003));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g).connect(o.dest ?? ctx.destination);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

/** Simple feedback-delay "room" reverb bus. */
function room(ctx: OfflineAudioContext, size = 0.35, wet = 0.35): { input: GainNode } {
  const input = ctx.createGain();
  const out = ctx.destination;
  const dry = ctx.createGain();
  dry.gain.value = 1;
  input.connect(dry).connect(out);
  const delays = [0.031, 0.043, 0.057, 0.071].map((d) => d * (0.6 + size));
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3500;
  const wetG = ctx.createGain();
  wetG.gain.value = wet;
  lp.connect(wetG).connect(out);
  for (const d of delays) {
    const dl = ctx.createDelay(1);
    dl.delayTime.value = d;
    const fb = ctx.createGain();
    fb.gain.value = 0.55 + size * 0.25;
    input.connect(dl);
    dl.connect(fb).connect(dl);
    dl.connect(lp);
  }
  return { input };
}

function compressorBus(ctx: OfflineAudioContext, dest: AudioNode): AudioNode {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = -14;
  c.knee.value = 6;
  c.ratio.value = 6;
  c.attack.value = 0.002;
  c.release.value = 0.12;
  c.connect(dest);
  return c;
}

export interface GunProfile {
  body: number;
  crack: number;
  tail: number;
  pitch: number;
  mech: number;
}

export function gunshot(p: GunProfile): SynthFn {
  return (ctx, rnd) => {
    const rv = room(ctx, 0.3 + p.tail * 0.3, 0.22 + p.tail * 0.15);
    const bus = compressorBus(ctx, rv.input);
    const pv = p.pitch * (0.96 + rnd() * 0.08);
    // supersonic crack
    noiseHit(ctx, rnd, { dur: 0.03, type: 'highpass', f: 2500 * pv, gain: 0.9 * p.crack, decay: 0.012 + 0.01 * p.crack, dest: bus });
    noiseHit(ctx, rnd, { dur: 0.06, type: 'bandpass', f: 4200 * pv, q: 0.8, gain: 0.5 * p.crack, decay: 0.03, dest: bus });
    // muzzle blast body
    noiseHit(ctx, rnd, { dur: 0.25, type: 'lowpass', f: 1800 * pv, f2: 300, gain: 1.1 * p.body, decay: 0.09 + 0.06 * p.body, color: 'pink', dest: bus });
    tone(ctx, { type: 'sine', f: 140 * pv, f2: 38, dur: 0.16 + 0.08 * p.body, gain: 0.9 * p.body, dest: bus });
    tone(ctx, { type: 'triangle', f: 85 * pv, f2: 30, dur: 0.22 * p.body + 0.05, gain: 0.5 * p.body, dest: bus });
    // mechanism
    noiseHit(ctx, rnd, { t: 0.012 + rnd() * 0.01, dur: 0.02, type: 'bandpass', f: 3400 + rnd() * 900, q: 4, gain: 0.25 * p.mech, decay: 0.012, dest: bus });
    noiseHit(ctx, rnd, { t: 0.05 + rnd() * 0.02, dur: 0.02, type: 'bandpass', f: 2600 + rnd() * 600, q: 5, gain: 0.18 * p.mech, decay: 0.015, dest: bus });
    // indoor slap / tail
    noiseHit(ctx, rnd, { t: 0.015, dur: 0.9 * p.tail + 0.2, type: 'lowpass', f: 1200 * pv, f2: 200, gain: 0.32 * p.tail, decay: 0.35 + 0.6 * p.tail, color: 'brown', dest: rv.input });
  };
}

export const SYNTHS: Record<string, { fn: SynthFn; dur: number; variants?: number }> = {
  // ---------------- mechanics
  magOut: {
    dur: 0.35,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.03, type: 'bandpass', f: 2800, q: 6, gain: 0.5, decay: 0.02 });
      noiseHit(ctx, r, { t: 0.04, dur: 0.18, type: 'bandpass', f: 1200, q: 2, gain: 0.25, decay: 0.12 });
    },
  },
  magIn: {
    dur: 0.3,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.06, type: 'bandpass', f: 900, q: 2, gain: 0.6, decay: 0.05, color: 'pink' });
      noiseHit(ctx, r, { t: 0.05, dur: 0.03, type: 'bandpass', f: 3500, q: 7, gain: 0.6, decay: 0.02 });
      tone(ctx, { t: 0.05, f: 1900, f2: 1700, dur: 0.06, gain: 0.08 });
    },
  },
  boltBack: {
    dur: 0.3,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.12, type: 'bandpass', f: 2200, f2: 1400, q: 3, gain: 0.45, decay: 0.08 });
      noiseHit(ctx, r, { t: 0.1, dur: 0.03, type: 'bandpass', f: 3800, q: 8, gain: 0.5, decay: 0.02 });
    },
  },
  boltForward: {
    dur: 0.3,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.04, type: 'bandpass', f: 3000, q: 6, gain: 0.7, decay: 0.03 });
      tone(ctx, { f: 2400, f2: 2100, dur: 0.08, gain: 0.1 });
      noiseHit(ctx, r, { dur: 0.1, type: 'lowpass', f: 900, gain: 0.3, decay: 0.06, color: 'pink' });
    },
  },
  shellIn: {
    dur: 0.25,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.05, type: 'bandpass', f: 1600, q: 3, gain: 0.5, decay: 0.04 });
      noiseHit(ctx, r, { t: 0.05, dur: 0.03, type: 'bandpass', f: 3200, q: 6, gain: 0.35, decay: 0.02 });
    },
  },
  pump: {
    dur: 0.5,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.1, type: 'bandpass', f: 1500, f2: 900, q: 2, gain: 0.6, decay: 0.08 });
      noiseHit(ctx, r, { t: 0.18, dur: 0.1, type: 'bandpass', f: 1200, f2: 2000, q: 2, gain: 0.6, decay: 0.07 });
      noiseHit(ctx, r, { t: 0.27, dur: 0.03, type: 'bandpass', f: 3600, q: 8, gain: 0.5, decay: 0.02 });
    },
  },
  dryFire: {
    dur: 0.15,
    fn: (ctx, r) => noiseHit(ctx, r, { dur: 0.02, type: 'bandpass', f: 4200, q: 9, gain: 0.5, decay: 0.012 }),
  },
  swap: {
    dur: 0.4,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.2, type: 'bandpass', f: 800, f2: 1600, q: 1, gain: 0.18, decay: 0.15, color: 'pink' });
      noiseHit(ctx, r, { t: 0.2, dur: 0.03, type: 'bandpass', f: 3000, q: 6, gain: 0.3, decay: 0.02 });
    },
  },
  melee: {
    dur: 0.35,
    fn: (ctx, r) => noiseHit(ctx, r, { dur: 0.25, type: 'bandpass', f: 600, f2: 2400, q: 1.5, gain: 0.4, decay: 0.2, color: 'pink' }),
  },
  meleeHit: {
    dur: 0.3,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.1, type: 'lowpass', f: 600, gain: 1.0, decay: 0.08, color: 'brown' });
      tone(ctx, { f: 120, f2: 60, dur: 0.12, gain: 0.6 });
    },
  },
  // ---------------- feedback
  hitmarker: {
    dur: 0.12,
    fn: (ctx) => {
      tone(ctx, { type: 'square', f: 2900, dur: 0.035, gain: 0.08 });
      tone(ctx, { type: 'sine', f: 1800, dur: 0.05, gain: 0.12 });
    },
  },
  headshot: {
    dur: 0.4,
    fn: (ctx) => {
      tone(ctx, { type: 'sine', f: 2400, dur: 0.25, gain: 0.18 });
      tone(ctx, { type: 'sine', f: 3600, dur: 0.18, gain: 0.08 });
      tone(ctx, { type: 'triangle', f: 1200, dur: 0.06, gain: 0.12 });
    },
  },
  killConfirm: {
    dur: 0.6,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.08, type: 'lowpass', f: 500, gain: 0.7, decay: 0.07, color: 'brown' });
      tone(ctx, { type: 'sine', f: 90, f2: 50, dur: 0.18, gain: 0.6 });
      tone(ctx, { t: 0.04, type: 'triangle', f: 880, dur: 0.3, gain: 0.12 });
      tone(ctx, { t: 0.08, type: 'sine', f: 1320, dur: 0.35, gain: 0.08 });
    },
  },
  hurt: {
    dur: 0.3,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.12, type: 'lowpass', f: 300, gain: 0.8, decay: 0.1, color: 'brown' });
      tone(ctx, { f: 70, f2: 45, dur: 0.15, gain: 0.5 });
    },
  },
  impactConcrete: {
    dur: 0.25,
    variants: 3,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.04, type: 'bandpass', f: 2200 + r() * 800, q: 1.5, gain: 0.7, decay: 0.03 });
      noiseHit(ctx, r, { t: 0.01, dur: 0.15, type: 'lowpass', f: 1400, gain: 0.3, decay: 0.12, color: 'pink' });
    },
  },
  impactMetal: {
    dur: 0.5,
    variants: 3,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.03, type: 'highpass', f: 3000, gain: 0.6, decay: 0.02 });
      const f = 1400 + r() * 1800;
      tone(ctx, { type: 'sine', f, dur: 0.35, gain: 0.12 });
      tone(ctx, { type: 'sine', f: f * 1.51, dur: 0.25, gain: 0.07 });
      tone(ctx, { type: 'sine', f: f * 2.37, dur: 0.15, gain: 0.04 });
    },
  },
  impactFlesh: {
    dur: 0.2,
    variants: 2,
    fn: (ctx, r) => noiseHit(ctx, r, { dur: 0.08, type: 'lowpass', f: 700, gain: 0.8, decay: 0.06, color: 'pink' }),
  },
  impactWood: {
    dur: 0.25,
    variants: 2,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.05, type: 'bandpass', f: 900 + r() * 300, q: 2.5, gain: 0.8, decay: 0.05 });
      tone(ctx, { f: 320 + r() * 80, f2: 200, dur: 0.08, gain: 0.25 });
    },
  },
  impactWater: {
    dur: 0.35,
    variants: 2,
    fn: (ctx, r) => noiseHit(ctx, r, { dur: 0.25, type: 'bandpass', f: 1400, f2: 500, q: 1, gain: 0.5, decay: 0.2 }),
  },
  ricochet: {
    dur: 0.6,
    variants: 3,
    fn: (ctx, r) => {
      const f = 2600 + r() * 2200;
      tone(ctx, { type: 'sine', f, f2: f * 0.55, dur: 0.45, gain: 0.1 });
      noiseHit(ctx, r, { dur: 0.03, type: 'highpass', f: 4000, gain: 0.3, decay: 0.02 });
    },
  },
  whiz: {
    dur: 0.3,
    variants: 2,
    fn: (ctx, r) => noiseHit(ctx, r, { dur: 0.18, type: 'bandpass', f: 1200, f2: 3500, q: 3, gain: 0.35, attack: 0.08, decay: 0.08 }),
  },
  // ---------------- footsteps
  stepConcrete: {
    dur: 0.25,
    variants: 4,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.05, type: 'lowpass', f: 600 + r() * 200, gain: 0.7, decay: 0.05, color: 'pink' });
      noiseHit(ctx, r, { t: 0.01, dur: 0.06, type: 'highpass', f: 2500, gain: 0.12, decay: 0.04 });
    },
  },
  stepMetal: {
    dur: 0.4,
    variants: 4,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.05, type: 'lowpass', f: 900, gain: 0.6, decay: 0.05 });
      const f = 380 + r() * 150;
      tone(ctx, { f, dur: 0.25, gain: 0.1 });
      tone(ctx, { f: f * 2.7, dur: 0.15, gain: 0.05 });
      noiseHit(ctx, r, { dur: 0.1, type: 'bandpass', f: 2200, q: 6, gain: 0.12, decay: 0.08 });
    },
  },
  stepTile: {
    dur: 0.25,
    variants: 4,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.03, type: 'bandpass', f: 2600 + r() * 600, q: 2, gain: 0.5, decay: 0.025 });
      noiseHit(ctx, r, { dur: 0.06, type: 'lowpass', f: 700, gain: 0.5, decay: 0.05, color: 'pink' });
    },
  },
  stepWater: {
    dur: 0.35,
    variants: 4,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.2, type: 'bandpass', f: 1200 + r() * 600, f2: 600, q: 1.2, gain: 0.5, decay: 0.15 });
      noiseHit(ctx, r, { dur: 0.05, type: 'lowpass', f: 500, gain: 0.5, decay: 0.05, color: 'pink' });
    },
  },
  land: {
    dur: 0.35,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.1, type: 'lowpass', f: 400, gain: 0.9, decay: 0.09, color: 'brown' });
      tone(ctx, { f: 80, f2: 45, dur: 0.12, gain: 0.5 });
      noiseHit(ctx, r, { t: 0.02, dur: 0.1, type: 'bandpass', f: 2000, q: 2, gain: 0.15, decay: 0.07 });
    },
  },
  slide: {
    dur: 0.8,
    fn: (ctx, r) => noiseHit(ctx, r, { dur: 0.7, type: 'bandpass', f: 1800, f2: 700, q: 0.8, gain: 0.35, attack: 0.03, decay: 0.6, color: 'pink' }),
  },
  jump: {
    dur: 0.25,
    fn: (ctx, r) => noiseHit(ctx, r, { dur: 0.12, type: 'bandpass', f: 900, f2: 1600, q: 1, gain: 0.2, decay: 0.1, color: 'pink' }),
  },
  // ---------------- grenades
  explosion: {
    dur: 3.0,
    fn: (ctx, r) => {
      const rv = room(ctx, 0.9, 0.5);
      noiseHit(ctx, r, { dur: 0.4, type: 'lowpass', f: 3000, f2: 200, gain: 1.2, decay: 0.3, color: 'pink', dest: rv.input });
      tone(ctx, { f: 70, f2: 22, dur: 1.2, gain: 1.0, dest: rv.input });
      noiseHit(ctx, r, { t: 0.05, dur: 2.5, type: 'lowpass', f: 600, f2: 80, gain: 0.6, decay: 2.2, color: 'brown', dest: rv.input });
      for (let i = 0; i < 6; i++) noiseHit(ctx, r, { t: 0.3 + r() * 1.2, dur: 0.03, type: 'bandpass', f: 2000 + r() * 2000, q: 5, gain: 0.15, decay: 0.02 });
    },
  },
  flashbang: {
    dur: 2.5,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.2, type: 'highpass', f: 1500, gain: 1.0, decay: 0.15 });
      tone(ctx, { f: 60, f2: 30, dur: 0.6, gain: 0.8 });
      noiseHit(ctx, r, { t: 0.02, dur: 1.8, type: 'lowpass', f: 1500, f2: 100, gain: 0.4, decay: 1.5, color: 'pink' });
    },
  },
  tinnitus: {
    dur: 3.0,
    fn: (ctx) => tone(ctx, { type: 'sine', f: 4100, dur: 3.0, gain: 0.12, attack: 0.05 }),
  },
  pin: {
    dur: 0.4,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.03, type: 'bandpass', f: 4000, q: 8, gain: 0.4, decay: 0.02 });
      tone(ctx, { t: 0.05, f: 2800, dur: 0.2, gain: 0.06 });
    },
  },
  bounce: {
    dur: 0.3,
    variants: 2,
    fn: (ctx, r) => {
      noiseHit(ctx, r, { dur: 0.03, type: 'bandpass', f: 1800 + r() * 800, q: 4, gain: 0.4, decay: 0.03 });
      tone(ctx, { f: 1200 + r() * 600, dur: 0.12, gain: 0.05 });
    },
  },
  // ---------------- UI & match flow
  uiHover: { dur: 0.08, fn: (ctx) => tone(ctx, { type: 'sine', f: 1800, dur: 0.04, gain: 0.05 }) },
  uiClick: {
    dur: 0.15,
    fn: (ctx, r) => {
      tone(ctx, { type: 'triangle', f: 900, f2: 700, dur: 0.06, gain: 0.14 });
      noiseHit(ctx, r, { dur: 0.02, type: 'bandpass', f: 3000, q: 4, gain: 0.15, decay: 0.012 });
    },
  },
  uiConfirm: {
    dur: 0.5,
    fn: (ctx) => {
      tone(ctx, { type: 'triangle', f: 660, dur: 0.12, gain: 0.14 });
      tone(ctx, { t: 0.08, type: 'triangle', f: 990, dur: 0.25, gain: 0.14 });
    },
  },
  uiError: {
    dur: 0.4,
    fn: (ctx) => {
      tone(ctx, { type: 'square', f: 220, dur: 0.12, gain: 0.08 });
      tone(ctx, { t: 0.12, type: 'square', f: 180, dur: 0.18, gain: 0.08 });
    },
  },
  notify: {
    dur: 0.7,
    fn: (ctx) => {
      tone(ctx, { type: 'sine', f: 880, dur: 0.2, gain: 0.12 });
      tone(ctx, { t: 0.12, type: 'sine', f: 1320, dur: 0.4, gain: 0.12 });
    },
  },
  matchFound: {
    dur: 1.6,
    fn: (ctx) => {
      [440, 554, 659, 880].forEach((f, i) => tone(ctx, { t: i * 0.09, type: 'triangle', f, dur: 0.9, gain: 0.12 }));
      tone(ctx, { t: 0, type: 'sine', f: 110, dur: 1.4, gain: 0.25 });
    },
  },
  countBeep: { dur: 0.3, fn: (ctx) => tone(ctx, { type: 'square', f: 880, dur: 0.12, gain: 0.08 }) },
  countGo: {
    dur: 0.7,
    fn: (ctx) => {
      tone(ctx, { type: 'square', f: 1320, dur: 0.35, gain: 0.08 });
      tone(ctx, { type: 'sine', f: 660, dur: 0.5, gain: 0.12 });
    },
  },
  roundWin: {
    dur: 2.2,
    fn: (ctx) => {
      [261.6, 329.6, 392, 523.2].forEach((f, i) => tone(ctx, { t: i * 0.06, type: 'sawtooth', f, dur: 1.6, gain: 0.05 }));
      tone(ctx, { type: 'sine', f: 65.4, dur: 1.8, gain: 0.3 });
    },
  },
  roundLose: {
    dur: 2.2,
    fn: (ctx) => {
      [220, 261.6, 311.1].forEach((f, i) => tone(ctx, { t: i * 0.1, type: 'sawtooth', f, f2: f * 0.94, dur: 1.7, gain: 0.05 }));
      tone(ctx, { type: 'sine', f: 55, f2: 45, dur: 1.9, gain: 0.3 });
    },
  },
  overtime: {
    dur: 2.0,
    fn: (ctx) => {
      for (let i = 0; i < 3; i++) tone(ctx, { t: i * 0.55, type: 'sawtooth', f: 520, f2: 760, dur: 0.45, gain: 0.07 });
    },
  },
  capture: {
    dur: 1.2,
    fn: (ctx) => {
      tone(ctx, { type: 'triangle', f: 523, dur: 0.3, gain: 0.12 });
      tone(ctx, { t: 0.15, type: 'triangle', f: 784, dur: 0.6, gain: 0.12 });
    },
  },
  levelUp: {
    dur: 2.0,
    fn: (ctx) => {
      [392, 523.2, 659.3, 784, 1046.5].forEach((f, i) => tone(ctx, { t: i * 0.08, type: 'triangle', f, dur: 1.1, gain: 0.1 }));
    },
  },
  xpTick: { dur: 0.06, fn: (ctx) => tone(ctx, { type: 'sine', f: 1400, dur: 0.03, gain: 0.05 }) },
};

/** Looping bunker ambience: low hum, ventilation, distant drips. */
export const AMBIENCE: { fn: SynthFn; dur: number } = {
  dur: 12,
  fn: (ctx, r) => {
    const out = ctx.destination;
    const hum = ctx.createGain();
    hum.gain.value = 0.18;
    hum.connect(out);
    for (const [f, g] of [[50, 0.5], [100, 0.25], [150, 0.08]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const gg = ctx.createGain();
      gg.gain.value = g;
      o.connect(gg).connect(hum);
      o.start();
      o.stop(12);
    }
    const vent = ctx.createBufferSource();
    vent.buffer = noiseBuffer(ctx, 12, r, 'brown');
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    const vg = ctx.createGain();
    vg.gain.value = 0.35;
    vent.connect(lp).connect(vg).connect(out);
    vent.start();
    for (let i = 0; i < 9; i++) {
      const t = 0.5 + r() * 11;
      tone(ctx, { t, type: 'sine', f: 1100 + r() * 900, f2: 700, dur: 0.12, gain: 0.04 + r() * 0.03 });
    }
    // distant metal groan
    tone(ctx, { t: 4 + r() * 4, type: 'sawtooth', f: 90, f2: 70, dur: 2.5, gain: 0.015, attack: 0.8 });
  },
};

/** Tense, minimal match soundtrack loop (synth pad + pulse + sparse percussion). */
export function musicLoop(intense: boolean): { fn: SynthFn; dur: number } {
  const bpm = intense ? 112 : 84;
  const beat = 60 / bpm;
  const bars = 8;
  const dur = beat * 4 * bars;
  return {
    dur,
    fn: (ctx, r) => {
      const master = ctx.createGain();
      master.gain.value = 0.5;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
      const roots = intense ? [55, 55, 51.9, 49] : [55, 58.3, 51.9, 49];
      // pad
      for (let b = 0; b < bars; b++) {
        const root = roots[b % 4];
        const t = b * beat * 4;
        const chord = [root * 2, root * 2 * 1.189, root * 2 * 1.498];
        for (const f of chord) {
          for (const det of [-7, 7]) {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.value = f;
            o.detune.value = det;
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.setValueAtTime(300, t);
            lp.frequency.linearRampToValueAtTime(intense ? 1400 : 900, t + beat * 2);
            lp.frequency.linearRampToValueAtTime(300, t + beat * 4);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.025, t + beat * 0.8);
            g.gain.linearRampToValueAtTime(0.0, t + beat * 4 + 0.05);
            o.connect(lp).connect(g).connect(master);
            o.start(t);
            o.stop(t + beat * 4 + 0.1);
          }
        }
        // bass pulse (8ths)
        for (let i = 0; i < 8; i++) {
          const tt = t + i * beat * 0.5;
          tone(ctx, { t: tt, type: 'square', f: root, dur: beat * 0.4, gain: intense ? 0.06 : 0.035, dest: master });
        }
        // percussion
        for (let i = 0; i < 4; i++) {
          const tt = t + i * beat;
          if (i % 2 === 0 || intense) tone(ctx, { t: tt, type: 'sine', f: 120, f2: 40, dur: 0.25, gain: 0.35, dest: master });
          if (intense && i % 2 === 1) noiseHit(ctx, r, { t: tt, dur: 0.15, type: 'bandpass', f: 1800, q: 0.8, gain: 0.12, decay: 0.12, dest: master });
          noiseHit(ctx, r, { t: tt + beat * 0.5, dur: 0.05, type: 'highpass', f: 7000, gain: intense ? 0.05 : 0.03, decay: 0.03, dest: master });
        }
      }
      // tension riser in the last bar
      noiseHit(ctx, r, { t: dur - beat * 4, dur: beat * 4, type: 'bandpass', f: 400, f2: 4000, q: 2, gain: 0.05, attack: beat * 3.5, decay: 0.2, dest: master });
    },
  };
}

export async function render(fn: SynthFn, dur: number, seed: number, sampleRate = 44100, channels = 1): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(channels, Math.max(1, Math.ceil(dur * sampleRate)), sampleRate);
  fn(ctx, mulberry(seed));
  return ctx.startRendering();
}
