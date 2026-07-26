import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StudentTask, TaskRepository } from "../domain/task.js";

interface TaskDatabase {
  version: 1;
  tasks: StudentTask[];
}

export class FileTaskRepository implements TaskRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async save(task: StudentTask): Promise<void> {
    await this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.tasks.findIndex(
        (item) => item.ownerId === task.ownerId && item.id === task.id,
      );

      if (index >= 0) {
        database.tasks[index] = task;
      } else {
        database.tasks.push(task);
      }

      await this.writeDatabase(database);
    });
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.tasks.findIndex(
        (task) => task.ownerId === ownerId && task.id === id,
      );
      if (index < 0) return false;

      database.tasks.splice(index, 1);
      await this.writeDatabase(database);
      return true;
    });
  }

  async findById(ownerId: string, id: string): Promise<StudentTask | null> {
    const database = await this.readDatabase();
    return (
      database.tasks.find(
        (task) => task.ownerId === ownerId && task.id === id,
      ) ?? null
    );
  }

  async listActive(ownerId: string): Promise<StudentTask[]> {
    const database = await this.readDatabase();
    return database.tasks.filter(
      (task) => task.ownerId === ownerId && task.status === "active",
    );
  }

  async listDueReminders(now: Date): Promise<StudentTask[]> {
    const database = await this.readDatabase();
    return database.tasks.filter(
      (task) =>
        task.status === "active" &&
        task.reminderAt !== null &&
        task.reminderSentAt === null &&
        new Date(task.reminderAt).getTime() <= now.getTime(),
    );
  }

  private async readDatabase(): Promise<TaskDatabase> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as TaskDatabase;
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
        throw new Error("Format basis data tugas tidak dikenali.");
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, tasks: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: TaskDatabase): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(database, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, this.filePath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
