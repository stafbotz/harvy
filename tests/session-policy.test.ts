import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizedSessionSignal,
  sessionAppliesToMessage,
} from "../src/core/session-policy.js";
import type { ActiveSession, SessionSignal } from "../src/domain/session.js";
import type { SemanticOperation } from "../src/domain/semantic-operation.js";

describe("kebijakan sesi semantic", () => {
  it("membawa sesi dari meaning, goal overlap, atau jawaban struktural", () => {
    const active = session();
    assert.equal(
      sessionAppliesToMessage(active, "aku masih bingung bagian fotosintesis"),
      true,
    );
    assert.equal(sessionAppliesToMessage(active, "42"), true);
    assert.equal(sessionAppliesToMessage(active, "karena klorofil"), true);
    for (const message of [
      "continue with the previous exercise",
      "mangga teraskeun latihan tadi",
      "terusna latihan mau",
    ]) {
      assert.equal(
        sessionAppliesToMessage(active, message, sessionSemantic(message, "continue", "contextual")),
        true,
      );
    }
    const newTopic = "what is the weather today?";
    assert.equal(
      sessionAppliesToMessage(active, newTopic, {
        ...sessionSemantic(newTopic, "continue", "explicit"),
        domain: "history",
        operation: "recall",
      }),
      false,
    );
  });

  it("menghapus state hanya dari semantic done/cancel explicit yang sejalan", () => {
    for (const [message, signal] of [
      ["the photosynthesis session is finished", "done"],
      ["sési fotosintésisna parantos réngsé", "done"],
      ["mandheg sesi iki", "cancel"],
    ] as const) {
      assert.equal(
        authorizedSessionSignal(
          message,
          signal,
          session(),
          sessionSemantic(message, signal, "explicit"),
        ),
        signal,
      );
    }

    const vague = "maybe we're done";
    assert.equal(
      authorizedSessionSignal(
        vague,
        "done",
        session(),
        sessionSemantic(vague, "done", "implicit"),
      ),
      null,
    );
    assert.equal(
      authorizedSessionSignal(
        "continue",
        "done",
        session(),
        sessionSemantic("continue", "continue", "explicit"),
      ),
      null,
    );
  });

  it("menerima continue/stuck contextual tanpa memberi authority mutasi", () => {
    const message = "I still don't understand";
    assert.equal(
      authorizedSessionSignal(
        message,
        "stuck",
        session(),
        sessionSemantic(message, "stuck", "contextual"),
      ),
      "stuck",
    );
  });

  it("memulihkan selesai sesi eksplisit tanpa mempercayai label model", () => {
    assert.equal(
      sessionAppliesToMessage(session(), "udah selesai sesi fotosintesisnya"),
      true,
    );
    assert.equal(
      authorizedSessionSignal(
        "udah selesai sesi fotosintesisnya",
        null,
        session(),
        null,
      ),
      "done",
    );
    for (const message of [
      "sesi fotosintesisnya belum selesai",
      "jangan hentikan sesi fotosintesis",
      "selesai makan malam",
    ]) {
      assert.equal(
        authorizedSessionSignal(message, null, session(), null),
        null,
        message,
      );
    }
    const notDone = "sesi fotosintesisnya belum selesai";
    assert.equal(
      authorizedSessionSignal(
        notDone,
        "done",
        session(),
        sessionSemantic(notDone, "done", "explicit"),
      ),
      null,
    );
  });
});

function sessionSemantic(
  message: string,
  operation: SessionSignal,
  explicitness: "explicit" | "contextual" | "implicit",
): SemanticOperation {
  return {
    version: 1,
    domain: "session",
    operation,
    target: null,
    subject: "self",
    reference: "current",
    explicitness,
    evidence: message,
    confidence: 0.95,
  };
}

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
