import type * as THREE from 'three';
import type { Renderer } from '@/engine/Renderer';

// `?perf` overlay: FPS, frame time (interval and CPU work), draw calls, triangles, active shadow
// lights, GPU memory (geometries, textures, programs) and the JS heap, plus a frame-time graph.
// Plain DOM, refreshed four times a second so it costs next to nothing.

const W = 160;
const H = 36;

export class PerfOverlay {
  private el: HTMLDivElement;
  private text: HTMLPreElement;
  private graph: CanvasRenderingContext2D;
  private intervals: number[] = [];
  private cpu: number[] = [];
  private history: number[] = [];
  private lastShow = 0;

  constructor(parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'perf-overlay';
    Object.assign(this.el.style, {
      position: 'fixed',
      left: '8px',
      top: '8px',
      zIndex: '9999',
      padding: '6px 8px',
      background: 'rgba(0,0,0,0.72)',
      color: '#cfe8d0',
      font: '11px/1.35 ui-monospace, Menlo, Consolas, monospace',
      pointerEvents: 'none',
      borderRadius: '4px',
    } satisfies Partial<CSSStyleDeclaration>);
    this.text = document.createElement('pre');
    this.text.style.margin = '0 0 4px';
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    this.graph = c.getContext('2d')!;
    this.el.append(this.text, c);
    parent.appendChild(this.el);
  }

  /** Call once per frame after rendering: `interval` = time since the last frame, `cpu` = loop work. */
  frame(intervalMs: number, cpuMs: number, renderer: Renderer): void {
    this.intervals.push(intervalMs);
    this.cpu.push(cpuMs);
    this.history.push(intervalMs);
    if (this.history.length > W) this.history.shift();
    const now = performance.now();
    if (now - this.lastShow < 250) return;
    this.lastShow = now;
    const n = this.intervals.length;
    const avg = this.intervals.reduce((a, b) => a + b, 0) / n;
    const worst = Math.max(...this.intervals);
    const cpuAvg = this.cpu.reduce((a, b) => a + b, 0) / n;
    this.intervals = [];
    this.cpu = [];
    const gl = renderer.gl;
    const info = gl.info;
    let shadowLights = 0;
    let lights = 0;
    for (const sc of renderer.activeScenes()) {
      sc.traverseVisible((o) => {
        const l = o as THREE.Light;
        if (!l.isLight || l.intensity <= 0) return;
        lights++;
        if (l.castShadow) shadowLights++;
      });
    }
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    const px = gl.getPixelRatio();
    const cv = gl.domElement;
    this.text.textContent = [
      `FPS ${(1000 / avg).toFixed(0).padStart(4)}   frame ${avg.toFixed(1)} ms (worst ${worst.toFixed(1)})`,
      `CPU ${cpuAvg.toFixed(1)} ms   ${cv.width}x${cv.height} @${px.toFixed(2)}`,
      `draw calls ${info.render.calls}   tris ${(info.render.triangles / 1000).toFixed(1)}k`,
      `lights ${lights}   shadow lights ${shadowLights}`,
      `geometries ${info.memory.geometries}   textures ${info.memory.textures}   programs ${info.programs?.length ?? 0}`,
      heap ? `JS heap ${(heap / 1048576).toFixed(0)} MB` : 'JS heap n/a',
    ].join('\n');
    this.draw();
  }

  private draw(): void {
    const g = this.graph;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, 0, W, H);
    // guide lines at 60 and 30 FPS (graph spans 0-50 ms)
    const y = (ms: number) => H - Math.min(H, (ms / 50) * H);
    g.fillStyle = 'rgba(120,200,120,0.6)';
    g.fillRect(0, y(16.7), W, 1);
    g.fillStyle = 'rgba(220,160,80,0.6)';
    g.fillRect(0, y(33.3), W, 1);
    this.history.forEach((ms, i) => {
      g.fillStyle = ms > 33.3 ? '#e0604a' : ms > 17.5 ? '#e0b04a' : '#7fd07f';
      g.fillRect(W - this.history.length + i, y(ms), 1, H - y(ms));
    });
  }

  dispose(): void {
    this.el.remove();
  }
}
