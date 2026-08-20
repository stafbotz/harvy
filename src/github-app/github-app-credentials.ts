import {
  createPrivateKey,
  createSign,
  type KeyObject,
} from "node:crypto";
import { GitHubApiClient } from "./github-api-client.js";

const JWT_TTL_SECONDS = 9 * 60;
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface GitHubAppCredentialsOptions {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: Uint8Array;
  api: GitHubApiClient;
  now?: () => Date;
}

interface CachedInstallationToken {
  token: string;
  expiresAt: string;
}

/** Credential vault exists only inside the broker service process. */
export class GitHubAppCredentials {
  readonly #appId: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #privateKey: KeyObject;
  readonly #api: GitHubApiClient;
  readonly #now: () => Date;
  readonly #tokens = new Map<string, CachedInstallationToken>();

  constructor(options: GitHubAppCredentialsOptions) {
    this.#appId = numericId(options.appId, "GitHub App id");
    this.#clientId = safeSecret(options.clientId, "GitHub App client id", 256);
    this.#clientSecret = safeSecret(options.clientSecret, "GitHub App client secret", 1_024);
    if (!(options.privateKeyPem instanceof Uint8Array) || options.privateKeyPem.byteLength < 128 ||
      options.privateKeyPem.byteLength > 128 * 1_024) {
      throw new Error("GitHub App private key tidak sah.");
    }
    this.#privateKey = createPrivateKey(Buffer.from(options.privateKeyPem));
    if (this.#privateKey.asymmetricKeyType !== "rsa") {
      throw new Error("GitHub App private key wajib RSA.");
    }
    this.#api = options.api;
    this.#now = options.now ?? (() => new Date());
  }

  get appId(): string {
    return this.#appId;
  }

  get clientId(): string {
    return this.#clientId;
  }

  appJwt(): string {
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    const header = base64Json({ alg: "RS256", typ: "JWT" });
    const payload = base64Json({
      iat: nowSeconds - 60,
      exp: nowSeconds + JWT_TTL_SECONDS,
      iss: this.#appId,
    });
    const signingInput = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput, "ascii")
      .end()
      .sign(this.#privateKey)
      .toString("base64url");
    return `${signingInput}.${signature}`;
  }

  async exchangeUserCode(input: {
    code: string;
    redirectUri: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const response = await this.#api.exchangeUserCode({
      clientId: this.#clientId,
      clientSecret: this.#clientSecret,
      code: safeSecret(input.code, "GitHub OAuth code", 2_048),
      redirectUri: input.redirectUri,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const value = object(response.value);
    const token = safeSecret(value.access_token, "GitHub user access token", 8_192);
    if (value.token_type !== "bearer") throw new Error("GitHub OAuth token type tidak sah.");
    return token;
  }

  async installationToken(input: {
    installationId: string;
    repositoryId?: string;
    permissions?: Readonly<Record<string, "read" | "write">>;
    signal?: AbortSignal;
  }): Promise<string> {
    const installationId = numericId(input.installationId, "installation id");
    const repositoryId = input.repositoryId === undefined
      ? null
      : numericId(input.repositoryId, "repository id");
    const permissions = canonicalPermissions(input.permissions ?? {});
    const cacheKey = JSON.stringify({ installationId, repositoryId, permissions });
    const cached = this.#tokens.get(cacheKey);
    if (cached && Date.parse(cached.expiresAt) - TOKEN_REFRESH_SKEW_MS > this.#now().getTime()) {
      return cached.token;
    }
    const response = await this.#api.apiJson({
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      authorization: this.appJwt(),
      body: {
        ...(repositoryId ? { repository_ids: [Number(repositoryId)] } : {}),
        ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
      },
      accepted: [201],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const value = object(response.value);
    const token = safeSecret(value.token, "GitHub installation token", 8_192);
    const expiresAt = iso(value.expires_at, "GitHub installation token expiry");
    if (Date.parse(expiresAt) <= this.#now().getTime() + TOKEN_REFRESH_SKEW_MS) {
      throw new Error("GitHub installation token terlalu dekat expiry.");
    }
    this.#tokens.set(cacheKey, { token, expiresAt });
    return token;
  }

  clearInstallationTokens(installationIdInput: string): void {
    const installationId = numericId(installationIdInput, "installation id");
    for (const key of this.#tokens.keys()) {
      if ((JSON.parse(key) as { installationId?: string }).installationId === installationId) {
        this.#tokens.delete(key);
      }
    }
  }
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function numericId(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") ||
    !/^\d{1,20}$/u.test(String(value)) || BigInt(String(value)) < 1n) {
    throw new Error(`${label} tidak sah.`);
  }
  return String(value);
}

function canonicalPermissions(
  input: Readonly<Record<string, "read" | "write">>,
): Record<string, "read" | "write"> {
  const allowed = new Set(["contents", "pull_requests", "workflows", "metadata"]);
  const result: Record<string, "read" | "write"> = {};
  for (const [name, value] of Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) {
    if (!allowed.has(name) || (value !== "read" && value !== "write")) {
      throw new Error("Permission installation token GitHub tidak sah.");
    }
    result[name] = value;
  }
  return result;
}

function safeSecret(input: unknown, label: string, maximum: number): string {
  if (typeof input !== "string" || input.length < 4 || input.length > maximum || /[\r\n\0]/u.test(input)) {
    throw new Error(`${label} tidak sah.`);
  }
  return input;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Response credential GitHub tidak sah.");
  }
  return value as Record<string, unknown>;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value) throw new Error(`${label} tidak sah.`);
  return value;
}
