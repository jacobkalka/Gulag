import * as THREE from 'three';
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

interface Tracer {
  mesh: THREE.Mesh;
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  len: number;
  t: number;
  active: boolean;
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
    const tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    tracerGeo.rotateX(Math.PI / 2);
    // warm and only mildly HDR: a hint of bloom without turning into white sticks
    const tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.7, 0.36).multiplyScalar(2.4), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.8 });
    for (let i = 0; i < 48; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 9;
      this.group.add(mesh);
      this.tracers.push({ mesh, ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0, len: 0, t: 0, active: false });
    }
    this.flashMat = new THREE.SpriteMaterial({
      map: radialTexture('rgba(255,236,190,1)', 'rgba(255,120,30,0)', 64),
      color: new THREE.Color(1, 0.8, 0.5).multiplyScalar(6),
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

  setPixelScale(heightPx: number): void {
    this.add.setScale(heightPx * 0.9);
    this.alpha.setScale(heightPx * 0.9);
  }

  tracer(ox: number, oy: number, oz: number, ex: number, ey: number, ez: number, width = 0.007): void {
    const len = Math.hypot(ex - ox, ey - oy, ez - oz);
    if (len < 1.5) return;
    const tr = this.tracers.find((t) => !t.active) ?? this.tracers[0];
    tr.active = true;
    tr.ox = ox;
    tr.oy = oy;
    tr.oz = oz;
    tr.dx = (ex - ox) / len;
    tr.dy = (ey - oy) / len;
    tr.dz = (ez - oz) / len;
    tr.len = len;
    tr.t = 0;
    tr.mesh.visible = true;
    tr.mesh.scale.set(width, width, 1);
  }

  muzzleFlash(x: number, y: number, z: number, size = 0.35, light = true): void {
    const f = this.flashes.find((q) => q.t <= 0) ?? this.flashes[0];
    f.t = 0.05;
    f.sprite.position.set(x, y, z);
    f.sprite.scale.setScalar(size * (0.8 + Math.random() * 0.4));
    f.sprite.material.rotation = Math.random() * Math.PI;
    f.sprite.visible = true;
    if (light) {
      const l = this.flashLights.reduce((a, b) => (a.t < b.t ? a : b));
      l.t = 0.06;
      l.light.position.set(x, y, z);
      l.light.intensity = 30;
    }
    for (let i = 0; i < 4 * this.scale; i++) {
      this.alpha.emit(x, y, z, (Math.random() - 0.5) * 0.6, Math.random() * 0.5, (Math.random() - 0.5) * 0.6, 0.6 + Math.random() * 0.4, 0.12, 0.6, 0.18, 0.17, 0.16, 0.18, 2.0, -0.2);
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
      const dust: [number, number, number] =
        surface === 'wood' ? [0.42, 0.32, 0.2] : surface === 'tile' ? [0.82, 0.8, 0.76] : surface === 'metal' ? [0.3, 0.3, 0.3] : [0.52, 0.5, 0.47];
      for (let i = 0; i < n(7); i++) {
        const sp = 0.6 + Math.random() * 1.6;
        this.alpha.emit(x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, (nx + rnd() * 0.8) * sp, (ny + rnd() * 0.8) * sp + 0.2, (nz + rnd() * 0.8) * sp, 0.6 + Math.random() * 0.6, 0.12, 0.55, dust[0], dust[1], dust[2], 0.45, 3.5, 0.6);
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
    for (const tr of this.tracers) {
      if (!tr.active) continue;
      tr.t += dt;
      const head = Math.min(tr.len, tr.t * 420);
      const tail = Math.max(0, head - 2.6);
      if (tail >= tr.len - 0.01) {
        tr.active = false;
        tr.mesh.visible = false;
        continue;
      }
      const mid = (head + tail) / 2;
      tr.mesh.position.set(tr.ox + tr.dx * mid, tr.oy + tr.dy * mid, tr.oz + tr.dz * mid);
      tr.mesh.scale.z = Math.max(0.01, head - tail);
      tr.mesh.lookAt(tr.mesh.position.x + tr.dx, tr.mesh.position.y + tr.dy, tr.mesh.position.z + tr.dz);
    }
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
