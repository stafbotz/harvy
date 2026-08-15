import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  EntitlementDeliveryScope,
  EntitlementEntry,
  PendingEntitlementCandidate,
} from "../src/domain/entitlement.js";
import { FileEntitlementLedgerRepository } from "../src/storage/file-entitlement-ledger-repository.js";

describe("FileEntitlementLedgerRepository delivery settlement", () => {
  it("memulihkan kandidat setelah restart dan commit exact effect secara idempoten", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-entitlement-delivery-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "entitlement.json");
    const scope = deliveryScope();
    const first = new FileEntitlementLedgerRepository(file);

    assert.equal(await first.stageCandidate(candidate(scope)), "staged");
    assert.deepEqual(await first.listPendingScopes(), [scope]);
    assert.equal(
      await first.pendingDebitTokens(
        scope.subjectRef,
        new Date("2026-08-01T00:00:00.000Z"),
      ),
      15,
    );

    const afterCrash = new FileEntitlementLedgerRepository(file);
    assert.deepEqual(await afterCrash.listPendingScopes(), [scope]);
    assert.equal(
      await afterCrash.settleScope(scope, {
        outcome: "committed",
        effectId: "effect-final-1",
        settledAt: "2026-08-01T00:01:00.000Z",
      }),
      "settled",
    );

    const afterCommitCrash = new FileEntitlementLedgerRepository(file);
    assert.deepEqual(await afterCommitCrash.listPendingScopes(), []);
    assert.deepEqual((await afterCommitCrash.list())[0]?.delivery, {
      scope: {
        kind: scope.kind,
        runId: scope.runId,
        attemptId: scope.attemptId,
      },
      effectId: "effect-final-1",
    });
    assert.equal(
      await afterCommitCrash.settleScope(scope, {
        outcome: "committed",
        effectId: "effect-final-1",
        settledAt: "2026-08-01T00:02:00.000Z",
      }),
      "replayed",
    );
    await assert.rejects(
      afterCommitCrash.settleScope(scope, {
        outcome: "committed",
        effectId: "effect-final-berbeda",
        settledAt: "2026-08-01T00:02:00.000Z",
      }),
      /keputusan terminal/u,
    );
    await assert.rejects(
      afterCommitCrash.settleScope(
        { ...scope, runId: "run-lain" },
        {
          outcome: "committed",
          effectId: "effect-final-1",
          settledAt: "2026-08-01T00:02:00.000Z",
        },
      ),
      /sudah terikat/u,
    );

    const stored = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      entries: unknown[];
      candidates: unknown[];
      settlements: unknown[];
    };
    assert.equal(stored.version, 2);
    assert.equal(stored.entries.length, 1);
    assert.equal(stored.candidates.length, 0);
    assert.equal(stored.settlements.length, 1);
  });

  it("tombstone discard menolak completion terlambat juga setelah restart", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-entitlement-late-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "entitlement.json");
    const scope = deliveryScope();
    const first = new FileEntitlementLedgerRepository(file);
    assert.equal(
      await first.settleScope(scope, {
        outcome: "discarded",
        effectId: "effect-not-committed-1",
        settledAt: "2026-08-01T00:01:00.000Z",
      }),
      "settled",
    );

    const afterCrash = new FileEntitlementLedgerRepository(file);
    assert.equal(await afterCrash.stageCandidate(candidate(scope)), "discarded");
    assert.deepEqual(await afterCrash.listPendingScopes(), []);
    assert.deepEqual(await afterCrash.list(), []);

    const afterLateCompletion = new FileEntitlementLedgerRepository(file);
    assert.equal(
      await afterLateCompletion.settleScope(scope, {
        outcome: "discarded",
        effectId: "effect-not-committed-1",
        settledAt: "2026-08-01T00:03:00.000Z",
      }),
      "replayed",
    );
    await assert.rejects(
      afterLateCompletion.settleScope(scope, {
        outcome: "committed",
        effectId: "effect-not-committed-1",
        settledAt: "2026-08-01T00:03:00.000Z",
      }),
      /keputusan terminal/u,
    );
  });

  it("menolak requestId sama dengan payload kandidat berbeda", async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-entitlement-collision-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const repository = new FileEntitlementLedgerRepository(
      join(directory, "entitlement.json"),
    );
    const scope = deliveryScope();
    assert.equal(await repository.stageCandidate(candidate(scope)), "staged");
    assert.equal(await repository.stageCandidate(candidate(scope)), "replayed");
    await assert.rejects(
      repository.stageCandidate(candidate(scope, 16)),
      /Idempotency key/u,
    );
  });
});

function deliveryScope(): EntitlementDeliveryScope {
  return {
    kind: "group_agent_run_attempt",
    subjectRef: "subject-group-1",
    runId: "run-1",
    attemptId: "attempt-1",
  };
}

function candidate(
  scope: EntitlementDeliveryScope,
  tokens = 15,
): PendingEntitlementCandidate {
  return {
    scope,
    entry: entitlementEntry(scope.subjectRef, tokens),
  };
}

function entitlementEntry(subjectRef: string, tokens: number): EntitlementEntry {
  return {
    schemaVersion: 1,
    entryId: "entry-1",
    idempotencyKey: "request-1",
    requestId: "request-1",
    turnId: "attempt-1",
    subjectRef,
    planId: "personal_free",
    cohort: "standard",
    tier: "cheap",
    purpose: "agent",
    modelId: "model-1",
    type: "debit",
    disposition: "charge",
    measuredTokens: tokens,
    debitedTokens: tokens,
    succeeded: true,
    at: "2026-08-01T00:00:30.000Z",
  };
}
