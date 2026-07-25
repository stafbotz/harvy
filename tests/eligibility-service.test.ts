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
