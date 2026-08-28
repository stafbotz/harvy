import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  AiClient,
  AiResponseError,
  type ChatAssistantToolMessage,
  type ChatFunctionTool,
} from "../src/ai/client.js";
import { resolveModel } from "../src/ai/model-policy.js";
import { HARVY_REPLY_CACHE_SPINE } from "../src/ai/persona.js";
import {
  ModelProfileRegistry,
  type ModelProfile,
} from "../src/ai/model-profile.js";
import { aiClientOptions, loadAiConfig, type AiConfig } from "../src/config.js";
import { ExecutionPolicy } from "../src/core/execution-policy.js";
import type {
  ProviderAttemptFinish,
  ProviderAttemptObserver,
  ProviderAttemptStart,
} from "../src/domain/usage-ledger.js";
import {
  createVisualAcceptanceFixtureForColor,
  observedVisualAcceptanceColors,
  VISUAL_ACCEPTANCE_COLORS,
} from "./live-visual-acceptance-fixture.js";

const TOOL_NAME = "provider_smoke_marker";
const TOOL_MARKER = "PROVIDER_SMOKE_OK";
const CONTINUATION_MARKER = "PROVIDER_CONTINUATION_OK";
const COMPLETION_MARKER = "PROVIDER_COMPLETION_OK";
const STRUCTURED_MARKER = "PROVIDER_STRUCTURED_OK";
const MAX_CONTEXT_PROBE_CHARACTERS = 16 * 1024 * 1024;

interface SafeAttempt {
  attemptNo: number;
  origin: string;
  status: ProviderAttemptFinish["status"];
  httpStatus: number | null;
  responseOutcome: ProviderAttemptFinish["responseOutcome"];
  finishReason: string | null;
  latencyMs: number;
  usageSource: "provider" | "estimated";
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

interface SafeStage {
  stage: string;
  status: "passed" | "failed" | "not_exercised";
  code: string;
  durationMs: number;
  attempts: SafeAttempt[];
  facts?: Readonly<Record<string, string | number | boolean | null>>;
}

type ProviderSmokeFocus = "full" | "image";

class AttemptCollector implements ProviderAttemptObserver {
  readonly starts = new Map<string, ProviderAttemptStart>();
  readonly attempts: SafeAttempt[] = [];

  async startAttempt(context: ProviderAttemptStart): Promise<void> {
    this.starts.set(context.attemptId, context);
  }

  async finishAttempt(
    context: ProviderAttemptStart,
    result: ProviderAttemptFinish,
  ): Promise<void> {
    this.attempts.push({
      attemptNo: context.attemptNo,
      origin: context.origin,
      status: result.status,
      httpStatus: result.httpStatus,
      responseOutcome: result.responseOutcome,
      finishReason: result.finishReason,
      latencyMs: result.latencyMs,
      usageSource: result.usage.estimated ? "estimated" : "provider",
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
    });
  }
}

function loadEnvironment(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) throw error;
  }
}

function clientFor(
  config: AiConfig,
  collector: AttemptCollector,
  probeProfile: ModelProfile,
): AiClient {
  const otherProfiles = config.modelProfiles.list().filter((profile) =>
    profile.provider !== probeProfile.provider || profile.id !== probeProfile.id
  );
  return new AiClient({
    ...aiClientOptions(config),
    modelProfiles: new ModelProfileRegistry([...otherProfiles, probeProfile]),
    attemptObserver: collector,
    environment: "development",
    costCenter: "probe",
  });
}

function stageRequestMetadata() {
  return {
    ownerId: "provider-live-smoke",
    turnId: null,
    subjectKind: "private" as const,
    channel: "system" as const,
    tier: "ambitious" as const,
    purpose: "agent" as const,
    safetyCritical: false,
  };
}

const MARKER_TOOL: ChatFunctionTool = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: TOOL_NAME,
    description: "Return the exact marker requested by the provider smoke probe.",
    parameters: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["marker"],
      properties: Object.freeze({
        marker: Object.freeze({ type: "string", enum: [TOOL_MARKER] }),
      }),
    }),
  }),
});

function boundedOutput(profile: ModelProfile, wanted: number): number {
  return Math.max(1, Math.min(wanted, profile.maxOutputTokens ?? wanted));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof AiResponseError) return `ai_response_${error.reason}`;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  if (error instanceof Error && "code" in error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,96}$/u.test(code)) {
      return code;
    }
  }
  return error instanceof Error
    ? error.name.replaceAll(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 96) || "Error"
    : "unknown_error";
}

function providerSmokeFocus(env: NodeJS.ProcessEnv): ProviderSmokeFocus {
  const value = env.HARVY_PROVIDER_SMOKE_FOCUS?.trim() || "full";
  if (value === "full" || value === "image") return value;
  throw Object.assign(new Error("provider_smoke_focus_invalid"), {
    code: "provider_smoke_focus_invalid",
  });
}

async function runStage(
  name: string,
  action: (client: AiClient, collector: AttemptCollector) => Promise<{
    code: string;
    facts?: Readonly<Record<string, string | number | boolean | null>>;
  }>,
  config: AiConfig,
  probeProfile: ModelProfile,
): Promise<SafeStage> {
  const collector = new AttemptCollector();
  const started = Date.now();
  try {
    const result = await action(
      clientFor(config, collector, probeProfile),
      collector,
    );
    return {
      stage: name,
      status: "passed",
      code: result.code,
      durationMs: Date.now() - started,
      attempts: collector.attempts,
      ...(result.facts ? { facts: result.facts } : {}),
    };
  } catch (error) {
    return {
      stage: name,
      status: "failed",
      code: safeErrorCode(error),
      durationMs: Date.now() - started,
      attempts: collector.attempts,
    };
  }
}

async function basicCompletionStage(
  config: AiConfig,
  profile: ModelProfile,
  model: string,
): Promise<SafeStage> {
  return runStage("basic_completion", async (client) => {
    const text = await client.complete({
      model,
      messages: [{
        role: "user",
        content: `Answer with exactly ${COMPLETION_MARKER}.`,
      }],
      temperature: 0,
      maxTokens: boundedOutput(profile, 64),
      timeoutMs: 60_000,
      maxAttempts: 1,
      validateResponse: (value) => value.trim() === COMPLETION_MARKER,
      usage: stageRequestMetadata(),
    });
    if (text.trim() !== COMPLETION_MARKER) {
      throw new Error("completion_marker_mismatch");
    }
    return { code: "exact_marker_observed" };
  }, config, profile);
}

async function structuredOutputStage(
  config: AiConfig,
  profile: ModelProfile,
  model: string,
): Promise<SafeStage> {
  if (!profile.supports.structuredOutput) {
    return notExercised("structured_output", "profile_capability_disabled");
  }
  return runStage("structured_output", async (client) => {
    const isValid = (text: string): boolean => {
      try {
        const value = JSON.parse(text) as unknown;
        return value !== null && typeof value === "object" &&
          !Array.isArray(value) &&
          Object.keys(value).length === 1 &&
          (value as Record<string, unknown>).marker === STRUCTURED_MARKER;
      } catch {
        return false;
      }
    };
    const text = await client.complete({
      model,
      messages: [
        {
          role: "system",
          content: [
            "Return exactly one valid JSON object and nothing else.",
            "Do not use Markdown fences, prose, or additional keys.",
            `The exact required output is {\"marker\":\"${STRUCTURED_MARKER}\"}.`,
          ].join(" "),
        },
        {
          role: "user",
          content: "Emit the exact required JSON object now.",
        },
      ],
      temperature: 0,
      maxTokens: boundedOutput(profile, 64),
      timeoutMs: 60_000,
      maxAttempts: 1,
      json: true,
      validateResponse: isValid,
      usage: stageRequestMetadata(),
    });
    if (!isValid(text)) throw new Error("structured_contract_mismatch");
    return { code: "json_object_contract_observed" };
  }, config, profile);
}

async function automaticPromptCacheStage(
  config: AiConfig,
  profile: ModelProfile,
  model: string,
): Promise<SafeStage> {
  if (!profile.supports.promptCaching) {
    return notExercised("automatic_prompt_cache", "profile_capability_disabled");
  }
  return runStage("automatic_prompt_cache", async (client, collector) => {
    const runNonce = randomUUID();
    const stablePrefix = [
      HARVY_REPLY_CACHE_SPINE,
      "",
      `<provider-cache-probe>${runNonce}</provider-cache-probe>`,
      ...Array.from(
        { length: 96 },
        (_, index) =>
          `Run-local stable suffix ${index + 1}: preserve exact semantics.`,
      ),
    ].join("\n");
    const request = {
      model,
      messages: [
        { role: "system" as const, content: stablePrefix },
        {
          role: "user" as const,
          content: `Answer with exactly ${COMPLETION_MARKER}.`,
        },
      ],
      temperature: 0,
      // MiniMax dapat memakai sebagian budget untuk penalaran internal bahkan
      // pada jawaban marker pendek; batas 32 membuat probe cache sesekali
      // terpotong sebelum marker keluar dan mengaburkan bukti cache.
      maxTokens: boundedOutput(profile, 128),
      timeoutMs: 60_000,
      maxAttempts: 1,
      validateResponse: (value: string) => value.trim() === COMPLETION_MARKER,
      usage: stageRequestMetadata(),
    };
    await client.complete(request);
    const first = collector.attempts.at(-1);
    await client.complete(request);
    const second = collector.attempts.at(-1);
    const firstRead = first?.cacheReadTokens ?? 0;
    const secondRead = second?.cacheReadTokens ?? 0;
    if (secondRead <= 0 || secondRead <= firstRead) {
      throw new Error("automatic_cache_read_not_observed");
    }
    return {
      code: "automatic_prefix_cache_read_observed",
      facts: {
        firstCacheReadTokens: firstRead,
        secondCacheReadTokens: secondRead,
        firstCacheWriteTokens: first?.cacheWriteTokens ?? 0,
        secondCacheWriteTokens: second?.cacheWriteTokens ?? 0,
        harvyCacheSpineBytes: Buffer.byteLength(
          HARVY_REPLY_CACHE_SPINE,
          "utf8",
        ),
      },
    };
  }, config, profile);
}

async function imageInputStage(
  config: AiConfig,
  profile: ModelProfile,
  model: string,
): Promise<SafeStage> {
  if (!profile.supports.imageInput) {
    return notExercised("image_input", "profile_capability_disabled");
  }
  return runStage("image_input", async (client) => {
    const cases = (await Promise.all(
      VISUAL_ACCEPTANCE_COLORS.map(async (expected) => {
        const png = createVisualAcceptanceFixtureForColor(expected).data;
        return [
          { expected, data: png, mediaType: "image/png" as const },
          {
            expected,
            data: await sharp(png).jpeg({ quality: 85 }).toBuffer(),
            mediaType: "image/jpeg" as const,
          },
        ];
      }),
    )).flat();
    const probeNonce = randomUUID();
    const observedColor = (value: string): string => {
      const colors = observedVisualAcceptanceColors(value);
      if (colors.length === 1) return colors[0]!;
      if (colors.length > 1) return "ambiguous";
      return /(?:^|[^\p{L}])other(?:$|[^\p{L}])/iu.test(value)
        ? "other"
        : "unclassified";
    };
    for (const [index, fixture] of cases.entries()) {
      const text = await client.complete({
        model,
        messages: [
          {
            role: "system",
            content: [
              "Inspect the current image and answer with exactly one lowercase word:",
              "red, green, blue, or other. Do not describe your reasoning.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              "What is the dominant visible color of the attached image?",
              `Neutral probe id: ${probeNonce}-${index + 1}.`,
            ].join(" "),
          },
        ],
        imageInputs: [{
          type: "input_image",
          mediaType: fixture.mediaType,
          data: fixture.data,
          // This is the exact detail mode used by Telegram and WhatsApp.
          // MiniMax-M3 on the verified GMI wire misclassified deterministic
          // fixtures with `auto` and `high`; `low` is the live-proven mode.
          detail: "low",
        }],
        temperature: 0,
        maxTokens: boundedOutput(profile, 64),
        timeoutMs: 60_000,
        maxAttempts: 1,
        usage: stageRequestMetadata(),
      });
      const observed = observedColor(text);
      if (observed !== fixture.expected) {
        throw Object.assign(new Error("image_contract_mismatch"), {
          code: `image_expected_${fixture.expected}_observed_${observed}`,
        });
      }
    }
    return {
      code: "visual_content_observed",
      facts: {
        imageCases: cases.length,
        imageFormats: "png,jpeg",
      },
    };
  }, config, profile);
}

function notExercised(stage: string, code: string): SafeStage {
  return { stage, status: "not_exercised", code, durationMs: 0, attempts: [] };
}

async function toolAndContinuation(
  config: AiConfig,
  profile: ModelProfile,
  model: string,
): Promise<{ stages: SafeStage[]; assistant: ChatAssistantToolMessage | null }> {
  const capturedTurns: ChatAssistantToolMessage[] = [];
  const policy = new ExecutionPolicy();
  const toolStage = await runStage("native_tool_and_continuation_capture", async (client) => {
    const maxOutputTokens = boundedOutput(profile, 256);
    const execution = policy.decide({
      tier: "ambitious",
      role: "planner",
      workClass: "agent",
      profile,
      maxOutputTokens,
      deadlineMs: 60_000,
      maxSteps: 2,
      allowTools: true,
      allowDelegation: false,
    });
    const assistant = await client.completeToolTurn({
      model,
      messages: [
        {
          role: "system",
          content: "Call the required function exactly once. Do not provide free text.",
        },
        {
          role: "user",
          content: `Call ${TOOL_NAME} with marker ${TOOL_MARKER}. After its result, answer exactly ${CONTINUATION_MARKER}.`,
        },
      ],
      temperature: 0,
      maxTokens: execution.maxOutputTokens,
      timeoutMs: execution.deadlineMs,
      maxAttempts: 1,
      execution,
      tools: [MARKER_TOOL],
      toolChoice: profile.supports.namedToolChoice
        ? { type: "function", function: { name: TOOL_NAME } }
        : "required",
      parallelToolCalls: false,
      validateToolCalls: (calls) => {
        if (calls.length !== 1 || calls[0]?.function.name !== TOOL_NAME) return false;
        try {
          const value = JSON.parse(calls[0].function.arguments) as unknown;
          return Boolean(value) && typeof value === "object" &&
            !Array.isArray(value) &&
            (value as Record<string, unknown>).marker === TOOL_MARKER;
        } catch {
          return false;
        }
      },
      usage: stageRequestMetadata(),
    });
    capturedTurns.push(assistant);
    const call = assistant.tool_calls[0];
    if (!call || call.function.name !== TOOL_NAME) {
      throw new Error("tool_contract_mismatch");
    }
    const parsed = JSON.parse(call.function.arguments) as Record<string, unknown>;
    if (parsed.marker !== TOOL_MARKER) throw new Error("tool_argument_mismatch");
    const continuation = assistant.continuation;
    const reasoningCaptured = Boolean(
      continuation?.reasoning !== undefined ||
      continuation?.reasoningContent !== undefined ||
      continuation?.reasoningDetails !== undefined ||
      call.extra_content?.google.thought_signature,
    );
    if (profile.continuation.preserveReasoning && !reasoningCaptured) {
      throw new Error("reasoning_continuation_missing");
    }
    return {
      code: "tool_call_bound",
      facts: {
        reasoningCaptured,
        reasoningDetailsCaptured: continuation?.reasoningDetails !== undefined,
        reasoningStringCaptured: continuation?.reasoning !== undefined ||
          continuation?.reasoningContent !== undefined,
        thoughtSignatureCaptured: Boolean(call.extra_content?.google.thought_signature),
      },
    };
  }, config, profile);

  const captured = capturedTurns[0] ?? null;
  if (toolStage.status !== "passed" || !captured) {
    return { stages: [toolStage], assistant: null };
  }

  const continuationStage = await runStage("tool_result_continuation_replay", async (client) => {
    const maxOutputTokens = boundedOutput(profile, 128);
    const execution = policy.decide({
      tier: "ambitious",
      role: "worker",
      workClass: "agent",
      profile,
      maxOutputTokens,
      deadlineMs: 60_000,
      maxSteps: 1,
      allowTools: false,
      allowDelegation: false,
    });
    const text = await client.complete({
      model,
      messages: [
        {
          role: "system",
          content: "Continue the exact prior tool turn and return only the requested marker.",
        },
        {
          role: "user",
          content: `Call ${TOOL_NAME} with marker ${TOOL_MARKER}. After its result, answer exactly ${CONTINUATION_MARKER}.`,
        },
        captured,
        {
          role: "tool",
          tool_call_id: captured.tool_calls[0]!.id,
          name: TOOL_NAME,
          content: JSON.stringify({ accepted: true, marker: TOOL_MARKER }),
        },
      ],
      temperature: 0,
      maxTokens: execution.maxOutputTokens,
      timeoutMs: execution.deadlineMs,
      maxAttempts: 1,
      execution,
      validateResponse: (value) => value.includes(CONTINUATION_MARKER),
      usage: stageRequestMetadata(),
    });
    if (!text.includes(CONTINUATION_MARKER)) {
      throw new Error("continuation_marker_missing");
    }
    return { code: "assistant_tool_turn_replayed" };
  }, config, profile);
  return { stages: [toolStage, continuationStage], assistant: captured };
}

async function outputCeilingStage(
  config: AiConfig,
  profile: ModelProfile,
  model: string,
): Promise<SafeStage> {
  const policy = new ExecutionPolicy();
  const collector = new AttemptCollector();
  const started = Date.now();
  try {
    const execution = policy.decide({
      tier: "ambitious",
      role: "worker",
      workClass: "agent",
      profile,
      maxOutputTokens: 1,
      deadlineMs: 60_000,
      maxSteps: 1,
    });
    const text = await clientFor(config, collector, profile).complete({
      model,
      messages: [{
        role: "user",
        content: "Write a detailed answer of at least one hundred words about addition.",
      }],
      temperature: 0,
      maxTokens: execution.maxOutputTokens,
      timeoutMs: execution.deadlineMs,
      maxAttempts: 1,
      execution,
      usage: stageRequestMetadata(),
    });
    return {
      stage: "output_ceiling_and_finish_reason",
      status: text.length <= 16 ? "passed" : "failed",
      code: text.length <= 16 ? "provider_stopped_within_ceiling" : "ceiling_not_observed",
      durationMs: Date.now() - started,
      attempts: collector.attempts,
      facts: { responseCharactersAtMost16: text.length <= 16 },
    };
  } catch (error) {
    const expected = error instanceof AiResponseError &&
      (error.reason === "truncated" || error.reason === "incomplete");
    return {
      stage: "output_ceiling_and_finish_reason",
      status: expected ? "passed" : "failed",
      code: expected ? `classified_${error.reason}` : safeErrorCode(error),
      durationMs: Date.now() - started,
      attempts: collector.attempts,
    };
  }
}

async function contextPressureStage(
  config: AiConfig,
  profile: ModelProfile,
  model: string,
): Promise<SafeStage> {
  if (profile.contextWindow === null) {
    return {
      stage: "context_pressure_preflight",
      status: "not_exercised",
      code: "profile_context_window_unknown",
      durationMs: 0,
      attempts: [],
    };
  }
  const characters = (profile.contextWindow + 1_024) * 4;
  if (characters > MAX_CONTEXT_PROBE_CHARACTERS) {
    return {
      stage: "context_pressure_preflight",
      status: "not_exercised",
      code: "safe_probe_allocation_limit",
      durationMs: 0,
      attempts: [],
      facts: { contextWindow: profile.contextWindow },
    };
  }
  return runStage("context_pressure_preflight", async (client, collector) => {
    const policy = new ExecutionPolicy();
    const maxOutputTokens = boundedOutput(profile, 8);
    const execution = policy.decide({
      tier: "ambitious",
      role: "worker",
      workClass: "agent",
      profile,
      maxOutputTokens,
      deadlineMs: 10_000,
      maxSteps: 1,
    });
    try {
      await client.complete({
        model,
        messages: [{ role: "user", content: "x".repeat(characters) }],
        temperature: 0,
        maxTokens: execution.maxOutputTokens,
        timeoutMs: execution.deadlineMs,
        maxAttempts: 1,
        execution,
        usage: stageRequestMetadata(),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Request melampaui context window profile model." &&
        collector.attempts.length === 0
      ) {
        return {
          code: "rejected_before_network",
          facts: { providerAttempts: 0, contextWindow: profile.contextWindow },
        };
      }
      throw error;
    }
    throw new Error("context_pressure_not_rejected");
  }, config, profile);
}

async function timeoutAndRetryStage(
  config: AiConfig,
  profile: ModelProfile,
  model: string,
): Promise<SafeStage> {
  const collector = new AttemptCollector();
  const started = Date.now();
  const policy = new ExecutionPolicy();
  const maxOutputTokens = boundedOutput(profile, 16);
  const execution = policy.decide({
    tier: "ambitious",
    role: "worker",
    workClass: "agent",
    profile,
    maxOutputTokens,
    deadlineMs: 1_000,
    maxSteps: 1,
  });
  const wantedAttempts = Math.min(2, config.keys.size);
  try {
    await clientFor(config, collector, profile).complete({
      model,
      messages: [{ role: "user", content: "Return the single word OK." }],
      temperature: 0,
      maxTokens: execution.maxOutputTokens,
      timeoutMs: 1,
      maxAttempts: wantedAttempts,
      execution,
      usage: stageRequestMetadata(),
    });
    return {
      stage: "timeout_and_retry",
      status: "failed",
      code: "request_completed_before_timeout",
      durationMs: Date.now() - started,
      attempts: collector.attempts,
    };
  } catch (error) {
    const timeoutObserved = collector.attempts.some((item) => item.status === "timeout") ||
      (error instanceof Error && error.name === "AbortError");
    const retryObserved = wantedAttempts < 2 || collector.attempts.length >= 2;
    return {
      stage: "timeout_and_retry",
      status: timeoutObserved && retryObserved ? "passed" : "failed",
      code: timeoutObserved
        ? wantedAttempts < 2
          ? "timeout_observed_retry_not_exercisable_single_key"
          : retryObserved
            ? "timeout_and_retry_observed"
            : "timeout_observed_retry_missing"
        : safeErrorCode(error),
      durationMs: Date.now() - started,
      attempts: collector.attempts,
      facts: {
        timeoutObserved,
        retryExpected: wantedAttempts >= 2,
        retryObserved: wantedAttempts >= 2 && collector.attempts.length >= 2,
      },
    };
  }
}

function probeProfileFor(
  configured: ModelProfile,
  provider: string,
  model: string,
): { phase: "discovery" | "verification"; profile: ModelProfile } {
  if (configured.verification === "explicit") {
    return { phase: "verification", profile: configured };
  }
  // Kandidat ini hanya hidup di proses smoke. Menandai capability `true`
  // memberi izin kepada adapter untuk benar-benar mencoba wire tersebut; hasil
  // baru boleh dipromosikan setelah semua stage wajib lulus.
  return {
    phase: "discovery",
    profile: {
      id: model,
      provider,
      verification: "explicit",
      reasoning: {
        mandatory: false,
        defaultEffort: "none",
        supportedEfforts: [],
        wireFormat: "none",
      },
      supports: {
        tools: true,
        toolChoice: true,
        namedToolChoice: true,
        structuredOutput: true,
        temperature: true,
        promptCaching: true,
        imageInput: true,
      },
      continuation: {
        preserveReasoning: false,
        preserveAssistantMessage: true,
      },
      contextWindow: configured.contextWindow,
      maxOutputTokens: configured.maxOutputTokens,
    },
  };
}

async function main(): Promise<void> {
  loadEnvironment();
  const focus = providerSmokeFocus(process.env);
  const config = loadAiConfig();
  const model = resolveModel("ambitious", config);
  const configuredProfile = config.modelProfiles.require(config.providerId, model);
  const { phase, profile } = probeProfileFor(
    configuredProfile,
    config.providerId,
    model,
  );
  const profileDigest = createHash("sha256")
    .update(JSON.stringify(profile))
    .digest("hex");

  const stages: SafeStage[] = [];
  if (focus === "image") {
    stages.push(await imageInputStage(config, profile, model));
  } else {
    stages.push(await basicCompletionStage(config, profile, model));
    stages.push(await structuredOutputStage(config, profile, model));
    const continuation = await toolAndContinuation(config, profile, model);
    stages.push(...continuation.stages);
    stages.push(await automaticPromptCacheStage(config, profile, model));
    stages.push(await imageInputStage(config, profile, model));
    stages.push(await outputCeilingStage(config, profile, model));
    stages.push(await contextPressureStage(config, profile, model));
    stages.push(await timeoutAndRetryStage(config, profile, model));
  }
  const failures = stages.filter((stage) => stage.status === "failed");
  console.log(JSON.stringify({
    protocol: "harvy-provider-live-smoke/1",
    status: failures.length === 0 ? "passed" : "failed",
    testedAt: new Date().toISOString(),
    mode: config.mode,
    provider: config.providerId,
    model,
    focus,
    phase,
    promotionEligible:
      phase === "discovery" && focus === "full" && failures.length === 0,
    profileDigest,
    profile: {
      verification: profile.verification,
      reasoningWireFormat: profile.reasoning.wireFormat,
      reasoningMandatory: profile.reasoning.mandatory,
      defaultEffort: profile.reasoning.defaultEffort,
      tools: profile.supports.tools,
      namedToolChoice: profile.supports.namedToolChoice,
      structuredOutput: profile.supports.structuredOutput,
      promptCaching: profile.supports.promptCaching,
      imageInput: profile.supports.imageInput,
      preserveAssistantMessage: profile.continuation.preserveAssistantMessage,
      preserveReasoning: profile.continuation.preserveReasoning,
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxOutputTokens,
    },
    fallback: "disabled_for_exact_profile_smoke",
    outputPrivacy: "no_prompt_response_reasoning_or_credentials",
    stages,
  }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  console.log(JSON.stringify({
    protocol: "harvy-provider-live-smoke/1",
    status: "blocked",
    testedAt: new Date().toISOString(),
    blockerCode: safeErrorCode(error),
    outputPrivacy: "no_prompt_response_reasoning_or_credentials",
  }, null, 2));
  process.exitCode = 2;
});
