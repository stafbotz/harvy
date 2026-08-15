import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GroupAgentRunUsageReconciler,
  type GroupAgentRunUsageReconcilerPorts,
  type GroupAgentRunUsageSettlement,
  type GroupAgentRunUsageSnapshot,
} from "../src/core/group-agent-run-usage-reconciler.js";
import type { EntitlementDeliveryScope } from "../src/domain/entitlement.js";

describe("GroupAgentRunUsageReconciler", () => {
  it("commit memakai exact effect receipt final maupun question", async () => {
    const finalScope = scope("final");
    const questionScope = scope("question");
    const ports = new FakePorts([finalScope, questionScope]);
    ports.runs.set(finalScope.runId, snapshot(finalScope, {
      status: "committed",
      effectId: "effect-final",
      purpose: "final_result",
    }));
    ports.runs.set(questionScope.runId, snapshot(questionScope, {
      status: "committed",
      effectId: "effect-question",
      purpose: "assigned_question",
    }));

    assert.deepEqual(
      await new GroupAgentRunUsageReconciler(ports).reconcilePending(),
      report({ listed: 2, attempted: 2, committed: 2 }),
    );
    assert.deepEqual(ports.settlementFor(finalScope), {
      outcome: "committed",
      effectId: "effect-final",
    });
    assert.deepEqual(ports.settlementFor(questionScope), {
      outcome: "committed",
      effectId: "effect-question",
    });
  });

  it("unknown dan not_committed membuang kandidat dengan exact effect", async () => {
    const unknownScope = scope("unknown");
    const notCommittedScope = scope("not-committed");
    const ports = new FakePorts([unknownScope, notCommittedScope]);
    ports.runs.set(unknownScope.runId, snapshot(unknownScope, {
      status: "unknown",
      effectId: "effect-unknown",
      purpose: "final_result",
    }));
    ports.runs.set(notCommittedScope.runId, snapshot(notCommittedScope, {
      status: "not_committed",
      effectId: "effect-not-committed",
      purpose: "assigned_question",
    }));

    assert.deepEqual(
      await new GroupAgentRunUsageReconciler(ports).reconcilePending(),
      report({ listed: 2, attempted: 2, discarded: 2 }),
    );
    assert.deepEqual(ports.settlementFor(unknownScope), {
      outcome: "discarded",
      effectId: "effect-unknown",
    });
    assert.deepEqual(ports.settlementFor(notCommittedScope), {
      outcome: "discarded",
      effectId: "effect-not-committed",
    });
  });

  it("attempt running tanpa receipt tetap pending", async () => {
    const activeScope = scope("active");
    const ports = new FakePorts([activeScope]);
    ports.runs.set(activeScope.runId, snapshot(activeScope));

    assert.deepEqual(
      await new GroupAgentRunUsageReconciler(ports).reconcilePending(),
      report({ listed: 1, attempted: 1, pending: 1 }),
    );
    assert.equal(ports.settlements.size, 0);
  });

  it("run hilang, attempt hilang, dan attempt terminal dibuang", async () => {
    const missingRun = scope("missing-run");
    const missingAttempt = scope("missing-attempt");
    const terminalAttempt = scope("terminal-attempt");
    const ports = new FakePorts([missingRun, missingAttempt, terminalAttempt]);
    ports.runs.set(missingRun.runId, null);
    ports.runs.set(missingAttempt.runId, {
      runId: missingAttempt.runId,
      receipts: [],
      workAttempts: [],
    });
    ports.runs.set(terminalAttempt.runId, {
      ...snapshot(terminalAttempt),
      workAttempts: [{
        attemptId: terminalAttempt.attemptId,
        status: "completed",
      }],
    });

    assert.deepEqual(
      await new GroupAgentRunUsageReconciler(ports).reconcilePending(),
      report({ listed: 3, attempted: 3, discarded: 3 }),
    );
    assert.deepEqual(
      [...ports.settlements.values()],
      Array.from({ length: 3 }, () => ({
        outcome: "discarded",
        effectId: null,
      })),
    );
  });

  it("mengisolasi load dan settlement failure lalu melanjutkan scope lain", async () => {
    const loadFailure = scope("load-failure");
    const settleFailure = scope("settle-failure");
    const committed = scope("good-commit");
    const active = scope("good-active");
    const ports = new FakePorts([
      loadFailure,
      settleFailure,
      committed,
      active,
    ]);
    ports.loadFailures.add(loadFailure.runId);
    ports.settleFailures.add(scopeKey(settleFailure));
    ports.runs.set(settleFailure.runId, null);
    ports.runs.set(committed.runId, snapshot(committed, {
      status: "committed",
      effectId: "effect-good",
      purpose: "final_result",
    }));
    ports.runs.set(active.runId, snapshot(active));

    assert.deepEqual(
      await new GroupAgentRunUsageReconciler(ports).reconcilePending(),
      report({
        listed: 4,
        attempted: 4,
        committed: 1,
        pending: 1,
        failed: 2,
      }),
    );
    assert.deepEqual(ports.settlementFor(committed), {
      outcome: "committed",
      effectId: "effect-good",
    });
  });

  it("membatasi pass dan mendeduplikasi exact scope", async () => {
    const first = scope("bounded-1");
    const second = scope("bounded-2");
    const deferred = scope("bounded-3");
    const ports = new FakePorts([first, first, second, deferred]);
    ports.runs.set(first.runId, null);
    ports.runs.set(second.runId, null);
    ports.runs.set(deferred.runId, null);

    assert.deepEqual(
      await new GroupAgentRunUsageReconciler(ports, { maxScopes: 2 })
        .reconcilePending(),
      report({
        listed: 4,
        attempted: 2,
        discarded: 2,
        duplicates: 1,
        deferred: 1,
      }),
    );
    assert.equal(ports.settlements.size, 2);
    assert.equal(ports.loadCalls.includes(deferred.runId), false);
  });

  it("restart mereplay settlement yang sama tanpa collision", async () => {
    const committed = scope("restart");
    const ports = new FakePorts([committed]);
    ports.runs.set(committed.runId, snapshot(committed, {
      status: "committed",
      effectId: "effect-restart",
      purpose: "final_result",
    }));
    const expected = report({ listed: 1, attempted: 1, committed: 1 });

    assert.deepEqual(
      await new GroupAgentRunUsageReconciler(ports).reconcilePending(),
      expected,
    );
    assert.deepEqual(
      await new GroupAgentRunUsageReconciler(ports).reconcilePending(),
      expected,
    );
    assert.equal(ports.settleCalls, 2);
    assert.equal(ports.settlements.size, 1);
  });

  it("gagal membaca daftar pending menghasilkan count fail-closed", async () => {
    const ports = new FakePorts([]);
    ports.failPendingList = true;
    assert.deepEqual(
      await new GroupAgentRunUsageReconciler(ports).reconcilePending(),
      report({ failed: 1 }),
    );
  });
});

class FakePorts implements GroupAgentRunUsageReconcilerPorts {
  readonly runs = new Map<string, GroupAgentRunUsageSnapshot | null>();
  readonly loadFailures = new Set<string>();
  readonly settleFailures = new Set<string>();
  readonly settlements = new Map<string, GroupAgentRunUsageSettlement>();
  readonly loadCalls: string[] = [];
  settleCalls = 0;
  failPendingList = false;

  constructor(
    private readonly scopes: readonly EntitlementDeliveryScope[],
  ) {}

  async pendingDeliveryScopes() {
    if (this.failPendingList) throw new Error("pending list unavailable");
    return this.scopes.map((item) => structuredClone(item));
  }

  async loadRun(runId: string) {
    this.loadCalls.push(runId);
    if (this.loadFailures.has(runId)) throw new Error("load unavailable");
    return structuredClone(this.runs.get(runId) ?? null);
  }

  async settleDeliveryScope(
    target: EntitlementDeliveryScope,
    settlement: GroupAgentRunUsageSettlement,
  ) {
    this.settleCalls += 1;
    const key = scopeKey(target);
    if (this.settleFailures.has(key)) throw new Error("settlement unavailable");
    const existing = this.settlements.get(key);
    if (existing) {
      if (
        existing.outcome === settlement.outcome &&
        existing.effectId === settlement.effectId
      ) return "replayed";
      throw new Error("settlement collision");
    }
    this.settlements.set(key, structuredClone(settlement));
    return "settled";
  }

  settlementFor(target: EntitlementDeliveryScope) {
    return this.settlements.get(scopeKey(target));
  }
}

function scope(suffix: string): EntitlementDeliveryScope {
  return {
    kind: "group_agent_run_attempt",
    subjectRef: `subject-${suffix}`,
    runId: `run-${suffix}`,
    attemptId: `attempt-${suffix}`,
  };
}

function snapshot(
  target: EntitlementDeliveryScope,
  receipt?: {
    status: "committed" | "unknown" | "not_committed";
    effectId: string;
    purpose: "final_result" | "assigned_question";
  },
): GroupAgentRunUsageSnapshot {
  return {
    runId: target.runId,
    receipts: receipt
      ? [{ ...receipt, workAttemptId: target.attemptId }]
      : [],
    workAttempts: [{ attemptId: target.attemptId, status: "running" }],
  };
}

function scopeKey(target: EntitlementDeliveryScope): string {
  return JSON.stringify([
    target.kind,
    target.subjectRef,
    target.runId,
    target.attemptId,
  ]);
}

function report(
  overrides: Partial<{
    listed: number;
    attempted: number;
    committed: number;
    discarded: number;
    pending: number;
    failed: number;
    duplicates: number;
    deferred: number;
  }>,
) {
  return {
    listed: 0,
    attempted: 0,
    committed: 0,
    discarded: 0,
    pending: 0,
    failed: 0,
    duplicates: 0,
    deferred: 0,
    ...overrides,
  };
}
