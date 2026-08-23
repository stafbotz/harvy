import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { CodingTaskReviewInput, CodingValidatorPolicy } from
  "../src/coding/coding-validators.js";
import {
  CodingRunCoordinator,
  type CodingWorkerAction,
  type CodingWorkerDriver,
  type CodingWorkerInput,
} from
  "../src/core/coding-run-coordinator.js";
import { CodingRunEngine } from "../src/core/coding-run-engine.js";
import { CodingRunProgressHub } from "../src/core/coding-run-progress-hub.js";
import { CodingRunScheduler } from "../src/core/coding-run-scheduler.js";
import { LocalGitService } from "../src/core/local-git-service.js";
import { PrivateCodingApplication } from "../src/core/private-coding-application.js";
import { ProjectWorkspaceService } from "../src/core/project-workspace-service.js";
import { TrustedWorkspaceActorRegistry } from
  "../src/core/trusted-workspace-actor-registry.js";
import { WorkspaceAuthorityService, workspacePrincipal } from
  "../src/core/workspace-authority-service.js";
import { WorkspaceCodingController } from "../src/core/workspace-coding-controller.js";
import type {
  SandboxArtifactReference,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxHealth,
  SandboxInputSnapshotSource,
  SandboxLease,
  SandboxRunner,
  SandboxSnapshotResult,
} from "../src/domain/sandbox.js";
import { FileCodingEvidenceStore } from "../src/storage/file-coding-evidence-store.js";
import { FileCodingRunRepository } from "../src/storage/file-coding-run-repository.js";
import { FilePrivateCodingSessionStore } from
  "../src/storage/file-private-coding-session-store.js";
import { FileProjectWorkspaceRepository } from
  "../src/storage/file-project-workspace-repository.js";
import { FileWorkspaceRepository } from "../src/storage/file-workspace-repository.js";
import { FileGroupCodingRepository } from
  "../src/storage/file-group-coding-repository.js";
import { groupScopeKey } from "../src/domain/group.js";
import { LocalGitBackend } from "../src/local-git/local-git-backend.js";
import { LocalGitServiceHandler } from "../src/local-git/local-git-service-handler.js";
import { HmacTrustDomainRequestProofProvider } from
  "../src/transport/trust-domain-http.js";
import { TrustDomainHttpServer } from "../src/transport/trust-domain-http-server.js";
import { HttpLocalGitTransport } from "../src/transport/http-local-git-transport.js";
import { buildZip } from "./zip-test-fixture.js";

const NOW = new Date("2026-08-15T10:00:00.000Z");
const roots: string[] = [];
const servers: TrustDomainHttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PrivateCodingApplication end-to-end", () => {
  it("upload ZIP → map/plan/read/edit/test/review → snapshot → exact Git commit", async () => {
    const fixture = await createFixture(new DeterministicWorker());
    const selected = await fixture.application.uploadZip(fixture.actor, projectZip());
    const updates: string[] = [];
    const handle = await fixture.application.startCoding(
      fixture.actor,
      "Ubah nilai export menjadi 2",
      (run) => { updates.push(`${run.phase}:${run.stateRevision}`); },
    );
    const outcome = await handle.completion;

    assert.equal(outcome.run.status, "completed");
    assert.equal(outcome.stoppedReason, null);
    assert.ok(outcome.localCommit);
    assert.match(outcome.localCommit.commit, /^[a-f0-9]{40}$/u);
    assert.notEqual(outcome.localCommit.commit, outcome.localCommit.parentCommit);
    assert.match(outcome.localCommit.branch, /^harvy\//u);
    assert.equal(outcome.localCommit.objectBundle.commit, outcome.localCommit.commit);
    assert.ok(updates.some((entry) => entry.startsWith("editing:")));
    assert.ok(updates.some((entry) => entry.startsWith("completed:")));

    const current = await fixture.application.current(fixture.actor);
    assert.equal(current.selection.foregroundRunId, null);
    assert.equal(current.selection.projectId, selected.project.id);
    assert.equal(current.selection.projectRevision, outcome.projectRevision);
    const content = await snapshotFile(
      fixture.projects,
      fixture.scopeFor(selected.workspaceKey!),
      selected.project.id,
      outcome.projectRevision!,
      "src/index.ts",
    );
    assert.equal(content, "export const value = 2;\n");
    const scope = await fixture.scopeFor(selected.workspaceKey!);
    const log = await fixture.localGit.log(
      scope,
      selected.project.id,
      outcome.projectRevision!,
      20,
    );
    assert.equal(log[0]?.commit, outcome.localCommit.commit);
    await fixture.stop();
  });

  it("membuang action revision lama dan hanya commit constraint mid-run terbaru", async () => {
    const gate = deferred<void>();
    const patchStarted = deferred<void>();
    const worker = new DeterministicWorker({ gate: gate.promise, patchStarted });
    const fixture = await createFixture(worker);
    const selected = await fixture.application.uploadZip(fixture.actor, projectZip());
    const initial = await fixture.application.startCoding(
      fixture.actor,
      "Ubah nilai export menjadi 2",
    );
    await patchStarted.promise;
    const revised = await fixture.application.revise(fixture.actor, {
      sourceMessageId: "telegram-correction-1",
      kind: "correction",
      content: "Koreksi: nilai akhirnya harus 3 dan public API tetap sama",
    });
    gate.resolve();
    const outcome = await revised.completion;

    assert.equal(initial.runId, revised.runId);
    assert.equal(outcome.run.status, "completed");
    assert.equal(outcome.run.instructionRevision, 1);
    assert.equal(outcome.run.appliedInstructionRevision, 1);
    assert.equal(outcome.run.constraints.at(-1)?.content,
      "Koreksi: nilai akhirnya harus 3 dan public API tetap sama");
    assert.ok(outcome.localCommit);
    const content = await snapshotFile(
      fixture.projects,
      fixture.scopeFor(selected.workspaceKey!),
      selected.project.id,
      outcome.projectRevision!,
      "src/index.ts",
    );
    assert.equal(content, "export const value = 3;\n");
    assert.equal(outcome.run.diff?.files.length, 1);
    await fixture.stop();
  });

  it("menjaga pertanyaan waiting_input durable dan hanya melanjutkan lewat revision terikat", async () => {
    const fixture = await createFixture(new WaitingThenDeterministicWorker());
    await fixture.application.uploadZip(fixture.actor, projectZip());
    const waitingHandle = await fixture.application.startCoding(
      fixture.actor,
      "Ubah nilai export setelah memastikan kontrak API",
    );
    const waiting = await waitingHandle.completion;

    assert.equal(waiting.run.status, "waiting_input");
    assert.equal(waiting.localCommit, null);
    assert.equal(waiting.stoppedReason, "public_api_confirmation");
    assert.equal(
      waiting.run.pendingQuestion?.prompt,
      "Apakah public API harus tetap dipertahankan?",
    );
    assert.match(waiting.anchor.text, /Apakah public API harus tetap dipertahankan\?/u);
    const current = await fixture.application.current(fixture.actor);
    assert.equal(current.selection.foregroundRunId, waiting.run.runId);
    assert.equal(current.run?.status, "waiting_input");

    const resumed = await fixture.application.revise(fixture.actor, {
      sourceMessageId: "telegram:reply-to-coding-anchor-1",
      kind: "constraint",
      content: "Ya, public API harus tetap sama.",
    });
    const outcome = await resumed.completion;
    assert.equal(resumed.runId, waiting.run.runId);
    assert.equal(outcome.run.status, "completed");
    assert.equal(outcome.run.instructionRevision, 1);
    assert.equal(outcome.run.pendingQuestion, null);
    assert.ok(outcome.localCommit);
    await fixture.stop();
  });

  it("cancel selama validator sandbox mem-fence run dan tidak membuat local commit", async () => {
    const executionGate = deferred<void>();
    const executionStarted = deferred<void>();
    const sandbox = new PassingSandbox({
      executionGate: executionGate.promise,
      executionStarted,
    });
    const fixture = await createFixture(new DeterministicWorker(), sandbox);
    const selected = await fixture.application.uploadZip(fixture.actor, projectZip());
    const handle = await fixture.application.startCoding(
      fixture.actor,
      "Ubah nilai export menjadi 2",
    );
    await executionStarted.promise;
    const cancelled = await fixture.application.cancel(fixture.actor);
    executionGate.resolve();
    const outcome = await handle.completion;

    assert.equal(cancelled.status, "cancelled");
    assert.equal(outcome.run.status, "cancelled");
    assert.equal(outcome.localCommit, null);
    assert.equal(outcome.projectRevision, null);
    const current = await fixture.application.current(fixture.actor);
    assert.equal(current.selection.foregroundRunId, null);
    assert.equal(current.selection.projectRevision, selected.project.revision);
    await fixture.stop();
  });

  it("owner WhatsApp privat menyetujui exact request link untuk principal grup", async () => {
    const fixture = await createFixture(new DeterministicWorker());
    const whatsappOwner = fixture.actors.issue({
      principal: workspacePrincipal(
        "private-coding-e2e-principal-secret-32",
        "whatsapp",
        "private-coding-owner-wa",
      ),
      interactionId: "whatsapp-private-e2e",
      audience: "workspace-private",
    });
    const selected = await fixture.application.createWorkspace(
      whatsappOwner,
      "Workspace lintas kanal",
    );
    const whatsappPrincipal = workspacePrincipal(
      "private-coding-e2e-principal-secret-32",
      "whatsapp",
      "group-admin-wa",
    );
    const requestId = "group-link-request-private-e2e";
    const scope = { channel: "whatsapp" as const, groupId: "coding@g.us" };
    assert.equal((await fixture.groupRepository.saveLinkRequest({
      version: 1,
      requestId,
      scopeKey: groupScopeKey(scope),
      scope,
      accountId: "account-a",
      groupJoinedAt: "2026-08-15T09:00:00.000Z",
      participantPrincipal: whatsappPrincipal,
      requestedByParticipantId: "group-admin-wa",
      requestedAtAuthorityEpoch: 7,
      status: "pending",
      workspaceKey: null,
      grantedMembershipId: null,
      approvedByMembershipId: null,
      approvedAclEpoch: null,
      createdAt: NOW.toISOString(),
      expiresAt: "2026-08-15T10:15:00.000Z",
      approvedAt: null,
      consumedAt: null,
      revokedAt: null,
      updatedAt: NOW.toISOString(),
    }, null)).status, "saved");

    assert.deepEqual(
      await fixture.application.confirmGroupWorkspaceLink(whatsappOwner, requestId),
      { status: "approved", role: "admin" },
    );
    const membership = await fixture.authority.resolveScope(
      selected.workspaceKey!,
      whatsappPrincipal,
    );
    assert.equal(membership?.role, "admin");
    const request = await fixture.groupRepository.loadLinkRequest(requestId);
    assert.equal(request?.status, "approved");
    assert.equal(request?.workspaceKey, selected.workspaceKey);
    assert.equal(request?.grantedMembershipId, membership?.membershipId);
    assert.equal(request?.approvedAclEpoch, membership?.aclEpoch);
    assert.deepEqual(
      await fixture.application.confirmGroupWorkspaceLink(whatsappOwner, requestId),
      { status: "already-approved", role: "admin" },
    );
    await fixture.stop();
  });
});

async function createFixture(
  worker: CodingWorkerDriver,
  sandbox: PassingSandbox = new PassingSandbox(),
) {
  const root = await mkdtemp(join(tmpdir(), "harvy-private-coding-e2e-"));
  roots.push(root);
  const now = () => NOW;
  const actorPrincipal = workspacePrincipal(
    "private-coding-e2e-principal-secret-32",
    "telegram",
    "private-coding-owner",
  );
  const actors = new TrustedWorkspaceActorRegistry();
  const actor = actors.issue({
    principal: actorPrincipal,
    interactionId: "telegram-private-e2e",
    audience: "workspace-private",
  });
  const authority = new WorkspaceAuthorityService(
    new FileWorkspaceRepository(join(root, "workspaces.json")),
    now,
    randomUUID,
  );
  const projects = new ProjectWorkspaceService(
    new FileProjectWorkspaceRepository(join(root, "projects.json")),
    authority,
    { root: join(root, "project-storage"), processRoot: process.cwd() },
    undefined,
    now,
    randomUUID,
  );
  const policy = validatorPolicy();
  const runs = new CodingRunEngine(
    new FileCodingRunRepository(join(root, "coding-runs.json")),
    projects,
    sandbox,
    policy,
    { evidenceStore: new FileCodingEvidenceStore(join(root, "evidence")) },
    now,
    randomUUID,
  );
  const progress = new CodingRunProgressHub();
  const coordinator = new CodingRunCoordinator(runs, worker, {
    onProgress: (run) => progress.report(run),
  });
  const scheduler = new CodingRunScheduler(
    coordinator,
    runs,
    {},
    {
      version: 1,
      serviceIdentityDigest: "1".repeat(64),
      runtimeImageDigest: "2".repeat(64),
      policyDigest: "3".repeat(64),
      suiteDigest: "4".repeat(64),
      verifiedAt: "2026-08-15T09:00:00.000Z",
      expiresAt: "2026-08-16T09:00:00.000Z",
    },
    now,
    { verify() {} },
  );
  scheduler.start();
  const backend = new LocalGitBackend({
    dataRoot: join(root, "local-git"),
    gitCommand: "git",
    commandEnvironment: { PATH: process.env.PATH ?? "", HOME: root },
    serviceEnvironment: {},
    now,
  });
  await backend.initialize();
  assert.equal((await backend.health()).available, true);
  const secret = randomBytes(32);
  const server = new TrustDomainHttpServer({
    protocol: "harvy-local-git/1",
    host: "127.0.0.1",
    port: 0,
    identities: [{ keyId: "private-e2e", secret }],
    handler: new LocalGitServiceHandler(backend),
  });
  servers.push(server);
  const address = await server.start();
  const transport = new HttpLocalGitTransport({
    origin: address.origin,
    allowInsecureLoopback: true,
    proofProvider: new HmacTrustDomainRequestProofProvider("private-e2e", secret),
  });
  const localGit = new LocalGitService(projects, transport, authority);
  const groupRepository = new FileGroupCodingRepository(
    join(root, "group-coding.json"),
  );
  const controller = new WorkspaceCodingController(authority, actors, projects, runs);
  const application = new PrivateCodingApplication(
    actors,
    controller,
    authority,
    projects,
    runs,
    scheduler,
    localGit,
    new FilePrivateCodingSessionStore(join(root, "private-sessions.json")),
    progress,
    now,
    groupRepository,
  );
  application.start();
  return {
    actor,
    actors,
    application,
    projects,
    localGit,
    authority,
    groupRepository,
    scopeFor(workspaceKey: string) {
      return authority.resolveScope(workspaceKey, actorPrincipal).then((scope) => {
        if (!scope) throw new Error("scope fixture hilang");
        return scope;
      });
    },
    async stop() {
      application.stop();
      scheduler.stop();
      await Promise.all([application.drain(), scheduler.drain()]);
    },
  };
}

class DeterministicWorker implements CodingWorkerDriver {
  private gated = false;

  constructor(private readonly options: {
    gate?: Promise<void>;
    patchStarted?: Deferred<void>;
  } = {}) {}

  async next(input: CodingWorkerInput) {
    const run = input.run;
    if (!run.plan) {
      return {
        kind: "plan" as const,
        steps: [
          { stage: "inspect" as const, description: "Inspect source", paths: ["src/index.ts"] },
          { stage: "edit" as const, description: "Update exported value", paths: ["src/index.ts"] },
          { stage: "test" as const, description: "Run tests", paths: [] },
          { stage: "review" as const, description: "Review exact diff", paths: [] },
        ],
      };
    }
    if (!run.diff) {
      if (input.previousObservation?.kind !== "workspace.read") {
        return { kind: "read" as const, path: "src/index.ts" };
      }
      if (this.options.gate && !this.gated) {
        this.gated = true;
        this.options.patchStarted?.resolve();
        await this.options.gate;
      }
      const payload = input.previousObservation.payload as { sha256?: unknown };
      if (typeof payload.sha256 !== "string") throw new Error("read sha fixture hilang");
      const corrected = run.constraints.some((constraint) => /nilai akhirnya harus 3/iu.test(
        constraint.content,
      ));
      return {
        kind: "apply_patch" as const,
        operations: [{
          kind: "update" as const,
          path: "src/index.ts",
          expectedSha256: payload.sha256,
          content: `export const value = ${corrected ? 3 : 2};\n`,
        }],
      };
    }
    if (!run.validators.some((receipt) => receipt.kind === "test" && receipt.status === "passed")) {
      return { kind: "validator" as const, validator: "test" as const };
    }
    if (!run.taskReviews.some((receipt) => receipt.status === "approved")) {
      return { kind: "task_review" as const };
    }
    return { kind: "finalize" as const };
  }
}

class WaitingThenDeterministicWorker implements CodingWorkerDriver {
  private waitingIssued = false;
  private readonly delegate = new DeterministicWorker();

  async next(input: CodingWorkerInput): Promise<CodingWorkerAction> {
    if (!this.waitingIssued) {
      this.waitingIssued = true;
      return {
        kind: "yield" as const,
        reasonCode: "public_api_confirmation",
        question: "Apakah public API harus tetap dipertahankan?",
      };
    }
    return this.delegate.next(input);
  }
}

class PassingSandbox implements SandboxRunner {
  private sequence = 0;

  constructor(private readonly options: {
    executionGate?: Promise<void>;
    executionStarted?: Deferred<void>;
  } = {}) {}

  async health(): Promise<SandboxHealth> {
    return {
      available: true,
      runtime: "isolated-linux",
      identity: {
        serviceIdentityDigest: "1".repeat(64),
        runtimeImageDigest: "2".repeat(64),
        policyDigest: "3".repeat(64),
      },
      checkedAt: NOW.toISOString(),
      reason: null,
    };
  }

  async allocate(
    binding: SandboxLease["binding"],
    _snapshot: SandboxInputSnapshotSource,
  ): Promise<SandboxLease> {
    this.sequence += 1;
    return {
      leaseId: `private-e2e-lease-${this.sequence}`,
      binding: structuredClone(binding),
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
        limits: {
          cpuCores: 1,
          memoryBytes: 128 * 1024 * 1024,
          diskBytes: 32 * 1024 * 1024,
          pids: 32,
          wallClockMs: 30_000,
          maxOutputBytes: 64 * 1024,
          maxArtifacts: 8,
          maxArtifactBytes: 1024 * 1024,
        },
      },
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    };
  }

  async execute(
    lease: SandboxLease,
    _request: SandboxExecRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    this.options.executionStarted?.resolve();
    if (this.options.executionGate) {
      await Promise.race([
        this.options.executionGate,
        new Promise<never>((_resolve, reject) => {
          const abort = () => {
            const error = new Error("fixture sandbox dibatalkan");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    }
    const output = "tests passed\n";
    return {
      operationId: `private-e2e-operation-${this.sequence}`,
      requestDigest: "a".repeat(64),
      executionId: `private-e2e-execution-${this.sequence}`,
      leaseId: lease.leaseId,
      status: "exited",
      exitCode: 0,
      signal: null,
      stdout: output,
      stderr: "",
      truncated: false,
      artifacts: [],
      usage: {
        wallClockMs: 10,
        peakMemoryBytes: 1024,
        cpuTimeMs: 5,
        outputBytes: Buffer.byteLength(output),
      },
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
    };
  }

  async captureSnapshot(lease: SandboxLease): Promise<SandboxSnapshotResult> {
    return {
      leaseId: lease.leaseId,
      sourceWorkspaceRevision: lease.binding.workspaceRevision,
      snapshot: {
        artifactId: `sandbox-workspace-snapshot-${"b".repeat(64)}`,
        sha256: "b".repeat(64),
        size: 1,
        mediaType: "application/octet-stream",
        purpose: "workspace-snapshot",
      },
      createdAt: NOW.toISOString(),
    };
  }

  async readArtifact(
    _lease: SandboxLease,
    _artifact: SandboxArtifactReference,
  ): Promise<Uint8Array> {
    throw new Error("fixture tidak menerbitkan artifact");
  }
  async dispose(): Promise<void> {}
  async fenceProjectRuns(): Promise<void> {}
}

function validatorPolicy(): CodingValidatorPolicy {
  return {
    taskReviewer: { id: "private-e2e-reviewer", version: "1" },
    async commandsFor() {
      return [{
        kind: "test",
        argv: ["npm", "test"],
        cwd: ".",
        purpose: "test",
        timeoutMs: 30_000,
        required: true,
      }];
    },
    async reviewTask(input: CodingTaskReviewInput) {
      await input.workspace.read({ path: "src/index.ts" });
      return {
        decision: "approved",
        requirementEvidence: input.requirements.map((requirement) => ({
          requirementDigest: requirement.digest,
          status: "evidenced" as const,
          evidenceRefs: [input.availableEvidenceRefs[0]!],
        })),
        publicApi: "preserved",
        unrelatedChanges: "minimized",
      };
    },
  };
}

function projectZip(): Buffer {
  return buildZip([
    { name: "src/", content: "" },
    { name: "src/index.ts", content: "export const value = 1;\n" },
    { name: "package.json", content: "{\"scripts\":{\"test\":\"node test.mjs\"}}\n" },
    { name: "test.mjs", content: "import './src/index.ts';\n" },
  ]);
}

async function snapshotFile(
  projects: ProjectWorkspaceService,
  scopePromise: ReturnType<AwaitedFixture["scopeFor"]>,
  projectId: string,
  revision: number,
  path: string,
): Promise<string> {
  const scope = await scopePromise;
  const handle = await projects.getSnapshotHandle(scope, projectId, revision);
  return readFile(join(handle.internalPath, path), "utf8");
}

interface AwaitedFixture {
  scopeFor(workspaceKey: string): Promise<NonNullable<Awaited<ReturnType<WorkspaceAuthorityService["resolveScope"]>>>>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value?: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value?: T) { resolvePromise(value as T); },
  };
}
