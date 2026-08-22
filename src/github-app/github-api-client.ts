import { setTimeout as delay } from "node:timers/promises";
import {
  BoundedResponseBodyError,
  readBoundedResponseBody,
} from "../transport/bounded-response-body.js";

const DEFAULT_API_VERSION = "2026-03-10";
const DEFAULT_MAX_JSON_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GitHubApiResponse {
  status: number;
  value: unknown;
  headers: Headers;
}

export interface GitHubApiClientOptions {
  apiOrigin?: string;
  webOrigin?: string;
  archiveOrigins?: readonly string[];
  apiVersion?: string;
  userAgent?: string;
  fetchImplementation?: typeof fetch;
  maxJsonBytes?: number;
  retryCount?: number;
  timeoutMs?: number;
  /** Tests may opt into loopback HTTP. Production origins remain HTTPS-only. */
  allowInsecureLoopback?: boolean;
}

/**
 * Narrow GitHub HTTP client owned by the broker trust domain. Authorization
 * values are accepted only as headers assembled here and never included in an
 * error, return value, redirect, or durable record.
 */
export class GitHubApiClient {
  readonly #apiOrigin: string;
  readonly #webOrigin: string;
  readonly #archiveOrigins: ReadonlySet<string>;
  readonly #apiVersion: string;
  readonly #userAgent: string;
  readonly #fetch: typeof fetch;
  readonly #maxJsonBytes: number;
  readonly #retryCount: number;
  readonly #timeoutMs: number;

  constructor(options: GitHubApiClientOptions = {}) {
    const insecure = options.allowInsecureLoopback === true;
    this.#apiOrigin = trustedOrigin(
      options.apiOrigin ?? "https://api.github.com",
      insecure,
      "GitHub API",
    );
    this.#webOrigin = trustedOrigin(
      options.webOrigin ?? "https://github.com",
      insecure,
      "GitHub web",
    );
    this.#archiveOrigins = new Set(
      (options.archiveOrigins ?? ["https://codeload.github.com"]).map((origin) =>
        trustedOrigin(origin, insecure, "GitHub archive")
      ),
    );
    this.#apiVersion = safeHeader(
      options.apiVersion ?? DEFAULT_API_VERSION,
      "GitHub API version",
      64,
    );
    this.#userAgent = safeHeader(options.userAgent ?? "harvy-github-app-broker/1", "user agent", 128);
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#maxJsonBytes = boundedInteger(
      options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES,
      "max JSON bytes",
      1_024,
      32 * 1024 * 1024,
    );
    this.#retryCount = boundedInteger(options.retryCount ?? DEFAULT_RETRIES, "retry count", 0, 4);
    this.#timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeout",
      10,
      120_000,
    );
  }

  async apiJson(input: {
    method: "GET" | "POST" | "PATCH";
    path: string;
    authorization: string;
    body?: unknown;
    signal?: AbortSignal;
    accepted?: readonly number[];
    retrySafe?: boolean;
  }): Promise<GitHubApiResponse> {
    return this.#json({
      ...input,
      origin: this.#apiOrigin,
      apiHeaders: true,
    });
  }

  async exchangeUserCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    signal?: AbortSignal;
  }): Promise<GitHubApiResponse> {
    const body = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    }).toString();
    const url = new URL("/login/oauth/access_token", this.#webOrigin);
    const response = await this.#requestWithRetry(
      url,
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(body)),
          "user-agent": this.#userAgent,
        },
        body,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      false,
    );
    return this.#parseJsonResponse(response, [200]);
  }

  async downloadArchive(input: {
    path: string;
    authorization: string;
    maximumBytes: number;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    const maximum = boundedInteger(input.maximumBytes, "archive maximum", 1, 128 * 1024 * 1024);
    const firstUrl = apiUrl(this.#apiOrigin, input.path);
    const first = await this.#requestWithRetry(
      firstUrl,
      {
        method: "GET",
        redirect: "manual",
        headers: this.#headers(input.authorization),
        ...(input.signal ? { signal: input.signal } : {}),
      },
      false,
    );
    let response = first;
    if (redirectStatus(first.status)) {
      const location = first.headers.get("location");
      await first.body?.cancel().catch(() => undefined);
      if (!location) throw apiError("GITHUB_ARCHIVE_REDIRECT_INVALID", first.status);
      const target = new URL(location, firstUrl);
      if (!this.#archiveOrigins.has(target.origin) || target.username || target.password || target.hash) {
        throw apiError("GITHUB_ARCHIVE_REDIRECT_REJECTED", first.status);
      }
      // Deliberately omit Authorization on the codeload hop.
      response = await this.#requestWithRetry(
        target,
        {
          method: "GET",
          redirect: "error",
          headers: { "user-agent": this.#userAgent, accept: "application/zip" },
          ...(input.signal ? { signal: input.signal } : {}),
        },
        false,
      );
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw apiError("GITHUB_ARCHIVE_FETCH_FAILED", response.status);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximum)) {
      await response.body?.cancel().catch(() => undefined);
      throw apiError("GITHUB_ARCHIVE_TOO_LARGE", response.status);
    }
    if (!response.body) throw apiError("GITHUB_ARCHIVE_BODY_MISSING", response.status);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        if (input.signal?.aborted) throw abortError();
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        size += chunk.byteLength;
        if (size > maximum) throw apiError("GITHUB_ARCHIVE_TOO_LARGE", response.status);
        chunks.push(chunk);
      }
      if (size < 1 || (contentLength !== null && size !== Number(contentLength))) {
        throw apiError("GITHUB_ARCHIVE_TRUNCATED", response.status);
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async #json(input: {
    origin: string;
    method: "GET" | "POST" | "PATCH";
    path: string;
    authorization: string;
    body?: unknown;
    signal?: AbortSignal;
    accepted?: readonly number[];
    retrySafe?: boolean;
    apiHeaders: boolean;
  }): Promise<GitHubApiResponse> {
    const url = apiUrl(input.origin, input.path);
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body !== undefined && Buffer.byteLength(body) > this.#maxJsonBytes) {
      throw apiError("GITHUB_REQUEST_TOO_LARGE", 0);
    }
    const headers = this.#headers(input.authorization);
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.#requestWithRetry(
      url,
      {
        method: input.method,
        redirect: "error",
        headers,
        ...(body === undefined ? {} : { body }),
        ...(input.signal ? { signal: input.signal } : {}),
      },
      input.retrySafe === true,
    );
    return this.#parseJsonResponse(response, input.accepted ?? [200]);
  }

  #headers(authorization: string): Record<string, string> {
    if (typeof authorization !== "string" || authorization.length < 8 ||
      authorization.length > 8_192 || /[\r\n]/u.test(authorization)) {
      throw apiError("GITHUB_AUTHORIZATION_INVALID", 0);
    }
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${authorization}`,
      "x-github-api-version": this.#apiVersion,
      "user-agent": this.#userAgent,
    };
  }

  async #requestWithRetry(
    url: URL,
    init: RequestInit,
    retrySafe: boolean,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const requestSignal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    const boundedInit: RequestInit = { ...init, signal: requestSignal };
    let last: unknown = null;
    const attempts = retrySafe ? this.#retryCount + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.#fetch(url, boundedInit);
        if (!retrySafe || ![502, 503, 504].includes(response.status) || attempt + 1 >= attempts) {
          return response;
        }
        await response.body?.cancel();
      } catch (error) {
        if (requestSignal.aborted || isAbort(error) || attempt + 1 >= attempts) {
          throw error;
        }
        last = error;
      }
      await delay(Math.min(250 * 2 ** attempt, 1_000), undefined, {
        signal: requestSignal,
      });
    }
    throw last ?? apiError("GITHUB_REQUEST_FAILED", 0);
  }

  async #parseJsonResponse(response: Response, accepted: readonly number[]): Promise<GitHubApiResponse> {
    if (!accepted.includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw apiError("GITHUB_API_REJECTED", response.status);
    }
    let bytes: Buffer;
    try {
      bytes = await readBoundedResponseBody(response, this.#maxJsonBytes);
    } catch (error) {
      if (error instanceof BoundedResponseBodyError) {
        throw apiError(
          error.reason === "too_large"
            ? "GITHUB_RESPONSE_TOO_LARGE"
            : "GITHUB_RESPONSE_MALFORMED",
          response.status,
        );
      }
      throw error;
    }
    let value: unknown = null;
    if (bytes.byteLength > 0) {
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as unknown;
      } catch {
        throw apiError("GITHUB_RESPONSE_MALFORMED", response.status);
      }
    }
    return { status: response.status, value, headers: response.headers };
  }
}

export class GitHubApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "GitHubApiError";
  }
}

function apiError(code: string, status: number): GitHubApiError {
  return new GitHubApiError(code, status);
}

function trustedOrigin(input: string, allowInsecureLoopback: boolean, label: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label} origin tidak sah.`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:")) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`${label} origin tidak aman.`);
  }
  return url.origin;
}

function apiUrl(origin: string, path: string): URL {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") ||
    path.includes("\\") || /[\r\n\0]/u.test(path)) {
    throw apiError("GITHUB_PATH_INVALID", 0);
  }
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw apiError("GITHUB_PATH_INVALID", 0);
  }
  return url;
}

function safeHeader(value: string, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\r\n\0]/u.test(value)) {
    throw new Error(`${label} tidak sah.`);
  }
  return value;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} tidak sah.`);
  }
  return value;
}

function redirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError");
}

function abortError(): Error {
  const error = new Error("Operasi GitHub dibatalkan.");
  error.name = "AbortError";
  return error;
}
