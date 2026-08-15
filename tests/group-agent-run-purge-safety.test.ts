import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GroupAgentRunService } from "../src/core/group-agent-run-service.js";
import type {
  GroupAuthorityResolver,
} from "../src/core/group-authority-policy.js";
import type {
  GroupAgentRun,
  GroupRunDeliveryReceipt,
} from "../src/domain/group-agent-run.js";
import type { GroupMessage } from "../src/domain/group.js";
import { FileGroupAgentRunRepository } from "../src/storage/file-group-agent-run-repository.js";

const NOW = new Date("2026-08-14T03:00:00.000Z");
const AFTER_HORIZON = new Date("2026-08-21T03:00:00.001Z");
const AUTHORITY: GroupAuthorityResolver = {
  resolveGroupAuthority: async () => ({ role: "member", authorityEpoch: 7 }),
};

describe("GroupAgentRun purge safety", () => {
  it("mempertahankan efek in-flight melewati horizon sampai recovery menutupnya", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-run-purge-"));
    const repository = new FileGroupAgentRunRepository(join(root, "runs.json"));
    let sequence = 0;
    const service = new GroupAgentRunService(
      repository,
      AUTHORITY,
      () => NOW,
      () => `purge-${++sequence}`,
    );
    const started = await service.start({ message: startMessage() });
    let entered!: () => void;
    let release!: () => void;
    const deliveryEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const deliveryBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interrupted = service.commitAnchor(
      started.run.runId,
      started.run.stateRevision,
      "📌 Efek yang masih in-flight",
      async () => {
        entered();
        await deliveryBlocked;
        return { messageId: "late-delivery" };
      },
    );

    await deliveryEntered;
    assert.notEqual(
      (await repository.load(started.run.runId))?.pendingEffect,
      null,
    );
    assert.equal(await repository.removeExpired(AFTER_HORIZON), 0);
    assert.notEqual(
      (await repository.load(started.run.runId))?.pendingEffect,
      null,
    );

    const recovery = new GroupAgentRunService(
      repository,
      AUTHORITY,
      () => AFTER_HORIZON,
      () => `recovery-${++sequence}`,
    );
    const recovered = await recovery.recoverInterruptedRuns();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, "partial");
    assert.equal(recovered[0]?.pendingEffect, null);

    assert.equal(await repository.removeExpired(AFTER_HORIZON), 1);
    assert.equal(await repository.load(started.run.runId), null);

    release();
    await assert.rejects(interrupted);
  });

  it("menolak menyiapkan efek baru ketika seluruh slot receipt sudah terpakai", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-run-receipts-"));
    const file = join(root, "runs.json");
    const repository = new FileGroupAgentRunRepository(file);
    let sequence = 0;
    const service = new GroupAgentRunService(
      repository,
      AUTHORITY,
      () => NOW,
      () => `receipt-cap-${++sequence}`,
    );
    const started = await service.start({
      message: startMessage({ messageId: "start-receipt-cap" }),
    });
    const database = JSON.parse(await readFile(file, "utf8")) as {
      version: 1;
      runs: GroupAgentRun[];
    };
    const stored = database.runs[0]!;
    stored.stateRevision = 65;
    stored.receipts = Array.from(
      { length: 64 },
      (_, index): GroupRunDeliveryReceipt => ({
        receiptId: `receipt-${index + 1}`,
        effectId: `effect-${index + 1}`,
        effect: "whatsapp.message.send",
        purpose: "anchor",
        instructionRevision: 0,
        preparedStateRevision: index + 1,
        contentDigest: "a".repeat(64),
        subjectId: null,
        authority: {
          initiatorRole: "member",
          assigneeRole: null,
          authorityEpoch: 7,
        },
        status: "not_committed",
        externalMessageId: null,
        committedAt: NOW.toISOString(),
        reversible: false,
      }),
    );
    await writeFile(file, `${JSON.stringify(database, null, 2)}\n`, "utf8");

    const current = await repository.load(started.run.runId);
    assert.ok(current);
    const { stateRevision, ...draft } = current;
    await assert.rejects(
      repository.save({
        ...draft,
        pendingEffect: {
          effectId: "effect-over-cap",
          purpose: "anchor",
          instructionRevision: 0,
          preparedStateRevision: stateRevision,
          contentDigest: "b".repeat(64),
          question: null,
          authority: {
            initiatorRole: "member",
            assigneeRole: null,
            authorityEpoch: 7,
          },
          preparedAt: NOW.toISOString(),
        },
      }, stateRevision, async () => true),
      /Transisi pending effect GroupAgentRun tidak sah/u,
    );
    assert.equal(
      (await repository.load(started.run.runId))?.pendingEffect,
      null,
    );
  });
});

function startMessage(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "purge-safety@g.us" },
    accountId: "utama",
    messageId: "start-purge-safety",
    participantId: "participant-1",
    participantAliases: [],
    participantName: "Ayu",
    groupName: "Grup purge safety",
    text: "Harvy, bantu kelompok ini",
    at: NOW.toISOString(),
    mentionsHarvy: true,
    repliesToHarvy: false,
    isAdmin: false,
    authorityEpoch: 7,
    ...overrides,
  };
}
