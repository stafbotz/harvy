import type { EntitlementDeliveryScope } from "../domain/entitlement.js";
import type {
  GroupRunDeliveryPurpose,
  GroupRunWorkAttemptStatus,
} from "../domain/group-agent-run.js";

const DEFAULT_MAX_SCOPES = 500;
const MAX_SCOPES = 10_000;

export interface GroupAgentRunUsageReceiptSnapshot {
  effectId: string;
  purpose: GroupRunDeliveryPurpose;
  workAttemptId?: string | null;
  status: "committed" | "unknown" | "not_committed";
}

export interface GroupAgentRunUsageAttemptSnapshot {
  attemptId: string;
  status: GroupRunWorkAttemptStatus;
}

/** Bentuk content-free minimum yang diproyeksikan dari aggregate durable. */
export interface GroupAgentRunUsageSnapshot {
  runId: string;
  receipts: readonly GroupAgentRunUsageReceiptSnapshot[];
  workAttempts?: readonly GroupAgentRunUsageAttemptSnapshot[];
}

export interface GroupAgentRunUsageSettlement {
  outcome: "committed" | "discarded";
  effectId: string | null;
}

export interface GroupAgentRunUsageReconcilerPorts {
  pendingDeliveryScopes(): Promise<readonly EntitlementDeliveryScope[]>;
  loadRun(runId: string): Promise<GroupAgentRunUsageSnapshot | null>;
  settleDeliveryScope(
    scope: EntitlementDeliveryScope,
    settlement: GroupAgentRunUsageSettlement,
  ): Promise<unknown>;
}

export interface GroupAgentRunUsageReconcilerOptions {
  maxScopes?: number;
}

/** Seluruh field hanya count; tidak ada identifier, status per-run, atau teks. */
export interface GroupAgentRunUsageReconciliationReport {
  listed: number;
  attempted: number;
  committed: number;
  discarded: number;
  pending: number;
  failed: number;
  duplicates: number;
  deferred: number;
}

type ReconcileDecision = GroupAgentRunUsageSettlement | { outcome: "pending" };

/**
 * Menutup kandidat entitlement yang tertinggal saat restart berdasarkan
 * receipt append-only. Error satu scope tidak pernah mengubah scope lain.
 */
export class GroupAgentRunUsageReconciler {
  private readonly maxScopes: number;
  private running: Promise<GroupAgentRunUsageReconciliationReport> | null = null;

  constructor(
    private readonly ports: GroupAgentRunUsageReconcilerPorts,
    options: GroupAgentRunUsageReconcilerOptions = {},
  ) {
    this.maxScopes = boundedScopeLimit(options.maxScopes ?? DEFAULT_MAX_SCOPES);
  }

  reconcilePending(): Promise<GroupAgentRunUsageReconciliationReport> {
    if (this.running) return this.running;
    const pending = this.reconcilePass();
    this.running = pending;
    void pending.finally(() => {
      if (this.running === pending) this.running = null;
    }).catch(() => undefined);
    return pending;
  }

  private async reconcilePass(): Promise<GroupAgentRunUsageReconciliationReport> {
    let scopes: readonly EntitlementDeliveryScope[];
    try {
      scopes = await this.ports.pendingDeliveryScopes();
    } catch {
      return { ...emptyReport(), failed: 1 };
    }

    const report = { ...emptyReport(), listed: scopes.length };
    const seen = new Set<string>();
    const runLoads = new Map<
      string,
      Promise<GroupAgentRunUsageSnapshot | null>
    >();

    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index]!;
      const key = exactScopeKey(scope);
      if (seen.has(key)) {
        report.duplicates += 1;
        continue;
      }
      if (report.attempted >= this.maxScopes) {
        report.deferred = scopes.length - index;
        break;
      }
      seen.add(key);
      report.attempted += 1;

      let run: GroupAgentRunUsageSnapshot | null;
      try {
        const existingLoad = runLoads.get(scope.runId);
        const load = existingLoad ?? this.ports.loadRun(scope.runId);
        if (existingLoad === undefined) runLoads.set(scope.runId, load);
        run = await load;
      } catch {
        report.failed += 1;
        continue;
      }

      if (run !== null && run.runId !== scope.runId) {
        report.failed += 1;
        continue;
      }
      const decision = reconcileDecision(scope, run);
      if (decision.outcome === "pending") {
        report.pending += 1;
        continue;
      }

      try {
        await this.ports.settleDeliveryScope(scope, decision);
        report[decision.outcome] += 1;
      } catch {
        // Fail-closed: kandidat tetap pending agar pass berikut dapat mencoba.
        report.failed += 1;
      }
    }
    return report;
  }
}

function reconcileDecision(
  scope: EntitlementDeliveryScope,
  run: GroupAgentRunUsageSnapshot | null,
): ReconcileDecision {
  if (run === null) return { outcome: "discarded", effectId: null };

  const receipts = run.receipts.filter(
    (receipt) => receipt.workAttemptId === scope.attemptId,
  );
  // Earliest committed receipt adalah binding yang juga akan dipilih pass
  // pertama sebelum crash; receipt append-only membuat replay tetap exact.
  const committed = receipts.find((receipt) => receipt.status === "committed");
  if (committed) {
    return { outcome: "committed", effectId: committed.effectId };
  }
  const terminalReceipt = receipts.find(
    (receipt) =>
      receipt.status === "unknown" || receipt.status === "not_committed",
  );
  if (terminalReceipt) {
    return { outcome: "discarded", effectId: terminalReceipt.effectId };
  }

  const attempt = (run.workAttempts ?? []).find(
    (candidate) => candidate.attemptId === scope.attemptId,
  );
  if (!attempt) return { outcome: "discarded", effectId: null };
  if (attempt.status !== "running") {
    return { outcome: "discarded", effectId: null };
  }
  return { outcome: "pending" };
}

function exactScopeKey(scope: EntitlementDeliveryScope): string {
  return JSON.stringify([
    scope.kind,
    scope.subjectRef,
    scope.runId,
    scope.attemptId,
  ]);
}

function boundedScopeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SCOPES) {
    throw new Error("Batas reconciliation usage GroupAgentRun tidak sah.");
  }
  return value;
}

function emptyReport(): GroupAgentRunUsageReconciliationReport {
  return {
    listed: 0,
    attempted: 0,
    committed: 0,
    discarded: 0,
    pending: 0,
    failed: 0,
    duplicates: 0,
    deferred: 0,
  };
}
