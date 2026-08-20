import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { DEFAULT_SANDBOX_LIMITS } from "../src/core/sandbox-runner-service.js";
import type {
  SandboxArtifactReference,
  SandboxLease,
} from "../src/domain/sandbox.js";
import type {
  SandboxAllocationRequest,
  SandboxTransportExecutionRequest,
} from "../src/sandbox/sandbox-transport.js";
import { HttpSandboxTransport } from "../src/transport/http-sandbox-transport.js";
import type {
  TrustDomainRequestBinding,
  TrustDomainRequestProofProvider,
} from "../src/transport/trust-domain-http.js";

const ORIGIN = "http://127.0.0.1:41874";
const PROTOCOL = "harvy-sandbox/1";
const NOW = "2026-08-11T09:00:00.000Z";

describe("HTTP Sandbox trust-domain transport", () => {
  it("mengalirkan snapshot, mengikat proof, dan tidak mengirim host path/credential", async () => {
    const bytes = Buffer.from("sandbox-snapshot-wire", "utf8");
    const request = allocation(bytes);
    const proof = new ProofProvider();
    let uploaded = Buffer.alloc(0);
    let encodedEnvelope = "";
    let observedHeaders = new Headers();
    const transport = createTransport(async (url, init) => {
      observedHeaders = new Headers(init?.headers);
      const path = new URL(url).pathname;
      if (path.endsWith("/health")) {
        await requestBytes(init);
        return jsonResponse(observedHeaders, {
          available: true,
          runtime: "isolated-linux",
          identity: {
            serviceIdentityDigest: "1".repeat(64),
            runtimeImageDigest: "2".repeat(64),
            policyDigest: "3".repeat(64),
          },
          checkedAt: NOW,
          reason: null,
        });
      }
      assert.equal(path.endsWith("/allocate"), true);
      uploaded = Buffer.from(await requestBytes(init));
      encodedEnvelope = Buffer.from(
        observedHeaders.get("x-harvy-envelope") ?? "",
        "base64url",
      ).toString("utf8");
      return jsonResponse(observedHeaders, lease(request));
    }, proof);

    assert.equal((await transport.health()).available, true);
    const allocated = await transport.allocate(request, chunks(bytes));
    assert.equal(allocated.leaseId, request.leaseId);
    assert.deepEqual(uploaded, bytes);
    assert.equal(observedHeaders.has("authorization"), false);
    assert.doesNotMatch(encodedEnvelope, /internalPath|hostPath|TOKEN_SENTINEL|C:\\/u);
    assert.equal(proof.bindings.at(-1)?.audience, ORIGIN);
    assert.equal(proof.bindings.at(-1)?.contentSha256, request.snapshot.bundleSha256);
    assert.equal(proof.bindings.at(-1)?.contentSize, bytes.byteLength);
  });

  it("mengikat execution ID/digest dan memverifikasi artifact download", async () => {
    const bytes = Buffer.from("artifact-from-sandbox", "utf8");
    const artifact: SandboxArtifactReference = {
      artifactId: "artifact-sandbox-http-1",
      sha256: digest(bytes),
      size: bytes.byteLength,
      mediaType: "application/octet-stream",
      purpose: "build-artifact",
    };
    const transport = createTransport(async (url, init) => {
      const headers = new Headers(init?.headers);
      const path = new URL(url).pathname;
      if (path.endsWith("/execute")) {
        const envelope = JSON.parse(await requestText(init)) as {
          leaseId: string;
          request: SandboxTransportExecutionRequest;
        };
        return jsonResponse(headers, {
          operationId: envelope.request.operationId,
          requestDigest: envelope.request.requestDigest,
          executionId: "execution-sandbox-http-1",
          leaseId: envelope.leaseId,
          status: "exited",
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          truncated: false,
          artifacts: [artifact],
          usage: {
            wallClockMs: 10,
            peakMemoryBytes: 1024,
            cpuTimeMs: 2,
            outputBytes: 2,
          },
          startedAt: NOW,
          completedAt: NOW,
        });
      }
      assert.equal(path.endsWith("/download-artifact"), true);
      await requestBytes(init);
      return new Response(bytes, {
        status: 200,
        headers: {
          ...responseHeaders(headers, artifact.mediaType),
          "content-length": String(artifact.size),
          "x-harvy-content-sha256": artifact.sha256,
        },
      });
    });
    const request: SandboxTransportExecutionRequest = {
      version: 1,
      operationId: "sandbox-operation-http-1",
      requestDigest: "d".repeat(64),
      request: {
        argv: ["npm", "test"],
        cwd: ".",
        purpose: "test",
        timeoutMs: 30_000,
      },
    };
    const result = await transport.execute("sandbox-lease-http-1", request);
    assert.equal(result.operationId, request.operationId);
    assert.equal(result.requestDigest, request.requestDigest);
    assert.deepEqual(
      await consume(transport.downloadArtifact(result.leaseId, artifact)),
      bytes,
    );
  });

  it("menolak secret-like output dan remote yang tidak mengonsumsi snapshot", async () => {
    const request = allocation(Buffer.from("not-consumed", "utf8"));
    const early = createTransport(async (_url, init) =>
      jsonResponse(new Headers(init?.headers), lease(request))
    );
    await assert.rejects(
      early.allocate(request, chunks(Buffer.from("not-consumed", "utf8"))),
      /tidak mengonsumsi seluruh upload/iu,
    );

    const secretOutput = createTransport(async (_url, init) => {
      const headers = new Headers(init?.headers);
      const envelope = JSON.parse(await requestText(init)) as {
        leaseId: string;
        request: SandboxTransportExecutionRequest;
      };
      return jsonResponse(headers, {
        operationId: envelope.request.operationId,
        requestDigest: envelope.request.requestDigest,
        executionId: "execution-sandbox-http-2",
        leaseId: envelope.leaseId,
        status: "exited",
        exitCode: 0,
        signal: null,
        stdout: `output ${"npm_"}${"A".repeat(30)}`,
        stderr: "",
        truncated: false,
        artifacts: [],
        usage: { wallClockMs: 1, peakMemoryBytes: 1, cpuTimeMs: 1, outputBytes: 40 },
        startedAt: NOW,
        completedAt: NOW,
      });
    });
    await assert.rejects(
      secretOutput.execute("sandbox-lease-http-2", {
        version: 1,
        operationId: "sandbox-operation-http-2",
        requestDigest: "e".repeat(64),
        request: { argv: ["npm", "test"], cwd: ".", purpose: "test", timeoutMs: 30_000 },
      }),
      /credential\/path terlarang/iu,
    );
  });
});

class ProofProvider implements TrustDomainRequestProofProvider {
  readonly bindings: TrustDomainRequestBinding[] = [];
  async createProof(binding: TrustDomainRequestBinding): Promise<string> {
    this.bindings.push(structuredClone(binding));
    return "s".repeat(43);
  }
}

function createTransport(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  proofProvider: TrustDomainRequestProofProvider = new ProofProvider(),
): HttpSandboxTransport {
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => handler(String(input), init)) as typeof fetch;
  return new HttpSandboxTransport({
    origin: ORIGIN,
    proofProvider,
    allowInsecureLoopback: true,
    fetch: fetchFn,
    now: () => new Date(NOW),
  });
}

function allocation(bytes: Uint8Array): SandboxAllocationRequest {
  return {
    leaseId: "sandbox-lease-http-1",
    binding: {
      ownerWorkspaceKey: "workspace-sandbox-http",
      projectId: "project-sandbox-http",
      snapshotId: "1".repeat(64),
      workspaceRevision: 3,
      runId: "coding-run-sandbox-http",
    },
    network: "off",
    limits: { ...DEFAULT_SANDBOX_LIMITS },
    snapshot: {
      version: 1,
      snapshotId: "1".repeat(64),
      bundleSha256: digest(bytes),
      manifestSha256: "2".repeat(64),
      size: bytes.byteLength,
      fileCount: 1,
      mediaType: "application/vnd.harvy.snapshot-bundle.v1",
    },
  };
}

function lease(request: SandboxAllocationRequest): SandboxLease {
  return {
    leaseId: request.leaseId,
    binding: request.binding,
    attestation: {
      version: 1,
      runtime: "isolated-linux",
      unprivilegedUser: true,
      noHarvySecrets: true,
      noProviderSecrets: true,
      noGitHubSecrets: true,
      noHarvyDataMount: true,
      noHostRootMount: true,
      noDockerSocket: true,
      noPrivilegedDevices: true,
      capabilitiesDropped: true,
      syscallFilter: true,
      readOnlyRootFilesystem: true,
      disposable: true,
      network: "off",
      limits: request.limits,
    },
    createdAt: NOW,
    expiresAt: "2026-08-11T09:10:00.000Z",
  };
}

function jsonResponse(headers: Headers, result: unknown): Response {
  return new Response(JSON.stringify({ version: 1, result }), {
    status: 200,
    headers: responseHeaders(headers, "application/json"),
  });
}

function responseHeaders(headers: Headers, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "x-harvy-trust-protocol": PROTOCOL,
    "x-harvy-request-id": headers.get("x-harvy-request-id") ?? "missing",
  };
}

async function requestText(init?: RequestInit): Promise<string> {
  return Buffer.from(await requestBytes(init)).toString("utf8");
}

async function requestBytes(init?: RequestInit): Promise<Uint8Array> {
  const body = init?.body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const parts: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
    }
    return Buffer.concat(parts.map((part) => Buffer.from(part)));
  }
  throw new Error("Fixture body sandbox tidak dikenal.");
}

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  const middle = Math.ceil(bytes.byteLength / 2);
  yield bytes.subarray(0, middle);
  yield bytes.subarray(middle);
}

async function consume(input: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of input) parts.push(chunk);
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
