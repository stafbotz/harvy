import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodingRunCoordinator,
  type CodingCoordinatorEngine,
  type CodingCoordinatorRepositoryTools,
  type CodingWorkerAction,
  type CodingWorkerDriver,
  type CodingWorkerInput,
} from "../src/core/coding-run-coordinator.js";
import type {
  CodingRun,
  CodingTaskReviewReceipt,
  CodingValidatorKind,
  CodingValidatorReceipt,
} from "../src/domain/coding-run.js";
import type { StructuredPatchOperation } from "../src/coding/repository-tools.js";
import type { WorkspaceAgentScope } from "../src/harness/scope.js";
import type { SandboxExecRequest, SandboxExecResult } from "../src/domain/sandbox.js";

const NOW = "2026-08-11T11:00:00.000Z";
const SCOPE = {
  kind: "workspace",
  channel: "telegram",
  workspaceKey: "workspace-coordinator-1",
  principalKey: "principal-coordinator-1",
  membershipId: "membership-coordinator-1",
  aclEpoch: 1,
  role: "owner",
  permissions: ["code.read", "code.write", "run.create", "sandbox.execute"],
  conversationKey: "conversation-coordinator-1",
  authorityKey: "authority-coordinator-1",
  sharedMemoryKey: "memory-coordinator-1",
  artifactKey: "artifact-coordinator-1",
} satisfies WorkspaceAgentScope;

describe("CodingRunCoordinator", () => {
  it("menjalankan map→inspect→plan→edit→test→review→finalize secara bounded", async () => {
    const engine = new FakeCoordinatorEngine();
    const driver = new QueueDriver([
      { kind: "tree", path: "src", maxDepth: 4 },
      {
        kind: "plan",
        steps: [
          { stage: "inspect", description: "Inspect source", paths: ["src"] },
          { stage: "edit", description: "Update value", paths: ["src/index.ts"] },
          { stage: "test", description: "Run tests", paths: [] },
          { stage: "review", description: "Review diff", paths: [] },
        ],
      },
      { kind: "read", path: "src/index.ts", startLine: 1, endLine: 20 },
      {
        kind: "sandbox.exec",
        request: {
          argv: ["npm", "test"],
          cwd: ".",
          purpose: "test",
          timeoutMs: 30_000,
        },
      },
      {
        kind: "apply_patch",
        operations: [{
          kind: "update",
          path: "src/index.ts",
          expectedSha256: "a".repeat(64),
          content: "export const value = 2;\n",
        }],
      },
      { kind: "validator", validator: "test" },
      { kind: "task_review" },
      { kind: "finalize" },
    ]);
    const coordinator = new CodingRunCoordinator(engine, driver, {
      maxActions: 16,
      workerTimeoutMs: 1_000,
    });
    const result = await coordinator.run(SCOPE, engine.run.runId);

    assert.equal(result.outcome, "terminal");
    assert.equal(result.run.status, "completed");
    assert.equal(engine.mapped, 1);
    assert.equal(engine.plans, 1);
    assert.equal(engine.patches, 1);
    assert.equal(engine.sandboxExecutions, 1);
    assert.deepEqual(engine.validators, ["test"]);
    assert.equal(engine.reviews, 1);
    assert.equal(engine.finalized, 1);
    assert.deepEqual(
      driver.inputs.slice(1).map((input) => input.previousObservation?.kind),
      [
        "workspace.tree",
        "plan.recorded",
        "workspace.read",
        "sandbox.exec",
        "patch.applied",
        "validator.completed",
        "task_review.completed",
      ],
    );
    assert.equal(
      driver.inputs.some((input) =>
        JSON.stringify(input).includes("working-copy-coordinator")
      ),
      false,
    );
    assert.equal(
      driver.inputs.some((input) =>
        JSON.stringify(input).includes('"ownerWorkspaceKey"')
      ),
      false,
    );
  });

  it("menolak capability/field asing dan credential pada observation", async () => {
    const unknown = new FakeCoordinatorEngine();
    const unknownDriver = new QueueDriver([
      { kind: "shell", command: "git push" } as never,
    ]);
    await assert.rejects(
      new CodingRunCoordinator(unknown, unknownDriver).run(SCOPE, unknown.run.runId),
      /action tidak dikenal|field asing/iu,
    );
    assert.equal(unknown.patches, 0);
    assert.equal(unknown.validators.length, 0);

    const secret = new FakeCoordinatorEngine();
    secret.secretRead = true;
    const secretDriver = new QueueDriver([
      { kind: "read", path: "src/index.ts" },
    ]);
    await assert.rejects(
      new CodingRunCoordinator(secret, secretDriver).run(SCOPE, secret.run.runId),
      /credential.*diblokir/iu,
    );
    assert.equal(secretDriver.inputs.length, 1);
  });

  it("yield dan budget mempause run serta menghentikan loop secara durable", async () => {
    const yieldedEngine = new FakeCoordinatorEngine();
    const yielded = await new CodingRunCoordinator(
      yieldedEngine,
      new QueueDriver([{ kind: "yield", reasonCode: "needs_user_input" }]),
    ).run(SCOPE, yieldedEngine.run.runId);
    assert.equal(yielded.outcome, "yielded");
    assert.equal(yielded.run.status, "waiting_input");
    assert.equal(yielded.run.counters.coordinatorDecisions, 1);

    const budgetEngine = new FakeCoordinatorEngine();
    const budgetDriver = new RepeatingDriver({ kind: "diff" });
    const budget = await new CodingRunCoordinator(budgetEngine, budgetDriver, {
      maxActions: 3,
    }).run(SCOPE, budgetEngine.run.runId);
    assert.equal(budget.outcome, "action_budget");
    assert.equal(budget.actions, 3);
    assert.equal(budget.run.status, "waiting_input");
    // The code-owned mapping step consumes one invocation slot but no paid
    // worker decision; only the two diff decisions are durably charged.
    assert.equal(budget.run.counters.coordinatorDecisions, 2);

    const cumulative = new FakeCoordinatorEngine();
    cumulative.run.phase = "planning";
    cumulative.run.limits.maxCoordinatorDecisions = 2;
    for (let index = 0; index < 2; index += 1) {
      const result = await new CodingRunCoordinator(
        cumulative,
        new QueueDriver([{ kind: "yield", reasonCode: `checkpoint_${index}` }]),
      ).run(SCOPE, cumulative.run.runId);
      assert.equal(result.outcome, "yielded");
    }
    const mustNotRun = new QueueDriver([{ kind: "yield", reasonCode: "overflow" }]);
    const exhausted = await new CodingRunCoordinator(cumulative, mustNotRun).run(
      SCOPE,
      cumulative.run.runId,
    );
    assert.equal(exhausted.outcome, "action_budget");
    assert.equal(exhausted.actions, 0);
    assert.equal(exhausted.run.counters.coordinatorDecisions, 2);
    assert.equal(mustNotRun.inputs.length, 0);
  });

  it("melaporkan finalize pada slot terakhir sebagai terminal", async () => {
    const engine = new FakeCoordinatorEngine();
    await engine.markMapped(SCOPE, engine.run.runId, 0);
    await engine.recordPlan(SCOPE, engine.run.runId, 0, {
      steps: [{
        stage: "review",
        description: "Finalize exact evidence",
        paths: [],
      }],
    });
    engine.run.phase = "reviewing";
    const result = await new CodingRunCoordinator(
      engine,
      new QueueDriver([{ kind: "finalize" }]),
      { maxActions: 1 },
    ).run(SCOPE, engine.run.runId);

    assert.equal(result.outcome, "terminal");
    assert.equal(result.actions, 1);
    assert.equal(result.run.status, "completed");
  });

  it("membuktikan code.write sebelum worker dan menyembunyikan metadata kanal", async () => {
    const denied = new FakeCoordinatorEngine();
    denied.run.phase = "planning";
    denied.denyWriter = true;
    const deniedDriver = new QueueDriver([
      { kind: "yield", reasonCode: "should_not_run" },
    ]);
    await assert.rejects(
      new CodingRunCoordinator(denied, deniedDriver).run(SCOPE, denied.run.runId),
      /code\.write/iu,
    );
    assert.equal(deniedDriver.inputs.length, 0);

    const privateMetadata = new FakeCoordinatorEngine();
    privateMetadata.run.phase = "planning";
    privateMetadata.run.instructionRevision = 1;
    privateMetadata.run.appliedInstructionRevision = 1;
    privateMetadata.run.constraints = [{
      id: "constraint-private-1",
      sourceMessageId: "telegram:raw-message-sentinel-991",
      kind: "constraint",
      content: "Preserve the public API",
      instructionRevision: 1,
      receivedAt: NOW,
    }];
    privateMetadata.run.changeSets = [{
      instructionRevision: 1,
      sourceMessageId: "telegram:raw-message-sentinel-991",
      kind: "constraint",
      affectedStages: ["plan", "edits", "validators", "publish"],
      receivedAt: NOW,
    }];
    const privateDriver = new QueueDriver([
      { kind: "yield", reasonCode: "done_for_now" },
    ]);
    await new CodingRunCoordinator(privateMetadata, privateDriver).run(
      SCOPE,
      privateMetadata.run.runId,
    );
    const serialized = JSON.stringify(privateDriver.inputs[0]);
    assert.equal(serialized.includes("raw-message-sentinel"), false);
    assert.equal(serialized.includes("constraint-private-1"), false);
    assert.equal(serialized.includes("Preserve the public API"), true);
  });

  it("menolak coordinator kedua dan merekonsiliasi pending commit sebelum worker", async () => {
    const concurrent = new FakeCoordinatorEngine();
    concurrent.run.phase = "planning";
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateDriver: CodingWorkerDriver = {
      next: async () => {
        started();
        await releasePromise;
        return { kind: "yield", reasonCode: "gate_released" };
      },
    };
    const first = new CodingRunCoordinator(concurrent, gateDriver).run(
      SCOPE,
      concurrent.run.runId,
    );
    await startedPromise;
    await assert.rejects(
      new CodingRunCoordinator(concurrent, new QueueDriver([
        { kind: "yield", reasonCode: "duplicate" },
      ])).run(SCOPE, concurrent.run.runId),
      /sudah aktif/iu,
    );
    release();
    assert.equal((await first).outcome, "yielded");

    const recovering = new FakeCoordinatorEngine();
    recovering.run.status = "validating";
    recovering.run.phase = "finalizing";
    recovering.run.pendingCommit = {
      effectId: "pending-commit-1",
      instructionRevision: 0,
      sourceWorkspaceRevision: 1,
      workingSnapshot: "b".repeat(64),
      validatorEvidence: [{
        receiptId: "validator-test-1",
        kind: "test",
        commandDigest: "1".repeat(64),
        taskContractDigest: "2".repeat(64),
        sandboxOperationId: "sandbox-operation-1",
        sandboxRequestDigest: "3".repeat(64),
        sandboxExecutionId: "sandbox-execution-1",
      }],
      preparedAt: NOW,
    };
    const recoveryDriver = new QueueDriver([
      { kind: "yield", reasonCode: "must_not_run" },
    ]);
    const recovered = await new CodingRunCoordinator(
      recovering,
      recoveryDriver,
    ).run(SCOPE, recovering.run.runId);
    assert.equal(recovered.outcome, "terminal");
    assert.equal(recovering.recoveries, 1);
    assert.equal(recoveryDriver.inputs.length, 0);
  });

  it("menolak action stale dan berhenti jujur ketika commit masih ambigu", async () => {
    const stale = new FakeCoordinatorEngine();
    stale.run.phase = "planning";
    stale.mutateBeforePatch = true;
    await assert.rejects(
      new CodingRunCoordinator(stale, new QueueDriver([{
        kind: "apply_patch",
        operations: [{
          kind: "add",
          path: "src/new.ts",
          content: "export const value = 2;\n",
        }],
      }])).run(SCOPE, stale.run.runId),
      /state revision.*basi/iu,
    );
    assert.equal(stale.patches, 0);
    assert.equal(stale.run.status, "waiting_input");

    const pending = new FakeCoordinatorEngine();
    pending.run.status = "validating";
    pending.run.phase = "finalizing";
    pending.recoveryRemainsPending = true;
    pending.run.pendingCommit = {
      effectId: "pending-commit-ambiguous",
      instructionRevision: 0,
      sourceWorkspaceRevision: 1,
      workingSnapshot: "b".repeat(64),
      validatorEvidence: [{
        receiptId: "validator-test-ambiguous",
        kind: "test",
        commandDigest: "1".repeat(64),
        taskContractDigest: "2".repeat(64),
        sandboxOperationId: "sandbox-operation-ambiguous",
        sandboxRequestDigest: "3".repeat(64),
        sandboxExecutionId: "sandbox-execution-ambiguous",
      }],
      preparedAt: NOW,
    };
    const driver = new QueueDriver([{ kind: "yield", reasonCode: "must_not_run" }]);
    const result = await new CodingRunCoordinator(pending, driver).run(
      SCOPE,
      pending.run.runId,
    );
    assert.equal(result.outcome, "yielded");
    assert.equal(result.reasonCode, "commit_reconciliation_pending");
    assert.equal(result.run.status, "validating");
    assert.equal(driver.inputs.length, 0);
  });
});

class QueueDriver implements CodingWorkerDriver {
  readonly inputs: CodingWorkerInput[] = [];
  constructor(private readonly actions: CodingWorkerAction[]) {}

  async next(input: CodingWorkerInput): Promise<CodingWorkerAction> {
    this.inputs.push(structuredClone(input));
    const action = this.actions.shift();
    if (!action) throw new Error("Fake worker action habis.");
    return structuredClone(action);
  }
}

class RepeatingDriver implements CodingWorkerDriver {
  constructor(private readonly action: CodingWorkerAction) {}
  async next(): Promise<CodingWorkerAction> {
    return structuredClone(this.action);
  }
}

class FakeCoordinatorEngine implements CodingCoordinatorEngine {
  run = baseRun();
  mapped = 0;
  plans = 0;
  patches = 0;
  validators: CodingValidatorKind[] = [];
  reviews = 0;
  finalized = 0;
  secretRead = false;
  denyWriter = false;
  recoveries = 0;
  sandboxExecutions = 0;
  mutateBeforePatch = false;
  recoveryRemainsPending = false;

  async get(_scope: WorkspaceAgentScope, runId: string): Promise<CodingRun | null> {
    return runId === this.run.runId ? structuredClone(this.run) : null;
  }

  async writerTools(): Promise<CodingCoordinatorRepositoryTools> {
    if (this.denyWriter) throw new Error("Izin code.write workspace tidak tersedia.");
    return {
      tree: async () => ({
        items: [
          { path: "src", type: "directory" as const, size: null },
          { path: "src/index.ts", type: "file" as const, size: 24 },
        ],
        truncated: false,
      }),
      read: async (_revision, input) => ({
        path: input.path,
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        text: this.secretRead
          ? `github_pat_${"A".repeat(30)}`
          : "export const value = 1;\n",
        sha256: "a".repeat(64),
        truncated: false,
      }),
      search: async () => ({ items: [], truncated: false }),
      symbols: async () => ({ items: [], truncated: false }),
      references: async () => ({ items: [], truncated: false }),
      diff: async () => structuredClone(this.run.diff ?? emptyDiff()),
    };
  }

  async reserveCoordinatorDecision(
    _scope: WorkspaceAgentScope,
    _runId: string,
    expectedStateRevision: number,
  ): Promise<CodingRun> {
    assert.equal(expectedStateRevision, this.run.stateRevision);
    if (
      this.run.counters.coordinatorDecisions >=
        this.run.limits.maxCoordinatorDecisions
    ) throw new Error("CodingRun coordinator decision budget habis.");
    this.run = {
      ...this.run,
      stateRevision: this.run.stateRevision + 1,
      counters: {
        ...this.run.counters,
        coordinatorDecisions: this.run.counters.coordinatorDecisions + 1,
      },
    };
    return structuredClone(this.run);
  }

  async runCoordinatorDecision<T>(
    _scope: WorkspaceAgentScope,
    _runId: string,
    expectedStateRevision: number,
    _timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    assert.equal(expectedStateRevision, this.run.stateRevision);
    return operation(signal ?? new AbortController().signal);
  }

  async pauseCoordinator(
    _scope: WorkspaceAgentScope,
    _runId: string,
    _reasonCode: string,
  ): Promise<CodingRun> {
    if (this.run.status === "waiting_input") return structuredClone(this.run);
    this.run = {
      ...this.run,
      status: "waiting_input",
      phase: "waiting_input",
      stateRevision: this.run.stateRevision + 1,
    };
    return structuredClone(this.run);
  }

  async resumeCoordinator(): Promise<CodingRun> {
    if (this.run.status !== "waiting_input") return structuredClone(this.run);
    this.run = {
      ...this.run,
      status: "running",
      phase: this.run.repositoryMap
        ? this.run.plan ? "editing" : "planning"
        : "mapping",
      stateRevision: this.run.stateRevision + 1,
    };
    return structuredClone(this.run);
  }

  async markMapped(
    _scope: WorkspaceAgentScope,
    _runId: string,
    expectedInstructionRevision: number,
  ): Promise<CodingRun> {
    assert.equal(expectedInstructionRevision, this.run.instructionRevision);
    this.mapped += 1;
    this.run = {
      ...this.run,
      phase: "planning",
      stateRevision: this.run.stateRevision + 1,
      repositoryMap: {
        instructionRevision: 0,
        workingSnapshot: "a".repeat(64),
        treeDigest: "b".repeat(64),
        symbolDigest: "c".repeat(64),
        entryCount: 2,
        symbolCount: 0,
        treeComplete: true,
        symbolsComplete: true,
        mapDigest: "d".repeat(64),
        completedAt: NOW,
      },
    };
    return structuredClone(this.run);
  }

  async recordPlan(
    _scope: WorkspaceAgentScope,
    _runId: string,
    expectedInstructionRevision: number,
    input: { steps: Array<{ stage: "inspect" | "edit" | "test" | "review"; description: string; paths: string[] }> },
    expectedStateRevision?: number,
  ): Promise<CodingRun> {
    assert.equal(expectedInstructionRevision, this.run.instructionRevision);
    if (expectedStateRevision !== undefined) {
      assert.equal(expectedStateRevision, this.run.stateRevision);
    }
    this.plans += 1;
    this.run = {
      ...this.run,
      phase: "editing",
      stateRevision: this.run.stateRevision + 1,
      plan: {
        revision: 1,
        instructionRevision: 0,
        repositoryMapDigest: this.run.repositoryMap!.mapDigest,
        taskContractDigest: "e".repeat(64),
        steps: input.steps.map((step, index) => ({
          stepId: `step-${index + 1}`,
          ...structuredClone(step),
        })),
        planDigest: "f".repeat(64),
        createdAt: NOW,
      },
    };
    return structuredClone(this.run);
  }

  async applyPatch(
    _scope: WorkspaceAgentScope,
    _runId: string,
    expectedInstructionRevision: number,
    operations: readonly StructuredPatchOperation[],
    expectedStateRevision?: number,
  ): Promise<{ run: CodingRun; diff: CodingRun["diff"] }> {
    assert.equal(expectedInstructionRevision, this.run.instructionRevision);
    if (this.mutateBeforePatch) {
      this.run = { ...this.run, stateRevision: this.run.stateRevision + 1 };
    }
    if (
      expectedStateRevision !== undefined &&
      expectedStateRevision !== this.run.stateRevision
    ) throw new Error("State revision CodingRun sudah basi untuk action coordinator.");
    assert.equal(operations.length, 1);
    this.patches += 1;
    const diff = changedDiff();
    this.run = {
      ...this.run,
      diff,
      stateRevision: this.run.stateRevision + 1,
      counters: { ...this.run.counters, patches: 1 },
    };
    return { run: structuredClone(this.run), diff: structuredClone(diff) };
  }

  async executeSandbox(
    _scope: WorkspaceAgentScope,
    _runId: string,
    expectedInstructionRevision: number,
    request: SandboxExecRequest,
    _signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<SandboxExecResult> {
    assert.equal(expectedInstructionRevision, this.run.instructionRevision);
    if (expectedStateRevision !== undefined) {
      assert.equal(expectedStateRevision, this.run.stateRevision);
    }
    this.sandboxExecutions += 1;
    this.run = {
      ...this.run,
      stateRevision: this.run.stateRevision + 1,
      counters: {
        ...this.run.counters,
        sandboxCalls: this.run.counters.sandboxCalls + 1,
      },
    };
    return {
      operationId: `sandbox-operation-${this.sandboxExecutions}`,
      requestDigest: "9".repeat(64),
      executionId: `sandbox-execution-${this.sandboxExecutions}`,
      leaseId: `sandbox-lease-${this.sandboxExecutions}`,
      status: "exited",
      exitCode: 0,
      signal: null,
      stdout: `${request.argv[0]} completed`,
      stderr: "",
      truncated: false,
      artifacts: [],
      usage: {
        wallClockMs: 10,
        peakMemoryBytes: 1_024,
        cpuTimeMs: 5,
        outputBytes: 12,
      },
      startedAt: NOW,
      completedAt: NOW,
    };
  }

  async runValidator(
    _scope: WorkspaceAgentScope,
    _runId: string,
    expectedInstructionRevision: number,
    kind: CodingValidatorKind,
    _signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<{ run: CodingRun; receipt: CodingValidatorReceipt }> {
    assert.equal(expectedInstructionRevision, this.run.instructionRevision);
    if (expectedStateRevision !== undefined) {
      assert.equal(expectedStateRevision, this.run.stateRevision);
    }
    this.validators.push(kind);
    const receipt: CodingValidatorReceipt = {
      receiptId: `validator-${kind}-1`,
      kind,
      status: "passed",
      instructionRevision: 0,
      workingSnapshot: changedDiff().workingSnapshot,
      commandDigest: "1".repeat(64),
      taskContractDigest: "2".repeat(64),
      sandboxOperationId: "sandbox-operation-1",
      sandboxRequestDigest: "3".repeat(64),
      sandboxExecutionId: "sandbox-execution-1",
      exitCode: 0,
      evidenceArtifactIds: [],
      completedAt: NOW,
    };
    this.run = {
      ...this.run,
      phase: "reviewing",
      validatorReceipts: [...this.run.validatorReceipts, receipt],
      stateRevision: this.run.stateRevision + 1,
    };
    return { run: structuredClone(this.run), receipt };
  }

  async runTaskReview(
    _scope?: WorkspaceAgentScope,
    _runId?: string,
    _expectedInstructionRevision?: number,
    _signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<{
    run: CodingRun;
    receipt: CodingTaskReviewReceipt;
  }> {
    if (expectedStateRevision !== undefined) {
      assert.equal(expectedStateRevision, this.run.stateRevision);
    }
    this.reviews += 1;
    const receipt: CodingTaskReviewReceipt = {
      receiptId: "task-review-1",
      status: "approved",
      instructionRevision: 0,
      workingSnapshot: changedDiff().workingSnapshot,
      diffDigest: "4".repeat(64),
      taskContractDigest: "2".repeat(64),
      policyDigest: "5".repeat(64),
      repositoryMapDigest: this.run.repositoryMap!.mapDigest,
      planDigest: this.run.plan!.planDigest,
      requirementEvidence: [],
      publicApi: "preserved",
      unrelatedChanges: "minimized",
      completedAt: NOW,
    };
    this.run = {
      ...this.run,
      taskReviewReceipts: [...(this.run.taskReviewReceipts ?? []), receipt],
      stateRevision: this.run.stateRevision + 1,
    };
    return { run: structuredClone(this.run), receipt };
  }

  async finalize(
    _scope?: WorkspaceAgentScope,
    _runId?: string,
    _expectedInstructionRevision?: number,
    expectedStateRevision?: number,
  ): Promise<CodingRun> {
    if (expectedStateRevision !== undefined) {
      assert.equal(expectedStateRevision, this.run.stateRevision);
    }
    this.finalized += 1;
    this.run = {
      ...this.run,
      status: "completed",
      phase: "completed",
      stateRevision: this.run.stateRevision + 1,
      result: {
        instructionRevision: 0,
        projectRevision: 2,
        snapshotId: changedDiff().workingSnapshot,
        changedFiles: 1,
        validators: [{
          kind: "test",
          status: "passed",
          sandboxOperationId: "sandbox-operation-1",
          sandboxRequestDigest: "3".repeat(64),
          sandboxExecutionId: "sandbox-execution-1",
        }],
        taskReview: {
          receiptId: "task-review-1",
          policyDigest: "5".repeat(64),
          repositoryMapDigest: this.run.repositoryMap!.mapDigest,
          planDigest: this.run.plan!.planDigest,
        },
        completedAt: NOW,
      },
      completedAt: NOW,
    };
    return structuredClone(this.run);
  }

  async recoverPendingCommit(): Promise<CodingRun> {
    if (!this.run.pendingCommit) throw new Error("Pending commit tidak tersedia.");
    this.recoveries += 1;
    if (this.recoveryRemainsPending) return structuredClone(this.run);
    this.run = {
      ...this.run,
      status: "completed",
      phase: "completed",
      pendingCommit: null,
      completedAt: NOW,
      stateRevision: this.run.stateRevision + 1,
    };
    return structuredClone(this.run);
  }
}

function baseRun(): CodingRun {
  return {
    version: 2,
    runId: "coding-run-coordinator-1",
    binding: {
      projectId: "project-coordinator-1",
      ownerWorkspaceKey: SCOPE.workspaceKey,
      workspaceRevision: 1,
      baseSnapshot: "a".repeat(64),
    },
    taskBrief: {
      request: "Update value",
      objective: "Value is two",
      acceptanceCriteria: ["Test passes"],
      initialConstraints: [],
    },
    status: "running",
    phase: "mapping",
    instructionRevision: 0,
    appliedInstructionRevision: 0,
    stateRevision: 0,
    workingCopyId: "working-copy-coordinator",
    writer: {
      writerId: "writer-coordinator",
      acquiredAt: NOW,
      expiresAt: "2026-08-11T11:15:00.000Z",
    },
    constraints: [],
    changeSets: [],
    events: [],
    validatorReceipts: [],
    taskReviewReceipts: [],
    repositoryMap: null,
    plan: null,
    diff: null,
    limits: {
      maxPatches: 8,
      maxSandboxCalls: 8,
      maxChangedFiles: 32,
      maxChangedBytes: 1_000_000,
      maxActiveMs: 60_000,
      maxCoordinatorDecisions: 64,
    },
    counters: {
      patches: 0,
      sandboxCalls: 0,
      activeElapsedMs: 0,
      coordinatorDecisions: 0,
    },
    pendingCommit: null,
    commitReceipts: [],
    result: null,
    lastError: null,
    createdAt: NOW,
    startedAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    expiresAt: "2026-08-18T11:00:00.000Z",
  };
}

function emptyDiff() {
  return {
    baseSnapshot: "a".repeat(64),
    workingSnapshot: "a".repeat(64),
    files: [],
    addedBytes: 0,
    removedBytes: 0,
    generatedAt: NOW,
  };
}

function changedDiff() {
  return {
    baseSnapshot: "a".repeat(64),
    workingSnapshot: "b".repeat(64),
    files: [{
      path: "src/index.ts",
      status: "modified" as const,
      beforeSha256: "a".repeat(64),
      afterSha256: "b".repeat(64),
      beforeSize: 24,
      afterSize: 24,
      binary: false,
    }],
    addedBytes: 1,
    removedBytes: 1,
    generatedAt: NOW,
  };
}
