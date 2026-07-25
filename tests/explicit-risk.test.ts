import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasExplicitSeriousRisk } from "../src/safety/explicit-risk.js";

describe("hasExplicitSeriousRisk", () => {
  it("mendeteksi ungkapan bahaya serius yang eksplisit", () => {
    for (const message of [
      "Aku mau bunuh diri",
      "Saya ingin menyakiti diri",
      "Aku lagi dipukul di rumah",
      "Dia mau membunuh aku",
      "Aku sedang nggak aman",
      "Aku tidak aman",
    ]) {
      assert.equal(hasExplicitSeriousRisk(message), true, message);
    }
  });

  it("tidak menyamakan pembahasan umum dengan risiko pribadi", () => {
    for (const message of [
      "Aku belajar tentang pencegahan bunuh diri",
      "Bagaimana membantu teman yang sedih?",
      "Film itu membahas kekerasan",
      "Aku lagi bingung memilih tugas",
    ]) {
      assert.equal(hasExplicitSeriousRisk(message), false, message);
    }
  });
});
