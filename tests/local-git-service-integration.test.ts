import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import {
  createLocalGitCommitRequest,
  LOCAL_GIT_UPLOAD_ROOT_COMMIT,
  type LocalGitBinding,
} from "../src/domain/local-git.js";
import type { GitHubExactEffect } from "../src/domain/github.js";
import { GitObjectBundleReader } from "../src/github-app/git-object-bundle.js";
import { scanProjectTree } from "../src/core/project-files.js";
import { LocalGitBackend } from "../src/local-git/local-git-backend.js";
import { LocalGitServiceHandler } from "../src/local-git/local-git-service-handler.js";
import { createSandboxSnapshotSource } from "../src/sandbox/snapshot-bundle.js";
import { HmacTrustDomainRequestProofProvider } from "../src/transport/trust-domain-http.js";
import { TrustDomainHttpServer } from "../src/transport/trust-domain-http-server.js";
import { HttpLocalGitTransport } from "../src/transport/http-local-git-transport.js";

const roots: string[] = [];
const servers: TrustDomainHttpServer[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local-git service integration", () => {
  it("prepare → status/diff → exact commit → object bundle → reconcile memakai Git nyata", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-local-git-live-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "app.js"), "export const answer = 41;\n", "utf8");
    const first = await snapshot(projectRoot);
    const backend = new LocalGitBackend({
      dataRoot: join(root, "service"),
      gitCommand: "git",
      commandEnvironment: {
        PATH: process.env.PATH ?? "",
        HOME: root,
      },
      serviceEnvironment: {},
      now: () => new Date("2026-08-15T01:02:03.000Z"),
    });
    await backend.initialize();
    assert.equal((await backend.health()).available, true);
    const secret = randomBytes(32);
    const server = new TrustDomainHttpServer({
      protocol: "harvy-local-git/1",
      host: "127.0.0.1",
      port: 0,
      identities: [{ keyId: "local-git-test", secret }],
      handler: new LocalGitServiceHandler(backend),
    });
    servers.push(server);
    const address = await server.start();
    const transport = new HttpLocalGitTransport({
      origin: address.origin,
      allowInsecureLoopback: true,
      proofProvider: new HmacTrustDomainRequestProofProvider("local-git-test", secret),
    });
    const firstBinding = binding(first.descriptor.snapshotId, 1);
    assert.deepEqual(
      await transport.prepare(firstBinding, first.descriptor, first.open()),
      { binding: firstBinding },
    );
    assert.deepEqual(await transport.status(firstBinding), {
      binding: firstBinding,
      changedPaths: [],
      clean: true,
    });

    await writeFile(join(projectRoot, "app.js"), "export const answer = 42;\n", "utf8");
    await writeFile(join(projectRoot, "test.js"), "if (42 !== 42) process.exit(1);\n", "utf8");
    const second = await snapshot(projectRoot);
    const secondBinding = binding(second.descriptor.snapshotId, 2);
    await transport.prepare(secondBinding, second.descriptor, second.open());
    const status = await transport.status(secondBinding);
    assert.equal(status.clean, false);
    assert.deepEqual(status.changedPaths, ["app.js", "test.js"]);
    const diff = await transport.diff(secondBinding);
    assert.match(diff.textArtifactId, /^local-git-diff-[a-f0-9]{64}$/u);

    const request = createLocalGitCommitRequest(secondBinding);
    assert.deepEqual(await transport.reconcileCommit(request), {
      operationId: request.operationId,
      status: "not_committed",
      operationFenced: true,
    });
    const committed = await transport.commit(
      request,
      second.descriptor,
      second.open(),
    );
    assert.equal(committed.parentCommit, LOCAL_GIT_UPLOAD_ROOT_COMMIT);
    assert.notEqual(committed.commit, committed.parentCommit);
    assert.equal(committed.objectBundle.commit, committed.commit);
    const bundle = Buffer.concat(await collect(
      transport.openObjectBundle(committed.objectBundle),
    ));
    assert.equal(bundle.byteLength, committed.objectBundle.size);
    assert.equal(createHash("sha256").update(bundle).digest("hex"),
      committed.objectBundle.sha256);
    assert.match(bundle.subarray(0, 64).toString("ascii"), /^# v2 git bundle\n/u);

    const reconciled = await transport.reconcileCommit(request);
    assert.equal(reconciled.status, "committed");
    assert.deepEqual((await transport.log(secondBinding, 20)).entries.map((entry) => entry.commit),
      [committed.commit]);
  });

  it("membuat bundle parsial exact ketika parent commit hanya ada di remote GitHub", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-local-git-remote-parent-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "app.js"), "export const answer = 41;\n", "utf8");
    const first = await snapshot(projectRoot);
    const remoteBase = "a".repeat(40);
    const backend = new LocalGitBackend({
      dataRoot: join(root, "service"),
      gitCommand: "git",
      commandEnvironment: { PATH: process.env.PATH ?? "", HOME: root },
      serviceEnvironment: {},
      now: () => new Date("2026-08-15T01:02:03.000Z"),
    });
    await backend.initialize();
    const firstBinding = binding(first.descriptor.snapshotId, 1, remoteBase);
    await backend.prepare(firstBinding, first.descriptor, first.open());

    await writeFile(join(projectRoot, "app.js"), "export const answer = 42;\n", "utf8");
    const second = await snapshot(projectRoot);
    const secondBinding = binding(second.descriptor.snapshotId, 2, remoteBase);
    const request = createLocalGitCommitRequest(secondBinding);
    const committed = await backend.commit(request, second.descriptor, second.open());
    assert.equal(committed.parentCommit, remoteBase);
    const artifact = await backend.objectBundle(committed.objectBundle);

    const effect: GitHubExactEffect = {
      effectId: `github-effect-${"b".repeat(64)}`,
      attempt: 1,
      capability: "github.push_branch",
      projectId: secondBinding.projectId,
      runId: "coding-run-remote-parent",
      ownerWorkspaceKey: "workspace-remote-parent",
      installationConnectionId: "installation-connection-remote-parent",
      repositoryBindingId: "repository-binding-remote-parent",
      installationId: "7",
      repositoryId: "99",
      workspaceRevision: secondBinding.workspaceRevision,
      instructionRevision: 0,
      branch: secondBinding.branch,
      commit: committed.commit,
      baseCommit: remoteBase,
      expectedTargetHead: remoteBase,
      baseBranch: "main",
      title: null,
      body: null,
      draft: null,
      objectBundle: committed.objectBundle,
    };
    const reader = new GitObjectBundleReader({
      temporaryRoot: root,
      gitCommand: "git",
      commandEnvironment: { PATH: process.env.PATH ?? "", HOME: root },
    });
    await reader.initialize();
    const parsed = await reader.read(effect, committed.objectBundle, artifact.path);
    assert.equal(parsed.commit, committed.commit);
    assert.equal(parsed.parent, remoteBase);
    assert.equal(parsed.tree, committed.treeHash);
    assert.deepEqual(parsed.blobs.map((blob) => [blob.path, blob.bytes.toString("utf8")]), [
      ["app.js", "export const answer = 42;\n"],
    ]);
  });

  it("menolak ref branch yang berubah tanpa menimpa history lokal", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-local-git-ref-cas-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const serviceRoot = join(root, "service");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "app.js"), "export const answer = 1;\n", "utf8");
    const first = await snapshot(projectRoot);
    const backend = new LocalGitBackend({
      dataRoot: serviceRoot,
      gitCommand: "git",
      commandEnvironment: { PATH: process.env.PATH ?? "", HOME: root },
      serviceEnvironment: {},
      now: () => new Date("2026-08-15T01:02:03.000Z"),
    });
    await backend.initialize();
    await backend.prepare(binding(first.descriptor.snapshotId, 1), first.descriptor, first.open());

    await writeFile(join(projectRoot, "app.js"), "export const answer = 2;\n", "utf8");
    const second = await snapshot(projectRoot);
    const secondBinding = binding(second.descriptor.snapshotId, 2);
    const firstCommit = await backend.commit(
      createLocalGitCommitRequest(secondBinding),
      second.descriptor,
      second.open(),
    );

    await writeFile(join(projectRoot, "app.js"), "export const answer = 3;\n", "utf8");
    const third = await snapshot(projectRoot);
    const thirdBinding: LocalGitBinding = {
      ...secondBinding,
      snapshotId: third.descriptor.snapshotId,
      workspaceRevision: 3,
      headCommit: firstCommit.commit,
    };
    await backend.prepare(thirdBinding, third.descriptor, third.open());
    const gitDir = join(
      serviceRoot,
      "projects",
      createHash("sha256").update(thirdBinding.projectId, "utf8").digest("hex"),
      "repo.git",
    );
    await execFileAsync("git", [
      `--git-dir=${gitDir}`,
      "update-ref",
      `refs/heads/${thirdBinding.branch}`,
      LOCAL_GIT_UPLOAD_ROOT_COMMIT,
      firstCommit.commit,
    ]);

    const request = createLocalGitCommitRequest(thirdBinding);
    await assert.rejects(
      backend.commit(request, third.descriptor, third.open()),
      /branch local git berubah/iu,
    );
    const observed = await execFileAsync("git", [
      `--git-dir=${gitDir}`,
      "show-ref",
      "--verify",
      "--hash",
      `refs/heads/${thirdBinding.branch}`,
    ]);
    assert.equal(observed.stdout.trim(), LOCAL_GIT_UPLOAD_ROOT_COMMIT);
    assert.deepEqual(await backend.reconcileCommit(request), {
      operationId: request.operationId,
      status: "unknown",
      operationFenced: false,
    });
  });
});

async function snapshot(root: string) {
  const manifest = await scanProjectTree(root, {
    now: () => new Date("2026-08-15T00:00:00.000Z"),
  });
  return createSandboxSnapshotSource(root, manifest);
}

function binding(
  snapshotId: string,
  workspaceRevision: number,
  baseCommit = LOCAL_GIT_UPLOAD_ROOT_COMMIT,
): LocalGitBinding {
  return {
    projectId: "uploaded-project-test",
    snapshotId,
    workspaceRevision,
    baseCommit,
    headCommit: baseCommit,
    branch: "harvy/upload-test",
  };
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const output: Buffer[] = [];
  for await (const chunk of chunks) output.push(Buffer.from(chunk));
  return output;
}
