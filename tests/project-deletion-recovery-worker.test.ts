import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  startProjectDeletionRecoveryWorker,
  type ProjectDeletionRecoveryCycleReport,
} from "../src/core/project-deletion-recovery-worker.js";
import type {
  ProjectDeletionPage,
  ProjectDeletionReference,
} from "../src/domain/project-deletion.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type LogChannel,
  type LogContext,
  type OperationalLogger,
} from "../src/observability/operational-logger.js";

const FIRST = reference("project-1", "deletion-1");
const SECOND = reference("project-2", "deletion-2");
const THIRD = reference("project-3", "deletion-3");

describe("Project deletion recovery worker", () => {
  it("memulai segera, tidak overlap, dan drain menunggu cleanup aktif", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let listCalls = 0;
    let resumeCalls = 0;
    const worker = startProjectDeletionRecoveryWorker(
      {
        async listIncomplete(): Promise<ProjectDeletionPage> {
          listCalls += 1;
          return { references: [FIRST, SECOND], nextCursor: null };
        },
      },
      {
        async resumeDurable() {
          resumeCalls += 1;
          entered.resolve(undefined);
          await release.promise;
          return "completed" as const;
        },
      },
      NOOP_OPERATIONAL_LOGGER,
      { intervalMs: 60_000, batchSize: 1 },
    );

    await entered.promise;
    const joined = worker.runNow();
    worker.stop();
    let drained = false;
    const draining = worker.drain().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    release.resolve(undefined);

    assert.deepEqual(await joined, report({ discovered: 2, completed: 1 }));
    await draining;
    assert.equal(listCalls, 1);
    assert.equal(resumeCalls, 1);
    assert.equal(await worker.runNow(), null);
  });

  it("memproses satu page per siklus, mengisolasi failure, dan hanya log agregat", async () => {
    const logger = new RecordingLogger();
    const cursors: Array<string | null> = [];
    const worker = startProjectDeletionRecoveryWorker(
      {
        async listIncomplete({ cursor }): Promise<ProjectDeletionPage> {
          cursors.push(cursor);
          return cursor === null
            ? { references: [FIRST, SECOND], nextCursor: "page-2" }
            : { references: [THIRD], nextCursor: null };
        },
      },
      {
        async resumeDurable(referenceInput) {
          if (referenceInput.deletionId === FIRST.deletionId) {
            throw new Error("PRIVATE_PROJECT_SENTINEL");
          }
          if (referenceInput.deletionId === SECOND.deletionId) {
            return "cleanup_required" as const;
          }
          return "missing" as const;
        },
      },
      logger,
      { intervalMs: 60_000, batchSize: 2 },
    );

    const first = await worker.runNow();
    const second = await worker.runNow();
    worker.stop();
    await worker.drain();

    assert.deepEqual(first, report({ discovered: 2, blocked: 1, failed: 1 }));
    assert.deepEqual(second, report({ missing: 1 }));
    assert.deepEqual(cursors, [null, "page-2"]);
    const serialized = JSON.stringify(logger.records);
    assert.equal(serialized.includes("PRIVATE_PROJECT_SENTINEL"), false);
    assert.equal(serialized.includes(FIRST.projectId), false);
    assert.equal(serialized.includes(FIRST.deletionId), false);
  });

  it("gagal tertutup bila cursor repository tidak bergerak", async () => {
    let pages = 0;
    const worker = startProjectDeletionRecoveryWorker(
      {
        async listIncomplete(): Promise<ProjectDeletionPage> {
          pages += 1;
          return { references: [], nextCursor: "same" };
        },
      },
      {
        async resumeDurable() {
          throw new Error("tidak boleh dipanggil");
        },
      },
      NOOP_OPERATIONAL_LOGGER,
      { intervalMs: 60_000, batchSize: 1 },
    );

    assert.deepEqual(await worker.runNow(), report({ discovered: 0 }));
    assert.deepEqual(
      await worker.runNow(),
      report({ discovered: 0, failed: 1 }),
    );
    worker.stop();
    await worker.drain();
    assert.equal(pages, 2);
  });

  it("mempertahankan cursor dan mencoba lagi setelah discovery gagal", async () => {
    let calls = 0;
    const worker = startProjectDeletionRecoveryWorker(
      {
        async listIncomplete(): Promise<ProjectDeletionPage> {
          calls += 1;
          if (calls === 1) throw new Error("PRIVATE_DISCOVERY_SENTINEL");
          return { references: [FIRST], nextCursor: null };
        },
      },
      {
        async resumeDurable() {
          return "completed" as const;
        },
      },
      NOOP_OPERATIONAL_LOGGER,
      { intervalMs: 60_000, batchSize: 1 },
    );

    assert.deepEqual(await worker.runNow(), report({ discovered: 0, failed: 1 }));
    assert.deepEqual(await worker.runNow(), report({ completed: 1 }));
    worker.stop();
    await worker.drain();
    assert.equal(calls, 2);
  });
});

function reference(projectId: string, deletionId: string): ProjectDeletionReference {
  return {
    version: 1,
    deletionId,
    ownerWorkspaceKey: "workspace-owner",
    projectId,
    projectCreatedAt: "2026-08-13T03:00:00.000Z",
    projectSource: "upload",
    expectedProjectRevision: 1,
  };
}

function report(
  changes: Partial<ProjectDeletionRecoveryCycleReport>,
): ProjectDeletionRecoveryCycleReport {
  return {
    discovered: 1,
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

class RecordingLogger implements OperationalLogger {
  readonly records: unknown[] = [];
  child(): OperationalLogger { return this; }
  runWithContext<T>(_context: LogContext, action: () => T): T { return action(); }
  newTraceContext(channel: LogChannel): LogContext {
    return { traceId: "test-trace", channel };
  }
  trace(event: string, message: string, fields?: Record<string, unknown>): void {
    this.records.push({ event, message, fields });
  }
  debug(event: string, message: string, fields?: Record<string, unknown>): void {
    this.records.push({ event, message, fields });
  }
  info(event: string, message: string, fields?: Record<string, unknown>): void {
    this.records.push({ event, message, fields });
  }
  warn(event: string, message: string, fields?: Record<string, unknown>): void {
    this.records.push({ event, message, fields });
  }
  error(event: string, message: string, error: unknown, fields?: Record<string, unknown>): void {
    this.records.push({ event, message, error: String(error), fields });
  }
  fatal(event: string, message: string, error: unknown, fields?: Record<string, unknown>): void {
    this.records.push({ event, message, error: String(error), fields });
  }
}
