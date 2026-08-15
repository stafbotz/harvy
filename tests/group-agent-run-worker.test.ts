import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  startGroupAgentRunWorker,
  type GroupAgentRunWorkerLease,
} from "../src/core/group-agent-run-worker.js";
import type { OperationalLogger } from
  "../src/observability/operational-logger.js";

describe("GroupAgentRun worker coordinator", () => {
  it("mencoalesce duplicate wake sebelum invocation menjadi satu task", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: async () => [],
      processRun: async () => {
        calls += 1;
        started.resolve(undefined);
        await release.promise;
      },
      onProcessFailure: terminalFailure,
    }, { maxConcurrency: 1 });

    assert.equal(worker.wake("run-duplicate"), "scheduled");
    assert.equal(worker.wake("run-duplicate"), "coalesced");
    await started.promise;
    assert.equal(calls, 1);

    release.resolve(undefined);
    await worker.drain();
    assert.equal(calls, 1);
  });

  it("membatasi concurrency global tanpa menjalankan dua task untuk run sama", async () => {
    const releases = new Map([
      ["run-a", deferred<void>()],
      ["run-b", deferred<void>()],
      ["run-c", deferred<void>()],
    ]);
    const started: string[] = [];
    let active = 0;
    let maximum = 0;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: async () => [],
      processRun: async (runId) => {
        active += 1;
        maximum = Math.max(maximum, active);
        started.push(runId);
        try {
          await releases.get(runId)!.promise;
        } finally {
          active -= 1;
        }
      },
      onProcessFailure: terminalFailure,
    }, { maxConcurrency: 2 });

    worker.wake("run-a");
    worker.wake("run-b");
    worker.wake("run-c");
    await until(() => started.length === 2);
    assert.deepEqual(started, ["run-a", "run-b"]);
    assert.equal(maximum, 2);

    releases.get("run-a")!.resolve(undefined);
    await until(() => started.length === 3);
    assert.deepEqual(started, ["run-a", "run-b", "run-c"]);
    assert.equal(maximum, 2);

    releases.get("run-b")!.resolve(undefined);
    releases.get("run-c")!.resolve(undefined);
    await worker.drain();
    assert.equal(active, 0);
  });

  it("mencoalesce wake saat running menjadi tepat satu follow-up pass", async () => {
    const releases = [deferred<void>(), deferred<void>()];
    let calls = 0;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: async () => [],
      processRun: async () => {
        const index = calls;
        calls += 1;
        await releases[index]!.promise;
      },
      onProcessFailure: terminalFailure,
    }, { maxConcurrency: 1 });

    worker.wake("run-follow-up");
    await until(() => calls === 1);
    assert.equal(worker.wake("run-follow-up"), "coalesced");
    assert.equal(worker.wake("run-follow-up"), "coalesced");

    releases[0]!.resolve(undefined);
    await until(() => calls === 2);
    await immediate();
    assert.equal(calls, 2);
    releases[1]!.resolve(undefined);
    await worker.drain();
    assert.equal(calls, 2);
  });

  it("interrupt sinkron mengabort signal dan membuat lease lama stale", async () => {
    const release = deferred<void>();
    let signal: AbortSignal | null = null;
    let lease: GroupAgentRunWorkerLease | null = null;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: async () => [],
      processRun: async (_runId, currentSignal, currentLease) => {
        signal = currentSignal;
        lease = currentLease;
        await release.promise;
      },
      onProcessFailure: terminalFailure,
    });

    worker.wake("run-interrupt");
    await until(() => lease !== null);
    const runningSignal = signal as AbortSignal | null;
    const runningLease = lease as GroupAgentRunWorkerLease | null;
    assert.ok(runningSignal);
    assert.ok(runningLease);
    assert.equal(runningLease.isCurrent(), true);

    assert.equal(worker.interrupt("run-interrupt"), true);
    assert.equal(runningSignal.aborted, true);
    assert.equal(runningLease.isCurrent(), false);
    assert.equal(worker.interrupt("run-interrupt"), false);

    release.resolve(undefined);
    await worker.drain();
    assert.equal(runningLease.isCurrent(), false);
  });

  it("interrupt lalu re-add memakai generation baru tanpa overlap atau ABA", async () => {
    const releases = [deferred<void>(), deferred<void>()];
    const leases: GroupAgentRunWorkerLease[] = [];
    const signals: AbortSignal[] = [];
    let calls = 0;
    let active = 0;
    let maximum = 0;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: async () => [],
      processRun: async (_runId, signal, lease) => {
        const index = calls;
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        leases.push(lease);
        signals.push(signal);
        try {
          await releases[index]!.promise;
        } finally {
          active -= 1;
        }
      },
      onProcessFailure: terminalFailure,
    }, { maxConcurrency: 2 });

    worker.wake("run-aba");
    await until(() => calls === 1);
    const oldLease = leases[0]!;
    assert.equal(worker.interrupt("run-aba"), true);
    assert.equal(oldLease.isCurrent(), false);
    assert.equal(worker.wake("run-aba"), "scheduled");
    assert.equal(worker.wake("run-aba"), "coalesced");
    await immediate();
    assert.equal(calls, 1);

    releases[0]!.resolve(undefined);
    await until(() => calls === 2);
    assert.equal(maximum, 1);
    assert.equal(oldLease.isCurrent(), false);
    assert.equal(signals[0]!.aborted, true);
    assert.equal(signals[1]!.aborted, false);
    assert.equal(leases[1]!.isCurrent(), true);

    releases[1]!.resolve(undefined);
    await worker.drain();
    assert.equal(oldLease.isCurrent(), false);
    assert.equal(leases[1]!.isCurrent(), false);
  });

  it("resume overlap dicoalesce menjadi tepat satu trailing scan", async () => {
    const scan = [deferred<string[]>(), deferred<string[]>()];
    const processed: string[] = [];
    let scans = 0;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: () => {
        const index = scans;
        scans += 1;
        return scan[index]!.promise;
      },
      processRun: async (runId) => {
        processed.push(runId);
      },
      onProcessFailure: terminalFailure,
    });

    const first = worker.resume();
    assert.equal(worker.resume(), first);
    assert.equal(worker.resume(), first);
    scan[0]!.resolve(["run-resume-a", "run-resume-a"]);
    await until(() => scans === 2);
    assert.equal(worker.resume(), first);
    assert.equal(worker.resume(), first);
    // ID ini baru runnable setelah snapshot pertama. Trailing pass wajib
    // melihatnya; trigger ketika trailing aktif tetap tidak membentuk hot loop.
    scan[1]!.resolve(["run-resume-b"]);
    await first;
    await worker.drain();

    assert.equal(scans, 2);
    assert.deepEqual(processed.sort(), ["run-resume-a", "run-resume-b"]);
  });

  it("resume gagal tertutup dan hanya mengekspos error/log sanitized", async () => {
    const privateValue = "private-run-id-and-content";
    const logged: unknown[] = [];
    let processed = 0;
    const logger = {
      error: (...args: unknown[]) => logged.push(args),
    } as unknown as OperationalLogger;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: async () => {
        throw new Error(privateValue);
      },
      processRun: async () => {
        processed += 1;
      },
      onProcessFailure: terminalFailure,
    }, { logger });

    await assert.rejects(worker.resume(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Worker GroupAgentRun gagal.");
      assert.equal(
        (error as Error & { code?: string }).code,
        "GROUP_RUN_WORKER_RESUME_FAILED",
      );
      return true;
    });
    await worker.drain();
    assert.equal(processed, 0);
    assert.equal(JSON.stringify(logged).includes(privateValue), false);
  });

  it("stop mengabort scan dan drain menunggu callback scan kooperatif", async () => {
    const scanStarted = deferred<void>();
    const abortObserved = deferred<void>();
    const releaseAfterAbort = deferred<void>();
    let observedSignal: AbortSignal | null = null;
    let processed = 0;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: (signal) => {
        observedSignal = signal;
        scanStarted.resolve(undefined);
        return new Promise<string[]>((resolve) => {
          signal.addEventListener("abort", () => {
            abortObserved.resolve(undefined);
            void releaseAfterAbort.promise.then(() => resolve([]));
          }, { once: true });
        });
      },
      processRun: async () => {
        processed += 1;
      },
      onProcessFailure: terminalFailure,
    });

    const resume = worker.resume();
    await scanStarted.promise;
    const scanSignal = observedSignal as AbortSignal | null;
    assert.ok(scanSignal);
    assert.equal(scanSignal.aborted, false);
    worker.stop();
    await abortObserved.promise;
    assert.equal(scanSignal.aborted, true);

    let drained = false;
    const drain = worker.drain().then(() => {
      drained = true;
    });
    await immediate();
    assert.equal(drained, false);
    releaseAfterAbort.resolve(undefined);
    await Promise.all([resume, drain]);
    assert.equal(drained, true);
    assert.equal(processed, 0);
  });

  it("process failure diselesaikan durable dan requeued tidak kehilangan wake", async () => {
    const privateRunId = "run-private-identifier";
    const privateContent = "private process failure content";
    const logged: unknown[] = [];
    const failures: Array<{ runId: string; code: string }> = [];
    let calls = 0;
    const logger = {
      error: (...args: unknown[]) => logged.push(args),
    } as unknown as OperationalLogger;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: async () => [],
      processRun: async () => {
        calls += 1;
        if (calls === 1) throw new Error(privateContent);
      },
      onProcessFailure: async (runId, code) => {
        failures.push({ runId, code });
        return "requeued";
      },
    }, { logger });

    worker.wake(privateRunId);
    await worker.drain();
    assert.equal(calls, 2);
    assert.deepEqual(failures, [{
      runId: privateRunId,
      code: "GROUP_RUN_WORKER_PROCESS_FAILED",
    }]);
    const serialized = JSON.stringify(logged);
    assert.equal(serialized.includes(privateRunId), false);
    assert.equal(serialized.includes(privateContent), false);
    assert.equal(serialized.includes("GROUP_RUN_WORKER_PROCESS_FAILED"), true);
  });

  it("failure settlement yang gagal hanya memicu satu recovery follow-up", async () => {
    const privateRunId = "run-private-settlement";
    const privateProcess = "private process error";
    const privateSettlement = "private settlement error";
    const logged: unknown[] = [];
    let calls = 0;
    let settlements = 0;
    const logger = {
      error: (...args: unknown[]) => logged.push(args),
    } as unknown as OperationalLogger;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: async () => [],
      processRun: async () => {
        calls += 1;
        throw new Error(privateProcess);
      },
      onProcessFailure: async () => {
        settlements += 1;
        throw new Error(privateSettlement);
      },
    }, { logger });

    worker.wake(privateRunId);
    await worker.drain();
    await immediate();
    assert.equal(calls, 2);
    assert.equal(settlements, 2);
    const serialized = JSON.stringify(logged);
    assert.equal(serialized.includes(privateRunId), false);
    assert.equal(serialized.includes(privateProcess), false);
    assert.equal(serialized.includes(privateSettlement), false);
    assert.equal(
      serialized.includes("GROUP_RUN_WORKER_FAILURE_SETTLEMENT_FAILED"),
      true,
    );
  });

  it("membatasi pending run dan interrupt queued langsung membebaskan kapasitas", async () => {
    const releaseRunning = deferred<void>();
    const releaseReplacement = deferred<void>();
    const started: string[] = [];
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: async () => [],
      processRun: async (runId) => {
        started.push(runId);
        if (runId === "run-capacity-active") await releaseRunning.promise;
        if (runId === "run-capacity-replacement") {
          await releaseReplacement.promise;
        }
      },
      onProcessFailure: terminalFailure,
    }, { maxConcurrency: 1, maxPendingRuns: 2 });

    worker.wake("run-capacity-active");
    await until(() => started.length === 1);
    assert.equal(worker.wake("run-capacity-queued"), "scheduled");
    assert.equal(worker.wake("run-capacity-overflow"), "saturated");
    assert.equal(worker.interrupt("run-capacity-queued"), true);
    assert.equal(
      worker.wake("run-capacity-replacement"),
      "scheduled",
    );

    releaseRunning.resolve(undefined);
    await until(() => started.length === 2);
    assert.deepEqual(started, [
      "run-capacity-active",
      "run-capacity-replacement",
    ]);
    releaseReplacement.resolve(undefined);
    await worker.drain();
  });

  it("stop mengabort semua running, membuang queued, dan drain menunggu callback", async () => {
    const releases = [deferred<void>(), deferred<void>()];
    const signals: AbortSignal[] = [];
    const leases: GroupAgentRunWorkerLease[] = [];
    const started: string[] = [];
    let scans = 0;
    const worker = startGroupAgentRunWorker({
      listRunnableRunIds: async () => {
        scans += 1;
        return ["run-after-stop"];
      },
      processRun: async (runId, signal, lease) => {
        const index = started.length;
        started.push(runId);
        signals.push(signal);
        leases.push(lease);
        await releases[index]!.promise;
      },
      onProcessFailure: terminalFailure,
    }, { maxConcurrency: 2 });

    worker.wake("run-stop-a");
    worker.wake("run-stop-b");
    worker.wake("run-never-started");
    await until(() => started.length === 2);
    worker.stop();

    assert.equal(worker.wake("run-late"), "stopped");
    assert.equal(worker.interrupt("run-stop-a"), false);
    await worker.resume();
    assert.equal(scans, 0);
    assert.equal(signals.every((signal) => signal.aborted), true);
    assert.equal(leases.every((lease) => !lease.isCurrent()), true);

    let drained = false;
    const drain = worker.drain().then(() => {
      drained = true;
    });
    await immediate();
    assert.equal(drained, false);
    releases[0]!.resolve(undefined);
    releases[1]!.resolve(undefined);
    await drain;

    assert.deepEqual(started, ["run-stop-a", "run-stop-b"]);
    assert.equal(leases.every((lease) => !lease.isCurrent()), true);
  });

  it("menolak konfigurasi dan run ID tidak sah", () => {
    const ports = {
      listRunnableRunIds: async () => [],
      processRun: async () => undefined,
      onProcessFailure: terminalFailure,
    };
    for (const maxConcurrency of [0, 33, 1.5]) {
      assert.throws(
        () => startGroupAgentRunWorker(ports, { maxConcurrency }),
        /batas concurrency worker GroupAgentRun tidak sah/iu,
      );
    }
    for (const maxPendingRuns of [0, 10_001, 1.5]) {
      assert.throws(
        () => startGroupAgentRunWorker(ports, { maxPendingRuns }),
        /batas pending worker GroupAgentRun tidak sah/iu,
      );
    }
    const worker = startGroupAgentRunWorker(ports);
    for (const runId of ["", " run", "run\ninvalid", "r".repeat(513)]) {
      assert.throws(
        () => worker.wake(runId),
        /run ID worker GroupAgentRun tidak sah/iu,
      );
    }
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

function terminalFailure(): Promise<"terminal"> {
  return Promise.resolve("terminal");
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await immediate();
  }
  assert.fail("Kondisi asynchronous worker tidak tercapai.");
}

function immediate(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
