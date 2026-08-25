import { createHash, randomUUID } from "node:crypto";
import {
  capabilitySystemContext,
  createHarvyCapabilityCatalog,
  type CapabilityCatalog,
  type CapabilitySnapshot,
  type CapabilitySnapshotEntry,
} from "./capabilities.js";
import type { AgentScope, WorkspaceAgentScope } from "./scope.js";
import { scopeKey } from "./scope.js";
import {
  isValidRunBudgetCheckpoint,
  RunBudgetAccount,
  runBudgetReason,
  type RunBudgetCheckpoint,
  type RunBudgetExhaustionReason,
  type RunBudgetPolicy,
  type RunBudgetView,
} from "../core/run-budget.js";
import { compactObservationSummary } from "./observation-compaction.js";

export interface AgentRunLimits {
  maxSteps: number;
  /** Budget aktif untuk satu invocation, tidak termasuk jeda jawaban manusia. */
  deadlineMs: number;
  /** Horizon absolut checkpoint; resume tidak pernah memperpanjangnya. */
  resumeWindowMs: number;
  maxReplyCharacters: number;
  maxObservationCharacters: number;
}

export const DEFAULT_AGENT_RUN_LIMITS: AgentRunLimits = Object.freeze({
  maxSteps: 6,
  deadlineMs: 45_000,
  resumeWindowMs: 45_000,
  maxReplyCharacters: 8_000,
  maxObservationCharacters: 4_000,
});

/** Ruang aman untuk envelope JSON executor di bawah budget observation runtime. */
export const MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS = 3_600;
/** Minimum agar envelope truncation tetap memuat marker, ukuran, dan head/tail. */
export const MIN_AGENT_OBSERVATION_CHARACTERS = 96;
export const MAX_AGENT_CHECKPOINT_HORIZON_MS = 10 * 60 * 1_000;

export type AgentPlannerDecision =
  | { kind: "final"; reply: string }
  | { kind: "need_input"; prompt: string }
  | {
      kind: "action";
      capabilityId: string;
      capabilityVersion: string;
      input: unknown;
    };

export interface AgentObservation {
  step: number;
  capabilityId: string;
  status: "ok" | "denied" | "unavailable" | "error" | "unknown";
  /** Data dari executor, selalu diperlakukan sebagai data tak tepercaya. */
  summary: string;
}

/** Kontrak provider-neutral yang dimiliki executor, bukan prompt atau model. */
export interface AgentNativeToolDefinition {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface AgentCallableCapability extends Pick<
  CapabilitySnapshotEntry,
  "id" | "version" | "effect" | "description"
> {
  /** Ada bila executor menyediakan schema native untuk planner provider. */
  nativeTool?: AgentNativeToolDefinition;
}

export interface AgentPlannerInput {
  runId: string;
  step: number;
  request: string;
  scope: Pick<AgentScope, "kind" | "channel">;
  /** Irisan snapshot runtime dengan executor yang benar-benar terpasang. */
  callableCapabilities: readonly AgentCallableCapability[];
  capabilities: CapabilitySnapshot;
  observations: readonly AgentObservation[];
  userInputs: readonly AgentUserInput[];
  /** Sisa budget dari kode; data ini informatif dan bukan authority model. */
  budget: RunBudgetView;
}

/** Sinyal pekerjaan code-owned; bukan field proposal planner atau tool. */
export interface AgentWorkSignals {
  difficulty: "mechanical" | "normal" | "deep";
  stakes: "low" | "medium" | "high";
  uncertainty: "low" | "medium" | "high";
}

export interface AgentUserInput {
  step: number;
  /** Pertanyaan yang dijawab; optional hanya untuk kompatibilitas checkpoint lama. */
  prompt?: string;
  text: string;
}

export type AgentPlanner = (
  input: AgentPlannerInput,
  signal: AbortSignal,
  runBudget: RunBudgetAccount,
) => Promise<unknown>;

/** Adapter planner boleh menghentikan work lanjutan saat revision berubah. */
export class AgentRunStaleError extends Error {
  constructor() {
    super("AgentRun tidak lagi memakai revision terkini.");
    this.name = "AgentRunStaleError";
  }
}

export interface AgentExecutorValidationSuccess<T = unknown> {
  ok: true;
  value: T;
}

export interface AgentExecutorValidationFailure {
  ok: false;
  reason: string;
}

export interface AgentExecutionContext {
  runId: string;
  step: number;
  scope: AgentScope;
  idempotencyKey: string;
  signal: AbortSignal;
  /** Akun yang sama dengan root planner dan seluruh worker run ini. */
  runBudget: RunBudgetAccount;
  /** Diturunkan composition dari assessment turn, tidak dapat diubah model. */
  workSignals?: AgentWorkSignals;
}

export interface AgentExecutorResult {
  status: "ok" | "error" | "unknown";
  summary: string;
}

export interface AgentCapabilityExecutor<T = unknown> {
  capabilityId: string;
  capabilityVersion: string;
  /** Schema native ikut authority hash checkpoint bila tersedia. */
  nativeTool?: AgentNativeToolDefinition;
  validate(
    input: unknown,
  ): AgentExecutorValidationSuccess<T> | AgentExecutorValidationFailure;
  execute(input: T, context: AgentExecutionContext): Promise<AgentExecutorResult>;
}

export type AgentAuthorization =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "approval"; expiresAt?: string };

export type AgentAuthorizationPolicy = (input: {
  scope: AgentScope;
  capability: CapabilitySnapshotEntry;
  value: unknown;
  runId: string;
  step: number;
  signal: AbortSignal;
}) => AgentAuthorization | Promise<AgentAuthorization>;

export interface AgentApprovalRequest {
  runId: string;
  step: number;
  capabilityId: string;
  capabilityVersion: string;
  binding: string;
  expiresAt: string;
}

export interface AgentApprovalGrant {
  binding: string;
  approvedAt: string;
}

export interface AgentPendingAction {
  proposal: Extract<AgentPlannerDecision, { kind: "action" }>;
  /** Nilai JSON hasil validator; inilah yang dilihat policy dan dieksekusi. */
  validatedValue: unknown;
  digest: string;
  approval: AgentApprovalRequest;
}

export interface AgentPendingInput {
  step: number;
  prompt: string;
}

/** Bentuk ini sengaja serializable agar pause/resume tidak memulai run baru. */
export interface AgentRunCheckpoint {
  /** v1 adalah checkpoint legacy tanpa RunBudget; writer baru selalu v2. */
  version: 1 | 2;
  runId: string;
  scopeKey: string;
  capabilityHash: string;
  /** Hash irisan capability available dengan executor+versi run ini. */
  callableHash: string;
  request: string;
  /** Budget waktu dan langkah dibekukan saat run pertama, bukan saat resume. */
  startedAt: string;
  deadlineAt: string;
  maxSteps: number;
  step: number;
  observations: AgentObservation[];
  userInputs: AgentUserInput[];
  seenActionDigests: string[];
  pending: AgentPendingAction | null;
  pendingInput: AgentPendingInput | null;
  /** Wajib pada v2; optional pada type hanya untuk migrasi v1. */
  runBudget?: RunBudgetCheckpoint;
}

export interface AgentTraceEvent {
  step: number;
  phase: "plan" | "policy" | "approval" | "execute" | "terminate";
  outcome: string;
  capabilityId: string | null;
}

/** Event operasi aktual untuk UX/telemetry; tidak membawa prompt atau CoT. */
export interface AgentActivityEvent {
  phase: "planning" | "executing";
  capabilityId: string | null;
}

export type AgentRunResult =
  | {
      status: "completed";
      reply: string;
      checkpoint: AgentRunCheckpoint;
      trace: readonly AgentTraceEvent[];
    }
  | {
      status: "needs_input";
      prompt: string;
      checkpoint: AgentRunCheckpoint;
      trace: readonly AgentTraceEvent[];
    }
  | {
      status: "needs_approval";
      approval: AgentApprovalRequest;
      checkpoint: AgentRunCheckpoint;
      trace: readonly AgentTraceEvent[];
    }
  | {
      status: "stopped";
      reason:
        | "cancelled"
        | "deadline"
        | "max_steps"
        | "cycle"
        | "invalid_planner_output"
        | "capability_changed"
        | "stale"
        | "invalid_checkpoint"
        | AgentUsageLimitReason
        | RunBudgetExhaustionReason;
      checkpoint: AgentRunCheckpoint;
      trace: readonly AgentTraceEvent[];
    };

export interface AgentRunInput {
  scope: AgentScope;
  request: string;
  planner: AgentPlanner;
  executors?: readonly AgentCapabilityExecutor[];
  policy?: AgentAuthorizationPolicy;
  limits?: Partial<AgentRunLimits>;
  /** Policy code-owned; model dan tool output tidak dapat mengubahnya. */
  runBudget?: RunBudgetPolicy;
  /** Metadata task code-owned untuk executor; tidak masuk schema planner. */
  workSignals?: AgentWorkSignals;
  signal?: AbortSignal;
  checkpoint?: AgentRunCheckpoint;
  /**
   * Input code-owned yang sudah diterima sebelum checkpoint pertama dibuat.
   * Hanya sah pada run baru; setelah itu checkpoint menjadi sumber durable.
   */
  initialUserInputs?: readonly AgentUserInput[];
  approval?: AgentApprovalGrant;
  /** Jawaban untuk `needs_input`; request awal tetap tidak berubah. */
  answer?: string;
  /** Generation guard milik adapter/core; hasil terlambat tidak boleh commit. */
  isCurrent?: () => boolean | Promise<boolean>;
  onActivity?: (event: AgentActivityEvent) => void;
  now?: () => Date;
  makeRunId?: () => string;
}

/** Authority tepercaya dari composition root untuk scope Workspace. */
export interface WorkspaceScopeAuthority {
  isCurrent(
    scope: WorkspaceAgentScope,
    signal: AbortSignal,
  ): boolean | Promise<boolean>;
}

export interface AgentRunOutcomeObserver {
  observeAgentRun(
    input: Pick<AgentRunInput, "scope" | "request">,
    result: AgentRunResult,
  ): Promise<void>;
}

type FreshnessState =
  | "current"
  | "stale"
  | "cancelled"
  | "deadline"
  | "budget_deadline";

export type AgentUsageLimitReason =
  | "usage_allowance_exhausted"
  | "usage_wallet_disabled"
  | "usage_byok_unavailable"
  | "usage_anti_abuse";

/**
 * Kernel agent channel-neutral. Current Harvy workflows belum memberinya tool;
 * ia sudah menegakkan kontrak yang akan dipakai executor nanti.
 */
export class AgentHarness {
  constructor(
    private readonly catalog: CapabilityCatalog,
    private readonly workspaceAuthority?: WorkspaceScopeAuthority,
    private readonly outcomeObserver?: AgentRunOutcomeObserver,
  ) {}

  capabilities(scope: AgentScope): CapabilitySnapshot {
    return this.catalog.snapshot(scope);
  }

  capabilityContext(scope: AgentScope): string {
    return capabilitySystemContext(this.capabilities(scope));
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const state: { runBudget?: RunBudgetAccount } = {};
    const result = await this.runInternal(input, state);
    if (state.runBudget) {
      result.checkpoint.runBudget = state.runBudget.checkpoint();
    }
    // Only the small durable event enqueue is awaited. Candidate processing is
    // owned by its background worker and cannot change this run's result.
    await this.outcomeObserver?.observeAgentRun(input, result).catch(() => undefined);
    return result;
  }

  private async runInternal(
    input: AgentRunInput,
    state: { runBudget?: RunBudgetAccount },
  ): Promise<AgentRunResult> {
    const now = input.now ?? (() => new Date());
    const limits = resolvedLimits(input.limits);
    const runBudget = new RunBudgetAccount(
      budgetPolicyFor(input.runBudget, limits, input.checkpoint),
      () => now().getTime(),
    );
    state.runBudget = runBudget;
    const snapshot = this.capabilities(input.scope);
    const executors = executorMap(input.executors ?? []);
    const callableHash = callableCapabilityHash(snapshot, executors);
    const policy = input.policy ?? conservativePolicy;
    const trace: AgentTraceEvent[] = [];
    const checkpointResult = initialCheckpoint(
      input,
      snapshot,
      callableHash,
      now,
      limits,
      runBudget,
    );
    if (!checkpointResult.ok) {
      const fallback = emptyCheckpoint(
        input,
        snapshot,
        callableHash,
        now,
        limits,
        runBudget,
      );
      return stopped("invalid_checkpoint", fallback, trace);
    }
    const checkpoint = checkpointResult.value;
    if (input.checkpoint) {
      if (checkpoint.version === 2 && checkpoint.runBudget) {
        runBudget.restore(checkpoint.runBudget);
      } else {
        runBudget.seedLegacy({
          modelCalls: Math.min(Number.MAX_SAFE_INTEGER, checkpoint.step + 1),
          toolCalls: checkpoint.observations.length,
        });
        checkpoint.version = 2;
        checkpoint.maxSteps = runBudget.checkpoint().limits.maxSteps;
      }
      checkpoint.runBudget = runBudget.checkpoint();
    }
    // Workspace scope membawa snapshot ACL. Tanpa resolver `isCurrent`, kernel
    // tidak mempunyai authority untuk memastikan membership/epoch masih sah.
    if (input.scope.kind === "workspace" && !input.isCurrent) {
      return stopped("stale", checkpoint, trace);
    }
    if (
      checkpoint.capabilityHash !== snapshot.hash ||
      checkpoint.callableHash !== callableHash
    ) {
      return stopped("capability_changed", checkpoint, trace);
    }

    // Stored deadline menjaga resume tidak memperoleh waktu baru; batas call
    // sekarang tetap menjadi ceiling bila checkpoint rusak/berasal dari store
    // lama dengan horizon lebih longgar.
    const deadlineNow = now().getTime();
    const invocationDeadlineAt = Math.min(
      Date.parse(checkpoint.deadlineAt),
      deadlineNow + limits.deadlineMs,
    );
    const budgetDeadlineAt = deadlineNow + runBudget.remainingActiveMs();
    // Tie tetap dianggap deadline invocation agar perilaku lama stabil. Budget
    // hanya memiliki deadline ketika batas aktifnya memang lebih ketat.
    const budgetOwnsDeadline = input.checkpoint
      ? budgetDeadlineAt < invocationDeadlineAt
      : runBudget.deadlineMs < invocationDeadlineAt - deadlineNow;
    const deadlineAt = Math.min(invocationDeadlineAt, budgetDeadlineAt);
    const freshness = async (): Promise<FreshnessState> => {
      const stop = stopReason(
        input.signal,
        deadlineAt,
        budgetOwnsDeadline,
        now,
        runBudget,
      );
      if (stop) return stop;
      try {
        const current = await boundedCall(
          async (signal) => {
            if (input.isCurrent && !(await input.isCurrent())) return false;
            if (input.scope.kind !== "workspace") return true;
            if (!this.workspaceAuthority) return false;
            return await this.workspaceAuthority.isCurrent(input.scope, signal);
          },
          input.signal,
          deadlineAt,
          now,
        );
        return current ? "current" : "stale";
      } catch (error) {
        const reason = abortReason(
          error,
          input.signal,
          deadlineAt,
          budgetOwnsDeadline,
          now,
          runBudget,
        );
        return reason === "cancelled" ||
            reason === "deadline" ||
            reason === "budget_deadline"
          ? reason
          : "stale";
      }
    };

    const resumeStop = stopReason(
      input.signal,
      deadlineAt,
      budgetOwnsDeadline,
      now,
      runBudget,
    );
    if (resumeStop) return stopped(resumeStop, checkpoint, trace);
    const initialFreshness = await freshness();
    if (initialFreshness !== "current") {
      return stopped(initialFreshness, checkpoint, trace);
    }

    if (checkpoint.pendingInput) {
      const pendingInput = checkpoint.pendingInput;
      const answer = input.answer
        ? boundedText(input.answer, limits.maxObservationCharacters)
        : "";
      if (!answer) {
        return {
          status: "needs_input",
          prompt: checkpoint.pendingInput.prompt,
          checkpoint,
          trace,
        };
      }
      checkpoint.userInputs.push({
        step: pendingInput.step,
        prompt: pendingInput.prompt,
        text: answer,
      });
      checkpoint.pendingInput = null;
      checkpoint.step += 1;
      trace.push(event(checkpoint.step - 1, "plan", "input_received"));
    }

    if (checkpoint.pending) {
      const pendingResult = await resumePending({
        input,
        checkpoint,
        snapshot,
        executors,
        limits,
        deadlineAt,
        budgetOwnsDeadline,
        freshness,
        trace,
        now,
        runBudget,
      });
      if (pendingResult) return pendingResult;
    }

    while (checkpoint.step < Math.min(limits.maxSteps, checkpoint.maxSteps)) {
      try {
        runBudget.assertStep(checkpoint.step);
      } catch (error) {
        return stopped(
          runBudgetReason(error) ?? "budget_steps",
          checkpoint,
          trace,
        );
      }
      const stop = stopReason(
        input.signal,
        deadlineAt,
        budgetOwnsDeadline,
        now,
        runBudget,
      );
      if (stop) return stopped(stop, checkpoint, trace);
      const planningFreshness = await freshness();
      if (planningFreshness !== "current") {
        return stopped(planningFreshness, checkpoint, trace);
      }

      trace.push(event(checkpoint.step, "plan", "started"));
      input.onActivity?.({ phase: "planning", capabilityId: null });
      let rawDecision: unknown;
      try {
        rawDecision = await boundedCall(
          (signal) =>
            input.planner(
              {
                runId: checkpoint.runId,
                step: checkpoint.step,
                request: checkpoint.request,
                scope: {
                  kind: input.scope.kind,
                  channel: input.scope.channel,
                },
                callableCapabilities: callableCapabilities(snapshot, executors),
                capabilities: snapshot,
                observations: immutableObservations(checkpoint.observations),
                userInputs: immutableUserInputs(checkpoint.userInputs),
                budget: runBudget.view(checkpoint.step),
              },
              signal,
              runBudget,
            ),
          input.signal,
          deadlineAt,
          now,
        );
      } catch (error) {
        return stopped(
          abortReason(
            error,
            input.signal,
            deadlineAt,
            budgetOwnsDeadline,
            now,
            runBudget,
          ),
          checkpoint,
          trace,
        );
      }
      const decisionFreshness = await freshness();
      if (decisionFreshness !== "current") {
        return stopped(decisionFreshness, checkpoint, trace);
      }

      const decision = parsePlannerDecision(rawDecision);
      if (!decision) {
        trace.push(event(checkpoint.step, "plan", "invalid"));
        return stopped("invalid_planner_output", checkpoint, trace);
      }
      trace.push(event(checkpoint.step, "plan", decision.kind));

      // Balasan final sudah dibayar dan boleh tetap dikirim. Work lanjutan
      // (tool atau pertanyaan baru) tidak boleh dimulai setelah actual usage
      // provider membuat akun melampaui token/cost reservation semula.
      const overage = runBudget.workOverageReason();
      if (overage && decision.kind !== "final") {
        return stopped(overage, checkpoint, trace);
      }

      if (decision.kind === "final") {
        const reply = boundedText(decision.reply, limits.maxReplyCharacters);
        if (!reply) {
          return stopped("invalid_planner_output", checkpoint, trace);
        }
        trace.push(event(checkpoint.step, "terminate", "completed"));
        return { status: "completed", reply, checkpoint, trace };
      }
      if (decision.kind === "need_input") {
        const prompt = boundedText(decision.prompt, limits.maxReplyCharacters);
        if (!prompt) {
          return stopped("invalid_planner_output", checkpoint, trace);
        }
        if (checkpoint.step + 1 >= Math.min(limits.maxSteps, checkpoint.maxSteps)) {
          return stopped("max_steps", checkpoint, trace);
        }
        checkpoint.pendingInput = { step: checkpoint.step, prompt };
        trace.push(event(checkpoint.step, "terminate", "needs_input"));
        return { status: "needs_input", prompt, checkpoint, trace };
      }

      const actionResult = await handleAction({
        input,
        decision,
        checkpoint,
        snapshot,
        executors,
        policy,
        limits,
        deadlineAt,
        budgetOwnsDeadline,
        freshness,
        trace,
        now,
        runBudget,
      });
      if (actionResult) return actionResult;
    }

    return stopped("max_steps", checkpoint, trace);
  }
}

export const DEFAULT_HARVY_AGENT_HARNESS = new AgentHarness(
  createHarvyCapabilityCatalog(),
);

interface ActionDependencies {
  input: AgentRunInput;
  decision: Extract<AgentPlannerDecision, { kind: "action" }>;
  checkpoint: AgentRunCheckpoint;
  snapshot: CapabilitySnapshot;
  executors: ReadonlyMap<string, AgentCapabilityExecutor>;
  policy: AgentAuthorizationPolicy;
  limits: AgentRunLimits;
  deadlineAt: number;
  budgetOwnsDeadline: boolean;
  freshness: () => Promise<FreshnessState>;
  trace: AgentTraceEvent[];
  now: () => Date;
  runBudget: RunBudgetAccount;
}

async function handleAction(
  dependencies: ActionDependencies,
): Promise<AgentRunResult | null> {
  const {
    input,
    decision,
    checkpoint,
    snapshot,
    executors,
    policy,
    limits,
    deadlineAt,
    budgetOwnsDeadline,
    freshness,
    trace,
    now,
    runBudget,
  } = dependencies;
  const capability = snapshot.entries.find(
    (entry) => entry.id === decision.capabilityId,
  );
  const fingerprint = actionFingerprint(input.scope, decision);
  if (checkpoint.seenActionDigests.includes(fingerprint)) {
    trace.push(event(checkpoint.step, "terminate", "cycle", decision.capabilityId));
    return stopped("cycle", checkpoint, trace);
  }
  checkpoint.seenActionDigests.push(fingerprint);

  if (
    !capability ||
    !capability.available ||
    capability.version !== decision.capabilityVersion
  ) {
    appendObservation(checkpoint, limits, {
      step: checkpoint.step,
      capabilityId: decision.capabilityId,
      status: "unavailable",
      summary: capability?.unavailableReason ?? "Capability tidak dikenal.",
    });
    checkpoint.step += 1;
    trace.push(event(checkpoint.step - 1, "policy", "unavailable", decision.capabilityId));
    return null;
  }

  const executor = executors.get(capability.id);
  if (!executor || executor.capabilityVersion !== capability.version) {
    appendObservation(checkpoint, limits, {
      step: checkpoint.step,
      capabilityId: capability.id,
      status: "unavailable",
      summary: "Executor capability belum terpasang.",
    });
    checkpoint.step += 1;
    trace.push(event(checkpoint.step - 1, "policy", "executor_missing", capability.id));
    return null;
  }

  let validated: ReturnType<AgentCapabilityExecutor["validate"]>;
  try {
    validated = executor.validate(decision.input);
  } catch {
    validated = { ok: false, reason: "Validator executor gagal." };
  }
  if (!validated.ok) {
    appendObservation(checkpoint, limits, {
      step: checkpoint.step,
      capabilityId: capability.id,
      status: "denied",
      summary: boundedText(validated.reason, 500) || "Input tidak sah.",
    });
    checkpoint.step += 1;
    trace.push(event(checkpoint.step - 1, "policy", "invalid_input", capability.id));
    return null;
  }

  if (!isJsonValue(validated.value)) {
    appendObservation(checkpoint, limits, {
      step: checkpoint.step,
      capabilityId: capability.id,
      status: "denied",
      summary: "Validator menghasilkan nilai yang tidak dapat di-checkpoint.",
    });
    checkpoint.step += 1;
    trace.push(event(checkpoint.step - 1, "policy", "invalid_value", capability.id));
    return null;
  }
  const validatedValue = freezeJsonValue(structuredClone(validated.value));
  const digest = actionDigest(
    checkpoint,
    input.scope,
    decision,
    validatedValue,
  );

  let authorization: AgentAuthorization;
  try {
    const rawAuthorization = await boundedCall(
      (signal) =>
        Promise.resolve(
          policy({
            scope: input.scope,
            capability,
            value: structuredClone(validatedValue),
            runId: checkpoint.runId,
            step: checkpoint.step,
            signal,
          }),
        ),
      input.signal,
      deadlineAt,
      now,
    );
    if (!validAuthorization(rawAuthorization)) {
      appendObservation(checkpoint, limits, {
        step: checkpoint.step,
        capabilityId: capability.id,
        status: "denied",
        summary: "Kebijakan otorisasi memberi hasil yang tidak sah.",
      });
      checkpoint.step += 1;
      trace.push(event(checkpoint.step - 1, "policy", "invalid", capability.id));
      return null;
    }
    authorization = rawAuthorization;
  } catch (error) {
    const reason = abortReason(
      error,
      input.signal,
      deadlineAt,
      budgetOwnsDeadline,
      now,
      runBudget,
    );
    if (reason !== "invalid_planner_output") {
      return stopped(reason, checkpoint, trace);
    }
    appendObservation(checkpoint, limits, {
      step: checkpoint.step,
      capabilityId: capability.id,
      status: "denied",
      summary: "Kebijakan otorisasi gagal tertutup.",
    });
    checkpoint.step += 1;
    trace.push(event(checkpoint.step - 1, "policy", "error", capability.id));
    return null;
  }
  if (authorization.decision === "deny") {
    appendObservation(checkpoint, limits, {
      step: checkpoint.step,
      capabilityId: capability.id,
      status: "denied",
      summary: boundedText(authorization.reason, 500) || "Ditolak kebijakan.",
    });
    checkpoint.step += 1;
    trace.push(event(checkpoint.step - 1, "policy", "denied", capability.id));
    return null;
  }
  if (authorization.decision === "approval") {
    const expiresAt = approvalExpiry(authorization.expiresAt, now);
    const approval: AgentApprovalRequest = {
      runId: checkpoint.runId,
      step: checkpoint.step,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      binding: approvalBinding(digest, expiresAt),
      expiresAt,
    };
    checkpoint.pending = {
      proposal: decision,
      validatedValue,
      digest,
      approval,
    };
    trace.push(event(checkpoint.step, "approval", "required", capability.id));
    return { status: "needs_approval", approval, checkpoint, trace };
  }

  return executeAction({
    input,
    checkpoint,
    decision,
    capability,
    executor,
    validatedValue,
    digest,
    limits,
    deadlineAt,
    budgetOwnsDeadline,
    freshness,
    trace,
    now,
    runBudget,
  });
}

interface ExecuteDependencies {
  input: AgentRunInput;
  checkpoint: AgentRunCheckpoint;
  decision: Extract<AgentPlannerDecision, { kind: "action" }>;
  capability: CapabilitySnapshotEntry;
  executor: AgentCapabilityExecutor;
  validatedValue: unknown;
  digest: string;
  limits: AgentRunLimits;
  deadlineAt: number;
  budgetOwnsDeadline: boolean;
  freshness: () => Promise<FreshnessState>;
  trace: AgentTraceEvent[];
  now: () => Date;
  runBudget: RunBudgetAccount;
}

async function executeAction(
  dependencies: ExecuteDependencies,
): Promise<AgentRunResult | null> {
  const {
    input,
    checkpoint,
    capability,
    executor,
    validatedValue,
    digest,
    limits,
    deadlineAt,
    budgetOwnsDeadline,
    freshness,
    trace,
    now,
    runBudget,
  } = dependencies;
  const stop = stopReason(
    input.signal,
    deadlineAt,
    budgetOwnsDeadline,
    now,
    runBudget,
  );
  if (stop) return stopped(stop, checkpoint, trace);
  const preExecuteFreshness = await freshness();
  if (preExecuteFreshness !== "current") {
    return stopped(preExecuteFreshness, checkpoint, trace);
  }
  const stopAfterFreshness = stopReason(
    input.signal,
    deadlineAt,
    budgetOwnsDeadline,
    now,
    runBudget,
  );
  if (stopAfterFreshness) {
    return stopped(stopAfterFreshness, checkpoint, trace);
  }
  try {
    runBudget.consumeToolCall();
  } catch (error) {
    return stopped(
      runBudgetReason(error) ?? "budget_tool_calls",
      checkpoint,
      trace,
    );
  }
  trace.push(event(checkpoint.step, "execute", "started", capability.id));
  input.onActivity?.({ phase: "executing", capabilityId: capability.id });
  let result: AgentExecutorResult;
  try {
    result = await boundedCall(
      (signal) =>
        executor.execute(validatedValue, {
          runId: checkpoint.runId,
          step: checkpoint.step,
          scope: input.scope,
          idempotencyKey: digest,
          signal,
          runBudget,
          ...(input.workSignals ? { workSignals: input.workSignals } : {}),
        }),
      input.signal,
      deadlineAt,
      now,
    );
  } catch (error) {
    const reason = abortReason(
      error,
      input.signal,
      deadlineAt,
      budgetOwnsDeadline,
      now,
      runBudget,
    );
    if (reason !== "invalid_planner_output") {
      return stopped(reason, checkpoint, trace);
    }
    result = { status: "error", summary: "Executor gagal tanpa hasil terverifikasi." };
  }
  const beforeExecuteFreshness = await freshness();
  if (beforeExecuteFreshness !== "current") {
    appendObservation(checkpoint, limits, {
      step: checkpoint.step,
      capabilityId: capability.id,
      status: "unknown",
      summary: "Executor mungkin sudah berjalan, tetapi authority berubah sebelum hasil dapat dipercaya.",
    });
    checkpoint.pending = null;
    checkpoint.step += 1;
    trace.push(event(checkpoint.step - 1, "execute", "unknown", capability.id));
    return stopped(beforeExecuteFreshness, checkpoint, trace);
  }
  if (!validExecutorResult(result)) {
    result = { status: "unknown", summary: "Bentuk hasil executor tidak sah." };
  }
  appendObservation(checkpoint, limits, {
    step: checkpoint.step,
    capabilityId: capability.id,
    status: result.status,
    summary:
      boundedObservationSummary(result.summary, limits.maxObservationCharacters) ||
      "Executor tidak memberi ringkasan.",
  });
  checkpoint.pending = null;
  checkpoint.step += 1;
  trace.push(event(checkpoint.step - 1, "execute", result.status, capability.id));
  return null;
}

async function resumePending(dependencies: {
  input: AgentRunInput;
  checkpoint: AgentRunCheckpoint;
  snapshot: CapabilitySnapshot;
  executors: ReadonlyMap<string, AgentCapabilityExecutor>;
  limits: AgentRunLimits;
  deadlineAt: number;
  budgetOwnsDeadline: boolean;
  freshness: () => Promise<FreshnessState>;
  trace: AgentTraceEvent[];
  now: () => Date;
  runBudget: RunBudgetAccount;
}): Promise<AgentRunResult | null> {
  const {
    input,
    checkpoint,
    snapshot,
    executors,
    limits,
    deadlineAt,
    budgetOwnsDeadline,
    freshness,
    trace,
    now,
    runBudget,
  } = dependencies;
  const pending = checkpoint.pending;
  if (!pending) return null;
  if (
    !input.approval ||
    !validApprovalGrant(input.approval, pending.approval, now())
  ) {
    trace.push(event(checkpoint.step, "approval", "missing_or_invalid", pending.proposal.capabilityId));
    return {
      status: "needs_approval",
      approval: pending.approval,
      checkpoint,
      trace,
    };
  }
  const capability = snapshot.entries.find(
    (entry) =>
      entry.id === pending.proposal.capabilityId &&
      entry.version === pending.proposal.capabilityVersion &&
      entry.available,
  );
  const executor = capability
    ? executors.get(capability.id)
    : undefined;
  if (
    !capability ||
    !executor ||
    executor.capabilityVersion !== capability.version
  ) {
    checkpoint.pending = null;
    appendObservation(checkpoint, limits, {
      step: checkpoint.step,
      capabilityId: pending.proposal.capabilityId,
      status: "unavailable",
      summary: "Capability berubah atau executor tidak lagi tersedia.",
    });
    checkpoint.step += 1;
    return null;
  }
  const stop = stopReason(
    input.signal,
    deadlineAt,
    budgetOwnsDeadline,
    now,
    runBudget,
  );
  if (stop) return stopped(stop, checkpoint, trace);
  const pendingFreshness = await freshness();
  if (pendingFreshness !== "current") {
    return stopped(pendingFreshness, checkpoint, trace);
  }
  trace.push(event(checkpoint.step, "approval", "accepted", capability.id));
  return executeAction({
    input,
    checkpoint,
    decision: pending.proposal,
    capability,
    executor,
    validatedValue: pending.validatedValue,
    digest: pending.digest,
    limits,
    deadlineAt,
    budgetOwnsDeadline,
    freshness,
    trace,
    now,
    runBudget,
  });
}

function parsePlannerDecision(value: unknown): AgentPlannerDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "final" && typeof record.reply === "string") {
    return { kind: "final", reply: record.reply };
  }
  if (record.kind === "need_input" && typeof record.prompt === "string") {
    return { kind: "need_input", prompt: record.prompt };
  }
  if (
    record.kind === "action" &&
    typeof record.capabilityId === "string" &&
    typeof record.capabilityVersion === "string" &&
    "input" in record &&
    isJsonValue(record.input)
  ) {
    return {
      kind: "action",
      capabilityId: record.capabilityId,
      capabilityVersion: record.capabilityVersion,
      input: record.input,
    };
  }
  return null;
}

function initialCheckpoint(
  input: AgentRunInput,
  snapshot: CapabilitySnapshot,
  callableHash: string,
  now: () => Date,
  limits: AgentRunLimits,
  runBudget: RunBudgetAccount,
): { ok: true; value: AgentRunCheckpoint } | { ok: false } {
  if (!input.checkpoint) {
    const initialUserInputs = normalizeInitialUserInputs(
      input.initialUserInputs,
      limits.maxObservationCharacters,
    );
    if (initialUserInputs === null) return { ok: false };
    const checkpoint = emptyCheckpoint(
      input,
      snapshot,
      callableHash,
      now,
      limits,
      runBudget,
    );
    checkpoint.userInputs = initialUserInputs;
    return {
      ok: true,
      value: checkpoint,
    };
  }
  if ((input.initialUserInputs?.length ?? 0) > 0) return { ok: false };
  const checkpoint = structuredClone(input.checkpoint);
  if (!isValidAgentRunCheckpoint(checkpoint, input.scope, input.request)) {
    return { ok: false };
  }
  return { ok: true, value: checkpoint };
}

function normalizeInitialUserInputs(
  inputs: readonly AgentUserInput[] | undefined,
  maxCharacters: number,
): AgentUserInput[] | null {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs) || inputs.length > 16) return null;
  const normalized: AgentUserInput[] = [];
  for (const input of inputs) {
    if (!input || input.step !== 0 || typeof input.text !== "string") {
      return null;
    }
    const text = boundedText(input.text, maxCharacters);
    if (!text) return null;
    if (input.prompt !== undefined) {
      if (typeof input.prompt !== "string") return null;
      const prompt = boundedText(input.prompt, 500);
      if (!prompt) return null;
      normalized.push({ step: 0, prompt, text });
    } else {
      normalized.push({ step: 0, text });
    }
  }
  return normalized;
}

/** Codec tunggal untuk checkpoint dari proses maupun penyimpanan durable. */
export function isValidAgentRunCheckpoint(
  value: unknown,
  scope: AgentScope,
  request: string,
): value is AgentRunCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as AgentRunCheckpoint;
  const startedAt = Date.parse(checkpoint.startedAt);
  const deadlineAt = Date.parse(checkpoint.deadlineAt);
  return (
    (checkpoint.version === 1 || checkpoint.version === 2) &&
    checkpoint.scopeKey === scopeKey(scope) &&
    checkpoint.request === request &&
    typeof checkpoint.runId === "string" &&
    checkpoint.runId.length > 0 &&
    typeof checkpoint.capabilityHash === "string" &&
    /^[a-f0-9]{16}$/u.test(checkpoint.capabilityHash) &&
    typeof checkpoint.callableHash === "string" &&
    /^[a-f0-9]{64}$/u.test(checkpoint.callableHash) &&
    typeof checkpoint.startedAt === "string" &&
    typeof checkpoint.deadlineAt === "string" &&
    Number.isFinite(startedAt) &&
    Number.isFinite(deadlineAt) &&
    deadlineAt > startedAt &&
    deadlineAt - startedAt <= MAX_AGENT_CHECKPOINT_HORIZON_MS &&
    Number.isInteger(checkpoint.maxSteps) &&
    checkpoint.maxSteps > 0 &&
    Number.isInteger(checkpoint.step) &&
    checkpoint.step >= 0 &&
    checkpoint.step < checkpoint.maxSteps &&
    Array.isArray(checkpoint.observations) &&
    checkpoint.observations.every(validCheckpointObservation) &&
    Array.isArray(checkpoint.userInputs) &&
    checkpoint.userInputs.every(validUserInput) &&
    Array.isArray(checkpoint.seenActionDigests) &&
    checkpoint.seenActionDigests.every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest),
    ) &&
    validPendingCheckpoint(checkpoint, scope) &&
    validPendingInput(checkpoint) &&
    validCheckpointRunBudget(checkpoint) &&
    !(checkpoint.pending !== null && checkpoint.pendingInput !== null)
  );
}

function validUserInput(value: unknown): value is AgentUserInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.step) &&
    (record.step as number) >= 0 &&
    (record.prompt === undefined ||
      (typeof record.prompt === "string" && record.prompt.trim().length > 0)) &&
    typeof record.text === "string" &&
    record.text.length > 0
  );
}

function validPendingInput(checkpoint: AgentRunCheckpoint): boolean {
  if (checkpoint.pendingInput === null) return true;
  const pending = checkpoint.pendingInput as unknown;
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
    return false;
  }
  const record = pending as Record<string, unknown>;
  return (
    record.step === checkpoint.step &&
    typeof record.prompt === "string" &&
    record.prompt.trim().length > 0
  );
}

function validCheckpointRunBudget(checkpoint: AgentRunCheckpoint): boolean {
  if (checkpoint.version === 1) return checkpoint.runBudget === undefined;
  return checkpoint.runBudget !== undefined &&
    isValidRunBudgetCheckpoint(checkpoint.runBudget) &&
    checkpoint.runBudget.limits.maxSteps === checkpoint.maxSteps;
}

function validCheckpointObservation(value: unknown): value is AgentObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.step) &&
    (record.step as number) >= 0 &&
    typeof record.capabilityId === "string" &&
    (record.status === "ok" ||
      record.status === "denied" ||
      record.status === "unavailable" ||
      record.status === "error" ||
      record.status === "unknown") &&
    typeof record.summary === "string"
  );
}

function validPendingCheckpoint(
  checkpoint: AgentRunCheckpoint,
  scope: AgentScope,
): boolean {
  if (checkpoint.pending === null) return true;
  const pending = checkpoint.pending as unknown;
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
    return false;
  }
  const record = pending as Record<string, unknown>;
  const proposal = parsePlannerDecision(record.proposal);
  if (proposal?.kind !== "action") return false;
  if (
    typeof record.digest !== "string" ||
    !isJsonValue(record.validatedValue)
  ) {
    return false;
  }
  const approval = record.approval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return false;
  }
  const request = approval as Record<string, unknown>;
  if (
    request.runId !== checkpoint.runId ||
    request.step !== checkpoint.step ||
    request.capabilityId !== proposal.capabilityId ||
    request.capabilityVersion !== proposal.capabilityVersion ||
    typeof request.binding !== "string" ||
    typeof request.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(request.expiresAt))
  ) {
    return false;
  }
  const digest = actionDigest(
    checkpoint,
    scope,
    proposal,
    record.validatedValue,
  );
  return (
    record.digest === digest &&
    request.binding === approvalBinding(digest, request.expiresAt)
  );
}

function emptyCheckpoint(
  input: AgentRunInput,
  snapshot: CapabilitySnapshot,
  callableHash: string,
  now: () => Date,
  limits: AgentRunLimits,
  runBudget: RunBudgetAccount,
): AgentRunCheckpoint {
  const started = now();
  return {
    version: 2,
    runId: input.makeRunId?.() ?? randomUUID(),
    scopeKey: scopeKey(input.scope),
    capabilityHash: snapshot.hash,
    callableHash,
    request: input.request,
    startedAt: started.toISOString(),
    deadlineAt: new Date(started.getTime() + limits.resumeWindowMs).toISOString(),
    maxSteps: Math.min(limits.maxSteps, runBudget.view(0).remainingSteps),
    step: 0,
    observations: [],
    userInputs: [],
    seenActionDigests: [],
    pending: null,
    pendingInput: null,
    runBudget: runBudget.checkpoint(),
  };
}

function callableCapabilities(
  snapshot: CapabilitySnapshot,
  executors: ReadonlyMap<string, AgentCapabilityExecutor>,
): AgentPlannerInput["callableCapabilities"] {
  return Object.freeze(
    snapshot.entries
      .filter((entry) => {
        const executor = executors.get(entry.id);
        return entry.available && executor?.capabilityVersion === entry.version;
      })
      .map((entry) => {
        const nativeTool = executors.get(entry.id)?.nativeTool;
        return Object.freeze({
          id: entry.id,
          version: entry.version,
          effect: entry.effect,
          description: entry.description,
          ...(nativeTool
            ? { nativeTool: immutableNativeTool(nativeTool) }
            : {}),
        });
      }),
  );
}

function callableCapabilityHash(
  snapshot: CapabilitySnapshot,
  executors: ReadonlyMap<string, AgentCapabilityExecutor>,
): string {
  const authority = callableCapabilities(snapshot, executors).map((entry) => ({
    id: entry.id,
    version: entry.version,
    nativeTool: entry.nativeTool ?? null,
  }));
  return createHash("sha256").update(canonicalJson(authority)).digest("hex");
}

function executorMap(
  executors: readonly AgentCapabilityExecutor[],
): ReadonlyMap<string, AgentCapabilityExecutor> {
  const result = new Map<string, AgentCapabilityExecutor>();
  const nativeNames = new Set<string>();
  for (const executor of executors) {
    if (result.has(executor.capabilityId)) {
      throw new Error(`Executor capability duplikat: ${executor.capabilityId}.`);
    }
    if (executor.nativeTool) {
      if (!validNativeTool(executor.nativeTool)) {
        throw new Error(`Schema native executor tidak sah: ${executor.capabilityId}.`);
      }
      if (nativeNames.has(executor.nativeTool.name)) {
        throw new Error(`Nama native tool duplikat: ${executor.nativeTool.name}.`);
      }
      nativeNames.add(executor.nativeTool.name);
    }
    result.set(executor.capabilityId, executor);
  }
  return result;
}

function immutableNativeTool(
  tool: AgentNativeToolDefinition,
): AgentNativeToolDefinition {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: freezeJsonValue(structuredClone(tool.inputSchema)) as Readonly<
      Record<string, unknown>
    >,
  });
}

function validNativeTool(tool: AgentNativeToolDefinition): boolean {
  return (
    /^[A-Za-z0-9_-]{1,64}$/u.test(tool.name) &&
    tool.description.trim().length > 0 &&
    tool.description.length <= 1_024 &&
    tool.inputSchema !== null &&
    typeof tool.inputSchema === "object" &&
    !Array.isArray(tool.inputSchema) &&
    tool.inputSchema["type"] === "object" &&
    isJsonValue(tool.inputSchema)
  );
}

function conservativePolicy(input: {
  capability: CapabilitySnapshotEntry;
}): AgentAuthorization {
  if (
    input.capability.confirmation === "none" &&
    (input.capability.effect === "none" || input.capability.effect === "read")
  ) {
    return { decision: "allow" };
  }
  return { decision: "approval" };
}

function resolvedLimits(overrides?: Partial<AgentRunLimits>): AgentRunLimits {
  const limits = { ...DEFAULT_AGENT_RUN_LIMITS, ...overrides };
  // Pemanggil lama yang hanya mengubah deadline tetap mendapat semantik lama;
  // jendela resume lebih panjang harus dipilih secara eksplisit.
  if (overrides?.deadlineMs !== undefined && overrides.resumeWindowMs === undefined) {
    limits.resumeWindowMs = overrides.deadlineMs;
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Batas agent ${name} tidak sah.`);
    }
  }
  if (limits.resumeWindowMs > MAX_AGENT_CHECKPOINT_HORIZON_MS) {
    throw new Error("Horizon resume agent maksimal sepuluh menit.");
  }
  if (limits.maxObservationCharacters < MIN_AGENT_OBSERVATION_CHARACTERS) {
    throw new Error(
      `Batas observation agent minimal ${MIN_AGENT_OBSERVATION_CHARACTERS} karakter.`,
    );
  }
  return limits;
}

function budgetPolicyFor(
  policy: RunBudgetPolicy | undefined,
  limits: AgentRunLimits,
  checkpoint: AgentRunCheckpoint | undefined,
): RunBudgetPolicy {
  const legacyMaxSteps = checkpoint?.version === 1
    ? checkpoint.maxSteps
    : Number.POSITIVE_INFINITY;
  return {
    ...policy,
    limits: {
      ...policy?.limits,
      maxSteps: Math.min(
        limits.maxSteps,
        policy?.limits?.maxSteps ?? limits.maxSteps,
        legacyMaxSteps,
      ),
      deadlineMs: Math.min(
        limits.deadlineMs,
        policy?.limits?.deadlineMs ?? limits.deadlineMs,
      ),
    },
  };
}

function appendObservation(
  checkpoint: AgentRunCheckpoint,
  limits: AgentRunLimits,
  observation: AgentObservation,
): void {
  checkpoint.observations.push({
    ...observation,
    summary: boundedObservationSummary(
      observation.summary,
      limits.maxObservationCharacters,
    ),
  });
}

/**
 * Pertahanan terakhir bagi executor pihak lain. JSON yang terlalu besar tidak
 * pernah dipotong menjadi dokumen rusak; detailnya diganti envelope valid.
 */
function boundedObservationSummary(value: string, maxCharacters: number): string {
  return compactObservationSummary(value, maxCharacters, {
    reason: "executor_summary_exceeded_budget",
  });
}

function validExecutorResult(value: unknown): value is AgentExecutorResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.status === "ok" ||
      record.status === "error" ||
      record.status === "unknown") &&
    typeof record.summary === "string"
  );
}

function validAuthorization(value: unknown): value is AgentAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.decision === "allow") return true;
  if (record.decision === "deny") return typeof record.reason === "string";
  return (
    record.decision === "approval" &&
    (record.expiresAt === undefined || typeof record.expiresAt === "string")
  );
}

function actionDigest(
  checkpoint: AgentRunCheckpoint,
  scope: AgentScope,
  decision: Extract<AgentPlannerDecision, { kind: "action" }>,
  validatedValue: unknown,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        runId: checkpoint.runId,
        step: checkpoint.step,
        scopeKey: scopeKey(scope),
        capabilityId: decision.capabilityId,
        capabilityVersion: decision.capabilityVersion,
        proposalInput: decision.input,
        validatedValue,
      }),
    )
    .digest("hex");
}

function actionFingerprint(
  scope: AgentScope,
  decision: Extract<AgentPlannerDecision, { kind: "action" }>,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        scopeKey: scopeKey(scope),
        capabilityId: decision.capabilityId,
        capabilityVersion: decision.capabilityVersion,
        input: decision.input,
      }),
    )
    .digest("hex");
}

function approvalBinding(digest: string, expiresAt: string): string {
  return createHash("sha256")
    .update(`${digest}\u0000${expiresAt}`)
    .digest("hex");
}

function approvalExpiry(value: string | undefined, now: () => Date): string {
  const maximum = now().getTime() + 10 * 60 * 1_000;
  if (value) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime()) && parsed.getTime() > now().getTime()) {
      return new Date(Math.min(parsed.getTime(), maximum)).toISOString();
    }
  }
  return new Date(maximum).toISOString();
}

function validApprovalGrant(
  grant: AgentApprovalGrant,
  request: AgentApprovalRequest,
  current: Date,
): boolean {
  const approvedAt = Date.parse(grant.approvedAt);
  const expiresAt = Date.parse(request.expiresAt);
  const currentAt = current.getTime();
  return (
    grant.binding === request.binding &&
    Number.isFinite(approvedAt) &&
    Number.isFinite(expiresAt) &&
    approvedAt <= expiresAt &&
    approvedAt <= currentAt &&
    currentAt <= expiresAt
  );
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function freezeJsonValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeJsonValue(item);
    return Object.freeze(value);
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    freezeJsonValue(item);
  }
  return Object.freeze(value);
}

function immutableObservations(
  observations: readonly AgentObservation[],
): readonly AgentObservation[] {
  return Object.freeze(
    observations.map((observation) => Object.freeze({ ...observation })),
  );
}

function immutableUserInputs(
  inputs: readonly AgentUserInput[],
): readonly AgentUserInput[] {
  return Object.freeze(inputs.map((input) => Object.freeze({ ...input })));
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  if (
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    return "null";
  }
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function boundedText(value: string, maxCharacters: number): string {
  const clean = value.trim();
  if (clean.length <= maxCharacters) return clean;
  return `${clean.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`;
}

function event(
  step: number,
  phase: AgentTraceEvent["phase"],
  outcome: string,
  capabilityId: string | null = null,
): AgentTraceEvent {
  return { step, phase, outcome, capabilityId };
}

function stopped(
  reason: Extract<AgentRunResult, { status: "stopped" }>["reason"],
  checkpoint: AgentRunCheckpoint,
  trace: AgentTraceEvent[],
): AgentRunResult {
  trace.push(event(checkpoint.step, "terminate", reason));
  return { status: "stopped", reason, checkpoint, trace };
}

function stopReason(
  signal: AbortSignal | undefined,
  deadlineAt: number,
  budgetOwnsDeadline: boolean,
  now: () => Date,
  runBudget: RunBudgetAccount,
): "cancelled" | "deadline" | "budget_deadline" | null {
  if (signal?.aborted) return "cancelled";
  if (now().getTime() >= deadlineAt) {
    return budgetOwnsDeadline ? "budget_deadline" : "deadline";
  }
  return runBudget.isTimeExhausted() ? "budget_deadline" : null;
}

function abortReason(
  error: unknown,
  signal: AbortSignal | undefined,
  deadlineAt: number,
  budgetOwnsDeadline: boolean,
  now: () => Date,
  runBudget: RunBudgetAccount,
):
  | "cancelled"
  | "deadline"
  | "stale"
  | "invalid_planner_output"
  | AgentUsageLimitReason
  | RunBudgetExhaustionReason {
  if (signal?.aborted) return "cancelled";
  if (now().getTime() >= deadlineAt) {
    return budgetOwnsDeadline ? "budget_deadline" : "deadline";
  }
  const budgetReason = runBudgetReason(error);
  if (budgetReason) return budgetReason;
  if (error instanceof AgentRunStaleError) return "stale";
  // `boundedCall` memakai clock monotonic AbortSignal. Timer itu dapat menang
  // beberapa mikrodetik sebelum wall clock `now()` membulat ke deadline. Pada
  // AbortError, atribusikan ke owner deadline yang sudah dipilih, bukan pada
  // pembacaan RunBudget berikutnya yang dapat berubah karena scheduling load.
  if (error instanceof Error && error.name === "AbortError") {
    return budgetOwnsDeadline ? "budget_deadline" : "deadline";
  }
  const usageLimit = usageLimitReason(error);
  if (usageLimit) return usageLimit;
  const overage = runBudget.workOverageReason();
  if (overage) return overage;
  if (runBudget.isTimeExhausted()) return "budget_deadline";
  return "invalid_planner_output";
}

function usageLimitReason(error: unknown): AgentUsageLimitReason | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const record = error as Record<string, unknown>;
  if (record["name"] !== "UsageLimitError") return null;
  switch (record["reason"]) {
    case "anti_abuse":
      return "usage_anti_abuse";
    case "wallet_disabled":
      return "usage_wallet_disabled";
    case "byok_unavailable":
      return "usage_byok_unavailable";
    case "wallet_empty":
    case "allowance_exhausted":
    default:
      return "usage_allowance_exhausted";
  }
}

async function boundedCall<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  outerSignal: AbortSignal | undefined,
  deadlineAt: number,
  now: () => Date,
): Promise<T> {
  if (outerSignal?.aborted || now().getTime() >= deadlineAt) {
    return Promise.reject(abortError());
  }
  const remaining = deadlineAt - now().getTime();
  const deadlineSignal = AbortSignal.timeout(remaining);
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, deadlineSignal])
    : deadlineSignal;
  if (signal.aborted || now().getTime() >= deadlineAt) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    let running: Promise<T>;
    try {
      running = operation(signal);
    } catch (error) {
      signal.removeEventListener("abort", abort);
      reject(error);
      return;
    }
    running.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(abortError());
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  const error = new Error("Agent run dibatalkan.");
  error.name = "AbortError";
  return error;
}
