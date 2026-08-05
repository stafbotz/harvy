import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PendingStore } from "../src/bot/pending.js";
import type { AgentRunCheckpoint } from "../src/harness/agent-harness.js";

describe("langkah tertunda bertoken", () => {
  it("menolak tombol lama, pemilik lain, kedaluwarsa, dan klik ganda", () => {
    let now = 0;
    const store = new PendingStore(100, () => now);
    const first = store.set("a", {
      kind: "confirm-task",
      task: task("Pertama"),
    });
    const second = store.set("a", {
      kind: "confirm-task",
      task: task("Kedua"),
    });

    assert.equal(store.take("a", first), null);
    assert.equal(store.take("b", second), null);
    assert.equal(store.take("a", second)?.kind, "confirm-task");
    assert.equal(store.take("a", second), null);

    const expiring = store.set("a", {
      kind: "confirm-task",
      task: task("Ketiga"),
    });
    now = 100;
    assert.equal(store.take("a", expiring), null);
  });

  it("mengikat mirror checkpoint agent ke owner, maksimal sepuluh menit, dan tidak memulihkannya sendiri setelah restart", () => {
    let now = 0;
    const store = new PendingStore(10 * 60 * 1_000, () => now);
    const checkpoint = {
      version: 1,
      runId: "run-agent",
      scopeKey: "private:telegram:alice",
      capabilityHash: "a".repeat(64),
      callableHash: "b".repeat(64),
      request: "buat analisis",
      startedAt: "2026-08-04T05:00:00.000Z",
      deadlineAt: "2026-08-04T05:10:00.000Z",
      maxSteps: 6,
      step: 0,
      observations: [],
      userInputs: [],
      seenActionDigests: [],
      pending: null,
      pendingInput: { step: 0, prompt: "Rentang mana?" },
    } satisfies AgentRunCheckpoint;
    store.set("alice", {
      kind: "agent-input",
      request: checkpoint.request,
      mode: "orchestrate",
      intent: "request",
      checkpoint,
      revision: null,
      acceptAnswersAfterUpdateId: 1,
    });

    assert.equal(store.peek("bob"), null);
    now = 10 * 60 * 1_000 - 1;
    assert.equal(store.peek("alice")?.kind, "agent-input");
    now = 10 * 60 * 1_000;
    assert.equal(store.peek("alice"), null);

    const restarted = new PendingStore(10 * 60 * 1_000, () => now);
    assert.equal(restarted.peek("alice"), null);
  });
});

function task(title: string) {
  return {
    title,
    dueAt: null,
    remindAt: null,
    importance: 2 as const,
  };
}
