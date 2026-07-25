import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { StudentTask } from "../src/domain/task.js";
import { FileTaskRepository } from "../src/storage/file-task-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("FileTaskRepository", () => {
  it("menyimpan dan membaca ulang tugas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-test-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "nested", "tasks.json");
    const repository = new FileTaskRepository(filePath);
    const task = makeTask();

    await repository.save(task);

    const reloaded = new FileTaskRepository(filePath);
    assert.deepEqual(await reloaded.findById(task.ownerId, task.id), task);
  });

  it("mengambil pengingat yang sudah jatuh waktu hanya sekali", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harvy-test-"));
    temporaryDirectories.push(directory);
    const repository = new FileTaskRepository(join(directory, "tasks.json"));
    await repository.save(
      makeTask({
        reminderAt: "2026-07-25T09:00:00.000Z",
      }),
    );

    const due = await repository.listDueReminders(
      new Date("2026-07-25T10:00:00.000Z"),
    );
    assert.equal(due.length, 1);

    await repository.save({
      ...due[0]!,
      reminderSentAt: "2026-07-25T10:00:01.000Z",
    });
    assert.equal(
      (
        await repository.listDueReminders(
          new Date("2026-07-25T10:01:00.000Z"),
        )
      ).length,
      0,
    );
  });
});

function makeTask(overrides: Partial<StudentTask> = {}): StudentTask {
  return {
    id: "a1b2c3d4",
    ownerId: "student",
    chatId: "chat",
    title: "Tugas",
    dueAt: "2026-07-26T10:00:00.000Z",
    importance: 2,
    status: "active",
    createdAt: "2026-07-25T10:00:00.000Z",
    completedAt: null,
    reminderAt: null,
    reminderSentAt: null,
    ...overrides,
  };
}
