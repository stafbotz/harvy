import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { SandboxAllocationRequest } from "../src/sandbox/sandbox-transport.js";
import { scanProjectTree } from "../src/core/project-files.js";
import { createSandboxSnapshotSource } from "../src/sandbox/snapshot-bundle.js";
import {
  OciSandboxBackend,
} from "../src/sandbox/oci-sandbox-backend.js";
import type {
  OciCommandRequest,
  OciCommandResult,
  OciCommandRunner,
} from "../src/sandbox/oci-command-runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OciSandboxBackend", () => {
  it("membentuk container rootless tanpa mount/network/capability dan mengeksekusi argv tanpa shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-oci-backend-"));
    roots.push(root);
    const seccomp = join(root, "seccomp.json");
    const tar = join(root, "tar");
    await writeFile(seccomp, "{}", "utf8");
    await writeFile(tar, "test", "utf8");
    const runner = new FakeOciRunner(tar);
    const backend = new OciSandboxBackend({
      dataRoot: join(root, "backend"),
      image: `registry.example/harvy/toolchain@sha256:${"a".repeat(64)}`,
      seccompProfile: seccomp,
      tarCommand: tar,
      commandEnvironment: {
        PATH: "/usr/bin",
        HOME: "/srv/harvy-sandbox",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      serviceIdentityDigest: "9".repeat(64),
      runner,
      platform: "linux",
      uid: 1000,
      serviceEnvironment: {},
      now: () => new Date("2026-08-15T00:00:00.000Z"),
      makeId: () => "00000000-0000-4000-8000-000000000001",
    });
    await backend.initialize();
    const initialHealth = await backend.health();
    assert.equal(initialHealth.available, true);
    assert.deepEqual(initialHealth.identity && {
      serviceIdentityDigest: initialHealth.identity.serviceIdentityDigest,
      runtimeImageDigest: initialHealth.identity.runtimeImageDigest,
    }, {
      serviceIdentityDigest: "9".repeat(64),
      runtimeImageDigest: "a".repeat(64),
    });
    assert.match(initialHealth.identity?.policyDigest ?? "", /^[a-f0-9]{64}$/u);
    await writeFile(seccomp, "{\"defaultAction\":\"SCMP_ACT_ERRNO\"}", "utf8");
    const changedPolicyHealth = await backend.health();
    assert.equal(changedPolicyHealth.available, true);
    assert.notEqual(changedPolicyHealth.identity?.policyDigest, initialHealth.identity?.policyDigest);
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "package.json"), "{\"scripts\":{\"test\":\"node test.js\"}}\n");
    const manifest = await scanProjectTree(projectRoot);
    const snapshot = await createSandboxSnapshotSource(projectRoot, manifest);
    const allocation = request(snapshot.descriptor.snapshotId, snapshot.descriptor);
    const lease = await backend.allocate(allocation, snapshot.open());
    assert.equal(lease.attestation.runtime, "isolated-linux");
    assert.equal(lease.attestation.network, "off");

    const create = runner.calls.find((call) => call.args[0] === "create")!;
    assert.ok(create.args.includes("none"));
    assert.ok(create.args.includes("--read-only"));
    assert.ok(create.args.includes("--cap-drop"));
    assert.ok(create.args.includes("ALL"));
    assert.ok(create.args.includes("--pids-limit"));
    assert.ok(create.args.includes("--memory"));
    assert.ok(create.args.includes("--cpus"));
    assert.equal(create.args.some((part) => part === "--volume" || part === "--mount"), false);
    assert.equal(create.args.some((part) => /docker\.sock|harvy\/src/iu.test(part)), false);
    assert.equal(create.args.includes("--privileged"), false);

    const argv = ["node", "-e", "console.log('$(touch /host-pwned)')"] as const;
    const operationId = "sandbox-exec:00000000-0000-4000-8000-000000000002";
    const requestBody = { argv, cwd: ".", purpose: "test" as const, timeoutMs: 1_000 };
    const requestDigest = createHash("sha256").update(JSON.stringify({
      version: 1,
      operationId,
      leaseId: lease.leaseId,
      binding: lease.binding,
      request: requestBody,
    }), "utf8").digest("hex");
    const executed = await backend.execute(lease.leaseId, {
      version: 1,
      operationId,
      requestDigest,
      request: requestBody,
    });
    assert.equal(executed.status, "exited");
    const projectExec = runner.calls.find((call) =>
      call.args.includes("console.log('$(touch /host-pwned)')")
    )!;
    assert.equal(projectExec.executable, "podman");
    assert.deepEqual(projectExec.args.slice(-3), [...argv]);

    const binaryOperationId = "sandbox-exec:00000000-0000-4000-8000-000000000003";
    const binaryRequest = {
      argv: ["node", "binary-output"] as const,
      cwd: ".",
      purpose: "test" as const,
      timeoutMs: 1_000,
    };
    const binaryDigest = createHash("sha256").update(JSON.stringify({
      version: 1,
      operationId: binaryOperationId,
      leaseId: lease.leaseId,
      binding: lease.binding,
      request: binaryRequest,
    }), "utf8").digest("hex");
    const binary = await backend.execute(lease.leaseId, {
      version: 1,
      operationId: binaryOperationId,
      requestDigest: binaryDigest,
      request: binaryRequest,
    });
    assert.equal(binary.status, "exited");
    assert.equal(binary.truncated, true);
    assert.ok(Buffer.byteLength(binary.stdout) <= lease.attestation.limits.maxOutputBytes);
    assert.equal(binary.artifacts.length, 1);

    const disposed = await backend.cancelAndDispose(lease.leaseId);
    assert.equal(disposed.fenced, true);
    await assert.rejects(() => backend.allocate(allocation, snapshot.open()), /difence/u);
  });

  it("menolak admission bila service host membawa credential Harvy/provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-oci-secret-health-"));
    roots.push(root);
    const seccomp = join(root, "seccomp.json");
    const tar = join(root, "tar");
    await writeFile(seccomp, "{}", "utf8");
    await writeFile(tar, "test", "utf8");
    const backend = new OciSandboxBackend({
      dataRoot: join(root, "backend"),
      image: `registry.example/harvy/toolchain@sha256:${"a".repeat(64)}`,
      seccompProfile: seccomp,
      tarCommand: tar,
      commandEnvironment: {
        PATH: "/usr/bin",
        HOME: "/srv/harvy-sandbox",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      serviceIdentityDigest: "9".repeat(64),
      runner: new FakeOciRunner(tar),
      platform: "linux",
      uid: 1000,
      serviceEnvironment: { HARVY_WORKSPACE_PRINCIPAL_SECRET_FILE: "/forbidden" },
      now: () => new Date("2026-08-15T00:00:00.000Z"),
    });
    await backend.initialize();
    assert.deepEqual(await backend.health(), {
      available: false,
      runtime: null,
      identity: null,
      checkedAt: "2026-08-15T00:00:00.000Z",
      reason: "Rootless isolated Linux sandbox belum memenuhi conformance deployment.",
    });
  });
});

class FakeOciRunner implements OciCommandRunner {
  readonly calls: OciCommandRequest[] = [];

  constructor(private readonly tarCommand: string) {}

  async run(request: OciCommandRequest): Promise<OciCommandResult> {
    this.calls.push(structuredClone(request));
    if (request.executable === this.tarCommand) {
      const target = request.args.find((part) => part.startsWith("--file="))?.slice(7);
      assert.ok(target);
      await writeFile(target, "fake-tar");
      return result();
    }
    if (request.args[0] === "info") {
      return result(Buffer.from(JSON.stringify({
        version: { Version: "5.5.2" },
        serviceIsRemote: false,
        host: {
          kernel: "6.8.0-test",
          cgroupManager: "systemd",
          cgroupVersion: "v2",
          security: { rootless: true, seccompEnabled: true },
          ociRuntime: { name: "crun", version: "crun version 1.20" },
        },
      })));
    }
    if (request.args[0] === "exec" && request.args.includes("binary-output")) {
      return result(Buffer.alloc(64 * 1024, 0xff));
    }
    if (request.args[0] === "exec" && request.args.includes("node")) {
      return result(Buffer.from("ok\n"));
    }
    return result();
  }
}

function result(stdout = Buffer.alloc(0)): OciCommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout,
    stderr: Buffer.alloc(0),
    timedOut: false,
    aborted: false,
    outputExceeded: false,
    wallClockMs: 1,
  };
}

function request(
  snapshotId: string,
  snapshot: SandboxAllocationRequest["snapshot"],
): SandboxAllocationRequest {
  return {
    leaseId: "lease-test-0001",
    binding: {
      ownerWorkspaceKey: "workspace-test",
      projectId: "project-test",
      snapshotId,
      workspaceRevision: 1,
      runId: "coding-run-test",
    },
    network: "off",
    limits: {
      cpuCores: 1,
      memoryBytes: 128 * 1024 * 1024,
      diskBytes: 16 * 1024 * 1024,
      pids: 32,
      wallClockMs: 60_000,
      maxOutputBytes: 64 * 1024,
      maxArtifacts: 8,
      maxArtifactBytes: 2 * 1024 * 1024,
    },
    snapshot,
  };
}
