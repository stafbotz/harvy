import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
} from "node:fs/promises";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  assertSandboxRuntimeMatchesConformanceReceipt,
  codingRuntimeConformanceReceiptDigest,
  loadCodingRuntimeConformanceReceipt,
  parseCodingRuntimeConformanceReceipt,
  PinnedCodingRuntimeConformanceVerifier,
} from "../core/pinned-coding-runtime-conformance.js";
import { writeDurableFileAtomic } from "../storage/durable-file.js";
import { HttpGitHubBrokerTransport } from
  "../transport/http-github-broker-transport.js";
import { HttpLocalGitTransport } from
  "../transport/http-local-git-transport.js";
import { HttpSandboxTransport } from "../transport/http-sandbox-transport.js";
import { HmacTrustDomainRequestProofProvider } from
  "../transport/trust-domain-http.js";
import type { SandboxHealth } from "../domain/sandbox.js";
import type { LocalGitHealth } from "../domain/local-git.js";
import type { GitHubBrokerHealth } from "../domain/github.js";

const CONFIG_VERSION = 1 as const;
const CONFIG_KEYS = ["version", "revision", "compute", "github", "updatedAt"];
const COMPUTE_KEYS = [
  "configured",
  "enabled",
  "allowInsecureLoopback",
  "codingAiPrivacyDomain",
  "stateRoot",
  "principalSecretFile",
  "conformanceReceiptFile",
  "conformanceReceiptSha256",
  "sandbox",
  "localGit",
  "verifiedRevision",
  "verifiedAt",
];
const GITHUB_KEYS = [
  "configured",
  "enabled",
  "broker",
  "app",
  "verifiedRevision",
  "verifiedAt",
];
const TRUST_KEYS = ["origin", "keyId", "secretFile"];
const APP_KEYS = [
  "dataRoot",
  "appId",
  "appSlug",
  "clientId",
  "clientSecretFile",
  "privateKeyFile",
  "stateSecretFile",
  "callbackUrl",
  "gitCommand",
  "rpcHost",
  "rpcPort",
  "rpcPublicOrigin",
  "callbackHost",
  "callbackPort",
  "callbackPublicOrigin",
];

export interface CodingRuntimeSetupPaths {
  configFile: string;
  environmentFile: string;
  stateRoot: string;
  principalSecretFile: string;
  sandboxSecretFile: string;
  localGitSecretFile: string;
  conformanceReceiptFile: string;
  githubBrokerSecretFile: string;
  githubClientSecretFile: string;
  githubPrivateKeyFile: string;
  githubStateSecretFile: string;
  githubDataRoot: string;
}

export interface ManagedTrustDomainConfiguration {
  origin: string;
  keyId: string;
  secretFile: string;
}

export interface ManagedComputeConfiguration {
  configured: boolean;
  enabled: boolean;
  allowInsecureLoopback: boolean;
  codingAiPrivacyDomain: string | null;
  stateRoot: string;
  principalSecretFile: string;
  conformanceReceiptFile: string | null;
  conformanceReceiptSha256: string | null;
  sandbox: ManagedTrustDomainConfiguration | null;
  localGit: ManagedTrustDomainConfiguration | null;
  verifiedRevision: number | null;
  verifiedAt: string | null;
}

export interface ManagedGitHubAppConfiguration {
  dataRoot: string;
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecretFile: string;
  privateKeyFile: string;
  stateSecretFile: string;
  callbackUrl: string;
  gitCommand: string;
  rpcHost: string;
  rpcPort: number;
  rpcPublicOrigin: string | null;
  callbackHost: string;
  callbackPort: number;
  callbackPublicOrigin: string;
}

export interface ManagedGitHubConfiguration {
  configured: boolean;
  enabled: boolean;
  broker: ManagedTrustDomainConfiguration | null;
  app: ManagedGitHubAppConfiguration | null;
  verifiedRevision: number | null;
  verifiedAt: string | null;
}

export interface ManagedCodingRuntimeSetup {
  version: 1;
  revision: number;
  compute: ManagedComputeConfiguration;
  github: ManagedGitHubConfiguration;
  updatedAt: string;
}

export interface ComputeSetupInput {
  sandboxOrigin: string;
  sandboxKeyId: string;
  sandboxHmacSecret?: string | null;
  localGitOrigin: string;
  localGitKeyId: string;
  localGitHmacSecret?: string | null;
  conformanceReceipt?: string | null;
  allowInsecureLoopback: boolean;
  codingAiPrivacyDomain?: string | null;
}

export interface GitHubSetupInput {
  brokerOrigin: string;
  brokerKeyId: string;
  brokerHmacSecret?: string | null;
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret?: string | null;
  privateKeyPem?: string | null;
  callbackUrl: string;
}

export interface CodingRuntimeSetupSnapshot {
  source: "console" | "none";
  revision: number;
  runtimeActive: boolean;
  restartRequired: boolean;
  compute: {
    configured: boolean;
    enabled: boolean;
    sandboxOrigin: string | null;
    sandboxKeyId: string | null;
    localGitOrigin: string | null;
    localGitKeyId: string | null;
    allowInsecureLoopback: boolean;
    codingAiPrivacyDomain: string | null;
    receiptConfigured: boolean;
    receiptExpiresAt: string | null;
    verifiedAt: string | null;
    verificationCurrent: boolean;
  };
  github: {
    configured: boolean;
    enabled: boolean;
    brokerOrigin: string | null;
    brokerKeyId: string | null;
    appId: string | null;
    appSlug: string | null;
    clientId: string | null;
    callbackUrl: string | null;
    callbackOrigin: string | null;
    credentialsStored: boolean;
    verifiedAt: string | null;
    verificationCurrent: boolean;
  };
}

export interface ManagedGitHubBrokerServiceConfiguration {
  dataRoot: string;
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecretFile: string;
  privateKeyFile: string;
  stateSecretFile: string;
  callbackUrl: string;
  gitCommand: string;
  hmacKeyId: string;
  hmacSecretFile: string;
  rpcHost: string;
  rpcPort: number;
  rpcPublicOrigin: string | null;
  callbackHost: string;
  callbackPort: number;
  callbackPublicOrigin: string;
}

export class CodingRuntimeSetupError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CodingRuntimeSetupError";
  }
}

export interface CodingRuntimeSetupProbes {
  compute(
    config: ManagedComputeConfiguration,
    signal: AbortSignal,
  ): Promise<{ sandbox: SandboxHealth; localGit: LocalGitHealth }>;
  github(
    broker: ManagedTrustDomainConfiguration,
    allowInsecureLoopback: boolean,
    signal: AbortSignal,
  ): Promise<GitHubBrokerHealth>;
}

export class CodingRuntimeSetupService {
  readonly #paths: CodingRuntimeSetupPaths;
  readonly #runtimeActive: boolean;
  readonly #now: () => Date;
  readonly #probes: CodingRuntimeSetupProbes;
  #changed = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    paths?: CodingRuntimeSetupPaths;
    runtimeActive?: boolean;
    now?: () => Date;
    probes?: CodingRuntimeSetupProbes;
  } = {}) {
    this.#paths = options.paths ?? codingRuntimeSetupPaths();
    this.#runtimeActive = options.runtimeActive === true;
    this.#now = options.now ?? (() => new Date());
    this.#probes = options.probes ?? DEFAULT_PROBES;
  }

  async initialize(): Promise<void> {
    await assertSafeSetupPaths(this.#paths);
  }

  async snapshot(): Promise<CodingRuntimeSetupSnapshot> {
    return setupSnapshot(await loadManagedCodingRuntimeSetup(this.#paths), {
      runtimeActive: this.#runtimeActive,
      changed: this.#changed,
    });
  }

  async saveCompute(input: ComputeSetupInput): Promise<CodingRuntimeSetupSnapshot> {
    return this.#exclusive(async () => {
      const current = await loadManagedCodingRuntimeSetup(this.#paths) ??
        emptySetup(this.#paths, this.#now());
      const allowInsecureLoopback = input.allowInsecureLoopback === true;
      const sandboxOrigin = setupOrigin(
        input.sandboxOrigin,
        allowInsecureLoopback,
        "sandbox",
      );
      const localGitOrigin = setupOrigin(
        input.localGitOrigin,
        allowInsecureLoopback,
        "local Git",
      );
      const sandboxKeyId = keyId(input.sandboxKeyId, "sandbox");
      const localGitKeyId = keyId(input.localGitKeyId, "local Git");
      await ensureBase64Secret(
        this.#paths.sandboxSecretFile,
        input.sandboxHmacSecret,
        current.compute.sandbox?.secretFile ?? null,
        "HMAC sandbox",
      );
      await ensureBase64Secret(
        this.#paths.localGitSecretFile,
        input.localGitHmacSecret,
        current.compute.localGit?.secretFile ?? null,
        "HMAC local Git",
      );
      await ensureGeneratedSecret(
        this.#paths.principalSecretFile,
        current.compute.principalSecretFile,
      );
      let receiptFile = current.compute.conformanceReceiptFile;
      let receiptDigest = current.compute.conformanceReceiptSha256;
      if (input.conformanceReceipt?.trim()) {
        const parsed = parseReceiptInput(input.conformanceReceipt);
        receiptDigest = codingRuntimeConformanceReceiptDigest(parsed);
        receiptFile = this.#paths.conformanceReceiptFile;
        await writeSecureFile(
          receiptFile,
          `${JSON.stringify(parsed, null, 2)}\n`,
          64 * 1_024,
        );
      }
      if (!receiptFile || !receiptDigest) {
        throw setupError(
          "CODING_SETUP_RECEIPT_REQUIRED",
          "Receipt conformance hostile-sandbox wajib diunggah sebelum compute disimpan.",
        );
      }
      await verifyReceiptFile(receiptFile, receiptDigest, this.#now());
      const revision = current.revision + 1;
      const next: ManagedCodingRuntimeSetup = {
        ...current,
        revision,
        compute: {
          configured: true,
          enabled: false,
          allowInsecureLoopback,
          codingAiPrivacyDomain: privacyDomain(input.codingAiPrivacyDomain),
          stateRoot: this.#paths.stateRoot,
          principalSecretFile: this.#paths.principalSecretFile,
          conformanceReceiptFile: receiptFile,
          conformanceReceiptSha256: receiptDigest,
          sandbox: {
            origin: sandboxOrigin,
            keyId: sandboxKeyId,
            secretFile: this.#paths.sandboxSecretFile,
          },
          localGit: {
            origin: localGitOrigin,
            keyId: localGitKeyId,
            secretFile: this.#paths.localGitSecretFile,
          },
          verifiedRevision: null,
          verifiedAt: null,
        },
        github: {
          ...current.github,
          enabled: false,
          verifiedRevision: null,
          verifiedAt: null,
        },
        updatedAt: this.#now().toISOString(),
      };
      await saveManagedCodingRuntimeSetup(next, this.#paths);
      this.#changed = true;
      return setupSnapshot(next, {
        runtimeActive: this.#runtimeActive,
        changed: this.#changed,
      });
    });
  }

  async verifyAndEnableCompute(): Promise<CodingRuntimeSetupSnapshot> {
    return this.#exclusive(async () => {
      const current = await requiredSetup(this.#paths);
      if (
        !current.compute.configured || !current.compute.sandbox ||
        !current.compute.localGit || !current.compute.conformanceReceiptFile ||
        !current.compute.conformanceReceiptSha256
      ) throw setupError("CODING_SETUP_COMPUTE_INCOMPLETE", "Konfigurasi compute belum lengkap.");
      const receipt = await verifyReceiptFile(
        current.compute.conformanceReceiptFile,
        current.compute.conformanceReceiptSha256,
        this.#now(),
      );
      let sandbox: SandboxHealth;
      let localGit: LocalGitHealth;
      try {
        ({ sandbox, localGit } = await boundedProbe((signal) =>
          this.#probes.compute(current.compute, signal)
        ));
      } catch {
        throw setupError(
          "CODING_SETUP_COMPUTE_UNREACHABLE",
          "Sandbox atau local Git tidak dapat diverifikasi dari Console.",
          502,
        );
      }
      if (!sandbox.available || !localGit.available) {
        throw setupError(
          "CODING_SETUP_COMPUTE_UNAVAILABLE",
          "Sandbox atau local Git belum melaporkan health yang tersedia.",
          502,
        );
      }
      try {
        assertSandboxRuntimeMatchesConformanceReceipt(sandbox, receipt);
      } catch {
        throw setupError(
          "CODING_SETUP_RECEIPT_IDENTITY_MISMATCH",
          "Identity sandbox live tidak cocok dengan receipt hostile-code yang dipin.",
          409,
        );
      }
      const revision = current.revision + 1;
      const next: ManagedCodingRuntimeSetup = {
        ...current,
        revision,
        compute: {
          ...current.compute,
          enabled: true,
          verifiedRevision: revision,
          verifiedAt: this.#now().toISOString(),
        },
        github: {
          ...current.github,
          enabled: false,
          verifiedRevision: null,
          verifiedAt: null,
        },
        updatedAt: this.#now().toISOString(),
      };
      await saveManagedCodingRuntimeSetup(next, this.#paths);
      this.#changed = true;
      return setupSnapshot(next, {
        runtimeActive: this.#runtimeActive,
        changed: this.#changed,
      });
    });
  }

  async saveGitHub(input: GitHubSetupInput): Promise<CodingRuntimeSetupSnapshot> {
    return this.#exclusive(async () => {
      const current = await loadManagedCodingRuntimeSetup(this.#paths) ??
        emptySetup(this.#paths, this.#now());
      const allowInsecure = current.compute.allowInsecureLoopback;
      const brokerOrigin = setupOrigin(
        input.brokerOrigin,
        allowInsecure,
        "GitHub Broker",
      );
      const brokerKeyId = keyId(input.brokerKeyId, "GitHub Broker");
      const callbackUrl = httpsUrl(input.callbackUrl, "callback GitHub App");
      const appId = boundedPattern(input.appId, /^\d{1,20}$/u, 20, "App ID");
      const appSlug = boundedPattern(
        input.appSlug,
        /^[a-z0-9][a-z0-9-]{0,99}$/u,
        100,
        "App slug",
      );
      const clientId = boundedPattern(
        input.clientId,
        /^[A-Za-z0-9_.-]{4,256}$/u,
        256,
        "Client ID",
      );
      await ensureBase64Secret(
        this.#paths.githubBrokerSecretFile,
        input.brokerHmacSecret,
        current.github.broker?.secretFile ?? null,
        "HMAC GitHub Broker",
      );
      await ensureTextSecret(
        this.#paths.githubClientSecretFile,
        input.clientSecret,
        current.github.app?.clientSecretFile ?? null,
        8,
        8_192,
        "client secret GitHub App",
      );
      await ensurePrivateKey(
        this.#paths.githubPrivateKeyFile,
        input.privateKeyPem,
        current.github.app?.privateKeyFile ?? null,
      );
      await ensureGeneratedSecret(
        this.#paths.githubStateSecretFile,
        current.github.app?.stateSecretFile ?? null,
      );
      const callback = new URL(callbackUrl);
      const broker = new URL(brokerOrigin);
      const revision = current.revision + 1;
      const next: ManagedCodingRuntimeSetup = {
        ...current,
        revision,
        compute: current.compute.enabled
          ? { ...current.compute, verifiedRevision: revision }
          : current.compute,
        github: {
          configured: true,
          enabled: false,
          broker: {
            origin: brokerOrigin,
            keyId: brokerKeyId,
            secretFile: this.#paths.githubBrokerSecretFile,
          },
          app: {
            dataRoot: this.#paths.githubDataRoot,
            appId,
            appSlug,
            clientId,
            clientSecretFile: this.#paths.githubClientSecretFile,
            privateKeyFile: this.#paths.githubPrivateKeyFile,
            stateSecretFile: this.#paths.githubStateSecretFile,
            callbackUrl,
            gitCommand: "git",
            rpcHost: "127.0.0.1",
            rpcPort: urlPort(broker, 8_445),
            rpcPublicOrigin: brokerOrigin,
            callbackHost: "0.0.0.0",
            callbackPort: 8_446,
            callbackPublicOrigin: callback.origin,
          },
          verifiedRevision: null,
          verifiedAt: null,
        },
        updatedAt: this.#now().toISOString(),
      };
      await saveManagedCodingRuntimeSetup(next, this.#paths);
      this.#changed = true;
      return setupSnapshot(next, {
        runtimeActive: this.#runtimeActive,
        changed: this.#changed,
      });
    });
  }

  async verifyAndEnableGitHub(): Promise<CodingRuntimeSetupSnapshot> {
    return this.#exclusive(async () => {
      const current = await requiredSetup(this.#paths);
      if (!current.compute.enabled) {
        throw setupError(
          "CODING_SETUP_COMPUTE_NOT_ENABLED",
          "Aktifkan compute sebelum GitHub agar commit lokal tetap menjadi gate pertama.",
        );
      }
      if (!current.github.configured || !current.github.broker || !current.github.app) {
        throw setupError("CODING_SETUP_GITHUB_INCOMPLETE", "Konfigurasi GitHub belum lengkap.");
      }
      let health: GitHubBrokerHealth;
      try {
        health = await boundedProbe((signal) => this.#probes.github(
          current.github.broker!,
          current.compute.allowInsecureLoopback,
          signal,
        ));
      } catch {
        throw setupError(
          "CODING_SETUP_GITHUB_UNREACHABLE",
          "GitHub Broker tidak dapat diverifikasi dari Console.",
          502,
        );
      }
      if (!health.available) {
        throw setupError(
          "CODING_SETUP_GITHUB_UNAVAILABLE",
          "GitHub Broker belum melaporkan health yang tersedia.",
          502,
        );
      }
      const revision = current.revision + 1;
      const next: ManagedCodingRuntimeSetup = {
        ...current,
        revision,
        compute: { ...current.compute, verifiedRevision: revision },
        github: {
          ...current.github,
          enabled: true,
          verifiedRevision: revision,
          verifiedAt: this.#now().toISOString(),
        },
        updatedAt: this.#now().toISOString(),
      };
      await saveManagedCodingRuntimeSetup(next, this.#paths);
      this.#changed = true;
      return setupSnapshot(next, {
        runtimeActive: this.#runtimeActive,
        changed: this.#changed,
      });
    });
  }

  async disable(kind: "compute" | "github"): Promise<CodingRuntimeSetupSnapshot> {
    return this.#exclusive(async () => {
      const current = await requiredSetup(this.#paths);
      const revision = current.revision + 1;
      const next: ManagedCodingRuntimeSetup = {
        ...current,
        revision,
        compute: kind === "compute"
          ? { ...current.compute, enabled: false }
          : current.compute.enabled
          ? { ...current.compute, verifiedRevision: revision }
          : current.compute,
        github: kind === "github" || kind === "compute"
          ? { ...current.github, enabled: false }
          : current.github,
        updatedAt: this.#now().toISOString(),
      };
      await saveManagedCodingRuntimeSetup(next, this.#paths);
      this.#changed = true;
      return setupSnapshot(next, {
        runtimeActive: this.#runtimeActive,
        changed: this.#changed,
      });
    });
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

const DEFAULT_PROBES: CodingRuntimeSetupProbes = Object.freeze({
  async compute(
    config: ManagedComputeConfiguration,
    signal: AbortSignal,
  ) {
    const [sandbox, localGit] = await Promise.all([
      sandboxTransport(config).health(signal),
      localGitTransport(config).health(signal),
    ]);
    return { sandbox, localGit };
  },
  github(
    config: ManagedTrustDomainConfiguration,
    allowInsecureLoopback: boolean,
    signal: AbortSignal,
  ) {
    return githubTransport(config, allowInsecureLoopback).health(signal);
  },
});

async function boundedProbe<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function codingRuntimeSetupPaths(
  repositoryRoot = process.cwd(),
): CodingRuntimeSetupPaths {
  const root = resolve(repositoryRoot);
  return {
    configFile: join(root, "secrets", "coding-runtime.setup.json"),
    environmentFile: join(root, ".env"),
    stateRoot: join(root, "data", "coding-runtime"),
    principalSecretFile: join(root, "secrets", "workspace-principal.b64url"),
    sandboxSecretFile: join(root, "secrets", "sandbox-client-hmac.b64url"),
    localGitSecretFile: join(root, "secrets", "local-git-client-hmac.b64url"),
    conformanceReceiptFile: join(root, "secrets", "sandbox-conformance.json"),
    githubBrokerSecretFile: join(root, "secrets", "github-broker-client-hmac.b64url"),
    githubClientSecretFile: join(root, "secrets", "github-app-client-secret"),
    githubPrivateKeyFile: join(root, "secrets", "github-app.pem"),
    githubStateSecretFile: join(root, "secrets", "github-state-secret.b64url"),
    githubDataRoot: join(root, "data", "github-broker"),
  };
}

export async function loadManagedCodingRuntimeSetup(
  paths = codingRuntimeSetupPaths(),
): Promise<ManagedCodingRuntimeSetup | null> {
  let raw: string;
  try {
    raw = await readFile(paths.configFile, "utf8");
  } catch (error) {
    if (nodeError(error, "ENOENT")) return null;
    throw error;
  }
  return parseSetup(JSON.parse(raw) as unknown);
}

export function loadManagedCodingRuntimeSetupSync(
  paths = codingRuntimeSetupPaths(),
): ManagedCodingRuntimeSetup | null {
  if (!existsSync(paths.configFile)) return null;
  assertRegularFileSync(paths.configFile, "CODING_SETUP_CONFIG_INVALID");
  return parseSetup(JSON.parse(readFileSync(paths.configFile, "utf8")) as unknown);
}

export function loadManagedGitHubBrokerServiceConfigurationSync(
  paths = codingRuntimeSetupPaths(),
): ManagedGitHubBrokerServiceConfiguration | null {
  const state = loadManagedCodingRuntimeSetupSync(paths);
  const app = state?.github.app;
  const broker = state?.github.broker;
  if (!state?.github.configured || !app || !broker) return null;
  return {
    dataRoot: app.dataRoot,
    appId: app.appId,
    appSlug: app.appSlug,
    clientId: app.clientId,
    clientSecretFile: app.clientSecretFile,
    privateKeyFile: app.privateKeyFile,
    stateSecretFile: app.stateSecretFile,
    callbackUrl: app.callbackUrl,
    gitCommand: app.gitCommand,
    hmacKeyId: broker.keyId,
    hmacSecretFile: broker.secretFile,
    rpcHost: app.rpcHost,
    rpcPort: app.rpcPort,
    rpcPublicOrigin: app.rpcPublicOrigin,
    callbackHost: app.callbackHost,
    callbackPort: app.callbackPort,
    callbackPublicOrigin: app.callbackPublicOrigin,
  };
}

async function saveManagedCodingRuntimeSetup(
  state: ManagedCodingRuntimeSetup,
  paths: CodingRuntimeSetupPaths,
): Promise<void> {
  const parsed = parseSetup(state);
  await writeSecureFile(
    paths.configFile,
    `${JSON.stringify(parsed, null, 2)}\n`,
    64 * 1_024,
  );
}

function emptySetup(
  paths: CodingRuntimeSetupPaths,
  now: Date,
): ManagedCodingRuntimeSetup {
  return {
    version: CONFIG_VERSION,
    revision: 0,
    compute: {
      configured: false,
      enabled: false,
      allowInsecureLoopback: false,
      codingAiPrivacyDomain: null,
      stateRoot: paths.stateRoot,
      principalSecretFile: paths.principalSecretFile,
      conformanceReceiptFile: null,
      conformanceReceiptSha256: null,
      sandbox: null,
      localGit: null,
      verifiedRevision: null,
      verifiedAt: null,
    },
    github: {
      configured: false,
      enabled: false,
      broker: null,
      app: null,
      verifiedRevision: null,
      verifiedAt: null,
    },
    updatedAt: now.toISOString(),
  };
}

function parseSetup(input: unknown): ManagedCodingRuntimeSetup {
  const root = object(input, "config coding setup");
  exactKeys(root, CONFIG_KEYS, "config coding setup");
  if (
    root.version !== CONFIG_VERSION || !integer(root.revision, 0) ||
    !iso(root.updatedAt)
  ) throw invalidConfig();
  const computeRaw = object(root.compute, "compute coding setup");
  exactKeys(computeRaw, COMPUTE_KEYS, "compute coding setup");
  const githubRaw = object(root.github, "GitHub coding setup");
  exactKeys(githubRaw, GITHUB_KEYS, "GitHub coding setup");
  const compute: ManagedComputeConfiguration = {
    configured: boolean(computeRaw.configured),
    enabled: boolean(computeRaw.enabled),
    allowInsecureLoopback: boolean(computeRaw.allowInsecureLoopback),
    codingAiPrivacyDomain: nullablePrivacyDomain(computeRaw.codingAiPrivacyDomain),
    stateRoot: absolutePath(computeRaw.stateRoot, "state root coding"),
    principalSecretFile: absolutePath(
      computeRaw.principalSecretFile,
      "principal secret coding",
    ),
    conformanceReceiptFile: nullableAbsolutePath(
      computeRaw.conformanceReceiptFile,
      "receipt coding",
    ),
    conformanceReceiptSha256: nullableSha(computeRaw.conformanceReceiptSha256),
    sandbox: nullableTrust(computeRaw.sandbox, computeRaw.allowInsecureLoopback),
    localGit: nullableTrust(computeRaw.localGit, computeRaw.allowInsecureLoopback),
    verifiedRevision: nullableRevision(computeRaw.verifiedRevision),
    verifiedAt: nullableIso(computeRaw.verifiedAt),
  };
  const github: ManagedGitHubConfiguration = {
    configured: boolean(githubRaw.configured),
    enabled: boolean(githubRaw.enabled),
    broker: nullableTrust(githubRaw.broker, compute.allowInsecureLoopback),
    app: nullableApp(githubRaw.app),
    verifiedRevision: nullableRevision(githubRaw.verifiedRevision),
    verifiedAt: nullableIso(githubRaw.verifiedAt),
  };
  if (
    compute.enabled && (!compute.configured || !compute.sandbox ||
      !compute.localGit || !compute.conformanceReceiptFile ||
      !compute.conformanceReceiptSha256 ||
      compute.verifiedRevision !== root.revision || !compute.verifiedAt) ||
    github.enabled && (!compute.enabled || !github.configured || !github.broker ||
      !github.app || github.verifiedRevision !== root.revision || !github.verifiedAt)
  ) throw invalidConfig();
  return {
    version: 1,
    revision: root.revision as number,
    compute,
    github,
    updatedAt: root.updatedAt as string,
  };
}

function nullableTrust(
  input: unknown,
  allowInsecure: unknown,
): ManagedTrustDomainConfiguration | null {
  if (input === null) return null;
  const value = object(input, "trust domain coding setup");
  exactKeys(value, TRUST_KEYS, "trust domain coding setup");
  return {
    origin: setupOrigin(value.origin, allowInsecure === true, "trust domain"),
    keyId: keyId(value.keyId, "trust domain"),
    secretFile: absolutePath(value.secretFile, "secret trust domain"),
  };
}

function nullableApp(input: unknown): ManagedGitHubAppConfiguration | null {
  if (input === null) return null;
  const value = object(input, "GitHub App coding setup");
  exactKeys(value, APP_KEYS, "GitHub App coding setup");
  return {
    dataRoot: absolutePath(value.dataRoot, "data root GitHub Broker"),
    appId: boundedPattern(value.appId, /^\d{1,20}$/u, 20, "App ID"),
    appSlug: boundedPattern(value.appSlug, /^[a-z0-9][a-z0-9-]{0,99}$/u, 100, "App slug"),
    clientId: boundedPattern(value.clientId, /^[A-Za-z0-9_.-]{4,256}$/u, 256, "Client ID"),
    clientSecretFile: absolutePath(value.clientSecretFile, "client secret GitHub"),
    privateKeyFile: absolutePath(value.privateKeyFile, "private key GitHub"),
    stateSecretFile: absolutePath(value.stateSecretFile, "state secret GitHub"),
    callbackUrl: httpsUrl(value.callbackUrl, "callback GitHub App"),
    gitCommand: boundedPattern(value.gitCommand, /^[A-Za-z0-9_./:-]{1,512}$/u, 512, "command Git"),
    rpcHost: host(value.rpcHost, "host RPC GitHub Broker"),
    rpcPort: port(value.rpcPort, "port RPC GitHub Broker"),
    rpcPublicOrigin: value.rpcPublicOrigin === null
      ? null
      : setupOrigin(value.rpcPublicOrigin, true, "origin RPC GitHub Broker"),
    callbackHost: host(value.callbackHost, "host callback GitHub Broker"),
    callbackPort: port(value.callbackPort, "port callback GitHub Broker"),
    callbackPublicOrigin: httpsOrigin(value.callbackPublicOrigin, "origin callback GitHub Broker"),
  };
}

function setupSnapshot(
  state: ManagedCodingRuntimeSetup | null,
  flags: { runtimeActive: boolean; changed: boolean },
): CodingRuntimeSetupSnapshot {
  const receipt = state?.compute.conformanceReceiptFile
    ? receiptExpiry(state.compute.conformanceReceiptFile)
    : null;
  const callbackOrigin = state?.github.app
    ? new URL(state.github.app.callbackUrl).origin
    : null;
  return {
    source: state ? "console" : "none",
    revision: state?.revision ?? 0,
    runtimeActive: flags.runtimeActive,
    restartRequired: flags.runtimeActive && flags.changed,
    compute: {
      configured: state?.compute.configured ?? false,
      enabled: state?.compute.enabled ?? false,
      sandboxOrigin: state?.compute.sandbox?.origin ?? null,
      sandboxKeyId: state?.compute.sandbox?.keyId ?? null,
      localGitOrigin: state?.compute.localGit?.origin ?? null,
      localGitKeyId: state?.compute.localGit?.keyId ?? null,
      allowInsecureLoopback: state?.compute.allowInsecureLoopback ?? false,
      codingAiPrivacyDomain: state?.compute.codingAiPrivacyDomain ?? null,
      receiptConfigured: Boolean(state?.compute.conformanceReceiptFile),
      receiptExpiresAt: receipt,
      verifiedAt: state?.compute.verifiedAt ?? null,
      verificationCurrent: Boolean(
        state?.compute.enabled &&
        state.compute.verifiedRevision === state.revision,
      ),
    },
    github: {
      configured: state?.github.configured ?? false,
      enabled: state?.github.enabled ?? false,
      brokerOrigin: state?.github.broker?.origin ?? null,
      brokerKeyId: state?.github.broker?.keyId ?? null,
      appId: state?.github.app?.appId ?? null,
      appSlug: state?.github.app?.appSlug ?? null,
      clientId: state?.github.app?.clientId ?? null,
      callbackUrl: state?.github.app?.callbackUrl ?? null,
      callbackOrigin,
      credentialsStored: Boolean(state?.github.app),
      verifiedAt: state?.github.verifiedAt ?? null,
      verificationCurrent: Boolean(
        state?.github.enabled && state.github.verifiedRevision === state.revision,
      ),
    },
  };
}

function receiptExpiry(path: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof value.expiresAt === "string" && iso(value.expiresAt)
      ? value.expiresAt
      : null;
  } catch {
    return null;
  }
}

async function verifyReceiptFile(path: string, digest: string, now: Date) {
  try {
    const receipt = await loadCodingRuntimeConformanceReceipt(path);
    new PinnedCodingRuntimeConformanceVerifier(digest).verify(receipt, now);
    return receipt;
  } catch {
    throw setupError(
      "CODING_SETUP_RECEIPT_INVALID",
      "Receipt conformance sandbox tidak sah, tidak cocok pin, atau sudah kedaluwarsa.",
    );
  }
}

function parseReceiptInput(value: string) {
  try {
    return parseCodingRuntimeConformanceReceipt(JSON.parse(value) as unknown);
  } catch {
    throw setupError(
      "CODING_SETUP_RECEIPT_INVALID",
      "JSON receipt conformance sandbox tidak sah.",
    );
  }
}

function sandboxTransport(config: ManagedComputeConfiguration): HttpSandboxTransport {
  return new HttpSandboxTransport({
    origin: config.sandbox!.origin,
    proofProvider: proof(config.sandbox!),
    allowInsecureLoopback: config.allowInsecureLoopback,
  });
}

function localGitTransport(config: ManagedComputeConfiguration): HttpLocalGitTransport {
  return new HttpLocalGitTransport({
    origin: config.localGit!.origin,
    proofProvider: proof(config.localGit!),
    allowInsecureLoopback: config.allowInsecureLoopback,
  });
}

function githubTransport(
  config: ManagedTrustDomainConfiguration,
  allowInsecureLoopback: boolean,
): HttpGitHubBrokerTransport {
  return new HttpGitHubBrokerTransport({
    origin: config.origin,
    proofProvider: proof(config),
    allowInsecureLoopback,
  });
}

function proof(config: ManagedTrustDomainConfiguration) {
  return new HmacTrustDomainRequestProofProvider(
    config.keyId,
    readBase64SecretSync(config.secretFile),
  );
}

function readBase64SecretSync(file: string): Buffer {
  assertRegularFileSync(file, "CODING_SETUP_SECRET_INVALID");
  return decodeBase64Secret(readFileSync(file, "utf8"), "secret trust-domain");
}

async function ensureBase64Secret(
  target: string,
  candidate: string | null | undefined,
  existing: string | null,
  label: string,
): Promise<void> {
  if (!candidate?.trim()) {
    if (existing && existsSync(existing)) return;
    throw setupError("CODING_SETUP_SECRET_REQUIRED", `${label} wajib diisi.`);
  }
  const normalized = candidate.trim();
  decodeBase64Secret(normalized, label);
  await writeSecureFile(target, `${normalized}\n`, 16 * 1_024);
}

async function ensureGeneratedSecret(target: string, existing: string | null): Promise<void> {
  if (existing && existsSync(existing)) return;
  await writeSecureFile(target, `${randomBytes(32).toString("base64url")}\n`, 16 * 1_024);
}

async function ensureTextSecret(
  target: string,
  candidate: string | null | undefined,
  existing: string | null,
  minimum: number,
  maximum: number,
  label: string,
): Promise<void> {
  if (!candidate?.trim()) {
    if (existing && existsSync(existing)) return;
    throw setupError("CODING_SETUP_SECRET_REQUIRED", `${label} wajib diisi.`);
  }
  const value = candidate.trim();
  if (value.length < minimum || value.length > maximum || /[\r\n\0]/u.test(value)) {
    throw setupError("CODING_SETUP_SECRET_INVALID", `${label} tidak sah.`);
  }
  await writeSecureFile(target, `${value}\n`, maximum + 2);
}

async function ensurePrivateKey(
  target: string,
  candidate: string | null | undefined,
  existing: string | null,
): Promise<void> {
  if (!candidate?.trim()) {
    if (existing && existsSync(existing)) return;
    throw setupError("CODING_SETUP_GITHUB_PRIVATE_KEY_REQUIRED", "Private key GitHub App wajib diisi.");
  }
  const value = candidate.trim();
  if (
    value.length > 128 * 1_024 ||
    !/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----$/u.test(value)
  ) throw setupError("CODING_SETUP_GITHUB_PRIVATE_KEY_INVALID", "Private key GitHub App tidak sah.");
  await writeSecureFile(target, `${value}\n`, 128 * 1_024);
}

async function writeSecureFile(path: string, value: string, maximum: number): Promise<void> {
  if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > maximum) {
    throw setupError("CODING_SETUP_FILE_TOO_LARGE", "Berkas setup melampaui batas.");
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertRegularOrMissing(path);
  await writeDurableFileAtomic(path, value);
  await chmod(path, 0o600).catch(() => undefined);
}

async function assertSafeSetupPaths(paths: CodingRuntimeSetupPaths): Promise<void> {
  for (const path of Object.values(paths)) {
    if (typeof path !== "string" || !resolve(path)) throw invalidConfig();
  }
  await mkdir(dirname(paths.configFile), { recursive: true, mode: 0o700 });
  await assertRegularOrMissing(paths.configFile);
}

async function assertRegularOrMissing(path: string): Promise<void> {
  try {
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink()) throw invalidConfig();
  } catch (error) {
    if (!nodeError(error, "ENOENT")) throw error;
  }
}

function assertRegularFileSync(path: string, code: string): void {
  try {
    const state = lstatSync(path);
    if (!state.isFile() || state.isSymbolicLink()) throw new Error(code);
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code);
  }
}

async function requiredSetup(paths: CodingRuntimeSetupPaths) {
  const state = await loadManagedCodingRuntimeSetup(paths);
  if (!state) throw setupError("CODING_SETUP_MISSING", "Konfigurasi coding belum tersedia.");
  return state;
}

function decodeBase64Secret(value: string, label: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{43,5462}$/u.test(normalized)) {
    throw setupError("CODING_SETUP_SECRET_INVALID", `${label} tidak sah.`);
  }
  const bytes = Buffer.from(normalized, "base64url");
  if (bytes.byteLength < 32 || bytes.byteLength > 4_096) {
    throw setupError("CODING_SETUP_SECRET_INVALID", `${label} tidak sah.`);
  }
  return bytes;
}

function setupOrigin(input: unknown, allowInsecure: boolean, label: string): string {
  if (typeof input !== "string" || input.length > 2_048) {
    throw setupError("CODING_SETUP_ORIGIN_INVALID", `Origin ${label} tidak sah.`);
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw setupError("CODING_SETUP_ORIGIN_INVALID", `Origin ${label} tidak sah.`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" ||
    url.hostname === "[::1]" || url.hostname === "::1";
  if (
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" &&
      !(allowInsecure && loopback && url.protocol === "http:"))
  ) throw setupError("CODING_SETUP_ORIGIN_INVALID", `Origin ${label} tidak sah.`);
  return url.origin;
}

function httpsUrl(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length > 2_048) {
    throw setupError("CODING_SETUP_URL_INVALID", `URL ${label} tidak sah.`);
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw setupError("CODING_SETUP_URL_INVALID", `URL ${label} tidak sah.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw setupError("CODING_SETUP_URL_INVALID", `URL ${label} wajib HTTPS tanpa credential atau fragment.`);
  }
  return url.toString();
}

function httpsOrigin(input: unknown, label: string): string {
  const value = httpsUrl(input, label);
  const url = new URL(value);
  if (url.pathname !== "/" || url.search) {
    throw setupError("CODING_SETUP_ORIGIN_INVALID", `${label} harus berupa origin HTTPS.`);
  }
  return url.origin;
}

function keyId(input: unknown, label: string): string {
  return boundedPattern(input, /^[A-Za-z0-9_-]{3,64}$/u, 64, `key ID ${label}`);
}

function privacyDomain(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  return boundedPattern(input, /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u, 128, "privacy domain coding");
}

function nullablePrivacyDomain(input: unknown): string | null {
  return input === null ? null : privacyDomain(input);
}

function boundedPattern(
  input: unknown,
  pattern: RegExp,
  maximum: number,
  label: string,
): string {
  if (typeof input !== "string") throw setupError("CODING_SETUP_FIELD_INVALID", `${label} tidak sah.`);
  const value = input.trim();
  if (!value || value.length > maximum || !pattern.test(value)) {
    throw setupError("CODING_SETUP_FIELD_INVALID", `${label} tidak sah.`);
  }
  return value;
}

function absolutePath(input: unknown, label: string): string {
  if (typeof input !== "string" || !input || input.length > 4_096 || resolve(input) !== input) {
    throw setupError("CODING_SETUP_PATH_INVALID", `${label} tidak sah.`);
  }
  return input;
}

function nullableAbsolutePath(input: unknown, label: string): string | null {
  return input === null ? null : absolutePath(input, label);
}

function nullableSha(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/u.test(input)) throw invalidConfig();
  return input;
}

function nullableRevision(input: unknown): number | null {
  if (input === null) return null;
  if (!integer(input, 1)) throw invalidConfig();
  return input as number;
}

function nullableIso(input: unknown): string | null {
  if (input === null) return null;
  if (!iso(input)) throw invalidConfig();
  return input as string;
}

function host(input: unknown, label: string): string {
  return boundedPattern(input, /^[A-Za-z0-9][A-Za-z0-9.:-]{0,254}$/u, 255, label);
}

function port(input: unknown, label: string): number {
  if (!integer(input, 1) || (input as number) > 65_535) {
    throw setupError("CODING_SETUP_FIELD_INVALID", `${label} tidak sah.`);
  }
  return input as number;
}

function urlPort(url: URL, fallback: number): number {
  if (url.port) return port(Number(url.port), "port GitHub Broker");
  if (url.protocol === "https:") return 443;
  if (url.protocol === "http:") return 80;
  return fallback;
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw setupError("CODING_SETUP_CONFIG_INVALID", `${label} tidak sah.`);
  }
  return input as Record<string, unknown>;
}

function exactKeys(input: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...expected].sort())) {
    throw setupError("CODING_SETUP_CONFIG_INVALID", `${label} memuat field asing atau hilang.`);
  }
}

function boolean(input: unknown): boolean {
  if (typeof input !== "boolean") throw invalidConfig();
  return input;
}

function integer(input: unknown, minimum: number): input is number {
  return Number.isSafeInteger(input) && (input as number) >= minimum;
}

function iso(input: unknown): input is string {
  return typeof input === "string" && Number.isFinite(Date.parse(input)) &&
    new Date(input).toISOString() === input;
}

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function invalidConfig(): CodingRuntimeSetupError {
  return setupError("CODING_SETUP_CONFIG_INVALID", "Berkas konfigurasi coding Console tidak sah.");
}

function setupError(code: string, message: string, status = 400): CodingRuntimeSetupError {
  return new CodingRuntimeSetupError(code, status, message);
}
