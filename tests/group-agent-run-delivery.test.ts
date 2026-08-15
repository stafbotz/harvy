import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  GroupAgentRunAuthorityError,
  GroupAgentRunConflictError,
  GroupAgentRunDeliveryNotCommittedError,
  GroupAgentRunMessageCollisionError,
  GroupAgentRunService,
} from "../src/core/group-agent-run-service.js";
import type {
  GroupAuthorityRequest,
  GroupAuthorityResolver,
  GroupAuthoritySnapshot,
} from "../src/core/group-authority-policy.js";
import type { GroupAgentRun } from "../src/domain/group-agent-run.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from "../src/storage/file-group-agent-run-repository.js";

const NOW = new Date("2026-08-14T02:00:00.000Z");
let serviceSequence = 0;

describe("GroupAgentRun delivery commit barrier", () => {
  it("mempersistenkan intent sebelum anchor dikirim dan replay tidak mengirim ulang", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({
      message: startMessage({ participantAliases: ["p1-lid", "p1-device"] }),
    });
    let deliveries = 0;
    const committed = await fixture.service.commitAnchor(
      started.run.runId,
      started.run.stateRevision,
      "📌 Susun jadwal presentasi",
      async (request) => {
        deliveries += 1;
        const pending = await fixture.repository.load(started.run.runId);
        assert.equal(pending?.anchor.messageId, null);
        assert.equal(pending?.receipts.length, 0);
        assert.equal(pending?.pendingEffect?.effectId, request.effectId);
        assert.equal(pending?.pendingEffect?.purpose, "anchor");
        assert.deepEqual(request, {
          effectId: pending?.pendingEffect?.effectId,
          content: "📌 Susun jadwal presentasi",
          quoteMessageId: null,
          authorityExpectation: {
            expectedAuthorityEpoch: 7,
            actors: [{
              participantIds: ["p1", "p1-lid", "p1-device"],
              expectedRole: "member",
            }],
          },
        });
        return { messageId: "anchor-delivered-1" };
      },
    );

    assert.equal(committed.anchor.messageId, "anchor-delivered-1");
    assert.equal(committed.pendingEffect, null);
    assert.deepEqual(committed.receipts.map((receipt) => ({
      purpose: receipt.purpose,
      status: receipt.status,
      externalMessageId: receipt.externalMessageId,
      preparedStateRevision: receipt.preparedStateRevision,
    })), [{
      purpose: "anchor",
      status: "committed",
      externalMessageId: "anchor-delivered-1",
      preparedStateRevision: started.run.stateRevision,
    }]);

    const replay = await fixture.service.commitAnchor(
      started.run.runId,
      started.run.stateRevision,
      "📌 Susun jadwal presentasi",
      async () => {
        deliveries += 1;
        return { messageId: "must-not-send" };
      },
    );
    assert.equal(replay.stateRevision, committed.stateRevision);
    assert.equal(deliveries, 1);
    await assert.rejects(
      fixture.service.commitAnchor(
        started.run.runId,
        started.run.stateRevision,
        "📌 Isi replay berbeda",
        async () => {
          deliveries += 1;
          return { messageId: "must-not-send-collision" };
        },
      ),
      GroupAgentRunMessageCollisionError,
    );
    assert.equal(deliveries, 1);
  });

  it("mengikat assigned question ke ID dan watermark yang diambil setelah delivery", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({
      message: startMessage({ participantAliases: ["p1-lid"] }),
    });
    const anchored = await fixture.service.commitAnchor(
      started.run.runId,
      started.run.stateRevision,
      "📌 Koordinasi kelompok",
      async () => ({ messageId: "anchor-question-delivery" }),
    );
    let deliveries = 0;
    const waiting = await fixture.service.commitAssignedQuestion({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      prompt: "Sabtu pagi kamu bisa?",
      assignee: participant("p2", "Bima", ["admin-1", "p2-lid"]),
    }, async (request) => {
      deliveries += 1;
      const pending = await fixture.repository.load(anchored.runId);
      assert.equal(pending?.questions.length, 0);
      assert.equal(pending?.pendingEffect?.purpose, "assigned_question");
      assert.deepEqual(request, {
        effectId: pending?.pendingEffect?.effectId,
        content: "Sabtu pagi kamu bisa?",
        quoteMessageId: "anchor-question-delivery",
        authorityExpectation: {
          expectedAuthorityEpoch: 7,
          actors: [{
            participantIds: ["p1", "p1-lid"],
            expectedRole: "member",
          }, {
            participantIds: ["p2", "admin-1", "p2-lid"],
            expectedRole: "admin",
          }],
        },
      });
      return {
        messageId: "question-delivered-1",
        acceptAnswersAfterIngressRevision: 42,
      };
    });

    assert.equal(waiting.status, "waiting_input");
    assert.equal(waiting.questions[0]?.messageId, "question-delivered-1");
    assert.equal(waiting.questions[0]?.acceptAnswersAfterIngressRevision, 42);
    assert.equal(waiting.receipts.at(-1)?.subjectId, waiting.questions[0]?.questionId);

    const delayed = await fixture.service.routeMessage(message({
      participantId: "p2",
      participantName: "Bima",
      messageId: "answer-before-delivery-watermark",
      text: "bisa",
      repliesToHarvy: true,
      quotedMessageId: "question-delivered-1",
      ingressRevision: 42,
    }));
    assert.equal(delayed.status, "independent");

    const replay = await fixture.service.commitAssignedQuestion({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      prompt: "Sabtu pagi kamu bisa?",
      assignee: participant("p2", "Bima", ["admin-1", "p2-lid"]),
    }, async () => {
      deliveries += 1;
      return {
        messageId: "must-not-send",
        acceptAnswersAfterIngressRevision: 99,
      };
    });
    assert.equal(replay.stateRevision, waiting.stateRevision);
    assert.equal(deliveries, 1);
    await assert.rejects(
      fixture.service.commitAssignedQuestion({
        runId: anchored.runId,
        expectedStateRevision: anchored.stateRevision,
        prompt: "Minggu pagi kamu bisa?",
        assignee: participant("p2", "Bima", ["admin-1", "p2-lid"]),
      }, async () => {
        deliveries += 1;
        return {
          messageId: "must-not-send-question-collision",
          acceptAnswersAfterIngressRevision: 100,
        };
      }),
      GroupAgentRunMessageCollisionError,
    );
    assert.equal(deliveries, 1);
  });

  it("mencatat delivery gagal atau ID kosong sebagai unknown tanpa retry", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({ message: startMessage() });
    let deliveries = 0;
    await assert.rejects(
      fixture.service.commitAnchor(
        started.run.runId,
        started.run.stateRevision,
        "📌 Pekerjaan",
        async () => {
          deliveries += 1;
          return { messageId: "" };
        },
      ),
      /messageId/iu,
    );
    const failed = await fixture.repository.load(started.run.runId);
    assert.equal(deliveries, 1);
    assert.equal(failed?.status, "partial");
    assert.equal(failed?.pendingEffect, null);
    assert.equal(failed?.anchor.messageId, null);
    assert.equal(failed?.receipts[0]?.status, "unknown");
    assert.equal(failed?.receipts[0]?.externalMessageId, null);
  });

  it("menutup typed pre-socket anchor sebagai not_committed tanpa resend", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({ message: startMessage() });
    const rejection = new GroupAgentRunDeliveryNotCommittedError(
      "socket belum dipanggil",
    );
    let deliveries = 0;
    const commit = () => fixture.service.commitAnchor(
      started.run.runId,
      started.run.stateRevision,
      "📌 Delivery ditolak sebelum socket",
      async () => {
        deliveries += 1;
        throw rejection;
      },
    );

    await assert.rejects(commit(), (error: unknown) => error === rejection);
    const current = await fixture.repository.load(started.run.runId);
    assert.equal(deliveries, 1);
    assert.equal(current?.status, "queued");
    assert.equal(current?.pendingEffect, null);
    assert.equal(current?.anchor.messageId, null);
    assert.equal(current?.receipts.at(-1)?.status, "not_committed");
    assert.equal(current?.receipts.at(-1)?.workAttemptId, null);

    await assert.rejects(commit(), GroupAgentRunConflictError);
    assert.equal(deliveries, 1);
  });

  it("menutup typed pre-socket assigned question sebagai not_committed", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({ message: startMessage() });
    const anchored = await fixture.service.commitAnchor(
      started.run.runId,
      started.run.stateRevision,
      "📌 Pekerjaan dengan pertanyaan",
      async () => ({ messageId: "anchor-before-pre-socket-question" }),
    );
    let deliveries = 0;

    await assert.rejects(
      fixture.service.commitAssignedQuestion({
        runId: anchored.runId,
        expectedStateRevision: anchored.stateRevision,
        prompt: "Apakah Sabtu bisa?",
        assignee: structuredClone(anchored.initiator),
      }, async () => {
        deliveries += 1;
        throw new GroupAgentRunDeliveryNotCommittedError();
      }),
      GroupAgentRunDeliveryNotCommittedError,
    );

    const current = await fixture.repository.load(anchored.runId);
    assert.equal(deliveries, 1);
    // Anchor commit hanya membuka antrean work; tanpa claim durable, run tetap
    // queued. Penolakan sebelum socket tidak boleh mengarang attempt running.
    assert.equal(current?.status, "queued");
    assert.equal(current?.pendingEffect, null);
    assert.deepEqual(current?.questions, []);
    assert.equal(current?.receipts.at(-1)?.purpose, "assigned_question");
    assert.equal(current?.receipts.at(-1)?.status, "not_committed");
    assert.equal(current?.receipts.at(-1)?.workAttemptId, null);
  });

  it("recovery menutup pending delivery sebagai ambigu dan tidak memanggil transport", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({ message: startMessage() });
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deliveryCalls = 0;
    const interrupted = fixture.service.commitAnchor(
      started.run.runId,
      started.run.stateRevision,
      "📌 Pekerjaan terputus",
      async () => {
        deliveryCalls += 1;
        entered();
        await blocked;
        return { messageId: "late-old-process" };
      },
    );
    await enteredPromise;
    assert.equal(
      (await fixture.repository.load(started.run.runId))?.pendingEffect?.purpose,
      "anchor",
    );

    const recovery = serviceFor(fixture.file);
    const recovered = await recovery.recoverInterruptedRuns();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, "partial");
    assert.equal(recovered[0]?.receipts[0]?.status, "unknown");
    assert.equal(deliveryCalls, 1);

    release();
    await assert.rejects(interrupted);
    assert.equal(deliveryCalls, 1);
  });

  it("expiry foreground menutup pending delivery sebagai unknown sebelum run baru", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-expiry-delivery-"));
    const repository = new FileGroupAgentRunRepository(join(root, "runs.json"));
    let now = new Date(NOW);
    let sequence = 0;
    const service = new GroupAgentRunService(
      repository,
      resolver(snapshotFor),
      () => now,
      () => `expiry-delivery-${++sequence}`,
    );
    const started = await service.start({ message: startMessage() });
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interrupted = service.commitAnchor(
      started.run.runId,
      started.run.stateRevision,
      "📌 Delivery melewati horizon",
      async () => {
        entered();
        await blocked;
        return { messageId: "late-after-expiry" };
      },
    );
    await enteredPromise;
    now = new Date("2026-08-21T02:00:00.001Z");
    const replacement = await service.start({
      message: startMessage({
        messageId: "start-after-expiry",
        at: now.toISOString(),
      }),
    });
    assert.equal(replacement.status, "started");
    const expired = await repository.load(started.run.runId);
    assert.equal(expired?.status, "partial");
    assert.equal(expired?.pendingEffect, null);
    assert.equal(expired?.receipts.at(-1)?.status, "unknown");

    release();
    await assert.rejects(interrupted);
    assert.equal(
      (await repository.load(started.run.runId))?.receipts.length,
      1,
    );
  });

  it("revalidasi authority menolak sebelum transport dan menyimpan not_committed", async () => {
    let deliveryPhase = false;
    let deliveryAuthorityCalls = 0;
    const fixture = await makeFixture(resolver((request) => {
      if (deliveryPhase) deliveryAuthorityCalls += 1;
      return {
        role: "member",
        authorityEpoch: deliveryPhase && deliveryAuthorityCalls >= 3 ? 8 : 7,
      };
    }));
    const started = await fixture.service.start({ message: startMessage() });
    deliveryPhase = true;
    let delivered = false;
    await assert.rejects(
      fixture.service.commitAnchor(
        started.run.runId,
        started.run.stateRevision,
        "📌 Tidak boleh terkirim",
        async () => {
          delivered = true;
          return { messageId: "forbidden" };
        },
      ),
      GroupAgentRunAuthorityError,
    );
    const current = await fixture.repository.load(started.run.runId);
    assert.equal(delivered, false);
    assert.equal(current?.status, "queued");
    assert.equal(current?.pendingEffect, null);
    assert.equal(current?.receipts[0]?.status, "not_committed");
  });

  it("menolak delivery baru sebelum send ketika seluruh slot receipt terpakai", async () => {
    let deliveryPhase = false;
    let authorityCalls = 0;
    const fixture = await makeFixture(resolver(() => {
      if (!deliveryPhase) return { role: "member", authorityEpoch: 7 };
      authorityCalls += 1;
      return {
        role: "member",
        // Dua pembacaan pertama menyiapkan intent, pembacaan ketiga
        // mensimulasikan epoch berubah tepat sebelum transport.
        authorityEpoch: authorityCalls % 3 === 0 ? 8 : 7,
      };
    }));
    let current = (await fixture.service.start({ message: startMessage() })).run;
    deliveryPhase = true;
    let sends = 0;

    for (let index = 0; index < 64; index += 1) {
      await assert.rejects(
        fixture.service.commitAnchor(
          current.runId,
          current.stateRevision,
          `Anchor ditolak ${index}`,
          async () => {
            sends += 1;
            return { messageId: `must-not-send-${index}` };
          },
        ),
        GroupAgentRunAuthorityError,
      );
      current = (await fixture.repository.load(current.runId))!;
    }

    assert.equal(current.receipts.length, 64);
    assert.equal(current.pendingEffect, null);
    const authorityCallsBeforeCapacityCheck = authorityCalls;
    await assert.rejects(
      fixture.service.commitAnchor(
        current.runId,
        current.stateRevision,
        "Anchor yang tidak mempunyai slot receipt",
        async () => {
          sends += 1;
          return { messageId: "must-not-send-at-capacity" };
        },
      ),
      GroupAgentRunConflictError,
    );
    assert.equal(sends, 0);
    assert.equal(authorityCalls, authorityCallsBeforeCapacityCheck);
    assert.equal(
      (await fixture.repository.load(current.runId))?.pendingEffect,
      null,
    );
  });
});

describe("GroupAgentRun delivery persistence", () => {
  it("repository menolak pemasangan anchor yang melewati pending effect", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({ message: startMessage() });
    const { stateRevision, ...draft } = structuredClone(started.run);
    draft.anchor = {
      ...draft.anchor,
      messageId: "anchor-bypass",
      updatedAt: NOW.toISOString(),
    };
    await assert.rejects(
      fixture.repository.save(draft, stateRevision, async () => true),
      /pending effect|immutable|append-only/iu,
    );
  });

  it("memigrasikan record v1 dan menolak receipt yang dirusak", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({ message: startMessage() });
    const raw = JSON.parse(await readFile(fixture.file, "utf8")) as {
      version: 1;
      runs: Array<Record<string, unknown>>;
    };
    raw.runs[0]!.version = 1;
    delete raw.runs[0]!.pendingEffect;
    delete raw.runs[0]!.receipts;
    delete raw.runs[0]!.checkpoint;
    await writeFile(fixture.file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const migrated = await fixture.repository.load(started.run.runId);
    assert.equal(migrated?.version, 2);
    assert.equal(migrated?.pendingEffect, null);
    assert.deepEqual(migrated?.receipts, []);

    const committed = await fixture.service.commitAnchor(
      migrated!.runId,
      migrated!.stateRevision,
      "📌 Bukti receipt",
      async () => ({ messageId: "anchor-tamper" }),
    );
    const database = JSON.parse(await readFile(fixture.file, "utf8")) as {
      version: 1;
      runs: GroupAgentRun[];
    };
    database.runs[0]!.receipts[0]!.externalMessageId = "anchor-tampered";
    await writeFile(
      fixture.file,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      fixture.repository.load(committed.runId),
      /receipt|digest|immutable/iu,
    );
  });
});

async function makeFixture(
  authority = resolver(snapshotFor),
): Promise<{
  file: string;
  repository: FileGroupAgentRunRepository;
  service: GroupAgentRunService;
}> {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-delivery-"));
  const file = join(root, "group-runs.json");
  const repository = new FileGroupAgentRunRepository(file);
  return { file, repository, service: serviceFor(file, authority, repository) };
}

function serviceFor(
  file: string,
  authority = resolver(snapshotFor),
  repository = new FileGroupAgentRunRepository(file),
): GroupAgentRunService {
  let sequence = 0;
  const serviceId = ++serviceSequence;
  return new GroupAgentRunService(
    repository,
    authority,
    () => NOW,
    () => `delivery-${serviceId}-${++sequence}`,
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

function startMessage(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return message({
    messageId: "start-delivery",
    text: "Harvy, bantu susun jadwal presentasi",
    mentionsHarvy: true,
    ...overrides,
  });
}

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "group-delivery@g.us" },
    accountId: "utama",
    messageId: "message-delivery",
    participantId: "p1",
    participantAliases: [],
    participantName: "Ayu",
    groupName: "Grup delivery",
    text: "halo",
    at: NOW.toISOString(),
    mentionsHarvy: false,
    repliesToHarvy: false,
    isAdmin: false,
    authorityEpoch: 7,
    ...overrides,
  };
}

function participant(
  participantId: string,
  displayName: string,
  identityAliases: string[] = [],
) {
  return { participantId, identityAliases, displayName };
}
