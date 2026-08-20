import { createHash } from "node:crypto";
import {
  AiClient,
  AiResponseError,
  type ChatAssistantToolMessage,
  type ChatFunctionTool,
} from "../src/ai/client.js";
import { resolveModel } from "../src/ai/model-policy.js";
import type { ModelProfile } from "../src/ai/model-profile.js";
import { aiClientOptions, loadAiConfig, type AiConfig } from "../src/config.js";
import { ExecutionPolicy } from "../src/core/execution-policy.js";
import type {
  ProviderAttemptFinish,
  ProviderAttemptObserver,
  ProviderAttemptStart,
} from "../src/domain/usage-ledger.js";

const TOOL_NAME = "provider_smoke_marker";
const TOOL_MARKER = "PROVIDER_SMOKE_OK";
const CONTINUATION_MARKER = "PROVIDER_CONTINUATION_OK";
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
}

interface SafeStage {
  stage: string;
  status: "passed" | "failed" | "not_exercised";
  code: string;
  durationMs: number;
  attempts: SafeAttempt[];
  facts?: Readonly<Record<string, string | number | boolean | null>>;
}

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

function clientFor(config: AiConfig, collector: AttemptCollector): AiClient {
  return new AiClient({
    ...aiClientOptions(config, { fallback: false }),
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

async function runStage(
  name: string,
  action: (client: AiClient, collector: AttemptCollector) => Promise<{
    code: string;
    facts?: Readonly<Record<string, string | number | boolean | null>>;
  }>,
  config: AiConfig,
): Promise<SafeStage> {
  const collector = new AttemptCollector();
  const started = Date.now();
  try {
    const result = await action(clientFor(config, collector), collector);
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

async function toolAndContinuation(
  config: AiConfig,
  profile: ModelProfile,
  model: string,
): Promise<{ stages: SafeStage[]; assistant: ChatAssistantToolMessage | null }> {
  const capturedTurns: ChatAssistantToolMessage[] = [];
  const policy = new ExecutionPolicy();
  const toolStage = await runStage("native_tool_and_reasoning_capture", async (client) => {
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
  }, config);

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
    return { code: "assistant_and_reasoning_replayed" };
  }, config);
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
    const text = await clientFor(config, collector).complete({
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
  }, config);
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
    await clientFor(config, collector).complete({
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

async function main(): Promise<void> {
  loadEnvironment();
  const config = loadAiConfig();
  const model = resolveModel("ambitious", config);
  const profile = config.modelProfiles.require(config.providerId, model);
  const profileDigest = createHash("sha256")
    .update(JSON.stringify(profile))
    .digest("hex");
  const blockedReasons: string[] = [];
  if (profile.verification !== "explicit") blockedReasons.push("profile_not_explicit");
  if (!profile.supports.tools) blockedReasons.push("native_tools_not_declared");
  if (!profile.continuation.preserveAssistantMessage) {
    blockedReasons.push("assistant_continuation_not_declared");
  }
  if (profile.reasoning.wireFormat !== "none" && !profile.continuation.preserveReasoning) {
    blockedReasons.push("reasoning_replay_not_declared");
  }
  if (blockedReasons.length > 0) {
    console.log(JSON.stringify({
      protocol: "harvy-provider-live-smoke/1",
      status: "blocked",
      testedAt: new Date().toISOString(),
      provider: config.providerId,
      model,
      profileDigest,
      blockedReasons,
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const stages: SafeStage[] = [];
  const continuation = await toolAndContinuation(config, profile, model);
  stages.push(...continuation.stages);
  stages.push(await outputCeilingStage(config, profile, model));
  stages.push(await contextPressureStage(config, profile, model));
  stages.push(await timeoutAndRetryStage(config, profile, model));
  const failures = stages.filter((stage) => stage.status === "failed");
  console.log(JSON.stringify({
    protocol: "harvy-provider-live-smoke/1",
    status: failures.length === 0 ? "passed" : "failed",
    testedAt: new Date().toISOString(),
    mode: config.mode,
    provider: config.providerId,
    model,
    profileDigest,
    profile: {
      verification: profile.verification,
      reasoningWireFormat: profile.reasoning.wireFormat,
      reasoningMandatory: profile.reasoning.mandatory,
      defaultEffort: profile.reasoning.defaultEffort,
      tools: profile.supports.tools,
      namedToolChoice: profile.supports.namedToolChoice,
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
