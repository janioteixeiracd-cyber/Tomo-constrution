import { fmt } from '../core/math';
import { buildArch, crossSection, panoramic, type ArchCurve, type PanoImage, type Pt } from '../core/panoramic';
import type { Volume } from '../core/types';
import { HuCanvas } from './hu-canvas';

const WINDOWS = { osso: { center: 600, width: 3000 }, dentes: { center: 1200, width: 3500 } };

/** Aba "Panorâmica": arco desenhado no axial → panorâmica reformatada + cortes transversais. */
export class PanoPanel {
  private vol: Volume | null = null;
  private axial: HuCanvas;
  private pano: HuCanvas;
  private cross: HuCanvas;
  private slice = 0;
  private control: Pt[] = [];
  private arch: ArchCurve | null = null;
  private panoImg: PanoImage | null = null;
  private crossCol = -1;
  private ruler: { a: [number, number]; b: [number, number] } | null = null;
  private dragIndex = -1;
  private pending = 0;
  private window = WINDOWS.osso;

  constructor(private root: HTMLElement) {
    this.axial = new HuCanvas(root.querySelector<HTMLCanvasElement>('#pano-axial')!);
    this.pano = new HuCanvas(root.querySelector<HTMLCanvasElement>('#pano-image')!);
    this.cross = new HuCanvas(root.querySelector<HTMLCanvasElement>('#pano-cross')!);
    const slider = root.querySelector<HTMLInputElement>('#pano-slice')!;
    slider.addEventListener('input', () => {
      this.slice = Number(slider.value);
      this.renderAxial();
    });
    this.axial.canvas.addEventListener('pointerdown', (e) => this.axialDown(e));
    this.axial.canvas.addEventListener('pointermove', (e) => this.axialMove(e));
    this.axial.canvas.addEventListener('pointerup', () => (this.dragIndex = -1));
    this.pano.canvas.addEventListener('pointerdown', (e) => this.pickColumn(e));
    this.pano.canvas.addEventListener('pointermove', (e) => e.buttons && this.pickColumn(e));
    this.cross.canvas.addEventListener('pointerdown', (e) => {
      this.cross.canvas.setPointerCapture(e.pointerId);
      const p = this.cross.toImage(e);
      this.ruler = { a: p, b: p };
      this.drawCross();
    });
    this.cross.canvas.addEventListener('pointermove', (e) => {
      if (!this.ruler || !e.buttons) return;
      this.ruler.b = this.cross.toImage(e);
      this.drawCross();
    });
    root.querySelector('#pano-undo')!.addEventListener('click', () => {
      this.control.pop();
      this.update();
    });
    root.querySelector('#pano-clear')!.addEventListener('click', () => {
      this.control = [];
      this.update();
    });
    ['#pano-thickness', '#pano-mode'].forEach((s) => root.querySelector(s)!.addEventListener('input', () => this.update()));
    root.querySelectorAll<HTMLButtonElement>('[data-pano-wl]').forEach((btn) =>
      btn.addEventListener('click', () => {
        root.querySelectorAll('[data-pano-wl]').forEach((b) => b.classList.toggle('on', b === btn));
        this.window = WINDOWS[btn.dataset.panoWl as keyof typeof WINDOWS];
        this.renderAxial();
        this.renderPano();
      }),
    );
    for (const c of [this.axial, this.pano, this.cross]) new ResizeObserver(() => this.redraw()).observe(c.canvas);
  }

  setVolume(vol: Volume) {
    this.vol = vol;
    this.control = [];
    this.arch = null;
    this.panoImg = null;
    this.crossCol = -1;
    this.ruler = null;
    this.slice = this.toothSlice(vol);
    const slider = this.root.querySelector<HTMLInputElement>('#pano-slice')!;
    slider.max = String(vol.dims[2] - 1);
    slider.value = String(this.slice);
    this.renderAxial();
    this.renderPano();
  }

  /** corte axial com mais esmalte (coroas dentárias); o osso petroso e o cortical não passam de ~2000 HU */
  private toothSlice(vol: Volume) {
    const [nx, ny, nz] = vol.dims;
    const plane = nx * ny;
    for (const limit of [2500, 1800, 1200]) {
      let best = -1;
      let bestCount = 0;
      for (let k = 0; k < nz; k++) {
        let c = 0;
        for (let i = k * plane; i < (k + 1) * plane; i += 2) if (vol.data[i] > limit) c++;
        if (c > bestCount) {
          bestCount = c;
          best = k;
        }
      }
      if (best >= 0 && bestCount > 20) return best;
    }
    return Math.floor(nz / 2);
  }

  redraw() {
    this.drawAxial();
    this.drawPano();
    this.drawCross();
  }

  private renderAxial() {
    if (!this.vol) return;
    const [nx, ny] = this.vol.dims;
    const plane = nx * ny;
    this.axial.setImage(
      { width: nx, height: ny, data: this.vol.data.subarray(this.slice * plane, (this.slice + 1) * plane), pw: this.vol.spacing[0], ph: this.vol.spacing[1] },
      this.window,
    );
    this.drawAxial();
  }

  private drawAxial() {
    const L = this.axial.draw();
    if (!this.vol) return;
    const ctx = this.axial.ctx;
    const dpr = L.dpr;
    if (this.arch) {
      ctx.strokeStyle = '#4cc3ff';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      this.arch.points.forEach((p, i) => {
        const [x, y] = this.axial.toCanvas(p[0], p[1]);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
      const thick = Number(this.root.querySelector<HTMLInputElement>('#pano-thickness')!.value);
      // limites da faixa
      ctx.strokeStyle = 'rgba(76,195,255,0.35)';
      ctx.lineWidth = 1 * dpr;
      for (const sgn of [-1, 1]) {
        ctx.beginPath();
        this.arch.points.forEach((p, i) => {
          const n = this.arch!.normals[i];
          const [x, y] = this.axial.toCanvas(p[0] + (sgn * n[0] * thick) / 2 / this.vol!.spacing[0], p[1] + (sgn * n[1] * thick) / 2 / this.vol!.spacing[1]);
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.stroke();
      }
      if (this.crossCol >= 0) {
        const p = this.arch.points[this.crossCol];
        const n = this.arch.normals[this.crossCol];
        const r = 20;
        const [x1, y1] = this.axial.toCanvas(p[0] - (n[0] * r) / this.vol.spacing[0], p[1] - (n[1] * r) / this.vol.spacing[1]);
        const [x2, y2] = this.axial.toCanvas(p[0] + (n[0] * r) / this.vol.spacing[0], p[1] + (n[1] * r) / this.vol.spacing[1]);
        ctx.strokeStyle = '#ffd400';
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#ffd400';
    for (const p of this.control) {
      const [x, y] = this.axial.toCanvas(p[0], p[1]);
      ctx.beginPath();
      ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    this.axial.text([
      `Axial ${this.slice + 1}/${this.vol.dims[2]}`,
      this.control.length < 3 ? `Toque ${3 - this.control.length}+ ponto(s) ao longo do arco, de um lado ao outro` : `${this.control.length} pontos · arraste para ajustar`,
    ]);
  }

  private axialDown(e: PointerEvent) {
    if (!this.vol) return;
    this.axial.canvas.setPointerCapture(e.pointerId);
    const [u, v] = this.axial.toImage(e);
    const L = this.axial.layout;
    const near = this.control.findIndex((p) => Math.hypot((p[0] - u) * L.sx, (p[1] - v) * L.sy) < 14 * L.dpr);
    if (near >= 0) {
      this.dragIndex = near;
      return;
    }
    if (u < 0 || v < 0 || u > this.vol.dims[0] - 1 || v > this.vol.dims[1] - 1) return;
    this.control.push([u, v]);
    this.dragIndex = this.control.length - 1;
    this.update();
  }

  private axialMove(e: PointerEvent) {
    if (this.dragIndex < 0 || !e.buttons) return;
    this.control[this.dragIndex] = this.axial.toImage(e);
    this.update();
  }

  private update() {
    cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => {
      if (!this.vol) return;
      this.arch = this.control.length >= 2 ? buildArch(this.control, this.vol) : null;
      if (this.arch && this.crossCol >= this.arch.points.length) this.crossCol = this.arch.points.length - 1;
      if (this.arch && this.crossCol < 0) this.crossCol = Math.floor(this.arch.points.length / 2);
      this.renderPano();
      this.drawAxial();
    });
  }

  private renderPano() {
    if (!this.vol || !this.arch || this.control.length < 3) {
      this.panoImg = null;
      this.pano.setImage(null, this.window);
      this.cross.setImage(null, this.window);
      this.drawPano();
      this.drawCross();
      return;
    }
    const thick = Number(this.root.querySelector<HTMLInputElement>('#pano-thickness')!.value);
    const mode = this.root.querySelector<HTMLSelectElement>('#pano-mode')!.value as 'media' | 'mip';
    this.root.querySelector('#pano-thickness-out')!.textContent = `${thick} mm`;
    this.panoImg = panoramic(this.vol, this.arch, thick, mode);
    this.pano.setImage({ ...this.panoImg, pw: this.panoImg.pixel, ph: this.panoImg.pixel }, mode === 'mip' ? WINDOWS.dentes : this.window);
    this.drawPano();
    this.renderCross();
  }

  private drawPano() {
    const L = this.pano.draw();
    if (!this.panoImg) {
      this.pano.text(['A panorâmica aparece depois de 3 pontos no arco.']);
      return;
    }
    const ctx = this.pano.ctx;
    if (this.crossCol >= 0) {
      const [x] = this.pano.toCanvas(this.crossCol, 0);
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 1.5 * L.dpr;
      ctx.beginPath();
      ctx.moveTo(x, L.y0);
      ctx.lineTo(x, L.y0 + this.panoImg.height * L.sy);
      ctx.stroke();
    }
    ctx.fillStyle = '#9fe870';
    ctx.font = `${12 * L.dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('R', 8 * L.dpr, 30 * L.dpr);
    ctx.textAlign = 'right';
    ctx.fillText('L', this.pano.canvas.width - 8 * L.dpr, 30 * L.dpr);
    this.pano.text([`Arco ${fmt(this.arch!.length, 0)} mm · toque para escolher o corte transversal`]);
  }

  private pickColumn(e: PointerEvent) {
    if (!this.panoImg) return;
    const [u] = this.pano.toImage(e);
    this.crossCol = Math.max(0, Math.min(this.panoImg.width - 1, Math.round(u)));
    this.ruler = null;
    this.drawPano();
    this.drawAxial();
    this.renderCross();
  }

  private renderCross() {
    if (!this.vol || !this.arch || this.crossCol < 0 || !this.panoImg) return;
    const img = crossSection(this.vol, this.arch, this.crossCol, 40);
    this.cross.setImage({ ...img, pw: img.pixel, ph: img.pixel }, this.window);
    this.drawCross();
  }

  private drawCross() {
    const L = this.cross.draw();
    const img = this.cross.image;
    if (!img || !this.arch) return;
    const ctx = this.cross.ctx;
    ctx.fillStyle = '#9fe870';
    ctx.font = `${12 * L.dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('Lingual/palatino', 8 * L.dpr, 30 * L.dpr);
    ctx.textAlign = 'right';
    ctx.fillText('Vestibular', this.cross.canvas.width - 8 * L.dpr, 30 * L.dpr);
    if (this.ruler) {
      const { a, b } = this.ruler;
      const [ax, ay] = this.cross.toCanvas(a[0], a[1]);
      const [bx, by] = this.cross.toCanvas(b[0], b[1]);
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 2 * L.dpr;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      const mm = Math.hypot(b[0] - a[0], b[1] - a[1]) * img.pw;
      this.cross.label(`${fmt(mm, 1)} mm`, bx + 8 * L.dpr, by, '#ffd400');
    }
    const pos = this.crossCol * this.arch.step;
    const lines = [`Transversal a ${fmt(pos, 0)} mm do início do arco`, 'Arraste para medir altura/espessura óssea'];
    if (this.vol && this.vol.spacing[2] > 1.5) lines.push(`Atenção: cortes de ${fmt(this.vol.spacing[2])} mm — altura com baixa precisão`);
    this.cross.text(lines);
  }

  snapshotImages(): { label: string; canvas: HTMLCanvasElement }[] {
    if (!this.panoImg) return [];
    return [
      { label: 'Panorâmica reconstruída', canvas: this.pano.canvas },
      { label: 'Corte transversal', canvas: this.cross.canvas },
    ];
  }
}
