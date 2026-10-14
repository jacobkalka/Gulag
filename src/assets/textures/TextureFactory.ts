import * as THREE from 'three';
import { NOISE_GLSL } from './noise.glsl';
import type { TextureRecipe } from './recipes';

export interface TextureSet {
  id: string;
  tileMeters: number;
  map: THREE.Texture;
  normalMap: THREE.Texture;
  ormMap: THREE.Texture;
  size: number;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const HEADER = /* glsl */ `
precision highp float;
precision highp int;
varying vec2 vUv;
uniform float uSeed;
uniform int uMode;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec4 uP0;
`;

const MAIN = /* glsl */ `
void main() {
  vec3 albedo; float height; float rough; float ao; float metal;
  surface(vUv, albedo, height, rough, ao, metal);
  if (uMode == 0) gl_FragColor = vec4(clamp(albedo, 0.0, 1.0), 1.0);
  else gl_FragColor = vec4(height, clamp(rough, 0.02, 1.0), clamp(ao, 0.0, 1.0), clamp(metal, 0.0, 1.0));
}`;

// Height (R of data RT) → tangent-space normal (OpenGL convention, +Y = +V).
const NORMAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uData;
uniform float uSize;
uniform float uStrength;
float H(ivec2 p) {
  int s = int(uSize);
  p = ivec2((p.x % s + s) % s, (p.y % s + s) % s);
  return texelFetch(uData, p, 0).r;
}
void main() {
  ivec2 p = ivec2(floor(vUv * uSize));
  float tl = H(p + ivec2(-1, 1)), t = H(p + ivec2(0, 1)), tr = H(p + ivec2(1, 1));
  float l = H(p + ivec2(-1, 0)), r = H(p + ivec2(1, 0));
  float bl = H(p + ivec2(-1, -1)), b = H(p + ivec2(0, -1)), br = H(p + ivec2(1, -1));
  // Sobel gradient in "height per texel", rescaled to "height per uv unit".
  float dx = ((tr + 2.0 * r + br) - (tl + 2.0 * l + bl)) / 8.0 * uSize;
  float dy = ((tl + 2.0 * t + tr) - (bl + 2.0 * b + br)) / 8.0 * uSize;
  float k = uStrength * 0.004;
  vec3 n = normalize(vec3(-dx * k, -dy * k, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`;

// Data RT → ORM (R = AO incl. height cavity, G = roughness, B = metalness).
const ORM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uData;
uniform float uSize;
vec4 D(ivec2 p) {
  int s = int(uSize);
  p = ivec2((p.x % s + s) % s, (p.y % s + s) % s);
  return texelFetch(uData, p, 0);
}
void main() {
  ivec2 p = ivec2(floor(vUv * uSize));
  vec4 c = D(p);
  // Cavity: how far this texel sits below its neighborhood average.
  float avg = 0.0;
  int r = int(max(2.0, uSize / 256.0));
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    ivec2 o = ivec2(round(vec2(cos(a), sin(a)) * float(r) * 2.0));
    avg += D(p + o).r;
  }
  avg /= 8.0;
  float cavity = clamp(1.0 - max(0.0, avg - c.r) * 4.0, 0.35, 1.0);
  gl_FragColor = vec4(clamp(c.b * cavity, 0.0, 1.0), c.g, c.a, 1.0);
}`;

function makeTarget(size: number, opts: { srgb?: boolean; half?: boolean; mips?: boolean; anisotropy?: number }) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: opts.half ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: !!opts.mips,
    minFilter: opts.mips ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter,
    magFilter: opts.mips ? THREE.LinearFilter : THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    anisotropy: opts.anisotropy ?? 1,
  });
  return rt;
}

function srgbVec(c?: [number, number, number]): THREE.Vector3 {
  return c ? new THREE.Vector3(c[0] / 255, c[1] / 255, c[2] / 255) : new THREE.Vector3(0.5, 0.5, 0.5);
}

/**
 * Generates seamless PBR texture sets on the GPU. Each recipe produces:
 *   map (sRGB albedo), normalMap (tangent space), ormMap (AO / roughness / metalness).
 */
export class TextureFactory {
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private targets: THREE.WebGLRenderTarget[] = [];
  readonly sets = new Map<string, TextureSet>();

  constructor(
    private gl: THREE.WebGLRenderer,
    private heroSize: number,
    private smallSize: number,
    private anisotropy: number,
  ) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  private draw(material: THREE.Material, target: THREE.WebGLRenderTarget): void {
    this.quad.material = material;
    this.gl.setRenderTarget(target);
    this.gl.render(this.scene, this.cam);
  }

  generate(recipe: TextureRecipe): TextureSet {
    const size = recipe.hero ? this.heroSize : this.smallSize;
    const prevTarget = this.gl.getRenderTarget();
    const prevAutoClear = this.gl.autoClear;
    this.gl.autoClear = false;

    const colors = recipe.colors ?? [];
    const surface = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: HEADER + NOISE_GLSL + recipe.glsl + MAIN,
      uniforms: {
        uSeed: { value: recipe.seed ?? 1 },
        uMode: { value: 0 },
        uC0: { value: srgbVec(colors[0]) },
        uC1: { value: srgbVec(colors[1]) },
        uC2: { value: srgbVec(colors[2]) },
        uC3: { value: srgbVec(colors[3]) },
        uP0: { value: new THREE.Vector4(...(recipe.params ?? [0, 0, 0, 0])) },
      },
      depthTest: false,
      depthWrite: false,
    });

    const albedoRT = makeTarget(size, { srgb: true, mips: true, anisotropy: this.anisotropy });
    const dataRT = makeTarget(size, { half: true });
    surface.uniforms.uMode.value = 0;
    this.draw(surface, albedoRT);
    surface.uniforms.uMode.value = 1;
    this.draw(surface, dataRT);

    const normalRT = makeTarget(size, { mips: true, anisotropy: this.anisotropy });
    const normalMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: NORMAL_FRAG,
      uniforms: { uData: { value: dataRT.texture }, uSize: { value: size }, uStrength: { value: recipe.normalStrength } },
      depthTest: false,
      depthWrite: false,
    });
    this.draw(normalMat, normalRT);

    const ormRT = makeTarget(size, { mips: true, anisotropy: this.anisotropy });
    const ormMat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: ORM_FRAG,
      uniforms: { uData: { value: dataRT.texture }, uSize: { value: size } },
      depthTest: false,
      depthWrite: false,
    });
    this.draw(ormMat, ormRT);

    this.gl.setRenderTarget(prevTarget);
    this.gl.autoClear = prevAutoClear;
    surface.dispose();
    normalMat.dispose();
    ormMat.dispose();
    dataRT.dispose();

    const rep = 1 / recipe.tileMeters;
    for (const t of [albedoRT.texture, normalRT.texture, ormRT.texture]) {
      t.repeat.set(rep, rep);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
    }
    this.targets.push(albedoRT, normalRT, ormRT);
    const set: TextureSet = {
      id: recipe.id,
      tileMeters: recipe.tileMeters,
      map: albedoRT.texture,
      normalMap: normalRT.texture,
      ormMap: ormRT.texture,
      size,
    };
    this.sets.set(recipe.id, set);
    return set;
  }

  async generateAll(recipes: TextureRecipe[], onProgress?: (done: number, total: number) => void): Promise<void> {
    let done = 0;
    for (const r of recipes) {
      this.generate(r);
      done++;
      onProgress?.(done, recipes.length);
      // Yield so the loading screen can repaint between heavy GPU jobs.
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  get(id: string): TextureSet {
    const s = this.sets.get(id);
    if (!s) throw new Error(`Texture set '${id}' not generated`);
    return s;
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.targets = [];
    this.sets.clear();
    this.quad.geometry.dispose();
  }
}
