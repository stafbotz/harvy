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
  "",
  "Agar tidak menanyakannya setiap kali, aku akan menyimpan ID akun Telegram dan status jawabanmu. Aku tidak meminta kelas persis, nama sekolah, atau kartu pelajar.",
].join("\n");

export const FIRST_WELCOME_MESSAGE = [
  "Oke, kamu bisa lanjut.",
  "",
  "Harvy dirancang buat membantu hal yang ingin kamu beresin, pikirin, atau ceritain. Di versi percobaan yang aktif sekarang, yang sudah tersambung baru pengelolaan tugas. Aku nggak akan pura-pura memahami pesan bebas sebelum kemampuan itu siap.",
  "",
  "Kirim /bantuan untuk melihat yang sudah bisa dipakai. Aku tidak otomatis menjadikan pesanmu sebagai ingatan.",
].join("\n");

export const RETURNING_WELCOME_MESSAGE = [
  "Hai lagi.",
  "",
  "Versi percobaan ini baru bisa membantu merapikan tugas. Kirim /bantuan untuk melihat caranya; percakapan bebas masih sedang dibangun.",
].join("\n");

export const INELIGIBLE_MESSAGE = [
  "Terima kasih sudah jawab.",
  "",
  "Harvy versi percobaan ini baru bisa dipakai mulai kelas 8 SMP atau tingkat setara, jadi kita belum bisa lanjut.",
  "",
  "Agar ingat jawaban ini, aku menyimpan ID akun Telegram dan status kelayakan—bukan kelas persis, nama sekolah, atau kartu pelajar. Kalau tadi salah pilih, kamu bisa koreksi jawaban.",
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
