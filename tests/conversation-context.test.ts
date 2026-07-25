import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryConversationContext } from "../src/ai/conversation-context.js";

describe("InMemoryConversationContext", () => {
  it("menyimpan konteks aktif tanpa melebihi batas pesan", () => {
    const context = new InMemoryConversationContext({ maxMessages: 2 });

    context.appendExchange("student", "Pesan pertama", "Jawaban pertama");
    context.appendExchange("student", "Pesan kedua", "Jawaban kedua");

    assert.deepEqual(context.get("student"), [
      { role: "user", content: "Pesan kedua" },
      { role: "assistant", content: "Jawaban kedua" },
    ]);
  });

  it("menghapus konteks setelah masa aktif berakhir", () => {
    let now = 1_000;
    const context = new InMemoryConversationContext({
      ttlMs: 500,
      now: () => now,
    });
    context.appendExchange("student", "Pesan", "Jawaban");

    now = 1_500;

    assert.deepEqual(context.get("student"), []);
  });

  it("dapat langsung dihapus oleh pengguna", () => {
    const context = new InMemoryConversationContext();
    context.appendExchange("student", "Pesan", "Jawaban");

    context.clear("student");

    assert.deepEqual(context.get("student"), []);
  });
});
