/**
 * Memilih model berdasarkan kebutuhan pekerjaan, bukan paket yang dibayar
 * pengguna atau nama provider/model tertentu.
 *
 * `ModelTier` tetap menjadi kelas biaya/accounting yang kompatibel dengan
 * konfigurasi lama. `CognitiveModelRole` menyatakan pekerjaan intelektual yang
 * dibutuhkan. Binding role ke tier atau exact model adalah konfigurasi tepercaya
 * dan dapat diganti tanpa mengubah policy bisnis.
 *
 * Modul ini murni: tidak memanggil jaringan dan tidak membaca konfigurasi.
 */
import type { RiskLevel } from "../core/safety-policy.js";

export type ModelTier = "cheap" | "efficient" | "ambitious";
/** Slot escalation-only; ordinary routing never returns it. */
export type ExecutionModelTier = ModelTier | "toughest";

/** Peran kognitif bukan ladder IQ dan bukan nama provider/model. */
export const COGNITIVE_MODEL_ROLES = [
  "mechanical",
  "everyday_conversation",
  "orchestrator",
  "strong_worker",
  "heavy_executor",
  "verifier",
  "challenger",
] as const;

export type CognitiveModelRole = (typeof COGNITIVE_MODEL_ROLES)[number];

/** Binding code-owned/config-owned; model tidak pernah memilihnya sendiri. */
export interface CognitiveModelBinding {
  /** Kelas accounting dan fallback konfigurasi lama. */
  tier: ModelTier;
  /** Exact model aktif untuk role ini; kosong berarti memakai model tier. */
  modelId?: string;
}

export interface RoleAwareRoutingConfig {
  mode: "testing" | "production";
  testingModel: string;
  testingModels?: Partial<Record<ModelTier, string>>;
  models: Record<ModelTier, string>;
  roleBindings?: Partial<Record<CognitiveModelRole, CognitiveModelBinding>>;
}

export interface ResolvedModelRoute {
  role: CognitiveModelRole;
  tier: ModelTier;
  modelId: string;
}

export type ConversationIntent =
  | "task"
  | "feeling"
  | "question"
  | "request"
  | "smalltalk"
  | "history"
  | "memory"
  | "control";

export type WorkComplexity = "mechanical" | "normal" | "deep";
export type RoutingDegree = "low" | "medium" | "high";
export type ExecutionSize = "small" | "medium" | "heavy";
export type RoutingToolNeed =
  | "none"
  | "internal_state"
  | "calculation"
  | "execution"
  | "external";

/**
 * Data semantik bounded dari extractor murah. Seluruh field advisory dan
 * diperlakukan sebagai input tidak tepercaya oleh policy di bawah.
 */
export interface RoutingAssessment {
  complexity: WorkComplexity;
  ambiguity: RoutingDegree;
  planningRequired: boolean;
  emotionalNuance: RoutingDegree;
  executionSize: ExecutionSize;
  factualStakes: RoutingDegree;
  transformationMechanical: boolean;
  toolNeed: RoutingToolNeed;
  confidence: number;
}

export interface RoutingInput {
  intent: ConversationIntent;
  /** Panjang hanya fallback kompatibilitas bila assessment baru tidak ada. */
  messageLength: number;
  /** Pengguna meminta dituntun bertahap, bukan sekadar jawaban. */
  needsStepByStep?: boolean;
  /** Assessment semantic baru; null/undefined mempertahankan route lama. */
  assessment?: RoutingAssessment | null;
  /** Fast path lokal yang sudah diputuskan kode sebelum model routing. */
  deterministicFastPath?: boolean;
  /** Flow/tool khusus yang dipilih high-precision code-owned preflight. */
  specializedFlow?: boolean;
  /** Policy UX memilih interaksi ringan dari sinyal model bounded. */
  guidedInteraction?: boolean;
  /**
   * Percakapan menyinggung keselamatan, seperti menyakiti diri, kekerasan,
   * pelecehan, atau eksploitasi.
   */
  safetySensitive?: boolean;
  /** Hasil triase risiko, bila pemeriksaannya sempat berjalan. */
  risk?: RiskLevel;
  /**
   * Pilihan intelligence code-owned untuk jalur safety. Operational authority
   * tetap ditentukan work class/policy dan tidak ikut naik bersama model.
   */
  safetyCognitiveRole?: Extract<
    CognitiveModelRole,
    "everyday_conversation" | "orchestrator"
  >;
}

export type GlobalWorkRoute =
  | "deterministic"
  | "conversation"
  | "specialized"
  | "orchestrate";
export type AgentRoutingMode = "tools" | "orchestrate";

/** Hanya dipakai untuk fallback checkpoint/fixture sebelum assessment baru. */
const LEGACY_LONG_MESSAGE = 280;

const DEFAULT_ROLE_TIERS: Readonly<Record<CognitiveModelRole, ModelTier>> =
  Object.freeze({
    mechanical: "cheap",
    everyday_conversation: "efficient",
    orchestrator: "ambitious",
    strong_worker: "efficient",
    heavy_executor: "ambitious",
    verifier: "ambitious",
    challenger: "ambitious",
  });

/**
 * Global router hanya memilih siapa yang menangani request pertama. Ia tidak
 * memprediksi atau memaksakan perjalanan internal task setelah orkestrasi.
 */
export function selectGlobalRoute(input: RoutingInput): GlobalWorkRoute {
  if (input.deterministicFastPath) return "deterministic";

  // Safety mempunyai compiler dan review selektif tersendiri. Nuansa emosi
  // tidak boleh secara otomatis mengaktifkan agent graph atau tool.
  if (
    input.risk === "dukungan" || input.risk === "bahaya" ||
    input.safetySensitive
  ) return "conversation";

  // High-precision flow code-owned tidak boleh dikalahkan classifier semantik.
  if (input.specializedFlow) return "specialized";

  // Resolusi konflik ini terjadi setelah safety dan flow state-live. Sinyal
  // model tidak memperoleh authority baru; policy hanya mencegah interaksi
  // terpandu yang kecil dinaikkan menjadi pekerjaan durable.
  if (input.guidedInteraction) return "conversation";

  const assessment = input.assessment;
  // Low-confidence semantic output cannot override compatibility/high-precision
  // routing. It remains useful telemetry/eval data but not a route signal.
  if (assessment && assessment.confidence >= 0.55) {
    const mechanical =
      assessment.complexity === "mechanical" ||
      assessment.transformationMechanical;
    const deep =
      assessment.complexity === "deep" ||
      requiresPlannedExecution(assessment) ||
      (assessment.executionSize === "heavy" && !mechanical) ||
      (assessment.emotionalNuance === "high" &&
        (assessment.ambiguity === "high" ||
          assessment.factualStakes === "high")) ||
      (assessment.ambiguity === "high" &&
        assessment.factualStakes === "high");
    if (deep) return "orchestrate";
    if (assessment.toolNeed !== "none") {
      return "specialized";
    }
    return "conversation";
  }

  // Compatibility untuk checkpoint/test double lama. Runtime baru meminta
  // assessment sehingga panjang tidak lagi menjadi proxy utama.
  if (input.needsStepByStep || input.messageLength > LEGACY_LONG_MESSAGE) {
    return "orchestrate";
  }
  return input.intent === "question" || input.intent === "request"
    ? "specialized"
    : "conversation";
}

/**
 * Planning durable diusulkan assessment model yang bounded, lalu dipersempit
 * oleh confidence dan policy pekerjaan mekanis milik kode. Kata mentah tidak
 * pernah menaikkan request menjadi AgentRun.
 */
export function requiresPlannedExecution(
  assessment: RoutingAssessment | null | undefined,
): boolean {
  if (!assessment || assessment.confidence < 0.55) return false;
  const mechanical = assessment.complexity === "mechanical" ||
    assessment.transformationMechanical;
  const executionBacked = assessment.toolNeed === "execution" ||
    assessment.toolNeed === "external";
  const substantial = assessment.executionSize === "medium" ||
    assessment.executionSize === "heavy";
  return assessment.planningRequired && !mechanical && executionBacked &&
    substantial;
}

/**
 * Menilai apakah assessment meminta kemampuan tool, bukan sekadar penalaran.
 *
 * Nilai ini tetap advisory dan tidak pernah cukup untuk mutasi state. Adapter
 * masih wajib membuktikan intent, scope, permission, serta authority operasi.
 * `internal_state` sengaja tidak diterima dari model saja: jalur itu harus
 * dibuktikan oleh preflight state-live code-owned pada adapter.
 */
export function requestsAgentTooling(
  assessment: RoutingAssessment | null | undefined,
): boolean {
  if (!assessment || assessment.confidence < 0.55) return false;
  // `calculation` tidak menunjuk capability callable tertentu. Operasi
  // aritmetika sempit selesai di fast path exact; bentuk lain tetap mendapat
  // jawaban model biasa. Memberi Agent Runtime authority hanya dari label ini
  // pernah mengirim 17+28 ke terminal/planner generik dan berakhir tanpa
  // jawaban. Execution/external tetap membutuhkan runtime tool sungguhan.
  return assessment.toolNeed === "execution" ||
    assessment.toolNeed === "external";
}

/**
 * Surface deterministik cocok untuk navigasi/state read yang benar-benar
 * mekanis. Permintaan normal atau deep tetap dijawab oleh model meski semantic
 * extractor keliru mengusulkan domain menu/account.
 */
export function allowsDeterministicSurface(
  assessment: RoutingAssessment | null | undefined,
): boolean {
  if (!assessment || assessment.confidence < 0.55) return false;
  if (requiresPlannedExecution(assessment)) return false;
  return assessment.complexity === "mechanical" ||
    assessment.transformationMechanical;
}

/** Adapter kompatibilitas untuk surface yang masih memakai dua mode agent. */
export function selectAgentMode(input: RoutingInput): AgentRoutingMode {
  return selectGlobalRoute(input) === "orchestrate"
    ? "orchestrate"
    : "tools";
}

/** Suara user-facing: everyday atau orchestrator, tanpa rewrite lintas model. */
export function selectConversationModelRole(
  input: RoutingInput,
): Extract<CognitiveModelRole, "everyday_conversation" | "orchestrator"> {
  if (
    input.risk === "dukungan" || input.risk === "bahaya" ||
    input.safetySensitive
  ) {
    return input.safetyCognitiveRole ?? "everyday_conversation";
  }
  return selectGlobalRoute(input) === "orchestrate"
    ? "orchestrator"
    : "everyday_conversation";
}

/**
 * Compatibility tier policy. Call path baru sebaiknya memilih cognitive role
 * lalu memakai `resolveModelRoute`; fungsi ini tetap menjaga pemanggil lama.
 */
export function selectTier(input: RoutingInput): ModelTier {
  if (input.risk === "dukungan" || input.risk === "bahaya") return "efficient";
  if (input.safetySensitive) return "efficient";

  switch (input.intent) {
    case "question":
    case "request":
      return selectGlobalRoute(input) === "orchestrate"
        ? "ambitious"
        : "efficient";

    case "feeling":
      return "efficient";

    case "task":
    case "smalltalk":
    case "history":
    case "control":
    case "memory":
      return "cheap";
  }
}

/**
 * Menerjemahkan tingkatan menjadi ID model yang benar-benar dipanggil.
 * Selama mode testing, fallback satu model lama tetap berlaku.
 */
export function resolveModel(
  tier: ModelTier,
  routing: RoleAwareRoutingConfig,
): string {
  if (routing.mode !== "testing") return routing.models[tier];
  return routing.testingModels?.[tier] || routing.testingModel;
}

/** Memisahkan role kognitif dari tier accounting dan exact model aktif. */
export function resolveModelRoute(
  role: CognitiveModelRole,
  routing: RoleAwareRoutingConfig,
): ResolvedModelRoute {
  const binding = routing.roleBindings?.[role];
  const tier = binding?.tier ?? DEFAULT_ROLE_TIERS[role];
  const configuredModel = binding?.modelId?.trim();
  const modelId = configuredModel || resolveModel(tier, routing);
  if (!modelId) {
    throw new Error(`Model untuk cognitive role ${role} belum dikonfigurasi.`);
  }
  return Object.freeze({ role, tier, modelId });
}
