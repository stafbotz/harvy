import type {
  ConversationTurn,
  HistoryRepository,
  TurnRole,
} from "../domain/history.js";
import {
  needsCompaction,
  promptWindow,
  splitForCompaction,
  trimTurnText,
} from "./history-policy.js";

/**
 * Meringkas giliran yang sudah terlalu tua menjadi satu paragraf.
 *
 * Disuntikkan dari luar karena peringkasan memanggil model, sedangkan `core/`
 * harus tetap bebas jaringan dan dapat diuji tanpa kunci API.
 */
export type Summarizer = (
  previousSummary: string | null,
  turns: ConversationTurn[],
) => Promise<string>;

export interface ConversationContext {
  summary: string | null;
  turns: ConversationTurn[];
}

/**
 * Menyimpan percakapan yang baru terjadi, dan menjaganya tetap pendek.
 *
 * Riwayat memang disimpan ke disk supaya konteks tidak hilang saat proses
 * restart, tetapi ia tidak dibiarkan tumbuh tanpa batas: giliran terlama
 * diringkas lalu dibuang. Lihat `ADR-006` bagian 3.
 */
export class HistoryService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly compacting = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private readonly forgetGeneration = new Map<string, number>();

  constructor(
    private readonly repository: HistoryRepository,
    private readonly summarize: Summarizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async context(ownerId: string): Promise<ConversationContext> {
    return this.exclusive(ownerId, async () => {
      const history = await this.repository.load(ownerId);
      if (!history) return { summary: null, turns: [] };

      return { summary: history.summary, turns: promptWindow(history) };
    });
  }

  async append(
    ownerId: string,
    role: TurnRole,
    text: string,
  ): Promise<void> {
    const clean = trimTurnText(text);
    if (!clean) return;

    await this.exclusive(ownerId, async () => {
      const history = (await this.repository.load(ownerId)) ?? {
        ownerId,
        summary: null,
        turns: [],
        updatedAt: this.now().toISOString(),
      };

      history.turns.push({ role, text: clean, at: this.now().toISOString() });
      history.updatedAt = this.now().toISOString();

      // Penyimpanan giliran tidak menunggu model peringkas. `compact()` dipanggil
      // setelah balasan terkirim sehingga model yang lambat tidak menahan chat.
      await this.repository.save(history);
    });
  }

  async forget(ownerId: string): Promise<boolean> {
    return this.exclusive(ownerId, async () => {
      this.forgetGeneration.set(ownerId, this.generationOf(ownerId) + 1);
      this.retryAfter.delete(ownerId);
      return this.repository.remove(ownerId);
    });
  }

  /**
   * Memadatkan riwayat tanpa menahan balasan pengguna.
   *
   * Ringkasan dibuat di luar antrean penyimpanan. Saat hasilnya siap, bagian
   * yang diringkas dihapus dari versi terbaru sehingga giliran yang masuk
   * selama model bekerja tidak tertimpa.
   */
  async compact(ownerId: string): Promise<void> {
    if (this.compacting.has(ownerId)) return;
    if ((this.retryAfter.get(ownerId) ?? 0) > this.now().getTime()) return;

    this.compacting.add(ownerId);
    const generation = this.generationOf(ownerId);

    try {
      const snapshot = await this.exclusive(ownerId, () =>
        this.repository.load(ownerId),
      );
      if (!snapshot || !needsCompaction(snapshot)) return;

      const { evict } = splitForCompaction(snapshot);
      if (evict.length === 0) return;

      const summary = await this.summarize(snapshot.summary, evict);
      const clean = summary.trim();
      if (!clean) {
        this.delayRetry(ownerId);
        return;
      }

      await this.exclusive(ownerId, async () => {
        if (this.generationOf(ownerId) !== generation) return;

        const latest = await this.repository.load(ownerId);
        if (!latest || latest.summary !== snapshot.summary) return;
        if (!startsWithTurns(latest.turns, evict)) return;

        await this.repository.save({
          ...latest,
          summary: clean,
          turns: latest.turns.slice(evict.length),
          updatedAt: this.now().toISOString(),
        });
        this.retryAfter.delete(ownerId);
      });
    } catch (error) {
      this.delayRetry(ownerId);
      console.warn("Peringkasan riwayat gagal, dicoba lagi nanti:", error);
    } finally {
      this.compacting.delete(ownerId);
    }
  }

  private delayRetry(ownerId: string): void {
    this.retryAfter.set(ownerId, this.now().getTime() + COMPACTION_RETRY_MS);
  }

  private generationOf(ownerId: string): number {
    return this.forgetGeneration.get(ownerId) ?? 0;
  }

  private async exclusive<T>(
    ownerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(ownerId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(ownerId, settled);

    try {
      return await result;
    } finally {
      if (this.queues.get(ownerId) === settled) {
        this.queues.delete(ownerId);
      }
    }
  }
}

const COMPACTION_RETRY_MS = 60_000;

function startsWithTurns(
  turns: ConversationTurn[],
  prefix: ConversationTurn[],
): boolean {
  if (turns.length < prefix.length) return false;

  return prefix.every((expected, index) => {
    const actual = turns[index];
    return (
      actual?.role === expected.role &&
      actual.text === expected.text &&
      actual.at === expected.at
    );
  });
}
