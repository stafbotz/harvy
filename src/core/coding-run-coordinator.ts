import { createHash } from "node:crypto";
import type {
  CodingAdvisoryReceipt,
  CodingPlanStep,
  CodingRun,
  CodingTaskBrief,
  CodingValidatorKind,
} from "../domain/coding-run.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import type {
  SandboxExecRequest,
  SandboxExecResult,
} from "../domain/sandbox.js";
import type {
  ReadOnlyRepositoryTools,
  StructuredPatchOperation,
} from "../coding/repository-tools.js";
import { containsSecretLikeValue } from "../security/credential-like.js";

const DEFAULT_MAX_ACTIONS = 64;
const DEFAULT_WORKER_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OBSERVATION_CHARACTERS = 128_000;
const ACTIVE_COORDINATOR_RUNS = new Set<string>();

export type CodingWorkerAction =
  | {
      kind: "plan";
      steps: Array<Pick<CodingPlanStep, "stage" | "description" | "paths">>;
    }
  | { kind: "tree"; path?: string; maxDepth?: number }
  | { kind: "read"; path: string; startLine?: number; endLine?: number }
  | {
      kind: "search";
      query: string;
      path?: string;
      caseSensitive?: boolean;
      extensions?: string[];
    }
  | { kind: "symbols"; query?: string }
  | { kind: "references"; symbol: string }
  | { kind: "diff" }
  | { kind: "apply_patch"; operations: StructuredPatchOperation[] }
  | { kind: "sandbox.exec"; request: SandboxExecRequest }
  | { kind: "validator"; validator: CodingValidatorKind }
  | { kind: "task_review" }
  | { kind: "finalize" }
  | { kind: "yield"; reasonCode: string; question: string };

export interface CodingCoordinatorRunView {
  runId: string;
  projectId: string;
  status: CodingRun["status"];
  phase: CodingRun["phase"];
  instructionRevision: number;
  appliedInstructionRevision: number;
  stateRevision: number;
  taskBrief: CodingTaskBrief;
  constraints: Array<Pick<
    CodingRun["constraints"][number],
    "kind" | "content" | "instructionRevision"
  >>;
  repositoryMap: CodingRun["repositoryMap"];
  plan: CodingRun["plan"];
  diff: CodingRun["diff"];
  validators: Array<Pick<
    CodingRun["validatorReceipts"][number],
    "receiptId" | "kind" | "status" | "instructionRevision" | "completedAt"
  >>;
  taskReviews: Array<Pick<
    NonNullable<CodingRun["taskReviewReceipts"]>[number],
    "receiptId" | "status" | "instructionRevision" | "completedAt"
  >>;
  advisories?: Array<Pick<
    CodingAdvisoryReceipt,
    "advisoryId" | "role" | "status" | "instructionRevision" |
      "summary" | "summaryDigest" | "createdAt"
  >>;
  counters: CodingRun["counters"];
  limits: CodingRun["limits"];
}

export interface CodingWorkerObservation {
  kind: string;
  payload: unknown;
  digest: string;
  compacted: boolean;
  originalCharacters: number;
}

export interface CodingWorkerInput {
  run: CodingCoordinatorRunView;
  previousObservation: CodingWorkerObservation | null;
}

export interface CodingAdvisoryInput {
  run: CodingCoordinatorRunView;
  repositoryEvidence: {
    tree: CodingWorkerObservation;
    diff: CodingWorkerObservation;
  };
}

export interface CodingAdvisoryDraft {
  role: CodingAdvisoryReceipt["role"];
  status: CodingAdvisoryReceipt["status"];
  summary: string;
}

/** Provider/model policy adapter. It receives no conversation or personal memory. */
export interface CodingWorkerDriver {
  next(
    input: CodingWorkerInput,
    signal?: AbortSignal,
  ): Promise<CodingWorkerAction>;
  advise?(
    input: CodingAdvisoryInput,
    signal?: AbortSignal,
  ): Promise<CodingAdvisoryDraft[]>;
}

export type CodingCoordinatorRepositoryTools = Pick<
  ReadOnlyRepositoryTools,
  "tree" | "read" | "search" | "symbols" | "references" | "diff"
>;

export interface CodingCoordinatorEngine {
  get(scope: WorkspaceAgentScope, runId: string): Promise<CodingRun | null>;
  reserveCoordinatorInvocation(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedStateRevision: number,
  ): Promise<CodingRun>;
  writerTools(
    scope: WorkspaceAgentScope,
    runId: string,
  ): Promise<CodingCoordinatorRepositoryTools>;
  markMapped(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
  ): Promise<CodingRun>;
  recordPlan(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    input: {
      steps: Array<Pick<CodingPlanStep, "stage" | "description" | "paths">>;
    },
    expectedStateRevision?: number,
  ): Promise<CodingRun>;
  recordAdvisories?(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    drafts: readonly CodingAdvisoryDraft[],
    expectedStateRevision?: number,
  ): Promise<CodingRun>;
  applyPatch(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    operations: readonly StructuredPatchOperation[],
    expectedStateRevision?: number,
  ): Promise<{ run: CodingRun; diff: CodingRun["diff"] }>;
  executeSandbox(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    request: SandboxExecRequest,
    signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<SandboxExecResult>;
  reserveCoordinatorDecision(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedStateRevision: number,
  ): Promise<CodingRun>;
  runCoordinatorDecision<T>(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedStateRevision: number,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  pauseCoordinator(
    scope: WorkspaceAgentScope,
    runId: string,
    reasonCode: string,
    question: string,
  ): Promise<CodingRun>;
  resumeCoordinator(
    scope: WorkspaceAgentScope,
    runId: string,
  ): Promise<CodingRun>;
  runValidator(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    kind: CodingValidatorKind,
    signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<{
    run: CodingRun;
    receipt: CodingRun["validatorReceipts"][number];
    diagnostic?: CodingValidatorDiagnostic;
  }>;
  runTaskReview(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<{
    run: CodingRun;
    receipt: NonNullable<CodingRun["taskReviewReceipts"]>[number];
  }>;
  finalize(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    expectedStateRevision?: number,
  ): Promise<CodingRun>;
  recoverPendingCommit(
    scope: WorkspaceAgentScope,
    runId: string,
  ): Promise<CodingRun>;
}

export interface CodingValidatorDiagnostic {
  status: SandboxExecResult["status"];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  artifacts: SandboxExecResult["artifacts"];
}

export interface CodingValidatorEscalationResult {
  status: "accepted" | "not_escalated" | "already_used" | "failed";
  code: string;
  recoveryHint?: string;
}

export interface CodingValidatorEscalationDriver {
  recover(input: {
    run: CodingCoordinatorRunView;
    receipt: CodingCoordinatorRunView["validators"][number];
    diagnostic: CodingValidatorDiagnostic | null;
  }, signal?: AbortSignal): Promise<CodingValidatorEscalationResult>;
}

export type CodingCoordinatorResult =
  | { outcome: "terminal"; actions: number; run: CodingRun }
  | {
      outcome: "yielded";
      actions: number;
      reasonCode: string;
      run: CodingRun;
    }
  | { outcome: "action_budget"; actions: number; run: CodingRun };

export interface CodingRunCoordinatorOptions {
  maxActions?: number;
  workerTimeoutMs?: number;
  maxObservationCharacters?: number;
  /** Best-effort facts-only observer; it never controls run state. */
  onProgress?: (run: CodingRun) => void | Promise<void>;
  validatorEscalation?: CodingValidatorEscalationDriver;
}

/**
 * Bounded long-horizon loop. Every repository mutation, validator, review and
 * finalization still crosses CodingRunEngine's durable freshness/CAS gates.
 */
export class CodingRunCoordinator {
  private readonly maxActions: number;
  private readonly workerTimeoutMs: number;
  private readonly maxObservationCharacters: number;
  private readonly onProgress:
    | ((run: CodingRun) => void | Promise<void>)
    | undefined;
  private readonly validatorEscalation:
    | CodingValidatorEscalationDriver
    | undefined;

  constructor(
    private readonly engine: CodingCoordinatorEngine,
    private readonly worker: CodingWorkerDriver,
    options: CodingRunCoordinatorOptions = {},
  ) {
    this.maxActions = boundedInteger(
      options.maxActions ?? DEFAULT_MAX_ACTIONS,
      "maxActions",
      512,
    );
    this.workerTimeoutMs = boundedInteger(
      options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
      "workerTimeoutMs",
      5 * 60_000,
    );
    this.maxObservationCharacters = boundedInteger(
      options.maxObservationCharacters ?? DEFAULT_MAX_OBSERVATION_CHARACTERS,
      "maxObservationCharacters",
      512_000,
    );
    this.onProgress = options.onProgress;
    this.validatorEscalation = options.validatorEscalation;
  }

  async run(
    scope: WorkspaceAgentScope,
    runIdInput: string,
    signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<CodingCoordinatorResult> {
    const runId = safeOpaque(runIdInput, "runId", 512);
    if (
      expectedStateRevision !== undefined &&
      (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 0)
    ) {
      throw new Error("expectedStateRevision CodingRun tidak sah.");
    }
    const admissionKey = `${scope.workspaceKey}\0${runId}`;
    if (ACTIVE_COORDINATOR_RUNS.has(admissionKey)) {
      throw new Error("CodingRun coordinator untuk run ini sudah aktif.");
    }
    ACTIVE_COORDINATOR_RUNS.add(admissionKey);
    let invocationAdmitted = false;
    try {
      if (expectedStateRevision !== undefined) {
        await this.engine.reserveCoordinatorInvocation(
          scope,
          runId,
          expectedStateRevision,
        );
      }
      invocationAdmitted = true;
      return await this.runLoop(
        scope,
        runId,
        signal,
        expectedStateRevision === undefined,
      );
    } catch (error) {
      if (invocationAdmitted) {
        await this.pauseAfterFailure(scope, runId, error).catch(() => undefined);
      }
      throw error;
    } finally {
      ACTIVE_COORDINATOR_RUNS.delete(admissionKey);
    }
  }

  private async runLoop(
    scope: WorkspaceAgentScope,
    runId: string,
    signal?: AbortSignal,
    allowPendingCommitRecovery = true,
  ): Promise<CodingCoordinatorResult> {
    let previousObservation: CodingWorkerObservation | null = null;
    for (let actions = 0; actions < this.maxActions; actions += 1) {
      if (signal?.aborted) throw abortError();
      let run = await this.requireRun(scope, runId);
      if (terminal(run)) return { outcome: "terminal", actions, run };
      if (run.status === "waiting_input") {
        run = await this.engine.resumeCoordinator(scope, runId);
      }
      if (run.status === "validating" && run.pendingCommit) {
        if (!allowPendingCommitRecovery) {
          throw new Error(
            "CodingRun commit barrier memerlukan recovery authority terpisah.",
          );
        }
        run = await this.engine.recoverPendingCommit(scope, runId);
        if (terminal(run)) return { outcome: "terminal", actions, run };
        if (run.status === "validating" && run.pendingCommit) {
          return {
            outcome: "yielded",
            actions,
            reasonCode: "commit_reconciliation_pending",
            run,
          };
        }
        previousObservation = observation(
          "commit.reconciled",
          { status: run.status, phase: run.phase, stateRevision: run.stateRevision },
          this.maxObservationCharacters,
        );
        continue;
      }
      const instructionRevision = run.instructionRevision;
      if (run.phase === "mapping") {
        run = await this.engine.markMapped(scope, runId, instructionRevision);
        await this.reportProgress(run);
        previousObservation = observation(
          "mapping.completed",
          {
            repositoryMap: run.repositoryMap,
            phase: run.phase,
          },
          this.maxObservationCharacters,
        );
        continue;
      }

      // Claiming the writer is the coordinator's explicit code.write gate.
      // It happens before any paid/provider decision, including yield-only
      // actions, and also enforces the run's active-time budget.
      const tools = await this.engine.writerTools(scope, runId);
      run = await this.requireRun(scope, runId);
      if (terminal(run)) return { outcome: "terminal", actions, run };
      const currentAdvisories = (run.advisoryReceipts ?? []).filter((receipt) =>
        receipt.instructionRevision === run.instructionRevision
      );
      if (
        run.phase === "planning" && this.worker.advise &&
        this.engine.recordAdvisories &&
        currentAdvisories.length === 0
      ) {
        if (
          run.counters.coordinatorDecisions >=
            run.limits.maxCoordinatorDecisions
        ) {
          const paused = await this.engine.pauseCoordinator(
            scope,
            runId,
            "decision_budget",
            "Batas keputusan kumulatif run ini tercapai sebelum advisory read-only dapat diselesaikan.",
          );
          return { outcome: "action_budget", actions, run: paused };
        }
        run = await this.engine.reserveCoordinatorDecision(
          scope,
          runId,
          run.stateRevision,
        );
        const advisoryStateRevision = run.stateRevision;
        const advisoryInstructionRevision = run.instructionRevision;
        const [tree, diff] = await Promise.all([
          tools.tree(advisoryInstructionRevision, { maxDepth: 8 }),
          tools.diff(advisoryInstructionRevision),
        ]);
        const advisoryInput: CodingAdvisoryInput = {
          run: runView(run),
          repositoryEvidence: {
            tree: this.observe("workspace.tree", tree),
            diff: this.observe("workspace.diff", diff),
          },
        };
        const rawDrafts = await this.engine.runCoordinatorDecision(
          scope,
          runId,
          advisoryStateRevision,
          this.workerTimeoutMs,
          signal,
          (workerSignal) => this.worker.advise!(advisoryInput, workerSignal),
        );
        const drafts = validateAdvisoryDrafts(rawDrafts);
        const current = await this.requireRun(scope, runId);
        if (
          current.stateRevision !== advisoryStateRevision ||
          current.instructionRevision !== advisoryInstructionRevision ||
          current.status !== run.status || current.phase !== run.phase
        ) throw new Error("CodingRun berubah selama advisory; handoff lama dibuang.");
        const advised = await this.engine.recordAdvisories(
          scope,
          runId,
          advisoryInstructionRevision,
          drafts,
          advisoryStateRevision,
        );
        previousObservation = this.observe("advisory.completed", {
          receipts: (advised.advisoryReceipts ?? [])
            .filter((receipt) =>
              receipt.instructionRevision === advisoryInstructionRevision
            )
            .map((receipt) => ({
              role: receipt.role,
              status: receipt.status,
              summaryDigest: receipt.summaryDigest,
            })),
        });
        await this.reportProgress(advised);
        continue;
      }
      if (
        run.counters.coordinatorDecisions >=
          run.limits.maxCoordinatorDecisions
      ) {
        const paused = await this.engine.pauseCoordinator(
          scope,
          runId,
          "decision_budget",
          "Batas keputusan kumulatif run ini tercapai. Balas anchor dengan arahan yang lebih sempit, atau batalkan run.",
        );
        return { outcome: "action_budget", actions, run: paused };
      }
      run = await this.engine.reserveCoordinatorDecision(
        scope,
        runId,
        run.stateRevision,
      );
      const decisionStateRevision = run.stateRevision;
      const decisionInstructionRevision = run.instructionRevision;

      const actionInput: CodingWorkerInput = {
        run: runView(run),
        previousObservation: previousObservation
          ? structuredClone(previousObservation)
          : null,
      };
      const rawAction = await this.engine.runCoordinatorDecision(
        scope,
        runId,
        decisionStateRevision,
        this.workerTimeoutMs,
        signal,
        (workerSignal) => this.worker.next(actionInput, workerSignal),
      );
      const action = validateAction(rawAction);
      const current = await this.requireRun(scope, runId);
      if (
        current.stateRevision !== decisionStateRevision ||
        current.instructionRevision !== decisionInstructionRevision ||
        current.status !== run.status ||
        current.phase !== run.phase
      ) {
        throw new Error(
          "CodingRun berubah selama keputusan worker; action lama dibuang.",
        );
      }
      run = current;
      if (action.kind === "yield") {
        const paused = await this.engine.pauseCoordinator(
          scope,
          runId,
          action.reasonCode,
          action.question,
        );
        return {
          outcome: "yielded",
          actions: actions + 1,
          reasonCode: action.reasonCode,
          run: paused,
        };
      }
      previousObservation = await this.executeAction(
        scope,
        run,
        action,
        tools,
        signal,
      );

      // A terminal effect (most commonly finalize) may consume the final
      // action slot. Report the durable terminal outcome instead of
      // misclassifying a successfully completed run as budget exhaustion.
      run = await this.requireRun(scope, runId);
      await this.reportProgress(run);
      if (terminal(run)) {
        return { outcome: "terminal", actions: actions + 1, run };
      }
    }
    // Ini checkpoint internal antar-invocation, bukan permintaan input manusia.
    // Application dapat menjadwalkan run durable yang sama setelah quiescence.
    const checkpoint = await this.requireRun(scope, runId);
    return {
      outcome: "action_budget",
      actions: this.maxActions,
      run: checkpoint,
    };
  }

  private async executeAction(
    scope: WorkspaceAgentScope,
    run: CodingRun,
    action: Exclude<CodingWorkerAction, { kind: "yield" }>,
    tools: CodingCoordinatorRepositoryTools,
    signal?: AbortSignal,
  ): Promise<CodingWorkerObservation> {
    const revision = run.instructionRevision;
    if (action.kind === "plan") {
      const updated = await this.engine.recordPlan(
        scope,
        run.runId,
        revision,
        { steps: action.steps },
        run.stateRevision,
      );
      return this.observe("plan.recorded", {
        phase: updated.phase,
        plan: updated.plan,
      });
    }
    if (action.kind === "apply_patch") {
      const applied = await this.engine.applyPatch(
        scope,
        run.runId,
        revision,
        action.operations,
        run.stateRevision,
      );
      return this.observe("patch.applied", {
        phase: applied.run.phase,
        diff: applied.diff,
      });
    }
    if (action.kind === "sandbox.exec") {
      const result = await this.engine.executeSandbox(
        scope,
        run.runId,
        revision,
        action.request,
        signal,
        run.stateRevision,
      );
      return this.observe("sandbox.exec", {
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        artifacts: result.artifacts,
        usage: result.usage,
      });
    }
    if (action.kind === "validator") {
      const validated = await this.engine.runValidator(
        scope,
        run.runId,
        revision,
        action.validator,
        signal,
        run.stateRevision,
      );
      const completed = {
        phase: validated.run.phase,
        receipt: receiptSummary(validated.receipt),
        ...(validated.diagnostic
          ? { diagnostic: structuredClone(validated.diagnostic) }
          : {}),
      };
      if (
        validated.receipt.status !== "failed" ||
        !this.validatorEscalation ||
        repeatedValidatorFailures(validated.run, validated.receipt) < 2
      ) return this.observe("validator.completed", completed);
      let escalation: CodingValidatorEscalationResult;
      try {
        escalation = validateEscalationResult(
          await this.validatorEscalation.recover({
            run: runView(validated.run),
            receipt: receiptSummary(validated.receipt),
            diagnostic: validated.diagnostic
              ? structuredClone(validated.diagnostic)
              : null,
          }, signal),
        );
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return this.observe("validator.completed", {
          ...completed,
          escalation: { status: "failed", code: "escalation_unavailable" },
        });
      }
      return this.observe("validator.completed", { ...completed, escalation });
    }
    if (action.kind === "task_review") {
      const reviewed = await this.engine.runTaskReview(
        scope,
        run.runId,
        revision,
        signal,
        run.stateRevision,
      );
      return this.observe("task_review.completed", {
        phase: reviewed.run.phase,
        receipt: taskReviewSummary(reviewed.receipt),
      });
    }
    if (action.kind === "finalize") {
      const completed = await this.engine.finalize(
        scope,
        run.runId,
        revision,
        run.stateRevision,
      );
      return this.observe("run.finalized", {
        status: completed.status,
        phase: completed.phase,
        result: completed.result,
      });
    }
    switch (action.kind) {
      case "tree":
        return this.observe(
          "workspace.tree",
          await tools.tree(revision, {
            ...(action.path === undefined ? {} : { path: action.path }),
            ...(action.maxDepth === undefined
              ? {}
              : { maxDepth: action.maxDepth }),
          }),
        );
      case "read":
        return this.observe(
          "workspace.read",
          await tools.read(revision, {
            path: action.path,
            ...(action.startLine === undefined
              ? {}
              : { startLine: action.startLine }),
            ...(action.endLine === undefined
              ? {}
              : { endLine: action.endLine }),
          }),
        );
      case "search":
        return this.observe(
          "workspace.search",
          await tools.search(revision, {
            query: action.query,
            ...(action.path === undefined ? {} : { path: action.path }),
            ...(action.caseSensitive === undefined
              ? {}
              : { caseSensitive: action.caseSensitive }),
            ...(action.extensions === undefined
              ? {}
              : { extensions: action.extensions }),
          }),
        );
      case "symbols":
        return this.observe(
          "workspace.symbols",
          await tools.symbols(
            revision,
            action.query === undefined ? {} : { query: action.query },
          ),
        );
      case "references":
        return this.observe(
          "workspace.references",
          await tools.references(revision, action.symbol),
        );
      case "diff":
        return this.observe("workspace.diff", await tools.diff(revision));
    }
  }

  private observe(kind: string, payload: unknown): CodingWorkerObservation {
    return observation(kind, payload, this.maxObservationCharacters);
  }

  private async requireRun(
    scope: WorkspaceAgentScope,
    runId: string,
  ): Promise<CodingRun> {
    const run = await this.engine.get(scope, runId);
    if (!run) throw new Error("CodingRun coordinator tidak menemukan run pada workspace.");
    return run;
  }

  private async reportProgress(run: CodingRun): Promise<void> {
    if (!this.onProgress) return;
    try {
      await this.onProgress(structuredClone(run));
    } catch {
      // Delivery is cosmetic. Durable run state remains authoritative.
    }
  }

  private async pauseAfterFailure(
    scope: WorkspaceAgentScope,
    runId: string,
    error: unknown,
  ): Promise<void> {
    const run = await this.engine.get(scope, runId);
    if (!run || run.status !== "running") return;
    await this.engine.pauseCoordinator(
      scope,
      runId,
      error instanceof Error && error.name === "AbortError"
        ? "coordinator_aborted"
        : "coordinator_error",
      error instanceof Error && error.name === "AbortError"
        ? "Pekerjaan terhenti sebelum langkah aktif selesai. Balas anchor untuk mencoba lagi dengan constraint terbaru, atau batalkan run."
        : "Pekerjaan tidak dapat melanjutkan langkah aktif dengan aman. Balas anchor dengan koreksi atau constraint tambahan, atau batalkan run.",
    );
  }
}

function validateAction(input: CodingWorkerAction): CodingWorkerAction {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Coding worker action bukan object.");
  }
  switch (input.kind) {
    case "plan":
      exactKeys(input, ["kind", "steps"]);
      if (!Array.isArray(input.steps)) throw new Error("Coding plan steps tidak sah.");
      return structuredClone(input);
    case "tree":
      optionalKeys(input, ["kind"], ["path", "maxDepth"]);
      if (input.path !== undefined) safePathText(input.path, "tree path");
      if (
        input.maxDepth !== undefined &&
        (!Number.isSafeInteger(input.maxDepth) || input.maxDepth < 0 ||
          input.maxDepth > 64)
      ) throw new Error("Coding tree maxDepth tidak sah.");
      return structuredClone(input);
    case "read":
      optionalKeys(input, ["kind", "path"], ["startLine", "endLine"]);
      safePathText(input.path, "read path");
      optionalPositive(input.startLine, "read startLine");
      optionalPositive(input.endLine, "read endLine");
      return structuredClone(input);
    case "search":
      optionalKeys(
        input,
        ["kind", "query"],
        ["path", "caseSensitive", "extensions"],
      );
      safeText(input.query, "search query", 1_000);
      if (input.path !== undefined) safePathText(input.path, "search path");
      if (
        input.caseSensitive !== undefined &&
        typeof input.caseSensitive !== "boolean"
      ) throw new Error("Coding search caseSensitive tidak sah.");
      if (
        input.extensions !== undefined &&
        (!Array.isArray(input.extensions) || input.extensions.length > 32 ||
          input.extensions.some((item) =>
            typeof item !== "string" || !/^\.[A-Za-z0-9]+$/u.test(item)
          ))
      ) throw new Error("Coding search extensions tidak sah.");
      return structuredClone(input);
    case "symbols":
      optionalKeys(input, ["kind"], ["query"]);
      if (input.query !== undefined) safeText(input.query, "symbol query", 512);
      return structuredClone(input);
    case "references":
      exactKeys(input, ["kind", "symbol"]);
      safeText(input.symbol, "reference symbol", 512);
      return structuredClone(input);
    case "diff":
    case "task_review":
    case "finalize":
      exactKeys(input, ["kind"]);
      return structuredClone(input);
    case "apply_patch":
      exactKeys(input, ["kind", "operations"]);
      if (!Array.isArray(input.operations) || input.operations.length < 1) {
        throw new Error("Coding patch operations tidak sah.");
      }
      return structuredClone(input);
    case "sandbox.exec":
      exactKeys(input, ["kind", "request"]);
      return {
        kind: "sandbox.exec",
        request: validateSandboxRequest(input.request),
      };
    case "validator":
      exactKeys(input, ["kind", "validator"]);
      if (!isValidator(input.validator)) {
        throw new Error("Coding validator kind tidak sah.");
      }
      return structuredClone(input);
    case "yield":
      exactKeys(input, ["kind", "reasonCode", "question"]);
      if (!/^[a-z][a-z0-9_.-]{0,108}$/u.test(input.reasonCode)) {
        throw new Error("Coding yield reasonCode tidak sah.");
      }
      safeText(input.question, "coding yield question", 2_000);
      return structuredClone(input);
    default:
      throw new Error("Coding worker action tidak dikenal.");
  }
}

function validateAdvisoryDrafts(input: readonly CodingAdvisoryDraft[]): CodingAdvisoryDraft[] {
  if (!Array.isArray(input) || input.length !== 2) {
    throw new Error("Coding advisory wajib memuat dua handoff.");
  }
  const result = input.map((draft) => {
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
      throw new Error("Coding advisory bukan object.");
    }
    exactKeys(draft, ["role", "status", "summary"]);
    if (
      (draft.role !== "challenger" && draft.role !== "verifier") ||
      !["completed", "partial", "plan_conflict", "uncertain", "failed"]
        .includes(draft.status)
    ) throw new Error("Role atau status coding advisory tidak sah.");
    return {
      role: draft.role,
      status: draft.status,
      summary: safeText(draft.summary, "coding advisory summary", 8_000),
    };
  });
  if (new Set(result.map((draft) => draft.role)).size !== 2) {
    throw new Error("Role coding advisory harus challenger dan verifier.");
  }
  return result;
}

function runView(run: CodingRun): CodingCoordinatorRunView {
  return Object.freeze({
    runId: run.runId,
    projectId: run.binding.projectId,
    status: run.status,
    phase: run.phase,
    instructionRevision: run.instructionRevision,
    appliedInstructionRevision: run.appliedInstructionRevision,
    stateRevision: run.stateRevision,
    taskBrief: structuredClone(run.taskBrief),
    constraints: run.constraints.map((constraint) => ({
      kind: constraint.kind,
      content: constraint.content,
      instructionRevision: constraint.instructionRevision,
    })),
    repositoryMap: structuredClone(run.repositoryMap),
    plan: structuredClone(run.plan),
    diff: structuredClone(run.diff),
    validators: run.validatorReceipts.map(receiptSummary),
    taskReviews: (run.taskReviewReceipts ?? []).map(taskReviewSummary),
    advisories: (run.advisoryReceipts ?? [])
      .filter((receipt) => receipt.instructionRevision === run.instructionRevision)
      .map((receipt) => ({
        advisoryId: receipt.advisoryId,
        role: receipt.role,
        status: receipt.status,
        instructionRevision: receipt.instructionRevision,
        summary: receipt.summary,
        summaryDigest: receipt.summaryDigest,
        createdAt: receipt.createdAt,
      })),
    counters: structuredClone(run.counters),
    limits: structuredClone(run.limits),
  });
}

function receiptSummary(
  receipt: CodingRun["validatorReceipts"][number],
): CodingCoordinatorRunView["validators"][number] {
  return {
    receiptId: receipt.receiptId,
    kind: receipt.kind,
    status: receipt.status,
    instructionRevision: receipt.instructionRevision,
    completedAt: receipt.completedAt,
  };
}

function repeatedValidatorFailures(
  run: CodingRun,
  receipt: CodingRun["validatorReceipts"][number],
): number {
  return run.validatorReceipts.filter((candidate) =>
    candidate.kind === receipt.kind &&
    candidate.status === "failed" &&
    candidate.instructionRevision === receipt.instructionRevision
  ).length;
}

function validateEscalationResult(
  input: CodingValidatorEscalationResult,
): CodingValidatorEscalationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Hasil eskalasi validator tidak sah.");
  }
  const allowed = input.status === "accepted"
    ? ["status", "code", "recoveryHint"]
    : ["status", "code"];
  exactKeys(input, allowed);
  if (
    input.status !== "accepted" && input.status !== "not_escalated" &&
    input.status !== "already_used" && input.status !== "failed"
  ) throw new Error("Status eskalasi validator tidak sah.");
  if (!/^[a-z][a-z0-9_.-]{0,108}$/u.test(input.code)) {
    throw new Error("Kode eskalasi validator tidak sah.");
  }
  if (
    input.status === "accepted" &&
    (typeof input.recoveryHint !== "string" ||
      !input.recoveryHint.trim() || input.recoveryHint.length > 8_192 ||
      containsSecretLikeValue(input.recoveryHint))
  ) throw new Error("Recovery hint eskalasi validator tidak sah.");
  if (input.status !== "accepted" && input.recoveryHint !== undefined) {
    throw new Error("Recovery hint hanya sah pada eskalasi accepted.");
  }
  return structuredClone(input);
}

function taskReviewSummary(
  receipt: NonNullable<CodingRun["taskReviewReceipts"]>[number],
): CodingCoordinatorRunView["taskReviews"][number] {
  return {
    receiptId: receipt.receiptId,
    status: receipt.status,
    instructionRevision: receipt.instructionRevision,
    completedAt: receipt.completedAt,
  };
}

function observation(
  kind: string,
  payload: unknown,
  maximum: number,
): CodingWorkerObservation {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("Coding observation tidak serializable.");
  if (containsSecretLikeValue(serialized)) {
    throw new Error("Coding observation menyerupai credential dan diblokir.");
  }
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
  if (serialized.length <= maximum) {
    return {
      kind,
      payload: structuredClone(payload),
      digest,
      compacted: false,
      originalCharacters: serialized.length,
    };
  }
  return {
    kind,
    payload: {
      truncated: true,
      digest,
      originalCharacters: serialized.length,
      instruction: "Persempit path/query/line range lalu ulangi tool read-only.",
    },
    digest,
    compacted: true,
    originalCharacters: serialized.length,
  };
}

function terminal(run: CodingRun): boolean {
  return run.status === "completed" || run.status === "failed" ||
    run.status === "cancelled" || run.status === "stale" ||
    run.status === "partial";
}

function isValidator(value: unknown): value is CodingValidatorKind {
  return value === "test" || value === "lint" || value === "typecheck" ||
    value === "build";
}

function validateSandboxRequest(input: SandboxExecRequest): SandboxExecRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Sandbox request coding worker bukan object.");
  }
  exactKeys(input, ["argv", "cwd", "purpose", "timeoutMs"]);
  if (!Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 128) {
    throw new Error("Sandbox argv coding worker tidak sah.");
  }
  const argv = input.argv.map((part) => safeText(part, "sandbox argv", 4_096));
  const cwd = input.cwd === "." ? "." : safePathText(input.cwd, "sandbox cwd");
  if (
    input.purpose !== "inspect" &&
    input.purpose !== "test" &&
    input.purpose !== "lint" &&
    input.purpose !== "typecheck" &&
    input.purpose !== "build"
  ) throw new Error("Sandbox purpose coding worker tidak sah.");
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 5 * 60_000
  ) throw new Error("Sandbox timeout coding worker tidak sah.");
  return {
    argv: argv as [string, ...string[]],
    cwd,
    purpose: input.purpose,
    timeoutMs: input.timeoutMs,
  };
}

function exactKeys(value: object, expected: readonly string[]): void {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) throw new Error("Coding worker action memuat field asing atau hilang.");
}

function optionalKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) throw new Error("Coding worker action memuat field asing atau hilang.");
}

function safeText(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    /\p{Cc}/u.test(value) ||
    containsSecretLikeValue(value)
  ) throw new Error(`${field} coding worker tidak sah atau credential-like.`);
  return value;
}

function safePathText(value: unknown, field: string): string {
  const path = safeText(value, field, 1_024);
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path) || path.includes("..")) {
    throw new Error(`${field} coding worker keluar dari workspace.`);
  }
  return path;
}

function optionalPositive(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || (value as number) < 1)
  ) throw new Error(`${field} coding worker tidak sah.`);
}

function safeOpaque(value: unknown, field: string, maximum: number): string {
  return safeText(value, field, maximum);
}

function boundedInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} CodingRunCoordinator tidak sah.`);
  }
  return value;
}

function abortError(): Error {
  const error = new Error("CodingRunCoordinator dibatalkan.");
  error.name = "AbortError";
  return error;
}
