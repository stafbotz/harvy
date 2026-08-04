import { randomUUID } from "node:crypto";
import { AiClient } from "./ai/client.js";
import { Conversation } from "./ai/conversation.js";
import { GroupConversation } from "./ai/group-conversation.js";
import { createModelAgentWorker } from "./ai/agent.js";
import {
  currentUsageAttribution,
  withUsageAttribution,
} from "./ai/usage-attribution.js";
import { createBot } from "./bot/create-bot.js";
import {
  aiClientOptions,
  loadConfig,
  loadOperationalLogConfig,
  type AiConfig,
} from "./config.js";
import { HistoryService } from "./core/history-service.js";
import { DataControlService } from "./core/data-control-service.js";
import { GroupMemoryService } from "./core/group-memory-service.js";
import {
  GROUP_NOTICE_VERSION,
  GroupTurnService,
} from "./core/group-turn-service.js";
import { InsightService } from "./core/insight-service.js";
import { MemoryService } from "./core/memory-service.js";
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
import { ConsoleServer } from "./console/console-server.js";
import { startCheckInWorker } from "./reminders/checkin-worker.js";
import { startReminderWorker } from "./reminders/reminder-worker.js";
import { FileHistoryRepository } from "./storage/file-history-repository.js";
import { FileGroupRepository } from "./storage/file-group-repository.js";
import { FileProfileRepository } from "./storage/file-profile-repository.js";
import { FileSessionRepository } from "./storage/file-session-repository.js";
import { FileTelemetryRepository } from "./storage/file-telemetry-repository.js";
import { FileControlPlaneRepository } from "./storage/file-control-plane-repository.js";
import { FileUsageLedgerRepository } from "./storage/file-usage-ledger-repository.js";
import { FileEntitlementLedgerRepository } from "./storage/file-entitlement-ledger-repository.js";
import { MarkdownInsightRepository } from "./storage/markdown-insight-repository.js";
import { MarkdownMemoryRepository } from "./storage/markdown-memory-repository.js";
import { FileTaskRepository } from "./storage/file-task-repository.js";
import { BaileysAccountManager } from "./whatsapp/baileys-account-manager.js";
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
import { BraveWebSearchProvider } from "./research/web-search.js";
import { SafeWebReader } from "./research/safe-web-reader.js";
import {
  WebOpenExecutor,
  WebSearchExecutor,
} from "./research/web-executors.js";
import { createInternalAgentExecutors } from "./agent/internal-executors.js";
import { VirtualTerminalExecutor } from "./agent/virtual-terminal.js";
import { ParallelDelegationExecutor } from "./agent/parallel-delegation.js";

async function main(): Promise<void> {
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
const usageLedger = new UsageLedgerService(
  new FileUsageLedgerRepository(config.controlPlane.usageLedgerFile),
  controlPlane,
  {
    retentionDays: config.controlPlane.usageLedgerRetentionDays,
    entitlementRepository: new FileEntitlementLedgerRepository(
      config.controlPlane.entitlementLedgerFile,
    ),
  },
);
const telemetry = new TelemetryService(
  new FileTelemetryRepository(config.telemetryFile),
  {
    rollingTokenLimit: config.ai.rollingTokenLimit,
    retentionDays: config.telemetryRetentionDays,
    prices: config.ai.prices,
    limitForOwner: (ownerId) => controlPlane.effectiveLimit(ownerId),
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
});
// Authority internal perlu tersedia sebelum registry agent dibentuk. Scope
// executor tetap mengambil owner dari AgentExecutionContext, bukan dari model.
const profiles = new ProfileService(
  new FileProfileRepository(config.profileFile),
);
const sessionRepository = new FileSessionRepository(config.sessionFile);
const sessions = new SessionService(sessionRepository, sessionRepository);
const webExecutors = [
  ...(config.web.searchApiKey
    ? [new WebSearchExecutor(new BraveWebSearchProvider(
        config.web.searchApiKey,
        { timeoutMs: config.web.searchTimeoutMs },
      ))]
    : []),
  ...(config.web.openEnabled
    ? [new WebOpenExecutor(new SafeWebReader({
        timeoutMs: config.web.openTimeoutMs,
      }))]
    : []),
];
const internalExecutors = createInternalAgentExecutors({
  tasks,
  profiles,
  sessions,
  defaultTimeZone: config.defaultTimezone,
});
const agentExecutors = [
  ...webExecutors,
  ...internalExecutors,
  new VirtualTerminalExecutor(),
  new ParallelDelegationExecutor(createModelAgentWorker(aiClient, config.ai)),
];
// Satu registry tepercaya dipakai semua kanal. Capability hanya tersedia bila
// executor dan dependency yang cocok benar-benar dipasang.
const agentHarness = new AgentHarness(createHarvyCapabilityCatalog({
  webSearchInstalled: config.web.searchApiKey !== null,
  webOpenInstalled: config.web.openEnabled,
  internalToolsInstalled: true,
  virtualTerminalInstalled: true,
  parallelDelegationInstalled: true,
}));
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
const memories = new MemoryService(
  new MarkdownMemoryRepository(config.memoryFolder, config.memoryFile),
);

// Peringkasnya memanggil model, tetapi `HistoryService` sendiri tidak tahu
// apa-apa soal itu — ia hanya memegang fungsi. Itu yang membuat aturan
// pemadatan dapat diuji tanpa kunci API.
const history = new HistoryService(
  new FileHistoryRepository(config.historyFile),
  (turns, ownerId) => conversation.summarizeEpisode(turns, ownerId),
  undefined,
  logger.child("core.history"),
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
);

// Penghapusan lintas beberapa berkas dilanjutkan sebelum bot menerima update.
// Profil tombstone-nya dihapus paling akhir oleh DataControlService.
await telemetry.purgeExpired();
await dataControls.resumePendingDeletions();
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
);

let groupTurns: GroupTurnService | null = null;
let groupBatcher: GroupMessageBatcher | null = null;
const groupMemories = config.whatsapp.enabled
  ? new GroupMemoryService(
      new FileGroupRepository(config.whatsapp.groupFile),
    )
  : null;
const whatsapp = config.whatsapp.enabled
  ? new BaileysAccountManager(config.whatsapp, {
      onMessage: async (message) => {
        if (groupBatcher) await groupBatcher.enqueue(message);
        else if (groupTurns) {
          await runManagedGroupTurn(controlPlane, groupTurns, message);
        }
      },
      onGroupActive: async (message) => {
        const outcome = await groupTurns?.activateGroup(message);
        if (outcome === "binding-conflict") {
          logger.error(
            "whatsapp_group_binding_conflict",
            "Grup sudah terikat ke akun Harvy lain; akun ini tidak akan menjawab.",
            new Error("Binding akun WhatsApp bertentangan."),
            { accountId: message.accountId },
          );
        } else if (outcome === "notice-failed") {
          logger.warn(
            "whatsapp_group_notice_pending",
            "Notice grup belum terkirim dan akan dicoba lagi sebelum pesan live diproses.",
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
        // Batasi ingress akun ini sebelum satu pun read binding. Generation
        // guard di core dipasang pada awal disableGroup; invalidasi batch di
        // sini memastikan bubble yang belum flush tidak menyusul kemudian.
        groupBatcher?.invalidateScope(scopeKey, accountId);
        await groupTurns?.disableGroup(scopeKey, accountId);
        logger.info(
          "whatsapp_group_disabled",
          "Grup WhatsApp dinonaktifkan dan state runtime dibatalkan.",
          { accountId },
        );
      },
      onGroupAuthorityChanged: (scopeKey, accountId) => {
        groupBatcher?.invalidateScope(scopeKey, accountId);
        groupTurns?.invalidateAuthority(scopeKey, accountId);
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
let groupPurgeTimer: NodeJS.Timeout | null = null;

if (whatsapp && groupMemories) {
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
  groupTurns = new GroupTurnService(
    groupMemories,
    new GroupConversation(
      aiClient,
      config.ai,
      logger.child("ai.group-conversation"),
      agentHarness,
    ),
    conversation,
    whatsapp,
    GROUP_NOTICE_VERSION,
    () => new Date(),
    groupUsageControl,
    logger.child("core.group-turn"),
    config.operationalLog.retentionDays,
    config.defaultTimezone,
    conversation,
    whatsapp,
  );
  groupBatcher = new GroupMessageBatcher(async (message) => {
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
  }, undefined, undefined, undefined, undefined, logger.child(
    "whatsapp.group-batcher",
  ), undefined, (message) => groupTurns?.observe(message) ?? message);
}

const SHUTDOWN_GRACE_MS = 60_000;
const GROUP_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

// Sedikit perintah saja. Cara utama memakai Harvy adalah menulis biasa.
await bot.api.setMyCommands([
  { command: "tugas", description: "Lihat yang harus dikerjakan" },
  { command: "bantuan", description: "Lihat cara pakai" },
]);

const reminders = startReminderWorker(
  bot,
  tasks,
  profiles,
  config,
  logger.child("worker.reminder"),
);
const checkIns = startCheckInWorker(
  bot,
  sessions,
  profiles,
  telemetry,
  config,
  logger.child("worker.checkin"),
);

const consoleServer = config.controlPlane.console.enabled
  ? new ConsoleServer(
      controlPlane,
      usageLedger,
      config.controlPlane.console,
      logger.child("console.server"),
    )
  : null;

let shutdownPromise: Promise<void> | undefined;

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
            // Tutup ingress WA lebih dulu, lalu tunggu event yang sudah diterima
            // masuk ke batch dan selesai selagi socket masih hidup. Setelah
            // batch berhenti menambah kerja, batalkan/drain planner serta
            // pending candidate; socket baru ditutup paling akhir.
            await Promise.all([
              bot.isRunning() ? bot.stop() : Promise.resolve(),
              (async () => {
                whatsapp?.stopIngress();
                await whatsapp?.drainEvents();
                await groupBatcher?.stopIngress();
                groupTurns?.stopIngress();
                await groupTurns?.drain();
                await whatsapp?.close();
              })(),
            ]);
          },
          drainPending: async () => {
            await groupBatcher?.drainAll();
            await groupTurns?.drain();
            // `bot.drainPending()` menguras telemetry. Ia harus terakhir karena
            // giliran WhatsApp juga memakai observer yang sama.
            await bot.drainPending();
          },
        },
        reminders,
        checkIns,
      );
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
  if (whatsapp) {
    logger.warn(
      "whatsapp_local_auth_enabled",
      "WhatsApp aktif dengan auth berkas lokal Baileys. Ini fondasi beta satu proses, bukan penyimpanan kredensial produksi.",
    );
    await groupMemories?.purgeExpired();
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
  }

  logger.info(
    "application_starting",
    "Harvy menyiapkan polling Telegram.",
    {
      whatsappEnabled: config.whatsapp.enabled,
      whatsappAccountCount: config.whatsapp.accounts.length,
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
      consoleServer?.markReady();
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
  return tiers.map((tier) => ({
    providerId: config.providerId,
    modelId:
      config.mode === "testing"
        ? config.testingModels[tier] ?? config.testingModel
        : config.models[tier],
    inputPerMillionUsd: String(config.prices[tier].inputPerMillionUsd),
    outputPerMillionUsd: String(config.prices[tier].outputPerMillionUsd),
  }));
}

function runtimeEnvironment(
  value: string,
): "development" | "staging" | "production" {
  if (value === "production" || value === "staging") return value;
  return "development";
}

type DevShutdownReason = "dev-restart" | "dev-stop";

function installDevShutdownControl(
  onShutdown: (reason: DevShutdownReason) => void,
): () => void {
  if (
    process.env.HARVY_DEV_RUNNER !== "1" ||
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
    message = turns.observe(message);
  }
  const ownerId = groupScopeKey(message.scope);
  const effective = await controlPlane.effectiveEnrollment(ownerId);
  const mode = effective.enrollment.groupRuntimeMode ?? "direct_only";
  if (mode === "disabled") return "inactive";
  if (mode === "paused") return "silent";
  if (
    mode === "direct_only" &&
    !message.mentionsHarvy &&
    !message.repliesToHarvy
  ) {
    return "silent";
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
