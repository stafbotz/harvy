import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explicitMemoryRememberAuthority } from "../src/core/memory-explicit-consent.js";
import type { SemanticOperation } from "../src/domain/semantic-operation.js";

describe("authority explicit remember", () => {
  it("mengikat semantic evidence lintas bahasa ke candidate", () => {
    const cases = [
      [
        "harvy inget aku cintaaa banget sama sohit",
        "aku cintaaa banget sama sohit",
        "Sangat mencintai Sohit",
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
    const message = "inget ya Sohit pacarku, tadi aku habis dari rumah sakit";
    const authority = explicitMemoryRememberAuthority(
      message,
      [
        { content: "Sohit adalah pacarku" },
        { content: "Baru pulang dari rumah sakit" },
      ],
      remember(message, "Sohit pacarku"),
    );
    assert.equal(authority?.requestedText, "Sohit pacarku");
    assert.deepEqual(authority?.candidateIndexes, [0]);
  });

  it("menolak candidate yang memperluas fakta di luar span authority", () => {
    const message = "remember Sohit is my partner";
    const authority = explicitMemoryRememberAuthority(
      message,
      [{ content: "Sohit is my partner and is being treated in hospital" }],
      remember(message, "Sohit is my partner"),
    );
    assert.deepEqual(authority?.candidateIndexes, []);
  });

  it("menolak implicit statement, retrieval, negasi, dan reminder task", () => {
    const cases: Array<[string, SemanticOperation]> = [
      [
        "I should remember that Sohit is my partner",
        { ...remember("I should remember that Sohit is my partner", "Sohit is my partner"), explicitness: "implicit" },
      ],
      [
        "Do you remember Sohit?",
        { ...remember("Do you remember Sohit?", "Sohit"), operation: "recall" },
      ],
      [
        "Don't remember Sohit",
        { ...remember("Don't remember Sohit", "Sohit"), operation: "forget" },
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
          [{ content: "Sohit is my partner" }],
          semantic,
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
