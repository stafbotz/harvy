import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ActiveAgentRunStaleError,
  AgentRunService,
} from "../src/core/agent-run-service.js";
import type { AgentRunCheckpoint } from "../src/harness/agent-harness.js";
import { privateAgentScope, scopeKey } from "../src/harness/scope.js";
import { FileAgentRunRepository } from "../src/storage/file-agent-run-repository.js";

describe("active AgentRun Phase D", () => {
  it("memulihkan active state lintas instance dan menolak foreground kedua", async () => {
    const file = await temporaryFile();
    const service = serviceAt(file);
    const started = await service.startActive(startInput());
    assert.equal(started.status, "started");
    if (started.status !== "started") return;

    const duplicate = await service.startActive({
      ...startInput(),
      request: "pekerjaan kedua",
    });
    assert.equal(duplicate.status, "foreground_exists");
    assert.equal(duplicate.run.runId, started.run.runId);

    const restarted = serviceAt(file);
    const recovered = await restarted.loadForegroundActive("telegram", "alice");
    assert.equal(recovered?.runId, started.run.runId);
    assert.equal(recovered?.context.summary, "Ringkasan lama");
    assert.equal(recovered?.instructionRevision, 1);
  });

  it("memilih terminal terbaru meski dua transisi mempunyai timestamp sama", async () => {
    const file = await temporaryFile();
    const service = serviceAt(file);
    const first = await service.startActive(startInput());
    assert.equal(first.status, "started");
    if (first.status !== "started") return;
    await service.beginActiveAttempt("telegram", "alice", first.run.runId);
    await service.commitActiveFinal(
      {
        channel: "telegram",
        ownerId: "alice",
        runId: first.run.runId,
        inputRevision: 1,
        checkpoint: makeCheckpoint(first.run.runId),
        reply: "hasil pertama",
      },
      async () => ({ externalId: "terminal-1" }),
    );

    const second = await service.startActive({
      ...startInput(),
      request: "Buat rencana kedua.",
    });
    assert.equal(second.status, "started");
    if (second.status !== "started") return;
    await service.beginActiveAttempt("telegram", "alice", second.run.runId);
    await service.commitActiveFinal(
      {
        channel: "telegram",
        ownerId: "alice",
        runId: second.run.runId,
        inputRevision: 1,
        checkpoint: makeCheckpoint(second.run.runId, {
          request: "Buat rencana kedua.",
        }),
        reply: "hasil kedua",
      },
      async () => ({ externalId: "terminal-2" }),
    );

    assert.equal(
      (await service.loadActive("telegram", "alice"))?.runId,
      second.run.runId,
    );
    assert.equal(
      (await new FileAgentRunRepository(file).listActive("telegram")).length,
      1,
    );
  });

  it("mengganti terminal v2 ketika checkpoint sinkron v1 baru dimulai", async () => {
    const file = await temporaryFile();
    const service = serviceAt(file);
    const active = await service.startActive(startInput());
    assert.equal(active.status, "started");
    if (active.status !== "started") return;
    await service.beginActiveAttempt("telegram", "alice", active.run.runId);
    await service.commitActiveFinal(
      {
        channel: "telegram",
        ownerId: "alice",
        runId: active.run.runId,
        inputRevision: 1,
        checkpoint: makeCheckpoint(active.run.runId),
        reply: "hasil active",
      },
      async () => ({ externalId: "active-terminal" }),
    );
    const request = "Cek tugas yang mana?";
    const checkpoint = makeCheckpoint("run-legacy-after-active", {
      request,
      pendingInput: { step: 0, prompt: "Tugas yang mana?" },
    });
    const saved = await service.saveWaitingInput({
      channel: "telegram",
      ownerId: "alice",
      request,
      mode: "tools",
      intent: "question",
      acceptAnswersAfterUpdateId: 60,
      checkpoint,
      expectedRevision: null,
    });

    assert.equal(saved.runId, "run-legacy-after-active");
    assert.equal(await service.loadActive("telegram", "alice"), null);
    assert.equal((await service.export("telegram", "alice"))?.version, 1);
  });

  it("membentuk ChangeSet dan me-rebase checkpoint tanpa membuang observation", async () => {
    const file = await temporaryFile();
    const service = serviceAt(file);
    const started = await service.startActive(startInput());
    assert.equal(started.status, "started");
    if (started.status !== "started") return;
    const first = await service.beginActiveAttempt(
      "telegram",
      "alice",
      started.run.runId,
    );
    assert.equal(first?.inputRevision, 1);

    const routed = await service.routeActiveMessage({
      channel: "telegram",
      ownerId: "alice",
      runId: started.run.runId,
      kind: "correction",
      content: "Jangan buat pengingat; cukup rencananya.",
      sourceMessageId: "telegram:22",
    });
    assert.equal(routed.status, "accepted");
    if (routed.status !== "accepted") return;
    assert.equal(routed.run.instructionRevision, 2);
    assert.equal(routed.run.changeSets[0]?.kind, "correction");
    assert.equal(
      await service.isActiveAttemptCurrent(
        "telegram",
        "alice",
        started.run.runId,
        1,
      ),
      false,
    );

    const checkpoint = makeCheckpoint(started.run.runId, {
      observations: [{
        step: 0,
        capabilityId: "task.list_active",
        status: "ok",
        summary: "Ada dua tugas.",
      }],
    });
    await service.requeueStaleActive(
      "telegram",
      "alice",
      started.run.runId,
      1,
      checkpoint,
    );
    const revised = await service.beginActiveAttempt(
      "telegram",
      "alice",
      started.run.runId,
    );
    assert.equal(revised?.inputRevision, 2);
    assert.equal(revised?.checkpoint?.observations.length, 1);
    assert.match(
      revised?.checkpoint?.userInputs.at(-1)?.text ?? "",
      /Jangan buat pengingat/iu,
    );
    assert.equal(revised?.checkpoint?.pendingInput, null);
  });

  it("mempertahankan koreksi sebelum attempt pertama tanpa menduplikasinya saat resume", async () => {
    const file = await temporaryFile();
    const service = serviceAt(file);
    const started = await service.startActive(startInput());
    assert.equal(started.status, "started");
    if (started.status !== "started") return;
    await service.routeActiveMessage({
      channel: "telegram",
      ownerId: "alice",
      runId: started.run.runId,
      kind: "constraint",
      content: "Jumat sore ada basket.",
      sourceMessageId: "telegram:pre-attempt",
    });
    const first = await service.beginActiveAttempt(
      "telegram",
      "alice",
      started.run.runId,
    );
    assert.equal(first?.inputRevision, 2);
    assert.equal(first?.initialUserInputs?.length, 1);
    const checkpoint = makeCheckpoint(started.run.runId, {
      userInputs: first?.initialUserInputs ?? [],
    });
    await service.settleActiveStopped(
      "telegram",
      "alice",
      started.run.runId,
      2,
      {
        status: "stopped",
        reason: "cancelled",
        checkpoint,
        trace: [],
      },
      true,
    );

    const restarted = serviceAt(file);
    await restarted.recoverInterruptedActiveRuns("telegram");
    const resumed = await restarted.beginActiveAttempt(
      "telegram",
      "alice",
      started.run.runId,
    );
    assert.equal(resumed?.initialUserInputs, undefined);
    assert.equal(resumed?.checkpoint?.userInputs.length, 1);
    assert.match(
      resumed?.checkpoint?.userInputs[0]?.text ?? "",
      /Jumat sore ada basket/iu,
    );
  });

  it("menahan hasil basi dan hanya mencatat receipt setelah commit revision terbaru", async () => {
    const file = await temporaryFile();
    const service = serviceAt(file);
    const started = await service.startActive(startInput());
    assert.equal(started.status, "started");
    if (started.status !== "started") return;
    await service.beginActiveAttempt("telegram", "alice", started.run.runId);
    await service.routeActiveMessage({
      channel: "telegram",
      ownerId: "alice",
      runId: started.run.runId,
      kind: "constraint",
      content: "Jumat sore ada basket.",
      sourceMessageId: "telegram:23",
    });
    let deliveries = 0;
    await assert.rejects(
      service.commitActiveFinal(
        {
          channel: "telegram",
          ownerId: "alice",
          runId: started.run.runId,
          inputRevision: 1,
          checkpoint: makeCheckpoint(started.run.runId),
          reply: "hasil basi",
        },
        async () => {
          deliveries += 1;
          return { externalId: "99" };
        },
      ),
      ActiveAgentRunStaleError,
    );
    assert.equal(deliveries, 0);

    await service.requeueStaleActive(
      "telegram",
      "alice",
      started.run.runId,
      1,
      makeCheckpoint(started.run.runId),
    );
    const revised = await service.beginActiveAttempt(
      "telegram",
      "alice",
      started.run.runId,
    );
    assert.equal(revised?.inputRevision, 2);
    const completed = await service.commitActiveFinal(
      {
        channel: "telegram",
        ownerId: "alice",
        runId: started.run.runId,
        inputRevision: 2,
        checkpoint: revised!.checkpoint!,
        reply: "Rencana terbaru sudah siap.",
      },
      async () => {
        deliveries += 1;
        return { externalId: "100" };
      },
    );
    assert.equal(deliveries, 1);
    assert.equal(completed.status, "completed");
    assert.equal(completed.receipts[0]?.status, "committed");
    assert.equal(completed.receipts[0]?.externalId, "100");
    assert.equal(completed.result?.instructionRevision, 2);
  });

  it("mengikat jawaban ke run, question, quote, dan watermark yang tepat", async () => {
    const file = await temporaryFile();
    const service = serviceAt(file);
    const started = await service.startActive(startInput());
    assert.equal(started.status, "started");
    if (started.status !== "started") return;
    await service.beginActiveAttempt("telegram", "alice", started.run.runId);
    const checkpoint = makeCheckpoint(started.run.runId, {
      pendingInput: { step: 0, prompt: "Sabtu pagi bisa belajar?" },
    });
    const waiting = await service.commitActiveQuestion(
      {
        channel: "telegram",
        ownerId: "alice",
        runId: started.run.runId,
        inputRevision: 1,
        checkpoint,
        prompt: "Sabtu pagi bisa belajar?",
        acceptAnswersAfterUpdateId: 30,
      },
      async () => ({ externalId: "question-message" }),
    );
    assert.equal(waiting.status, "waiting_input");
    const questionId = waiting.pendingQuestion!.questionId;

    const stale = await service.routeActiveMessage({
      channel: "telegram",
      ownerId: "alice",
      runId: started.run.runId,
      kind: "answer",
      content: "bisa",
      sourceMessageId: "telegram:30",
      questionId,
      ingressUpdateId: 30,
    });
    assert.equal(stale.status, "not_applicable");
    const wrongQuestion = await service.routeActiveMessage({
      channel: "telegram",
      ownerId: "alice",
      runId: started.run.runId,
      kind: "answer",
      content: "bisa",
      sourceMessageId: "telegram:31",
      questionId: "question-lain",
      ingressUpdateId: 31,
    });
    assert.equal(wrongQuestion.status, "not_applicable");
    const accepted = await service.routeActiveMessage({
      channel: "telegram",
      ownerId: "alice",
      runId: started.run.runId,
      kind: "answer",
      content: "bisa",
      sourceMessageId: "telegram:31",
      questionId,
      ingressUpdateId: 31,
    });
    assert.equal(accepted.status, "accepted");
    const resumed = await service.beginActiveAttempt(
      "telegram",
      "alice",
      started.run.runId,
    );
    assert.equal(resumed?.answer, "bisa");
    assert.equal(resumed?.checkpoint?.pendingInput?.prompt, checkpoint.pendingInput?.prompt);
  });

  it("menutup pertanyaan kedaluwarsa pada ingress tanpa menghidupkan checkpoint", async () => {
    const file = await temporaryFile();
    let now = new Date("2026-08-09T05:01:00.000Z");
    let sequence = 0;
    const service = new AgentRunService(
      new FileAgentRunRepository(file),
      () => now,
      () => `expiry-id-${String(++sequence).padStart(4, "0")}`,
    );
    const started = await service.startActive(startInput());
    assert.equal(started.status, "started");
    if (started.status !== "started") return;
    await service.beginActiveAttempt("telegram", "alice", started.run.runId);
    const prompt = "Sabtu pagi bisa belajar?";
    await service.commitActiveQuestion(
      {
        channel: "telegram",
        ownerId: "alice",
        runId: started.run.runId,
        inputRevision: 1,
        checkpoint: makeCheckpoint(started.run.runId, {
          pendingInput: { step: 0, prompt },
        }),
        prompt,
        acceptAnswersAfterUpdateId: 30,
      },
      async () => ({ externalId: "question-message" }),
    );

    now = new Date("2026-08-09T05:12:00.000Z");
    const expired = await service.expireWaitingActive("telegram", "alice");
    assert.equal(expired?.status, "failed");
    assert.equal(expired?.lastError?.code, "input_expired");
    assert.equal(expired?.pendingQuestion, null);
    assert.equal(expired?.checkpoint?.pendingInput, null);
    assert.equal(expired?.workUnits.at(-1)?.status, "failed");
    assert.equal(
      await service.expireWaitingActive("telegram", "alice"),
      null,
    );
    assert.equal(await service.loadForegroundActive("telegram", "alice"), null);
    now = new Date("2026-08-17T05:12:01.000Z");
    assert.equal(await service.loadActive("telegram", "alice"), null);
    assert.equal(
      (await new FileAgentRunRepository(file).listActive("telegram")).length,
      0,
    );
  });

  it("menganggap delivery in-flight saat restart sebagai unknown dan tidak mengulangnya", async () => {
    const file = await temporaryFile();
    const service = serviceAt(file);
    const started = await service.startActive(startInput());
    assert.equal(started.status, "started");
    if (started.status !== "started") return;
    await service.beginActiveAttempt("telegram", "alice", started.run.runId);
    const enteredDelivery = deferred<void>();
    const releaseDelivery = deferred<void>();
    const committing = service.commitActiveFinal(
      {
        channel: "telegram",
        ownerId: "alice",
        runId: started.run.runId,
        inputRevision: 1,
        checkpoint: makeCheckpoint(started.run.runId),
        reply: "hasil",
      },
      async () => {
        enteredDelivery.resolve();
        await releaseDelivery.promise;
        return { externalId: "ambiguous-message" };
      },
    );
    await enteredDelivery.promise;

    const restarted = serviceAt(file);
    const recoveredRuns = await restarted.recoverInterruptedActiveRuns("telegram");
    assert.equal(recoveredRuns.length, 1);
    assert.equal(recoveredRuns[0]?.status, "partial");
    const recovered = await restarted.loadActive("telegram", "alice");
    assert.equal(recovered?.status, "partial");
    assert.equal(recovered?.receipts[0]?.status, "unknown");
    assert.equal(recovered?.pendingQuestion, null);
    assert.equal(recovered?.workUnits.at(-1)?.status, "failed");

    releaseDelivery.resolve();
    await assert.rejects(committing);
    assert.equal(
      (await restarted.loadActive("telegram", "alice"))?.receipts.length,
      1,
    );
  });

  it("mengekspor mailbox dan receipt tanpa context snapshot atau effect id", async () => {
    const file = await temporaryFile();
    const service = serviceAt(file);
    const started = await service.startActive(startInput());
    assert.equal(started.status, "started");
    if (started.status !== "started") return;
    const routed = await service.routeActiveMessage({
      channel: "telegram",
      ownerId: "alice",
      runId: started.run.runId,
      kind: "constraint",
      content: "Jumat sore ada basket.",
      sourceMessageId: "telegram:52",
    });
    assert.equal(routed.status, "accepted");
    const attempt = await service.beginActiveAttempt(
      "telegram",
      "alice",
      started.run.runId,
    );
    assert.match(
      attempt?.initialUserInputs?.[0]?.text ?? "",
      /Jumat sore ada basket/iu,
    );
    await service.commitActiveFinal(
      {
        channel: "telegram",
        ownerId: "alice",
        runId: started.run.runId,
        inputRevision: 2,
        checkpoint: makeCheckpoint(started.run.runId, {
          userInputs: attempt?.initialUserInputs ?? [],
        }),
        reply: "selesai",
      },
      async () => ({ externalId: "101" }),
    );
    const exported = await service.export("telegram", "alice");
    assert.equal(exported?.version, 2);
    assert.equal(exported?.status, "completed");
    if (exported?.version === 2) {
      assert.equal(exported.mailbox[0]?.content, "Jumat sore ada basket.");
    }
    assert.doesNotMatch(
      JSON.stringify(exported),
      /Ringkasan lama|effectId|capabilityHash|callableHash/iu,
    );
  });
});

function startInput() {
  return {
    channel: "telegram" as const,
    ownerId: "alice",
    request: "Buat rencana belajar sampai ujian.",
    mode: "orchestrate" as const,
    intent: "request" as const,
    timeZone: "Asia/Jakarta",
    style: "advice" as const,
    context: {
      summary: "Ringkasan lama",
      turns: [{
        role: "user" as const,
        text: "Ujian dua minggu lagi.",
        at: "2026-08-09T05:00:00.000Z",
      }],
      memories: [{
        id: "memory-1",
        kind: "preference" as const,
        content: "Lebih nyaman belajar pagi.",
      }],
    },
    chatId: "alice",
    turnId: "turn-active-0001",
  };
}

function serviceAt(file: string): AgentRunService {
  let sequence = 0;
  const serviceId = ++serviceSequence;
  return new AgentRunService(
    new FileAgentRunRepository(file),
    () => new Date("2026-08-09T05:01:00.000Z"),
    () =>
      `generated-id-${serviceId}-${String(++sequence).padStart(4, "0")}`,
  );
}

let serviceSequence = 0;

function makeCheckpoint(
  runId: string,
  overrides: Partial<AgentRunCheckpoint> = {},
): AgentRunCheckpoint {
  return {
    version: 1,
    runId,
    scopeKey: scopeKey(privateAgentScope("telegram", "alice")),
    capabilityHash: "a".repeat(16),
    callableHash: "b".repeat(64),
    request: "Buat rencana belajar sampai ujian.",
    startedAt: "2026-08-09T05:01:00.000Z",
    deadlineAt: "2026-08-09T05:11:00.000Z",
    maxSteps: 6,
    step: 0,
    observations: [],
    userInputs: [],
    seenActionDigests: [],
    pending: null,
    pendingInput: null,
    ...overrides,
  };
}

async function temporaryFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harvy-active-agent-run-"));
  return join(root, "agent-runs.json");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
