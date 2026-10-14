import { AMBIENCE, SYNTHS, gunshot, musicLoop, render } from './synth';
import { WEAPONS } from '@/data/weapons';

// WebAudio playback: buses (master/sfx/music/ui), positional HRTF voices for the world,
// synthesized buffer library, ambience + music loops.

export interface Volumes {
  master: number;
  sfx: number;
  music: number;
  ui: number;
}

export interface PlayOpts {
  volume?: number;
  rate?: number;
  /** World position for 3D sounds. */
  pos?: { x: number; y: number; z: number };
  /** Extra lowpass (Hz) e.g. for occluded or distant sounds. */
  lowpass?: number;
  bus?: 'sfx' | 'ui' | 'music';
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private buses!: Record<'sfx' | 'ui' | 'music', GainNode>;
  private buffers = new Map<string, AudioBuffer[]>();
  private ambienceSrc: AudioBufferSourceNode | null = null;
  private musicSrc: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;
  private currentMusic = '';
  private voices = 0;
  ready = false;
  volumes: Volumes = { master: 0.8, sfx: 0.9, music: 0.45, ui: 0.7 };
  hrtf = true;

  /** Must be called from a user gesture (browsers block autoplay). */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      this.master.connect(limiter).connect(this.ctx.destination);
      this.buses = {
        sfx: this.ctx.createGain(),
        ui: this.ctx.createGain(),
        music: this.ctx.createGain(),
      };
      for (const b of Object.values(this.buses)) b.connect(this.master);
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolumes(v: Partial<Volumes>): void {
    this.volumes = { ...this.volumes, ...v };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.03);
    this.buses.sfx.gain.setTargetAtTime(this.volumes.sfx, t, 0.03);
    this.buses.ui.gain.setTargetAtTime(this.volumes.ui, t, 0.03);
    this.buses.music.gain.setTargetAtTime(this.volumes.music, t, 0.03);
  }

  /** Synthesizes the whole sound library (runs offline, a few hundred ms). */
  async generate(onProgress?: (f: number) => void): Promise<void> {
    const jobs: [string, () => Promise<AudioBuffer>][] = [];
    for (const w of WEAPONS) {
      for (let v = 0; v < 3; v++) jobs.push([`gun_${w.id}`, () => render(gunshot(w.sound), 0.6 + w.sound.tail * 1.2, 1000 + v * 31 + w.id.length, 44100)]);
    }
    for (const [name, s] of Object.entries(SYNTHS)) {
      for (let v = 0; v < (s.variants ?? 1); v++) jobs.push([name, () => render(s.fn, s.dur, 77 + v * 13 + name.length)]);
    }
    jobs.push(['ambience', () => render(AMBIENCE.fn, AMBIENCE.dur, 5, 44100)]);
    const calm = musicLoop(false);
    const tense = musicLoop(true);
    jobs.push(['musicMenu', () => render(calm.fn, calm.dur, 9, 44100, 2)]);
    jobs.push(['musicMatch', () => render(tense.fn, tense.dur, 11, 44100, 2)]);
    let done = 0;
    // Render in small parallel batches to keep the main thread responsive.
    for (let i = 0; i < jobs.length; i += 6) {
      const batch = jobs.slice(i, i + 6);
      const bufs = await Promise.all(batch.map(([, f]) => f().catch(() => null)));
      batch.forEach(([name], k) => {
        const b = bufs[k];
        if (!b) return;
        const list = this.buffers.get(name);
        if (list) list.push(b);
        else this.buffers.set(name, [b]);
      });
      done += batch.length;
      onProgress?.(done / jobs.length);
    }
    this.ready = true;
  }

  has(name: string): boolean {
    return this.buffers.has(name);
  }

  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(x, t);
      l.positionY.setValueAtTime(y, t);
      l.positionZ.setValueAtTime(z, t);
      l.forwardX.setValueAtTime(fx, t);
      l.forwardY.setValueAtTime(fy, t);
      l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    } else {
      (l as unknown as { setPosition: (a: number, b: number, c: number) => void }).setPosition(x, y, z);
      (l as unknown as { setOrientation: (a: number, b: number, c: number, d: number, e: number, f: number) => void }).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  play(name: string, o: PlayOpts = {}): AudioBufferSourceNode | null {
    if (!this.ctx || !this.ready || this.ctx.state !== 'running') return null;
    const list = this.buffers.get(name);
    if (!list?.length) return null;
    if (this.voices > 48) return null;
    const buf = list[Math.floor(Math.random() * list.length)];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (o.rate ?? 1) * (0.97 + Math.random() * 0.06);
    const g = this.ctx.createGain();
    g.gain.value = o.volume ?? 1;
    let node: AudioNode = src;
    if (o.lowpass && o.lowpass < 20000) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = o.lowpass;
      node.connect(lp);
      node = lp;
    }
    node.connect(g);
    if (o.pos) {
      const p = this.ctx.createPanner();
      p.panningModel = this.hrtf ? 'HRTF' : 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = 2.5;
      p.maxDistance = 80;
      p.rolloffFactor = 1.1;
      p.positionX.value = o.pos.x;
      p.positionY.value = o.pos.y;
      p.positionZ.value = o.pos.z;
      g.connect(p).connect(this.buses[o.bus ?? 'sfx']);
    } else g.connect(this.buses[o.bus ?? 'sfx']);
    this.voices++;
    src.onended = () => {
      this.voices--;
      try {
        g.disconnect();
      } catch {
        /* already disconnected */
      }
    };
    src.start();
    return src;
  }

  ui(name: string, volume = 1): void {
    this.play(name, { bus: 'ui', volume });
  }

  startAmbience(volume = 0.5): void {
    if (!this.ctx || this.ambienceSrc || !this.buffers.has('ambience')) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get('ambience')![0];
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.buses.sfx);
    src.start();
    this.ambienceSrc = src;
  }

  stopAmbience(): void {
    this.ambienceSrc?.stop();
    this.ambienceSrc = null;
  }

  playMusic(which: 'musicMenu' | 'musicMatch' | null, fade = 1.5): void {
    if (!this.ctx || which === this.currentMusic) return;
    const t = this.ctx.currentTime;
    if (this.musicSrc && this.musicGain) {
      const old = this.musicSrc;
      this.musicGain.gain.setTargetAtTime(0, t, fade / 3);
      setTimeout(() => old.stop(), fade * 1000 + 200);
    }
    this.currentMusic = which ?? '';
    if (!which || !this.buffers.has(which)) {
      this.musicSrc = null;
      return;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get(which)![0];
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + fade);
    src.connect(g).connect(this.buses.music);
    src.start();
    this.musicSrc = src;
    this.musicGain = g;
  }
}

export const audio = new AudioEngine();
