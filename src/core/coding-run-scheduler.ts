import type { CodingCoordinatorResult } from "./coding-run-coordinator.js";
import { callTransportWithDeadline } from "./transport-deadline.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_CONCURRENT_PER_WORKSPACE = 2;
const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;

export interface CodingCoordinatorRunner {
  run(
    scope: WorkspaceAgentScope,
    runId: string,
    signal?: AbortSignal,
    expectedStateRevision?: number,
  ): Promise<CodingCoordinatorResult>;
}

export interface CodingRunQuiescence {
  waitForRunQuiescence(runId: string): Promise<void>;
}

export interface CodingRunAdvanceRequest {
  runId: string;
  expectedStateRevision: number;
}

export interface CodingRunSchedulerOptions {
  maxConcurrent?: number;
  maxConcurrentPerWorkspace?: number;
  drainTimeoutMs?: number;
}

/**
 * Capability evidence supplied by deployment composition, not inferred from
 * transport health. A verifier outside this module must bind these digests to
 * the exact sandbox service/runtime and an unexpired negative conformance run.
 */
export interface CodingRuntimeConformanceReceipt {
  version: 1;
  serviceIdentityDigest: string;
  runtimeImageDigest: string;
  policyDigest: string;
  suiteDigest: string;
  verifiedAt: string;
  expiresAt: string;
}

export interface CodingRuntimeConformanceVerifier {
  verify(
    receipt: CodingRuntimeConformanceReceipt,
    now: Date,
  ): void;
}

export interface CodingRunSchedulerStatus {
  version: 1;
  state: "idle" | "accepting" | "stopping" | "stopped";
  active: number;
  activeWorkspaces: number;
}

interface ActiveInvocation {
  workspaceKey: string;
  controller: AbortController;
  result: Promise<CodingCoordinatorResult>;
  quiesced: Promise<void>;
  quiescenceFailure: unknown | null;
}

/**
 * Process-local immediate admission for CodingRun coordinator invocations.
 * It never queues a WorkspaceAgentScope: a delayed scope could carry a stale
 * ACL epoch. Durable replay/freshness remains bound to stateRevision + engine
 * CAS; this scheduler only supplies bounded concurrency and lifecycle fences.
 */
export class CodingRunScheduler {
  private readonly maxConcurrent: number;
  private readonly maxConcurrentPerWorkspace: number;
  private readonly drainTimeoutMs: number;
  private readonly active = new Map<string, ActiveInvocation>();
  private state: CodingRunSchedulerStatus["state"] = "idle";
  private drainPromise: Promise<void> | null = null;
  private readonly conformanceReceipt: CodingRuntimeConformanceReceipt | null;

  constructor(
    private readonly coordinator: CodingCoordinatorRunner,
    private readonly quiescence: CodingRunQuiescence,
    options: CodingRunSchedulerOptions = {},
    conformanceReceipt: CodingRuntimeConformanceReceipt | null = null,
    private readonly now: () => Date = () => new Date(),
    private readonly conformanceVerifier: CodingRuntimeConformanceVerifier | null = null,
  ) {
    this.maxConcurrent = boundedInteger(
      options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      "maxConcurrent CodingRun scheduler",
      1,
      64,
    );
    this.maxConcurrentPerWorkspace = boundedInteger(
      options.maxConcurrentPerWorkspace ?? DEFAULT_MAX_CONCURRENT_PER_WORKSPACE,
      "maxConcurrentPerWorkspace CodingRun scheduler",
      1,
      this.maxConcurrent,
    );
    this.drainTimeoutMs = boundedInteger(
      options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      "drainTimeoutMs CodingRun scheduler",
      1,
      5 * 60_000,
    );
    this.conformanceReceipt = conformanceReceipt
      ? validateConformanceReceipt(conformanceReceipt, this.now())
      : null;
    if ((this.conformanceReceipt === null) !== (this.conformanceVerifier === null)) {
      throw new Error("Receipt dan verifier conformance wajib diprovision bersama.");
    }
  }

  start(): void {
    if (this.state === "accepting") return;
    if (this.state !== "idle") {
      throw new Error("CodingRun scheduler yang dihentikan tidak dapat dimulai ulang.");
    }
    if (!this.conformanceReceipt) {
      throw new Error("CodingRun scheduler memerlukan conformance receipt terverifikasi.");
    }
    validateConformanceReceipt(this.conformanceReceipt, this.now());
    this.conformanceVerifier?.verify(this.conformanceReceipt, this.now());
    this.state = "accepting";
  }

  advance(
    scopeInput: WorkspaceAgentScope,
    requestInput: CodingRunAdvanceRequest,
  ): Promise<CodingCoordinatorResult> {
    if (this.state !== "accepting") {
      return Promise.reject(new Error("CodingRun scheduler belum menerima admission."));
    }
    if (!this.conformanceReceipt || !this.conformanceVerifier) {
      return Promise.reject(new Error("Conformance coding runtime tidak tersedia."));
    }
    try {
      validateConformanceReceipt(this.conformanceReceipt, this.now());
      this.conformanceVerifier.verify(this.conformanceReceipt, this.now());
    } catch (error) {
      this.stop();
      return Promise.reject(error);
    }
    const scope = validateScopeSnapshot(scopeInput);
    const request = validateAdvanceRequest(requestInput);
    const key = `${scope.workspaceKey}\0${request.runId}`;
    if (this.active.has(key)) {
      return Promise.reject(
        new Error("CodingRun yang sama sudah mempunyai invocation aktif."),
      );
    }
    if (this.active.size >= this.maxConcurrent) {
      return Promise.reject(new Error("Kapasitas global CodingRun scheduler penuh."));
    }
    const workspaceActive = this.activeForWorkspace(scope.workspaceKey);
    if (workspaceActive >= this.maxConcurrentPerWorkspace) {
      return Promise.reject(new Error("Kapasitas workspace CodingRun scheduler penuh."));
    }

    const controller = new AbortController();
    const result = Promise.resolve().then(() => {
      if (this.state !== "accepting" || controller.signal.aborted) {
        throw abortError();
      }
      return this.coordinator.run(
        scope,
        request.runId,
        controller.signal,
        request.expectedStateRevision,
      );
    });
    result.catch(() => undefined);
    const quiesced = result.then(
      () => this.quiescence.waitForRunQuiescence(request.runId),
      () => this.quiescence.waitForRunQuiescence(request.runId),
    );
    quiesced.then(() => {
      const current = this.active.get(key);
      if (
        current?.quiesced === quiesced &&
        current.quiescenceFailure === null
      ) this.active.delete(key);
    }, (error) => {
      const current = this.active.get(key);
      if (current?.quiesced === quiesced) current.quiescenceFailure = error;
    }).catch(() => undefined);
    const invocation: ActiveInvocation = {
      workspaceKey: scope.workspaceKey,
      controller,
      result,
      quiesced,
      quiescenceFailure: null,
    };
    this.active.set(key, invocation);
    return result;
  }

  stop(): void {
    if (this.state === "stopped" || this.state === "stopping") return;
    this.state = "stopping";
    for (const invocation of this.active.values()) {
      invocation.controller.abort(new Error("CodingRun scheduler sedang dihentikan."));
    }
    if (this.active.size === 0) this.state = "stopped";
  }

  async drain(): Promise<void> {
    this.stop();
    if (this.state === "stopped") return;
    if (!this.drainPromise) {
      this.drainPromise = callTransportWithDeadline(
        "CodingRun scheduler drain",
        this.drainTimeoutMs,
        async (signal) => {
          while (this.active.size > 0) {
            if (signal.aborted) throw abortError();
            const latchedFailures = [...this.active.values()]
              .map((entry) => entry.quiescenceFailure)
              .filter((error): error is NonNullable<unknown> => error !== null);
            if (latchedFailures.length > 0) {
              throw new AggregateError(
                latchedFailures,
                "Quiescence CodingRun scheduler gagal dibuktikan.",
              );
            }
            const settled = await Promise.allSettled(
              [...this.active.values()].map((entry) => entry.quiesced),
            );
            const failures = settled
              .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
              .map((entry) => entry.reason);
            if (failures.length > 0) {
              throw new AggregateError(
                failures,
                "Quiescence CodingRun scheduler gagal dibuktikan.",
              );
            }
          }
        },
      ).then(() => {
        this.state = "stopped";
      });
    }
    const pending = this.drainPromise;
    try {
      await pending;
    } finally {
      if (this.drainPromise === pending) this.drainPromise = null;
    }
  }

  status(): CodingRunSchedulerStatus {
    return {
      version: 1,
      state: this.state,
      active: this.active.size,
      activeWorkspaces: new Set(
        [...this.active.values()].map((entry) => entry.workspaceKey),
      ).size,
    };
  }

  private activeForWorkspace(workspaceKey: string): number {
    let count = 0;
    for (const invocation of this.active.values()) {
      if (invocation.workspaceKey === workspaceKey) count += 1;
    }
    return count;
  }
}

function validateScopeSnapshot(input: WorkspaceAgentScope): WorkspaceAgentScope {
  const scope = structuredClone(input);
  if (
    scope.kind !== "workspace" ||
    !safeText(scope.workspaceKey, 512) ||
    !safeText(scope.membershipId, 512) ||
    !Number.isSafeInteger(scope.aclEpoch) ||
    scope.aclEpoch < 1
  ) {
    throw new Error("WorkspaceAgentScope CodingRun scheduler tidak sah.");
  }
  return scope;
}

function validateAdvanceRequest(input: CodingRunAdvanceRequest): CodingRunAdvanceRequest {
  const runId = safeText(input.runId, 512);
  if (
    !runId ||
    !Number.isSafeInteger(input.expectedStateRevision) ||
    input.expectedStateRevision < 0
  ) {
    throw new Error("Request advance CodingRun tidak sah.");
  }
  return { runId, expectedStateRevision: input.expectedStateRevision };
}

function safeText(input: string, maximum: number): string | null {
  if (typeof input !== "string") return null;
  const clean = input.trim();
  if (!clean || clean.length > maximum || /\p{Cc}/u.test(clean)) return null;
  return clean;
}

function boundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} tidak sah.`);
  }
  return value;
}

function abortError(): Error {
  const error = new Error("CodingRun scheduler dibatalkan.");
  error.name = "AbortError";
  return error;
}

function validateConformanceReceipt(
  input: CodingRuntimeConformanceReceipt,
  now: Date,
): CodingRuntimeConformanceReceipt {
  const receipt = structuredClone(input);
  if (
    receipt.version !== 1 ||
    !sha256(receipt.serviceIdentityDigest) ||
    !sha256(receipt.runtimeImageDigest) ||
    !sha256(receipt.policyDigest) ||
    !sha256(receipt.suiteDigest) ||
    !validTimestamp(receipt.verifiedAt) ||
    !validTimestamp(receipt.expiresAt) ||
    Date.parse(receipt.verifiedAt) > now.getTime() ||
    Date.parse(receipt.expiresAt) <= now.getTime() ||
    Date.parse(receipt.expiresAt) <= Date.parse(receipt.verifiedAt)
  ) {
    throw new Error("Coding runtime conformance receipt tidak sah atau kedaluwarsa.");
  }
  return Object.freeze(receipt);
}

function sha256(value: string): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
