import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NATURAL_SURFACE_OPERATIONS,
  naturalSurfaceAuthorized,
  type SemanticOperation,
  type SemanticOperationName,
} from "../src/domain/semantic-operation.js";

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

  it("menjaga daftar operasi permukaan tetap eksplisit", () => {
    assert.deepEqual(Object.keys(NATURAL_SURFACE_OPERATIONS).sort(), [
      "coding",
      "goal",
      "project",
      "skill",
    ]);
  });
});
