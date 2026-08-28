import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CHARACTERS_PER_TOKEN,
  estimateTokens,
  TokenRatioCalibration,
} from "../src/ai/token-estimate.js";

describe("perkiraan token", () => {
  it("memakai default konservatif dan tidak pernah negatif", () => {
    assert.equal(DEFAULT_CHARACTERS_PER_TOKEN, 4);
    assert.equal(estimateTokens(400), 100);
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(-10), 0);
    // Pembulatan ke atas: sisa karakter tetap memakan satu token.
    assert.equal(estimateTokens(401), 101);
  });

  it("mengabaikan rasio yang tidak masuk akal dan kembali ke default", () => {
    assert.equal(estimateTokens(400, 0), 100);
    assert.equal(estimateTokens(400, -3), 100);
    assert.equal(estimateTokens(400, Number.NaN), 100);
    // Di luar batas kewarasan 1,5–12.
    assert.equal(estimateTokens(400, 900), 100);
  });
});

describe("kalibrasi rasio per model", () => {
  it("memakai default sampai bukti cukup, lalu memakai rasio teramati", () => {
    const calibration = new TokenRatioCalibration();
    assert.equal(calibration.charactersPerToken("m"), 4);

    // Empat observasi belum cukup; ambangnya lima.
    for (let index = 0; index < 4; index += 1) {
      calibration.observe("m", 4_180, 1_000);
    }
    assert.equal(calibration.charactersPerToken("m"), 4);

    calibration.observe("m", 4_180, 1_000);
    assert.ok(calibration.charactersPerToken("m") > 4);
    assert.ok(calibration.charactersPerToken("m") <= 4.18);
  });

  it("memisahkan rasio antar model", () => {
    const calibration = new TokenRatioCalibration();
    for (let index = 0; index < 8; index += 1) {
      calibration.observe("padat", 2_000, 1_000);
      calibration.observe("longgar", 6_000, 1_000);
    }
    const padat = calibration.charactersPerToken("padat");
    const longgar = calibration.charactersPerToken("longgar");
    assert.ok(padat < 4, `padat ${padat}`);
    assert.ok(longgar > 4, `longgar ${longgar}`);
  });

  it("membuang observasi rusak tanpa merusak rasio yang sudah baik", () => {
    const calibration = new TokenRatioCalibration();
    for (let index = 0; index < 8; index += 1) {
      calibration.observe("m", 4_000, 1_000);
    }
    const before = calibration.charactersPerToken("m");

    // Nol token, karakter nol, model kosong, dan rasio ekstrem semuanya ditolak.
    calibration.observe("m", 4_000, 0);
    calibration.observe("m", 0, 1_000);
    calibration.observe("", 4_000, 1_000);
    calibration.observe("m", 4_000_000, 1);

    assert.equal(calibration.charactersPerToken("m"), before);
  });

  it("menerbitkan snapshot bebas isi untuk observability", () => {
    const calibration = new TokenRatioCalibration();
    calibration.observe("m", 4_000, 1_000);
    const snapshot = calibration.snapshot();
    assert.deepEqual(snapshot, [{ modelId: "m", ratio: 4, observations: 1 }]);
  });
});
