import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  GroupAgentRunAuthorityError,
  GroupAgentRunConflictError,
  GroupAgentRunMessageCollisionError,
  GroupAgentRunService,
} from "../src/core/group-agent-run-service.js";
import type {
  GroupAuthorityRequest,
  GroupAuthorityResolver,
  GroupAuthoritySnapshot,
} from "../src/core/group-authority-policy.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from "../src/storage/file-group-agent-run-repository.js";

const NOW = new Date("2026-08-13T12:00:00.000Z");

describe("group agent run service", () => {
  it("menegakkan satu foreground per grup dan replay start idempotent", async () => {
    const service = await serviceFixture();
    const startMessage = message({
      messageId: "start-1",
      text: "Harvy, bantu susun jadwal presentasi kelompok",
      mentionsHarvy: true,
    });
    const first = await service.start({ message: startMessage });
    assert.equal(first.status, "started");
    assert.equal(first.run.audience.visibility, "group-safe");
    assert.equal(first.run.anchor.pinPolicy, "manual-only");
    assert.equal(first.run.participants.length, 1);

    const replay = await service.start({ message: startMessage });
    assert.equal(replay.status, "replayed");
    assert.equal(replay.run.runId, first.run.runId);

    const competing = await service.start({
      message: message({
        messageId: "start-2",
        text: "Harvy, buat agenda lain",
        mentionsHarvy: true,
      }),
    });
    assert.equal(competing.status, "active-run-exists");
    assert.equal(competing.run.runId, first.run.runId);

    const otherGroup = await service.start({
      message: message({
        scope: { channel: "whatsapp", groupId: "grup-lain@g.us" },
        messageId: "start-3",
        text: "Harvy, bantu grup ini",
        mentionsHarvy: true,
      }),
    });
    assert.equal(otherGroup.status, "started");
    assert.notEqual(otherGroup.run.runId, first.run.runId);

    const cancelled = await service.routeMessage(message({
      messageId: "cancel-first",
      text: "batalkan pekerjaan ini",
      mentionsHarvy: true,
    }));
    assert.equal(cancelled.status, "cancelled");
    const terminalReplay = await service.start({ message: startMessage });
    assert.equal(terminalReplay.status, "replayed");
    assert.equal(terminalReplay.run.runId, first.run.runId);

    const active = await service.start({
      message: message({
        messageId: "start-account-a",
        text: "Harvy, bantu pekerjaan account A",
        mentionsHarvy: true,
      }),
    });
    assert.equal(active.status, "started");
    await assert.rejects(
      service.start({
        message: message({
          accountId: "account-b",
          messageId: "start-account-b",
          text: "Harvy, bantu pekerjaan account B",
          mentionsHarvy: true,
        }),
      }),
      GroupAgentRunAuthorityError,
    );
  });

  it("mengabaikan ambient, mengatribusi self-info, dan menyimpan constraint anggota sebagai proposal", async () => {
    let authorityCalls = 0;
    const service = await serviceFixture({
      authority: resolver((request) => {
        authorityCalls += 1;
        return snapshotFor(request);
      }),
    });
    const started = await service.start({
      message: message({
        messageId: "start-routing",
        text: "Harvy, atur jadwal presentasi ini",
        mentionsHarvy: true,
      }),
    });
    const anchored = await service.attachAnchor(
      started.run.runId,
      started.run.stateRevision,
      "anchor-routing",
    );
    const callsAfterStart = authorityCalls;

    assert.deepEqual(
      await service.routeMessage(message({
        participantId: "p2",
        participantAliases: [],
        participantName: "Bima",
        messageId: "ambient-1",
        text: "besok kantin buka ga?",
      })),
      { status: "independent" },
    );
    assert.equal(authorityCalls, callsAfterStart);

    const selfInfo = await service.routeMessage(message({
      participantId: "p2",
      participantAliases: [],
      participantName: "Bima",
      messageId: "input-self",
      text: "aku tidak bisa Jumat sore",
      quotedMessageId: "anchor-routing",
      repliesToHarvy: true,
    }));
    assert.equal(selfInfo.status, "applied");
    if (selfInfo.status !== "applied") return;
    assert.equal(selfInfo.run.instructionRevision, 1);
    assert.equal(selfInfo.run.inputs[0]?.actor.participantId, "p2");
    assert.equal(selfInfo.run.changeSets[0]?.sourceMessageId, "input-self");
    assert.equal(selfInfo.run.participants.length, 2);

    const proposal = await service.routeMessage(message({
      participantId: "p3",
      participantAliases: [],
      participantName: "Citra",
      messageId: "input-proposal",
      text: "Jumat sebaiknya jangan dipakai sama sekali",
      quotedMessageId: "anchor-routing",
      repliesToHarvy: true,
    }));
    assert.equal(proposal.status, "proposed");
    if (proposal.status !== "proposed") return;
    assert.equal(proposal.run.instructionRevision, 1);
    assert.equal(proposal.run.inputs.at(-1)?.disposition, "proposal");

    const forbiddenCancel = await service.routeMessage(message({
      participantId: "p3",
      participantAliases: [],
      participantName: "Citra",
      messageId: "cancel-member",
      text: "batalkan pekerjaan ini",
      quotedMessageId: "anchor-routing",
      repliesToHarvy: true,
    }));
    assert.equal(forbiddenCancel.status, "forbidden");
    if (forbiddenCancel.status === "forbidden") {
      assert.equal(forbiddenCancel.reason, "initiator_or_admin_required");
    }

    const latest = await service.routeMessage(message({
      participantId: "p1",
      participantAliases: [],
      participantName: "Ayu",
      messageId: "status-initiator",
      text: "status pekerjaan ini?",
      mentionsHarvy: true,
    }));
    assert.equal(latest.status, "status");
    if (latest.status === "status") {
      assert.equal(latest.run.stateRevision, proposal.run.stateRevision);
      assert.equal(latest.run.status, anchored.status);
    }
  });

  it("mengikat jawaban ke assignee dan hanya mengizinkan override admin eksplisit", async () => {
    const service = await serviceFixture();
    const started = await service.start({
      message: message({
        messageId: "start-question",
        text: "Harvy, koordinasikan jadwal ini",
        mentionsHarvy: true,
      }),
    });
    const anchored = await service.attachAnchor(
      started.run.runId,
      started.run.stateRevision,
      "anchor-question",
    );
    const waiting = await service.recordAssignedQuestion({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      prompt: "Sabtu pagi kamu bisa?",
      assignee: {
        participantId: "p2",
        identityAliases: ["p2-alt"],
        displayName: "Bima",
      },
      messageId: "question-bima",
      acceptAnswersAfterIngressRevision: 10,
    });
    assert.equal(waiting.status, "waiting_input");

    const delayedBeforeQuestion = await service.routeMessage(message({
      participantId: "p2",
      participantAliases: ["p2-alt"],
      participantName: "Bima",
      messageId: "delayed-before-question",
      text: "Sabtu pagi bisa",
      quotedMessageId: "question-bima",
      repliesToHarvy: true,
      ingressRevision: 10,
    }));
    assert.deepEqual(delayedBeforeQuestion, { status: "independent" });

    const other = await service.routeMessage(message({
      participantId: "p3",
      participantAliases: [],
      participantName: "Citra",
      messageId: "guess-bima",
      text: "Bima kayaknya bisa",
      quotedMessageId: "question-bima",
      repliesToHarvy: true,
    }));
    assert.equal(other.status, "forbidden");
    if (other.status === "forbidden") {
      assert.equal(other.reason, "assigned_to_other_participant");
    }

    const adminImplicit = await service.routeMessage(message({
      participantId: "admin-1",
      participantAliases: [],
      participantName: "Dina",
      messageId: "admin-guess",
      text: "Bima bisa Sabtu",
      quotedMessageId: "question-bima",
      repliesToHarvy: true,
      isAdmin: false,
      ingressRevision: 11,
    }));
    assert.equal(adminImplicit.status, "forbidden");
    if (adminImplicit.status === "forbidden") {
      assert.equal(adminImplicit.reason, "admin_override_must_be_explicit");
    }

    const override = await service.routeMessage(message({
      participantId: "admin-1",
      participantAliases: [],
      participantName: "Dina",
      messageId: "admin-override",
      text: "override: Sabtu bisa",
      quotedMessageId: "question-bima",
      repliesToHarvy: true,
      isAdmin: false,
      ingressRevision: 11,
    }));
    assert.equal(override.status, "applied");
    if (override.status !== "applied") return;
    assert.equal(override.run.status, "running");
    assert.equal(override.run.phase, "replanning");
    assert.equal(override.run.questions[0]?.status, "answered");
    assert.equal(
      override.run.questions[0]?.answeredBy?.participantId,
      "admin-1",
    );
    assert.equal(
      override.run.questions[0]?.answerSourceMessageId,
      "admin-override",
    );
    assert.equal(override.run.inputs.at(-1)?.assignedOverride, true);
  });

  it("menerima jawaban assignee melalui alias dan menolak perubahan authority di commit barrier", async () => {
    const base = await serviceFixture();
    const started = await base.start({
      message: message({
        messageId: "start-assignee",
        text: "Harvy, koordinasikan jadwal lain",
        mentionsHarvy: true,
      }),
    });
    const anchored = await base.attachAnchor(
      started.run.runId,
      started.run.stateRevision,
      "anchor-assignee",
    );
    const waiting = await base.recordAssignedQuestion({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      prompt: "Jumat pagi bisa?",
      assignee: {
        participantId: "p2",
        identityAliases: ["p2-alt"],
        displayName: "Bima",
      },
      messageId: "question-assignee",
      acceptAnswersAfterIngressRevision: 10,
    });
    assert.equal(waiting.status, "waiting_input");
    const answer = await base.routeMessage(message({
      participantId: "p2-alt",
      participantAliases: ["p2"],
      participantName: "Bima",
      messageId: "answer-assignee",
      text: "bisa",
      quotedMessageId: "question-assignee",
      repliesToHarvy: true,
      ingressRevision: 11,
    }));
    assert.equal(answer.status, "applied");
    if (answer.status === "applied") {
      assert.equal(answer.run.questions[0]?.answeredBy?.participantId, "p2-alt");
    }

    const staleFile = await temporaryFile();
    const stable = serviceFor(staleFile);
    const staleStarted = await stable.start({
      message: message({
        messageId: "start-stale",
        text: "Harvy, buat pekerjaan ini",
        mentionsHarvy: true,
      }),
    });
    const staleAnchored = await stable.attachAnchor(
      staleStarted.run.runId,
      staleStarted.run.stateRevision,
      "anchor-stale",
    );
    let calls = 0;
    const changing = serviceFor(staleFile, resolver((request) => ({
      role: request.participantIds.includes("admin-1") ? "admin" : "member",
      authorityEpoch: ++calls,
    })));
    const stale = await changing.routeMessage(message({
      participantId: "p2",
      participantAliases: [],
      participantName: "Bima",
      messageId: "input-stale",
      text: "aku tidak bisa Senin",
      quotedMessageId: "anchor-stale",
      repliesToHarvy: true,
    }));
    assert.equal(stale.status, "forbidden");
    if (stale.status === "forbidden") assert.equal(stale.reason, "authority_changed");
    assert.equal(
      (await new FileGroupAgentRunRepository(staleFile).load(staleAnchored.runId))
        ?.inputs.length,
      0,
    );
    await assert.rejects(
      changing.recordAssignedQuestion({
        runId: staleAnchored.runId,
        expectedStateRevision: staleAnchored.stateRevision,
        prompt: "Besok kamu bisa?",
        assignee: {
          participantId: "p2",
          identityAliases: [],
          displayName: "Bima",
        },
        messageId: "question-stale-authority",
        acceptAnswersAfterIngressRevision: 10,
      }),
      GroupAgentRunConflictError,
    );
    assert.equal(
      (await new FileGroupAgentRunRepository(staleFile).load(staleAnchored.runId))
        ?.questions.length,
      0,
    );
  });

  it("membuat replay mailbox no-op, menolak collision, dan mempertahankan dua update konkuren", async () => {
    const service = await serviceFixture();
    const started = await service.start({
      message: message({
        messageId: "start-idempotent",
        text: "Harvy, susun pekerjaan ini",
        mentionsHarvy: true,
      }),
    });
    await service.attachAnchor(
      started.run.runId,
      started.run.stateRevision,
      "anchor-idempotent",
    );
    const envelope = message({
      participantId: "p2",
      participantAliases: [],
      participantName: "Bima",
      messageId: "same-source",
      text: "aku hanya bisa pagi",
      quotedMessageId: "anchor-idempotent",
      repliesToHarvy: true,
    });
    const first = await service.routeMessage(envelope);
    assert.equal(first.status, "applied");
    const replay = await service.routeMessage(envelope);
    assert.equal(replay.status, "applied");
    if (replay.status === "applied") {
      assert.equal(replay.replayed, true);
      assert.equal(replay.run.inputs.length, 1);
    }
    await assert.rejects(
      service.routeMessage({ ...envelope, text: "aku hanya bisa malam" }),
      GroupAgentRunMessageCollisionError,
    );

    const [left, right] = await Promise.all([
      service.routeMessage(message({
        participantId: "p3",
        participantAliases: [],
        participantName: "Citra",
        messageId: "concurrent-left",
        text: "aku kosong Selasa",
        quotedMessageId: "anchor-idempotent",
        repliesToHarvy: true,
      })),
      service.routeMessage(message({
        participantId: "p4",
        participantAliases: [],
        participantName: "Doni",
        messageId: "concurrent-right",
        text: "aku kosong Rabu",
        quotedMessageId: "anchor-idempotent",
        repliesToHarvy: true,
      })),
    ]);
    assert.equal(left.status, "applied");
    assert.equal(right.status, "applied");
    const run = left.status === "applied"
      ? await service.routeMessage(message({
          messageId: "status-after-concurrent",
          text: "status pekerjaan ini?",
          mentionsHarvy: true,
        }))
      : null;
    assert.equal(run?.status, "status");
    if (run?.status === "status") {
      assert.equal(run.run.inputs.length, 3);
      assert.equal(run.run.instructionRevision, 3);
    }
  });

  it("menutup pertanyaan saat cancel dan menolak jawaban setelah horizon", async () => {
    let now = new Date(NOW);
    const file = await temporaryFile();
    let sequence = 0;
    const service = new GroupAgentRunService(
      new FileGroupAgentRunRepository(file),
      resolver(snapshotFor),
      () => now,
      () => `expiry-id-${++sequence}`,
    );
    const started = await service.start({
      message: message({
        messageId: "start-expiry",
        text: "Harvy, koordinasikan jadwal expiry",
        mentionsHarvy: true,
      }),
    });
    const anchored = await service.attachAnchor(
      started.run.runId,
      started.run.stateRevision,
      "anchor-expiry",
    );
    const waiting = await service.recordAssignedQuestion({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      prompt: "Besok bisa?",
      assignee: {
        participantId: "p2",
        identityAliases: [],
        displayName: "Bima",
      },
      messageId: "question-expiry",
      acceptAnswersAfterIngressRevision: 10,
    });
    const cancelled = await service.routeMessage(message({
      messageId: "cancel-waiting",
      text: "batalkan pekerjaan ini",
      quotedMessageId: "anchor-expiry",
      repliesToHarvy: true,
    }));
    assert.equal(cancelled.status, "cancelled");
    if (cancelled.status === "cancelled") {
      assert.equal(cancelled.run.questions[0]?.status, "cancelled");
      assert.equal(cancelled.run.status, "cancelled");
    }

    const second = await service.start({
      message: message({
        messageId: "start-after-cancel",
        text: "Harvy, koordinasikan jadwal baru",
        mentionsHarvy: true,
      }),
    });
    assert.equal(second.status, "started");
    const secondAnchor = await service.attachAnchor(
      second.run.runId,
      second.run.stateRevision,
      "anchor-after-cancel",
    );
    await service.recordAssignedQuestion({
      runId: secondAnchor.runId,
      expectedStateRevision: secondAnchor.stateRevision,
      prompt: "Lusa bisa?",
      assignee: {
        participantId: "p2",
        identityAliases: [],
        displayName: "Bima",
      },
      messageId: "question-after-cancel",
      acceptAnswersAfterIngressRevision: 20,
    });
    now = new Date(NOW.getTime() + 10 * 60 * 1_000 + 1);
    const expiredAnswer = await service.routeMessage(message({
      participantId: "p2",
      participantAliases: [],
      participantName: "Bima",
      messageId: "late-answer",
      text: "bisa",
      quotedMessageId: "question-after-cancel",
      repliesToHarvy: true,
      ingressRevision: 21,
      at: now.toISOString(),
    }));
    assert.equal(expiredAnswer.status, "forbidden");
    if (expiredAnswer.status === "forbidden") {
      assert.equal(expiredAnswer.reason, "run_terminal");
      assert.equal(expiredAnswer.run.status, "failed");
      assert.equal(expiredAnswer.run.questions[0]?.status, "expired");
      assert.equal(expiredAnswer.run.inputs.length, 0);
    }
    assert.equal(waiting.status, "waiting_input");
  });

  it("menolak jawaban bila horizon lewat tepat sebelum commit", async () => {
    let now = new Date(NOW);
    let routePhase = false;
    let routeAuthorityCalls = 0;
    let sequence = 0;
    const file = await temporaryFile();
    const service = new GroupAgentRunService(
      new FileGroupAgentRunRepository(file),
      resolver((request) => {
        if (routePhase) {
          routeAuthorityCalls += 1;
          if (routeAuthorityCalls === 2) {
            now = new Date("2026-08-13T12:00:01.001Z");
          }
        }
        return snapshotFor(request);
      }),
      () => now,
      () => `expiry-race-${++sequence}`,
    );
    const started = await service.start({
      message: message({
        messageId: "start-expiry-race",
        text: "Harvy, cek jadwal ini",
        mentionsHarvy: true,
      }),
    });
    const anchored = await service.attachAnchor(
      started.run.runId,
      started.run.stateRevision,
      "anchor-expiry-race",
    );
    await service.recordAssignedQuestion({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      prompt: "Sekarang bisa?",
      assignee: {
        participantId: "p2",
        identityAliases: [],
        displayName: "Bima",
      },
      messageId: "question-expiry-race",
      acceptAnswersAfterIngressRevision: 10,
      expiresAt: "2026-08-13T12:00:01.000Z",
    });

    now = new Date("2026-08-13T12:00:00.999Z");
    routePhase = true;
    const lateAtCommit = await service.routeMessage(message({
      participantId: "p2",
      participantAliases: [],
      participantName: "Bima",
      messageId: "answer-expiry-race",
      text: "bisa",
      quotedMessageId: "question-expiry-race",
      repliesToHarvy: true,
      ingressRevision: 11,
      at: now.toISOString(),
    }));
    assert.equal(lateAtCommit.status, "forbidden");
    if (lateAtCommit.status === "forbidden") {
      assert.equal(lateAtCommit.reason, "run_terminal");
      assert.equal(lateAtCommit.run.status, "failed");
      assert.equal(lateAtCommit.run.questions[0]?.status, "expired");
      assert.equal(lateAtCommit.run.inputs.length, 0);
    }
  });

  it("menyisakan kapasitas untuk jawaban dan cancel", async () => {
    const file = await temporaryFile();
    const service = serviceFor(file);
    const started = await service.start({
      message: message({
        messageId: "start-capacity",
        text: "Harvy, buat rencana kapasitas ini",
        mentionsHarvy: true,
      }),
    });
    const full = structuredClone(started.run);
    full.inputs = Array.from({ length: 62 }, (_, index) => ({
      id: `proposal-capacity-${index}`,
      sourceMessageId: `proposal-message-${index}`,
      sourceIngressRevision: null,
      actor: structuredClone(full.initiator),
      quotedMessageId: null,
      kind: "constraint" as const,
      disposition: "proposal" as const,
      content: `proposal ${index}`,
      questionId: null,
      assignedOverride: false,
      authorityRole: "member" as const,
      authorityEpoch: 7,
      instructionRevision: null,
      receivedAt: NOW.toISOString(),
    }));
    await writeFile(
      file,
      `${JSON.stringify({ version: 1, runs: [full] }, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(
      service.recordAssignedQuestion({
        runId: full.runId,
        expectedStateRevision: full.stateRevision,
        prompt: "Masih bisa?",
        assignee: structuredClone(full.initiator),
        messageId: "question-capacity",
        acceptAnswersAfterIngressRevision: 10,
      }),
      GroupAgentRunConflictError,
    );
    const cancelled = await service.routeMessage(message({
      messageId: "cancel-capacity",
      text: "batalkan pekerjaan ini",
      mentionsHarvy: true,
    }));
    assert.equal(cancelled.status, "cancelled");
    if (cancelled.status === "cancelled") {
      assert.equal(cancelled.run.inputs.length, 63);
    }
  });
});

describe("file group agent run repository", () => {
  it("pulih lintas instance, menegakkan CAS, dan menolak audience yang dirusak", async () => {
    const file = await temporaryFile();
    const service = serviceFor(file);
    const started = await service.start({
      message: message({
        messageId: "start-durable",
        text: "Harvy, bantu tugas ini",
        mentionsHarvy: true,
      }),
    });
    const first = new FileGroupAgentRunRepository(file);
    const second = new FileGroupAgentRunRepository(file);
    assert.equal((await second.load(started.run.runId))?.stateRevision, 1);

    const draft = { ...started.run };
    const { stateRevision: _stateRevision, ...withoutRevision } = draft;
    const saved = await first.save(withoutRevision, 1, async () => true);
    assert.equal(saved.status, "saved");
    assert.deepEqual(
      await second.save(withoutRevision, 1, async () => true),
      { status: "conflict" },
    );

    const database = JSON.parse(await readFile(file, "utf8")) as {
      version: 1;
      runs: Array<{ audience: { scopeKey: string } }>;
    };
    database.runs[0]!.audience.scopeKey = "whatsapp:grup-lain@g.us";
    await writeFile(file, `${JSON.stringify(database, null, 2)}\n`, "utf8");
    await assert.rejects(
      second.load(started.run.runId),
      /audience GroupAgentRun tidak sah/iu,
    );
  });
});

async function serviceFixture(options: {
  authority?: GroupAuthorityResolver;
} = {}): Promise<GroupAgentRunService> {
  return serviceFor(await temporaryFile(), options.authority);
}

function serviceFor(
  file: string,
  authority = resolver(snapshotFor),
): GroupAgentRunService {
  let sequence = 0;
  const nonce = Math.random().toString(36).slice(2);
  return new GroupAgentRunService(
    new FileGroupAgentRunRepository(file),
    authority,
    () => NOW,
    () => `${nonce}-id-${++sequence}`,
  );
}

function resolver(
  resolve: (request: GroupAuthorityRequest) => GroupAuthoritySnapshot | null,
): GroupAuthorityResolver {
  return { resolveGroupAuthority: async (request) => resolve(request) };
}

function snapshotFor(request: GroupAuthorityRequest): GroupAuthoritySnapshot {
  return {
    role: request.participantIds.includes("admin-1") ? "admin" : "member",
    authorityEpoch: 7,
  };
}

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "grup@g.us" },
    accountId: "utama",
    messageId: "pesan-1",
    participantId: "p1",
    participantAliases: [],
    participantName: "Ayu",
    groupName: "Grup uji",
    text: "halo semua",
    at: NOW.toISOString(),
    mentionsHarvy: false,
    repliesToHarvy: false,
    isAdmin: false,
    authorityEpoch: 7,
    ...overrides,
  };
}

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harvy-group-run-"));
  return join(directory, "group-agent-runs.json");
}
