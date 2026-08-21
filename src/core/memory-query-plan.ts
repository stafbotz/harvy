export type MemoryTemporalMode = "current" | "historical";

export interface MemoryQueryPlan {
  version: 1;
  taskBrief: {
    /** Tidak pernah diringkas/ditulis ulang oleh planner. */
    rawRequest: string;
    retrievalGoal: string;
  };
  query: string;
  routes: {
    episodic: boolean;
    semantic: boolean;
    graph: boolean;
    personalization: boolean;
    procedural: boolean;
    errorLessons: boolean;
  };
  temporal: {
    mode: MemoryTemporalMode;
    asOf: string | null;
  };
  limits: {
    perRoute: number;
    contextItems: number;
    contextCharacters: number;
    graphDepth: number;
  };
}

export interface MemoryQueryPlanningOptions {
  allowRetrieval?: boolean;
  now?: Date;
}

/**
 * Query plan lokal dan advisory. Ia tidak memuat capability, provider, scope,
 * atau authority sehingga teks/model tidak dapat memperluas izin lewat plan.
 */
export function planMemoryQuery(
  rawRequest: string,
  options: MemoryQueryPlanningOptions = {},
): MemoryQueryPlan {
  const raw = boundedRawRequest(rawRequest);
  const normalized = normalize(raw);
  const terms = significantTerms(normalized);
  const allowed = options.allowRetrieval !== false &&
    raw.length >= 4 &&
    terms.length > 0 &&
    !LOCAL_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
  const recall = RECALL_PATTERNS.some((pattern) => pattern.test(normalized));
  const temporal = TEMPORAL_PATTERNS.some((pattern) => pattern.test(normalized));
  const relational = RELATION_PATTERNS.some((pattern) => pattern.test(normalized));
  const memorySeeking = MEMORY_SEEKING_PATTERNS.some((pattern) =>
    pattern.test(normalized));
  const proceduralSeeking = PROCEDURAL_PATTERNS.some((pattern) =>
    pattern.test(normalized));
  const failureSeeking = FAILURE_PATTERNS.some((pattern) =>
    pattern.test(normalized));
  const personalizationSeeking = memorySeeking ||
    PERSONALIZATION_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
  const asOf = parseExplicitDate(normalized, options.now ?? new Date());
  const historical = asOf !== null ||
    PAST_PATTERNS.some((pattern) => pattern.test(normalized));
  const usefulQuery = terms.slice(0, 20).join(" ");
  const episodic = allowed && (recall || historical);
  const semantic = allowed &&
    (recall || temporal || relational || memorySeeking);
  const graph = allowed && (relational || temporal);
  const personalization = allowed && personalizationSeeking;
  const procedural = allowed && (proceduralSeeking || failureSeeking);
  const errorLessons = allowed && failureSeeking;
  const usesRetrieval = episodic || semantic || graph || personalization ||
    procedural || errorLessons;

  return Object.freeze({
    version: 1,
    taskBrief: Object.freeze({
      rawRequest: raw,
      retrievalGoal: usesRetrieval
        ? `Cari konteks relevan untuk: ${usefulQuery}`
        : "Tidak memerlukan retrieval memory.",
    }),
    query: usesRetrieval ? usefulQuery : "",
    routes: Object.freeze({
      episodic,
      semantic,
      graph,
      personalization,
      procedural,
      errorLessons,
    }),
    temporal: Object.freeze({
      mode: historical ? "historical" : "current",
      asOf,
    }),
    limits: Object.freeze({
      perRoute: 8,
      contextItems: 8,
      contextCharacters: 3_000,
      graphDepth: relational ? 3 : 2,
    }),
  });
}

export function memoryPlanUsesRetrieval(plan: MemoryQueryPlan): boolean {
  return plan.routes.episodic || plan.routes.semantic || plan.routes.graph ||
    plan.routes.personalization || plan.routes.procedural ||
    plan.routes.errorLessons;
}

function boundedRawRequest(value: string): string {
  if (typeof value !== "string") throw new Error("Raw request memory tidak sah.");
  const clean = value.trim();
  if (!clean || clean.length > 8_000 || /\u0000/u.test(clean)) {
    throw new Error("Raw request memory tidak sah.");
  }
  return clean;
}

function significantTerms(value: string): string[] {
  return [...new Set(
    (value.match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((term) => term.length >= 2 && !STOP_WORDS.has(term)),
  )];
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("id-ID")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function parseExplicitDate(value: string, now: Date): string | null {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/u.exec(value);
  if (iso) {
    const parsed = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T23:59:59.999Z`);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  if (/\bkemarin\b/u.test(value)) {
    return new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
  }
  return null;
}

const LOCAL_ONLY_PATTERNS = [
  /^(halo|hai|hi|hey|p|makasih|terima kasih|sip|oke|ok)[!?. ]*$/u,
  /^(?:sekarang\s+)?(?:jam berapa|tanggal berapa|hari apa)(?:\s+sekarang)?[!?. ]*$/u,
  /^(?:kamu pakai\s+)?(?:model apa|kamu siapa|siapa kamu)[!?. ]*$/u,
];
const RECALL_PATTERNS = [
  /\b(ingat|pernah|sebelumnya|yang lalu|waktu itu|tadi kita|ceritain dulu)\b/u,
];
const TEMPORAL_PATTERNS = [
  /\b(kapan|jadwal|sekarang|dulu|saat itu|sebelum|sesudah|berubah|terbaru)\b/u,
  /\b20\d{2}-\d{2}-\d{2}\b/u,
];
const PAST_PATTERNS = [
  /\b(dulu|waktu itu|sebelumnya|kemarin|saat itu|pernah)\b/u,
];
const RELATION_PATTERNS = [
  /\b(siapa|hubungan|terkait|mengajar|diajar|sekolah|kelas|proyek|guru|teman|dengan siapa)\b/u,
];
const MEMORY_SEEKING_PATTERNS = [
  /\b(tentangku|profilku|preferensi|kesukaanku|favorit|kebiasaanku|biasanya)\b/u,
  /\b(menurut yang kamu tahu|yang kuceritakan|cocok buatku)\b/u,
];
const PROCEDURAL_PATTERNS = [
  /\b(cara|langkah|workflow|prosedur|deploy|deployment|rilis|migrasi|setup|konfigurasi|debug|perbaiki|memperbaiki|implementasi|coding|repository|repo|git|github|test|build)\b/u,
  /\b(bagaimana|gimana)\b.*\b(melakukan|menjalankan|menyelesaikan|memperbaiki)\b/u,
];
const FAILURE_PATTERNS = [
  /\b(error|gagal|failure|failed|exception|timeout|crash|rusak|bermasalah|tidak jalan|nggak jalan)\b/u,
];
const PERSONALIZATION_TASK_PATTERNS = [
  /\b(review|coding|implementasi|desain|arsitektur|rencana teknis)\b/u,
];
const STOP_WORDS = new Set([
  "aku",
  "apa",
  "atau",
  "dan",
  "dari",
  "dengan",
  "di",
  "ini",
  "itu",
  "ke",
  "kamu",
  "tentang",
  "yang",
]);
