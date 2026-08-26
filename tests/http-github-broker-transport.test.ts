import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type {
  GitHubBrokerTransportResult,
  GitHubExactEffect,
} from "../src/domain/github.js";
import { createGitHubRepositoryBootstrapEffect } from
  "../src/domain/github-bootstrap.js";
import { HttpGitHubBrokerTransport } from "../src/transport/http-github-broker-transport.js";
import type {
  TrustDomainRequestBinding,
  TrustDomainRequestProofProvider,
} from "../src/transport/trust-domain-http.js";

const ORIGIN = "http://127.0.0.1:41875";
const PROTOCOL = "harvy-github-broker/1";
const NOW = "2026-08-11T10:00:00.000Z";

describe("HTTP GitHub Broker trust-domain transport", () => {
  it("mengikat health/access ke service proof tanpa membawa credential GitHub", async () => {
    const proof = new ProofProvider();
    let headers = new Headers();
    const transport = createTransport(async (url, init) => {
      headers = new Headers(init?.headers);
      const path = new URL(url).pathname;
      await requestBytes(init);
      if (path.endsWith("/health")) {
        return jsonResponse(headers, {
          available: true,
          protocol: PROTOCOL,
          checkedAt: NOW,
          reason: null,
        });
      }
      return jsonResponse(headers, {
        ownerWorkspaceKey: "workspace-http-github",
        installationId: "installation-http-1",
        repositoryId: "repository-http-1",
        repositoryFullName: "student/project",
        visibility: "private",
        defaultBranch: "main",
        baseCommit: "a".repeat(40),
        empty: false,
        targetBranch: "harvy/project",
        targetBranchHead: null,
        canRead: true,
        canPush: true,
        canWriteWorkflows: false,
        canCreatePullRequest: true,
      });
    }, proof);
    assert.equal((await transport.health()).available, true);
    const access = await transport.repositoryAccess(
      "workspace-http-github",
      "installation-http-1",
      "repository-http-1",
      "harvy/project",
    );
    assert.equal(access.canPush, true);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.get("x-harvy-request-proof"), "g".repeat(43));
    assert.equal(proof.bindings.at(-1)?.audience, ORIGIN);
    assert.equal(JSON.stringify(proof.bindings).includes("installation-token"), false);
  });

  it("membawa lifecycle installation, repo selection, dan archive exact tanpa callback credential", async () => {
    const archive = Buffer.from("PK\u0003\u0004github-archive-fixture", "binary");
    const archiveSha256 = digest(archive);
    const sessionId = "github-install-session-http-1";
    const paths: string[] = [];
    const statusRequestIds: string[] = [];
    let archivePrepareRequestId = "";
    const transport = createTransport(async (url, init) => {
      const headers = new Headers(init?.headers);
      const path = new URL(url).pathname;
      paths.push(path);
      await requestBytes(init);
      if (path.endsWith("/installations/begin")) {
        return jsonResponse(headers, {
          sessionId,
          ownerWorkspaceKey: "workspace-http-github",
          status: "pending",
          authorizationUrl: "https://github.com/apps/harvy-test/installations/new?state=opaque-state",
          createdAt: NOW,
          expiresAt: "2026-08-11T10:20:00.000Z",
        });
      }
      if (path.endsWith("/installations/status")) {
        statusRequestIds.push(headers.get("x-harvy-request-id") ?? "missing");
        return jsonResponse(headers, {
          sessionId,
          ownerWorkspaceKey: "workspace-http-github",
          status: "ready",
          installationId: "installation-http-1",
          completedAt: NOW,
          expiresAt: "2026-08-11T10:20:00.000Z",
        });
      }
      if (path.endsWith("/installations/repositories")) {
        return jsonResponse(headers, {
          ownerWorkspaceKey: "workspace-http-github",
          installationId: "installation-http-1",
          repositories: [{
            installationId: "installation-http-1",
            repositoryId: "repository-http-1",
            repositoryFullName: "student/project",
            visibility: "private",
            defaultBranch: "main",
          }],
          nextCursor: null,
        });
      }
      const reference = {
        version: 1,
        operationId: "github-selection-http-1",
        archiveId: "github-archive-http-1",
        ownerWorkspaceKey: "workspace-http-github",
        installationId: "installation-http-1",
        repositoryId: "repository-http-1",
        repositoryFullName: "student/project",
        defaultBranch: "main",
        commit: "a".repeat(40),
        mediaType: "application/zip",
        sha256: archiveSha256,
        size: archive.byteLength,
        createdAt: NOW,
        expiresAt: "2026-08-11T10:10:00.000Z",
      } as const;
      if (path.endsWith("/repository-archive/prepare")) {
        archivePrepareRequestId = headers.get("x-harvy-request-id") ?? "missing";
        return jsonResponse(headers, reference);
      }
      return new Response(archive, {
        status: 200,
        headers: {
          "content-type": reference.mediaType,
          "content-length": String(reference.size),
          "x-harvy-content-sha256": reference.sha256,
          "x-harvy-trust-protocol": PROTOCOL,
          "x-harvy-request-id": headers.get("x-harvy-request-id") ?? "missing",
        },
      });
    });
    const session = await transport.beginInstallation(
      "workspace-http-github",
      sessionId,
    );
    assert.equal(session.status, "pending");
    const status = await transport.installationStatus(
      "workspace-http-github",
      sessionId,
    );
    await transport.installationStatus("workspace-http-github", sessionId);
    assert.equal(new Set(statusRequestIds).size, 2);
    assert.equal(status.installationId, "installation-http-1");
    const page = await transport.listRepositories(
      "workspace-http-github",
      status.installationId!,
      null,
    );
    assert.equal(page.repositories[0]?.repositoryFullName, "student/project");
    const reference = await transport.prepareRepositoryArchive(
      "workspace-http-github",
      status.installationId!,
      "repository-http-1",
      "a".repeat(40),
      "github-selection-http-1",
    );
    const downloaded: Buffer[] = [];
    assert.equal(archivePrepareRequestId, "github-selection-http-1");
    for await (const chunk of transport.downloadRepositoryArchive(reference)) {
      downloaded.push(Buffer.from(chunk));
    }
    assert.deepEqual(Buffer.concat(downloaded), archive);
    assert.deepEqual(paths, [
      "/v1/github-broker/installations/begin",
      "/v1/github-broker/installations/status",
      "/v1/github-broker/installations/status",
      "/v1/github-broker/installations/repositories",
      "/v1/github-broker/repository-archive/prepare",
      "/v1/github-broker/repository-archive/download",
    ]);
  });

  it("menolak installation URL dan archive descriptor yang keluar dari contract", async () => {
    const invalidUrl = createTransport(async (_url, init) => {
      const headers = new Headers(init?.headers);
      await requestBytes(init);
      return jsonResponse(headers, {
        sessionId: "github-install-session-http-bad",
        ownerWorkspaceKey: "workspace-http-github",
        status: "pending",
        authorizationUrl: "https://evil.invalid/apps/harvy/installations/new?state=stolen",
        createdAt: NOW,
        expiresAt: "2026-08-11T10:20:00.000Z",
      });
    });
    await assert.rejects(
      invalidUrl.beginInstallation(
        "workspace-http-github",
        "github-install-session-http-bad",
      ),
      /URL GitHub installation tidak sah/iu,
    );

    const foreignArchive = createTransport(async (_url, init) => {
      const headers = new Headers(init?.headers);
      await requestBytes(init);
      return jsonResponse(headers, {
        version: 1,
        operationId: "github-selection-http-bad",
        archiveId: "github-archive-http-bad",
        ownerWorkspaceKey: "workspace-other",
        installationId: "installation-http-1",
        repositoryId: "repository-http-1",
        repositoryFullName: "student/project",
        defaultBranch: "main",
        commit: "a".repeat(40),
        mediaType: "application/zip",
        sha256: "f".repeat(64),
        size: 1,
        createdAt: NOW,
        expiresAt: "2026-08-11T10:10:00.000Z",
      });
    });
    await assert.rejects(
      foreignArchive.prepareRepositoryArchive(
        "workspace-http-github",
        "installation-http-1",
        "repository-http-1",
        "a".repeat(40),
        "github-selection-http-bad",
      ),
      /Binding archive repository GitHub tidak cocok/iu,
    );
  });

  it("mengalirkan exact object bundle dan memisahkan endpoint capability", async () => {
    const bundleBytes = Buffer.from("git-bundle-http-broker", "utf8");
    const push = effect("github.push_branch", bundleBytes);
    let uploaded = Buffer.alloc(0);
    let uploadEnvelope = "";
    const paths: string[] = [];
    const transport = createTransport(async (url, init) => {
      const headers = new Headers(init?.headers);
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/push-exact-commit")) {
        uploaded = Buffer.from(await requestBytes(init));
        uploadEnvelope = Buffer.from(
          headers.get("x-harvy-envelope") ?? "",
          "base64url",
        ).toString("utf8");
      } else {
        await requestBytes(init);
      }
      if (path.endsWith("/bootstrap-repository")) {
        return jsonResponse(headers, {
          effectId: bootstrap.effectId,
          status: "committed",
          operationFenced: true,
          externalId: "c".repeat(40),
          url: `https://github.com/student/project/commit/${"c".repeat(40)}`,
          completedAt: NOW,
        });
      }
      return jsonResponse(headers, committed(push.effectId));
    });
    const result = await transport.pushExactCommit(push, chunks(bundleBytes));
    assert.equal(result.status, "committed");
    assert.deepEqual(uploaded, bundleBytes);
    assert.doesNotMatch(uploadEnvelope, /credential|privateKey|internalPath|TOKEN_SENTINEL/u);

    const branch = effect("github.branch.create");
    await transport.createBranch(branch);
    const bootstrap = createGitHubRepositoryBootstrapEffect({
      attempt: 1,
      ownerWorkspaceKey: "workspace-http-github",
      installationConnectionId: "installation-connection-http-1",
      selectionId: "github-selection-http-empty-1",
      installationId: "7",
      repositoryId: "99",
      repositoryFullName: "student/project",
      visibility: "private",
      defaultBranch: "main",
    });
    const bootstrapResult = await transport.bootstrapRepository(bootstrap);
    assert.equal(bootstrapResult.externalId, "c".repeat(40));
    const pr = effect("github.pr.create");
    await transport.createDraftPullRequest(pr);
    assert.deepEqual(paths, [
      "/v1/github-broker/push-exact-commit",
      "/v1/github-broker/create-branch",
      "/v1/github-broker/bootstrap-repository",
      "/v1/github-broker/create-draft-pr",
    ]);
    await assert.rejects(
      transport.createBranch(push),
      /capability exact effect tidak cocok/iu,
    );
  });

  it("menolak ACK credential-like dan remote yang tidak mengonsumsi bundle", async () => {
    const bytes = Buffer.from("bundle-not-consumed", "utf8");
    const push = effect("github.push_branch", bytes);
    const early = createTransport(async (_url, init) =>
      jsonResponse(new Headers(init?.headers), committed(push.effectId))
    );
    await assert.rejects(
      early.pushExactCommit(push, chunks(bytes)),
      /tidak mengonsumsi seluruh upload/iu,
    );

    const credentialAck = createTransport(async (_url, init) => {
      const headers = new Headers(init?.headers);
      await requestBytes(init);
      return jsonResponse(headers, {
        ...committed("github-effect-http-branch"),
        url: `https://example.invalid/pr?${"token"}=${"A".repeat(30)}`,
      });
    });
    await assert.rejects(
      credentialAck.createBranch(effect("github.branch.create")),
      /credential\/path terlarang/iu,
    );
  });
});

class ProofProvider implements TrustDomainRequestProofProvider {
  readonly bindings: TrustDomainRequestBinding[] = [];
  async createProof(binding: TrustDomainRequestBinding): Promise<string> {
    this.bindings.push(structuredClone(binding));
    return "g".repeat(43);
  }
}

function createTransport(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  proofProvider: TrustDomainRequestProofProvider = new ProofProvider(),
): HttpGitHubBrokerTransport {
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => handler(String(input), init)) as typeof fetch;
  return new HttpGitHubBrokerTransport({
    origin: ORIGIN,
    proofProvider,
    allowInsecureLoopback: true,
    fetch: fetchFn,
    now: () => new Date(NOW),
  });
}

function effect(
  capability: GitHubExactEffect["capability"],
  bundleBytes?: Uint8Array,
): GitHubExactEffect {
  const push = capability === "github.push_branch" || capability === "github.workflow.write";
  const pr = capability === "github.pr.create";
  const effectId = capability === "github.branch.create"
    ? "github-effect-http-branch"
    : capability === "github.pr.create"
      ? "github-effect-http-pr"
      : "github-effect-http-push";
  const sha = bundleBytes ? digest(bundleBytes) : "f".repeat(64);
  return {
    effectId,
    attempt: 1,
    capability,
    projectId: "project-http-github",
    runId: "coding-run-http-github",
    ownerWorkspaceKey: "workspace-http-github",
    installationConnectionId: "installation-connection-http-1",
    repositoryBindingId: "repository-binding-http-1",
    installationId: "installation-http-1",
    repositoryId: "repository-http-1",
    workspaceRevision: 4,
    instructionRevision: 0,
    branch: "harvy/project",
    commit: "b".repeat(40),
    baseCommit: "a".repeat(40),
    expectedTargetHead: capability === "github.branch.create"
      ? null
      : capability === "github.pr.create"
        ? "b".repeat(40)
        : "a".repeat(40),
    baseBranch: "main",
    title: pr ? "Harvy coding update" : null,
    body: pr ? "Validated change" : null,
    draft: pr ? true : null,
    objectBundle: push
      ? {
          version: 1,
          artifactId: `git-bundle-${sha}`,
          sha256: sha,
          size: bundleBytes?.byteLength ?? 1,
          mediaType: "application/vnd.git.bundle",
          commit: "b".repeat(40),
          parentCommit: "a".repeat(40),
          treeHash: "c".repeat(40),
        }
      : null,
  };
}

function committed(effectId: string): GitHubBrokerTransportResult {
  return {
    effectId,
    status: "committed",
    operationFenced: true,
    externalId: "external-http-1",
    url: "https://example.invalid/pull/1",
    completedAt: NOW,
  };
}

function jsonResponse(headers: Headers, result: unknown): Response {
  return new Response(JSON.stringify({ version: 1, result }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-harvy-trust-protocol": PROTOCOL,
      "x-harvy-request-id": headers.get("x-harvy-request-id") ?? "missing",
    },
  });
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
  throw new Error("Fixture body GitHub Broker tidak dikenal.");
}

async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  const middle = Math.ceil(bytes.byteLength / 2);
  yield bytes.subarray(0, middle);
  yield bytes.subarray(middle);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
