import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_SANDBOX_LIMITS,
  SandboxRunnerService as BaseSandboxRunnerService,
} from "../src/core/sandbox-runner-service.js";
import type {
  SandboxArtifactReference,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxHealth,
  SandboxBinding,
  SandboxInputSnapshotSource,
  SandboxLease,
  SandboxLeaseJournalRecord,
  SandboxResourceLimits,
  SandboxSnapshotResult,
} from "../src/domain/sandbox.js";
import {
  UnavailableSandboxTransport,
  type SandboxAllocationRequest,
  type SandboxTransport,
  type SandboxTransportExecutionRequest,
} from "../src/sandbox/sandbox-transport.js";
import { MemorySandboxLeaseJournal } from "../src/sandbox/sandbox-lease-journal.js";
import { FileSandboxLeaseJournal } from "../src/storage/file-sandbox-lease-journal.js";
import { SqliteSandboxLeaseJournal } from "../src/storage/sqlite-sandbox-lease-journal.js";

const NOW = new Date("2026-08-10T04:00:00.000Z");
const SNAPSHOT = "a".repeat(64);

class SandboxRunnerService extends BaseSandboxRunnerService {
  override allocate(
    binding: SandboxBinding,
    snapshot: SandboxInputSnapshotSource = snapshotSource(binding.snapshotId),
  ): Promise<SandboxLease> {
    return super.allocate(binding, snapshot);
  }
}

describe("SandboxRunner Phase H policy boundary", () => {
  it("gagal tertutup ketika backend isolasi tidak tersedia", async () => {
    const runner = new SandboxRunnerService(
      new UnavailableSandboxTransport("runner offline", () => NOW),
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    assert.deepEqual(await runner.health(), {
      available: false,
      runtime: null,
      checkedAt: NOW.toISOString(),
      reason: "runner offline",
    });
    await assert.rejects(runner.allocate(binding()), /runner offline/iu);
  });

  it("mengirim bundle content-addressed tanpa host path dan memvalidasi attestation lengkap", async () => {
    const transport = new FakeSandboxTransport();
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    const lease = await runner.allocate(binding());

    assert.equal(transport.allocations.length, 1);
    const envelope = transport.allocations[0]!;
    assert.deepEqual(
      Object.keys(envelope).sort(),
      ["binding", "leaseId", "limits", "network", "snapshot"],
    );
    assert.equal(envelope.network, "off");
    assert.equal(envelope.snapshot.snapshotId, SNAPSHOT);
    assert.equal(transport.snapshotBytes, envelope.snapshot.size);
    assert.equal(JSON.stringify(envelope).includes("internalPath"), false);
    assert.equal(JSON.stringify(envelope).includes("TOKEN_SENTINEL"), false);
    assert.equal(lease.attestation.noHarvySecrets, true);
    assert.equal(lease.attestation.noDockerSocket, true);
    assert.equal(lease.attestation.noHostRootMount, true);
    assert.equal(lease.attestation.syscallFilter, true);

    const result = await runner.execute(lease, command());
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(transport.commands[0], command());
    await runner.dispose(lease);
    assert.deepEqual(transport.disposed, [lease.leaseId]);
  });

  it("menolak transport yang tidak mengonsumsi atau mengubah byte bundle snapshot", async () => {
    const skippedTransport = new FakeSandboxTransport();
    skippedTransport.skipSnapshotContent = true;
    const skipped = new SandboxRunnerService(
      skippedTransport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    await assert.rejects(
      skipped.allocate(binding()),
      /tidak mengonsumsi seluruh bundle/iu,
    );
    assert.equal(skippedTransport.active.size, 0);

    const mismatchedTransport = new FakeSandboxTransport();
    const mismatched = new SandboxRunnerService(
      mismatchedTransport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    const source = snapshotSource();
    source.descriptor = {
      ...source.descriptor,
      bundleSha256: "f".repeat(64),
    };
    await assert.rejects(
      mismatched.allocate(binding(), source),
      /byte bundle snapshot.*tidak cocok/iu,
    );
    assert.equal(mismatchedTransport.active.size, 0);
  });

  it("menolak attestation longgar, forged lease, shell newline, dan timeout di luar quota", async () => {
    const transport = new FakeSandboxTransport();
    transport.weakenAttestation = true;
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    await assert.rejects(runner.allocate(binding()), /Attestation/iu);

    transport.weakenAttestation = false;
    const lease = await runner.allocate(binding());
    await assert.rejects(
      runner.execute({ ...lease, binding: { ...lease.binding, projectId: "other" } }, command()),
      /handle|binding|dikenal/iu,
    );
    await assert.rejects(
      runner.execute(lease, { ...command(), argv: ["npm", "test\nwhoami"] }),
      /Argumen sandbox/iu,
    );
    await assert.rejects(
      runner.execute(lease, {
        ...command(),
        timeoutMs: DEFAULT_SANDBOX_LIMITS.wallClockMs + 1,
      }),
      /Timeout/iu,
    );
  });

  it("menolak output tanpa batas dan snapshot yang tidak terikat revision", async () => {
    const transport = new FakeSandboxTransport();
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      { maxOutputBytes: 32 },
      () => NOW,
    );
    let lease = await runner.allocate(binding());
    transport.stdout = "x".repeat(33);
    await assert.rejects(runner.execute(lease, command()), /Output sandbox/iu);

    transport.stdout = "ok";
    lease = await runner.allocate(binding());
    transport.snapshotRevision = 999;
    await assert.rejects(
      runner.captureSnapshot(lease),
      /tidak cocok dengan binding/iu,
    );
    assert.equal(transport.disposed.includes(lease.leaseId), true);
    await assert.rejects(runner.execute(lease, command()), /tidak dikenal|dibuang/iu);
  });

  it("menerapkan admission per owner, horizon lease, dan mempertahankan lease bila dispose gagal", async () => {
    const transport = new FakeSandboxTransport();
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
      { maxConcurrentLeases: 2, maxConcurrentLeasesPerOwner: 1 },
    );
    const first = await runner.allocate(binding());
    await assert.rejects(runner.allocate(binding()), /admission.*owner/iu);
    const second = await runner.allocate({
      ...binding(),
      ownerWorkspaceKey: "workspace-owner-2",
      runId: "run-2",
    });
    transport.failDispose = true;
    await assert.rejects(runner.dispose(first), /dispose failed/iu);
    await assert.rejects(
      runner.allocate({ ...binding(), ownerWorkspaceKey: "workspace-owner-3" }),
      /admission.*penuh/iu,
    );
    transport.failDispose = false;
    await runner.dispose(first);
    await runner.dispose(second);

    transport.leaseDurationMs = 31 * 60 * 1000;
    await assert.rejects(runner.allocate(binding()), /horizon/iu);
    assert.equal(
      transport.disposed.includes(transport.allocations.at(-1)!.leaseId),
      true,
    );
  });

  it("menolak artifact agregat/snapshot palsu dan memutus transport yang melewati watchdog", async () => {
    const transport = new FakeSandboxTransport();
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      { maxArtifactBytes: 10, maxArtifacts: 2 },
      () => NOW,
    );
    let lease = await runner.allocate(binding());
    transport.artifacts = [artifact("stdout", 6, "c"), artifact("stderr", 6, "d")];
    await assert.rejects(runner.execute(lease, command()), /total artifact/iu);
    lease = await runner.allocate(binding());
    transport.artifacts = [artifact("workspace-snapshot", 1, "e")];
    await assert.rejects(runner.execute(lease, command()), /tidak boleh/iu);
    lease = await runner.allocate(binding());
    transport.artifacts = [];
    transport.hang = true;
    await assert.rejects(
      runner.execute(lease, { ...command(), timeoutMs: 1 }),
      /watchdog/iu,
    );
    assert.equal(transport.abortObserved, true);
    assert.equal(transport.disposed.includes(lease.leaseId), true);
  });

  it("mengambil byte artifact hanya dari descriptor exact yang diterbitkan lease", async () => {
    const transport = new FakeSandboxTransport();
    const bytes = Buffer.from("bounded artifact evidence", "utf8");
    const reference: SandboxArtifactReference = {
      artifactId: "artifact-evidence-1",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      mediaType: "text/plain",
      purpose: "stdout",
    };
    transport.artifacts = [reference];
    transport.artifactContents.set(reference.artifactId, bytes);
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    const lease = await runner.allocate(binding());
    await runner.execute(lease, command());
    assert.deepEqual(
      Buffer.from(await runner.readArtifact(lease, reference)),
      bytes,
    );
    await assert.rejects(
      runner.readArtifact(lease, { ...reference, artifactId: "artifact-forged" }),
      /tidak pernah diterbitkan/iu,
    );

    transport.artifactContents.set(reference.artifactId, Buffer.from("tampered", "utf8"));
    await assert.rejects(
      runner.readArtifact(lease, reference),
      /artifact sandbox.*descriptor/iu,
    );
    assert.equal(transport.disposed.includes(lease.leaseId), true);
  });

  it("menolak field tak dikenal pada request dan respons trust-domain", async () => {
    const transport = new FakeSandboxTransport();
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    const lease = await runner.allocate(binding());

    await assert.rejects(
      runner.execute(lease, {
        ...command(),
        environment: { SECRET: "TOKEN_SENTINEL" },
      } as SandboxExecRequest),
      /field yang tidak dikenal/iu,
    );
    assert.equal(transport.commands.length, 0);

    transport.extraResultField = true;
    await assert.rejects(runner.execute(lease, command()), /field yang tidak dikenal/iu);

    const wrongOperationTransport = new FakeSandboxTransport();
    wrongOperationTransport.resultOperationIdOverride = "sandbox-exec:wrong";
    const wrongOperationRunner = new SandboxRunnerService(
      wrongOperationTransport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    await assert.rejects(
      wrongOperationRunner.execute(
        await wrongOperationRunner.allocate(binding()),
        command(),
      ),
      /exact operation.*digest/iu,
    );

    const wrongDigestTransport = new FakeSandboxTransport();
    wrongDigestTransport.resultRequestDigestOverride = "e".repeat(64);
    const wrongDigestRunner = new SandboxRunnerService(
      wrongDigestTransport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    await assert.rejects(
      wrongDigestRunner.execute(
        await wrongDigestRunner.allocate(binding()),
        command(),
      ),
      /exact operation.*digest/iu,
    );

    const credentialTransport = new FakeSandboxTransport();
    credentialTransport.executionId = `xoxb-${"X".repeat(24)}`;
    const credentialRunner = new SandboxRunnerService(
      credentialTransport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    await assert.rejects(
      credentialRunner.execute(
        await credentialRunner.allocate(binding()),
        command(),
      ),
      /executionId.*opaque ID yang aman/iu,
    );

    const artifactTransport = new FakeSandboxTransport();
    artifactTransport.artifacts = [{
      ...artifact("stdout", 1, "a"),
      artifactId: `npm_${"Y".repeat(24)}`,
    }];
    const artifactRunner = new SandboxRunnerService(
      artifactTransport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    await assert.rejects(
      artifactRunner.execute(await artifactRunner.allocate(binding()), command()),
      /artifactId.*opaque ID yang aman/iu,
    );
  });

  it("menserialkan admission paralel dan memberi watchdog pada control-plane", async () => {
    const transport = new FakeSandboxTransport();
    transport.allocateDelayMs = 5;
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
      {
        maxConcurrentLeases: 1,
        maxConcurrentLeasesPerOwner: 1,
        controlPlaneTimeoutMs: 100,
      },
    );
    const outcomes = await Promise.allSettled([
      runner.allocate(binding()),
      runner.allocate({
        ...binding(),
        ownerWorkspaceKey: "workspace-owner-2",
        runId: "run-2",
      }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);

    const hanging = new FakeSandboxTransport();
    hanging.hangHealth = true;
    const watched = new SandboxRunnerService(
      hanging,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
      { controlPlaneTimeoutMs: 1 },
    );
    await assert.rejects(watched.health(), /health timeout/iu);
    assert.equal(hanging.abortObserved, true);
  });

  it("menolak hasil yang tiba setelah deadline walau timer event-loop belum sempat jalan", async () => {
    const controlTransport = new FakeSandboxTransport();
    controlTransport.blockHealthMs = 25;
    const controlRunner = new SandboxRunnerService(
      controlTransport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
      { controlPlaneTimeoutMs: 1 },
    );
    await assert.rejects(controlRunner.health(), /health timeout/iu);

    const executionTransport = new FakeSandboxTransport();
    const executionRunner = new SandboxRunnerService(
      executionTransport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    const lease = await executionRunner.allocate(binding());
    executionTransport.blockExecuteMs = 1_025;
    await assert.rejects(
      executionRunner.execute(lease, { ...command(), timeoutMs: 1 }),
      /watchdog timeout/iu,
    );
    assert.equal(executionTransport.disposed.includes(lease.leaseId), true);
  });

  it("memasang fence sebelum menerima lease pengganti saat allocate settle terlambat", async () => {
    const transport = new FakeSandboxTransport();
    let release!: () => void;
    transport.allocationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
      {
        maxConcurrentLeases: 1,
        maxConcurrentLeasesPerOwner: 1,
        // Keep the health preflight robust under a loaded CI scheduler; the
        // gated allocate call still deterministically crosses this deadline.
        controlPlaneTimeoutMs: 100,
      },
    );
    await assert.rejects(runner.allocate(binding()), /allocate timeout/iu);
    const lateAllocationId = transport.allocations[0]!.leaseId;
    assert.equal(transport.fenced.has(lateAllocationId), true);
    transport.allocationGate = null;
    const recovered = await runner.allocate({
      ...binding(),
      ownerWorkspaceKey: "workspace-owner-2",
      runId: "run-2",
    });
    release();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    assert.equal(transport.disposed.includes(lateAllocationId), true);
    assert.equal(transport.active.has(lateAllocationId), false);
    assert.equal(recovered.binding.runId, "run-2");
  });

  it("tidak mengeksekusi request yang dibatalkan ketika masih antre", async () => {
    const transport = new FakeSandboxTransport();
    let release!: () => void;
    transport.executionGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );
    const lease = await runner.allocate(binding());
    const first = runner.execute(lease, command());
    while (transport.commands.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const controller = new AbortController();
    const queued = runner.execute(lease, command(), controller.signal);
    controller.abort(new Error("cancel queued request"));
    release();

    await first;
    await assert.rejects(queued, /abort/iu);
    assert.equal(transport.commands.length, 1);
    await runner.execute(lease, command());
    assert.equal(transport.commands.length, 2);
  });

  it("mengarantina lease bila eksekusi ambigu tidak dapat dibuang", async () => {
    const transport = new FakeSandboxTransport();
    transport.hang = true;
    transport.failDispose = true;
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
      { maxConcurrentLeases: 1, maxConcurrentLeasesPerOwner: 1 },
    );
    const lease = await runner.allocate(binding());
    await assert.rejects(
      runner.execute(lease, { ...command(), timeoutMs: 1 }),
      /watchdog/iu,
    );
    await assert.rejects(
      runner.execute(lease, command()),
      /dikarantina/iu,
    );
    await assert.rejects(
      runner.allocate({
        ...binding(),
        ownerWorkspaceKey: "workspace-owner-2",
        runId: "run-2",
      }),
      /admission.*penuh/iu,
    );

    transport.failDispose = false;
    transport.hang = false;
    await runner.dispose(lease);
    const replacement = await runner.allocate({
      ...binding(),
      ownerWorkspaceKey: "workspace-owner-2",
      runId: "run-2",
    });
    assert.equal(replacement.binding.runId, "run-2");
  });

  it("mendurable-kan intent allocating sebelum menyeberangi transport", async () => {
    let persisted = false;
    class OrderingJournal extends MemorySandboxLeaseJournal {
      override async create(record: SandboxLeaseJournalRecord) {
        const result = await super.create(record);
        persisted = true;
        return result;
      }
    }
    const transport = new FakeSandboxTransport();
    transport.beforeAllocate = () => assert.equal(persisted, true);
    const runner = new SandboxRunnerService(
      transport,
      new OrderingJournal(),
      {},
      () => NOW,
    );
    await runner.allocate(binding());
    assert.equal(transport.allocations.length, 1);
  });

  it("memulihkan lease aktif dari file journal tanpa reattach setelah restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-sandbox-journal-"));
    try {
      const file = join(directory, "leases.json");
      const transport = new FakeSandboxTransport();
      const first = new SandboxRunnerService(
        transport,
        new FileSandboxLeaseJournal(file),
        {},
        () => NOW,
        { maxConcurrentLeases: 1, maxConcurrentLeasesPerOwner: 1 },
      );
      const oldLease = await first.allocate(binding());
      assert.equal(transport.active.has(oldLease.leaseId), true);
      assert.equal((await new FileSandboxLeaseJournal(file).list())[0]?.state, "active");

      const restarted = new SandboxRunnerService(
        transport,
        new FileSandboxLeaseJournal(file),
        {},
        () => NOW,
        { maxConcurrentLeases: 1, maxConcurrentLeasesPerOwner: 1 },
      );
      assert.equal((await restarted.health()).available, true);
      assert.equal(transport.fenced.has(oldLease.leaseId), true);
      assert.equal(transport.active.has(oldLease.leaseId), false);
      assert.deepEqual(await new FileSandboxLeaseJournal(file).list(), []);
      await assert.rejects(restarted.execute(oldLease, command()), /tidak dikenal/iu);
      const replacement = await restarted.allocate({ ...binding(), runId: "run-restart" });
      assert.equal(replacement.binding.runId, "run-restart");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovery membersihkan record lain walau satu fence gagal", async () => {
    const journal = new MemorySandboxLeaseJournal();
    const transport = new FakeSandboxTransport();
    const ids = ["sandbox-lease:recovery-1", "sandbox-lease:recovery-2", "sandbox-lease:recovery-3"];
    for (const [index, id] of ids.entries()) {
      const recordBinding = {
        ...binding(),
        ownerWorkspaceKey: `workspace-owner-${index + 1}`,
        runId: `run-${index + 1}`,
      };
      await journal.create(journalRecord(id, "allocating", recordBinding));
      assert.equal(
        (await journal.save(journalRecord(id, "active", recordBinding, 2), 1)).status,
        "saved",
      );
      transport.active.add(id);
    }
    transport.failDisposeIds.add(ids[0]!);
    const runner = new SandboxRunnerService(
      transport,
      journal,
      {},
      () => NOW,
      { maxConcurrentLeases: 3, maxConcurrentLeasesPerOwner: 1 },
    );
    await assert.rejects(runner.health(), /recovery.*cancellation fence/iu);
    assert.deepEqual(new Set(transport.disposed), new Set(ids.slice(1)));
    assert.deepEqual((await journal.list()).map((record) => record.leaseId), [ids[0]]);
    assert.equal((await journal.list())[0]?.state, "disposing");

    transport.failDisposeIds.clear();
    assert.equal((await runner.health()).available, true);
    assert.deepEqual(await journal.list(), []);
  });

  it("record allocating tetap durable bila backend tanpa authority fence", async () => {
    const journal = new MemorySandboxLeaseJournal();
    const record = journalRecord("sandbox-lease:unknown-backend", "allocating", binding());
    await journal.create(record);
    const runner = new SandboxRunnerService(
      new UnavailableSandboxTransport("runner offline", () => NOW),
      journal,
      {},
      () => NOW,
    );
    await assert.rejects(runner.health(), /recovery.*cancellation fence/iu);
    const remaining = await journal.list();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.state, "disposing");
  });

  it("file journal menolak CAS basi dan penghapusan record non-disposing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-sandbox-cas-"));
    try {
      const journal = new FileSandboxLeaseJournal(join(directory, "leases.json"));
      const record = journalRecord("sandbox-lease:cas", "allocating", binding());
      assert.equal((await journal.create(record)).status, "saved");
      const active = journalRecord(record.leaseId, "active", record.binding, 2);
      assert.equal((await journal.save(active, 1)).status, "saved");
      assert.equal((await journal.save({ ...active, revision: 3 }, 1)).status, "conflict");
      await assert.rejects(journal.remove(active.leaseId, 2), /hanya.*disposing/iu);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("SQLite journal memberi CAS lintas instance dan recovery restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-sandbox-sqlite-"));
    try {
      const file = join(directory, "leases.sqlite");
      const firstJournal = new SqliteSandboxLeaseJournal(file);
      const secondJournal = new SqliteSandboxLeaseJournal(file);
      const initial = journalRecord("sandbox-lease:sqlite-cas", "allocating", binding());
      assert.equal((await firstJournal.create(initial)).status, "saved");
      const active = journalRecord(initial.leaseId, "active", initial.binding, 2);
      const competing = await Promise.all([
        firstJournal.save(active, 1),
        secondJournal.save(active, 1),
      ]);
      assert.equal(competing.filter((result) => result.status === "saved").length, 1);
      assert.equal(competing.filter((result) => result.status === "conflict").length, 1);
      firstJournal.close();
      secondJournal.close();

      const transport = new FakeSandboxTransport();
      transport.active.add(active.leaseId);
      const restartedJournal = new SqliteSandboxLeaseJournal(file);
      const restarted = new SandboxRunnerService(
        transport,
        restartedJournal,
        {},
        () => NOW,
      );
      assert.equal((await restarted.health()).available, true);
      assert.equal(transport.fenced.has(active.leaseId), true);
      assert.equal(transport.active.has(active.leaseId), false);
      assert.deepEqual(await restartedJournal.list(), []);
      restartedJournal.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("tetap memasang cancellation fence bila ACK mutasi journal hilang setelah commit", async () => {
    const activationJournal = new AckLostJournal();
    activationJournal.failOnState = "active";
    const activationTransport = new FakeSandboxTransport();
    const activationRunner = new SandboxRunnerService(
      activationTransport,
      activationJournal,
      {},
      () => NOW,
    );
    await assert.rejects(activationRunner.allocate(binding()), /ack lost/iu);
    const rejectedId = activationTransport.allocations[0]!.leaseId;
    assert.equal(activationTransport.disposed.includes(rejectedId), true);
    assert.equal(activationTransport.active.has(rejectedId), false);
    assert.deepEqual(await activationJournal.list(), []);

    const quarantineJournal = new AckLostJournal();
    const quarantineTransport = new FakeSandboxTransport();
    const quarantineRunner = new SandboxRunnerService(
      quarantineTransport,
      quarantineJournal,
      { maxOutputBytes: 2 },
      () => NOW,
    );
    const lease = await quarantineRunner.allocate(binding());
    quarantineJournal.failOnState = "disposing";
    quarantineTransport.stdout = "too large";
    await assert.rejects(quarantineRunner.execute(lease, command()), /output/iu);
    assert.equal(quarantineTransport.disposed.includes(lease.leaseId), true);
    assert.equal(quarantineTransport.active.has(lease.leaseId), false);
    assert.deepEqual(await quarantineJournal.list(), []);

    const directJournal = new AckLostJournal();
    const directTransport = new FakeSandboxTransport();
    const directRunner = new SandboxRunnerService(
      directTransport,
      directJournal,
      {},
      () => NOW,
    );
    const directLease = await directRunner.allocate({ ...binding(), runId: "run-direct" });
    directJournal.failOnState = "disposing";
    await directRunner.dispose(directLease);
    assert.equal(directTransport.disposed.includes(directLease.leaseId), true);
    assert.deepEqual(await directJournal.list(), []);

    const recoveryJournal = new AckLostJournal();
    const recoveryTransport = new FakeSandboxTransport();
    const recoveryRecord = journalRecord(
      "sandbox-lease:ack-lost-recovery",
      "allocating",
      { ...binding(), runId: "run-recovery-ack" },
    );
    await recoveryJournal.create(recoveryRecord);
    assert.equal(
      (await recoveryJournal.save(
        journalRecord(
          recoveryRecord.leaseId,
          "active",
          recoveryRecord.binding,
          2,
        ),
        1,
      )).status,
      "saved",
    );
    recoveryTransport.active.add(recoveryRecord.leaseId);
    recoveryJournal.failOnState = "disposing";
    const recoveryRunner = new SandboxRunnerService(
      recoveryTransport,
      recoveryJournal,
      {},
      () => NOW,
    );
    assert.equal((await recoveryRunner.health()).available, true);
    assert.equal(recoveryTransport.disposed.includes(recoveryRecord.leaseId), true);
    assert.deepEqual(await recoveryJournal.list(), []);
  });

  it("memasang deletion fence untuk seluruh lease project termasuk run orphan", async () => {
    const transport = new FakeSandboxTransport();
    const journal = new MemorySandboxLeaseJournal();
    const runner = new SandboxRunnerService(transport, journal, {}, () => NOW);
    const first = await runner.allocate({ ...binding(), runId: "run-known" });
    const orphan = await runner.allocate({ ...binding(), runId: "run-orphan" });
    const foreign = await runner.allocate({
      ...binding(),
      ownerWorkspaceKey: "workspace-foreign",
      projectId: "project-foreign",
      runId: "run-foreign",
    });

    await runner.fenceProjectRuns({
      ownerWorkspaceKey: first.binding.ownerWorkspaceKey,
      projectId: first.binding.projectId,
    });

    assert.equal(transport.disposed.includes(first.leaseId), true);
    assert.equal(transport.disposed.includes(orphan.leaseId), true);
    assert.equal(transport.disposed.includes(foreign.leaseId), false);
    assert.deepEqual((await journal.list()).map((record) => record.leaseId), [
      foreign.leaseId,
    ]);
    await runner.dispose(foreign);
  });

  it("memulai runtime dengan recovery fence sebelum health dinyatakan siap", async () => {
    const transport = new FakeSandboxTransport();
    const journal = new MemorySandboxLeaseJournal();
    const allocating = journalRecord(
      "sandbox-lease:startup-recovery",
      "allocating",
      { ...binding(), runId: "run-startup-recovery" },
    );
    await journal.create(allocating);
    const active = journalRecord(
      allocating.leaseId,
      "active",
      allocating.binding,
      2,
    );
    await journal.save(active, 1);
    transport.active.add(active.leaseId);
    let releaseFence!: () => void;
    transport.disposeGate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });

    const runner = new SandboxRunnerService(transport, journal, {}, () => NOW);
    let started = false;
    const starting = runner.start().then((health) => {
      started = true;
      return health;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started, false);
    releaseFence();
    const health = await starting;

    assert.equal(health.available, true);
    assert.deepEqual(transport.disposed, [active.leaseId]);
    assert.deepEqual(await journal.list(), []);
  });

  it("memakai start hanya untuk coalescing dan membaca health baru pada retry", async () => {
    const transport = new FakeSandboxTransport();
    transport.healthAvailable = false;
    const runner = new SandboxRunnerService(
      transport,
      new MemorySandboxLeaseJournal(),
      {},
      () => NOW,
    );

    assert.equal((await runner.start()).available, false);
    transport.healthAvailable = true;
    assert.equal((await runner.start()).available, true);
  });

  it("menghentikan admission lalu menunggu operasi aktif sebelum drain mem-fence lease", async () => {
    const transport = new FakeSandboxTransport();
    const journal = new MemorySandboxLeaseJournal();
    const runner = new SandboxRunnerService(transport, journal, {}, () => NOW);
    const lease = await runner.allocate(binding());
    let releaseExecution!: () => void;
    transport.executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    transport.disposeWaitsForExecutionGate = true;
    const execution = runner.execute(lease, command());
    const executionRejected = assert.rejects(execution, /dibatalkan/iu);
    while (transport.commands.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    runner.stop();
    await assert.rejects(
      runner.allocate({ ...binding(), runId: "run-after-stop" }),
      /admission berhenti/iu,
    );
    await assert.rejects(
      runner.captureSnapshot(lease),
      /admission berhenti/iu,
    );

    let drained = false;
    const draining = runner.drain().then(() => {
      drained = true;
    });
    await assert.rejects(runner.dispose(lease), /drain menolak operasi dispose/iu);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    assert.equal(transport.disposed.includes(lease.leaseId), false);

    releaseExecution();
    await executionRejected;
    await draining;
    assert.equal(drained, true);
    assert.equal(transport.disposed.includes(lease.leaseId), true);
    assert.deepEqual(await journal.list(), []);
  });

  it("mempertahankan record disposing bila drain gagal dan dapat retry exact fence", async () => {
    const transport = new FakeSandboxTransport();
    const journal = new MemorySandboxLeaseJournal();
    const runner = new SandboxRunnerService(transport, journal, {}, () => NOW);
    const lease = await runner.allocate(binding());
    transport.failDisposeIds.add(lease.leaseId);

    await assert.rejects(runner.drain(), /cancellation fence/iu);
    const retained = await journal.list();
    assert.equal(retained.length, 1);
    assert.equal(retained[0]?.state, "disposing");

    transport.failDisposeIds.delete(lease.leaseId);
    await runner.drain();
    assert.deepEqual(await journal.list(), []);
    assert.equal(transport.disposed.includes(lease.leaseId), true);
  });

  it("tidak menutup journal saat fence gagal lalu menggabungkan retry close concurrent", async () => {
    const transport = new FakeSandboxTransport();
    const journal = new ClosingMemorySandboxLeaseJournal();
    const runner = new SandboxRunnerService(transport, journal, {}, () => NOW);
    const lease = await runner.allocate(binding());
    transport.failDisposeIds.add(lease.leaseId);

    await assert.rejects(runner.close(), /cancellation fence/iu);
    assert.equal(journal.closeCalls, 0);
    transport.failDisposeIds.delete(lease.leaseId);

    await Promise.all([runner.close(), runner.close()]);

    assert.equal(transport.disposed.includes(lease.leaseId), true);
    assert.equal(journal.closeCalls, 1);
    await assert.rejects(runner.health(), /sudah ditutup/iu);
  });
});

class ClosingMemorySandboxLeaseJournal extends MemorySandboxLeaseJournal {
  closeCalls = 0;

  close(): void {
    this.closeCalls += 1;
  }
}

class AckLostJournal extends MemorySandboxLeaseJournal {
  failOnState: SandboxLeaseJournalRecord["state"] | null = null;
  private failed = false;

  override async save(record: SandboxLeaseJournalRecord, expectedRevision: number) {
    const result = await super.save(record, expectedRevision);
    if (
      !this.failed &&
      result.status === "saved" &&
      record.state === this.failOnState
    ) {
      this.failed = true;
      throw new Error("journal ack lost after commit");
    }
    return result;
  }
}

class FakeSandboxTransport implements SandboxTransport {
  allocations: SandboxAllocationRequest[] = [];
  commands: SandboxExecRequest[] = [];
  disposed: string[] = [];
  active = new Set<string>();
  fenced = new Set<string>();
  failDisposeIds = new Set<string>();
  beforeAllocate: (() => void) | null = null;
  weakenAttestation = false;
  stdout = "ok";
  snapshotRevision = 1;
  leaseDurationMs = 60_000;
  failDispose = false;
  hang = false;
  abortObserved = false;
  extraResultField = false;
  executionId = "exec-1";
  resultOperationIdOverride: string | null = null;
  resultRequestDigestOverride: string | null = null;
  allocateDelayMs = 0;
  hangHealth = false;
  healthAvailable = true;
  blockHealthMs = 0;
  blockExecuteMs = 0;
  allocationGate: Promise<void> | null = null;
  executionGate: Promise<void> | null = null;
  disposeGate: Promise<void> | null = null;
  disposeWaitsForExecutionGate = false;
  artifacts: SandboxArtifactReference[] = [];
  artifactContents = new Map<string, Buffer>();
  snapshotBytes = 0;
  skipSnapshotContent = false;

  async health(signal?: AbortSignal): Promise<SandboxHealth> {
    blockEventLoop(this.blockHealthMs);
    if (this.hangHealth) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          this.abortObserved = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    }
    return {
      available: this.healthAvailable,
      runtime: this.healthAvailable ? "isolated-linux" : null,
      checkedAt: NOW.toISOString(),
      reason: this.healthAvailable ? null : "runner unavailable",
    };
  }

  async allocate(
    request: SandboxAllocationRequest,
    content: AsyncIterable<Uint8Array>,
  ): Promise<SandboxLease> {
    this.beforeAllocate?.();
    this.allocations.push(structuredClone(request));
    if (!this.skipSnapshotContent) {
      for await (const chunk of content) this.snapshotBytes += chunk.byteLength;
    }
    await this.allocationGate;
    if (this.allocateDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.allocateDelayMs));
    }
    if (this.fenced.has(request.leaseId)) {
      throw new Error("allocation cancelled by durable fence");
    }
    this.active.add(request.leaseId);
    return {
      leaseId: request.leaseId,
      binding: structuredClone(request.binding),
      attestation: {
        version: 1,
        runtime: "isolated-linux",
        unprivilegedUser: true,
        noHarvySecrets: true,
        noProviderSecrets: true,
        noGitHubSecrets: true,
        noHarvyDataMount: true,
        noHostRootMount: true,
        noDockerSocket: true,
        noPrivilegedDevices: true,
        capabilitiesDropped: true,
        syscallFilter: true,
        readOnlyRootFilesystem: true,
        disposable: this.weakenAttestation ? false as true : true,
        network: "off",
        limits: structuredClone(request.limits),
      },
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + this.leaseDurationMs).toISOString(),
    };
  }

  async execute(
    leaseId: string,
    request: SandboxTransportExecutionRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    this.commands.push(structuredClone(request.request));
    await this.executionGate;
    blockEventLoop(this.blockExecuteMs);
    if (this.hang) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          this.abortObserved = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    }
    const result: SandboxExecResult = {
      operationId: this.resultOperationIdOverride ?? request.operationId,
      requestDigest: this.resultRequestDigestOverride ?? request.requestDigest,
      executionId: this.executionId,
      leaseId,
      status: "exited",
      exitCode: 0,
      signal: null,
      stdout: this.stdout,
      stderr: "",
      truncated: false,
      artifacts: structuredClone(this.artifacts),
      usage: {
        wallClockMs: 10,
        peakMemoryBytes: 1024,
        cpuTimeMs: 5,
        outputBytes: Buffer.byteLength(this.stdout),
      },
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
    };
    return this.extraResultField
      ? Object.assign(result, { credential: "TOKEN_SENTINEL" })
      : result;
  }

  async captureSnapshot(leaseId: string): Promise<SandboxSnapshotResult> {
    return {
      leaseId,
      sourceWorkspaceRevision: this.snapshotRevision,
      snapshot: {
        artifactId: "artifact-snapshot",
        sha256: "b".repeat(64),
        size: 10,
        mediaType: "application/vnd.harvy.project-snapshot",
        purpose: "workspace-snapshot",
      },
      createdAt: NOW.toISOString(),
    };
  }

  async *downloadArtifact(
    _leaseId: string,
    artifact: SandboxArtifactReference,
  ): AsyncGenerator<Uint8Array> {
    const bytes = this.artifactContents.get(artifact.artifactId);
    if (!bytes) throw new Error("artifact missing");
    yield bytes;
  }

  async cancelAndDispose(leaseId: string) {
    await this.disposeGate;
    if (this.disposeWaitsForExecutionGate) await this.executionGate;
    if (this.failDispose || this.failDisposeIds.has(leaseId)) {
      throw new Error("dispose failed");
    }
    this.fenced.add(leaseId);
    this.active.delete(leaseId);
    if (!this.disposed.includes(leaseId)) this.disposed.push(leaseId);
    return {
      leaseId,
      fenced: true as const,
      completedAt: NOW.toISOString(),
    };
  }
}

function blockEventLoop(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    // Deliberately model a trust-domain adapter that stalls synchronously.
  }
}

function artifact(
  purpose: SandboxArtifactReference["purpose"],
  size: number,
  hash: string,
): SandboxArtifactReference {
  return {
    artifactId: `artifact-${purpose}`,
    sha256: hash.repeat(64),
    size,
    mediaType: "text/plain",
    purpose,
  };
}

function binding() {
  return {
    ownerWorkspaceKey: "workspace-owner-1",
    projectId: "project-1",
    snapshotId: SNAPSHOT,
    workspaceRevision: 1,
    runId: "run-1",
  };
}

function snapshotSource(snapshotId = SNAPSHOT): SandboxInputSnapshotSource {
  const bytes = Buffer.from("HARVY_SNAPSHOT_BUNDLE_V1\n{}\n", "utf8");
  return {
    descriptor: {
      version: 1,
      snapshotId,
      bundleSha256: createHash("sha256").update(bytes).digest("hex"),
      manifestSha256: createHash("sha256").update("{}", "utf8").digest("hex"),
      size: bytes.length,
      fileCount: 0,
      mediaType: "application/vnd.harvy.snapshot-bundle.v1",
    },
    async *open() {
      yield bytes;
    },
  };
}

function command(): SandboxExecRequest {
  return {
    argv: ["npm", "test"],
    cwd: ".",
    purpose: "test",
    timeoutMs: 30_000,
  };
}

function journalRecord(
  leaseId: string,
  state: SandboxLeaseJournalRecord["state"],
  recordBinding: ReturnType<typeof binding>,
  revision = 1,
): SandboxLeaseJournalRecord {
  const limits = structuredClone(DEFAULT_SANDBOX_LIMITS) as SandboxResourceLimits;
  const lease: SandboxLease | null = state === "allocating"
    ? null
    : {
        leaseId,
        binding: structuredClone(recordBinding),
        attestation: {
          version: 1,
          runtime: "isolated-linux",
          unprivilegedUser: true,
          noHarvySecrets: true,
          noProviderSecrets: true,
          noGitHubSecrets: true,
          noHarvyDataMount: true,
          noHostRootMount: true,
          noDockerSocket: true,
          noPrivilegedDevices: true,
          capabilitiesDropped: true,
          syscallFilter: true,
          readOnlyRootFilesystem: true,
          disposable: true,
          network: "off",
          limits: structuredClone(limits),
        },
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      };
  return {
    version: 1,
    leaseId,
    revision,
    state,
    binding: structuredClone(recordBinding),
    limits,
    lease,
    lastErrorCode: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}
