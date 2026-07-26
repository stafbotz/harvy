import type {
  ConversationHistory,
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
  constructor(
    private readonly repository: HistoryRepository,
    private readonly summarize: Summarizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async context(ownerId: string): Promise<ConversationContext> {
    const history = await this.repository.load(ownerId);
    if (!history) return { summary: null, turns: [] };

    return { summary: history.summary, turns: promptWindow(history) };
  }

  async append(
    ownerId: string,
    role: TurnRole,
    text: string,
  ): Promise<void> {
    const clean = trimTurnText(text);
    if (!clean) return;

    const history = (await this.repository.load(ownerId)) ?? {
      ownerId,
      summary: null,
      turns: [],
      updatedAt: this.now().toISOString(),
    };

    history.turns.push({ role, text: clean, at: this.now().toISOString() });
    history.updatedAt = this.now().toISOString();

    await this.repository.save(await this.compactIfNeeded(history));
  }

  async forget(ownerId: string): Promise<boolean> {
    return this.repository.remove(ownerId);
  }

  /**
   * Ringkasan yang gagal dibuat tidak boleh menjatuhkan percakapan.
   *
   * Kalau model sedang tidak dapat dihubungi, riwayat dibiarkan panjang untuk
   * sementara dan pemadatan dicoba lagi pada giliran berikutnya. Membuang
   * giliran tanpa ringkasannya jauh lebih buruk: konteksnya hilang diam-diam.
   */
  private async compactIfNeeded(
    history: ConversationHistory,
  ): Promise<ConversationHistory> {
    if (!needsCompaction(history)) return history;

    const { evict, keep } = splitForCompaction(history);
    if (evict.length === 0) return history;

    try {
      const summary = await this.summarize(history.summary, evict);
      const clean = summary.trim();
      if (!clean) return history;

      return { ...history, summary: clean, turns: keep };
    } catch (error) {
      console.warn("Peringkasan riwayat gagal, dicoba lagi nanti:", error);
      return history;
    }
  }
}
