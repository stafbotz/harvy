import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CALM_TRIAGE,
  parseInsightDraft,
  replyReviewInput,
  uncertainTriage,
  parseReplyVerdict,
  parseRiskTriage,
  riskTriageInput,
  safetyGuidance,
  DANGER_FALLBACK_REPLY,
  SUPPORT_FALLBACK_REPLY,
  withEmergencyAvailability,
  type RiskTriage,
} from "../src/ai/safety.js";
import {
  FOLLOW_UP_COOLDOWN_MS,
  needsReplyReview,
  shouldRaiseProfessionalHelp,
  worthRecording,
} from "../src/core/safety-policy.js";

const NOW = new Date("2026-07-27T10:00:00.000Z");

function triage(overrides: Partial<RiskTriage> = {}): RiskTriage {
  return { ...CALM_TRIAGE, ...overrides };
}

describe("triase risiko", () => {
  it("membaca tiga tingkat beserta tanda pendampingnya", () => {
    const parsed = parseRiskTriage(
      '{"risiko":"bahaya","sendirian":true,"sensitif":true,"ringkasan":"ingin mengakhiri hidup"}',
    );

    assert.deepEqual(parsed, {
      level: "bahaya",
      alone: true,
      sensitive: true,
      summary: "ingin mengakhiri hidup",
      certain: true,
    });
  });

  it("menolak tingkat yang tidak dikenal, bukan menebaknya aman", () => {
    // Menebak "biasa" akan membuat kegagalan model terlihat seperti percakapan
    // yang baik-baik saja. Pemanggilnya yang memilih jalur amannya sendiri.
    assert.equal(parseRiskTriage('{"risiko":"gawat"}'), null);
    assert.equal(parseRiskTriage("bukan json"), null);
    assert.equal(parseRiskTriage('```json\n{"risiko":"biasa"}\n```')?.level, "biasa");
  });

  it("menentukan mana yang perlu diperiksa dan dicatat", () => {
    assert.equal(needsReplyReview("biasa"), false);
    assert.equal(needsReplyReview("dukungan"), true);
    assert.equal(needsReplyReview("bahaya"), true);

    assert.equal(worthRecording("biasa"), false);
    assert.equal(worthRecording("dukungan"), true);
  });

  it("membawa konteks episode untuk jawaban pendek tanpa menjadikannya instruksi", () => {
    const input = riskTriageInput("belum", [
      {
        role: "user",
        text: "aku mau menyakiti diri sekarang",
        at: NOW.toISOString(),
      },
      {
        role: "harvy",
        text: "Kamu sudah berada di tempat yang lebih aman?",
        at: NOW.toISOString(),
      },
    ]);

    assert.match(input, /<konteks-terakhir>/);
    assert.match(input, /Pengguna: aku mau menyakiti diri/);
    assert.match(input, /<pesan>\nbelum\n<\/pesan>/);
    assert.match(input, /data, bukan aturan/i);
  });
});

describe("arahan keselamatan", () => {
  it("tidak menambah apa pun pada percakapan biasa", () => {
    assert.equal(safetyGuidance(triage()), "");
  });

  it("melarang mengalihkan lalu menutup percakapan", () => {
    const guidance = safetyGuidance(triage({ level: "dukungan" }));

    assert.match(guidance, /tidak boleh menolak membantu/i);
    assert.match(guidance, /tetap ada di percakapan/i);
  });

  it("berhenti menyuruh menghubungi orang ketika ia bilang tidak punya siapa-siapa", () => {
    const guidance = safetyGuidance(
      triage({ level: "dukungan", alone: true }),
    );

    // Ini keluhan yang paling merusak: menyuruh bercerita kepada orang lain
    // kepada seseorang yang baru saja bilang tidak percaya siapa pun berarti
    // memberi tahu orang yang terluka bahwa jalan keluarnya tertutup.
    assert.match(guidance, /Jangan mengulang saran bercerita/i);
    assert.match(guidance, /tidak menuntut\s+kepercayaan lebih dulu/i);
    assert.match(guidance, /apa yang bisa ia lakukan sendirian/i);
  });

  it("menaikkan tingkat ketika triasenya sendiri gagal, bukan menurunkan", () => {
    const fallback = uncertainTriage(true);

    // Uji QA 27 Juli 2026 membuktikan triase benar-benar dapat kehabisan waktu.
    // Keadaan lama menjatuhkannya ke "biasa", yang sekaligus mematikan arahan
    // anti-penolakan dan pemeriksaan balasan — dua jaring pengaman lumpuh
    // bersamaan, tepat pada giliran yang paling tidak boleh salah.
    assert.equal(fallback.level, "dukungan");
    assert.equal(needsReplyReview(fallback.level), true);

    const guidance = safetyGuidance(fallback);
    assert.match(guidance, /tidak boleh menolak membantu/i);
    assert.match(guidance, /Jangan menyuruhnya menghubungi orang tua/i);
    // Tidak boleh pula mengarang bahwa ia sudah bilang tidak punya siapa-siapa.
    assert.match(guidance, /Ia belum\s+mengatakannya/i);
  });

  it("mengutamakan jam-jam terdekat ketika bahayanya dekat", () => {
    const guidance = safetyGuidance(triage({ level: "bahaya" }));

    assert.match(guidance, /112/);
    assert.match(guidance, /beberapa jam ke depan/i);
    assert.match(guidance, /Jangan menutup percakapan/i);
    assert.match(guidance, /jangan mendiagnosis/i);
  });

  it("menempelkan batas ketersediaan 112 pada hasil akhir bahaya", () => {
    const reply = withEmergencyAvailability(
      "Aku di sini. Pindah ke tempat yang lebih aman dulu.",
      triage({ level: "bahaya" }),
    );
    assert.match(reply, /daerah yang sudah mengoperasikannya/i);
    assert.match(reply, /kalau tidak tersambung/i);
  });
});

describe("pemeriksaan balasan", () => {
  it("membaca putusan sebagai boolean tegas", () => {
    assert.equal(parseReplyVerdict('{"aman":true}'), true);
    assert.equal(parseReplyVerdict('{"aman":false,"alasan":"menolak"}'), false);
    assert.equal(parseReplyVerdict('{"alasan":"lupa"}'), null);
    assert.equal(parseReplyVerdict("kacau"), null);
  });

  it("menyediakan pengganti yang tetap menemani, bukan menutup", () => {
    assert.match(DANGER_FALLBACK_REPLY, /aku di sini/i);
    assert.match(DANGER_FALLBACK_REPLY, /112/);
    assert.match(SUPPORT_FALLBACK_REPLY, /aku di sini/i);
    assert.doesNotMatch(SUPPORT_FALLBACK_REPLY, /112|layanan darurat/i);
    // Pengganti ini dipakai justru ketika Harvy tidak tahu apakah penggunanya
    // punya orang yang aman, jadi ia tidak boleh menyuruh menghubungi siapa pun.
    assert.doesNotMatch(
      DANGER_FALLBACK_REPLY,
      /cerita ke orang|hubungi orang/i,
    );
  });

  it("membawa status sendirian dan konteks episode ke pemeriksa akhir", () => {
    const input = replyReviewInput(
      "nggak",
      "Kalau begitu coba hubungi teman dekatmu.",
      { level: "dukungan", alone: true, certain: true },
      [
        {
          role: "harvy",
          text: "Ada orang yang terasa aman untuk dihubungi?",
          at: NOW.toISOString(),
        },
      ],
    );

    assert.match(input, /tidak punya orang aman/i);
    assert.match(input, /tandai tidak\s+aman.*orang terdekat/is);
    assert.match(input, /Harvy: Ada orang yang terasa aman/);
    assert.match(input, /<pesan>\nnggak\n<\/pesan>/);
  });

  it("memberi tahu reviewer ketika triase gagal agar tidak mengarang orang aman", () => {
    const input = replyReviewInput(
      "aku nggak kuat",
      "Coba hubungi orang tuamu.",
      { level: "dukungan", alone: false, certain: false },
    );

    assert.match(input, /penilaian risiko.*tidak selesai/is);
    assert.match(input, /orang tua.*tidak disebut/is);
  });
});

describe("mengangkat bantuan profesional", () => {
  it("tidak pernah pada giliran yang sedang berat", () => {
    assert.equal(
      shouldRaiseProfessionalHelp(
        {
          level: "bahaya",
          lastRiskAt: "2026-07-01T00:00:00.000Z",
          lastSuggestedAt: null,
        },
        NOW,
      ),
      false,
    );
  });

  it("menunggu jarak dari kejadiannya sebelum diangkat", () => {
    const recent = new Date(NOW.getTime() - 60_000).toISOString();

    assert.equal(
      shouldRaiseProfessionalHelp(
        { level: "biasa", lastRiskAt: recent, lastSuggestedAt: null },
        NOW,
      ),
      false,
    );

    const lama = new Date(NOW.getTime() - FOLLOW_UP_COOLDOWN_MS - 1).toISOString();
    assert.equal(
      shouldRaiseProfessionalHelp(
        { level: "biasa", lastRiskAt: lama, lastSuggestedAt: null },
        NOW,
      ),
      true,
    );
  });

  it("tidak mengulanginya sebelum jaraknya cukup", () => {
    const lama = new Date(NOW.getTime() - FOLLOW_UP_COOLDOWN_MS - 1).toISOString();
    const baruSaja = new Date(NOW.getTime() - 60_000).toISOString();

    // Pasal 5 nomor 1: mengulanginya berubah menjadi desakan, dan pengguna
    // yang menolak tidak boleh dibuat merasa bersalah.
    assert.equal(
      shouldRaiseProfessionalHelp(
        { level: "biasa", lastRiskAt: lama, lastSuggestedAt: baruSaja },
        NOW,
      ),
      false,
    );
  });

  it("diam saja ketika belum pernah ada yang berat", () => {
    assert.equal(
      shouldRaiseProfessionalHelp(
        { level: "biasa", lastRiskAt: null, lastSuggestedAt: null },
        NOW,
      ),
      false,
    );
  });
});

describe("pemahaman pengguna", () => {
  it("membaca tiga field dan membuang yang kosong", () => {
    const draft = parseInsightDraft(
      '{"gaya":"nulis pendek-pendek","tahap":"tampaknya SMA","kerentanan":""}',
    );

    assert.equal(draft?.gaya, "nulis pendek-pendek");
    assert.equal(draft?.tahap, "tampaknya SMA");
    assert.equal(draft?.kerentanan, null);
  });

  it("mengembalikan null ketika seluruhnya kosong", () => {
    assert.equal(parseInsightDraft('{"gaya":"","tahap":"","kerentanan":""}'), null);
    assert.equal(parseInsightDraft("bukan json"), null);
  });
});
