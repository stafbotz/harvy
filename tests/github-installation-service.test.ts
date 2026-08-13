import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  GitHubInstallationService,
} from "../src/core/github-installation-service.js";
import {
  ProjectWorkspaceService,
  projectIdForGitHubSelection,
} from "../src/core/project-workspace-service.js";
import {
  WorkspaceAuthorityService,
  workspacePrincipal,
} from "../src/core/workspace-authority-service.js";
import type {
  GitHubBrokerHealth,
  GitHubBrokerTransport,
  GitHubBrokerTransportResult,
  GitHubConnectionState,
  GitHubExactEffect,
  GitHubInstallationSession,
  GitHubInstallationRepository,
  GitHubInstallationStatus,
  GitHubInstallationTransport,
  GitHubInteractiveAction,
  GitHubInteractiveAuthority,
  GitHubInteractiveBinding,
  GitHubInteractiveGrant,
  GitHubRepositoryAccess,
  GitHubRepositoryArchiveReference,
  GitHubRepositoryPage,
} from "../src/domain/github.js";
import type { WorkspaceAgentScope } from "../src/harness/scope.js";
import { FileGitHubConnectionRepository } from "../src/storage/file-github-connection-repository.js";
import { FileProjectWorkspaceRepository } from "../src/storage/file-project-workspace-repository.js";
import { FileWorkspaceRepository } from "../src/storage/file-workspace-repository.js";
import { buildZip } from "./zip-test-fixture.js";

const NOW = new Date("2026-08-11T09:00:00.000Z");
const OWNER_SECRET = "github-install-test-principal-secret-32";
const BASE = "a".repeat(40);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("GitHub installation lifecycle durable", () => {
  it("menulis WAL sebelum begin dan mengulang session exact setelah timeout", async () => {
    const fixture = await createFixture();
    const grant = fixture.confirmations.issue(
      fixture.scope,
      "github.install.begin",
      null,
      null,
    );
    fixture.transport.beforeBegin = async () => {
      const durable = await fixture.repository.loadInstallationByConfirmation(
        grant.confirmationId,
      );
      assert.equal(durable?.status, "pending");
      assert.ok(durable?.sessionId);
    };
    fixture.transport.failBeginOnce = true;

    await assert.rejects(
      fixture.service.beginInstallation(fixture.scope, grant),
      /timeout simulasi/iu,
    );
    const pending = await fixture.repository.loadInstallationByConfirmation(
      grant.confirmationId,
    );
    assert.equal(pending?.status, "pending");

    const resumed = await fixture.service.beginInstallation(fixture.scope, grant);
    assert.equal(resumed.connection.connectionId, pending?.connectionId);
    assert.equal(resumed.authorizationUrl?.startsWith("https://github.com/apps/"), true);
    assert.equal(new Set(fixture.transport.beginSessions).size, 1);
    assert.equal(fixture.transport.beginSessions.length, 2);

    const metadata = await readFile(fixture.connectionFile, "utf8");
    assert.equal(metadata.includes(grant.proof), false);
    assert.equal(metadata.includes(resumed.authorizationUrl!), false);
    assert.equal(metadata.includes(grant.confirmationId), true);
    assert.equal(JSON.parse(metadata).version, 2);
  });

  it("menolak confirmation install lintas audience atau interaction", async () => {
    const fixture = await createFixture();
    const grant = fixture.confirmations.issue(
      fixture.scope,
      "github.install.begin",
      null,
      null,
    );
    await assert.rejects(
      fixture.service.beginInstallation(fixture.scope, {
        ...grant,
        audience: "group" as never,
      }),
      /audience.*workspace-private/iu,
    );
    await assert.rejects(
      fixture.service.beginInstallation(fixture.scope, {
        ...grant,
        interactionId: "workspace-private-interaction-tampered",
      }),
      /confirmation controller.*tidak sah/iu,
    );
    assert.equal(fixture.transport.beginSessions.length, 0);
  });

  it("mengaktifkan connection exact dan menolak viewer/installation asing sebelum list", async () => {
    const fixture = await createActiveFixture();
    const viewerPrincipal = workspacePrincipal(
      OWNER_SECRET,
      "telegram",
      "viewer",
    );
    const added = await fixture.authority.addMember(
      fixture.scope,
      viewerPrincipal,
      "viewer",
    );
    assert.equal(added.status, "updated");
    const owner = await fixture.authority.resolveScope(
      fixture.scope.workspaceKey,
      fixture.ownerPrincipal,
    );
    const viewer = await fixture.authority.resolveScope(
      fixture.scope.workspaceKey,
      viewerPrincipal,
    );
    assert.ok(owner && viewer);

    const viewerGrant = fixture.confirmations.issue(
      viewer,
      "github.install.repositories.list",
      fixture.connection.connectionId,
      null,
    );
    await assert.rejects(
      fixture.service.listRepositories(
        viewer,
        fixture.connection.connectionId,
        null,
        viewerGrant,
      ),
      /workspace\.manage|izin workspace/iu,
    );
    assert.equal(fixture.transport.listCalls, 0);

    const listGrant = fixture.confirmations.issue(
      owner,
      "github.install.repositories.list",
      fixture.connection.connectionId,
      null,
    );
    const page = await fixture.service.listRepositories(
      owner,
      fixture.connection.connectionId,
      null,
      listGrant,
    );
    assert.equal(page.repositories[0]?.repositoryId, "repo-1");
    assert.equal(fixture.transport.listCalls, 1);

    const foreignGrant = fixture.confirmations.issue(
      owner,
      "github.install.repositories.list",
      "github-installation-foreign",
      null,
    );
    await assert.rejects(
      fixture.service.listRepositories(
        owner,
        "github-installation-foreign",
        null,
        foreignGrant,
      ),
      /tidak ditemukan/iu,
    );
    assert.equal(fixture.transport.listCalls, 1);
  });

  it("mendurable-kan selection sebelum archive dan melanjutkan exact setelah failure", async () => {
    const fixture = await createActiveFixture();
    const grant = fixture.confirmations.issue(
      fixture.scope,
      "github.repository.select",
      fixture.connection.connectionId,
      "repo-1",
    );
    fixture.transport.beforePrepare = async () => {
      const durable = await fixture.repository.loadSelectionByConfirmation(
        grant.confirmationId,
      );
      assert.equal(durable?.status, "selected");
      assert.equal(durable?.archive, null);
    };
    fixture.transport.failPrepareOnce = true;

    await assert.rejects(
      fixture.service.selectRepository(
        fixture.scope,
        { connectionId: fixture.connection.connectionId, repositoryId: "repo-1" },
        grant,
      ),
      /archive timeout simulasi/iu,
    );
    const selected = await fixture.repository.loadSelectionByConfirmation(
      grant.confirmationId,
    );
    assert.equal(selected?.status, "selected");
    assert.equal(fixture.transport.preparedCommits.length, 1);

    const ready = await fixture.service.selectRepository(
      fixture.scope,
      { connectionId: fixture.connection.connectionId, repositoryId: "repo-1" },
      grant,
    );
    assert.equal(ready.selectionId, selected?.selectionId);
    assert.equal(ready.status, "archive_ready");
    assert.equal(ready.archive?.commit, BASE);
    assert.deepEqual(fixture.transport.preparedCommits, [BASE, BASE]);

    const metadata = await readFile(fixture.connectionFile, "utf8");
    assert.equal(metadata.includes(grant.proof), false);
    assert.equal(metadata.includes("github_pat_"), false);
  });

  it("membatalkan selection ketika repository bergerak sebelum archive retry", async () => {
    const fixture = await createActiveFixture();
    const grant = fixture.confirmations.issue(
      fixture.scope,
      "github.repository.select",
      fixture.connection.connectionId,
      "repo-1",
    );
    fixture.transport.failPrepareOnce = true;
    await assert.rejects(
      fixture.service.selectRepository(
        fixture.scope,
        { connectionId: fixture.connection.connectionId, repositoryId: "repo-1" },
        grant,
      ),
    );
    fixture.transport.baseCommit = "b".repeat(40);
    await assert.rejects(
      fixture.service.selectRepository(
        fixture.scope,
        { connectionId: fixture.connection.connectionId, repositoryId: "repo-1" },
        grant,
      ),
      /berubah setelah selection/iu,
    );
    const cancelled = await fixture.repository.loadSelectionByConfirmation(
      grant.confirmationId,
    );
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(fixture.transport.preparedCommits.length, 1);
  });

  it("mengunduh archive exact dan memulihkan project deterministic tanpa duplikasi", async () => {
    const fixture = await createActiveFixture();
    const grant = fixture.confirmations.issue(
      fixture.scope,
      "github.repository.select",
      fixture.connection.connectionId,
      "repo-1",
    );
    const selected = await fixture.service.selectRepository(
      fixture.scope,
      { connectionId: fixture.connection.connectionId, repositoryId: "repo-1" },
      grant,
    );
    const provisionGrant = fixture.confirmations.issue(
      fixture.scope,
      "github.repository.provision",
      fixture.connection.connectionId,
      "repo-1",
      selected.selectionId,
    );
    const first = await fixture.service.provisionRepository(
      fixture.scope,
      selected.selectionId,
      provisionGrant,
    );
    const replay = await fixture.service.provisionRepository(
      fixture.scope,
      selected.selectionId,
      provisionGrant,
    );
    assert.equal(first.selection.status, "bound");
    assert.match(first.selection.bindingId!, /^github-binding-[a-f0-9]{64}$/u);
    assert.equal(replay.project.id, first.project.id);
    assert.equal(replay.project.baseSnapshot, first.project.baseSnapshot);
    assert.equal(first.project.revision, 2);
    assert.equal(fixture.transport.downloadCalls, 1);
    assert.equal((await fixture.projects.list(fixture.scope)).length, 1);
    assert.equal(first.project.source.type, "github");
    if (first.project.source.type === "github") {
      assert.equal(
        first.project.source.repositorySelectionId,
        selected.selectionId,
      );
      assert.equal(
        first.project.source.installationConnectionId,
        fixture.connection.connectionId,
      );
      assert.equal(first.project.source.provisioningStatus, "bound");
      assert.equal(
        first.project.source.repositoryBindingId,
        first.selection.bindingId,
      );
    }
  });

  it("menolak byte archive yang tidak cocok sebelum ProjectWorkspace dibuat", async () => {
    const fixture = await createActiveFixture();
    const grant = fixture.confirmations.issue(
      fixture.scope,
      "github.repository.select",
      fixture.connection.connectionId,
      "repo-1",
    );
    const selected = await fixture.service.selectRepository(
      fixture.scope,
      { connectionId: fixture.connection.connectionId, repositoryId: "repo-1" },
      grant,
    );
    const provisionGrant = fixture.confirmations.issue(
      fixture.scope,
      "github.repository.provision",
      fixture.connection.connectionId,
      "repo-1",
      selected.selectionId,
    );
    fixture.transport.downloadOverride = Buffer.from("tampered archive", "utf8");
    await assert.rejects(
      fixture.service.provisionRepository(
        fixture.scope,
        selected.selectionId,
        provisionGrant,
      ),
      /ukuran descriptor|digest berubah|terpotong/iu,
    );
    assert.equal((await fixture.projects.list(fixture.scope)).length, 0);
    assert.equal(
      (await fixture.repository.loadSelection(selected.selectionId))?.status,
      "archive_ready",
    );
  });

  it("memulihkan crash setelah project durable tanpa mengunduh archive lagi", async () => {
    const fixture = await createActiveFixture();
    const selectGrant = fixture.confirmations.issue(
      fixture.scope,
      "github.repository.select",
      fixture.connection.connectionId,
      "repo-1",
    );
    const selected = await fixture.service.selectRepository(
      fixture.scope,
      { connectionId: fixture.connection.connectionId, repositoryId: "repo-1" },
      selectGrant,
    );
    const provisionGrant = fixture.confirmations.issue(
      fixture.scope,
      "github.repository.provision",
      fixture.connection.connectionId,
      "repo-1",
      selected.selectionId,
    );
    let failProjectCreated = true;
    const faultingRepository = new Proxy(fixture.repository, {
      get(target, property) {
        if (property === "saveSelection") {
          return async (
            next: Parameters<GitHubInstallationRepository["saveSelection"]>[0],
            expected: Parameters<GitHubInstallationRepository["saveSelection"]>[1],
          ) => {
            if (failProjectCreated && next.status === "project_created") {
              failProjectCreated = false;
              throw new Error("simulated crash before project_created CAS");
            }
            return target.saveSelection(next, expected);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as GitHubInstallationRepository;
    const faultingService = new GitHubInstallationService(
      faultingRepository,
      fixture.transport,
      fixture.transport,
      fixture.confirmations,
      fixture.authority,
      fixture.projects,
      () => NOW,
      fixture.ids,
    );
    await assert.rejects(
      faultingService.provisionRepository(
        fixture.scope,
        selected.selectionId,
        provisionGrant,
      ),
      /simulated crash/iu,
    );
    assert.equal((await fixture.projects.list(fixture.scope)).length, 0);
    assert.equal(
      await fixture.projects.get(
        fixture.scope,
        projectIdForGitHubSelection(selected.selectionId),
      ),
      null,
    );
    assert.equal(
      (await fixture.repository.loadSelection(selected.selectionId))?.status,
      "archive_ready",
    );
    assert.equal(fixture.transport.downloadCalls, 1);

    fixture.transport.failDownload = true;
    const recovered = await fixture.service.provisionRepository(
      fixture.scope,
      selected.selectionId,
      provisionGrant,
    );
    assert.equal(recovered.selection.status, "bound");
    assert.equal(recovered.project.revision, 2);
    assert.equal((await fixture.projects.list(fixture.scope)).length, 1);
    assert.equal(fixture.transport.downloadCalls, 1);
  });

  it("menahan project tetap tersembunyi bila selection kedaluwarsa saat materialisasi", async () => {
    const fixture = await createActiveFixture();
    const selectGrant = fixture.confirmations.issue(
      fixture.scope,
      "github.repository.select",
      fixture.connection.connectionId,
      "repo-1",
    );
    const selected = await fixture.service.selectRepository(
      fixture.scope,
      { connectionId: fixture.connection.connectionId, repositoryId: "repo-1" },
      selectGrant,
    );
    const provisionGrant = fixture.confirmations.issue(
      fixture.scope,
      "github.repository.provision",
      fixture.connection.connectionId,
      "repo-1",
      selected.selectionId,
    );
    let current = new Date(NOW);
    fixture.transport.beforeDownload = () => {
      current = new Date(NOW.getTime() + 11 * 60_000);
    };
    const expiringService = new GitHubInstallationService(
      fixture.repository,
      fixture.transport,
      fixture.transport,
      fixture.confirmations,
      fixture.authority,
      fixture.projects,
      () => current,
      fixture.ids,
    );
    await assert.rejects(
      expiringService.provisionRepository(
        fixture.scope,
        selected.selectionId,
        provisionGrant,
      ),
      /kedaluwarsa saat project dimaterialisasi/iu,
    );
    const durable = await fixture.repository.loadSelection(selected.selectionId);
    assert.equal(durable?.status, "cleanup_required");
    assert.ok(durable?.projectId);
    assert.equal((await fixture.projects.list(fixture.scope)).length, 0);
    assert.equal(
      (await fixture.projects.getGitHubProvisioningProject(
        fixture.scope,
        selected.selectionId,
      ))?.source.type,
      "github",
    );
  });

  it("mencabut connection secara lokal dengan confirmation terpisah", async () => {
    const fixture = await createActiveFixture();
    const grant = fixture.confirmations.issue(
      fixture.scope,
      "github.install.revoke",
      fixture.connection.connectionId,
      null,
    );
    const revoked = await fixture.service.revokeInstallation(
      fixture.scope,
      fixture.connection.connectionId,
      grant,
    );
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revocationAuthorityId, grant.confirmationId);
    const replay = await fixture.service.revokeInstallation(
      fixture.scope,
      fixture.connection.connectionId,
      grant,
    );
    assert.deepEqual(replay, revoked);

    const listGrant = fixture.confirmations.issue(
      fixture.scope,
      "github.install.repositories.list",
      fixture.connection.connectionId,
      null,
    );
    await assert.rejects(
      fixture.service.listRepositories(
        fixture.scope,
        fixture.connection.connectionId,
        null,
        listGrant,
      ),
      /belum aktif|dicabut/iu,
    );
  });

  it("migrasi v1 fail-closed terhadap field selection asing/credential", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.connectionFile,
      JSON.stringify({
        version: 1,
        connections: [{
          version: 1,
          binding: {
            bindingId: "legacy-binding-1",
            projectId: "legacy-project-1",
            ownerWorkspaceKey: fixture.scope.workspaceKey,
            installationId: "legacy-installation-1",
            repositoryId: "legacy-repository-1",
            repositoryFullName: "student/legacy",
            visibility: "private",
            defaultBranch: "main",
            revision: 1,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            revokedAt: null,
          },
          approvals: [],
          receipts: [{
            receiptId: "legacy-receipt-1",
            effectId: "legacy-effect-1",
            effectDigest: "d".repeat(64),
            capability: "github.branch.create",
            branch: "harvy/legacy",
            commit: "b".repeat(40),
            baseCommit: "a".repeat(40),
            workspaceRevision: 1,
            status: "committed",
            effect: {
              effectId: "legacy-effect-1",
              attempt: 1,
              capability: "github.branch.create",
              projectId: "legacy-project-1",
              runId: "legacy-run-1",
              ownerWorkspaceKey: fixture.scope.workspaceKey,
              installationId: "legacy-installation-1",
              repositoryId: "legacy-repository-1",
              workspaceRevision: 1,
              instructionRevision: 0,
              branch: "harvy/legacy",
              commit: "b".repeat(40),
              baseCommit: "a".repeat(40),
              expectedTargetHead: null,
              baseBranch: "main",
              title: null,
              body: null,
              draft: null,
              objectBundle: null,
            },
            externalId: "harvy/legacy",
            url: null,
            committedAt: NOW.toISOString(),
          }],
        }],
      }),
      "utf8",
    );
    const legacy = await fixture.repository.loadByProject("legacy-project-1");
    assert.equal(legacy?.binding.installationConnectionId, null);
    assert.equal(legacy?.binding.repositorySelectionId, null);
    assert.equal(legacy?.receipts[0]?.effect.repositoryBindingId, null);
    assert.deepEqual(
      await fixture.repository.listInstallationsByWorkspace(
        fixture.scope.workspaceKey,
      ),
      [],
    );

    const grant = fixture.confirmations.issue(
      fixture.scope,
      "github.install.begin",
      null,
      null,
    );
    await fixture.service.beginInstallation(fixture.scope, grant);
    const parsed = JSON.parse(await readFile(fixture.connectionFile, "utf8"));
    parsed.installations[0].proof = "github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await writeFile(fixture.connectionFile, JSON.stringify(parsed), "utf8");
    await assert.rejects(
      fixture.repository.loadInstallation(parsed.installations[0].connectionId),
      /credential|field asing|schema/iu,
    );
  });

  it("menjaga confirmation approval single-use lintas project", async () => {
    const fixture = await createFixture();
    const first = legacyApprovalState(
      fixture.scope.workspaceKey,
      "project-confirmation-1",
      "binding-confirmation-1",
      "confirmation-global-1",
    );
    const second = legacyApprovalState(
      fixture.scope.workspaceKey,
      "project-confirmation-2",
      "binding-confirmation-2",
      "confirmation-global-1",
    );
    assert.equal((await fixture.repository.create(first)).status, "saved");
    await assert.rejects(
      fixture.repository.create(second),
      /confirmation.*lebih dari sekali|confirmation.*global/iu,
    );
    assert.equal(await fixture.repository.loadByProject(second.binding.projectId), null);
  });
});

function legacyApprovalState(
  workspaceKey: string,
  projectId: string,
  bindingId: string,
  confirmationId: string,
): GitHubConnectionState {
  return {
    version: 1,
    binding: {
      bindingId,
      projectId,
      ownerWorkspaceKey: workspaceKey,
      installationConnectionId: null,
      repositorySelectionId: null,
      installationId: `installation-${projectId}`,
      repositoryId: `repository-${projectId}`,
      repositoryFullName: `student/${projectId}`,
      visibility: "private",
      defaultBranch: "main",
      revision: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      revokedAt: null,
    },
    approvals: [{
      approvalId: `approval-${projectId}`,
      confirmationId,
      effectDigest: "e".repeat(64),
      capability: "github.branch.create",
      approvedByMembershipId: "membership-confirmation-owner",
      approvedAclEpoch: 1,
      approvedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      consumedAt: null,
    }],
    receipts: [],
  };
}

async function createActiveFixture() {
  const fixture = await createFixture();
  const beginGrant = fixture.confirmations.issue(
    fixture.scope,
    "github.install.begin",
    null,
    null,
  );
  const started = await fixture.service.beginInstallation(
    fixture.scope,
    beginGrant,
  );
  fixture.transport.statusBySession.set(started.connection.sessionId, {
    sessionId: started.connection.sessionId,
    ownerWorkspaceKey: fixture.scope.workspaceKey,
    status: "ready",
    installationId: "installation-1",
    completedAt: new Date(NOW.getTime() + 1_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
  });
  const statusGrant = fixture.confirmations.issue(
    fixture.scope,
    "github.install.status",
    started.connection.connectionId,
    null,
  );
  const connection = await fixture.service.refreshInstallation(
    fixture.scope,
    started.connection.connectionId,
    statusGrant,
  );
  assert.equal(connection.status, "active");
  return { ...fixture, connection };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "harvy-github-install-"));
  roots.push(root);
  let id = 0;
  const ids = () => `id-${id += 1}`;
  const ownerPrincipal = workspacePrincipal(
    OWNER_SECRET,
    "telegram",
    "owner",
  );
  const authority = new WorkspaceAuthorityService(
    new FileWorkspaceRepository(join(root, "workspace.json")),
    () => NOW,
    ids,
  );
  const workspace = await authority.createWorkspace("GitHub install", ownerPrincipal);
  const connectionFile = join(root, "github.json");
  const repository = new FileGitHubConnectionRepository(connectionFile);
  const projects = new ProjectWorkspaceService(
    new FileProjectWorkspaceRepository(join(root, "projects.json")),
    authority,
    { root: join(root, "project-data") },
    undefined,
    () => NOW,
    ids,
    repository,
  );
  const transport = new FakeGitHubInstallationTransport();
  const confirmations = new FakeInteractiveAuthority();
  const service = new GitHubInstallationService(
    repository,
    transport,
    transport,
    confirmations,
    authority,
    projects,
    () => NOW,
    ids,
  );
  return {
    root,
    ids,
    ownerPrincipal,
    authority,
    scope: workspace.scope,
    connectionFile,
    repository,
    transport,
    confirmations,
    projects,
    service,
  };
}

class FakeInteractiveAuthority implements GitHubInteractiveAuthority {
  private sequence = 0;
  private readonly grants = new Map<
    string,
    { grant: GitHubInteractiveGrant; binding: GitHubInteractiveBinding }
  >();

  issue(
    scope: WorkspaceAgentScope,
    action: GitHubInteractiveAction,
    connectionId: string | null,
    repositoryId: string | null,
    selectionId: string | null = null,
  ): GitHubInteractiveGrant {
    this.sequence += 1;
    const grant: GitHubInteractiveGrant = {
      confirmationId: `interactive-confirmation-${this.sequence}`,
      interactionId: `workspace-private-interaction-${this.sequence}`,
      audience: "workspace-private",
      proof: `private-controller-proof-value-${this.sequence}`,
      expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    };
    this.grants.set(grant.proof, {
      grant,
      binding: {
        action,
        interactionId: grant.interactionId,
        audience: "workspace-private",
        ownerWorkspaceKey: scope.workspaceKey,
        membershipId: scope.membershipId,
        aclEpoch: scope.aclEpoch,
        connectionId,
        repositoryId,
        selectionId,
      },
    });
    return structuredClone(grant);
  }

  async verify(
    grant: GitHubInteractiveGrant,
    binding: GitHubInteractiveBinding,
  ): Promise<boolean> {
    const expected = this.grants.get(grant.proof);
    return Boolean(
      expected &&
      JSON.stringify(expected.grant) === JSON.stringify(grant) &&
      JSON.stringify(expected.binding) === JSON.stringify(binding),
    );
  }
}

class FakeGitHubInstallationTransport
implements GitHubInstallationTransport, GitHubBrokerTransport {
  failBeginOnce = false;
  failPrepareOnce = false;
  beforeBegin: (() => Promise<void>) | null = null;
  beforePrepare: (() => Promise<void>) | null = null;
  beforeDownload: (() => void | Promise<void>) | null = null;
  beginSessions: string[] = [];
  preparedCommits: string[] = [];
  listCalls = 0;
  downloadCalls = 0;
  baseCommit = BASE;
  downloadOverride: Buffer | null = null;
  failDownload = false;
  readonly archiveBytes = buildZip([
    { name: "src/index.ts", content: "export const selected = true;\n" },
  ]);
  readonly statusBySession = new Map<string, GitHubInstallationStatus>();

  async health(): Promise<GitHubBrokerHealth> {
    return {
      available: true,
      protocol: "harvy-github-broker/1",
      checkedAt: NOW.toISOString(),
      reason: null,
    };
  }

  async beginInstallation(
    ownerWorkspaceKey: string,
    sessionId: string,
  ): Promise<GitHubInstallationSession> {
    this.beginSessions.push(sessionId);
    await this.beforeBegin?.();
    if (this.failBeginOnce) {
      this.failBeginOnce = false;
      throw new Error("begin timeout simulasi");
    }
    if (!this.statusBySession.has(sessionId)) {
      this.statusBySession.set(sessionId, {
        sessionId,
        ownerWorkspaceKey,
        status: "pending",
        installationId: null,
        completedAt: null,
        expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      });
    }
    return {
      sessionId,
      ownerWorkspaceKey,
      status: "pending",
      authorizationUrl:
        `https://github.com/apps/harvy-test/installations/new?state=${sessionId}`,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    };
  }

  async installationStatus(
    ownerWorkspaceKey: string,
    sessionId: string,
  ): Promise<GitHubInstallationStatus> {
    return structuredClone(this.statusBySession.get(sessionId) ?? {
      sessionId,
      ownerWorkspaceKey,
      status: "pending" as const,
      installationId: null,
      completedAt: null,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    });
  }

  async listRepositories(
    ownerWorkspaceKey: string,
    installationId: string,
  ): Promise<GitHubRepositoryPage> {
    this.listCalls += 1;
    return {
      ownerWorkspaceKey,
      installationId,
      repositories: [{
        installationId,
        repositoryId: "repo-1",
        repositoryFullName: "student/repo",
        visibility: "private",
        defaultBranch: "main",
      }],
      nextCursor: null,
    };
  }

  async repositoryAccess(
    ownerWorkspaceKey: string,
    installationId: string,
    repositoryId: string,
  ): Promise<GitHubRepositoryAccess> {
    return {
      ownerWorkspaceKey,
      installationId,
      repositoryId,
      repositoryFullName: "student/repo",
      visibility: "private",
      defaultBranch: "main",
      baseCommit: this.baseCommit,
      targetBranch: null,
      targetBranchHead: null,
      canRead: true,
      canPush: true,
      canWriteWorkflows: false,
      canCreatePullRequest: true,
    };
  }

  async prepareRepositoryArchive(
    ownerWorkspaceKey: string,
    installationId: string,
    repositoryId: string,
    commit: string,
    operationId: string,
  ): Promise<GitHubRepositoryArchiveReference> {
    this.preparedCommits.push(commit);
    await this.beforePrepare?.();
    if (this.failPrepareOnce) {
      this.failPrepareOnce = false;
      throw new Error("archive timeout simulasi");
    }
    return {
      version: 1,
      operationId,
      archiveId: `archive-${commit}`,
      ownerWorkspaceKey,
      installationId,
      repositoryId,
      repositoryFullName: "student/repo",
      defaultBranch: "main",
      commit,
      mediaType: "application/zip",
      sha256: createHash("sha256").update(this.archiveBytes).digest("hex"),
      size: this.archiveBytes.byteLength,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    };
  }

  downloadRepositoryArchive(
    _reference: GitHubRepositoryArchiveReference,
  ): AsyncIterable<Uint8Array> {
    this.downloadCalls += 1;
    if (this.failDownload) {
      return (async function* () {
        throw new Error("archive should not be downloaded during recovery");
      })();
    }
    const bytes = this.downloadOverride ?? this.archiveBytes;
    const beforeDownload = this.beforeDownload;
    return (async function* () {
      await beforeDownload?.();
      yield bytes;
    })();
  }

  async createBranch(effect: GitHubExactEffect): Promise<GitHubBrokerTransportResult> {
    return committed(effect);
  }

  async pushExactCommit(
    effect: GitHubExactEffect,
    _bundle: AsyncIterable<Uint8Array>,
  ): Promise<GitHubBrokerTransportResult> {
    return committed(effect);
  }

  async createDraftPullRequest(
    effect: GitHubExactEffect,
  ): Promise<GitHubBrokerTransportResult> {
    return committed(effect);
  }

  async reconcileEffect(
    effect: GitHubExactEffect,
  ): Promise<GitHubBrokerTransportResult> {
    return committed(effect);
  }
}

function committed(effect: GitHubExactEffect): GitHubBrokerTransportResult {
  return {
    effectId: effect.effectId,
    status: "committed",
    operationFenced: true,
    externalId: null,
    url: null,
    completedAt: NOW.toISOString(),
  };
}
