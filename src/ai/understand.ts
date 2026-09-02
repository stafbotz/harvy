import type { MemoryKind } from "../domain/memory.js";
import type { TaskImportance } from "../domain/task.js";
import type { SessionSignal } from "../domain/session.js";
import {
  parseSemanticOperation,
  type SemanticOperation,
} from "../domain/semantic-operation.js";
import {
  isAdaptiveActionId,
  type AdaptiveActionId,
} from "../core/action-policy.js";
import {
  parseRiskHint,
  type RiskHint,
} from "../core/safety-policy.js";
import type {
  ConversationIntent,
  ExecutionSize,
  RoutingAssessment,
  RoutingDegree,
  RoutingToolNeed,
  WorkComplexity,
} from "./model-policy.js";
import {
  parsePublicProgressFocus,
  type SafePublicProgressFocus,
} from "../core/conversation-progress.js";

/**
 * Membaca balasan model menjadi data yang dapat dipercaya.
 *
 * Model bisa mengembalikan JSON yang terbungkus pagar kode, disertai kalimat
 * pengantar, atau berisi nilai di luar dugaan. Modul ini memperlakukan seluruh
 * balasan sebagai masukan yang tidak tepercaya dan memaksanya masuk ke bentuk
 * yang sudah ditetapkan. Bila gagal, ia mengembalikan `null` supaya Harvy dapat
 * mengaku tidak paham alih-alih menebak.
 */
export interface ExtractedTask {
  title: string;
  dueAt: Date | null;
  /** Hanya terisi bila pengguna memang minta diingatkan pada waktu tertentu. */
  remindAt: Date | null;
  importance: TaskImportance;
}

/** Usulan memori dari model. Belum tentu disimpan; lihat `ADR-006` bagian 2. */
export interface ExtractedMemory {
  kind: MemoryKind;
  content: string;
  /** Exact span dari current user turn yang mendasari kandidat model. */
  sourceEvidence?: string;
  /** Siapa/apa yang dijelaskan span tersebut; bukan owner storage. */
  sourceSubject?: "self" | "other" | "work";
  /** Horizon makna menurut extractor; `transient` tidak layak auto-memory. */
  durability?: "durable" | "bounded" | "transient";
  /** Diisi adapter dari HistoryService; model/parser tidak boleh menentukannya. */
  sourceSequences?: number[];
  /** Diisi policy privasi lokal; model/parser tidak boleh menentukannya. */
  sensitivity?: import("../domain/memory-knowledge.js").MemorySensitivity;
  /** Metadata berikut diisi adapter lokal, bukan parser JSON model. */
  subject?: string;
  predicate?: string;
  value?: string;
  correction?: boolean;
  provenance?: import("../domain/memory-knowledge.js").MemoryProvenance;
  graphProjection?: import("../domain/memory-knowledge.js").MemoryGraphProjection | null;
}

/**
 * Usulan untuk mencabut pemahaman lama yang secara eksplisit dikoreksi user.
 *
 * Ini bukan authority mutasi. Adapter masih harus membuktikan exact evidence,
 * mencocokkan target hanya pada primary memory owner-local, lalu memperoleh
 * receipt dari `MemoryService.forget` sebelum Harvy boleh mengaku lupa.
 */
export interface ExtractedMemoryRetraction {
  /** Topik manusiawi dari pemahaman lama; tidak pernah berupa storage ID. */
  target: string;
  /** Exact span current turn yang mengatakan pemahaman lama tidak berlaku. */
  sourceEvidence: string;
  explicitness: "explicit";
  confidence: number;
}

export type TaskAction = "save" | "offer";
export type MemoryAction = "list" | "forget" | "edit" | "remember";
export type ControlAction =
  | "data"
  | "timezone"
  | "quiet-hours"
  | "active-session"
  | "withdraw-consent"
  | "export"
  | "delete-all";

export interface Understanding {
  intent: ConversationIntent;
  /** Menyimpan langsung, menawarkan, atau tidak memperlakukan teks sebagai tugas. */
  taskAction: TaskAction | null;
  /** Sinyal tindakan eksplisit; adapter tetap wajib membuktikan authority dari user turn. */
  memoryAction: MemoryAction | null;
  /** Topik bahasa alami untuk forget; bukan ID storage dan belum memberi izin mutasi. */
  memoryTarget?: string | null;
  /** Sinyal routing compiler; triase tetap menjadi penilai khusus. */
  riskHint: RiskHint;
  /** @deprecated Kompatibilitas sementara untuk policy/model test lama. */
  safetySensitive: boolean;
  needsStepByStep: boolean;
  /**
   * Assessment advisory dari extractor murah. Optional hanya untuk fixture dan
   * payload lama; parser runtime selalu mengisi object sah atau null.
   */
  routingAssessment?: RoutingAssessment | null;
  /** Public-safe semantic work focus; transient only and never reasoning. */
  publicFocus?: SafePublicProgressFocus | null;
  task: ExtractedTask | null;
  memories: ExtractedMemory[];
  /** Koreksi natural dapat mencabut beberapa primary memory dalam satu turn. */
  memoryRetractions?: ExtractedMemoryRetraction[];
  suggestedActions?: AdaptiveActionId[];
  actionGoal?: string | null;
  controlAction?: ControlAction | null;
  sessionSignal?: SessionSignal | null;
  /** Bounded meaning proposal; never permission or a capability selection. */
  semanticOperation?: SemanticOperation | null;
}

const INTENTS: readonly ConversationIntent[] = [
  "task",
  "feeling",
  "question",
  "request",
  "smalltalk",
  "history",
  "memory",
  "control",
];

const MEMORY_KINDS: readonly MemoryKind[] = [
  "profile",
  "preference",
  "routine",
  "context",
  "personal",
];

const TASK_ACTIONS: readonly TaskAction[] = ["save", "offer"];
const MEMORY_ACTIONS: readonly MemoryAction[] = [
  "list",
  "forget",
  "edit",
  "remember",
];
const MEMORY_SOURCE_SUBJECTS = ["self", "other", "work"] as const;
const MEMORY_DURABILITIES = ["durable", "bounded", "transient"] as const;
const CONTROL_ACTIONS: readonly ControlAction[] = [
  "data",
  "timezone",
  "quiet-hours",
  "active-session",
  "withdraw-consent",
  "export",
  "delete-all",
];
const SESSION_SIGNALS: readonly SessionSignal[] = [
  "continue",
  "stuck",
  "done",
  "cancel",
];
const WORK_COMPLEXITIES: readonly WorkComplexity[] = [
  "mechanical",
  "normal",
  "deep",
];
const ROUTING_DEGREES: readonly RoutingDegree[] = ["low", "medium", "high"];
const EXECUTION_SIZES: readonly ExecutionSize[] = ["small", "medium", "heavy"];
const ROUTING_TOOL_NEEDS: readonly RoutingToolNeed[] = [
  "none",
  "internal_state",
  "calculation",
  "execution",
  "external",
];
const INTENT_ALIASES: Readonly<Record<string, ConversationIntent>> = {
  reminder: "task",
};

/**
 * Batas jumlah memori per pesan.
 *
 * Model yang bersemangat akan mengusulkan setiap potongan kalimat sebagai
 * memori. Daftar memori yang panjang membuat haknya menghapus menjadi tidak
 * berguna: tidak ada yang mau membaca lima puluh baris untuk mencari satu.
 */
const MAX_MEMORIES_PER_MESSAGE = 2;

/** Koreksi gabungan tetap bounded dan tidak boleh menjadi bulk deletion. */
const MAX_MEMORY_RETRACTIONS_PER_MESSAGE = 4;

/** Memori yang lebih panjang dari ini hampir pasti kalimat percakapan. */
const MEMORY_MAX_CHARS = 200;

/**
 * Hasil pass pemahaman inti.
 *
 * `escalate` bukan milik model sendirian. Model mengusulkannya lewat
 * `perluPassPenuh`, dan kode menambahkan syaratnya sendiri di
 * `understandingNeedsFullPass`.
 */
export interface CoreUnderstanding {
  intent: ConversationIntent;
  riskHint: RiskHint;
  needsStepByStep: boolean;
  complexity: "mechanical" | "normal" | "deep";
  /** Usulan model, belum digabung dengan syarat kode. */
  proposesFullPass: boolean;
}

export function parseCoreUnderstanding(raw: string): CoreUnderstanding | null {
  const payload = extractJson(raw);
  if (!payload) return null;
  if (containsPrivateReasoningField(payload)) return null;
  const intent = readIntent(payload["intent"]);
  if (!intent) return null;
  const riskHint = parseRiskHint(payload["riskHint"], false);
  if (!riskHint) return null;
  const complexityRaw = payload["complexity"];
  const complexity =
    complexityRaw === "mechanical" || complexityRaw === "deep"
      ? complexityRaw
      : "normal";
  return {
    intent,
    riskHint,
    needsStepByStep: payload["needsStepByStep"] === true,
    complexity,
    // Bentuk yang tidak terbaca dihitung sebagai "perlu", bukan "tidak".
    // Satu-satunya arah yang aman saat ragu adalah membayar pass penuh.
    proposesFullPass: payload["perluPassPenuh"] !== false,
  };
}

/**
 * Intent yang boleh selesai dengan kontrak inti saja.
 *
 * Empat intent lain—task, memory, control, history—seluruh isinya justru ada
 * di field yang tidak diminta kontrak inti, jadi menjalankannya tanpa pass
 * penuh berarti membuang maksud penggunanya. `request` ikut dikecualikan
 * karena ia yang paling sering membawa pekerjaan durable.
 */
const LIGHT_INTENTS: ReadonlySet<ConversationIntent> = new Set([
  "smalltalk",
  "feeling",
  "question",
]);

/**
 * Petunjuk tekstual bahwa giliran ini menyimpan sesuatu yang lebih dalam.
 *
 * Jaring kedua di bawah penilaian model, bukan penggantinya. Model yang
 * menjawab `perluPassPenuh: false` untuk pesan yang jelas menyebut waktu atau
 * menyebutkan diri penggunanya tetap dinaikkan oleh daftar ini.
 *
 * Sengaja longgar dan sengaja murah: satu kesalahan menaikkan hanya berbiaya
 * pass penuh yang toh dibayar setiap giliran sampai hari ini.
 */
const DEEPER_TURN_CUES =
  /\b(?:ingat|inget|catat|hapus|lupakan|lupain|jangan lupa|ingetin|ingatkan|besok|lusa|kemarin|nanti|jam|pukul|tanggal|senin|selasa|rabu|kamis|jumat|sabtu|minggu|deadline|tenggat|ulangan|ujian|uts|uas|tugas|pr|jadwal|agenda|namaku|nama ?ku|aku kelas|kelas \d|sekolah|kampus|jurusan|langganan|paket|saldo|hapus data|ekspor|zona waktu|sesi)\b/iu;

/**
 * Penyaring gratis yang berjalan SEBELUM model dipanggil sama sekali.
 *
 * Pengukuran 2 September 2026 pada korpus evaluasi menunjukkan rancangan
 * pertama justru nyaris tidak menghemat: hanya 25% giliran selesai murah,
 * sedangkan 75% sisanya membayar pass inti LALU pass penuh. Titik impasnya
 * adalah rasio biaya kedua kontrak, sekitar 20% giliran ringan, dan korpus
 * itu nyaris tepat di garisnya.
 *
 * Petunjuk teks tidak berbiaya apa pun, jadi memeriksanya sesudah memanggil
 * model adalah urutan yang salah. Giliran yang sudah jelas berat dari
 * bentuknya langsung ke kontrak penuh dan tidak pernah membayar dua kali—
 * jalur itu kembali persis seperti sebelum pemecahan ini, tanpa kemunduran.
 */
export function turnLikelyNeedsFullPass(
  message: string,
  options: { hasActiveSession?: boolean } = {},
): boolean {
  // Sesi aktif menjadikan `sessionSignal` bermakna, dan itu hanya ada di
  // kontrak penuh. Tanpanya "udah selesai" tidak pernah menutup sesi.
  if (options.hasActiveSession === true) return true;
  return DEEPER_TURN_CUES.test(message);
}

/**
 * Apakah kontrak penuh tetap wajib dijalankan.
 *
 * Gagal ke arah "wajib". Setiap syarat di sini menaikkan, tidak ada yang
 * menurunkan, sehingga menambah syarat baru tidak pernah bisa membuat Harvy
 * melewatkan sesuatu yang sebelumnya ia tangkap.
 */
export function understandingNeedsFullPass(
  core: CoreUnderstanding,
  message: string,
  options: { hasActiveSession?: boolean } = {},
): boolean {
  if (turnLikelyNeedsFullPass(message, options)) return true;
  if (core.proposesFullPass) return true;
  if (!LIGHT_INTENTS.has(core.intent)) return true;
  // Giliran bertanda safety mendapat sinyal terkaya yang tersedia. Kontrak inti
  // memang membawa riskHint, tetapi bukan `suggestedActions` dan `actionGoal`
  // yang dipakai jalur pendampingan.
  if (core.riskHint.level !== "none") return true;
  // `deep` diarahkan `selectConversationModelRole` ke peran orchestrate. Tanpa
  // routingAssessment, jalur mundurnya hanya bisa mencapai peran itu lewat
  // needsStepByStep atau panjang pesan, sehingga penalaran berlapis yang
  // ringkas akan turun kelas diam-diam.
  if (core.complexity === "deep") return true;
  return false;
}

/**
 * Membentuk `Understanding` lengkap dari kontrak inti.
 *
 * Field yang tidak ditanyakan diisi kosong, bukan ditebak. `routingAssessment`
 * sengaja `null`: `selectConversationModelRole` sudah punya jalur mundur yang
 * memetakan smalltalk dan feeling ke peran percakapan, question ke specialized,
 * dan tetap menaikkan ke orchestrate lewat `needsStepByStep`. Mengarang
 * assessment berkeyakinan tinggi justru akan menimpa jalur itu dengan tebakan.
 */
export function understandingFromCore(
  core: CoreUnderstanding,
): Understanding {
  return {
    intent: core.intent,
    taskAction: null,
    memoryAction: null,
    memoryTarget: null,
    riskHint: core.riskHint,
    safetySensitive: core.riskHint.level !== "none",
    needsStepByStep: core.needsStepByStep,
    routingAssessment: null,
    publicFocus: null,
    task: null,
    memories: [],
    memoryRetractions: [],
    suggestedActions: [],
    actionGoal: null,
    controlAction: null,
    sessionSignal: null,
    semanticOperation: null,
  };
}

export function parseUnderstanding(raw: string): Understanding | null {
  const payload = extractJson(raw);
  if (!payload) return null;
  if (containsPrivateReasoningField(payload)) return null;

  let task = readTask(payload["task"]);
  let taskAction = readTaskAction(payload["taskAction"]);
  let memoryAction = readMemoryAction(payload["memoryAction"]);
  let memoryTarget = readShortText(payload["memoryTarget"], 120);
  const memories = readMemories(payload["memories"]);
  const memoryRetractions = readMemoryRetractions(
    payload["memoryRetractions"],
  );
  let intent = readIntent(payload["intent"]);
  if (!intent) return null;
  const semanticOperation = parseSemanticOperation(
    payload["semanticOperation"],
  );

  // Model kadang sudah memahami makna operasi dengan benar, tetapi memberi
  // label intent generik `request`. Jangan membuang payload task yang sah hanya
  // karena dua field model itu tidak selaras. Rekonsiliasi ini tetap tidak
  // memberi authority: adapter masih mencocokkan evidence semantic dengan
  // pesan asli sebelum write. Sebaliknya, proposal save yang explicit tetapi
  // tidak membawa aksi + payload lengkap ditolak agar jalur percakapan tidak
  // dapat mengarang receipt "sudah dicatat".
  const explicitTaskSave = semanticOperation?.domain === "task" &&
    semanticOperation.operation === "save" &&
    semanticOperation.explicitness === "explicit" &&
    semanticOperation.subject === "self" &&
    semanticOperation.confidence >= 0.85;
  if (explicitTaskSave) {
    if (taskAction !== "save" || task === null) return null;
    intent = "task";
  }

  // Task baru hanya boleh keluar bersama aksi save. Perubahan task tersimpan
  // membawa payload jadwal tanpa aksi save agar tidak pernah berubah menjadi
  // pembuatan task kedua; authority update tetap diverifikasi adapter terhadap
  // pesan asli sebelum mutasi apa pun dilakukan.
  if (intent === "task") {
    const isUpdatePayload = taskAction === null && task !== null &&
      semanticOperation?.domain === "task" &&
      semanticOperation.operation === "update";
    if ((taskAction !== "save" && !isUpdatePayload) || !task) {
      taskAction = null;
      task = null;
    }
  } else if (intent === "feeling") {
    if (taskAction !== "offer" || !task) {
      taskAction = null;
      task = null;
    }
  } else {
    taskAction = null;
    task = null;
  }

  // Pernyataan fakta/preferensi baru pernah salah diberi intent `memory`, lalu
  // adapter membuka daftar memori. Kontrol list/forget hanya sah bila tidak
  // berkontradiksi dengan usulan fakta baru; usulan itu lebih aman diproses
  // sebagai percakapan daripada dibuang oleh cabang kontrol yang berhenti dini.
  if (intent === "memory") {
    const isControl =
      memoryAction === "list" ||
      memoryAction === "forget" ||
      memoryAction === "edit";
    if (!isControl || memories.length > 0 || memoryRetractions.length > 0) {
      intent = "smalltalk";
      if (memoryAction !== "remember") memoryAction = null;
    }
  } else if (memoryAction !== "remember") {
    memoryAction = null;
  }
  if (intent !== "memory" || memoryAction !== "forget") memoryTarget = null;

  const controlAction =
    intent === "control" ? readControlAction(payload["controlAction"]) : null;
  const suggestedActions = readAdaptiveActions(payload["suggestedActions"]);
  const actionGoal = readShortText(payload["actionGoal"], 240);
  const riskHint = parseRiskHint(
    payload["riskHint"],
    payload["safetySensitive"] === true,
  );
  if (!riskHint) return null;
  return {
    intent,
    taskAction,
    memoryAction,
    memoryTarget,
    riskHint,
    safetySensitive: riskHint.level !== "none",
    needsStepByStep: payload["needsStepByStep"] === true,
    routingAssessment: readRoutingAssessment(payload["routingAssessment"]),
    publicFocus: parsePublicProgressFocus(payload["publicFocus"]),
    task,
    memories,
    ...(memoryRetractions.length > 0 ? { memoryRetractions } : {}),
    suggestedActions,
    actionGoal,
    controlAction,
    sessionSignal: readSessionSignal(payload["sessionSignal"]),
    semanticOperation,
  };
}

/**
 * Media privat selalu masuk lane conversation code-owned; hasil extractor
 * tidak pernah diberi authority untuk task, memory, control, atau agent run.
 * Menghindari extractor terpisah menghemat satu model call per gambar. Sinyal
 * bahaya teks tetap dinaikkan oleh policy lokal, sedangkan isi visual ditangani
 * oleh guidance safety pada request multimodal.
 */
export function imageConversationUnderstanding(): Understanding {
  return {
    intent: "request",
    taskAction: null,
    memoryAction: null,
    riskHint: { level: "none", confidence: 1 },
    safetySensitive: false,
    needsStepByStep: false,
    routingAssessment: null,
    publicFocus: null,
    task: null,
    memories: [],
    memoryRetractions: [],
    suggestedActions: [],
    actionGoal: null,
    controlAction: null,
    sessionSignal: null,
    semanticOperation: null,
  };
}

const PRIVATE_REASONING_KEYS = new Set([
  "chainofthought",
  "privatereasoning",
  "reasoningcontent",
  "reasoningdetails",
  "thoughtsignature",
]);

function containsPrivateReasoningField(
  value: unknown,
): boolean {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    // Provider output is JSON, hence acyclic. An excessively nested/wide
    // payload is invalid rather than a reason to stop inspecting fail-open.
    if (++visited > 1_000) return true;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, entry] of Object.entries(current)) {
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z]/gu, "");
      if (PRIVATE_REASONING_KEYS.has(normalizedKey)) return true;
      pending.push(entry);
    }
  }
  return false;
}

function readRoutingAssessment(value: unknown): RoutingAssessment | null {
  const keys = [
    "complexity",
    "ambiguity",
    "planningRequired",
    "emotionalNuance",
    "executionSize",
    "factualStakes",
    "transformationMechanical",
    "toolNeed",
    "confidence",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;

  const complexity = readClosedLabel(value["complexity"], WORK_COMPLEXITIES);
  const ambiguity = readClosedLabel(value["ambiguity"], ROUTING_DEGREES);
  const emotionalNuance = readClosedLabel(
    value["emotionalNuance"],
    ROUTING_DEGREES,
  );
  const executionSize = readClosedLabel(value["executionSize"], EXECUTION_SIZES);
  const factualStakes = readClosedLabel(value["factualStakes"], ROUTING_DEGREES);
  const toolNeed = readClosedLabel(value["toolNeed"], ROUTING_TOOL_NEEDS);
  const confidence = value["confidence"];
  if (
    !complexity || !ambiguity || !emotionalNuance || !executionSize ||
    !factualStakes || !toolNeed ||
    typeof value["planningRequired"] !== "boolean" ||
    typeof value["transformationMechanical"] !== "boolean" ||
    typeof confidence !== "number" || !Number.isFinite(confidence) ||
    confidence < 0 || confidence > 1
  ) return null;

  return Object.freeze({
    complexity,
    ambiguity,
    planningRequired: value["planningRequired"],
    emotionalNuance,
    executionSize,
    factualStakes,
    transformationMechanical: value["transformationMechanical"],
    toolNeed,
    confidence,
  });
}

function readClosedLabel<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.find((candidate) => candidate === label) ?? null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const present = Object.keys(value);
  return present.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function readAdaptiveActions(value: unknown): AdaptiveActionId[] {
  if (!Array.isArray(value)) return [];
  const actions: AdaptiveActionId[] = [];

  for (const entry of value) {
    const action =
      typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!isAdaptiveActionId(action) || actions.includes(action)) continue;
    actions.push(action);
    if (actions.length >= 3) break;
  }
  return actions;
}

function readControlAction(value: unknown): ControlAction | null {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return CONTROL_ACTIONS.find((candidate) => candidate === label) ?? null;
}

function readSessionSignal(value: unknown): SessionSignal | null {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SESSION_SIGNALS.find((candidate) => candidate === label) ?? null;
}

function readShortText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replaceAll(/\s+/g, " ").slice(0, limit);
  return clean || null;
}

/** Membaca jawaban model khusus perubahan tenggat tugas yang sudah ada. */
export function parseDueDate(raw: string): Date | null {
  const payload = extractJson(raw);
  return payload ? readDate(payload["dueAt"]) : null;
}

/**
 * Membaca usulan memori. Yang tidak sah dibuang satu per satu.
 *
 * Sebuah usulan yang cacat tidak boleh menjatuhkan seluruh pembacaan pesan:
 * pengguna akan kehilangan tugasnya hanya karena model salah menamai jenis
 * memori.
 */
function readMemories(value: unknown): ExtractedMemory[] {
  if (!Array.isArray(value)) return [];

  const memories: ExtractedMemory[] = [];

  for (const entry of value) {
    if (memories.length >= MAX_MEMORIES_PER_MESSAGE) break;
    if (!isRecord(entry)) continue;

    const content =
      typeof entry["content"] === "string" ? entry["content"].trim() : "";
    if (!content || content.length > MEMORY_MAX_CHARS) continue;

    const label =
      typeof entry["kind"] === "string" ? entry["kind"].trim().toLowerCase() : "";
    const kind = MEMORY_KINDS.find((candidate) => candidate === label);

    // Jenis yang tidak dikenal diperlakukan sebagai `personal`, bukan dibuang.
    // Menebak ke arah yang lebih longgar berarti menyimpan diam-diam sesuatu
    // yang mungkin sensitif; menebak ke arah yang lebih ketat hanya membuat
    // Harvy bertanya dulu.
    const sourceEvidence = readShortText(entry["sourceEvidence"], 500);
    // Satu kandidat harus ditopang satu klausa. Model pernah menggabungkan
    // preferensi umum dengan arahan "untuk presentasi ini" menjadi satu memori
    // durable. Boundary struktural ini bebas bahasa: bila evidence melompati
    // batas kalimat, kandidat dibuang agar horizon berbeda tidak melebur.
    if (sourceEvidence && containsMultipleEvidenceClauses(sourceEvidence)) {
      continue;
    }
    const sourceSubject = readClosedLabel(
      entry["sourceSubject"],
      MEMORY_SOURCE_SUBJECTS,
    );
    const durability = readClosedLabel(
      entry["durability"],
      MEMORY_DURABILITIES,
    );
    memories.push({
      kind: kind ?? "personal",
      content,
      ...(sourceEvidence ? { sourceEvidence } : {}),
      ...(sourceSubject ? { sourceSubject } : {}),
      ...(durability ? { durability } : {}),
    });
  }

  return memories;
}

function readMemoryRetractions(value: unknown): ExtractedMemoryRetraction[] {
  if (!Array.isArray(value)) return [];

  const retractions: ExtractedMemoryRetraction[] = [];
  for (const entry of value) {
    if (retractions.length >= MAX_MEMORY_RETRACTIONS_PER_MESSAGE) break;
    if (!isRecord(entry)) continue;
    const target = readShortText(entry["target"], 160);
    const sourceEvidence = readShortText(entry["sourceEvidence"], 240);
    const confidence = entry["confidence"];
    if (
      !target || !sourceEvidence ||
      entry["explicitness"] !== "explicit" ||
      typeof confidence !== "number" || !Number.isFinite(confidence) ||
      confidence < 0 || confidence > 1 ||
      containsMultipleEvidenceClauses(sourceEvidence)
    ) continue;
    retractions.push({
      target,
      sourceEvidence,
      explicitness: "explicit",
      confidence,
    });
  }
  return retractions;
}

function containsMultipleEvidenceClauses(value: string): boolean {
  const withoutTrailing = value.trim().replace(/[.!?;]+$/u, "");
  return /[.!?;]\s+\S/u.test(withoutTrailing);
}

/**
 * Model kecil kadang memakai alias di luar label yang diminta, misalnya
 * "reminder" untuk permintaan pengingat.
 *
 * Hanya alias yang didaftarkan eksplisit diterima. Balasan model adalah masukan
 * tidak tepercaya; membiarkan sembarang label berubah menjadi task pernah
 * membuat permintaan kepada Harvy tersimpan sebagai pekerjaan pengguna.
 */
function readIntent(value: unknown): ConversationIntent | null {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  const known = INTENTS.find((candidate) => candidate === label);
  if (known) return known;

  return INTENT_ALIASES[label] ?? null;
}

function readTaskAction(value: unknown): TaskAction | null {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return TASK_ACTIONS.find((candidate) => candidate === label) ?? null;
}

function readMemoryAction(value: unknown): MemoryAction | null {
  const label = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MEMORY_ACTIONS.find((candidate) => candidate === label) ?? null;
}

function readTask(value: unknown): ExtractedTask | null {
  if (!isRecord(value)) return null;

  const title = typeof value["title"] === "string" ? value["title"].trim() : "";
  if (!title) return null;

  return {
    title,
    dueAt: readDate(value["dueAt"]),
    remindAt: readDate(value["remindAt"]),
    importance: readImportance(value["importance"]),
  };
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;

  const iso = value.trim();
  const hasTimeAndOffset =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      iso,
    );
  if (!hasTimeAndOffset) return null;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  // Tenggat yang jatuh jauh di luar akal dianggap salah baca, bukan niat
  // pengguna. Lebih baik kehilangan tenggat daripada memasang yang keliru.
  const years = Math.abs(date.getUTCFullYear() - new Date().getUTCFullYear());
  return years > 5 ? null : date;
}

function readImportance(value: unknown): TaskImportance {
  return value === 1 || value === 3 ? value : 2;
}

/** Mengambil objek JSON pertama, meski terbungkus pagar kode atau basa-basi. */
function extractJson(raw: string): Record<string, unknown> | null {
  const withoutFence = raw
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(withoutFence.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
