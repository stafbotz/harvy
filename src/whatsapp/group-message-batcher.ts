import {
  groupScopeKey,
  type GroupMessage,
  type GroupMessagePart,
} from "../domain/group.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import { AdaptiveDebouncePolicy } from "../core/adaptive-debounce-policy.js";
import { hasExplicitImmediateDangerSignal } from "../core/safety-policy.js";
import {
  assessmentIdleWindowMs,
  assessTurnBoundaryLocally,
  guardTurnBoundaryAssessment,
  normalizeTurnBoundaryAssessment,
  type TurnBoundaryProposal,
  type TurnBoundarySignals,
} from "../core/turn-taking-policy.js";

interface PendingBatch {
  messages: GroupMessage[];
  firstEnqueuedAt: number;
  lastEnqueuedAt: number;
  revision: number;
  waiters: {
    resolve: () => void;
    reject: (error: unknown) => void;
  }[];
  settleTimer: NodeJS.Timeout | null;
  deadlineTimer: NodeJS.Timeout | null;
}

const DEFAULT_MAX_WAIT_MS = 4_000;
const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_MAX_CHARACTERS = 24_000;

/**
 * Menggabungkan hanya bubble berurutan dari anggota yang sama tanpa menahan
 * event loop Baileys. Pergantian pembicara langsung menutup batch sebelumnya,
 * sehingga A1 → B1 → A2 tetap tiga giliran dalam urutan tersebut.
 * Tidak ada model pada tahap ini: setelah jeda singkat, seluruh teks menjadi
 * satu giliran dan tiap ID bubble tetap dibawa untuk dedupe/statistik.
 * Akun ikut menjadi bagian kunci: dua nomor Harvy yang kebetulan menerima grup
 * sama tidak boleh meleburkan pesan atau memilih socket nomor terakhir.
 */
export class GroupMessageBatcher {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly ingressGenerations = new Map<string, number>();
  private readonly observationTasks = new Set<Promise<GroupMessage | null>>();
  private readonly observationChains = new Map<string, Promise<void>>();
  private readonly lastParticipantByStream = new Map<string, string>();
  private readonly active = new Set<Promise<void>>();
  private readonly boundaryTasks = new Set<Promise<void>>();
  private accepting = true;

  constructor(
    private readonly handle: (message: GroupMessage) => Promise<void>,
    private readonly settleMs = 1_200,
    private readonly maxWaitMs = DEFAULT_MAX_WAIT_MS,
    private readonly maxMessages = DEFAULT_MAX_MESSAGES,
    private readonly maxCharacters = DEFAULT_MAX_CHARACTERS,
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("whatsapp.group-batcher"),
    private readonly directSettleMs = 350,
    private readonly observe: (
      message: GroupMessage,
    ) => GroupMessage | null | Promise<GroupMessage | null> =
      (message) => message,
    private readonly adaptiveDebounce = new AdaptiveDebouncePolicy({
      minDelayMs: Math.min(Math.max(1, directSettleMs), 300),
      maxDelayMs: Math.min(2_500, Math.max(1, maxWaitMs)),
      maxGapMs: Math.max(1, maxWaitMs),
    }),
    private readonly urgentPreflight?: (
      message: GroupMessage,
    ) => Promise<void>,
    private readonly assessBoundary?: (
      message: GroupMessage,
      signals: TurnBoundarySignals,
    ) => Promise<TurnBoundaryProposal>,
  ) {}

  async enqueue(message: GroupMessage): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    const rawKey = streamKey(message);
    const ingressGeneration = this.ingressGenerations.get(rawKey) ?? 0;
    this.ingressGenerations.set(rawKey, ingressGeneration);
    // Observasi harus terjadi sebelum pergantian pembicara menutup batch lama.
    // Dengan urutan ini, kandidat ambient A sudah tahu bahwa pesan B datang
    // sebelum A sempat dikirim.
    const candidate = this.observeInOrder(rawKey, message);
    this.observationTasks.add(candidate);
    let observed: GroupMessage | null;
    try {
      observed = await candidate;
    } finally {
      this.observationTasks.delete(candidate);
    }
    if (
      !this.accepting ||
      this.ingressGenerations.get(rawKey) !== ingressGeneration
    ) {
      return;
    }
    if (!observed) return;
    message = observed;
    const urgent = hasExplicitImmediateDangerSignal(message.text);
    if (urgent) this.startUrgentPreflight(message);
    const key = streamKey(message);
    const timingKey = debounceSubjectKey(message);
    const enqueuedAt = Date.now();
    const previousParticipant = this.lastParticipantByStream.get(key);
    this.adaptiveDebounce.observeArrival(
      timingKey,
      enqueuedAt,
      previousParticipant === undefined ||
        previousParticipant === message.participantId,
    );
    this.lastParticipantByStream.set(key, message.participantId);
    let existing = this.pending.get(key);
    if (
      existing &&
      (existing.messages.at(-1)?.participantId !== message.participantId ||
        this.wouldOverflow(existing, message))
    ) {
      this.flush(key, existing);
      existing = undefined;
    }

    return new Promise<void>((resolve, reject) => {
      const batch = existing ?? {
        messages: [],
        firstEnqueuedAt: enqueuedAt,
        lastEnqueuedAt: enqueuedAt,
        revision: 0,
        waiters: [],
        settleTimer: null,
        deadlineTimer: null,
      };
      batch.messages.push(message);
      batch.lastEnqueuedAt = enqueuedAt;
      batch.revision += 1;
      batch.waiters.push({ resolve, reject });
      this.logger.debug(
        "group_bubble_enqueued",
        "Bubble WhatsApp masuk ke penampung giliran grup.",
        {
          accountId: message.accountId,
          bubbleCount: batch.messages.length,
        },
      );

      if (!batch.deadlineTimer) {
        batch.deadlineTimer = setTimeout(() => {
          this.flush(key, batch);
        }, Math.max(1, this.maxWaitMs));
        batch.deadlineTimer.unref();
      }
      if (batch.settleTimer) clearTimeout(batch.settleTimer);
      const hasDirectCall = batch.messages.some(
        (candidate) =>
          candidate.mentionsHarvy || candidate.repliesToHarvy,
      );
      const baseSettleMs = hasDirectCall
        ? Math.min(this.settleMs, this.directSettleMs)
        : this.settleMs;
      const adaptiveTiming = this.adaptiveDebounce.estimate(
        timingKey,
        baseSettleMs,
      );
      this.pending.set(key, batch);

      if (urgent) {
        // Fixed ACK boleh out-of-band, tetapi full turn tetap mengikuti urutan
        // stream. Bubble lama dari speaker sama ikut batch ini; speaker lama
        // yang berbeda sudah di-start lebih dulu oleh flush di atas.
        this.flush(key, batch);
      } else if (
        batch.messages.length >= Math.max(1, this.maxMessages) ||
        batchCharacters(batch) >= Math.max(1, this.maxCharacters)
      ) {
        this.flush(key, batch);
      } else if (this.assessBoundary) {
        const local = assessTurnBoundaryLocally(
          batch.messages.map((item) => item.text).join("\n"),
        );
        if (local?.state === "complete") {
          this.flush(key, batch);
        } else if (local?.state !== "incomplete") {
          const revision = batch.revision;
          batch.settleTimer = setTimeout(() => {
            batch.settleTimer = null;
            this.startBoundaryAssessment(
              key,
              batch,
              revision,
              adaptiveTiming.settleMs,
              adaptiveTiming.adaptive,
            );
          }, Math.max(1, Math.min(this.maxWaitMs, adaptiveTiming.settleMs)));
          batch.settleTimer.unref();
        }
      } else {
        batch.settleTimer = setTimeout(() => {
          this.flush(key, batch);
        }, Math.max(1, Math.min(this.maxWaitMs, adaptiveTiming.settleMs)));
        batch.settleTimer.unref();
      }
    });
  }

  invalidateScope(scopeKey: string, accountId?: string): void {
    const exact = accountId ? `${scopeKey}\u0000${accountId}` : null;
    const prefix = `${scopeKey}\u0000`;
    if (exact) {
      this.ingressGenerations.set(
        exact,
        (this.ingressGenerations.get(exact) ?? 0) + 1,
      );
    } else {
      for (const key of this.ingressGenerations.keys()) {
        if (key.startsWith(prefix)) {
          this.ingressGenerations.set(
            key,
            (this.ingressGenerations.get(key) ?? 0) + 1,
          );
        }
      }
    }
    for (const [key, batch] of this.pending) {
      if (exact ? key !== exact : !key.startsWith(prefix)) continue;
      this.clearTimers(batch);
      this.pending.delete(key);
      for (const waiter of batch.waiters) waiter.resolve();
    }
    for (const key of this.lastParticipantByStream.keys()) {
      if (exact ? key === exact : key.startsWith(prefix)) {
        this.lastParticipantByStream.delete(key);
      }
    }
    this.adaptiveDebounce.forgetPrefix(
      accountId
        ? `${scopeKey}\u0000${accountId}\u0000`
        : `${scopeKey}\u0000`,
    );
  }

  async stopIngress(): Promise<void> {
    this.accepting = false;
    await this.drainAll();
    this.lastParticipantByStream.clear();
    this.ingressGenerations.clear();
    this.observationChains.clear();
    this.adaptiveDebounce.clear();
  }

  async drainAll(): Promise<void> {
    while (this.observationTasks.size > 0) {
      await Promise.allSettled([...this.observationTasks]);
    }
    while (this.boundaryTasks.size > 0) {
      await Promise.allSettled([...this.boundaryTasks]);
    }
    for (const [key, batch] of [...this.pending]) {
      this.pending.delete(key);
      this.clearTimers(batch);
      this.start(key, batch);
    }
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }

  private flush(key: string, batch: PendingBatch): void {
    if (this.pending.get(key) !== batch) return;
    this.pending.delete(key);
    this.clearTimers(batch);
    this.start(key, batch);
  }

  private startBoundaryAssessment(
    key: string,
    batch: PendingBatch,
    revision: number,
    learnedSettleMs: number,
    adaptiveTimingUsed: boolean,
  ): void {
    if (!this.assessBoundary) return;
    const merged = mergeGroupMessages(batch.messages);
    const task = this.assessBoundary(merged, {
      bubbleCount: batch.messages.length,
      adaptiveTimingUsed,
      learnedSettleMs,
      rapidBurst: batch.messages.length > 1 &&
        Date.now() - batch.firstEnqueuedAt <=
          Math.max(1_500, learnedSettleMs * batch.messages.length),
    }).then((proposal) => {
      if (
        this.pending.get(key) !== batch ||
        batch.revision !== revision
      ) return;
      const assessment = guardTurnBoundaryAssessment(
        merged.text,
        normalizeTurnBoundaryAssessment(proposal),
      );
      if (assessment.state === "urgent") {
        this.startUrgentPreflight(merged);
      }
      const idleMs = Math.min(
        this.maxWaitMs,
        assessmentIdleWindowMs(assessment, batch.messages.length, {
          openMs: this.maxWaitMs,
          incompleteMs: this.maxWaitMs,
          multiBubbleMs: this.maxWaitMs,
        }),
      );
      const remaining = Math.max(
        0,
        idleMs - (Date.now() - batch.lastEnqueuedAt),
      );
      if (remaining === 0) {
        this.flush(key, batch);
        return;
      }
      batch.settleTimer = setTimeout(() => this.flush(key, batch), remaining);
      batch.settleTimer.unref();
    }).catch((error: unknown) => {
      // Deadline max tetap hidup. Kegagalan semantic assessment tidak boleh
      // membuat grup hilang, juga tidak boleh diasumsikan complete.
      this.logger.warn(
        "whatsapp_group_boundary_failed",
        "Assessment batas giliran grup gagal; deadline fail-safe dipakai.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    }).finally(() => {
      this.boundaryTasks.delete(task);
    });
    this.boundaryTasks.add(task);
  }

  private start(key: string, batch: PendingBatch): void {
    const merged = mergeGroupMessages(batch.messages);
    const previous = this.chains.get(key) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(async () => {
      const startedAt = Date.now();
      await this.handle(merged);
      this.logger.info(
        "whatsapp_group_turn_completed",
        "Giliran grup WhatsApp selesai diproses.",
        {
          accountId: merged.accountId,
          bubbleCount: batch.messages.length,
          characterCount: merged.text.length,
          durationMs: Date.now() - startedAt,
          latencyMs: Date.now() - batch.firstEnqueuedAt,
        },
      );
      for (const waiter of batch.waiters) waiter.resolve();
    }).catch(
      (error: unknown) => {
        this.logger.error(
          "whatsapp_group_turn_failed",
          "Giliran grup WhatsApp gagal diproses.",
          error,
          {
            accountId: merged.accountId,
            bubbleCount: batch.messages.length,
            characterCount: merged.text.length,
            latencyMs: Date.now() - batch.firstEnqueuedAt,
          },
        );
        for (const waiter of batch.waiters) waiter.reject(error);
      },
    );
    const barrier = running.then(
      () => {
        if (this.chains.get(key) === barrier) this.chains.delete(key);
      },
      () => {
        if (this.chains.get(key) === barrier) this.chains.delete(key);
      },
    );
    this.chains.set(key, barrier);
    this.active.add(running);
    void running.then(
      () => this.active.delete(running),
      () => this.active.delete(running),
    );
  }

  /** Hanya fixed ACK yang boleh keluar dari FIFO full-turn. */
  private startUrgentPreflight(message: GroupMessage): void {
    if (!this.urgentPreflight) return;
    const startedAt = Date.now();
    const running = Promise.resolve()
      .then(() => this.urgentPreflight!(message))
      .then(
        () => {
          this.logger.info(
            "whatsapp_group_urgent_preflight_completed",
            "Preflight darurat lokal grup selesai tanpa debounce.",
            {
              accountId: message.accountId,
              characterCount: message.text.length,
              durationMs: Date.now() - startedAt,
            },
          );
        },
        (error: unknown) => {
          this.logger.error(
            "whatsapp_group_urgent_preflight_failed",
            "Preflight darurat lokal grup gagal diproses.",
            error,
            {
              accountId: message.accountId,
              characterCount: message.text.length,
              durationMs: Date.now() - startedAt,
            },
          );
        },
      );
    this.active.add(running);
    void running.then(
      () => this.active.delete(running),
      () => this.active.delete(running),
    );
  }

  private clearTimers(batch: PendingBatch): void {
    if (batch.settleTimer) clearTimeout(batch.settleTimer);
    if (batch.deadlineTimer) clearTimeout(batch.deadlineTimer);
    batch.settleTimer = null;
    batch.deadlineTimer = null;
  }

  private wouldOverflow(
    batch: PendingBatch,
    message: GroupMessage,
  ): boolean {
    return (
      batch.messages.length >= Math.max(1, this.maxMessages) ||
      batchCharacters(batch) + message.text.length >
        Math.max(1, this.maxCharacters)
    );
  }

  private observeInOrder(
    key: string,
    message: GroupMessage,
  ): Promise<GroupMessage | null> {
    const previous = this.observationChains.get(key) ?? Promise.resolve();
    const running = previous
      .catch(() => undefined)
      .then(() => this.observe(message));
    const barrier: Promise<void> = running.then(
      (): void => this.releaseObservation(key, barrier),
      (): void => this.releaseObservation(key, barrier),
    );
    this.observationChains.set(key, barrier);
    return running;
  }

  private releaseObservation(key: string, barrier: Promise<void>): void {
    if (this.observationChains.get(key) === barrier) {
      this.observationChains.delete(key);
    }
  }
}

export function mergeGroupMessages(
  messages: readonly GroupMessage[],
): GroupMessage {
  const latest = messages.at(-1);
  if (!latest) throw new Error("Batch grup kosong.");
  const parts: GroupMessagePart[] = messages.flatMap((message) =>
    message.parts?.length
      ? message.parts
      : [{
          messageId: message.messageId,
          text: message.text,
          at: message.at,
          mentionsHarvy: message.mentionsHarvy,
          repliesToHarvy: message.repliesToHarvy,
          quotedMessageId: message.quotedMessageId ?? null,
          quotedParticipantId: message.quotedParticipantId ?? null,
          ingressRevision: message.ingressRevision,
        }],
  );
  const quoted = parts.find(
    (part) => part.quotedMessageId || part.quotedParticipantId,
  );
  const ingressRevision = Math.max(
    ...parts.map((part) => part.ingressRevision ?? 0),
  );

  return {
    ...latest,
    participantAliases: [
      ...new Set(messages.flatMap((message) => message.participantAliases)),
    ],
    text: parts.map((part) => part.text).join("\n"),
    mentionsHarvy: parts.some((part) => part.mentionsHarvy),
    repliesToHarvy: parts.some((part) => part.repliesToHarvy),
    quotedMessageId: quoted?.quotedMessageId ?? null,
    quotedParticipantId: quoted?.quotedParticipantId ?? null,
    ingressRevision:
      ingressRevision > 0 ? ingressRevision : latest.ingressRevision,
    parts,
  };
}

function streamKey(message: GroupMessage): string {
  return `${groupScopeKey(message.scope)}\u0000${message.accountId}`;
}

function debounceSubjectKey(message: GroupMessage): string {
  return `${streamKey(message)}\u0000${message.participantId}`;
}

function batchCharacters(batch: PendingBatch): number {
  return batch.messages.reduce(
    (total, message) => total + message.text.length,
    0,
  );
}
