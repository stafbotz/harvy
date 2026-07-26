export type TaskImportance = 1 | 2 | 3;
export type TaskStatus = "active" | "completed";

export interface StudentTask {
  id: string;
  ownerId: string;
  chatId: string;
  title: string;
  dueAt: string | null;
  importance: TaskImportance;
  status: TaskStatus;
  createdAt: string;
  completedAt: string | null;
  reminderAt: string | null;
  reminderSentAt: string | null;
}

export interface NewTask {
  ownerId: string;
  chatId: string;
  title: string;
  dueAt: Date | null;
  /** Hanya terisi bila pengguna memang meminta diingatkan pada waktu tertentu. */
  remindAt: Date | null;
  importance: TaskImportance;
}

export interface TaskRepository {
  save(task: StudentTask): Promise<void>;
  findById(ownerId: string, id: string): Promise<StudentTask | null>;
  listActive(ownerId: string): Promise<StudentTask[]>;
  listDueReminders(now: Date): Promise<StudentTask[]>;
  /** Menghapus tugas milik pengguna. Mengembalikan `false` bila tidak ada. */
  remove(ownerId: string, id: string): Promise<boolean>;
}
