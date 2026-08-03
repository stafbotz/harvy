import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Understanding } from "../src/ai/understand.js";
import {
  hasExplicitTaskWriteRequest,
  immediateUnderstandingRoute,
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

  it("hanya menyimpan kombinasi task, save, dan izin eksplisit", () => {
    const extractedTask = task("Kumpulkan matematika");
    const route = immediateUnderstandingRoute(
      sample({
        intent: "task",
        taskAction: "save",
        task: extractedTask,
      }),
      "tolong catat kumpulkan matematika",
    );

    assert.deepEqual(route, { kind: "save-task", task: extractedTask });
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({
          intent: "task",
          taskAction: "save",
          task: extractedTask,
        }),
        "pilihin aku mulai dari mana, jangan tanya balik",
      ),
      { kind: "conversation" },
    );
    assert.equal(hasExplicitTaskWriteRequest("ingetin aku jam 8 minum obat"), true);
    assert.equal(hasExplicitTaskWriteRequest("aku harus bikin presentasi"), false);
    assert.equal(hasExplicitTaskWriteRequest("jangan catat ini"), false);
    assert.equal(hasExplicitTaskWriteRequest("nggak usah disimpan"), false);
    assert.equal(
      hasExplicitTaskWriteRequest("aku tidak minta diingatkan"),
      false,
    );
    assert.equal(
      hasExplicitTaskWriteRequest("jangan lupa ingatkan aku minum obat"),
      true,
    );
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({
          intent: "task",
          taskAction: "save",
          task: task("Membuat pengingat"),
        }),
        "buat pengingat dong",
      ),
      { kind: "conversation" },
    );
    for (const message of [
      "tolong catat dong",
      "simpan ini ya",
      "tambah tugas",
    ]) {
      assert.deepEqual(
        immediateUnderstandingRoute(
          sample({
            intent: "task",
            taskAction: "save",
            task: task("Mencatat tugas"),
          }),
          message,
        ),
        { kind: "conversation" },
      );
    }
  });

  it("membuka kontrol memori hanya untuk intent dan aksi yang sejalan", () => {
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({ intent: "memory", memoryAction: "list" }),
      ),
      { kind: "memory-control", action: "list" },
    );
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({ intent: "smalltalk", memoryAction: "list" }),
      ),
      { kind: "conversation" },
    );
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({ intent: "memory", memoryAction: "edit" }),
      ),
      { kind: "memory-control", action: "edit" },
    );
  });

  it("membawa kontrol data langsung ke adapter", () => {
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({
          intent: "control",
          controlAction: "export",
        }),
      ),
      { kind: "control", action: "export" },
    );
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
