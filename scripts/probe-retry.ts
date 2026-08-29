/**
 * Pengulangan untuk probe dan evaluator.
 *
 * `AiClient` mengulang permintaan hanya selama masih ada key lain untuk
 * dirotasi. Dengan satu key—keadaan biasa di mesin pengembang—tidak ada
 * pengulangan sama sekali, sehingga satu gangguan sesaat provider menggagalkan
 * seluruh giliran. Probe menanggungnya sendiri di sini.
 *
 * Ada dua bentuk kegagalan yang harus ditangani terpisah:
 *
 * 1. Panggilan yang melempar (`reply`, `understand`, `presentOperation`).
 * 2. `conversation.agent()`, yang **tidak** melempar. Agent Runtime menangkap
 *    error di dalam loop dan mengembalikannya sebagai `status: "stopped"`.
 *    Sebelum alasan `provider_unavailable` ada, gangguan provider di sana tidak
 *    dapat dibedakan dari planner yang menghasilkan bentuk salah, sehingga
 *    tidak ada pemanggil yang boleh mengulang tanpa ikut mengulang kegagalan
 *    yang memang nyata.
 */
import { AiError, AiResponseError } from "../src/ai/client.js";
import type { AgentRunResult } from "../src/harness/agent-harness.js";

export const PROBE_RETRY_LIMIT = 5;
export const PROBE_BACKOFF_BASE_MS = 4_000;

/** Gangguan sesaat, bukan penolakan yang akan berulang sama persis. */
export function isTransientProviderFailure(error: unknown): boolean {
  if (error instanceof AiResponseError) return false;
  if (error instanceof AiError) {
    return error.status !== undefined &&
      (error.status === 408 || error.status === 429 || error.status >= 500);
  }
  return error instanceof Error && error.name === "AbortError";
}

async function backoff(attempt: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      PROBE_BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 500),
    )
  );
}

/** Untuk panggilan yang melempar saat provider bermasalah. */
export async function retryOnTransient<T>(
  run: () => Promise<T>,
  limit = PROBE_RETRY_LIMIT,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= limit || !isTransientProviderFailure(error)) throw error;
      await backoff(attempt);
    }
  }
}

/**
 * Untuk `conversation.agent()`, yang melaporkan kegagalan lewat hasil.
 *
 * Hanya `provider_unavailable` yang diulang. `invalid_planner_output`,
 * `max_steps`, dan `cycle` adalah hasil pengukuran yang sah—mengulanginya
 * berarti membuang bukti yang justru sedang dicari probe.
 */
export async function retryAgentRun(
  run: () => Promise<AgentRunResult>,
  limit = PROBE_RETRY_LIMIT,
): Promise<AgentRunResult> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await retryOnTransient(run, limit - attempt);
    if (
      result.status !== "stopped" ||
      result.reason !== "provider_unavailable" ||
      attempt >= limit
    ) {
      return result;
    }
    console.error(
      `  provider tidak tersedia; mengulang (percobaan ${attempt + 2}/${limit + 1})`,
    );
    await backoff(attempt);
  }
}
