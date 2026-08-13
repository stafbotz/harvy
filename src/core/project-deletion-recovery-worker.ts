import type {
  ProjectDeletionReconciler,
  ProjectDeletionRepository,
} from "../domain/project-deletion.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

export const PROJECT_DELETION_RECOVERY_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 25;

export interface ProjectDeletionRecoveryCycleReport {
  discovered: number;
  completed: number;
  blocked: number;
  missing: number;
  failed: number;
}

export interface ProjectDeletionRecoveryWorker {
  stop(): void;
  drain(): Promise<void>;
  runNow(): Promise<ProjectDeletionRecoveryCycleReport | null>;
}

/**
 * Resumes durable local deletion tombstones without fabricating a user scope.
 * One bounded page is processed per cycle and only aggregate counts are logged.
 */
export function startProjectDeletionRecoveryWorker(
  repository: Pick<ProjectDeletionRepository, "listIncomplete">,
  reconciler: ProjectDeletionReconciler,
  logger: OperationalLogger =
    NOOP_OPERATIONAL_LOGGER.child("worker.project-deletion-recovery"),
  options: { intervalMs?: number; batchSize?: number } = {},
): ProjectDeletionRecoveryWorker {
  const intervalMs = boundedInteger(
    options.intervalMs ?? PROJECT_DELETION_RECOVERY_INTERVAL_MS,
    "interval project deletion recovery",
    1,
    24 * 60 * 60_000,
  );
  const batchSize = boundedInteger(
    options.batchSize ?? DEFAULT_BATCH_SIZE,
    "batch project deletion recovery",
    1,
    100,
  );
  let stopped = false;
  let running: Promise<ProjectDeletionRecoveryCycleReport> | null = null;
  let cursor: string | null = null;

  const cycle = async (): Promise<ProjectDeletionRecoveryCycleReport> => {
    const report: ProjectDeletionRecoveryCycleReport = {
      discovered: 0,
      completed: 0,
      blocked: 0,
      missing: 0,
      failed: 0,
    };
    const cycleCursor = cursor;
    let page;
    try {
      page = await repository.listIncomplete({
        cursor: cycleCursor,
        limit: batchSize,
      });
    } catch {
      report.failed += 1;
      logger.error(
        "project_deletion_recovery_discovery_failed",
        "Enumerasi tombstone project deletion gagal; putaran berikutnya akan mencoba lagi.",
        new Error("project_deletion_recovery_discovery_failed"),
      );
      return report;
    }

    report.discovered = page.references.length;
    for (const reference of page.references) {
      if (stopped) break;
      try {
        const status = await reconciler.resumeDurable(reference);
        if (status === "completed") report.completed += 1;
        else if (status === "cleanup_required") report.blocked += 1;
        else report.missing += 1;
      } catch {
        report.failed += 1;
      }
    }

    if (!stopped) {
      if (page.nextCursor !== null && page.nextCursor === cycleCursor) {
        report.failed += 1;
      } else {
        cursor = page.nextCursor;
      }
    }
    logger.info(
      "project_deletion_recovery_cycle_completed",
      "Putaran recovery project deletion selesai.",
      { ...report },
    );
    return report;
  };

  const trigger = (): Promise<ProjectDeletionRecoveryCycleReport | null> => {
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
  void trigger();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    async drain(): Promise<void> {
      await running;
    },
    runNow(): Promise<ProjectDeletionRecoveryCycleReport | null> {
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
