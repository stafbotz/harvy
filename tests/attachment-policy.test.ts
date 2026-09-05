import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isProjectArchive,
  unsupportedAttachmentReply,
  type UnsupportedAttachment,
} from "../src/core/attachment-policy.js";
import {
  HARVY_GROUP_IDENTITY,
  HARVY_IDENTITY,
} from "../src/ai/persona.js";

const SEMUA: readonly UnsupportedAttachment[] = [
  "dokumen",
  "suara",
  "video",
  "gambar-asing",
];

describe("kebijakan lampiran", () => {
  it("mengenali archive project dari nama berkas maupun mimetype", () => {
    assert.equal(isProjectArchive("proyek.zip", null), true);
    assert.equal(isProjectArchive("PROYEK.ZIP", null), true);
    assert.equal(isProjectArchive(null, "application/zip"), true);
    assert.equal(isProjectArchive("tugas.pdf", "application/pdf"), false);
    assert.equal(isProjectArchive(null, null), false);
    assert.equal(isProjectArchive("zip.pdf", "application/pdf"), false);
  });

  it("selalu meminta maaf lebih dahulu", () => {
    for (const kind of SEMUA) {
      assert.match(unsupportedAttachmentReply(kind), /^Maaf ya,/u, kind);
    }
  });

  it("menyebut batas kemampuannya, bukan menyalahkan pengirim", () => {
    for (const kind of ["dokumen", "suara", "video"] as const) {
      assert.match(
        unsupportedAttachmentReply(kind),
        /cuma teks dan gambar/u,
        kind,
      );
    }
  });

  it("menawarkan screenshot untuk yang memang bisa di-screenshot", () => {
    for (const kind of ["dokumen", "video", "gambar-asing"] as const) {
      assert.match(unsupportedAttachmentReply(kind), /screenshot/iu, kind);
    }
  });

  it("meminta diketik untuk suara, karena screenshot tidak berlaku di situ", () => {
    const reply = unsupportedAttachmentReply("suara");
    assert.match(reply, /ketik/iu);
    assert.doesNotMatch(reply, /screenshot/iu);
  });

  it("tidak pernah menjanjikan akan membacanya nanti", () => {
    for (const kind of SEMUA) {
      assert.doesNotMatch(
        unsupportedAttachmentReply(kind),
        /nanti\s+(?:aku\s+)?(?:baca|buka|coba\s+buka)|belum\s+bisa\s+sekarang/iu,
        kind,
      );
    }
  });

  it("tidak menyuruh mengetik ulang seluruh isi berkas", () => {
    assert.doesNotMatch(
      unsupportedAttachmentReply("dokumen"),
      /ketik\s+ulang|salin\s+isinya|copy\s*-?\s*paste/iu,
    );
  });
});

describe("kesadaran Harvy atas batas kemampuannya", () => {
  it("menyatakan bahwa ia hanya menangkap teks dan gambar", () => {
    // Sisi model harus mengatakan hal yang sama dengan sisi deterministik.
    // Tanpa ini Harvy menjawab benar ketika berkasnya datang, tetapi salah
    // ketika ditanya "kamu bisa baca PDF, nggak?".
    assert.match(HARVY_IDENTITY, /hanya teks dan gambar/u);
    assert.match(HARVY_IDENTITY, /tidak mendengar rekaman suara/u);
    assert.match(HARVY_IDENTITY, /tidak menonton video/u);
    assert.match(HARVY_IDENTITY, /PDF, Word, Excel, atau PowerPoint/u);
  });

  it("mengarahkan ke screenshot, bukan ke mengetik ulang", () => {
    assert.match(HARVY_IDENTITY, /di-screenshot/u);
    assert.match(HARVY_IDENTITY, /menyuruhnya mengetik ulang seluruh isi/u);
  });

  it("melarang berpura-pura sudah membaca berkasnya", () => {
    assert.match(HARVY_IDENTITY, /Jangan berpura-pura/u);
    assert.match(HARVY_IDENTITY, /jangan menebak isinya dari nama berkas/u);
  });

  it("menyatakan batas grup yang lebih sempit lagi: teks saja", () => {
    // Gambar grup memang belum diproses, jadi persona grup tidak boleh
    // menjanjikan kemampuan yang ada di chat pribadi.
    assert.match(HARVY_GROUP_IDENTITY, /yang dapat kamu tangkap hanya teks/u);
    assert.match(HARVY_GROUP_IDENTITY, /tidak sampai kepadamu di sini/u);
  });
});
