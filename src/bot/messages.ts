import type { StudentTask, TaskImportance } from "../domain/task.js";

const IMPORTANCE_LABEL: Record<TaskImportance, string> = {
  1: "rendah",
  2: "sedang",
  3: "tinggi",
};

export const HELP_MESSAGE = [
  "Aku bisa bantu merapikan tugasmu.",
  "",
  "Tambah tugas:",
  "/tambah Matematika halaman 20 | 2026-07-28 19:00 | tinggi",
  "",
  "Tenggat dan prioritas boleh dikosongkan:",
  "/tambah Bawa buku sejarah",
  "",
  "Perintah lain:",
  "/tugas — lihat tugas aktif",
  "/selesai ID — tandai selesai",
  "/ingatkan ID | 2026-07-28 17:00 — pasang pengingat",
  "/bantuan — tampilkan panduan",
].join("\n");

export function formatTask(task: StudentTask, timeZone: string): string {
  const due = task.dueAt
    ? new Intl.DateTimeFormat("id-ID", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(new Date(task.dueAt))
    : "tanpa tenggat";

  const reminder = task.reminderAt
    ? ` · pengingat ${new Intl.DateTimeFormat("id-ID", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone,
      }).format(new Date(task.reminderAt))}`
    : "";

  return [
    `• ${task.title}`,
    `  ID ${task.id} · ${IMPORTANCE_LABEL[task.importance]} · ${due}${reminder}`,
  ].join("\n");
}
