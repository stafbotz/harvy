import type {
  ConversationTurn,
  EpisodeSummaryDraft,
  StoredConversationTurn,
} from "../domain/history.js";
import type { UserInsight } from "../domain/insight.js";
import type { StylePreference } from "../domain/profile.js";
import type { ActiveSession } from "../domain/session.js";
import type { AiPurpose } from "../domain/telemetry.js";
import type { TurnBoundaryState } from "../core/turn-taking-policy.js";
import type {
  AiClient,
  ChatAssistantToolMessage,
  ChatMessage,
  ChatRequest,
  ChatToolChoice,
} from "./client.js";
import { currentUsageAttribution } from "./usage-attribution.js";
import { EMPTY_CONTEXT, type HarvyContext } from "./context.js";
import {
  CAPYBARA_MIXED_MESSAGE_GUIDANCE,
  CAPYBARA_MODEL_REPLY,
  isModelIdentityQuestion,
  isPureModelIdentityQuestion,
  prependCapybaraIdentity,
} from "./identity.js";
import {
  resolveModel,
  selectTier,
  type ConversationIntent,
  type ModelTier,
} from "./model-policy.js";
import {
  agentNativeTools,
  agentPlannerInput,
  agentPlannerPrompt,
  liveStateRequirement,
  parseAgentNativeDecision,
  type AgentMode,
} from "./agent.js";
import {
  depthDirective,
  dueDateInput,
  dueDatePrompt,
  replyPrompt,
  turnBoundaryInput,
  TURN_BOUNDARY_PROMPT,
  understandingInput,
  understandingPrompt,
} from "./persona.js";
import {
  EPISODE_SUMMARY_PROMPT,
  episodeSummaryInput,
  parseEpisodeSummary,
} from "./episode-summary.js";
import {
  CALM_TRIAGE,
  insightInput,
  INSIGHT_PROMPT,
  parseInsightDraft,
  parseReplyVerdict,
  parseRiskTriage,
  replyReviewInput,
  REPLY_REVIEW_PROMPT,
  riskTriageInput,
  RISK_TRIAGE_PROMPT,
  safetyGuidance,
  type InsightDraftShape,
  type RiskTriage,
} from "./safety.js";
import {
  GROUP_INGRESS_PROMPT,
  groupIngressInput,
  parseGroupIngressAssessment,
  type GroupIngressAssessment,
} from "./group-ingress.js";
import {
  parseDueDate,
  parseUnderstanding,
  type ExtractedMemory,
  type Understanding,
} from "./understand.js";
import {
  MEMORY_PRIVACY_PROMPT,
  memoryPrivacyInput,
  parseMemoryPrivacy,
} from "./memory-privacy.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import {
  DEFAULT_HARVY_AGENT_HARNESS,
  type AgentCapabilityExecutor,
  type AgentHarness,
  type AgentObservation,
  type AgentPlannerDecision,
  type AgentPlannerInput,
  type AgentRunCheckpoint,
  type AgentRunResult,
} from "../harness/agent-harness.js";
import {
  compileHarvyContext,
  TURNS_ONLY_CONTEXT_PROJECTION,
} from "../harness/context-budget.js";
import {
  privateAgentScope,
  type AgentChannel,
  type AgentScope,
} from "../harness/scope.js";
import { deterministicTimeReply } from "../agent/time-fast-path.js";
import {
  DEFAULT_EXECUTION_POLICY,
  type ExecutionPlan,
  type ExecutionPolicy,
  type ExecutionWorkClass,
} from "../core/execution-policy.js";
import type { ModelRole } from "../domain/model-execution.js";
import {
  resolveModelProfile,
  type ModelProfileRegistry,
} from "./model-profile.js";

export interface RoutingConfig {
  mode: "testing" | "production";
  providerId?: string;
  testingModel: string;
  testingModels?: Partial<Record<ModelTier, string>>;
  models: Record<ModelTier, string>;
  modelProfiles?: ModelProfileRegistry;
}

export interface ConversationRuntime {
  ownerId?: string;
  channel?: AgentChannel;
  scope?: AgentScope;
  timeZone?: string;
  session?: ActiveSession | null;
  plannedActionLabels?: readonly string[];
  /** Kontrak suara/intent untuk jawaban final Agent Runtime. */
  style?: StylePreference | null;
  intent?: ConversationIntent;
  /** Cancellation dan generation guard dari adapter untuk run agent panjang. */
  signal?: AbortSignal;
  isCurrent?: () => boolean | Promise<boolean>;
}

/**
 * Batas token yang lapang, bukan boros.
 *
 * Model penalaran memakai token keluaran untuk berpikir sebelum menulis
 * jawabannya. Dengan batas sempit, seluruh jatah habis di bagian berpikir dan
 * jawabannya terpotong di tengah.
 *
 * Ini bukan dugaan. Pada 26 Juli 2026, dengan batas 400 token,
 * "ingetin aku pukul sebelas lewat 36 menit untuk minum obat" menghasilkan
 * balasan yang berhenti setelah dua baris:
 * `{ "intent": "task", "safetySensitive": false` — tanpa penutup. Sapaan pendek
 * tetap lolos karena hampir tidak perlu berpikir, sehingga cacatnya hanya
 * muncul pada kalimat yang justru paling penting.
 *
 * Batas ini plafon, bukan tagihan: yang dibayar hanya token yang benar-benar
 * dihasilkan.
 */
// Diekspor agar `scripts/coba-pemahaman.ts` memakai angka yang sama persis.
// Skrip itu pernah tertinggal di 400 setelah angka di sini dinaikkan, sehingga
// alat diagnostiknya sendiri mereproduksi cacat yang ia dibuat untuk mencari.
export const UNDERSTANDING_MAX_TOKENS = 2048;
const REPLY_MAX_TOKENS = 4096;
export const TURN_BOUNDARY_MAX_TOKENS = 128;
export const TURN_BOUNDARY_TIMEOUT_MS = 2_000;

/**
 * Triase risiko berjalan berbarengan dengan ekstraksi, jadi jatahnya kecil dan
 * batas waktunya ketat. Yang dihasilkan hanya empat field pendek.
 */
export const TRIAGE_MAX_TOKENS = 256;
/**
 * Lebih lapang daripada batas giliran, karena arah kegagalannya jauh lebih
 * mahal. Uji QA 27 Juli 2026 melihat batas 6 detik benar-benar terlampaui pada
 * model uji gratis. Pada jalur emergency lokal ia dapat berjalan tanpa
 * compiler; pada jalur selektif lain ia dimulai setelah compiler menghasilkan
 * RiskHint `possible` atau `strong`.
 */
export const TRIAGE_TIMEOUT_MS = 12_000;

/** Pemeriksaan balasan hanya menghasilkan satu boolean dan satu alasan. */
const REVIEW_MAX_TOKENS = 256;
const REVIEW_TIMEOUT_MS = 8_000;
const MEMORY_PRIVACY_MAX_TOKENS = 128;
const MEMORY_PRIVACY_TIMEOUT_MS = 8_000;
const GROUP_INGRESS_MAX_TOKENS = 192;
const GROUP_INGRESS_TIMEOUT_MS = 8_000;
const INSIGHT_MAX_TOKENS = 512;

/**
 * Ringkasan sengaja diberi jatah kecil.
 *
 * Ia menggantikan giliran mentah yang dibuang, jadi ringkasan yang panjang
 * menghapus alasan pemadatan itu sendiri.
 */
const EPISODE_SUMMARY_MAX_TOKENS = 768;
const AGENT_PLANNER_MAX_TOKENS = 4096;
const GENERAL_MODEL_DEADLINE_MS = 30_000;

interface AgentNativeThread {
  messages: ChatMessage[];
  pending: {
    step: number;
    capabilityId: string;
    assistant: ChatAssistantToolMessage;
  } | null;
}

interface RequestedAgentDecision {
  decision: AgentPlannerDecision;
  assistant: ChatAssistantToolMessage;
}

/**
 * Menyatukan pemahaman dan balasan menjadi satu alur percakapan.
 *
 * Setelah batas bubble diputuskan, giliran utuh berjalan dua langkah. Model
 * termurah membaca pesan menjadi data terstruktur, lalu tingkatan model untuk
 * balasan dipilih dari hasil pembacaan itu. Dengan begitu pekerjaan ekstraksi
 * tidak pernah membayar harga model besar, dan percakapan yang memang sulit
 * tidak pernah dilayani model kecil.
 *
 * Konteks — ingatan Harvy tentang penggunanya — masuk ke **kedua** langkah.
 * Memberikannya hanya pada langkah balasan adalah kesalahan yang menggoda:
 * "iya yang tadi itu" gagal dipahami justru di langkah pertama.
 */
export class Conversation {
  constructor(
    private readonly client: AiClient,
    private readonly routing: RoutingConfig,
    private readonly defaultTimeZone: string,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("ai.conversation"),
    private readonly harness: AgentHarness = DEFAULT_HARVY_AGENT_HARNESS,
    private readonly agentExecutors: readonly AgentCapabilityExecutor[] = [],
    private readonly executionPolicy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY,
  ) {}

  /** Mengembalikan `null` bila model gagal menghasilkan bentuk yang sah. */
  async understand(
    message: string,
    context: HarvyContext = EMPTY_CONTEXT,
    runtime: ConversationRuntime = {},
  ): Promise<Understanding | null> {
    const timeZone = runtime.timeZone ?? this.defaultTimeZone;
    const { context: boundedContext, manifest: contextManifest } =
      compileHarvyContext(context);
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: UNDERSTANDING_MAX_TOKENS,
      execution: this.execution(
        "cheap",
        "extractor",
        "mechanical",
        UNDERSTANDING_MAX_TOKENS,
        GENERAL_MODEL_DEADLINE_MS,
      ),
      json: true,
      validateResponse: (content) => parseUnderstanding(content) !== null,
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      contextManifest,
      usage: this.usage(runtime.ownerId, "cheap", "understanding"),
      messages: [
        {
          role: "system",
          content: understandingPrompt(this.now(), timeZone),
        },
        // Dibungkus, bukan dikirim mentah: pesan pengguna adalah data yang
        // diklasifikasikan, dan tidak boleh terbaca sebagai instruksi. Konteks
        // ikut dibungkus karena isinya juga berasal dari pengguna.
        {
          role: "user",
          content: understandingInput(
            message,
            boundedContext,
            runtime.session,
          ),
        },
      ],
    });

    const understanding = parseUnderstanding(raw);

    if (!understanding) {
      // Tanpa ini, kegagalan membaca balasan model tidak meninggalkan jejak sama
      // sekali dan hanya terlihat sebagai "aku belum menangkap maksudnya" di
      // sisi pengguna. Dipotong agar log tidak menyimpan seluruh isi percakapan.
      this.logger.warn(
        "understanding_parse_failed",
        "Balasan model untuk pemahaman tidak dapat dibaca.",
      );
    }

    return understanding;
  }

  /** Mengurai jawaban pada alur Ubah tenggat tanpa melewati intent umum. */
  async understandDueDate(
    message: string,
    runtime: ConversationRuntime = {},
  ): Promise<Date | null> {
    const timeZone = runtime.timeZone ?? this.defaultTimeZone;
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: UNDERSTANDING_MAX_TOKENS,
      execution: this.execution(
        "cheap",
        "extractor",
        "mechanical",
        UNDERSTANDING_MAX_TOKENS,
        GENERAL_MODEL_DEADLINE_MS,
      ),
      json: true,
      validateResponse: (content) => parseDueDate(content) !== null,
      usage: this.usage(runtime.ownerId, "cheap", "due-date"),
      messages: [
        {
          role: "system",
          content: dueDatePrompt(this.now(), timeZone),
        },
        { role: "user", content: dueDateInput(message) },
      ],
    });

    return parseDueDate(raw);
  }

  /**
   * Menentukan apakah kumpulan bubble complete, open, incomplete, atau urgent.
   *
   * Dipakai hanya sebagai fallback untuk boundary yang ambigu. Ia memakai
   * tingkatan termurah dan satu percobaan. Kegagalannya ditangani
   * `MessageBatcher`, jadi keputusan UX ini tidak boleh menahan percakapan
   * selama rotasi seluruh kunci.
   */
  async classifyTurnBoundary(
    message: string,
    ownerId?: string,
  ): Promise<TurnBoundaryState> {
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: TURN_BOUNDARY_MAX_TOKENS,
      execution: this.execution(
        "cheap",
        "classifier",
        "mechanical",
        TURN_BOUNDARY_MAX_TOKENS,
        TURN_BOUNDARY_TIMEOUT_MS,
      ),
      timeoutMs: TURN_BOUNDARY_TIMEOUT_MS,
      maxAttempts: 1,
      json: true,
      validateResponse: (content) => parseTurnBoundaryDecision(content) !== null,
      // `urgent` adalah satu-satunya jalur acknowledgment di luar FIFO.
      // Karena itu classifier ini bagian dari keselamatan dan tidak boleh mati
      // hanya karena batas pemakaian percakapan biasa tercapai.
      usage: this.usage(ownerId, "cheap", "turn-boundary", true),
      messages: [
        { role: "system", content: TURN_BOUNDARY_PROMPT },
        { role: "user", content: turnBoundaryInput(message) },
      ],
    });

    const decision = parseTurnBoundaryDecision(raw);
    if (decision === null) {
      throw new Error("Model tidak mengembalikan keputusan bubble yang sah.");
    }
    return decision;
  }

  /**
   * Menyusun balasan, dengan giliran terakhir sebagai pesan chat sungguhan.
   *
   * Sebelumnya seluruh riwayat diselipkan sebagai kutipan di dalam satu pesan
   * sistem. Model membacanya sebagai catatan tentang percakapan, bukan sebagai
   * percakapan yang sedang berjalan, dan balasannya terdengar seperti membalas
   * surat: mengulang pembuka yang sama dan kehilangan ritme.
   *
   * Memori dan ringkasan tetap dibungkus `<konteks>`. Keduanya memang catatan,
   * dan tidak ada bentuk chat yang wajar untuk mereka.
   */
  /**
   * Menilai risiko sebuah pesan tanpa menjawabnya.
   *
   * Dipanggil hanya setelah RiskHint `possible`/`strong`, ketika compiler gagal,
   * atau langsung pada emergency lokal.
   */
  async triageRisk(
    message: string,
    ownerId?: string,
    context: HarvyContext = EMPTY_CONTEXT,
    signal?: AbortSignal,
  ): Promise<RiskTriage | null> {
    const { context: boundedContext, manifest: contextManifest } =
      compileHarvyContext(
        context,
        undefined,
        TURNS_ONLY_CONTEXT_PROJECTION,
      );
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: TRIAGE_MAX_TOKENS,
      execution: this.execution(
        "cheap",
        "classifier",
        "safety",
        TRIAGE_MAX_TOKENS,
        TRIAGE_TIMEOUT_MS,
      ),
      timeoutMs: TRIAGE_TIMEOUT_MS,
      json: true,
      validateResponse: (content) => parseRiskTriage(content) !== null,
      ...(signal ? { signal } : {}),
      contextManifest,
      usage: this.usage(ownerId, "cheap", "risk-triage", true),
      messages: [
        {
          role: "system",
          content: RISK_TRIAGE_PROMPT,
        },
        {
          role: "user",
          content: riskTriageInput(message, boundedContext.turns),
        },
      ],
    });

    const triage = parseRiskTriage(raw);
    if (!triage) {
      this.logger.warn(
        "risk_triage_parse_failed",
        "Balasan model untuk triase risiko tidak dapat dibaca.",
      );
    }
    return triage;
  }

  /**
   * Compiler ringan untuk ingress grup direct. Risk hint dan izin retensi raw
   * context dibaca independen; kegagalan salah satunya tidak memberi authority
   * kepada field lain.
   */
  async assessGroupIngress(
    message: string,
    context: HarvyContext = EMPTY_CONTEXT,
    ownerId?: string,
    signal?: AbortSignal,
  ): Promise<GroupIngressAssessment | null> {
    const { context: boundedContext, manifest: contextManifest } =
      compileHarvyContext(
        context,
        undefined,
        TURNS_ONLY_CONTEXT_PROJECTION,
      );
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: GROUP_INGRESS_MAX_TOKENS,
      execution: this.execution(
        "cheap",
        "classifier",
        "safety",
        GROUP_INGRESS_MAX_TOKENS,
        GROUP_INGRESS_TIMEOUT_MS,
      ),
      timeoutMs: GROUP_INGRESS_TIMEOUT_MS,
      maxAttempts: 1,
      json: true,
      validateResponse: (content) =>
        parseGroupIngressAssessment(content) !== null,
      ...(signal ? { signal } : {}),
      contextManifest,
      operation: "group-ingress",
      usage: this.usage(ownerId, "cheap", "group-ingress"),
      messages: [
        { role: "system", content: GROUP_INGRESS_PROMPT },
        {
          role: "user",
          content: groupIngressInput(message, boundedContext.turns),
        },
      ],
    });
    const assessment = parseGroupIngressAssessment(raw);
    if (!assessment) {
      this.logger.warn(
        "group_ingress_parse_failed",
        "Balasan model untuk assessment ingress grup tidak dapat dibaca.",
      );
    }
    return assessment;
  }

  /**
   * Menilai sensitivitas hanya ketika compiler sudah membuat kandidat memori.
   * Kegagalan dikembalikan sebagai `null`; adapter memperlakukannya sensitif
   * agar gangguan classifier tidak dapat menyimpan data pribadi diam-diam.
   */
  async assessMemoryPrivacy(
    candidates: readonly ExtractedMemory[],
    ownerId?: string,
    signal?: AbortSignal,
  ): Promise<boolean | null> {
    if (candidates.length === 0) return false;
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: MEMORY_PRIVACY_MAX_TOKENS,
      execution: this.execution(
        "cheap",
        "classifier",
        "safety",
        MEMORY_PRIVACY_MAX_TOKENS,
        MEMORY_PRIVACY_TIMEOUT_MS,
      ),
      timeoutMs: MEMORY_PRIVACY_TIMEOUT_MS,
      json: true,
      validateResponse: (content) => parseMemoryPrivacy(content) !== null,
      ...(signal ? { signal } : {}),
      usage: this.usage(ownerId, "cheap", "memory-privacy"),
      messages: [
        { role: "system", content: MEMORY_PRIVACY_PROMPT },
        { role: "user", content: memoryPrivacyInput(candidates) },
      ],
    });
    const sensitive = parseMemoryPrivacy(raw);
    if (sensitive === null) {
      this.logger.warn(
        "memory_privacy_parse_failed",
        "Balasan model untuk sensitivitas memori tidak dapat dibaca.",
      );
    }
    return sensitive;
  }

  /**
   * Memeriksa rancangan balasan untuk giliran yang berisiko.
   *
   * Mengembalikan `null` ketika pemeriksaannya sendiri gagal. Pemanggilnya
   * memilih apa yang harus dilakukan; menganggapnya aman secara diam-diam akan
   * membuat kegagalan jaringan terlihat seperti lampu hijau.
   */
  async reviewReply(
    message: string,
    reply: string,
    triage: Pick<RiskTriage, "level" | "alone" | "certain"> = {
      level: "dukungan",
      alone: false,
      certain: true,
    },
    ownerId?: string,
    context: HarvyContext = EMPTY_CONTEXT,
    signal?: AbortSignal,
  ): Promise<boolean | null> {
    const { context: boundedContext, manifest: contextManifest } =
      compileHarvyContext(
        context,
        undefined,
        TURNS_ONLY_CONTEXT_PROJECTION,
      );
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: REVIEW_MAX_TOKENS,
      execution: this.execution(
        "cheap",
        "critic",
        "safety",
        REVIEW_MAX_TOKENS,
        REVIEW_TIMEOUT_MS,
      ),
      timeoutMs: REVIEW_TIMEOUT_MS,
      json: true,
      validateResponse: (content) => parseReplyVerdict(content) !== null,
      ...(signal ? { signal } : {}),
      contextManifest,
      usage: this.usage(ownerId, "cheap", "reply-review", true),
      messages: [
        { role: "system", content: REPLY_REVIEW_PROMPT },
        {
          role: "user",
          content: replyReviewInput(
            message,
            reply,
            triage,
            boundedContext.turns,
          ),
        },
      ],
    });

    return parseReplyVerdict(raw);
  }

  /** Menyusun pemahaman tentang penggunanya. Berjalan di latar, bukan inline. */
  async readInsight(
    summary: string | null,
    turns: ConversationTurn[],
    ownerId?: string,
  ): Promise<InsightDraftShape | null> {
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: INSIGHT_MAX_TOKENS,
      execution: this.execution(
        "cheap",
        "extractor",
        "mechanical",
        INSIGHT_MAX_TOKENS,
        GENERAL_MODEL_DEADLINE_MS,
      ),
      json: true,
      validateResponse: (content) => parseInsightDraft(content) !== null,
      usage: this.usage(ownerId, "cheap", "insight"),
      messages: [
        { role: "system", content: INSIGHT_PROMPT },
        { role: "user", content: insightInput(summary, turns) },
      ],
    });

    return parseInsightDraft(raw);
  }

  async reply(
    message: string,
    understanding: Understanding,
    context: HarvyContext = EMPTY_CONTEXT,
    style: StylePreference | null = null,
    triage: RiskTriage = CALM_TRIAGE,
    insight: UserInsight | null = null,
    raiseHelp = false,
    runtime: ConversationRuntime = {},
  ): Promise<string> {
    const modelIdentityQuestion =
      triage.level === "biasa" && isModelIdentityQuestion(message);
    if (modelIdentityQuestion && isPureModelIdentityQuestion(message)) {
      return CAPYBARA_MODEL_REPLY;
    }

    const selected = selectTier({
      intent: understanding.intent,
      messageLength: message.length,
      needsStepByStep: understanding.needsStepByStep,
      risk: triage.level,
    });
    const tier =
      runtime.session?.kind === "tutor" && triage.level === "biasa"
        ? "ambitious"
        : selected;
    const timeZone = runtime.timeZone ?? this.defaultTimeZone;
    const { context: boundedContext, manifest: contextManifest } =
      compileHarvyContext(context);
    const scope = this.runtimeScope(runtime);

    const base = replyPrompt(understanding.intent, {
      context: boundedContext,
      style,
      now: this.now(),
      timeZone,
      insight,
      raiseHelp,
      activeSession: runtime.session ?? null,
      ...(runtime.plannedActionLabels
        ? { plannedActionLabels: runtime.plannedActionLabels }
        : {}),
    });

    // Satu jalur arahan saja. Dulu ada dua: `safetyGuidance` yang lengkap, dan
    // `SAFETY_ADDENDUM` generik yang dipakai ketika triase gagal. Yang generik
    // itu justru menyuruh mengarahkan ke orang tua dan guru tanpa pengaman
    // apa pun — persis perilaku yang sedang diperbaiki, muncul kembali tepat
    // ketika sistemnya paling rapuh. Kegagalan triase kini ditangani dengan
    // menaikkan tingkat, bukan dengan prompt cadangan yang berbeda.
    const system = `${base}\n\n${this.harness.capabilityContext(scope)}${safetyGuidance(triage)}${
      modelIdentityQuestion
        ? `\n\n${CAPYBARA_MIXED_MESSAGE_GUIDANCE}`
        : ""
    }`;

    // Perintah kedalaman ikut di dalam giliran pengguna, bukan sebagai pesan
    // sistem tersendiri. Sebagai aturan di prompt sistem ia kalah oleh panduan
    // intent yang menyuruh membalas singkat; sebagai pesan sistem kedua ia sama
    // sekali tidak berpengaruh, karena penyedia yang hanya mengenal satu
    // `system_instruction` menggabungkan atau membuangnya. Yang pasti terbaca
    // model mana pun adalah giliran terakhir.
    const depth = depthDirective(message);

    const reply = await this.client.complete({
      model: resolveModel(tier, this.routing),
      temperature: 0.7,
      maxTokens: REPLY_MAX_TOKENS,
      execution: this.execution(
        tier,
        tier === "ambitious" ? "synthesizer" : "conversationalist",
        triage.level === "biasa" ? "conversation" : "safety",
        REPLY_MAX_TOKENS,
        GENERAL_MODEL_DEADLINE_MS,
      ),
      contextManifest,
      usage: this.usage(
        runtime.ownerId,
        tier,
        "reply",
        triage.level !== "biasa",
      ),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      messages: [
        { role: "system", content: system },
        ...recentTurnMessages(boundedContext.turns),
        { role: "user", content: depth ? `${depth}\n\n${message}` : message },
      ],
    });
    return modelIdentityQuestion
      ? prependCapybaraIdentity(reply)
      : reply;
  }

  /**
   * Mengekstrak satu episode v2 tanpa membaca atau merangkum ulang episode lama.
   * Metadata provenance dibuat oleh `HistoryService`, bukan oleh model.
   */
  async summarizeEpisode(
    turns: StoredConversationTurn[],
    ownerId?: string,
  ): Promise<EpisodeSummaryDraft> {
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: EPISODE_SUMMARY_MAX_TOKENS,
      execution: this.execution(
        "cheap",
        "extractor",
        "mechanical",
        EPISODE_SUMMARY_MAX_TOKENS,
        GENERAL_MODEL_DEADLINE_MS,
      ),
      json: true,
      validateResponse: (content) =>
        parseEpisodeSummary(content, turns) !== null,
      usage: this.usage(ownerId, "cheap", "summary"),
      messages: [
        { role: "system", content: EPISODE_SUMMARY_PROMPT },
        { role: "user", content: episodeSummaryInput(turns) },
      ],
    });
    const episode = parseEpisodeSummary(raw, turns);
    if (!episode) {
      throw new Error("Model mengembalikan episode percakapan yang tidak sah.");
    }
    return episode;
  }

  /**
   * Agent Runtime v1 untuk giliran biasa yang read-only.
   *
   * Root cheap menangani pekerjaan sederhana dan tool atomik. Root ambitious
   * hanya dipilih kode untuk pekerjaan kompleks dan menjadi satu-satunya yang
   * dapat melihat capability delegasi paralel.
   */
  async agent(
    message: string,
    mode: AgentMode,
    context: HarvyContext = EMPTY_CONTEXT,
    runtime: ConversationRuntime = {},
    checkpoint?: AgentRunCheckpoint,
    answer?: string,
  ): Promise<AgentRunResult> {
    const compiled = compileHarvyContext(context);
    // Transcript provider hanya hidup selama invocation sinkron ini. Checkpoint
    // tetap provider-neutral; resume baru memulai transcript dari state kernel.
    const nativeThread: AgentNativeThread = { messages: [], pending: null };
    const allowed = new Set([
      "task.list_active",
      "task.get",
      "session.status",
      "settings.time.get",
      "calendar.agenda",
      "terminal.run",
      ...(mode === "orchestrate" ? ["agent.delegate.parallel"] : []),
    ]);
    const executors = this.agentExecutors.filter((executor) =>
      allowed.has(executor.capabilityId)
    );
    const result = await this.harness.run({
      scope: this.runtimeScope(runtime),
      request: message,
      executors,
      limits: {
        maxSteps: 6,
        deadlineMs: 45_000,
        resumeWindowMs: 10 * 60 * 1_000,
        maxReplyCharacters: 8_000,
        maxObservationCharacters: 4_000,
      },
      planner: (input, signal) =>
        this.planAgent(
          input,
          compiled.context,
          compiled.manifest,
          mode,
          runtime,
          signal,
          nativeThread,
        ),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      ...(runtime.isCurrent ? { isCurrent: runtime.isCurrent } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(answer ? { answer } : {}),
    });
    return withDelegationDisclosure(result);
  }

  deterministicTimeReply(timeZone = this.defaultTimeZone): string {
    return deterministicTimeReply(this.now(), timeZone);
  }

  private async planAgent(
    input: AgentPlannerInput,
    context: HarvyContext,
    contextManifest: ReturnType<typeof compileHarvyContext>["manifest"],
    mode: AgentMode,
    runtime: ConversationRuntime,
    signal: AbortSignal,
    nativeThread: AgentNativeThread,
  ): Promise<unknown> {
    continueAgentNativeThread(nativeThread, input, mode);
    const required = liveStateRequirement(input.request, {
      now: this.now(),
      timeZone: runtime.timeZone ?? this.defaultTimeZone,
    });
    const observed = required
      ? input.observations.some((observation) =>
          satisfiesLiveStateRequirement(observation, required)
        )
      : false;
    const requiredFailed = required
      ? input.observations.some(
          (observation) =>
            observation.capabilityId === required.capabilityId &&
            observation.status !== "ok",
        )
      : false;
    // Langkah nol adalah satu-satunya tempat delegasi dapat dieksekusi. Dengan
    // mengosongkan konteks di fase ini, root tidak dapat menyalin memori atau
    // riwayat tersimpan ke instruksi worker. Konteks kembali untuk sintesis.
    const plannerContext =
      mode === "orchestrate" && input.step === 0 ? EMPTY_CONTEXT : context;
    let plannerInput: AgentPlannerInput = {
      ...input,
      callableCapabilities: input.callableCapabilities.filter(
        (capability) =>
          !(input.step > 0 && capability.id === "agent.delegate.parallel"),
      ),
    };
    const mustReadLiveState = required !== null && !observed && !requiredFailed;
    const requiredCapability = mustReadLiveState
      ? plannerInput.callableCapabilities.find(
          (capability) => capability.id === required.capabilityId,
        )
      : undefined;
    if (mustReadLiveState && !requiredCapability?.nativeTool) {
      throw new Error("Capability state-live yang diperlukan tidak callable.");
    }
    const forcedToolChoice: ChatToolChoice | undefined = requiredCapability
      ? {
          type: "function",
          function: { name: requiredCapability.nativeTool!.name },
        }
      : undefined;
    const isContextFreeFanout =
      mode === "orchestrate" && input.step === 0 && !mustReadLiveState;
    let planned = await this.requestAgentDecision(
      plannerInput,
      plannerContext,
      isContextFreeFanout
        ? compileHarvyContext(EMPTY_CONTEXT).manifest
        : contextManifest,
      mode,
      runtime,
      signal,
      isContextFreeFanout,
      isContextFreeFanout,
      nativeThread.messages,
      forcedToolChoice,
    );
    let decision = planned.decision;
    // Jawaban/pertanyaan langsung dari fase fanout belum melihat konteks. Ulangi
    // sekali sebagai sintesis kontekstual dengan delegasi dihapus dari authority.
    if (
      isContextFreeFanout &&
      (decision.kind !== "action" ||
        decision.capabilityId !== "agent.delegate.parallel")
    ) {
      plannerInput = {
        ...input,
        callableCapabilities: input.callableCapabilities.filter(
          (capability) => capability.id !== "agent.delegate.parallel",
        ),
      };
      planned = await this.requestAgentDecision(
        plannerInput,
        context,
        contextManifest,
        mode,
        runtime,
        signal,
        false,
        false,
        nativeThread.messages,
      );
      decision = planned.decision;
    }
    if (required) {
      // Named tool_choice menggantikan override post-hoc: raw call dan thought
      // signature yang dieksekusi kini selalu sama dengan transcript provider.
      if (
        mustReadLiveState &&
        (decision.kind !== "action" ||
          decision.capabilityId !== required.capabilityId)
      ) {
        throw new Error("Planner mengabaikan capability state-live wajib.");
      }
      if (
        observed &&
        decision.kind === "final" &&
        required.coverageNote &&
        !decision.reply.includes(required.coverageNote)
      ) {
        return {
          ...decision,
          reply: `${decision.reply}\n\n${required.coverageNote}`,
        };
      }
    }
    if (decision.kind === "action") {
      nativeThread.pending = {
        step: input.step,
        capabilityId: decision.capabilityId,
        assistant: planned.assistant,
      };
    }
    return decision;
  }

  private async requestAgentDecision(
    plannerInput: AgentPlannerInput,
    plannerContext: HarvyContext,
    contextManifest: ReturnType<typeof compileHarvyContext>["manifest"],
    mode: AgentMode,
    runtime: ConversationRuntime,
    signal: AbortSignal,
    contextFree: boolean,
    suppressFirstMessageClaim: boolean,
    nativeMessages: readonly ChatMessage[],
    toolChoice: ChatToolChoice = "required",
  ): Promise<RequestedAgentDecision> {
    const tier: ModelTier = mode === "orchestrate" ? "ambitious" : "cheap";
    // Prompt sistem membawa suara/waktu/gaya. Konteks tersimpan berada sekali:
    // ringkasan/memori sebagai data terbungkus di system prompt, dan
    // recent turns sebagai pesan chat sungguhan sesuai kontrak reply Harvy.
    const persona = replyPrompt(runtime.intent ?? null, {
      context: plannerContext,
      style: contextFree ? null : runtime.style ?? null,
      now: this.now(),
      timeZone: contextFree
        ? this.defaultTimeZone
        : runtime.timeZone ?? this.defaultTimeZone,
      suppressFirstMessageClaim,
    });
    const nativeTools = agentNativeTools(plannerInput.callableCapabilities);
    const assistant = await this.client.completeToolTurn({
      model: resolveModel(tier, this.routing),
      temperature: 0.1,
      maxTokens: AGENT_PLANNER_MAX_TOKENS,
      execution: this.execution(
        tier,
        plannerInput.step > 0 ? "synthesizer" : "planner",
        "agent",
        AGENT_PLANNER_MAX_TOKENS,
        45_000,
        {
          maxSteps: 6,
          allowTools: true,
          allowDelegation: mode === "orchestrate" && plannerInput.step === 0,
        },
      ),
      signal,
      contextManifest,
      tools: nativeTools,
      toolChoice,
      parallelToolCalls: false,
      validateToolCalls: (calls) =>
        parseAgentNativeDecision(
          calls,
          plannerInput.callableCapabilities,
        ) !== null,
      usage: this.usage(runtime.ownerId, tier, "agent"),
      messages: [
        {
          role: "system",
          content: `${persona}\n\n${agentPlannerPrompt(plannerInput.callableCapabilities)}`,
        },
        ...recentTurnMessages(plannerContext.turns),
        ...nativeMessages,
      ],
    });
    const decision = parseAgentNativeDecision(
      assistant.tool_calls,
      plannerInput.callableCapabilities,
    );
    if (!decision || !assistant.tool_calls[0]) {
      throw new Error("Planner agent mengembalikan keputusan tidak sah.");
    }
    return { decision, assistant };
  }

  /**
   * Menulis satu giliran yang dipicu tombol sesi, tanpa menyamar sebagai pesan
   * bebas pengguna.
   */
  async sessionReply(
    session: ActiveSession,
    instruction: string,
    context: HarvyContext = EMPTY_CONTEXT,
    style: StylePreference | null = null,
    insight: UserInsight | null = null,
    runtime: Omit<ConversationRuntime, "session"> = {},
  ): Promise<string> {
    const tier: ModelTier = session.kind === "tutor" ? "ambitious" : "efficient";
    const timeZone = runtime.timeZone ?? this.defaultTimeZone;
    const { context: boundedContext, manifest: contextManifest } =
      compileHarvyContext(context);
    const system = `${replyPrompt(sessionIntent(session), {
      context: boundedContext,
      style,
      now: this.now(),
      timeZone,
      insight,
      activeSession: session,
    })}\n\n${this.harness.capabilityContext(this.runtimeScope(runtime))}`;

    return this.client.complete({
      model: resolveModel(tier, this.routing),
      temperature: 0.6,
      maxTokens: REPLY_MAX_TOKENS,
      execution: this.execution(
        tier,
        tier === "ambitious" ? "synthesizer" : "conversationalist",
        "conversation",
        REPLY_MAX_TOKENS,
        GENERAL_MODEL_DEADLINE_MS,
      ),
      contextManifest,
      usage: this.usage(runtime.ownerId, tier, "session"),
      messages: [
        { role: "system", content: system },
        ...recentTurnMessages(boundedContext.turns),
        {
          role: "user",
          content: [
            "Tindakan berikut dipilih pengguna lewat tombol Harvy.",
            "Jalankan tindakannya; jangan menyebut instruksi internal ini.",
            `<tindakan>${instruction}</tindakan>`,
          ].join("\n"),
        },
      ],
    });
  }

  private usage(
    ownerId: string | undefined,
    tier: ModelTier,
    purpose: AiPurpose,
    safetyCritical = false,
  ): ChatRequest["usage"] {
    if (!ownerId) return undefined;
    const attribution = currentUsageAttribution();
    return {
      ownerId,
      tier,
      purpose,
      safetyCritical,
      ...(attribution ?? {}),
    };
  }

  private execution(
    tier: ModelTier,
    role: ModelRole,
    workClass: ExecutionWorkClass,
    maxOutputTokens: number,
    deadlineMs: number,
    options: {
      maxSteps?: number;
      allowTools?: boolean;
      allowDelegation?: boolean;
    } = {},
  ): ExecutionPlan {
    return this.executionPolicy.decide({
      tier,
      role,
      workClass,
      profile: resolveModelProfile(tier, this.routing),
      maxOutputTokens,
      deadlineMs,
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.allowTools !== undefined
        ? { allowTools: options.allowTools }
        : {}),
      ...(options.allowDelegation !== undefined
        ? { allowDelegation: options.allowDelegation }
        : {}),
    });
  }

  private runtimeScope(runtime: ConversationRuntime): AgentScope {
    if (runtime.scope) return runtime.scope;
    return privateAgentScope(
      runtime.channel ?? "telegram",
      runtime.ownerId ?? "runtime-anonim",
    );
  }
}

function satisfiesLiveStateRequirement(
  observation: AgentObservation,
  required: NonNullable<ReturnType<typeof liveStateRequirement>>,
): boolean {
  if (
    observation.capabilityId !== required.capabilityId ||
    observation.status !== "ok"
  ) {
    return false;
  }
  if (
    required.capabilityId !== "calendar.agenda" &&
    required.capabilityId !== "task.list_active"
  ) return true;
  try {
    const payload: unknown = JSON.parse(observation.summary);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    const record = payload as Record<string, unknown>;
    if (required.capabilityId === "calendar.agenda") {
      const observedDays = record.days;
      const requiredDays = required.input.days;
      const requiredLocalDate = required.input.localDate;
      const observedLocalDate = record.localDate;
      return typeof observedDays === "number" &&
        typeof requiredDays === "number" &&
        observedDays >= requiredDays &&
        (requiredLocalDate === undefined ||
          (typeof requiredLocalDate === "string" &&
            observedLocalDate === requiredLocalDate));
    }
    const observedLimit = record.limit;
    const requiredLimit = required.input.limit;
    return typeof observedLimit === "number" &&
      typeof requiredLimit === "number" &&
      observedLimit >= requiredLimit;
  } catch {
    return false;
  }
}

function withDelegationDisclosure(result: AgentRunResult): AgentRunResult {
  if (result.status !== "completed") return result;
  for (const observation of result.checkpoint.observations) {
    if (observation.capabilityId !== "agent.delegate.parallel") continue;
    try {
      const parsed = JSON.parse(observation.summary) as Record<string, unknown>;
      if (
        parsed.kind !== "agent.delegate.parallel.result" ||
        parsed.partial !== true ||
        typeof parsed.requested !== "number" ||
        typeof parsed.succeeded !== "number"
      ) {
        continue;
      }
      const note = parsed.succeeded === 0
        ? "Catatan: semua sub-agent gagal, jadi hasil di atas tidak memakai keluaran mereka."
        : `Catatan: hanya ${parsed.succeeded} dari ${parsed.requested} sub-agent yang berhasil; hasilnya bersifat parsial.`;
      return {
        ...result,
        reply: `${result.reply.slice(0, 7_600)}\n\n${note}`,
      };
    } catch {
      // Observation adalah data tak tepercaya. JSON rusak tidak boleh mengubah
      // jawaban menjadi klaim keberhasilan parsial yang dibuat-buat.
    }
  }
  return result;
}

function sessionIntent(session: ActiveSession): ConversationIntent {
  switch (session.kind) {
    case "tutor":
      return "question";
    case "human-bridge":
      return "request";
    case "clarify":
      return "feeling";
    case "prioritize":
    case "focus":
    case "plan":
      return "task";
  }
}

function continueAgentNativeThread(
  thread: AgentNativeThread,
  input: AgentPlannerInput,
  mode: AgentMode,
): void {
  if (thread.pending) {
    const pending = thread.pending;
    const observation = input.observations.find(
      (candidate) =>
        candidate.step === pending.step &&
        candidate.capabilityId === pending.capabilityId,
    );
    if (!observation) {
      throw new Error("Hasil native tool belum tersedia untuk continuation.");
    }
    thread.messages.push(
      pending.assistant,
      {
        role: "tool",
        tool_call_id: pending.assistant.tool_calls[0]!.id,
        name: pending.assistant.tool_calls[0]!.function.name,
        content: JSON.stringify({
          capabilityId: observation.capabilityId,
          status: observation.status,
          summary: observation.summary,
        }),
      },
    );
    thread.pending = null;
  }
  if (thread.messages.length === 0) {
    thread.messages.push({
      role: "user",
      content: agentPlannerInput(input, EMPTY_CONTEXT, mode),
    });
  }
}

/**
 * Mengubah giliran tersimpan menjadi pesan chat.
 *
 * Giliran kosong dibuang: sebagian penyedia menolak pesan tanpa isi, dan satu
 * giliran rusak tidak boleh menggagalkan seluruh balasan.
 */
function recentTurnMessages(turns: ConversationTurn[]): ChatMessage[] {
  return turns
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn): ChatMessage => ({
      role: turn.role === "user" ? "user" : "assistant",
      content: turn.text,
    }));
}

export function parseWaitDecision(raw: string): boolean | null {
  const decision = parseTurnBoundaryDecision(raw);
  if (decision === null) return null;
  return decision === "open" || decision === "incomplete";
}

export function parseTurnBoundaryDecision(
  raw: string,
): TurnBoundaryState | null {
  const withoutFence = raw
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(withoutFence.slice(start, end + 1));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const state = record["state"];
    if (
      state === "complete" ||
      state === "open" ||
      state === "incomplete" ||
      state === "urgent"
    ) {
      return state;
    }

    // Kompatibilitas defensif bila model masih mengulang kontrak lama.
    return typeof record["wait"] === "boolean"
      ? record["wait"]
        ? "open"
        : "complete"
      : null;
  } catch {
    return null;
  }
}
