import type {
  ExtractedTask,
  ControlAction,
  MemoryAction,
  Understanding,
} from "../ai/understand.js";

export type ImmediateUnderstandingRoute =
  | { kind: "memory-control"; action: "list" | "edit" }
  | { kind: "memory-control"; action: "forget"; target: string | null }
  | { kind: "control"; action: ControlAction }
  | { kind: "save-task"; task: ExtractedTask }
  | { kind: "conversation" };

/**
 * Menentukan cabang yang boleh menghentikan percakapan sebelum model membalas.
 *
 * Aksi disandingkan lagi dengan intent-nya sebagai pertahanan kedua setelah
 * parser. Objek model yang kontradiktif tidak boleh menyimpan tugas ataupun
 * membuka daftar memori hanya karena salah satu field kebetulan cocok.
 *
 * Sampai 27 Juli 2026 dua pagar lokal berbasis pola ikut memeriksa teks
 * aslinya, karena model kecil pernah membuka seluruh daftar memori untuk
 * kalimat "kamu pahami aja" dan menulis tugas kosong berjudul "Membuat
 * pengingat". Keduanya diganti aturan yang lebih tegas di dalam prompt
 * ekstraksi, atas keputusan pemilik produk. Yang tersisa di sini adalah
 * pemeriksaan bentuk: intent dan aksi harus sejalan sebelum data berubah.
 */
export function immediateUnderstandingRoute(
  understanding: Understanding,
  originalMessage = "",
): ImmediateUnderstandingRoute {
  if (
    understanding.intent === "memory" &&
    isMemoryControl(understanding.memoryAction)
  ) {
    return understanding.memoryAction === "forget"
      ? {
          kind: "memory-control",
          action: "forget",
          target: understanding.memoryTarget?.trim() || null,
        }
      : { kind: "memory-control", action: understanding.memoryAction };
  }

  if (
    understanding.intent === "control" &&
    understanding.controlAction !== null &&
    understanding.controlAction !== undefined
  ) {
    return { kind: "control", action: understanding.controlAction };
  }

  if (
    understanding.intent === "task" &&
    understanding.taskAction === "save" &&
    understanding.task &&
    hasExplicitTaskWriteRequest(originalMessage) &&
    hasConcreteTaskContent(originalMessage, understanding.task.title)
  ) {
    return { kind: "save-task", task: understanding.task };
  }

  return { kind: "conversation" };
}

const TASK_WRITE_WORDS = new Set([
  "aku",
  "agar",
  "aja",
  "buat",
  "buatkan",
  "bikin",
  "catat",
  "catatkan",
  "deh",
  "di",
  "dong",
  "ingatkan",
  "ingetin",
  "ini",
  "itu",
  "jam",
  "ke",
  "masukkan",
  "masukin",
  "nanti",
  "pasang",
  "pasangkan",
  "pengingat",
  "pukul",
  "remind",
  "reminder",
  "saja",
  "saya",
  "setel",
  "setelkan",
  "simpan",
  "simpankan",
  "supaya",
  "tambah",
  "tambahkan",
  "tersebut",
  "tolong",
  "tugas",
  "untuk",
  "ya",
]);

function hasConcreteTaskContent(message: string, title: string): boolean {
  const normalized = message
    .toLocaleLowerCase("id-ID")
    .trim()
    .replaceAll(/\s+/g, " ");
  const vagueRequest =
    /^(tolong\s+)?(buat(?:kan)?|bikin|pasang(?:kan)?|setel(?:kan)?)?\s*(pengingat|reminder)\s*(dong|ya|tolong)?[.!?]*$/u.test(
      normalized,
    ) ||
    /^(tolong\s+)?(ingatkan|ingetin|remind)(\s+(aku|saya))?\s*(dong|ya)?[.!?]*$/u.test(
      normalized,
    );
  const genericTitle =
    /^(buat|membuat|bikin|pasang|mencatat|menyimpan|menambah)?\s*(tugas|pengingat|reminder)?$/u.test(
      title.toLocaleLowerCase("id-ID").trim(),
    );
  const payloadWords = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (word) =>
        word.length >= 3 &&
        !TASK_WRITE_WORDS.has(word) &&
        !/^\d+$/u.test(word),
    );
  return !vagueRequest && !genericTitle && payloadWords.length > 0;
}

/**
 * Model boleh mengusulkan sebuah tugas, tetapi izin menulis datang dari kata
 * pengguna sendiri. Pernyataan kewajiban atau permintaan memilih prioritas
 * bukan izin untuk mengubah daftar tugas.
 */
export function hasExplicitTaskWriteRequest(message: string): boolean {
  const normalized = message.toLocaleLowerCase("id-ID").replaceAll(/\s+/g, " ");
  const negatedWrite =
    /\b(jangan|tidak|tak|gak|ga|nggak|enggak)\s+(?:(?:usah|perlu|pernah|mau|ingin|minta|boleh|untuk)\s+){0,3}(?:di)?(catat(?:kan)?|simpan(?:kan)?|masuk(?:kan)?|tambah(?:kan)?|ingatkan|ingetin|remind)\b/u.test(
      normalized,
    );
  if (negatedWrite) return false;

  return (
    /\b(catat(?:kan)?|simpan(?:kan)?|masuk(?:kan)?|tambah(?:kan)?)\b/.test(
      normalized,
    ) ||
    /\b(ingatkan|ingetin|remind)\b/.test(normalized) ||
    /\b(pasang(?:kan)?|setel(?:kan)?|buat(?:kan)?)\b.{0,30}\b(pengingat|reminder)\b/.test(
      normalized,
    ) ||
    /\b(pengingat|reminder)\b.{0,30}\b(untuk|buat|agar|supaya)\b/.test(
      normalized,
    )
  );
}

function isMemoryControl(
  action: MemoryAction | null,
): action is "list" | "forget" | "edit" {
  return action === "list" || action === "forget" || action === "edit";
}

/** Tugas tersirat hanya boleh ditawarkan setelah balasan empatik. */
export function taskToOffer(
  understanding: Understanding,
): ExtractedTask | null {
  if (
    understanding.intent === "feeling" &&
    understanding.taskAction === "offer" &&
    understanding.task
  ) {
    return understanding.task;
  }

  return null;
}
