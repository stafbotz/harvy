import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizedSessionSignal,
  sessionAppliesToMessage,
} from "../src/core/session-policy.js";
import type { ActiveSession } from "../src/domain/session.js";

describe("kebijakan sesi lunak", () => {
  it("membawa sesi hanya untuk tujuan atau jawaban yang berkaitan", () => {
    const active = session();
    assert.equal(
      sessionAppliesToMessage(active, "aku masih bingung bagian fotosintesis"),
      true,
    );
    assert.equal(sessionAppliesToMessage(active, "42"), true);
    assert.equal(
      sessionAppliesToMessage(active, "btw cuaca Jakarta hari ini gimana?"),
      false,
    );
    assert.equal(
      sessionAppliesToMessage(active, "siapa presiden Indonesia sekarang?"),
      false,
    );
    assert.equal(
      sessionAppliesToMessage(active, "besok aku ada dokter gigi"),
      false,
    );
    assert.equal(
      sessionAppliesToMessage(active, "aku berantem sama ibu"),
      false,
    );
    assert.equal(
      sessionAppliesToMessage(active, "aku masih marah sama ibu"),
      false,
    );
    assert.equal(
      sessionAppliesToMessage(active, "aku belum siap cerita soal rumah"),
      false,
    );
    assert.equal(sessionAppliesToMessage(active, "jawabanku oksigen"), true);
    assert.equal(sessionAppliesToMessage(active, "karena klorofil"), true);
  });

  it("tidak menghapus sesi dari usulan model tanpa kata pengguna yang jelas", () => {
    assert.equal(authorizedSessionSignal("aku coba dulu", "done"), null);
    assert.equal(authorizedSessionSignal("udah selesai", "done"), null);
    assert.equal(
      authorizedSessionSignal("sesi fotosintesisnya udah selesai", "done", session()),
      "done",
    );
    assert.equal(
      authorizedSessionSignal("aku udah selesai makan", "done", session()),
      null,
    );
    assert.equal(
      authorizedSessionSignal("tolong berhentiin sesi ini", "cancel"),
      "cancel",
    );
    assert.equal(authorizedSessionSignal("aku belum paham", "stuck"), "stuck");
  });
});

function session(): ActiveSession {
  return {
    id: "session-1",
    ownerId: "student",
    chatId: "10",
    kind: "tutor",
    goal: "Memahami fotosintesis",
    stage: "attempt",
    taskId: null,
    checkIn: null,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
  };
}
