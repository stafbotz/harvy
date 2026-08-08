import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyTurnBoundaryLocally,
  guardTurnBoundary,
  idleWindowMs,
} from "../src/core/turn-taking-policy.js";

describe("kebijakan giliran percakapan", () => {
  it("memutus bentuk lengkap yang sempit tanpa classifier", () => {
    for (const message of ["iya", "oke", "makasih", "B", "opsi 2"]) {
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
      "aku mau menyakiti diri sekarang",
      "satu\ndua",
    ]) {
      assert.equal(classifyTurnBoundaryLocally(message), null, message);
    }
  });

  it("menahan pembuka dan emosi samar meski model terlalu cepat menutup", () => {
    assert.equal(guardTurnBoundary("eh tau ga", "complete"), "open");
    assert.equal(guardTurnBoundary("sumpah", "complete"), "open");
    assert.equal(
      guardTurnBoundary("aku boleh curhat kah", "complete"),
      "open",
    );
    assert.equal(
      guardTurnBoundary(
        "eh tau ga\nsumpah\naku cape banget\nada tigasss\naku takutttt banget",
        "complete",
      ),
      "open",
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
    assert.equal(
      guardTurnBoundary("aku takutttt banget", "complete"),
      "open",
    );
    assert.equal(
      guardTurnBoundary("aku mau menyakiti diri sekarang", "urgent"),
      "urgent",
    );
    assert.equal(idleWindowMs("urgent", 2), 0);
  });

  it("menjaga pesan lengkap cepat tetapi memberi ruang pada gaya multi-bubble", () => {
    assert.equal(idleWindowMs("complete", 1), 0);
    assert.equal(idleWindowMs("complete", 3), 4_000);
    assert.equal(idleWindowMs("open", 1), 7_000);
  });

  it("menghormati penutup eksplisit dan tidak menyalahartikan tidak jadi", () => {
    assert.equal(
      guardTurnBoundary("eh tau ga\nudah itu aja", "open"),
      "complete",
    );
    assert.equal(guardTurnBoundary("nggak jadi", "incomplete"), "complete");
    assert.equal(guardTurnBoundary("udah jadi", "complete"), "complete");
    assert.equal(
      guardTurnBoundary("websitenya udah jadi", "incomplete"),
      "complete",
    );
    assert.equal(guardTurnBoundary("jadi", "complete"), "incomplete");
  });
});
