import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  GroupWorkspaceCodingController,
  GroupWorkspaceLinkService,
  type AuthenticatedGroupCodingActor,
  type GroupCodingActorResolver,
  type GroupCodingAuthorityExpectation,
  type GroupCodingAuthorityGuard,
  type GroupCodingRunCreator,
  type GroupCodingRunReader,
  type GroupRuntimeBindingReader,
  type ResolvedGroupCodingActor,
} from "../src/core/group-workspace-coding-controller.js";
import {
  WorkspaceAuthorityService,
  workspacePrincipal,
} from "../src/core/workspace-authority-service.js";
import type {
  CodingRun,
  CodingRunStartOptions,
  CodingTaskBrief,
} from "../src/domain/coding-run.js";
import type { GroupAuthoritySnapshot } from "../src/core/group-authority-policy.js";
import { groupScopeKey, type GroupBinding, type GroupScope } from "../src/domain/group.js";
import type { WorkspaceAgentScope } from "../src/harness/scope.js";
import { FileGroupCodingRepository } from "../src/storage/file-group-coding-repository.js";
import { FileWorkspaceRepository } from "../src/storage/file-workspace-repository.js";

const NOW = new Date("2026-08-15T03:00:00.000Z");
const SECRET = "group-coding-test-secret-at-least-32-chars";
const GROUP: GroupScope = { channel: "whatsapp", groupId: "kelas@g.us" };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("Phase L group Workspace coding", () => {
  it("memerlukan irisan admin grup dan workspace.manage untuk membuat link", async () => {
    const fixture = await createFixture();
    fixture.guard.set(GROUP, "account-1", ["owner-wa"], {
      role: "member",
      authorityEpoch: 7,
    });
    const memberActor = fixture.actors.issue(
      actor(fixture.ownerPrincipal, "owner-wa", false, 7, "link-member"),
    );
    await assert.rejects(
      fixture.controller.linkWorkspace(memberActor, {
        workspaceKey: fixture.workspaceKey,
      }),
      /authority lease|access|admin/iu,
    );

    fixture.guard.set(GROUP, "account-1", ["owner-wa"], {
      role: "admin",
      authorityEpoch: 8,
    });
    const adminActor = fixture.actors.issue(
      actor(fixture.ownerPrincipal, "owner-wa", true, 8, "link-admin"),
    );
    const linked = await fixture.controller.linkWorkspace(adminActor, {
      workspaceKey: fixture.workspaceKey,
    });
    assert.deepEqual(linked, {
      audience: "group-safe",
      status: "linked",
      text: "Grup ini sudah terhubung ke Workspace. Izin setiap anggota tetap diperiksa per aksi.",
    });
    const durable = await fixture.repository.loadLink(groupScopeKey(GROUP), "account-1");
    assert.equal(durable?.workspaceKey, fixture.workspaceKey);
    assert.equal(durable?.groupJoinedAt, fixture.binding.joinedAt);
    assert.equal(durable?.linkedAtAuthorityEpoch, 8);
  });

  it("tidak menganggap membership WhatsApp sebagai membership Workspace", async () => {
    const fixture = await linkedFixture();
    const stranger = workspacePrincipal(SECRET, "whatsapp", "stranger-wa");
    fixture.guard.set(GROUP, "account-1", ["stranger-wa"], {
      role: "member",
      authorityEpoch: 9,
    });
    const strangerActor = fixture.actors.issue(
      actor(stranger, "stranger-wa", false, 9, "stranger-run"),
    );
    await assert.rejects(
      fixture.controller.createCodingRun(strangerActor, runCommand()),
      /membership Workspace|tidak mempunyai/iu,
    );
    assert.equal(fixture.runs.startCalls, 0);
  });

  it("membuat CodingRun idempoten dan hanya mengembalikan proyeksi group-safe", async () => {
    const fixture = await linkedFixture();
    const ownerActor = fixture.actors.issue(
      actor(fixture.ownerPrincipal, "owner-wa", true, 8, "run-same-interaction"),
    );
    const first = await fixture.controller.createCodingRun(ownerActor, runCommand());
    const replay = await fixture.controller.createCodingRun(ownerActor, runCommand());
    assert.deepEqual(replay, first);
    assert.equal(fixture.runs.startCalls, 1);
    assert.equal(first.audience, "group-safe");
    assert.equal(first.status, "running");
    const serialized = JSON.stringify(first);
    for (const privateValue of [
      fixture.workspaceKey,
      "project-private-1",
      "src/private-auth.ts",
      "WORKSPACE_PRIVATE_TASK_BRIEF",
      "snapshot-private",
      "working-copy-private",
    ]) assert.equal(serialized.includes(privateValue), false);
    const run = fixture.runs.lastStarted;
    assert.equal(run?.admission?.source, "group");
    assert.equal(run?.admission?.audience, "group-safe");
    assert.match(run?.admission?.interactionDigest ?? "", /^[a-f0-9]{64}$/u);

    await assert.rejects(
      fixture.controller.createCodingRun(ownerActor, {
        ...runCommand(),
        brief: {
          ...runCommand().brief,
          objective: "Command lain pada interaction yang sama",
        },
      }),
      /bertabrakan|collision|command lain/iu,
    );
    assert.equal(fixture.runs.startCalls, 1);
  });

  it("membatasi status ke run yang benar-benar dimulai dari audience grup itu", async () => {
    const fixture = await linkedFixture();
    const ownerActor = fixture.actors.issue(
      actor(fixture.ownerPrincipal, "owner-wa", true, 8, "run-for-status"),
    );
    const created = await fixture.controller.createCodingRun(ownerActor, runCommand());
    const statusActor = fixture.actors.issue(
      actor(fixture.ownerPrincipal, "owner-wa", true, 8, "status-interaction"),
    );
    assert.equal(
      (await fixture.controller.getCodingRun(statusActor, { runId: created.runId })).runId,
      created.runId,
    );
    fixture.runs.put(fakeRun(
      fixture.ownerScope,
      "unbound-run",
      "project-private-1",
      runCommand().brief,
      undefined,
    ));
    await assert.rejects(
      fixture.controller.getCodingRun(statusActor, { runId: "unbound-run" }),
      /bukan milik audience/iu,
    );
  });

  it("menahan source/diff dan semua aksi GitHub di belakang Workspace-private confirmation", async () => {
    const fixture = await linkedFixture();
    const actorHandle = fixture.actors.issue(
      actor(fixture.ownerPrincipal, "owner-wa", true, 8, "publish-run"),
    );
    const created = await fixture.controller.createCodingRun(actorHandle, runCommand());
    fixture.runs.complete(created.runId);
    const publishActor = fixture.actors.issue(
      actor(fixture.ownerPrincipal, "owner-wa", true, 8, "publish-offer"),
    );
    const offer = await fixture.controller.requestPublish(publishActor, {
      runId: created.runId,
      action: "github.push_branch",
    });
    assert.deepEqual(offer, {
      audience: "group-safe",
      runId: created.runId,
      action: "github.push_branch",
      status: "workspace-private-confirmation-required",
      text: "Push belum dijalankan. Lanjutkan konfirmasi exact commit di Workspace privat.",
    });
    assert.equal(JSON.stringify(offer).includes("src/private-auth.ts"), false);
    assert.equal(fixture.runs.publishCalls, 0);
  });

  it("viewer boleh melihat status tetapi tidak membuat run atau meminta publish", async () => {
    const fixture = await linkedFixture();
    const ownerActor = fixture.actors.issue(
      actor(fixture.ownerPrincipal, "owner-wa", true, 8, "owner-create"),
    );
    const created = await fixture.controller.createCodingRun(ownerActor, runCommand());
    fixture.runs.complete(created.runId);
    const viewerPrincipal = workspacePrincipal(SECRET, "whatsapp", "viewer-wa");
    const ownerScope = await fixture.authority.resolveScope(
      fixture.workspaceKey,
      fixture.ownerPrincipal,
    );
    assert.ok(ownerScope);
    assert.equal(
      (await fixture.authority.addMember(ownerScope, viewerPrincipal, "viewer")).status,
      "updated",
    );
    fixture.guard.set(GROUP, "account-1", ["viewer-wa"], {
      role: "member",
      authorityEpoch: 9,
    });
    const viewerStatus = fixture.actors.issue(
      actor(viewerPrincipal, "viewer-wa", false, 9, "viewer-status"),
    );
    assert.equal(
      (await fixture.controller.getCodingRun(viewerStatus, { runId: created.runId })).status,
      "completed",
    );
    const viewerCreate = fixture.actors.issue(
      actor(viewerPrincipal, "viewer-wa", false, 9, "viewer-create"),
    );
    await assert.rejects(
      fixture.controller.createCodingRun(viewerCreate, runCommand()),
      /code\.write|izin workspace/iu,
    );
    const viewerPublish = fixture.actors.issue(
      actor(viewerPrincipal, "viewer-wa", false, 9, "viewer-publish"),
    );
    await assert.rejects(
      fixture.controller.requestPublish(viewerPublish, {
        runId: created.runId,
        action: "github.push_branch",
      }),
      /github\.push|izin workspace/iu,
    );
  });

  it("remove/re-add group dan authority epoch basi mematikan link lama", async () => {
    const fixture = await linkedFixture();
    fixture.bindings.set({ ...fixture.binding, joinedAt: "2026-08-15T04:00:00.000Z" });
    const staleGeneration = fixture.actors.issue(
      actor(fixture.ownerPrincipal, "owner-wa", true, 8, "stale-generation"),
    );
    await assert.rejects(
      fixture.controller.createCodingRun(staleGeneration, runCommand()),
      /link Workspace aktif|generation/iu,
    );

    fixture.bindings.set(fixture.binding);
    fixture.guard.set(GROUP, "account-1", ["owner-wa"], {
      role: "admin",
      authorityEpoch: 10,
    });
    const staleEpoch = fixture.actors.issue(
      actor(fixture.ownerPrincipal, "owner-wa", true, 8, "stale-epoch"),
    );
    await assert.rejects(
      fixture.controller.createCodingRun(staleEpoch, runCommand()),
      /authority|epoch|tidak cocok/iu,
    );
    assert.equal(fixture.runs.startCalls, 0);
  });

  it("repository pulih lintas instance dan menolak schema/link transition rusak", async () => {
    const fixture = await linkedFixture();
    const second = new FileGroupCodingRepository(fixture.repositoryFile);
    const loaded = await second.loadLink(groupScopeKey(GROUP), "account-1");
    assert.equal(loaded?.status, "active");
    assert.equal(loaded?.stateRevision, 1);
    if (!loaded) return;
    await assert.rejects(
      second.saveLink({
        ...withoutStateRevision(loaded),
        workspaceKey: "workspace-forged",
        status: "revoked",
        revokedAt: NOW.toISOString(),
      }, loaded.stateRevision),
      /immutable/iu,
    );

    const raw = JSON.parse(await readFile(fixture.repositoryFile, "utf8")) as {
      links: Array<Record<string, unknown>>;
    };
    raw.links[0]!["privateTranscript"] = "PRIVATE_HISTORY_SENTINEL";
    await writeFile(fixture.repositoryFile, JSON.stringify(raw), "utf8");
    await assert.rejects(
      second.loadLink(groupScopeKey(GROUP), "account-1"),
      /field asing|schema/iu,
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-coding-"));
  roots.push(root);
  let sequence = 0;
  const ids = () => `id-${sequence += 1}`;
  const ownerPrincipal = workspacePrincipal(SECRET, "whatsapp", "owner-wa");
  const authority = new WorkspaceAuthorityService(
    new FileWorkspaceRepository(join(root, "workspace.json")),
    () => NOW,
    ids,
  );
  const workspace = await authority.createWorkspace("Group coding", ownerPrincipal);
  const binding: GroupBinding = {
    scopeKey: groupScopeKey(GROUP),
    channel: "whatsapp",
    groupId: GROUP.groupId,
    accountId: "account-1",
    groupName: "Kelas",
    joinedAt: "2026-08-15T02:00:00.000Z",
    noticeVersion: 9,
    noticeSentAt: "2026-08-15T02:01:00.000Z",
    disabledAt: null,
  };
  const bindings = new FakeBindingReader(binding);
  const guard = new FakeAuthorityGuard();
  guard.set(GROUP, "account-1", ["owner-wa"], {
    role: "admin",
    authorityEpoch: 8,
  });
  const actors = new FakeActorResolver();
  const repositoryFile = join(root, "group-coding.json");
  const repository = new FileGroupCodingRepository(repositoryFile);
  const runs = new FakeGroupCodingRuns();
  const links = new GroupWorkspaceLinkService(
    repository,
    bindings,
    guard,
    authority,
    () => NOW,
    ids,
  );
  const controller = new GroupWorkspaceCodingController(
    actors,
    links,
    repository,
    runs,
    () => NOW,
    ids,
  );
  return {
    root,
    repositoryFile,
    ownerPrincipal,
    ownerScope: workspace.scope,
    workspaceKey: workspace.workspace.workspaceKey,
    authority,
    binding,
    bindings,
    guard,
    actors,
    repository,
    runs,
    controller,
  };
}

async function linkedFixture() {
  const fixture = await createFixture();
  const linkActor = fixture.actors.issue(
    actor(fixture.ownerPrincipal, "owner-wa", true, 8, "initial-link"),
  );
  await fixture.controller.linkWorkspace(linkActor, {
    workspaceKey: fixture.workspaceKey,
  });
  return fixture;
}

function actor(
  principal: ReturnType<typeof workspacePrincipal>,
  participantId: string,
  claimedAdmin: boolean,
  claimedAuthorityEpoch: number,
  interactionId: string,
): ResolvedGroupCodingActor {
  return {
    audience: "group",
    interactionId,
    principal,
    scope: GROUP,
    accountId: "account-1",
    participantIds: [participantId],
    claimedAdmin,
    claimedAuthorityEpoch,
  };
}

function runCommand() {
  return {
    projectId: "project-private-1",
    expectedProjectRevision: 1,
    brief: {
      request: "WORKSPACE_PRIVATE_TASK_BRIEF",
      objective: "Perbaiki login",
      acceptanceCriteria: ["Test lulus"],
      initialConstraints: ["Jangan ubah API"],
    },
  } satisfies {
    projectId: string;
    expectedProjectRevision: number;
    brief: CodingTaskBrief;
  };
}

class FakeActorResolver implements GroupCodingActorResolver {
  private readonly actors = new WeakMap<object, ResolvedGroupCodingActor>();

  issue(actor: ResolvedGroupCodingActor): AuthenticatedGroupCodingActor {
    const handle = Object.freeze({});
    this.actors.set(handle, structuredClone(actor));
    return handle as AuthenticatedGroupCodingActor;
  }

  async resolve(
    actor: AuthenticatedGroupCodingActor,
  ): Promise<ResolvedGroupCodingActor | null> {
    return structuredClone(this.actors.get(actor as object) ?? null);
  }
}

class FakeBindingReader implements GroupRuntimeBindingReader {
  private current: GroupBinding;

  constructor(binding: GroupBinding) {
    this.current = structuredClone(binding);
  }

  set(binding: GroupBinding): void {
    this.current = structuredClone(binding);
  }

  async binding(scopeKey: string): Promise<GroupBinding | null> {
    return this.current.scopeKey === scopeKey ? structuredClone(this.current) : null;
  }
}

class FakeAuthorityGuard implements GroupCodingAuthorityGuard {
  private readonly values = new Map<string, GroupAuthoritySnapshot>();

  set(
    scope: GroupScope,
    accountId: string,
    participantIds: readonly string[],
    value: GroupAuthoritySnapshot,
  ): void {
    this.values.set(key(scope, accountId, participantIds), structuredClone(value));
  }

  async withCurrentActor<T>(
    expectation: GroupCodingAuthorityExpectation,
    operation: (authority: GroupAuthoritySnapshot) => Promise<T>,
  ): Promise<T> {
    const value = this.values.get(key(
      expectation.scope,
      expectation.accountId,
      expectation.participantIds,
    ));
    if (
      !value || value.authorityEpoch !== expectation.claimedAuthorityEpoch ||
      (expectation.minimumRole === "admin" && value.role !== "admin")
    ) throw new Error("group authority lease tidak cocok");
    return operation(structuredClone(value));
  }
}

class FakeGroupCodingRuns implements GroupCodingRunCreator, GroupCodingRunReader {
  readonly runs = new Map<string, CodingRun>();
  startCalls = 0;
  publishCalls = 0;
  lastStarted: CodingRun | null = null;

  async start(
    scope: WorkspaceAgentScope,
    projectId: string,
    expectedWorkspaceRevision: number,
    brief: CodingTaskBrief,
    options: CodingRunStartOptions = {},
  ): Promise<CodingRun> {
    const replay = [...this.runs.values()].find(
      (candidate) => candidate.admission?.effectId === options.admission?.effectId,
    );
    if (replay) {
      if (
        JSON.stringify(replay.admission) !== JSON.stringify(options.admission) ||
        JSON.stringify(replay.taskBrief) !== JSON.stringify(brief)
      ) throw new Error("Admission effect CodingRun bertabrakan dengan command lain.");
      return structuredClone(replay);
    }
    this.startCalls += 1;
    const run = fakeRun(
      scope,
      `group-coding-run-${this.startCalls}`,
      projectId,
      brief,
      options.admission,
      expectedWorkspaceRevision,
    );
    this.put(run);
    this.lastStarted = structuredClone(run);
    return structuredClone(run);
  }

  async get(scope: WorkspaceAgentScope, runId: string): Promise<CodingRun | null> {
    const run = this.runs.get(runId);
    return run?.binding.ownerWorkspaceKey === scope.workspaceKey
      ? structuredClone(run)
      : null;
  }

  put(run: CodingRun): void {
    this.runs.set(run.runId, structuredClone(run));
  }

  complete(runId: string): void {
    const run = this.runs.get(runId);
    assert.ok(run);
    const completed: CodingRun = {
      ...run,
      status: "completed",
      phase: "completed",
      diff: {
        baseSnapshot: "a".repeat(64),
        workingSnapshot: "b".repeat(64),
        files: [{
          path: "src/private-auth.ts",
          status: "modified",
          beforeSha256: "c".repeat(64),
          afterSha256: "d".repeat(64),
          beforeSize: 10,
          afterSize: 12,
          binary: false,
        }],
        addedBytes: 2,
        removedBytes: 0,
        generatedAt: NOW.toISOString(),
      },
      result: {
        instructionRevision: 0,
        projectRevision: 2,
        snapshotId: "b".repeat(64),
        changedFiles: 1,
        validators: [{
          kind: "test",
          status: "passed",
          sandboxOperationId: "private-operation",
          sandboxRequestDigest: "e".repeat(64),
          sandboxExecutionId: "private-execution",
        }],
        taskReview: null,
        completedAt: NOW.toISOString(),
      },
      completedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    this.put(completed);
  }
}

function fakeRun(
  scope: WorkspaceAgentScope,
  runId: string,
  projectId: string,
  brief: CodingTaskBrief,
  admission: CodingRunStartOptions["admission"],
  workspaceRevision = 1,
): CodingRun {
  return {
    version: 2,
    runId,
    binding: {
      projectId,
      ownerWorkspaceKey: scope.workspaceKey,
      workspaceRevision,
      baseSnapshot: "a".repeat(64),
    },
    taskBrief: structuredClone(brief),
    ...(admission ? { admission: structuredClone(admission) } : {}),
    status: "running",
    phase: "editing",
    instructionRevision: 0,
    appliedInstructionRevision: 0,
    stateRevision: 1,
    workingCopyId: "working-copy-private",
    writer: {
      writerId: "writer-private",
      acquiredAt: NOW.toISOString(),
      expiresAt: "2026-08-15T04:00:00.000Z",
    },
    constraints: [],
    changeSets: [],
    events: [],
    validatorReceipts: [],
    taskReviewReceipts: [],
    repositoryMap: null,
    plan: null,
    diff: {
      baseSnapshot: "a".repeat(64),
      workingSnapshot: "f".repeat(64),
      files: [{
        path: "src/private-auth.ts",
        status: "modified",
        beforeSha256: "c".repeat(64),
        afterSha256: "d".repeat(64),
        beforeSize: 10,
        afterSize: 12,
        binary: false,
      }],
      addedBytes: 2,
      removedBytes: 0,
      generatedAt: NOW.toISOString(),
    },
    limits: {
      maxPatches: 4,
      maxSandboxCalls: 4,
      maxChangedFiles: 8,
      maxChangedBytes: 10_000,
      maxActiveMs: 60_000,
      maxCoordinatorDecisions: 64,
    },
    counters: {
      patches: 1,
      sandboxCalls: 0,
      activeElapsedMs: 100,
      coordinatorDecisions: 1,
    },
    pendingCommit: null,
    commitReceipts: [],
    result: null,
    lastError: null,
    createdAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    completedAt: null,
    expiresAt: "2026-08-16T03:00:00.000Z",
  };
}

function key(
  scope: GroupScope,
  accountId: string,
  participantIds: readonly string[],
): string {
  return `${groupScopeKey(scope)}\0${accountId}\0${[...participantIds].sort().join("|")}`;
}

function withoutStateRevision<T extends { stateRevision: number }>(
  value: T,
): Omit<T, "stateRevision"> {
  const { stateRevision: _revision, ...rest } = value;
  return rest;
}
