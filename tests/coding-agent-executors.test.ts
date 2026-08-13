import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCodingAgentExecutorBundle,
  type CodingAgentExecutorDependencies,
} from "../src/agent/coding-executors.js";
import type { StructuredPatchOperation } from "../src/coding/repository-tools.js";
import type {
  CodingDiffSummary,
  CodingRun,
} from "../src/domain/coding-run.js";
import type { SandboxExecResult } from "../src/domain/sandbox.js";
import {
  AgentHarness,
  type AgentExecutionContext,
  type AgentCapabilityExecutor,
} from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { privateAgentScope, type WorkspaceAgentScope } from "../src/harness/scope.js";

const NOW = "2026-08-11T00:00:00.000Z";
const SHA = "a".repeat(64);

describe("coding agent executors G–I", () => {
  it("memasang capability hanya dari executor nyata dan health sandbox positif", async () => {
    const fixture = fakeCodingDependencies();
    const unhealthy = await createCodingAgentExecutorBundle({
      engine: fixture.engine,
      sandboxHealth: async () => {
        throw new Error("runner offline");
      },
    });
    assert.equal(unhealthy.catalogOptions.codingWorkspaceInstalled, true);
    assert.equal(unhealthy.catalogOptions.sandboxRunnerInstalled, false);
    assert.equal(unhealthy.catalogOptions.localGitInstalled, false);
    assert.equal(unhealthy.executors.some((value) => value.capabilityId === "sandbox.exec"), false);

    const stalled = await createCodingAgentExecutorBundle({
      engine: fixture.engine,
      healthTimeoutMs: 5,
      sandboxHealth: async () => {
        const deadline = performance.now() + 20;
        while (performance.now() < deadline) {
          // Model an adapter that blocks the event loop past the watchdog.
        }
        return {
          available: true,
          runtime: "isolated-linux" as const,
          checkedAt: NOW,
          reason: null,
        };
      },
    });
    assert.equal(stalled.catalogOptions.sandboxRunnerInstalled, false);
    assert.equal(stalled.sandboxHealth?.available, false);

    const unhealthyGit = await createCodingAgentExecutorBundle({
      engine: fixture.engine,
      localGit: {
        ...fixture.localGit,
        health: async () => ({
          available: false,
          protocol: null,
          checkedAt: NOW,
          reason: "runner unavailable",
        }),
      },
    });
    assert.equal(unhealthyGit.catalogOptions.localGitInstalled, false);
    assert.equal(unhealthyGit.localGitHealth?.available, false);

    const healthy = await createCodingAgentExecutorBundle({
      engine: fixture.engine,
      localGit: fixture.localGit,
      sandboxHealth: async () => ({
        available: true,
        runtime: "isolated-linux",
        checkedAt: NOW,
        reason: null,
      }),
    });
    assert.equal(healthy.catalogOptions.sandboxRunnerInstalled, true);
    assert.equal(healthy.catalogOptions.localGitInstalled, true);
    assert.deepEqual(
      new Set(healthy.executors.map((value) => value.capabilityId)),
      new Set([
        "workspace.tree",
        "workspace.read",
        "workspace.search",
        "workspace.symbols",
        "workspace.references",
        "workspace.diff",
        "workspace.apply_patch",
        "sandbox.exec",
        "sandbox.test",
        "git.status",
        "git.diff",
        "git.log",
        "git.commit",
      ]),
    );
  });

  it("menolak schema longgar, scope non-workspace, dan state run basi", async () => {
    const fixture = fakeCodingDependencies();
    const bundle = await createCodingAgentExecutorBundle({ engine: fixture.engine });
    const read = named(bundle.executors, "workspace.read");
    assert.equal(read.validate({
      runId: "coding-run-1",
      instructionRevision: 0,
      stateRevision: 4,
      path: "src/app.ts",
      credential: "tidak-boleh",
    }).ok, false);
    const patch = named(bundle.executors, "workspace.apply_patch");
    assert.equal(patch.validate({
      runId: "coding-run-1",
      instructionRevision: 0,
      stateRevision: 4,
      operations: [{
        kind: "update",
        path: "src/app.ts",
        expectedSha256: SHA,
        content: "baru",
        force: true,
      }],
    }).ok, false);

    const validated = read.validate({
      runId: "coding-run-1",
      instructionRevision: 0,
      stateRevision: 4,
      path: "src/app.ts",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const denied = await read.execute(validated.value, directContext(privateAgentScope("telegram", "1")));
    assert.equal(denied.status, "error");
    assert.equal(JSON.parse(denied.summary).code, "workspace_scope_required");

    const staleValidation = read.validate({
      runId: "coding-run-1",
      instructionRevision: 0,
      stateRevision: 3,
      path: "src/app.ts",
    });
    assert.equal(staleValidation.ok, true);
    if (!staleValidation.ok) return;
    const stale = await read.execute(staleValidation.value, directContext(workspaceScope()));
    assert.equal(stale.status, "error");
    assert.deepEqual(JSON.parse(stale.summary), {
      kind: "coding_executor.error",
      capabilityId: "workspace.read",
      code: "coding_run_state_stale",
      currentInstructionRevision: 0,
      currentStateRevision: 4,
    });
  });

  it("menghasilkan observation berbatas dan memakai state token baru setelah patch", async () => {
    const fixture = fakeCodingDependencies();
    const bundle = await createCodingAgentExecutorBundle({ engine: fixture.engine });
    const read = named(bundle.executors, "workspace.read");
    const first = await executeValidated(read, {
      runId: "coding-run-1",
      instructionRevision: 0,
      stateRevision: 4,
      path: "src/app.ts",
    });
    assert.equal(first.status, "ok");
    assert.ok(first.summary.length <= 3_600);
    const firstValue = JSON.parse(first.summary);
    assert.equal(firstValue.treatAsInstructions, false);
    assert.equal(firstValue.observationTruncated, true);

    const patch = named(bundle.executors, "workspace.apply_patch");
    const patched = await executeValidated(patch, {
      runId: "coding-run-1",
      instructionRevision: 0,
      stateRevision: 4,
      operations: [{ kind: "add", path: "src/new.ts", content: "export {};\n" }],
    });
    assert.equal(patched.status, "ok");
    assert.equal(JSON.parse(patched.summary).run.stateRevision, 5);

    const reread = await executeValidated(read, {
      runId: "coding-run-1",
      instructionRevision: 0,
      stateRevision: 5,
      path: "src/app.ts",
    });
    assert.equal(reread.status, "ok");
  });

  it("AgentHarness tidak salah mendeteksi siklus saat read diulang setelah patch", async () => {
    const fixture = fakeCodingDependencies();
    const bundle = await createCodingAgentExecutorBundle({ engine: fixture.engine });
    const harness = new AgentHarness(
      createHarvyCapabilityCatalog({
        activeSurfaces: ["workspace:telegram"],
        ...bundle.catalogOptions,
      }),
      { isCurrent: () => true },
    );
    const result = await harness.run({
      scope: workspaceScope(),
      request: "ubah project lalu baca ulang",
      executors: bundle.executors,
      isCurrent: () => true,
      policy: () => ({ decision: "allow" }),
      planner: async ({ observations }) => {
        if (observations.length === 0) {
          return {
            kind: "action" as const,
            capabilityId: "workspace.read",
            capabilityVersion: "1",
            input: runInput(4, { path: "src/app.ts" }),
          };
        }
        if (observations.length === 1) {
          return {
            kind: "action" as const,
            capabilityId: "workspace.apply_patch",
            capabilityVersion: "1",
            input: runInput(4, {
              operations: [{ kind: "add", path: "src/new.ts", content: "export {};\n" }],
            }),
          };
        }
        if (observations.length === 2) {
          return {
            kind: "action" as const,
            capabilityId: "workspace.read",
            capabilityVersion: "1",
            input: runInput(5, { path: "src/app.ts" }),
          };
        }
        return { kind: "final" as const, reply: "Selesai." };
      },
      now: () => new Date(NOW),
      makeRunId: () => "agent-coding-loop-1",
    });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(
      result.checkpoint.observations.map((value) => value.capabilityId),
      ["workspace.read", "workspace.apply_patch", "workspace.read"],
    );
  });

  it("git.commit tidak menerima branch/message/force dari model", async () => {
    const fixture = fakeCodingDependencies();
    const bundle = await createCodingAgentExecutorBundle({
      engine: fixture.engine,
      localGit: fixture.localGit,
    });
    const commit = named(bundle.executors, "git.commit");
    assert.equal(commit.validate({
      projectId: "project-1",
      expectedRevision: 2,
      branch: "main",
      force: true,
    }).ok, false);
    const result = await executeValidated(commit, {
      projectId: "project-1",
      expectedRevision: 2,
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(fixture.commitCalls, [{ projectId: "project-1", revision: 2 }]);
  });

  it("memblokir credential dari observation sandbox sebelum mencapai planner", async () => {
    const fixture = fakeCodingDependencies();
    fixture.setSandboxOutput(`AWS_SECRET_ACCESS_KEY=${"Z".repeat(40)}`);
    const bundle = await createCodingAgentExecutorBundle({
      engine: fixture.engine,
      sandboxHealth: async () => ({
        available: true,
        runtime: "isolated-linux",
        checkedAt: NOW,
        reason: null,
      }),
    });
    const execute = named(bundle.executors, "sandbox.exec");
    const result = await executeValidated(execute, runInput(4, {
      request: {
        argv: ["npm", "test"],
        cwd: ".",
        purpose: "test",
        timeoutMs: 30_000,
      },
    }));
    assert.equal(result.status, "error");
    assert.equal(JSON.parse(result.summary).code, "sensitive_observation_blocked");
    assert.equal(result.summary.includes("AWS_SECRET_ACCESS_KEY"), false);
  });
});

function fakeCodingDependencies(): {
  engine: CodingAgentExecutorDependencies["engine"];
  localGit: NonNullable<CodingAgentExecutorDependencies["localGit"]>;
  commitCalls: Array<{ projectId: string; revision: number }>;
  setSandboxOutput(value: string): void;
} {
  let run = fakeRun(4);
  let sandboxOutput = "ok";
  const diff = fakeDiff();
  const tools = {
    tree: async () => [{ path: "src", type: "directory", size: null }],
    read: async () => ({
      path: "src/app.ts",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      text: "x".repeat(12_000),
      sha256: SHA,
      truncated: false,
    }),
    search: async () => [{ path: "src/app.ts", line: 1, column: 1, preview: "export" }],
    symbols: async () => [{ path: "src/app.ts", line: 1, kind: "function", name: "main" }],
    references: async () => [{ path: "src/app.ts", line: 1, column: 1, preview: "main" }],
    diff: async () => diff,
  };
  const engine = {
    get: async (_scope: WorkspaceAgentScope, runId: string) =>
      runId === run.runId ? structuredClone(run) : null,
    readOnlyWorkerTools: async () => tools,
    applyPatch: async (
      _scope: WorkspaceAgentScope,
      _runId: string,
      _instructionRevision: number,
      _operations: readonly StructuredPatchOperation[],
    ) => {
      run = fakeRun(run.stateRevision + 1);
      return { run: structuredClone(run), diff };
    },
    executeSandbox: async () => {
      run = fakeRun(run.stateRevision + 1);
      return { ...fakeSandboxResult(), stdout: sandboxOutput };
    },
    runValidator: async () => ({
      run: structuredClone(run),
      receipt: {
        receiptId: "validator-1",
        kind: "test" as const,
        status: "passed" as const,
        instructionRevision: 0,
        workingSnapshot: diff.workingSnapshot,
        commandDigest: SHA,
        taskContractDigest: SHA,
        sandboxOperationId: "operation-1",
        sandboxRequestDigest: SHA,
        sandboxExecutionId: "execution-1",
        exitCode: 0,
        evidenceArtifactIds: [],
        completedAt: NOW,
      },
    }),
  } as unknown as CodingAgentExecutorDependencies["engine"];
  const commitCalls: Array<{ projectId: string; revision: number }> = [];
  const localGit = {
    health: async () => ({
      available: true,
      protocol: "harvy-local-git/1" as const,
      checkedAt: NOW,
      reason: null,
    }),
    status: async () => ({
      binding: gitBinding(),
      changedPaths: [],
      clean: true,
    }),
    diff: async () => ({ textArtifactId: "artifact-git-diff", sha256: SHA }),
    log: async () => [],
    commit: async (_scope: WorkspaceAgentScope, projectId: string, revision: number) => {
      commitCalls.push({ projectId, revision });
      return {
        projectRevision: revision + 1,
        receipt: {
          operationId: "local-git-op-1",
          projectId,
          snapshotId: "snapshot-2",
          sourceWorkspaceRevision: revision,
          branch: "harvy/project-1",
          parentCommit: "1".repeat(40),
          commit: "2".repeat(40),
          treeHash: "3".repeat(40),
          objectBundle: {
            version: 1 as const,
            artifactId: `git-bundle-${SHA}`,
            sha256: SHA,
            size: 1,
            mediaType: "application/vnd.git.bundle" as const,
            commit: "2".repeat(40),
            parentCommit: "1".repeat(40),
            treeHash: "3".repeat(40),
          },
          authorName: "Harvy Bot" as const,
          authorEmail: "bot@harvy.local" as const,
          committedAt: NOW,
        },
      };
    },
  } as unknown as NonNullable<CodingAgentExecutorDependencies["localGit"]>;
  return {
    engine,
    localGit,
    commitCalls,
    setSandboxOutput(value: string) {
      sandboxOutput = value;
    },
  };
}

function fakeRun(stateRevision: number): CodingRun {
  return {
    version: 2,
    runId: "coding-run-1",
    instructionRevision: 0,
    stateRevision,
  } as unknown as CodingRun;
}

function fakeDiff(): CodingDiffSummary {
  return {
    baseSnapshot: "b".repeat(64),
    workingSnapshot: "c".repeat(64),
    files: [{
      path: "src/new.ts",
      status: "added",
      beforeSha256: null,
      afterSha256: SHA,
      beforeSize: null,
      afterSize: 11,
      binary: false,
    }],
    addedBytes: 11,
    removedBytes: 0,
    generatedAt: NOW,
  };
}

function fakeSandboxResult(): SandboxExecResult {
  return {
    operationId: "operation-1",
    requestDigest: "d".repeat(64),
    executionId: "execution-1",
    leaseId: "lease-1",
    status: "exited",
    exitCode: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    truncated: false,
    artifacts: [],
    usage: {
      wallClockMs: 1,
      peakMemoryBytes: 1,
      cpuTimeMs: 1,
      outputBytes: 2,
    },
    startedAt: NOW,
    completedAt: NOW,
  };
}

function gitBinding() {
  return {
    projectId: "project-1",
    snapshotId: "snapshot-2",
    workspaceRevision: 2,
    baseCommit: "1".repeat(40),
    headCommit: "1".repeat(40),
    branch: "main",
  };
}

function workspaceScope(): WorkspaceAgentScope {
  return {
    kind: "workspace",
    channel: "telegram",
    workspaceKey: "workspace-1",
    principalKey: "principal-1",
    membershipId: "membership-1",
    role: "owner",
    aclEpoch: 1,
    permissions: ["code.read", "code.write", "sandbox.execute", "git.commit"],
    conversationKey: "workspace:conversation",
    sharedMemoryKey: "workspace:memory",
    artifactKey: "workspace:artifact",
    authorityKey: "workspace:authority:1",
  };
}

function directContext(scope: AgentExecutionContext["scope"]): AgentExecutionContext {
  return {
    runId: "agent-run-1",
    step: 0,
    scope,
    idempotencyKey: "idempotency-1",
    signal: new AbortController().signal,
    runBudget: {} as AgentExecutionContext["runBudget"],
  };
}

function named(
  executors: readonly AgentCapabilityExecutor[],
  capabilityId: string,
): AgentCapabilityExecutor {
  const value = executors.find((executor) => executor.capabilityId === capabilityId);
  assert.ok(value, `Executor ${capabilityId} wajib tersedia.`);
  return value;
}

async function executeValidated(
  executor: AgentCapabilityExecutor,
  input: unknown,
) {
  const validated = executor.validate(input);
  if (!validated.ok) assert.fail(validated.reason);
  return executor.execute(validated.value, directContext(workspaceScope()));
}

function runInput(
  stateRevision: number,
  extra: Readonly<Record<string, unknown>>,
) {
  return {
    runId: "coding-run-1",
    instructionRevision: 0,
    stateRevision,
    ...extra,
  };
}
