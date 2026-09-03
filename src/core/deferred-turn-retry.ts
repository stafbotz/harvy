import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

/**
 * Mencoba ulang satu giliran yang gagal, di luar giliran itu sendiri.
 *
 * Ketika model tidak dapat dipakai, pesan penggunanya sudah tersimpan di
 * riwayat sebelum kalimat maaf dikirim. Meminta orangnya mengetik ulang berarti
 * menjadikan dia tombol coba-ulang untuk sesuatu yang Harvy sudah pegang.
 *
 * Dua percobaan di dalam giliran sudah ada dan menutup kelambatan sesaat. Yang
 * ditutup di sini berbeda: gangguan yang berlangsung puluhan detik, cukup lama
 * untuk menghabiskan kedua percobaan itu tetapi pulih jauh sebelum orangnya
 * sempat bertanya lagi.
 *
 * Tiga batas yang membuatnya aman, seluruhnya dituntut rancangan aslinya:
 *
 * - **Sekali saja.** Percobaan tertunda tidak menjadwalkan penerusnya. Provider
 *   yang benar-benar mati tidak boleh diulang tanpa henti.
 * - **Batal begitu penggunanya bicara lagi.** Pesan baru berarti percakapannya
 *   sudah bergerak, dan jawaban atas pesan lama justru mengganggu.
 * - **Satu per pemilik.** Jadwal baru menggantikan yang lama, sehingga
 *   kegagalan beruntun tidak menumpuk menjadi antrean.
 */
export const DEFERRED_RETRY_DELAY_MS = 30_000;

export class DeferredTurnRetry {
  private readonly pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; controller: AbortController }
  >();

  constructor(
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.deferred-retry"),
    private readonly delayMs: number = DEFERRED_RETRY_DELAY_MS,
    private readonly schedule: (
      run: () => void,
      ms: number,
    ) => ReturnType<typeof setTimeout> = setTimeout,
  ) {}

  /**
   * Menjadwalkan satu percobaan untuk pemilik ini, menggantikan yang tertunda.
   *
   * `run` menerima signal yang batal bila penggunanya bicara lagi selagi
   * percobaannya berjalan, sehingga jawaban basi tidak pernah terkirim.
   */
  arrange(ownerId: string, run: (signal: AbortSignal) => Promise<void>): void {
    this.cancel(ownerId);
    const controller = new AbortController();
    const timer = this.schedule(() => {
      this.pending.delete(ownerId);
      if (controller.signal.aborted) return;
      void run(controller.signal).catch((error: unknown) => {
        // Percobaan tertunda yang gagal berakhir diam.
        //
        // Kalimat maafnya sudah dikirim pada giliran aslinya. Mengirim yang
        // kedua hanya memberi tahu penggunanya bahwa Harvy mencoba lagi dan
        // gagal lagi—kabar yang tidak dapat ia pakai untuk apa pun.
        this.logger.info(
          "deferred_retry_failed",
          "Percobaan ulang tertunda gagal; tidak ada pesan kedua dikirim.",
          { errorType: error instanceof Error ? error.name : "unknown" },
        );
      });
    }, this.delayMs);
    timer.unref?.();
    this.pending.set(ownerId, { timer, controller });
    this.logger.info(
      "deferred_retry_arranged",
      "Percobaan ulang dijadwalkan di luar giliran.",
      { delayMs: this.delayMs },
    );
  }

  /** Dipanggil begitu pemiliknya mengirim pesan baru, dan saat mematikan. */
  cancel(ownerId: string): void {
    const entry = this.pending.get(ownerId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.controller.abort();
    this.pending.delete(ownerId);
  }

  cancelAll(): void {
    for (const ownerId of [...this.pending.keys()]) this.cancel(ownerId);
  }

  /** Hanya untuk pengujian dan pemeriksaan; bukan bagian dari kontrak runtime. */
  pendingCount(): number {
    return this.pending.size;
  }
}
