import type { InputFile } from '../core/dicom';
import type { Mesh } from '../core/mesh';
import type { MetalObject } from '../core/metal';
import type { BuiltVolume, ReconOptions, SeriesSummary, Vec3, Volume } from '../core/types';

export interface ParseResponse {
  summaries: SeriesSummary[];
  skipped: { name: string; reason: string }[];
  best: string | null;
}

export interface LayerOut {
  id: number;
  name: string;
  base: 'bone' | 'teeth' | 'metal';
  mesh: Mesh;
  volumeMm3: number;
}

export interface SegmentResponse {
  layers: LayerOut[];
  notes: string[];
}

export interface SplitResponse {
  ok: boolean;
  message: string;
  layers: LayerOut[];
}

export interface ReconResponse {
  intensity: Volume;
  notes: string[];
  mesh: Mesh;
  metal: { mesh: Mesh; objects: MetalObject[]; seed: number; low: number } | null;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (m: string) => void };

/** Cliente RPC do worker de processamento (todo o processamento fica no navegador). */
export class ProcessingClient {
  private worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker.onmessage = (ev) => {
      const { id, progress, result, error } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (progress) return p.onProgress?.(progress);
      this.pending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    this.worker.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || 'Falha no processamento.'));
      this.pending.clear();
    };
  }

  private call<T>(msg: Record<string, unknown>, onProgress?: (m: string) => void, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  parse(files: InputFile[], onProgress?: (m: string) => void) {
    return this.call<ParseResponse>({ type: 'parse', files }, onProgress, files.map((f) => f.buffer));
  }

  build(seriesIds: string[], onProgress?: (m: string) => void, extra: { effective?: Vec3; effectiveGap?: number; maxVoxels?: number } = {}) {
    return this.call<BuiltVolume>({ type: 'build', seriesIds, ...extra }, onProgress);
  }

  segment(calibratedHU: boolean, smoothIterations: number, onProgress?: (m: string) => void) {
    return this.call<SegmentResponse>({ type: 'segment', calibratedHU, smoothIterations }, onProgress);
  }

  recon(options: ReconOptions, maxVoxels: number, smoothIterations: number, calibratedHU: boolean, onProgress?: (m: string) => void) {
    return this.call<ReconResponse>({ type: 'recon', options, maxVoxels, smoothIterations, calibratedHU }, onProgress);
  }

  split(
    req: { mode: 'seed' | 'plane'; point: Vec3; planeOrigin?: Vec3; planeNormal?: Vec3; name: string; smoothIterations: number },
    onProgress?: (m: string) => void,
  ) {
    return this.call<SplitResponse>({ type: 'split', ...req }, onProgress);
  }
}
