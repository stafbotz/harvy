import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryService } from "../src/core/memory-service.js";
import type { MemoryItem, MemoryRepository } from "../src/domain/memory.js";

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
});

/** Penyimpanan di memori proses, agar tes tidak menyentuh berkas nyata. */
class MemoryStore implements MemoryRepository {
  private items: MemoryItem[] = [];

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
