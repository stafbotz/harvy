import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bubblePauseMs,
  MAX_BUBBLE_PAUSE_MS,
  memoryNoteActions,
  splitReplyBubbles,
  withMemoryNotes,
  withoutMemoryNote,
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

describe("jeda antar bubble", () => {
  it("menyesuaikan panjang teks tanpa melewati plafon", () => {
    assert.ok(bubblePauseMs("oke") < bubblePauseMs("oke, aku ngerti maksudmu"));
    assert.equal(bubblePauseMs("x".repeat(500)), MAX_BUBBLE_PAUSE_MS);
    assert.ok(bubblePauseMs("") >= 300);
  });
});

describe("catatan memori pada balasan", () => {
  it("menempel di ujung bubble, bukan menjadi pesan tersendiri", () => {
    const bubble = withMemoryNotes("Oke, aku ngerti.", [memory()]);

    // Pasal 4 nomor 2 meminta pengguna diberi tahu, bukan meminta percakapan
    // dipotong pop-up yang harus ditutup dulu.
    assert.match(bubble, /^Oke, aku ngerti\./);
    assert.match(bubble, /📎 aku inget ini: Nama pengguna Dimas/);
  });

  it("tidak mengubah bubble ketika tidak ada yang diingat", () => {
    assert.equal(withMemoryNotes("Oke.", []), "Oke.");
  });

  it("menawarkan satu tombol Lupakan untuk satu catatan", () => {
    const keyboard = memoryNoteActions([memory()]);
    const buttons = keyboard.inline_keyboard.flat();

    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]?.text, "Lupakan itu");
    assert.match(
      (buttons[0] as { callback_data?: string }).callback_data ?? "",
      /^memdrop:mem00001$/,
    );
  });

  it("membuang barisnya saja, bukan seluruh balasan", () => {
    const sent = withMemoryNotes("Oke, aku ngerti.", [memory()]);
    const after = withoutMemoryNote(sent, "Nama pengguna Dimas");

    // Balasan itu pesan sungguhan. Menimpanya dengan daftar memori berarti
    // menghapus percakapan hanya karena satu tombol ditekan.
    assert.match(after, /^Oke, aku ngerti\./);
    assert.doesNotMatch(after, /📎/);
    assert.match(after, /aku lupain/i);
  });

  it("tetap memberi kabar ketika catatannya sudah tidak ditemukan", () => {
    assert.match(withoutMemoryNote("", null), /aku lupain/i);
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
