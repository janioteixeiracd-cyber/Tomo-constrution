import { fmt, orientationLabel } from '../core/math';
import type { Volume } from '../core/types';

export type Plane = 'axial' | 'coronal' | 'sagittal';
export type Tool = 'navegar' | 'janela' | 'regua' | 'densidade';

const PLANE_NAMES: Record<Plane, string> = { axial: 'Axial', coronal: 'Coronal', sagittal: 'Sagital' };

/** Estado compartilhado entre as três vistas. */
export class MprState {
  /** cursor em índices contínuos do volume (x, y, z) */
  cursor: [number, number, number];
  window = { center: 400, width: 2000 };
  tool: Tool = 'navegar';
  private listeners = new Set<() => void>();

  constructor(public volume: Volume) {
    this.cursor = [(volume.dims[0] - 1) / 2, (volume.dims[1] - 1) / 2, Math.floor((volume.dims[2] - 1) / 2)];
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  /** HU no ponto (x,y inteiros; z contínuo com interpolação linear). */
  sample(x: number, y: number, z: number): number {
    const v = this.volume;
    const [nx, ny, nz] = v.dims;
    const xi = Math.min(nx - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(ny - 1, Math.max(0, Math.round(y)));
    const zc = Math.min(nz - 1, Math.max(0, z));
    const z0 = Math.floor(zc);
    const z1 = Math.min(nz - 1, z0 + 1);
    const t = zc - z0;
    const plane = nx * ny;
    const a = v.data[z0 * plane + yi * nx + xi];
    if (t === 0) return a;
    return a + (v.data[z1 * plane + yi * nx + xi] - a) * t;
  }
}

interface Measurement {
  a: [number, number];
  b: [number, number];
}

/** Uma vista 2D (axial, coronal ou sagital) desenhada em canvas. */
export class MprView {
  readonly canvas: HTMLCanvasElement;
  readonly slider: HTMLInputElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  private off = document.createElement('canvas');
  private measurement: Measurement | null = null;
  private probe: { u: number; v: number; value: number } | null = null;
  private drag: { x: number; y: number; c: number; w: number } | null = null;
  hidePatient = true;
  patientLine = '';

  constructor(
    private host: HTMLElement,
    readonly plane: Plane,
    private state: MprState,
  ) {
    host.classList.add('mpr-view');
    host.innerHTML = `<div class="mpr-title">${PLANE_NAMES[plane]}</div><canvas></canvas><input type="range" class="mpr-slider" aria-label="Corte ${PLANE_NAMES[plane]}">`;
    this.canvas = host.querySelector('canvas')!;
    this.slider = host.querySelector('input')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.slider.addEventListener('input', () => {
      this.setSliceIndex(Number(this.slider.value));
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setSliceIndex(this.sliceIndex() + (e.deltaY > 0 ? 1 : -1));
    });
    this.canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.canvas.addEventListener('pointerup', () => this.pointerUp());
    this.canvas.addEventListener('pointercancel', () => this.pointerUp());
    new ResizeObserver(() => this.draw()).observe(host);
    state.onChange(() => this.render());
    this.render();
  }

  /** dimensões da imagem exibida e tamanho do pixel em mm */
  private geometry() {
    const v = this.state.volume;
    const [nx, ny, nz] = v.dims;
    const [sx, sy, sz] = v.spacing;
    if (this.plane === 'axial') return { w: nx, h: ny, pw: sx, ph: sy, slices: nz };
    const pxMm = this.plane === 'coronal' ? sx : sy;
    const h = Math.max(1, Math.round(((nz - 1) * sz) / pxMm) + 1);
    return this.plane === 'coronal'
      ? { w: nx, h, pw: sx, ph: ((nz - 1) * sz) / Math.max(1, h - 1) || sz, slices: ny }
      : { w: ny, h, pw: sy, ph: ((nz - 1) * sz) / Math.max(1, h - 1) || sz, slices: nx };
  }

  private sliceIndex() {
    const c = this.state.cursor;
    return Math.round(this.plane === 'axial' ? c[2] : this.plane === 'coronal' ? c[1] : c[0]);
  }

  private setSliceIndex(i: number) {
    const g = this.geometry();
    const k = Math.max(0, Math.min(g.slices - 1, i));
    const axis = this.plane === 'axial' ? 2 : this.plane === 'coronal' ? 1 : 0;
    if (Math.round(this.state.cursor[axis]) === k) return;
    this.state.cursor[axis] = k;
    this.measurement = null;
    this.state.emit();
  }

  /** (u, v) na imagem exibida → índices contínuos do volume */
  private toVolume(u: number, v: number): [number, number, number] {
    const vol = this.state.volume;
    const nz = vol.dims[2];
    const g = this.geometry();
    const c = this.state.cursor;
    if (this.plane === 'axial') return [u, v, Math.round(c[2])];
    const z = g.h > 1 ? ((g.h - 1 - v) / (g.h - 1)) * (nz - 1) : 0;
    return this.plane === 'coronal' ? [u, c[1], z] : [c[0], u, z];
  }

  private fromVolume(p: [number, number, number]): [number, number] {
    const nz = this.state.volume.dims[2];
    const g = this.geometry();
    if (this.plane === 'axial') return [p[0], p[1]];
    const v = nz > 1 ? g.h - 1 - (p[2] / (nz - 1)) * (g.h - 1) : 0;
    return this.plane === 'coronal' ? [p[0], v] : [p[1], v];
  }

  render() {
    const g = this.geometry();
    this.slider.min = '0';
    this.slider.max = String(g.slices - 1);
    this.slider.value = String(this.sliceIndex());
    if (!this.image || this.image.width !== g.w || this.image.height !== g.h) this.image = new ImageData(g.w, g.h);
    const px = this.image.data;
    const { center, width } = this.state.window;
    const lo = center - width / 2;
    const scale = 255 / Math.max(1, width);
    const vol = this.state.volume;
    const [nx, ny, nz] = vol.dims;
    const plane = nx * ny;
    const d = vol.data;
    const c = this.state.cursor;
    for (let v = 0; v < g.h; v++) {
      let rowBase0 = 0;
      let rowBase1 = 0;
      let t = 0;
      if (this.plane !== 'axial') {
        const z = g.h > 1 ? ((g.h - 1 - v) / (g.h - 1)) * (nz - 1) : 0;
        const z0 = Math.floor(z);
        const z1 = Math.min(nz - 1, z0 + 1);
        t = z - z0;
        rowBase0 = z0 * plane;
        rowBase1 = z1 * plane;
      }
      for (let u = 0; u < g.w; u++) {
        let val: number;
        if (this.plane === 'axial') {
          val = d[Math.round(c[2]) * plane + v * nx + u];
        } else {
          const idx = this.plane === 'coronal' ? Math.round(c[1]) * nx + u : u * nx + Math.round(c[0]);
          const a = d[rowBase0 + idx];
          val = t ? a + (d[rowBase1 + idx] - a) * t : a;
        }
        let gray = (val - lo) * scale;
        gray = gray < 0 ? 0 : gray > 255 ? 255 : gray;
        const o = (v * g.w + u) * 4;
        px[o] = px[o + 1] = px[o + 2] = gray;
        px[o + 3] = 255;
      }
    }
    this.off.width = g.w;
    this.off.height = g.h;
    this.off.getContext('2d')!.putImageData(this.image, 0, 0);
    this.draw();
  }

  /** transformação imagem → canvas (ajuste com proporção física preservada) */
  private layout() {
    const g = this.geometry();
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const physW = g.w * g.pw;
    const physH = g.h * g.ph;
    const s = Math.min(cw / physW, ch / physH);
    const dw = physW * s;
    const dh = physH * s;
    return { x0: (cw - dw) / 2, y0: (ch - dh) / 2, sx: dw / g.w, sy: dh / g.h, g };
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width * dpr));
    const H = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const L = this.layout();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, L.x0, L.y0, L.g.w * L.sx, L.g.h * L.sy);

    // linhas de referência dos outros planos
    const [cu, cv] = this.fromVolume(this.state.cursor);
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = 'rgba(80, 200, 255, 0.55)';
    ctx.beginPath();
    ctx.moveTo(L.x0 + (cu + 0.5) * L.sx, L.y0);
    ctx.lineTo(L.x0 + (cu + 0.5) * L.sx, L.y0 + L.g.h * L.sy);
    ctx.moveTo(L.x0, L.y0 + (cv + 0.5) * L.sy);
    ctx.lineTo(L.x0 + L.g.w * L.sx, L.y0 + (cv + 0.5) * L.sy);
    ctx.stroke();
    ctx.setLineDash([]);

    const font = 12 * dpr;
    ctx.font = `${font}px system-ui, sans-serif`;
    ctx.fillStyle = '#9fe870';
    ctx.textBaseline = 'middle';
    const [left, right, top, bottom] = this.edgeLabels();
    ctx.textAlign = 'left';
    ctx.fillText(left, 6 * dpr, H / 2);
    ctx.textAlign = 'right';
    ctx.fillText(right, W - 6 * dpr, H / 2);
    ctx.textAlign = 'center';
    ctx.fillText(top, W / 2, 30 * dpr);
    ctx.fillText(bottom, W / 2, H - 12 * dpr);

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const g = L.g;
    const lines = [
      `${PLANE_NAMES[this.plane]} ${this.sliceIndex() + 1}/${g.slices}`,
      `J/N: ${Math.round(this.state.window.center)} / ${Math.round(this.state.window.width)}`,
    ];
    if (!this.hidePatient && this.patientLine) lines.unshift(this.patientLine);
    lines.forEach((t, i) => ctx.fillText(t, 8 * dpr, H - 12 * dpr - (lines.length - 1 - i) * (font + 4 * dpr)));
    if (this.plane !== 'axial' && this.state.volume.spacing[2] > this.state.volume.spacing[0] * 2.5) {
      ctx.fillStyle = '#ffcf5c';
      ctx.textAlign = 'right';
      ctx.fillText('interpolado entre cortes', W - 8 * dpr, H - 12 * dpr);
    }

    if (this.measurement) {
      const { a, b } = this.measurement;
      const ax = L.x0 + (a[0] + 0.5) * L.sx;
      const ay = L.y0 + (a[1] + 0.5) * L.sy;
      const bx = L.x0 + (b[0] + 0.5) * L.sx;
      const by = L.y0 + (b[1] + 0.5) * L.sy;
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      const mm = Math.hypot((b[0] - a[0]) * g.pw, (b[1] - a[1]) * g.ph);
      this.label(`${fmt(mm, 1)} mm`, bx + 8 * dpr, by, '#ffd400');
    }
    if (this.probe) {
      const x = L.x0 + (this.probe.u + 0.5) * L.sx;
      const y = L.y0 + (this.probe.v + 0.5) * L.sy;
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      this.label(`${Math.round(this.probe.value)} HU`, x + 10 * dpr, y, '#ff6b6b');
    }
  }

  private label(text: string, x: number, y: number, color: string) {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.font = `${13 * dpr}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x - 4 * dpr, y - 10 * dpr, w + 8 * dpr, 20 * dpr);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  private edgeLabels(): [string, string, string, string] {
    const d = this.state.volume.direction;
    const row = [d[0], d[1], d[2]];
    const col = [d[3], d[4], d[5]];
    const nrm = [d[6], d[7], d[8]];
    const neg = (v: number[]) => v.map((x) => -x);
    const [h, vDown] = this.plane === 'axial' ? [row, col] : this.plane === 'coronal' ? [row, neg(nrm)] : [col, neg(nrm)];
    return [orientationLabel(neg(h)), orientationLabel(h), orientationLabel(neg(vDown)), orientationLabel(vDown)];
  }

  private eventToImage(e: PointerEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const L = this.layout();
    const x = (e.clientX - rect.left) * dpr;
    const y = (e.clientY - rect.top) * dpr;
    return [(x - L.x0) / L.sx - 0.5, (y - L.y0) / L.sy - 0.5];
  }

  private clampImage([u, v]: [number, number]): [number, number] {
    const g = this.geometry();
    return [Math.max(0, Math.min(g.w - 1, u)), Math.max(0, Math.min(g.h - 1, v))];
  }

  private pointerDown(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.clampImage(this.eventToImage(e));
    const tool = this.state.tool;
    if (tool === 'janela') {
      this.drag = { x: e.clientX, y: e.clientY, c: this.state.window.center, w: this.state.window.width };
    } else if (tool === 'regua') {
      this.measurement = { a: p, b: p };
      this.drag = { x: 0, y: 0, c: 0, w: 0 };
      this.draw();
    } else if (tool === 'densidade') {
      this.updateProbe(p);
      this.drag = { x: 0, y: 0, c: 0, w: 0 };
    } else {
      this.drag = { x: 0, y: 0, c: 0, w: 0 };
      this.moveCursor(p);
    }
  }

  private pointerMove(e: PointerEvent) {
    if (!this.drag) return;
    const p = this.clampImage(this.eventToImage(e));
    const tool = this.state.tool;
    if (tool === 'janela') {
      this.state.window.width = Math.max(1, this.drag.w + (e.clientX - this.drag.x) * 8);
      this.state.window.center = this.drag.c + (e.clientY - this.drag.y) * 4;
      this.state.emit();
    } else if (tool === 'regua' && this.measurement) {
      this.measurement.b = p;
      this.draw();
    } else if (tool === 'densidade') {
      this.updateProbe(p);
    } else {
      this.moveCursor(p);
    }
  }

  private pointerUp() {
    this.drag = null;
  }

  private updateProbe([u, v]: [number, number]) {
    const p = this.toVolume(Math.round(u), Math.round(v));
    this.probe = { u: Math.round(u), v: Math.round(v), value: this.state.sample(...p) };
    this.draw();
  }

  private moveCursor([u, v]: [number, number]) {
    const p = this.toVolume(u, v);
    const keep = this.plane === 'axial' ? 2 : this.plane === 'coronal' ? 1 : 0;
    for (let i = 0; i < 3; i++) if (i !== keep) this.state.cursor[i] = i === 2 ? Math.round(p[i]) : p[i];
    this.probe = null;
    this.state.emit();
  }

  /** marca esta vista como a principal (usada no modo de vista única) */
  setFocus() {
    this.host.parentElement?.querySelectorAll('.focus').forEach((el) => el.classList.remove('focus'));
    this.host.classList.add('focus');
  }

  clearAnnotations() {
    this.measurement = null;
    this.probe = null;
    this.draw();
  }

  snapshot(): string {
    return this.canvas.toDataURL('image/png');
  }
}
