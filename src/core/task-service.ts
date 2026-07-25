import { randomUUID } from "node:crypto";
import type {
  NewTask,
  StudentTask,
  TaskRepository,
} from "../domain/task.js";
import { sortTasksByPriority } from "./prioritizer.js";

export class TaskService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: NewTask): Promise<StudentTask> {
    const title = input.title.trim();
    if (!title) {
      throw new Error("Judul tugas tidak boleh kosong.");
    }

    const createdAt = this.now().toISOString();
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
      reminderAt: null,
      reminderSentAt: null,
    };

    await this.repository.save(task);
    return task;
  }

  async listActive(ownerId: string): Promise<StudentTask[]> {
    const tasks = await this.repository.listActive(ownerId);
    return sortTasksByPriority(tasks, this.now());
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
    await this.repository.save({
      ...task,
      reminderSentAt: this.now().toISOString(),
    });
  }
}
