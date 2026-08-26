import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CodingRunEngine } from "../src/core/coding-run-engine.js";
import { effectDigest, GitHubBroker } from "../src/core/github-broker.js";
import { startGitHubReconciliationWorker } from "../src/core/github-reconciliation-worker.js";
import { LocalGitService } from "../src/core/local-git-service.js";
import type { GitHubInstallationService } from "../src/core/github-installation-service.js";
import { PrivateGitHubApplication } from "../src/core/private-github-application.js";
import { PrivateGitHubConfirmationController } from
  "../src/core/private-github-confirmation-controller.js";
import { ProjectWorkspaceService } from "../src/core/project-workspace-service.js";
import { TrustedWorkspaceActorRegistry } from
  "../src/core/trusted-workspace-actor-registry.js";
import { callTransportWithDeadline } from "../src/core/transport-deadline.js";
import {
  WorkspaceAuthorityService,
  workspacePrincipal,
} from "../src/core/workspace-authority-service.js";
import type { CodingValidatorPolicy } from "../src/coding/coding-validators.js";
import type {
  GitHubBrokerTransport,
  GitHubBrokerTransportResult,
  GitHubConfirmationAuthority,
  GitHubConfirmationBinding,
  GitHubConfirmationGrant,
  GitHubExactEffect,
  GitHubInstallationConnection,
  GitHubRepositoryAccess,
  GitHubRepositoryBootstrapEffect,
  GitHubRepositorySelection,
} from "../src/domain/github.js";
import type {
  LocalGitBinding,
  LocalGitCommitRequest,
  LocalGitCommitReconciliation,
  LocalGitCommitResult,
  LocalGitLogEntry,
  LocalGitObjectBundleReference,
  LocalGitStatus,
  LocalGitTransport,
} from "../src/domain/local-git.js";
import type {
  SandboxArtifactReference,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxHealth,
  SandboxInputSnapshotDescriptor,
  SandboxLease,
  SandboxRunner,
  SandboxSnapshotResult,
} from "../src/domain/sandbox.js";

function sandboxIdentity() {
  return {
    serviceIdentityDigest: "1".repeat(64),
    runtimeImageDigest: "2".repeat(64),
    policyDigest: "3".repeat(64),
  };
}
import { FileCodingRunRepository } from "../src/storage/file-coding-run-repository.js";
import { FileCodingEvidenceStore } from "../src/storage/file-coding-evidence-store.js";
import { FileGitHubConnectionRepository } from "../src/storage/file-github-connection-repository.js";
import { FileProjectWorkspaceRepository } from "../src/storage/file-project-workspace-repository.js";
import { FilePrivateCodingSessionStore } from
  "../src/storage/file-private-coding-session-store.js";
import { FileWorkspaceRepository } from "../src/storage/file-workspace-repository.js";
import type { WorkspaceAgentScope } from "../src/harness/scope.js";
import { buildZip } from "./zip-test-fixture.js";

const NOW = new Date("2026-08-10T06:00:00.000Z");
const SECRET = "github-broker-test-secret-32-characters";
const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);

describe("GitHub Broker Phase J", () => {
  it("menolak hasil transport yang tiba setelah monotonic deadline", async () => {
    await assert.rejects(
      callTransportWithDeadline("github.sync-stall", 5, async () => {
        const deadline = performance.now() + 20;
        while (performance.now() < deadline) {
          // Model a synchronous trust-domain adapter stall.
        }
        return "late";
      }),
      /watchdog timeout/iu,
    );
  });

  it("membatasi repository binding ke owner workspace, bukan viewer github.read", async () => {
    const fixture = await createFixture();
    const viewerPrincipal = workspacePrincipal(SECRET, "telegram", "viewer-connect");
    const added = await fixture.authority.addMember(
      fixture.scope,
      viewerPrincipal,
      "viewer",
    );
    assert.equal(added.status, "updated");
    const viewerScope = await fixture.authority.resolveScope(
      fixture.scope.workspaceKey,
      viewerPrincipal,
    );
    assert.ok(viewerScope);
    await assert.rejects(
      fixture.broker.connectRepository(viewerScope, {
        projectId: fixture.project.id,
        installationId: "installation-1",
        repositoryId: "repo-1",
      }),
      /workspace\.manage/iu,
    );
  });

  it("memisahkan branch, exact push, dan draft PR dengan approval granular", async () => {
    const fixture = await createFixture();
    const branchEffect = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    const branchApproval = await approveEffect(fixture, branchEffect);
    const branchReceipt = await fixture.broker.createBranch(
      fixture.scope,
      branchEffect,
      branchApproval,
    );
    assert.equal(branchReceipt.status, "committed");

    const pushEffect = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.push_branch",
    });
    const pushApproval = await approveEffect(fixture, pushEffect);
    const pushReceipt = await fixture.broker.pushBranch(
      fixture.scope,
      pushEffect,
      pushApproval,
    );
    assert.equal(pushReceipt.status, "committed");
    assert.equal(pushReceipt.commit, COMMIT);
    assert.equal(pushReceipt.baseCommit, BASE);
    assert.equal(
      fixture.transport.pushedBundleSha256.at(-1),
      pushEffect.objectBundle?.sha256,
    );
    const afterCommitStatus = await fixture.localGit.status(
      fixture.scope,
      fixture.project.id,
      fixture.project.revision,
    );
    assert.equal(afterCommitStatus.clean, true);

    await assert.rejects(
      fixture.broker.prepareEffect(fixture.scope, {
        runId: fixture.runId,
        capability: "github.pr.create",
        title: "Fix value",
        body: `Do not persist ${"github_"}${"pat_"}${"x".repeat(32)}`,
      }),
      /credential/iu,
    );
    for (const credential of [
      `xoxb-${"S".repeat(24)}`,
      `AWS_SECRET_ACCESS_KEY=${"T".repeat(40)}`,
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    ]) {
      await assert.rejects(
        fixture.broker.prepareEffect(fixture.scope, {
          runId: fixture.runId,
          capability: "github.pr.create",
          title: "Fix value",
          body: `Do not persist ${credential}`,
        }),
        /credential/iu,
      );
    }

    const prEffect = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.pr.create",
      title: "Fix value",
      body: "Perubahan sudah dites.",
    });
    assert.equal(prEffect.draft, true);
    const prApproval = await approveEffect(fixture, prEffect);
    const prReceipt = await fixture.broker.createDraftPullRequest(
      fixture.scope,
      prEffect,
      prApproval,
    );
    assert.equal(prReceipt.status, "committed");
    assert.match(prReceipt.url ?? "", /^https:\/\/github\.com\//u);
    assert.equal(fixture.transport.branches.length, 1);
    assert.equal(fixture.transport.pushes.length, 1);
    assert.equal(fixture.transport.pullRequests.length, 1);
    assert.equal(fixture.transport.pullRequests[0]?.draft, true);
    assert.equal(JSON.stringify(fixture.transport).includes("TOKEN_SENTINEL"), false);

    const metadata = await readFile(fixture.connectionFile, "utf8");
    assert.doesNotMatch(metadata, /private.?key|access.?token|credential/iu);
    assert.match(metadata, /github\.push_branch/u);
  });

  it("mengorkestrasi confirmation privat branch → push exact → draft PR", async () => {
    const fixture = await createFixture();
    const actors = new TrustedWorkspaceActorRegistry();
    const issueActor = (interactionId: string) => actors.issue({
      principal: fixture.owner,
      interactionId,
      audience: "workspace-private",
    });
    const sessions = new FilePrivateCodingSessionStore(
      join(fixture.root, "private-github-sessions.json"),
    );
    await sessions.save({
      version: 1,
      principalKey: fixture.owner.principalKey,
      channel: fixture.owner.channel,
      workspaceKey: fixture.scope.workspaceKey,
      projectId: fixture.project.id,
      projectRevision: fixture.project.revision,
      foregroundRunId: null,
      lastRunId: fixture.runId,
      updatedAt: NOW.toISOString(),
    }, null);
    const confirmations = new PrivateGitHubConfirmationController(() => NOW);
    const broker = new GitHubBroker(
      fixture.connectionRepository,
      fixture.transport,
      confirmations,
      fixture.authority,
      fixture.projects,
      fixture.codingRepository,
      fixture.localGitTransport,
      () => NOW,
      fixture.ids,
    );
    const application = new PrivateGitHubApplication(
      actors,
      fixture.authority,
      fixture.engine,
      null as unknown as GitHubInstallationService,
      broker,
      confirmations,
      fixture.connectionRepository,
      sessions,
      () => NOW,
    );

    const branchOffer = await application.preparePublishOffer(
      issueActor("telegram:publish:branch"),
    );
    assert.equal(branchOffer?.capability, "github.branch.create");
    assert.equal(branchOffer?.audience, "workspace-private");
    const branch = await application.confirmPublishOffer(
      issueActor("telegram:confirm:branch"),
      branchOffer!.offerId,
    );
    assert.equal(branch.receipt.status, "committed");
    assert.equal(branch.nextOffer?.capability, "github.push_branch");

    const push = await application.confirmPublishOffer(
      issueActor("telegram:confirm:push"),
      branch.nextOffer!.offerId,
    );
    assert.equal(push.receipt.status, "committed");
    assert.equal(push.receipt.commit, fixture.project.git?.headCommit);
    assert.equal(push.nextOffer?.capability, "github.pr.create");

    const pullRequest = await application.confirmPublishOffer(
      issueActor("telegram:confirm:pr"),
      push.nextOffer!.offerId,
    );
    assert.equal(pullRequest.receipt.status, "committed");
    assert.match(pullRequest.receipt.url ?? "", /^https:\/\/github\.com\//u);
    assert.equal(pullRequest.nextOffer, null);
    assert.equal(fixture.transport.branches.length, 1);
    assert.equal(fixture.transport.pushes.length, 1);
    assert.equal(fixture.transport.pullRequests.length, 1);
    const state = await fixture.connectionRepository.loadByProject(fixture.project.id);
    assert.deepEqual(
      state?.receipts.map((receipt) => receipt.capability),
      ["github.branch.create", "github.push_branch", "github.pr.create"],
    );
    assert.equal(new Set(state?.approvals.map((approval) =>
      approval.confirmationId)).size, 3);
  });

  it("menolak offer publish privat setelah authority epoch berubah", async () => {
    const fixture = await createFixture();
    const actors = new TrustedWorkspaceActorRegistry();
    let interaction = 0;
    const actor = () => actors.issue({
      principal: fixture.owner,
      interactionId: `telegram:publish:${interaction += 1}`,
      audience: "workspace-private",
    });
    const sessions = new FilePrivateCodingSessionStore(
      join(fixture.root, "private-github-stale-sessions.json"),
    );
    await sessions.save({
      version: 1,
      principalKey: fixture.owner.principalKey,
      channel: fixture.owner.channel,
      workspaceKey: fixture.scope.workspaceKey,
      projectId: fixture.project.id,
      projectRevision: fixture.project.revision,
      foregroundRunId: null,
      lastRunId: fixture.runId,
      updatedAt: NOW.toISOString(),
    }, null);
    const confirmations = new PrivateGitHubConfirmationController(() => NOW);
    const broker = new GitHubBroker(
      fixture.connectionRepository,
      fixture.transport,
      confirmations,
      fixture.authority,
      fixture.projects,
      fixture.codingRepository,
      fixture.localGitTransport,
      () => NOW,
      fixture.ids,
    );
    const application = new PrivateGitHubApplication(
      actors,
      fixture.authority,
      fixture.engine,
      null as unknown as GitHubInstallationService,
      broker,
      confirmations,
      fixture.connectionRepository,
      sessions,
      () => NOW,
    );
    const offer = await application.preparePublishOffer(actor());
    const member = workspacePrincipal(SECRET, "telegram", "epoch-bump-member");
    assert.equal((await fixture.authority.addMember(
      fixture.scope,
      member,
      "viewer",
    )).status, "updated");

    await assert.rejects(
      application.confirmPublishOffer(actor(), offer!.offerId),
      /authority.*berubah/iu,
    );
    assert.equal(fixture.transport.branches.length, 0);
    assert.equal(fixture.transport.pushes.length, 0);
    assert.equal(fixture.transport.pullRequests.length, 0);
  });

  it("mendorong CodingRun kedua secara non-force dari head branch Harvy sebelumnya", async () => {
    const fixture = await createFixture();
    const branch = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    await fixture.broker.createBranch(
      fixture.scope,
      branch,
      await approveEffect(fixture, branch),
    );
    const firstPush = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.push_branch",
    });
    await fixture.broker.pushBranch(
      fixture.scope,
      firstPush,
      await approveEffect(fixture, firstPush),
    );
    const firstHead = firstPush.commit;

    const current = await fixture.projectRepository.load(fixture.project.id);
    assert.ok(current);
    const run = await fixture.engine.start(
      fixture.scope,
      current.id,
      current.revision,
      {
        request: "Advance value again",
        objective: "Value menjadi 3",
        acceptanceCriteria: ["Test lulus"],
        initialConstraints: [],
      },
    );
    await fixture.engine.markMapped(fixture.scope, run.runId, 0);
    await fixture.engine.recordPlan(fixture.scope, run.runId, 0, {
      steps: [
        { stage: "inspect", description: "Inspect repository", paths: ["src"] },
        { stage: "edit", description: "Update requested value", paths: ["src/index.ts"] },
        { stage: "test", description: "Run required test", paths: [] },
        { stage: "review", description: "Review exact diff", paths: [] },
      ],
    });
    const tools = await fixture.engine.writerTools(fixture.scope, run.runId);
    const before = await tools.read(0, { path: "src/index.ts" });
    await fixture.engine.applyPatch(fixture.scope, run.runId, 0, [{
      kind: "update",
      path: "src/index.ts",
      expectedSha256: before.sha256,
      content: "export const value = 3;\n",
    }]);
    await fixture.engine.runValidator(fixture.scope, run.runId, 0, "test");
    await fixture.engine.runTaskReview(fixture.scope, run.runId, 0);
    const completed = await fixture.engine.finalize(fixture.scope, run.runId, 0);
    await fixture.localGit.commit(
      fixture.scope,
      current.id,
      completed.result!.projectRevision,
    );

    const secondPush = await fixture.broker.prepareEffect(fixture.scope, {
      runId: run.runId,
      capability: "github.push_branch",
    });
    assert.equal(secondPush.expectedTargetHead, firstHead);
    assert.equal(secondPush.objectBundle?.parentCommit, firstHead);
    const receipt = await fixture.broker.pushBranch(
      fixture.scope,
      secondPush,
      await approveEffect(fixture, secondPush),
    );
    assert.equal(receipt.status, "committed");
    assert.equal(fixture.transport.targetHeads.get(secondPush.branch), secondPush.commit);
  });

  it("mengikat exact push ke object bundle dan menolak ACK tanpa konsumsi penuh", async () => {
    const fixture = await createFixture();
    const branch = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    await fixture.broker.createBranch(
      fixture.scope,
      branch,
      await approveEffect(fixture, branch),
    );
    const push = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.push_branch",
    });
    assert.ok(push.objectBundle);
    const approval = await approveEffect(fixture, push);
    await assert.rejects(
      fixture.broker.pushBranch(
        fixture.scope,
        {
          ...push,
          objectBundle: { ...push.objectBundle, size: push.objectBundle.size + 1 },
        },
        approval,
      ),
      /bundle|deterministik|exact effect/iu,
    );

    fixture.transport.skipBundleConsumption = true;
    const receipt = await fixture.broker.pushBranch(fixture.scope, push, approval);
    assert.equal(receipt.status, "unknown");
    assert.equal(fixture.transport.pushedBundleSha256.length, 0);
  });

  it("mengirim snapshot content-addressed ke local-git tanpa host path", async () => {
    const fixture = await createFixture();
    const descriptor = fixture.localGitTransport.lastInputSnapshot;
    assert.ok(descriptor);
    assert.match(descriptor.bundleSha256, /^[a-f0-9]{64}$/u);
    assert.equal(descriptor.snapshotId, fixture.project.baseSnapshot);
    assert.equal(JSON.stringify(descriptor).includes("internalPath"), false);
    assert.equal(fixture.localGitTransport.consumedSnapshotSha256.length, 1);

    await assert.rejects(
      createFixture({ skipLocalSnapshotConsumption: true }),
      /snapshot bundle|belum terjadi/iu,
    );
  });

  it("menolak approval bila commit berubah, ACL epoch berubah, atau remote base maju", async () => {
    const commitFixture = await createFixture();
    const effect = await commitFixture.broker.prepareEffect(commitFixture.scope, {
      runId: commitFixture.runId,
      capability: "github.branch.create",
    });
    const approval = await approveEffect(commitFixture, effect);
    await assert.rejects(
      commitFixture.broker.createBranch(
        commitFixture.scope,
        { ...effect, commit: "c".repeat(40) },
        approval,
      ),
      /basi|exact effect/iu,
    );

    const aclFixture = await createFixture();
    const aclEffect = await aclFixture.broker.prepareEffect(aclFixture.scope, {
      runId: aclFixture.runId,
      capability: "github.branch.create",
    });
    const aclApproval = await approveEffect(aclFixture, aclEffect);
    await aclFixture.authority.addMember(
      aclFixture.scope,
      workspacePrincipal(SECRET, "telegram", "viewer"),
      "viewer",
    );
    const freshScope = await aclFixture.authority.resolveScope(
      aclFixture.scope.workspaceKey,
      workspacePrincipal(SECRET, "telegram", "owner"),
    );
    assert.ok(freshScope);
    await assert.rejects(
      aclFixture.broker.createBranch(freshScope, aclEffect, aclApproval),
      /Approval|basi|scope|workspace/iu,
    );

    const remoteFixture = await createFixture();
    const remoteEffect = await remoteFixture.broker.prepareEffect(remoteFixture.scope, {
      runId: remoteFixture.runId,
      capability: "github.branch.create",
    });
    const remoteApproval = await approveEffect(remoteFixture, remoteEffect);
    remoteFixture.transport.baseCommit = "d".repeat(40);
    await assert.rejects(
      remoteFixture.broker.createBranch(
        remoteFixture.scope,
        remoteEffect,
        remoteApproval,
      ),
      /remote base|authority GitHub App/iu,
    );
  });

  it("membatalkan approval lama ketika installation connection dicabut", async () => {
    const fixture = await createFixture();
    const effect = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    const approval = await approveEffect(fixture, effect);
    const installation = await fixture.connectionRepository.loadInstallation(
      "installation-connection-1",
    );
    assert.ok(installation);
    const { revision, ...record } = installation;
    const revoked = await fixture.connectionRepository.saveInstallation({
      ...record,
      status: "revoked",
      revocationAuthorityId: "revoke-confirmation-1",
      revokedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }, revision);
    assert.equal(revoked.status, "saved");
    await assert.rejects(
      fixture.broker.createBranch(fixture.scope, effect, approval),
      /installation\/selection authority|dicabut/iu,
    );
    assert.equal(fixture.transport.branches.length, 0);
  });

  it("menserialkan exact effect terhadap perubahan ProjectWorkspace", async () => {
    const fixture = await createFixture();
    const adminPrincipal = workspacePrincipal(SECRET, "telegram", "effect-admin");
    const added = await fixture.authority.addMember(
      fixture.scope,
      adminPrincipal,
      "admin",
    );
    assert.equal(added.status, "updated");
    if (added.status !== "updated") throw new Error("Admin fixture gagal dibuat.");
    const owner = await fixture.authority.resolveScope(
      fixture.scope.workspaceKey,
      workspacePrincipal(SECRET, "telegram", "owner"),
    );
    const admin = await fixture.authority.resolveScope(
      fixture.scope.workspaceKey,
      adminPrincipal,
    );
    assert.ok(owner);
    assert.ok(admin);
    const approvalFixture = { ...fixture, scope: admin };
    const effect = await fixture.broker.prepareEffect(admin, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    const approval = await approveEffect(approvalFixture, effect);
    const accessStarted = deferred<void>();
    const releaseAccess = deferred<void>();
    fixture.transport.repositoryAccessStarted = () => accessStarted.resolve();
    fixture.transport.repositoryAccessGate = releaseAccess.promise;

    const executing = fixture.broker.createBranch(admin, effect, approval);
    await accessStarted.promise;
    let rollbackSettled = false;
    const rollback = fixture.projects.rollback(
      owner,
      fixture.project.id,
      fixture.project.revision,
      1,
    ).finally(() => {
      rollbackSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(rollbackSettled, false);

    releaseAccess.resolve();
    assert.equal((await executing).status, "committed");
    assert.equal((await rollback).revision, fixture.project.revision + 1);
    assert.equal(fixture.transport.branches.length, 1);
  });

  it("menahan pencabutan ACL sampai exact effect yang sudah dimulai selesai", async () => {
    const fixture = await createFixture();
    const adminPrincipal = workspacePrincipal(SECRET, "telegram", "effect-admin");
    const added = await fixture.authority.addMember(
      fixture.scope,
      adminPrincipal,
      "admin",
    );
    assert.equal(added.status, "updated");
    if (added.status !== "updated") throw new Error("Admin fixture gagal dibuat.");
    const owner = await fixture.authority.resolveScope(
      fixture.scope.workspaceKey,
      workspacePrincipal(SECRET, "telegram", "owner"),
    );
    const admin = await fixture.authority.resolveScope(
      fixture.scope.workspaceKey,
      adminPrincipal,
    );
    assert.ok(owner);
    assert.ok(admin);
    const approvalFixture = { ...fixture, scope: admin };
    const effect = await fixture.broker.prepareEffect(admin, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    const approval = await approveEffect(approvalFixture, effect);
    const accessStarted = deferred<void>();
    const releaseAccess = deferred<void>();
    fixture.transport.repositoryAccessStarted = () => accessStarted.resolve();
    fixture.transport.repositoryAccessGate = releaseAccess.promise;

    const executing = fixture.broker.createBranch(admin, effect, approval);
    await accessStarted.promise;
    let revocationSettled = false;
    const revocation = fixture.authority.removeMember(
      owner,
      added.membership.membershipId,
    ).finally(() => {
      revocationSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(revocationSettled, false);

    releaseAccess.resolve();
    assert.equal((await executing).status, "committed");
    assert.equal((await revocation).status, "updated");
    assert.equal(fixture.transport.branches.length, 1);
  });

  it("memakai branch Harvy code-owned dan tidak mengulang efek ambiguous", async () => {
    const defaultFixture = await createFixture();
    assert.match(defaultFixture.project.git?.branch ?? "", /^harvy\//u);

    const unknownFixture = await createFixture();
    const branchEffect = await unknownFixture.broker.prepareEffect(
      unknownFixture.scope,
      { runId: unknownFixture.runId, capability: "github.branch.create" },
    );
    const branchApproval = await approveEffect(unknownFixture, branchEffect);
    await unknownFixture.broker.createBranch(
      unknownFixture.scope,
      branchEffect,
      branchApproval,
    );
    const pushEffect = await unknownFixture.broker.prepareEffect(
      unknownFixture.scope,
      { runId: unknownFixture.runId, capability: "github.push_branch" },
    );
    const pushApproval = await approveEffect(unknownFixture, pushEffect);
    unknownFixture.transport.failPush = true;
    const first = await unknownFixture.broker.pushBranch(
      unknownFixture.scope,
      pushEffect,
      pushApproval,
    );
    const replay = await unknownFixture.broker.pushBranch(
      unknownFixture.scope,
      pushEffect,
      pushApproval,
    );
    assert.equal(first.status, "unknown");
    assert.deepEqual(replay, first);
    assert.equal(unknownFixture.transport.pushes.length, 1);
    const forgedAttempt = effectWithAttempt(pushEffect, pushEffect.attempt + 1);
    await assert.rejects(
      approveEffect(unknownFixture, forgedAttempt),
      /attempt/iu,
    );
    const regenerated = await unknownFixture.broker.prepareEffect(
      unknownFixture.scope,
      { runId: unknownFixture.runId, capability: "github.push_branch" },
    );
    assert.equal(regenerated.effectId, pushEffect.effectId);
    await unknownFixture.projects.updateGitState(
      unknownFixture.scope,
      unknownFixture.project.id,
      unknownFixture.project.revision,
      structuredClone(unknownFixture.project.git!),
    );
    const reconciled = await unknownFixture.broker.reconcileUnknown(
      unknownFixture.scope,
      { projectId: regenerated.projectId, effectId: regenerated.effectId },
    );
    assert.equal(reconciled.status, "committed");
    assert.deepEqual(reconciled.effect, regenerated);
    assert.equal(unknownFixture.transport.pushes.length, 1);
  });

  it("memulihkan unknown setelah restart dan membuat attempt baru hanya setelah not_committed", async () => {
    const fixture = await createFixture();
    const branch = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    await fixture.broker.createBranch(
      fixture.scope,
      branch,
      await approveEffect(fixture, branch),
    );
    const firstEffect = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.push_branch",
    });
    fixture.transport.failPushBeforeEffect = true;
    const unknown = await fixture.broker.pushBranch(
      fixture.scope,
      firstEffect,
      await approveEffect(fixture, firstEffect),
    );
    assert.equal(unknown.status, "unknown");

    fixture.transport.reconcileNotCommitted = true;
    const restarted = new GitHubBroker(
      new FileGitHubConnectionRepository(fixture.connectionFile),
      fixture.transport,
      fixture.confirmations,
      fixture.authority,
      fixture.projects,
      fixture.codingRepository,
      fixture.localGitTransport,
      () => NOW,
      fixture.ids,
    );
    const recoveredPending = await restarted.reconcileProjectUnknown(
      fixture.scope,
      firstEffect.projectId,
    );
    const notCommitted = recoveredPending.find(
      (receipt) => receipt.effectId === firstEffect.effectId,
    )!;
    assert.equal(notCommitted.status, "not_committed");

    fixture.transport.failPushBeforeEffect = false;
    fixture.transport.reconcileNotCommitted = false;
    const retry = await restarted.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.push_branch",
    });
    assert.equal(retry.attempt, firstEffect.attempt + 1);
    assert.notEqual(retry.effectId, firstEffect.effectId);
    const committedRetry = await restarted.pushBranch(
      fixture.scope,
      retry,
      await approveEffect(fixture, retry, restarted),
    );
    assert.equal(committedRetry.status, "committed");
  });

  it("menemukan unknown secara paged dan worker restart hanya mengamati tanpa replay", async () => {
    const fixture = await createFixture();
    const branch = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    fixture.transport.failBranchBeforeEffect = true;
    const unknown = await fixture.broker.createBranch(
      fixture.scope,
      branch,
      await approveEffect(fixture, branch),
    );
    assert.equal(unknown.status, "unknown");
    const page = await fixture.connectionRepository.listUnknownEffects({
      cursor: null,
      limit: 1,
    });
    assert.deepEqual(page.references, [{
      version: 1,
      ownerWorkspaceKey: fixture.scope.workspaceKey,
      projectId: branch.projectId,
      effectId: branch.effectId,
      effectDigest: effectDigest(branch),
    }]);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(
      Object.keys(page.references[0]!).sort(),
      ["effectDigest", "effectId", "ownerWorkspaceKey", "projectId", "version"],
    );
    const serializedPage = JSON.stringify(page);
    for (const privateField of [
      "repositoryFullName", "title", "body", "url", "externalId", "effect",
      "objectBundle",
    ]) {
      assert.equal(serializedPage.includes(`"${privateField}":`), false);
    }
    await assert.rejects(
      fixture.connectionRepository.listUnknownEffects({ cursor: "%%%", limit: 1 }),
      /cursor/iu,
    );
    await assert.rejects(
      fixture.connectionRepository.listUnknownEffects({ cursor: null, limit: 101 }),
      /limit/iu,
    );

    fixture.transport.failBranchBeforeEffect = false;
    fixture.transport.reconcileNotCommitted = true;
    const branchesBefore = fixture.transport.branches.length;
    const pushesBefore = fixture.transport.pushes.length;
    const prsBefore = fixture.transport.pullRequests.length;
    const restarted = new GitHubBroker(
      new FileGitHubConnectionRepository(fixture.connectionFile),
      fixture.transport,
      fixture.confirmations,
      fixture.authority,
      fixture.projects,
      fixture.codingRepository,
      fixture.localGitTransport,
      () => NOW,
      fixture.ids,
    );
    const worker = startGitHubReconciliationWorker(
      new FileGitHubConnectionRepository(fixture.connectionFile),
      restarted,
      undefined,
      { intervalMs: 60_000, batchSize: 1 },
    );
    const report = await worker.runNow();
    worker.stop();
    await worker.drain();

    assert.deepEqual(report, {
      discovered: 1,
      terminal: 1,
      unresolved: 0,
      missing: 0,
      failed: 0,
    });
    assert.equal(fixture.transport.branches.length, branchesBefore);
    assert.equal(fixture.transport.pushes.length, pushesBefore);
    assert.equal(fixture.transport.pullRequests.length, prsBefore);
    assert.equal(fixture.transport.reconciliations, 1);
    const durable = await fixture.connectionRepository.loadByProject(branch.projectId);
    assert.equal(
      durable?.receipts.find((receipt) => receipt.effectId === branch.effectId)?.status,
      "not_committed",
    );
  });

  it("rekonsiliasi durable menahan ACK malformed sebagai unknown dan tidak perlu scope pengguna", async () => {
    const fixture = await createFixture();
    const branch = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    fixture.transport.failBranchBeforeEffect = true;
    await fixture.broker.createBranch(
      fixture.scope,
      branch,
      await approveEffect(fixture, branch),
    );
    const [reference] = (await fixture.connectionRepository.listUnknownEffects({
      cursor: null,
      limit: 10,
    })).references;
    assert.ok(reference);

    fixture.transport.failBranchBeforeEffect = false;
    fixture.transport.reconcileNotCommitted = true;
    fixture.transport.resultFenceOverride = false;
    await assert.rejects(
      fixture.broker.reconcileDurableUnknown(reference),
      /fence.*tidak cocok/iu,
    );
    const durableUnknown = await fixture.connectionRepository.loadByProject(
      branch.projectId,
    );
    assert.equal(
      durableUnknown?.receipts.find(
        (receipt) => receipt.effectId === branch.effectId,
      )?.status,
      "unknown",
    );
    assert.ok(durableUnknown);
    const { revision: expectedRevision, ...binding } = durableUnknown.binding;
    await assert.rejects(
      fixture.connectionRepository.save({
        ...durableUnknown,
        binding,
        receipts: durableUnknown.receipts.map((receipt) =>
          receipt.effectId === branch.effectId
            ? { ...receipt, externalId: "123" }
            : receipt
        ),
      }, expectedRevision),
      /non-committed.*metadata eksternal/iu,
    );
    await assert.rejects(
      fixture.connectionRepository.save({
        ...durableUnknown,
        binding,
        receipts: durableUnknown.receipts.map((receipt) =>
          receipt.effectId === branch.effectId
            ? { ...receipt, committedAt: new Date(NOW.getTime() + 1_000).toISOString() }
            : receipt
        ),
      }, expectedRevision),
      /receipt.*berubah.*rekonsiliasi unknown/iu,
    );
    await assert.rejects(
      fixture.broker.reconcileDurableUnknown({
        ...reference,
        effectDigest: "f".repeat(64),
      }),
      /locator.*tidak cocok/iu,
    );
    assert.equal(fixture.transport.reconciliations, 1);
  });

  it("mengamati effect lama setelah installation dicabut tanpa memberi authority publish baru", async () => {
    const fixture = await createFixture();
    const branch = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    fixture.transport.failBranchBeforeEffect = true;
    await fixture.broker.createBranch(
      fixture.scope,
      branch,
      await approveEffect(fixture, branch),
    );
    const [reference] = (await fixture.connectionRepository.listUnknownEffects({
      cursor: null,
      limit: 10,
    })).references;
    assert.ok(reference);

    const installation = await fixture.connectionRepository.loadInstallation(
      "installation-connection-1",
    );
    assert.ok(installation);
    const { revision, ...record } = installation;
    const revoked = await fixture.connectionRepository.saveInstallation({
      ...record,
      status: "revoked",
      revocationAuthorityId: "revoke-confirmation-after-send",
      revokedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    }, revision);
    assert.equal(revoked.status, "saved");

    fixture.transport.failBranchBeforeEffect = false;
    fixture.transport.reconcileNotCommitted = true;
    assert.equal(
      await fixture.broker.reconcileDurableUnknown(reference),
      "not_committed",
    );
    await assert.rejects(
      fixture.broker.prepareEffect(fixture.scope, {
        runId: fixture.runId,
        capability: "github.branch.create",
      }),
      /installation\/selection authority|dicabut/iu,
    );
    assert.equal(fixture.transport.branches.length, 1);
    assert.equal(fixture.transport.reconciliations, 1);
  });

  it("menolak field asing dan target ref yang bergerak tanpa force", async () => {
    const fixture = await createFixture();
    const effect = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    await assert.rejects(
      approveEffect(
        fixture,
        { ...effect, force: true, credential: "TOKEN_SENTINEL" } as GitHubExactEffect,
      ),
      /field asing|schema/iu,
    );
    const approval = await approveEffect(fixture, effect);
    fixture.transport.targetHeads.set(effect.branch, "c".repeat(40));
    await assert.rejects(
      fixture.broker.createBranch(fixture.scope, effect, approval),
      /target branch|non-force/iu,
    );
    assert.equal(fixture.transport.branches.length, 0);

    fixture.transport.targetHeads.delete(effect.branch);
    fixture.transport.resultEffectIdOverride = "github-effect-wrong-id";
    const ambiguous = await fixture.broker.createBranch(
      fixture.scope,
      effect,
      approval,
    );
    assert.equal(ambiguous.status, "unknown");
    fixture.transport.resultEffectIdOverride = null;
    fixture.transport.resultFenceOverride = false;
    await assert.rejects(
      fixture.broker.reconcileUnknown(fixture.scope, effect),
      /fence.*tidak cocok/iu,
    );
    fixture.transport.resultFenceOverride = null;
    assert.equal(
      (await fixture.broker.reconcileUnknown(fixture.scope, effect)).status,
      "committed",
    );
  });

  it("mengikat approval ke confirmation tepercaya tanpa menyimpan proof", async () => {
    const fixture = await createFixture();
    const effect = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    const grant = fixture.confirmations.issue(fixture.scope, effect);
    await assert.rejects(
      fixture.broker.approve(fixture.scope, effect, {
        ...grant,
        audience: "group",
      } as unknown as GitHubConfirmationGrant),
      /workspace-private|audience/iu,
    );
    await assert.rejects(
      fixture.broker.approve(fixture.scope, effect, {
        ...grant,
        interactionId: "another-private-interaction",
      }),
      /confirmation pengguna|tidak sah/iu,
    );
    await assert.rejects(
      fixture.broker.approve(fixture.scope, effect, {
        ...grant,
        proof: "forged-controller-proof",
      }),
      /confirmation pengguna|tidak sah/iu,
    );
    const approval = await fixture.broker.approve(fixture.scope, effect, grant);
    await assert.rejects(
      fixture.broker.approve(fixture.scope, effect, {
        ...grant,
        proof: "forged-after-mint-proof",
      }),
      /confirmation pengguna|tidak sah/iu,
    );
    const replayed = await fixture.broker.approve(fixture.scope, effect, grant);
    assert.deepEqual(replayed, approval);
    const metadata = await readFile(fixture.connectionFile, "utf8");
    assert.equal(metadata.includes(grant.proof), false);
    assert.equal(metadata.includes(grant.confirmationId), true);

    await fixture.broker.createBranch(fixture.scope, effect, approval);
    const push = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.push_branch",
    });
    await assert.rejects(
      fixture.broker.approve(fixture.scope, push, grant),
      /binding berbeda|confirmation pengguna.*tidak sah/iu,
    );

    const tampered = JSON.parse(metadata) as {
      connections: Array<{ approvals: Array<Record<string, unknown>> }>;
    };
    tampered.connections[0]!.approvals[0]!.proof = grant.proof;
    await writeFile(fixture.connectionFile, JSON.stringify(tampered), "utf8");
    await assert.rejects(
      new FileGitHubConnectionRepository(fixture.connectionFile)
        .loadByProject(fixture.project.id),
      /field asing|schema metadata/iu,
    );
  });

  it("memerlukan capability dan approval terpisah untuk perubahan workflow", async () => {
    const fixture = await createFixture({ workflowChange: true });
    await assert.rejects(
      fixture.broker.prepareEffect(fixture.scope, {
        runId: fixture.runId,
        capability: "github.push_branch",
      }),
      /workflow.*approval|workflow.*terpisah/iu,
    );
    const branch = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    await fixture.broker.createBranch(
      fixture.scope,
      branch,
      await approveEffect(fixture, branch),
    );
    const workflow = await fixture.broker.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.workflow.write",
    });
    fixture.transport.canWriteWorkflows = false;
    await assert.rejects(
      approveEffect(fixture, workflow),
      /authority GitHub App|remote base/iu,
    );
    fixture.transport.canWriteWorkflows = true;
    await assert.rejects(
      fixture.broker.pushBranch(
        fixture.scope,
        workflow,
        await approveEffect(fixture, workflow),
      ),
      /capability.*tidak cocok/iu,
    );
    const receipt = await fixture.broker.pushWorkflowChanges(
      fixture.scope,
      workflow,
      await approveEffect(fixture, workflow),
    );
    assert.equal(receipt.status, "committed");
    assert.equal(receipt.capability, "github.workflow.write");
    assert.equal(fixture.transport.pushes.at(-1)?.capability, "github.workflow.write");
  });

  it("watchdog melepaskan antrean GitHub/local-git dan mempertahankan efek ambigu", async () => {
    const fixture = await createFixture();
    const watched = new GitHubBroker(
      new FileGitHubConnectionRepository(fixture.connectionFile),
      fixture.transport,
      fixture.confirmations,
      fixture.authority,
      fixture.projects,
      fixture.codingRepository,
      fixture.localGitTransport,
      () => NOW,
      fixture.ids,
      { transportTimeoutMs: 5 },
    );
    const effect = await watched.prepareEffect(fixture.scope, {
      runId: fixture.runId,
      capability: "github.branch.create",
    });
    const approval = await approveEffect(fixture, effect, watched);
    fixture.transport.hangCreateBranch = true;
    const receipt = await watched.createBranch(fixture.scope, effect, approval);
    assert.equal(receipt.status, "unknown");
    assert.equal(fixture.transport.abortObserved, true);
    assert.equal(fixture.transport.branches.length, 1);
    const replay = await watched.createBranch(fixture.scope, effect, approval);
    assert.deepEqual(replay, receipt);
    assert.equal(fixture.transport.branches.length, 1);

    const local = new LocalGitService(
      fixture.projects,
      fixture.localGitTransport,
      fixture.authority,
      { transportTimeoutMs: 100 },
    );
    fixture.localGitTransport.hangStatus = true;
    await assert.rejects(
      local.status(fixture.scope, fixture.project.id, fixture.project.revision),
      /watchdog timeout/iu,
    );
    assert.equal(fixture.localGitTransport.abortObserved, true);
    fixture.localGitTransport.hangStatus = false;
    assert.equal(
      (await local.status(fixture.scope, fixture.project.id, fixture.project.revision)).clean,
      true,
    );
  });

  it("menolak rekonsiliasi local-git dengan operation id atau fence palsu", async () => {
    await assert.rejects(
      createFixture({ localReconciliationFault: "wrong-id" }),
      /exact operation fence/iu,
    );
    await assert.rejects(
      createFixture({ localReconciliationFault: "wrong-fence" }),
      /exact operation fence/iu,
    );
  });
});

async function createFixture(
  options: {
    workflowChange?: boolean;
    localReconciliationFault?: "wrong-id" | "wrong-fence";
    skipLocalSnapshotConsumption?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "harvy-github-broker-"));
  let sequence = 0;
  const ids = () => `id-${sequence += 1}`;
  const authority = new WorkspaceAuthorityService(
    new FileWorkspaceRepository(join(root, "authority.json")),
    () => NOW,
    ids,
  );
  const owner = workspacePrincipal(SECRET, "telegram", "owner");
  const workspace = await authority.createWorkspace("GitHub", owner);
  const projectRepository = new FileProjectWorkspaceRepository(join(root, "projects.json"));
  const projects = new ProjectWorkspaceService(
    projectRepository,
    authority,
    { root: join(root, "project-data") },
    undefined,
    () => NOW,
    ids,
    {
      async isProjectSelectionBound(binding) {
        return binding.selectionId === "repository-selection-1" &&
          binding.bindingId === "github-binding-repository-selection-1";
      },
    },
  );
  const repositoryArchive = buildZip([
    { name: "student-project-deadbeef/", content: "" },
    { name: "student-project-deadbeef/src/", content: "" },
    { name: "student-project-deadbeef/src/index.ts", content: "export const value = 1;\n" },
    ...(options.workflowChange
      ? [
          { name: "student-project-deadbeef/.github/", content: "" },
          { name: "student-project-deadbeef/.github/workflows/", content: "" },
          {
            name: "student-project-deadbeef/.github/workflows/ci.yml",
            content: "name: CI\non: [push]\njobs: {}\n",
          },
        ]
      : []),
  ]);
  const installationConnectionId = "installation-connection-1";
  const repositorySelectionId = "repository-selection-1";
  const bindingId = "github-binding-repository-selection-1";
  let project = await projects.createFromGitHubSelection(workspace.scope, {
    selectionId: repositorySelectionId,
    installationConnectionId,
    repositoryId: "repo-1",
    installationId: "installation-1",
    archiveSha256: createHash("sha256").update(repositoryArchive).digest("hex"),
    archive: repositoryArchive,
    git: { baseCommit: BASE, headCommit: BASE, branch: "main" },
  });
  // The broker fixture seeds the exact binding ledger later in this setup; the
  // project must model the resulting bound visibility before coding starts.
  project = await projects.activateGitHubSelectionProject(
    workspace.scope,
    repositorySelectionId,
    bindingId,
  );
  const localGitTransport = new FakeLocalGitTransport();
  localGitTransport.reconciliationFault = options.localReconciliationFault ?? null;
  localGitTransport.skipSnapshotConsumption = options.skipLocalSnapshotConsumption ?? false;
  const localGit = new LocalGitService(
    projects,
    localGitTransport,
    authority,
  );
  const freshGitStatus = await localGit.status(
    workspace.scope,
    project.id,
    project.revision,
  );
  if (!freshGitStatus.clean) throw new Error("Fresh local git fixture harus clean.");
  const codingRepository = new FileCodingRunRepository(join(root, "coding.json"));
  const sandbox = new PassingSandbox();
  const policy: CodingValidatorPolicy = {
    taskReviewer: { id: "test-task-reviewer", version: "1" },
    async commandsFor() {
      return [{
        kind: "test",
        argv: ["npm", "test"],
        cwd: ".",
        purpose: "test",
        timeoutMs: 30_000,
        required: true,
      }];
    },
    async reviewTask(input) {
      await input.workspace.read({ path: "src/index.ts" });
      return {
        decision: "approved" as const,
        requirementEvidence: input.requirements.map((requirement) => ({
          requirementDigest: requirement.digest,
          status: "evidenced" as const,
          evidenceRefs: [input.availableEvidenceRefs[0]!],
        })),
        publicApi: "preserved" as const,
        unrelatedChanges: "minimized" as const,
      };
    },
  };
  const engine = new CodingRunEngine(
    codingRepository,
    projects,
    sandbox,
    policy,
    { evidenceStore: new FileCodingEvidenceStore(join(root, "evidence")) },
    () => NOW,
    ids,
  );
  const run = await engine.start(
    workspace.scope,
    project.id,
    project.revision,
    {
    request: "Fix value",
    objective: "Value menjadi 2",
    acceptanceCriteria: ["Test lulus"],
    initialConstraints: [],
    },
  );
  await engine.markMapped(workspace.scope, run.runId, 0);
  await engine.recordPlan(workspace.scope, run.runId, 0, {
    steps: [
      { stage: "inspect", description: "Inspect repository", paths: ["src"] },
      { stage: "edit", description: "Update requested value", paths: ["src/index.ts"] },
      { stage: "test", description: "Run required test", paths: [] },
      { stage: "review", description: "Review exact diff", paths: [] },
    ],
  });
  const tools = await engine.writerTools(workspace.scope, run.runId);
  const patchPath = options.workflowChange
    ? ".github/workflows/ci.yml"
    : "src/index.ts";
  const before = await tools.read(0, { path: patchPath });
  await engine.applyPatch(workspace.scope, run.runId, 0, [{
    kind: "update",
    path: patchPath,
    expectedSha256: before.sha256,
    content: options.workflowChange
      ? "name: CI\non: [push, pull_request]\njobs: {}\n"
      : "export const value = 2;\n",
  }]);
  await engine.runValidator(workspace.scope, run.runId, 0, "test");
  await engine.runTaskReview(workspace.scope, run.runId, 0);
  const completed = await engine.finalize(workspace.scope, run.runId, 0);
  await localGit.commit(
    workspace.scope,
    project.id,
    completed.result!.projectRevision,
  );
    project = (await projectRepository.load(project.id))!;

  const transport = new FakeGitHubTransport();
  const confirmations = new FakeGitHubConfirmationAuthority();
  const connectionFile = join(root, "github-connections.json");
  const connectionRepository = new FileGitHubConnectionRepository(connectionFile);
  const installation = await connectionRepository.createInstallation({
    version: 1,
    connectionId: installationConnectionId,
    ownerWorkspaceKey: workspace.scope.workspaceKey,
    sessionId: "installation-session-1",
    confirmationId: "installation-confirmation-1",
    requestedByMembershipId: workspace.scope.membershipId,
    requestedAclEpoch: workspace.scope.aclEpoch,
    status: "pending",
    installationId: null,
    revocationAuthorityId: null,
    revision: 1,
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    activatedAt: null,
    revokedAt: null,
    updatedAt: NOW.toISOString(),
  });
  assert.equal(installation.status, "saved");
  if (installation.status !== "saved") throw new Error("installation fixture conflict");
  const activeInstallation = await connectionRepository.saveInstallation({
    ...withoutInstallationRevision(installation.connection),
    status: "active",
    installationId: "installation-1",
    activatedAt: NOW.toISOString(),
  }, 1);
  assert.equal(activeInstallation.status, "saved");
  const selected = await connectionRepository.createSelection({
    version: 1,
    selectionId: repositorySelectionId,
    confirmationId: "selection-confirmation-1",
    ownerWorkspaceKey: workspace.scope.workspaceKey,
    installationConnectionId,
    installationId: "installation-1",
    repositoryId: "repo-1",
    repositoryFullName: "student/repo",
    visibility: "private",
    defaultBranch: "main",
    baseCommit: BASE,
    bootstrapAttempts: [],
    selectedByMembershipId: workspace.scope.membershipId,
    selectedAclEpoch: workspace.scope.aclEpoch,
    status: "selected",
    archive: null,
    projectId: null,
    bindingId: null,
    revision: 1,
    selectedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    updatedAt: NOW.toISOString(),
  });
  assert.equal(selected.status, "saved");
  if (selected.status !== "saved") throw new Error("selection fixture conflict");
  const archiveReady = await connectionRepository.saveSelection({
    ...withoutSelectionRevision(selected.selection),
    status: "archive_ready",
    archive: {
      version: 1,
      operationId: repositorySelectionId,
      archiveId: "archive-repository-selection-1",
      ownerWorkspaceKey: workspace.scope.workspaceKey,
      installationId: "installation-1",
      repositoryId: "repo-1",
      repositoryFullName: "student/repo",
      defaultBranch: "main",
      commit: BASE,
      mediaType: "application/zip",
      sha256: createHash("sha256").update(repositoryArchive).digest("hex"),
      size: repositoryArchive.byteLength,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    },
  }, 1);
  assert.equal(archiveReady.status, "saved");
  if (archiveReady.status !== "saved") throw new Error("archive fixture conflict");
  const projectCreated = await connectionRepository.saveSelection({
    ...withoutSelectionRevision(archiveReady.selection),
    status: "project_created",
    projectId: project.id,
  }, 2);
  assert.equal(projectCreated.status, "saved");
  if (projectCreated.status !== "saved") throw new Error("project fixture conflict");
  const bound = await connectionRepository.bindSelection({
    version: 1,
    binding: {
      bindingId,
      projectId: project.id,
      ownerWorkspaceKey: workspace.scope.workspaceKey,
      installationConnectionId,
      repositorySelectionId,
      installationId: "installation-1",
      repositoryId: "repo-1",
      repositoryFullName: "student/repo",
      visibility: "private",
      defaultBranch: "main",
      revision: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      revokedAt: null,
    },
    approvals: [],
    receipts: [],
  }, repositorySelectionId, 3, NOW.toISOString());
  assert.equal(bound.status, "saved");
  const broker = new GitHubBroker(
    connectionRepository,
    transport,
    confirmations,
    authority,
    projects,
    codingRepository,
    localGitTransport,
    () => NOW,
    ids,
  );
  return {
    root,
    ids,
    owner,
    authority,
    scope: workspace.scope,
    project,
    projects,
    codingRepository,
    engine,
    projectRepository,
    runId: run.runId,
    transport,
    confirmations,
    broker,
    connectionFile,
    connectionRepository,
    localGit,
    localGitTransport,
  };
}

class FakeGitHubConfirmationAuthority implements GitHubConfirmationAuthority {
  private sequence = 0;
  private readonly grants = new Map<
    string,
    { grant: GitHubConfirmationGrant; binding: GitHubConfirmationBinding }
  >();

  issue(
    scope: WorkspaceAgentScope,
    effect: GitHubExactEffect,
  ): GitHubConfirmationGrant {
    this.sequence += 1;
    const grant: GitHubConfirmationGrant = {
      confirmationId: `confirmation-${this.sequence}`,
      interactionId: `private-interaction-${this.sequence}`,
      audience: "workspace-private",
      proof: `opaque-confirmation-proof-${this.sequence}`,
      expiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    };
    this.grants.set(grant.proof, {
      grant,
      binding: {
        effectId: effect.effectId,
        effectDigest: effectDigest(effect),
        capability: effect.capability,
        interactionId: grant.interactionId,
        audience: "workspace-private",
        ownerWorkspaceKey: scope.workspaceKey,
        membershipId: scope.membershipId,
        aclEpoch: scope.aclEpoch,
      },
    });
    return structuredClone(grant);
  }

  async verify(
    grant: GitHubConfirmationGrant,
    binding: GitHubConfirmationBinding,
  ): Promise<boolean> {
    const expected = this.grants.get(grant.proof);
    return Boolean(
      expected &&
        JSON.stringify(expected.grant) === JSON.stringify(grant) &&
        JSON.stringify(expected.binding) === JSON.stringify(binding) &&
        Date.parse(grant.expiresAt) > NOW.getTime(),
    );
  }
}

interface ApprovalFixture {
  broker: GitHubBroker;
  scope: WorkspaceAgentScope;
  confirmations: FakeGitHubConfirmationAuthority;
}

async function approveEffect(
  fixture: ApprovalFixture,
  effect: GitHubExactEffect,
  broker: GitHubBroker = fixture.broker,
) {
  return await broker.approve(
    fixture.scope,
    effect,
    fixture.confirmations.issue(fixture.scope, effect),
  );
}

class FakeGitHubTransport implements GitHubBrokerTransport {
  baseCommit = BASE;
  failPush = false;
  failPushBeforeEffect = false;
  failBranchBeforeEffect = false;
  skipBundleConsumption = false;
  reconcileNotCommitted = false;
  hangCreateBranch = false;
  abortObserved = false;
  canWriteWorkflows = true;
  resultEffectIdOverride: string | null = null;
  resultFenceOverride: boolean | null = null;
  repositoryAccessStarted: (() => void) | null = null;
  repositoryAccessGate: Promise<void> | null = null;
  branches: GitHubExactEffect[] = [];
  pushes: GitHubExactEffect[] = [];
  pushedBundleSha256: string[] = [];
  pullRequests: GitHubExactEffect[] = [];
  reconciliations = 0;
  readonly targetHeads = new Map<string, string>();

  async health() {
    return {
      available: true,
      protocol: "harvy-github-broker/1" as const,
      checkedAt: NOW.toISOString(),
      reason: null,
    };
  }
  async repositoryAccess(
    ownerWorkspaceKey: string,
    _installationId: string,
    _repositoryId: string,
    targetBranch: string | null,
  ): Promise<GitHubRepositoryAccess> {
    this.repositoryAccessStarted?.();
    if (this.repositoryAccessGate) await this.repositoryAccessGate;
    return {
      ownerWorkspaceKey,
      installationId: "installation-1",
      repositoryId: "repo-1",
      repositoryFullName: "student/repo",
      visibility: "private",
      defaultBranch: "main",
      baseCommit: this.baseCommit,
      empty: false,
      targetBranch,
      targetBranchHead: targetBranch ? this.targetHeads.get(targetBranch) ?? null : null,
      canRead: true,
      canPush: true,
      canWriteWorkflows: this.canWriteWorkflows,
      canCreatePullRequest: true,
    };
  }

  async bootstrapRepository(
    _effect: GitHubRepositoryBootstrapEffect,
  ): Promise<GitHubBrokerTransportResult> {
    throw new Error("bootstrap repository tidak dipakai fixture publish");
  }

  async createBranch(
    effect: GitHubExactEffect,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    this.branches.push(structuredClone(effect));
    if (this.failBranchBeforeEffect) throw new Error("safe failure before effect");
    if (this.hangCreateBranch) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          this.abortObserved = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    }
    this.targetHeads.set(effect.branch, effect.baseCommit);
    return this.maybeMalformed(committed(effect, "1"));
  }

  async pushExactCommit(
    effect: GitHubExactEffect,
    objectBundle: AsyncIterable<Uint8Array>,
  ): Promise<GitHubBrokerTransportResult> {
    this.pushes.push(structuredClone(effect));
    if (this.failPushBeforeEffect) throw new Error("safe failure before effect");
    if (!effect.objectBundle) throw new Error("missing object bundle descriptor");
    if (this.skipBundleConsumption) {
      this.targetHeads.set(effect.branch, effect.commit);
      return this.maybeMalformed(committed(effect, "2"));
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const value of objectBundle) {
      size += value.byteLength;
      hash.update(value);
    }
    const digest = hash.digest("hex");
    if (size !== effect.objectBundle.size || digest !== effect.objectBundle.sha256) {
      throw new Error("tampered object bundle");
    }
    this.pushedBundleSha256.push(digest);
    this.targetHeads.set(effect.branch, effect.commit);
    if (this.failPush) throw new Error("ambiguous network failure");
    return this.maybeMalformed(committed(effect, "2"));
  }

  async createDraftPullRequest(
    effect: GitHubExactEffect,
  ): Promise<GitHubBrokerTransportResult> {
    this.pullRequests.push(structuredClone(effect));
    return this.maybeMalformed({
      ...committed(effect, "3"),
      url: "https://github.com/student/repo/pull/1",
    });
  }

  async reconcileEffect(effect: GitHubExactEffect): Promise<GitHubBrokerTransportResult> {
    this.reconciliations += 1;
    if (this.reconcileNotCommitted) {
      return this.maybeMalformed({
        effectId: effect.effectId,
        status: "not_committed",
        operationFenced: true,
        externalId: null,
        url: null,
        completedAt: NOW.toISOString(),
      });
    }
    const head = this.targetHeads.get(effect.branch) ?? null;
    if (
      (effect.capability === "github.branch.create" && head === effect.baseCommit) ||
      ((effect.capability === "github.push_branch" ||
        effect.capability === "github.workflow.write") && head === effect.commit) ||
      (effect.capability === "github.pr.create" &&
        this.pullRequests.some((candidate) => candidate.effectId === effect.effectId))
    ) {
      return this.maybeMalformed(committed(effect, "4"));
    }
    return this.maybeMalformed({
      effectId: effect.effectId,
      status: "unknown",
      operationFenced: false,
      externalId: null,
      url: null,
      completedAt: NOW.toISOString(),
    });
  }

  private maybeMalformed(
    result: GitHubBrokerTransportResult,
  ): GitHubBrokerTransportResult {
    return {
      ...result,
      effectId: this.resultEffectIdOverride ?? result.effectId,
      operationFenced: this.resultFenceOverride ?? result.operationFenced,
    } as GitHubBrokerTransportResult;
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeLocalGitTransport implements LocalGitTransport {
  private readonly commits = new Map<string, LocalGitCommitResult>();
  private readonly bundles = new Map<string, Uint8Array>();
  hangStatus = false;
  abortObserved = false;
  skipSnapshotConsumption = false;
  lastInputSnapshot: SandboxInputSnapshotDescriptor | null = null;
  consumedSnapshotSha256: string[] = [];
  reconciliationFault: "wrong-id" | "wrong-fence" | null = null;
  async health() {
    return {
      available: true,
      protocol: "harvy-local-git/1" as const,
      checkedAt: NOW.toISOString(),
      reason: null,
    };
  }

  async prepare(
    binding: LocalGitBinding,
    snapshot: SandboxInputSnapshotDescriptor,
    content: AsyncIterable<Uint8Array>,
  ): Promise<{ binding: LocalGitBinding }> {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of content) {
      size += chunk.byteLength;
      hash.update(chunk);
    }
    if (size !== snapshot.size || hash.digest("hex") !== snapshot.bundleSha256) {
      throw new Error("prepare snapshot local git rusak");
    }
    return { binding: structuredClone(binding) };
  }
  async status(
    binding: LocalGitBinding,
    signal?: AbortSignal,
  ): Promise<LocalGitStatus> {
    if (this.hangStatus) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          this.abortObserved = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
    }
    return { binding, changedPaths: [], clean: true };
  }
  async diff(binding: LocalGitBinding) {
    return { binding, textArtifactId: "git-diff", sha256: "e".repeat(64) };
  }
  async log(binding: LocalGitBinding, _limit: number) {
    return { binding, entries: [] as LocalGitLogEntry[] };
  }
  async reconcileCommit(
    request: LocalGitCommitRequest,
  ): Promise<LocalGitCommitReconciliation> {
    const receipt = this.commits.get(request.operationId);
    if (!receipt && this.reconciliationFault === "wrong-id") {
      return {
        operationId: "local-git-wrong-operation",
        status: "not_committed",
        operationFenced: true,
      };
    }
    if (!receipt && this.reconciliationFault === "wrong-fence") {
      return {
        operationId: request.operationId,
        status: "not_committed",
        operationFenced: false,
      } as unknown as LocalGitCommitReconciliation;
    }
    return receipt
      ? {
          operationId: request.operationId,
          status: "committed" as const,
          operationFenced: true as const,
          receipt,
        }
      : {
          operationId: request.operationId,
          status: "not_committed" as const,
          operationFenced: true as const,
        };
  }
  async commit(
    request: LocalGitCommitRequest,
    snapshot: SandboxInputSnapshotDescriptor,
    content: AsyncIterable<Uint8Array>,
  ): Promise<LocalGitCommitResult> {
    this.lastInputSnapshot = structuredClone(snapshot);
    if (!this.skipSnapshotConsumption) {
      const snapshotHash = createHash("sha256");
      let snapshotSize = 0;
      for await (const value of content) {
        snapshotSize += value.byteLength;
        snapshotHash.update(value);
      }
      const snapshotDigest = snapshotHash.digest("hex");
      if (snapshotSize !== snapshot.size || snapshotDigest !== snapshot.bundleSha256) {
        throw new Error("snapshot bundle local git rusak");
      }
      this.consumedSnapshotSha256.push(snapshotDigest);
    }
    const treeHash = "f".repeat(40);
    const commit = request.binding.headCommit === COMMIT ? "9".repeat(40) : COMMIT;
    const bundleBytes = Buffer.from(
      `# v2 git bundle\n-${request.binding.headCommit} parent\n${commit} refs/heads/${request.targetBranch}\n\n${treeHash}\n`,
      "utf8",
    );
    const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
    const objectBundle: LocalGitObjectBundleReference = {
      version: 1,
      artifactId: `git-bundle-${bundleSha256}`,
      sha256: bundleSha256,
      size: bundleBytes.byteLength,
      mediaType: "application/vnd.git.bundle",
      commit,
      parentCommit: request.binding.headCommit,
      treeHash,
    };
    const result: LocalGitCommitResult = {
      operationId: request.operationId,
      projectId: request.binding.projectId,
      snapshotId: request.binding.snapshotId,
      sourceWorkspaceRevision: request.binding.workspaceRevision,
      branch: request.targetBranch,
      parentCommit: request.binding.headCommit,
      commit,
      treeHash,
      objectBundle,
      authorName: "Harvy Bot",
      authorEmail: "bot@harvy.local",
      committedAt: NOW.toISOString(),
    };
    if (!this.skipSnapshotConsumption) {
      this.bundles.set(objectBundle.artifactId, bundleBytes);
      this.commits.set(request.operationId, result);
    }
    return result;
  }

  openObjectBundle(
    reference: LocalGitObjectBundleReference,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const bytes = this.bundles.get(reference.artifactId);
    return (async function* (): AsyncGenerator<Uint8Array> {
      if (signal?.aborted) throw new Error("aborted");
      if (!bytes) throw new Error("object bundle tidak ditemukan");
      yield bytes;
    })();
  }
}

class PassingSandbox implements SandboxRunner {
  private sequence = 0;
  async health(): Promise<SandboxHealth> {
    return {
      available: true,
      runtime: "isolated-linux",
      identity: sandboxIdentity(),
      checkedAt: NOW.toISOString(),
      reason: null,
    };
  }
  async allocate(binding: SandboxLease["binding"]): Promise<SandboxLease> {
    return {
      leaseId: `lease-${this.sequence += 1}`,
      binding,
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
        limits: {
          cpuCores: 1,
          memoryBytes: 1_000_000,
          diskBytes: 1_000_000,
          pids: 32,
          wallClockMs: 60_000,
          maxOutputBytes: 1_000,
          maxArtifacts: 2,
          maxArtifactBytes: 1_000,
        },
      },
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
  }
  async execute(lease: SandboxLease, _request: SandboxExecRequest): Promise<SandboxExecResult> {
    return {
      operationId: `operation-${this.sequence}`,
      requestDigest: "d".repeat(64),
      executionId: `exec-${this.sequence}`,
      leaseId: lease.leaseId,
      status: "exited",
      exitCode: 0,
      signal: null,
      stdout: "pass",
      stderr: "",
      truncated: false,
      artifacts: [],
      usage: { wallClockMs: 1, peakMemoryBytes: 100, cpuTimeMs: 1, outputBytes: 4 },
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
    };
  }
  async captureSnapshot(lease: SandboxLease): Promise<SandboxSnapshotResult> {
    return {
      leaseId: lease.leaseId,
      sourceWorkspaceRevision: lease.binding.workspaceRevision,
      snapshot: {
        artifactId: "snapshot",
        sha256: lease.binding.snapshotId,
        size: 0,
        mediaType: "application/octet-stream",
        purpose: "workspace-snapshot",
      },
      createdAt: NOW.toISOString(),
    };
  }
  async readArtifact(
    _lease: SandboxLease,
    _artifact: SandboxArtifactReference,
  ): Promise<Uint8Array> {
    throw new Error("Fake GitHub sandbox tidak menyimpan artifact bytes.");
  }
  async dispose(_lease: SandboxLease): Promise<void> {}
  async fenceProjectRuns(): Promise<void> {}
}

function withoutSelectionRevision(
  selection: GitHubRepositorySelection,
): Omit<GitHubRepositorySelection, "revision"> {
  const { revision: _revision, ...rest } = selection;
  return rest;
}

function withoutInstallationRevision(
  connection: GitHubInstallationConnection,
): Omit<GitHubInstallationConnection, "revision"> {
  const { revision: _revision, ...rest } = connection;
  return rest;
}

function committed(
  effect: GitHubExactEffect,
  externalId: string,
): Extract<GitHubBrokerTransportResult, { status: "committed" }> {
  return {
    effectId: effect.effectId,
    status: "committed",
    operationFenced: true,
    externalId,
    url: null,
    completedAt: NOW.toISOString(),
  };
}

function effectWithAttempt(
  effect: GitHubExactEffect,
  attempt: number,
): GitHubExactEffect {
  const { effectId: _effectId, ...previous } = effect;
  const semantic = { ...previous, attempt };
  const effectId = `github-effect-${createHash("sha256")
    .update(canonicalJsonForTest(semantic), "utf8")
    .digest("hex")}`;
  return { effectId, ...semantic };
}

function canonicalJsonForTest(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonForTest).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJsonForTest(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
