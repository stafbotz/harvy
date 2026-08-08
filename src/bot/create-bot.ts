import {
  Bot,
  InputFile,
  type Context,
  type InlineKeyboard,
} from "grammy";
import { randomUUID } from "node:crypto";
import type { HarvyContext } from "../ai/context.js";
import type { Conversation, ConversationRuntime } from "../ai/conversation.js";
import {
  currentUsageAttribution,
  withUsageAttribution,
} from "../ai/usage-attribution.js";
import { selectAgentMode } from "../ai/model-policy.js";
import { liveStateRequirement } from "../ai/agent.js";
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
import type { AppConfig } from "../config.js";
import {
  adaptiveActions,
  replyHasBlockingQuestion,
} from "../core/action-policy.js";
import { HISTORY_WINDOW } from "../core/history-policy.js";
import type { HistoryService } from "../core/history-service.js";
import type { InsightService } from "../core/insight-service.js";
import { isSensitiveMemory } from "../core/memory-policy.js";
import type { MemoryService } from "../core/memory-service.js";
import { ProfileService, shouldAskStyle } from "../core/profile-service.js";
import type { DataControlService } from "../core/data-control-service.js";
import {
  AgentRunConflictError,
  type AgentRunService,
} from "../core/agent-run-service.js";
import { needsReplyReview } from "../core/safety-policy.js";
import {
  ActiveSessionError,
  type SessionService,
} from "../core/session-service.js";
import {
  authorizedSessionSignal,
  sessionAppliesToMessage,
} from "../core/session-policy.js";
import type { TaskService } from "../core/task-service.js";
import {
  UsageLimitError,
  type TelemetryService,
  type TurnTelemetrySignal,
} from "../core/telemetry-service.js";
import {
  INDONESIAN_TIME_ZONES,
  isInQuietHours,
  parseQuietHours,
} from "../core/time-policy.js";
import {
  safeFallbackReply,
  URGENT_ACKNOWLEDGEMENT,
  uncertainTriage,
  withEmergencyAvailability,
  type RiskTriage,
} from "../ai/safety.js";
import type { MemoryItem } from "../domain/memory.js";
import type { QuietHours, StylePreference } from "../domain/profile.js";
import type {
  ActiveSession,
  SessionKind,
  SessionSignal,
} from "../domain/session.js";
import type { StudentTask } from "../domain/task.js";
import {
  bubblePauseMs,
  adaptiveActionLabel,
  adaptiveActionButtons,
  CHECK_IN_MESSAGE,
  checkInOutcomeActions,
  confirmActions,
  dataControlActions,
  deleteAllConfirmActions,
  formatMemories,
  formatSession,
  formatTask,
  formatTimeSettings,
  formatUsage,
  HELP_MESSAGE,
  helpActions,
  memoryConsentActions,
  memoryListActions,
  memoryNoteActions,
  memoryNoteLines,
  memoryWipeConfirmActions,
  mergeKeyboards,
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
import { ActionOfferStore } from "./action-offers.js";
import { MessageBatcher } from "./message-batcher.js";
import {
  CONSENT_ACCEPTED,
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
  immediateUnderstandingRoute,
  taskToOffer,
} from "./understanding-route.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

/** Jarak bawaan antara pengingat dan tenggat. */
const REMINDER_LEAD_MS = 60 * 60 * 1000;

const AI_FAILURE_MESSAGE =
  "Maaf, aku lagi nggak bisa mikir sekarang — sambungan ke otakku lagi bermasalah. Coba kirim lagi sebentar lagi, ya.";
const AI_USAGE_LIMIT_MESSAGE =
  "Pemakaian AI-mu untuk 24 jam terakhir sudah mencapai batas yang dipasang. Aku tetap memeriksa pesan yang menyangkut keselamatan, tapi percakapan biasa perlu menunggu sampai pemakaian lama keluar dari jendela 24 jam.";

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
): HarvyBot {
  const currentTurnId = (): string | null =>
    currentUsageAttribution()?.turnId ?? null;
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
  const dropKeyboard = (ctx: Context): Promise<void> =>
    dropKeyboardSafely(ctx, logger);
  const safeEdit = (
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> => safeEditSafely(ctx, text, keyboard, logger);
  const bot = new Bot(config.telegramBotToken);
  const pending = new PendingStore();
  const held = new HeldMessageStore();
  const actionOffers = new ActionOfferStore();
  let latestTelegramUpdateId = -1;

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
    async (text, ownerId, turnId) => {
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
          return conversation.classifyTurnBoundary(text, ownerId);
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
          },
          batch.firstIngressSequence ?? batch.carrier.update.update_id,
        ),
      );
    },
    undefined,
    undefined,
    undefined,
    undefined,
    logger.child("telegram.message-batcher"),
    (metrics) => telemetry.recordTurn({
      ...metrics,
      subjectKind: "private",
      channel: "telegram",
    }),
  ).onUrgent(async (_ownerId, batch) => {
    // Observer dimulai lebih dulu agar lifecycle-nya terurut sebelum
    // `recordTurn`, tetapi tidak ditunggu: telemetry tidak boleh menahan ACK.
    void noteTurnSignal(
      _ownerId,
      "urgent-acknowledgement",
      batch.turnId,
    );
    await batch.carrier.reply(URGENT_ACKNOWLEDGEMENT);
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
        await clearPending(ownerId);
        actionOffers.clear(ownerId);
        await ctx.reply(HELP_MESSAGE, { reply_markup: helpActions() });
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

  bot.on("message:text", (ctx) => {
    const ownerId = ownerOf(ctx);
    const text = ctx.message.text.trim();

    if (text.startsWith("/")) {
      enqueueBotAction(
        ctx,
        ownerId,
        "cancel",
        "Perintah tak dikenal gagal ditanggapi:",
        async () => {
          await ctx.reply(
            ["Aku belum punya perintah itu.", "", HELP_MESSAGE].join("\n"),
          );
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
    drainPending: async () => {
      await drainIngress();
      await drainOnboarding();
      await messageBatcher.drainAll();
      await history.drain?.();
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
      sent = await sessions.deliverCheckIn(candidate, async (current) => {
        await bot.api.sendMessage(current.chatId, CHECK_IN_MESSAGE, {
          reply_markup: checkInOutcomeActions(current),
        });
        await history.append(current.ownerId, "harvy", CHECK_IN_MESSAGE);
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
        sent = await tasks.deliverReminder(candidate, async (current) => {
          const response = [`🔔 Pengingat`, "", `• ${current.title}`].join(
            "\n",
          );
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
        messageBatcher.enqueue(ownerId, text, ctx, ctx.update.update_id);
        return;
      }
      await beginOnboarding(ctx, ownerId, text);
    });
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

  /**
   * Setiap pesan bebas dibaca model lebih dulu. Tugas hanya dicatat ketika
   * maksudnya memang mencatat pekerjaan; selebihnya Harvy menjawab sebagai
   * teman bicara dan hanya *menawarkan* pencatatan.
   */
  async function handleFreeText(
    ctx: Context,
    ownerId: string,
    text: string,
    runtime: ConversationRuntime = {},
    firstIngressUpdateId = ctx.update.update_id,
  ): Promise<void> {
    // Indikator muncul ketika Harvy benar-benar mulai menangani satu giliran,
    // bukan pada setiap bubble saat ia masih menyimak.
    actionOffers.clear(ownerId);
    await bestEffortTyping(ctx, logger);

    // Konteks disusun sebelum pesan ini ikut tercatat, supaya giliran yang
    // sedang ditangani tidak muncul dua kali di dalam promptnya sendiri.
    const [context, profile, activeSession] = await Promise.all([
      contextFor(ownerId, text),
      profiles.load(ownerId),
      sessions.active(ownerId),
    ]);
    const engagedSession =
      activeSession && sessionAppliesToMessage(activeSession, text)
        ? activeSession
        : null;
    const timeZone = profile.timeZone ?? config.defaultTimezone;
    if (!(await runtimeIsCurrent(runtime))) return;

    // Pertanyaan identitas model yang berdiri sendiri adalah fakta produk,
    // sehingga tetap dapat dijawab saat model dasar atau kuota biasa sedang
    // tidak tersedia. Pesan campuran tetap masuk triase penuh.
    if (canUseModelIdentityFastPath(text, context.turns)) {
      await noteTurnSignal(ownerId, "deterministic-fast-path");
      await history.append(ownerId, "user", text);
      if (!(await runtimeIsCurrent(runtime))) return;
      await ctx.reply(CAPYBARA_MODEL_REPLY);
      await history.append(ownerId, "harvy", CAPYBARA_MODEL_REPLY);
      void history.compact(ownerId);
      return;
    }

    if (canUseDirectTimeFastPath(text, context.turns)) {
      const response = conversation.deterministicTimeReply(timeZone);
      await noteTurnSignal(ownerId, "deterministic-fast-path");
      await history.append(ownerId, "user", text);
      if (!(await runtimeIsCurrent(runtime))) return;
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      void history.compact(ownerId);
      return;
    }

    let understanding: Understanding | null;
    let triage: RiskTriage;
    let userAlreadyAppended = false;
    let pendingRisk: RiskTriage | null | undefined;

    // Jawaban formulir sempit tidak perlu melewati ekstraksi intent umum.
    // Triase tetap berjalan lebih dulu; bila gagal atau berisiko, pending tidak
    // dikonsumsi dan pesan masuk jalur percakapan keselamatan.
    // `drainPending()` pada shutdown/test dapat mem-flush bubble sebelum timer
    // klasifikasi sempat memuat checkpoint dari disk. Boundary handler tetap
    // menjadi authority terakhir agar restart tidak bergantung pada timer UX.
    const restoredAtStart = await restoreAgentPending(ownerId);
    const waitingAtStart = restoredAtStart && pendingAnswerIsEligible(
      firstIngressUpdateId,
      restoredAtStart,
    )
      ? restoredAtStart
      : null;
    if (waitingAtStart) {
      pendingRisk = await conversation
        .triageRisk(text, ownerId, context, runtime.signal)
        .catch((error: unknown) => {
          logger.error(
            "pending_answer_triage_failed",
            "Triase keselamatan untuk jawaban tertunda gagal.",
            error,
          );
          return null;
        });
      if (!(await runtimeIsCurrent(runtime))) {
        await telemetry.discardUndelivered?.(ownerId, currentTurnId());
        return;
      }
      if (
        pendingRisk?.certain &&
        pendingRisk.level === "biasa"
      ) {
        await history.append(ownerId, "user", text);
        userAlreadyAppended = true;
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
    }

    // Kedua hasil ditangkap terpisah. Batas pemakaian boleh menolak ekstraksi,
    // tetapi tidak boleh membuang hasil triase yang memang selalu dibebaskan.
    const [readResult, risk] = await Promise.all([
      conversation
        .understand(text, context, {
          ...runtime,
          ownerId,
          timeZone,
          session: engagedSession,
        })
        .then(
          (value) => ({ value } as const),
          (error: unknown) => ({ error } as const),
        ),
      pendingRisk === undefined
          ? conversation
            .triageRisk(text, ownerId, context, runtime.signal)
            .catch((error: unknown) => {
              logger.error(
                "risk_triage_failed",
                "Triase keselamatan gagal.",
                error,
              );
              return null;
            })
        : Promise.resolve(pendingRisk),
    ]);
    if (!(await runtimeIsCurrent(runtime))) {
      await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      return;
    }

    if ("error" in readResult) {
      logger.error(
        "message_understanding_failed",
        "Pemahaman pesan gagal.",
        readResult.error,
      );
      if (!risk || risk.level !== "biasa") {
        understanding = safetyUnderstanding();
      } else {
        if (!userAlreadyAppended) {
          await history.append(ownerId, "user", text);
        }
        const response =
          readResult.error instanceof UsageLimitError
            ? AI_USAGE_LIMIT_MESSAGE
            : AI_FAILURE_MESSAGE;
        if (!(await runtimeIsCurrent(runtime))) {
          await telemetry.discardUndelivered?.(ownerId, currentTurnId());
          return;
        }
        await ctx.reply(response);
        await history.append(ownerId, "harvy", response);
        return;
      }
    } else {
      understanding = readResult.value;
      if (!understanding && risk && risk.level !== "biasa") {
        understanding = safetyUnderstanding();
      }
    }

    // Triase yang gagal tidak boleh terlihat seperti percakapan yang baik-baik
    // saja ketika ekstraksi masih menemukan sinyal keselamatan.
    if (risk === null) {
      await noteTurnSignal(ownerId, "risk-triage-unavailable");
    }
    triage =
      risk ?? uncertainTriage(understanding?.safetySensitive === true);
    if (understanding?.safetySensitive === true && triage.level === "biasa") {
      // Dua penilai berjalan independen. Satu suara "biasa" tidak boleh
      // membatalkan sinyal keselamatan dari penilai lain lalu membuka mutasi.
      triage = uncertainTriage(true);
    }
    if (triage.level !== "biasa" || !triage.certain) {
      // Sesi, kontrol, dan mutasi tidak boleh membentuk giliran keselamatan.
      // Ekstraksi tetap berjalan paralel demi latensi, tetapi hasil operasional
      // itu dibuang sebelum balasan disusun.
      understanding = safetyUnderstanding();
    }

    if (!userAlreadyAppended) {
      await history.append(ownerId, "user", text);
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

      // Jawaban sempit dari tombol tetap baru diproses setelah triase. Pesan
      // berisiko di tengah edit waktu/memori harus masuk jalur keselamatan,
      // bukan dianggap sebagai nilai formulir.
      const pendingNow = pending.peek(ownerId);
      const waiting = pendingNow && pendingAnswerIsEligible(
        firstIngressUpdateId,
        pendingNow,
      )
        ? pendingNow
        : null;
      if (
        triage.level === "biasa" &&
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

      const mutationsAllowed = triage.certain && triage.level === "biasa";
      // Pertanyaan state-live yang dikenali pagar lokal harus selalu mencapai
      // runtime read-only. Label intent/action model tidak boleh membajaknya ke
      // kontrol memori atau kontrol data sebelum tool authority hidup.
      const requiresLiveState = liveStateRequirement(text) !== null;
      const requiresAgentPlanning = isExplicitPlanningRequest(text);
      const proposedRoute = immediateUnderstandingRoute(understanding, text);
      const route =
        mutationsAllowed && !requiresLiveState && !requiresAgentPlanning
        ? proposedRoute
        : ({ kind: "conversation" } as const);

      if (route.kind === "memory-control") {
        await clearPending(ownerId);
        await showMemories(ctx, ownerId);
        return;
      }

      if (route.kind === "control") {
        await clearPending(ownerId);
        await showControl(ctx, ownerId, route.action);
        return;
      }

      const offeredTask = mutationsAllowed
        ? taskToOffer(understanding)
        : null;
      const styleEligible =
        shouldAskStyle(profile) &&
        context.turns.length >= HISTORY_WINDOW &&
        !activeSession;
      const proposedActions =
        !activeSession &&
        route.kind === "conversation" &&
        understanding.memories.length === 0 &&
        offeredTask === null &&
        !styleEligible &&
        !(profile.stylePreference === "listen" &&
          understanding.intent === "feeling")
          ? adaptiveActions(understanding.suggestedActions ?? [], {
              intent: understanding.intent,
              risk: triage.level,
              hasActiveSession: false,
              hasBlockingQuestion: false,
            })
          : [];
      const actionGoal =
        understanding.actionGoal?.trim() ||
        understanding.task?.title.trim() ||
        (proposedActions[0] === "listen" ? "Menyimak cerita ini" : "");
      const plannedActions = actionGoal ? proposedActions : [];

      // Balasan disusun lebih dulu, termasuk untuk pesan yang berisi tugas.
      // Kalimat yang membawa perasaan sekaligus pekerjaan pernah dijawab hanya
      // dengan struk pencatatan, dan bagian perasaannya hilang tanpa jejak.
      let reply: string | null = null;
      let debitDeliveredReply = true;
      let agentPending: Extract<Pending, { kind: "agent-input" }> | null = null;
      let agentCheckpointWarning: string | null = null;
      const agentIntent =
        understanding.intent === "request" || requiresAgentPlanning
          ? "request"
          : "question";
      try {
        if (mutationsAllowed && isDirectTimeQuestion(text)) {
          reply = conversation.deterministicTimeReply(timeZone);
        } else if (
          mutationsAllowed &&
          !activeSession &&
          route.kind === "conversation" &&
          (understanding.intent === "question" ||
            understanding.intent === "request" ||
            requiresLiveState ||
            requiresAgentPlanning)
        ) {
          const mode = selectAgentMode({
            intent: agentIntent,
            messageLength: text.length,
            needsStepByStep: understanding.needsStepByStep,
          });
          const planningMode = requiresAgentPlanning
            ? "orchestrate"
            : mode;
          if (
            !isModelIdentityQuestion(text) &&
            shouldUseAgentRuntime(text, planningMode)
          ) {
            const agentResult = await conversation.agent(
              text,
              planningMode,
              context,
              {
                ...runtime,
                ownerId,
                channel: "telegram",
                timeZone,
                style: profile.stylePreference,
                intent: agentIntent,
              },
            );
            if (agentResult.status === "stopped") {
              logger.warn(
                "agent_run_stopped",
                "Run agent dihentikan oleh guard runtime.",
                {
                  status: agentResult.status,
                  reason: agentResult.reason,
                  outcome: agentResult.trace.at(-1)?.outcome,
                  count: agentResult.trace.length,
                },
              );
            }
            // `needs_input` adalah prompt model yang benar-benar dikirim, jadi
            // usage-nya diselesaikan setelah delivery seperti jawaban final.
            // Status lain di bawah diganti copy deterministik adapter.
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
            reply = agentResult.status === "completed"
              ? agentResult.reply
              : agentResult.status === "needs_input"
                ? agentResult.prompt
                : agentResult.status === "needs_approval"
                  ? "Aku menghentikan run ini karena agent baca-saja meminta izin untuk perubahan yang tidak tersedia."
                  : agentResult.reason === "deadline"
                    ? "Aku belum menyelesaikan run ini sebelum batas waktunya. Aku tidak akan mengarang hasilnya."
                    : agentResult.reason === "cycle"
                      ? "Aku menghentikan run karena planner mengulang langkah yang sama. Coba ulangi pertanyaannya; aku tidak akan mengarang hasilnya."
                      : "Run agent berhenti sebelum menghasilkan jawaban yang dapat dipercaya.";
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
              session: mutationsAllowed ? engagedSession : null,
              plannedActionLabels: plannedActions.map(adaptiveActionLabel),
            },
          );
        }
        reply = normalizeTelegramText(reply);
        reply = withEmergencyAvailability(reply, triage);
        reply = await guardReply(ownerId, text, reply, triage, context, runtime);
      } catch (error) {
        if (!(await runtimeIsCurrent(runtime))) {
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
        if (route.kind !== "save-task") {
          await ctx.reply(AI_FAILURE_MESSAGE);
          await history.append(ownerId, "harvy", AI_FAILURE_MESSAGE);
          return;
        }
        // Untuk tugas, pencatatannya tetap diteruskan. Kehilangan kalimat
        // pembuka jauh lebih ringan daripada kehilangan pekerjaan pengguna.
      }

      if (!(await runtimeIsCurrent(runtime))) {
        await telemetry.discardUndelivered?.(ownerId, currentTurnId());
        return;
      }

      const remembered = await storeOrdinaryMemories(
        ownerId,
        mutationsAllowed ? understanding.memories : [],
        triage.sensitive,
      );
      if (!(await runtimeIsCurrent(runtime))) {
        await rollbackOrdinaryMemories(ownerId, remembered.saved);
        await telemetry.discardUndelivered?.(ownerId, currentTurnId());
        return;
      }
      let memoryNoticeDelivered = remembered.saved.length === 0;

      let adaptiveKeyboard: InlineKeyboard | undefined;

      if (
        reply &&
        plannedActions.length > 0 &&
        remembered.saved.length === 0 &&
        remembered.sensitive === null &&
        !replyHasBlockingQuestion(reply)
      ) {
        adaptiveKeyboard = adaptiveActionButtons(
          actionOffers.set(ownerId, plannedActions, actionGoal),
        );
      }

      if (reply) {
        let replyDelivered = false;
        try {
          let deliveredBySession = false;
          if (
            engagedSession &&
            mutationsAllowed &&
            route.kind === "conversation"
          ) {
            const sessionSignal = authorizedSessionSignal(
              text,
              understanding.sessionSignal,
              engagedSession,
            );
            await sessions.progressAfterDelivery(
              ownerId,
              sessionSignal,
              engagedSession.id,
              async (next) => {
                deliveredBySession = true;
                if (!(await runtimeIsCurrent(runtime))) {
                  throw new Error("Giliran sudah digantikan sebelum delivery.");
                }
                await sendReply(
                  ctx,
                  reply ?? "",
                  remembered.saved,
                  remembered.saved.length === 0 && next
                    ? sessionActions(next)
                  : undefined,
                );
                replyDelivered = true;
                memoryNoticeDelivered = true;
                if (debitDeliveredReply) {
                  await telemetry.markDelivered?.(ownerId, currentTurnId());
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
            await sendReply(
              ctx,
              reply,
              remembered.saved,
              adaptiveKeyboard,
              () => {
                replyDelivered = true;
              },
            );
            replyDelivered = true;
            memoryNoticeDelivered = true;
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
              await telemetry.markDelivered?.(ownerId, currentTurnId());
            }
          }
        } catch (error) {
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
              await telemetry.markDelivered?.(ownerId, currentTurnId());
            }
            await history.append(ownerId, "harvy", error.deliveredText);
            if (warning) await history.append(ownerId, "harvy", warning);
            await memories.markUsed(context.memories);
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
        await history.append(ownerId, "harvy", reply.trim());
        if (agentCheckpointWarning) {
          await history.append(ownerId, "harvy", agentCheckpointWarning);
        }
        await memories.markUsed(context.memories);

        // Catatan tersembunyi tidak dibuat dari satu false positive dukungan,
        // hasil triase yang gagal, atau balasan yang belum berhasil dikirim.
        if (triage.certain && triage.level === "bahaya") {
          await insights.record(
            ownerId,
            triage.level,
            triage.summary,
            reply.slice(0, 160),
          );
        }
      } else {
        await telemetry.discardUndelivered?.(ownerId, currentTurnId());
      }

      // Satu pending saja per pemilik. Klarifikasi agent yang sudah terlihat
      // menang atas tawaran tugas/memori/gaya agar checkpoint tidak tertimpa.
      if (agentPending) return;

      if (route.kind === "save-task") {
        await clearPending(ownerId);
        // Kartu tugas menyusul balasan, tanpa kalimat pembuka kedua. Kalau
        // balasannya gagal dibuat, kartunya yang membawa kalimatnya.
        try {
          await saveTask(
            ctx,
            ownerId,
            route.task,
            reply ? undefined : taskSavedHeading(),
          );
          if (!reply) {
            await sendMemoryNotes(ctx, remembered.saved);
            memoryNoticeDelivered = true;
          }
        } catch (error) {
          if (!memoryNoticeDelivered) {
            await rollbackOrdinaryMemories(ownerId, remembered.saved);
          }
          throw error;
        }
        await askSensitive(ctx, ownerId, remembered.sensitive);
        return;
      }

      if (!reply && remembered.saved.length > 0) {
        try {
          await sendMemoryNotes(ctx, remembered.saved);
          memoryNoticeDelivered = true;
        } catch (error) {
          await rollbackOrdinaryMemories(ownerId, remembered.saved);
          throw error;
        }
      }

      // Pekerjaan yang tersirat di balik cerita ditawarkan, tidak dicatat diam-diam.
      if (offeredTask) {
        const confirmationToken = await setPending(ownerId, {
          kind: "confirm-task",
          task: offeredTask,
        });
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

      await askSensitive(ctx, ownerId, remembered.sensitive);

      // Ditanyakan setelah percakapan punya isi, bukan setelah giliran pertama.
      // Pada uji pertama pesan pembukanya cuma "p", dan pertanyaan gaya sudah
      // muncul di detik berikutnya — pengguna belum punya bahan menjawabnya.
      await askStyleOnce(
        ctx,
        ownerId,
        styleEligible && !adaptiveKeyboard,
      );
    } finally {
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
    triage: RiskTriage,
    context: HarvyContext,
    runtime: ConversationRuntime = {},
  ): Promise<string> {
    if (!needsReplyReview(triage.level)) return reply;

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
    };
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
        await applyNewDue(ctx, ownerId, waiting.taskId, text, timeZone);
        return true;
      case "edit-memory":
        await applyMemoryEdit(ctx, ownerId, waiting.memoryId, text);
        return true;
      case "set-task-reminder":
        await applyTaskReminder(
          ctx,
          ownerId,
          waiting.taskId,
          text,
          timeZone,
        );
        return true;
      case "schedule-checkin":
        await applyCheckInTime(
          ctx,
          ownerId,
          waiting.sessionId,
          text,
          timeZone,
        );
        return true;
      case "custom-quiet-hours":
        await applyCustomQuietHours(ctx, ownerId, waiting.sessionId, text);
        return true;
      case "checkin-settings":
        await ctx.reply(
          waiting.step === "timezone"
            ? "Pilih zona waktumu lewat tombol yang tadi, ya."
            : "Pilih jam tenang lewat tombol yang tadi, ya.",
        );
        return true;
      case "confirm-task":
      case "confirm-memory":
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
      await clearPending(
        ownerId,
        waiting.checkpoint.runId,
        waiting.revision ?? undefined,
      );
      if (!(await runtimeIsCurrent(runtime))) return;
      logger.error("agent_resume_failed", "Run agent gagal dilanjutkan.", error);
      await ctx.reply(AI_FAILURE_MESSAGE);
      await history.append(ownerId, "harvy", AI_FAILURE_MESSAGE);
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
      response = "Aku menghentikan run ini karena agent baca-saja meminta izin untuk perubahan yang tidak tersedia.";
    } else {
      debitDeliveredReply = false;
      response = result.reason === "deadline"
        ? "Waktu run sebelumnya sudah habis, jadi aku tidak melanjutkannya seolah hasilnya masih segar. Coba minta lagi kalau kamu masih perlu."
        : result.reason === "cycle"
          ? "Aku menghentikan run karena planner mengulang langkah yang sama. Coba ulangi pertanyaannya; aku tidak akan mengarang hasilnya."
          : "Run agent berhenti sebelum menghasilkan jawaban yang dapat dipercaya.";
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
      await sendReply(ctx, response);
    } catch (error) {
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
          await telemetry.markDelivered?.(ownerId, currentTurnId());
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
      await telemetry.markDelivered?.(ownerId, currentTurnId());
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
  ): Promise<void> {
    if (!text.trim() || text.trim().length > 200) {
      await ctx.reply(
        "Tulis penggantinya dalam satu kalimat, maksimal 200 karakter.",
      );
      return;
    }

    const updated = await memories.edit(ownerId, memoryId, text);
    if (!updated) {
      await ctx.reply(
        "Aku nggak bisa mengubahnya—catatannya mungkin sudah hilang atau isinya sama dengan catatan lain.",
      );
      return;
    }

    await clearPending(ownerId);
    await recordEvent(ownerId, "memory_edited");
    const response = `Udah aku ubah jadi: ${updated.content}`;
    await ctx.reply(response);
    await history.append(ownerId, "harvy", response);
  }

  async function applyTaskReminder(
    ctx: Context,
    ownerId: string,
    taskId: string,
    text: string,
    timeZone: string,
  ): Promise<void> {
    const at = await readChosenTime(ctx, ownerId, text, timeZone);
    if (!at) return;

    const profile = await profiles.load(ownerId);
    if (isInQuietHours(at, timeZone, profile.quietHours)) {
      await ctx.reply(
        "Waktu itu masuk jam tenangmu. Pilih waktu lain, atau ubah jam tenang lewat Data & izin.",
      );
      return;
    }

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
  ): Promise<void> {
    const at = await readChosenTime(ctx, ownerId, text, timeZone);
    if (!at) return;

    const profile = await profiles.load(ownerId);
    if (isInQuietHours(at, timeZone, profile.quietHours)) {
      await ctx.reply(
        "Waktu itu masuk jam tenangmu, jadi aku nggak akan menggesernya diam-diam. Pilih waktu lain, ya.",
      );
      return;
    }

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
  ): Promise<void> {
    const quietHours = parseQuietHours(text);
    if (!quietHours) {
      await ctx.reply(
        "Aku belum nangkep rentangnya. Tulis seperti “21.30–06.00”.",
      );
      return;
    }

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
  ): Promise<Date | null> {
    let at: Date | null;
    try {
      at = await conversation.understandDueDate(text, {
        ownerId,
        timeZone,
      });
    } catch (error) {
      logger.error(
        "selected_time_understanding_failed",
        "Pembacaan waktu pilihan gagal.",
        error,
      );
      await ctx.reply(
        error instanceof UsageLimitError
          ? AI_USAGE_LIMIT_MESSAGE
          : AI_FAILURE_MESSAGE,
      );
      return null;
    }

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
  ): Promise<void> {
    const token = await setPending(ownerId, value);
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
  ): Promise<void> {
    switch (action) {
      case "data":
        await ctx.reply(
          "Di sini kamu bisa melihat, mengubah, mengekspor, atau menghapus datamu sendiri.",
          { reply_markup: dataControlActions() },
        );
        return;
      case "timezone": {
        const profile = await profiles.load(ownerId);
        await ctx.reply(
          `Pengaturan waktu saat ini:\n\n${formatTimeSettings(profile)}`,
          { reply_markup: timezoneActions() },
        );
        return;
      }
      case "quiet-hours": {
        const profile = await profiles.load(ownerId);
        await ctx.reply(
          `Pengaturan waktu saat ini:\n\n${formatTimeSettings(profile)}`,
          { reply_markup: quietHoursActions() },
        );
        return;
      }
      case "active-session": {
        const session = await sessions.active(ownerId);
        if (!session) {
          await ctx.reply("Saat ini nggak ada sesi yang aktif.");
          return;
        }
        await ctx.reply(
          formatSession(session, await timeZoneFor(ownerId)),
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
        );
        return;
      case "export":
        await sendDataExport(ctx, ownerId);
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
        );
        return;
    }
  }

  async function sendDataExport(
    ctx: Context,
    ownerId: string,
  ): Promise<void> {
    const snapshot = await dataControls.export(ownerId);
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
   * Tiga bubble yang tiba serentak terbaca seperti notifikasi beruntun. Jedanya
   * pendek dan berplafon: ini soal keterbacaan, bukan soal membuat percakapan
   * terasa lebih lama.
   */
  async function sendReply(
    ctx: Context,
    text: string,
    notes: MemoryItem[] = [],
    keyboard?: InlineKeyboard,
    onBubbleDelivered?: (text: string) => void,
  ): Promise<SentMessageRef | null> {
    const bubbles = splitReplyBubbles(text);
    if (bubbles.length === 0) return null;
    const replyKeyboard = mergeKeyboards(
      notes.length > 0 ? memoryNoteActions(notes) : undefined,
      keyboard,
    );

    let lastMessage: SentMessageRef | null = null;
    const delivered: string[] = [];
    for (const [index, bubble] of bubbles.entries()) {
      const last = index === bubbles.length - 1;
      const deliveredBubble = last ? withMemoryNotes(bubble, notes) : bubble;
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
        await sleep(bubblePauseMs(bubbles[index + 1] ?? ""));
      }
    }
    return lastMessage;
  }

  /** Jalur mundur ketika tidak ada balasan yang bisa ditempeli catatan. */
  async function sendMemoryNotes(
    ctx: Context,
    items: MemoryItem[],
  ): Promise<void> {
    if (items.length === 0) return;

    await ctx.reply(memoryNoteLines(items), {
      reply_markup: memoryNoteActions(items),
    });
  }

  /**
   * Menyimpan memori biasa dan menyisihkan yang sensitif untuk ditawarkan.
   *
   * Yang biasa disimpan tanpa bertanya, tetapi tidak diam-diam: setiap
   * penyimpanan diumumkan di balasan yang sama berikut jalan keluarnya, sesuai
   * Pasal 4 nomor 2. Yang sensitif tidak pernah lewat jalur ini — Pasal 4
   * nomor 3.
   */
  async function storeOrdinaryMemories(
    ownerId: string,
    items: ExtractedMemory[],
    sensitiveByModel = false,
  ): Promise<{ saved: MemoryItem[]; sensitive: ExtractedMemory | null }> {
    const saved: MemoryItem[] = [];
    let sensitive: ExtractedMemory | null = null;

    try {
      for (const item of items) {
        if (isSensitiveMemory(item, sensitiveByModel)) {
          sensitive ??= item;
          continue;
        }

        const stored = await memories.remember({
          ownerId,
          kind: item.kind,
          content: item.content,
        });
        if (stored) saved.push(stored);
      }
    } catch (error) {
      await rollbackOrdinaryMemories(ownerId, saved);
      throw error;
    }

    return { saved, sensitive };
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
   * Hanya satu langkah tertunda yang dapat hidup sekaligus per pengguna.
   *
   * Ketika sebuah pesan melahirkan tawaran tugas sekaligus memori sensitif,
   * tawaran tugas menang dan memorinya dilewatkan. Menumpuk dua pertanyaan
   * sekaligus membuat pengguna harus menjawab kuis, dan Pasal 3.11 meminta
   * pilihan yang tidak berlebihan.
   */
  async function askSensitive(
    ctx: Context,
    ownerId: string,
    sensitive: ExtractedMemory | null,
  ): Promise<void> {
    if (!sensitive) {
      // Batch yang memuat bubble sebelum prompt agent tidak sah sebagai
      // jawaban. Jangan biarkan housekeeping memori membatalkan checkpoint
      // yang sengaja tidak dikonsumsi itu.
      if (pending.peek(ownerId)?.kind === "agent-input") return;
      await clearPending(ownerId);
      return;
    }

    const confirmationToken = await setPending(ownerId, {
      kind: "confirm-memory",
      memory: sensitive,
    });
    try {
      await ctx.reply(
        [
          `Boleh aku inget ini? “${sensitive.content}”`,
          "",
          "Kalau boleh, kamu nggak perlu cerita ulang nanti. Kalau nggak, aku tetap dengerin hari ini dan nggak nyimpen apa-apa.",
        ].join("\n"),
        { reply_markup: memoryConsentActions(confirmationToken) },
      );
    } catch (error) {
      pending.take(ownerId, confirmationToken);
      throw error;
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
  ): Promise<void> {
    if (!eligible || pending.peek(ownerId)) return;

    await ctx.reply(STYLE_QUESTION, { reply_markup: styleActions() });
    await profiles.markStyleAsked(ownerId);
    await history.append(ownerId, "harvy", STYLE_QUESTION);
  }

  async function showMemories(ctx: Context, ownerId: string): Promise<void> {
    const items = await memories.list(ownerId);
    const text = formatMemories(items);

    await ctx.reply(
      text,
      items.length > 0 ? { reply_markup: memoryListActions(items) } : {},
    );
    await history.append(ownerId, "harvy", text);
  }

  async function saveTask(
    ctx: Context,
    ownerId: string,
    extracted: ExtractedTask,
    heading?: string,
  ): Promise<void> {
    const profile = await profiles.load(ownerId);
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

    const response = [
      ...(heading ? [heading, ""] : []),
      formatTask(task, timeZone),
      understandingNote(task),
      ...(reminderRejected
        ? [
            "",
            "Waktu pengingat itu masuk jam tenangmu, jadi aku nggak memasangnya diam-diam. Pilih waktu lain lewat tombol Ingatkan.",
          ]
        : []),
    ].join("\n");

    await ctx.reply(response, { reply_markup: taskActions(task) });
    await history.append(ownerId, "harvy", response);
  }

  async function applyNewDue(
    ctx: Context,
    ownerId: string,
    taskId: string,
    text: string,
    timeZone: string,
  ): Promise<void> {
    let dueAt: Date | null;

    try {
      dueAt = await conversation.understandDueDate(text, {
        ownerId,
        timeZone,
      });
    } catch (error) {
      logger.error(
        "due_date_understanding_failed",
        "Pembacaan tenggat baru gagal.",
        error,
      );
      await ctx.reply(
        error instanceof UsageLimitError
          ? AI_USAGE_LIMIT_MESSAGE
          : AI_FAILURE_MESSAGE,
      );
      return;
    }

    if (!dueAt) {
      const response =
        "Aku belum nangkep waktunya. Coba tulis seperti “besok jam 7 malam” atau “senin depan”.";
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return;
    }

    await clearPending(ownerId);
    const updated = await tasks.setDue(ownerId, taskId, dueAt);

    if (!updated) {
      const response = taskMissingNote();
      await ctx.reply(response);
      await history.append(ownerId, "harvy", response);
      return;
    }

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
        await safeEdit(ctx, styleAck(target));
        await history.append(ownerId, "harvy", styleAck(target));
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
        await refreshAfterChange(ctx, ownerId, completed.title);
        return;
      }

      case "drop": {
        const removed = await tasks.remove(ownerId, target);
        if (!removed) {
          await safeEdit(ctx, taskMissingNote());
          return;
        }
        await refreshAfterChange(ctx, ownerId);
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

      case "memsave": {
        const waiting = pending.take(ownerId, target);

        if (waiting?.kind !== "confirm-memory") {
          await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
          return;
        }

        const saved = await memories.remember({
          ownerId,
          kind: waiting.memory.kind,
          content: waiting.memory.content,
        });

        await safeEdit(
          ctx,
          saved ? memoryNoteLines([saved]) : "Ternyata udah aku inget sebelumnya.",
          saved ? memoryNoteActions([saved]) : undefined,
        );
        return;
      }

      case "memskip": {
        const waiting = pending.take(ownerId, target);
        if (waiting?.kind !== "confirm-memory") {
          await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
          return;
        }
        await safeEdit(
          ctx,
          "Oke, itu nggak aku simpen. Aku tetap di sini kalau kamu mau cerita.",
        );
        return;
      }

      // Tombol pada catatan yang menempel di balasan. Balasannya pesan
      // sungguhan, jadi yang dibuang cukup barisnya — bukan seluruh pesannya,
      // dan bukan diganti daftar memori.
      case "memdrop": {
        const forgotten = await memories.forget(ownerId, target);
        await safeEdit(
          ctx,
          withoutMemoryNote(
            ctx.callbackQuery?.message?.text ?? "",
            forgotten?.content ?? null,
          ),
        );
        return;
      }

      case "memforget": {
        const forgotten = await memories.forget(ownerId, target);
        await refreshMemories(
          ctx,
          ownerId,
          forgotten?.content,
          forgotten === null,
        );
        return;
      }

      case "memedit": {
        const item = (await memories.list(ownerId)).find(
          (memory) => memory.id === target,
        );
        if (!item) {
          await safeEdit(ctx, "Catatan itu sudah nggak ada.");
          return;
        }
        await sendPendingPrompt(
          ownerId,
          {
            kind: "edit-memory",
            memoryId: item.id,
          },
          () =>
            ctx.reply(
              `Tulis versi penggantinya untuk “${item.content}”. Maksimal satu kalimat pendek.`,
            ).then(() => undefined),
        );
        return;
      }

      case "memall": {
        await sendPendingPrompt(
          ownerId,
          { kind: "confirm-memory-wipe" },
          (token) =>
            ctx.reply(
              [
                "Yakin? Aku bakal ngelupain semua catatan tentang kamu sekaligus seluruh riwayat obrolan kita. Ini nggak bisa dibatalin.",
              ].join("\n"),
              { reply_markup: memoryWipeConfirmActions(token) },
            ).then(() => undefined),
        );
        return;
      }

      case "memallyes": {
        const waiting = pending.take(ownerId, target);
        if (waiting?.kind !== "confirm-memory-wipe") {
          await safeEdit(ctx, "Tombol ini udah nggak berlaku.");
          return;
        }
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

        await safeEdit(
          ctx,
          [
            `Udah aku lupain semuanya — ${removed} catatan dan seluruh riwayat obrolan kita.`,
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
        await ctx.reply("Oke, sesi ini berhenti di sini.");
        await recordEvent(ownerId, "session_stopped");
        return;
      }
      case "done": {
        await sessions.progress(ownerId, "done", current.id);
        await dropKeyboard(ctx);
        await ctx.reply(
          "Selesai 🌿 Aku nggak akan terus mendorong sesi ini.",
        );
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
        await safeEdit(ctx, "Sip, selesai 🌿");
        await recordEvent(ownerId, "checkin_completed");
        await recordEvent(ownerId, "session_completed");
        return;
      case "ongoing":
        await safeEdit(
          ctx,
          "Oke, masih jalan. Aku nggak menjadwalkan pesan lain tanpa kamu minta.",
          sessionActions(current),
        );
        return;
      case "stop":
        await sessions.stop(ownerId);
        await safeEdit(ctx, "Oke, sesi dan check-in ini berhenti.");
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
    const [context, profile] = await Promise.all([
      contextFor(ownerId, session.goal),
      profiles.load(ownerId),
    ]);
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
      await telemetry.markDelivered?.(ownerId, currentTurnId());
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
        await ctx.reply(formatUsage(await telemetry.summary(ownerId)));
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
    await ctx.reply(`Zona waktu tersimpan.\n\n${formatTimeSettings(profile)}`);
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
    await ctx.reply(`Jam tenang tersimpan.\n\n${formatTimeSettings(profile)}`);
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
    pending.clear(ownerId);
    actionOffers.clear(ownerId);
    held.clear(ownerId);
    messageBatcher.invalidate(ownerId);
    history.suspend(ownerId);
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
    // DataControlService memasang tombstone sebelum menyentuh store lain.
    // Jangan biarkan pre-clear checkpoint menggagalkan hak penghapusan sebelum
    // tombstone itu sempat ditulis.
    pending.clear(ownerId);
    actionOffers.clear(ownerId);
    held.clear(ownerId);
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
    return runtime.isCurrent ? await runtime.isCurrent() : true;
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
    await telemetry.allow(ownerId);
    agentRuns?.allow("telegram", ownerId);
    consentChecks.set(ownerId, Promise.resolve(true));
    await dropKeyboard(ctx);

    const waiting = held.take(ownerId);
    held.clear(ownerId);

    await ctx.reply("😉");
    await ctx.reply(waiting ? CONSENT_ACCEPTED_HELD : CONSENT_ACCEPTED);

    // Diproses langsung, bukan lewat batcher: pesannya sudah selesai ditulis
    // jauh sebelum tombol ditekan, jadi tidak ada batas giliran yang perlu
    // ditebak. Ini tetap berada di dalam antrean pengguna yang sama.
    if (waiting) await handleFreeText(ctx, ownerId, waiting);
  }

  async function refreshMemories(
    ctx: Context,
    ownerId: string,
    forgotten?: string,
    missing = false,
  ): Promise<void> {
    const remaining = await memories.list(ownerId);
    const heading = missing
      ? "Itu udah nggak ada."
      : forgotten
      ? `Udah aku lupain: ${forgotten}`
      : "Udah aku lupain.";

    if (remaining.length === 0) {
      await safeEdit(
        ctx,
        `${heading}\n\nSekarang nggak ada lagi yang aku inget tentang kamu.`,
      );
      return;
    }

    await safeEdit(
      ctx,
      [heading, "", formatMemories(remaining)].join("\n"),
      memoryListActions(remaining),
    );
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
      await ctx.reply(
        [
          "Oke, nanti aku ingetin.",
          "",
          formatTask(updated, timeZone),
        ].join("\n"),
      );
      return;
    }
    await safeEdit(ctx, taskMissingNote());
  }

  async function refreshAfterChange(
    ctx: Context,
    ownerId: string,
    completedTitle?: string,
  ): Promise<void> {
    const remaining = await tasks.listActive(ownerId);
    const timeZone = await timeZoneFor(ownerId);
    const heading = completedTitle
      ? taskCompletedHeading(completedTitle)
      : taskDroppedHeading();

    if (remaining.length === 0) {
      await safeEdit(ctx, `${heading}\n\n${nothingLeftNote()}`);
      return;
    }

    await safeEdit(
      ctx,
      [
        heading,
        "",
        "Sisanya:",
        "",
        ...remaining.map((task) => formatTask(task, timeZone)),
      ].join("\n"),
      taskListActions(remaining),
    );
  }

  async function sendTaskList(ctx: Context, ownerId: string): Promise<void> {
    const active = await tasks.listActive(ownerId);
    const timeZone = await timeZoneFor(ownerId);

    if (active.length === 0) {
      await ctx.reply(emptyListNote());
      return;
    }

    await ctx.reply(
      [
        taskListLead(),
        "",
        ...active.map((task) => formatTask(task, timeZone)),
      ].join("\n"),
      { reply_markup: taskListActions(active) },
    );
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
    text: string,
    _mode: "tools" | "orchestrate",
  ): boolean {
    // Pertanyaan kemampuan produk perlu snapshot lengkap, bukan hanya irisan
    // executor agent. Jalur reply lama sudah membawa capabilityContext itu.
    return !isProductCapabilityQuestion(text);
  }

  function isProductCapabilityQuestion(text: string): boolean {
    return /\b(?:kamu|harvy).{0,24}(?:bisa apa|dapat apa|kemampuan|fitur|punya (?:tool|alat|fitur))\b/iu.test(text) ||
      /\b(?:fitur|kemampuan|tool|alat)(?:mu| kamu| harvy).{0,18}\b(?:apa|apa saja|apa aja|punya|tersedia)\b/iu.test(text) ||
      /\bapa(?: saja| aja)? (?:fitur|kemampuan|tool|alat)(?:mu| kamu| harvy)\b/iu.test(text) ||
      /\bapa (?:saja|aja) yang bisa kamu lakukan\b/iu.test(text) ||
      /\bapa yang (?:tidak|nggak|gak) bisa (?:kamu|harvy) lakukan\b/iu.test(text);
  }

  function isExplicitPlanningRequest(text: string): boolean {
    if (/\bjangan\s+(?:buat(?:kan)?|bikin(?:kan)?|susun(?:kan)?|rancang(?:kan)?|rencanakan|pecah(?:kan)?)\b/iu.test(text)) {
      return false;
    }
    return /\b(?:rencanakan|pecah(?:kan)? menjadi langkah)\b/iu.test(text) ||
      /\b(?:tolong\s+)?(?:buat(?:kan)?|bikin(?:kan)?|susun(?:kan)?|rancang(?:kan)?|beri(?:kan)?(?: aku| saya)?)\b.{0,40}\b(?:rencana|planning|langkah demi langkah)\b/iu.test(text);
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
          error instanceof UsageLimitError
            ? AI_USAGE_LIMIT_MESSAGE
            : "Ada yang gagal diproses. Coba lagi sebentar, ya.",
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

function safetyUnderstanding(): Understanding {
  return {
    intent: "feeling",
    taskAction: null,
    memoryAction: null,
    safetySensitive: true,
    needsStepByStep: false,
    task: null,
    memories: [],
    suggestedActions: [],
    actionGoal: null,
    controlAction: null,
    sessionSignal: null,
  };
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
