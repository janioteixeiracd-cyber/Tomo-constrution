import { zipSync } from 'fflate';

interface DownloadsApi {
  save(req: { filename: string; data: Blob | ArrayBuffer | ArrayBufferView | string }): Promise<{ status: string }>;
}

type ClaudeHost = { use?: (name: string) => Promise<unknown> };

let downloadsApi: Promise<DownloadsApi | null> | null = null;

/** API de downloads quando a página roda publicada no claude.ai (onde links de download são bloqueados). */
function hostDownloads(): Promise<DownloadsApi | null> {
  if (!downloadsApi) {
    const host = (window as unknown as { claude?: ClaudeHost }).claude;
    downloadsApi = host?.use ? (host.use('downloads') as Promise<DownloadsApi | null>).catch(() => null) : Promise.resolve(null);
  }
  return downloadsApi;
}

// o claude.ai só aceita alguns formatos; os demais vão compactados
const HOST_FORMATS = /\.(png|jpe?g|webp|gif|txt|json|md|csv|zip|pdf|svg|html)$/i;

/** Salva um arquivo gerado no navegador. Retorna uma mensagem de erro, ou null se deu certo. */
export async function saveFile(filename: string, data: Blob): Promise<string | null> {
  const api = await hostDownloads();
  if (api) {
    let name = filename;
    let payload: Blob | Uint8Array = data;
    if (!HOST_FORMATS.test(filename)) {
      payload = zipSync({ [filename]: new Uint8Array(await data.arrayBuffer()) });
      name = filename.replace(/\.[^.]+$/, '') + '.zip';
    }
    try {
      await api.save({ filename: name, data: payload });
      return null;
    } catch (e) {
      const code = (e as { code?: string }).code;
      return code === 'declined' ? null : `Não foi possível salvar o arquivo (${code ?? 'erro'}).`;
    }
  }
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}
