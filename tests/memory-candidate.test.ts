import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveMemoryMetadata } from "../src/core/memory-candidate.js";

describe("deriveMemoryMetadata", () => {
  it("mengikat koreksi sekolah ke slot dan graph relation yang sama", () => {
    assert.deepEqual(
      deriveMemoryMetadata(
        "profile",
        "Sekolah di SMAN Baru",
        "Ralat, aku sudah pindah sekolah ke SMAN Baru",
      ),
      {
        subject: "user",
        predicate: "studies_at",
        value: "SMAN Baru",
        correction: true,
        provenance: "asserted",
        graphProjection: {
          from: { type: "person", canonicalName: "Pengguna" },
          relation: "studies_at",
          to: { type: "place", canonicalName: "SMAN Baru" },
        },
      },
    );
  });

  it("membentuk edge course-ke-teacher tanpa mempercayai graph buatan model", () => {
    const metadata = deriveMemoryMetadata(
      "profile",
      "Matematika diajar oleh Pak Ardi",
      "Matematika diajar oleh Pak Ardi",
    );
    assert.equal(metadata.predicate, "taught_by");
    assert.deepEqual(metadata.graphProjection, {
      from: { type: "course", canonicalName: "Matematika" },
      relation: "taught_by",
      to: { type: "person", canonicalName: "Pak Ardi" },
    });
  });

  it("tidak menjadikan correction signal global untuk preference non-eksklusif", () => {
    const metadata = deriveMemoryMetadata(
      "preference",
      "Suka penjelasan bertahap",
      "sebenarnya aku juga suka penjelasan bertahap",
    );
    assert.equal(metadata.predicate, "preference_fact");
    assert.equal(metadata.correction, false);
  });

  it("membawa sinyal koreksi pada slot gaya belajar yang eksklusif", () => {
    const metadata = deriveMemoryMetadata(
      "preference",
      "Lebih suka belajar audio",
      "Sebenarnya bukan visual, aku lebih suka belajar audio",
    );
    assert.equal(metadata.predicate, "prefers_learning_style");
    assert.equal(metadata.value, "audio");
    assert.equal(metadata.correction, true);
  });

  it("membedakan perubahan pilihan kuliah dari deletion", () => {
    const previous = deriveMemoryMetadata(
      "context",
      "Sedang mempertimbangkan ITB",
      "aku sedang mempertimbangkan ITB",
    );
    const corrected = deriveMemoryMetadata(
      "context",
      "Tidak lagi mempertimbangkan ITB",
      "aku udah nggak mempertimbangkan ITB lagi",
    );

    assert.equal(previous.predicate, "college_preference");
    assert.equal(previous.value, "ITB");
    assert.equal(previous.correction, false);
    assert.equal(corrected.predicate, "college_preference");
    assert.equal(corrected.value, "tidak:ITB");
    assert.equal(corrected.correction, true);
  });

  it("merepresentasikan hubungan yang berakhir sebagai correction temporal", () => {
    const previous = deriveMemoryMetadata(
      "personal",
      "Sohit adalah pacarku",
      "Sohit adalah pacarku",
    );
    const corrected = deriveMemoryMetadata(
      "personal",
      "Sohit bukan pacarku lagi",
      "Sohit bukan pacarku lagi",
    );

    assert.equal(previous.predicate, "romantic_partner");
    assert.equal(previous.value, "Sohit");
    assert.equal(corrected.predicate, "romantic_partner");
    assert.equal(corrected.value, "tidak:Sohit");
    assert.equal(corrected.correction, true);
    assert.equal(corrected.graphProjection?.relation, "no_longer_partner_of");
  });
});
