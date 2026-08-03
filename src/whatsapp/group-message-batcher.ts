import {
  groupScopeKey,
  type GroupMessage,
  type GroupMessagePart,
} from "../domain/group.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

interface PendingBatch {
  messages: GroupMessage[];
  firstEnqueuedAt: number;
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
  private readonly active = new Set<Promise<void>>();
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
    ) => GroupMessage = (message) => message,
  ) {}

  enqueue(message: GroupMessage): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    // Observasi harus terjadi sebelum pergantian pembicara menutup batch lama.
    // Dengan urutan ini, kandidat ambient A sudah tahu bahwa pesan B datang
    // sebelum A sempat dikirim.
    message = this.observe(message);
    const key = streamKey(message);
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
        firstEnqueuedAt: Date.now(),
        waiters: [],
        settleTimer: null,
        deadlineTimer: null,
      };
      batch.messages.push(message);
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
      batch.settleTimer = setTimeout(() => {
        this.flush(key, batch);
      }, Math.max(
        1,
        hasDirectCall
          ? Math.min(this.settleMs, this.directSettleMs)
          : this.settleMs,
      ));
      batch.settleTimer.unref();
      this.pending.set(key, batch);

      if (
        batch.messages.length >= Math.max(1, this.maxMessages) ||
        batchCharacters(batch) >= Math.max(1, this.maxCharacters)
      ) {
        this.flush(key, batch);
      }
    });
  }

  invalidateScope(scopeKey: string, accountId?: string): void {
    const exact = accountId ? `${scopeKey}\u0000${accountId}` : null;
    const prefix = `${scopeKey}\u0000`;
    for (const [key, batch] of this.pending) {
      if (exact ? key !== exact : !key.startsWith(prefix)) continue;
      this.clearTimers(batch);
      this.pending.delete(key);
      for (const waiter of batch.waiters) waiter.resolve();
    }
  }

  async stopIngress(): Promise<void> {
    this.accepting = false;
    await this.drainAll();
  }

  async drainAll(): Promise<void> {
    for (const [key, batch] of [...this.pending]) {
      this.pending.delete(key);
      this.clearTimers(batch);
      this.start(batch);
    }
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active]);
    }
  }

  private flush(key: string, batch: PendingBatch): void {
    if (this.pending.get(key) !== batch) return;
    this.pending.delete(key);
    this.clearTimers(batch);
    this.start(batch);
  }

  private start(batch: PendingBatch): void {
    const startedAt = Date.now();
    const merged = mergeGroupMessages(batch.messages);
    const running = this.handle(merged).then(
      () => {
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
      },
      (error: unknown) => {
        this.logger.error(
          "whatsapp_group_turn_failed",
          "Giliran grup WhatsApp gagal diproses.",
          error,
          {
            accountId: merged.accountId,
            bubbleCount: batch.messages.length,
            characterCount: merged.text.length,
            durationMs: Date.now() - startedAt,
            latencyMs: Date.now() - batch.firstEnqueuedAt,
          },
        );
        for (const waiter of batch.waiters) waiter.reject(error);
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

function batchCharacters(batch: PendingBatch): number {
  return batch.messages.reduce(
    (total, message) => total + message.text.length,
    0,
  );
}
