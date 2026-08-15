import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  GroupAuthorityRequest,
  GroupAuthorityResolver,
} from "../src/core/group-authority-policy.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import {
  GroupAgentRunAuthorityError,
  GroupAgentRunConflictError,
  GroupAgentRunRuntimeAdmissionError,
  GroupAgentRunService,
  GroupAgentRunWorkAttemptLimitError,
  type GroupAgentRunRuntimeAdmissionResolver,
} from "../src/core/group-agent-run-service.js";
import {
  groupRunExecutionInputDigest,
  type GroupAgentRun,
  type GroupRunExecutionCheckpoint,
} from "../src/domain/group-agent-run.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from
  "../src/storage/file-group-agent-run-repository.js";

const NOW = new Date("2026-08-14T10:00:00.000Z");

describe("GroupAgentRun durable work lifecycle", () => {
  it("tidak membuka work lane sebelum anchor committed", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({ message: message() });
    assert.equal(started.status, "started");

    await assert.rejects(
      fixture.service.claimWorkAttempt({
        runId: started.run.runId,
        expectedStateRevision: started.run.stateRevision,
        claimKey: "dispatcher:too-early",
      }),
      GroupAgentRunConflictError,
    );
    assert.deepEqual(
      (await fixture.repository.load(started.run.runId))?.workAttempts,
      [],
    );
  });

  it("repository menolak status running yang melewati claim ledger", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    const { stateRevision, ...draft } = structuredClone(anchored);
    draft.status = "running";
    draft.phase = "reading_context";

    await assert.rejects(
      fixture.repository.save(draft, stateRevision, async () => true),
      /work attempt/iu,
    );
    assert.equal(
      (await fixture.repository.load(anchored.runId))?.status,
      "queued",
    );
  });

  it("mengklaim satu attempt secara CAS dan replay claimKey identik", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);

    const [left, right] = await Promise.all([
      fixture.service.claimWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: anchored.stateRevision,
        claimKey: "dispatcher:run:0",
      }),
      fixture.service.claimWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: anchored.stateRevision,
        claimKey: "dispatcher:run:0",
      }),
    ]);

    assert.deepEqual(
      [left.status, right.status].sort(),
      ["claimed", "replayed"],
    );
    assert.equal(left.attempt.attemptId, right.attempt.attemptId);
    assert.equal(left.attempt.instructionRevision, 0);
    const stored = await fixture.repository.load(anchored.runId);
    assert.equal(stored?.status, "running");
    assert.equal(stored?.phase, "reading_context");
    assert.equal(stored?.workAttempts?.length, 1);
    assert.equal(stored?.workAttempts?.[0]?.status, "running");

    await assert.rejects(
      fixture.service.claimWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: stored!.stateRevision,
        claimKey: "dispatcher:run:0",
      }),
      GroupAgentRunConflictError,
    );

    await assert.rejects(
      fixture.service.claimWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: anchored.stateRevision,
        claimKey: "dispatcher:competing",
      }),
      GroupAgentRunConflictError,
    );
  });

  it("menolak hasil basi, lalu requeue dan complete bersifat idempotent", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    const claimed = await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      claimKey: "dispatcher:first",
    });
    const updated = await fixture.service.routeMessage(message({
      messageId: "constraint-after-claim",
      text: "pekerjaan ini harus selesai tanpa mengubah jadwal Jumat",
      quotedMessageId: anchored.anchor.messageId,
      ingressRevision: 2,
    }));
    assert.equal(updated.status, "applied");
    if (updated.status !== "applied") assert.fail("constraint harus diterapkan");

    await assert.rejects(
      fixture.service.completeWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: updated.run.stateRevision,
        attemptId: claimed.attempt.attemptId,
      }),
      GroupAgentRunConflictError,
    );
    const requeued = await fixture.service.requeueWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: updated.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
      code: "instruction_changed",
    });
    assert.equal(requeued.run.status, "queued");
    assert.equal(requeued.attempt.status, "requeued");
    const requeueReplay = await fixture.service.requeueWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: updated.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
      code: "instruction_changed",
    });
    assert.equal(requeueReplay.status, "replayed");
    assert.equal(requeueReplay.run.stateRevision, requeued.run.stateRevision);

    const second = await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: requeued.run.stateRevision,
      claimKey: "dispatcher:second",
    });
    const completed = await fixture.service.completeWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: second.run.stateRevision,
      attemptId: second.attempt.attemptId,
    });
    assert.equal(completed.status, "settled");
    assert.equal(completed.run.status, "running");
    assert.equal(completed.run.phase, "finalizing");
    assert.equal(completed.run.completedAt, null);
    assert.equal(completed.attempt.status, "completed");
    assert.equal(
      completed.run.appliedInstructionRevision,
      completed.run.instructionRevision,
    );
    const { stateRevision: completedRevision, ...terminalBypass } =
      structuredClone(completed.run);
    terminalBypass.status = "completed";
    terminalBypass.phase = "completed";
    terminalBypass.completedAt = NOW.toISOString();
    await assert.rejects(
      fixture.repository.save(
        terminalBypass,
        completedRevision,
        async () => true,
      ),
      /work attempt/iu,
    );

    const replay = await fixture.service.completeWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: second.run.stateRevision,
      attemptId: second.attempt.attemptId,
    });
    assert.equal(replay.status, "replayed");
    assert.equal(replay.run.stateRevision, completed.run.stateRevision);
  });

  it("fail dan cancel menutup attempt running tanpa state yatim", async () => {
    const failedFixture = await makeFixture();
    const failedAnchor = await startAnchored(failedFixture.service);
    const failedClaim = await failedFixture.service.claimWorkAttempt({
      runId: failedAnchor.runId,
      expectedStateRevision: failedAnchor.stateRevision,
      claimKey: "dispatcher:fail",
    });
    const failed = await failedFixture.service.failWorkAttempt({
      runId: failedAnchor.runId,
      expectedStateRevision: failedClaim.run.stateRevision,
      attemptId: failedClaim.attempt.attemptId,
      code: "planner_unavailable",
    });
    assert.equal(failed.run.status, "failed");
    assert.equal(failed.attempt.status, "failed");
    assert.equal(failed.attempt.code, "planner_unavailable");
    const failedReplay = await failedFixture.service.failWorkAttempt({
      runId: failedAnchor.runId,
      expectedStateRevision: failedClaim.run.stateRevision,
      attemptId: failedClaim.attempt.attemptId,
      code: "planner_unavailable",
    });
    assert.equal(failedReplay.status, "replayed");
    assert.equal(failedReplay.run.stateRevision, failed.run.stateRevision);

    const cancelledFixture = await makeFixture();
    const cancelledAnchor = await startAnchored(cancelledFixture.service);
    await cancelledFixture.service.claimWorkAttempt({
      runId: cancelledAnchor.runId,
      expectedStateRevision: cancelledAnchor.stateRevision,
      claimKey: "dispatcher:cancel",
    });
    const cancelled = await cancelledFixture.service.routeMessage(message({
      messageId: "cancel-running-attempt",
      text: "batalkan pekerjaan ini",
      mentionsHarvy: true,
      ingressRevision: 3,
    }));
    assert.equal(cancelled.status, "cancelled");
    if (cancelled.status !== "cancelled") assert.fail("run harus cancelled");
    assert.equal(cancelled.run.workAttempts?.[0]?.status, "cancelled");
    assert.equal(cancelled.run.workAttempts?.[0]?.code, "run_cancelled");
    assert.equal(
      cancelled.run.workAttempts?.some((attempt) =>
        attempt.status === "running"
      ),
      false,
    );
  });

  it("commit assigned question merequeue attempt pada CAS waiting_input yang sama", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    const claimed = await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      claimKey: "dispatcher:question",
    });

    const waiting = await fixture.service.commitAssignedQuestion({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      prompt: "Kapan kelompok bisa berkumpul?",
      assignee: structuredClone(claimed.run.initiator),
      attemptId: claimed.attempt.attemptId,
      checkpoint: executionCheckpoint(claimed.run, claimed.attempt.attemptId),
    }, async () => ({
      messageId: "question-work",
      acceptAnswersAfterIngressRevision: 10,
    }));

    assert.equal(waiting.status, "waiting_input");
    assert.equal(waiting.phase, "waiting_input");
    assert.equal(waiting.workAttempts?.[0]?.status, "requeued");
    assert.equal(waiting.workAttempts?.[0]?.code, "waiting_input");
    assert.equal(
      waiting.workAttempts?.some((attempt) => attempt.status === "running"),
      false,
    );
    assert.equal(waiting.events.at(-1)?.type, "input.required");
  });

  it("menolak assigned question dari attempt yang basi setelah koreksi", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    const claimed = await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      claimKey: "dispatcher:stale-question",
    });
    const correction = await fixture.service.routeMessage(message({
      messageId: "correction-before-question",
      text: "pekerjaan ini harus selesai tanpa memakai jadwal Jumat",
      quotedMessageId: claimed.run.anchor.messageId,
      ingressRevision: 12,
    }));
    assert.equal(correction.status, "applied");
    if (correction.status !== "applied") assert.fail("koreksi harus diterapkan");
    let deliveries = 0;

    await assert.rejects(
      fixture.service.commitAssignedQuestion({
        runId: claimed.run.runId,
        expectedStateRevision: correction.run.stateRevision,
        prompt: "Apakah Jumat masih bisa?",
        assignee: structuredClone(claimed.run.initiator),
        attemptId: claimed.attempt.attemptId,
        checkpoint: executionCheckpoint(claimed.run, claimed.attempt.attemptId),
      }, async () => {
        deliveries += 1;
        return {
          messageId: "must-not-send-stale-question",
          acceptAnswersAfterIngressRevision: 13,
        };
      }),
      GroupAgentRunConflictError,
    );
    const current = await fixture.repository.load(claimed.run.runId);
    assert.equal(deliveries, 0);
    assert.equal(current?.pendingEffect, null);
    assert.deepEqual(current?.questions, []);
    assert.equal(current?.workAttempts?.at(-1)?.status, "running");
  });

  it("menolak assigned question setelah attempt sudah disettle", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    const claimed = await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      claimKey: "dispatcher:settled-question",
    });
    const completed = await fixture.service.completeWorkAttempt({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
    });
    let deliveries = 0;

    await assert.rejects(
      fixture.service.commitAssignedQuestion({
        runId: completed.run.runId,
        expectedStateRevision: completed.run.stateRevision,
        prompt: "Pertanyaan ini berasal dari attempt yang sudah selesai.",
        assignee: structuredClone(completed.run.initiator),
        attemptId: claimed.attempt.attemptId,
        checkpoint: executionCheckpoint(claimed.run, claimed.attempt.attemptId),
      }, async () => {
        deliveries += 1;
        return {
          messageId: "must-not-send-settled-question",
          acceptAnswersAfterIngressRevision: 14,
        };
      }),
      GroupAgentRunConflictError,
    );
    assert.equal(deliveries, 0);
    assert.deepEqual(
      (await fixture.repository.load(completed.run.runId))?.questions,
      [],
    );
  });

  it("menyisakan slot event untuk recovery dan penutupan work", async () => {
    const rejectedFixture = await makeFixture();
    const rejectedAnchor = await startAnchored(rejectedFixture.service);
    await forceEventCount(rejectedFixture.file, 253);
    const saturated = await rejectedFixture.repository.load(
      rejectedAnchor.runId,
    );
    assert.ok(saturated);
    await assert.rejects(
      rejectedFixture.service.claimWorkAttempt({
        runId: saturated.runId,
        expectedStateRevision: saturated.stateRevision,
        claimKey: "dispatcher:no-closure-slot",
      }),
      GroupAgentRunConflictError,
    );
    assert.equal(
      (await rejectedFixture.repository.load(saturated.runId))?.events.length,
      253,
    );

    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    await forceEventCount(fixture.file, 252);
    const ready = await fixture.repository.load(anchored.runId);
    assert.ok(ready);
    const claimed = await fixture.service.claimWorkAttempt({
      runId: ready.runId,
      expectedStateRevision: ready.stateRevision,
      claimKey: "dispatcher:boundary-recovery",
    });
    assert.equal(claimed.run.events.length, 253);
    const completed = await fixture.service.completeWorkAttempt({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
    });
    assert.equal(completed.run.events.length, 254);

    const restarted = serviceFor(fixture.file, async () => true);
    const recovered = await restarted.recoverInterruptedRuns();
    assert.equal(recovered[0]?.status, "queued");
    assert.equal(recovered[0]?.events.length, 255);
    const cancelled = await restarted.routeMessage(message({
      messageId: "cancel-after-boundary-recovery",
      text: "batalkan pekerjaan ini",
      quotedMessageId: anchored.anchor.messageId,
      ingressRevision: 30,
    }));
    assert.equal(cancelled.status, "cancelled");
    if (cancelled.status !== "cancelled") assert.fail("run harus ditutup");
    assert.equal(cancelled.run.events.length, 256);
  });

  it("repository menolak state nonterminal yang memakai slot event terakhir", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    await forceEventCount(fixture.file, 255);
    const current = await fixture.repository.load(anchored.runId);
    assert.ok(current);
    const { stateRevision, ...draft } = structuredClone(current);
    draft.events = [...draft.events, {
      id: "work-cap-bypass-last-event",
      type: "input.proposed",
      at: NOW.toISOString(),
      instructionRevision: draft.instructionRevision,
      sourceMessageId: null,
      participantId: null,
    }];

    await assert.rejects(
      fixture.repository.save(draft, stateRevision, async () => true),
      /menyisakan slot event/iu,
    );
    assert.equal(
      (await fixture.repository.load(anchored.runId))?.events.length,
      255,
    );
  });

  it("menolak answer yang akan menghabiskan slot penutupan event", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    const claimed = await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      claimKey: "dispatcher:question-cap",
    });
    const waiting = await fixture.service.commitAssignedQuestion({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      prompt: "Kapan pekerjaan dijalankan?",
      assignee: structuredClone(claimed.run.initiator),
      attemptId: claimed.attempt.attemptId,
      checkpoint: executionCheckpoint(claimed.run, claimed.attempt.attemptId),
    }, async () => ({
      messageId: "question-at-cap",
      acceptAnswersAfterIngressRevision: 40,
    }));
    await forceEventCount(fixture.file, 255);

    const answer = await fixture.service.routeMessage(message({
      messageId: "answer-at-cap",
      text: "bisa Jumat",
      quotedMessageId: "question-at-cap",
      repliesToHarvy: true,
      ingressRevision: 41,
    }));
    assert.equal(answer.status, "rejected");
    if (answer.status !== "rejected") assert.fail("answer harus ditolak");
    assert.equal(answer.reason, "mailbox_full");
    const stillWaiting = await fixture.repository.load(waiting.runId);
    assert.equal(stillWaiting?.status, "waiting_input");
    assert.equal(stillWaiting?.events.length, 255);

    const cancelled = await fixture.service.routeMessage(message({
      messageId: "cancel-question-at-cap",
      text: "batalkan pekerjaan ini",
      quotedMessageId: anchored.anchor.messageId,
      ingressRevision: 42,
    }));
    assert.equal(cancelled.status, "cancelled");
    if (cancelled.status !== "cancelled") assert.fail("run harus ditutup");
    assert.equal(cancelled.run.events.length, 256);
  });

  it("recovery instance baru hanya merequeue attempt dan idempotent", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      claimKey: "dispatcher:restart",
    });

    const restarted = serviceFor(fixture.file, async () => true);
    const recovered = await restarted.recoverInterruptedRuns();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, "queued");
    assert.equal(recovered[0]?.workAttempts?.[0]?.status, "requeued");
    assert.equal(recovered[0]?.workAttempts?.[0]?.code, "process_interrupted");
    assert.equal(
      recovered[0]?.events.at(-1)?.type,
      "work.recovered",
    );
    assert.deepEqual(await restarted.recoverInterruptedRuns(), []);
  });

  it("recovery finalizing tanpa final receipt kembali queued tanpa memakai ulang claim", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    const claimed = await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      claimKey: "dispatcher:completed-before-crash",
    });
    const workCompleted = await fixture.service.completeWorkAttempt({
      runId: claimed.run.runId,
      expectedStateRevision: claimed.run.stateRevision,
      attemptId: claimed.attempt.attemptId,
    });
    assert.equal(workCompleted.run.phase, "finalizing");

    const restarted = serviceFor(fixture.file, async () => true);
    const recovered = await restarted.recoverInterruptedRuns();
    assert.equal(recovered[0]?.status, "queued");
    assert.equal(recovered[0]?.phase, "queued");
    assert.equal(recovered[0]?.workAttempts?.[0]?.status, "completed");
    await assert.rejects(
      restarted.claimWorkAttempt({
        runId: recovered[0]!.runId,
        expectedStateRevision: recovered[0]!.stateRevision,
        claimKey: "dispatcher:completed-before-crash",
      }),
      GroupAgentRunConflictError,
    );
    const fresh = await restarted.claimWorkAttempt({
      runId: recovered[0]!.runId,
      expectedStateRevision: recovered[0]!.stateRevision,
      claimKey: "dispatcher:after-finalizing-recovery",
    });
    assert.equal(fresh.status, "claimed");
    assert.equal(fresh.attempt.attemptNumber, 2);
  });

  it("purge mempertahankan attempt aktif dan recovery expired menutupnya failed", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      claimKey: "dispatcher:expired",
    });
    const afterHorizon = new Date(Date.parse(anchored.expiresAt) + 1);

    assert.equal(await fixture.repository.removeExpired(afterHorizon), 0);
    assert.notEqual(await fixture.repository.load(anchored.runId), null);

    const restarted = serviceFor(
      fixture.file,
      async () => true,
      new FileGroupAgentRunRepository(fixture.file),
      () => afterHorizon,
    );
    const recovered = await restarted.recoverInterruptedRuns();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, "failed");
    assert.equal(recovered[0]?.phase, "failed");
    assert.equal(recovered[0]?.workAttempts?.[0]?.status, "failed");
    assert.equal(recovered[0]?.workAttempts?.[0]?.code, "run_expired");
    assert.equal(recovered[0]?.events.at(-1)?.type, "run.expired");
    assert.equal(await fixture.repository.removeExpired(afterHorizon), 1);
  });

  it("memagari claim, settlement, dan recovery dengan runtime admission", async () => {
    let stage: "setup" | "claim" | "settle" | "recovery" = "setup";
    let stageChecks = 0;
    const fixture = await makeFixture(async () => {
      if (stage === "setup") return true;
      stageChecks += 1;
      if (stage === "recovery") return false;
      return stageChecks === 1;
    });
    const anchored = await startAnchored(fixture.service);

    stage = "claim";
    stageChecks = 0;
    await assert.rejects(
      fixture.service.claimWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: anchored.stateRevision,
        claimKey: "dispatcher:fenced-claim",
      }),
      GroupAgentRunRuntimeAdmissionError,
    );
    assert.deepEqual(
      (await fixture.repository.load(anchored.runId))?.workAttempts,
      [],
    );

    stage = "setup";
    const claimed = await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      claimKey: "dispatcher:allowed",
    });
    stage = "settle";
    stageChecks = 0;
    await assert.rejects(
      fixture.service.completeWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: claimed.run.stateRevision,
        attemptId: claimed.attempt.attemptId,
      }),
      GroupAgentRunRuntimeAdmissionError,
    );
    assert.equal(
      (await fixture.repository.load(anchored.runId))?.workAttempts?.[0]
        ?.status,
      "running",
    );

    stage = "recovery";
    stageChecks = 0;
    assert.deepEqual(await fixture.service.recoverInterruptedRuns(), []);
    assert.equal(
      (await fixture.repository.load(anchored.runId))?.workAttempts?.[0]
        ?.status,
      "running",
    );
  });

  it("menolak claim bila initiator durable sudah bukan anggota", async () => {
    let membershipActive = true;
    const fixture = await makeFixture(
      async () => true,
      {
        resolveGroupAuthority: async () => membershipActive
          ? { role: "member", authorityEpoch: 7 }
          : null,
      },
    );
    const anchored = await startAnchored(fixture.service);
    const eventsBeforeClaim = anchored.events.length;
    membershipActive = false;

    await assert.rejects(
      fixture.service.claimWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: anchored.stateRevision,
        claimKey: "dispatcher:removed-initiator",
      }),
      GroupAgentRunAuthorityError,
    );
    const stored = await fixture.repository.load(anchored.runId);
    assert.equal(stored?.stateRevision, anchored.stateRevision);
    assert.deepEqual(stored?.workAttempts, []);
    assert.equal(stored?.events.length, eventsBeforeClaim);
  });

  it("menolak claim bila authority epoch berubah di dalam guard CAS", async () => {
    let claimPhase = false;
    let claimAuthorityChecks = 0;
    const fixture = await makeFixture(
      async () => true,
      {
        resolveGroupAuthority: async () => {
          if (!claimPhase) return { role: "member", authorityEpoch: 7 };
          claimAuthorityChecks += 1;
          return {
            role: "member",
            authorityEpoch: claimAuthorityChecks === 1 ? 7 : 8,
          };
        },
      },
    );
    const anchored = await startAnchored(fixture.service);
    const eventsBeforeClaim = anchored.events.length;
    claimPhase = true;

    await assert.rejects(
      fixture.service.claimWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: anchored.stateRevision,
        claimKey: "dispatcher:epoch-flip",
      }),
      GroupAgentRunAuthorityError,
    );
    assert.equal(claimAuthorityChecks, 2);
    const stored = await fixture.repository.load(anchored.runId);
    assert.equal(stored?.stateRevision, anchored.stateRevision);
    assert.deepEqual(stored?.workAttempts, []);
    assert.equal(stored?.events.length, eventsBeforeClaim);
  });

  it("menolak claim bila resolver authority melempar error", async () => {
    let resolverFails = false;
    const fixture = await makeFixture(
      async () => true,
      {
        resolveGroupAuthority: async () => {
          if (resolverFails) throw new Error("metadata unavailable");
          return { role: "member", authorityEpoch: 7 };
        },
      },
    );
    const anchored = await startAnchored(fixture.service);
    const eventsBeforeClaim = anchored.events.length;
    resolverFails = true;

    await assert.rejects(
      fixture.service.claimWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: anchored.stateRevision,
        claimKey: "dispatcher:resolver-error",
      }),
      GroupAgentRunAuthorityError,
    );
    const stored = await fixture.repository.load(anchored.runId);
    assert.equal(stored?.stateRevision, anchored.stateRevision);
    assert.deepEqual(stored?.workAttempts, []);
    assert.equal(stored?.events.length, eventsBeforeClaim);
  });

  it("claim memverifikasi exact scope, account, dan alias durable initiator", async () => {
    let captureClaim = false;
    const claimRequests: GroupAuthorityRequest[] = [];
    const authority: GroupAuthorityResolver = {
      resolveGroupAuthority: async (request) => {
        if (captureClaim) claimRequests.push(structuredClone(request));
        return { role: "member", authorityEpoch: 7 };
      },
    };
    const fixture = await makeFixture(async () => true, authority);
    const anchored = await startAnchored(fixture.service, message({
      participantId: "p-primary",
      participantAliases: ["legacy@lid", "phone@s.whatsapp.net"],
    }));
    captureClaim = true;

    const claimed = await fixture.service.claimWorkAttempt({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      claimKey: "dispatcher:exact-identity",
    });

    assert.equal(claimed.status, "claimed");
    assert.equal(claimRequests.length, 2);
    for (const request of claimRequests) {
      assert.deepEqual(request.scope, {
        channel: "whatsapp",
        groupId: "work-lifecycle@g.us",
      });
      assert.equal(request.accountId, "utama");
      assert.deepEqual(request.participantIds, [
        "p-primary",
        "legacy@lid",
        "phone@s.whatsapp.net",
      ]);
      assert.equal(request.claimedAdmin, false);
      assert.equal(request.claimedAuthorityEpoch, 0);
    }
  });

  it("batas attempt men-terminalkan run dengan outcome work_attempt_limit", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    const database = JSON.parse(await readFile(fixture.file, "utf8")) as {
      version: 1;
      runs: Array<Record<string, unknown>>;
    };
    database.runs[0]!.stateRevision = 100;
    database.runs[0]!.workAttempts = Array.from({ length: 32 }, (_, index) => ({
      attemptId: `limit-attempt-${index + 1}`,
      claimKey: `limit-claim-${index + 1}`,
      attemptNumber: index + 1,
      instructionRevision: 0,
      claimedStateRevision: index + 10,
      status: "requeued",
      startedAt: NOW.toISOString(),
      settledAt: NOW.toISOString(),
      code: "process_interrupted",
    }));
    await writeFile(
      fixture.file,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );

    await assert.rejects(
      fixture.service.claimWorkAttempt({
        runId: anchored.runId,
        expectedStateRevision: 100,
        claimKey: "limit-claim-next",
      }),
      (error: unknown) =>
        error instanceof GroupAgentRunWorkAttemptLimitError &&
        error.code === "work_attempt_limit" && error.run.status === "failed",
    );
    const stored = await fixture.repository.load(anchored.runId);
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.phase, "failed");
    assert.equal(stored?.completedAt, NOW.toISOString());
    assert.equal(stored?.workAttempts?.length, 32);
    assert.equal(stored?.events.at(-1)?.type, "work.failed");
  });

  it("memigrasikan record v1 tanpa work ledger secara konservatif", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({ message: message() });
    assert.equal(started.status, "started");
    const database = JSON.parse(await readFile(fixture.file, "utf8")) as {
      version: 1;
      runs: Array<Record<string, unknown>>;
    };
    database.runs[0]!.version = 1;
    database.runs[0]!.status = "running";
    database.runs[0]!.phase = "planning";
    delete database.runs[0]!.pendingEffect;
    delete database.runs[0]!.receipts;
    delete database.runs[0]!.workAttempts;
    delete database.runs[0]!.result;
    delete database.runs[0]!.checkpoint;
    await writeFile(
      fixture.file,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );

    const migrated = await new FileGroupAgentRunRepository(fixture.file).load(
      started.run.runId,
    );
    assert.equal(migrated?.version, 2);
    assert.deepEqual(migrated?.workAttempts, []);
    assert.equal(migrated?.result, null);
    assert.equal(migrated?.status, "queued");
    assert.equal(migrated?.phase, "queued");
  });

  it("menormalisasi legacy completed tanpa final receipt menjadi partial", async () => {
    const fixture = await makeFixture();
    const started = await fixture.service.start({ message: message() });
    assert.equal(started.status, "started");
    const database = JSON.parse(await readFile(fixture.file, "utf8")) as {
      version: 1;
      runs: Array<Record<string, unknown>>;
    };
    database.runs[0]!.version = 1;
    database.runs[0]!.status = "completed";
    database.runs[0]!.phase = "completed";
    database.runs[0]!.completedAt = NOW.toISOString();
    delete database.runs[0]!.pendingEffect;
    delete database.runs[0]!.receipts;
    delete database.runs[0]!.workAttempts;
    delete database.runs[0]!.result;
    delete database.runs[0]!.checkpoint;
    await writeFile(
      fixture.file,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );

    const migrated = await new FileGroupAgentRunRepository(fixture.file).load(
      started.run.runId,
    );
    assert.equal(migrated?.status, "partial");
    assert.equal(migrated?.phase, "failed");
    assert.equal(migrated?.completedAt, NOW.toISOString());
    assert.equal(migrated?.result, null);
    assert.deepEqual(migrated?.receipts, []);
    assert.deepEqual(migrated?.workAttempts, []);
  });

  it("memigrasikan legacy v2 workless dengan pertanyaan open ke waiting_input", async () => {
    const fixture = await makeFixture();
    const anchored = await startAnchored(fixture.service);
    const waiting = await fixture.service.commitAssignedQuestion({
      runId: anchored.runId,
      expectedStateRevision: anchored.stateRevision,
      prompt: "Pilih waktu rapat",
      assignee: structuredClone(anchored.initiator),
    }, async () => ({
      messageId: "legacy-question",
      acceptAnswersAfterIngressRevision: 5,
    }));
    const database = JSON.parse(await readFile(fixture.file, "utf8")) as {
      version: 1;
      runs: Array<Record<string, unknown>>;
    };
    database.runs[0]!.status = "paused";
    database.runs[0]!.phase = "planning";
    delete database.runs[0]!.workAttempts;
    delete database.runs[0]!.result;
    delete database.runs[0]!.checkpoint;
    await writeFile(
      fixture.file,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );

    const migrated = await new FileGroupAgentRunRepository(fixture.file).load(
      waiting.runId,
    );
    assert.equal(migrated?.status, "waiting_input");
    assert.equal(migrated?.phase, "waiting_input");
    assert.deepEqual(migrated?.workAttempts, []);
    assert.equal(migrated?.result, null);
  });
});

async function makeFixture(
  runtimeAdmission: GroupAgentRunRuntimeAdmissionResolver = async () => true,
  authority: GroupAuthorityResolver = authorityResolver(),
): Promise<{
  file: string;
  service: GroupAgentRunService;
  repository: FileGroupAgentRunRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-run-work-"));
  const file = join(root, "runs.json");
  const repository = new FileGroupAgentRunRepository(file);
  return {
    file,
    repository,
    service: serviceFor(file, runtimeAdmission, repository, () => NOW, authority),
  };
}

function serviceFor(
  file: string,
  runtimeAdmission: GroupAgentRunRuntimeAdmissionResolver,
  repository = new FileGroupAgentRunRepository(file),
  now: () => Date = () => NOW,
  authority: GroupAuthorityResolver = authorityResolver(),
): GroupAgentRunService {
  let sequence = 0;
  return new GroupAgentRunService(
    repository,
    authority,
    now,
    () => `work-${++sequence}`,
    runtimeAdmission,
  );
}

async function startAnchored(
  service: GroupAgentRunService,
  startMessage: GroupMessage = message(),
) {
  const started = await service.start({ message: startMessage });
  assert.equal(started.status, "started");
  return service.commitAnchor(
    started.run.runId,
    started.run.stateRevision,
    "📌 Pekerjaan grup",
    async () => ({ messageId: "anchor-work" }),
  );
}

function authorityResolver(): GroupAuthorityResolver {
  return {
    resolveGroupAuthority: async (_request: GroupAuthorityRequest) => ({
      role: "member",
      authorityEpoch: 7,
    }),
  };
}

async function forceEventCount(file: string, count: number): Promise<void> {
  const database = JSON.parse(await readFile(file, "utf8")) as {
    version: 1;
    runs: Array<{
      instructionRevision: number;
      events: Array<Record<string, unknown>>;
    }>;
  };
  const run = database.runs[0]!;
  while (run.events.length < count) {
    const index = run.events.length;
    run.events.push({
      id: `work-cap-filler-${index}`,
      type: "input.proposed",
      at: NOW.toISOString(),
      instructionRevision: run.instructionRevision,
      sourceMessageId: null,
      participantId: null,
    });
  }
  await writeFile(file, `${JSON.stringify(database, null, 2)}\n`, "utf8");
}

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "work-lifecycle@g.us" },
    accountId: "utama",
    messageId: "start-work",
    participantId: "p1",
    participantAliases: [],
    participantName: "Ayu",
    groupName: "Grup work",
    text: "Harvy, mulai pekerjaan ini",
    at: NOW.toISOString(),
    mentionsHarvy: true,
    repliesToHarvy: false,
    isAdmin: false,
    authorityEpoch: 7,
    ...overrides,
  };
}

function executionCheckpoint(
  run: GroupAgentRun,
  attemptId: string,
  sequence = 1,
): GroupRunExecutionCheckpoint {
  return {
    version: 1,
    engine: "group-model-v1",
    attemptId,
    sequence,
    instructionRevision: run.instructionRevision,
    inputDigest: groupRunExecutionInputDigest(run),
    waitingQuestionId: null,
    budget: new RunBudgetAccount({}, () => NOW.getTime()).checkpoint(),
    updatedAt: NOW.toISOString(),
  };
}
