import type {
  SandboxArtifactReference,
  SandboxBinding,
  SandboxExecRequest,
  SandboxResourceLimits,
} from "../domain/sandbox.js";
import type { ProjectSnapshotBundleDescriptor } from "../domain/project-transfer.js";
import type {
  SandboxAllocationRequest,
  SandboxTransportExecutionRequest,
} from "./sandbox-transport.js";
import { canonicalProjectPath } from "../core/project-files.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import {
  OciSandboxBackend,
  openStoredSandboxArtifact,
} from "./oci-sandbox-backend.js";
import type {
  TrustDomainServiceHandler,
  TrustDomainServiceRequest,
  TrustDomainServiceResponse,
} from "../transport/trust-domain-http-server.js";

/** Exact route surface for the credential-free isolated Linux service. */
export class SandboxServiceHandler implements TrustDomainServiceHandler {
  constructor(private readonly backend: OciSandboxBackend) {}

  async handle(request: TrustDomainServiceRequest): Promise<TrustDomainServiceResponse> {
    rejectCredentialEnvelope(request.envelope);
    switch (request.binding.pathname) {
      case "/v1/sandbox/health": {
        exactEnvelope(request, ["version"], false);
        return json(await this.backend.health());
      }
      case "/v1/sandbox/allocate": {
        exactEnvelope(request, ["version", "request"], true);
        const envelope = object(request.envelope);
        const allocation = parseAllocation(envelope.request);
        const content = request.content!;
        if (content.mediaType !== allocation.snapshot.mediaType ||
          content.sha256 !== allocation.snapshot.bundleSha256 ||
          content.size !== allocation.snapshot.size) {
          throw routeError("Upload allocation sandbox tidak cocok descriptor.");
        }
        return json(await this.backend.allocate(allocation, content.chunks, request.signal));
      }
      case "/v1/sandbox/execute": {
        exactEnvelope(request, ["version", "leaseId", "request"], false);
        const envelope = object(request.envelope);
        return json(await this.backend.execute(
          opaque(envelope.leaseId, "leaseId"),
          parseExecution(envelope.request),
          request.signal,
        ));
      }
      case "/v1/sandbox/capture-snapshot": {
        exactEnvelope(request, ["version", "leaseId"], false);
        return json(await this.backend.captureSnapshot(
          opaque(object(request.envelope).leaseId, "leaseId"),
          request.signal,
        ));
      }
      case "/v1/sandbox/download-artifact": {
        exactEnvelope(request, ["version", "leaseId", "artifact"], false);
        const envelope = object(request.envelope);
        const artifact = parseArtifact(envelope.artifact);
        const stored = await this.backend.artifact(
          opaque(envelope.leaseId, "leaseId"),
          artifact,
        );
        return {
          kind: "download",
          mediaType: artifact.mediaType,
          sha256: artifact.sha256,
          size: artifact.size,
          chunks: openStoredSandboxArtifact(stored),
        };
      }
      case "/v1/sandbox/cancel-and-dispose": {
        exactEnvelope(request, ["version", "leaseId"], false);
        return json(await this.backend.cancelAndDispose(
          opaque(object(request.envelope).leaseId, "leaseId"),
        ));
      }
      default:
        throw routeError("Route sandbox tidak dikenal.");
    }
  }
}

function parseAllocation(input: unknown): SandboxAllocationRequest {
  const value = object(input);
  exactKeys(value, ["leaseId", "binding", "network", "limits", "snapshot"], "allocation sandbox");
  if (value.network !== "off") throw routeError("Network sandbox wajib off.");
  const binding = parseBinding(value.binding);
  const snapshot = parseSnapshot(value.snapshot, binding.snapshotId);
  return {
    leaseId: opaque(value.leaseId, "leaseId"),
    binding,
    network: "off",
    limits: parseLimits(value.limits),
    snapshot,
  };
}

function parseBinding(input: unknown): SandboxBinding {
  const value = object(input);
  exactKeys(value, [
    "ownerWorkspaceKey", "projectId", "snapshotId", "workspaceRevision", "runId",
  ], "binding sandbox");
  if (typeof value.snapshotId !== "string" || !/^[a-f0-9]{64}$/u.test(value.snapshotId) ||
    typeof value.workspaceRevision !== "number" || !Number.isSafeInteger(value.workspaceRevision) ||
    value.workspaceRevision < 1) {
    throw routeError("Binding snapshot/revision sandbox tidak sah.");
  }
  return {
    ownerWorkspaceKey: opaque(value.ownerWorkspaceKey, "ownerWorkspaceKey"),
    projectId: opaque(value.projectId, "projectId"),
    snapshotId: value.snapshotId,
    workspaceRevision: value.workspaceRevision,
    runId: opaque(value.runId, "runId"),
  };
}

function parseLimits(input: unknown): SandboxResourceLimits {
  const value = object(input);
  const keys = [
    "cpuCores", "memoryBytes", "diskBytes", "pids", "wallClockMs",
    "maxOutputBytes", "maxArtifacts", "maxArtifactBytes",
  ] as const;
  exactKeys(value, keys, "limits sandbox");
  const limits = Object.fromEntries(keys.map((key) => [
    key,
    positiveInteger(value[key], `limit ${key}`),
  ])) as unknown as SandboxResourceLimits;
  if (limits.cpuCores > 64 || limits.pids > 4_096 ||
    limits.memoryBytes > 256 * 1_024 * 1_024 * 1_024 ||
    limits.diskBytes > 2 * 1_024 * 1_024 * 1_024 * 1_024 ||
    limits.wallClockMs > 24 * 60 * 60_000 || limits.maxArtifacts > 256 ||
    limits.maxArtifactBytes > 2 * 1_024 * 1_024 * 1_024) {
    throw routeError("Resource limit sandbox melampaui policy service.");
  }
  return limits;
}

function parseSnapshot(input: unknown, snapshotId: string): ProjectSnapshotBundleDescriptor {
  const value = object(input);
  exactKeys(value, [
    "version", "snapshotId", "bundleSha256", "manifestSha256", "size", "fileCount", "mediaType",
  ], "snapshot sandbox");
  if (value.version !== 1 || value.snapshotId !== snapshotId ||
    value.mediaType !== "application/vnd.harvy.snapshot-bundle.v1" ||
    typeof value.bundleSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.bundleSha256) ||
    typeof value.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.manifestSha256) ||
    typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 1 ||
    typeof value.fileCount !== "number" || !Number.isSafeInteger(value.fileCount) ||
    value.fileCount < 0 || value.fileCount > 10_000) {
    throw routeError("Descriptor snapshot sandbox tidak sah.");
  }
  return {
    version: 1,
    snapshotId,
    bundleSha256: value.bundleSha256,
    manifestSha256: value.manifestSha256,
    size: value.size,
    fileCount: value.fileCount,
    mediaType: "application/vnd.harvy.snapshot-bundle.v1",
  };
}

function parseExecution(input: unknown): SandboxTransportExecutionRequest {
  const value = object(input);
  exactKeys(value, ["version", "operationId", "requestDigest", "request"], "execution sandbox");
  if (value.version !== 1 || typeof value.operationId !== "string" ||
    !/^sandbox-exec:[A-Za-z0-9-]{8,128}$/u.test(value.operationId) ||
    typeof value.requestDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestDigest)) {
    throw routeError("Binding execution sandbox tidak sah.");
  }
  return {
    version: 1,
    operationId: value.operationId,
    requestDigest: value.requestDigest,
    request: parseExecRequest(value.request),
  };
}

function parseExecRequest(input: unknown): SandboxExecRequest {
  const value = object(input);
  exactKeys(value, ["argv", "cwd", "purpose", "timeoutMs"], "exec request sandbox");
  if (!Array.isArray(value.argv) || value.argv.length < 1 || value.argv.length > 128 ||
    value.argv.some((part) => typeof part !== "string" || part.length < 1 ||
      part.length > 32_768 || /[\u0000\r\n]/u.test(part)) ||
    (value.purpose !== "inspect" && value.purpose !== "test" && value.purpose !== "lint" &&
      value.purpose !== "typecheck" && value.purpose !== "build") ||
    typeof value.timeoutMs !== "number" || !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 1 || value.timeoutMs > 24 * 60 * 60_000 || typeof value.cwd !== "string") {
    throw routeError("Exec request sandbox tidak sah.");
  }
  const cwd = value.cwd === "." ? "." : canonicalProjectPath(value.cwd);
  return {
    argv: value.argv as [string, ...string[]],
    cwd,
    purpose: value.purpose,
    timeoutMs: value.timeoutMs,
  };
}

function parseArtifact(input: unknown): SandboxArtifactReference {
  const value = object(input);
  exactKeys(value, ["artifactId", "sha256", "size", "mediaType", "purpose"], "artifact sandbox");
  if (typeof value.artifactId !== "string" ||
    !/^sandbox-(?:stdout|stderr|workspace-snapshot|build-artifact)-[a-f0-9]{64}$/u.test(value.artifactId) ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 ||
    typeof value.mediaType !== "string" ||
    !/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/u.test(value.mediaType) ||
    (value.purpose !== "stdout" && value.purpose !== "stderr" &&
      value.purpose !== "workspace-snapshot" && value.purpose !== "build-artifact")) {
    throw routeError("Descriptor artifact sandbox tidak sah.");
  }
  return value as unknown as SandboxArtifactReference;
}

function exactEnvelope(
  request: TrustDomainServiceRequest,
  keys: readonly string[],
  contentRequired: boolean,
): void {
  const envelope = object(request.envelope);
  exactKeys(envelope, keys, "envelope sandbox");
  if (envelope.version !== 1 || Boolean(request.content) !== contentRequired) {
    throw routeError("Versi/content envelope sandbox tidak sah.");
  }
}

function rejectCredentialEnvelope(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > 2 * 1_024 * 1_024 ||
    containsSecretLikeValue(serialized) ||
    /"(?:env|environment|hostPath|internalPath|dockerSocket|mounts?)"\s*:/iu.test(serialized)) {
    throw routeError("Envelope sandbox memuat credential/path/field terlarang.");
  }
}

function opaque(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value) || containsSecretLikeValue(value)) {
    throw routeError(`${label} sandbox tidak sah.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw routeError(`${label} sandbox tidak sah.`);
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw routeError("Object sandbox route tidak sah.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw routeError(`${label} memuat field asing atau hilang.`);
  }
}

function json(result: unknown): TrustDomainServiceResponse {
  return { kind: "json", result };
}

function routeError(message: string): Error {
  const error = new Error(message);
  error.name = "SandboxRouteError";
  return error;
}
