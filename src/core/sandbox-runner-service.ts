import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  SandboxArtifactReference,
  SandboxBinding,
  SandboxDisposalReceipt,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxHealth,
  SandboxInputSnapshotDescriptor,
  SandboxInputSnapshotSource,
  SandboxLease,
  SandboxLeaseJournal,
  SandboxLeaseJournalRecord,
  SandboxResourceLimits,
  SandboxRunner,
  SandboxRunnerLifecycle,
  SandboxSecurityAttestation,
  SandboxSnapshotResult,
} from "../domain/sandbox.js";
import type {
  SandboxTransport,
  SandboxTransportExecutionRequest,
} from "../sandbox/sandbox-transport.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { canonicalProjectPath } from "./project-files.js";

export const DEFAULT_SANDBOX_LIMITS: Readonly<SandboxResourceLimits> =
  Object.freeze({
    cpuCores: 2,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    diskBytes: 4 * 1024 * 1024 * 1024,
    pids: 256,
    wallClockMs: 15 * 60 * 1000,
    maxOutputBytes: 256 * 1024,
    maxArtifacts: 32,
    maxArtifactBytes: 128 * 1024 * 1024,
  });

export interface SandboxAdmissionPolicy {
  maxConcurrentLeases: number;
  maxConcurrentLeasesPerOwner: number;
  maxLeaseMs: number;
  controlPlaneTimeoutMs: number;
}

const DEFAULT_ADMISSION_POLICY: Readonly<SandboxAdmissionPolicy> = Object.freeze({
  maxConcurrentLeases: 4,
  maxConcurrentLeasesPerOwner: 2,
  maxLeaseMs: 30 * 60 * 1000,
  controlPlaneTimeoutMs: 30_000,
});

/**
 * Policy/validation facade for an out-of-process isolation backend. It never
 * uses child_process and has no fallback to VirtualTerminal or host execution.
 */
export class SandboxRunnerService implements SandboxRunner, SandboxRunnerLifecycle {
  private readonly limits: SandboxResourceLimits;
  private readonly leases = new Map<string, SandboxLease>();
  private readonly records = new Map<string, SandboxLeaseJournalRecord>();
  private readonly artifacts = new Map<
    string,
    Map<string, SandboxArtifactReference>
  >();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly volatileQuarantine = new Set<string>();
  private admissionTail: Promise<void> = Promise.resolve();
  private readonly admission: Readonly<SandboxAdmissionPolicy>;
  private recovered = false;
  private recovery: Promise<void> | null = null;
  private acceptingOperations = true;
  private maintenanceSealed = false;
  private drained = false;
  private closed = false;
  private startPromise: Promise<SandboxHealth> | null = null;
  private drainPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private readonly inFlightControllers = new Set<AbortController>();

  constructor(
    private readonly transport: SandboxTransport,
    private readonly journal: SandboxLeaseJournal,
    limits: Partial<SandboxResourceLimits> = {},
    private readonly now: () => Date = () => new Date(),
    admission: Partial<SandboxAdmissionPolicy> = {},
  ) {
    this.limits = validatedLimits({ ...DEFAULT_SANDBOX_LIMITS, ...limits });
    this.admission = validatedAdmission({ ...DEFAULT_ADMISSION_POLICY, ...admission });
  }

  /**
   * Explicit startup boundary for application composition. Recovery always
   * fences every durable pre-existing lease before health can be returned.
   */
  async start(): Promise<SandboxHealth> {
    if (this.closed) throw new Error("SandboxRunner sudah ditutup.");
    if (!this.acceptingOperations) {
      throw new Error("SandboxRunner sudah menghentikan admission.");
    }
    if (!this.startPromise) {
      this.startPromise = this.trackOperation(
        "start",
        async () => {
          await this.ensureRecovered();
          return this.rawHealth();
        },
        true,
      );
    }
    const pending = this.startPromise;
    try {
      const health = await pending;
      if (!this.acceptingOperations) {
        throw new Error("SandboxRunner berhenti sebelum startup selesai.");
      }
      return structuredClone(health);
    } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  /** Stop admission synchronously; cleanup and exact backend fences happen in drain. */
  stop(): void {
    this.acceptingOperations = false;
    for (const controller of this.inFlightControllers) {
      controller.abort(new Error("SandboxRunner sedang dihentikan."));
    }
  }

  /**
   * Wait for admitted calls, seal maintenance admission, then fence every
   * journaled allocation. A failed fence keeps its durable record and rejects.
   */
  async drain(): Promise<void> {
    this.stop();
    if (this.drained) return;
    // Seal synchronously with the caller that starts drain. Waiting first
    // would leave a microtask window where a new maintenance call could enter
    // after the in-flight snapshot looked empty.
    this.maintenanceSealed = true;
    if (!this.drainPromise) {
      this.drainPromise = this.drainInternal();
    }
    const pending = this.drainPromise;
    try {
      await pending;
    } finally {
      if (this.drainPromise === pending) this.drainPromise = null;
    }
  }

  /** Close an owned journal only after every exact cancellation fence succeeds. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.closePromise) {
      this.closePromise = (async () => {
        await this.drain();
        await this.journal.close?.();
        this.closed = true;
      })();
    }
    const pending = this.closePromise;
    try {
      await pending;
    } finally {
      if (this.closePromise === pending) this.closePromise = null;
    }
  }

  async health(): Promise<SandboxHealth> {
    return this.trackOperation("health", async () => {
      await this.ensureRecovered();
      return this.rawHealth();
    }, true);
  }

  private async rawHealth(): Promise<SandboxHealth> {
    const health = await this.controlPlaneCall(
      "health",
      (signal) => this.transport.health(signal),
    );
    validateHealth(health);
    return structuredClone(health);
  }

  async allocate(
    bindingInput: SandboxBinding,
    snapshotInput: SandboxInputSnapshotSource,
  ): Promise<SandboxLease> {
    return this.trackOperation("allocate", () =>
      this.allocateInternal(bindingInput, snapshotInput));
  }

  private async allocateInternal(
    bindingInput: SandboxBinding,
    snapshotInput: SandboxInputSnapshotSource,
  ): Promise<SandboxLease> {
    const binding = validateBinding(bindingInput);
    const snapshot = validateInputSnapshot(
      snapshotInput,
      binding,
      this.limits.diskBytes,
    );
    await this.ensureRecovered();
    return this.exclusiveAdmission(async () => {
      await this.reapExpiredLeases();
      await this.reapUnresolvedRecords();
      const health = await this.rawHealth();
      if (!health.available || health.runtime !== "isolated-linux") {
        throw new Error(health.reason ?? "SandboxRunner tidak tersedia.");
      }
      const admittedCount = this.records.size;
      if (admittedCount >= this.admission.maxConcurrentLeases) {
        throw new Error("Admission SandboxRunner penuh.");
      }
      const ownerLeases = [...this.records.values()].filter(
        (candidate) => candidate.binding.ownerWorkspaceKey === binding.ownerWorkspaceKey,
      ).length;
      if (ownerLeases >= this.admission.maxConcurrentLeasesPerOwner) {
        throw new Error("Admission SandboxRunner untuk workspace owner penuh.");
      }
      const requestedLeaseId = `sandbox-lease:${randomUUID()}`;
      const createdAt = this.now().toISOString();
      const allocating = await this.createRecord({
        version: 1,
        leaseId: requestedLeaseId,
        revision: 1,
        state: "allocating",
        binding,
        limits: structuredClone(this.limits),
        lease: null,
        lastErrorCode: null,
        createdAt,
        updatedAt: createdAt,
      });
      let lease: SandboxLease;
      try {
        const transfer = verifiedSnapshotTransfer(snapshot);
        lease = await this.controlPlaneCall(
          "allocate",
          (signal) => this.transport.allocate({
            leaseId: requestedLeaseId,
            binding,
            network: "off",
            limits: structuredClone(this.limits),
            snapshot: structuredClone(snapshot.descriptor),
          }, transfer.content, signal),
          { onLateSettlement: () => this.cleanupRejectedAllocation(requestedLeaseId) },
        );
        if (!transfer.completed()) {
          throw new Error("Sandbox transport tidak mengonsumsi seluruh bundle snapshot.");
        }
        validateLease(
          lease,
          requestedLeaseId,
          binding,
          this.limits,
          this.admission.maxLeaseMs,
          this.now(),
        );
        if (this.leases.has(lease.leaseId)) {
          throw new Error("Sandbox lease id duplikat.");
        }
      } catch (error) {
        await this.cleanupRejectedAllocation(requestedLeaseId).catch(() => undefined);
        throw error;
      }
      const frozen = structuredClone(lease);
      await this.transitionRecord(allocating, {
        state: "active",
        lease: frozen,
        lastErrorCode: null,
      }).catch(async (error) => {
        await this.cleanupRejectedAllocation(requestedLeaseId).catch(() => undefined);
        throw error;
      });
      this.leases.set(lease.leaseId, frozen);
      return structuredClone(frozen);
    });
  }

  async execute(
    leaseInput: SandboxLease,
    requestInput: SandboxExecRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    return this.trackOperation("execute", (lifecycleSignal) =>
      this.executeInternal(
        leaseInput,
        requestInput,
        anyAbortSignal(signal, lifecycleSignal),
      ));
  }

  private async executeInternal(
    leaseInput: SandboxLease,
    requestInput: SandboxExecRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    await this.ensureRecovered();
    const initialLease = this.currentLease(leaseInput);
    const request = validateExecRequest(requestInput, initialLease.attestation.limits);
    const transportRequest = createTransportExecutionRequest(
      initialLease,
      request,
    );
    if (signal?.aborted) throw abortError();
    return this.exclusive(initialLease.leaseId, async () => {
      if (signal?.aborted) throw abortError();
      const lease = this.currentLease(leaseInput);
      this.assertLeaseLive(lease);
      try {
        const result = await this.executeWithDeadline(
          lease,
          transportRequest,
          signal,
        );
        validateExecResult(result, lease, request, transportRequest);
        this.rememberArtifacts(lease.leaseId, result.artifacts);
        return structuredClone(result);
      } catch (error) {
        await this.quarantineAfterAmbiguousOperation(lease, "execution_ambiguous");
        throw error;
      }
    });
  }

  async captureSnapshot(
    leaseInput: SandboxLease,
  ): Promise<SandboxSnapshotResult> {
    return this.trackOperation("captureSnapshot", () =>
      this.captureSnapshotInternal(leaseInput));
  }

  private async captureSnapshotInternal(
    leaseInput: SandboxLease,
  ): Promise<SandboxSnapshotResult> {
    await this.ensureRecovered();
    const initialLease = this.currentLease(leaseInput);
    return this.exclusive(initialLease.leaseId, async () => {
      const lease = this.currentLease(leaseInput);
      this.assertLeaseLive(lease);
      try {
        const result = await this.controlPlaneCall(
          "captureSnapshot",
          (signal) => this.transport.captureSnapshot(lease.leaseId, signal),
        );
        assertExactObject(
          result,
          ["leaseId", "snapshot", "sourceWorkspaceRevision", "createdAt"],
          "sandbox snapshot result",
        );
        if (
          result.leaseId !== lease.leaseId ||
          result.sourceWorkspaceRevision !== lease.binding.workspaceRevision
        ) {
          throw new Error("Snapshot sandbox tidak cocok dengan binding lease.");
        }
        validIso(result.createdAt, "sandbox snapshot createdAt");
        validateArtifact(
          result.snapshot,
          lease.attestation.limits,
          "workspace-snapshot",
        );
        this.rememberArtifacts(lease.leaseId, [result.snapshot]);
        return structuredClone(result);
      } catch (error) {
        await this.quarantineAfterAmbiguousOperation(lease, "snapshot_ambiguous");
        throw error;
      }
    });
  }

  async readArtifact(
    leaseInput: SandboxLease,
    artifactInput: SandboxArtifactReference,
  ): Promise<Uint8Array> {
    return this.trackOperation("readArtifact", () =>
      this.readArtifactInternal(leaseInput, artifactInput));
  }

  private async readArtifactInternal(
    leaseInput: SandboxLease,
    artifactInput: SandboxArtifactReference,
  ): Promise<Uint8Array> {
    await this.ensureRecovered();
    const initialLease = this.currentLease(leaseInput);
    validateArtifact(artifactInput, initialLease.attestation.limits);
    return this.exclusive(initialLease.leaseId, async () => {
      const lease = this.currentLease(leaseInput);
      const known = this.artifacts.get(lease.leaseId)?.get(artifactInput.artifactId);
      if (!known || JSON.stringify(known) !== JSON.stringify(artifactInput)) {
        throw new Error("Artifact sandbox tidak pernah diterbitkan oleh exact lease ini.");
      }
      try {
        return await this.controlPlaneCall(
          "downloadArtifact",
          async (signal) => {
            const chunks: Buffer[] = [];
            const hash = createHash("sha256");
            let size = 0;
            for await (const value of this.transport.downloadArtifact(
              lease.leaseId,
              known,
              signal,
            )) {
              if (signal.aborted) throw abortError();
              if (!(value instanceof Uint8Array) || value.byteLength < 1) {
                throw new Error("Chunk artifact sandbox tidak sah.");
              }
              const chunk = Buffer.from(value);
              size += chunk.byteLength;
              if (size > known.size || size > lease.attestation.limits.maxArtifactBytes) {
                throw new Error("Byte artifact sandbox melampaui descriptor.");
              }
              hash.update(chunk);
              chunks.push(chunk);
            }
            if (size !== known.size || hash.digest("hex") !== known.sha256) {
              throw new Error("Byte artifact sandbox tidak cocok descriptor content-addressed.");
            }
            return new Uint8Array(Buffer.concat(chunks, size));
          },
        );
      } catch (error) {
        await this.quarantineAfterAmbiguousOperation(
          lease,
          "artifact_read_ambiguous",
        );
        throw error;
      }
    });
  }

  async dispose(leaseInput: SandboxLease): Promise<void> {
    return this.trackOperation("dispose", () => this.disposeInternal(leaseInput), true);
  }

  private async disposeInternal(leaseInput: SandboxLease): Promise<void> {
    await this.ensureRecovered();
    const known = this.leases.get(leaseInput.leaseId);
    if (!known) throw new Error("Sandbox lease tidak dikenal.");
    if (!sameLease(known, leaseInput)) {
      throw new Error("Sandbox lease handle tidak sah.");
    }
    await this.exclusive(known.leaseId, async () => {
      const current = this.leases.get(known.leaseId);
      if (!current) throw new Error("Sandbox lease tidak dikenal.");
      const record = this.records.get(known.leaseId);
      if (!record) throw new Error("Sandbox lease kehilangan journal durable.");
      const disposing = await this.transitionToDisposing(record, null);
      await this.fenceAndRemove(disposing, "dispose");
    });
  }

  async fenceProjectRuns(input: {
    ownerWorkspaceKey: string;
    projectId: string;
  }): Promise<void> {
    return this.trackOperation(
      "fenceProjectRuns",
      () => this.fenceProjectRunsInternal(input),
      true,
    );
  }

  private async fenceProjectRunsInternal(input: {
    ownerWorkspaceKey: string;
    projectId: string;
  }): Promise<void> {
    await this.ensureRecovered();
    const ownerWorkspaceKey = safeText(input.ownerWorkspaceKey, "ownerWorkspaceKey", 512);
    const projectId = safeText(input.projectId, "projectId", 512);
    const failures: unknown[] = [];
    const matching = [...this.records.values()].filter((record) =>
      record.binding.ownerWorkspaceKey === ownerWorkspaceKey &&
      record.binding.projectId === projectId
    );
    for (const initial of matching) {
      try {
        await this.exclusive(initial.leaseId, async () => {
          const current = this.records.get(initial.leaseId);
          if (!current) return;
          const disposing = await this.transitionToDisposing(
            current,
            "project_authority_fence",
          );
          await this.fenceAndRemove(disposing, "project authority fence dispose");
        });
      } catch (error) {
        failures.push(error);
      }
    }
    const unresolved = [...this.records.values()].filter((record) =>
      record.binding.ownerWorkspaceKey === ownerWorkspaceKey &&
      record.binding.projectId === projectId
    );
    if (failures.length > 0 || unresolved.length > 0) {
      throw new AggregateError(
        failures,
        "Sandbox project authority belum membuktikan seluruh cancellation fence.",
      );
    }
  }

  private currentLease(input: SandboxLease): SandboxLease {
    const current = this.leases.get(input.leaseId);
    const record = this.records.get(input.leaseId);
    if (!current || !sameLease(current, input)) {
      throw new Error("Sandbox lease tidak dikenal atau binding berubah.");
    }
    if (!record) throw new Error("Sandbox lease kehilangan journal durable.");
    if (record.state === "quarantined" || this.volatileQuarantine.has(input.leaseId)) {
      throw new Error("Sandbox lease dikarantina setelah hasil eksekusi ambigu.");
    }
    if (record.state === "disposing") {
      throw new Error("Sandbox lease sedang dibuang.");
    }
    if (record.state !== "active") throw new Error("Sandbox lease belum aktif.");
    this.assertLeaseLive(current);
    return current;
  }

  private assertLeaseLive(lease: SandboxLease): void {
    if (Date.parse(lease.expiresAt) <= this.now().getTime()) {
      throw new Error("Sandbox lease sudah kedaluwarsa.");
    }
  }

  private async executeWithDeadline(
    lease: SandboxLease,
    request: SandboxTransportExecutionRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    let accepting = true;
    const deadline = performance.now() + request.request.timeoutMs + 1_000;
    const forwardAbort = () => {
      accepting = false;
      controller.abort(signal?.reason);
    };
    signal?.addEventListener("abort", forwardAbort, { once: true });
    let timedOut = false;
    const expire = () => {
      if (timedOut) return;
      timedOut = true;
      accepting = false;
      controller.abort(new Error("SandboxRunner client watchdog timeout."));
    };
    const timeout = setTimeout(expire, request.request.timeoutMs + 1_000);
    const execution = Promise.resolve().then(() =>
      this.transport.execute(lease.leaseId, request, controller.signal)
    );
    execution.catch(() => undefined);
    try {
      const result = await Promise.race([
        execution,
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(timedOut
              ? new Error("SandboxRunner melewati client watchdog timeout.")
              : abortError());
          }, { once: true });
        }),
      ]);
      if (performance.now() >= deadline) expire();
      if (!accepting || timedOut || signal?.aborted || controller.signal.aborted) {
        throw timedOut
          ? new Error("SandboxRunner melewati client watchdog timeout.")
          : abortError();
      }
      return result;
    } catch (error) {
      if (timedOut) {
        throw new Error("SandboxRunner melewati client watchdog timeout.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async reapExpiredLeases(): Promise<void> {
    const expired = [...this.leases.values()].filter(
      (lease) => Date.parse(lease.expiresAt) <= this.now().getTime(),
    );
    for (const lease of expired) {
      try {
        await this.disposeInternal(lease);
      } catch {
        // Failed cleanup remains admitted and blocks new work fail-closed.
      }
    }
  }

  private async reapUnresolvedRecords(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.state === "active") continue;
      try {
        await this.cleanupRejectedAllocation(record.leaseId);
      } catch {
        // Durable unresolved lifecycle stays admitted and blocks new work.
      }
    }
  }

  private async cleanupRejectedAllocation(allocationId: string): Promise<void> {
    await this.exclusive(allocationId, async () => {
      let current = this.records.get(allocationId);
      if (!current) return;
      if (current.state !== "disposing") {
        try {
          current = await this.transitionRecord(current, {
            state: "disposing",
            lastErrorCode: "allocation_rejected",
          });
        } catch {
          // A response-lost save may have advanced allocating→active. Reloaded
          // CAS state is authoritative and must still cross the disposal fence.
          current = this.records.get(allocationId);
          if (!current) return;
          if (current.state !== "disposing") {
            current = await this.transitionRecord(current, {
              state: "disposing",
              lastErrorCode: "allocation_rejected",
            });
          }
        }
      }
      await this.fenceAndRemove(current, "dispose rejected allocation");
    });
  }

  private async quarantineAfterAmbiguousOperation(
    lease: SandboxLease,
    errorCode:
      | "execution_ambiguous"
      | "snapshot_ambiguous"
      | "artifact_read_ambiguous",
  ): Promise<void> {
    this.volatileQuarantine.add(lease.leaseId);
    let record = this.records.get(lease.leaseId);
    if (!record) return;
    try {
      if (record.state === "active") {
        try {
          record = await this.transitionRecord(record, {
            state: "quarantined",
            lastErrorCode: errorCode,
          });
        } catch {
          record = this.records.get(lease.leaseId) ?? record;
          if (record.state === "active") return;
        }
      }
      if (record.state !== "disposing") {
        try {
          record = await this.transitionRecord(record, {
            state: "disposing",
            lastErrorCode: errorCode,
          });
        } catch {
          record = this.records.get(lease.leaseId) ?? record;
          if (record.state !== "disposing") return;
        }
      }
      await this.fenceAndRemove(record, "dispose ambiguous execution");
    } catch {
      // Journal record plus process-local quarantine remains admitted and
      // unusable until cancellation fence can be proven.
    }
  }

  private async ensureRecovered(): Promise<void> {
    if (this.recovered) return;
    if (!this.recovery) {
      this.recovery = this.recoverDurableState()
        .then(() => {
          this.recovered = true;
        })
        .finally(() => {
          this.recovery = null;
        });
    }
    await this.recovery;
  }

  private async recoverDurableState(): Promise<void> {
    const records = await this.journal.list();
    this.records.clear();
    this.leases.clear();
    this.artifacts.clear();
    this.volatileQuarantine.clear();
    for (const record of records) this.records.set(record.leaseId, record);
    const failures: unknown[] = [];
    for (const initial of records) {
      try {
        let current = this.records.get(initial.leaseId);
        if (!current) continue;
        current = await this.transitionToDisposing(current, "startup_recovery");
        await this.fenceAndRemove(current, "startup recovery dispose");
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Recovery SandboxRunner belum membuktikan semua cancellation fence.",
      );
    }
  }

  private async drainInternal(): Promise<void> {
    await this.waitForTrackedOperations();
    await this.ensureRecovered();
    const failures: unknown[] = [];
    await this.exclusiveAdmission(async () => {
      const durable = await this.journal.list();
      this.replaceRecordsFromJournal(durable);
      for (const initial of durable) {
        try {
          await this.exclusive(initial.leaseId, async () => {
            const current = this.records.get(initial.leaseId);
            if (!current) return;
            const disposing = await this.transitionToDisposing(
              current,
              "shutdown_drain",
            );
            await this.fenceAndRemove(disposing, "shutdown drain dispose");
          });
        } catch (error) {
          failures.push(error);
        }
      }
    });
    const unresolved = await this.journal.list();
    this.replaceRecordsFromJournal(unresolved);
    if (failures.length > 0 || unresolved.length > 0) {
      throw new AggregateError(
        failures,
        "Shutdown SandboxRunner belum membuktikan semua cancellation fence.",
      );
    }
    this.drained = true;
  }

  private async waitForTrackedOperations(): Promise<void> {
    while (this.inFlightOperations.size > 0) {
      await Promise.allSettled([...this.inFlightOperations]);
    }
  }

  private trackOperation<T>(
    operationName: string,
    operation: (signal: AbortSignal) => Promise<T>,
    allowAfterStop = false,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("SandboxRunner sudah ditutup."));
    }
    if (this.maintenanceSealed) {
      return Promise.reject(
        new Error(`SandboxRunner drain menolak operasi ${operationName}.`),
      );
    }
    if (!allowAfterStop && !this.acceptingOperations) {
      return Promise.reject(
        new Error(`SandboxRunner admission berhenti; operasi ${operationName} ditolak.`),
      );
    }
    const controller = new AbortController();
    this.inFlightControllers.add(controller);
    const pending = Promise.resolve().then(() => operation(controller.signal));
    this.inFlightOperations.add(pending);
    pending.finally(() => {
      this.inFlightOperations.delete(pending);
      this.inFlightControllers.delete(controller);
    }).catch(() => undefined);
    return pending;
  }

  private replaceRecordsFromJournal(
    records: readonly SandboxLeaseJournalRecord[],
  ): void {
    this.records.clear();
    for (const record of records) this.records.set(record.leaseId, record);
    for (const leaseId of [...this.leases.keys()]) {
      if (!this.records.has(leaseId)) this.leases.delete(leaseId);
    }
    for (const leaseId of [...this.artifacts.keys()]) {
      if (!this.records.has(leaseId)) this.artifacts.delete(leaseId);
    }
    for (const leaseId of [...this.volatileQuarantine]) {
      if (!this.records.has(leaseId)) this.volatileQuarantine.delete(leaseId);
    }
  }

  private async createRecord(
    record: SandboxLeaseJournalRecord,
  ): Promise<SandboxLeaseJournalRecord> {
    let result;
    try {
      result = await this.journal.create(record);
    } catch (error) {
      const durable = await this.refreshRecordFromJournal(record.leaseId)
        .catch(() => null);
      if (durable && durable.revision === record.revision) {
        await this.cleanupRejectedAllocation(record.leaseId).catch(() => undefined);
      }
      throw error;
    }
    if (result.status !== "saved") {
      this.records.set(result.record.leaseId, result.record);
      throw new Error("Lease ID sandbox sudah ada di journal durable.");
    }
    this.records.set(result.record.leaseId, result.record);
    return result.record;
  }

  private async transitionRecord(
    before: SandboxLeaseJournalRecord,
    changes: Pick<SandboxLeaseJournalRecord, "state" | "lastErrorCode"> & {
      lease?: SandboxLease | null;
    },
  ): Promise<SandboxLeaseJournalRecord> {
    const current = this.records.get(before.leaseId);
    if (!current || current.revision !== before.revision) {
      throw new Error("Sandbox journal berubah bersamaan.");
    }
    const next: SandboxLeaseJournalRecord = {
      ...structuredClone(current),
      revision: current.revision + 1,
      state: changes.state,
      lease: changes.lease === undefined
        ? structuredClone(current.lease)
        : structuredClone(changes.lease),
      lastErrorCode: changes.lastErrorCode,
      updatedAt: this.now().toISOString(),
    };
    let result;
    try {
      result = await this.journal.save(next, current.revision);
    } catch (error) {
      await this.refreshRecordFromJournal(current.leaseId).catch(() => undefined);
      throw error;
    }
    if (result.status !== "saved") {
      if (result.record) this.records.set(result.record.leaseId, result.record);
      else this.records.delete(current.leaseId);
      throw new Error("CAS sandbox lease journal konflik.");
    }
    this.records.set(result.record.leaseId, result.record);
    return result.record;
  }

  private async transitionToDisposing(
    record: SandboxLeaseJournalRecord,
    lastErrorCode: string | null,
  ): Promise<SandboxLeaseJournalRecord> {
    if (record.state === "disposing") return record;
    try {
      return await this.transitionRecord(record, {
        state: "disposing",
        lastErrorCode,
      });
    } catch (error) {
      // A durable store may commit the transition and then lose the ACK (for
      // example, while syncing the directory entry). The reloaded state is
      // authoritative: once it is disposing we must still cross the remote
      // cancellation fence instead of waiting for an external retry.
      const durable = this.records.get(record.leaseId);
      if (durable?.state === "disposing") return durable;
      throw error;
    }
  }

  private async fenceAndRemove(
    record: SandboxLeaseJournalRecord,
    operationName: string,
  ): Promise<void> {
    if (record.state !== "disposing") {
      throw new Error("Cancellation fence hanya sah untuk record disposing.");
    }
    let receipt: SandboxDisposalReceipt;
    try {
      receipt = await this.controlPlaneCall(
        operationName,
        (signal) => this.transport.cancelAndDispose(record.leaseId, signal),
      );
      validateDisposalReceipt(receipt, record.leaseId);
    } catch (error) {
      const current = this.records.get(record.leaseId);
      if (current?.state === "disposing") {
        await this.transitionRecord(current, {
          state: "disposing",
          lastErrorCode: "dispose_unconfirmed",
        }).catch(() => undefined);
      }
      throw error;
    }
    const current = this.records.get(record.leaseId);
    if (!current) throw new Error("Sandbox journal hilang sebelum fence disimpan.");
    let removed;
    try {
      removed = await this.journal.remove(current.leaseId, current.revision);
    } catch (error) {
      const durable = await this.refreshRecordFromJournal(current.leaseId)
        .catch(() => current);
      if (!durable) {
        this.leases.delete(record.leaseId);
        this.volatileQuarantine.delete(record.leaseId);
        return;
      }
      throw error;
    }
    if (removed.status !== "removed") {
      if (removed.record) this.records.set(removed.record.leaseId, removed.record);
      else this.records.delete(current.leaseId);
      throw new Error("CAS penghapusan sandbox journal konflik.");
    }
    this.records.delete(record.leaseId);
    this.leases.delete(record.leaseId);
    this.artifacts.delete(record.leaseId);
    this.volatileQuarantine.delete(record.leaseId);
  }

  private rememberArtifacts(
    leaseId: string,
    artifacts: readonly SandboxArtifactReference[],
  ): void {
    const known = this.artifacts.get(leaseId) ?? new Map();
    for (const artifact of artifacts) {
      const existing = known.get(artifact.artifactId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(artifact)) {
        throw new Error("Artifact ID sandbox dipakai ulang untuk descriptor berbeda.");
      }
      known.set(artifact.artifactId, structuredClone(artifact));
    }
    this.artifacts.set(leaseId, known);
  }

  private async refreshRecordFromJournal(
    leaseId: string,
  ): Promise<SandboxLeaseJournalRecord | null> {
    const records = await this.journal.list();
    const durable = records.find((candidate) => candidate.leaseId === leaseId) ?? null;
    if (durable) this.records.set(leaseId, durable);
    else this.records.delete(leaseId);
    return durable;
  }

  private async controlPlaneCall<T>(
    operationName: string,
    operation: (signal: AbortSignal) => Promise<T>,
    lifecycle: {
      onTimeout?: () => void;
      onLateSettlement?: () => Promise<void>;
    } = {},
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let accepting = true;
    let lateCleanupScheduled = false;
    const deadline = performance.now() + this.admission.controlPlaneTimeoutMs;
    const scheduleLateCleanup = () => {
      if (lateCleanupScheduled) return;
      lateCleanupScheduled = true;
      void lifecycle.onLateSettlement?.().catch(() => undefined);
    };
    const expire = () => {
      if (timedOut) return;
      timedOut = true;
      accepting = false;
      lifecycle.onTimeout?.();
      controller.abort(new Error(`SandboxRunner ${operationName} timeout.`));
    };
    const timeout = setTimeout(expire, this.admission.controlPlaneTimeoutMs);
    const pending = Promise.resolve().then(() => operation(controller.signal));
    pending.catch(() => undefined);
    pending.then(
      () => {
        if (timedOut) scheduleLateCleanup();
      },
      () => {
        if (timedOut) scheduleLateCleanup();
      },
    );
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new Error(`SandboxRunner ${operationName} timeout.`));
          }, { once: true });
        }),
      ]);
      if (performance.now() >= deadline) {
        expire();
        scheduleLateCleanup();
      }
      if (!accepting || timedOut || controller.signal.aborted) {
        throw new Error(`SandboxRunner ${operationName} timeout.`);
      }
      return result;
    } catch (error) {
      if (timedOut) {
        throw new Error(`SandboxRunner ${operationName} timeout.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async exclusiveAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.admissionTail.then(operation, operation);
    this.admissionTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async exclusive<T>(leaseId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(leaseId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(leaseId, tail);
    try {
      return await next;
    } finally {
      if (this.queues.get(leaseId) === tail) this.queues.delete(leaseId);
    }
  }
}

function validateInputSnapshot(
  input: SandboxInputSnapshotSource,
  binding: SandboxBinding,
  maxBytes: number,
): SandboxInputSnapshotSource {
  assertExactObject(input, ["descriptor", "open"], "sandbox snapshot source");
  if (typeof input.open !== "function") {
    throw new Error("Source bundle snapshot sandbox tidak dapat dibuka.");
  }
  const descriptor = validateInputSnapshotDescriptor(
    input.descriptor,
    binding,
    maxBytes,
  );
  return Object.freeze({ descriptor, open: () => input.open() });
}

function validateInputSnapshotDescriptor(
  input: SandboxInputSnapshotDescriptor,
  binding: SandboxBinding,
  maxBytes: number,
): SandboxInputSnapshotDescriptor {
  assertExactObject(
    input,
    [
      "version",
      "snapshotId",
      "bundleSha256",
      "manifestSha256",
      "size",
      "fileCount",
      "mediaType",
    ],
    "sandbox snapshot descriptor",
  );
  if (
    input.version !== 1 ||
    input.snapshotId !== binding.snapshotId ||
    !/^[a-f0-9]{64}$/u.test(input.bundleSha256) ||
    !/^[a-f0-9]{64}$/u.test(input.manifestSha256) ||
    !Number.isSafeInteger(input.size) ||
    input.size < 1 ||
    input.size > maxBytes ||
    !Number.isSafeInteger(input.fileCount) ||
    input.fileCount < 0 ||
    input.fileCount > 10_000 ||
    input.mediaType !== "application/vnd.harvy.snapshot-bundle.v1"
  ) {
    throw new Error("Descriptor bundle snapshot sandbox tidak sah atau tidak cocok binding.");
  }
  return Object.freeze(structuredClone(input));
}

function verifiedSnapshotTransfer(source: SandboxInputSnapshotSource): {
  content: AsyncIterable<Uint8Array>;
  completed: () => boolean;
} {
  let opened = false;
  let complete = false;
  const content = (async function* (): AsyncGenerator<Uint8Array> {
    if (opened) throw new Error("Bundle snapshot sandbox hanya boleh dibuka sekali per allocate.");
    opened = true;
    const iterable = source.open();
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
      throw new Error("Source bundle snapshot sandbox bukan async iterable.");
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const value of iterable) {
      if (!(value instanceof Uint8Array) || value.byteLength < 1) {
        throw new Error("Chunk bundle snapshot sandbox tidak sah.");
      }
      const chunk = Buffer.from(value);
      size += chunk.byteLength;
      if (size > source.descriptor.size) {
        throw new Error("Bundle snapshot sandbox melampaui descriptor size.");
      }
      hash.update(chunk);
      yield chunk;
    }
    if (
      size !== source.descriptor.size ||
      hash.digest("hex") !== source.descriptor.bundleSha256
    ) {
      throw new Error("Byte bundle snapshot sandbox tidak cocok descriptor content-addressed.");
    }
    complete = true;
  })();
  return { content, completed: () => complete };
}

function validateBinding(input: SandboxBinding): SandboxBinding {
  assertExactObject(
    input,
    ["ownerWorkspaceKey", "projectId", "snapshotId", "workspaceRevision", "runId"],
    "sandbox binding",
  );
  const ownerWorkspaceKey = safeText(
    input.ownerWorkspaceKey,
    "sandbox ownerWorkspaceKey",
    512,
  );
  const projectId = safeText(input.projectId, "sandbox projectId", 512);
  const runId = safeText(input.runId, "sandbox runId", 512);
  if (!/^[a-f0-9]{64}$/u.test(input.snapshotId)) {
    throw new Error("Sandbox snapshotId tidak sah.");
  }
  if (!Number.isSafeInteger(input.workspaceRevision) || input.workspaceRevision < 1) {
    throw new Error("Sandbox workspaceRevision tidak sah.");
  }
  return {
    ownerWorkspaceKey,
    projectId,
    snapshotId: input.snapshotId,
    workspaceRevision: input.workspaceRevision,
    runId,
  };
}

function validateLease(
  lease: SandboxLease,
  expectedLeaseId: string,
  binding: SandboxBinding,
  limits: SandboxResourceLimits,
  maxLeaseMs: number,
  now: Date,
): void {
  assertExactObject(
    lease,
    ["leaseId", "binding", "attestation", "createdAt", "expiresAt"],
    "sandbox lease",
  );
  validateBinding(lease.binding);
  safeText(lease.leaseId, "sandbox leaseId", 512);
  if (lease.leaseId !== expectedLeaseId) {
    throw new Error("Sandbox leaseId tidak menggemakan allocation id Harvy.");
  }
  if (!sameBinding(lease.binding, binding)) {
    throw new Error("Sandbox lease tidak terikat ke project revision yang diminta.");
  }
  validateAttestation(lease.attestation, limits);
  validIso(lease.createdAt, "sandbox lease createdAt");
  validIso(lease.expiresAt, "sandbox lease expiresAt");
  if (
    Math.abs(Date.parse(lease.createdAt) - now.getTime()) > 60_000 ||
    Date.parse(lease.expiresAt) <= now.getTime() ||
    Date.parse(lease.expiresAt) <= Date.parse(lease.createdAt) ||
    Date.parse(lease.expiresAt) - Date.parse(lease.createdAt) > maxLeaseMs
  ) {
    throw new Error("Horizon Sandbox lease tidak sah.");
  }
}

function validateAttestation(
  value: SandboxSecurityAttestation,
  limits: SandboxResourceLimits,
): void {
  assertExactObject(
    value,
    [
      "version",
      "runtime",
      "unprivilegedUser",
      "noHarvySecrets",
      "noProviderSecrets",
      "noGitHubSecrets",
      "noHarvyDataMount",
      "noHostRootMount",
      "noDockerSocket",
      "noPrivilegedDevices",
      "capabilitiesDropped",
      "syscallFilter",
      "readOnlyRootFilesystem",
      "disposable",
      "network",
      "limits",
    ],
    "sandbox attestation",
  );
  assertExactLimits(value.limits);
  if (
    value?.version !== 1 ||
    value.runtime !== "isolated-linux" ||
    value.unprivilegedUser !== true ||
    value.noHarvySecrets !== true ||
    value.noProviderSecrets !== true ||
    value.noGitHubSecrets !== true ||
    value.noHarvyDataMount !== true ||
    value.noHostRootMount !== true ||
    value.noDockerSocket !== true ||
    value.noPrivilegedDevices !== true ||
    value.capabilitiesDropped !== true ||
    value.syscallFilter !== true ||
    value.readOnlyRootFilesystem !== true ||
    value.disposable !== true ||
    value.network !== "off" ||
    !sameLimits(value.limits, limits)
  ) {
    throw new Error("Attestation SandboxRunner tidak memenuhi policy Harvy.");
  }
}

function validateExecRequest(
  input: SandboxExecRequest,
  limits: SandboxResourceLimits,
): SandboxExecRequest {
  assertExactObject(input, ["argv", "cwd", "purpose", "timeoutMs"], "sandbox exec request");
  if (!Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 128) {
    throw new Error("argv sandbox tidak sah.");
  }
  const argv = input.argv.map((part) => safeArg(part));
  const executable = argv[0];
  if (!executable) throw new Error("Executable sandbox kosong.");
  const cwd = input.cwd === "." ? "." : canonicalProjectPath(input.cwd);
  if (
    input.purpose !== "inspect" &&
    input.purpose !== "test" &&
    input.purpose !== "lint" &&
    input.purpose !== "typecheck" &&
    input.purpose !== "build"
  ) {
    throw new Error("Purpose eksekusi sandbox tidak sah.");
  }
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > limits.wallClockMs
  ) {
    throw new Error("Timeout eksekusi sandbox tidak sah.");
  }
  return {
    argv: argv as [string, ...string[]],
    cwd,
    purpose: input.purpose,
    timeoutMs: input.timeoutMs,
  };
}

function createTransportExecutionRequest(
  lease: SandboxLease,
  request: SandboxExecRequest,
): SandboxTransportExecutionRequest {
  const operationId = `sandbox-exec:${randomUUID()}`;
  const requestDigest = createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      operationId,
      leaseId: lease.leaseId,
      binding: lease.binding,
      request,
    }), "utf8")
    .digest("hex");
  return Object.freeze({
    version: 1,
    operationId,
    requestDigest,
    request: structuredClone(request),
  });
}

function validateExecResult(
  value: SandboxExecResult,
  lease: SandboxLease,
  request: SandboxExecRequest,
  transportRequest: SandboxTransportExecutionRequest,
): void {
  assertExactObject(
    value,
    [
      "operationId",
      "requestDigest",
      "executionId",
      "leaseId",
      "status",
      "exitCode",
      "signal",
      "stdout",
      "stderr",
      "truncated",
      "artifacts",
      "usage",
      "startedAt",
      "completedAt",
    ],
    "sandbox exec result",
  );
  if (
    value.operationId !== transportRequest.operationId ||
    value.requestDigest !== transportRequest.requestDigest
  ) {
    throw new Error("Hasil sandbox tidak menggemakan exact operation/request digest.");
  }
  safeOpaqueTransportId(value.executionId, "sandbox executionId");
  if (value.leaseId !== lease.leaseId) {
    throw new Error("Hasil sandbox berasal dari lease lain.");
  }
  if (
    value.status !== "exited" &&
    value.status !== "timed_out" &&
    value.status !== "resource_exhausted" &&
    value.status !== "cancelled" &&
    value.status !== "infrastructure_error"
  ) {
    throw new Error("Status hasil sandbox tidak sah.");
  }
  if (
    (value.status === "exited" &&
      (!Number.isSafeInteger(value.exitCode) || value.exitCode === null)) ||
    (value.status !== "exited" && value.exitCode !== null)
  ) {
    throw new Error("Exit code sandbox tidak konsisten.");
  }
  if (value.signal !== null) safeText(value.signal, "sandbox signal", 64);
  if (typeof value.stdout !== "string" || typeof value.stderr !== "string") {
    throw new Error("Output sandbox tidak sah.");
  }
  const outputBytes = Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr);
  if (
    outputBytes > lease.attestation.limits.maxOutputBytes ||
    value.usage.outputBytes < outputBytes ||
    value.usage.outputBytes > lease.attestation.limits.maxOutputBytes
  ) {
    throw new Error("Output sandbox melampaui batas atau metadata tidak cocok.");
  }
  if (value.truncated && value.artifacts.length === 0) {
    throw new Error("Output sandbox terpotong tanpa artifact evidence.");
  }
  if (value.artifacts.length > lease.attestation.limits.maxArtifacts) {
    throw new Error("Jumlah artifact sandbox melampaui batas.");
  }
  let artifactBytes = 0;
  for (const artifact of value.artifacts) {
    validateArtifact(artifact, lease.attestation.limits);
    if (artifact.purpose === "workspace-snapshot") {
      throw new Error("Exec sandbox tidak boleh menyisipkan workspace snapshot.");
    }
    artifactBytes += artifact.size;
    if (artifactBytes > lease.attestation.limits.maxArtifactBytes) {
      throw new Error("Total artifact sandbox melampaui batas.");
    }
  }
  validateUsage(value.usage, lease.attestation.limits, request.timeoutMs);
  validIso(value.startedAt, "sandbox startedAt");
  validIso(value.completedAt, "sandbox completedAt");
  if (Date.parse(value.completedAt) < Date.parse(value.startedAt)) {
    throw new Error("Timestamp hasil sandbox tidak berurutan.");
  }
}

function validateArtifact(
  artifact: SandboxArtifactReference,
  limits: SandboxResourceLimits,
  expectedPurpose?: SandboxArtifactReference["purpose"],
): void {
  assertExactObject(
    artifact,
    ["artifactId", "sha256", "size", "mediaType", "purpose"],
    "sandbox artifact",
  );
  safeOpaqueTransportId(artifact.artifactId, "sandbox artifactId");
  if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
    throw new Error("Hash artifact sandbox tidak sah.");
  }
  if (
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 0 ||
    artifact.size > limits.maxArtifactBytes
  ) {
    throw new Error("Ukuran artifact sandbox tidak sah.");
  }
  safeText(artifact.mediaType, "sandbox artifact mediaType", 128);
  if (
    artifact.purpose !== "stdout" &&
    artifact.purpose !== "stderr" &&
    artifact.purpose !== "workspace-snapshot" &&
    artifact.purpose !== "build-artifact"
  ) {
    throw new Error("Purpose artifact sandbox tidak sah.");
  }
  if (expectedPurpose && artifact.purpose !== expectedPurpose) {
    throw new Error("Purpose artifact sandbox tidak cocok.");
  }
}

function validateUsage(
  usage: SandboxExecResult["usage"],
  limits: SandboxResourceLimits,
  timeoutMs: number,
): void {
  assertExactObject(
    usage,
    ["wallClockMs", "peakMemoryBytes", "cpuTimeMs", "outputBytes"],
    "sandbox resource usage",
  );
  if (
    !Number.isSafeInteger(usage.wallClockMs) ||
    usage.wallClockMs < 0 ||
    usage.wallClockMs > timeoutMs + 5_000 ||
    (usage.peakMemoryBytes !== null &&
      (!Number.isSafeInteger(usage.peakMemoryBytes) ||
        usage.peakMemoryBytes < 0 ||
        usage.peakMemoryBytes > limits.memoryBytes)) ||
    (usage.cpuTimeMs !== null &&
      (!Number.isSafeInteger(usage.cpuTimeMs) || usage.cpuTimeMs < 0)) ||
    !Number.isSafeInteger(usage.outputBytes) ||
    usage.outputBytes < 0
  ) {
    throw new Error("Resource usage sandbox tidak sah.");
  }
}

function validatedLimits(value: SandboxResourceLimits): SandboxResourceLimits {
  assertExactLimits(value);
  for (const [name, amount] of Object.entries(value) as Array<[string, number]>) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error(`Limit sandbox ${name} tidak sah.`);
    }
  }
  if (value.cpuCores > 64 || value.pids > 4096) {
    throw new Error("Limit sandbox melampaui policy maksimum Harvy.");
  }
  return Object.freeze({ ...value });
}

function validatedAdmission(value: SandboxAdmissionPolicy): Readonly<SandboxAdmissionPolicy> {
  assertExactObject(
    value,
    [
      "maxConcurrentLeases",
      "maxConcurrentLeasesPerOwner",
      "maxLeaseMs",
      "controlPlaneTimeoutMs",
    ],
    "sandbox admission policy",
  );
  for (const [name, amount] of Object.entries(value) as Array<[string, number]>) {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error(`Admission SandboxRunner ${name} tidak sah.`);
    }
  }
  if (value.maxConcurrentLeasesPerOwner > value.maxConcurrentLeases) {
    throw new Error("Admission per-owner tidak boleh melebihi total lease.");
  }
  return Object.freeze({ ...value });
}

function validateHealth(value: SandboxHealth): void {
  assertExactObject(
    value,
    ["available", "runtime", "identity", "checkedAt", "reason"],
    "sandbox health",
  );
  if (value.identity !== null) {
    assertExactObject(
      value.identity,
      ["serviceIdentityDigest", "runtimeImageDigest", "policyDigest"],
      "sandbox runtime identity",
    );
  }
  if (
    typeof value?.available !== "boolean" ||
    (value.runtime !== null && value.runtime !== "isolated-linux") ||
    (value.available && value.runtime !== "isolated-linux") ||
    (value.available && (
      !value.identity ||
      !/^[a-f0-9]{64}$/u.test(value.identity.serviceIdentityDigest) ||
      !/^[a-f0-9]{64}$/u.test(value.identity.runtimeImageDigest) ||
      !/^[a-f0-9]{64}$/u.test(value.identity.policyDigest)
    )) ||
    (!value.available && value.identity !== null) ||
    (value.available && value.reason !== null) ||
    (!value.available && (typeof value.reason !== "string" || !value.reason))
  ) {
    throw new Error("Status kesehatan SandboxRunner tidak sah.");
  }
  validIso(value.checkedAt, "sandbox health checkedAt");
}

function validateDisposalReceipt(
  value: SandboxDisposalReceipt,
  expectedLeaseId: string,
): void {
  assertExactObject(
    value,
    ["leaseId", "fenced", "completedAt"],
    "sandbox disposal receipt",
  );
  if (value.leaseId !== expectedLeaseId || value.fenced !== true) {
    throw new Error("Cancellation fence SandboxRunner tidak cocok dengan lease.");
  }
  validIso(value.completedAt, "sandbox disposal completedAt");
}

function sameLimits(
  left: SandboxResourceLimits,
  right: SandboxResourceLimits,
): boolean {
  return Object.keys(right).every(
    (key) =>
      left[key as keyof SandboxResourceLimits] ===
      right[key as keyof SandboxResourceLimits],
  );
}

function sameBinding(left: SandboxBinding, right: SandboxBinding): boolean {
  return left.ownerWorkspaceKey === right.ownerWorkspaceKey &&
    left.projectId === right.projectId &&
    left.snapshotId === right.snapshotId &&
    left.workspaceRevision === right.workspaceRevision &&
    left.runId === right.runId;
}

function sameLease(left: SandboxLease, right: SandboxLease): boolean {
  return left.leaseId === right.leaseId &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt &&
    sameBinding(left.binding, right.binding) &&
    JSON.stringify(left.attestation) === JSON.stringify(right.attestation);
}

function assertExactLimits(value: SandboxResourceLimits): void {
  assertExactObject(
    value,
    [
      "cpuCores",
      "memoryBytes",
      "diskBytes",
      "pids",
      "wallClockMs",
      "maxOutputBytes",
      "maxArtifacts",
      "maxArtifactBytes",
    ],
    "sandbox resource limits",
  );
}

function assertExactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} bukan object data yang sah.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} memiliki prototype yang tidak sah.`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.some((key) => typeof key !== "string") ||
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !actualKeys.includes(key))
  ) {
    throw new Error(`${label} memiliki field yang tidak dikenal atau kurang.`);
  }
}

function safeText(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${field} tidak sah.`);
  }
  return value;
}

function safeOpaqueTransportId(value: unknown, field: string): string {
  const clean = safeText(value, field, 256);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(clean) ||
    containsSecretLikeValue(clean)
  ) {
    throw new Error(`${field} bukan opaque ID yang aman.`);
  }
  return clean;
}

function safeArg(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 8_192 ||
    value.includes("\0") ||
    /[\r\n]/u.test(value) ||
    containsSecretLikeValue(value)
  ) {
    throw new Error("Argumen sandbox tidak sah.");
  }
  return value;
}

function validIso(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${field} tidak sah.`);
  }
}

function abortError(): Error {
  const error = new Error("Eksekusi sandbox dibatalkan.");
  error.name = "AbortError";
  return error;
}

function anyAbortSignal(
  input: AbortSignal | undefined,
  lifecycle: AbortSignal,
): AbortSignal {
  return input ? AbortSignal.any([input, lifecycle]) : lifecycle;
}
