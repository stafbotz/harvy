import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OciSandboxBackend } from "./sandbox/oci-sandbox-backend.js";
import { SandboxServiceHandler } from "./sandbox/sandbox-service-handler.js";
import { TrustDomainHttpServer } from "./transport/trust-domain-http-server.js";

const PROTOCOL = "harvy-sandbox/1";

async function main(): Promise<void> {
  const config = await loadSandboxServiceConfig();
  const backend = new OciSandboxBackend({
    dataRoot: config.dataRoot,
    image: config.image,
    seccompProfile: config.seccompProfile,
    ociCommand: config.ociCommand,
    tarCommand: config.tarCommand,
    commandEnvironment: config.commandEnvironment,
    serviceIdentityDigest: createHash("sha256")
      .update(`${PROTOCOL}\0${config.keyId}\0`, "utf8")
      .update(config.hmacSecret)
      .digest("hex"),
  });
  await backend.initialize();
  const initialHealth = await backend.health();
  if (!initialHealth.available) {
    throw new Error("SANDBOX_CONFORMANCE_UNAVAILABLE");
  }
  const server = new TrustDomainHttpServer({
    protocol: PROTOCOL,
    host: config.host,
    port: config.port,
    identities: [{ keyId: config.keyId, secret: config.hmacSecret }],
    handler: new SandboxServiceHandler(backend),
    ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
    ...(config.tls ? { tls: config.tls } : {}),
  });
  const address = await server.start();
  process.stdout.write(
    `${new Date().toISOString()} INFO sandbox_service_ready origin=${address.origin}\n`,
  );
  let stopping: Promise<void> | null = null;
  const stop = (): void => {
    if (stopping) return;
    stopping = (async () => {
      await server.close();
      await backend.shutdown();
    })();
    void stopping.then(
      () => { process.exitCode = 0; },
      () => { process.exitCode = 1; },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>((resolveDone, rejectDone) => {
    const interval = setInterval(() => {
      if (!stopping) return;
      clearInterval(interval);
      void stopping.then(resolveDone, rejectDone);
    }, 50);
  });
}

interface SandboxServiceConfig {
  host: string;
  port: number;
  publicOrigin: string | null;
  keyId: string;
  hmacSecret: Buffer;
  dataRoot: string;
  image: string;
  seccompProfile: string;
  ociCommand: string;
  tarCommand: string;
  commandEnvironment: Readonly<Record<string, string>>;
  tls: { key: Buffer; cert: Buffer } | null;
}

async function loadSandboxServiceConfig(): Promise<SandboxServiceConfig> {
  const tlsKeyFile = optionalPath("HARVY_SANDBOX_TLS_KEY_FILE");
  const tlsCertFile = optionalPath("HARVY_SANDBOX_TLS_CERT_FILE");
  if (Boolean(tlsKeyFile) !== Boolean(tlsCertFile)) {
    throw new Error("SANDBOX_TLS_CONFIG_INVALID");
  }
  const hmacBytes = await readSecureRegularFile(
    requiredPath("HARVY_SANDBOX_HMAC_SECRET_FILE"),
    16 * 1_024,
  );
  const encodedSecret = hmacBytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{43,5462}$/u.test(encodedSecret)) {
    throw new Error("SANDBOX_SERVICE_IDENTITY_INVALID");
  }
  const hmacSecret = Buffer.from(encodedSecret, "base64url");
  if (hmacSecret.byteLength < 32 || hmacSecret.byteLength > 4_096) {
    throw new Error("SANDBOX_SERVICE_IDENTITY_INVALID");
  }
  const commandEnvironment: Record<string, string> = {};
  for (const name of [
    "PATH", "HOME", "XDG_RUNTIME_DIR", "TMPDIR", "CONTAINERS_CONF", "STORAGE_CONF",
  ]) {
    const value = process.env[name]?.trim();
    if (value) commandEnvironment[name] = value;
  }
  return {
    host: process.env.HARVY_SANDBOX_LISTEN_HOST?.trim() || "127.0.0.1",
    port: positiveIntegerEnv("HARVY_SANDBOX_LISTEN_PORT", 8443, 65_535),
    publicOrigin: process.env.HARVY_SANDBOX_PUBLIC_ORIGIN?.trim() || null,
    keyId: requiredText("HARVY_SANDBOX_HMAC_KEY_ID", /^[A-Za-z0-9_-]{3,64}$/u),
    hmacSecret,
    dataRoot: requiredPath("HARVY_SANDBOX_DATA_ROOT"),
    image: requiredText(
      "HARVY_SANDBOX_IMAGE",
      /^[A-Za-z0-9][A-Za-z0-9._/:@-]+@sha256:[a-f0-9]{64}$/u,
    ),
    seccompProfile: requiredPath("HARVY_SANDBOX_SECCOMP_PROFILE"),
    ociCommand: process.env.HARVY_SANDBOX_OCI_COMMAND?.trim() || "podman",
    tarCommand: process.env.HARVY_SANDBOX_TAR_COMMAND?.trim() || "/usr/bin/tar",
    commandEnvironment,
    tls: tlsKeyFile && tlsCertFile
      ? {
          key: await readSecureRegularFile(tlsKeyFile, 1024 * 1024),
          cert: await readSecureRegularFile(tlsCertFile, 1024 * 1024),
        }
      : null,
  };
}

async function readSecureRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink() || state.size < 1 || state.size > maxBytes) {
    throw new Error("SANDBOX_SECURE_FILE_INVALID");
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

function positiveIntegerEnv(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? String(fallback));
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`CONFIG_INVALID_${name}`);
  }
  return value;
}

await main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]{3,100}$/u.test(error.message)
    ? error.message
    : "SANDBOX_SERVICE_FAILED";
  process.stderr.write(`${new Date().toISOString()} FATAL sandbox_service code=${code}\n`);
  process.exitCode = 1;
});
