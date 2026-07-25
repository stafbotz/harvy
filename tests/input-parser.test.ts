import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseAddTask,
  parseLocalDateTime,
  parseReminder,
} from "../src/core/input-parser.js";

describe("input parser", () => {
  it("membaca tugas lengkap dalam zona Jakarta", () => {
    const parsed = parseAddTask(
      "Matematika halaman 20 | 2026-07-28 19:00 | tinggi",
      "+07:00",
    );

    assert.equal(parsed.title, "Matematika halaman 20");
    assert.equal(parsed.dueAt?.toISOString(), "2026-07-28T12:00:00.000Z");
    assert.equal(parsed.importance, 3);
  });

  it("mengizinkan tugas tanpa tenggat", () => {
    const parsed = parseAddTask("Bawa buku sejarah", "+07:00");
    assert.equal(parsed.dueAt, null);
    assert.equal(parsed.importance, 2);
  });

  it("menolak tanggal yang tidak ada", () => {
    assert.equal(parseLocalDateTime("2026-02-30 10:00", "+07:00"), null);
  });

  it("membaca perintah pengingat", () => {
    const parsed = parseReminder(
      "a1b2c3d4 | 2026-07-28 17:00",
      "+07:00",
    );
    assert.equal(parsed.id, "a1b2c3d4");
    assert.equal(parsed.reminderAt.toISOString(), "2026-07-28T10:00:00.000Z");
  });
});
