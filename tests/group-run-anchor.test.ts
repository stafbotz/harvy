import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  groupRunInputAcknowledgement,
  renderGroupRunAnchor,
} from "../src/bot/group-run-anchor.js";
import { CLAIMED_GROUP_AUTHORITY_RESOLVER } from "../src/core/group-authority-policy.js";
import { GroupAgentRunService } from "../src/core/group-agent-run-service.js";
import type {
  GroupAgentRun,
  GroupRunInput,
  GroupRunParticipant,
} from "../src/domain/group-agent-run.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from "../src/storage/file-group-agent-run-repository.js";

const NOW = "2026-08-13T05:00:00.000Z";

const AYU: GroupRunParticipant = {
  participantId: "ayu@pn",
  identityAliases: [],
  displayName: "Ayu",
};

const BIMA: GroupRunParticipant = {
  participantId: "bima@pn",
  identityAliases: [],
  displayName: "Bima",
};

describe("Group Run Anchor", () => {
  it("merender status, atribusi, input, dan pertanyaan dengan copy group-safe", () => {
    const run = groupRun();
    run.inputs = [
      groupInput({
        id: "input-applied",
        sourceMessageId: "message-applied",
        actor: AYU,
        kind: "self_info",
        disposition: "applied",
        instructionRevision: 1,
      }),
      groupInput({
        id: "input-proposal",
        sourceMessageId: "message-proposal",
        actor: BIMA,
        kind: "constraint",
        disposition: "proposal",
        instructionRevision: null,
      }),
    ];
    run.questions = [{
      questionId: "question-1",
      prompt: "Sabtu pagi kamu bisa?",
      assignee: structuredClone(BIMA),
      messageId: "question-message-1",
      acceptAnswersAfterIngressRevision: 10,
      status: "open",
      askedAt: NOW,
      expiresAt: "2026-08-13T05:10:00.000Z",
      answeredBy: null,
      answerSourceMessageId: null,
      answeredAt: null,
    }];

    assert.equal(renderGroupRunAnchor(run), [
      "📌 Jadwal presentasi kelompok",
      "Diminta oleh: Ayu",
      "🟡 Sedang dikerjakan",
      "",
      "Sekarang: menyusun pekerjaan",
      "1 input diterapkan · 1 proposal menunggu keputusan",
      "",
      "Untuk Bima: Sabtu pagi kamu bisa?",
      "",
      "Untuk mengubah pekerjaan ini, balas pesan ini atau tag Harvy dan sebut pekerjaan ini.",
    ].join("\n"));
  });

  it("tidak menampilkan progres palsu, detail internal, atau klaim auto-pin", () => {
    const rendered = renderGroupRunAnchor(groupRun());

    assert.doesNotMatch(
      rendered,
      /(?:\b\d+%\b|ETA|model|worker|tool|runId|otomatis.*(?:pin|semat)|(?:pin|semat).*otomatis)/iu,
    );
    assert.match(rendered, /balas pesan ini atau tag Harvy/iu);
  });

  it("menghilangkan ajakan mutasi setelah run terminal", () => {
    const rendered = renderGroupRunAnchor(groupRun({
      status: "completed",
      phase: "completed",
      completedAt: "2026-08-13T05:05:00.000Z",
    }));

    assert.match(rendered, /🟢 Selesai/iu);
    assert.doesNotMatch(rendered, /untuk mengubah pekerjaan ini/iu);
  });

  it("memulai dan memasang anchor dengan kebijakan pin manual-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-run-anchor-"));
    let sequence = 0;
    const service = new GroupAgentRunService(
      new FileGroupAgentRunRepository(join(root, "group-runs.json")),
      CLAIMED_GROUP_AUTHORITY_RESOLVER,
      () => new Date(NOW),
      () => `id-${sequence += 1}`,
    );

    const started = await service.start({ message: groupMessage() });
    if (started.status !== "started") {
      assert.fail(`run baru tidak dimulai: ${started.status}`);
    }
    assert.equal(started.run.anchor.pinPolicy, "manual-only");
    assert.equal(started.run.anchor.messageId, null);

    const attached = await service.attachAnchor(
      started.run.runId,
      started.run.stateRevision,
      "anchor-message-1",
    );
    assert.equal(attached.anchor.messageId, "anchor-message-1");
    assert.equal(attached.anchor.pinPolicy, "manual-only");
    assert.doesNotMatch(renderGroupRunAnchor(attached), /(?:dipin|disematkan)/iu);
  });

  it("membedakan acknowledgement applied, proposal, dan cancel", () => {
    assert.match(groupRunInputAcknowledgement("applied"), /terikat/iu);
    assert.match(groupRunInputAcknowledgement("proposed"), /belum mengubah/iu);
    assert.match(groupRunInputAcknowledgement("cancelled"), /dibatalkan/iu);
  });
});

function groupMessage(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "group-1" },
    accountId: "account-1",
    messageId: "start-message-1",
    participantId: "ayu@pn",
    participantAliases: [],
    participantName: "Ayu",
    groupName: "Kelompok Biologi",
    text: "Harvy, bantu cari jadwal presentasi",
    at: NOW,
    mentionsHarvy: true,
    repliesToHarvy: false,
    isAdmin: false,
    ...overrides,
  };
}

function groupInput(
  overrides: Partial<GroupRunInput> & Pick<
    GroupRunInput,
    "id" | "sourceMessageId" | "actor" | "kind" | "disposition" |
      "instructionRevision"
  >,
): GroupRunInput {
  return {
    sourceIngressRevision: 11,
    quotedMessageId: "anchor-message-1",
    content: "input untuk pekerjaan grup",
    questionId: null,
    assignedOverride: false,
    authorityRole: "member",
    authorityEpoch: 1,
    receivedAt: NOW,
    ...structuredClone(overrides),
  };
}

function groupRun(overrides: Partial<GroupAgentRun> = {}): GroupAgentRun {
  return {
    version: 1,
    runId: "group-run-1",
    scopeKey: "whatsapp:group-1",
    scope: { channel: "whatsapp", groupId: "group-1" },
    accountId: "account-1",
    startSourceMessageId: "start-message-1",
    initialRequest: "Bantu cari jadwal presentasi",
    title: "Jadwal presentasi kelompok",
    initiator: structuredClone(AYU),
    startAuthority: { role: "member", authorityEpoch: 1 },
    participants: [structuredClone(AYU), structuredClone(BIMA)],
    audience: {
      kind: "group",
      visibility: "group-safe",
      scopeKey: "whatsapp:group-1",
    },
    status: "running",
    phase: "planning",
    instructionRevision: 1,
    appliedInstructionRevision: 0,
    stateRevision: 2,
    anchor: {
      platform: "whatsapp",
      messageId: "anchor-message-1",
      pinPolicy: "manual-only",
      updatedAt: NOW,
    },
    inputs: [],
    changeSets: [],
    questions: [],
    events: [],
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    expiresAt: "2026-08-20T05:00:00.000Z",
    ...overrides,
  };
}
