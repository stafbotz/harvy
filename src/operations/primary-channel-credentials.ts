import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  EncryptedFileSecretStore,
  readEncryptedFileSecretSync,
} from "../core/secret-store.js";
import { writeDurableFileAtomic } from "../storage/durable-file.js";
import {
  parseEnabled,
  parsePrivateEnabled,
  parseWhatsAppAccountAlias,
  parseWhatsAppAccounts,
  parseWhatsAppPhoneNumber,
} from "../whatsapp/config.js";

const PRIMARY_TELEGRAM_BOT_SECRET_REF = "primary.telegram.bot.v1";
const PRIMARY_WHATSAPP_FLEET_SECRET_REF = "primary.whatsapp.fleet.v1";
const PRIMARY_TELEGRAM_BOT_TOKEN_PATTERN =
  /^\d{5,20}:[A-Za-z0-9_-]{20,160}$/u;
const PRIMARY_TELEGRAM_ENV_LINE =
  /^\uFEFF?\s*(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=/u;
const PRIMARY_WHATSAPP_ENV_KEYS = [
  "WHATSAPP_ENABLED",
  "WHATSAPP_PRIVATE_ENABLED",
  "WHATSAPP_ACCOUNTS",
] as const;
const PRIMARY_WHATSAPP_ENV_LINE =
  /^\uFEFF?\s*(?:export\s+)?(?:WHATSAPP_ENABLED|WHATSAPP_PRIVATE_ENABLED|WHATSAPP_ACCOUNTS)\s*=/u;
const PRIMARY_CHANNEL_FILE_QUEUES = new Map<string, Promise<void>>();

export interface PrimaryChannelCredentialPaths {
  keyFile: string;
  secretFile: string;
  environmentFile: string;
}

export interface PrimaryTelegramBotCredential {
  version: 1;
  botToken: string;
}

export interface PrimaryTelegramEnvironmentStatus {
  declared: boolean;
  migratable: boolean;
  entryCount: number;
}

export type PrimaryWhatsAppFleetAccountState =
  | "active"
  | "pending"
  | "removing";

export interface PrimaryWhatsAppFleetAccount {
  id: string;
  phoneNumber: string | null;
  state: PrimaryWhatsAppFleetAccountState;
}

export interface PrimaryWhatsAppFleetCredential {
  version: 1;
  enabled: boolean;
  privateEnabled: boolean;
  accounts: PrimaryWhatsAppFleetAccount[];
}

export interface PrimaryWhatsAppEnvironmentStatus {
  declared: boolean;
  migratable: boolean;
  entryCount: number;
  configurationValid: boolean;
}

export function primaryChannelCredentialPaths(
  repositoryRoot = process.cwd(),
): PrimaryChannelCredentialPaths {
  const root = resolve(repositoryRoot);
  return {
    keyFile: join(root, "secrets", "primary-channels.key"),
    secretFile: join(root, "secrets", "primary-channels.secrets.json"),
    environmentFile: join(root, ".env"),
  };
}

export async function savePrimaryTelegramBotCredential(
  credential: PrimaryTelegramBotCredential,
  paths = primaryChannelCredentialPaths(),
): Promise<void> {
  const validated = validatePrimaryTelegramBotCredential(credential);
  await withPrimaryChannelFileAccess(paths, async () => {
    const store = await openPrimaryChannelStore(paths);
    await store.put(PRIMARY_TELEGRAM_BOT_SECRET_REF, JSON.stringify(validated));
  });
}

export async function loadPrimaryTelegramBotCredential(
  paths = primaryChannelCredentialPaths(),
): Promise<PrimaryTelegramBotCredential | null> {
  return withPrimaryChannelFileAccess(paths, async () => {
    const store = await openPrimaryChannelStore(paths);
    const value = await store.get(PRIMARY_TELEGRAM_BOT_SECRET_REF);
    return value === null ? null : parsePrimaryTelegramBotCredential(value);
  });
}

export function loadPrimaryTelegramBotCredentialSync(
  paths = primaryChannelCredentialPaths(),
): PrimaryTelegramBotCredential | null {
  const key = loadPrimaryChannelKeySync(paths);
  if (key === null) return null;
  assertRegularCredentialFileSync(
    paths.secretFile,
    "PRIMARY_CHANNEL_SECRET_FILE_INVALID",
  );
  const value = readEncryptedFileSecretSync(
    paths.secretFile,
    key,
    PRIMARY_TELEGRAM_BOT_SECRET_REF,
  );
  return value === null ? null : parsePrimaryTelegramBotCredential(value);
}

export async function deletePrimaryTelegramBotCredential(
  paths = primaryChannelCredentialPaths(),
): Promise<void> {
  await withPrimaryChannelFileAccess(paths, async () => {
    const store = await openPrimaryChannelStore(paths);
    await store.delete(PRIMARY_TELEGRAM_BOT_SECRET_REF);
  });
}

export async function savePrimaryWhatsAppFleetCredential(
  credential: PrimaryWhatsAppFleetCredential,
  paths = primaryChannelCredentialPaths(),
): Promise<void> {
  const validated = validatePrimaryWhatsAppFleetCredential(credential);
  await withPrimaryChannelFileAccess(paths, async () => {
    const store = await openPrimaryChannelStore(paths);
    await store.put(PRIMARY_WHATSAPP_FLEET_SECRET_REF, JSON.stringify(validated));
  });
}

export async function loadPrimaryWhatsAppFleetCredential(
  paths = primaryChannelCredentialPaths(),
): Promise<PrimaryWhatsAppFleetCredential | null> {
  return withPrimaryChannelFileAccess(paths, async () => {
    const store = await openPrimaryChannelStore(paths);
    const value = await store.get(PRIMARY_WHATSAPP_FLEET_SECRET_REF);
    return value === null ? null : parsePrimaryWhatsAppFleetCredential(value);
  });
}

export function loadPrimaryWhatsAppFleetCredentialSync(
  paths = primaryChannelCredentialPaths(),
): PrimaryWhatsAppFleetCredential | null {
  const key = loadPrimaryChannelKeySync(paths);
  if (key === null) return null;
  assertRegularCredentialFileSync(
    paths.secretFile,
    "PRIMARY_CHANNEL_SECRET_FILE_INVALID",
  );
  const value = readEncryptedFileSecretSync(
    paths.secretFile,
    key,
    PRIMARY_WHATSAPP_FLEET_SECRET_REF,
  );
  return value === null ? null : parsePrimaryWhatsAppFleetCredential(value);
}

export async function deletePrimaryWhatsAppFleetCredential(
  paths = primaryChannelCredentialPaths(),
): Promise<void> {
  await withPrimaryChannelFileAccess(paths, async () => {
    const store = await openPrimaryChannelStore(paths);
    await store.delete(PRIMARY_WHATSAPP_FLEET_SECRET_REF);
  });
}

export async function primaryTelegramEnvironmentStatus(
  environment: NodeJS.ProcessEnv = process.env,
  paths = primaryChannelCredentialPaths(),
): Promise<PrimaryTelegramEnvironmentStatus> {
  const token = optionalTelegramBotToken(environment.TELEGRAM_BOT_TOKEN);
  const file = await readEnvironmentToken(paths.environmentFile);
  return {
    declared: token !== null,
    migratable: token !== null && file.token !== null && secretEqual(token, file.token),
    entryCount: file.entryCount,
  };
}

export async function primaryWhatsAppEnvironmentStatus(
  environment: NodeJS.ProcessEnv = process.env,
  paths = primaryChannelCredentialPaths(),
): Promise<PrimaryWhatsAppEnvironmentStatus> {
  const declared = primaryWhatsAppEnvironmentDeclared(environment);
  const file = await readWhatsAppEnvironment(paths.environmentFile);
  let processCredential: PrimaryWhatsAppFleetCredential | null = null;
  let configurationValid = true;
  try {
    processCredential = legacyPrimaryWhatsAppFleetCredential(environment);
  } catch {
    configurationValid = false;
  }
  const expectedEntries = PRIMARY_WHATSAPP_ENV_KEYS.filter((key) =>
    Boolean(environment[key]?.trim())
  ).length;
  const migratable = Boolean(
    declared &&
    configurationValid &&
    processCredential &&
    file.configuration &&
    file.entryCount === expectedEntries &&
    file.entriesUnique &&
    samePrimaryWhatsAppFleet(processCredential, file.configuration),
  );
  return {
    declared,
    migratable,
    entryCount: file.entryCount,
    configurationValid,
  };
}

/**
 * Memindahkan satu token legacy dari .env ke SecretStore. Secret ditulis lebih
 * dahulu; crash sebelum rewrite .env menyisakan duplikasi yang aman untuk
 * dicoba ulang, bukan kehilangan credential.
 */
export async function migratePrimaryTelegramBotCredentialFromEnvironment(
  options: {
    environment?: NodeJS.ProcessEnv;
    paths?: PrimaryChannelCredentialPaths;
  } = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const paths = options.paths ?? primaryChannelCredentialPaths();
  const environmentToken = optionalTelegramBotToken(
    environment.TELEGRAM_BOT_TOKEN,
  );
  if (environmentToken === null) {
    throw primaryCredentialError(
      "PRIMARY_TELEGRAM_ENVIRONMENT_MISSING",
      "Token Telegram utama tidak ditemukan di environment.",
    );
  }
  const file = await readEnvironmentToken(paths.environmentFile);
  if (
    file.entryCount !== 1 ||
    file.token === null ||
    !secretEqual(environmentToken, file.token)
  ) {
    throw primaryCredentialError(
      "PRIMARY_TELEGRAM_ENVIRONMENT_AMBIGUOUS",
      "Sumber token Telegram utama tidak dapat dimigrasikan otomatis.",
    );
  }
  const current = await loadPrimaryTelegramBotCredential(paths);
  if (current && !secretEqual(current.botToken, environmentToken)) {
    throw primaryCredentialError(
      "PRIMARY_TELEGRAM_CREDENTIAL_CONFLICT",
      "Credential Console dan environment berbeda.",
    );
  }

  await savePrimaryTelegramBotCredential({
    version: 1,
    botToken: environmentToken,
  }, paths);
  const rewritten = removeTelegramEnvironmentLine(file.contents);
  await writeDurableFileAtomic(paths.environmentFile, rewritten);
  await chmod(paths.environmentFile, 0o600).catch(() => undefined);
  delete environment.TELEGRAM_BOT_TOKEN;
}

/** Memindahkan konfigurasi akun WhatsApp legacy setelah sesi diverifikasi caller. */
export async function migratePrimaryWhatsAppFleetFromEnvironment(
  options: {
    environment?: NodeJS.ProcessEnv;
    paths?: PrimaryChannelCredentialPaths;
  } = {},
): Promise<PrimaryWhatsAppFleetCredential> {
  const environment = options.environment ?? process.env;
  const paths = options.paths ?? primaryChannelCredentialPaths();
  let candidate: PrimaryWhatsAppFleetCredential;
  try {
    candidate = legacyPrimaryWhatsAppFleetCredential(environment) ??
      (() => {
        throw primaryCredentialError(
          "PRIMARY_WHATSAPP_ENVIRONMENT_MISSING",
          "Konfigurasi WhatsApp layanan tidak ditemukan di environment.",
        );
      })();
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    throw primaryCredentialError(
      "PRIMARY_WHATSAPP_ENVIRONMENT_INVALID",
      "Konfigurasi WhatsApp layanan di environment tidak sah.",
    );
  }
  const status = await primaryWhatsAppEnvironmentStatus(environment, paths);
  if (!status.migratable) {
    throw primaryCredentialError(
      "PRIMARY_WHATSAPP_ENVIRONMENT_AMBIGUOUS",
      "Sumber konfigurasi WhatsApp layanan tidak dapat dimigrasikan otomatis.",
    );
  }
  const current = await loadPrimaryWhatsAppFleetCredential(paths);
  if (current && !samePrimaryWhatsAppFleet(current, candidate)) {
    throw primaryCredentialError(
      "PRIMARY_WHATSAPP_CREDENTIAL_CONFLICT",
      "Konfigurasi WhatsApp Console dan environment berbeda.",
    );
  }
  await savePrimaryWhatsAppFleetCredential(candidate, paths);
  const file = await readWhatsAppEnvironment(paths.environmentFile);
  await writeDurableFileAtomic(
    paths.environmentFile,
    removeWhatsAppEnvironmentLines(file.contents),
  );
  await chmod(paths.environmentFile, 0o600).catch(() => undefined);
  for (const key of PRIMARY_WHATSAPP_ENV_KEYS) delete environment[key];
  return candidate;
}

/** Runtime utama memakai Console-managed credential; env tetap fallback legacy. */
export function resolvePrimaryTelegramBotToken(
  environment: NodeJS.ProcessEnv = process.env,
  paths = primaryChannelCredentialPaths(),
): string {
  const environmentToken = optionalTelegramBotToken(
    environment.TELEGRAM_BOT_TOKEN,
  );
  if (environment.HARVY_TELEGRAM_TOKEN_EPHEMERAL === "live-acceptance-v1") {
    if (environmentToken === null) {
      throw primaryCredentialError(
        "CONFIG_TELEGRAM_TOKEN_MISSING",
        "Token Telegram ephemeral belum tersedia.",
      );
    }
    return environmentToken;
  }

  const managed = loadPrimaryTelegramBotCredentialSync(paths);
  if (
    managed && environmentToken &&
    !secretEqual(managed.botToken, environmentToken)
  ) {
    throw primaryCredentialError(
      "CONFIG_TELEGRAM_CREDENTIAL_SOURCE_CONFLICT",
      "Credential Telegram utama di Console dan environment berbeda.",
    );
  }
  if (managed) return managed.botToken;
  if (environmentToken) return environmentToken;
  throw primaryCredentialError(
    "CONFIG_TELEGRAM_TOKEN_MISSING",
    "Token Telegram utama belum diatur. Jalankan npm run console:setup.",
  );
}

/** Runtime memakai armada Console; environment hanya fallback legacy/acceptance. */
export function resolvePrimaryWhatsAppFleetCredential(
  environment: NodeJS.ProcessEnv = process.env,
  paths = primaryChannelCredentialPaths(),
): PrimaryWhatsAppFleetCredential | null {
  if (environment.HARVY_WHATSAPP_CONFIG_EPHEMERAL === "live-acceptance-v1") {
    return legacyPrimaryWhatsAppFleetCredential(environment);
  }
  const managed = loadPrimaryWhatsAppFleetCredentialSync(paths);
  const legacy = legacyPrimaryWhatsAppFleetCredential(environment);
  if (managed && primaryWhatsAppEnvironmentDeclared(environment)) {
    throw primaryCredentialError(
      "CONFIG_WHATSAPP_CREDENTIAL_SOURCE_CONFLICT",
      "Konfigurasi WhatsApp layanan tersedia di Console dan environment. Pindahkan atau hapus sumber legacy melalui npm run console:setup.",
    );
  }
  return managed ?? legacy;
}

export function primaryTelegramBotToken(value: string): string {
  const normalized = value.trim();
  if (!PRIMARY_TELEGRAM_BOT_TOKEN_PATTERN.test(normalized)) {
    throw primaryCredentialError(
      "PRIMARY_TELEGRAM_BOT_TOKEN_INVALID",
      "Format token bot Telegram utama tidak sah.",
    );
  }
  return normalized;
}

async function openPrimaryChannelStore(
  paths: PrimaryChannelCredentialPaths,
): Promise<EncryptedFileSecretStore> {
  const key = await loadOrCreatePrimaryChannelKey(paths.keyFile);
  await assertRegularCredentialFile(
    paths.secretFile,
    "PRIMARY_CHANNEL_SECRET_FILE_INVALID",
  );
  return new EncryptedFileSecretStore(paths.secretFile, key);
}

function withPrimaryChannelFileAccess<T>(
  paths: PrimaryChannelCredentialPaths,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(paths.secretFile);
  const previous = PRIMARY_CHANNEL_FILE_QUEUES.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => undefined, () => undefined);
  PRIMARY_CHANNEL_FILE_QUEUES.set(key, settled);
  void settled.then(() => {
    if (PRIMARY_CHANNEL_FILE_QUEUES.get(key) === settled) {
      PRIMARY_CHANNEL_FILE_QUEUES.delete(key);
    }
  });
  return result;
}

async function loadOrCreatePrimaryChannelKey(file: string): Promise<Buffer> {
  const target = resolve(file);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw primaryCredentialError(
      "PRIMARY_CHANNEL_SECRET_DIRECTORY_INVALID",
      "Direktori secret kanal utama tidak sah.",
    );
  }
  try {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(`${randomBytes(32).toString("base64url")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  return readPrimaryChannelKey(target);
}

function loadPrimaryChannelKeySync(
  paths: PrimaryChannelCredentialPaths,
): Buffer | null {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(paths.keyFile);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      assertRegularCredentialFileSync(
        paths.secretFile,
        "PRIMARY_CHANNEL_SECRET_FILE_INVALID",
      );
      try {
        readFileSync(paths.secretFile);
      } catch (secretError) {
        if (isNodeError(secretError) && secretError.code === "ENOENT") return null;
      }
      throw primaryCredentialError(
        "PRIMARY_CHANNEL_KEY_FILE_MISSING",
        "Kunci credential kanal utama tidak tersedia.",
      );
    }
    throw error;
  }
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
  ) {
    throw primaryCredentialError(
      "PRIMARY_CHANNEL_KEY_FILE_INVALID",
      "Kunci credential kanal utama tidak sah.",
    );
  }
  const encoded = readFileSync(paths.keyFile, "utf8").trim();
  return decodePrimaryChannelKey(encoded);
}

async function readPrimaryChannelKey(file: string): Promise<Buffer> {
  const metadata = await lstat(file);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
  ) {
    throw primaryCredentialError(
      "PRIMARY_CHANNEL_KEY_FILE_INVALID",
      "Kunci credential kanal utama tidak sah.",
    );
  }
  return decodePrimaryChannelKey((await readFile(file, "utf8")).trim());
}

async function assertRegularCredentialFile(
  file: string,
  code: string,
): Promise<void> {
  const metadata = await lstat(file).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return;
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
  ) {
    throw primaryCredentialError(code, "Berkas credential kanal utama tidak sah.");
  }
}

function assertRegularCredentialFileSync(file: string, code: string): void {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
  ) {
    throw primaryCredentialError(code, "Berkas credential kanal utama tidak sah.");
  }
}

function decodePrimaryChannelKey(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) {
    throw primaryCredentialError(
      "PRIMARY_CHANNEL_KEY_FILE_INVALID",
      "Kunci credential kanal utama tidak sah.",
    );
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== encoded) {
    throw primaryCredentialError(
      "PRIMARY_CHANNEL_KEY_FILE_INVALID",
      "Kunci credential kanal utama tidak sah.",
    );
  }
  return key;
}

async function readEnvironmentToken(file: string): Promise<{
  contents: string;
  token: string | null;
  entryCount: number;
}> {
  const metadata = await lstat(file).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return { contents: "", token: null, entryCount: 0 };
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
  ) {
    throw primaryCredentialError(
      "PRIMARY_TELEGRAM_ENVIRONMENT_FILE_INVALID",
      "Berkas environment tidak sah.",
    );
  }
  const contents = await readFile(file, "utf8");
  const entryCount = contents.split(/\r?\n/u)
    .filter((line) => PRIMARY_TELEGRAM_ENV_LINE.test(line)).length;
  let token: string | null = null;
  if (entryCount > 0) {
    try {
      token = optionalTelegramBotToken(
        parseEnv(contents).TELEGRAM_BOT_TOKEN,
      );
    } catch {
      throw primaryCredentialError(
        "PRIMARY_TELEGRAM_ENVIRONMENT_FILE_INVALID",
        "Berkas environment tidak dapat dibaca dengan aman.",
      );
    }
  }
  return { contents, token, entryCount };
}

function removeTelegramEnvironmentLine(contents: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = /\r?\n$/u.test(contents);
  const filtered = contents.split(/\r?\n/u)
    .filter((line) => !PRIMARY_TELEGRAM_ENV_LINE.test(line));
  if (finalNewline && filtered.at(-1) === "") filtered.pop();
  const rewritten = filtered.join(newline);
  return finalNewline ? `${rewritten}${newline}` : rewritten;
}

function validatePrimaryTelegramBotCredential(
  value: PrimaryTelegramBotCredential,
): PrimaryTelegramBotCredential {
  if (!value || value.version !== 1) {
    throw primaryCredentialError(
      "PRIMARY_TELEGRAM_CREDENTIAL_INVALID",
      "Credential Telegram utama tidak sah.",
    );
  }
  return { version: 1, botToken: primaryTelegramBotToken(value.botToken) };
}

function parsePrimaryTelegramBotCredential(
  value: string,
): PrimaryTelegramBotCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw primaryCredentialError(
      "PRIMARY_TELEGRAM_CREDENTIAL_INVALID",
      "Credential Telegram utama tidak sah.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw primaryCredentialError(
      "PRIMARY_TELEGRAM_CREDENTIAL_INVALID",
      "Credential Telegram utama tidak sah.",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "version" && key !== "botToken") ||
    record["version"] !== 1 ||
    typeof record["botToken"] !== "string"
  ) {
    throw primaryCredentialError(
      "PRIMARY_TELEGRAM_CREDENTIAL_INVALID",
      "Credential Telegram utama tidak sah.",
    );
  }
  return validatePrimaryTelegramBotCredential({
    version: 1,
    botToken: record["botToken"],
  });
}

function validatePrimaryWhatsAppFleetCredential(
  value: PrimaryWhatsAppFleetCredential,
): PrimaryWhatsAppFleetCredential {
  if (
    !value || value.version !== 1 ||
    typeof value.enabled !== "boolean" ||
    typeof value.privateEnabled !== "boolean" ||
    !Array.isArray(value.accounts)
  ) {
    throw primaryCredentialError(
      "PRIMARY_WHATSAPP_FLEET_INVALID",
      "Konfigurasi armada WhatsApp layanan tidak sah.",
    );
  }
  const seen = new Set<string>();
  const phones = new Set<string>();
  const accounts = value.accounts.map((account) => {
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      throw primaryCredentialError(
        "PRIMARY_WHATSAPP_FLEET_INVALID",
        "Konfigurasi akun WhatsApp layanan tidak sah.",
      );
    }
    const keys = Object.keys(account);
    if (keys.some((key) => !["id", "phoneNumber", "state"].includes(key))) {
      throw primaryCredentialError(
        "PRIMARY_WHATSAPP_FLEET_INVALID",
        "Konfigurasi akun WhatsApp layanan memuat field yang tidak dikenal.",
      );
    }
    let id: string;
    try {
      id = parseWhatsAppAccountAlias(account.id);
    } catch {
      throw primaryCredentialError(
        "PRIMARY_WHATSAPP_ACCOUNT_ALIAS_INVALID",
        "Alias akun WhatsApp layanan tidak sah.",
      );
    }
    const folded = id.toLocaleLowerCase("en-US");
    if (seen.has(folded)) {
      throw primaryCredentialError(
        "PRIMARY_WHATSAPP_ACCOUNT_ALIAS_DUPLICATE",
        "Alias akun WhatsApp layanan harus unik.",
      );
    }
    seen.add(folded);
    if (!["active", "pending", "removing"].includes(account.state)) {
      throw primaryCredentialError(
        "PRIMARY_WHATSAPP_ACCOUNT_STATE_INVALID",
        "Status akun WhatsApp layanan tidak sah.",
      );
    }
    let phoneNumber: string | null = null;
    if (account.phoneNumber !== null) {
      try {
        phoneNumber = parseWhatsAppPhoneNumber(account.phoneNumber);
      } catch {
        throw primaryCredentialError(
          "PRIMARY_WHATSAPP_PHONE_INVALID",
          "Identitas akun WhatsApp layanan tidak sah.",
        );
      }
      if (phones.has(phoneNumber)) {
        throw primaryCredentialError(
          "PRIMARY_WHATSAPP_PHONE_DUPLICATE",
          "Identitas akun WhatsApp layanan harus unik.",
        );
      }
      phones.add(phoneNumber);
    }
    if (account.state === "active" && phoneNumber === null) {
      throw primaryCredentialError(
        "PRIMARY_WHATSAPP_ACTIVE_IDENTITY_MISSING",
        "Akun WhatsApp aktif harus memiliki identitas terverifikasi.",
      );
    }
    return {
      id,
      phoneNumber,
      state: account.state,
    } as PrimaryWhatsAppFleetAccount;
  });
  return {
    version: 1,
    enabled: value.enabled,
    privateEnabled: value.privateEnabled,
    accounts,
  };
}

function parsePrimaryWhatsAppFleetCredential(
  value: string,
): PrimaryWhatsAppFleetCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw primaryCredentialError(
      "PRIMARY_WHATSAPP_FLEET_INVALID",
      "Konfigurasi armada WhatsApp layanan tidak sah.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw primaryCredentialError(
      "PRIMARY_WHATSAPP_FLEET_INVALID",
      "Konfigurasi armada WhatsApp layanan tidak sah.",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).some((key) =>
      !["version", "enabled", "privateEnabled", "accounts"].includes(key)
    ) ||
    record["version"] !== 1 ||
    typeof record["enabled"] !== "boolean" ||
    typeof record["privateEnabled"] !== "boolean" ||
    !Array.isArray(record["accounts"])
  ) {
    throw primaryCredentialError(
      "PRIMARY_WHATSAPP_FLEET_INVALID",
      "Konfigurasi armada WhatsApp layanan tidak sah.",
    );
  }
  return validatePrimaryWhatsAppFleetCredential(
    parsed as PrimaryWhatsAppFleetCredential,
  );
}

function legacyPrimaryWhatsAppFleetCredential(
  environment: NodeJS.ProcessEnv,
): PrimaryWhatsAppFleetCredential | null {
  if (!primaryWhatsAppEnvironmentDeclared(environment)) return null;
  return validatePrimaryWhatsAppFleetCredential({
    version: 1,
    enabled: parseEnabled(environment.WHATSAPP_ENABLED),
    privateEnabled: parsePrivateEnabled(environment.WHATSAPP_PRIVATE_ENABLED),
    accounts: parseWhatsAppAccounts(environment.WHATSAPP_ACCOUNTS).map(
      (account) => ({ ...account, state: "active" as const }),
    ),
  });
}

export function primaryWhatsAppFleetFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PrimaryWhatsAppFleetCredential | null {
  return legacyPrimaryWhatsAppFleetCredential(environment);
}

function primaryWhatsAppEnvironmentDeclared(
  environment: NodeJS.ProcessEnv,
): boolean {
  return PRIMARY_WHATSAPP_ENV_KEYS.some((key) =>
    Boolean(environment[key]?.trim())
  );
}

async function readWhatsAppEnvironment(file: string): Promise<{
  contents: string;
  entryCount: number;
  entriesUnique: boolean;
  configuration: PrimaryWhatsAppFleetCredential | null;
}> {
  const metadata = await lstat(file).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) {
    return {
      contents: "",
      entryCount: 0,
      entriesUnique: true,
      configuration: null,
    };
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw primaryCredentialError(
      "PRIMARY_WHATSAPP_ENVIRONMENT_FILE_INVALID",
      "Berkas environment tidak sah.",
    );
  }
  const contents = await readFile(file, "utf8");
  const counts = new Map<string, number>();
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^\uFEFF?\s*(?:export\s+)?(WHATSAPP_ENABLED|WHATSAPP_PRIVATE_ENABLED|WHATSAPP_ACCOUNTS)\s*=/u.exec(line);
    if (match?.[1]) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  let parsed: NodeJS.ProcessEnv;
  try {
    parsed = parseEnv(contents);
  } catch {
    throw primaryCredentialError(
      "PRIMARY_WHATSAPP_ENVIRONMENT_FILE_INVALID",
      "Berkas environment tidak dapat dibaca dengan aman.",
    );
  }
  let configuration: PrimaryWhatsAppFleetCredential | null = null;
  try {
    configuration = legacyPrimaryWhatsAppFleetCredential(parsed);
  } catch {
    configuration = null;
  }
  return {
    contents,
    entryCount: [...counts.values()].reduce((sum, value) => sum + value, 0),
    entriesUnique: [...counts.values()].every((value) => value === 1),
    configuration,
  };
}

function removeWhatsAppEnvironmentLines(contents: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = /\r?\n$/u.test(contents);
  const filtered = contents.split(/\r?\n/u)
    .filter((line) => !PRIMARY_WHATSAPP_ENV_LINE.test(line));
  if (finalNewline && filtered.at(-1) === "") filtered.pop();
  const rewritten = filtered.join(newline);
  return finalNewline ? `${rewritten}${newline}` : rewritten;
}

function samePrimaryWhatsAppFleet(
  left: PrimaryWhatsAppFleetCredential,
  right: PrimaryWhatsAppFleetCredential,
): boolean {
  return JSON.stringify(validatePrimaryWhatsAppFleetCredential(left)) ===
    JSON.stringify(validatePrimaryWhatsAppFleetCredential(right));
}

function optionalTelegramBotToken(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  return primaryTelegramBotToken(value);
}

function secretEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes);
}

function primaryCredentialError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
