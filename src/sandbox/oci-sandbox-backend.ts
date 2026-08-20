import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  SandboxArtifactReference,
  SandboxDisposalReceipt,
  SandboxExecResult,
  SandboxHealth,
  SandboxLease,
  SandboxSecurityAttestation,
  SandboxSnapshotResult,
} from "../domain/sandbox.js";
import type { ProjectSnapshotBundleDescriptor } from "../domain/project-transfer.js";
import type {
  SandboxAllocationRequest,
  SandboxTransportExecutionRequest,
} from "./sandbox-transport.js";
import { extractProjectSnapshotBundle } from "./snapshot-bundle-codec.js";
import { createSandboxSnapshotSource } from "./snapshot-bundle.js";
import { scanProjectTree } from "../core/project-files.js";
import {
  SpawnOciCommandRunner,
  type OciCommandResult,
  type OciCommandRunner,
} from "./oci-command-runner.js";

const CONTROL_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const RECORD_VERSION = 1;
const CONTAINER_USER = "65532:65532";
const OCI_POLICY_DESCRIPTOR = Object.freeze({
  version: 1,
  runtime: "rootless-podman",
  network: "none",
  rootFilesystem: "read-only",
  capabilities: "drop-all",
  noNewPrivileges: true,
  namespaces: ["user", "pid", "ipc", "uts", "cgroup"],
  writableFilesystems: ["tmpfs:/workspace", "tmpfs:/tmp"],
});
const FORBIDDEN_SECRET_ENV = new Set([
  "TELEGRAM_BOT_TOKEN",
  "HARVY_CONSOLE_TOKEN",
  "HARVY_WORKSPACE_PRINCIPAL_SECRET_FILE",
  "AI_TESTING_FALLBACK_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_AI_STUDIO_API_KEYS",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AZURE_CLIENT_SECRET",
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  "MYSQL_PASSWORD",
  "REDIS_URL",
  "SESSION_FILE",
  "WHATSAPP_SESSION",
  "WHATSAPP_CREDENTIAL",
]);

export interface OciSandboxBackendOptions {
  dataRoot: string;
  image: string;
  seccompProfile: string;
  ociCommand?: string;
  tarCommand?: string;
  commandEnvironment: Readonly<Record<string, string>>;
  serviceIdentityDigest: string;
  maxLeaseMs?: number;
  now?: () => Date;
  makeId?: () => string;
  runner?: OciCommandRunner;
  platform?: NodeJS.Platform;
  uid?: number | null;
  serviceEnvironment?: Readonly<Record<string, string | undefined>>;
}

interface OciLeaseRecord {
  version: 1;
  leaseId: string;
  containerName: string;
  state: "active" | "fenced";
  lease: SandboxLease | null;
  createdAt: string;
  updatedAt: string;
}

interface StoredArtifact {
  reference: SandboxArtifactReference;
  path: string;
}

/**
 * Concrete rootless-Podman backend for the separate Linux sandbox service.
 * Project bytes cross through a verified bundle and a service-owned staging
 * area; no host path is ever mounted into the hostile container.
 */
export class OciSandboxBackend {
  readonly #dataRoot: string;
  readonly #recordsRoot: string;
  readonly #leasesRoot: string;
  readonly #image: string;
  readonly #seccompProfile: string;
  readonly #ociCommand: string;
  readonly #tarCommand: string;
  readonly #commandEnvironment: Readonly<Record<string, string>>;
  readonly #serviceIdentityDigest: string;
  readonly #maxLeaseMs: number;
  readonly #now: () => Date;
  readonly #makeId: () => string;
  readonly #runner: OciCommandRunner;
  readonly #platform: NodeJS.Platform;
  readonly #uid: number | null;
  readonly #serviceEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #queues = new Map<string, Promise<void>>();
  #initialized = false;

  constructor(options: OciSandboxBackendOptions) {
    this.#dataRoot = safeAbsolutePath(options.dataRoot, "sandbox dataRoot");
    this.#recordsRoot = join(this.#dataRoot, "records");
    this.#leasesRoot = join(this.#dataRoot, "leases");
    this.#image = pinnedImage(options.image);
    this.#seccompProfile = safeAbsolutePath(options.seccompProfile, "seccomp profile");
    this.#ociCommand = safeExecutable(options.ociCommand ?? "podman");
    this.#tarCommand = safeExecutable(options.tarCommand ?? "/usr/bin/tar");
    this.#commandEnvironment = validateCommandEnvironment(options.commandEnvironment);
    this.#serviceIdentityDigest = sha256Digest(
      options.serviceIdentityDigest,
      "sandbox service identity digest",
    );
    this.#maxLeaseMs = boundedInteger(
      options.maxLeaseMs ?? 30 * 60_000,
      "sandbox maxLeaseMs",
      1_000,
      24 * 60 * 60_000,
    );
    this.#now = options.now ?? (() => new Date());
    this.#makeId = options.makeId ?? randomUUID;
    this.#runner = options.runner ?? new SpawnOciCommandRunner();
    this.#platform = options.platform ?? process.platform;
    this.#uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
    this.#serviceEnvironment = options.serviceEnvironment ?? process.env;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#dataRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.#recordsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.#leasesRoot, { recursive: true, mode: 0o700 });
    await assertRealDirectory(this.#dataRoot);
    await this.#removeAllHarvyContainers();
    for (const name of await readdir(this.#recordsRoot)) {
      if (!name.endsWith(".json")) continue;
      const record = await this.#readRecordFile(join(this.#recordsRoot, name));
      if (record.state === "active") {
        await this.#writeRecord({
          ...record,
          state: "fenced",
          lease: null,
          updatedAt: this.#now().toISOString(),
        });
      }
      await this.#removeLeaseData(record.leaseId);
    }
    this.#initialized = true;
  }

  async health(): Promise<SandboxHealth> {
    const checkedAt = this.#now().toISOString();
    try {
      if (!this.#initialized) throw new Error("backend belum diinisialisasi");
      if (this.#platform !== "linux" || this.#uid === null || this.#uid === 0) {
        throw new Error("sandbox service wajib Linux non-root");
      }
      for (const name of FORBIDDEN_SECRET_ENV) {
        if (this.#serviceEnvironment[name]) {
          throw new Error("sandbox service menerima environment credential terlarang");
        }
      }
      const seccomp = await lstat(this.#seccompProfile);
      if (!seccomp.isFile() || seccomp.isSymbolicLink() || seccomp.size > 16 * 1_024 * 1_024) {
        throw new Error("seccomp profile bukan file nyata");
      }
      const seccompBytes = await readFile(this.#seccompProfile);
      const seccompJson = JSON.parse(seccompBytes.toString("utf8")) as unknown;
      if (!seccompJson || typeof seccompJson !== "object" || Array.isArray(seccompJson)) {
        throw new Error("seccomp profile bukan object JSON");
      }
      const tar = await lstat(this.#tarCommand);
      if (!tar.isFile() || tar.isSymbolicLink()) throw new Error("tar executable tidak sah");
      const info = await this.#control(["info", "--format", "json"], 15_000);
      if (info.exitCode !== 0) throw new Error("rootless OCI runtime tidak sehat");
      const runtimeIdentity = rootlessPodmanIdentity(info.stdout);
      const image = await this.#control(["image", "exists", this.#image], 15_000);
      if (image.exitCode !== 0) throw new Error("image sandbox pinned belum tersedia lokal");
      return {
        available: true,
        runtime: "isolated-linux",
        identity: {
          serviceIdentityDigest: this.#serviceIdentityDigest,
          runtimeImageDigest: imageDigest(this.#image),
          policyDigest: createHash("sha256")
            .update("harvy-oci-sandbox-policy/1\0", "utf8")
            .update(JSON.stringify(OCI_POLICY_DESCRIPTOR), "utf8")
            .update("\0", "utf8")
            .update(JSON.stringify(runtimeIdentity), "utf8")
            .update("\0", "utf8")
            .update(seccompBytes)
            .digest("hex"),
        },
        checkedAt,
        reason: null,
      };
    } catch {
      return {
        available: false,
        runtime: null,
        identity: null,
        checkedAt,
        reason: "Rootless isolated Linux sandbox belum memenuhi conformance deployment.",
      };
    }
  }

  async shutdown(): Promise<void> {
    for (const name of await readdir(this.#recordsRoot).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const record = await this.#readRecordFile(join(this.#recordsRoot, name)).catch(() => null);
      if (record?.state === "active") {
        await this.cancelAndDispose(record.leaseId);
      }
    }
    await this.#removeAllHarvyContainers();
    this.#initialized = false;
  }

  async allocate(
    request: SandboxAllocationRequest,
    content: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<SandboxLease> {
    return this.#exclusive(request.leaseId, async () => {
      await this.#assertHealthy();
      const existing = await this.#readRecord(request.leaseId);
      if (existing?.state === "fenced") throw new Error("Lease sandbox sudah difence.");
      if (existing?.state === "active" && existing.lease) {
        await drain(content, signal);
        if (JSON.stringify(existing.lease.binding) !== JSON.stringify(request.binding)) {
          throw new Error("Lease sandbox bertabrakan dengan binding lain.");
        }
        return structuredClone(existing.lease);
      }
      const leaseRoot = this.#leaseRoot(request.leaseId);
      const stagingRoot = join(leaseRoot, "staging");
      const bundlePath = join(leaseRoot, "input.bundle");
      const tarPath = join(leaseRoot, "input.tar");
      await rm(leaseRoot, { recursive: true, force: true });
      await mkdir(leaseRoot, { recursive: false, mode: 0o700 });
      const containerName = containerNameFor(request.leaseId);
      const createdAt = this.#now().toISOString();
      const allocating: OciLeaseRecord = {
        version: RECORD_VERSION,
        leaseId: request.leaseId,
        containerName,
        state: "active",
        lease: null,
        createdAt,
        updatedAt: createdAt,
      };
      await this.#writeRecord(allocating);
      let containerCreated = false;
      try {
        await writeVerifiedContent(bundlePath, content, request.snapshot, signal);
        const manifest = await extractProjectSnapshotBundle(
          bundlePath,
          stagingRoot,
          request.snapshot,
          { maxExtractedBytes: request.limits.diskBytes },
        );
        if (manifest.totalBytes > request.limits.diskBytes) {
          throw new Error("Snapshot sandbox melampaui disk quota.");
        }
        const archived = await this.#run(
          this.#tarCommand,
          ["--format=posix", "--create", `--file=${tarPath}`, `--directory=${stagingRoot}`, "."],
          60_000,
          CONTROL_OUTPUT_BYTES,
          signal,
        );
        assertSuccessfulControl(archived, "pembuatan archive staging sandbox");
        const tarState = await lstat(tarPath);
        if (!tarState.isFile() || tarState.size > request.limits.diskBytes + 64 * 1_024 * 1_024) {
          throw new Error("Archive staging sandbox tidak sah atau terlalu besar.");
        }
        const create = await this.#control(
          this.#createArgs(request, containerName),
          60_000,
          signal,
        );
        assertSuccessfulControl(create, "create container sandbox");
        containerCreated = true;
        const start = await this.#control(["start", containerName], 30_000, signal);
        assertSuccessfulControl(start, "start container sandbox");
        const install = await this.#run(
          this.#ociCommand,
          [
            "exec",
            "--interactive",
            "--user",
            CONTAINER_USER,
            "--workdir",
            "/workspace",
            containerName,
            "/bin/tar",
            "--extract",
            "--file=-",
            "--no-same-owner",
            "--no-same-permissions",
          ],
          Math.min(request.limits.wallClockMs, 5 * 60_000),
          CONTROL_OUTPUT_BYTES,
          signal,
          tarPath,
        );
        assertSuccessfulControl(install, "install snapshot ke container sandbox");
        const verify = await this.#control([
          "exec",
          "--user",
          CONTAINER_USER,
          "--workdir",
          "/workspace",
          containerName,
          "/usr/bin/test",
          "-w",
          "/workspace",
        ], 15_000, signal);
        assertSuccessfulControl(verify, "verifikasi user non-root sandbox");
        const expiresAt = new Date(this.#now().getTime() + this.#maxLeaseMs).toISOString();
        const lease: SandboxLease = {
          leaseId: request.leaseId,
          binding: structuredClone(request.binding),
          attestation: attestation(request),
          createdAt,
          expiresAt,
        };
        await this.#writeRecord({
          ...allocating,
          lease,
          updatedAt: this.#now().toISOString(),
        });
        await rm(stagingRoot, { recursive: true, force: true });
        await rm(bundlePath, { force: true });
        await rm(tarPath, { force: true });
        return structuredClone(lease);
      } catch (error) {
        if (containerCreated) await this.#removeContainer(containerName).catch(() => undefined);
        await this.#writeRecord({
          ...allocating,
          state: "fenced",
          lease: null,
          updatedAt: this.#now().toISOString(),
        }).catch(() => undefined);
        await rm(leaseRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async execute(
    leaseId: string,
    transportRequest: SandboxTransportExecutionRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    return this.#exclusive(leaseId, async () => {
      const record = await this.#activeRecord(leaseId);
      const lease = record.lease!;
      verifyExecutionDigest(lease, transportRequest);
      const startedAt = this.#now().toISOString();
      const request = transportRequest.request;
      const cwd = request.cwd === "." ? "/workspace" : `/workspace/${request.cwd}`;
      const maximumCapture = Math.min(
        lease.attestation.limits.maxArtifactBytes,
        2 * 1_024 * 1_024 * 1_024,
      );
      const outcome = await this.#run(
        this.#ociCommand,
        [
          "exec",
          "--user",
          CONTAINER_USER,
          "--workdir",
          cwd,
          record.containerName,
          ...request.argv,
        ],
        request.timeoutMs,
        maximumCapture,
        signal,
      );
      const status = executionStatus(outcome);
      if (status !== "exited") {
        await this.#removeContainer(record.containerName).catch(() => undefined);
        await this.#writeRecord({
          ...record,
          state: "fenced",
          lease: null,
          updatedAt: this.#now().toISOString(),
        });
      }
      const output = await this.#executionOutput(lease, outcome);
      const completedAt = this.#now().toISOString();
      return {
        operationId: transportRequest.operationId,
        requestDigest: transportRequest.requestDigest,
        executionId: `sandbox-execution-${safeOpaque(this.#makeId(), "executionId")}`,
        leaseId,
        status,
        exitCode: status === "exited" ? outcome.exitCode : null,
        signal: outcome.signal,
        stdout: output.stdout,
        stderr: output.stderr,
        truncated: output.truncated,
        artifacts: output.artifacts,
        usage: {
          wallClockMs: Math.min(outcome.wallClockMs, request.timeoutMs + 5_000),
          peakMemoryBytes: null,
          cpuTimeMs: null,
          outputBytes: Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr),
        },
        startedAt,
        completedAt,
      };
    });
  }

  async captureSnapshot(leaseId: string, signal?: AbortSignal): Promise<SandboxSnapshotResult> {
    return this.#exclusive(leaseId, async () => {
      const record = await this.#activeRecord(leaseId);
      const lease = record.lease!;
      const captureRoot = join(this.#leaseRoot(leaseId), `capture-${safeOpaque(this.#makeId(), "capture")}`);
      await mkdir(captureRoot, { recursive: false, mode: 0o700 });
      try {
        const copied = await this.#control(
          ["cp", `${record.containerName}:/workspace/.`, captureRoot],
          Math.min(lease.attestation.limits.wallClockMs, 5 * 60_000),
          signal,
        );
        assertSuccessfulControl(copied, "capture workspace sandbox");
        const manifest = await scanProjectTree(captureRoot, {
          limits: {
            maxFiles: 10_000,
            maxTotalBytes: lease.attestation.limits.maxArtifactBytes,
            maxFileBytes: lease.attestation.limits.maxArtifactBytes,
            maxDepth: 32,
            maxPathCharacters: 240,
          },
          now: this.#now,
        });
        const source = await createSandboxSnapshotSource(captureRoot, manifest);
        if (source.descriptor.size > lease.attestation.limits.maxArtifactBytes) {
          throw new Error("Snapshot artifact sandbox melampaui quota.");
        }
        const artifact = await this.#storeStreamArtifact(
          leaseId,
          "workspace-snapshot",
          source.descriptor.mediaType,
          source.open(),
          source.descriptor.size,
          source.descriptor.bundleSha256,
          signal,
        );
        return {
          leaseId,
          snapshot: artifact,
          sourceWorkspaceRevision: lease.binding.workspaceRevision,
          createdAt: this.#now().toISOString(),
        };
      } finally {
        await rm(captureRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async artifact(
    leaseId: string,
    reference: SandboxArtifactReference,
  ): Promise<StoredArtifact> {
    const record = await this.#readRecord(leaseId);
    if (!record) throw new Error("Lease artifact sandbox tidak dikenal.");
    const id = safeArtifactId(reference.artifactId);
    const metadataPath = join(this.#leaseRoot(leaseId), "artifacts", `${id}.json`);
    const raw = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    const stored = parseStoredArtifact(raw, this.#leaseRoot(leaseId));
    if (JSON.stringify(stored.reference) !== JSON.stringify(reference)) {
      throw new Error("Descriptor artifact sandbox tidak cocok storage.");
    }
    return stored;
  }

  async cancelAndDispose(leaseId: string): Promise<SandboxDisposalReceipt> {
    return this.#exclusive(leaseId, async () => {
      const existing = await this.#readRecord(leaseId);
      const containerName = existing?.containerName ?? containerNameFor(leaseId);
      await this.#removeContainer(containerName);
      const at = this.#now().toISOString();
      await this.#writeRecord({
        version: RECORD_VERSION,
        leaseId,
        containerName,
        state: "fenced",
        lease: null,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      });
      await this.#removeLeaseData(leaseId);
      return { leaseId, fenced: true, completedAt: at };
    });
  }

  async #executionOutput(
    lease: SandboxLease,
    outcome: OciCommandResult,
  ): Promise<{
    stdout: string;
    stderr: string;
    truncated: boolean;
    artifacts: SandboxArtifactReference[];
  }> {
    const maximumInline = lease.attestation.limits.maxOutputBytes;
    const combined = outcome.stdout.byteLength + outcome.stderr.byteLength;
    if (!outcome.outputExceeded && combined <= maximumInline) {
      const decodedStdout = outcome.stdout.toString("utf8");
      const decodedStderr = outcome.stderr.toString("utf8");
      if (Buffer.byteLength(decodedStdout) + Buffer.byteLength(decodedStderr) <= maximumInline) {
        return {
          stdout: decodedStdout,
          stderr: decodedStderr,
          truncated: false,
          artifacts: [],
        };
      }
    }
    const artifacts: SandboxArtifactReference[] = [];
    if (outcome.stdout.byteLength > 0) {
      artifacts.push(await this.#storeBytesArtifact(
        lease.leaseId,
        "stdout",
        "text/plain",
        outcome.stdout,
      ));
    }
    if (outcome.stderr.byteLength > 0) {
      artifacts.push(await this.#storeBytesArtifact(
        lease.leaseId,
        "stderr",
        "text/plain",
        outcome.stderr,
      ));
    }
    const stdout = boundedUtf8(outcome.stdout, maximumInline);
    const stderrBudget = Math.max(0, maximumInline - Buffer.byteLength(stdout));
    const stderr = boundedUtf8(outcome.stderr, stderrBudget);
    return {
      stdout,
      stderr,
      truncated: true,
      artifacts,
    };
  }

  async #storeBytesArtifact(
    leaseId: string,
    purpose: SandboxArtifactReference["purpose"],
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<SandboxArtifactReference> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return this.#storeStreamArtifact(
      leaseId,
      purpose,
      mediaType,
      (async function* (): AsyncGenerator<Uint8Array> { yield bytes; })(),
      bytes.byteLength,
      sha256,
    );
  }

  async #storeStreamArtifact(
    leaseId: string,
    purpose: SandboxArtifactReference["purpose"],
    mediaType: string,
    chunks: AsyncIterable<Uint8Array>,
    size: number,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<SandboxArtifactReference> {
    const artifactId = `sandbox-${purpose}-${sha256}`;
    const artifactsRoot = join(this.#leaseRoot(leaseId), "artifacts");
    await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
    const path = join(artifactsRoot, `${artifactId}.bin`);
    const handle = await open(path, "wx", 0o600).catch(async (error: unknown) => {
      if (errorCode(error) === "EEXIST") return open(path, "r+");
      throw error;
    });
    const hash = createHash("sha256");
    let written = 0;
    try {
      await handle.truncate(0);
      for await (const value of chunks) {
        if (signal?.aborted) throw abortError();
        if (!(value instanceof Uint8Array) || value.byteLength < 1) {
          throw new Error("Chunk artifact sandbox tidak sah.");
        }
        written += value.byteLength;
        if (written > size) throw new Error("Artifact sandbox melampaui descriptor.");
        hash.update(value);
        await handle.write(value, 0, value.byteLength, written - value.byteLength);
      }
      if (written !== size || hash.digest("hex") !== sha256) {
        throw new Error("Artifact sandbox tidak cocok descriptor.");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const reference: SandboxArtifactReference = {
      artifactId,
      sha256,
      size,
      mediaType,
      purpose,
    };
    await atomicJson(join(artifactsRoot, `${artifactId}.json`), { reference, path });
    return reference;
  }

  #createArgs(request: SandboxAllocationRequest, containerName: string): string[] {
    const disk = request.limits.diskBytes;
    const temporary = Math.max(1 * 1_024 * 1_024, Math.floor(disk / 10));
    const workspace = disk - temporary;
    if (workspace < request.snapshot.size) throw new Error("Disk quota sandbox terlalu kecil.");
    return [
      "create",
      "--name", containerName,
      "--label", "io.harvy.sandbox=1",
      "--label", `io.harvy.lease=${request.leaseId}`,
      "--pull", "never",
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--security-opt", `seccomp=${this.#seccompProfile}`,
      "--userns", "auto:size=65536",
      "--user", CONTAINER_USER,
      "--pid", "private",
      "--ipc", "private",
      "--uts", "private",
      "--cgroupns", "private",
      "--pids-limit", String(request.limits.pids),
      "--memory", String(request.limits.memoryBytes),
      "--memory-swap", String(request.limits.memoryBytes),
      "--cpus", String(request.limits.cpuCores),
      "--tmpfs", `/workspace:rw,nosuid,nodev,size=${workspace},uid=65532,gid=65532,mode=0700`,
      "--tmpfs", `/tmp:rw,nosuid,nodev,size=${temporary},uid=65532,gid=65532,mode=0700`,
      "--workdir", "/workspace",
      "--env", "HOME=/tmp",
      "--env", "TMPDIR=/tmp",
      "--no-hosts",
      "--stop-timeout", "1",
      "--entrypoint", "/bin/sleep",
      this.#image,
      "infinity",
    ];
  }

  async #assertHealthy(): Promise<void> {
    const health = await this.health();
    if (!health.available) throw new Error(health.reason ?? "Sandbox backend tidak sehat.");
  }

  async #activeRecord(leaseId: string): Promise<OciLeaseRecord> {
    const record = await this.#readRecord(leaseId);
    if (!record || record.state !== "active" || !record.lease ||
      Date.parse(record.lease.expiresAt) <= this.#now().getTime()) {
      throw new Error("Lease sandbox tidak aktif atau kedaluwarsa.");
    }
    return record;
  }

  async #removeAllHarvyContainers(): Promise<void> {
    if (this.#platform !== "linux") return;
    const listed = await this.#control([
      "ps", "--all", "--filter", "label=io.harvy.sandbox=1", "--format", "{{.Names}}",
    ], 30_000).catch(() => null);
    if (!listed || listed.exitCode !== 0) return;
    for (const name of listed.stdout.toString("utf8").split(/\r?\n/gu).filter(Boolean)) {
      if (/^harvy-sandbox-[a-f0-9]{32}$/u.test(name)) {
        await this.#removeContainer(name).catch(() => undefined);
      }
    }
  }

  async #removeContainer(containerName: string): Promise<void> {
    const removed = await this.#control(["rm", "--force", "--time", "1", containerName], 30_000);
    if (removed.exitCode !== 0 && !/no such container|does not exist/iu.test(removed.stderr.toString("utf8"))) {
      throw new Error("Container sandbox belum terbukti terhapus.");
    }
  }

  #control(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<OciCommandResult> {
    return this.#run(this.#ociCommand, args, timeoutMs, CONTROL_OUTPUT_BYTES, signal);
  }

  #run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
    signal?: AbortSignal,
    stdinPath?: string,
  ): Promise<OciCommandResult> {
    return this.#runner.run({
      executable,
      args,
      timeoutMs,
      maxOutputBytes,
      env: this.#commandEnvironment,
      ...(signal ? { signal } : {}),
      ...(stdinPath ? { stdinPath } : {}),
    });
  }

  #recordPath(leaseId: string): string {
    return join(this.#recordsRoot, `${safeLeaseId(leaseId)}.json`);
  }

  #leaseRoot(leaseId: string): string {
    return join(this.#leasesRoot, safeLeaseId(leaseId));
  }

  async #readRecord(leaseId: string): Promise<OciLeaseRecord | null> {
    try {
      return await this.#readRecordFile(this.#recordPath(leaseId));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async #readRecordFile(path: string): Promise<OciLeaseRecord> {
    return parseRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  }

  #writeRecord(record: OciLeaseRecord): Promise<void> {
    return atomicJson(this.#recordPath(record.leaseId), record);
  }

  async #removeLeaseData(leaseId: string): Promise<void> {
    const root = this.#leaseRoot(leaseId);
    if (!root.startsWith(`${this.#leasesRoot}${sep}`)) throw new Error("Root lease sandbox tidak aman.");
    await rm(root, { recursive: true, force: true });
  }

  async #exclusive<T>(leaseIdInput: string, operation: () => Promise<T>): Promise<T> {
    const leaseId = safeLeaseId(leaseIdInput);
    const previous = this.#queues.get(leaseId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(() => undefined, () => undefined);
    this.#queues.set(leaseId, tail);
    try {
      return await next;
    } finally {
      if (this.#queues.get(leaseId) === tail) this.#queues.delete(leaseId);
    }
  }
}

function attestation(request: SandboxAllocationRequest): SandboxSecurityAttestation {
  return {
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
    limits: structuredClone(request.limits),
  };
}

function verifyExecutionDigest(
  lease: SandboxLease,
  request: SandboxTransportExecutionRequest,
): void {
  const expected = createHash("sha256").update(JSON.stringify({
    version: 1,
    operationId: request.operationId,
    leaseId: lease.leaseId,
    binding: lease.binding,
    request: request.request,
  }), "utf8").digest("hex");
  if (request.version !== 1 || request.requestDigest !== expected) {
    throw new Error("Digest execution sandbox tidak cocok binding.");
  }
}

function executionStatus(result: OciCommandResult): SandboxExecResult["status"] {
  if (result.aborted) return "cancelled";
  if (result.timedOut) return "timed_out";
  if (result.outputExceeded || result.exitCode === 137) return "resource_exhausted";
  if (result.exitCode === null) return "infrastructure_error";
  return "exited";
}

async function writeVerifiedContent(
  path: string,
  content: AsyncIterable<Uint8Array>,
  descriptor: ProjectSnapshotBundleDescriptor,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const value of content) {
      if (signal?.aborted) throw abortError();
      if (!(value instanceof Uint8Array) || value.byteLength < 1) {
        throw new Error("Chunk snapshot sandbox tidak sah.");
      }
      size += value.byteLength;
      if (size > descriptor.size) throw new Error("Snapshot sandbox melampaui descriptor.");
      hash.update(value);
      await handle.write(value, 0, value.byteLength, size - value.byteLength);
    }
    if (size !== descriptor.size || hash.digest("hex") !== descriptor.bundleSha256) {
      throw new Error("Snapshot sandbox tidak cocok descriptor.");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function drain(content: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
  for await (const _chunk of content) {
    if (signal?.aborted) throw abortError();
  }
}

interface RootlessPodmanIdentity {
  podmanVersion: string;
  kernel: string;
  cgroupManager: "systemd";
  cgroupVersion: "v2";
  ociRuntimeName: "crun" | "runc" | "youki";
  ociRuntimeVersion: string;
  seccompEnabled: true;
  serviceIsRemote: false;
}

function rootlessPodmanIdentity(bytes: Uint8Array): RootlessPodmanIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("Output podman info bukan JSON.");
  }
  const root = object(parsed);
  const host = object(root.host ?? root.Host);
  const security = object(host.security ?? host.Security);
  const rootless = security.rootless ?? security.Rootless;
  const seccompEnabled = security.seccompEnabled ?? security.SeccompEnabled;
  const cgroup = host.cgroupVersion ?? host.CgroupVersion;
  const cgroupManager = host.cgroupManager ?? host.CgroupManager;
  const kernel = boundedRuntimeText(host.kernel ?? host.Kernel, "kernel");
  const runtime = object(host.ociRuntime ?? host.OCIRuntime);
  const runtimeName = runtime.name ?? runtime.Name;
  const runtimeVersion = boundedRuntimeText(runtime.version ?? runtime.Version, "OCI runtime version");
  const version = object(root.version ?? root.Version);
  const podmanVersion = boundedRuntimeText(version.Version ?? version.version, "Podman version");
  const serviceIsRemote = root.serviceIsRemote ?? root.ServiceIsRemote;
  if (rootless !== true || (cgroup !== "v2" && cgroup !== "2") ||
    cgroupManager !== "systemd" || seccompEnabled !== true || serviceIsRemote !== false ||
    (runtimeName !== "crun" && runtimeName !== "runc" && runtimeName !== "youki")) {
    throw new Error("Podman bukan rootless+cgroup-v2 dengan OCI runtime yang didukung.");
  }
  return Object.freeze({
    podmanVersion,
    kernel,
    cgroupManager: "systemd",
    cgroupVersion: "v2",
    ociRuntimeName: runtimeName,
    ociRuntimeVersion: runtimeVersion,
    seccompEnabled: true,
    serviceIsRemote: false,
  });
}

function boundedRuntimeText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096 || value.includes("\0")) {
    throw new Error(`${label} sandbox tidak sah.`);
  }
  return value;
}

function boundedUtf8(bytes: Uint8Array, maximumBytes: number): string {
  if (maximumBytes < 1 || bytes.byteLength < 1) return "";
  const decoded = Buffer.from(bytes.subarray(0, Math.min(bytes.byteLength, maximumBytes)))
    .toString("utf8");
  if (Buffer.byteLength(decoded) <= maximumBytes) return decoded;
  let output = "";
  let size = 0;
  for (const character of decoded) {
    const characterBytes = Buffer.byteLength(character);
    if (size + characterBytes > maximumBytes) break;
    output += character;
    size += characterBytes;
  }
  return output;
}

function parseRecord(value: unknown): OciLeaseRecord {
  const record = object(value) as Partial<OciLeaseRecord>;
  exactKeys(record, [
    "version", "leaseId", "containerName", "state", "lease", "createdAt", "updatedAt",
  ], "record sandbox backend");
  if (record.version !== 1 || (record.state !== "active" && record.state !== "fenced") ||
    typeof record.leaseId !== "string" || safeLeaseId(record.leaseId) !== record.leaseId ||
    record.containerName !== containerNameFor(record.leaseId) ||
    (record.lease !== null && typeof record.lease !== "object") ||
    (record.state === "fenced" && record.lease !== null) ||
    !validIso(record.createdAt) || !validIso(record.updatedAt)) {
    throw new Error("Record sandbox backend tidak sah.");
  }
  return structuredClone(record as OciLeaseRecord);
}

function parseStoredArtifact(value: unknown, leaseRoot: string): StoredArtifact {
  const stored = object(value) as Partial<StoredArtifact>;
  exactKeys(stored, ["reference", "path"], "artifact sandbox backend");
  const reference = object(stored.reference) as unknown as SandboxArtifactReference;
  exactKeys(reference, ["artifactId", "sha256", "size", "mediaType", "purpose"], "descriptor artifact sandbox");
  if (typeof stored.path !== "string" || !resolve(stored.path).startsWith(`${resolve(leaseRoot)}${sep}`) ||
    safeArtifactId(reference.artifactId) !== reference.artifactId ||
    !/^[a-f0-9]{64}$/u.test(reference.sha256) || !Number.isSafeInteger(reference.size) ||
    reference.size < 0) {
    throw new Error("Artifact sandbox backend tidak sah.");
  }
  return { reference: structuredClone(reference), path: stored.path };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertSuccessfulControl(result: OciCommandResult, label: string): void {
  if (result.exitCode !== 0 || result.timedOut || result.aborted || result.outputExceeded) {
    throw new Error(`${label} gagal tertutup.`);
  }
}

function validateCommandEnvironment(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const allowed = new Set([
    "PATH", "HOME", "XDG_RUNTIME_DIR", "TMPDIR", "CONTAINERS_CONF", "STORAGE_CONF",
  ]);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key) || !item || item.length > 4_096 || item.includes("\0")) {
      throw new Error("Environment command sandbox memuat field tidak diizinkan.");
    }
    output[key] = item;
  }
  if (!output.PATH || !output.HOME || !output.XDG_RUNTIME_DIR) {
    throw new Error("Environment rootless OCI belum lengkap.");
  }
  return Object.freeze(output);
}

function pinnedImage(value: string): string {
  if (value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]+@sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Image sandbox wajib digest-pinned.");
  }
  return value;
}

function imageDigest(image: string): string {
  const match = /@sha256:([a-f0-9]{64})$/u.exec(image);
  if (!match?.[1]) throw new Error("Digest image sandbox tidak tersedia.");
  return match[1];
}

function sha256Digest(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} tidak sah.`);
  return value;
}

function safeAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error(`${label} tidak sah.`);
  }
  return resolve(value);
}

function safeExecutable(value: string): string {
  if (!value || value.length > 512 || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error("Executable sandbox service tidak sah.");
  }
  return value;
}

function safeLeaseId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u.test(value)) {
    throw new Error("Lease ID sandbox backend tidak sah.");
  }
  return value;
}

function safeArtifactId(value: string): string {
  if (!/^sandbox-(?:stdout|stderr|workspace-snapshot|build-artifact)-[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Artifact ID sandbox backend tidak sah.");
  }
  return value;
}

function safeOpaque(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u.test(value)) {
    throw new Error(`${label} sandbox backend tidak sah.`);
  }
  return value;
}

function containerNameFor(leaseId: string): string {
  return `harvy-sandbox-${createHash("sha256").update(safeLeaseId(leaseId), "utf8").digest("hex").slice(0, 32)}`;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} tidak sah.`);
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Object sandbox backend tidak sah.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} memuat field asing atau hilang.`);
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const state = await lstat(path);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error("Direktori sandbox service bukan direktori nyata.");
  }
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function abortError(): Error {
  const error = new Error("Operasi sandbox backend dibatalkan.");
  error.name = "AbortError";
  return error;
}

/** Stream source used by the HTTP handler without exposing a filesystem path. */
export function openStoredSandboxArtifact(artifact: StoredArtifact): AsyncIterable<Uint8Array> {
  return (async function* (): AsyncGenerator<Uint8Array> {
    const stream = createReadStream(artifact.path);
    for await (const value of stream) yield Buffer.from(value as Buffer);
  })();
}
