import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  GitHubBrokerHealth,
  GitHubBrokerTransportResult,
  GitHubExactEffect,
  GitHubInstallationSession,
  GitHubInstallationStatus,
  GitHubRepositoryAccess,
  GitHubRepositoryArchiveReference,
  GitHubRepositoryPage,
  GitHubRepositorySummary,
} from "../domain/github.js";
import {
  validateLocalGitObjectBundleReference,
  type LocalGitObjectBundleReference,
} from "../domain/local-git.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import {
  GitHubApiClient,
  GitHubApiError,
  type GitHubApiClientOptions,
} from "./github-api-client.js";
import { GitHubAppCredentials } from "./github-app-credentials.js";
import {
  GitHubBrokerStore,
  digest,
  digestCanonical,
  type BrokerEffectRecord,
  type BrokerInstallationSessionRecord,
} from "./github-broker-store.js";
import {
  GitObjectBundleReader,
  type GitBundleCommit,
} from "./git-object-bundle.js";

const PROTOCOL = "harvy-github-broker/1" as const;
const DEFAULT_SESSION_TTL_MS = 15 * 60_000;
const DEFAULT_ARCHIVE_TTL_MS = 15 * 60_000;
const DEFAULT_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const WORKFLOW_PATH = /^\.github\/workflows\//u;

export interface GitHubAppBackendOptions {
  dataRoot: string;
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: Uint8Array;
  callbackUrl: string;
  stateSecret: Uint8Array;
  api?: GitHubApiClient;
  apiOptions?: GitHubApiClientOptions;
  gitCommand?: string;
  commandEnvironment?: Readonly<Record<string, string>>;
  now?: () => Date;
  sessionTtlMs?: number;
  archiveTtlMs?: number;
  maxArchiveBytes?: number;
}

export interface GitHubInstallationCallback {
  state: string;
  code: string;
  installationId: string;
  setupAction: "install" | "update";
}

interface RepositoryContext {
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  owner: string;
  name: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
  archived: boolean;
  disabled: boolean;
  repoCanPush: boolean;
  permissions: Record<string, string>;
}

/**
 * Credential-owning GitHub App implementation. Only this class can mint App,
 * user, or installation tokens. Its public methods return content metadata and
 * exact receipts, never credentials.
 */
export class GitHubAppBackend {
  readonly #store: GitHubBrokerStore;
  readonly #api: GitHubApiClient;
  readonly #credentials: GitHubAppCredentials;
  readonly #reader: GitObjectBundleReader;
  readonly #appSlug: string;
  readonly #callbackUrl: string;
  readonly #stateSecret: Buffer;
  readonly #now: () => Date;
  readonly #sessionTtlMs: number;
  readonly #archiveTtlMs: number;
  readonly #maxArchiveBytes: number;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: GitHubAppBackendOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#appSlug = appSlug(options.appSlug);
    this.#callbackUrl = callbackUrl(options.callbackUrl);
    if (!(options.stateSecret instanceof Uint8Array) || options.stateSecret.byteLength < 32 ||
      options.stateSecret.byteLength > 4_096) {
      throw new Error("GitHub callback state secret tidak sah.");
    }
    this.#stateSecret = Buffer.from(options.stateSecret);
    this.#api = options.api ?? new GitHubApiClient({
      maxJsonBytes: 32 * 1024 * 1024,
      ...(options.apiOptions ?? {}),
    });
    this.#credentials = new GitHubAppCredentials({
      appId: options.appId,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      privateKeyPem: options.privateKeyPem,
      api: this.#api,
      now: this.#now,
    });
    this.#store = new GitHubBrokerStore(options.dataRoot);
    this.#reader = new GitObjectBundleReader({
      temporaryRoot: join(this.#store.root, "object-bundle-tmp"),
      ...(options.gitCommand ? { gitCommand: options.gitCommand } : {}),
      ...(options.commandEnvironment ? { commandEnvironment: options.commandEnvironment } : {}),
    });
    this.#sessionTtlMs = duration(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, "session TTL", 60 * 60_000);
    this.#archiveTtlMs = duration(options.archiveTtlMs ?? DEFAULT_ARCHIVE_TTL_MS, "archive TTL", 60 * 60_000);
    this.#maxArchiveBytes = duration(
      options.maxArchiveBytes ?? DEFAULT_ARCHIVE_MAX_BYTES,
      "archive maximum",
      128 * 1024 * 1024,
    );
  }

  async initialize(): Promise<void> {
    await this.#store.initialize();
    await this.#reader.initialize();
    const now = this.#now();
    for (const session of await this.#store.listSessions()) {
      if (session.status === "pending" && now.getTime() >= Date.parse(session.expiresAt)) {
        await this.#store.saveSession({ ...session, status: "expired", updatedAt: now.toISOString() });
      }
    }
    for (const effect of await this.#store.listEffects()) {
      if (effect.status === "committed" || effect.status === "not_committed") continue;
      if (effect.phase === "admitted" || effect.phase === "objects_uploading") {
        await this.#terminal(effect, "not_committed", null, null);
        continue;
      }
      await this.#exclusive(effect.effectId, async () => {
        await this.#observe(effect).catch(() => undefined);
      });
    }
  }

  async health(signal?: AbortSignal): Promise<GitHubBrokerHealth> {
    try {
      const response = await this.#api.apiJson({
        method: "GET",
        path: "/app",
        authorization: this.#credentials.appJwt(),
        accepted: [200],
        retrySafe: true,
        ...(signal ? { signal } : {}),
      });
      const app = object(response.value, "GitHub App health");
      if (String(app.id) !== this.#credentials.appId || app.slug !== this.#appSlug) {
        throw new Error("GitHub App identity tidak cocok.");
      }
      return { available: true, protocol: PROTOCOL, checkedAt: this.#now().toISOString(), reason: null };
    } catch (error) {
      return {
        available: false,
        protocol: null,
        checkedAt: this.#now().toISOString(),
        reason: safeReason(error),
      };
    }
  }

  async beginInstallation(
    ownerWorkspaceKeyInput: string,
    sessionIdInput: string,
  ): Promise<GitHubInstallationSession> {
    const ownerWorkspaceKey = safeText(ownerWorkspaceKeyInput, "owner workspace", 256);
    const sessionId = safeText(sessionIdInput, "installation session", 128);
    return this.#exclusive(`session:${sessionId}`, async () => {
      const existing = await this.#store.loadSession(sessionId);
      const state = this.#callbackState(ownerWorkspaceKey, sessionId);
      const stateHash = digest(Buffer.from(state, "ascii"));
      if (existing) {
        if (existing.ownerWorkspaceKey !== ownerWorkspaceKey || existing.callbackStateHash !== stateHash) {
          throw new Error("GitHub installation session bertabrakan.");
        }
        if (existing.status !== "pending" || this.#now().getTime() >= Date.parse(existing.expiresAt)) {
          throw new Error("GitHub installation session tidak lagi pending.");
        }
        return this.#sessionView(existing, state);
      }
      const createdAt = this.#now();
      const record: BrokerInstallationSessionRecord = {
        version: 1,
        sessionId,
        ownerWorkspaceKey,
        callbackStateHash: stateHash,
        status: "pending",
        installationId: null,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + this.#sessionTtlMs).toISOString(),
        completedAt: null,
        updatedAt: createdAt.toISOString(),
      };
      await this.#store.saveSession(record);
      return this.#sessionView(record, state);
    });
  }

  async completeInstallationCallback(
    input: GitHubInstallationCallback,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; ownerWorkspaceKey: string; installationId: string }> {
    const state = callbackValue(input.state, "state", 512);
    const stateHash = digest(Buffer.from(state, "ascii"));
    const session = await this.#store.findSessionByStateHash(stateHash);
    if (!session) throw new Error("GitHub callback state tidak dikenal.");
    return this.#exclusive(`session:${session.sessionId}`, async () => {
      const current = await this.#store.loadSession(session.sessionId);
      if (!current || !constantEqual(this.#callbackState(current.ownerWorkspaceKey, current.sessionId), state)) {
        throw new Error("GitHub callback state tidak cocok.");
      }
      const installationId = numericId(input.installationId, "installation id");
      if (current.status === "ready") {
        if (current.installationId !== installationId) throw new Error("GitHub callback mengubah installation id.");
        return {
          sessionId: current.sessionId,
          ownerWorkspaceKey: current.ownerWorkspaceKey,
          installationId,
        };
      }
      if (current.status !== "pending" || this.#now().getTime() >= Date.parse(current.expiresAt)) {
        throw new Error("GitHub callback session sudah kedaluwarsa atau dicabut.");
      }
      if (input.setupAction !== "install" && input.setupAction !== "update") {
        throw new Error("GitHub setup action tidak sah.");
      }
      const userToken = await this.#credentials.exchangeUserCode({
        code: callbackValue(input.code, "OAuth code", 2_048),
        redirectUri: this.#callbackUrl,
        ...(signal ? { signal } : {}),
      });
      const userOwnsInstallation = await this.#userCanAccessInstallation(
        userToken,
        installationId,
        signal,
      );
      if (!userOwnsInstallation) throw new Error("Pengguna GitHub tidak berwenang atas installation.");
      await this.#installationInfo(installationId, signal);
      const completedAt = this.#now().toISOString();
      const ready: BrokerInstallationSessionRecord = {
        ...current,
        status: "ready",
        installationId,
        completedAt,
        updatedAt: completedAt,
      };
      await this.#store.saveSession(ready);
      return {
        sessionId: ready.sessionId,
        ownerWorkspaceKey: ready.ownerWorkspaceKey,
        installationId,
      };
    });
  }

  async installationStatus(
    ownerWorkspaceKeyInput: string,
    sessionIdInput: string,
    signal?: AbortSignal,
  ): Promise<GitHubInstallationStatus> {
    const ownerWorkspaceKey = safeText(ownerWorkspaceKeyInput, "owner workspace", 256);
    const sessionId = safeText(sessionIdInput, "installation session", 128);
    return this.#exclusive(`session:${sessionId}`, async () => {
      let session = await this.#store.loadSession(sessionId);
      if (!session || session.ownerWorkspaceKey !== ownerWorkspaceKey) {
        throw new Error("GitHub installation session tidak ditemukan.");
      }
      const at = this.#now();
      if (session.status === "pending" && at.getTime() >= Date.parse(session.expiresAt)) {
        session = { ...session, status: "expired", updatedAt: at.toISOString() };
        await this.#store.saveSession(session);
      }
      if (session.status === "ready" && session.installationId) {
        try {
          await this.#installationInfo(session.installationId, signal);
        } catch (error) {
          if (error instanceof GitHubApiError && (error.status === 404 || error.status === 401)) {
            session = {
              ...session,
              status: "revoked",
              completedAt: at.toISOString(),
              updatedAt: at.toISOString(),
            };
            this.#credentials.clearInstallationTokens(session.installationId!);
            await this.#store.saveSession(session);
          } else {
            throw error;
          }
        }
      }
      return {
        sessionId: session.sessionId,
        ownerWorkspaceKey: session.ownerWorkspaceKey,
        status: session.status,
        installationId: session.installationId,
        completedAt: session.completedAt,
        expiresAt: session.expiresAt,
      };
    });
  }

  async listRepositories(
    ownerWorkspaceKeyInput: string,
    installationIdInput: string,
    cursorInput: string | null,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryPage> {
    const ownerWorkspaceKey = safeText(ownerWorkspaceKeyInput, "owner workspace", 256);
    const installationId = numericId(installationIdInput, "installation id");
    await this.#assertInstallationOwner(ownerWorkspaceKey, installationId);
    const page = decodeCursor(cursorInput);
    const token = await this.#credentials.installationToken({
      installationId,
      permissions: { metadata: "read" },
      ...(signal ? { signal } : {}),
    });
    const response = await this.#api.apiJson({
      method: "GET",
      path: `/installation/repositories?per_page=100&page=${page}`,
      authorization: token,
      accepted: [200],
      retrySafe: true,
      ...(signal ? { signal } : {}),
    });
    const root = object(response.value, "installation repositories");
    if (!Array.isArray(root.repositories) || root.repositories.length > 100) {
      throw new Error("Daftar repository installation tidak sah.");
    }
    const repositories = root.repositories.map((value) => repositorySummary(value, installationId));
    return {
      ownerWorkspaceKey,
      installationId,
      repositories,
      nextCursor: repositories.length === 100 ? encodeCursor(page + 1) : null,
    };
  }

  async repositoryAccess(
    ownerWorkspaceKeyInput: string,
    installationIdInput: string,
    repositoryIdInput: string,
    targetBranchInput: string | null,
    signal?: AbortSignal,
  ): Promise<GitHubRepositoryAccess> {
    const ownerWorkspaceKey = safeText(ownerWorkspaceKeyInput, "owner workspace", 256);
    const installationId = numericId(installationIdInput, "installation id");
    const repositoryId = numericId(repositoryIdInput, "repository id");
    const targetBranch = targetBranchInput === null ? null : gitBranch(targetBranchInput);
    await this.#assertInstallationOwner(ownerWorkspaceKey, installationId);
    const context = await this.#repositoryContext(installationId, repositoryId, signal);
    const token = await this.#credentials.installationToken({
      installationId,
      repositoryId,
      permissions: { contents: "read", metadata: "read" },
      ...(signal ? { signal } : {}),
    });
    const baseCommit = await this.#refHead(context, context.defaultBranch, token, false, signal);
    if (!baseCommit) throw new Error("Default branch GitHub tidak mempunyai head.");
    const targetBranchHead = targetBranch === null
      ? null
      : await this.#refHead(context, targetBranch, token, true, signal);
    const contents = permissionLevel(context.permissions.contents);
    const workflows = permissionLevel(context.permissions.workflows);
    const pulls = permissionLevel(context.permissions.pull_requests);
    const writable = !context.archived && !context.disabled && context.repoCanPush;
    return {
      ownerWorkspaceKey,
      installationId,
      repositoryId,
      repositoryFullName: context.repositoryFullName,
      visibility: context.visibility,
      defaultBranch: context.defaultBranch,
      baseCommit,
      targetBranch,
      targetBranchHead,
      canRead: contents >= 1,
      canPush: writable && contents >= 2,
      canWriteWorkflows: writable && contents >= 2 && workflows >= 2,
      canCreatePullRequest: writable && contents >= 1 && pulls >= 2,
    };
  }

  async prepareRepositoryArchive(input: {
    ownerWorkspaceKey: string;
    installationId: string;
    repositoryId: string;
    commit: string;
    operationId: string;
  }, signal?: AbortSignal): Promise<GitHubRepositoryArchiveReference> {
    const request = {
      ownerWorkspaceKey: safeText(input.ownerWorkspaceKey, "owner workspace", 256),
      installationId: numericId(input.installationId, "installation id"),
      repositoryId: numericId(input.repositoryId, "repository id"),
      commit: gitHash(input.commit, "archive commit"),
      operationId: safeText(input.operationId, "archive operation", 256),
    };
    return this.#exclusive(`archive:${request.operationId}`, async () => {
      const requestDigest = digestCanonical(request);
      const existing = await this.#store.loadArchive(request.operationId);
      if (existing) {
        if (existing.requestDigest !== requestDigest) throw new Error("Archive operation id bertabrakan.");
        await this.#verifyArchive(existing.reference);
        return existing.reference;
      }
      const access = await this.repositoryAccess(
        request.ownerWorkspaceKey,
        request.installationId,
        request.repositoryId,
        null,
        signal,
      );
      if (!access.canRead || access.baseCommit !== request.commit) {
        throw new Error("Repository archive tidak fresh terhadap default branch.");
      }
      const context = await this.#repositoryContext(request.installationId, request.repositoryId, signal);
      const token = await this.#credentials.installationToken({
        installationId: request.installationId,
        repositoryId: request.repositoryId,
        permissions: { contents: "read", metadata: "read" },
        ...(signal ? { signal } : {}),
      });
      const bytes = await this.#api.downloadArchive({
        path: `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/zipball/${request.commit}`,
        authorization: token,
        maximumBytes: this.#maxArchiveBytes,
        ...(signal ? { signal } : {}),
      });
      const createdAt = this.#now();
      const sha256 = digest(bytes);
      const reference: GitHubRepositoryArchiveReference = {
        version: 1,
        operationId: request.operationId,
        archiveId: `github-archive-${sha256}`,
        ownerWorkspaceKey: request.ownerWorkspaceKey,
        installationId: request.installationId,
        repositoryId: request.repositoryId,
        repositoryFullName: context.repositoryFullName,
        defaultBranch: context.defaultBranch,
        commit: request.commit,
        mediaType: "application/zip",
        sha256,
        size: bytes.byteLength,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + this.#archiveTtlMs).toISOString(),
      };
      await this.#store.saveArchive({
        version: 1,
        requestDigest,
        reference,
        relativePath: `archive-${sha256}.zip`,
      }, bytes);
      return reference;
    });
  }

  async repositoryArchive(
    referenceInput: GitHubRepositoryArchiveReference,
  ): Promise<{ path: string; reference: GitHubRepositoryArchiveReference }> {
    const reference = validateArchiveReference(referenceInput);
    const record = await this.#store.loadArchive(reference.operationId);
    if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference)) {
      throw new Error("Archive GitHub tidak ditemukan atau binding berubah.");
    }
    await this.#verifyArchive(reference);
    return { path: this.#store.archivePath(record.relativePath), reference };
  }

  async createBranch(effectInput: GitHubExactEffect, signal?: AbortSignal): Promise<GitHubBrokerTransportResult> {
    const effect = validateEffect(effectInput, "github.branch.create");
    return this.#execute(effect, async (record) => {
      const context = await this.#effectContext(effect, "write", signal);
      const token = await this.#effectToken(effect, { contents: "write", metadata: "read" }, signal);
      const baseHead = await this.#refHead(context, effect.baseBranch, token, false, signal);
      if (baseHead !== effect.baseCommit) {
        return this.#terminal(record, "not_committed", null, null);
      }
      const current = await this.#refHead(context, effect.branch, token, true, signal);
      if (current !== null) {
        if (current === effect.baseCommit) {
          return this.#terminal(record, "committed", null, branchUrl(context, effect.branch));
        }
        return this.#terminal(record, "not_committed", null, null);
      }
      record = await this.#phase(record, "ref_update_sending", "unknown");
      try {
        const response = await this.#api.apiJson({
          method: "POST",
          path: repoPath(context, "/git/refs"),
          authorization: token,
          body: { ref: `refs/heads/${effect.branch}`, sha: effect.baseCommit },
          accepted: [201],
          ...(signal ? { signal } : {}),
        });
        const ref = gitRefResponse(response.value);
        if (ref.ref !== `refs/heads/${effect.branch}` || ref.sha !== effect.baseCommit) {
          throw new Error("Receipt create branch GitHub tidak exact.");
        }
        return this.#terminal(record, "committed", null, branchUrl(context, effect.branch));
      } catch {
        return this.#observe(record);
      }
    });
  }

  async pushExactCommit(
    effectInput: GitHubExactEffect,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    const effect = validateEffect(effectInput, ["github.push_branch", "github.workflow.write"]);
    const descriptor = validateLocalGitObjectBundleReference(effect.objectBundle!);
    const spool = join(this.#store.root, "object-bundle-tmp", `upload-${randomBytes(16).toString("hex")}.bundle`);
    try {
      await spoolUpload(spool, content, descriptor, signal);
      return await this.#execute(effect, async (record) => {
        if (record.status === "unknown" && record.phase === "ref_update_sending") {
          return this.#observe(record);
        }
        const commit = await this.#reader.read(effect, descriptor, spool, signal);
        const context = await this.#effectContext(effect, "write", signal);
        const readToken = await this.#effectToken(effect, {
          contents: "read",
          metadata: "read",
        }, signal);
        const baseHead = await this.#refHead(
          context,
          effect.baseBranch,
          readToken,
          false,
          signal,
        );
        if (baseHead !== effect.baseCommit) {
          return this.#terminal(record, "not_committed", null, null);
        }
        const hasWorkflow = await this.#workflowChanged(
          context,
          readToken,
          effect.baseCommit,
          commit,
          signal,
        );
        if (hasWorkflow !== (effect.capability === "github.workflow.write")) {
          return this.#terminal(record, "not_committed", null, null);
        }
        const permissions: Record<string, "read" | "write"> = {
          contents: "write",
          metadata: "read",
          ...(hasWorkflow ? { workflows: "write" as const } : {}),
        };
        const token = await this.#effectToken(effect, permissions, signal);
        const current = await this.#refHead(context, effect.branch, token, false, signal);
        if (current === effect.commit) {
          return this.#terminal(record, "committed", null, commitUrl(context, effect.commit));
        }
        if (current !== effect.expectedTargetHead) {
          return this.#terminal(record, "not_committed", null, null);
        }
        record = await this.#phase(record, "objects_uploading", "pending");
        try {
          await this.#uploadCommitObjects(context, token, effect, commit, signal);
          const fresh = await this.#refHead(context, effect.branch, token, false, signal);
          if (fresh !== effect.expectedTargetHead) {
            return this.#terminal(record, "not_committed", null, null);
          }
        } catch {
          return this.#terminal(record, "not_committed", null, null);
        }
        record = await this.#phase(record, "ref_update_sending", "unknown");
        try {
          const response = await this.#api.apiJson({
            method: "PATCH",
            path: repoPath(context, `/git/refs/heads/${encodedBranch(effect.branch)}`),
            authorization: token,
            body: { sha: effect.commit, force: false },
            accepted: [200],
            ...(signal ? { signal } : {}),
          });
          const ref = gitRefResponse(response.value);
          if (ref.ref !== `refs/heads/${effect.branch}` || ref.sha !== effect.commit) {
            throw new Error("Receipt push GitHub tidak exact.");
          }
          return this.#terminal(record, "committed", null, commitUrl(context, effect.commit));
        } catch {
          return this.#observe(record);
        }
      });
    } finally {
      await rm(spool, { force: true });
    }
  }

  async createDraftPullRequest(
    effectInput: GitHubExactEffect,
    signal?: AbortSignal,
  ): Promise<GitHubBrokerTransportResult> {
    const effect = validateEffect(effectInput, "github.pr.create");
    return this.#execute(effect, async (record) => {
      const context = await this.#effectContext(effect, "pull_request", signal);
      const token = await this.#effectToken(effect, {
        contents: "read", metadata: "read", pull_requests: "write",
      }, signal);
      const baseHead = await this.#refHead(context, effect.baseBranch, token, false, signal);
      if (baseHead !== effect.baseCommit) {
        return this.#terminal(record, "not_committed", null, null);
      }
      const head = await this.#refHead(context, effect.branch, token, false, signal);
      if (head !== effect.commit || effect.expectedTargetHead !== effect.commit) {
        return this.#terminal(record, "not_committed", null, null);
      }
      const existing = await this.#findPullRequest(context, token, effect, signal);
      if (existing) return this.#terminal(record, "committed", existing.id, existing.url);
      record = await this.#phase(record, "pr_create_sending", "unknown");
      try {
        const response = await this.#api.apiJson({
          method: "POST",
          path: repoPath(context, "/pulls"),
          authorization: token,
          body: {
            title: effect.title,
            body: pullRequestBody(effect),
            head: effect.branch,
            base: effect.baseBranch,
            draft: true,
          },
          accepted: [201],
          ...(signal ? { signal } : {}),
        });
        const pull = pullRequestResponse(response.value, effect);
        return this.#terminal(record, "committed", pull.id, pull.url);
      } catch {
        return this.#observe(record);
      }
    });
  }

  async reconcileEffect(
    effectInput: GitHubExactEffect,
  ): Promise<GitHubBrokerTransportResult> {
    const effect = validateEffect(effectInput);
    return this.#exclusive(effect.effectId, async () => {
      let record = await this.#store.loadEffect(effect.effectId);
      if (!record) {
        const at = this.#now().toISOString();
        record = {
          version: 1,
          effectId: effect.effectId,
          effectDigest: digestCanonical(effect),
          effect,
          phase: "terminal",
          status: "not_committed",
          externalId: null,
          url: null,
          createdAt: at,
          updatedAt: at,
        };
        await this.#store.saveEffect(record);
        return transportResult(record);
      }
      assertSameEffect(record, effect);
      if (terminal(record)) return transportResult(record);
      return this.#observe(record);
    });
  }

  #sessionView(
    record: BrokerInstallationSessionRecord,
    state: string,
  ): GitHubInstallationSession {
    const url = new URL(`https://github.com/apps/${this.#appSlug}/installations/new`);
    url.searchParams.set("state", state);
    return {
      sessionId: record.sessionId,
      ownerWorkspaceKey: record.ownerWorkspaceKey,
      status: "pending",
      authorizationUrl: url.toString(),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }

  #callbackState(ownerWorkspaceKey: string, sessionId: string): string {
    return createHmac("sha256", this.#stateSecret)
      .update(JSON.stringify({ version: 1, ownerWorkspaceKey, sessionId }), "utf8")
      .digest("base64url");
  }

  async #userCanAccessInstallation(
    userToken: string,
    installationId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.#api.apiJson({
        method: "GET",
        path: `/user/installations?per_page=100&page=${page}`,
        authorization: userToken,
        accepted: [200],
        retrySafe: true,
        ...(signal ? { signal } : {}),
      });
      const value = object(response.value, "user installations");
      if (!Array.isArray(value.installations) || value.installations.length > 100) {
        throw new Error("Daftar user installation GitHub tidak sah.");
      }
      if (value.installations.some((item) => String(object(item, "user installation").id) === installationId)) {
        return true;
      }
      if (value.installations.length < 100) return false;
    }
    throw new Error("Pagination user installation GitHub melampaui batas.");
  }

  async #assertInstallationOwner(ownerWorkspaceKey: string, installationId: string): Promise<void> {
    const sessions = await this.#store.listSessions();
    if (!sessions.some((session) => session.ownerWorkspaceKey === ownerWorkspaceKey &&
      session.status === "ready" && session.installationId === installationId)) {
      throw new Error("Installation GitHub tidak terikat owner workspace.");
    }
  }

  async #installationInfo(
    installationId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.#api.apiJson({
      method: "GET",
      path: `/app/installations/${installationId}`,
      authorization: this.#credentials.appJwt(),
      accepted: [200],
      retrySafe: true,
      ...(signal ? { signal } : {}),
    });
    const value = object(response.value, "App installation");
    if (String(value.id) !== installationId || String(value.app_id) !== this.#credentials.appId ||
      value.suspended_at !== null) {
      throw new Error("GitHub App installation tidak aktif atau salah App.");
    }
    return value;
  }

  async #repositoryContext(
    installationId: string,
    repositoryId: string,
    signal?: AbortSignal,
  ): Promise<RepositoryContext> {
    const installation = await this.#installationInfo(installationId, signal);
    const permissions = permissionObject(installation.permissions);
    const token = await this.#credentials.installationToken({
      installationId,
      repositoryId,
      permissions: { metadata: "read" },
      ...(signal ? { signal } : {}),
    });
    const response = await this.#api.apiJson({
      method: "GET",
      path: `/repositories/${repositoryId}`,
      authorization: token,
      accepted: [200],
      retrySafe: true,
      ...(signal ? { signal } : {}),
    });
    const repository = object(response.value, "repository GitHub");
    if (String(repository.id) !== repositoryId) throw new Error("Repository id GitHub berubah.");
    const fullName = repositoryName(repository.full_name);
    const [owner, name] = fullName.split("/") as [string, string];
    const visibility = repository.visibility === "private" || repository.visibility === "internal"
      ? repository.visibility
      : "public";
    const repoPermissions = object(repository.permissions, "repository permissions");
    return {
      installationId,
      repositoryId,
      repositoryFullName: fullName,
      owner,
      name,
      visibility,
      defaultBranch: gitBranch(repository.default_branch),
      archived: repository.archived === true,
      disabled: repository.disabled === true,
      repoCanPush: repoPermissions.push === true,
      permissions,
    };
  }

  async #effectContext(
    effect: GitHubExactEffect,
    requirement: "write" | "pull_request",
    signal?: AbortSignal,
  ): Promise<RepositoryContext> {
    await this.#assertInstallationOwner(effect.ownerWorkspaceKey, effect.installationId);
    const context = await this.#repositoryContext(effect.installationId, effect.repositoryId, signal);
    if (context.defaultBranch !== effect.baseBranch || context.archived || context.disabled ||
      !context.repoCanPush || permissionLevel(context.permissions.contents) < (requirement === "write" ? 2 : 1) ||
      (requirement === "pull_request" && permissionLevel(context.permissions.pull_requests) < 2) ||
      (effect.capability === "github.workflow.write" && permissionLevel(context.permissions.workflows) < 2)) {
      throw new Error("GitHub App permission tidak memenuhi exact effect.");
    }
    return context;
  }

  #effectToken(
    effect: GitHubExactEffect,
    permissions: Readonly<Record<string, "read" | "write">>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.#credentials.installationToken({
      installationId: effect.installationId,
      repositoryId: effect.repositoryId,
      permissions,
      ...(signal ? { signal } : {}),
    });
  }

  async #refHead(
    context: RepositoryContext,
    branch: string,
    token: string,
    allowMissing: boolean,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const response = await this.#api.apiJson({
      method: "GET",
      path: repoPath(context, `/git/ref/heads/${encodedBranch(branch)}`),
      authorization: token,
      accepted: allowMissing ? [200, 404] : [200],
      retrySafe: true,
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) return null;
    return gitRefResponse(response.value).sha;
  }

  async #uploadCommitObjects(
    context: RepositoryContext,
    token: string,
    effect: GitHubExactEffect,
    commit: GitBundleCommit,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const blob of commit.blobs) {
      const response = await this.#api.apiJson({
        method: "POST",
        path: repoPath(context, "/git/blobs"),
        authorization: token,
        body: { content: blob.bytes.toString("base64"), encoding: "base64" },
        accepted: [201],
        ...(signal ? { signal } : {}),
      });
      const value = object(response.value, "GitHub blob receipt");
      if (value.sha !== blob.sha) throw new Error("SHA blob GitHub tidak exact.");
    }
    const treeResponse = await this.#api.apiJson({
      method: "POST",
      path: repoPath(context, "/git/trees"),
      authorization: token,
      body: {
        tree: commit.blobs.map((blob) => ({
          path: blob.path,
          mode: blob.mode,
          type: "blob",
          sha: blob.sha,
        })),
      },
      accepted: [201],
      ...(signal ? { signal } : {}),
    });
    const tree = object(treeResponse.value, "GitHub tree receipt");
    if (tree.sha !== commit.tree) throw new Error("SHA tree GitHub tidak exact.");
    const commitResponse = await this.#api.apiJson({
      method: "POST",
      path: repoPath(context, "/git/commits"),
      authorization: token,
      body: {
        message: commit.message,
        tree: commit.tree,
        parents: [effect.baseCommit],
        author: commit.author,
        committer: commit.committer,
      },
      accepted: [201],
      ...(signal ? { signal } : {}),
    });
    const result = object(commitResponse.value, "GitHub commit receipt");
    if (result.sha !== effect.commit || object(result.tree, "GitHub commit tree").sha !== commit.tree ||
      !Array.isArray(result.parents) || result.parents.length !== 1 ||
      object(result.parents[0], "GitHub commit parent").sha !== effect.baseCommit) {
      throw new Error("SHA/binding commit GitHub tidak exact.");
    }
  }

  async #workflowChanged(
    context: RepositoryContext,
    token: string,
    baseCommit: string,
    commit: GitBundleCommit,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const baseResponse = await this.#api.apiJson({
      method: "GET",
      path: repoPath(context, `/git/commits/${baseCommit}`),
      authorization: token,
      accepted: [200],
      retrySafe: true,
      ...(signal ? { signal } : {}),
    });
    const base = object(baseResponse.value, "GitHub base commit");
    const treeSha = gitHash(object(base.tree, "GitHub base tree").sha, "base tree");
    const treeResponse = await this.#api.apiJson({
      method: "GET",
      path: `${repoPath(context, `/git/trees/${treeSha}`)}?recursive=1`,
      authorization: token,
      accepted: [200],
      retrySafe: true,
      ...(signal ? { signal } : {}),
    });
    const tree = object(treeResponse.value, "GitHub recursive tree");
    if (tree.truncated === true || !Array.isArray(tree.tree) || tree.tree.length > 100_000) {
      throw new Error("GitHub base tree terpotong atau melampaui batas.");
    }
    const previous = new Map<string, string>();
    for (const raw of tree.tree) {
      const entry = object(raw, "GitHub base tree entry");
      if (typeof entry.path !== "string" || typeof entry.sha !== "string" ||
        typeof entry.mode !== "string" || typeof entry.type !== "string") {
        throw new Error("GitHub base tree entry tidak sah.");
      }
      if (WORKFLOW_PATH.test(entry.path) && entry.type === "blob") {
        previous.set(entry.path, `${entry.mode}:${gitHash(entry.sha, "base blob")}`);
      }
    }
    const next = new Map(
      commit.blobs
        .filter((blob) => WORKFLOW_PATH.test(blob.path))
        .map((blob) => [blob.path, `${blob.mode}:${blob.sha}`]),
    );
    if (previous.size !== next.size) return true;
    for (const [path, binding] of previous) {
      if (next.get(path) !== binding) return true;
    }
    return false;
  }

  async #findPullRequest(
    context: RepositoryContext,
    token: string,
    effect: GitHubExactEffect,
    signal?: AbortSignal,
  ): Promise<{ id: string; url: string } | null> {
    const query = new URLSearchParams({
      state: "all",
      head: `${context.owner}:${effect.branch}`,
      base: effect.baseBranch,
      per_page: "100",
    });
    const response = await this.#api.apiJson({
      method: "GET",
      path: `${repoPath(context, "/pulls")}?${query}`,
      authorization: token,
      accepted: [200],
      retrySafe: true,
      ...(signal ? { signal } : {}),
    });
    if (!Array.isArray(response.value) || response.value.length > 100) {
      throw new Error("Daftar pull request GitHub tidak sah.");
    }
    for (const raw of response.value) {
      const value = object(raw, "GitHub pull request");
      if (typeof value.body === "string" && value.body.includes(effectMarker(effect.effectId))) {
        return pullRequestResponse(value, effect);
      }
    }
    return null;
  }

  async #execute(
    effect: GitHubExactEffect,
    operation: (record: BrokerEffectRecord) => Promise<GitHubBrokerTransportResult>,
  ): Promise<GitHubBrokerTransportResult> {
    return this.#exclusive(effect.effectId, async () => {
      let record = await this.#store.loadEffect(effect.effectId);
      if (record) {
        assertSameEffect(record, effect);
        if (terminal(record) || record.status === "unknown") return transportResult(record);
      } else {
        const at = this.#now().toISOString();
        record = {
          version: 1,
          effectId: effect.effectId,
          effectDigest: digestCanonical(effect),
          effect,
          phase: "admitted",
          status: "pending",
          externalId: null,
          url: null,
          createdAt: at,
          updatedAt: at,
        };
        await this.#store.saveEffect(record);
      }
      try {
        return await operation(record);
      } catch {
        const latest = await this.#store.loadEffect(effect.effectId) ?? record;
        if (latest.phase === "admitted" || latest.phase === "objects_uploading") {
          return this.#terminal(latest, "not_committed", null, null);
        }
        return transportResult(await this.#phase(latest, latest.phase, "unknown"));
      }
    });
  }

  async #observe(record: BrokerEffectRecord): Promise<GitHubBrokerTransportResult> {
    if (terminal(record)) return transportResult(record);
    const effect = record.effect;
    try {
      const context = await this.#repositoryContext(effect.installationId, effect.repositoryId);
      if (effect.capability === "github.pr.create") {
        const token = await this.#effectToken(effect, {
          contents: "read", metadata: "read", pull_requests: "write",
        });
        const pull = await this.#findPullRequest(context, token, effect);
        if (pull) return this.#terminal(record, "committed", pull.id, pull.url);
        if (record.phase !== "pr_create_sending") {
          return this.#terminal(record, "not_committed", null, null);
        }
        return transportResult(await this.#phase(record, record.phase, "unknown"));
      }
      const token = await this.#effectToken(effect, { contents: "read", metadata: "read" });
      const head = await this.#refHead(context, effect.branch, token, true);
      const expected = effect.capability === "github.branch.create" ? effect.baseCommit : effect.commit;
      if (head === expected) {
        return this.#terminal(
          record,
          "committed",
          null,
          effect.capability === "github.branch.create"
            ? branchUrl(context, effect.branch)
            : commitUrl(context, effect.commit),
        );
      }
      if (record.phase !== "ref_update_sending") {
        return this.#terminal(record, "not_committed", null, null);
      }
      return transportResult(await this.#phase(record, record.phase, "unknown"));
    } catch {
      return transportResult(await this.#phase(record, record.phase, "unknown"));
    }
  }

  async #phase(
    record: BrokerEffectRecord,
    phase: BrokerEffectRecord["phase"],
    status: BrokerEffectRecord["status"],
  ): Promise<BrokerEffectRecord> {
    const next = { ...record, phase, status, updatedAt: this.#now().toISOString() };
    await this.#store.saveEffect(next);
    return next;
  }

  async #terminal(
    record: BrokerEffectRecord,
    status: "committed" | "not_committed",
    externalId: string | null,
    url: string | null,
  ): Promise<GitHubBrokerTransportResult> {
    const next: BrokerEffectRecord = {
      ...record,
      phase: "terminal",
      status,
      externalId: status === "committed" ? externalId : null,
      url: status === "committed" ? url : null,
      updatedAt: this.#now().toISOString(),
    };
    await this.#store.saveEffect(next);
    return transportResult(next);
  }

  async #verifyArchive(reference: GitHubRepositoryArchiveReference): Promise<void> {
    const record = await this.#store.loadArchive(reference.operationId);
    if (!record || JSON.stringify(record.reference) !== JSON.stringify(reference)) {
      throw new Error("Record archive GitHub tidak exact.");
    }
    const path = this.#store.archivePath(record.relativePath);
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink() || state.size !== reference.size ||
      digest(await readFile(path)) !== reference.sha256) {
      throw new Error("Artifact archive GitHub rusak.");
    }
  }

  async #exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(() => undefined, () => undefined);
    this.#queues.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
  }
}

export async function* openBrokerFile(path: string): AsyncGenerator<Uint8Array> {
  for await (const chunk of createReadStream(path)) yield Buffer.from(chunk as Buffer);
}

async function spoolUpload(
  path: string,
  content: AsyncIterable<Uint8Array>,
  descriptor: LocalGitObjectBundleReference,
  signal?: AbortSignal,
): Promise<void> {
  if (descriptor.size > MAX_BUNDLE_BYTES) throw new Error("Object bundle GitHub melampaui batas.");
  const handle = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const raw of content) {
      if (signal?.aborted) throw abortError();
      if (!(raw instanceof Uint8Array) || raw.byteLength < 1) throw new Error("Chunk object bundle tidak sah.");
      const chunk = Buffer.from(raw);
      size += chunk.byteLength;
      if (size > descriptor.size) throw new Error("Object bundle GitHub melampaui descriptor.");
      hash.update(chunk);
      await handle.write(chunk, 0, chunk.byteLength, size - chunk.byteLength);
    }
    if (size !== descriptor.size || hash.digest("hex") !== descriptor.sha256) {
      throw new Error("Object bundle GitHub tidak cocok descriptor.");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateEffect(
  input: GitHubExactEffect,
  expected?: GitHubExactEffect["capability"] | readonly GitHubExactEffect["capability"][],
): GitHubExactEffect {
  const effect = structuredClone(input);
  const keys = [
    "effectId", "attempt", "capability", "projectId", "runId", "ownerWorkspaceKey",
    "installationConnectionId", "repositoryBindingId", "installationId", "repositoryId",
    "workspaceRevision", "instructionRevision", "branch", "commit", "baseCommit",
    "expectedTargetHead", "baseBranch", "title", "body", "draft", "objectBundle",
  ];
  exactKeys(effect, keys, "GitHub exact effect");
  const expectedList = expected === undefined ? null : Array.isArray(expected) ? expected : [expected];
  if (expectedList && !expectedList.includes(effect.capability)) throw new Error("Capability endpoint GitHub tidak cocok.");
  if (!["github.branch.create", "github.push_branch", "github.workflow.write", "github.pr.create"]
    .includes(effect.capability) || !Number.isSafeInteger(effect.attempt) || effect.attempt < 1 ||
    !Number.isSafeInteger(effect.workspaceRevision) || effect.workspaceRevision < 1 ||
    !Number.isSafeInteger(effect.instructionRevision) || effect.instructionRevision < 0 ||
    !safeTextValue(effect.effectId, 512) || !safeTextValue(effect.projectId, 512) ||
    !safeTextValue(effect.runId, 512) || !safeTextValue(effect.ownerWorkspaceKey, 256) ||
    !safeTextValue(effect.installationConnectionId, 512) || !safeTextValue(effect.repositoryBindingId, 512)) {
    throw new Error("Metadata exact effect GitHub tidak sah.");
  }
  numericId(effect.installationId, "installation id");
  numericId(effect.repositoryId, "repository id");
  effect.branch = publishBranch(effect.branch, effect.baseBranch);
  effect.baseBranch = gitBranch(effect.baseBranch);
  effect.commit = gitHash(effect.commit, "commit");
  effect.baseCommit = gitHash(effect.baseCommit, "base commit");
  if (effect.expectedTargetHead !== null) gitHash(effect.expectedTargetHead, "expected target head");
  const push = effect.capability === "github.push_branch" || effect.capability === "github.workflow.write";
  const pr = effect.capability === "github.pr.create";
  if ((push && !effect.objectBundle) || (!push && effect.objectBundle !== null) ||
    (effect.capability === "github.branch.create" && effect.expectedTargetHead !== null) ||
    (push && effect.expectedTargetHead !== effect.baseCommit) ||
    (pr && (effect.draft !== true || effect.expectedTargetHead !== effect.commit ||
      typeof effect.title !== "string" || effect.title.length < 1 || effect.title.length > 256 ||
      (effect.body !== null && (typeof effect.body !== "string" || effect.body.length > 16_000)))) ||
    (!pr && (effect.title !== null || effect.body !== null || effect.draft !== null))) {
    throw new Error("Shape capability exact effect GitHub tidak sah.");
  }
  if (effect.objectBundle) {
    const bundle = validateLocalGitObjectBundleReference(effect.objectBundle);
    if (bundle.commit !== effect.commit || bundle.parentCommit !== effect.expectedTargetHead) {
      throw new Error("Object bundle GitHub tidak mengikat exact commit/parent.");
    }
  }
  if (containsSecretLikeValue(JSON.stringify(effect))) throw new Error("Exact effect GitHub memuat credential.");
  const { effectId: _effectId, ...semantic } = effect;
  const deterministicId = `github-effect-${createHash("sha256")
    .update(canonicalJson(semantic), "utf8")
    .digest("hex")}`;
  if (effect.effectId !== deterministicId) throw new Error("GitHub effectId tidak deterministik.");
  return effect;
}

function validateArchiveReference(input: GitHubRepositoryArchiveReference): GitHubRepositoryArchiveReference {
  const value = structuredClone(input);
  exactKeys(value, [
    "version", "operationId", "archiveId", "ownerWorkspaceKey", "installationId", "repositoryId",
    "repositoryFullName", "defaultBranch", "commit", "mediaType", "sha256", "size", "createdAt", "expiresAt",
  ], "archive reference");
  if (value.version !== 1 || value.mediaType !== "application/zip" || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.size) || value.size < 1 || value.size > 128 * 1024 * 1024 ||
    !validIso(value.createdAt) || !validIso(value.expiresAt)) throw new Error("Archive reference tidak sah.");
  return value;
}

function repositorySummary(value: unknown, installationId: string): GitHubRepositorySummary {
  const repository = object(value, "repository summary");
  return {
    installationId,
    repositoryId: numericId(repository.id, "repository id"),
    repositoryFullName: repositoryName(repository.full_name),
    visibility: repository.visibility === "private" || repository.visibility === "internal"
      ? repository.visibility
      : "public",
    defaultBranch: gitBranch(repository.default_branch),
  };
}

function permissionObject(value: unknown): Record<string, string> {
  const raw = object(value, "installation permissions");
  const result: Record<string, string> = {};
  for (const [key, level] of Object.entries(raw)) {
    if (!/^[a-z_]{1,64}$/u.test(key) || (level !== "read" && level !== "write")) {
      throw new Error("Permission GitHub installation tidak sah.");
    }
    result[key] = level;
  }
  return result;
}

function permissionLevel(value: string | undefined): number {
  return value === "write" ? 2 : value === "read" ? 1 : 0;
}

function gitRefResponse(value: unknown): { ref: string; sha: string } {
  const ref = object(value, "GitHub ref receipt");
  const target = object(ref.object, "GitHub ref object");
  if (typeof ref.ref !== "string") throw new Error("GitHub ref receipt tidak sah.");
  return { ref: ref.ref, sha: gitHash(target.sha, "ref sha") };
}

function pullRequestResponse(
  valueInput: unknown,
  effect: GitHubExactEffect,
): { id: string; url: string } {
  const value = object(valueInput, "GitHub pull request receipt");
  const head = object(value.head, "GitHub pull request head");
  const base = object(value.base, "GitHub pull request base");
  if (value.draft !== true || head.sha !== effect.commit || base.ref !== effect.baseBranch ||
    typeof value.html_url !== "string" || !safeGitHubUrl(value.html_url)) {
    throw new Error("GitHub draft pull request receipt tidak exact.");
  }
  return { id: numericId(value.id, "pull request id"), url: value.html_url };
}

function pullRequestBody(effect: GitHubExactEffect): string {
  return `${effect.body ?? ""}${effect.body ? "\n\n" : ""}${effectMarker(effect.effectId)}`;
}

function effectMarker(effectId: string): string {
  const digestValue = createHash("sha256").update(effectId, "utf8").digest("hex");
  return `<!-- harvy-effect:${digestValue} -->`;
}

function transportResult(record: BrokerEffectRecord): GitHubBrokerTransportResult {
  const completedAt = record.updatedAt;
  if (record.status === "committed") {
    return {
      effectId: record.effectId,
      status: "committed",
      operationFenced: true,
      externalId: record.externalId,
      url: record.url,
      completedAt,
    };
  }
  if (record.status === "not_committed") {
    return {
      effectId: record.effectId,
      status: "not_committed",
      operationFenced: true,
      externalId: null,
      url: null,
      completedAt,
    };
  }
  return {
    effectId: record.effectId,
    status: "unknown",
    operationFenced: false,
    externalId: null,
    url: null,
    completedAt,
  };
}

function terminal(record: BrokerEffectRecord): boolean {
  return record.status === "committed" || record.status === "not_committed";
}

function assertSameEffect(record: BrokerEffectRecord, effect: GitHubExactEffect): void {
  if (record.effectDigest !== digestCanonical(effect) || JSON.stringify(record.effect) !== JSON.stringify(effect)) {
    throw new Error("GitHub effectId digunakan untuk payload berbeda.");
  }
}

function repoPath(context: RepositoryContext, suffix: string): string {
  if (!suffix.startsWith("/")) throw new Error("Suffix repository API tidak sah.");
  return `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}${suffix}`;
}

function encodedBranch(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function branchUrl(context: RepositoryContext, branch: string): string {
  return `https://github.com/${context.repositoryFullName}/tree/${encodedBranch(branch)}`;
}

function commitUrl(context: RepositoryContext, commit: string): string {
  return `https://github.com/${context.repositoryFullName}/commit/${commit}`;
}

function encodeCursor(page: number): string {
  return Buffer.from(JSON.stringify({ version: 1, page }), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): number {
  if (value === null) return 1;
  if (!/^[A-Za-z0-9_-]{3,512}$/u.test(value)) throw new Error("Cursor GitHub tidak sah.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const item = object(parsed, "repository cursor");
    exactKeys(item, ["version", "page"], "repository cursor");
    if (item.version !== 1 || !Number.isSafeInteger(item.page) || (item.page as number) < 2 ||
      (item.page as number) > 10_000) throw new Error("Cursor GitHub tidak sah.");
    return item.page as number;
  } catch {
    throw new Error("Cursor GitHub tidak sah.");
  }
}

function callbackUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("GitHub callback URL tidak sah."); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username || url.password || url.hash || url.search || url.pathname !== "/v1/github-app/callback") {
    throw new Error("GitHub callback URL tidak aman atau path salah.");
  }
  return url.toString();
}

function appSlug(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(value)) {
    throw new Error("GitHub App slug tidak sah.");
  }
  return value;
}

function callbackValue(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 4 || value.length > maximum || !/^[A-Za-z0-9_.~-]+$/u.test(value)) {
    throw new Error(`GitHub callback ${label} tidak sah.`);
  }
  return value;
}

function numericId(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d{1,20}$/u.test(String(value)) ||
    BigInt(String(value)) < 1n) throw new Error(`${label} GitHub tidak sah.`);
  return String(value);
}

function repositoryName(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || !/^[^/\s]+\/[^/\s]+$/u.test(value)) {
    throw new Error("Nama repository GitHub tidak sah.");
  }
  return value;
}

function publishBranch(value: unknown, base: unknown): string {
  const branch = gitBranch(value);
  const baseBranch = gitBranch(base);
  if (!branch.startsWith("harvy/") || branch === baseBranch) throw new Error("Publish branch GitHub wajib harvy/*.");
  return branch;
}

function gitBranch(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 244 || value.startsWith("-") ||
    value.startsWith(".") || value.endsWith(".") || value.endsWith("/") || value.includes("..") ||
    value.includes("//") || /[~^:?*[\\\s\x00-\x1f\x7f]/u.test(value) || value.endsWith(".lock")) {
    throw new Error("Branch GitHub tidak sah.");
  }
  return value;
}

function gitHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) throw new Error(`${label} GitHub tidak sah.`);
  return value;
}

function safeText(value: unknown, label: string, maximum: number): string {
  if (!safeTextValue(value, maximum) || containsSecretLikeValue(value)) throw new Error(`${label} GitHub tidak sah.`);
  return value;
}

function safeTextValue(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\r\n\0]/u.test(value);
}

function duration(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} tidak sah.`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} bukan object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} memuat field asing atau hilang.`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function validIso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function safeGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function safeReason(error: unknown): string {
  if (error instanceof GitHubApiError) return `${error.code}_${error.status}`.slice(0, 512);
  return error instanceof Error && /^[A-Z0-9_ -]{3,512}$/u.test(error.message)
    ? error.message
    : "GITHUB_BROKER_UNAVAILABLE";
}

function abortError(): Error {
  const error = new Error("Operasi GitHub dibatalkan.");
  error.name = "AbortError";
  return error;
}
