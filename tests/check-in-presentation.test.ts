import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkInPresentationInput,
  parseCheckInPresentation,
} from "../src/ai/check-in-presentation.js";
import type { ActiveSession } from "../src/domain/session.js";

const SESSION: ActiveSession = {
  id: "session-1",
  ownerId: "student",
  chatId: "chat",
  kind: "focus",
  goal: "menyelesaikan pembuka laporan",
  stage: "act",
  taskId: null,
  checkIn: {
    at: "2026-08-23T09:00:00.000Z",
    sentAt: null,
    delivery: null,
  },
  createdAt: "2026-08-23T08:00:00.000Z",
  updatedAt: "2026-08-23T08:00:00.000Z",
  expiresAt: "2026-08-24T09:00:00.000Z",
};

describe("check-in presentation", () => {
  it("menerima satu pertanyaan pendek", () => {
    assert.equal(
      parseCheckInPresentation(
        '{"question":"Pembuka laporannya sekarang terasa lebih ringan atau masih seret?"}',
      ),
      "Pembuka laporannya sekarang terasa lebih ringan atau masih seret?",
    );
  });

  it("menolak pernyataan, field tambahan, command, dan multiline", () => {
    assert.equal(parseCheckInPresentation('{"question":"Kamu pasti sudah selesai."}'), null);
    assert.equal(
      parseCheckInPresentation('{"question":"Sudah sampai mana?","status":"ok"}'),
      null,
    );
    assert.equal(parseCheckInPresentation('{"question":"Coba /menu dulu?"}'), null);
    assert.equal(
      parseCheckInPresentation('{"question":"Masih jalan? Atau sudah selesai?"}'),
      null,
    );
    assert.equal(
      parseCheckInPresentation('{"question":"Masih jalan?\\nAku tunggu."}'),
      null,
    );
  });

  it("tidak memasukkan goal privat ke payload notifikasi", () => {
    const input = checkInPresentationInput({
      ...SESSION,
      goal: "TOPIK-PRIVAT-YANG-TIDAK-BOLEH-KELUAR",
    });
    assert.doesNotMatch(input, /TOPIK-PRIVAT-YANG-TIDAK-BOLEH-KELUAR/u);
  });
});
