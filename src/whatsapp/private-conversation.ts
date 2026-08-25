import { randomUUID } from "node:crypto";
import { EMPTY_CONTEXT, type HarvyContext } from "../ai/context.js";
import { ByokProviderError } from "../ai/client.js";
import type {
  Conversation,
  ConversationRuntime,
} from "../ai/conversation.js";
import type { OperationPresentationBrief } from
  "../ai/operation-presentation.js";
import type {
  ControlAction,
  ExtractedTask,
  Understanding,
} from "../ai/understand.js";
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
import { liveStateRequirement } from "../ai/agent.js";
import {
  prefersGuidedSmallStep,
} from "../core/action-policy.js";
import {
  allowsDeterministicSurface,
  requiresPlannedExecution,
  selectGlobalRoute,
} from "../ai/model-policy.js";
import {
  CAPYBARA_MODEL_REPLY,
  canUseModelIdentityFastPath,
} from "../ai/identity.js";
import { deterministicArithmeticReply } from "../bot/fast-path-policy.js";
import {
  CONSENT_ACCEPTED,
  CONSENT_ACCEPTED_EMOJI,
  CONSENT_ACCEPTED_HELD,
  HOLD_LIMIT_REACHED,
  HOLD_REMINDER,
  HeldMessageStore,
  PRE_CONSENT_SAFETY,
  PRE_CONSENT_UNCERTAIN,
  consentDetail,
  introBubbles,
  isOnboardingEntryCommand,
} from "../bot/onboarding.js";
import { normalizeTelegramText } from "../bot/messages.js";
import { MessageBatcher, type MessageBatch } from "../bot/message-batcher.js";
import { notUnderstoodNote } from "../bot/phrasing.js";
import {
  economyCredentialSafetyReply,
  type EconomyCommandService,
} from "../core/economy-command-service.js";
import type { DataControlService } from "../core/data-control-service.js";
import {
  ActiveAgentRunStaleError,
  type AgentRunService,
} from "../core/agent-run-service.js";
import type { HistoryService } from "../core/history-service.js";
import type { MemoryContextCompiler } from "../core/memory-context-compiler.js";
import type { MemoryService } from "../core/memory-service.js";
import { memoriesMatchingNaturalTarget } from
  "../core/memory-natural-control.js";
import {
  containsForbiddenMemorySecret,
  isSensitiveMemory,
} from "../core/memory-policy.js";
import {
  automaticMemoryCandidateAuthorized,
  deriveMemoryMetadata,
  exactExplicitMemoryCandidate,
  inferExplicitResponsePreference,
} from "../core/memory-candidate.js";
import {
  explicitMemoryRememberAuthority,
  normalizeMemoryWriteEmoji,
  replyAcknowledgesMemoryWrite,
  withoutUnconfirmedMemoryWriteClaims,
} from "../core/memory-explicit-consent.js";
import type { ExtractedMemory } from "../ai/understand.js";
import type { MemoryItem } from "../domain/memory.js";
import type { StoredConversationTurn } from "../domain/history.js";
import type { ProfileService } from "../core/profile-service.js";
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
  authorizedSessionSignal,
  sessionAppliesToMessage,
} from "../core/session-policy.js";
import {
  classifyRunMailboxLocally,
  mailboxKindForRelation,
} from "../core/run-mailbox-policy.js";
import {
  ActiveRunIngressBarrier,
  type ActiveRunIngressReservation,
} from "../core/active-run-ingress-barrier.js";
import type { SessionService } from "../core/session-service.js";
import { ActiveSessionError } from "../core/session-service.js";
import type { TaskService } from "../core/task-service.js";
import {
  UsageLimitError,
  type TelemetryService,
} from "../core/telemetry-service.js";
import type { UserUsageSummaryService } from "../core/user-usage-summary-service.js";
import {
  interruptionProgressEvent,
  publicFocusProgressEvent,
  TransientConversationProgress,
} from "../core/conversation-progress.js";
import {
  presentationPauseMs,
} from "../core/response-presentation.js";
import {
  parseUsageDashboardCommand,
  renderUsageDashboard,
  USAGE_COMMAND_TARGET_REJECTED,
} from "../core/usage-dashboard-renderer.js";
import type {
  WhatsAppPrivateMessage,
  WhatsAppPrivateDelivery,
  WhatsAppPrivateOutboundDocument,
  WhatsAppPrivateReply,
  WhatsAppPrivateReplyResult,
  WhatsAppPrivateTransport,
} from "./baileys-message-normalizer.js";
import {
  whatsappPrivateOwnerId,
  whatsAppPrivatePresentationBubbles,
} from "./baileys-message-normalizer.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import {
  renderCommandCategory,
  renderCommandMenu,
  renderHelpMessage,
  type TelegramCommandOptions,
} from "../bot/commands.js";
import {
  CHECK_IN_MESSAGE,
  formatSession,
  formatTask,
  formatTimeSettings,
  MEMORY_SAVE_UNAVAILABLE,
  MEMORY_SECRET_REJECTION,
} from "../bot/messages.js";
import {
  emptyListNote,
  taskCompletedHeading,
  taskDroppedHeading,
  taskListLead,
  taskMissingNote,
  taskSavedHeading,
} from "../bot/phrasing.js";
import {
  immediateUnderstandingRoute,
} from "../bot/understanding-route.js";
import {
  isInQuietHours,
  explicitIndonesianTimeZoneChange,
  explicitQuietHoursChange,
  parseIndonesianTimeZone,
  parseQuietHours,
} from "../core/time-policy.js";
import { resolveActiveTaskReference } from "../core/task-reference.js";
import type { StylePreference } from "../domain/profile.js";
import type { SessionKind, SessionSignal } from "../domain/session.js";
import type { StudentTask } from "../domain/task.js";
import type {
  ActiveAgentRun,
  AgentRunContextSnapshot,
} from "../domain/agent-run.js";
import type { CodingRuntimeComposition } from
  "../core/coding-runtime-composition.js";
import type { PrivateCodingRunHandle } from
  "../core/private-coding-application.js";
import type { PrivateGitHubPublishOffer } from
  "../core/private-github-application.js";
import { renderCodingRunAnchor } from "../coding/coding-run-anchor.js";
import {
  semanticConfidenceBucket,
  semanticOperationContextAvailable,
  semanticOperationAuthorized,
  semanticOperationForExactCommand,
  type SemanticDomain,
  type SemanticOperationName,
} from "../domain/semantic-operation.js";
import {
  TransientInteractionContextStore,
} from "../core/transient-interaction-context.js";
import {
  renderRunAnchor,
  runCancellationAcknowledgement,
  runMailboxCapacityNotice,
  runUpdateAcknowledgement,
} from "../bot/run-anchor.js";

export type {
  WhatsAppPrivateReply,
  WhatsAppPrivateReplyResult,
} from "./baileys-message-normalizer.js";

export interface WhatsAppPrivateConversationDependencies {
  conversation: Pick<
    Conversation,
    "understand" | "triageRisk" | "reply" | "reviewReply" |
    "deterministicTimeReply" | "understandDueDate"
  > & Partial<Pick<
    Conversation,
    "assessTurnBoundary" | "classifyTurnInterruption" |
      "agent" | "presentOperation" |
      "presentScheduledCheckIn"
  >>;
  history: Pick<
    HistoryService,
    "context" | "append" | "compact" | "allow" | "suspend"
  >;
  memories: Pick<
    MemoryService,
    "relevantTo" | "list" | "forget" | "forgetAll" | "allow" | "suspend" |
      "remember" | "markUsed"
  >;
  profiles: Pick<
    ProfileService,
    "load" | "needsOnboarding" | "acceptConsent" | "withdrawConsent" |
      "rememberStyle" | "setTimeZone" | "setQuietHours"
  >;
  sessions: Pick<
    SessionService,
    "active" | "start" | "progress" | "scheduleCheckIn" | "stop" |
      "deliverCheckIn"
  >;
  tasks: Pick<
    TaskService,
    "create" | "listActive" | "find" | "complete" | "remove" |
      "setDue" | "setReminder" | "updateSchedule"
      | "deliverReminder"
  >;
  telemetry: Pick<
    TelemetryService,
    "allow" | "beginTurn" | "noteTurnSignal" | "noteTurnResponse" |
      "recordTurn" | "markDelivered" | "discardUndelivered"
  >;
  memoryContextCompiler?: Pick<MemoryContextCompiler, "compilePrivate">;
  economyCommands?: Pick<EconomyCommandService, "handle">;
  usageDashboard?: Pick<UserUsageSummaryService, "summary">;
  dataControls?: Pick<DataControlService, "deleteAll" | "export">;
  agentRuns?: AgentRunService | null;
  codingRuntime?: Pick<
    CodingRuntimeComposition,
    "application" | "privateGitHub" | "issuePrivateActor"
  > | null;
  proactive?: {
    send(accountId: string, userId: string, text: string): Promise<void>;
    sendTracked(
      accountId: string,
      userId: string,
      text: string,
    ): Promise<{ messageIds: string[] }>;
    editTracked(
      accountId: string,
      userId: string,
      messageId: string,
      text: string,
    ): Promise<{ messageId: string }>;
    removeTracked(
      accountId: string,
      userId: string,
      messageId: string,
    ): Promise<void>;
    setPinned(
      accountId: string,
      userId: string,
      messageId: string,
      pinned: boolean,
    ): Promise<void>;
  };
}

export interface WhatsAppPrivateConversationOptions {
  defaultTimezone: string;
  termsUrl: string;
  telemetryRetentionDays: number;
  operationalLogRetentionDays: number;
}

const AI_FAILURE_MESSAGE =
  "Maaf, aku lagi nggak bisa mikir sekarang — sambungan ke otakku lagi bermasalah. Coba kirim lagi sebentar lagi, ya.";
const MAX_PRIVATE_REPLY_CHARACTERS = 12_000;

interface ComposedPrivateReply {
  text: string;
  presentationBubbles?: readonly string[];
  document?: WhatsAppPrivateOutboundDocument;
  storeHistory: boolean;
  onDelivered?: (delivery?: WhatsAppPrivateDelivery) => Promise<void>;
  onDeliveryFailed?: (delivery?: WhatsAppPrivateDelivery) => Promise<void>;
  interaction?: {
    domain: SemanticDomain;
    operation: SemanticOperationName;
  };
}

interface WhatsAppMemoryBatch {
  saved: MemoryItem[];
  uncommitted: boolean;
  failure: "forbidden-secret" | "write-unavailable" | null;
  acknowledgements: Array<{
    content: string;
    operation: "saved" | "updated" | "already-known";
    explicit: boolean;
  }>;
}

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
  private readonly activeCodingWork = new Set<Promise<void>>();
  private readonly activeAgentWork = new Map<string, {
    runId: string;
    controller: AbortController;
    promise: Promise<void>;
  }>();
  private readonly activeRunIngress = new ActiveRunIngressBarrier();
  private readonly interactionContext = new TransientInteractionContextStore();
  private readonly batcher: MessageBatcher<PrivateIngressCarrier>;
  private acceptingIngress = true;
  private stoppingActiveAgentWork = false;

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

  private commandOptions(): TelegramCommandOptions {
    return {
      codingRuntime: Boolean(this.dependencies.codingRuntime),
      githubPublishing: Boolean(
        this.dependencies.codingRuntime?.privateGitHub,
      ),
    };
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
      if (!text && !message.document) return;
      const needsOnboarding = await this.dependencies.profiles.needsOnboarding(
        ownerId,
      );
      const runIngress = needsOnboarding || message.document
        ? null
        : await this.reserveActiveRunIngress(ownerId, message);
      if (runIngress) {
        this.batcher.drainAndEnqueue(ownerId, async () => {
          let released = false;
          try {
            const result = await this.handleSerial(ownerId, message);
            this.activeRunIngress.release(runIngress);
            released = true;
            await this.deliverResult(result, transport);
          } finally {
            if (!released) this.activeRunIngress.release(runIngress);
          }
        });
        return;
      }
      if (
        needsOnboarding || message.document ||
        isDeterministicPrivateControl(text)
      ) {
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
    await this.stopActiveAgentWork();
    await Promise.allSettled([...this.activeCodingWork]);
  }

  /** Memulihkan work lane privat setelah akun WhatsApp yang sesuai tersambung. */
  async resumeAgentRuns(accountId?: string): Promise<void> {
    const agentRuns = this.dependencies.agentRuns;
    if (!agentRuns || !this.dependencies.proactive || this.stoppingActiveAgentWork) {
      return;
    }
    const runs = await agentRuns.recoverInterruptedActiveRuns("whatsapp");
    for (let run of runs) {
      const target = parseWhatsAppPrivateChatId(run.anchor.chatId);
      if (!target || (accountId && target.accountId !== accountId)) continue;
      try {
        if (run.anchor.messageId === null) {
          const sent = await this.dependencies.proactive.sendTracked(
            target.accountId,
            target.userId,
            renderRunAnchor(run),
          );
          const messageId = sent.messageIds.at(-1);
          if (!messageId) throw new Error("Recovery AgentRun tidak menghasilkan ID pesan.");
          run = await agentRuns.attachActiveAnchor(
            "whatsapp",
            run.ownerId,
            run.runId,
            messageId,
          );
          await this.setActiveRunAnchorPinned(run, true);
        } else {
          await this.updateActiveRunAnchor(run, true);
        }
        if (
          run.status === "queued" ||
          (run.status === "waiting_input" && run.resumeAnswer)
        ) {
          this.launchActiveAgentWork(run);
        }
      } catch (error) {
        this.logger.warn(
          "whatsapp_private_active_run_recovery_deferred",
          "Pemulihan AgentRun WhatsApp ditunda sampai transport akun tersedia.",
          {
            accountId: target.accountId,
            errorType: error instanceof Error ? error.name : "unknown",
          },
        );
      }
    }
  }

  private launchActiveAgentWork(run: ActiveAgentRun): void {
    const agentRuns = this.dependencies.agentRuns;
    if (!agentRuns || this.stoppingActiveAgentWork) return;
    const existing = this.activeAgentWork.get(run.ownerId);
    if (existing?.runId === run.runId) return;
    if (existing) {
      this.logger.warn(
        "whatsapp_private_active_run_foreground_conflict",
        "Work lane WhatsApp menolak foreground kedua untuk pemilik yang sama.",
      );
      return;
    }
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => withUsageAttribution(
        {
          turnId: run.turnId,
          subjectKind: "private",
          channel: "whatsapp",
          actorAliases: [],
        },
        () => this.executeActiveAgentWork(run.ownerId, run.runId, controller),
      ))
      .catch(async (error: unknown) => {
        this.logger.error(
          "whatsapp_private_active_run_failed",
          "Work lane active AgentRun WhatsApp gagal.",
          error,
        );
        await this.dependencies.telemetry.discardUndelivered(
          run.ownerId,
          run.turnId,
        ).catch(() => undefined);
        try {
          const failed = await agentRuns.failActive(
            "whatsapp",
            run.ownerId,
            run.runId,
            "work_lane_failed",
          );
          if (failed) await this.updateActiveRunAnchor(failed);
        } catch (stateError) {
          this.logger.error(
            "whatsapp_private_active_run_failure_state_failed",
            "Kegagalan work lane WhatsApp tidak dapat dipersistenkan.",
            stateError,
          );
        }
      })
      .finally(async () => {
        const current = this.activeAgentWork.get(run.ownerId);
        if (current?.promise !== promise) return;
        this.activeAgentWork.delete(run.ownerId);
        if (this.stoppingActiveAgentWork) return;
        try {
          const latest = await agentRuns.loadForegroundActive(
            "whatsapp",
            run.ownerId,
          );
          if (latest?.runId === run.runId && latest.status === "queued") {
            this.launchActiveAgentWork(latest);
          }
        } catch (error) {
          this.logger.error(
            "whatsapp_private_active_run_wakeup_failed",
            "Status queued AgentRun WhatsApp tidak dapat diperiksa.",
            error,
          );
        }
      });
    this.activeAgentWork.set(run.ownerId, { runId: run.runId, controller, promise });
  }

  private async executeActiveAgentWork(
    ownerId: string,
    runId: string,
    controller: AbortController,
  ): Promise<void> {
    const agentRuns = this.dependencies.agentRuns;
    const agent = this.dependencies.conversation.agent;
    if (!agentRuns || !agent) return;
    for (let revisionPass = 0; revisionPass < 8; revisionPass += 1) {
      const attempt = await agentRuns.beginActiveAttempt(
        "whatsapp",
        ownerId,
        runId,
      );
      if (!attempt) return;
      await this.updateActiveRunAnchor(attempt.run);
      const result = await agent.call(
        this.dependencies.conversation,
        attempt.run.initialRequest,
        attempt.run.mode,
        contextFromActiveRun(attempt.run),
        {
          ownerId,
          channel: "whatsapp",
          timeZone: attempt.run.timeZone,
          style: attempt.run.style,
          intent: attempt.run.intent,
          runId,
          signal: controller.signal,
          isCurrent: () => agentRuns.isActiveAttemptCurrent(
            "whatsapp",
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
      await this.activeRunIngress.waitForIdle(runId);

      if (result.status === "completed") {
        try {
          const completed = await agentRuns.commitActiveFinal(
            {
              channel: "whatsapp",
              ownerId,
              runId,
              inputRevision: attempt.inputRevision,
              checkpoint: result.checkpoint,
              reply: result.reply,
            },
            async () => {
              await this.activeRunIngress.waitForIdle(runId);
              return this.sendActiveRunMessage(attempt.run, result.reply);
            },
          );
          await this.updateActiveRunAnchor(completed);
          await this.dependencies.history.append(ownerId, "harvy", result.reply);
          await this.dependencies.telemetry.markDelivered(ownerId, attempt.run.turnId);
          return;
        } catch (error) {
          if (error instanceof ActiveAgentRunStaleError) {
            const queued = await agentRuns.requeueStaleActive(
              "whatsapp",
              ownerId,
              runId,
              attempt.inputRevision,
              result.checkpoint,
            );
            if (queued?.status === "queued") continue;
          }
          await this.dependencies.telemetry.discardUndelivered(
            ownerId,
            attempt.run.turnId,
          );
          const latest = await agentRuns.loadActive("whatsapp", ownerId);
          if (latest) await this.updateActiveRunAnchor(latest);
          throw error;
        }
      }

      if (result.status === "needs_input") {
        try {
          const waiting = await agentRuns.commitActiveQuestion(
            {
              channel: "whatsapp",
              ownerId,
              runId,
              inputRevision: attempt.inputRevision,
              checkpoint: result.checkpoint,
              prompt: result.prompt,
              // WhatsApp tidak mempunyai update_id monotonik. Admission tetap
              // diikat ke quote exact question; watermark 0/1 hanya memenuhi
              // kontrak lintas kanal tanpa menerima "pesan berikutnya".
              acceptAnswersAfterUpdateId: 0,
            },
            async () => {
              await this.activeRunIngress.waitForIdle(runId);
              return this.sendActiveRunMessage(attempt.run, result.prompt);
            },
          );
          await this.updateActiveRunAnchor(waiting);
          await this.dependencies.history.append(ownerId, "harvy", result.prompt);
          await this.dependencies.telemetry.markDelivered(ownerId, attempt.run.turnId);
          return;
        } catch (error) {
          if (error instanceof ActiveAgentRunStaleError) {
            const queued = await agentRuns.requeueStaleActive(
              "whatsapp",
              ownerId,
              runId,
              attempt.inputRevision,
              result.checkpoint,
            );
            if (queued?.status === "queued") continue;
          }
          await this.dependencies.telemetry.discardUndelivered(
            ownerId,
            attempt.run.turnId,
          );
          const latest = await agentRuns.loadActive("whatsapp", ownerId);
          if (latest) await this.updateActiveRunAnchor(latest);
          throw error;
        }
      }

      if (result.status === "needs_approval") {
        const failed = await agentRuns.failActive(
          "whatsapp",
          ownerId,
          runId,
          "write_approval_unavailable",
        );
        await this.dependencies.telemetry.discardUndelivered(
          ownerId,
          attempt.run.turnId,
        );
        if (failed) await this.updateActiveRunAnchor(failed);
        return;
      }

      this.logger.warn(
        "whatsapp_private_active_run_stopped",
        "Active AgentRun WhatsApp dihentikan oleh guard runtime.",
        {
          reason: result.reason,
          outcome: result.trace.at(-1)?.outcome,
          count: result.trace.length,
        },
      );

      const settled = await agentRuns.settleActiveStopped(
        "whatsapp",
        ownerId,
        runId,
        attempt.inputRevision,
        result,
        this.stoppingActiveAgentWork && controller.signal.aborted,
      );
      if (settled?.status === "queued" && !controller.signal.aborted) {
        await this.updateActiveRunAnchor(settled);
        continue;
      }
      await this.dependencies.telemetry.discardUndelivered(
        ownerId,
        attempt.run.turnId,
      );
      if (settled) await this.updateActiveRunAnchor(settled);
      return;
    }

    const exhausted = await agentRuns.loadActive("whatsapp", ownerId);
    await this.dependencies.telemetry.discardUndelivered(
      ownerId,
      exhausted?.runId === runId ? exhausted.turnId : null,
    );
    const failed = await agentRuns.failActive(
      "whatsapp",
      ownerId,
      runId,
      "revision_limit",
    );
    if (failed) await this.updateActiveRunAnchor(failed);
  }

  private async sendActiveRunMessage(
    run: ActiveAgentRun,
    text: string,
  ): Promise<{ externalId: string; bindingExternalId: string }> {
    const target = parseWhatsAppPrivateChatId(run.anchor.chatId);
    const proactive = this.dependencies.proactive;
    if (!target || !proactive) {
      throw new Error("Target delivery active AgentRun WhatsApp tidak tersedia.");
    }
    const sent = await proactive.sendTracked(target.accountId, target.userId, text);
    const bindingExternalId = sent.messageIds.at(-1);
    if (!bindingExternalId || sent.messageIds.length === 0) {
      throw new Error("Active AgentRun WhatsApp tidak menghasilkan ID pesan.");
    }
    return {
      externalId: sent.messageIds.join(","),
      bindingExternalId,
    };
  }

  private async updateActiveRunAnchor(
    run: ActiveAgentRun,
    ensurePinned = false,
  ): Promise<void> {
    const agentRuns = this.dependencies.agentRuns;
    const proactive = this.dependencies.proactive;
    const target = parseWhatsAppPrivateChatId(run.anchor.chatId);
    if (!agentRuns || !proactive || !target) return;
    if (run.anchor.messageId) {
      try {
        await proactive.editTracked(
          target.accountId,
          target.userId,
          run.anchor.messageId,
          renderRunAnchor(run),
        );
        if (isTerminalActiveRun(run)) {
          await this.setActiveRunAnchorPinned(run, false);
        } else if (ensurePinned) {
          await this.setActiveRunAnchorPinned(run, true);
        }
        return;
      } catch (error) {
        this.logger.warn(
          "whatsapp_private_active_run_anchor_edit_failed",
          "Run Anchor WhatsApp gagal diedit; anchor lama harus dihapus sebelum pengganti dikirim.",
          { errorType: error instanceof Error ? error.name : "unknown" },
        );
        try {
          await proactive.removeTracked(
            target.accountId,
            target.userId,
            run.anchor.messageId,
          );
        } catch (removeError) {
          if (isTerminalActiveRun(run)) {
            await this.setActiveRunAnchorPinned(run, false);
          }
          this.logger.warn(
            "whatsapp_private_active_run_anchor_replace_blocked",
            "Anchor pengganti tidak dikirim karena anchor lama belum berhasil dihapus.",
            {
              errorType: removeError instanceof Error
                ? removeError.name
                : "unknown",
            },
          );
          return;
        }
      }
    }
    const sent = await proactive.sendTracked(
      target.accountId,
      target.userId,
      renderRunAnchor(run),
    );
    const messageId = sent.messageIds.at(-1);
    if (!messageId) throw new Error("Anchor pengganti tidak menghasilkan ID pesan.");
    const attached = await agentRuns.attachActiveAnchor(
      "whatsapp",
      run.ownerId,
      run.runId,
      messageId,
    );
    if (!isTerminalActiveRun(attached)) {
      await this.setActiveRunAnchorPinned(attached, true);
    }
  }

  private async setActiveRunAnchorPinned(
    run: ActiveAgentRun,
    pinned: boolean,
  ): Promise<void> {
    const proactive = this.dependencies.proactive;
    const target = parseWhatsAppPrivateChatId(run.anchor.chatId);
    const messageId = run.anchor.messageId;
    if (!proactive || !target || !messageId) return;
    try {
      await proactive.setPinned(
        target.accountId,
        target.userId,
        messageId,
        pinned,
      );
    } catch (error) {
      this.logger.warn(
        pinned
          ? "whatsapp_private_active_run_anchor_pin_failed"
          : "whatsapp_private_active_run_anchor_unpin_failed",
        pinned
          ? "Run Anchor WhatsApp gagal disematkan."
          : "Run Anchor WhatsApp terminal gagal dilepas dari sematan.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    }
  }

  private abortActiveAgentWork(ownerId: string, runId?: string): void {
    const active = this.activeAgentWork.get(ownerId);
    if (active && (runId === undefined || active.runId === runId)) {
      active.controller.abort();
    }
  }

  private async stopActiveAgentWork(): Promise<void> {
    this.stoppingActiveAgentWork = true;
    this.activeRunIngress.releaseAll();
    const work = [...this.activeAgentWork.values()];
    for (const active of work) active.controller.abort();
    await Promise.allSettled(work.map((active) => active.promise));
  }

  private async activeRunForIngress(
    ownerId: string,
  ): Promise<ActiveAgentRun | null> {
    const agentRuns = this.dependencies.agentRuns;
    if (!agentRuns) return null;
    const expired = await agentRuns.expireWaitingActive("whatsapp", ownerId);
    if (expired) {
      await this.updateActiveRunAnchor(expired);
      return expired;
    }
    return agentRuns.loadForegroundActive("whatsapp", ownerId);
  }

  private async reserveActiveRunIngress(
    ownerId: string,
    message: WhatsAppPrivateMessage,
  ): Promise<ActiveRunIngressReservation | null> {
    if (!message.quotedMessageId) return null;
    const run = await this.activeRunForIngress(ownerId);
    if (
      !run?.anchor.messageId ||
      run.anchor.messageId !== message.quotedMessageId
    ) {
      return null;
    }
    return this.activeRunIngress.reserve(run.runId);
  }

  private async handleLocalActiveRunControl(
    ownerId: string,
    message: WhatsAppPrivateMessage,
    turnId: string,
    runtime: ConversationRuntime,
  ): Promise<ComposedPrivateReply | null> {
    const agentRuns = this.dependencies.agentRuns;
    if (!agentRuns) return null;
    const run = await this.activeRunForIngress(ownerId);
    if (!run) return null;
    const relation = classifyRunMailboxLocally({
      text: message.text,
      run,
      quotedMessageId: message.quotedMessageId ?? null,
    });
    if (relation !== "status_query" && relation !== "cancel") return null;
    await this.noteTurnSignal(ownerId, turnId, "deterministic-fast-path");
    await this.appendUserHistory(ownerId, message.text, runtime);
    if (relation === "status_query") {
      return { text: renderRunAnchor(run), storeHistory: true };
    }
    const routed = await agentRuns.routeActiveMessage({
      channel: "whatsapp",
      ownerId,
      runId: run.runId,
      kind: "cancel",
      content: message.text,
      sourceMessageId: `whatsapp:${message.messageId}`,
      receivedAt: validMessageDate(message.at),
    });
    if (routed.status === "duplicate" || routed.status === "conflict") {
      return { text: "Pembatalan pekerjaan itu sudah diproses.", storeHistory: false };
    }
    if (routed.status === "capacity_exceeded") {
      return { text: runMailboxCapacityNotice(), storeHistory: true };
    }
    if (routed.status !== "accepted") return null;
    this.abortActiveAgentWork(ownerId, run.runId);
    await this.updateActiveRunAnchor(routed.run);
    return {
      text: runCancellationAcknowledgement(routed.committedEffects),
      storeHistory: true,
    };
  }

  private async handleActiveRunMailboxAfterSafety(
    ownerId: string,
    message: WhatsAppPrivateMessage,
    runtime: ConversationRuntime,
  ): Promise<ComposedPrivateReply | null> {
    const agentRuns = this.dependencies.agentRuns;
    if (!agentRuns) return null;
    const run = await this.activeRunForIngress(ownerId);
    await ensurePrivateCurrent(runtime);
    if (!run) return null;
    const relation = classifyRunMailboxLocally({
      text: message.text,
      run,
      quotedMessageId: message.quotedMessageId ?? null,
    });
    if (
      relation === "independent_chat" ||
      relation === "status_query" ||
      relation === "cancel"
    ) {
      return null;
    }
    const kind = mailboxKindForRelation(relation);
    if (!kind) return null;
    const routed = await agentRuns.routeActiveMessage({
      channel: "whatsapp",
      ownerId,
      runId: run.runId,
      kind,
      content: message.text,
      sourceMessageId: `whatsapp:${message.messageId}`,
      receivedAt: validMessageDate(message.at),
      ...(relation === "answer_to_run" && run.pendingQuestion
        ? {
            questionId: run.pendingQuestion.questionId,
            ingressUpdateId: 1,
          }
        : {}),
    });
    await ensurePrivateCurrent(runtime);
    if (routed.status === "duplicate" || routed.status === "conflict") {
      return { text: "Pembaruan pekerjaan itu sudah diterima.", storeHistory: false };
    }
    if (routed.status === "capacity_exceeded") {
      await this.appendUserHistory(ownerId, message.text, runtime);
      return { text: runMailboxCapacityNotice(), storeHistory: true };
    }
    if (routed.status !== "accepted") return null;
    await this.appendUserHistory(ownerId, message.text, runtime);
    await this.updateActiveRunAnchor(routed.run);
    if (routed.run.status === "queued") this.launchActiveAgentWork(routed.run);
    return { text: runUpdateAcknowledgement(relation), storeHistory: true };
  }

  private async discardAgentRunForPrivateDataChange(
    ownerId: string,
  ): Promise<boolean> {
    const agentRuns = this.dependencies.agentRuns;
    if (!agentRuns) return false;
    const current = await agentRuns.loadActive("whatsapp", ownerId);
    let stopped = false;
    let terminal = current;
    if (current && !isTerminalActiveRun(current)) {
      const routed = await agentRuns.routeActiveMessage({
        channel: "whatsapp",
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
      const work = this.activeAgentWork.get(ownerId);
      if (work?.runId === current.runId) {
        work.controller.abort();
        await work.promise;
      }
      if (stopped && terminal) await this.updateActiveRunAnchor(terminal);
    }
    await agentRuns.discardContextData("whatsapp", ownerId);
    return stopped;
  }

  async sendScheduledReminder(
    candidate: StudentTask,
    send: (accountId: string, userId: string, text: string) => Promise<void>,
  ): Promise<boolean> {
    const target = parseWhatsAppPrivateChatId(candidate.chatId);
    if (!target) return false;
    let sent = false;
    const accepted = await this.batcher.runWhenIdle(
      candidate.ownerId,
      async () => {
        const candidateFallback = [
          "🔔 Pengingat",
          "",
          `• ${candidate.title}`,
        ].join("\n");
        const personalized = await this.presentOperation(candidate.ownerId, {
          kind: "reminder-due",
          outcome: "information",
          userMessage: `Pengingat untuk ${candidate.title}`,
          stableBody: ["🔔 Pengingat", "", `• ${candidate.title}`].join("\n"),
          fallbackText: candidateFallback,
        });
        sent = await this.dependencies.tasks.deliverReminder(
          candidate,
          async (current) => {
            const fallbackText = [
              "🔔 Pengingat",
              "",
              `• ${current.title}`,
            ].join("\n");
            const response = current.title === candidate.title &&
                current.dueAt === candidate.dueAt
              ? personalized
              : fallbackText;
            await send(target.accountId, target.userId, response);
            await this.dependencies.history.append(current.ownerId, "harvy", response);
          },
        );
      },
    );
    return accepted && sent;
  }

  async sendScheduledCheckIn(
    candidate: Parameters<SessionService["deliverCheckIn"]>[0],
    send: (accountId: string, userId: string, text: string) => Promise<void>,
  ): Promise<boolean> {
    const target = parseWhatsAppPrivateChatId(candidate.chatId);
    if (!target) return false;
    let sent = false;
    const accepted = await this.batcher.runWhenIdle(
      candidate.ownerId,
      async () => {
        const personalized = await this.scheduledCheckInText(candidate);
        sent = await this.dependencies.sessions.deliverCheckIn(
          candidate,
          async (current) => {
            const response = current.updatedAt === candidate.updatedAt
              ? personalized
              : CHECK_IN_MESSAGE;
            await send(target.accountId, target.userId, response);
            await this.dependencies.history.append(
              current.ownerId,
              "harvy",
              response,
            );
          },
        );
      },
    );
    return accepted && sent;
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
    const interruptionEvent = interruptionProgressEvent(
      batch.interruptionRelation,
    );
    if (interruptionEvent) {
      progress.report(interruptionEvent);
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
    const bubbles = whatsAppPrivatePresentationBubbles(
      prepared,
      MAX_PRIVATE_REPLY_CHARACTERS,
    );
    const delivered: string[] = [];
    const messageIds: string[] = [];
    const messageRefs: Array<string | null> = [];
    try {
      for (const [index, bubble] of bubbles.entries()) {
        if (index > 0) {
          await interruptiblePrivatePause(
            presentationPauseMs(bubble),
            runtime.signal,
          );
        }
        if (
          !(await privateRuntimeIsCurrent(runtime)) ||
          !transport.isCurrent()
        ) {
          throw new PrivateTurnSupersededError();
        }
        if (index === 0) await runtime.progress?.responding?.();
        const sent = await transport.send(bubble);
        messageRefs.push(sent.messageId);
        if (sent.messageId) messageIds.push(sent.messageId);
        delivered.push(bubble);
      }
      if (prepared.document) {
        if (
          !(await privateRuntimeIsCurrent(runtime)) ||
          !transport.isCurrent()
        ) {
          throw new PrivateTurnSupersededError();
        }
        const sent = await transport.sendDocument(prepared.document);
        messageRefs.push(sent.messageId);
        if (sent.messageId) messageIds.push(sent.messageId);
      }
      await prepared.onDelivered?.({
        text: delivered.join("\n\n"),
        bubbleCount: delivered.length + (prepared.document ? 1 : 0),
        complete: true,
        messageIds,
        messageRefs,
      });
    } catch (error) {
      await prepared.onDeliveryFailed?.({
        text: delivered.join("\n\n"),
        bubbleCount: delivered.length,
        complete: false,
        messageIds,
        messageRefs,
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
    if (!text && !message.document) return null;

    const usageCommand = parseUsageDashboardCommand(text);
    if (usageCommand === "invalid") return USAGE_COMMAND_TARGET_REJECTED;
    if (usageCommand === "summary") {
      if (this.dependencies.usageDashboard) {
        const rendered = renderUsageDashboard(
          await this.dependencies.usageDashboard.summary(ownerId),
          "whatsapp",
        ).text;
        return this.interactionAwareReply(
          ownerId,
          rendered,
          "usage",
          "show-summary",
        );
      }
      const rendered = await this.dependencies.economyCommands?.handle(
        ownerId,
        {
          rawText: text,
          semanticOperation: semanticOperationForExactCommand(
            "usage",
            "show-summary",
            text,
          ),
        },
        `whatsapp:${message.messageId}`,
      );
      if (rendered) {
        return this.interactionAwareReply(
          ownerId,
          rendered,
          "usage",
          "show-summary",
        );
      }
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
      this.clearInteraction(ownerId);
      await this.discardAgentRunForPrivateDataChange(ownerId);
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
      await this.discardAgentRunForPrivateDataChange(ownerId);
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
      const onboarding = await this.beginOnboarding(ownerId, text);
      if (!message.document) return onboarding;
      const documentNotice =
        "Setelah menyetujui, kirim ulang file ZIP supaya berkas tidak ditahan sebelum izin.";
      return {
        text: [onboarding.text, documentNotice].filter(Boolean).join("\n\n"),
        presentationBubbles: [
          ...(onboarding.presentationBubbles ?? []),
          documentNotice,
        ],
      };
    }

    if (message.document) {
      return this.uploadProjectZip(message);
    }

    if (isConsentWithdrawal(text)) {
      this.held.clear(ownerId);
      this.memorySelections.delete(ownerId);
      this.pendingMemoryWipes.delete(ownerId);
      this.pendingDataDeletions.delete(ownerId);
      this.clearInteraction(ownerId);
      await this.discardAgentRunForPrivateDataChange(ownerId);
      this.dependencies.history.suspend(ownerId);
      this.dependencies.memories.suspend(ownerId);
      await this.dependencies.profiles.withdrawConsent(ownerId);
      try {
        await this.dependencies.agentRuns?.forget("whatsapp", ownerId);
      } catch (error) {
        this.logger.error(
          "whatsapp_private_consent_agent_run_cleanup_failed",
          "Izin WhatsApp sudah ditarik tetapi checkpoint agent belum dapat dibersihkan.",
          error,
        );
      }
      return [
        "Izin AI sudah ditarik.",
        "Pesan pribadi berikutnya akan kembali ke perkenalan dan tidak diproses sebelum kamu membalas SETUJU.",
        "Data yang sudah ada tetap tersimpan sampai kamu menghapusnya lewat kontrol data Harvy.",
      ].join("\n\n");
    }
    if (isMenu(text)) {
      return this.interactionAwareReply(
        ownerId,
        renderCommandMenu(this.commandOptions(), "whatsapp"),
        "menu",
        "show",
      );
    }
    if (isHelp(text)) {
      return this.interactionAwareReply(
        ownerId,
        renderHelpMessage(this.commandOptions(), "whatsapp"),
        "menu",
        "show-help",
      );
    }
    const capabilityReply = await this.handleCapabilityCommand(
      ownerId,
      message,
    );
    if (capabilityReply !== null) return capabilityReply;
    if (text.startsWith("/")) {
      return [
        "Aku belum punya perintah itu di WhatsApp.",
        "",
        renderHelpMessage(this.commandOptions(), "whatsapp"),
      ]
        .join("\n");
    }

    const credentialReply = economyCredentialSafetyReply(text);
    if (credentialReply) return credentialReply;

    return this.runConversationTurn(ownerId, message);
  }

  private async handleCapabilityCommand(
    ownerId: string,
    message: WhatsAppPrivateMessage,
  ): Promise<WhatsAppPrivateReplyResult> {
    const text = message.text.trim();
    const command = firstCommand(text);
    if (!command) return null;
    const tail = commandTail(text);

    switch (command) {
      case "dukung": {
        const reply = await this.dependencies.economyCommands?.handle(
          ownerId,
          {
            rawText: text,
            semanticOperation: semanticOperationForExactCommand(
              "billing",
              "show-support",
              text,
            ),
          },
          `whatsapp:${message.messageId}`,
        );
        return reply ??
          "Kontribusi sukarela belum tersedia pada instalasi ini dan tidak memengaruhi kualitas Harvy.";
      }
      case "tugas":
        return this.renderTaskList(ownerId, text);
      case "selesai":
        return this.completeTask(ownerId, tail, text);
      case "batalkan-tugas":
      case "hapus-tugas":
        return this.removeTask(ownerId, tail, text);
      case "tenggat":
        return this.changeTaskTime(ownerId, tail, "due", text);
      case "ingatkan":
        return this.changeTaskTime(ownerId, tail, "reminder", text);
      case "sesi":
        return this.handleSessionCommand(ownerId, message, tail);
      case "checkin":
        return this.scheduleCheckIn(ownerId, tail, text);
      case "zona":
      case "timezone":
        return this.setTimeZone(ownerId, tail, text);
      case "jam-tenang":
        return this.setQuietHours(ownerId, tail, text);
      case "gaya":
        return this.setStyle(ownerId, tail, text);
      case "ekspor":
      case "export":
        return this.exportDataReply(ownerId);
      case "project":
        return this.handleProjectCommand(ownerId, message, tail);
      case "code":
        return this.startCoding(ownerId, message, tail);
      case "code_status":
        return this.codingStatus(message);
      case "code_cancel":
        return this.cancelCoding(message);
      case "github":
        return this.handleGitHubCommand(message, tail);
      case "publish":
        return this.preparePublish(message, tail);
      case "konfirmasi-publish":
        return this.confirmPublish(message, tail);
      default:
        return null;
    }
  }

  private async renderTaskList(
    ownerId: string,
    sourceText = "/tugas",
    technicalControls = true,
  ): Promise<string> {
    const active = await this.dependencies.tasks.listActive(ownerId);
    if (active.length === 0) {
      const fallbackText = emptyListNote();
      return this.presentOperation(ownerId, {
        kind: "empty-state",
        outcome: "information",
        userMessage: sourceText,
        stableBody: "Tugas aktif: tidak ada.",
        fallbackText,
        allowedNextSteps: [
          "Kalau ada yang ingin kamu pegang, tulis saja dengan kalimat biasa.",
        ],
      });
    }
    const timeZone = await this.timeZone(ownerId);
    const formatted = active.map((task) =>
      technicalControls
        ? formatWhatsAppTask(task, timeZone)
        : formatTask(task, timeZone)
    );
    const controls = technicalControls
      ? [
          "",
          "Kelola dengan /selesai <id>, /batalkan-tugas <id>, /tenggat <id> <waktu>, atau /ingatkan <id> <waktu>.",
        ]
      : [];
    const fallbackText = [
      taskListLead(),
      "",
      ...formatted,
      ...controls,
    ].join("\n");
    return this.presentOperation(ownerId, {
      kind: "task-list",
      outcome: "information",
      userMessage: sourceText,
      stableBody: [
        "Tugas aktif",
        "",
        ...formatted,
        ...controls,
      ].join("\n"),
      fallbackText,
    }, { timeZone });
  }

  private async completeTask(
    ownerId: string,
    taskId: string,
    sourceText: string,
  ): Promise<string> {
    if (!safeTaskId(taskId)) return "Format: /selesai <id tugas>";
    const completed = await this.dependencies.tasks.complete(ownerId, taskId);
    if (!completed) return taskMissingNote();
    const fallbackText = taskCompletedHeading(completed.title);
    return this.presentOperation(ownerId, {
      kind: "task-completed",
      outcome: "success",
      userMessage: sourceText,
      stableBody: `Tugas selesai\n${completed.title}`,
      fallbackText,
    });
  }

  private async removeTask(
    ownerId: string,
    taskId: string,
    sourceText: string,
  ): Promise<string> {
    if (!safeTaskId(taskId)) return "Format: /batalkan-tugas <id tugas>";
    const removed = await this.dependencies.tasks.remove(ownerId, taskId);
    if (!removed) return taskMissingNote();
    const fallbackText = `${taskDroppedHeading()} ${removed.title}`;
    return this.presentOperation(ownerId, {
      kind: "task-removed",
      outcome: "success",
      userMessage: sourceText,
      stableBody: `Tugas dibatalkan\n${removed.title}`,
      fallbackText,
    });
  }

  private async changeTaskTime(
    ownerId: string,
    input: string,
    kind: "due" | "reminder",
    sourceText: string,
  ): Promise<string> {
    const split = splitIdAndValue(input);
    if (!split) {
      return kind === "due"
        ? "Format: /tenggat <id tugas> <waktu>"
        : "Format: /ingatkan <id tugas> <waktu>";
    }
    const current = await this.dependencies.tasks.find(ownerId, split.id);
    if (!current || current.status !== "active") return taskMissingNote();
    const timeZone = await this.timeZone(ownerId);
    const at = await this.dependencies.conversation.understandDueDate(
      split.value,
      { ownerId, channel: "whatsapp", timeZone },
    );
    if (!at || (kind === "reminder" && at.getTime() <= Date.now())) {
      return "Aku belum menangkap waktu yang sah. Coba seperti “besok jam 7 malam” atau “30 menit lagi”.";
    }
    if (kind === "reminder") {
      const profile = await this.dependencies.profiles.load(ownerId);
      if (isInQuietHours(at, timeZone, profile.quietHours)) {
        return "Waktu itu masuk jam tenangmu. Aku tidak menggesernya diam-diam; pilih waktu lain.";
      }
    }
    const updated = kind === "due"
      ? await this.dependencies.tasks.setDue(ownerId, split.id, at)
      : await this.dependencies.tasks.setReminder(ownerId, split.id, at);
    if (!updated) return taskMissingNote();
    const fallbackText = [
      kind === "due"
        ? "Tenggatnya sudah aku ubah."
        : "Pengingat satu kali sudah dipasang.",
      "",
      formatWhatsAppTask(updated, timeZone),
    ].join("\n");
    return this.presentOperation(ownerId, {
      kind: kind === "due" ? "task-due-updated" : "reminder-scheduled",
      outcome: "success",
      userMessage: sourceText,
      stableBody: formatWhatsAppTask(updated, timeZone),
      fallbackText,
      allowedNextSteps: kind === "due"
        ? ["Kalau perlu, kamu juga bisa menentukan kapan Harvy mengingatkan."]
        : [],
    }, { timeZone });
  }

  private async handleSessionCommand(
    ownerId: string,
    message: WhatsAppPrivateMessage,
    input: string,
  ): Promise<string> {
    const normalized = input.trim();
    const current = await this.dependencies.sessions.active(ownerId);
    if (!normalized || normalized === "status") {
      return current
        ? formatSession(current, await this.timeZone(ownerId))
        : "Saat ini tidak ada sesi aktif. Mulai dengan /sesi mulai <jenis> <tujuan>.";
    }
    const control = normalizeCommand(normalized);
    if (control === "berhenti" || control === "stop") {
      const stopped = await this.dependencies.sessions.stop(ownerId);
      if (!stopped) return "Tidak ada sesi aktif.";
      return this.presentOperation(ownerId, {
        kind: "session-stopped",
        outcome: "success",
        userMessage: message.text,
        stableBody: "Status sesi: berhenti.",
        fallbackText: "Oke, sesi ini berhenti di sini.",
      });
    }
    const signal: SessionSignal | null =
      control === "selesai" ? "done"
        : control === "lanjut" ? "continue"
        : control === "macet" || control === "atur-ulang" ? "stuck"
        : null;
    if (signal) {
      if (!current) return "Tidak ada sesi aktif.";
      const updated = await this.dependencies.sessions.progress(
        ownerId,
        signal,
        current.id,
      );
      if (updated) {
        const timeZone = await this.timeZone(ownerId);
        const fallbackText = formatSession(updated, timeZone);
        return this.presentOperation(ownerId, {
          kind: "session-progressed",
          outcome: "success",
          userMessage: message.text,
          stableBody: fallbackText,
          fallbackText,
        }, { timeZone });
      }
      if (signal !== "done") return "Sesi itu sudah berubah atau selesai.";
      return this.presentOperation(ownerId, {
        kind: "session-completed",
        outcome: "success",
        userMessage: message.text,
        stableBody: "Status sesi: selesai.",
        fallbackText: "Selesai. Aku tidak akan terus mendorong sesi ini.",
      });
    }
    const start = /^(?:mulai\s+)?([\p{L}-]+)\s+(.+)$/iu.exec(normalized);
    if (!start?.[1] || !start[2]?.trim()) {
      return [
        "Format: /sesi mulai <jenis> <tujuan>",
        "Jenis: jernihkan, prioritaskan, fokus, tutor, rencana, atau minta-bantuan.",
      ].join("\n");
    }
    const kind = sessionKind(start[1]);
    if (!kind) return "Jenis sesi tidak dikenali.";
    try {
      const session = await this.dependencies.sessions.start({
        ownerId,
        chatId: whatsappPrivateChatId(message.accountId, message.userId),
        kind,
        goal: start[2],
        taskId: null,
      });
      const timeZone = await this.timeZone(ownerId);
      const fallbackText = [
        "Sesi dimulai.",
        "",
        formatSession(session, timeZone),
        "",
        "Lanjutkan dengan bicara biasa, atau gunakan /sesi lanjut, /sesi macet, /checkin <waktu>, /sesi selesai, dan /sesi berhenti.",
      ].join("\n");
      return this.presentOperation(ownerId, {
        kind: "session-started",
        outcome: "success",
        userMessage: message.text,
        stableBody: formatSession(session, timeZone),
        fallbackText,
        allowedNextSteps: [
          "Lanjutkan dengan bicara biasa; Harvy akan mengikuti tujuan sesi ini.",
        ],
      }, { timeZone });
    } catch (error) {
      if (error instanceof ActiveSessionError) {
        return [
          "Masih ada satu sesi aktif; aku tidak menggantinya diam-diam.",
          "",
          formatSession(error.session, await this.timeZone(ownerId)),
        ].join("\n");
      }
      throw error;
    }
  }

  private async scheduleCheckIn(
    ownerId: string,
    input: string,
    sourceText: string,
  ): Promise<string> {
    const session = await this.dependencies.sessions.active(ownerId);
    if (!session) return "Mulai satu sesi dulu sebelum menjadwalkan check-in.";
    if (!input.trim()) return "Format: /checkin <waktu>";
    const timeZone = await this.timeZone(ownerId);
    const at = await this.dependencies.conversation.understandDueDate(input, {
      ownerId,
      channel: "whatsapp",
      timeZone,
    });
    if (!at || at.getTime() <= Date.now()) {
      return "Aku belum menangkap waktu yang masih akan datang.";
    }
    const profile = await this.dependencies.profiles.load(ownerId);
    if (isInQuietHours(at, timeZone, profile.quietHours)) {
      return "Waktu itu masuk jam tenangmu. Pilih waktu lain, ya.";
    }
    const updated = await this.dependencies.sessions.scheduleCheckIn(
      ownerId,
      at,
      session.id,
    );
    if (!updated) return "Sesi itu sudah berubah atau selesai.";
    const fallbackText =
      `Siap. Aku akan bertanya sekali pada waktu pilihanmu.\n\n${formatSession(updated, timeZone)}`;
    return this.presentOperation(ownerId, {
      kind: "checkin-scheduled",
      outcome: "success",
      userMessage: sourceText,
      stableBody: formatSession(updated, timeZone),
      fallbackText,
    }, { timeZone });
  }

  private async setTimeZone(
    ownerId: string,
    input: string,
    sourceText: string,
  ): Promise<string> {
    const zone = parseIndonesianTimeZone(input);
    if (!zone) return "Pilih zona dengan /zona WIB, /zona WITA, atau /zona WIT.";
    const profile = await this.dependencies.profiles.setTimeZone(ownerId, zone);
    const fallbackText = `Zona waktu tersimpan.\n\n${formatTimeSettings(profile)}`;
    return this.presentOperation(ownerId, {
      kind: "preference-updated",
      outcome: "success",
      userMessage: sourceText,
      stableBody: formatTimeSettings(profile),
      fallbackText,
    }, { timeZone: zone });
  }

  private async setQuietHours(
    ownerId: string,
    input: string,
    sourceText: string,
  ): Promise<string> {
    const normalized = normalizeCommand(input);
    const quiet = normalized === "off" || normalized === "mati"
      ? null
      : parseQuietHours(input);
    if (quiet === null && normalized !== "off" && normalized !== "mati") {
      return "Format: /jam-tenang 21.30-06.00, atau /jam-tenang off.";
    }
    const profile = await this.dependencies.profiles.setQuietHours(ownerId, quiet);
    const fallbackText =
      `${quiet ? "Jam tenang tersimpan." : "Jam tenang dimatikan."}\n\n${formatTimeSettings(profile)}`;
    return this.presentOperation(ownerId, {
      kind: "preference-updated",
      outcome: "success",
      userMessage: sourceText,
      stableBody: formatTimeSettings(profile),
      fallbackText,
    });
  }

  private async setStyle(
    ownerId: string,
    input: string,
    sourceText: string,
  ): Promise<string> {
    const style = stylePreference(input);
    if (!style) return "Pilih /gaya dengarkan atau /gaya saran.";
    await this.dependencies.profiles.rememberStyle(ownerId, style);
    const fallbackText = style === "listen"
      ? "Oke, aku dengarkan dulu; saran nanti kalau kamu minta."
      : "Siap. Kalau kamu cerita, aku akan lebih cepat memberi saran.";
    return this.presentOperation(ownerId, {
      kind: "preference-updated",
      outcome: "success",
      userMessage: sourceText,
      stableBody: style === "listen"
        ? "Gaya respons: dengarkan dulu."
        : "Gaya respons: langsung beri saran.",
      fallbackText,
    }, { style });
  }

  private async exportDataReply(ownerId: string): Promise<WhatsAppPrivateReply> {
    if (!this.dependencies.dataControls?.export) {
      return { text: "Ekspor data belum tersedia pada runtime ini." };
    }
    const snapshot = await this.dependencies.dataControls.export(ownerId);
    const body = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return {
      text: "Aku kirim salinan data Harvy yang boleh kamu lihat sebagai berkas JSON.",
      document: {
        fileName: "harvy-data.json",
        mimetype: "application/json",
        data: body,
        caption: "Ekspor data Harvy",
      },
    };
  }

  private async exportDataComposed(
    ownerId: string,
  ): Promise<ComposedPrivateReply> {
    const reply = await this.exportDataReply(ownerId);
    return {
      text: reply.text,
      ...(reply.document ? { document: reply.document } : {}),
      storeHistory: false,
    };
  }

  private async handleProjectCommand(
    _ownerId: string,
    message: WhatsAppPrivateMessage,
    input: string,
  ): Promise<string> {
    const runtime = this.dependencies.codingRuntime;
    if (!runtime) return "Runtime coding belum diaktifkan oleh deployment Harvy.";
    const actor = this.privateCodingActor(message);
    if (/^new\s+/iu.test(input)) {
      const selected = await runtime.application.createWorkspace(
        actor,
        input.replace(/^new\s+/iu, ""),
      );
      return `Workspace dibuat dan dipilih:\n${selected.workspaceKey}`;
    }
    if (input === "list") {
      const workspaces = await runtime.application.listWorkspaces(actor);
      return workspaces.length === 0
        ? "Belum ada workspace. Buat dengan /project new <nama>."
        : ["Workspace:", ...workspaces.map((workspace) =>
          `• ${workspace.displayName} — ${workspace.workspaceKey} (${workspace.role})`
        )].join("\n");
    }
    if (/^use\s+/iu.test(input)) {
      const selected = await runtime.application.selectWorkspace(
        actor,
        input.replace(/^use\s+/iu, "").trim(),
      );
      return `Workspace aktif: ${selected.workspaceKey}`;
    }
    if (input === "projects") {
      const projects = await runtime.application.listProjects(actor);
      return projects.length === 0
        ? "Workspace ini belum punya project. Kirim file ZIP untuk membuatnya."
        : ["Project:", ...projects.map((project) =>
          `• ${project.projectId} — ${project.source}, revision ${project.revision}`
        )].join("\n");
    }
    if (/^use-project\s+/iu.test(input)) {
      const selected = await runtime.application.selectProject(
        actor,
        input.replace(/^use-project\s+/iu, "").trim(),
      );
      return `Project aktif: ${selected.projectId} (revision ${selected.projectRevision})`;
    }
    if (/^group-confirm\s+/iu.test(input)) {
      const confirmed = await runtime.application.confirmGroupWorkspaceLink(
        actor,
        input.replace(/^group-confirm\s+/iu, "").trim(),
      );
      return confirmed.status === "approved"
        ? "Link grup disetujui. Kembali ke grup dan ulangi permintaan hubungkan workspace."
        : "Link grup sudah disetujui untuk Workspace aktif.";
    }
    return [
      "Kelola project coding:",
      "/project new <nama>",
      "/project list",
      "/project use <workspaceKey>",
      "/project projects",
      "/project use-project <projectId>",
      "/project group-confirm <kode dari grup>",
      "Atau kirim sebuah file ZIP.",
    ].join("\n");
  }

  private async uploadProjectZip(
    message: WhatsAppPrivateMessage,
  ): Promise<string> {
    const runtime = this.dependencies.codingRuntime;
    if (!runtime) return "Runtime coding belum diaktifkan oleh deployment Harvy.";
    const document = message.document;
    if (!document) return "Dokumen project tidak tersedia.";
    const zip = document.fileName.toLocaleLowerCase("en-US").endsWith(".zip") ||
      document.mimetype.toLocaleLowerCase("en-US") === "application/zip";
    if (!zip || document.data.length < 1 || document.data.length > 32 * 1024 * 1024) {
      return "Kirim file ZIP project berukuran maksimal 32 MiB.";
    }
    const uploaded = await runtime.application.uploadZip(
      this.privateCodingActor(message),
      document.data,
    );
    return [
      "Project ZIP sudah diimpor dan dipilih.",
      `Workspace: ${uploaded.workspaceKey}`,
      `Project: ${uploaded.projectId}`,
      `Revision: ${uploaded.projectRevision}`,
      "Mulai dengan /code <task>.",
    ].join("\n");
  }

  private async startCoding(
    ownerId: string,
    message: WhatsAppPrivateMessage,
    request: string,
  ): Promise<string> {
    const runtime = this.dependencies.codingRuntime;
    if (!runtime) return "Runtime coding belum diaktifkan oleh deployment Harvy.";
    if (!request.trim()) return "Tulis task setelah /code.";
    let pendingRun: Parameters<NonNullable<Parameters<
      typeof runtime.application.startCoding
    >[2]>>[0] | null = null;
    const handle = await runtime.application.startCoding(
      this.privateCodingActor(message),
      request,
      (run) => {
        pendingRun = run;
      },
    );
    this.trackCodingCompletion(ownerId, message, handle);
    return (pendingRun ? renderCodingRunAnchor(pendingRun).text : handle.initialAnchor.text);
  }

  private async codingStatus(message: WhatsAppPrivateMessage): Promise<string> {
    const runtime = this.dependencies.codingRuntime;
    if (!runtime) return "Runtime coding belum diaktifkan.";
    const current = await runtime.application.current(this.privateCodingActor(message));
    return current.run
      ? renderCodingRunAnchor(current.run).text
      : "Tidak ada CodingRun foreground aktif.";
  }

  private async cancelCoding(message: WhatsAppPrivateMessage): Promise<string> {
    const runtime = this.dependencies.codingRuntime;
    if (!runtime) return "Runtime coding belum diaktifkan.";
    const run = await runtime.application.cancel(this.privateCodingActor(message));
    return renderCodingRunAnchor(run).text;
  }

  private async handleGitHubCommand(
    message: WhatsAppPrivateMessage,
    input: string,
  ): Promise<string> {
    const github = this.dependencies.codingRuntime?.privateGitHub;
    if (!github) return "GitHub App Broker belum diaktifkan oleh deployment Harvy.";
    const actor = this.privateCodingActor(message);
    if (input === "connect") {
      const started = await github.beginInstallation(actor);
      return [
        "Buka URL GitHub App berikut di browser. Jangan kirim PAT atau token ke chat.",
        started.authorizationUrl ?? "Session installation sudah dibuat; cek statusnya.",
        `Connection: ${started.connection.connectionId}`,
        `Setelah selesai: /github status ${started.connection.connectionId}`,
      ].join("\n\n");
    }
    if (/^status\s+/iu.test(input)) {
      const connection = await github.installationStatus(
        actor,
        input.replace(/^status\s+/iu, "").trim(),
      );
      return [
        `Connection: ${connection.connectionId}`,
        `Status: ${connection.status}`,
        `Installation: ${connection.installationId ?? "belum tersedia"}`,
      ].join("\n");
    }
    if (/^repos\s+/iu.test(input)) {
      const connectionId = input.replace(/^repos\s+/iu, "").trim();
      const page = await github.listRepositories(actor, connectionId);
      return [
        "Repository yang dipilih GitHub App:",
        ...page.repositories.map((repository) =>
          `• ${repository.repositoryFullName} — id ${repository.repositoryId} (${repository.visibility})`
        ),
        "",
        `Pilih: /github use ${connectionId} <repositoryId>`,
      ].join("\n");
    }
    if (/^use\s+/iu.test(input)) {
      const parts = input.replace(/^use\s+/iu, "").trim().split(/\s+/u);
      if (parts.length !== 2) return "Format: /github use <connectionId> <repositoryId>";
      const provisioned = await github.selectAndProvision(actor, {
        connectionId: parts[0]!,
        repositoryId: parts[1]!,
      });
      return [
        "Repository GitHub sudah menjadi project workspace terisolasi.",
        `Repository: ${provisioned.selection.repositoryFullName}`,
        `Base commit: ${provisioned.selection.baseCommit}`,
        `Project: ${provisioned.project.id}`,
      ].join("\n");
    }
    return [
      "/github connect",
      "/github status <connectionId>",
      "/github repos <connectionId>",
      "/github use <connectionId> <repositoryId>",
    ].join("\n");
  }

  private async preparePublish(
    message: WhatsAppPrivateMessage,
    runId: string,
  ): Promise<string> {
    const github = this.dependencies.codingRuntime?.privateGitHub;
    if (!github) return "GitHub App Broker belum diaktifkan.";
    const actor = this.privateCodingActor(message);
    const offer = runId
      ? await github.preparePublishOfferForRun(actor, runId)
      : await github.preparePublishOffer(actor);
    return offer ? renderPublishOffer(offer) : "Draft PR untuk CodingRun terbaru sudah dibuat.";
  }

  private async confirmPublish(
    message: WhatsAppPrivateMessage,
    offerId: string,
  ): Promise<string> {
    const github = this.dependencies.codingRuntime?.privateGitHub;
    if (!github) return "GitHub App Broker belum diaktifkan.";
    if (!safeOpaqueId(offerId)) return "Format: /konfirmasi-publish <offerId>";
    const result = await github.confirmPublishOffer(
      this.privateCodingActor(message),
      offerId,
    );
    return [
      `Status efek GitHub: ${result.receipt.status}`,
      ...(result.nextOffer ? ["", renderPublishOffer(result.nextOffer)] : []),
    ].join("\n");
  }

  private privateCodingActor(message: WhatsAppPrivateMessage) {
    const runtime = this.dependencies.codingRuntime;
    if (!runtime) throw new Error("Runtime coding tidak tersedia.");
    return runtime.issuePrivateActor({
      channel: "whatsapp",
      platformId: message.userId,
      interactionId: `whatsapp:${message.accountId}:${message.messageId}`,
    });
  }

  private trackCodingCompletion(
    ownerId: string,
    message: WhatsAppPrivateMessage,
    handle: PrivateCodingRunHandle,
  ): void {
    const work = handle.completion.then(async (outcome) => {
      const lines = [renderCodingRunAnchor(outcome.run).text];
      if (outcome.localCommit) {
        lines.push(
          "",
          "Commit lokal terverifikasi dibuat.",
          `Commit: ${outcome.localCommit.commit.slice(0, 12)}`,
          `Tree: ${outcome.localCommit.treeHash.slice(0, 12)}`,
          `Branch: ${outcome.localCommit.branch}`,
          "Belum ada push remote tanpa confirmation exact.",
        );
      }
      await this.dependencies.proactive?.send(
        message.accountId,
        message.userId,
        lines.join("\n"),
      );
      this.logger.info(
        "whatsapp_private_coding_completed",
        "CodingRun privat WhatsApp mencapai state terminal.",
        { ownerKind: ownerId.startsWith("whatsapp-user:") ? "private" : "unknown" },
      );
    }).catch((error: unknown) => {
      this.logger.error(
        "whatsapp_private_coding_completion_failed",
        "CodingRun privat WhatsApp berhenti sebelum delivery akhir.",
        error,
      );
    }).finally(() => {
      handle.unsubscribeProgress();
      this.activeCodingWork.delete(work);
    });
    this.activeCodingWork.add(work);
    void work.catch(() => undefined);
  }

  private async timeZone(ownerId: string): Promise<string> {
    return (await this.dependencies.profiles.load(ownerId)).timeZone ??
      this.options.defaultTimezone;
  }

  private async presentOperation(
    ownerId: string,
    brief: OperationPresentationBrief,
    options: {
      context?: HarvyContext;
      style?: StylePreference | null;
      timeZone?: string;
      runtime?: ConversationRuntime;
    } = {},
  ): Promise<string> {
    const present = this.dependencies.conversation.presentOperation;
    if (typeof present !== "function") return brief.fallbackText;
    try {
      const profile = await this.dependencies.profiles.load(ownerId);
      const context = options.context ?? EMPTY_CONTEXT;
      return await present.call(
        this.dependencies.conversation,
        brief,
        context,
        options.style === undefined
          ? profile.stylePreference
          : options.style,
        {
          ...options.runtime,
          ownerId,
          channel: "whatsapp",
          timeZone: options.timeZone ?? profile.timeZone ??
            this.options.defaultTimezone,
        },
      );
    } catch (error) {
      this.logger.warn(
        "whatsapp_private_operation_presentation_failed",
        "Presentasi operasi privat WhatsApp gagal; fallback dipakai.",
        {
          kind: brief.kind,
          errorType: error instanceof Error ? error.name : "unknown",
        },
      );
      return brief.fallbackText;
    }
  }

  private async scheduledCheckInText(
    session: Parameters<SessionService["deliverCheckIn"]>[0],
  ): Promise<string> {
    const present = this.dependencies.conversation.presentScheduledCheckIn;
    if (typeof present !== "function") return CHECK_IN_MESSAGE;
    try {
      const profile = await this.dependencies.profiles.load(session.ownerId);
      return await present.call(
        this.dependencies.conversation,
        session,
        profile.stylePreference,
        {
          ownerId: session.ownerId,
          channel: "whatsapp",
          timeZone: profile.timeZone ?? this.options.defaultTimezone,
        },
      ) ?? CHECK_IN_MESSAGE;
    } catch (error) {
      this.logger.warn(
        "whatsapp_private_checkin_presentation_failed",
        "Pertanyaan check-in WhatsApp gagal dipersonalisasi; fallback dipakai.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
      return CHECK_IN_MESSAGE;
    }
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

  private async beginOnboarding(
    ownerId: string,
    text: string,
  ): Promise<WhatsAppPrivateReply> {
    const shouldHold = Boolean(text.trim()) && !isOnboardingEntryCommand(text);
    const heldSuccessfully = shouldHold && this.held.hold(ownerId, text);
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
        ...introBubbles(
          null,
          shouldHold && heldSuccessfully,
          this.options.termsUrl,
        ),
        "Kalau kamu oke, balas SETUJU. Untuk penjelasan lebih rinci, balas INFO.",
      );
    } else if (
      shouldHold && !heldSuccessfully && this.held.markLimitWarned(ownerId)
    ) {
      replies.push(whatsAppTextCopy(HOLD_LIMIT_REACHED));
    } else if (this.held.markReminded(ownerId)) {
      replies.push([
        whatsAppTextCopy(HOLD_REMINDER),
        "",
        "Balas SETUJU untuk mulai, atau INFO untuk membaca penjelasan rinci.",
      ].join("\n"));
    }

    return {
      text: replies.join("\n\n"),
      presentationBubbles: replies,
    };
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
    await this.dependencies.agentRuns?.forget("whatsapp", ownerId);
    await this.dependencies.profiles.acceptConsent(ownerId);
    this.dependencies.history.allow(ownerId);
    this.dependencies.memories.allow(ownerId);
    await this.dependencies.telemetry.allow(ownerId);
    this.dependencies.agentRuns?.allow("whatsapp", ownerId);

    const waiting = this.held.takeBatch(ownerId);
    this.held.clear(ownerId);
    if (!waiting.text) {
      const bubbles = [CONSENT_ACCEPTED_EMOJI, CONSENT_ACCEPTED];
      return { text: bubbles.join("\n\n"), presentationBubbles: bubbles };
    }

    const response = await this.runConversationTurn(
      ownerId,
      { ...message, text: waiting.text },
      "",
    );
    return prependConsentAcceptedPresentation(response);
  }

  private async showMemories(ownerId: string): Promise<WhatsAppPrivateReply> {
    const items = await this.dependencies.memories.list(ownerId);
    if (items.length === 0) {
      return this.interactionAwareReply(
        ownerId,
        "Aku belum punya memori tersimpan tentangmu di chat WhatsApp ini.",
        "memory",
        "list",
        () => this.memorySelections.delete(ownerId),
      );
    }
    const memoryIds = items.map((item) => item.id);
    const lines = items.map((item, index) => {
      const content = item.content.trim().replace(/\s+/gu, " ").slice(0, 240);
      return `${index + 1}. ${content}`;
    });
    const response = [
      "Memori yang tersimpan di chat WhatsApp ini:",
      "",
      ...lines,
      "",
      "Kirim /lupakan <nomor> untuk menghapus satu item, atau /lupakan-semua untuk menghapus semuanya.",
    ].join("\n");
    return this.interactionAwareReply(
      ownerId,
      response,
      "memory",
      "list",
      () => this.memorySelections.set(ownerId, memoryIds),
    );
  }

  private async forgetMemory(ownerId: string, index: number): Promise<string> {
    const selected = this.memorySelections.get(ownerId);
    const memoryId = selected?.[index - 1];
    if (!memoryId) {
      return "Nomor memori itu belum tersedia. Kirim /memori dulu untuk melihat daftar terbaru.";
    }
    await this.discardAgentRunForPrivateDataChange(ownerId);
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
          const delivery = boundedDelivery(prefix, response.text);
          return this.deliveryAwareReply({
            ownerId,
            turnId,
            replyText: delivery.replyText,
            outboundText: delivery.outboundText,
            startedAt,
            settleUsage: true,
            recordLifecycle: !runtime.isCurrent,
            storeHistory: response.storeHistory,
            ...(!prefix && response.presentationBubbles
              ? { presentationBubbles: response.presentationBubbles }
              : {}),
            ...(response.onDelivered
              ? { onDelivered: response.onDelivered }
              : {}),
            ...(response.onDeliveryFailed
              ? { onDeliveryFailed: response.onDeliveryFailed }
              : {}),
            ...(response.interaction
              ? { interaction: response.interaction }
              : {}),
            ...(response.document ? { document: response.document } : {}),
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
            storeHistory: true,
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
  ): Promise<ComposedPrivateReply> {
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
      interactions: this.interactionContext.read({
        ownerId,
        channel: "whatsapp",
        conversationId: ownerId,
      }),
    };
    const timeZone = profile.timeZone ?? this.options.defaultTimezone;

    const activeControl = await this.handleLocalActiveRunControl(
      ownerId,
      message,
      turnId,
      runtime,
    );
    if (activeControl) return activeControl;

    if (canUseModelIdentityFastPath(text, context.turns)) {
      await this.noteTurnSignal(ownerId, turnId, "deterministic-fast-path");
      await this.appendUserHistory(ownerId, text, runtime);
      return { text: CAPYBARA_MODEL_REPLY, storeHistory: true };
    }
    if (canUseDirectTimeFastPath(text, context.turns)) {
      await this.noteTurnSignal(ownerId, turnId, "deterministic-fast-path");
      await this.appendUserHistory(ownerId, text, runtime);
      return {
        text: this.dependencies.conversation.deterministicTimeReply(timeZone),
        storeHistory: true,
      };
    }
    const immediateDanger = hasExplicitImmediateDangerSignal(text);
    const arithmeticReply = !activeSession && !immediateDanger && !urgentBoundary
      ? deterministicArithmeticReply(text)
      : null;
    if (arithmeticReply) {
      await this.noteTurnSignal(ownerId, turnId, "deterministic-fast-path");
      await this.appendUserHistory(ownerId, text, runtime);
      return { text: arithmeticReply, storeHistory: true };
    }

    let understanding = immediateDanger || urgentBoundary
      ? safetyOnlyUnderstanding()
      : await this.dependencies.conversation.understand(text, context, {
          ...runtime,
          ownerId,
          channel: "whatsapp",
          timeZone,
          session: activeSession,
        });
    await ensurePrivateCurrent(runtime);
    const parsedHint = understanding
      ? parseRiskHint(understanding.riskHint, understanding.safetySensitive) ??
        NO_RISK_HINT
      : NO_RISK_HINT;
    const riskHint = withExplicitSupportHint(
      withImmediateDangerHint(
        parsedHint,
        immediateDanger || urgentBoundary,
      ),
      hasExplicitSupportTriageSignal(text),
    );
    if (
      this.dependencies.memoryContextCompiler && understanding &&
      (understanding.intent !== "smalltalk" ||
        Boolean(understanding.semanticOperation)) &&
      riskHint.level === "none" && !immediateDanger && !urgentBoundary
    ) {
      try {
        const compiled = await this.dependencies.memoryContextCompiler
          .compilePrivate(ownerId, text, context, {
            allowRetrieval: true,
            semanticOperation: understanding.semanticOperation ?? null,
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

    const publicProgressFocus = assessment.level === "biasa"
      ? understanding?.publicFocus ?? null
      : null;
    runtime = { ...runtime, publicProgressFocus };
    const focusEvent = publicFocusProgressEvent(
      runtime.interruptionRelation,
      publicProgressFocus,
    );
    if (focusEvent) runtime.progress?.report(focusEvent);

    if (understanding && assessment.level === "biasa") {
      const semantic = understanding.semanticOperation;
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
        this.logger.info(
          "semantic_route_selected",
          "Semantic WhatsApp turn memakai menu deterministik.",
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
        return {
          text: semantic.operation === "show-help"
            ? renderHelpMessage(this.commandOptions(), "whatsapp")
            : semantic.operation === "show-category" && semantic.target
              ? renderCommandCategory(
                  semantic.target,
                  this.commandOptions(),
                  "whatsapp",
                ) ?? renderCommandMenu(this.commandOptions(), "whatsapp")
              : renderCommandMenu(this.commandOptions(), "whatsapp"),
          storeHistory: false,
          interaction: {
            domain: "menu",
            operation: semantic.operation,
          },
        };
      }

      const accountReply = deterministicSurfaceEligible &&
          semanticOperationContextAvailable(
          semantic,
          context.interactions,
        )
        ? await this.dependencies.economyCommands?.handle(
            ownerId,
            {
              rawText: text,
              semanticOperation: semantic,
              recentInteractions: context.interactions ?? [],
            },
            `whatsapp:${message.messageId}`,
          )
        : null;
      if (accountReply) {
        this.logger.info(
          "semantic_route_selected",
          "Semantic WhatsApp turn memakai account surface deterministik.",
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
        return {
          text: accountReply,
          storeHistory: false,
          ...(semantic
            ? {
                interaction: {
                  domain: semantic.domain,
                  operation: semantic.operation,
                },
              }
            : {}),
        };
      }
    }

    const effectPermissions = safetyEffectPermissions(
      assessment.routing,
      immediateDanger,
    );
    if (assessment.level === "biasa" && effectPermissions.generalState) {
      const mailboxReply = await this.handleActiveRunMailboxAfterSafety(
        ownerId,
        message,
        runtime,
      );
      if (mailboxReply) return mailboxReply;
    }
    const proposedRoute = understanding
      ? immediateUnderstandingRoute(understanding, text)
      : { kind: "conversation" as const };
    const routeAllowed = proposedRoute.kind === "show-tasks"
      ? effectPermissions.generalState && allowsDeterministicSurface(
          understanding?.routingAssessment,
        )
      : proposedRoute.kind === "save-task" ||
        proposedRoute.kind === "update-task" ||
        proposedRoute.kind === "complete-task"
      ? effectPermissions.ordinaryTask
      : proposedRoute.kind === "memory-control" ||
          proposedRoute.kind === "control"
        ? effectPermissions.explicitControl
        : effectPermissions.generalState;
    const route = routeAllowed
      ? proposedRoute
      : { kind: "conversation" as const };
    this.logger.info(
      "semantic_route_evaluated",
      "Proposal semantic WhatsApp privat selesai dipagari kode.",
      {
        route: proposedRoute.kind,
        operation: route.kind,
        outcome: understanding?.intent ?? "none",
        reason: [
          `payload-${understanding?.task ? "t" : "n"}${understanding?.task?.dueAt ? "d" : "n"}${understanding?.task?.remindAt ? "r" : "n"}`,
          `explicit-${understanding?.semanticOperation?.explicitness ?? "none"}`,
          `reference-${understanding?.semanticOperation?.reference ?? "none"}`,
          `allowed-${routeAllowed ? "1" : "0"}`,
          `planning-${requiresPlannedExecution(understanding?.routingAssessment) ? "1" : "0"}`,
        ].join("."),
        decision: [
          `intent-${understanding?.intent ?? "none"}`,
          `semantic-${understanding?.semanticOperation?.domain ?? "none"}-${understanding?.semanticOperation?.operation ?? "none"}`,
          `explicit-${understanding?.semanticOperation?.explicitness ?? "none"}`,
          `reference-${understanding?.semanticOperation?.reference ?? "none"}`,
          `payload-${understanding?.task ? "t" : "n"}${understanding?.task?.dueAt ? "d" : "n"}${understanding?.task?.remindAt ? "r" : "n"}`,
          `proposed-${proposedRoute.kind}`,
          `selected-${route.kind}`,
          `allowed-${routeAllowed ? "1" : "0"}`,
          `planning-${requiresPlannedExecution(understanding?.routingAssessment) ? "1" : "0"}`,
        ].join("."),
        semanticDomain: understanding?.semanticOperation?.domain ?? "none",
        semanticOperation:
          understanding?.semanticOperation?.operation ?? "none",
        confidenceBucket: semanticConfidenceBucket(
          understanding?.semanticOperation,
        ),
        semanticExplicitness:
          understanding?.semanticOperation?.explicitness ?? "none",
        semanticReference:
          understanding?.semanticOperation?.reference ?? "none",
        proposedRoute: proposedRoute.kind,
        selectedRoute: route.kind,
        routeAllowed,
        planningRequired: requiresPlannedExecution(
          understanding?.routingAssessment,
        ),
        taskPayloadPresent: Boolean(understanding?.task),
        duePresent: Boolean(understanding?.task?.dueAt),
        reminderPresent: Boolean(understanding?.task?.remindAt),
      },
    );
    if (proposedRoute.kind !== "conversation" && !routeAllowed) {
      await this.noteTurnSignal(ownerId, turnId, "safe-action-blocked");
    }

    if (route.kind === "memory-control") {
      if (route.action === "list") {
        const listed = await this.dependencies.memories.list(ownerId);
        const ids = listed.map((item) => item.id);
        return {
          text: listed.length === 0
            ? "Aku belum punya memori tersimpan tentangmu di chat WhatsApp ini."
            : [
                "Memori yang tersimpan di chat WhatsApp ini:",
                "",
                ...listed.map((item, index) =>
                  `${index + 1}. ${item.content.trim().replace(/\s+/gu, " ").slice(0, 240)}`
                ),
                "",
                "Kirim /lupakan <nomor> untuk menghapus satu item.",
              ].join("\n"),
          storeHistory: false,
          onDelivered: async () => {
            if (ids.length > 0) this.memorySelections.set(ownerId, ids);
            this.recordInteraction(ownerId, "memory", "list");
          },
        };
      }
      if (route.action === "edit") {
        return {
          text: "Buka /memori, hapus item yang keliru dengan /lupakan <nomor>, lalu minta aku mengingat koreksinya secara eksplisit.",
          storeHistory: false,
        };
      }
      if (route.action === "forget") {
        const current = await this.dependencies.memories.list(ownerId);
        const matches = memoriesMatchingNaturalTarget(
          current,
          route.target,
          route.reference,
        );
        if (matches.length === 0) {
          return {
            text: "Aku belum yakin bagian mana yang kamu maksud. Sebut topiknya, atau buka /memori.",
            storeHistory: true,
          };
        }
        await this.discardAgentRunForPrivateDataChange(ownerId);
        for (const match of matches) {
          await this.dependencies.memories.forget(ownerId, match.id);
        }
        return {
          text: "Oke, bagian yang kamu tunjuk sudah aku lupakan.",
          storeHistory: true,
        };
      }
    }

    if (route.kind === "control") {
      return this.composeControlReply(ownerId, route.action, text);
    }

    if (route.kind === "show-tasks") {
      return {
        text: await this.renderTaskList(ownerId, text, false),
        storeHistory: false,
        interaction: { domain: "task", operation: "list" },
      };
    }

    if (route.kind === "complete-task") {
      await this.appendUserHistory(ownerId, text, runtime);
      await ensurePrivateCurrent(runtime);
      const active = await this.dependencies.tasks.listActive(ownerId);
      const selected = resolveActiveTaskReference(active, route.target);
      if (!selected) {
        return {
          text: active.length === 0
            ? "Belum ada tugas aktif yang bisa diselesaikan."
            : "Aku belum yakin tugas mana yang ingin kamu selesaikan. Sebut judulnya lebih spesifik.",
          storeHistory: true,
        };
      }
      await ensurePrivateCurrent(runtime);
      const completed = await this.dependencies.tasks.complete(
        ownerId,
        selected.id,
      );
      if (!completed) {
        return {
          text: "Tugas itu sudah berubah sebelum sempat kuselesaikan. Buka daftar tugas agar aku memakai state terbaru.",
          storeHistory: true,
        };
      }
      const stableBody = `Tugas selesai\n${completed.title}`;
      const presented = await this.presentOperation(ownerId, {
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
      return { text: presented, storeHistory: true };
    }

    if (route.kind === "update-task") {
      await this.appendUserHistory(ownerId, text, runtime);
      await ensurePrivateCurrent(runtime);
      const active = await this.dependencies.tasks.listActive(ownerId);
      const selected = resolveActiveTaskReference(active, route.target);
      if (!selected) {
        return {
          text: active.length === 0
            ? "Belum ada tugas aktif yang bisa diubah."
            : "Aku belum yakin tugas mana yang ingin kamu ubah. Sebut judulnya lebih spesifik.",
          storeHistory: true,
        };
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
        return {
          text: route.task.remindAt.getTime() <= Date.now()
            ? "Waktu pengingat itu sudah lewat. Pilih waktu yang masih akan datang."
            : "Waktu pengingat itu masuk jam tenangmu. Aku tidak menggesernya diam-diam; pilih waktu lain.",
          storeHistory: true,
        };
      }
      const updated = await this.dependencies.tasks.updateSchedule(
        ownerId,
        selected.id,
        {
          ...(route.task.dueAt ? { dueAt: route.task.dueAt } : {}),
          ...(route.task.remindAt
            ? { reminderAt: route.task.remindAt }
            : {}),
          expected: {
            dueAt: selected.dueAt,
            reminderAt: selected.reminderAt,
          },
        },
      );
      if (!updated) {
        return {
          text: "Tugas itu berubah sebelum jadwal baru sempat disimpan. Coba ulangi agar aku memakai state terbaru.",
          storeHistory: true,
        };
      }
      if (!(await privateRuntimeIsCurrent(runtime))) {
        await this.dependencies.tasks.updateSchedule(ownerId, selected.id, {
          dueAt: selected.dueAt ? new Date(selected.dueAt) : null,
          reminderAt: selected.reminderAt
            ? new Date(selected.reminderAt)
            : null,
          expected: {
            dueAt: updated.dueAt,
            reminderAt: updated.reminderAt,
          },
        }).catch(() => null);
        throw new PrivateTurnSupersededError();
      }
      const stableBody = formatTask(updated, timeZone);
      const presented = await this.presentOperation(ownerId, {
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
      return { text: presented, storeHistory: true };
    }

    if (route.kind === "save-task") {
      await this.appendUserHistory(ownerId, text, runtime);
      await ensurePrivateCurrent(runtime);
      const task = await this.saveExtractedTask(ownerId, message, route.task);
      const fallbackText = [
        taskSavedHeading(),
        "",
        formatTask(task, timeZone),
      ].join("\n");
      const presented = await this.presentOperation(ownerId, {
        kind: "task-created",
        outcome: "success",
        userMessage: text,
        stableBody: formatTask(task, timeZone),
        fallbackText,
        allowedNextSteps: task.reminderAt
          ? []
          : ["Kalau perlu, kamu bisa menentukan kapan Harvy mengingatkan."],
      }, {
        context,
        style: profile.stylePreference,
        timeZone,
        runtime,
      });
      if (!(await privateRuntimeIsCurrent(runtime))) {
        try {
          await this.dependencies.tasks.remove(ownerId, task.id);
        } catch (error) {
          this.logger.error(
            "whatsapp_stale_presented_task_compensation_failed",
            "Tugas dari presentasi WhatsApp stale gagal dikompensasi.",
            error,
          );
        }
        throw new PrivateTurnSupersededError();
      }
      return {
        text: presented,
        storeHistory: true,
      };
    }

    const storedUserTurn = await this.appendUserHistory(ownerId, text, runtime);
    await ensurePrivateCurrent(runtime);

    if (!understanding) {
      return { text: notUnderstoodNote(), storeHistory: true };
    }

    const engagedSession = activeSession && sessionAppliesToMessage(
        activeSession,
        text,
        understanding.semanticOperation,
      )
      ? activeSession
      : null;
    const remembered = effectPermissions.generalState
      ? await this.storeTurnMemories(
          ownerId,
          text,
          understanding,
          storedUserTurn,
          runtime,
        )
      : {
          saved: [],
          uncommitted: false,
          failure: null,
          acknowledgements: [],
        };
    let guarded: string;
    let activeRunLaunch: ActiveAgentRun | null = null;
    let activeRunMemoryNotice: string | null = null;
    try {
      await ensurePrivateCurrent(runtime);
      const requiresLiveState = liveStateRequirement(text) !== null;
      const guidedSmallStep = effectPermissions.generalState &&
        !activeSession &&
        prefersGuidedSmallStep(
          understanding.suggestedActions ?? [],
          understanding.routingAssessment,
        );
      const requiresAgentPlanning = !guidedSmallStep &&
        requiresPlannedExecution(understanding.routingAssessment);
      const agentIntent = understanding.intent === "request" ||
          requiresAgentPlanning
        ? "request"
        : "question";
      const globalRoute = selectGlobalRoute({
        intent: agentIntent,
        messageLength: text.length,
        needsStepByStep: understanding.needsStepByStep,
        assessment: understanding.routingAssessment ?? null,
        specializedFlow: requiresLiveState,
        guidedInteraction: guidedSmallStep,
        risk: assessment.level,
      });
      const planningMode = globalRoute === "orchestrate"
        ? "orchestrate"
        : "tools";
      // Sesi adalah konteks lunak, bukan alasan menurunkan permintaan planning
      // explicit ke reply biasa. Ini juga menjaga parity dengan Telegram.
      const useAgent = (!engagedSession || requiresAgentPlanning) &&
        (globalRoute === "specialized" || globalRoute === "orchestrate") &&
        Boolean(this.dependencies.conversation.agent);
      let reply: string;
      if (remembered.failure === "forbidden-secret") {
        reply = MEMORY_SECRET_REJECTION;
      } else if (remembered.failure === "write-unavailable") {
        reply = MEMORY_SAVE_UNAVAILABLE;
      } else if (
        useAgent &&
        this.dependencies.agentRuns &&
        this.dependencies.proactive
      ) {
        const started = await this.dependencies.agentRuns.startActive({
          channel: "whatsapp",
          ownerId,
          request: text,
          mode: planningMode,
          intent: agentIntent,
          timeZone,
          style: profile.stylePreference,
          context: contextSnapshotForActiveRun(context),
          chatId: whatsappPrivateChatId(message.accountId, message.userId),
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
      } else if (useAgent) {
        const result = await this.dependencies.conversation.agent!.call(
          this.dependencies.conversation,
          text,
          planningMode,
          context,
          {
            ...runtime,
            ownerId,
            channel: "whatsapp",
            timeZone,
            style: profile.stylePreference,
            intent: agentIntent,
            routingAssessment: understanding.routingAssessment ?? null,
            memoryAcknowledgements: remembered.acknowledgements,
          },
        );
        reply = agentResultMessage(result);
      } else {
        reply = await this.dependencies.conversation.reply(
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
            memoryAcknowledgements: remembered.acknowledgements,
          },
        );
      }
      reply = normalizeTelegramText(reply);
      if (
        remembered.acknowledgements.length === 0 &&
        remembered.uncommitted &&
        replyAcknowledgesMemoryWrite(reply)
      ) {
        reply = withoutUnconfirmedMemoryWriteClaims(reply) ||
          "Aku dengar yang kamu ceritakan.";
      }
      if (activeRunLaunch && remembered.acknowledgements.length > 0) {
        activeRunMemoryNotice = normalizeMemoryWriteEmoji(
          memoryWriteNotice(remembered),
        );
      } else if (
        remembered.acknowledgements.length > 0 &&
        !replyAcknowledgesMemoryWrite(reply)
      ) {
        reply = [reply, "", memoryWriteNotice(remembered)].join("\n");
      }
      if (
        remembered.acknowledgements.length > 0 &&
        !activeRunMemoryNotice
      ) {
        reply = normalizeMemoryWriteEmoji(reply);
      }
      reply = withEmergencyAvailability(reply, assessment);
      await ensurePrivateCurrent(runtime);
      guarded = await this.guardReply(
        ownerId,
        text,
        reply,
        assessment,
        context,
        turnId,
        runtime,
      );
    } catch (error) {
      for (const item of remembered.saved) {
        await this.dependencies.memories.forget(ownerId, item.id).catch(
          () => undefined,
        );
      }
      throw error;
    }
    const sessionSignal = engagedSession
      ? authorizedSessionSignal(
          text,
          understanding.sessionSignal,
          engagedSession,
          understanding.semanticOperation,
        )
      : null;
    const presentationBubbles = activeRunLaunch
      ? [
          ...(activeRunMemoryNotice ? [activeRunMemoryNotice] : []),
          guarded,
        ]
      : null;
    const outboundText = presentationBubbles
      ? presentationBubbles.join("\n\n")
      : guarded;
    return {
      text: outboundText,
      ...(activeRunLaunch
        ? { presentationBubbles: presentationBubbles! }
        : {}),
      storeHistory: activeRunLaunch === null,
      onDelivered: async (delivery) => {
        if (activeRunLaunch) {
          const anchorBubbleIndex = (presentationBubbles?.length ?? 1) - 1;
          const positionalRefs = delivery?.messageRefs;
          const compactRefs = delivery?.messageIds;
          const messageId = positionalRefs
            ? positionalRefs[anchorBubbleIndex] ?? null
            : compactRefs && compactRefs.length === presentationBubbles?.length
              ? compactRefs[anchorBubbleIndex] ?? null
              : null;
          try {
            if (!messageId || !this.dependencies.agentRuns) {
              throw new Error("Run Anchor WhatsApp tidak mempunyai ID pesan.");
            }
            const attached = await this.dependencies.agentRuns.attachActiveAnchor(
              "whatsapp",
              ownerId,
              activeRunLaunch.runId,
              messageId,
            );
            await this.setActiveRunAnchorPinned(attached, true);
            this.launchActiveAgentWork(attached);
          } catch (error) {
            this.logger.error(
              "whatsapp_private_active_run_launch_failed",
              "Run Anchor WhatsApp terlihat tetapi work lane gagal diluncurkan.",
              error,
            );
            await this.dependencies.agentRuns?.failActive(
              "whatsapp",
              ownerId,
              activeRunLaunch.runId,
              "surface_not_bound",
            ).catch(() => undefined);
          }
        }
        try {
          await this.dependencies.memories.markUsed(context.memories);
        } catch (error) {
          this.logger.warn(
            "whatsapp_private_memory_usage_mark_failed",
            "Balasan sudah terkirim tetapi penggunaan konteks memori gagal dicatat.",
            { errorType: error instanceof Error ? error.name : "unknown" },
          );
        }
        if (engagedSession) {
          try {
            await this.dependencies.sessions.progress(
              ownerId,
              sessionSignal,
              engagedSession.id,
            );
          } catch (error) {
            this.logger.warn(
              "whatsapp_private_session_progress_failed",
              "Balasan sudah terkirim tetapi progres sesi gagal dicatat.",
              { errorType: error instanceof Error ? error.name : "unknown" },
            );
          }
        }
      },
      ...(remembered.saved.length > 0 || activeRunLaunch
        ? {
            onDeliveryFailed: async (delivery) => {
              const memoryNoticeDelivered = activeRunMemoryNotice
                ? (delivery?.bubbleCount ?? 0) >= 1
                : replyAcknowledgesMemoryWrite(delivery?.text ?? "");
              if (!memoryNoticeDelivered) {
                for (const item of remembered.saved) {
                  await this.dependencies.memories.forget(ownerId, item.id);
                }
              }
              if (activeRunLaunch) {
                await this.dependencies.agentRuns?.failActive(
                  "whatsapp",
                  ownerId,
                  activeRunLaunch.runId,
                  "surface_not_delivered",
                );
              }
            },
          }
        : {}),
    };
  }

  private async appendUserHistory(
    ownerId: string,
    text: string,
    runtime: ConversationRuntime,
  ): Promise<StoredConversationTurn | null> {
    const stored = await this.dependencies.history.append(
      ownerId,
      "user",
      text,
    );
    if (stored) runtime.markUserCommitted?.();
    return stored;
  }

  private async storeTurnMemories(
    ownerId: string,
    text: string,
    understanding: Understanding,
    storedUserTurn: StoredConversationTurn | null,
    runtime: ConversationRuntime,
  ): Promise<WhatsAppMemoryBatch> {
    const explicitResponsePreference = inferExplicitResponsePreference(text);
    // Sama dengan Telegram: turn yang dibuktikan sebagai satu instruksi bentuk
    // jawaban memakai canonical candidate lokal saja agar parafrasa model tidak
    // berubah menjadi prompt consent kedua.
    const proposedMemories: ExtractedMemory[] = explicitResponsePreference
      ? [explicitResponsePreference]
      : [...understanding.memories];
    const explicitResponsePreferenceForbidden = Boolean(
      explicitResponsePreference &&
        containsForbiddenMemorySecret(explicitResponsePreference.content),
    );
    if (explicitResponsePreferenceForbidden) {
      return {
        saved: [],
        uncommitted: false,
        failure: "forbidden-secret",
        acknowledgements: [],
      };
    }
    const initialCandidates = proposedMemories
      .map((memory) => ({
        ...memory,
        ...deriveMemoryMetadata(memory.kind, memory.content, text),
        ...(storedUserTurn ? { sourceSequences: [storedUserTurn.sequence] } : {}),
      }))
      .filter((memory) => !containsForbiddenMemorySecret(memory.content));
    const explicitRememberSignaled = explicitResponsePreference === null &&
      understanding.memoryAction === "remember" &&
      understanding.taskAction === null &&
      understanding.task === null;
    const explicit = explicitRememberSignaled
      ? explicitMemoryRememberAuthority(
          text,
          initialCandidates,
          understanding.semanticOperation,
        )
      : null;
    if (explicit?.forbiddenSecret) {
      return {
        saved: [],
        uncommitted: false,
        failure: "forbidden-secret",
        acknowledgements: [],
      };
    }
    if (explicitRememberSignaled && !explicit) {
      return {
        saved: [],
        uncommitted: true,
        failure: null,
        acknowledgements: [],
      };
    }
    const exactExplicitFallback = explicit &&
        !explicit.forbiddenSecret &&
        explicit.candidateIndexes.length === 0 &&
        (understanding.semanticOperation?.reference === "none" ||
          understanding.semanticOperation?.reference === "quoted")
      ? exactExplicitMemoryCandidate(explicit.requestedText, proposedMemories)
      : null;
    if (explicit && explicit.candidateIndexes.length === 0 && !exactExplicitFallback) {
      return {
        saved: [],
        uncommitted: true,
        failure: "write-unavailable",
        acknowledgements: [],
      };
    }
    const candidates = exactExplicitFallback
      ? [{
          ...exactExplicitFallback,
          ...deriveMemoryMetadata(
            exactExplicitFallback.kind,
            exactExplicitFallback.content,
            text,
          ),
          ...(storedUserTurn ? { sourceSequences: [storedUserTurn.sequence] } : {}),
        }]
      : initialCandidates;
    const explicitIndexes = new Set(
      exactExplicitFallback ? [0] : (explicit?.candidateIndexes ?? []),
    );
    if (explicitResponsePreference) {
      const index = candidates.findIndex((candidate) =>
        candidate.kind === explicitResponsePreference.kind &&
        candidate.content.toLocaleLowerCase("id-ID") ===
          explicitResponsePreference.content.toLocaleLowerCase("id-ID")
      );
      if (index >= 0) explicitIndexes.add(index);
    }
    const saved: MemoryItem[] = [];
    const acknowledgements: WhatsAppMemoryBatch["acknowledgements"] = [];
    let uncommitted = candidates.some((candidate, index) =>
      !explicitIndexes.has(index) &&
      !automaticMemoryCandidateAuthorized(text, candidate)
    );
    try {
      for (const [index, candidate] of candidates.entries()) {
        const explicitlyAuthorized = explicitIndexes.has(index);
        if (
          !explicitlyAuthorized &&
          !automaticMemoryCandidateAuthorized(text, candidate)
        ) continue;
        const privateCandidate = isSensitiveMemory(candidate);
        // Scope ini hanya dicapai setelah consent onboarding aktif. Kandidat
        // percakapan biasa boleh commit tanpa prompt per-item; explicit remember
        // tetap ditandai agar kegagalan permintaannya dijawab dengan jujur.
        const stored = await this.dependencies.memories.remember({
          ownerId,
          kind: candidate.kind,
          content: candidate.content,
          ...(candidate.sourceSequences
            ? { sourceSequences: [...candidate.sourceSequences] }
            : {}),
          ...memoryKnowledgeFields(candidate),
          ...(privateCandidate
            ? { sensitivity: "personal" as const, sensitiveConsent: true }
            : {}),
        });
        if (stored) {
          saved.push(stored);
          acknowledgements.push({
            content: stored.content,
            operation: candidate.correction ? "updated" : "saved",
            explicit: explicitlyAuthorized,
          });
          continue;
        }
        const duplicate = (await this.dependencies.memories.list(ownerId))
          .find((item) => item.content.toLocaleLowerCase("id-ID") ===
            candidate.content.toLocaleLowerCase("id-ID"));
        if (duplicate) {
          if (explicitlyAuthorized) {
            acknowledgements.push({
              content: duplicate.content,
              operation: "already-known",
              explicit: true,
            });
          }
          continue;
        }
        uncommitted = true;
      }
    } catch (error) {
      for (const item of saved) {
        await this.dependencies.memories.forget(ownerId, item.id).catch(
          () => undefined,
        );
      }
      throw error;
    }
    const committedExplicit = acknowledgements.filter((item) => item.explicit)
      .length;
    return {
      saved,
      uncommitted,
      failure: explicitIndexes.size > committedExplicit
        ? "write-unavailable"
        : null,
      acknowledgements,
    };
  }

  private async composeControlReply(
    ownerId: string,
    action: ControlAction,
    text: string,
  ): Promise<ComposedPrivateReply> {
    switch (action) {
      case "data":
        return {
          text: [
            "Kontrol data WhatsApp privat:",
            "/memori — lihat memori",
            "/lupakan <nomor> — hapus satu memori",
            "/lupakan-semua — hapus semua memori",
            "/ekspor — ekspor data",
            "/tarik-izin — hentikan pemrosesan AI",
            "/hapus-data — hapus seluruh data",
          ].join("\n"),
          storeHistory: false,
        };
      case "timezone": {
        const zone = explicitIndonesianTimeZoneChange(text);
        if (!zone) {
          return {
            text: "Pilih zona dengan /zona WIB, /zona WITA, atau /zona WIT.",
            storeHistory: false,
          };
        }
        const profile = await this.dependencies.profiles.setTimeZone(ownerId, zone);
        return { text: formatTimeSettings(profile), storeHistory: false };
      }
      case "quiet-hours": {
        const quiet = explicitQuietHoursChange(text);
        if (!quiet) {
          return {
            text: "Atur dengan /jam-tenang 21.30-06.00, atau /jam-tenang off.",
            storeHistory: false,
          };
        }
        const profile = await this.dependencies.profiles.setQuietHours(ownerId, quiet);
        return { text: formatTimeSettings(profile), storeHistory: false };
      }
      case "active-session": {
        const session = await this.dependencies.sessions.active(ownerId);
        return {
          text: session
            ? formatSession(session, await this.timeZone(ownerId))
            : "Saat ini tidak ada sesi aktif.",
          storeHistory: false,
        };
      }
      case "withdraw-consent":
        return {
          text: "Untuk memastikan ini benar-benar keputusanmu, kirim /tarik-izin.",
          storeHistory: false,
        };
      case "export":
        return this.exportDataComposed(ownerId);
      case "delete-all":
        return {
          text: "Untuk memulai penghapusan seluruh data, kirim /hapus-data.",
          storeHistory: false,
        };
    }
  }

  private async saveExtractedTask(
    ownerId: string,
    message: WhatsAppPrivateMessage,
    extracted: ExtractedTask,
  ): Promise<StudentTask> {
    const profile = await this.dependencies.profiles.load(ownerId);
    const timeZone = profile.timeZone ?? this.options.defaultTimezone;
    const reminderRejected = extracted.remindAt !== null &&
      (extracted.remindAt.getTime() <= Date.now() ||
        isInQuietHours(extracted.remindAt, timeZone, profile.quietHours));
    return this.dependencies.tasks.create({
      ownerId,
      chatId: whatsappPrivateChatId(message.accountId, message.userId),
      title: extracted.title,
      dueAt: extracted.dueAt,
      remindAt: reminderRejected ? null : extracted.remindAt,
      importance: extracted.importance,
    });
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
    storeHistory: boolean;
    presentationBubbles?: readonly string[];
    document?: WhatsAppPrivateOutboundDocument;
    interaction?: {
      domain: SemanticDomain;
      operation: SemanticOperationName;
    };
    onDelivered?: (delivery?: WhatsAppPrivateDelivery) => Promise<void>;
    onDeliveryFailed?: (delivery?: WhatsAppPrivateDelivery) => Promise<void>;
  }): WhatsAppPrivateReply {
    let finalized = false;
    return {
      text: input.outboundText,
      ...(input.presentationBubbles
        ? { presentationBubbles: input.presentationBubbles }
        : {}),
      ...(input.document ? { document: input.document } : {}),
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
        const historyStored = input.storeHistory
          ? await this.runDeliveryCommitStep(
              "whatsapp_private_history_commit_failed",
              "Balasan privat WhatsApp terkirim tetapi gagal dicatat ke histori.",
              () => this.dependencies.history.append(
                input.ownerId,
                "harvy",
                deliveredText,
              ),
            )
          : null;
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
        if (input.interaction) {
          this.recordInteraction(
            input.ownerId,
            input.interaction.domain,
            input.interaction.operation,
          );
        }
        await input.onDelivered?.(delivery);
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
          const stored = input.storeHistory
            ? await this.runDeliveryCommitStep(
                "whatsapp_private_history_commit_failed",
                "Respons parsial WhatsApp gagal dicatat ke histori.",
                () => this.dependencies.history.append(
                  input.ownerId,
                  "harvy",
                  deliveredText,
                ),
              )
            : null;
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
        await input.onDeliveryFailed?.(delivery);
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

  private recordInteraction(
    ownerId: string,
    domain: SemanticDomain,
    operation: SemanticOperationName,
  ): void {
    this.interactionContext.record({
      ownerId,
      channel: "whatsapp",
      conversationId: ownerId,
    }, {
      domain,
      operation,
    });
  }

  private clearInteraction(ownerId: string): void {
    this.interactionContext.clear({
      ownerId,
      channel: "whatsapp",
      conversationId: ownerId,
    });
  }

  private interactionAwareReply(
    ownerId: string,
    text: string,
    domain: SemanticDomain,
    operation: SemanticOperationName,
    beforeRecord?: () => void,
  ): WhatsAppPrivateReply {
    let finalized = false;
    return {
      text,
      onDelivered: async () => {
        if (finalized) return;
        finalized = true;
        beforeRecord?.();
        this.recordInteraction(ownerId, domain, operation);
      },
      onDeliveryFailed: async () => {
        finalized = true;
      },
    };
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

const WHATSAPP_PRIVATE_CHAT_PREFIX = "whatsapp-private:";

export function whatsappPrivateChatId(
  accountId: string,
  userId: string,
): string {
  const account = encodeURIComponent(accountId.trim());
  const user = encodeURIComponent(userId.trim());
  if (!account || !user) throw new Error("Target WhatsApp privat tidak sah.");
  return `${WHATSAPP_PRIVATE_CHAT_PREFIX}${account}:${user}`;
}

export function parseWhatsAppPrivateChatId(
  value: string,
): { accountId: string; userId: string } | null {
  if (!value.startsWith(WHATSAPP_PRIVATE_CHAT_PREFIX)) return null;
  const encoded = value.slice(WHATSAPP_PRIVATE_CHAT_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator === encoded.length - 1) return null;
  try {
    const accountId = decodeURIComponent(encoded.slice(0, separator));
    const userId = decodeURIComponent(encoded.slice(separator + 1));
    return accountId && userId ? { accountId, userId } : null;
  } catch {
    return null;
  }
}

function firstCommand(text: string): string | null {
  const match = /^\/([a-z][a-z0-9_-]*)(?:@[^\s]+)?(?:\s|$)/iu.exec(text.trim());
  return match?.[1]?.toLocaleLowerCase("id-ID") ?? null;
}

function commandTail(text: string): string {
  return text.trim().replace(/^\/[^\s]+\s*/u, "").trim();
}

function safeTaskId(value: string): value is string {
  return /^[a-z0-9_-]{1,80}$/iu.test(value.trim());
}

function safeOpaqueId(value: string): boolean {
  return /^[a-z0-9_-]{8,256}$/iu.test(value.trim());
}

function splitIdAndValue(value: string): { id: string; value: string } | null {
  const match = /^([a-z0-9_-]{1,80})\s+(.+)$/iu.exec(value.trim());
  return match?.[1] && match[2]?.trim()
    ? { id: match[1], value: match[2].trim() }
    : null;
}

function sessionKind(value: string): SessionKind | null {
  switch (normalizeCommand(value)) {
    case "jernihkan":
    case "clarify":
      return "clarify";
    case "prioritaskan":
    case "prioritas":
    case "prioritize":
      return "prioritize";
    case "fokus":
    case "focus":
      return "focus";
    case "tutor":
    case "belajar":
      return "tutor";
    case "rencana":
    case "plan":
      return "plan";
    case "minta-bantuan":
    case "human-bridge":
      return "human-bridge";
    default:
      return null;
  }
}

function stylePreference(value: string): StylePreference | null {
  switch (normalizeCommand(value)) {
    case "dengarkan":
    case "didengarkan":
    case "dengar":
    case "listen":
      return "listen";
    case "langsung":
    case "saran":
    case "advice":
      return "advice";
    default:
      return null;
  }
}

function renderPublishOffer(offer: PrivateGitHubPublishOffer): string {
  return [
    "Confirmation GitHub exact (workspace-private)",
    `Capability: ${offer.capability}`,
    `Repository: ${offer.repositoryFullName}`,
    `Branch: ${offer.branch}`,
    `Commit: ${offer.commit}`,
    `Base commit: ${offer.baseCommit}`,
    `Effect ID: ${offer.effectId}`,
    `Audience: ${offer.audience}`,
    `Authority revision: ${offer.authorityRevision}`,
    `Expires: ${offer.expiresAt}`,
    "",
    `Konfirmasi hanya dengan: /konfirmasi-publish ${offer.offerId}`,
  ].join("\n");
}

function formatWhatsAppTask(task: StudentTask, timeZone: string): string {
  return `${formatTask(task, timeZone)}\n  ID: ${task.id}`;
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

function isTerminalActiveRun(run: ActiveAgentRun): boolean {
  return run.status === "completed" || run.status === "partial" ||
    run.status === "failed" || run.status === "cancelled";
}

function validMessageDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function agentResultMessage(
  result: Awaited<ReturnType<Conversation["agent"]>>,
): string {
  if (result.status === "completed") return result.reply;
  if (result.status === "needs_input") return result.prompt;
  if (result.status === "needs_approval") {
    return "Aku menghentikan run ini karena agent baca-saja meminta izin untuk perubahan yang tidak tersedia.";
  }
  if (result.reason === "deadline") {
    return "Aku belum menyelesaikan run ini sebelum batas waktunya. Aku tidak akan mengarang hasilnya.";
  }
  if (result.reason.startsWith("budget_")) {
    return "Aku menghentikan run saat batas kerja kumulatifnya tercapai. Aku tidak akan mengarang atau meneruskan hasil setengah jadi.";
  }
  if (result.reason === "cycle") {
    return "Aku menghentikan run karena planner mengulang langkah yang sama. Coba ulangi pertanyaannya; aku tidak akan mengarang hasilnya.";
  }
  if (result.reason === "usage_anti_abuse") {
    return "Batas pemakaian singkat Harvy tercapai. Coba lagi setelah jeda; task dan percakapanmu tetap tersimpan.";
  }
  if (result.reason === "usage_wallet_disabled") {
    return "Saldo tambah compute tersedia, tetapi penggunaan otomatis belum diizinkan. Aktifkan funding atau gunakan provider sendiri untuk melanjutkan.";
  }
  if (result.reason === "usage_byok_unavailable") {
    return "Provider milikmu belum cocok untuk pekerjaan ini. Pilih provider lain atau gunakan compute Harvy secara eksplisit.";
  }
  if (result.reason === "usage_allowance_exhausted") {
    return "Kapasitas Harvy-funded periode ini sudah terpakai. Gunakan BYOK, tambah compute, atau tunggu kapasitas diperbarui.";
  }
  return "Run agent berhenti sebelum menghasilkan jawaban yang dapat dipercaya.";
}

function memoryKnowledgeFields(item: ExtractedMemory): Pick<
  ExtractedMemory,
  "subject" | "predicate" | "value" | "correction" | "provenance" |
    "graphProjection"
> {
  return {
    ...(item.subject !== undefined ? { subject: item.subject } : {}),
    ...(item.predicate !== undefined ? { predicate: item.predicate } : {}),
    ...(item.value !== undefined ? { value: item.value } : {}),
    ...(item.correction !== undefined ? { correction: item.correction } : {}),
    ...(item.provenance !== undefined ? { provenance: item.provenance } : {}),
    ...(item.graphProjection !== undefined
      ? { graphProjection: item.graphProjection }
      : {}),
  };
}

function memoryWriteNotice(batch: WhatsAppMemoryBatch): string {
  if (batch.acknowledgements.length > 1) {
    return "Oke, beberapa hal penting dari ceritamu aku simpan untuk kuingat ke depan 📍";
  }
  switch (batch.acknowledgements[0]?.operation) {
    case "updated":
      return "Oke, yang itu sudah aku perbarui untuk ke depan 📍";
    case "already-known":
      return "Iya, yang itu masih aku ingat.";
    case "saved":
    default:
      return "Oke, yang ini aku ingat untuk ke depan 📍";
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
    isMenu(text) ||
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
    normalized === "/izin";
}

function isConsentWithdrawal(text: string): boolean {
  const normalized = normalizeCommand(text);
  return normalized === "/tarik-izin";
}

function isHelp(text: string): boolean {
  const normalized = normalizeCommand(text);
  return normalized === "/bantuan" || normalized === "/help";
}

function isMenu(text: string): boolean {
  return normalizeCommand(text) === "/menu";
}

function isMemoryList(text: string): boolean {
  const normalized = normalizeCommand(text);
  return normalized === "/memori";
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
    .replace(
      "Kalau kamu oke, kita mulai.",
      "Kalau kamu oke, balas SETUJU dan kita mulai.",
    );
}

function prependConsentAcceptedPresentation(
  response: WhatsAppPrivateReply,
): WhatsAppPrivateReply {
  const prefix = [CONSENT_ACCEPTED_EMOJI, CONSENT_ACCEPTED_HELD];
  const responseBubbles = whatsAppPrivatePresentationBubbles(
    response,
    MAX_PRIVATE_REPLY_CHARACTERS,
  );
  const adaptDelivery = (
    delivery: WhatsAppPrivateDelivery | undefined,
    complete: boolean,
  ): WhatsAppPrivateDelivery => {
    const deliveredAfterPrefix = Math.max(0, (delivery?.bubbleCount ?? 0) - prefix.length);
    const deliveredTextBubbles = Math.min(
      deliveredAfterPrefix,
      responseBubbles.length,
    );
    return {
      text: responseBubbles.slice(0, deliveredTextBubbles).join("\n\n"),
      bubbleCount: deliveredAfterPrefix,
      complete,
      ...(delivery?.messageIds
        ? { messageIds: delivery.messageIds.slice(prefix.length) }
        : {}),
      ...(delivery?.messageRefs
        ? { messageRefs: delivery.messageRefs.slice(prefix.length) }
        : {}),
    };
  };
  return {
    ...response,
    text: [...prefix, response.text.trim()].join("\n\n"),
    presentationBubbles: [...prefix, ...responseBubbles],
    ...(response.onDelivered
      ? {
          onDelivered: (delivery?: WhatsAppPrivateDelivery) =>
            response.onDelivered!(adaptDelivery(delivery, true)),
        }
      : {}),
    ...(response.onDeliveryFailed
      ? {
          onDeliveryFailed: (delivery?: WhatsAppPrivateDelivery) =>
            response.onDeliveryFailed!(adaptDelivery(delivery, false)),
        }
      : {}),
  };
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
