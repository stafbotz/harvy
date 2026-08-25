import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveActiveTaskReference } from "../src/core/task-reference.js";
import type { StudentTask } from "../src/domain/task.js";

describe("resolusi referensi task natural", () => {
  it("memilih satu-satunya task aktif untuk rujukan deiktik", () => {
    const only = task("one", "Meninjau hasil uji live");
    assert.equal(
      resolveActiveTaskReference([only], "tugas peninjauan itu")?.id,
      "one",
    );
  });

  it("memilih kecocokan unik dan gagal tertutup saat ambigu", () => {
    const report = task("report", "Kirim laporan audit");
    const slides = task("slides", "Rapikan slide presentasi");
    assert.equal(
      resolveActiveTaskReference([report, slides], "laporan audit")?.id,
      "report",
    );
    assert.equal(
      resolveActiveTaskReference([report, task("other", "Baca laporan")], "laporan"),
      null,
    );
  });
});

function task(id: string, title: string): StudentTask {
  return {
    id,
    ownerId: "owner",
    chatId: "chat",
    title,
    dueAt: null,
    importance: 2,
    status: "active",
    createdAt: "2026-08-24T00:00:00.000Z",
    completedAt: null,
    reminderAt: null,
    reminderSentAt: null,
  };
}
