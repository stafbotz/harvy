import type {
  ConversationEpisode,
  ConversationTurn,
  EpisodeSummaryDraft,
  HistoryRepository,
  HistoricalEpisodeMatch,
  StoredConversationTurn,
  TurnRole,
} from "../domain/history.js";
import { HISTORY_EPISODE_CONTEXT_LIMIT } from "../domain/history.js";
import {
  needsCompaction,
  promptWindow,
  splitForCompaction,
  trimTurnText,
} from "./history-policy.js";
import {
  createConversationEpisode,
  episodeCoverageHash,
  episodeSourceHash,
  renderEpisodeContext,
  retainConversationEpisode,
} from "./episodic-compaction.js";
import {
  searchConversationEpisodes,
  type HistorySearchOptions,
} from "./history-search.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

/**
 * Mengekstrak satu episode terstruktur dari giliran yang sudah terlalu tua.
 *
 * Disuntikkan dari luar karena peringkasan memanggil model, sedangkan `core/`
 * harus tetap bebas jaringan dan dapat diuji tanpa kunci API.
 */
export type Summarizer = (
  turns: StoredConversationTurn[],
  ownerId?: string,
) => Promise<EpisodeSummaryDraft>;

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
  private readonly compactions = new Map<string, Promise<void>>();
  private readonly retryAfter = new Map<string, number>();
  private readonly forgetGeneration = new Map<string, number>();
  private readonly forgettingOwners = new Set<string>();
  private readonly blockedOwners = new Set<string>();
  private activeCompactionSlots = 0;
  private readonly compactionSlotWaiters: Array<() => void> = [];

  constructor(
    private readonly repository: HistoryRepository,
    private readonly summarize: Summarizer,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.history"),
  ) {}

  async context(ownerId: string): Promise<ConversationContext> {
    const generation = this.generationOf(ownerId);
    if (!this.canRead(ownerId)) {
      return { summary: null, turns: [] };
    }
    return this.exclusive(ownerId, async () => {
      if (
        !this.canRead(ownerId) ||
        generation !== this.generationOf(ownerId)
      ) return { summary: null, turns: [] };
      const history = await this.repository.load(ownerId);
      if (
        !history ||
        !this.canRead(ownerId) ||
        generation !== this.generationOf(ownerId)
      ) {
        return { summary: null, turns: [] };
      }

      return {
        summary: renderEpisodeContext(history.episodes),
        turns: promptWindow(history),
      };
    });
  }

  async append(
    ownerId: string,
    role: TurnRole,
    text: string,
  ): Promise<StoredConversationTurn | null> {
    const clean = trimTurnText(text);
    if (!clean || this.blockedOwners.has(ownerId)) return null;
    const generation = this.generationOf(ownerId);

    return this.exclusive(ownerId, async () => {
      if (
        this.blockedOwners.has(ownerId) ||
        generation !== this.generationOf(ownerId)
      ) return null;
      const history = (await this.repository.load(ownerId)) ?? {
        ownerId,
        episodes: [],
        turns: [],
        nextSequence: 1,
        updatedAt: this.now().toISOString(),
      };

      const turn: StoredConversationTurn = {
        sequence: history.nextSequence,
        role,
        text: clean,
        at: this.now().toISOString(),
      };
      history.turns.push(turn);
      history.nextSequence += 1;
      history.updatedAt = this.now().toISOString();
      if (
        this.blockedOwners.has(ownerId) ||
        generation !== this.generationOf(ownerId)
      ) return null;

      // Penyimpanan giliran tidak menunggu model peringkas. `compact()` dipanggil
      // setelah balasan terkirim sehingga model yang lambat tidak menahan chat.
      await this.repository.save(history);
      return structuredClone(turn);
    });
  }

  /** Episode lengkap untuk semantic retrieval, tetap fail-closed saat suspend. */
  async episodesForRetrieval(ownerId: string): Promise<ConversationEpisode[]> {
    const generation = this.generationOf(ownerId);
    if (!this.canRead(ownerId)) return [];
    return this.exclusive(ownerId, async () => {
      if (!this.canRead(ownerId) || generation !== this.generationOf(ownerId)) {
        return [];
      }
      const history = await this.repository.load(ownerId);
      if (
        !history ||
        !this.canRead(ownerId) ||
        generation !== this.generationOf(ownerId)
      ) return [];
      return structuredClone(history.episodes);
    });
  }

  /** Hanya jendela episode yang memang boleh dirender otomatis. */
  async episodesForContext(ownerId: string): Promise<ConversationEpisode[]> {
    const episodes = await this.episodesForRetrieval(ownerId);
    return episodes.slice(-HISTORY_EPISODE_CONTEXT_LIMIT);
  }

  async forget(ownerId: string, blockWrites = false): Promise<boolean> {
    this.forgettingOwners.add(ownerId);
    if (blockWrites) this.blockedOwners.add(ownerId);
    this.forgetGeneration.set(ownerId, this.generationOf(ownerId) + 1);
    this.retryAfter.delete(ownerId);

    try {
      const active = this.compactions.get(ownerId);
      if (active) await active;
      return await this.exclusive(ownerId, () =>
        this.repository.remove(ownerId),
      );
    } finally {
      this.forgettingOwners.delete(ownerId);
    }
  }

  /**
   * Mencari klaim episode lama secara lokal tanpa memanggil model.
   *
   * Hasil belum otomatis masuk prompt: routing query, suppression setelah
   * `forget one`, dan ContextCompiler Phase E berikutnya harus menentukan kapan
   * data lama memang layak dibawa. Owner yang consent/history-nya diblokir
   * selalu mendapat hasil kosong.
   */
  async search(
    ownerId: string,
    query: string,
    options: HistorySearchOptions = {},
  ): Promise<HistoricalEpisodeMatch[]> {
    const generation = this.generationOf(ownerId);
    if (!this.canRead(ownerId)) return [];
    return this.exclusive(ownerId, async () => {
      if (!this.canRead(ownerId) || generation !== this.generationOf(ownerId)) {
        return [];
      }
      const history = await this.repository.load(ownerId);
      if (
        !history ||
        !this.canRead(ownerId) ||
        generation !== this.generationOf(ownerId)
      ) return [];
      return searchConversationEpisodes(history.episodes, query, options);
    });
  }

  /**
   * Menghentikan penggunaan riwayat tanpa menghapus record yang sudah ada.
   * Dipakai segera ketika persetujuan ditarik: compaction yang masih menunggu
   * slot melihat generation baru dan tidak boleh mulai memanggil model.
   */
  suspend(ownerId: string): void {
    this.blockedOwners.add(ownerId);
    this.forgetGeneration.set(ownerId, this.generationOf(ownerId) + 1);
    this.retryAfter.delete(ownerId);
  }

  /** Membuka riwayat baru hanya setelah persetujuan baru diberikan. */
  allow(ownerId: string): void {
    this.blockedOwners.delete(ownerId);
  }

  /** Salinan lengkap untuk ekspor pengguna, bukan jendela prompt. */
  async snapshot(ownerId: string) {
    return this.exclusive(ownerId, () => this.repository.load(ownerId));
  }

  /** Menunggu seluruh compaction yang sudah dimulai sebelum shutdown selesai. */
  async drain(): Promise<void> {
    while (this.compactions.size > 0) {
      await Promise.allSettled([...this.compactions.values()]);
    }
  }

  /**
   * Memadatkan riwayat tanpa menahan balasan pengguna.
   *
   * Ringkasan dibuat di luar antrean penyimpanan. Saat hasilnya siap, bagian
   * yang diringkas dihapus dari versi terbaru sehingga giliran yang masuk
   * selama model bekerja tidak tertimpa.
   */
  async compact(ownerId: string): Promise<void> {
    if (
      this.forgettingOwners.has(ownerId) ||
      this.blockedOwners.has(ownerId)
    ) {
      return;
    }
    const active = this.compactions.get(ownerId);
    if (active) {
      await active;
      // Request yang datang di ujung run aktif dapat lolos dari pemeriksaan
      // backlog terakhir. Masuk lagi setelah promise lama dilepas agar keadaan
      // terbaru diperiksa, bukan mengandalkan pesan pengguna berikutnya.
      return this.compact(ownerId);
    }
    if ((this.retryAfter.get(ownerId) ?? 0) > this.now().getTime()) return;

    const generation = this.generationOf(ownerId);
    const running = this.runCompactionLoop(ownerId, generation).catch(
      (error: unknown) => {
        this.delayRetry(ownerId);
        this.logger.warn(
          "history_compaction_failed",
          "Peringkasan riwayat gagal dan akan dicoba lagi nanti.",
          { error },
        );
      },
    );
    this.compactions.set(ownerId, running);

    try {
      await running;
    } finally {
      if (this.compactions.get(ownerId) === running) {
        this.compactions.delete(ownerId);
      }
    }
  }

  /**
   * Menangkap backlog yang tumbuh ketika satu model compaction masih aktif.
   * Setiap pass melepaskan slot global lebih dulu agar satu pemilik tidak
   * memonopoli dua slot ketika banyak akun sama-sama perlu dipadatkan.
   */
  private async runCompactionLoop(
    ownerId: string,
    generation: number,
  ): Promise<void> {
    while (true) {
      const committed = await this.withCompactionSlot(() =>
        this.runCompaction(ownerId, generation),
      );
      if (!committed) return;
      if (
        this.generationOf(ownerId) !== generation ||
        this.forgettingOwners.has(ownerId) ||
        this.blockedOwners.has(ownerId)
      ) {
        return;
      }
      const shouldContinue = await this.exclusive(ownerId, async () => {
        const latest = await this.repository.load(ownerId);
        return latest ? needsCompaction(latest) : false;
      });
      if (!shouldContinue) return;
    }
  }

  private async runCompaction(
    ownerId: string,
    generation: number,
  ): Promise<boolean> {
    const snapshot = await this.exclusive(ownerId, () =>
      this.repository.load(ownerId),
    );
    if (
      this.generationOf(ownerId) !== generation ||
      this.forgettingOwners.has(ownerId) ||
      this.blockedOwners.has(ownerId) ||
      !snapshot ||
      !needsCompaction(snapshot)
    ) {
      return false;
    }

    const { evict } = splitForCompaction(snapshot);
    if (evict.length === 0) return false;

    const sourceHash = episodeSourceHash(evict);
    const coverageHash = episodeCoverageHash(snapshot.episodes);
    const draft = await this.summarize(evict, ownerId);
    const createdAt = this.now().toISOString();
    const episode = createConversationEpisode(draft, evict, createdAt);
    if (!episode || episode.source.sourceHash !== sourceHash) {
      throw new Error("Rancangan episode tidak sah atau provenance berubah.");
    }

    return this.exclusive(ownerId, async () => {
      if (
        this.generationOf(ownerId) !== generation ||
        this.blockedOwners.has(ownerId)
      ) {
        return false;
      }

      const latest = await this.repository.load(ownerId);
      if (!latest || episodeCoverageHash(latest.episodes) !== coverageHash) {
        return false;
      }
      if (!startsWithTurns(latest.turns, evict)) return false;
      if (episodeSourceHash(latest.turns.slice(0, evict.length)) !== sourceHash) {
        return false;
      }

      const episodes = retainConversationEpisode(latest.episodes, episode);
      if (!episodes) return false;

      await this.repository.save({
        ...latest,
        episodes,
        turns: latest.turns.slice(evict.length),
        updatedAt: createdAt,
      });
      this.retryAfter.delete(ownerId);
      return true;
    });
  }

  private delayRetry(ownerId: string): void {
    this.retryAfter.set(ownerId, this.now().getTime() + COMPACTION_RETRY_MS);
  }

  private generationOf(ownerId: string): number {
    return this.forgetGeneration.get(ownerId) ?? 0;
  }

  private canRead(ownerId: string): boolean {
    return !this.blockedOwners.has(ownerId) &&
      !this.forgettingOwners.has(ownerId);
  }

  private async withCompactionSlot<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.acquireCompactionSlot();

    try {
      return await operation();
    } finally {
      const next = this.compactionSlotWaiters.shift();
      if (next) {
        // Slot langsung dipindahkan ke waiter; caller baru tetap melihatnya
        // terpakai sampai waiter itu sendiri selesai.
        next();
      } else {
        this.activeCompactionSlots -= 1;
      }
    }
  }

  private async acquireCompactionSlot(): Promise<void> {
    if (this.activeCompactionSlots < MAX_CONCURRENT_COMPACTIONS) {
      this.activeCompactionSlots += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.compactionSlotWaiters.push(resolve);
    });
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
const MAX_CONCURRENT_COMPACTIONS = 2;

function startsWithTurns(
  turns: StoredConversationTurn[],
  prefix: StoredConversationTurn[],
): boolean {
  if (turns.length < prefix.length) return false;

  return prefix.every((expected, index) => {
    const actual = turns[index];
    return (
      actual?.role === expected.role &&
      actual.sequence === expected.sequence &&
      actual.text === expected.text &&
      actual.at === expected.at
    );
  });
}
