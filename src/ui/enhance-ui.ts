import { DEFAULT_ENHANCE, enhance, grayToRgba, toGray, type EnhanceOptions, type Gray } from '../core/enhance2d';

const MAX_SIDE = 2000;

/** Aba "Imagem 2D": realce de radiografias, fotos de negatoscópio e capturas de tela. */
export class EnhancePanel {
  private source: Gray | null = null;
  private result: Gray | null = null;
  private opts: EnhanceOptions = { ...DEFAULT_ENHANCE };
  private split = 0.5;
  private canvas: HTMLCanvasElement;
  private before = document.createElement('canvas');
  private after = document.createElement('canvas');
  private pending = 0;
  private fileName = 'imagem';

  constructor(private root: HTMLElement) {
    this.canvas = root.querySelector<HTMLCanvasElement>('#enh-canvas')!;
    const input = root.querySelector<HTMLInputElement>('#enh-file')!;
    input.addEventListener('change', () => input.files?.[0] && this.load(input.files[0]));
    root.addEventListener('dragover', (e) => e.preventDefault());
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) this.load(f);
    });
    root.querySelectorAll<HTMLInputElement>('[data-opt]').forEach((el) => {
      el.addEventListener('input', () => {
        const key = el.dataset.opt as keyof EnhanceOptions;
        (this.opts as unknown as Record<string, number | boolean>)[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
        this.schedule();
      });
    });
    root.querySelector('#enh-reset')!.addEventListener('click', () => {
      this.opts = { ...DEFAULT_ENHANCE };
      this.syncControls();
      this.schedule();
    });
    root.querySelector('#enh-download')!.addEventListener('click', () => this.download());
    const splitInput = root.querySelector<HTMLInputElement>('#enh-split')!;
    splitInput.addEventListener('input', () => {
      this.split = Number(splitInput.value) / 100;
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(this.canvas.parentElement!);
    this.syncControls();
  }

  private syncControls() {
    this.root.querySelectorAll<HTMLInputElement>('[data-opt]').forEach((el) => {
      const v = this.opts[el.dataset.opt as keyof EnhanceOptions];
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = String(v);
    });
  }

  async load(file: File) {
    this.fileName = file.name.replace(/\.[^.]+$/, '') || 'imagem';
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) {
      alert('Não foi possível abrir esta imagem. Use JPG, PNG ou WEBP (fotos HEIC do iPhone: exporte como JPG).');
      return;
    }
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    this.source = toGray(ctx.getImageData(0, 0, w, h).data, w, h);
    this.paint(this.before, this.source);
    this.root.classList.add('has-image');
    this.process();
  }

  private schedule() {
    if (!this.source) return;
    cancelAnimationFrame(this.pending);
    this.pending = requestAnimationFrame(() => this.process());
  }

  private process() {
    if (!this.source) return;
    this.result = enhance(this.source, this.opts);
    this.paint(this.after, this.result);
    this.draw();
  }

  private paint(target: HTMLCanvasElement, img: Gray) {
    target.width = img.width;
    target.height = img.height;
    const ctx = target.getContext('2d')!;
    const id = ctx.createImageData(img.width, img.height);
    grayToRgba(img, id.data);
    ctx.putImageData(id, 0, 0);
  }

  private draw() {
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(box.width * dpr));
    this.canvas.height = Math.max(1, Math.round(box.height * dpr));
    const ctx = this.canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.source) return;
    const s = Math.min(this.canvas.width / this.source.width, this.canvas.height / this.source.height);
    const w = this.source.width * s;
    const h = this.source.height * s;
    const x0 = (this.canvas.width - w) / 2;
    const y0 = (this.canvas.height - h) / 2;
    const cut = this.source.width * this.split;
    ctx.drawImage(this.before, 0, 0, cut, this.source.height, x0, y0, cut * s, h);
    ctx.drawImage(this.after, cut, 0, this.source.width - cut, this.source.height, x0 + cut * s, y0, w - cut * s, h);
    ctx.strokeStyle = '#4cc3ff';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x0 + cut * s, y0);
    ctx.lineTo(x0 + cut * s, y0 + h);
    ctx.stroke();
    ctx.font = `${12 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textBaseline = 'top';
    if (this.split > 0.08) ctx.fillText('Original', x0 + 8 * dpr, y0 + 8 * dpr);
    if (this.split < 0.92) {
      ctx.textAlign = 'right';
      ctx.fillText('Realçada', x0 + w - 8 * dpr, y0 + 8 * dpr);
      ctx.textAlign = 'left';
    }
  }

  private download() {
    if (!this.result) return;
    const a = document.createElement('a');
    a.href = this.after.toDataURL('image/png');
    a.download = `${this.fileName}-realcada.png`;
    a.click();
  }
}
