import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideGroupRunInput,
  groupRunTarget,
  type GroupRunPolicyInput,
} from "../src/core/group-agent-run-policy.js";
import type {
  GroupAgentRun,
  GroupRunParticipant,
} from "../src/domain/group-agent-run.js";
import type { GroupMessage } from "../src/domain/group.js";

const AYU: GroupRunParticipant = {
  participantId: "ayu@pn",
  identityAliases: ["ayu@lid"],
  displayName: "Ayu",
};

const BIMA: GroupRunParticipant = {
  participantId: "bima@pn",
  identityAliases: ["bima@lid"],
  displayName: "Bima",
};

describe("GroupAgentRun local policy", () => {
  it("mengisolasi pesan ambient dan quote yang tidak menargetkan run", () => {
    const run = groupRun();

    for (const candidate of [
      message({ text: "Sabtu pagi aku nggak bisa" }),
      message({
        text: "Jadwalnya sebaiknya Jumat",
        quotedMessageId: "pesan-anggota-lain",
      }),
      message({ text: "Tolong ubah pekerjaan ini" }),
    ]) {
      assert.equal(groupRunTarget(candidate, run, false), "none");
      assert.deepEqual(decideGroupRunInput({
        message: candidate,
        run,
        role: "member",
      }), {
        relation: "independent_chat",
        target: "none",
      });
    }
  });

  it("tidak melebur bubble bertarget dengan bubble ambient menjadi satu input", () => {
    const run = groupRun();
    const candidate: GroupRunPolicyInput["message"] &
      Pick<GroupMessage, "parts"> = {
        ...message({
          text: "Jadwalnya harus Jumat\nbtw kantin buka nggak?",
          quotedMessageId: "anchor-run-1",
        }),
        parts: [{
          messageId: "bubble-targeted",
          text: "Jadwalnya harus Jumat",
          at: "2026-08-13T05:01:00.000Z",
          mentionsHarvy: false,
          repliesToHarvy: true,
          quotedMessageId: "anchor-run-1",
          quotedParticipantId: "harvy",
        }, {
          messageId: "bubble-ambient",
          text: "btw kantin buka nggak?",
          at: "2026-08-13T05:01:01.000Z",
          mentionsHarvy: false,
          repliesToHarvy: false,
          quotedMessageId: null,
          quotedParticipantId: null,
        }],
      };

    assert.deepEqual(decideGroupRunInput({
      message: candidate,
      run,
      role: "member",
    }), {
      relation: "independent_chat",
      target: "none",
    });
  });

  it("mention Harvy tanpa referensi pekerjaan tetap merupakan chat independen", () => {
    const run = groupRun();
    const candidate = message({
      text: "Harvy, Sabtu aku nggak bisa",
      mentionsHarvy: true,
    });

    assert.equal(groupRunTarget(candidate, run, false), "none");
    assert.deepEqual(decideGroupRunInput({
      message: candidate,
      run,
      role: "member",
    }), {
      relation: "independent_chat",
      target: "none",
    });
  });

  it("reply ke anchor menargetkan run walau tanpa mention", () => {
    const run = groupRun();
    const candidate = message({
      text: "Jadwalnya harus selesai sebelum Jumat",
      quotedMessageId: "anchor-run-1",
    });

    assert.equal(groupRunTarget(candidate, run, false), "anchor");
    assert.deepEqual(decideGroupRunInput({
      message: candidate,
      run,
      role: "member",
    }), {
      relation: "mutation",
      target: "anchor",
      kind: "constraint",
      disposition: "proposal",
      questionId: null,
      assignedOverride: false,
    });
  });

  it("membedakan proposal anggota dari informasi tentang dirinya sendiri", () => {
    const run = groupRun();
    const proposal = decideGroupRunInput({
      message: message({
        text: "Presentasinya harus Jumat sore",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });
    const selfInfo = decideGroupRunInput({
      message: message({
        text: "Saya tidak bisa hari Jumat",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });

    assert.deepEqual(proposal, {
      relation: "mutation",
      target: "anchor",
      kind: "constraint",
      disposition: "proposal",
      questionId: null,
      assignedOverride: false,
    });
    assert.deepEqual(selfInfo, {
      relation: "mutation",
      target: "anchor",
      kind: "self_info",
      disposition: "applied",
      questionId: null,
      assignedOverride: false,
    });

    const firstPersonGroupDirective = decideGroupRunInput({
      message: message({
        text: "Saya menetapkan deadline kelompok hari Jumat",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });
    const deceptiveSelfInfo = decideGroupRunInput({
      message: message({
        text: "Saya bisa pilih Jumat untuk semuanya",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });
    const groupAvailabilityClaim = decideGroupRunInput({
      message: message({
        text: "Waktu saya dan semua orang harus Jumat",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });
    const anotherPersonsSchedule = decideGroupRunInput({
      message: message({
        text: "Jadwalku dan jadwal Bima harus Jumat",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });
    const smuggledReasons = [
      "Saya bisa Jumat karena semua harus ikut Sabtu",
      "Aku kosong pagi soalnya Bima wajib presentasi malam",
      "Saya tersedia Senin karena acaranya harus Selasa",
    ].map((text) => decideGroupRunInput({
      message: message({ text, quotedMessageId: "anchor-run-1" }),
      run,
      role: "member",
    }));
    assert.deepEqual(firstPersonGroupDirective, {
      relation: "mutation",
      target: "anchor",
      kind: "constraint",
      disposition: "proposal",
      questionId: null,
      assignedOverride: false,
    });
    assert.deepEqual(deceptiveSelfInfo, {
      relation: "mutation",
      target: "anchor",
      kind: "constraint",
      disposition: "proposal",
      questionId: null,
      assignedOverride: false,
    });
    for (const candidate of [
      groupAvailabilityClaim,
      anotherPersonsSchedule,
      ...smuggledReasons,
    ]) {
      assert.deepEqual(candidate, {
        relation: "mutation",
        target: "anchor",
        kind: "constraint",
        disposition: "proposal",
        questionId: null,
        assignedOverride: false,
      });
    }
  });

  it("membatasi cancel kepada initiator atau admin", () => {
    const run = groupRun();
    const memberCancel = decideGroupRunInput({
      message: message({
        text: "Batalkan pekerjaan ini",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });
    const initiatorCancel = decideGroupRunInput({
      message: message({
        participantId: "ayu@lid",
        text: "Batalkan pekerjaan ini",
      }),
      run,
      role: "member",
    });
    const adminCancel = decideGroupRunInput({
      message: message({ text: "Hentikan run ini" }),
      run,
      role: "admin",
    });

    assert.deepEqual(memberCancel, {
      relation: "forbidden",
      target: "anchor",
      reason: "initiator_or_admin_required",
    });
    assert.deepEqual(initiatorCancel, {
      relation: "mutation",
      target: "privileged-command",
      kind: "cancel",
      disposition: "applied",
      questionId: null,
      assignedOverride: false,
    });
    assert.deepEqual(adminCancel, {
      relation: "mutation",
      target: "privileged-command",
      kind: "cancel",
      disposition: "applied",
      questionId: null,
      assignedOverride: false,
    });
  });

  it("hanya menerima jawaban assignee atau override admin yang eksplisit", () => {
    const run = waitingForBima();
    const assigned = decideGroupRunInput({
      message: message({
        participantId: "bima@lid",
        text: "Sabtu pagi bisa",
        quotedMessageId: "question-bima-1",
      }),
      run,
      role: "member",
    });
    const anotherMember = decideGroupRunInput({
      message: message({
        text: "Bima sepertinya bisa",
        quotedMessageId: "question-bima-1",
      }),
      run,
      role: "member",
    });
    const implicitAdmin = decideGroupRunInput({
      message: message({
        text: "Bima bisa Sabtu",
        quotedMessageId: "question-bima-1",
      }),
      run,
      role: "admin",
    });
    const explicitAdmin = decideGroupRunInput({
      message: message({
        text: "Override: Sabtu bisa",
        quotedMessageId: "question-bima-1",
      }),
      run,
      role: "admin",
    });
    const assignedViaAnchor = decideGroupRunInput({
      message: message({
        participantId: "bima@lid",
        text: "Sabtu pagi tidak bisa",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });
    const adminViaAnchor = decideGroupRunInput({
      message: message({
        text: "Override: Sabtu bisa",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "admin",
    });
    const assigneeCorrection = decideGroupRunInput({
      message: message({
        participantId: "bima@lid",
        text: "Ralat tujuan: acaranya bukan Sabtu",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });
    const vagueQuestionReply = decideGroupRunInput({
      message: message({
        participantId: "bima@lid",
        text: "Sebentar, aku cek dulu",
        quotedMessageId: "question-bima-1",
      }),
      run,
      role: "member",
    });
    const vagueAnchorReply = decideGroupRunInput({
      message: message({
        participantId: "bima@lid",
        text: "Aku belum tahu, nanti kukabari",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });
    const assigneeQuestionCorrection = decideGroupRunInput({
      message: message({
        participantId: "bima@lid",
        text: "Ralat tujuan: ganti acaranya ke Sabtu",
        quotedMessageId: "question-bima-1",
      }),
      run,
      role: "member",
    });
    const vagueAdminOverride = decideGroupRunInput({
      message: message({
        text: "Override: saya belum tahu, nanti saya kabari",
        quotedMessageId: "question-bima-1",
      }),
      run,
      role: "admin",
    });
    const clarificationReplies = [
      "Bisa jelasin maksudnya?",
      "Maksudnya Jumat atau Sabtu?",
      "Jumat itu deadline tugas lain.",
    ].map((text) => decideGroupRunInput({
      message: message({
        participantId: "bima@lid",
        text,
        quotedMessageId: "question-bima-1",
      }),
      run,
      role: "member",
    }));
    const staleRun = waitingForBima();
    staleRun.questions.unshift({
      questionId: "question-old",
      prompt: "Minggu pagi bisa?",
      assignee: structuredClone(BIMA),
      messageId: "question-bima-old",
      acceptAnswersAfterIngressRevision: 5,
      status: "answered",
      askedAt: "2026-08-13T04:50:00.000Z",
      expiresAt: "2026-08-13T05:00:00.000Z",
      answeredBy: structuredClone(BIMA),
      answerSourceMessageId: "answer-old",
      answeredAt: "2026-08-13T04:51:00.000Z",
    });
    const staleQuestionReply = decideGroupRunInput({
      message: message({
        participantId: "bima@lid",
        text: "Ralat tujuan: ganti acaranya ke Sabtu",
        quotedMessageId: "question-bima-old",
      }),
      run: staleRun,
      role: "member",
    });

    assert.deepEqual(assigned, {
      relation: "mutation",
      target: "assigned-question",
      kind: "answer",
      disposition: "applied",
      questionId: "question-1",
      assignedOverride: false,
    });
    assert.deepEqual(anotherMember, {
      relation: "forbidden",
      target: "assigned-question",
      reason: "assigned_to_other_participant",
    });
    assert.deepEqual(implicitAdmin, {
      relation: "forbidden",
      target: "assigned-question",
      reason: "admin_override_must_be_explicit",
    });
    assert.deepEqual(explicitAdmin, {
      relation: "mutation",
      target: "assigned-question",
      kind: "answer",
      disposition: "applied",
      questionId: "question-1",
      assignedOverride: true,
    });
    assert.deepEqual(assignedViaAnchor, {
      relation: "mutation",
      target: "anchor",
      kind: "answer",
      disposition: "applied",
      questionId: "question-1",
      assignedOverride: false,
    });
    assert.deepEqual(adminViaAnchor, {
      relation: "mutation",
      target: "anchor",
      kind: "answer",
      disposition: "applied",
      questionId: "question-1",
      assignedOverride: true,
    });
    assert.deepEqual(assigneeCorrection, {
      relation: "mutation",
      target: "anchor",
      kind: "correction",
      disposition: "proposal",
      questionId: null,
      assignedOverride: false,
    });
    assert.deepEqual(vagueQuestionReply, {
      relation: "independent_chat",
      target: "none",
    });
    assert.deepEqual(vagueAnchorReply, {
      relation: "independent_chat",
      target: "none",
    });
    assert.deepEqual(assigneeQuestionCorrection, {
      relation: "mutation",
      target: "assigned-question",
      kind: "correction",
      disposition: "proposal",
      questionId: null,
      assignedOverride: false,
    });
    assert.deepEqual(vagueAdminOverride, {
      relation: "independent_chat",
      target: "none",
    });
    for (const clarification of clarificationReplies) {
      assert.deepEqual(clarification, {
        relation: "independent_chat",
        target: "none",
      });
    }
    assert.deepEqual(staleQuestionReply, {
      relation: "independent_chat",
      target: "none",
    });
  });

  it("mengenali status query tanpa mengubah run", () => {
    const run = groupRun();
    const anchorQuery = decideGroupRunInput({
      message: message({
        text: "Sampai mana?",
        quotedMessageId: "anchor-run-1",
      }),
      run,
      role: "member",
    });
    const explicitQuery = decideGroupRunInput({
      message: message({
        text: "Status pekerjaan ini?",
        mentionsHarvy: true,
      }),
      run,
      role: "member",
    });
    const unsupportedPause = decideGroupRunInput({
      message: message({
        participantId: "ayu@lid",
        text: "Jeda pekerjaan ini",
        mentionsHarvy: true,
      }),
      run,
      role: "member",
    });

    assert.deepEqual(anchorQuery, {
      relation: "status_query",
      target: "anchor",
    });
    assert.deepEqual(explicitQuery, {
      relation: "status_query",
      target: "explicit-reference",
    });
    assert.deepEqual(unsupportedPause, {
      relation: "independent_chat",
      target: "none",
    });
  });
});

function message(
  overrides: Partial<GroupRunPolicyInput["message"]> = {},
): GroupRunPolicyInput["message"] {
  return {
    participantId: "rani@pn",
    participantAliases: ["rani@lid"],
    text: "obrolan biasa",
    mentionsHarvy: false,
    quotedMessageId: null,
    ...overrides,
  };
}

function waitingForBima(): GroupAgentRun {
  const run = groupRun({
    status: "waiting_input",
    phase: "waiting_input",
  });
  run.questions = [{
    questionId: "question-1",
    prompt: "Sabtu pagi bisa?",
    assignee: structuredClone(BIMA),
    messageId: "question-bima-1",
    acceptAnswersAfterIngressRevision: 10,
    status: "open",
    askedAt: "2026-08-13T05:01:00.000Z",
    expiresAt: "2026-08-13T05:11:00.000Z",
    answeredBy: null,
    answerSourceMessageId: null,
    answeredAt: null,
  }];
  return run;
}

function groupRun(
  overrides: Partial<GroupAgentRun> = {},
): GroupAgentRun {
  return {
    version: 2,
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
    instructionRevision: 0,
    appliedInstructionRevision: 0,
    stateRevision: 2,
    anchor: {
      platform: "whatsapp",
      messageId: "anchor-run-1",
      pinPolicy: "manual-only",
      updatedAt: "2026-08-13T05:00:00.000Z",
    },
    pendingEffect: null,
    receipts: [],
    inputs: [],
    changeSets: [],
    questions: [],
    events: [],
    createdAt: "2026-08-13T05:00:00.000Z",
    updatedAt: "2026-08-13T05:00:00.000Z",
    completedAt: null,
    expiresAt: "2026-08-20T05:00:00.000Z",
    ...overrides,
  };
}
