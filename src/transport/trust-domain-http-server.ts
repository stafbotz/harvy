import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { TrustDomainRequestBinding } from "./trust-domain-http.js";

const MAX_PROOF_LENGTH = 4_096;
const MAX_UPLOAD_ENVELOPE_BYTES = 4 * 1_024;
const DEFAULT_MAX_JSON_BYTES = 1_024 * 1_024;
const DEFAULT_MAX_CONTENT_BYTES = 2 * 1_024 * 1_024 * 1_024;
const DEFAULT_CLOCK_SKEW_MS = 2 * 60_000;

export interface TrustDomainServiceIdentity {
  keyId: string;
  secret: Uint8Array;
}

export interface TrustDomainIncomingContent {
  mediaType: string;
  sha256: string;
  size: number;
  chunks: AsyncIterable<Uint8Array>;
}

export interface TrustDomainServiceRequest {
  binding: TrustDomainRequestBinding;
  envelope: unknown;
  content: TrustDomainIncomingContent | null;
  signal: AbortSignal;
}

export type TrustDomainServiceResponse =
  | { kind: "json"; result: unknown }
  | {
      kind: "download";
      mediaType: string;
      sha256: string;
      size: number;
      chunks: AsyncIterable<Uint8Array>;
    };

export interface TrustDomainServiceHandler {
  handle(request: TrustDomainServiceRequest): Promise<TrustDomainServiceResponse>;
}

export interface TrustDomainHttpServerOptions {
  protocol: string;
  host: string;
  port: number;
  identities: readonly TrustDomainServiceIdentity[];
  handler: TrustDomainServiceHandler;
  /** Required outside an insecure loopback development listener. */
  publicOrigin?: string;
  tls?: Pick<HttpsServerOptions, "key" | "cert" | "ca" | "requestCert" | "rejectUnauthorized">;
  maxJsonBytes?: number;
  maxContentBytes?: number;
  clockSkewMs?: number;
  now?: () => Date;
}

export interface TrustDomainHttpServerAddress {
  origin: string;
  host: string;
  port: number;
}

/**
 * Server-side half of the Harvy trust-domain protocol. It authenticates an
 * exact method/path/body binding before dispatch and never exposes proof
 * material to a route handler. Capability idempotency remains route-owned.
 */
export class TrustDomainHttpServer {
  readonly #protocol: string;
  readonly #host: string;
  readonly #port: number;
  readonly #identities: ReadonlyMap<string, Buffer>;
  readonly #handler: TrustDomainServiceHandler;
  readonly #configuredOrigin: string | null;
  readonly #maxJsonBytes: number;
  readonly #maxContentBytes: number;
  readonly #clockSkewMs: number;
  readonly #now: () => Date;
  readonly #server: Server;
  #origin: string | null = null;
  #started = false;

  constructor(options: TrustDomainHttpServerOptions) {
    this.#protocol = safeProtocol(options.protocol);
    this.#host = safeHost(options.host);
    this.#port = boundedInteger(options.port, "port", 0, 65_535);
    this.#identities = identityMap(options.identities);
    this.#handler = options.handler;
    this.#configuredOrigin = options.publicOrigin === undefined
      ? null
      : canonicalOrigin(options.publicOrigin, options.tls !== undefined);
    this.#maxJsonBytes = boundedInteger(
      options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES,
      "maxJsonBytes",
      1_024,
      16 * 1_024 * 1_024,
    );
    this.#maxContentBytes = boundedInteger(
      options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES,
      "maxContentBytes",
      1_024,
      DEFAULT_MAX_CONTENT_BYTES,
    );
    this.#clockSkewMs = boundedInteger(
      options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
      "clockSkewMs",
      1_000,
      15 * 60_000,
    );
    this.#now = options.now ?? (() => new Date());
    const listener = (request: IncomingMessage, response: ServerResponse): void => {
      void this.#dispatch(request, response);
    };
    this.#server = options.tls
      ? createHttpsServer(options.tls, listener)
      : createHttpServer(listener);
  }

  async start(): Promise<TrustDomainHttpServerAddress> {
    if (this.#started) throw serviceError("Trust-domain server sudah berjalan.");
    if (!this.#configuredOrigin && !isLoopbackHost(this.#host)) {
      throw serviceError("publicOrigin HTTPS wajib untuk listener non-loopback.");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw serviceError("Alamat trust-domain server tidak tersedia.");
    }
    const port = (address as AddressInfo).port;
    this.#origin = this.#configuredOrigin ?? `http://${loopbackOriginHost(this.#host)}:${port}`;
    this.#started = true;
    return Object.freeze({ origin: this.#origin, host: this.#host, port });
  }

  async close(): Promise<void> {
    if (!this.#server.listening) {
      this.#started = false;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
      this.#server.closeIdleConnections();
    });
    this.#started = false;
  }

  async #dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(abortError());
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableEnded) abort();
    });
    let requestId: string | null = null;
    try {
      if (!this.#origin || request.method !== "POST") {
        throw requestError("Method trust-domain tidak diizinkan.", 405);
      }
      rejectAmbiguousTransfer(request.headers);
      const pathname = requestPathname(request.url);
      const upload = singleHeader(request.headers, "x-harvy-envelope") !== null;
      const contentType = singleHeader(request.headers, "content-type");
      const contentLength = contentLengthHeader(request.headers, this.#maxContentBytes);
      requestId = safeRequestId(requiredHeader(request.headers, "x-harvy-request-id"));
      const issuedAt = canonicalIso(requiredHeader(request.headers, "x-harvy-issued-at"));
      const issuedTime = Date.parse(issuedAt);
      if (Math.abs(this.#now().getTime() - issuedTime) > this.#clockSkewMs) {
        throw requestError("Proof trust-domain kedaluwarsa.", 401);
      }
      if (requiredHeader(request.headers, "x-harvy-trust-protocol") !== this.#protocol) {
        throw requestError("Protocol trust-domain tidak cocok.", 401);
      }
      const envelopeSha256 = safeSha(
        requiredHeader(request.headers, "x-harvy-envelope-sha256"),
      );
      const contentSha256 = upload
        ? safeSha(requiredHeader(request.headers, "x-harvy-content-sha256"))
        : null;
      if (contentType === null || (upload
        ? !validMediaType(contentType)
        : contentType !== "application/json")) {
        throw requestError("Content-Type trust-domain tidak sah.", 400);
      }
      const binding: TrustDomainRequestBinding = Object.freeze({
        version: 1,
        protocol: this.#protocol,
        audience: this.#origin,
        method: "POST",
        pathname,
        requestId,
        envelopeSha256,
        contentSha256,
        contentMediaType: contentType,
        contentSize: contentLength,
        issuedAt,
      });
      this.#verifyProof(binding, requiredHeader(request.headers, "x-harvy-request-proof"));

      const prepared = upload
        ? prepareUploadRequest(
            request,
            binding,
            requiredHeader(request.headers, "x-harvy-envelope"),
            this.#maxContentBytes,
            controller.signal,
          )
        : await prepareJsonRequest(
            request,
            binding,
            this.#maxJsonBytes,
            controller.signal,
          );
      const routed = await this.#handler.handle({
        binding,
        envelope: prepared.envelope,
        content: prepared.content,
        signal: controller.signal,
      });
      if (prepared.completed && !prepared.completed()) {
        throw requestError("Route tidak mengonsumsi seluruh upload.", 400);
      }
      if (routed.kind === "json") {
        await sendJson(response, this.#protocol, requestId, routed.result);
      } else {
        await sendDownload(response, this.#protocol, requestId, routed, controller.signal);
      }
    } catch (error) {
      if (!response.headersSent) {
        const status = error instanceof TrustDomainRequestError ? error.status : 503;
        sendFailure(response, this.#protocol, requestId, status);
      } else if (!response.writableEnded) {
        response.destroy();
      }
      request.destroy();
    } finally {
      request.off("aborted", abort);
    }
  }

  #verifyProof(binding: TrustDomainRequestBinding, proof: string): void {
    if (proof.length < 32 || proof.length > MAX_PROOF_LENGTH ||
      !/^[A-Za-z0-9_-]{3,64}\.[A-Za-z0-9_-]{43}$/u.test(proof)) {
      throw requestError("Proof trust-domain tidak sah.", 401);
    }
    const separator = proof.indexOf(".");
    const keyId = proof.slice(0, separator);
    const supplied = Buffer.from(proof.slice(separator + 1), "base64url");
    const secret = this.#identities.get(keyId);
    if (!secret) throw requestError("Identity trust-domain tidak dikenal.", 401);
    const expected = createHmac("sha256", secret)
      .update(JSON.stringify(binding), "utf8")
      .digest();
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw requestError("Proof trust-domain tidak cocok.", 401);
    }
  }
}

interface PreparedRequest {
  envelope: unknown;
  content: TrustDomainIncomingContent | null;
  completed: (() => boolean) | null;
}

async function prepareJsonRequest(
  request: IncomingMessage,
  binding: TrustDomainRequestBinding,
  maxBytes: number,
  signal: AbortSignal,
): Promise<PreparedRequest> {
  const bytes = await readRequestBody(request, Math.min(maxBytes, binding.contentSize), signal);
  if (bytes.byteLength !== binding.contentSize || sha256(bytes) !== binding.envelopeSha256) {
    throw requestError("Body JSON trust-domain tidak cocok binding.", 400);
  }
  return { envelope: parseJson(bytes), content: null, completed: null };
}

function prepareUploadRequest(
  request: IncomingMessage,
  binding: TrustDomainRequestBinding,
  encodedEnvelope: string,
  maxBytes: number,
  signal: AbortSignal,
): PreparedRequest {
  if (encodedEnvelope.length < 3 || encodedEnvelope.length > 8_192 ||
    !/^[A-Za-z0-9_-]+$/u.test(encodedEnvelope)) {
    throw requestError("Envelope upload trust-domain tidak sah.", 400);
  }
  const envelopeBytes = Buffer.from(encodedEnvelope, "base64url");
  if (envelopeBytes.byteLength < 2 || envelopeBytes.byteLength > MAX_UPLOAD_ENVELOPE_BYTES ||
    sha256(envelopeBytes) !== binding.envelopeSha256) {
    throw requestError("Envelope upload trust-domain tidak cocok binding.", 400);
  }
  const verified = verifiedIncomingBody(
    request,
    binding.contentSha256!,
    binding.contentSize,
    maxBytes,
    signal,
  );
  return {
    envelope: parseJson(envelopeBytes),
    content: {
      mediaType: binding.contentMediaType,
      sha256: binding.contentSha256!,
      size: binding.contentSize,
      chunks: verified.chunks,
    },
    completed: verified.completed,
  };
}

function verifiedIncomingBody(
  request: IncomingMessage,
  expectedSha256: string,
  expectedSize: number,
  maxBytes: number,
  signal: AbortSignal,
): { chunks: AsyncIterable<Uint8Array>; completed: () => boolean } {
  let complete = false;
  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    const hash = createHash("sha256");
    let size = 0;
    for await (const value of request) {
      if (signal.aborted) throw abortError();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      if (chunk.byteLength < 1) continue;
      size += chunk.byteLength;
      if (size > expectedSize || size > maxBytes) {
        throw requestError("Upload trust-domain melampaui batas.", 413);
      }
      hash.update(chunk);
      yield chunk;
    }
    if (size !== expectedSize || hash.digest("hex") !== expectedSha256) {
      throw requestError("Upload trust-domain tidak cocok descriptor.", 400);
    }
    complete = true;
  })();
  return { chunks, completed: () => complete };
}

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    if (signal.aborted) throw abortError();
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.byteLength;
    if (size > maxBytes) throw requestError("Body trust-domain melampaui batas.", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function sendJson(
  response: ServerResponse,
  protocol: string,
  requestId: string,
  result: unknown,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify({ version: 1, result }), "utf8");
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": String(bytes.byteLength),
    "content-encoding": "identity",
    "x-harvy-trust-protocol": protocol,
    "x-harvy-request-id": requestId,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

async function sendDownload(
  response: ServerResponse,
  protocol: string,
  requestId: string,
  download: Extract<TrustDomainServiceResponse, { kind: "download" }>,
  signal: AbortSignal,
): Promise<void> {
  const size = boundedInteger(download.size, "download size", 1, DEFAULT_MAX_CONTENT_BYTES);
  const expectedSha256 = safeSha(download.sha256);
  const mediaType = validMediaType(download.mediaType)
    ? download.mediaType
    : (() => { throw serviceError("Media type download tidak sah."); })();
  response.writeHead(200, {
    "content-type": mediaType,
    "content-length": String(size),
    "content-encoding": "identity",
    "x-harvy-content-sha256": expectedSha256,
    "x-harvy-trust-protocol": protocol,
    "x-harvy-request-id": requestId,
    "cache-control": "no-store",
  });
  const hash = createHash("sha256");
  let written = 0;
  for await (const value of download.chunks) {
    if (signal.aborted) throw abortError();
    if (!(value instanceof Uint8Array) || value.byteLength < 1) {
      throw serviceError("Chunk download trust-domain tidak sah.");
    }
    written += value.byteLength;
    if (written > size) throw serviceError("Download trust-domain melampaui descriptor.");
    hash.update(value);
    if (!response.write(value)) await once(response, "drain");
  }
  if (written !== size || hash.digest("hex") !== expectedSha256) {
    throw serviceError("Download trust-domain tidak cocok descriptor.");
  }
  response.end();
}

function sendFailure(
  response: ServerResponse,
  protocol: string,
  requestId: string | null,
  status: number,
): void {
  const bytes = Buffer.from(JSON.stringify({ version: 1, error: "request_rejected" }), "utf8");
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.byteLength),
    "content-encoding": "identity",
    "x-harvy-trust-protocol": protocol,
    ...(requestId ? { "x-harvy-request-id": requestId } : {}),
    "cache-control": "no-store",
  });
  response.end(bytes);
}

function identityMap(
  identities: readonly TrustDomainServiceIdentity[],
): ReadonlyMap<string, Buffer> {
  if (!Array.isArray(identities) || identities.length < 1 || identities.length > 32) {
    throw serviceError("Identity trust-domain kosong atau melampaui batas.");
  }
  const mapped = new Map<string, Buffer>();
  for (const identity of identities) {
    if (!/^[A-Za-z0-9_-]{3,64}$/u.test(identity.keyId) ||
      !(identity.secret instanceof Uint8Array) || identity.secret.byteLength < 32 ||
      identity.secret.byteLength > 4_096 || mapped.has(identity.keyId)) {
      throw serviceError("Identity trust-domain tidak sah atau duplikat.");
    }
    mapped.set(identity.keyId, Buffer.from(identity.secret));
  }
  return mapped;
}

function rejectAmbiguousTransfer(headers: IncomingHttpHeaders): void {
  if (singleHeader(headers, "content-encoding") !== null ||
    singleHeader(headers, "transfer-encoding") !== null) {
    throw requestError("Encoding/transfer trust-domain tidak diizinkan.", 400);
  }
}

function contentLengthHeader(headers: IncomingHttpHeaders, max: number): number {
  const raw = requiredHeader(headers, "content-length");
  if (!/^\d+$/u.test(raw)) throw requestError("Content-Length tidak sah.", 400);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw requestError("Content-Length melampaui batas.", 413);
  }
  return value;
}

function requiredHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = singleHeader(headers, name);
  if (value === null || value.length < 1) {
    throw requestError(`Header ${name} hilang.`, 400);
  }
  return value;
}

function singleHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (value === undefined) return null;
  if (Array.isArray(value) || typeof value !== "string" || value.includes(",")) {
    throw requestError(`Header ${name} ambigu.`, 400);
  }
  return value;
}

function requestPathname(raw: string | undefined): string {
  if (!raw) throw requestError("Path trust-domain hilang.", 400);
  let url: URL;
  try {
    url = new URL(raw, "http://trust-domain.invalid");
  } catch {
    throw requestError("Path trust-domain tidak sah.", 400);
  }
  if (url.search || url.hash || !/^\/v1\/[a-z0-9]+(?:[/-][a-z0-9]+)*$/u.test(url.pathname) ||
    url.pathname.includes("..")) {
    throw requestError("Path trust-domain tidak sah.", 400);
  }
  return url.pathname;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw requestError("JSON trust-domain tidak sah.", 400);
  }
}

function canonicalOrigin(value: string, tls: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw serviceError("publicOrigin trust-domain tidak sah.");
  }
  if (url.origin !== value || url.username || url.password || url.pathname !== "/" ||
    url.search || url.hash || (tls ? url.protocol !== "https:" :
      !(url.protocol === "http:" && isLoopbackHost(url.hostname)))) {
    throw serviceError("publicOrigin trust-domain tidak cocok listener/TLS.");
  }
  return url.origin;
}

function safeProtocol(value: string): string {
  if (!/^[a-z][a-z0-9-]{2,31}\/1$/u.test(value)) {
    throw serviceError("Protocol trust-domain tidak sah.");
  }
  return value;
}

function safeHost(value: string): string {
  if (!value || value.length > 253 || /[\s/?#]/u.test(value)) {
    throw serviceError("Host trust-domain tidak sah.");
  }
  return value;
}

function safeRequestId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{7,199}$/u.test(value)) {
    throw requestError("Request ID trust-domain tidak sah.", 400);
  }
  return value;
}

function safeSha(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw requestError("SHA trust-domain tidak sah.", 400);
  return value;
}

function canonicalIso(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw requestError("Waktu trust-domain tidak sah.", 400);
  }
  return value;
}

function validMediaType(value: string): boolean {
  return /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/u.test(value);
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw serviceError(`${label} trust-domain tidak sah.`);
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "[::1]";
}

function loopbackOriginHost(host: string): string {
  return host === "::1" ? "[::1]" : host;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

class TrustDomainRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TrustDomainRequestError";
  }
}

function requestError(message: string, status: number): TrustDomainRequestError {
  return new TrustDomainRequestError(message, status);
}

function serviceError(message: string): Error {
  const error = new Error(message);
  error.name = "TrustDomainServiceError";
  return error;
}

function abortError(): Error {
  const error = new Error("Request trust-domain dibatalkan.");
  error.name = "AbortError";
  return error;
}
