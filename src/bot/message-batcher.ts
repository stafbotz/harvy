import {
  guardTurnBoundary,
  idleWindowMs,
  INCOMPLETE_IDLE_MS,
  MULTI_BUBBLE_IDLE_MS,
  OPEN_IDLE_MS,
  type TurnBoundaryState,
} from "../core/turn-taking-policy.js";

/**
 * Satu giliran percakapan boleh datang sebagai beberapa bubble Telegram.
 *
 * Model murah memutuskan apakah kalimatnya tampak masih akan dilanjutkan.
 * Kalau iya, Harvy menunggu sebentar; bubble baru membatalkan keputusan lama
 * dan seluruh potongan diproses sebagai satu pesan logis.
 */
export interface MessageBatch<T> {
  text: string;
  carrier: T;
}

interface BatchEntry<T> {
  chunks: string[];
  carrier: T;
  revision: number;
  evaluationRequested: boolean;
  lastReceivedAt: number;
  settleTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_SETTLE_MS = 650;

export class MessageBatcher<T> {
  private readonly entries = new Map<string, BatchEntry<T>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly evaluations = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly classify: (text: string) => Promise<TurnBoundaryState>,
    private readonly handle: (
      ownerId: string,
      batch: MessageBatch<T>,
    ) => Promise<void>,
    private readonly maxWaitMs: number = INCOMPLETE_IDLE_MS,
    private readonly settleMs: number = DEFAULT_SETTLE_MS,
    private readonly openWaitMs: number = Math.min(OPEN_IDLE_MS, maxWaitMs),
    private readonly multiBubbleWaitMs: number = Math.min(
      MULTI_BUBBLE_IDLE_MS,
      maxWaitMs,
    ),
  ) {}

  /**
   * Menampung bubble lalu langsung mengembalikan kendali ke adapter Telegram.
   *
   * grammY long-polling memproses update secara berurutan. Kalau metode ini
   * menunggu model atau balasan, update bubble berikutnya belum dapat masuk.
   */
  enqueue(ownerId: string, text: string, carrier: T): void {
    const now = Date.now();
    const existing = this.entries.get(ownerId);
    if (existing) clearTimers(existing);

    const entry: BatchEntry<T> = existing ?? {
      chunks: [],
      carrier,
      revision: 0,
      evaluationRequested: false,
      lastReceivedAt: now,
      settleTimer: null,
      deadlineTimer: null,
    };

    entry.chunks.push(text);
    entry.carrier = carrier;
    entry.revision += 1;
    entry.evaluationRequested = false;
    entry.lastReceivedAt = now;
    this.entries.set(ownerId, entry);

    const revision = entry.revision;
    // Bahaya segera yang sudah dapat dikenali secara lokal tidak boleh
    // menunggu debounce maupun jaringan. Model tetap menilai kasus yang lebih
    // samar pada jalur biasa.
    if (
      guardTurnBoundary(entry.chunks.join("\n"), "complete") === "urgent"
    ) {
      void this.flush(ownerId, revision).catch((error: unknown) => {
        console.error("Kumpulan bubble darurat gagal diproses:", error);
      });
      return;
    }

    entry.settleTimer = setTimeout(() => {
      entry.settleTimer = null;
      void this.evaluate(ownerId, revision).catch((error: unknown) => {
        console.error("Keputusan kumpulan bubble gagal diproses:", error);
      });
    }, this.settleMs);
    entry.settleTimer.unref?.();

    // Fail-safe terpanjang dimulai dari bubble terakhir, bukan setelah model
    // selesai. Keputusan complete/open dapat memajukan timer ini; fragmen keras
    // boleh memakai seluruh jendela.
    entry.deadlineTimer = setTimeout(() => {
      entry.deadlineTimer = null;
      void this.flush(ownerId, revision).catch((error: unknown) => {
        console.error("Kumpulan bubble gagal diproses:", error);
      });
    }, this.maxWaitMs);
    entry.deadlineTimer.unref?.();
  }

  clear(ownerId: string): void {
    const entry = this.entries.get(ownerId);
    if (entry) clearTimers(entry);
    this.entries.delete(ownerId);
    this.cleanupOwner(ownerId);
  }

  /**
   * Membatalkan bubble yang belum diproses lalu menunggu handler lama selesai.
   *
   * Command memakai barrier ini supaya balasan lama tidak muncul setelah
   * `/start` atau `/tugas`, dan supaya mutasi lama tidak menyusul reset.
   */
  async cancelAndWait(ownerId: string): Promise<void> {
    this.cancelPending(ownerId);
    await this.waitForIdle(ownerId);
    this.cleanupOwner(ownerId);
  }

  /**
   * Membatalkan bubble tertunda lalu mengantrekan aksi tanpa menahan polling.
   *
   * Handler grammY harus dapat kembali segera. Aksi tetap menunggu chain milik
   * pengguna yang sama, tetapi tidak memblokir update pengguna lain.
   */
  cancelAndEnqueue(ownerId: string, action: () => Promise<void>): void {
    this.cancelPending(ownerId);
    this.enqueueBackground(ownerId, action, "Aksi setelah pembatalan gagal:");
  }

  /**
   * Memproses bubble yang sudah lebih dulu tiba dan menunggu seluruh chain.
   *
   * Tombol memakai ini agar tindakan seperti Lupakan semua menjadi operasi
   * terakhir; handler percakapan lama tidak boleh menghidupkan data kembali.
   */
  async drain(ownerId: string): Promise<void> {
    const entry = this.entries.get(ownerId);
    if (entry) {
      try {
        await this.flush(ownerId, entry.revision);
      } catch (error) {
        console.error("Kumpulan bubble gagal sebelum tindakan tombol:", error);
      }
    }
    await this.waitForIdle(ownerId);
  }

  /**
   * Menguras bubble terdahulu lalu mengantrekan aksi tanpa menahan polling.
   *
   * `flush` memasang handler pada chain secara sinkron sebelum await pertama,
   * sehingga aksi yang langsung diantrekan sesudahnya pasti berada di belakang
   * batch tersebut.
   */
  drainAndEnqueue(ownerId: string, action: () => Promise<void>): void {
    const entry = this.entries.get(ownerId);
    if (entry) {
      void this.flush(ownerId, entry.revision).catch((error: unknown) => {
        console.error("Kumpulan bubble gagal sebelum tindakan berikutnya:", error);
      });
    }
    this.enqueueBackground(ownerId, action, "Tindakan setelah bubble gagal:");
  }

  /**
   * Menguras seluruh pemilik ketika proses berhenti secara normal.
   *
   * Loop menangkap pekerjaan baru yang mungkin dipasang oleh chain yang sedang
   * selesai. Setelah polling dihentikan tidak ada update baru, jadi himpunan ini
   * akhirnya kosong.
   */
  async drainAll(): Promise<void> {
    while (
      this.entries.size > 0 ||
      this.chains.size > 0 ||
      this.evaluations.size > 0
    ) {
      const owners = new Set([
        ...this.entries.keys(),
        ...this.chains.keys(),
        ...this.evaluations.keys(),
      ]);
      await Promise.all(
        [...owners].map(async (ownerId) => {
          await this.drain(ownerId);
          const evaluation = this.evaluations.get(ownerId);
          if (evaluation) {
            try {
              await evaluation;
            } catch {
              // Pemanggil timer sudah mencatat kegagalan evaluator.
            }
          }
        }),
      );
    }
  }

  private evaluate(ownerId: string, revision: number): Promise<void> {
    const entry = this.entries.get(ownerId);
    if (!entry || entry.revision !== revision) return Promise.resolve();

    // Satu pemilik hanya boleh punya satu request batas giliran. Jika timer
    // bubble terbaru berbunyi saat request lama masih berjalan, cukup tandai
    // revisi terbaru untuk dinilai setelahnya.
    const active = this.evaluations.get(ownerId);
    if (active) {
      entry.evaluationRequested = true;
      return active;
    }

    const running = this.runEvaluation(ownerId, revision);
    this.evaluations.set(ownerId, running);
    void running.then(
      () => this.releaseEvaluation(ownerId, running),
      () => this.releaseEvaluation(ownerId, running),
    );
    return running;
  }

  private async runEvaluation(
    ownerId: string,
    revision: number,
  ): Promise<void> {
    let targetRevision = revision;

    while (true) {
      const evaluated = this.entries.get(ownerId);
      if (!evaluated || evaluated.revision !== targetRevision) return;
      evaluated.evaluationRequested = false;

      let state: TurnBoundaryState = "complete";
      try {
        state = await this.classify(evaluated.chunks.join("\n"));
      } catch (error) {
        // Keputusan ini hanya optimasi UX. Kalau model cepat gagal, pesan
        // tetap harus diproses.
        console.warn(
          "Pemeriksaan sambungan bubble gagal, diproses sekarang:",
          error,
        );
      }

      const current = this.entries.get(ownerId);
      if (current === evaluated && current.revision === targetRevision) {
        const guarded = guardTurnBoundary(
          evaluated.chunks.join("\n"),
          state,
        );
        const waitMs = Math.min(
          this.maxWaitMs,
          idleWindowMs(guarded, evaluated.chunks.length, {
            openMs: this.openWaitMs,
            incompleteMs: this.maxWaitMs,
            multiBubbleMs: this.multiBubbleWaitMs,
          }),
        );
        this.scheduleDeadline(ownerId, evaluated, targetRevision, waitMs);
        return;
      }

      // Bubble baru mungkin sudah melewati settle timer ketika request lama
      // selesai. Nilai hanya revisi terbaru itu; revisi perantara dilewati.
      const latest = this.entries.get(ownerId);
      if (!latest?.evaluationRequested) return;
      targetRevision = latest.revision;
    }
  }

  private async flush(ownerId: string, revision: number): Promise<void> {
    const entry = this.entries.get(ownerId);
    if (!entry || entry.revision !== revision) return;

    clearTimers(entry);
    this.entries.delete(ownerId);

    const batch: MessageBatch<T> = {
      text: entry.chunks.join("\n"),
      carrier: entry.carrier,
    };
    const generation = this.generation(ownerId);

    // Satu pengguna diproses berurutan. Bubble baru boleh dikumpulkan ketika
    // balasan lama sedang dibuat, tetapi konteksnya baru dibaca setelah giliran
    // sebelumnya selesai sehingga riwayat tidak saling menyalip.
    await this.enqueueAction(ownerId, async () => {
      // `/start` atau `/bantuan` dapat datang ketika batch ini sudah masuk
      // chain tetapi belum mulai. Generasi baru membatalkannya tanpa memutus
      // handler yang memang sudah aktif.
      if (this.generation(ownerId) !== generation) return;
      await this.handle(ownerId, batch);
    });
  }

  private scheduleDeadline(
    ownerId: string,
    entry: BatchEntry<T>,
    revision: number,
    idleMs: number,
  ): void {
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);

    const elapsed = Date.now() - entry.lastReceivedAt;
    const remaining = Math.max(0, idleMs - elapsed);
    if (remaining === 0) {
      entry.deadlineTimer = null;
      void this.flush(ownerId, revision).catch((error: unknown) => {
        console.error("Kumpulan bubble gagal diproses:", error);
      });
      return;
    }

    entry.deadlineTimer = setTimeout(() => {
      entry.deadlineTimer = null;
      void this.flush(ownerId, revision).catch((error: unknown) => {
        console.error("Kumpulan bubble gagal diproses:", error);
      });
    }, remaining);
    entry.deadlineTimer.unref?.();
  }

  private async waitForIdle(ownerId: string): Promise<void> {
    const active = this.chains.get(ownerId);
    if (!active) return;

    try {
      await active;
    } catch (error) {
      // Command/tombol yang datang sesudahnya tetap harus dapat diproses.
      console.error("Giliran percakapan sebelumnya gagal:", error);
    }
  }

  private enqueueBackground(
    ownerId: string,
    action: () => Promise<void>,
    errorMessage: string,
  ): void {
    void this.enqueueAction(ownerId, action).catch((error: unknown) => {
      console.error(errorMessage, error);
    });
  }

  private enqueueAction(
    ownerId: string,
    action: () => Promise<void>,
  ): Promise<void> {
    const previous = this.chains.get(ownerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.chains.set(ownerId, next);

    // Cleanup dipasang dengan dua cabang agar promise turunannya tidak
    // menghasilkan rejection yang tidak tertangani.
    void next.then(
      () => this.release(ownerId, next),
      () => this.release(ownerId, next),
    );
    return next;
  }

  private release(ownerId: string, chain: Promise<void>): void {
    if (this.chains.get(ownerId) === chain) {
      this.chains.delete(ownerId);
      this.cleanupOwner(ownerId);
    }
  }

  private cancelPending(ownerId: string): void {
    this.clear(ownerId);
    this.generations.set(ownerId, this.generation(ownerId) + 1);
  }

  private generation(ownerId: string): number {
    return this.generations.get(ownerId) ?? 0;
  }

  private releaseEvaluation(
    ownerId: string,
    evaluation: Promise<void>,
  ): void {
    if (this.evaluations.get(ownerId) === evaluation) {
      this.evaluations.delete(ownerId);
      this.cleanupOwner(ownerId);
    }
  }

  private cleanupOwner(ownerId: string): void {
    if (
      !this.entries.has(ownerId) &&
      !this.chains.has(ownerId) &&
      !this.evaluations.has(ownerId)
    ) {
      this.generations.delete(ownerId);
    }
  }
}

function clearTimers<T>(entry: BatchEntry<T>): void {
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
  entry.settleTimer = null;
  entry.deadlineTimer = null;
}
