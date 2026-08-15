import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  resolveGroupAgentRunEnabled,
  resolveGroupAgentRunCleanupFile,
  resolveGroupAgentRunFile,
} from "../src/config.js";

describe("konfigurasi penyimpanan GroupAgentRun", () => {
  it("menahan capability produksi default-off dan hanya menerima boolean eksplisit", () => {
    assert.equal(resolveGroupAgentRunEnabled(undefined), false);
    assert.equal(resolveGroupAgentRunEnabled(" true "), true);
    assert.equal(resolveGroupAgentRunEnabled("0"), false);
    assert.throws(
      () => resolveGroupAgentRunEnabled("production"),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "CONFIG_WHATSAPP_GROUP_AGENT_RUN_ENABLED_INVALID",
    );
  });

  it("memakai file durable khusus secara default dan menerima override", () => {
    const groupFile = resolve("./data/whatsapp-groups.json");

    assert.equal(
      resolveGroupAgentRunFile(groupFile, ""),
      resolve("./data/whatsapp-group-agent-runs.json"),
    );
    assert.equal(
      resolveGroupAgentRunFile(groupFile, "./data/group-runs-custom.json"),
      resolve("./data/group-runs-custom.json"),
    );
  });

  it("menolak file yang sama dengan repository state grup", () => {
    const groupFile = resolve("./data/whatsapp-groups.json");

    assert.throws(
      () => resolveGroupAgentRunFile(
        groupFile,
        "./data/subfolder/../whatsapp-groups.json",
      ),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code ===
          "CONFIG_WHATSAPP_GROUP_AGENT_RUN_FILE_SHARED",
    );
  });

  it("memisahkan intent cleanup dari kedua repository state", () => {
    const groupFile = resolve("./data/whatsapp-groups.json");
    const runFile = resolve("./data/whatsapp-group-agent-runs.json");
    assert.equal(
      resolveGroupAgentRunCleanupFile(groupFile, runFile, ""),
      resolve("./data/whatsapp-group-agent-run-cleanup.json"),
    );
    assert.equal(
      resolveGroupAgentRunCleanupFile(
        groupFile,
        runFile,
        "./data/custom-cleanup.json",
      ),
      resolve("./data/custom-cleanup.json"),
    );
    for (const collision of [groupFile, runFile]) {
      assert.throws(
        () => resolveGroupAgentRunCleanupFile(
          groupFile,
          runFile,
          collision,
        ),
        (error: unknown) =>
          error instanceof Error &&
          (error as Error & { code?: string }).code ===
            "CONFIG_WHATSAPP_GROUP_AGENT_RUN_CLEANUP_FILE_SHARED",
      );
    }
  });
});
