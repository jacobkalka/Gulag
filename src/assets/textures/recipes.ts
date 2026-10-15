// Procedural PBR texture recipes. Each recipe is a GLSL function
//   void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal)
// evaluated on the GPU over one seamless tile. Colors uC0..uC3 are sRGB (0..1), uP0 is free params.
// albedo must be LINEAR (use srgb()).

export interface TextureRecipe {
  id: string;
  /** World size (meters) covered by one repeat of the texture. */
  tileMeters: number;
  /** Hero textures get the high-resolution budget. */
  hero: boolean;
  normalStrength: number;
  colors?: [number, number, number][];
  params?: [number, number, number, number];
  seed?: number;
  glsl: string;
}

const concreteWall = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float large = fbm01(uv * 3.0, vec2(3.0), 5);
  float med = fbm01(uv * 11.0 + 7.3, vec2(11.0), 4);
  float fine = vnoise(uv * 190.0, vec2(190.0)) * 0.5 + vnoise(uv * 95.0, vec2(95.0)) * 0.5;
  vec3 v = voronoi(uv * 70.0, vec2(70.0));
  float pit = (1.0 - smoothstep(0.04, 0.22, v.x)) * step(0.78, v.z);
  float bigPit = (1.0 - smoothstep(0.08, 0.3, voronoi(uv * 18.0, vec2(18.0)).x)) * step(0.93, voronoi(uv * 18.0, vec2(18.0)).z);
  // Vertical moisture streaks.
  float streak = fbm01(vec2(uv.x * 26.0, uv.y * 2.0) + vec2(0.0, large * 0.6), vec2(26.0, 2.0), 4);
  streak = smoothstep(0.52, 0.8, streak) * (0.35 + 0.65 * large);
  // Board-formed panel seams and tie holes.
  float sy = abs(fract(uv.y * 2.0) - 0.5);
  float seam = smoothstep(0.494, 0.4995, sy);
  vec2 tp = fract(uv * vec2(2.0, 2.0) + 0.25) - 0.5;
  float tie = 1.0 - smoothstep(0.010, 0.016, length(tp));
  float tieRing = (1.0 - smoothstep(0.016, 0.03, length(tp))) - tie;
  vec3 c0 = srgb(uC0);
  vec3 c1 = srgb(uC1);
  vec3 base = mix(c0, c1, smoothstep(0.25, 0.75, large));
  base *= 0.86 + 0.28 * med;
  base *= 0.93 + 0.14 * fine;
  base = mix(base, base * vec3(0.62, 0.66, 0.6), streak * 0.75);
  base *= 1.0 - pit * 0.45 - bigPit * 0.35;
  base *= 1.0 - seam * 0.35;
  base *= 1.0 - tie * 0.7 - tieRing * 0.15;
  albedo = base;
  height = 0.55 + 0.05 * fine + 0.12 * med - pit * 0.25 - bigPit * 0.35 - seam * 0.3 - tie * 0.5;
  rough = clamp(0.93 - streak * 0.35 - fine * 0.05, 0.0, 1.0);
  ao = 1.0 - pit * 0.4 - tie * 0.6 - bigPit * 0.4;
  metal = 0.0;
}`;

const concreteFloor = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  vec2 w = uv + vec2(fbm(uv * 3.0, vec2(3.0), 3), fbm(uv * 3.0 + 9.1, vec2(3.0), 3)) * 0.04;
  float large = fbm01(w * 2.0, vec2(2.0), 5);
  float trowel = fbm01(w * vec2(9.0, 9.0) + large, vec2(9.0), 4);
  float fine = vnoise(uv * 260.0, vec2(260.0)) * 0.6 + vnoise(uv * 130.0, vec2(130.0)) * 0.4;
  // Cracks: voronoi edges masked by noise.
  vec2 ve = voronoiEdge(w * 5.0 + fbm(uv * 8.0, vec2(8.0), 3) * 0.25, vec2(5.0));
  float crackMask = smoothstep(0.55, 0.75, fbm01(uv * 4.0 + 3.7, vec2(4.0), 4));
  float crack = (1.0 - smoothstep(0.0, 0.018, ve.x)) * crackMask;
  // Expansion joints at tile borders.
  vec2 jd = abs(fract(uv) - 0.5);
  float joint = smoothstep(0.4955, 0.4995, max(jd.x, jd.y));
  // Oil / grime stains.
  float stain = smoothstep(0.6, 0.85, fbm01(uv * 5.0 + 1.3, vec2(5.0), 5));
  // Water pooling in low areas.
  float undul = fbm(uv * 2.0 + 4.4, vec2(2.0), 4);
  float wet = (1.0 - smoothstep(-0.2, -0.05, undul));
  float puddle = (1.0 - smoothstep(-0.3, -0.22, undul));
  vec3 c0 = srgb(uC0);
  vec3 c1 = srgb(uC1);
  vec3 base = mix(c0, c1, large);
  base *= 0.88 + 0.24 * trowel;
  base *= 0.94 + 0.12 * fine;
  base = mix(base, base * vec3(0.45, 0.42, 0.4), stain * 0.8);
  base *= 1.0 - crack * 0.6 - joint * 0.5;
  base = mix(base, base * 0.62, wet);
  base = mix(base, base * 0.75, puddle);
  albedo = base;
  float h = 0.5 + 0.08 * trowel + 0.03 * fine - crack * 0.35 - joint * 0.4;
  height = mix(h, 0.52, puddle);
  rough = 0.82 - trowel * 0.12 - fine * 0.06;
  rough = mix(rough, 0.32, wet);
  rough = mix(rough, 0.03, puddle);
  rough = mix(rough, 0.55, stain * 0.5 * (1.0 - puddle));
  ao = 1.0 - crack * 0.5 - joint * 0.5;
  metal = 0.0;
}`;

const tiles = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float N = uP0.x;
  vec2 g = uv * N;
  vec2 id = floor(g);
  vec2 f = fract(g);
  vec2 e = min(f, 1.0 - f);
  float edge = min(e.x, e.y);
  float gw = 0.026;
  float grout = 1.0 - smoothstep(gw * 0.55, gw, edge);
  float bevel = smoothstep(gw * 0.6, gw * 2.8, edge);
  vec2 cid = mod(id, vec2(N));
  float rid = h12(cid + 3.1);
  float rid2 = h12(cid + 11.7);
  vec3 tc = srgb(uC0) * (0.9 + 0.14 * rid);
  tc = mix(tc, srgb(uC0) * vec3(1.02, 1.0, 0.94), rid2 * 0.5);
  float missing = step(0.994, rid);
  float cracked = step(0.955, rid) * (1.0 - missing);
  float crackLine = cracked * (1.0 - smoothstep(0.0, 0.03, abs(f.x - f.y * (0.4 + rid2) - 0.2)));
  float grime = sat(fbm(uv * 3.0, vec2(3.0), 5) * 0.7 + 0.25) * uP0.y;
  float drip = smoothstep(0.55, 0.9, fbm01(vec2(uv.x * 18.0, uv.y * 2.0), vec2(18.0, 2.0), 4)) * uP0.y;
  float speck = step(0.86, vnoise(uv * 300.0, vec2(300.0)));
  vec3 groutC = srgb(uC1) * (0.85 + 0.3 * vnoise(uv * 120.0, vec2(120.0)));
  vec3 under = srgb(vec3(0.36, 0.35, 0.33)) * (0.8 + 0.4 * vnoise(uv * 80.0, vec2(80.0)));
  vec3 c = mix(tc, groutC, grout);
  float dirt = sat(grime * (0.35 + 0.9 * grout) + drip * 0.5);
  c = mix(c, c * srgb(vec3(0.62, 0.55, 0.42)), dirt);
  c *= 1.0 - crackLine * 0.6;
  c *= 1.0 - speck * 0.06;
  c = mix(c, under, missing);
  albedo = c;
  vec2 tilt = (h22(cid + 5.0) - 0.5) * 0.04;
  float tileH = 0.62 + dot(f - 0.5, tilt);
  height = mix(0.35, tileH, bevel);
  height -= crackLine * 0.15;
  height = mix(height, 0.25 + 0.05 * vnoise(uv * 60.0, vec2(60.0)), missing);
  rough = mix(0.1 + rid * 0.08, 0.85, grout);
  rough = mix(rough, 0.7, dirt * 0.6);
  rough = mix(rough, 0.9, missing);
  ao = 1.0 - grout * 0.35 - missing * 0.3;
  metal = 0.0;
}`;

const paintedMetal = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  vec2 w = uv + vec2(fbm(uv * 6.0, vec2(6.0), 4), fbm(uv * 6.0 + 5.2, vec2(6.0), 4)) * 0.05;
  float chipN = fbm01(w * 7.0, vec2(7.0), 6);
  float chip = smoothstep(0.66, 0.69, chipN);
  float chipEdge = smoothstep(0.62, 0.66, chipN) - chip;
  float rustN = fbm01(uv * 13.0 + 2.0, vec2(13.0), 5);
  float rust = chip * smoothstep(0.35, 0.6, rustN);
  float rustBleed = smoothstep(0.6, 0.9, fbm01(vec2(uv.x * 14.0, uv.y * 3.0), vec2(14.0, 3.0), 4)) * 0.6;
  float sc = scratches(uv, 40.0, 0.0, 70.0, 1.0) + scratches(uv, 40.0, PI * 0.5, 60.0, 2.0) * 0.7;
  sc = sat(sc) * smoothstep(0.4, 0.8, fbm01(uv * 3.0 + 8.0, vec2(3.0), 3));
  float peel = vnoise(uv * 240.0, vec2(240.0));
  float dirt = smoothstep(0.45, 0.85, fbm01(uv * 4.0 + 1.0, vec2(4.0), 5));
  vec3 paint = srgb(uC0) * (0.92 + 0.12 * fbm01(uv * 20.0, vec2(20.0), 3));
  vec3 steel = srgb(vec3(0.55, 0.55, 0.56));
  vec3 rustC = mix(srgbHex(92.0, 44.0, 20.0), srgbHex(150.0, 74.0, 30.0), rustN);
  vec3 c = paint;
  c = mix(c, c * srgbHex(140.0, 90.0, 60.0) * 1.6, rustBleed * 0.35);
  c = mix(c, steel, chip);
  c = mix(c, rustC, rust);
  c = mix(c, steel * 0.9, sc * (1.0 - chip) * 0.8);
  c *= 1.0 - chipEdge * 0.25;
  c = mix(c, c * srgbHex(70.0, 62.0, 50.0) * 2.0, dirt * 0.45);
  albedo = c;
  height = 0.6 - chip * 0.12 + chipEdge * 0.04 + peel * 0.015 - sc * 0.03 + rust * (rustN - 0.5) * 0.1;
  rough = mix(0.48 + peel * 0.1, 0.32, chip);
  rough = mix(rough, 0.92, rust);
  rough = mix(rough, 0.25, sc * (1.0 - chip) * 0.6);
  rough = mix(rough, 0.8, dirt * 0.4);
  ao = 1.0 - chipEdge * 0.2;
  metal = mix(0.0, 1.0, chip * (1.0 - rust));
  metal = max(metal, sc * (1.0 - chip) * 0.9);
}`;

const rustyMetal = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float a = fbm01(uv * 4.0, vec2(4.0), 6);
  float b = fbm01(uv * 16.0 + 3.0, vec2(16.0), 5);
  vec3 vo = voronoi(uv * 22.0, vec2(22.0));
  float flake = (1.0 - smoothstep(0.0, 0.1, vo.y - vo.x)) ;
  float pits = (1.0 - smoothstep(0.05, 0.2, voronoi(uv * 90.0, vec2(90.0)).x));
  float bare = smoothstep(0.62, 0.7, a) * (1.0 - smoothstep(0.4, 0.7, b));
  vec3 rust1 = srgbHex(58.0, 36.0, 24.0);
  vec3 rust2 = srgbHex(150.0, 82.0, 34.0);
  vec3 rust3 = srgbHex(96.0, 84.0, 72.0);
  vec3 c = mix(rust1, rust2, b);
  c = mix(c, rust3, smoothstep(0.55, 0.8, a) * 0.6);
  c *= 0.8 + 0.4 * vnoise(uv * 150.0, vec2(150.0));
  vec3 steel = srgb(uC0);
  c = mix(c, steel, bare);
  c *= 1.0 - flake * 0.35 - pits * 0.2;
  albedo = c;
  height = 0.5 + b * 0.2 + flake * 0.08 - pits * 0.1 - bare * 0.1;
  rough = mix(0.9, 0.42, bare);
  ao = 1.0 - pits * 0.3 - flake * 0.2;
  metal = bare;
}`;

const diamondPlate = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float N = 6.0;
  vec2 g = uv * N;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float flip = mod(id.x + id.y, 2.0) < 1.0 ? 1.0 : -1.0;
  float ang = 0.785398 * flip;
  vec2 r = vec2(cos(ang) * f.x - sin(ang) * f.y, sin(ang) * f.x + cos(ang) * f.y);
  // Elongated lozenge
  float d = abs(r.x) / 0.36 + abs(r.y) / 0.07;
  float raised = 1.0 - smoothstep(0.85, 1.0, d);
  float worn = smoothstep(0.4, 0.75, fbm01(uv * 5.0, vec2(5.0), 4));
  float dirt = smoothstep(0.35, 0.8, fbm01(uv * 3.0 + 2.0, vec2(3.0), 5));
  float rustN = smoothstep(0.65, 0.85, fbm01(uv * 7.0 + 9.0, vec2(7.0), 5));
  vec3 steel = srgb(uC0) * (0.85 + 0.25 * vnoise(uv * 200.0, vec2(200.0)));
  vec3 c = steel;
  c = mix(c, c * 1.35, raised * worn);
  c = mix(c, srgbHex(55.0, 48.0, 40.0), dirt * (1.0 - raised) * 0.7);
  c = mix(c, srgbHex(110.0, 55.0, 25.0), rustN * (1.0 - raised) * 0.8);
  albedo = c;
  height = 0.4 + raised * 0.35;
  rough = mix(0.5, 0.25, raised * worn);
  rough = mix(rough, 0.85, dirt * (1.0 - raised) * 0.7 + rustN * 0.5);
  ao = 1.0 - (1.0 - raised) * 0.15;
  metal = 1.0 - rustN * (1.0 - raised) * 0.8 - dirt * (1.0 - raised) * 0.5;
}`;

const brick = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float rows = 26.0;
  float cols = 9.0;
  vec2 g = vec2(uv.x * cols, uv.y * rows);
  float row = floor(g.y);
  g.x += mod(row, 2.0) * 0.5;
  vec2 id = floor(g);
  vec2 f = fract(g);
  vec2 cid = vec2(mod(id.x, cols), mod(id.y, rows));
  float mx = 0.045;
  float my = 0.14;
  float mortar = 1.0 - smoothstep(0.0, 1.0, min(min(f.x, 1.0 - f.x) / mx, min(f.y, 1.0 - f.y) / my));
  float bev = smoothstep(0.0, 1.0, min(min(f.x, 1.0 - f.x) / (mx * 2.5), min(f.y, 1.0 - f.y) / (my * 2.5)));
  float rid = h12(cid + 1.0);
  float rid2 = h12(cid + 9.0);
  vec3 b1 = srgbHex(120.0, 52.0, 36.0);
  vec3 b2 = srgbHex(150.0, 78.0, 52.0);
  vec3 b3 = srgbHex(80.0, 40.0, 32.0);
  vec3 bc = mix(b1, b2, rid);
  bc = mix(bc, b3, step(0.85, rid2));
  float speck = vnoise(uv * 220.0, vec2(220.0));
  bc *= 0.85 + 0.3 * speck;
  float soot = smoothstep(0.5, 0.85, fbm01(uv * 3.0, vec2(3.0), 5));
  vec3 mc = srgbHex(140.0, 134.0, 122.0) * (0.8 + 0.3 * vnoise(uv * 160.0, vec2(160.0)));
  vec3 c = mix(bc, mc, mortar);
  c = mix(c, c * 0.35, soot * 0.7);
  albedo = c;
  float chip = step(0.75, vnoise(g * 5.0, vec2(cols * 5.0, rows * 5.0))) * (1.0 - bev);
  height = mix(0.25, 0.65 + speck * 0.05, bev) - chip * 0.2;
  rough = mix(0.85, 0.95, mortar);
  ao = 1.0 - mortar * 0.4;
  metal = 0.0;
}`;

const plasterPaint = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  vec2 w = uv + vec2(fbm(uv * 5.0, vec2(5.0), 4), fbm(uv * 5.0 + 3.3, vec2(5.0), 4)) * 0.03;
  // peeling patches come from decals now (unique per wall); the tiling texture keeps only
  // rare small chips so nothing big repeats every tile
  float peelN = fbm01(w * 9.0, vec2(9.0), 5);
  float peel = smoothstep(0.82, 0.83, peelN);
  float peelEdge = smoothstep(0.79, 0.82, peelN) - peel;
  float stain = smoothstep(0.5, 0.9, fbm01(vec2(uv.x * 10.0, uv.y * 2.0) + vec2(0.0, fbm(uv * 2.0, vec2(2.0), 3)), vec2(10.0, 2.0), 5));
  float grime = smoothstep(0.4, 0.9, fbm01(uv * 2.0 + 7.0, vec2(2.0), 5));
  vec2 ve = voronoiEdge(w * 4.0, vec2(4.0));
  float crack = (1.0 - smoothstep(0.0, 0.01, ve.x)) * smoothstep(0.72, 0.8, fbm01(uv * 3.0 + 4.0, vec2(3.0), 4));
  float orange = vnoise(uv * 300.0, vec2(300.0));
  vec3 paint = srgb(uC0) * (0.93 + 0.1 * fbm01(uv * 14.0, vec2(14.0), 3));
  vec3 under = srgb(uC1) * (0.8 + 0.3 * vnoise(uv * 90.0, vec2(90.0)));
  vec3 c = mix(paint, under, peel);
  c *= 1.0 - peelEdge * 0.3;
  c = mix(c, c * srgbHex(120.0, 105.0, 80.0) * 1.6, stain * 0.55);
  c = mix(c, c * 0.6, grime * 0.4);
  c *= 1.0 - crack * 0.6;
  albedo = c;
  height = 0.6 + orange * 0.02 - peel * 0.12 + peelEdge * 0.05 - crack * 0.2;
  rough = mix(0.62 + orange * 0.08, 0.92, peel);
  rough = mix(rough, 0.45, stain * 0.3);
  ao = 1.0 - crack * 0.4 - peelEdge * 0.2;
  metal = 0.0;
}`;

const woodPlanks = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float planks = uP0.y > 0.5 ? uP0.y : 8.0;
  float nails = uP0.z > 0.5 ? 0.0 : 1.0;
  float py = uv.y * planks;
  float pid = floor(py);
  float pf = fract(py);
  float gap = (1.0 - smoothstep(0.0, 0.035, min(pf, 1.0 - pf))) * step(1.5, planks);
  float rid = h12(vec2(mod(pid, planks), 4.0));
  float off = rid * 37.0;
  float grain = fbm01(vec2(uv.x * 3.0 + off, py * 2.0 + fbm(vec2(uv.x * 6.0, py), vec2(6.0, planks), 3) * 0.6), vec2(3.0, planks * 2.0), 5);
  float rings = sin((grain * 22.0 + pf * 3.0) * PI) * 0.5 + 0.5;
  vec2 kp = vec2(fract(uv.x * 2.0 + rid) - 0.5, pf - 0.5) * vec2(4.0, 1.0);
  float knot = (1.0 - smoothstep(0.05, 0.18, length(kp))) * step(0.6, rid);
  vec3 w1 = srgb(uC0);
  vec3 w2 = srgb(uC1);
  vec3 c = mix(w1, w2, rings * 0.6 + grain * 0.4);
  c *= 0.85 + 0.25 * rid;
  c = mix(c, w2 * 0.45, knot);
  float weather = smoothstep(0.4, 0.8, fbm01(uv * 3.0 + 2.0, vec2(3.0), 4)) * uP0.x;
  c = mix(c, srgbHex(110.0, 104.0, 96.0), weather * 0.5);
  vec2 np = vec2(fract(uv.x * 2.0) - 0.06, pf - 0.5);
  float nail = (1.0 - smoothstep(0.012, 0.02, length(np * vec2(1.0, 0.25)))) * nails;
  c = mix(c, srgbHex(60.0, 60.0, 62.0), nail);
  c *= 1.0 - gap * 0.75;
  albedo = c;
  height = 0.6 + rings * 0.03 - gap * 0.5 - knot * 0.03;
  rough = 0.72 + weather * 0.15 - nail * 0.3;
  ao = 1.0 - gap * 0.6;
  metal = nail;
}`;

const hazard = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float s = fract((uv.x + uv.y) * 5.0);
  float stripe = step(0.5, s);
  float edgeSoft = smoothstep(0.0, 0.01, abs(s - 0.5)) * smoothstep(0.0, 0.01, min(s, 1.0 - s));
  float wear = smoothstep(0.62, 0.66, fbm01(uv * 8.0, vec2(8.0), 6));
  float dirt = smoothstep(0.4, 0.85, fbm01(uv * 3.0 + 3.0, vec2(3.0), 5));
  vec3 yel = srgbHex(222.0, 168.0, 22.0);
  vec3 blk = srgbHex(22.0, 22.0, 22.0);
  vec3 c = mix(yel, blk, stripe);
  vec3 under = srgb(uC0) * (0.8 + 0.3 * vnoise(uv * 100.0, vec2(100.0)));
  c = mix(c, under, wear);
  c = mix(c, c * srgbHex(90.0, 80.0, 60.0) * 2.0, dirt * 0.5);
  albedo = c;
  height = 0.6 - wear * 0.08 + vnoise(uv * 200.0, vec2(200.0)) * 0.02;
  rough = mix(0.55, 0.85, wear);
  rough = mix(rough, 0.8, dirt * 0.3);
  ao = 1.0;
  metal = wear * uP0.x;
}`;

const gunSteel = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float grain = vnoise(uv * 400.0, vec2(400.0)) * 0.5 + vnoise(uv * 200.0, vec2(200.0)) * 0.5;
  float mottle = fbm01(uv * 6.0, vec2(6.0), 4);
  float sc = sat(scratches(uv, 30.0, 0.0, 160.0, 3.0) + scratches(uv, 25.0, PI * 0.25, 120.0, 4.0) * 0.6) * smoothstep(0.5, 0.8, fbm01(uv * 3.0 + 5.0, vec2(3.0), 3));
  float wear = smoothstep(0.62, 0.82, fbm01(uv * 4.0 + 1.0, vec2(4.0), 5));
  vec3 base = srgb(uC0) * (0.85 + 0.25 * mottle) * (0.9 + 0.2 * grain);
  vec3 bright = srgb(vec3(0.62, 0.62, 0.64));
  vec3 c = mix(base, bright, sc * 0.18 + wear * 0.12);
  albedo = c;
  height = 0.5 + grain * 0.04 - sc * 0.02;
  rough = mix(0.5 + grain * 0.12 + mottle * 0.06, 0.3, sc * 0.35 + wear * 0.2);
  ao = 1.0;
  metal = mix(uP0.x, 1.0, sc + wear * 0.5);
}`;

const gunPolymer = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  vec3 v = voronoi(uv * uP0.x, vec2(uP0.x));
  float stipple = (1.0 - smoothstep(0.0, 0.55, v.x)) * uP0.y;
  float fine = vnoise(uv * 500.0, vec2(500.0));
  float mottle = fbm01(uv * 5.0, vec2(5.0), 4);
  float scuff = smoothstep(0.66, 0.82, fbm01(uv * 7.0 + 2.0, vec2(7.0), 5));
  vec3 c = srgb(uC0) * (0.9 + 0.16 * mottle) * (0.95 + 0.1 * fine);
  c = mix(c, c * 1.5 + 0.02, scuff * 0.35);
  albedo = c;
  height = 0.5 + stipple * 0.25 + fine * 0.03;
  rough = 0.62 + fine * 0.1 - scuff * 0.15 + stipple * 0.08;
  ao = 1.0 - (1.0 - smoothstep(0.0, 0.35, v.x)) * 0.12 * uP0.y;
  metal = 0.0;
}`;

const gunAlu = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float brushed = vnoise(vec2(uv.x * 8.0, uv.y * 900.0), vec2(8.0, 900.0)) * 0.6 + vnoise(vec2(uv.x * 30.0, uv.y * 1800.0), vec2(30.0, 1800.0)) * 0.4;
  float mottle = fbm01(uv * 4.0, vec2(4.0), 4);
  float sc = sat(scratches(uv, 30.0, 0.0, 150.0, 7.0)) * smoothstep(0.55, 0.85, fbm01(uv * 3.0 + 1.0, vec2(3.0), 3));
  float edgeWear = smoothstep(0.74, 0.88, fbm01(uv * 5.0 + 3.0, vec2(5.0), 5));
  vec3 c = srgb(uC0) * (0.9 + 0.16 * mottle) * (0.95 + 0.1 * brushed);
  c = mix(c, srgb(vec3(0.62, 0.62, 0.64)), sc * 0.22 + edgeWear * 0.18);
  albedo = c;
  height = 0.5 + brushed * 0.02 - sc * 0.015;
  rough = mix(0.42 + brushed * 0.1, 0.3, sc * 0.4 + edgeWear * 0.3);
  ao = 1.0;
  // Anodized finish behaves mostly like a dark dielectric; bare scratches are metal.
  metal = mix(0.18, 1.0, sat(sc + edgeWear));
}`;

// Brushed / polished bare metal (chrome fittings, brass casings). uP0.x = base roughness.
const brushedMetal = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float brushed = vnoise(vec2(uv.x * 6.0, uv.y * 700.0), vec2(6.0, 700.0)) * 0.6 + vnoise(vec2(uv.x * 24.0, uv.y * 1400.0), vec2(24.0, 1400.0)) * 0.4;
  float mottle = fbm01(uv * 3.0, vec2(3.0), 4);
  float smudge = smoothstep(0.55, 0.85, fbm01(uv * 5.0 + 9.0, vec2(5.0), 5));
  float sc = sat(scratches(uv, 22.0, 0.3, 140.0, 11.0)) * smoothstep(0.5, 0.8, fbm01(uv * 2.0 + 4.0, vec2(2.0), 3));
  float pit = (1.0 - smoothstep(0.05, 0.2, voronoi(uv * 40.0, vec2(40.0)).x)) * step(0.9, voronoi(uv * 40.0, vec2(40.0)).z);
  vec3 c = srgb(uC0) * (0.9 + 0.12 * mottle) * (0.96 + 0.08 * brushed);
  c *= 1.0 - smudge * 0.25 - pit * 0.5;
  albedo = c;
  height = 0.5 + brushed * 0.015 - sc * 0.02 - pit * 0.1;
  rough = clamp(uP0.x + brushed * 0.08 + smudge * 0.22 + sc * 0.1, 0.03, 1.0);
  ao = 1.0 - pit * 0.4;
  metal = 1.0 - smudge * 0.3;
}`;

// Glazed ceramic (toilets, sinks): glossy glaze with fine crazing and grime in the cracks.
const ceramic = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  vec2 ve = voronoiEdge(uv * 9.0 + fbm(uv * 6.0, vec2(6.0), 3) * 0.15, vec2(9.0));
  float craze = 1.0 - smoothstep(0.0, 0.012, ve.x);
  float grime = smoothstep(0.45, 0.85, fbm01(uv * 4.0 + 2.0, vec2(4.0), 5));
  float fine = vnoise(uv * 300.0, vec2(300.0));
  vec3 c = srgb(uC0) * (0.95 + 0.05 * fine);
  c = mix(c, srgb(uC1), grime * 0.45);
  c *= 1.0 - craze * (0.25 + grime * 0.4);
  albedo = c;
  height = 0.6 - craze * 0.15 + fine * 0.01;
  rough = 0.1 + grime * 0.45 + craze * 0.3;
  ao = 1.0 - craze * 0.3;
  metal = 0.0;
}`;

const fabricCamo = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  // Woven micro texture
  vec2 wv = uv * 220.0;
  float weave = sin(wv.x * PI) * sin(wv.y * PI);
  float threadA = 0.5 + 0.5 * sin(wv.x * PI * 2.0);
  float threadB = 0.5 + 0.5 * sin(wv.y * PI * 2.0);
  float woven = mix(threadA, threadB, step(0.0, weave));
  // Camo blobs from warped noise, 4 tones
  vec2 w = uv + vec2(fbm(uv * 4.0, vec2(4.0), 3), fbm(uv * 4.0 + 2.0, vec2(4.0), 3)) * 0.08;
  float n1 = fbm01(w * 3.0, vec2(3.0), 4);
  float n2 = fbm01(w * 5.0 + 4.0, vec2(5.0), 4);
  vec3 c = srgb(uC0);
  c = mix(c, srgb(uC1), smoothstep(0.48, 0.52, n1));
  c = mix(c, srgb(uC2), smoothstep(0.58, 0.62, n2));
  c = mix(c, srgb(uC3), smoothstep(0.68, 0.71, n1 * 0.5 + n2 * 0.5) * uP0.x);
  float wear = smoothstep(0.5, 0.9, fbm01(uv * 6.0 + 7.0, vec2(6.0), 5));
  c = mix(c, c * srgbHex(150.0, 140.0, 120.0) * 1.4, wear * 0.25);
  c *= 0.9 + 0.15 * woven;
  albedo = c;
  height = 0.5 + woven * 0.2 + fbm(uv * 12.0, vec2(12.0), 3) * 0.05;
  rough = 0.88 - woven * 0.05;
  ao = 0.9 + woven * 0.1;
  metal = 0.0;
}`;

const jungleFloor = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  // dark wet soil under a litter of fallen leaves, moss creeping over it
  float soilN = fbm01(uv * 6.0, vec2(6.0), 5);
  vec3 soil = mix(srgb(uC0), srgb(uC0) * 0.6, soilN);
  // leaves: two layers of rotated voronoi cells, each cell one leaf with its own tone
  vec3 leafCol = soil;
  float leafH = 0.0;
  for (int k = 0; k < 2; k++) {
    float sc = k == 0 ? 15.0 : 23.0;
    // warped cells: torn, irregular leaves instead of round spots
    vec2 q = uv * sc + float(k) * 7.31;
    q += vec2(fbm(uv * 6.0 + float(k) * 2.1, vec2(6.0), 3), fbm(uv * 6.0 + 4.3 + float(k), vec2(6.0), 3)) * 1.1;
    vec3 v = voronoi(q, vec2(sc));
    float shape = 1.0 - smoothstep(0.14, 0.36, v.x * (1.2 + v.z * 0.6));
    float vein = 1.0 - smoothstep(0.0, 0.03, abs(fract((v.x - v.y) * 3.0) - 0.5) * 0.2);
    // rotting leaves sit close to the soil's own tone
    vec3 tone = mix(soil, mix(srgb(uC1), srgb(uC2), fract(v.z * 7.13)), 0.6);
    tone *= 0.72 + 0.3 * fract(v.z * 3.7);
    float keep = step(0.35, fract(v.z * 11.3));
    leafCol = mix(leafCol, tone * (0.92 + 0.12 * vein), shape * keep);
    leafH = max(leafH, shape * keep * (0.5 + 0.2 * float(k)));
  }
  // moss patches and thin twigs
  float moss = smoothstep(0.55, 0.72, fbm01(uv * 3.0 + 4.0, vec2(3.0), 5));
  float mossFine = vnoise(uv * 140.0, vec2(140.0));
  vec3 col = mix(leafCol, srgb(uC3) * (0.8 + 0.4 * mossFine), moss * 0.85);
  float twig = sat(scratches(uv, 9.0, 0.7, 12.0, 4.0) + scratches(uv, 9.0, 2.1, 10.0, 6.0));
  col = mix(col, srgbHex(58.0, 44.0, 32.0), twig * 0.8);
  albedo = col;
  height = 0.35 + soilN * 0.1 + leafH * 0.4 + moss * 0.18 + twig * 0.15;
  rough = mix(0.62, 0.8, moss) - leafH * 0.12;
  ao = 0.8 + 0.2 * leafH;
  metal = 0.0;
}`;

const mud = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  vec2 w = uv + vec2(fbm(uv * 4.0, vec2(4.0), 4), fbm(uv * 4.0 + 3.3, vec2(4.0), 4)) * 0.06;
  float lumps = fbm01(w * 7.0, vec2(7.0), 5);
  float fine = vnoise(uv * 160.0, vec2(160.0));
  // boot prints and ruts filled with water
  vec3 v = voronoi(uv * 6.0, vec2(6.0));
  float print = (1.0 - smoothstep(0.12, 0.2, v.x)) * step(0.55, v.z);
  float rut = smoothstep(0.42, 0.5, abs(fract(uv.x * 2.0 + fbm(uv * 2.0, vec2(2.0), 3) * 0.2) - 0.5));
  float wet = sat(max(print, (1.0 - lumps) * 1.4 - 0.6));
  vec3 col = mix(srgb(uC0), srgb(uC1), lumps);
  col *= 0.85 + 0.25 * fine;
  col = mix(col, col * 0.55, wet);
  albedo = col;
  height = 0.4 + lumps * 0.4 - print * 0.25 - rut * 0.1 + fine * 0.04;
  rough = mix(0.72, 0.12, wet);
  ao = 0.85 + 0.15 * lumps;
  metal = 0.0;
}`;

const bark = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  // deep vertical furrows between rough plates, lichen and moss on top
  vec2 q = vec2(uv.x * 9.0, uv.y * 2.5);
  float furrow = fbm01(q + vec2(fbm(uv * vec2(4.0, 1.0), vec2(4.0, 1.0), 3) * 0.8, 0.0), vec2(9.0, 2.5), 5);
  float ridge = smoothstep(0.35, 0.65, furrow);
  float plates = voronoi(vec2(uv.x * 12.0, uv.y * 4.0), vec2(12.0, 4.0)).x;
  float fine = vnoise(uv * vec2(220.0, 90.0), vec2(220.0, 90.0));
  vec3 col = mix(srgb(uC0) * 0.55, srgb(uC0), ridge);
  col *= 0.85 + 0.3 * fine;
  float lichen = smoothstep(0.62, 0.75, fbm01(uv * 5.0 + 2.0, vec2(5.0), 4));
  float moss = smoothstep(0.55, 0.7, fbm01(uv * 3.0 + 8.0, vec2(3.0), 5));
  col = mix(col, srgb(uC1), lichen * 0.6);
  col = mix(col, srgb(uC2) * (0.8 + 0.4 * fine), moss * 0.7);
  albedo = col;
  height = 0.3 + ridge * 0.5 + smoothstep(0.1, 0.4, plates) * 0.1 + moss * 0.15 + fine * 0.05;
  rough = 0.9 - moss * 0.25;
  ao = 0.6 + 0.4 * ridge;
  metal = 0.0;
}`;

const palmBark = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  // rings of old leaf scars up the trunk, fibrous between them
  float ring = fract(uv.y * 7.0 + fbm(uv * vec2(3.0, 1.0), vec2(3.0, 1.0), 3) * 0.15);
  float scar = smoothstep(0.0, 0.12, ring) * (1.0 - smoothstep(0.82, 1.0, ring));
  float fiber = vnoise(vec2(uv.x * 260.0, uv.y * 40.0), vec2(260.0, 40.0));
  float diamond = abs(fract(uv.x * 6.0 + uv.y * 3.5) - 0.5) + abs(fract(uv.x * 6.0 - uv.y * 3.5) - 0.5);
  vec3 col = mix(srgb(uC0) * 0.6, srgb(uC0), scar);
  col *= 0.85 + 0.25 * fiber;
  col = mix(col, srgb(uC1), smoothstep(0.55, 0.7, fbm01(uv * 4.0, vec2(4.0), 4)) * 0.5);
  albedo = col;
  height = 0.4 + scar * 0.35 + fiber * 0.08 + smoothstep(0.6, 0.9, diamond) * 0.1;
  rough = 0.88;
  ao = 0.7 + 0.3 * scar;
  metal = 0.0;
}`;

const canvas = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  vec2 wv = uv * 180.0;
  float weave = sin(wv.x * PI) * sin(wv.y * PI);
  float threadA = 0.5 + 0.5 * sin(wv.x * PI * 2.0);
  float threadB = 0.5 + 0.5 * sin(wv.y * PI * 2.0);
  float woven = mix(threadA, threadB, step(0.0, weave));
  float seam = 1.0 - smoothstep(0.0, 0.006, abs(fract(uv.x * 2.0) - 0.5) - 0.49);
  float stain = smoothstep(0.55, 0.85, fbm01(uv * 3.0, vec2(3.0), 5));
  float drip = smoothstep(0.6, 0.85, fbm01(vec2(uv.x * 14.0, uv.y * 1.5), vec2(14.0, 1.5), 4));
  vec3 col = srgb(uC0) * (0.88 + 0.16 * woven);
  col = mix(col, col * 0.62, stain * 0.6 + drip * 0.35);
  col *= 1.0 - seam * 0.25;
  albedo = col;
  height = 0.5 + woven * 0.2 + seam * 0.2;
  rough = 0.86 - drip * 0.25;
  ao = 0.9 + 0.1 * woven;
  metal = 0.0;
}`;

const corrugated = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  // painted corrugated steel (tint the material for the paint color): ribs, scratches, rust streaks
  float rib = 0.5 + 0.5 * cos(uv.x * PI * 2.0 * 7.0);
  float fine = vnoise(uv * 200.0, vec2(200.0));
  float sc = sat(scratches(uv, 16.0, 0.4, 30.0, 3.0) + scratches(uv, 16.0, 1.9, 24.0, 5.0));
  float streak = smoothstep(0.55, 0.85, fbm01(vec2(uv.x * 24.0, uv.y * 2.0), vec2(24.0, 2.0), 4));
  float rustPatch = smoothstep(0.6, 0.78, fbm01(uv * 5.0 + 1.0, vec2(5.0), 5));
  vec3 paint = srgb(uC0) * (0.9 + 0.12 * fine);
  vec3 rust = srgb(uC1) * (0.7 + 0.5 * fine);
  vec3 col = mix(paint, rust, sat(streak * 0.55 + rustPatch * 0.8));
  col = mix(col, srgbHex(140.0, 140.0, 138.0), sc * 0.5);
  albedo = col;
  height = 0.5 + rib * 0.4 + fine * 0.03 - sc * 0.04 + rustPatch * 0.04;
  rough = mix(0.5, 0.9, sat(streak + rustPatch));
  ao = 0.75 + 0.25 * rib;
  metal = 0.0;
}`;

const sandbag = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  // coarse burlap weave, darker where it's wet and caked
  vec2 wv = uv * 90.0;
  float tx = 0.5 + 0.5 * sin(wv.x * PI * 2.0 + vnoise(uv * 30.0, vec2(30.0)) * 2.0);
  float ty = 0.5 + 0.5 * sin(wv.y * PI * 2.0 + vnoise(uv * 30.0 + 3.0, vec2(30.0)) * 2.0);
  float weave = max(tx * step(0.5, fract(wv.y * 0.5)), ty * step(fract(wv.y * 0.5), 0.5));
  float dirt = smoothstep(0.45, 0.8, fbm01(uv * 4.0, vec2(4.0), 5));
  vec3 col = srgb(uC0) * (0.8 + 0.3 * weave);
  col = mix(col, srgb(uC1), dirt * 0.7);
  albedo = col;
  height = 0.45 + weave * 0.35 + dirt * 0.05;
  rough = 0.9 - dirt * 0.2;
  ao = 0.8 + 0.2 * weave;
  metal = 0.0;
}`;

const armorPlastic = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float fine = vnoise(uv * 300.0, vec2(300.0));
  float mottle = fbm01(uv * 5.0, vec2(5.0), 4);
  float scuff = smoothstep(0.64, 0.8, fbm01(uv * 9.0 + 1.0, vec2(9.0), 5));
  float sc = sat(scratches(uv, 20.0, 0.6, 40.0, 9.0) + scratches(uv, 20.0, 2.2, 30.0, 10.0));
  vec3 c = srgb(uC0) * (0.88 + 0.2 * mottle) * (0.96 + 0.08 * fine);
  c = mix(c, c * 1.7 + 0.03, scuff * 0.4 + sc * 0.5);
  albedo = c;
  height = 0.5 + fine * 0.03 - sc * 0.05;
  rough = 0.55 + fine * 0.1 + scuff * 0.1;
  ao = 1.0;
  metal = 0.0;
}`;

const rubber = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float fine = vnoise(uv * 350.0, vec2(350.0));
  float mottle = fbm01(uv * 6.0, vec2(6.0), 4);
  float dust = smoothstep(0.55, 0.85, fbm01(uv * 4.0, vec2(4.0), 5));
  vec3 c = srgb(uC0) * (0.85 + 0.25 * mottle);
  c = mix(c, srgbHex(90.0, 86.0, 80.0), dust * 0.25);
  albedo = c;
  height = 0.5 + fine * 0.06;
  rough = 0.86 + fine * 0.08;
  ao = 1.0;
  metal = 0.0;
}`;

// Loose paper (forms, notices): fibers, faint printed lines, a fold crease, tea-colored stains.
const paper = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float fib = vnoise(uv * vec2(400.0, 60.0), vec2(400.0, 60.0));
  float row = fract(uv.y * 24.0);
  float lines = smoothstep(0.86, 0.93, row) * (1.0 - smoothstep(0.93, 0.97, row)) * step(0.12, fract(uv.x)) * step(fract(uv.x), 0.8) * 0.55;
  float stain = smoothstep(0.55, 0.9, fbm01(uv * 3.0, vec2(3.0), 4));
  float crease = 1.0 - smoothstep(0.0, 0.012, abs(fract(uv.x) - 0.5 + fbm(uv * 2.0, vec2(2.0), 2) * 0.02));
  vec3 c = srgb(uC0) * (0.94 + 0.06 * fib);
  c = mix(c, c * 0.4, lines);
  c = mix(c, c * srgbHex(170.0, 140.0, 90.0) * 1.3, stain * 0.5);
  albedo = c;
  height = 0.5 + fib * 0.03 - crease * 0.15;
  rough = 0.9;
  ao = 1.0 - crease * 0.3;
  metal = 0.0;
}`;

// Woven cloth tape (team ID strips): light neutral weave, tinted per team by the material color.
const tape = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  vec2 wv = uv * 160.0;
  float weave = 0.5 + 0.5 * sin(wv.x * PI) * sin(wv.y * PI);
  float grime = smoothstep(0.45, 0.9, fbm01(uv * 5.0, vec2(5.0), 4));
  float scuff = scratches(uv, 9.0, 0.3, 30.0, 5.0);
  vec3 c = srgb(uC0) * (0.9 + 0.1 * weave);
  c = mix(c, c * 0.55, grime * 0.5);
  c = mix(c, c * 0.7, scuff * 0.5);
  albedo = c;
  height = 0.5 + weave * 0.08 - scuff * 0.05;
  rough = 0.82 + weave * 0.06;
  ao = 0.92 + weave * 0.08;
  metal = 0.0;
}`;

const mattress = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  float st = fract(uv.x * 14.0);
  float stripe = smoothstep(0.35, 0.4, st) * (1.0 - smoothstep(0.6, 0.65, st));
  vec2 wv = uv * 300.0;
  float weave = 0.5 + 0.25 * sin(wv.x * PI) + 0.25 * sin(wv.y * PI);
  float stain = smoothstep(0.55, 0.8, fbm01(uv * 3.0, vec2(3.0), 5));
  float stain2 = smoothstep(0.62, 0.66, fbm01(uv * 6.0 + 4.0, vec2(6.0), 5));
  vec3 c = mix(srgb(uC0), srgb(uC1), stripe);
  c *= 0.9 + 0.12 * weave;
  c = mix(c, c * srgbHex(150.0, 120.0, 70.0) * 1.3, stain * 0.7);
  c = mix(c, c * 0.6, stain2 * 0.4);
  albedo = c;
  vec2 q = fract(uv * vec2(4.0, 6.0)) - 0.5;
  float tuft = 1.0 - smoothstep(0.0, 0.06, length(q));
  height = 0.5 + weave * 0.05 - tuft * 0.3;
  rough = 0.92;
  ao = 1.0 - tuft * 0.4;
  metal = 0.0;
}`;

const leather = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao, out float metal) {
  vec3 v = voronoi(uv * 180.0, vec2(180.0));
  float cell = smoothstep(0.0, 0.25, v.y - v.x);
  float crease = 1.0 - smoothstep(0.0, 0.03, abs(fbm(uv * vec2(4.0, 10.0), vec2(4.0, 10.0), 4)));
  float mottle = fbm01(uv * 5.0, vec2(5.0), 4);
  vec3 c = srgb(uC0) * (0.88 + 0.2 * mottle);
  c *= 0.96 + 0.04 * cell;
  c = mix(c, c * 1.3, crease * 0.25);
  albedo = c;
  height = 0.5 + cell * 0.04 - crease * 0.08;
  rough = 0.6 + (1.0 - cell) * 0.2;
  ao = 0.9 + 0.1 * cell;
  metal = 0.0;
}`;

/** All recipes used by the game. Colors are sRGB 0..255. */
export const RECIPES: TextureRecipe[] = [
  { id: 'concrete', tileMeters: 2.5, hero: true, normalStrength: 2.2, colors: [[128, 126, 120], [96, 94, 90]], glsl: concreteWall },
  { id: 'concreteDark', tileMeters: 2.5, hero: false, normalStrength: 2.2, colors: [[92, 90, 86], [70, 69, 66]], seed: 7, glsl: concreteWall },
  { id: 'floor', tileMeters: 4, hero: true, normalStrength: 2.0, colors: [[98, 95, 90], [78, 75, 70]], glsl: concreteFloor },
  { id: 'tileWhite', tileMeters: 1.2, hero: true, normalStrength: 3.0, colors: [[206, 202, 188], [150, 146, 134]], params: [8, 0.9, 0, 0], glsl: tiles },
  { id: 'tileGreen', tileMeters: 1.2, hero: false, normalStrength: 3.0, colors: [[104, 138, 116], [120, 122, 110]], params: [8, 1.0, 0, 0], seed: 3, glsl: tiles },
  { id: 'tileFloor', tileMeters: 1.0, hero: true, normalStrength: 3.0, colors: [[150, 146, 136], [70, 68, 62]], params: [5, 1.0, 0, 0], seed: 5, glsl: tiles },
  { id: 'paintGreen', tileMeters: 2, hero: false, normalStrength: 1.5, colors: [[62, 84, 70]], glsl: paintedMetal },
  { id: 'paintGrey', tileMeters: 2, hero: false, normalStrength: 1.5, colors: [[96, 100, 102]], seed: 2, glsl: paintedMetal },
  { id: 'paintBlue', tileMeters: 2, hero: false, normalStrength: 1.5, colors: [[46, 66, 84]], seed: 4, glsl: paintedMetal },
  { id: 'paintOrange', tileMeters: 2, hero: false, normalStrength: 1.5, colors: [[196, 86, 24]], seed: 6, glsl: paintedMetal },
  { id: 'rust', tileMeters: 2, hero: false, normalStrength: 2.5, colors: [[90, 90, 92]], glsl: rustyMetal },
  { id: 'diamond', tileMeters: 0.8, hero: false, normalStrength: 3.0, colors: [[120, 122, 126]], glsl: diamondPlate },
  { id: 'brick', tileMeters: 2, hero: false, normalStrength: 3.0, glsl: brick },
  { id: 'plasterCream', tileMeters: 2.5, hero: false, normalStrength: 1.5, colors: [[196, 186, 160], [120, 116, 108]], glsl: plasterPaint },
  { id: 'plasterGreen', tileMeters: 2.5, hero: false, normalStrength: 1.5, colors: [[58, 86, 72], [120, 116, 108]], seed: 9, glsl: plasterPaint },
  { id: 'wood', tileMeters: 1, hero: false, normalStrength: 2.0, colors: [[150, 112, 72], [96, 66, 40]], params: [0.6, 0, 0, 0], glsl: woodPlanks },
  // weathered outdoor planks: gray-brown, sun and rain have taken the color out
  { id: 'deck', tileMeters: 1.2, hero: false, normalStrength: 2.2, colors: [[122, 112, 98], [72, 64, 54]], params: [0.6, 0, 0, 0], seed: 5, glsl: woodPlanks },
  { id: 'hazard', tileMeters: 1, hero: false, normalStrength: 1.2, colors: [[110, 110, 112]], params: [1, 0, 0, 0], glsl: hazard },
  { id: 'gunSteel', tileMeters: 0.25, hero: true, normalStrength: 1.0, colors: [[52, 53, 56]], params: [0.25, 0, 0, 0], glsl: gunSteel },
  { id: 'gunPolymer', tileMeters: 0.15, hero: true, normalStrength: 1.5, colors: [[30, 31, 33]], params: [90, 0.3, 0, 0], glsl: gunPolymer },
  { id: 'gunPolymerTan', tileMeters: 0.15, hero: false, normalStrength: 1.5, colors: [[150, 124, 92]], params: [90, 0.3, 0, 0], seed: 3, glsl: gunPolymer },
  { id: 'gunGrip', tileMeters: 0.08, hero: false, normalStrength: 2.5, colors: [[28, 29, 31]], params: [60, 1.0, 0, 0], seed: 5, glsl: gunPolymer },
  { id: 'gunAlu', tileMeters: 0.3, hero: true, normalStrength: 0.8, colors: [[44, 45, 48]], glsl: gunAlu },
  { id: 'gunAluTan', tileMeters: 0.3, hero: false, normalStrength: 0.8, colors: [[140, 116, 84]], seed: 2, glsl: gunAlu },
  { id: 'gunWood', tileMeters: 0.4, hero: false, normalStrength: 1.2, colors: [[110, 58, 30], [60, 30, 16]], params: [0, 1, 1, 0], seed: 8, glsl: woodPlanks },
  // first-person sleeves, matched to the two soldier skins (black-and-red, tan woodland camo)
  { id: 'sleeveRed', tileMeters: 0.6, hero: false, normalStrength: 1.2, colors: [[50, 50, 52], [32, 32, 34], [74, 72, 72], [118, 26, 28]], params: [1, 0, 0, 0], seed: 7, glsl: fabricCamo },
  { id: 'sleeveCamo', tileMeters: 0.6, hero: false, normalStrength: 1.2, colors: [[146, 124, 88], [112, 96, 66], [172, 152, 114], [84, 72, 50]], params: [1, 0, 0, 0], seed: 9, glsl: fabricCamo },
  { id: 'armor', tileMeters: 0.5, hero: false, normalStrength: 1.0, colors: [[78, 82, 74]], glsl: armorPlastic },
  { id: 'rubber', tileMeters: 0.3, hero: false, normalStrength: 1.0, colors: [[24, 24, 25]], glsl: rubber },
  { id: 'tape', tileMeters: 0.25, hero: false, normalStrength: 1.0, colors: [[205, 203, 196]], glsl: tape },
  { id: 'paper', tileMeters: 0.3, hero: false, normalStrength: 1.0, colors: [[214, 210, 196]], glsl: paper },
  { id: 'mattress', tileMeters: 1, hero: false, normalStrength: 1.0, colors: [[190, 184, 166], [70, 90, 120]], glsl: mattress },
  { id: 'leather', tileMeters: 0.25, hero: false, normalStrength: 0.7, colors: [[38, 34, 31]], glsl: leather },
  // outdoor maps
  { id: 'jungleFloor', tileMeters: 3.0, hero: true, normalStrength: 1.4, colors: [[62, 50, 37], [114, 90, 58], [82, 88, 50], [68, 92, 46]], glsl: jungleFloor },
  { id: 'mud', tileMeters: 3.0, hero: true, normalStrength: 1.3, colors: [[58, 44, 32], [82, 64, 46]], glsl: mud },
  { id: 'bark', tileMeters: 1.6, hero: false, normalStrength: 1.6, colors: [[86, 78, 66], [118, 124, 102], [56, 76, 38]], glsl: bark },
  { id: 'palmBark', tileMeters: 1.2, hero: false, normalStrength: 1.3, colors: [[104, 92, 76], [70, 74, 56]], glsl: palmBark },
  { id: 'canvas', tileMeters: 1.0, hero: false, normalStrength: 0.9, colors: [[118, 114, 86]], glsl: canvas },
  { id: 'corrugated', tileMeters: 1.0, hero: false, normalStrength: 1.4, colors: [[205, 205, 200], [118, 64, 36]], glsl: corrugated },
  { id: 'sandbag', tileMeters: 0.6, hero: false, normalStrength: 1.1, colors: [[150, 132, 98], [78, 64, 46]], glsl: sandbag },
  { id: 'chrome', tileMeters: 0.5, hero: false, normalStrength: 0.6, colors: [[196, 200, 204]], params: [0.12, 0, 0, 0], glsl: brushedMetal },
  { id: 'brass', tileMeters: 0.2, hero: false, normalStrength: 0.6, colors: [[204, 160, 84]], params: [0.22, 0, 0, 0], seed: 3, glsl: brushedMetal },
  { id: 'ceramic', tileMeters: 0.8, hero: false, normalStrength: 0.8, colors: [[232, 228, 218], [140, 128, 98]], glsl: ceramic },
];
