import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type GroupAgentRunLifecyclePort,
  startGroupAgentRunRetentionWorker,
} from "../src/core/group-agent-run-retention-worker.js";
import type { OperationalLogger } from "../src/observability/operational-logger.js";

describe("group agent run retention worker", () => {
  it("memulai recovery segera, tidak overlap, dan drain menunggu purge aktif", async () => {
    const recoveryGate = deferred<void>();
    const purgeGate = deferred<void>();
    const recoveryStarted = deferred<void>();
    const purgeStarted = deferred<void>();
    const order: string[] = [];
    let recoveryCalls = 0;
    let purgeCalls = 0;
    const lifecycle: GroupAgentRunLifecyclePort = {
      recoverInterruptedRuns: async () => {
        recoveryCalls += 1;
        order.push("recover:start");
        recoveryStarted.resolve();
        await recoveryGate.promise;
        order.push("recover:end");
      },
      purgeExpired: async () => {
        purgeCalls += 1;
        order.push("purge:start");
        purgeStarted.resolve();
        await purgeGate.promise;
        order.push("purge:end");
        return 0;
      },
    };
    const worker = startGroupAgentRunRetentionWorker(
      lifecycle,
      undefined,
      60_000,
    );

    await recoveryStarted.promise;
    const joinedA = worker.runNow();
    const joinedB = worker.runNow();
    assert.equal(recoveryCalls, 1);
    assert.equal(purgeCalls, 0);

    recoveryGate.resolve();
    await purgeStarted.promise;
    assert.deepEqual(order, ["recover:start", "recover:end", "purge:start"]);
    worker.stop();
    const drained = worker.drain();
    let drainCompleted = false;
    void drained.then(() => {
      drainCompleted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drainCompleted, false);

    purgeGate.resolve();
    await Promise.all([joinedA, joinedB, drained]);
    assert.equal(recoveryCalls, 1);
    assert.equal(purgeCalls, 1);
    assert.deepEqual(order, [
      "recover:start",
      "recover:end",
      "purge:start",
      "purge:end",
    ]);

    await worker.runNow();
    assert.equal(purgeCalls, 1);
  });

  it("menahan purge saat recovery gagal lalu mencoba setiap tahap lagi", async () => {
    let recoveryCalls = 0;
    let purgeCalls = 0;
    const errors: string[] = [];
    const infos: Array<{ event: string; removed?: number }> = [];
    const lifecycle: GroupAgentRunLifecyclePort = {
      recoverInterruptedRuns: async () => {
        recoveryCalls += 1;
        if (recoveryCalls === 1) throw new Error("recovery sementara gagal");
      },
      purgeExpired: async () => {
        purgeCalls += 1;
        if (purgeCalls === 1) throw new Error("purge sementara gagal");
        return 3;
      },
    };
    const logger = {
      info: (event: string, _message: string, fields?: { removed?: number }) => {
        infos.push(fields?.removed === undefined
          ? { event }
          : { event, removed: fields.removed });
      },
      error: (event: string) => {
        errors.push(event);
      },
    } as unknown as OperationalLogger;
    const worker = startGroupAgentRunRetentionWorker(
      lifecycle,
      logger,
      60_000,
    );

    try {
      // Bergabung dengan siklus startup: recovery pertama gagal dan purge
      // sengaja tidak dijalankan agar pending effect tidak hilang.
      await worker.runNow();
      assert.equal(recoveryCalls, 1);
      assert.equal(purgeCalls, 0);

      // Recovery berikutnya berhasil, lalu purge pertama gagal.
      await worker.runNow();
      assert.equal(recoveryCalls, 2);
      assert.equal(purgeCalls, 1);

      // Recovery tidak diulang setelah sukses; purge dicoba lagi.
      await worker.runNow();
      assert.equal(recoveryCalls, 2);
      assert.equal(purgeCalls, 2);
      assert.deepEqual(errors, [
        "group_agent_run_recovery_failed",
        "group_agent_run_retention_failed",
      ]);
      assert.deepEqual(infos, [
        { event: "group_agent_run_recovery_completed" },
        { event: "group_agent_run_retention_completed", removed: 3 },
      ]);
    } finally {
      worker.stop();
      await worker.drain();
    }
  });

  it("menolak interval yang tidak sah", () => {
    const lifecycle: GroupAgentRunLifecyclePort = {
      recoverInterruptedRuns: async () => undefined,
      purgeExpired: async () => 0,
    };
    assert.throws(
      () => startGroupAgentRunRetentionWorker(lifecycle, undefined, 0),
      /interval retensi GroupAgentRun tidak sah/iu,
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
