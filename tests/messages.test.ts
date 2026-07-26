import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  memorySavedActions,
  splitReplyBubbles,
} from "../src/bot/messages.js";
import type { MemoryItem } from "../src/domain/memory.js";

describe("bubble balasan", () => {
  it("memisahkan paragraf alami menjadi bubble pendek", () => {
    assert.deepEqual(
      splitReplyBubbles(
        "Makasih sudah percaya cerita.\n\nApa yang paling bikin kepikiran?",
      ),
      ["Makasih sudah percaya cerita.", "Apa yang paling bikin kepikiran?"],
    );
  });

  it("membatasi balasan menjadi paling banyak tiga bubble", () => {
    assert.deepEqual(splitReplyBubbles("satu\n\ndua\n\ntiga\n\nempat"), [
      "satu",
      "dua",
      "tiga\n\nempat",
    ]);
  });

  it("tidak memecah blok kode", () => {
    const code = "Coba ini:\n\n```html\n<div>\n\n</div>\n```";
    assert.deepEqual(splitReplyBubbles(code), [code]);
  });

  it("memecah blok kode hanya bila melewati batas pesan Telegram", () => {
    const code = `\`\`\`html\n${"x".repeat(4_200)}\n\`\`\``;
    const bubbles = splitReplyBubbles(code);

    assert.equal(bubbles.length, 2);
    assert.equal(bubbles.every((bubble) => Array.from(bubble).length <= 4_000), true);
    assert.equal(bubbles.join(""), code);
  });
});

describe("tombol memori", () => {
  it("menawarkan Oke selain Lupakan", () => {
    const keyboard = memorySavedActions(memory());
    const labels = keyboard.inline_keyboard.flat().map((button) => button.text);

    assert.deepEqual(labels, ["Oke", "Lupakan"]);
  });
});

function memory(): MemoryItem {
  return {
    id: "mem00001",
    ownerId: "student",
    kind: "profile",
    content: "Nama pengguna Dimas",
    createdAt: "2026-07-26T10:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };
}
