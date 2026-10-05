/** Desenha uma imagem em HU num canvas com janela/nível, mantendo proporção, e mapeia coordenadas. */
export interface HuImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
  /** tamanho físico do pixel (mm) em x e y */
  pw: number;
  ph: number;
}

export interface Layout {
  x0: number;
  y0: number;
  /** pixels de canvas por pixel de imagem */
  sx: number;
  sy: number;
  dpr: number;
}

export class HuCanvas {
  readonly ctx: CanvasRenderingContext2D;
  private off = document.createElement('canvas');
  private img: HuImage | null = null;
  layout: Layout = { x0: 0, y0: 0, sx: 1, sy: 1, dpr: 1 };

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  setImage(img: HuImage | null, window: { center: number; width: number }) {
    this.img = img;
    if (!img) return;
    this.off.width = img.width;
    this.off.height = img.height;
    const ctx = this.off.getContext('2d')!;
    const id = ctx.createImageData(img.width, img.height);
    const lo = window.center - window.width / 2;
    const scale = 255 / Math.max(1, window.width);
    for (let i = 0; i < img.width * img.height; i++) {
      const g = Math.max(0, Math.min(255, (img.data[i] - lo) * scale));
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = g;
      id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }

  get image() {
    return this.img;
  }

  /** Limpa, desenha a imagem e devolve o layout para sobreposições. */
  draw(): Layout {
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
    if (!this.img) return (this.layout = { x0: 0, y0: 0, sx: 1, sy: 1, dpr });
    const physW = this.img.width * this.img.pw;
    const physH = this.img.height * this.img.ph;
    const s = Math.min(W / physW, H / physH);
    const dw = physW * s;
    const dh = physH * s;
    this.layout = { x0: (W - dw) / 2, y0: (H - dh) / 2, sx: dw / this.img.width, sy: dh / this.img.height, dpr };
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, this.layout.x0, this.layout.y0, dw, dh);
    return this.layout;
  }

  /** evento → coordenada contínua da imagem (centro do pixel = inteiro) */
  toImage(e: { clientX: number; clientY: number }): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const L = this.layout;
    const x = (e.clientX - rect.left) * L.dpr;
    const y = (e.clientY - rect.top) * L.dpr;
    return [(x - L.x0) / L.sx - 0.5, (y - L.y0) / L.sy - 0.5];
  }

  toCanvas(u: number, v: number): [number, number] {
    const L = this.layout;
    return [L.x0 + (u + 0.5) * L.sx, L.y0 + (v + 0.5) * L.sy];
  }

  label(text: string, x: number, y: number, color: string) {
    const ctx = this.ctx;
    const dpr = this.layout.dpr;
    ctx.font = `${13 * dpr}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x - 4 * dpr, y - 10 * dpr, w + 8 * dpr, 20 * dpr);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  text(lines: string[], color = 'rgba(255,255,255,0.85)') {
    const ctx = this.ctx;
    const dpr = this.layout.dpr;
    ctx.font = `${12 * dpr}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    lines.forEach((t, i) => ctx.fillText(t, 8 * dpr, this.canvas.height - 10 * dpr - (lines.length - 1 - i) * 16 * dpr));
  }
}
