import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GroupMemoryService,
  ROOM_MEMORY_RETENTION_DAYS,
  SOCIAL_STAT_WINDOW_DAYS,
} from "../src/core/group-memory-service.js";
import type {
  GroupBinding,
  GroupMemberMemory,
  GroupMemory,
  GroupMessage,
  GroupRepository,
  GroupRoomMemory,
  GroupScope,
} from "../src/domain/group.js";

const NOW = new Date("2026-07-29T12:00:00.000Z");
const ALLOW_MUTATION = async (): Promise<boolean> => true;

describe("memori grup", () => {
  it("mengikat satu grup ke satu akun dan tidak memindahkannya diam-diam", async () => {
    const service = createService();
    const scope = whatsappGroup("123@g.us");

    const first = await service.activate(scope, "nomor-a", "Kelas XI");
    const second = await service.activate(scope, "nomor-b", "Kelas XI");

    assert.equal(first.status, "active");
    assert.equal(second.status, "conflict");
    assert.equal(second.binding.accountId, "nomor-a");
  });

  it("mengisolasi anggota yang sama di dua grup", async () => {
    const service = createService();
    const first = whatsappGroup("a@g.us");
    const second = whatsappGroup("b@g.us");
    await service.activate(first, "nomor-a", "Grup A");
    await service.activate(second, "nomor-a", "Grup B");

    await service.recordIncoming(message(first, "a-1", "anggota-1"));
    await service.recordIncoming(message(second, "b-1", "anggota-1"));
    await service.recordIncoming(message(first, "a-2", "anggota-1"));

    const firstMemory = await service.memory("whatsapp:a@g.us");
    const secondMemory = await service.memory("whatsapp:b@g.us");

    assert.equal(service.activityRanking(firstMemory!)[0]?.messages, 2);
    assert.equal(service.activityRanking(secondMemory!)[0]?.messages, 1);
  });

  it("menghitung statistik hanya dalam jendela tujuh hari", async () => {
    const service = createService();
    const scope = whatsappGroup("kelas@g.us");
    await service.activate(scope, "nomor-a", "Kelas");

    await service.recordIncoming(
      message(scope, "lama", "satu", "2026-07-20T12:00:00.000Z"),
    );
    await service.recordIncoming(
      message(scope, "baru", "satu", "2026-07-29T12:00:00.000Z"),
    );

    const memory = await service.memory("whatsapp:kelas@g.us");
    const ranking = service.activityRanking(memory!);

    assert.equal(SOCIAL_STAT_WINDOW_DAYS, 7);
    assert.equal(ranking[0]?.messages, 1);
  });

  it("mendeduplikasi pesan dan dapat melupakan statistik satu anggota", async () => {
    const service = createService();
    const scope = whatsappGroup("diskusi@g.us");
    const incoming = message(scope, "pesan-1", "anggota-1");
    await service.activate(scope, "nomor-a", "Diskusi");

    assert.equal(
      (await service.recordIncoming(incoming)).status,
      "recorded",
    );
    assert.equal(
      (await service.recordIncoming(incoming)).status,
      "duplicate",
    );
    assert.equal(
      await service.forgetParticipant(
        "whatsapp:diskusi@g.us",
        ["anggota-1"],
        "nomor-a",
        ALLOW_MUTATION,
      ),
      true,
    );

    const memory = await service.memory("whatsapp:diskusi@g.us");
    assert.deepEqual(memory?.participants, []);
  });

  it("menghapus fisik aktivitas yang melewati retensi meski grup tidak aktif", async () => {
    let now = new Date("2026-07-01T12:00:00.000Z");
    const repository = new MemoryGroupRepository();
    const service = new GroupMemoryService(repository, () => now);
    const scope = whatsappGroup("retensi@g.us");
    await service.activate(scope, "nomor-a", "Retensi", now.toISOString());

    await service.recordIncoming(
      message(scope, "awal", "anggota-1", now.toISOString()),
    );
    now = new Date("2026-08-02T12:00:00.000Z");
    await service.purgeExpired();

    const stored = repository.memories.get("whatsapp:retensi@g.us");
    assert.deepEqual(stored?.participants, []);
    assert.deepEqual(stored?.recentMessageIds, []);
  });

  it("menyatukan PN dan LID lalu menghapus keduanya sebagai satu anggota", async () => {
    const service = createService();
    const scope = whatsappGroup("lid@g.us");
    await service.activate(scope, "nomor-a", "LID");

    await service.recordIncoming({
      ...message(scope, "pn", "628777777777@s.whatsapp.net"),
      participantAliases: [
        "628777777777@s.whatsapp.net",
        "12345@lid",
      ],
    });
    await service.recordIncoming({
      ...message(scope, "lid", "12345@lid"),
      participantAliases: [
        "12345@lid",
        "628777777777@s.whatsapp.net",
      ],
    });

    const before = await service.memory("whatsapp:lid@g.us");
    assert.equal(before?.participants.length, 1);
    assert.equal(service.activityRanking(before!)[0]?.messages, 2);
    assert.equal(
      await service.forgetParticipant(
        "whatsapp:lid@g.us",
        ["12345@lid"],
        "nomor-a",
        ALLOW_MUTATION,
      ),
      true,
    );
    assert.deepEqual(
      (await service.memory("whatsapp:lid@g.us"))?.participants,
      [],
    );
  });

  it("menghapus memori saat dikeluarkan dan memulai bersih saat akun sama ditambahkan ulang", async () => {
    const repository = new MemoryGroupRepository();
    const service = new GroupMemoryService(repository, () => NOW);
    const scope = whatsappGroup("readd@g.us");
    await service.activate(scope, "nomor-a", "Re-add");
    await service.recordIncoming(message(scope, "awal", "anggota"));

    assert.equal(
      await service.disable("whatsapp:readd@g.us", "nomor-a"),
      true,
    );
    assert.equal(await service.memory("whatsapp:readd@g.us"), null);
    assert.equal(
      await service.rememberHarvyAlias(
        "whatsapp:readd@g.us",
        "nomor-a",
        "Kapi",
        ALLOW_MUTATION,
      ),
      false,
    );

    const activation = await service.activate(
      scope,
      "nomor-a",
      "Re-add",
      "2026-07-29T12:10:00.000Z",
    );
    assert.equal(activation.status, "active");
    assert.equal(activation.created, true);
    assert.equal(await service.memory("whatsapp:readd@g.us"), null);
  });

  it("menghitung setiap bubble dalam satu giliran gabungan", async () => {
    const service = createService();
    const scope = whatsappGroup("bubble@g.us");
    await service.activate(scope, "nomor-a", "Bubble");

    assert.equal(
      (await service.recordIncoming({
        ...message(scope, "dua", "anggota"),
        text: "satu\ndua",
        parts: [
          {
            messageId: "satu",
            text: "satu",
            at: NOW.toISOString(),
            mentionsHarvy: false,
            repliesToHarvy: false,
          },
          {
            messageId: "dua",
            text: "dua",
            at: NOW.toISOString(),
            mentionsHarvy: false,
            repliesToHarvy: false,
          },
        ],
      })).status,
      "recorded",
    );
    const memory = await service.memory("whatsapp:bubble@g.us");
    assert.equal(service.activityRanking(memory!)[0]?.messages, 2);
  });

  it("menyatukan record PN-only dan LID-only ketika event penghubung tiba", async () => {
    const service = createService();
    const scope = whatsappGroup("bridge@g.us");
    await service.activate(scope, "nomor-a", "Bridge");
    await service.recordIncoming(message(scope, "pn", "pn-1"));
    await service.recordIncoming(message(scope, "lid", "lid-1"));
    await service.recordIncoming({
      ...message(scope, "bridge", "pn-1"),
      participantAliases: ["pn-1", "lid-1"],
    });

    const memory = await service.memory("whatsapp:bridge@g.us");
    assert.equal(memory?.participants.length, 1);
    assert.equal(service.activityRanking(memory!)[0]?.messages, 3);
  });

  it("mengisolasi memori semantik per anggota dan per grup", async () => {
    const repository = new MemoryGroupRepository();
    let sequence = 0;
    const service = new GroupMemoryService(
      repository,
      () => NOW,
      () => `id-${sequence += 1}`,
    );
    const first = whatsappGroup("memori-a@g.us");
    const second = whatsappGroup("memori-b@g.us");
    await service.activate(first, "nomor-a", "A");
    await service.activate(second, "nomor-a", "B");

    assert.equal(
      (await service.rememberParticipantMemory(
        "whatsapp:memori-a@g.us",
        "nomor-a",
        ["anggota-sama"],
        {
          kind: "preference",
          content: "Lebih mudah belajar memakai diagram",
          sensitivity: "ordinary",
          consent: "notice",
          source: "conversation",
        },
        ALLOW_MUTATION,
      )).status,
      "saved",
    );

    assert.equal(
      (await service.memberMemories(
        "whatsapp:memori-a@g.us",
        ["anggota-sama"],
        "bisa pakai diagram?",
      )).length,
      1,
    );
    assert.deepEqual(
      await service.memberMemories(
        "whatsapp:memori-a@g.us",
        ["anggota-lain"],
        "diagram",
      ),
      [],
    );
    assert.deepEqual(
      await service.memberMemories(
        "whatsapp:memori-b@g.us",
        ["anggota-sama"],
        "diagram",
      ),
      [],
    );
    const stored = repository.memberMemories.get("whatsapp:memori-a@g.us") ?? [];
    assert.equal(JSON.stringify(stored).includes("anggota-sama"), false);
  });

  it("memerlukan izin eksplisit untuk memori sensitif grup", async () => {
    const service = createService();
    const scope = whatsappGroup("sensitif@g.us");
    await service.activate(scope, "nomor-a", "Sensitif");
    const candidate = {
      kind: "personal" as const,
      content: "Sedang menghadapi masalah keluarga",
      sensitivity: "sensitive" as const,
      source: "explicit" as const,
    };

    assert.equal(
      (await service.rememberParticipantMemory(
        "whatsapp:sensitif@g.us",
        "nomor-a",
        ["anggota"],
        { ...candidate, consent: "notice" },
        ALLOW_MUTATION,
      )).status,
      "requires-consent",
    );
    assert.equal(
      (await service.rememberParticipantMemory(
        "whatsapp:sensitif@g.us",
        "nomor-a",
        ["anggota"],
        { ...candidate, consent: "explicit" },
        ALLOW_MUTATION,
      )).status,
      "saved",
    );
  });

  it("menghapus memori anggota bersama aktivitasnya", async () => {
    const service = createService();
    const scope = whatsappGroup("hapus-anggota@g.us");
    await service.activate(scope, "nomor-a", "Hapus");
    await service.recordIncoming(message(scope, "pesan", "anggota"));
    await service.rememberParticipantMemory(
      "whatsapp:hapus-anggota@g.us",
      "nomor-a",
      ["anggota"],
      {
        kind: "profile",
        content: "Nama panggilannya Nara",
        sensitivity: "ordinary",
        consent: "notice",
        source: "conversation",
      },
      ALLOW_MUTATION,
    );

    assert.equal(
      await service.forgetParticipant(
        "whatsapp:hapus-anggota@g.us",
        ["anggota"],
        "nomor-a",
        ALLOW_MUTATION,
      ),
      true,
    );
    assert.deepEqual(
      await service.memberMemories(
        "whatsapp:hapus-anggota@g.us",
        ["anggota"],
      ),
      [],
    );
  });

  it("mengulang cleanup disable yang sempat gagal setelah tombstone ditulis", async () => {
    const repository = new FailingCleanupRepository();
    const service = new GroupMemoryService(repository, () => NOW);
    const scope = whatsappGroup("crash-cleanup@g.us");
    await service.activate(scope, "nomor-a", "Cleanup");
    await service.recordIncoming(message(scope, "pesan", "anggota"));
    await service.rememberParticipantMemory(
      "whatsapp:crash-cleanup@g.us",
      "nomor-a",
      ["anggota"],
      {
        kind: "profile",
        content: "Nama panggilannya Nara",
        sensitivity: "ordinary",
        consent: "notice",
        source: "conversation",
      },
      ALLOW_MUTATION,
    );

    await assert.rejects(
      service.disable("whatsapp:crash-cleanup@g.us", "nomor-a"),
      /simulasi crash/u,
    );
    assert.notEqual(
      (await service.binding("whatsapp:crash-cleanup@g.us"))?.disabledAt,
      null,
    );
    assert.equal(
      await service.disable("whatsapp:crash-cleanup@g.us", "nomor-a"),
      false,
    );
    assert.deepEqual(
      await service.memberMemories(
        "whatsapp:crash-cleanup@g.us",
        ["anggota"],
      ),
      [],
    );
  });

  it("mengoreksi dan menghapus satu memori hanya milik anggota peminta", async () => {
    const service = createService();
    const scope = whatsappGroup("kontrol-item@g.us");
    await service.activate(scope, "nomor-a", "Kontrol");
    const saved = await service.rememberParticipantMemory(
      "whatsapp:kontrol-item@g.us",
      "nomor-a",
      ["anggota-a"],
      {
        kind: "profile",
        content: "Nama panggilannya Nara",
        sensitivity: "ordinary",
        consent: "notice",
        source: "conversation",
      },
      ALLOW_MUTATION,
    );
    assert.equal(saved.status, "saved");
    if (saved.status !== "saved") return;

    assert.equal(
      await service.editParticipantMemory(
        "whatsapp:kontrol-item@g.us",
        ["anggota-b"],
        saved.item.id,
        "Nama panggilannya Ara",
        "nomor-a",
        ALLOW_MUTATION,
      ),
      false,
    );
    assert.equal(
      await service.editParticipantMemory(
        "whatsapp:kontrol-item@g.us",
        ["anggota-a"],
        saved.item.id,
        "Nama panggilannya Ara",
        "nomor-a",
        ALLOW_MUTATION,
      ),
      true,
    );
    assert.equal(
      (await service.memberMemories(
        "whatsapp:kontrol-item@g.us",
        ["anggota-a"],
      ))[0]?.content,
      "Nama panggilannya Ara",
    );
    assert.equal(
      await service.removeParticipantMemory(
        "whatsapp:kontrol-item@g.us",
        ["anggota-a"],
        saved.item.id.slice(0, 8),
        "nomor-a",
        ALLOW_MUTATION,
      ),
      true,
    );
  });

  it("menyimpan catatan bersama hanya setelah konfirmasi admin dan mengisolasi grup", async () => {
    const repository = new MemoryGroupRepository();
    let sequence = 0;
    const service = new GroupMemoryService(
      repository,
      () => NOW,
      () => `room-${sequence += 1}`,
    );
    await service.activate(whatsappGroup("room-a@g.us"), "nomor-a", "A");
    await service.activate(whatsappGroup("room-b@g.us"), "nomor-a", "B");

    assert.equal(
      (await service.rememberRoomMemory(
        "whatsapp:room-a@g.us",
        "nomor-a",
        ["anggota"],
        "decision",
        "Presentasi dilakukan hari Jumat",
        false,
        ALLOW_MUTATION,
      )).status,
      "requires-admin-confirmation",
    );
    const saved = await service.rememberRoomMemory(
      "whatsapp:room-a@g.us",
      "nomor-a",
      ["anggota"],
      "decision",
      "Presentasi dilakukan hari Jumat",
      true,
      ALLOW_MUTATION,
    );
    assert.equal(saved.status, "saved");
    assert.equal((await service.roomMemories("whatsapp:room-a@g.us")).length, 1);
    assert.deepEqual(await service.roomMemories("whatsapp:room-b@g.us"), []);
    const stored = repository.roomMemories.get("whatsapp:room-a@g.us");
    assert.equal(JSON.stringify(stored).includes("anggota"), false);
    assert.equal(ROOM_MEMORY_RETENTION_DAYS, 60);
  });

  it("reset admin menghapus state bersama tanpa mengambil memori member-local", async () => {
    const repository = new MemoryGroupRepository();
    const service = new GroupMemoryService(repository, () => NOW, () => "id-room");
    const scope = whatsappGroup("authority@g.us");
    await service.activate(scope, "nomor-a", "Authority");
    await service.recordIncoming(message(scope, "pesan", "anggota"));
    await service.rememberParticipantMemory(
      "whatsapp:authority@g.us",
      "nomor-a",
      ["anggota"],
      {
        kind: "preference",
        content: "Suka diagram",
        sensitivity: "ordinary",
        consent: "notice",
        source: "explicit",
      },
      ALLOW_MUTATION,
    );
    await service.rememberRoomMemory(
      "whatsapp:authority@g.us",
      "nomor-a",
      ["anggota"],
      "norm",
      "Diskusi dimulai setelah semua hadir",
      true,
      ALLOW_MUTATION,
    );

    assert.equal(
      await service.resetMemory(
        "whatsapp:authority@g.us",
        "nomor-a",
        ALLOW_MUTATION,
      ),
      true,
    );
    assert.deepEqual(await service.roomMemories("whatsapp:authority@g.us"), []);
    assert.equal(
      (await service.memberMemories("whatsapp:authority@g.us", ["anggota"]))
        .length,
      1,
    );
    assert.deepEqual(
      (await service.memory("whatsapp:authority@g.us"))?.participants,
      [],
    );
  });

  it("menolak mutasi bila authority guard tidak lagi berlaku", async () => {
    const service = createService();
    const scope = whatsappGroup("guard@g.us");
    await service.activate(scope, "nomor-a", "Guard");
    const denied = async (): Promise<boolean> => false;

    assert.equal(
      (await service.rememberParticipantMemory(
        "whatsapp:guard@g.us",
        "nomor-a",
        ["anggota"],
        {
          kind: "preference",
          content: "Suka diagram",
          sensitivity: "ordinary",
          consent: "notice",
          source: "explicit",
        },
        denied,
      )).status,
      "inactive",
    );
    assert.equal(
      (await service.rememberRoomMemory(
        "whatsapp:guard@g.us",
        "nomor-a",
        ["anggota"],
        "decision",
        "Presentasi hari Jumat",
        true,
        denied,
      )).status,
      "inactive",
    );
    assert.deepEqual(
      await service.memberMemories("whatsapp:guard@g.us", ["anggota"]),
      [],
    );
    assert.deepEqual(await service.roomMemories("whatsapp:guard@g.us"), []);
  });
});

class MemoryGroupRepository implements GroupRepository {
  readonly bindings = new Map<string, GroupBinding>();
  readonly memories = new Map<string, GroupMemory>();
  readonly memberMemories = new Map<string, GroupMemberMemory[]>();
  readonly roomMemories = new Map<string, GroupRoomMemory>();

  async loadBinding(scopeKey: string): Promise<GroupBinding | null> {
    return this.bindings.get(scopeKey) ?? null;
  }

  async saveBinding(binding: GroupBinding): Promise<void> {
    this.bindings.set(binding.scopeKey, structuredClone(binding));
  }

  async loadMemory(scopeKey: string): Promise<GroupMemory | null> {
    const memory = this.memories.get(scopeKey);
    return memory ? structuredClone(memory) : null;
  }

  async listMemories(): Promise<GroupMemory[]> {
    return [...this.memories.values()].map((memory) => structuredClone(memory));
  }

  async saveMemory(memory: GroupMemory): Promise<void> {
    this.memories.set(memory.scopeKey, structuredClone(memory));
  }

  async removeMemory(scopeKey: string): Promise<boolean> {
    return this.memories.delete(scopeKey);
  }

  async loadMemberMemories(scopeKey: string): Promise<GroupMemberMemory[]> {
    return structuredClone(this.memberMemories.get(scopeKey) ?? []);
  }

  async saveMemberMemories(
    scopeKey: string,
    memories: GroupMemberMemory[],
  ): Promise<void> {
    this.memberMemories.set(scopeKey, structuredClone(memories));
  }

  async removeMemberMemories(scopeKey: string): Promise<number> {
    const count = this.memberMemories.get(scopeKey)?.length ?? 0;
    this.memberMemories.delete(scopeKey);
    return count;
  }

  async listMemberMemoryScopes(): Promise<string[]> {
    return [...this.memberMemories.keys()];
  }

  async loadRoomMemory(scopeKey: string): Promise<GroupRoomMemory | null> {
    const memory = this.roomMemories.get(scopeKey);
    return memory ? structuredClone(memory) : null;
  }

  async saveRoomMemory(memory: GroupRoomMemory): Promise<void> {
    this.roomMemories.set(memory.scopeKey, structuredClone(memory));
  }

  async removeRoomMemory(scopeKey: string): Promise<boolean> {
    return this.roomMemories.delete(scopeKey);
  }

  async listRoomMemoryScopes(): Promise<string[]> {
    return [...this.roomMemories.keys()];
  }
}

class FailingCleanupRepository extends MemoryGroupRepository {
  private failOnce = true;

  override async removeMemberMemories(scopeKey: string): Promise<number> {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("simulasi crash cleanup");
    }
    return super.removeMemberMemories(scopeKey);
  }
}

function createService(): GroupMemoryService {
  return new GroupMemoryService(new MemoryGroupRepository(), () => NOW);
}

function whatsappGroup(groupId: string): GroupScope {
  return { channel: "whatsapp", groupId };
}

function message(
  scope: GroupScope,
  messageId: string,
  participantId: string,
  at = NOW.toISOString(),
): GroupMessage {
  return {
    scope,
    accountId: "nomor-a",
    messageId,
    participantId,
    participantAliases: [participantId],
    participantName: participantId,
    groupName: "Grup uji",
    text: "halo",
    at,
    mentionsHarvy: false,
    repliesToHarvy: false,
    isAdmin: false,
  };
}
