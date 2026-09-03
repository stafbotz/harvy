import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  LocalTextEmbeddingProvider,
} from "../src/ai/local-embedding-client.js";

/**
 * Penyedia embedding yang berjalan di dalam proses Harvy.
 *
 * Yang diuji di sini sengaja hanya pagar-pagarnya, bukan mutu vektornya.
 * Memuat model sungguhan menuntut unduhan ratusan megabita dan tidak pantas
 * dijalankan di suite; kualitas maknanya dibuktikan terpisah lewat probe
 * langsung terhadap kalimat berbahasa Indonesia.
 *
 * Semua yang di bawah ini harus selesai **tanpa** menyentuh model sama sekali.
 * Kalau satu saja mulai memuatnya, suite berubah dari enam menit menjadi
 * unduhan besar pada mesin siapa pun yang menjalankannya.
 */
describe("penyedia embedding lokal", () => {
  it("memakai model multibahasa simetris sebagai bawaan", () => {
    const provider = new LocalTextEmbeddingProvider();
    assert.equal(provider.modelId, DEFAULT_LOCAL_EMBEDDING_MODEL);
    assert.match(provider.modelId, /multilingual/iu);
  });

  // Versi mengikat cache embedding ke model yang menghasilkannya. Tanpa itu,
  // mengganti model membuat vektor lama dan baru hidup di ruang berbeda dan
  // skor kemiripannya berhenti berarti apa pun.
  it("menandai versinya sebagai lokal, terpisah dari model jarak jauh", () => {
    const provider = new LocalTextEmbeddingProvider({ model: "uji/model-a" });
    assert.equal(provider.modelVersion, "local:uji/model-a");

    const lain = new LocalTextEmbeddingProvider({ model: "uji/model-b" });
    assert.notEqual(provider.modelVersion, lain.modelVersion);
  });

  it("mengembalikan larik kosong tanpa memuat model", async () => {
    const provider = new LocalTextEmbeddingProvider({ model: "tidak/ada" });
    assert.deepEqual(await provider.embed([]), []);
  });

  it("menolak batch yang terlalu besar sebelum memuat model", async () => {
    const provider = new LocalTextEmbeddingProvider({ model: "tidak/ada" });
    const terlalu = Array.from({ length: 33 }, (_, i) => `teks ${i}`);
    await assert.rejects(
      () => provider.embed(terlalu),
      /Batch embedding lokal dibatasi/u,
    );
  });

  // Pembatalan giliran harus terasa sebelum pekerjaan berat dimulai, bukan
  // sesudah ratusan megabita dimuat sia-sia.
  it("menghormati pembatalan sebelum memuat model", async () => {
    const provider = new LocalTextEmbeddingProvider({ model: "tidak/ada" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => provider.embed(["halo"], controller.signal));
  });

  // Route ini hidup secara bawaan, jadi mesin tanpa jaringan untuk unduhan
  // pertama akan mencoba memuat ratusan megabita pada SETIAP giliran yang
  // memakai pencarian makna. Tanpa pemutus arus, satu mesin offline membuat
  // setiap giliran tertahan, dan itu jauh lebih buruk daripada satu route yang
  // diam.
  it("berhenti mencoba sesudah gagal memuat berkali-kali", async () => {
    let sekarang = 0;
    const provider = new LocalTextEmbeddingProvider(
      { model: "tidak/pernah/ada" },
      () => sekarang,
    );

    let percobaan = 0;
    for (let i = 0; i < 3; i += 1) {
      await provider.embed(["halo"]).catch(() => {
        percobaan += 1;
      });
    }
    assert.equal(percobaan, 3);

    // Percobaan keempat ditolak tanpa menyentuh pustaka sama sekali.
    await assert.rejects(
      () => provider.embed(["halo"]),
      /sedang dijeda/u,
    );

    // Dan pulih sendiri sesudah jedanya lewat; kegagalan tidak permanen.
    sekarang += 11 * 60 * 1000;
    await assert.rejects(
      () => provider.embed(["halo"]),
      (error: Error) => !/sedang dijeda/u.test(error.message),
    );
  });
});
