import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldHoldAmbientTurn } from "../src/core/group-turn-policy.js";

describe("kebijakan bentuk giliran grup", () => {
  it("menahan acknowledgment, izin, dan penutup koordinasi pendek", () => {
    for (const text of [
      "nah itu yang menarik",
      "nah itu yg menarik",
      "boleh kirim aja",
      "silakan lanjut",
      "sip nanti digabung malam",
      "oke kabarin aja",
    ]) {
      assert.equal(shouldHoldAmbientTurn(text), true, text);
    }
  });

  it("tidak menahan pertanyaan atau panggilan yang membutuhkan pemahaman model", () => {
    for (const text of [
      "nah itu yang menarik, menurut kalian gimana?",
      "boleh kirim contoh yang benar?",
      "gimana cara lanjut dari sini",
      "apa ini sudah cukup jelas",
      "oke tapi data ini salah",
      "nah itu menarik, tapi kesimpulannya belum nyambung",
    ]) {
      assert.equal(shouldHoldAmbientTurn(text), false, text);
    }
  });
});
