import * as THREE from 'three';

/**
 * Renders the scene into a cubemap from `pos` and prefilters it (PMREM) for image-based
 * lighting. Used for wet-floor / metal reflections and as ambient light for dynamic objects.
 */
export function bakeReflectionProbe(gl: THREE.WebGLRenderer, scene: THREE.Scene, pos: THREE.Vector3, size: number): THREE.Texture {
  const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cam = new THREE.CubeCamera(0.05, 120, rt);
  cam.position.copy(pos);
  scene.add(cam);
  const prevTarget = gl.getRenderTarget();
  cam.update(gl, scene);
  scene.remove(cam);
  const pmrem = new THREE.PMREMGenerator(gl);
  const env = pmrem.fromCubemap(rt.texture).texture;
  pmrem.dispose();
  rt.dispose();
  gl.setRenderTarget(prevTarget);
  return env;
}
