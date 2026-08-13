import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  startGitHubReconciliationWorker,
  type GitHubReconciliationCycleReport,
} from "../src/core/github-reconciliation-worker.js";
import type {
  GitHubUnknownEffectPage,
  GitHubUnknownEffectReference,
} from "../src/domain/github.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type LogChannel,
  type LogContext,
  type OperationalLogger,
} from "../src/observability/operational-logger.js";

const FIRST = reference("project-1", "effect-1", "a");
const SECOND = reference("project-2", "effect-2", "b");

describe("GitHub unknown reconciliation worker", () => {
  it("memulai recovery segera, tidak overlap, dan drain menunggu kandidat aktif", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let listCalls = 0;
    let reconcileCalls = 0;
    const worker = startGitHubReconciliationWorker(
      {
        async listUnknownEffects(): Promise<GitHubUnknownEffectPage> {
          listCalls += 1;
          return { references: [FIRST, SECOND], nextCursor: null };
        },
      },
      {
        async reconcileDurableUnknown() {
          reconcileCalls += 1;
          entered.resolve(undefined);
          await release.promise;
          return "committed" as const;
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

    assert.deepEqual(await joined, report({ discovered: 2, terminal: 1 }));
    await draining;
    assert.equal(listCalls, 1);
    assert.equal(reconcileCalls, 1);
    assert.equal(await worker.runNow(), null);
  });

  it("memproses kandidat lain setelah failure dan hanya mencatat agregat", async () => {
    const logger = new RecordingLogger();
    const worker = startGitHubReconciliationWorker(
      {
        async listUnknownEffects({ cursor }): Promise<GitHubUnknownEffectPage> {
          return cursor === null
            ? { references: [FIRST], nextCursor: "page-2" }
            : { references: [SECOND], nextCursor: null };
        },
      },
      {
        async reconcileDurableUnknown(referenceInput) {
          if (referenceInput.effectId === FIRST.effectId) {
            throw new Error("PRIVATE_REPOSITORY_SENTINEL");
          }
          return "unknown" as const;
        },
      },
      logger,
      { intervalMs: 60_000, batchSize: 1 },
    );

    const first = await worker.runNow();
    const second = await worker.runNow();
    worker.stop();
    await worker.drain();

    assert.deepEqual(first, report({
      failed: 1,
    }));
    assert.deepEqual(second, report({ unresolved: 1 }));
    const serialized = JSON.stringify(logger.records);
    assert.equal(serialized.includes("PRIVATE_REPOSITORY_SENTINEL"), false);
    assert.equal(serialized.includes(FIRST.projectId), false);
    assert.equal(serialized.includes(FIRST.effectId), false);
  });

  it("berhenti fail-closed bila cursor repository tidak bergerak", async () => {
    const logger = new RecordingLogger();
    let pages = 0;
    const worker = startGitHubReconciliationWorker(
      {
        async listUnknownEffects(): Promise<GitHubUnknownEffectPage> {
          pages += 1;
          return { references: [], nextCursor: "same" };
        },
      },
      {
        async reconcileDurableUnknown() {
          throw new Error("tidak boleh dipanggil");
        },
      },
      logger,
      { intervalMs: 60_000, batchSize: 1 },
    );

    // First cycle advances null→same; the second rejects a non-advancing
    // cursor without spinning through more pages.
    const first = await worker.runNow();
    const result = await worker.runNow();
    worker.stop();
    assert.deepEqual(first, report({ discovered: 0 }));
    assert.deepEqual(result, report({ discovered: 0, failed: 1 }));
    assert.equal(pages, 2);
  });
});

function reference(
  projectId: string,
  effectId: string,
  digestCharacter: string,
): GitHubUnknownEffectReference {
  return {
    version: 1,
    ownerWorkspaceKey: "workspace-owner",
    projectId,
    effectId,
    effectDigest: digestCharacter.repeat(64),
  };
}

function report(
  changes: Partial<GitHubReconciliationCycleReport>,
): GitHubReconciliationCycleReport {
  return {
    discovered: 1,
    terminal: 0,
    unresolved: 0,
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
