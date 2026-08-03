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

describe("naskah perkenalan", () => {
  it("menyapa dengan nama Telegram bila ada, tanpa memaksakannya", () => {
    assert.match(introBubbles("Dimas", false)[0] ?? "", /^Hai Dimas, aku Harvy/);
    assert.match(introBubbles(null, false)[0] ?? "", /^Hai, aku Harvy/);
    assert.match(
      introBubbles("x".repeat(40), false)[0] ?? "",
      /^Hai, aku Harvy/,
    );
  });

  it("membuka dengan apa yang boleh dibawa, bukan daftar fitur", () => {
    const [opening = ""] = introBubbles(null, false);

    assert.match(opening, /cerita yang masih berantakan/);
    // "AI pendamping" membuat kemampuannya terdengar sempit sejak kalimat
    // pertama, dan daftar perintah adalah manual sebelum percakapan.
    assert.doesNotMatch(opening, /AI pendamping/i);
    assert.doesNotMatch(opening, /\/tugas|\/bantuan/);
  });

  it("mengatakan pesannya diproses layanan AI di luar Harvy", () => {
    const consent = introBubbles(null, false)[1] ?? "";

    // Pasal 3.9: pengguna berhak tahu ke mana isi pesannya pergi, sebelum ia
    // pergi ke sana.
    assert.match(consent, /layanan AI di luar Harvy/i);
    assert.match(consent, /satu atau lebih/i);
    assert.match(consent, /layanan cadangan/i);
    assert.match(consent, /bisa salah/i);
    assert.match(CONSENT_DETAIL, /dikirim ulang ke layanan cadangan/i);
    assert.match(CONSENT_DETAIL, /penyedia search terpisah/i);
    assert.match(CONSENT_DETAIL, /memori dan riwayat lama tidak ikut/i);
  });

  it("tidak menjanjikan penilai AI selalu mengenali catatan pribadi", () => {
    assert.match(CONSENT_DETAIL, /penilaian AI bisa keliru/i);
    assert.doesNotMatch(
      CONSENT_DETAIL,
      /sifatnya pribadi selalu aku tanya/i,
    );
  });

  it("mengaku apa adanya soal pemeriksaan bahaya sebelum persetujuan", () => {
    const withHeld = introBubbles(null, true)[1] ?? "";

    // Naskah lama berbunyi "belum aku baca". Sejak pemeriksaan bahaya boleh
    // berjalan lebih dulu, kalimat itu menjadi klaim yang tidak benar.
    assert.doesNotMatch(withHeld, /belum aku baca/i);
    assert.match(withHeld, /lihat sekilas/i);
    assert.match(withHeld, /bahaya/i);
    assert.doesNotMatch(introBubbles(null, false)[1] ?? "", /lihat sekilas/i);
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

  it("memberi jalur keselamatan eksplisit tanpa harus menyetujui AI", () => {
    const buttons = consentActions().inline_keyboard.flat();
    const safety = buttons.find((button) => button.text.includes("nggak aman"));
    assert.equal(
      (safety as { callback_data?: string } | undefined)?.callback_data,
      "safety:now",
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
