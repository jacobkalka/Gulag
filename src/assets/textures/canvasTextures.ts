import * as THREE from 'three';

// Small 2D-canvas generated textures: sight reticles, stencil signage and graffiti decals.

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function toTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export type ReticleStyle = 'holo' | 'dot' | 'chevron' | 'scope';

/** Emissive reticle (white on black, tinted by the material color, drawn additively). */
export function reticleTexture(style: ReticleStyle): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.translate(S / 2, S / 2);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.shadowColor = '#fff';
  g.shadowBlur = 6;
  if (style === 'holo') {
    g.lineWidth = 7;
    g.beginPath();
    g.arc(0, 0, 78, 0, Math.PI * 2);
    g.stroke();
    for (let i = 0; i < 4; i++) {
      g.save();
      g.rotate((i * Math.PI) / 2);
      g.fillRect(-3, -96, 6, 18);
      g.restore();
    }
    g.beginPath();
    g.arc(0, 0, 9, 0, Math.PI * 2);
    g.fill();
  } else if (style === 'dot') {
    g.beginPath();
    g.arc(0, 0, 14, 0, Math.PI * 2);
    g.fill();
  } else if (style === 'chevron') {
    g.lineWidth = 9;
    g.lineJoin = 'miter';
    g.beginPath();
    g.moveTo(-36, 34);
    g.lineTo(0, -4);
    g.lineTo(36, 34);
    g.stroke();
    g.fillRect(-2, 50, 4, 30);
  } else {
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(-128, 0);
    g.lineTo(-12, 0);
    g.moveTo(12, 0);
    g.lineTo(128, 0);
    g.moveTo(0, 12);
    g.lineTo(0, 128);
    g.stroke();
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(-128, 0);
    g.lineTo(-60, 0);
    g.moveTo(60, 0);
    g.lineTo(128, 0);
    g.moveTo(0, 60);
    g.lineTo(0, 128);
    g.stroke();
    g.beginPath();
    g.arc(0, 0, 3, 0, Math.PI * 2);
    g.fill();
  }
  return toTexture(c);
}

export interface DecalSpec {
  text: string;
  font?: string;
  color: string;
  bg?: string;
  stencil?: boolean;
  spray?: boolean;
  w?: number;
  h?: number;
  rotate?: number;
  arrow?: 'left' | 'right' | 'up' | null;
}

/** Stenciled sign or sprayed graffiti on a transparent background. */
export function decalTexture(spec: DecalSpec): THREE.Texture {
  const W = spec.w ?? 512;
  const H = spec.h ?? 256;
  const [c, g] = canvas(W, H);
  g.clearRect(0, 0, W, H);
  if (spec.bg) {
    g.fillStyle = spec.bg;
    g.fillRect(0, 0, W, H);
  }
  g.save();
  g.translate(W / 2, H / 2);
  g.rotate(spec.rotate ?? 0);
  const font = spec.font ?? `900 ${Math.floor(H * 0.42)}px "Big Shoulders Stencil Display", "Arial Black", Impact, sans-serif`;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = spec.text.split('\n');
  const lh = H / (lines.length + 0.6);
  const y0 = -((lines.length - 1) * lh) / 2;
  if (spec.spray) {
    // Overspray halo, then core strokes, then drips.
    g.fillStyle = spec.color;
    g.shadowColor = spec.color;
    g.shadowBlur = 18;
    g.globalAlpha = 0.35;
    lines.forEach((l, i) => g.fillText(l, 0, y0 + i * lh));
    g.shadowBlur = 4;
    g.globalAlpha = 0.95;
    lines.forEach((l, i) => g.fillText(l, 0, y0 + i * lh));
    g.globalAlpha = 0.8;
    g.shadowBlur = 0;
    const m = g.measureText(lines[0]);
    for (let i = 0; i < 9; i++) {
      const x = (Math.random() - 0.5) * m.width * 0.9;
      const y = y0 + lh * 0.25;
      const len = 10 + Math.random() * 50;
      g.fillRect(x, y, 2 + Math.random() * 2, len);
      g.beginPath();
      g.arc(x + 1.5, y + len, 2.4, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    g.fillStyle = spec.color;
    lines.forEach((l, i) => g.fillText(l, 0, y0 + i * lh));
  }
  if (spec.arrow) {
    g.fillStyle = spec.color;
    const s = H * 0.22;
    const ax = spec.arrow === 'left' ? -W * 0.38 : spec.arrow === 'right' ? W * 0.38 : 0;
    const ay = spec.arrow === 'up' ? -H * 0.32 : 0;
    g.save();
    g.translate(ax, ay);
    g.rotate(spec.arrow === 'left' ? Math.PI : spec.arrow === 'up' ? -Math.PI / 2 : 0);
    g.beginPath();
    g.moveTo(s, 0);
    g.lineTo(-s * 0.2, -s * 0.8);
    g.lineTo(-s * 0.2, -s * 0.3);
    g.lineTo(-s, -s * 0.3);
    g.lineTo(-s, s * 0.3);
    g.lineTo(-s * 0.2, s * 0.3);
    g.lineTo(-s * 0.2, s * 0.8);
    g.closePath();
    g.fill();
    g.restore();
  }
  g.restore();
  // Weathering: knock out random specks so paint looks worn.
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const px = (i / 4) % W;
    const py = Math.floor(i / 4 / W);
    const n = Math.sin(px * 0.31 + py * 0.17) * Math.sin(px * 0.053 - py * 0.091) + Math.random() * 0.9;
    if (n > 1.05) d[i + 3] = 0;
    else d[i + 3] = Math.floor(d[i + 3] * (0.75 + Math.random() * 0.25));
  }
  g.putImageData(img, 0, 0);
  return toTexture(c);
}

/** Soft radial sprite (glows, light cards, particles). */
export function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 128): THREE.Texture {
  const [c, g] = canvas(size, size);
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return toTexture(c);
}

/** Vertical gradient used for volumetric light shafts (bright at top, fading down and at the sides). */
export function shaftTexture(): THREE.Texture {
  const W = 64;
  const H = 256;
  const [c, g] = canvas(W, H);
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const v = y / (H - 1);
      const side = Math.pow(Math.sin(u * Math.PI), 1.6);
      const fall = Math.pow(1 - v, 1.4) * 0.85 + 0.15 * (1 - v);
      const streak = 0.75 + 0.25 * Math.sin(u * 40 + Math.sin(u * 13) * 3);
      const a = side * fall * streak;
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.floor(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return toTexture(c, false);
}
