import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  startGroupAgentRunCleanupWorker,
} from "../src/core/group-agent-run-cleanup-worker.js";
import type { GroupAgentRunCleanupRecoveryResult } from
  "../src/core/group-agent-run-cleanup-service.js";
import type { OperationalLogger } from
  "../src/observability/operational-logger.js";

const EMPTY: GroupAgentRunCleanupRecoveryResult = {
  attempted: 0,
  completed: 0,
  pending: 0,
};

describe("GroupAgentRun cleanup worker", () => {
  it("menjalankan pass startup yang bisa di-await, coalesce, stop, dan drain", async () => {
    const started = deferred<void>();
    const release = deferred<GroupAgentRunCleanupRecoveryResult>();
    let calls = 0;
    const worker = startGroupAgentRunCleanupWorker({
      recoverPending: async () => {
        calls += 1;
        started.resolve();
        return release.promise;
      },
    }, undefined, 60_000);

    await started.promise;
    const joined = worker.runNow();
    assert.equal(calls, 1);
    worker.stop();
    const drained = worker.drain();
    let didDrain = false;
    void drained.then(() => {
      didDrain = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(didDrain, false);

    const result = { attempted: 2, completed: 1, pending: 1 };
    release.resolve(result);
    assert.deepEqual(await worker.ready(), result);
    assert.deepEqual(await joined, result);
    await drained;
    assert.deepEqual(await worker.runNow(), EMPTY);
    assert.equal(calls, 1);
  });

  it("readiness mempropagasi kegagalan startup dan putaran berikutnya dapat pulih", async () => {
    const errors: Array<{ event: string; error: unknown }> = [];
    let calls = 0;
    const worker = startGroupAgentRunCleanupWorker({
      recoverPending: () => {
        calls += 1;
        if (calls === 1) throw new Error("private-target@g.us");
        return Promise.resolve(EMPTY);
      },
    }, {
      error: (event: string, _message: string, error: unknown) => {
        errors.push({ event, error });
      },
    } as unknown as OperationalLogger, 60_000);

    try {
      await assert.rejects(worker.ready(), /private-target/iu);
      assert.deepEqual(await worker.runNow(), EMPTY);
      assert.equal(calls, 2);
      assert.equal(errors[0]?.event, "group_agent_run_cleanup_recovery_failed");
      assert.equal(
        errors[0]?.error instanceof Error
          ? errors[0].error.message.includes("private-target")
          : true,
        false,
      );
    } finally {
      worker.stop();
      await worker.drain();
    }
  });

  it("menolak interval tidak sah", () => {
    assert.throws(
      () => startGroupAgentRunCleanupWorker({
        recoverPending: async () => EMPTY,
      }, undefined, 0),
      /interval cleanup GroupAgentRun tidak sah/iu,
    );
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
