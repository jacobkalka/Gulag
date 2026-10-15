import * as THREE from 'three';

// Shader add-on for architecture materials (walls, floors, tiles, paint, metal plate):
//
// 1. Macro variation: low-frequency world-space noise nudges albedo and roughness so a texture
//    that repeats every 2-3 m stops reading as a grid on long walls and big floors.
// 2. Wetness: a top-down mask over the map (puddles, rain under sky openings, leaks) darkens
//    upward-facing surfaces, makes them glossy and fills small bumps, so wet floors read as wet
//    and pick up the lights as sharp highlights.
//
// The uniforms are shared by every patched material; the active MapView binds its own mask each
// frame (see bindWetMask), so the menu scene and a match can use different maps.

export interface WetMask {
  texture: THREE.Texture;
  /** minX, minZ, 1/sizeX, 1/sizeZ of the area the mask covers. */
  bounds: THREE.Vector4;
  /** Wetness only below this world height (keeps upper floors dry over a wet ground floor). */
  maxY: number;
}

const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
blank.needsUpdate = true;

const U = {
  uWetMap: { value: blank as THREE.Texture },
  uWetBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
  uWetMaxY: { value: -1e9 },
  uMacroAmount: { value: 1 },
};

/** Makes this mask the one every patched material samples (call each frame from the active view). */
export function bindWetMask(mask: WetMask | null): void {
  if (!mask) {
    U.uWetMap.value = blank;
    U.uWetMaxY.value = -1e9;
    return;
  }
  U.uWetMap.value = mask.texture;
  U.uWetBounds.value.copy(mask.bounds);
  U.uWetMaxY.value = mask.maxY;
}

const VERT_DECL = /* glsl */ `
varying vec3 vSfxPos;
varying float vSfxUp;`;

const VERT_MAIN = /* glsl */ `
  {
    vec4 sfxP = vec4( transformed, 1.0 );
    vec3 sfxN = objectNormal;
    #ifdef USE_INSTANCING
      sfxP = instanceMatrix * sfxP;
      sfxN = mat3( instanceMatrix ) * sfxN;
    #endif
    sfxP = modelMatrix * sfxP;
    vSfxPos = sfxP.xyz;
    vSfxUp = normalize( mat3( modelMatrix ) * sfxN ).y;
  }`;

const FRAG_DECL = /* glsl */ `
varying vec3 vSfxPos;
varying float vSfxUp;
uniform sampler2D uWetMap;
uniform vec4 uWetBounds;
uniform float uWetMaxY;
uniform float uMacroAmount;
float sfxHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float sfxNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( sfxHash( i ), sfxHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( sfxHash( i + vec2( 0.0, 1.0 ) ), sfxHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}`;

// after map_fragment: wetness + macro tint on the albedo
const FRAG_ALBEDO = /* glsl */ `
  // floors use the XZ plane, walls run along X+Z and up Y
  vec2 sfxUv = abs( vSfxUp ) > 0.5 ? vSfxPos.xz : vec2( vSfxPos.x + vSfxPos.z, vSfxPos.y );
  float sfxMacro = sfxNoise( sfxUv * 0.31 ) * 0.62 + sfxNoise( sfxUv * 1.17 + 7.3 ) * 0.38;
  diffuseColor.rgb *= mix( 1.0, mix( 0.84, 1.1, sfxMacro ), uMacroAmount );
  float sfxWet = texture2D( uWetMap, ( vSfxPos.xz - uWetBounds.xy ) * uWetBounds.zw ).r;
  sfxWet *= smoothstep( 0.55, 0.9, vSfxUp ) * step( vSfxPos.y, uWetMaxY );
  sfxWet = smoothstep( 0.22, 0.72, sfxWet + ( sfxNoise( vSfxPos.xz * 2.7 ) - 0.5 ) * 0.36 );
  diffuseColor.rgb *= mix( 1.0, 0.58, sfxWet );`;

// after roughnessmap_fragment
const FRAG_ROUGH = /* glsl */ `
  roughnessFactor *= mix( 1.0, mix( 0.92, 1.08, sfxMacro ), uMacroAmount );
  roughnessFactor = mix( roughnessFactor, 0.07, sfxWet );`;

// after normal_fragment_maps: standing water fills the bumps
const FRAG_NORMAL = /* glsl */ `
  normal = normalize( mix( normal, nonPerturbedNormal, sfxWet * 0.75 ) );`;

function inject(src: string, anchor: string, code: string, after = true): string {
  if (!src.includes(anchor)) {
    console.warn(`surfaceFx: anchor ${anchor} missing`);
    return src;
  }
  return src.replace(anchor, after ? `${anchor}\n${code}` : `${code}\n${anchor}`);
}

/** Adds macro variation and wetness to a library material (idempotent). */
export function applySurfaceFx(mat: THREE.MeshStandardMaterial): void {
  if (mat.userData.surfaceFx) return;
  mat.userData.surfaceFx = true;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = inject(sh.vertexShader, '#include <common>', VERT_DECL);
    sh.vertexShader = inject(sh.vertexShader, '#include <worldpos_vertex>', VERT_MAIN);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <common>', FRAG_DECL);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <map_fragment>', FRAG_ALBEDO);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <roughnessmap_fragment>', FRAG_ROUGH);
    sh.fragmentShader = inject(sh.fragmentShader, '#include <normal_fragment_maps>', FRAG_NORMAL);
  };
  mat.customProgramCacheKey = () => 'surfaceFx1';
  mat.needsUpdate = true;
}

/** Wet patch sources for a map's mask. */
export interface WetSource {
  x: number;
  z: number;
  /** Radius of the fully wet core (m). */
  r: number;
  /** Extra soft falloff beyond the core (m). */
  soft: number;
  /** 0..1 */
  wet: number;
}

/**
 * Rasterizes wet sources (discs) and wet rectangles into a top-down mask, 4 texels per meter.
 */
export function buildWetMask(
  bounds: { min: [number, number, number]; max: [number, number, number] },
  discs: WetSource[],
  rects: { min: [number, number]; max: [number, number]; wet: number; soft: number }[],
  maxY: number,
): WetMask {
  const ppm = 4;
  const x0 = bounds.min[0];
  const z0 = bounds.min[2];
  const sx = bounds.max[0] - x0;
  const sz = bounds.max[2] - z0;
  const W = Math.max(4, Math.ceil(sx * ppm));
  const H = Math.max(4, Math.ceil(sz * ppm));
  const data = new Uint8Array(W * H * 4);
  const field = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const z = z0 + ((j + 0.5) / H) * sz;
    for (let i = 0; i < W; i++) {
      const x = x0 + ((i + 0.5) / W) * sx;
      let w = 0;
      for (const d of discs) {
        const dist = Math.hypot(x - d.x, z - d.z);
        if (dist > d.r + d.soft) continue;
        const t = dist <= d.r ? 1 : 1 - (dist - d.r) / d.soft;
        w = Math.max(w, d.wet * t * t * (3 - 2 * t));
      }
      for (const r of rects) {
        const dx = Math.max(r.min[0] - x, 0, x - r.max[0]);
        const dz = Math.max(r.min[1] - z, 0, z - r.max[1]);
        const dist = Math.hypot(dx, dz);
        if (dist > r.soft) continue;
        const t = 1 - dist / Math.max(r.soft, 1e-3);
        w = Math.max(w, r.wet * t * t * (3 - 2 * t));
      }
      field[j * W + i] = w;
    }
  }
  for (let k = 0; k < W * H; k++) {
    data[k * 4] = Math.round(Math.min(1, field[k]) * 255);
    data[k * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  // row j covers world z0 + j/H: with flipY off, texture v = (z - z0) / sz
  tex.flipY = false;
  tex.needsUpdate = true;
  return { texture: tex, bounds: new THREE.Vector4(x0, z0, 1 / sx, 1 / sz), maxY };
}
