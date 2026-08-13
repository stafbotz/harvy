import type {
  GitHubUnknownEffectReconciler,
  GitHubUnknownEffectRepository,
} from "../domain/github.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

export const GITHUB_RECONCILIATION_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;

export interface GitHubReconciliationCycleReport {
  discovered: number;
  terminal: number;
  unresolved: number;
  missing: number;
  failed: number;
}

export interface GitHubReconciliationWorker {
  stop(): void;
  drain(): Promise<void>;
  runNow(): Promise<GitHubReconciliationCycleReport | null>;
}

/**
 * Observes durable `unknown` effects after restart. It never prepares, approves,
 * or executes a GitHub effect, and logs aggregate counts only.
 */
export function startGitHubReconciliationWorker(
  repository: GitHubUnknownEffectRepository,
  reconciler: GitHubUnknownEffectReconciler,
  logger: OperationalLogger =
    NOOP_OPERATIONAL_LOGGER.child("worker.github-reconciliation"),
  options: { intervalMs?: number; batchSize?: number } = {},
): GitHubReconciliationWorker {
  const intervalMs = boundedInteger(
    options.intervalMs ?? GITHUB_RECONCILIATION_INTERVAL_MS,
    "interval GitHub reconciliation",
    1,
    24 * 60 * 60_000,
  );
  const batchSize = boundedInteger(
    options.batchSize ?? DEFAULT_BATCH_SIZE,
    "batch GitHub reconciliation",
    1,
    100,
  );
  let stopped = false;
  let running: Promise<GitHubReconciliationCycleReport> | null = null;
  let cursor: string | null = null;

  const cycle = async (): Promise<GitHubReconciliationCycleReport> => {
    const report: GitHubReconciliationCycleReport = {
      discovered: 0,
      terminal: 0,
      unresolved: 0,
      missing: 0,
      failed: 0,
    };
    const cycleCursor = cursor;
    let page;
    try {
      page = await repository.listUnknownEffects({
        cursor: cycleCursor,
        limit: batchSize,
      });
    } catch {
      report.failed += 1;
      logger.error(
        "github_reconciliation_discovery_failed",
        "Enumerasi receipt GitHub unknown gagal; putaran berikutnya akan mencoba lagi.",
        new Error("github_reconciliation_discovery_failed"),
      );
      return report;
    }
    report.discovered = page.references.length;
    for (const reference of page.references) {
      if (stopped) break;
      try {
        const status = await reconciler.reconcileDurableUnknown(reference);
        if (status === "committed" || status === "not_committed") {
          report.terminal += 1;
        } else if (status === "missing") {
          report.missing += 1;
        } else {
          report.unresolved += 1;
        }
      } catch {
        report.failed += 1;
      }
    }
    if (!stopped) {
      if (page.nextCursor !== null && page.nextCursor === cycleCursor) {
        report.failed += 1;
      } else {
        // Exactly one page is observed per cycle. Stop is checked between
        // candidates, so drain waits for at most the current broker deadline.
        // A completed page advances the in-process cursor; reaching the end
        // wraps to the first unresolved locator on the next cycle.
        cursor = page.nextCursor;
      }
    }
    logger.info(
      "github_reconciliation_cycle_completed",
      "Putaran rekonsiliasi receipt GitHub unknown selesai.",
      { ...report },
    );
    return report;
  };

  const trigger = (): Promise<GitHubReconciliationCycleReport | null> => {
    if (stopped) return Promise.resolve(null);
    if (running) return running;
    const pending = cycle();
    running = pending;
    pending.finally(() => {
      if (running === pending) running = null;
    }).catch(() => undefined);
    return pending;
  };
  const timer = setInterval(() => void trigger(), intervalMs);
  timer.unref();
  // Startup recovery begins immediately. The returned runNow joins this same
  // promise instead of creating an overlapping pass.
  void trigger();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    async drain(): Promise<void> {
      await running;
    },
    runNow(): Promise<GitHubReconciliationCycleReport | null> {
      return trigger();
    },
  };
}

function boundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} tidak sah.`);
  }
  return value;
}
