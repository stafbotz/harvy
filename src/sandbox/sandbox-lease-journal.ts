import type {
  SandboxBinding,
  SandboxLease,
  SandboxLeaseJournal,
  SandboxLeaseJournalCreateResult,
  SandboxLeaseJournalRecord,
  SandboxLeaseJournalRemoveResult,
  SandboxLeaseJournalSaveResult,
  SandboxResourceLimits,
} from "../domain/sandbox.js";

/** Unit/dev adapter. Production composition must select a durable repository. */
export class MemorySandboxLeaseJournal implements SandboxLeaseJournal {
  private readonly records = new Map<string, SandboxLeaseJournalRecord>();

  async list(): Promise<SandboxLeaseJournalRecord[]> {
    return [...this.records.values()].map(cloneRecord);
  }

  async create(
    input: SandboxLeaseJournalRecord,
  ): Promise<SandboxLeaseJournalCreateResult> {
    const record = validateSandboxLeaseJournalRecord(input);
    assertInitialRecord(record);
    const existing = this.records.get(record.leaseId);
    if (existing) return { status: "exists", record: cloneRecord(existing) };
    this.records.set(record.leaseId, cloneRecord(record));
    return { status: "saved", record: cloneRecord(record) };
  }

  async save(
    input: SandboxLeaseJournalRecord,
    expectedRevision: number,
  ): Promise<SandboxLeaseJournalSaveResult> {
    const record = validateSandboxLeaseJournalRecord(input);
    const current = this.records.get(record.leaseId);
    if (!current || current.revision !== expectedRevision) {
      return {
        status: "conflict",
        record: current ? cloneRecord(current) : null,
      };
    }
    validateSandboxLeaseJournalTransition(current, record);
    this.records.set(record.leaseId, cloneRecord(record));
    return { status: "saved", record: cloneRecord(record) };
  }

  async remove(
    leaseId: string,
    expectedRevision: number,
  ): Promise<SandboxLeaseJournalRemoveResult> {
    const current = this.records.get(leaseId);
    if (!current || current.revision !== expectedRevision) {
      return {
        status: "conflict",
        record: current ? cloneRecord(current) : null,
      };
    }
    if (current.state !== "disposing") {
      throw new Error("Sandbox journal hanya dapat menghapus record disposing.");
    }
    this.records.delete(leaseId);
    return { status: "removed" };
  }
}

export function validateSandboxLeaseJournalRecord(
  input: SandboxLeaseJournalRecord,
): SandboxLeaseJournalRecord {
  exactObject(
    input,
    [
      "version",
      "leaseId",
      "revision",
      "state",
      "binding",
      "limits",
      "lease",
      "lastErrorCode",
      "createdAt",
      "updatedAt",
    ],
    "sandbox lease journal record",
  );
  if (input.version !== 1) throw new Error("Versi sandbox lease journal tidak sah.");
  safeId(input.leaseId, "leaseId");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error("Revision sandbox lease journal tidak sah.");
  }
  if (
    (input.state === "allocating" && input.revision !== 1) ||
    (input.state !== "allocating" && input.revision < 2)
  ) {
    throw new Error("Revision awal/state sandbox lease journal tidak konsisten.");
  }
  if (
    input.state !== "allocating" &&
    input.state !== "active" &&
    input.state !== "quarantined" &&
    input.state !== "disposing"
  ) {
    throw new Error("State sandbox lease journal tidak sah.");
  }
  validateBinding(input.binding);
  validateLimits(input.limits);
  if (input.state === "allocating" && input.lease !== null) {
    throw new Error("Record allocating tidak boleh memuat lease.");
  }
  if (
    (input.state === "active" || input.state === "quarantined") &&
    input.lease === null
  ) {
    throw new Error("Record sandbox aktif/karantina wajib memuat lease.");
  }
  if (input.lease) validateLease(input.lease, input);
  if (
    input.lastErrorCode !== null &&
    (typeof input.lastErrorCode !== "string" ||
      !/^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(input.lastErrorCode))
  ) {
    throw new Error("lastErrorCode sandbox lease journal tidak sah.");
  }
  validIso(input.createdAt, "createdAt");
  validIso(input.updatedAt, "updatedAt");
  if (Date.parse(input.updatedAt) < Date.parse(input.createdAt)) {
    throw new Error("updatedAt sandbox lease journal mendahului createdAt.");
  }
  return cloneRecord(input);
}

export function validateSandboxLeaseJournalTransition(
  beforeInput: SandboxLeaseJournalRecord,
  afterInput: SandboxLeaseJournalRecord,
): void {
  const before = validateSandboxLeaseJournalRecord(beforeInput);
  const after = validateSandboxLeaseJournalRecord(afterInput);
  if (
    before.leaseId !== after.leaseId ||
    before.version !== after.version ||
    before.createdAt !== after.createdAt ||
    !sameBinding(before.binding, after.binding) ||
    !sameLimits(before.limits, after.limits)
  ) {
    throw new Error("Identity sandbox lease journal berubah.");
  }
  if (after.revision !== before.revision + 1) {
    throw new Error("Revision sandbox lease journal harus CAS +1.");
  }
  const allowed =
    (before.state === "allocating" &&
      (after.state === "active" ||
        after.state === "quarantined" ||
        after.state === "disposing")) ||
    (before.state === "active" &&
      (after.state === "quarantined" || after.state === "disposing")) ||
    (before.state === "quarantined" && after.state === "disposing") ||
    (before.state === "disposing" && after.state === "disposing");
  if (!allowed) {
    throw new Error(`Transisi sandbox journal ${before.state}→${after.state} ditolak.`);
  }
  if (before.lease && after.lease && !sameLease(before.lease, after.lease)) {
    throw new Error("Lease sandbox journal berubah setelah dicatat.");
  }
  if (before.lease && !after.lease) {
    throw new Error("Lease sandbox journal tidak boleh dihapus sebelum record terminal.");
  }
}

function validateLease(
  lease: SandboxLease,
  record: SandboxLeaseJournalRecord,
): void {
  exactObject(
    lease,
    ["leaseId", "binding", "attestation", "createdAt", "expiresAt"],
    "sandbox lease journal lease",
  );
  if (lease.leaseId !== record.leaseId || !sameBinding(lease.binding, record.binding)) {
    throw new Error("Lease sandbox journal tidak cocok dengan binding.");
  }
  validIso(lease.createdAt, "lease.createdAt");
  validIso(lease.expiresAt, "lease.expiresAt");
  exactObject(
    lease.attestation,
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
    "sandbox lease journal attestation",
  );
  const attestation = lease.attestation;
  if (
    attestation.version !== 1 ||
    attestation.runtime !== "isolated-linux" ||
    attestation.unprivilegedUser !== true ||
    attestation.noHarvySecrets !== true ||
    attestation.noProviderSecrets !== true ||
    attestation.noGitHubSecrets !== true ||
    attestation.noHarvyDataMount !== true ||
    attestation.noHostRootMount !== true ||
    attestation.noDockerSocket !== true ||
    attestation.noPrivilegedDevices !== true ||
    attestation.capabilitiesDropped !== true ||
    attestation.syscallFilter !== true ||
    attestation.readOnlyRootFilesystem !== true ||
    attestation.disposable !== true ||
    attestation.network !== "off" ||
    !sameLimits(attestation.limits, record.limits)
  ) {
    throw new Error("Attestation sandbox journal tidak sah.");
  }
}

function validateBinding(binding: SandboxBinding): void {
  exactObject(
    binding,
    ["ownerWorkspaceKey", "projectId", "snapshotId", "workspaceRevision", "runId"],
    "sandbox journal binding",
  );
  safeText(binding.ownerWorkspaceKey, "ownerWorkspaceKey", 512);
  safeId(binding.projectId, "projectId");
  if (!/^[a-f0-9]{64}$/u.test(binding.snapshotId)) {
    throw new Error("snapshotId sandbox journal tidak sah.");
  }
  if (!Number.isSafeInteger(binding.workspaceRevision) || binding.workspaceRevision < 1) {
    throw new Error("workspaceRevision sandbox journal tidak sah.");
  }
  safeId(binding.runId, "runId");
}

function validateLimits(limits: SandboxResourceLimits): void {
  exactObject(
    limits,
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
    "sandbox journal limits",
  );
  for (const value of Object.values(limits) as number[]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Limit sandbox journal tidak sah.");
    }
  }
}

function sameLease(left: SandboxLease, right: SandboxLease): boolean {
  return left.leaseId === right.leaseId &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt &&
    sameBinding(left.binding, right.binding) &&
    JSON.stringify(left.attestation) === JSON.stringify(right.attestation);
}

function sameBinding(left: SandboxBinding, right: SandboxBinding): boolean {
  return left.ownerWorkspaceKey === right.ownerWorkspaceKey &&
    left.projectId === right.projectId &&
    left.snapshotId === right.snapshotId &&
    left.workspaceRevision === right.workspaceRevision &&
    left.runId === right.runId;
}

function sameLimits(
  left: SandboxResourceLimits,
  right: SandboxResourceLimits,
): boolean {
  return left.cpuCores === right.cpuCores &&
    left.memoryBytes === right.memoryBytes &&
    left.diskBytes === right.diskBytes &&
    left.pids === right.pids &&
    left.wallClockMs === right.wallClockMs &&
    left.maxOutputBytes === right.maxOutputBytes &&
    left.maxArtifacts === right.maxArtifacts &&
    left.maxArtifactBytes === right.maxArtifactBytes;
}

function cloneRecord(record: SandboxLeaseJournalRecord): SandboxLeaseJournalRecord {
  return structuredClone(record);
}

export function assertInitialRecord(record: SandboxLeaseJournalRecord): void {
  if (record.state !== "allocating" || record.revision !== 1 || record.lease !== null) {
    throw new Error("Record sandbox journal baru wajib allocating revision 1.");
  }
}

function exactObject(
  input: unknown,
  keys: readonly string[],
  label: string,
): asserts input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} harus object.`);
  }
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} memuat field yang tidak dikenal.`);
  }
}

function safeId(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new Error(`${field} sandbox journal tidak sah.`);
  }
}

function safeText(value: unknown, field: string, max: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${field} sandbox journal tidak sah.`);
  }
}

function validIso(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${field} sandbox journal tidak sah.`);
  }
}
