import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessmentIdleWindowMs,
  assessTurnBoundaryLocally,
  classifyTurnBoundaryLocally,
  guardTurnBoundary,
  idleWindowMs,
  acknowledgesPrematureReply,
  withPrematureAcknowledgement,
  MULTI_BUBBLE_IDLE_MS,
} from "../src/core/turn-taking-policy.js";

describe("kebijakan giliran percakapan", () => {
  it("memutus bentuk lengkap yang sempit tanpa classifier", () => {
    for (const message of [
      "iya",
      "oke",
      "makasih",
      "B",
      "opsi 2",
      "17 x 24 berapa?",
      "apa ibu kota Jepang?",
      "17 Agustus tahun ini hari apa?",
    ]) {
      assert.equal(classifyTurnBoundaryLocally(message), "complete", message);
    }
  });

  it("menahan fragmen yang jelas tanpa classifier", () => {
    for (const message of ["karena", "tapi", "terus aku", "jadi tadi aku mau"]) {
      assert.equal(classifyTurnBoundaryLocally(message), "incomplete", message);
    }
  });

  it("menyerahkan pembuka dan emosi ambigu ke classifier", () => {
    for (const message of [
      "jadi gini",
      "aku mau cerita",
      "aku capek banget",
      "kamu masih ingat yang tadi?",
      "eh, kenapa ya?",
      "aku mau menyakiti diri sekarang",
      "satu\ndua",
    ]) {
      assert.equal(classifyTurnBoundaryLocally(message), null, message);
    }
  });

  it("menyerahkan bahasa natural ambigu ke assessment semantik", () => {
    assert.equal(guardTurnBoundary("eh tau ga", "open"), "open");
    assert.equal(guardTurnBoundary("eh tau ga", "complete"), "complete");
    assert.equal(guardTurnBoundary("aku takut", "open"), "open");
    assert.equal(
      guardTurnBoundary(
        "aku bingung antara informatika dan SI, menurutmu pilih mana",
        "complete",
      ),
      "complete",
    );
  });

  it("memaksa fragmen karna menunggu jendela terpanjang", () => {
    const state = guardTurnBoundary(
      "aku mau curhat\naku hari ini\ncapekk banget\nkarna",
      "complete",
    );

    assert.equal(state, "incomplete");
    assert.equal(idleWindowMs(state, 4), 12_000);
  });

  it("menghormati keputusan urgent fallback model tanpa menundanya", () => {
    assert.equal(guardTurnBoundary("aku takutttt banget", "open"), "open");
    assert.equal(
      guardTurnBoundary("aku mau menyakiti diri sekarang", "urgent"),
      "urgent",
    );
    assert.equal(idleWindowMs("urgent", 2), 0);
  });

  it("menjaga complete kuat cepat dan hanya menunggu complete yang ragu", () => {
    assert.equal(idleWindowMs("complete", 1), 0);
    assert.equal(idleWindowMs("complete", 3), 0);
    assert.equal(
      assessmentIdleWindowMs({
        state: "complete",
        confidence: 0.6,
        continuationLikelihood: 0.6,
        reasonClass: "uncertain",
      }, 3),
      4_000,
    );
    assert.equal(idleWindowMs("open", 1), 7_000);
  });

  it("mempertahankan closed form sempit dan fragmen keras", () => {
    assert.equal(guardTurnBoundary("nggak jadi", "incomplete"), "complete");
    assert.equal(guardTurnBoundary("jadi", "complete"), "incomplete");
  });
});

describe("penilaian batas giliran lokal pada semburan", () => {
  // Sampai 30 Agustus 2026 fungsi ini menyerah pada setiap pesan multi-bubble,
  // sehingga seluruh semburan dilempar ke classifier model. Classifier itu
  // gagal pada 16 dari 28 giliran sesi nyata, dan setiap kegagalan menjadi
  // tunggu tujuh detik—pada bentuk pesan yang justru paling sering muncul.
  it("membaca bubble terakhir untuk memutuskan kelengkapan", () => {
    const assessment = assessTurnBoundaryLocally(
      ["aku mau nanya", "makasih ya"].join("\n"),
    );

    assert.equal(assessment?.state, "complete");
  });

  it("mengenali fragmen di bubble terakhir sebagai belum selesai", () => {
    const assessment = assessTurnBoundaryLocally(
      ["besok ada ujian biologi", "soalnya"].join("\n"),
    );

    assert.equal(assessment?.state, "incomplete");
  });

  // Ini penjaga yang paling penting di berkas ini. Dengan keyakinan 0,99 dan
  // continuation 0,02, `assessmentIdleWindowMs` melewati bantalan multi-bubble
  // dan memotong di nol detik—tepat pada bentuk pesan yang paling mungkin
  // masih berlanjut.
  it("tidak memotong semburan di nol detik", () => {
    const assessment = assessTurnBoundaryLocally(
      ["aku mau nanya", "makasih ya"].join("\n"),
    );
    assert.ok(assessment);

    assert.ok(
      assessmentIdleWindowMs(assessment, 2) >= MULTI_BUBBLE_IDLE_MS,
      "semburan yang tampak lengkap tetap mendapat bantalan",
    );
  });

  it("mempertahankan pemotongan segera untuk satu bubble yang jelas selesai", () => {
    const assessment = assessTurnBoundaryLocally("makasih ya");
    assert.ok(assessment);

    assert.equal(assessment.state, "complete");
    assert.equal(assessmentIdleWindowMs(assessment, 1), 0);
  });

  it("tetap menyerah ketika bubble terakhir tidak jelas", () => {
    assert.equal(
      assessTurnBoundaryLocally(
        ["besok dua deadline", "aku harus gimana ya kira-kira"].join("\n"),
      ),
      null,
    );
  });
});

describe("kesadaran Harvy ketika ia memotong pengguna", () => {
  const BALASAN =
    "Dua tenggat barengan memang bikin pusing. Coba mulai dari yang paling dekat, lalu pecah jadi bagian kecil biar nggak numpuk.";

  it("mengakui sambungan cepat yang membawa isi baru", () => {
    for (
      const message of [
        "yang biologi sama yang sejarah, aku harus gimana ya",
        "sama satu lagi ada ulangan kimia",
      ]
    ) {
      assert.equal(
        acknowledgesPrematureReply({ message, reply: BALASAN, elapsedMs: 1_200 }),
        true,
        message,
      );
    }
  });

  // Penjaga terpenting berkas ini. Pertanyaan lanjutan berbentuk sama persis
  // dengan sambungan yang terpotong; yang membedakan hanya waktu. Orang harus
  // membaca balasannya lebih dulu sebelum dapat menyusun pertanyaan baru, dan
  // itu tidak mungkin selesai dalam hitungan detik.
  it("tidak mengakui pertanyaan lanjutan yang datang setelah sempat dibaca", () => {
    assert.equal(
      acknowledgesPrematureReply({
        message: "terus kalau ujiannya besok gimana?",
        reply: BALASAN,
        elapsedMs: 30_000,
      }),
      false,
    );
  });

  it("tidak mengakui penutup maupun topik baru", () => {
    for (
      const message of ["makasih ya", "oke", "besok aku ada les renang"]
    ) {
      assert.equal(
        acknowledgesPrematureReply({ message, reply: BALASAN, elapsedMs: 1_000 }),
        false,
        message,
      );
    }
  });

  // Inilah arti "hanya ketika mengubah jawaban". Sambungan yang seluruh isinya
  // sudah disinggung balasan tadi tidak mengubah apa pun, jadi mengakuinya
  // hanya menambah kalimat tanpa menambah kejujuran.
  it("diam ketika sambungannya sudah terjawab balasan sebelumnya", () => {
    assert.equal(
      acknowledgesPrematureReply({
        message: "yang tenggat paling dekat itu",
        reply: BALASAN,
        elapsedMs: 1_000,
      }),
      false,
    );
  });

  // Fragmen telanjang belum membawa isi apa pun; isinya datang di bubble
  // berikutnya, dan bubble-bubble itu digabung menjadi satu giliran.
  it("diam pada fragmen yang belum membawa isi", () => {
    assert.equal(
      acknowledgesPrematureReply({ message: "tapi", reply: BALASAN, elapsedMs: 700 }),
      false,
    );
  });

  it("gagal aman pada masukan yang tidak masuk akal", () => {
    assert.equal(
      acknowledgesPrematureReply({ message: "yang sejarah", reply: "", elapsedMs: 500 }),
      false,
    );
    assert.equal(
      acknowledgesPrematureReply({
        message: "yang sejarah",
        reply: BALASAN,
        elapsedMs: Number.NaN,
      }),
      false,
    );
  });
});

describe("pengakuan potong yang dimiliki kode", () => {
  // Pengukuran provider nyata 30 Agustus 2026: arahan berbentuk kalimat di
  // prompt menghasilkan pengakuan 0 dari 5. Sesudah kalimatnya dimiliki kode,
  // 3 dari 3. Yang wajib terjadi tidak boleh bergantung kepatuhan model.
  it("menambahkan pengakuan di depan balasan", () => {
    const reply = withPrematureAcknowledgement("Kerjain biologi dulu.", "siswa");

    assert.match(reply, /keburu|motong|belum selesai/iu);
    assert.match(reply, /Kerjain biologi dulu\./u);
  });

  // Kalau model kebetulan sudah mengakui, menambah lagi membuat Harvy meminta
  // maaf dua kali dalam satu balasan.
  it("tidak menulis pengakuan dua kali", () => {
    const already = "Eh, aku keburu jawab tadi. Kerjain biologi dulu.";

    assert.equal(withPrematureAcknowledgement(already, "siswa"), already);
  });

  it("memilih kalimat yang stabil per pengguna tetapi tidak seragam", () => {
    const a = withPrematureAcknowledgement("Oke.", "siswa-a");
    const b = withPrematureAcknowledgement("Oke.", "siswa-a");

    assert.equal(a, b);
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"].map((seed) =>
      withPrematureAcknowledgement("Oke.", seed)
    );
    assert.ok(new Set(seeds).size > 1, "kalimatnya tidak boleh selalu sama");
  });

  it("membiarkan balasan kosong apa adanya", () => {
    assert.equal(withPrematureAcknowledgement("   ", "siswa"), "   ");
  });
});
