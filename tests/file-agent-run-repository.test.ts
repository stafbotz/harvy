import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentRunService } from "../src/core/agent-run-service.js";
import type {
  AgentRunRepository,
  DurableAgentRun,
  NewDurableAgentRun,
} from "../src/domain/agent-run.js";
import type { AgentRunCheckpoint } from "../src/harness/agent-harness.js";
import { AgentHarness } from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { privateAgentScope, scopeKey } from "../src/harness/scope.js";
import { FileAgentRunRepository } from "../src/storage/file-agent-run-repository.js";

describe("file agent run repository", () => {
  it("memulihkan checkpoint lintas instance dan menegakkan CAS per scope", async () => {
    const file = await temporaryFile();
    const first = new FileAgentRunRepository(file);
    const second = new FileAgentRunRepository(file);
    const initial = draft("alice", "run-a");

    const saved = await first.save(initial, null);
    assert.equal(saved.status, "saved");
    if (saved.status !== "saved") return;
    assert.equal(saved.run.revision, 1);
    assert.equal((await second.load(initial.scopeKey))?.runId, "run-a");

    const updated: NewDurableAgentRun = {
      ...initial,
      updatedAt: "2026-08-04T05:01:00.000Z",
    };
    const next = await second.save(updated, 1);
    assert.equal(next.status, "saved");
    assert.deepEqual(
      await first.save({ ...updated, updatedAt: "2026-08-04T05:02:00.000Z" }, 1),
      { status: "conflict" },
    );
    assert.equal((await first.load(initial.scopeKey))?.revision, 2);

    const other = draft("bob", "run-b");
    assert.equal((await first.save(other, null)).status, "saved");
    assert.equal((await first.load(other.scopeKey))?.ownerId, "bob");
    assert.equal(await first.remove(initial.scopeKey, "run-lama"), "conflict");
    assert.equal(await first.remove(initial.scopeKey, "run-a", 1), "conflict");
    assert.equal((await first.load(initial.scopeKey))?.runId, "run-a");
  });

  it("hanya memberi satu claim resume untuk revision yang sama", async () => {
    const file = await temporaryFile();
    const instant = () => new Date("2026-08-04T05:00:30.000Z");
    const first = new AgentRunService(new FileAgentRunRepository(file), instant);
    const second = new AgentRunService(new FileAgentRunRepository(file), instant);
    const checkpoint = makeCheckpoint("alice", "run-claim");
    const stored = await first.saveWaitingInput({
      channel: "telegram",
      ownerId: "alice",
      request: checkpoint.request,
      mode: "tools",
      intent: "question",
      acceptAnswersAfterUpdateId: 10,
      checkpoint,
      expectedRevision: null,
    });

    const claims = await Promise.allSettled([
      first.claimWaitingInput("telegram", "alice", stored.runId, 1),
      second.claimWaitingInput("telegram", "alice", stored.runId, 1),
    ]);
    assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
    assert.equal(claims.filter((claim) => claim.status === "rejected").length, 1);
    assert.equal(
      (await first.loadWaitingInput("telegram", "alice"))?.revision,
      2,
    );
  });

  it("tidak mengembalikan authority lama setelah forget mulai", async () => {
    const stale = { ...draft("alice", "run-blocked-load"), revision: 1 };
    const loadStarted = deferred<void>();
    const releaseLoad = deferred<void>();
    const repository = repositoryStub({
      load: async () => {
        loadStarted.resolve();
        await releaseLoad.promise;
        return structuredClone(stale);
      },
    });
    const service = new AgentRunService(
      repository,
      () => new Date("2026-08-04T05:00:30.000Z"),
    );

    const loading = service.loadWaitingInput("telegram", "alice");
    await loadStarted.promise;
    const forgetting = service.forget("telegram", "alice");
    releaseLoad.resolve();

    assert.equal(await loading, null);
    await forgetting;
  });

  it("save dan claim gagal tertutup bila forget dimulai saat I/O berjalan", async () => {
    const checkpoint = makeCheckpoint("alice", "run-blocked-save");
    const saveStarted = deferred<void>();
    const releaseSave = deferred<void>();
    const repository = repositoryStub({
      save: async (run, expectedRevision) => {
        saveStarted.resolve();
        await releaseSave.promise;
        return {
          status: "saved",
          run: {
            ...structuredClone(run),
            revision: expectedRevision === null ? 1 : expectedRevision + 1,
          },
        };
      },
    });
    const service = new AgentRunService(
      repository,
      () => new Date("2026-08-04T05:00:30.000Z"),
    );
    const saving = service.saveWaitingInput({
      channel: "telegram",
      ownerId: "alice",
      request: checkpoint.request,
      mode: "tools",
      intent: "question",
      acceptAnswersAfterUpdateId: 10,
      checkpoint,
      expectedRevision: null,
    });
    await saveStarted.promise;
    const savingRejected = assert.rejects(
      saving,
      /diblokir selama penghapusan data/iu,
    );
    const forgetting = service.forget("telegram", "alice");
    releaseSave.resolve();
    await savingRejected;
    await forgetting;

    const claimedRun = {
      ...draft("bob", "run-blocked-claim"),
      revision: 1,
    };
    const claimSaveStarted = deferred<void>();
    const releaseClaimSave = deferred<void>();
    const claimRepository = repositoryStub({
      load: async () => structuredClone(claimedRun),
      save: async (run, expectedRevision) => {
        claimSaveStarted.resolve();
        await releaseClaimSave.promise;
        return {
          status: "saved",
          run: { ...structuredClone(run), revision: (expectedRevision ?? 0) + 1 },
        };
      },
    });
    const claimService = new AgentRunService(
      claimRepository,
      () => new Date("2026-08-04T05:00:30.000Z"),
    );
    const claiming = claimService.claimWaitingInput(
      "telegram",
      "bob",
      claimedRun.runId,
      1,
    );
    await claimSaveStarted.promise;
    const claimingRejected = assert.rejects(
      claiming,
      /diblokir selama penghapusan data/iu,
    );
    const forgettingClaim = claimService.forget("telegram", "bob");
    releaseClaimSave.resolve();
    await claimingRejected;
    await forgettingClaim;
  });

  it("service mempertahankan horizon absolut dan membersihkan expiry", async () => {
    const file = await temporaryFile();
    let now = new Date("2026-08-04T05:00:00.000Z");
    const service = new AgentRunService(
      new FileAgentRunRepository(file),
      () => now,
    );
    const checkpoint = makeCheckpoint("alice", "run-expiry");
    const saved = await service.saveWaitingInput({
      channel: "telegram",
      ownerId: "alice",
      request: checkpoint.request,
      mode: "orchestrate",
      intent: "request",
      acceptAnswersAfterUpdateId: 10,
      checkpoint,
      expectedRevision: null,
    });
    assert.equal(saved.expiresAt, "2026-08-04T05:10:00.000Z");

    now = new Date("2026-08-04T05:09:59.999Z");
    assert.equal(
      (await new AgentRunService(
        new FileAgentRunRepository(file),
        () => now,
      ).loadWaitingInput("telegram", "alice"))?.revision,
      1,
    );
    now = new Date("2026-08-04T05:10:00.000Z");
    assert.equal(await service.loadWaitingInput("telegram", "alice"), null);
    assert.equal(
      await new FileAgentRunRepository(file).load(checkpoint.scopeKey),
      null,
    );
  });

  it("menolak record file yang scope atau checkpoint-nya dirusak", async () => {
    const file = await temporaryFile();
    const repository = new FileAgentRunRepository(file);
    const run = draft("alice", "run-tampered");
    await repository.save(run, null);
    const database = JSON.parse(await readFile(file, "utf8")) as {
      version: 1;
      runs: DurableAgentRun[];
    };
    database.runs[0]!.checkpoint.scopeKey = scopeKey(
      privateAgentScope("telegram", "mallory"),
    );
    await writeFile(file, `${JSON.stringify(database, null, 2)}\n`, "utf8");

    await assert.rejects(
      repository.load(run.scopeKey),
      /record run agent tidak sah/iu,
    );
  });

  it("menolak horizon di atas sepuluh menit dan elemen checkpoint rusak", async () => {
    const file = await temporaryFile();
    const repository = new FileAgentRunRepository(file);
    const tooLong = draft("alice", "run-too-long");
    tooLong.checkpoint.deadlineAt = "2026-08-04T05:10:00.001Z";
    tooLong.expiresAt = tooLong.checkpoint.deadlineAt;
    await assert.rejects(
      repository.save(tooLong, null),
      /record run agent tidak sah/iu,
    );

    const nested = draft("alice", "run-nested");
    nested.checkpoint.observations = [{
      step: 0,
      capabilityId: "task.get",
      status: "forged",
      summary: "x",
    } as never];
    await assert.rejects(
      repository.save(nested, null),
      /record run agent tidak sah/iu,
    );
  });

  it("menolak checkpoint masa depan dan urutan waktu file yang dirusak", async () => {
    const file = await temporaryFile();
    const repository = new FileAgentRunRepository(file);
    const future = makeCheckpoint("alice", "run-future");
    future.startedAt = "2026-08-04T06:00:00.000Z";
    future.deadlineAt = "2026-08-04T06:10:00.000Z";
    const service = new AgentRunService(
      repository,
      () => new Date("2026-08-04T05:00:00.000Z"),
    );
    await assert.rejects(
      service.saveWaitingInput({
        channel: "telegram",
        ownerId: "alice",
        request: future.request,
        mode: "tools",
        intent: "question",
        acceptAnswersAfterUpdateId: 10,
        checkpoint: future,
        expectedRevision: null,
      }),
      /checkpoint agent tidak sah/iu,
    );

    const valid = draft("alice", "run-time-order");
    await repository.save(valid, null);
    const database = JSON.parse(await readFile(file, "utf8")) as {
      version: 1;
      runs: DurableAgentRun[];
    };
    database.runs[0]!.updatedAt = "2026-08-04T04:59:59.999Z";
    await writeFile(file, `${JSON.stringify(database, null, 2)}\n`, "utf8");
    await assert.rejects(
      repository.load(valid.scopeKey),
      /record run agent tidak sah/iu,
    );
  });

  it("menolak owner ID nonkanonis agar penghapusan tidak meninggalkan data", async () => {
    const file = await temporaryFile();
    const service = new AgentRunService(
      new FileAgentRunRepository(file),
      () => new Date("2026-08-04T05:00:00.000Z"),
    );
    const checkpoint = makeCheckpoint("alice", "run-owner");
    await assert.rejects(
      service.saveWaitingInput({
        channel: "telegram",
        ownerId: " alice ",
        request: checkpoint.request,
        mode: "tools",
        intent: "question",
        acceptAnswersAfterUpdateId: 10,
        checkpoint,
        expectedRevision: null,
      }),
      /bentuk kanonis/iu,
    );
  });

  it("checkpoint ikut ekspor dan penghapusan owner", async () => {
    const file = await temporaryFile();
    const now = () => new Date("2026-08-04T05:00:00.000Z");
    const service = new AgentRunService(new FileAgentRunRepository(file), now);
    const checkpoint = makeCheckpoint("alice", "run-export");
    await service.saveWaitingInput({
      channel: "telegram",
      ownerId: "alice",
      request: checkpoint.request,
      mode: "tools",
      intent: "question",
      acceptAnswersAfterUpdateId: 10,
      checkpoint,
      expectedRevision: null,
    });

    const exported = await service.export("telegram", "alice");
    assert.equal(exported?.progress.pendingInput?.prompt, "Rentang mana?");
    assert.equal("checkpoint" in (exported ?? {}), false);
    assert.equal(await service.forget("telegram", "alice"), 1);
    assert.equal(await service.export("telegram", "alice"), null);
    await assert.rejects(
      service.saveWaitingInput({
        channel: "telegram",
        ownerId: "alice",
        request: checkpoint.request,
        mode: "tools",
        intent: "question",
        acceptAnswersAfterUpdateId: 10,
        checkpoint,
        expectedRevision: null,
      }),
      /diblokir selama penghapusan data/iu,
    );
    service.allow("telegram", "alice");
    assert.equal((await service.saveWaitingInput({
      channel: "telegram",
      ownerId: "alice",
      request: checkpoint.request,
      mode: "tools",
      intent: "question",
      acceptAnswersAfterUpdateId: 10,
      checkpoint,
      expectedRevision: null,
    })).revision, 1);
  });

  it("startup purge dan forget membuang file temporary yatim", async () => {
    for (const operation of ["purge", "forget"] as const) {
      const file = await temporaryFile();
      const run = { ...draft("alice", `run-tmp-${operation}`), revision: 1 };
      await writeFile(
        `${file}.tmp`,
        `${JSON.stringify({ version: 1, runs: [run] }, null, 2)}\n`,
        "utf8",
      );
      const service = new AgentRunService(
        new FileAgentRunRepository(file),
        () => new Date("2026-08-04T05:00:00.000Z"),
      );

      if (operation === "purge") await service.purgeExpired();
      else await service.forget("telegram", "alice");

      await assert.rejects(
        readFile(`${file}.tmp`, "utf8"),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "ENOENT",
      );
    }
  });

  it("menerima checkpoint yang benar-benar dihasilkan AgentHarness", async () => {
    const file = await temporaryFile();
    const instant = new Date("2026-08-04T05:00:00.000Z");
    const harness = new AgentHarness(createHarvyCapabilityCatalog());
    const result = await harness.run({
      scope: privateAgentScope("telegram", "alice"),
      request: "buat analisis",
      planner: async () => ({ kind: "need_input", prompt: "Rentang mana?" }),
      limits: { resumeWindowMs: 10 * 60 * 1_000 },
      now: () => instant,
      makeRunId: () => "run-real-harness",
    });
    assert.equal(result.status, "needs_input");
    if (result.status !== "needs_input") return;

    const service = new AgentRunService(
      new FileAgentRunRepository(file),
      () => instant,
    );
    const saved = await service.saveWaitingInput({
      channel: "telegram",
      ownerId: "alice",
      request: "buat analisis",
      mode: "tools",
      intent: "question",
      acceptAnswersAfterUpdateId: 10,
      checkpoint: result.checkpoint,
      expectedRevision: null,
    });
    assert.equal(saved.checkpoint.capabilityHash.length, 16);
    assert.equal(saved.checkpoint.callableHash.length, 64);
    const userExport = await service.export("telegram", "alice");
    assert.ok(userExport?.budget);
    assert.doesNotMatch(
      JSON.stringify(userExport),
      /capabilityHash|callableHash|"prices"|"limits"/u,
    );

    const restarted = new AgentRunService(
      new FileAgentRunRepository(file),
      () => new Date("2026-08-04T05:01:00.000Z"),
    );
    const recovered = await restarted.loadWaitingInput("telegram", "alice");
    assert.ok(recovered);
    if (!recovered) return;
    const resumed = await new AgentHarness(createHarvyCapabilityCatalog()).run({
      scope: privateAgentScope("telegram", "alice"),
      request: "buat analisis",
      planner: async (input) => {
        assert.equal(input.userInputs[0]?.prompt, "Rentang mana?");
        assert.equal(input.userInputs[0]?.text, "30 hari");
        return { kind: "final", reply: "Siap." };
      },
      checkpoint: recovered.checkpoint,
      answer: "30 hari",
      limits: { resumeWindowMs: 10 * 60 * 1_000 },
      now: () => new Date("2026-08-04T05:01:00.000Z"),
    });
    assert.equal(resumed.status, "completed");
  });
});

async function temporaryFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harvy-agent-run-"));
  return join(root, "agent-runs.json");
}

function repositoryStub(
  overrides: Partial<AgentRunRepository>,
): AgentRunRepository {
  return {
    load: async () => null,
    save: async () => ({ status: "conflict" }),
    remove: async () => "missing",
    removeOwner: async () => 0,
    removeExpired: async () => 0,
    ...overrides,
  };
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

function draft(ownerId: string, runId: string): NewDurableAgentRun {
  const checkpoint = makeCheckpoint(ownerId, runId);
  return {
    version: 1,
    scopeKey: checkpoint.scopeKey,
    channel: "telegram",
    ownerId,
    runId,
    request: checkpoint.request,
    mode: "orchestrate",
    intent: "request",
    acceptAnswersAfterUpdateId: 10,
    status: "waiting_input",
    checkpoint,
    createdAt: checkpoint.startedAt,
    updatedAt: checkpoint.startedAt,
    expiresAt: checkpoint.deadlineAt,
  };
}

function makeCheckpoint(ownerId: string, runId: string): AgentRunCheckpoint {
  return {
    version: 1,
    runId,
    scopeKey: scopeKey(privateAgentScope("telegram", ownerId)),
    capabilityHash: "a".repeat(16),
    callableHash: "b".repeat(64),
    request: "buat analisis",
    startedAt: "2026-08-04T05:00:00.000Z",
    deadlineAt: "2026-08-04T05:10:00.000Z",
    maxSteps: 6,
    step: 0,
    observations: [],
    userInputs: [],
    seenActionDigests: [],
    pending: null,
    pendingInput: { step: 0, prompt: "Rentang mana?" },
  };
}
