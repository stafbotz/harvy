import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createVisualAcceptanceFixture,
  createVisualAcceptanceFixtureForColor,
  matchesVisualAcceptanceResponse,
  observedVisualAcceptanceColors,
  VISUAL_ACCEPTANCE_COLORS,
} from "../scripts/live-visual-acceptance-fixture.js";

describe("live visual acceptance fixture", () => {
  it("membuat PNG valid dan deterministik tanpa membocorkan jawaban di prompt", () => {
    const first = createVisualAcceptanceFixture("acceptance-visual-alpha");
    const second = createVisualAcceptanceFixture("acceptance-visual-alpha");

    assert.deepEqual(
      first.data.subarray(0, 8),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    assert.deepEqual(first, second);
    assert.equal(first.data.length < 5_000, true);
    assert.doesNotMatch(first.prompt, new RegExp(first.expectedColor, "iu"));
  });

  it("menerima satu klaim warna yang tepat dan menolak tebakan ambigu", () => {
    assert.equal(
      matchesVisualAcceptanceResponse(
        "Warna yang paling dominan adalah hijau.",
        "green",
      ),
      true,
    );
    assert.equal(
      matchesVisualAcceptanceResponse("Mungkin hijau atau biru.", "green"),
      false,
    );
    assert.equal(
      matchesVisualAcceptanceResponse("Warna dominannya merah.", "blue"),
      false,
    );
  });

  it("mengklasifikasi hanya warna fixture tanpa membawa isi balasan", () => {
    assert.deepEqual(
      observedVisualAcceptanceColors("Menurutku hijau, bukan red."),
      ["red", "green"],
    );
    assert.deepEqual(observedVisualAcceptanceColors("Kuning."), []);
  });

  it("menyediakan fixture eksplisit untuk seluruh matriks warna", () => {
    const fixtures = VISUAL_ACCEPTANCE_COLORS.map(
      createVisualAcceptanceFixtureForColor,
    );
    assert.deepEqual(
      fixtures.map((fixture) => fixture.expectedColor),
      ["red", "green", "blue"],
    );
    assert.equal(new Set(fixtures.map((fixture) => fixture.data.toString("hex"))).size, 3);
  });
});
