import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import type {
  GroupAgentRunCleanupRecoveryResult,
  GroupAgentRunCleanupService,
} from "./group-agent-run-cleanup-service.js";

export const GROUP_AGENT_RUN_CLEANUP_INTERVAL_MS = 60_000;

export interface GroupAgentRunCleanupWorker {
  /** Promise pass startup; dapat di-await sebelum WhatsApp menerima ingress. */
  ready(): Promise<GroupAgentRunCleanupRecoveryResult>;
  runNow(): Promise<GroupAgentRunCleanupRecoveryResult>;
  stop(): void;
  drain(): Promise<void>;
}

export function startGroupAgentRunCleanupWorker(
  cleanup: Pick<GroupAgentRunCleanupService, "recoverPending">,
  logger: OperationalLogger =
    NOOP_OPERATIONAL_LOGGER.child("worker.group-agent-run-cleanup"),
  intervalMs = GROUP_AGENT_RUN_CLEANUP_INTERVAL_MS,
): GroupAgentRunCleanupWorker {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("Interval cleanup GroupAgentRun tidak sah.");
  }

  let stopped = false;
  let running: Promise<GroupAgentRunCleanupRecoveryResult> | null = null;
  const idle = (): GroupAgentRunCleanupRecoveryResult => ({
    attempted: 0,
    completed: 0,
    pending: 0,
  });

  const trigger = (): Promise<GroupAgentRunCleanupRecoveryResult> => {
    if (stopped) return Promise.resolve(idle());
    if (running) return running;
    const pending = Promise.resolve().then(() => cleanup.recoverPending());
    running = pending;
    pending.finally(() => {
      if (running === pending) running = null;
    }).catch(() => undefined);
    return pending;
  };

  const reportFailure = (): void => {
    logger.error(
      "group_agent_run_cleanup_recovery_failed",
      "Recovery cleanup GroupAgentRun gagal; putaran berikutnya akan mencoba lagi.",
      sanitizedWorkerError(),
    );
  };

  // Simpan promise asli agar readiness tetap menolak saat source intent tidak
  // dapat dibaca. Handler samping mencegah unhandled rejection bila host belum
  // sempat memanggil ready().
  const startup = trigger();
  void startup.catch(reportFailure);
  const timer = setInterval(() => {
    void trigger().catch(reportFailure);
  }, intervalMs);
  timer.unref();

  return {
    ready(): Promise<GroupAgentRunCleanupRecoveryResult> {
      return startup;
    },
    runNow(): Promise<GroupAgentRunCleanupRecoveryResult> {
      return trigger();
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    async drain(): Promise<void> {
      await running;
    },
  };
}

function sanitizedWorkerError(): Error {
  return Object.assign(
    new Error("Recovery cleanup GroupAgentRun gagal."),
    { name: "GroupAgentRunCleanupError", code: "GROUP_RUN_CLEANUP_FAILED" },
  );
}
