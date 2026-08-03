import { randomUUID } from "node:crypto";
import type { ApiKeyPool } from "./key-pool.js";
import type {
  AiUsageContext,
  TokenUsage,
  UsageObserver,
} from "../domain/telemetry.js";
import type {
  ProviderAttemptFinish,
  ProviderAttemptObserver,
  ProviderAttemptStart,
  ProviderTokenUsage,
  RuntimeEnvironment,
  UsageCostCenter,
} from "../domain/usage-ledger.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import {
  contextManifestLogFields,
  type ContextManifest,
} from "../harness/context-manifest.js";

/**
 * Klien chat completion yang netral penyedia.
 *
 * OpenRouter, Google AI Studio, dan provider cadangan mode uji menyediakan
 * permukaan yang kompatibel dengan OpenAI, sehingga satu klien cukup untuk
 * semuanya. Alamat, kunci, model, dan bentuk autentikasi berasal dari
 * konfigurasi.
 *
 * Memakai `fetch` bawaan Node 22; tidak ada dependency baru.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type AiRequestOperation =
  | "group-plan-ambient"
  | "group-revalidate-ambient"
  | "group-reply";

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** Rendah untuk ekstraksi, lebih tinggi untuk percakapan. */
  temperature?: number;
  maxTokens?: number;
  /** Batas khusus permintaan yang harus cepat, misalnya pengelompokan bubble. */
  timeoutMs?: number;
  /** Batasi rotasi kunci untuk keputusan UX yang punya jalur mundur lokal. */
  maxAttempts?: number;
  /** Pembatalan lifecycle dari pemilik request, terpisah dari timeout. */
  signal?: AbortSignal;
  /**
   * Meminta penyedia menjamin keluaran berupa JSON. Tidak semua penyedia
   * mendukungnya, jadi permintaan diulang tanpa opsi ini bila ditolak.
   */
  json?: boolean;
  /** Validasi bentuk domain lokal; tidak pernah dikirim ke provider. */
  validateResponse?: (content: string) => boolean;
  /** Metadata bebas isi dari context compiler; tidak dikirim ke provider. */
  contextManifest?: ContextManifest;
  /** Label route lokal untuk observability; tidak dikirim ke provider. */
  operation?: AiRequestOperation;
  /**
   * Metadata bebas isi untuk batas pemakaian dan pencatatan token.
   *
   * Tidak pernah berisi prompt maupun balasan.
   */
  usage?:
    | (Omit<
        AiUsageContext,
        | "requestId"
        | "turnId"
        | "model"
        | "maxTokens"
        | "inputTokenEstimate"
      > & { turnId?: string | null })
    | undefined;
}

export interface AiClientOptions {
  baseUrl: string;
  keys: ApiKeyPool;
  fallback?: AiFallbackOptions | null;
  timeoutMs?: number;
  usageObserver?: UsageObserver;
  attemptObserver?: ProviderAttemptObserver;
  /** Runtime dapat mengantrekan file ledger; probe satu-shot tetap inline. */
  bufferAttemptObserver?: boolean;
  providerId?: string;
  environment?: RuntimeEnvironment;
  costCenter?: UsageCostCenter;
  logger?: OperationalLogger;
  now?: () => number;
}

export interface AiFallbackOptions {
  baseUrl: string;
  keys: ApiKeyPool;
  model: string;
  providerId?: string;
  /** Beberapa gateway memilih model dari query meski body juga membawanya. */
  modelInQuery?: boolean;
  /** Cooldown setelah gangguan provider-wide/429 seluruh key primary habis. */
  cooldownMs?: number;
}

interface AiProviderTarget {
  origin: "primary" | "fallback";
  providerId: string;
  baseUrl: string;
  keys: ApiKeyPool;
  modelInQuery: boolean;
}

interface LogicalRequestState {
  requestId: string;
  nextAttemptNo: number;
  startedAt: number;
}

interface CompletionResult {
  content: string;
  usage: ProviderTokenUsage;
  model: string;
  responseAccepted: boolean;
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
  private readonly logger: OperationalLogger;
  private primaryUnavailableUntil = 0;

  constructor(private readonly options: AiClientOptions) {
    this.logger =
      options.logger ?? NOOP_OPERATIONAL_LOGGER.child("ai.client");
  }

  /**
   * Mengirim permintaan dan mengembalikan teks balasan.
   *
   * Ketika kuota sebuah kunci habis, permintaan diulang dengan kunci
   * berikutnya. Jumlah percobaan dibatasi sebanyak kunci yang tersedia agar
   * kegagalan tetap cepat terlihat, bukan berputar diam-diam.
   */
  async complete(request: ChatRequest): Promise<string> {
    const state: LogicalRequestState = {
      requestId: randomUUID(),
      nextAttemptNo: 1,
      startedAt: Date.now(),
    };
    const usageContext = this.logicalUsageContext(request, state.requestId);
    if (usageContext) {
      await this.options.usageObserver?.beforeRequest(usageContext);
    }

    try {
      const result = await this.dispatch(request, state);
      if (usageContext && this.options.usageObserver) {
        const settledContext = result.model === usageContext.model
          ? usageContext
          : { ...usageContext, model: result.model };
        await bestEffortUsage(
          this.options.usageObserver,
          settledContext,
          result.usage,
          result.responseAccepted,
          Date.now() - state.startedAt,
          this.logger,
        );
      }
      return result.content;
    } catch (error) {
      if (usageContext && this.options.usageObserver) {
        await bestEffortUsage(
          this.options.usageObserver,
          usageContext,
          zeroUsage(),
          false,
          Date.now() - state.startedAt,
          this.logger,
        );
      }
      throw error;
    }
  }

  private async dispatch(
    request: ChatRequest,
    state: LogicalRequestState,
  ): Promise<CompletionResult> {
    const primary: AiProviderTarget = {
      origin: "primary",
      providerId: this.options.providerId ?? "primary",
      baseUrl: this.options.baseUrl,
      keys: this.options.keys,
      modelInQuery: false,
    };
    const fallback = this.options.fallback;
    if (
      fallback &&
      !request.signal?.aborted &&
      this.primaryUnavailableUntil > this.now()
    ) {
      return this.completeWithFallback(
        request,
        fallback,
        "circuit_open",
        state,
      );
    }

    try {
      const result = await this.completeWithProvider(
        primary,
        request,
        Boolean(fallback),
        state,
      );
      this.primaryUnavailableUntil = 0;
      return result;
    } catch (primaryError) {
      if (
        !fallback ||
        request.signal?.aborted ||
        !isRetryable(primaryError)
      ) {
        this.logTerminalFailure(primary, request, primaryError);
        throw primaryError;
      }

      if (
        shouldOpenPrimaryCircuit(
          primaryError,
          request,
          primary.keys.size,
        )
      ) {
        this.primaryUnavailableUntil =
          this.now() + (fallback.cooldownMs ?? 30_000);
      }
      return this.completeWithFallback(
        request,
        fallback,
        retryReason(primaryError),
        state,
        primaryError,
      );
    }
  }

  private async completeWithFallback(
    request: ChatRequest,
    fallback: AiFallbackOptions,
    reason: string,
    state: LogicalRequestState,
    primaryError?: unknown,
  ): Promise<CompletionResult> {
    const fallbackTarget: AiProviderTarget = {
      origin: "fallback",
      providerId: fallback.providerId ?? "fallback",
      baseUrl: fallback.baseUrl,
      keys: fallback.keys,
      modelInQuery: fallback.modelInQuery ?? false,
    };
    const fallbackRequest = { ...request, model: fallback.model };
    this.logger.warn(
      "ai_fallback_activated",
      "Provider utama gagal sementara; permintaan dialihkan ke provider cadangan mode uji.",
      {
        ...this.safeRequestFields(fallbackTarget, fallbackRequest),
        reason,
        errorType:
          primaryError instanceof Error
            ? primaryError.name
            : undefined,
        status:
          primaryError instanceof AiError
            ? primaryError.status
            : undefined,
      },
    );

    try {
      return await this.completeWithProvider(
        fallbackTarget,
        fallbackRequest,
        false,
        state,
      );
    } catch (fallbackError) {
      this.logTerminalFailure(
        fallbackTarget,
        fallbackRequest,
        fallbackError,
      );
      throw fallbackError;
    }
  }

  private async completeWithProvider(
    provider: AiProviderTarget,
    request: ChatRequest,
    preferFallbackOnTransportFailure: boolean,
    state: LogicalRequestState,
  ): Promise<CompletionResult> {
    try {
      return await this.attempt(
        provider,
        request,
        preferFallbackOnTransportFailure,
        state,
      );
    } catch (error) {
      // Penyedia yang tidak mengenal mode JSON menolak dengan galat permintaan.
      // Turunkan sekali ke permintaan biasa daripada menggagalkan percakapan.
      if (request.json && isUnsupportedOption(error)) {
        this.logger.warn(
          "ai_json_mode_unsupported",
          "Penyedia menolak mode JSON; permintaan diulang tanpa mode itu.",
          this.safeRequestFields(provider, request),
        );
        return this.attempt(
          provider,
          { ...request, json: false },
          preferFallbackOnTransportFailure,
          state,
        );
      }
      throw error;
    }
  }

  private async attempt(
    provider: AiProviderTarget,
    request: ChatRequest,
    preferFallbackOnTransportFailure: boolean,
    state: LogicalRequestState,
  ): Promise<CompletionResult> {
    const attempts = Math.max(
      1,
      Math.min(
        request.maxAttempts ?? provider.keys.size,
        provider.keys.size,
      ),
    );
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.send(
          provider,
          request,
          provider.keys.take(),
          state,
        );
      } catch (error) {
        lastError = error;
        const retrying =
          !request.signal?.aborted &&
          isRetryable(error) &&
          !(
            preferFallbackOnTransportFailure &&
            isProviderWideFailure(error)
          ) &&
          attempt + 1 < attempts;
        if (retrying) {
          this.logger.warn(
            "ai_request_retrying",
            "Permintaan model gagal sementara dan akan dicoba lagi.",
            {
              ...this.safeRequestFields(provider, request),
              attempt: attempt + 1,
              maxAttempts: attempts,
              errorType:
                error instanceof Error ? error.name : typeof error,
              status: error instanceof AiError ? error.status : undefined,
            },
          );
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AiError("Permintaan ke model gagal.");
  }

  private async send(
    provider: AiProviderTarget,
    request: ChatRequest,
    apiKey: string,
    state: LogicalRequestState,
  ): Promise<CompletionResult> {
    const startedAt = Date.now();
    const attemptContext = this.attemptContext(
      provider,
      request,
      state,
      startedAt,
    );
    if (attemptContext) {
      await bestEffortAttemptStart(
        this.options.attemptObserver,
        attemptContext,
        this.logger,
        this.options.bufferAttemptObserver ?? false,
      );
    }
    let attemptFinished = false;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      };
      const response = await fetch(
        completionUrl(provider, request.model),
        {
          method: "POST",
          redirect: "error",
          headers,
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            temperature: request.temperature ?? 0.7,
            max_tokens: request.maxTokens ?? 800,
            ...(request.json
              ? { response_format: { type: "json_object" } }
              : {}),
          }),
          signal: request.signal
            ? AbortSignal.any([controller.signal, request.signal])
            : controller.signal,
        },
      );

      if (!response.ok) {
        throw new AiError(
          `Model menolak permintaan (${response.status}).`,
          response.status,
        );
      }

      const payload: unknown = await response.json();
      const tokenUsage = readTokenUsage(payload, request);
      const finishReason = readFinishReason(payload);

      try {
        const content = readContent(payload);
        const responseAccepted = validateProviderContent(
          request.validateResponse,
          content,
        );
        if (attemptContext) {
          attemptFinished = true;
          await bestEffortAttemptFinish(
            this.options.attemptObserver,
            attemptContext,
            {
              finishedAt: new Date(this.now()).toISOString(),
              status: "completed",
              httpStatus: response.status,
              responseOutcome: responseAccepted
                ? "accepted"
                : "schema_rejected",
              finishReason,
              latencyMs: Date.now() - startedAt,
              usage: tokenUsage,
            },
            this.logger,
            this.options.bufferAttemptObserver ?? false,
          );
        }
        this.logger.info(
          "ai_request_completed",
          "Permintaan model selesai.",
          {
            ...this.safeRequestFields(provider, request),
            durationMs: Date.now() - startedAt,
            succeeded: responseAccepted,
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens,
            tokenUsageEstimated: tokenUsage.estimated,
            ...inputTokenCalibrationFields(request, tokenUsage),
          },
        );
        return {
          content,
          usage: tokenUsage,
          model: request.model,
          responseAccepted,
        };
      } catch (error) {
        if (attemptContext && !attemptFinished) {
          attemptFinished = true;
          await bestEffortAttemptFinish(
            this.options.attemptObserver,
            attemptContext,
            {
              finishedAt: new Date(this.now()).toISOString(),
              status: "response_rejected",
              httpStatus: response.status,
              responseOutcome: responseOutcomeForError(error),
              finishReason,
              latencyMs: Date.now() - startedAt,
              usage: tokenUsage,
            },
            this.logger,
            this.options.bufferAttemptObserver ?? false,
          );
        }
        throw error;
      }
    } catch (error) {
      if (attemptContext && !attemptFinished) {
        attemptFinished = true;
        await bestEffortAttemptFinish(
          this.options.attemptObserver,
          attemptContext,
          attemptFailure(error, request, controller.signal, startedAt, this.now()),
          this.logger,
          this.options.bufferAttemptObserver ?? false,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private logicalUsageContext(
    request: ChatRequest,
    requestId: string,
  ): AiUsageContext | null {
    if (!request.usage) return null;
    return {
      ...request.usage,
      requestId,
      turnId: request.usage.turnId ?? null,
      subjectKind:
        request.usage.subjectKind ?? inferSubjectKind(request.usage.ownerId),
      channel: request.usage.channel ?? inferChannel(request.usage.ownerId),
      model: request.model,
      maxTokens: request.maxTokens ?? 800,
      inputTokenEstimate: estimateInputTokens(request.messages),
    };
  }

  private attemptContext(
    provider: AiProviderTarget,
    request: ChatRequest,
    state: LogicalRequestState,
    startedAt: number,
  ): ProviderAttemptStart | null {
    if (!request.usage) return null;
    const attemptNo = state.nextAttemptNo;
    state.nextAttemptNo += 1;
    return {
      attemptId: randomUUID(),
      requestId: state.requestId,
      turnId: request.usage.turnId ?? null,
      attemptNo,
      ownerId: request.usage.ownerId,
      subjectKind:
        request.usage.subjectKind ?? inferSubjectKind(request.usage.ownerId),
      channel: request.usage.channel ?? inferChannel(request.usage.ownerId),
      actorAliases: request.usage.actorAliases ?? [],
      providerId: provider.providerId,
      origin: provider.origin,
      modelId: request.model,
      tier: request.usage.tier,
      purpose: request.usage.purpose,
      environment: this.options.environment ?? "development",
      costCenter: this.options.costCenter ?? "runtime",
      maxOutputTokens: request.maxTokens ?? 800,
      inputTokenEstimate: estimateInputTokens(request.messages),
      safetyCritical: request.usage.safetyCritical,
      startedAt: new Date(startedAt).toISOString(),
    };
  }

  private safeRequestFields(
    provider: AiProviderTarget,
    request: ChatRequest,
  ): Record<string, unknown> {
    return {
      origin: provider.origin,
      provider: provider.providerId,
      model: request.model,
      purpose: request.usage?.purpose,
      operation: request.operation,
      tier: request.usage?.tier,
      jsonMode: request.json ?? false,
      maxTokens: request.maxTokens ?? 800,
      inputTokenEstimate: estimateInputTokens(request.messages),
      ...(request.contextManifest
        ? contextManifestLogFields(request.contextManifest)
        : {}),
      timeoutMs:
        request.timeoutMs ??
        this.options.timeoutMs ??
        DEFAULT_TIMEOUT_MS,
    };
  }

  private logTerminalFailure(
    provider: AiProviderTarget,
    request: ChatRequest,
    error: unknown,
  ): void {
    if (request.signal?.aborted) {
      this.logger.info(
        "ai_request_cancelled",
        "Permintaan model dibatalkan oleh lifecycle pemilik request.",
        {
          ...this.safeRequestFields(provider, request),
          reason: "lifecycle",
        },
      );
      return;
    }
    this.logger.error(
      "ai_request_failed",
      "Permintaan model gagal.",
      error,
      this.safeRequestFields(provider, request),
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function completionUrl(
  provider: AiProviderTarget,
  model: string,
): string {
  let url: URL;
  try {
    url = new URL(
      `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    );
  } catch {
    throw new AiError("Base URL model tidak sah.");
  }
  if (provider.modelInQuery) {
    url.searchParams.set("model", model);
  }
  return url.toString();
}

async function bestEffortUsage(
  observer: UsageObserver,
  context: AiUsageContext,
  usage: TokenUsage,
  succeeded: boolean,
  latencyMs: number,
  logger: OperationalLogger,
): Promise<void> {
  try {
    await observer.afterRequest(context, usage, { succeeded, latencyMs });
  } catch (error) {
    // Observabilitas tidak boleh mengubah keberhasilan percakapan.
    logger.warn(
      "ai_usage_record_failed",
      "Pencatatan pemakaian model gagal tanpa menggagalkan percakapan.",
      {
        purpose: context.purpose,
        tier: context.tier,
        error,
      },
    );
  }
}

async function bestEffortAttemptStart(
  observer: ProviderAttemptObserver | undefined,
  context: ProviderAttemptStart,
  logger: OperationalLogger,
  buffered: boolean,
): Promise<void> {
  if (!observer) return;
  // Observer mengantrekan start/finish secara berurutan dan drain menjadi
  // durability barrier. Rewrite ledger lokal tidak boleh menambah latensi
  // sebelum request provider dikirim.
  const recording = observer.startAttempt(context);
  if (!buffered) {
    try {
      await recording;
      return;
    } catch (error) {
      warnAttemptStart(logger, context, error);
      return;
    }
  }
  void recording.catch((error: unknown) => {
    warnAttemptStart(logger, context, error);
  });
}

function warnAttemptStart(
  logger: OperationalLogger,
  context: ProviderAttemptStart,
  error: unknown,
): void {
    logger.warn(
      "ai_attempt_start_record_failed",
      "Awal attempt provider gagal dicatat; request tetap dilanjutkan.",
      {
        purpose: context.purpose,
        tier: context.tier,
        origin: context.origin,
        error,
      },
    );
}
async function bestEffortAttemptFinish(
  observer: ProviderAttemptObserver | undefined,
  context: ProviderAttemptStart,
  result: ProviderAttemptFinish,
  logger: OperationalLogger,
  buffered: boolean,
): Promise<void> {
  if (!observer) return;
  const recording = observer.finishAttempt(context, result);
  if (!buffered) {
    try {
      await recording;
      return;
    } catch (error) {
      warnAttemptFinish(logger, context, error);
      return;
    }
  }
  void recording.catch((error: unknown) => {
    warnAttemptFinish(logger, context, error);
  });
}

function warnAttemptFinish(
  logger: OperationalLogger,
  context: ProviderAttemptStart,
  error: unknown,
): void {
    logger.warn(
      "ai_attempt_finish_record_failed",
      "Hasil attempt provider gagal dicatat; percakapan tidak digagalkan.",
      {
        purpose: context.purpose,
        tier: context.tier,
        origin: context.origin,
        error,
      },
    );
}
function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimated: true,
  };
}

function zeroProviderUsage(): ProviderTokenUsage {
  return {
    ...zeroUsage(),
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    providerCostUsd: null,
    providerGenerationId: null,
  };
}

function readTokenUsage(
  payload: unknown,
  request: ChatRequest,
): ProviderTokenUsage {
  const usage = (
    payload as {
      id?: unknown;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        cost?: unknown;
        cost_details?: { upstream_inference_cost?: unknown };
        prompt_tokens_details?: {
          cached_tokens?: unknown;
          cache_read_tokens?: unknown;
          cache_write_tokens?: unknown;
        };
        completion_tokens_details?: { reasoning_tokens?: unknown };
      };
    }
  )?.usage;
  const input = nonNegativeInteger(usage?.prompt_tokens);
  const output = nonNegativeInteger(usage?.completion_tokens);
  const total = nonNegativeInteger(usage?.total_tokens);

  if (input !== null && output !== null) {
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: Math.max(total ?? 0, input + output),
      estimated: false,
      reasoningTokens: nonNegativeInteger(
        usage?.completion_tokens_details?.reasoning_tokens,
      ),
      cacheReadTokens:
        nonNegativeInteger(usage?.prompt_tokens_details?.cached_tokens) ??
        nonNegativeInteger(usage?.prompt_tokens_details?.cache_read_tokens),
      cacheWriteTokens: nonNegativeInteger(
        usage?.prompt_tokens_details?.cache_write_tokens,
      ),
      providerCostUsd:
        decimalCost(usage?.cost) ??
        decimalCost(usage?.cost_details?.upstream_inference_cost),
      providerGenerationId: providerGenerationId(payload),
    };
  }

  // Sebagian endpoint kompatibel OpenAI tidak mengembalikan `usage`. Angka
  // ini hanya untuk pagar biaya kasar dan ditandai sebagai estimasi.
  const inputEstimate = estimateInputTokens(request.messages);
  const content = (
    payload as { choices?: { message?: { content?: unknown } }[] }
  )?.choices?.[0]?.message?.content;
  const outputEstimate =
    typeof content === "string" ? Math.ceil(content.length / 4) : 0;

  return {
    inputTokens: inputEstimate,
    outputTokens: outputEstimate,
    totalTokens: inputEstimate + outputEstimate,
    estimated: true,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    providerCostUsd:
      decimalCost(usage?.cost) ??
      decimalCost(usage?.cost_details?.upstream_inference_cost),
    providerGenerationId: providerGenerationId(payload),
  };
}

function readFinishReason(payload: unknown): string | null {
  const value = (
    payload as { choices?: { finish_reason?: unknown }[] }
  )?.choices?.[0]?.finish_reason;
  return typeof value === "string" ? value : null;
}

function estimateInputTokens(messages: ChatMessage[]): number {
  return Math.ceil(
    messages.reduce((sum, message) => sum + message.content.length, 0) / 4,
  );
}

function inputTokenCalibrationFields(
  request: ChatRequest,
  usage: ProviderTokenUsage,
): Record<string, number> {
  if (usage.estimated) return {};
  const estimate = estimateInputTokens(request.messages);
  return {
    inputTokenEstimateErrorTokens: estimate - usage.inputTokens,
    ...(usage.inputTokens > 0
      ? {
          // 1.000 berarti tepat; <1.000 under-estimate, >1.000 over-estimate.
          inputTokenEstimateRatioPermille: Math.round(
            (estimate / usage.inputTokens) * 1_000,
          ),
        }
      : {}),
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : null;
}

function decimalCost(value: unknown): string | null {
  if (typeof value === "string") {
    const clean = value.trim();
    return /^\d+(?:\.\d+)?$/u.test(clean) && clean.length <= 64
      ? clean
      : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value
    .toFixed(12)
    .replace(/0+$/u, "")
    .replace(/\.$/u, "");
}

function providerGenerationId(payload: unknown): string | null {
  const value = (payload as { id?: unknown })?.id;
  return typeof value === "string" ? value : null;
}

function responseOutcomeForError(
  error: unknown,
): ProviderAttemptFinish["responseOutcome"] {
  return error instanceof AiError && error.message.includes("terpotong")
    ? "truncated"
    : "empty";
}

function validateProviderContent(
  validator: ChatRequest["validateResponse"],
  content: string,
): boolean {
  if (!validator) return true;
  try {
    return validator(content) === true;
  } catch {
    return false;
  }
}

function attemptFailure(
  error: unknown,
  request: ChatRequest,
  timeoutSignal: AbortSignal,
  startedAt: number,
  finishedAt: number,
): ProviderAttemptFinish {
  let status: ProviderAttemptFinish["status"] = "unknown";
  if (request.signal?.aborted) status = "cancelled";
  else if (timeoutSignal.aborted) status = "timeout";
  else if (error instanceof AiError && error.status !== undefined) {
    status = "http_error";
  } else if (error instanceof TypeError) {
    status = "network_error";
  }
  return {
    finishedAt: new Date(finishedAt).toISOString(),
    status,
    httpStatus: error instanceof AiError ? error.status ?? null : null,
    responseOutcome: "not_checked",
    finishReason: null,
    latencyMs: Math.max(0, finishedAt - startedAt),
    usage: zeroProviderUsage(),
  };
}

function inferSubjectKind(ownerId: string): "private" | "group" {
  return ownerId.startsWith("whatsapp:") || ownerId.startsWith("telegram:")
    ? "group"
    : "private";
}

function inferChannel(
  ownerId: string,
): "telegram" | "whatsapp" | "system" {
  return ownerId.startsWith("whatsapp:") ? "whatsapp" : "telegram";
}

function readContent(payload: unknown): string {
  const choice = (
    payload as {
      choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
    }
  )?.choices?.[0];

  const content = choice?.message?.content;

  // Balasan yang terpotong tampak seperti balasan rusak di lapisan atas, dan
  // penyebabnya tidak terlihat sama sekali. Model penalaran menghabiskan jatah
  // token untuk berpikir, lalu jawabannya terpenggal di tengah.
  if (choice?.finish_reason === "length") {
    throw new AiError(
      "Balasan model terpotong karena batas token (finish_reason=length). " +
        "Naikkan maxTokens untuk permintaan ini.",
    );
  }

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

  // Timeout dan gangguan jaringan. Galat kebijakan lokal (misalnya batas
  // pemakaian) bukan alasan memutar kunci dan mencoba permintaan yang sama.
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error instanceof TypeError)
  );
}

function isProviderWideFailure(error: unknown): boolean {
  return (
    (error instanceof AiError &&
      error.status !== undefined &&
      error.status >= 500) ||
    (error instanceof Error &&
      (error.name === "AbortError" || error instanceof TypeError))
  );
}

function shouldOpenPrimaryCircuit(
  error: unknown,
  request: ChatRequest,
  primaryKeyCount: number,
): boolean {
  if (isProviderWideFailure(error)) return true;
  if (!(error instanceof AiError) || error.status !== 429) return false;

  const attempts = Math.max(
    1,
    Math.min(
      request.maxAttempts ?? primaryKeyCount,
      primaryKeyCount,
    ),
  );
  return attempts >= primaryKeyCount;
}

function retryReason(error: unknown): string {
  if (error instanceof AiError) {
    if (error.status === 429) return "rate_limit";
    if (error.status !== undefined && error.status >= 500) {
      return "provider_server";
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "timeout";
  }
  if (error instanceof TypeError) return "network";
  return "temporary_failure";
}
