import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deterministicArithmeticReply,
  isNarrowPendingAnswer,
} from "../src/bot/fast-path-policy.js";
import type { Pending } from "../src/bot/pending.js";

describe("fast path percakapan privat", () => {
  it("menghitung satu operasi eksplisit secara exact", () => {
    assert.equal(
      deterministicArithmeticReply("kerjakan soal ini untukku: 24 dibagi 6"),
      "Hasilnya 4.",
    );
    assert.equal(
      deterministicArithmeticReply("berapa setengah ditambah seperempat?"),
      "Hasilnya 3/4.",
    );
    assert.equal(
      deterministicArithmeticReply("aku buru-buru, langsung kasih hasil 17 x 8"),
      "Hasilnya 136.",
    );
    assert.equal(
      deterministicArithmeticReply("Sekarang jawab 17+28 dengan angka saja."),
      "45",
    );
  });

  it("tidak membajak narasi, beberapa operasi, atau pembagian nol", () => {
    for (const message of [
      "aku dapat soal 24 dibagi 6 dari guruku",
      "hitung 2 + 2 dan 3 + 3",
      "berapa 10 dibagi 0?",
      "karena jawabannya 24 dibagi 6",
    ]) {
      assert.equal(deterministicArithmeticReply(message), null, message);
    }
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
