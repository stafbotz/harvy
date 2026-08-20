import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SANDBOX_HOSTILE_ACCEPTANCE_SCENARIOS,
  createSandboxConformanceReceipt,
  parseSandboxLiveAcceptanceObservation,
  sandboxAcceptanceSuiteDigest,
} from "../src/sandbox/sandbox-live-conformance.js";
import { assertSandboxRuntimeMatchesConformanceReceipt } from
  "../src/core/pinned-coding-runtime-conformance.js";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const SOURCE = Buffer.from("exact hostile suite source", "utf8");
const SUITE = sandboxAcceptanceSuiteDigest(SOURCE);

describe("sandbox live conformance receipt", () => {
  it("mengikat observation ke source suite, seluruh scenario, dan runtime identity exact", () => {
    const observation = parseSandboxLiveAcceptanceObservation(validObservation(), SUITE);
    const receipt = createSandboxConformanceReceipt(observation, NOW);
    assert.deepEqual(receipt, {
      version: 1,
      serviceIdentityDigest: "1".repeat(64),
      runtimeImageDigest: "2".repeat(64),
      policyDigest: "3".repeat(64),
      suiteDigest: SUITE,
      verifiedAt: "2026-08-15T11:59:00.000Z",
      expiresAt: "2026-08-22T11:59:00.000Z",
    });
    assert.doesNotThrow(() => assertSandboxRuntimeMatchesConformanceReceipt({
      available: true,
      runtime: "isolated-linux",
      identity: observation.identity,
      checkedAt: NOW.toISOString(),
      reason: null,
    }, receipt));
    assert.throws(() => assertSandboxRuntimeMatchesConformanceReceipt({
      available: true,
      runtime: "isolated-linux",
      identity: { ...observation.identity, policyDigest: "9".repeat(64) },
      checkedAt: NOW.toISOString(),
      reason: null,
    }, receipt), /tidak cocok/u);
  });

  it("menolak suite lama, scenario hilang, field asing, dan observation tidak fresh", () => {
    assert.throws(
      () => parseSandboxLiveAcceptanceObservation(validObservation(), "4".repeat(64)),
      /suite\/runtime exact/u,
    );
    assert.throws(
      () => parseSandboxLiveAcceptanceObservation({
        ...validObservation(),
        scenarios: SANDBOX_HOSTILE_ACCEPTANCE_SCENARIOS.slice(1),
      }, SUITE),
      /suite\/runtime exact/u,
    );
    assert.throws(
      () => parseSandboxLiveAcceptanceObservation({ ...validObservation(), extra: true }, SUITE),
      /field asing/u,
    );
    const stale = parseSandboxLiveAcceptanceObservation({
      ...validObservation(),
      verifiedAt: "2026-08-15T11:00:00.000Z",
    }, SUITE);
    assert.throws(
      () => createSandboxConformanceReceipt(stale, NOW),
      /tidak fresh/u,
    );
  });
});

function validObservation() {
  return {
    version: 1,
    verifiedAt: "2026-08-15T11:59:00.000Z",
    runtime: "isolated-linux",
    identity: {
      serviceIdentityDigest: "1".repeat(64),
      runtimeImageDigest: "2".repeat(64),
      policyDigest: "3".repeat(64),
    },
    suiteDigest: SUITE,
    scenarios: SANDBOX_HOSTILE_ACCEPTANCE_SCENARIOS,
  };
}
