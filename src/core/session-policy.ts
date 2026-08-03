import type { ActiveSession, SessionSignal } from "../domain/session.js";

const CONTINUATION_CUES =
  /\b(lanjut(?:kan)?|yang tadi|itu tadi|coba lagi|petunjuk|jelasin lagi)\b/i;
const NEW_TOPIC_CUES =
  /\b(ngomong-ngomong|ngomongin yang lain|topik lain|ganti topik|btw)\b/i;
const SESSION_REFERENCE =
  /\b(sesi(?:nya)?|latihan(?:nya)?|tujuan(?:nya)?|yang tadi)\b/i;
const COMPLETION_WORDS = /\b(selesai|beres|kelar)\b/i;
const EXPLICIT_CANCEL =
  /\b(berhenti\w*|stop|batalkan|batalin|akhiri)\b.{0,24}\b(sesi|yang tadi|ini)\b|\b(sesi|yang tadi)\b.{0,24}\b(berhenti\w*|stop|batalkan|batalin|akhiri)\b/i;
const SHORT_ACKNOWLEDGEMENT =
  /^(iya|ya|y|nggak|enggak|gak|ga|tidak|belum|sudah|udah|oke|ok|sip|boleh|siap|paham|nggak paham|belum paham)[.!?]*$/i;
const ANSWER_SHAPE =
  /^(jawab(?:an)?ku|menurutku|kalau menurutku|hasil(?:nya)?|karena|sebab|aku (?:jawab|pilih|coba))\b/i;
const NUMERIC_OR_FORMULA = /^[\d\s.,+\-*/^=()%:]+$/u;

/**
 * Sesi adalah konteks lunak. Ia hanya ikut ke prompt bila pesan memang tampak
 * melanjutkan tujuan itu; sesi lama tetap tersimpan ketika pengguna berganti
 * topik dan tidak boleh mengambil alih semua percakapan selama tujuh hari.
 */
export function sessionAppliesToMessage(
  session: ActiveSession,
  message: string,
): boolean {
  const text = normalize(message);
  if (!text) return false;
  if (NEW_TOPIC_CUES.test(text)) return false;
  if (CONTINUATION_CUES.test(text)) return true;
  if (SESSION_REFERENCE.test(text)) return true;

  const goalWords = meaningfulWords(session.goal);
  const messageWords = new Set(meaningfulWords(text));
  if (goalWords.some((word) => messageWords.has(word))) return true;

  // Ketidakpastian diparkir, bukan dianggap lanjutan. Pesan pendek dapat berupa
  // topik hidup yang sama sekali baru; hanya bentuk jawaban yang cukup jelas
  // boleh membawa sesi lama kembali ke prompt.
  return (
    SHORT_ACKNOWLEDGEMENT.test(text) ||
    ANSWER_SHAPE.test(text) ||
    (text.length <= 80 && NUMERIC_OR_FORMULA.test(text))
  );
}

/**
 * `done` dan `cancel` menghapus state, jadi usulan model baru dipercaya bila
 * perkataan pengguna sendiri menyatakannya dengan jelas.
 */
export function authorizedSessionSignal(
  message: string,
  proposed: SessionSignal | null | undefined,
  session?: ActiveSession | null,
): SessionSignal | null {
  if (!proposed) return null;
  if (proposed === "done") {
    const text = normalize(message);
    const namesSession = SESSION_REFERENCE.test(text);
    const namesGoal =
      session !== null &&
      session !== undefined &&
      meaningfulWords(session.goal).some((word) =>
        new Set(meaningfulWords(text)).has(word),
      );
    return COMPLETION_WORDS.test(text) && (namesSession || namesGoal)
      ? "done"
      : null;
  }
  if (proposed === "cancel") {
    return EXPLICIT_CANCEL.test(message) ? "cancel" : null;
  }
  return proposed;
}

function meaningfulWords(value: string): string[] {
  const ignored = new Set([
    "yang",
    "dan",
    "atau",
    "untuk",
    "dengan",
    "dari",
    "aku",
    "saya",
    "mau",
    "ingin",
    "bantu",
  ]);
  return normalize(value)
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 4 && !ignored.has(word));
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("id-ID").trim().replaceAll(/\s+/g, " ");
}
