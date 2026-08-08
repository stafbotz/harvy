import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deterministicQuickChatReply,
  isNarrowPendingAnswer,
} from "../src/bot/fast-path-policy.js";
import type { Pending } from "../src/bot/pending.js";

describe("fast path percakapan privat", () => {
  it("hanya menjawab acknowledgement dingin dari closed set", () => {
    assert.equal(deterministicQuickChatReply("makasih!"), "Sama-sama.");
    assert.equal(deterministicQuickChatReply("oke"), "Sip.");
    assert.equal(deterministicQuickChatReply("aku capek banget"), null);
    assert.equal(deterministicQuickChatReply("iya, tapi nanti dulu"), null);
  });

  it("mengenali nilai waktu dan pilihan sempit menurut jenis pending", () => {
    const due: Pending = { kind: "edit-due", taskId: "task-1" };
    const memory: Pending = { kind: "edit-memory", memoryId: "memory-1" };
    const agent = { kind: "agent-input" } as Pending;
    const settings: Pending = {
      kind: "checkin-settings",
      sessionId: "session-1",
      step: "timezone",
    };

    for (const value of ["besok", "jam 7", "45 menit", "19.00-07.00"]) {
      assert.equal(isNarrowPendingAnswer(due, value), true, value);
    }
    assert.equal(isNarrowPendingAnswer(settings, "iya"), true);
    assert.equal(isNarrowPendingAnswer(agent, "opsi B"), false);
    assert.equal(isNarrowPendingAnswer(agent, "iya"), false);
    assert.equal(isNarrowPendingAnswer(memory, "aku sedang nggak aman"), false);
    assert.equal(isNarrowPendingAnswer(due, "aku capek hidup"), false);
  });
});
