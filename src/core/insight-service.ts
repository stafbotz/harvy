import type { ConversationTurn } from "../domain/history.js";
import {
  emptyInsight,
  type InsightRepository,
  type SafetyNote,
  type UserInsight,
} from "../domain/insight.js";
import {
  shouldRaiseProfessionalHelp,
  worthRecording,
  type RiskLevel,
} from "./safety-policy.js";

/** Berapa banyak giliran berisiko yang disimpan sebelum yang terlama dibuang. */
export const SAFETY_NOTE_LIMIT = 20;

export interface InsightDraft {
  gaya: string | null;
  tahap: string | null;
  kerentanan: string | null;
}

/** Peringkas pemahaman diberikan dari luar supaya `core/` tetap bebas jaringan. */
export type InsightReader = (
  summary: string | null,
  turns: ConversationTurn[],
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
  constructor(
    private readonly repository: InsightRepository,
    private readonly read: InsightReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(ownerId: string): Promise<UserInsight> {
    return (await this.repository.load(ownerId)) ?? emptyInsight(ownerId);
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
    if (turns.length === 0 && !summary) return;

    let draft: InsightDraft | null;
    try {
      draft = await this.read(summary, turns);
    } catch (error) {
      console.warn("Pemahaman pengguna gagal diperbarui:", error);
      return;
    }
    if (!draft) return;

    const current = await this.load(ownerId);
    await this.repository.save({
      ...current,
      gaya: draft.gaya ?? current.gaya,
      tahap: draft.tahap ?? current.tahap,
      kerentanan: draft.kerentanan ?? current.kerentanan,
      updatedAt: this.now().toISOString(),
    });
  }

  /** Mencatat satu giliran berisiko. Yang biasa tidak pernah dicatat. */
  async record(
    ownerId: string,
    level: RiskLevel,
    ringkasan: string,
    tindakan: string,
  ): Promise<void> {
    if (!worthRecording(level)) return;

    const current = await this.load(ownerId);
    const note: SafetyNote = {
      at: this.now().toISOString(),
      level,
      ringkasan: ringkasan.trim() || "(tidak dicatat)",
      tindakan: tindakan.trim() || "(tidak dicatat)",
    };

    await this.repository.save({
      ...current,
      catatan: [...current.catatan, note].slice(-SAFETY_NOTE_LIMIT),
      updatedAt: this.now().toISOString(),
    });
  }

  /**
   * Apakah percakapan ini saat yang tepat mengangkat bantuan profesional.
   *
   * Bukan pada giliran yang sedang berat — saat itu yang dibutuhkan ditemani,
   * bukan dirujuk — melainkan pada percakapan tenang beberapa hari sesudahnya.
   */
  async shouldRaiseHelp(ownerId: string, level: RiskLevel): Promise<boolean> {
    const insight = await this.load(ownerId);
    const lastRisk = insight.catatan.at(-1)?.at ?? null;

    return shouldRaiseProfessionalHelp(
      {
        lastSuggestedAt: insight.terakhirMenyarankanBantuan,
        lastRiskAt: lastRisk,
        level,
      },
      this.now(),
    );
  }

  async markHelpSuggested(ownerId: string): Promise<void> {
    const current = await this.load(ownerId);
    await this.repository.save({
      ...current,
      terakhirMenyarankanBantuan: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    });
  }

  /** Pasal 4 nomor 6: catatan ini ikut terhapus bersama data lainnya. */
  async forget(ownerId: string): Promise<void> {
    await this.repository.remove(ownerId);
  }
}
