import * as THREE from 'three';

// Global tweaks to three.js' built-in shader chunks, applied once before any material compiles.
//
// 1. Diffuse image-based light is scaled way down. The reflection probe is baked from a lit room,
//    so its diffuse term acts as a flat, even ambient that kills contrast. Indirect diffuse now
//    comes from the baked light-probe grid (colored, position dependent); the probe keeps
//    providing specular reflections for wet floors, metal and glass.
// 2. Fog becomes colored haze: inside a probe grid it picks up the color and strength of the
//    lights around the shaded point, so lamps visibly glow in the air.
// 3. Local reflection occlusion: the one reflection probe is captured in a lit spot, so in a dark
//    corner its reflections would make armor, visors and guns glint as if lit. Inside a probe grid
//    reflections are scaled by how much light actually reaches the point, so whatever stands in
//    the dark stays dark.

/** Fraction of the environment map's diffuse light that is kept. */
export const IBL_DIFFUSE = 0.06;
/** How strongly nearby light colors the fog (multiplies probe irradiance). */
export const HAZE_GAIN = 0.05;
/**
 * Probe irradiance (luminance) at which reflections reach full strength: about what the baked
 * grid gives at the reflection probe's capture point (Sublevel 9 drain: 0.145).
 */
export const ENV_OCC_REF = 0.14;
/** Reflections never drop below this fraction (keeps a hint of gloss on wet floors). */
export const ENV_OCC_MIN = 0.03;

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

  const spec = 'radiance += iblRadiance;';
  const coat = 'clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );';
  if (C.lights_fragment_maps.includes(spec) && C.lights_fragment_maps.includes(coat)) {
    C.lights_fragment_maps = C.lights_fragment_maps.replace(
      spec,
      `float envOcc = 1.0;
	#if defined( USE_LIGHT_PROBES_GRID ) && defined( RE_IndirectDiffuse )
		envOcc = clamp( dot( irradiance, vec3( 0.2126, 0.7152, 0.0722 ) ) / ${ENV_OCC_REF.toFixed(4)}, ${ENV_OCC_MIN.toFixed(4)}, 1.0 );
	#endif
	radiance += iblRadiance * envOcc;`,
    );
    C.lights_fragment_maps = C.lights_fragment_maps.replace(coat, coat.replace(');', ') * envOcc;'));
  } else console.warn('shaderPatches: IBL specular chunk changed, reflection occlusion disabled');
}
