import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Understanding } from "../src/ai/understand.js";
import {
  immediateUnderstandingRoute,
  isVagueTaskTitle,
  looksLikeMemoryRequest,
  taskToOffer,
} from "../src/bot/understanding-route.js";

describe("routing hasil pemahaman di adapter bot", () => {
  it("membawa permintaan hasil langsung ke percakapan, bukan tugas", () => {
    const understanding = sample({
      intent: "request",
      taskAction: "offer",
      task: task("Buat kode tic-tac-toe"),
    });

    assert.deepEqual(immediateUnderstandingRoute(understanding), {
      kind: "conversation",
    });
    assert.equal(taskToOffer(understanding), null);
  });

  it("membawa preferensi baru ke percakapan agar memorinya diproses", () => {
    const understanding = sample({
      intent: "smalltalk",
      memories: [{ kind: "preference", content: "Warna favoritnya biru" }],
    });

    assert.deepEqual(immediateUnderstandingRoute(understanding), {
      kind: "conversation",
    });
    assert.equal(understanding.memories.length, 1);
  });

  it("hanya menyimpan kombinasi task dan save", () => {
    const extractedTask = task("Kumpulkan matematika");
    const route = immediateUnderstandingRoute(
      sample({
        intent: "task",
        taskAction: "save",
        task: extractedTask,
      }),
    );

    assert.deepEqual(route, { kind: "save-task", task: extractedTask });
  });

  it("membuka kontrol memori hanya untuk intent dan aksi yang sejalan", () => {
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({ intent: "memory", memoryAction: "list" }),
        "apa yang kamu ingat tentang aku",
      ),
      { kind: "memory-control", action: "list" },
    );
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({ intent: "smalltalk", memoryAction: "list" }),
        "apa yang kamu ingat tentang aku",
      ),
      { kind: "conversation" },
    );
  });

  it("tidak membuka daftar memori ketika pesannya tidak menyinggung ingatan", () => {
    // Transkrip 26 Juli 2026: "iya kan aku udah tulis di situ kamu pahami aja"
    // membuka seluruh catatan pribadi seseorang berikut tombol Lupakan semua.
    // Yang ia minta adalah ceritanya dibaca.
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({ intent: "memory", memoryAction: "list" }),
        "iya kan aku udah tulis di situ kamu pahami aja",
      ),
      { kind: "conversation" },
    );

    assert.equal(looksLikeMemoryRequest("kamu inget apa aja tentang aku"), true);
    assert.equal(looksLikeMemoryRequest("lupain semua dong"), true);
    assert.equal(looksLikeMemoryRequest("kamu pahami aja"), false);
  });

  it("tidak mencatat tugas yang isinya belum disebut pengguna", () => {
    // "eh buat pengingat dong" pernah tersimpan sebagai tugas berjudul
    // "Membuat pengingat" tanpa tenggat, padahal Harvy sendiri sedang bertanya
    // isinya pada kalimat yang sama.
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({
          intent: "task",
          taskAction: "save",
          task: task("Membuat pengingat"),
        }),
        "eh buat pengingat dong",
      ),
      { kind: "conversation" },
    );

    for (const title of [
      "Membuat pengingat",
      "buat pengingat",
      "bikin tugas baru",
      "Pengingat",
      "catat",
      "to-do",
    ]) {
      assert.equal(isVagueTaskTitle(title), true, title);
    }

    for (const title of [
      "Kumpulkan matematika halaman 20",
      "Minum obat",
      "Belajar biologi bab genetika",
    ]) {
      assert.equal(isVagueTaskTitle(title), false, title);
    }
  });

  it("hanya menawarkan tugas yang tersirat pada cerita pengguna", () => {
    const extractedTask = task("Belajar untuk ulangan biologi");

    assert.equal(
      taskToOffer(
        sample({
          intent: "feeling",
          taskAction: "offer",
          task: extractedTask,
        }),
      ),
      extractedTask,
    );

    // Tawaran pun tidak boleh berisi tugas kosong.
    assert.equal(
      taskToOffer(
        sample({
          intent: "feeling",
          taskAction: "offer",
          task: task("Membuat catatan"),
        }),
      ),
      null,
    );
  });
});

function sample(overrides: Partial<Understanding>): Understanding {
  return {
    intent: "smalltalk",
    taskAction: null,
    memoryAction: null,
    safetySensitive: false,
    needsStepByStep: false,
    task: null,
    memories: [],
    ...overrides,
  };
}

function task(title: string) {
  return {
    title,
    dueAt: null,
    remindAt: null,
    importance: 2 as const,
  };
}
