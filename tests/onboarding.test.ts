import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONSENT_DETAIL,
  consentActions,
  consentDetail,
  HeldMessageStore,
  introBubbles,
  PRE_CONSENT_SAFETY,
  welcomeBack,
} from "../src/bot/onboarding.js";

const TEST_TERMS_URL = "https://harvy.id/terms";

describe("naskah perkenalan", () => {
  it("menyapa dengan emoji 👋 lalu nama Telegram bila ada, tanpa memaksakannya", () => {
    assert.equal(introBubbles("Dimas", false, TEST_TERMS_URL)[0], "👋");
    assert.match(introBubbles("Dimas", false, TEST_TERMS_URL)[1] ?? "", /^Haloo Dimas, aku Harvy/);
    assert.match(introBubbles(null, false, TEST_TERMS_URL)[1] ?? "", /^Haloo, aku Harvy/);
    assert.match(
      introBubbles("x".repeat(40), false, TEST_TERMS_URL)[1] ?? "",
      /^Haloo, aku Harvy/,
    );
  });

  it("mengenalkan diri sebagai AI agent dan apa yang bisa dilakukan", () => {
    const [, opening = ""] = introBubbles(null, false, TEST_TERMS_URL);

    assert.match(opening, /ai agent/i);
    assert.match(opening, /nyelesain tugas/);
    assert.match(opening, /mikir bareng/);
    assert.match(opening, /belajar materi susah/);
    // Tidak menyebut diri sebagai teman — Pasal 3.6.
    assert.doesNotMatch(opening, /temen|teman/i);
    assert.doesNotMatch(opening, /\/tugas|\/bantuan/);
  });

  it("mengatakan pesannya diproses oleh AI dan memberi link terms", () => {
    const consent = introBubbles(null, false, TEST_TERMS_URL)[2] ?? "";

    // Pasal 3.9: pengguna berhak tahu pesannya diproses AI.
    assert.match(consent, /diproses oleh AI/i);
    // Pengguna tahu bisa lihat dan hapus data.
    assert.match(consent, /lihat atau hapus/i);
    // Link ke halaman persyaratan.
    assert.match(consent, new RegExp(TEST_TERMS_URL));
    // Framing sebagai janji bersama.
    assert.match(consent, /janji di antara kita/i);
    assert.match(CONSENT_DETAIL, /model utama.*memori dan riwayat tersimpan/i);
    assert.match(CONSENT_DETAIL, /dikirim ulang ke layanan cadangan/i);
    assert.match(CONSENT_DETAIL, /bisa keliru/i);
    assert.match(CONSENT_DETAIL, /checkpoint.*ekspor\/penghapusan data/i);
  });

  it("tidak menjanjikan penilai AI selalu mengenali catatan pribadi", () => {
    assert.match(CONSENT_DETAIL, /penilaian AI bisa keliru/i);
    assert.doesNotMatch(
      CONSENT_DETAIL,
      /sifatnya pribadi selalu aku tanya/i,
    );
  });

  it("mengaku apa adanya soal pemeriksaan bahaya sebelum persetujuan", () => {
    const withHeld = introBubbles(null, true, TEST_TERMS_URL)[2] ?? "";

    // Naskah lama berbunyi "belum aku baca". Sejak pemeriksaan bahaya boleh
    // berjalan lebih dulu, kalimat itu menjadi klaim yang tidak benar.
    assert.doesNotMatch(withHeld, /belum aku baca/i);
    assert.match(withHeld, /lihat sekilas/i);
    assert.match(withHeld, /bahaya/i);
    assert.doesNotMatch(introBubbles(null, false, TEST_TERMS_URL)[2] ?? "", /lihat sekilas/i);
  });

  it("menjelaskan penyimpanan dan cara menghapus hanya bila ditanya", () => {
    assert.match(CONSENT_DETAIL, /nyuruh aku lupain/i);
    assert.match(CONSENT_DETAIL, /bukan terapis, dokter, atau layanan darurat/i);
  });

  it("membedakan retensi file log lokal dari collector deployment", () => {
    const detail = consentDetail(30, 9);
    assert.match(detail, /file log gangguan teknis lokal/i);
    assert.match(detail, /paling lama 9 hari/i);
    assert.match(detail, /collector perusahaan/i);
    assert.match(detail, /kebijakan infrastrukturnya sendiri/i);
  });

  it("mengarahkan bahaya segera ke manusia, bukan ke dirinya sendiri", () => {
    assert.match(PRE_CONSENT_SAFETY, /112/);
    assert.match(PRE_CONSENT_SAFETY, /nggak bisa gantiin mereka/i);
  });

  it("menyediakan satu tombol persetujuan", () => {
    const buttons = consentActions().inline_keyboard.flat();
    assert.equal(buttons.length, 1);
    assert.equal(
      (buttons[0] as { text?: string } | undefined)?.text,
      "Okei, mulai.",
    );
    assert.equal(
      (buttons[0] as { callback_data?: string } | undefined)?.callback_data,
      "consent:yes",
    );
  });

  it("menyapa pengguna lama dari keadaan nyata, bukan ingatan yang dikarang", () => {
    assert.match(welcomeBack(0), /Ada apa hari ini/);
    assert.match(welcomeBack(3), /masih ada 3 yang belum kelar/i);
    assert.doesNotMatch(welcomeBack(0), /Hai, aku Harvy/);
  });
});

describe("pesan yang ditahan sebelum persetujuan", () => {
  it("mengumpulkan bubble lalu menyerahkannya sekali", () => {
    const held = new HeldMessageStore();

    held.hold("student", "eh tau ga");
    held.hold("student", "aku capek banget");

    assert.equal(held.has("student"), true);
    assert.equal(held.take("student"), "eh tau ga\naku capek banget");
    assert.equal(held.has("student"), false);
    assert.equal(held.take("student"), "");
  });

  it("berhenti menampung ketika sudah kebanyakan", () => {
    const held = new HeldMessageStore();

    for (let index = 0; index < 40; index += 1) {
      held.hold("student", `bubble ${index}`);
    }

    // Ini memori proses, bukan penyimpanan. Pengguna yang terus mengetik tanpa
    // menekan tombol tidak boleh membuatnya tumbuh tanpa batas.
    assert.ok(held.take("student").split("\n").length <= 12);
  });

  it("memperkenalkan diri sekali meski beberapa bubble datang berbarengan", () => {
    const held = new HeldMessageStore();

    assert.equal(held.markIntroduced("student"), true);
    assert.equal(held.markIntroduced("student"), false);
  });

  it("mengingatkan dan mengarahkan keselamatan sekali saja", () => {
    const held = new HeldMessageStore();

    assert.equal(held.markReminded("student"), true);
    assert.equal(held.markReminded("student"), false);
    assert.equal(held.markSafetyShown("student"), true);
    assert.equal(held.markSafetyShown("student"), false);
  });

  it("melupakan seluruh jejaknya setelah pengguna setuju", () => {
    const held = new HeldMessageStore();
    held.hold("student", "halo");
    held.markIntroduced("student");

    held.clear("student");

    assert.equal(held.has("student"), false);
    assert.equal(held.markIntroduced("student"), true);
  });
});
