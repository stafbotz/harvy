import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { Bot } from "grammy";
import { Api, Logger, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import makeWASocket, {
  DisconnectReason,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from "baileys";
import {
  deleteTelegramBotCredential,
  deleteTelegramTesterCredential,
  liveAcceptancePaths,
  loadTelegramBotCredential,
  loadTelegramTesterCredential,
  saveTelegramBotCredential,
  saveTelegramTesterCredential,
  type LiveAcceptancePaths,
} from "./live-acceptance.js";
import {
  acquireLocalRuntimeLock,
  type LocalRuntimeLock,
} from "../core/local-runtime-lock.js";
import { installThirdPartyConsoleSecretGuard } from
  "../observability/third-party-console-guard.js";
import {
  parseEnabled,
  parsePrivateEnabled,
  parseWhatsAppAccounts,
} from "../whatsapp/config.js";
import { isWhatsAppCredentialReady } from "../whatsapp/auth-credential.js";
import {
  deletePrimaryTelegramBotCredential,
  loadPrimaryTelegramBotCredential,
  migratePrimaryTelegramBotCredentialFromEnvironment,
  primaryChannelCredentialPaths,
  primaryTelegramBotToken,
  primaryTelegramEnvironmentStatus,
  savePrimaryTelegramBotCredential,
  type PrimaryChannelCredentialPaths,
} from "./primary-channel-credentials.js";

const DEFAULT_PAIRING_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_WHATSAPP_VERIFICATION_TIMEOUT_MS = 12_000;
const DEFAULT_WHATSAPP_VERIFICATION_TTL_MS = 5 * 60_000;
const TELEGRAM_API_HASH_PATTERN = /^[a-f0-9]{32}$/iu;
const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,160}$/u;

export type WhatsAppTestRole = "harvy" | "tester";
export type ChannelPairingPhase =
  | "idle"
  | "connecting"
  | "awaiting_scan"
  | "awaiting_password"
  | "revoking"
  | "paired"
  | "error";

export interface ChannelPairingSnapshot {
  configured: boolean;
  phase: ChannelPairingPhase;
  qrAvailable: boolean;
  qrRevision: number;
  qrExpiresAt: string | null;
  errorCode: string | null;
}

export type WhatsAppSessionVerificationStatus =
  | "missing"
  | "unchecked"
  | "checking"
  | "accepted"
  | "rejected"
  | "unreachable";

export interface WhatsAppSessionVerificationSnapshot {
  status: WhatsAppSessionVerificationStatus;
  checkedAt: string | null;
  errorCode: string | null;
}

export interface WhatsAppPairingSnapshot extends ChannelPairingSnapshot {
  session: WhatsAppSessionVerificationSnapshot;
}

export interface ChannelSetupSnapshot {
  identityBoundary: {
    mode: "isolated_acceptance";
    primary: PrimaryChannelConfigurationSnapshot;
  };
  telegram: {
    ready: boolean;
    bot: {
      configured: boolean;
      phase: "missing" | "validating" | "ready" | "error";
      errorCode: string | null;
    };
    tester: ChannelPairingSnapshot;
  };
  whatsapp: {
    ready: boolean;
    harvy: WhatsAppPairingSnapshot;
    tester: WhatsAppPairingSnapshot;
  };
}

export interface PrimaryChannelConfigurationSnapshot {
  telegram: {
    declared: boolean;
    configured?: boolean;
    source?: "console" | "environment" | "missing" | "conflict";
    legacyEnvironment?: boolean;
    migrationAvailable?: boolean;
    runtimeActive?: boolean;
    restartRequired?: boolean;
    phase?: "missing" | "unchecked" | "validating" | "ready" | "error";
    errorCode?: string | null;
  };
  whatsapp: {
    configurationValid: boolean;
    enabled: boolean;
    privateEnabled: boolean;
    accountCount: number;
    declared: boolean;
  };
}

export interface TelegramPairingAdapter {
  validateBotToken(token: string, signal: AbortSignal): Promise<void>;
  pairTester(input: {
    apiId: number;
    apiHash: string;
    signal: AbortSignal;
    onQr(value: string, expiresAt: number): void;
    requestPassword(): Promise<string>;
  }): Promise<string>;
  revokeTester(input: {
    apiId: number;
    apiHash: string;
    session: string;
    signal: AbortSignal;
  }): Promise<void>;
}

export interface WhatsAppPairingAdapter {
  configured(authFolder: string): Promise<boolean>;
  probe(input: {
    authFolder: string;
    signal: AbortSignal;
  }): Promise<"accepted" | "rejected">;
  pair(input: {
    authFolder: string;
    otherAuthFolder: string;
    signal: AbortSignal;
    onQr(value: string): void;
  }): Promise<void>;
  revoke(input: {
    authFolder: string;
    authRoot: string;
    signal: AbortSignal;
  }): Promise<void>;
}

interface PairingState {
  phase: ChannelPairingPhase;
  qr: string | null;
  qrRevision: number;
  qrExpiresAt: number | null;
  errorCode: string | null;
}

interface PasswordWaiter {
  resolve(value: string): void;
  reject(error: Error): void;
}

interface ActiveOperation {
  id: number;
  controller: AbortController;
  timer: NodeJS.Timeout;
  task: Promise<void>;
  cancelled: boolean;
  timedOut: boolean;
  passwordWaiter: PasswordWaiter | null;
}

export interface ChannelSetupServiceOptions {
  paths?: LiveAcceptancePaths;
  telegramAdapter?: TelegramPairingAdapter;
  whatsappAdapter?: WhatsAppPairingAdapter;
  pairingTimeoutMs?: number;
  whatsappVerificationTimeoutMs?: number;
  whatsappVerificationTtlMs?: number;
  now?: () => number;
  primaryChannels?: PrimaryChannelConfigurationSnapshot;
  primaryCredentialPaths?: PrimaryChannelCredentialPaths;
  environment?: NodeJS.ProcessEnv;
  primaryRuntimeActive?: boolean;
  primaryTelegramRuntimeToken?: string | null;
}

interface WhatsAppVerificationState {
  status: WhatsAppSessionVerificationStatus;
  checkedAt: number | null;
  errorCode: string | null;
}

interface WhatsAppVerificationOperation {
  id: number;
  controller: AbortController;
  timer: NodeJS.Timeout;
  task: Promise<void>;
  timedOut: boolean;
}

interface PrimaryTelegramEnvironmentObservation {
  token: string | null;
  declared: boolean;
  migratable: boolean;
  errorCode: string | null;
}

export class ChannelSetupError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Mengelola credential khusus live acceptance. Snapshot tidak pernah membawa
 * token, session, nomor, JID, atau payload QR; QR hanya tersedia sebagai SVG
 * sementara melalui endpoint Console yang sudah terautentikasi.
 */
export class ChannelSetupService {
  private readonly paths: LiveAcceptancePaths;
  private readonly telegram: TelegramPairingAdapter;
  private readonly whatsapp: WhatsAppPairingAdapter;
  private readonly timeoutMs: number;
  private readonly whatsappVerificationTimeoutMs: number;
  private readonly whatsappVerificationTtlMs: number;
  private readonly now: () => number;
  private readonly primaryChannels: PrimaryChannelConfigurationSnapshot;
  private readonly primaryCredentialPaths: PrimaryChannelCredentialPaths;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly primaryRuntimeActive: boolean;
  private readonly primaryTelegramRuntimeFingerprint: string | null;
  private readonly telegramState = emptyPairingState();
  private readonly whatsappState: Record<WhatsAppTestRole, PairingState> = {
    harvy: emptyPairingState(),
    tester: emptyPairingState(),
  };
  private readonly whatsappVerificationState: Record<
    WhatsAppTestRole,
    WhatsAppVerificationState
  > = {
    harvy: emptyWhatsAppVerificationState(),
    tester: emptyWhatsAppVerificationState(),
  };
  private telegramOperation: ActiveOperation | null = null;
  private botValidation: AbortController | null = null;
  private botValidationTask: Promise<void> | null = null;
  private primaryBotValidation: AbortController | null = null;
  private primaryBotValidationTask: Promise<void> | null = null;
  private credentialQueue: Promise<unknown> = Promise.resolve();
  private lock: LocalRuntimeLock | null = null;
  private initialization: Promise<void> | null = null;
  private readonly whatsappOperations = new Map<WhatsAppTestRole, ActiveOperation>();
  private readonly whatsappVerificationOperations = new Map<
    WhatsAppTestRole,
    WhatsAppVerificationOperation
  >();
  private botPhase: "idle" | "validating" | "error" = "idle";
  private botErrorCode: string | null = null;
  private primaryBotPhase: "idle" | "validating" | "ready" | "error" = "idle";
  private primaryBotErrorCode: string | null = null;
  private primaryBotCheckedFingerprint: string | null = null;
  private sequence = 0;
  private closed = false;

  constructor(options: ChannelSetupServiceOptions = {}) {
    this.paths = options.paths ?? liveAcceptancePaths();
    this.telegram = options.telegramAdapter ?? new LiveTelegramPairingAdapter();
    this.whatsapp = options.whatsappAdapter ?? new LiveWhatsAppPairingAdapter();
    this.timeoutMs = options.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS;
    this.whatsappVerificationTimeoutMs =
      options.whatsappVerificationTimeoutMs ??
      DEFAULT_WHATSAPP_VERIFICATION_TIMEOUT_MS;
    this.whatsappVerificationTtlMs = options.whatsappVerificationTtlMs ??
      DEFAULT_WHATSAPP_VERIFICATION_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.primaryChannels = options.primaryChannels ??
      primaryChannelConfigurationFromEnvironment();
    this.primaryCredentialPaths = options.primaryCredentialPaths ??
      primaryChannelCredentialPaths();
    this.environment = options.environment ?? process.env;
    this.primaryRuntimeActive = options.primaryRuntimeActive ?? false;
    this.primaryTelegramRuntimeFingerprint =
      options.primaryTelegramRuntimeToken?.trim()
        ? credentialFingerprint(options.primaryTelegramRuntimeToken)
        : null;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1_000) {
      throw new Error("Timeout pairing minimal 1000 ms.");
    }
    if (
      !Number.isFinite(this.whatsappVerificationTimeoutMs) ||
      this.whatsappVerificationTimeoutMs < 1_000
    ) {
      throw new Error("Timeout pemeriksaan WhatsApp minimal 1000 ms.");
    }
    if (
      !Number.isFinite(this.whatsappVerificationTtlMs) ||
      this.whatsappVerificationTtlMs < this.whatsappVerificationTimeoutMs
    ) {
      throw new Error(
        "Masa berlaku pemeriksaan WhatsApp harus melampaui timeout pemeriksaan.",
      );
    }
  }

  async initialize(): Promise<void> {
    if (this.lock) return;
    if (this.closed) {
      throw new ChannelSetupError(
        "CHANNEL_SETUP_CLOSED",
        503,
        "Pengelola kanal sudah ditutup.",
      );
    }
    const pending = this.initialization ??= (async () => {
      const lock = await acquireLocalRuntimeLock(this.paths.setupLockFile, "setup");
      if (this.closed) {
        await lock.release();
        throw new ChannelSetupError(
          "CHANNEL_SETUP_CLOSED",
          503,
          "Pengelola kanal sudah ditutup.",
        );
      }
      this.lock = lock;
    })();
    try {
      await pending;
    } finally {
      if (this.initialization === pending) this.initialization = null;
    }
  }

  async snapshot(): Promise<ChannelSetupSnapshot> {
    this.assertReady();
    const [
      [bot, tester],
      whatsappHarvy,
      whatsappTester,
      primaryTelegramCredential,
      primaryTelegramEnvironment,
    ] = await Promise.all([
      this.withCredentialAccess(() => Promise.all([
        loadTelegramBotCredential(this.paths),
        loadTelegramTesterCredential(this.paths),
      ])),
      this.whatsapp.configured(this.paths.whatsappHarvyAuth),
      this.whatsapp.configured(this.paths.whatsappTesterAuth),
      loadPrimaryTelegramBotCredential(this.primaryCredentialPaths),
      this.observePrimaryTelegramEnvironment(),
    ]);
    const botConfigured = bot !== null;
    const testerConfigured = tester !== null;
    const now = this.now();
    this.reconcileWhatsAppVerification("harvy", whatsappHarvy);
    this.reconcileWhatsAppVerification("tester", whatsappTester);
    this.maybeVerifyWhatsApp("harvy", whatsappHarvy, now);
    this.maybeVerifyWhatsApp("tester", whatsappTester, now);
    const whatsappHarvySnapshot = publicWhatsAppPairingState(
      this.whatsappState.harvy,
      this.whatsappVerificationState.harvy,
      whatsappHarvy,
      now,
    );
    const whatsappTesterSnapshot = publicWhatsAppPairingState(
      this.whatsappState.tester,
      this.whatsappVerificationState.tester,
      whatsappTester,
      now,
    );
    const primaryTelegram = this.primaryTelegramSnapshot(
      primaryTelegramCredential?.botToken ?? null,
      primaryTelegramEnvironment,
    );
    return {
      identityBoundary: {
        mode: "isolated_acceptance",
        primary: {
          ...this.primaryChannels,
          telegram: primaryTelegram,
        },
      },
      telegram: {
        ready: botConfigured && testerConfigured,
        bot: {
          configured: botConfigured,
          phase: this.botPhase === "validating"
            ? "validating"
            : this.botPhase === "error"
              ? "error"
              : botConfigured ? "ready" : "missing",
          errorCode: this.botErrorCode,
        },
        tester: publicPairingState(this.telegramState, testerConfigured, now),
      },
      whatsapp: {
        ready:
          whatsappPairingReady(whatsappHarvySnapshot) &&
          whatsappPairingReady(whatsappTesterSnapshot),
        harvy: whatsappHarvySnapshot,
        tester: whatsappTesterSnapshot,
      },
    };
  }

  /**
   * Memulai handshake baru untuk semua credential WhatsApp acceptance yang
   * tersimpan. Method ini tidak menunggu jaringan selesai; snapshot berikutnya
   * akan bergerak dari checking ke accepted/rejected/unreachable.
   */
  async verifyWhatsAppSessions(): Promise<void> {
    this.assertReady();
    if (this.whatsappOperations.size > 0) {
      throw conflict(
        "CHANNEL_WHATSAPP_OPERATION_ACTIVE",
        "Selesaikan operasi WhatsApp sebelum memeriksa koneksi.",
      );
    }
    const [harvyConfigured, testerConfigured] = await Promise.all([
      this.whatsapp.configured(this.paths.whatsappHarvyAuth),
      this.whatsapp.configured(this.paths.whatsappTesterAuth),
    ]);
    this.reconcileWhatsAppVerification("harvy", harvyConfigured);
    this.reconcileWhatsAppVerification("tester", testerConfigured);
    if (harvyConfigured) this.startWhatsAppVerification("harvy", true);
    if (testerConfigured) this.startWhatsAppVerification("tester", true);
  }

  async setPrimaryTelegramBotToken(value: string): Promise<void> {
    this.assertReady();
    this.assertPrimaryTelegramIdle();
    const environment = await this.observePrimaryTelegramEnvironment();
    if (environment.declared) {
      throw conflict(
        "PRIMARY_TELEGRAM_ENVIRONMENT_PRESENT",
        "Pindahkan token environment ke Console sebelum menggantinya.",
      );
    }
    let token: string;
    try {
      token = primaryTelegramBotToken(value);
    } catch {
      throw rejected(
        "PRIMARY_TELEGRAM_BOT_TOKEN_INVALID",
        "Format token bot Telegram utama tidak sah.",
      );
    }
    await this.assertPrimaryTelegramDistinctFromAcceptance(token);
    await this.validatePrimaryTelegramBotToken(token);
    try {
      await savePrimaryTelegramBotCredential(
        { version: 1, botToken: token },
        this.primaryCredentialPaths,
      );
      this.primaryBotPhase = "ready";
      this.primaryBotErrorCode = null;
      this.primaryBotCheckedFingerprint = credentialFingerprint(token);
    } catch (error) {
      this.primaryBotPhase = "error";
      this.primaryBotErrorCode = safeOperationCode(
        error,
        "PRIMARY_TELEGRAM_CREDENTIAL_WRITE_FAILED",
      );
      throw serviceFailure(
        this.primaryBotErrorCode,
        "Token utama sudah valid tetapi belum dapat disimpan.",
      );
    }
  }

  async migratePrimaryTelegramBotToken(): Promise<void> {
    this.assertReady();
    this.assertPrimaryTelegramIdle();
    const environment = await this.observePrimaryTelegramEnvironment();
    if (!environment.token || !environment.migratable) {
      throw rejected(
        "PRIMARY_TELEGRAM_ENVIRONMENT_NOT_MIGRATABLE",
        "Token environment tidak dapat dipindahkan otomatis.",
      );
    }
    await this.assertPrimaryTelegramDistinctFromAcceptance(environment.token);
    await this.validatePrimaryTelegramBotToken(environment.token);
    try {
      await migratePrimaryTelegramBotCredentialFromEnvironment({
        environment: this.environment,
        paths: this.primaryCredentialPaths,
      });
      this.primaryBotPhase = "ready";
      this.primaryBotErrorCode = null;
      this.primaryBotCheckedFingerprint = credentialFingerprint(
        environment.token,
      );
    } catch (error) {
      this.primaryBotPhase = "error";
      this.primaryBotErrorCode = safeOperationCode(
        error,
        "PRIMARY_TELEGRAM_MIGRATION_FAILED",
      );
      throw serviceFailure(
        this.primaryBotErrorCode,
        "Token Telegram utama belum berhasil dipindahkan.",
      );
    }
  }

  async verifyPrimaryTelegramBotToken(): Promise<void> {
    this.assertReady();
    this.assertPrimaryTelegramIdle();
    const credential = await loadPrimaryTelegramBotCredential(
      this.primaryCredentialPaths,
    );
    const environment = await this.observePrimaryTelegramEnvironment();
    const token = this.effectivePrimaryTelegramToken(
      credential?.botToken ?? null,
      environment,
    );
    if (!token) {
      throw rejected(
        "PRIMARY_TELEGRAM_CREDENTIAL_MISSING",
        "Token Telegram utama belum tersedia.",
      );
    }
    await this.assertPrimaryTelegramDistinctFromAcceptance(token);
    await this.validatePrimaryTelegramBotToken(token);
  }

  async deletePrimaryTelegramBotToken(): Promise<void> {
    this.assertReady();
    this.assertPrimaryTelegramIdle();
    const environment = await this.observePrimaryTelegramEnvironment();
    if (environment.declared) {
      throw conflict(
        "PRIMARY_TELEGRAM_ENVIRONMENT_PRESENT",
        "Token environment harus dipindahkan atau dihapus lebih dulu.",
      );
    }
    await deletePrimaryTelegramBotCredential(this.primaryCredentialPaths);
    this.primaryBotPhase = "idle";
    this.primaryBotErrorCode = null;
    this.primaryBotCheckedFingerprint = null;
  }

  async setTelegramBotToken(value: string): Promise<void> {
    this.assertReady();
    if (this.botPhase === "validating") {
      throw conflict("CHANNEL_TELEGRAM_BOT_VALIDATION_ACTIVE", "Validasi token bot masih berjalan.");
    }
    const token = value.trim();
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) {
      throw rejected("CHANNEL_TELEGRAM_BOT_TOKEN_INVALID", "Format token bot Telegram tidak sah.");
    }
    await this.assertAcceptanceTelegramDistinctFromPrimary(token);
    this.botPhase = "validating";
    this.botErrorCode = null;
    const controller = new AbortController();
    this.botValidation = controller;
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(this.timeoutMs, 12_000),
    );
    timer.unref();
    const task = (async () => {
      try {
        await this.telegram.validateBotToken(token, controller.signal);
        assertNotAborted(controller.signal);
        await this.withCredentialAccess(async () => {
          assertNotAborted(controller.signal);
          await saveTelegramBotCredential({ version: 1, botToken: token }, this.paths);
        });
        this.botPhase = "idle";
      } catch (error) {
        this.botPhase = "error";
        this.botErrorCode = safeOperationCode(error, "CHANNEL_TELEGRAM_BOT_TOKEN_REJECTED");
        throw serviceFailure(this.botErrorCode, "Token bot ditolak atau tidak dapat diverifikasi.");
      } finally {
        clearTimeout(timer);
        if (this.botValidation === controller) this.botValidation = null;
      }
    })();
    this.botValidationTask = task;
    try {
      await task;
    } finally {
      if (this.botValidationTask === task) this.botValidationTask = null;
    }
  }

  async deleteTelegramBotToken(): Promise<void> {
    this.assertReady();
    if (this.botPhase === "validating") {
      throw conflict("CHANNEL_TELEGRAM_BOT_VALIDATION_ACTIVE", "Validasi token bot masih berjalan.");
    }
    await this.withCredentialAccess(() => deleteTelegramBotCredential(this.paths));
    this.botPhase = "idle";
    this.botErrorCode = null;
  }

  startTelegramTester(input: { apiId: number; apiHash: string }): void {
    this.assertReady();
    if (this.telegramOperation) {
      throw conflict("CHANNEL_TELEGRAM_PAIRING_ACTIVE", "Pairing Telegram masih berjalan.");
    }
    const apiId = telegramApiId(input.apiId);
    const apiHash = telegramApiHash(input.apiHash);
    const operation = this.createOperation();
    this.telegramOperation = operation;
    setPairingState(this.telegramState, "connecting");
    operation.task = this.runTelegramPairing(operation, apiId, apiHash);
  }

  submitTelegramPassword(value: string): void {
    this.assertReady();
    const operation = this.telegramOperation;
    const password = value;
    if (!operation?.passwordWaiter || this.telegramState.phase !== "awaiting_password") {
      throw conflict("CHANNEL_TELEGRAM_PASSWORD_NOT_REQUESTED", "Telegram tidak sedang meminta password dua langkah.");
    }
    if (password.length < 1 || password.length > 256 || /\p{Cc}/u.test(password)) {
      throw rejected("CHANNEL_TELEGRAM_PASSWORD_INVALID", "Password dua langkah tidak sah.");
    }
    const waiter = operation.passwordWaiter;
    operation.passwordWaiter = null;
    setPairingState(this.telegramState, "connecting");
    waiter.resolve(password);
  }

  async cancelTelegramTester(): Promise<void> {
    this.assertReady();
    const operation = this.telegramOperation;
    if (!operation) {
      setPairingState(this.telegramState, "idle");
      return;
    }
    operation.cancelled = true;
    clearQr(this.telegramState);
    operation.passwordWaiter?.reject(aborted());
    operation.passwordWaiter = null;
    operation.controller.abort();
    const settled = await settleCancellation(operation.task);
    if (!settled && this.currentTelegram(operation)) {
      setPairingError(this.telegramState, "CHANNEL_TELEGRAM_CANCEL_PENDING");
    }
  }

  startTelegramTesterRevoke(): void {
    this.assertReady();
    if (this.telegramOperation) {
      throw conflict("CHANNEL_TELEGRAM_PAIRING_ACTIVE", "Operasi Telegram masih berjalan.");
    }
    const operation = this.createOperation();
    this.telegramOperation = operation;
    setPairingState(this.telegramState, "revoking");
    operation.task = this.runTelegramRevoke(operation);
  }

  startWhatsApp(role: WhatsAppTestRole): void {
    this.assertReady();
    if (this.whatsappOperations.size > 0) {
      throw conflict("CHANNEL_WHATSAPP_OPERATION_ACTIVE", "Selesaikan satu operasi WhatsApp sebelum memulai role lain.");
    }
    this.assertNoWhatsAppVerification();
    const operation = this.createOperation();
    this.whatsappOperations.set(role, operation);
    setPairingState(this.whatsappState[role], "connecting");
    operation.task = this.runWhatsAppPairing(role, operation);
  }

  startWhatsAppRevoke(role: WhatsAppTestRole): void {
    this.assertReady();
    if (this.whatsappOperations.size > 0) {
      throw conflict("CHANNEL_WHATSAPP_OPERATION_ACTIVE", "Selesaikan satu operasi WhatsApp sebelum mencabut role lain.");
    }
    this.assertNoWhatsAppVerification();
    const operation = this.createOperation();
    this.whatsappOperations.set(role, operation);
    setPairingState(this.whatsappState[role], "revoking");
    operation.task = this.runWhatsAppRevoke(role, operation);
  }

  startWhatsAppReplace(role: WhatsAppTestRole): void {
    this.assertReady();
    if (this.whatsappOperations.size > 0) {
      throw conflict("CHANNEL_WHATSAPP_OPERATION_ACTIVE", "Selesaikan satu operasi WhatsApp sebelum mengganti sesi.");
    }
    this.assertNoWhatsAppVerification();
    const operation = this.createOperation();
    this.whatsappOperations.set(role, operation);
    setPairingState(this.whatsappState[role], "revoking");
    operation.task = this.runWhatsAppReplace(role, operation);
  }

  async cancelWhatsApp(role: WhatsAppTestRole): Promise<void> {
    this.assertReady();
    const operation = this.whatsappOperations.get(role);
    if (!operation) {
      setPairingState(this.whatsappState[role], "idle");
      return;
    }
    operation.cancelled = true;
    clearQr(this.whatsappState[role]);
    operation.controller.abort();
    const settled = await settleCancellation(operation.task);
    if (!settled && this.currentWhatsApp(role, operation)) {
      setPairingError(this.whatsappState[role], "CHANNEL_WHATSAPP_CANCEL_PENDING");
    }
  }

  qrSvg(channel: "telegram" | "whatsapp", role?: WhatsAppTestRole): string {
    this.assertReady();
    const state = channel === "telegram"
      ? this.telegramState
      : this.whatsappState[requiredRole(role)];
    if (
      !state.qr ||
      !state.qrExpiresAt ||
      state.qrExpiresAt <= this.now()
    ) {
      throw new ChannelSetupError(
        "CHANNEL_PAIRING_QR_UNAVAILABLE",
        404,
        "QR tidak tersedia atau sudah kedaluwarsa.",
      );
    }
    return renderQrSvg(state.qr);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.botValidation?.abort();
    this.primaryBotValidation?.abort();
    const tasks: Promise<void>[] = [];
    if (this.botValidationTask) tasks.push(this.botValidationTask);
    if (this.primaryBotValidationTask) tasks.push(this.primaryBotValidationTask);
    if (this.telegramOperation) {
      this.telegramOperation.cancelled = true;
      this.telegramOperation.passwordWaiter?.reject(aborted());
      this.telegramOperation.controller.abort();
      tasks.push(this.telegramOperation.task);
    }
    for (const operation of this.whatsappOperations.values()) {
      operation.cancelled = true;
      operation.controller.abort();
      tasks.push(operation.task);
    }
    for (const operation of this.whatsappVerificationOperations.values()) {
      operation.controller.abort();
      tasks.push(operation.task);
    }
    await Promise.allSettled(tasks);
    await this.credentialQueue.catch(() => undefined);
    await this.initialization?.catch(() => undefined);
    const lock = this.lock;
    this.lock = null;
    await lock?.release();
  }

  private async observePrimaryTelegramEnvironment(): Promise<
    PrimaryTelegramEnvironmentObservation
  > {
    const raw = this.environment.TELEGRAM_BOT_TOKEN;
    try {
      const status = await primaryTelegramEnvironmentStatus(
        this.environment,
        this.primaryCredentialPaths,
      );
      return {
        token: raw?.trim() ? primaryTelegramBotToken(raw) : null,
        declared: status.declared,
        migratable: status.migratable,
        errorCode: status.entryCount > 1
          ? "PRIMARY_TELEGRAM_ENVIRONMENT_AMBIGUOUS"
          : null,
      };
    } catch (error) {
      return {
        token: null,
        declared: Boolean(raw?.trim()),
        migratable: false,
        errorCode: safeOperationCode(
          error,
          "PRIMARY_TELEGRAM_ENVIRONMENT_INVALID",
        ),
      };
    }
  }

  private primaryTelegramSnapshot(
    managedToken: string | null,
    environment: PrimaryTelegramEnvironmentObservation,
  ): PrimaryChannelConfigurationSnapshot["telegram"] {
    const sourceConflict = Boolean(
      managedToken && environment.token && managedToken !== environment.token,
    );
    const source = sourceConflict || environment.errorCode
      ? "conflict" as const
      : managedToken
        ? "console" as const
        : environment.token
          ? "environment" as const
          : "missing" as const;
    const token = source === "console"
      ? managedToken
      : source === "environment"
        ? environment.token
        : null;
    const fingerprint = token ? credentialFingerprint(token) : null;
    if (
      this.primaryBotPhase !== "validating" &&
      this.primaryBotCheckedFingerprint !== fingerprint
    ) {
      this.primaryBotPhase = "idle";
      this.primaryBotErrorCode = null;
      this.primaryBotCheckedFingerprint = null;
    }
    const configured = token !== null;
    const phase = source === "conflict"
      ? "error" as const
      : !configured
        ? "missing" as const
        : this.primaryBotPhase === "validating"
          ? "validating" as const
          : this.primaryBotPhase === "ready" &&
              this.primaryBotCheckedFingerprint === fingerprint
            ? "ready" as const
            : this.primaryBotPhase === "error" &&
                this.primaryBotCheckedFingerprint === fingerprint
              ? "error" as const
              : "unchecked" as const;
    return {
      declared: configured,
      configured,
      source,
      legacyEnvironment: environment.declared,
      migrationAvailable: source === "environment" && environment.migratable,
      runtimeActive: this.primaryRuntimeActive,
      restartRequired: this.primaryRuntimeActive &&
        this.primaryTelegramRuntimeFingerprint !== fingerprint,
      phase,
      errorCode: sourceConflict
        ? "PRIMARY_TELEGRAM_CREDENTIAL_SOURCE_CONFLICT"
        : environment.errorCode ?? this.primaryBotErrorCode,
    };
  }

  private effectivePrimaryTelegramToken(
    managedToken: string | null,
    environment: PrimaryTelegramEnvironmentObservation,
  ): string | null {
    if (environment.errorCode) {
      throw conflict(
        environment.errorCode,
        "Konfigurasi environment Telegram utama tidak sah.",
      );
    }
    if (
      managedToken && environment.token && managedToken !== environment.token
    ) {
      throw conflict(
        "PRIMARY_TELEGRAM_CREDENTIAL_SOURCE_CONFLICT",
        "Credential Console dan environment berbeda.",
      );
    }
    return managedToken ?? environment.token;
  }

  private assertPrimaryTelegramIdle(): void {
    if (this.primaryBotValidation) {
      throw conflict(
        "PRIMARY_TELEGRAM_VALIDATION_ACTIVE",
        "Pemeriksaan bot Telegram utama masih berjalan.",
      );
    }
  }

  private async validatePrimaryTelegramBotToken(token: string): Promise<void> {
    const controller = new AbortController();
    const fingerprint = credentialFingerprint(token);
    this.primaryBotValidation = controller;
    this.primaryBotPhase = "validating";
    this.primaryBotErrorCode = null;
    this.primaryBotCheckedFingerprint = fingerprint;
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(this.timeoutMs, 12_000),
    );
    timer.unref();
    const task = (async () => {
      try {
        await this.telegram.validateBotToken(token, controller.signal);
        assertNotAborted(controller.signal);
        this.primaryBotPhase = "ready";
      } catch (error) {
        this.primaryBotPhase = "error";
        this.primaryBotErrorCode = safeOperationCode(
          error,
          controller.signal.aborted
            ? "PRIMARY_TELEGRAM_VALIDATION_TIMEOUT"
            : "PRIMARY_TELEGRAM_BOT_TOKEN_REJECTED",
        );
        throw serviceFailure(
          this.primaryBotErrorCode,
          "Bot Telegram utama ditolak atau tidak dapat diverifikasi.",
        );
      } finally {
        clearTimeout(timer);
        if (this.primaryBotValidation === controller) {
          this.primaryBotValidation = null;
        }
      }
    })();
    this.primaryBotValidationTask = task;
    try {
      await task;
    } finally {
      if (this.primaryBotValidationTask === task) {
        this.primaryBotValidationTask = null;
      }
    }
  }

  private async assertPrimaryTelegramDistinctFromAcceptance(
    token: string,
  ): Promise<void> {
    const acceptance = await loadTelegramBotCredential(this.paths);
    if (acceptance?.botToken === token) {
      throw rejected(
        "PRIMARY_TELEGRAM_BOT_MUST_DIFFER_FROM_ACCEPTANCE",
        "Bot Telegram utama harus berbeda dari bot acceptance.",
      );
    }
  }

  private async assertAcceptanceTelegramDistinctFromPrimary(
    token: string,
  ): Promise<void> {
    const managed = await loadPrimaryTelegramBotCredential(
      this.primaryCredentialPaths,
    );
    const environment = await this.observePrimaryTelegramEnvironment();
    const primary = this.effectivePrimaryTelegramToken(
      managed?.botToken ?? null,
      environment,
    );
    if (primary === token) {
      throw rejected(
        "CHANNEL_TELEGRAM_BOT_MUST_DIFFER_FROM_PRIMARY",
        "Bot acceptance harus berbeda dari bot Telegram utama.",
      );
    }
  }

  private createOperation(): ActiveOperation {
    const controller = new AbortController();
    const operation: ActiveOperation = {
      id: ++this.sequence,
      controller,
      timer: setTimeout(() => undefined, this.timeoutMs),
      task: Promise.resolve(),
      cancelled: false,
      timedOut: false,
      passwordWaiter: null,
    };
    clearTimeout(operation.timer);
    operation.timer = setTimeout(() => {
      operation.timedOut = true;
      operation.controller.abort();
    }, this.timeoutMs);
    operation.timer.unref();
    return operation;
  }

  private assertNoWhatsAppVerification(): void {
    if (this.whatsappVerificationOperations.size > 0) {
      throw conflict(
        "CHANNEL_WHATSAPP_VERIFICATION_ACTIVE",
        "Tunggu pemeriksaan koneksi WhatsApp selesai.",
      );
    }
  }

  private reconcileWhatsAppVerification(
    role: WhatsAppTestRole,
    configured: boolean,
  ): void {
    const state = this.whatsappVerificationState[role];
    if (!configured) {
      if (!this.whatsappVerificationOperations.has(role)) {
        resetWhatsAppVerificationState(state);
      }
      return;
    }
    if (state.status === "missing") {
      state.status = "unchecked";
      state.checkedAt = null;
      state.errorCode = null;
    }
  }

  private maybeVerifyWhatsApp(
    role: WhatsAppTestRole,
    configured: boolean,
    now: number,
  ): void {
    if (
      !configured ||
      this.whatsappOperations.size > 0 ||
      this.whatsappVerificationOperations.has(role) ||
      this.whatsappState[role].phase === "error"
    ) return;
    const verification = this.whatsappVerificationState[role];
    const stale = verification.checkedAt !== null &&
      now - verification.checkedAt >= this.whatsappVerificationTtlMs;
    if (verification.status === "unchecked" || stale) {
      this.startWhatsAppVerification(role, false);
    }
  }

  private startWhatsAppVerification(
    role: WhatsAppTestRole,
    force: boolean,
  ): void {
    if (this.whatsappVerificationOperations.has(role)) return;
    if (this.whatsappOperations.size > 0) {
      if (force) {
        throw conflict(
          "CHANNEL_WHATSAPP_OPERATION_ACTIVE",
          "Selesaikan operasi WhatsApp sebelum memeriksa koneksi.",
        );
      }
      return;
    }
    const controller = new AbortController();
    const operation: WhatsAppVerificationOperation = {
      id: ++this.sequence,
      controller,
      timer: setTimeout(() => undefined, this.whatsappVerificationTimeoutMs),
      task: Promise.resolve(),
      timedOut: false,
    };
    clearTimeout(operation.timer);
    operation.timer = setTimeout(() => {
      operation.timedOut = true;
      controller.abort();
    }, this.whatsappVerificationTimeoutMs);
    operation.timer.unref();
    this.whatsappVerificationOperations.set(role, operation);
    const state = this.whatsappVerificationState[role];
    state.status = "checking";
    state.errorCode = null;
    operation.task = this.runWhatsAppVerification(role, operation);
  }

  private async runWhatsAppVerification(
    role: WhatsAppTestRole,
    operation: WhatsAppVerificationOperation,
  ): Promise<void> {
    try {
      const status = await this.whatsapp.probe({
        authFolder: whatsappAuthFolder(role, this.paths),
        signal: operation.controller.signal,
      });
      if (!this.currentWhatsAppVerification(role, operation)) return;
      setWhatsAppVerificationResult(
        this.whatsappVerificationState[role],
        status,
        this.now(),
        status === "rejected" ? "CHANNEL_WHATSAPP_SESSION_REJECTED" : null,
      );
    } catch (error) {
      if (!this.currentWhatsAppVerification(role, operation)) return;
      if (this.closed && operation.controller.signal.aborted) return;
      const code = operation.timedOut
        ? "CHANNEL_WHATSAPP_VERIFICATION_TIMEOUT"
        : safeOperationCode(error, "CHANNEL_WHATSAPP_VERIFICATION_UNAVAILABLE");
      setWhatsAppVerificationResult(
        this.whatsappVerificationState[role],
        isWhatsAppSessionRejection(code) ? "rejected" : "unreachable",
        this.now(),
        code,
      );
    } finally {
      clearTimeout(operation.timer);
      if (this.currentWhatsAppVerification(role, operation)) {
        this.whatsappVerificationOperations.delete(role);
      }
    }
  }

  private currentWhatsAppVerification(
    role: WhatsAppTestRole,
    operation: WhatsAppVerificationOperation,
  ): boolean {
    return this.whatsappVerificationOperations.get(role)?.id === operation.id;
  }

  private async runTelegramPairing(
    operation: ActiveOperation,
    apiId: number,
    apiHash: string,
  ): Promise<void> {
    try {
      const session = await this.telegram.pairTester({
        apiId,
        apiHash,
        signal: operation.controller.signal,
        onQr: (value, expiresAt) => {
          if (
            !this.currentTelegram(operation) ||
            operation.cancelled ||
            operation.controller.signal.aborted
          ) return;
          setQr(this.telegramState, value, expiresAt);
        },
        requestPassword: () => this.waitForTelegramPassword(operation),
      });
      if (!this.currentTelegram(operation)) return;
      if (operation.cancelled) {
        setPairingState(this.telegramState, "idle");
        return;
      }
      await this.withCredentialAccess(async () => {
        if (
          !this.currentTelegram(operation) ||
          operation.cancelled ||
          operation.controller.signal.aborted
        ) throw aborted();
        await saveTelegramTesterCredential({
          version: 1,
          apiId,
          apiHash,
          session,
        }, this.paths);
      });
      if (!this.currentTelegram(operation)) return;
      if (operation.cancelled) {
        setPairingState(this.telegramState, "idle");
        return;
      }
      setPairingState(this.telegramState, "paired");
    } catch (error) {
      if (!this.currentTelegram(operation)) return;
      if (operation.cancelled) setPairingState(this.telegramState, "idle");
      else setPairingError(
        this.telegramState,
        operation.timedOut
          ? "CHANNEL_TELEGRAM_PAIRING_TIMEOUT"
          : safeOperationCode(error, "CHANNEL_TELEGRAM_PAIRING_FAILED"),
      );
    } finally {
      clearTimeout(operation.timer);
      operation.passwordWaiter?.reject(aborted());
      operation.passwordWaiter = null;
      if (this.currentTelegram(operation)) this.telegramOperation = null;
    }
  }

  private async runTelegramRevoke(operation: ActiveOperation): Promise<void> {
    try {
      const credential = await this.withCredentialAccess(() =>
        loadTelegramTesterCredential(this.paths)
      );
      if (credential) {
        await this.telegram.revokeTester({
          ...credential,
          signal: operation.controller.signal,
        });
      }
      if (!this.currentTelegram(operation)) return;
      if (operation.cancelled) {
        setPairingState(this.telegramState, "idle");
        return;
      }
      await this.withCredentialAccess(() =>
        deleteTelegramTesterCredential(this.paths)
      );
      setPairingState(this.telegramState, "idle");
    } catch (error) {
      if (!this.currentTelegram(operation)) return;
      if (operation.cancelled) setPairingState(this.telegramState, "idle");
      else setPairingError(
        this.telegramState,
        operation.timedOut
          ? "CHANNEL_TELEGRAM_REVOKE_TIMEOUT"
          : safeOperationCode(error, "CHANNEL_TELEGRAM_REVOKE_FAILED"),
      );
    } finally {
      clearTimeout(operation.timer);
      if (this.currentTelegram(operation)) this.telegramOperation = null;
    }
  }

  private waitForTelegramPassword(operation: ActiveOperation): Promise<string> {
    if (!this.currentTelegram(operation) || operation.controller.signal.aborted) {
      return Promise.reject(aborted());
    }
    if (operation.passwordWaiter) {
      return Promise.reject(blocked("CHANNEL_TELEGRAM_PASSWORD_REQUEST_OVERLAP"));
    }
    setPairingState(this.telegramState, "awaiting_password");
    return new Promise<string>((resolvePassword, rejectPassword) => {
      operation.passwordWaiter = {
        resolve: resolvePassword,
        reject: rejectPassword,
      };
    });
  }

  private async runWhatsAppPairing(
    role: WhatsAppTestRole,
    operation: ActiveOperation,
  ): Promise<void> {
    try {
      await this.pairWhatsApp(role, operation);
    } catch (error) {
      if (!this.currentWhatsApp(role, operation)) return;
      if (operation.cancelled) setPairingState(this.whatsappState[role], "idle");
      else setPairingError(
        this.whatsappState[role],
        operation.timedOut
          ? "CHANNEL_WHATSAPP_PAIRING_TIMEOUT"
          : safeOperationCode(error, "CHANNEL_WHATSAPP_PAIRING_FAILED"),
      );
    } finally {
      clearTimeout(operation.timer);
      if (this.currentWhatsApp(role, operation)) this.whatsappOperations.delete(role);
    }
  }

  private async runWhatsAppReplace(
    role: WhatsAppTestRole,
    operation: ActiveOperation,
  ): Promise<void> {
    const authFolder = whatsappAuthFolder(role, this.paths);
    try {
      await this.whatsapp.revoke({
        authFolder,
        authRoot: this.paths.whatsappAuthRoot,
        signal: operation.controller.signal,
      });
      if (!this.currentWhatsApp(role, operation)) return;
      if (operation.cancelled) {
        setPairingState(this.whatsappState[role], "idle");
        return;
      }
      setPairingState(this.whatsappState[role], "connecting");
      await this.pairWhatsApp(role, operation);
    } catch (error) {
      if (!this.currentWhatsApp(role, operation)) return;
      if (operation.cancelled) setPairingState(this.whatsappState[role], "idle");
      else setPairingError(
        this.whatsappState[role],
        operation.timedOut
          ? "CHANNEL_WHATSAPP_REPLACE_TIMEOUT"
          : safeOperationCode(error, "CHANNEL_WHATSAPP_REPLACE_FAILED"),
      );
    } finally {
      clearTimeout(operation.timer);
      if (this.currentWhatsApp(role, operation)) this.whatsappOperations.delete(role);
    }
  }

  private async pairWhatsApp(
    role: WhatsAppTestRole,
    operation: ActiveOperation,
  ): Promise<void> {
    const folders = whatsappFolders(role, this.paths);
    await this.whatsapp.pair({
      ...folders,
      signal: operation.controller.signal,
      onQr: (value) => {
        if (
          !this.currentWhatsApp(role, operation) ||
          operation.cancelled ||
          operation.controller.signal.aborted
        ) return;
        setQr(this.whatsappState[role], value, this.now() + this.timeoutMs);
      },
    });
    if (!this.currentWhatsApp(role, operation)) return;
    if (operation.cancelled) {
      setPairingState(this.whatsappState[role], "idle");
      return;
    }
    setPairingState(this.whatsappState[role], "paired");
    setWhatsAppVerificationResult(
      this.whatsappVerificationState[role],
      "accepted",
      this.now(),
      null,
    );
  }

  private async runWhatsAppRevoke(
    role: WhatsAppTestRole,
    operation: ActiveOperation,
  ): Promise<void> {
    const authFolder = whatsappAuthFolder(role, this.paths);
    try {
      await this.whatsapp.revoke({
        authFolder,
        authRoot: this.paths.whatsappAuthRoot,
        signal: operation.controller.signal,
      });
      if (!this.currentWhatsApp(role, operation)) return;
      if (operation.cancelled) {
        setPairingState(this.whatsappState[role], "idle");
        return;
      }
      setPairingState(this.whatsappState[role], "idle");
      resetWhatsAppVerificationState(this.whatsappVerificationState[role]);
    } catch (error) {
      if (!this.currentWhatsApp(role, operation)) return;
      if (operation.cancelled) setPairingState(this.whatsappState[role], "idle");
      else setPairingError(
        this.whatsappState[role],
        operation.timedOut
          ? "CHANNEL_WHATSAPP_REVOKE_TIMEOUT"
          : safeOperationCode(error, "CHANNEL_WHATSAPP_REVOKE_FAILED"),
      );
    } finally {
      clearTimeout(operation.timer);
      if (this.currentWhatsApp(role, operation)) this.whatsappOperations.delete(role);
    }
  }

  private currentTelegram(operation: ActiveOperation): boolean {
    return this.telegramOperation?.id === operation.id;
  }

  private currentWhatsApp(
    role: WhatsAppTestRole,
    operation: ActiveOperation,
  ): boolean {
    return this.whatsappOperations.get(role)?.id === operation.id;
  }

  private withCredentialAccess<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.credentialQueue.then(operation, operation);
    this.credentialQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertReady(): void {
    if (this.closed) {
      throw new ChannelSetupError(
        "CHANNEL_SETUP_CLOSED",
        503,
        "Pengelola kanal sudah ditutup.",
      );
    }
    if (!this.lock) {
      throw new ChannelSetupError(
        "CHANNEL_SETUP_NOT_INITIALIZED",
        503,
        "Pengelola kanal belum diinisialisasi.",
      );
    }
  }
}

export function primaryChannelConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PrimaryChannelConfigurationSnapshot {
  const telegramDeclared = Boolean(environment.TELEGRAM_BOT_TOKEN?.trim());
  try {
    const enabled = parseEnabled(environment.WHATSAPP_ENABLED);
    const privateEnabled = parsePrivateEnabled(
      environment.WHATSAPP_PRIVATE_ENABLED,
    );
    const accountCount = parseWhatsAppAccounts(
      environment.WHATSAPP_ACCOUNTS,
    ).length;
    return {
      telegram: { declared: telegramDeclared },
      whatsapp: {
        configurationValid: true,
        enabled,
        privateEnabled,
        accountCount,
        declared: enabled && accountCount > 0,
      },
    };
  } catch {
    return {
      telegram: { declared: telegramDeclared },
      whatsapp: {
        configurationValid: false,
        enabled: false,
        privateEnabled: false,
        accountCount: 0,
        declared: false,
      },
    };
  }
}

export class LiveTelegramPairingAdapter implements TelegramPairingAdapter {
  async validateBotToken(token: string, signal: AbortSignal): Promise<void> {
    const bot = new Bot(token);
    const telegramSignal = signal as unknown as
      NonNullable<Parameters<typeof bot.api.getMe>[0]>;
    const identity = await bot.api.getMe(telegramSignal).catch(() => {
      throw blocked("CHANNEL_TELEGRAM_BOT_TOKEN_REJECTED");
    });
    if (!identity.is_bot || !identity.username) {
      throw blocked("CHANNEL_TELEGRAM_BOT_IDENTITY_INVALID");
    }
  }

  async pairTester(input: {
    apiId: number;
    apiHash: string;
    signal: AbortSignal;
    onQr(value: string, expiresAt: number): void;
    requestPassword(): Promise<string>;
  }): Promise<string> {
    const session = new StringSession("");
    const logger = new Logger();
    logger.handler = () => undefined;
    const client = new TelegramClient(session, input.apiId, input.apiHash, {
      baseLogger: logger,
      connectionRetries: 3,
      reconnectRetries: 3,
      autoReconnect: false,
    });
    const onAbort = (): void => {
      void client.disconnect().catch(() => undefined);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      assertNotAborted(input.signal);
      await client.connect();
      assertNotAborted(input.signal);
      const user = await client.signInUserWithQrCode(
        { apiId: input.apiId, apiHash: input.apiHash },
        {
          qrCode: async ({ token, expires }) => {
            input.onQr(`tg://login?token=${token.toString("base64url")}`, expires * 1_000);
          },
          password: async () => input.requestPassword(),
          onError: async () => true,
          abortSignal: input.signal,
        },
      );
      if (!(user instanceof Api.User) || user.bot === true) {
        throw blocked("CHANNEL_TELEGRAM_TESTER_MUST_BE_USER_ACCOUNT");
      }
      const encoded = session.save();
      if (typeof encoded !== "string" || encoded.length < 16) {
        throw blocked("CHANNEL_TELEGRAM_SESSION_INVALID");
      }
      return encoded;
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      await client.disconnect().catch(() => undefined);
    }
  }

  async revokeTester(input: {
    apiId: number;
    apiHash: string;
    session: string;
    signal: AbortSignal;
  }): Promise<void> {
    const logger = new Logger();
    logger.handler = () => undefined;
    const client = new TelegramClient(
      new StringSession(input.session),
      input.apiId,
      input.apiHash,
      {
        baseLogger: logger,
        connectionRetries: 3,
        reconnectRetries: 3,
        autoReconnect: false,
      },
    );
    const onAbort = (): void => {
      void client.disconnect().catch(() => undefined);
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      assertNotAborted(input.signal);
      await client.connect();
      assertNotAborted(input.signal);
      if (!await client.logOut()) {
        throw blocked("CHANNEL_TELEGRAM_REVOKE_REJECTED");
      }
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      await client.disconnect().catch(() => undefined);
    }
  }
}

export class LiveWhatsAppPairingAdapter implements WhatsAppPairingAdapter {
  async configured(authFolder: string): Promise<boolean> {
    const metadata = await lstat(authFolder).catch(() => null);
    if (!metadata) return false;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw blocked("CHANNEL_WHATSAPP_AUTH_DIRECTORY_INVALID");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(authFolder, "creds.json"), "utf8")) as unknown;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      if (error instanceof SyntaxError) {
        throw blocked("CHANNEL_WHATSAPP_CREDENTIAL_INVALID");
      }
      throw error;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw blocked("CHANNEL_WHATSAPP_CREDENTIAL_INVALID");
    }
    return isWhatsAppCredentialReady(parsed);
  }

  async probe(input: {
    authFolder: string;
    signal: AbortSignal;
  }): Promise<"accepted" | "rejected"> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assertNotAborted(input.signal);
      const connection = await openWhatsAppSocket(input.authFolder);
      try {
        let outcome: "open" | "restart" | "logged_out";
        try {
          outcome = await waitForWhatsAppConnection(
            connection.socket,
            input.signal,
            () => {
              throw blocked("CHANNEL_WHATSAPP_SESSION_REJECTED");
            },
          );
        } catch (error) {
          if (
            safeOperationCode(error, "CHANNEL_WHATSAPP_VERIFICATION_UNAVAILABLE") ===
              "CHANNEL_WHATSAPP_SESSION_REJECTED"
          ) return "rejected";
          throw error;
        }
        await connection.authWrite();
        if (outcome === "restart") continue;
        if (outcome === "logged_out") return "rejected";
        return "accepted";
      } finally {
        await connection.socket.end(undefined).catch(() => undefined);
      }
    }
    throw blocked("CHANNEL_WHATSAPP_VERIFICATION_RESTART_LIMIT");
  }

  async pair(input: {
    authFolder: string;
    otherAuthFolder: string;
    signal: AbortSignal;
    onQr(value: string): void;
  }): Promise<void> {
    await ensurePrivateDirectory(input.authFolder);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assertNotAborted(input.signal);
      const connection = await openWhatsAppSocket(input.authFolder);
      try {
        const outcome = await waitForWhatsAppConnection(
          connection.socket,
          input.signal,
          input.onQr,
        );
        await connection.authWrite();
        if (outcome === "restart") continue;
        if (outcome === "logged_out") {
          throw blocked("CHANNEL_WHATSAPP_SESSION_REVOKED");
        }
        if (!connection.socket.user?.id) {
          throw blocked("CHANNEL_WHATSAPP_IDENTITY_MISSING");
        }
        await assertDifferentWhatsAppIdentity(
          connection.socket.user,
          input.otherAuthFolder,
        );
        return;
      } finally {
        await connection.socket.end(undefined).catch(() => undefined);
      }
    }
    throw blocked("CHANNEL_WHATSAPP_RESTART_LIMIT");
  }

  async revoke(input: {
    authFolder: string;
    authRoot: string;
    signal: AbortSignal;
  }): Promise<void> {
    const metadata = await lstat(input.authFolder).catch(() => null);
    if (!metadata) return;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw blocked("CHANNEL_WHATSAPP_AUTH_DIRECTORY_INVALID");
    }
    const initial = await useMultiFileAuthState(input.authFolder);
    if (!isWhatsAppCredentialReady(initial.state.creds)) {
      await resetWhatsAppAuthDirectory(input.authFolder, input.authRoot);
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assertNotAborted(input.signal);
      const connection = await openWhatsAppSocket(input.authFolder);
      try {
        const outcome = await waitForWhatsAppConnection(
          connection.socket,
          input.signal,
          () => {
            throw blocked("CHANNEL_WHATSAPP_REVOKE_REQUIRES_EXISTING_SESSION");
          },
        );
        if (outcome === "restart") continue;
        if (outcome === "logged_out") {
          await resetWhatsAppAuthDirectory(input.authFolder, input.authRoot);
          return;
        }
        await connection.socket.logout("Sesi uji dicabut dari Harvy Console.");
        await connection.authWrite();
        await resetWhatsAppAuthDirectory(input.authFolder, input.authRoot);
        return;
      } finally {
        await connection.socket.end(undefined).catch(() => undefined);
      }
    }
    throw blocked("CHANNEL_WHATSAPP_REVOKE_RESTART_LIMIT");
  }
}

interface WhatsAppConnection {
  socket: WASocket;
  authWrite(): Promise<void>;
}

async function openWhatsAppSocket(authFolder: string): Promise<WhatsAppConnection> {
  installThirdPartyConsoleSecretGuard();
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const logger = silentBaileysLogger();
  const socket = makeWASocket({
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
  });
  let write = Promise.resolve();
  socket.ev.on("creds.update", () => {
    write = write.then(saveCreds, saveCreds);
  });
  return { socket, authWrite: () => write };
}

function waitForWhatsAppConnection(
  socket: WASocket,
  signal: AbortSignal,
  onQr: (value: string) => void,
): Promise<"open" | "restart" | "logged_out"> {
  return new Promise((resolveConnection, rejectConnection) => {
    const onAbort = (): void => {
      cleanup();
      void socket.end(undefined).catch(() => undefined);
      rejectConnection(aborted());
    };
    const onUpdate = (update: {
      connection?: string;
      qr?: string;
      lastDisconnect?: { error?: unknown };
    }): void => {
      if (update.qr) {
        try {
          onQr(update.qr);
        } catch (error) {
          cleanup();
          rejectConnection(error);
          return;
        }
      }
      if (update.connection === "open") {
        cleanup();
        resolveConnection("open");
        return;
      }
      if (update.connection !== "close") return;
      const reason = disconnectStatus(update.lastDisconnect?.error);
      cleanup();
      const outcome = whatsappSetupCloseOutcome(reason);
      if (outcome === "restart" || outcome === "logged_out") {
        resolveConnection(outcome);
      } else rejectConnection(blocked("CHANNEL_WHATSAPP_CONNECTION_CLOSED"));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      socket.ev.off("connection.update", onUpdate);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.ev.on("connection.update", onUpdate);
  });
}

async function assertDifferentWhatsAppIdentity(
  own: { id: string; lid?: string; phoneNumber?: string },
  otherFolder: string,
): Promise<void> {
  const metadata = await lstat(otherFolder).catch(() => null);
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw blocked("CHANNEL_WHATSAPP_AUTH_DIRECTORY_INVALID");
  }
  const other = await useMultiFileAuthState(otherFolder);
  if (!isWhatsAppCredentialReady(other.state.creds) || !other.state.creds.me) return;
  const ownIds = identityJids(own);
  const otherIds = identityJids(other.state.creds.me);
  if ([...ownIds].some((id) => otherIds.has(id))) {
    throw blocked("CHANNEL_WHATSAPP_ROLES_MUST_USE_DIFFERENT_NUMBERS");
  }
}

function identityJids(
  identity: { id: string; lid?: string; phoneNumber?: string },
): Set<string> {
  return new Set(
    [identity.id, identity.lid, identity.phoneNumber]
      .filter((value): value is string => Boolean(value))
      .map(jidNormalizedUser),
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw blocked("CHANNEL_WHATSAPP_AUTH_DIRECTORY_INVALID");
  }
}

async function resetWhatsAppAuthDirectory(
  path: string,
  expectedParent: string,
): Promise<void> {
  const target = resolve(path);
  const parent = resolve(expectedParent);
  if (
    dirname(target) !== parent ||
    (target !== resolve(parent, "harvy") && target !== resolve(parent, "tester"))
  ) {
    throw blocked("CHANNEL_WHATSAPP_RESET_TARGET_INVALID");
  }
  const metadata = await lstat(target).catch(() => null);
  if (metadata?.isSymbolicLink() || (metadata && !metadata.isDirectory())) {
    throw blocked("CHANNEL_WHATSAPP_RESET_TARGET_INVALID");
  }
  await rm(target, { recursive: true, force: true });
}

function emptyPairingState(): PairingState {
  return {
    phase: "idle",
    qr: null,
    qrRevision: 0,
    qrExpiresAt: null,
    errorCode: null,
  };
}

function publicPairingState(
  state: PairingState,
  configured: boolean,
  now: number,
): ChannelPairingSnapshot {
  return {
    configured,
    phase: state.phase === "idle" && configured ? "paired" : state.phase,
    qrAvailable: Boolean(
      state.qr && state.qrExpiresAt && state.qrExpiresAt > now,
    ),
    qrRevision: state.qrRevision,
    qrExpiresAt: state.qrExpiresAt === null
      ? null
      : new Date(state.qrExpiresAt).toISOString(),
    errorCode: state.errorCode,
  };
}

function publicWhatsAppPairingState(
  pairing: PairingState,
  verification: WhatsAppVerificationState,
  configured: boolean,
  now: number,
): WhatsAppPairingSnapshot {
  return {
    ...publicPairingState(pairing, configured, now),
    session: {
      status: configured ? verification.status : "missing",
      checkedAt: verification.checkedAt === null
        ? null
        : new Date(verification.checkedAt).toISOString(),
      errorCode: verification.errorCode,
    },
  };
}

function whatsappPairingReady(snapshot: WhatsAppPairingSnapshot): boolean {
  return snapshot.configured &&
    snapshot.phase === "paired" &&
    snapshot.session.status === "accepted";
}

function emptyWhatsAppVerificationState(): WhatsAppVerificationState {
  return {
    status: "missing",
    checkedAt: null,
    errorCode: null,
  };
}

function resetWhatsAppVerificationState(
  state: WhatsAppVerificationState,
): void {
  state.status = "missing";
  state.checkedAt = null;
  state.errorCode = null;
}

function setWhatsAppVerificationResult(
  state: WhatsAppVerificationState,
  status: "accepted" | "rejected" | "unreachable",
  checkedAt: number,
  errorCode: string | null,
): void {
  state.status = status;
  state.checkedAt = checkedAt;
  state.errorCode = errorCode;
}

function isWhatsAppSessionRejection(code: string): boolean {
  return code === "CHANNEL_WHATSAPP_SESSION_REJECTED" ||
    code === "CHANNEL_WHATSAPP_SESSION_REVOKED";
}

function setPairingState(
  state: PairingState,
  phase: ChannelPairingPhase,
  preserveQr = false,
): void {
  state.phase = phase;
  state.errorCode = null;
  if (!preserveQr) {
    state.qr = null;
    state.qrExpiresAt = null;
  }
}

function setPairingError(state: PairingState, code: string): void {
  setPairingState(state, "error");
  state.errorCode = code;
}

function clearQr(state: PairingState): void {
  state.qr = null;
  state.qrExpiresAt = null;
}

function setQr(state: PairingState, value: string, expiresAt: number): void {
  if (!value || value.length > 8_192 || !Number.isFinite(expiresAt)) {
    throw blocked("CHANNEL_PAIRING_QR_INVALID");
  }
  state.phase = "awaiting_scan";
  state.qr = value;
  state.qrRevision += 1;
  state.qrExpiresAt = expiresAt;
  state.errorCode = null;
}

function telegramApiId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw rejected("CHANNEL_TELEGRAM_API_ID_INVALID", "Telegram api_id tidak sah.");
  }
  return value;
}

function telegramApiHash(value: string): string {
  const normalized = value.trim();
  if (!TELEGRAM_API_HASH_PATTERN.test(normalized)) {
    throw rejected("CHANNEL_TELEGRAM_API_HASH_INVALID", "Telegram api_hash tidak sah.");
  }
  return normalized;
}

function requiredRole(value: WhatsAppTestRole | undefined): WhatsAppTestRole {
  if (value !== "harvy" && value !== "tester") {
    throw rejected("CHANNEL_WHATSAPP_ROLE_INVALID", "Role WhatsApp tidak sah.");
  }
  return value;
}

function whatsappAuthFolder(
  role: WhatsAppTestRole,
  paths: LiveAcceptancePaths,
): string {
  return role === "harvy" ? paths.whatsappHarvyAuth : paths.whatsappTesterAuth;
}

function whatsappFolders(
  role: WhatsAppTestRole,
  paths: LiveAcceptancePaths,
): { authFolder: string; otherAuthFolder: string } {
  return role === "harvy"
    ? { authFolder: paths.whatsappHarvyAuth, otherAuthFolder: paths.whatsappTesterAuth }
    : { authFolder: paths.whatsappTesterAuth, otherAuthFolder: paths.whatsappHarvyAuth };
}

function safeOperationCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const candidate = "code" in error
    ? (error as { code?: unknown }).code
    : error.message;
  return typeof candidate === "string" && /^[A-Z][A-Z0-9_]{2,159}$/u.test(candidate)
    ? candidate
    : fallback;
}

function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function rejected(code: string, message: string): ChannelSetupError {
  return new ChannelSetupError(code, 400, message);
}

function conflict(code: string, message: string): ChannelSetupError {
  return new ChannelSetupError(code, 409, message);
}

function serviceFailure(code: string, message: string): ChannelSetupError {
  return new ChannelSetupError(code, 502, message);
}

function blocked(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function aborted(): Error {
  return Object.assign(new Error("CHANNEL_PAIRING_ABORTED"), {
    name: "AbortError",
    code: "CHANNEL_PAIRING_ABORTED",
  });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw aborted();
}

async function settleCancellation(task: Promise<void>): Promise<boolean> {
  return Promise.race([
    task.then(() => true, () => true),
    new Promise<boolean>((resolveCancellation) => {
      const timer = setTimeout(() => resolveCancellation(false), 5_000);
      timer.unref();
    }),
  ]);
}

function disconnectStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    output?: { statusCode?: unknown };
    statusCode?: unknown;
  };
  const status = value.output?.statusCode ?? value.statusCode;
  return typeof status === "number" ? status : null;
}

export function whatsappSetupCloseOutcome(
  reason: number | null,
): "restart" | "logged_out" | "closed" {
  if (reason === DisconnectReason.restartRequired) return "restart";
  if (
    reason === DisconnectReason.loggedOut ||
    reason === DisconnectReason.badSession ||
    reason === DisconnectReason.multideviceMismatch
  ) return "logged_out";
  return "closed";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function silentBaileysLogger() {
  const logger = {
    level: "silent",
    child: () => logger,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return logger;
}

interface QrCodeInstance {
  addData(value: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, column: number): boolean;
}

type QrCodeConstructor = new (
  typeNumber: number,
  errorCorrectLevel: number,
) => QrCodeInstance;

const require = createRequire(import.meta.url);
const QrCode = require("qrcode-terminal/vendor/QRCode/index.js") as QrCodeConstructor;
const qrLevels = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js") as {
  M: number;
};

export function renderQrSvg(value: string): string {
  if (!value || value.length > 8_192 || /\p{Cc}/u.test(value)) {
    throw rejected("CHANNEL_PAIRING_QR_INVALID", "Payload QR tidak sah.");
  }
  const qr = new QrCode(-1, qrLevels.M);
  qr.addData(value);
  qr.make();
  const modules = qr.getModuleCount();
  const quiet = 4;
  const size = modules + quiet * 2;
  const cells: string[] = [];
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (qr.isDark(row, column)) {
        cells.push(`M${column + quiet} ${row + quiet}h1v1h-1z`);
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR pairing">`,
    `<rect width="${size}" height="${size}" fill="#fff"/>`,
    `<path d="${cells.join("")}" fill="#000"/>`,
    "</svg>",
  ].join("");
}
