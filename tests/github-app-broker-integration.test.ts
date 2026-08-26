import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { scanProjectTree } from "../src/core/project-files.js";
import type { GitHubExactEffect } from "../src/domain/github.js";
import {
  createGitHubRepositoryBootstrapEffect,
  githubRepositoryBootstrapContent,
} from "../src/domain/github-bootstrap.js";
import {
  createLocalGitCommitRequest,
  LOCAL_GIT_EMPTY_TREE,
  LOCAL_GIT_UPLOAD_ROOT_COMMIT,
  type LocalGitBinding,
} from "../src/domain/local-git.js";
import { GitHubApiClient } from "../src/github-app/github-api-client.js";
import { GitHubAppBackend } from "../src/github-app/github-app-backend.js";
import { GitHubBrokerServiceHandler } from "../src/github-app/github-broker-service-handler.js";
import { LocalGitBackend } from "../src/local-git/local-git-backend.js";
import { createSandboxSnapshotSource } from "../src/sandbox/snapshot-bundle.js";
import {
  HmacTrustDomainRequestProofProvider,
} from "../src/transport/trust-domain-http.js";
import { TrustDomainHttpServer } from "../src/transport/trust-domain-http-server.js";
import { HttpGitHubBrokerTransport } from "../src/transport/http-github-broker-transport.js";

const NOW = new Date("2026-08-15T01:00:00.000Z");
const roots: string[] = [];
const servers: TrustDomainHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("credential-owning GitHub App Broker integration", () => {
  it("OAuth installation → exact branch → Git bundle push → draft PR memakai Git object nyata", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-github-app-broker-"));
    roots.push(root);
    const bundle = await localCommit(root);
    const github = new FakeGitHub(bundle.commit, bundle.treeHash);
    const api = new GitHubApiClient({
      apiOrigin: "http://127.0.0.1:49111",
      webOrigin: "http://127.0.0.1:49111",
      archiveOrigins: ["http://127.0.0.1:49111"],
      allowInsecureLoopback: true,
      fetchImplementation: github.fetch,
      retryCount: 0,
      maxJsonBytes: 32 * 1024 * 1024,
    });
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const backend = new GitHubAppBackend({
      dataRoot: join(root, "broker"),
      appId: "1234",
      appSlug: "harvy-test",
      clientId: "Iv1.harvy-test",
      clientSecret: "client-secret-test-only",
      privateKeyPem: Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" })),
      callbackUrl: "http://127.0.0.1:49112/v1/github-app/callback",
      stateSecret: randomBytes(32),
      api,
      gitCommand: "git",
      commandEnvironment: { PATH: process.env.PATH ?? "", HOME: root },
      now: () => new Date(NOW),
    });
    await backend.initialize();
    assert.equal((await backend.health()).available, true);

    const secret = randomBytes(32);
    const server = new TrustDomainHttpServer({
      protocol: "harvy-github-broker/1",
      host: "127.0.0.1",
      port: 0,
      identities: [{ keyId: "github-broker-test", secret }],
      handler: new GitHubBrokerServiceHandler(backend),
      maxContentBytes: 256 * 1024 * 1024,
      now: () => new Date(NOW),
    });
    servers.push(server);
    const address = await server.start();
    const transport = new HttpGitHubBrokerTransport({
      origin: address.origin,
      allowInsecureLoopback: true,
      proofProvider: new HmacTrustDomainRequestProofProvider("github-broker-test", secret),
      now: () => new Date(NOW),
    });

    const session = await transport.beginInstallation("workspace-1", "github-session-e2e-1");
    const state = new URL(session.authorizationUrl).searchParams.get("state");
    assert.ok(state);
    await backend.completeInstallationCallback({
      state,
      code: "oauth-code-once",
      installationId: "7",
      setupAction: "install",
    });
    const status = await transport.installationStatus("workspace-1", session.sessionId);
    assert.equal(status.status, "ready");
    assert.equal(status.installationId, "7");
    const repositories = await transport.listRepositories("workspace-1", "7", null);
    assert.equal(repositories.repositories[0]?.repositoryFullName, "student/project");
    const access = await transport.repositoryAccess("workspace-1", "7", "99", null);
    assert.equal(access.baseCommit, LOCAL_GIT_UPLOAD_ROOT_COMMIT);
    assert.equal(access.canPush, true);
    assert.equal(access.canCreatePullRequest, true);

    const archive = await transport.prepareRepositoryArchive(
      "workspace-1",
      "7",
      "99",
      LOCAL_GIT_UPLOAD_ROOT_COMMIT,
      "github-selection-e2e-1",
    );
    const archiveChunks: Buffer[] = [];
    for await (const chunk of transport.downloadRepositoryArchive(archive)) {
      archiveChunks.push(Buffer.from(chunk));
    }
    assert.deepEqual(Buffer.concat(archiveChunks), github.archive);

    const branch = exactEffect({
      capability: "github.branch.create",
      commit: bundle.commit,
      objectBundle: null,
    });
    const branchResult = await transport.createBranch(branch);
    assert.equal(branchResult.status, "committed");
    assert.equal(github.refs.get("harvy/fix-login"), LOCAL_GIT_UPLOAD_ROOT_COMMIT);

    const push = exactEffect({
      capability: "github.push_branch",
      commit: bundle.commit,
      objectBundle: bundle.objectBundle,
    });
    const pushResult = await transport.pushExactCommit(push, fileChunks(bundle.path));
    assert.equal(pushResult.status, "committed");
    assert.equal(github.refs.get("harvy/fix-login"), bundle.commit);
    assert.equal(github.createdCommit, bundle.commit);
    assert.equal(github.lastPatchForce, false);

    const pr = exactEffect({
      capability: "github.pr.create",
      commit: bundle.commit,
      objectBundle: null,
    });
    const prResult = await transport.createDraftPullRequest(pr);
    assert.equal(prResult.status, "committed");
    assert.equal(prResult.externalId, "501");
    assert.equal(github.pulls[0]?.draft, true);
    assert.match(github.pulls[0]?.body ?? "", /harvy-effect:[a-f0-9]{64}/u);

    // Permanent effect IDs reconcile without replaying mutation.
    const patchCount = github.patchCount;
    assert.equal((await transport.pushExactCommit(push, fileChunks(bundle.path))).status, "committed");
    assert.equal(github.patchCount, patchCount);
    assert.ok(github.tokenRequests.some((request) =>
      JSON.stringify(request.repository_ids) === "[99]" &&
      object(request.permissions).contents === "write"
    ));
    assert.equal(github.seenAuthorization.some((value) => value.includes("client-secret-test-only")), false);
  });

  it("menolak stale target tanpa ref mutation dan mem-fence not_committed", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-github-app-stale-"));
    roots.push(root);
    const bundle = await localCommit(root);
    const github = new FakeGitHub(bundle.commit, bundle.treeHash);
    const backend = await readyBackend(root, github);
    const branch = exactEffect({ capability: "github.branch.create", commit: bundle.commit, objectBundle: null });
    assert.equal((await backend.createBranch(branch)).status, "committed");
    github.refs.set("harvy/fix-login", "f".repeat(40));
    const push = exactEffect({
      capability: "github.push_branch",
      commit: bundle.commit,
      objectBundle: bundle.objectBundle,
    });
    const result = await backend.pushExactCommit(push, fileChunks(bundle.path));
    assert.equal(result.status, "not_committed");
    assert.equal(result.operationFenced, true);
    assert.equal(github.patchCount, 0);
  });

  it("menginisialisasi repository privat yang benar-benar kosong secara exact dan idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-github-app-empty-"));
    roots.push(root);
    const github = new FakeGitHub("a".repeat(40), "b".repeat(40), true);
    const backend = await readyBackend(root, github);
    const before = await backend.repositoryAccess("workspace-1", "7", "99", null);
    assert.equal(before.empty, true);
    assert.equal(before.baseCommit, null);
    assert.equal(github.bootstrapPutCount, 0);

    const effect = createGitHubRepositoryBootstrapEffect({
      attempt: 1,
      ownerWorkspaceKey: "workspace-1",
      installationConnectionId: "installation-connection-empty-1",
      selectionId: "github-selection-empty-1",
      installationId: "7",
      repositoryId: "99",
      repositoryFullName: "student/project",
      visibility: "private",
      defaultBranch: "main",
    });
    const first = await backend.bootstrapRepository(effect);
    assert.equal(first.status, "committed");
    assert.equal(first.operationFenced, true);
    assert.equal(first.externalId, "c".repeat(40));
    assert.equal(
      first.url,
      `https://github.com/student/project/commit/${"c".repeat(40)}`,
    );
    assert.equal(github.bootstrapPutCount, 1);
    assert.deepEqual(
      github.contents.get("README.md"),
      githubRepositoryBootstrapContent(effect),
    );

    const replay = await backend.bootstrapRepository(effect);
    assert.deepEqual(replay, first);
    assert.equal(github.bootstrapPutCount, 1);
    const after = await backend.repositoryAccess("workspace-1", "7", "99", null);
    assert.equal(after.empty, false);
    assert.equal(after.baseCommit, "c".repeat(40));
  });

  it("menolak stale base branch di credential broker sebelum branch/object/PR mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-github-app-stale-base-"));
    roots.push(root);
    const bundle = await localCommit(root);
    const github = new FakeGitHub(bundle.commit, bundle.treeHash);
    const backend = await readyBackend(root, github);
    github.refs.set("main", "e".repeat(40));
    const branch = exactEffect({
      capability: "github.branch.create",
      commit: bundle.commit,
      objectBundle: null,
    });
    const result = await backend.createBranch(branch);
    assert.equal(result.status, "not_committed");
    assert.equal(result.operationFenced, true);
    assert.equal(github.refs.has("harvy/fix-login"), false);
    assert.equal(github.createdCommit, null);
    assert.equal(github.patchCount, 0);
    github.refs.set("harvy/fix-login", LOCAL_GIT_UPLOAD_ROOT_COMMIT);
    const push = exactEffect({
      capability: "github.push_branch",
      commit: bundle.commit,
      objectBundle: bundle.objectBundle,
    });
    assert.equal((await backend.pushExactCommit(push, fileChunks(bundle.path))).status,
      "not_committed");
    assert.equal(github.createdCommit, null);
    assert.equal(github.patchCount, 0);
    github.refs.set("harvy/fix-login", bundle.commit);
    const pr = exactEffect({
      capability: "github.pr.create",
      commit: bundle.commit,
      objectBundle: null,
    });
    assert.equal((await backend.createDraftPullRequest(pr)).status, "not_committed");
    assert.equal(github.pulls.length, 0);
  });
});

async function readyBackend(root: string, github: FakeGitHub): Promise<GitHubAppBackend> {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const api = new GitHubApiClient({
    apiOrigin: "http://127.0.0.1:49111",
    webOrigin: "http://127.0.0.1:49111",
    archiveOrigins: ["http://127.0.0.1:49111"],
    allowInsecureLoopback: true,
    fetchImplementation: github.fetch,
    retryCount: 0,
    maxJsonBytes: 32 * 1024 * 1024,
  });
  const backend = new GitHubAppBackend({
    dataRoot: join(root, "broker"),
    appId: "1234",
    appSlug: "harvy-test",
    clientId: "Iv1.harvy-test",
    clientSecret: "client-secret-test-only",
    privateKeyPem: Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" })),
    callbackUrl: "http://127.0.0.1:49112/v1/github-app/callback",
    stateSecret: randomBytes(32),
    api,
    gitCommand: "git",
    commandEnvironment: { PATH: process.env.PATH ?? "", HOME: root },
    now: () => new Date(NOW),
  });
  await backend.initialize();
  const session = await backend.beginInstallation("workspace-1", "github-session-stale-1");
  await backend.completeInstallationCallback({
    state: new URL(session.authorizationUrl).searchParams.get("state")!,
    code: "oauth-code-once",
    installationId: "7",
    setupAction: "install",
  });
  return backend;
}

async function localCommit(root: string) {
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "app.js"), "export const answer = 41;\n", "utf8");
  const first = await snapshot(project);
  const local = new LocalGitBackend({
    dataRoot: join(root, "local-git"),
    gitCommand: "git",
    commandEnvironment: { PATH: process.env.PATH ?? "", HOME: root },
    serviceEnvironment: {},
    now: () => new Date(NOW),
  });
  await local.initialize();
  await local.prepare(binding(first.descriptor.snapshotId, 1), first.descriptor, first.open());
  await writeFile(join(project, "app.js"), "export const answer = 42;\n", "utf8");
  const second = await snapshot(project);
  const secondBinding = binding(second.descriptor.snapshotId, 2);
  const request = createLocalGitCommitRequest(secondBinding);
  const committed = await local.commit(request, second.descriptor, second.open());
  const artifact = await local.objectBundle(committed.objectBundle);
  return { ...committed, path: artifact.path };
}

async function snapshot(root: string) {
  const manifest = await scanProjectTree(root, { now: () => new Date(NOW) });
  return createSandboxSnapshotSource(root, manifest);
}

function binding(snapshotId: string, workspaceRevision: number): LocalGitBinding {
  return {
    projectId: "github-app-test-project",
    snapshotId,
    workspaceRevision,
    baseCommit: LOCAL_GIT_UPLOAD_ROOT_COMMIT,
    headCommit: LOCAL_GIT_UPLOAD_ROOT_COMMIT,
    branch: "harvy/fix-login",
  };
}

function exactEffect(input: {
  capability: GitHubExactEffect["capability"];
  commit: string;
  objectBundle: GitHubExactEffect["objectBundle"];
}): GitHubExactEffect {
  const push = input.capability === "github.push_branch" || input.capability === "github.workflow.write";
  const pr = input.capability === "github.pr.create";
  const semantic: Omit<GitHubExactEffect, "effectId"> = {
    attempt: 1,
    capability: input.capability,
    projectId: "github-app-test-project",
    runId: "coding-run-e2e-1",
    ownerWorkspaceKey: "workspace-1",
    installationConnectionId: "installation-connection-1",
    repositoryBindingId: "repository-binding-1",
    installationId: "7",
    repositoryId: "99",
    workspaceRevision: 3,
    instructionRevision: 0,
    branch: "harvy/fix-login",
    commit: input.commit,
    baseCommit: LOCAL_GIT_UPLOAD_ROOT_COMMIT,
    expectedTargetHead: input.capability === "github.branch.create"
      ? null
      : pr
        ? input.commit
        : LOCAL_GIT_UPLOAD_ROOT_COMMIT,
    baseBranch: "main",
    title: pr ? "Fix login expiry" : null,
    body: pr ? "Tests pass." : null,
    draft: pr ? true : null,
    objectBundle: push ? input.objectBundle : null,
  };
  return {
    effectId: `github-effect-${createHash("sha256")
      .update(canonicalJson(semantic), "utf8").digest("hex")}`,
    ...semantic,
  };
}

async function* fileChunks(path: string): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(path)) yield Buffer.from(chunk as Buffer);
}

class FakeGitHub {
  readonly refs = new Map<string, string>();
  readonly archive = Buffer.from("PK\u0003\u0004fake-github-archive", "binary");
  readonly tokenRequests: Array<Record<string, unknown>> = [];
  readonly seenAuthorization: string[] = [];
  readonly pulls: Array<{ id: number; body: string; draft: boolean }> = [];
  readonly blobs = new Map<string, Buffer>();
  readonly contents = new Map<string, Buffer>();
  createdCommit: string | null = null;
  lastPatchForce: boolean | null = null;
  patchCount = 0;
  bootstrapPutCount = 0;

  constructor(
    readonly expectedCommit: string,
    readonly expectedTree: string,
    empty = false,
  ) {
    if (!empty) this.refs.set("main", LOCAL_GIT_UPLOAD_ROOT_COMMIT);
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (authorization) this.seenAuthorization.push(authorization);
    if (url.pathname === "/login/oauth/access_token") {
      assert.equal(headers.has("authorization"), false);
      return response({ access_token: "ghu_user_test_token_123456789012345", token_type: "bearer" });
    }
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname === "/app" && method === "GET") {
      assert.match(authorization ?? "", /^Bearer eyJ[^.]+\.[^.]+\.[^.]+$/u);
      return response({ id: 1234, slug: "harvy-test" });
    }
    if (url.pathname === "/user/installations") {
      return response({ installations: [{ id: 7 }] });
    }
    if (url.pathname === "/app/installations/7" && method === "GET") {
      return response({
        id: 7,
        app_id: 1234,
        suspended_at: null,
        permissions: {
          metadata: "read",
          contents: "write",
          pull_requests: "write",
          workflows: "write",
        },
      });
    }
    if (url.pathname === "/app/installations/7/access_tokens" && method === "POST") {
      this.tokenRequests.push(body);
      return response({
        token: "ghs_installation_test_token_123456789",
        expires_at: "2026-08-15T02:00:00.000Z",
      }, 201);
    }
    if (url.pathname === "/installation/repositories") {
      return response({ repositories: [this.repository()] });
    }
    if (url.pathname === "/repositories/99") return response(this.repository());
    if (url.pathname.endsWith(`/zipball/${LOCAL_GIT_UPLOAD_ROOT_COMMIT}`)) {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:49111/archive.zip" },
      });
    }
    if (url.pathname === "/archive.zip") {
      return new Response(this.archive, {
        status: 200,
        headers: { "content-type": "application/zip", "content-length": String(this.archive.byteLength) },
      });
    }
    const refMatch = /^\/repos\/student\/project\/git\/ref\/heads\/(.+)$/u.exec(url.pathname);
    if (refMatch && method === "GET") {
      const branch = decodeURIComponent(refMatch[1]!);
      const sha = this.refs.get(branch);
      return sha ? response(ref(branch, sha)) : response({ message: "Not Found" }, 404);
    }
    if (
      url.pathname === "/repos/student/project/git/matching-refs/heads/" &&
      method === "GET"
    ) {
      return response([...this.refs.entries()].map(([branch, sha]) => ref(branch, sha)));
    }
    if (url.pathname === "/repos/student/project/contents/README.md" && method === "PUT") {
      assert.equal(body.message, "Initialize repository for Harvy");
      assert.equal(body.branch, "main");
      assert.equal(this.refs.size, 0);
      const bytes = Buffer.from(String(body.content), "base64");
      this.contents.set("README.md", bytes);
      this.bootstrapPutCount += 1;
      const commit = "c".repeat(40);
      this.refs.set("main", commit);
      return response({
        content: { path: "README.md", sha: gitObjectHash("blob", bytes) },
        commit: { sha: commit },
      }, 201);
    }
    if (url.pathname === "/repos/student/project/contents/README.md" && method === "GET") {
      const bytes = this.contents.get("README.md");
      const requested = url.searchParams.get("ref");
      if (!bytes || requested !== this.refs.get("main")) {
        return response({ message: "Not Found" }, 404);
      }
      return response({
        path: "README.md",
        sha: gitObjectHash("blob", bytes),
        encoding: "base64",
        content: bytes.toString("base64"),
      });
    }
    if (url.pathname === "/repos/student/project/git/refs" && method === "POST") {
      const branch = String(body.ref).slice("refs/heads/".length);
      assert.equal(body.sha, LOCAL_GIT_UPLOAD_ROOT_COMMIT);
      assert.equal(this.refs.has(branch), false);
      this.refs.set(branch, String(body.sha));
      return response(ref(branch, String(body.sha)), 201);
    }
    const patchRef = /^\/repos\/student\/project\/git\/refs\/heads\/(.+)$/u.exec(url.pathname);
    if (patchRef && method === "PATCH") {
      const branch = decodeURIComponent(patchRef[1]!);
      this.patchCount += 1;
      this.lastPatchForce = body.force as boolean;
      assert.equal(body.force, false);
      assert.equal(this.refs.get(branch), LOCAL_GIT_UPLOAD_ROOT_COMMIT);
      this.refs.set(branch, String(body.sha));
      return response(ref(branch, String(body.sha)));
    }
    if (url.pathname === "/repos/student/project/git/blobs" && method === "POST") {
      const bytes = Buffer.from(String(body.content), "base64");
      const sha = gitObjectHash("blob", bytes);
      this.blobs.set(sha, bytes);
      return response({ sha }, 201);
    }
    if (url.pathname === "/repos/student/project/git/trees" && method === "POST") {
      const entries = body.tree as Array<Record<string, unknown>>;
      const sha = treeHash(entries);
      assert.equal(sha, this.expectedTree);
      return response({ sha }, 201);
    }
    if (url.pathname === `/repos/student/project/git/commits/${LOCAL_GIT_UPLOAD_ROOT_COMMIT}`) {
      return response({ sha: LOCAL_GIT_UPLOAD_ROOT_COMMIT, tree: { sha: LOCAL_GIT_EMPTY_TREE } });
    }
    if (url.pathname === `/repos/student/project/git/trees/${LOCAL_GIT_EMPTY_TREE}`) {
      return response({ sha: LOCAL_GIT_EMPTY_TREE, truncated: false, tree: [] });
    }
    if (url.pathname === "/repos/student/project/git/commits" && method === "POST") {
      const sha = commitHash(body);
      assert.equal(sha, this.expectedCommit);
      this.createdCommit = sha;
      return response({ sha, tree: { sha: body.tree }, parents: [{ sha: LOCAL_GIT_UPLOAD_ROOT_COMMIT }] }, 201);
    }
    if (url.pathname === "/repos/student/project/pulls" && method === "GET") {
      return response(this.pulls.map((pull) => ({
        id: pull.id,
        body: pull.body,
        draft: pull.draft,
        html_url: `https://github.com/student/project/pull/${pull.id}`,
        head: { sha: this.expectedCommit },
        base: { ref: "main" },
      })));
    }
    if (url.pathname === "/repos/student/project/pulls" && method === "POST") {
      assert.equal(body.draft, true);
      const pull = { id: 501, body: String(body.body), draft: true };
      this.pulls.push(pull);
      return response({
        ...pull,
        html_url: "https://github.com/student/project/pull/501",
        head: { sha: this.expectedCommit },
        base: { ref: "main" },
      }, 201);
    }
    return response({ message: `Unhandled ${method} ${url.pathname}` }, 500);
  }) as typeof fetch;

  private repository(): Record<string, unknown> {
    return {
      id: 99,
      full_name: "student/project",
      visibility: "private",
      default_branch: "main",
      archived: false,
      disabled: false,
      permissions: { pull: true, push: true, admin: false },
    };
  }
}

function ref(branch: string, sha: string): Record<string, unknown> {
  return { ref: `refs/heads/${branch}`, object: { type: "commit", sha } };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function treeHash(entries: Array<Record<string, unknown>>): string {
  const chunks = [...entries]
    .sort((a, b) => Buffer.from(String(a.path)).compare(Buffer.from(String(b.path))))
    .map((entry) => Buffer.concat([
      Buffer.from(`${entry.mode} ${entry.path}\0`, "utf8"),
      Buffer.from(String(entry.sha), "hex"),
    ]));
  return gitObjectHash("tree", Buffer.concat(chunks));
}

function commitHash(value: Record<string, unknown>): string {
  const author = value.author as Record<string, unknown>;
  const committer = value.committer as Record<string, unknown>;
  const content = [
    `tree ${value.tree}`,
    `parent ${(value.parents as string[])[0]}`,
    identityLine("author", author),
    identityLine("committer", committer),
    "",
    String(value.message),
    "",
  ].join("\n");
  return gitObjectHash("commit", Buffer.from(content, "utf8"));
}

function identityLine(kind: string, value: Record<string, unknown>): string {
  const epoch = Math.floor(Date.parse(String(value.date)) / 1_000);
  return `${kind} ${value.name} <${value.email}> ${epoch} +0000`;
}

function gitObjectHash(type: string, bytes: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`${type} ${bytes.byteLength}\0`, "ascii"))
    .update(bytes)
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
