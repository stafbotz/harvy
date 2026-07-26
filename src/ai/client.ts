import type { ApiKeyPool } from "./key-pool.js";

/**
 * Klien chat completion yang netral penyedia.
 *
 * OpenRouter dan Google AI Studio sama-sama menyediakan permukaan yang
 * kompatibel dengan OpenAI, sehingga satu klien cukup untuk keduanya. Yang
 * membedakan hanya `baseUrl` dan kunci, dan keduanya berasal dari konfigurasi.
 *
 * Memakai `fetch` bawaan Node 22; tidak ada dependency baru.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Rendah untuk ekstraksi, lebih tinggi untuk percakapan. */
  temperature?: number;
  maxTokens?: number;
  /**
   * Meminta penyedia menjamin keluaran berupa JSON. Tidak semua penyedia
   * mendukungnya, jadi permintaan diulang tanpa opsi ini bila ditolak.
   */
  json?: boolean;
}

export interface AiClientOptions {
  baseUrl: string;
  keys: ApiKeyPool;
  timeoutMs?: number;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class AiClient {
  constructor(private readonly options: AiClientOptions) {}

  /**
   * Mengirim permintaan dan mengembalikan teks balasan.
   *
   * Ketika kuota sebuah kunci habis, permintaan diulang dengan kunci
   * berikutnya. Jumlah percobaan dibatasi sebanyak kunci yang tersedia agar
   * kegagalan tetap cepat terlihat, bukan berputar diam-diam.
   */
  async complete(request: ChatRequest): Promise<string> {
    try {
      return await this.attempt(request);
    } catch (error) {
      // Penyedia yang tidak mengenal mode JSON menolak dengan galat permintaan.
      // Turunkan sekali ke permintaan biasa daripada menggagalkan percakapan.
      if (request.json && isUnsupportedOption(error)) {
        return this.attempt({ ...request, json: false });
      }
      throw error;
    }
  }

  private async attempt(request: ChatRequest): Promise<string> {
    const attempts = Math.max(1, this.options.keys.size);
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.send(request, this.options.keys.take());
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AiError("Permintaan ke model gagal.");
  }

  private async send(request: ChatRequest, apiKey: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(
        `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            temperature: request.temperature ?? 0.7,
            max_tokens: request.maxTokens ?? 800,
            ...(request.json
              ? { response_format: { type: "json_object" } }
              : {}),
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new AiError(
          `Model menolak permintaan (${response.status}).`,
          response.status,
        );
      }

      return readContent(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }
}

function readContent(payload: unknown): string {
  const content = (
    payload as {
      choices?: { message?: { content?: unknown } }[];
    }
  )?.choices?.[0]?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new AiError("Balasan model kosong atau tidak dikenali.");
  }

  return content.trim();
}

/** Penyedia menolak bentuk permintaannya, bukan kuncinya. */
function isUnsupportedOption(error: unknown): boolean {
  return (
    error instanceof AiError &&
    (error.status === 400 || error.status === 404 || error.status === 422)
  );
}

/** Kuota habis, pembatasan laju, dan galat server layak dicoba dengan kunci lain. */
function isRetryable(error: unknown): boolean {
  if (error instanceof AiError && error.status !== undefined) {
    return error.status === 429 || error.status >= 500;
  }

  // Timeout dan gangguan jaringan.
  return error instanceof Error && error.name !== "AiError";
}
