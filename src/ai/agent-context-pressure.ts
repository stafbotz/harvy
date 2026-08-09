import {
  estimateChatRequestInputTokens,
  type ChatMessage,
  type ChatRequest,
} from "./client.js";
import { agentPlannerInput, type AgentMode } from "./agent.js";
import { EMPTY_CONTEXT, type HarvyContext } from "./context.js";
import type { ModelProfile } from "./model-profile.js";
import type { AgentPlannerInput } from "../harness/agent-harness.js";
import {
  compileHarvyContext,
  DEFAULT_CONTEXT_BUDGET,
  type CompiledHarvyContext,
  type ContextBudget,
} from "../harness/context-budget.js";
import {
  withContextPressureMetadata,
  type ContextManifest,
} from "../harness/context-manifest.js";
import { compactObservationSummary } from "../harness/observation-compaction.js";

interface CompactionLevel {
  contextCharacters: number;
  observationCharacters: number;
}

const COMPACTION_LEVELS: readonly CompactionLevel[] = Object.freeze([
  Object.freeze({
    contextCharacters: 16_000,
    observationCharacters: 3_600,
  }),
  Object.freeze({
    contextCharacters: 8_000,
    observationCharacters: 2_000,
  }),
  Object.freeze({
    contextCharacters: 4_000,
    observationCharacters: 1_000,
  }),
  Object.freeze({
    contextCharacters: 2_000,
    observationCharacters: 750,
  }),
  Object.freeze({
    contextCharacters: 0,
    observationCharacters: 512,
  }),
]);

export interface AgentContextPressureInput {
  normalRequest: ChatRequest;
  sourceContext: HarvyContext;
  plannerInput: AgentPlannerInput;
  mode: AgentMode;
  nativeMessages: readonly ChatMessage[];
  profile: ModelProfile | null;
  compactAtContextRatio: number;
  recovery: boolean;
  rebuild: (
    compiledContext: CompiledHarvyContext,
    nativeMessages: readonly ChatMessage[],
  ) => ChatRequest;
}

export interface PreparedAgentContext {
  request: ChatRequest;
  /** Bila true, caller harus mengganti transcript live dengan nilai ini. */
  resetNativeThread: boolean;
  nativeMessages: readonly ChatMessage[];
}

/**
 * Compiler pressure khusus loop agent. Ia tidak menyentuh request mentah,
 * system instructions, tool schema, scope, atau RunBudget. Saat transcript
 * provider perlu diputus, state kini dibangun ulang dari checkpoint kernel;
 * reasoning lama tidak disalin ke summary dan continuation baru dimulai dari
 * pesan provider-neutral yang benar-benar dikirim.
 */
export function prepareAgentContext(
  input: AgentContextPressureInput,
): PreparedAgentContext {
  validateRatio(input.compactAtContextRatio);
  const before = estimateChatRequestInputTokens(input.normalRequest);
  const contextWindow = input.profile?.verification === "explicit"
    ? input.profile.contextWindow
    : null;
  const threshold = contextWindow === null
    ? null
    : Math.max(1, Math.floor(contextWindow * input.compactAtContextRatio));
  const maxOutputTokens = input.normalRequest.maxTokens ?? 800;
  const pressured = threshold !== null &&
    before + maxOutputTokens >= threshold;

  if (!input.recovery && !pressured) {
    return {
      request: attachPressure(
        input.normalRequest,
        input.normalRequest.contextManifest,
        {
          applied: false,
          recovery: false,
          contextWindowTokens: contextWindow,
          thresholdTokens: threshold,
          compactAtRatioPermille: ratioPermille(
            input.compactAtContextRatio,
          ),
          maxOutputTokens,
          inputTokensBefore: before,
          inputTokensAfter: before,
          nativeMessagesBefore: input.nativeMessages.length,
          nativeMessagesAfter: input.nativeMessages.length,
          observationCount: input.plannerInput.observations.length,
          clippedObservationCount: 0,
        },
      ),
      resetNativeThread: false,
      nativeMessages: input.nativeMessages,
    };
  }

  let selected: CompactionCandidate | null = null;
  for (const level of COMPACTION_LEVELS) {
    const candidate = compactionCandidate(input, level);
    if (!selected || candidate.inputTokens < selected.inputTokens) {
      selected = candidate;
    }
    if (
      threshold === null ||
      candidate.inputTokens + maxOutputTokens < threshold
    ) {
      selected = candidate;
      break;
    }
  }
  if (!selected) throw new Error("Level pemadatan agent tidak tersedia.");
  if (
    contextWindow !== null &&
    selected.inputTokens + maxOutputTokens > contextWindow
  ) {
    throw new Error(
      "State agent tidak dapat dipadatkan tanpa melewati context window model.",
    );
  }

  const request = attachPressure(
    selected.request,
    selected.request.contextManifest,
    {
      applied: true,
      recovery: input.recovery,
      contextWindowTokens: contextWindow,
      thresholdTokens: threshold,
      compactAtRatioPermille: ratioPermille(input.compactAtContextRatio),
      maxOutputTokens,
      inputTokensBefore: before,
      inputTokensAfter: selected.inputTokens,
      nativeMessagesBefore: input.nativeMessages.length,
      nativeMessagesAfter: selected.nativeMessages.length,
      observationCount: input.plannerInput.observations.length,
      clippedObservationCount: selected.clippedObservationCount,
    },
  );
  return {
    request,
    resetNativeThread: true,
    nativeMessages: selected.nativeMessages,
  };
}

interface CompactionCandidate {
  request: ChatRequest;
  nativeMessages: readonly ChatMessage[];
  inputTokens: number;
  clippedObservationCount: number;
}

function compactionCandidate(
  input: AgentContextPressureInput,
  level: CompactionLevel,
): CompactionCandidate {
  let clippedObservationCount = 0;
  const observations = input.plannerInput.observations.map((observation) => {
    const summary = compactObservationSummary(
      observation.summary,
      level.observationCharacters,
      { reason: "context_pressure" },
    );
    if (summary !== observation.summary.trim()) clippedObservationCount += 1;
    return { ...observation, summary };
  });
  const plannerInput: AgentPlannerInput = {
    ...input.plannerInput,
    observations,
    // Jawaban/koreksi adalah instruction revision tepercaya dari mailbox.
    // Memotongnya dapat membuat hasil fresh secara revision tetapi basi secara
    // semantik; compiler lebih baik gagal tertutup bila state ini tak muat.
    userInputs: input.plannerInput.userInputs,
  };
  const nativeMessages: readonly ChatMessage[] = Object.freeze([{
    role: "user",
    content: agentPlannerInput(plannerInput, EMPTY_CONTEXT, input.mode),
  }]);
  const compiled = compileHarvyContext(
    input.sourceContext,
    contextBudget(level.contextCharacters),
  );
  const request = input.rebuild(compiled, nativeMessages);
  return {
    request,
    nativeMessages,
    inputTokens: estimateChatRequestInputTokens(request),
    clippedObservationCount,
  };
}

function contextBudget(maxCharacters: number): ContextBudget {
  return {
    maxCharacters,
    maxSummaryCharacters: Math.min(
      DEFAULT_CONTEXT_BUDGET.maxSummaryCharacters,
      maxCharacters,
    ),
    maxTurnCharacters: Math.min(
      DEFAULT_CONTEXT_BUDGET.maxTurnCharacters,
      maxCharacters,
    ),
    maxMemoryCharacters: Math.min(
      DEFAULT_CONTEXT_BUDGET.maxMemoryCharacters,
      maxCharacters,
    ),
    maxTurns: maxCharacters === 0 ? 0 : DEFAULT_CONTEXT_BUDGET.maxTurns,
    maxMemories: maxCharacters === 0
      ? 0
      : DEFAULT_CONTEXT_BUDGET.maxMemories,
  };
}

function attachPressure(
  request: ChatRequest,
  manifest: ContextManifest | undefined,
  pressure: Parameters<typeof withContextPressureMetadata>[1],
): ChatRequest {
  if (!manifest) {
    throw new Error("Agent request wajib membawa context manifest.");
  }
  return {
    ...request,
    contextManifest: withContextPressureMetadata(manifest, pressure),
  };
}

function validateRatio(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error("Rasio context pressure agent tidak sah.");
  }
}

function ratioPermille(value: number): number {
  return Math.min(999, Math.max(1, Math.round(value * 1_000)));
}
