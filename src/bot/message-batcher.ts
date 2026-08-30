import {
  assessmentIdleWindowMs,
  assessTurnBoundaryLocally,
  boundaryConfidenceBucket,
  guardTurnBoundaryAssessment,
  INCOMPLETE_IDLE_MS,
  MULTI_BUBBLE_IDLE_MS,
  normalizeTurnBoundaryAssessment,
  OPEN_IDLE_MS,
  type TurnBoundaryAssessment,
  type TurnBoundaryProposal,
  type TurnBoundarySignals,
  type TurnInterruptionRelation,
} from "../core/turn-taking-policy.js";
import { hasExplicitImmediateDangerSignal } from "../core/safety-policy.js";
import { AdaptiveDebouncePolicy } from "../core/adaptive-debounce-policy.js";
import { randomUUID } from "node:crypto";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

/**
 * Satu giliran percakapan boleh datang sebagai beberapa bubble transport.
 *
 * Kebijakan lokal menangani bentuk yang jelas. Classifier murah hanya menjadi
 * fallback untuk ambiguitas; bubble baru membatalkan keputusan lama dan
 * seluruh potongan diproses sebagai satu pesan logis.
 */
export interface MessageBatch<T> {
  text: string;
  /** Ada bubble yang secara mandiri lolos matcher bahaya eksplisit lokal. */
  explicitImmediateDanger: boolean;
  /** Fallback boundary menilai turn perlu triase segera. */
  urgentBoundary: boolean;
  carrier: T;
  /** Korelasi acak satu giliran dari boundary sampai delivery. */
  turnId: string;
  /** Sequence bubble pertama; seluruh batch harus lebih baru dari prompt. */
  firstIngressSequence: number | null;
  /** Dibatalkan ketika command atau giliran urgent menggantikan run aktif. */
  signal: AbortSignal;
  /** Guard generasi adapter; hasil lama tidak boleh dikirim atau commit. */
  isCurrent: () => boolean;
  /** Menunggu assessment pesan baru sebelum efek/delivery berikutnya. */
  awaitCurrent: () => Promise<boolean>;
  /** Dipanggil sesudah user turn durable agar restart tidak menduplikasi teks. */
  markUserCommitted: () => void;
  /** Hubungan dengan run yang digantikan, bila ada. */
  interruptionRelation: TurnInterruptionRelation | null;
  /**
   * Kapan bubble pertama giliran ini tiba.
   *
   * Diukur sebelum jendela batching, sehingga jarak ke balasan sebelumnya
   * mencerminkan jeda pengguna yang sebenarnya—bukan jeda itu ditambah
   * waktu tunggu Harvy sendiri.
   */
  firstReceivedAt: number;
}

export interface MessageBatchMetrics {
  ownerId: string;
  turnId: string;
  outcome: "completed" | "failed" | "cancelled";
  bubbleCount: number;
  batchWaitMs: number;
  queueWaitMs: number;
  handlingLatencyMs: number;
  totalLatencyMs: number;
  boundaryState?: TurnBoundaryAssessment["state"];
  boundaryConfidence?: "low" | "medium" | "high";
  adaptiveTimingUsed?: boolean;
  interruptionRelation?: TurnInterruptionRelation | null;
}

interface BatchEntry<T> {
  chunks: string[];
  explicitImmediateDanger: boolean;
  urgentBoundary: boolean;
  carrier: T;
  turnId: string;
  firstIngressSequence: number | null;
  firstReceivedAt: number;
  revision: number;
  evaluationRequested: boolean;
  urgentAcknowledged: boolean;
  lastReceivedAt: number;
  settleTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  boundaryAssessment: TurnBoundaryAssessment | null;
  adaptiveTimingUsed: boolean;
  interruptionRelation: TurnInterruptionRelation | null;
  supersededTurnIds: Set<string>;
  pendingRelations: Set<Promise<void>>;
}

interface ActiveRun {
  generation: number;
  controller: AbortController;
  text: string;
  turnId: string;
  userCommitted: boolean;
  pendingRelations: Set<Promise<void>>;
}

const DEFAULT_SETTLE_MS = 650;

export class MessageBatcher<T> {
  private readonly entries = new Map<string, BatchEntry<T>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly evaluations = new Map<string, Promise<void>>();
  private readonly interruptionTasks = new Set<Promise<void>>();
  private readonly generations = new Map<string, number>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private urgentHandler:
    | ((ownerId: string, batch: MessageBatch<T>) => Promise<void>)
    | undefined;

  constructor(
    private readonly classifyAmbiguous: (
      text: string,
      ownerId?: string,
      turnId?: string,
      signals?: TurnBoundarySignals,
    ) => Promise<TurnBoundaryProposal>,
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
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("conversation.message-batcher"),
    private readonly observeTurn?: (
      metrics: MessageBatchMetrics,
    ) => Promise<void> | void,
    private readonly adaptiveDebounce = new AdaptiveDebouncePolicy({
      minDelayMs: Math.min(Math.max(1, settleMs), 300),
      maxDelayMs: Math.max(
        Math.min(Math.max(1, settleMs), 300),
        Math.min(2_500, Math.max(1, maxWaitMs)),
      ),
      maxGapMs: Math.max(1, maxWaitMs),
    }),
    private readonly classifyInterruption?: (
      activeText: string,
      incomingText: string,
      ownerId: string,
      turnId: string,
    ) => Promise<TurnInterruptionRelation>,
  ) {}

  /**
   * Memasang acknowledgment out-of-band untuk keadaan `urgent`.
   *
   * Handler lengkap tetap memakai chain pemilik agar mutasi dan riwayat tidak
   * saling menyalip. Acknowledgment ini hanya pesan aman tanpa mutasi, sehingga
   * boleh dikirim segera saat chain lama masih bekerja.
   */
  onUrgent(
    handler: (ownerId: string, batch: MessageBatch<T>) => Promise<void>,
  ): this {
    this.urgentHandler = handler;
    return this;
  }

  /**
   * Menampung bubble lalu langsung mengembalikan kendali ke adapter transport.
   *
   * grammY long-polling memproses update secara berurutan. Kalau metode ini
   * menunggu model atau balasan, update bubble berikutnya belum dapat masuk.
   */
  enqueue(
    ownerId: string,
    text: string,
    carrier: T,
    ingressSequence?: number,
  ): void {
    const now = Date.now();
    this.adaptiveDebounce.observeArrival(ownerId, now);
    const existing = this.entries.get(ownerId);
    if (existing) clearTimers(existing);

    const entry: BatchEntry<T> = existing ?? {
      chunks: [],
      explicitImmediateDanger: false,
      urgentBoundary: false,
      carrier,
      turnId: randomUUID(),
      firstIngressSequence:
        Number.isSafeInteger(ingressSequence) ? ingressSequence! : null,
      firstReceivedAt: now,
      revision: 0,
      evaluationRequested: false,
      urgentAcknowledged: false,
      lastReceivedAt: now,
      settleTimer: null,
      deadlineTimer: null,
      boundaryAssessment: null,
      adaptiveTimingUsed: false,
      interruptionRelation: null,
      supersededTurnIds: new Set<string>(),
      pendingRelations: new Set<Promise<void>>(),
    };

    entry.chunks.push(text);
    // Nilai tiap bubble secara mandiri. Marker konteks pada bubble lama tidak
    // boleh memveto sinyal darurat eksplisit pada bubble terbaru ketika teks
    // batch kemudian digabung untuk pemahaman penuh.
    entry.explicitImmediateDanger ||= hasExplicitImmediateDangerSignal(text);
    entry.carrier = carrier;
    if (
      entry.firstIngressSequence === null &&
      Number.isSafeInteger(ingressSequence)
    ) {
      entry.firstIngressSequence = ingressSequence!;
    }
    entry.revision += 1;
    entry.evaluationRequested = false;
    entry.boundaryAssessment = null;
    entry.lastReceivedAt = now;
    this.entries.set(ownerId, entry);
    this.logger.debug(
      "bubble_enqueued",
      "Bubble masuk ke penampung giliran percakapan.",
      { bubbleCount: entry.chunks.length },
    );

    const revision = entry.revision;
    if (entry.explicitImmediateDanger) {
      this.acknowledgeUrgent(ownerId, entry);
      this.scheduleDeadline(ownerId, entry, revision, 0);
      return;
    }

    const active = this.activeRuns.get(ownerId);
    let assessingInterruption = false;
    if (
      active &&
      active.generation === this.generation(ownerId) &&
      this.classifyInterruption
    ) {
      assessingInterruption = true;
      this.startInterruptionAssessment(ownerId, active, entry);
    }

    const adaptiveTiming = this.adaptiveDebounce.estimate(
      ownerId,
      this.settleMs,
    );
    entry.adaptiveTimingUsed ||= adaptiveTiming.adaptive;
    const local = assessTurnBoundaryLocally(entry.chunks.join("\n"));
    if (local?.state === "complete" && !assessingInterruption) {
      entry.boundaryAssessment = local;
      this.scheduleDeadline(ownerId, entry, revision, 0);
      return;
    }
    if (local?.state === "incomplete") {
      entry.boundaryAssessment = local;
      this.scheduleDeadline(ownerId, entry, revision, this.maxWaitMs);
      return;
    }
    entry.settleTimer = setTimeout(() => {
      entry.settleTimer = null;
      void this.evaluate(ownerId, revision).catch((error: unknown) => {
        this.logger.error(
          "turn_boundary_evaluation_failed",
          "Keputusan kumpulan bubble gagal diproses.",
          error,
        );
      });
    }, Math.min(this.maxWaitMs, adaptiveTiming.settleMs));
    entry.settleTimer.unref?.();

    // Fail-safe terpanjang dimulai dari bubble terakhir, bukan setelah model
    // selesai. Keputusan complete/open dapat memajukan timer ini; fragmen keras
    // boleh memakai seluruh jendela.
    entry.deadlineTimer = setTimeout(() => {
      entry.deadlineTimer = null;
      void this.flush(ownerId, revision).catch((error: unknown) => {
        this.logger.error(
          "message_batch_failed",
          "Kumpulan bubble gagal diproses.",
          error,
        );
      });
    }, this.maxWaitMs);
    entry.deadlineTimer.unref?.();
  }

  clear(ownerId: string): void {
    const entry = this.entries.get(ownerId);
    if (entry) {
      clearTimers(entry);
      const endedAt = Date.now();
      this.notifyTurn({
        ownerId,
        turnId: entry.turnId,
        outcome: "cancelled",
        bubbleCount: entry.chunks.length,
        batchWaitMs: endedAt - entry.firstReceivedAt,
        queueWaitMs: 0,
        handlingLatencyMs: 0,
        totalLatencyMs: endedAt - entry.firstReceivedAt,
      });
    }
    this.entries.delete(ownerId);
    this.adaptiveDebounce.forget(ownerId);
    this.cleanupOwner(ownerId);
  }

  /** Membatalkan state tertunda tanpa menunggu chain yang sedang memanggilnya. */
  invalidate(ownerId: string): void {
    this.cancelPending(ownerId);
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
    this.enqueueBackground(
      ownerId,
      action,
      "post_cancel_action_failed",
      "Aksi setelah pembatalan gagal.",
    );
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
        this.logger.error(
          "pre_callback_batch_failed",
          "Kumpulan bubble gagal sebelum tindakan tombol.",
          error,
        );
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
        this.logger.error(
          "pre_action_batch_failed",
          "Kumpulan bubble gagal sebelum tindakan berikutnya.",
          error,
        );
      });
    }
    this.enqueueBackground(
      ownerId,
      action,
      "post_batch_action_failed",
      "Tindakan setelah bubble gagal.",
    );
  }

  /**
   * Varian yang dapat ditunggu oleh worker internal.
   *
   * Aksi dijalankan pada chain pemilik yang sama, sehingga pesan terjadwal
   * tidak menyelip di tengah balasan dan penghapusan data tetap mempunyai
   * urutan yang tegas.
   */
  async drainAndRun(
    ownerId: string,
    action: () => Promise<void>,
  ): Promise<void> {
    const entry = this.entries.get(ownerId);
    if (entry) {
      void this.flush(ownerId, entry.revision).catch((error: unknown) => {
        this.logger.error(
          "pre_worker_batch_failed",
          "Kumpulan bubble gagal sebelum worker.",
          error,
        );
      });
    }
    await this.enqueueAction(ownerId, action);
  }

  /**
   * Menjalankan kiriman terjadwal hanya bila pengguna benar-benar sedang idle.
   *
   * Berbeda dari callback, worker tidak boleh memaksa bubble yang masih
   * terbuka segera diproses. `false` meminta worker mencoba lagi nanti.
   */
  async runWhenIdle(
    ownerId: string,
    action: () => Promise<void>,
  ): Promise<boolean> {
    if (
      this.entries.has(ownerId) ||
      this.chains.has(ownerId) ||
      this.evaluations.has(ownerId)
    ) {
      return false;
    }

    await this.enqueueAction(ownerId, action);
    return true;
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
      this.evaluations.size > 0 ||
      this.interruptionTasks.size > 0
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
      if (this.interruptionTasks.size > 0) {
        await Promise.allSettled([...this.interruptionTasks]);
      }
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

      const text = evaluated.chunks.join("\n");
      const adaptiveTiming = this.adaptiveDebounce.estimate(
        ownerId,
        this.settleMs,
      );
      evaluated.adaptiveTimingUsed ||= adaptiveTiming.adaptive;
      const signals: TurnBoundarySignals = {
        bubbleCount: evaluated.chunks.length,
        adaptiveTimingUsed: adaptiveTiming.adaptive,
        learnedSettleMs: adaptiveTiming.settleMs,
        rapidBurst: evaluated.chunks.length > 1 &&
          Date.now() - evaluated.firstReceivedAt <=
            Math.max(1_500, adaptiveTiming.settleMs * evaluated.chunks.length),
      };
      let assessment: TurnBoundaryAssessment | null =
        evaluated.explicitImmediateDanger
          ? normalizeTurnBoundaryAssessment("urgent")
          : assessTurnBoundaryLocally(text);
      if (assessment === null) {
        // Gagal menilai ambiguitas harus memberi ruang kecil, bukan memotong
        // pengguna seolah complete telah terbukti.
        assessment = Object.freeze({
          state: "open",
          confidence: 0,
          continuationLikelihood: 0.65,
          reasonClass: "uncertain",
        });
        try {
          assessment = normalizeTurnBoundaryAssessment(
            await this.classifyAmbiguous(
              text,
              ownerId,
              evaluated.turnId,
              signals,
            ),
          );
        } catch (error) {
          // Fail-safe timer tetap memastikan pesan akhirnya diproses.
          this.logger.warn(
            "turn_boundary_check_failed",
            "Assessment batas bubble gagal; giliran diberi ruang fail-safe.",
            { error },
          );
        }
      }

      const current = this.entries.get(ownerId);
      if (current === evaluated && current.revision === targetRevision) {
        const guarded = guardTurnBoundaryAssessment(
          text,
          assessment,
        );
        evaluated.boundaryAssessment = guarded;
        if (guarded.state === "urgent") {
          evaluated.urgentBoundary = true;
          this.acknowledgeUrgent(ownerId, evaluated);
        }
        const learnedSettleMs = adaptiveTiming.settleMs;
        const multiBubbleMs = adaptiveTiming.adaptive
          ? Math.min(
              this.maxWaitMs,
              Math.max(this.multiBubbleWaitMs, learnedSettleMs),
            )
          : this.multiBubbleWaitMs;
        const waitMs = Math.min(
          this.maxWaitMs,
          assessmentIdleWindowMs(guarded, evaluated.chunks.length, {
            // Pembuka/narasi dan fragmen keras membawa makna, bukan sekadar
            // ritme ketik. Sampai telemetry membuktikan window yang lebih
            // pendek aman, adaptive profile hanya mengubah debounce awal dan
            // ruang gabungan bubble yang sudah lengkap.
            openMs: this.openWaitMs,
            incompleteMs: this.maxWaitMs,
            multiBubbleMs,
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

    const generation = this.generation(ownerId);
    const queuedAt = Date.now();

    // Satu pengguna diproses berurutan. Bubble baru boleh dikumpulkan ketika
    // balasan lama sedang dibuat, tetapi konteksnya baru dibaca setelah giliran
    // sebelumnya selesai sehingga riwayat tidak saling menyalip.
    await this.enqueueAction(ownerId, async () => {
      await this.awaitRelationTasks(entry.pendingRelations);
      const handlingStartedAt = Date.now();
      // `/start` atau `/bantuan` dapat datang ketika batch ini sudah masuk
      // chain tetapi belum mulai. Generasi baru membatalkannya tanpa memutus
      // pekerjaan deterministik yang tidak mengamati signal.
      if (this.generation(ownerId) !== generation) {
        this.notifyTurn({
          ownerId,
          turnId: entry.turnId,
          outcome: "cancelled",
          bubbleCount: entry.chunks.length,
          batchWaitMs: queuedAt - entry.firstReceivedAt,
          queueWaitMs: handlingStartedAt - queuedAt,
          handlingLatencyMs: 0,
          totalLatencyMs: handlingStartedAt - entry.firstReceivedAt,
        });
        return;
      }
      const controller = new AbortController();
      const active: ActiveRun = {
        generation,
        controller,
        text: entry.chunks.join("\n"),
        turnId: entry.turnId,
        userCommitted: false,
        pendingRelations: new Set<Promise<void>>(),
      };
      this.activeRuns.set(ownerId, active);
      const runtimeBatch: MessageBatch<T> = {
        text: active.text,
        explicitImmediateDanger: entry.explicitImmediateDanger,
        urgentBoundary: entry.urgentBoundary,
        carrier: entry.carrier,
        turnId: entry.turnId,
        firstIngressSequence: entry.firstIngressSequence,
        signal: controller.signal,
        isCurrent: () =>
          !controller.signal.aborted &&
          this.generation(ownerId) === generation &&
          this.activeRuns.get(ownerId) === active,
        awaitCurrent: () => this.awaitActiveCurrent(ownerId, active),
        markUserCommitted: () => {
          active.userCommitted = true;
        },
        interruptionRelation: entry.interruptionRelation,
        firstReceivedAt: entry.firstReceivedAt,
      };
      let outcome: MessageBatchMetrics["outcome"] = "completed";
      try {
        await this.handle(ownerId, runtimeBatch);
        if (controller.signal.aborted) outcome = "cancelled";
      } catch (error) {
        outcome = controller.signal.aborted ? "cancelled" : "failed";
        throw error;
      } finally {
        if (this.activeRuns.get(ownerId) === active) {
          this.activeRuns.delete(ownerId);
        }
        const endedAt = Date.now();
        const metrics: MessageBatchMetrics = {
          ownerId,
          turnId: entry.turnId,
          outcome,
          bubbleCount: entry.chunks.length,
          batchWaitMs: queuedAt - entry.firstReceivedAt,
          queueWaitMs: handlingStartedAt - queuedAt,
          handlingLatencyMs: endedAt - handlingStartedAt,
          totalLatencyMs: endedAt - entry.firstReceivedAt,
          ...(entry.boundaryAssessment
            ? {
                boundaryState: entry.boundaryAssessment.state,
                boundaryConfidence: boundaryConfidenceBucket(
                  entry.boundaryAssessment.confidence,
                ),
              }
            : {}),
          adaptiveTimingUsed: entry.adaptiveTimingUsed,
          interruptionRelation: entry.interruptionRelation,
        };
        this.logger.info(
          "conversation_turn_completed",
          "Giliran percakapan selesai diproses.",
          {
            bubbleCount: metrics.bubbleCount,
            batchWaitMs: metrics.batchWaitMs,
            queueWaitMs: metrics.queueWaitMs,
            handlingLatencyMs: metrics.handlingLatencyMs,
            durationMs: metrics.totalLatencyMs,
            outcome: metrics.outcome,
            boundaryState: metrics.boundaryState,
            boundaryConfidence: metrics.boundaryConfidence,
            adaptiveTimingUsed: metrics.adaptiveTimingUsed,
            interruptionRelation: metrics.interruptionRelation,
          },
        );
        this.notifyTurn(metrics);
      }
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
        this.logger.error(
          "message_batch_failed",
          "Kumpulan bubble gagal diproses.",
          error,
        );
      });
      return;
    }

    entry.deadlineTimer = setTimeout(() => {
      entry.deadlineTimer = null;
      void this.flush(ownerId, revision).catch((error: unknown) => {
        this.logger.error(
          "message_batch_failed",
          "Kumpulan bubble gagal diproses.",
          error,
        );
      });
    }, remaining);
    entry.deadlineTimer.unref?.();
  }

  private acknowledgeUrgent(ownerId: string, entry: BatchEntry<T>): void {
    // ACK boleh mendahului FIFO, dan run agent lama harus berhenti agar tidak
    // menyelipkan balasan biasa sebelum giliran keselamatan diproses.
    if (entry.urgentAcknowledged) return;
    entry.urgentAcknowledged = true;
    // Batch biasa yang sudah menunggu di chain membawa generation lama dan
    // akan berhenti sebelum handler. Giliran urgent sendiri baru menangkap
    // generation baru ketika `flush` dipanggil setelah metode ini.
    this.generations.set(ownerId, this.generation(ownerId) + 1);
    this.abortActive(ownerId);
    if (!this.urgentHandler) return;
    const controller = new AbortController();
    const batch = {
      text: entry.chunks.join("\n"),
      explicitImmediateDanger: entry.explicitImmediateDanger,
      urgentBoundary: entry.urgentBoundary,
      carrier: entry.carrier,
      turnId: entry.turnId,
      firstIngressSequence: entry.firstIngressSequence,
      signal: controller.signal,
      isCurrent: () => true,
      awaitCurrent: async () => true,
      markUserCommitted: () => undefined,
      interruptionRelation: null,
      firstReceivedAt: entry.firstReceivedAt,
    };
    void this.urgentHandler(ownerId, batch).catch((error: unknown) => {
      this.logger.error(
        "urgent_acknowledgment_failed",
        "Acknowledgment keselamatan gagal dikirim.",
        error,
      );
    });
  }

  private startInterruptionAssessment(
    ownerId: string,
    active: ActiveRun,
    entry: BatchEntry<T>,
  ): void {
    if (!this.classifyInterruption) return;
    const incomingText = entry.chunks.join("\n");
    let task!: Promise<void>;
    task = (async () => {
      let relation: TurnInterruptionRelation;
      try {
        relation = await this.classifyInterruption!(
          active.text,
          incomingText,
          ownerId,
          entry.turnId,
        );
      } catch (error) {
        // Jika hubungan tidak dapat dinilai, hentikan output lama. Menganggap
        // pesan baru sebagai redirect lebih aman daripada mengirim hasil stale.
        relation = "redirect";
        this.logger.warn(
          "turn_interruption_check_failed",
          "Hubungan pesan baru gagal dinilai; output lama dihentikan.",
          { error },
        );
      }

      entry.interruptionRelation = strongerRelation(
        entry.interruptionRelation,
        relation,
      );
      if (entry.interruptionRelation === "redirect") {
        if (
          entry.supersededTurnIds.has(active.turnId) &&
          entry.chunks[0] === active.text
        ) {
          entry.chunks.shift();
          entry.supersededTurnIds.delete(active.turnId);
        }
      } else if (
        (entry.interruptionRelation === "addition" ||
          entry.interruptionRelation === "correction") &&
        !active.userCommitted &&
        !entry.supersededTurnIds.has(active.turnId)
      ) {
        // Run yang dibatalkan sebelum user turn masuk history harus membawa
        // teks awalnya ke logical turn pengganti, tepat satu kali.
        entry.chunks.unshift(active.text);
        entry.supersededTurnIds.add(active.turnId);
      }

      if (
        entry.interruptionRelation !== "independent" &&
        this.activeRuns.get(ownerId) === active &&
        this.generation(ownerId) === active.generation
      ) {
        active.controller.abort();
      }
    })().finally(() => {
      active.pendingRelations.delete(task);
      entry.pendingRelations.delete(task);
      this.interruptionTasks.delete(task);
    });
    active.pendingRelations.add(task);
    entry.pendingRelations.add(task);
    this.interruptionTasks.add(task);
  }

  private async awaitActiveCurrent(
    ownerId: string,
    active: ActiveRun,
  ): Promise<boolean> {
    if (active.controller.signal.aborted) return false;
    await this.awaitRelationTasks(active.pendingRelations);
    return !active.controller.signal.aborted &&
      this.generation(ownerId) === active.generation &&
      this.activeRuns.get(ownerId) === active;
  }

  private async awaitRelationTasks(tasks: Set<Promise<void>>): Promise<void> {
    while (tasks.size > 0) {
      await Promise.allSettled([...tasks]);
    }
  }

  private async waitForIdle(ownerId: string): Promise<void> {
    const active = this.chains.get(ownerId);
    if (!active) return;

    try {
      await active;
    } catch (error) {
      // Command/tombol yang datang sesudahnya tetap harus dapat diproses.
      this.logger.error(
        "previous_turn_failed",
        "Giliran percakapan sebelumnya gagal.",
        error,
      );
    }
  }

  private enqueueBackground(
    ownerId: string,
    action: () => Promise<void>,
    event: string,
    message: string,
  ): void {
    void this.enqueueAction(ownerId, action).catch((error: unknown) => {
      this.logger.error(event, message, error);
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
    this.abortActive(ownerId);
  }

  private abortActive(ownerId: string): void {
    this.activeRuns.get(ownerId)?.controller.abort();
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
      !this.evaluations.has(ownerId) &&
      !this.activeRuns.has(ownerId)
    ) {
      this.generations.delete(ownerId);
    }
  }

  private notifyTurn(metrics: MessageBatchMetrics): void {
    if (!this.observeTurn) return;
    void Promise.resolve()
      .then(() => this.observeTurn?.(metrics))
      .catch((error: unknown) => {
        this.logger.warn(
          "turn_telemetry_failed",
          "Metrik giliran gagal dicatat.",
          { error },
        );
      });
  }
}

function clearTimers<T>(entry: BatchEntry<T>): void {
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
  entry.settleTimer = null;
  entry.deadlineTimer = null;
}

function strongerRelation(
  current: TurnInterruptionRelation | null,
  incoming: TurnInterruptionRelation,
): TurnInterruptionRelation {
  if (!current) return incoming;
  const priority: Record<TurnInterruptionRelation, number> = {
    independent: 0,
    addition: 1,
    correction: 2,
    redirect: 3,
  };
  return priority[incoming] > priority[current] ? incoming : current;
}
