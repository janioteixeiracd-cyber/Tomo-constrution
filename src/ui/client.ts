import type { InputFile } from '../core/dicom';
import type { Mesh } from '../core/mesh';
import type { SegmentKey } from '../core/segment';
import type { BuiltVolume, ReconOptions, SeriesSummary, Volume } from '../core/types';

export interface ParseResponse {
  summaries: SeriesSummary[];
  skipped: { name: string; reason: string }[];
  best: string | null;
}

export interface SegmentResponse {
  meshes: { key: SegmentKey; mesh: Mesh }[];
  notes: string[];
  stats: { key: SegmentKey; volumeMm3: number }[];
}

export interface ReconResponse {
  intensity: Volume;
  notes: string[];
  mesh: Mesh;
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

  build(seriesId: string, onProgress?: (m: string) => void) {
    return this.call<BuiltVolume>({ type: 'build', seriesId }, onProgress);
  }

  segment(calibratedHU: boolean, smoothIterations: number, onProgress?: (m: string) => void) {
    return this.call<SegmentResponse>({ type: 'segment', calibratedHU, smoothIterations }, onProgress);
  }

  recon(options: ReconOptions, maxVoxels: number, smoothIterations: number, onProgress?: (m: string) => void) {
    return this.call<ReconResponse>({ type: 'recon', options, maxVoxels, smoothIterations }, onProgress);
  }
}
