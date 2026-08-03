import type { ConversationTurn } from "../domain/history.js";
import {
  emptyInsight,
  type InsightRepository,
  type SafetyNote,
  type UserInsight,
} from "../domain/insight.js";
import {
  worthRecording,
  type RiskLevel,
} from "./safety-policy.js";

/** Berapa banyak giliran berisiko yang disimpan sebelum yang terlama dibuang. */
export const SAFETY_NOTE_LIMIT = 20;
export const SAFETY_NOTE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface InsightDraft {
  gaya: string | null;
  tahap: string | null;
  kerentanan: string | null;
}

/** Peringkas pemahaman diberikan dari luar supaya `core/` tetap bebas jaringan. */
export type InsightReader = (
  summary: string | null,
  turns: ConversationTurn[],
  ownerId?: string,
) => Promise<InsightDraft | null>;

/**
 * Mengurus catatan tersembunyi tentang seorang pengguna.
 *
 * Dua pekerjaan yang berbeda ritmenya. `refresh` berjalan di latar setelah
 * balasan terkirim, menumpang jadwal yang sama dengan pemadatan riwayat,
 * sehingga pengguna tidak pernah menunggunya. `record` berjalan seketika,
 * karena giliran yang berbahaya justru yang paling tidak boleh hilang kalau
 * proses berhenti.
 */
export class InsightService {
  private readonly generations = new Map<string, number>();
  private readonly ownerQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: InsightRepository,
    private readonly read: InsightReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(ownerId: string): Promise<UserInsight> {
    return this.exclusiveOwner(ownerId, async () => {
      const current =
        (await this.repository.load(ownerId)) ?? emptyInsight(ownerId);
      const retained = this.retainedNotes(current.catatan);
      const hasLegacyInference =
        current.gaya !== null ||
        current.tahap !== null ||
        current.kerentanan !== null ||
        current.terakhirMenyarankanBantuan !== null;
      if (retained.length !== current.catatan.length || hasLegacyInference) {
        const pruned = {
          ...current,
          gaya: null,
          tahap: null,
          kerentanan: null,
          terakhirMenyarankanBantuan: null,
          catatan: retained,
          updatedAt: this.now().toISOString(),
        };
        await this.repository.save(pruned);
        return pruned;
      }
      return current;
    });
  }

  /**
   * Memperbarui pemahaman dari seluruh riwayat yang masih ada.
   *
   * Kegagalannya sengaja tidak dilempar: ini pekerjaan latar, dan percakapan
   * berikutnya tetap harus berjalan meskipun pemahamannya tertinggal satu
   * putaran.
   */
  async refresh(
    ownerId: string,
    summary: string | null,
    turns: ConversationTurn[],
  ): Promise<void> {
    // Inferensi gaya/tahap/kerentanan ditangguhkan lewat ADR-008. Metode lama
    // dipertahankan agar adapter lama tidak patah, tetapi tidak lagi memanggil
    // model ataupun menulis inferensi baru. `load` sekaligus memigrasikan field
    // lama menjadi kosong.
    void summary;
    void turns;
    void this.read;
    await this.load(ownerId);
  }

  /** Mencatat satu giliran berisiko. Yang biasa tidak pernah dicatat. */
  async record(
    ownerId: string,
    level: RiskLevel,
    ringkasan: string,
    tindakan: string,
  ): Promise<void> {
    if (!worthRecording(level) || level !== "bahaya") return;

    await this.exclusiveOwner(ownerId, async () => {
      const current =
        (await this.repository.load(ownerId)) ?? emptyInsight(ownerId);
      const note: SafetyNote = {
        at: this.now().toISOString(),
        level,
        ringkasan: ringkasan.trim() || "(tidak dicatat)",
        tindakan: tindakan.trim() || "(tidak dicatat)",
      };

      await this.repository.save({
        ...current,
        gaya: null,
        tahap: null,
        kerentanan: null,
        terakhirMenyarankanBantuan: null,
        catatan: this.retainedNotes([...current.catatan, note]).slice(
          -SAFETY_NOTE_LIMIT,
        ),
        updatedAt: this.now().toISOString(),
      });
    });
  }

  /**
   * Apakah percakapan ini saat yang tepat mengangkat bantuan profesional.
   *
   * Bukan pada giliran yang sedang berat — saat itu yang dibutuhkan ditemani,
   * bukan dirujuk — melainkan pada percakapan tenang beberapa hari sesudahnya.
   */
  async shouldRaiseHelp(ownerId: string, level: RiskLevel): Promise<boolean> {
    // Ditangguhkan sampai evaluasi percakapan membuktikan bahwa false positive
    // triase tidak berubah menjadi desakan bantuan profesional beberapa hari
    // kemudian. Parameter dipertahankan agar kontrak pemanggil stabil.
    void ownerId;
    void level;
    return false;
  }

  async markHelpSuggested(ownerId: string): Promise<void> {
    // Nudge profesional dan timestamp tersembunyinya ditangguhkan bersama
    // inferensi lain. Parameter dipertahankan agar kontrak lama tidak pecah.
    void ownerId;
  }

  /** Pasal 4 nomor 6: catatan ini ikut terhapus bersama data lainnya. */
  async forget(ownerId: string): Promise<void> {
    await this.exclusiveOwner(ownerId, async () => {
      this.generations.set(ownerId, this.generation(ownerId) + 1);
      await this.repository.remove(ownerId);
    });
  }

  private generation(ownerId: string): number {
    return this.generations.get(ownerId) ?? 0;
  }

  private retainedNotes(notes: SafetyNote[]): SafetyNote[] {
    const threshold = this.now().getTime() - SAFETY_NOTE_RETENTION_MS;
    return notes.filter((note) => {
      const at = new Date(note.at).getTime();
      return Number.isFinite(at) && at >= threshold;
    });
  }

  private async exclusiveOwner<T>(
    ownerId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.ownerQueues.get(ownerId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.ownerQueues.set(ownerId, settled);

    try {
      return await result;
    } finally {
      if (this.ownerQueues.get(ownerId) === settled) {
        this.ownerQueues.delete(ownerId);
      }
    }
  }
}
