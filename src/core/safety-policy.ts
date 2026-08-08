/**
 * Tingkat risiko sebuah giliran percakapan.
 *
 * Tiga tingkat, bukan satu tanda benar/salah. Konstitusi Pasal 3.8 menuntut
 * intervensi yang proporsional: memperlakukan setiap kesedihan sebagai keadaan
 * darurat sama merusaknya dengan tidak mengenali bahaya sama sekali.
 */
export type RiskLevel = "biasa" | "dukungan" | "bahaya";

export const RISK_LEVELS: readonly RiskLevel[] = ["biasa", "dukungan", "bahaya"];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && RISK_LEVELS.includes(value as RiskLevel);
}

const IMMEDIATE_SELF_HARM = /^(?:harvy\s+)?(?:tolong\s+)?(?:(?:aku|saya|gue|gua)\s+)?(?:mau|ingin|pengen|akan|bakal|berencana)\s+(?:untuk\s+)?(?:bunuh\s+diri|mati|mengakhiri\s+hidup(?:ku)?|menyakiti\s+diri(?:ku)?|melukai\s+diri(?:ku)?)\s+(?:sekarang|saat\s+ini|malam\s+ini|hari\s+ini|sebentar\s+lagi|habis\s+ini)\b/iu;
const ACTIVE_SELF_HARM = /^(?:harvy\s+)?(?:tolong\s+)?(?:aku|saya|gue|gua)\s+(?:sedang|lagi|baru\s+saja)\s+(?:menyakiti|melukai)\s+diri(?:ku)?\b/iu;
const IMMEDIATE_VIOLENCE = /^(?:harvy\s+)?(?:tolong\s+)?(?:aku|saya|gue|gua)\s+(?:mau|ingin|pengen|akan|bakal)\s+(?:membunuh|bunuh|melukai|menyerang)\s+(?:dia|mereka|orang\s+itu|seseorang)\s+(?:sekarang|saat\s+ini|malam\s+ini|hari\s+ini|sebentar\s+lagi|habis\s+ini)\b/iu;
const ACTIVE_ABUSE = /^(?:harvy\s+)?(?:tolong\s+)?(?:aku|saya|gue|gua)\s+(?:sedang|lagi)\s+(?:dipukul|dianiaya|dicekik|diculik|diperkosa|ditahan\s+paksa)(?:\s+(?:sekarang|saat\s+ini))?$/iu;
const ACTIVE_CONFINEMENT = /^(?:harvy\s+)?(?:tolong\s+)?(?:aku|saya|gue|gua)\s+(?:sedang|lagi)\s+dikunci\s+(?:di|dalam)\s+(?:kamar|ruangan|rumah|mobil)(?:\s+(?:sekarang|saat\s+ini))?$/iu;
const ACTIVE_DEATH_THREAT = /^(?:harvy\s+)?(?:tolong\s+)?(?:aku|saya|gue|gua)\s+(?:sedang|lagi)\s+diancam\s+(?:akan\s+|mau\s+)?(?:dibunuh|dipukul|dilukai|diserang)(?:\s+(?:sekarang|saat\s+ini))?$/iu;
const IMMEDIATE_DANGER = /^(?:harvy\s+)?(?:tolong\s+)?(?:aku|saya|gue|gua)\s+(?:dalam\s+bahaya|tidak\s+aman|nggak\s+aman|gak\s+aman|ga\s+aman)\s+(?:sekarang|saat\s+ini)\b/iu;
const THREAT_FROM_OTHER = /^(?:harvy\s+)?(?:tolong\s+)?ada\s+(?:orang|seseorang|dia|mereka)\s+(?:yang\s+)?(?:mau|akan|ingin)\s+(?:membunuh|bunuh|melukai|menyerang)\s+(?:aku|saya|gue|gua)\s+(?:sekarang|saat\s+ini|malam\s+ini|hari\s+ini|sebentar\s+lagi)\b/iu;
const DIRECT_THREAT_FROM_OTHER = /^(?:harvy\s+)?(?:tolong\s+)?(?:orang\s+itu|seseorang|dia|mereka)\s+(?:mau|akan|ingin)\s+(?:membunuh|bunuh|melukai|menyerang)\s+(?:aku|saya|gue|gua)\s+(?:sekarang|saat\s+ini|malam\s+ini|hari\s+ini|sebentar\s+lagi)\b/iu;
const ACTIVE_ATTACK_FROM_OTHER = /^(?:harvy\s+)?(?:tolong\s+)?(?:orang\s+itu|seseorang|dia|mereka)\s+(?:sedang|lagi)\s+(?:mencekik|memukul|melukai|menyerang|menculik)\s+(?:aku|saya|gue|gua)(?:\s+(?:sekarang|saat\s+ini))?$/iu;
const IMMEDIATE_PREFIX_SELF_HARM = /^(?:harvy\s+)?(?:tolong\s+)?(?:sekarang|saat\s+ini)\s+(?:(?:aku|saya|gue|gua)\s+)?(?:mau|ingin|pengen|akan|bakal)\s+(?:untuk\s+)?(?:bunuh\s+diri|mati|mengakhiri\s+hidup(?:ku)?|menyakiti\s+diri(?:ku)?|melukai\s+diri(?:ku)?)\b/iu;

/**
 * Sinyal lokal berpresisi tinggi untuk acknowledgment darurat sebelum debounce.
 *
 * Ini bukan diagnosis atau pengganti triase. Hanya pernyataan langsung dengan
 * pelaku/korban yang cukup jelas dan berjangka segera yang lolos. Kutipan,
 * pembahasan umum, konteks historis, dan bentuk samar tetap dinilai model pada
 * jalur biasa.
 */
export function hasExplicitImmediateDangerSignal(message: string): boolean {
  const lines = message
    .normalize("NFKC")
    .split("\n")
    .map((bubble) => bubble.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;

  const normalizedLines = lines.map(normalizeDangerText);
  const context = normalizedLines.join(" ");
  if (
    /\b(?:contoh|kutipan|dialog|cerpen|novel|film|berita|laporan|skenario|roleplay|permainan|game)\b/iu.test(
      context,
    ) ||
    /\b(?:pesan|chat|status)\s+dari\b/iu.test(context) ||
    /\b(?:teman(?:ku)?|tokoh(?:nya)?|dia)\s+(?:bilang|berkata|menulis|cerita)\b/iu.test(
      context,
    ) ||
    /\b(?:kata|ujar|ucap|tulis)\s+(?:dia|teman(?:ku)?|tokoh)\b/iu.test(
      context,
    ) ||
    /\b(?:nggak|gak|ga|tidak|batal)\s+jadi\b/iu.test(context)
  ) {
    return false;
  }

  return lines.some((line, index) => {
    if (/^(?:>|["'`“”‘’])/u.test(line)) return false;
    const normalized = normalizedLines[index] ?? "";
    return [
      IMMEDIATE_SELF_HARM,
      IMMEDIATE_PREFIX_SELF_HARM,
      ACTIVE_SELF_HARM,
      IMMEDIATE_VIOLENCE,
      ACTIVE_ABUSE,
      ACTIVE_CONFINEMENT,
      ACTIVE_DEATH_THREAT,
      IMMEDIATE_DANGER,
      THREAT_FROM_OTHER,
      DIRECT_THREAT_FROM_OTHER,
      ACTIVE_ATTACK_FROM_OTHER,
    ].some((pattern) => pattern.test(normalized));
  });
}

function normalizeDangerText(text: string): string {
  return text
    .toLocaleLowerCase("id-ID")
    .replace(/[!?.,:;()[\]{}*_~-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Giliran yang balasannya wajib diperiksa lagi sebelum dikirim. */
export function needsReplyReview(level: RiskLevel): boolean {
  return level !== "biasa";
}

/** Giliran yang isinya layak dicatat sebagai riwayat keselamatan. */
export function worthRecording(level: RiskLevel): boolean {
  return level !== "biasa";
}

/**
 * Jarak minimum sebelum Harvy boleh mengangkat kembali soal bantuan
 * profesional.
 *
 * Menawarkannya lagi pada giliran berikutnya terbaca sebagai desakan, dan
 * Pasal 5 nomor 1 melarang membuat pengguna merasa bersalah karena tidak
 * mengikuti saran. Menawarkannya beberapa hari kemudian, ketika keadaannya
 * lebih tenang, adalah hal yang berbeda.
 */
export const FOLLOW_UP_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

export interface FollowUpInput {
  /** Kapan Harvy terakhir kali menyarankan bantuan profesional. */
  lastSuggestedAt: string | null;
  /** Kapan giliran berisiko terakhir tercatat. */
  lastRiskAt: string | null;
  level: RiskLevel;
}

/**
 * Apakah saat ini pantas mengangkat kembali bantuan profesional.
 *
 * Tidak pernah pada giliran yang sedang berbahaya — saat itu yang dibutuhkan
 * adalah ditemani, bukan dirujuk. Yang pantas justru percakapan tenang setelah
 * jarak yang cukup dari kejadiannya.
 */
export function shouldRaiseProfessionalHelp(
  input: FollowUpInput,
  now: Date,
): boolean {
  if (input.level !== "biasa") return false;
  if (!input.lastRiskAt) return false;

  const sinceRisk = now.getTime() - new Date(input.lastRiskAt).getTime();
  if (sinceRisk < FOLLOW_UP_COOLDOWN_MS) return false;

  if (!input.lastSuggestedAt) return true;

  const sinceSuggestion =
    now.getTime() - new Date(input.lastSuggestedAt).getTime();
  return sinceSuggestion >= FOLLOW_UP_COOLDOWN_MS;
}
