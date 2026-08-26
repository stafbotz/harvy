import { createHash, randomUUID } from "node:crypto";
import type {
  CodingChangeSet,
  CodingAdvisoryReceipt,
  CodingConstraintKind,
  CodingDiffSummary,
  CodingEvidenceBinding,
  CodingEvidenceSource,
  CodingEvidenceStore,
  CodingPlanStep,
  CodingRepositoryMapReceipt,
  CodingRun,
  CodingRunAdmission,
  CodingRunStartOptions,
  CodingRunPlan,
  CodingRunEvent,
  CodingRunLimits,
  CodingRunRepository,
  CodingTaskBrief,
  CodingTaskReviewReceipt,
  CodingValidationCommand,
  CodingValidatorKind,
  CodingValidatorReceipt,
  PendingCodingCommit,
} from "../domain/coding-run.js";
import type {
  ProjectWorkspace,
  ProjectWorkspaceRevision,
} from "../domain/project-workspace.js";
import type {
  SandboxArtifactReference,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxRunner,
} from "../domain/sandbox.js";
import type { WorkspacePermission } from "../domain/workspace.js";
import type { ProjectDeletionReference } from "../domain/project-deletion.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import {
  RepositoryTools,
  WorkingCopyQuarantinedError,
  bindReadOnlyRepositoryTools,
  createSnapshotReadOnlyRepositoryTools,
  diffTrees,
  type ReadOnlyRepositoryTools,
  type RepositoryToolLimits,
  type StructuredPatchOperation,
} from "../coding/repository-tools.js";
import {
  assertRequiredValidators,
  codingDiffDigest,
  containsSecretLikeValue,
  taskContractDigest,
  taskReviewPolicyDigest,
  taskReviewRequirements,
  validateCodingDiff,
  validatorCommand,
  validatorCommandDigest,
  type CodingValidatorPolicy,
  type CodingTaskReviewAssessment,
  type CodingTaskReviewRequirement,
} from "../coding/coding-validators.js";
import type {
  ProjectSnapshotHandle,
  ProjectWorkingCopy,
} from "./project-workspace-service.js";
import { ProjectWorkspaceService } from "./project-workspace-service.js";
import { canonicalProjectPath } from "./project-files.js";
import {
  TransportDeadlineError,
  callTransportWithDeadline,
} from "./transport-deadline.js";

export const DEFAULT_CODING_RUN_LIMITS: Readonly<CodingRunLimits> =
  Object.freeze({
    maxPatches: 64,
    maxSandboxCalls: 32,
    maxChangedFiles: 256,
    maxChangedBytes: 32 * 1024 * 1024,
    maxActiveMs: 2 * 60 * 60 * 1000,
    maxCoordinatorDecisions: 512,
  });

interface CodingRuntime {
  scope: WorkspaceAgentScope;
  base: ProjectSnapshotHandle;
  working: ProjectWorkingCopy;
  tools: RepositoryTools;
}

interface InFlightOperationEntry {
  abort: AbortController;
  done: Promise<void>;
}

interface RegisteredInFlightOperation {
  signal: AbortSignal;
  finish(): void;
}

interface PreparedSandboxExecution {
  run: CodingRun;
  snapshot: ProjectSnapshotHandle;
  request: SandboxExecRequest;
}

interface ExecutedSandboxResult {
  result: SandboxExecResult;
  durableEvidenceIds: string[];
}

export interface CodingRunAdmissionFence {
  version: 1;
  source: "group";
  cause: "group_disabled" | "group_authority_changed";
  runId: string;
  ownerWorkspaceKey: string;
  projectId: string;
  effectId: string;
  authorityRef: string;
}

export interface CodingRunAdmissionFenceResult {
  run: CodingRun;
  /** A local workspace commit may be ambiguous and must be reconciled first. */
  pendingCommit: boolean;
}

class SandboxCleanupError extends Error {
  override readonly name = "SandboxCleanupError";

  constructor(
    readonly executed: ExecutedSandboxResult,
    error: unknown,
  ) {
    super(error instanceof Error ? error.message : "Sandbox cleanup gagal.", {
      cause: error,
    });
  }
}

class SandboxExecutionPreflightError extends Error {
  override readonly name = "SandboxExecutionPreflightError";

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : "Sandbox preflight gagal.", {
      cause: error,
    });
  }
}

class SandboxEvidenceBoundaryError extends Error {
  override readonly name = "SandboxEvidenceBoundaryError";

  constructor(error: unknown) {
    super(
      error instanceof Error ? error.message : "Evidence sandbox tidak sah.",
      { cause: error },
    );
  }
}

const WRITER_LEASE_MS = 15 * 60 * 1000;
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 512;

/**
 * Durable deterministic coordinator for the coding work graph. Model planning
 * can call its typed methods, but paths, writer authority, freshness, sandbox
 * binding, validators and commit decisions remain code-owned.
 */
export class CodingRunEngine {
  private readonly writerId: string;
  private readonly runtimes = new Map<string, CodingRuntime>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly inFlightOperations = new Map<
    string,
    Set<InFlightOperationEntry>
  >();
  private readonly limits: CodingRunLimits;
  private readonly evidenceStore: CodingEvidenceStore | undefined;
  private readonly deletionQuiescenceMs: number;

  constructor(
    private readonly repository: CodingRunRepository,
    private readonly projects: ProjectWorkspaceService,
    private readonly sandbox: SandboxRunner,
    private readonly validatorPolicy: CodingValidatorPolicy,
    options: {
      limits?: Partial<CodingRunLimits>;
      repositoryToolLimits?: Partial<RepositoryToolLimits>;
      evidenceStore?: CodingEvidenceStore;
      deletionQuiescenceMs?: number;
    } = {},
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
  ) {
    this.writerId = opaqueId("writer", this.makeId());
    this.limits = validateRunLimits({
      ...DEFAULT_CODING_RUN_LIMITS,
      ...options.limits,
    });
    this.repositoryToolLimits = options.repositoryToolLimits ?? {};
    this.evidenceStore = options.evidenceStore;
    const deletionQuiescenceMs = options.deletionQuiescenceMs ?? 30_000;
    if (
      !Number.isSafeInteger(deletionQuiescenceMs) ||
      deletionQuiescenceMs < 1 ||
      deletionQuiescenceMs > 5 * 60_000
    ) {
      throw new Error("Timeout quiescence project deletion tidak sah.");
    }
    this.deletionQuiescenceMs = deletionQuiescenceMs;
  }

  private readonly repositoryToolLimits: Partial<RepositoryToolLimits>;

  async start(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedWorkspaceRevision: number,
    briefInput: CodingTaskBrief,
    options: CodingRunStartOptions = {},
  ): Promise<CodingRun> {
    const brief = validateTaskBrief(briefInput);
    const admission = validateCodingRunAdmission(options.admission);
    return this.projects.withFreshProjectPermissions(
      scope,
      projectId,
      expectedWorkspaceRevision,
      ["run.create", "code.write"],
      async (project) => {
    if (admission) {
      const replay = (await this.repository.listByProject(project.id)).find(
        (candidate) => candidate.admission?.effectId === admission.effectId,
      );
      if (replay) {
        if (
          JSON.stringify(replay.admission) !== JSON.stringify(admission) ||
          replay.binding.ownerWorkspaceKey !== scope.workspaceKey ||
          replay.binding.workspaceRevision !== expectedWorkspaceRevision ||
          JSON.stringify(replay.taskBrief) !== JSON.stringify(brief)
        ) {
          throw new Error("Admission effect CodingRun bertabrakan dengan command lain.");
        }
        return replay;
      }
    }
    const active = await this.repository.loadActiveByProject(project.id);
    if (active) {
      if (active.pendingCommit) {
        throw new Error("Project mempunyai CodingRun pada commit barrier; reconciliation wajib.");
      }
      if (
        active.binding.workspaceRevision === project.revision &&
        active.binding.baseSnapshot === project.baseSnapshot
      ) {
        throw new Error("Project ini sudah mempunyai CodingRun writer aktif.");
      }
      await this.markRunStale(scope, active, "project_workspace_stale_before_start");
    }
    const base = await this.projects.getSnapshotHandle(
      scope,
      project.id,
      project.revision,
    );
    const working = await this.projects.createWorkingCopy(
      scope,
      project.id,
      project.revision,
    );
    const runId = opaqueId("coding-run", this.makeId());
    const at = this.now();
    const atIso = at.toISOString();
    const event = makeEvent(
      this.makeId,
      "run.started",
      0,
      "coding_run_started",
      atIso,
    );
    const created = await this.repository.create({
      version: 2,
      runId,
      binding: {
        projectId: project.id,
        ownerWorkspaceKey: project.ownerWorkspaceKey,
        workspaceRevision: project.revision,
        baseSnapshot: project.baseSnapshot,
      },
      taskBrief: brief,
      ...(admission ? { admission } : {}),
      status: "running",
      phase: "mapping",
      instructionRevision: 0,
      appliedInstructionRevision: 0,
      workingCopyId: working.workingCopyId,
      writer: writerLease(this.writerId, at),
      constraints: [],
      changeSets: [],
      events: [event],
      validatorReceipts: [],
      taskReviewReceipts: [],
      repositoryMap: null,
      advisoryReceipts: [],
      plan: null,
      diff: null,
      limits: structuredClone(this.limits),
      counters: {
        patches: 0,
        sandboxCalls: 0,
        activeElapsedMs: 0,
        coordinatorDecisions: 0,
      },
      pendingQuestion: null,
      pendingCommit: null,
      commitReceipts: [],
      result: null,
      lastError: null,
      createdAt: atIso,
      startedAt: atIso,
      updatedAt: atIso,
      completedAt: null,
      expiresAt: new Date(at.getTime() + RUN_RETENTION_MS).toISOString(),
    });
    if (created.status !== "saved") {
      await this.projects.disposeWorkingCopy(scope, working);
      throw new Error(
        created.status === "active-run-exists"
          ? "Project ini sudah mempunyai CodingRun writer aktif."
          : "CodingRun gagal dibuat karena konflik.",
      );
    }
    const runtime = this.buildRuntime(scope, created.run, base, working);
    this.runtimes.set(runId, runtime);
    return created.run;
      },
    );
  }

  async get(scope: WorkspaceAgentScope, runId: string): Promise<CodingRun | null> {
    const run = await this.repository.load(runId);
    if (!run || run.binding.ownerWorkspaceKey !== scope.workspaceKey) return null;
    const project = await this.projects.get(scope, run.binding.projectId);
    return project ? run : null;
  }

  async writerTools(
    scope: WorkspaceAgentScope,
    runId: string,
  ): Promise<ReadOnlyRepositoryTools> {
    return this.projects.withWorkspacePermission(scope, "code.write", async () => {
      let run = await this.requireMutableRun(scope, runId);
      run = await this.claimOrRenewWriter(run);
      this.assertActiveBudget(run, "work");
      return (await this.runtimeFor(scope, run)).tools.readOnlyWorker();
    });
  }

  /**
   * Durable CAS admission for one externally scheduled coordinator invocation.
   * Renewing the writer lease advances stateRevision, so a stale command cannot
   * slip through a read/read window before the first coordinator action.
   */
  async reserveCoordinatorInvocation(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedStateRevision: number,
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId, "code.write", true);
      assertStateRevision(run, expectedStateRevision);
      this.assertActiveBudget(run, "work");
      run = await this.claimOrRenewWriter(run);
      return run;
    });
  }

  async reserveCoordinatorDecision(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedStateRevision: number,
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId);
      if (run.stateRevision !== expectedStateRevision) {
        throw new Error("CodingRun berubah sebelum decision budget dicadangkan.");
      }
      if (
        run.counters.coordinatorDecisions >=
          run.limits.maxCoordinatorDecisions
      ) {
        throw new Error("CodingRun coordinator decision budget habis.");
      }
      run = await this.claimOrRenewWriter(run);
      this.assertActiveBudget(run, "work");
      return this.saveRun(run, {
        counters: {
          ...run.counters,
          coordinatorDecisions: run.counters.coordinatorDecisions + 1,
        },
      });
    });
  }

  /**
   * Launches a provider decision while the exact project revision is still
   * locked and records it before the lock is released. A deletion request can
   * therefore either win before launch or observe, abort and fence the call.
   */
  async runCoordinatorDecision<T>(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedStateRevision: number,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 5 * 60_000
    ) {
      throw new Error("Timeout CodingRun coordinator tidak sah.");
    }
    if (signal?.aborted) throw abortError();
    const initial = await this.repository.load(runId);
    if (!initial || initial.binding.ownerWorkspaceKey !== scope.workspaceKey) {
      throw new Error("CodingRun tidak tersedia pada scope ini.");
    }
    const launch: {
      tracked?: RegisteredInFlightOperation;
      result?: Promise<T>;
    } = {};
    await this.projects.withFreshProjectPermissions(
      scope,
      initial.binding.projectId,
      initial.binding.workspaceRevision,
      ["code.write"],
      async () => this.exclusive(runId, async () => {
        if (signal?.aborted) throw abortError();
        const current = await this.requireMutableRun(scope, runId);
        assertStateRevision(current, expectedStateRevision);
        this.assertActiveBudget(current, "work");
        launch.tracked = this.registerInFlight(runId, signal);
        const timeoutAbort = new AbortController();
        const effectiveSignal = AbortSignal.any([
          launch.tracked.signal,
          timeoutAbort.signal,
        ]);
        if (effectiveSignal.aborted) {
          launch.tracked.finish();
          throw abortError();
        }
        const deadline = performance.now() + timeoutMs;
        let timedOut = false;
        try {
          // Invoke synchronously while the project lock is held. Only awaiting
          // the provider promise happens after the lock has been released.
          const provider = Promise.resolve(operation(effectiveSignal));
          provider.catch(() => undefined);
          provider.finally(() => launch.tracked?.finish()).catch(() => undefined);
          const timer = setTimeout(() => {
            timedOut = true;
            timeoutAbort.abort(new TransportDeadlineError("Coding worker decision"));
          }, timeoutMs);
          timer.unref?.();
          const aborted = new Promise<never>((_resolve, reject) => {
            const rejectAbort = () => reject(
              timedOut
                ? new TransportDeadlineError("Coding worker decision")
                : abortError(),
            );
            if (effectiveSignal.aborted) rejectAbort();
            else effectiveSignal.addEventListener("abort", rejectAbort, { once: true });
          });
          launch.result = Promise.race([
            provider,
            aborted,
          ]).then((result) => {
            if (performance.now() >= deadline) {
              timedOut = true;
              timeoutAbort.abort(
                new TransportDeadlineError("Coding worker decision"),
              );
              throw new TransportDeadlineError("Coding worker decision");
            }
            if (effectiveSignal.aborted) {
              throw timedOut
                ? new TransportDeadlineError("Coding worker decision")
                : abortError();
            }
            return result;
          }).finally(() => clearTimeout(timer));
        } catch (error) {
          launch.tracked.finish();
          launch.result = Promise.reject(error);
        }
        launch.result.catch(() => undefined);
      }),
    );
    const tracked = launch.tracked;
    const launched = launch.result;
    if (!tracked || !launched) {
      throw new Error("Coding worker decision tidak berhasil diluncurkan.");
    }
    return launched;
  }

  /**
   * App-owned quiescence fence. It exposes no run data and only resolves once
   * every provider/sandbox operation already registered for this run settles.
   */
  async waitForRunQuiescence(runIdInput: string): Promise<void> {
    const runId = boundedText(runIdInput, 512, "runId");
    while (true) {
      const operations = [...(this.inFlightOperations.get(runId) ?? [])];
      if (operations.length === 0) return;
      await Promise.all(operations.map((entry) => entry.done));
    }
  }

  async pauseCoordinator(
    scope: WorkspaceAgentScope,
    runId: string,
    reasonCodeInput: string,
    questionInput: string,
  ): Promise<CodingRun> {
    const reasonCode = boundedText(reasonCodeInput, 109, "pause reasonCode");
    const prompt = boundedTaskText(questionInput, 2_000, "pause question");
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId, "code.write", true);
      if (run.status === "waiting_input") {
        if (
          run.pendingQuestion?.reasonCode === reasonCode &&
          run.pendingQuestion.prompt === prompt
        ) return run;
        throw new Error("CodingRun sudah menunggu pertanyaan lain.");
      }
      if (run.status !== "running") {
        throw new Error("CodingRun tidak dapat dipause pada status ini.");
      }
      run = await this.claimOrRenewWriter(run);
      const at = this.now().toISOString();
      return this.saveRun(run, {
        status: "waiting_input",
        phase: "waiting_input",
        pendingQuestion: {
          questionId: opaqueId("coding-question", this.makeId()),
          reasonCode,
          prompt,
          instructionRevision: run.instructionRevision,
          requestedAt: at,
        },
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "run.paused",
            run.instructionRevision,
            `coordinator_paused_${reasonCode}`,
            at,
          ),
        ),
        updatedAt: at,
      });
    });
  }

  async resumeCoordinator(
    scope: WorkspaceAgentScope,
    runId: string,
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      const run = await this.requireMutableRun(
        scope,
        runId,
        "code.write",
        true,
      );
      if (run.status !== "waiting_input") return run;
      const now = this.now();
      const at = now.toISOString();
      return this.saveRun(run, {
        status: "running",
        phase: resumePhase(run),
        pendingQuestion: null,
        writer: writerLease(this.writerId, now),
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "run.resumed",
            run.instructionRevision,
            "coordinator_resumed",
            at,
          ),
        ),
        // Reset the active interval. Idle time while waiting is never charged.
        updatedAt: at,
      });
    });
  }

  async readOnlyWorkerTools(
    scope: WorkspaceAgentScope,
    runId: string,
  ): Promise<ReadOnlyRepositoryTools> {
    return this.projects.withWorkspacePermission(scope, "code.read", async () => {
      const run = await this.requireMutableRun(scope, runId, "code.read");
      return (await this.runtimeFor(scope, run, false)).tools.readOnlyWorker();
    });
  }

  async markMapped(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId);
      run = await this.claimOrRenewWriter(run);
      assertInstruction(run, expectedInstructionRevision);
      this.assertActiveBudget(run, "work");
      const runtime = await this.runtimeFor(scope, run);
      const [treeResult, symbolResult, diff] = await Promise.all([
        runtime.tools.tree(expectedInstructionRevision, { maxDepth: 32 }),
        runtime.tools.symbols(expectedInstructionRevision),
        runtime.tools.diff(expectedInstructionRevision),
      ]);
      if (treeResult.truncated || symbolResult.truncated) {
        throw new Error(
          "Repository map mencapai batas traversal; persempit scope atau naikkan batas code-owned.",
        );
      }
      const tree = treeResult.items;
      const symbols = symbolResult.items;
      const completedAt = this.now().toISOString();
      const treeDigest = digestJson(tree);
      const symbolDigest = digestJson(symbols);
      const mapBase = {
        instructionRevision: expectedInstructionRevision,
        workingSnapshot: diff.workingSnapshot,
        treeDigest,
        symbolDigest,
        entryCount: tree.length,
        symbolCount: symbols.length,
        treeComplete: true as const,
        symbolsComplete: true as const,
      };
      const repositoryMap: CodingRepositoryMapReceipt = {
        ...mapBase,
        mapDigest: digestJson(mapBase),
        completedAt,
      };
      return this.saveRun(run, {
        phase: "planning",
        repositoryMap,
        plan: null,
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "mapping.completed",
            run.instructionRevision,
            "repository_map_ready",
            this.now().toISOString(),
          ),
        ),
      });
    });
  }

  async recordAdvisories(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    drafts: ReadonlyArray<{
      role: CodingAdvisoryReceipt["role"];
      status: CodingAdvisoryReceipt["status"];
      summary: string;
    }>,
    expectedStateRevision?: number,
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId);
      assertStateRevision(run, expectedStateRevision);
      run = await this.claimOrRenewWriter(run);
      assertInstruction(run, expectedInstructionRevision);
      this.assertActiveBudget(run, "work");
      const repositoryMap = currentRepositoryMap(run);
      const current = (run.advisoryReceipts ?? []).filter((receipt) =>
        receipt.instructionRevision === expectedInstructionRevision
      );
      if (current.length > 0) {
        if (
          current.length === drafts.length && drafts.every((draft) =>
            current.some((receipt) =>
              receipt.role === draft.role && receipt.status === draft.status &&
              receipt.summary === draft.summary
            )
          )
        ) return run;
        throw new Error("Advisory CodingRun untuk revision ini sudah tercatat berbeda.");
      }
      if (
        drafts.length !== 2 || new Set(drafts.map((draft) => draft.role)).size !== 2 ||
        !drafts.some((draft) => draft.role === "challenger") ||
        !drafts.some((draft) => draft.role === "verifier")
      ) throw new Error("CodingRun memerlukan tepat dua advisory read-only berbeda.");
      const scopeDigest = digestJson({
        runId: run.runId,
        projectId: run.binding.projectId,
        instructionRevision: expectedInstructionRevision,
        repositoryMapDigest: repositoryMap.mapDigest,
        taskContractDigest: taskContractDigest(run),
      });
      const createdAt = this.now().toISOString();
      const receipts = drafts.map((draft): CodingAdvisoryReceipt => {
        if (
          (draft.role !== "challenger" && draft.role !== "verifier") ||
          !["completed", "partial", "plan_conflict", "uncertain", "failed"]
            .includes(draft.status)
        ) throw new Error("Role atau status advisory CodingRun tidak sah.");
        const summary = boundedTaskText(
          draft.summary,
          3_600,
          "summary advisory CodingRun",
        );
        return {
          advisoryId: opaqueId("advisory", this.makeId()),
          role: draft.role,
          status: draft.status,
          instructionRevision: expectedInstructionRevision,
          workingSnapshot: repositoryMap.workingSnapshot,
          scopeDigest,
          summary,
          summaryDigest: createHash("sha256").update(summary, "utf8").digest("hex"),
          createdAt,
        };
      });
      return this.saveRun(run, {
        advisoryReceipts: [...(run.advisoryReceipts ?? []), ...receipts],
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "advisory.completed",
            run.instructionRevision,
            "read_only_advisory_recorded",
            createdAt,
          ),
        ),
      });
    });
  }

  async recordPlan(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    input: {
      steps: Array<Pick<CodingPlanStep, "stage" | "description" | "paths">>;
    },
    expectedStateRevision?: number,
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId);
      assertStateRevision(run, expectedStateRevision);
      run = await this.claimOrRenewWriter(run);
      assertInstruction(run, expectedInstructionRevision);
      this.assertActiveBudget(run, "work");
      const repositoryMap = currentRepositoryMap(run);
      const runtime = await this.runtimeFor(scope, run);
      const diff = await runtime.tools.diff(expectedInstructionRevision);
      if (repositoryMap.workingSnapshot !== diff.workingSnapshot) {
        throw new Error("Repository map CodingRun sudah basi terhadap working snapshot.");
      }
      const steps = validatePlanSteps(input.steps);
      const base = {
        revision: (run.plan?.revision ?? 0) + 1,
        instructionRevision: expectedInstructionRevision,
        repositoryMapDigest: repositoryMap.mapDigest,
        taskContractDigest: taskContractDigest(run),
        steps,
      };
      const plan = {
        ...base,
        planDigest: digestJson(base),
        createdAt: this.now().toISOString(),
      };
      return this.saveRun(run, {
        phase: "editing",
        appliedInstructionRevision: expectedInstructionRevision,
        plan,
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "editing.started",
            run.instructionRevision,
            "coding_plan_recorded",
            plan.createdAt,
          ),
        ),
      });
    });
  }

  async revise(
    scope: WorkspaceAgentScope,
    runId: string,
    input: {
      sourceMessageId: string;
      kind: CodingConstraintKind;
      content: string;
    },
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(
        scope,
        runId,
        "code.write",
        true,
      );
      const sourceMessageId = boundedTaskText(
        input.sourceMessageId,
        512,
        "sourceMessageId",
      );
      const content = boundedTaskText(input.content, 8_192, "coding constraint");
      const existing = run.constraints.find(
        (constraint) => constraint.sourceMessageId === sourceMessageId,
      );
      if (existing) {
        if (existing.kind === input.kind && existing.content === content) return run;
        throw new Error("sourceMessageId CodingRun dipakai untuk revision berbeda.");
      }
      run = await this.claimOrRenewWriter(run);
      const instructionRevision = run.instructionRevision + 1;
      const at = this.now().toISOString();
      const stages = changeSetStages(input.kind);
      const change: CodingChangeSet = {
        instructionRevision,
        sourceMessageId,
        kind: input.kind,
        affectedStages: stages,
        receivedAt: at,
      };
      return this.saveRun(run, {
        instructionRevision,
        status: "running",
        phase: "mapping",
        pendingQuestion: null,
        repositoryMap: null,
        plan: null,
        constraints: [
          ...run.constraints,
          {
            id: opaqueId("constraint", this.makeId()),
            sourceMessageId,
            kind: input.kind,
            content,
            instructionRevision,
            receivedAt: at,
          },
        ],
        changeSets: [...run.changeSets, change],
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "revision.received",
            instructionRevision,
            `revision_${input.kind}`,
            at,
          ),
        ),
      });
    });
  }

  async acknowledgeRevision(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId);
      run = await this.claimOrRenewWriter(run);
      assertInstruction(run, expectedInstructionRevision);
      currentPlan(run);
      return this.saveRun(run, {
        appliedInstructionRevision: expectedInstructionRevision,
        phase: "editing",
      });
    });
  }

  async applyPatch(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    operations: readonly StructuredPatchOperation[],
    expectedStateRevision?: number,
  ): Promise<{ run: CodingRun; diff: CodingDiffSummary }> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId);
      assertStateRevision(run, expectedStateRevision);
      run = await this.claimOrRenewWriter(run);
      assertInstruction(run, expectedInstructionRevision);
      currentPlan(run);
      this.assertActiveBudget(run, "patch");
      const runtime = await this.runtimeFor(scope, run);
      try {
        const applied = await runtime.tools.applyPatch(
          expectedInstructionRevision,
          operations,
          async (diff) => {
            await this.projects.assertWorkingCopyStorage(scope, runtime.working);
            const at = this.now().toISOString();
            return this.saveRun(run, {
              phase: "editing",
              appliedInstructionRevision: expectedInstructionRevision,
              diff,
              counters: {
                ...run.counters,
                patches: run.counters.patches + 1,
                activeElapsedMs: activeElapsed(run, this.now()),
              },
              events: appendEvent(
                run.events,
                makeEvent(
                  this.makeId,
                  "patch.applied",
                  expectedInstructionRevision,
                  "workspace_patch_applied",
                  at,
                ),
              ),
            });
          },
          async () => {
            const durable = await this.repository.load(run.runId);
            if (!durable) throw new Error("State CodingRun hilang setelah rollback patch.");
            const actual = await diffTrees(runtime.base, runtime.working);
            const expected = durable.diff?.workingSnapshot ?? durable.binding.baseSnapshot;
            if (actual.workingSnapshot !== expected) {
              throw new Error("Rollback patch tidak cocok dengan state durable CodingRun.");
            }
          },
        );
        return { run: applied.persisted, diff: applied.diff };
      } catch (error) {
        if (error instanceof WorkingCopyQuarantinedError) {
          await this.failQuarantinedWorkingCopy(scope, run, runtime, error);
        }
        throw error;
      }
    });
  }

  async executeSandbox(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    request: SandboxExecRequest,
    signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<SandboxExecResult> {
    const prepared = await this.prepareSandboxExecution(
      scope,
      runId,
      expectedInstructionRevision,
      request,
      expectedStateRevision,
    );
    const { result } = await this.executePrepared(scope, prepared, signal);
    await this.assertResultFresh(
      scope,
      runId,
      expectedInstructionRevision,
      prepared.snapshot.snapshotId,
    );
    return result;
  }

  async runValidator(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    kind: CodingValidatorKind,
    signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<{
    run: CodingRun;
    receipt: CodingValidatorReceipt;
    diagnostic?: {
      status: SandboxExecResult["status"];
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
      artifacts: SandboxExecResult["artifacts"];
    };
  }> {
    const initial = await this.requireMutableRun(scope, runId);
    const commands = await validationCommands(this.validatorPolicy, initial);
    const command = validatorCommand(commands, kind);
    const prepared = await this.prepareSandboxExecution(
      scope,
      runId,
      expectedInstructionRevision,
      {
        argv: command.argv,
        cwd: command.cwd,
        purpose: command.purpose,
        timeoutMs: command.timeoutMs,
      },
      expectedStateRevision,
    );
    let result: SandboxExecResult;
    let durableEvidenceIds: string[] = [];
    try {
      const executed = await this.executePrepared(
        scope,
        prepared,
        signal,
        true,
      );
      result = executed.result;
      durableEvidenceIds = executed.durableEvidenceIds;
    } catch (error) {
      if (
        error instanceof SandboxExecutionPreflightError ||
        error instanceof SandboxEvidenceBoundaryError
      ) throw error;
      return this.recordInfrastructureValidatorFailure(
        scope,
        prepared,
        kind,
        command,
        error,
      );
    }
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId);
      run = await this.claimOrRenewWriter(run);
      this.assertActiveBudget(run, "work");
      const runtime = await this.runtimeFor(scope, run);
      const currentDiff = await runtime.tools.diff(run.instructionRevision);
      const stale =
        run.instructionRevision !== expectedInstructionRevision ||
        currentDiff.workingSnapshot !== prepared.snapshot.snapshotId;
      const status: CodingValidatorReceipt["status"] = stale
        ? "stale"
        : result.status === "exited" && result.exitCode === 0
          ? "passed"
          : result.status === "exited"
            ? "failed"
            : "infrastructure_error";
      const receipt: CodingValidatorReceipt = {
        receiptId: opaqueId("validator", this.makeId()),
        kind,
        status,
        instructionRevision: expectedInstructionRevision,
        workingSnapshot: prepared.snapshot.snapshotId,
        commandDigest: validatorCommandDigest(command),
        taskContractDigest: taskContractDigest(prepared.run),
        sandboxOperationId: safeSandboxEvidenceId(
          result.operationId,
          "sandbox operationId",
        ),
        sandboxRequestDigest: safeSandboxRequestDigest(result.requestDigest),
        sandboxExecutionId: safeSandboxEvidenceId(
          result.executionId,
          "sandbox executionId",
        ),
        exitCode: result.exitCode,
        evidenceArtifactIds: durableEvidenceIds,
        completedAt: result.completedAt,
      };
      const saved = await this.saveRun(run, {
        phase: stale ? "planning" : status === "passed" ? "reviewing" : "editing",
        validatorReceipts: [...run.validatorReceipts, receipt],
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "validator.completed",
            run.instructionRevision,
            `validator_${kind}_${status}`,
            this.now().toISOString(),
          ),
        ),
      });
      return {
        run: saved,
        receipt,
        diagnostic: {
          status: result.status,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          artifacts: structuredClone(result.artifacts),
        },
      };
    });
  }

  async runTaskReview(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<{ run: CodingRun; receipt: CodingTaskReviewReceipt }> {
    const prepared = await this.authorizedExclusive(
      scope,
      runId,
      ["code.write"],
      async () => {
      let run = await this.requireMutableRun(scope, runId);
      assertStateRevision(run, expectedStateRevision);
      run = await this.claimOrRenewWriter(run);
      assertInstruction(run, expectedInstructionRevision);
      this.assertActiveBudget(run, "work");
      const repositoryMap = currentRepositoryMap(run);
      const plan = currentPlan(run);
      if (run.appliedInstructionRevision !== run.instructionRevision) {
        throw new Error("Revision CodingRun terbaru belum diterapkan integrator.");
      }
      const runtime = await this.runtimeFor(scope, run);
      const diff = await runtime.tools.diff(run.instructionRevision);
      const commands = await validationCommands(this.validatorPolicy, run);
      assertRequiredValidators(run, commands, diff.workingSnapshot);
      const staged = await this.projects.stageWorkingSnapshot(scope, runtime.working);
      if (staged.snapshotId !== diff.workingSnapshot) {
        throw new Error("Snapshot review task tidak cocok dengan diff CodingRun.");
      }
      const requirements = taskReviewRequirements(run);
      const availableEvidenceRefs = taskReviewEvidenceRefs(run, diff);
      const policyDigest = taskReviewPolicyDigest(this.validatorPolicy);
      const contractDigest = taskContractDigest(run);
      const at = this.now().toISOString();
      run = await this.saveRun(run, {
        phase: "reviewing",
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "review.started",
            run.instructionRevision,
            "task_review_started",
            at,
          ),
        ),
      });
      return {
        run,
        diff,
        requirements,
        availableEvidenceRefs,
        repositoryMap,
        plan,
        policyDigest,
        contractDigest,
        base: runtime.base,
        staged,
      };
    });

    let assessment: CodingTaskReviewAssessment | null = null;
    let reviewFailed = false;
    try {
      if (signal?.aborted) throw abortError();
      assessment = await this.trackInFlight(
        runId,
        signal,
        async (effectiveSignal) => {
          if (effectiveSignal.aborted) throw abortError();
          await this.projects.withFreshProject(
            scope,
            prepared.run.binding.projectId,
            prepared.run.binding.workspaceRevision,
            "code.write",
            async () => undefined,
          );
          const launched = await this.projects.withFreshProject(
            scope,
            prepared.run.binding.projectId,
            prepared.run.binding.workspaceRevision,
            "code.write",
            async () => {
              const tools = createSnapshotReadOnlyRepositoryTools(
                prepared.base,
                prepared.staged,
                async (revision, effect) => {
                  if (
                    effect !== "read" ||
                    revision !== expectedInstructionRevision
                  ) {
                    throw new Error("Repository view task review tidak sah.");
                  }
                  if (effectiveSignal.aborted) throw abortError();
                  await this.projects.withFreshProject(
                    scope,
                    prepared.run.binding.projectId,
                    prepared.run.binding.workspaceRevision,
                    "code.read",
                    async () => undefined,
                  );
                },
                this.repositoryToolLimits,
              );
              return {
              result: this.validatorPolicy.reviewTask({
                projectId: prepared.run.binding.projectId,
                instructionRevision: expectedInstructionRevision,
                taskBrief: structuredClone(prepared.run.taskBrief),
                constraints: structuredClone(prepared.run.constraints),
                diff: structuredClone(prepared.diff),
                validators: structuredClone(prepared.run.validatorReceipts),
                requirements: structuredClone(prepared.requirements),
                availableEvidenceRefs: structuredClone(prepared.availableEvidenceRefs),
                repositoryMap: structuredClone(prepared.repositoryMap),
                plan: structuredClone(prepared.plan),
                workspace: bindReadOnlyRepositoryTools(
                  tools,
                  expectedInstructionRevision,
                ),
              }, effectiveSignal),
              };
            },
          );
          return launched.result;
        },
      );
    } catch {
      reviewFailed = true;
    }

    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId);
      run = await this.claimOrRenewWriter(run);
      this.assertActiveBudget(run, "work");
      const runtime = await this.runtimeFor(scope, run);
      const currentDiff = await runtime.tools.diff(run.instructionRevision);
      const stale =
        run.instructionRevision !== expectedInstructionRevision ||
        currentDiff.workingSnapshot !== prepared.diff.workingSnapshot ||
        taskContractDigest(run) !== prepared.contractDigest ||
        run.repositoryMap?.mapDigest !== prepared.repositoryMap.mapDigest ||
        run.plan?.planDigest !== prepared.plan.planDigest;
      let normalized: NormalizedTaskReview;
      if (reviewFailed || assessment === null) {
        normalized = failedTaskReview(prepared.requirements);
      } else {
        try {
          normalized = normalizeTaskReviewAssessment(
            assessment,
            prepared.requirements,
            new Set(prepared.availableEvidenceRefs),
          );
        } catch {
          reviewFailed = true;
          normalized = failedTaskReview(prepared.requirements);
        }
      }
      const status: CodingTaskReviewReceipt["status"] = stale
        ? "stale"
        : reviewFailed
          ? "infrastructure_error"
          : normalized.approved
            ? "approved"
            : "changes_requested";
      const receipt: CodingTaskReviewReceipt = {
        receiptId: opaqueId("task-review", this.makeId()),
        status,
        instructionRevision: expectedInstructionRevision,
        workingSnapshot: prepared.diff.workingSnapshot,
        diffDigest: codingDiffDigest(prepared.diff),
        taskContractDigest: prepared.contractDigest,
        policyDigest: prepared.policyDigest,
        repositoryMapDigest: prepared.repositoryMap.mapDigest,
        planDigest: prepared.plan.planDigest,
        requirementEvidence: normalized.requirementEvidence,
        publicApi: normalized.publicApi,
        unrelatedChanges: normalized.unrelatedChanges,
        completedAt: this.now().toISOString(),
      };
      const saved = await this.saveRun(run, {
        phase: stale ? run.phase : "reviewing",
        taskReviewReceipts: [...(run.taskReviewReceipts ?? []), receipt],
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "review.completed",
            run.instructionRevision,
            `task_review_${status}`,
            receipt.completedAt,
          ),
        ),
      });
      return { run: saved, receipt };
    });
  }

  async finalize(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    expectedStateRevision?: number,
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(scope, runId);
      assertStateRevision(run, expectedStateRevision);
      run = await this.claimOrRenewWriter(run);
      assertInstruction(run, expectedInstructionRevision);
      this.assertActiveBudget(run, "work");
      currentPlan(run);
      if (run.appliedInstructionRevision !== run.instructionRevision) {
        throw new Error("Revision CodingRun terbaru belum diterapkan integrator.");
      }
      const runtime = await this.runtimeFor(scope, run);
      const diff = await runtime.tools.diff(run.instructionRevision);
      const report = await validateCodingDiff(diff, runtime.working, {
        maxChangedFiles: run.limits.maxChangedFiles,
        maxChangedBytes: run.limits.maxChangedBytes,
      });
      if (!report.passed) {
        throw new Error(
          `Coding validators menolak diff: ${report.findings
            .map((finding) => finding.code)
            .join(", ")}.`,
        );
      }
      const commands = await validationCommands(this.validatorPolicy, run);
      assertRequiredValidators(run, commands, diff.workingSnapshot);
      const validatorEvidence = requiredValidatorEvidence(
        run,
        commands,
        diff.workingSnapshot,
      );
      await this.assertDurableValidatorEvidence(run, validatorEvidence);
      const taskReviewEvidence = requiredTaskReviewEvidence(
        run,
        diff,
        this.validatorPolicy,
      );
      const at = this.now().toISOString();
      const effectId = opaqueId("coding-commit", this.makeId());
      run = await this.saveRun(run, {
        status: "validating",
        phase: "finalizing",
        diff,
        pendingCommit: {
          effectId,
          instructionRevision: run.instructionRevision,
          sourceWorkspaceRevision: run.binding.workspaceRevision,
          workingSnapshot: diff.workingSnapshot,
          validatorEvidence,
          taskReviewEvidence,
          preparedAt: at,
        },
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "finalizing.started",
            run.instructionRevision,
            "coding_commit_prepared",
            at,
          ),
        ),
      });
      const project = await this.projects.commitWorkingCopy(scope, runtime.working, {
        effectId,
        expectedSnapshotId: diff.workingSnapshot,
      });
      const completedAt = this.now().toISOString();
      const current = await this.repository.load(runId);
      if (!current || current.stateRevision !== run.stateRevision ||
        current.pendingCommit?.effectId !== effectId) {
        throw new Error("CodingRun berubah setelah commit workspace; rekonsiliasi wajib.");
      }
      const pending = current.pendingCommit;
      if (!pending || pending.effectId !== effectId) {
        throw new Error("Commit barrier CodingRun hilang setelah effect workspace.");
      }
      const committedRevision = project.snapshotHistory.find(
        (entry) => entry.effectId === effectId,
      );
      if (!committedRevision) {
        throw new Error("Receipt effect ProjectWorkspace tidak ditemukan setelah commit.");
      }
      const passed = validatorsFromPending(current, pending);
      const taskReview = taskReviewFromPending(current, pending);
      const completed = await this.saveRun(current, {
        status: "completed",
        phase: "completed",
        pendingCommit: null,
        commitReceipts: [
          ...current.commitReceipts,
          {
            effectId,
            status: "committed",
            sourceWorkspaceRevision: current.binding.workspaceRevision,
            committedWorkspaceRevision: committedRevision.revision,
            snapshotId: committedRevision.snapshotId,
            committedAt: completedAt,
          },
        ],
        result: {
          instructionRevision: current.instructionRevision,
          projectRevision: committedRevision.revision,
          snapshotId: committedRevision.snapshotId,
          changedFiles: diff.files.length,
          validators: passed,
          taskReview,
          completedAt,
        },
        events: appendEvent(
          current.events,
          makeEvent(
            this.makeId,
            "run.completed",
            current.instructionRevision,
            "coding_run_completed",
            completedAt,
          ),
        ),
        completedAt,
        updatedAt: completedAt,
      });
      this.runtimes.delete(runId);
      await this.projects.pruneUnreferencedSnapshots(
        scope,
        project.id,
        project.revision,
      ).catch(() => undefined);
      return completed;
    });
  }

  async cancel(
    scope: WorkspaceAgentScope,
    runId: string,
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      let run = await this.requireMutableRun(
        scope,
        runId,
        "code.write",
        true,
      );
      run = await this.claimOrRenewWriter(run);
      if (run.pendingCommit) {
        throw new Error("CodingRun sedang melewati commit barrier dan tidak dapat dibatalkan diam-diam.");
      }
      const runtime = await this.runtimeFor(scope, run);
      const at = this.now().toISOString();
      const cancelled = await this.saveRun(run, {
        status: "cancelled",
        phase: "cancelled",
        pendingQuestion: null,
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "run.cancelled",
            run.instructionRevision,
            "coding_run_cancelled",
            at,
          ),
        ),
        completedAt: at,
        updatedAt: at,
      });
      await this.projects.disposeWorkingCopy(scope, runtime.working);
      this.runtimes.delete(runId);
      return cancelled;
    });
  }

  /**
   * Fail-closed cancellation for a durable group admission after the group
   * authority itself is no longer usable. It is deliberately incapable of
   * selecting an arbitrary run: every immutable binding and admission effect
   * must match the already persisted CodingRun before a state mutation occurs.
   */
  async cancelByAdmissionFence(
    input: CodingRunAdmissionFence,
  ): Promise<CodingRunAdmissionFenceResult> {
    const fence = validateAdmissionFence(input);
    const initial = await this.repository.load(fence.runId);
    if (!initial) throw new Error("CodingRun lifecycle fence tidak ditemukan.");
    assertAdmissionFence(initial, fence);
    if (terminal(initial.status)) return { run: initial, pendingCommit: false };
    const operations = [...(this.inFlightOperations.get(fence.runId) ?? [])];
    operations.forEach((entry) => entry.abort.abort(
      new Error("CodingRun dihentikan karena authority group berubah."),
    ));
    await callTransportWithDeadline(
      "CodingRun group authority quiescence",
      this.deletionQuiescenceMs,
      async () => {
        await Promise.all(operations.map((entry) => entry.done));
      },
    );
    await this.sandbox.fenceProjectRuns({
      ownerWorkspaceKey: fence.ownerWorkspaceKey,
      projectId: fence.projectId,
    });
    return this.exclusive(fence.runId, async () => {
      const run = await this.repository.load(fence.runId);
      if (!run) throw new Error("CodingRun lifecycle fence tidak ditemukan.");
      assertAdmissionFence(run, fence);
      if (terminal(run.status)) return { run, pendingCommit: false };
      if (run.pendingCommit) {
        // Never erase an exact-effect barrier: the snapshot may already have
        // committed. Recovery must report completed/partial before cleanup.
        return { run, pendingCommit: true };
      }
      const at = this.now().toISOString();
      const cancelled = await this.saveRun(run, {
        status: "cancelled",
        phase: "cancelled",
        pendingQuestion: null,
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "run.cancelled",
            run.instructionRevision,
            fence.cause,
            at,
          ),
        ),
        completedAt: at,
        updatedAt: at,
      });
      await this.projects.disposeWorkingCopyReferenceForRunFence({
        projectId: run.binding.projectId,
        ownerWorkspaceKey: run.binding.ownerWorkspaceKey,
        workingCopyId: run.workingCopyId,
        workspaceRevision: run.binding.workspaceRevision,
        baseSnapshot: run.binding.baseSnapshot,
      });
      this.runtimes.delete(run.runId);
      return { run: cancelled, pendingCommit: false };
    });
  }

  async cancelAndFenceForDeletion(
    reference: ProjectDeletionReference,
  ): Promise<{
    runIds: string[];
    totalRunCount: number;
    blockedRunId: string | null;
  }> {
    const durableReference = structuredClone(reference);
    await this.projects.assertDurableDeletionProject(durableReference);
    const projectId = durableReference.projectId;
    const ownerWorkspaceKey = durableReference.ownerWorkspaceKey;
    const initial = await this.repository.listByProject(projectId);
    for (const run of initial) {
      if (
        run.binding.ownerWorkspaceKey !== ownerWorkspaceKey ||
        run.binding.projectId !== projectId
      ) {
        throw new Error("CodingRun deletion berada di workspace lain.");
      }
    }
    const totalRunCount = initial.length;
    const runIds = initial.map((run) => run.runId);
    for (const runId of runIds) {
      const operations = [...(this.inFlightOperations.get(runId) ?? [])];
      operations.forEach((entry) => entry.abort.abort());
      await callTransportWithDeadline(
        "CodingRun project deletion quiescence",
        this.deletionQuiescenceMs,
        async () => {
          await Promise.all(operations.map((entry) => entry.done));
        },
      );
    }
    await this.sandbox.fenceProjectRuns({
      ownerWorkspaceKey,
      projectId,
    });
    for (const runId of runIds) {
      const blocked = await this.exclusive(runId, async () => {
        const current = await this.repository.load(runId);
        if (!current) return false;
        if (
          current.binding.ownerWorkspaceKey !== ownerWorkspaceKey ||
          current.binding.projectId !== projectId
        ) throw new Error("CodingRun deletion berada di workspace lain.");
        const refreshed = await this.repository.load(runId);
        if (!refreshed) return false;
        if (refreshed.pendingCommit) {
          const observed = await this.projects.hasDurableDeletionProjectEffect(
            durableReference,
            refreshed.pendingCommit.effectId,
          );
          if (observed) return true;
        }
        if (!terminal(refreshed.status)) {
          const at = this.now().toISOString();
          await this.saveRun(refreshed, {
            status: "cancelled",
            phase: "cancelled",
            pendingQuestion: null,
            pendingCommit: null,
            events: appendEvent(
              refreshed.events,
              makeEvent(
                this.makeId,
                "run.cancelled",
                refreshed.instructionRevision,
                "project_deletion_fence",
                at,
              ),
            ),
            completedAt: at,
            updatedAt: at,
          });
        }
        await this.projects.disposeWorkingCopyReferenceForDurableDeletion(
          durableReference,
          {
            projectId: refreshed.binding.projectId,
            ownerWorkspaceKey: refreshed.binding.ownerWorkspaceKey,
            workingCopyId: refreshed.workingCopyId,
            workspaceRevision: refreshed.binding.workspaceRevision,
            baseSnapshot: refreshed.binding.baseSnapshot,
          },
        );
        this.runtimes.delete(runId);
        return false;
      });
      if (blocked) return { runIds, totalRunCount, blockedRunId: runId };
    }
    return { runIds, totalRunCount, blockedRunId: null };
  }

  /**
   * Reconciles a crash after the pending commit was persisted. The workspace
   * effect is idempotent by effectId, so concurrent recovery cannot create a
   * second revision. Ambiguous transport/storage failures retain the barrier.
   */
  async recoverPendingCommit(
    scope: WorkspaceAgentScope,
    runId: string,
  ): Promise<CodingRun> {
    return this.authorizedExclusive(scope, runId, ["code.write"], async () => {
      const run = await this.repository.load(runId);
      if (
        !run ||
        run.binding.ownerWorkspaceKey !== scope.workspaceKey ||
        run.status !== "validating" ||
        !run.pendingCommit
      ) {
        throw new Error("CodingRun tidak mempunyai pending commit untuk direkonsiliasi.");
      }
      let project = await this.projects.get(scope, run.binding.projectId);
      if (!project) throw new Error("ProjectWorkspace recovery tidak tersedia pada scope ini.");
      await this.projects.withFreshProject(
        scope,
        project.id,
        project.revision,
        "code.write",
        async () => undefined,
      );
      const pending = run.pendingCommit;
      if (!run.diff || run.diff.workingSnapshot !== pending.workingSnapshot) {
        throw new Error("Evidence diff pending commit tidak cocok.");
      }
      await this.assertDurableValidatorEvidence(run, pending.validatorEvidence);
      const validators = validatorsFromPending(run, pending);
      const taskReview = taskReviewFromPending(run, pending);
      const at = this.now().toISOString();
      let committedRevision = committedWorkspaceRevision(project, run);
      if (
        !committedRevision &&
        project.revision === pending.sourceWorkspaceRevision &&
        project.baseSnapshot === run.binding.baseSnapshot
      ) {
        try {
          const working = await this.projects.rehydrateWorkingCopy(scope, {
            projectId: run.binding.projectId,
            ownerWorkspaceKey: run.binding.ownerWorkspaceKey,
            workingCopyId: run.workingCopyId,
            workspaceRevision: run.binding.workspaceRevision,
            baseSnapshot: run.binding.baseSnapshot,
          });
          project = await this.projects.commitWorkingCopy(scope, working, {
            effectId: pending.effectId,
            expectedSnapshotId: pending.workingSnapshot,
          });
        } catch {
          const observed = await this.projects.get(scope, run.binding.projectId);
          if (observed) project = observed;
        }
        committedRevision = committedWorkspaceRevision(project, run);
      }
      if (committedRevision) {
        const completed = await this.saveRun(run, {
          status: "completed",
          phase: "completed",
          pendingCommit: null,
          commitReceipts: [
            ...run.commitReceipts,
            {
              effectId: pending.effectId,
              status: "committed",
              sourceWorkspaceRevision: pending.sourceWorkspaceRevision,
              committedWorkspaceRevision: committedRevision.revision,
              snapshotId: pending.workingSnapshot,
              committedAt: at,
            },
          ],
          result: {
            instructionRevision: pending.instructionRevision,
            projectRevision: committedRevision.revision,
            snapshotId: pending.workingSnapshot,
            changedFiles: run.diff.files.length,
            validators,
            taskReview,
            completedAt: at,
          },
          events: appendEvent(
            run.events,
            makeEvent(
              this.makeId,
              "run.completed",
              run.instructionRevision,
              "coding_commit_reconciled",
              at,
            ),
          ),
          lastError: null,
          completedAt: at,
          updatedAt: at,
        });
        this.runtimes.delete(runId);
        await this.projects.pruneUnreferencedSnapshots(
          scope,
          project.id,
          project.revision,
        ).catch(() => undefined);
        return completed;
      }
      if (
        project.revision === pending.sourceWorkspaceRevision &&
        project.baseSnapshot === run.binding.baseSnapshot
      ) {
        return this.saveRun(run, {
          lastError: {
            stage: "recovery",
            code: "commit_reconciliation_pending",
            at,
          },
          updatedAt: at,
        });
      }
      const partial = await this.saveRun(run, {
        status: "partial",
        phase: "failed",
        pendingCommit: null,
        commitReceipts: [
          ...run.commitReceipts,
          {
            effectId: pending.effectId,
            status: "unknown",
            sourceWorkspaceRevision: pending.sourceWorkspaceRevision,
            committedWorkspaceRevision: null,
            snapshotId: pending.workingSnapshot,
            committedAt: at,
          },
        ],
        lastError: {
          stage: "recovery",
          code: "commit_outcome_ambiguous",
          at,
        },
        completedAt: at,
        updatedAt: at,
      });
      await this.projects.disposeWorkingCopyReference(scope, {
        projectId: run.binding.projectId,
        ownerWorkspaceKey: run.binding.ownerWorkspaceKey,
        workingCopyId: run.workingCopyId,
        workspaceRevision: run.binding.workspaceRevision,
        baseSnapshot: run.binding.baseSnapshot,
      }).catch(() => undefined);
      await this.projects.pruneUnreferencedSnapshots(
        scope,
        project.id,
        project.revision,
      ).catch(() => undefined);
      this.runtimes.delete(runId);
      return partial;
    });
  }

  private async prepareSandboxExecution(
    scope: WorkspaceAgentScope,
    runId: string,
    expectedInstructionRevision: number,
    request: SandboxExecRequest,
    expectedStateRevision?: number,
  ): Promise<PreparedSandboxExecution> {
    return this.authorizedExclusive(
      scope,
      runId,
      ["code.write", "sandbox.execute"],
      async () => {
      let run = await this.requireMutableRun(scope, runId);
      assertStateRevision(run, expectedStateRevision);
      run = await this.claimOrRenewWriter(run);
      assertInstruction(run, expectedInstructionRevision);
      currentPlan(run);
      this.assertActiveBudget(run, "sandbox");
      const runtime = await this.runtimeFor(scope, run);
      const snapshot = await runtime.tools.withStableWorkingCopy(() =>
        this.projects.stageWorkingSnapshot(scope, runtime.working)
      );
      const at = this.now().toISOString();
      const saved = await this.saveRun(run, {
        phase: request.purpose === "test" ? "testing" : "reviewing",
        counters: {
          ...run.counters,
          sandboxCalls: run.counters.sandboxCalls + 1,
          activeElapsedMs: activeElapsed(run, this.now()),
        },
        events: appendEvent(
          run.events,
          makeEvent(
            this.makeId,
            "testing.started",
            run.instructionRevision,
            `sandbox_${request.purpose}_started`,
            at,
          ),
        ),
      });
      return { run: saved, snapshot, request };
    });
  }

  private async executePrepared(
    scope: WorkspaceAgentScope,
    prepared: PreparedSandboxExecution,
    signal?: AbortSignal,
    persistEvidence = false,
  ): Promise<ExecutedSandboxResult> {
    return this.trackInFlight(
      prepared.run.runId,
      signal,
      (effectiveSignal) => this.executePreparedTracked(
        scope,
        prepared,
        effectiveSignal,
        persistEvidence,
      ),
    );
  }

  private async trackInFlight<T>(
    runId: string,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const tracked = this.registerInFlight(runId, signal);
    try {
      return await operation(tracked.signal);
    } finally {
      tracked.finish();
    }
  }

  private registerInFlight(
    runId: string,
    signal?: AbortSignal,
  ): RegisteredInFlightOperation {
    const abort = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry = { abort, done };
    const entries = this.inFlightOperations.get(runId) ?? new Set();
    entries.add(entry);
    this.inFlightOperations.set(runId, entries);
    const combinedSignal = signal
      ? AbortSignal.any([signal, abort.signal])
      : abort.signal;
    let finished = false;
    return {
      signal: combinedSignal,
      finish: () => {
        if (finished) return;
        finished = true;
      entries.delete(entry);
      if (entries.size === 0) this.inFlightOperations.delete(runId);
      finish();
      },
    };
  }

  private async executePreparedTracked(
    scope: WorkspaceAgentScope,
    prepared: PreparedSandboxExecution,
    signal: AbortSignal,
    persistEvidence: boolean,
  ): Promise<ExecutedSandboxResult> {
    const launched = await this.projects.withWorkspacePermissions(
      scope,
      ["code.write", "sandbox.execute"],
      async () => {
        try {
          await this.assertResultFresh(
            scope,
            prepared.run.runId,
            prepared.run.instructionRevision,
            prepared.snapshot.snapshotId,
          );
        } catch (error) {
          throw new SandboxExecutionPreflightError(error);
        }
        const lease = await this.projects.withSandboxSnapshotSource(
          scope,
          prepared.snapshot,
          (snapshotSource) => this.sandbox.allocate(
            {
              ownerWorkspaceKey: prepared.run.binding.ownerWorkspaceKey,
              projectId: prepared.run.binding.projectId,
              snapshotId: prepared.snapshot.snapshotId,
              workspaceRevision: prepared.run.binding.workspaceRevision,
              runId: prepared.run.runId,
            },
            snapshotSource,
          ),
        );
        try {
          return {
            lease,
            result: this.sandbox.execute(lease, prepared.request, signal),
          };
        } catch (error) {
          await this.sandbox.dispose(lease);
          throw error;
        }
      },
    );
    let executed: ExecutedSandboxResult;
    try {
      const result = await launched.result;
      const durableEvidenceIds: string[] = [];
      if (persistEvidence) {
        if (!this.evidenceStore) {
          throw new Error(
            "CodingEvidenceStore wajib dikonfigurasi untuk validator.",
          );
        }
        await this.projects.withWorkspacePermissions(
          scope,
          ["artifact.write"],
          async () => {
            await this.assertResultFresh(
              scope,
              prepared.run.runId,
              prepared.run.instructionRevision,
              prepared.snapshot.snapshotId,
            );
            const binding = evidenceBinding(prepared.run);
            let source: CodingEvidenceSource;
            try {
              source = evidenceSource(result);
            } catch (error) {
              throw new SandboxEvidenceBoundaryError(error);
            }
            if (
              containsSecretLikeValue(result.stdout) ||
              containsSecretLikeValue(result.stderr)
            ) {
              throw new SandboxEvidenceBoundaryError(
                new Error("Output validator menyerupai credential dan diblokir."),
              );
            }
            if (result.artifacts.length === 0) {
              const transcript = result.stderr
                ? `${result.stdout}\n[stderr]\n${result.stderr}`
                : result.stdout;
              const bytes = Buffer.from(transcript, "utf8");
              const artifact = inlineEvidenceArtifact(source, "stdout", bytes);
              const evidenceId = await this.evidenceStore!.persist(
                binding,
                source,
                artifact,
                bytes,
              );
              durableEvidenceIds.push(safeSandboxEvidenceId(
                evidenceId,
                "durable evidenceId",
              ));
            }
            for (const artifact of result.artifacts) {
              const bytes = await this.sandbox.readArtifact(
                launched.lease,
                artifact,
              );
              if (
                textualMediaType(artifact.mediaType) &&
                containsSecretLikeValue(Buffer.from(bytes).toString("utf8"))
              ) {
                throw new Error(
                  "Artifact validator menyerupai credential dan diblokir.",
                );
              }
              const evidenceId = await this.evidenceStore!.persist(
                binding,
                source,
                artifact,
                bytes,
              );
              const safeId = safeSandboxEvidenceId(
                evidenceId,
                "durable evidenceId",
              );
              if (!durableEvidenceIds.includes(safeId)) {
                durableEvidenceIds.push(safeId);
              }
            }
          },
        );
      }
      executed = { result, durableEvidenceIds };
    } catch (error) {
      await this.sandbox.dispose(launched.lease).catch(() => undefined);
      throw error;
    }
    try {
      await this.sandbox.dispose(launched.lease);
    } catch (error) {
      throw new SandboxCleanupError(executed, error);
    }
    return executed;
  }

  private async assertDurableValidatorEvidence(
    run: CodingRun,
    required: PendingCodingCommit["validatorEvidence"],
  ): Promise<void> {
    const binding = evidenceBinding(run);
    for (const prepared of required) {
      const receipt = run.validatorReceipts.find(
        (candidate) => candidate.receiptId === prepared.receiptId,
      );
      if (!receipt) throw new Error("Receipt validator durable hilang.");
      if (receipt.evidenceArtifactIds.length === 0) {
        throw new Error("Validator wajib mempunyai artifact evidence durable.");
      }
      if (!this.evidenceStore) {
        throw new Error("CodingEvidenceStore wajib untuk artifact validator.");
      }
      for (const evidenceId of receipt.evidenceArtifactIds) {
        if (!await this.evidenceStore.verify(
          binding,
          evidenceId,
          evidenceSource(receipt),
        )) {
          throw new Error("Artifact evidence validator hilang atau berubah.");
        }
      }
    }
  }

  private async recordInfrastructureValidatorFailure(
    scope: WorkspaceAgentScope,
    prepared: PreparedSandboxExecution,
    kind: CodingValidatorKind,
    command: CodingValidationCommand,
    error: unknown,
  ): Promise<{ run: CodingRun; receipt: CodingValidatorReceipt }> {
    return this.authorizedExclusive(
      scope,
      prepared.run.runId,
      ["code.write"],
      async () => {
      let run = await this.requireMutableRun(scope, prepared.run.runId);
      run = await this.claimOrRenewWriter(run);
      const at = this.now().toISOString();
      const receipt: CodingValidatorReceipt = {
        receiptId: opaqueId("validator", this.makeId()),
        kind,
        status: run.instructionRevision === prepared.run.instructionRevision
          ? "infrastructure_error"
          : "stale",
        instructionRevision: prepared.run.instructionRevision,
        workingSnapshot: prepared.snapshot.snapshotId,
        commandDigest: validatorCommandDigest(command),
        taskContractDigest: taskContractDigest(prepared.run),
        sandboxOperationId: error instanceof SandboxCleanupError
          ? error.executed.result.operationId
          : opaqueId("unavailable-operation", this.makeId()),
        sandboxRequestDigest: error instanceof SandboxCleanupError
          ? error.executed.result.requestDigest
          : digestJson({
            runId: prepared.run.runId,
            instructionRevision: prepared.run.instructionRevision,
            snapshotId: prepared.snapshot.snapshotId,
            request: prepared.request,
          }),
        sandboxExecutionId: error instanceof SandboxCleanupError
          ? error.executed.result.executionId
          : opaqueId("unavailable", this.makeId()),
        exitCode: error instanceof SandboxCleanupError
          ? error.executed.result.exitCode
          : null,
        evidenceArtifactIds: error instanceof SandboxCleanupError
          ? error.executed.durableEvidenceIds
          : [],
        completedAt: at,
      };
      const saved = await this.saveRun(run, {
        phase: "editing",
        validatorReceipts: [...run.validatorReceipts, receipt],
        lastError: {
          stage: "sandbox",
          code: errorCode(error),
          at,
        },
      });
      return { run: saved, receipt };
    });
  }

  private async assertResultFresh(
    scope: WorkspaceAgentScope,
    runId: string,
    instructionRevision: number,
    workingSnapshot: string,
  ): Promise<void> {
    const run = await this.requireMutableRun(scope, runId);
    assertInstruction(run, instructionRevision);
    const runtime = await this.runtimeFor(scope, run);
    const diff = await runtime.tools.diff(instructionRevision);
    if (diff.workingSnapshot !== workingSnapshot) {
      throw new Error("Hasil sandbox basi karena working copy sudah berubah.");
    }
  }

  private async runtimeFor(
    scope: WorkspaceAgentScope,
    run: CodingRun,
    allowTerminalize = true,
  ): Promise<CodingRuntime> {
    const existing = this.runtimes.get(run.runId);
    if (existing) {
      if (existing.scope.authorityKey === scope.authorityKey) return existing;
      const rebound = this.buildRuntime(
        scope,
        run,
        existing.base,
        existing.working,
      );
      this.runtimes.set(run.runId, rebound);
      return rebound;
    }
    const base = await this.projects.getSnapshotHandle(
      scope,
      run.binding.projectId,
      run.binding.workspaceRevision,
    );
    if (base.snapshotId !== run.binding.baseSnapshot) {
      throw new Error("Base snapshot CodingRun sudah basi.");
    }
    const working = await this.projects.rehydrateWorkingCopy(scope, {
      projectId: run.binding.projectId,
      ownerWorkspaceKey: run.binding.ownerWorkspaceKey,
      workingCopyId: run.workingCopyId,
      workspaceRevision: run.binding.workspaceRevision,
      baseSnapshot: run.binding.baseSnapshot,
    });
    const durableDiff = await diffTrees(base, working);
    const expectedWorkingSnapshot = run.diff?.workingSnapshot ?? run.binding.baseSnapshot;
    if (durableDiff.workingSnapshot !== expectedWorkingSnapshot) {
      if (!allowTerminalize) {
        throw new Error("Working copy CodingRun tidak cocok dengan evidence durable.");
      }
      const at = this.now().toISOString();
      const failed = await this.repository.save(
        {
          ...withoutStateRevision(run),
          status: "failed",
          phase: "failed",
          pendingQuestion: null,
          events: appendEvent(
            run.events,
            makeEvent(
              this.makeId,
              "run.failed",
              run.instructionRevision,
              "working_copy_evidence_mismatch",
              at,
            ),
          ),
          lastError: {
            stage: "workspace",
            code: "working_copy_evidence_mismatch",
            at,
          },
          completedAt: at,
          updatedAt: at,
        },
        run.stateRevision,
      );
      if (failed.status !== "saved") {
        throw new Error("Working copy CodingRun rusak dan state berubah bersamaan.");
      }
      throw new Error("Working copy CodingRun tidak cocok dengan evidence durable.");
    }
    const runtime = this.buildRuntime(scope, run, base, working);
    this.runtimes.set(run.runId, runtime);
    return runtime;
  }

  private buildRuntime(
    scope: WorkspaceAgentScope,
    run: CodingRun,
    base: ProjectSnapshotHandle,
    working: ProjectWorkingCopy,
  ): CodingRuntime {
    const guard = async (
      expectedInstructionRevision: number,
      _effect: "read" | "write",
    ) => {
      const current = await this.repository.load(run.runId);
      if (!current || terminal(current.status)) {
        throw new Error("CodingRun tidak lagi aktif.");
      }
      assertInstruction(current, expectedInstructionRevision);
      if (
        _effect === "write" &&
        (
          current.writer.writerId !== this.writerId ||
          Date.parse(current.writer.expiresAt) <= this.now().getTime()
        )
      ) {
        throw new Error("Writer lease CodingRun berubah atau kedaluwarsa.");
      }
      const project = await this.projects.get(scope, current.binding.projectId);
      if (
        !project ||
        project.revision !== current.binding.workspaceRevision ||
        project.baseSnapshot !== current.binding.baseSnapshot
      ) {
        throw new Error("ProjectWorkspace CodingRun sudah basi.");
      }
    };
    return {
      scope,
      base,
      working,
      tools: new RepositoryTools(
        base,
        working,
        guard,
        this.repositoryToolLimits,
        this.makeId,
      ),
    };
  }

  private async failQuarantinedWorkingCopy(
    scope: WorkspaceAgentScope,
    runInput: CodingRun,
    runtime: CodingRuntime,
    error: WorkingCopyQuarantinedError,
  ): Promise<void> {
    const current = await this.repository.load(runInput.runId);
    if (!current || terminal(current.status)) return;
    const at = this.now().toISOString();
    const saved = await this.repository.save(
      {
        ...withoutStateRevision(current),
        status: "failed",
        phase: "failed",
        pendingQuestion: null,
        pendingCommit: null,
        events: appendEvent(
          current.events,
          makeEvent(
            this.makeId,
            "run.failed",
            current.instructionRevision,
            "working_copy_quarantined",
            at,
          ),
        ),
        lastError: {
          stage: "workspace",
          code: error.name,
          at,
        },
        completedAt: at,
        updatedAt: at,
      },
      current.stateRevision,
    );
    if (saved.status !== "saved") {
      throw new Error("Working copy dikarantina tetapi state CodingRun berubah bersamaan.");
    }
    await this.projects.disposeWorkingCopy(scope, runtime.working).catch(() => undefined);
    this.runtimes.delete(runInput.runId);
  }

  private async markRunStale(
    scope: WorkspaceAgentScope,
    run: CodingRun,
    summaryCode: string,
  ): Promise<CodingRun> {
    return this.projects.withWorkspacePermission(scope, "code.write", async () => {
      if (run.binding.ownerWorkspaceKey !== scope.workspaceKey || run.pendingCommit) {
        throw new Error("CodingRun stale tidak dapat diterminalkan pada scope ini.");
      }
      const current = await this.repository.load(run.runId);
      if (
        !current ||
        terminal(current.status) ||
        current.pendingCommit ||
        current.stateRevision !== run.stateRevision
      ) {
        throw new Error("ProjectWorkspace CodingRun basi dan state berubah bersamaan.");
      }
      const at = this.now().toISOString();
      const stale = await this.repository.save(
        {
          ...withoutStateRevision(current),
          status: "stale",
          phase: "failed",
          pendingQuestion: null,
          events: appendEvent(
            current.events,
            makeEvent(
              this.makeId,
              "run.failed",
              current.instructionRevision,
              summaryCode,
              at,
            ),
          ),
          lastError: { stage: "workspace", code: "project_workspace_stale", at },
          completedAt: at,
          updatedAt: at,
        },
        current.stateRevision,
      );
      if (stale.status !== "saved") {
        throw new Error("ProjectWorkspace CodingRun basi dan state berubah bersamaan.");
      }
      const runtime = this.runtimes.get(current.runId);
      if (runtime) {
        await this.projects.disposeWorkingCopy(scope, runtime.working).catch(() => undefined);
      } else {
        await this.projects.disposeWorkingCopyReference(scope, {
          projectId: current.binding.projectId,
          ownerWorkspaceKey: current.binding.ownerWorkspaceKey,
          workingCopyId: current.workingCopyId,
          workspaceRevision: current.binding.workspaceRevision,
          baseSnapshot: current.binding.baseSnapshot,
        }).catch(() => undefined);
      }
      this.runtimes.delete(current.runId);
      return stale.run;
    });
  }

  private async requireMutableRun(
    scope: WorkspaceAgentScope,
    runId: string,
    permission: "code.read" | "code.write" = "code.write",
    allowWaiting = false,
  ): Promise<CodingRun> {
    const run = await this.repository.load(boundedText(runId, 512, "runId"));
    if (!run || run.binding.ownerWorkspaceKey !== scope.workspaceKey) {
      throw new Error("CodingRun tidak ditemukan pada workspace ini.");
    }
    if (run.version !== 2) {
      throw new Error("CodingRun legacy v1 hanya dapat dibaca; mulai run v2 baru.");
    }
    validateTaskBrief(run.taskBrief);
    for (const constraint of run.constraints) {
      boundedTaskText(constraint.content, 8_192, "coding constraint durable");
    }
    if (terminal(run.status)) throw new Error("CodingRun sudah terminal.");
    if (run.status === "waiting_input" && !allowWaiting) {
      throw new Error("CodingRun sedang dipause; resume coordinator wajib.");
    }
    if (run.pendingCommit) {
      throw new Error("CodingRun berada pada commit barrier; hanya reconciliation yang diizinkan.");
    }
    const project = await this.projects.get(scope, run.binding.projectId);
    if (!project) {
      throw new Error("ProjectWorkspace CodingRun tidak tersedia pada scope ini.");
    }
    if (permission === "code.write") {
      await this.projects.withFreshProject(
        scope,
        project.id,
        project.revision,
        "code.write",
        async () => undefined,
      );
    }
    if (
      project.revision !== run.binding.workspaceRevision ||
      project.baseSnapshot !== run.binding.baseSnapshot
    ) {
      if (permission === "code.read") {
        throw new Error("ProjectWorkspace CodingRun sudah basi.");
      }
      await this.markRunStale(scope, run, "project_workspace_stale");
      throw new Error("ProjectWorkspace CodingRun sudah basi.");
    }
    return run;
  }

  private async claimOrRenewWriter(run: CodingRun): Promise<CodingRun> {
    const at = this.now();
    const wasWaiting = run.status === "waiting_input";
    if (
      run.writer.writerId !== this.writerId &&
      run.status !== "waiting_input" &&
      Date.parse(run.writer.expiresAt) > at.getTime()
    ) {
      throw new Error("CodingRun sedang dimiliki integrator writer lain.");
    }
    return this.saveRun(run, {
      writer: run.writer.writerId === this.writerId
        ? { ...run.writer, expiresAt: new Date(at.getTime() + WRITER_LEASE_MS).toISOString() }
        : writerLease(this.writerId, at),
      counters: {
        ...run.counters,
        activeElapsedMs: wasWaiting
          ? run.counters.activeElapsedMs
          : activeElapsed(run, at),
      },
    });
  }

  private assertActiveBudget(
    run: CodingRun,
    effect: "work" | "patch" | "sandbox",
  ): void {
    const elapsed = activeElapsed(run, this.now());
    if (elapsed >= run.limits.maxActiveMs) {
      throw new Error("CodingRun active-time budget habis.");
    }
    if (effect === "patch" && run.counters.patches >= run.limits.maxPatches) {
      throw new Error("CodingRun patch budget habis.");
    }
    if (
      effect === "sandbox" &&
      run.counters.sandboxCalls >= run.limits.maxSandboxCalls
    ) {
      throw new Error("CodingRun sandbox-call budget habis.");
    }
  }

  private async saveRun(
    current: CodingRun,
    changes: Partial<Omit<CodingRun, "version" | "runId" | "binding" | "taskBrief" | "stateRevision">>,
  ): Promise<CodingRun> {
    const updatedAt = changes.updatedAt ?? this.now().toISOString();
    const requestedCounters = changes.counters ?? current.counters;
    const counters = {
      ...requestedCounters,
      activeElapsedMs: current.status === "running"
        ? Math.max(
          requestedCounters.activeElapsedMs,
          activeElapsed(current, new Date(updatedAt)),
        )
        : requestedCounters.activeElapsedMs,
    };
    const saved = await this.repository.save(
      {
        ...withoutStateRevision(current),
        ...changes,
        counters,
        updatedAt,
      },
      current.stateRevision,
    );
    if (saved.status !== "saved") {
      throw new Error("CodingRun berubah bersamaan; hasil tidak di-commit.");
    }
    return saved.run;
  }

  private authorizedExclusive<T>(
    scope: WorkspaceAgentScope,
    runId: string,
    permissions: readonly WorkspacePermission[],
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.projects.withWorkspacePermissions(
      scope,
      permissions,
      () => this.exclusive(runId, operation),
    );
  }

  private async exclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(runId, tail);
    try {
      return await next;
    } finally {
      if (this.queues.get(runId) === tail) this.queues.delete(runId);
    }
  }
}

function withoutStateRevision(run: CodingRun): Omit<CodingRun, "stateRevision"> {
  const { stateRevision: _revision, ...rest } = run;
  return rest;
}

function validateTaskBrief(input: CodingTaskBrief): CodingTaskBrief {
  return {
    request: boundedTaskText(input.request, 16_000, "coding request"),
    objective: boundedTaskText(input.objective, 4_000, "coding objective"),
    acceptanceCriteria: boundedList(input.acceptanceCriteria, 32, 2_000),
    initialConstraints: boundedList(input.initialConstraints, 32, 2_000),
  };
}

function validateCodingRunAdmission(
  value: CodingRunAdmission | undefined,
): CodingRunAdmission | null {
  if (value === undefined) return null;
  if (
    value.source !== "group" || value.audience !== "group-safe" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.effectId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.authorityRef) ||
    !/^[a-f0-9]{64}$/u.test(value.interactionDigest) ||
    containsSecretLikeValue(value.effectId) ||
    containsSecretLikeValue(value.authorityRef)
  ) {
    throw new Error("Admission provenance CodingRun tidak sah.");
  }
  return Object.freeze(structuredClone(value));
}

function validateAdmissionFence(
  value: CodingRunAdmissionFence,
): CodingRunAdmissionFence {
  const keys = Object.keys(value).sort();
  const expected = [
    "authorityRef", "cause", "effectId", "ownerWorkspaceKey", "projectId",
    "runId", "source", "version",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error("Schema lifecycle fence CodingRun tidak exact.");
  }
  const fence = structuredClone(value);
  if (
    fence.version !== 1 || fence.source !== "group" ||
    (fence.cause !== "group_disabled" &&
      fence.cause !== "group_authority_changed")
  ) throw new Error("Lifecycle fence CodingRun tidak sah.");
  for (const [field, raw] of [
    ["runId", fence.runId],
    ["ownerWorkspaceKey", fence.ownerWorkspaceKey],
    ["projectId", fence.projectId],
    ["effectId", fence.effectId],
    ["authorityRef", fence.authorityRef],
  ] as const) {
    const clean = boundedText(raw, 512, `lifecycle fence ${field}`);
    if (clean !== raw || containsSecretLikeValue(clean)) {
      throw new Error(`Lifecycle fence ${field} tidak sah.`);
    }
  }
  return Object.freeze(fence);
}

function assertAdmissionFence(
  run: CodingRun,
  fence: CodingRunAdmissionFence,
): void {
  if (
    run.runId !== fence.runId ||
    run.binding.ownerWorkspaceKey !== fence.ownerWorkspaceKey ||
    run.binding.projectId !== fence.projectId ||
    run.admission?.source !== fence.source ||
    run.admission.effectId !== fence.effectId ||
    run.admission.authorityRef !== fence.authorityRef
  ) {
    throw new Error("Lifecycle fence tidak cocok admission CodingRun exact.");
  }
}

function validateRunLimits(value: CodingRunLimits): CodingRunLimits {
  for (const [name, amount] of Object.entries(value)) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`CodingRun limit ${name} tidak sah.`);
    }
  }
  return Object.freeze({ ...value });
}

function writerLease(writerId: string, at: Date) {
  return {
    writerId,
    acquiredAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + WRITER_LEASE_MS).toISOString(),
  };
}

function assertInstruction(run: CodingRun, expected: number): void {
  if (!Number.isSafeInteger(expected) || run.instructionRevision !== expected) {
    throw new Error("Instruction revision CodingRun sudah basi.");
  }
}

function assertStateRevision(run: CodingRun, expected?: number): void {
  if (expected !== undefined && run.stateRevision !== expected) {
    throw new Error("State revision CodingRun sudah basi untuk action coordinator.");
  }
}

function activeElapsed(run: CodingRun, now: Date): number {
  const leaseHorizon = Date.parse(run.writer.expiresAt);
  const effectiveNow = Number.isFinite(leaseHorizon)
    ? Math.min(now.getTime(), leaseHorizon)
    : now.getTime();
  return run.counters.activeElapsedMs +
    Math.max(0, effectiveNow - Date.parse(run.updatedAt));
}

function makeEvent(
  makeId: () => string,
  type: CodingRunEvent["type"],
  instructionRevision: number,
  summaryCode: string,
  at: string,
): CodingRunEvent {
  return {
    id: opaqueId("coding-event", makeId()),
    type,
    at,
    instructionRevision,
    summaryCode: boundedText(summaryCode, 128, "coding event summary"),
  };
}

function appendEvent(
  events: readonly CodingRunEvent[],
  event: CodingRunEvent,
): CodingRunEvent[] {
  return [...events, event].slice(-MAX_EVENTS);
}

function changeSetStages(kind: CodingConstraintKind): CodingChangeSet["affectedStages"] {
  switch (kind) {
    case "constraint": return ["plan", "edits", "validators", "publish"];
    case "correction": return ["plan", "edits", "validators", "publish"];
    case "scope_change": return ["plan", "edits", "validators", "publish"];
  }
}

function digestJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function currentRepositoryMap(run: CodingRun): CodingRepositoryMapReceipt {
  const map = run.repositoryMap;
  if (!map || map.instructionRevision !== run.instructionRevision) {
    throw new Error("Repository map CodingRun terbaru belum tersedia.");
  }
  if (map.treeComplete !== true || map.symbolsComplete !== true) {
    throw new Error("Repository map CodingRun belum membuktikan traversal lengkap.");
  }
  const base = {
    instructionRevision: map.instructionRevision,
    workingSnapshot: map.workingSnapshot,
    treeDigest: map.treeDigest,
    symbolDigest: map.symbolDigest,
    entryCount: map.entryCount,
    symbolCount: map.symbolCount,
    treeComplete: map.treeComplete,
    symbolsComplete: map.symbolsComplete,
  };
  if (map.mapDigest !== digestJson(base)) {
    throw new Error("Digest repository map CodingRun tidak sah.");
  }
  return map;
}

function currentPlan(run: CodingRun): CodingRunPlan {
  const repositoryMap = currentRepositoryMap(run);
  const plan = run.plan;
  if (
    !plan ||
    plan.instructionRevision !== run.instructionRevision ||
    plan.repositoryMapDigest !== repositoryMap.mapDigest ||
    plan.taskContractDigest !== taskContractDigest(run)
  ) {
    throw new Error("Coding plan terbaru belum tersedia untuk instruction revision ini.");
  }
  const base = {
    revision: plan.revision,
    instructionRevision: plan.instructionRevision,
    repositoryMapDigest: plan.repositoryMapDigest,
    taskContractDigest: plan.taskContractDigest,
    steps: plan.steps,
  };
  if (plan.planDigest !== digestJson(base)) {
    throw new Error("Digest coding plan tidak sah.");
  }
  return plan;
}

function validatePlanSteps(
  value: readonly Pick<CodingPlanStep, "stage" | "description" | "paths">[],
): CodingPlanStep[] {
  if (!Array.isArray(value) || value.length < 4 || value.length > 32) {
    throw new Error("Coding plan wajib mempunyai 4 sampai 32 langkah.");
  }
  const allowedStages = new Set<CodingPlanStep["stage"]>([
    "inspect",
    "edit",
    "test",
    "review",
  ]);
  const seenStages = new Set<CodingPlanStep["stage"]>();
  const steps = value.map((candidate, index) => {
    const raw: unknown = candidate;
    assertExactReviewObject(
      raw,
      ["stage", "description", "paths"],
      "coding plan step",
    );
    const stage = raw.stage;
    if (
      typeof stage !== "string" ||
      !allowedStages.has(stage as CodingPlanStep["stage"])
    ) {
      throw new Error("Stage coding plan tidak sah.");
    }
    const description = raw.description;
    const paths = raw.paths;
    if (
      typeof description !== "string" ||
      !Array.isArray(paths) ||
      paths.length > 32 ||
      paths.some((path) => typeof path !== "string")
    ) {
      throw new Error("Path coding plan melampaui batas.");
    }
    const typedStage = stage as CodingPlanStep["stage"];
    seenStages.add(typedStage);
    return {
      stepId: `plan-step-${index + 1}`,
      stage: typedStage,
      description: boundedTaskText(description, 1_000, "coding plan description"),
      paths: [...new Set(paths.map((path) => safeCodingPath(path as string)))],
    };
  });
  if ([...allowedStages].some((stage) => !seenStages.has(stage))) {
    throw new Error("Coding plan wajib mencakup inspect, edit, test, dan review.");
  }
  return steps;
}

function taskReviewEvidenceRefs(
  run: CodingRun,
  diff: CodingDiffSummary,
): string[] {
  const refs = new Set<string>([`diff:${codingDiffDigest(diff)}`]);
  for (const receipt of run.validatorReceipts) {
    if (
      receipt.status === "passed" &&
      receipt.instructionRevision === run.instructionRevision &&
      receipt.workingSnapshot === diff.workingSnapshot
    ) refs.add(`validator:${receipt.receiptId}`);
  }
  return [...refs].sort();
}

function evidenceBinding(run: CodingRun): CodingEvidenceBinding {
  return {
    ownerWorkspaceKey: run.binding.ownerWorkspaceKey,
    projectId: run.binding.projectId,
    runId: run.runId,
  };
}

function evidenceSource(
  input: SandboxExecResult | CodingValidatorReceipt,
): CodingEvidenceSource {
  if ("operationId" in input) {
    return {
      sandboxOperationId: safeSandboxEvidenceId(
        input.operationId,
        "sandbox operationId",
      ),
      sandboxRequestDigest: safeSandboxRequestDigest(input.requestDigest),
      sandboxExecutionId: safeSandboxEvidenceId(
        input.executionId,
        "sandbox executionId",
      ),
    };
  }
  return {
    sandboxOperationId: input.sandboxOperationId,
    sandboxRequestDigest: input.sandboxRequestDigest,
    sandboxExecutionId: input.sandboxExecutionId,
  };
}

function inlineEvidenceArtifact(
  source: CodingEvidenceSource,
  purpose: "stdout" | "stderr",
  bytes: Uint8Array,
): SandboxArtifactReference {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sourceDigest = createHash("sha256")
    .update(JSON.stringify({ source, purpose }), "utf8")
    .digest("hex");
  return {
    artifactId: `inline-${purpose}-${sourceDigest}`,
    sha256,
    size: bytes.byteLength,
    mediaType: "text/plain; charset=utf-8",
    purpose,
  };
}

function textualMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();
  return normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("xml") ||
    normalized.includes("javascript");
}

function requiredValidatorEvidence(
  run: CodingRun,
  commands: readonly CodingValidationCommand[],
  snapshot: string,
): PendingCodingCommit["validatorEvidence"] {
  return commands
    .filter((command) => command.required)
    .map((command) => {
      const receipt = [...run.validatorReceipts].reverse().find(
        (candidate) =>
          candidate.kind === command.kind &&
          candidate.status === "passed" &&
          candidate.instructionRevision === run.instructionRevision &&
          candidate.workingSnapshot === snapshot &&
          candidate.commandDigest === validatorCommandDigest(command) &&
          candidate.taskContractDigest === taskContractDigest(run),
      );
      if (!receipt) throw new Error(`Receipt validator ${command.kind} hilang.`);
      return {
        receiptId: receipt.receiptId,
        kind: command.kind,
        commandDigest: receipt.commandDigest,
        taskContractDigest: receipt.taskContractDigest,
        sandboxOperationId: receipt.sandboxOperationId,
        sandboxRequestDigest: receipt.sandboxRequestDigest,
        sandboxExecutionId: receipt.sandboxExecutionId,
      };
    });
}

function requiredTaskReviewEvidence(
  run: CodingRun,
  diff: CodingDiffSummary,
  policy: CodingValidatorPolicy,
): NonNullable<PendingCodingCommit["taskReviewEvidence"]> {
  const diffDigest = codingDiffDigest(diff);
  const contractDigest = taskContractDigest(run);
  const policyDigest = taskReviewPolicyDigest(policy);
  const repositoryMap = currentRepositoryMap(run);
  const plan = currentPlan(run);
  const requirements = taskReviewRequirements(run);
  const receipt = [...(run.taskReviewReceipts ?? [])].reverse().find(
    (candidate) =>
      candidate.status === "approved" &&
      candidate.instructionRevision === run.instructionRevision &&
      candidate.workingSnapshot === diff.workingSnapshot &&
      candidate.diffDigest === diffDigest &&
      candidate.taskContractDigest === contractDigest &&
      candidate.policyDigest === policyDigest &&
      candidate.repositoryMapDigest === repositoryMap.mapDigest &&
      candidate.planDigest === plan.planDigest &&
      candidate.publicApi !== "changed" &&
      candidate.unrelatedChanges === "minimized" &&
      exactRequirementEvidence(candidate, requirements),
  );
  if (!receipt) {
    throw new Error("Task-level review terbaru belum menyetujui exact diff CodingRun.");
  }
  return {
    receiptId: receipt.receiptId,
    diffDigest,
    taskContractDigest: contractDigest,
    policyDigest,
    repositoryMapDigest: repositoryMap.mapDigest,
    planDigest: plan.planDigest,
  };
}

function taskReviewFromPending(
  run: CodingRun,
  pending: PendingCodingCommit,
): NonNullable<CodingRun["result"]>["taskReview"] {
  const evidence = pending.taskReviewEvidence;
  if (!evidence) {
    throw new Error("Pending commit legacy tidak mempunyai task review evidence v2.");
  }
  const receipt = (run.taskReviewReceipts ?? []).find(
    (candidate) =>
      candidate.receiptId === evidence.receiptId &&
      candidate.status === "approved" &&
      candidate.instructionRevision === pending.instructionRevision &&
      candidate.workingSnapshot === pending.workingSnapshot &&
      candidate.diffDigest === evidence.diffDigest &&
      candidate.taskContractDigest === evidence.taskContractDigest &&
      candidate.policyDigest === evidence.policyDigest &&
      candidate.repositoryMapDigest === evidence.repositoryMapDigest &&
      candidate.planDigest === evidence.planDigest,
  );
  const requirements = taskReviewRequirements(run);
  const repositoryMap = currentRepositoryMap(run);
  const plan = currentPlan(run);
  if (
    !receipt ||
    receipt.taskContractDigest !== taskContractDigest(run) ||
    receipt.repositoryMapDigest !== repositoryMap.mapDigest ||
    receipt.planDigest !== plan.planDigest ||
    receipt.publicApi === "changed" ||
    receipt.unrelatedChanges !== "minimized" ||
    !exactRequirementEvidence(receipt, requirements)
  ) {
    throw new Error("Task review evidence pending commit tidak sah.");
  }
  return {
    receiptId: evidence.receiptId,
    policyDigest: evidence.policyDigest,
    repositoryMapDigest: evidence.repositoryMapDigest,
    planDigest: evidence.planDigest,
  };
}

interface NormalizedTaskReview {
  approved: boolean;
  requirementEvidence: CodingTaskReviewReceipt["requirementEvidence"];
  publicApi: CodingTaskReviewReceipt["publicApi"];
  unrelatedChanges: CodingTaskReviewReceipt["unrelatedChanges"];
}

function normalizeTaskReviewAssessment(
  value: CodingTaskReviewAssessment,
  requirements: readonly CodingTaskReviewRequirement[],
  availableEvidenceRefs: ReadonlySet<string>,
): NormalizedTaskReview {
  assertExactReviewObject(
    value,
    ["decision", "requirementEvidence", "publicApi", "unrelatedChanges"],
    "task review assessment",
  );
  if (value.decision !== "approved" && value.decision !== "changes_requested") {
    throw new Error("Decision task review tidak sah.");
  }
  if (
    value.publicApi !== "preserved" &&
    value.publicApi !== "changed" &&
    value.publicApi !== "not_applicable"
  ) throw new Error("Evidence public API task review tidak sah.");
  if (
    value.unrelatedChanges !== "minimized" &&
    value.unrelatedChanges !== "not_minimized"
  ) throw new Error("Evidence unrelated changes task review tidak sah.");
  if (
    !Array.isArray(value.requirementEvidence) ||
    value.requirementEvidence.length !== requirements.length
  ) throw new Error("Jumlah requirement evidence task review tidak cocok.");
  const expected = new Map(requirements.map((item) => [item.digest, item]));
  const seen = new Set<string>();
  const requirementEvidence = value.requirementEvidence.map((item) => {
    assertExactReviewObject(
      item,
      ["requirementDigest", "status", "evidenceRefs"],
      "task review requirement evidence",
    );
    const requirement = expected.get(item.requirementDigest);
    if (!requirement || seen.has(item.requirementDigest)) {
      throw new Error("Requirement evidence task review asing atau duplikat.");
    }
    seen.add(item.requirementDigest);
    if (item.status !== "evidenced" && item.status !== "not_evidenced") {
      throw new Error("Status requirement evidence task review tidak sah.");
    }
    if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length > 32) {
      throw new Error("Evidence refs task review tidak sah.");
    }
    const evidenceRefs = [...new Set(item.evidenceRefs.map(safeReviewRef))];
    if (evidenceRefs.some((reference) => !availableEvidenceRefs.has(reference))) {
      throw new Error("Task review menunjuk evidence yang tidak dikenal.");
    }
    if (item.status === "evidenced" && evidenceRefs.length === 0) {
      throw new Error("Requirement evidenced wajib mempunyai evidence ref.");
    }
    return {
      kind: requirement.kind,
      requirementDigest: requirement.digest,
      status: item.status,
      evidenceRefs,
    };
  });
  const publicApiRequired = requirements.some(
    (item) =>
      item.kind === "constraint" &&
      /(?:\bapi\b|\bpublic\b|\bpublik\b)/iu.test(item.text),
  );
  const approved =
    value.decision === "approved" &&
    requirementEvidence.every((item) => item.status === "evidenced") &&
    value.unrelatedChanges === "minimized" &&
    value.publicApi !== "changed" &&
    (!publicApiRequired || value.publicApi === "preserved");
  return {
    approved,
    requirementEvidence,
    publicApi: value.publicApi,
    unrelatedChanges: value.unrelatedChanges,
  };
}

function failedTaskReview(
  requirements: readonly CodingTaskReviewRequirement[],
): NormalizedTaskReview {
  return {
    approved: false,
    requirementEvidence: requirements.map((item) => ({
      kind: item.kind,
      requirementDigest: item.digest,
      status: "not_evidenced",
      evidenceRefs: [],
    })),
    publicApi: "not_applicable",
    unrelatedChanges: "not_minimized",
  };
}

function exactRequirementEvidence(
  receipt: CodingTaskReviewReceipt,
  requirements: readonly CodingTaskReviewRequirement[],
): boolean {
  if (receipt.requirementEvidence.length !== requirements.length) return false;
  const evidence = new Map(
    receipt.requirementEvidence.map((item) => [item.requirementDigest, item]),
  );
  return requirements.every((requirement) => {
    const item = evidence.get(requirement.digest);
    return item?.kind === requirement.kind &&
      item.status === "evidenced" &&
      item.evidenceRefs.length > 0;
  });
}

function assertExactReviewObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} tidak sah.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mempunyai field asing atau hilang.`);
  }
}

function safeReviewRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /\p{Cc}/u.test(value) ||
    containsSecretLikeValue(value)
  ) throw new Error("Evidence ref task review tidak sah atau menyerupai credential.");
  return value;
}

function abortError(): Error {
  const error = new Error("Coding task review dibatalkan.");
  error.name = "AbortError";
  return error;
}

function validatorsFromPending(
  run: CodingRun,
  pending: PendingCodingCommit,
): NonNullable<CodingRun["result"]>["validators"] {
  if (pending.validatorEvidence.length < 1) {
    throw new Error("Pending commit tidak mempunyai validator evidence.");
  }
  const kinds = new Set<CodingValidatorKind>();
  return pending.validatorEvidence.map((evidence) => {
    if (kinds.has(evidence.kind)) {
      throw new Error("Pending commit mempunyai validator evidence duplikat.");
    }
    kinds.add(evidence.kind);
    const receipt = run.validatorReceipts.find(
      (candidate) =>
        candidate.receiptId === evidence.receiptId &&
        candidate.kind === evidence.kind &&
        candidate.status === "passed" &&
        candidate.instructionRevision === pending.instructionRevision &&
        candidate.workingSnapshot === pending.workingSnapshot &&
        candidate.commandDigest === evidence.commandDigest &&
        candidate.taskContractDigest === evidence.taskContractDigest &&
        candidate.sandboxOperationId === evidence.sandboxOperationId &&
        candidate.sandboxRequestDigest === evidence.sandboxRequestDigest &&
        candidate.sandboxExecutionId === evidence.sandboxExecutionId,
    );
    if (!receipt || receipt.taskContractDigest !== taskContractDigest(run)) {
      throw new Error(`Validator evidence pending ${evidence.kind} tidak sah.`);
    }
    return {
      kind: evidence.kind,
      status: "passed" as const,
      sandboxOperationId: evidence.sandboxOperationId,
      sandboxRequestDigest: evidence.sandboxRequestDigest,
      sandboxExecutionId: evidence.sandboxExecutionId,
    };
  });
}

function committedWorkspaceRevision(
  project: ProjectWorkspace,
  run: CodingRun,
): ProjectWorkspaceRevision | null {
  const pending = run.pendingCommit;
  if (!pending) throw new Error("Commit barrier CodingRun hilang.");
  const observed = project.snapshotHistory.find(
    (entry) => entry.effectId === pending.effectId,
  );
  if (!observed) return null;
  if (
    observed.reason !== "coding" ||
    observed.revision !== pending.sourceWorkspaceRevision + 1 ||
    observed.parentSnapshotId !== run.binding.baseSnapshot ||
    observed.snapshotId !== pending.workingSnapshot
  ) {
    throw new Error("Effect workspace CodingRun dipakai ulang untuk binding berbeda.");
  }
  return observed;
}

function validationCommands(
  policy: CodingValidatorPolicy,
  run: CodingRun,
): Promise<readonly CodingValidationCommand[]> {
  return policy.commandsFor({
    projectId: run.binding.projectId,
    baseSnapshot: run.binding.baseSnapshot,
    instructionRevision: run.instructionRevision,
    taskBrief: structuredClone(run.taskBrief),
    constraints: structuredClone(run.constraints),
  }).then((commands) => {
    if (!Array.isArray(commands) || !commands.some((command) => command.required)) {
      throw new Error("Policy CodingRun wajib menyediakan sedikitnya satu validator task-level.");
    }
    const kinds = new Set<CodingValidatorKind>();
    for (const command of commands) {
      if (kinds.has(command.kind)) {
        throw new Error(`Policy validator ${command.kind} duplikat.`);
      }
      kinds.add(command.kind);
      validatorCommand(commands, command.kind);
    }
    return structuredClone(commands);
  });
}

function terminal(status: CodingRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" ||
    status === "stale" || status === "partial";
}

function resumePhase(run: CodingRun): CodingRun["phase"] {
  if (!run.repositoryMap) return "mapping";
  if (!run.plan) return "planning";
  const currentPassed = run.validatorReceipts.some((receipt) =>
    receipt.status === "passed" &&
    receipt.instructionRevision === run.instructionRevision &&
    receipt.workingSnapshot === run.diff?.workingSnapshot
  );
  if (
    run.appliedInstructionRevision < run.instructionRevision ||
    !run.diff ||
    !currentPassed
  ) return "editing";
  return "reviewing";
}

function boundedList(values: readonly string[], max: number, maxCharacters: number): string[] {
  if (!Array.isArray(values) || values.length > max) {
    throw new Error("Daftar TaskBrief CodingRun melampaui batas.");
  }
  return values.map((value) => boundedTaskText(value, maxCharacters, "TaskBrief item"));
}

function boundedTaskText(value: string, max: number, field: string): string {
  const clean = boundedText(value, max, field);
  if (containsSecretLikeValue(clean)) {
    throw new Error(`${field} menyerupai credential dan tidak boleh dipersistenkan.`);
  }
  return clean;
}

function safeCodingPath(value: string): string {
  const clean = canonicalProjectPath(value);
  if (containsSecretLikeValue(clean)) {
    throw new Error("Path coding menyerupai credential dan tidak boleh dipersistenkan.");
  }
  return clean;
}

function safeSandboxEvidenceId(value: string, field: string): string {
  const clean = boundedText(value, 256, field);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(clean) ||
    containsSecretLikeValue(clean)
  ) {
    throw new Error(`${field} bukan opaque ID yang aman untuk evidence durable.`);
  }
  return clean;
}

function safeSandboxRequestDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("sandbox requestDigest bukan SHA-256 yang sah.");
  }
  return value;
}

function boundedText(value: string, max: number, field: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || clean.length > max || /\p{Cc}/u.test(clean.replace(/[\r\n\t]/gu, ""))) {
    throw new Error(`${field} tidak sah.`);
  }
  return clean;
}

function opaqueId(prefix: string, value: string): string {
  const clean = value.replace(/[^a-z0-9_-]/giu, "").slice(0, 80);
  if (!clean) throw new Error("Generator ID CodingRun tidak sah.");
  return `${prefix}-${clean}`;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "sandbox_cancelled";
  return "sandbox_unavailable";
}
