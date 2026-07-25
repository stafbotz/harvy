import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EligibilityService } from "../src/core/eligibility-service.js";
import type {
  EligibilityRecord,
  EligibilityRepository,
} from "../src/domain/user-profile.js";

describe("EligibilityService", () => {
  it("mengembalikan null sebelum pengguna menjawab", async () => {
    const service = new EligibilityService(new MemoryEligibilityRepository());
    assert.equal(await service.getStatus("student"), null);
  });

  it("menyimpan hanya status kelayakan untuk setiap pengguna", async () => {
    const repository = new MemoryEligibilityRepository();
    const service = new EligibilityService(repository);

    await service.setStatus("student-a", "eligible");
    await service.setStatus("student-b", "ineligible");

    assert.deepEqual(repository.records, [
      { ownerId: "student-a", status: "eligible" },
      { ownerId: "student-b", status: "ineligible" },
    ]);
  });

  it("menghapus jawaban agar pengguna dapat mengoreksinya", async () => {
    const service = new EligibilityService(new MemoryEligibilityRepository());
    await service.setStatus("student", "ineligible");

    await service.clearStatus("student");

    assert.equal(await service.getStatus("student"), null);
  });

  it("menyimpan dan menarik persetujuan AI tanpa menghapus kelayakan", async () => {
    const service = new EligibilityService(new MemoryEligibilityRepository());
    await service.setStatus("student", "eligible");

    await service.setAiConsent("student", "granted");
    assert.equal(await service.getAiConsent("student"), "granted");

    await service.clearAiConsent("student");
    assert.equal(await service.getAiConsent("student"), null);
    assert.equal(await service.getStatus("student"), "eligible");
  });

  it("menolak persetujuan AI untuk pengguna yang belum eligible", async () => {
    const service = new EligibilityService(new MemoryEligibilityRepository());

    await assert.rejects(
      service.setAiConsent("student", "granted"),
      /hanya tersedia untuk pengguna eligible/,
    );
  });

  it("menghapus persetujuan ketika status berubah menjadi ineligible", async () => {
    const service = new EligibilityService(new MemoryEligibilityRepository());
    await service.setStatus("student", "eligible");
    await service.setAiConsent("student", "granted");

    await service.setStatus("student", "ineligible");

    assert.equal(await service.getStatus("student"), "ineligible");
    assert.equal(await service.getAiConsent("student"), null);
  });
});

class MemoryEligibilityRepository implements EligibilityRepository {
  records: EligibilityRecord[] = [];

  async find(ownerId: string): Promise<EligibilityRecord | null> {
    return this.records.find((record) => record.ownerId === ownerId) ?? null;
  }

  async save(record: EligibilityRecord): Promise<void> {
    const index = this.records.findIndex(
      (item) => item.ownerId === record.ownerId,
    );
    if (index >= 0) this.records[index] = record;
    else this.records.push(record);
  }

  async delete(ownerId: string): Promise<void> {
    this.records = this.records.filter((record) => record.ownerId !== ownerId);
  }
}
