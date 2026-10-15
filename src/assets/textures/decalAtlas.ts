import * as THREE from 'three';
import { NOISE_GLSL } from './noise.glsl';

// GPU-generated decal atlas: 4x4 cells of grime, rust and water streaks, stains, cracks, moss,
// soot, mud, oil, peeling paint, scuffs, wet patches and splash grime along wall bases. Each cell has albedo with
// alpha, a normal map (from a height field) and roughness/AO, so decals sit in the surface instead
// of reading as flat stickers.

export const DECAL_CELLS = {
  dirt: 0,
  grimeStreak: 1,
  rustStreak: 2,
  waterStain: 3,
  crack: 4,
  moss: 5,
  soot: 6,
  peel: 7,
  mud: 8,
  oil: 9,
  scuff: 10,
  wet: 11,
  baseGrime: 12,
  mold: 13,
  drip: 14,
  leak: 15,
} as const;
export type DecalCell = keyof typeof DECAL_CELLS;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DECALS = /* glsl */ `
float blob(vec2 uv, float seed, float rough) {
  vec2 p = uv - 0.5;
  float n = fbm(uv * 4.0 + seed, vec2(512.0), 5);
  float r = length(p) * 2.0 + n * rough;
  return 1.0 - smoothstep(0.55, 0.95, r);
}
float speckle(vec2 uv, float freq, float th) { return step(th, vnoise(uv * freq, vec2(4096.0))); }

void decal(int cell, vec2 uv, out vec3 col, out float a, out float h, out float r) {
  col = vec3(0.0); a = 0.0; h = 0.5; r = 0.9;
  float fine = vnoise(uv * 120.0, vec2(4096.0));
  if (cell == 0) { // dirt splat
    float b = blob(uv, 3.0, 0.9);
    float grain = fbm01(uv * 18.0, vec2(512.0), 4);
    a = b * (0.35 + 0.65 * grain);
    col = srgbHex(58.0, 48.0, 36.0) * (0.8 + 0.4 * grain);
    h = 0.5 + a * 0.08; r = 0.95;
  } else if (cell == 1) { // grime streaks running down from the top, uneven runs that fade out
    float x = uv.x + fbm(vec2(uv.y * 2.0, 5.0), vec2(512.0), 3) * 0.03;
    float wide = fbm01(vec2(x * 6.0, 0.5), vec2(512.0), 5);
    float thin = fbm01(vec2(x * 26.0, 2.5), vec2(512.0), 3);
    float len = mix(0.25, 1.0, fbm01(vec2(x * 4.0, 3.0), vec2(512.0), 3));
    float fall = 1.0 - smoothstep(len * 0.35, len, 1.0 - uv.y);
    float body = smoothstep(0.4, 0.7, wide) * (0.55 + 0.45 * smoothstep(0.3, 0.8, thin));
    float blot = fbm01(uv * vec2(5.0, 2.0) + 4.0, vec2(512.0), 4);
    a = body * fall * (0.45 + 0.55 * blot) * 0.8 * smoothstep(0.0, 0.06, 1.0 - uv.y + 0.02);
    col = mix(srgbHex(56.0, 50.0, 40.0), srgbHex(34.0, 32.0, 28.0), thin);
    h = 0.5 - a * 0.02; r = 0.8;
  } else if (cell == 2) { // rust streak under metal
    float x = (uv.x - 0.5) * 2.0;
    float spread = 0.25 + (1.0 - uv.y) * 0.75;
    float core = 1.0 - smoothstep(0.0, spread, abs(x + fbm(vec2(uv.y * 6.0, 1.7), vec2(512.0), 3) * 0.15));
    float drips = smoothstep(0.55, 0.8, fbm01(vec2(uv.x * 30.0, uv.y * 3.0), vec2(512.0), 4));
    a = core * (0.55 + 0.45 * drips) * smoothstep(0.0, 0.25, uv.y) * (0.7 + 0.3 * fine);
    col = mix(srgbHex(120.0, 52.0, 18.0), srgbHex(70.0, 32.0, 14.0), drips);
    h = 0.5 + a * 0.02; r = 0.8;
  } else if (cell == 3) { // water stain: faint fill with a few irregular tide lines
    vec2 p = uv - 0.5;
    float n = fbm(uv * 4.0 + 11.0, vec2(512.0), 5);
    float d = length(p * vec2(1.0, 1.15)) * 2.0 + n * 0.45;
    float rings = 0.0;
    for (int i = 0; i < 3; i++) {
      float rr = 0.5 + float(i) * 0.17 + fbm(uv * 6.0 + float(i) * 3.1, vec2(512.0), 3) * 0.05;
      rings = max(rings, (1.0 - smoothstep(0.0, 0.03, abs(d - rr))) * (1.0 - float(i) * 0.25));
    }
    float fill = (1.0 - smoothstep(0.3, 0.95, d)) * 0.16;
    a = max(rings * 0.4 * step(d, 0.98), fill) * (0.8 + 0.2 * fine);
    col = mix(srgbHex(112.0, 90.0, 54.0), srgbHex(78.0, 60.0, 36.0), rings);
    h = 0.5; r = mix(0.9, 0.6, rings);
  } else if (cell == 4) { // crack
    vec2 w = uv + vec2(fbm(uv * 3.0, vec2(512.0), 3), fbm(uv * 3.0 + 5.0, vec2(512.0), 3)) * 0.08;
    vec2 e = voronoiEdge(w * 4.0, vec2(512.0));
    float line = 1.0 - smoothstep(0.0, 0.02 + 0.02 * fbm01(uv * 9.0, vec2(512.0), 3), e.x);
    float mask = blob(uv, 7.0, 0.6);
    a = line * mask;
    col = srgbHex(20.0, 19.0, 18.0);
    h = 0.5 - a * 0.45; r = 0.95;
  } else if (cell == 5) { // moss
    float b = blob(uv, 13.0, 1.1);
    float clump = fbm01(uv * 25.0, vec2(512.0), 5);
    a = b * smoothstep(0.35, 0.7, clump);
    col = mix(srgbHex(46.0, 62.0, 26.0), srgbHex(78.0, 92.0, 38.0), clump);
    h = 0.5 + a * 0.25 * clump; r = 1.0;
  } else if (cell == 6) { // soot / burn mark
    float b = blob(uv, 21.0, 0.7);
    float n = fbm01(uv * 12.0, vec2(512.0), 5);
    a = b * (0.5 + 0.5 * n);
    col = mix(srgbHex(12.0, 11.0, 10.0), srgbHex(40.0, 30.0, 22.0), smoothstep(0.6, 1.0, length(uv - 0.5) * 2.0));
    h = 0.5; r = 0.98;
  } else if (cell == 7) { // peeling paint: flaked-off patches show the bare wall, lifted edges catch light
    vec2 w = uv * 7.0 + vec2(fbm(uv * 3.0, vec2(512.0), 3), fbm(uv * 3.0 + 9.0, vec2(512.0), 3)) * 0.35;
    vec3 v = voronoi(w, vec2(512.0));
    float region = blob(uv, 31.0, 0.8);
    float pick = step(0.42, v.z) * step(0.25, region);
    float border = v.y - v.x;
    float bare = pick * smoothstep(0.03, 0.08, border);
    float lift = pick * (1.0 - smoothstep(0.0, 0.05, border));
    a = max(bare * 0.95, lift * 0.9) * smoothstep(0.1, 0.4, region);
    col = mix(srgbHex(178.0, 172.0, 154.0), srgbHex(128.0, 124.0, 116.0), bare);
    h = 0.5 - bare * 0.1 + lift * 0.25; r = mix(0.6, 0.93, bare);
  } else if (cell == 8) { // mud splatter with droplets
    float b = blob(uv, 41.0, 1.2);
    float drops = speckle(uv, 40.0, 0.86) * (1.0 - smoothstep(0.2, 0.5, length(uv - 0.5)));
    a = max(b, drops) * (0.75 + 0.25 * fine);
    col = srgbHex(54.0, 40.0, 26.0);
    h = 0.5 + a * 0.15; r = 0.55;
  } else if (cell == 9) { // oil stain: soaked-in, darker toward the middle, faintly glossy
    float b = blob(uv, 51.0, 0.8);
    float core = blob(uv * 1.3 - 0.15, 52.0, 0.6);
    a = b * (0.35 + 0.3 * core);
    col = srgbHex(22.0, 18.0, 13.0);
    h = 0.5; r = mix(0.5, 0.25, core);
  } else if (cell == 10) { // scuffs / boot smudges
    float s = sat(scratches(uv, 8.0, 0.4, 25.0, 61.0) + scratches(uv, 6.0, -0.3, 18.0, 62.0));
    float m = blob(uv, 61.0, 0.5);
    a = s * m * 0.8;
    col = srgbHex(30.0, 28.0, 26.0);
    h = 0.5 - a * 0.02; r = 0.6;
  } else if (cell == 11) { // wet patch: water darkens the surface and makes it glossy
    float b = blob(uv, 71.0, 1.0);
    a = b * 0.42;
    col = srgbHex(6.0, 6.0, 6.0);
    h = 0.5; r = 0.1;
  } else if (cell == 12) { // splash grime along a wall base: dense at the floor line, ragged top edge
    float edge = 0.35 + fbm(vec2(uv.x * 5.0, 1.0), vec2(512.0), 5) * 0.25;
    float body = 1.0 - smoothstep(edge * 0.4, edge, uv.y);
    float splash = speckle(uv, 60.0, 0.8) * (1.0 - smoothstep(edge, edge + 0.25, uv.y)) * step(edge * 0.6, uv.y);
    float grain = fbm01(uv * vec2(7.0, 5.0), vec2(512.0), 4);
    float ends = smoothstep(0.0, 0.2, uv.x) * smoothstep(0.0, 0.2, 1.0 - uv.x);
    a = max(body * (0.5 + 0.5 * grain), splash * 0.7) * ends * 0.85;
    col = mix(srgbHex(60.0, 52.0, 40.0), srgbHex(32.0, 28.0, 22.0), body * grain);
    h = 0.5 + a * 0.04; r = 0.92;
  } else if (cell == 13) { // mold spots
    float b = blob(uv, 91.0, 1.0);
    float spots = smoothstep(0.62, 0.8, fbm01(uv * 30.0, vec2(512.0), 4));
    a = b * spots;
    col = mix(srgbHex(30.0, 36.0, 26.0), srgbHex(14.0, 16.0, 12.0), spots);
    h = 0.5 + a * 0.05; r = 0.95;
  } else if (cell == 14) { // a few drip lines (condensation, leaks) that thin out as they run
    a = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float cx = 0.3 + fi * 0.2 + (h12(vec2(fi, 141.0)) - 0.5) * 0.12;
      float len = 0.45 + h12(vec2(fi, 142.0)) * 0.5;
      float x = abs(uv.x - cx - fbm(vec2(uv.y * 3.0, 7.0 + fi), vec2(512.0), 2) * 0.04);
      float run = 1.0 - smoothstep(len * 0.7, len, 1.0 - uv.y);
      float w = 0.008 + 0.012 * (1.0 - uv.y);
      a = max(a, (1.0 - smoothstep(w * 0.5, w, x)) * run * (0.4 + 0.25 * h12(vec2(fi, 143.0))));
    }
    col = srgbHex(38.0, 36.0, 32.0);
    h = 0.5; r = 0.3;
  } else { // leak: wet streak spreading as it runs down, pale mineral crust along its edges
    float wob = fbm(vec2(uv.y * 4.0, 15.0), vec2(512.0), 3) * 0.08;
    float x = (uv.x - 0.5 - wob) * 2.0;
    float spread = 0.15 + (1.0 - uv.y) * 0.55 + fbm(vec2(uv.y * 9.0, 16.0), vec2(512.0), 2) * 0.08;
    float core = 1.0 - smoothstep(spread * 0.6, spread, abs(x));
    float crust = (1.0 - smoothstep(0.0, 0.07, abs(abs(x) - spread * 0.85))) * smoothstep(0.1, 0.4, 1.0 - uv.y);
    float fade = smoothstep(0.0, 0.25, uv.y) * smoothstep(0.0, 0.05, 1.0 - uv.y);
    a = max(core * 0.5, crust * 0.45) * fade * (0.75 + 0.25 * fine);
    col = mix(srgbHex(28.0, 28.0, 26.0), srgbHex(150.0, 146.0, 130.0), crust);
    h = 0.5 + crust * 0.06; r = mix(0.15, 0.85, crust);
  }
  // keep every decal inside its cell (no bleeding at lower mips)
  vec2 m = smoothstep(0.0, 0.06, uv) * smoothstep(0.0, 0.06, 1.0 - uv);
  a *= m.x * m.y;
}`;

const MAIN = /* glsl */ `
varying vec2 vUv;
uniform int uMode;
uniform float uSeed;
void main() {
  vec2 cf = floor(vUv * 4.0);
  vec2 uv = fract(vUv * 4.0);
  int cell = int(cf.y * 4.0 + cf.x);
  vec3 col; float a; float h; float r;
  decal(cell, uv, col, a, h, r);
  if (uMode == 0) gl_FragColor = vec4(col, a);
  else gl_FragColor = vec4(h, r, a, 1.0);
}`;

const NORMAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uData;
uniform float uSize;
float H(vec2 o) { vec4 d = texture2D(uData, vUv + o / uSize); return mix(0.5, d.r, d.b); }
void main() {
  float l = H(vec2(-1.0, 0.0)), r = H(vec2(1.0, 0.0)), b = H(vec2(0.0, -1.0)), t = H(vec2(0.0, 1.0));
  vec3 n = normalize(vec3((l - r) * 6.0, (b - t) * 6.0, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`;

const ORM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uData;
void main() {
  vec4 d = texture2D(uData, vUv);
  float ao = clamp(1.0 - max(0.0, 0.5 - d.r) * 1.2, 0.4, 1.0);
  gl_FragColor = vec4(ao, d.g, 0.0, 1.0);
}`;

export interface DecalAtlas {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  ormMap: THREE.Texture;
  dispose(): void;
}

export function buildDecalAtlas(gl: THREE.WebGLRenderer, size = 2048, anisotropy = 4): DecalAtlas {
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  scene.add(quad);
  const rt = (srgb: boolean, half = false, mips = true) =>
    new THREE.WebGLRenderTarget(size, size, {
      type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      depthBuffer: false,
      generateMipmaps: mips,
      minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      anisotropy,
    });
  const prev = gl.getRenderTarget();
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: 'precision highp float;\nuniform float uSeed;\n' + NOISE_GLSL + DECALS + MAIN.replace('uniform float uSeed;', ''),
    uniforms: { uMode: { value: 0 }, uSeed: { value: 7 } },
    depthTest: false,
    depthWrite: false,
  });
  const albedo = rt(true);
  const data = rt(false, true, false);
  quad.material = mat;
  gl.setRenderTarget(albedo);
  gl.render(scene, cam);
  mat.uniforms.uMode.value = 1;
  gl.setRenderTarget(data);
  gl.render(scene, cam);
  const normal = rt(false);
  const nm = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: NORMAL_FRAG, uniforms: { uData: { value: data.texture }, uSize: { value: size } }, depthTest: false, depthWrite: false });
  quad.material = nm;
  gl.setRenderTarget(normal);
  gl.render(scene, cam);
  const orm = rt(false);
  const om = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: ORM_FRAG, uniforms: { uData: { value: data.texture } }, depthTest: false, depthWrite: false });
  quad.material = om;
  gl.setRenderTarget(orm);
  gl.render(scene, cam);
  gl.setRenderTarget(prev);
  mat.dispose();
  nm.dispose();
  om.dispose();
  data.dispose();
  quad.geometry.dispose();
  return {
    map: albedo.texture,
    normalMap: normal.texture,
    ormMap: orm.texture,
    dispose: () => [albedo, normal, orm].forEach((t) => t.dispose()),
  };
}
