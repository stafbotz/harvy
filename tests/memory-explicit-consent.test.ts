import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  explicitMemoryRememberAuthority,
  replyClaimsMemoryDeletion,
  replyClaimsDefinitiveMemoryRecordWrite,
  withoutUnconfirmedMemoryRecordClaims,
  withoutUnconfirmedMemoryDeletionClaims,
} from "../src/core/memory-explicit-consent.js";
import type { SemanticOperation } from "../src/domain/semantic-operation.js";

describe("authority explicit remember", () => {
  it("mengikat semantic evidence lintas bahasa ke candidate", () => {
    const cases = [
      [
        "harvy inget aku cintaaa banget sama rani",
        "aku cintaaa banget sama rani",
        "Sangat mencintai Rani",
      ],
      [
        "Remember that my preferred study time is morning",
        "my preferred study time is morning",
        "Preferred study time is morning",
      ],
      [
        "punten emutkeun abdi resep diajar isuk-isuk",
        "abdi resep diajar isuk-isuk",
        "Abdi resep diajar isuk-isuk",
      ],
      [
        "elinga aku seneng sinau esuk",
        "aku seneng sinau esuk",
        "Aku seneng sinau esuk",
      ],
      [
        "please remember aku sekarang kelas 12",
        "aku sekarang kelas 12",
        "Sekarang kelas 12",
      ],
    ] as const;

    for (const [message, target, content] of cases) {
      const authority = explicitMemoryRememberAuthority(
        message,
        [{ content }],
        remember(message, target),
      );
      assert.deepEqual(authority?.candidateIndexes, [0], message);
      assert.equal(authority?.forbiddenSecret, false, message);
    }
  });

  it("mengikat consent hanya ke span yang diminta diingat", () => {
    const message = "inget ya Rani pacarku, tadi aku habis dari rumah sakit";
    const authority = explicitMemoryRememberAuthority(
      message,
      [
        { content: "Rani adalah pacarku" },
        { content: "Baru pulang dari rumah sakit" },
      ],
      remember(message, "Rani pacarku"),
    );
    assert.equal(authority?.requestedText, "Rani pacarku");
    assert.deepEqual(authority?.candidateIndexes, [0]);
  });

  it("memakai evidence exact ketika target model berupa label parafrasa", () => {
    const message =
      "Mulai sekarang, kalau kita membahas pekerjaan produk, jawab dengan langkah pendek bernomor dan akhiri dengan satu keputusan tegas.";
    const authority = explicitMemoryRememberAuthority(
      message,
      [{
        content:
          "Lebih suka jawaban pekerjaan produk dengan langkah pendek bernomor dan diakhiri satu keputusan tegas.",
      }],
      remember(message, "format jawaban pekerjaan produk"),
    );

    assert.equal(authority?.requestedText, message);
    assert.deepEqual(authority?.candidateIndexes, []);
    assert.equal(authority?.forbiddenSecret, false);
  });

  it("menolak candidate yang memperluas fakta di luar span authority", () => {
    const message = "remember Rani is my partner";
    const authority = explicitMemoryRememberAuthority(
      message,
      [{ content: "Rani is my partner and is being treated in hospital" }],
      remember(message, "Rani is my partner"),
    );
    assert.deepEqual(authority?.candidateIndexes, []);
  });

  it("menolak implicit statement, retrieval, negasi, dan reminder task", () => {
    const cases: Array<[string, SemanticOperation]> = [
      [
        "I should remember that Rani is my partner",
        { ...remember("I should remember that Rani is my partner", "Rani is my partner"), explicitness: "implicit" },
      ],
      [
        "Do you remember Rani?",
        { ...remember("Do you remember Rani?", "Rani"), operation: "recall" },
      ],
      [
        "Don't remember Rani",
        { ...remember("Don't remember Rani", "Rani"), operation: "forget" },
      ],
      [
        "Remind me to study at seven",
        { ...remember("Remind me to study at seven", "study at seven"), domain: "task", operation: "save" },
      ],
    ];
    for (const [message, semantic] of cases) {
      assert.equal(
        explicitMemoryRememberAuthority(
          message,
          [{ content: "Rani is my partner" }],
          semantic,
        ),
        null,
        message,
      );
    }
  });

  it("menolak constraint current task walau model salah menandainya explicit remember", () => {
    const message =
      "Jangan buat pekerjaan latar dan jangan pakai tool; bantu aku lewat percakapan ini saja.";
    assert.equal(
      explicitMemoryRememberAuthority(
        message,
        [{ content: "Lebih suka selalu dibantu tanpa tool" }],
        remember(message, "cara kerja yang diminta"),
      ),
      null,
    );
  });

  it("menolak exact evidence negatif walau model mengusulkan remember", () => {
    for (const message of [
      "Jangan ingat ini untuk ke depan; lanjut bantu urutkan prioritas.",
      "Do not remember this; continue answering my main request.",
    ]) {
      assert.equal(
        explicitMemoryRememberAuthority(
          message,
          [{ content: "Preferensi permanen yang tidak diminta" }],
          remember(message, message),
        ),
        null,
        message,
      );
    }
  });

  it("mengenali credential tetapi tidak memberi candidate authority", () => {
    for (const message of [
      "remember password emailku adalah CONTOH_SANDI_123",
      "remember OTP-ku 123456",
      "remember PIN kartu aku 4321",
      "remember API key-ku adalah CONTOH_KUNCI_123456",
    ]) {
      const target = message.replace(/^remember\s+/u, "");
      const authority = explicitMemoryRememberAuthority(
        message,
        [{ content: target }],
        remember(message, target),
      );
      assert.equal(authority?.forbiddenSecret, true, message);
      assert.deepEqual(authority?.candidateIndexes, [], message);
    }
  });
});

describe("klaim penghapusan memori", () => {
  it("mengenali klaim deletion tanpa receipt dalam bahasa Indonesia dan Inggris", () => {
    for (const text of [
      "Catatannya udah aku hapus.",
      "Memori yang tadi telah dilupakan.",
      "I have deleted that note.",
      "The memory has been removed.",
    ]) {
      assert.equal(replyClaimsMemoryDeletion(text), true, text);
    }
  });

  it("membuang hanya klaim deletion dan mempertahankan jawaban utama", () => {
    const reply = [
      "Catatannya udah aku hapus.",
      "",
      "Keputusan utamanya: tool hanya berjalan bila permintaan memang membutuhkan eksekusi.",
    ].join("\n");

    assert.equal(
      withoutUnconfirmedMemoryDeletionClaims(reply),
      "Keputusan utamanya: tool hanya berjalan bila permintaan memang membutuhkan eksekusi.",
    );
  });

  it("tidak menghapus penjelasan yang jujur bahwa tidak ada receipt deletion", () => {
    const reply = "Aku belum menghapus catatan apa pun.";
    assert.equal(replyClaimsMemoryDeletion(reply), false);
    assert.equal(withoutUnconfirmedMemoryDeletionClaims(reply), reply);
  });
});

describe("klaim pencatatan memori tanpa receipt", () => {
  it("membuang klaim definitive tetapi menjaga keputusan produk", () => {
    const reply = [
      "Permintaanmu sudah aku catat.",
      "Keputusan utamanya: kita akan memperbaiki pemilihan tool lebih dulu.",
    ].join("\n\n");

    assert.equal(replyClaimsDefinitiveMemoryRecordWrite(reply.split("\n")[0]!), true);
    assert.equal(
      withoutUnconfirmedMemoryRecordClaims(reply),
      "Keputusan utamanya: kita akan memperbaiki pemilihan tool lebih dulu.",
    );
    assert.equal(
      replyClaimsDefinitiveMemoryRecordWrite(
        "Keputusan utamanya: kita akan memperbaiki pemilihan tool lebih dulu.",
      ),
      false,
    );
  });
});

function remember(message: string, target: string): SemanticOperation {
  return {
    version: 1,
    domain: "memory",
    operation: "remember",
    target,
    subject: "self",
    reference: "none",
    explicitness: "explicit",
    evidence: message,
    confidence: 0.95,
  };
}
