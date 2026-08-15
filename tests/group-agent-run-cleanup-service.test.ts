import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  type GroupAgentRunCleanupExecutor,
  GroupAgentRunCleanupService,
} from "../src/core/group-agent-run-cleanup-service.js";
import { GroupAgentRunLifecycleCoordinator } from
  "../src/core/group-agent-run-lifecycle-coordinator.js";
import type { GroupAgentRunCleanupIntentRepository } from
  "../src/domain/group-agent-run-cleanup.js";
import type { OperationalLogger } from
  "../src/observability/operational-logger.js";
import { FileGroupAgentRunCleanupIntentRepository } from
  "../src/storage/file-group-agent-run-cleanup-repository.js";

const SCOPE = "whatsapp:cleanup-target@g.us";
const ACCOUNT = "wa-cleanup";

describe("GroupAgentRun cleanup service", () => {
  it("membuat intent durable sebelum kedua efek dan baru complete setelah keduanya fulfilled", async (t) => {
    const fixture = await makeFixture(t);
    const observed: string[] = [];
    const executor: GroupAgentRunCleanupExecutor = {
      disableGroup: async (scopeKey, accountId) => {
        assert.deepEqual(
          (await fixture.repository.listPending()).map(targetOf),
          [{ scopeKey, accountId }],
        );
        observed.push("binding");
        return false;
      },
      forgetScope: async (scopeKey, accountId) => {
        assert.deepEqual(
          (await fixture.repository.listPending()).map(targetOf),
          [{ scopeKey, accountId }],
        );
        observed.push("runs");
        return 0;
      },
    };
    const service = new GroupAgentRunCleanupService(
      fixture.repository,
      executor,
      undefined,
      () => new Date("2026-08-14T02:00:00.000Z"),
    );

    assert.equal(await service.request(SCOPE, ACCOUNT), "completed");
    assert.deepEqual(observed.sort(), ["binding", "runs"]);
    assert.deepEqual(await fixture.repository.listPending(), []);
  });

  it("menyimpan intent bila disable gagal, tetap mencoba forget, lalu recovery restart menuntaskan", async (t) => {
    const fixture = await makeFixture(t);
    const logs = logCapture();
    let disableCalls = 0;
    let forgetCalls = 0;
    const failed = new GroupAgentRunCleanupService(
      fixture.repository,
      {
        disableGroup: () => {
          disableCalls += 1;
          throw new Error(`${SCOPE} isi rahasia tidak boleh masuk log`);
        },
        forgetScope: async () => {
          forgetCalls += 1;
          return 2;
        },
      },
      logs.logger,
      () => new Date("2026-08-14T02:01:00.000Z"),
    );

    assert.equal(await failed.request(SCOPE, ACCOUNT), "pending");
    assert.equal(await failed.isPending(SCOPE, ACCOUNT), true);
    assert.equal(disableCalls, 1);
    assert.equal(forgetCalls, 1);
    assert.equal((await fixture.repository.listPending()).length, 1);

    const restartCalls: Array<{ operation: string; scopeKey: string; accountId: string }> = [];
    const restarted = new GroupAgentRunCleanupService(
      new FileGroupAgentRunCleanupIntentRepository(fixture.path),
      {
        disableGroup: async (scopeKey, accountId) => {
          restartCalls.push({ operation: "binding", scopeKey, accountId });
        },
        forgetScope: async (scopeKey, accountId) => {
          restartCalls.push({ operation: "runs", scopeKey, accountId });
        },
      },
      logs.logger,
    );
    assert.deepEqual(await restarted.recoverPending(), {
      attempted: 1,
      completed: 1,
      pending: 0,
    });
    assert.equal(await restarted.isPending(SCOPE, ACCOUNT), false);
    assert.deepEqual(restartCalls, [
      { operation: "binding", scopeKey: SCOPE, accountId: ACCOUNT },
      { operation: "runs", scopeKey: SCOPE, accountId: ACCOUNT },
    ]);
    assert.deepEqual(await fixture.repository.listPending(), []);
    assertLogsContainNoPrivateValues(logs.records);
  });

  it("menyimpan intent bila forget gagal dan mencoba kedua efek lagi", async (t) => {
    const fixture = await makeFixture(t);
    let shouldFail = true;
    let disableCalls = 0;
    let forgetCalls = 0;
    const service = new GroupAgentRunCleanupService(
      fixture.repository,
      {
        disableGroup: async () => {
          disableCalls += 1;
        },
        forgetScope: async () => {
          forgetCalls += 1;
          if (shouldFail) throw new Error("gagal sementara");
        },
      },
      undefined,
      () => new Date("2026-08-14T02:02:00.000Z"),
    );

    assert.equal(await service.request(SCOPE, ACCOUNT), "pending");
    shouldFail = false;
    assert.deepEqual(await service.recoverPending(), {
      attempted: 1,
      completed: 1,
      pending: 0,
    });
    assert.equal(disableCalls, 2);
    assert.equal(forgetCalls, 2);
  });

  it("mereconcile intent pending lalu mengaktifkan tanpa lock reentrant", async (t) => {
    const fixture = await makeFixture(t);
    let cleanupFails = true;
    let activated = false;
    const service = new GroupAgentRunCleanupService(
      fixture.repository,
      {
        disableGroup: async () => {
          if (cleanupFails) throw new Error("sementara");
        },
        forgetScope: async () => undefined,
      },
      undefined,
      () => new Date("2026-08-14T02:03:00.000Z"),
    );
    assert.equal(await service.request(SCOPE, ACCOUNT), "pending");

    cleanupFails = false;
    assert.deepEqual(
      await service.activateWhenClean(SCOPE, ACCOUNT, async () => {
        activated = true;
        return "active" as const;
      }),
      { status: "activated", value: "active" },
    );
    assert.equal(activated, true);
    assert.equal(await service.isPending(SCOPE, ACCOUNT), false);
  });

  it("snapshot recovery basi tidak mematikan binding yang diaktifkan kembali", async (t) => {
    const fixture = await makeFixture(t);
    await fixture.repository.enqueue(
      SCOPE,
      ACCOUNT,
      "2026-08-14T02:03:00.000Z",
    );
    const listed = deferred();
    const resumeRecovery = deferred();
    let blockRecoverySnapshot = true;
    const intents: GroupAgentRunCleanupIntentRepository = {
      enqueue: (...args) => fixture.repository.enqueue(...args),
      listPending: async () => {
        const snapshot = await fixture.repository.listPending();
        if (blockRecoverySnapshot) {
          blockRecoverySnapshot = false;
          listed.resolve();
          await resumeRecovery.promise;
        }
        return snapshot;
      },
      hasPending: (...args) => fixture.repository.hasPending(...args),
      matchesPending: (...args) => fixture.repository.matchesPending(...args),
      complete: (...args) => fixture.repository.complete(...args),
    };
    const lifecycle = new GroupAgentRunLifecycleCoordinator();
    let active = false;
    let disableCalls = 0;
    let forgetCalls = 0;
    const service = new GroupAgentRunCleanupService(
      intents,
      {
        disableGroup: async () => {
          disableCalls += 1;
          active = false;
        },
        forgetScope: async () => {
          forgetCalls += 1;
        },
      },
      undefined,
      () => new Date("2026-08-14T02:04:00.000Z"),
      lifecycle,
    );

    const recovery = service.recoverPending();
    await listed.promise;
    assert.equal(await service.request(SCOPE, ACCOUNT), "completed");
    assert.deepEqual(
      await service.activateWhenClean(SCOPE, ACCOUNT, async () => {
        active = true;
        return "active" as const;
      }),
      { status: "activated", value: "active" },
    );
    resumeRecovery.resolve();

    assert.deepEqual(await recovery, {
      attempted: 1,
      completed: 1,
      pending: 0,
    });
    assert.equal(active, true);
    assert.equal(disableCalls, 1);
    assert.equal(forgetCalls, 1);
    assert.equal(await service.isPending(SCOPE, ACCOUNT), false);
  });
});

async function makeFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-run-cleanup-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "cleanup-intents.json");
  return {
    path,
    repository: new FileGroupAgentRunCleanupIntentRepository(path),
  };
}

function targetOf(value: { scopeKey: string; accountId: string }): {
  scopeKey: string;
  accountId: string;
} {
  return { scopeKey: value.scopeKey, accountId: value.accountId };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function logCapture(): {
  logger: OperationalLogger;
  records: Array<{
    event: string;
    message: string;
    error?: unknown;
    fields?: Record<string, unknown>;
  }>;
} {
  const records: Array<{
    event: string;
    message: string;
    error?: unknown;
    fields?: Record<string, unknown>;
  }> = [];
  return {
    records,
    logger: {
      info: (event: string, message: string, fields?: Record<string, unknown>) => {
        records.push({ event, message, ...(fields ? { fields } : {}) });
      },
      error: (
        event: string,
        message: string,
        error: unknown,
        fields?: Record<string, unknown>,
      ) => {
        records.push({ event, message, error, ...(fields ? { fields } : {}) });
      },
    } as unknown as OperationalLogger,
  };
}

function assertLogsContainNoPrivateValues(
  records: Array<{
    event: string;
    message: string;
    error?: unknown;
    fields?: Record<string, unknown>;
  }>,
): void {
  const projection = records.map((record) => ({
    ...record,
    error: record.error instanceof Error
      ? { name: record.error.name, message: record.error.message }
      : record.error,
  }));
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, new RegExp(SCOPE, "iu"));
  assert.doesNotMatch(serialized, new RegExp(ACCOUNT, "iu"));
  assert.doesNotMatch(serialized, /isi rahasia/iu);
}
