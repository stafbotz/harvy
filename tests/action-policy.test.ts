import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adaptiveActions,
  prefersGuidedSmallStep,
  replyHasBlockingQuestion,
  type AdaptiveActionId,
} from "../src/core/action-policy.js";
import { ActionOfferStore } from "../src/bot/action-offers.js";

describe("tombol adaptif", () => {
  it("memakai allowlist intent, membuang duplikat, dan memilih satu", () => {
    assert.deepEqual(
      adaptiveActions(
        [
          "listen",
          "clarify",
          "listen",
          "prioritize",
          "start_small",
        ],
        {
          intent: "feeling",
          risk: "biasa",
          hasActiveSession: false,
          hasBlockingQuestion: false,
        },
      ),
      ["listen"],
    );
  });

  it("tidak menawarkan produktivitas pada giliran berisiko atau terblokir", () => {
    const proposed: AdaptiveActionId[] = ["prioritize", "start_small"];
    assert.deepEqual(
      adaptiveActions(proposed, {
        intent: "feeling",
        risk: "dukungan",
        hasActiveSession: false,
        hasBlockingQuestion: false,
      }),
      [],
    );
    assert.deepEqual(
      adaptiveActions(proposed, {
        intent: "feeling",
        risk: "biasa",
        hasActiveSession: false,
        hasBlockingQuestion: true,
      }),
      [],
    );
  });

  it("membatasi sesi aktif pada satu kontrol sesi", () => {
    assert.deepEqual(
      adaptiveActions(
        ["listen", "schedule_checkin", "view_session", "stop_session"],
        {
          intent: "feeling",
          risk: "biasa",
          hasActiveSession: true,
          hasBlockingQuestion: false,
        },
      ),
      ["schedule_checkin"],
    );
  });

  it("tidak menawarkan tombol sesi ketika tidak ada sesi", () => {
    assert.deepEqual(
      adaptiveActions(["view_session"], {
        intent: "history",
        risk: "biasa",
        hasActiveSession: false,
        hasBlockingQuestion: false,
      }),
      [],
    );
  });

  it("memilih interaksi langkah kecil dari sinyal semantik, bukan kata mentah", () => {
    const assessment = {
      complexity: "normal" as const,
      ambiguity: "medium" as const,
      planningRequired: true,
      emotionalNuance: "high" as const,
      executionSize: "small" as const,
      factualStakes: "low" as const,
      transformationMechanical: false,
      toolNeed: "none" as const,
      confidence: 0.9,
    };
    assert.equal(
      prefersGuidedSmallStep(["start_small", "plan"], assessment),
      true,
    );
    assert.equal(prefersGuidedSmallStep(["plan"], assessment), false);
    assert.equal(
      prefersGuidedSmallStep(["start_small"], {
        ...assessment,
        executionSize: "heavy",
        toolNeed: "execution",
      }),
      false,
    );
  });

  it("menolak tombol bila balasan menunggu jawaban bebas", () => {
    assert.equal(replyHasBlockingQuestion("Yang paling berat bagian mana?"), true);
    assert.equal(
      replyHasBlockingQuestion(
        "Kamu mau mulai dari mana? Pilih tombol di bawah.",
      ),
      true,
    );
    assert.equal(replyHasBlockingQuestion("Kamu boleh pilih tombol di bawah."), false);
    assert.equal(
      replyHasBlockingQuestion("Ceritain bagian yang paling berat."),
      true,
    );
    assert.equal(
      replyHasBlockingQuestion("Pilih mana yang mau kamu bahas dulu."),
      true,
    );
    assert.equal(
      replyHasBlockingQuestion("```ts\nconst query = value?.name;\n```"),
      false,
    );
  });
});

describe("tawaran tindakan sesaat", () => {
  it("terikat pemilik, token, aksi, dan hanya dapat dipakai sekali", () => {
    const store = new ActionOfferStore();
    const offer = store.set("a", ["clarify", "listen"], "  cerita   tadi ");

    assert.equal(store.take("b", offer.token, "clarify"), null);
    assert.equal(store.take("a", "salah", "clarify"), null);
    assert.equal(store.take("a", offer.token, "tutor"), null);
    assert.equal(
      store.take("a", offer.token, "clarify")?.goal,
      "cerita tadi",
    );
    assert.equal(store.take("a", offer.token, "clarify"), null);
  });

  it("mengganti tawaran lama dan menolak tujuan kosong", () => {
    const store = new ActionOfferStore();
    const first = store.set("a", ["listen"], "pertama");
    const second = store.set("a", ["clarify"], "kedua");

    assert.equal(store.take("a", first.token, "listen"), null);
    assert.equal(store.take("a", second.token, "clarify")?.goal, "kedua");
    assert.throws(() => store.set("a", ["listen"], "   "));
  });

  it("kedaluwarsa tepat di batas TTL", () => {
    let now = 10;
    const store = new ActionOfferStore(100, () => now);
    const offer = store.set("a", ["listen"], "cerita");
    now = 110;
    assert.equal(store.take("a", offer.token, "listen"), null);
  });
});
