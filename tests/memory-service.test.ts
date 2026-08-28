import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MemoryService,
  type MemoryDerivationLifecycle,
} from "../src/core/memory-service.js";
import type {
  MemoryItem,
  MemoryRepository,
  NewMemory,
} from "../src/domain/memory.js";

describe("MemoryService", () => {
  it("mengisolasi memori berdasarkan pemilik", async () => {
    const service = new MemoryService(new MemoryStore());

    await service.remember({
      ownerId: "student-a",
      kind: "profile",
      content: "Kelas 11 IPA",
    });
    await service.remember({
      ownerId: "student-b",
      kind: "profile",
      content: "Kelas 9",
    });

    const mine = await service.list("student-a");
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.content, "Kelas 11 IPA");
  });

  it("tidak mencatat hal yang sama dua kali", async () => {
    const service = new MemoryService(new MemoryStore());

    const first = await service.remember({
      ownerId: "student",
      kind: "profile",
      content: "Kelas 11 IPA",
    });
    const second = await service.remember({
      ownerId: "student",
      kind: "profile",
      content: "kelas 11 ipa",
    });

    assert.notEqual(first, null);
    // Model mengusulkan memori pada setiap giliran. Tanpa penjagaan ini, daftar
    // memori penuh pengulangan dan hak menghapus satu per satu jadi percuma.
    assert.equal(second, null);
    assert.equal((await service.list("student")).length, 1);
  });

  it("membuang memori kedaluwarsa saat dibaca", async () => {
    const store = new MemoryStore();
    let now = new Date("2026-07-26T10:00:00.000Z");
    const service = new MemoryService(store, () => now);

    await service.remember({
      ownerId: "student",
      kind: "context",
      content: "Ujian biologi minggu depan",
    });
    assert.equal((await service.list("student")).length, 1);

    now = new Date("2027-07-26T10:00:00.000Z");

    assert.equal((await service.list("student")).length, 0);
    // Bukan sekadar disembunyikan dari tampilan: memori kedaluwarsa yang masih
    // tersimpan tetap data yang dipegang tanpa alasan.
    assert.equal((await store.list("student")).length, 0);
  });

  it("melupakan satu memori tanpa menyentuh yang lain", async () => {
    const service = new MemoryService(new MemoryStore());
    const kept = await service.remember({
      ownerId: "student",
      kind: "profile",
      content: "Kelas 11 IPA",
    });
    const dropped = await service.remember({
      ownerId: "student",
      kind: "personal",
      content: "Ibunya sedang sakit",
      sensitiveConsent: true,
    });

    const forgotten = await service.forget("student", dropped?.id ?? "");
    assert.equal(forgotten?.content, "Ibunya sedang sakit");

    const remaining = await service.list("student");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.id, kept?.id);
  });

  it("melupakan semuanya hanya milik pengguna yang meminta", async () => {
    const service = new MemoryService(new MemoryStore());
    await service.remember({
      ownerId: "student-a",
      kind: "profile",
      content: "Kelas 11 IPA",
    });
    await service.remember({
      ownerId: "student-b",
      kind: "profile",
      content: "Kelas 9",
    });

    assert.equal(await service.forgetAll("student-a"), 1);
    assert.equal((await service.list("student-a")).length, 0);
    assert.equal((await service.list("student-b")).length, 1);
  });

  it("menolak memori kosong", async () => {
    const service = new MemoryService(new MemoryStore());

    assert.equal(
      await service.remember({
        ownerId: "student",
        kind: "profile",
        content: "   ",
      }),
      null,
    );
  });

  it("menolak primary personal memory tanpa authority consent adapter", async () => {
    const service = new MemoryService(new MemoryStore());
    assert.equal(await service.remember({
      ownerId: "student",
      kind: "personal",
      content: "Ibunya sedang sakit",
    }), null);
  });

  it("menolak credential meski adapter membawa sensitive consent", async () => {
    const lifecycle = new MemoryLifecycle();
    const service = new MemoryService(new MemoryStore(), () => new Date(), lifecycle);
    assert.equal(await service.remember({
      ownerId: "student",
      kind: "personal",
      content: "Password email adalah CONTOH_SANDI_123",
      sensitiveConsent: true,
    }), null);
    await service.drain();
    assert.deepEqual(await service.list("student"), []);
    assert.deepEqual(lifecycle.events, []);
  });

  it("meneruskan explicit personal memory ke derivation normal", async () => {
    const lifecycle = new MemoryLifecycle();
    const service = new MemoryService(new MemoryStore(), () => new Date(), lifecycle);
    const saved = await service.remember({
      ownerId: "student",
      kind: "personal",
      content: "Rani adalah pacarku",
      sensitiveConsent: true,
      sensitivity: "personal",
      sourceSequences: [12],
      subject: "user",
      predicate: "romantic_partner",
      value: "Rani",
    });

    assert.ok(saved);
    await service.drain();
    assert.deepEqual(lifecycle.events, ["remember:student:12"]);
  });

  it("mengubah isi tanpa mengganti ID, jenis, atau metadata", async () => {
    const service = new MemoryService(new MemoryStore(), () =>
      new Date("2026-07-27T10:00:00.000Z"),
    );
    const saved = await service.remember({
      ownerId: "student",
      kind: "preference",
      content: "Suka belajar malam",
    });
    assert.ok(saved);

    const updated = await service.edit(
      "student",
      saved.id,
      "Lebih suka belajar pagi",
    );
    assert.equal(updated?.id, saved.id);
    assert.equal(updated?.kind, saved.kind);
    assert.equal(updated?.createdAt, saved.createdAt);
    assert.equal(updated?.expiresAt, saved.expiresAt);
    assert.equal(updated?.content, "Lebih suka belajar pagi");
  });

  it("menolak edit yang mencoba memasukkan credential", async () => {
    const service = new MemoryService(new MemoryStore());
    const saved = await service.remember({
      ownerId: "student",
      kind: "preference",
      content: "Suka belajar pagi",
    });
    assert.ok(saved);
    assert.equal(
      await service.edit("student", saved.id, "PIN kartu aku 4321"),
      null,
    );
    assert.equal((await service.list("student"))[0]?.content, "Suka belajar pagi");
  });

  it("menolak edit kosong, terlalu panjang, duplikat, atau milik orang lain", async () => {
    const service = new MemoryService(new MemoryStore());
    const first = await service.remember({
      ownerId: "student",
      kind: "profile",
      content: "Kelas 11",
    });
    await service.remember({
      ownerId: "student",
      kind: "profile",
      content: "Sekolah di Bandung",
    });
    assert.ok(first);

    assert.equal(await service.edit("student", first.id, " "), null);
    assert.equal(
      await service.edit("student", first.id, "x".repeat(201)),
      null,
    );
    assert.equal(
      await service.edit("student", first.id, "sekolah di bandung"),
      null,
    );
    assert.equal(await service.edit("other", first.id, "Kelas 12"), null);
  });

  it("mengkonsolidasikan remember di belakang respons lalu mengurutkan forget sesudahnya", async () => {
    const lifecycle = new MemoryLifecycle();
    const service = new MemoryService(
      new MemoryStore(),
      () => new Date("2026-08-09T00:00:00.000Z"),
      lifecycle,
    );
    const saved = await service.remember({
      ownerId: "student",
      kind: "preference",
      content: "Suka diagram",
      sourceSequences: [7],
    });
    assert.ok(saved);
    await service.drain();
    assert.deepEqual(lifecycle.events, ["remember:student:7"]);

    await service.forget("student", saved.id);
    assert.deepEqual(lifecycle.events, [
      "remember:student:7",
      "forget:student:forgotten",
    ]);
  });

  it("menutup relevant memory saat consent ditarik dan hanya membuka setelah allow", async () => {
    const lifecycle = new MemoryLifecycle();
    const service = new MemoryService(new MemoryStore(), () => new Date(), lifecycle);
    await service.remember({
      ownerId: "student",
      kind: "profile",
      content: "Kelas 11",
    });
    await service.drain();

    service.suspend("student");
    assert.deepEqual(await service.relevantTo("student", "kelas"), []);
    assert.equal(
      await service.remember({
        ownerId: "student",
        kind: "profile",
        content: "Sekolah A",
      }),
      null,
    );
    service.allow("student");
    assert.equal((await service.relevantTo("student", "kelas")).length, 1);
    assert.deepEqual(lifecycle.events.slice(-2), ["suspend:student", "allow:student"]);
  });

  it("forget-all menghapus derivation dan mempertahankan block penghapusan penuh", async () => {
    const lifecycle = new MemoryLifecycle();
    const service = new MemoryService(new MemoryStore(), () => new Date(), lifecycle);
    await service.remember({
      ownerId: "student",
      kind: "profile",
      content: "Kelas 11",
    });
    await service.drain();
    service.suspend("student");
    await service.forgetAll("student");
    assert.deepEqual(lifecycle.events.slice(-2), [
      "suspend:student",
      "forget-all:student",
    ]);
  });

  it("tidak menghidupkan primary memory dari remember yang tertahan saat full delete", async () => {
    const store = new GatedListMemoryStore();
    const service = new MemoryService(store);
    const pendingRemember = service.remember({
      ownerId: "student",
      kind: "profile",
      content: "Kelas 11",
    });
    await store.listStarted;

    service.suspend("student");
    const deletion = service.forgetAll("student");
    store.releaseList();

    assert.equal(await pendingRemember, null);
    assert.equal(await deletion, 0);
    assert.deepEqual(await store.list("student"), []);
  });

  it("markUsed completion lama tidak membuat ulang item sesudah full delete", async () => {
    const store = new MemoryStore();
    const service = new MemoryService(store);
    const saved = await service.remember({
      ownerId: "student",
      kind: "preference",
      content: "Suka diagram",
    });
    assert.ok(saved);
    service.suspend("student");
    await service.forgetAll("student");

    await service.markUsed([saved]);
    assert.deepEqual(await store.list("student"), []);
  });

  it("hak edit dan forget tetap lokal ketika retrieval consent disuspend", async () => {
    const store = new MemoryStore();
    const service = new MemoryService(store, () => new Date(), new MemoryLifecycle());
    const saved = await service.remember({
      ownerId: "student",
      kind: "preference",
      content: "Suka malam",
    });
    assert.ok(saved);
    await service.drain();
    service.suspend("student");

    const edited = await service.edit("student", saved.id, "Suka pagi");
    assert.equal(edited?.content, "Suka pagi");
    assert.equal((await service.list("student"))[0]?.content, "Suka pagi");
    assert.equal((await service.forget("student", saved.id))?.id, saved.id);
    assert.deepEqual(await service.list("student"), []);
  });

  it("membuka kembali ordinary wipe setelah lifecycle gagal agar retry dapat selesai", async () => {
    const lifecycle = new FailOnceForgetAllLifecycle();
    const store = new MemoryStore();
    const service = new MemoryService(store, () => new Date(), lifecycle);
    await service.remember({
      ownerId: "student",
      kind: "profile",
      content: "Kelas 11",
    });
    await service.drain();

    await assert.rejects(service.forgetAll("student"), /gagal sekali/u);
    assert.ok(await service.remember({
      ownerId: "student",
      kind: "profile",
      content: "Sekolah A",
    }));
    assert.equal(await service.forgetAll("student"), 2);
    assert.deepEqual(await store.list("student"), []);
  });

  it("membuang relevant snapshot lama melintasi suspend-allow ABA", async () => {
    const store = new GatedListMemoryStore(false);
    const service = new MemoryService(store);
    await service.remember({
      ownerId: "student",
      kind: "profile",
      content: "Kelas 11",
    });
    store.holdNextList();
    const pending = service.relevantTo("student", "kelas");
    await store.listStarted;
    const wipe = service.forgetAll("student");
    store.releaseList();

    assert.deepEqual(await pending, []);
    await wipe;
  });
});

/** Penyimpanan di memori proses, agar tes tidak menyentuh berkas nyata. */
class MemoryStore implements MemoryRepository {
  protected items: MemoryItem[] = [];

  async save(item: MemoryItem): Promise<void> {
    const index = this.items.findIndex(
      (stored) => stored.ownerId === item.ownerId && stored.id === item.id,
    );
    if (index >= 0) {
      this.items[index] = item;
    } else {
      this.items.push(item);
    }
  }

  async list(ownerId: string): Promise<MemoryItem[]> {
    return this.items.filter((item) => item.ownerId === ownerId);
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    const index = this.items.findIndex(
      (item) => item.ownerId === ownerId && item.id === id,
    );
    if (index < 0) return false;

    this.items.splice(index, 1);
    return true;
  }

  async removeAll(ownerId: string): Promise<number> {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.ownerId !== ownerId);
    return before - this.items.length;
  }
}

class GatedListMemoryStore extends MemoryStore {
  private hold: boolean;
  private release: (() => void) | null = null;
  private startedResolve: (() => void) | null = null;
  listStarted: Promise<void>;

  constructor(hold = true) {
    super();
    this.hold = hold;
    this.listStarted = new Promise((resolve) => {
      this.startedResolve = resolve;
    });
  }

  holdNextList(): void {
    this.hold = true;
    this.listStarted = new Promise((resolve) => {
      this.startedResolve = resolve;
    });
  }

  releaseList(): void {
    this.release?.();
    this.release = null;
    this.hold = false;
  }

  override async list(ownerId: string): Promise<MemoryItem[]> {
    if (this.hold) {
      this.startedResolve?.();
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return super.list(ownerId);
  }
}

class MemoryLifecycle implements MemoryDerivationLifecycle {
  readonly events: string[] = [];

  async rememberSource(_item: MemoryItem, input: NewMemory): Promise<void> {
    this.events.push(
      `remember:${input.ownerId}:${input.sourceSequences?.join(",") ?? ""}`,
    );
  }

  async editSource(previous: MemoryItem): Promise<void> {
    this.events.push(`edit:${previous.ownerId}`);
  }

  async forgetSource(
    item: MemoryItem,
    reason = "forgotten",
  ): Promise<void> {
    this.events.push(`forget:${item.ownerId}:${reason}`);
  }

  async forgetPrivateOwner(ownerId: string): Promise<void> {
    this.events.push(`forget-all:${ownerId}`);
  }

  suspendPrivateOwner(ownerId: string): void {
    this.events.push(`suspend:${ownerId}`);
  }

  allowPrivateOwner(ownerId: string): void {
    this.events.push(`allow:${ownerId}`);
  }

  async drain(): Promise<void> {}
}

class FailOnceForgetAllLifecycle extends MemoryLifecycle {
  private failed = false;

  override async forgetPrivateOwner(ownerId: string): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("gagal sekali");
    }
    await super.forgetPrivateOwner(ownerId);
  }
}
