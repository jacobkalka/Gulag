import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { radialTexture } from '@/assets/textures/canvasTextures';
import type { Surface } from '@/game/world/mapTypes';

// Pooled VFX: particles (additive sparks + alpha dust/smoke), tracers, muzzle flashes,
// bullet-hole decals, explosions. Light count is fixed (pooled) so shaders never recompile.

const PARTICLE_VERT = /* glsl */ `
attribute float size;
attribute vec4 pcolor;
varying vec4 vColor;
uniform float uScale;
void main() {
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * uScale / max(0.05, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec4 vColor;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a;
  gl_FragColor = vec4(vColor.rgb * (vColor.a * a), vColor.a * a);
}`;

class ParticlePool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grow: Float32Array;
  private baseA: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private next = 0;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;

  constructor(readonly max: number, additive: boolean) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.grow = new Float32Array(max);
    this.baseA = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: { uMap: { value: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 64) }, uScale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    // NormalBlending with premultiplied color: use custom blend for correct alpha
    if (!additive) {
      this.mat.blending = THREE.CustomBlending;
      this.mat.blendSrc = THREE.OneFactor;
      this.mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    }
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 8 : 7;
  }

  setScale(px: number): void {
    this.mat.uniforms.uScale.value = px;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grow: number, r: number, g: number, b: number, a: number, drag = 1, grav = 0): void {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.col[i * 4 + 3] = a;
    this.baseA[i] = a;
    this.drag[i] = drag;
    this.grav[i] = grav;
  }

  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        if (this.size[i] !== 0) {
          this.size[i] = 0;
          this.col[i * 4 + 3] = 0;
        }
        continue;
      }
      this.life[i] -= dt;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.col[i * 4 + 3] = this.baseA[i] * Math.min(1, t * 2.5);
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('pcolor') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Tracer look: a thin hot core (screen-space width) with a short fading streak. */
const TRACER = {
  /** Visual speed of the round (m/s); real tracers are faster, this keeps a few frames visible. */
  speed: 520,
  /** Streak length behind the head (m). */
  length: 1.3,
  /** Core width in CSS pixels. */
  widthPx: 1.6,
  /** HDR head color (kept modest: the bloom is clamped and must not blow out). */
  head: [2.1, 0.95, 0.38] as const,
  max: 48,
};

interface Tracer {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  len: number;
  t: number;
  active: boolean;
  /** Brightness multiplier (remote shots read a little brighter so you can find the shooter). */
  gain: number;
}

interface Flash {
  sprite: THREE.Sprite;
  t: number;
}

function holeTexture(): THREE.Texture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(5,5,5,1)');
  grad.addColorStop(0.18, 'rgba(12,11,10,0.95)');
  grad.addColorStop(0.3, 'rgba(40,36,32,0.7)');
  grad.addColorStop(0.55, 'rgba(70,64,58,0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(20,18,16,0.6)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2;
    const l = S * (0.18 + Math.random() * 0.22);
    g.beginPath();
    g.moveTo(S / 2 + Math.cos(a) * S * 0.08, S / 2 + Math.sin(a) * S * 0.08);
    g.lineTo(S / 2 + Math.cos(a + 0.2) * l, S / 2 + Math.sin(a + 0.2) * l);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  readonly group = new THREE.Group();
  private add: ParticlePool;
  private alpha: ParticlePool;
  private tracers: Tracer[] = [];
  private tracerLines: LineSegments2;
  private tracerGeo: LineSegmentsGeometry;
  private tracerMat: LineMaterial;
  private tracerPos: Float32Array;
  private tracerCol: Float32Array;
  private flashes: Flash[] = [];
  private flashLights: { light: THREE.PointLight; t: number }[] = [];
  private holes: THREE.InstancedMesh;
  private holeNext = 0;
  private holeCount: number;
  private flashMat: THREE.SpriteMaterial;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();
  private tmpP = new THREE.Vector3();
  scale: number;

  constructor(opts: { particleScale: number; decalLimit: number }) {
    this.scale = opts.particleScale;
    this.add = new ParticlePool(Math.floor(700 * Math.max(0.4, opts.particleScale)), true);
    this.alpha = new ParticlePool(Math.floor(600 * Math.max(0.4, opts.particleScale)), false);
    this.group.add(this.add.points, this.alpha.points);
    // Tracers: one batched set of screen-space line segments (constant pixel width, so a round
    // passing near the camera is still a hairline, not a glowing stick).
    this.tracerPos = new Float32Array(TRACER.max * 6);
    this.tracerCol = new Float32Array(TRACER.max * 6);
    this.tracerGeo = new LineSegmentsGeometry();
    this.tracerGeo.setPositions(this.tracerPos);
    this.tracerGeo.setColors(this.tracerCol);
    this.tracerMat = new LineMaterial({ linewidth: TRACER.widthPx, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, worldUnits: false });
    this.tracerMat.toneMapped = false;
    this.tracerLines = new LineSegments2(this.tracerGeo, this.tracerMat);
    this.tracerLines.frustumCulled = false;
    this.tracerLines.renderOrder = 9;
    this.group.add(this.tracerLines);
    for (let i = 0; i < TRACER.max; i++) this.tracers.push({ ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0, len: 0, t: 0, active: false, gain: 1 });
    this.flashMat = new THREE.SpriteMaterial({
      map: radialTexture('rgba(255,236,190,1)', 'rgba(255,120,30,0)', 64),
      color: new THREE.Color(1, 0.78, 0.48).multiplyScalar(2.6),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    for (let i = 0; i < 12; i++) {
      const s = new THREE.Sprite(this.flashMat);
      s.visible = false;
      s.renderOrder = 10;
      this.group.add(s);
      this.flashes.push({ sprite: s, t: 0 });
    }
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 9, 2);
      this.group.add(l);
      this.flashLights.push({ light: l, t: 0 });
    }
    this.holeCount = opts.decalLimit;
    const holeGeo = new THREE.PlaneGeometry(1, 1);
    const holeMat = new THREE.MeshStandardMaterial({
      map: holeTexture(),
      transparent: true,
      depthWrite: false,
      roughness: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.holes = new THREE.InstancedMesh(holeGeo, holeMat, this.holeCount);
    this.holes.count = 0;
    this.holes.frustumCulled = false;
    this.holes.renderOrder = 3;
    this.holes.receiveShadow = true;
    this.group.add(this.holes);
  }

  setPixelScale(heightPx: number, widthPx = heightPx * (16 / 9)): void {
    this.add.setScale(heightPx * 0.9);
    this.alpha.setScale(heightPx * 0.9);
    this.tracerMat.resolution.set(widthPx, heightPx);
  }

  /**
   * A tracer from (ox,oy,oz) toward (ex,ey,ez). `skip` meters at the start are not drawn
   * (the shooter's own rounds appear downrange instead of crossing the reticle).
   */
  tracer(ox: number, oy: number, oz: number, ex: number, ey: number, ez: number, gain = 1, skip = 0): void {
    const len = Math.hypot(ex - ox, ey - oy, ez - oz);
    if (len < skip + 1.5) return;
    const tr = this.tracers.find((t) => !t.active) ?? this.tracers[0];
    tr.active = true;
    tr.dx = (ex - ox) / len;
    tr.dy = (ey - oy) / len;
    tr.dz = (ez - oz) / len;
    tr.ox = ox + tr.dx * skip;
    tr.oy = oy + tr.dy * skip;
    tr.oz = oz + tr.dz * skip;
    tr.len = len - skip;
    tr.t = 0;
    tr.gain = gain;
  }

  /**
   * Muzzle flash in the world (other players). Small, brief and clamped: a short light pulse for
   * the room and a tiny HDR sprite; smoke drifts away from the shooter.
   */
  muzzleFlash(x: number, y: number, z: number, size = 0.22, light = true, lightIntensity = 6, smoke = 1): void {
    const f = this.flashes.find((q) => q.t <= 0) ?? this.flashes[0];
    f.t = 0.035;
    f.sprite.position.set(x, y, z);
    f.sprite.scale.setScalar(size * (0.8 + Math.random() * 0.4));
    f.sprite.material.rotation = Math.random() * Math.PI;
    f.sprite.visible = true;
    if (light) this.flashLight(x, y, z, lightIntensity, 0.05);
    const n = Math.round(2 * this.scale * smoke);
    for (let i = 0; i < n; i++) {
      this.alpha.emit(x, y, z, (Math.random() - 0.5) * 0.5, 0.15 + Math.random() * 0.35, (Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 0.3, 0.1, 0.45, 0.17, 0.16, 0.15, 0.12, 2.2, -0.2);
    }
  }

  /** Short clamped light pulse (muzzle flashes). */
  flashLight(x: number, y: number, z: number, intensity: number, t = 0.05): void {
    const l = this.flashLights.reduce((a, b) => (a.t < b.t ? a : b));
    l.t = t;
    l.light.position.set(x, y, z);
    l.light.intensity = Math.min(intensity, 8);
    l.light.distance = 6;
  }

  /** Thin smoke wisp leaving the local muzzle, pushed forward so it never hangs in front of the sights. */
  muzzleSmoke(x: number, y: number, z: number, fx: number, fy: number, fz: number, amount = 1): void {
    const n = Math.round(1 * this.scale * amount);
    for (let i = 0; i < n; i++) {
      this.alpha.emit(x + fx * 0.45, y + fy * 0.45 + 0.03, z + fz * 0.45, fx * 2.2 + (Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.2, fz * 2.2 + (Math.random() - 0.5) * 0.3, 0.35, 0.04, 0.3, 0.1, 0.1, 0.09, 0.05, 2.5, -0.25);
    }
  }

  impact(x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: Surface | 'flesh', camPos: THREE.Vector3, withDecal = true): void {
    const s = this.scale;
    const n = (k: number) => Math.max(1, Math.round(k * s));
    const rnd = () => Math.random() - 0.5;
    if (surface === 'flesh') {
      for (let i = 0; i < n(6); i++) this.alpha.emit(x, y, z, rnd() * 1.2 + nx, rnd() * 1.2 + 0.4, rnd() * 1.2 + nz, 0.35 + Math.random() * 0.25, 0.08, 0.5, 0.32, 0.03, 0.02, 0.55, 3, 2);
      return;
    }
    const spark = surface === 'metal' || surface === 'concrete' || surface === 'tile';
    if (spark) {
      const cnt = surface === 'metal' ? n(10) : n(4);
      for (let i = 0; i < cnt; i++) {
        const sp = 3 + Math.random() * 5;
        this.add.emit(x, y, z, (nx + rnd() * 1.6) * sp, (ny + rnd() * 1.6 + 0.3) * sp, (nz + rnd() * 1.6) * sp, 0.12 + Math.random() * 0.2, 0.035, -0.05, 1.0, 0.62, 0.25, 1.0, 1.5, 9);
      }
    }
    if (surface === 'water') {
      for (let i = 0; i < n(10); i++) this.alpha.emit(x, y, z, rnd() * 1.5, 2 + Math.random() * 2.5, rnd() * 1.5, 0.5, 0.05, 0.05, 0.6, 0.65, 0.7, 0.5, 1, 9);
    } else {
      // dust is unlit, so keep it dim: it should read as a puff of grit, not a glowing ball
      const dust: [number, number, number] =
        surface === 'wood' ? [0.2, 0.15, 0.1] : surface === 'tile' ? [0.32, 0.31, 0.29] : surface === 'metal' ? [0.14, 0.14, 0.14] : [0.24, 0.23, 0.21];
      for (let i = 0; i < n(6); i++) {
        const sp = 0.6 + Math.random() * 1.6;
        this.alpha.emit(x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, (nx + rnd() * 0.8) * sp, (ny + rnd() * 0.8) * sp + 0.2, (nz + rnd() * 0.8) * sp, 0.55 + Math.random() * 0.5, 0.09, 0.45, dust[0], dust[1], dust[2], 0.32, 3.5, 0.6);
      }
      // chips
      for (let i = 0; i < n(4); i++) {
        const sp = 2 + Math.random() * 3;
        this.alpha.emit(x, y, z, (nx + rnd()) * sp, (ny + rnd() + 0.5) * sp, (nz + rnd()) * sp, 0.5, 0.025, 0, dust[0] * 0.6, dust[1] * 0.6, dust[2] * 0.6, 0.9, 0.5, 12);
      }
    }
    if (withDecal && surface !== 'water' && surface !== 'glass') this.addHole(x, y, z, nx, ny, nz, surface === 'metal' ? 0.07 : 0.1);
    void camPos;
  }

  private addHole(x: number, y: number, z: number, nx: number, ny: number, nz: number, size: number): void {
    if (this.holeCount <= 0) return;
    const i = this.holeNext;
    this.holeNext = (this.holeNext + 1) % this.holeCount;
    this.tmpP.set(x + nx * 0.004, y + ny * 0.004, z + nz * 0.004);
    this.tmpQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(nx, ny, nz));
    this.tmpQ.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.random() * Math.PI * 2));
    const s = size * (0.8 + Math.random() * 0.5);
    this.tmpS.set(s, s, s);
    this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
    this.holes.setMatrixAt(i, this.tmpM);
    this.holes.count = Math.max(this.holes.count, i + 1);
    this.holes.instanceMatrix.needsUpdate = true;
  }

  explosion(x: number, y: number, z: number, kind: 'frag' | 'flash'): void {
    const s = this.scale;
    const l = this.flashLights.reduce((a, b) => (a.t < b.t ? a : b));
    l.t = 0.25;
    l.light.position.set(x, y + 0.3, z);
    l.light.intensity = kind === 'frag' ? 400 : 900;
    l.light.distance = 14;
    const f = this.flashes.find((q) => q.t <= 0) ?? this.flashes[0];
    f.t = 0.12;
    f.sprite.position.set(x, y + 0.3, z);
    f.sprite.scale.setScalar(kind === 'frag' ? 3.2 : 4.5);
    f.sprite.visible = true;
    const rnd = () => Math.random() - 0.5;
    for (let i = 0; i < 40 * s; i++) {
      const sp = 4 + Math.random() * 9;
      this.add.emit(x, y + 0.2, z, rnd() * sp, Math.random() * sp * 0.8, rnd() * sp, 0.3 + Math.random() * 0.4, 0.05, 0, 1, 0.65, 0.3, 1, 1.2, 9);
    }
    if (kind === 'frag') {
      for (let i = 0; i < 26 * s; i++) {
        const sp = 1 + Math.random() * 3;
        this.alpha.emit(x + rnd() * 0.6, y + 0.3 + Math.random() * 0.5, z + rnd() * 0.6, rnd() * sp, Math.random() * sp * 0.6, rnd() * sp, 1.8 + Math.random() * 1.5, 0.5, 1.2, 0.16, 0.15, 0.14, 0.65, 1.5, -0.25);
      }
      for (let i = 0; i < 16 * s; i++) {
        const sp = 4 + Math.random() * 5;
        this.alpha.emit(x, y + 0.2, z, rnd() * sp, Math.random() * sp, rnd() * sp, 1.0, 0.04, 0, 0.2, 0.19, 0.18, 1, 0.3, 14);
      }
    }
  }

  update(dt: number): void {
    this.add.update(dt);
    this.alpha.update(dt);
    const P = this.tracerPos;
    const C = this.tracerCol;
    for (let i = 0; i < this.tracers.length; i++) {
      const tr = this.tracers[i];
      const o = i * 6;
      if (tr.active) {
        tr.t += dt;
        // the streak travels at the visual speed; once it arrives a short stub stays at the end
        // for a couple of frames, so even a round into a wall a few meters away is seen
        const tEnd = (tr.len + TRACER.length) / TRACER.speed;
        const head = Math.min(tr.len, tr.t * TRACER.speed);
        const tail = Math.max(0, Math.min(head - TRACER.length, tr.len - TRACER.length * 0.5));
        if (tr.t > tEnd + 0.045) tr.active = false;
        else {
          P[o] = tr.ox + tr.dx * tail;
          P[o + 1] = tr.oy + tr.dy * tail;
          P[o + 2] = tr.oz + tr.dz * tail;
          P[o + 3] = tr.ox + tr.dx * head;
          P[o + 4] = tr.oy + tr.dy * head;
          P[o + 5] = tr.oz + tr.dz * head;
          // faint tail, hot head; fades out after arriving
          const fade = tr.t > tEnd ? Math.max(0, 1 - (tr.t - tEnd) / 0.045) : 1;
          const g = tr.gain * fade;
          C[o] = TRACER.head[0] * 0.08 * g;
          C[o + 1] = TRACER.head[1] * 0.08 * g;
          C[o + 2] = TRACER.head[2] * 0.08 * g;
          C[o + 3] = TRACER.head[0] * g;
          C[o + 4] = TRACER.head[1] * g;
          C[o + 5] = TRACER.head[2] * g;
          continue;
        }
      }
      for (let k = 0; k < 6; k++) {
        P[o + k] = 0;
        C[o + k] = 0;
      }
    }
    const ps = this.tracerGeo.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute;
    const cs = this.tracerGeo.getAttribute('instanceColorStart') as THREE.InterleavedBufferAttribute;
    (ps.data.array as Float32Array).set(P);
    ps.data.needsUpdate = true;
    (cs.data.array as Float32Array).set(C);
    cs.data.needsUpdate = true;
    for (const f of this.flashes) {
      if (f.t <= 0) continue;
      f.t -= dt;
      if (f.t <= 0) f.sprite.visible = false;
    }
    for (const l of this.flashLights) {
      if (l.t <= 0) {
        l.light.intensity = 0;
        continue;
      }
      l.t -= dt;
      l.light.intensity *= Math.exp(-dt * 30);
      if (l.t <= 0) l.light.intensity = 0;
    }
  }

  clear(): void {
    this.holes.count = 0;
    this.holeNext = 0;
  }
}
