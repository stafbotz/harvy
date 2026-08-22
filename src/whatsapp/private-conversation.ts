import { randomUUID } from "node:crypto";
import type { HarvyContext } from "../ai/context.js";
import { ByokProviderError } from "../ai/client.js";
import type {
  Conversation,
  ConversationRuntime,
} from "../ai/conversation.js";
import {
  safetyOnlyUnderstanding,
  safeFallbackReply,
  resolveRiskAssessment,
  URGENT_ACKNOWLEDGEMENT,
  withEmergencyAvailability,
  type RiskAssessment,
  type RiskTriage,
} from "../ai/safety.js";
import { withUsageAttribution } from "../ai/usage-attribution.js";
import { canUseDirectTimeFastPath } from "../agent/time-fast-path.js";
import {
  CAPYBARA_MODEL_REPLY,
  canUseModelIdentityFastPath,
} from "../ai/identity.js";
import { deterministicQuickChatReply } from "../bot/fast-path-policy.js";
import {
  CONSENT_ACCEPTED,
  CONSENT_ACCEPTED_HELD,
  HOLD_LIMIT_REACHED,
  HOLD_REMINDER,
  HeldMessageStore,
  PRE_CONSENT_SAFETY,
  PRE_CONSENT_UNCERTAIN,
  consentDetail,
  introBubbles,
} from "../bot/onboarding.js";
import { normalizeTelegramText } from "../bot/messages.js";
import { MessageBatcher, type MessageBatch } from "../bot/message-batcher.js";
import { notUnderstoodNote } from "../bot/phrasing.js";
import type { EconomyCommandService } from "../core/economy-command-service.js";
import type { DataControlService } from "../core/data-control-service.js";
import type { HistoryService } from "../core/history-service.js";
import type { MemoryContextCompiler } from "../core/memory-context-compiler.js";
import type { MemoryService } from "../core/memory-service.js";
import type { ProfileService } from "../core/profile-service.js";
import {
  hasExplicitImmediateDangerSignal,
  needsConditionalReplyReview,
  NO_RISK_HINT,
  parseRiskHint,
  withImmediateDangerHint,
} from "../core/safety-policy.js";
import { sessionAppliesToMessage } from "../core/session-policy.js";
import type { SessionService } from "../core/session-service.js";
import {
  UsageLimitError,
  type TelemetryService,
} from "../core/telemetry-service.js";
import type { UserUsageSummaryService } from "../core/user-usage-summary-service.js";
import {
  TransientConversationProgress,
} from "../core/conversation-progress.js";
import {
  planResponsePresentation,
} from "../core/response-presentation.js";
import {
  parseUsageDashboardCommand,
  renderUsageDashboard,
  USAGE_COMMAND_TARGET_REJECTED,
} from "../core/usage-dashboard-renderer.js";
import type {
  WhatsAppPrivateMessage,
  WhatsAppPrivateReply,
  WhatsAppPrivateReplyResult,
  WhatsAppPrivateTransport,
} from "./baileys-message-normalizer.js";
import { whatsappPrivateOwnerId } from "./baileys-message-normalizer.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

export type {
  WhatsAppPrivateReply,
  WhatsAppPrivateReplyResult,
} from "./baileys-message-normalizer.js";

export interface WhatsAppPrivateConversationDependencies {
  conversation: Pick<
    Conversation,
    "understand" | "triageRisk" | "reply" | "reviewReply" |
      "deterministicTimeReply"
  > & Partial<Pick<
    Conversation,
    "assessTurnBoundary" | "classifyTurnInterruption"
  >>;
  history: Pick<
    HistoryService,
    "context" | "append" | "compact" | "allow" | "suspend"
  >;
  memories: Pick<
    MemoryService,
    "relevantTo" | "list" | "forget" | "forgetAll" | "allow" | "suspend"
  >;
  profiles: Pick<
    ProfileService,
    "load" | "needsOnboarding" | "acceptConsent" | "withdrawConsent"
  >;
  sessions: Pick<SessionService, "active">;
  telemetry: Pick<
    TelemetryService,
    "allow" | "beginTurn" | "noteTurnSignal" | "noteTurnResponse" |
      "recordTurn" | "markDelivered" | "discardUndelivered"
  >;
  memoryContextCompiler?: Pick<MemoryContextCompiler, "compilePrivate">;
  economyCommands?: Pick<EconomyCommandService, "handle">;
  usageDashboard?: Pick<UserUsageSummaryService, "summary">;
  dataControls?: Pick<DataControlService, "deleteAll">;
}

export interface WhatsAppPrivateConversationOptions {
  defaultTimezone: string;
  termsUrl: string;
  telemetryRetentionDays: number;
  operationalLogRetentionDays: number;
}

const WHATSAPP_PRIVATE_HELP = [
  "Tulis aja seperti chat pribadi biasa; Harvy akan menjawab lewat nomor WhatsApp ini.",
  "",
  "Perintah yang tersedia:",
  "• /penggunaan — lihat kapasitas akunmu",
  "• /memori — lihat atau hapus memori yang tersimpan",
  "• /hapus-data — hapus seluruh data setelah konfirmasi",
  "• /izin — baca cara pesan dan data diproses",
  "• /tarik-izin — hentikan pemrosesan AI sampai kamu setuju lagi",
  "• /bantuan — tampilkan pesan ini",
].join("\n");

const AI_FAILURE_MESSAGE =
  "Maaf, aku lagi nggak bisa mikir sekarang — sambungan ke otakku lagi bermasalah. Coba kirim lagi sebentar lagi, ya.";
const MAX_PRIVATE_REPLY_CHARACTERS = 12_000;

interface PrivateIngressCarrier {
  message: WhatsAppPrivateMessage;
  transport: WhatsAppPrivateTransport;
}

class PrivateTurnSupersededError extends Error {
  constructor() {
    super("Giliran privat WhatsApp sudah digantikan.");
    this.name = "PrivateTurnSupersededError";
  }
}

/**
 * Adapter percakapan privat WhatsApp yang memakai core AI, context, consent,
 * safety, telemetry, dan funding yang sama dengan chat privat Telegram.
 * Surface berbasis tombol Telegram sengaja tidak diterjemahkan menjadi efek
 * palsu; WhatsApp memakai perintah teks yang tertutup untuk consent/kontrol.
 */
export class WhatsAppPrivateConversation {
  private readonly held = new HeldMessageStore();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly ingressChains = new Map<string, Promise<void>>();
  private readonly ingressTasks = new Set<Promise<void>>();
  private readonly memorySelections = new Map<string, string[]>();
  private readonly pendingMemoryWipes = new Set<string>();
  private readonly pendingDataDeletions = new Set<string>();
  private readonly batcher: MessageBatcher<PrivateIngressCarrier>;
  private acceptingIngress = true;

  constructor(
    private readonly dependencies: WhatsAppPrivateConversationDependencies,
    private readonly options: WhatsAppPrivateConversationOptions,
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("whatsapp.private"),
  ) {
    this.batcher = new MessageBatcher<PrivateIngressCarrier>(
      async (text, ownerId, turnId, signals) => {
        if (!this.dependencies.conversation.assessTurnBoundary) {
          return "complete";
        }
        if (ownerId && turnId) {
          await this.dependencies.telemetry.beginTurn(ownerId, turnId);
        }
        return withUsageAttribution(
          {
            turnId: turnId ?? null,
            subjectKind: "private",
            channel: "whatsapp",
            actorAliases: [],
          },
          async () => {
            const recent = ownerId
              ? await this.dependencies.history.context(ownerId)
              : undefined;
            return this.dependencies.conversation.assessTurnBoundary!(
              text,
              ownerId,
              recent ? { turns: recent.turns } : undefined,
              signals,
            );
          },
        );
      },
      (ownerId, batch) => this.handleBatchedTurn(ownerId, batch),
      undefined,
      undefined,
      undefined,
      undefined,
      logger.child("batcher"),
      (metrics) => this.dependencies.telemetry.recordTurn({
        ...metrics,
        subjectKind: "private",
        channel: "whatsapp",
      }),
      undefined,
      this.dependencies.conversation.classifyTurnInterruption
        ? (activeText, incomingText, ownerId, turnId) =>
            withUsageAttribution(
              {
                turnId,
                subjectKind: "private",
                channel: "whatsapp",
                actorAliases: [],
              },
              () => this.dependencies.conversation.classifyTurnInterruption!(
                activeText,
                incomingText,
                ownerId,
              ),
            )
        : undefined,
    ).onUrgent(async (_ownerId, batch) => {
      if (!batch.carrier.transport.isCurrent()) return;
      await batch.carrier.transport.send(URGENT_ACKNOWLEDGEMENT);
    });
  }

  handle(message: WhatsAppPrivateMessage): Promise<WhatsAppPrivateReplyResult> {
    const ownerId = whatsappPrivateOwnerId(message.userId);
    const previous = this.chains.get(ownerId) ?? Promise.resolve();
    const next = previous.then(
      () => this.handleSerial(ownerId, message),
      () => this.handleSerial(ownerId, message),
    );
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(ownerId, tail);
    return next.finally(() => {
      if (this.chains.get(ownerId) === tail) this.chains.delete(ownerId);
    });
  }

  /**
   * Ingress produksi: callback socket kembali segera, sedangkan batching dan
   * delivery tetap dilacak untuk drain. Teks pra-consent tidak pernah masuk
   * classifier semantik.
   */
  async ingest(
    message: WhatsAppPrivateMessage,
    transport: WhatsAppPrivateTransport,
  ): Promise<null> {
    if (!this.acceptingIngress) return null;
    const ownerId = whatsappPrivateOwnerId(message.userId);
    const previous = this.ingressChains.get(ownerId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      if (!this.acceptingIngress) return;
      const text = message.text.trim();
      if (!text) return;
      const needsOnboarding = await this.dependencies.profiles.needsOnboarding(
        ownerId,
      );
      if (needsOnboarding || isDeterministicPrivateControl(text)) {
        this.batcher.cancelAndEnqueue(ownerId, async () => {
          const result = await this.handleSerial(ownerId, message);
          await this.deliverResult(result, transport);
        });
        return;
      }
      this.batcher.enqueue(ownerId, text, { message, transport });
    });
    const tail = task.then(
      () => undefined,
      (error: unknown) => {
        this.logger.error(
          "whatsapp_private_ingress_failed",
          "Ingress privat WhatsApp gagal diproses.",
          error,
        );
      },
    );
    this.ingressChains.set(ownerId, tail);
    this.ingressTasks.add(tail);
    void tail.finally(() => {
      this.ingressTasks.delete(tail);
      if (this.ingressChains.get(ownerId) === tail) {
        this.ingressChains.delete(ownerId);
      }
    });
    return null;
  }

  stopIngress(): void {
    this.acceptingIngress = false;
  }

  async drain(): Promise<void> {
    do {
      while (this.ingressTasks.size > 0) {
        await Promise.allSettled([...this.ingressTasks]);
      }
      await this.batcher.drainAll();
    } while (this.ingressTasks.size > 0);
    while (this.chains.size > 0) {
      await Promise.allSettled([...this.chains.values()]);
    }
  }

  private async handleBatchedTurn(
    ownerId: string,
    batch: MessageBatch<PrivateIngressCarrier>,
  ): Promise<void> {
    const progress = new TransientConversationProgress(
      {
        show: (text) => batch.carrier.transport.send(text),
        update: (reference, text) =>
          batch.carrier.transport.edit(reference, text),
        remove: (reference) => batch.carrier.transport.remove(reference),
        typing: () => batch.carrier.transport.typing(),
      },
      {
        seed: batch.turnId,
        onError: (operation, error) => {
          this.logger.warn(
            "whatsapp_private_progress_operation_failed",
            "Status kerja privat WhatsApp gagal diperbarui.",
            {
              operation,
              errorType: error instanceof Error ? error.name : "unknown",
            },
          );
        },
      },
    );
    const runtime: ConversationRuntime = {
      signal: batch.signal,
      isCurrent: batch.isCurrent,
      awaitCurrent: batch.awaitCurrent,
      markUserCommitted: batch.markUserCommitted,
      interruptionRelation: batch.interruptionRelation,
      progress,
    };
    if (
      batch.interruptionRelation === "addition" ||
      batch.interruptionRelation === "correction"
    ) {
      progress.report({ phase: "adjusting", detail: "new-context" });
    } else if (batch.interruptionRelation === "redirect") {
      progress.report({ phase: "switching", detail: "new-direction" });
    } else {
      progress.report({ phase: "reading", detail: "general" });
    }

    try {
      const reply = await this.runConversationTurn(
        ownerId,
        { ...batch.carrier.message, text: batch.text },
        "",
        batch.turnId,
        runtime,
        batch.urgentBoundary,
      );
      if (!(await privateRuntimeIsCurrent(runtime))) {
        await reply.onDeliveryFailed?.({
          text: "",
          bubbleCount: 0,
          complete: false,
        });
        return;
      }
      await this.deliverResult(reply, batch.carrier.transport, runtime);
    } catch (error) {
      if (!(error instanceof PrivateTurnSupersededError)) throw error;
    } finally {
      await progress.finish();
    }
  }

  private async deliverResult(
    result: WhatsAppPrivateReplyResult,
    transport: WhatsAppPrivateTransport,
    runtime: ConversationRuntime = {},
  ): Promise<void> {
    const prepared = typeof result === "string" ? { text: result } : result;
    const clean = prepared?.text.trim() ?? "";
    if (!prepared || !clean) return;
    const plan = planResponsePresentation(clean, {
      maxSegmentCharacters: MAX_PRIVATE_REPLY_CHARACTERS,
    });
    const delivered: string[] = [];
    try {
      for (const [index, segment] of plan.segments.entries()) {
        if (index > 0) {
          await interruptiblePrivatePause(segment.pauseBeforeMs, runtime.signal);
        }
        if (
          !(await privateRuntimeIsCurrent(runtime)) ||
          !transport.isCurrent()
        ) {
          throw new PrivateTurnSupersededError();
        }
        if (index === 0) await runtime.progress?.responding?.();
        await transport.send(segment.text);
        delivered.push(segment.text);
      }
      await prepared.onDelivered?.({
        text: delivered.join("\n\n"),
        bubbleCount: delivered.length,
        complete: true,
      });
    } catch (error) {
      await prepared.onDeliveryFailed?.({
        text: delivered.join("\n\n"),
        bubbleCount: delivered.length,
        complete: false,
      });
      if (error instanceof PrivateTurnSupersededError) return;
      throw error;
    }
  }

  private async handleSerial(
    ownerId: string,
    message: WhatsAppPrivateMessage,
  ): Promise<WhatsAppPrivateReplyResult> {
    const text = message.text.trim();
    if (!text) return null;

    const usageCommand = parseUsageDashboardCommand(text);
    if (usageCommand === "invalid") return USAGE_COMMAND_TARGET_REJECTED;
    if (usageCommand === "summary" && this.dependencies.usageDashboard) {
      return renderUsageDashboard(
        await this.dependencies.usageDashboard.summary(ownerId),
        "whatsapp",
      ).text;
    }

    if (isConsentDetail(text)) return this.consentExplanation();
    if (isFullDataDeletion(text)) {
      if (!this.dependencies.dataControls) {
        return "Penghapusan seluruh data belum tersedia pada runtime WhatsApp ini.";
      }
      this.pendingMemoryWipes.delete(ownerId);
      this.pendingDataDeletions.add(ownerId);
      return [
        "Ini menghapus seluruh data Harvy dalam scope WhatsApp pribadimu: profil, riwayat, memori, sesi, tugas, dan catatan pemakaian.",
        "Tindakan ini tidak bisa dibatalkan. Ketik HAPUS SEMUA DATA untuk mengonfirmasi, atau BATAL untuk membatalkan.",
      ].join("\n\n");
    }
    if (isFullDataDeletionConfirmation(text)) {
      if (!this.pendingDataDeletions.delete(ownerId)) {
        return "Tidak ada penghapusan seluruh data yang sedang menunggu konfirmasi.";
      }
      this.held.clear(ownerId);
      this.memorySelections.delete(ownerId);
      this.pendingMemoryWipes.delete(ownerId);
      await this.dependencies.dataControls?.deleteAll(ownerId);
      return "Seluruh data Harvy dalam scope WhatsApp pribadimu sudah dihapus. Pesan berikutnya akan kembali ke persetujuan awal.";
    }
    if (isMemoryList(text)) return this.showMemories(ownerId);
    if (isMemoryWipe(text)) {
      this.pendingDataDeletions.delete(ownerId);
      this.pendingMemoryWipes.add(ownerId);
      return [
        "Ini akan menghapus semua memori tersimpan tentangmu di scope WhatsApp pribadi ini.",
        "Ketik HAPUS SEMUA MEMORI untuk mengonfirmasi, atau BATAL untuk membatalkan.",
      ].join("\n\n");
    }
    if (isMemoryWipeConfirmation(text)) {
      if (!this.pendingMemoryWipes.delete(ownerId)) {
        return "Tidak ada penghapusan memori yang sedang menunggu konfirmasi.";
      }
      const removed = await this.dependencies.memories.forgetAll(ownerId);
      this.memorySelections.delete(ownerId);
      return removed > 0
        ? `Semua memori tersimpan sudah dihapus (${removed} item).`
        : "Tidak ada memori tersimpan yang perlu dihapus.";
    }
    if (isCancelControl(text)) {
      const cancelledMemory = this.pendingMemoryWipes.delete(ownerId);
      const cancelledData = this.pendingDataDeletions.delete(ownerId);
      return cancelledMemory || cancelledData
        ? "Tindakan penghapusan dibatalkan."
        : "Tidak ada tindakan yang sedang menunggu konfirmasi.";
    }
    const memoryIndex = parseMemoryForgetIndex(text);
    if (memoryIndex !== null) {
      return this.forgetMemory(ownerId, memoryIndex);
    }

    const needsOnboarding = await this.dependencies.profiles.needsOnboarding(
      ownerId,
    );
    if (needsOnboarding) {
      if (isConsentAcceptance(text)) {
        return this.acceptConsent(ownerId, message);
      }
      return this.beginOnboarding(ownerId, text);
    }

    if (isConsentWithdrawal(text)) {
      this.held.clear(ownerId);
      this.memorySelections.delete(ownerId);
      this.pendingMemoryWipes.delete(ownerId);
      this.pendingDataDeletions.delete(ownerId);
      this.dependencies.history.suspend(ownerId);
      this.dependencies.memories.suspend(ownerId);
      await this.dependencies.profiles.withdrawConsent(ownerId);
      return [
        "Izin AI sudah ditarik.",
        "Pesan pribadi berikutnya akan kembali ke perkenalan dan tidak diproses sebelum kamu membalas SETUJU.",
        "Data yang sudah ada tetap tersimpan sampai kamu menghapusnya lewat kontrol data Harvy.",
      ].join("\n\n");
    }
    if (isHelp(text)) return WHATSAPP_PRIVATE_HELP;
    if (text.startsWith("/")) {
      return ["Aku belum punya perintah itu di WhatsApp.", "", WHATSAPP_PRIVATE_HELP]
        .join("\n");
    }

    const economyReply = await this.dependencies.economyCommands?.handle(
      ownerId,
      text,
      `whatsapp:${message.messageId}`,
    );
    if (economyReply) return economyReply;

    return this.runConversationTurn(ownerId, message);
  }

  private consentExplanation(): string {
    return [
      whatsAppTextCopy(
        consentDetail(
          this.options.telemetryRetentionDays,
          this.options.operationalLogRetentionDays,
        ),
      ),
      "",
      "Balas SETUJU untuk mulai, atau kirim pesan lain kalau kamu belum ingin menyetujui.",
    ].join("\n");
  }

  private async beginOnboarding(ownerId: string, text: string): Promise<string> {
    const heldSuccessfully = this.held.hold(ownerId, text);
    const first = this.held.markIntroduced(ownerId);
    const replies: string[] = [];

    if (first && this.held.markSafetyShown(ownerId)) {
      const assessment = await this.assessPreConsentRisk(text);
      if (assessment === "danger") replies.push(
        whatsAppTextCopy(PRE_CONSENT_SAFETY),
      );
      else if (assessment === "unknown") {
        replies.push(whatsAppTextCopy(PRE_CONSENT_UNCERTAIN));
      }
    }

    if (first) {
      replies.push(
        ...introBubbles(null, heldSuccessfully, this.options.termsUrl),
        "Kalau kamu oke, balas SETUJU. Untuk penjelasan lebih rinci, balas INFO.",
      );
    } else if (!heldSuccessfully && this.held.markLimitWarned(ownerId)) {
      replies.push(whatsAppTextCopy(HOLD_LIMIT_REACHED));
    } else if (this.held.markReminded(ownerId)) {
      replies.push([
        whatsAppTextCopy(HOLD_REMINDER),
        "",
        "Balas SETUJU untuk mulai, atau INFO untuk membaca penjelasan rinci.",
      ].join("\n"));
    }

    return replies.join("\n\n");
  }

  private async assessPreConsentRisk(
    text: string,
  ): Promise<"danger" | "calm" | "unknown"> {
    if (hasExplicitImmediateDangerSignal(text)) return "danger";
    try {
      const triage = await this.dependencies.conversation.triageRisk(text);
      if (!triage) return "unknown";
      return triage.level === "bahaya" ? "danger" : "calm";
    } catch (error) {
      this.logger.error(
        "whatsapp_private_pre_consent_triage_failed",
        "Triase keselamatan pra-persetujuan WhatsApp gagal.",
        error,
      );
      return "unknown";
    }
  }

  private async acceptConsent(
    ownerId: string,
    message: WhatsAppPrivateMessage,
  ): Promise<WhatsAppPrivateReplyResult> {
    await this.dependencies.profiles.acceptConsent(ownerId);
    this.dependencies.history.allow(ownerId);
    this.dependencies.memories.allow(ownerId);
    await this.dependencies.telemetry.allow(ownerId);

    const waiting = this.held.takeBatch(ownerId);
    this.held.clear(ownerId);
    if (!waiting.text) return CONSENT_ACCEPTED;

    return this.runConversationTurn(
      ownerId,
      { ...message, text: waiting.text },
      CONSENT_ACCEPTED_HELD,
    );
  }

  private async showMemories(ownerId: string): Promise<string> {
    const items = await this.dependencies.memories.list(ownerId);
    if (items.length === 0) {
      this.memorySelections.delete(ownerId);
      return "Aku belum punya memori tersimpan tentangmu di chat WhatsApp ini.";
    }
    this.memorySelections.set(ownerId, items.map((item) => item.id));
    const lines = items.map((item, index) => {
      const content = item.content.trim().replace(/\s+/gu, " ").slice(0, 240);
      return `${index + 1}. ${content}`;
    });
    return [
      "Memori yang tersimpan di chat WhatsApp ini:",
      "",
      ...lines,
      "",
      "Kirim /lupakan <nomor> untuk menghapus satu item, atau /lupakan-semua untuk menghapus semuanya.",
    ].join("\n");
  }

  private async forgetMemory(ownerId: string, index: number): Promise<string> {
    const selected = this.memorySelections.get(ownerId);
    const memoryId = selected?.[index - 1];
    if (!memoryId) {
      return "Nomor memori itu belum tersedia. Kirim /memori dulu untuk melihat daftar terbaru.";
    }
    const removed = await this.dependencies.memories.forget(ownerId, memoryId);
    this.memorySelections.delete(ownerId);
    return removed
      ? "Memori itu sudah aku lupakan. Kirim /memori untuk melihat daftar terbaru."
      : "Memori itu sudah tidak ada. Kirim /memori untuk memperbarui daftar.";
  }

  private async runConversationTurn(
    ownerId: string,
    message: WhatsAppPrivateMessage,
    prefix = "",
    turnId: string = randomUUID(),
    runtime: ConversationRuntime = {},
    urgentBoundary = false,
  ): Promise<WhatsAppPrivateReply> {
    const startedAt = Date.now();
    await this.dependencies.telemetry.beginTurn(ownerId, turnId);

    return withUsageAttribution(
      {
        turnId,
        subjectKind: "private",
        channel: "whatsapp",
        actorAliases: [],
      },
      async () => {
        try {
          const response = await this.composeReply(
            ownerId,
            message,
            turnId,
            runtime,
            urgentBoundary,
          );
          if (!(await privateRuntimeIsCurrent(runtime))) {
            throw new PrivateTurnSupersededError();
          }
          const delivery = boundedDelivery(prefix, response);
          return this.deliveryAwareReply({
            ownerId,
            turnId,
            replyText: delivery.replyText,
            outboundText: delivery.outboundText,
            startedAt,
            settleUsage: true,
            recordLifecycle: !runtime.isCurrent,
          });
        } catch (error) {
          if (
            error instanceof PrivateTurnSupersededError ||
            !(await privateRuntimeIsCurrent(runtime))
          ) {
            await this.dependencies.telemetry.discardUndelivered(
              ownerId,
              turnId,
            );
            throw new PrivateTurnSupersededError();
          }
          this.logger.error(
            "whatsapp_private_turn_failed",
            "Giliran privat WhatsApp gagal disusun.",
            error,
          );
          await this.dependencies.telemetry.discardUndelivered(ownerId, turnId);
          const response = failureMessage(error);
          const delivery = boundedDelivery(prefix, response);
          return this.deliveryAwareReply({
            ownerId,
            turnId,
            replyText: delivery.replyText,
            outboundText: delivery.outboundText,
            startedAt,
            settleUsage: false,
            recordLifecycle: !runtime.isCurrent,
          });
        }
      },
    );
  }

  private async composeReply(
    ownerId: string,
    message: WhatsAppPrivateMessage,
    turnId: string,
    runtime: ConversationRuntime = {},
    urgentBoundary = false,
  ): Promise<string> {
    const text = message.text;
    const [profile, activeSession, relevant, conversationContext] =
      await Promise.all([
        this.dependencies.profiles.load(ownerId),
        this.dependencies.sessions.active(ownerId),
        this.dependencies.memories.relevantTo(ownerId, text),
        this.dependencies.history.context(ownerId),
      ]);
    await ensurePrivateCurrent(runtime);
    let context: HarvyContext = {
      summary: conversationContext.summary,
      turns: conversationContext.turns,
      memories: relevant,
    };
    const timeZone = profile.timeZone ?? this.options.defaultTimezone;

    if (canUseModelIdentityFastPath(text, context.turns)) {
      await this.noteTurnSignal(ownerId, turnId, "deterministic-fast-path");
      await this.appendUserHistory(ownerId, text, runtime);
      return CAPYBARA_MODEL_REPLY;
    }
    if (canUseDirectTimeFastPath(text, context.turns)) {
      await this.noteTurnSignal(ownerId, turnId, "deterministic-fast-path");
      await this.appendUserHistory(ownerId, text, runtime);
      return this.dependencies.conversation.deterministicTimeReply(timeZone);
    }
    const quickReply = !activeSession && context.turns.length === 0 &&
        !context.summary
      ? deterministicQuickChatReply(text)
      : null;
    if (quickReply) {
      await this.noteTurnSignal(ownerId, turnId, "deterministic-fast-path");
      await this.appendUserHistory(ownerId, text, runtime);
      return quickReply;
    }

    const immediateDanger = hasExplicitImmediateDangerSignal(text);
    if (
      this.dependencies.memoryContextCompiler &&
      !immediateDanger &&
      !urgentBoundary
    ) {
      try {
        const compiled = await this.dependencies.memoryContextCompiler
          .compilePrivate(ownerId, text, context, {
            allowRetrieval: true,
            ...(runtime.signal ? { signal: runtime.signal } : {}),
          });
        context = compiled.context;
      } catch (error) {
        this.logger.warn(
          "whatsapp_private_memory_context_failed",
          "Context memory WhatsApp gagal dikompilasi; recent context dipakai.",
          { errorType: error instanceof Error ? error.name : "unknown" },
        );
      }
      await ensurePrivateCurrent(runtime);
    }

    await this.appendUserHistory(ownerId, text, runtime);
    await ensurePrivateCurrent(runtime);

    let understanding = immediateDanger || urgentBoundary
      ? safetyOnlyUnderstanding()
      : await this.dependencies.conversation.understand(text, context, {
          ...runtime,
          ownerId,
          channel: "whatsapp",
          timeZone,
          session: activeSession && sessionAppliesToMessage(activeSession, text)
            ? activeSession
            : null,
        });
    await ensurePrivateCurrent(runtime);
    const parsedHint = understanding
      ? parseRiskHint(understanding.riskHint, understanding.safetySensitive) ??
        NO_RISK_HINT
      : NO_RISK_HINT;
    const riskHint = withImmediateDangerHint(
      parsedHint,
      immediateDanger || urgentBoundary,
    );
    const triageRequired = understanding === null || riskHint.level !== "none";
    let triage: RiskTriage | null | undefined;
    if (triageRequired) {
      try {
        triage = await this.dependencies.conversation.triageRisk(
          text,
          ownerId,
          context,
          runtime.signal,
        );
      } catch (error) {
        this.logger.error(
          "whatsapp_private_risk_triage_failed",
          "Triase keselamatan WhatsApp gagal.",
          error,
        );
        triage = null;
      }
      if (triage === null) {
        await this.noteTurnSignal(
          ownerId,
          turnId,
          "risk-triage-unavailable",
        );
      }
    }
    await ensurePrivateCurrent(runtime);
    const assessment = resolveRiskAssessment(riskHint, triage);
    if (!understanding && assessment.level !== "biasa") {
      understanding = safetyOnlyUnderstanding();
    }

    if (!understanding) return notUnderstoodNote();

    const engagedSession = activeSession && sessionAppliesToMessage(
        activeSession,
        text,
      )
      ? activeSession
      : null;
    let reply = await this.dependencies.conversation.reply(
      text,
      understanding,
      context,
      profile.stylePreference,
      assessment,
      null,
      false,
      {
        ...runtime,
        ownerId,
        channel: "whatsapp",
        timeZone,
        session: engagedSession,
        routingAssessment: understanding.routingAssessment ?? null,
      },
    );
    reply = normalizeTelegramText(reply);
    reply = withEmergencyAvailability(reply, assessment);
    await ensurePrivateCurrent(runtime);
    return this.guardReply(
      ownerId,
      text,
      reply,
      assessment,
      context,
      turnId,
      runtime,
    );
  }

  private async appendUserHistory(
    ownerId: string,
    text: string,
    runtime: ConversationRuntime,
  ): Promise<void> {
    const stored = await this.dependencies.history.append(
      ownerId,
      "user",
      text,
    );
    if (stored) runtime.markUserCommitted?.();
  }

  private async guardReply(
    ownerId: string,
    message: string,
    reply: string,
    triage: RiskAssessment,
    context: HarvyContext,
    turnId: string,
    runtime: ConversationRuntime,
  ): Promise<string> {
    if (!needsConditionalReplyReview(triage.routing)) return reply;
    runtime.progress?.report({ phase: "checking", detail: "consistency" });
    try {
      const verdict = await this.dependencies.conversation.reviewReply(
        message,
        reply,
        triage,
        ownerId,
        context,
        runtime.signal,
      );
      await ensurePrivateCurrent(runtime);
      if (verdict === true) return reply;
      if (verdict === false) {
        this.logger.warn(
          "whatsapp_private_reply_review_rejected",
          "Balasan WhatsApp ditolak pemeriksaan keselamatan.",
        );
      }
    } catch (error) {
      this.logger.error(
        "whatsapp_private_reply_review_failed",
        "Pemeriksaan balasan WhatsApp gagal.",
        error,
      );
    }
    await this.noteTurnSignal(ownerId, turnId, "safety-fallback");
    return safeFallbackReply(triage.level);
  }

  private deliveryAwareReply(input: {
    ownerId: string;
    turnId: string;
    replyText: string;
    outboundText: string;
    startedAt: number;
    settleUsage: boolean;
    recordLifecycle: boolean;
  }): WhatsAppPrivateReply {
    let finalized = false;
    return {
      text: input.outboundText,
      onDelivered: async (delivery) => {
        if (finalized) return;
        finalized = true;
        const deliveredText = delivery?.text.trim() || input.outboundText;
        const bubbleCount = Math.max(1, delivery?.bubbleCount ?? 1);
        await this.runDeliveryCommitStep(
          "whatsapp_private_response_commit_failed",
          "Status respons privat WhatsApp gagal dicatat setelah terkirim.",
          () => this.dependencies.telemetry.noteTurnResponse(
            input.ownerId,
            input.turnId,
          ),
        );
        if (input.settleUsage) {
          await this.runDeliveryCommitStep(
            "whatsapp_private_usage_delivery_commit_failed",
            "Usage privat WhatsApp gagal ditandai terkirim.",
            () => this.dependencies.telemetry.markDelivered(
              input.ownerId,
              input.turnId,
            ),
          );
        }
        const historyStored = await this.runDeliveryCommitStep(
          "whatsapp_private_history_commit_failed",
          "Balasan privat WhatsApp terkirim tetapi gagal dicatat ke histori.",
          () => this.dependencies.history.append(
            input.ownerId,
            "harvy",
            deliveredText,
          ),
        );
        if (historyStored) {
          void this.dependencies.history.compact(input.ownerId).catch(
            (error: unknown) => {
              this.logger.warn(
                "whatsapp_private_history_compaction_failed",
                "Kompaksi histori privat WhatsApp gagal setelah delivery.",
                { errorType: error instanceof Error ? error.name : "unknown" },
              );
            },
          );
        }
        if (input.recordLifecycle) {
          await this.runDeliveryCommitStep(
            "whatsapp_private_turn_record_failed",
            "Hasil giliran privat WhatsApp gagal dicatat setelah delivery.",
            () => this.recordTurn(input, "completed", bubbleCount),
          );
        }
      },
      onDeliveryFailed: async (delivery) => {
        if (finalized) return;
        finalized = true;
        const deliveredText = delivery?.text.trim() ?? "";
        const partial = deliveredText.length > 0;
        if (partial) {
          await this.runDeliveryCommitStep(
            "whatsapp_private_response_commit_failed",
            "Respons parsial privat WhatsApp gagal dicatat.",
            () => this.dependencies.telemetry.noteTurnResponse(
              input.ownerId,
              input.turnId,
            ),
          );
          if (input.settleUsage) {
            await this.runDeliveryCommitStep(
              "whatsapp_private_usage_delivery_commit_failed",
              "Usage respons parsial WhatsApp gagal ditandai terkirim.",
              () => this.dependencies.telemetry.markDelivered(
                input.ownerId,
                input.turnId,
              ),
            );
          }
          const stored = await this.runDeliveryCommitStep(
            "whatsapp_private_history_commit_failed",
            "Respons parsial WhatsApp gagal dicatat ke histori.",
            () => this.dependencies.history.append(
              input.ownerId,
              "harvy",
              deliveredText,
            ),
          );
          if (stored) {
            void this.dependencies.history.compact(input.ownerId).catch(
              (error: unknown) => {
                this.logger.warn(
                  "whatsapp_private_history_compaction_failed",
                  "Kompaksi histori privat WhatsApp gagal setelah delivery parsial.",
                  {
                    errorType: error instanceof Error
                      ? error.name
                      : "unknown",
                  },
                );
              },
            );
          }
        } else if (input.settleUsage) {
          await this.runDeliveryCommitStep(
            "whatsapp_private_usage_discard_failed",
            "Usage privat WhatsApp gagal dibatalkan setelah delivery gagal.",
            () => this.dependencies.telemetry.discardUndelivered(
              input.ownerId,
              input.turnId,
            ),
          );
        }
        if (input.recordLifecycle) {
          await this.runDeliveryCommitStep(
            "whatsapp_private_turn_record_failed",
            "Hasil giliran privat WhatsApp gagal dicatat setelah delivery gagal.",
            () => this.recordTurn(
              input,
              partial ? "cancelled" : "failed",
              delivery?.bubbleCount ?? 0,
            ),
          );
        }
      },
    };
  }

  private async runDeliveryCommitStep(
    event: string,
    message: string,
    operation: () => Promise<unknown>,
  ): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch (error) {
      this.logger.error(event, message, error);
      return false;
    }
  }

  private async recordTurn(
    input: {
      ownerId: string;
      turnId: string;
      startedAt: number;
    },
    outcome: "completed" | "failed" | "cancelled",
    bubbleCount: number,
  ): Promise<void> {
    const durationMs = Math.max(0, Date.now() - input.startedAt);
    await this.dependencies.telemetry.recordTurn({
      ownerId: input.ownerId,
      turnId: input.turnId,
      subjectKind: "private",
      channel: "whatsapp",
      outcome,
      bubbleCount,
      batchWaitMs: 0,
      queueWaitMs: 0,
      handlingLatencyMs: durationMs,
      totalLatencyMs: durationMs,
    });
    this.logger.info(
      "whatsapp_private_turn_completed",
      "Giliran privat WhatsApp selesai diproses.",
      { outcome, durationMs },
    );
  }

  private async noteTurnSignal(
    ownerId: string,
    turnId: string,
    signal: Parameters<TelemetryService["noteTurnSignal"]>[2],
  ): Promise<void> {
    try {
      await this.dependencies.telemetry.noteTurnSignal(ownerId, turnId, signal);
    } catch (error) {
      this.logger.warn(
        "whatsapp_private_turn_signal_failed",
        "Sinyal telemetry giliran WhatsApp gagal dicatat.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    }
  }
}

async function privateRuntimeIsCurrent(
  runtime: ConversationRuntime,
): Promise<boolean> {
  if (runtime.signal?.aborted) return false;
  if (runtime.awaitCurrent && !(await runtime.awaitCurrent())) return false;
  if (runtime.signal?.aborted) return false;
  return runtime.isCurrent ? await runtime.isCurrent() : true;
}

async function ensurePrivateCurrent(
  runtime: ConversationRuntime,
): Promise<void> {
  if (!(await privateRuntimeIsCurrent(runtime))) {
    throw new PrivateTurnSupersededError();
  }
}

function interruptiblePrivatePause(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

function isDeterministicPrivateControl(text: string): boolean {
  return parseUsageDashboardCommand(text) !== null ||
    isConsentAcceptance(text) ||
    isConsentDetail(text) ||
    isConsentWithdrawal(text) ||
    isHelp(text) ||
    isMemoryList(text) ||
    isMemoryWipe(text) ||
    isMemoryWipeConfirmation(text) ||
    isFullDataDeletion(text) ||
    isFullDataDeletionConfirmation(text) ||
    isCancelControl(text) ||
    parseMemoryForgetIndex(text) !== null ||
    text.trim().startsWith("/");
}

function isConsentAcceptance(text: string): boolean {
  return normalizeCommand(text) === "setuju";
}

function isConsentDetail(text: string): boolean {
  const normalized = normalizeCommand(text);
  return normalized === "info" || normalized === "/info" ||
    normalized === "/izin" || normalized === "jelaskan izin";
}

function isConsentWithdrawal(text: string): boolean {
  const normalized = normalizeCommand(text);
  return normalized === "/tarik-izin" || normalized === "tarik izin ai";
}

function isHelp(text: string): boolean {
  const normalized = normalizeCommand(text);
  return normalized === "/bantuan" || normalized === "/help";
}

function isMemoryList(text: string): boolean {
  const normalized = normalizeCommand(text);
  return normalized === "/memori" || normalized === "lihat memori";
}

function isMemoryWipe(text: string): boolean {
  return normalizeCommand(text) === "/lupakan-semua";
}

function isMemoryWipeConfirmation(text: string): boolean {
  return normalizeCommand(text) === "hapus semua memori";
}

function isFullDataDeletion(text: string): boolean {
  return normalizeCommand(text) === "/hapus-data";
}

function isFullDataDeletionConfirmation(text: string): boolean {
  return normalizeCommand(text) === "hapus semua data";
}

function isCancelControl(text: string): boolean {
  const normalized = normalizeCommand(text);
  return normalized === "batal" || normalized === "/batal";
}

function parseMemoryForgetIndex(text: string): number | null {
  const match = /^\/lupakan\s+(\d{1,4})$/iu.exec(text.trim());
  if (!match?.[1]) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index > 0 ? index : null;
}

function normalizeCommand(text: string): string {
  return text.trim().toLocaleLowerCase("id-ID").replace(/\s+/gu, " ");
}

function whatsAppTextCopy(text: string): string {
  return text
    .replaceAll("menekan tombol", "membalas SETUJU")
    .replaceAll("tombol di atas", "persetujuan di atas")
    .replaceAll("tombol ini", "persetujuan ini")
    .replaceAll(
      "dengan tombol untuk melupakannya",
      "melalui perintah /memori untuk melihat atau melupakannya",
    )
    .split("\n")
    .filter((line) =>
      !line.startsWith("• Untuk pekerjaan planning yang berjalan di latar") &&
      !line.startsWith("• Kalau kamu memilih sesi atau check-in")
    )
    .map((line) =>
      line.startsWith("• Kapan aja kamu bisa melihat atau mengubah memori")
        ? "• Kapan aja kamu bisa melihat atau melupakan memori lewat /memori, menarik izin AI lewat /tarik-izin, dan menghapus seluruh data scope WhatsApp lewat /hapus-data. Mengubah memori dan mengekspor file data belum tersedia lewat adapter WhatsApp ini."
        : line
    )
    .join("\n");
}

function boundedDelivery(
  prefix: string,
  response: string,
): { replyText: string; outboundText: string } {
  const cleanPrefix = prefix.trim();
  const replyText = response.trim();
  const separator = cleanPrefix ? "\n\n" : "";
  return {
    replyText,
    outboundText: `${cleanPrefix}${separator}${replyText}`,
  };
}

function failureMessage(error: unknown): string {
  if (error instanceof UsageLimitError) {
    if (error.reason === "anti_abuse") {
      return "Batas pemakaian singkat Harvy tercapai. Coba lagi setelah jeda; percakapanmu tetap tersimpan.";
    }
    if (error.reason === "wallet_disabled") {
      return "Saldo tambah compute tersedia, tetapi penggunaan otomatis belum diizinkan. Aktifkan dari pengaturan funding, gunakan provider sendiri, atau tunggu pembaruan kapasitas.";
    }
    if (error.reason === "byok_unavailable") {
      return "Provider BYOK-mu belum dapat melayani pekerjaan ini. Pilih provider lain atau gunakan compute Harvy secara eksplisit.";
    }
    return "Penggunaan Harvy-funded untuk periode ini sudah terpakai. Percakapan dan datamu tetap tersimpan; kamu bisa memakai BYOK atau menunggu kapasitas diperbarui.";
  }
  if (error instanceof ByokProviderError) {
    return "Provider BYOK-mu belum dapat menyelesaikan pesan ini. Pilih provider lain atau gunakan compute Harvy secara eksplisit.";
  }
  return AI_FAILURE_MESSAGE;
}
