import Anthropic from '@anthropic-ai/sdk';

export interface CaseImage {
  label: string;
  blob: Blob;
}

export interface DescribeRequest {
  images: CaseImage[];
  /** dados técnicos do exame (sem identificação do paciente) */
  technical: string;
  /** contexto clínico e pergunta escritos pelo usuário */
  question: string;
  apiKey?: string;
  onText: (text: string) => void;
  signal?: AbortSignal;
}

const MODEL = 'claude-opus-5-5';

export const SYSTEM_PROMPT = `Você apoia o ESTUDO de casos de cirurgia e traumatologia bucomaxilofacial por um cirurgião-dentista e seus alunos.
Recebe imagens anonimizadas de uma tomografia (cortes, reconstrução 3D e, às vezes, panorâmica reconstruída) e dados técnicos do exame.

Responda em português do Brasil, com estas seções:
1. Qualidade e limitações das imagens (espessura de corte, artefatos, cobertura) e como isso afeta a leitura.
2. Estruturas identificáveis (seios maxilares, órbitas, cavidade nasal, maxila, mandíbula, ATM, dentes, etc.).
3. Achados observáveis — descreva o que se vê, com localização anatômica; diferencie claramente o que é visível do que é incerto.
4. Hipóteses a considerar no estudo do caso (não diagnóstico), com o que ajudaria a confirmar ou descartar.
5. Sugestões de estudo: incidências/cortes adicionais, medidas úteis, pontos para discutir com a turma.

Regras: não invente achados que as imagens não sustentam; quando a resolução não permitir avaliar algo, diga isso.
Termine lembrando que a descrição é educacional e não substitui o laudo do radiologista nem o exame clínico.`;

type SampleFn = ((
  input: string,
  opts?: { images?: Blob[]; onText?: (p: { text: string }) => void; signal?: AbortSignal; modelTier?: 'quick' | 'default' | 'complex'; cache?: boolean },
) => Promise<{ text: string; truncated: boolean }>) & { limits(): Promise<{ images?: { maxCount: number; mediaTypes: string[] } }> };

export interface HostClaude {
  sample: SampleFn;
  /** máximo de imagens por chamada neste aparelho (0 = só texto) */
  maxImages: number;
}

let hostSample: Promise<HostClaude | null> | null = null;

/** Claude do próprio claude.ai, quando o app roda publicado lá (sem chave de API). */
export function claudeHostSample(): Promise<HostClaude | null> {
  if (!hostSample) {
    const host = (window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
    hostSample = host?.use
      ? (host.use('sample') as Promise<SampleFn | null>)
          .then(async (s) => {
            if (!s) return null;
            const lim = await s.limits().catch(() => null);
            const img = lim?.images;
            const jpeg = !!img && img.mediaTypes.some((t) => t === 'image/jpeg' || t === 'image/*');
            return { sample: s, maxImages: jpeg ? img!.maxCount : 0 };
          })
          .catch(() => null)
      : Promise.resolve(null);
  }
  return hostSample;
}

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

function userText(req: DescribeRequest) {
  const list = req.images.map((im, i) => `Imagem ${i + 1}: ${im.label}`).join('\n');
  return `Imagens enviadas (na ordem):\n${list}\n\nDados técnicos do exame:\n${req.technical}\n\nContexto e pergunta do usuário:\n${
    req.question.trim() || '(nenhum — faça a descrição geral)'
  }`;
}

/** Texto para colar no chat do Claude junto com a montagem das imagens (uma única imagem numerada). */
export function chatPrompt(req: Pick<DescribeRequest, 'images' | 'technical' | 'question'>): string {
  return `${SYSTEM_PROMPT}\n\nAs imagens vêm numa única montagem anexada, cada quadro numerado na ordem abaixo.\n\n${userText(req as DescribeRequest)}`;
}

/** Junta as imagens numa montagem JPEG numerada (para anexar no chat do Claude). */
export async function montage(images: CaseImage[], cell = 720): Promise<Blob> {
  const bitmaps = await Promise.all(images.map((i) => createImageBitmap(i.blob)));
  const cols = images.length > 1 ? 2 : 1;
  const rows = Math.ceil(images.length / cols);
  const head = 34;
  const heights = bitmaps.map((b) => Math.round((b.height * cell) / b.width));
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(...heights.slice(r * cols, r * cols + cols)) + head);
  const c = document.createElement('canvas');
  c.width = cols * cell + (cols - 1) * 8;
  c.height = rowH.reduce((a, b) => a + b, 0) + (rows - 1) * 8;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  let y = 0;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const i = r * cols + k;
      if (i >= images.length) break;
      const x = k * (cell + 8);
      ctx.fillStyle = '#ffcf5c';
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const label = `${i + 1}. ${images[i].label}`;
      ctx.fillText(label.length > 58 ? `${label.slice(0, 56)}…` : label, x + 6, y + head / 2);
      ctx.drawImage(bitmaps[i], x, y + head, cell, heights[i]);
    }
    y += rowH[r] + 8;
  }
  bitmaps.forEach((b) => b.close());
  return canvasToJpeg(c, 2000);
}

/** Descreve o caso com o Claude. Usa o Claude do claude.ai quando disponível; senão, a chave de API informada. */
export async function describeCase(req: DescribeRequest): Promise<string> {
  const host = await claudeHostSample();
  // Conta do claude.ai: com imagens quando o aparelho permite; só texto apenas se não houver chave.
  if (host && (host.maxImages > 0 || !req.apiKey)) {
    const images = req.images.slice(0, host.maxImages);
    const left = req.images.slice(images.length);
    let prompt = `${SYSTEM_PROMPT}\n\n${userText({ ...req, images })}`;
    if (left.length) {
      prompt += `\n\nAtenção: ${images.length ? 'apenas as imagens listadas acima foram anexadas' : 'nenhuma imagem pôde ser anexada neste aparelho'}; não foram enviadas: ${left
        .map((i) => i.label)
        .join(', ')}. Baseie-se só no que recebeu e diga claramente o que não pôde ser avaliado sem as imagens.`;
    }
    const res = await host.sample(prompt, {
      ...(images.length ? { images: images.map((i) => i.blob) } : {}),
      onText: ({ text }) => req.onText(text),
      signal: req.signal,
      modelTier: 'complex',
      cache: false,
    });
    return res.text;
  }
  if (!req.apiKey) throw new Error('Informe uma chave de API da Anthropic para usar a descrição por IA fora do claude.ai.');

  const client = new Anthropic({ apiKey: req.apiKey, dangerouslyAllowBrowser: true });
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const im of req.images) {
    content.push({ type: 'text', text: im.label });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toBase64(im.blob) } });
  }
  content.push({ type: 'text', text: userText(req) });

  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    },
    { signal: req.signal },
  );
  let text = '';
  stream.on('text', (delta) => {
    text += delta;
    req.onText(text);
  });
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    throw new Error('O modelo não respondeu a esta solicitação. Tente reformular a pergunta.');
  }
  return text;
}

export function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'Chave de API inválida. Confira a chave em console.anthropic.com.';
  if (e instanceof Anthropic.RateLimitError) return 'Limite de uso atingido. Aguarde um pouco e tente de novo.';
  if (e instanceof Anthropic.APIUserAbortError) return 'Descrição interrompida.';
  if (e instanceof Anthropic.APIError) return `Erro da API (${e.status ?? 'rede'}): ${e.message}`;
  const code = (e as { code?: string }).code;
  if (code === 'not_granted') return 'Uso do Claude não autorizado nesta página.';
  if (code === 'cancelled') return 'Descrição interrompida.';
  if (code === 'rate_limited') return 'Muitas solicitações seguidas. Aguarde um pouco.';
  if (code === 'images_unavailable' || code === 'image_rejected') return 'Este aparelho não conseguiu enviar as imagens ao Claude. Desmarque as imagens ou use o computador.';
  if (code) return `O Claude não respondeu (${code}): ${(e as { message?: string }).message ?? ''}`;
  return e instanceof Error ? e.message : String(e);
}

/** Converte um canvas para JPEG reduzido (máx. 1280 px), sem metadados. */
export function canvasToJpeg(canvas: HTMLCanvasElement, maxSide = 1280): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * scale));
  c.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Falha ao gerar imagem.'))), 'image/jpeg', 0.88));
}
