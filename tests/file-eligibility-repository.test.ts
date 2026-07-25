import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { FileEligibilityRepository } from "../src/storage/file-eligibility-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("FileEligibilityRepository", () => {
  it("menyimpan status tanpa kelas, sekolah, atau identitas tambahan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-eligibility-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "nested", "eligibility.json");
    const repository = new FileEligibilityRepository(filePath);

    await repository.save({ ownerId: "student", status: "eligible" });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      records: unknown[];
    };
    assert.deepEqual(raw.records, [
      { ownerId: "student", status: "eligible" },
    ]);
  });

  it("memperbarui jawaban dan dapat menghapusnya", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-eligibility-"));
    temporaryDirectories.push(directory);
    const repository = new FileEligibilityRepository(
      join(directory, "eligibility.json"),
    );

    await repository.save({ ownerId: "student", status: "ineligible" });
    await repository.save({ ownerId: "student", status: "eligible" });
    assert.equal((await repository.find("student"))?.status, "eligible");

    await repository.delete("student");
    assert.equal(await repository.find("student"), null);
  });

  it("menyimpan hanya status persetujuan AI tambahan yang diperlukan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-eligibility-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "eligibility.json");
    const repository = new FileEligibilityRepository(filePath);

    await repository.save({
      ownerId: "student",
      status: "eligible",
      aiConsent: "granted",
    });

    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      records: unknown[];
    };
    assert.deepEqual(raw.records, [
      {
        ownerId: "student",
        status: "eligible",
        aiConsent: "granted",
      },
    ]);
  });
});
