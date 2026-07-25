import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sortTasksByPriority,
  taskPriorityScore,
} from "../src/core/prioritizer.js";
import type { StudentTask } from "../src/domain/task.js";

const NOW = new Date("2026-07-25T10:00:00.000Z");

describe("prioritizer", () => {
  it("menempatkan tenggat dekat di atas tugas tanpa tenggat", () => {
    const tasks = [
      makeTask({ id: "later", dueAt: null, importance: 3 }),
      makeTask({
        id: "urgent",
        dueAt: "2026-07-25T12:00:00.000Z",
        importance: 1,
      }),
    ];

    assert.deepEqual(
      sortTasksByPriority(tasks, NOW).map((task) => task.id),
      ["urgent", "later"],
    );
  });

  it("membuat skor transparan dari urgensi dan kepentingan", () => {
    const task = makeTask({
      dueAt: "2026-07-26T09:00:00.000Z",
      importance: 3,
    });
    assert.equal(taskPriorityScore(task, NOW), 110);
  });
});

function makeTask(overrides: Partial<StudentTask>): StudentTask {
  return {
    id: "task",
    ownerId: "student",
    chatId: "chat",
    title: "Tugas",
    dueAt: null,
    importance: 2,
    status: "active",
    createdAt: NOW.toISOString(),
    completedAt: null,
    reminderAt: null,
    reminderSentAt: null,
    ...overrides,
  };
}
