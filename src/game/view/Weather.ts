import * as THREE from 'three';
import type { MapDef } from '@/game/world/mapTypes';
import { radialTexture } from '@/assets/textures/canvasTextures';

// Outdoor sky and weather: storm sky dome, moonlight over the open ground (a far soft-edged
// spotlight; under the canopy the moon only reaches the baked probes), rain streaks that live in a
// box around the camera and stop under roofs (the wet mask's roof heights), lightning that flashes
// the sky and the scene, and fireflies over the jungle floor.

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uMoonDir;
uniform float uFlash;
uniform float uTime;
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * n2(p); p *= 2.03; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec2 uv = d.xz / max(0.12, d.y) * 0.6 + vec2(uTime * 0.004, uTime * 0.002);
  float clouds = fbm(uv * 1.3);
  vec3 col = mix(vec3(0.032, 0.036, 0.045), vec3(0.012, 0.014, 0.02), pow(h, 0.7));
  // heavy rain clouds, lit faintly from behind by the moon
  vec3 m = normalize(-uMoonDir);
  float md = max(dot(d, m), 0.0);
  col += vec3(0.06, 0.07, 0.09) * pow(md, 6.0) * clouds;
  col *= 0.7 + 0.6 * clouds;
  // lightning lights the clouds from inside
  col += vec3(0.55, 0.6, 0.75) * uFlash * (0.25 + clouds) * (0.4 + h);
  gl_FragColor = vec4(col, 1.0);
}`;

const RAIN_VERT = /* glsl */ `
attribute vec4 seed;
uniform float uTime;
uniform vec3 uOrigin;
uniform vec3 uBox;
uniform vec2 uWind;
uniform sampler2D uRoof;
uniform vec4 uRoofBounds;
varying float vAlpha;
void main() {
  // each streak falls through a box around the camera and wraps; position.y is 0 (top) or 1 (tail)
  vec3 speed = vec3(uWind.x, -9.0 - seed.w * 3.0, uWind.y);
  vec3 p = seed.xyz * uBox + speed * uTime;
  p = mod(p, uBox) - uBox * 0.5 + uOrigin;
  p -= speed * 0.035 * position.y;
  // under a roof: hide the streak
  vec2 ruv = (p.xz - uRoofBounds.xy) * uRoofBounds.zw;
  float roof = texture2D(uRoof, ruv).g * 16.0;
  float covered = step(0.01, roof) * step(p.y, roof);
  vAlpha = (1.0 - covered) * (0.35 + 0.65 * seed.w) * (1.0 - position.y * 0.85);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vAlpha *= smoothstep(0.3, 1.5, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const RAIN_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uFlash;
varying float vAlpha;
void main() {
  if (vAlpha < 0.01) discard;
  gl_FragColor = vec4(uColor * (1.0 + uFlash * 6.0), vAlpha);
}`;

const FLY_VERT = /* glsl */ `
attribute float seed;
uniform float uTime;
uniform float uScale;
varying float vGlow;
void main() {
  vec3 p = position;
  float t = uTime * (0.2 + seed * 0.3);
  p.x += sin(t * 1.3 + seed * 50.0) * 0.8;
  p.z += cos(t * 1.1 + seed * 31.0) * 0.8;
  p.y += sin(t * 2.1 + seed * 17.0) * 0.35;
  // slow blinking
  float blink = sin(uTime * (0.8 + seed) + seed * 40.0);
  vGlow = smoothstep(0.55, 1.0, blink);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uScale * (2.0 + seed * 2.5) * 6.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FLY_FRAG = /* glsl */ `
uniform sampler2D uMap;
varying float vGlow;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a;
  gl_FragColor = vec4(vec3(0.75, 1.0, 0.35) * a * vGlow * 2.2, 1.0);
}`;

export interface WeatherOpts {
  shadows: boolean;
  shadowSize: number;
  particleScale: number;
  /**
   * Re-render the moon's shadow map every frame (players cast moon shadows). Off, it renders
   * once, on the first frame after the map is built (before any player is in the scene).
   */
  dynamicShadow: boolean;
}

export class Weather {
  readonly group = new THREE.Group();
  readonly moon: THREE.SpotLight;
  /** A cold flash light for lightning (intensity 0 most of the time). */
  readonly flash: THREE.DirectionalLight;
  private skyMat: THREE.ShaderMaterial;
  private rainMat: THREE.ShaderMaterial | null = null;
  private flyMat: THREE.ShaderMaterial | null = null;
  private nextBolt = 8;
  private boltT = -1;
  /** In a match, bolts follow a schedule from the match seed and the shared sim clock. */
  private schedSeed: number | null = null;
  private schedK = 0;
  private schedT = 0;
  /** Lightning brightness right now (0..1), for the HUD/audio and other effects. */
  flashLevel = 0;

  constructor(private map: MapDef, opts: WeatherOpts, roofMask: { texture: THREE.Texture; bounds: THREE.Vector4 }) {
    const md = new THREE.Vector3(...map.moonDir).normalize();
    const w = map.weather ?? { rain: 0, mist: 0, lightning: false, wind: 0 };
    // ---- sky
    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: { uMoonDir: { value: md }, uFlash: { value: 0 }, uTime: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.skyMat.userData.textureExempt = 'sky dome: procedural storm sky shader';
    const sky = new THREE.Mesh(new THREE.SphereGeometry(160, 32, 16), this.skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    sky.userData.shadowExempt = 'sky dome: infinitely far background';
    this.group.add(sky);

    // ---- moonlight over the open base: a far spotlight with a soft edge, so the jungle under the
    // canopy stays dark (its faint moonlight is baked into the probes with canopy shade)
    const open = map.openSky ?? { min: map.bounds.min, max: map.bounds.max };
    const center = new THREE.Vector3((open.min[0] + open.max[0]) / 2, 0, (open.min[2] + open.max[2]) / 2);
    const radius = Math.hypot(open.max[0] - open.min[0], open.max[2] - open.min[2]) / 2;
    const dist = 120;
    const moon = new THREE.SpotLight(0xa9b8dc, 0, dist + radius * 3, Math.atan((radius * 1.15) / dist), 0.45, 0);
    moon.position.copy(center).addScaledVector(md, -dist);
    moon.target.position.copy(center);
    moon.intensity = 2.6;
    moon.castShadow = opts.shadows;
    moon.shadow.mapSize.set(opts.shadowSize, opts.shadowSize);
    moon.shadow.camera.near = dist - 30;
    moon.shadow.camera.far = dist + 40;
    moon.shadow.bias = -0.0004;
    moon.shadow.normalBias = 0.05;
    if (!opts.dynamicShadow) {
      moon.shadow.autoUpdate = false;
      moon.shadow.needsUpdate = true;
    }
    this.group.add(moon, moon.target);
    this.moon = moon;

    this.flash = new THREE.DirectionalLight(0xc8d6ff, 0);
    this.flash.position.copy(center).addScaledVector(new THREE.Vector3(-0.3, -1, 0.2).normalize(), -60);
    this.flash.target.position.copy(center);
    this.group.add(this.flash, this.flash.target);

    // ---- rain
    if (w.rain > 0) {
      const n = Math.floor(4200 * w.rain * Math.max(0.35, opts.particleScale));
      const pos = new Float32Array(n * 6);
      const seed = new Float32Array(n * 8);
      for (let i = 0; i < n; i++) {
        pos[i * 6 + 4] = 1; // tail vertex: position.y = 1
        const s = [Math.random(), Math.random(), Math.random(), Math.random()];
        seed.set(s, i * 8);
        seed.set(s, i * 8 + 4);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
      this.rainMat = new THREE.ShaderMaterial({
        vertexShader: RAIN_VERT,
        fragmentShader: RAIN_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uOrigin: { value: new THREE.Vector3() },
          uBox: { value: new THREE.Vector3(26, 14, 26) },
          uWind: { value: new THREE.Vector2(1.4 * w.wind, 0.6 * w.wind) },
          uColor: { value: new THREE.Color(0.1, 0.115, 0.135) },
          uFlash: { value: 0 },
          uRoof: { value: roofMask.texture },
          uRoofBounds: { value: roofMask.bounds },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.rainMat.userData.textureExempt = 'particles: rain streaks';
      const lines = new THREE.LineSegments(g, this.rainMat);
      lines.frustumCulled = false;
      lines.renderOrder = 7;
      lines.userData.shadowExempt = 'particles: rain streaks';
      this.group.add(lines);
    }

    // ---- fireflies drifting low over the jungle (outside the base)
    const flies = Math.floor(260 * opts.particleScale);
    if (flies > 0) {
      const [x0, , z0] = map.bounds.min;
      const [x1, , z1] = map.bounds.max;
      const inOpen = (x: number, z: number) => !!map.openSky && x > open.min[0] && x < open.max[0] && z > open.min[2] && z < open.max[2];
      const pos = new Float32Array(flies * 3);
      const seed = new Float32Array(flies);
      for (let i = 0; i < flies; i++) {
        let x = 0;
        let z = 0;
        for (let k = 0; k < 20; k++) {
          x = x0 + 1.5 + Math.random() * (x1 - x0 - 3);
          z = z0 + 1.5 + Math.random() * (z1 - z0 - 3);
          if (!inOpen(x, z)) break;
        }
        pos[i * 3] = x;
        pos[i * 3 + 1] = 0.6 + Math.random() * 1.8;
        pos[i * 3 + 2] = z;
        seed[i] = Math.random();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
      this.flyMat = new THREE.ShaderMaterial({
        vertexShader: FLY_VERT,
        fragmentShader: FLY_FRAG,
        uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uMap: { value: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 64) } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.flyMat.userData.textureExempt = 'particles: fireflies';
      const pts = new THREE.Points(g, this.flyMat);
      pts.frustumCulled = false;
      pts.renderOrder = 6;
      pts.userData.shadowExempt = 'particles: fireflies';
      this.group.add(pts);
    }
  }

  setPixelScale(heightPx: number): void {
    if (this.flyMat) this.flyMat.uniforms.uScale.value = heightPx / 720;
  }

  /** Puts fireflies on the ground (called once the terrain is known). */
  settleOnGround(height: (x: number, z: number) => number): void {
    const pts = this.group.children.find((c) => (c as THREE.Points).isPoints) as THREE.Points | undefined;
    if (!pts) return;
    const p = pts.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setY(i, height(p.getX(i), p.getZ(i)) + 0.5 + (i % 7) * 0.22);
    p.needsUpdate = true;
  }

  /** Seeds the lightning schedule so every player in a match sees the same bolts. */
  setLightningSeed(seed: number): void {
    this.schedSeed = seed >>> 0;
    this.schedK = 0;
    this.schedT = 6 + hash01(this.schedSeed, 0) * 10;
  }

  /** `simTime`: seconds on the match's shared clock (bolts then follow the seeded schedule). */
  update(t: number, dt: number, camera: THREE.Camera, simTime?: number): void {
    const w = this.map.weather;
    // lightning: a double flash now and then
    let b = -1;
    if (w?.lightning && this.schedSeed !== null && simTime !== undefined) {
      for (;;) {
        const next = this.schedT + 14 + hash01(this.schedSeed, this.schedK + 1) * 26;
        if (next > simTime) break;
        this.schedT = next;
        this.schedK++;
      }
      b = simTime - this.schedT;
    } else if (w?.lightning) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.boltT = 0;
        this.nextBolt = 14 + Math.random() * 26;
      }
      if (this.boltT >= 0) {
        this.boltT += dt;
        b = this.boltT;
        if (b > 0.6) this.boltT = -1;
      }
    }
    const f = b >= 0 && b <= 0.6 ? Math.max(0, 1 - b / 0.12) + (b > 0.18 ? Math.max(0, 0.8 - (b - 0.18) / 0.25) : 0) : 0;
    this.flashLevel = f;
    this.flash.intensity = f * 2.4;
    this.skyMat.uniforms.uFlash.value = f;
    this.skyMat.uniforms.uTime.value = t;
    if (this.rainMat) {
      this.rainMat.uniforms.uTime.value = t;
      this.rainMat.uniforms.uFlash.value = f;
      (this.rainMat.uniforms.uOrigin.value as THREE.Vector3).copy(camera.position);
    }
    if (this.flyMat) this.flyMat.uniforms.uTime.value = t;
  }
}

/** Integer hash of (seed, k) to [0, 1): the same on every machine. */
function hash01(seed: number, k: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

