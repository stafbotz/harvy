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
