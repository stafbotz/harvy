import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import type { Understanding } from "../src/ai/understand.js";
import { immediateUnderstandingRoute } from "../src/bot/understanding-route.js";
import { sessionAppliesToMessage } from "../src/core/session-policy.js";
import {
  CONVERSATION_EVAL_CASES,
  TURN_BOUNDARY_EVAL_CASES,
  TURN_INTERRUPTION_EVAL_CASES,
} from "../scripts/eval-corpus.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();

describe("corpus evaluasi percakapan", () => {
  it("memuat 61 skenario sintetis lintas jalur utama", () => {
    assert.equal(CONVERSATION_EVAL_CASES.length, 61);
    const ids = new Set(CONVERSATION_EVAL_CASES.map((testCase) => testCase.id));
    for (const required of [
      // Cakupan semantic dan routing ditambahkan 2026-08-28. Tanpa daftar ini,
      // satu-satunya assertion untuk semanticOperation dan toolNeed dapat
      // hilang tanpa satu tes pun berubah merah.
      "semantic-usage-summary",
      "semantic-none-on-plain-chat",
      "semantic-none-on-mention",
      "semantic-task-list-readonly",
      "toolneed-none-on-explanation",
      "toolneed-internal-state-agenda",
      "toolneed-external-web",
      "complexity-mechanical-greeting",
      "focus-compare-two-options",
      "focus-null-on-greeting",
      "memory-evidence-span",
      "memory-transient-not-durable",
      "memory-retraction-explicit",
      "priority-no-write",
      "listen-choice",
      "self-harm-danger",
      "danger-followup",
      "history-reference",
      "session-new-topic",
      "human-bridge",
      "memory-learning-preference",
      "memory-learning-preference-after-session",
      // Mutu review artefak kode ditambahkan 2026-08-29. Keempatnya
      // menjalankan kode balasan sungguhan lewat `codeCheck`; tanpa daftar
      // ini, satu-satunya pengukuran mutu kode dapat hilang tanpa satu tes
      // pun berubah merah.
      "code-empty-input",
      "code-reject-wrong-type",
      "code-no-mutation",
      "code-boundary",
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
        sessionAppliesToMessage(
          testCase.session,
          testCase.message,
          testCase.expectedSessionRelevant
            ? {
                version: 1,
                domain: "session",
                operation: testCase.expectedSessionSignal ?? "continue",
                target: null,
                subject: "self",
                reference: "current",
                explicitness: testCase.expectedSessionSignal
                  ? "explicit"
                  : "contextual",
                evidence: testCase.message,
                confidence: 0.95,
              }
            : null,
        ),
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

  it("memuat skenario boundary dan empat hubungan interupsi", () => {
    assert.ok(TURN_BOUNDARY_EVAL_CASES.length >= 14);
    const boundaryIds = new Set(
      TURN_BOUNDARY_EVAL_CASES.map((testCase) => testCase.id),
    );
    assert.equal(boundaryIds.has("boundary-user-burst-open"), true);
    assert.equal(boundaryIds.has("boundary-quick-calculation"), true);
    assert.equal(
      boundaryIds.has("boundary-quick-fact-no-punctuation"),
      true,
    );
    assert.equal(boundaryIds.has("boundary-full-narrative-burst"), true);
    assert.equal(boundaryIds.has("boundary-contextual-closed-response"), true);
    assert.equal(boundaryIds.has("boundary-immediate-danger"), true);

    assert.deepEqual(
      new Set(
        TURN_INTERRUPTION_EVAL_CASES.map(
          (testCase) => testCase.expectedRelation,
        ),
      ),
      new Set(["addition", "correction", "redirect", "independent"]),
    );
  });

  it("memisahkan eval bounded dari corpus penuh", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as {
      scripts?: {
        "eval:conversation"?: string;
        "eval:conversation:full"?: string;
      };
    };

    assert.equal(
      packageJson.scripts?.["eval:conversation"],
      "tsx scripts/evaluasi-percakapan.ts --conversation-only --compact",
    );
    assert.equal(
      packageJson.scripts?.["eval:conversation:full"],
      "tsx scripts/evaluasi-percakapan.ts --all --compact",
    );
  });

  it("menolak selector eval ambigu sebelum memanggil provider", async () => {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve(repositoryRoot, "scripts/evaluasi-percakapan.ts"),
          "--all",
          "--limit=1",
          "--conversation-only",
          "--compact",
        ],
        { cwd: repositoryRoot },
      ),
      /--all tidak dapat digabung dengan --limit atau --case/u,
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
