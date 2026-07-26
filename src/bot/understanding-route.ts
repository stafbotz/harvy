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

/** Tugas tersirat hanya boleh ditawarkan setelah balasan empatik. */
export function taskToOffer(
  understanding: Understanding,
): ExtractedTask | null {
  if (
    understanding.intent === "feeling" &&
    understanding.taskAction === "offer"
  ) {
    return understanding.task;
  }

  return null;
}

function isMemoryControl(
  action: MemoryAction | null,
): action is "list" | "forget" {
  return action === "list" || action === "forget";
}
