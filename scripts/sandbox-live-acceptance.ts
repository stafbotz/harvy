import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanProjectTree } from "../src/core/project-files.js";
import { SandboxRunnerService } from "../src/core/sandbox-runner-service.js";
import type { SandboxExecRequest, SandboxExecResult, SandboxLease } from "../src/domain/sandbox.js";
import { MemorySandboxLeaseJournal } from "../src/sandbox/sandbox-lease-journal.js";
import {
  SANDBOX_HOSTILE_ACCEPTANCE_SCENARIOS,
  sandboxAcceptanceSuiteDigest,
} from "../src/sandbox/sandbox-live-conformance.js";
import { createSandboxSnapshotSource } from "../src/sandbox/snapshot-bundle.js";
import { HmacTrustDomainRequestProofProvider } from "../src/transport/trust-domain-http.js";
import { HttpSandboxTransport } from "../src/transport/http-sandbox-transport.js";

const HOST_SENTINEL = "/var/lib/harvy-sandbox/host-sentinel";
const root = await mkdtemp(join(tmpdir(), "harvy-sandbox-live-"));
let runner: SandboxRunnerService | null = null;

try {
  if (process.platform !== "linux") throw new Error("SANDBOX_ACCEPTANCE_REQUIRES_LINUX_HOST");
  const origin = required("HARVY_SANDBOX_ACCEPTANCE_ORIGIN");
  const keyId = required("HARVY_SANDBOX_ACCEPTANCE_HMAC_KEY_ID");
  const secretPath = resolve(required("HARVY_SANDBOX_ACCEPTANCE_HMAC_SECRET_FILE"));
  const secretState = await lstat(secretPath);
  if (!secretState.isFile() || secretState.isSymbolicLink() || secretState.size > 16 * 1024) {
    throw new Error("SANDBOX_ACCEPTANCE_SECRET_FILE_INVALID");
  }
  const sentinelPath = resolve(required("HARVY_SANDBOX_ACCEPTANCE_HOST_SENTINEL_FILE"));
  if (sentinelPath !== HOST_SENTINEL) throw new Error("SANDBOX_ACCEPTANCE_SENTINEL_PATH_MISMATCH");
  const sentinelState = await lstat(sentinelPath);
  if (!sentinelState.isFile() || sentinelState.isSymbolicLink() ||
    sentinelState.size < 32 || sentinelState.size > 4_096) {
    throw new Error("SANDBOX_ACCEPTANCE_HOST_SENTINEL_INVALID");
  }
  const secret = Buffer.from((await readFile(secretPath, "utf8")).trim(), "base64url");
  if (secret.byteLength < 32) throw new Error("SANDBOX_ACCEPTANCE_SECRET_INVALID");
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "probe.mjs"), probeSource(), "utf8");
  await chmod(join(project, "probe.mjs"), 0o700);
  const manifest = await scanProjectTree(project);
  const snapshot = await createSandboxSnapshotSource(project, manifest);
  runner = new SandboxRunnerService(
    new HttpSandboxTransport({
      origin,
      proofProvider: new HmacTrustDomainRequestProofProvider(keyId, secret),
      allowInsecureLoopback: process.env.HARVY_SANDBOX_ACCEPTANCE_ALLOW_HTTP === "1",
    }),
    new MemorySandboxLeaseJournal(),
    {
      cpuCores: 1,
      memoryBytes: 128 * 1024 * 1024,
      diskBytes: 32 * 1024 * 1024,
      pids: 32,
      wallClockMs: 8_000,
      maxOutputBytes: 64 * 1024,
      maxArtifacts: 8,
      maxArtifactBytes: 1 * 1024 * 1024,
    },
  );
  const health = await runner.start();
  assert.equal(health.available, true);
  assert.ok(health.identity);

  const proc = await execute(runner, snapshot, "proc", 3_000);
  assert.equal(proc.status, "exited");
  const environmentNames = proc.stdout.split("\0").filter(Boolean).map((item) => item.split("=", 1)[0]!);
  assert.equal(environmentNames.some((name) =>
    name.startsWith("HARVY_") || /TOKEN|SECRET|CREDENTIAL|PASSWORD|API_KEY|DATABASE_URL/iu.test(name)
  ), false);

  for (const scenario of ["host", "harvy-data", "docker-socket"] as const) {
    const result = await execute(runner, snapshot, scenario, 3_000);
    assert.equal(result.status, "exited");
    assert.match(result.stdout, /^blocked$/mu);
  }

  const network = await execute(runner, snapshot, "network", 5_000);
  assert.equal(network.status, "exited");
  assert.match(network.stdout, /^http=blocked dns=blocked$/mu);

  const disk = await execute(runner, snapshot, "disk", 6_000);
  assert.ok(disk.status === "exited" || disk.status === "resource_exhausted");
  assert.match(`${disk.stdout}\n${disk.stderr}`, /ENOSPC|resource|quota|no space/iu);

  const memory = await execute(runner, snapshot, "memory", 6_000);
  assert.equal(memory.status, "resource_exhausted");

  const loop = await execute(runner, snapshot, "loop", 500);
  assert.equal(loop.status, "timed_out");

  const forkBomb = await execute(runner, snapshot, "fork-bomb", 2_000);
  assert.ok(forkBomb.status === "timed_out" || forkBomb.status === "resource_exhausted");

  const children = await execute(runner, snapshot, "children", 4_000);
  assert.equal(children.status, "exited");
  const childEvidence = /^spawned=(\d+) blocked=true$/mu.exec(children.stdout);
  assert.ok(childEvidence?.[1]);
  assert.ok(Number(childEvidence[1]) < 32);

  const outputLease = await allocate(runner, snapshot);
  try {
    const oversize = await runner.execute(outputLease, command("output-oversize", 3_000));
    assert.equal(oversize.status, "resource_exhausted");
    assert.equal(oversize.truncated, true);
    assert.ok(oversize.artifacts.length > 0);
    for (const artifact of oversize.artifacts) {
      assert.ok(artifact.size <= 1 * 1024 * 1024);
      const bytes = await runner.readArtifact(outputLease, artifact);
      assert.equal(bytes.byteLength, artifact.size);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
    }
  } finally {
    await runner.dispose(outputLease).catch(() => undefined);
  }

  const artifactLease = await allocate(runner, snapshot);
  try {
    const written = await runner.execute(artifactLease, command("artifact-oversize", 3_000));
    assert.equal(written.status, "exited");
    await assert.rejects(
      () => runner!.captureSnapshot(artifactLease),
      /artifact|byte|file|melampaui|limit|quota|total/iu,
    );
  } finally {
    await runner.dispose(artifactLease).catch(() => undefined);
  }

  const malformed = await execute(runner, snapshot, "malformed", 3_000);
  assert.equal(malformed.status, "exited");
  assert.ok(Buffer.byteLength(malformed.stdout) <= 64 * 1024);
  assert.match(malformed.stdout, /\uFFFD/u);

  const symlinkLease = await allocate(runner, snapshot);
  try {
    const linked = await runner.execute(symlinkLease, command("symlink", 3_000));
    assert.equal(linked.status, "exited");
    await assert.rejects(() => runner!.captureSnapshot(symlinkLease), /Symlink|symlink/u);
  } finally {
    await runner.dispose(symlinkLease).catch(() => undefined);
  }

  const cancellationLease = await allocate(runner, snapshot);
  try {
    const cancellation = new AbortController();
    const pending = runner.execute(cancellationLease, command("loop", 8_000), cancellation.signal);
    setTimeout(() => cancellation.abort(), 200).unref?.();
    const cancellationOutcome = await pending.catch(() => null);
    if (cancellationOutcome) assert.equal(cancellationOutcome.status, "cancelled");
    await eventuallyRejected(
      () => runner!.execute(cancellationLease, command("proc", 1_000)),
      5_000,
    );
  } finally {
    await runner.dispose(cancellationLease).catch(() => undefined);
  }

  const acceptanceSource = await readFile(new URL("./sandbox-live-acceptance.ts", import.meta.url));
  process.stdout.write(`${JSON.stringify({
    version: 1,
    verifiedAt: new Date().toISOString(),
    runtime: "isolated-linux",
    identity: health.identity,
    suiteDigest: sandboxAcceptanceSuiteDigest(acceptanceSource),
    scenarios: SANDBOX_HOSTILE_ACCEPTANCE_SCENARIOS,
  }, null, 2)}\n`);
} finally {
  await runner?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

async function execute(
  runner: SandboxRunnerService,
  snapshot: Awaited<ReturnType<typeof createSandboxSnapshotSource>>,
  scenario: string,
  timeoutMs: number,
): Promise<SandboxExecResult> {
  const lease = await allocate(runner, snapshot);
  try {
    return await runner.execute(lease, command(scenario, timeoutMs));
  } finally {
    await runner.dispose(lease).catch(() => undefined);
  }
}

function allocate(
  runner: SandboxRunnerService,
  snapshot: Awaited<ReturnType<typeof createSandboxSnapshotSource>>,
): Promise<SandboxLease> {
  return runner.allocate({
    ownerWorkspaceKey: "sandbox-live-acceptance",
    projectId: "sandbox-hostile-project",
    snapshotId: snapshot.descriptor.snapshotId,
    workspaceRevision: 1,
    runId: `sandbox-live-${randomUUID()}`,
  }, snapshot);
}

function command(scenario: string, timeoutMs: number): SandboxExecRequest {
  return {
    argv: ["node", "probe.mjs", scenario],
    cwd: ".",
    purpose: "test",
    timeoutMs,
  };
}

async function eventuallyRejected(operation: () => Promise<unknown>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await operation();
    } catch {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("SANDBOX_PROCESS_REMAINED_REACHABLE_AFTER_CANCELLATION");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`SANDBOX_ACCEPTANCE_MISSING_${name}`);
  return value;
}

function probeSource(): string {
  return String.raw`
import { access, open, readFile, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import dns from "node:dns/promises";

const scenario = process.argv[2];
if (scenario === "proc") {
  process.stdout.write(await readFile("/proc/1/environ", "utf8"));
} else if (scenario === "host") {
  await blocked("/var/lib/harvy-sandbox/host-sentinel");
} else if (scenario === "harvy-data") {
  await blocked("/var/lib/harvy/data");
} else if (scenario === "docker-socket") {
  await blocked("/var/run/docker.sock");
} else if (scenario === "network") {
  let http = "open";
  let lookup = "open";
  try { await fetch("https://example.com", { signal: AbortSignal.timeout(1500) }); } catch { http = "blocked"; }
  try { await dns.lookup("example.com"); } catch { lookup = "blocked"; }
  console.log("http=" + http + " dns=" + lookup);
} else if (scenario === "disk") {
  const file = await open("disk-fill.bin", "w");
  const chunk = Buffer.alloc(1024 * 1024, 1);
  try { for (let i = 0; i < 128; i += 1) await file.write(chunk); }
  catch (error) { console.log(error?.code ?? "quota"); }
  finally { await file.close(); }
} else if (scenario === "memory") {
  const values = [];
  while (true) values.push(Buffer.alloc(8 * 1024 * 1024, 1));
} else if (scenario === "loop") {
  while (true) {}
} else if (scenario === "fork-bomb") {
  const child = spawn("/bin/bash", ["-c", ":(){ :|:& };:"]);
  await Promise.race([once(child, "close"), new Promise(() => undefined)]);
} else if (scenario === "children") {
  const children = [];
  let blockedByLimit = false;
  for (let i = 0; i < 64; i += 1) {
    const child = spawn("/bin/sleep", ["60"]);
    const result = await new Promise((resolve) => {
      child.once("spawn", () => resolve("spawned"));
      child.once("error", () => resolve("blocked"));
    });
    if (result === "blocked") { blockedByLimit = true; break; }
    children.push(child);
  }
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(children.map((child) => once(child, "close").catch(() => undefined)));
  console.log("spawned=" + children.length + " blocked=" + blockedByLimit);
} else if (scenario === "output-oversize") {
  const chunk = "x".repeat(64 * 1024);
  for (let i = 0; i < 64; i += 1) process.stdout.write(chunk);
} else if (scenario === "artifact-oversize") {
  await writeFile("oversized-artifact.bin", Buffer.alloc(2 * 1024 * 1024, 1));
  console.log("written");
} else if (scenario === "malformed") {
  process.stdout.write(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x0a]));
} else if (scenario === "symlink") {
  await symlink("/etc/passwd", "escape-link");
  console.log("created");
} else {
  process.exitCode = 2;
}

async function blocked(path) {
  try { await access(path, constants.R_OK); console.log("open"); }
  catch { console.log("blocked"); }
}
`;
}
