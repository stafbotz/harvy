import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  discoverCapabilities,
  shortlistCallableCapabilities,
} from "../src/harness/capability-discovery.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { privateAgentScope } from "../src/harness/scope.js";
import type { CapabilitySnapshot } from "../src/harness/capabilities.js";

describe("progressive capability discovery", () => {
  it("menemukan metadata capability yang tidak berada di shortlist awal", () => {
    const snapshot = createHarvyCapabilityCatalog({
      internalToolsInstalled: true,
      specialistDelegationInstalled: true,
    }).snapshot(privateAgentScope("telegram", "student"));
    const initial = discoverCapabilities(snapshot, "agenda besok");
    const discoveredLater = discoverCapabilities(
      snapshot,
      "specialist perspektif trade-off",
    );

    assert.equal(
      initial.matches.some((match) => match.id === "agent.delegate.specialist"),
      false,
    );
    assert.equal(
      discoveredLater.matches.some((match) =>
        match.id === "agent.delegate.specialist" && match.available
      ),
      true,
    );
    assert.doesNotMatch(JSON.stringify(discoveredLater), /inputSchema|nativeTool/u);
  });

  it("shortlist tidak dapat memperbesar authority callable", () => {
    const snapshot = createHarvyCapabilityCatalog({
      internalToolsInstalled: true,
      specialistDelegationInstalled: true,
    }).snapshot(privateAgentScope("telegram", "student"));
    const discovery = discoverCapabilities(snapshot, "specialist challenger");
    const callable = [{
      id: "calendar.agenda",
      version: "1",
      effect: "read" as const,
      description: "Baca agenda.",
    }];

    assert.deepEqual(shortlistCallableCapabilities(discovery, callable), []);
  });

  it("menyediakan high-recall metadata fallback tanpa memuat schema", () => {
    const snapshot = createHarvyCapabilityCatalog({
      internalToolsInstalled: true,
    }).snapshot(privateAgentScope("telegram", "student"));
    const result = discoverCapabilities(snapshot, "istilah-yang-tidak-cocok", {
      mode: "high_recall",
      limit: 50,
    });

    assert.equal(result.mode, "high_recall");
    assert.equal(result.matches.length, snapshot.entries.length);
    assert.equal(result.nextOffset, null);
    assert.doesNotMatch(JSON.stringify(result), /inputSchema|parameters/u);
  });

  it("mem-page high-recall agar registry besar tidak menyembunyikan capability", () => {
    const entries = Array.from({ length: 75 }, (_, index) => ({
      id: `demo.capability_${String(index).padStart(2, "0")}`,
      version: "1",
      title: `Capability ${index}`,
      description: "Metadata uji tanpa schema.",
      effect: "none" as const,
      confirmation: "none" as const,
      idempotency: "read-only" as const,
      available: true,
      unavailableReason: null,
    }));
    const snapshot: CapabilitySnapshot = {
      version: 1,
      scope: "private:telegram:opaque",
      hash: "snapshot-large",
      entries,
    };
    const first = discoverCapabilities(snapshot, "semua capability", {
      mode: "high_recall",
      limit: 50,
    });
    assert.equal(first.matches.length, 50);
    assert.equal(first.nextOffset, 50);
    const second = discoverCapabilities(snapshot, "semua capability", {
      mode: "high_recall",
      limit: 50,
      offset: first.nextOffset ?? 0,
    });

    assert.equal(second.matches.length, 25);
    assert.equal(second.nextOffset, null);
    assert.equal(
      new Set([...first.matches, ...second.matches].map((entry) => entry.id)).size,
      75,
    );
  });
});
