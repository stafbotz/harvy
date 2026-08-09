import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyRunMailboxLocally,
  mailboxKindForRelation,
} from "../src/core/run-mailbox-policy.js";
import {
  renderRunAnchor,
  runCancellationAcknowledgement,
  runMailboxCapacityNotice,
} from "../src/bot/run-anchor.js";
import type { ActiveAgentRun } from "../src/domain/agent-run.js";

describe("RunMailbox local routing", () => {
  it("membiarkan chat tak terkait dan mengenali status tanpa model", () => {
    const run = activeRun();
    assert.equal(
      classifyRunMailboxLocally({ text: "makasih", run }),
      "independent_chat",
    );
    assert.equal(
      classifyRunMailboxLocally({ text: "udah sampai mana?", run }),
      "status_query",
    );
    assert.equal(
      classifyRunMailboxLocally({ text: "batal", run }),
      "independent_chat",
    );
    assert.equal(
      classifyRunMailboxLocally({ text: "batalin pekerjaan tadi", run }),
      "cancel",
    );
  });

  it("hanya merutekan update ketika quote atau target eksplisit mengikat run", () => {
    const run = activeRun();
    assert.equal(
      classifyRunMailboxLocally({
        text: "Jangan buat reminder dulu",
        run,
      }),
      "independent_chat",
    );
    assert.equal(
      classifyRunMailboxLocally({
        text: "Jangan buat reminder dulu",
        run,
        quotedMessageId: "anchor-1",
      }),
      "correction",
    );
    assert.equal(
      classifyRunMailboxLocally({
        text: "Sekalian tambahkan latihan",
        run,
        quotedMessageId: "anchor-1",
      }),
      "scope_expansion",
    );
    assert.equal(mailboxKindForRelation("scope_expansion"), "scope_change");
  });

  it("jawaban menargetkan question/anchor dan tidak mengonsumsi pesan berikutnya", () => {
    const run = activeRun({ status: "waiting_input", phase: "waiting_input" });
    run.pendingQuestion = {
      questionId: "question-1",
      prompt: "Sabtu pagi bisa?",
      askedAt: run.updatedAt,
      expiresAt: run.expiresAt,
      acceptAnswersAfterUpdateId: 10,
      messageId: "question-message",
    };
    assert.equal(
      classifyRunMailboxLocally({ text: "bisa", run }),
      "independent_chat",
    );
    assert.equal(
      classifyRunMailboxLocally({
        text: "bisa",
        run,
        quotedMessageId: "question-message",
      }),
      "answer_to_run",
    );
    assert.equal(
      classifyRunMailboxLocally({
        text: "Jangan buat reminder dulu",
        run,
        quotedMessageId: "anchor-1",
      }),
      "correction",
    );
  });
});

describe("Run Anchor", () => {
  it("merender fase nyata tanpa identifier model/tool atau progres palsu", () => {
    const rendered = renderRunAnchor(activeRun());
    assert.match(rendered, /Sedang dikerjakan/iu);
    assert.match(rendered, /menyusun pilihan/iu);
    assert.match(rendered, /tetap bisa ngobrol/iu);
    assert.doesNotMatch(rendered, /worker #|terra|kimi|tool|hampir selesai/iu);
  });

  it("membedakan waiting input dan pembatalan sesudah efek", () => {
    const run = activeRun({ status: "waiting_input", phase: "waiting_input" });
    run.pendingQuestion = {
      questionId: "question-1",
      prompt: "Sabtu pagi bisa?",
      askedAt: run.updatedAt,
      expiresAt: run.expiresAt,
      acceptAnswersAfterUpdateId: 10,
      messageId: null,
    };
    const rendered = renderRunAnchor(run);
    assert.match(rendered, /Perlu jawabanmu/iu);
    assert.match(rendered, /Sabtu pagi bisa/iu);
    assert.doesNotMatch(rendered, /Sedang dikerjakan/iu);
    assert.match(runCancellationAcknowledgement(1), /tidak.*terurungkan/iu);
    assert.match(runMailboxCapacityNotice(), /belum masuk.*kirim lagi/iu);
  });

  it("membatasi pertanyaan panjang agar satu Anchor tetap muat di Telegram", () => {
    const run = activeRun({ status: "waiting_input", phase: "waiting_input" });
    run.pendingQuestion = {
      questionId: "question-long",
      prompt: "Pertanyaan ".repeat(800),
      askedAt: run.updatedAt,
      expiresAt: run.expiresAt,
      acceptAnswersAfterUpdateId: 10,
      messageId: "question-message",
    };
    const rendered = renderRunAnchor(run);
    assert.ok(rendered.length <= 3_900);
    assert.match(rendered, /…$/u);
  });

  it("menjelaskan delivery ambigu tanpa menjanjikan retry otomatis", () => {
    const run = activeRun({
      status: "partial",
      phase: "failed",
      completedAt: "2026-08-09T05:02:00.000Z",
      lastError: {
        stage: "delivery",
        code: "delivery_outcome_unknown",
        at: "2026-08-09T05:02:00.000Z",
      },
    });
    const rendered = renderRunAnchor(run);
    assert.match(rendered, /tidak dapat dipastikan/iu);
    assert.match(rendered, /tidak akan mengirim ulang otomatis/iu);
  });
});

function activeRun(
  overrides: Partial<ActiveAgentRun> = {},
): ActiveAgentRun {
  return {
    version: 2,
    scopeKey: "private:telegram:alice",
    channel: "telegram",
    ownerId: "alice",
    runId: "run-active",
    initialRequest: "Buat rencana belajar sampai ujian",
    mode: "orchestrate",
    intent: "request",
    timeZone: "Asia/Jakarta",
    style: null,
    status: "running",
    phase: "planning",
    contextRevision: 1,
    instructionRevision: 1,
    appliedInstructionRevision: 1,
    revision: 1,
    context: { summary: null, turns: [], memories: [] },
    mailbox: [],
    changeSets: [],
    workUnits: [{
      id: "planner-1",
      role: "planner",
      label: "Menyusun pekerjaan",
      status: "running",
      inputRevision: 1,
    }],
    events: [],
    receipts: [],
    anchor: {
      platform: "telegram",
      chatId: "alice",
      messageId: "anchor-1",
      updatedAt: "2026-08-09T05:00:00.000Z",
    },
    checkpoint: null,
    pendingQuestion: null,
    resumeAnswer: null,
    pendingEffect: null,
    result: null,
    lastError: null,
    turnId: "turn-1",
    createdAt: "2026-08-09T05:00:00.000Z",
    startedAt: "2026-08-09T05:00:00.000Z",
    updatedAt: "2026-08-09T05:00:00.000Z",
    completedAt: null,
    expiresAt: "2026-08-16T05:00:00.000Z",
    ...overrides,
  };
}
