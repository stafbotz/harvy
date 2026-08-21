import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptiveActionButtons,
  bubblePauseMs,
  checkInOutcomeActions,
  dataControlActions,
  deleteAllConfirmActions,
  MAX_BUBBLE_PAUSE_MS,
  memoryConsentActions,
  memoryPortraitActions,
  memoryWipeConfirmActions,
  normalizeTelegramText,
  sessionActions,
  splitReplyBubbles,
  withMemoryNotes,
  withoutMemoryNote,
  withdrawConsentConfirmActions,
} from "../src/bot/messages.js";
import type { MemoryItem } from "../src/domain/memory.js";
import type { ActiveSession } from "../src/domain/session.js";

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
    assert.match(bubble, /💭 Siap, yang ini aku ingat: Nama pengguna Dimas/);
  });

  it("tidak mengubah bubble ketika tidak ada yang diingat", () => {
    assert.equal(withMemoryNotes("Oke.", []), "Oke.");
  });

  it("menawarkan satu tombol Ubah pada potret, bukan tombol per-item", () => {
    const keyboard = memoryPortraitActions();
    const buttons = keyboard.inline_keyboard.flat();

    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]?.text, "Ubah");
    assert.match(
      (buttons[0] as { callback_data?: string }).callback_data ?? "",
      /^memchange:$/,
    );
  });

  it("membuang barisnya saja, bukan seluruh balasan", () => {
    const sent = withMemoryNotes("Oke, aku ngerti.", [memory()]);
    const after = withoutMemoryNote(sent, "Nama pengguna Dimas");

    // Balasan itu pesan sungguhan. Menimpanya dengan daftar memori berarti
    // menghapus percakapan hanya karena satu tombol ditekan.
    assert.match(after, /^Oke, aku ngerti\./);
    assert.doesNotMatch(after, /💭/);
    assert.match(after, /aku lupain/i);
  });

  it("tetap memberi kabar ketika catatannya sudah tidak ditemukan", () => {
    assert.match(withoutMemoryNote("", null), /aku lupain/i);
  });
});

describe("tombol fitur Harvy Loop", () => {
  it("membentuk callback adaptif dari kode dan maksimal 64 byte", () => {
    const keyboard = adaptiveActionButtons({
      token: "abc12345",
      ownerId: "student",
      actions: ["clarify", "prioritize", "start_small"],
      goal: "cerita",
      taskId: null,
    });
    const buttons = keyboard.inline_keyboard.flat();

    assert.equal(buttons.length, 3);
    for (const button of buttons) {
      const callback =
        (button as { callback_data?: string }).callback_data ?? "";
      assert.match(callback, /^flow:abc12345\./u);
      assert.ok(Buffer.byteLength(callback, "utf8") <= 64);
    }
  });

  it("membersihkan Markdown dan LaTeX di luar blok kode", () => {
    assert.equal(
      normalizeTelegramText("**Jawab:** $\\frac{1}{2}$ dan _selesai_."),
      "Jawab: 1/2 dan selesai.",
    );
    assert.equal(
      normalizeTelegramText("```ts\nconst x = `a`;\n```"),
      "```ts\nconst x = `a`;\n```",
    );
  });

  it("tidak mengubah URL yang mempunyai underscore", () => {
    assert.equal(
      normalizeTelegramText("Sumber: https://example.com/a_b_c?x=dua_kata"),
      "Sumber: https://example.com/a_b_c?x=dua_kata",
    );
  });

  it("membatasi tutor pada tiga pilihan termasuk jawaban langsung dan berhenti", () => {
    const labels = sessionActions(session("tutor")).inline_keyboard
      .flat()
      .map((button) => button.text);
    assert.ok(labels.includes("Jelaskan langsung"));
    assert.ok(labels.includes("Berhenti"));
    assert.equal(labels.length, 3);
  });

  it("membentuk callback sesi, hasil check-in, dan kontrol data yang pendek", () => {
    const keyboards = [
      sessionActions(session("focus")),
      checkInOutcomeActions(session("focus")),
      dataControlActions(),
    ];
    for (const keyboard of keyboards) {
      for (const button of keyboard.inline_keyboard.flat()) {
        const callback =
          (button as { callback_data?: string }).callback_data ?? "";
        assert.ok(Buffer.byteLength(callback, "utf8") <= 64);
      }
    }
    const dataCallbacks = dataControlActions().inline_keyboard.flat()
      .map((button) => "callback_data" in button ? button.callback_data : "");
    assert.ok(dataCallbacks.includes("control:memories"));
    assert.ok(dataCallbacks.includes("memall:"));
  });

  it("mengikat persetujuan memori sensitif ke token proposal", () => {
    const callbacks = memoryConsentActions("mem12345").inline_keyboard
      .flat()
      .map((button) => ("callback_data" in button ? button.callback_data : ""));

    assert.deepEqual(callbacks, [
      "memsave:mem12345",
      "memskip:mem12345",
    ]);
  });

  it("mengikat seluruh konfirmasi destruktif ke token sekali pakai", () => {
    const callbacks = [
      ...memoryWipeConfirmActions("wipe1234").inline_keyboard.flat(),
      ...withdrawConsentConfirmActions("leave123").inline_keyboard.flat(),
      ...deleteAllConfirmActions("delete12").inline_keyboard.flat(),
    ].map((button) =>
      "callback_data" in button ? button.callback_data : "",
    );

    assert.deepEqual(callbacks, [
      "memallyes:wipe1234",
      "memallno:wipe1234",
      "consentwithdraw:leave123.yes",
      "consentwithdraw:leave123.no",
      "datawipe:delete12.yes",
      "datawipe:delete12.no",
    ]);
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

function session(kind: ActiveSession["kind"]): ActiveSession {
  return {
    id: "session123",
    ownerId: "student",
    chatId: "chat",
    kind,
    goal: "belajar",
    stage: kind === "tutor" ? "hint" : "act",
    taskId: null,
    checkIn: null,
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-27T10:00:00.000Z",
    expiresAt: "2026-08-03T10:00:00.000Z",
  };
}
