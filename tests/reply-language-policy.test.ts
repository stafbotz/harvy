import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  explicitReplyConstraintViolations,
  harvyPronounRegister,
  questionOnlyReply,
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

/**
 * Sapaan Harvy dimiliki kode. Journey keempat menangkap Harvy berjanji kembali
 * ke aku-kamu lalu melanggarnya di bubble berikutnya pada giliran yang sama.
 */
describe("sapaan Harvy tetap aku-kamu", () => {
  it("mengganti lo dan gue pada kalimat yang benar-benar terkirim", () => {
    assert.equal(
      harvyPronounRegister(
        "frasa kunci yang masuk akal buat lo coba, dan kalau lo nemu yang cocok, gue bisa bantu cek lagi",
      ),
      "frasa kunci yang masuk akal buat kamu coba, dan kalau kamu nemu yang cocok, aku bisa bantu cek lagi",
    );
  });

  it("mempertahankan huruf besar di awal kalimat", () => {
    assert.equal(
      harvyPronounRegister("Gue ga bisa nyari jurnal di web. Lo cari sendiri ya."),
      "Aku ga bisa nyari jurnal di web. Kamu cari sendiri ya.",
    );
  });

  it("tidak menyentuh balasan yang memang sudah aku-kamu", () => {
    const utuh = "aku belum bisa cek webnya, tapi kamu bisa coba Google Scholar.";
    assert.equal(harvyPronounRegister(utuh), utuh);
  });

  it("tidak mengubah kutipan ucapan pengguna", () => {
    assert.equal(
      harvyPronounRegister(
        'tadi kamu bilang "gue capek banget", jadi gue mau tanya dulu',
      ),
      'tadi kamu bilang "gue capek banget", jadi aku mau tanya dulu',
    );
  });

  it("membiarkan gua yang berarti rongga bukit", () => {
    const geografi =
      "gua karst terbentuk dari pelarutan batu kapur selama ribuan tahun.";
    assert.equal(harvyPronounRegister(geografi), geografi);
  });

  it("mengganti gua hanya ketika balasannya memang slang", () => {
    assert.equal(
      harvyPronounRegister("gua udah cek, lo tinggal baca aja"),
      "aku udah cek, kamu tinggal baca aja",
    );
  });

  it("tidak memotong kata bertanda hubung seperti lo-fi", () => {
    const musik = "coba dengerin lo-fi pas ngerjain, biasanya bikin fokus.";
    assert.equal(harvyPronounRegister(musik), musik);
  });

  it("tetap mengganti kata ganti di kalimat yang juga menyebut lo-fi", () => {
    assert.equal(
      harvyPronounRegister("kalau lo suka lo-fi, coba pasang sambil nulis"),
      "kalau kamu suka lo-fi, coba pasang sambil nulis",
    );
  });

  it("tidak menyentuh isi pagar kode", () => {
    const kode = "coba jalankan ini:\n```\nlet lo = 3;\n```\nnanti gue cek lagi";
    assert.equal(
      harvyPronounRegister(kode),
      "coba jalankan ini:\n```\nlet lo = 3;\n```\nnanti aku cek lagi",
    );
  });
});

/**
 * Pengguna yang memilih "Langsung saran" dijawab pertanyaan telanjang dua dari
 * empat giliran meski arahan promptnya sudah menyebut syaratnya.
 */
describe("balasan yang seluruhnya bertanya", () => {
  it("mengenali balasan yang tidak memberi apa pun", () => {
    assert.equal(
      questionOnlyReply(
        "sebelum bikin rencana, perlu tahu: bagian analisis data itu udah final atau masih mau direvisi?",
      ),
      true,
    );
  });

  it("mengenali dua pertanyaan berturut-turut", () => {
    assert.equal(
      questionOnlyReply("masih ada waktu dua hari? atau udah mepet banget?"),
      true,
    );
  });

  it("melepas balasan yang menyertakan satu langkah", () => {
    assert.equal(
      questionOnlyReply(
        "mulai dari keterbatasan dulu, itu yang paling cepat. bagian analisisnya udah final?",
      ),
      false,
    );
  });

  it("melepas balasan berbutir meski tiap barisnya berbentuk tanya", () => {
    assert.equal(
      questionOnlyReply("cek dua hal ini:\n- udah final?\n- masih mau direvisi?"),
      false,
    );
  });

  it("melepas balasan tanpa pertanyaan sama sekali", () => {
    assert.equal(
      questionOnlyReply("tulis keterbatasannya dulu, baru kesimpulan."),
      false,
    );
  });

  it("melepas balasan kosong", () => {
    assert.equal(questionOnlyReply("   "), false);
  });
});
