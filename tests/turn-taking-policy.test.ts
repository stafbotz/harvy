import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  guardTurnBoundary,
  idleWindowMs,
} from "../src/core/turn-taking-policy.js";

describe("kebijakan giliran percakapan", () => {
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

  it("membedakan ketakutan samar dari bahaya segera", () => {
    assert.equal(
      guardTurnBoundary("aku takutttt banget", "complete"),
      "open",
    );
    assert.equal(
      guardTurnBoundary("aku mau menyakiti diri sekarang", "open"),
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
