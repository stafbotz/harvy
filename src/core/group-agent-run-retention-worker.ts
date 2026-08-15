import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

export const GROUP_AGENT_RUN_RETENTION_INTERVAL_MS = 60_000;

/** Kontrak lifecycle minimum yang nanti dipenuhi GroupAgentRunService. */
export interface GroupAgentRunLifecyclePort {
  recoverInterruptedRuns(): Promise<unknown>;
  purgeExpired(): Promise<number>;
}

export interface GroupAgentRunRetentionWorker {
  stop(): void;
  drain(): Promise<void>;
  runNow(): Promise<void>;
}

/**
 * Memulihkan efek GroupAgentRun yang terputus sebelum retensi boleh menghapus
 * record. Setiap trigger menjalankan paling banyak satu siklus dan trigger yang
 * datang bersamaan bergabung dengan promise yang sama.
 */
export function startGroupAgentRunRetentionWorker(
  lifecycle: GroupAgentRunLifecyclePort,
  logger: OperationalLogger =
    NOOP_OPERATIONAL_LOGGER.child("worker.group-agent-run-retention"),
  intervalMs = GROUP_AGENT_RUN_RETENTION_INTERVAL_MS,
): GroupAgentRunRetentionWorker {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Interval retensi GroupAgentRun tidak sah.");
  }

  let stopped = false;
  let recoveryCompleted = false;
  let running: Promise<void> | null = null;

  const cycle = async (): Promise<void> => {
    if (!recoveryCompleted) {
      try {
        await lifecycle.recoverInterruptedRuns();
        recoveryCompleted = true;
        logger.info(
          "group_agent_run_recovery_completed",
          "Pemulihan GroupAgentRun yang terputus selesai.",
        );
      } catch (error) {
        logger.error(
          "group_agent_run_recovery_failed",
          "Pemulihan GroupAgentRun yang terputus gagal; putaran berikutnya akan mencoba lagi.",
          error,
        );
        return;
      }
    }

    // Stop menutup admission kerja baru. Recovery yang telanjur berjalan tetap
    // ditunggu, tetapi tidak dilanjutkan dengan purge baru saat shutdown.
    if (stopped) return;

    try {
      const removed = await lifecycle.purgeExpired();
      if (removed > 0) {
        logger.info(
          "group_agent_run_retention_completed",
          "GroupAgentRun kedaluwarsa sudah dihapus.",
          { removed },
        );
      }
    } catch (error) {
      logger.error(
        "group_agent_run_retention_failed",
        "Pembersihan GroupAgentRun kedaluwarsa gagal; putaran berikutnya akan mencoba lagi.",
        error,
      );
    }
  };

  const trigger = (): Promise<void> => {
    if (stopped) return Promise.resolve();
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
  // Recovery startup dimulai langsung; runNow bergabung dengan siklus ini.
  void trigger();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    async drain(): Promise<void> {
      await running;
    },
    runNow(): Promise<void> {
      return trigger();
    },
  };
}
