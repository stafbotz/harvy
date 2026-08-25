import { parse, resolve } from "node:path";
import type {
  AiClientOptions,
  AiFallbackOptions,
} from "./ai/client.js";
import { ApiKeyPool } from "./ai/key-pool.js";
import {
  COGNITIVE_MODEL_ROLES,
  type CognitiveModelBinding,
  type CognitiveModelRole,
  type ModelTier,
} from "./ai/model-policy.js";
import {
  ModelProfileRegistry,
  type ModelProfile,
} from "./ai/model-profile.js";
import { liveVerifiedModelProfiles } from
  "./ai/live-verified-model-profiles.js";
import type { TierPrice } from "./core/telemetry-service.js";
import { isValidTimeZone } from "./core/time-policy.js";
import type {
  LogLevel,
  OperationalLogOptions,
} from "./observability/operational-logger.js";
import type {
  ConfiguredModel,
  ConfiguredModelSource,
} from "./domain/control-plane.js";
import {
  parseEnabled,
  parseLiveExplorationMessageScope,
  parsePairingMode,
  parsePrivateEnabled,
  parseWhatsAppAccounts,
  type WhatsAppConfig,
} from "./whatsapp/config.js";
import { resolvePrimaryTelegramBotToken } from
  "./operations/primary-channel-credentials.js";

/**
 * `testing` memakai satu model gratis lewat Google AI Studio, dengan beberapa
 * kunci yang dipakai bergantian. `production` memakai tiga model lewat
 * OpenRouter, dipilih menurut kesulitan pekerjaan.
 */
export type AiMode = "testing" | "production";

export interface AiConfig {
  mode: AiMode;
  providerId: string;
  keys: ApiKeyPool;
  baseUrl: string;
  /** Provider cadangan yang hanya boleh hidup dalam mode testing. */
  fallback: AiFallbackOptions | null;
  testingModel: string;
  /**
   * Model uji per tingkatan. Kosong berarti memakai `testingModel`.
   *
   * Tanpa peta ini seluruh routing tidak dapat diamati dalam mode uji: satu
   * model melayani semua tingkatan, sehingga naik-turunnya tier tidak pernah
   * terlihat pada keluaran mana pun.
   */
  testingModels: Partial<Record<ModelTier, string>>;
  models: Record<ModelTier, string>;
  /** Binding role kognitif ke tier accounting dan optional exact model. */
  roleBindings?: Partial<Record<CognitiveModelRole, CognitiveModelBinding>>;
  /** Opt-in specialist graph; readiness exact/diverse diverifikasi composition. */
  specialistDelegationEnabled: boolean;
  /** Escalation-only model; null keeps Phase M disabled. */
  toughest: {
    modelId: string;
    privacyDomain: string;
  } | null;
  /** Capability provider+model; key tidak pernah diturunkan dari prompt. */
  modelProfiles: ModelProfileRegistry;
  /** Model dari seluruh slot `.env`, tanpa key, base URL, atau credential. */
  configuredModels: ConfiguredModel[];
  /** Null mempertahankan retrieval semantic fail-closed. */
  memoryEmbeddingModel: string | null;
  rollingTokenLimit: number;
  prices: Record<ModelTier, TierPrice>;
}

export interface EconomyConfig {
  file: string;
  byokSecretFile: string;
  byokMasterKey: Uint8Array | null;
  paymentGatewayMode: "disabled" | "local";
  paygComputeUnitsPerIdr: string;
  gettingLowThresholdBps: number;
  lowThresholdBps: number;
  notificationCooldownMs: number;
  supportMilestone: number;
}

export interface ControlPlaneConfig {
  file: string;
  usageLedgerFile: string;
  entitlementLedgerFile: string;
  usageLedgerRetentionDays: number;
  betaQuotaMultiplier: number;
  /** Durable compute/funding state; separate from provider and entitlement ledgers. */
  /** Optional for backwards-compatible programmatic/test configs. */
  economy?: EconomyConfig;
  console: {
    enabled: boolean;
    host: "127.0.0.1";
    port: number;
    operatorToken: string | null;
  };
}

export interface AppConfig {
  telegramBotToken: string;
  dataFile: string;
  /** Memori terstruktur per pengguna. Lihat `ADR-006`. */
  memoryFile: string;
  /** Folder memori Markdown, satu subfolder per pengguna. */
  memoryFolder: string;
  /** Riwayat percakapan yang sudah dipadatkan. Berisi kata-kata pengguna. */
  historyFile: string;
  /** Cold archive, learned procedures, outbox, dan derived embedding index. */
  longTermMemoryFile: string;
  /** Status kenalan dan persetujuan per pengguna. */
  profileFile: string;
  /** Satu sesi aktif dan check-in satu kali per pengguna. */
  sessionFile: string;
  /** Checkpoint agent yang menunggu jawaban; berisi data percakapan sementara. */
  agentRunFile: string;
  /** Token dan event bertipe tertutup; tidak berisi isi percakapan. */
  telemetryFile: string;
  telemetryRetentionDays: number;
  defaultTimezone: string;
  reminderIntervalMs: number;
  operationalLog: OperationalLogOptions;
  controlPlane: ControlPlaneConfig;
  ai: AiConfig;
  whatsapp: WhatsAppConfig;
  /** URL halaman persyaratan dan layanan yang dirujuk dari naskah perkenalan. */
  termsUrl: string;
}

/** Konfigurasi penuh yang hanya dibentuk oleh bootstrap runtime. */
export interface RuntimeAppConfig extends AppConfig {
  /** Capability ingress/executor Phase K; default-off sampai live acceptance. */
  groupAgentRunEnabled: boolean;
  /** State durable GroupAgentRun WhatsApp; wajib terpisah dari state grup. */
  groupAgentRunFile: string;
  /** Intent penghapusan scope; terpisah agar retry tetap hidup setelah crash. */
  groupAgentRunCleanupFile: string;
}

const GOOGLE_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function aiClientOptions(
  config: AiConfig,
  options: { fallback?: boolean } = {},
): AiClientOptions {
  return {
    baseUrl: config.baseUrl,
    keys: config.keys,
    fallback: options.fallback === false ? null : config.fallback,
    providerId: config.providerId,
    modelProfiles: config.modelProfiles,
  };
}

export function loadConfig(): RuntimeAppConfig {
  loadEnvironmentFile();

  const telegramBotToken = resolvePrimaryTelegramBotToken();

  const defaultTimezone = process.env.DEFAULT_TIMEZONE ?? "Asia/Jakarta";
  if (!isValidTimeZone(defaultTimezone)) {
    throw configurationError(
      "CONFIG_DEFAULT_TIMEZONE_INVALID",
      "DEFAULT_TIMEZONE harus berupa zona waktu IANA yang sah.",
    );
  }

  const reminderIntervalMs = Number(
    process.env.REMINDER_INTERVAL_MS ?? "30000",
  );
  if (!Number.isFinite(reminderIntervalMs) || reminderIntervalMs < 5_000) {
    throw configurationError(
      "CONFIG_REMINDER_INTERVAL_INVALID",
      "REMINDER_INTERVAL_MS minimal 5000.",
    );
  }

  const operationalLog = loadOperationalLogConfig();
  const whatsapp = loadWhatsAppConfig();
  const groupAgentRunFile = resolveGroupAgentRunFile(whatsapp.groupFile);
  return {
    telegramBotToken,
    dataFile: resolve(process.env.DATA_FILE ?? "./data/tasks.json"),
    memoryFile: resolve(process.env.MEMORY_FILE ?? "./data/memories.json"),
    memoryFolder: resolve(process.env.MEMORY_FOLDER ?? "./data/memori"),
    historyFile: resolve(process.env.HISTORY_FILE ?? "./data/history.json"),
    longTermMemoryFile: resolve(
      process.env.LONG_TERM_MEMORY_FILE ?? "./data/long-term-memory.sqlite",
    ),
    profileFile: resolve(process.env.PROFILE_FILE ?? "./data/profiles.json"),
    sessionFile: resolve(process.env.SESSION_FILE ?? "./data/sessions.json"),
    agentRunFile: resolve(
      process.env.AGENT_RUN_FILE ?? "./data/agent-runs.json",
    ),
    telemetryFile: resolve(
      process.env.TELEMETRY_FILE ?? "./data/telemetry.json",
    ),
    telemetryRetentionDays: readPositiveNumber(
      "TELEMETRY_RETENTION_DAYS",
      30,
    ),
    defaultTimezone,
    reminderIntervalMs,
    operationalLog,
    controlPlane: loadControlPlaneConfig(operationalLog.environment),
    ai: loadAiConfig(),
    whatsapp,
    groupAgentRunEnabled: resolveGroupAgentRunEnabled(),
    groupAgentRunFile,
    groupAgentRunCleanupFile: resolveGroupAgentRunCleanupFile(
      whatsapp.groupFile,
      groupAgentRunFile,
    ),
    termsUrl: process.env.TERMS_URL?.trim() || "https://harvy.id/terms",
  };
}

export function resolveGroupAgentRunEnabled(
  configured = process.env.WHATSAPP_GROUP_AGENT_RUN_ENABLED,
): boolean {
  const normalized = configured?.trim().toLocaleLowerCase("en-US");
  if (!normalized) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw configurationError(
    "CONFIG_WHATSAPP_GROUP_AGENT_RUN_ENABLED_INVALID",
    "WHATSAPP_GROUP_AGENT_RUN_ENABLED harus true atau false.",
  );
}

export function resolveGroupAgentRunFile(
  groupFile: string,
  configuredPath = process.env.WHATSAPP_GROUP_AGENT_RUN_FILE,
): string {
  const file = resolve(
    configuredPath?.trim() || "./data/whatsapp-group-agent-runs.json",
  );
  const resolvedGroupFile = resolve(groupFile);
  const comparableFile = process.platform === "win32"
    ? file.toLocaleLowerCase("en-US")
    : file;
  const comparableGroupFile = process.platform === "win32"
    ? resolvedGroupFile.toLocaleLowerCase("en-US")
    : resolvedGroupFile;
  if (comparableFile === comparableGroupFile) {
    throw configurationError(
      "CONFIG_WHATSAPP_GROUP_AGENT_RUN_FILE_SHARED",
      "WHATSAPP_GROUP_AGENT_RUN_FILE wajib terpisah dari WHATSAPP_GROUP_FILE.",
    );
  }
  return file;
}

export function resolveGroupAgentRunCleanupFile(
  groupFile: string,
  groupAgentRunFile: string,
  configuredPath = process.env.WHATSAPP_GROUP_AGENT_RUN_CLEANUP_FILE,
): string {
  const file = resolve(
    configuredPath?.trim() ||
      "./data/whatsapp-group-agent-run-cleanup.json",
  );
  const comparable = comparablePath(file);
  if (
    comparable === comparablePath(groupFile) ||
    comparable === comparablePath(groupAgentRunFile)
  ) {
    throw configurationError(
      "CONFIG_WHATSAPP_GROUP_AGENT_RUN_CLEANUP_FILE_SHARED",
      "WHATSAPP_GROUP_AGENT_RUN_CLEANUP_FILE wajib terpisah dari state grup dan GroupAgentRun.",
    );
  }
  return file;
}

function comparablePath(value: string): string {
  const file = resolve(value);
  return process.platform === "win32"
    ? file.toLocaleLowerCase("en-US")
    : file;
}

function loadControlPlaneConfig(environment: string): ControlPlaneConfig {
  const enabled = readBoolean("HARVY_CONSOLE_ENABLED", false);
  const host = process.env.HARVY_CONSOLE_HOST?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw configurationError(
      "CONFIG_HARVY_CONSOLE_HOST_INVALID",
      "HARVY_CONSOLE_HOST local-first harus 127.0.0.1.",
    );
  }
  const operatorToken = process.env.HARVY_CONSOLE_TOKEN?.trim() || null;
  if (operatorToken !== null && operatorToken.length < 32) {
    throw configurationError(
      "CONFIG_HARVY_CONSOLE_TOKEN_INVALID",
      "HARVY_CONSOLE_TOKEN minimal 32 karakter.",
    );
  }
  if (enabled && environment === "production" && operatorToken === null) {
    throw configurationError(
      "CONFIG_HARVY_CONSOLE_TOKEN_MISSING",
      "HARVY_CONSOLE_TOKEN wajib diisi ketika Console aktif di production.",
    );
  }
  const paymentGatewayMode = readLabel(
    "HARVY_PAYMENT_GATEWAY_MODE",
    "disabled",
  );
  if (paymentGatewayMode !== "disabled" && paymentGatewayMode !== "local") {
    throw configurationError(
      "CONFIG_PAYMENT_GATEWAY_MODE_INVALID",
      "HARVY_PAYMENT_GATEWAY_MODE hanya boleh disabled atau local.",
    );
  }
  if (paymentGatewayMode === "local" && environment === "production") {
    throw configurationError(
      "CONFIG_PAYMENT_GATEWAY_LOCAL_PRODUCTION",
      "Gateway pembayaran lokal tidak boleh diaktifkan di production.",
    );
  }
  return {
    file: resolve(
      process.env.CONTROL_PLANE_FILE ?? "./data/control-plane.json",
    ),
    usageLedgerFile: resolve(
      process.env.USAGE_LEDGER_FILE ?? "./data/usage-ledger.json",
    ),
    entitlementLedgerFile: resolve(
      process.env.ENTITLEMENT_LEDGER_FILE ?? "./data/entitlement-ledger.json",
    ),
    usageLedgerRetentionDays: readPositiveInteger(
      "USAGE_LEDGER_RETENTION_DAYS",
      90,
    ),
    betaQuotaMultiplier: readPositiveInteger(
      "BETA_QUOTA_MULTIPLIER",
      4,
    ),
    economy: {
      file: resolve(
        process.env.HARVY_ECONOMY_FILE ?? "./data/economy.json",
      ),
      byokSecretFile: resolve(
        process.env.HARVY_BYOK_SECRET_FILE ?? "./data/byok-secrets.json",
      ),
      byokMasterKey: parseByokMasterKey(process.env.HARVY_BYOK_MASTER_KEY_B64),
      paymentGatewayMode,
      paygComputeUnitsPerIdr: readPositiveIntegerString(
        "HARVY_PAYG_COMPUTE_UNITS_PER_IDR",
        "1000000",
      ),
      gettingLowThresholdBps: readBps(
        "HARVY_USAGE_GETTING_LOW_BPS",
        5_000,
      ),
      lowThresholdBps: readBps("HARVY_USAGE_LOW_BPS", 2_000),
      notificationCooldownMs: readPositiveInteger(
        "HARVY_USAGE_NOTIFICATION_COOLDOWN_MS",
        24 * 60 * 60 * 1_000,
      ),
      supportMilestone: readPositiveInteger(
        "HARVY_SUPPORT_MILESTONE",
        8,
      ),
    },
    console: {
      enabled,
      host,
      port: readNonNegativeInteger("HARVY_CONSOLE_PORT", 3210, 65_535),
      operatorToken,
    },
  };
}

/**
 * Konfigurasi ini dapat dibaca sebelum konfigurasi aplikasi lain agar galat
 * bootstrap (misalnya token/model yang tidak diisi) tetap masuk log.
 */
export function loadOperationalLogConfig(): OperationalLogOptions {
  loadEnvironmentFile();
  const environment = readLabel("APP_ENV", "development");
  const directory = resolve(process.env.LOG_FOLDER ?? "./data/logs");
  if (parse(directory).root === directory) {
    throw configurationError(
      "CONFIG_LOG_FOLDER_ROOT",
      "LOG_FOLDER tidak boleh menunjuk ke akar filesystem.",
    );
  }

  const level = readLogLevel(process.env.LOG_LEVEL);
  const consoleFormat = readConsoleFormat(
    process.env.LOG_CONSOLE_FORMAT,
    environment === "production" ? "json" : "pretty",
  );
  return {
    directory,
    level,
    environment,
    release: readLabel(
      "RELEASE_SHA",
      process.env.npm_package_version ?? "0.1.0",
    ),
    retentionDays: readPositiveInteger("LOG_RETENTION_DAYS", 14),
    maxSegmentBytes: readPositiveInteger(
      "LOG_MAX_FILE_BYTES",
      25 * 1024 * 1024,
    ),
    maxTotalBytes: readPositiveInteger(
      "LOG_MAX_TOTAL_BYTES",
      250 * 1024 * 1024,
    ),
    maxQueueRecords: readPositiveInteger(
      "LOG_QUEUE_MAX_RECORDS",
      10_000,
    ),
    maxQueueBytes: readPositiveInteger(
      "LOG_QUEUE_MAX_BYTES",
      8 * 1024 * 1024,
    ),
    consoleEnabled: readBoolean("LOG_CONSOLE", true),
    consoleFormat,
    fileRequired: readBoolean("LOG_FILE_REQUIRED", false),
  };
}

function loadWhatsAppConfig(): WhatsAppConfig {
  const enabled = parseEnabled(process.env.WHATSAPP_ENABLED);
  const accounts = parseWhatsAppAccounts(process.env.WHATSAPP_ACCOUNTS);
  if (enabled && accounts.length === 0) {
    throw configurationError(
      "CONFIG_WHATSAPP_ACCOUNTS_MISSING",
      "WHATSAPP_ACCOUNTS wajib berisi minimal satu akun ketika WhatsApp aktif.",
    );
  }

  const reconnectBaseMs = readPositiveNumber(
    "WHATSAPP_RECONNECT_BASE_MS",
    2_000,
  );
  const reconnectMaxMs = readPositiveNumber(
    "WHATSAPP_RECONNECT_MAX_MS",
    60_000,
  );
  if (reconnectMaxMs < reconnectBaseMs) {
    throw configurationError(
      "CONFIG_WHATSAPP_RECONNECT_RANGE",
      "WHATSAPP_RECONNECT_MAX_MS tidak boleh lebih kecil daripada batas dasar.",
    );
  }

  return {
    enabled,
    privateEnabled: parsePrivateEnabled(
      process.env.WHATSAPP_PRIVATE_ENABLED,
    ),
    accounts,
    pairingMode: parsePairingMode(process.env.WHATSAPP_PAIRING_MODE),
    authFolder: resolve(
      process.env.WHATSAPP_AUTH_FOLDER ?? "./data/whatsapp-auth",
    ),
    groupFile: resolve(
      process.env.WHATSAPP_GROUP_FILE ?? "./data/whatsapp-groups.json",
    ),
    reconnectBaseMs,
    reconnectMaxMs,
    liveExplorationMessageScope: parseLiveExplorationMessageScope(
      process.env.HARVY_LIVE_EXPLORATION_MESSAGE_SCOPE,
      {
        environment: process.env.APP_ENV,
        release: process.env.RELEASE_SHA,
        trace: process.env.HARVY_LIVE_ACCEPTANCE_TRACE,
      },
    ),
  };
}

/**
 * Seluruh ID model dibaca dari environment, tidak ditulis mati di kode.
 *
 * Nama, ketersediaan, dan harga model berubah cepat. Menaruhnya di konfigurasi
 * membuat koreksi cukup satu baris `.env`, tanpa menyentuh kode.
 */
export function loadAiConfig(): AiConfig {
  const mode = (process.env.AI_MODE ?? "testing") as AiMode;
  if (mode !== "testing" && mode !== "production") {
    throw configurationError(
      "CONFIG_AI_MODE_INVALID",
      "AI_MODE harus testing atau production.",
    );
  }

  const models = {
    cheap: process.env.AI_MODEL_CHEAP?.trim() ?? "",
    efficient: process.env.AI_MODEL_EFFICIENT?.trim() ?? "",
    ambitious: process.env.AI_MODEL_AMBITIOUS?.trim() ?? "",
  } satisfies Record<ModelTier, string>;

  const testingModel = process.env.AI_MODEL_TESTING?.trim() ?? "";
  const testingToughestModel = process.env.AI_MODEL_TESTING_TOUGHEST?.trim() ?? "";
  const productionToughestModel = process.env.AI_MODEL_TOUGHEST?.trim() ?? "";
  const activeToughestModel = mode === "testing"
    ? testingToughestModel
    : productionToughestModel;
  const toughestPrivacyDomainRaw = process.env.AI_TOUGHEST_PRIVACY_DOMAIN?.trim() ?? "";
  // Slot mode lain tetap boleh diinventarisasi tanpa mengaktifkan route itu.
  // Domain tanpa slot mana pun tetap ditolak sebagai konfigurasi yatim.
  const activeToughestPrivacyDomain = !activeToughestModel &&
      (testingToughestModel || productionToughestModel)
    ? ""
    : toughestPrivacyDomainRaw;
  const memoryEmbeddingModelRaw = process.env.MEMORY_EMBEDDING_MODEL?.trim() ?? "";
  const memoryEmbeddingModel = memoryEmbeddingModelRaw
    ? configuredModelId("MEMORY_EMBEDDING_MODEL", memoryEmbeddingModelRaw)
    : null;
  const testingModels: Partial<Record<ModelTier, string>> = {
    ...(process.env.AI_MODEL_TESTING_CHEAP?.trim()
      ? { cheap: process.env.AI_MODEL_TESTING_CHEAP.trim() }
      : {}),
    ...(process.env.AI_MODEL_TESTING_EFFICIENT?.trim()
      ? { efficient: process.env.AI_MODEL_TESTING_EFFICIENT.trim() }
      : {}),
    ...(process.env.AI_MODEL_TESTING_AMBITIOUS?.trim()
      ? { ambitious: process.env.AI_MODEL_TESTING_AMBITIOUS.trim() }
      : {}),
  };
  const roleBindings = loadCognitiveModelBindings();
  const specialistDelegationEnabled = readBoolean(
    "AI_SPECIALIST_DELEGATION_ENABLED",
    false,
  );
  const rollingTokenLimit = readNonNegativeNumber(
    "AI_ROLLING_24H_TOKEN_LIMIT",
    200_000,
  );
  const prices = {
    cheap: readTierPrice("CHEAP"),
    efficient: readTierPrice("EFFICIENT"),
    ambitious: readTierPrice("AMBITIOUS"),
  } satisfies Record<ModelTier, TierPrice>;

  if (mode === "testing") {
    const keys = ApiKeyPool.parse(process.env.GOOGLE_AI_STUDIO_API_KEYS);
    if (keys.length === 0) {
      throw configurationError(
        "CONFIG_GOOGLE_KEYS_MISSING",
        "GOOGLE_AI_STUDIO_API_KEYS wajib diisi ketika AI_MODE=testing. " +
          "Beberapa kunci boleh dipisah koma.",
      );
    }
    if (!testingModel) {
      throw configurationError(
        "CONFIG_TESTING_MODEL_MISSING",
        "AI_MODEL_TESTING wajib diisi ketika AI_MODE=testing.",
      );
    }

    const fallback = loadTestingFallback();
    const baseUrl = validatedAiBaseUrl(
      process.env.AI_BASE_URL?.trim() || GOOGLE_BASE_URL,
    );
    const configuredModels = configuredModelCatalog({
      mode,
      testingModel,
      testingModels,
      models,
      roleBindings,
      activeFallback: fallback,
      testingToughestModel,
      productionToughestModel,
    });
    const explicitProfiles = loadExplicitModelProfiles();
    const modelProfiles = configuredModelProfiles({
      configuredModels,
      codeOwnedProfiles: liveVerifiedModelProfiles(
        "google-ai-studio",
        baseUrl,
      ),
      explicitProfiles,
    });
    const toughest = configuredToughest(
      "google-ai-studio",
      activeToughestModel,
      activeToughestPrivacyDomain,
      modelProfiles,
    );
    return {
      mode,
      providerId: "google-ai-studio",
      keys: new ApiKeyPool(keys),
      baseUrl,
      fallback,
      testingModel,
      testingModels,
      models,
      roleBindings,
      specialistDelegationEnabled,
      toughest,
      modelProfiles,
      configuredModels,
      memoryEmbeddingModel,
      rollingTokenLimit,
      prices,
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw configurationError(
      "CONFIG_OPENROUTER_KEY_MISSING",
      "OPENROUTER_API_KEY wajib diisi ketika AI_MODE=production.",
    );
  }

  const missing = (Object.keys(models) as ModelTier[]).filter(
    (tier) => !models[tier],
  );
  if (missing.length > 0) {
    throw configurationError(
      "CONFIG_PRODUCTION_MODELS_MISSING",
      `Model belum lengkap untuk AI_MODE=production: ${missing.join(", ")}.`,
    );
  }

  const baseUrl = validatedAiBaseUrl(
    process.env.AI_BASE_URL?.trim() || OPENROUTER_BASE_URL,
  );
  const configuredModels = configuredModelCatalog({
    mode,
    testingModel,
    testingModels,
    models,
    roleBindings,
    activeFallback: null,
    testingToughestModel,
    productionToughestModel,
  });
  const explicitProfiles = loadExplicitModelProfiles();
  const modelProfiles = configuredModelProfiles({
    configuredModels,
    codeOwnedProfiles: liveVerifiedModelProfiles("openrouter", baseUrl),
    explicitProfiles,
  });
  const toughest = configuredToughest(
    "openrouter",
    activeToughestModel,
    activeToughestPrivacyDomain,
    modelProfiles,
  );
  return {
    mode,
    providerId: "openrouter",
    keys: new ApiKeyPool([apiKey]),
    baseUrl,
    fallback: null,
    testingModel,
    testingModels,
    models,
    roleBindings,
    specialistDelegationEnabled,
    toughest,
    modelProfiles,
    configuredModels,
    memoryEmbeddingModel,
    rollingTokenLimit,
    prices,
  };
}

const MAX_AI_MODEL_ROLE_BINDINGS_CHARACTERS = 8_192;
const MODEL_TIERS = new Set<ModelTier>([
  "cheap",
  "efficient",
  "ambitious",
]);

/**
 * Role binding adalah konfigurasi operator, bukan output router/model. Schema
 * sengaja tertutup agar typo tidak diam-diam memindahkan pekerjaan ke model
 * yang salah.
 */
function loadCognitiveModelBindings(): Partial<
  Record<CognitiveModelRole, CognitiveModelBinding>
> {
  const raw = process.env.AI_MODEL_ROLE_BINDINGS?.trim() ?? "";
  if (!raw) return Object.freeze({});
  if (raw.length > MAX_AI_MODEL_ROLE_BINDINGS_CHARACTERS) {
    throw configurationError(
      "CONFIG_AI_MODEL_ROLE_BINDINGS_INVALID",
      "AI_MODEL_ROLE_BINDINGS terlalu besar.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw configurationError(
      "CONFIG_AI_MODEL_ROLE_BINDINGS_INVALID",
      "AI_MODEL_ROLE_BINDINGS harus berupa object JSON yang sah.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw configurationError(
      "CONFIG_AI_MODEL_ROLE_BINDINGS_INVALID",
      "AI_MODEL_ROLE_BINDINGS harus berupa object JSON.",
    );
  }

  const record = parsed as Record<string, unknown>;
  const allowedRoles = new Set<string>(COGNITIVE_MODEL_ROLES);
  if (Object.keys(record).some((role) => !allowedRoles.has(role))) {
    throw configurationError(
      "CONFIG_AI_MODEL_ROLE_BINDINGS_INVALID",
      "AI_MODEL_ROLE_BINDINGS memuat role yang tidak dikenal.",
    );
  }

  const bindings: Partial<
    Record<CognitiveModelRole, CognitiveModelBinding>
  > = {};
  try {
    for (const role of COGNITIVE_MODEL_ROLES) {
      const value = record[role];
      if (value === undefined) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Binding role harus berupa object.");
      }
      const binding = value as Record<string, unknown>;
      const keys = Object.keys(binding);
      if (
        !Object.hasOwn(binding, "tier") ||
        keys.some((key) => key !== "tier" && key !== "modelId")
      ) {
        throw new Error("Field binding role tidak sah.");
      }
      const tier = binding["tier"];
      if (typeof tier !== "string" || !MODEL_TIERS.has(tier as ModelTier)) {
        throw new Error("Tier binding role tidak sah.");
      }
      if (!Object.hasOwn(binding, "modelId")) {
        bindings[role] = Object.freeze({ tier: tier as ModelTier });
        continue;
      }
      if (typeof binding["modelId"] !== "string") {
        throw new Error("Exact model binding role tidak sah.");
      }
      bindings[role] = Object.freeze({
        tier: tier as ModelTier,
        modelId: configuredModelId(
          "AI_MODEL_ROLE_BINDINGS",
          binding["modelId"],
        ),
      });
    }
  } catch {
    throw configurationError(
      "CONFIG_AI_MODEL_ROLE_BINDINGS_INVALID",
      "AI_MODEL_ROLE_BINDINGS memuat binding yang tidak sah.",
    );
  }
  return Object.freeze(bindings);
}

const MAX_AI_MODEL_PROFILES_CHARACTERS = 64_000;
const MAX_AI_MODEL_PROFILES = 32;

/**
 * Capability operator hanya aktif lewat deklarasi exact provider+model.
 * Profile code-owned tetap memerlukan live evidence exact; nama endpoint saja
 * tidak cukup untuk mempromosikan model baru.
 */
function loadExplicitModelProfiles(): readonly ModelProfile[] {
  const raw = process.env.AI_MODEL_PROFILES?.trim() ?? "";
  if (!raw) return [];
  if (raw.length > MAX_AI_MODEL_PROFILES_CHARACTERS) {
    throw configurationError(
      "CONFIG_AI_MODEL_PROFILES_INVALID",
      "AI_MODEL_PROFILES terlalu besar.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw configurationError(
      "CONFIG_AI_MODEL_PROFILES_INVALID",
      "AI_MODEL_PROFILES harus berupa array JSON yang sah.",
    );
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_AI_MODEL_PROFILES) {
    throw configurationError(
      "CONFIG_AI_MODEL_PROFILES_INVALID",
      `AI_MODEL_PROFILES harus berupa array maksimal ${MAX_AI_MODEL_PROFILES} profile.`,
    );
  }

  try {
    return new ModelProfileRegistry(parsed.map(parseExplicitModelProfile)).list();
  } catch {
    throw configurationError(
      "CONFIG_AI_MODEL_PROFILES_INVALID",
      "AI_MODEL_PROFILES memuat capability yang tidak lengkap atau tidak sah.",
    );
  }
}

function parseExplicitModelProfile(value: unknown): ModelProfile {
  const profile = exactRecord(value, [
    "provider",
    "id",
    "reasoning",
    "supports",
    "continuation",
    "contextWindow",
    "maxOutputTokens",
  ]);
  const reasoning = exactRecord(profile["reasoning"], [
    "mandatory",
    "defaultEffort",
    "supportedEfforts",
    "wireFormat",
  ]);
  const supports = exactRecord(profile["supports"], [
    "tools",
    "toolChoice",
    "namedToolChoice",
    "structuredOutput",
    "temperature",
  ]);
  const continuation = exactRecord(profile["continuation"], [
    "preserveReasoning",
    "preserveAssistantMessage",
  ]);

  return {
    provider: requiredString(profile["provider"]),
    id: requiredString(profile["id"]),
    verification: "explicit",
    reasoning: {
      mandatory: requiredBoolean(reasoning["mandatory"]),
      defaultEffort: requiredString(reasoning["defaultEffort"]) as
        ModelProfile["reasoning"]["defaultEffort"],
      supportedEfforts: requiredStringArray(reasoning["supportedEfforts"]) as
        ModelProfile["reasoning"]["supportedEfforts"],
      wireFormat: requiredString(reasoning["wireFormat"]) as
        ModelProfile["reasoning"]["wireFormat"],
    },
    supports: {
      tools: requiredBoolean(supports["tools"]),
      toolChoice: requiredBoolean(supports["toolChoice"]),
      namedToolChoice: requiredBoolean(supports["namedToolChoice"]),
      structuredOutput: requiredBoolean(supports["structuredOutput"]),
      temperature: requiredBoolean(supports["temperature"]),
    },
    continuation: {
      preserveReasoning: requiredBoolean(continuation["preserveReasoning"]),
      preserveAssistantMessage: requiredBoolean(
        continuation["preserveAssistantMessage"],
      ),
    },
    contextWindow: optionalPositiveInteger(profile["contextWindow"]),
    maxOutputTokens: optionalPositiveInteger(profile["maxOutputTokens"]),
  };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Object profile tidak sah.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error("Field profile tidak lengkap atau berlebih.");
  }
  return record;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("String profile tidak sah.");
  }
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Boolean profile tidak sah.");
  return value;
}

function requiredStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("Array profile tidak sah.");
  }
  return value;
}

function optionalPositiveInteger(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Limit profile tidak sah.");
  }
  return value;
}

function configuredModelProfiles(input: {
  configuredModels: readonly ConfiguredModel[];
  codeOwnedProfiles: readonly ModelProfile[];
  explicitProfiles: readonly ModelProfile[];
}): ModelProfileRegistry {
  const profiles = new Map<string, ModelProfile>();
  const add = (profile: ModelProfile): void => {
    profiles.set(`${profile.provider}\u0000${profile.id}`, profile);
  };
  for (const model of input.configuredModels) {
    const primary = model.sources.some((source) => source.origin === "primary");
    add({
      id: model.modelId,
      provider: model.providerId,
      verification: "compatibility",
      reasoning: {
        mandatory: false,
        defaultEffort: "none",
        supportedEfforts: [],
        wireFormat: "none",
      },
      supports: {
        tools: primary,
        toolChoice: primary,
        namedToolChoice: primary,
        structuredOutput: primary,
        temperature: true,
      },
      continuation: {
        preserveReasoning: false,
        preserveAssistantMessage: primary,
      },
      contextWindow: null,
      maxOutputTokens: null,
    });
  }
  for (const profile of input.codeOwnedProfiles) {
    const key = `${profile.provider}\u0000${profile.id}`;
    const configured = input.configuredModels.find(
      (model) => model.providerId === profile.provider && model.modelId === profile.id,
    );
    if (!configured) continue;
    // Registry saat ini tidak dapat membawa profile berbeda untuk primary dan
    // fallback pada pasangan yang sama. Tetap compatibility sampai fallback
    // wire contract mempunyai bukti dan execution plan sendiri.
    if (configured.sources.some(
      (source) => source.origin === "fallback" && source.active,
    )) continue;
    profiles.set(key, profile);
  }
  for (const profile of input.explicitProfiles) {
    const key = `${profile.provider}\u0000${profile.id}`;
    if (!profiles.has(key)) {
      throw configurationError(
        "CONFIG_AI_MODEL_PROFILES_UNKNOWN",
        `AI_MODEL_PROFILES memuat model yang tidak dikonfigurasi: ${profile.provider}/${profile.id}.`,
      );
    }
    const configured = input.configuredModels.find(
      (model) => model.providerId === profile.provider && model.modelId === profile.id,
    );
    if (
      configured?.sources.some(
        (source) => source.origin === "fallback" && source.active,
      )
    ) {
      throw configurationError(
        "CONFIG_AI_MODEL_PROFILES_FALLBACK_UNSUPPORTED",
        "AI_MODEL_PROFILES belum boleh mengaktifkan capability provider fallback.",
      );
    }
    profiles.set(key, profile);
  }
  return new ModelProfileRegistry([...profiles.values()]);
}

function configuredToughest(
  providerId: string,
  modelId: string,
  privacyDomain: string,
  profiles: ModelProfileRegistry,
): AiConfig["toughest"] {
  if (!modelId && !privacyDomain) return null;
  if (!modelId || !privacyDomain) {
    throw configurationError(
      "CONFIG_AI_TOUGHEST_INCOMPLETE",
      "Model toughest dan privacy domain harus dikonfigurasi bersama.",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/u.test(privacyDomain)) {
    throw configurationError(
      "CONFIG_AI_TOUGHEST_PRIVACY_DOMAIN_INVALID",
      "AI_TOUGHEST_PRIVACY_DOMAIN tidak sah.",
    );
  }
  let profile: ModelProfile;
  try {
    profile = profiles.require(providerId, modelId);
  } catch {
    throw configurationError(
      "CONFIG_AI_TOUGHEST_PROFILE_REQUIRED",
      "Model toughest harus mempunyai profile exact yang terdaftar.",
    );
  }
  if (profile.verification !== "explicit") {
    throw configurationError(
      "CONFIG_AI_TOUGHEST_PROFILE_REQUIRED",
      "Model toughest hanya aktif dengan AI_MODEL_PROFILES explicit.",
    );
  }
  return Object.freeze({ modelId: profile.id, privacyDomain });
}

function configuredModelCatalog(input: {
  mode: AiMode;
  testingModel: string;
  testingModels: Partial<Record<ModelTier, string>>;
  models: Record<ModelTier, string>;
  roleBindings: Partial<Record<CognitiveModelRole, CognitiveModelBinding>>;
  activeFallback: AiFallbackOptions | null;
  testingToughestModel: string;
  productionToughestModel: string;
}): ConfiguredModel[] {
  const tiers = ["cheap", "efficient", "ambitious"] as const;
  const entries: {
    providerId: string;
    modelId: string;
    source: ConfiguredModelSource;
  }[] = [];
  const add = (
    providerId: string,
    modelId: string,
    source: ConfiguredModelSource,
  ): void => {
    const cleanModel = configuredModelId(
      source.environmentVariable,
      modelId,
    );
    if (!cleanConfiguredProviderId(providerId)) {
      throw configurationError(
        "CONFIG_AI_MODEL_PROVIDER_INVALID",
        `Provider untuk ${source.environmentVariable} tidak sah.`,
      );
    }
    entries.push({ providerId, modelId: cleanModel, source });
  };

  if (input.testingModel) {
    const servedTiers = tiers.filter((tier) => !input.testingModels[tier]);
    add("google-ai-studio", input.testingModel, {
      environmentVariable: "AI_MODEL_TESTING",
      mode: "testing",
      origin: "primary",
      tiers: [...servedTiers],
      active: input.mode === "testing" && servedTiers.length > 0,
    });
  }
  for (const tier of tiers) {
    const modelId = input.testingModels[tier];
    if (modelId) {
      add("google-ai-studio", modelId, {
        environmentVariable: `AI_MODEL_TESTING_${tier.toUpperCase()}`,
        mode: "testing",
        origin: "primary",
        tiers: [tier],
        active: input.mode === "testing",
      });
    }
  }
  if (input.testingToughestModel) {
    add("google-ai-studio", input.testingToughestModel, {
      environmentVariable: "AI_MODEL_TESTING_TOUGHEST",
      mode: "testing",
      origin: "primary",
      tiers: ["toughest"],
      active: input.mode === "testing",
    });
  }
  for (const tier of tiers) {
    const modelId = input.models[tier];
    if (modelId) {
      add("openrouter", modelId, {
        environmentVariable: `AI_MODEL_${tier.toUpperCase()}`,
        mode: "production",
        origin: "primary",
        tiers: [tier],
        active: input.mode === "production",
      });
    }
  }
  if (input.productionToughestModel) {
    add("openrouter", input.productionToughestModel, {
      environmentVariable: "AI_MODEL_TOUGHEST",
      mode: "production",
      origin: "primary",
      tiers: ["toughest"],
      active: input.mode === "production",
    });
  }

  const roleProvider = input.mode === "testing"
    ? "google-ai-studio"
    : "openrouter";
  for (const role of COGNITIVE_MODEL_ROLES) {
    const binding = input.roleBindings[role];
    if (!binding?.modelId) continue;
    add(roleProvider, binding.modelId, {
      environmentVariable: `AI_MODEL_ROLE_BINDINGS.${role}`,
      mode: input.mode,
      origin: "primary",
      tiers: [binding.tier],
      active: true,
    });
  }

  const fallbackModel = process.env.AI_TESTING_FALLBACK_MODEL?.trim() ?? "";
  if (fallbackModel) {
    const fallbackProvider = input.activeFallback?.providerId ?? readLabel(
      "AI_TESTING_FALLBACK_PROVIDER_ID",
      "testing-fallback",
    );
    add(fallbackProvider, fallbackModel, {
      environmentVariable: "AI_TESTING_FALLBACK_MODEL",
      mode: "testing",
      origin: "fallback",
      tiers: [...tiers],
      active: input.mode === "testing" && input.activeFallback !== null,
    });
  }

  const grouped = new Map<string, ConfiguredModel>();
  for (const entry of entries) {
    const key = `${entry.providerId}\u0000${entry.modelId}`;
    const current = grouped.get(key) ?? {
      providerId: entry.providerId,
      modelId: entry.modelId,
      active: false,
      sources: [],
    };
    current.active ||= entry.source.active;
    if (!current.sources.some((source) =>
      source.environmentVariable === entry.source.environmentVariable &&
      source.mode === entry.source.mode &&
      source.origin === entry.source.origin
    )) {
      current.sources.push(entry.source);
    }
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map((model) => ({
      ...model,
      sources: model.sources.sort((left, right) =>
        left.environmentVariable.localeCompare(right.environmentVariable, "en")
      ),
    }))
    .sort((left, right) =>
      `${left.providerId}\u0000${left.modelId}`.localeCompare(
        `${right.providerId}\u0000${right.modelId}`,
        "en",
      )
    );
}

function configuredModelId(name: string, value: string): string {
  const clean = value.trim();
  if (
    clean.length < 1 ||
    clean.length > 160 ||
    /[\u0000-\u001f<>]/u.test(clean)
  ) {
    throw configurationError(
      `CONFIG_${name}_INVALID`,
      `${name} harus berisi ID model yang sah (maksimal 160 karakter).`,
    );
  }
  return clean;
}

function cleanConfiguredProviderId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u.test(value);
}

function loadTestingFallback(): AiFallbackOptions | null {
  const baseUrl =
    process.env.AI_TESTING_FALLBACK_BASE_URL?.trim() ?? "";
  const apiKey =
    process.env.AI_TESTING_FALLBACK_API_KEY?.trim() ?? "";
  const model =
    process.env.AI_TESTING_FALLBACK_MODEL?.trim() ?? "";
  const configured = Boolean(baseUrl || apiKey || model);
  if (!configured) return null;
  if (!baseUrl || !apiKey || !model) {
    throw configurationError(
      "CONFIG_TESTING_FALLBACK_INCOMPLETE",
      "AI_TESTING_FALLBACK_BASE_URL, AI_TESTING_FALLBACK_API_KEY, dan " +
        "AI_TESTING_FALLBACK_MODEL harus diisi bersama.",
    );
  }

  return {
    baseUrl: validatedFallbackBaseUrl(baseUrl),
    keys: new ApiKeyPool([apiKey]),
    model,
    providerId: readLabel(
      "AI_TESTING_FALLBACK_PROVIDER_ID",
      "testing-fallback",
    ),
    modelInQuery: true,
    cooldownMs: readPositiveNumber(
      "AI_TESTING_FALLBACK_COOLDOWN_MS",
      30_000,
    ),
  };
}

function validatedFallbackBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(
      "CONFIG_TESTING_FALLBACK_URL_INVALID",
      "AI_TESTING_FALLBACK_BASE_URL harus berupa URL HTTPS yang sah.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /\/chat\/completions\/?$/u.test(url.pathname)
  ) {
    throw configurationError(
      "CONFIG_TESTING_FALLBACK_URL_INVALID",
      "AI_TESTING_FALLBACK_BASE_URL harus berupa base URL HTTPS tanpa " +
        "kredensial, query, fragment, atau akhiran /chat/completions.",
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

function validatedAiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(
      "CONFIG_AI_BASE_URL_INVALID",
      "AI_BASE_URL harus berupa base URL HTTPS yang sah.",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /\/chat\/completions\/?$/iu.test(url.pathname)
  ) {
    throw configurationError(
      "CONFIG_AI_BASE_URL_INVALID",
      "AI_BASE_URL harus berupa base URL HTTPS (atau HTTP loopback) tanpa " +
        "kredensial, query, fragment, atau akhiran /chat/completions.",
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

function readTierPrice(label: string): TierPrice {
  return {
    inputPerMillionUsd: readNonNegativeNumber(
      `AI_PRICE_${label}_INPUT_PER_MILLION_USD`,
      0,
    ),
    outputPerMillionUsd: readNonNegativeNumber(
      `AI_PRICE_${label}_OUTPUT_PER_MILLION_USD`,
      0,
    ),
  };
}

function readNonNegativeNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? String(fallback));
  if (!Number.isFinite(value) || value < 0) {
    throw configurationError(
      `CONFIG_${name}_INVALID`,
      `${name} harus berupa angka nol atau positif.`,
    );
  }
  return value;
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = readNonNegativeNumber(name, fallback);
  if (value <= 0) {
    throw configurationError(
      `CONFIG_${name}_INVALID`,
      `${name} harus lebih besar dari nol.`,
    );
  }
  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = readPositiveNumber(name, fallback);
  if (!Number.isSafeInteger(value)) {
    throw configurationError(
      `CONFIG_${name}_INVALID`,
      `${name} harus berupa bilangan bulat positif.`,
    );
  }
  return value;
}

function readPositiveIntegerString(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!/^\d+$/u.test(value) || BigInt(value) <= 0n || value.length > 40) {
    throw configurationError(
      `CONFIG_${name}_INVALID`,
      `${name} harus berupa bilangan bulat positif yang terbatas.`,
    );
  }
  return BigInt(value).toString();
}

function readBps(name: string, fallback: number): number {
  const value = readNonNegativeInteger(name, fallback, 10_000);
  return value;
}

function parseByokMasterKey(value: string | undefined): Uint8Array | null {
  const raw = value?.trim();
  if (!raw) return null;
  let decoded: Buffer;
  try {
    const urlSafe = /^[A-Za-z0-9_-]+={0,2}$/u.test(raw);
    const ordinary = /^[A-Za-z0-9+/]+={0,2}$/u.test(raw);
    if (!urlSafe && !ordinary) throw new Error("invalid base64");
    decoded = Buffer.from(raw, urlSafe ? "base64url" : "base64");
  } catch {
    throw configurationError(
      "CONFIG_BYOK_MASTER_KEY_INVALID",
      "HARVY_BYOK_MASTER_KEY_B64 harus berupa kunci base64 32 byte.",
    );
  }
  if (decoded.length !== 32) {
    throw configurationError(
      "CONFIG_BYOK_MASTER_KEY_INVALID",
      "HARVY_BYOK_MASTER_KEY_B64 harus berupa kunci base64 32 byte.",
    );
  }
  return new Uint8Array(decoded);
}

function readNonNegativeInteger(
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = readNonNegativeNumber(name, fallback);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw configurationError(
      `CONFIG_${name}_INVALID`,
      `${name} harus berupa bilangan bulat dalam rentang yang sah.`,
    );
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLocaleLowerCase("en-US");
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw configurationError(
    `CONFIG_${name}_INVALID`,
    `${name} harus true atau false.`,
  );
}

function readLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLocaleLowerCase("en-US") ?? "info";
  if (
    normalized === "trace" ||
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error" ||
    normalized === "fatal"
  ) {
    return normalized;
  }
  throw configurationError(
    "CONFIG_LOG_LEVEL_INVALID",
    "LOG_LEVEL harus trace, debug, info, warn, error, atau fatal.",
  );
}

function readConsoleFormat(
  value: string | undefined,
  fallback: "pretty" | "json",
): "pretty" | "json" {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  if (!normalized) return fallback;
  if (normalized === "pretty" || normalized === "json") return normalized;
  throw configurationError(
    "CONFIG_LOG_CONSOLE_FORMAT_INVALID",
    "LOG_CONSOLE_FORMAT harus pretty atau json.",
  );
}

function readLabel(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value)) {
    throw configurationError(
      `CONFIG_${name}_INVALID`,
      `${name} hanya boleh berisi huruf, angka, titik, _ atau - (maksimal 96).`,
    );
  }
  return value;
}

function loadEnvironmentFile(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (!isMissingEnvFile(error)) throw error;
  }
}

function isMissingEnvFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function configurationError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: "ConfigurationError",
    code,
  });
}
