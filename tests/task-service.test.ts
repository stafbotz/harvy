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
      remindAt: null,
      importance: 2,
    });
    await service.create({
      ownerId: "student-b",
      chatId: "chat-b",
      title: "Tugas B",
      dueAt: null,
      remindAt: null,
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
      remindAt: null,
      importance: 2,
    });

    const completed = await service.complete("student", task.id);
    assert.equal(completed?.status, "completed");
    assert.equal((await service.listActive("student")).length, 0);
  });

  it("membatalkan tugas tanpa menyisakan jejak", async () => {
    const service = new TaskService(new MemoryRepository());
    const task = await service.create({
      ownerId: "student",
      chatId: "chat",
      title: "Salah ketik",
      dueAt: null,
      remindAt: null,
      importance: 2,
    });

    assert.equal((await service.remove("student", task.id))?.title, "Salah ketik");
    assert.equal(await service.find("student", task.id), null);
    assert.equal(await service.remove("student", task.id), null);
  });

  it("tidak membiarkan pengguna lain menyentuh tugas orang", async () => {
    const service = new TaskService(new MemoryRepository());
    const task = await service.create({
      ownerId: "student-a",
      chatId: "chat-a",
      title: "Milik A",
      dueAt: null,
      remindAt: null,
      importance: 2,
    });

    assert.equal(await service.remove("student-b", task.id), null);
    assert.equal(await service.complete("student-b", task.id), null);
    assert.equal(await service.setDue("student-b", task.id, new Date()), null);
    assert.equal((await service.find("student-a", task.id))?.title, "Milik A");
  });

  it("mengubah tenggat tugas yang masih aktif", async () => {
    const service = new TaskService(new MemoryRepository());
    const task = await service.create({
      ownerId: "student",
      chatId: "chat",
      title: "Laporan",
      dueAt: null,
      remindAt: null,
      importance: 2,
    });

    const updated = await service.setDue(
      "student",
      task.id,
      new Date("2026-07-28T12:00:00.000Z"),
    );
    assert.equal(updated?.dueAt, "2026-07-28T12:00:00.000Z");
  });

  it("mengubah tenggat dan pengingat secara atomik dengan expected state", async () => {
    const service = new TaskService(
      new MemoryRepository(),
      () => new Date("2026-07-26T10:00:00.000Z"),
    );
    const task = await service.create({
      ownerId: "student",
      chatId: "chat",
      title: "Tinjau hasil live",
      dueAt: new Date("2026-07-27T02:00:00.000Z"),
      remindAt: new Date("2026-07-27T01:30:00.000Z"),
      importance: 3,
    });

    const updated = await service.updateSchedule("student", task.id, {
      dueAt: new Date("2026-07-27T03:30:00.000Z"),
      reminderAt: new Date("2026-07-27T02:30:00.000Z"),
      expected: {
        dueAt: task.dueAt,
        reminderAt: task.reminderAt,
      },
    });
    assert.equal(updated?.dueAt, "2026-07-27T03:30:00.000Z");
    assert.equal(updated?.reminderAt, "2026-07-27T02:30:00.000Z");

    assert.equal(await service.updateSchedule("student", task.id, {
      dueAt: new Date("2026-07-27T04:00:00.000Z"),
      expected: {
        dueAt: task.dueAt,
        reminderAt: task.reminderAt,
      },
    }), null);
    assert.equal(
      (await service.find("student", task.id))?.dueAt,
      "2026-07-27T03:30:00.000Z",
    );
  });

  it("memasang pengingat yang diminta lewat kalimat", async () => {
    const service = new TaskService(
      new MemoryRepository(),
      () => new Date("2026-07-26T10:00:00.000Z"),
    );

    const task = await service.create({
      ownerId: "student",
      chatId: "chat",
      title: "Minum obat",
      dueAt: null,
      remindAt: new Date("2026-07-26T13:00:00.000Z"),
      importance: 2,
    });

    assert.equal(task.reminderAt, "2026-07-26T13:00:00.000Z");
    assert.equal(task.reminderSentAt, null);
  });

  it("mengabaikan pengingat yang waktunya sudah lewat", async () => {
    const service = new TaskService(
      new MemoryRepository(),
      () => new Date("2026-07-26T10:00:00.000Z"),
    );

    const task = await service.create({
      ownerId: "student",
      chatId: "chat",
      title: "Sudah telat",
      dueAt: null,
      remindAt: new Date("2026-07-26T09:00:00.000Z"),
      importance: 2,
    });

    // Pengingat masa lalu akan terkirim pada detik pencatatan; itu salah baca
    // model, bukan permintaan pengguna.
    assert.equal(task.reminderAt, null);
  });

  it("tidak mengulang pengingat ketika hasil transport tidak dapat dipastikan", async () => {
    const repository = new MemoryRepository();
    let now = new Date("2026-07-26T10:00:00.000Z");
    const service = new TaskService(repository, () => now);
    const task = await service.create({
      ownerId: "student",
      chatId: "chat",
      title: "Minum obat",
      dueAt: null,
      remindAt: new Date("2026-07-26T11:00:00.000Z"),
      importance: 2,
    });
    now = new Date("2026-07-26T11:00:00.000Z");
    let attempts = 0;

    await assert.rejects(
      service.deliverReminder(task, async () => {
        attempts += 1;
        throw new Error("hasil send tidak diketahui");
      }),
      /tidak diketahui/u,
    );
    const stored = await service.find("student", task.id);
    assert.equal(stored?.reminderDelivery?.status, "unknown");
    assert.equal(stored?.reminderSentAt, null);
    assert.equal((await service.dueReminders()).length, 0);
    assert.equal(
      await service.deliverReminder(task, async () => {
        attempts += 1;
      }),
      false,
    );
    assert.equal(attempts, 1);
  });

  it("menyelesaikan delivery lama sebelum menyimpan jadwal baru pemilik yang sama", async () => {
    const repository = new MemoryRepository();
    let now = new Date("2026-07-26T10:00:00.000Z");
    const service = new TaskService(repository, () => now);
    const task = await service.create({
      ownerId: "student",
      chatId: "chat",
      title: "Minum obat",
      dueAt: null,
      remindAt: new Date("2026-07-26T11:00:00.000Z"),
      importance: 2,
    });
    now = new Date("2026-07-26T11:00:00.000Z");
    let releaseDelivery!: () => void;
    let deliveryStarted!: () => void;
    const held = new Promise<void>((resolvePromise) => {
      releaseDelivery = resolvePromise;
    });
    const started = new Promise<void>((resolvePromise) => {
      deliveryStarted = resolvePromise;
    });

    const delivery = service.deliverReminder(task, async () => {
      deliveryStarted();
      await held;
    });
    await started;
    const rescheduled = service.setReminder(
      "student",
      task.id,
      new Date("2026-07-27T11:00:00.000Z"),
    );
    releaseDelivery();

    assert.equal(await delivery, true);
    const updated = await rescheduled;
    assert.equal(updated?.reminderAt, "2026-07-27T11:00:00.000Z");
    assert.equal(updated?.reminderSentAt, null);
    assert.equal(updated?.reminderDelivery, null);
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

  async remove(ownerId: string, id: string): Promise<boolean> {
    const index = this.tasks.findIndex(
      (task) => task.ownerId === ownerId && task.id === id,
    );
    if (index < 0) return false;

    this.tasks.splice(index, 1);
    return true;
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

  async list(ownerId: string): Promise<StudentTask[]> {
    return this.tasks.filter((task) => task.ownerId === ownerId);
  }

  async removeAll(ownerId: string): Promise<number> {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.ownerId !== ownerId);
    return before - this.tasks.length;
  }

  async listDueReminders(now: Date): Promise<StudentTask[]> {
    return this.tasks.filter(
      (task) =>
        task.status === "active" &&
        task.reminderAt !== null &&
        task.reminderSentAt === null &&
        task.reminderDelivery == null &&
        new Date(task.reminderAt).getTime() <= now.getTime(),
    );
  }
}
