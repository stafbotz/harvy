import { createHash } from "node:crypto";
import type { SandboxHealth } from "../domain/sandbox.js";
import type { CodingRuntimeConformanceReceipt } from "../core/coding-run-scheduler.js";

export const SANDBOX_HOSTILE_ACCEPTANCE_SCENARIOS = Object.freeze([
  "proc-environ",
  "host-file",
  "harvy-data",
  "docker-socket",
  "network-http-dns",
  "disk-quota",
  "memory-quota",
  "infinite-loop",
  "fork-bomb",
  "pid-explosion",
  "output-oversize",
  "artifact-oversize",
  "malformed-output",
  "symlink-capture",
  "cancellation-fence",
] as const);

export interface SandboxLiveAcceptanceObservation {
  version: 1;
  verifiedAt: string;
  runtime: "isolated-linux";
  identity: NonNullable<SandboxHealth["identity"]>;
  suiteDigest: string;
  scenarios: readonly string[];
}

/** Binds a live result to the exact executable acceptance source and manifest. */
export function sandboxAcceptanceSuiteDigest(source: Uint8Array): string {
  return createHash("sha256")
    .update("harvy-sandbox-hostile-acceptance/1\0", "utf8")
    .update(JSON.stringify(SANDBOX_HOSTILE_ACCEPTANCE_SCENARIOS), "utf8")
    .update("\0", "utf8")
    .update(source)
    .digest("hex");
}

export function parseSandboxLiveAcceptanceObservation(
  input: unknown,
  expectedSuiteDigest: string,
): SandboxLiveAcceptanceObservation {
  const value = object(input, "observation hostile sandbox") as Partial<SandboxLiveAcceptanceObservation>;
  exactKeys(value, [
    "version", "verifiedAt", "runtime", "identity", "suiteDigest", "scenarios",
  ], "observation hostile sandbox");
  const identity = object(value.identity, "identity hostile sandbox");
  exactKeys(identity, [
    "serviceIdentityDigest", "runtimeImageDigest", "policyDigest",
  ], "identity hostile sandbox");
  if (
    value.version !== 1 || value.runtime !== "isolated-linux" ||
    !validIso(value.verifiedAt) || !sha256(value.suiteDigest) ||
    value.suiteDigest !== expectedSuiteDigest ||
    !sha256(identity.serviceIdentityDigest) ||
    !sha256(identity.runtimeImageDigest) || !sha256(identity.policyDigest) ||
    !Array.isArray(value.scenarios) ||
    JSON.stringify(value.scenarios) !== JSON.stringify(SANDBOX_HOSTILE_ACCEPTANCE_SCENARIOS)
  ) {
    throw new Error("Observation hostile sandbox tidak cocok suite/runtime exact.");
  }
  return Object.freeze(structuredClone(value)) as SandboxLiveAcceptanceObservation;
}

export function createSandboxConformanceReceipt(
  observation: SandboxLiveAcceptanceObservation,
  now: Date,
  validityMs = 7 * 24 * 60 * 60_000,
): CodingRuntimeConformanceReceipt {
  const verifiedAt = Date.parse(observation.verifiedAt);
  if (
    !Number.isSafeInteger(validityMs) || validityMs < 60_000 ||
    validityMs > 7 * 24 * 60 * 60_000 ||
    verifiedAt > now.getTime() + 60_000 ||
    now.getTime() - verifiedAt > 15 * 60_000
  ) {
    throw new Error("Observation hostile sandbox tidak fresh atau masa receipt terlalu panjang.");
  }
  return Object.freeze({
    version: 1,
    serviceIdentityDigest: observation.identity.serviceIdentityDigest,
    runtimeImageDigest: observation.identity.runtimeImageDigest,
    policyDigest: observation.identity.policyDigest,
    suiteDigest: observation.suiteDigest,
    verifiedAt: observation.verifiedAt,
    expiresAt: new Date(verifiedAt + validityMs).toISOString(),
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} bukan object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} memuat field asing atau hilang.`);
  }
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
