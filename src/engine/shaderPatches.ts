import * as THREE from 'three';

// Global tweaks to three.js' built-in shader chunks, applied once before any material compiles.
//
// 1. Diffuse image-based light is scaled way down. The reflection probe is baked from a lit room,
//    so its diffuse term acts as a flat, even ambient that kills contrast. Indirect diffuse now
//    comes from the baked light-probe grid (colored, position dependent); the probe keeps
//    providing specular reflections for wet floors, metal and glass.
// 2. Fog becomes colored haze: inside a probe grid it picks up the color and strength of the
//    lights around the shaded point, so lamps visibly glow in the air.

/** Fraction of the environment map's diffuse light that is kept. */
export const IBL_DIFFUSE = 0.06;
/** How strongly nearby light colors the fog (multiplies probe irradiance). */
export const HAZE_GAIN = 0.05;

let patched = false;

export function applyShaderPatches(): void {
  if (patched) return;
  patched = true;
  const C = THREE.ShaderChunk as Record<string, string>;

  const ibl = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
  if (C.lights_fragment_maps.includes(ibl)) {
    C.lights_fragment_maps = C.lights_fragment_maps.replace(ibl, `iblIrradiance += getIBLIrradiance( geometryNormal ) * ${IBL_DIFFUSE.toFixed(4)};`);
  } else console.warn('shaderPatches: IBL chunk changed, diffuse IBL not scaled');

  const fogMix = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
  if (C.fog_fragment.includes(fogMix)) {
    C.fog_fragment = C.fog_fragment.replace(
      fogMix,
      `vec3 hazeColor = fogColor;
	#if defined( USE_LIGHT_PROBES_GRID ) && defined( RE_IndirectDiffuse )
		vec3 hazeView = normalize( cameraPosition - probeWorldPos );
		hazeColor += getLightProbeGridIrradiance( probeWorldPos, hazeView ) * ${HAZE_GAIN.toFixed(4)};
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, hazeColor, fogFactor );`,
    );
  } else console.warn('shaderPatches: fog chunk changed, haze disabled');
}
