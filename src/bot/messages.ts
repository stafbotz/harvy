import { InlineKeyboard } from "grammy";
import type { StudentTask, TaskImportance } from "../domain/task.js";

const IMPORTANCE_LABEL: Record<TaskImportance, string> = {
  1: "santai",
  2: "biasa",
  3: "penting",
};

/**
 * Konstitusi Pasal 3.11: pengguna tidak boleh dipaksa menghafal perintah,
 * format tanggal, atau ID teknis. Seluruh teks di bawah ini memakai bahasa
 * sehari-hari dan tindakan dijalankan lewat tombol, bukan kode.
 */
export const HELP_MESSAGE = [
  "Tulis saja tugasmu seperti biasa, aku yang rapikan.",
  "",
  "Contoh:",
  "• besok jam 7 malam kumpulin matematika halaman 20",
  "• senin ada ulangan biologi, penting banget",
  "• bawa buku sejarah",
  "",
  "Setelah tercatat, tinggal pakai tombol untuk menandai selesai, memasang",
  "pengingat, atau membatalkan. Kamu yang menentukan, aku hanya membantu.",
  "",
  "/tugas — lihat semua tugasmu",
  "/bantuan — tampilkan pesan ini",
].join("\n");

export function formatTask(task: StudentTask, timeZone: string): string {
  const details = [IMPORTANCE_LABEL[task.importance], formatDue(task, timeZone)];

  if (task.reminderAt) {
    details.push(`🔔 ${formatMoment(task.reminderAt, timeZone, "short")}`);
  }

  return [`• ${task.title}`, `  ${details.join(" · ")}`].join("\n");
}

function formatDue(task: StudentTask, timeZone: string): string {
  if (!task.dueAt) return "tanpa tenggat";

  // Tenggat 23.59 berasal dari tanggal tanpa jam; menampilkannya sebagai jam
  // persis akan terasa lebih mendesak daripada yang pengguna maksud.
  const local = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(task.dueAt));

  const day = formatMoment(task.dueAt, timeZone, "medium", false);
  return local === "23.59" ? day : `${day} ${local}`;
}

function formatMoment(
  iso: string,
  timeZone: string,
  dateStyle: "short" | "medium",
  withTime = true,
): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle,
    ...(withTime ? { timeStyle: "short" as const } : {}),
    timeZone,
  }).format(new Date(iso));
}

/** Tombol untuk satu tugas yang baru saja dicatat atau diubah. */
export function taskActions(task: StudentTask): InlineKeyboard {
  const keyboard = new InlineKeyboard().text("✓ Selesai", `done:${task.id}`);

  if (task.dueAt) {
    keyboard.text("🔔 Ingatkan", `remind:${task.id}`);
  }

  return keyboard
    .row()
    .text("Ubah tenggat", `edit:${task.id}`)
    .text("Batalkan", `drop:${task.id}`);
}

/** Persetujuan sebelum sebuah pesan dicatat sebagai tugas. */
export function confirmActions(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Ya, catat", "save:")
    .text("Nggak usah", "nosave:");
}

/** Satu baris tombol per tugas, agar pengguna tidak perlu mengetik ID. */
export function taskListActions(tasks: StudentTask[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const task of tasks) {
    keyboard.text(`✓ ${shorten(task.title)}`, `done:${task.id}`).row();
  }

  return keyboard;
}

export function reminderActions(task: StudentTask): InlineKeyboard {
  return new InlineKeyboard()
    .text("✓ Selesai", `done:${task.id}`)
    .text("Ingatkan 1 jam lagi", `snooze:${task.id}`);
}

/**
 * Menjelaskan apa yang belum dipahami, agar pengguna dapat mengoreksi.
 *
 * Tugas yang lahir dari permintaan pengingat memang tidak punya tenggat, dan
 * menanyakannya di situ hanya membingungkan: pengguna sudah menyebut waktunya.
 */
export function understandingNote(task: StudentTask): string {
  if (task.dueAt || task.reminderAt) return "";

  return [
    "",
    "Aku belum menangkap kapan tenggatnya. Kalau ada, tekan Ubah tenggat.",
  ].join("\n");
}

function shorten(title: string, limit = 28): string {
  return title.length <= limit ? title : `${title.slice(0, limit - 1)}…`;
}
