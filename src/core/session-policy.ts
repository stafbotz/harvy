import type { ActiveSession, SessionSignal } from "../domain/session.js";
import {
  semanticOperationAuthorized,
  type SemanticOperation,
  type SemanticOperationName,
} from "../domain/semantic-operation.js";

const NUMERIC_OR_FORMULA = /^[\d\s.,+\-*/^=()%:]+$/u;
const TUTOR_ANSWER_CUE = /^(?:karena|sebab|soalnya|jawabannya|hasilnya|menurut(?:ku|\s+saya)|because|the\s+answer\s+is)\b/iu;
const SESSION_NOUN = /\b(?:sesi|session)\b/iu;
const DONE_CUE = /\b(?:sudah|udah|telah|already|is|sesi(?:nya)?\s+)?(?:selesai|beres|tuntas|finished|done|complete)\b/iu;
const CANCEL_CUE = /\b(?:batalkan|batalin|hentikan|berhenti(?:kan)?|stop|cancel)\b/iu;
const NOT_DONE_CUE = /\b(?:belum|not\s+yet|belum\s+benar-benar)\s+(?:selesai|beres|tuntas|finished|done|complete)\b/iu;
const DO_NOT_CANCEL_CUE = /\b(?:jangan|tidak\s+usah|nggak\s+usah|gak\s+usah|ga\s+usah|do\s+not|don't)\s+(?:batalkan|batalin|hentikan|berhenti(?:kan)?|stop|cancel)\b/iu;
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
  if (explicitSessionMutation(session, message)) return true;
  if (
    SESSION_NOUN.test(text) &&
    (NOT_DONE_CUE.test(text) || DO_NOT_CANCEL_CUE.test(text))
  ) return true;
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
  if (text.length <= 80 && NUMERIC_OR_FORMULA.test(text)) return true;

  // Jawaban tutor yang sangat pendek sering tidak mengulang nama topik. Cue
  // kausal/jawaban cukup kuat pada tahap yang memang sedang menunggu usaha,
  // tetapi pertanyaan baru tetap tidak boleh dibajak oleh sesi lama.
  return session.kind === "tutor" &&
    (session.stage === "assess" || session.stage === "attempt" ||
      session.stage === "retry") &&
    text.length <= 120 &&
    !/[?？]/u.test(text) &&
    TUTOR_ANSWER_CUE.test(text);
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
  const explicit = _session ? explicitSessionMutation(_session, message) : null;
  if (explicit) return explicit;
  if (proposed) {
    const operation: SemanticOperationName = proposed;
    const mutating = proposed === "done" || proposed === "cancel";
    const normalized = normalize(message);
    if (
      (proposed === "done" && NOT_DONE_CUE.test(normalized)) ||
      (proposed === "cancel" && DO_NOT_CANCEL_CUE.test(normalized))
    ) return null;
    if (semanticOperationAuthorized(message, semantic, {
      domain: "session",
      operations: [operation],
      minConfidence: mutating ? 0.85 : 0.7,
      explicitness: mutating
        ? ["explicit"]
        : ["explicit", "contextual"],
    })) return proposed;
  }

  // Menghapus sesi adalah mutasi, jadi fallback hanya menerima kalimat yang
  // secara eksplisit menyebut sesi atau tujuan aktif serta verba selesai/batal.
  // Proposal model tidak diperlukan untuk bukti closed-set ini.
  return null;
}

function explicitSessionMutation(
  session: ActiveSession,
  message: string,
): "done" | "cancel" | null {
  const normalized = normalize(message);
  const namesSession = SESSION_NOUN.test(normalized) ||
    meaningfulWords(session.goal).some((word) =>
      new Set(meaningfulWords(normalized)).has(word)
    );
  if (!namesSession) return null;
  if (CANCEL_CUE.test(normalized) && !DO_NOT_CANCEL_CUE.test(normalized)) {
    return "cancel";
  }
  if (DONE_CUE.test(normalized) && !NOT_DONE_CUE.test(normalized)) return "done";
  return null;
}

function meaningfulWords(value: string): string[] {
  return normalize(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("id-ID").trim().replaceAll(/\s+/g, " ");
}
