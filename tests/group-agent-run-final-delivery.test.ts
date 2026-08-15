import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  GroupAuthorityRequest,
  GroupAuthorityResolver,
} from "../src/core/group-authority-policy.js";
import {
  GroupAgentRunConflictError,
  GroupAgentRunDeliveryNotCommittedError,
  GroupAgentRunMessageCollisionError,
  GroupAgentRunRuntimeAdmissionError,
  GroupAgentRunService,
  type GroupAgentRunRuntimeAdmissionResolver,
} from "../src/core/group-agent-run-service.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import { groupRunExecutionInputDigest } from
  "../src/domain/group-agent-run.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from
  "../src/storage/file-group-agent-run-repository.js";

const NOW = new Date("2026-08-14T11:00:00.000Z");
let serviceSequence = 0;

describe("GroupAgentRun final-result delivery barrier", () => {
  it("mempersistenkan intent sebelum send lalu mengomit receipt, result, attempt, dan terminal run secara atomik", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    let deliveries = 0;

    const completed = await fixture.service.commitFinalResult({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
      reply: "Jadwal final sudah disepakati untuk Jumat pukul 15.00.",
    }, async (request) => {
      deliveries += 1;
      const pending = await fixture.repository.load(claimed.run.runId);
      assert.equal(pending?.status, "running");
      assert.equal(pending?.phase, "finalizing");
      assert.equal(pending?.result, null);
      assert.equal(pending?.pendingEffect?.purpose, "final_result");
      assert.equal(
        pending?.pendingEffect?.workAttemptId,
        claimed.attempt.attemptId,
      );
      assert.equal(
        pending?.workAttempts?.find((attempt) =>
          attempt.attemptId === claimed.attempt.attemptId
        )?.status,
        "running",
      );
      assert.equal(
        pending?.receipts.some((receipt) =>
          receipt.purpose === "final_result"
        ),
        false,
      );
      assert.deepEqual(request, {
        effectId: pending?.pendingEffect?.effectId,
        content: "Jadwal final sudah disepakati untuk Jumat pukul 15.00.",
        quoteMessageId: "anchor-final",
        authorityExpectation: {
          expectedAuthorityEpoch: 7,
          actors: [{
            participantIds: ["p1", "p1-lid"],
            expectedRole: "member",
          }],
        },
      });
      return { messageId: "final-message-1" };
    });

    assert.equal(deliveries, 1);
    assert.equal(completed.status, "completed");
    assert.equal(completed.phase, "completed");
    assert.equal(completed.pendingEffect, null);
    assert.equal(completed.completedAt, completed.result?.committedAt);
    assert.deepEqual(completed.result, {
      kind: "final",
      text: "Jadwal final sudah disepakati untuk Jumat pukul 15.00.",
      contentDigest: completed.receipts.at(-1)?.contentDigest,
      instructionRevision: claimed.run.instructionRevision,
      attemptId: claimed.attempt.attemptId,
      messageId: "final-message-1",
      committedAt: completed.completedAt,
    });
    assert.equal(completed.receipts.at(-1)?.purpose, "final_result");
    assert.equal(completed.receipts.at(-1)?.status, "committed");
    assert.equal(
      completed.receipts.at(-1)?.subjectId,
      claimed.attempt.attemptId,
    );
    assert.equal(
      completed.workAttempts?.find((attempt) =>
        attempt.attemptId === claimed.attempt.attemptId
      )?.status,
      "completed",
    );
    assert.equal(completed.events.at(-1)?.type, "run.completed");
  });

  it("mereplay final result committed tanpa mengirim ulang", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    let deliveries = 0;
    const input = {
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
      reply: "Hasil final yang identik.",
    };
    const committed = await fixture.service.commitFinalResult(
      input,
      async () => {
        deliveries += 1;
        return { messageId: "final-replay" };
      },
    );
    const replayed = await fixture.service.commitFinalResult(
      input,
      async () => {
        deliveries += 1;
        return { messageId: "must-not-send" };
      },
    );

    assert.equal(deliveries, 1);
    assert.equal(replayed.stateRevision, committed.stateRevision);
    assert.deepEqual(replayed.result, committed.result);
    assert.equal(replayed.receipts.length, committed.receipts.length);
  });

  it("menolak collision digest final pada attempt/revision yang sama tanpa send", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    let deliveries = 0;
    await fixture.service.commitFinalResult({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
      reply: "Hasil pertama.",
    }, async () => {
      deliveries += 1;
      return { messageId: "final-collision" };
    });

    await assert.rejects(
      fixture.service.commitFinalResult({
        runId: claimed.run.runId,
        expectedStateRevision: claimed.run.stateRevision,
        attemptId: claimed.attempt.attemptId,
        reply: "Hasil berbeda pada slot final yang sama.",
      }, async () => {
        deliveries += 1;
        return { messageId: "must-not-send-collision" };
      }),
      GroupAgentRunMessageCollisionError,
    );
    assert.equal(deliveries, 1);
  });

  it("menolak attempt yang basi setelah koreksi tanpa memanggil transport", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    const correction = await fixture.service.routeMessage(message({
      messageId: "correction-after-work",
      text: "pekerjaan ini harus selesai tanpa memakai jadwal Jumat",
      quotedMessageId: claimed.run.anchor.messageId,
      ingressRevision: 2,
    }));
    assert.equal(correction.status, "applied");
    if (correction.status !== "applied") assert.fail("koreksi harus diterapkan");
    let deliveries = 0;

    await assert.rejects(
      fixture.service.commitFinalResult({
        runId: claimed.run.runId,
        expectedStateRevision: correction.run.stateRevision,
        attemptId: claimed.attempt.attemptId,
        reply: "Hasil dari instruksi lama.",
      }, async () => {
        deliveries += 1;
        return { messageId: "must-not-send-stale" };
      }),
      GroupAgentRunConflictError,
    );
    assert.equal(deliveries, 0);
    assert.equal(
      (await fixture.repository.load(claimed.run.runId))?.result,
      null,
    );
  });

  it("mereservasi slot outcome sebelum final send saat event ledger hampir penuh", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    const database = JSON.parse(await readFile(fixture.file, "utf8")) as {
      version: 1;
      runs: Array<{ events: Array<Record<string, unknown>> }>;
    };
    const events = database.runs[0]!.events;
    while (events.length < 255) {
      events.push(fillerEvent(events.length));
    }
    await writeFile(
      fixture.file,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );
    let deliveries = 0;

    await assert.rejects(
      fixture.service.commitFinalResult({
        runId: claimed.run.runId,
        expectedStateRevision: claimed.run.stateRevision,
        attemptId: claimed.attempt.attemptId,
        reply: "Hasil tidak boleh dikirim tanpa slot outcome.",
      }, async () => {
        deliveries += 1;
        return { messageId: "must-not-send-event-cap" };
      }),
      GroupAgentRunConflictError,
    );
    const current = await fixture.repository.load(claimed.run.runId);
    assert.equal(deliveries, 0);
    assert.equal(current?.pendingEffect, null);
    assert.equal(current?.workAttempts?.at(-1)?.status, "running");
    assert.equal(current?.result, null);
  });

  it("runtime yang dicabut tepat sebelum send menghasilkan not_committed dan mempertahankan attempt running", async () => {
    let finalPhase = false;
    let finalAdmissionCalls = 0;
    const fixture = await makeFixture(async () => {
      if (!finalPhase) return true;
      finalAdmissionCalls += 1;
      return finalAdmissionCalls < 3;
    });
    const claimed = await startClaimed(fixture.service);
    finalPhase = true;
    let deliveries = 0;

    await assert.rejects(
      fixture.service.commitFinalResult({
        runId: claimed.run.runId,
        expectedStateRevision: claimed.run.stateRevision,
        attemptId: claimed.attempt.attemptId,
        reply: "Tidak boleh keluar setelah runtime dicabut.",
      }, async () => {
        deliveries += 1;
        return { messageId: "must-not-send-runtime" };
      }),
      GroupAgentRunRuntimeAdmissionError,
    );

    const current = await fixture.repository.load(claimed.run.runId);
    assert.equal(deliveries, 0);
    assert.equal(current?.status, "running");
    assert.equal(current?.result, null);
    assert.equal(current?.pendingEffect, null);
    assert.equal(current?.receipts.at(-1)?.purpose, "final_result");
    assert.equal(current?.receipts.at(-1)?.status, "not_committed");
    assert.equal(current?.receipts.at(-1)?.subjectId, claimed.attempt.attemptId);
    assert.equal(current?.workAttempts?.at(-1)?.status, "running");

    assert.ok(current);
    const restarted = serviceFor(fixture.file);
    let retryDeliveries = 0;
    const retryInput = {
      runId: current.runId,
      expectedStateRevision: current.stateRevision,
      attemptId: claimed.attempt.attemptId,
      reply: "Tidak boleh keluar setelah runtime dicabut.",
    };
    const completed = await restarted.commitFinalResult(
      retryInput,
      async () => {
        retryDeliveries += 1;
        return { messageId: "final-after-runtime-restored" };
      },
    );
    const replayed = await restarted.commitFinalResult(
      retryInput,
      async () => {
        retryDeliveries += 1;
        return { messageId: "must-not-send-after-replay" };
      },
    );
    assert.equal(completed.status, "completed");
    assert.equal(replayed.stateRevision, completed.stateRevision);
    assert.equal(retryDeliveries, 1);
  });

  it("typed pre-socket final menjaga active attempt dan checkpoint budget", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    const budget = {
      ...new RunBudgetAccount({}, () => NOW.getTime()).checkpoint(),
      consumedTokens: 21,
      modelCalls: 1,
      activeElapsedMs: 17,
    };
    const checkpointed = await fixture.service.commitExecutionCheckpoint({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
      checkpoint: {
        version: 1,
        engine: "group-model-v1",
        attemptId: claimed.attempt.attemptId,
        sequence: 1,
        instructionRevision: claimed.run.instructionRevision,
        inputDigest: groupRunExecutionInputDigest(claimed.run),
        waitingQuestionId: null,
        budget,
        updatedAt: NOW.toISOString(),
      },
    });
    let deliveries = 0;

    await assert.rejects(
      fixture.service.commitFinalResult({
        runId: checkpointed.runId,
        expectedStateRevision: checkpointed.stateRevision,
        attemptId: claimed.attempt.attemptId,
        reply: "Hasil final belum menyentuh socket.",
      }, async () => {
        deliveries += 1;
        throw new GroupAgentRunDeliveryNotCommittedError();
      }),
      GroupAgentRunDeliveryNotCommittedError,
    );

    const current = await fixture.repository.load(claimed.run.runId);
    assert.equal(deliveries, 1);
    assert.equal(current?.status, "running");
    assert.equal(current?.pendingEffect, null);
    assert.equal(current?.result, null);
    assert.equal(current?.workAttempts?.at(-1)?.status, "running");
    assert.equal(current?.checkpoint?.attemptId, claimed.attempt.attemptId);
    assert.deepEqual(current?.checkpoint?.budget, budget);
    assert.equal(current?.receipts.at(-1)?.status, "not_committed");
    assert.equal(
      current?.receipts.at(-1)?.workAttemptId,
      claimed.attempt.attemptId,
    );
  });

  it("ambiguity transport menutup run partial dan attempt failed tanpa result", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    let deliveries = 0;

    await assert.rejects(
      fixture.service.commitFinalResult({
        runId: claimed.run.runId,
        expectedStateRevision: claimed.run.stateRevision,
        attemptId: claimed.attempt.attemptId,
        reply: "Hasil yang status kirimnya tidak diketahui.",
      }, async () => {
        deliveries += 1;
        throw new Error("transport terputus setelah send");
      }),
      /transport terputus/iu,
    );

    const current = await fixture.repository.load(claimed.run.runId);
    assert.equal(deliveries, 1);
    assert.equal(current?.status, "partial");
    assert.equal(current?.phase, "failed");
    assert.equal(current?.result, null);
    assert.equal(current?.pendingEffect, null);
    assert.equal(current?.receipts.at(-1)?.purpose, "final_result");
    assert.equal(current?.receipts.at(-1)?.status, "unknown");
    assert.equal(current?.receipts.at(-1)?.subjectId, claimed.attempt.attemptId);
    assert.equal(current?.workAttempts?.at(-1)?.status, "failed");
    assert.match(
      current?.workAttempts?.at(-1)?.code ?? "",
      /delivery.*unknown/iu,
    );
  });

  it("recovery pending final menandainya unknown dan gagal tanpa retry transport", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deliveries = 0;
    const interrupted = fixture.service.commitFinalResult({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
      reply: "Hasil final dari proses yang terputus.",
    }, async () => {
      deliveries += 1;
      entered();
      await blocked;
      return { messageId: "late-final-message" };
    });
    const observed = interrupted.then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );

    await enteredPromise;
    assert.equal(
      (await fixture.repository.load(claimed.run.runId))?.pendingEffect
        ?.purpose,
      "final_result",
    );
    const database = JSON.parse(await readFile(fixture.file, "utf8")) as {
      version: 1;
      runs: Array<{ events: Array<Record<string, unknown>> }>;
    };
    const preparedEvent = database.runs[0]!.events.pop();
    assert.ok(preparedEvent);
    assert.equal(preparedEvent?.type, "delivery.prepared");
    while (database.runs[0]!.events.length < 255) {
      database.runs[0]!.events.push(
        fillerEvent(database.runs[0]!.events.length),
      );
    }
    database.runs[0]!.events.push(preparedEvent);
    await writeFile(
      fixture.file,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );
    const recovered = await serviceFor(fixture.file).recoverInterruptedRuns();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, "partial");
    assert.equal(recovered[0]?.result, null);
    assert.equal(recovered[0]?.pendingEffect, null);
    assert.equal(recovered[0]?.receipts.at(-1)?.purpose, "final_result");
    assert.equal(recovered[0]?.receipts.at(-1)?.status, "unknown");
    assert.equal(
      recovered[0]?.receipts.at(-1)?.subjectId,
      claimed.attempt.attemptId,
    );
    assert.equal(recovered[0]?.workAttempts?.at(-1)?.status, "failed");
    assert.equal(deliveries, 1);

    release();
    assert.ok((await observed).error instanceof Error);
    assert.equal(deliveries, 1);
  });

  it("repository menolak terminal result yang melewati committed final receipt", async () => {
    const fixture = await makeFixture();
    const claimed = await startClaimed(fixture.service);
    const { stateRevision, ...draft } = structuredClone(claimed.run);
    const committedAt = NOW.toISOString();
    const reply = "Result palsu yang tidak mempunyai receipt.";
    draft.status = "completed";
    draft.phase = "completed";
    draft.appliedInstructionRevision = draft.instructionRevision;
    draft.completedAt = committedAt;
    draft.updatedAt = committedAt;
    draft.pendingEffect = null;
    draft.workAttempts = (draft.workAttempts ?? []).map((attempt) => ({
      ...attempt,
      status: attempt.attemptId === claimed.attempt.attemptId
        ? "completed" as const
        : attempt.status,
      settledAt: attempt.attemptId === claimed.attempt.attemptId
        ? committedAt
        : attempt.settledAt,
    }));
    draft.result = {
      kind: "final",
      text: reply,
      contentDigest: createHash("sha256").update(reply, "utf8").digest("hex"),
      instructionRevision: draft.instructionRevision,
      attemptId: claimed.attempt.attemptId,
      messageId: "forged-final-message",
      committedAt,
    };
    draft.events = [...draft.events, {
      id: "forged-run-completed",
      type: "run.completed",
      at: committedAt,
      instructionRevision: draft.instructionRevision,
      sourceMessageId: "forged-final-message",
      participantId: null,
    }];

    await assert.rejects(
      fixture.repository.save(draft, stateRevision, async () => true),
      /final|result|receipt/iu,
    );
    const current = await fixture.repository.load(claimed.run.runId);
    assert.equal(current?.status, "running");
    assert.equal(current?.result, null);
    assert.equal(current?.workAttempts?.at(-1)?.status, "running");
  });
});

function fillerEvent(index: number): Record<string, unknown> {
  return {
    id: `final-event-filler-${index}`,
    type: "input.proposed",
    at: NOW.toISOString(),
    instructionRevision: 0,
    sourceMessageId: null,
    participantId: null,
  };
}

async function makeFixture(
  runtimeAdmission: GroupAgentRunRuntimeAdmissionResolver = async () => true,
): Promise<{
  file: string;
  repository: FileGroupAgentRunRepository;
  service: GroupAgentRunService;
}> {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-final-delivery-"));
  const file = join(root, "runs.json");
  const repository = new FileGroupAgentRunRepository(file);
  return {
    file,
    repository,
    service: serviceFor(file, runtimeAdmission, repository),
  };
}

function serviceFor(
  file: string,
  runtimeAdmission: GroupAgentRunRuntimeAdmissionResolver = async () => true,
  repository = new FileGroupAgentRunRepository(file),
): GroupAgentRunService {
  let sequence = 0;
  const serviceId = ++serviceSequence;
  return new GroupAgentRunService(
    repository,
    authorityResolver(),
    () => NOW,
    () => `final-${serviceId}-${++sequence}`,
    runtimeAdmission,
  );
}

async function startClaimed(service: GroupAgentRunService) {
  const started = await service.start({
    message: message({ participantAliases: ["p1-lid"] }),
  });
  assert.equal(started.status, "started");
  const anchored = await service.commitAnchor(
    started.run.runId,
    started.run.stateRevision,
    "📌 Susun jadwal kelompok",
    async () => ({ messageId: "anchor-final" }),
  );
  return service.claimWorkAttempt({
    runId: anchored.runId,
    expectedStateRevision: anchored.stateRevision,
    claimKey: "dispatcher:final",
  });
}

function authorityResolver(): GroupAuthorityResolver {
  return {
    resolveGroupAuthority: async (_request: GroupAuthorityRequest) => ({
      role: "member",
      authorityEpoch: 7,
    }),
  };
}

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "final-delivery@g.us" },
    accountId: "utama",
    messageId: "start-final",
    participantId: "p1",
    participantAliases: [],
    participantName: "Ayu",
    groupName: "Grup final",
    text: "Harvy, susun jadwal kelompok ini",
    at: NOW.toISOString(),
    mentionsHarvy: true,
    repliesToHarvy: false,
    isAdmin: false,
    authorityEpoch: 7,
    ...overrides,
  };
}
