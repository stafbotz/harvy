import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskService } from "../src/core/task-service.js";
import type { StudentTask, TaskRepository } from "../src/domain/task.js";

describe("TaskService", () => {
  it("mengisolasi tugas berdasarkan pemilik", async () => {
    const repository = new MemoryRepository();
    const service = new TaskService(
      repository,
      () => new Date("2026-07-25T10:00:00.000Z"),
    );

    await service.create({
      ownerId: "student-a",
      chatId: "chat-a",
      title: "Tugas A",
      dueAt: null,
      importance: 2,
    });
    await service.create({
      ownerId: "student-b",
      chatId: "chat-b",
      title: "Tugas B",
      dueAt: null,
      importance: 2,
    });

    const tasks = await service.listActive("student-a");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.title, "Tugas A");
  });

  it("menandai tugas selesai", async () => {
    const repository = new MemoryRepository();
    const service = new TaskService(repository);
    const task = await service.create({
      ownerId: "student",
      chatId: "chat",
      title: "Tugas",
      dueAt: null,
      importance: 2,
    });

    const completed = await service.complete("student", task.id);
    assert.equal(completed?.status, "completed");
    assert.equal((await service.listActive("student")).length, 0);
  });
});

class MemoryRepository implements TaskRepository {
  private tasks: StudentTask[] = [];

  async save(task: StudentTask): Promise<void> {
    const index = this.tasks.findIndex(
      (item) => item.ownerId === task.ownerId && item.id === task.id,
    );
    if (index >= 0) this.tasks[index] = task;
    else this.tasks.push(task);
  }

  async findById(ownerId: string, id: string): Promise<StudentTask | null> {
    return (
      this.tasks.find(
        (task) => task.ownerId === ownerId && task.id === id,
      ) ?? null
    );
  }

  async listActive(ownerId: string): Promise<StudentTask[]> {
    return this.tasks.filter(
      (task) => task.ownerId === ownerId && task.status === "active",
    );
  }

  async listDueReminders(now: Date): Promise<StudentTask[]> {
    return this.tasks.filter(
      (task) =>
        task.status === "active" &&
        task.reminderAt !== null &&
        task.reminderSentAt === null &&
        new Date(task.reminderAt).getTime() <= now.getTime(),
    );
  }
}
