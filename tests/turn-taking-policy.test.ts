import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessmentIdleWindowMs,
  assessTurnBoundaryLocally,
  classifyTurnBoundaryLocally,
  guardTurnBoundary,
  idleWindowMs,
  MULTI_BUBBLE_IDLE_MS,
} from "../src/core/turn-taking-policy.js";

describe("kebijakan giliran percakapan", () => {
  it("memutus bentuk lengkap yang sempit tanpa classifier", () => {
    for (const message of [
      "iya",
      "oke",
      "makasih",
      "B",
      "opsi 2",
      "17 x 24 berapa?",
      "apa ibu kota Jepang?",
      "17 Agustus tahun ini hari apa?",
    ]) {
      assert.equal(classifyTurnBoundaryLocally(message), "complete", message);
    }
  });

  it("menahan fragmen yang jelas tanpa classifier", () => {
    for (const message of ["karena", "tapi", "terus aku", "jadi tadi aku mau"]) {
      assert.equal(classifyTurnBoundaryLocally(message), "incomplete", message);
    }
  });

  it("menyerahkan pembuka dan emosi ambigu ke classifier", () => {
    for (const message of [
      "jadi gini",
      "aku mau cerita",
      "aku capek banget",
      "kamu masih ingat yang tadi?",
      "eh, kenapa ya?",
      "aku mau menyakiti diri sekarang",
      "satu\ndua",
    ]) {
      assert.equal(classifyTurnBoundaryLocally(message), null, message);
    }
  });

  it("menyerahkan bahasa natural ambigu ke assessment semantik", () => {
    assert.equal(guardTurnBoundary("eh tau ga", "open"), "open");
    assert.equal(guardTurnBoundary("eh tau ga", "complete"), "complete");
    assert.equal(guardTurnBoundary("aku takut", "open"), "open");
    assert.equal(
      guardTurnBoundary(
        "aku bingung antara informatika dan SI, menurutmu pilih mana",
        "complete",
      ),
      "complete",
    );
  });

  it("memaksa fragmen karna menunggu jendela terpanjang", () => {
    const state = guardTurnBoundary(
      "aku mau curhat\naku hari ini\ncapekk banget\nkarna",
      "complete",
    );

    assert.equal(state, "incomplete");
    assert.equal(idleWindowMs(state, 4), 12_000);
  });

  it("menghormati keputusan urgent fallback model tanpa menundanya", () => {
    assert.equal(guardTurnBoundary("aku takutttt banget", "open"), "open");
    assert.equal(
      guardTurnBoundary("aku mau menyakiti diri sekarang", "urgent"),
      "urgent",
    );
    assert.equal(idleWindowMs("urgent", 2), 0);
  });

  it("menjaga complete kuat cepat dan hanya menunggu complete yang ragu", () => {
    assert.equal(idleWindowMs("complete", 1), 0);
    assert.equal(idleWindowMs("complete", 3), 0);
    assert.equal(
      assessmentIdleWindowMs({
        state: "complete",
        confidence: 0.6,
        continuationLikelihood: 0.6,
        reasonClass: "uncertain",
      }, 3),
      4_000,
    );
    assert.equal(idleWindowMs("open", 1), 7_000);
  });

  it("mempertahankan closed form sempit dan fragmen keras", () => {
    assert.equal(guardTurnBoundary("nggak jadi", "incomplete"), "complete");
    assert.equal(guardTurnBoundary("jadi", "complete"), "incomplete");
  });
});

describe("penilaian batas giliran lokal pada semburan", () => {
  // Sampai 30 Agustus 2026 fungsi ini menyerah pada setiap pesan multi-bubble,
  // sehingga seluruh semburan dilempar ke classifier model. Classifier itu
  // gagal pada 16 dari 28 giliran sesi nyata, dan setiap kegagalan menjadi
  // tunggu tujuh detik—pada bentuk pesan yang justru paling sering muncul.
  it("membaca bubble terakhir untuk memutuskan kelengkapan", () => {
    const assessment = assessTurnBoundaryLocally(
      ["aku mau nanya", "makasih ya"].join("\n"),
    );

    assert.equal(assessment?.state, "complete");
  });

  it("mengenali fragmen di bubble terakhir sebagai belum selesai", () => {
    const assessment = assessTurnBoundaryLocally(
      ["besok ada ujian biologi", "soalnya"].join("\n"),
    );

    assert.equal(assessment?.state, "incomplete");
  });

  // Ini penjaga yang paling penting di berkas ini. Dengan keyakinan 0,99 dan
  // continuation 0,02, `assessmentIdleWindowMs` melewati bantalan multi-bubble
  // dan memotong di nol detik—tepat pada bentuk pesan yang paling mungkin
  // masih berlanjut.
  it("tidak memotong semburan di nol detik", () => {
    const assessment = assessTurnBoundaryLocally(
      ["aku mau nanya", "makasih ya"].join("\n"),
    );
    assert.ok(assessment);

    assert.ok(
      assessmentIdleWindowMs(assessment, 2) >= MULTI_BUBBLE_IDLE_MS,
      "semburan yang tampak lengkap tetap mendapat bantalan",
    );
  });

  it("mempertahankan pemotongan segera untuk satu bubble yang jelas selesai", () => {
    const assessment = assessTurnBoundaryLocally("makasih ya");
    assert.ok(assessment);

    assert.equal(assessment.state, "complete");
    assert.equal(assessmentIdleWindowMs(assessment, 1), 0);
  });

  it("tetap menyerah ketika bubble terakhir tidak jelas", () => {
    assert.equal(
      assessTurnBoundaryLocally(
        ["besok dua deadline", "aku harus gimana ya kira-kira"].join("\n"),
      ),
      null,
    );
  });
});
