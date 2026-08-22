import { containsForbiddenMemorySecret } from "./memory-policy.js";

export interface ExplicitMemoryRememberAuthority {
  /** Potongan turn yang benar-benar berada di bawah verba simpan/ingat. */
  requestedText: string;
  /** Index candidate model yang didukung potongan tersebut. */
  candidateIndexes: number[];
  /** Secret tetap tidak boleh menjadi durable memory meski diminta eksplisit. */
  forbiddenSecret: boolean;
}

/**
 * Membentuk bukti consent item-scoped dari teks user turn sendiri.
 *
 * `memoryAction: remember` tetap diperlukan oleh adapter, tetapi tidak cukup:
 * model tidak boleh memberi authority. Fungsi lokal ini memeriksa bentuk
 * perintah, memisahkannya dari retrieval/forget/reminder, lalu hanya memilih
 * candidate yang benar-benar beririsan dengan klausa yang diminta disimpan.
 */
export function explicitMemoryRememberAuthority(
  message: string,
  candidates: readonly { content: string }[],
): ExplicitMemoryRememberAuthority | null {
  const normalized = normalizeSentence(message);
  if (!normalized || isForgetOrNegativeInstruction(normalized)) return null;
  if (isMemoryRetrievalQuestion(normalized)) return null;
  if (isReminderRequest(normalized)) return null;

  const request = extractRememberRequest(normalized);
  if (!request) return null;
  if (request.verb === "ingetin" && !request.semanticCue) return null;

  const requestedText = boundedRequestedText(request.content);
  if (!hasConcreteMemoryContent(requestedText)) return null;
  const forbiddenSecret = containsForbiddenMemorySecret(requestedText);
  if (forbiddenSecret) {
    return { requestedText, candidateIndexes: [], forbiddenSecret: true };
  }

  const requestedTerms = meaningfulTerms(requestedText);
  const candidateIndexes = candidates.flatMap((candidate, index) =>
    candidateMatchesRequest(candidate.content, requestedTerms) ? [index] : []
  );
  return { requestedText, candidateIndexes, forbiddenSecret: false };
}

/**
 * Menilai apakah balasan sudah mengomunikasikan write/update ke masa depan.
 *
 * Ini hanya dipakai sesudah adapter memiliki receipt commit; hasilnya bukan
 * bukti penyimpanan dan tidak pernah memberi authority. Recall lama seperti
 * "aku masih inget dulu..." sengaja tidak dihitung sebagai acknowledgment
 * write, dan emoji 💭 tidak mempunyai makna save.
 */
export function replyAcknowledgesMemoryWrite(text: string): boolean {
  const clean = normalizeSentence(text);
  if (
    /\baku\s+(?:tidak|tak|gak|ga|nggak|enggak)\s+(?:(?:akan|bakal)\s+)?lupa\b/u
      .test(clean) ||
    /\b(?:tidak|tak|gak|ga|nggak|enggak)\s+(?:akan|bakal)\s+ku(?:lupa|lupakan)\b/u
      .test(clean)
  ) return true;

  if (
    /\b(?:tidak|tak|gak|ga|nggak|enggak|belum|jangan)\b[^.!?]{0,28}\b(?:mengingat|menyimpan|mencatat|ingat|inget|catat|simpan)\b/u
      .test(clean)
  ) return false;

  // 📍 cukup jelas sebagai bahasa write setelah commit terkonfirmasi. Ia tetap
  // bukan bukti bahwa commit terjadi; caller sudah memegang receipt code-owned.
  if (text.includes("📍")) return true;

  if (
    /\b(?:aku\s+)?(?:akan\s+|bakal\s+|sudah\s+|udah\s+)?(?:memperbarui|memperbaiki|mengoreksi|perbarui|perbaiki|koreksi|update)(?:nya)?\b/u
      .test(clean) ||
    /\b(?:(?:akan|bakal|sudah|udah)\s+)?ku(?:perbarui|perbaiki|koreksi|update)(?:nya)?\b/u
      .test(clean) ||
    /\bmulai\s+sekarang\s+(?:aku\s+)?(?:akan\s+)?(?:memanggil|panggil|menganggap|anggap|menyesuaikan|sesuaikan)\b/u
      .test(clean) ||
    /\baku\s+(?:tidak|tak|gak|ga|nggak|enggak)\s+(?:akan\s+)?(?:lagi\s+)?(?:menganggap|memakai|menyebut)\b/u
      .test(clean)
  ) return true;

  const recallOnly =
    /\baku\s+(?:masih\s+)?(?:ingat|inget)\b[^.!?]{0,80}\b(?:dulu|pernah|waktu|sebelumnya)\b/u
      .test(clean) ||
    /\b(?:teringat|keinget|ngingetin\s+aku)\b/u.test(clean);
  const definitiveWrite =
    /\baku\s+(?:(?:akan|bakal|bisa|siap|sudah|udah|juga|tetap)\s+){0,3}(?:menyimpan|mencatat|catat|simpan)(?:nya)?\b/u
      .test(clean) ||
    /\b(?:(?:akan|bakal|sudah|udah|siap)\s+)?ku(?:simpan|catat)(?:nya)?\b/u
      .test(clean);
  if (definitiveWrite) return true;
  if (recallOnly) return false;

  return /\baku\s+(?:(?:akan|bakal|bisa|siap|sudah|udah|juga|tetap)\s+){0,3}(?:mengingat|ingat|inget)(?:nya)?\b/u
      .test(clean) ||
    /\b(?:(?:akan|bakal|sudah|udah|siap)\s+)?kuingat(?:nya)?\b/u
      .test(clean);
}

/**
 * Mengoreksi satu-satunya konflik emoji yang bisa dibuktikan secara lokal:
 * 💭 berada pada klausa yang justru mengaku write/update. Recall pada kalimat
 * lain tetap utuh, dan tidak ada emoji baru yang dipaksakan bila model memilih
 * balasan tanpa emoji.
 */
export function normalizeMemoryWriteEmoji(text: string): string {
  return text.replace(/[^.!?\n]+[.!?]?/gu, (sentence) =>
    sentence.includes("💭") && replyAcknowledgesMemoryWrite(sentence)
      ? sentence.replace("💭", "📍")
      : sentence
  );
}

interface RememberRequest {
  verb: "ingat" | "inget" | "simpan" | "catat" | "jangan-lupa" | "ingetin";
  content: string;
  semanticCue: boolean;
}

function extractRememberRequest(message: string): RememberRequest | null {
  const janganLupa = /\bjangan\s+lupa\s*(?:ya|yah|dong|deh)?\s*[:,]?\s+(.+)$/u
    .exec(message);
  if (janganLupa?.[1]) {
    return {
      verb: "jangan-lupa",
      content: janganLupa[1],
      semanticCue: true,
    };
  }

  const store = /\b(simpan|catat)\s*(?:ini\s*)?(?:ya|yah|dong|deh)?\s*[:,]?\s+(.+)$/u
    .exec(message);
  if (store?.[1] && store[2]) {
    return {
      verb: store[1] as "simpan" | "catat",
      content: store[2],
      semanticCue: true,
    };
  }

  const remember = /\b(ingat|inget)\s*(?:ya|yah|dong|deh|nih)?\s*[:,]?\s+(.+)$/u
    .exec(message);
  if (remember?.[1] && remember[2]) {
    return {
      verb: remember[1] as "ingat" | "inget",
      content: remember[2],
      semanticCue: true,
    };
  }

  const remind = /\bingetin\s+(?:kamu|dirimu|harvy)\s+(kalau|bahwa|tentang|soal)\s+(.+)$/u
    .exec(message);
  if (remind?.[2]) {
    return {
      verb: "ingetin",
      content: remind[2],
      semanticCue: true,
    };
  }
  return null;
}

function isForgetOrNegativeInstruction(message: string): boolean {
  if (/\b(?:lupakan|lupain|melupakan|hapus|hilangkan)\b/u.test(message)) {
    return true;
  }
  return /\b(?:jangan|tidak|tak|gak|ga|nggak|enggak)\s+(?:(?:usah|perlu|pernah|mau|ingin|boleh|untuk)\s+){0,3}(?:(?:kamu|harvy)\s+)?(?:di)?(?:ingat|inget|simpan|catat)\b/u
    .test(message);
}

function isMemoryRetrievalQuestion(message: string): boolean {
  return /\b(?:ingat|inget)\s+(?:gak|ga|nggak|tidak|enggak|kah)\b/u
      .test(message) ||
    /\b(?:kamu|harvy)\s+(?:masih\s+)?(?:ingat|inget)\s+(?:gak|ga|nggak|tidak|enggak|kah)\b/u
      .test(message) ||
    /\bapa(?:kah)?\s+(?:kamu|harvy)\s+(?:masih\s+)?(?:ingat|inget)\b/u
      .test(message) ||
    /^(?:kamu|harvy)\s+(?:masih\s+)?(?:ingat|inget)\b.*\?$/u.test(message) ||
    /\bmasih\s+(?:ingat|inget)\b.*\?$/u.test(message) ||
    /^(?:ingat|inget)\s+(?:siapa|apa|kapan|di\s*mana|gimana|bagaimana)\b.*\?$/u
      .test(message);
}

function isReminderRequest(message: string): boolean {
  return /\b(?:ingatkan|ingetin)\s+(?:aku|saya|gue|gw|kami|kita)\b/u
    .test(message);
}

function boundedRequestedText(value: string): string {
  return value
    .split(/(?:[.!?]\s+|\s*[,;]\s*(?:btw|by\s+the\s+way|ngomong-ngomong|oh\s+iya)\b)/u)[0]!
    .replace(/^[\s,:-]+|[\s,:-]+$/gu, "")
    .trim();
}

function hasConcreteMemoryContent(value: string): boolean {
  const terms = meaningfulTerms(value);
  return terms.size >= 2 && !/^(?:ini|itu|yang\s+tadi|hal\s+ini)$/u.test(value);
}

function candidateMatchesRequest(
  content: string,
  requestedTerms: ReadonlySet<string>,
): boolean {
  const candidateTerms = meaningfulTerms(content);
  if (candidateTerms.size === 0) return false;
  let overlap = 0;
  for (const term of candidateTerms) {
    if (requestedTerms.has(term)) overlap += 1;
  }
  return (overlap >= 2 && overlap === candidateTerms.size) ||
    (overlap === 1 && candidateTerms.size === 1);
}

function meaningfulTerms(value: string): Set<string> {
  return new Set(
    (normalizeSentence(value).match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((term) => !STOP_WORDS.has(term))
      .map(canonicalTerm)
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term)),
  );
}

function canonicalTerm(value: string): string {
  let term = value.replace(/([a-z])\1{2,}/gu, "$1");
  term = term.replace(/(?:ku|mu|nya)$/u, "");
  term = term.replace(/^(?:meng|meny|men|mem|me|ber|ter)/u, "");
  term = term.replace(/(?:kan|an|i)$/u, "");
  return term;
}

function normalizeSentence(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("id-ID")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "adalah",
  "aku",
  "banget",
  "bahwa",
  "dengan",
  "dia",
  "ini",
  "ingin",
  "itu",
  "kalau",
  "kamu",
  "lebih",
  "mau",
  "memiliki",
  "merupakan",
  "pengguna",
  "sangat",
  "saya",
  "sekarang",
  "tentang",
  "tolong",
  "yang",
]);
