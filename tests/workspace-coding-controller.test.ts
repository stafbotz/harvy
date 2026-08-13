import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ProjectWorkspaceService } from "../src/core/project-workspace-service.js";
import {
  WorkspaceAuthorityService,
  workspacePrincipal,
} from "../src/core/workspace-authority-service.js";
import {
  WorkspaceCodingController,
  type AuthenticatedWorkspaceActor,
  type CodingRunCreator,
  type ResolvedWorkspaceActor,
  type WorkspaceActorResolver,
} from "../src/core/workspace-coding-controller.js";
import type { CodingRun, CodingTaskBrief } from "../src/domain/coding-run.js";
import type { WorkspaceAgentScope } from "../src/harness/scope.js";
import { FileProjectWorkspaceRepository } from "../src/storage/file-project-workspace-repository.js";
import { FileWorkspaceRepository } from "../src/storage/file-workspace-repository.js";
import { buildZip } from "./zip-test-fixture.js";

const NOW = new Date("2026-08-11T10:00:00.000Z");
const SECRET = "workspace-controller-test-secret-32";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("WorkspaceCodingController", () => {
  it("mengunggah ZIP lewat principal tepercaya dan hanya mengembalikan DTO kecil", async () => {
    const fixture = await createFixture();
    const result = await fixture.controller.uploadZip(
      fixture.ownerActor,
      {
        workspaceKey: fixture.scope.workspaceKey,
        archive: buildZip([{ name: "src/index.ts", content: "safe\n" }]),
      },
    );
    assert.equal(result.revision, 1);
    assert.match(result.snapshotId, /^[a-f0-9]{64}$/u);
    assert.match(result.archiveSha256, /^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(fixture.scope.workspaceKey), false);
    assert.equal(serialized.includes("internalPath"), false);
    assert.equal(serialized.includes(fixture.root), false);
  });

  it("menolak viewer, principal asing, field scope/context, dan body terlalu besar", async () => {
    const fixture = await createFixture();
    const groupActor = fixture.actors.issue(fixture.ownerPrincipal, "group");
    await assert.rejects(
      fixture.controller.uploadZip(groupActor, {
        workspaceKey: fixture.scope.workspaceKey,
        archive: buildZip([{ name: "x.txt", content: "x" }]),
      }),
      /actor tidak sah|access/iu,
    );
    const viewerPrincipal = workspacePrincipal(SECRET, "telegram", "viewer");
    const viewerActor = fixture.actors.issue(viewerPrincipal);
    const added = await fixture.authority.addMember(
      fixture.scope,
      viewerPrincipal,
      "viewer",
    );
    assert.equal(added.status, "updated");
    await assert.rejects(
      fixture.controller.uploadZip(
        viewerActor,
        {
          workspaceKey: fixture.scope.workspaceKey,
          archive: buildZip([{ name: "x.txt", content: "x" }]),
        },
      ),
      /artifact\.write|izin workspace/iu,
    );
    const stranger = workspacePrincipal(SECRET, "telegram", "stranger");
    const strangerActor = fixture.actors.issue(stranger);
    await assert.rejects(
      fixture.controller.uploadZip(
        strangerActor,
        {
          workspaceKey: fixture.scope.workspaceKey,
          archive: buildZip([{ name: "x.txt", content: "x" }]),
        },
      ),
      /tidak tersedia/iu,
    );
    await assert.rejects(
      fixture.controller.uploadZip(
        { principal: fixture.ownerPrincipal } as never,
        {
          workspaceKey: fixture.scope.workspaceKey,
          archive: buildZip([{ name: "x.txt", content: "x" }]),
        },
      ),
      /actor tidak sah|access/iu,
    );
    await assert.rejects(
      fixture.controller.uploadZip(
        fixture.ownerActor,
        {
          workspaceKey: fixture.scope.workspaceKey,
          archive: buildZip([{ name: "x.txt", content: "x" }]),
          scope: fixture.scope,
          context: "PRIVATE_HISTORY_SENTINEL",
        } as never,
      ),
      /field asing|schema/iu,
    );
    await assert.rejects(
      fixture.controller.uploadZip(
        fixture.ownerActor,
        {
          workspaceKey: fixture.scope.workspaceKey,
          archive: Buffer.alloc(32 * 1024 * 1024 + 1),
        },
      ),
      /32 MiB|melewati/iu,
    );
  });

  it("membuat state CodingRun tanpa membawa history/memory atau scope dari command", async () => {
    const fixture = await createFixture();
    const uploaded = await fixture.controller.uploadZip(
      fixture.ownerActor,
      {
        workspaceKey: fixture.scope.workspaceKey,
        archive: buildZip([{ name: "src/index.ts", content: "before\n" }]),
      },
    );
    const brief: CodingTaskBrief = {
      request: "Ubah nilai yang diminta",
      objective: "Nilai baru terverifikasi",
      acceptanceCriteria: ["Tes lulus"],
      initialConstraints: ["Jangan ubah API publik"],
    };
    const result = await fixture.controller.createCodingRun(
      fixture.ownerActor,
      {
        workspaceKey: fixture.scope.workspaceKey,
        projectId: uploaded.projectId,
        expectedProjectRevision: uploaded.revision,
        brief,
      },
    );
    assert.deepEqual(result, {
      runId: "coding-run-controller-1",
      projectId: uploaded.projectId,
      workspaceRevision: 1,
      stateRevision: 0,
      status: "running",
      phase: "mapping",
    });
    assert.deepEqual(fixture.runs.lastBrief, brief);
    const captured = JSON.stringify(fixture.runs.lastBrief);
    assert.equal(captured.includes("PRIVATE_HISTORY_SENTINEL"), false);
    assert.equal(JSON.stringify(result).includes("workingCopyId"), false);
    assert.equal(fixture.runs.lastScope?.workspaceKey, fixture.scope.workspaceKey);
  });

  it("menolak credential-like brief dan field percakapan sebelum engine dipanggil", async () => {
    const fixture = await createFixture();
    const uploaded = await fixture.controller.uploadZip(
      fixture.ownerActor,
      {
        workspaceKey: fixture.scope.workspaceKey,
        archive: buildZip([{ name: "src/index.ts", content: "before\n" }]),
      },
    );
    await assert.rejects(
      fixture.controller.createCodingRun(
        fixture.ownerActor,
        {
          workspaceKey: fixture.scope.workspaceKey,
          projectId: uploaded.projectId,
          expectedProjectRevision: 1,
          brief: {
            request: `Use github_pat_${"A".repeat(30)}`,
            objective: "Fix",
            acceptanceCriteria: ["Done"],
            initialConstraints: [],
          },
        },
      ),
      /credential-like/iu,
    );
    await assert.rejects(
      fixture.controller.createCodingRun(
        fixture.ownerActor,
        {
          workspaceKey: fixture.scope.workspaceKey,
          projectId: uploaded.projectId,
          expectedProjectRevision: 1,
          brief: {
            request: "Fix",
            objective: "Fix",
            acceptanceCriteria: ["Done"],
            initialConstraints: [],
          },
          conversation: { history: "PRIVATE_HISTORY_SENTINEL" },
        } as never,
      ),
      /field asing|schema/iu,
    );
    assert.equal(fixture.runs.calls, 0);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "harvy-workspace-controller-"));
  roots.push(root);
  let sequence = 0;
  const ids = () => `id-${sequence += 1}`;
  const ownerPrincipal = workspacePrincipal(SECRET, "telegram", "owner");
  const actors = new FakeWorkspaceActorResolver();
  const ownerActor = actors.issue(ownerPrincipal);
  const authority = new WorkspaceAuthorityService(
    new FileWorkspaceRepository(join(root, "authority.json")),
    () => NOW,
    ids,
  );
  const workspace = await authority.createWorkspace("Controller", ownerPrincipal);
  const projects = new ProjectWorkspaceService(
    new FileProjectWorkspaceRepository(join(root, "projects.json")),
    authority,
    { root: join(root, "project-data") },
    undefined,
    () => NOW,
    ids,
  );
  const runs = new FakeCodingRunCreator();
  return {
    root,
    ownerPrincipal,
    ownerActor,
    actors,
    authority,
    scope: workspace.scope,
    projects,
    runs,
    controller: new WorkspaceCodingController(authority, actors, projects, runs),
  };
}

class FakeWorkspaceActorResolver implements WorkspaceActorResolver {
  private readonly principals = new WeakMap<object, ResolvedWorkspaceActor>();
  private sequence = 0;

  issue(
    principal: ReturnType<typeof workspacePrincipal>,
    audience: ResolvedWorkspaceActor["audience"] = "workspace-private",
  ): AuthenticatedWorkspaceActor {
    const handle = Object.freeze({});
    this.sequence += 1;
    this.principals.set(handle, {
      principal: structuredClone(principal),
      interactionId: `workspace-interaction-${this.sequence}`,
      audience,
    });
    return handle as AuthenticatedWorkspaceActor;
  }

  async resolve(
    actor: AuthenticatedWorkspaceActor,
  ): Promise<ResolvedWorkspaceActor | null> {
    if (!actor || typeof actor !== "object") return null;
    return structuredClone(this.principals.get(actor as object) ?? null);
  }
}

class FakeCodingRunCreator implements CodingRunCreator {
  calls = 0;
  lastScope: WorkspaceAgentScope | null = null;
  lastBrief: CodingTaskBrief | null = null;

  async start(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedWorkspaceRevision: number,
    brief: CodingTaskBrief,
  ): Promise<CodingRun> {
    this.calls += 1;
    this.lastScope = structuredClone(scope);
    this.lastBrief = structuredClone(brief);
    return fakeRun(scope, projectId, expectedWorkspaceRevision, brief);
  }
}

function fakeRun(
  scope: WorkspaceAgentScope,
  projectId: string,
  workspaceRevision: number,
  brief: CodingTaskBrief,
): CodingRun {
  const at = NOW.toISOString();
  return {
    version: 2,
    runId: "coding-run-controller-1",
    binding: {
      projectId,
      ownerWorkspaceKey: scope.workspaceKey,
      workspaceRevision,
      baseSnapshot: "a".repeat(64),
    },
    taskBrief: structuredClone(brief),
    status: "running",
    phase: "mapping",
    instructionRevision: 0,
    appliedInstructionRevision: 0,
    stateRevision: 0,
    workingCopyId: "working-copy-controller-1",
    writer: {
      writerId: "writer-controller-1",
      acquiredAt: at,
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    },
    constraints: [],
    changeSets: [],
    events: [],
    validatorReceipts: [],
    taskReviewReceipts: [],
    repositoryMap: null,
    plan: null,
    diff: null,
    limits: {
      maxPatches: 1,
      maxSandboxCalls: 1,
      maxChangedFiles: 1,
      maxChangedBytes: 1,
      maxActiveMs: 60_000,
      maxCoordinatorDecisions: 64,
    },
    counters: {
      patches: 0,
      sandboxCalls: 0,
      activeElapsedMs: 0,
      coordinatorDecisions: 0,
    },
    pendingCommit: null,
    commitReceipts: [],
    result: null,
    lastError: null,
    createdAt: at,
    startedAt: at,
    updatedAt: at,
    completedAt: null,
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  };
}
