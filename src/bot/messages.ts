import { InlineKeyboard } from "grammy";
import type { MemoryItem, MemoryKind } from "../domain/memory.js";
import type { StudentTask, TaskImportance } from "../domain/task.js";

const IMPORTANCE_LABEL: Record<TaskImportance, string> = {
  1: "santai",
  2: "biasa",
  3: "penting",
};

/**
 * Nama jenis memori dalam bahasa yang dimengerti pengguna.
 *
 * Konstitusi Pasal 4 nomor 4 memberi hak menghapus satu memori. Hak itu hanya
 * berguna kalau pemiliknya paham apa yang sedang ia hapus, sehingga label
 * teknis seperti "context" tidak boleh muncul di layar.
 */
const KIND_LABEL: Record<MemoryKind, string> = {
  profile: "tentang kamu",
  preference: "cara belajarmu",
  routine: "kebiasaanmu",
  context: "yang sedang berjalan",
  personal: "hal pribadi",
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
  "Aku juga mengingat beberapa hal supaya kamu tidak perlu mengulang diri:",
  "kelasmu, cara belajar yang cocok, apa yang sedang kamu hadapi. Untuk hal",
  "pribadi aku selalu bertanya dulu. Tanya saja “apa yang kamu ingat tentang",
  "aku”, dan kamu bisa menyuruhku melupakan apa pun kapan saja.",
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

/**
 * Pemberitahuan bahwa sesuatu baru saja diingat.
 *
 * Pasal 4 nomor 2 meminta pengguna tahu sebelum sesuatu yang baru disimpan.
 * Untuk memori biasa, Harvy tidak meminta izin — tetapi ia tetap harus
 * mengatakannya, dan jalan keluarnya harus ada di pesan yang sama.
 */
export function memorySavedNote(item: MemoryItem): string {
  return `📎 Aku ingat ini: ${item.content}`;
}

export function memorySavedActions(item: MemoryItem): InlineKeyboard {
  return new InlineKeyboard().text("Lupakan", `memforget:${item.id}`);
}

/** Persetujuan sebelum hal sensitif disimpan. Pasal 4 nomor 3. */
export function memoryConsentActions(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Boleh diingat", "memsave:")
    .text("Jangan", "memskip:");
}

export function formatMemories(items: MemoryItem[]): string {
  if (items.length === 0) {
    return [
      "Sejauh ini aku belum mengingat apa pun tentang kamu.",
      "",
      "Kalau nanti ada yang kusimpan, aku selalu bilang, dan kamu bisa",
      "menyuruhku melupakannya kapan saja.",
    ].join("\n");
  }

  return [
    "Ini yang aku ingat tentang kamu:",
    "",
    ...items.map((item) => `• ${item.content}\n  ${KIND_LABEL[item.kind]}`),
    "",
    "Tekan tombolnya kalau ada yang mau aku lupakan.",
  ].join("\n");
}

export function memoryListActions(items: MemoryItem[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const item of items) {
    keyboard.text(`Lupakan: ${shorten(item.content)}`, `memforget:${item.id}`).row();
  }

  return keyboard.text("Lupakan semua tentang aku", "memall:");
}

/**
 * Menghapus seluruh ingatan tidak dapat dibatalkan, jadi ia dikonfirmasi.
 *
 * Ini bukan penghalang: Pasal 4 nomor 5 melarang penarikan izin dipersulit.
 * Satu ketukan tambahan yang menjelaskan akibatnya bukan mempersulit, melainkan
 * memenuhi Pasal 3.11 soal menunjukkan konsekuensi sebelum tindakan penting.
 */
export function memoryWipeConfirmActions(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Ya, lupakan semua", "memallyes:")
    .text("Batal", "memallno:");
}
