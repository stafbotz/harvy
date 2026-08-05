import type { AgentRunService } from "../core/agent-run-service.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

export const AGENT_RUN_RETENTION_INTERVAL_MS = 60_000;

/**
 * Menghapus checkpoint yang melewati horizon absolut walau pemiliknya tidak
 * pernah kembali. Kegagalan satu putaran dicatat dan dicoba lagi pada putaran
 * berikutnya; worker tidak boleh menghentikan bot.
 */
export function startAgentRunRetentionWorker(
  agentRuns: AgentRunService,
  logger: OperationalLogger =
    NOOP_OPERATIONAL_LOGGER.child("worker.agent-run-retention"),
  intervalMs = AGENT_RUN_RETENTION_INTERVAL_MS,
): { stop(): void; drain(): Promise<void>; runNow(): Promise<void> } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Interval retensi run agent tidak sah.");
  }

  let stopped = false;
  let running: Promise<void> | null = null;
  const trigger = (): void => {
    if (stopped || running) return;
    running = agentRuns.purgeExpired()
      .then((removed) => {
        if (removed > 0) {
          logger.info(
            "agent_run_retention_completed",
            "Checkpoint agent kedaluwarsa sudah dihapus.",
            { removed },
          );
        }
      })
      .catch((error: unknown) => {
        logger.error(
          "agent_run_retention_failed",
          "Pembersihan checkpoint agent kedaluwarsa gagal; putaran berikutnya akan mencoba lagi.",
          error,
        );
      })
      .finally(() => {
        running = null;
      });
  };

  const timer = setInterval(trigger, intervalMs);
  timer.unref();
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    async drain(): Promise<void> {
      await running;
    },
    async runNow(): Promise<void> {
      trigger();
      await running;
    },
  };
}
