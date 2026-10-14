// Tileable (periodic) noise library for procedural texture generation.
// Every function takes a period `per` (in lattice cells) so textures wrap seamlessly
// when `p = uv * freq` and `per = vec2(freq)` with integer freq.

export const NOISE_GLSL = /* glsl */ `
#define PI 3.14159265359

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat3(vec3 x) { return clamp(x, 0.0, 1.0); }
// Author colors in sRGB, convert to linear for the render target.
vec3 srgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
vec3 srgbHex(float r, float g, float b) { return srgb(vec3(r, g, b) / 255.0); }

float h12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + uSeed * 0.0137);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 h22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + uSeed * 0.0213);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec3 h32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + uSeed * 0.0171);
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

vec2 wrapCell(vec2 i, vec2 per) { return mod(i, per); }

// Periodic value noise in [0,1]
float vnoise(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = h12(wrapCell(i, per));
  float b = h12(wrapCell(i + vec2(1.0, 0.0), per));
  float c = h12(wrapCell(i + vec2(0.0, 1.0), per));
  float d = h12(wrapCell(i + vec2(1.0, 1.0), per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Periodic gradient noise in roughly [-1,1]
float gnoise(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = h22(wrapCell(i, per)) * 2.0 - 1.0;
  vec2 gb = h22(wrapCell(i + vec2(1.0, 0.0), per)) * 2.0 - 1.0;
  vec2 gc = h22(wrapCell(i + vec2(0.0, 1.0), per)) * 2.0 - 1.0;
  vec2 gd = h22(wrapCell(i + vec2(1.0, 1.0), per)) * 2.0 - 1.0;
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  return 1.6 * mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}

// Fractal sum of gradient noise, roughly [-1,1]. Lacunarity is fixed at 2 to keep periodicity.
float fbm(vec2 p, vec2 per, int oct) {
  float s = 0.0;
  float a = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= oct) break;
    s += a * gnoise(p, per);
    norm += a;
    p *= 2.0;
    per *= 2.0;
    a *= 0.5;
  }
  return s / norm;
}
float fbm01(vec2 p, vec2 per, int oct) { return fbm(p, per, oct) * 0.5 + 0.5; }

// Value-noise fbm in [0,1]
float vfbm(vec2 p, vec2 per, int oct) {
  float s = 0.0;
  float a = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 10; i++) {
    if (i >= oct) break;
    s += a * vnoise(p, per);
    norm += a;
    p *= 2.0;
    per *= 2.0;
    a *= 0.5;
  }
  return s / norm;
}

// Ridged multifractal in [0,1] (sharp crests) - good for cracks/veins.
float ridged(vec2 p, vec2 per, int oct) {
  float s = 0.0;
  float a = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(gnoise(p, per));
    s += a * n * n;
    norm += a;
    p *= 2.0;
    per *= 2.0;
    a *= 0.5;
  }
  return s / norm;
}

// Periodic Voronoi. Returns (F1, F2, cell hash of nearest point).
vec3 voronoi(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  float id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 c = wrapCell(i + g, per);
      vec2 o = h22(c);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; id = h12(c + 17.0); }
      else if (d < d2) { d2 = d; }
    }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}

// Distance to the nearest Voronoi edge (exact two-pass version) - crisp cracks & cells.
vec2 voronoiEdge(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 mg;
  vec2 mr;
  float md = 8.0;
  float id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 c = wrapCell(i + g, per);
      vec2 o = h22(c);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; id = h12(c + 31.0); }
    }
  }
  md = 8.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 g = mg + vec2(float(x), float(y));
      vec2 c = wrapCell(i + g, per);
      vec2 o = h22(c);
      vec2 r = g + o - f;
      if (dot(mr - r, mr - r) > 0.00001) {
        md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
      }
    }
  }
  return vec2(md, id);
}

// Thin random scratches. dirAngle in radians, density = lines per unit, returns [0,1] mask.
float scratches(vec2 uv, float freq, float angle, float density, float seed) {
  vec2 d = vec2(cos(angle), sin(angle));
  vec2 n = vec2(-d.y, d.x);
  // Integer-ish projection keeps it periodic for axis-aligned and 45 degree angles.
  float along = dot(uv, d) * freq;
  float across = dot(uv, n) * density;
  float row = floor(across);
  float rnd = h12(vec2(row, seed));
  float len = step(0.55, vnoise(vec2(along * 0.35 + rnd * 37.0, row), vec2(1e4)));
  float w = abs(fract(across) - 0.5 - (rnd - 0.5) * 0.6);
  return (1.0 - smoothstep(0.0, 0.04, w)) * len * step(0.35, rnd);
}
`;
