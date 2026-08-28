import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptiveActionButtons,
  bubblePauseMs,
  checkInOutcomeActions,
  dataControlActions,
  deleteAllConfirmActions,
  formatSession,
  formatTask,
  MAX_BUBBLE_PAUSE_MS,
  memoryPortraitActions,
  memoryWipeConfirmActions,
  normalizeTelegramText,
  sessionActions,
  splitReplyBubbles,
  withMemoryNotes,
  withoutMemoryNote,
  withdrawConsentConfirmActions,
} from "../src/bot/messages.js";
import {
  normalizeMemoryWriteEmoji,
  replyAcknowledgesMemoryWrite,
  withoutUnconfirmedMemoryWriteClaims,
} from "../src/core/memory-explicit-consent.js";
import type { MemoryItem } from "../src/domain/memory.js";
import type { ActiveSession } from "../src/domain/session.js";
import type { StudentTask } from "../src/domain/task.js";

describe("bubble balasan", () => {
  it("memisahkan paragraf alami menjadi bubble pendek", () => {
    assert.deepEqual(
      splitReplyBubbles(
        "Makasih sudah percaya cerita.\n\nApa yang paling bikin kepikiran?",
      ),
      ["Makasih sudah percaya cerita.", "Apa yang paling bikin kepikiran?"],
    );
  });

  it("membiarkan empat beat natural tanpa aturan maksimal tiga", () => {
    assert.deepEqual(splitReplyBubbles("satu\n\ndua\n\ntiga\n\nempat"), [
      "satu",
      "dua",
      "tiga",
      "empat",
    ]);
  });

  it("menjaga penjelasan panjang yang koheren sebagai satu bubble", () => {
    const explanation = [
      "Pilihan pertama cocok kalau kamu ingin fondasi teori yang kuat dan ruang eksplorasi yang luas. Bagian ini menjelaskan alasan utamanya dengan cukup rinci supaya konteksnya tidak terputus.",
      "Pilihan kedua lebih langsung ke praktik dan proyek. Perbedaannya baru terasa dari cara belajar, bukan sekadar nama jurusan atau kesan awal.",
      "Jadi, keputusan akhirnya sebaiknya mengikuti cara belajar yang membuatmu konsisten. Kita bisa membandingkan kurikulumnya kalau kamu punya dua kampus spesifik.",
    ].join("\n\n");

    assert.deepEqual(splitReplyBubbles(explanation), [explanation]);
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
  it("memakai satu fallback write tanpa mencetak record atau simbol recall", () => {
    const bubble = withMemoryNotes("Oke, aku ngerti.", [memory()]);

    assert.match(bubble, /^Oke, aku ngerti\./);
    assert.match(bubble, /Yang ini juga aku ingat untuk ke depan 📍/u);
    assert.doesNotMatch(bubble, /Nama pengguna Dimas/iu);
    assert.doesNotMatch(bubble, /💭/u);
  });

  it("merangkum beberapa write sebagai satu kalimat, bukan rentetan log", () => {
    const second = { ...memory(), id: "mem00002", content: "Belajar pagi" };
    const bubble = withMemoryNotes("Oke.", [memory(), second]);

    assert.equal((bubble.match(/📍/gu) ?? []).length, 1);
    assert.doesNotMatch(bubble, /(?:•|Nama pengguna Dimas|Belajar pagi)/u);
    assert.equal(bubble.split("\n").filter((line) => /ingat/iu.test(line)).length, 1);
  });

  it("tidak mengubah bubble ketika tidak ada yang diingat", () => {
    assert.equal(withMemoryNotes("Oke.", []), "Oke.");
  });

  it("mengenali bahasa save/update tanpa menyamakan recall dengan write", () => {
    assert.equal(
      replyAcknowledgesMemoryWrite(
        "Aku bakal inget kok kalau kamu cinta banget sama Rani.",
      ),
      true,
    );
    assert.equal(replyAcknowledgesMemoryWrite("Oke, aku mencatat yang ini."), true);
    assert.equal(replyAcknowledgesMemoryWrite("Aturan baru dicatat untuk ke depan."), true);
    assert.equal(replyAcknowledgesMemoryWrite("Aturan itu belum dicatat."), false);
    assert.equal(replyAcknowledgesMemoryWrite("Aku perbarui yang dulu 📍"), true);
    assert.equal(replyAcknowledgesMemoryWrite("Mulai sekarang aku panggil Hafizh."), true);
    assert.equal(replyAcknowledgesMemoryWrite("Tenang, aku nggak bakal lupa."), true);
    assert.equal(replyAcknowledgesMemoryWrite("Sip, Hafizh 📍"), true);
    assert.equal(replyAcknowledgesMemoryWrite("Aku belum bisa menyimpan itu."), false);
    assert.equal(replyAcknowledgesMemoryWrite("Kamu perlu ingat hal ini."), false);
    assert.equal(
      replyAcknowledgesMemoryWrite("💭 Aku masih inget dulu kamu mempertimbangkan UI."),
      false,
    );
    assert.equal(replyAcknowledgesMemoryWrite("Aku dengar ceritamu."), false);
  });

  it("mengoreksi 💭 hanya bila dipakai pada klausa write", () => {
    assert.equal(
      normalizeMemoryWriteEmoji("💭 Aku simpan yang ini."),
      "📍 Aku simpan yang ini.",
    );
    assert.equal(
      normalizeMemoryWriteEmoji(
        "💭 Aku masih inget dulu kamu condong ke UI. Yang baru ini aku catat 📍",
      ),
      "💭 Aku masih inget dulu kamu condong ke UI. Yang baru ini aku catat 📍",
    );
  });

  it("membuang klaim write tanpa receipt sambil mempertahankan isi lain", () => {
    assert.equal(
      withoutUnconfirmedMemoryWriteClaims(
        "Aku paham kenapa itu melelahkan. Aku simpan pilihanmu ya. Kita bisa mulai pelan-pelan.",
      ),
      "Aku paham kenapa itu melelahkan. Kita bisa mulai pelan-pelan.",
    );
    assert.equal(
      withoutUnconfirmedMemoryWriteClaims("💭 Aku masih inget dulu kamu memilih UI."),
      "💭 Aku masih inget dulu kamu memilih UI.",
    );
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
    assert.doesNotMatch(after, /📍/);
    assert.match(after, /aku lupain/i);
  });

  it("tetap memberi kabar ketika catatannya sudah tidak ditemukan", () => {
    assert.match(withoutMemoryNote("", null), /aku lupain/i);
  });
});

describe("tombol fitur Harvy Loop", () => {
  it("menampilkan outcome pengiriman yang tidak pasti tanpa menjanjikan retry", () => {
    const uncertain = {
      effectId: "effect-1",
      status: "unknown" as const,
      preparedAt: "2026-08-23T10:00:00.000Z",
      completedAt: "2026-08-23T10:00:01.000Z",
    };
    const task: StudentTask = {
      id: "task-1",
      ownerId: "student",
      chatId: "chat",
      title: "Kumpulkan laporan",
      dueAt: null,
      importance: 2,
      status: "active",
      createdAt: "2026-08-23T09:00:00.000Z",
      completedAt: null,
      reminderAt: "2026-08-23T10:00:00.000Z",
      reminderSentAt: null,
      reminderDelivery: uncertain,
    };
    const active = {
      ...session("focus"),
      checkIn: {
        at: "2026-08-23T10:00:00.000Z",
        sentAt: null,
        delivery: uncertain,
      },
    };

    const renderedTask = formatTask(task, "Asia/Jakarta");
    assert.match(renderedTask, /tidak pasti.*atur ulang/iu);
    assert.doesNotMatch(renderedTask, /tanpa tenggat/iu);
    assert.match(formatSession(active, "Asia/Jakarta"), /tidak pasti.*jadwalkan ulang/iu);
  });

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

  it("selalu menyediakan berhenti pada sesi fokus, termasuk setelah check-in dijadwalkan", () => {
    const keyboard = sessionActions({
      ...session("focus"),
      checkIn: {
        at: "2026-08-23T12:30:00.000Z",
        sentAt: null,
        delivery: null,
      },
    });
    const buttons = keyboard.inline_keyboard.flat();
    const stop = buttons.find((button) => button.text === "Berhenti");
    assert.ok(stop);
    assert.equal(
      "callback_data" in stop ? stop.callback_data : "",
      "session:session123.stop",
    );
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
