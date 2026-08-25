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

const PRIMARY_TELEGRAM_BOT_SECRET_REF = "primary.telegram.bot.v1";
const PRIMARY_TELEGRAM_BOT_TOKEN_PATTERN =
  /^\d{5,20}:[A-Za-z0-9_-]{20,160}$/u;
const PRIMARY_TELEGRAM_ENV_LINE =
  /^\uFEFF?\s*(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=/u;

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
  const store = await openPrimaryChannelStore(paths);
  await store.put(PRIMARY_TELEGRAM_BOT_SECRET_REF, JSON.stringify(validated));
}

export async function loadPrimaryTelegramBotCredential(
  paths = primaryChannelCredentialPaths(),
): Promise<PrimaryTelegramBotCredential | null> {
  const store = await openPrimaryChannelStore(paths);
  const value = await store.get(PRIMARY_TELEGRAM_BOT_SECRET_REF);
  return value === null ? null : parsePrimaryTelegramBotCredential(value);
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
  const store = await openPrimaryChannelStore(paths);
  await store.delete(PRIMARY_TELEGRAM_BOT_SECRET_REF);
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
