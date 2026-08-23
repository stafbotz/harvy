/**
 * Tingkat risiko sebuah giliran percakapan.
 *
 * Tiga tingkat, bukan satu tanda benar/salah. Konstitusi Pasal 3.8 menuntut
 * intervensi yang proporsional: memperlakukan setiap kesedihan sebagai keadaan
 * darurat sama merusaknya dengan tidak mengenali bahaya sama sekali.
 */
export type RiskLevel = "biasa" | "dukungan" | "bahaya";

export const RISK_LEVELS: readonly RiskLevel[] = ["biasa", "dukungan", "bahaya"];

/**
 * Sinyal routing dari compiler percakapan, bukan putusan keselamatan.
 *
 * Bentuk ini sengaja tidak memuat sensitivitas memori/privasi. Sebuah cerita
 * dapat sangat pribadi tanpa menjadi bahaya akut, dan mencampur keduanya
 * membuat percakapan biasa menerima UX krisis yang tidak proporsional.
 */
export type RiskHintLevel = "none" | "possible" | "strong";

export type RiskCategory =
  | "self_harm"
  | "violence"
  | "abuse"
  | "exploitation"
  | "acute_distress";

export interface RiskHint {
  level: RiskHintLevel;
  category?: RiskCategory;
  confidence: number;
}

export const NO_RISK_HINT: RiskHint = Object.freeze({
  level: "none",
  confidence: 1,
});

const RISK_HINT_LEVELS: readonly RiskHintLevel[] = [
  "none",
  "possible",
  "strong",
];
const RISK_CATEGORIES: readonly RiskCategory[] = [
  "self_harm",
  "violence",
  "abuse",
  "exploitation",
  "acute_distress",
];

/** Membaca RiskHint model sebagai data tidak tepercaya. */
export function parseRiskHint(
  value: unknown,
  legacySafetySensitive?: boolean,
): RiskHint | null {
  // Selama migrasi, checkpoint/test double lama masih dapat mengirim boolean.
  // Runtime baru selalu diminta mengirim objek terstruktur di atas.
  if (value === undefined) {
    return legacySafetySensitive
      ? { level: "possible", category: "acute_distress", confidence: 0.5 }
      : NO_RISK_HINT;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const level = typeof record["level"] === "string"
    ? RISK_HINT_LEVELS.find((candidate) => candidate === record["level"])
    : undefined;
  const confidence = record["confidence"];
  if (
    !level ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return null;
  }

  const rawCategory = record["category"];
  const category = typeof rawCategory === "string"
    ? RISK_CATEGORIES.find((candidate) => candidate === rawCategory)
    : undefined;
  if (rawCategory !== undefined && rawCategory !== null && !category) {
    return null;
  }

  return level === "none" || !category
    ? { level, confidence }
    : { level, category, confidence };
}

/** Sinyal lokal hanya menaikkan routing; ia tidak menetapkan disposition. */
export function withImmediateDangerHint(
  hint: RiskHint,
  immediateDanger: boolean,
): RiskHint {
  if (!immediateDanger || hint.level === "strong") return hint;
  return {
    level: "strong",
    category: hint.category ?? "acute_distress",
    confidence: 1,
  };
}

/** Sinyal lokal hanya meminta triase; model khusus tetap menentukan hasilnya. */
export function withExplicitSupportHint(
  hint: RiskHint,
  explicitSupport: boolean,
): RiskHint {
  if (!explicitSupport || hint.level !== "none") return hint;
  return {
    level: "possible",
    category: "acute_distress",
    confidence: 1,
  };
}

export type RiskDisposition = "calm" | "support" | "danger" | "unavailable";

export interface SafetyRoutingDecision {
  disposition: RiskDisposition;
  /** Level efektif untuk prompt/copy Harvy yang sudah ada. */
  responseLevel: RiskLevel;
  hintLevel: RiskHintLevel;
  /** False berarti disagreement atau triage tidak tersedia. */
  certain: boolean;
}

/**
 * Menggabungkan hint compiler dan hasil triase tanpa aturan "satu suara positif
 * selalu menang". `undefined` berarti triase memang dilewati; `null` berarti
 * triase diperlukan tetapi tidak tersedia.
 */
export function decideSafetyRouting(
  hint: RiskHint,
  triageLevel: RiskLevel | null | undefined,
): SafetyRoutingDecision {
  if (triageLevel === undefined) {
    if (hint.level === "none") {
      return {
        disposition: "calm",
        responseLevel: "biasa",
        hintLevel: hint.level,
        certain: true,
      };
    }
    // Guard defensif bila pemanggil keliru melewatkan triase yang dibutuhkan.
    return {
      disposition: "unavailable",
      responseLevel: hint.level === "strong" ? "dukungan" : "biasa",
      hintLevel: hint.level,
      certain: false,
    };
  }

  if (triageLevel === null) {
    return {
      disposition: "unavailable",
      responseLevel: hint.level === "strong" ? "dukungan" : "biasa",
      hintLevel: hint.level,
      certain: false,
    };
  }

  if (triageLevel === "bahaya") {
    return {
      disposition: "danger",
      responseLevel: "bahaya",
      hintLevel: hint.level,
      certain: true,
    };
  }
  if (triageLevel === "dukungan") {
    return {
      disposition: "support",
      responseLevel: "dukungan",
      hintLevel: hint.level,
      // Bukti kuat + hasil yang berhenti di support adalah high-consequence
      // disagreement. Balasan tetap support, tetapi reviewer dan effect guard
      // harus tetap aktif.
      certain: hint.level !== "strong",
    };
  }
  if (hint.level === "strong") {
    // Hint kuat dan triase tenang memerlukan penanganan konservatif; hasil
    // tenang tidak boleh diam-diam menghapus bukti kuat dari compiler.
    return {
      disposition: "support",
      responseLevel: "dukungan",
      hintLevel: hint.level,
      certain: false,
    };
  }
  return {
    disposition: "calm",
    responseLevel: "biasa",
    hintLevel: hint.level,
    certain: true,
  };
}

export interface SafetyEffectPermissions {
  /** Task/reminder biasa yang diminta eksplisit oleh pengguna. */
  ordinaryTask: boolean;
  /** Kontrol eksplisit milik pengguna, termasuk hak akses/ekspor/hapus data. */
  explicitControl: boolean;
  /** Memori baru, pending, sesi, tawaran, dan mutasi percakapan implisit lain. */
  generalState: boolean;
}

/** Otorisasi per efek; emosi berat tidak menjadi tombol mati global. */
export function safetyEffectPermissions(
  decision: SafetyRoutingDecision,
  immediateDanger = false,
): SafetyEffectPermissions {
  const unresolvedStrongEvidence =
    decision.hintLevel === "strong" && !decision.certain;
  const explicitLowRiskEffect =
    !immediateDanger &&
    decision.responseLevel !== "bahaya" &&
    !unresolvedStrongEvidence;
  return {
    ordinaryTask: explicitLowRiskEffect,
    explicitControl: explicitLowRiskEffect,
    generalState:
      decision.disposition === "calm" && decision.certain,
  };
}

/** Support yang pasti biasanya tidak membayar reviewer kedua. */
export function needsConditionalReplyReview(
  decision: SafetyRoutingDecision,
): boolean {
  if (decision.responseLevel === "bahaya") return true;
  return decision.responseLevel === "dukungan" && !decision.certain;
}

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
const RECENT_BREAKUP = /\b(?:aku|saya|gue|gua)\s+(?:baru(?:\s+saja)?|habis)\s+(?:putus|diputusin|berpisah)\b/iu;
const RECENT_BEREAVEMENT = /\b(?:aku|saya|gue|gua)(?:\s+baru(?:\s+saja)?|\s+habis)?\s+(?:kehilangan\s+(?:orang|seseorang|ibu|ayah|mama|bapak|kakak|adik|pasangan|pacar|sahabat|teman|anggota\s+keluarga)|ditinggal\s+(?:meninggal|selamanya))\b/iu;

/**
 * Memastikan kehilangan yang dinyatakan langsung masuk ke triase dukungan.
 * Ini bukan disposition: kutipan/cerita orang lain ditolak, lalu classifier
 * safety khusus tetap boleh menilai hasil akhirnya biasa atau dukungan.
 */
export function hasExplicitSupportTriageSignal(message: string): boolean {
  const normalized = normalizeDangerText(message.normalize("NFKC"));
  if (
    /\b(?:contoh|kutipan|dialog|cerpen|novel|film|berita|teman(?:ku)?\s+(?:bilang|cerita))\b/iu.test(
      normalized,
    )
  ) return false;
  return RECENT_BREAKUP.test(normalized) || RECENT_BEREAVEMENT.test(normalized);
}

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
