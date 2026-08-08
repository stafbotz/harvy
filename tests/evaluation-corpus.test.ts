import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Understanding } from "../src/ai/understand.js";
import { immediateUnderstandingRoute } from "../src/bot/understanding-route.js";
import { sessionAppliesToMessage } from "../src/core/session-policy.js";
import { CONVERSATION_EVAL_CASES } from "../scripts/eval-corpus.js";

describe("corpus evaluasi percakapan", () => {
  it("memuat 42 skenario sintetis lintas jalur utama", () => {
    assert.equal(CONVERSATION_EVAL_CASES.length, 42);
    const ids = new Set(CONVERSATION_EVAL_CASES.map((testCase) => testCase.id));
    for (const required of [
      "priority-no-write",
      "listen-choice",
      "self-harm-danger",
      "danger-followup",
      "history-reference",
      "session-new-topic",
      "human-bridge",
    ]) {
      assert.equal(ids.has(required), true, `kasus ${required} hilang`);
    }
  });

  it("pagar kode menolak usulan save pada semua kasus tanpa izin", () => {
    for (const testCase of CONVERSATION_EVAL_CASES) {
      if (testCase.forbidTaskMutation === false) continue;
      assert.notEqual(
        immediateUnderstandingRoute(taskProposal(), testCase.message).kind,
        "save-task",
        testCase.id,
      );
    }
  });

  it("ekspektasi hubungan sesi dijaga kebijakan lokal", () => {
    for (const testCase of CONVERSATION_EVAL_CASES) {
      if (!testCase.session || testCase.expectedSessionRelevant === undefined) {
        continue;
      }
      assert.equal(
        sessionAppliesToMessage(testCase.session, testCase.message),
        testCase.expectedSessionRelevant,
        testCase.id,
      );
    }
  });

  it("menyimpan assertion kualitas untuk menyimak, cerita panjang, dan selesai sesi", () => {
    const byId = new Map(
      CONVERSATION_EVAL_CASES.map((testCase) => [testCase.id, testCase]),
    );

    assert.equal(byId.get("listen-choice")?.forbidAdvice, true);
    assert.equal(byId.get("listen-choice")?.expectNoButtons, true);
    assert.ok(
      (byId.get("long-story-depth")?.requiredTopicGroups?.length ?? 0) >= 4,
    );
    assert.ok((byId.get("long-story-depth")?.minTopicGroups ?? 0) >= 3);
    assert.equal(
      byId.get("session-explicit-done")?.expectedSessionSignal,
      "done",
    );
  });
});

function taskProposal(): Understanding {
  return {
    intent: "task",
    taskAction: "save",
    memoryAction: null,
    controlAction: null,
    riskHint: { level: "none", confidence: 1 },
    safetySensitive: false,
    needsStepByStep: false,
    sessionSignal: null,
    suggestedActions: [],
    actionGoal: null,
    task: {
      title: "Usulan model",
      dueAt: null,
      remindAt: null,
      importance: 2,
    },
    memories: [],
  };
}
