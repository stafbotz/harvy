import type {
  SandboxArtifactReference,
  SandboxDisposalReceipt,
  SandboxExecResult,
  SandboxHealth,
  SandboxLease,
  SandboxSnapshotResult,
} from "../domain/sandbox.js";
import type {
  SandboxAllocationRequest,
  SandboxTransport,
  SandboxTransportExecutionRequest,
} from "../sandbox/sandbox-transport.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import {
  TrustDomainHttpClient,
  trustDomainRequestId,
  type TrustDomainHttpClientOptions,
} from "./trust-domain-http.js";

const PROTOCOL = "harvy-sandbox/1";

export type HttpSandboxTransportOptions = Omit<
  TrustDomainHttpClientOptions,
  "protocol"
>;

/**
 * Authenticated wire adapter only. A healthy protocol response is still not
 * evidence of Linux/cgroup/seccomp isolation; live capability installation
 * remains gated by SandboxRunnerService attestation and deployment conformance.
 */
export class HttpSandboxTransport implements SandboxTransport {
  private readonly client: TrustDomainHttpClient;

  constructor(options: HttpSandboxTransportOptions) {
    this.client = new TrustDomainHttpClient({
      maxJsonResponseBytes: 1024 * 1024,
      ...options,
      protocol: PROTOCOL,
    });
  }

  async health(signal?: AbortSignal): Promise<SandboxHealth> {
    const envelope = { version: 1 as const };
    const raw = await this.client.postJson(
      "/v1/sandbox/health",
      trustDomainRequestId("sandbox-health", envelope),
      envelope,
      signal,
    );
    const result = wireResult(raw, "health sandbox");
    exactKeys(
      result,
      ["available", "runtime", "identity", "checkedAt", "reason"],
      "health sandbox",
    );
    const identity = result.identity === null
      ? null
      : exactClone(
          result.identity,
          ["serviceIdentityDigest", "runtimeImageDigest", "policyDigest"],
          "identity health sandbox",
        ) as Record<string, unknown>;
    if (typeof result.available !== "boolean" ||
      (result.runtime !== null && result.runtime !== "isolated-linux") ||
      (result.available && (
        result.runtime !== "isolated-linux" || result.reason !== null || !identity ||
        Object.values(identity).some((digest) =>
          typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)
        )
      )) ||
      (!result.available && (typeof result.reason !== "string" || identity !== null))) {
      throw protocolError("Health sandbox tidak sah.");
    }
    return Object.freeze({
      available: result.available,
      runtime: result.available ? "isolated-linux" : null,
      identity: result.available
        ? {
            serviceIdentityDigest: identity!.serviceIdentityDigest as string,
            runtimeImageDigest: identity!.runtimeImageDigest as string,
            policyDigest: identity!.policyDigest as string,
          }
        : null,
      checkedAt: iso(result.checkedAt, "waktu health sandbox"),
      reason: result.reason === null ? null : safeText(result.reason, "alasan health sandbox", 512),
    });
  }

  async allocate(
    requestInput: SandboxAllocationRequest,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<SandboxLease> {
    const request = exactClone(requestInput, [
      "leaseId",
      "binding",
      "network",
      "limits",
      "snapshot",
    ], "allocation sandbox") as unknown as SandboxAllocationRequest;
    noCredentialEnvelope(request, "allocation sandbox");
    const envelope = { version: 1 as const, request };
    const raw = await this.client.postUpload(
      "/v1/sandbox/allocate",
      request.leaseId,
      envelope,
      {
        mediaType: request.snapshot.mediaType,
        sha256: request.snapshot.bundleSha256,
        size: request.snapshot.size,
        chunks: content,
      },
      signal,
    );
    return structuredClone(wireResult(raw, "allocation sandbox")) as unknown as SandboxLease;
  }

  async execute(
    leaseId: string,
    requestInput: SandboxTransportExecutionRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    const request = exactClone(
      requestInput,
      ["version", "operationId", "requestDigest", "request"],
      "execution sandbox",
    ) as unknown as SandboxTransportExecutionRequest;
    const envelope = { version: 1 as const, leaseId: opaqueId(leaseId, "leaseId"), request };
    noCredentialEnvelope(envelope, "execution sandbox");
    const raw = await this.client.postJson(
      "/v1/sandbox/execute",
      request.operationId,
      envelope,
      signal,
    );
    return structuredClone(wireResult(raw, "execution sandbox")) as unknown as SandboxExecResult;
  }

  async captureSnapshot(
    leaseId: string,
    signal?: AbortSignal,
  ): Promise<SandboxSnapshotResult> {
    const envelope = { version: 1 as const, leaseId: opaqueId(leaseId, "leaseId") };
    const raw = await this.client.postJson(
      "/v1/sandbox/capture-snapshot",
      trustDomainRequestId("sandbox-capture", envelope),
      envelope,
      signal,
    );
    return structuredClone(wireResult(raw, "snapshot sandbox")) as unknown as SandboxSnapshotResult;
  }

  downloadArtifact(
    leaseId: string,
    artifactInput: SandboxArtifactReference,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const artifact = exactClone(
      artifactInput,
      ["artifactId", "sha256", "size", "mediaType", "purpose"],
      "artifact sandbox",
    ) as unknown as SandboxArtifactReference;
    const envelope = {
      version: 1 as const,
      leaseId: opaqueId(leaseId, "leaseId"),
      artifact,
    };
    noCredentialEnvelope(envelope, "artifact sandbox");
    return this.client.postDownload(
      "/v1/sandbox/download-artifact",
      opaqueId(artifact.artifactId, "artifactId"),
      envelope,
      {
        mediaType: artifact.mediaType,
        sha256: artifact.sha256,
        size: artifact.size,
      },
      signal,
    );
  }

  async cancelAndDispose(
    leaseId: string,
    signal?: AbortSignal,
  ): Promise<SandboxDisposalReceipt> {
    const envelope = { version: 1 as const, leaseId: opaqueId(leaseId, "leaseId") };
    const raw = await this.client.postJson(
      "/v1/sandbox/cancel-and-dispose",
      envelope.leaseId,
      envelope,
      signal,
    );
    return structuredClone(wireResult(raw, "disposal sandbox")) as unknown as SandboxDisposalReceipt;
  }
}

function wireResult(input: unknown, label: string): Record<string, unknown> {
  exactKeys(input, ["version", "result"], `wire ${label}`);
  const wire = input as Record<string, unknown>;
  if (wire.version !== 1 || !plainObject(wire.result)) {
    throw protocolError(`Wire ${label} tidak sah.`);
  }
  noCredentialEnvelope(wire.result, `response ${label}`);
  return wire.result;
}

function exactClone(
  input: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  exactKeys(input, keys, label);
  return structuredClone(input) as Record<string, unknown>;
}

function noCredentialEnvelope(input: unknown, label: string): void {
  const serialized = JSON.stringify(input);
  if (serialized === undefined || serialized.length > 2 * 1024 * 1024 ||
    containsSecretLikeValue(serialized) ||
    /"(?:internalPath|hostPath|dockerSocket)"\s*:/iu.test(serialized)) {
    throw protocolError(`Envelope ${label} memuat credential/path terlarang atau terlalu besar.`);
  }
}

function opaqueId(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length < 8 || input.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input) || containsSecretLikeValue(input)) {
    throw protocolError(`${label} sandbox tidak sah.`);
  }
  return input;
}

function safeText(input: unknown, label: string, max: number): string {
  if (typeof input !== "string" || input.length < 1 || input.length > max ||
    /\p{Cc}/u.test(input) || containsSecretLikeValue(input)) {
    throw protocolError(`${label} tidak sah.`);
  }
  return input;
}

function iso(input: unknown, label: string): string {
  if (typeof input !== "string" || !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input) {
    throw protocolError(`${label} tidak sah.`);
  }
  return input;
}

function exactKeys(input: unknown, expected: readonly string[], label: string): void {
  if (!plainObject(input) ||
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...expected].sort())) {
    throw protocolError(`Schema ${label} memuat field asing atau hilang.`);
  }
}

function plainObject(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function protocolError(message: string): Error {
  const error = new Error(message);
  error.name = "SandboxProtocolError";
  return error;
}
