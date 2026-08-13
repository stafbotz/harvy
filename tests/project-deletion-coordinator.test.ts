import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CodingValidatorPolicy } from "../src/coding/coding-validators.js";
import { CodingRunEngine } from "../src/core/coding-run-engine.js";
import { ProjectDeletionCoordinator } from "../src/core/project-deletion-coordinator.js";
import { ProjectWorkspaceService } from "../src/core/project-workspace-service.js";
import {
  WorkspaceAuthorityService,
  workspacePrincipal,
} from "../src/core/workspace-authority-service.js";
import type {
  SandboxArtifactReference,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxHealth,
  SandboxLease,
  SandboxRunner,
  SandboxSnapshotResult,
} from "../src/domain/sandbox.js";
import { FileCodingEvidenceStore } from "../src/storage/file-coding-evidence-store.js";
import { FileCodingRunRepository } from "../src/storage/file-coding-run-repository.js";
import { FileProjectDeletionRepository } from "../src/storage/file-project-deletion-repository.js";
import { FileProjectWorkspaceRepository } from "../src/storage/file-project-workspace-repository.js";
import { FileWorkspaceRepository } from "../src/storage/file-workspace-repository.js";
import { buildZip } from "./zip-test-fixture.js";

const NOW = new Date("2026-08-13T03:00:00.000Z");
const SECRET = "project-deletion-test-secret-32-characters";

describe("Project deletion saga", () => {
  it("menyembunyikan project sebelum cleanup, menolak bypass, lalu resume idempotent", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const value = 1;\n"),
    );

    const deletion = await fixture.coordinator.request(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    assert.equal(await fixture.projects.get(fixture.ownerScope, project.id), null);
    assert.deepEqual(await fixture.projects.list(fixture.ownerScope), []);
    assert.equal(
      await fixture.projects.readManifest(fixture.ownerScope, project.id),
      null,
    );
    await assert.rejects(
      fixture.projects.removeForDeletion(
        fixture.ownerScope,
        project.id,
        project.revision,
        deletion.deletionId,
      ),
      /belum mencapai/u,
    );
    await assert.rejects(
      fixture.engine.start(fixture.ownerScope, project.id, project.revision, brief()),
      /tidak ditemukan/u,
    );
    assert.ok(await fixture.projectRepository.load(project.id));

    const completed = await fixture.coordinator.resume(
      fixture.ownerScope,
      deletion.deletionId,
    );
    assert.equal(completed.status, "completed", JSON.stringify(completed.lastError));
    assert.deepEqual(completed.completedSteps, [
      "runs_fenced",
      "evidence_removed",
      "runs_removed",
      "github_detached",
      "project_removed",
    ]);
    assert.equal(await fixture.projectRepository.load(project.id), null);
    assert.equal(
      (await fixture.coordinator.resume(fixture.ownerScope, deletion.deletionId)).revision,
      completed.revision,
    );
    assert.equal(
      await fixture.deletions.isDeletionPending(fixture.ownerScope.workspaceKey, project.id),
      true,
    );
  });

  it("mengautorisasi replay request sebelum mengungkap tombstone existing", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const value = 1;\n"),
    );
    await fixture.coordinator.request(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const viewer = workspacePrincipal(SECRET, "telegram", "viewer");
    const added = await fixture.authority.addMember(
      fixture.ownerScope,
      viewer,
      "viewer",
    );
    assert.equal(added.status, "updated");
    const viewerScope = await fixture.authority.resolveScope(
      fixture.ownerScope.workspaceKey,
      viewer,
    );
    assert.ok(viewerScope);
    await assert.rejects(
      fixture.coordinator.request(viewerScope!, project.id, project.revision),
      /workspace\.manage/u,
    );
  });

  it("melanjutkan tombstone durable setelah scope peminta menjadi basi", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const value = 1;\n"),
    );
    const deletion = await fixture.coordinator.request(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const viewer = workspacePrincipal(SECRET, "telegram", "acl-epoch-bump");
    const added = await fixture.authority.addMember(
      fixture.ownerScope,
      viewer,
      "viewer",
    );
    assert.equal(added.status, "updated");

    await assert.rejects(
      fixture.coordinator.resume(fixture.ownerScope, deletion.deletionId),
      /workspace\.manage/u,
    );
    const restartedRepository = new FileProjectDeletionRepository(
      join(fixture.root, "deletions.json"),
    );
    const restartedAuthority = new WorkspaceAuthorityService(
      new FileWorkspaceRepository(join(fixture.root, "authority.json")),
      () => NOW,
      () => "restart-id",
    );
    const restartedProjects = new ProjectWorkspaceService(
      new FileProjectWorkspaceRepository(join(fixture.root, "projects.json")),
      restartedAuthority,
      { root: join(fixture.root, "project-data") },
      { async forgetAll() {} },
      () => NOW,
      () => "restart-id",
      undefined,
      restartedRepository,
    );
    const restartedRuns = new FileCodingRunRepository(join(fixture.root, "runs.json"));
    const restartedEvidence = new FileCodingEvidenceStore(join(fixture.root, "evidence"));
    const restartedEngine = new CodingRunEngine(
      restartedRuns,
      restartedProjects,
      new DeletionSandbox(),
      VALIDATOR_POLICY,
      { evidenceStore: restartedEvidence },
      () => NOW,
      () => "restart-id",
    );
    const restartedCoordinator = new ProjectDeletionCoordinator(
      restartedRepository,
      restartedProjects,
      restartedRuns,
      restartedEngine,
      restartedEvidence,
      undefined,
      () => NOW,
      () => "restart-id",
    );
    const page = await restartedRepository.listIncomplete({ cursor: null, limit: 10 });
    assert.equal(page.references.length, 1);
    assert.equal(
      await restartedCoordinator.resumeDurable(page.references[0]!),
      "completed",
    );
    assert.equal(await fixture.projectRepository.load(project.id), null);
  });

  it("menolak locator durable forged sebelum cleanup dan mem-page metadata content-free", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const value = 1;\n"),
    );
    await fixture.coordinator.request(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const secondProject = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const second = 2;\n"),
    );
    await fixture.coordinator.request(
      fixture.ownerScope,
      secondProject.id,
      secondProject.revision,
    );
    const page = await fixture.deletions.listIncomplete({ cursor: null, limit: 1 });
    assert.ok(page.nextCursor);
    const nextPage = await fixture.deletions.listIncomplete({
      cursor: page.nextCursor,
      limit: 1,
    });
    assert.equal(nextPage.references.length, 1);
    assert.equal(nextPage.nextCursor, null);
    assert.deepEqual(
      new Set([...page.references, ...nextPage.references].map((entry) => entry.projectId)),
      new Set([project.id, secondProject.id]),
    );
    const reference = page.references[0]!;
    assert.deepEqual(Object.keys(reference).sort(), [
      "deletionId",
      "expectedProjectRevision",
      "ownerWorkspaceKey",
      "projectCreatedAt",
      "projectId",
      "projectSource",
      "version",
    ]);
    assert.equal(JSON.stringify(page).includes("runIds"), false);
    assert.equal(JSON.stringify(page).includes("lastError"), false);
    await assert.rejects(
      fixture.coordinator.resumeDurable({
        ...reference,
        projectCreatedAt: "2026-08-13T03:00:01.000Z",
      }),
      /tidak cocok/u,
    );
    assert.equal(fixture.sandbox.fenceCalls, 0);
    assert.ok(await fixture.projectRepository.load(reference.projectId));
    await assert.rejects(
      fixture.deletions.listIncomplete({ cursor: "%%%", limit: 1 }),
      /cursor/iu,
    );
    await assert.rejects(
      fixture.deletions.listIncomplete({ cursor: null, limit: 0 }),
      /limit/iu,
    );
  });

  it("mempertahankan tombstone cleanup_required sampai metadata GitHub aman dilepas", async () => {
    let blocked = true;
    const fixture = await createFixture({
      github: {
        async detachLocalProject() {
          return blocked ? "blocked_unknown" as const : "detached" as const;
        },
      },
    });
    const project = await fixture.projects.createFromGitHubArchive(
      fixture.ownerScope,
      {
        repositoryId: "repo-1",
        installationId: "installation-1",
        archive: zip("export const value = 1;\n"),
        git: {
          baseCommit: "a".repeat(40),
          branch: "main",
          headCommit: "a".repeat(40),
        },
      },
    );
    const deletion = await fixture.coordinator.request(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const reference = (await fixture.deletions.listIncomplete({
      cursor: null,
      limit: 1,
    })).references[0]!;
    assert.equal(await fixture.coordinator.resumeDurable(reference), "cleanup_required");
    const pending = await fixture.deletions.load(deletion.deletionId);
    assert.equal(pending?.status, "cleanup_required");
    assert.equal(pending?.lastError?.code, "github_effect_unknown");
    assert.ok(await fixture.projectRepository.load(project.id));
    assert.equal(await fixture.projects.get(fixture.ownerScope, project.id), null);

    blocked = false;
    assert.equal(await fixture.coordinator.resumeDurable(reference), "completed");
    assert.equal(await fixture.projectRepository.load(project.id), null);
  });

  it("menserialkan resume pengguna dan recovery durable pada deletion yang sama", async () => {
    let detachCalls = 0;
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const fixture = await createFixture({
      github: {
        async detachLocalProject() {
          detachCalls += 1;
          enteredResolve();
          await release;
          return "detached" as const;
        },
      },
    });
    const project = await fixture.projects.createFromGitHubArchive(
      fixture.ownerScope,
      {
        repositoryId: "repo-serialized",
        installationId: "installation-serialized",
        archive: zip("export const value = 1;\n"),
        git: {
          baseCommit: "b".repeat(40),
          branch: "main",
          headCommit: "b".repeat(40),
        },
      },
    );
    const deletion = await fixture.coordinator.request(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const reference = (await fixture.deletions.listIncomplete({
      cursor: null,
      limit: 1,
    })).references[0]!;

    const interactive = fixture.coordinator.resume(
      fixture.ownerScope,
      deletion.deletionId,
    );
    await entered;
    let durableSettled = false;
    const durable = fixture.coordinator.resumeDurable(reference).then((status) => {
      durableSettled = true;
      return status;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(durableSettled, false);
    assert.equal(detachCalls, 1);
    releaseResolve();

    assert.equal((await interactive).status, "completed");
    assert.equal(await durable, "completed");
    assert.equal(detachCalls, 1);
  });

  it("membatalkan run aktif, memasang sandbox fence, dan menghapus histori serta evidence", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const value = 1;\n"),
    );
    const historicalRun = await fixture.engine.start(
      fixture.ownerScope,
      project.id,
      project.revision,
      brief(),
    );
    await fixture.engine.cancel(fixture.ownerScope, historicalRun.runId);
    const activeRun = await fixture.engine.start(
      fixture.ownerScope,
      project.id,
      project.revision,
      brief(),
    );
    const source = {
      sandboxOperationId: "operation-history",
      sandboxRequestDigest: "d".repeat(64),
      sandboxExecutionId: "execution-history",
    };
    const bytes = Buffer.from("durable evidence", "utf8");
    const artifact = {
      artifactId: "artifact-history",
      sha256: (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      mediaType: "text/plain",
      purpose: "stdout" as const,
    };
    const evidenceId = await fixture.evidence.persist(
      {
        ownerWorkspaceKey: fixture.ownerScope.workspaceKey,
        projectId: project.id,
        runId: historicalRun.runId,
      },
      source,
      artifact,
      bytes,
    );
    await fixture.evidence.persist(
      {
        ownerWorkspaceKey: fixture.ownerScope.workspaceKey,
        projectId: project.id,
        runId: activeRun.runId,
      },
      {
        ...source,
        sandboxOperationId: "operation-active",
        sandboxExecutionId: "execution-active",
      },
      { ...artifact, artifactId: "artifact-active" },
      bytes,
    );
    await fixture.evidence.persist(
      {
        ownerWorkspaceKey: fixture.ownerScope.workspaceKey,
        projectId: project.id,
        runId: "orphan-run",
      },
      {
        ...source,
        sandboxOperationId: "operation-orphan",
        sandboxExecutionId: "execution-orphan",
      },
      { ...artifact, artifactId: "artifact-orphan" },
      bytes,
    );

    const deletion = await fixture.coordinator.request(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const completed = await fixture.coordinator.resume(
      fixture.ownerScope,
      deletion.deletionId,
    );
    assert.equal(completed.status, "completed");
    assert.deepEqual(
      new Set(completed.runIds),
      new Set([historicalRun.runId, activeRun.runId]),
    );
    assert.equal(completed.fencedRunCount, 2);
    assert.equal(fixture.sandbox.fenceCalls, 1);
    assert.equal(await fixture.runs.load(historicalRun.runId), null);
    assert.equal(await fixture.runs.load(activeRun.runId), null);
    await assert.rejects(
      fixture.evidence.read(
        {
          ownerWorkspaceKey: fixture.ownerScope.workspaceKey,
          projectId: project.id,
          runId: historicalRun.runId,
        },
        evidenceId,
      ),
      /ENOENT|hilang/u,
    );
  });

  it("repository menolak lompatan step yang dapat melewati cleanup", async () => {
    const fixture = await createFixture();
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const value = 1;\n"),
    );
    const deletion = await fixture.coordinator.request(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const { revision, ...record } = deletion;
    await assert.rejects(
      fixture.deletions.save({
        ...record,
        completedSteps: [
          "runs_fenced",
          "evidence_removed",
          "runs_removed",
          "github_detached",
        ],
        updatedAt: NOW.toISOString(),
      }, revision),
      /immutable|lompatan|step/iu,
    );
    await assert.rejects(
      fixture.deletions.create({
        ...record,
        deletionId: "project-deletion-forged",
        completedSteps: [
          "runs_fenced",
          "evidence_removed",
          "runs_removed",
          "github_detached",
        ],
      }),
      /awal|canonical/iu,
    );

    let sequential = deletion;
    for (const step of [
      "runs_fenced",
      "evidence_removed",
      "runs_removed",
      "github_detached",
    ] as const) {
      const { revision: currentRevision, ...current } = sequential;
      const saved = await fixture.deletions.save({
        ...current,
        completedSteps: [...current.completedSteps, step],
      }, currentRevision);
      assert.equal(saved.status, "saved");
      if (saved.status !== "saved") throw new Error("Fixture transition gagal.");
      sequential = saved.record;
    }
    const { revision: sequentialRevision, ...sequentialRecord } = sequential;
    await assert.rejects(
      fixture.deletions.save({
        ...sequentialRecord,
        completedSteps: [...sequentialRecord.completedSteps, "project_removed"],
      }, sequentialRevision),
      /completion|canonical/iu,
    );
  });

  it("cleanup durable project exact tidak menyapu trash project lain", async () => {
    const fixture = await createFixture();
    const first = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const first = 1;\n"),
    );
    const second = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const second = 2;\n"),
    );
    const secondSnapshot = await fixture.projects.getSnapshotHandle(
      fixture.ownerScope,
      second.id,
      second.revision,
    );
    const deletion = await fixture.coordinator.request(
      fixture.ownerScope,
      first.id,
      first.revision,
    );
    let durable = deletion;
    for (const step of [
      "runs_fenced",
      "evidence_removed",
      "runs_removed",
      "github_detached",
    ] as const) {
      const { revision, ...record } = durable;
      const saved = await fixture.deletions.save({
        ...record,
        completedSteps: [...record.completedSteps, step],
      }, revision);
      assert.equal(saved.status, "saved");
      if (saved.status !== "saved") throw new Error("Fixture transition gagal.");
      durable = saved.record;
    }
    assert.equal(
      await fixture.projectRepository.remove(first.id, first.revision),
      "removed",
    );

    const ownerPart = createHash("sha256")
      .update("harvy-project-owner-v1\0", "utf8")
      .update(second.ownerWorkspaceKey, "utf8")
      .digest("hex");
    const secondTrash = join(
      fixture.root,
      "project-data",
      "trash",
      ownerPart,
      second.id,
      "foreign-prune",
    );
    await mkdir(secondTrash, { recursive: true });
    await writeFile(join(secondTrash, ".harvy-trash.json"), `${JSON.stringify({
      version: 1,
      kind: "snapshot-prune",
      ownerPart,
      projectId: second.id,
      projectCreatedAt: second.createdAt,
      snapshotId: second.baseSnapshot,
    })}\n`, "utf8");
    await rename(secondSnapshot.internalPath, join(secondTrash, "snapshot"));

    const reference = {
      version: 1 as const,
      deletionId: durable.deletionId,
      ownerWorkspaceKey: durable.ownerWorkspaceKey,
      projectId: durable.projectId,
      projectCreatedAt: durable.projectCreatedAt,
      projectSource: durable.projectSource,
      expectedProjectRevision: durable.expectedProjectRevision,
    };
    await assert.rejects(
      fixture.projects.removeForDurableDeletion(reference),
      /payload|masih tersisa/iu,
    );
    await assert.rejects(access(secondSnapshot.internalPath));
    await access(secondTrash);
  });

  it("tidak meluncurkan provider setelah tombstone dan mem-fence call yang sudah aktif", async () => {
    const fixture = await createFixture({ deletionQuiescenceMs: 25 });
    const project = await fixture.projects.createFromUpload(
      fixture.ownerScope,
      zip("export const value = 1;\n"),
    );
    const run = await fixture.engine.start(
      fixture.ownerScope,
      project.id,
      project.revision,
      brief(),
    );
    let releaseLaunch!: () => void;
    const launched = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const inFlight = fixture.engine.runCoordinatorDecision(
      fixture.ownerScope,
      run.runId,
      run.stateRevision,
      5_000,
      undefined,
      async () => {
        releaseLaunch();
        await providerGate;
        return "late-result";
      },
    );
    const inFlightOutcome = inFlight.then(
      () => null,
      (error: unknown) => error,
    );
    await launched;
    const deletion = await fixture.coordinator.request(
      fixture.ownerScope,
      project.id,
      project.revision,
    );
    const blocked = await fixture.coordinator.resume(
      fixture.ownerScope,
      deletion.deletionId,
    );
    assert.equal(blocked.status, "cleanup_required");
    assert.match(String(await inFlightOutcome), /dibatalkan|AbortError/u);
    releaseProvider();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const completed = await fixture.coordinator.resume(
      fixture.ownerScope,
      deletion.deletionId,
    );
    assert.equal(completed.status, "completed", JSON.stringify(completed.lastError));

    let calls = 0;
    await assert.rejects(
      fixture.engine.runCoordinatorDecision(
        fixture.ownerScope,
        run.runId,
        run.stateRevision,
        5_000,
        undefined,
        async () => {
          calls += 1;
          return "unexpected";
        },
      ),
      /tidak ditemukan|tidak tersedia|dihapus|deletion/u,
    );
    assert.equal(calls, 0);
  });
});

async function createFixture(options: {
  github?: ConstructorParameters<typeof ProjectDeletionCoordinator>[5];
  deletionQuiescenceMs?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "harvy-project-deletion-"));
  let sequence = 0;
  const ids = () => `id-${sequence += 1}`;
  const authority = new WorkspaceAuthorityService(
    new FileWorkspaceRepository(join(root, "authority.json")),
    () => NOW,
    ids,
  );
  const owner = workspacePrincipal(SECRET, "telegram", "owner");
  const created = await authority.createWorkspace("Deletion", owner);
  const projectRepository = new FileProjectWorkspaceRepository(
    join(root, "projects.json"),
  );
  const deletions = new FileProjectDeletionRepository(join(root, "deletions.json"));
  const projects = new ProjectWorkspaceService(
    projectRepository,
    authority,
    { root: join(root, "project-data") },
    { async forgetAll() {} },
    () => NOW,
    ids,
    undefined,
    deletions,
  );
  const runs = new FileCodingRunRepository(join(root, "runs.json"));
  const evidence = new FileCodingEvidenceStore(join(root, "evidence"));
  const sandbox = new DeletionSandbox();
  const engine = new CodingRunEngine(
    runs,
    projects,
    sandbox,
    VALIDATOR_POLICY,
    {
      evidenceStore: evidence,
      ...(options.deletionQuiescenceMs
        ? { deletionQuiescenceMs: options.deletionQuiescenceMs }
        : {}),
    },
    () => NOW,
    ids,
  );
  const coordinator = new ProjectDeletionCoordinator(
    deletions,
    projects,
    runs,
    engine,
    evidence,
    options.github,
    () => NOW,
    ids,
  );
  return {
    root,
    authority,
    ownerScope: created.scope,
    projectRepository,
    deletions,
    projects,
    runs,
    evidence,
    sandbox,
    engine,
    coordinator,
  };
}

class DeletionSandbox implements SandboxRunner {
  fenceCalls = 0;
  async health(): Promise<SandboxHealth> {
    return { available: false, runtime: null, checkedAt: NOW.toISOString(), reason: "test" };
  }
  async allocate(): Promise<SandboxLease> { throw new Error("not used"); }
  async execute(_lease: SandboxLease, _request: SandboxExecRequest): Promise<SandboxExecResult> {
    throw new Error("not used");
  }
  async captureSnapshot(): Promise<SandboxSnapshotResult> { throw new Error("not used"); }
  async readArtifact(
    _lease: SandboxLease,
    _artifact: SandboxArtifactReference,
  ): Promise<Uint8Array> { throw new Error("not used"); }
  async dispose(): Promise<void> {}
  async fenceProjectRuns(): Promise<void> { this.fenceCalls += 1; }
}

const VALIDATOR_POLICY: CodingValidatorPolicy = {
  taskReviewer: { id: "deletion-test", version: "1" },
  async commandsFor() { return []; },
  async reviewTask() { throw new Error("not used"); },
};

function brief() {
  return {
    request: "Ubah value.",
    objective: "Project selesai.",
    acceptanceCriteria: ["Test lulus"],
    initialConstraints: [],
  };
}

function zip(content: string): Buffer {
  return buildZip([
    { name: "src/", content: "" },
    { name: "src/index.ts", content },
  ]);
}
