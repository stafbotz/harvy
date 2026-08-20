import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalProjectPath, scanProjectTree } from "../src/core/project-files.js";
import { extractSafeZip } from "../src/core/safe-zip.js";
import type {
  GitHubBrokerTransportResult,
  GitHubExactEffect,
} from "../src/domain/github.js";
import {
  createLocalGitCommitRequest,
  type LocalGitBinding,
} from "../src/domain/local-git.js";
import { createSandboxSnapshotSource } from "../src/sandbox/snapshot-bundle.js";
import { HttpGitHubBrokerTransport } from "../src/transport/http-github-broker-transport.js";
import { HttpLocalGitTransport } from "../src/transport/http-local-git-transport.js";
import { HmacTrustDomainRequestProofProvider } from "../src/transport/trust-domain-http.js";

const CONFIRMATION = "CREATE_NONCRITICAL_DRAFT_PR";
const MAX_NEW_CONTENT_BYTES = 1024 * 1024;
const MAX_ACCEPTANCE_MS = 10 * 60_000;

interface AcceptanceConfig {
  githubOrigin: string;
  githubKeyId: string;
  githubSecretFile: string;
  localGitOrigin: string;
  localGitKeyId: string;
  localGitSecretFile: string;
  allowInsecureLoopback: boolean;
  ownerWorkspaceKey: string;
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  runLabel: string;
  targetPath: string;
  expectedBeforeSha256: string;
  newContentFile: string;
}

async function main(): Promise<void> {
  rejectForeignCredentials(process.env);
  const config = loadConfig(process.env);
  const github = new HttpGitHubBrokerTransport({
    origin: config.githubOrigin,
    allowInsecureLoopback: config.allowInsecureLoopback,
    proofProvider: new HmacTrustDomainRequestProofProvider(
      config.githubKeyId,
      await readSecret(config.githubSecretFile),
    ),
  });
  const localGit = new HttpLocalGitTransport({
    origin: config.localGitOrigin,
    allowInsecureLoopback: config.allowInsecureLoopback,
    proofProvider: new HmacTrustDomainRequestProofProvider(
      config.localGitKeyId,
      await readSecret(config.localGitSecretFile),
    ),
  });
  const signal = AbortSignal.timeout(MAX_ACCEPTANCE_MS);
  const [githubHealth, localGitHealth] = await Promise.all([
    github.health(signal),
    localGit.health(signal),
  ]);
  if (!githubHealth.available || githubHealth.protocol !== "harvy-github-broker/1") {
    throw new Error("GITHUB_LIVE_ACCEPTANCE_BROKER_UNAVAILABLE");
  }
  if (!localGitHealth.available || localGitHealth.protocol !== "harvy-local-git/1") {
    throw new Error("GITHUB_LIVE_ACCEPTANCE_LOCAL_GIT_UNAVAILABLE");
  }

  const branch = `harvy/live-acceptance-${config.runLabel}`;
  const staleBranch = `${branch}-stale-proof`;
  const access = await github.repositoryAccess(
    config.ownerWorkspaceKey,
    config.installationId,
    config.repositoryId,
    branch,
    signal,
  );
  if (access.repositoryFullName !== config.repositoryFullName ||
    !access.canRead || !access.canPush || !access.canCreatePullRequest) {
    throw new Error("GITHUB_LIVE_ACCEPTANCE_REPOSITORY_AUTHORITY_MISMATCH");
  }
  if (access.targetBranchHead !== null) {
    throw new Error("GITHUB_LIVE_ACCEPTANCE_BRANCH_ALREADY_EXISTS");
  }
  const staleAccess = await github.repositoryAccess(
    config.ownerWorkspaceKey,
    config.installationId,
    config.repositoryId,
    staleBranch,
    signal,
  );
  if (staleAccess.targetBranchHead !== null) {
    throw new Error("GITHUB_LIVE_ACCEPTANCE_STALE_PROOF_BRANCH_EXISTS");
  }

  const temporary = await mkdtemp(join(tmpdir(), "harvy-github-live-"));
  try {
    const archiveOperation = `github-live-archive-${config.runLabel}-${randomBytes(8).toString("hex")}`;
    const archiveReference = await github.prepareRepositoryArchive(
      config.ownerWorkspaceKey,
      config.installationId,
      config.repositoryId,
      access.baseCommit,
      archiveOperation,
      signal,
    );
    const archive = await collect(github.downloadRepositoryArchive(archiveReference, signal));
    if (archive.byteLength !== archiveReference.size || sha256(archive) !== archiveReference.sha256) {
      throw new Error("GITHUB_LIVE_ACCEPTANCE_ARCHIVE_DIGEST_MISMATCH");
    }
    const projectRoot = join(temporary, "project");
    const extracted = await extractSafeZip(archive, projectRoot, {
      stripSingleRoot: true,
      preserveRegularFileExecutability: true,
    });
    const first = await createSandboxSnapshotSource(projectRoot, extracted.manifest);
    const targetPath = canonicalProjectPath(config.targetPath);
    if (targetPath.startsWith(".github/workflows/")) {
      throw new Error("GITHUB_LIVE_ACCEPTANCE_WORKFLOW_CHANGE_REQUIRES_SEPARATE_CAPABILITY");
    }
    const target = join(projectRoot, ...targetPath.split("/"));
    const targetState = await lstat(target);
    if (!targetState.isFile() || targetState.isSymbolicLink() || targetState.size > MAX_NEW_CONTENT_BYTES) {
      throw new Error("GITHUB_LIVE_ACCEPTANCE_TARGET_NOT_SAFE_REGULAR_FILE");
    }
    const before = await readFile(target);
    if (sha256(before) !== config.expectedBeforeSha256) {
      throw new Error("GITHUB_LIVE_ACCEPTANCE_TARGET_PRECONDITION_FAILED");
    }
    const after = await readBoundedFile(config.newContentFile, MAX_NEW_CONTENT_BYTES);
    if (after.equals(before)) throw new Error("GITHUB_LIVE_ACCEPTANCE_CHANGE_IS_EMPTY");

    const projectId = `github-live-project-${config.runLabel}`;
    const firstBinding = binding({
      projectId,
      snapshotId: first.descriptor.snapshotId,
      workspaceRevision: 1,
      baseCommit: access.baseCommit,
      branch,
    });
    await localGit.prepare(firstBinding, first.descriptor, first.open(), signal);
    await writeFile(target, after);
    const secondManifest = await scanProjectTree(projectRoot);
    const second = await createSandboxSnapshotSource(projectRoot, secondManifest);
    const secondBinding = binding({
      projectId,
      snapshotId: second.descriptor.snapshotId,
      workspaceRevision: 2,
      baseCommit: access.baseCommit,
      branch,
    });
    await localGit.prepare(secondBinding, second.descriptor, second.open(), signal);
    const localStatus = await localGit.status(secondBinding, signal);
    if (localStatus.clean || JSON.stringify(localStatus.changedPaths) !== JSON.stringify([targetPath])) {
      throw new Error("GITHUB_LIVE_ACCEPTANCE_LOCAL_DIFF_NOT_EXACT");
    }
    const commitRequest = createLocalGitCommitRequest(secondBinding);
    const commit = await localGit.commit(
      commitRequest,
      second.descriptor,
      second.open(),
      signal,
    );
    if (commit.parentCommit !== access.baseCommit || commit.sourceWorkspaceRevision !== 2) {
      throw new Error("GITHUB_LIVE_ACCEPTANCE_LOCAL_COMMIT_NOT_EXACT");
    }

    const common = {
      projectId,
      runId: `github-live-run-${config.runLabel}`,
      ownerWorkspaceKey: config.ownerWorkspaceKey,
      installationConnectionId: `github-live-installation-${config.runLabel}`,
      repositoryBindingId: `github-live-binding-${config.runLabel}`,
      installationId: config.installationId,
      repositoryId: config.repositoryId,
      workspaceRevision: 2,
      instructionRevision: 0,
      branch,
      commit: commit.commit,
      baseCommit: access.baseCommit,
      baseBranch: access.defaultBranch,
    } as const;

    const syntheticStaleBase = access.baseCommit === "0".repeat(40)
      ? "1".repeat(40)
      : "0".repeat(40);
    const staleEffect = exactEffect({
      ...common,
      branch: staleBranch,
      baseCommit: syntheticStaleBase,
      capability: "github.branch.create",
      expectedTargetHead: null,
      objectBundle: null,
      title: null,
      body: null,
      draft: null,
    });
    const staleResult = await settle(
      github,
      staleEffect,
      () => github.createBranch(staleEffect, signal),
      signal,
    );
    if (staleResult.status !== "not_committed" || !staleResult.operationFenced) {
      throw new Error("GITHUB_LIVE_ACCEPTANCE_STALE_BASE_NOT_FENCED");
    }
    const staleAfter = await github.repositoryAccess(
      config.ownerWorkspaceKey,
      config.installationId,
      config.repositoryId,
      staleBranch,
      signal,
    );
    if (staleAfter.targetBranchHead !== null) {
      throw new Error("GITHUB_LIVE_ACCEPTANCE_STALE_BASE_MUTATED_REMOTE");
    }

    const branchEffect = exactEffect({
      ...common,
      capability: "github.branch.create",
      expectedTargetHead: null,
      objectBundle: null,
      title: null,
      body: null,
      draft: null,
    });
    const branchResult = await settle(
      github,
      branchEffect,
      () => github.createBranch(branchEffect, signal),
      signal,
    );
    requireCommitted(branchResult, "BRANCH");

    const pushEffect = exactEffect({
      ...common,
      capability: "github.push_branch",
      expectedTargetHead: access.baseCommit,
      objectBundle: commit.objectBundle,
      title: null,
      body: null,
      draft: null,
    });
    const pushResult = await settle(
      github,
      pushEffect,
      () => github.pushExactCommit(
        pushEffect,
        localGit.openObjectBundle(commit.objectBundle, signal),
        signal,
      ),
      signal,
    );
    requireCommitted(pushResult, "PUSH");

    const prEffect = exactEffect({
      ...common,
      capability: "github.pr.create",
      expectedTargetHead: commit.commit,
      objectBundle: null,
      title: `Harvy live acceptance ${config.runLabel}`,
      body: "Credential-brokered Harvy live acceptance. This intentionally remains a draft for inspection.",
      draft: true,
    });
    const prResult = await settle(
      github,
      prEffect,
      () => github.createDraftPullRequest(prEffect, signal),
      signal,
    );
    requireCommitted(prResult, "DRAFT_PR");

    const finalAccess = await github.repositoryAccess(
      config.ownerWorkspaceKey,
      config.installationId,
      config.repositoryId,
      branch,
      signal,
    );
    if (finalAccess.baseCommit !== access.baseCommit || finalAccess.targetBranchHead !== commit.commit) {
      throw new Error("GITHUB_LIVE_ACCEPTANCE_REMOTE_STATE_NOT_EXACT");
    }
    process.stdout.write(`${JSON.stringify({
      version: 1,
      suite: "harvy-github-broker-live-v1",
      testedAt: new Date().toISOString(),
      brokerProtocol: githubHealth.protocol,
      localGitProtocol: localGitHealth.protocol,
      repositoryFullName: access.repositoryFullName,
      repositoryVisibility: access.visibility,
      baseBranch: access.defaultBranch,
      baseCommit: access.baseCommit,
      branch,
      commit: commit.commit,
      treeHash: commit.treeHash,
      archiveSha256: archiveReference.sha256,
      beforeSnapshot: first.descriptor.snapshotId,
      afterSnapshot: second.descriptor.snapshotId,
      changedPath: targetPath,
      beforeSha256: config.expectedBeforeSha256,
      afterSha256: sha256(after),
      staleBaseRejectedWithoutBranch: true,
      branchEffectId: branchEffect.effectId,
      pushEffectId: pushEffect.effectId,
      pullRequestEffectId: prEffect.effectId,
      branchUrl: branchResult.url,
      commitUrl: pushResult.url,
      draftPullRequestId: prResult.externalId,
      draftPullRequestUrl: prResult.url,
      remoteDeleteAttempted: false,
    }, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function loadConfig(env: NodeJS.ProcessEnv): AcceptanceConfig {
  if (env.HARVY_GITHUB_ACCEPTANCE_CONFIRM !== CONFIRMATION) {
    throw new Error(`GITHUB_LIVE_ACCEPTANCE_REQUIRES_${CONFIRMATION}`);
  }
  return {
    githubOrigin: requiredUrl(env, "HARVY_GITHUB_ACCEPTANCE_BROKER_ORIGIN"),
    githubKeyId: requiredText(env, "HARVY_GITHUB_ACCEPTANCE_BROKER_HMAC_KEY_ID", /^[A-Za-z0-9_-]{3,64}$/u),
    githubSecretFile: requiredPath(env, "HARVY_GITHUB_ACCEPTANCE_BROKER_HMAC_SECRET_FILE"),
    localGitOrigin: requiredUrl(env, "HARVY_GITHUB_ACCEPTANCE_LOCAL_GIT_ORIGIN"),
    localGitKeyId: requiredText(env, "HARVY_GITHUB_ACCEPTANCE_LOCAL_GIT_HMAC_KEY_ID", /^[A-Za-z0-9_-]{3,64}$/u),
    localGitSecretFile: requiredPath(env, "HARVY_GITHUB_ACCEPTANCE_LOCAL_GIT_HMAC_SECRET_FILE"),
    allowInsecureLoopback: env.HARVY_GITHUB_ACCEPTANCE_ALLOW_INSECURE_LOOPBACK === "true",
    ownerWorkspaceKey: requiredText(env, "HARVY_GITHUB_ACCEPTANCE_OWNER_WORKSPACE_KEY", /^[A-Za-z0-9._:-]{3,256}$/u),
    installationId: requiredText(env, "HARVY_GITHUB_ACCEPTANCE_INSTALLATION_ID", /^\d{1,20}$/u),
    repositoryId: requiredText(env, "HARVY_GITHUB_ACCEPTANCE_REPOSITORY_ID", /^\d{1,20}$/u),
    repositoryFullName: requiredText(env, "HARVY_GITHUB_ACCEPTANCE_REPOSITORY_FULL_NAME", /^[^/\s]+\/[^/\s]+$/u),
    runLabel: requiredText(env, "HARVY_GITHUB_ACCEPTANCE_RUN_LABEL", /^[a-z0-9][a-z0-9-]{2,48}$/u),
    targetPath: requiredText(env, "HARVY_GITHUB_ACCEPTANCE_TARGET_PATH", /^[^\0\r\n]{1,512}$/u),
    expectedBeforeSha256: requiredText(env, "HARVY_GITHUB_ACCEPTANCE_EXPECTED_BEFORE_SHA256", /^[a-f0-9]{64}$/u),
    newContentFile: requiredPath(env, "HARVY_GITHUB_ACCEPTANCE_NEW_CONTENT_FILE"),
  };
}

function binding(input: {
  projectId: string;
  snapshotId: string;
  workspaceRevision: number;
  baseCommit: string;
  branch: string;
}): LocalGitBinding {
  return {
    projectId: input.projectId,
    snapshotId: input.snapshotId,
    workspaceRevision: input.workspaceRevision,
    baseCommit: input.baseCommit,
    headCommit: input.baseCommit,
    branch: input.branch,
  };
}

function exactEffect(
  semantic: Omit<GitHubExactEffect, "effectId" | "attempt">,
): GitHubExactEffect {
  const body = { attempt: 1, ...semantic };
  return {
    effectId: `github-effect-${sha256(Buffer.from(canonicalJson(body), "utf8"))}`,
    ...body,
  };
}

async function settle(
  github: HttpGitHubBrokerTransport,
  effect: GitHubExactEffect,
  invoke: () => Promise<GitHubBrokerTransportResult>,
  signal: AbortSignal,
): Promise<GitHubBrokerTransportResult> {
  let result: GitHubBrokerTransportResult;
  try {
    result = await invoke();
  } catch {
    result = await github.reconcileEffect(effect, signal);
  }
  for (let attempt = 0; result.status === "unknown" && attempt < 5; attempt += 1) {
    await delay(1_000, signal);
    result = await github.reconcileEffect(effect, signal);
  }
  if (result.status === "unknown" || !result.operationFenced) {
    throw new Error("GITHUB_LIVE_ACCEPTANCE_EFFECT_REMAINS_AMBIGUOUS");
  }
  return result;
}

function requireCommitted(result: GitHubBrokerTransportResult, stage: string): void {
  if (result.status !== "committed" || !result.operationFenced) {
    throw new Error(`GITHUB_LIVE_ACCEPTANCE_${stage}_NOT_COMMITTED`);
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const raw of source) chunks.push(Buffer.from(raw));
  return Buffer.concat(chunks);
}

async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
  const state = await lstat(path);
  if (!state.isFile() || state.isSymbolicLink() || state.size < 1 || state.size > maximum) {
    throw new Error("GITHUB_LIVE_ACCEPTANCE_NEW_CONTENT_FILE_INVALID");
  }
  return readFile(path);
}

async function readSecret(path: string): Promise<Buffer> {
  const bytes = await readBoundedFile(path, 16 * 1024);
  const text = bytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{43,5462}$/u.test(text)) {
    throw new Error("GITHUB_LIVE_ACCEPTANCE_HMAC_SECRET_INVALID");
  }
  const secret = Buffer.from(text, "base64url");
  if (secret.byteLength < 32 || secret.byteLength > 4_096) {
    throw new Error("GITHUB_LIVE_ACCEPTANCE_HMAC_SECRET_INVALID");
  }
  return secret;
}

function requiredText(
  env: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
): string {
  const value = env[name]?.trim();
  if (!value || !pattern.test(value)) throw new Error(`CONFIG_INVALID_${name}`);
  return value;
}

function requiredPath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`CONFIG_MISSING_${name}`);
  return resolve(value);
}

function requiredUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`CONFIG_MISSING_${name}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`CONFIG_INVALID_${name}`);
  }
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error(`CONFIG_INVALID_${name}`);
  }
  return url.toString().replace(/\/$/u, "");
}

function rejectForeignCredentials(env: NodeJS.ProcessEnv): void {
  const forbidden = [
    /^(?:GH|GITHUB)_TOKEN$/u,
    /^HARVY_GITHUB_APP_/u,
    /^OPENAI_/u,
    /^OPENROUTER_/u,
    /^GOOGLE_AI_STUDIO_API_KEYS$/u,
    /^TELEGRAM_BOT_TOKEN$/u,
    /^WHATSAPP_/u,
    /^(?:DATABASE_URL|PGPASSWORD|MYSQL_PWD|REDIS_URL)$/u,
  ];
  if (Object.keys(env).some((name) => env[name] && forbidden.some((pattern) => pattern.test(name)))) {
    throw new Error("GITHUB_LIVE_ACCEPTANCE_CLIENT_FOREIGN_CREDENTIAL_PRESENT");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal.aborted) {
      rejectDelay(signal.reason);
      return;
    }
    const timer = setTimeout(resolveDelay, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      rejectDelay(signal.reason);
    }, { once: true });
  });
}

await main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]{3,160}$/u.test(error.message)
    ? error.message
    : "GITHUB_LIVE_ACCEPTANCE_FAILED";
  process.stderr.write(`${JSON.stringify({
    version: 1,
    suite: "harvy-github-broker-live-v1",
    testedAt: new Date().toISOString(),
    status: "failed",
    code,
  })}\n`);
  process.exitCode = 1;
});
