import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  createLocalGitCommitRequest,
  type LocalGitBinding,
  type LocalGitCommitResult,
} from "../src/domain/local-git.js";
import type { ProjectSnapshotBundleDescriptor } from "../src/domain/project-transfer.js";
import { HttpLocalGitTransport } from "../src/transport/http-local-git-transport.js";
import type {
  TrustDomainRequestBinding,
  TrustDomainRequestProofProvider,
} from "../src/transport/trust-domain-http.js";
import { HmacTrustDomainRequestProofProvider } from "../src/transport/trust-domain-http.js";

const ORIGIN = "http://127.0.0.1:41873";
const PROTOCOL = "harvy-local-git/1";
const AT = "2026-08-11T08:00:00.000Z";

describe("HTTP local git trust-domain transport", () => {
  it("memvalidasi origin dan mengikat proof ke audience, media, ukuran, serta request", async () => {
    const proof = new RecordingProofProvider();
    assert.throws(
      () => new HttpLocalGitTransport({ origin: "http://example.com", proofProvider: proof }),
      /origin https/iu,
    );
    assert.throws(
      () => new HttpLocalGitTransport({
        origin: `${ORIGIN}/path?token=forbidden`,
        proofProvider: proof,
        allowInsecureLoopback: true,
      }),
      /origin https/iu,
    );

    let observedHeaders = new Headers();
    const transport = transportWith(async (url, init) => {
      observedHeaders = new Headers(init?.headers);
      if (new URL(url).pathname.endsWith("/health")) {
        await requestText(init);
        return jsonResponse(observedHeaders, {
          available: true,
          protocol: PROTOCOL,
          checkedAt: AT,
          reason: null,
        });
      }
      const envelope = JSON.parse(await requestText(init)) as { binding: LocalGitBinding };
      return jsonResponse(observedHeaders, {
        binding: envelope.binding,
        changedPaths: [],
        clean: true,
      });
    }, proof);
    assert.equal((await transport.health()).available, true);
    const result = await transport.status(binding());
    assert.equal(result.clean, true);
    assert.equal(observedHeaders.has("authorization"), false);
    assert.equal(observedHeaders.get("x-harvy-request-proof"), "p".repeat(43));
    assert.equal(proof.bindings.length, 2);
    assert.equal(proof.bindings[1]?.audience, ORIGIN);
    assert.equal(proof.bindings[1]?.contentMediaType, "application/json");
    assert.ok((proof.bindings[1]?.contentSize ?? 0) > 0);
    assert.equal(proof.bindings[1]?.contentSha256, null);

    const hmac = new HmacTrustDomainRequestProofProvider(
      "local-git-service",
      Buffer.alloc(32, 7),
    );
    const signed = proof.bindings[1]!;
    const firstProof = await hmac.createProof(signed);
    const secondProof = await hmac.createProof({
      ...signed,
      requestId: `${signed.requestId}-retry`,
    });
    assert.notEqual(firstProof, secondProof);
    assert.equal(JSON.stringify(hmac), "{}");
  });

  it("menolak schema asing, credential-like log, dan response JSON tak terbatas", async () => {
    let mode: "extra" | "secret" | "oversize" = "extra";
    const transport = transportWith(async (_url, init) => {
      const headers = new Headers(init?.headers);
      const envelope = JSON.parse(await requestText(init)) as {
        binding: LocalGitBinding;
        limit?: number;
      };
      if (mode === "oversize") {
        return new Response("x".repeat(300_000), {
          status: 200,
          headers: responseHeaders(headers, "application/json"),
        });
      }
      if (mode === "secret") {
        return jsonResponse(headers, {
          binding: envelope.binding,
          entries: [{
            commit: "b".repeat(40),
            parentCommit: "a".repeat(40),
            subject: `release ${"xoxb-"}${"A".repeat(30)}`,
            authoredAt: AT,
            authorName: "Harvy Bot",
            authorEmail: "bot@harvy.local",
          }],
        });
      }
      return jsonResponse(headers, {
        binding: envelope.binding,
        changedPaths: [],
        clean: true,
        credential: "must-not-pass",
      });
    });

    await assert.rejects(transport.status(binding()), /field asing/iu);
    mode = "secret";
    await assert.rejects(transport.log(binding(), 10), /subject log local git tidak sah/iu);
    mode = "oversize";
    await assert.rejects(transport.status(binding()), /melampaui batas/iu);
  });

  it("mengalirkan snapshot dan object bundle content-addressed tanpa host path", async () => {
    const snapshotBytes = Buffer.from("snapshot-wire-bytes", "utf8");
    const objectBytes = Buffer.from("git-object-bundle", "utf8");
    const request = createLocalGitCommitRequest(binding());
    const objectSha = digest(objectBytes);
    const receipt: LocalGitCommitResult = {
      operationId: request.operationId,
      projectId: request.binding.projectId,
      snapshotId: request.binding.snapshotId,
      sourceWorkspaceRevision: request.binding.workspaceRevision,
      branch: request.targetBranch,
      parentCommit: request.binding.headCommit,
      commit: "b".repeat(40),
      treeHash: "c".repeat(40),
      objectBundle: {
        version: 1,
        artifactId: `git-bundle-${objectSha}`,
        sha256: objectSha,
        size: objectBytes.byteLength,
        mediaType: "application/vnd.git.bundle",
        commit: "b".repeat(40),
        parentCommit: request.binding.headCommit,
        treeHash: "c".repeat(40),
      },
      authorName: "Harvy Bot",
      authorEmail: "bot@harvy.local",
      committedAt: AT,
    };
    let uploaded = Buffer.alloc(0);
    let uploadedEnvelope = "";
    const transport = transportWith(async (url, init) => {
      const headers = new Headers(init?.headers);
      if (new URL(url).pathname.endsWith("/commit")) {
        uploaded = Buffer.from(await requestBytes(init));
        uploadedEnvelope = Buffer.from(
          headers.get("x-harvy-envelope") ?? "",
          "base64url",
        ).toString("utf8");
        return jsonResponse(headers, receipt);
      }
      assert.equal(new URL(url).pathname.endsWith("/object-bundle"), true);
      await requestBytes(init);
      return new Response(objectBytes, {
        status: 200,
        headers: {
          ...responseHeaders(headers, "application/vnd.git.bundle"),
          "content-length": String(objectBytes.byteLength),
          "x-harvy-content-sha256": objectSha,
        },
      });
    });
    const descriptor = snapshotDescriptor(request.binding.snapshotId, snapshotBytes);
    const committed = await transport.commit(
      request,
      descriptor,
      chunks(snapshotBytes),
    );
    assert.deepEqual(uploaded, snapshotBytes);
    assert.equal(digest(uploaded), descriptor.bundleSha256);
    assert.doesNotMatch(uploadedEnvelope, /internalPath|C:\\|TOKEN_SENTINEL/u);
    assert.deepEqual(committed, receipt);

    const downloaded = await consume(transport.openObjectBundle(receipt.objectBundle));
    assert.deepEqual(downloaded, objectBytes);
  });

  it("menolak remote yang menjawab sebelum upload habis atau mengubah download", async () => {
    const snapshotBytes = Buffer.from("snapshot-not-consumed", "utf8");
    const request = createLocalGitCommitRequest(binding());
    const descriptor = snapshotDescriptor(request.binding.snapshotId, snapshotBytes);
    const early = transportWith(async (_url, init) =>
      jsonResponse(new Headers(init?.headers), { ignored: true })
    );
    await assert.rejects(
      early.commit(request, descriptor, chunks(snapshotBytes)),
      /tidak mengonsumsi seluruh upload/iu,
    );

    const expected = Buffer.from("expected-bundle", "utf8");
    const expectedSha = digest(expected);
    const reference = {
      version: 1 as const,
      artifactId: `git-bundle-${expectedSha}`,
      sha256: expectedSha,
      size: expected.byteLength,
      mediaType: "application/vnd.git.bundle" as const,
      commit: "b".repeat(40),
      parentCommit: "a".repeat(40),
      treeHash: "c".repeat(40),
    };
    const corrupt = Buffer.from("corrupted-data", "utf8");
    const transport = transportWith(async (_url, init) => {
      const headers = new Headers(init?.headers);
      await requestBytes(init);
      return new Response(corrupt, {
        status: 200,
        headers: {
          ...responseHeaders(headers, "application/vnd.git.bundle"),
          "content-length": String(reference.size),
          "x-harvy-content-sha256": reference.sha256,
        },
      });
    });
    await assert.rejects(
      consume(transport.openObjectBundle(reference)),
      /byte download|melampaui descriptor/iu,
    );
  });
});

class RecordingProofProvider implements TrustDomainRequestProofProvider {
  readonly bindings: TrustDomainRequestBinding[] = [];

  async createProof(binding: TrustDomainRequestBinding): Promise<string> {
    this.bindings.push(structuredClone(binding));
    return "p".repeat(43);
  }
}

function transportWith(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  proofProvider: TrustDomainRequestProofProvider = new RecordingProofProvider(),
): HttpLocalGitTransport {
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => handler(String(input), init)) as typeof fetch;
  return new HttpLocalGitTransport({
    origin: ORIGIN,
    proofProvider,
    allowInsecureLoopback: true,
    fetch: fetchFn,
    now: () => new Date(AT),
  });
}

function jsonResponse(requestHeaders: Headers, result: unknown): Response {
  return new Response(JSON.stringify({ version: 1, result }), {
    status: 200,
    headers: responseHeaders(requestHeaders, "application/json"),
  });
}

function responseHeaders(requestHeaders: Headers, contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "x-harvy-trust-protocol": PROTOCOL,
    "x-harvy-request-id": requestHeaders.get("x-harvy-request-id") ?? "missing",
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
  throw new Error("Fixture request body tidak dikenal.");
}

function binding(): LocalGitBinding {
  return {
    projectId: "project-http-local-git",
    snapshotId: "1".repeat(64),
    workspaceRevision: 3,
    baseCommit: "a".repeat(40),
    headCommit: "a".repeat(40),
    branch: "main",
  };
}

function snapshotDescriptor(
  snapshotId: string,
  bytes: Uint8Array,
): ProjectSnapshotBundleDescriptor {
  return {
    version: 1,
    snapshotId,
    bundleSha256: digest(bytes),
    manifestSha256: "2".repeat(64),
    size: bytes.byteLength,
    fileCount: 1,
    mediaType: "application/vnd.harvy.snapshot-bundle.v1",
  };
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
