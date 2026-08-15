import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileGroupAgentRunCleanupIntentRepository } from
  "../src/storage/file-group-agent-run-cleanup-repository.js";

describe("file GroupAgentRun cleanup intent repository", () => {
  it("persist exact scope+account, revision CAS, dan pulih setelah restart", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-run-cleanup-repo-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "cleanup-intents.json");
    const repository = new FileGroupAgentRunCleanupIntentRepository(path);

    const first = await repository.enqueue(
      "whatsapp:target@g.us",
      "wa-primary",
      "2026-08-14T01:00:00.000Z",
    );
    const otherAccount = await repository.enqueue(
      "whatsapp:target@g.us",
      "wa-secondary",
      "2026-08-14T01:01:00.000Z",
    );
    const otherScope = await repository.enqueue(
      "whatsapp:other@g.us",
      "wa-primary",
      "2026-08-14T01:02:00.000Z",
    );
    const second = await repository.enqueue(
      first.scopeKey,
      first.accountId,
      "2026-08-14T01:03:00.000Z",
    );

    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(
      await repository.hasPending(first.scopeKey, first.accountId),
      true,
    );
    assert.equal(await repository.matchesPending(
      first.scopeKey,
      first.accountId,
      first.revision,
      first.intentId,
    ), false);
    assert.equal(await repository.matchesPending(
      second.scopeKey,
      second.accountId,
      second.revision,
      second.intentId,
    ), true);
    assert.equal(await repository.complete(
      first.scopeKey,
      first.accountId,
      first.revision,
      first.intentId,
    ), false);

    const restarted = new FileGroupAgentRunCleanupIntentRepository(path);
    assert.deepEqual(await restarted.listPending(), [
      otherAccount,
      otherScope,
      second,
    ]);
    assert.equal(await restarted.complete(
      second.scopeKey,
      second.accountId,
      second.revision,
      second.intentId,
    ), true);
    assert.equal(
      await restarted.hasPending(second.scopeKey, second.accountId),
      false,
    );
    assert.deepEqual(await restarted.listPending(), [otherAccount, otherScope]);
    assert.equal(await restarted.complete(
      second.scopeKey,
      second.accountId,
      second.revision,
      second.intentId,
    ), false);

    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, /content|messageId|participant/iu);
  });

  it("menolak schema asing/duplikat tanpa menimpa file", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-run-cleanup-bad-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "cleanup-intents.json");
    const record = {
      version: 1,
      intentId: "intent-duplicate",
      scopeKey: "whatsapp:target@g.us",
      accountId: "wa-primary",
      revision: 1,
      requestedAt: "2026-08-14T01:00:00.000Z",
    };
    await writeFile(path, JSON.stringify({
      version: 1,
      intents: [record, { ...record }],
    }));
    const repository = new FileGroupAgentRunCleanupIntentRepository(path);

    await assert.rejects(
      repository.listPending(),
      /binding intent cleanup GroupAgentRun duplikat/iu,
    );
    await assert.rejects(
      repository.enqueue(
        "whatsapp:new@g.us",
        "wa-primary",
        "2026-08-14T01:04:00.000Z",
      ),
      /binding intent cleanup GroupAgentRun duplikat/iu,
    );
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).intents.length,
      2,
    );
  });

  it("token fresh mencegah completion ABA menghapus intent baru", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-run-cleanup-aba-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repository = new FileGroupAgentRunCleanupIntentRepository(
      join(root, "cleanup-intents.json"),
    );
    const stale = await repository.enqueue(
      "whatsapp:aba@g.us",
      "wa-primary",
      "2026-08-14T01:00:00.000Z",
    );
    const replacement = await repository.enqueue(
      stale.scopeKey,
      stale.accountId,
      "2026-08-14T01:01:00.000Z",
    );
    assert.equal(await repository.complete(
      replacement.scopeKey,
      replacement.accountId,
      replacement.revision,
      replacement.intentId,
    ), true);
    const fresh = await repository.enqueue(
      stale.scopeKey,
      stale.accountId,
      "2026-08-14T01:02:00.000Z",
    );
    assert.equal(stale.revision, fresh.revision);
    assert.notEqual(stale.intentId, fresh.intentId);

    assert.equal(await repository.complete(
      stale.scopeKey,
      stale.accountId,
      stale.revision,
      stale.intentId,
    ), false);
    assert.deepEqual(await repository.listPending(), [fresh]);
  });
});
