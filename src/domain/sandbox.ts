export type SandboxNetworkPolicy = "off";

export interface SandboxResourceLimits {
  cpuCores: number;
  memoryBytes: number;
  diskBytes: number;
  pids: number;
  wallClockMs: number;
  maxOutputBytes: number;
  maxArtifacts: number;
  maxArtifactBytes: number;
}

export interface SandboxBinding {
  ownerWorkspaceKey: string;
  projectId: string;
  snapshotId: string;
  workspaceRevision: number;
  runId: string;
}

export type SandboxInputSnapshotDescriptor = ProjectSnapshotBundleDescriptor;

/**
 * Handle internal Harvy. Hanya descriptor yang boleh melewati transport;
 * fungsi open dan filesystem backing-nya tidak boleh diserialisasi/log/model.
 */
export type SandboxInputSnapshotSource = ProjectSnapshotBundleSource;

/** Security facts asserted by the isolated runner, never by project code. */
export interface SandboxSecurityAttestation {
  version: 1;
  runtime: "isolated-linux";
  unprivilegedUser: true;
  noHarvySecrets: true;
  noProviderSecrets: true;
  noGitHubSecrets: true;
  noHarvyDataMount: true;
  noHostRootMount: true;
  noDockerSocket: true;
  noPrivilegedDevices: true;
  capabilitiesDropped: true;
  syscallFilter: true;
  readOnlyRootFilesystem: true;
  disposable: true;
  network: SandboxNetworkPolicy;
  limits: SandboxResourceLimits;
}

export interface SandboxLease {
  leaseId: string;
  binding: SandboxBinding;
  attestation: SandboxSecurityAttestation;
  createdAt: string;
  expiresAt: string;
}

export type SandboxExecutionPurpose =
  | "inspect"
  | "test"
  | "lint"
  | "typecheck"
  | "build";

export interface SandboxExecRequest {
  /** argv only; shell text/interpolation is intentionally not part of the port. */
  argv: readonly [string, ...string[]];
  cwd: string;
  purpose: SandboxExecutionPurpose;
  timeoutMs: number;
}

export interface SandboxArtifactReference {
  artifactId: string;
  sha256: string;
  size: number;
  mediaType: string;
  purpose: "stdout" | "stderr" | "workspace-snapshot" | "build-artifact";
}

export interface SandboxResourceUsage {
  wallClockMs: number;
  peakMemoryBytes: number | null;
  cpuTimeMs: number | null;
  outputBytes: number;
}

export type SandboxExecStatus =
  | "exited"
  | "timed_out"
  | "resource_exhausted"
  | "cancelled"
  | "infrastructure_error";

export interface SandboxExecResult {
  operationId: string;
  requestDigest: string;
  executionId: string;
  leaseId: string;
  status: SandboxExecStatus;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  artifacts: SandboxArtifactReference[];
  usage: SandboxResourceUsage;
  startedAt: string;
  completedAt: string;
}

export interface SandboxSnapshotResult {
  leaseId: string;
  snapshot: SandboxArtifactReference;
  sourceWorkspaceRevision: number;
  createdAt: string;
}

/**
 * ACK ini adalah cancellation fence: setelah diterbitkan, lease/allocation ID
 * yang sama tidak dapat muncul kembali walaupun allocate lama settle terlambat.
 */
export interface SandboxDisposalReceipt {
  leaseId: string;
  fenced: true;
  completedAt: string;
}

export type SandboxLeaseJournalState =
  | "allocating"
  | "active"
  | "quarantined"
  | "disposing";

/** Durable lifecycle intent; it contains no host path, environment, or secret. */
export interface SandboxLeaseJournalRecord {
  version: 1;
  leaseId: string;
  revision: number;
  state: SandboxLeaseJournalState;
  binding: SandboxBinding;
  limits: SandboxResourceLimits;
  lease: SandboxLease | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SandboxLeaseJournalCreateResult =
  | { status: "saved"; record: SandboxLeaseJournalRecord }
  | { status: "exists"; record: SandboxLeaseJournalRecord };

export type SandboxLeaseJournalSaveResult =
  | { status: "saved"; record: SandboxLeaseJournalRecord }
  | { status: "conflict"; record: SandboxLeaseJournalRecord | null };

export type SandboxLeaseJournalRemoveResult =
  | { status: "removed" }
  | { status: "conflict"; record: SandboxLeaseJournalRecord | null };

export interface SandboxLeaseJournal {
  list(): Promise<SandboxLeaseJournalRecord[]>;
  create(record: SandboxLeaseJournalRecord): Promise<SandboxLeaseJournalCreateResult>;
  save(
    record: SandboxLeaseJournalRecord,
    expectedRevision: number,
  ): Promise<SandboxLeaseJournalSaveResult>;
  remove(
    leaseId: string,
    expectedRevision: number,
  ): Promise<SandboxLeaseJournalRemoveResult>;
  /** Optional lifecycle hook for adapters that own a database handle. */
  close?(): void | Promise<void>;
}

export interface SandboxHealth {
  available: boolean;
  runtime: "isolated-linux" | null;
  identity: {
    serviceIdentityDigest: string;
    runtimeImageDigest: string;
    policyDigest: string;
  } | null;
  checkedAt: string;
  reason: string | null;
}

export interface SandboxRunner {
  health(): Promise<SandboxHealth>;
  allocate(
    binding: SandboxBinding,
    snapshot: SandboxInputSnapshotSource,
  ): Promise<SandboxLease>;
  execute(
    lease: SandboxLease,
    request: SandboxExecRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult>;
  captureSnapshot(lease: SandboxLease): Promise<SandboxSnapshotResult>;
  readArtifact(
    lease: SandboxLease,
    artifact: SandboxArtifactReference,
  ): Promise<Uint8Array>;
  dispose(lease: SandboxLease): Promise<void>;
  /**
   * Durable project-deletion fence. Success means every matching journaled
   * allocation has an exact backend cancellation ACK and has been removed.
   */
  fenceProjectRuns(input: {
    ownerWorkspaceKey: string;
    projectId: string;
  }): Promise<void>;
}

/** App-owned lifecycle; capability consumers only receive `SandboxRunner`. */
export interface SandboxRunnerLifecycle {
  start(): Promise<SandboxHealth>;
  stop(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** Dependency download is a different capability and never implicit egress. */
export interface DependencyFetchBroker {
  fetch(input: {
    projectId: string;
    workspaceRevision: number;
    ecosystem: "npm" | "pypi" | "cargo" | "maven";
    lockfileSha256: string;
  }): Promise<SandboxArtifactReference>;
}
import type {
  ProjectSnapshotBundleDescriptor,
  ProjectSnapshotBundleSource,
} from "./project-transfer.js";
