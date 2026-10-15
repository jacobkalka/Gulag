import * as THREE from 'three';
import type { PlayerState } from '@/game/sim/types';
import { kelvinColor } from './lighting/lightKinds';

// Weapon-mounted flashlights. The local player's is a real shadow-casting spotlight with a lens
// cookie; other players' flashlights are lit by a small pool of spotlights (nearest first) and
// always show a visible beam and a lens glare, so you can see who is carrying a light.
// Light objects always exist (intensity 0 when off) so toggling never recompiles shaders.

const BEAM_VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  vLocal = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGain;
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  float along = clamp(-vLocal.z, 0.0, 1.0);
  vec3 axis = normalize((modelMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
  vec3 apex = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 n = normalize(vWorld - (apex + axis * dot(vWorld - apex, axis)));
  vec3 v = normalize(cameraPosition - vWorld);
  float edge = pow(abs(dot(n, v)), 2.0);
  float fall = pow(1.0 - along, 2.2) * smoothstep(0.0, 0.03, along);
  gl_FragColor = vec4(uColor * edge * fall * uGain, 1.0);
}`;

function cookieTexture(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  // hotspot, a faint reflector ring and soft spill
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.3, 'rgba(210,210,210,0.55)');
  grad.addColorStop(0.42, 'rgba(255,255,255,0.62)');
  grad.addColorStop(0.5, 'rgba(150,150,150,0.3)');
  grad.addColorStop(0.85, 'rgba(60,60,60,0.12)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Beam {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
}

export class Flashlights {
  readonly group = new THREE.Group();
  readonly local: THREE.SpotLight;
  private remote: THREE.SpotLight[] = [];
  private beams: Beam[] = [];
  private glare: THREE.Sprite[] = [];
  private color = kelvinColor(5600);
  private localOn = 0;

  constructor(opts: { shadowSize: number; shadows: boolean; remoteLights: number }) {
    const cookie = cookieTexture();
    this.local = new THREE.SpotLight(this.color, 0, 30, 0.34, 0.5, 2);
    this.local.map = cookie;
    this.local.castShadow = opts.shadows;
    this.local.shadow.mapSize.set(opts.shadowSize, opts.shadowSize);
    this.local.shadow.bias = -0.0003;
    this.local.shadow.normalBias = 0.02;
    this.local.shadow.camera.near = 0.2;
    this.local.shadow.camera.far = 30;
    this.group.add(this.local, this.local.target);
    for (let i = 0; i < opts.remoteLights; i++) {
      const s = new THREE.SpotLight(this.color, 0, 26, 0.34, 0.5, 2);
      s.map = cookie;
      this.remote.push(s);
      this.group.add(s, s.target);
    }
    const cone = new THREE.ConeGeometry(1, 1, 20, 1, true);
    cone.translate(0, -0.5, 0);
    cone.rotateX(-Math.PI / 2); // apex at origin, opening toward -Z
    const glareTex = (() => {
      const S = 128;
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d')!;
      const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.15, 'rgba(255,255,255,0.6)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, S, S);
      // thin horizontal streak
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(0, S / 2 - 1, S, 2);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms: { uColor: { value: this.color.clone() }, uGain: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(cone, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      mesh.name = 'fx:flashlightBeam';
      this.group.add(mesh);
      this.beams.push({ mesh, mat });
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glareTex, color: this.color.clone().multiplyScalar(2.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      sp.visible = false;
      sp.renderOrder = 7;
      this.group.add(sp);
      this.glare.push(sp);
    }
  }

  /**
   * Local flashlight from the camera (weapon-mounted: slightly right/below the eye, aimed at the
   * crosshair 12 m out). `on` fades the light in/out over a few frames.
   */
  updateLocal(cam: THREE.Camera, on: boolean, dt: number): void {
    this.localOn += ((on ? 1 : 0) - this.localOn) * Math.min(1, dt * 25);
    const q = cam.quaternion;
    const p = new THREE.Vector3(0.14, -0.16, -0.35).applyQuaternion(q).add(cam.position);
    const aim = new THREE.Vector3(0, 0, -12).applyQuaternion(q).add(cam.position);
    this.local.position.copy(p);
    this.local.target.position.copy(aim);
    this.local.target.updateMatrixWorld();
    this.local.intensity = 70 * this.localOn;
  }

  /** Remote players' lights, beams and glare (pose gives eye position and aim). */
  updateRemote(players: { p: PlayerState; eye: THREE.Vector3; yaw: number; pitch: number }[], cam: THREE.Camera): void {
    const on = players.filter((r) => r.p.flashlight && r.p.alive);
    on.sort((a, b) => a.eye.distanceToSquared(cam.position) - b.eye.distanceToSquared(cam.position));
    const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    for (let i = 0; i < this.remote.length; i++) {
      const L = this.remote[i];
      const r = on[i];
      if (!r) {
        L.intensity = 0;
        continue;
      }
      const f = dirOf(r.yaw, r.pitch);
      L.position.copy(r.eye).addScaledVector(f, 0.45);
      L.target.position.copy(r.eye).addScaledVector(f, 12);
      L.target.updateMatrixWorld();
      L.intensity = 60;
    }
    for (let i = 0; i < this.beams.length; i++) {
      const b = this.beams[i];
      const g = this.glare[i];
      const r = on[i];
      if (!r) {
        b.mesh.visible = false;
        g.visible = false;
        continue;
      }
      const f = dirOf(r.yaw, r.pitch);
      const origin = r.eye.clone().addScaledVector(f, 0.45);
      b.mesh.visible = true;
      b.mesh.position.copy(origin);
      b.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), f);
      b.mesh.scale.set(Math.tan(0.3) * 9, Math.tan(0.3) * 9, 9);
      b.mat.uniforms.uGain.value = 0.16;
      // lens glare when the beam points at the viewer
      const toCam = cam.position.clone().sub(origin).normalize();
      const facing = Math.max(0, f.dot(toCam));
      g.visible = facing > 0.6 && camDir.dot(toCam) < 0;
      g.position.copy(origin);
      const s = 0.25 + 0.9 * Math.pow(facing, 6);
      g.scale.set(s * 1.6, s, 1);
      g.material.opacity = Math.pow(facing, 4);
    }
  }
}

function dirOf(yaw: number, pitch: number): THREE.Vector3 {
  return new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}
