import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nothingLeftNote,
  notUnderstoodNote,
  taskCompletedHeading,
  taskSavedHeading,
} from "../src/bot/phrasing.js";

describe("variasi kalimat Harvy", () => {
  it("tidak memakai kalimat yang sama persis setiap kali", () => {
    // Teman tidak punya satu kalimat untuk selamanya. Konfirmasi yang identik
    // pada giliran keseratus adalah yang membuat Harvy terdengar seperti mesin
    // absensi, bukan panjang balasannya.
    assert.notEqual(taskSavedHeading(() => 0), taskSavedHeading(() => 0.99));
    assert.notEqual(nothingLeftNote(() => 0), nothingLeftNote(() => 0.99));
    assert.notEqual(notUnderstoodNote(() => 0), notUnderstoodNote(() => 0.99));
  });

  it("tetap dapat diramalkan ketika pemilihnya ditentukan", () => {
    assert.equal(taskSavedHeading(() => 0), taskSavedHeading(() => 0));
  });

  it("tidak pernah menghasilkan kalimat kosong, apa pun nilai pemilihnya", () => {
    for (const value of [0, 0.5, 0.999, 1, 1.5, -1, Number.NaN]) {
      assert.ok(taskSavedHeading(() => value).length > 0);
    }
  });

  it("menyebut judul tugas yang baru selesai", () => {
    const heading = taskCompletedHeading("Kumpulin matematika", () => 0);

    assert.match(heading, /Kumpulin matematika$/);
    assert.match(heading, /✓/);
  });
});
