import { createHash, createHmac } from "node:crypto";

// Base64url expansion stays below conservative 8 KiB proxy/header limits.
const MAX_UPLOAD_ENVELOPE_BYTES = 4 * 1024;
const MAX_JSON_ENVELOPE_BYTES = 1024 * 1024;
const DEFAULT_MAX_JSON_RESPONSE_BYTES = 256 * 1024;
const MAX_PROOF_LENGTH = 4096;

export interface TrustDomainRequestBinding {
  version: 1;
  protocol: string;
  audience: string;
  method: "POST";
  pathname: string;
  requestId: string;
  envelopeSha256: string;
  contentSha256: string | null;
  contentMediaType: string;
  contentSize: number;
  issuedAt: string;
}

/**
 * Produces an ephemeral service-to-service request proof. Implementations may
 * use an OS key store or a remote signer; the proof is never persisted or
 * returned in an error. GitHub App/provider credentials are not legal here.
 */
export interface TrustDomainRequestProofProvider {
  createProof(
    binding: TrustDomainRequestBinding,
    signal?: AbortSignal,
  ): Promise<string>;
}

/**
 * Concrete service-identity proof for deployments that provision a dedicated
 * non-provider secret through an OS secret store. Servers must enforce the
 * signed audience, issuedAt skew, request idempotency, and protocol version.
 */
export class HmacTrustDomainRequestProofProvider
  implements TrustDomainRequestProofProvider {
  readonly #keyId: string;
  readonly #secret: Buffer;

  constructor(keyId: string, secret: Uint8Array) {
    if (!/^[A-Za-z0-9_-]{3,64}$/u.test(keyId) ||
      !(secret instanceof Uint8Array) || secret.byteLength < 32 || secret.byteLength > 4096) {
      throw protocolError("Identity HMAC trust-domain tidak sah.");
    }
    this.#keyId = keyId;
    this.#secret = Buffer.from(secret);
  }

  async createProof(
    binding: TrustDomainRequestBinding,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw abortError();
    validateProofBinding(binding);
    const digest = createHmac("sha256", this.#secret)
      .update(JSON.stringify(binding), "utf8")
      .digest("base64url");
    return `${this.#keyId}.${digest}`;
  }
}

export interface TrustDomainHttpClientOptions {
  origin: string;
  protocol: string;
  proofProvider: TrustDomainRequestProofProvider;
  allowInsecureLoopback?: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  maxJsonResponseBytes?: number;
}

export interface TrustDomainUploadContent {
  mediaType: string;
  sha256: string;
  size: number;
  chunks: AsyncIterable<Uint8Array>;
}

export interface TrustDomainDownloadExpectation {
  mediaType: string;
  sha256: string;
  size: number;
}

/**
 * Strict client-side half of the versioned Harvy trust-domain protocol.
 * Redirects, URL-controlled routes, unbounded JSON, and host paths are absent
 * by construction. This is a transport primitive, not a capability health
 * signal; a caller must still prove the concrete remote service separately.
 */
export class TrustDomainHttpClient {
  private readonly origin: URL;
  private readonly protocol: string;
  private readonly proofProvider: TrustDomainRequestProofProvider;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly maxJsonResponseBytes: number;

  constructor(options: TrustDomainHttpClientOptions) {
    this.origin = validateOrigin(options.origin, options.allowInsecureLoopback === true);
    this.protocol = safeProtocol(options.protocol);
    this.proofProvider = options.proofProvider;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.maxJsonResponseBytes = boundedSize(
      options.maxJsonResponseBytes ?? DEFAULT_MAX_JSON_RESPONSE_BYTES,
      "batas JSON response",
      1024,
      16 * 1024 * 1024,
    );
  }

  async postJson(
    pathname: string,
    requestId: string,
    envelope: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const encoded = encodeEnvelope(envelope, MAX_JSON_ENVELOPE_BYTES);
    const binding = this.binding(
      pathname,
      requestId,
      sha256(encoded),
      null,
      "application/json",
      encoded.byteLength,
    );
    const headers = await this.headers(binding, signal, {
      "content-type": "application/json",
      "content-length": String(encoded.byteLength),
    });
    const response = await this.fetchFn(this.url(pathname), {
      method: "POST",
      headers,
      body: Buffer.from(encoded).toString("utf8"),
      redirect: "error",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    await this.validateResponseEnvelope(response, requestId);
    if (!isJsonContentType(response.headers.get("content-type"))) {
      await discard(response);
      throw protocolError("Content-Type JSON trust-domain tidak sah.");
    }
    const bytes = await readBoundedBody(response, this.maxJsonResponseBytes);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw protocolError("JSON response trust-domain tidak sah.");
    }
  }

  async postUpload(
    pathname: string,
    requestId: string,
    envelope: unknown,
    content: TrustDomainUploadContent,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const encodedEnvelope = encodeEnvelope(envelope, MAX_UPLOAD_ENVELOPE_BYTES);
    const envelopeSha256 = sha256(encodedEnvelope);
    const expected = validateContentExpectation(content);
    const binding = this.binding(
      pathname,
      requestId,
      envelopeSha256,
      expected.sha256,
      expected.mediaType,
      expected.size,
    );
    const headers = await this.headers(binding, signal, {
      "content-type": expected.mediaType,
      "content-length": String(expected.size),
      "x-harvy-envelope": Buffer.from(encodedEnvelope).toString("base64url"),
      "x-harvy-content-sha256": expected.sha256,
    });
    const verified = verifiedUpload(content.chunks, expected, signal);
    const body = readableStreamFrom(verified.chunks, signal);
    const response = await this.fetchFn(this.url(pathname), {
      method: "POST",
      headers,
      body,
      redirect: "error",
      cache: "no-store",
      ...(signal ? { signal } : {}),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!verified.completed()) {
      await discard(response);
      throw protocolError("Remote trust-domain tidak mengonsumsi seluruh upload.");
    }
    await this.validateResponseEnvelope(response, requestId);
    if (!isJsonContentType(response.headers.get("content-type"))) {
      await discard(response);
      throw protocolError("Content-Type JSON trust-domain tidak sah.");
    }
    const bytes = await readBoundedBody(response, this.maxJsonResponseBytes);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw protocolError("JSON response trust-domain tidak sah.");
    }
  }

  postDownload(
    pathname: string,
    requestId: string,
    envelope: unknown,
    expectation: TrustDomainDownloadExpectation,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const self = this;
    return (async function* (): AsyncGenerator<Uint8Array> {
      const encoded = encodeEnvelope(envelope, MAX_JSON_ENVELOPE_BYTES);
      const expected = validateContentExpectation(expectation);
      const binding = self.binding(
        pathname,
        requestId,
        sha256(encoded),
        null,
        "application/json",
        encoded.byteLength,
      );
      const headers = await self.headers(binding, signal, {
        "content-type": "application/json",
        "content-length": String(encoded.byteLength),
        accept: expected.mediaType,
      });
      const response = await self.fetchFn(self.url(pathname), {
        method: "POST",
        headers,
        body: Buffer.from(encoded).toString("utf8"),
        redirect: "error",
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      await self.validateResponseEnvelope(response, requestId);
      if (response.headers.get("content-type") !== expected.mediaType ||
        response.headers.get("x-harvy-content-sha256") !== expected.sha256 ||
        response.headers.get("content-length") !== String(expected.size)) {
        await discard(response);
        throw protocolError("Descriptor download trust-domain tidak cocok.");
      }
      if (!response.body) throw protocolError("Body download trust-domain hilang.");
      const reader = response.body.getReader();
      const hash = createHash("sha256");
      let size = 0;
      let complete = false;
      try {
        while (true) {
          if (signal?.aborted) throw abortError();
          const next = await reader.read();
          if (next.done) break;
          const chunk = next.value;
          if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1) {
            throw protocolError("Chunk download trust-domain tidak sah.");
          }
          size += chunk.byteLength;
          if (size > expected.size) {
            throw protocolError("Download trust-domain melampaui descriptor.");
          }
          hash.update(chunk);
          yield chunk;
        }
        if (size !== expected.size || hash.digest("hex") !== expected.sha256) {
          throw protocolError("Byte download trust-domain tidak cocok descriptor.");
        }
        complete = true;
      } finally {
        if (!complete) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    })();
  }

  private binding(
    pathname: string,
    requestId: string,
    envelopeSha256: string,
    contentSha256: string | null,
    contentMediaType: string,
    contentSize: number,
  ): TrustDomainRequestBinding {
    const issuedAt = this.now().toISOString();
    if (!Number.isFinite(Date.parse(issuedAt))) {
      throw protocolError("Clock trust-domain tidak sah.");
    }
    return Object.freeze({
      version: 1 as const,
      protocol: this.protocol,
      audience: this.origin.origin,
      method: "POST" as const,
      pathname: safePathname(pathname),
      requestId: safeRequestId(requestId),
      envelopeSha256: safeSha(envelopeSha256),
      contentSha256: contentSha256 === null ? null : safeSha(contentSha256),
      contentMediaType: validateContentMediaType(contentMediaType),
      contentSize: boundedSize(contentSize, "ukuran binding content", 1, 2 * 1024 * 1024 * 1024),
      issuedAt,
    });
  }

  private async headers(
    binding: TrustDomainRequestBinding,
    signal: AbortSignal | undefined,
    contentHeaders: Readonly<Record<string, string>>,
  ): Promise<Record<string, string>> {
    const proof = await this.proofProvider.createProof(binding, signal);
    if (typeof proof !== "string" || proof.length < 32 || proof.length > MAX_PROOF_LENGTH ||
      !/^[A-Za-z0-9._~-]+$/u.test(proof)) {
      throw protocolError("Proof trust-domain tidak sah.");
    }
    return {
      ...contentHeaders,
      accept: contentHeaders.accept ?? "application/json",
      "x-harvy-trust-protocol": this.protocol,
      "x-harvy-request-id": binding.requestId,
      "x-harvy-envelope-sha256": binding.envelopeSha256,
      "x-harvy-issued-at": binding.issuedAt,
      "x-harvy-request-proof": proof,
    };
  }

  private url(pathname: string): URL {
    return new URL(safePathname(pathname), this.origin);
  }

  private async validateResponseEnvelope(response: Response, requestId: string): Promise<void> {
    if (response.headers.get("x-harvy-trust-protocol") !== this.protocol ||
      response.headers.get("x-harvy-request-id") !== requestId) {
      await discard(response);
      throw protocolError("Response trust-domain tidak mengikat request/protocol.");
    }
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding !== null && contentEncoding !== "identity") {
      await discard(response);
      throw protocolError("Response trust-domain terkompresi tidak diizinkan.");
    }
    if (response.status !== 200) {
      await discard(response);
      throw protocolError(`Trust-domain menolak request (HTTP ${response.status}).`);
    }
  }
}

export function trustDomainRequestId(prefix: string, envelope: unknown): string {
  if (!/^[a-z][a-z0-9-]{2,39}$/u.test(prefix)) {
    throw protocolError("Prefix request trust-domain tidak sah.");
  }
  return `${prefix}-${sha256(encodeEnvelope(envelope, MAX_JSON_ENVELOPE_BYTES))}`;
}

function validateOrigin(value: string, allowInsecureLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw protocolError("Origin trust-domain tidak sah.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" ||
    url.hostname === "localhost";
  if ((url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:")) ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")) {
    throw protocolError("Origin trust-domain harus berupa origin HTTPS tanpa credential/path/query.");
  }
  return new URL(url.origin);
}

function validateProofBinding(binding: TrustDomainRequestBinding): void {
  const expected = [
    "version",
    "protocol",
    "audience",
    "method",
    "pathname",
    "requestId",
    "envelopeSha256",
    "contentSha256",
    "contentMediaType",
    "contentSize",
    "issuedAt",
  ].sort();
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
    JSON.stringify(Object.keys(binding).sort()) !== JSON.stringify(expected) ||
    binding.version !== 1 || binding.method !== "POST") {
    throw protocolError("Binding proof trust-domain tidak sah.");
  }
  safeProtocol(binding.protocol);
  const audience = validateOrigin(binding.audience, true);
  if (audience.origin !== binding.audience) {
    throw protocolError("Audience proof trust-domain tidak canonical.");
  }
  safePathname(binding.pathname);
  safeRequestId(binding.requestId);
  safeSha(binding.envelopeSha256);
  if (binding.contentSha256 !== null) safeSha(binding.contentSha256);
  validateContentMediaType(binding.contentMediaType);
  boundedSize(binding.contentSize, "ukuran proof content", 1, 2 * 1024 * 1024 * 1024);
  if (!Number.isFinite(Date.parse(binding.issuedAt)) ||
    new Date(binding.issuedAt).toISOString() !== binding.issuedAt) {
    throw protocolError("Waktu proof trust-domain tidak sah.");
  }
}

function safeProtocol(value: string): string {
  if (!/^[a-z][a-z0-9-]{2,31}\/1$/u.test(value)) {
    throw protocolError("Versi protocol trust-domain tidak sah.");
  }
  return value;
}

function safePathname(value: string): string {
  if (!/^\/v1\/[a-z0-9]+(?:[/-][a-z0-9]+)*$/u.test(value) || value.includes("..")) {
    throw protocolError("Path trust-domain tidak sah.");
  }
  return value;
}

function safeRequestId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{7,199}$/u.test(value)) {
    throw protocolError("Request ID trust-domain tidak sah.");
  }
  return value;
}

function encodeEnvelope(value: unknown, maximumBytes: number): Uint8Array {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw protocolError("Envelope trust-domain tidak dapat diserialisasi.");
  }
  if (json === undefined) throw protocolError("Envelope trust-domain hilang.");
  const bytes = Buffer.from(json, "utf8");
  if (bytes.byteLength < 2 || bytes.byteLength > maximumBytes) {
    throw protocolError("Envelope trust-domain melampaui batas.");
  }
  return bytes;
}

function validateContentExpectation(
  value: Pick<TrustDomainUploadContent, "mediaType" | "sha256" | "size">,
): { mediaType: string; sha256: string; size: number } {
  return {
    mediaType: validateContentMediaType(value.mediaType),
    sha256: safeSha(value.sha256),
    size: boundedSize(value.size, "ukuran content", 1, 2 * 1024 * 1024 * 1024),
  };
}

function verifiedUpload(
  chunks: AsyncIterable<Uint8Array>,
  expected: { sha256: string; size: number },
  signal?: AbortSignal,
): { chunks: AsyncIterable<Uint8Array>; completed: () => boolean } {
  if (!chunks || typeof chunks[Symbol.asyncIterator] !== "function") {
    throw protocolError("Upload trust-domain bukan async iterable.");
  }
  let complete = false;
  const verified = (async function* (): AsyncGenerator<Uint8Array> {
    const hash = createHash("sha256");
    let size = 0;
    for await (const value of chunks) {
      if (signal?.aborted) throw abortError();
      if (!(value instanceof Uint8Array) || value.byteLength < 1) {
        throw protocolError("Chunk upload trust-domain tidak sah.");
      }
      size += value.byteLength;
      if (size > expected.size) throw protocolError("Upload trust-domain melampaui descriptor.");
      hash.update(value);
      yield value;
    }
    if (size !== expected.size || hash.digest("hex") !== expected.sha256) {
      throw protocolError("Byte upload trust-domain tidak cocok descriptor.");
    }
    complete = true;
  })();
  return { chunks: verified, completed: () => complete };
}

function readableStreamFrom(
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (signal?.aborted) {
        controller.error(abortError());
        await iterator.return?.();
        return;
      }
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(): Promise<void> {
      await iterator.return?.();
    },
  });
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    await discard(response);
    throw protocolError("Response trust-domain melampaui batas.");
  }
  if (!response.body) throw protocolError("Body response trust-domain hilang.");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength < 1) {
        throw protocolError("Chunk response trust-domain tidak sah.");
      }
      size += next.value.byteLength;
      if (size > maxBytes) throw protocolError("Response trust-domain melampaui batas.");
      parts.push(next.value);
    }
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(parts.map((part) => Buffer.from(part)), size);
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function isJsonContentType(value: string | null): boolean {
  return value === "application/json" || value === "application/json; charset=utf-8";
}

function boundedSize(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw protocolError(`${label} trust-domain tidak sah.`);
  }
  return value;
}

function validateContentMediaType(value: string): string {
  if (!/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/u.test(value)) {
    throw protocolError("Media type trust-domain tidak sah.");
  }
  return value;
}

function safeSha(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw protocolError("SHA-256 trust-domain tidak sah.");
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function protocolError(message: string): Error {
  const error = new Error(message);
  error.name = "TrustDomainProtocolError";
  return error;
}

function abortError(): Error {
  const error = new Error("Request trust-domain dibatalkan.");
  error.name = "AbortError";
  return error;
}
