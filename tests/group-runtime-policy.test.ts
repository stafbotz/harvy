import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupRuntimeAdmission } from "../src/core/group-runtime-policy.js";

const AMBIENT = {
  mentionsHarvy: false,
  repliesToHarvy: false,
  text: "obrolan biasa",
};

describe("admission runtime grup", () => {
  it("direct_only menahan ambient biasa tetapi tidak menelan emergency eksplisit", () => {
    assert.equal(
      groupRuntimeAdmission("direct_only", AMBIENT),
      "silent",
    );
    assert.equal(
      groupRuntimeAdmission("direct_only", {
        ...AMBIENT,
        text: "aku dalam bahaya sekarang",
      }),
      "process",
    );
    assert.equal(
      groupRuntimeAdmission("direct_only", {
        ...AMBIENT,
        text: "contoh untuk tugas\naku dalam bahaya sekarang",
        parts: [
          {
            messageId: "context",
            text: "contoh untuk tugas",
            at: "2026-08-08T00:00:00.000Z",
            mentionsHarvy: false,
            repliesToHarvy: false,
          },
          {
            messageId: "danger",
            text: "aku dalam bahaya sekarang",
            at: "2026-08-08T00:00:01.000Z",
            mentionsHarvy: false,
            repliesToHarvy: false,
          },
        ],
      }),
      "process",
    );
    assert.equal(
      groupRuntimeAdmission("direct_only", {
        ...AMBIENT,
        mentionsHarvy: true,
      }),
      "process",
    );
  });

  it("disabled dan paused tetap fail-closed termasuk untuk emergency", () => {
    const danger = { ...AMBIENT, text: "aku dalam bahaya sekarang" };
    assert.equal(groupRuntimeAdmission("disabled", danger), "inactive");
    assert.equal(groupRuntimeAdmission("paused", danger), "silent");
    assert.equal(groupRuntimeAdmission("ambient", AMBIENT), "process");
  });
});
