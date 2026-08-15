import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_PENDING_RUNS = 1_000;
const MAX_CONCURRENCY = 32;
const MAX_PENDING_RUNS = 10_000;
const MAX_RUN_ID_CHARACTERS = 512;
const MAX_RESUME_RUNS = 10_000;
const MAX_AUTOMATIC_FAILURE_RECOVERY = 1;

/**
 * Lease generasional untuk satu invocation. Callback yang menyimpan referensi
 * ini tetap melihat `false` setelah interrupt, stop, atau generation pengganti.
 */
export interface GroupAgentRunWorkerLease {
  isCurrent(): boolean;
}

/**
 * Port sengaja tidak mengetahui model, transport, maupun aggregate. Host yang
 * mengklaim work attempt dan melakukan commit barrier berada di luar primitive
 * coordinator ini.
 */
export interface GroupAgentRunWorkerPorts {
  listRunnableRunIds(signal: AbortSignal): Promise<string[]>;
  processRun(
    runId: string,
    signal: AbortSignal,
    lease: GroupAgentRunWorkerLease,
  ): Promise<void>;
  /**
   * Menetapkan outcome durable setelah callback process melempar. Error mentah
   * tidak diteruskan; host hanya menerima machine code code-owned.
   */
  onProcessFailure(
    runId: string,
    code: GroupAgentRunWorkerFailureCode,
  ): Promise<"requeued" | "terminal">;
}

export interface GroupAgentRunWorkerOptions {
  maxConcurrency?: number;
  maxPendingRuns?: number;
  logger?: OperationalLogger;
}

export type GroupAgentRunWorkerWakeResult =
  | "scheduled"
  | "coalesced"
  | "saturated"
  | "stopped";

export type GroupAgentRunWorkerFailureCode =
  "GROUP_RUN_WORKER_PROCESS_FAILED";

export interface GroupAgentRunWorker {
  wake(runId: string): GroupAgentRunWorkerWakeResult;
  interrupt(runId: string): boolean;
  resume(): Promise<void>;
  stop(): void;
  drain(): Promise<void>;
}

type EntryPhase = "queued" | "scheduled" | "running";

interface WorkEntry {
  readonly runId: string;
  readonly generation: object;
  readonly controller: AbortController;
  phase: EntryPhase;
  interrupted: boolean;
  rerunRequested: boolean;
  failureRecoveryCount: number;
  nextFailureRecoveryCount: number;
}

/**
 * In-memory coordinator untuk satu proses. Ia hanya menjadwalkan callback host;
 * tidak melakukan scan periodik, claim, model call, transport, atau recovery.
 */
export function startGroupAgentRunWorker(
  ports: GroupAgentRunWorkerPorts,
  options: GroupAgentRunWorkerOptions = {},
): GroupAgentRunWorker {
  const maxConcurrency = boundedConcurrency(
    options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
  );
  const maxPendingRuns = boundedPendingRuns(
    options.maxPendingRuns ?? DEFAULT_MAX_PENDING_RUNS,
  );
  const logger = options.logger ??
    NOOP_OPERATIONAL_LOGGER.child("worker.group-agent-run");
  const entries = new Map<string, WorkEntry>();
  const queue: WorkEntry[] = [];
  const tasks = new Set<Promise<void>>();
  let accepting = true;
  let activeCount = 0;
  let resumeInFlight: Promise<void> | null = null;
  let resumeTrailingRequested = false;
  let scanController: AbortController | null = null;

  const leaseCurrent = (entry: WorkEntry): boolean =>
    accepting && entry.phase === "running" && !entry.interrupted &&
    !entry.controller.signal.aborted && entries.get(entry.runId) === entry &&
    entries.get(entry.runId)?.generation === entry.generation;

  const enqueueFresh = (
    runId: string,
    failureRecoveryCount = 0,
  ): boolean => {
    if (entries.size >= maxPendingRuns) return false;
    const entry: WorkEntry = {
      runId,
      // Object identity prevents an interrupted generation becoming current
      // again when the same run ID is re-added (ABA).
      generation: Object.freeze({}),
      controller: new AbortController(),
      phase: "queued",
      interrupted: false,
      rerunRequested: false,
      failureRecoveryCount,
      nextFailureRecoveryCount: 0,
    };
    entries.set(runId, entry);
    queue.push(entry);
    return true;
  };

  const finish = (entry: WorkEntry, task: Promise<void>): void => {
    tasks.delete(task);
    activeCount -= 1;
    const shouldRerun = accepting && entry.rerunRequested;
    if (entries.get(entry.runId) === entry) entries.delete(entry.runId);
    if (shouldRerun && !entries.has(entry.runId)) {
      enqueueFresh(entry.runId, entry.nextFailureRecoveryCount);
    }
    pump();
  };

  const launch = (entry: WorkEntry): void => {
    // Callback baru dianggap running ketika microtask invocation benar-benar
    // dimulai. Wake sinkron kedua sebelum itu tetap duplicate queued work.
    entry.phase = "scheduled";
    activeCount += 1;
    const lease = Object.freeze<GroupAgentRunWorkerLease>({
      isCurrent: () => leaseCurrent(entry),
    });
    let task!: Promise<void>;
    task = Promise.resolve()
      .then(async () => {
        if (
          !accepting || entry.interrupted ||
          entries.get(entry.runId) !== entry
        ) return;
        entry.phase = "running";
        if (!lease.isCurrent()) return;
        await ports.processRun(entry.runId, entry.controller.signal, lease);
      })
      .catch(async () => {
        // Callback yang gagal tidak lagi memegang lease commit. Detached work
        // yang masih menyimpan lease juga langsung melihat generation stale.
        entry.interrupted = true;
        entry.controller.abort();
        safeLog(() => logger.error(
          "group_agent_run_worker_process_failed",
          "Pemrosesan work lane GroupAgentRun gagal.",
          sanitizedWorkerError("PROCESS_FAILED"),
        ));
        if (!accepting || entries.get(entry.runId) !== entry) return;
        try {
          const outcome = await ports.onProcessFailure(
            entry.runId,
            "GROUP_RUN_WORKER_PROCESS_FAILED",
          );
          if (outcome !== "requeued" && outcome !== "terminal") {
            throw new Error("Outcome failure worker tidak sah.");
          }
          if (outcome === "requeued" && accepting) {
            entry.rerunRequested = true;
            entry.nextFailureRecoveryCount = 0;
          }
        } catch {
          safeLog(() => logger.error(
            "group_agent_run_worker_failure_settlement_failed",
            "Settlement failure work lane GroupAgentRun gagal tertutup.",
            sanitizedWorkerError("FAILURE_SETTLEMENT_FAILED"),
          ));
          // Satu follow-up memberi recovery kesempatan kedua tanpa membuat
          // callback/handler yang rusak menjadi hot loop tanpa batas.
          if (
            accepting && !entry.rerunRequested &&
            entry.failureRecoveryCount < MAX_AUTOMATIC_FAILURE_RECOVERY
          ) {
            entry.rerunRequested = true;
            entry.nextFailureRecoveryCount = entry.failureRecoveryCount + 1;
          }
        }
      })
      .finally(() => finish(entry, task));
    tasks.add(task);
  };

  function pump(): void {
    while (accepting && activeCount < maxConcurrency && queue.length > 0) {
      const entry = queue.shift()!;
      if (
        entry.phase !== "queued" || entry.interrupted ||
        entries.get(entry.runId) !== entry
      ) continue;
      launch(entry);
    }
  }

  const wake = (runIdValue: string): GroupAgentRunWorkerWakeResult => {
    const runId = validRunId(runIdValue);
    if (!accepting) return "stopped";
    const existing = entries.get(runId);
    if (existing) {
      if (existing.phase === "running") {
        const newlyScheduled = existing.interrupted &&
          !existing.rerunRequested;
        existing.rerunRequested = true;
        existing.nextFailureRecoveryCount = 0;
        return newlyScheduled ? "scheduled" : "coalesced";
      }
      if (existing.phase === "scheduled" && existing.interrupted) {
        const newlyScheduled = !existing.rerunRequested;
        existing.rerunRequested = true;
        existing.nextFailureRecoveryCount = 0;
        return newlyScheduled ? "scheduled" : "coalesced";
      }
      return "coalesced";
    }
    if (!enqueueFresh(runId)) return "saturated";
    pump();
    return "scheduled";
  };

  const interrupt = (runIdValue: string): boolean => {
    const runId = validRunId(runIdValue);
    const entry = entries.get(runId);
    if (!entry || entry.interrupted) return false;
    entry.interrupted = true;
    entry.rerunRequested = false;
    entry.nextFailureRecoveryCount = 0;
    entry.controller.abort();
    if (entry.phase === "queued") {
      const queuedIndex = queue.indexOf(entry);
      if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
      entries.delete(runId);
      pump();
    }
    return true;
  };

  const scanOnce = async (): Promise<void> => {
    const controller = new AbortController();
    scanController = controller;
    try {
      let values: string[];
      try {
        values = await ports.listRunnableRunIds(controller.signal);
        if (controller.signal.aborted || !accepting) return;
        validateResumeSnapshot(values);
      } catch {
        if (controller.signal.aborted && !accepting) return;
        safeLog(() => logger.error(
          "group_agent_run_worker_resume_failed",
          "Scan recovery work lane GroupAgentRun gagal tertutup.",
          sanitizedWorkerError("RESUME_FAILED"),
        ));
        throw sanitizedWorkerError("RESUME_FAILED");
      }
      if (!accepting) return;
      for (const runId of new Set(values)) wake(runId);
    } finally {
      if (scanController === controller) scanController = null;
    }
  };

  const scan = (): Promise<void> => {
    if (!accepting) return Promise.resolve();
    if (resumeInFlight) {
      // Banyak caller overlap hanya meminta satu pass tambahan. Marker di-reset
      // tepat sebelum trailing pass agar trigger selama pass kedua tidak dapat
      // membentuk scan loop tanpa batas.
      resumeTrailingRequested = true;
      return resumeInFlight;
    }
    resumeTrailingRequested = false;
    let pending!: Promise<void>;
    pending = Promise.resolve()
      .then(async () => {
        await scanOnce();
        if (accepting && resumeTrailingRequested) {
          resumeTrailingRequested = false;
          await scanOnce();
        }
      })
      .finally(() => {
        if (resumeInFlight === pending) resumeInFlight = null;
      });
    resumeInFlight = pending;
    // Caller tetap menerima rejection sanitized; handler ini hanya mencegah
    // unhandled rejection bila shutdown mendahului await milik host.
    void pending.catch(() => undefined);
    return pending;
  };

  return {
    wake,
    interrupt,
    resume: scan,

    stop(): void {
      if (!accepting) return;
      accepting = false;
      resumeTrailingRequested = false;
      scanController?.abort();
      for (const entry of entries.values()) {
        entry.interrupted = true;
        entry.rerunRequested = false;
        entry.nextFailureRecoveryCount = 0;
        entry.controller.abort();
      }
      entries.clear();
      queue.length = 0;
    },

    async drain(): Promise<void> {
      while (true) {
        const pending = [
          ...tasks,
          ...(resumeInFlight ? [resumeInFlight] : []),
        ];
        if (pending.length === 0) {
          pump();
          if (tasks.size === 0 && resumeInFlight === null) return;
          continue;
        }
        await Promise.allSettled(pending);
      }
    },
  };
}

function boundedConcurrency(value: number): number {
  if (
    !Number.isSafeInteger(value) || value <= 0 || value > MAX_CONCURRENCY
  ) {
    throw new Error("Batas concurrency worker GroupAgentRun tidak sah.");
  }
  return value;
}

function boundedPendingRuns(value: number): number {
  if (
    !Number.isSafeInteger(value) || value <= 0 || value > MAX_PENDING_RUNS
  ) {
    throw new Error("Batas pending worker GroupAgentRun tidak sah.");
  }
  return value;
}

function validRunId(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > MAX_RUN_ID_CHARACTERS || value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error("Run ID worker GroupAgentRun tidak sah.");
  return value;
}

function validateResumeSnapshot(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_RESUME_RUNS) {
    throw new Error("Snapshot resume worker GroupAgentRun tidak sah.");
  }
  for (const runId of value) validRunId(runId);
}

function sanitizedWorkerError(
  reason:
    | "PROCESS_FAILED"
    | "FAILURE_SETTLEMENT_FAILED"
    | "RESUME_FAILED",
): Error {
  return Object.assign(
    new Error("Worker GroupAgentRun gagal."),
    {
      name: "GroupAgentRunWorkerError",
      code: `GROUP_RUN_WORKER_${reason}`,
    },
  );
}

function safeLog(action: () => void): void {
  try {
    action();
  } catch {
    // Logging tidak boleh mengubah lifecycle worker atau lease.
  }
}
