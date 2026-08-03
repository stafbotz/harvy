import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InsightService } from "../src/core/insight-service.js";
import type {
  InsightRepository,
  UserInsight,
} from "../src/domain/insight.js";

describe("InsightService", () => {
  it("membersihkan inferensi tersembunyi warisan ketika dibaca", async () => {
    const repository = new InsightStore();
    const now = new Date("2026-07-28T00:00:00.000Z");
    const service = new InsightService(
      repository,
      async () => {
        throw new Error("reader lama tidak boleh dipanggil");
      },
      () => now,
    );

    await repository.save({
      ownerId: "student",
      gaya: "tenang",
      tahap: "sekolah menengah",
      kerentanan: "takut ditinggalkan",
      catatan: [
        {
          at: "2026-07-27T00:00:00.000Z",
          level: "bahaya",
          ringkasan: "sedang tidak aman",
          tindakan: "menemani",
        },
      ],
      terakhirMenyarankanBantuan: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-27T01:00:00.000Z",
    });

    const loaded = await service.load("student");

    assert.equal(loaded.gaya, null);
    assert.equal(loaded.tahap, null);
    assert.equal(loaded.kerentanan, null);
    assert.equal(loaded.terakhirMenyarankanBantuan, null);
    assert.equal(loaded.catatan.length, 1);
    assert.deepEqual(await repository.load("student"), loaded);
  });

  it("refresh lama tidak memanggil model atau menghidupkan inferensi lagi", async () => {
    const repository = new InsightStore();
    let reads = 0;
    const service = new InsightService(repository, async () => {
      reads += 1;
      return {
        gaya: "ringkas",
        tahap: "sekolah menengah",
        kerentanan: "cemas",
      };
    });

    await service.refresh("student", "ringkasan", [
      {
        role: "user",
        text: "aku sedang belajar",
        at: "2026-07-27T02:00:00.000Z",
      },
    ]);

    assert.equal(reads, 0);
    assert.equal((await repository.load("student"))?.gaya, undefined);
  });
});

class InsightStore implements InsightRepository {
  private insight: UserInsight | null = null;

  async load(ownerId: string): Promise<UserInsight | null> {
    if (this.insight?.ownerId !== ownerId) return null;
    return structuredClone(this.insight);
  }

  async save(insight: UserInsight): Promise<void> {
    this.insight = structuredClone(insight);
  }

  async remove(ownerId: string): Promise<boolean> {
    if (this.insight?.ownerId !== ownerId) return false;
    this.insight = null;
    return true;
  }
}
