import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deterministicArithmeticReply,
  deterministicEmptyReminderReply,
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

  it("mengumpulkan isi dan waktu hanya untuk reminder yang benar-benar kosong", () => {
    const empty = {
      intent: "request" as const,
      task: null,
      taskAction: null,
    };
    assert.match(
      deterministicEmptyReminderReply("buat pengingat dong", empty) ?? "",
      /apa.*kapan|apa.*waktu/iu,
    );
    assert.equal(
      deterministicEmptyReminderReply(
        "buat pengingat minum obat besok jam 7",
        empty,
      ),
      null,
    );
    assert.equal(
      deterministicEmptyReminderReply("buat pengingat dong", {
        ...empty,
        intent: "smalltalk",
      }),
      null,
    );
    assert.match(
      deterministicEmptyReminderReply("buat pengingat dong", {
        ...empty,
        intent: "question",
      }) ?? "",
      /apa.*kapan/iu,
    );
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
