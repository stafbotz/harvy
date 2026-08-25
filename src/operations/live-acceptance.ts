import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { EncryptedFileSecretStore } from "../core/secret-store.js";

const LEGACY_TELEGRAM_SECRET_REF = "live-acceptance.telegram.v1";
const TELEGRAM_BOT_SECRET_REF = "live-acceptance.telegram-bot.v1";
const TELEGRAM_TESTER_SECRET_REF = "live-acceptance.telegram-tester.v1";
const ISOLATED_ROOT_PREFIX = "harvy-live-acceptance-";

const ISOLATED_STATE_VARIABLES = [
  "DATA_FILE",
  "MEMORY_FILE",
  "MEMORY_FOLDER",
  "HISTORY_FILE",
  "LONG_TERM_MEMORY_FILE",
  "PROFILE_FILE",
  "SESSION_FILE",
  "AGENT_RUN_FILE",
  "TELEMETRY_FILE",
  "CONTROL_PLANE_FILE",
  "USAGE_LEDGER_FILE",
  "ENTITLEMENT_LEDGER_FILE",
  "HARVY_ECONOMY_FILE",
  "HARVY_BYOK_SECRET_FILE",
  "LOG_FOLDER",
  "WHATSAPP_AUTH_FOLDER",
  "WHATSAPP_GROUP_FILE",
  "WHATSAPP_GROUP_AGENT_RUN_FILE",
  "WHATSAPP_GROUP_AGENT_RUN_CLEANUP_FILE",
] as const;

const UNNEEDED_SECRET_VARIABLES = [
  "HARVY_BACKUP_KEY_B64",
  "HARVY_BACKUP_KEY_FILE",
  "HARVY_BYOK_MASTER_KEY_B64",
  "HARVY_CONSOLE_TOKEN",
  "HARVY_WORKSPACE_PRINCIPAL_SECRET_FILE",
  "HARVY_CODING_CONFORMANCE_RECEIPT_FILE",
  "HARVY_CODING_CONFORMANCE_RECEIPT_SHA256",
  "HARVY_SANDBOX_HMAC_SECRET_FILE",
  "HARVY_LOCAL_GIT_HMAC_SECRET_FILE",
  "HARVY_GITHUB_BROKER_HMAC_SECRET_FILE",
] as const;

export interface TelegramLiveAcceptanceCredential {
  version: 1;
  apiId: number;
  apiHash: string;
  session: string;
  botToken: string;
}

export interface TelegramBotCredential {
  version: 1;
  botToken: string;
}

export interface TelegramTesterCredential {
  version: 1;
  apiId: number;
  apiHash: string;
  session: string;
}

export interface LiveAcceptancePaths {
  keyFile: string;
  secretFile: string;
  setupLockFile: string;
  whatsappAuthRoot: string;
  whatsappHarvyAuth: string;
  whatsappTesterAuth: string;
}

export interface IsolatedRuntimeEnvironmentOptions {
  telegramBotToken: string;
  whatsapp?: {
    authRoot: string;
    accountAlias: string;
    phoneNumber: string;
    messageScope?: string;
  };
}

export type TelegramPrivateStartSurface = "onboarding" | "returning" | null;

/**
 * Menentukan terminal surface `/start` tanpa menebak dari jeda antarbubble.
 * Bubble pembuka onboarding memang dikirim bertahap; `👋` atau bubble identitas
 * belum cukup untuk menyimpulkan apakah akun sudah pernah memberi consent.
 */
export function classifyTelegramPrivateStartSurface(
  text: string,
  buttonLabels: readonly string[],
): TelegramPrivateStartSurface {
  if (buttonLabels.some((label) => label === "Okei, mulai.")) {
    return "onboarding";
  }
  if (/^Haloo lagi,\s*(?:\r?\n)+/u.test(text.trim())) {
    return "returning";
  }
  return null;
}

export function liveAcceptancePaths(
  repositoryRoot = process.cwd(),
): LiveAcceptancePaths {
  const root = resolve(repositoryRoot);
  const whatsappAuthRoot = join(
    root,
    "data",
    "whatsapp-auth",
    "live-acceptance",
  );
  return {
    keyFile: join(root, "secrets", "live-acceptance.key"),
    secretFile: join(root, "secrets", "live-acceptance.secrets.json"),
    setupLockFile: join(root, "secrets", "live-acceptance.setup.runtime.lock"),
    whatsappAuthRoot,
    whatsappHarvyAuth: join(whatsappAuthRoot, "harvy"),
    whatsappTesterAuth: join(whatsappAuthRoot, "tester"),
  };
}

export async function saveTelegramLiveAcceptanceCredential(
  credential: TelegramLiveAcceptanceCredential,
  paths = liveAcceptancePaths(),
): Promise<void> {
  const validated = validateTelegramCredential(credential);
  const store = await openLiveAcceptanceStore(paths);
  await store.put(TELEGRAM_BOT_SECRET_REF, JSON.stringify({
    version: 1,
    botToken: validated.botToken,
  } satisfies TelegramBotCredential));
  await store.put(TELEGRAM_TESTER_SECRET_REF, JSON.stringify({
    version: 1,
    apiId: validated.apiId,
    apiHash: validated.apiHash,
    session: validated.session,
  } satisfies TelegramTesterCredential));
  await store.delete(LEGACY_TELEGRAM_SECRET_REF);
}

export async function loadTelegramLiveAcceptanceCredential(
  paths = liveAcceptancePaths(),
): Promise<TelegramLiveAcceptanceCredential | null> {
  const store = await openLiveAcceptanceStore(paths);
  const [botValue, testerValue] = await Promise.all([
    store.get(TELEGRAM_BOT_SECRET_REF),
    store.get(TELEGRAM_TESTER_SECRET_REF),
  ]);
  if (botValue !== null && testerValue !== null) {
    const bot = parseTelegramBotCredential(botValue);
    const tester = parseTelegramTesterCredential(testerValue);
    return {
      version: 1,
      apiId: tester.apiId,
      apiHash: tester.apiHash,
      session: tester.session,
      botToken: bot.botToken,
    };
  }

  const legacyValue = await store.get(LEGACY_TELEGRAM_SECRET_REF);
  if (legacyValue === null) return null;
  const legacy = parseTelegramLiveAcceptanceCredential(legacyValue);
  const bot = botValue === null
    ? { version: 1 as const, botToken: legacy.botToken }
    : parseTelegramBotCredential(botValue);
  const tester = testerValue === null
    ? {
        version: 1 as const,
        apiId: legacy.apiId,
        apiHash: legacy.apiHash,
        session: legacy.session,
      }
    : parseTelegramTesterCredential(testerValue);
  await saveTelegramLiveAcceptanceCredential({ ...tester, ...bot }, paths);
  return { ...tester, ...bot };
}

export async function saveTelegramBotCredential(
  credential: TelegramBotCredential,
  paths = liveAcceptancePaths(),
): Promise<void> {
  const validated = validateTelegramBotCredential(credential);
  const store = await openLiveAcceptanceStore(paths);
  await store.put(TELEGRAM_BOT_SECRET_REF, JSON.stringify(validated));
}

export async function loadTelegramBotCredential(
  paths = liveAcceptancePaths(),
): Promise<TelegramBotCredential | null> {
  const store = await openLiveAcceptanceStore(paths);
  const value = await store.get(TELEGRAM_BOT_SECRET_REF);
  if (value !== null) return parseTelegramBotCredential(value);
  const legacyValue = await store.get(LEGACY_TELEGRAM_SECRET_REF);
  if (legacyValue === null) return null;
  return {
    version: 1,
    botToken: parseTelegramLiveAcceptanceCredential(legacyValue).botToken,
  };
}

export async function deleteTelegramBotCredential(
  paths = liveAcceptancePaths(),
): Promise<void> {
  const store = await openLiveAcceptanceStore(paths);
  const [tester, legacyValue] = await Promise.all([
    store.get(TELEGRAM_TESTER_SECRET_REF),
    store.get(LEGACY_TELEGRAM_SECRET_REF),
  ]);
  if (tester === null && legacyValue !== null) {
    const legacy = parseTelegramLiveAcceptanceCredential(legacyValue);
    await store.put(TELEGRAM_TESTER_SECRET_REF, JSON.stringify({
      version: 1,
      apiId: legacy.apiId,
      apiHash: legacy.apiHash,
      session: legacy.session,
    } satisfies TelegramTesterCredential));
  }
  await Promise.all([
    store.delete(TELEGRAM_BOT_SECRET_REF),
    store.delete(LEGACY_TELEGRAM_SECRET_REF),
  ]);
}

export async function saveTelegramTesterCredential(
  credential: TelegramTesterCredential,
  paths = liveAcceptancePaths(),
): Promise<void> {
  const validated = validateTelegramTesterCredential(credential);
  const store = await openLiveAcceptanceStore(paths);
  await store.put(TELEGRAM_TESTER_SECRET_REF, JSON.stringify(validated));
}

export async function loadTelegramTesterCredential(
  paths = liveAcceptancePaths(),
): Promise<TelegramTesterCredential | null> {
  const store = await openLiveAcceptanceStore(paths);
  const value = await store.get(TELEGRAM_TESTER_SECRET_REF);
  if (value !== null) return parseTelegramTesterCredential(value);
  const legacyValue = await store.get(LEGACY_TELEGRAM_SECRET_REF);
  if (legacyValue === null) return null;
  const legacy = parseTelegramLiveAcceptanceCredential(legacyValue);
  return {
    version: 1,
    apiId: legacy.apiId,
    apiHash: legacy.apiHash,
    session: legacy.session,
  };
}

export async function deleteTelegramTesterCredential(
  paths = liveAcceptancePaths(),
): Promise<void> {
  const store = await openLiveAcceptanceStore(paths);
  const [bot, legacyValue] = await Promise.all([
    store.get(TELEGRAM_BOT_SECRET_REF),
    store.get(LEGACY_TELEGRAM_SECRET_REF),
  ]);
  if (bot === null && legacyValue !== null) {
    const legacy = parseTelegramLiveAcceptanceCredential(legacyValue);
    await store.put(TELEGRAM_BOT_SECRET_REF, JSON.stringify({
      version: 1,
      botToken: legacy.botToken,
    } satisfies TelegramBotCredential));
  }
  await Promise.all([
    store.delete(TELEGRAM_TESTER_SECRET_REF),
    store.delete(LEGACY_TELEGRAM_SECRET_REF),
  ]);
}

function parseTelegramLiveAcceptanceCredential(
  value: string,
): TelegramLiveAcceptanceCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw blocked("LIVE_ACCEPTANCE_TELEGRAM_CREDENTIAL_INVALID");
  }
  return validateTelegramCredential(parsed);
}

function parseTelegramBotCredential(value: string): TelegramBotCredential {
  try {
    return validateTelegramBotCredential(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw blocked("LIVE_ACCEPTANCE_TELEGRAM_BOT_CREDENTIAL_INVALID");
    }
    throw error;
  }
}

function parseTelegramTesterCredential(
  value: string,
): TelegramTesterCredential {
  try {
    return validateTelegramTesterCredential(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw blocked("LIVE_ACCEPTANCE_TELEGRAM_TESTER_CREDENTIAL_INVALID");
    }
    throw error;
  }
}

export async function createIsolatedRuntimeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), ISOLATED_ROOT_PREFIX));
}

export async function removeIsolatedRuntimeRoot(root: string): Promise<void> {
  const resolved = resolve(root);
  const expectedParent = resolve(tmpdir());
  if (
    dirname(resolved) !== expectedParent ||
    !basename(resolved).startsWith(ISOLATED_ROOT_PREFIX)
  ) {
    throw new Error("LIVE_ACCEPTANCE_ISOLATED_ROOT_INVALID");
  }
  await rm(resolved, { recursive: true, force: true });
}

export function isolatedRuntimeEnvironment(
  source: NodeJS.ProcessEnv,
  options: IsolatedRuntimeEnvironmentOptions,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const name of ISOLATED_STATE_VARIABLES) delete env[name];
  for (const name of UNNEEDED_SECRET_VARIABLES) delete env[name];
  delete env.HARVY_LIVE_EXPLORATION_MESSAGE_SCOPE;

  env.TELEGRAM_BOT_TOKEN = botToken(options.telegramBotToken);
  env.HARVY_TELEGRAM_TOKEN_EPHEMERAL = "live-acceptance-v1";
  env.APP_ENV = "development";
  env.RELEASE_SHA = "live-acceptance";
  env.LOG_CONSOLE = "false";
  env.LOG_FILE_REQUIRED = "false";
  env.HARVY_CONSOLE_ENABLED = "false";
  env.HARVY_PAYMENT_GATEWAY_MODE = "disabled";
  env.HARVY_CODING_RUNTIME_ENABLED = "false";
  env.HARVY_GITHUB_RUNTIME_ENABLED = "false";
  env.WHATSAPP_GROUP_AGENT_RUN_ENABLED = "false";
  env.REMINDER_INTERVAL_MS = "5000";

  if (options.whatsapp) {
    const alias = accountAlias(options.whatsapp.accountAlias);
    const phoneNumber = e164Digits(options.whatsapp.phoneNumber);
    env.WHATSAPP_ENABLED = "true";
    env.WHATSAPP_PRIVATE_ENABLED = "true";
    env.WHATSAPP_PAIRING_MODE = "qr";
    env.WHATSAPP_AUTH_FOLDER = resolve(options.whatsapp.authRoot);
    env.WHATSAPP_ACCOUNTS = JSON.stringify([{ id: alias, phoneNumber }]);
    if (options.whatsapp.messageScope !== undefined) {
      if (!/^HARVYEXP[A-F0-9]{12}$/u.test(options.whatsapp.messageScope)) {
        throw new Error("LIVE_EXPLORATION_WHATSAPP_SCOPE_INVALID");
      }
      env.HARVY_LIVE_EXPLORATION_MESSAGE_SCOPE =
        options.whatsapp.messageScope;
    }
  } else {
    env.WHATSAPP_ENABLED = "false";
    env.WHATSAPP_PRIVATE_ENABLED = "false";
    delete env.WHATSAPP_ACCOUNTS;
  }
  return env;
}

export function loadRepositoryEnvironment(repositoryRoot = process.cwd()): void {
  try {
    process.loadEnvFile(join(resolve(repositoryRoot), ".env"));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

async function openLiveAcceptanceStore(
  paths: LiveAcceptancePaths,
): Promise<EncryptedFileSecretStore> {
  const key = await loadOrCreateKey(paths.keyFile);
  return new EncryptedFileSecretStore(paths.secretFile, key);
}

async function loadOrCreateKey(file: string): Promise<Buffer> {
  const directory = dirname(resolve(file));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw blocked("LIVE_ACCEPTANCE_SECRET_DIRECTORY_INVALID");
  }

  try {
    const handle = await open(resolve(file), "wx", 0o600);
    try {
      await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(resolve(file), 0o600).catch(() => undefined);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }

  const metadata = await lstat(resolve(file));
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw blocked("LIVE_ACCEPTANCE_KEY_FILE_INVALID");
  }
  const encoded = (await readFile(resolve(file), "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) {
    throw blocked("LIVE_ACCEPTANCE_KEY_FILE_INVALID");
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== encoded) {
    throw blocked("LIVE_ACCEPTANCE_KEY_FILE_INVALID");
  }
  return key;
}

function validateTelegramCredential(
  value: unknown,
): TelegramLiveAcceptanceCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw blocked("LIVE_ACCEPTANCE_TELEGRAM_CREDENTIAL_INVALID");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join("\0") !==
      ["apiHash", "apiId", "botToken", "session", "version"].sort().join("\0") ||
    record["version"] !== 1
  ) {
    throw blocked("LIVE_ACCEPTANCE_TELEGRAM_CREDENTIAL_INVALID");
  }
  let tester: TelegramTesterCredential;
  let bot: TelegramBotCredential;
  try {
    tester = validateTelegramTesterCredential({
      version: 1,
      apiId: record["apiId"],
      apiHash: record["apiHash"],
      session: record["session"],
    });
    bot = validateTelegramBotCredential({
      version: 1,
      botToken: record["botToken"],
    });
  } catch {
    throw blocked("LIVE_ACCEPTANCE_TELEGRAM_CREDENTIAL_INVALID");
  }
  return {
    version: 1,
    apiId: tester.apiId,
    apiHash: tester.apiHash,
    session: tester.session,
    botToken: bot.botToken,
  };
}

function validateTelegramBotCredential(
  value: unknown,
): TelegramBotCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw blocked("LIVE_ACCEPTANCE_TELEGRAM_BOT_CREDENTIAL_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
      ["botToken", "version"].sort().join("\0") ||
    record["version"] !== 1
  ) {
    throw blocked("LIVE_ACCEPTANCE_TELEGRAM_BOT_CREDENTIAL_INVALID");
  }
  try {
    return { version: 1, botToken: botToken(record["botToken"]) };
  } catch {
    throw blocked("LIVE_ACCEPTANCE_TELEGRAM_BOT_CREDENTIAL_INVALID");
  }
}

function validateTelegramTesterCredential(
  value: unknown,
): TelegramTesterCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw blocked("LIVE_ACCEPTANCE_TELEGRAM_TESTER_CREDENTIAL_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
      ["apiHash", "apiId", "session", "version"].sort().join("\0") ||
    record["version"] !== 1 ||
    !Number.isSafeInteger(record["apiId"]) ||
    (record["apiId"] as number) < 1 ||
    (record["apiId"] as number) > 2_147_483_647 ||
    typeof record["apiHash"] !== "string" ||
    !/^[a-f0-9]{32}$/iu.test(record["apiHash"]) ||
    typeof record["session"] !== "string" ||
    record["session"].length < 16 ||
    record["session"].length > 8_192 ||
    /\p{Cc}/u.test(record["session"])
  ) {
    throw blocked("LIVE_ACCEPTANCE_TELEGRAM_TESTER_CREDENTIAL_INVALID");
  }
  return {
    version: 1,
    apiId: record["apiId"] as number,
    apiHash: record["apiHash"],
    session: record["session"],
  };
}

function botToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{5,20}:[A-Za-z0-9_-]{20,160}$/u.test(value.trim())
  ) {
    throw blocked("LIVE_ACCEPTANCE_TELEGRAM_BOT_TOKEN_INVALID");
  }
  return value.trim();
}

function accountAlias(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/iu.test(normalized)) {
    throw blocked("LIVE_ACCEPTANCE_WHATSAPP_ALIAS_INVALID");
  }
  return normalized;
}

function e164Digits(value: string): string {
  const normalized = value.trim();
  if (!/^[1-9]\d{7,14}$/u.test(normalized)) {
    throw blocked("LIVE_ACCEPTANCE_WHATSAPP_PHONE_INVALID");
  }
  return normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function blocked(code: string): Error {
  return Object.assign(new Error(code), { code });
}
