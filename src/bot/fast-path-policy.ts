import type { Pending } from "./pending.js";

/** Balasan lokal hanya untuk chat dingin tanpa sesi atau pending. */
export function deterministicQuickChatReply(message: string): string | null {
  const normalized = normalize(message);
  if (/^(?:makasih|terima kasih|thanks|thank you|tengkyu)$/u.test(normalized)) {
    return "Sama-sama.";
  }
  if (/^(?:iya|ya|yap|oke|ok|sip|siap)$/u.test(normalized)) {
    return "Sip.";
  }
  return null;
}

/**
 * Form value berstruktur sempit tidak memerlukan compiler intent atau triase
 * umum. Caller tetap menjalankan emergency preflight lokal lebih dahulu.
 */
export function isNarrowPendingAnswer(
  waiting: Pending,
  answer: string,
): boolean {
  switch (waiting.kind) {
    case "edit-due":
    case "set-task-reminder":
    case "schedule-checkin":
    case "custom-quiet-hours":
      return looksLikeNarrowTimeValue(answer);
    case "agent-input":
      // Checkpoint belum menyimpan schema jawaban yang diharapkan. Watermark
      // update saja tidak cukup untuk mengikat "iya"/"besok" ke pertanyaan
      // terbuka agent, jadi jalur ini tetap memakai compiler umum.
      return false;
    case "checkin-settings":
      return looksLikeNarrowChoice(answer);
    case "edit-memory":
    case "confirm-task":
    case "confirm-memory":
    case "confirm-memory-wipe":
    case "confirm-consent-withdrawal":
    case "confirm-full-deletion":
      return false;
  }
}

function looksLikeNarrowChoice(value: string): boolean {
  const normalized = normalize(value);
  return /^(?:iya|ya|y|oke|ok|tidak|nggak|gak|ga|belum|sudah|udah|opsi\s+[a-z0-9]|[a-z0-9])$/u.test(
    normalized,
  );
}

function looksLikeNarrowTimeValue(value: string): boolean {
  const normalized = normalize(value);
  if (!normalized || normalized.length > 48) return false;
  return /^(?:(?:hari ini|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu|minggu)(?:\s+(?:(?:jam|pukul)\s*)?\d{1,2}(?:(?:[:.]\d{2})|(?:\s*(?:pagi|siang|sore|malam)))?)?|(?:(?:jam|pukul)\s*)\d{1,2}(?:(?:[:.]\d{2})|(?:\s*(?:pagi|siang|sore|malam)))?|setengah\s+\d{1,2}|\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?|\d+(?:\s*[-–]\s*\d+)?\s*(?:menit|jam|hari|minggu)|\d{1,2}(?::|\.)\d{2}\s*[-–]\s*\d{1,2}(?::|\.)\d{2})$/u.test(
    normalized,
  );
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .trim()
    .replace(/[!?.,]+$/gu, "")
    .replace(/\s+/gu, " ");
}
