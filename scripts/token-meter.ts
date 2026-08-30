/**
 * Pengukur token nyata untuk skrip probe dan evaluasi.
 *
 * Angka token di dokumen selama ini perkiraan `char/3.5`. Membungkus `fetch`
 * membuat setiap panggilan melaporkan `usage` yang benar-benar dikembalikan
 * provider, termasuk bagian yang kena cache.
 *
 * Dipisah dari `probe-chat.ts` ketika evaluator juga membutuhkannya: pertanyaan
 * "berapa biaya langkah review artefak kode" tidak dapat dijawab tanpa angka
 * yang sama, dan dua salinan instrumentasi akan berayun sendiri-sendiri.
 */
export interface ModelCallUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

const calls: ModelCallUsage[] = [];
let installed = false;

/** Membungkus `fetch` sekali; pemanggilan berikutnya tidak menumpuk pembungkus. */
export function startTokenMeter(): void {
  if (installed) return;
  installed = true;
  const baseFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await baseFetch(input, init);
    if (!String(input).includes("/chat/completions")) return response;
    try {
      const body = await response.clone().json() as {
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      if (body.usage) {
        calls.push({
          promptTokens: body.usage.prompt_tokens ?? 0,
          cachedTokens: body.usage.prompt_tokens_details?.cached_tokens ?? 0,
          completionTokens: body.usage.completion_tokens ?? 0,
        });
      }
    } catch {
      // Respons non-JSON tidak relevan untuk pengukuran ini.
    }
    return response;
  }) as typeof fetch;
}

export function tokenMeterCalls(): readonly ModelCallUsage[] {
  return calls;
}

export interface TokenTotals {
  calls: number;
  prompt: number;
  cached: number;
  output: number;
  total: number;
}

export function tokenTotals(): TokenTotals {
  const prompt = calls.reduce((sum, call) => sum + call.promptTokens, 0);
  const cached = calls.reduce((sum, call) => sum + call.cachedTokens, 0);
  const output = calls.reduce((sum, call) => sum + call.completionTokens, 0);
  return { calls: calls.length, prompt, cached, output, total: prompt + output };
}
