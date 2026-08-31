import { agentStopDeservesExplanation } from "../ai/conversation.js";
import {
  Bot,
  InputFile,
  type Context,
  type InlineKeyboard,
} from "grammy";
import { randomUUID } from "node:crypto";
import { EMPTY_CONTEXT, type HarvyContext } from "../ai/context.js";
import type { Conversation, ConversationRuntime } from "../ai/conversation.js";
import type { OperationPresentationBrief } from
  "../ai/operation-presentation.js";
import {
  groundedMemoryPortraitFallback,
  hasMemoryPortraitEvidence,
  isMemoryPortraitGrounded,
} from "../ai/memory-portrait.js";
import {
  ByokProviderError,
  type ChatImageMediaType,
} from "../ai/client.js";
import {
  currentUsageAttribution,
  withUsageAttribution,
} from "../ai/usage-attribution.js";
import {
  allowsDeterministicSurface,
  requiresPlannedExecution,
  intentAllowsAgentRuntime,
  requestsAgentTooling,
  selectGlobalRoute,
} from "../ai/model-policy.js";
import { agentRunLogFields, liveStateRequirement } from "../ai/agent.js";
import { acknowledgesPrematureReply } from "../core/turn-taking-policy.js";
import {
  canUseDirectTimeFastPath,
  isDirectTimeQuestion,
} from "../agent/time-fast-path.js";
import {
  CAPYBARA_MODEL_REPLY,
  canUseModelIdentityFastPath,
  isModelIdentityQuestion,
  isPureModelIdentityQuestion,
} from "../ai/identity.js";
import type {
  ExtractedMemory,
  ExtractedTask,
  ControlAction,
  Understanding,
} from "../ai/understand.js";
import { imageConversationUnderstanding } from "../ai/understand.js";
import type { AppConfig } from "../config.js";
import type { CodingRun } from "../domain/coding-run.js";
import { renderCodingRunAnchor } from "../coding/coding-run-anchor.js";
import {
  GOAL_COMMAND_HELP,
  parseGoalCommand,
  parseSkillCommand,
  SKILL_COMMAND_HELP,
} from "../coding/project-intent-command.js";
import {
  renderProjectGoal,
  renderProjectSkill,
  renderProjectSkills,
} from "../coding/project-intent-presentation.js";
import type { CodingRuntimeComposition } from "../core/coding-runtime-composition.js";
import type { EconomyService } from "../core/economy-service.js";
import {
  EconomyCommandService,
  economyCredentialSafetyReply,
} from "../core/economy-command-service.js";
import type { UserUsageSummaryService } from "../core/user-usage-summary-service.js";
import {
  parseUsageDashboardCommand,
  renderUsageDashboard,
  USAGE_COMMAND_TARGET_REJECTED,
  USAGE_GROUP_PRIVACY_MESSAGE,
} from "../core/usage-dashboard-renderer.js";
import type { PrivateCodingRunHandle } from "../core/private-coding-application.js";
import type { PrivateGitHubPublishOffer } from "../core/private-github-application.js";
import {
  adaptiveActions,
  prefersGuidedSmallStep,
  requestsUnhandledTaskChange,
  replyHasBlockingQuestion,
} from "../core/action-policy.js";
import { HISTORY_WINDOW } from "../core/history-policy.js";
import type { HistoryService } from "../core/history-service.js";
import type { MemoryContextCompiler } from "../core/memory-context-compiler.js";
import type { InsightService } from "../core/insight-service.js";
import {
  containsForbiddenMemorySecret,
  isSensitiveMemory,
} from "../core/memory-policy.js";
import {
  authorizeAutomaticMemory,
  knowledgeFields,
  deriveMemoryMetadata,
  exactExplicitMemoryCandidate,
  groundedAutomaticMemoryContent,
  inferExplicitResponsePreference,
  memoryCandidateConflictsWithRetractions,
  memoryEvidenceConflictsWithRetractions,
} from "../core/memory-candidate.js";
import {
  explicitMemoryRememberAuthority,
  normalizeMemoryWriteEmoji,
  replyAcknowledgesMemoryWrite,
  replyClaimsMemoryDeletion,
  withoutUnconfirmedMemoryRecordClaims,
  withoutUnconfirmedMemoryDeletionClaims,
  withoutUnconfirmedMemoryWriteClaims,
} from "../core/memory-explicit-consent.js";
import type { MemoryService } from "../core/memory-service.js";
import {
  isExplicitForgetAllMemories,
  memoryRetractionAuthorized,
  memoriesMatchingNaturalTarget,
  naturalMemoryTargetLabel,
} from "../core/memory-natural-control.js";
import { ProfileService, shouldAskStyle } from "../core/profile-service.js";
import type { DataControlService } from "../core/data-control-service.js";
import {
  ActiveAgentRunStaleError,
  AgentRunConflictError,
  type AgentRunService,
} from "../core/agent-run-service.js";
import type { ActiveAgentRun, AgentRunContextSnapshot } from "../domain/agent-run.js";
import {
  classifyRunMailboxLocally,
  mailboxKindForRelation,
} from "../core/run-mailbox-policy.js";
import {
  ActiveRunIngressBarrier,
  type ActiveRunIngressReservation,
} from "../core/active-run-ingress-barrier.js";
import {
  hasExplicitImmediateDangerSignal,
  hasExplicitSupportTriageSignal,
  needsConditionalReplyReview,
  NO_RISK_HINT,
  parseRiskHint,
  safetyEffectPermissions,
  withImmediateDangerHint,
  withExplicitSupportHint,
} from "../core/safety-policy.js";
import {
  ActiveSessionError,
  type SessionService,
} from "../core/session-service.js";
import {
  authorizedSessionSignal,
  sessionAppliesToMessage,
} from "../core/session-policy.js";
import type { TaskService } from "../core/task-service.js";
import { resolveActiveTaskReference } from "../core/task-reference.js";
import {
  UsageLimitError,
  type TelemetryService,
  type TurnTelemetrySignal,
} from "../core/telemetry-service.js";
import {
  INDONESIAN_TIME_ZONES,
  explicitIndonesianTimeZoneChange,
  explicitQuietHoursChange,
  isInQuietHours,
  parseQuietHours,
} from "../core/time-policy.js";
import {
  safeFallbackReply,
  URGENT_ACKNOWLEDGEMENT,
  resolveRiskAssessment,
  withEmergencyAvailability,
  safetyOnlyUnderstanding,
  type RiskAssessment,
  type RiskTriage,
} from "../ai/safety.js";
import type { MemoryItem } from "../domain/memory.js";
import type { StoredConversationTurn } from "../domain/history.js";
import type { QuietHours, StylePreference } from "../domain/profile.js";
import type {
  ActiveSession,
  SessionKind,
  SessionSignal,
} from "../domain/session.js";
import type { StudentTask } from "../domain/task.js";
import {
  semanticConfidenceBucket,
  semanticOperationContextAvailable,
  codingRunStatusOperation,
  naturalSurfaceAuthorized,
  semanticOperationAuthorized,
  semanticOperationForExactCommand,
} from "../domain/semantic-operation.js";
import {
  NumberedOptionStore,
  parseNumberedReply,
} from "../core/numbered-options.js";
import {
  TransientInteractionContextStore,
} from "../core/transient-interaction-context.js";
import {
  bubblePauseMs,
  adaptiveActionLabel,
  adaptiveActionButtons,
  CHECK_IN_MESSAGE,
  checkInOutcomeActions,
  confirmActions,
  dataControlActions,
  deleteAllConfirmActions,
  formatMemoryPortrait,
  formatEconomyUsage,
  formatSession,
  formatTask,
  formatTimeSettings,
  formatUsage,
  helpActions,
  menuActions,
  MEMORY_CHANGE_PROMPT,
  MEMORY_PORTRAIT_EMPTY,
  MEMORY_PORTRAIT_UNAVAILABLE,
  MEMORY_SAVE_UNAVAILABLE,
  MEMORY_SECRET_REJECTION,
  MEMORY_WIPE_PROMPT,
  memoryNoteLines,
  memoryPortraitActions,
  memoryWipeConfirmActions,
  normalizeTelegramText,
  quietHoursActions,
  reminderActions,
  sessionActions,
  splitReplyBubbles,
  taskActions,
  taskListActions,
  timezoneActions,
  understandingNote,
  withMemoryNotes,
  withoutMemoryNote,
  withdrawConsentConfirmActions,
} from "./messages.js";
import {
  renderCommandCategory,
  renderCommandMenu,
  renderHelpMessage,
  type TelegramCommandOptions,
} from "./commands.js";
import { ActionOfferStore } from "./action-offers.js";
import { MessageBatcher } from "./message-batcher.js";
import {
  CONSENT_ACCEPTED,
  CONSENT_ACCEPTED_EMOJI,
  CONSENT_ACCEPTED_HELD,
  consentDetail,
  consentActions,
  HeldMessageStore,
  HOLD_LIMIT_REACHED,
  HOLD_REMINDER,
  introBubbles,
  PRE_CONSENT_SAFETY,
  PRE_CONSENT_UNCERTAIN,
  STYLE_QUESTION,
  styleAck,
  styleActions,
  welcomeBack,
} from "./onboarding.js";
import { PendingStore, type Pending } from "./pending.js";
import {
  deterministicArithmeticReply,
  isNarrowPendingAnswer,
} from "./fast-path-policy.js";
import {
  emptyListNote,
  notUnderstoodNote,
  nothingLeftNote,
  taskCompletedHeading,
  taskDeclinedNote,
  taskDroppedHeading,
  taskListLead,
  taskMissingNote,
  taskSavedHeading,
} from "./phrasing.js";
import {
  renderRunAnchor,
  runCancellationAcknowledgement,
  runMailboxCapacityNotice,
  runUpdateAcknowledgement,
} from "./run-anchor.js";
import {
  immediateUnderstandingRoute,
  taskToOffer,
} from "./understanding-route.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import {
  initialProgressEvent,
  renderProgressMeter,
  interruptionProgressEvent,
  publicFocusProgressEvent,
  TransientConversationProgress,
  type ConversationProgressReporter,
} from "../core/conversation-progress.js";
import {
  agentApprovalStopMessage,
  agentStopMessage,
} from "./agent-stop-copy.js";

/** Jarak bawaan antara pengingat dan tenggat. */
const REMINDER_LEAD_MS = 60 * 60 * 1000;
interface AuthorizedMemoryCandidate {
  memory: ExtractedMemory;
  /** Perintah remember dibuktikan lokal; onboarding mengotorisasi write biasa. */
  explicitRequest: boolean;
}

interface StoredMemoryBatch {
  /** Primary memory yang benar-benar baru ditulis dan perlu rollback bila send gagal. */
  saved: MemoryItem[];
  /** Ada kandidat yang tidak berhasil commit dan tidak boleh diakui sebagai write. */
  uncommitted: boolean;
  /** Primary baru atau duplicate yang diminta eksplisit oleh user turn ini. */
  explicitlyRemembered: MemoryItem[];
  /** Hasil code-owned yang boleh dijelaskan model setelah commit selesai. */
  acknowledgements: Array<{
    item: MemoryItem;
    operation: "saved" | "updated" | "already-known";
    explicit: boolean;
  }>;
}

interface ForgottenMemoryBatch {
  forgotten: MemoryItem[];
  acknowledgements: Array<{
    content: string;
    operation: "forgotten";
    explicit: true;
  }>;
}

const AI_FAILURE_MESSAGE =
  "Maaf, aku lagi nggak bisa mikir sekarang — sambungan ke otakku lagi bermasalah. Coba kirim lagi sebentar lagi, ya.";
function usageLimitMessage(error: UsageLimitError): string {
  if (error.reason === "wallet_disabled") {
    return "Saldo tambah compute tersedia, tetapi penggunaan otomatis belum diizinkan. Kamu bisa mengaktifkannya dari pengaturan funding, memakai provider sendiri, atau menunggu pembaruan kapasitas.";
  }
  if (error.reason === "anti_abuse") {
    return "Batas pemakaian singkat Harvy tercapai. Coba lagi setelah jeda; kapasitas dan pekerjaanmu tetap tersimpan.";
  }
  if (error.reason === "byok_unavailable") {
    return "Provider BYOK-mu belum cocok untuk tingkat pekerjaan ini. Kamu dapat memilih model BYOK yang lebih kuat, menambah provider lain, memakai compute Harvy/PAYG dengan izin, atau menunggu pembaruan kapasitas.";
  }
  return [
    "Penggunaan Harvy-funded untuk periode ini sudah terpakai.",
    "Harvy membutuhkan compute berbayar untuk melanjutkan pekerjaan baru.",
    "Kamu dapat menggunakan paket Harvy, menambah compute, memakai akun API/provider milikmu, atau menunggu penggunaan gratis diperbarui.",
    "Memory, percakapan, dan pekerjaanmu tetap tersimpan.",
  ].join("\n\n");
}
function aiFailureMessage(error: unknown, fallback = AI_FAILURE_MESSAGE): string {
  if (error instanceof UsageLimitError) return usageLimitMessage(error);
  if (error instanceof ByokProviderError) {
    return "Provider BYOK-mu belum dapat menyelesaikan pekerjaan ini. Kamu bisa memilih model BYOK yang lebih kuat, memasang provider lain, atau memakai compute Harvy secara eksplisit. Harvy tidak mengalihkan biaya diam-diam.";
  }
  return fallback;
}
const SESSION_KIND_OF: Partial<Record<string, SessionKind>> = {
  clarify: "clarify",
  prioritize: "prioritize",
  start_small: "focus",
  tutor: "tutor",
  plan: "plan",
  human_bridge: "human-bridge",
};

export type HarvyBot = Bot & {
  drainPending: () => Promise<void>;
  resumeAgentRuns: () => Promise<void>;
  sendCheckIn: (candidate: ActiveSession) => Promise<boolean>;
  sendReminder: (candidate: StudentTask) => Promise<boolean>;
};

interface SentMessageRef {
  chatId: number;
  messageId: number;
}
class PartialReplyDeliveryError extends Error {
  constructor(
    readonly deliveredText: string,
    readonly cause: unknown,
  ) {
    super("Balasan Telegram hanya terkirim sebagian.");
    this.name = "PartialReplyDeliveryError";
  }
}
class ReplyInterruptedError extends Error {
  constructor(readonly deliveredText: string) {
    super("Balasan dihentikan karena giliran percakapan berubah.");
    this.name = "ReplyInterruptedError";
  }
}
export interface TypingContext {
  replyWithChatAction: (action: "typing") => Promise<unknown>;
}

export async function bestEffortTyping(
  ctx: TypingContext,
  logger: OperationalLogger = NOOP_OPERATIONAL_LOGGER,
): Promise<void> {
  try {
    await ctx.replyWithChatAction("typing");
  } catch (error) {
    // Indikator ini kosmetik. Kegagalan Telegram tidak boleh membuang pesan
    // pengguna atau menghentikan giliran percakapan.
    logger.warn(
      "telegram_typing_failed",
      "Indikator mengetik gagal dikirim.",
      { error },
    );
  }
}

export function createBot(
  config: AppConfig,
  tasks: TaskService,
  conversation: Conversation,
  memories: MemoryService,
  history: HistoryService,
  profiles: ProfileService,
  insights: InsightService,
  sessions: SessionService,
  dataControls: DataControlService,
  telemetry: TelemetryService,
  logger: OperationalLogger =
    NOOP_OPERATIONAL_LOGGER.child("telegram.bot"),
  agentRuns: AgentRunService | null = null,
  memoryContextCompiler: MemoryContextCompiler | null = null,
  codingRuntime: Pick<
    CodingRuntimeComposition,
    "application" | "privateGitHub" | "issuePrivateActor"
  > | null = null,
  economy: EconomyService | null = null,
  usageDashboard: Pick<UserUsageSummaryService, "summary"> | null = null,
): HarvyBot {
  const commandOptions: TelegramCommandOptions = Object.freeze({
    codingRuntime: codingRuntime !== null,
    githubPublishing: Boolean(codingRuntime?.privateGitHub),
  });
  const interactionContext = new TransientInteractionContextStore();
  const numberedOptions = new NumberedOptionStore();
  /**
   * Status "Menunggu Harvy" yang dibuat saat pesan tiba, sebelum batching.
   *
   * Harvy menahan giliran beberapa detik untuk memastikan pengguna selesai
   * mengetik, dan selama itu layar dulu sunyi total—status pertama baru muncul
   * sesudah jendela tutup. Pesan yang menggantung karena itu bisa tidak
   * berbalas tanda apa pun sampai dua belas detik.
   *
   * Entrinya diambil giliran yang benar-benar berjalan, atau ditutup oleh
   * `observeTurn` bila gilirannya batal.
   */
  const waitingProgress = new Map<
    string,
    TransientConversationProgress<SentMessageRef>
  >();
  const interactionScope = (ownerId: string) => ({
    ownerId,
    channel: "telegram" as const,
    conversationId: ownerId,
  });
  const economyCommands = economy
    ? new EconomyCommandService(economy, usageDashboard)
    : null;
  const replyUsageDashboard = async (
    ctx: Context,
    ownerId: string,
  ): Promise<void> => {
    if (usageDashboard) {
      const rendered = renderUsageDashboard(
        await usageDashboard.summary(ownerId),
        "telegram",
      );
      await ctx.reply(rendered.text, { parse_mode: "HTML" });
      interactionContext.record(interactionScope(ownerId), {
        domain: "usage",
        operation: "show-summary",
      });
      return;
    }
    await ctx.reply(
      economy
        ? formatEconomyUsage(await economy.usage(ownerId))
        : formatUsage(await telemetry.summary(ownerId)),
    );
    interactionContext.record(interactionScope(ownerId), {
      domain: "usage",
      operation: "show-summary",
    });
  };
  const currentTurnId = (): string | null =>
    currentUsageAttribution()?.turnId ?? null;
  const presentPrivateOperation = async (
    ownerId: string,
    brief: OperationPresentationBrief,
    options: {
      context?: HarvyContext;
      style?: StylePreference | null;
      timeZone?: string;
      runtime?: ConversationRuntime;
    } = {},
  ): Promise<string> => {
    const present = (conversation as Partial<
      Pick<Conversation, "presentOperation">
    >).presentOperation;
    if (typeof present !== "function") return brief.fallbackText;
    try {
      if (await profiles.needsOnboarding(ownerId)) return brief.fallbackText;
      const profile = await profiles.load(ownerId);
      const context = options.context ?? EMPTY_CONTEXT;
      return await present.call(
        conversation,
        brief,
        context,
        options.style === undefined
          ? profile.stylePreference
          : options.style,
        {
          ...options.runtime,
          ownerId,
          channel: "telegram",
          timeZone: options.timeZone ?? profile.timeZone ??
            config.defaultTimezone,
        },
      );
    } catch (error) {
      logger.warn(
        "telegram_private_operation_presentation_failed",
        "Presentasi operasi privat Telegram gagal; fallback dipakai.",
        {
          kind: brief.kind,
          errorType: error instanceof Error ? error.name : "unknown",
        },
      );
      return brief.fallbackText;
    }
  };
  const scheduledCheckInText = async (
    session: ActiveSession,
  ): Promise<string> => {
    const present = (conversation as Partial<
      Pick<Conversation, "presentScheduledCheckIn">
    >).presentScheduledCheckIn;
    if (typeof present !== "function") return CHECK_IN_MESSAGE;
    try {
      const profile = await profiles.load(session.ownerId);
      return await present.call(
        conversation,
        session,
        profile.stylePreference,
        {
          ownerId: session.ownerId,
          channel: "telegram",
          timeZone: profile.timeZone ?? config.defaultTimezone,
        },
      ) ?? CHECK_IN_MESSAGE;
    } catch (error) {
      logger.warn(
        "telegram_private_checkin_presentation_failed",
        "Pertanyaan check-in Telegram gagal dipersonalisasi; fallback dipakai.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
      return CHECK_IN_MESSAGE;
    }
  };
  const markDeliveredForOwner = async (
    ownerId: string,
    turnId: string | null,
    ctx?: Context,
  ): Promise<void> => {
    const notice = await telemetry.markDelivered?.(ownerId, turnId);
    if (!ctx) return;
    if (notice) {
      try {
        await ctx.reply(notice.message);
      } catch (error) {
        logger.warn(
          "usage_notice_delivery_failed",
          "Pemberitahuan kapasitas tidak terkirim; tidak mengubah settlement.",
          { error },
        );
      }
      return;
    }
  };
  const noteTurnSignal = async (
    ownerId: string,
    signal: TurnTelemetrySignal,
    turnId: string | null = currentTurnId(),
  ): Promise<void> => {
    try {
      await telemetry.noteTurnSignal(ownerId, turnId, signal);
    } catch (error) {
      logger.warn(
        "turn_telemetry_signal_failed",
        "Sinyal metrik giliran gagal dicatat.",
        { error },
      );
    }
  };
  const noteTurnResponse = async (
    ownerId: string,
    turnId: string | null = currentTurnId(),
  ): Promise<void> => {
    const observer = telemetry as TelemetryService & {
      noteTurnResponse?: (ownerId: string, turnId: string | null) => Promise<void>;
    };
    if (!observer.noteTurnResponse) return;
    try {
      await observer.noteTurnResponse(ownerId, turnId);
    } catch (error) {
      logger.warn(
        "turn_response_telemetry_failed",
        "Timestamp response giliran gagal dicatat.",
        { error },
      );
    }
  };
  const dropKeyboard = (ctx: Context): Promise<void> =>
    dropKeyboardSafely(ctx, logger);
  const safeEdit = (
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> => safeEditSafely(ctx, text, keyboard, logger);
  const activeProgress = new Map<string, ConversationProgressReporter>();
  /**
   * Identitas giliran yang sedang berjalan per pengguna.
   *
   * Baris biaya pada status perlu tahu giliran mana yang sedang dihitung, dan
   * ia dipanggil dari timer denyut bulan—di luar konteks asinkron giliran.
   * Diukur langsung: `currentUsageAttribution()` di dalam timer mengembalikan
   * null, sehingga tokennya selalu terbaca nol dan tidak akan pernah muncul.
   *
   * Peta ini menangkapnya sekali saat giliran mulai, bukan membacanya ulang
   * tiap denyut.
   */
  const activeTurnId = new Map<string, string>();
  const bot = new Bot(config.telegramBotToken);
  bot.use(async (ctx, next) => {
    const originalReply = ctx.reply.bind(ctx);
    ctx.reply = (async (...args: Parameters<Context["reply"]>) => {
      // Kirim dulu, hapus status sesudahnya.
      //
      // Urutan sebaliknya membuat layar melompat: penghapusan dan pengiriman
      // adalah dua panggilan jaringan terpisah, sehingga ada jeda beberapa
      // ratus milidetik ketika statusnya sudah hilang dan jawabannya belum
      // datang. Dengan urutan ini pengguna melihat jawabannya muncul selagi
      // status masih ada, lalu status lenyap.
      //
      // Bila pengiriman gagal, statusnya tertinggal sebentar dan ditutup jalur
      // pembersih giliran—lebih baik daripada layar kosong.
      const progress = activeProgress.get(ownerOf(ctx));
      const sent = await originalReply(...args);
      await progress?.responding?.();
      const turnId = currentUsageAttribution()?.turnId ?? null;
      if (turnId) await noteTurnResponse(ownerOf(ctx), turnId);
      return sent;
    }) as Context["reply"];
    await next();
  });
  const pending = new PendingStore();
  const held = new HeldMessageStore();
  const actionOffers = new ActionOfferStore();
  let latestTelegramUpdateId = -1;
  const activeAgentWork = new Map<
    string,
    { runId: string; controller: AbortController; promise: Promise<void> }
  >();
  const activeRunIngress = new ActiveRunIngressBarrier();
  const activeCodingWork = new Set<Promise<void>>();
  const codingAnchors = new Map<
    string,
    { runId: string; chatId: number; messageId: number }
  >();
  const codingAnchorUpdates = new Map<
    string,
    {
      chatId: number;
      messageId: number;
      lastText: string;
      pendingText: string | null;
      timer: ReturnType<typeof setTimeout> | null;
      sending: boolean;
    }
  >();
  let stoppingActiveAgentWork = false;

  async function restoreAgentPending(ownerId: string): Promise<Pending | null> {
    const cached = pending.peek(ownerId);
    if (cached || !agentRuns) return cached;
    const run = await agentRuns.loadWaitingInput("telegram", ownerId);
    if (!run) return null;
    const restored: Extract<Pending, { kind: "agent-input" }> = {
      kind: "agent-input",
      request: run.request,
      mode: run.mode,
      intent: run.intent,
      checkpoint: run.checkpoint,
      revision: run.revision,
      acceptAnswersAfterUpdateId: run.acceptAnswersAfterUpdateId,
    };
    return pending.restore(
        ownerId,
        restored,
        Date.parse(run.expiresAt),
      ) === null
      ? null
      : restored;
  }

  async function saveAgentPending(
    ownerId: string,
    value: Extract<Pending, { kind: "agent-input" }>,
  ): Promise<void> {
    const boundedValue = {
      ...value,
      acceptAnswersAfterUpdateId: latestTelegramUpdateId,
    };
    if (!agentRuns) {
      pending.set(ownerId, boundedValue);
      return;
    }
    const run = await agentRuns.saveWaitingInput({
      channel: "telegram",
      ownerId,
      request: boundedValue.request,
      mode: boundedValue.mode,
      intent: boundedValue.intent,
      acceptAnswersAfterUpdateId: boundedValue.acceptAnswersAfterUpdateId,
      checkpoint: boundedValue.checkpoint,
      expectedRevision: boundedValue.revision,
    });
    pending.restore(
      ownerId,
      { ...boundedValue, revision: run.revision },
      Date.parse(run.expiresAt),
    );
  }

  async function clearPending(
    ownerId: string,
    expectedRunId?: string,
    expectedRevision?: number,
  ): Promise<void> {
    pending.clear(ownerId);
    if (agentRuns) {
      await agentRuns.clear(
        "telegram",
        ownerId,
        expectedRunId,
        expectedRevision,
      );
    }
  }

  /**
   * Telegram delivery dan commit file belum satu transaksi. Jika commit sesudah
   * delivery gagal, checkpoint lama harus dibuang secara best effort agar
   * jawaban berikutnya tidak terikat ke pertanyaan yang sudah berubah.
   */
  async function abandonAgentRunAfterDelivery(
    ctx: Context,
    ownerId: string,
    _runId: string,
    persistenceError: unknown,
  ): Promise<string | null> {
    pending.clear(ownerId);
    logger.error(
      "agent_checkpoint_commit_failed",
      "Balasan agent terkirim tetapi checkpoint berikutnya gagal di-commit.",
      persistenceError,
    );

    let cleanupConfirmed = true;
    if (agentRuns) {
      try {
        // `forget` memblokir scope sebelum I/O. Bila cleanup gagal, block tetap
        // aktif sehingga record lama tidak dipulihkan lagi di proses ini.
        await agentRuns.forget("telegram", ownerId);
        agentRuns.allow("telegram", ownerId);
      } catch (cleanupError) {
        cleanupConfirmed = false;
        logger.error(
          "agent_checkpoint_cleanup_failed",
          "Checkpoint agent lama belum dapat dipastikan terhapus.",
          cleanupError,
        );
      }
    }

    const warning = cleanupConfirmed
      ? "Balasanku tadi sudah terkirim, tapi progress run-nya gagal kusimpan dengan aman. Checkpoint itu kubatalkan; kirim ulang permintaan awal kalau kamu ingin lanjut."
      : "Balasanku tadi sudah terkirim, tapi progress run-nya gagal kusimpan dan checkpoint lama belum dapat kupastikan terhapus. Jangan jawab prompt lama itu; kirim ulang permintaan awal setelah layanan pulih.";
    try {
      await ctx.reply(warning);
      return warning;
    } catch (warningError) {
      logger.error(
        "agent_checkpoint_warning_failed",
        "Peringatan kegagalan checkpoint agent tidak terkirim.",
        warningError,
      );
      return null;
    }
  }

  async function setPending(ownerId: string, value: Pending): Promise<string> {
    const protectsDataRight =
      value.kind === "confirm-consent-withdrawal" ||
      value.kind === "confirm-full-deletion";
    if (protectsDataRight) {
      pending.clear(ownerId);
      try {
        await agentRuns?.clear("telegram", ownerId);
      } catch (error) {
        // Menampilkan tombol hak pengguna tidak boleh bergantung pada file run.
        // Eksekusi YES memasang block/tombstone melalui jalurnya sendiri.
        logger.error(
          "data_right_agent_run_preclear_failed",
          "Checkpoint agent belum dapat dibersihkan sebelum konfirmasi hak data.",
          error,
        );
      }
    } else {
      await clearPending(ownerId);
    }
    return pending.set(ownerId, value);
  }

  function pendingAnswerIsEligible(
    firstIngressUpdateId: number,
    value: Pending,
  ): boolean {
    return value.kind !== "agent-input" ||
      firstIngressUpdateId > value.acceptAnswersAfterUpdateId;
  }

  const messageBatcher = new MessageBatcher<Context>(
    async (text, ownerId, turnId, signals) => {
      if (ownerId && turnId) await telemetry.beginTurn(ownerId, turnId);
      return withUsageAttribution(
        {
          turnId: turnId ?? null,
          subjectKind: "private",
          channel: "telegram",
          actorAliases: [],
        },
        async () => {
          // Evaluasi boundary berjalan di luar chain pemilik. Ia hanya boleh
          // membaca durable state; memulihkan PendingStore di sini dapat
          // menghidupkan kembali run yang baru dibatalkan command.
          if (
            ownerId &&
            (pending.peek(ownerId) ||
              (agentRuns &&
                await agentRuns.loadWaitingInput("telegram", ownerId)))
          ) {
            return "complete";
          }
          if (
            isDirectTimeQuestion(text) ||
            isPureModelIdentityQuestion(text)
          ) {
            return "complete";
          }
          const recent = ownerId ? await history.context(ownerId) : undefined;
          return typeof conversation.assessTurnBoundary === "function"
            ? conversation.assessTurnBoundary(
                text,
                ownerId,
                recent ? { turns: recent.turns } : undefined,
                signals,
              )
            : conversation.classifyTurnBoundary(text, ownerId);
        },
      );
    },
    async (ownerId, batch) => {
      await telemetry.beginTurn(ownerId, batch.turnId);
      return withUsageAttribution(
        {
          turnId: batch.turnId,
          subjectKind: "private",
          channel: "telegram",
          actorAliases: [],
        },
        () => handleFreeText(
          batch.carrier,
          ownerId,
          batch.text,
          {
            signal: batch.signal,
            isCurrent: batch.isCurrent,
            awaitCurrent: batch.awaitCurrent,
            markUserCommitted: batch.markUserCommitted,
            interruptionRelation: batch.interruptionRelation,
            turnReceivedAt: batch.firstReceivedAt,
            ...(((waiting) => (waiting ? { progress: waiting } : {}))(
              takeWaitingProgress(ownerId),
            )),
          },
          batch.firstIngressSequence ?? batch.carrier.update.update_id,
          batch.explicitImmediateDanger,
          batch.urgentBoundary,
        ),
      );
    },
    undefined,
    undefined,
    undefined,
    undefined,
    logger.child("telegram.message-batcher"),
    (metrics) => {
      // Giliran yang batal tidak pernah mengambil status menunggunya, jadi ia
      // harus ditutup di sini—kalau tidak, bulannya berputar selamanya di
      // layar pengguna.
      const orphan = waitingProgress.get(metrics.ownerId);
      if (orphan) {
        waitingProgress.delete(metrics.ownerId);
        void orphan.finish();
      }
      return telemetry.recordTurn({
        ...metrics,
        subjectKind: "private",
        channel: "telegram",
      });
    },
    undefined,
    typeof conversation.classifyTurnInterruption === "function"
      ? async (activeText, incomingText, ownerId, turnId) => {
          await telemetry.beginTurn(ownerId, turnId);
          return withUsageAttribution(
            {
              turnId,
              subjectKind: "private",
              channel: "telegram",
              actorAliases: [],
            },
            () => conversation.classifyTurnInterruption(
              activeText,
              incomingText,
              ownerId,
            ),
          );
        }
      : undefined,
  ).onUrgent(async (_ownerId, batch) => {
    // Observer dimulai lebih dulu agar lifecycle-nya terurut sebelum
    // `recordTurn`, tetapi tidak ditunggu: telemetry tidak boleh menahan ACK.
    void noteTurnSignal(
      _ownerId,
      "urgent-acknowledgement",
      batch.turnId,
    );
    await batch.carrier.reply(URGENT_ACKNOWLEDGEMENT);
    await noteTurnResponse(_ownerId, batch.turnId);
  });

  /**
   * Status persetujuan yang sudah dibaca, satu promise per pengguna.
   *
   * Bubble yang datang beruntun memakai promise yang sama, sehingga berkasnya
   * dibaca sekali dan urutan `then` mengikuti urutan pesannya. Tanpa itu, dua
   * bubble pertama setelah proses restart dapat masuk ke batcher terbalik.
   */
  const consentChecks = new Map<string, Promise<boolean>>();
  const onboardingChains = new Map<string, Promise<void>>();
  const ingressTasks = new Set<Promise<void>>();

  bot.use(async (ctx, next) => {
    latestTelegramUpdateId = Math.max(
      latestTelegramUpdateId,
      ctx.update.update_id,
    );
    const context = logger.newTraceContext("telegram", "update");
    await logger.runWithContext(context, async () => {
      const startedAt = Date.now();
      let succeeded = false;
      logger.debug(
        "telegram_update_received",
        "Update Telegram diterima.",
        { updateKind: telegramUpdateKind(ctx) },
      );
      try {
        await next();
        succeeded = true;
      } finally {
        logger.debug(
          "telegram_update_dispatched",
          "Dispatch update Telegram selesai.",
          {
            updateKind: telegramUpdateKind(ctx),
            succeeded,
            durationMs: Date.now() - startedAt,
          },
        );
      }
    });
  });

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === "private") {
      await next();
      return;
    }

    const usageCommand = parseUsageDashboardCommand(ctx.message?.text ?? "");
    if (usageCommand !== null) {
      await ctx.reply(USAGE_GROUP_PRIVACY_MESSAGE);
      return;
    }
    if (ctx.message?.text?.startsWith("/")) {
      await ctx.reply(
        "Harvy versi ini khusus chat pribadi. Kirim pesan langsung ke akun bot, ya.",
      );
    }
  });

  bot.command("start", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "cancel",
      "Perintah /start gagal:",
      async () => {
        await clearPending(ownerId);

        // `/start` hanyalah salah satu pintu masuk perkenalan, bukan syaratnya.
        // Yang belum pernah menyetujui apa pun tetap berkenalan dulu di sini.
        if (await profiles.needsOnboarding(ownerId)) {
          await enqueueOnboarding(ctx, ownerId, "", true);
          return;
        }

        // Pengguna lama tidak mengulang perkenalan. Sapaannya memakai keadaan
        // yang benar-benar ada di datanya, bukan ingatan yang dikarang.
        const active = await tasks.listActive(ownerId);
        await ctx.reply(welcomeBack(active.length));
      },
    );
  });

  bot.command("bantuan", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "cancel",
      "Perintah /bantuan gagal:",
      async () => {
        if (await profiles.needsOnboarding(ownerId)) {
          await enqueueOnboarding(ctx, ownerId, "", true);
          return;
        }
        await clearPending(ownerId);
        actionOffers.clear(ownerId);
        await ctx.reply(renderHelpMessage(commandOptions, "telegram"), {
          reply_markup: helpActions(),
        });
        interactionContext.record(interactionScope(ownerId), {
          domain: "menu",
          operation: "show-help",
        });
      },
    );
  });

  bot.command("menu", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "cancel",
      "Perintah /menu gagal:",
      async () => {
        if (await profiles.needsOnboarding(ownerId)) {
          await enqueueOnboarding(ctx, ownerId, "", true);
          return;
        }
        await clearPending(ownerId);
        actionOffers.clear(ownerId);
        await ctx.reply(renderCommandMenu(commandOptions, "telegram"), {
          reply_markup: menuActions(commandOptions),
        });
        interactionContext.record(interactionScope(ownerId), {
          domain: "menu",
          operation: "show",
        });
      },
    );
  });

  bot.command("memori", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "cancel",
      "Perintah /memori gagal:",
      async () => {
        await clearPending(ownerId);
        actionOffers.clear(ownerId);
        await showMemories(ctx, ownerId);
      },
    );
  });

  const handleUsageDashboardCommand = (ctx: Context): void => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "cancel",
      "Perintah /penggunaan gagal:",
      async () => {
        await clearPending(ownerId);
        const match = parseUsageDashboardCommand(ctx.message?.text ?? "");
        if (match === "invalid") {
          await ctx.reply(USAGE_COMMAND_TARGET_REJECTED);
          return;
        }
        await replyUsageDashboard(ctx, ownerId);
      },
    );
  };
  bot.command("penggunaan", handleUsageDashboardCommand);
  bot.command("usage", handleUsageDashboardCommand);

  bot.command("dukung", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "cancel",
      "Perintah /dukung gagal:",
      async () => {
        await clearPending(ownerId);
        const reply = economy
          ? await economyCommands!.handle(
              ownerId,
              {
                rawText: ctx.message?.text ?? "/dukung",
                semanticOperation: semanticOperationForExactCommand(
                  "billing",
                  "show-support",
                  "/dukung",
                ),
              },
              currentTurnId() ?? `telegram:${ctx.update.update_id}`,
            )
          : "Harvy bisa digunakan gratis. Kontribusi sukarela belum tersedia pada instalasi ini.";
        await ctx.reply(reply ?? "Kontribusi sukarela tetap opsional dan tidak memengaruhi kualitas Harvy.");
        interactionContext.record(interactionScope(ownerId), {
          domain: "billing",
          operation: "show-support",
        });
      },
    );
  });

  bot.command("tugas", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "drain",
      "Perintah /tugas gagal:",
      async () => {
        await clearPending(ownerId);
        await sendTaskList(ctx, ownerId);
      },
    );
  });

  bot.command("project", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "drain",
      "Perintah /project gagal:",
      async () => {
        if (!codingRuntime) {
          await ctx.reply("Runtime coding belum diaktifkan oleh deployment Harvy.");
          return;
        }
        if (!await codingConsent(ctx, ownerId)) return;
        const actor = privateCodingActor(ctx, codingRuntime);
        const command = commandTail(ctx.message?.text ?? "", "project");
        if (/^init\s+/iu.test(command)) {
          const selected = await codingRuntime.application.createBlankProject(
            actor,
            command.replace(/^init\s+/iu, ""),
          );
          await ctx.reply([
            "Project kosong dibuat dan dipilih.",
            `Workspace: ${selected.workspaceKey}`,
            `Project: ${selected.projectId}`,
            "Tetapkan tujuan dengan /goal sebelum mulai coding.",
          ].join("\n"));
          return;
        }
        if (/^new\s+/iu.test(command)) {
          const selected = await codingRuntime.application.createWorkspace(
            actor,
            command.replace(/^new\s+/iu, ""),
          );
          await ctx.reply(`Workspace dibuat dan dipilih:\n${selected.workspaceKey}`);
          return;
        }
        if (command === "list") {
          const workspaces = await codingRuntime.application.listWorkspaces(actor);
          await ctx.reply(
            workspaces.length === 0
              ? "Belum ada workspace. Buat dengan /project new <nama>."
              : ["Workspace:", ...workspaces.map((workspace) =>
                  `• ${workspace.displayName} — ${workspace.workspaceKey} (${workspace.role})`
                )].join("\n"),
          );
          return;
        }
        if (/^use\s+/iu.test(command)) {
          const selected = await codingRuntime.application.selectWorkspace(
            actor,
            command.replace(/^use\s+/iu, "").trim(),
          );
          await ctx.reply(`Workspace aktif: ${selected.workspaceKey}`);
          return;
        }
        if (command === "projects") {
          const projects = await codingRuntime.application.listProjects(actor);
          await ctx.reply(
            projects.length === 0
              ? "Workspace ini belum punya project. Upload file ZIP untuk membuatnya."
              : ["Project:", ...projects.map((project) =>
                  `• ${project.projectId} — ${project.source}, revision ${project.revision}`
                )].join("\n"),
          );
          return;
        }
        if (/^use-project\s+/iu.test(command)) {
          const selected = await codingRuntime.application.selectProject(
            actor,
            command.replace(/^use-project\s+/iu, "").trim(),
          );
          await ctx.reply(
            `Project aktif: ${selected.projectId} (revision ${selected.projectRevision})`,
          );
          return;
        }
        if (/^group-confirm\s+/iu.test(command)) {
          const confirmed = await codingRuntime.application.confirmGroupWorkspaceLink(
            actor,
            command.replace(/^group-confirm\s+/iu, "").trim(),
          );
          await ctx.reply(
            confirmed.status === "approved"
              ? "Link grup disetujui. Kembali ke grup dan ulangi @Harvy hubungkan workspace."
              : "Link grup sudah disetujui untuk Workspace aktif.",
          );
          return;
        }
        await ctx.reply([
          "Kelola project coding:",
          "/project init <nama>",
          "/project new <nama>",
          "/project list",
          "/project use <workspaceKey>",
          "/project projects",
          "/project use-project <projectId>",
          "/project group-confirm <kode dari grup>",
          "Atau kirim sebuah file ZIP.",
        ].join("\n"));
      },
    );
  });

  bot.command("goal", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(ctx, ownerId, "drain", "Perintah /goal gagal:", async () => {
      if (!codingRuntime) {
        await ctx.reply("Runtime coding belum diaktifkan oleh deployment Harvy.");
        return;
      }
      if (!await codingConsent(ctx, ownerId)) return;
      const actor = privateCodingActor(ctx, codingRuntime);
      const command = parseGoalCommand(commandTail(ctx.message?.text ?? "", "goal"));
      if (command.kind === "show") {
        await ctx.reply(renderProjectGoal(await codingRuntime.application.currentGoal(actor)));
        return;
      }
      if (command.kind === "set") {
        await ctx.reply(renderProjectGoal(await codingRuntime.application.setGoal(actor, command.input)));
        return;
      }
      if (command.kind === "complete") {
        await ctx.reply(renderProjectGoal(await codingRuntime.application.completeGoal(actor)));
        return;
      }
      if (command.kind === "block") {
        await ctx.reply(renderProjectGoal(await codingRuntime.application.addGoalBlocker(actor, command.summary)));
        return;
      }
      if (command.kind === "resolve") {
        await ctx.reply(renderProjectGoal(await codingRuntime.application.resolveGoalBlocker(actor, command.blockerId)));
        return;
      }
      if (command.kind === "confirm") {
        await ctx.reply(renderProjectGoal(await codingRuntime.application.confirmManualGoalCriterion(
          actor,
          command.criterionId,
          command.summary,
        )));
        return;
      }
      await ctx.reply(GOAL_COMMAND_HELP);
    });
  });

  bot.command("skill", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(ctx, ownerId, "drain", "Perintah /skill gagal:", async () => {
      if (!codingRuntime) {
        await ctx.reply("Runtime coding belum diaktifkan oleh deployment Harvy.");
        return;
      }
      if (!await codingConsent(ctx, ownerId)) return;
      const actor = privateCodingActor(ctx, codingRuntime);
      const command = parseSkillCommand(commandTail(ctx.message?.text ?? "", "skill"));
      if (command.kind === "list") {
        await ctx.reply(renderProjectSkills(await codingRuntime.application.listSkills(actor)));
        return;
      }
      if (command.kind === "create") {
        await ctx.reply(renderProjectSkill(await codingRuntime.application.createSkill(actor, command.input)));
        return;
      }
      if (command.kind === "apply") {
        let anchorMessageId: number | null = null;
        let pendingRun: CodingRun | null = null;
        const handle = await codingRuntime.application.startCodingWithSkill(
          actor,
          command.nameOrId,
          command.request,
          async (run) => {
            pendingRun = run;
            if (anchorMessageId !== null) scheduleCodingAnchor(run, ctx.chat.id, anchorMessageId);
          },
        );
        const sent = await ctx.reply(handle.initialAnchor.text);
        anchorMessageId = sent.message_id;
        codingAnchors.set(ownerId, {
          runId: handle.runId,
          chatId: ctx.chat.id,
          messageId: sent.message_id,
        });
        if (pendingRun) scheduleCodingAnchor(pendingRun, ctx.chat.id, sent.message_id);
        trackCodingCompletion(ctx, ownerId, handle, sent.message_id);
        return;
      }
      await ctx.reply(SKILL_COMMAND_HELP);
    });
  });

  bot.command("code", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(
      ctx,
      ownerId,
      "drain",
      "Perintah /code gagal:",
      async () => {
        if (!codingRuntime) {
          await ctx.reply("Runtime coding belum diaktifkan oleh deployment Harvy.");
          return;
        }
        if (!await codingConsent(ctx, ownerId)) return;
        const request = commandTail(ctx.message?.text ?? "", "code");
        if (!request) {
          await ctx.reply("Tulis task setelah /code, misalnya: /code perbaiki token expired.");
          return;
        }
        const actor = privateCodingActor(ctx, codingRuntime);
        let anchorMessageId: number | null = null;
        let pendingRun: CodingRun | null = null;
        const handle = await codingRuntime.application.startCoding(
          actor,
          request,
          async (run) => {
            pendingRun = run;
            if (anchorMessageId !== null) {
              scheduleCodingAnchor(run, ctx.chat.id, anchorMessageId);
            }
          },
        );
        const sent = await ctx.reply(handle.initialAnchor.text);
        anchorMessageId = sent.message_id;
        codingAnchors.set(ownerId, {
          runId: handle.runId,
          chatId: ctx.chat.id,
          messageId: sent.message_id,
        });
        if (pendingRun) scheduleCodingAnchor(pendingRun, ctx.chat.id, sent.message_id);
        trackCodingCompletion(ctx, ownerId, handle, sent.message_id);
      },
    );
  });

  bot.command("code_status", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(ctx, ownerId, "drain", "Status coding gagal:", async () => {
      if (!codingRuntime) {
        await ctx.reply("Runtime coding belum diaktifkan.");
        return;
      }
      const actor = privateCodingActor(ctx, codingRuntime);
      const current = await codingRuntime.application.current(actor);
      if (!current.run) {
        await ctx.reply("Tidak ada CodingRun foreground aktif.");
        return;
      }
      const sent = await ctx.reply(renderCodingRunAnchor(current.run).text);
      codingAnchors.set(ownerId, {
        runId: current.run.runId,
        chatId: ctx.chat.id,
        messageId: sent.message_id,
      });
    });
  });

  bot.command("code_cancel", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(ctx, ownerId, "drain", "Pembatalan coding gagal:", async () => {
      if (!codingRuntime) {
        await ctx.reply("Runtime coding belum diaktifkan.");
        return;
      }
      const run = await codingRuntime.application.cancel(
        privateCodingActor(ctx, codingRuntime),
      );
      const anchor = codingAnchors.get(ownerId);
      if (anchor?.runId === run.runId) {
        await flushCodingAnchor(run, anchor.chatId, anchor.messageId);
        codingAnchors.delete(ownerId);
      } else {
        await ctx.reply(renderCodingRunAnchor(run).text);
      }
    });
  });

  bot.command("github", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(ctx, ownerId, "drain", "Perintah /github gagal:", async () => {
      if (!codingRuntime?.privateGitHub) {
        await ctx.reply("GitHub App Broker belum diaktifkan oleh deployment Harvy.");
        return;
      }
      if (!await codingConsent(ctx, ownerId)) return;
      const actor = privateCodingActor(ctx, codingRuntime);
      const command = commandTail(ctx.message?.text ?? "", "github");
      if (command === "connect") {
        const started = await codingRuntime.privateGitHub.beginInstallation(actor);
        await ctx.reply([
          "Buka URL GitHub App berikut di browser. Jangan paste PAT atau token ke chat.",
          started.authorizationUrl ?? "Session installation sudah dibuat; cek statusnya.",
          `Connection: ${started.connection.connectionId}`,
          "Setelah installation selesai: /github status <connectionId>",
        ].join("\n\n"));
        return;
      }
      if (/^status\s+/iu.test(command)) {
        const connectionId = command.replace(/^status\s+/iu, "").trim();
        const connection = await codingRuntime.privateGitHub.installationStatus(
          actor,
          connectionId,
        );
        await ctx.reply([
          `Connection: ${connection.connectionId}`,
          `Status: ${connection.status}`,
          `Installation: ${connection.installationId ?? "belum tersedia"}`,
          connection.status === "active"
            ? `Lanjut: /github repos ${connection.connectionId}`
            : "Selesaikan installation di browser lalu cek lagi.",
        ].join("\n"));
        return;
      }
      if (/^repos\s+/iu.test(command)) {
        const connectionId = command.replace(/^repos\s+/iu, "").trim();
        const page = await codingRuntime.privateGitHub.listRepositories(
          actor,
          connectionId,
        );
        await ctx.reply([
          "Repository yang dipilih GitHub App:",
          ...page.repositories.map((repository) =>
            `• ${repository.repositoryFullName} — id ${repository.repositoryId} (${repository.visibility})`
          ),
          "",
          `Pilih: /github use ${connectionId} <repositoryId>`,
        ].join("\n"));
        return;
      }
      if (/^use\s+/iu.test(command)) {
        const parts = command.replace(/^use\s+/iu, "").trim().split(/\s+/u);
        if (parts.length !== 2) {
          await ctx.reply("Format: /github use <connectionId> <repositoryId>");
          return;
        }
        const provisioned = await codingRuntime.privateGitHub.selectAndProvision(
          actor,
          { connectionId: parts[0]!, repositoryId: parts[1]! },
        );
        if (provisioned.status === "bootstrap_required") {
          await ctx.reply([
            "Repository privat ini benar-benar kosong.",
            "Harvy belum menulis apa pun. Untuk melanjutkan, Harvy perlu membuat commit baseline code-owned berupa README.md pada default branch.",
            `Repository: ${provisioned.selection.repositoryFullName}`,
            `Konfirmasi: /github bootstrap ${provisioned.selection.selectionId}`,
          ].join("\n\n"));
          return;
        }
        await ctx.reply([
          "Repository GitHub sudah menjadi project workspace terisolasi.",
          `Repository: ${provisioned.selection.repositoryFullName}`,
          `Base commit: ${provisioned.selection.baseCommit}`,
          `Project: ${provisioned.project.id}`,
          "Mulai dengan /code <task>.",
        ].join("\n"));
        return;
      }
      if (/^bootstrap\s+/iu.test(command)) {
        const selectionId = command.replace(/^bootstrap\s+/iu, "").trim();
        const provisioned = await codingRuntime.privateGitHub.bootstrapAndProvision(
          actor,
          selectionId,
        );
        await ctx.reply([
          "Baseline repository dibuat dan project workspace sudah siap.",
          `Repository: ${provisioned.selection.repositoryFullName}`,
          `Base commit: ${provisioned.selection.baseCommit}`,
          `Project: ${provisioned.project.id}`,
          "Mulai dengan /code <task>.",
        ].join("\n"));
        return;
      }
      await ctx.reply([
        "GitHub App workspace-private:",
        "/github connect",
        "/github status <connectionId>",
        "/github repos <connectionId>",
        "/github use <connectionId> <repositoryId>",
        "/github bootstrap <selectionId> — hanya untuk repo privat kosong",
      ].join("\n"));
    });
  });

  bot.command("publish", (ctx) => {
    const ownerId = ownerOf(ctx);
    enqueueBotAction(ctx, ownerId, "drain", "Persiapan publish gagal:", async () => {
      if (!codingRuntime?.privateGitHub) {
        await ctx.reply("GitHub App Broker belum diaktifkan.");
        return;
      }
      if (!await codingConsent(ctx, ownerId)) return;
      const runId = commandTail(ctx.message?.text ?? "", "publish");
      const actor = privateCodingActor(ctx, codingRuntime);
      const offer = runId
        ? await codingRuntime.privateGitHub.preparePublishOfferForRun(actor, runId)
        : await codingRuntime.privateGitHub.preparePublishOffer(actor);
      if (!offer) {
        await ctx.reply("Draft PR untuk CodingRun terbaru sudah dibuat.");
        return;
      }
      await sendPublishOffer(ctx, offer);
    });
  });

  bot.on("message:document", (ctx) => {
    const imageType = telegramImageMediaType(ctx.message.document.mime_type);
    if (imageType) {
      enqueueTelegramImage(
        ctx,
        ctx.message.document.file_id,
        ctx.message.document.file_size,
        imageType,
        ctx.message.caption ?? "",
      );
      return;
    }
    if (ctx.message.document.mime_type?.startsWith("image/")) {
      const ownerId = ownerOf(ctx);
      enqueueBotAction(
        ctx,
        ownerId,
        "cancel",
        "Format gambar gagal ditanggapi:",
        async () => {
          await ctx.reply("Kirim gambar JPEG, PNG, atau WebP, ya.");
        },
      );
      return;
    }
    const ownerId = ownerOf(ctx);
    enqueueBotAction(ctx, ownerId, "drain", "Upload project ZIP gagal:", async () => {
      if (!codingRuntime) {
        await ctx.reply("Runtime coding belum diaktifkan oleh deployment Harvy.");
        return;
      }
      if (!await codingConsent(ctx, ownerId)) return;
      const document = ctx.message.document;
      if (
        !document.file_name?.toLocaleLowerCase("en-US").endsWith(".zip") &&
        document.mime_type !== "application/zip"
      ) {
        await ctx.reply("Untuk project coding, kirim archive berformat ZIP.");
        return;
      }
      const telegramFile = await ctx.api.getFile(document.file_id);
      if (!telegramFile.file_path) throw new Error("Telegram tidak menyediakan path file ZIP.");
      const archive = await downloadTelegramZip(
        config.telegramBotToken,
        telegramFile.file_path,
        document.file_size,
      );
      const selected = await codingRuntime.application.uploadZip(
        privateCodingActor(ctx, codingRuntime),
        archive,
      );
      await ctx.reply([
        "ZIP sudah dipasang sebagai project terisolasi.",
        `Project: ${selected.projectId}`,
        `Revision: ${selected.projectRevision}`,
        "Mulai dengan /code <task>.",
      ].join("\n"));
    });
  });

  bot.on("message:photo", (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    enqueueTelegramImage(
      ctx,
      photo.file_id,
      photo.file_size,
      "image/jpeg",
      ctx.message.caption ?? "",
    );
  });

  bot.on("message:text", (ctx) => {
    const ownerId = ownerOf(ctx);
    const text = ctx.message.text.trim();

    // Telegram tidak menerima tanda hubung pada registrasi command native,
    // tetapi shortcut yang sama dengan WhatsApp tetap harus bekerja ketika
    // diketik langsung. Jalurnya hanya membuka konfirmasi bertoken; data baru
    // dihapus setelah tombol YES yang sama dengan kontrol menu dipilih.
    if (/^\/hapus-data(?:@[A-Za-z0-9_]+)?$/iu.test(text)) {
      enqueueBotAction(
        ctx,
        ownerId,
        "cancel",
        "Perintah /hapus-data gagal:",
        () => showControl(ctx, ownerId, "delete-all"),
      );
      return;
    }

    if (text.startsWith("/")) {
      enqueueBotAction(
        ctx,
        ownerId,
        "cancel",
        "Perintah tak dikenal gagal ditanggapi:",
        async () => {
          await ctx.reply(
            [
              "Aku belum punya perintah itu.",
              "",
              renderHelpMessage(commandOptions, "telegram"),
            ].join("\n"),
          );
        },
      );
      return;
    }

    const codingAnchor = codingAnchors.get(ownerId);
    if (
      codingRuntime && codingAnchor &&
      ctx.message.reply_to_message?.message_id === codingAnchor.messageId
    ) {
      enqueueBotAction(
        ctx,
        ownerId,
        "drain",
        "Correction CodingRun gagal:",
        async () => {
          if (!await codingConsent(ctx, ownerId)) return;
          const handle = await codingRuntime.application.revise(
            privateCodingActor(ctx, codingRuntime),
            {
              sourceMessageId: `telegram:${ctx.message.message_id}`,
              content: text,
              kind: "constraint",
            },
            (run) => scheduleCodingAnchor(
              run,
              codingAnchor.chatId,
              codingAnchor.messageId,
            ),
          );
          await ctx.reply("Constraint diterapkan ke revision CodingRun terbaru.");
          trackCodingCompletion(ctx, ownerId, handle, codingAnchor.messageId);
        },
      );
      return;
    }

    // Gerbang persetujuan wajib berada di sini, sebelum `enqueue`.
    // Boundary lokal tidak mengirim isi keluar, tetapi bentuk ambigu masih
    // memakai `classifyTurnBoundary` dan mengirim teks ke penyedia model.
    // Karena itu gerbang consent tetap wajib berada sebelum `enqueue`.
    const ingress = enqueueConsentIngress(ctx, ownerId, text)
      .catch((error: unknown) => {
        logger.error(
          "onboarding_ingress_failed",
          "Gerbang kenalan gagal.",
          error,
        );
      });
    trackIngress(ingress);
  });

  bot.on("callback_query:data", (ctx) => {
    const ownerId = String(ctx.from.id);
    const [action = "", target = ""] = ctx.callbackQuery.data.split(":");

    // Tutup spinner segera. Tindakannya tetap mengantre di belakang chat milik
    // pengguna ini, tetapi handler update kembali agar polling pengguna lain
    // tidak ikut tertahan oleh generasi model yang panjang.
    void ctx.answerCallbackQuery().catch((error: unknown) => {
      logger.warn(
        "telegram_callback_ack_failed",
        "Callback Telegram gagal diakui.",
        { error },
      );
    });
    if (action === "codingpub") {
      enqueueBotAction(
        ctx,
        ownerId,
        "drain",
        "Confirmation publish GitHub gagal:",
        async () => {
          if (!codingRuntime?.privateGitHub) {
            await ctx.reply("GitHub App Broker tidak tersedia.");
            return;
          }
          if (!await codingConsent(ctx, ownerId)) return;
          const confirmed = await codingRuntime.privateGitHub.confirmPublishOffer(
            privateCodingActor(ctx, codingRuntime),
            target,
          );
          await dropKeyboard(ctx);
          await ctx.reply([
            `Efek ${confirmed.receipt.capability} tercatat ${confirmed.receipt.status}.`,
            `Effect: ${confirmed.receipt.effectId}`,
            `Commit: ${confirmed.receipt.commit}`,
            ...(confirmed.receipt.url ? [`URL: ${confirmed.receipt.url}`] : []),
          ].join("\n"));
          if (confirmed.nextOffer) await sendPublishOffer(ctx, confirmed.nextOffer);
          else if (
            confirmed.receipt.status === "committed" &&
            confirmed.receipt.capability === "github.pr.create"
          ) {
            await ctx.reply("Workflow publish selesai: branch exact, push exact, dan draft PR sudah terbukti.");
          }
        },
      );
      return;
    }
    if (
      action === "consent" ||
      action === "safety" ||
      action === "consentwithdraw" ||
      action === "datawipe"
    ) {
      // Posisi callback pada rantai izin harus dipesan saat update masuk,
      // bukan beberapa saat kemudian ketika antrean bot mulai menjalankannya.
      // Dengan begitu pesan yang tiba setelah klik tidak dapat memakai hasil
      // pembacaan consent lama.
      void enqueueOnboardingOperation(ownerId, () =>
        messageBatcher.drainAndRun(ownerId, () =>
          runGuardedAction(ctx, "Tombol izin/data gagal diproses:", () =>
            routeAction(ctx, ownerId, action, target),
          ),
        ),
      ).catch((error: unknown) => {
        logger.error(
          "consent_queue_failed",
          "Antrean izin atau kontrol data gagal.",
          error,
        );
      });
      return;
    }
    enqueueBotAction(
      ctx,
      ownerId,
      "drain",
      "Tombol gagal diproses:",
      () => routeAction(ctx, ownerId, action, target),
    );
  });

  bot.catch(({ error }) => {
    logger.error(
      "telegram_update_failed",
      "Update Telegram gagal diproses.",
      error,
    );
  });

  return Object.assign(bot, {
    resumeAgentRuns: () => resumeActiveAgentRuns(),
    drainPending: async () => {
      await drainIngress();
      await drainOnboarding();
      await messageBatcher.drainAll();
      await stopActiveAgentWork();
      await Promise.allSettled([...activeCodingWork]);
      await history.drain?.();
      await memories.drain?.();
      await telemetry.drain();
    },
    sendCheckIn: (candidate: ActiveSession) =>
      sendScheduledCheckIn(candidate),
    sendReminder: (candidate: StudentTask) =>
      sendScheduledReminder(candidate),
  });

  async function sendScheduledCheckIn(
    candidate: ActiveSession,
  ): Promise<boolean> {
    let sent = false;
    const accepted = await messageBatcher.runWhenIdle(
      candidate.ownerId,
      async () => {
        const personalized = await scheduledCheckInText(candidate);
        sent = await sessions.deliverCheckIn(candidate, async (current) => {
          const response = current.updatedAt === candidate.updatedAt
            ? personalized
            : CHECK_IN_MESSAGE;
          await bot.api.sendMessage(current.chatId, response, {
            reply_markup: checkInOutcomeActions(current),
          });
          await history.append(current.ownerId, "harvy", response);
        });
      },
    );
    return accepted && sent;
  }

  async function sendScheduledReminder(
    candidate: StudentTask,
  ): Promise<boolean> {
    let sent = false;
    const accepted = await messageBatcher.runWhenIdle(
      candidate.ownerId,
      async () => {
        const profile = await profiles.load(candidate.ownerId);
        const timeZone = profile.timeZone ?? config.defaultTimezone;
        const candidateFallback = [
          "🔔 Pengingat",
          "",
          `• ${candidate.title}`,
        ].join("\n");
        const personalized = await presentPrivateOperation(candidate.ownerId, {
          kind: "reminder-due",
          outcome: "information",
          userMessage: `Pengingat untuk ${candidate.title}`,
          stableBody: ["🔔 Pengingat", "", `• ${candidate.title}`].join("\n"),
          fallbackText: candidateFallback,
        }, { timeZone });
        sent = await tasks.deliverReminder(candidate, async (current) => {
          const fallbackText = [
            "🔔 Pengingat",
            "",
            `• ${current.title}`,
          ].join("\n");
          const response = current.title === candidate.title &&
              current.dueAt === candidate.dueAt
            ? personalized
            : fallbackText;
          await bot.api.sendMessage(current.chatId, response, {
            reply_markup: reminderActions(current),
          });
          await history.append(current.ownerId, "harvy", response);
        });
      },
    );
    return accepted && sent;
  }

  /**
   * Membaca status persetujuan sekali per pengguna, lalu mengingatnya.
   *
   * Gagal membaca dianggap belum menyetujui. Akibat terburuknya perkenalan
   * muncul sekali lagi kepada pengguna lama; sebaliknya, menganggap sudah
   * setuju ketika berkasnya tidak terbaca berarti mengirim pesannya ke luar
   * tanpa izin.
   */
  function consentGate(ownerId: string): Promise<boolean> {
    let check = consentChecks.get(ownerId);
    if (check) return check;

    check = profiles
      .needsOnboarding(ownerId)
      .then((needs) => !needs)
      .catch((error: unknown) => {
        logger.error(
          "consent_status_read_failed",
          "Status persetujuan gagal dibaca.",
          error,
        );
        consentChecks.delete(ownerId);
        return false;
      });

    consentChecks.set(ownerId, check);
    return check;
  }

  /**
   * Perkenalan pada kontak pertama, apa pun bentuk kontaknya.
   *
   * Pesan yang sudah telanjur dikirim ditahan lokal — tidak dibaca, tidak
   * dikirim ke mana pun — lalu diproses sendiri setelah pengguna menekan
   * tombolnya. Menyuruhnya mengetik ulang berarti menghukum orang yang langsung
   * bercerita.
   */
  async function beginOnboarding(
    ctx: Context,
    ownerId: string,
    text: string,
    force = false,
  ): Promise<void> {
    const heldSuccessfully = text ? held.hold(ownerId, text) : true;
    if (!heldSuccessfully && held.markLimitWarned(ownerId)) {
      await ctx.reply(HOLD_LIMIT_REACHED);
    }

    // Bahaya dijawab lebih dulu, dan penilaiannya memakai model. Konstitusi
    // v0.3 Pasal 3.9 mengizinkan pemeriksaan ini berjalan sebelum persetujuan,
    // khusus untuk keselamatan — dan naskah perkenalan mengatakannya apa adanya
    // alih-alih mengaku belum membaca apa pun.
    if (text && held.markSafetyShown(ownerId)) {
      const assessment = await assessPreConsentRisk(text);
      if (assessment === "danger") {
        await ctx.reply(PRE_CONSENT_SAFETY);
      } else if (assessment === "unknown") {
        await ctx.reply(PRE_CONSENT_UNCERTAIN);
      }
    }

    const first = held.markIntroduced(ownerId);
    if (!first && !force) {
      if (held.markReminded(ownerId)) await ctx.reply(HOLD_REMINDER);
      return;
    }

    const bubbles = introBubbles(ctx.from?.first_name ?? null, held.has(ownerId), config.termsUrl);

    for (const [index, bubble] of bubbles.entries()) {
      const last = index === bubbles.length - 1;
      await ctx.reply(bubble, last ? { reply_markup: consentActions() } : {});

      if (!last) {
        await bestEffortTyping(ctx, logger);
        await sleep(bubblePauseMs(bubbles[index + 1] ?? ""));
      }
    }
  }

  /**
   * Menserialisasi triase, penahanan pesan, dan naskah perkenalan per pemilik.
   *
   * Tanpa antrean ini bubble kedua dapat mengirim perkenalan saat triase bubble
   * pertama masih berjalan, atau tombol persetujuan dapat mengosongkan pesan
   * sebelum triase pertama selesai.
   */
  function enqueueOnboarding(
    ctx: Context,
    ownerId: string,
    text: string,
    force = false,
  ): Promise<void> {
    return enqueueOnboardingOperation(ownerId, () =>
      beginOnboarding(ctx, ownerId, text, force),
    );
  }

  /**
   * Gerbang izin dan penerimaan izin memakai antrean yang sama.
   *
   * Mendaftarkan operasinya secara sinkron saat update masuk menutup celah
   * ketika sebuah bubble datang persis saat tombol persetujuan sedang
   * diproses: bubble itu pasti berada sebelum atau sesudah penerimaan izin,
   * tidak dapat terselip di antara `held.take` dan `held.clear`.
   */
  function enqueueConsentIngress(
    ctx: Context,
    ownerId: string,
    text: string,
  ): Promise<void> {
    return enqueueOnboardingOperation(ownerId, async () => {
      if (await consentGate(ownerId)) {
        const runIngress = await reserveActiveRunIngress(ctx, ownerId);
        if (runIngress) {
          const queuedAt = Date.now();
          await messageBatcher.drainAndRun(ownerId, () =>
            processBoundActiveRunIngress(
              ctx,
              ownerId,
              text,
              runIngress,
              queuedAt,
            )
          );
          return;
        }
        const running = activeProgress.get(ownerId);
        if (running) {
          // Pesan susulan yang datang saat Harvy sudah bekerja. Hubungannya
          // belum dinilai—menambah, mengoreksi, atau ganti topik—dan penilaian
          // itu perlu beberapa detik. Tanpa ini layar tetap menampilkan
          // pekerjaan lama seolah tidak terjadi apa-apa, padahal pekerjaan itu
          // mungkin sedang dibuang.
          running.report({ phase: "reading", detail: "new-message" });
        } else if (!waitingProgress.has(ownerId)) {
          const waiting = createTelegramProgress(ctx, ownerId);
          if (waiting) {
            waitingProgress.set(ownerId, waiting);
            waiting.report({ phase: "waiting" });
          }
        }
        messageBatcher.enqueue(ownerId, text, ctx, ctx.update.update_id);
        return;
      }
      await beginOnboarding(ctx, ownerId, text);
    });
  }

  async function reserveActiveRunIngress(
    ctx: Context,
    ownerId: string,
  ): Promise<ActiveRunIngressReservation | null> {
    const quoted = quotedMessageId(ctx);
    if (!quoted) return null;
    const run = await activeRunForIngress(ownerId);
    if (!run?.anchor.messageId || run.anchor.messageId !== quoted) return null;
    return activeRunIngress.reserve(run.runId);
  }

  async function processBoundActiveRunIngress(
    ctx: Context,
    ownerId: string,
    text: string,
    reservation: ActiveRunIngressReservation,
    queuedAt: number,
  ): Promise<void> {
    const turnId = randomUUID();
    const startedAt = Date.now();
    let outcome: "completed" | "failed" = "completed";
    await telemetry.beginTurn(ownerId, turnId);
    try {
      await withUsageAttribution(
        {
          turnId,
          subjectKind: "private",
          channel: "telegram",
          actorAliases: [],
        },
        () => handleFreeText(
          ctx,
          ownerId,
          text,
          {},
          ctx.update.update_id,
          hasExplicitImmediateDangerSignal(text),
          false,
        ),
      );
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      activeRunIngress.release(reservation);
      const endedAt = Date.now();
      await telemetry.recordTurn({
        turnId,
        ownerId,
        subjectKind: "private",
        channel: "telegram",
        outcome,
        bubbleCount: 1,
        batchWaitMs: 0,
        queueWaitMs: Math.max(0, startedAt - queuedAt),
        handlingLatencyMs: Math.max(0, endedAt - startedAt),
        totalLatencyMs: Math.max(0, endedAt - queuedAt),
      });
    }
  }

  function enqueueTelegramImage(
    ctx: Context,
    fileId: string,
    declaredSize: number | undefined,
    mediaType: ChatImageMediaType,
    caption: string,
  ): void {
    const ownerId = ownerOf(ctx);
    const queuedAt = Date.now();
    const ingress = enqueueOnboardingOperation(ownerId, async () => {
      if (!await consentGate(ownerId)) {
        await beginOnboarding(ctx, ownerId, "");
        await ctx.reply(
          "Setelah menyetujui, kirim ulang gambarnya supaya media tidak ditahan sebelum izin.",
        );
        return;
      }
      messageBatcher.cancelAndEnqueue(ownerId, () =>
        runGuardedAction(ctx, "Gambar gagal diproses:", () =>
          processTelegramImage(
            ctx,
            ownerId,
            fileId,
            declaredSize,
            mediaType,
            caption,
            queuedAt,
          )
        )
      );
    }).catch((error: unknown) => {
      logger.error(
        "telegram_image_ingress_failed",
        "Gerbang gambar Telegram gagal.",
        error,
      );
    });
    trackIngress(ingress);
  }

  async function processTelegramImage(
    ctx: Context,
    ownerId: string,
    fileId: string,
    declaredSize: number | undefined,
    mediaType: ChatImageMediaType,
    caption: string,
    queuedAt: number,
  ): Promise<void> {
    const telegramFile = await ctx.api.getFile(fileId);
    if (!telegramFile.file_path) {
      throw new Error("Telegram tidak menyediakan path gambar.");
    }
    const image = await downloadTelegramImage(
      config.telegramBotToken,
      telegramFile.file_path,
      mediaType,
      declaredSize,
    );
    const text = caption.trim() || "Tolong bantu aku memahami gambar ini.";
    const turnId = randomUUID();
    const startedAt = Date.now();
    let outcome: "completed" | "failed" = "completed";
    await telemetry.beginTurn(ownerId, turnId);
    try {
      await withUsageAttribution(
        {
          turnId,
          subjectKind: "private",
          channel: "telegram",
          actorAliases: [],
        },
        () => handleFreeText(
          ctx,
          ownerId,
          text,
          {
            images: [{
              type: "input_image",
              mediaType,
              data: image,
              // The verified GMI/MiniMax wire is reliable with `low` while
              // live probes misclassified deterministic images with `auto`.
              detail: "low",
            }],
          },
          ctx.update.update_id,
          hasExplicitImmediateDangerSignal(text),
          false,
        ),
      );
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      const endedAt = Date.now();
      await telemetry.recordTurn({
        turnId,
        ownerId,
        subjectKind: "private",
        channel: "telegram",
        outcome,
        bubbleCount: 1,
        batchWaitMs: 0,
        queueWaitMs: Math.max(0, startedAt - queuedAt),
        handlingLatencyMs: Math.max(0, endedAt - startedAt),
        totalLatencyMs: Math.max(0, endedAt - queuedAt),
      });
    }
  }

  function enqueueOnboardingOperation(
    ownerId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = onboardingChains.get(ownerId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation);
    onboardingChains.set(ownerId, next);
    void next.then(
      () => releaseOnboarding(ownerId, next),
      () => releaseOnboarding(ownerId, next),
    );
    return next;
  }

  function releaseOnboarding(ownerId: string, task: Promise<void>): void {
    if (onboardingChains.get(ownerId) === task) {
      onboardingChains.delete(ownerId);
    }
  }

  async function drainOnboarding(): Promise<void> {
    while (onboardingChains.size > 0) {
      await Promise.allSettled([...onboardingChains.values()]);
    }
  }

  function trackIngress(task: Promise<void>): void {
    ingressTasks.add(task);
    void task.then(
      () => ingressTasks.delete(task),
      () => ingressTasks.delete(task),
    );
  }

  async function drainIngress(): Promise<void> {
    while (ingressTasks.size > 0) {
      await Promise.allSettled([...ingressTasks]);
    }
  }

  /**
   * Pemeriksaan bahaya atas pesan yang belum disetujui pemrosesannya.
   *
   * Kegagalannya tidak boleh menghentikan perkenalan: yang hilang hanya
   * kesempatan menjawab lebih dulu, dan itu lebih baik daripada pengguna baru
   * yang tidak mendapat sapaan sama sekali.
   */
  async function assessPreConsentRisk(
    text: string,
  ): Promise<"danger" | "calm" | "unknown"> {
    const immediateDanger = hasExplicitImmediateDangerSignal(text);
    // Pengguna belum memberi consent dan pesan pertama ini tidak melewati
    // MessageBatcher. Sinyal lokal yang sangat sempit harus menampilkan copy
    // safety segera, tanpa menunggu atau mengirim teks ke provider.
    if (immediateDanger) return "danger";
    try {
      const triage = await conversation.triageRisk(text);
      if (!triage) return "unknown";
      return triage.level === "bahaya" ? "danger" : "calm";
    } catch (error) {
      logger.error(
        "pre_consent_triage_failed",
        "Triase keselamatan pra-persetujuan gagal.",
        error,
      );
      return "unknown";
    }
  }

  function createTelegramProgress(
    ctx: Context,
    seed: string,
  ): TransientConversationProgress<SentMessageRef> | null {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return null;
    // Jam giliran dimulai di sini, bukan saat model dipanggil: yang dirasakan
    // pengguna adalah sejak pesannya terkirim.
    const startedAt = Date.now();
    const ownerId = ownerOf(ctx);
    return new TransientConversationProgress<SentMessageRef>(
      {
        show: async (text) => {
          // Status sementara ini dihapus lagi sebelum jawabannya dikirim, jadi
          // ia tidak boleh berbunyi. Tanpa `disable_notification`, tiap giliran
          // yang lebih lambat dari grace period mengirim getar dan preview ke
          // layar kunci untuk pesan yang beberapa detik kemudian hilang.
          const sent = await bot.api.sendMessage(chatId, text, {
            disable_notification: true,
          });
          return { chatId: sent.chat.id, messageId: sent.message_id };
        },
        update: async (reference, text) => {
          await bot.api.editMessageText(
            reference.chatId,
            reference.messageId,
            text,
          );
        },
        remove: async (reference) => {
          await bot.api.deleteMessage(reference.chatId, reference.messageId);
        },
        typing: async () => {
          await bot.api.sendChatAction(chatId, "typing");
        },
      },
      {
        seed,
        // Perubahan fase ditahan lama karena ia jarang membawa informasi baru
        // yang mendesak. Denyut bulan tidak melewati penahan ini—ia menyunting
        // langsung tiap detik, dan kanal menerimanya: satu giliran nyata
        // mencatat dua puluh lima suntingan, dua di antaranya ditolak batas
        // laju. Penolakan itu tidak diulang—`onError` mencatat, bingkai
        // sebelumnya bertahan sedetik lebih lama, dan giliran berjalan terus.
        minimumUpdateIntervalMs: 15_000,
        // Gagal aman: baris biaya adalah hiasan, dan tidak boleh menjadi sebab
        // status gagal tampil. Telemetry di sini bisa berupa objek yang lebih
        // ramping daripada tipenya—test double membentuk seperlunya.
        footer: () => {
          try {
            return renderProgressMeter(
              Date.now() - startedAt,
              telemetry.turnTokens?.(ownerId, activeTurnId.get(ownerId) ?? null) ??
                { input: 0, output: 0 },
            );
          } catch {
            return null;
          }
        },
        onError: (operation, error) => {
          logger.warn(
            "telegram_progress_operation_failed",
            "Status kerja sementara gagal diperbarui.",
            {
              operation,
              errorType: error instanceof Error ? error.name : "unknown",
            },
          );
        },
      },
    );
  }

  /**
   * Di luar jalur deterministik yang sempit, pesan bebas masuk compiler lebih
   * dulu. Tugas hanya dicatat ketika maksudnya memang mencatat pekerjaan;
   * selebihnya Harvy menjawab sebagai teman bicara dan hanya *menawarkan*
   * pencatatan.
   */
  async function handleFreeText(
    ctx: Context,
    ownerId: string,
    text: string,
    runtime: ConversationRuntime = {},
    firstIngressUpdateId = ctx.update.update_id,
    explicitImmediateDanger = false,
    urgentBoundary = false,
  ): Promise<void> {
    // "2" diperluas menjadi frasa pilihan yang tercatat, lalu mengalir lewat
    // jalur biasa.
    //
    // Nomor tidak pernah memberi wewenang apa pun: yang dihasilkan hanyalah
    // kalimat yang setara dengan mengetiknya sendiri, sehingga pembatalan tetap
    // menuntut konfirmasi dan pemetaan yang basi paling jauh menghasilkan
    // pertanyaan. Itu sengaja, karena mode kegagalan yang ditakuti di sini
    // bukan salah paham melainkan menghapus tugas yang salah.
    const choice = parseNumberedReply(text);
    const chosen = choice === null
      ? null
      : numberedOptions.resolve(ownerId, choice);
    if (chosen) {
      logger.info(
        "numbered_reply_expanded",
        "Balasan bernomor diperluas menjadi frasa pilihannya.",
        { decision: String(choice) },
      );
      text = chosen;
    }
    const createdProgress = runtime.progress
      ? null
      : createTelegramProgress(ctx, currentTurnId() ?? ownerId);
    // Status yang diserahkan dari luar—"Menunggu Harvy" yang dibuat saat pesan
    // tiba—menjadi milik giliran ini, dan giliran ini yang wajib menutupnya.
    //
    // Sebelum baris ini, `finally` hanya menutup status yang dibuat di dalam.
    // Giliran yang dibatalkan tidak pernah mengirim balasan, sehingga jalur
    // penutupan lewat `ctx.reply` juga tidak pernah berjalan—dan statusnya
    // tertinggal di layar pengguna selamanya. Persis yang terjadi ketika
    // pengguna menyela: pekerjaan lama dibatalkan, statusnya tidak.
    const handedProgress = runtime.progress as
      | (ConversationProgressReporter & { finish?: () => Promise<void> })
      | undefined;
    const ownedProgress = createdProgress ??
      (typeof handedProgress?.finish === "function" ? handedProgress : null);
    const progress = runtime.progress ?? createdProgress ?? undefined;
    const scopedRuntime: ConversationRuntime = progress
      ? { ...runtime, progress }
      : runtime;
    if (progress) activeProgress.set(ownerId, progress);
    const turnIdForMeter = currentTurnId();
    if (turnIdForMeter) activeTurnId.set(ownerId, turnIdForMeter);
    const interruptionEvent = interruptionProgressEvent(
      runtime.interruptionRelation,
    );
    if (interruptionEvent) progress?.report(interruptionEvent);

    try {
      await handleFreeTextTurn(
        ctx,
        ownerId,
        text,
        scopedRuntime,
        firstIngressUpdateId,
        explicitImmediateDanger,
        urgentBoundary,
      );
    } finally {
      if (activeProgress.get(ownerId) === progress) {
        activeProgress.delete(ownerId);
      }
      if (activeTurnId.get(ownerId) === turnIdForMeter) {
        activeTurnId.delete(ownerId);
      }
      // Pembersihan penghitung biaya tidak boleh mendahului penutupan status.
      // Ia berjalan di `finally`, jadi lemparan apa pun di sini akan menggantikan
      // hasil giliran **dan** melewati `finish()`—statusnya tertinggal di layar
      // pengguna selamanya, persis cacat yang sudah pernah dilaporkan sekali.
      try {
        telemetry.releaseTurnTokens?.(ownerId, turnIdForMeter ?? null);
      } catch {
        // Sengaja diam: ini akuntansi tampilan, bukan bagian dari jawaban.
      }
      await ownedProgress?.finish?.();
    }
  }

  async function handleFreeTextTurn(
    ctx: Context,
    ownerId: string,
    text: string,
    runtime: ConversationRuntime = {},
    firstIngressUpdateId = ctx.update.update_id,
    explicitImmediateDanger = false,
    urgentBoundary = false,
  ): Promise<void> {
    const hasImageInput = Boolean(runtime.images?.length);
    if (
      !hasImageInput &&
      !explicitImmediateDanger &&
      !urgentBoundary &&
      !hasExplicitImmediateDangerSignal(text) &&
      await handleLocalActiveRunControl(ctx, ownerId, text, runtime)
    ) {
      return;
    }
    const credentialSafetyReply = economyCredentialSafetyReply(text);
    if (credentialSafetyReply) {
      if (!(await runtimeIsCurrent(runtime))) return;
      await ctx.reply(credentialSafetyReply);
      // Credentials never enter history, memory, semantic compilation, or
      // transient navigation context.
      return;
    }
    actionOffers.clear(ownerId);
    const [profile, activeSession] = await Promise.all([
      profiles.load(ownerId),
      sessions.active(ownerId),
    ]);
    const timeZone = profile.timeZone ?? config.defaultTimezone;
    if (!(await runtimeIsCurrent(runtime))) return;

    // `drainPending()` pada shutdown/test dapat mem-flush bubble sebelum timer
    // klasifikasi sempat memuat checkpoint dari disk. Handler tetap authority
    // terakhir agar restart tidak bergantung pada timer UX.
    const restoredAtStart = await restoreAgentPending(ownerId);
    const pendingAtStart = restoredAtStart ?? pending.peek(ownerId);
    const waitingAtStart = pendingAtStart && pendingAnswerIsEligible(
      firstIngressUpdateId,
      pendingAtStart,
    )
      ? pendingAtStart
      : null;
    const immediateDanger =
      explicitImmediateDanger || hasExplicitImmediateDangerSignal(text);

    const arithmeticReply =
      !hasImageInput && !waitingAtStart && !activeSession &&
        !immediateDanger && !urgentBoundary
        ? deterministicArithmeticReply(text)
        : null;
    if (arithmeticReply) {
      await noteTurnSignal(ownerId, "deterministic-fast-path");
      await appendUserHistory(ownerId, text, runtime);
      if (!(await runtimeIsCurrent(runtime))) return;
      await ctx.reply(arithmeticReply);
      await history.append(ownerId, "harvy", arithmeticReply);
      void history.compact(ownerId);
      return;
    }

    // Baru sesudah fast path lokal gugur, bayar kompilasi history dan semantic
    // memory. Ini penting karena retrieval dapat memanggil embedding/provider;
    // hitungan exact tidak boleh menunggu seluruh pipeline tersebut.
    const initialContext = await contextFor(ownerId, text);
    let context = initialContext;
    let engagedSession: ActiveSession | null = null;
    if (!(await runtimeIsCurrent(runtime))) return;

    // Pertanyaan identitas model yang berdiri sendiri adalah fakta produk,
    // sehingga tetap dapat dijawab saat model dasar atau kuota biasa sedang
    // tidak tersedia. Pesan campuran tetap masuk triase penuh.
    if (!hasImageInput && canUseModelIdentityFastPath(text, context.turns)) {
      await noteTurnSignal(ownerId, "deterministic-fast-path");
      await appendUserHistory(ownerId, text, runtime);
      if (!(await runtimeIsCurrent(runtime))) return;
      await ctx.reply(CAPYBARA_MODEL_REPLY);
      await history.append(ownerId, "harvy", CAPYBARA_MODEL_REPLY);
      void history.compact(ownerId);
      return;
    }

    if (!hasImageInput && canUseDirectTimeFastPath(text, context.turns)) {
      const response = conversation.deterministicTimeReply(timeZone);
      await noteTurnSignal(ownerId, "deterministic-fast-path");
      await appendUserHistory(ownerId, text, runtime);
      if (!(await runtimeIsCurrent(runtime))) return;
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      void history.compact(ownerId);
      return;
    }

    // Nilai formulir memerlukan context untuk menyajikan hasilnya, tetapi
    // tetap berada di luar understanding/triase umum setelah context tersedia.
    if (
      !hasImageInput && waitingAtStart &&
      !immediateDanger &&
      isNarrowPendingAnswer(waitingAtStart, text)
    ) {
      await noteTurnSignal(ownerId, "deterministic-fast-path");
      await appendUserHistory(ownerId, text, runtime);
      if (!(await runtimeIsCurrent(runtime))) return;
      if (
        await handlePendingText(
          ctx,
          ownerId,
          waitingAtStart,
          text,
          timeZone,
          context,
          runtime,
          profile.stylePreference,
        )
      ) {
        void history.compact(ownerId);
        return;
      }
    }

    // Normalisasi local-only tetap menutup supersession/suppression pada jalur
    // safety yang sengaja tidak membayar embedding/provider.
    if (
      memoryContextCompiler &&
      typeof memoryContextCompiler.normalizePrivateBase === "function" &&
      (immediateDanger || urgentBoundary)
    ) {
      context = await memoryContextCompiler.normalizePrivateBase(
        ownerId,
        text,
        context,
        runtime.signal ? { signal: runtime.signal } : {},
      );
    }

    let understanding: Understanding | null;
    let triage: RiskAssessment;
    let userAlreadyAppended = false;
    let storedUserTurn: StoredConversationTurn | null = null;
    let activeRunLaunch: ActiveAgentRun | null = null;
    let activeRunLaunched = false;
    let activeRunSurfaceReply = false;
    let activeRunMemoryNotice: string | null = null;
    const requestRiskTriage = (): Promise<RiskTriage | null> =>
      conversation
        .triageRisk(text, ownerId, context, runtime.signal)
        .catch((error: unknown) => {
          logger.error(
            "risk_triage_failed",
            "Triase keselamatan gagal.",
            error,
          );
          return null;
        });
    // Bahaya eksplisit tidak menunggu compiler. Pesan lain baru membayar
    // triase setelah RiskHint compiler menyatakan possible/strong.
    const earlyRisk = immediateDanger || urgentBoundary
      ? requestRiskTriage()
      : undefined;
    // Hanya cabang compiler yang benar-benar memanggil model; dua cabang lain
    // menjawab dari state lokal dan selesai sebelum grace period habis. Lane
    // keselamatan lokal sengaja tetap sunyi supaya jawaban safety tidak
    // didahului basa-basi status.
    if (!immediateDanger && !urgentBoundary && !hasImageInput) {
      runtime.progress?.report(initialProgressEvent());
    }
    const readResult = immediateDanger
      ? ({ value: safetyOnlyUnderstanding() } as const)
      : hasImageInput
      ? ({ value: imageConversationUnderstanding() } as const)
      : await conversation
        .understand(text, context, {
          ...runtime,
          ownerId,
          timeZone,
          // The semantic compiler may see bounded active-session state so it
          // can decide relevance; the session itself is not assumed relevant
          // merely because it exists.
          session: activeSession,
        })
        .then(
          (value) => ({ value } as const),
          (error: unknown) => ({ error } as const),
        );
    if (!(await runtimeIsCurrent(runtime))) {
      await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      return;
    }

    understanding = "error" in readResult ? null : readResult.value;
    const parsedHint = understanding
      ? parseRiskHint(
          understanding.riskHint,
          understanding.safetySensitive,
        ) ?? NO_RISK_HINT
      : NO_RISK_HINT;
    const riskHint = withExplicitSupportHint(
      withImmediateDangerHint(
        parsedHint,
        immediateDanger || urgentBoundary,
      ),
      hasExplicitSupportTriageSignal(text),
    );
    // Retrieval follows the one mechanical understanding pass so activation is
    // semantic and multilingual. Safety-signalled turns keep the recent-only
    // path and never wait on an embedding/vector provider.
    if (
      !hasImageInput && memoryContextCompiler && understanding &&
      (understanding.intent !== "smalltalk" ||
        Boolean(understanding.semanticOperation)) &&
      riskHint.level === "none" && !immediateDanger && !urgentBoundary
    ) {
      try {
        const compiled = await memoryContextCompiler.compilePrivate(
          ownerId,
          text,
          context,
          {
            allowRetrieval: true,
            semanticOperation: understanding.semanticOperation ?? null,
            ...(runtime.signal ? { signal: runtime.signal } : {}),
          },
        );
        context = compiled.context;
        logger.info(
          "memory_context_compiled",
          "Context memory on-demand selesai dikompilasi.",
          {
            episodicRequested: compiled.manifest.episodicRequested,
            semanticRequested: compiled.manifest.semanticRequested,
            graphRequested: compiled.manifest.graphRequested,
            semanticProviderAvailable:
              compiled.manifest.semanticProviderAvailable,
            episodicResultCount: compiled.manifest.episodicResultCount,
            semanticResultCount: compiled.manifest.semanticResultCount,
            graphResultCount: compiled.manifest.graphResultCount,
            graphUsed: compiled.context.retrieved?.some((item) =>
              item.sources.includes("graph")) ?? false,
            suppressedCount: compiled.manifest.suppressedCount,
            selectedCount: compiled.manifest.selectedCount,
            selectedCharacters: compiled.manifest.selectedCharacters,
            failedRouteCount: compiled.manifest.failedRouteCount,
          },
        );
      } catch (error) {
        logger.warn(
          "memory_context_compile_failed",
          "Context retrieval gagal; recent context tetap dipakai.",
          { errorType: error instanceof Error ? error.name : "unknown" },
        );
      }
      if (!(await runtimeIsCurrent(runtime))) return;
    }
    // Bila compiler gagal, tidak adanya RiskHint bukan bukti tenang. Jalankan
    // triase sebagai fallback; bila itu juga gagal, policy tetap memetakan
    // keadaan tanpa bukti kuat ke `unavailable` + jalur percakapan biasa.
    const triageRequired = understanding === null || riskHint.level !== "none";
    const risk = triageRequired
      ? await (earlyRisk ?? requestRiskTriage())
      : undefined;
    if (!(await runtimeIsCurrent(runtime))) {
      await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      return;
    }
    if (triageRequired && risk === null) {
      await noteTurnSignal(ownerId, "risk-triage-unavailable");
    }
    triage = resolveRiskAssessment(riskHint, risk);

    if ("error" in readResult) {
      logger.error(
        "message_understanding_failed",
        "Pemahaman pesan gagal.",
        readResult.error,
      );
      if (triage.level !== "biasa") {
        understanding = safetyOnlyUnderstanding();
      } else {
        if (!userAlreadyAppended) {
          await appendUserHistory(ownerId, text, runtime);
        }
        const response = aiFailureMessage(readResult.error);
        if (!(await runtimeIsCurrent(runtime))) {
          await telemetry.discardUndelivered?.(ownerId, currentTurnId());
          return;
        }
        await ctx.reply(response);
        await history.append(ownerId, "harvy", response);
        return;
      }
    } else if (!understanding && triage.level !== "biasa") {
      understanding = safetyOnlyUnderstanding();
    }

    const exposeSemanticProgressFocus =
      runtime.interruptionRelation !== "correction" &&
      runtime.interruptionRelation !== "redirect";
    const publicProgressFocus = triage.level === "biasa" &&
        exposeSemanticProgressFocus
      ? understanding?.publicFocus ?? null
      : null;
    runtime = { ...runtime, publicProgressFocus };
    const focusEvent = publicFocusProgressEvent(
      runtime.interruptionRelation,
      publicProgressFocus,
    );
    if (focusEvent) runtime.progress?.report(focusEvent);

    if (understanding && activeSession) {
      engagedSession = sessionAppliesToMessage(
          activeSession,
          text,
          understanding.semanticOperation,
        )
        ? activeSession
        : null;
    }

    // Natural-language account/menu requests use the same bounded mechanical
    // understanding pass as the rest of the turn. These deterministic
    // surfaces do not enter durable conversation history, and every follow-up
    // reads fresh state from its owner-scoped service.
    if (!hasImageInput && understanding && triage.level === "biasa") {
      const semantic = understanding.semanticOperation;
      // Surface account/menu adalah jawaban mekanis. Bila assessment yang sama
      // mengatakan pengguna meminta analisis atau pekerjaan berencana, proposal
      // semantic yang kebetulan menyerupai "usage" tidak boleh membajak turn
      // menjadi dashboard statis. Agent tetap dapat membaca state lewat tool
      // bila pekerjaan kompleks itu memang memerlukannya.
      const deterministicSurfaceEligible = allowsDeterministicSurface(
        understanding.routingAssessment,
      );
      if (
        deterministicSurfaceEligible && semantic && semanticOperationContextAvailable(
          semantic,
          context.interactions,
        ) && semanticOperationAuthorized(text, semantic, {
        domain: "menu",
        operations: ["show", "show-help", "show-category"],
        minConfidence: 0.75,
        explicitness: ["explicit", "contextual"],
        })
      ) {
        const rendered = semantic.operation === "show-help"
          ? renderHelpMessage(commandOptions, "telegram")
          : semantic.operation === "show-category" && semantic.target
            ? renderCommandCategory(
                semantic.target,
                commandOptions,
                "telegram",
              ) ?? renderCommandMenu(commandOptions, "telegram")
            : renderCommandMenu(commandOptions, "telegram");
        if (!(await runtimeIsCurrent(runtime))) return;
        await ctx.reply(rendered, {
          reply_markup: semantic.operation === "show-help"
            ? helpActions()
            : menuActions(commandOptions),
        });
        interactionContext.record(interactionScope(ownerId), {
          domain: "menu",
          operation: semantic.operation,
          reference: semantic.reference === "all" ? "all" : "current",
        });
        logger.info(
          "semantic_route_selected",
          "Semantic turn memakai surface deterministik.",
          {
            semanticDomain: semantic.domain,
            semanticOperation: semantic.operation,
            confidenceBucket: semanticConfidenceBucket(semantic),
            route: "menu",
            recentContextUsed: semantic.explicitness === "contextual",
            recentContextKind: semantic.explicitness === "contextual"
              ? "interaction"
              : "none",
            deterministic: true,
            clarificationNeeded: false,
            semanticFallback: false,
          },
        );
        return;
      }

      if (deterministicSurfaceEligible && economyCommands) {
        const accountReply = semanticOperationContextAvailable(
            semantic,
            context.interactions,
          )
          ? await economyCommands.handle(
              ownerId,
              {
                rawText: text,
                semanticOperation: semantic,
                recentInteractions: context.interactions ?? [],
              },
              currentTurnId() ?? `telegram:${firstIngressUpdateId}`,
            )
          : null;
        if (accountReply) {
          if (!(await runtimeIsCurrent(runtime))) return;
          await ctx.reply(accountReply);
          if (semantic) {
            interactionContext.record(interactionScope(ownerId), {
              domain: semantic.domain,
              operation: semantic.operation,
              reference: semantic.reference === "all" ? "all" : "current",
            });
          }
          logger.info(
            "semantic_route_selected",
            "Semantic turn memakai surface account deterministik.",
            {
              semanticDomain: semantic?.domain ?? "none",
              semanticOperation: semantic?.operation ?? "none",
              confidenceBucket: semanticConfidenceBucket(semantic),
              route: "account",
              recentContextUsed: semantic?.explicitness === "contextual",
              recentContextKind: semantic?.explicitness === "contextual"
                ? "interaction"
                : "none",
              deterministic: true,
              clarificationNeeded: false,
              semanticFallback: false,
            },
          );
          return;
        }
      }
    }

    if (!userAlreadyAppended) {
      storedUserTurn = await appendUserHistory(ownerId, text, runtime);
    }
    if (!(await runtimeIsCurrent(runtime))) {
      await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      return;
    }

    try {
      if (!understanding) {
        const response = notUnderstoodNote();
        if (!(await runtimeIsCurrent(runtime))) {
          await telemetry.discardUndelivered?.(ownerId, currentTurnId());
          return;
        }
        await ctx.reply(response);
        await history.append(ownerId, "harvy", response);
        return;
      }

      const effectPermissions = safetyEffectPermissions(
        triage.routing,
        immediateDanger,
      );

      if (
        effectPermissions.generalState &&
        await handleActiveRunMailboxAfterSafety(ctx, ownerId, text, runtime)
      ) {
        await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
        return;
      }

      if (
        effectPermissions.generalState &&
        await handleNaturalProjectIntent(
          ctx,
          ownerId,
          text,
          understanding,
          context,
          runtime,
        )
      ) {
        await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
        return;
      }

      // Jawaban bebas untuk pending tetap memakai compiler + routing safety.
      // Hanya closed-set yang sudah keluar lewat fast path di atas.
      const pendingNow = pending.peek(ownerId);
      const waiting = pendingNow && pendingAnswerIsEligible(
        firstIngressUpdateId,
        pendingNow,
      )
        ? pendingNow
        : null;
      if (
        effectPermissions.generalState &&
        waiting &&
        (await handlePendingText(
          ctx,
          ownerId,
          waiting,
          text,
          timeZone,
          context,
          runtime,
          profile.stylePreference,
        ))
      ) {
        return;
      }

      // Pertanyaan state-live yang dikenali pagar lokal harus selalu mencapai
      // runtime read-only. Label intent/action model tidak boleh membajaknya ke
      // kontrol memori atau kontrol data sebelum tool authority hidup.
      const requiresLiveState = !hasImageInput &&
        liveStateRequirement(
          text,
          undefined,
          understanding.routingAssessment?.emotionalNuance ?? null,
        ) !== null;
      // Harvy sudah mengenali empat bentuk penyelaan, tetapi keempatnya satu
      // arah: pengguna menyela pekerjaan yang sedang berjalan. Ketika balasan
      // sudah terkirim tidak ada pekerjaan yang tergantikan, sehingga sambungan
      // kalimat pengguna diperlakukan sebagai topik baru—Harvy tidak punya cara
      // tahu bahwa ia baru saja memotong orang di tengah pikiran.
      //
      // Hanya sambungan yang mengubah jawaban yang diakui. Mengakui setiap
      // potongan lebih jujur tetapi terasa cerewet, dan potongan yang tidak
      // mengubah apa pun memang tidak merugikan siapa pun.
      const lastHarvyTurn = [...context.turns].reverse().find(
        (turn) => turn.role === "harvy",
      );
      const prematureReply = !hasImageInput && lastHarvyTurn !== undefined &&
        runtime.turnReceivedAt !== undefined &&
        acknowledgesPrematureReply({
          message: text,
          reply: lastHarvyTurn.text,
          elapsedMs: runtime.turnReceivedAt - Date.parse(lastHarvyTurn.at),
        });
      if (prematureReply) runtime = { ...runtime, prematureReply: true };
      const guidedSmallStep = !hasImageInput &&
        effectPermissions.generalState &&
        !activeSession &&
        prefersGuidedSmallStep(
          understanding.suggestedActions ?? [],
          understanding.routingAssessment,
        );
      // `planningRequired` describes the shape of work, not authority to start
      // that work. A user can mention a difficult plan while venting or giving
      // context (for example, "aku tahu harus meninjau catatan..."). Only an
      // actual request may open the Agent Runtime lane.
      const requiresAgentPlanning = !hasImageInput && !guidedSmallStep &&
        understanding.intent === "request" &&
        requiresPlannedExecution(understanding.routingAssessment);
      const proposedRoute = hasImageInput
        ? ({ kind: "conversation" } as const)
        : immediateUnderstandingRoute(understanding, text);
      const proposedRouteAllowed = proposedRoute.kind === "show-tasks"
        ? effectPermissions.generalState && allowsDeterministicSurface(
            understanding.routingAssessment,
          )
        : proposedRoute.kind === "save-task" ||
          proposedRoute.kind === "update-task" ||
          proposedRoute.kind === "complete-task"
        ? effectPermissions.ordinaryTask
        : proposedRoute.kind === "memory-control"
          ? effectPermissions.explicitControl
        : proposedRoute.kind === "control"
          ? effectPermissions.explicitControl
          : effectPermissions.generalState;
      if (proposedRoute.kind !== "conversation" && !proposedRouteAllowed) {
        await noteTurnSignal(ownerId, "safe-action-blocked");
      }
      const deterministicTimeControl = proposedRoute.kind === "control" &&
        (proposedRoute.action === "timezone" ||
          proposedRoute.action === "quiet-hours");
      const deterministicTaskMutation = proposedRoute.kind === "update-task" ||
        proposedRoute.kind === "complete-task";
      const deterministicTaskRead = proposedRoute.kind === "show-tasks";
      const route =
        proposedRouteAllowed &&
          (!requiresLiveState || deterministicTimeControl ||
            deterministicTaskMutation || deterministicTaskRead) &&
          !requiresAgentPlanning
          ? proposedRoute
          : ({ kind: "conversation" } as const);
      logger.info(
        "semantic_route_evaluated",
        "Proposal semantic Telegram privat selesai dipagari kode.",
        {
          route: proposedRoute.kind,
          operation: route.kind,
          outcome: understanding.intent,
          reason: [
            `payload-${understanding.task ? "t" : "n"}${understanding.task?.dueAt ? "d" : "n"}${understanding.task?.remindAt ? "r" : "n"}`,
            `explicit-${understanding.semanticOperation?.explicitness ?? "none"}`,
            `reference-${understanding.semanticOperation?.reference ?? "none"}`,
            `allowed-${proposedRouteAllowed ? "1" : "0"}`,
            `live-${requiresLiveState ? "1" : "0"}`,
            `planning-${requiresAgentPlanning ? "1" : "0"}`,
          ].join("."),
          decision: [
            `intent-${understanding.intent}`,
            `semantic-${understanding.semanticOperation?.domain ?? "none"}-${understanding.semanticOperation?.operation ?? "none"}`,
            `explicit-${understanding.semanticOperation?.explicitness ?? "none"}`,
            `reference-${understanding.semanticOperation?.reference ?? "none"}`,
            `payload-${understanding.task ? "t" : "n"}${understanding.task?.dueAt ? "d" : "n"}${understanding.task?.remindAt ? "r" : "n"}`,
            `proposed-${proposedRoute.kind}`,
            `selected-${route.kind}`,
            `allowed-${proposedRouteAllowed ? "1" : "0"}`,
            `live-${requiresLiveState ? "1" : "0"}`,
            `planning-${requiresAgentPlanning ? "1" : "0"}`,
          ].join("."),
          semanticDomain: understanding.semanticOperation?.domain ?? "none",
          semanticOperation:
            understanding.semanticOperation?.operation ?? "none",
          confidenceBucket: semanticConfidenceBucket(
            understanding.semanticOperation,
          ),
          semanticExplicitness:
            understanding.semanticOperation?.explicitness ?? "none",
          semanticReference:
            understanding.semanticOperation?.reference ?? "none",
          proposedRoute: proposedRoute.kind,
          selectedRoute: route.kind,
          proposedRouteAllowed,
          requiresLiveState,
          requiresAgentPlanning,
          taskPayloadPresent: Boolean(understanding.task),
          duePresent: Boolean(understanding.task?.dueAt),
          reminderPresent: Boolean(understanding.task?.remindAt),
        },
      );

      if (route.kind === "memory-control") {
        if (!(await runtimeIsCurrent(runtime))) return;
        await clearPending(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        if (route.action === "list") {
          await showMemories(ctx, ownerId, runtime);
          return;
        }
        if (route.action === "edit") {
          await ctx.reply(MEMORY_CHANGE_PROMPT);
          await history.append(ownerId, "harvy", MEMORY_CHANGE_PROMPT);
          return;
        }
        if (route.action !== "forget") return;
        if (isExplicitForgetAllMemories(
          text,
          understanding.semanticOperation,
        )) {
          await confirmMemoryWipe(ctx, ownerId, runtime);
          return;
        }

        const current = await memories.list(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        const matches = memoriesMatchingNaturalTarget(
          current,
          route.target,
          route.reference,
        );
        if (matches.length === 0) {
          const response =
            "Aku belum yakin bagian mana yang kamu maksud. Sebut aja topiknya—misalnya ‘lupain yang soal sekolah’.";
          await ctx.reply(response);
          await history.append(ownerId, "harvy", response);
          return;
        }

        if (!(await runtimeIsCurrent(runtime))) return;
        const stoppedRun = await discardAgentRunForMemoryChange(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        for (const match of matches) {
          await memories.forget(ownerId, match.id);
        }
        const label = naturalMemoryTargetLabel(
          route.target,
          route.reference,
        );
        const forgottenSubject = label === "yang tadi"
          ? "yang tadi"
          : `yang soal ${label}`;
        const response = [
          `Oke, ${forgottenSubject} sudah aku lupakan.`,
          ...(stoppedRun
            ? [
                "Pekerjaan planning yang memakai ingatan itu juga kuhentikan supaya salinan lamanya nggak dipakai lagi.",
              ]
            : []),
        ].join("\n\n");
        await ctx.reply(response);
        await history.append(ownerId, "harvy", response);
        return;
      }

      if (route.kind === "control") {
        if (!(await runtimeIsCurrent(runtime))) return;
        await clearPending(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        await showControl(ctx, ownerId, route.action, runtime, text);
        return;
      }

      if (route.kind === "show-tasks") {
        if (!(await runtimeIsCurrent(runtime))) return;
        await clearPending(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        await sendTaskList(ctx, ownerId, text);
        return;
      }

      if (route.kind === "complete-task") {
        if (!(await runtimeIsCurrent(runtime))) return;
        await clearPending(ownerId);
        const active = await tasks.listActive(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        const selected = resolveActiveTaskReference(active, route.target);
        if (!selected) {
          const response = active.length === 0
            ? "Belum ada tugas aktif yang bisa diselesaikan."
            : "Aku belum yakin tugas mana yang ingin kamu selesaikan. Sebut judulnya lebih spesifik.";
          await ctx.reply(response);
          await history.append(ownerId, "harvy", response);
          return;
        }
        if (!(await runtimeIsCurrent(runtime))) return;
        const completed = await tasks.complete(ownerId, selected.id);
        if (!completed) {
          const response =
            "Tugas itu sudah berubah sebelum sempat kuselesaikan. Buka daftar tugas agar aku memakai state terbaru.";
          await ctx.reply(response);
          await history.append(ownerId, "harvy", response);
          return;
        }
        const stableBody = `Tugas selesai\n${completed.title}`;
        const response = await presentPrivateOperation(ownerId, {
          kind: "task-completed",
          outcome: "success",
          userMessage: text,
          stableBody,
          fallbackText: taskCompletedHeading(completed.title),
        }, {
          context,
          style: profile.stylePreference,
          timeZone,
          runtime,
        });
        if (!(await runtimeIsCurrent(runtime))) return;
        await ctx.reply(response);
        await history.append(ownerId, "harvy", response);
        return;
      }

      if (route.kind === "update-task") {
        if (!(await runtimeIsCurrent(runtime))) return;
        await clearPending(ownerId);
        const active = await tasks.listActive(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        const selected = resolveActiveTaskReference(active, route.target);
        if (!selected) {
          const response = active.length === 0
            ? "Belum ada tugas aktif yang bisa diubah."
            : "Aku belum yakin tugas mana yang ingin kamu ubah. Sebut judulnya lebih spesifik.";
          await ctx.reply(response);
          await history.append(ownerId, "harvy", response);
          return;
        }
        if (
          route.task.remindAt &&
          (route.task.remindAt.getTime() <= Date.now() ||
            isInQuietHours(
              route.task.remindAt,
              timeZone,
              profile.quietHours,
            ))
        ) {
          const response = route.task.remindAt.getTime() <= Date.now()
            ? "Waktu pengingat itu sudah lewat. Pilih waktu yang masih akan datang."
            : "Waktu pengingat itu masuk jam tenangmu. Aku tidak menggesernya diam-diam; pilih waktu lain.";
          await ctx.reply(response);
          await history.append(ownerId, "harvy", response);
          return;
        }
        const updated = await tasks.updateSchedule(ownerId, selected.id, {
          ...(route.task.dueAt ? { dueAt: route.task.dueAt } : {}),
          ...(route.task.remindAt
            ? { reminderAt: route.task.remindAt }
            : {}),
          expected: {
            dueAt: selected.dueAt,
            reminderAt: selected.reminderAt,
          },
        });
        if (!updated) {
          const response =
            "Tugas itu berubah sebelum jadwal baru sempat disimpan. Coba ulangi agar aku memakai state terbaru.";
          await ctx.reply(response);
          await history.append(ownerId, "harvy", response);
          return;
        }
        const rollback = async (): Promise<void> => {
          await tasks.updateSchedule(ownerId, selected.id, {
            dueAt: selected.dueAt ? new Date(selected.dueAt) : null,
            reminderAt: selected.reminderAt
              ? new Date(selected.reminderAt)
              : null,
            expected: {
              dueAt: updated.dueAt,
              reminderAt: updated.reminderAt,
            },
          }).catch(() => null);
        };
        if (!(await runtimeIsCurrent(runtime))) {
          await rollback();
          return;
        }
        const stableBody = formatTask(updated, timeZone);
        const response = await presentPrivateOperation(ownerId, {
          kind: "task-due-updated",
          outcome: "success",
          userMessage: text,
          stableBody,
          fallbackText: [
            "Jadwal tugasnya sudah aku ubah.",
            "",
            stableBody,
          ].join("\n"),
        }, {
          context,
          style: profile.stylePreference,
          timeZone,
          runtime,
        });
        if (!(await runtimeIsCurrent(runtime))) {
          await rollback();
          return;
        }
        await ctx.reply(response, { reply_markup: taskActions(updated) });
        await history.append(ownerId, "harvy", response);
        return;
      }

      const explicitSmallStepSession =
        guidedSmallStep &&
        route.kind === "conversation";
      const offeredTask = !hasImageInput && effectPermissions.generalState &&
          !explicitSmallStepSession
        ? taskToOffer(understanding)
        : null;
      const styleEligible =
        !hasImageInput && effectPermissions.generalState &&
        !explicitSmallStepSession &&
        understanding.intent === "feeling" &&
        shouldAskStyle(profile) &&
        context.turns.length >= HISTORY_WINDOW &&
        !activeSession;
      const suggestedActions = explicitSmallStepSession
        ? (["start_small"] as const)
        : (understanding.suggestedActions ?? []);
      const proposedActions =
        !hasImageInput && effectPermissions.generalState &&
        !activeSession &&
        route.kind === "conversation" &&
        understanding.memories.length === 0 &&
        offeredTask === null &&
        !styleEligible &&
        !(profile.stylePreference === "listen" &&
          understanding.intent === "feeling")
          ? adaptiveActions(suggestedActions, {
              // Permintaan code-owned ini tetap relevan walau extractor salah
              // melabelinya sebagai task offer atau smalltalk.
              intent: explicitSmallStepSession
                ? "feeling"
                : understanding.intent,
              risk: triage.level,
              hasActiveSession: false,
              hasBlockingQuestion: false,
            })
          : [];
      const actionGoal =
        understanding.actionGoal?.trim() ||
        understanding.task?.title.trim() ||
        (explicitSmallStepSession ? text : "") ||
        (proposedActions[0] === "listen" ? "Menyimak cerita ini" : "");
      const plannedActions = actionGoal ? proposedActions : [];
      const explicitResponsePreference = inferExplicitResponsePreference(text);
      const authorizedMemoryRetractions =
        (understanding.memoryRetractions ?? []).filter((proposal) =>
          memoryRetractionAuthorized(text, proposal)
        );
      // Boundary lokal membuktikan bahwa seluruh turn adalah satu instruksi
      // presentasi. Gunakan canonical candidate-nya saja: kandidat model yang
      // memparafrasakan item yang sama tidak boleh menghasilkan write kedua
      // atau prompt consent tambahan.
      const proposedMemories: ExtractedMemory[] = explicitResponsePreference
        ? [explicitResponsePreference]
        : understanding.memories.filter((memory) =>
          !memoryCandidateConflictsWithRetractions(
            memory,
            authorizedMemoryRetractions,
          )
        );
      const retracted = !hasImageInput &&
          route.kind === "conversation" &&
          effectPermissions.explicitControl
        ? await retractCorrectedMemories(
            ownerId,
            text,
            understanding,
            runtime,
          )
        : { forgotten: [], acknowledgements: [] };
      if (retracted.forgotten.length > 0) {
        const forgottenIds = new Set(retracted.forgotten.map((item) => item.id));
        context = {
          ...context,
          memories: context.memories.filter((item) =>
            !forgottenIds.has(item.id)
          ),
          ...(context.retrieved
            ? {
                retrieved: context.retrieved.filter((item) =>
                  !item.sourceMemoryIds.some((id) => forgottenIds.has(id))
                ),
              }
            : {}),
        };
      }
      if (!(await runtimeIsCurrent(runtime))) return;
      // Sama seperti WhatsApp privat, fakta stabil dari current turn diproses
      // sebelum jalur agent dipilih. Kedalaman pekerjaan tidak membatalkan
      // authority onboarding atau instruksi preferensi yang eksplisit.
      const initialDerivedMemoryCandidates =
        !hasImageInput && effectPermissions.generalState
        ? proposedMemories.map((memory) => ({
            ...memory,
            ...deriveMemoryMetadata(memory.kind, memory.content, text),
            ...(storedUserTurn
              ? { sourceSequences: [storedUserTurn.sequence] }
              : {}),
          }))
        : [];
      const explicitResponsePreferenceForbidden = Boolean(
        explicitResponsePreference &&
          containsForbiddenMemorySecret(explicitResponsePreference.content),
      );
      // Instruksi presentasi explicit mempunyai authority sendiri. Jalur
      // remember umum tetap memerlukan proposal semantik dan evidence raw-turn.
      const explicitRememberSignaled = explicitResponsePreference === null &&
        understanding.memoryAction === "remember" &&
        understanding.taskAction === null &&
        understanding.task === null &&
        !memoryEvidenceConflictsWithRetractions(
          understanding.semanticOperation?.evidence,
          authorizedMemoryRetractions,
        ) &&
        !memoryEvidenceConflictsWithRetractions(
          understanding.semanticOperation?.target,
          authorizedMemoryRetractions,
        );
      const explicitRemember = explicitRememberSignaled &&
          effectPermissions.generalState
        ? explicitMemoryRememberAuthority(
            text,
            initialDerivedMemoryCandidates,
            understanding.semanticOperation,
          )
        : null;
      const exactExplicitFallback = explicitRemember &&
          !explicitRemember.forbiddenSecret &&
          explicitRemember.candidateIndexes.length === 0 &&
          (understanding.semanticOperation?.reference === "none" ||
            understanding.semanticOperation?.reference === "quoted")
        ? exactExplicitMemoryCandidate(
            explicitRemember.requestedText,
            proposedMemories,
          )
        : null;
      const derivedMemoryCandidates = exactExplicitFallback
        ? [{
            ...exactExplicitFallback,
            ...deriveMemoryMetadata(
              exactExplicitFallback.kind,
              exactExplicitFallback.content,
              text,
            ),
            ...(storedUserTurn
              ? { sourceSequences: [storedUserTurn.sequence] }
              : {}),
          }]
        : initialDerivedMemoryCandidates;
      const explicitlyConsented = new Set(
        exactExplicitFallback ? [0] : (explicitRemember?.candidateIndexes ?? []),
      );
      if (explicitResponsePreference && !explicitResponsePreferenceForbidden) {
        const index = derivedMemoryCandidates.findIndex((memory) =>
          memory.kind === explicitResponsePreference.kind &&
          memory.content.toLocaleLowerCase("id-ID") ===
            explicitResponsePreference.content.toLocaleLowerCase("id-ID")
        );
        if (index >= 0) explicitlyConsented.add(index);
      }
      const explicitAuthorityMissing =
        explicitRememberSignaled &&
        (!explicitRemember ||
          (!explicitRemember.forbiddenSecret &&
            explicitRemember.candidateIndexes.length === 0 &&
            !exactExplicitFallback));
      const explicitRequestUnresolved = Boolean(
        explicitRememberSignaled &&
        explicitRemember &&
          !explicitRemember.forbiddenSecret &&
          explicitRemember.candidateIndexes.length === 0 &&
          !exactExplicitFallback,
      );
      const rejectedAutomaticMemoryCandidate = derivedMemoryCandidates.some(
        (memory, index) => {
          if (explicitlyConsented.has(index)) return false;
          const grounded = groundedAutomaticMemoryContent(text, memory);
          return grounded === null ||
            containsForbiddenMemorySecret(memory.content) ||
            containsForbiddenMemorySecret(grounded);
        },
      );
      const memoryCandidates: AuthorizedMemoryCandidate[] =
        explicitRemember?.forbiddenSecret ||
          explicitAuthorityMissing ||
          explicitRequestUnresolved
          ? []
          : derivedMemoryCandidates
            .flatMap((memory, index): AuthorizedMemoryCandidate[] => {
              const explicitRequest = explicitlyConsented.has(index);
              if (explicitRequest) return [{ memory, explicitRequest: true }];
              // Keputusan yang sama dipakai probe lewat fungsi ini, supaya
              // laporan probe tidak pernah membenarkan klaim "sudah kucatat"
              // yang produksi tolak.
              const authorization = authorizeAutomaticMemory(text, memory);
              if (!authorization) return [];
              return [{
                memory: authorization.authorized,
                explicitRequest: false,
              }];
            })
            // Primary MemoryService menolak lagi. Filter ini juga mencegah
            // candidate credential membayar classifier privasi kedua.
            .filter(({ memory }) =>
              !containsForbiddenMemorySecret(memory.content));
      // Gerbang onboarding sudah memberi authority memori pada scope privat.
      // Model hanya mengusulkan isi; primary service tetap menolak credential,
      // duplikat, owner tersuspensi, dan write di luar batas penyimpanan.
      const storedMemories = await storeOrdinaryMemories(
        ownerId,
        memoryCandidates,
      );
      const remembered = explicitAuthorityMissing
        ? { ...storedMemories, uncommitted: true }
        : rejectedAutomaticMemoryCandidate
          ? { ...storedMemories, uncommitted: true }
          : storedMemories;
      if (!(await runtimeIsCurrent(runtime))) {
        await rollbackOrdinaryMemories(ownerId, remembered.saved);
        await telemetry.discardUndelivered?.(ownerId, currentTurnId());
        return;
      }
      const explicitCommitMissing =
        explicitlyConsented.size > remembered.explicitlyRemembered.length;
      const memoryAcknowledgements = [
        ...retracted.acknowledgements,
        ...remembered.acknowledgements.map(
          ({ item, operation, explicit }) => ({
            content: item.content,
            operation,
            explicit,
          }),
        ),
      ];

      // Sesudah policy dan commit selesai, balasan tetap disusun sebagai
      // percakapan utama—bukan struk penyimpanan. Kalimat yang membawa perasaan
      // sekaligus pekerjaan harus tetap menjawab perasaannya lebih dulu.
      // Perubahan task yang tidak ditangani route deterministik dihitung di
      // sini, bukan di dalam cabang agent. Sebelumnya ia dihitung sesudah
      // gerbang bentuk intent, sehingga tidak pernah dapat membuka gerbang itu
      // sendiri: intent `task` selalu ditolak lebih dulu, dan sinyal ini
      // menjadi tidak terjangkau persis pada bentuk giliran yang melahirkannya.
      const unhandledTaskChange = requestsUnhandledTaskChange(
        understanding.semanticOperation,
      );
      let reply: string | null = null;
      let debitDeliveredReply = true;
      let agentPending: Extract<Pending, { kind: "agent-input" }> | null = null;
      let agentCheckpointWarning: string | null = null;
      const agentIntent =
        understanding.intent === "request" || requiresAgentPlanning
          ? "request"
          : "question";
      try {
        if (
          explicitRemember?.forbiddenSecret ||
          explicitResponsePreferenceForbidden
        ) {
          reply = MEMORY_SECRET_REJECTION;
        } else if (explicitRequestUnresolved || explicitCommitMissing) {
          reply = MEMORY_SAVE_UNAVAILABLE;
        } else if (route.kind === "save-task") {
          // Task belum menjadi fakta sebelum primary store commit. Telegram
          // menyuarakan receipt melalui presentPrivateOperation sesudah save,
          // sama seperti WhatsApp privat; balasan bebas pre-commit dapat
          // mengarang status atau berkontradiksi dengan kartu task.
          reply = null;
        } else if (effectPermissions.generalState && isDirectTimeQuestion(text)) {
          reply = conversation.deterministicTimeReply(timeZone);
        } else if (
          effectPermissions.generalState &&
          (!engagedSession || requiresAgentPlanning) &&
          route.kind === "conversation" &&
          (intentAllowsAgentRuntime(understanding.intent) ||
            requiresLiveState ||
            requiresAgentPlanning ||
            unhandledTaskChange)
        ) {
          const globalRoute = selectGlobalRoute({
            intent: agentIntent,
            messageLength: text.length,
            needsStepByStep: understanding.needsStepByStep,
            assessment: understanding.routingAssessment ?? null,
            specializedFlow: requiresLiveState || unhandledTaskChange,
            guidedInteraction: guidedSmallStep,
            risk: triage.level,
          });
          const planningMode = globalRoute === "orchestrate"
            ? "orchestrate"
            : "tools";
          if (
            !hasImageInput &&
            !isModelIdentityQuestion(text) &&
            (globalRoute === "specialized" || globalRoute === "orchestrate") &&
            shouldUseAgentRuntime(
              understanding,
              requiresLiveState,
              requiresAgentPlanning,
              unhandledTaskChange,
            )
          ) {
            if (
              agentRuns &&
              requiresAgentPlanning &&
              planningMode === "orchestrate"
            ) {
              const started = await agentRuns.startActive({
                channel: "telegram",
                ownerId,
                request: text,
                mode: planningMode,
                intent: agentIntent,
                timeZone,
                style: profile.stylePreference,
                context: contextSnapshotForActiveRun(context),
                chatId: String(ctx.chat?.id ?? ownerId),
                turnId: randomUUID(),
              });
              if (started.status === "started") {
                activeRunLaunch = started.run;
                reply = renderRunAnchor(started.run);
              } else {
                reply = [
                  "Aku masih mengerjakan pekerjaan foreground yang tadi; permintaan baru ini belum kumulai.",
                  "",
                  renderRunAnchor(started.run),
                ].join("\n");
              }
              activeRunSurfaceReply = true;
            } else {
              const agentResult = await conversation.agent(
                text,
                planningMode,
                context,
                {
                  ...runtime,
                  ownerId,
                  channel: "telegram",
                  deliveryChatId: String(ctx.chat?.id ?? ownerId),
                  timeZone,
                  style: profile.stylePreference,
                  intent: agentIntent,
                  routingAssessment: understanding.routingAssessment ?? null,
                  memoryAcknowledgements,
                },
              );
              // Setiap run meninggalkan jejak, bukan hanya yang gagal. Tanpa
              // baris ini tidak ada cara membuktikan giliran mana yang masuk
              // Agent Runtime maupun capability mana yang benar-benar dipanggil.
              const agentFields = agentRunLogFields(agentResult, planningMode);
              if (agentResult.status === "stopped") {
                logger.warn(
                  "agent_run_stopped",
                  "Run agent dihentikan oleh guard runtime.",
                  {
                    ...agentFields,
                    outcome: agentResult.trace.at(-1)?.outcome,
                    count: agentResult.trace.length,
                  },
                );
              } else {
                logger.info(
                  "agent_run_completed",
                  "Run agent selesai.",
                  {
                    ...agentFields,
                    intent: agentIntent,
                    toolNeed: understanding.routingAssessment?.toolNeed ?? "none",
                  },
                );
              }
              // `needs_input` adalah prompt model yang benar-benar dikirim,
              // jadi usage-nya diselesaikan setelah delivery seperti final.
              if (
                agentResult.status === "stopped" ||
                agentResult.status === "needs_approval"
              ) {
                debitDeliveredReply = false;
                await telemetry.discardUndelivered?.(ownerId, currentTurnId());
              }
              if (agentResult.status === "needs_input") {
                agentPending = {
                  kind: "agent-input",
                  request: text,
                  mode: planningMode,
                  intent: agentIntent,
                  checkpoint: agentResult.checkpoint,
                  revision: null,
                  acceptAnswersAfterUpdateId: latestTelegramUpdateId,
                };
              }
              // Penghentian dijelaskan model dengan suara Harvy bila masih
              // mungkin; teks deterministik di bawah hanya jaring terakhir.
              const explained = agentResult.status === "stopped" &&
                agentStopDeservesExplanation(agentResult.reason)
                ? await conversation.explainAgentStop(text, agentResult, context, {
                    ...runtime,
                    ownerId,
                    timeZone,
                    style: profile.stylePreference,
                    intent: agentIntent,
                  })
                : null;
              reply = explained ??
                (agentResult.status === "completed"
                ? agentResult.reply
                : agentResult.status === "needs_input"
                  ? agentResult.prompt
                  : agentResult.status === "needs_approval"
                    ? agentApprovalStopMessage()
                    : agentStopMessage(agentResult.reason));
            }
          } else {
            reply = await conversation.reply(
              text,
              understanding,
              context,
              profile.stylePreference,
              triage,
              null,
              false,
              {
                ...runtime,
                ownerId,
                timeZone,
                session: null,
                plannedActionLabels: plannedActions.map(adaptiveActionLabel),
                routingAssessment: understanding.routingAssessment ?? null,
                memoryAcknowledgements,
              },
            );
          }
        } else {
          reply = await conversation.reply(
            text,
            understanding,
            context,
            profile.stylePreference,
            triage,
            null,
            false,
            {
              ...runtime,
              ownerId,
              timeZone,
              session: effectPermissions.generalState ? engagedSession : null,
              plannedActionLabels: plannedActions.map(adaptiveActionLabel),
              routingAssessment: understanding.routingAssessment ?? null,
              memoryAcknowledgements,
            },
          );
        }
        if (reply !== null) {
          reply = normalizeTelegramText(reply);
          reply = withEmergencyAvailability(reply, triage);
          reply = await guardReply(
            ownerId,
            text,
            reply,
            triage,
            context,
            runtime,
          );
        }
      } catch (error) {
        if (!(await runtimeIsCurrent(runtime))) {
          await rollbackOrdinaryMemories(ownerId, remembered.saved);
          await telemetry.discardUndelivered?.(ownerId, currentTurnId());
          return;
        }
        logger.error(
          "model_reply_failed",
          "Penyusunan balasan model gagal.",
          error,
        );
        debitDeliveredReply = false;
        await telemetry.discardUndelivered?.(ownerId, currentTurnId());
        if (!(await runtimeIsCurrent(runtime))) {
          await rollbackOrdinaryMemories(ownerId, remembered.saved);
          return;
        }
        if (triage.level !== "biasa") {
          await noteTurnSignal(ownerId, "safety-fallback");
          reply = safeFallbackReply(triage.level);
        } else if (memoryAcknowledgements.length > 0) {
          // Model gagal memilih wording, tetapi commit sudah nyata. Beri satu
          // fallback manusiawi dan tetap biarkan delivery guard menentukan
          // apakah primary write dipertahankan atau di-rollback.
          reply = memoryLifecycleFallbackAcknowledgement(
            retracted,
            remembered,
          );
        } else if (route.kind !== "save-task") {
          const failure = aiFailureMessage(error);
          await ctx.reply(failure);
          await history.append(ownerId, "harvy", failure);
          return;
        }
        // Untuk tugas, pencatatannya tetap diteruskan. Kehilangan kalimat
        // pembuka jauh lebih ringan daripada kehilangan pekerjaan pengguna.
      }

      if (!(await runtimeIsCurrent(runtime))) {
        await rollbackOrdinaryMemories(ownerId, remembered.saved);
        await telemetry.discardUndelivered?.(ownerId, currentTurnId());
        return;
      }
      if (reply) {
        reply = withoutUnconfirmedMemoryRecordClaims(reply) ||
          "Aku dengar koreksimu.";
        if (retracted.acknowledgements.length === 0) {
          reply = withoutUnconfirmedMemoryDeletionClaims(reply) ||
            "Aku dengar koreksimu.";
        } else if (!activeRunLaunch && !replyClaimsMemoryDeletion(reply)) {
          reply = [
            reply.trimEnd(),
            "",
            memoryRetractionFallbackAcknowledgement(retracted),
          ].join("\n");
        }
      }
      if (
        reply &&
        remembered.acknowledgements.length > 0 &&
        !activeRunLaunch
      ) {
        reply = normalizeMemoryWriteEmoji(reply);
      }
      if (
        reply &&
        remembered.acknowledgements.length === 0 &&
        remembered.uncommitted &&
        replyAcknowledgesMemoryWrite(reply)
      ) {
        reply = withoutUnconfirmedMemoryWriteClaims(reply) ||
          "Aku dengar yang kamu ceritakan.";
      }
      if (
        activeRunLaunch &&
        (remembered.acknowledgements.length > 0 ||
          retracted.acknowledgements.length > 0)
      ) {
        const notice = memoryLifecycleFallbackAcknowledgement(
          retracted,
          remembered,
        );
        activeRunMemoryNotice = remembered.acknowledgements.length > 0
          ? normalizeMemoryWriteEmoji(notice)
          : notice;
      } else if (
        reply &&
        remembered.acknowledgements.length > 0 &&
        !replyAcknowledgesMemoryWrite(reply)
      ) {
        reply = [
          reply.trimEnd(),
          "",
          memoryFallbackAcknowledgement(remembered),
        ].join("\n");
      }
      let memoryNoticeDelivered = remembered.saved.length === 0;
      const memoryNoticeItems = activeRunMemoryNotice
        ? []
        : memoryNoticeItemsForReply(reply, remembered);

      let adaptiveKeyboard: InlineKeyboard | undefined;

      if (
        reply &&
        plannedActions.length > 0 &&
        remembered.saved.length === 0 &&
        (!replyHasBlockingQuestion(reply) || explicitSmallStepSession)
      ) {
        adaptiveKeyboard = adaptiveActionButtons(
          actionOffers.set(ownerId, plannedActions, actionGoal),
        );
      }

      if (reply) {
        let replyDelivered = false;
        const deliveredReplyBubbles: string[] = [];
        const onBubbleDelivered = (deliveredText: string): void => {
          replyDelivered = true;
          deliveredReplyBubbles.push(deliveredText);
          // Acknowledgement kontekstual dapat berada sebelum bubble terakhir.
          // Setelah pengguna benar-benar melihat klaim write itu, rollback pada
          // kegagalan bubble lanjutan justru akan membuat klaim tersebut palsu.
          if (
            remembered.acknowledgements.length > 0 &&
            replyAcknowledgesMemoryWrite(deliveredText)
          ) {
            memoryNoticeDelivered = true;
          }
        };
        try {
          let deliveredBySession = false;
          if (
            engagedSession &&
            effectPermissions.generalState &&
            route.kind === "conversation"
          ) {
            const sessionSignal = authorizedSessionSignal(
              text,
              understanding.sessionSignal,
              engagedSession,
              understanding.semanticOperation,
            );
            await sessions.progressAfterDelivery(
              ownerId,
              sessionSignal,
              engagedSession.id,
              async (next) => {
                deliveredBySession = true;
                if (!(await runtimeIsCurrent(runtime))) {
                  throw new ReplyInterruptedError("");
                }
                await sendReply(
                  ctx,
                  reply ?? "",
                  memoryNoticeItems,
                  remembered.saved.length === 0 && next
                    ? sessionActions(next)
                    : undefined,
                  onBubbleDelivered,
                  runtime,
                );
                replyDelivered = true;
                memoryNoticeDelivered = true;
                if (debitDeliveredReply) {
                  await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
                }
              },
            );
            if (sessionSignal) {
              await recordSessionSignal(ownerId, sessionSignal);
            }
          }
          if (!deliveredBySession) {
            if (!(await runtimeIsCurrent(runtime))) {
              await rollbackOrdinaryMemories(ownerId, remembered.saved);
              await telemetry.discardUndelivered?.(ownerId, currentTurnId());
              return;
            }
            if (activeRunLaunch && activeRunMemoryNotice) {
              await ctx.reply(activeRunMemoryNotice);
              memoryNoticeDelivered = true;
            }
            const sent = activeRunLaunch
              ? await sendRunAnchor(ctx, reply, runtime)
              : await sendReply(
                ctx,
                reply,
                memoryNoticeItems,
                adaptiveKeyboard,
                onBubbleDelivered,
                runtime,
              );
            replyDelivered = true;
            memoryNoticeDelivered = true;
            if (activeRunLaunch) {
              if (!sent) {
                throw new Error("Run Anchor tidak menghasilkan message ID.");
              }
              activeRunLaunch = await agentRuns!.attachActiveAnchor(
                "telegram",
                ownerId,
                activeRunLaunch.runId,
                String(sent.messageId),
              );
              await setActiveRunAnchorPinned(activeRunLaunch, true);
              // Anchor yang sudah diakui transport tetap harus terikat ke
              // record. Namun work backend jangan diluncurkan bila pesan baru
              // menyupersesi turn persis selama send berlangsung.
              activeRunLaunched = true;
              if (await runtimeIsCurrent(runtime)) {
                launchActiveAgentWork(activeRunLaunch);
              } else {
                try {
                  const stopped = await agentRuns!.failActive(
                    "telegram",
                    ownerId,
                    activeRunLaunch.runId,
                    "superseded_before_launch",
                  );
                  if (stopped) await updateActiveRunAnchor(stopped);
                } catch (error) {
                  logger.error(
                    "superseded_active_run_cleanup_failed",
                    "Run yang disupersesi setelah Anchor terkirim gagal dihentikan.",
                    error,
                  );
                }
              }
            }
            if (agentPending) {
              try {
                await saveAgentPending(ownerId, agentPending);
              } catch (error) {
                agentCheckpointWarning = await abandonAgentRunAfterDelivery(
                  ctx,
                  ownerId,
                  agentPending.checkpoint.runId,
                  error,
                );
              }
            }
            if (debitDeliveredReply) {
              await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
            }
          }
        } catch (error) {
          if (activeRunLaunch && !activeRunLaunched) {
            try {
              await agentRuns?.failActive(
                "telegram",
                ownerId,
                activeRunLaunch.runId,
                "anchor_delivery_failed",
              );
            } catch (cleanupError) {
              logger.error(
                "active_run_anchor_cleanup_failed",
                "Run aktif gagal ditandai setelah Run Anchor tidak terkirim.",
                cleanupError,
              );
            }
          }
          if (error instanceof ReplyInterruptedError) {
            actionOffers.clear(ownerId);
            if (!memoryNoticeDelivered) {
              await rollbackOrdinaryMemories(ownerId, remembered.saved);
            }
            if (error.deliveredText) {
              if (debitDeliveredReply) {
                await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
              }
              await history.append(ownerId, "harvy", error.deliveredText);
              await memories.markUsed(context.memories);
            } else {
              await telemetry.discardUndelivered?.(
                ownerId,
                currentTurnId(),
              );
            }
            return;
          }
          if (
            error instanceof PartialReplyDeliveryError &&
            error.deliveredText &&
            agentPending
          ) {
            const warning = await abandonAgentRunAfterDelivery(
              ctx,
              ownerId,
              agentPending.checkpoint.runId,
              error.cause,
            );
            if (!memoryNoticeDelivered) {
              await rollbackOrdinaryMemories(ownerId, remembered.saved);
            }
            if (debitDeliveredReply) {
              await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
            }
            await history.append(ownerId, "harvy", error.deliveredText);
            if (warning) await history.append(ownerId, "harvy", warning);
            await memories.markUsed(context.memories);
            return;
          }
          if (
            error instanceof PartialReplyDeliveryError &&
            error.deliveredText
          ) {
            actionOffers.clear(ownerId);
            if (!memoryNoticeDelivered) {
              await rollbackOrdinaryMemories(ownerId, remembered.saved);
            }
            if (debitDeliveredReply) {
              await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
            }
            await history.append(ownerId, "harvy", error.deliveredText);
            await memories.markUsed(context.memories);
            logger.warn(
              "telegram_reply_partially_delivered",
              "Balasan Telegram berhenti setelah sebagian bubble terkirim.",
              {
                errorType: error.cause instanceof Error
                  ? error.cause.name
                  : "unknown",
              },
            );
            return;
          }
          if (!replyDelivered) {
            await telemetry.discardUndelivered?.(ownerId, currentTurnId());
          }
          if (!memoryNoticeDelivered) {
            await rollbackOrdinaryMemories(ownerId, remembered.saved);
          }
          throw error;
        }
        await history.append(
          ownerId,
          "harvy",
          deliveredReplyBubbles.join("\n\n") || reply.trim(),
        );
        if (agentCheckpointWarning) {
          await history.append(ownerId, "harvy", agentCheckpointWarning);
        }
        await memories.markUsed(context.memories);

        // Catatan tersembunyi tidak dibuat dari satu false positive dukungan,
        // hasil triase yang gagal, atau balasan yang belum berhasil dikirim.
        if (!(await runtimeIsCurrent(runtime))) return;
        if (triage.certain && triage.level === "bahaya") {
          await insights.record(
            ownerId,
            triage.level,
            triage.summary,
            reply.slice(0, 160),
          );
        }
      } else if (route.kind !== "save-task") {
        await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      }

      if (!(await runtimeIsCurrent(runtime))) return;

      // Satu pending saja per pemilik. Klarifikasi agent yang sudah terlihat
      // menang atas tawaran tugas/memori/gaya agar checkpoint tidak tertimpa.
      if (activeRunSurfaceReply) return;
      if (agentPending) return;

      if (route.kind === "save-task") {
        await clearPending(ownerId);
        // Kartu tugas menyusul balasan, tanpa kalimat pembuka kedua. Kalau
        // balasannya gagal dibuat, kartunya yang membawa kalimatnya.
        try {
          const taskDelivered = await saveTask(
            ctx,
            ownerId,
            route.task,
            reply ? undefined : taskSavedHeading(),
            runtime,
            {
              userMessage: text,
              context,
              style: profile.stylePreference,
            },
          );
          if (!taskDelivered) {
            if (!memoryNoticeDelivered) {
              await rollbackOrdinaryMemories(ownerId, remembered.saved);
            }
            return;
          }
          if (!reply) {
            await sendMemoryNotes(ctx, memoryNoticeItems);
            memoryNoticeDelivered = true;
            if (debitDeliveredReply) {
              await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
            }
            await memories.markUsed(context.memories);
          }
        } catch (error) {
          if (!memoryNoticeDelivered) {
            await rollbackOrdinaryMemories(ownerId, remembered.saved);
          }
          throw error;
        }
        if (!(await runtimeIsCurrent(runtime))) return;
        return;
      }

      if (!reply && memoryNoticeItems.length > 0) {
        try {
          await sendMemoryNotes(ctx, memoryNoticeItems);
          memoryNoticeDelivered = true;
        } catch (error) {
          await rollbackOrdinaryMemories(ownerId, remembered.saved);
          throw error;
        }
      }

      if (!(await runtimeIsCurrent(runtime))) return;

      // Pekerjaan yang tersirat di balik cerita ditawarkan, tidak dicatat diam-diam.
      if (
        offeredTask && reply && remembered.saved.length === 0 &&
        plannedActions.length === 0 && !replyHasBlockingQuestion(reply)
      ) {
        const confirmationToken = await setPending(ownerId, {
          kind: "confirm-task",
          task: offeredTask,
        });
        if (!(await runtimeIsCurrent(runtime))) {
          pending.take(ownerId, confirmationToken);
          return;
        }
        const offerText =
          `Mau aku catat “${offeredTask.title}” biar nggak perlu kamu ingat-ingat?`;
        try {
          await ctx.reply(offerText, {
            reply_markup: confirmActions(confirmationToken),
          });
        } catch (error) {
          pending.take(ownerId, confirmationToken);
          throw error;
        }
        await history.append(ownerId, "harvy", offerText);
        return;
      }

      if (!(await runtimeIsCurrent(runtime))) return;
      if (pending.peek(ownerId)?.kind !== "agent-input") {
        await clearPending(ownerId);
      }

      // Ditanyakan setelah percakapan punya isi, bukan setelah giliran pertama.
      // Pada uji pertama pesan pembukanya cuma "p", dan pertanyaan gaya sudah
      // muncul di detik berikutnya — pengguna belum punya bahan menjawabnya.
      if (!(await runtimeIsCurrent(runtime))) return;
      await askStyleOnce(
        ctx,
        ownerId,
        styleEligible && !adaptiveKeyboard &&
          !replyHasBlockingQuestion(reply ?? ""),
        runtime,
      );
    } finally {
      if (activeRunLaunch && !activeRunLaunched) {
        await failUnlaunchedActiveRun(activeRunLaunch);
      }
      // Model peringkas berjalan setelah balasan utama selesai. Tidak di-await:
      // kegagalan atau timeout-nya tidak boleh membuat pengguna menunggu.
      void history.compact(ownerId);
    }
  }

  /**
   * Memeriksa rancangan balasan untuk giliran yang berisiko.
   *
   * Kegagalan atau bentuk yang tidak sah memakai balasan aman yang sudah
   * ditinjau. Jalur berisiko tidak boleh menjadikan gangguan pemeriksa sebagai
   * lampu hijau diam-diam.
   */
  async function guardReply(
    ownerId: string,
    message: string,
    reply: string,
    triage: RiskAssessment,
    context: HarvyContext,
    runtime: ConversationRuntime = {},
  ): Promise<string> {
    if (!needsConditionalReplyReview(triage.routing)) return reply;

    runtime.progress?.report({ phase: "checking", detail: "consistency" });
    let verdict: boolean | null = null;
    try {
      verdict = await conversation.reviewReply(
        message,
        reply,
        triage,
        ownerId,
        context,
        runtime.signal,
      );
    } catch (error) {
      logger.error(
        "reply_review_failed",
        "Pemeriksaan balasan gagal.",
        error,
      );
      await noteTurnSignal(ownerId, "safety-fallback");
      return safeFallbackReply(triage.level);
    }

    if (verdict === false) {
      logger.warn(
        "reply_review_rejected",
        "Balasan ditolak pemeriksaan keselamatan; balasan pengganti dipakai.",
      );
    }
    if (verdict === true) return reply;
    await noteTurnSignal(ownerId, "safety-fallback");
    return safeFallbackReply(triage.level);
  }

  async function contextFor(
    ownerId: string,
    message: string,
  ): Promise<HarvyContext> {
    const [relevant, conversationContext] = await Promise.all([
      memories.relevantTo(ownerId, message),
      history.context(ownerId),
    ]);

    return {
      summary: conversationContext.summary,
      turns: conversationContext.turns,
      memories: relevant,
      interactions: interactionContext.read(interactionScope(ownerId)),
    };
  }

  async function handleLocalActiveRunControl(
    ctx: Context,
    ownerId: string,
    text: string,
    runtime: ConversationRuntime,
  ): Promise<boolean> {
    if (!agentRuns) return false;
    const run = await activeRunForIngress(ownerId);
    if (!run) return false;
    const relation = classifyRunMailboxLocally({
      text,
      run,
      quotedMessageId: quotedMessageId(ctx),
    });
    if (relation !== "status_query" && relation !== "cancel") return false;
    if (isTerminalActiveRun(run)) {
      if (relation !== "status_query") return false;
      await noteTurnSignal(ownerId, "deterministic-fast-path");
      await appendUserHistory(ownerId, text, runtime);
      const response = renderRunAnchor(run);
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return true;
    }

    await noteTurnSignal(ownerId, "deterministic-fast-path");
    await appendUserHistory(ownerId, text, runtime);
    if (relation === "status_query") {
      const response = renderRunAnchor(run);
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return true;
    }

    const routed = await agentRuns.routeActiveMessage({
      channel: "telegram",
      ownerId,
      runId: run.runId,
      kind: "cancel",
      content: text,
      sourceMessageId: sourceMessageId(ctx),
      ingressUpdateId: ctx.update.update_id,
    });
    if (routed.status === "duplicate" || routed.status === "conflict") {
      return true;
    }
    if (routed.status === "capacity_exceeded") {
      const response = runMailboxCapacityNotice();
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return true;
    }
    if (routed.status !== "accepted") return false;
    abortActiveAgentWork(ownerId, run.runId);
    await updateActiveRunAnchor(routed.run);
    const response = runCancellationAcknowledgement(routed.committedEffects);
    await ctx.reply(response);
    await history.append(ownerId, "harvy", response);
    return true;
  }

  async function handleActiveRunMailboxAfterSafety(
    ctx: Context,
    ownerId: string,
    text: string,
    runtime: ConversationRuntime = {},
  ): Promise<boolean> {
    if (!agentRuns) return false;
    const run = await activeRunForIngress(ownerId);
    if (!(await runtimeIsCurrent(runtime))) throw new ReplyInterruptedError("");
    if (!run || isTerminalActiveRun(run)) return false;
    const relation = classifyRunMailboxLocally({
      text,
      run,
      quotedMessageId: quotedMessageId(ctx),
    });
    if (
      relation === "independent_chat" ||
      relation === "status_query" ||
      relation === "cancel"
    ) {
      return false;
    }
    const kind = mailboxKindForRelation(relation);
    if (!kind) return false;
    if (!(await runtimeIsCurrent(runtime))) throw new ReplyInterruptedError("");
    const routed = await agentRuns.routeActiveMessage({
      channel: "telegram",
      ownerId,
      runId: run.runId,
      kind,
      content: text,
      sourceMessageId: sourceMessageId(ctx),
      ...(relation === "answer_to_run" && run.pendingQuestion
        ? { questionId: run.pendingQuestion.questionId }
        : {}),
      ingressUpdateId: ctx.update.update_id,
    });
    if (!(await runtimeIsCurrent(runtime))) throw new ReplyInterruptedError("");
    if (routed.status === "duplicate" || routed.status === "conflict") {
      return true;
    }
    if (routed.status === "capacity_exceeded") {
      const response = runMailboxCapacityNotice();
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return true;
    }
    if (routed.status !== "accepted") return false;
    const response = runUpdateAcknowledgement(relation);
    await ctx.reply(response);
    await history.append(ownerId, "harvy", response);
    if (!(await runtimeIsCurrent(runtime))) return true;
    await updateActiveRunAnchor(routed.run);
    if (routed.run.status === "queued") launchActiveAgentWork(routed.run);
    return true;
  }

  async function activeRunForIngress(
    ownerId: string,
  ): Promise<ActiveAgentRun | null> {
    if (!agentRuns) return null;
    const expired = await agentRuns.expireWaitingActive("telegram", ownerId);
    if (expired) {
      await updateActiveRunAnchor(expired);
      return expired;
    }
    return agentRuns.loadForegroundActive("telegram", ownerId);
  }

  async function discardAgentRunForMemoryChange(
    ownerId: string,
  ): Promise<boolean> {
    if (!agentRuns) return false;
    const current = await agentRuns.loadActive("telegram", ownerId);
    let stopped = false;
    let terminal = current;
    if (current && !isTerminalActiveRun(current)) {
      const routed = await agentRuns.routeActiveMessage({
        channel: "telegram",
        ownerId,
        runId: current.runId,
        kind: "cancel",
        content: "Data konteks yang dipakai run dicabut oleh pengguna.",
        sourceMessageId: `data-control:${randomUUID()}`,
      });
      if (routed.status === "accepted") {
        terminal = routed.run;
        stopped = true;
      }
      const work = activeAgentWork.get(ownerId);
      if (work?.runId === current.runId) {
        work.controller.abort();
        await work.promise;
      }
      if (stopped && terminal) await updateActiveRunAnchor(terminal);
    }

    await agentRuns.discardContextData("telegram", ownerId);
    return stopped;
  }

  function isTerminalActiveRun(run: ActiveAgentRun): boolean {
    return run.status === "completed" ||
      run.status === "partial" ||
      run.status === "failed" ||
      run.status === "cancelled";
  }

  function launchActiveAgentWork(run: ActiveAgentRun): void {
    if (!agentRuns || stoppingActiveAgentWork) return;
    const existing = activeAgentWork.get(run.ownerId);
    if (existing?.runId === run.runId) return;
    if (existing) {
      logger.warn(
        "active_run_foreground_conflict",
        "Work lane menolak foreground kedua untuk pemilik yang sama.",
      );
      return;
    }
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => withUsageAttribution(
        {
          turnId: run.turnId,
          subjectKind: "private",
          channel: "telegram",
          actorAliases: [],
        },
        async () => {
          await executeActiveAgentWork(run.ownerId, run.runId, controller);
        },
      ))
      .catch(async (error: unknown) => {
        logger.error(
          "active_run_work_failed",
          "Work lane active AgentRun gagal.",
          error,
        );
        try {
          await telemetry.discardUndelivered?.(run.ownerId, run.turnId);
        } catch (telemetryError) {
          logger.warn(
            "active_run_usage_discard_failed",
            "Kandidat usage work lane yang gagal belum dapat dibatalkan.",
            { telemetryError },
          );
        }
        try {
          const failed = await agentRuns.failActive(
            "telegram",
            run.ownerId,
            run.runId,
            "work_lane_failed",
          );
          if (failed) await updateActiveRunAnchor(failed);
        } catch (stateError) {
          logger.error(
            "active_run_failure_state_failed",
            "Kegagalan work lane tidak dapat dipersistenkan.",
            stateError,
          );
        }
      })
      .finally(async () => {
        const current = activeAgentWork.get(run.ownerId);
        if (current?.promise !== promise) return;
        activeAgentWork.delete(run.ownerId);
        if (stoppingActiveAgentWork || !agentRuns) return;
        try {
          const latest = await agentRuns.loadForegroundActive(
            "telegram",
            run.ownerId,
          );
          // Jawaban dapat tiba tepat ketika worker waiting_input sedang keluar.
          // Kalau launch pada jalur ingress melihat worker lama, finally inilah
          // yang mengambil ulang queued work agar wake-up tidak hilang.
          if (latest?.runId === run.runId && latest.status === "queued") {
            launchActiveAgentWork(latest);
          }
        } catch (error) {
          logger.error(
            "active_run_wakeup_check_failed",
            "Status queued active AgentRun tidak dapat diperiksa setelah worker selesai.",
            error,
          );
        }
      });
    activeAgentWork.set(run.ownerId, {
      runId: run.runId,
      controller,
      promise,
    });
  }

  async function executeActiveAgentWork(
    ownerId: string,
    runId: string,
    controller: AbortController,
  ): Promise<void> {
    if (!agentRuns) return;
    for (let revisionPass = 0; revisionPass < 8; revisionPass += 1) {
      const attempt = await agentRuns.beginActiveAttempt(
        "telegram",
        ownerId,
        runId,
      );
      if (!attempt) return;
      await updateActiveRunAnchor(attempt.run);
      const result = await conversation.agent(
        attempt.run.initialRequest,
        attempt.run.mode,
        contextFromActiveRun(attempt.run),
        {
          ownerId,
          channel: "telegram",
          timeZone: attempt.run.timeZone,
          style: attempt.run.style,
          intent: attempt.run.intent,
          runId,
          signal: controller.signal,
          isCurrent: () => agentRuns.isActiveAttemptCurrent(
            "telegram",
            ownerId,
            runId,
            attempt.inputRevision,
          ),
          ...(attempt.initialUserInputs
            ? { initialAgentInputs: attempt.initialUserInputs }
            : {}),
        },
        attempt.checkpoint,
        attempt.answer,
      );
      await activeRunIngress.waitForIdle(runId);

      if (result.status === "completed") {
        try {
          const completed = await agentRuns.commitActiveFinal(
            {
              channel: "telegram",
              ownerId,
              runId,
              inputRevision: attempt.inputRevision,
              checkpoint: result.checkpoint,
              reply: result.reply,
            },
            async () => {
              await activeRunIngress.waitForIdle(runId);
              return sendActiveRunMessage(attempt.run, result.reply);
            },
          );
          await updateActiveRunAnchor(completed);
          await history.append(ownerId, "harvy", result.reply);
          await markDeliveredForOwner(ownerId, attempt.run.turnId);
          return;
        } catch (error) {
          if (error instanceof ActiveAgentRunStaleError) {
            const queued = await agentRuns.requeueStaleActive(
              "telegram",
              ownerId,
              runId,
              attempt.inputRevision,
              result.checkpoint,
            );
            if (queued?.status === "queued") continue;
          }
          await telemetry.discardUndelivered?.(ownerId, attempt.run.turnId);
          const latest = await agentRuns.loadActive("telegram", ownerId);
          if (latest) await updateActiveRunAnchor(latest);
          throw error;
        }
      }

      if (result.status === "needs_input") {
        try {
          const waiting = await agentRuns.commitActiveQuestion(
            {
              channel: "telegram",
              ownerId,
              runId,
              inputRevision: attempt.inputRevision,
              checkpoint: result.checkpoint,
              prompt: result.prompt,
              acceptAnswersAfterUpdateId: latestTelegramUpdateId,
            },
            async () => {
              await activeRunIngress.waitForIdle(runId);
              return sendActiveRunMessage(attempt.run, result.prompt);
            },
          );
          await updateActiveRunAnchor(waiting);
          await history.append(ownerId, "harvy", result.prompt);
          await markDeliveredForOwner(ownerId, attempt.run.turnId);
          return;
        } catch (error) {
          if (error instanceof ActiveAgentRunStaleError) {
            const queued = await agentRuns.requeueStaleActive(
              "telegram",
              ownerId,
              runId,
              attempt.inputRevision,
              result.checkpoint,
            );
            if (queued?.status === "queued") continue;
          }
          await telemetry.discardUndelivered?.(ownerId, attempt.run.turnId);
          const latest = await agentRuns.loadActive("telegram", ownerId);
          if (latest) await updateActiveRunAnchor(latest);
          throw error;
        }
      }

      if (result.status === "needs_approval") {
        const failed = await agentRuns.failActive(
          "telegram",
          ownerId,
          runId,
          "write_approval_unavailable",
        );
        await telemetry.discardUndelivered?.(ownerId, attempt.run.turnId);
        if (failed) await updateActiveRunAnchor(failed);
        return;
      }

      logger.warn(
        "active_run_stopped",
        "Active AgentRun Telegram dihentikan oleh guard runtime.",
        {
          reason: result.reason,
          outcome: result.trace.at(-1)?.outcome,
          count: result.trace.length,
        },
      );

      const settled = await agentRuns.settleActiveStopped(
        "telegram",
        ownerId,
        runId,
        attempt.inputRevision,
        result,
        stoppingActiveAgentWork && controller.signal.aborted,
      );
      if (settled?.status === "queued" && !controller.signal.aborted) {
        await updateActiveRunAnchor(settled);
        continue;
      }
      await telemetry.discardUndelivered?.(ownerId, attempt.run.turnId);
      if (settled) await updateActiveRunAnchor(settled);
      return;
    }

    const exhausted = await agentRuns.loadActive("telegram", ownerId);
    await telemetry.discardUndelivered?.(
      ownerId,
      exhausted?.runId === runId ? exhausted.turnId : null,
    );
    const failed = await agentRuns.failActive(
      "telegram",
      ownerId,
      runId,
      "revision_limit",
    );
    if (failed) await updateActiveRunAnchor(failed);
  }

  async function failUnlaunchedActiveRun(run: ActiveAgentRun): Promise<void> {
    try {
      await agentRuns?.failActive(
        "telegram",
        run.ownerId,
        run.runId,
        "surface_not_delivered",
      );
    } catch (error) {
      logger.error(
        "active_run_surface_cleanup_failed",
        "Run aktif tanpa Run Anchor belum dapat ditandai gagal.",
        error,
      );
    }
  }

  async function sendActiveRunMessage(
    run: ActiveAgentRun,
    text: string,
  ): Promise<{ externalId: string; bindingExternalId: string }> {
    const messageIds: string[] = [];
    for (const bubble of splitReplyBubbles(text)) {
      const sent = await bot.api.sendMessage(telegramChatId(run.anchor.chatId), bubble);
      messageIds.push(String(sent.message_id));
    }
    if (messageIds.length === 0) {
      throw new Error("Active AgentRun tidak menghasilkan bubble delivery.");
    }
    return {
      externalId: messageIds.join(","),
      bindingExternalId: messageIds.at(-1)!,
    };
  }

  async function updateActiveRunAnchor(
    run: ActiveAgentRun,
    ensurePinned = false,
  ): Promise<void> {
    const text = renderRunAnchor(run);
    const messageId = numericMessageId(run.anchor.messageId);
    if (messageId !== null) {
      try {
        await bot.api.editMessageText(
          telegramChatId(run.anchor.chatId),
          messageId,
          text,
        );
        if (isTerminalActiveRun(run)) {
          await setActiveRunAnchorPinned(run, false);
        } else if (ensurePinned) {
          await setActiveRunAnchorPinned(run, true);
        }
        return;
      } catch (error) {
        if (isTelegramMessageNotModified(error)) {
          if (isTerminalActiveRun(run)) {
            await setActiveRunAnchorPinned(run, false);
          } else if (ensurePinned) {
            await setActiveRunAnchorPinned(run, true);
          }
          return;
        }
        logger.warn(
          "active_run_anchor_edit_failed",
          "Run Anchor gagal diedit; anchor lama harus dihapus sebelum pengganti dikirim.",
          { error },
        );
        try {
          await bot.api.deleteMessage(
            telegramChatId(run.anchor.chatId),
            messageId,
          );
        } catch (deleteError) {
          if (isTerminalActiveRun(run)) {
            await setActiveRunAnchorPinned(run, false);
          }
          logger.warn(
            "active_run_anchor_replace_blocked",
            "Anchor pengganti tidak dikirim karena anchor lama belum berhasil dihapus.",
            { error: deleteError },
          );
          return;
        }
      }
    }
    try {
      const sent = await bot.api.sendMessage(
        telegramChatId(run.anchor.chatId),
        text,
      );
      const attached = await agentRuns?.attachActiveAnchor(
        "telegram",
        run.ownerId,
        run.runId,
        String(sent.message_id),
      );
      if (attached && !isTerminalActiveRun(attached)) {
        await setActiveRunAnchorPinned(attached, true);
      }
    } catch (error) {
      logger.warn(
        "active_run_anchor_fallback_failed",
        "Run Anchor pengganti gagal dikirim.",
        { error },
      );
    }
  }

  async function resumeActiveAgentRuns(): Promise<void> {
    if (!agentRuns || stoppingActiveAgentWork) return;
    const runs = await agentRuns.recoverInterruptedActiveRuns("telegram");
    for (let run of runs) {
      if (run.anchor.messageId === null) {
        const sent = await bot.api.sendMessage(
          telegramChatId(run.anchor.chatId),
          renderRunAnchor(run),
        );
        run = await agentRuns.attachActiveAnchor(
          "telegram",
          run.ownerId,
          run.runId,
          String(sent.message_id),
        );
        await setActiveRunAnchorPinned(run, true);
      } else {
        await updateActiveRunAnchor(run, true);
      }
      if (
        run.status === "queued" ||
        (run.status === "waiting_input" && run.resumeAnswer)
      ) {
        launchActiveAgentWork(run);
      }
    }
  }

  function abortActiveAgentWork(ownerId: string, runId?: string): void {
    const active = activeAgentWork.get(ownerId);
    if (active && (runId === undefined || active.runId === runId)) {
      active.controller.abort();
    }
  }

  async function stopActiveAgentWork(): Promise<void> {
    stoppingActiveAgentWork = true;
    activeRunIngress.releaseAll();
    const work = [...activeAgentWork.values()];
    for (const active of work) active.controller.abort();
    await Promise.allSettled(work.map((active) => active.promise));
  }

  async function codingConsent(ctx: Context, ownerId: string): Promise<boolean> {
    if (!await profiles.needsOnboarding(ownerId)) return true;
    await ctx.reply("Selesaikan perkenalan dan persetujuan lewat /start sebelum memakai coding agent.");
    return false;
  }

  function scheduleCodingAnchor(
    run: CodingRun,
    chatId: number,
    messageId: number,
  ): void {
    const text = renderCodingRunAnchor(run).text;
    let delivery = codingAnchorUpdates.get(run.runId);
    if (!delivery) {
      delivery = {
        chatId,
        messageId,
        lastText: "",
        pendingText: text,
        timer: null,
        sending: false,
      };
      codingAnchorUpdates.set(run.runId, delivery);
    } else {
      delivery.pendingText = text;
    }
    if (delivery.timer || delivery.sending) return;
    delivery.timer = setTimeout(() => {
      delivery!.timer = null;
      void deliverCodingAnchor(run.runId);
    }, 1_200);
    delivery.timer.unref?.();
  }

  async function deliverCodingAnchor(runId: string): Promise<void> {
    const delivery = codingAnchorUpdates.get(runId);
    if (!delivery || delivery.sending || delivery.pendingText === null) return;
    const text = delivery.pendingText;
    delivery.pendingText = null;
    if (text === delivery.lastText) return;
    delivery.sending = true;
    try {
      await bot.api.editMessageText(delivery.chatId, delivery.messageId, text);
      delivery.lastText = text;
    } catch {
      logger.warn(
        "coding_anchor_update_failed",
        "Run Anchor coding gagal diperbarui; state durable tetap tersedia.",
      );
    } finally {
      delivery.sending = false;
      if (delivery.pendingText !== null && delivery.timer === null) {
        delivery.timer = setTimeout(() => {
          delivery.timer = null;
          void deliverCodingAnchor(runId);
        }, 1_200);
        delivery.timer.unref?.();
      }
    }
  }

  async function flushCodingAnchor(
    run: CodingRun,
    chatId: number,
    messageId: number,
  ): Promise<void> {
    const current = codingAnchorUpdates.get(run.runId);
    if (current?.timer) clearTimeout(current.timer);
    codingAnchorUpdates.delete(run.runId);
    try {
      await bot.api.editMessageText(chatId, messageId, renderCodingRunAnchor(run).text);
    } catch {
      // Final state remains queryable through /code_status.
    }
  }

  function trackCodingCompletion(
    ctx: Context,
    ownerId: string,
    handle: PrivateCodingRunHandle,
    messageId: number,
  ): void {
    const work = handle.completion.then(async (outcome) => {
      await flushCodingAnchor(outcome.run, ctx.chat!.id, messageId);
      if (outcome.localCommit) {
        await ctx.api.sendMessage(ctx.chat!.id, [
          "Commit lokal terverifikasi dibuat.",
          `Commit: ${outcome.localCommit.commit.slice(0, 12)}`,
          `Tree: ${outcome.localCommit.treeHash.slice(0, 12)}`,
          `Branch: ${outcome.localCommit.branch}`,
          "Belum ada push remote tanpa confirmation exact.",
        ].join("\n"));
      }
      if (outcome.stoppedReason === "local_git_commit_failed") {
        await ctx.api.sendMessage(
          ctx.chat!.id,
          "Perubahan project tersimpan dan validator lulus, tetapi commit git lokal belum terbukti. Publish tetap tertutup.",
        );
      }
      if (isTerminalCodingRun(outcome.run)) {
        const anchor = codingAnchors.get(ownerId);
        if (anchor?.runId === outcome.run.runId) codingAnchors.delete(ownerId);
      }
    }).catch(async () => {
      logger.error(
        "private_coding_completion_failed",
        "CodingRun private berhenti sebelum delivery akhir.",
        new Error("private_coding_completion_failed"),
      );
      await ctx.api.sendMessage(
        ctx.chat!.id,
        "CodingRun berhenti. Gunakan /code_status untuk melihat state faktual terakhir.",
      ).catch(() => undefined);
    }).finally(() => {
      handle.unsubscribeProgress();
      activeCodingWork.delete(work);
    });
    work.catch(() => undefined);
    activeCodingWork.add(work);
  }

  async function sendPublishOffer(
    ctx: Context,
    offer: PrivateGitHubPublishOffer,
  ): Promise<void> {
    await ctx.reply([
      "Confirmation GitHub exact (workspace-private)",
      `Capability: ${offer.capability}`,
      `Repository: ${offer.repositoryFullName}`,
      `Branch: ${offer.branch}`,
      `Commit: ${offer.commit}`,
      `Base commit: ${offer.baseCommit}`,
      `Effect ID: ${offer.effectId}`,
      `Audience: ${offer.audience}`,
      `Actor membership: ${offer.actorMembershipId}`,
      `Authority revision: ${offer.authorityRevision}`,
      `Expires: ${offer.expiresAt}`,
    ].join("\n"), {
      reply_markup: {
        inline_keyboard: [[{
          text: `Konfirmasi ${publishCapabilityLabel(offer.capability)}`,
          callback_data: `codingpub:${offer.offerId}`,
        }]],
      },
    });
  }

  function privateCodingActor(
    ctx: Context,
    runtime: Pick<CodingRuntimeComposition, "issuePrivateActor">,
  ) {
    if (!ctx.from) throw new Error("Principal Telegram private tidak tersedia.");
    return runtime.issuePrivateActor({
      channel: "telegram",
      platformId: String(ctx.from.id),
      interactionId: `telegram:${ctx.update.update_id}:${ctx.message?.message_id ?? 0}`,
    });
  }

  function contextSnapshotForActiveRun(
    context: HarvyContext,
  ): AgentRunContextSnapshot {
    return {
      summary: context.summary,
      turns: context.turns.map((turn) => ({ ...turn })),
      memories: context.memories.map((memory) => ({
        id: memory.id,
        kind: memory.kind,
        content: memory.content,
      })),
      ...(context.retrieved?.length
        ? { retrieved: structuredClone(context.retrieved) }
        : {}),
    };
  }

  function contextFromActiveRun(run: ActiveAgentRun): HarvyContext {
    return {
      summary: run.context.summary,
      turns: run.context.turns.map((turn) => ({ ...turn })),
      memories: run.context.memories.map((memory) => ({
        ...memory,
        ownerId: run.ownerId,
        createdAt: run.createdAt,
        lastUsedAt: null,
        expiresAt: null,
      })),
      ...(run.context.retrieved?.length
        ? { retrieved: structuredClone(run.context.retrieved) }
        : {}),
    };
  }

  function quotedMessageId(ctx: Context): string | null {
    return ctx.message?.reply_to_message?.message_id === undefined
      ? null
      : String(ctx.message.reply_to_message.message_id);
  }

  function sourceMessageId(ctx: Context): string {
    const messageId = ctx.message?.message_id ?? ctx.update.update_id;
    return `telegram:${messageId}`;
  }

  function telegramChatId(value: string): number | string {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : value;
  }

  function numericMessageId(value: string | null): number | null {
    if (value === null) return null;
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
  }

  function isTelegramMessageNotModified(error: unknown): boolean {
    if (
      error instanceof Error &&
      /message is not modified/iu.test(error.message)
    ) {
      return true;
    }
    if (!error || typeof error !== "object") return false;
    const description = (error as { description?: unknown }).description;
    return typeof description === "string" &&
      /message is not modified/iu.test(description);
  }

  async function handlePendingText(
    ctx: Context,
    ownerId: string,
    waiting: Pending,
    text: string,
    timeZone: string,
    context: HarvyContext,
    runtime: ConversationRuntime,
    style: StylePreference | null,
  ): Promise<boolean> {
    if (!(await runtimeIsCurrent(runtime))) return true;
    switch (waiting.kind) {
      case "agent-input":
        await continueAgentInput(
          ctx,
          ownerId,
          waiting,
          text,
          timeZone,
          context,
          runtime,
          style,
        );
        return true;
      case "edit-due":
        await applyNewDue(
          ctx,
          ownerId,
          waiting.taskId,
          text,
          timeZone,
          runtime,
        );
        return true;
      case "edit-memory":
        await applyMemoryEdit(
          ctx,
          ownerId,
          waiting.memoryId,
          text,
          runtime,
        );
        return true;
      case "set-task-reminder":
        await applyTaskReminder(
          ctx,
          ownerId,
          waiting.taskId,
          text,
          timeZone,
          runtime,
        );
        return true;
      case "schedule-checkin":
        await applyCheckInTime(
          ctx,
          ownerId,
          waiting.sessionId,
          text,
          timeZone,
          runtime,
        );
        return true;
      case "custom-quiet-hours":
        await applyCustomQuietHours(
          ctx,
          ownerId,
          waiting.sessionId,
          text,
          runtime,
        );
        return true;
      case "checkin-settings":
        await ctx.reply(
          waiting.step === "timezone"
            ? "Pilih zona waktumu lewat tombol yang tadi, ya."
            : "Pilih jam tenang lewat tombol yang tadi, ya.",
        );
        return true;
      case "confirm-task":
      case "confirm-memory-wipe":
      case "confirm-consent-withdrawal":
      case "confirm-full-deletion":
        return false;
    }
  }

  async function continueAgentInput(
    ctx: Context,
    ownerId: string,
    waiting: Extract<Pending, { kind: "agent-input" }>,
    answer: string,
    timeZone: string,
    context: HarvyContext,
    runtime: ConversationRuntime,
    style: StylePreference | null,
  ): Promise<void> {
    if (agentRuns && waiting.revision !== null) {
      try {
        const claimed = await agentRuns.claimWaitingInput(
          "telegram",
          ownerId,
          waiting.checkpoint.runId,
          waiting.revision,
        );
        waiting = { ...waiting, revision: claimed.revision };
        pending.restore(ownerId, waiting, Date.parse(claimed.expiresAt));
      } catch (error) {
        if (!(error instanceof AgentRunConflictError)) throw error;
        pending.clear(ownerId);
        const response =
          "Run sebelumnya sudah berubah atau kedaluwarsa, jadi jawaban ini tidak kupakai untuk checkpoint lama. Kirim ulang permintaan awal kalau kamu masih membutuhkannya.";
        await ctx.reply(response);
        await history.append(ownerId, "harvy", response);
        return;
      }
    }

    let result;
    try {
      result = await conversation.agent(
        waiting.request,
        waiting.mode,
        context,
        {
          ...runtime,
          ownerId,
          channel: "telegram",
          timeZone,
          style,
          intent: waiting.intent,
        },
        waiting.checkpoint,
        answer,
      );
    } catch (error) {
      await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      if (!(await runtimeIsCurrent(runtime))) return;
      await clearPending(
        ownerId,
        waiting.checkpoint.runId,
        waiting.revision ?? undefined,
      );
      logger.error("agent_resume_failed", "Run agent gagal dilanjutkan.", error);
      const failure = aiFailureMessage(error);
      await ctx.reply(failure);
      await history.append(ownerId, "harvy", failure);
      return;
    }

    if (!(await runtimeIsCurrent(runtime))) {
      await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      return;
    }
    if (result.status === "stopped") {
      logger.warn(
        "agent_run_stopped",
        "Run agent lanjutan dihentikan oleh guard runtime.",
        {
          status: result.status,
          reason: result.reason,
          outcome: result.trace.at(-1)?.outcome,
          count: result.trace.length,
        },
      );
    }

    let debitDeliveredReply = true;
    let nextPending: Extract<Pending, { kind: "agent-input" }> | null = null;
    let response: string;
    if (result.status === "completed") {
      response = result.reply;
    } else if (result.status === "needs_input") {
      response = result.prompt;
      nextPending = { ...waiting, checkpoint: result.checkpoint };
    } else if (result.status === "needs_approval") {
      debitDeliveredReply = false;
      response = agentApprovalStopMessage();
    } else {
      debitDeliveredReply = false;
      response = agentStopMessage(result.reason, "resumed");
    }
    response = normalizeTelegramText(response);
    if (!debitDeliveredReply) {
      await telemetry.discardUndelivered?.(ownerId, currentTurnId());
    }

    if (!(await runtimeIsCurrent(runtime))) {
      await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      return;
    }
    try {
      await sendReply(ctx, response, [], undefined, undefined, runtime);
    } catch (error) {
      if (error instanceof ReplyInterruptedError) {
        if (error.deliveredText) {
          if (debitDeliveredReply) {
            await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
          }
          await history.append(ownerId, "harvy", error.deliveredText);
          await memories.markUsed(context.memories);
        } else {
          await telemetry.discardUndelivered?.(ownerId, currentTurnId());
        }
        return;
      }
      if (
        error instanceof PartialReplyDeliveryError &&
        error.deliveredText
      ) {
        const warning = await abandonAgentRunAfterDelivery(
          ctx,
          ownerId,
          waiting.checkpoint.runId,
          error.cause,
        );
        if (debitDeliveredReply) {
          await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
        }
        await history.append(ownerId, "harvy", error.deliveredText);
        if (warning) await history.append(ownerId, "harvy", warning);
        await memories.markUsed(context.memories);
        return;
      }
      await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      throw error;
    }

    let checkpointWarning: string | null = null;
    try {
      if (nextPending) await saveAgentPending(ownerId, nextPending);
      else {
        await clearPending(
          ownerId,
          waiting.checkpoint.runId,
          waiting.revision ?? undefined,
        );
      }
    } catch (error) {
      checkpointWarning = await abandonAgentRunAfterDelivery(
        ctx,
        ownerId,
        waiting.checkpoint.runId,
        error,
      );
    }
    if (debitDeliveredReply) {
      await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
    }
    await history.append(ownerId, "harvy", response);
    if (checkpointWarning) {
      await history.append(ownerId, "harvy", checkpointWarning);
    }
    await memories.markUsed(context.memories);
  }

  async function applyMemoryEdit(
    ctx: Context,
    ownerId: string,
    memoryId: string,
    text: string,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    if (!text.trim() || text.trim().length > 200) {
      await ctx.reply(
        "Tulis penggantinya dalam satu kalimat, maksimal 200 karakter.",
      );
      return;
    }

    const clean = text.trim().replaceAll(/\s+/g, " ");
    const currentMemories = await memories.list(ownerId);
    if (!(await runtimeIsCurrent(runtime))) return;
    const current = currentMemories.find((memory) => memory.id === memoryId);
    const duplicate = currentMemories.some(
      (memory) =>
        memory.id !== memoryId &&
        memory.content.toLowerCase() === clean.toLowerCase(),
    );
    if (!current || duplicate) {
      await ctx.reply(
        "Aku nggak bisa mengubahnya—catatannya mungkin sudah hilang atau isinya sama dengan catatan lain.",
      );
      return;
    }

    if (!(await runtimeIsCurrent(runtime))) return;
    const stoppedRun = await discardAgentRunForMemoryChange(ownerId);
    if (!(await runtimeIsCurrent(runtime))) return;
    const updated = await memories.edit(ownerId, memoryId, clean);
    if (!updated) {
      await ctx.reply(
        "Aku nggak bisa mengubahnya—catatannya mungkin sudah hilang atau isinya sama dengan catatan lain.",
      );
      return;
    }

    await clearPending(ownerId);
    await recordEvent(ownerId, "memory_edited");
    const response = [
      `Udah aku ubah jadi: ${updated.content}`,
      ...(stoppedRun
        ? ["Pekerjaan planning yang memakai catatan lama juga kuhentikan supaya versi lama itu tidak dipakai lagi."]
        : []),
    ].join("\n\n");
    await ctx.reply(response);
    await history.append(ownerId, "harvy", response);
  }

  async function applyTaskReminder(
    ctx: Context,
    ownerId: string,
    taskId: string,
    text: string,
    timeZone: string,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    const at = await readChosenTime(ctx, ownerId, text, timeZone, runtime);
    if (!at) return;

    const profile = await profiles.load(ownerId);
    if (!(await runtimeIsCurrent(runtime))) return;
    if (isInQuietHours(at, timeZone, profile.quietHours)) {
      await ctx.reply(
        "Waktu itu masuk jam tenangmu. Pilih waktu lain, atau ubah jam tenang lewat Data & izin.",
      );
      return;
    }

    if (!(await runtimeIsCurrent(runtime))) return;
    const updated = await tasks.setReminder(ownerId, taskId, at);
    if (!updated) {
      await clearPending(ownerId);
      await ctx.reply(taskMissingNote());
      return;
    }

    await clearPending(ownerId);
    const response = [
      "Oke, aku akan mengingatkan sekali pada waktu yang kamu pilih.",
      "",
      formatTask(updated, timeZone),
    ].join("\n");
    await ctx.reply(response, { reply_markup: taskActions(updated) });
    await history.append(ownerId, "harvy", response);
  }

  async function applyCheckInTime(
    ctx: Context,
    ownerId: string,
    sessionId: string,
    text: string,
    timeZone: string,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    const at = await readChosenTime(ctx, ownerId, text, timeZone, runtime);
    if (!at) return;

    const profile = await profiles.load(ownerId);
    if (!(await runtimeIsCurrent(runtime))) return;
    if (isInQuietHours(at, timeZone, profile.quietHours)) {
      await ctx.reply(
        "Waktu itu masuk jam tenangmu, jadi aku nggak akan menggesernya diam-diam. Pilih waktu lain, ya.",
      );
      return;
    }

    if (!(await runtimeIsCurrent(runtime))) return;
    const updated = await sessions.scheduleCheckIn(
      ownerId,
      at,
      sessionId,
    );
    if (!updated) {
      await clearPending(ownerId);
      await ctx.reply("Sesinya sudah berubah atau selesai.");
      return;
    }

    await clearPending(ownerId);
    await recordEvent(ownerId, "checkin_scheduled");
    const response = [
      "Siap. Aku akan tanya sekali pada waktu itu; kalau kamu diam, aku nggak akan mengejar.",
      "",
      formatSession(updated, timeZone),
    ].join("\n");
    await ctx.reply(response, { reply_markup: sessionActions(updated) });
    await history.append(ownerId, "harvy", response);
  }

  async function applyCustomQuietHours(
    ctx: Context,
    ownerId: string,
    sessionId: string | null,
    text: string,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    const quietHours = parseQuietHours(text);
    if (!quietHours) {
      await ctx.reply(
        "Aku belum nangkep rentangnya. Tulis seperti “21.30–06.00”.",
      );
      return;
    }

    if (!(await runtimeIsCurrent(runtime))) return;
    const profile = await profiles.setQuietHours(ownerId, quietHours);
    await clearPending(ownerId);
    if (sessionId) {
      await promptCheckInTime(ctx, ownerId, sessionId);
      return;
    }

    const response = `Jam tenang tersimpan.\n\n${formatTimeSettings(profile)}`;
    await ctx.reply(response);
  }

  async function readChosenTime(
    ctx: Context,
    ownerId: string,
    text: string,
    timeZone: string,
    runtime: ConversationRuntime = {},
  ): Promise<Date | null> {
    let at: Date | null;
    try {
      at = await conversation.understandDueDate(text, {
        ...runtime,
        ownerId,
        timeZone,
      });
    } catch (error) {
      if (!(await runtimeIsCurrent(runtime))) return null;
      logger.error(
        "selected_time_understanding_failed",
        "Pembacaan waktu pilihan gagal.",
        error,
      );
      await ctx.reply(aiFailureMessage(error));
      return null;
    }

    if (!(await runtimeIsCurrent(runtime))) return null;
    if (!at || at.getTime() <= Date.now()) {
      await ctx.reply(
        "Aku belum nangkep waktu yang masih akan datang. Coba tulis seperti “30 menit lagi” atau “besok jam 7 malam”.",
      );
      return null;
    }
    return at;
  }

  async function promptCheckInTime(
    ctx: Context,
    ownerId: string,
    sessionId: string,
  ): Promise<void> {
    await sendPendingPrompt(
      ownerId,
      { kind: "schedule-checkin", sessionId },
      () =>
        ctx.reply(
          "Mau aku tanya lagi kapan? Kamu yang pilih waktunya—misalnya “30 menit lagi” atau “besok jam 7 malam”.",
        ).then(() => undefined),
    );
  }

  /**
   * Pending baru hanya hidup bila pertanyaan yang menjelaskannya sudah terlihat.
   *
   * Token juga membuat rollback aman terhadap prompt yang lebih baru: kegagalan
   * kirim lama tidak boleh menghapus langkah yang menggantikannya.
   */
  async function sendPendingPrompt(
    ownerId: string,
    value: Pending,
    deliver: (token: string) => Promise<void>,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    if (!(await runtimeIsCurrent(runtime))) return;
    const token = await setPending(ownerId, value);
    if (!(await runtimeIsCurrent(runtime))) {
      pending.take(ownerId, token);
      return;
    }
    try {
      await deliver(token);
    } catch (error) {
      pending.take(ownerId, token);
      throw error;
    }
  }

  async function showControl(
    ctx: Context,
    ownerId: string,
    action: ControlAction,
    runtime: ConversationRuntime = {},
    sourceText = "",
  ): Promise<void> {
    if (!(await runtimeIsCurrent(runtime))) return;
    switch (action) {
      case "data":
        await ctx.reply(
          "Di sini kamu bisa melihat, mengubah, mengekspor, atau menghapus datamu sendiri.",
          { reply_markup: dataControlActions() },
        );
        return;
      case "timezone": {
        const requestedZone = sourceText
          ? explicitIndonesianTimeZoneChange(sourceText)
          : null;
        const profile = requestedZone
          ? await profiles.setTimeZone(ownerId, requestedZone)
          : await profiles.load(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        await ctx.reply(
          `${requestedZone ? "Zona waktu tersimpan." : "Pengaturan waktu saat ini:"}\n\n${formatTimeSettings(profile)}`,
          { reply_markup: timezoneActions() },
        );
        return;
      }
      case "quiet-hours": {
        const requestedQuietHours = sourceText
          ? explicitQuietHoursChange(sourceText)
          : null;
        const profile = requestedQuietHours
          ? await profiles.setQuietHours(ownerId, requestedQuietHours)
          : await profiles.load(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        await ctx.reply(
          `${requestedQuietHours ? "Jam tenang tersimpan." : "Pengaturan waktu saat ini:"}\n\n${formatTimeSettings(profile)}`,
          { reply_markup: quietHoursActions() },
        );
        return;
      }
      case "active-session": {
        const session = await sessions.active(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        if (!session) {
          await ctx.reply("Saat ini nggak ada sesi yang aktif.");
          return;
        }
        const timeZone = await timeZoneFor(ownerId);
        if (!(await runtimeIsCurrent(runtime))) return;
        await ctx.reply(
          formatSession(session, timeZone),
          { reply_markup: sessionActions(session) },
        );
        return;
      }
      case "withdraw-consent":
        await sendPendingPrompt(
          ownerId,
          { kind: "confirm-consent-withdrawal" },
          (token) =>
            ctx.reply(
              "Kalau izin ditarik, pesan berikutnya tidak akan diproses AI sampai kamu memilih setuju lagi. Data, sesi, dan check-in yang sudah ada tetap tersimpan, tetapi run agent yang sedang menunggu jawaban dibatalkan dan check-in tidak dikirim selama izin belum diberikan lagi.",
              { reply_markup: withdrawConsentConfirmActions(token) },
            ).then(() => undefined),
          runtime,
        );
        return;
      case "export":
        await sendDataExport(ctx, ownerId, runtime);
        return;
      case "delete-all":
        await sendPendingPrompt(
          ownerId,
          { kind: "confirm-full-deletion" },
          (token) =>
            ctx.reply(
              "Ini menghapus tugas aktif dan selesai, riwayat, memori, sesi, check-in, run agent tertunda, profil, serta catatan pemakaian. Tindakan ini tidak bisa dibatalkan.",
              { reply_markup: deleteAllConfirmActions(token) },
            ).then(() => undefined),
          runtime,
        );
        return;
    }
  }

  async function sendDataExport(
    ctx: Context,
    ownerId: string,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    const snapshot = await dataControls.export(ownerId);
    if (!(await runtimeIsCurrent(runtime))) return;
    const body = `${JSON.stringify(snapshot, null, 2)}\n`;
    await ctx.replyWithDocument(
      new InputFile(
        Buffer.from(body, "utf8"),
        `harvy-data-${ownerId}.json`,
      ),
      {
        caption:
          "Ini salinan data Harvy yang boleh kamu lihat. Catatan keselamatan tersembunyi tidak dimasukkan, tetapi akan ikut terhapus bila kamu memilih hapus seluruh data.",
      },
    );
    await recordEvent(ownerId, "data_exported");
  }

  async function timeZoneFor(ownerId: string): Promise<string> {
    return (await profiles.load(ownerId)).timeZone ?? config.defaultTimezone;
  }

  function recordEvent(
    ownerId: string,
    kind: Parameters<TelemetryService["event"]>[1],
  ): Promise<void> {
    void telemetry.event(ownerId, kind).catch((error: unknown) => {
      logger.warn(
        "product_metric_failed",
        "Metrik produk gagal dicatat.",
        { eventKind: kind, error },
      );
    });
    return Promise.resolve();
  }

  async function recordSessionSignal(
    ownerId: string,
    signal: SessionSignal,
  ): Promise<void> {
    if (signal === "done") {
      await recordEvent(ownerId, "session_completed");
    } else if (signal === "cancel") {
      await recordEvent(ownerId, "session_stopped");
    } else {
      await recordEvent(ownerId, "session_progressed");
    }
  }

  /**
   * Mengirim balasan sebagai beberapa bubble, dengan jeda kecil di antaranya.
   *
   * Beberapa bubble yang tiba serentak terbaca seperti notifikasi beruntun.
   * Jedanya pendek dan berplafon: ini soal keterbacaan, bukan soal membuat
   * percakapan terasa lebih lama.
   */
  async function sendReply(
    ctx: Context,
    text: string,
    notes: MemoryItem[] = [],
    keyboard?: InlineKeyboard,
    onBubbleDelivered?: (text: string) => void,
    runtime: ConversationRuntime = {},
  ): Promise<SentMessageRef | null> {
    const bubbles = splitReplyBubbles(text);
    if (bubbles.length === 0) return null;
    const replyKeyboard = keyboard;
    // Caller biasanya sudah membuang fallback note bila balasan model telah
    // mengakui write. Pertahankan pagar kedua di boundary delivery agar race
    // atau refactor tidak menghasilkan dua kalimat "aku ingat" dalam bubble
    // yang sama.
    const notesToDeliver = replyAcknowledgesMemoryWrite(text) ? [] : notes;

    let lastMessage: SentMessageRef | null = null;
    const delivered: string[] = [];
    for (const [index, bubble] of bubbles.entries()) {
      if (!(await runtimeIsCurrent(runtime))) {
        throw new ReplyInterruptedError(delivered.join("\n\n"));
      }
      const last = index === bubbles.length - 1;
      const deliveredBubble = last
        ? withMemoryNotes(bubble, notesToDeliver)
        : bubble;
      let sent;
      try {
        sent = await ctx.reply(
          deliveredBubble,
          last && replyKeyboard ? { reply_markup: replyKeyboard } : {},
        );
      } catch (error) {
        if (delivered.length > 0) {
          throw new PartialReplyDeliveryError(delivered.join("\n\n"), error);
        }
        throw error;
      }
      delivered.push(deliveredBubble);
      onBubbleDelivered?.(deliveredBubble);
      lastMessage = {
        chatId: sent.chat.id,
        messageId: sent.message_id,
      };

      if (!last) {
        await bestEffortTyping(ctx, logger);
        await interruptibleBubblePause(
          bubblePauseMs(bubbles[index + 1] ?? ""),
          runtime.signal,
        );
      }
    }
    return lastMessage;
  }

  /** Run Anchor harus satu pesan yang dapat diedit, bukan rangkaian bubble. */
  async function sendRunAnchor(
    ctx: Context,
    text: string,
    runtime: ConversationRuntime = {},
  ): Promise<SentMessageRef> {
    if (!(await runtimeIsCurrent(runtime))) {
      throw new ReplyInterruptedError("");
    }
    await runtime.progress?.responding?.();
    const sent = await ctx.reply(text);
    return { chatId: sent.chat.id, messageId: sent.message_id };
  }

  /** Jalur mundur ketika tidak ada balasan yang bisa ditempeli catatan. */
  async function sendMemoryNotes(
    ctx: Context,
    items: MemoryItem[],
  ): Promise<void> {
    if (items.length === 0) return;

    await ctx.reply(memoryNoteLines(items));
  }

  async function retractCorrectedMemories(
    ownerId: string,
    text: string,
    understanding: Understanding,
    runtime: ConversationRuntime,
  ): Promise<ForgottenMemoryBatch> {
    const proposals = (understanding.memoryRetractions ?? []).filter(
      (proposal) => memoryRetractionAuthorized(text, proposal),
    );
    if (proposals.length === 0) {
      return { forgotten: [], acknowledgements: [] };
    }

    const current = await memories.list(ownerId);
    if (!(await runtimeIsCurrent(runtime))) {
      return { forgotten: [], acknowledgements: [] };
    }
    const selected = new Map<string, MemoryItem>();
    for (const proposal of proposals) {
      for (const item of memoriesMatchingNaturalTarget(
        current,
        proposal.target,
      )) {
        selected.set(item.id, item);
      }
    }
    // Koreksi natural adalah item-scoped, bukan jalan belakang bulk deletion.
    if (selected.size === 0 || selected.size > 8) {
      return { forgotten: [], acknowledgements: [] };
    }

    await discardAgentRunForMemoryChange(ownerId);
    if (!(await runtimeIsCurrent(runtime))) {
      return { forgotten: [], acknowledgements: [] };
    }
    const forgotten: MemoryItem[] = [];
    for (const item of selected.values()) {
      const removed = await memories.forget(ownerId, item.id);
      if (removed) forgotten.push(removed);
    }
    return {
      forgotten,
      acknowledgements: forgotten.map((item) => ({
        content: item.content,
        operation: "forgotten" as const,
        explicit: true as const,
      })),
    };
  }

  /**
   * Menyimpan kandidat setelah consent onboarding privat aktif.
   *
   * Perintah remember tetap dibuktikan lokal agar kegagalan dapat dijelaskan
   * secara jujur. Kandidat percakapan biasa memakai authority onboarding dan
   * tidak membuat prompt atau tombol per-item. Primary MemoryService tetap
   * menjadi pagar credential, lifecycle, dedupe, dan batas penyimpanan.
   */
  async function storeOrdinaryMemories(
    ownerId: string,
    items: AuthorizedMemoryCandidate[],
  ): Promise<StoredMemoryBatch> {
    const saved: MemoryItem[] = [];
    const explicitlyRemembered: MemoryItem[] = [];
    const acknowledgements: StoredMemoryBatch["acknowledgements"] = [];
    let uncommitted = false;

    try {
      for (const authorized of items) {
        const item = authorized.memory;
        const isSensitive = isSensitiveMemory(item);

        const stored = await memories.remember({
          ownerId,
          kind: item.kind,
          content: item.content,
          ...(item.sourceSequences
            ? { sourceSequences: [...item.sourceSequences] }
            : {}),
          ...knowledgeFields(item),
          ...(isSensitive
            ? {
                sensitivity: "personal" as const,
                sensitiveConsent: true,
              }
            : {}),
        });
        if (stored) {
          saved.push(stored);
          acknowledgements.push({
            item: stored,
            operation: item.correction ? "updated" : "saved",
            explicit: authorized.explicitRequest,
          });
          if (authorized.explicitRequest) explicitlyRemembered.push(stored);
          continue;
        }
        const duplicate = (await memories.list(ownerId)).find(
          (existing) =>
            existing.content.toLocaleLowerCase("id-ID") ===
              item.content.toLocaleLowerCase("id-ID"),
        );
        if (duplicate) {
          if (authorized.explicitRequest) {
            explicitlyRemembered.push(duplicate);
            acknowledgements.push({
              item: duplicate,
              operation: "already-known",
              explicit: true,
            });
          }
          continue;
        }
        uncommitted = true;
      }
    } catch (error) {
      await rollbackOrdinaryMemories(ownerId, saved);
      throw error;
    }

    return { saved, uncommitted, explicitlyRemembered, acknowledgements };
  }

  function memoryNoticeItemsForReply(
    reply: string | null,
    remembered: StoredMemoryBatch,
  ): MemoryItem[] {
    const alreadyAcknowledged = Boolean(
      reply && replyAcknowledgesMemoryWrite(reply),
    );
    if (alreadyAcknowledged) return [];

    const notices = [...remembered.saved];
    for (const item of remembered.explicitlyRemembered) {
      if (!notices.some((candidate) => candidate.id === item.id)) {
        notices.push(item);
      }
    }
    return notices;
  }

  function memoryFallbackAcknowledgement(
    remembered: StoredMemoryBatch,
  ): string {
    const receipts = remembered.acknowledgements;
    if (receipts.length > 1) {
      return "Oke, beberapa hal penting dari ceritamu aku bawa untuk kuingat ke depan 📍";
    }
    switch (receipts[0]?.operation) {
      case "updated":
        return "Oke, yang itu sudah aku perbarui untuk ke depan 📍";
      case "already-known":
        return "Iya, yang itu masih aku ingat.";
      case "saved":
      default:
        return "Oke, yang ini aku ingat untuk ke depan 📍";
    }
  }

  function memoryRetractionFallbackAcknowledgement(
    _retracted: ForgottenMemoryBatch,
  ): string {
    return "Oke, ingatan lama yang kamu koreksi sudah aku hapus.";
  }

  function memoryLifecycleFallbackAcknowledgement(
    retracted: ForgottenMemoryBatch,
    remembered: StoredMemoryBatch,
  ): string {
    return [
      ...(retracted.acknowledgements.length > 0
        ? [memoryRetractionFallbackAcknowledgement(retracted)]
        : []),
      ...(remembered.acknowledgements.length > 0
        ? [memoryFallbackAcknowledgement(remembered)]
        : []),
    ].join(" ");
  }

  async function setActiveRunAnchorPinned(
    run: ActiveAgentRun,
    pinned: boolean,
  ): Promise<void> {
    const messageId = numericMessageId(run.anchor.messageId);
    if (messageId === null) return;
    try {
      if (pinned) {
        await bot.api.pinChatMessage(
          telegramChatId(run.anchor.chatId),
          messageId,
          { disable_notification: true },
        );
      } else {
        await bot.api.unpinChatMessage(
          telegramChatId(run.anchor.chatId),
          messageId,
        );
      }
    } catch (error) {
      logger.warn(
        pinned ? "active_run_anchor_pin_failed" : "active_run_anchor_unpin_failed",
        pinned
          ? "Run Anchor Telegram gagal disematkan."
          : "Run Anchor Telegram terminal gagal dilepas dari sematan.",
        { error },
      );
    }
  }

  async function rollbackOrdinaryMemories(
    ownerId: string,
    items: MemoryItem[],
  ): Promise<void> {
    for (const item of items) {
      try {
        await memories.forget(ownerId, item.id);
      } catch (error) {
        logger.error(
          "memory_rollback_failed",
          "Rollback memori yang belum diumumkan gagal.",
          error,
        );
      }
    }
  }

  /**
   * Satu pertanyaan gaya, sesudah percakapan pertama benar-benar terjadi.
   *
   * Tidak diajukan ketika ada pertanyaan lain yang sedang menunggu jawaban:
   * dua pertanyaan sekaligus mengubah percakapan menjadi formulir.
   */
  async function askStyleOnce(
    ctx: Context,
    ownerId: string,
    eligible: boolean,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    if (!eligible || pending.peek(ownerId)) return;
    if (!(await runtimeIsCurrent(runtime))) return;

    await ctx.reply(STYLE_QUESTION, { reply_markup: styleActions() });
    await profiles.markStyleAsked(ownerId);
    await history.append(ownerId, "harvy", STYLE_QUESTION);
  }

  async function showMemories(
    ctx: Context,
    ownerId: string,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    if (!(await runtimeIsCurrent(runtime))) return;
    const items = await memories.list(ownerId);
    if (!(await runtimeIsCurrent(runtime))) return;
    const portraitContext: HarvyContext = {
      // Riwayat dan episode bukan daftar memori. Potret hanya memakai primary
      // memory (serta, bila caller lain kelak menambahkannya, evidence yang
      // tetap menunjuk primary source yang dapat dikendalikan pengguna).
      summary: null,
      turns: [],
      memories: items,
    };

    const hasEvidence = hasMemoryPortraitEvidence(portraitContext);
    let text = MEMORY_PORTRAIT_EMPTY;
    if (hasEvidence) {
      await bestEffortTyping(ctx, logger);
      if (!(await runtimeIsCurrent(runtime))) return;
      try {
        const candidate = await conversation.memoryPortrait(
          portraitContext,
          ownerId,
          runtime.signal,
        );
        const summary = isMemoryPortraitGrounded(candidate, portraitContext)
          ? candidate
          : groundedMemoryPortraitFallback(portraitContext);
        text = summary
          ? formatMemoryPortrait(summary)
          : MEMORY_PORTRAIT_UNAVAILABLE;
      } catch (error) {
        logger.warn(
          "memory_portrait_generation_failed",
          "Potret memori tidak dapat disintesis secara grounded; fallback exact dipakai.",
          { errorType: error instanceof Error ? error.name : "unknown" },
        );
        const fallback = groundedMemoryPortraitFallback(portraitContext);
        text = fallback
          ? formatMemoryPortrait(fallback)
          : MEMORY_PORTRAIT_UNAVAILABLE;
      }
    }

    if (!(await runtimeIsCurrent(runtime))) return;
    await ctx.reply(text, hasEvidence
      ? { reply_markup: memoryPortraitActions() }
      : {});
    interactionContext.record(interactionScope(ownerId), {
      domain: "memory",
      operation: "list",
    });
  }

  async function confirmMemoryWipe(
    ctx: Context,
    ownerId: string,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    await sendPendingPrompt(
      ownerId,
      { kind: "confirm-memory-wipe" },
      (token) =>
        ctx.reply(MEMORY_WIPE_PROMPT, {
          reply_markup: memoryWipeConfirmActions(token),
        }).then(() => undefined),
      runtime,
    );
  }

  async function saveTask(
    ctx: Context,
    ownerId: string,
    extracted: ExtractedTask,
    heading?: string,
    runtime: ConversationRuntime = {},
    presentation?: {
      userMessage: string;
      context: HarvyContext;
      style: StylePreference | null;
    },
  ): Promise<boolean> {
    const profile = await profiles.load(ownerId);
    if (!(await runtimeIsCurrent(runtime))) return false;
    const timeZone = profile.timeZone ?? config.defaultTimezone;
    const reminderRejected =
      extracted.remindAt !== null &&
      isInQuietHours(
        extracted.remindAt,
        timeZone,
        profile.quietHours,
      );
    const task = await tasks.create({
      ownerId,
      chatId: String(ctx.chat?.id ?? ownerId),
      title: extracted.title,
      dueAt: extracted.dueAt,
      remindAt: reminderRejected ? null : extracted.remindAt,
      importance: extracted.importance,
    });
    if (!(await runtimeIsCurrent(runtime))) {
      try {
        await tasks.remove(ownerId, task.id);
      } catch (error) {
        logger.error(
          "stale_task_compensation_failed",
          "Tugas dari giliran stale gagal dikompensasi sebelum delivery.",
          error,
        );
      }
      return false;
    }

    const factBody = [
      formatTask(task, timeZone),
      understandingNote(task),
      ...(reminderRejected
        ? [
            "",
            "Waktu pengingat itu masuk jam tenangmu, jadi aku nggak memasangnya diam-diam. Pilih waktu lain lewat tombol Ingatkan.",
          ]
        : []),
    ].join("\n");
    const fallbackText = [
      ...(heading ? [heading, ""] : []),
      factBody,
    ].join("\n");
    const response = heading
      ? await presentPrivateOperation(ownerId, {
          kind: "task-created",
          outcome: "success",
          userMessage: presentation?.userMessage ?? extracted.title,
          stableBody: factBody,
          fallbackText,
          allowedNextSteps: task.reminderAt
            ? []
            : ["Kalau perlu, pilih kapan Harvy harus mengingatkan."],
        }, {
          ...(presentation
            ? { context: presentation.context, style: presentation.style }
            : {}),
          timeZone,
          runtime,
        })
      : fallbackText;
    if (!(await runtimeIsCurrent(runtime))) {
      try {
        await tasks.remove(ownerId, task.id);
      } catch (error) {
        logger.error(
          "stale_presented_task_compensation_failed",
          "Tugas dari presentasi Telegram stale gagal dikompensasi.",
          error,
        );
      }
      return false;
    }

    await ctx.reply(response, { reply_markup: taskActions(task) });
    await history.append(ownerId, "harvy", response);
    return true;
  }

  async function applyNewDue(
    ctx: Context,
    ownerId: string,
    taskId: string,
    text: string,
    timeZone: string,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    let dueAt: Date | null;

    try {
      dueAt = await conversation.understandDueDate(text, {
        ...runtime,
        ownerId,
        timeZone,
      });
    } catch (error) {
      if (!(await runtimeIsCurrent(runtime))) return;
      logger.error(
        "due_date_understanding_failed",
        "Pembacaan tenggat baru gagal.",
        error,
      );
      await ctx.reply(aiFailureMessage(error));
      return;
    }

    if (!(await runtimeIsCurrent(runtime))) return;
    if (!dueAt) {
      const response =
        "Aku belum nangkep waktunya. Coba tulis seperti “besok jam 7 malam” atau “senin depan”.";
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return;
    }

    if (!(await runtimeIsCurrent(runtime))) return;
    const updated = await tasks.setDue(ownerId, taskId, dueAt);

    if (!updated) {
      await clearPending(ownerId);
      const response = taskMissingNote();
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return;
    }

    await clearPending(ownerId);
    const response = [
      "Tenggatnya udah aku ubah.",
      "",
      formatTask(updated, timeZone),
    ].join("\n");
    await ctx.reply(response, { reply_markup: taskActions(updated) });
    await history.append(ownerId, "harvy", response);
  }

  async function routeAction(
    ctx: Context,
    ownerId: string,
    action: string,
    target: string,
  ): Promise<void> {
    switch (action) {
      case "menu": {
        const rendered = renderCommandCategory(
          target,
          commandOptions,
          "telegram",
        );
        if (!rendered) return;
        await safeEdit(
          ctx,
          rendered,
          target === "settings" || target === "memory"
            ? dataControlActions()
            : menuActions(commandOptions),
        );
        interactionContext.record(interactionScope(ownerId), {
          domain: "menu",
          operation: "show-category",
        });
        return;
      }

      case "consent": {
        await acceptConsent(ctx, ownerId, target);
        return;
      }

      case "safety": {
        await ctx.reply(PRE_CONSENT_SAFETY, {
          reply_markup: consentActions(),
        });
        return;
      }

      case "style": {
        if (target !== "listen" && target !== "advice") return;

        await profiles.rememberStyle(ownerId, target);
        const fallbackText = styleAck(target);
        const response = await presentPrivateOperation(ownerId, {
          kind: "preference-updated",
          outcome: "success",
          userMessage: target === "listen"
            ? "Dengarkan dulu"
            : "Langsung beri saran",
          stableBody: target === "listen"
            ? "Gaya respons: dengarkan dulu."
            : "Gaya respons: langsung beri saran.",
          fallbackText,
        }, { style: target });
        await safeEdit(ctx, response);
        await history.append(ownerId, "harvy", response);
        return;
      }

      case "flow": {
        await handleFlowAction(ctx, ownerId, target);
        return;
      }

      case "session": {
        await handleSessionAction(ctx, ownerId, target);
        return;
      }

      case "checkin": {
        await handleCheckInOutcome(ctx, ownerId, target);
        return;
      }

      case "control": {
        await handleControlButton(ctx, ownerId, target);
        return;
      }

      case "timezone": {
        await handleTimeZoneChoice(ctx, ownerId, target);
        return;
      }

      case "quiet": {
        await handleQuietHoursChoice(ctx, ownerId, target);
        return;
      }

      case "consentwithdraw": {
        await handleConsentWithdrawal(ctx, ownerId, target);
        return;
      }

      case "datawipe": {
        await handleFullDeletion(ctx, ownerId, target);
        return;
      }

      case "save": {
        const waiting = pending.take(ownerId, target);

        if (waiting?.kind !== "confirm-task") {
          await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
          return;
        }

        await dropKeyboard(ctx);
        await saveTask(ctx, ownerId, waiting.task, taskSavedHeading());
        return;
      }

      case "nosave": {
        const waiting = pending.take(ownerId, target);
        if (waiting?.kind !== "confirm-task") {
          await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
          return;
        }
        await safeEdit(ctx, taskDeclinedNote());
        return;
      }

      case "done": {
        const completed = await tasks.complete(ownerId, target);
        if (!completed) {
          await safeEdit(ctx, taskMissingNote());
          return;
        }
        await refreshAfterChange(ctx, ownerId, {
          kind: "completed",
          title: completed.title,
        });
        return;
      }

      case "drop": {
        const removed = await tasks.remove(ownerId, target);
        if (!removed) {
          await safeEdit(ctx, taskMissingNote());
          return;
        }
        await refreshAfterChange(ctx, ownerId, {
          kind: "removed",
          title: removed.title,
        });
        return;
      }

      case "edit": {
        await sendPendingPrompt(
          ownerId,
          { kind: "edit-due", taskId: target },
          () =>
            ctx.reply(
              "Mau diubah jadi kapan? Tulis aja, misalnya “besok jam 7 malam” atau “senin depan”.",
            ).then(() => undefined),
        );
        return;
      }

      case "remind": {
        const task = await tasks.find(ownerId, target);
        if (!task || task.status === "completed") {
          await safeEdit(ctx, taskMissingNote());
          return;
        }
        await sendPendingPrompt(
          ownerId,
          {
            kind: "set-task-reminder",
            taskId: target,
          },
          () =>
            ctx.reply(
              "Mau diingatkan kapan? Kamu yang pilih—misalnya “30 menit lagi” atau “besok jam 7 malam”.",
            ).then(() => undefined),
        );
        return;
      }

      case "snooze": {
        await scheduleReminder(ctx, ownerId, target);
        return;
      }

      // Kompatibilitas untuk tombol catatan yang sudah terkirim oleh build lama.
      // Build baru tidak membuat tombol per-write, tetapi callback lama tetap
      // boleh menjalankan hak hapus pada scope pemiliknya.
      case "memdrop": {
        const stoppedRun = await discardAgentRunForMemoryChange(ownerId);
        const forgotten = await memories.forget(ownerId, target);
        await safeEdit(
          ctx,
          withoutMemoryNote(
            ctx.callbackQuery?.message?.text ?? "",
            forgotten?.content ?? null,
          ),
        );
        if (stoppedRun) {
          await ctx.reply(
            "Pekerjaan planning yang memakai catatan itu juga kuhentikan supaya salinan lamanya tidak dipakai lagi.",
          );
        }
        return;
      }

      case "memforget": {
        const stoppedRun = await discardAgentRunForMemoryChange(ownerId);
        const forgotten = await memories.forget(ownerId, target);
        await refreshMemories(
          ctx,
          ownerId,
          forgotten?.content,
          forgotten === null,
        );
        if (stoppedRun) {
          await ctx.reply(
            "Pekerjaan planning yang memakai catatan itu juga kuhentikan supaya salinan lamanya tidak dipakai lagi.",
          );
        }
        return;
      }

      case "memedit": {
        // Kompatibilitas tombol lama: jangan membuka formulir edit record lagi.
        await ctx.reply(MEMORY_CHANGE_PROMPT);
        return;
      }

      case "memchange": {
        // Tidak membuat pending mode. Pesan berikutnya tetap melewati alur
        // percakapan normal agar koreksi, perubahan, dan forget dibaca utuh.
        await ctx.reply(MEMORY_CHANGE_PROMPT);
        return;
      }

      case "memall": {
        await confirmMemoryWipe(ctx, ownerId);
        return;
      }

      case "memallyes": {
        const waiting = pending.take(ownerId, target);
        if (waiting?.kind !== "confirm-memory-wipe") {
          await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
          return;
        }
        memories.suspend(ownerId);
        history.suspend(ownerId);
        let wipeComplete = false;
        const stoppedRun = await discardAgentRunForMemoryChange(ownerId);
        // Pasal 4 nomor 6: catatan tersembunyi ikut terhapus bersama sisanya.
        await insights.forget(ownerId);
        // Insight dihapus lebih dulu agar adapter memori dapat membuang folder
        // pemilik bila tidak ada berkas lain yang tersisa.
        const removed = await memories.forgetAll(ownerId);
        await history.forget(ownerId);
        await sessions.forget(ownerId);
        // Persetujuan tidak ikut terhapus: kalau ikut, memakai hak melupakan
        // berarti dipaksa berkenalan ulang, dan Pasal 4 nomor 5 melarang
        // penarikan izin dipersulit.
        await profiles.forgetPersonal(ownerId);
        await clearPending(ownerId);
        actionOffers.clear(ownerId);
        wipeComplete = true;
        if (wipeComplete) {
          memories.allow(ownerId);
          history.allow(ownerId);
        }

        await safeEdit(
          ctx,
          [
            `Udah aku lupain semuanya — ${removed} catatan dan seluruh riwayat obrolan kita.`,
            ...(stoppedRun
              ? [
                  "",
                  "Pekerjaan planning yang memakai konteks lama juga sudah kuhentikan dan record-nya dihapus.",
                ]
              : []),
            "",
            "Tugasmu nggak ikut kehapus. Kalau mau itu juga hilang, batalin satu per satu lewat daftarnya.",
          ].join("\n"),
        );
        return;
      }

      case "memallno": {
        const waiting = pending.take(ownerId, target);
        if (waiting?.kind !== "confirm-memory-wipe") {
          await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
          return;
        }
        await safeEdit(ctx, "Nggak jadi. Semuanya masih aku inget.");
        return;
      }

      default:
        return;
    }
  }

  async function handleFlowAction(
    ctx: Context,
    ownerId: string,
    target: string,
  ): Promise<void> {
    const selected = splitTarget(target);
    if (!selected) return;

    const offer = actionOffers.take(
      ownerId,
      selected.id,
      selected.operation,
    );
    if (!offer) {
      await dropKeyboard(ctx);
      await ctx.reply("Tombol ini sudah nggak berlaku.");
      return;
    }

    await dropKeyboard(ctx);
    await recordEvent(ownerId, "adaptive_action_chosen");

    switch (selected.operation) {
      case "listen": {
        await profiles.rememberStyle(ownerId, "listen");
        const response =
          "Oke, aku ingat pilihanmu. Aku dengerin dulu dan nggak akan buru-buru mengubah ceritamu jadi daftar atau saran. Kalau nanti kamu ingin saran langsung, bilang aja.";
        await ctx.reply(response);
        await history.append(ownerId, "harvy", response);
        return;
      }
      case "data_controls":
        await showControl(ctx, ownerId, "data");
        return;
      case "view_session":
        await showControl(ctx, ownerId, "active-session");
        return;
      case "stop_session": {
        const stopped = await sessions.stop(ownerId);
        await ctx.reply(
          stopped
            ? "Sesinya aku hentikan. Tujuannya nggak akan terus kubawa ke giliran berikutnya."
            : "Saat ini nggak ada sesi yang aktif.",
        );
        if (stopped) await recordEvent(ownerId, "session_stopped");
        return;
      }
      case "schedule_checkin": {
        const session = await sessions.active(ownerId);
        if (!session) {
          await ctx.reply("Mulai satu sesi dulu sebelum menjadwalkan check-in.");
          return;
        }
        await beginCheckInSetup(ctx, ownerId, session.id);
        return;
      }
      default:
        break;
    }

    const kind = SESSION_KIND_OF[selected.operation];
    if (!kind) return;

    let openingMessage: SentMessageRef | null = null;
    try {
      await sessions.startAfterDelivery(
        {
          ownerId,
          chatId: String(ctx.chat?.id ?? ownerId),
          kind,
          goal: offer.goal,
          taskId: offer.taskId,
        },
        async (candidate) => {
          openingMessage = await sendSessionTurn(
            ctx,
            ownerId,
            candidate,
            startInstruction(candidate.kind),
          );
        },
        async () => {
          if (!openingMessage) return;
          try {
            await bot.api.editMessageReplyMarkup(
              openingMessage.chatId,
              openingMessage.messageId,
              { reply_markup: { inline_keyboard: [] } },
            );
          } catch (error) {
            logger.warn(
              "session_keyboard_cleanup_failed",
              "Keyboard sesi gagal dinonaktifkan.",
              { error },
            );
          }
        },
      );
    } catch (error) {
      if (error instanceof ActiveSessionError) {
        await ctx.reply(
          [
            "Masih ada satu sesi aktif. Aku nggak akan menggantinya diam-diam.",
            "",
            formatSession(error.session, await timeZoneFor(ownerId)),
          ].join("\n"),
          { reply_markup: sessionActions(error.session) },
        );
        return;
      }
      throw error;
    }

    await recordEvent(ownerId, "session_started");
  }

  async function handleSessionAction(
    ctx: Context,
    ownerId: string,
    target: string,
  ): Promise<void> {
    const selected = splitTarget(target);
    if (!selected) return;
    const current = await sessions.active(ownerId);
    if (!current || current.id !== selected.id) {
      await dropKeyboard(ctx);
      await ctx.reply("Sesi dari tombol ini sudah nggak aktif.");
      return;
    }

    switch (selected.operation) {
      case "stop": {
        await sessions.stop(ownerId);
        await dropKeyboard(ctx);
        const response = await presentPrivateOperation(ownerId, {
          kind: "session-stopped",
          outcome: "success",
          userMessage: "Berhenti dari sesi ini",
          stableBody: "Status sesi: berhenti.",
          fallbackText: "Oke, sesi ini berhenti di sini.",
        });
        await ctx.reply(response);
        await recordEvent(ownerId, "session_stopped");
        return;
      }
      case "done": {
        await sessions.progress(ownerId, "done", current.id);
        await dropKeyboard(ctx);
        const response = await presentPrivateOperation(ownerId, {
          kind: "session-completed",
          outcome: "success",
          userMessage: "Sesi ini selesai",
          stableBody: "Status sesi: selesai.",
          fallbackText: "Selesai 🌿 Aku nggak akan terus mendorong sesi ini.",
        });
        await ctx.reply(response);
        await recordEvent(ownerId, "session_completed");
        return;
      }
      case "checkin":
        await dropKeyboard(ctx);
        await beginCheckInSetup(ctx, ownerId, current.id);
        return;
      default:
        break;
    }

    const explicitStage = stageForButton(current, selected.operation);
    if (explicitStage) {
      await dropKeyboard(ctx);
      const updated = await sessions.setStageAfterDelivery(
        ownerId,
        explicitStage,
        current.id,
        async (next) => {
          await sendSessionTurn(
            ctx,
            ownerId,
            next,
            instructionForButton(selected.operation),
          );
        },
      );
      if (updated) await recordEvent(ownerId, "session_progressed");
      return;
    }

    const signal: SessionSignal | null =
      selected.operation === "stuck" || selected.operation === "replan"
        ? "stuck"
        : selected.operation === "continue"
          ? "continue"
          : null;
    if (!signal) return;

    await dropKeyboard(ctx);
    const updated = await sessions.progressAfterDelivery(
      ownerId,
      signal,
      current.id,
      async (next) => {
        if (!next) return;
        await sendSessionTurn(
          ctx,
          ownerId,
          next,
          instructionForButton(selected.operation),
        );
      },
    );
    if (updated) await recordEvent(ownerId, "session_progressed");
  }

  async function handleCheckInOutcome(
    ctx: Context,
    ownerId: string,
    target: string,
  ): Promise<void> {
    const selected = splitTarget(target);
    if (!selected) return;
    const current = await sessions.active(ownerId);
    if (
      !current ||
      current.id !== selected.id ||
      !current.checkIn?.sentAt
    ) {
      await safeEdit(ctx, "Check-in ini sudah nggak aktif.");
      return;
    }

    switch (selected.operation) {
      case "done":
        await sessions.progress(ownerId, "done", current.id);
        await safeEdit(ctx, await presentPrivateOperation(ownerId, {
          kind: "session-completed",
          outcome: "success",
          userMessage: "Check-in ini selesai",
          stableBody: "Status sesi: selesai.",
          fallbackText: "Sip, selesai 🌿",
        }));
        await recordEvent(ownerId, "checkin_completed");
        await recordEvent(ownerId, "session_completed");
        return;
      case "ongoing":
        await safeEdit(
          ctx,
          await presentPrivateOperation(ownerId, {
            kind: "checkin-ongoing",
            outcome: "information",
            userMessage: "Pekerjaannya masih berjalan",
            stableBody: "Status sesi: masih berjalan.",
            fallbackText:
              "Oke, masih jalan. Aku nggak menjadwalkan pesan lain tanpa kamu minta.",
            allowedNextSteps: [
              "Harvy tidak akan menjadwalkan pesan lain kecuali kamu memintanya.",
            ],
          }),
          sessionActions(current),
        );
        return;
      case "stop":
        await sessions.stop(ownerId);
        await safeEdit(ctx, await presentPrivateOperation(ownerId, {
          kind: "session-stopped",
          outcome: "success",
          userMessage: "Hentikan sesi dan check-in",
          stableBody: "Status sesi dan check-in: berhenti.",
          fallbackText: "Oke, sesi dan check-in ini berhenti.",
        }));
        await recordEvent(ownerId, "session_stopped");
        return;
      case "stuck":
      case "replan": {
        await dropKeyboard(ctx);
        const updated = await sessions.progressAfterDelivery(
          ownerId,
          "stuck",
          current.id,
          async (next) => {
            if (!next) return;
            await sendSessionTurn(
              ctx,
              ownerId,
              next,
              selected.operation === "stuck"
                ? "Pengguna mengatakan ia tersangkut. Cari hambatan terdekat dan tawarkan satu penyesuaian kecil."
                : "Pengguna memilih mengubah rencana. Susun ulang langkah terdekat tanpa menyalahkan rencana sebelumnya.",
            );
          },
        );
        if (updated) await recordEvent(ownerId, "session_progressed");
        return;
      }
      default:
        return;
    }
  }

  async function sendSessionTurn(
    ctx: Context,
    ownerId: string,
    session: ActiveSession,
    instruction: string,
  ): Promise<SentMessageRef | null> {
    const [baseContext, profile] = await Promise.all([
      contextFor(ownerId, session.goal),
      profiles.load(ownerId),
    ]);
    const context = memoryContextCompiler &&
        typeof memoryContextCompiler.normalizePrivateBase === "function"
      ? await memoryContextCompiler.normalizePrivateBase(
          ownerId,
          session.goal,
          baseContext,
        )
      : baseContext;
    const timeZone = profile.timeZone ?? config.defaultTimezone;
    const response = normalizeTelegramText(
      await conversation.sessionReply(
        session,
        instruction,
        context,
        profile.stylePreference,
        null,
        { ownerId, timeZone },
      ),
    );
    let delivered = false;
    try {
      const sent = await sendReply(ctx, response, [], sessionActions(session));
      delivered = true;
      await markDeliveredForOwner(ownerId, currentTurnId(), ctx);
      await history.append(ownerId, "harvy", response);
      return sent;
    } catch (error) {
      if (!delivered) {
        await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      }
      throw error;
    }
  }

  async function beginCheckInSetup(
    ctx: Context,
    ownerId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await sessions.active(ownerId);
    if (!session || session.id !== sessionId) {
      await ctx.reply("Sesinya sudah berubah atau selesai.");
      return;
    }

    const profile = await profiles.load(ownerId);
    if (!profile.timeZone) {
      await sendPendingPrompt(
        ownerId,
        {
          kind: "checkin-settings",
          sessionId,
          step: "timezone",
        },
        () =>
          ctx.reply(
            "Sebelum menjadwalkan, pilih zona waktumu supaya aku nggak salah jam.",
            { reply_markup: timezoneActions() },
          ).then(() => undefined),
      );
      return;
    }

    if (!profile.quietHoursSetAt) {
      await sendPendingPrompt(
        ownerId,
        {
          kind: "checkin-settings",
          sessionId,
          step: "quiet-hours",
        },
        () =>
          ctx.reply(
            "Pilih jam ketika Harvy sebaiknya diam. Waktu check-in yang masuk rentang ini akan kutolak, bukan kugeser diam-diam.",
            { reply_markup: quietHoursActions() },
          ).then(() => undefined),
      );
      return;
    }

    await promptCheckInTime(ctx, ownerId, sessionId);
  }

  async function handleControlButton(
    ctx: Context,
    ownerId: string,
    target: string,
  ): Promise<void> {
    switch (target) {
      case "memories":
        await showMemories(ctx, ownerId);
        return;
      case "usage":
        await replyUsageDashboard(ctx, ownerId);
        return;
      case "data":
      case "timezone":
      case "quiet-hours":
      case "active-session":
      case "withdraw":
      case "export":
      case "delete-all":
        await showControl(
          ctx,
          ownerId,
          target === "withdraw"
            ? "withdraw-consent"
            : (target as ControlAction),
        );
        return;
      default:
        return;
    }
  }

  async function handleTimeZoneChoice(
    ctx: Context,
    ownerId: string,
    target: string,
  ): Promise<void> {
    if (
      !(INDONESIAN_TIME_ZONES as readonly string[]).includes(target)
    ) {
      return;
    }

    const profile = await profiles.setTimeZone(ownerId, target);
    const waiting = pending.peek(ownerId);
    await dropKeyboard(ctx);
    if (
      waiting?.kind === "checkin-settings" &&
      waiting.step === "timezone"
    ) {
      if (!profile.quietHoursSetAt) {
        await sendPendingPrompt(
          ownerId,
          {
            kind: "checkin-settings",
            sessionId: waiting.sessionId,
            step: "quiet-hours",
          },
          () =>
            ctx.reply(
              "Sekarang pilih jam tenangmu. Kamu juga boleh memilih tanpa jam tenang.",
              { reply_markup: quietHoursActions() },
            ).then(() => undefined),
        );
        return;
      }
      await promptCheckInTime(ctx, ownerId, waiting.sessionId);
      return;
    }

    await clearPending(ownerId);
    const fallbackText = `Zona waktu tersimpan.\n\n${formatTimeSettings(profile)}`;
    const response = await presentPrivateOperation(ownerId, {
      kind: "preference-updated",
      outcome: "success",
      userMessage: "Ubah zona waktu",
      stableBody: formatTimeSettings(profile),
      fallbackText,
    }, { timeZone: target });
    await ctx.reply(response);
  }

  async function handleQuietHoursChoice(
    ctx: Context,
    ownerId: string,
    target: string,
  ): Promise<void> {
    const waiting = pending.peek(ownerId);
    const sessionId =
      waiting?.kind === "checkin-settings" &&
      waiting.step === "quiet-hours"
        ? waiting.sessionId
        : null;

    if (target === "custom") {
      await dropKeyboard(ctx);
      await sendPendingPrompt(
        ownerId,
        {
          kind: "custom-quiet-hours",
          sessionId,
        },
        () =>
          ctx.reply(
            "Tulis rentangnya seperti “21.30–06.00”. Rentang boleh melewati tengah malam.",
          ).then(() => undefined),
      );
      return;
    }

    let quietHours: QuietHours | null = null;
    if (target !== "none") {
      const match = /^(\d{1,4})-(\d{1,4})$/u.exec(target);
      if (!match) return;
      quietHours = {
        startMinute: Number(match[1]),
        endMinute: Number(match[2]),
      };
    }

    const profile = await profiles.setQuietHours(ownerId, quietHours);
    await clearPending(ownerId);
    await dropKeyboard(ctx);
    if (sessionId) {
      await promptCheckInTime(ctx, ownerId, sessionId);
      return;
    }
    const fallbackText = `Jam tenang tersimpan.\n\n${formatTimeSettings(profile)}`;
    const response = await presentPrivateOperation(ownerId, {
      kind: "preference-updated",
      outcome: "success",
      userMessage: "Ubah jam tenang",
      stableBody: formatTimeSettings(profile),
      fallbackText,
    });
    await ctx.reply(response);
  }

  async function handleConsentWithdrawal(
    ctx: Context,
    ownerId: string,
    target: string,
  ): Promise<void> {
    const selected = splitTarget(target);
    if (!selected) {
      await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
      return;
    }
    const waiting = pending.take(ownerId, selected.id);
    if (waiting?.kind !== "confirm-consent-withdrawal") {
      await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
      return;
    }

    if (selected.operation === "no") {
      await safeEdit(ctx, "Nggak jadi. Izinmu tetap berlaku.");
      return;
    }
    if (selected.operation !== "yes") return;

    // Hak menarik izin tidak boleh bergantung pada kesehatan file checkpoint.
    // Tutup ingress/model lebih dulu, lalu persist keputusan pengguna.
    consentChecks.set(ownerId, Promise.resolve(false));
    abortActiveAgentWork(ownerId);
    pending.clear(ownerId);
    actionOffers.clear(ownerId);
    held.clear(ownerId);
    interactionContext.clear(interactionScope(ownerId));
    messageBatcher.invalidate(ownerId);
    history.suspend(ownerId);
    memories.suspend?.(ownerId);
    await profiles.withdrawConsent(ownerId);
    messageBatcher.invalidate(ownerId);
    try {
      await agentRuns?.forget("telegram", ownerId);
    } catch (error) {
      // `forget()` sudah memblokir scope di proses ini sebelum I/O. Consent
      // tetap tertarik; recovery/penerimaan consent berikutnya mencoba lagi.
      logger.error(
        "consent_agent_run_cleanup_failed",
        "Izin sudah ditarik tetapi file checkpoint belum dapat dibersihkan.",
        error,
      );
    }
    await recordEvent(ownerId, "consent_withdrawn");
    await safeEdit(
      ctx,
      "Izin AI sudah ditarik. Data, sesi, dan check-in yang ada tetap tersimpan, run agent tertunda sudah dibatalkan, dan check-in tidak dikirim sampai kamu setuju lagi. Pesan berikutnya akan kembali ke layar persetujuan.",
    );
  }

  async function handleFullDeletion(
    ctx: Context,
    ownerId: string,
    target: string,
  ): Promise<void> {
    const selected = splitTarget(target);
    if (!selected) {
      await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
      return;
    }
    const waiting = pending.take(ownerId, selected.id);
    if (waiting?.kind !== "confirm-full-deletion") {
      await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
      return;
    }

    if (selected.operation === "no") {
      await safeEdit(ctx, "Nggak jadi. Datamu tetap ada.");
      return;
    }
    if (selected.operation !== "yes") return;

    consentChecks.set(ownerId, Promise.resolve(false));
    abortActiveAgentWork(ownerId);
    // DataControlService memasang tombstone sebelum menyentuh store lain.
    // Jangan biarkan pre-clear checkpoint menggagalkan hak penghapusan sebelum
    // tombstone itu sempat ditulis.
    pending.clear(ownerId);
    actionOffers.clear(ownerId);
    held.clear(ownerId);
    interactionContext.clear(interactionScope(ownerId));
    messageBatcher.invalidate(ownerId);
    await dataControls.deleteAll(ownerId);
    messageBatcher.invalidate(ownerId);

    // Jangan menulis riwayat atau telemetry lagi setelah penghapusan.
    await safeEdit(
      ctx,
      "Seluruh data Harvy tentangmu sudah dihapus. Kalau menulis lagi, kita mulai dari persetujuan awal.",
    );
  }

  function splitTarget(
    target: string,
  ): { id: string; operation: string } | null {
    const separator = target.indexOf(".");
    if (separator <= 0 || separator === target.length - 1) return null;
    return {
      id: target.slice(0, separator),
      operation: target.slice(separator + 1),
    };
  }

  async function runtimeIsCurrent(
    runtime: ConversationRuntime,
  ): Promise<boolean> {
    if (runtime.signal?.aborted) return false;
    if (runtime.awaitCurrent && !(await runtime.awaitCurrent())) return false;
    if (runtime.signal?.aborted) return false;
    return runtime.isCurrent ? await runtime.isCurrent() : true;
  }

  async function appendUserHistory(
    ownerId: string,
    text: string,
    runtime: ConversationRuntime,
  ): Promise<StoredConversationTurn | null> {
    const stored = await history.append(ownerId, "user", text);
    if (stored) runtime.markUserCommitted?.();
    return stored;
  }

  function stageForButton(
    session: ActiveSession,
    operation: string,
  ): ActiveSession["stage"] | null {
    if (session.kind === "tutor") {
      if (operation === "attempt") return "attempt";
      if (operation === "hint") return "hint";
      if (operation === "direct") return "explain";
      if (operation === "retry") return "retry";
    }
    if (session.kind === "focus" && operation === "replan") return "reflect";
    return null;
  }

  function startInstruction(kind: SessionKind): string {
    switch (kind) {
      case "clarify":
        return "Mulai dengan merangkum kekusutan secara tentatif, lalu ajukan satu pertanyaan penjernih.";
      case "prioritize":
        return "Bantu memilih satu prioritas dengan menanyakan akibat dan kedekatan waktunya, tanpa membuat daftar panjang.";
      case "focus":
        return "Ubah tujuan menjadi satu langkah yang dapat dimulai dalam beberapa menit.";
      case "tutor":
        return "Mulai tahap assess: tanyakan apa yang sudah dipahami dan minta satu percobaan kecil sebelum memberi jawaban penuh.";
      case "plan":
        return "Susun rencana pendek yang dapat dikoreksi pengguna; mulai dari langkah terdekat.";
      case "human-bridge":
        return "Bantu menyusun draf pesan yang dapat diedit pengguna. Jangan mengirimnya dan jangan mengaku sudah menghubungi siapa pun.";
    }
  }

  function instructionForButton(operation: string): string {
    switch (operation) {
      case "attempt":
        return "Ajak pengguna mencoba satu bagian kecil dengan kata-katanya sendiri.";
      case "hint":
        return "Berikan satu petunjuk yang cukup untuk percobaan berikutnya, bukan jawaban lengkap.";
      case "direct":
        return "Pengguna memilih penjelasan langsung. Jelaskan jawabannya dengan jelas tanpa menahan informasi.";
      case "retry":
        return "Berikan kesempatan mencoba lagi dan kurangi bantuan bila ia sudah lebih paham.";
      case "stuck":
        return "Cari titik tersangkut yang paling dekat, lalu ubah satu hal kecil.";
      case "replan":
        return "Susun ulang langkah terdekat tanpa menyalahkan rencana sebelumnya.";
      case "continue":
        return "Lanjutkan satu tahap saja dan tutup dengan ruang bagi pengguna untuk menjawab.";
      default:
        return "Lanjutkan sesi satu tahap saja.";
    }
  }

  async function acceptConsent(
    ctx: Context,
    ownerId: string,
    target: string,
  ): Promise<void> {
    if (target === "info") {
      // Tombolnya dipindahkan ke pesan terbaru, bukan digandakan. Kalau papan
      // lama dibiarkan hidup, setiap ketukan menambah satu salinan penjelasan
      // yang sama — dan itu yang terjadi pada uji pertama.
      await dropKeyboard(ctx);
      await ctx.reply(
        consentDetail(
          config.telemetryRetentionDays,
          config.operationalLog.retentionDays,
        ),
        {
        reply_markup: consentActions(),
        },
      );
      return;
    }

    if (target !== "yes") return;

    // Checkpoint dari consent lama harus benar-benar hilang sebelum profil
    // dibuka kembali. Jika cleanup gagal, tombol tetap dapat dicoba lagi dan
    // consent tetap tertarik—lebih aman daripada mengandalkan block in-memory.
    await agentRuns?.forget("telegram", ownerId);
    await profiles.acceptConsent(ownerId);
    history.allow(ownerId);
    memories.allow?.(ownerId);
    await telemetry.allow(ownerId);
    agentRuns?.allow("telegram", ownerId);
    consentChecks.set(ownerId, Promise.resolve(true));
    await dropKeyboard(ctx);

    const waiting = held.takeBatch(ownerId);
    held.clear(ownerId);
    // Pemeriksaan bubble kedua dan seterusnya baru boleh terjadi setelah
    // consent berhasil dibuka. Batas bubble dipertahankan agar marker konteks
    // pada satu bubble tidak memveto bahaya eksplisit pada bubble lain.
    const explicitImmediateDanger = waiting.bubbles.some(
      hasExplicitImmediateDangerSignal,
    );

    await ctx.reply(CONSENT_ACCEPTED_EMOJI);
    await ctx.reply(waiting.text ? CONSENT_ACCEPTED_HELD : CONSENT_ACCEPTED);

    // Diproses langsung, bukan lewat batcher: pesannya sudah selesai ditulis
    // jauh sebelum tombol ditekan, jadi tidak ada batas giliran yang perlu
    // ditebak. Ini tetap berada di dalam antrean pengguna yang sama.
    if (waiting.text) {
      await handleFreeText(
        ctx,
        ownerId,
        waiting.text,
        {},
        ctx.update.update_id,
        explicitImmediateDanger,
      );
    }
  }

  async function refreshMemories(
    ctx: Context,
    ownerId: string,
    forgotten?: string,
    missing = false,
  ): Promise<void> {
    const heading = missing
      ? "Itu udah nggak ada."
      : forgotten
      ? `Udah aku lupain: ${forgotten}`
      : "Udah aku lupain.";
    await safeEdit(ctx, heading);
    await showMemories(ctx, ownerId);
  }

  async function scheduleReminder(
    ctx: Context,
    ownerId: string,
    taskId: string,
  ): Promise<void> {
    const task = await tasks.find(ownerId, taskId);
    if (!task || task.status === "completed") {
      await safeEdit(ctx, taskMissingNote());
      return;
    }

    const target = new Date(Date.now() + REMINDER_LEAD_MS);
    const profile = await profiles.load(ownerId);
    const timeZone = profile.timeZone ?? config.defaultTimezone;
    if (isInQuietHours(target, timeZone, profile.quietHours)) {
      await ctx.reply(
        "Satu jam lagi masuk jam tenangmu. Aku nggak menjadwalkannya diam-diam; pilih waktu lain lewat tombol Ingatkan.",
      );
      return;
    }

    const updated = await tasks.setReminder(ownerId, taskId, target);

    if (updated) {
      const fallbackText = [
        "Oke, nanti aku ingetin.",
        "",
        formatTask(updated, timeZone),
      ].join("\n");
      const response = await presentPrivateOperation(ownerId, {
        kind: "reminder-scheduled",
        outcome: "success",
        userMessage: "Ingatkan tugas ini satu jam lagi",
        stableBody: formatTask(updated, timeZone),
        fallbackText,
      }, { timeZone });
      await ctx.reply(response);
      return;
    }
    await safeEdit(ctx, taskMissingNote());
  }

  async function refreshAfterChange(
    ctx: Context,
    ownerId: string,
    change: { kind: "completed" | "removed"; title: string },
  ): Promise<void> {
    const remaining = await tasks.listActive(ownerId);
    const timeZone = await timeZoneFor(ownerId);
    const heading = change.kind === "completed"
      ? taskCompletedHeading(change.title)
      : taskDroppedHeading();
    const changeFact = change.kind === "completed"
      ? `Tugas selesai\n${change.title}`
      : `Tugas dibatalkan\n${change.title}`;

    if (remaining.length === 0) {
      const fallbackText = `${heading}\n\n${nothingLeftNote()}`;
      const response = await presentPrivateOperation(ownerId, {
        kind: change.kind === "completed" ? "task-completed" : "task-removed",
        outcome: "success",
        userMessage: change.title,
        stableBody: `${changeFact}\n\nTugas aktif: tidak ada.`,
        fallbackText,
      }, { timeZone });
      await safeEdit(ctx, response);
      return;
    }

    const fallbackText = [
      heading,
      "",
      "Sisanya:",
      "",
      ...remaining.map((task) => formatTask(task, timeZone)),
    ].join("\n");
    const response = await presentPrivateOperation(ownerId, {
      kind: change.kind === "completed" ? "task-completed" : "task-removed",
      outcome: "success",
      userMessage: change.title,
      stableBody: [
        changeFact,
        "",
        "Tugas aktif yang tersisa",
        "",
        ...remaining.map((task) => formatTask(task, timeZone)),
      ].join("\n"),
      fallbackText,
    }, { timeZone });
    await safeEdit(
      ctx,
      response,
      taskListActions(remaining),
    );
  }

  /** Menyerahkan status menunggu kepada giliran yang benar-benar berjalan. */
  function takeWaitingProgress(
    ownerId: string,
  ): TransientConversationProgress<SentMessageRef> | undefined {
    const waiting = waitingProgress.get(ownerId);
    waitingProgress.delete(ownerId);
    return waiting;
  }

  async function sendTaskList(
    ctx: Context,
    ownerId: string,
    sourceText = "/tugas",
  ): Promise<void> {
    const active = await tasks.listActive(ownerId);
    const timeZone = await timeZoneFor(ownerId);

    if (active.length === 0) {
      const fallbackText = emptyListNote();
      const response = await presentPrivateOperation(ownerId, {
        kind: "empty-state",
        outcome: "information",
        userMessage: sourceText,
        stableBody: "Tugas aktif: tidak ada.",
        fallbackText,
        allowedNextSteps: [
          "Kalau ada yang ingin kamu pegang, tulis saja dengan kalimat biasa.",
        ],
      }, { timeZone });
      await ctx.reply(response);
      interactionContext.record(interactionScope(ownerId), {
        domain: "task",
        operation: "list",
      });
      return;
    }

    const fallbackText = [
      taskListLead(),
      "",
      ...active.map((task, index) =>
        `${index + 1}. ${formatTask(task, timeZone)}`
      ),
    ].join("\n");
    const response = await presentPrivateOperation(ownerId, {
      kind: "task-list",
      outcome: "information",
      userMessage: sourceText,
      stableBody: [
        "Tugas aktif",
        "",
        ...active.map((task, index) =>
          `${index + 1}. ${formatTask(task, timeZone)}`
        ),
      ].join("\n"),
      fallbackText,
    }, { timeZone });
    await ctx.reply(response, { reply_markup: taskListActions(active) });
    // Pemetaan nomor dicatat hanya bila penomorannya benar-benar muncul pada
    // teks yang terkirim.
    //
    // Badan daftar disusun model, bukan teks tetap, sehingga penomoran yang
    // dikirim belum tentu bertahan pada balasan yang dilihat pengguna. Mencatat
    // pemetaan tanpa memeriksa itu berarti nomor yang tersimpan dapat menunjuk
    // tugas yang berbeda dari yang orangnya baca—dan pada pembatalan, itu
    // menghapus tugas yang salah.
    //
    // Nomornya sendiri hanya menyimpan frasa judul, bukan ID, sehingga ia
    // mengalir lewat jalur biasa dengan seluruh pagar konfirmasinya.
    const numbering = active.map((task, index) => `${index + 1}.`);
    const numberingVisible = numbering.every((prefix, index) =>
      response.includes(prefix) &&
      response.includes(active[index]!.title)
    );
    if (numberingVisible) {
      numberedOptions.record(ownerId, active.map((task) => task.title));
    } else {
      numberedOptions.forget(ownerId);
    }
    interactionContext.record(interactionScope(ownerId), {
      domain: "task",
      operation: "list",
    });
  }

  function enqueueBotAction(
    ctx: Context,
    ownerId: string,
    mode: "cancel" | "drain",
    errorLabel: string,
    action: () => Promise<void>,
  ): void {
    const guarded = () => withUsageAttribution(
      {
        turnId: randomUUID(),
        subjectKind: "private",
        channel: "telegram",
        actorAliases: [],
      },
      () => runGuardedAction(ctx, errorLabel, action),
    );

    if (mode === "cancel") {
      messageBatcher.cancelAndEnqueue(ownerId, guarded);
      return;
    }
    messageBatcher.drainAndEnqueue(ownerId, guarded);
  }

  function shouldUseAgentRuntime(
    understanding: Understanding,
    requiresLiveState: boolean,
    requiresAgentPlanning: boolean,
    unhandledTaskChange = false,
  ): boolean {
    return requiresLiveState || requiresAgentPlanning || unhandledTaskChange ||
      requestsAgentTooling(understanding.routingAssessment);
  }

  async function handleNaturalProjectIntent(
    ctx: Context,
    ownerId: string,
    text: string,
    understanding: Understanding,
    context: HarvyContext,
    runtime: ConversationRuntime,
  ): Promise<boolean> {
    const proposed = understanding.semanticOperation;
    // Extractor sesekali tidak mengusulkan apa pun untuk kalimat yang sama.
    // Ketika itu terjadi pada pertanyaan status CodingRun, pengenalannya
    // diambil alih kode—jatuh ke planner generik membuat jawabannya mengarang
    // progres dari daftar tugas belajar.
    const semantic = naturalSurfaceAuthorized(text, proposed)
      ? proposed
      : codingRunStatusOperation(text);
    if (!semantic) return false;

    // Dicatat begitu otorisasi lolos, sebelum bercabang pada ketersediaan
    // runtime. Sebelum ini cabang "runtime coding mati" membalas lalu keluar
    // tanpa jejak apa pun, sehingga pemeriksaan live tidak dapat membedakan
    // operasi yang tidak pernah diusulkan extractor dari operasi yang
    // diusulkan, diotorisasi, lalu ditolak deployment. Keduanya terlihat
    // sebagai kekosongan yang sama.
    logger.info(
      "semantic_route_selected",
      "Permukaan bahasa alami project/coding terotorisasi.",
      {
        semanticDomain: semantic.domain,
        semanticOperation: semantic.operation,
        confidenceBucket: semanticConfidenceBucket(semantic),
        route: "natural-surface",
        // Benar ketika operasinya berasal dari pengenalan kode, bukan usulan
        // extractor. Membedakan keduanya di log adalah satu-satunya cara
        // pemeriksaan live tahu jalur mana yang sebenarnya menyala.
        deterministic: semantic !== proposed,
      },
    );

    if (!codingRuntime) {
      const response = "Runtime coding belum diaktifkan oleh deployment Harvy.";
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return true;
    }
    if (!await codingConsent(ctx, ownerId)) return true;
    const actor = privateCodingActor(ctx, codingRuntime);

    try {
      let response: string | null = null;
      if (semantic.domain === "project" && semantic.operation === "list") {
        const projects = await codingRuntime.application.listProjects(actor);
        response = projects.length === 0
          ? "Workspace aktif belum mempunyai project."
          : ["Project di workspace aktif:", ...projects.map((project) =>
              `• ${project.projectId} — ${project.source}, revision ${project.revision}`
            )].join("\n");
      } else if (semantic.domain === "project" && semantic.operation === "show") {
        const current = await codingRuntime.application.current(actor);
        const selected = current.selection;
        response = selected.projectId
          ? [
              "Project aktif:",
              `Workspace: ${selected.workspaceKey}`,
              `Project: ${selected.projectId}`,
              `Revision: ${selected.projectRevision}`,
            ].join("\n")
          : "Belum ada project aktif.";
      } else if (semantic.domain === "goal" && semantic.operation === "show") {
        response = renderProjectGoal(await codingRuntime.application.currentGoal(actor));
      } else if (semantic.domain === "goal" && semantic.operation === "complete") {
        response = renderProjectGoal(await codingRuntime.application.completeGoal(actor));
      } else if (semantic.domain === "skill" && semantic.operation === "list") {
        response = renderProjectSkills(await codingRuntime.application.listSkills(actor));
      } else if (semantic.domain === "coding" && semantic.operation === "show") {
        // Padanan bahasa alami untuk /code_status.
        const run = (await codingRuntime.application.current(actor)).run;
        response = run
          ? renderCodingRunAnchor(run).text
          : "Tidak ada CodingRun foreground aktif.";
      } else if (semantic.domain === "coding" && semantic.operation === "cancel") {
        // Padanan bahasa alami untuk /code_cancel. Membatalkan hanya
        // menghentikan pekerjaan milik pengguna sendiri; tidak ada yang
        // terhapus, dan menunggu invokasi tegas justru membuat "stop" gagal
        // pada saat ia paling dibutuhkan.
        const cancelled = await codingRuntime.application.cancel(actor);
        const anchor = codingAnchors.get(ownerId);
        if (anchor?.runId === cancelled.runId) {
          await flushCodingAnchor(cancelled, anchor.chatId, anchor.messageId);
          codingAnchors.delete(ownerId);
          response = null;
        } else {
          response = renderCodingRunAnchor(cancelled).text;
        }
      } else {
        const proposal = await conversation.interpretProjectIntent(
          text,
          semantic,
          context,
          runtime,
        );
        if (!proposal) {
          response = "Aku menangkap tindakan projectnya, tetapi detailnya belum cukup pasti. Jelaskan nama, tujuan, atau skill yang dimaksud dalam satu pesan.";
        } else if (proposal.kind === "project-create") {
          const selected = await codingRuntime.application.createBlankProject(
            actor,
            proposal.displayName,
          );
          response = [
            `Project kosong “${proposal.displayName}” sudah dibuat dan dipilih.`,
            `Workspace: ${selected.workspaceKey}`,
            `Project: ${selected.projectId}`,
            "Berikutnya tetapkan tujuan dan bukti selesai yang kamu inginkan.",
          ].join("\n");
        } else if (proposal.kind === "goal-set") {
          response = renderProjectGoal(await codingRuntime.application.setGoal(actor, {
            objective: proposal.objective,
            acceptanceCriteria: proposal.acceptanceCriteria,
            ...(proposal.milestones ? { milestones: proposal.milestones } : {}),
          }));
        } else if (proposal.kind === "goal-block") {
          response = renderProjectGoal(await codingRuntime.application.addGoalBlocker(
            actor,
            proposal.summary,
          ));
        } else if (proposal.kind === "goal-resolve") {
          response = renderProjectGoal(
            await codingRuntime.application.resolveGoalBlockerByReference(
              actor,
              proposal.query,
            ),
          );
        } else if (proposal.kind === "skill-create") {
          const { kind: _kind, ...definition } = proposal;
          response = renderProjectSkill(
            await codingRuntime.application.createSkillFromLatestEvidence(
              actor,
              definition,
            ),
          );
        } else if (proposal.kind === "skill-apply") {
          const chatId = ctx.chat?.id;
          if (chatId === undefined) throw new Error("Chat Telegram tidak tersedia.");
          let anchorMessageId: number | null = null;
          let pendingRun: CodingRun | null = null;
          const handle = await codingRuntime.application.startCodingWithSkill(
            actor,
            proposal.nameOrId,
            proposal.request,
            async (run) => {
              pendingRun = run;
              if (anchorMessageId !== null) {
                scheduleCodingAnchor(run, chatId, anchorMessageId);
              }
            },
          );
          const sent = await ctx.reply(handle.initialAnchor.text);
          anchorMessageId = sent.message_id;
          codingAnchors.set(ownerId, {
            runId: handle.runId,
            chatId,
            messageId: sent.message_id,
          });
          if (pendingRun) scheduleCodingAnchor(pendingRun, chatId, sent.message_id);
          trackCodingCompletion(ctx, ownerId, handle, sent.message_id);
          await history.append(ownerId, "harvy", handle.initialAnchor.text);
          return true;
        }
      }

      if (!response || !(await runtimeIsCurrent(runtime))) return true;
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      logger.info("semantic_route_selected", "Intent project natural dijalankan.", {
        semanticDomain: semantic.domain,
        semanticOperation: semantic.operation,
        confidenceBucket: semanticConfidenceBucket(semantic),
        route: "project-intent",
        deterministic: false,
      });
      return true;
    } catch (error) {
      const response = error instanceof Error
        ? error.message
        : "Tindakan project belum dapat dijalankan.";
      if (await runtimeIsCurrent(runtime)) {
        await ctx.reply(response);
        await history.append(ownerId, "harvy", response);
      }
      return true;
    }
  }

  async function runGuardedAction(
    ctx: Context,
    errorLabel: string,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      logger.error(
        "guarded_action_failed",
        errorLabel.replace(/:$/, ""),
        error,
      );
      try {
        await ctx.reply(
          aiFailureMessage(error, "Ada yang gagal diproses. Coba lagi sebentar, ya."),
        );
      } catch (replyError) {
        logger.error(
          "failure_notice_delivery_failed",
          "Pemberitahuan kegagalan juga tidak terkirim.",
          replyError,
        );
      }
    }
  }
}

function ownerOf(ctx: Context): string {
  return String(ctx.from?.id ?? ctx.chat?.id ?? "tidak-dikenal");
}

function commandTail(text: string, command: string): string {
  const pattern = new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?(?:\\s+|$)`, "iu");
  return text.replace(pattern, "").trim();
}

function telegramImageMediaType(
  value: string | undefined,
): ChatImageMediaType | null {
  switch (value?.trim().toLocaleLowerCase("en-US")) {
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/png":
      return "image/png";
    case "image/webp":
      return "image/webp";
    default:
      return null;
  }
}

async function downloadTelegramImage(
  botToken: string,
  filePath: string,
  mediaType: ChatImageMediaType,
  declaredSize?: number,
): Promise<Buffer> {
  const maximum = 5 * 1024 * 1024;
  if (
    (declaredSize !== undefined &&
      (!Number.isSafeInteger(declaredSize) || declaredSize < 1 ||
        declaredSize > maximum)) ||
    !/^[A-Za-z0-9_./-]{1,512}$/u.test(filePath) ||
    filePath.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("Descriptor gambar Telegram tidak sah atau terlalu besar.");
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  let response: Response;
  try {
    response = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${encodedPath}`,
      {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch {
    throw new Error("Download gambar Telegram gagal.");
  }
  const contentLength = Number(response.headers.get("content-length") ?? "NaN");
  if (
    !response.ok || !response.body ||
    (Number.isFinite(contentLength) &&
      (!Number.isSafeInteger(contentLength) || contentLength < 1 ||
        contentLength > maximum))
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Response gambar Telegram tidak sah atau terlalu besar.");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) throw new Error("Gambar Telegram melewati batas 5 MiB.");
      chunks.push(Buffer.from(item.value));
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("Download gambar Telegram gagal atau melewati batas.");
  } finally {
    reader.releaseLock();
  }
  if (total < 1 || (declaredSize !== undefined && total !== declaredSize)) {
    throw new Error("Ukuran gambar Telegram tidak cocok descriptor.");
  }
  const image = Buffer.concat(chunks, total);
  if (!hasImageSignature(image, mediaType)) {
    throw new Error("Isi gambar Telegram tidak cocok format yang dinyatakan.");
  }
  return image;
}

function hasImageSignature(
  data: Uint8Array,
  mediaType: ChatImageMediaType,
): boolean {
  if (mediaType === "image/jpeg") {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 &&
      data[2] === 0xff;
  }
  if (mediaType === "image/png") {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return data.length >= png.length && png.every((byte, index) =>
      data[index] === byte
    );
  }
  return data.length >= 12 &&
    String.fromCharCode(...data.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...data.slice(8, 12)) === "WEBP";
}

async function downloadTelegramZip(
  botToken: string,
  filePath: string,
  declaredSize?: number,
): Promise<Buffer> {
  const maximum = 32 * 1024 * 1024;
  if (
    (declaredSize !== undefined &&
      (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > maximum)) ||
    !/^[A-Za-z0-9_./-]{1,512}$/u.test(filePath) ||
    filePath.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error("Descriptor ZIP Telegram tidak sah atau terlalu besar.");
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  let response: Response;
  try {
    response = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${encodedPath}`,
      {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch {
    throw new Error("Download ZIP Telegram gagal.");
  }
  const contentLength = Number(response.headers.get("content-length") ?? "NaN");
  if (
    !response.ok || !response.body ||
    (Number.isFinite(contentLength) &&
      (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maximum))
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Response ZIP Telegram tidak sah atau terlalu besar.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) throw new Error("ZIP Telegram melewati batas 32 MiB.");
      chunks.push(Buffer.from(item.value));
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("Download ZIP Telegram gagal atau melewati batas.");
  } finally {
    reader.releaseLock();
  }
  if (total < 1 || (declaredSize !== undefined && total !== declaredSize)) {
    throw new Error("Ukuran ZIP Telegram tidak cocok descriptor.");
  }
  return Buffer.concat(chunks, total);
}

function isTerminalCodingRun(run: CodingRun): boolean {
  return run.status === "completed" || run.status === "failed" ||
    run.status === "cancelled" || run.status === "stale" ||
    run.status === "partial";
}

function publishCapabilityLabel(capability: PrivateGitHubPublishOffer["capability"]): string {
  switch (capability) {
    case "github.branch.create": return "buat branch";
    case "github.push_branch": return "push exact commit";
    case "github.workflow.write": return "push workflow exact";
    case "github.pr.create": return "buat draft PR";
  }
}

function telegramUpdateKind(ctx: Context): string {
  if (ctx.callbackQuery) return "callback_query";
  if (ctx.message?.text?.startsWith("/")) return "command";
  if (ctx.message?.text) return "text_message";
  return "other";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    timer.unref?.();
  });
}

function interruptibleBubblePause(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });

    function done(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function dropKeyboardSafely(
  ctx: Context,
  logger: OperationalLogger,
): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup();
  } catch (error) {
    // Pesan mungkin sudah berubah di sisi Telegram; bukan kegagalan nyata.
    logger.debug(
      "telegram_keyboard_cleanup_skipped",
      "Keyboard Telegram tidak dapat dihapus; pesan mungkin sudah berubah.",
      { error },
    );
  }
}

async function safeEditSafely(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
  logger: OperationalLogger = NOOP_OPERATIONAL_LOGGER,
): Promise<void> {
  const options = keyboard ? { reply_markup: keyboard } : {};

  try {
    await ctx.editMessageText(text, options);
  } catch (error) {
    logger.warn(
      "telegram_edit_fallback",
      "Edit pesan Telegram gagal; Harvy mengirim pesan baru sebagai fallback.",
      { error },
    );
    await ctx.reply(text, options);
  }
}
