import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  executionProgressEvent,
  renderConversationProgress,
  TransientConversationProgress,
} from "../src/core/conversation-progress.js";
import type { ExecutionPlan } from "../src/core/execution-policy.js";

describe("status kerja percakapan", () => {
  it("tidak berkedip untuk respons yang selesai di dalam grace period", async () => {
    const operations: string[] = [];
    const progress = new TransientConversationProgress(
      {
        show: async () => {
          operations.push("show");
          return "status";
        },
        update: async () => {
          operations.push("update");
        },
        remove: async () => {
          operations.push("remove");
        },
      },
      { graceMs: 30, minimumUpdateIntervalMs: 5 },
    );

    progress.report({ phase: "thinking", detail: "general" });
    await progress.finish();
    await delay(40);

    assert.deepEqual(operations, []);
  });

  it("memakai satu surface, mengeditnya, lalu menghapus sebelum jawaban", async () => {
    const shown: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const progress = new TransientConversationProgress(
      {
        show: async (text) => {
          shown.push(text);
          return "status-1";
        },
        update: async (reference, text) => {
          assert.equal(reference, "status-1");
          updated.push(text);
        },
        remove: async (reference) => {
          removed.push(reference);
        },
      },
      { graceMs: 1, minimumUpdateIntervalMs: 1, seed: "turn-1" },
    );

    progress.report({ phase: "thinking", detail: "general" });
    await delay(10);
    progress.report({ phase: "searching", detail: "latest-information" });
    await delay(10);
    await progress.responding();

    assert.equal(shown.length, 1);
    assert.equal(updated.length, 1);
    assert.deepEqual(removed, ["status-1"]);
    assert.match(shown[0] ?? "", /^Memikirkan\.\.\.\n💭 /u);
    assert.match(updated[0] ?? "", /^Mencari\.\.\.\n💭 /u);
    assert.doesNotMatch(
      `${shown.join(" ")} ${updated.join(" ")}`,
      /token|chain[- ]?of[- ]?thought|model tier|reasoning high/iu,
    );
  });

  it("mengklaim berpikir hanya dari effective execution", () => {
    assert.equal(executionProgressEvent(execution(null)).phase, "composing");
    assert.equal(executionProgressEvent(execution("high")).phase, "thinking");
    assert.equal(
      renderConversationProgress({ phase: "adjusting", detail: "new-context" })
        .startsWith("Menyesuaikan..."),
      true,
    );
  });
});

function execution(
  effectiveEffort: ExecutionPlan["effectiveEffort"],
): ExecutionPlan {
  return { effectiveEffort } as ExecutionPlan;
}
