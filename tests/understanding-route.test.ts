import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Understanding } from "../src/ai/understand.js";
import {
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
      ),
      { kind: "memory-control", action: "list" },
    );
    assert.deepEqual(
      immediateUnderstandingRoute(
        sample({ intent: "smalltalk", memoryAction: "list" }),
      ),
      { kind: "conversation" },
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
