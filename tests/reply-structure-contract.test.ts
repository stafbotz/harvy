import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessReplyStructure,
  deriveReplyStructureContract,
} from "../src/core/reply-structure-contract.js";

describe("reply structure contract", () => {
  it("menurunkan jumlah exact, field per langkah, dan kedalaman secara sempit", () => {
    const contract = deriveReplyStructureContract([
      "Susun rencana mendalam tepat tiga langkah.",
      "Pada setiap langkah, tulis jelas: Tindakan, Bukti yang dikumpulkan, dan Kriteria lulus.",
      "Berikan detail agar orang lain dapat menjalankannya tanpa menebak.",
    ].join(" "));

    assert.deepEqual(contract, {
      kind: "numbered_steps",
      exactSteps: 3,
      perStepFields: [
        "Tindakan",
        "Bukti yang dikumpulkan",
        "Kriteria lulus",
      ],
      detail: "detailed",
      minimumFieldCharacters: 32,
    });
    assert.equal(
      deriveReplyStructureContract("Berikan tiga langkah atau lebih bila perlu."),
      null,
    );
    assert.equal(
      deriveReplyStructureContract("Jelaskan tepat dua puluh langkah."),
      null,
    );
  });

  it("menolak langkah atau field yang hilang dan menerima struktur lengkap", () => {
    const contract = deriveReplyStructureContract(
      "Buat tepat dua langkah mendalam. Pada setiap langkah, tulis: Tindakan dan Kriteria lulus.",
    );
    assert.ok(contract);
    const incomplete = assessReplyStructure([
      "1. Periksa alur",
      "   Tindakan: Jalankan seluruh alur dari awal sampai selesai pada akun uji nyata.",
      "2. Pulihkan runtime",
      "   Tindakan: Hentikan lalu nyalakan runtime saat pekerjaan masih aktif berjalan.",
      "   Kriteria lulus: Pekerjaan pulih tanpa membuat hasil ganda atau kehilangan status terakhir.",
    ].join("\n"), contract);
    assert.equal(incomplete.passed, false);
    assert.deepEqual(incomplete.missingFields, ["1:Kriteria lulus"]);

    const complete = assessReplyStructure([
      "1. Periksa alur",
      "   Tindakan: Jalankan seluruh alur dari awal sampai selesai pada akun uji nyata.",
      "   Kriteria lulus: Seluruh tahap muncul satu kali dalam urutan yang sudah ditentukan.",
      "",
      "2. Pulihkan runtime",
      "   Tindakan: Hentikan lalu nyalakan runtime saat pekerjaan masih aktif berjalan.",
      "   Kriteria lulus: Pekerjaan pulih tanpa membuat hasil ganda atau kehilangan status terakhir.",
    ].join("\n"), contract);
    assert.deepEqual(complete, {
      passed: true,
      numberedSteps: 2,
      missingFields: [],
      shortFields: [],
    });
  });
});
