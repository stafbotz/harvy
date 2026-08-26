import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  explicitReplyConstraintViolations,
  removeUnexpectedReplyScripts,
  unexpectedReplyScripts,
} from "../src/ai/reply-language-policy.js";

describe("reply language policy", () => {
  it("menangkap aksara asing yang terselip di prosa Indonesia", () => {
    assert.deepEqual(
      unexpectedReplyScripts(
        "Bagaimana ritme kerja yang sehat?",
        "Jangan pindah topik terlalu cepat karena itu yang bikin累.",
      ),
      ["han"],
    );
  });

  it("membolehkan aksara yang dipakai atau diminta pengguna", () => {
    assert.deepEqual(
      unexpectedReplyScripts(
        "Apa arti 累?",
        "累 bisa berarti lelah.",
      ),
      [],
    );
    assert.deepEqual(
      unexpectedReplyScripts(
        "Tuliskan terima kasih dalam bahasa Mandarin.",
        "谢谢 berarti terima kasih.",
      ),
      [],
    );
  });

  it("tidak mengubah literal di fenced atau inline code", () => {
    const reply = "Gunakan nilai berikut:\n```ts\nconst label = '累';\n```\natau `累`.";
    assert.deepEqual(
      unexpectedReplyScripts("Periksa potongan kode ini.", reply),
      [],
    );
  });

  it("fallback membuang hanya script yang tidak berwenang", () => {
    assert.equal(
      removeUnexpectedReplyScripts(
        "Jangan pindah terlalu cepat karena itu bikin 累.",
        ["han"],
      ),
      "Jangan pindah terlalu cepat karena itu bikin.",
    );
  });

  it("memeriksa hanya constraint keluaran explicit yang mekanis", () => {
    const request = [
      "Jawab tepat 3 baris.",
      "Jangan tanya balik dan jangan pakai jam absolut.",
    ].join(" ");
    assert.deepEqual(
      explicitReplyConstraintViolations(
        request,
        "1. Bagian awal\n2. Bagian tengah\n3. Bagian akhir\nTotal: tiga bagian pada 08.30?",
      ),
      ["exact-lines", "no-question", "no-absolute-time"],
    );
    assert.deepEqual(
      explicitReplyConstraintViolations(
        "Hitung 17+28 dan jawab angkanya saja.",
        "Hasilnya 45.",
      ),
      ["numbers-only"],
    );
    assert.deepEqual(
      explicitReplyConstraintViolations(
        "Hitung 17+28 dan jawab angkanya saja.",
        "45",
      ),
      [],
    );
  });

  it("menolak prosa di luar satu blok ketika pengguna meminta code-only", () => {
    const request =
      "Write only TypeScript types and a pure decision function; no plan.";
    assert.deepEqual(
      explicitReplyConstraintViolations(
        request,
        "Berikut kodenya:\n```ts\ntype State = 'dry' | 'wet';\n```",
      ),
      ["code-only"],
    );
    assert.deepEqual(
      explicitReplyConstraintViolations(
        request,
        "```ts\ntype State = 'dry' | 'wet';\n```",
      ),
      [],
    );
  });

  it("menghitung exact-lines dari isi code fence dan menangkap ternary rumpang", () => {
    const request =
      "Write only code, exactly three lines.";
    assert.deepEqual(
      explicitReplyConstraintViolations(
        request,
        [
          "```ts",
          "const threshold = 30;",
          "const action = moisture <= threshold ? 'water';",
          "return action;",
          "```",
        ].join("\n"),
      ),
      ["malformed-conditional"],
    );
    assert.deepEqual(
      explicitReplyConstraintViolations(
        request,
        [
          "```ts",
          "const threshold = 30;",
          "const action = moisture <= threshold ? 'water' : 'wait';",
          "return action;",
          "```",
        ].join("\n"),
      ),
      [],
    );
  });

  it("memahami modifier non-empty pada batas jumlah baris", () => {
    const request = "Write only TypeScript code, exactly 8 non-empty lines.";
    const sevenLines = [
      "```ts",
      "type Reading = number;",
      "type Action = 'water' | 'wait';",
      "const threshold = 30;",
      "const decide = (value: Reading): Action =>",
      "  value <= threshold ? 'water' : 'wait';",
      "export { decide };",
      "export type { Reading, Action };",
      "```",
    ].join("\n");
    assert.deepEqual(
      explicitReplyConstraintViolations(request, sevenLines),
      ["exact-lines"],
    );
  });

  it("tidak salah menolak optional chaining, nullish, atau optional property", () => {
    const request = "Write only TypeScript code.";
    assert.deepEqual(
      explicitReplyConstraintViolations(
        request,
        [
          "```ts",
          "type Options = { threshold?: number };",
          "const threshold = options?.threshold ?? 30;",
          "return threshold <= 30 ? 'water' : 'wait';",
          "```",
        ].join("\n"),
      ),
      [],
    );
  });
});
