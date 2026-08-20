import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CodingRunScheduler,
  type CodingCoordinatorRunner,
  type CodingRunQuiescence,
} from "../src/core/coding-run-scheduler.js";
import type { CodingCoordinatorResult } from "../src/core/coding-run-coordinator.js";
import type { WorkspaceAgentScope } from "../src/harness/scope.js";

const SCOPE = scope("workspace-scheduler-a");
const NOW = new Date("2026-08-13T02:00:00.000Z");

describe("CodingRunScheduler", () => {
  it("membatasi admission global/per-workspace tanpa mengantre scope basi", async () => {
    const first = deferred<CodingCoordinatorResult>();
    const second = deferred<CodingCoordinatorResult>();
    const calls: Array<{ workspaceKey: string; runId: string; revision: number }> = [];
    const runner: CodingCoordinatorRunner = {
      run(scopeInput, runId, _signal, expectedStateRevision) {
        calls.push({
          workspaceKey: scopeInput.workspaceKey,
          runId,
          revision: expectedStateRevision ?? -1,
        });
        return runId === "run-a" ? first.promise : second.promise;
      },
    };
    const quiescence: CodingRunQuiescence = {
      async waitForRunQuiescence() {},
    };
    const scheduler = createScheduler(runner, quiescence, {
      maxConcurrent: 2,
      maxConcurrentPerWorkspace: 1,
    });
    scheduler.start();

    const a = scheduler.advance(SCOPE, {
      runId: "run-a",
      expectedStateRevision: 7,
    });
    await tick();
    await assert.rejects(
      scheduler.advance(SCOPE, { runId: "run-a", expectedStateRevision: 7 }),
      /invocation aktif/u,
    );
    await assert.rejects(
      scheduler.advance(SCOPE, { runId: "run-a-2", expectedStateRevision: 1 }),
      /Kapasitas workspace/u,
    );

    const b = scheduler.advance(scope("workspace-scheduler-b"), {
      runId: "run-b",
      expectedStateRevision: 9,
    });
    await tick();
    await assert.rejects(
      scheduler.advance(scope("workspace-scheduler-c"), {
        runId: "run-c",
        expectedStateRevision: 1,
      }),
      /Kapasitas global/u,
    );
    assert.deepEqual(calls, [
      { workspaceKey: "workspace-scheduler-a", runId: "run-a", revision: 7 },
      { workspaceKey: "workspace-scheduler-b", runId: "run-b", revision: 9 },
    ]);
    assert.deepEqual(scheduler.status(), {
      version: 1,
      state: "accepting",
      active: 2,
      activeWorkspaces: 2,
    });

    first.resolve(result());
    second.resolve(result());
    await Promise.all([a, b]);
    await tick();
    assert.equal(scheduler.status().active, 0);
  });

  it("stop mengabort invocation dan drain menunggu provider asli quiescent", async () => {
    const entered = deferred<void>();
    const providerSettled = deferred<void>();
    let observedAbort = false;
    const scheduler = createScheduler(
      {
        async run(_scope, _runId, signal) {
          entered.resolve(undefined);
          return new Promise<CodingCoordinatorResult>((_resolve, reject) => {
            const abort = () => {
              observedAbort = true;
              const error = new Error("coordinator aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        },
      },
      {
        async waitForRunQuiescence() {
          await providerSettled.promise;
        },
      },
      { drainTimeoutMs: 5_000 },
    );
    scheduler.start();
    const invocation = scheduler.advance(SCOPE, {
      runId: "run-abort",
      expectedStateRevision: 3,
    });
    await entered.promise;
    scheduler.stop();
    await assert.rejects(invocation, { name: "AbortError" });
    assert.equal(observedAbort, true);

    let drained = false;
    const draining = scheduler.drain().then(() => {
      drained = true;
    });
    await tick();
    assert.equal(drained, false);
    providerSettled.resolve(undefined);
    await draining;
    assert.deepEqual(scheduler.status(), {
      version: 1,
      state: "stopped",
      active: 0,
      activeWorkspaces: 0,
    });
    await assert.rejects(
      scheduler.advance(SCOPE, { runId: "run-late", expectedStateRevision: 1 }),
      /belum menerima admission/u,
    );
  });

  it("stop pada microtask admission mencegah coordinator diluncurkan", async () => {
    let calls = 0;
    const scheduler = createScheduler(
      {
        async run() {
          calls += 1;
          return result();
        },
      },
      { async waitForRunQuiescence() {} },
    );
    scheduler.start();
    const pending = scheduler.advance(SCOPE, {
      runId: "run-prelaunch",
      expectedStateRevision: 1,
    });
    scheduler.stop();

    await assert.rejects(pending, { name: "AbortError" });
    await scheduler.drain();
    assert.equal(calls, 0);
  });

  it("melatch kegagalan quiescence sehingga drain dan retry tetap fail-closed", async () => {
    const scheduler = createScheduler(
      {
        async run() {
          return result();
        },
      },
      {
        async waitForRunQuiescence() {
          throw new Error("provider quiescence unknown");
        },
      },
      { drainTimeoutMs: 5_000 },
    );
    scheduler.start();
    await scheduler.advance(SCOPE, {
      runId: "run-quiescence-failure",
      expectedStateRevision: 1,
    });
    await tick();
    assert.equal(scheduler.status().active, 1);

    await assert.rejects(scheduler.drain(), /Quiescence CodingRun/u);
    await assert.rejects(scheduler.drain(), /Quiescence CodingRun/u);
    assert.equal(scheduler.status().state, "stopping");
    assert.equal(scheduler.status().active, 1);
  });

  it("lifecycle fence hanya mengabort exact workspace dan menunggu quiescence", async () => {
    const entered = deferred<void>();
    const providerSettled = deferred<void>();
    let aborted = false;
    const scheduler = createScheduler(
      {
        async run(_scope, _runId, signal) {
          entered.resolve(undefined);
          return new Promise<CodingCoordinatorResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              const error = new Error("authority fenced");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        },
      },
      { async waitForRunQuiescence() { await providerSettled.promise; } },
    );
    scheduler.start();
    const invocation = scheduler.advance(SCOPE, {
      runId: "run-authority-fence",
      expectedStateRevision: 1,
    });
    await entered.promise;

    await scheduler.interruptByBinding(
      "workspace-scheduler-other",
      "run-authority-fence",
    );
    assert.equal(aborted, false);
    let fenceSettled = false;
    const fence = scheduler.interruptByBinding(
      SCOPE.workspaceKey,
      "run-authority-fence",
    ).then(() => {
      fenceSettled = true;
    });
    await assert.rejects(invocation, { name: "AbortError" });
    await tick();
    assert.equal(aborted, true);
    assert.equal(fenceSettled, false);
    providerSettled.resolve(undefined);
    await fence;
    assert.equal(scheduler.status().active, 0);
  });

  it("health tanpa deployment conformance tidak pernah membuka admission", async () => {
    const scheduler = new CodingRunScheduler(
      { async run() { return result(); } },
      { async waitForRunQuiescence() {} },
    );
    assert.throws(
      () => scheduler.start(),
      /conformance receipt terverifikasi/u,
    );
    assert.equal(scheduler.status().state, "idle");
  });

  it("menutup admission ketika conformance receipt kedaluwarsa setelah start", async () => {
    let now = NOW;
    const scheduler = createScheduler(
      { async run() { return result(); } },
      { async waitForRunQuiescence() {} },
      {},
      () => now,
    );
    scheduler.start();
    now = new Date("2026-08-14T01:00:00.001Z");

    await assert.rejects(
      scheduler.advance(SCOPE, { runId: "run-expired", expectedStateRevision: 1 }),
      /kedaluwarsa/u,
    );
    assert.equal(scheduler.status().state, "stopped");
  });
});

function createScheduler(
  runner: CodingCoordinatorRunner,
  quiescence: CodingRunQuiescence,
  options: ConstructorParameters<typeof CodingRunScheduler>[2] = {},
  now: () => Date = () => NOW,
): CodingRunScheduler {
  return new CodingRunScheduler(
    runner,
    quiescence,
    options,
    {
      version: 1,
      serviceIdentityDigest: "1".repeat(64),
      runtimeImageDigest: "2".repeat(64),
      policyDigest: "3".repeat(64),
      suiteDigest: "4".repeat(64),
      verifiedAt: "2026-08-13T01:00:00.000Z",
      expiresAt: "2026-08-14T01:00:00.000Z",
    },
    now,
    {
      verify(receipt, at) {
        assert.equal(receipt.serviceIdentityDigest, "1".repeat(64));
        assert.ok(Date.parse(receipt.expiresAt) > at.getTime());
      },
    },
  );
}

function scope(workspaceKey: string): WorkspaceAgentScope {
  return {
    kind: "workspace",
    channel: "telegram",
    workspaceKey,
    principalKey: `${workspaceKey}-principal`,
    membershipId: `${workspaceKey}-membership`,
    aclEpoch: 1,
    role: "owner",
    permissions: ["code.read", "code.write", "run.create", "sandbox.execute"],
    conversationKey: `${workspaceKey}-conversation`,
    authorityKey: `${workspaceKey}-authority`,
    sharedMemoryKey: `${workspaceKey}-memory`,
    artifactKey: `${workspaceKey}-artifact`,
  };
}

function result(): CodingCoordinatorResult {
  return {
    outcome: "yielded",
    actions: 1,
    reasonCode: "test_yield",
    run: {} as CodingCoordinatorResult["run"],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
