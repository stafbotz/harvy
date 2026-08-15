import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

const DEFAULT_MAX_FAILURE_ATTEMPTS = 5;
const MAX_TARGET_LENGTH = 1_024;

export interface GroupAgentRunActivationTarget {
  scopeKey: string;
  accountId: string;
}

/**
 * Fence ini wajib diperiksa callback host tepat sebelum efek aktivasi terakhir.
 * Cancellation bersifat sinkron sehingga lease lama langsung menjadi false.
 */
export interface GroupAgentRunActivationLease {
  isCurrent(): boolean;
}

/** Bukti membership live exact-generation yang diterbitkan adapter. */
export interface GroupAgentRunLiveMembershipLease {
  isCurrent(): boolean;
}

/**
 * Hasil authoritative dari adapter membership. `self-missing` hanya boleh
 * diterbitkan setelah metadata exact group berhasil dibaca dan membuktikan
 * identitas socket tidak ada; seluruh keadaan lain yang belum dapat dibuktikan
 * adalah `unavailable` dan memakai failure budget retry.
 */
export type GroupAgentRunLiveMembershipResult =
  | {
      status: "member";
      lease: GroupAgentRunLiveMembershipLease;
    }
  | { status: "self-missing" }
  | { status: "unavailable" };

export type GroupAgentRunActivationReconcileResult = "activated" | "pending";

export interface GroupAgentRunActivationRetryPorts {
  /** Error/unavailable diretry bounded; hanya self-missing yang terminal. */
  revalidateLiveMembership(
    target: Readonly<GroupAgentRunActivationTarget>,
  ): Promise<GroupAgentRunLiveMembershipResult>;
  /**
   * Host merekonsiliasi cleanup lalu mengaktifkan hanya jika lease masih current
   * pada titik commit. `pending` mempertahankan target untuk putaran berikutnya.
   */
  reconcileAndActivate(
    target: Readonly<GroupAgentRunActivationTarget>,
    lease: GroupAgentRunActivationLease,
  ): Promise<GroupAgentRunActivationReconcileResult>;
}

export interface GroupAgentRunActivationRetryOptions {
  maxFailureAttempts?: number;
  logger?: OperationalLogger;
}

export type GroupAgentRunActivationEnqueueResult =
  | "scheduled"
  | "coalesced"
  | "stopped";

export interface GroupAgentRunActivationRetryReport {
  attempted: number;
  activated: number;
  pending: number;
  denied: number;
  retrying: number;
  exhausted: number;
  cancelled: number;
}

export interface GroupAgentRunActivationRetry {
  enqueue(scopeKey: string, accountId: string): GroupAgentRunActivationEnqueueResult;
  cancel(scopeKey: string, accountId: string): boolean;
  runNow(): Promise<GroupAgentRunActivationRetryReport>;
  stop(): void;
  drain(): Promise<void>;
}

interface QueueEntry {
  readonly key: string;
  readonly target: Readonly<GroupAgentRunActivationTarget>;
  readonly generation: object;
  failureAttempts: number;
}

type AttemptOutcome =
  | "activated"
  | "pending"
  | "denied"
  | "retrying"
  | "exhausted"
  | "cancelled";

/**
 * Queue in-memory untuk menutup jendela availability antara membership re-add
 * dan cleanup durable yang belum selesai. Target exact scope+account tidak
 * pernah diserialisasi atau disertakan dalam log.
 *
 * Worker sengaja triggerable: host boleh memanggil runNow setelah pass cleanup
 * atau dari timer bounded miliknya. Putaran yang overlap dikoaleskan.
 */
export function startGroupAgentRunActivationRetry(
  ports: GroupAgentRunActivationRetryPorts,
  options: GroupAgentRunActivationRetryOptions = {},
): GroupAgentRunActivationRetry {
  const maxFailureAttempts = boundedPositiveInteger(
    options.maxFailureAttempts ?? DEFAULT_MAX_FAILURE_ATTEMPTS,
    "max failure attempts reaktivasi GroupAgentRun",
  );
  const logger = options.logger ??
    NOOP_OPERATIONAL_LOGGER.child("worker.group-agent-run-activation-retry");
  const entries = new Map<string, QueueEntry>();
  let stopped = false;
  let running: Promise<GroupAgentRunActivationRetryReport> | null = null;

  const isCurrent = (entry: QueueEntry): boolean =>
    !stopped &&
    entries.get(entry.key) === entry &&
    entries.get(entry.key)?.generation === entry.generation;

  const removeIfCurrent = (entry: QueueEntry): boolean => {
    if (!isCurrent(entry)) return false;
    entries.delete(entry.key);
    return true;
  };

  const fail = (entry: QueueEntry): AttemptOutcome => {
    if (!isCurrent(entry)) return "cancelled";
    entry.failureAttempts += 1;
    if (entry.failureAttempts >= maxFailureAttempts) {
      entries.delete(entry.key);
      safeLog(() => logger.error(
        "group_agent_run_activation_retry_exhausted",
        "Retry reaktivasi GroupAgentRun mencapai batas dan dihentikan.",
        sanitizedActivationRetryError(),
        {
          attempt: entry.failureAttempts,
          maxAttempts: maxFailureAttempts,
        },
      ));
      return "exhausted";
    }
    safeLog(() => logger.warn(
      "group_agent_run_activation_retry_failed",
      "Reaktivasi GroupAgentRun gagal; putaran berikutnya akan mencoba lagi.",
      {
        attempt: entry.failureAttempts,
        maxAttempts: maxFailureAttempts,
      },
    ));
    return "retrying";
  };

  const attempt = async (entry: QueueEntry): Promise<AttemptOutcome> => {
    if (!isCurrent(entry)) return "cancelled";

    let membership: GroupAgentRunLiveMembershipResult;
    try {
      membership = validMembershipResult(
        await ports.revalidateLiveMembership(entry.target),
      );
    } catch {
      return fail(entry);
    }
    if (!isCurrent(entry)) return "cancelled";
    if (membership.status === "unavailable") return fail(entry);
    if (membership.status === "self-missing") {
      removeIfCurrent(entry);
      return "denied";
    }
    const membershipLease = membership.lease;
    if (!membershipLeaseIsCurrent(membershipLease)) return fail(entry);

    const lease: GroupAgentRunActivationLease = {
      isCurrent: () =>
        isCurrent(entry) && membershipLeaseIsCurrent(membershipLease),
    };
    let reconciled: GroupAgentRunActivationReconcileResult;
    try {
      // Tidak ada await antara fence internal terakhir dan invocation callback.
      if (!isCurrent(entry)) return "cancelled";
      if (!membershipLeaseIsCurrent(membershipLease)) return fail(entry);
      const pending = ports.reconcileAndActivate(entry.target, lease);
      reconciled = await pending;
    } catch {
      return fail(entry);
    }
    if (!isCurrent(entry)) return "cancelled";
    if (!membershipLeaseIsCurrent(membershipLease)) return fail(entry);
    if (reconciled === "pending") {
      // Pending cleanup bukan keberhasilan notice dan tidak boleh menghapus
      // failure budget yang sudah dikonsumsi pada putaran sebelumnya.
      return "pending";
    }
    if (reconciled !== "activated") return fail(entry);
    return removeIfCurrent(entry) ? "activated" : "cancelled";
  };

  const cycle = async (): Promise<GroupAgentRunActivationRetryReport> => {
    const snapshot = [...entries.values()];
    const outcomes = await Promise.all(snapshot.map(attempt));
    return summarize(outcomes, entries.size);
  };

  const trigger = (): Promise<GroupAgentRunActivationRetryReport> => {
    if (stopped) return Promise.resolve(emptyReport());
    if (running) return running;
    const pending = Promise.resolve().then(cycle);
    running = pending;
    void pending.finally(() => {
      if (running === pending) running = null;
    }).catch(() => undefined);
    return pending;
  };

  return {
    enqueue(
      scopeKey: string,
      accountId: string,
    ): GroupAgentRunActivationEnqueueResult {
      const target = makeTarget(scopeKey, accountId);
      if (stopped) return "stopped";
      const key = targetKey(target);
      if (entries.has(key)) return "coalesced";
      entries.set(key, {
        key,
        target,
        // Object identity mencegah ABA ketika cancel lalu re-add memakai key sama.
        generation: Object.freeze({}),
        failureAttempts: 0,
      });
      return "scheduled";
    },

    cancel(scopeKey: string, accountId: string): boolean {
      const target = makeTarget(scopeKey, accountId);
      return entries.delete(targetKey(target));
    },

    runNow(): Promise<GroupAgentRunActivationRetryReport> {
      return trigger();
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      // Menghapus entry membuat seluruh lease in-flight stale secara sinkron.
      entries.clear();
    },

    async drain(): Promise<void> {
      // stop() mencegah pass baru. Loop juga aman bila drain dipanggil sebelum
      // stop dan sebuah caller sudah men-trigger pass berikutnya di boundary.
      while (running) {
        await running;
      }
    },
  };
}

function makeTarget(
  scopeKey: string,
  accountId: string,
): Readonly<GroupAgentRunActivationTarget> {
  validateTargetPart(scopeKey, "scope");
  validateTargetPart(accountId, "account");
  return Object.freeze({ scopeKey, accountId });
}

function validateTargetPart(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_TARGET_LENGTH ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Target ${field} reaktivasi GroupAgentRun tidak sah.`);
  }
}

function targetKey(target: Readonly<GroupAgentRunActivationTarget>): string {
  return `${target.scopeKey.length}:${target.scopeKey}` +
    `${target.accountId.length}:${target.accountId}`;
}

function summarize(
  outcomes: readonly AttemptOutcome[],
  pending: number,
): GroupAgentRunActivationRetryReport {
  const report = emptyReport();
  report.attempted = outcomes.length;
  report.pending = pending;
  for (const outcome of outcomes) {
    if (outcome === "activated") report.activated += 1;
    else if (outcome === "denied") report.denied += 1;
    else if (outcome === "retrying") report.retrying += 1;
    else if (outcome === "exhausted") report.exhausted += 1;
    else if (outcome === "cancelled") report.cancelled += 1;
  }
  return report;
}

function emptyReport(): GroupAgentRunActivationRetryReport {
  return {
    attempted: 0,
    activated: 0,
    pending: 0,
    denied: 0,
    retrying: 0,
    exhausted: 0,
    cancelled: 0,
  };
}

function boundedPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100) {
    throw new Error(`${field} tidak sah.`);
  }
  return value;
}

function validMembershipLease(
  value: GroupAgentRunLiveMembershipLease,
): GroupAgentRunLiveMembershipLease {
  if (
    typeof value !== "object" || value === null ||
    typeof value.isCurrent !== "function"
  ) {
    throw new Error("Lease membership reaktivasi GroupAgentRun tidak sah.");
  }
  return value;
}

function membershipLeaseIsCurrent(
  lease: GroupAgentRunLiveMembershipLease,
): boolean {
  try {
    return lease.isCurrent() === true;
  } catch {
    return false;
  }
}

function validMembershipResult(
  value: GroupAgentRunLiveMembershipResult,
): GroupAgentRunLiveMembershipResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("Hasil membership reaktivasi GroupAgentRun tidak sah.");
  }
  if (value.status === "member") {
    return { status: "member", lease: validMembershipLease(value.lease) };
  }
  if (value.status === "self-missing" || value.status === "unavailable") {
    return { status: value.status };
  }
  throw new Error("Hasil membership reaktivasi GroupAgentRun tidak sah.");
}

function sanitizedActivationRetryError(): Error {
  return Object.assign(
    new Error("Retry reaktivasi GroupAgentRun gagal."),
    {
      name: "GroupAgentRunActivationRetryError",
      code: "GROUP_RUN_ACTIVATION_RETRY_FAILED",
    },
  );
}

function safeLog(action: () => void): void {
  try {
    action();
  } catch {
    // Logging tidak boleh mengubah hasil reconciliation atau retry.
  }
}
