import { randomUUID } from "node:crypto";
import type {
  NewTask,
  StudentTask,
  TaskRepository,
} from "../domain/task.js";
import { sortTasksByPriority } from "./prioritizer.js";

export interface TaskScheduleUpdate {
  dueAt?: Date | null;
  reminderAt?: Date | null;
  expected?: {
    dueAt: string | null;
    reminderAt: string | null;
  };
}

export class TaskService {
  private readonly ownerQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: TaskRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: NewTask): Promise<StudentTask> {
    return this.exclusiveOwner(input.ownerId, async () => {
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
        reminderDelivery: null,
      };

      await this.repository.save(task);
      return task;
    });
  }

  async listActive(ownerId: string): Promise<StudentTask[]> {
    const tasks = await this.repository.listActive(ownerId);
    return sortTasksByPriority(tasks, this.now());
  }

  async listAll(ownerId: string): Promise<StudentTask[]> {
    return this.repository.list(ownerId);
  }

  async complete(ownerId: string, id: string): Promise<StudentTask | null> {
    return this.exclusiveOwner(ownerId, async () => {
      const task = await this.repository.findById(ownerId, id);
      if (!task || task.status === "completed") return null;

      const completed = {
        ...task,
        status: "completed" as const,
        completedAt: this.now().toISOString(),
      };
      await this.repository.save(completed);
      return completed;
    });
  }

  async find(ownerId: string, id: string): Promise<StudentTask | null> {
    return this.repository.findById(ownerId, id);
  }

  async setDue(
    ownerId: string,
    id: string,
    dueAt: Date | null,
  ): Promise<StudentTask | null> {
    return this.exclusiveOwner(ownerId, async () => {
      const task = await this.repository.findById(ownerId, id);
      if (!task || task.status === "completed") return null;

      const updated = { ...task, dueAt: dueAt?.toISOString() ?? null };
      await this.repository.save(updated);
      return updated;
    });
  }

  /** Membatalkan tugas sepenuhnya, bukan menandainya selesai. */
  async remove(ownerId: string, id: string): Promise<StudentTask | null> {
    return this.exclusiveOwner(ownerId, async () => {
      const task = await this.repository.findById(ownerId, id);
      if (!task) return null;

      return (await this.repository.remove(ownerId, id)) ? task : null;
    });
  }

  /** Mengubah tenggat+pengingat dalam satu commit owner-serialized. */
  async updateSchedule(
    ownerId: string,
    id: string,
    update: TaskScheduleUpdate,
  ): Promise<StudentTask | null> {
    if (update.dueAt === undefined && update.reminderAt === undefined) {
      throw new Error("Perubahan jadwal tugas tidak boleh kosong.");
    }
    return this.exclusiveOwner(ownerId, async () => {
      const task = await this.repository.findById(ownerId, id);
      if (!task || task.status === "completed") return null;
      if (
        update.expected &&
        (task.dueAt !== update.expected.dueAt ||
          task.reminderAt !== update.expected.reminderAt)
      ) {
        return null;
      }
      if (
        update.reminderAt instanceof Date &&
        update.reminderAt.getTime() <= this.now().getTime()
      ) {
        throw new Error("Waktu pengingat harus berada di masa depan.");
      }
      const reminderChanged = update.reminderAt !== undefined;
      const updated: StudentTask = {
        ...task,
        dueAt: update.dueAt === undefined
          ? task.dueAt
          : update.dueAt?.toISOString() ?? null,
        reminderAt: update.reminderAt === undefined
          ? task.reminderAt
          : update.reminderAt?.toISOString() ?? null,
        ...(reminderChanged
          ? { reminderSentAt: null, reminderDelivery: null }
          : {}),
      };
      await this.repository.save(updated);
      return updated;
    });
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
    return this.exclusiveOwner(ownerId, async () => {
      const task = await this.repository.findById(ownerId, id);
      if (!task || task.status === "completed") return null;

      const updated = {
        ...task,
        reminderAt: reminderAt.toISOString(),
        reminderSentAt: null,
        reminderDelivery: null,
      };
      await this.repository.save(updated);
      return updated;
    });
  }

  async dueReminders(now = this.now()): Promise<StudentTask[]> {
    return this.repository.listDueReminders(now);
  }

  /**
   * Mengunci pengiriman terhadap seluruh mutasi tugas pemilik yang sama.
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
        current.reminderSentAt !== null ||
        current.reminderDelivery != null
      ) {
        return false;
      }

      const preparedAt = this.now().toISOString();
      const prepared: StudentTask = {
        ...current,
        reminderDelivery: {
          effectId: randomUUID(),
          status: "in_flight",
          preparedAt,
          completedAt: null,
        },
      };
      // Commit intent sebelum I/O. Jika proses mati sesudah titik ini, record
      // tidak masuk due list lagi dan Harvy tidak mengirim duplikat.
      await this.repository.save(prepared);
      try {
        await deliver(prepared);
      } catch (error) {
        const completedAt = this.now().toISOString();
        await this.repository.save({
          ...prepared,
          reminderDelivery: {
            ...prepared.reminderDelivery!,
            status: "unknown",
            completedAt,
          },
        }).catch(() => undefined);
        throw error;
      }
      const completedAt = this.now().toISOString();
      await this.repository.save({
        ...prepared,
        reminderSentAt: completedAt,
        reminderDelivery: {
          ...prepared.reminderDelivery!,
          status: "sent",
          completedAt,
        },
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
