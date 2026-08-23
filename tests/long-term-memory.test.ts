import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { HistoryService } from "../src/core/history-service.js";
import {
  LongTermMemoryService,
  normalizeFailureSignature,
} from "../src/core/long-term-memory-service.js";
import { privateMemoryNamespace } from "../src/core/memory-namespace.js";
import { FileHistoryRepository } from "../src/storage/file-history-repository.js";
import { SqliteLongTermMemoryRepository } from
  "../src/storage/sqlite-long-term-memory-repository.js";
import { HISTORY_EPISODE_RETENTION_LIMIT } from "../src/domain/history.js";
import type {
  ConversationEpisode,
  EpisodeSummaryDraft,
  StoredConversationTurn,
} from "../src/domain/history.js";
import type {
  LearningEventPayload,
  ProcedureDraft,
} from "../src/domain/long-term-memory.js";
import type { AgentRunResult } from "../src/harness/agent-harness.js";
import { privateAgentScope, scopeKey } from "../src/harness/scope.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("durable episodic archive", () => {
  it("menemukan episode setelah hot eviction dan restart tanpa memuat archive ke hot state", async () => {
    const directory = await temporaryDirectory();
    const historyFile = join(directory, "history.json");
    const archiveFile = join(directory, "long-term.sqlite");
    let clock = Date.parse("2025-01-01T00:00:00.000Z");
    const now = () => new Date(clock++);
    let repository = new SqliteLongTermMemoryRepository(archiveFile);
    let longTerm = new LongTermMemoryService(repository, now);
    let history = new HistoryService(
      new FileHistoryRepository(historyFile),
      async (turns) => episodeDraft(turns),
      now,
      undefined,
      longTerm,
    );

    for (let cycle = 0; cycle < HISTORY_EPISODE_RETENTION_LIMIT + 3; cycle += 1) {
      const additions = cycle === 0 ? 17 : 11;
      for (let index = 0; index < additions; index += 1) {
        const marker = cycle === 0 && index === 0 ? "primordial-github-fix" : "ordinary";
        await history.append("owner-a", "user", `${marker} ${cycle}-${index}`);
      }
      await history.compact("owner-a");
    }

    const hot = await history.snapshot("owner-a");
    assert.equal(hot?.episodes.length, HISTORY_EPISODE_RETENTION_LIMIT);
    assert.equal(
      hot?.episodes.some((episode) =>
        episode.facts.some((claim) => claim.text.includes("primordial"))),
      false,
    );
    assert.equal(
      (await longTerm.list(privateMemoryNamespace("owner-a"))).length,
      HISTORY_EPISODE_RETENTION_LIMIT + 3,
    );
    assert.deepEqual(
      await longTerm.list(privateMemoryNamespace("owner-b")),
      [],
    );

    await history.drain();
    longTerm.stop();
    await longTerm.drain();
    longTerm.close();

    repository = new SqliteLongTermMemoryRepository(archiveFile);
    longTerm = new LongTermMemoryService(repository, now);
    history = new HistoryService(
      new FileHistoryRepository(historyFile),
      async (turns) => episodeDraft(turns),
      now,
      undefined,
      longTerm,
    );
    const recalled = await history.search("owner-a", "primordial github fix");
    assert.equal(recalled.length, 1);
    assert.match(recalled[0]?.claims[0]?.text ?? "", /primordial-github-fix/u);

    assert.equal(await history.forget("owner-a"), true);
    assert.deepEqual(await history.search("owner-a", "primordial github fix"), []);
    assert.deepEqual(await longTerm.list(privateMemoryNamespace("owner-a")), []);
    longTerm.close();
  });
});

describe("evidence-backed learning", () => {
  it("mempelajari run WhatsApp privat pada namespace owner kanal itu", async () => {
    const directory = await temporaryDirectory();
    const repository = new SqliteLongTermMemoryRepository(
      join(directory, "long-term.sqlite"),
    );
    const service = new LongTermMemoryService(repository, tickingClock());
    const ownerId = "whatsapp-user:test";
    const scope = privateAgentScope("whatsapp", ownerId);
    const startedAt = "2026-08-21T00:00:00.000Z";
    const result: AgentRunResult = {
      status: "completed",
      reply: "Selesai.",
      checkpoint: {
        version: 2,
        runId: "run-whatsapp",
        scopeKey: scopeKey(scope),
        capabilityHash: "capability-hash",
        callableHash: "callable-hash",
        request: "susun agenda matematika",
        startedAt,
        deadlineAt: "2026-08-21T00:01:00.000Z",
        maxSteps: 6,
        step: 1,
        observations: [{
          step: 0,
          capabilityId: "calendar.agenda",
          status: "ok",
          summary: "{}",
        }],
        userInputs: [],
        seenActionDigests: [],
        pending: null,
        pendingInput: null,
        runBudget: new RunBudgetAccount().checkpoint(),
      },
      trace: [],
    };

    await service.observeAgentRun(
      { scope, request: "susun agenda matematika" },
      result,
    );
    await service.drain();
    const snapshot = await service.snapshotPrivateOwner(ownerId);
    assert.equal(snapshot.procedures.length, 1);
    assert.deepEqual(snapshot.procedures[0]?.toolRequirements, ["calendar.agenda"]);
    service.stop();
    await service.drain();
    service.close();
  });

  it("mempromosikan procedure secara idempoten lalu mendegradasikannya setelah failure berulang", async () => {
    const directory = await temporaryDirectory();
    const repository = new SqliteLongTermMemoryRepository(
      join(directory, "long-term.sqlite"),
    );
    const service = new LongTermMemoryService(repository, tickingClock());
    const namespace = privateMemoryNamespace("owner-a");
    const draft = deployProcedure();

    for (const runId of ["run-1", "run-2"]) {
      assert.equal(await service.enqueue(namespace, "procedure_success", {
        procedure: draft,
        sourceRunId: runId,
        outcome: successfulOutcome(),
        evidence: [evidence(runId)],
      }, `success:${runId}`), "enqueued");
    }
    await service.drain();
    let snapshot = await service.snapshotPrivateOwner("owner-a");
    assert.equal(snapshot.procedures.length, 1);
    assert.equal(snapshot.procedures[0]?.status, "active");
    assert.equal(snapshot.procedures[0]?.successCount, 2);
    assert.equal(snapshot.procedures[0]?.verifiedSuccessCount, 2);

    assert.equal(await service.enqueue(namespace, "procedure_success", {
      procedure: draft,
      sourceRunId: "run-2",
      outcome: successfulOutcome(),
      evidence: [evidence("run-2")],
    }, "success:run-2"), "deduped");

    for (const runId of ["run-3", "run-4"]) {
      await service.enqueue(namespace, "procedure_failure", {
        procedure: draft,
        sourceRunId: runId,
        outcome: {
          technical: "failure",
          task: "failure",
          user: "unknown",
          verified: false,
        },
        evidence: [evidence(runId)],
      }, `failure:${runId}`);
    }
    await service.drain();
    snapshot = await service.snapshotPrivateOwner("owner-a");
    assert.equal(snapshot.procedures[0]?.status, "degraded");
    assert.equal(snapshot.procedures[0]?.failureCount, 2);
    assert.equal(snapshot.candidates.length, 1, "candidate semantic harus dedup");

    const other = await service.snapshotPrivateOwner("owner-b");
    assert.deepEqual(other.procedures, []);
    service.close();
  });

  it("menyimpan recovery lesson dan menemukannya lewat exact fingerprint", async () => {
    const directory = await temporaryDirectory();
    const repository = new SqliteLongTermMemoryRepository(
      join(directory, "long-term.sqlite"),
    );
    const service = new LongTermMemoryService(repository, tickingClock());
    const namespace = privateMemoryNamespace("owner-a");
    const signature = normalizeFailureSignature({
      tool: "github.create-pr",
      operation: "create pull request",
      message: "Request ID 88aa: remote ref refs/heads/fix was not found at 2026-08-20T10:11:12Z",
      errorCode: "REF_NOT_FOUND",
      environment: "github-v3",
    });
    await service.enqueue(namespace, "tool_recovered", {
      failure: signature,
      recovery: ["Push branch, verify remote ref, lalu ulangi create PR."],
      rootCause: "Branch belum berada di remote.",
      outcome: successfulOutcome(),
      evidence: [evidence("recovery-1")],
    }, "recovery-1");
    await service.drain();

    const lesson = await service.findErrorLesson(namespace, signature);
    assert.equal(lesson?.status, "active");
    assert.match(lesson?.successfulRecovery[0] ?? "", /Push branch/u);
    const fuzzy = await service.searchErrorLessons(
      namespace,
      "github remote ref create pull request gagal",
      4,
    );
    assert.equal(fuzzy.length, 1);
    service.close();
  });

  it("membuat versi procedure baru tanpa menimpa versi historis", async () => {
    const directory = await temporaryDirectory();
    const repository = new SqliteLongTermMemoryRepository(
      join(directory, "long-term.sqlite"),
    );
    const service = new LongTermMemoryService(repository, tickingClock());
    const namespace = privateMemoryNamespace("owner-a");
    const v1 = deployProcedure();
    for (const runId of ["v1-a", "v1-b"]) {
      await service.enqueue(namespace, "procedure_success", {
        procedure: v1,
        sourceRunId: runId,
        outcome: successfulOutcome(),
        evidence: [evidence(runId)],
      }, runId);
    }
    await service.drain();
    const v2 = {
      ...v1,
      verification: ["Periksa health endpoint, smoke test, dan metric error."],
    };
    for (const runId of ["v2-a", "v2-b"]) {
      await service.enqueue(namespace, "procedure_success", {
        procedure: v2,
        sourceRunId: runId,
        outcome: successfulOutcome(),
        evidence: [evidence(runId)],
      }, runId);
    }
    await service.drain();

    const procedures = (await service.snapshotPrivateOwner("owner-a")).procedures;
    assert.equal(procedures.length, 2);
    assert.deepEqual(
      procedures.map((procedure) => [procedure.version, procedure.status]),
      [[1, "superseded"], [2, "active"]],
    );
    assert.equal(procedures[1]?.supersedesVersion, 1);
    service.close();
  });

  it("membuat preference temporal dan correction men-supersede nilai lama", async () => {
    const directory = await temporaryDirectory();
    const repository = new SqliteLongTermMemoryRepository(
      join(directory, "long-term.sqlite"),
    );
    const service = new LongTermMemoryService(repository, tickingClock());
    const namespace = privateMemoryNamespace("owner-a");
    await service.enqueue(
      namespace,
      "durable_preference_discovered",
      userFactPayload("detail", "memory-a"),
      "preference-a",
    );
    await service.drain();
    await service.enqueue(
      namespace,
      "user_correction",
      userFactPayload("ringkas", "memory-b"),
      "preference-b",
    );
    await service.drain();

    const snapshot = await service.snapshotPrivateOwner("owner-a");
    assert.equal(snapshot.userModel.length, 2);
    assert.equal(
      snapshot.userModel.find((fact) => fact.value === "detail")?.status,
      "superseded",
    );
    assert.equal(
      snapshot.userModel.find((fact) => fact.value === "ringkas")?.status,
      "active",
    );
    const current = await service.searchUserModel(namespace, "cara menjawab", 4);
    assert.deepEqual(current.map((item) => item.text), ["Jawab ringkas."]);
    service.close();
  });

  it("generation fence mencegah extractor terlambat menghidupkan data setelah delete", async () => {
    const directory = await temporaryDirectory();
    const repository = new SqliteLongTermMemoryRepository(
      join(directory, "long-term.sqlite"),
    );
    let release: ((payload: LearningEventPayload) => void) | undefined;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const service = new LongTermMemoryService(
      repository,
      tickingClock(),
      undefined,
      undefined,
      async () => {
        startedResolve?.();
        return new Promise<LearningEventPayload>((resolve) => {
          release = resolve;
        });
      },
    );
    const namespace = privateMemoryNamespace("owner-a");
    const payload = userFactPayload("detail", "memory-a");
    await service.enqueue(namespace, "durable_preference_discovered", payload, "race");
    await started;

    await service.forgetAll(namespace);
    release?.(payload);
    await service.drain();
    service.allow(namespace);
    const snapshot = await service.snapshotPrivateOwner("owner-a");
    assert.deepEqual(snapshot.userModel, []);
    assert.deepEqual(snapshot.candidates, []);
    assert.deepEqual(snapshot.learningEvents, []);
    service.close();
  });

  it("forget source menghapus procedure, candidate, dan event yang hanya ditopang source itu", async () => {
    const directory = await temporaryDirectory();
    const repository = new SqliteLongTermMemoryRepository(
      join(directory, "long-term.sqlite"),
    );
    const service = new LongTermMemoryService(repository, tickingClock());
    const namespace = privateMemoryNamespace("owner-a");
    await service.enqueue(namespace, "procedure_success", {
      procedure: deployProcedure(),
      sourceMemoryIds: ["memory-a"],
      outcome: successfulOutcome(),
      evidence: [{ ...evidence("memory:memory-a"), sourceId: "memory:memory-a" }],
    }, "memory-backed-procedure");
    await service.drain();
    assert.equal((await service.snapshotPrivateOwner("owner-a")).procedures.length, 1);

    await service.forgetSource({
      id: "memory-a",
      ownerId: "owner-a",
      kind: "context",
      content: "deploy workflow",
      createdAt: "2026-08-21T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    });
    const snapshot = await service.snapshotPrivateOwner("owner-a");
    assert.deepEqual(snapshot.procedures, []);
    assert.deepEqual(snapshot.candidates, []);
    assert.deepEqual(snapshot.learningEvents, []);
    service.close();
  });

  it("memulihkan event processing setelah crash tanpa duplicate promotion", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "long-term.sqlite");
    const namespace = privateMemoryNamespace("owner-a");
    let repository = new SqliteLongTermMemoryRepository(file);
    const generation = await repository.currentGeneration(namespace);
    const now = "2026-08-21T00:00:00.000Z";
    const payload = userFactPayload("detail", "memory-a");
    await repository.enqueue({
      eventId: "event-crash",
      idempotencyKey: "event-crash",
      namespace,
      generation: generation.generation,
      kind: "durable_preference_discovered",
      occurredAt: now,
      createdAt: now,
      status: "pending",
      attempts: 0,
      payload,
    });
    assert.equal((await repository.claimNext())?.status, "processing");
    repository.close();

    repository = new SqliteLongTermMemoryRepository(file);
    const service = new LongTermMemoryService(repository, tickingClock());
    await service.recover();
    const snapshot = await service.snapshotPrivateOwner("owner-a");
    assert.equal(snapshot.userModel.length, 1);
    assert.equal(snapshot.learningEvents[0]?.attempts, 2);
    service.close();
  });

  it("mempertahankan consent suspension lintas restart dan memagari event lama", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "long-term.sqlite");
    const namespace = privateMemoryNamespace("consent-owner");
    const firstRepository = new SqliteLongTermMemoryRepository(file);
    const first = new LongTermMemoryService(
      firstRepository,
      () => new Date("2026-08-21T00:00:00.000Z"),
    );
    await first.archive(namespace, archiveEpisode("consent-episode", "consent data"));
    first.suspend(namespace);
    first.close();

    const reopenedRepository = new SqliteLongTermMemoryRepository(file);
    const reopened = new LongTermMemoryService(
      reopenedRepository,
      () => new Date("2026-08-21T00:00:00.000Z"),
    );
    assert.deepEqual(await reopened.search(namespace, "consent data"), []);
    assert.equal(
      (await reopenedRepository.currentGeneration(namespace)).blocked,
      true,
    );
    reopened.allow(namespace);
    assert.equal((await reopened.search(namespace, "consent data")).length, 1);
    reopened.close();
  });
});

function episodeDraft(turns: StoredConversationTurn[]): EpisodeSummaryDraft {
  return {
    topics: [],
    facts: [{
      text: `Episode ${turns[0]!.text}`,
      sourceSequences: [turns[0]!.sequence],
    }],
    goals: [],
    decisions: [],
    corrections: [],
    commitments: [],
    unresolved: [],
    temporalAnchors: [],
    uncertainties: [],
  };
}

function archiveEpisode(episodeId: string, text: string): ConversationEpisode {
  return {
    schemaVersion: 2,
    episodeId,
    source: {
      kind: "turn-range",
      fromSequence: 1,
      throughSequence: 1,
      turnCount: 1,
      sourceHash: "b".repeat(64),
    },
    summarizerVersion: "test",
    createdAt: "2026-08-21T00:00:00.000Z",
    topics: [],
    facts: [{ text, sourceSequences: [1] }],
    goals: [],
    decisions: [],
    corrections: [],
    commitments: [],
    unresolved: [],
    temporalAnchors: [],
    uncertainties: [],
  };
}

function deployProcedure(): ProcedureDraft {
  return {
    logicalKey: "deploy-harvy-production",
    name: "Deploy Harvy production",
    description: "Deploy Harvy ke production secara terverifikasi.",
    triggerSignatures: ["deploy harvy", "production deployment"],
    preconditions: ["Branch release tersedia."],
    toolRequirements: ["git.push", "deployment.run"],
    environmentConstraints: ["linux"],
    steps: [
      { order: 1, action: "Push branch release.", tool: "git.push", expectedOutcome: "remote ref ada" },
      { order: 2, action: "Jalankan deployment.", tool: "deployment.run", expectedOutcome: "healthy" },
    ],
    pitfalls: ["Branch lokal belum ada di remote."],
    recoveryStrategies: ["Push lalu verifikasi remote ref."],
    verification: ["Periksa health endpoint dan smoke test."],
  };
}

function successfulOutcome() {
  return {
    technical: "success" as const,
    task: "success" as const,
    user: "accepted" as const,
    verified: true,
  };
}

function evidence(sourceId: string) {
  return {
    kind: "validator_result" as const,
    sourceId,
    contentHash: "a".repeat(64),
    occurredAt: "2026-08-21T00:00:00.000Z",
    sourceEpisodeId: null,
    sourceSequences: [],
    locator: null,
  };
}

function userFactPayload(value: string, sourceMemoryId: string): LearningEventPayload {
  return {
    userFact: {
      category: "communication_preference",
      subject: "user",
      predicate: "response_style",
      value,
      displayText: value === "detail" ? "Jawab detail." : "Jawab ringkas.",
      provenance: "asserted",
      confidence: 1,
      stability: "evolving",
      lastConfirmedAt: "2026-08-21T00:00:00.000Z",
      validFrom: "2026-08-21T00:00:00.000Z",
      validUntil: null,
      evidence: [evidence(sourceMemoryId)],
      sourceMemoryIds: [sourceMemoryId],
    },
    sourceMemoryIds: [sourceMemoryId],
    evidence: [evidence(sourceMemoryId)],
  };
}

function tickingClock(): () => Date {
  let at = Date.parse("2026-08-21T00:00:00.000Z");
  return () => new Date(at++);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harvy-long-term-"));
  temporaryDirectories.push(directory);
  return directory;
}
