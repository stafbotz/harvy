import type {
  ExtractedTask,
  ControlAction,
  MemoryAction,
  Understanding,
} from "../ai/understand.js";
import {
  semanticOperationAuthorized,
  type SemanticOperationName,
  type SemanticReference,
} from "../domain/semantic-operation.js";
import {
  explicitQuietHoursChange,
  explicitIndonesianTimeZoneChange,
} from "../core/time-policy.js";

export type ImmediateUnderstandingRoute =
  | { kind: "memory-control"; action: "list" | "edit" }
  | {
      kind: "memory-control";
      action: "forget";
      target: string | null;
      reference: SemanticReference;
    }
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
    isMemoryControl(understanding.memoryAction) &&
    memoryControlAuthorized(
      originalMessage,
      understanding.memoryAction,
      understanding.semanticOperation,
    )
  ) {
    return understanding.memoryAction === "forget"
      ? {
          kind: "memory-control",
          action: "forget",
          target: understanding.semanticOperation?.target?.trim() ||
            understanding.memoryTarget?.trim() || null,
          reference: understanding.semanticOperation?.reference ?? "none",
        }
      : { kind: "memory-control", action: understanding.memoryAction };
  }

  if (
    understanding.intent === "control" &&
    understanding.controlAction !== null &&
    understanding.controlAction !== undefined &&
    controlAuthorized(
      originalMessage,
      understanding.controlAction,
      understanding.semanticOperation,
    )
  ) {
    return { kind: "control", action: understanding.controlAction };
  }

  if (
    understanding.intent === "task" &&
    understanding.taskAction === "save" &&
    understanding.task &&
    understanding.semanticOperation &&
    semanticOperationAuthorized(
      originalMessage,
      understanding.semanticOperation,
      {
        domain: "task",
        operations: ["save"],
        minConfidence: 0.85,
        explicitness: ["explicit"],
      },
    ) &&
    hasConcreteTaskEvidence(
      understanding.task.title,
      understanding.semanticOperation.target,
      understanding.semanticOperation.evidence,
    )
  ) {
    return { kind: "save-task", task: understanding.task };
  }

  return { kind: "conversation" };
}

function hasConcreteTaskEvidence(
  title: string,
  target: string | null,
  evidence: string | null,
): boolean {
  const titleTerms = meaningfulTerms(title);
  const sourceTerms = meaningfulTerms(target ?? evidence ?? "");
  if (titleTerms.size === 0 || sourceTerms.size === 0) return false;
  return [...titleTerms].some((term) => sourceTerms.has(term));
}

function meaningfulTerms(value: string): Set<string> {
  return new Set(
    (value.normalize("NFKC").toLocaleLowerCase("und").match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((term) => term.length >= 2),
  );
}

function memoryControlAuthorized(
  message: string,
  action: "list" | "forget" | "edit",
  semantic: Understanding["semanticOperation"],
): boolean {
  const operation: SemanticOperationName = action;
  return semanticOperationAuthorized(message, semantic, {
    domain: "memory",
    operations: [operation],
    minConfidence: action === "list" ? 0.75 : 0.85,
    explicitness: action === "list"
      ? ["explicit", "contextual"]
      : ["explicit"],
  });
}

const CONTROL_OPERATIONS: Readonly<Record<ControlAction, SemanticOperationName>> = {
  data: "show-controls",
  timezone: "set-timezone",
  "quiet-hours": "set-quiet-hours",
  "active-session": "show-controls",
  "withdraw-consent": "withdraw-consent",
  export: "export",
  "delete-all": "delete-all",
};

function controlAuthorized(
  message: string,
  action: ControlAction,
  semantic: Understanding["semanticOperation"],
): boolean {
  const readOnly = action === "data" || action === "active-session";
  if (semanticOperationAuthorized(message, semantic, {
    domain: "data",
    operations: [CONTROL_OPERATIONS[action]],
    minConfidence: readOnly ? 0.75 : 0.85,
    explicitness: readOnly
      ? ["explicit", "contextual"]
      : ["explicit"],
  })) return true;

  // Dua pengaturan reversible mempunyai fallback lokal sempit agar kegagalan
  // extractor tidak mengubah permintaan eksplisit menjadi janji palsu. Aksi
  // privacy/destructive tetap wajib melewati proposal semantic + konfirmasi.
  if (action === "timezone") {
    return explicitIndonesianTimeZoneChange(message) !== null;
  }
  if (action === "quiet-hours") {
    return explicitQuietHoursChange(message) !== null;
  }
  return false;
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
