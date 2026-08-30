import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizeAutomaticMemory,
  automaticMemoryCandidateAuthorized,
  deriveMemoryMetadata,
  exactExplicitMemoryCandidate,
  groundedAutomaticMemoryContent,
  inferExplicitResponsePreference,
  memoryCandidateConflictsWithRetractions,
  memoryEvidenceConflictsWithRetractions,
} from "../src/core/memory-candidate.js";

describe("deriveMemoryMetadata", () => {
  it("memenangkan retraction atas candidate dan semantic remember yang bertentangan", () => {
    const retractions = [{
      sourceEvidence:
        "Bahasa Inggris tadi hanya untuk proyek ini, bukan preferensi permanen.",
    }];
    assert.equal(memoryCandidateConflictsWithRetractions({
      content: "Bahasa Inggris tadi hanya untuk proyek ini, bukan preferensi permanen",
      sourceEvidence:
        "Bahasa Inggris tadi hanya untuk proyek ini, bukan preferensi permanen.",
    }, retractions), true);
    assert.equal(memoryEvidenceConflictsWithRetractions(
      "Koreksi: Bahasa Inggris tadi hanya untuk proyek ini, bukan preferensi permanen.",
      retractions,
    ), true);
    assert.equal(memoryCandidateConflictsWithRetractions({
      content: "Aku suka contoh batas 30 dan 31.",
      sourceEvidence: "Aku suka contoh batas 30 dan 31.",
    }, retractions), false);
  });

  it("hanya mengizinkan auto-memory grounded tentang pengguna yang tidak sesaat", () => {
    assert.equal(automaticMemoryCandidateAuthorized(
      "Aku biasanya paling fokus belajar pagi.",
      {
        sourceEvidence: "Aku biasanya paling fokus belajar pagi",
        sourceSubject: "self",
        durability: "durable",
      },
    ), true);
    assert.equal(automaticMemoryCandidateAuthorized(
      "Besok harus bangun pagi, malam ini belajar atau tidur?",
      {
        sourceEvidence: "Besok harus bangun pagi",
        sourceSubject: "self",
        durability: "transient",
      },
    ), false);
    assert.equal(automaticMemoryCandidateAuthorized(
      "Tolong buat acceptance reminder untuk Harvy.",
      {
        sourceEvidence: "acceptance reminder untuk Harvy",
        sourceSubject: "work",
        durability: "bounded",
      },
    ), false);
    assert.equal(automaticMemoryCandidateAuthorized(
      "Warna favoritku biru.",
      {
        sourceEvidence: "warna favoritku hijau",
        sourceSubject: "self",
        durability: "durable",
      },
    ), false, "evidence yang tidak ada di current turn harus gagal tertutup");
    assert.equal(automaticMemoryCandidateAuthorized(
      "Jangan pakai tool; bantu aku lewat percakapan ini saja.",
      {
        sourceEvidence: "bantu aku lewat percakapan ini saja",
        sourceSubject: "self",
        durability: "durable",
      },
    ), false, "constraint current turn tidak boleh menjadi preferensi durable");
    assert.equal(automaticMemoryCandidateAuthorized(
      "Mulai sekarang bantu aku lewat percakapan biasa, kecuali aku meminta tool.",
      {
        sourceEvidence:
          "Mulai sekarang bantu aku lewat percakapan biasa, kecuali aku meminta tool",
        sourceSubject: "self",
        durability: "durable",
      },
    ), true, "horizon lintas giliran yang eksplisit tetap dapat disimpan");
    assert.equal(automaticMemoryCandidateAuthorized(
      "Kalau aku memakai Harvy setiap hari, kebiasaan apa yang paling masuk akal?",
      {
        sourceEvidence: "aku memakai Harvy setiap hari",
        sourceSubject: "self",
        durability: "durable",
      },
    ), false, "premis pertanyaan bersyarat bukan fakta durable");
    assert.equal(automaticMemoryCandidateAuthorized(
      "Kalau penjelasan teknis panjang, aku sering kehilangan inti.",
      {
        sourceEvidence:
          "Kalau penjelasan teknis panjang, aku sering kehilangan inti",
        sourceSubject: "self",
        durability: "durable",
      },
    ), true, "pola habitual pada klausa akibat bukan skenario rekaan");
    assert.equal(automaticMemoryCandidateAuthorized(
      "Untuk konteks: jika aku pindah ke Bandung, apa yang perlu disiapkan?",
      {
        sourceEvidence: "aku pindah ke Bandung",
        sourceSubject: "self",
        durability: "bounded",
      },
    ), false, "exact evidence di dalam klausa andaian tetap ditolak");
    assert.equal(automaticMemoryCandidateAuthorized(
      "Let's continue in English for this section.",
      {
        sourceEvidence: "Let's continue in English for this section",
        sourceSubject: "self",
        durability: "durable",
      },
    ), false, "peralihan bahasa satu bagian bukan preferensi durable");
    assert.equal(automaticMemoryCandidateAuthorized(
      "Mulai sekarang selalu balas dalam bahasa Inggris.",
      {
        sourceEvidence: "Mulai sekarang selalu balas dalam bahasa Inggris",
        sourceSubject: "self",
        durability: "durable",
      },
    ), true, "horizon durable explicit tetap menang atas pola bahasa");
  });

  it("menyimpan evidence user, bukan perluasan makna buatan model", () => {
    const raw = "Kalau penjelasan teknis panjang aku sering kehilangan inti.";
    assert.equal(
      groundedAutomaticMemoryContent(raw, {
        sourceEvidence:
          "Kalau penjelasan teknis panjang aku sering kehilangan inti",
        sourceSubject: "self",
        durability: "durable",
      }),
      "Kalau penjelasan teknis panjang aku sering kehilangan inti",
    );
    assert.equal(
      groundedAutomaticMemoryContent("Let's continue in English.", {
        sourceEvidence: "Let's continue in English",
        sourceSubject: "self",
        durability: "durable",
      }),
      null,
    );
  });

  it("memakai span explicit exact saat satu parafrasa model tidak cocok leksikal", () => {
    const requested =
      "kalau membantu pekerjaan produk, jawab dengan keputusan utama dulu lalu alasan singkat; jangan buka dengan empati generik";
    assert.deepEqual(
      exactExplicitMemoryCandidate(requested, [{
        kind: "preference",
        content:
          "Untuk pekerjaan produk, beri keputusan utama lalu alasan singkat tanpa empati generik.",
      }]),
      { kind: "preference", content: requested },
    );
    assert.equal(
      exactExplicitMemoryCandidate(requested, [
        { kind: "preference", content: "Kandidat satu" },
        { kind: "context", content: "Kandidat dua" },
      ]),
      null,
      "lebih dari satu kandidat tidak boleh memperoleh scope explicit yang sama",
    );
  });

  it("membentuk authority lokal hanya untuk instruksi bentuk jawaban lintas giliran", () => {
    assert.deepEqual(
      inferExplicitResponsePreference(
        "Mulai sekarang, aku lebih suka semua jawaban memakai langkah pendek dan bernomor.",
      ),
      {
        kind: "preference",
        content: "Lebih suka semua jawaban memakai langkah pendek dan bernomor.",
      },
    );
    assert.equal(
      inferExplicitResponsePreference("Aku lebih suka jawaban ini singkat."),
      null,
    );
    assert.equal(
      inferExplicitResponsePreference(
        "Tolong simpan: aku lebih suka semua jawaban singkat.",
      ),
      null,
    );
    assert.equal(
      inferExplicitResponsePreference(
        "Mulai sekarang, aku lebih suka belajar malam.",
      ),
      null,
      "preferensi personal bukan instruksi tentang jawaban Harvy",
    );
    assert.equal(
      inferExplicitResponsePreference(
        "Mulai sekarang, aku lebih suka semua jawaban singkat. Warna favoritku biru.",
      ),
      null,
      "kalimat kedua tidak boleh ikut memperoleh authority",
    );
    assert.deepEqual(
      inferExplicitResponsePreference(
        "Ke depannya, saya lebih suka setiap balasanmu memakai poin pendek!",
      ),
      {
        kind: "preference",
        content: "Lebih suka setiap balasanmu memakai poin pendek.",
      },
    );
  });

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
      "Rani adalah pacarku",
      "Rani adalah pacarku",
    );
    const corrected = deriveMemoryMetadata(
      "personal",
      "Rani bukan pacarku lagi",
      "Rani bukan pacarku lagi",
    );

    assert.equal(previous.predicate, "romantic_partner");
    assert.equal(previous.value, "Rani");
    assert.equal(corrected.predicate, "romantic_partner");
    assert.equal(corrected.value, "tidak:Rani");
    assert.equal(corrected.correction, true);
    assert.equal(corrected.graphProjection?.relation, "no_longer_partner_of");
  });
});

/**
 * Keputusan yang dipakai adapter maupun probe.
 *
 * Sebelum dipisahkan, keputusan ini hidup sebagai `flatMap` di dalam
 * `create-bot.ts`, sehingga probe hanya dapat melaporkan kandidat mentah dari
 * extractor—dan kandidat mentah memuat parafrasa yang produksi tolak. Probe
 * karena itu tampak menyimpan lebih banyak daripada yang sebenarnya terjadi,
 * dan laporannya membenarkan klaim "sudah kucatat" yang tidak pernah tercatat.
 */
describe("otorisasi kandidat auto-memory", () => {
  it("membumikan isi kandidat pada kalimat pengguna", () => {
    const authorization = authorizeAutomaticMemory(
      "aku lebih suka belajar malam hari",
      {
        kind: "preference" as const,
        content: "Selalu memilih belajar malam untuk semua mata pelajaran",
        sourceEvidence: "lebih suka belajar malam hari",
        sourceSubject: "self" as const,
        durability: "durable" as const,
      },
    );

    assert.ok(authorization);
    // Yang tersimpan adalah span dari kalimat pengguna, bukan perluasan model.
    assert.equal(authorization.authorized.content, "lebih suka belajar malam hari");
  });

  // Penjaga terpenting di sini. Parafrasa yang tidak berpijak pada kalimat
  // pengguna adalah cara paling halus sebuah catatan salah masuk: isinya
  // terdengar benar, dan tidak ada yang pernah mengatakannya.
  it("menolak kandidat yang tidak berpijak pada kalimat pengguna", () => {
    assert.equal(
      authorizeAutomaticMemory("besok aku ada ujian biologi", {
        kind: "preference" as const,
        content: "Menyukai biologi lebih daripada mata pelajaran lain",
        sourceEvidence: "menyukai biologi lebih daripada mata pelajaran lain",
        sourceSubject: "self" as const,
        durability: "durable" as const,
      }),
      null,
    );
  });

  it("menolak kandidat tanpa evidence sama sekali", () => {
    assert.equal(
      authorizeAutomaticMemory("halo", {
        kind: "preference" as const,
        content: "Ramah",
      }),
      null,
    );
  });
});
