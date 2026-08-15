import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  GroupAgentRunDeliveryError,
  GroupAgentRunService,
} from "../src/core/group-agent-run-service.js";
import type { GroupAuthorityResolver } from "../src/core/group-authority-policy.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from "../src/storage/file-group-agent-run-repository.js";

const TARGET_GROUP = "target-forget@g.us";
const OTHER_GROUP = "other-forget@g.us";
const TARGET_ACCOUNT = "wa-target";
const OTHER_ACCOUNT = "wa-other";
const TARGET_SCOPE_KEY = `whatsapp:${TARGET_GROUP}`;

const ALLOW_AUTHORITY: GroupAuthorityResolver = {
  resolveGroupAuthority: async () => ({
    role: "admin",
    authorityEpoch: 1,
  }),
};

describe("GroupAgentRun scope forgetting", () => {
  it("menghapus exact scope+account dan delivery terlambat tidak membangkitkan record", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-run-forget-"));
    const repository = new FileGroupAgentRunRepository(
      join(root, "group-agent-runs.json"),
    );
    const service = new GroupAgentRunService(repository, ALLOW_AUTHORITY);

    const oldTarget = await service.start({
      message: message({ messageId: "target-old-start" }),
    });
    const cancelledTarget = await service.routeMessage(message({
      messageId: "target-old-cancel",
      text: "batalkan pekerjaan ini",
    }));
    assert.equal(cancelledTarget.status, "cancelled");

    const otherAccount = await service.start({
      message: message({
        accountId: OTHER_ACCOUNT,
        messageId: "other-account-start",
      }),
    });
    const cancelledOtherAccount = await service.routeMessage(message({
      accountId: OTHER_ACCOUNT,
      messageId: "other-account-cancel",
      text: "batalkan pekerjaan ini",
    }));
    assert.equal(cancelledOtherAccount.status, "cancelled");

    const pendingTarget = await service.start({
      message: message({ messageId: "target-pending-start" }),
    });
    const otherScope = await service.start({
      message: message({
        scope: { channel: "whatsapp", groupId: OTHER_GROUP },
        messageId: "other-scope-start",
      }),
    });

    let releaseDelivery!: () => void;
    let deliveryEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      deliveryEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const lateCommit = service.commitAnchor(
      pendingTarget.run.runId,
      pendingTarget.run.stateRevision,
      "📌 Pekerjaan yang akan dilupakan",
      async () => {
        deliveryEntered();
        await blocked;
        return { messageId: "late-anchor-after-forget" };
      },
    );
    await entered;
    assert.equal(
      (await repository.load(pendingTarget.run.runId))?.pendingEffect?.purpose,
      "anchor",
    );

    assert.equal(
      await service.forgetScope(TARGET_SCOPE_KEY, TARGET_ACCOUNT),
      2,
    );
    assert.equal(await repository.load(oldTarget.run.runId), null);
    assert.equal(await repository.load(pendingTarget.run.runId), null);
    assert.notEqual(await repository.load(otherAccount.run.runId), null);
    assert.notEqual(await repository.load(otherScope.run.runId), null);
    assert.equal(
      await service.forgetScope(TARGET_SCOPE_KEY, TARGET_ACCOUNT),
      0,
    );

    releaseDelivery();
    await assert.rejects(lateCommit, GroupAgentRunDeliveryError);
    assert.equal(await repository.load(pendingTarget.run.runId), null);
    assert.notEqual(await repository.load(otherAccount.run.runId), null);
    assert.notEqual(await repository.load(otherScope.run.runId), null);
  });
});

function message(
  overrides: Partial<GroupMessage> = {},
): GroupMessage {
  const groupId = overrides.scope?.groupId ?? TARGET_GROUP;
  return {
    accountId: TARGET_ACCOUNT,
    messageId: "group-run-message",
    participantId: "participant-1@lid",
    participantAliases: ["628111111111@s.whatsapp.net"],
    participantName: "Ayu",
    groupName: "Kelompok",
    text: "Harvy, mulai pekerjaan ini",
    at: "2026-08-14T03:00:00.000Z",
    mentionsHarvy: true,
    repliesToHarvy: false,
    quotedMessageId: null,
    quotedParticipantId: null,
    isAdmin: true,
    authorityEpoch: 1,
    ingressRevision: 1,
    ...overrides,
    scope: overrides.scope ?? { channel: "whatsapp", groupId },
  };
}
