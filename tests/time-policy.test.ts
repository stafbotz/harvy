import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isInQuietHours,
  isValidQuietHours,
  isValidTimeZone,
  localMinuteOfDay,
  parseQuietHours,
} from "../src/core/time-policy.js";

describe("zona waktu pengguna", () => {
  it("membaca instant yang sama sebagai WIB, WITA, dan WIT", () => {
    const instant = new Date("2026-07-27T14:30:00.000Z");
    assert.equal(localMinuteOfDay(instant, "Asia/Jakarta"), 21 * 60 + 30);
    assert.equal(localMinuteOfDay(instant, "Asia/Makassar"), 22 * 60 + 30);
    assert.equal(localMinuteOfDay(instant, "Asia/Jayapura"), 23 * 60 + 30);
  });

  it("memvalidasi nama zona waktu IANA", () => {
    assert.equal(isValidTimeZone("Asia/Jakarta"), true);
    assert.equal(isValidTimeZone("Waktu/Karanganku"), false);
  });
});

describe("jam tenang", () => {
  it("bersifat inklusif di awal dan eksklusif di akhir", () => {
    const hours = { startMinute: 21 * 60, endMinute: 6 * 60 };
    assert.equal(
      isInQuietHours(
        new Date("2026-07-27T14:00:00.000Z"),
        "Asia/Jakarta",
        hours,
      ),
      true,
    );
    assert.equal(
      isInQuietHours(
        new Date("2026-07-27T23:00:00.000Z"),
        "Asia/Jakarta",
        hours,
      ),
      false,
    );
  });

  it("mendukung rentang biasa dan tanpa jam tenang", () => {
    const noon = new Date("2026-07-27T05:00:00.000Z");
    assert.equal(
      isInQuietHours(noon, "Asia/Jakarta", {
        startMinute: 11 * 60,
        endMinute: 13 * 60,
      }),
      true,
    );
    assert.equal(isInQuietHours(noon, "Asia/Jakarta", null), false);
  });

  it("menolak rentang cacat dan membaca bentuk yang ditulis pengguna", () => {
    assert.equal(
      isValidQuietHours({ startMinute: 60, endMinute: 60 }),
      false,
    );
    assert.equal(
      isValidQuietHours({ startMinute: -1, endMinute: 60 }),
      false,
    );
    assert.deepEqual(parseQuietHours("21.30–06.00"), {
      startMinute: 21 * 60 + 30,
      endMinute: 6 * 60,
    });
    assert.equal(parseQuietHours("25.00-06.00"), null);
  });
});
