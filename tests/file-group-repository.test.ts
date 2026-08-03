import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  GroupMemberMemory,
  GroupRoomMemory,
} from "../src/domain/group.js";
import { FileGroupRepository } from "../src/storage/file-group-repository.js";

describe("file group repository", () => {
  it("memigrasikan database v1 dan menyimpan subject memory v3", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-repository-"));
    const file = join(root, "groups.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        bindings: [
          {
            scopeKey: "whatsapp:g",
            channel: "whatsapp",
            groupId: "g",
            accountId: "utama",
            groupName: "G",
            joinedAt: "2026-07-31T00:00:00.000Z",
            noticeVersion: 5,
            noticeSentAt: "2026-07-31T00:00:00.000Z",
            disabledAt: null,
          },
        ],
        memories: [],
      }),
      "utf8",
    );
    const repository = new FileGroupRepository(file);

    assert.equal((await repository.loadBinding("whatsapp:g"))?.groupId, "g");
    assert.deepEqual(await repository.loadMemberMemories("whatsapp:g"), []);
    await repository.saveMemberMemories("whatsapp:g", [
      { ...memberMemory(), scopeKey: "whatsapp:g" },
    ]);

    const stored = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      memberMemories: GroupMemberMemory[];
    };
    assert.equal(stored.version, 3);
    assert.equal(stored.memberMemories[0]?.memberId, "member-1");
  });

  it("mengganti seluruh memori satu scope tanpa menyentuh scope lain", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-repository-"));
    const repository = new FileGroupRepository(join(root, "groups.json"));
    await repository.saveMemberMemories("whatsapp:a", [memberMemory()]);
    await repository.saveMemberMemories("whatsapp:b", [
      { ...memberMemory(), scopeKey: "whatsapp:b", memberId: "member-b" },
    ]);
    await repository.saveMemberMemories("whatsapp:a", []);

    assert.deepEqual(await repository.loadMemberMemories("whatsapp:a"), []);
    assert.equal(
      (await repository.loadMemberMemories("whatsapp:b"))[0]?.memberId,
      "member-b",
    );
  });

  it("menulis tombstone dan menghapus member memory dalam satu commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-repository-"));
    const repository = new FileGroupRepository(join(root, "groups.json"));
    await repository.saveBinding({
      scopeKey: "whatsapp:atomik",
      channel: "whatsapp",
      groupId: "atomik",
      accountId: "utama",
      groupName: "Atomik",
      joinedAt: "2026-07-31T00:00:00.000Z",
      noticeVersion: 6,
      noticeSentAt: "2026-07-31T00:00:00.000Z",
      disabledAt: null,
    });
    await repository.saveMemberMemories("whatsapp:atomik", [
      { ...memberMemory(), scopeKey: "whatsapp:atomik" },
    ]);
    await repository.saveRoomMemory(roomMemory("whatsapp:atomik"));

    assert.equal(
      await repository.disableAndRemoveScope(
        "whatsapp:atomik",
        "utama",
        "2026-07-31T01:00:00.000Z",
      ),
      true,
    );
    assert.deepEqual(
      await repository.loadMemberMemories("whatsapp:atomik"),
      [],
    );
    assert.equal(await repository.loadRoomMemory("whatsapp:atomik"), null);
    assert.equal(
      (await repository.loadBinding("whatsapp:atomik"))?.disabledAt,
      "2026-07-31T01:00:00.000Z",
    );
  });

  it("memigrasikan v2 tanpa mengarang shared room memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-repository-"));
    const file = join(root, "groups.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        bindings: [],
        memories: [],
        memberMemories: [memberMemory()],
      }),
      "utf8",
    );
    const repository = new FileGroupRepository(file);

    assert.equal((await repository.loadMemberMemories("whatsapp:a")).length, 1);
    assert.equal(await repository.loadRoomMemory("whatsapp:a"), null);
    await repository.saveRoomMemory(roomMemory("whatsapp:a"));
    const stored = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      roomMemories: GroupRoomMemory[];
    };
    assert.equal(stored.version, 3);
    assert.equal(stored.roomMemories.length, 1);
  });

  it("mereset profil sosial dan room memory tanpa menghapus member-local", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-repository-"));
    const repository = new FileGroupRepository(join(root, "groups.json"));
    await repository.saveMemory({
      scopeKey: "whatsapp:reset",
      groupName: "Ruang",
      harvyAliases: ["Kapi"],
      participants: [{
        participantId: "p1",
        identityAliases: [],
        displayName: "Ayu",
        daily: [],
        lastSeenAt: "2026-07-31T00:00:00.000Z",
      }],
      recentMessageIds: [{ messageId: "m1", seenAt: "2026-07-31T00:00:00.000Z" }],
      lastHarvyMessageAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    await repository.saveMemberMemories("whatsapp:reset", [
      { ...memberMemory(), scopeKey: "whatsapp:reset" },
    ]);
    await repository.saveRoomMemory(roomMemory("whatsapp:reset"));

    assert.equal(
      await repository.resetSharedMemory(
        "whatsapp:reset",
        "2026-08-02T00:00:00.000Z",
      ),
      true,
    );
    const memory = await repository.loadMemory("whatsapp:reset");
    assert.deepEqual(memory?.harvyAliases, ["Harvy"]);
    assert.deepEqual(memory?.participants, []);
    assert.deepEqual(memory?.recentMessageIds, [
      { messageId: "m1", seenAt: "2026-07-31T00:00:00.000Z" },
    ]);
    assert.equal(await repository.loadRoomMemory("whatsapp:reset"), null);
    assert.equal((await repository.loadMemberMemories("whatsapp:reset")).length, 1);
  });

  it("menghapus state satu anggota dan atribusi room dalam satu commit file", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-group-repository-"));
    const repository = new FileGroupRepository(join(root, "groups.json"));
    await repository.saveMemory({
      scopeKey: "whatsapp:forget",
      groupName: "Ruang",
      harvyAliases: ["Harvy"],
      participants: [{
        participantId: "p1",
        identityAliases: ["pn1"],
        displayName: "Ayu",
        daily: [{ date: "2026-08-02", messages: 2 }],
        lastSeenAt: "2026-08-02T00:00:00.000Z",
      }],
      recentMessageIds: [{ messageId: "m1", seenAt: "2026-08-02T00:00:00.000Z" }],
      lastHarvyMessageAt: null,
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    await repository.saveMemberMemories("whatsapp:forget", [
      { ...memberMemory(), scopeKey: "whatsapp:forget" },
    ]);
    await repository.saveRoomMemory(roomMemory("whatsapp:forget"));

    assert.equal(
      await repository.forgetParticipantState(
        "whatsapp:forget",
        ["p1", "pn1"],
        ["hash"],
        "2026-08-03T00:00:00.000Z",
      ),
      true,
    );
    const social = await repository.loadMemory("whatsapp:forget");
    assert.deepEqual(social?.participants, []);
    assert.deepEqual(social?.recentMessageIds, [
      { messageId: "m1", seenAt: "2026-08-02T00:00:00.000Z" },
    ]);
    assert.deepEqual(
      await repository.loadMemberMemories("whatsapp:forget"),
      [],
    );
    assert.deepEqual(
      (await repository.loadRoomMemory("whatsapp:forget"))?.items[0]
        ?.proposedByAliasKeys,
      [],
    );
  });
});

function memberMemory(): GroupMemberMemory {
  return {
    scopeKey: "whatsapp:a",
    memberId: "member-1",
    aliasKeys: ["hash"],
    generation: 1,
    updatedAt: "2026-07-31T00:00:00.000Z",
    items: [
      {
        id: "memory-1",
        kind: "preference",
        content: "Suka diagram",
        sensitivity: "ordinary",
        visibility: "member-local",
        consent: "notice",
        source: "conversation",
        createdAt: "2026-07-31T00:00:00.000Z",
        lastConfirmedAt: "2026-07-31T00:00:00.000Z",
        expiresAt: null,
      },
    ],
  };
}

function roomMemory(scopeKey: string): GroupRoomMemory {
  return {
    scopeKey,
    generation: 1,
    updatedAt: "2026-07-31T00:00:00.000Z",
    items: [
      {
        id: "room-1",
        kind: "decision",
        content: "Presentasi hari Jumat",
        proposedByAliasKeys: ["hash"],
        visibility: "room",
        consent: "admin-confirmed",
        source: "explicit",
        createdAt: "2026-07-31T00:00:00.000Z",
        expiresAt: "2026-09-29T00:00:00.000Z",
      },
    ],
  };
}
