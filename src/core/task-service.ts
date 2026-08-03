import { randomUUID } from "node:crypto";
import type {
  NewTask,
  StudentTask,
  TaskRepository,
} from "../domain/task.js";
import { sortTasksByPriority } from "./prioritizer.js";

export class TaskService {
  private readonly ownerQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: TaskRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: NewTask): Promise<StudentTask> {
    const title = input.title.trim();
    if (!title) {
      throw new Error("Judul tugas tidak boleh kosong.");
    }

    const now = this.now();
    const createdAt = now.toISOString();

    // Pengingat yang waktunya sudah lewat berarti salah baca, bukan permintaan
    // pengguna. Memasangnya akan membuat Harvy menegur pada detik yang sama
    // dengan pencatatan.
    const remindAt =
      input.remindAt && input.remindAt.getTime() > now.getTime()
        ? input.remindAt
        : null;

    const task: StudentTask = {
      id: randomUUID().replaceAll("-", "").slice(0, 8),
      ownerId: input.ownerId,
      chatId: input.chatId,
      title,
      dueAt: input.dueAt?.toISOString() ?? null,
      importance: input.importance,
      status: "active",
      createdAt,
      completedAt: null,
      reminderAt: remindAt?.toISOString() ?? null,
      reminderSentAt: null,
    };

    await this.repository.save(task);
    return task;
  }

  async listActive(ownerId: string): Promise<StudentTask[]> {
    const tasks = await this.repository.listActive(ownerId);
    return sortTasksByPriority(tasks, this.now());
  }

  async listAll(ownerId: string): Promise<StudentTask[]> {
    return this.repository.list(ownerId);
  }

  async complete(ownerId: string, id: string): Promise<StudentTask | null> {
    const task = await this.repository.findById(ownerId, id);
    if (!task || task.status === "completed") return null;

    const completed = {
      ...task,
      status: "completed" as const,
      completedAt: this.now().toISOString(),
    };
    await this.repository.save(completed);
    return completed;
  }

  async find(ownerId: string, id: string): Promise<StudentTask | null> {
    return this.repository.findById(ownerId, id);
  }

  async setDue(
    ownerId: string,
    id: string,
    dueAt: Date | null,
  ): Promise<StudentTask | null> {
    const task = await this.repository.findById(ownerId, id);
    if (!task || task.status === "completed") return null;

    const updated = { ...task, dueAt: dueAt?.toISOString() ?? null };
    await this.repository.save(updated);
    return updated;
  }

  /** Membatalkan tugas sepenuhnya, bukan menandainya selesai. */
  async remove(ownerId: string, id: string): Promise<StudentTask | null> {
    const task = await this.repository.findById(ownerId, id);
    if (!task) return null;

    return (await this.repository.remove(ownerId, id)) ? task : null;
  }

  async removeAll(ownerId: string): Promise<number> {
    return this.exclusiveOwner(ownerId, () =>
      this.repository.removeAll(ownerId),
    );
  }

  async setReminder(
    ownerId: string,
    id: string,
    reminderAt: Date,
  ): Promise<StudentTask | null> {
    const task = await this.repository.findById(ownerId, id);
    if (!task || task.status === "completed") return null;

    const updated = {
      ...task,
      reminderAt: reminderAt.toISOString(),
      reminderSentAt: null,
    };
    await this.repository.save(updated);
    return updated;
  }

  async dueReminders(now = this.now()): Promise<StudentTask[]> {
    return this.repository.listDueReminders(now);
  }

  async markReminderSent(task: StudentTask): Promise<void> {
    const current = await this.repository.findById(task.ownerId, task.id);
    if (
      !current ||
      current.status !== "active" ||
      current.reminderAt !== task.reminderAt ||
      current.reminderSentAt !== null
    ) {
      return;
    }

    await this.repository.save({
      ...current,
      reminderSentAt: this.now().toISOString(),
    });
  }

  /**
   * Mengunci pengiriman terhadap penghapusan seluruh tugas pemilik yang sama.
   *
   * Kalau penghapusan menang antrean, snapshot lama tidak dikirim. Kalau
   * pengiriman menang, penghapusan menunggu lalu membuang hasil akhirnya.
   */
  async deliverReminder(
    candidate: StudentTask,
    deliver: (current: StudentTask) => Promise<void>,
  ): Promise<boolean> {
    return this.exclusiveOwner(candidate.ownerId, async () => {
      const current = await this.repository.findById(
        candidate.ownerId,
        candidate.id,
      );
      if (
        !current ||
        current.status !== "active" ||
        current.reminderAt !== candidate.reminderAt ||
        current.reminderSentAt !== null
      ) {
        return false;
      }

      await deliver(current);
      await this.repository.save({
        ...current,
        reminderSentAt: this.now().toISOString(),
      });
      return true;
    });
  }

  private async exclusiveOwner<T>(
    ownerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.ownerQueues.get(ownerId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.ownerQueues.set(ownerId, settled);

    try {
      return await result;
    } finally {
      if (this.ownerQueues.get(ownerId) === settled) {
        this.ownerQueues.delete(ownerId);
      }
    }
  }
}
