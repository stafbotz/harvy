import type { ApiKeyPool } from "./key-pool.js";
import type { TextEmbeddingProvider } from "../domain/memory-knowledge.js";
import {
  BoundedResponseBodyError,
  readBoundedResponseBody,
} from "../transport/bounded-response-body.js";

const MAX_BATCH = 161;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface EmbeddingClientOptions {
  baseUrl: string;
  keys: ApiKeyPool;
  model: string;
  providerId: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  /** Hard cap sebelum payload embedding dibuffer. */
  maxResponseBytes?: number;
}

/**
 * Adapter embeddings kompatibel OpenAI untuk endpoint yang sudah dipakai
 * Harvy. Ia opt-in lewat model config; tidak pernah menebak model chat sebagai
 * model embedding dan tidak menyimpan vector/provider payload ke disk/log.
 */
export class OpenAiCompatibleEmbeddingProvider
implements TextEmbeddingProvider {
  readonly modelId: string;
  readonly modelVersion: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: EmbeddingClientOptions) {
    this.modelId = boundedModel(options.model);
    // Exact configured model ID is the cache compatibility boundary until a
    // provider exposes a stronger immutable revision identifier.
    this.modelVersion = this.modelId;
    this.endpoint = embeddingEndpoint(options.baseUrl);
    this.timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? 15_000));
    this.fetcher = options.fetcher ?? fetch;
    this.maxResponseBytes = boundedResponseBytes(
      options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
    );
  }

  async embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length < 1 || texts.length > MAX_BATCH) {
      throw new Error("Batch embedding tidak sah.");
    }
    const input = texts.map((text) => {
      if (
        typeof text !== "string" ||
        text.length < 1 ||
        text.length > 1_000 ||
        /\u0000/u.test(text)
      ) {
        throw new Error("Teks embedding tidak sah.");
      }
      return text;
    });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;
    const body: Record<string, unknown> = {
      model: this.modelId,
      input,
    };
    if (this.options.providerId === "openrouter") {
      body.provider = { data_collection: "deny" };
    }
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.keys.take()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Provider embedding gagal dengan status ${response.status}.`);
    }
    let bytes: Buffer;
    try {
      bytes = await readBoundedResponseBody(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof BoundedResponseBodyError) {
        throw new Error(
          error.reason === "too_large"
            ? "Respons embedding melewati batas."
            : "Content-Length respons embedding tidak sah.",
        );
      }
      throw error;
    }
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Respons embedding bukan UTF-8 sah.");
    }
    return parseResponse(raw, input.length);
  }
}

function parseResponse(raw: string, expected: number): number[][] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Respons embedding bukan JSON sah.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Respons embedding tidak sah.");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error("Jumlah respons embedding tidak cocok.");
  }
  const ordered: number[][] = new Array(expected);
  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Item embedding tidak sah.");
    }
    const index = (entry as { index?: unknown }).index;
    const vector = (entry as { embedding?: unknown }).embedding;
    if (
      !Number.isSafeInteger(index) ||
      (index as number) < 0 ||
      (index as number) >= expected ||
      ordered[index as number] !== undefined ||
      !Array.isArray(vector) ||
      vector.length < 1 ||
      vector.length > 16_384 ||
      vector.some((number) => typeof number !== "number" || !Number.isFinite(number))
    ) {
      throw new Error("Item embedding tidak sah.");
    }
    ordered[index as number] = vector as number[];
  }
  if (ordered.some((vector) => vector === undefined)) {
    throw new Error("Index respons embedding tidak lengkap.");
  }
  return ordered;
}

function embeddingEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/embeddings`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function boundedModel(model: string): string {
  const clean = model.trim();
  if (
    clean.length < 1 ||
    clean.length > 160 ||
    /[\u0000-\u001f<>]/u.test(clean)
  ) {
    throw new Error("Model embedding tidak sah.");
  }
  return clean;
}

function boundedResponseBytes(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1_024 ||
    value > MAX_RESPONSE_BYTES
  ) {
    throw new Error("Batas byte respons embedding tidak sah.");
  }
  return value;
}
