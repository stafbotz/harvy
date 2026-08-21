import type { MemoryKind } from "../domain/memory.js";
import type { TaskImportance } from "../domain/task.js";
import type { SessionSignal } from "../domain/session.js";
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
  /** Tindakan eksplisit terhadap memori; fakta baru sendiri bukan tindakan list. */
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
  task: ExtractedTask | null;
  memories: ExtractedMemory[];
  suggestedActions?: AdaptiveActionId[];
  actionGoal?: string | null;
  controlAction?: ControlAction | null;
  sessionSignal?: SessionSignal | null;
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

/** Memori yang lebih panjang dari ini hampir pasti kalimat percakapan. */
const MEMORY_MAX_CHARS = 200;

export function parseUnderstanding(raw: string): Understanding | null {
  const payload = extractJson(raw);
  if (!payload) return null;

  let task = readTask(payload["task"]);
  let taskAction = readTaskAction(payload["taskAction"]);
  let memoryAction = readMemoryAction(payload["memoryAction"]);
  let memoryTarget = readShortText(payload["memoryTarget"], 120);
  const memories = readMemories(payload["memories"]);
  let intent = readIntent(payload["intent"]);
  if (!intent) return null;

  // Hanya dua kombinasi yang boleh membawa tugas keluar dari parser. Hal ini
  // mencegah objek kontradiktif seperti request+offer memicu tombol tugas pada
  // adapter, serta mencegah task tanpa izin eksplisit tersimpan.
  if (intent === "task") {
    if (taskAction !== "save" || !task) {
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
    if (!isControl || memories.length > 0) {
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
    task,
    memories,
    suggestedActions,
    actionGoal,
    controlAction,
    sessionSignal: readSessionSignal(payload["sessionSignal"]),
  };
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
    memories.push({ kind: kind ?? "personal", content });
  }

  return memories;
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
