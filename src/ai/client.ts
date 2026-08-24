import { randomUUID } from "node:crypto";
import { ApiKeyPool } from "./key-pool.js";
import type { ResolvedFundingContext } from "../domain/economy.js";
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
import type { ExecutionPlan } from "../core/execution-policy.js";
import type { RunBudgetAccount } from "../core/run-budget.js";
import type { ModelProfile, ModelProfileRegistry } from "./model-profile.js";
import {
  bindProviderToolCall,
  serializeProviderMessages,
  serializeProviderOptions,
} from "./provider-adapter.js";
import {
  BoundedResponseBodyError,
  readBoundedResponseBody,
} from "../transport/bounded-response-body.js";

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
export interface ChatTextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Respons assistant yang harus diputar ulang sebelum hasil tool. */
export interface ChatAssistantToolMessage {
  role: "assistant";
  content: string | null;
  tool_calls: readonly ChatToolCall[];
  /** Binding + reasoning provider hanya hidup pada transcript invocation aktif. */
  continuation?: AssistantContinuation;
}

export interface ProviderModelBinding {
  providerId: string;
  modelId: string;
}

export interface AssistantContinuation extends ProviderModelBinding {
  /** Binding mencegah metadata reasoning diputar pada provider/model lain. */
  reasoning?: string;
  reasoningContent?: string;
  reasoningDetails?: readonly unknown[];
}

/** Hasil executor lokal pada continuation native chat-completions. */
export interface ChatToolResultMessage {
  role: "tool";
  tool_call_id: string;
  name?: string;
  content: string;
}

export type ChatMessage =
  | ChatTextMessage
  | ChatAssistantToolMessage
  | ChatToolResultMessage;

/** Function tool pada wire protocol chat-completions kompatibel OpenAI. */
export interface ChatFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Readonly<Record<string, unknown>>;
  };
}

export type ChatToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      function: { name: string };
    };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON arguments sebagaimana dikirim provider; parser domain tetap wajib. */
    arguments: string;
  };
  /** Metadata Gemini yang wajib diputar ulang persis pada continuation. */
  extra_content?: {
    google: {
      thought_signature: string;
    };
  };
}

export type ChatCompletion =
  | { kind: "text"; content: string }
  | {
      kind: "tool_calls";
      /** Alias lama dipertahankan untuk consumer yang hanya perlu call. */
      toolCalls: readonly ChatToolCall[];
      assistant: ChatAssistantToolMessage;
    };

export type AiRequestOperation =
  | "group-ingress"
  | "group-plan-ambient"
  | "group-revalidate-ambient"
  | "group-reply"
  | "private-operation-presentation"
  | "private-checkin-presentation";

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
  /** Trusted caller may forbid provider fallback for exact-bound stages. */
  fallbackPolicy?: "configured" | "disabled";
  /** Pembatalan lifecycle dari pemilik request, terpisah dari timeout. */
  signal?: AbortSignal;
  /**
   * Meminta penyedia menjamin keluaran berupa JSON. Tidak semua penyedia
   * mendukungnya, jadi permintaan diulang tanpa opsi ini bila ditolak.
   */
  json?: boolean;
  /** Validasi bentuk domain lokal; tidak pernah dikirim ke provider. */
  validateResponse?: (content: string) => boolean;
  /** Native function tools yang boleh diusulkan model pada request ini. */
  tools?: readonly ChatFunctionTool[];
  /** Dikirim sebagai `tool_choice`; planner Harvy memakai `required`. */
  toolChoice?: ChatToolChoice;
  /** Planner Harvy selalu false agar satu langkah berarti satu keputusan. */
  parallelToolCalls?: boolean;
  /** Validasi tool call domain lokal; tidak pernah dikirim ke provider. */
  validateToolCalls?: (toolCalls: readonly ChatToolCall[]) => boolean;
  /** Metadata bebas isi dari context compiler; tidak dikirim ke provider. */
  contextManifest?: ContextManifest;
  /** Keputusan kode; prompt dan model tidak dapat mengubah metadata ini. */
  execution?: ExecutionPlan;
  /** Akun kumulatif logical run; object lokal ini tidak pernah masuk wire. */
  runBudget?: RunBudgetAccount;
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
  /** Registry capability provider+model yang diverifikasi composition root. */
  modelProfiles?: ModelProfileRegistry;
  now?: () => number;
  /** Hard byte cap sebelum response provider dibuffer/di-parse. */
  maxResponseBytes?: number;
  /** Resolver BYOK mengembalikan secret hanya untuk invocation provider aktif. */
  fundingCredentialResolver?: (
    funding: ResolvedFundingContext,
    ownerId: string,
  ) => Promise<FundingCredential | null>;
}

export interface FundingCredential {
  credentialRef: string;
  providerId: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
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
  funding: ResolvedFundingContext | null;
}

interface CompletionResult {
  completion: ChatCompletion;
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

export type AiResponseFailureReason = "truncated" | "incomplete";

/**
 * Kegagalan terminal response yang sudah mencapai provider. Type terpisah
 * mencegah lapisan orkestrasi menebak recovery dari copy error atau mencoba
 * ulang content filter sebagai truncation biasa.
 */
export class AiResponseError extends AiError {
  constructor(
    readonly reason: AiResponseFailureReason,
    readonly finishReason: string | null,
    message: string,
  ) {
    super(message);
    this.name = "AiResponseError";
  }
}

/** Terminal BYOK failure never authorizes a silent Harvy-funded fallback. */
export class ByokProviderError extends AiError {
  constructor() {
    super(
      "Provider BYOK tidak dapat menyelesaikan pekerjaan ini. Pilih model/provider BYOK lain atau izinkan sumber compute Harvy secara eksplisit.",
    );
    this.name = "ByokProviderError";
  }
}

export function isTruncatedAiResponse(error: unknown): error is AiResponseError {
  return error instanceof AiResponseError && error.reason === "truncated";
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_NATIVE_TOOLS = 32;
const MAX_NATIVE_TOOL_SCHEMA_CHARACTERS = 64_000;
const MAX_NATIVE_TOOL_CALLS = 8;
const MAX_NATIVE_TOOL_ARGUMENT_CHARACTERS = 32_000;
const MAX_NATIVE_THOUGHT_SIGNATURE_CHARACTERS = 64_000;
const MAX_REASONING_CONTINUATION_CHARACTERS = 256_000;
const MAX_REASONING_DETAILS_CHARACTERS = 512_000;
const MAX_REASONING_DETAILS_DEPTH = 32;
const MAX_REASONING_DETAILS_NODES = 8_192;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024 * 1024;

export class AiClient {
  private readonly logger: OperationalLogger;
  private readonly maxResponseBytes: number;
  private primaryUnavailableUntil = 0;

  constructor(private readonly options: AiClientOptions) {
    this.logger =
      options.logger ?? NOOP_OPERATIONAL_LOGGER.child("ai.client");
    this.maxResponseBytes = providerResponseBytes(
      options.maxResponseBytes ?? MAX_PROVIDER_RESPONSE_BYTES,
    );
  }

  /**
   * Mengirim permintaan dan mengembalikan teks balasan.
   *
   * Ketika kuota sebuah kunci habis, permintaan diulang dengan kunci
   * berikutnya. Jumlah percobaan dibatasi sebanyak kunci yang tersedia agar
   * kegagalan tetap cepat terlihat, bukan berputar diam-diam.
   */
  async complete(request: ChatRequest): Promise<string> {
    if (request.tools) {
      throw new AiError(
        "Permintaan native tool harus memakai completeToolCalls().",
      );
    }
    const result = await this.perform(request);
    if (result.completion.kind !== "text") {
      throw new AiError(
        "Model memanggil tool pada permintaan yang mengharapkan teks.",
      );
    }
    return result.completion.content;
  }

  /**
   * Mengirim native function tools dan hanya menerima satu atau lebih
   * `tool_calls`. Pemilihan capability tetap divalidasi harness; klien ini
   * hanya menjaga kontrak wire provider.
   *
   * Hanya untuk konsumsi one-shot/kompatibilitas. Loop yang akan mengirim hasil
   * tool kembali ke model wajib memakai `completeToolTurn()` agar metadata
   * assistant-level tidak dibuang.
   */
  async completeToolCalls(
    request: ChatRequest & { tools: readonly ChatFunctionTool[] },
  ): Promise<readonly ChatToolCall[]> {
    return (await this.completeToolTurn(request)).tool_calls;
  }

  /**
   * Mengembalikan assistant turn utuh agar reasoning continuation tidak hilang
   * sebelum hasil tool diputar ulang. Wrapper lama tetap tersedia di atas.
   */
  async completeToolTurn(
    request: ChatRequest & { tools: readonly ChatFunctionTool[] },
  ): Promise<ChatAssistantToolMessage> {
    const normalizedRequest = {
      ...request,
      toolChoice: request.toolChoice ?? "required",
      parallelToolCalls: request.parallelToolCalls ?? false,
    };
    assertNativeToolRequest(normalizedRequest);
    const result = await this.perform(normalizedRequest);
    if (result.completion.kind !== "tool_calls") {
      throw new AiError(
        "Model tidak menghasilkan native tool call yang diwajibkan.",
      );
    }
    const assistant = result.completion.assistant;
    const calls = assistant.tool_calls;
    const availableNames = new Set(
      normalizedRequest.tools.map((tool) => tool.function.name),
    );
    if (calls.some((call) => !availableNames.has(call.function.name))) {
      throw new AiError("Model memanggil native tool yang tidak tersedia.");
    }
    if (!normalizedRequest.parallelToolCalls && calls.length !== 1) {
      throw new AiError("Model mengembalikan lebih dari satu native tool call.");
    }
    const selectedToolName = typeof normalizedRequest.toolChoice === "object"
      ? normalizedRequest.toolChoice.function.name
      : null;
    if (
      selectedToolName !== null &&
      calls.some((call) => call.function.name !== selectedToolName)
    ) {
      throw new AiError("Model mengabaikan native tool_choice yang ditetapkan.");
    }
    return assistant;
  }

  private async perform(request: ChatRequest): Promise<CompletionResult> {
    const state: LogicalRequestState = {
      requestId: randomUUID(),
      nextAttemptNo: 1,
      startedAt: Date.now(),
      funding: null,
    };
    const usageContext = this.logicalUsageContext(request, state.requestId);
    if (usageContext) {
      const funding = await this.options.usageObserver?.beforeRequest(usageContext);
      state.funding = funding && "reservationId" in funding ? funding : null;
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
      return result;
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
    if (
      request.fallbackPolicy !== undefined &&
      request.fallbackPolicy !== "configured" &&
      request.fallbackPolicy !== "disabled"
    ) {
      throw new AiError("Kebijakan fallback request tidak sah.");
    }
    let effectiveRequest = request;
    let primary: AiProviderTarget = {
      origin: "primary",
      providerId: this.options.providerId ?? "primary",
      baseUrl: this.options.baseUrl,
      keys: this.options.keys,
      modelInQuery: false,
    };
    if (state.funding?.source === "byok") {
      const credential = await this.options.fundingCredentialResolver?.(
        state.funding,
        request.usage?.ownerId ?? "",
      );
      if (!credential || credential.credentialRef !== state.funding.providerCredentialRef) {
        throw new AiError("Credential BYOK tidak tersedia atau sudah dicabut.");
      }
      effectiveRequest = {
        ...request,
        model: credential.modelId,
        // A user-owned provider may expose a model absent from Harvy's
        // catalog. Keep the trusted budget/role shape, but do not claim a
        // provider-specific reasoning wire capability we have not verified.
        ...(request.execution
          ? {
              execution: {
                ...request.execution,
                effectiveEffort: null,
              },
            }
          : {}),
      };
      primary = {
        origin: "primary",
        providerId: credential.providerId,
        baseUrl: credential.baseUrl,
        keys: new ApiKeyPool([credential.apiKey]),
        modelInQuery: false,
      };
    }
    // Native tool support belum dibuktikan pada provider cadangan. Jangan
    // mengubah wire contract diam-diam saat circuit fallback terbuka.
    const fallback = state.funding?.source === "byok" || request.tools || request.fallbackPolicy === "disabled"
      ? undefined
      : this.options.fallback;
    if (
      fallback &&
      !request.signal?.aborted &&
      this.primaryUnavailableUntil > this.now()
    ) {
      return this.completeWithFallback(
        effectiveRequest,
        fallback,
        "circuit_open",
        state,
      );
    }

    try {
      const result = await this.completeWithProvider(
        primary,
        effectiveRequest,
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
        if (state.funding?.source === "byok" && !request.signal?.aborted) {
          throw new ByokProviderError();
        }
        throw primaryError;
      }

      if (
        shouldOpenPrimaryCircuit(
          primaryError,
          effectiveRequest,
          primary.keys.size,
        )
      ) {
        this.primaryUnavailableUntil =
          this.now() + (fallback.cooldownMs ?? 30_000);
      }
      return this.completeWithFallback(
        effectiveRequest,
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
    const fallbackProfile = this.options.modelProfiles?.get(
      fallbackTarget.providerId,
      fallback.model,
    ) ?? null;
    if (fallbackProfile?.verification === "explicit") {
      throw new AiError(
        "Capability explicit provider fallback belum didukung.",
      );
    }
    const fallbackRequest: ChatRequest = {
      ...request,
      model: fallback.model,
      // Capability reasoning fallback belum diprofilkan. Pertahankan request
      // pengguna, tetapi jangan menebak field wire provider cadangan.
      ...(request.execution
        ? {
            execution: {
              ...request.execution,
              effectiveEffort: null,
            },
          }
        : {}),
    };
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
    const keyAttempts = Math.max(
      1,
      Math.min(
        request.maxAttempts ?? provider.keys.size,
        provider.keys.size,
      ),
    );
    // Missing finish metadata kadang terjadi pada respons HTTP 200 yang valid
    // secara transport. Setelah seluruh key mendapat giliran, permintaan umum
    // memperoleh satu recovery bounded. `maxAttempts` eksplisit tetap keras
    // untuk classifier berdeadline pendek seperti turn boundary.
    let incompleteRecoveryAttempts = request.maxAttempts === undefined ? 1 : 0;

    for (let attempt = 0;; attempt += 1) {
      try {
        return await this.send(
          provider,
          request,
          state,
        );
      } catch (error) {
        const keyRotationAvailable = attempt + 1 < keyAttempts;
        const boundedIncompleteRecovery =
          !keyRotationAvailable &&
          incompleteRecoveryAttempts > 0 &&
          isMissingTerminalMarker(error);
        if (boundedIncompleteRecovery) incompleteRecoveryAttempts -= 1;
        const retrying =
          !request.signal?.aborted &&
          isRetryable(error) &&
          !(
            preferFallbackOnTransportFailure &&
            isProviderWideFailure(error)
          ) &&
          (keyRotationAvailable || boundedIncompleteRecovery);
        if (retrying) {
          this.logger.warn(
            "ai_request_retrying",
            "Permintaan model gagal sementara dan akan dicoba lagi.",
            {
              ...this.safeRequestFields(provider, request),
              attempt: attempt + 1,
              maxAttempts: keyAttempts +
                (request.maxAttempts === undefined ? 1 : 0),
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
  }

  private async send(
    provider: AiProviderTarget,
    request: ChatRequest,
    state: LogicalRequestState,
  ): Promise<CompletionResult> {
    const registry = this.options.modelProfiles;
    const profile = registry?.get(
      provider.providerId,
      request.model,
    ) ?? null;
    const allowUnprofiledByok =
      state.funding?.source === "byok" && provider.origin === "primary";
    if (registry && !profile && !allowUnprofiledByok) {
      throw new AiError(
        `Profile model tidak terdaftar: ${provider.providerId}/${request.model}.`,
      );
    }
    const timeoutMs = this.requestTimeoutMs(request);
    assertExecutionRequest(request, profile, timeoutMs);
    const providerMessages = serializeProviderMessages(request.messages, {
      providerId: provider.providerId,
      modelId: request.model,
      profile,
    });
    const providerOptions = serializeProviderOptions({
      providerId: provider.providerId,
      modelId: request.model,
      profile,
      execution: request.execution ?? null,
      temperature: request.temperature ?? 0.7,
    });
    const budgetReservation = request.runBudget?.reserveModelCall({
      tier: request.execution!.tier,
      budgetClass: request.execution!.budgetClass,
      inputTokenEstimate: estimateChatRequestInputTokens(request),
      maxOutputTokens: request.maxTokens ?? 800,
    });
    const apiKey = provider.keys.take();

    // Validasi request/continuation harus selesai sebelum sebuah attempt
    // dicatat. Request lokal yang ditolak tidak boleh meninggalkan record
    // `started` yang seolah-olah pernah mencapai provider.
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
    let budgetSettled = false;
    let observedProviderCostUsd: string | null = null;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs,
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
            messages: providerMessages,
            ...providerOptions,
            max_tokens: request.maxTokens ?? 800,
            ...(request.json && profile?.supports.structuredOutput !== false
              ? { response_format: { type: "json_object" } }
              : {}),
            ...(request.tools
              ? {
                  tools: request.tools,
                  ...(profile?.supports.toolChoice === false
                    ? {}
                    : {
                        tool_choice: request.toolChoice ?? "auto",
                        parallel_tool_calls:
                          request.parallelToolCalls ?? false,
                      }),
                }
              : {}),
          }),
          signal: request.signal
            ? AbortSignal.any([controller.signal, request.signal])
            : controller.signal,
        },
      );

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // 429/4xx lain adalah penolakan request yang teramati. Timeout HTTP
        // dan 5xx dapat terjadi setelah provider mulai bekerja, jadi usage-nya
        // tetap dianggap unknown secara konservatif.
        if (response.status === 408 || response.status >= 500) {
          budgetReservation?.consumeUnknown();
        } else {
          budgetReservation?.release();
        }
        budgetSettled = true;
        throw new AiError(
          `Model menolak permintaan (${response.status}).`,
          response.status,
        );
      }

      let responseBytes: Buffer;
      try {
        responseBytes = await readBoundedResponseBody(
          response,
          this.maxResponseBytes,
        );
      } catch (error) {
        if (error instanceof BoundedResponseBodyError) {
          throw new AiError(
            error.reason === "too_large"
              ? "Respons model melewati batas ukuran aman."
              : "Content-Length respons model tidak sah.",
          );
        }
        throw error;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(responseBytes),
        ) as unknown;
      } catch {
        throw new AiError("Respons model bukan JSON UTF-8 yang sah.");
      }
      const finishReason = readFinishReason(payload);
      observedProviderCostUsd = readProviderCost(payload);
      const tokenUsage = readTokenUsage(payload, request);
      // Tanpa usage provider, output yang berhenti karena batas/penolakan tidak
      // boleh dinilai hanya dari fragmen teks yang terlihat. Status inference
      // akhirnya ambigu, jadi tahan reservation penuh.
      const estimatedTerminalUsage = tokenUsage.estimated &&
        (finishReason === "stop" || finishReason === "tool_calls");
      if (tokenUsage.estimated && !estimatedTerminalUsage) {
        budgetReservation?.consumeUnknown(observedProviderCostUsd);
        budgetSettled = true;
      } else if (!tokenUsage.estimated) {
        budgetReservation?.settle(tokenUsage, observedProviderCostUsd);
        budgetSettled = true;
      }

      try {
        const completion = readCompletion(
          payload,
          provider.providerId,
          request.model,
          profile,
        );
        const responseAccepted = validateProviderCompletion(
          request,
          completion,
        );
        if (estimatedTerminalUsage) {
          budgetReservation?.settle(tokenUsage, observedProviderCostUsd);
          budgetSettled = true;
        }
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
          completion,
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
      if (!budgetSettled) {
        // Timeout/network/response 2xx yang tidak dapat dibaca dapat saja sudah
        // memakai inference. Reservation penuh ditahan agar retry tidak
        // melewati batas kumulatif secara optimistis.
        budgetReservation?.consumeUnknown(observedProviderCostUsd);
        budgetSettled = true;
      }
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
      inputTokenEstimate: estimateChatRequestInputTokens(request),
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
      inputTokenEstimate: estimateChatRequestInputTokens(request),
      safetyCritical: request.usage.safetyCritical,
      ...(state.funding
        ? { fundingSource: state.funding.source }
        : {}),
      startedAt: new Date(startedAt).toISOString(),
      ...(request.execution
        ? {
            modelRole: request.execution.role,
            requestedEffort: request.execution.requestedEffort,
            effectiveEffort: request.execution.effectiveEffort,
            verbosity: request.execution.verbosity,
            ...(request.execution.routeTier
              ? { routeTier: request.execution.routeTier }
              : {}),
            ...(request.execution.routeReason
              ? { routeReason: request.execution.routeReason }
              : {}),
            ...(request.execution.escalationReason
              ? { escalationReason: request.execution.escalationReason }
              : {}),
            ...(request.execution.promptMaterial
              ? { promptMaterial: request.execution.promptMaterial }
              : {}),
            ...(request.execution.sourcePrivacyDomain
              ? { sourcePrivacyDomain: request.execution.sourcePrivacyDomain }
              : {}),
            ...(request.execution.targetPrivacyDomain
              ? { targetPrivacyDomain: request.execution.targetPrivacyDomain }
              : {}),
          }
        : {}),
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
      nativeToolCount: request.tools?.length ?? 0,
      nativeToolChoice:
        typeof request.toolChoice === "string"
          ? request.toolChoice
          : request.toolChoice
            ? "named"
            : "none",
      parallelToolCalls: request.parallelToolCalls ?? false,
      maxTokens: request.maxTokens ?? 800,
      inputTokenEstimate: estimateChatRequestInputTokens(request),
      modelRole: request.execution?.role,
      requestedEffort: request.execution?.requestedEffort,
      effectiveEffort: request.execution?.effectiveEffort,
      verbosity: request.execution?.verbosity,
      routeTier: request.execution?.routeTier,
      routeReason: request.execution?.routeReason,
      escalationReason: request.execution?.escalationReason,
      promptMaterial: request.execution?.promptMaterial,
      sourcePrivacyDomain: request.execution?.sourcePrivacyDomain,
      targetPrivacyDomain: request.execution?.targetPrivacyDomain,
      ...(request.contextManifest
        ? contextManifestLogFields(request.contextManifest)
        : {}),
      timeoutMs: this.requestTimeoutMs(request),
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

  private requestTimeoutMs(request: ChatRequest): number {
    if (request.timeoutMs !== undefined) return request.timeoutMs;
    const configured = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return request.execution
      ? Math.min(configured, request.execution.deadlineMs)
      : configured;
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

function providerResponseBytes(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1_024 ||
    value > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new AiError("Batas byte respons model tidak sah.");
  }
  return value;
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
  const usageRecord = usage !== null && typeof usage === "object"
    ? usage
    : null;
  const totalFieldPresent = usageRecord !== null &&
    Object.hasOwn(usageRecord, "total_tokens");
  const tokenFieldsPresent = usageRecord !== null &&
    (
      Object.hasOwn(usageRecord, "prompt_tokens") ||
      Object.hasOwn(usageRecord, "completion_tokens") ||
      totalFieldPresent
    );

  if (
    tokenFieldsPresent &&
    (
      input === null ||
      output === null ||
      (totalFieldPresent && total === null)
    )
  ) {
    throw new AiError("Usage token provider tidak sah.");
  }

  if (input !== null && output !== null) {
    const summedTokens = input + output;
    if (!Number.isSafeInteger(summedTokens)) {
      throw new AiError("Usage token provider tidak sah.");
    }
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: Math.max(total ?? 0, summedTokens),
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
      providerCostUsd: readProviderCost(payload),
      providerGenerationId: providerGenerationId(payload),
    };
  }

  // Sebagian endpoint kompatibel OpenAI tidak mengembalikan `usage`. Angka
  // ini hanya untuk pagar biaya kasar dan ditandai sebagai estimasi.
  const inputEstimate = estimateChatRequestInputTokens(request);
  const message = (
    payload as {
      choices?: {
        message?: { content?: unknown; tool_calls?: unknown };
      }[];
    }
  )?.choices?.[0]?.message;
  const outputCharacters =
    (typeof message?.content === "string" ? message.content.length : 0) +
    (message?.tool_calls === undefined
      ? 0
      : safeSerializedLength(message.tool_calls)) +
    rawContinuationCharacters(message);
  const outputEstimate = Math.ceil(outputCharacters / 4);

  return {
    inputTokens: inputEstimate,
    outputTokens: outputEstimate,
    totalTokens: inputEstimate + outputEstimate,
    estimated: true,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    providerCostUsd: readProviderCost(payload),
    providerGenerationId: providerGenerationId(payload),
  };
}

function readFinishReason(payload: unknown): string | null {
  const value = (
    payload as { choices?: { finish_reason?: unknown }[] }
  )?.choices?.[0]?.finish_reason;
  return normalizedFinishReason(value);
}

function normalizedFinishReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  switch (value) {
    case "stop":
    case "tool_calls":
    case "length":
    case "content_filter":
      return value;
    default:
      return "other";
  }
}

/** Estimator provider-neutral yang juga dipakai preflight context pressure. */
export function estimateChatRequestInputTokens(request: ChatRequest): number {
  const messageCharacters = request.messages.reduce(
    (sum, message) =>
      sum +
      (typeof message.content === "string" ? message.content.length : 0) +
      (message.role === "assistant" && "tool_calls" in message
        ? toolCallsWireCharacters(message.tool_calls) +
          assistantContinuationCharacters(message.continuation)
        : 0) +
      (message.role === "tool"
        ? message.tool_call_id.length + (message.name?.length ?? 0)
        : 0),
    0,
  );
  const toolCharacters = request.tools
    ? safeSerializedLength(request.tools)
    : 0;
  return Math.ceil((messageCharacters + toolCharacters) / 4);
}

function toolCallsWireCharacters(toolCalls: readonly ChatToolCall[]): number {
  return safeSerializedLength(toolCalls.map((call) => ({
    id: call.id,
    type: "function",
    function: {
      name: call.function.name,
      arguments: call.function.arguments,
    },
    ...(call.extra_content ? { extra_content: call.extra_content } : {}),
  })));
}

function rawContinuationCharacters(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const record = value as Record<string, unknown>;
  return (
    (typeof record["reasoning"] === "string"
      ? record["reasoning"].length
      : 0) +
    (typeof record["reasoning_content"] === "string"
      ? record["reasoning_content"].length
      : 0) +
    (record["reasoning_details"] === undefined
      ? 0
      : safeSerializedLength(record["reasoning_details"]))
  );
}

function assistantContinuationCharacters(
  continuation: AssistantContinuation | undefined,
): number {
  if (!continuation) return 0;
  return (
    (continuation.reasoning?.length ?? 0) +
    (continuation.reasoningContent?.length ?? 0) +
    (continuation.reasoningDetails === undefined
      ? 0
      : safeSerializedLength(continuation.reasoningDetails))
  );
}

function inputTokenCalibrationFields(
  request: ChatRequest,
  usage: ProviderTokenUsage,
): Record<string, number> {
  if (usage.estimated) return {};
  const estimate = estimateChatRequestInputTokens(request);
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
    Number.isSafeInteger(value) &&
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

function readProviderCost(payload: unknown): string | null {
  const usage = (
    payload as {
      usage?: {
        cost?: unknown;
        cost_details?: { upstream_inference_cost?: unknown };
      };
    }
  )?.usage;
  return decimalCost(usage?.cost) ??
    decimalCost(usage?.cost_details?.upstream_inference_cost);
}

function providerGenerationId(payload: unknown): string | null {
  const value = (payload as { id?: unknown })?.id;
  return typeof value === "string" ? value : null;
}

function responseOutcomeForError(
  error: unknown,
): ProviderAttemptFinish["responseOutcome"] {
  if (!(error instanceof AiError)) return "empty";
  if (error instanceof AiResponseError) return error.reason;
  return "empty";
}

function validateProviderCompletion(
  request: ChatRequest,
  completion: ChatCompletion,
): boolean {
  if (completion.kind === "tool_calls") {
    if (!request.tools || request.tools.length === 0) return false;
    const calls = completion.assistant.tool_calls;
    const availableNames = new Set(
      request.tools.map((tool) => tool.function.name),
    );
    if (calls.some((call) => !availableNames.has(call.function.name))) {
      return false;
    }
    if (!request.parallelToolCalls && calls.length !== 1) return false;
    if (request.toolChoice === "none") return false;
    const selectedToolName = typeof request.toolChoice === "object"
      ? request.toolChoice.function.name
      : null;
    if (
      selectedToolName !== null &&
      calls.some((call) => call.function.name !== selectedToolName)
    ) {
      return false;
    }
    if (!request.validateToolCalls) return true;
    try {
      return request.validateToolCalls(calls) === true;
    } catch {
      return false;
    }
  }
  if (request.toolChoice === "required") return false;
  if (!request.validateResponse) return true;
  try {
    return request.validateResponse(completion.content) === true;
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
  if (ownerId.startsWith("whatsapp-user:")) return "private";
  return ownerId.startsWith("whatsapp:") || ownerId.startsWith("telegram:")
    ? "group"
    : "private";
}

function inferChannel(
  ownerId: string,
): "telegram" | "whatsapp" | "system" {
  return ownerId.startsWith("whatsapp:") || ownerId.startsWith("whatsapp-user:")
    ? "whatsapp"
    : "telegram";
}

function readCompletion(
  payload: unknown,
  providerId: string,
  modelId: string,
  profile: ModelProfile | null,
): ChatCompletion {
  const choice = (
    payload as {
      choices?: {
        message?: { content?: unknown; tool_calls?: unknown };
        finish_reason?: unknown;
      }[];
    }
  )?.choices?.[0];
  const finishReason = normalizedFinishReason(choice?.finish_reason);

  // Balasan yang terpotong tampak seperti balasan rusak di lapisan atas, dan
  // penyebabnya tidak terlihat sama sekali. Model penalaran menghabiskan jatah
  // token untuk berpikir, lalu jawabannya terpenggal di tengah.
  if (finishReason === "length") {
    throw new AiResponseError(
      "truncated",
      finishReason,
      "Balasan model terpotong karena batas token (finish_reason=length). " +
        "Naikkan maxTokens untuk permintaan ini.",
    );
  }

  if (
    finishReason !== "stop" &&
    finishReason !== "tool_calls"
  ) {
    const reason = finishReason ?? "missing";
    throw new AiResponseError(
      "incomplete",
      finishReason,
      `Balasan model tidak lengkap atau ditolak (finish_reason=${reason}).`,
    );
  }

  const rawToolCalls = choice?.message?.tool_calls;
  if (rawToolCalls !== undefined && rawToolCalls !== null) {
    if (finishReason !== "tool_calls") {
      throw new AiError(
        "Native tool call tidak mempunyai finish_reason=tool_calls.",
      );
    }
    if (
      !Array.isArray(rawToolCalls) ||
      rawToolCalls.length < 1 ||
      rawToolCalls.length > MAX_NATIVE_TOOL_CALLS
    ) {
      throw new AiError("Native tool call model tidak dikenali.");
    }
    const toolCalls = rawToolCalls.map(readToolCall);
    const content = choice?.message?.content;
    if (content !== null && content !== undefined && typeof content !== "string") {
      throw new AiError("Konten assistant native tool tidak sah.");
    }
    const continuation = readAssistantContinuation(
      choice?.message,
      providerId,
      modelId,
      profile,
    );
    const assistant = immutableAssistantToolMessage({
        role: "assistant",
        content: typeof content === "string" ? content : null,
        tool_calls: toolCalls,
        continuation,
      });
    for (const call of assistant.tool_calls) {
      bindProviderToolCall(call, { providerId, modelId });
    }
    return {
      kind: "tool_calls",
      toolCalls: assistant.tool_calls,
      assistant,
    };
  }

  if (choice?.finish_reason === "tool_calls") {
    throw new AiError("Model menandai tool call tanpa payload yang sah.");
  }

  const content = choice?.message?.content;

  if (typeof content !== "string" || !content.trim()) {
    throw new AiError("Balasan model kosong atau tidak dikenali.");
  }

  return { kind: "text", content: content.trim() };
}

function readToolCall(value: unknown): ChatToolCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiError("Native tool call model tidak dikenali.");
  }
  const record = value as Record<string, unknown>;
  const fn = record.function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
    throw new AiError("Native function call model tidak dikenali.");
  }
  const functionRecord = fn as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    record.id.length < 1 ||
    record.id.length > 256 ||
    record.type !== "function" ||
    typeof functionRecord.name !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(functionRecord.name) ||
    typeof functionRecord.arguments !== "string" ||
    functionRecord.arguments.length > MAX_NATIVE_TOOL_ARGUMENT_CHARACTERS
  ) {
    throw new AiError("Native function call model tidak sah.");
  }
  const extraContent = readToolCallExtraContent(record.extra_content);
  return {
    id: record.id,
    type: "function",
    function: {
      name: functionRecord.name,
      arguments: functionRecord.arguments,
    },
    ...(extraContent ? { extra_content: extraContent } : {}),
  };
}

function readToolCallExtraContent(
  value: unknown,
): ChatToolCall["extra_content"] | undefined {
  if (value === undefined) return undefined;
  if (!isPlainJsonObject(value)) {
    throw new AiError("Metadata native tool call tidak sah.");
  }
  const google = value["google"];
  if (
    Object.keys(value).length !== 1 ||
    !isPlainJsonObject(google) ||
    Object.keys(google).length !== 1
  ) {
    throw new AiError("Metadata native tool call tidak sah.");
  }
  const signature = google["thought_signature"];
  if (
    typeof signature !== "string" ||
    signature.length < 1 ||
    signature.length > MAX_NATIVE_THOUGHT_SIGNATURE_CHARACTERS
  ) {
    throw new AiError("Thought signature native tool call tidak sah.");
  }
  return { google: { thought_signature: signature } };
}

function readAssistantContinuation(
  value: unknown,
  providerId: string,
  modelId: string,
  profile: ModelProfile | null,
): AssistantContinuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({ providerId, modelId });
  }
  const message = value as Record<string, unknown>;
  const reasoning = readBoundedReasoningString(message["reasoning"], "reasoning");
  const reasoningContent = readBoundedReasoningString(
    message["reasoning_content"],
    "reasoning_content",
  );
  const rawDetails = message["reasoning_details"];
  let reasoningDetails: readonly unknown[] | undefined;
  if (rawDetails !== undefined && rawDetails !== null) {
    if (
      !Array.isArray(rawDetails) ||
      !isBoundedJsonData(rawDetails) ||
      safeSerializedLength(rawDetails) > MAX_REASONING_DETAILS_CHARACTERS
    ) {
      throw new AiError("Reasoning details provider tidak sah atau terlalu besar.");
    }
    reasoningDetails = deepFreezeJson(structuredClone(rawDetails));
  }
  if (
    (reasoning !== undefined ||
      reasoningContent !== undefined ||
      reasoningDetails !== undefined) &&
    (profile?.verification !== "explicit" ||
      !profile.continuation.preserveReasoning)
  ) {
    throw new AiError(
      "Profile model tidak mengizinkan reasoning continuation provider.",
    );
  }
  return Object.freeze({
    providerId,
    modelId,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    ...(reasoningDetails !== undefined ? { reasoningDetails } : {}),
  });
}

function readBoundedReasoningString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    value.length > MAX_REASONING_CONTINUATION_CHARACTERS
  ) {
    throw new AiError(`${field} provider tidak sah atau terlalu besar.`);
  }
  return value;
}

function isBoundedJsonData(root: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_REASONING_DETAILS_NODES || current.depth > MAX_REASONING_DETAILS_DEPTH) {
      return false;
    }
    const value = current.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        stack.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }
    if (!value || typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const entry of Object.values(value)) {
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
  return true;
}

function deepFreezeJson<T>(root: T): T {
  const stack: object[] = [];
  if (root !== null && typeof root === "object") stack.push(root as object);
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const value of Object.values(current)) {
      if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        stack.push(value);
      }
    }
    Object.freeze(current);
  }
  return root;
}

function immutableAssistantToolMessage(
  message: ChatAssistantToolMessage,
): ChatAssistantToolMessage {
  return deepFreezeJson(structuredClone(message));
}

function assertExecutionRequest(
  request: ChatRequest,
  profile: ModelProfile | null,
  timeoutMs: number,
): void {
  const execution = request.execution;
  if (request.runBudget && !execution) {
    throw new AiError("RunBudget model memerlukan execution plan tepercaya.");
  }
  if (
    profile?.verification === "explicit" &&
    profile.reasoning.mandatory &&
    (!execution || execution.effectiveEffort === null)
  ) {
    throw new AiError("Profile reasoning wajib memerlukan execution effort.");
  }
  if (execution) {
    if (
      request.maxTokens !== execution.maxOutputTokens ||
      timeoutMs > execution.deadlineMs ||
      (request.usage !== undefined && request.usage.tier !== execution.tier) ||
      (request.tools !== undefined && !execution.allowTools)
    ) {
      throw new AiError("Request model tidak cocok dengan execution plan.");
    }
    if (
      execution.effectiveEffort !== null &&
      (!profile ||
        !profile.reasoning.supportedEfforts.includes(execution.effectiveEffort))
    ) {
      throw new AiError("Execution plan memakai reasoning effort tanpa profile sah.");
    }
  }
  if (request.tools && profile && !profile.supports.tools) {
    throw new AiError("Profile model tidak mendukung native tool.");
  }
  if (
    request.json &&
    profile?.verification === "explicit" &&
    !profile.supports.structuredOutput
  ) {
    throw new AiError("Profile model tidak mendukung structured output.");
  }
  if (
    request.tools &&
    execution &&
    execution.maxSteps > 1 &&
    profile?.verification === "explicit" &&
    !profile.continuation.preserveAssistantMessage
  ) {
    throw new AiError("Profile model tidak mendukung continuation native tool.");
  }
  if (
    request.tools &&
    execution?.effectiveEffort !== null &&
    execution?.effectiveEffort !== undefined &&
    profile?.verification === "explicit" &&
    !profile.continuation.preserveReasoning
  ) {
    throw new AiError("Profile model tidak mendukung reasoning continuation.");
  }
  const continuedAssistantTurns = request.messages.filter(
    (message): message is ChatAssistantToolMessage =>
      message.role === "assistant" && "tool_calls" in message,
  );
  if (
    continuedAssistantTurns.length > 0 &&
    profile?.verification === "explicit" &&
    !profile.continuation.preserveAssistantMessage
  ) {
    throw new AiError("Profile model tidak mendukung replay assistant tool turn.");
  }
  if (
    continuedAssistantTurns.some((message) =>
      message.continuation?.reasoning !== undefined ||
      message.continuation?.reasoningContent !== undefined ||
      message.continuation?.reasoningDetails !== undefined
    ) &&
    profile?.verification === "explicit" &&
    !profile.continuation.preserveReasoning
  ) {
    throw new AiError("Profile model tidak mendukung replay reasoning.");
  }
  const maxOutputTokens = request.maxTokens ?? 800;
  if (
    profile?.maxOutputTokens !== null &&
    profile?.maxOutputTokens !== undefined &&
    maxOutputTokens > profile.maxOutputTokens
  ) {
    throw new AiError("Request melampaui output ceiling profile model.");
  }
  if (
    profile?.contextWindow !== null &&
    profile?.contextWindow !== undefined &&
    estimateChatRequestInputTokens(request) + maxOutputTokens >
      profile.contextWindow
  ) {
    throw new AiError("Request melampaui context window profile model.");
  }
  if (
    typeof request.toolChoice === "object" &&
    profile &&
    !profile.supports.namedToolChoice
  ) {
    throw new AiError("Profile model tidak mendukung named tool choice.");
  }
}

function assertNativeToolRequest(
  request: ChatRequest & { tools: readonly ChatFunctionTool[] },
): void {
  if (request.json) {
    throw new AiError("Mode JSON dan native tool calling tidak boleh digabung.");
  }
  if (
    !Array.isArray(request.tools) ||
    request.tools.length < 1 ||
    request.tools.length > MAX_NATIVE_TOOLS
  ) {
    throw new AiError("Jumlah native tool tidak sah.");
  }
  const names = new Set<string>();
  for (const tool of request.tools) {
    const definition = tool?.function;
    if (
      tool?.type !== "function" ||
      !definition ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(definition.name) ||
      names.has(definition.name) ||
      !definition.description.trim() ||
      definition.description.length > 1_024 ||
      !isPlainJsonObject(definition.parameters) ||
      definition.parameters["type"] !== "object"
    ) {
      throw new AiError("Definisi native tool tidak sah.");
    }
    names.add(definition.name);
  }
  const toolChoice: unknown = request.toolChoice;
  if (
    toolChoice === "none" ||
    (typeof toolChoice === "string" &&
      toolChoice !== "auto" &&
      toolChoice !== "required") ||
    (request.parallelToolCalls !== undefined &&
      typeof request.parallelToolCalls !== "boolean")
  ) {
    throw new AiError("Konfigurasi native tool request tidak sah.");
  }
  if (toolChoice !== undefined && typeof toolChoice !== "string") {
    if (
      !toolChoice ||
      typeof toolChoice !== "object" ||
      Array.isArray(toolChoice) ||
      (toolChoice as { type?: unknown }).type !== "function"
    ) {
      throw new AiError("Konfigurasi native tool_choice tidak sah.");
    }
    const namedFunction = (toolChoice as { function?: unknown }).function;
    if (
      !namedFunction ||
      typeof namedFunction !== "object" ||
      Array.isArray(namedFunction) ||
      typeof (namedFunction as { name?: unknown }).name !== "string" ||
      !names.has((namedFunction as { name: string }).name)
    ) {
      throw new AiError("tool_choice menunjuk function yang tidak tersedia.");
    }
  }
  if (safeSerializedLength(request.tools) > MAX_NATIVE_TOOL_SCHEMA_CHARACTERS) {
    throw new AiError("Schema native tool melewati batas ukuran.");
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    isJsonData(value)
  );
}

function isJsonData(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonData);
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isJsonData);
}

function safeSerializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Penyedia menolak bentuk permintaannya, bukan kuncinya. */
function isUnsupportedOption(error: unknown): boolean {
  return (
    error instanceof AiError &&
    (error.status === 400 || error.status === 404 || error.status === 422)
  );
}

/**
 * Timeout, pembatasan laju, galat server, dan respons 2xx tanpa terminal marker
 * layak dicoba dengan kunci lain. Marker yang menyatakan penolakan seperti
 * content_filter tetap terminal agar retry tidak mengakali kebijakan provider.
 */
function isRetryable(error: unknown): boolean {
  if (isMissingTerminalMarker(error)) return true;
  if (error instanceof AiError && error.status !== undefined) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  // Timeout dan gangguan jaringan. Galat kebijakan lokal (misalnya batas
  // pemakaian) bukan alasan memutar kunci dan mencoba permintaan yang sama.
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error instanceof TypeError)
  );
}

function isMissingTerminalMarker(error: unknown): boolean {
  return error instanceof AiResponseError &&
    error.reason === "incomplete" &&
    error.finishReason === null;
}

function isProviderWideFailure(error: unknown): boolean {
  return (
    (error instanceof AiError &&
      error.status !== undefined &&
      (error.status === 408 || error.status >= 500)) ||
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
    if (error.status === 408) return "timeout";
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
