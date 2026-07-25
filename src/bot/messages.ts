import type { StudentTask, TaskImportance } from "../domain/task.js";

const IMPORTANCE_LABEL: Record<TaskImportance, string> = {
  1: "rendah",
  2: "sedang",
  3: "tinggi",
};

export const ELIGIBILITY_PROMPT = [
  "Hai, aku Harvy. Aku AI pendamping buat pelajar.",
  "",
  "Sebelum ngobrol lebih jauh, aku perlu cek satu hal dulu: kamu sudah kelas 8 SMP, tingkat setara, atau lebih tinggi?",
].join("\n");

export const FIRST_WELCOME_MESSAGE = [
  "Oke. Gimana harimu? Ada yang lagi pengin kamu beresin, pikirin, atau ceritain?",
  "",
  "Aku tidak otomatis menjadikan ceritamu sebagai ingatan. Kalau nanti ada yang berguna untuk disimpan, aku akan minta izin dulu.",
].join("\n");

export const RETURNING_WELCOME_MESSAGE =
  "Hai lagi. Hari ini gimana? Ada yang lagi pengin kamu beresin, pikirin, atau ceritain?";

export const INELIGIBLE_MESSAGE = [
  "Terima kasih sudah jawab.",
  "",
  "Harvy versi percobaan ini baru bisa dipakai mulai kelas 8 SMP atau tingkat setara, jadi kita belum bisa lanjut.",
  "",
  "Aku hanya menyimpan status kelayakan akunmu—bukan kelas persis, nama sekolah, atau kartu pelajar. Kalau tadi salah pilih, kamu bisa koreksi jawaban.",
].join("\n");

export const FREE_TEXT_LIMIT_MESSAGE = [
  "Aku sudah membaca pesanmu, tapi kemampuan memahami cerita bebas belum tersambung di versi ini. Aku tidak mau pura-pura paham.",
  "",
  "Untuk sekarang, kemampuan yang sudah bisa dipakai adalah merapikan tugas. Kirim /bantuan untuk melihat caranya.",
].join("\n");

export const HELP_MESSAGE = [
  "Harvy dirancang untuk mendampingi kehidupan pelajar secara lebih luas. Versi percobaan yang sudah aktif sekarang baru bisa membantu merapikan tugas.",
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
