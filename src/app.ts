import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AiClient } from "./ai/client.js";
import { OpenAiCompatibleEmbeddingProvider } from "./ai/embedding-client.js";
import { Conversation } from "./ai/conversation.js";
import type { HarvyContext } from "./ai/context.js";
import { GroupConversation } from "./ai/group-conversation.js";
import { GroupAgentRunExecutor } from "./ai/group-agent-run-executor.js";
import { createModelAgentWorker } from "./ai/agent.js";
import { createConfiguredSpecialistExecutor } from "./ai/specialist-runtime.js";
import {
  currentUsageAttribution,
  withUsageAttribution,
} from "./ai/usage-attribution.js";
import { createBot } from "./bot/create-bot.js";
import { telegramCommands } from "./bot/commands.js";
import { startAgentRunRetentionWorker } from "./agent/agent-run-retention-worker.js";
import {
  aiClientOptions,
  loadConfig,
  loadOperationalLogConfig,
  type AiConfig,
  type EconomyConfig,
} from "./config.js";
import {
  createCodingRuntimeComposition,
  loadCodingRuntimeDeploymentConfig,
} from "./core/coding-runtime-composition.js";
import { HistoryService } from "./core/history-service.js";
import { AgentRunService } from "./core/agent-run-service.js";
import { DataControlService } from "./core/data-control-service.js";
import { GroupAgentRunService } from "./core/group-agent-run-service.js";
import { GroupAgentRunCleanupService } from "./core/group-agent-run-cleanup-service.js";
import { startGroupAgentRunCleanupWorker } from "./core/group-agent-run-cleanup-worker.js";
import { startGroupAgentRunActivationRetry } from "./core/group-agent-run-activation-retry.js";
import { GroupAgentRunLifecycleCoordinator } from "./core/group-agent-run-lifecycle-coordinator.js";
import { startGroupAgentRunRetentionWorker } from "./core/group-agent-run-retention-worker.js";
import { GroupAgentRunUsageReconciler } from "./core/group-agent-run-usage-reconciler.js";
import { GroupAgentRunIngressRouter } from "./core/group-agent-run-ingress.js";
import { GroupCodingIngressRouter } from "./core/group-coding-ingress.js";
import { GroupCodingDeliveryService } from "./core/group-coding-delivery-service.js";
import {
  GroupWorkspaceCodingController,
  GroupWorkspaceLinkService,
} from "./core/group-workspace-coding-controller.js";
import {
  startGroupAgentRunWorker,
  type GroupAgentRunWorker,
} from "./core/group-agent-run-worker.js";
import { createGroupAgentRunWorkProcessor } from "./core/group-agent-run-work-processor.js";
import { createGroupAgentRunRuntimePorts } from "./core/group-agent-run-runtime.js";
import { GroupMemoryService } from "./core/group-memory-service.js";
import {
  GROUP_NOTICE_VERSION,
  GroupTurnService,
} from "./core/group-turn-service.js";
import { InsightService } from "./core/insight-service.js";
import { MemoryService } from "./core/memory-service.js";
import { MemoryKnowledgeService } from "./core/memory-knowledge-service.js";
import { MemoryContextCompiler } from "./core/memory-context-compiler.js";
import { LongTermMemoryService } from "./core/long-term-memory-service.js";
import { ProfileService } from "./core/profile-service.js";
import { SessionService } from "./core/session-service.js";
import { shutdownGracefully } from "./core/shutdown-service.js";
import { TaskService } from "./core/task-service.js";
import { TelemetryService } from "./core/telemetry-service.js";
import {
  ControlPlaneService,
  type PriceBootstrap,
} from "./core/control-plane-service.js";
import { UsageLedgerService } from "./core/usage-ledger-service.js";
import { EconomyService } from "./core/economy-service.js";
import { EconomyCommandService } from "./core/economy-command-service.js";
import { UserUsageSummaryService } from "./core/user-usage-summary-service.js";
import {
  LocalPaymentGateway,
  UnavailablePaymentGateway,
} from "./core/payment-gateway.js";
import { EncryptedFileSecretStore } from "./core/secret-store.js";
import { groupRuntimeAdmission } from "./core/group-runtime-policy.js";
import { ConsoleServer } from "./console/console-server.js";
import {
  ChannelSetupService,
  primaryWhatsAppRuntimeFingerprint,
} from "./operations/channel-setup.js";
import { CodingRuntimeSetupService } from
  "./operations/coding-runtime-setup.js";
import { installThirdPartyConsoleSecretGuard } from
  "./observability/third-party-console-guard.js";
import { startCheckInWorker } from "./reminders/checkin-worker.js";
import { startReminderWorker } from "./reminders/reminder-worker.js";
import { FileHistoryRepository } from "./storage/file-history-repository.js";
import { FileAgentRunRepository } from "./storage/file-agent-run-repository.js";
import { FileGroupAgentRunRepository } from "./storage/file-group-agent-run-repository.js";
import { FileGroupAgentRunCleanupIntentRepository } from "./storage/file-group-agent-run-cleanup-repository.js";
import { FileGroupRepository } from "./storage/file-group-repository.js";
import { FileProfileRepository } from "./storage/file-profile-repository.js";
import { FileSessionRepository } from "./storage/file-session-repository.js";
import { FileTelemetryRepository } from "./storage/file-telemetry-repository.js";
import { FileControlPlaneRepository } from "./storage/file-control-plane-repository.js";
import { FileUsageLedgerRepository } from "./storage/file-usage-ledger-repository.js";
import { FileEntitlementLedgerRepository } from "./storage/file-entitlement-ledger-repository.js";
import { FileEconomyRepository } from "./storage/file-economy-repository.js";
import { MarkdownInsightRepository } from "./storage/markdown-insight-repository.js";
import { MarkdownMemoryRepository } from "./storage/markdown-memory-repository.js";
import { FileMemoryKnowledgeRepository } from "./storage/file-memory-knowledge-repository.js";
import { SqliteLongTermMemoryRepository } from "./storage/sqlite-long-term-memory-repository.js";
import { FileTaskRepository } from "./storage/file-task-repository.js";
import {
  BaileysAccountManager,
  type WhatsAppAccountStatus,
} from "./whatsapp/baileys-account-manager.js";
import {
  parseWhatsAppPrivateChatId,
  WhatsAppPrivateConversation,
} from "./whatsapp/private-conversation.js";
import { GroupMessageBatcher } from "./whatsapp/group-message-batcher.js";
import qrCodeTerminal from "qrcode-terminal";
import {
  createOperationalLogSystem,
} from "./observability/operational-logger.js";
import {
  operatorSecretChannelAvailable,
  presentOperatorSecret,
} from "./observability/operator-secret.js";
import { installProcessDiagnostics } from "./observability/process-diagnostics.js";
import {
  AgentHarness,
} from "./harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "./harness/capabilities.js";
import {
  groupScopeKey,
  type GroupMessage,
} from "./domain/group.js";
import type { GroupTurnOutcome } from "./core/group-turn-service.js";
import {
  acquireLocalRuntimeLock,
  localRuntimeLockPath,
  type LocalRuntimeLock,
} from "./core/local-runtime-lock.js";
import { createInternalAgentExecutors } from "./agent/internal-executors.js";
import { VirtualTerminalExecutor } from "./agent/virtual-terminal.js";
import { ParallelDelegationExecutor } from "./agent/parallel-delegation.js";

async function main(): Promise<void> {
  installThirdPartyConsoleSecretGuard();
const logSystem = await createOperationalLogSystem(
  loadOperationalLogConfig(),
);
const logger = logSystem.logger;
const removeProcessDiagnostics = installProcessDiagnostics(
  logSystem,
  logger.child("process"),
);
let runtimeLock: LocalRuntimeLock | null = null;
let removeDevShutdownControl: () => void = () => undefined;

try {
const config = loadConfig();
const economyConfig: EconomyConfig = config.controlPlane.economy ?? {
  file: join("data", "economy.json"),
  byokSecretFile: join("data", "byok-secrets.json"),
  byokMasterKey: null,
  paymentGatewayMode: "disabled",
  paygComputeUnitsPerIdr: "1000000",
  gettingLowThresholdBps: 5_000,
  lowThresholdBps: 2_000,
  notificationCooldownMs: 24 * 60 * 60 * 1_000,
  supportMilestone: 8,
};
const codingDeployment = loadCodingRuntimeDeploymentConfig();
runtimeLock = await acquireLocalRuntimeLock(
  localRuntimeLockPath(config.controlPlane.file),
  "runtime",
);
const repository = new FileTaskRepository(config.dataFile);
const tasks = new TaskService(repository);
const controlPlane = new ControlPlaneService(
  new FileControlPlaneRepository(config.controlPlane.file),
  {
    fallbackRollingTokenLimit: config.ai.rollingTokenLimit,
    betaQuotaMultiplier: config.controlPlane.betaQuotaMultiplier,
    configuredModels: config.ai.configuredModels,
    priceBootstraps: modelPriceBootstraps(config.ai),
  },
);
await controlPlane.initialize();
const economySecretStore = economyConfig.byokMasterKey
  ? new EncryptedFileSecretStore(
      economyConfig.byokSecretFile,
      economyConfig.byokMasterKey,
    )
  : null;
const paymentGateway = economyConfig.paymentGatewayMode === "local"
  ? new LocalPaymentGateway()
  : new UnavailablePaymentGateway();
const economy = new EconomyService(
  new FileEconomyRepository(economyConfig.file),
  controlPlane,
  {
    providerId: config.ai.providerId,
    paygComputeUnitsPerIdr: economyConfig.paygComputeUnitsPerIdr,
    gettingLowThresholdBps: economyConfig.gettingLowThresholdBps,
    lowThresholdBps: economyConfig.lowThresholdBps,
    notificationCooldownMs:
      economyConfig.notificationCooldownMs,
    supportMilestone: economyConfig.supportMilestone,
    paymentGateway,
  },
  undefined,
  economySecretStore,
);
if (economySecretStore) {
  economy.setCredentialAvailabilityProvider((credentialRef) =>
    economy.credentialAvailable(credentialRef));
}
const usageLedger = new UsageLedgerService(
  new FileUsageLedgerRepository(config.controlPlane.usageLedgerFile),
  controlPlane,
  {
    retentionDays: config.controlPlane.usageLedgerRetentionDays,
    entitlementRepository: new FileEntitlementLedgerRepository(
      config.controlPlane.entitlementLedgerFile,
    ),
    economicFunding: economy,
  },
);
const usageDashboard = new UserUsageSummaryService(economy, usageLedger);
economy.setLegacyTokenUsageProvider((ownerId, since, until) =>
  usageLedger.debitedTokens(ownerId, since, until).then((value) => value ?? 0));
const telemetry = new TelemetryService(
  new FileTelemetryRepository(config.telemetryFile),
  {
    rollingTokenLimit: config.ai.rollingTokenLimit,
    retentionDays: config.telemetryRetentionDays,
    prices: config.ai.prices,
    limitForOwner: (ownerId) => controlPlane.effectiveLimit(ownerId),
    fundingAuthority: economy,
  },
  undefined,
  logger.child("core.telemetry"),
  usageLedger,
);

const aiClient = new AiClient({
  ...aiClientOptions(config.ai),
  usageObserver: telemetry,
  attemptObserver: usageLedger,
  bufferAttemptObserver: true,
  environment: runtimeEnvironment(config.operationalLog.environment),
  costCenter: "runtime",
  logger: logger.child("ai.client"),
  fundingCredentialResolver: (funding, ownerId) =>
    economy.credentialForReservation(funding.reservationId, ownerId),
});
const groupMemories = config.whatsapp.enabled
  ? new GroupMemoryService(
      new FileGroupRepository(config.whatsapp.groupFile),
    )
  : null;
const codingRuntime = await createCodingRuntimeComposition({
  config: codingDeployment,
  aiClient,
  ai: config.ai,
  groupBindings: groupMemories,
  logger: logger.child("coding.runtime"),
});
// Authority internal perlu tersedia sebelum registry agent dibentuk. Scope
// executor tetap mengambil owner dari AgentExecutionContext, bukan dari model.
const profiles = new ProfileService(
  new FileProfileRepository(config.profileFile),
);
const sessionRepository = new FileSessionRepository(config.sessionFile);
const sessions = new SessionService(sessionRepository, sessionRepository);
const agentRuns = new AgentRunService(
  new FileAgentRunRepository(config.agentRunFile),
);
const longTermRepository = new SqliteLongTermMemoryRepository(
  config.longTermMemoryFile,
);
const longTermMemory = new LongTermMemoryService(
  longTermRepository,
  undefined,
  undefined,
  undefined,
  undefined,
  logger.child("core.long-term-memory"),
);
const internalExecutors = createInternalAgentExecutors({
  tasks,
  profiles,
  sessions,
  defaultTimeZone: config.defaultTimezone,
});
const specialistExecutor = createConfiguredSpecialistExecutor(
  aiClient,
  config.ai,
  config.ai.specialistDelegationEnabled,
);
const agentExecutors = [
  ...internalExecutors,
  new VirtualTerminalExecutor(),
  ...(specialistExecutor
    ? [specialistExecutor]
    : [
        new ParallelDelegationExecutor(
          createModelAgentWorker(aiClient, config.ai),
        ),
      ]),
];
// Satu registry tepercaya dipakai semua kanal. Capability hanya tersedia bila
// executor dan dependency yang cocok benar-benar dipasang.
const agentHarness = new AgentHarness(
  createHarvyCapabilityCatalog({
    internalToolsInstalled: true,
    virtualTerminalInstalled: true,
    parallelDelegationInstalled: specialistExecutor === null,
    specialistDelegationInstalled: specialistExecutor !== null,
  }),
  undefined,
  longTermMemory,
);
const conversation = new Conversation(
  aiClient,
  config.ai,
  config.defaultTimezone,
  () => new Date(),
  logger.child("ai.conversation"),
  agentHarness,
  agentExecutors,
);

// Memori berupa berkas Markdown, satu folder per pengguna. Berkas JSON lama
// hanya dibaca sekali sebagai bahan impor, lalu tidak pernah ditulis lagi.
const memoryEmbedding = config.ai.memoryEmbeddingModel
  ? new OpenAiCompatibleEmbeddingProvider({
      baseUrl: config.ai.baseUrl,
      keys: config.ai.keys,
      model: config.ai.memoryEmbeddingModel,
      providerId: config.ai.providerId,
    })
  : null;
const memoryKnowledge = new MemoryKnowledgeService(
  new FileMemoryKnowledgeRepository(
    join(config.memoryFolder, "_knowledge"),
  ),
  memoryEmbedding,
  undefined,
  undefined,
  longTermRepository,
  logger.child("core.memory-knowledge"),
);
const memories = new MemoryService(
  new MarkdownMemoryRepository(config.memoryFolder, config.memoryFile),
  undefined,
  memoryKnowledge,
  logger.child("core.memory"),
  longTermMemory,
);

// Peringkasnya memanggil model, tetapi `HistoryService` sendiri tidak tahu
// apa-apa soal itu — ia hanya memegang fungsi. Itu yang membuat aturan
// pemadatan dapat diuji tanpa kunci API.
const history = new HistoryService(
  new FileHistoryRepository(config.historyFile),
  (turns, ownerId) => conversation.summarizeEpisode(turns, ownerId),
  undefined,
  logger.child("core.history"),
  longTermMemory,
);
const memoryContextCompiler = new MemoryContextCompiler(
  history,
  memoryKnowledge,
  undefined,
  logger.child("core.memory-context"),
  longTermMemory,
);

// Catatan tersembunyi tinggal di folder yang sama dengan memori pengguna,
// supaya "hapus semua data" berarti satu tempat. Konstitusi v0.3 Pasal 4
// nomor 6 mengizinkannya justru dengan syarat batas-batasnya jelas.
const insights = new InsightService(
  new MarkdownInsightRepository(config.memoryFolder),
  (summary, turns, ownerId) =>
    conversation.readInsight(summary, turns, ownerId),
);

const dataControls = new DataControlService(
  tasks,
  memories,
  history,
  profiles,
  insights,
  sessions,
  telemetry,
  undefined,
  agentRuns,
  memoryKnowledge,
  longTermMemory,
);

// Penghapusan lintas beberapa berkas dilanjutkan sebelum bot menerima update.
// Profil tombstone-nya dihapus paling akhir oleh DataControlService.
await telemetry.purgeExpired();
await agentRuns.purgeExpired();
await dataControls.resumePendingDeletions();
await longTermMemory.recover();
logger.info(
  "startup_data_recovery_completed",
  "Retensi telemetry dan pemulihan penghapusan tertunda selesai.",
);

const bot = createBot(
  config,
  tasks,
  conversation,
  memories,
  history,
  profiles,
  insights,
  sessions,
  dataControls,
  telemetry,
  logger.child("telegram.bot"),
  agentRuns,
  memoryContextCompiler,
  codingRuntime,
  economy,
  usageDashboard,
);
let whatsapp: BaileysAccountManager | null = null;
const whatsappPrivate = config.whatsapp.enabled && config.whatsapp.privateEnabled
  ? new WhatsAppPrivateConversation(
      {
        conversation,
        history,
        memories,
        profiles,
        sessions,
        tasks,
        telemetry,
        memoryContextCompiler,
        economyCommands: new EconomyCommandService(economy, usageDashboard),
        usageDashboard,
        dataControls,
        agentRuns,
        codingRuntime,
        proactive: {
          send: async (accountId, userId, text) => {
            if (!whatsapp) {
              throw new Error("Transport WhatsApp privat belum tersedia.");
            }
            await whatsapp.sendPrivateText(accountId, userId, text);
          },
          sendTracked: async (accountId, userId, text) => {
            if (!whatsapp) {
              throw new Error("Transport WhatsApp privat belum tersedia.");
            }
            return whatsapp.sendPrivateTextTracked(accountId, userId, text);
          },
          editTracked: async (accountId, userId, messageId, text) => {
            if (!whatsapp) {
              throw new Error("Transport WhatsApp privat belum tersedia.");
            }
            return whatsapp.editPrivateText(
              accountId,
              userId,
              messageId,
              text,
            );
          },
          removeTracked: async (accountId, userId, messageId) => {
            if (!whatsapp) {
              throw new Error("Transport WhatsApp privat belum tersedia.");
            }
            await whatsapp.removePrivateText(accountId, userId, messageId);
          },
          setPinned: async (accountId, userId, messageId, pinned) => {
            if (!whatsapp) {
              throw new Error("Transport WhatsApp privat belum tersedia.");
            }
            await whatsapp.setPrivateMessagePinned(
              accountId,
              userId,
              messageId,
              pinned,
            );
          },
        },
      },
      {
        defaultTimezone: config.defaultTimezone,
        termsUrl: config.termsUrl,
        telemetryRetentionDays: config.telemetryRetentionDays,
        operationalLogRetentionDays: config.operationalLog.retentionDays,
      },
      logger.child("whatsapp.private"),
    )
  : null;

let groupTurns: GroupTurnService | null = null;
let groupBatcher: GroupMessageBatcher | null = null;
let groupAgentRunCleanup: GroupAgentRunCleanupService | null = null;
let groupAgentRunIngress: GroupAgentRunIngressRouter | null = null;
let groupAgentRunWorker: GroupAgentRunWorker | null = null;
let groupCodingIngress: GroupCodingIngressRouter | null = null;
let groupCodingDeliveries: GroupCodingDeliveryService | null = null;
let groupAgentRunActivationRetry: ReturnType<
  typeof startGroupAgentRunActivationRetry
> | null = null;
const groupAgentRunLifecycle = new GroupAgentRunLifecycleCoordinator();
const groupAgentRunRuntimeAdmission = async (
  { scopeKey, accountId }: { scopeKey: string; accountId: string },
): Promise<boolean> => {
  if (!config.groupAgentRunEnabled) return false;
  if (await groupAgentRunCleanup?.isPending(scopeKey, accountId)) return false;
  const binding = await groupMemories?.binding(scopeKey);
  if (
    !binding || binding.accountId !== accountId || binding.disabledAt !== null
  ) return false;
  const enrollment = await controlPlane.enrollmentForOwner(scopeKey);
  const mode = enrollment.groupRuntimeMode ?? "direct_only";
  return mode !== "disabled" && mode !== "paused";
};
whatsapp = config.whatsapp.enabled
  ? new BaileysAccountManager(config.whatsapp, {
      onMessage: async (message) => {
        if (groupBatcher) await groupBatcher.enqueue(message);
        else if (groupTurns) {
          await runManagedGroupTurn(controlPlane, groupTurns, message);
        }
      },
      ...(whatsappPrivate
        ? {
            onPrivateMessage: (message, transport) =>
              whatsappPrivate.ingest(message, transport),
          }
        : {}),
      onGroupActive: async (message, authorityFence) => {
        const scopeKey = groupScopeKey(message.scope);
        const cleanupCoordinator = groupAgentRunCleanup;
        if (!cleanupCoordinator) {
          throw new Error("Coordinator cleanup GroupAgentRun belum siap.");
        }
        groupBatcher?.invalidateScope(scopeKey, message.accountId);
        groupTurns?.invalidateAuthority(scopeKey, message.accountId);
        const activation = await cleanupCoordinator.activateWhenClean(
          scopeKey,
          message.accountId,
          () => groupTurns!.activateGroup(message, authorityFence),
        );
        if (activation.status === "pending") {
          groupAgentRunActivationRetry?.enqueue(scopeKey, message.accountId);
          void groupAgentRunActivationRetry?.runNow();
          logger.warn(
            "whatsapp_group_reactivation_cleanup_pending",
            "Reaktivasi grup ditahan sampai cleanup durable lama selesai.",
            { accountId: message.accountId },
          );
          return;
        }
        const outcome = activation.value;
        if (outcome === "notice-failed") {
          groupAgentRunActivationRetry?.enqueue(scopeKey, message.accountId);
          void groupAgentRunActivationRetry?.runNow();
          logger.warn(
            "whatsapp_group_notice_pending",
            "Notice grup belum terkirim dan akan dicoba lagi sebelum pesan live diproses.",
            { accountId: message.accountId },
          );
          return;
        }
        groupAgentRunActivationRetry?.cancel(scopeKey, message.accountId);
        if (outcome === "inactive") {
          return;
        } else if (outcome === "binding-conflict") {
          logger.error(
            "whatsapp_group_binding_conflict",
            "Grup sudah terikat ke akun Harvy lain; akun ini tidak akan menjawab.",
            new Error("Binding akun WhatsApp bertentangan."),
            { accountId: message.accountId },
          );
        } else {
          logger.info(
            "whatsapp_group_activated",
            "Grup WhatsApp aktif untuk akun Harvy.",
            { accountId: message.accountId },
          );
        }
      },
      onGroupDisabled: async (scopeKey, accountId) => {
        // Batasi ingress akun ini sebelum satu pun read binding. Efek cleanup
        // masuk coordinator yang sama dengan aktivasi dan recovery worker.
        groupBatcher?.invalidateScope(scopeKey, accountId);
        groupTurns?.invalidateAuthority(scopeKey, accountId);
        groupAgentRunActivationRetry?.cancel(scopeKey, accountId);
        let codingFenceFailure: unknown = null;
        try {
          await codingRuntime?.fenceGroupCoding({
            scopeKey,
            accountId,
            cause: "group_disabled",
          });
        } catch (error) {
          codingFenceFailure = error;
          logger.error(
            "whatsapp_group_coding_fence_failed",
            "Ingress grup sudah tertutup, tetapi lifecycle fence CodingRun memerlukan recovery.",
            error,
            { accountId },
          );
        }
        const foreground = await groupAgentRunRepository?.loadForeground(
          scopeKey,
          accountId,
        );
        if (foreground) groupAgentRunWorker?.interrupt(foreground.runId);
        const cleanupCoordinator = groupAgentRunCleanup;
        if (!cleanupCoordinator) {
          throw new Error("Coordinator cleanup GroupAgentRun belum siap.");
        }
        const cleanup = await cleanupCoordinator.request(scopeKey, accountId);
        if (cleanup === "pending") {
          logger.warn(
            "whatsapp_group_disable_cleanup_pending",
            "Grup sudah diblokir dari ingress; intent cleanup durable akan dicoba lagi.",
            { accountId },
          );
        }
        logger.info(
          "whatsapp_group_disabled",
          "Grup WhatsApp dinonaktifkan dan state runtime dibatalkan.",
          { accountId },
        );
        if (codingFenceFailure) throw codingFenceFailure;
      },
      onGroupAuthorityChanged: (scopeKey, accountId) => {
        groupBatcher?.invalidateScope(scopeKey, accountId);
        groupTurns?.invalidateAuthority(scopeKey, accountId);
        void codingRuntime?.fenceGroupCoding({
          scopeKey,
          accountId,
          cause: "group_authority_changed",
        }).catch((error: unknown) => {
          logger.error(
            "whatsapp_group_coding_authority_fence_failed",
            "Authority grup berubah; group-coding diblokir tetapi recovery fence belum selesai.",
            error,
            { accountId },
          );
        });
        void groupAgentRunRepository?.loadForeground(scopeKey, accountId)
          .then((run) => {
            if (run) groupAgentRunWorker?.interrupt(run.runId);
          });
      },
      onStatus: (accountId, status, reason) => {
        notifySupervisorChannelStatus("whatsapp", accountId, status, reason);
        if (status !== "open") return;
        notifySupervisorChannelReady("whatsapp", accountId);
        void whatsappPrivate?.resumeAgentRuns(accountId).catch(
          (error: unknown) => {
            logger.error(
              "whatsapp_private_active_run_recovery_failed",
              "Pemulihan active AgentRun WhatsApp gagal setelah akun tersambung.",
              error,
              { accountId },
            );
          },
        );
      },
      onPrivateLifecycle: (accountId, stage) => {
        notifySupervisorAcceptanceTrace(accountId, stage);
      },
      onPairingCode: (accountId, code) => {
        if (
          !operatorSecretChannelAvailable(
            config.operationalLog.environment,
            process.stdout.isTTY === true,
          )
        ) {
          logger.error(
            "whatsapp_pairing_terminal_unavailable",
            "Kode pairing tidak ditampilkan karena jalur operator aman tidak tersedia.",
            new Error("Jalur operator pairing tidak tersedia."),
            { accountId },
          );
          return;
        }
        const readable = code.match(/.{1,4}/g)?.join("-") ?? code;
        const shown = presentOperatorSecret(
          `[WhatsApp ${accountId}] Kode pairing sekali pakai: ${readable}. Jangan bagikan kode ini.`,
          operatorSecretChannel(config.operationalLog.environment),
        );
        if (shown) {
          logger.info(
            "whatsapp_pairing_code_presented",
            "Kode pairing sekali pakai ditampilkan hanya ke terminal operator.",
            { accountId },
          );
        }
      },
      onQr: (accountId, qr) => {
        if (
          !operatorSecretChannelAvailable(
            config.operationalLog.environment,
            process.stdout.isTTY === true,
          )
        ) {
          logger.error(
            "whatsapp_qr_terminal_unavailable",
            "QR pairing tidak ditampilkan karena jalur operator aman tidak tersedia.",
            new Error("Jalur operator pairing tidak tersedia."),
            { accountId },
          );
          return;
        }
        const headingShown = presentOperatorSecret(
          `[WhatsApp ${accountId}] Pindai QR berikut lewat Perangkat tertaut. QR adalah kredensial sekali pakai; jangan bagikan.`,
          operatorSecretChannel(config.operationalLog.environment),
        );
        try {
          qrCodeTerminal.generate(qr, { small: true }, (rendered) => {
            const qrShown = presentOperatorSecret(
              rendered,
              operatorSecretChannel(config.operationalLog.environment),
            );
            if (headingShown && qrShown) {
              logger.info(
                "whatsapp_qr_presented",
                "QR pairing sekali pakai ditampilkan hanya ke terminal operator.",
                { accountId },
              );
            }
          });
        } catch {
          logger.error(
            "whatsapp_qr_render_failed",
            "QR pairing gagal dirender ke terminal operator.",
            new Error("Renderer QR gagal."),
            { accountId },
          );
        }
      },
    }, {
      logger: logger.child("whatsapp.account-manager"),
    })
  : null;
const groupAgentRunRepository = whatsapp
  ? new FileGroupAgentRunRepository(config.groupAgentRunFile)
  : null;
const groupAgentRuns = whatsapp && groupAgentRunRepository
  ? new GroupAgentRunService(
      groupAgentRunRepository,
      whatsapp,
      undefined,
      undefined,
      groupAgentRunRuntimeAdmission,
    )
  : null;
const groupAgentRunUsageReconciler = groupAgentRunRepository
  ? new GroupAgentRunUsageReconciler({
      pendingDeliveryScopes: () => usageLedger.pendingDeliveryScopes(),
      loadRun: (runId) => groupAgentRunRepository.load(runId),
      settleDeliveryScope: (scope, settlement) =>
        usageLedger.settleDeliveryScope(scope, settlement),
    }, { maxScopes: 10_000 })
  : null;
let groupAgentRunCleanupWorker: ReturnType<
  typeof startGroupAgentRunCleanupWorker
> | null = null;
let groupAgentRunRetention: ReturnType<
  typeof startGroupAgentRunRetentionWorker
> | null = null;
let groupAgentRunActivationRetryTimer: NodeJS.Timeout | null = null;
let groupAgentRunResumeTimer: NodeJS.Timeout | null = null;
let groupPurgeTimer: NodeJS.Timeout | null = null;

if (whatsapp && groupMemories) {
  if (codingRuntime) {
    const groupCodingRepository = codingRuntime.groupRepository;
    const groupWorkspaceLinks = new GroupWorkspaceLinkService(
      groupCodingRepository,
      groupMemories,
      whatsapp,
      codingRuntime.authority,
    );
    groupCodingDeliveries = new GroupCodingDeliveryService(
      groupCodingRepository,
      whatsapp,
      groupAgentRunRuntimeAdmission,
      groupMemories,
    );
    const groupCodingController = new GroupWorkspaceCodingController(
      codingRuntime.groupActors,
      groupWorkspaceLinks,
      groupCodingRepository,
      codingRuntime.groupRuns,
      () => new Date(),
      randomUUID,
      codingRuntime.projects,
    );
    groupCodingIngress = new GroupCodingIngressRouter(
      groupCodingController,
      groupCodingDeliveries,
      (message) => codingRuntime.issueGroupActor(message),
      groupAgentRunRuntimeAdmission,
      codingRuntime.progress,
    );
  }
  const groupUsageControl = {
    allow: (ownerId: string) => telemetry.allow(ownerId),
    forget: (ownerId: string) => telemetry.forget(ownerId),
    forgetActor: (ownerId: string, actorAliases: readonly string[]) =>
      telemetry.forgetActor(ownerId, actorAliases),
    markDelivered: (ownerId: string) =>
      telemetry.markDelivered(ownerId, currentUsageAttribution()?.turnId ?? null),
    discardUndelivered: (ownerId: string) =>
      telemetry.discardUndelivered(
        ownerId,
        currentUsageAttribution()?.turnId ?? null,
      ),
  };
  const groupSafety = {
    triageRisk: (
      message: string,
      ownerId?: string,
      context?: HarvyContext,
      signal?: AbortSignal,
    ) => conversation.triageRisk(
      message,
      ownerId,
      context,
      signal,
    ),
    reviewReply: (
      message: string,
      reply: string,
      triage?: Parameters<typeof conversation.reviewReply>[2],
      ownerId?: string,
      context?: HarvyContext,
    ) => conversation.reviewReply(message, reply, triage, ownerId, context),
  };
  groupTurns = new GroupTurnService(
    groupMemories,
    new GroupConversation(
      aiClient,
      config.ai,
      logger.child("ai.group-conversation"),
      agentHarness,
    ),
    groupSafety,
    whatsapp,
    GROUP_NOTICE_VERSION,
    () => new Date(),
    groupUsageControl,
    logger.child("core.group-turn"),
    config.operationalLog.retentionDays,
    config.defaultTimezone,
    conversation,
    whatsapp,
    conversation,
    (message) => resolveManagedGroupRuntimeAdmission(controlPlane, message),
  );
  if (
    config.groupAgentRunEnabled && groupAgentRuns &&
    groupAgentRunRepository
  ) {
    const workProcessor = createGroupAgentRunWorkProcessor({
      ports: createGroupAgentRunRuntimePorts({
        repository: groupAgentRunRepository,
        service: groupAgentRuns,
        transport: whatsapp,
        watermark: groupTurns,
        runtimeAdmission: groupAgentRunRuntimeAdmission,
      }),
      executor: new GroupAgentRunExecutor(aiClient, config.ai),
      usage: usageLedger,
    });
    groupAgentRunWorker = startGroupAgentRunWorker(workProcessor, {
      logger: logger.child("worker.group-agent-run"),
    });
    groupAgentRunIngress = new GroupAgentRunIngressRouter(
      groupAgentRuns,
      whatsapp,
      groupAgentRunRuntimeAdmission,
      logger.child("core.group-agent-run-ingress"),
      groupAgentRunWorker,
    );
  }
  groupBatcher = new GroupMessageBatcher(
    async (message) => {
      const outcome = groupTurns
        ? await runManagedGroupTurn(controlPlane, groupTurns, message)
        : undefined;
      logger.info(
        "whatsapp_group_turn_outcome",
        "Pipeline giliran grup menghasilkan keputusan.",
        {
          accountId: message.accountId,
          outcome: outcome ?? "unavailable",
        },
      );
    },
    undefined,
    undefined,
    undefined,
    undefined,
    logger.child("whatsapp.group-batcher"),
    undefined,
    async (message) => {
      const observed = await (groupTurns?.observeAuthorized(message) ?? message);
      if (
        observed && await groupAgentRunCleanup?.isPending(
          groupScopeKey(observed.scope),
          observed.accountId,
        )
      ) {
        groupTurns?.settleRejectedObservation(observed);
        return null;
      }
      if (
        observed && groupCodingIngress &&
        await groupCodingIngress.handleObserved(observed) === "consumed"
      ) {
        groupTurns?.settleRejectedObservation(observed);
        return null;
      }
      if (
        observed && groupAgentRunIngress &&
        await groupAgentRunIngress.handleObserved(observed) === "consumed"
      ) {
        groupTurns?.settleRejectedObservation(observed);
        return null;
      }
      return observed;
    },
    undefined,
    async (message) => {
      if (groupTurns) {
        await runManagedGroupUrgentPreflight(
          controlPlane,
          groupTurns,
          message,
        );
      }
    },
    (message, signals) =>
      withUsageAttribution(
        {
          turnId: `whatsapp-group-boundary:${message.accountId}:${message.messageId}`,
          subjectKind: "group",
          channel: "whatsapp",
          actorAliases: message.participantAliases,
        },
        () => conversation.assessTurnBoundary(
          message.text,
          groupScopeKey(message.scope),
          undefined,
          signals,
        ),
      ),
  );
  if (groupAgentRuns) {
    groupAgentRunCleanup = new GroupAgentRunCleanupService(
      new FileGroupAgentRunCleanupIntentRepository(
        config.groupAgentRunCleanupFile,
      ),
      {
        disableGroup: (scopeKey, accountId) =>
          groupTurns!.disableGroup(scopeKey, accountId),
        forgetScope: (scopeKey, accountId) =>
          groupAgentRuns.forgetScope(scopeKey, accountId),
      },
      logger.child("core.group-agent-run-cleanup"),
      undefined,
      groupAgentRunLifecycle,
    );
    groupAgentRunActivationRetry = startGroupAgentRunActivationRetry(
      {
        revalidateLiveMembership: async ({ scopeKey, accountId }) => {
          const binding = await groupMemories.binding(scopeKey);
          if (
            !binding || binding.accountId !== accountId ||
            binding.channel !== "whatsapp"
          ) return { status: "unavailable" };
          return whatsapp.captureLiveGroupMembership({
            scope: { channel: "whatsapp", groupId: binding.groupId },
            accountId,
          });
        },
        reconcileAndActivate: async ({ scopeKey, accountId }, lease) => {
          const cleanup = groupAgentRunCleanup!;
          const activation = await cleanup.activateWhenClean(
            scopeKey,
            accountId,
            async () => {
              const binding = await groupMemories.binding(scopeKey);
              if (
                !lease.isCurrent() || !binding ||
                binding.accountId !== accountId ||
                binding.channel !== "whatsapp"
              ) return "stale" as const;
              return groupTurns!.activateGroup({
                scope: { channel: "whatsapp", groupId: binding.groupId },
                accountId,
                groupName: binding.groupName,
                at: new Date().toISOString(),
              }, lease.isCurrent);
            },
          );
          if (activation.status === "pending") return "pending";
          if (activation.value === "active") return "activated";
          if (activation.value === "inactive") {
            throw new Error("Lease reaktivasi GroupAgentRun tidak lagi aktif.");
          }
          if (activation.value === "notice-failed") {
            // `pending` hanya untuk cleanup durable yang memang masih dapat
            // direkonsiliasi. Kegagalan notice harus menghabiskan failure
            // budget worker agar error transport permanen tidak menjadi loop.
            throw new Error("Reaktivasi GroupAgentRun gagal mengirim notice.");
          }
          throw new Error("Reaktivasi GroupAgentRun ditolak oleh binding.");
        },
      },
      { logger: logger.child("worker.group-agent-run-activation-retry") },
    );
    groupAgentRunActivationRetryTimer = setInterval(() => {
      void groupAgentRunActivationRetry?.runNow();
    }, 60_000);
    groupAgentRunActivationRetryTimer.unref();
  }
}

const SHUTDOWN_GRACE_MS = 60_000;
const GROUP_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;
const GROUP_RUN_RESUME_INTERVAL_MS = 60_000;

const scheduledPrivateDelivery = {
  sendReminder: async (candidate: Parameters<typeof bot.sendReminder>[0]) => {
    const target = parseWhatsAppPrivateChatId(candidate.chatId);
    if (!target) return bot.sendReminder(candidate);
    if (!whatsappPrivate || !whatsapp) {
      throw new Error("Runtime WhatsApp privat untuk reminder tidak tersedia.");
    }
    return whatsappPrivate.sendScheduledReminder(
      candidate,
      (accountId, userId, text) =>
        whatsapp!.sendPrivateText(accountId, userId, text),
    );
  },
  sendCheckIn: async (candidate: Parameters<typeof bot.sendCheckIn>[0]) => {
    const target = parseWhatsAppPrivateChatId(candidate.chatId);
    if (!target) return bot.sendCheckIn(candidate);
    if (!whatsappPrivate || !whatsapp) {
      throw new Error("Runtime WhatsApp privat untuk check-in tidak tersedia.");
    }
    return whatsappPrivate.sendScheduledCheckIn(
      candidate,
      (accountId, userId, text) =>
        whatsapp!.sendPrivateText(accountId, userId, text),
    );
  },
};

const reminders = startReminderWorker(
  scheduledPrivateDelivery,
  tasks,
  profiles,
  config,
  logger.child("worker.reminder"),
);
const checkIns = startCheckInWorker(
  scheduledPrivateDelivery,
  sessions,
  profiles,
  telemetry,
  config,
  logger.child("worker.checkin"),
);
const agentRunRetention = startAgentRunRetentionWorker(
  agentRuns,
  logger.child("worker.agent-run-retention"),
);

const channelSetup = config.controlPlane.console.enabled
  ? new ChannelSetupService({
      primaryRuntimeActive: true,
      primaryTelegramRuntimeToken: config.telegramBotToken,
      primaryWhatsAppAuthRoot: config.whatsapp.authFolder,
      primaryWhatsAppRuntimeFingerprint: primaryWhatsAppRuntimeFingerprint(
        config.whatsapp,
      ),
      primaryChannels: {
        telegram: { declared: Boolean(config.telegramBotToken) },
        whatsapp: {
          configurationValid: true,
          enabled: config.whatsapp.enabled,
          privateEnabled: config.whatsapp.privateEnabled,
          accountCount: config.whatsapp.accounts.length,
          declared: config.whatsapp.enabled && config.whatsapp.accounts.length > 0,
        },
      },
    })
  : null;
const codingSetup = config.controlPlane.console.enabled
  ? new CodingRuntimeSetupService({ runtimeActive: true })
  : null;
const consoleServer = config.controlPlane.console.enabled
  ? new ConsoleServer(
      controlPlane,
      usageLedger,
      config.controlPlane.console,
      logger.child("console.server"),
      undefined,
      economy,
      channelSetup,
      codingSetup,
    )
  : null;

let shutdownPromise: Promise<void> | undefined;
const startupNetworkAbort = new AbortController();
// grammY 1.x mengekspos tipe AbortSignal dari polyfill lamanya, sedangkan
// runtime Node 22+ menyediakan signal web-standard yang kompatibel saat jalan.
const telegramStartupSignal = startupNetworkAbort.signal as unknown as
  NonNullable<Parameters<typeof bot.api.setMyCommands>[2]>;

const shutdown = (
  reason:
    | "SIGINT"
    | "SIGTERM"
    | "dev-restart"
    | "dev-stop"
    | "polling-ended"
    | "runtime-failed",
): void => {
  if (shutdownPromise) {
    logger.warn(
      "shutdown_already_in_progress",
      "Permintaan shutdown diterima saat shutdown sudah berjalan.",
      { reason },
    );
    return;
  }
  startupNetworkAbort.abort();
  shutdownPromise ??= (async () => {
    const startedAt = Date.now();
    logger.info(
      "shutdown_requested",
      "Shutdown Harvy dimulai.",
      { reason, graceMs: SHUTDOWN_GRACE_MS },
    );
    const forcedExit = setTimeout(() => {
      logSystem.fatalSync(
        "shutdown_forced",
        "Harvy melewati batas shutdown 60 detik; proses dihentikan paksa.",
        new Error("Batas shutdown terlampaui."),
        { reason, graceMs: SHUTDOWN_GRACE_MS },
      );
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forcedExit.unref();

    try {
      consoleServer?.stopMutations();
      await consoleServer?.drainMutations();
      await shutdownGracefully(
        {
          stop: async () => {
            if (groupPurgeTimer) {
              clearInterval(groupPurgeTimer);
              groupPurgeTimer = null;
            }
            if (groupAgentRunActivationRetryTimer) {
              clearInterval(groupAgentRunActivationRetryTimer);
              groupAgentRunActivationRetryTimer = null;
            }
            if (groupAgentRunResumeTimer) {
              clearInterval(groupAgentRunResumeTimer);
              groupAgentRunResumeTimer = null;
            }
            // Tutup ingress WA lebih dulu, lalu tunggu event yang sudah diterima
            // masuk ke batch dan selesai selagi socket masih hidup. Setelah
            // batch berhenti menambah kerja, batalkan/drain planner serta
            // pending candidate; socket baru ditutup paling akhir.
            await Promise.all([
              bot.isRunning() ? bot.stop() : Promise.resolve(),
              (async () => {
                codingRuntime?.supervisor.stop();
                whatsapp?.stopIngress();
                await whatsapp?.drainEvents();
                whatsappPrivate?.stopIngress();
                await whatsappPrivate?.drain();
                groupCodingIngress?.stopIngress();
                groupAgentRunIngress?.stopIngress();
                groupAgentRunWorker?.stop();
                await groupBatcher?.stopIngress();
                groupTurns?.stopIngress();
                await groupAgentRunIngress?.drain();
                await groupCodingIngress?.drain();
                await groupAgentRunWorker?.drain();
                await groupTurns?.drain();
                await whatsapp?.close();
              })(),
            ]);
          },
          drainPending: async () => {
            await codingRuntime?.supervisor.drain();
            await groupBatcher?.drainAll();
            await groupTurns?.drain();
            // `bot.drainPending()` menguras telemetry. Ia harus terakhir karena
            // giliran WhatsApp juga memakai observer yang sama.
            await bot.drainPending();
          },
        },
        reminders,
        checkIns,
        agentRunRetention,
        ...(groupAgentRunCleanupWorker ? [groupAgentRunCleanupWorker] : []),
        ...(groupAgentRunRetention ? [groupAgentRunRetention] : []),
        ...(groupAgentRunActivationRetry
          ? [groupAgentRunActivationRetry]
          : []),
      );
      longTermMemory.stop();
      await longTermMemory.drain();
      longTermMemory.close();
      await consoleServer?.close();
      logger.info(
        "shutdown_completed",
        "Harvy berhenti dengan bersih.",
        { reason, durationMs: Date.now() - startedAt },
      );
      await logSystem.flush();
    } finally {
      clearTimeout(forcedExit);
    }
  })();
  void shutdownPromise.catch((error: unknown) => {
    logger.error(
      "shutdown_failed",
      "Harvy gagal berhenti dengan bersih.",
      error,
      { reason },
    );
    process.exitCode = 1;
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
removeDevShutdownControl = installDevShutdownControl((reason) => {
  // Ctrl+C sampai ke parent runner dan aplikasi pada terminal Windows. Abaikan
  // pesan IPC pendamping bila shutdown dari signal sudah lebih dulu dimulai.
  if (!shutdownPromise) shutdown(reason);
});

try {
  if (consoleServer) {
    const consoleStart = await consoleServer.start();
    if (consoleStart.generatedOperatorToken) {
      const channel = operatorSecretChannel(config.operationalLog.environment);
      if (
        !operatorSecretChannelAvailable(
          channel.environment,
          channel.interactive,
        ) ||
        !presentOperatorSecret(
          [
            `Harvy Console: ${consoleStart.origin}`,
            `Token operator sekali tampil: ${consoleStart.generatedOperatorToken}`,
          ].join("\n"),
          channel,
        )
      ) {
        await consoleServer.close();
        throw Object.assign(
          new Error("Token operator Console tidak dapat ditampilkan dengan aman."),
          { code: "CONSOLE_OPERATOR_CHANNEL_UNAVAILABLE" },
        );
      }
    }
  }
  if (shutdownPromise) {
    await shutdownPromise;
    return;
  }
  if (groupCodingDeliveries) {
    const deliveryRecovery = await groupCodingDeliveries.recoverPrepared();
    logger.info(
      "group_coding_delivery_recovery_completed",
      "Delivery group-coding prepared ditutup secara konservatif sebelum ingress.",
      { ...deliveryRecovery },
    );
  }
  if (codingRuntime) {
    const codingStartup = await codingRuntime.supervisor.start();
    logger.info(
      "coding_runtime_started",
      "Coding runtime production melewati recovery dan admission gate.",
      {
        state: codingStartup.state,
        codingAdmission: codingStartup.codingAdmission,
        sandboxRuntime: codingStartup.sandbox.runtime,
        githubUnresolved: codingStartup.githubInitialPass.unresolved,
        deletionBlocked: codingStartup.projectDeletionInitialPass.blocked,
      },
    );
  }
  if (groupCodingIngress) {
    const anchorRecovery = await groupCodingIngress.recoverAnchors();
    logger.info(
      "group_coding_anchor_recovery_completed",
      "Anchor Group CodingRun current dipasang kembali setelah recovery runtime.",
      { ...anchorRecovery },
    );
  }
  if (shutdownPromise) {
    await shutdownPromise;
    return;
  }
  // Aktivitas jaringan pertama baru boleh berjalan setelah control IPC aktif.
  // Sedikit perintah saja; cara utama memakai Harvy adalah menulis biasa.
  try {
    await bot.api.setMyCommands(telegramCommands({
      codingRuntime: codingRuntime !== null,
      githubPublishing: Boolean(codingRuntime?.privateGitHub),
    }), undefined, telegramStartupSignal);
  } catch (error) {
    // Abort/failure yang tiba setelah shutdown dimulai bukan kegagalan runtime.
    if (!shutdownPromise) throw error;
  }
  if (shutdownPromise) {
    await shutdownPromise;
    return;
  }
  if (whatsapp && groupAgentRuns && groupAgentRunCleanup) {
    logger.warn(
      "whatsapp_local_auth_enabled",
      "WhatsApp aktif dengan auth berkas lokal Baileys. Ini fondasi beta satu proses, bukan penyimpanan kredensial produksi.",
    );
    // Intent penghapusan didahulukan agar recovery delivery tidak menghidupkan
    // pekerjaan dari binding yang sudah dinonaktifkan sebelum proses mati.
    groupAgentRunCleanupWorker = startGroupAgentRunCleanupWorker(
      groupAgentRunCleanup,
      logger.child("worker.group-agent-run-cleanup"),
    );
    const cleanupRecovery = await groupAgentRunCleanupWorker.ready();
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
    if (cleanupRecovery.pending > 0) {
      throw new Error(
        "Cleanup GroupAgentRun tertunda belum tuntas; WhatsApp tidak dimulai.",
      );
    }
    // Readiness harus gagal tertutup: worker periodik menyerap error agar tetap
    // hidup, jadi recovery/purge startup dijalankan langsung sebelum ingress.
    await groupAgentRuns.recoverInterruptedRuns();
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
    const usageRecovery = await groupAgentRunUsageReconciler?.reconcilePending();
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
    if (usageRecovery && (usageRecovery.failed > 0 || usageRecovery.deferred > 0)) {
      throw new Error(
        "Reconciliation usage GroupAgentRun belum tuntas; WhatsApp tidak dimulai.",
      );
    }
    if (usageRecovery) {
      logger.info(
        "group_agent_run_usage_recovery_completed",
        "Kandidat usage GroupAgentRun direkonsiliasi sebelum purge dan ingress.",
        { ...usageRecovery },
      );
    }
    await groupAgentRuns.purgeExpired();
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
    groupAgentRunRetention = startGroupAgentRunRetentionWorker(
      groupAgentRuns,
      logger.child("worker.group-agent-run-retention"),
    );
    await groupMemories?.purgeExpired();
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
    if (groupMemories) {
      groupPurgeTimer = setInterval(() => {
        void groupMemories.purgeExpired().catch((error: unknown) => {
          logger.error(
            "whatsapp_group_retention_failed",
            "Pembersihan retensi grup gagal.",
            error,
          );
        });
      }, GROUP_RETENTION_INTERVAL_MS);
      groupPurgeTimer.unref();
    }
    await whatsapp.start();
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
    if (groupAgentRunWorker) {
      await groupAgentRunWorker.resume();
      if (!shutdownPromise) {
        groupAgentRunResumeTimer = setInterval(() => {
          void groupAgentRunWorker?.resume().catch((error: unknown) => {
            logger.error(
              "group_agent_run_resume_failed",
              "Scan berkala work lane GroupAgentRun gagal tertutup.",
              error,
            );
          });
        }, GROUP_RUN_RESUME_INTERVAL_MS);
        groupAgentRunResumeTimer.unref();
      }
    }
  }

  // IPC dev-restart dapat tiba ketika Console/WhatsApp masih startup. Jangan
  // melanjutkan ke polling/ready setelah shutdown sudah dimulai; outer finally
  // baru melepas runtime lock sesudah seluruh drain selesai.
  if (shutdownPromise) {
    await shutdownPromise;
    return;
  }

  logger.info(
    "application_starting",
    "Harvy menyiapkan polling Telegram.",
    {
      whatsappEnabled: config.whatsapp.enabled,
      whatsappAccountCount: config.whatsapp.accounts.length,
      groupAgentRunEnabled: config.groupAgentRunEnabled,
      aiMode: config.ai.mode,
      consoleEnabled: config.controlPlane.console.enabled,
    },
  );
  // Tombol inline adalah satu-satunya cara pengguna menindaklanjuti tugas, jadi
  // `callback_query` wajib ikut diminta. Tanpa itu Telegram tidak pernah
  // mengirimkannya dan semua tombol mati.
  await bot.start({
    allowed_updates: ["message", "callback_query"],
    onStart: () => {
      // Shutdown dapat tiba setelah guard startup terakhir, tetapi sebelum
      // grammY menandai polling sebagai running. Begitu onStart dipanggil,
      // tutup polling yang baru hidup agar shutdown tidak menunggu proses yang
      // tidak pernah ikut dihentikan dan runtime lock tetap dapat dilepas.
      if (shutdownPromise) {
        if (bot.isRunning()) bot.stop();
        return;
      }
      consoleServer?.markReady();
      void bot.resumeAgentRuns().catch((error: unknown) => {
        logger.error(
          "active_agent_run_recovery_failed",
          "Pemulihan active AgentRun setelah restart gagal.",
          error,
        );
      });
      logger.info(
        "application_ready",
        "Harvy mulai berjalan dan polling Telegram aktif.",
        {
          whatsappEnabled: config.whatsapp.enabled,
          whatsappAccountCount: config.whatsapp.accounts.length,
          aiMode: config.ai.mode,
          consoleEnabled: config.controlPlane.console.enabled,
        },
      );
    },
  });

  if (!shutdownPromise) shutdown("polling-ended");
} catch (error) {
  logger.error(
    "runtime_failed",
    "Startup kanal atau polling utama gagal.",
    error,
  );
  if (!shutdownPromise) shutdown("runtime-failed");
  try {
    await shutdownPromise;
  } catch {
    // `shutdown_failed` sudah dicatat oleh supervisor shutdown.
  }
  throw error;
}

// `bot.stop()` membuat start selesai sebelum antrean MessageBatcher habis.
// Tahan proses untuk batch, action, dan evaluator utama; ACK callback,
// pembersihan kosmetik, serta pemadatan riwayat mempunyai lifecycle sendiri.
if (shutdownPromise) {
  await shutdownPromise;
}
} catch (error) {
  logger.fatal(
    "application_fatal",
    "Harvy berhenti karena kegagalan fatal.",
    error,
  );
  process.exitCode = 1;
  try {
    await logSystem.flush();
  } catch {
    // Sink sudah melaporkan kegagalannya sendiri ke stderr yang telah disaring.
  }
} finally {
  removeDevShutdownControl();
  try {
    await runtimeLock?.release();
  } catch {
    process.exitCode = 1;
  }
  removeProcessDiagnostics();
  try {
    await logSystem.close();
  } catch {
    process.exitCode = 1;
  }
}
}

await main().catch((error: unknown) => {
  // Kegagalan sebelum logger berhasil dibuat tidak boleh mencetak object
  // konfigurasi atau kredensial mentah.
  const code = safeErrorCode(error);
  process.stderr.write(
    `${new Date().toISOString()} FATAL app bootstrap_failed: ` +
      "Harvy gagal menyiapkan pencatatan operasional." +
      `${code ? ` code=${code}` : ""}\n`,
  );
  process.exitCode = 1;
});

function modelPriceBootstraps(config: AiConfig): PriceBootstrap[] {
  const tiers = ["cheap", "efficient", "ambitious"] as const;
  const bootstraps = tiers.map((tier) => ({
    providerId: config.providerId,
    modelId:
      config.mode === "testing"
        ? config.testingModels[tier] ?? config.testingModel
        : config.models[tier],
    inputPerMillionUsd: String(config.prices[tier].inputPerMillionUsd),
    outputPerMillionUsd: String(config.prices[tier].outputPerMillionUsd),
  }));
  for (const binding of Object.values(config.roleBindings ?? {})) {
    if (!binding?.modelId) continue;
    bootstraps.push({
      providerId: config.providerId,
      modelId: binding.modelId,
      inputPerMillionUsd: String(
        config.prices[binding.tier].inputPerMillionUsd,
      ),
      outputPerMillionUsd: String(
        config.prices[binding.tier].outputPerMillionUsd,
      ),
    });
  }
  return bootstraps;
}

function runtimeEnvironment(
  value: string,
): "development" | "staging" | "production" {
  if (value === "production" || value === "staging") return value;
  return "development";
}

type DevShutdownReason = "dev-restart" | "dev-stop";

function notifySupervisorChannelReady(
  channel: "whatsapp",
  accountId: string,
): void {
  if (
    process.env.HARVY_RUNTIME_SUPERVISOR !== "1" ||
    typeof process.send !== "function"
  ) {
    return;
  }
  try {
    process.send({
      type: "harvy-runtime-channel-ready",
      channel,
      accountId,
    });
  } catch {
    // Parent sudah berhenti; lifecycle child tetap ditangani signal dan exit.
  }
}

function notifySupervisorChannelStatus(
  channel: "whatsapp",
  accountId: string,
  status: WhatsAppAccountStatus,
  reason?: number,
): void {
  if (
    process.env.HARVY_RUNTIME_SUPERVISOR !== "1" ||
    typeof process.send !== "function"
  ) {
    return;
  }
  try {
    process.send({
      type: "harvy-runtime-channel-status",
      channel,
      accountId,
      status,
      reason: Number.isSafeInteger(reason) ? reason : null,
    });
  } catch {
    // Parent sudah berhenti; lifecycle child tetap ditangani signal dan exit.
  }
}

function notifySupervisorAcceptanceTrace(
  accountId: string,
  stage: string,
): void {
  if (
    process.env.HARVY_LIVE_ACCEPTANCE_TRACE !== "content-free-v1" ||
    process.env.HARVY_RUNTIME_SUPERVISOR !== "1" ||
    typeof process.send !== "function"
  ) {
    return;
  }
  try {
    process.send({
      type: "harvy-live-acceptance-trace",
      channel: "whatsapp",
      accountId,
      stage,
    });
  } catch {
    // Trace diagnostik tidak pernah memengaruhi runtime atau delivery produk.
  }
}

function installDevShutdownControl(
  onShutdown: (reason: DevShutdownReason) => void,
): () => void {
  if (
    (process.env.HARVY_DEV_RUNNER !== "1" &&
      process.env.HARVY_RUNTIME_SUPERVISOR !== "1") ||
    typeof process.send !== "function"
  ) {
    return () => undefined;
  }

  const onMessage = (message: unknown): void => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "harvy-dev-shutdown" ||
      !("reason" in message) ||
      (message.reason !== "dev-restart" && message.reason !== "dev-stop")
    ) {
      return;
    }
    onShutdown(message.reason);
  };

  process.on("message", onMessage);
  process.channel?.unref();
  try {
    process.send({ type: "harvy-dev-control-ready" });
  } catch {
    // Parent sudah berhenti; signal OS dan exit cleanup tetap menjadi pagar.
  }

  return () => {
    process.off("message", onMessage);
    if (process.connected) {
      try {
        process.disconnect();
      } catch {
        // Channel parent sudah tutup; proses tetap boleh menyelesaikan cleanup.
      }
    }
  };
}

async function runManagedGroupTurn(
  controlPlane: ControlPlaneService,
  turns: GroupTurnService,
  message: GroupMessage,
): Promise<GroupTurnOutcome> {
  // Jalur normal sudah diobservasi batcher. Jalur singkat saat startup belum;
  // lakukan di sini agar panggilan vocative "Harvy, ..." tetap dianggap
  // direct sebelum paket direct-only memutuskan untuk diam.
  if (message.ingressRevision === undefined) {
    const observed = await turns.observeAuthorized(message);
    if (!observed) return "inactive";
    message = observed;
  }
  const admission = await resolveManagedGroupRuntimeAdmission(
    controlPlane,
    message,
  );
  if (admission !== "process") {
    turns.settleRejectedObservation(message);
    return admission;
  }
  return withUsageAttribution(
    {
      turnId: randomUUID(),
      subjectKind: "group",
      channel: message.scope.channel,
      actorAliases: [message.participantId, ...message.participantAliases],
    },
    () => turns.handle(message),
  );
}

async function runManagedGroupUrgentPreflight(
  controlPlane: ControlPlaneService,
  turns: GroupTurnService,
  message: GroupMessage,
): Promise<void> {
  if (
    (await resolveManagedGroupRuntimeAdmission(controlPlane, message)) !==
    "process"
  ) {
    return;
  }
  await turns.preflightUrgent(message);
}

async function resolveManagedGroupRuntimeAdmission(
  controlPlane: ControlPlaneService,
  message: GroupMessage,
) {
  const ownerId = groupScopeKey(message.scope);
  const enrollment = await controlPlane.enrollmentForOwner(ownerId);
  const mode = enrollment.groupRuntimeMode ?? "direct_only";
  return groupRuntimeAdmission(mode, message);
}

function operatorSecretChannel(environment: string) {
  return {
    environment,
    interactive: process.stdout.isTTY === true,
    stream: process.stdout,
  };
}

function safeErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(code)
    ? code
    : null;
}
