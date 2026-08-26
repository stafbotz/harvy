import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  CodingRuntimeConformanceReceipt,
  CodingRuntimeConformanceVerifier,
} from "./coding-run-scheduler.js";
import type { SandboxHealth } from "../domain/sandbox.js";

/** Operator-pinned receipt verifier; transport health alone cannot satisfy it. */
export class PinnedCodingRuntimeConformanceVerifier
  implements CodingRuntimeConformanceVerifier {
  readonly #expectedDigest: Buffer;

  constructor(expectedReceiptSha256: string) {
    if (!/^[a-f0-9]{64}$/u.test(expectedReceiptSha256)) {
      throw new Error("Digest conformance receipt tidak sah.");
    }
    this.#expectedDigest = Buffer.from(expectedReceiptSha256, "hex");
  }

  verify(receipt: CodingRuntimeConformanceReceipt, now: Date): void {
    if (Date.parse(receipt.expiresAt) <= now.getTime()) {
      throw new Error("Conformance runtime coding sudah kedaluwarsa.");
    }
    const actual = createHash("sha256")
      .update(canonicalReceipt(receipt), "utf8")
      .digest();
    if (
      actual.byteLength !== this.#expectedDigest.byteLength ||
      !timingSafeEqual(actual, this.#expectedDigest)
    ) throw new Error("Conformance runtime coding tidak cocok pin deployment.");
  }
}

export async function loadCodingRuntimeConformanceReceipt(
  path: string,
): Promise<CodingRuntimeConformanceReceipt> {
  return parseCodingRuntimeConformanceReceipt(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );
}

export function parseCodingRuntimeConformanceReceipt(
  parsed: unknown,
): CodingRuntimeConformanceReceipt {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("File conformance runtime coding tidak sah.");
  }
  const value = parsed as Record<string, unknown>;
  const expected = [
    "version", "serviceIdentityDigest", "runtimeImageDigest", "policyDigest",
    "suiteDigest", "verifiedAt", "expiresAt",
  ];
  if (
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected.sort()) ||
    value.version !== 1 ||
    ["serviceIdentityDigest", "runtimeImageDigest", "policyDigest", "suiteDigest"]
      .some((key) => typeof value[key] !== "string" || !/^[a-f0-9]{64}$/u.test(value[key] as string)) ||
    typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt)) ||
    typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
  ) throw new Error("Schema conformance runtime coding tidak sah.");
  return Object.freeze(structuredClone(value)) as unknown as CodingRuntimeConformanceReceipt;
}

export function codingRuntimeConformanceReceiptDigest(
  receipt: CodingRuntimeConformanceReceipt,
): string {
  return createHash("sha256").update(canonicalReceipt(receipt), "utf8").digest("hex");
}

/** Admission check against the identity currently reported by the executor. */
export function assertSandboxRuntimeMatchesConformanceReceipt(
  health: SandboxHealth,
  receipt: CodingRuntimeConformanceReceipt,
): void {
  if (
    !health.available || !health.identity ||
    health.identity.serviceIdentityDigest !== receipt.serviceIdentityDigest ||
    health.identity.runtimeImageDigest !== receipt.runtimeImageDigest ||
    health.identity.policyDigest !== receipt.policyDigest
  ) {
    throw new Error("Sandbox runtime identity tidak cocok dengan conformance receipt pinned.");
  }
}

function canonicalReceipt(receipt: CodingRuntimeConformanceReceipt): string {
  return JSON.stringify({
    version: receipt.version,
    serviceIdentityDigest: receipt.serviceIdentityDigest,
    runtimeImageDigest: receipt.runtimeImageDigest,
    policyDigest: receipt.policyDigest,
    suiteDigest: receipt.suiteDigest,
    verifiedAt: receipt.verifiedAt,
    expiresAt: receipt.expiresAt,
  });
}
