import type {
  ExtractedTask,
  MemoryAction,
  Understanding,
} from "../ai/understand.js";

export type ImmediateUnderstandingRoute =
  | { kind: "memory-control"; action: "list" | "forget" }
  | { kind: "save-task"; task: ExtractedTask }
  | { kind: "conversation" };

/**
 * Menentukan cabang yang boleh menghentikan percakapan sebelum model membalas.
 *
 * Aksi disandingkan lagi dengan intent-nya sebagai pertahanan kedua setelah
 * parser. Objek model yang kontradiktif tidak boleh menyimpan tugas ataupun
 * membuka daftar memori hanya karena salah satu field kebetulan cocok.
 *
 * Pesan aslinya ikut diperiksa. Model kecil kadang memberi kombinasi yang sah
 * secara bentuk tetapi tidak berhubungan dengan kalimat yang benar-benar
 * ditulis pengguna, dan dua cabang di sinilah yang paling merugikan bila salah:
 * satu membuka seluruh daftar memori, satu lagi menulis data.
 */
export function immediateUnderstandingRoute(
  understanding: Understanding,
  message = "",
): ImmediateUnderstandingRoute {
  if (
    understanding.intent === "memory" &&
    isMemoryControl(understanding.memoryAction) &&
    looksLikeMemoryRequest(message)
  ) {
    return { kind: "memory-control", action: understanding.memoryAction };
  }

  if (
    understanding.intent === "task" &&
    understanding.taskAction === "save" &&
    understanding.task &&
    !isVagueTaskTitle(understanding.task.title)
  ) {
    return { kind: "save-task", task: understanding.task };
  }

  return { kind: "conversation" };
}

/**
 * Daftar memori hanya boleh terbuka bila pengguna memang menyinggung ingatan.
 *
 * Pada 26 Juli 2026 kalimat "iya kan aku udah tulis di situ kamu pahami aja"
 * membuka seluruh catatan pribadi seseorang, lengkap dengan tombol Lupakan
 * semua. Pengguna sedang minta ceritanya dibaca, bukan minta arsipnya dibuka.
 * Membuka daftar adalah tindakan yang sulit ditarik kembali, jadi ia menuntut
 * bukti yang lebih kuat daripada satu field JSON dari model termurah.
 */
export function looksLikeMemoryRequest(message: string): boolean {
  return /\b(?:inget|ingat|ingatan|mengingat|diingat|lupa|lupain|lupakan|melupakan|catatan|memori|memory|simpan|disimpan)\w*/i.test(
    message,
  );
}

/**
 * Judul yang hanya menyebut tindakan mencatat, tanpa pekerjaan di dalamnya.
 *
 * "eh buat pengingat dong" pernah tersimpan sebagai tugas berjudul "Membuat
 * pengingat" tanpa tenggat. Harvy bahkan sudah menanyakan isinya di kalimat
 * yang sama — lalu tetap menulis tugas kosong itu. Yang belum diketahui belum
 * boleh menjadi data.
 */
export function isVagueTaskTitle(title: string): boolean {
  const clean = title
    .trim()
    .toLocaleLowerCase("id-ID")
    .replace(/[.!?]+$/u, "");

  if (clean.length < 3) return true;

  return VAGUE_TITLE.some((pattern) => pattern.test(clean));
}

const TASK_VERB =
  "buat|buatin|bikin|bikinin|membuat|membikin|pasang|set|setel|atur|tambah|tambahin|menambah|catat|catatin|mencatat|ingatkan|mengingatkan|ingetin";
const TASK_NOUN = "pengingat|reminder|alarm|tugas|task|catatan|to-?do|daftar|jadwal";
const TAIL = "(?:\\s+(?:baru|dong|ya|aja|saja|nya))*";

const VAGUE_TITLE: readonly RegExp[] = [
  // "Membuat pengingat", "bikin tugas baru", "Pengingat"
  new RegExp(
    `^(?:mau\\s+|minta\\s+|tolong\\s+)?(?:${TASK_VERB})?\\s*(?:sebuah\\s+|satu\\s+)?(?:${TASK_NOUN})${TAIL}$`,
    "u",
  ),
  // "catat", "ingetin dong" — kata kerjanya saja, tanpa pekerjaan apa pun.
  new RegExp(
    `^(?:mau\\s+|minta\\s+|tolong\\s+)?(?:${TASK_VERB})${TAIL}$`,
    "u",
  ),
];

function isMemoryControl(
  action: MemoryAction | null,
): action is "list" | "forget" {
  return action === "list" || action === "forget";
}

/** Tugas tersirat hanya boleh ditawarkan setelah balasan empatik. */
export function taskToOffer(
  understanding: Understanding,
): ExtractedTask | null {
  if (
    understanding.intent === "feeling" &&
    understanding.taskAction === "offer" &&
    understanding.task &&
    !isVagueTaskTitle(understanding.task.title)
  ) {
    return understanding.task;
  }

  return null;
}
