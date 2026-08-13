import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
    const pending = await fixture.coordinator.resume(
      fixture.ownerScope,
      deletion.deletionId,
    );
    assert.equal(pending.status, "cleanup_required");
    assert.equal(pending.lastError?.code, "github_effect_unknown");
    assert.ok(await fixture.projectRepository.load(project.id));
    assert.equal(await fixture.projects.get(fixture.ownerScope, project.id), null);

    blocked = false;
    const completed = await fixture.coordinator.resume(
      fixture.ownerScope,
      deletion.deletionId,
    );
    assert.equal(completed.status, "completed", JSON.stringify(completed.lastError));
    assert.equal(await fixture.projectRepository.load(project.id), null);
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
