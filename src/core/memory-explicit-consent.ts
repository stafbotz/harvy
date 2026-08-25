import { containsForbiddenMemorySecret } from "./memory-policy.js";
import {
  semanticEvidenceMatches,
  semanticOperationAuthorized,
  type SemanticOperation,
} from "../domain/semantic-operation.js";

export interface ExplicitMemoryRememberAuthority {
  /** Potongan turn yang benar-benar berada di bawah verba simpan/ingat. */
  requestedText: string;
  /** Index candidate model yang didukung potongan tersebut. */
  candidateIndexes: number[];
  /** Secret tetap tidak boleh menjadi durable memory meski diminta eksplisit. */
  forbiddenSecret: boolean;
}

/**
 * Membentuk bukti permintaan remember item-scoped dari teks user turn sendiri.
 *
 * `memoryAction: remember` tetap diperlukan oleh adapter, tetapi tidak cukup:
 * model tidak boleh mengarang adanya perintah explicit. Fungsi lokal ini
 * memvalidasi proposal closed-set, exact evidence dan target dari raw turn,
 * lalu hanya menandai candidate yang berkorespondensi secara bounded dengan
 * span yang diminta. Kanal privat memperoleh authority durable dari onboarding;
 * bukti ini tetap diperlukan untuk failure handling dan acknowledgment jujur.
 */
export function explicitMemoryRememberAuthority(
  message: string,
  candidates: readonly { content: string }[],
  semantic: SemanticOperation | null | undefined,
): ExplicitMemoryRememberAuthority | null {
  if (!semantic || !semanticOperationAuthorized(message, semantic, {
    domain: "memory",
    operations: ["remember"],
    minConfidence: 0.85,
    explicitness: ["explicit"],
  })) return null;
  // Model kecil cukup sering memahami operasinya dengan benar, tetapi menulis
  // `target` sebagai label ringkas (mis. "format jawaban pekerjaan produk")
  // alih-alih span verbatim. `evidence` sudah lolos pemeriksaan provenance di
  // atas, jadi pakai span itu sebagai batas authority ketika target bukan
  // bagian persis dari current turn. Ini tetap tidak memberi authority pada
  // parafrasa model atau konteks lama.
  const target = (semantic.target ?? "").trim();
  const evidence = (semantic.evidence ?? "").trim();
  const requestedText = semanticEvidenceMatches(message, target)
    ? target
    : evidence;
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

  if (
    /\b(?:tidak|tak|gak|ga|nggak|enggak|belum|jangan)\b[^.!?]{0,28}\b(?:dicatat|disimpan|diingat|diperbarui)\b/u
      .test(clean)
  ) return false;

  // Bentuk pasif seperti "aturan baru dicatat" tetap mengklaim adanya write.
  // Model tidak boleh menghindari receipt code-owned hanya dengan mengganti
  // subjek kalimat atau memakai bentuk pasif.
  if (/\b(?:dicatat|disimpan|diingat|diperbarui)\b/u.test(clean)) return true;

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

/**
 * Menghapus kalimat yang mengaku melakukan write tanpa receipt code-owned.
 * Prompt tetap menjadi pagar pertama, tetapi keluaran model tidak pernah
 * menjadi bukti bahwa data benar-benar disimpan.
 */
export function withoutUnconfirmedMemoryWriteClaims(text: string): string {
  const pieces = text.match(/[^.!?\n]+[.!?]?|\n+/gu) ?? [text];
  return pieces
    .filter((piece) => /^\n+$/u.test(piece) || !replyAcknowledgesMemoryWrite(piece))
    .join("")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function hasConcreteMemoryContent(value: string): boolean {
  const terms = meaningfulTerms(value);
  return value.length >= 2 && terms.size >= 1;
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
  // Candidate tetap output model yang tidak tepercaya. Batasi parafrasa pada
  // overlap konkret dan maksimal dua term tambahan; primary memory policy
  // memvalidasinya lagi sebelum commit.
  return overlap >= 1 && candidateTerms.size - overlap <= 2;
}

function meaningfulTerms(value: string): Set<string> {
  return new Set(
    (normalizeSentence(value).match(/[\p{L}\p{N}]+/gu) ?? [])
      .map((term) => term.replace(/([\p{L}])\1{2,}/gu, "$1"))
      .filter((term) => term.length >= 3 || /^\d+$/u.test(term)),
  );
}

function normalizeSentence(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("id-ID")
    .replaceAll(/\s+/gu, " ")
    .trim();
}
