import type { ActiveSession, SessionSignal } from "../domain/session.js";
import {
  semanticOperationAuthorized,
  type SemanticOperation,
  type SemanticOperationName,
} from "../domain/semantic-operation.js";

const NUMERIC_OR_FORMULA = /^[\d\s.,+\-*/^=()%:]+$/u;

/**
 * Sesi adalah konteks lunak. Ia hanya ikut ke prompt bila pesan memang tampak
 * melanjutkan tujuan itu; sesi lama tetap tersimpan ketika pengguna berganti
 * topik dan tidak boleh mengambil alih semua percakapan selama tujuh hari.
 */
export function sessionAppliesToMessage(
  session: ActiveSession,
  message: string,
  semantic: SemanticOperation | null | undefined = null,
): boolean {
  const text = normalize(message);
  if (!text) return false;
  if (semanticOperationAuthorized(message, semantic, {
    domain: "session",
    operations: ["continue", "stuck", "done", "cancel"],
    minConfidence: 0.7,
    explicitness: ["explicit", "contextual"],
  })) return true;
  // An explicit high-confidence operation in another domain is a new topic.
  if (
    semantic && semantic.domain !== "session" &&
    semantic.explicitness === "explicit" && semantic.confidence >= 0.8
  ) return false;

  const goalWords = meaningfulWords(session.goal);
  const messageWords = new Set(meaningfulWords(text));
  if (goalWords.some((word) => messageWords.has(word))) return true;

  // Ketidakpastian diparkir, bukan dianggap lanjutan. Pesan pendek dapat berupa
  // topik hidup yang sama sekali baru; hanya bentuk jawaban yang cukup jelas
  // boleh membawa sesi lama kembali ke prompt.
  return text.length <= 80 && NUMERIC_OR_FORMULA.test(text);
}

/**
 * `done` dan `cancel` menghapus state, jadi usulan model baru dipercaya bila
 * perkataan pengguna sendiri menyatakannya dengan jelas.
 */
export function authorizedSessionSignal(
  message: string,
  proposed: SessionSignal | null | undefined,
  _session?: ActiveSession | null,
  semantic: SemanticOperation | null | undefined = null,
): SessionSignal | null {
  if (!proposed) return null;
  const operation: SemanticOperationName = proposed;
  const mutating = proposed === "done" || proposed === "cancel";
  return semanticOperationAuthorized(message, semantic, {
      domain: "session",
      operations: [operation],
      minConfidence: mutating ? 0.85 : 0.7,
      explicitness: mutating
        ? ["explicit"]
        : ["explicit", "contextual"],
    })
    ? proposed
    : null;
}

function meaningfulWords(value: string): string[] {
  return normalize(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("id-ID").trim().replaceAll(/\s+/g, " ");
}
