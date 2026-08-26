import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GitHubAppBackend } from "./github-app/github-app-backend.js";
import { GitHubBrokerServiceHandler } from "./github-app/github-broker-service-handler.js";
import { GitHubInstallationCallbackServer } from "./github-app/github-installation-callback-server.js";
import { TrustDomainHttpServer } from "./transport/trust-domain-http-server.js";
import { loadManagedGitHubBrokerServiceConfigurationSync } from
  "./operations/coding-runtime-setup.js";

async function main(): Promise<void> {
  rejectForeignCredentials(process.env);
  const config = await loadConfig();
  const backend = new GitHubAppBackend({
    dataRoot: config.dataRoot,
    appId: config.appId,
    appSlug: config.appSlug,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    privateKeyPem: config.privateKey,
    callbackUrl: config.callbackUrl,
    stateSecret: config.stateSecret,
    gitCommand: config.gitCommand,
    commandEnvironment: config.commandEnvironment,
  });
  await backend.initialize();
  const health = await backend.health();
  if (!health.available) throw new Error("GITHUB_APP_CONFORMANCE_UNAVAILABLE");
  const rpc = new TrustDomainHttpServer({
    protocol: "harvy-github-broker/1",
    host: config.rpcHost,
    port: config.rpcPort,
    identities: [{ keyId: config.hmacKeyId, secret: config.hmacSecret }],
    handler: new GitHubBrokerServiceHandler(backend),
    ...(config.rpcPublicOrigin ? { publicOrigin: config.rpcPublicOrigin } : {}),
    ...(config.rpcTls ? { tls: config.rpcTls } : {}),
    maxContentBytes: 256 * 1024 * 1024,
  });
  const callback = new GitHubInstallationCallbackServer({
    host: config.callbackHost,
    port: config.callbackPort,
    backend,
    ...(config.callbackPublicOrigin ? { publicOrigin: config.callbackPublicOrigin } : {}),
    ...(config.callbackTls ? { tls: config.callbackTls } : {}),
  });
  const [rpcAddress, callbackAddress] = await Promise.all([rpc.start(), callback.start()]);
  process.stdout.write(
    `${new Date().toISOString()} INFO github_broker_ready rpc=${rpcAddress.origin} callback=${callbackAddress.origin}\n`,
  );
  await waitForShutdown(rpc, callback);
}

interface ServiceConfig {
  dataRoot: string;
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKey: Buffer;
  stateSecret: Buffer;
  callbackUrl: string;
  gitCommand: string;
  commandEnvironment: Readonly<Record<string, string>>;
  hmacKeyId: string;
  hmacSecret: Buffer;
  rpcHost: string;
  rpcPort: number;
  rpcPublicOrigin: string | null;
  rpcTls: { key: Buffer; cert: Buffer } | null;
  callbackHost: string;
  callbackPort: number;
  callbackPublicOrigin: string | null;
  callbackTls: { key: Buffer; cert: Buffer } | null;
}

async function loadConfig(): Promise<ServiceConfig> {
  const managed = loadManagedGitHubBrokerServiceConfigurationSync();
  if (managed) {
    const clientSecret = (await secureFile(
      managed.clientSecretFile,
      16 * 1_024,
    )).toString("utf8").trim();
    if (
      clientSecret.length < 8 || clientSecret.length > 8_192 ||
      /[\r\n\0]/u.test(clientSecret)
    ) throw new Error("GITHUB_APP_CLIENT_SECRET_INVALID");
    return {
      dataRoot: managed.dataRoot,
      appId: managed.appId,
      appSlug: managed.appSlug,
      clientId: managed.clientId,
      clientSecret,
      privateKey: await secureFile(managed.privateKeyFile, 128 * 1_024),
      stateSecret: decodeSecret(
        await secureFile(managed.stateSecretFile, 16 * 1_024),
        "GITHUB_APP_STATE_SECRET_INVALID",
      ),
      callbackUrl: managed.callbackUrl,
      gitCommand: managed.gitCommand,
      commandEnvironment: commandEnvironment(),
      hmacKeyId: managed.hmacKeyId,
      hmacSecret: decodeSecret(
        await secureFile(managed.hmacSecretFile, 16 * 1_024),
        "GITHUB_BROKER_HMAC_SECRET_INVALID",
      ),
      rpcHost: managed.rpcHost,
      rpcPort: managed.rpcPort,
      rpcPublicOrigin: managed.rpcPublicOrigin,
      rpcTls: null,
      callbackHost: managed.callbackHost,
      callbackPort: managed.callbackPort,
      callbackPublicOrigin: managed.callbackPublicOrigin,
      callbackTls: null,
    };
  }
  const rpcTls = await tlsPair("HARVY_GITHUB_BROKER_RPC_TLS_KEY_FILE", "HARVY_GITHUB_BROKER_RPC_TLS_CERT_FILE");
  const callbackTls = await tlsPair(
    "HARVY_GITHUB_BROKER_CALLBACK_TLS_KEY_FILE",
    "HARVY_GITHUB_BROKER_CALLBACK_TLS_CERT_FILE",
  );
  const clientSecret = (await secureFile(
    requiredPath("HARVY_GITHUB_APP_CLIENT_SECRET_FILE"),
    16 * 1_024,
  )).toString("utf8").trim();
  if (clientSecret.length < 8 || clientSecret.length > 8_192 || /[\r\n\0]/u.test(clientSecret)) {
    throw new Error("GITHUB_APP_CLIENT_SECRET_INVALID");
  }
  const stateSecret = decodeSecret(await secureFile(
    requiredPath("HARVY_GITHUB_APP_STATE_SECRET_FILE"),
    16 * 1_024,
  ), "GITHUB_APP_STATE_SECRET_INVALID");
  const hmacSecret = decodeSecret(await secureFile(
    requiredPath("HARVY_GITHUB_BROKER_HMAC_SECRET_FILE"),
    16 * 1_024,
  ), "GITHUB_BROKER_HMAC_SECRET_INVALID");
  return {
    dataRoot: requiredPath("HARVY_GITHUB_BROKER_DATA_ROOT"),
    appId: requiredText("HARVY_GITHUB_APP_ID", /^\d{1,20}$/u),
    appSlug: requiredText("HARVY_GITHUB_APP_SLUG", /^[a-z0-9][a-z0-9-]{0,99}$/u),
    clientId: requiredText("HARVY_GITHUB_APP_CLIENT_ID", /^[A-Za-z0-9_.-]{4,256}$/u),
    clientSecret,
    privateKey: await secureFile(requiredPath("HARVY_GITHUB_APP_PRIVATE_KEY_FILE"), 128 * 1_024),
    stateSecret,
    callbackUrl: requiredText("HARVY_GITHUB_APP_CALLBACK_URL", /^https:\/\/[^\s]+$/u),
    gitCommand: process.env.HARVY_GITHUB_BROKER_GIT_COMMAND?.trim() || "git",
    commandEnvironment: commandEnvironment(),
    hmacKeyId: requiredText("HARVY_GITHUB_BROKER_HMAC_KEY_ID", /^[A-Za-z0-9_-]{3,64}$/u),
    hmacSecret,
    rpcHost: process.env.HARVY_GITHUB_BROKER_RPC_LISTEN_HOST?.trim() || "127.0.0.1",
    rpcPort: integerEnv("HARVY_GITHUB_BROKER_RPC_LISTEN_PORT", 8445),
    rpcPublicOrigin: process.env.HARVY_GITHUB_BROKER_RPC_PUBLIC_ORIGIN?.trim() || null,
    rpcTls,
    callbackHost: process.env.HARVY_GITHUB_BROKER_CALLBACK_LISTEN_HOST?.trim() || "127.0.0.1",
    callbackPort: integerEnv("HARVY_GITHUB_BROKER_CALLBACK_LISTEN_PORT", 8446),
    callbackPublicOrigin: process.env.HARVY_GITHUB_BROKER_CALLBACK_PUBLIC_ORIGIN?.trim() || null,
    callbackTls,
  };
}

function commandEnvironment(): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR"] as const) {
    const value = process.env[name]?.trim();
    if (value) result[name] = value;
  }
  return result;
}

async function tlsPair(
  keyName: string,
  certName: string,
): Promise<{ key: Buffer; cert: Buffer } | null> {
  const keyPath = optionalPath(keyName);
  const certPath = optionalPath(certName);
  if (Boolean(keyPath) !== Boolean(certPath)) throw new Error("GITHUB_BROKER_TLS_CONFIG_INVALID");
  return keyPath && certPath
    ? {
        key: await secureFile(keyPath, 1024 * 1024),
        cert: await secureFile(certPath, 1024 * 1024),
      }
    : null;
}

async function waitForShutdown(
  rpc: TrustDomainHttpServer,
  callback: GitHubInstallationCallbackServer,
): Promise<void> {
  await new Promise<void>((resolveDone, rejectDone) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void Promise.all([rpc.close(), callback.close()]).then(() => resolveDone(), rejectDone);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function rejectForeignCredentials(environment: NodeJS.ProcessEnv): void {
  const forbidden = [
    /^OPENAI_/u,
    /^OPENROUTER_/u,
    /^TELEGRAM_/u,
    /^WHATSAPP_/u,
    /^WA_/u,
    /^(?:GH|GITHUB)_TOKEN$/u,
    /^(?:DATABASE_URL|PGPASSWORD|MYSQL_PWD|REDIS_URL)$/u,
  ];
  const found = Object.keys(environment).find((name) =>
    environment[name] !== undefined && forbidden.some((pattern) => pattern.test(name))
  );
  if (found) throw new Error("GITHUB_BROKER_FOREIGN_CREDENTIAL_PRESENT");
}

async function secureFile(path: string, maximum: number): Promise<Buffer> {
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink() || state.size < 1 || state.size > maximum) {
    throw new Error("GITHUB_BROKER_SECURE_FILE_INVALID");
  }
  return readFile(path);
}

function decodeSecret(bytes: Buffer, code: string): Buffer {
  const text = bytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{43,5462}$/u.test(text)) throw new Error(code);
  const secret = Buffer.from(text, "base64url");
  if (secret.byteLength < 32 || secret.byteLength > 4_096) throw new Error(code);
  return secret;
}

function requiredPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CONFIG_MISSING_${name}`);
  return resolve(value);
}

function optionalPath(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? resolve(value) : null;
}

function requiredText(name: string, pattern: RegExp): string {
  const value = process.env[name]?.trim();
  if (!value || !pattern.test(value)) throw new Error(`CONFIG_INVALID_${name}`);
  return value;
}

function integerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? String(fallback));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`CONFIG_INVALID_${name}`);
  }
  return value;
}

await main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]{3,100}$/u.test(error.message)
    ? error.message
    : "GITHUB_BROKER_SERVICE_FAILED";
  process.stderr.write(`${new Date().toISOString()} FATAL github_broker_service code=${code}\n`);
  process.exitCode = 1;
});
