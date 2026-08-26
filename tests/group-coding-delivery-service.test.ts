import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  GroupCodingDeliveryService,
  GroupCodingDeliveryUnknownError,
} from "../src/core/group-coding-delivery-service.js";
import { GroupAgentRunDeliveryNotCommittedError } from
  "../src/core/group-agent-run-service.js";
import type { GroupCodingIngressTransport } from
  "../src/core/group-coding-ingress.js";
import type { GroupRuntimeBindingReader } from
  "../src/core/group-workspace-coding-controller.js";
import type { GroupBinding, GroupMessage, GroupScope } from "../src/domain/group.js";
import { groupScopeKey } from "../src/domain/group.js";
import type { GroupCodingDeliveryEffect } from "../src/domain/group-coding.js";
import type { CodingRun } from "../src/domain/coding-run.js";
import { FileGroupCodingRepository } from
  "../src/storage/file-group-coding-repository.js";

const NOW = new Date("2026-08-15T08:00:00.000Z");
const GROUP: GroupScope = { channel: "whatsapp", groupId: "coding@g.us" };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("GroupCodingDeliveryService", () => {
  it("commits one exact delivery and replays its receipt without a second send", async () => {
    const fixture = await createFixture();
    const first = await fixture.service.deliver(deliveryInput());
    const replay = await fixture.service.deliver(deliveryInput());

    assert.equal(first.status, "committed");
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.externalMessageId, first.externalMessageId);
    assert.equal(fixture.transport.calls, 1);
    assert.equal((await fixture.repository.listDeliveryEffects("committed")).length, 1);
  });

  it("records a proven pre-send denial and permits an explicit replay", async () => {
    const fixture = await createFixture();
    fixture.transport.failures.push(new GroupAgentRunDeliveryNotCommittedError());
    await assert.rejects(
      fixture.service.deliver(deliveryInput()),
      /ditolak sebelum socket|delivery/iu,
    );
    assert.equal((await fixture.repository.listDeliveryEffects())[0]?.status, "not_committed");

    const retried = await fixture.service.deliver(deliveryInput());
    assert.equal(retried.status, "committed");
    assert.equal(fixture.transport.calls, 2);
  });

  it("marks an ambiguous send unknown and never retries it silently", async () => {
    const fixture = await createFixture();
    fixture.transport.failures.push(new Error("socket closed after send"));
    await assert.rejects(
      fixture.service.deliver(deliveryInput()),
      GroupCodingDeliveryUnknownError,
    );
    assert.equal((await fixture.repository.listDeliveryEffects())[0]?.status, "unknown");

    await assert.rejects(
      fixture.service.deliver(deliveryInput()),
      GroupCodingDeliveryUnknownError,
    );
    assert.equal(fixture.transport.calls, 1);
  });

  it("closes crash-left prepared effects as unknown during startup recovery", async () => {
    const fixture = await createFixture();
    const prepared = preparedEffect();
    assert.equal(
      (await fixture.repository.saveDeliveryEffect(prepared, null)).status,
      "saved",
    );

    const report = await fixture.service.recoverPrepared();
    assert.deepEqual(report, { preparedFound: 1, closedUnknown: 1 });
    assert.equal(
      (await fixture.repository.loadDeliveryEffect(prepared.effectId))?.status,
      "unknown",
    );
    assert.equal(fixture.transport.calls, 0);
  });

  it("rejects replay after a remove/re-add generation changes", async () => {
    const fixture = await createFixture();
    await fixture.service.deliver(deliveryInput());
    fixture.bindings.current = {
      ...fixture.bindings.current,
      joinedAt: "2026-08-15T09:00:00.000Z",
    };
    await assert.rejects(
      fixture.service.deliver(deliveryInput()),
      /bertabrakan|exact/iu,
    );
    assert.equal(fixture.transport.calls, 1);
  });

  it("edits one durable group-safe anchor for progress and terminal state", async () => {
    const fixture = await createFixture();
    await seedRunAudience(fixture.repository);
    const initial = await fixture.service.deliver(deliveryInput());
    const running = codingRun();
    const progress = await fixture.service.deliverRunUpdate(running);
    const progressReplay = await fixture.service.deliverRunUpdate(running);
    assert.equal(progress.replayed, false);
    assert.equal(progressReplay.replayed, true);
    assert.equal(fixture.transport.editCalls, 1);
    assert.deepEqual(fixture.transport.editTargets, [initial.externalMessageId]);
    assert.equal(fixture.transport.editTexts[0]?.includes("src/private-auth.ts"), false);
    assert.equal(fixture.transport.editTexts[0]?.includes("workspace-private"), false);

    const completed: CodingRun = {
      ...running,
      status: "completed",
      phase: "completed",
      stateRevision: 2,
      result: {
        instructionRevision: 0,
        projectRevision: 2,
        snapshotId: "e".repeat(64),
        changedFiles: 1,
        validators: [],
        taskReview: null,
        completedAt: NOW.toISOString(),
      },
      completedAt: NOW.toISOString(),
    };
    await fixture.service.deliverRunUpdate(completed);
    assert.equal(fixture.transport.editCalls, 2);
    assert.deepEqual(fixture.transport.editTargets, [
      initial.externalMessageId,
      initial.externalMessageId,
    ]);
    const effects = await fixture.repository.listDeliveryEffects("committed");
    assert.equal(effects.filter((effect) => effect.mode === "send").length, 1);
    assert.equal(effects.filter((effect) => effect.mode === "edit").length, 2);
    assert.equal(effects.some((effect) => effect.purpose === "terminal_result"), true);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "harvy-group-coding-delivery-"));
  roots.push(root);
  const repository = new FileGroupCodingRepository(join(root, "group-coding.json"));
  const binding: GroupBinding = {
    scopeKey: groupScopeKey(GROUP),
    channel: "whatsapp",
    groupId: GROUP.groupId,
    accountId: "account-a",
    groupName: "Coding",
    joinedAt: "2026-08-15T07:00:00.000Z",
    noticeVersion: 10,
    noticeSentAt: "2026-08-15T07:01:00.000Z",
    disabledAt: null,
  };
  const bindings = new FakeBindings(binding);
  const transport = new FakeTransport();
  const service = new GroupCodingDeliveryService(
    repository,
    transport,
    async () => true,
    bindings,
    () => NOW,
  );
  return { root, repository, bindings, transport, service };
}

function deliveryInput() {
  return {
    message: message(),
    commandDigest: "a".repeat(64),
    purpose: "command_reply" as const,
    text: "Pekerjaan coding dimulai.",
    runId: "coding-run-1",
  };
}

function message(): GroupMessage {
  return {
    scope: GROUP,
    accountId: "account-a",
    messageId: "message-a",
    participantId: "owner@s.whatsapp.net",
    participantAliases: ["owner@lid"],
    participantName: "Owner",
    groupName: "Coding",
    text: "@Harvy coding: perbaiki bug",
    at: NOW.toISOString(),
    mentionsHarvy: true,
    repliesToHarvy: false,
    quotedMessageId: null,
    quotedParticipantId: null,
    isAdmin: true,
    authorityEpoch: 7,
    ingressRevision: 1,
  };
}

function preparedEffect(): Omit<GroupCodingDeliveryEffect, "stateRevision"> {
  return {
    version: 1,
    effectId: `group-coding-delivery-${"b".repeat(64)}`,
    commandDigest: "c".repeat(64),
    purpose: "command_reply",
    scopeKey: groupScopeKey(GROUP),
    scope: GROUP,
    accountId: "account-a",
    groupJoinedAt: "2026-08-15T07:00:00.000Z",
    runId: "coding-run-crash",
    sourceMessageId: "message-crash",
    quoteMessageId: "message-crash",
    mode: "send",
    targetMessageId: null,
    text: "Status coding aman untuk grup.",
    textDigest: sha256("Status coding aman untuk grup."),
    authority: {
      expectedAuthorityEpoch: 7,
      actors: [{
        participantIds: ["owner@s.whatsapp.net"],
        expectedRole: "admin",
      }],
    },
    status: "prepared",
    externalMessageId: null,
    preparedAt: NOW.toISOString(),
    settledAt: null,
  };
}

class FakeBindings implements GroupRuntimeBindingReader {
  constructor(public current: GroupBinding) {}

  async binding(scopeKey: string): Promise<GroupBinding | null> {
    return scopeKey === this.current.scopeKey ? structuredClone(this.current) : null;
  }
}

class FakeTransport implements GroupCodingIngressTransport {
  calls = 0;
  editCalls = 0;
  readonly editTargets: string[] = [];
  readonly editTexts: string[] = [];
  failures: Error[] = [];

  async sendGroupRunMessage(): Promise<{ messageId: string }> {
    this.calls += 1;
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { messageId: `external-${this.calls}` };
  }

  async editGroupRunMessage(
    _target: unknown,
    text: string,
    targetMessageId: string,
  ): Promise<{ messageId: string }> {
    this.editCalls += 1;
    this.editTargets.push(targetMessageId);
    this.editTexts.push(text);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { messageId: `external-edit-${this.editCalls}` };
  }
}

async function seedRunAudience(repository: FileGroupCodingRepository): Promise<void> {
  const saved = await repository.saveLink({
    version: 1,
    linkId: "link-group-coding-1",
    scopeKey: groupScopeKey(GROUP),
    scope: GROUP,
    accountId: "account-a",
    groupJoinedAt: "2026-08-15T07:00:00.000Z",
    workspaceKey: "workspace-private-key",
    linkedByMembershipId: "membership-owner",
    linkedByParticipantId: "owner@s.whatsapp.net",
    linkedAtAuthorityEpoch: 7,
    status: "active",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    revokedAt: null,
  }, null);
  assert.equal(saved.status, "saved");
  assert.equal((await repository.saveRunReference({
    version: 1,
    referenceId: "reference-group-coding-1",
    effectId: "run-effect-group-coding-1",
    interactionDigest: "1".repeat(64),
    commandDigest: "2".repeat(64),
    runId: "coding-run-1",
    linkId: "link-group-coding-1",
    linkStateRevision: saved.status === "saved" ? saved.link.stateRevision : 1,
    scopeKey: groupScopeKey(GROUP),
    accountId: "account-a",
    groupJoinedAt: "2026-08-15T07:00:00.000Z",
    workspaceKey: "workspace-private-key",
    projectId: "project-private-1",
    initiatedByMembershipId: "membership-owner",
    initiatedByPrincipalKey: "3".repeat(64),
    initiatedByParticipantId: "owner@s.whatsapp.net",
    createdAt: NOW.toISOString(),
  })).status, "saved");
}

function codingRun(): CodingRun {
  return {
    version: 2,
    runId: "coding-run-1",
    binding: {
      projectId: "project-private-1",
      ownerWorkspaceKey: "workspace-private-key",
      workspaceRevision: 1,
      baseSnapshot: "a".repeat(64),
    },
    taskBrief: {
      request: "private request",
      objective: "private objective",
      acceptanceCriteria: [],
      initialConstraints: [],
    },
    admission: {
      source: "group",
      effectId: "run-effect-group-coding-1",
      audience: "group-safe",
      authorityRef: "link-group-coding-1",
      interactionDigest: "1".repeat(64),
    },
    status: "running",
    phase: "editing",
    instructionRevision: 0,
    appliedInstructionRevision: 0,
    stateRevision: 1,
    workingCopyId: "working-copy-private",
    writer: {
      writerId: "writer-private",
      acquiredAt: NOW.toISOString(),
      expiresAt: "2026-08-15T09:00:00.000Z",
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
      workingSnapshot: "b".repeat(64),
      files: [{
        path: "src/private-auth.ts",
        status: "modified",
        beforeSha256: "c".repeat(64),
        afterSha256: "d".repeat(64),
        beforeSize: 1,
        afterSize: 2,
        binary: false,
      }],
      addedBytes: 1,
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
      activeElapsedMs: 10,
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
    expiresAt: "2026-08-16T08:00:00.000Z",
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
