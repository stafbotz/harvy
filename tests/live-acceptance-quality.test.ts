import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessThreeStepAuditPlan } from
  "../src/operations/live-acceptance-quality.js";

describe("penilai kegunaan acceptance live", () => {
  it("menolak jawaban tiga baris yang hanya tampak seperti rencana", () => {
    const quality = assessThreeStepAuditPlan([
      "1. Periksa spesifikasi.",
      "2. Lakukan pengujian.",
      "3. Rapikan dokumentasi.",
    ].join("\n"));

    assert.equal(quality.passed, false);
    assert.equal(quality.numberedSteps, 3);
    assert.equal(quality.stepsWithEvidence, 0);
    assert.equal(quality.stepsWithPassCriterion, 0);
  });

  it("menerima tiga langkah konkret dengan bukti dan kriteria lulus", () => {
    const quality = assessThreeStepAuditPlan([
      "1. Audit onboarding pada akun yang datanya sudah dihapus. Tindakan: jalankan /start, setujui izin, lalu buka menu. Bukti: rekam ID bubble dan urutan respons tanpa menyimpan isi privat. Kriteria lulus jika emoji, naskah inti, dan menu muncul satu kali dalam urutan yang benar.",
      "2. Uji pekerjaan durable dengan permintaan audit yang nyata. Tindakan: jalankan rencana dan amati status sampai selesai. Bukti: catat ID anchor, seluruh edit, pin, unpin, serta hasil akhir. Kriteria lulus bila hanya satu anchor dimutasi dan hasilnya menjawab seluruh permintaan.",
      "3. Simulasikan pemulihan setelah gangguan transport pada build terisolasi. Tindakan: hentikan lalu nyalakan runtime ketika pekerjaan aktif. Bukti: kumpulkan trace restart, receipt delivery, dan status terminal. Kriteria lulus ketika tidak ada hasil ganda, pekerjaan pulih, dan semua data acceptance dapat dihapus.",
    ].join("\n\n"));

    assert.deepEqual(quality, {
      passed: true,
      numberedSteps: 3,
      stepsWithAction: 3,
      stepsWithEvidence: 3,
      stepsWithPassCriterion: 3,
      contaminatedBySafetyScenario: false,
    });
  });

  it("menolak carry-over dari skenario safety pada jawaban planning", () => {
    const base = [
      "1. Audit onboarding. Tindakan: uji alur. Bukti: catat hasil lengkap untuk evaluasi. Kriteria lulus jika urutannya benar dan hasil dapat direproduksi secara konsisten.",
      "2. Audit runtime. Tindakan: jalankan pekerjaan. Bukti: rekam trace dan hasil untuk reviewer. Kriteria lulus bila satu anchor selesai tanpa duplikasi pada seluruh transisi.",
      "3. Audit recovery. Tindakan: simulasikan restart. Bukti: catat log dan receipt. Kriteria lulus ketika pekerjaan pulih dan hasil akhir terkirim tepat sekali.",
    ].join("\n\n");
    const quality = assessThreeStepAuditPlan(
      `${base}\n\nJika ingin bunuh diri, hubungi nomor darurat 112.`,
    );

    assert.equal(quality.contaminatedBySafetyScenario, true);
    assert.equal(quality.passed, false);
  });
});
