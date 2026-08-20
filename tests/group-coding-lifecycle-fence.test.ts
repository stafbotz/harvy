import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { GroupCodingLifecycleFenceService } from
  "../src/core/group-coding-lifecycle-fence.js";
import type { CodingRun } from "../src/domain/coding-run.js";
import { groupScopeKey } from "../src/domain/group.js";
import { FileGroupCodingRepository } from
  "../src/storage/file-group-coding-repository.js";

const NOW = new Date("2026-08-15T11:00:00.000Z");
const GROUP = { channel: "whatsapp" as const, groupId: "lifecycle@g.us" };
const SCOPE_KEY = groupScopeKey(GROUP);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("GroupCodingLifecycleFenceService", () => {
  it("merevoke admission privat lalu membatalkan hanya run reference exact", async () => {
    const repository = await seededRepository();
    const runs = new Map([["coding-run-live", fakeRun("running")]]);
    const interrupted: string[] = [];
    const fenced: unknown[] = [];
    const reported: string[] = [];
    const service = new GroupCodingLifecycleFenceService(
      repository,
      { async load(runId) { return structuredClone(runs.get(runId) ?? null); } },
      {
        async interruptByBinding(workspaceKey, runId) {
          interrupted.push(`${workspaceKey}:${runId}`);
        },
      },
      {
        async cancelByAdmissionFence(input) {
          fenced.push(structuredClone(input));
          const cancelled = { ...fakeRun("cancelled"), completedAt: NOW.toISOString() };
          runs.set(input.runId, cancelled);
          return { run: cancelled, pendingCommit: false };
        },
      },
      { async report(run) { reported.push(run.runId); } },
      () => NOW,
    );

    assert.deepEqual(await service.fence({
      scopeKey: SCOPE_KEY,
      accountId: "account-live",
      cause: "group_disabled",
    }), {
      revokedLink: true,
      revokedRequests: 1,
      fencedRuns: 1,
      pendingCommitRunIds: [],
    });
    assert.equal(
      (await repository.loadLink(SCOPE_KEY, "account-live"))?.status,
      "revoked",
    );
    assert.equal(
      (await repository.loadLinkRequest("group-link-request-live"))?.status,
      "revoked",
    );
    assert.deepEqual(interrupted, ["workspace-private:coding-run-live"]);
    assert.deepEqual(fenced, [{
      version: 1,
      source: "group",
      cause: "group_disabled",
      runId: "coding-run-live",
      ownerWorkspaceKey: "workspace-private",
      projectId: "project-private",
      effectId: "group-effect-live",
      authorityRef: "group-link-live",
    }]);
    assert.deepEqual(reported, ["coding-run-live"]);

    assert.deepEqual(await service.fence({
      scopeKey: SCOPE_KEY,
      accountId: "account-live",
      cause: "group_disabled",
    }), {
      revokedLink: false,
      revokedRequests: 0,
      fencedRuns: 0,
      pendingCommitRunIds: [],
    });
  });

  it("tetap merevoke link tetapi fail closed saat commit outcome belum diketahui", async () => {
    const repository = await seededRepository();
    const pending = fakeRun("validating");
    pending.pendingCommit = {} as CodingRun["pendingCommit"];
    const service = new GroupCodingLifecycleFenceService(
      repository,
      { async load() { return structuredClone(pending); } },
      { async interruptByBinding() {} },
      {
        async cancelByAdmissionFence() {
          return { run: structuredClone(pending), pendingCommit: true };
        },
      },
      { async report() {} },
      () => NOW,
    );

    await assert.rejects(
      service.fence({
        scopeKey: SCOPE_KEY,
        accountId: "account-live",
        cause: "group_authority_changed",
      }),
      /pending commit|belum menutup/iu,
    );
    assert.equal(
      (await repository.loadLink(SCOPE_KEY, "account-live"))?.status,
      "revoked",
    );
  });
});

async function seededRepository(): Promise<FileGroupCodingRepository> {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-lifecycle-"));
  roots.push(root);
  const repository = new FileGroupCodingRepository(join(root, "group-coding.json"));
  assert.equal((await repository.saveLink({
    version: 1,
    linkId: "group-link-live",
    scopeKey: SCOPE_KEY,
    scope: GROUP,
    accountId: "account-live",
    groupJoinedAt: "2026-08-15T10:00:00.000Z",
    workspaceKey: "workspace-private",
    linkedByMembershipId: "membership-private",
    linkedByParticipantId: "admin@s.whatsapp.net",
    linkedAtAuthorityEpoch: 4,
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    revokedAt: null,
  }, null)).status, "saved");
  assert.equal((await repository.saveLinkRequest({
    version: 1,
    requestId: "group-link-request-live",
    scopeKey: SCOPE_KEY,
    scope: GROUP,
    accountId: "account-live",
    groupJoinedAt: "2026-08-15T10:00:00.000Z",
    participantPrincipal: {
      channel: "whatsapp",
      principalKey: "1".repeat(64),
    },
    requestedByParticipantId: "admin@s.whatsapp.net",
    requestedAtAuthorityEpoch: 4,
    status: "pending",
    workspaceKey: null,
    grantedMembershipId: null,
    approvedByMembershipId: null,
    approvedAclEpoch: null,
    createdAt: NOW.toISOString(),
    expiresAt: "2026-08-15T11:15:00.000Z",
    approvedAt: null,
    consumedAt: null,
    revokedAt: null,
    updatedAt: NOW.toISOString(),
  }, null)).status, "saved");
  assert.equal((await repository.saveRunReference({
    version: 1,
    referenceId: "group-reference-live",
    effectId: "group-effect-live",
    interactionDigest: "2".repeat(64),
    commandDigest: "3".repeat(64),
    runId: "coding-run-live",
    linkId: "group-link-live",
    linkStateRevision: 1,
    scopeKey: SCOPE_KEY,
    accountId: "account-live",
    groupJoinedAt: "2026-08-15T10:00:00.000Z",
    workspaceKey: "workspace-private",
    projectId: "project-private",
    initiatedByMembershipId: "membership-private",
    initiatedByPrincipalKey: "4".repeat(64),
    initiatedByParticipantId: "admin@s.whatsapp.net",
    createdAt: NOW.toISOString(),
  })).status, "saved");
  return repository;
}

function fakeRun(status: CodingRun["status"]): CodingRun {
  return {
    runId: "coding-run-live",
    status,
    pendingCommit: null,
  } as CodingRun;
}
