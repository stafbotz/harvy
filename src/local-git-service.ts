import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LocalGitBackend } from "./local-git/local-git-backend.js";
import { LocalGitServiceHandler } from "./local-git/local-git-service-handler.js";
import { TrustDomainHttpServer } from "./transport/trust-domain-http-server.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const backend = new LocalGitBackend({
    dataRoot: config.dataRoot,
    gitCommand: config.gitCommand,
    commandEnvironment: config.commandEnvironment,
  });
  await backend.initialize();
  if (!(await backend.health()).available) throw new Error("LOCAL_GIT_CONFORMANCE_UNAVAILABLE");
  const server = new TrustDomainHttpServer({
    protocol: "harvy-local-git/1",
    host: config.host,
    port: config.port,
    identities: [{ keyId: config.keyId, secret: config.secret }],
    handler: new LocalGitServiceHandler(backend),
    ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
    ...(config.tls ? { tls: config.tls } : {}),
  });
  const address = await server.start();
  process.stdout.write(`${new Date().toISOString()} INFO local_git_service_ready origin=${address.origin}\n`);
  await waitForShutdown(server);
}

interface ServiceConfig {
  host: string;
  port: number;
  publicOrigin: string | null;
  keyId: string;
  secret: Buffer;
  dataRoot: string;
  gitCommand: string;
  commandEnvironment: Readonly<Record<string, string>>;
  tls: { key: Buffer; cert: Buffer } | null;
}

async function loadConfig(): Promise<ServiceConfig> {
  const keyFile = optionalPath("HARVY_LOCAL_GIT_TLS_KEY_FILE");
  const certFile = optionalPath("HARVY_LOCAL_GIT_TLS_CERT_FILE");
  if (Boolean(keyFile) !== Boolean(certFile)) throw new Error("LOCAL_GIT_TLS_CONFIG_INVALID");
  const secretText = (await secureFile(requiredPath("HARVY_LOCAL_GIT_HMAC_SECRET_FILE"), 16 * 1_024))
    .toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{43,5462}$/u.test(secretText)) {
    throw new Error("LOCAL_GIT_SERVICE_IDENTITY_INVALID");
  }
  const secret = Buffer.from(secretText, "base64url");
  if (secret.byteLength < 32 || secret.byteLength > 4_096) {
    throw new Error("LOCAL_GIT_SERVICE_IDENTITY_INVALID");
  }
  const commandEnvironment: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR"] as const) {
    const value = process.env[name]?.trim();
    if (value) commandEnvironment[name] = value;
  }
  return {
    host: process.env.HARVY_LOCAL_GIT_LISTEN_HOST?.trim() || "127.0.0.1",
    port: integerEnv("HARVY_LOCAL_GIT_LISTEN_PORT", 8444),
    publicOrigin: process.env.HARVY_LOCAL_GIT_PUBLIC_ORIGIN?.trim() || null,
    keyId: requiredText("HARVY_LOCAL_GIT_HMAC_KEY_ID", /^[A-Za-z0-9_-]{3,64}$/u),
    secret,
    dataRoot: requiredPath("HARVY_LOCAL_GIT_DATA_ROOT"),
    gitCommand: process.env.HARVY_LOCAL_GIT_COMMAND?.trim() || "git",
    commandEnvironment,
    tls: keyFile && certFile
      ? {
          key: await secureFile(keyFile, 1024 * 1024),
          cert: await secureFile(certFile, 1024 * 1024),
        }
      : null,
  };
}

async function waitForShutdown(server: TrustDomainHttpServer): Promise<void> {
  await new Promise<void>((resolveDone, rejectDone) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void server.close().then(resolveDone, rejectDone);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function secureFile(path: string, maximum: number): Promise<Buffer> {
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink() || state.size < 1 || state.size > maximum) {
    throw new Error("LOCAL_GIT_SECURE_FILE_INVALID");
  }
  return readFile(path);
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
    : "LOCAL_GIT_SERVICE_FAILED";
  process.stderr.write(`${new Date().toISOString()} FATAL local_git_service code=${code}\n`);
  process.exitCode = 1;
});
