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
 * Sampai 27 Juli 2026 dua pagar lokal berbasis pola ikut memeriksa teks
 * aslinya, karena model kecil pernah membuka seluruh daftar memori untuk
 * kalimat "kamu pahami aja" dan menulis tugas kosong berjudul "Membuat
 * pengingat". Keduanya diganti aturan yang lebih tegas di dalam prompt
 * ekstraksi, atas keputusan pemilik produk. Yang tersisa di sini adalah
 * pemeriksaan bentuk: intent dan aksi harus sejalan sebelum data berubah.
 */
export function immediateUnderstandingRoute(
  understanding: Understanding,
): ImmediateUnderstandingRoute {
  if (
    understanding.intent === "memory" &&
    isMemoryControl(understanding.memoryAction)
  ) {
    return { kind: "memory-control", action: understanding.memoryAction };
  }

  if (
    understanding.intent === "task" &&
    understanding.taskAction === "save" &&
    understanding.task
  ) {
    return { kind: "save-task", task: understanding.task };
  }

  return { kind: "conversation" };
}

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
    understanding.task
  ) {
    return understanding.task;
  }

  return null;
}
