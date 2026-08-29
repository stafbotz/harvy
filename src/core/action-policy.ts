import type {
  ConversationIntent,
  RoutingAssessment,
} from "../ai/model-policy.js";
import type { SemanticOperation } from "../domain/semantic-operation.js";
import type { RiskLevel } from "./safety-policy.js";

/**
 * Daftar kemampuan yang boleh dipilih model.
 *
 * Model hanya menghasilkan ID. Label, callback, prasyarat, dan akibatnya tetap
 * dibuat serta divalidasi kode Harvy.
 */
export const ADAPTIVE_ACTION_IDS = [
  "listen",
  "clarify",
  "prioritize",
  "start_small",
  "tutor",
  "plan",
  "human_bridge",
  "schedule_checkin",
  "view_session",
  "stop_session",
  "data_controls",
] as const;

export type AdaptiveActionId = (typeof ADAPTIVE_ACTION_IDS)[number];

export interface ActionPolicyInput {
  intent: ConversationIntent;
  risk: RiskLevel;
  hasActiveSession: boolean;
  hasBlockingQuestion: boolean;
}

const ALLOWED_BY_INTENT: Record<
  ConversationIntent,
  readonly AdaptiveActionId[]
> = {
  task: ["prioritize", "start_small", "plan"],
  feeling: [
    "listen",
    "clarify",
    "prioritize",
    "start_small",
    "human_bridge",
  ],
  question: ["tutor", "human_bridge"],
  request: ["tutor", "human_bridge"],
  smalltalk: [],
  history: ["view_session"],
  memory: ["data_controls"],
  control: [],
};

export function adaptiveActions(
  proposed: readonly AdaptiveActionId[],
  input: ActionPolicyInput,
): AdaptiveActionId[] {
  if (input.risk !== "biasa" || input.hasBlockingQuestion) return [];

  if (input.hasActiveSession) {
    const allowed = new Set<AdaptiveActionId>([
      "schedule_checkin",
      "view_session",
      "stop_session",
    ]);
    return uniqueKnown(proposed).filter((id) => allowed.has(id)).slice(0, 1);
  }

  const allowed = new Set(ALLOWED_BY_INTENT[input.intent]);
  const inactiveOnly = uniqueKnown(proposed).filter(
    (id) =>
      id !== "schedule_checkin" &&
      id !== "view_session" &&
      id !== "stop_session",
  );
  return inactiveOnly.filter((id) => allowed.has(id)).slice(0, 1);
}

/**
 * Menyelesaikan konflik dua sinyal model tanpa membaca kata mentah pengguna.
 * Interaksi satu langkah yang kecil dan tanpa tool lebih tepat ditawarkan
 * sebagai sesi terpandu daripada dinaikkan menjadi AgentRun durable.
 *
 * Sinyal ini hanya memilih presentasi. Ia tidak membuat sesi atau menulis
 * state; pengguna tetap perlu menerima kontrol code-owned pada kanalnya.
 */
export function prefersGuidedSmallStep(
  proposed: readonly AdaptiveActionId[],
  assessment: RoutingAssessment | null | undefined,
): boolean {
  if (
    proposed[0] !== "start_small" ||
    !assessment ||
    assessment.confidence < 0.55
  ) return false;

  return assessment.complexity !== "deep" &&
    assessment.executionSize === "small" &&
    assessment.factualStakes !== "high" &&
    assessment.toolNeed === "none" &&
    !assessment.transformationMechanical;
}

/**
 * Permintaan mengubah tugas yang tidak akan dikerjakan jalur deterministik.
 *
 * `understand()` membuang `taskAction` beserta payload-nya begitu intent,
 * explicitness, atau confidence-nya tidak persis, dan `immediateUnderstandingRoute`
 * lalu memilih `conversation`. Akibatnya kalimat seperti "besok ada ulangan
 * fisika, ingetin ya" bisa berakhir tanpa tindakan apa pun dan tanpa
 * pemberitahuan apa pun kepada pengguna.
 *
 * Sinyal ini hanya dipakai pemanggil yang sudah berada di cabang `conversation`,
 * jadi tidak pernah menduplikasi write deterministik. Ia juga tidak memberi
 * authority menulis: harness, policy otorisasi, dan validator executor tetap
 * memutuskan. Yang diberikan hanya kesempatan bagi model untuk memakai tool
 * lalu melaporkan hasil terbukti, atau bertanya bila memang kurang jelas.
 */
export function requestsUnhandledTaskChange(
  operation: SemanticOperation | null | undefined,
): boolean {
  if (!operation || operation.domain !== "task") return false;
  if (operation.subject !== "self") return false;
  // Ambang yang sama dengan sinyal routing lain. Di bawah ini label semantic
  // lebih sering derau daripada permintaan.
  if (operation.confidence < 0.55) return false;
  // `implicit` berarti model menebak dari suasana, bukan dari permintaan.
  if (operation.explicitness === "implicit") return false;
  return operation.operation === "save" ||
    operation.operation === "update" ||
    operation.operation === "complete" ||
    // Pembatalan tidak punya route deterministik sama sekali, jadi ia selalu
    // "belum tertangani" dan wajib melewati konfirmasi Agent Runtime.
    operation.operation === "cancel";
}

/** Pagar terakhir: tombol tidak boleh bersaing dengan pertanyaan bebas. */
export function replyHasBlockingQuestion(reply: string): boolean {
  const prose = reply.replaceAll(/```[\s\S]*?```/gu, "");
  if (/[?？]/u.test(prose)) return true;

  return /(?:^|[.!]\s+|[,;:]\s*)(?:coba\s+)?(?:ceritain|ceritakan|jelasin|jelaskan|sebutkan|tuliskan|tulis|jawab|pilih|kasih\s+tahu)\b/imu.test(
    prose,
  );
}

export function isAdaptiveActionId(
  value: unknown,
): value is AdaptiveActionId {
  return (
    typeof value === "string" &&
    (ADAPTIVE_ACTION_IDS as readonly string[]).includes(value)
  );
}

function uniqueKnown(
  values: readonly AdaptiveActionId[],
): AdaptiveActionId[] {
  return [...new Set(values.filter(isAdaptiveActionId))];
}
