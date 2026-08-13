import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodingRuntimeSupervisor } from "../src/core/coding-runtime-supervisor.js";
import type {
  GitHubReconciliationCycleReport,
  GitHubReconciliationWorker,
} from "../src/core/github-reconciliation-worker.js";
import type {
  ProjectDeletionRecoveryCycleReport,
  ProjectDeletionRecoveryWorker,
} from "../src/core/project-deletion-recovery-worker.js";
import type { SandboxHealth, SandboxRunnerLifecycle } from "../src/domain/sandbox.js";

describe("CodingRuntimeSupervisor", () => {
  it("menyelesaikan sandbox→GitHub→deletion secara berurutan dan tetap menutup coding admission", async () => {
    const order: string[] = [];
    const sandboxGate = deferred<SandboxHealth>();
    const githubGate = deferred<GitHubReconciliationCycleReport>();
    const deletionGate = deferred<ProjectDeletionRecoveryCycleReport>();
    const scheduler = lifecycleScheduler(order);
    const supervisor = new CodingRuntimeSupervisor({
      sandbox: sandboxLifecycle(order, sandboxGate.promise),
      scheduler,
      createGitHubRecoveryWorker() {
        order.push("github-create");
        return recoveryWorker(order, "github", githubGate.promise);
      },
      createProjectDeletionRecoveryWorker() {
        order.push("deletion-create");
        return recoveryWorker(order, "deletion", deletionGate.promise);
      },
    });

    const starting = supervisor.start();
    await tick();
    assert.deepEqual(order, ["sandbox-start"]);
    assert.deepEqual(supervisor.status(), {
      version: 1,
      state: "starting",
      codingAdmission: "closed",
    });

    sandboxGate.resolve(healthy("PRIVATE_BACKEND_REASON"));
    await tick();
    assert.deepEqual(order, ["sandbox-start", "github-create", "github-run"]);
    githubGate.resolve(githubReport());
    await tick();
    assert.deepEqual(order, [
      "sandbox-start",
      "github-create",
      "github-run",
      "deletion-create",
      "deletion-run",
    ]);
    deletionGate.resolve(deletionReport());

    const report = await starting;
    assert.equal(report.state, "maintenance_ready");
    assert.equal(report.codingAdmission, "closed");
    assert.deepEqual(report.sandbox, {
      available: true,
      runtime: "isolated-linux",
      checkedAt: "2026-08-13T01:00:00.000Z",
    });
    assert.equal(JSON.stringify(report).includes("PRIVATE_BACKEND_REASON"), false);
    assert.equal(scheduler.startCalls, 0);
  });

  it("menandai initial pass degraded tanpa mengklaim backlog selesai", async () => {
    const supervisor = new CodingRuntimeSupervisor({
      sandbox: sandboxLifecycle([], Promise.resolve({
        available: false,
        runtime: null,
        checkedAt: "2026-08-13T01:00:00.000Z",
        reason: "backend unavailable",
      })),
      scheduler: lifecycleScheduler([]),
      createGitHubRecoveryWorker: () => recoveryWorker(
        [],
        "github",
        Promise.resolve(githubReport({ discovered: 1, unresolved: 1 })),
      ),
      createProjectDeletionRecoveryWorker: () => recoveryWorker(
        [],
        "deletion",
        Promise.resolve(deletionReport({ discovered: 1, blocked: 1 })),
      ),
    });

    const report = await supervisor.start();
    assert.equal(report.state, "degraded");
    assert.equal(report.githubInitialPass.unresolved, 1);
    assert.equal(report.projectDeletionInitialPass.blocked, 1);
    assert.equal(supervisor.status().codingAdmission, "closed");
  });

  it("mempertahankan worker untuk retry setelah discovery initial pass gagal", async () => {
    const supervisor = new CodingRuntimeSupervisor({
      sandbox: sandboxLifecycle([], Promise.resolve(healthy(null))),
      scheduler: lifecycleScheduler([]),
      createGitHubRecoveryWorker: () => recoveryWorker(
        [],
        "github",
        Promise.resolve(githubReport({ failed: 1 })),
      ),
      createProjectDeletionRecoveryWorker: () => recoveryWorker(
        [],
        "deletion",
        Promise.resolve(deletionReport({ failed: 1 })),
      ),
    });

    const report = await supervisor.start();
    assert.equal(report.state, "degraded");
    assert.equal(report.githubInitialPass.discovered, 0);
    assert.equal(report.githubInitialPass.failed, 1);
    assert.equal(report.projectDeletionInitialPass.failed, 1);
    await supervisor.drain();
  });

  it("shutdown menutup admission sinkron lalu men-drain caller sebelum sandbox close", async () => {
    const order: string[] = [];
    const supervisor = new CodingRuntimeSupervisor({
      sandbox: sandboxLifecycle(order, Promise.resolve(healthy(null))),
      scheduler: lifecycleScheduler(order),
      createGitHubRecoveryWorker: () => recoveryWorker(
        order,
        "github",
        Promise.resolve(githubReport()),
      ),
      createProjectDeletionRecoveryWorker: () => recoveryWorker(
        order,
        "deletion",
        Promise.resolve(deletionReport()),
      ),
    });
    await supervisor.start();
    order.length = 0;

    supervisor.stop();
    assert.deepEqual(order, [
      "scheduler-stop",
      "github-stop",
      "deletion-stop",
      "sandbox-stop",
    ]);
    await supervisor.drain();
    assert.deepEqual(order, [
      "scheduler-stop",
      "github-stop",
      "deletion-stop",
      "sandbox-stop",
      "scheduler-drain",
      "github-drain",
      "deletion-drain",
      "sandbox-drain",
      "sandbox-close",
    ]);
    assert.equal(supervisor.status().state, "stopped");
  });

  it("failure drain caller mencegah sandbox close dan dapat diretry", async () => {
    const order: string[] = [];
    const scheduler = lifecycleScheduler(order);
    scheduler.failDrainOnce = true;
    const supervisor = new CodingRuntimeSupervisor({
      sandbox: sandboxLifecycle(order, Promise.resolve(healthy(null))),
      scheduler,
      createGitHubRecoveryWorker: () => recoveryWorker(
        order,
        "github",
        Promise.resolve(githubReport()),
      ),
      createProjectDeletionRecoveryWorker: () => recoveryWorker(
        order,
        "deletion",
        Promise.resolve(deletionReport()),
      ),
    });
    await supervisor.start();
    order.length = 0;

    await assert.rejects(supervisor.drain(), /fail-closed/u);
    assert.equal(order.includes("sandbox-close"), false);
    await supervisor.drain();
    assert.equal(order.at(-1), "sandbox-close");
    assert.equal(supervisor.status().state, "stopped");
  });

  it("menolak start ulang sesudah stop walaupun startup report pernah tersimpan", async () => {
    const supervisor = new CodingRuntimeSupervisor({
      sandbox: sandboxLifecycle([], Promise.resolve(healthy(null))),
      scheduler: lifecycleScheduler([]),
      createGitHubRecoveryWorker: () => recoveryWorker(
        [],
        "github",
        Promise.resolve(githubReport()),
      ),
      createProjectDeletionRecoveryWorker: () => recoveryWorker(
        [],
        "deletion",
        Promise.resolve(deletionReport()),
      ),
    });
    await supervisor.start();
    await supervisor.drain();

    await assert.rejects(supervisor.start(), /tidak dapat dimulai ulang/u);
    assert.equal(supervisor.status().state, "stopped");
  });

  it("stop exception tetap menyegel semua komponen dan harus pulih sebelum close", async () => {
    const order: string[] = [];
    const scheduler = lifecycleScheduler(order);
    scheduler.failStopOnce = true;
    const supervisor = new CodingRuntimeSupervisor({
      sandbox: sandboxLifecycle(order, Promise.resolve(healthy(null))),
      scheduler,
      createGitHubRecoveryWorker: () => recoveryWorker(
        order,
        "github",
        Promise.resolve(githubReport()),
      ),
      createProjectDeletionRecoveryWorker: () => recoveryWorker(
        order,
        "deletion",
        Promise.resolve(deletionReport()),
      ),
    });
    await supervisor.start();
    order.length = 0;

    supervisor.stop();
    assert.deepEqual(order, [
      "scheduler-stop",
      "github-stop",
      "deletion-stop",
      "sandbox-stop",
    ]);
    await assert.rejects(supervisor.drain(), /fail-closed/u);
    assert.equal(order.includes("scheduler-stop-retry"), true);
    assert.equal(order.includes("sandbox-close"), false);
    await supervisor.drain();
    assert.equal(order.at(-1), "sandbox-close");
  });

  it("startup failure membersihkan worker parsial dan tidak membuat deletion worker", async () => {
    const order: string[] = [];
    let deletionFactories = 0;
    const supervisor = new CodingRuntimeSupervisor({
      sandbox: sandboxLifecycle(order, Promise.resolve(healthy(null))),
      scheduler: lifecycleScheduler(order),
      createGitHubRecoveryWorker: () => recoveryWorker(
        order,
        "github",
        Promise.reject(new Error("github discovery failed")),
      ),
      createProjectDeletionRecoveryWorker() {
        deletionFactories += 1;
        return recoveryWorker(order, "deletion", Promise.resolve(deletionReport()));
      },
    });

    await assert.rejects(supervisor.start(), /github discovery failed/u);
    assert.equal(deletionFactories, 0);
    assert.equal(supervisor.status().state, "failed");
    assert.deepEqual(order, [
      "sandbox-start",
      "github-run",
      "scheduler-stop",
      "github-stop",
      "sandbox-stop",
      "scheduler-drain",
      "github-drain",
      "sandbox-drain",
      "sandbox-close",
    ]);
  });
});

interface SchedulerFake {
  startCalls: number;
  stopCalls: number;
  failDrainOnce: boolean;
  failStopOnce: boolean;
  stop(): void;
  drain(): Promise<void>;
}

function lifecycleScheduler(order: string[]): SchedulerFake {
  return {
    startCalls: 0,
    stopCalls: 0,
    failDrainOnce: false,
    failStopOnce: false,
    stop() {
      this.stopCalls += 1;
      order.push(this.stopCalls === 1 ? "scheduler-stop" : "scheduler-stop-retry");
      if (this.failStopOnce) {
        this.failStopOnce = false;
        throw new Error("scheduler stop failed");
      }
    },
    async drain() {
      order.push("scheduler-drain");
      if (this.failDrainOnce) {
        this.failDrainOnce = false;
        throw new Error("scheduler drain failed");
      }
    },
  };
}

function sandboxLifecycle(
  order: string[],
  startResult: Promise<SandboxHealth>,
): SandboxRunnerLifecycle {
  return {
    async start() {
      order.push("sandbox-start");
      return startResult;
    },
    stop() {
      order.push("sandbox-stop");
    },
    async drain() {
      order.push("sandbox-drain");
    },
    async close() {
      order.push("sandbox-close");
    },
  };
}

function recoveryWorker(
  order: string[],
  name: "github",
  runResult: Promise<GitHubReconciliationCycleReport>,
): GitHubReconciliationWorker;
function recoveryWorker(
  order: string[],
  name: "deletion",
  runResult: Promise<ProjectDeletionRecoveryCycleReport>,
): ProjectDeletionRecoveryWorker;
function recoveryWorker(
  order: string[],
  name: "github" | "deletion",
  runResult: Promise<GitHubReconciliationCycleReport | ProjectDeletionRecoveryCycleReport>,
): GitHubReconciliationWorker | ProjectDeletionRecoveryWorker {
  return {
    stop() {
      order.push(`${name}-stop`);
    },
    async drain() {
      order.push(`${name}-drain`);
    },
    async runNow() {
      order.push(`${name}-run`);
      return runResult;
    },
  } as GitHubReconciliationWorker | ProjectDeletionRecoveryWorker;
}

function healthy(reason: string | null): SandboxHealth {
  return {
    available: true,
    runtime: "isolated-linux",
    checkedAt: "2026-08-13T01:00:00.000Z",
    reason,
  };
}

function githubReport(
  changes: Partial<GitHubReconciliationCycleReport> = {},
): GitHubReconciliationCycleReport {
  return {
    discovered: 0,
    terminal: 0,
    unresolved: 0,
    missing: 0,
    failed: 0,
    ...changes,
  };
}

function deletionReport(
  changes: Partial<ProjectDeletionRecoveryCycleReport> = {},
): ProjectDeletionRecoveryCycleReport {
  return {
    discovered: 0,
    completed: 0,
    blocked: 0,
    missing: 0,
    failed: 0,
    ...changes,
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
