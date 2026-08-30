import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NATURAL_SURFACE_OPERATIONS,
  codingRunStatusOperation,
  naturalSurfaceAuthorized,
  type SemanticOperation,
  type SemanticOperationName,
} from "../src/domain/semantic-operation.js";
import { requestsUnhandledTaskChange } from "../src/core/action-policy.js";

function proposal(
  draft: Partial<SemanticOperation> & {
    domain: SemanticOperation["domain"];
    operation: SemanticOperationName;
  },
): SemanticOperation {
  return {
    version: 1,
    target: null,
    subject: "self",
    reference: "current",
    explicitness: "explicit",
    evidence: null,
    confidence: 0.9,
    ...draft,
  };
}

describe("otorisasi permukaan bahasa alami", () => {
  // Sampai 29 Agustus 2026 kelompok coding adalah satu-satunya yang benar-benar
  // memaksa slash: tidak ada domain semantik untuknya sama sekali, sehingga
  // "gimana progres coding-nya" tidak punya jalan selain /code_status.
  it("membuka status dan pembatalan pekerjaan coding lewat bahasa alami", () => {
    assert.equal(
      naturalSurfaceAuthorized("gimana status coding-nya sekarang", proposal({
        domain: "coding",
        operation: "show",
        evidence: "status coding",
      })),
      true,
    );
    assert.equal(
      naturalSurfaceAuthorized("batalin coding yang lagi jalan dong", proposal({
        domain: "coding",
        operation: "cancel",
        evidence: "batalin coding",
      })),
      true,
    );
  });

  // Memulai CodingRun memerlukan teks task tersendiri dan tidak dapat dibedakan
  // dari permintaan bantuan biasa lewat label. GitHub dan publish memegang
  // credential serta mengirim keluar. Ketiganya sengaja tetap butuh invokasi
  // tegas, dan gerbang ini harus menolaknya walau modelnya mengusulkan.
  it("menolak operasi coding yang tidak ada di daftar", () => {
    for (const operation of ["create", "set", "apply"] as const) {
      assert.equal(
        naturalSurfaceAuthorized("mulai coding perbaiki token expired", proposal({
          domain: "coding",
          operation,
          evidence: "mulai coding",
        })),
        false,
        operation,
      );
    }
  });

  it("menolak domain yang tidak punya permukaan bahasa alami", () => {
    assert.equal(
      naturalSurfaceAuthorized("tunjukkan pemakaian kuotaku", proposal({
        domain: "usage",
        operation: "show-summary",
        evidence: "pemakaian kuota",
      })),
      false,
    );
    assert.equal(naturalSurfaceAuthorized("apa saja", null), false);
  });

  // Ambang ini adalah pertahanan kedua setelah parser: usulan model tidak
  // pernah cukup sendirian untuk menyentuh state.
  it("mempertahankan ambang otorisasi yang sama untuk seluruh domain", () => {
    const weak = [
      proposal({ domain: "coding", operation: "cancel", evidence: "batalin coding", confidence: 0.84 }),
      proposal({ domain: "coding", operation: "cancel", evidence: "batalin coding", explicitness: "contextual" }),
      proposal({ domain: "coding", operation: "cancel", evidence: "batalin coding", subject: "other" }),
      proposal({ domain: "coding", operation: "cancel", evidence: "kirim laporan" }),
      proposal({ domain: "coding", operation: "cancel", evidence: "batalin coding", reference: "all" }),
    ];
    for (const [index, semantic] of weak.entries()) {
      assert.equal(
        naturalSurfaceAuthorized("batalin coding yang lagi jalan dong", semantic),
        false,
        `usulan lemah #${index + 1}`,
      );
    }
  });

  // `/batalkan-tugas <id>` adalah satu-satunya perintah tersisa yang menuntut
  // pengguna menyalin ID dari daftar. `task/cancel` membuka padanan bahasa
  // alaminya, tetapi tanpa memberi authority menghapus: route deterministik
  // tidak menanganinya, jadi ia hanya boleh sampai ke Agent Runtime tempat
  // `task.manage` menuntut konfirmasi kontekstual.
  it("mengenali pembatalan task sebagai perubahan yang belum tertangani", () => {
    assert.equal(
      requestsUnhandledTaskChange(proposal({
        domain: "task",
        operation: "cancel",
        evidence: "batalin tugas fisika",
      })),
      true,
    );
  });

  it("tidak menaikkan usulan pembatalan yang lemah", () => {
    for (const weak of [
      proposal({ domain: "task", operation: "cancel", confidence: 0.5 }),
      proposal({ domain: "task", operation: "cancel", explicitness: "implicit" }),
      proposal({ domain: "task", operation: "cancel", subject: "other" }),
    ]) {
      assert.equal(requestsUnhandledTaskChange(weak), false);
    }
  });

  // Ambang bertingkat menurut akibat, bukan seragam. Pengukuran 29 Agustus:
  // "gimana status coding-nya sekarang?" mengembalikan `coding/show` di 3 dari
  // 3 run, tetapi confidence-nya 0,60 / 0,90 / 0,82 terhadap ambang seragam
  // 0,85 — pengguna mendapat jawaban berbeda untuk kalimat yang sama.
  it("menerima pembacaan pada confidence sedang", () => {
    assert.equal(
      naturalSurfaceAuthorized("gimana status coding-nya sekarang?", proposal({
        domain: "coding",
        operation: "show",
        evidence: "status coding",
        confidence: 0.82,
      })),
      true,
    );
  });

  // Yang mengubah data tetap di 0,85. Salah membaca kehilangan satu pembacaan;
  // salah menulis mengubah data pengguna.
  it("tidak menurunkan ambang untuk operasi yang mengubah state", () => {
    for (const operation of ["cancel", "create", "set"] as const) {
      assert.equal(
        naturalSurfaceAuthorized("batalin coding dan bikin project baru", proposal({
          domain: operation === "cancel" ? "coding" : "project",
          operation: operation === "set" ? "create" : operation,
          evidence: "batalin coding",
          confidence: 0.82,
        })),
        false,
        operation,
      );
    }
  });

  it("tetap menolak pembacaan di bawah ambang sedang", () => {
    assert.equal(
      naturalSurfaceAuthorized("gimana status coding-nya sekarang?", proposal({
        domain: "coding",
        operation: "show",
        evidence: "status coding",
        confidence: 0.6,
      })),
      false,
    );
  });

  it("menjaga daftar operasi permukaan tetap eksplisit", () => {
    assert.deepEqual(Object.keys(NATURAL_SURFACE_OPERATIONS).sort(), [
      "coding",
      "goal",
      "project",
      "skill",
    ]);
  });
});

// Sesi Telegram 30 Agustus 2026: kalimat yang sama menghasilkan `coding/show`
// pada dua sesi dan `none` pada sesi ketiga. Pada sesi ketiga permukaan
// deterministik tidak menyala dan jawabannya menyebut ada pekerjaan berjalan
// berikut progresnya—disusun dari daftar tugas belajar.
describe("pengenalan status CodingRun oleh kode", () => {
  it("mengenali bentuk status dan sedang-berjalan", () => {
    for (
      const message of [
        "gimana status pekerjaan coding yang lagi jalan?",
        "gimana status coding-nya sekarang?",
        "status coding gimana?",
        "coding yang lagi jalan gimana?",
        "cek status ngoding dong",
      ]
    ) {
      const operation = codingRunStatusOperation(message);
      assert.equal(operation?.domain, "coding", message);
      assert.equal(operation?.operation, "show", message);
    }
  });

  // Penjaga terpenting di sini. Pertanyaan belajar tidak boleh dijawab dengan
  // status CodingRun, dan kata "coding" saja tidak cukup menjadi bukti.
  it("membiarkan pertanyaan belajar dan kalimat lain tanpa status coding", () => {
    for (
      const message of [
        "gimana cara belajar coding?",
        "aku mau mulai belajar coding dari mana ya",
        "coding itu susah nggak sih",
        "gimana status tugasku?",
        "besok aku ada kelas coding",
        "kamu bisa coding nggak?",
      ]
    ) {
      assert.equal(codingRunStatusOperation(message), null, message);
    }
  });

  // Hanya pembacaan yang boleh diambil alih kode. Pembatalan tetap menuntut
  // usulan extractor yang lolos ambang 0,85, karena ia menghentikan pekerjaan.
  it("tidak pernah menghasilkan operasi selain show", () => {
    assert.equal(
      codingRunStatusOperation("batalin coding yang lagi jalan dong")?.operation,
      "show",
    );
  });
});
