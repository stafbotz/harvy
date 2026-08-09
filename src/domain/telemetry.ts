/**
 * Observabilitas tanpa isi percakapan.
 *
 * Tidak ada field teks bebas di bentuk ini. Tujuannya sengaja sempit: mengetahui
 * apakah alur bekerja dan berapa sumber daya model yang dipakai, bukan membaca
 * ulang kehidupan pengguna dari log.
 */
export type UsageTier = "cheap" | "efficient" | "ambitious";

export type AiPurpose =
  | "turn-boundary"
  | "understanding"
  | "due-date"
  | "risk-triage"
  | "memory-privacy"
  | "group-ingress"
  | "reply"
  | "reply-review"
  | "summary"
  | "agent"
  | "research"
  | "insight"
  | "session"
  | "group-participation"
  | "group-reply";

export interface AiUsageContext {
  /** Satu ID untuk seluruh retry key, JSON downgrade, dan fallback. */
  requestId: string;
  /** Satu giliran dapat memicu beberapa logical request. */
  turnId: string | null;
  ownerId: string;
  subjectKind?: "private" | "group";
  channel?: "telegram" | "whatsapp" | "system";
  /** Hanya hidup di request; observer detail wajib meng-hash lalu membuangnya. */
  actorAliases?: readonly string[];
  tier: UsageTier;
  purpose: AiPurpose;
  model: string;
  maxTokens: number;
  /** Perkiraan prompt untuk reservation sebelum penyedia menjawab. */
  inputTokenEstimate: number;
  /** Keselamatan tidak boleh mati hanya karena batas biaya tercapai. */
  safetyCritical: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** `true` bila penyedia tidak mengirim usage dan angka dihitung dari panjang. */
  estimated: boolean;
}

export interface AiUsageRecord extends TokenUsage {
  id: string;
  at: string;
  requestId: string;
  turnId: string | null;
  ownerId: string;
  subjectKind: "private" | "group";
  channel: "telegram" | "whatsapp" | "system";
  tier: UsageTier;
  purpose: AiPurpose;
  model: string;
  maxTokens: number;
  inputTokenEstimate: number;
  safetyCritical: boolean;
  /** Hanya hasil nilai pengguna yang mengurangi kapasitas komersial. */
  billable: boolean;
  estimatedCostUsd: number;
  succeeded: boolean;
  latencyMs: number;
}

export type TurnTelemetryOutcome = "completed" | "failed" | "cancelled";

/**
 * Metrik satu giliran logis tanpa isi percakapan.
 *
 * Seluruh field sengaja berupa enum/count/durasi. Record ini tidak boleh
 * membawa prompt, balasan, ringkasan, label risiko seseorang, atau reasoning
 * provider. `turnId` hanya korelasi acak per giliran dan bukan identitas
 * pengguna.
 */
export interface TurnTelemetryRecord {
  id: string;
  at: string;
  turnId: string;
  ownerId: string;
  subjectKind: "private" | "group";
  channel: "telegram" | "whatsapp" | "system";
  outcome: TurnTelemetryOutcome;
  bubbleCount: number;
  batchWaitMs: number;
  queueWaitMs: number;
  handlingLatencyMs: number;
  totalLatencyMs: number;
  modelCallCount: number;
  failedModelCallCount: number;
  boundaryCallCount: number;
  understandingCallCount: number;
  riskTriageCallCount: number;
  replyCallCount: number;
  replyReviewCallCount: number;
  agentCallCount: number;
  deterministicFastPathCount: number;
  riskTriageUnavailableCount: number;
  safetyFallbackCount: number;
  safeActionBlockedCount: number;
  urgentAcknowledgementCount: number;
}

export type ProductEventKind =
  | "adaptive_action_chosen"
  | "session_started"
  | "session_progressed"
  | "session_completed"
  | "session_stopped"
  | "checkin_scheduled"
  | "checkin_sent"
  | "checkin_completed"
  | "memory_edited"
  | "data_exported"
  | "consent_withdrawn";

export interface ProductEvent {
  id: string;
  ownerId: string;
  kind: ProductEventKind;
  at: string;
}

export interface TelemetryRepository {
  appendUsage(record: AiUsageRecord): Promise<void>;
  appendEvent(event: ProductEvent): Promise<void>;
  /** Idempoten untuk pasangan `ownerId` + `turnId`. */
  appendTurn(record: TurnTelemetryRecord): Promise<void>;
  usageSince(ownerId: string, since: Date): Promise<AiUsageRecord[]>;
  eventsSince(ownerId: string, since: Date): Promise<ProductEvent[]>;
  turnsSince(ownerId: string, since: Date): Promise<TurnTelemetryRecord[]>;
  removeBefore(before: Date): Promise<void>;
  removeAll(ownerId: string): Promise<void>;
}

export interface UsageObserver {
  beforeRequest(context: AiUsageContext): Promise<void>;
  afterRequest(
    context: AiUsageContext,
    usage: TokenUsage,
    outcome: { succeeded: boolean; latencyMs: number },
  ): Promise<void>;
}
