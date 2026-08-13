import type {
  SandboxArtifactReference,
  SandboxBinding,
  SandboxDisposalReceipt,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxHealth,
  SandboxInputSnapshotDescriptor,
  SandboxLease,
  SandboxNetworkPolicy,
  SandboxResourceLimits,
  SandboxSnapshotResult,
} from "../domain/sandbox.js";

export interface SandboxAllocationRequest {
  /** Code-owned idempotency/cleanup handle; the backend must echo it as leaseId. */
  leaseId: string;
  binding: SandboxBinding;
  network: SandboxNetworkPolicy;
  limits: SandboxResourceLimits;
  snapshot: SandboxInputSnapshotDescriptor;
}

export interface SandboxTransportExecutionRequest {
  version: 1;
  operationId: string;
  requestDigest: string;
  request: SandboxExecRequest;
}

/**
 * This transport crosses into a separately isolated execution service. The
 * request deliberately has no environment, credential, host path or mount.
 */
export interface SandboxTransport {
  health(signal?: AbortSignal): Promise<SandboxHealth>;
  allocate(
    request: SandboxAllocationRequest,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<SandboxLease>;
  execute(
    leaseId: string,
    request: SandboxTransportExecutionRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult>;
  captureSnapshot(leaseId: string, signal?: AbortSignal): Promise<SandboxSnapshotResult>;
  downloadArtifact(
    leaseId: string,
    artifact: SandboxArtifactReference,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array>;
  /**
   * Idempotent cancellation fence. A successful receipt proves this ID cannot
   * become live later, including an allocate request that settles after abort.
   */
  cancelAndDispose(
    leaseId: string,
    signal?: AbortSignal,
  ): Promise<SandboxDisposalReceipt>;
}

export class UnavailableSandboxTransport implements SandboxTransport {
  constructor(
    private readonly reason = "Isolated SandboxRunner belum dikonfigurasi.",
    private readonly now: () => Date = () => new Date(),
  ) {}

  async health(_signal?: AbortSignal): Promise<SandboxHealth> {
    return {
      available: false,
      runtime: null,
      checkedAt: this.now().toISOString(),
      reason: this.reason,
    };
  }

  async allocate(
    _request: SandboxAllocationRequest,
    _content: AsyncIterable<Uint8Array>,
    _signal?: AbortSignal,
  ): Promise<SandboxLease> {
    throw new Error(this.reason);
  }

  async execute(
    _leaseId: string,
    _request: SandboxTransportExecutionRequest,
    _signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    throw new Error(this.reason);
  }

  async captureSnapshot(
    _leaseId: string,
    _signal?: AbortSignal,
  ): Promise<SandboxSnapshotResult> {
    throw new Error(this.reason);
  }

  async *downloadArtifact(
    _leaseId: string,
    _artifact: SandboxArtifactReference,
    _signal?: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    throw new Error(this.reason);
  }

  async cancelAndDispose(
    _leaseId: string,
    _signal?: AbortSignal,
  ): Promise<SandboxDisposalReceipt> {
    throw new Error(this.reason);
  }
}
