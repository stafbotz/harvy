import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeferredTurnRetry } from "../src/core/deferred-turn-retry.js";

/**
 * Percobaan ulang di luar giliran.
 *
 * Ketika model tidak dapat dipakai, pesan penggunanya sudah tersimpan sebelum
 * kalimat maaf dikirim. Meminta orangnya mengetik ulang berarti menjadikan dia
 * tombol coba-ulang untuk sesuatu yang Harvy sudah pegang.
 *
 * Yang diuji di sini adalah ketiga batas yang membuatnya aman, bukan
 * kecepatannya. Timer disuntikkan supaya tesnya tidak menunggu setengah menit.
 */
describe("percobaan ulang tertunda", () => {
  interface Jadwal {
    run: () => void;
    ms: number;
  }

  function penjadwal(sink: Jadwal[]) {
    return (run: () => void, ms: number) => {
      sink.push({ run, ms });
      return { unref: () => undefined } as unknown as ReturnType<
        typeof setTimeout
      >;
    };
  }

  it("menjalankan percobaan sesudah jedanya", async () => {
    const jadwal: Jadwal[] = [];
    const retry = new DeferredTurnRetry(undefined, 30_000, penjadwal(jadwal));
    let dijalankan = 0;

    retry.arrange("1", async () => {
      dijalankan += 1;
    });

    assert.equal(jadwal.length, 1);
    assert.equal(jadwal[0]?.ms, 30_000);
    assert.equal(dijalankan, 0, "belum jalan sebelum jedanya lewat");

    jadwal[0]!.run();
    await Promise.resolve();
    assert.equal(dijalankan, 1);
  });

  // Pesan baru berarti percakapannya sudah bergerak, dan jawaban atas pesan
  // lama justru mengganggu.
  it("batal ketika penggunanya bicara lagi", async () => {
    const jadwal: Jadwal[] = [];
    const retry = new DeferredTurnRetry(undefined, 30_000, penjadwal(jadwal));
    let dijalankan = 0;

    retry.arrange("1", async () => {
      dijalankan += 1;
    });
    retry.cancel("1");
    jadwal[0]!.run();
    await Promise.resolve();

    assert.equal(dijalankan, 0);
    assert.equal(retry.pendingCount(), 0);
  });

  // Kegagalan beruntun tidak boleh menumpuk menjadi antrean percobaan.
  it("menyisakan satu jadwal per pemilik", () => {
    const jadwal: Jadwal[] = [];
    const retry = new DeferredTurnRetry(undefined, 30_000, penjadwal(jadwal));

    retry.arrange("1", async () => undefined);
    retry.arrange("1", async () => undefined);
    retry.arrange("2", async () => undefined);

    assert.equal(retry.pendingCount(), 2);
  });

  // Percobaan tertunda yang gagal berakhir diam: kalimat maafnya sudah dikirim
  // pada giliran aslinya, dan yang kedua tidak dapat dipakai penggunanya untuk
  // apa pun.
  it("tidak melempar ketika percobaannya gagal", async () => {
    const jadwal: Jadwal[] = [];
    const retry = new DeferredTurnRetry(undefined, 30_000, penjadwal(jadwal));

    retry.arrange("1", async () => {
      throw new Error("provider masih tumbang");
    });

    assert.doesNotThrow(() => jadwal[0]!.run());
    await Promise.resolve();
    await Promise.resolve();
  });

  it("membersihkan seluruh jadwal saat Harvy ditutup", () => {
    const jadwal: Jadwal[] = [];
    const retry = new DeferredTurnRetry(undefined, 30_000, penjadwal(jadwal));

    retry.arrange("1", async () => undefined);
    retry.arrange("2", async () => undefined);
    retry.cancelAll();

    assert.equal(retry.pendingCount(), 0);
  });

  // Signal-nya yang membuat percobaan berhenti di tengah jalan bila pesan baru
  // datang justru selagi ia berjalan.
  it("memberi signal yang batal bersama jadwalnya", async () => {
    const jadwal: Jadwal[] = [];
    const retry = new DeferredTurnRetry(undefined, 30_000, penjadwal(jadwal));
    let terlihat: AbortSignal | null = null;

    retry.arrange("1", async (signal) => {
      terlihat = signal;
    });
    jadwal[0]!.run();
    await Promise.resolve();

    assert.ok(terlihat);
    assert.equal((terlihat as unknown as AbortSignal).aborted, false);
  });
});
