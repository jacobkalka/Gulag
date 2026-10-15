import * as THREE from 'three';
import type { MapDef } from '@/game/world/mapTypes';
import { radialTexture } from '@/assets/textures/canvasTextures';

// Night sky seen through the collapsed roof, moonlight (shadowed directional light),
// analytic volumetric light shafts under each sky opening, drifting dust motes, and fog.

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
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 zenith = vec3(0.012, 0.018, 0.04);
  vec3 horizon = vec3(0.05, 0.06, 0.085);
  vec3 col = mix(horizon, zenith, pow(h, 0.6));
  // stars
  vec3 sp = floor(d * 380.0);
  float st = hash(sp);
  col += vec3(0.9, 0.95, 1.0) * step(0.9975, st) * (0.4 + 0.6 * hash(sp + 3.0)) * h;
  // moon glow
  vec3 m = normalize(-uMoonDir);
  float md = max(dot(d, m), 0.0);
  col += vec3(0.55, 0.62, 0.8) * pow(md, 600.0) * 30.0;
  col += vec3(0.15, 0.2, 0.32) * pow(md, 12.0) * 0.6;
  // thin clouds
  float c = sin(d.x * 9.0 + d.z * 4.0) * sin(d.z * 11.0 - d.x * 3.0);
  col += vec3(0.03, 0.035, 0.05) * smoothstep(0.2, 0.9, c) * h;
  gl_FragColor = vec4(col, 1.0);
}`;

// Volumetric shaft: a sheared box (roof opening extruded along the moon direction).
// The fragment shader intersects the view ray with the box analytically and
// accumulates in-scattering proportional to the traversed thickness.
const SHAFT_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SHAFT_FRAG = /* glsl */ `
varying vec3 vWorld;
uniform vec3 uK;        // moonDir / -moonDir.y  (so uK.y == -1)
uniform float uTop;
uniform float uBottom;
uniform vec2 uMinXZ;
uniform vec2 uMaxXZ;
uniform vec3 uColor;
uniform float uDensity;
uniform float uTime;

vec3 toLocal(vec3 p) { float dy = uTop - p.y; return vec3(p.x - uK.x * dy, p.y, p.z - uK.z * dy); }
vec3 dirLocal(vec3 d) { return vec3(d.x + uK.x * d.y, d.y, d.z + uK.z * d.y); }

float n3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float vnoise3(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = n3(i), b = n3(i + vec3(1,0,0)), c = n3(i + vec3(0,1,0)), d = n3(i + vec3(1,1,0));
  float e = n3(i + vec3(0,0,1)), g = n3(i + vec3(1,0,1)), h = n3(i + vec3(0,1,1)), k = n3(i + vec3(1,1,1));
  return mix(mix(mix(a,b,f.x), mix(c,d,f.x), f.y), mix(mix(e,g,f.x), mix(h,k,f.x), f.y), f.z);
}

void main() {
  vec3 ro = toLocal(cameraPosition);
  vec3 rd = dirLocal(normalize(vWorld - cameraPosition));
  vec3 bmin = vec3(uMinXZ.x, uBottom, uMinXZ.y);
  vec3 bmax = vec3(uMaxXZ.x, uTop, uMaxXZ.y);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  float viewLen = length(vWorld - cameraPosition);
  tf = min(tf, viewLen + 0.001);
  if (tf <= tn) discard;
  float thick = tf - tn;
  vec3 mid = ro + rd * (tn + tf) * 0.5;
  vec2 size = uMaxXZ - uMinXZ;
  vec2 rel = (mid.xz - uMinXZ) / size;
  float edge = smoothstep(0.0, 0.22, rel.x) * smoothstep(0.0, 0.22, 1.0 - rel.x) * smoothstep(0.0, 0.22, rel.y) * smoothstep(0.0, 0.22, 1.0 - rel.y);
  float hgt = clamp((mid.y - uBottom) / (uTop - uBottom), 0.0, 1.0);
  float dust = 0.65 + 0.7 * vnoise3(mid * 1.7 + vec3(0.0, -uTime * 0.12, uTime * 0.05));
  float a = (1.0 - exp(-thick * uDensity)) * edge * dust * (0.35 + 0.65 * hgt);
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

export class Atmosphere {
  readonly group = new THREE.Group();
  readonly moon: THREE.SpotLight;
  readonly hemi: THREE.HemisphereLight;
  private shafts: THREE.ShaderMaterial[] = [];
  private dust: THREE.Points | null = null;
  private dustMat: THREE.ShaderMaterial | null = null;

  constructor(map: MapDef, opts: { shadows: boolean; shadowSize: number; lightShafts: boolean; particleScale: number }) {
    const md = new THREE.Vector3(...map.moonDir).normalize();
    // Sky dome
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(90, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        uniforms: { uMoonDir: { value: md } },
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    (sky.material as THREE.Material).userData.textureExempt = 'sky dome: procedural night sky shader';
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    sky.userData.shadowExempt = 'sky dome: infinitely far background';
    this.group.add(sky);

    // Moonlight: a distant, narrow shadowed spotlight aimed through each sky opening.
    // Light can only enter through the holes, and the shadow map resolution is spent
    // exactly where the shaft lands (a map-wide directional light would leak everywhere).
    const holes = map.skyHoles.length ? map.skyHoles : [{ min: [-1, 6, -1] as [number, number, number], max: [1, 6, 1] as [number, number, number] }];
    const hole = holes[0];
    const hc = new THREE.Vector3((hole.min[0] + hole.max[0]) / 2, hole.min[1], (hole.min[2] + hole.max[2]) / 2);
    const holeR = Math.hypot(hole.max[0] - hole.min[0], hole.max[2] - hole.min[2]) / 2;
    const dist = 45;
    const moon = new THREE.SpotLight(0xc4cee4, 0, dist + 20, Math.atan((holeR * 1.25) / dist), 0.15, 0);
    moon.position.copy(hc).addScaledVector(md, -dist);
    moon.target.position.copy(hc).addScaledVector(md, hc.y / -md.y);
    moon.intensity = 2.6;
    moon.castShadow = opts.shadows;
    moon.shadow.mapSize.set(opts.shadowSize, opts.shadowSize);
    moon.shadow.camera.near = dist - 8;
    moon.shadow.camera.far = dist + 12;
    moon.shadow.bias = -0.0002;
    moon.shadow.normalBias = 0.03;
    this.group.add(moon);
    this.group.add(moon.target);
    this.moon = moon;

    // no flat sky fill indoors: ambient comes from the baked probes
    this.hemi = new THREE.HemisphereLight(0x5a6c8c, 0x2a2420, 0.0);
    this.group.add(this.hemi);

    if (opts.lightShafts) {
      for (const hole of map.skyHoles) {
        const k = new THREE.Vector3(md.x / -md.y, -1, md.z / -md.y);
        const top = hole.min[1];
        const bottom = 0.03;
        const mat = new THREE.ShaderMaterial({
          vertexShader: SHAFT_VERT,
          fragmentShader: SHAFT_FRAG,
          uniforms: {
            uK: { value: k },
            uTop: { value: top },
            uBottom: { value: bottom },
            uMinXZ: { value: new THREE.Vector2(hole.min[0], hole.min[2]) },
            uMaxXZ: { value: new THREE.Vector2(hole.max[0], hole.max[2]) },
            uColor: { value: new THREE.Color(0x7d95c8).multiplyScalar(0.5) },
            uDensity: { value: 0.26 },
            uTime: { value: 0 },
          },
          blending: THREE.AdditiveBlending,
          transparent: true,
          depthWrite: false,
          side: THREE.BackSide,
        });
        // Geometry: the sheared box hull (8 corners).
        const corners: THREE.Vector3[] = [];
        for (const y of [top, bottom]) {
          const dy = top - y;
          for (const [x, z] of [
            [hole.min[0], hole.min[2]],
            [hole.max[0], hole.min[2]],
            [hole.max[0], hole.max[2]],
            [hole.min[0], hole.max[2]],
          ]) {
            corners.push(new THREE.Vector3(x + k.x * dy, y, z + k.z * dy));
          }
        }
        const g = new THREE.BoxGeometry(1, 1, 1);
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i) > 0 ? 1 : 0;
          const y = pos.getY(i) > 0 ? 0 : 1; // top ring first
          const z = pos.getZ(i) > 0 ? 1 : 0;
          const idx = y * 4 + (z === 0 ? (x === 0 ? 0 : 1) : x === 0 ? 3 : 2);
          pos.setXYZ(i, corners[idx].x, corners[idx].y, corners[idx].z);
        }
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, mat);
        mesh.renderOrder = 5;
        mesh.frustumCulled = false;
        mesh.userData.shadowExempt = 'light effect: volumetric moon shaft';
        mat.userData.textureExempt = 'light effect: volumetric moon shaft shader';
        this.group.add(mesh);
        this.shafts.push(mat);
      }
    }

    // Dust motes: drifting points that glow when inside a moon shaft.
    const count = Math.floor(900 * opts.particleScale);
    if (count > 0) {
      const pos = new Float32Array(count * 3);
      const seed = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        // Concentrate around the shower room and the boiler hall.
        const inShowers = i % 3 !== 0;
        pos[i * 3] = inShowers ? (Math.random() - 0.5) * 16 : (Math.random() - 0.5) * 36;
        pos[i * 3 + 1] = Math.random() * 4.2;
        pos[i * 3 + 2] = inShowers ? (Math.random() - 0.5) * 11 : 7 + Math.random() * 9;
        seed[i] = Math.random();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
      const hole = map.skyHoles[0];
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uMap: { value: radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 64) },
          uK: { value: new THREE.Vector3(md.x / -md.y, -1, md.z / -md.y) },
          uTop: { value: hole ? hole.min[1] : 6 },
          uMinXZ: { value: new THREE.Vector2(hole ? hole.min[0] : 0, hole ? hole.min[2] : 0) },
          uMaxXZ: { value: new THREE.Vector2(hole ? hole.max[0] : 0, hole ? hole.max[2] : 0) },
          uScale: { value: 1 },
        },
        vertexShader: /* glsl */ `
          attribute float seed;
          uniform float uTime;
          uniform vec3 uK;
          uniform float uTop;
          uniform vec2 uMinXZ;
          uniform vec2 uMaxXZ;
          uniform float uScale;
          varying float vGlow;
          void main() {
            vec3 p = position;
            float t = uTime * (0.05 + seed * 0.08);
            p.x += sin(t * 2.0 + seed * 40.0) * 0.4;
            p.z += cos(t * 1.7 + seed * 23.0) * 0.4;
            p.y = mod(p.y + sin(t + seed * 9.0) * 0.3 + uTime * 0.02 * (seed - 0.5), 4.2);
            float dy = uTop - p.y;
            vec2 s = vec2(p.x - uK.x * dy, p.z - uK.z * dy);
            float inShaft = step(uMinXZ.x, s.x) * step(s.x, uMaxXZ.x) * step(uMinXZ.y, s.y) * step(s.y, uMaxXZ.y);
            vGlow = 0.015 + inShaft * 0.7;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_PointSize = uScale * (0.6 + seed) * 6.0 / -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D uMap;
          varying float vGlow;
          void main() {
            float a = texture2D(uMap, gl_PointCoord).a;
            gl_FragColor = vec4(vec3(0.75, 0.8, 0.95) * a * vGlow, 1.0);
          }`,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      });
      mat.userData.textureExempt = 'particles: dust motes';
      const pts = new THREE.Points(g, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 6;
      this.group.add(pts);
      this.dust = pts;
      this.dustMat = mat;
    }
  }

  setPixelScale(heightPx: number): void {
    if (this.dustMat) this.dustMat.uniforms.uScale.value = heightPx / 720;
  }

  update(t: number): void {
    for (const s of this.shafts) s.uniforms.uTime.value = t;
    if (this.dustMat) this.dustMat.uniforms.uTime.value = t;
    void this.dust;
  }
}
