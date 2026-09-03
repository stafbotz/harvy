import type {
  AbuseAction,
  AbuseCategory,
  AbuseRecord,
  AbuseRepository,
} from "../domain/abuse.js";
import {
  ABUSE_SUSPENSION_TTL_MS,
  ABUSE_WARNING_TTL_MS,
  activeSuspension,
  decideAbuseAction,
  suspensionAllowsTurn,
  type AbuseSignal,
} from "./abuse-policy.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

/**
 * Menjalankan kebijakan pencegahan penyalahgunaan. Lihat ADR-045.
 *
 * Seluruh keputusannya ada di `abuse-policy.ts` yang murni; berkas ini hanya
 * memegang penyimpanan, pemangkasan riwayat, dan pelaporan. Pemisahan itu
 * disengaja: aturan yang menentukan apakah seorang pelajar kehilangan akses
 * harus dapat diuji tanpa satu pun berkas atau jam nyata.
 */
export interface AbuseReport {
  ownerId: string;
  category: AbuseCategory;
  action: AbuseAction;
  warningCount: number;
}

export class AbuseService {
  constructor(
    private readonly repository: AbuseRepository,
    private readonly now: () => number = () => Date.now(),
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.abuse"),
    /**
     * Dipanggil hanya saat penangguhan, tidak pernah saat peringatan.
     *
     * Pemberitahuan yang terlalu sering akan dibisukan pengelolanya, dan
     * sesudah itu yang penting ikut tidak terbaca.
     */
    private readonly notifyOperator?: (report: AbuseReport) => Promise<void>,
  ) {}

  /**
   * Apakah giliran ini boleh berjalan seperti biasa.
   *
   * `distress` selalu menang. Penangguhan menutup percakapan biasa; ia tidak
   * pernah menutup keselamatan.
   */
  async allowsTurn(ownerId: string, distress: boolean): Promise<boolean> {
    const record = await this.repository.load(ownerId);
    return suspensionAllowsTurn(record, this.now(), distress);
  }

  /** Penangguhan yang sedang berjalan, untuk menyusun pemberitahuannya. */
  async currentSuspension(ownerId: string) {
    const record = await this.repository.load(ownerId);
    return activeSuspension(record, this.now());
  }

  /**
   * Menilai satu sinyal dan menerapkan akibatnya.
   *
   * Mengembalikan tindakan yang diambil supaya adapter dapat menyusun kalimat
   * yang sesuai. Adapter tidak pernah memutuskan sendiri.
   */
  async observe(ownerId: string, signal: AbuseSignal): Promise<AbuseAction> {
    const nowMs = this.now();
    const record = await this.repository.load(ownerId);
    const action = decideAbuseAction(record, signal, nowMs);

    const next: AbuseRecord = {
      ownerId,
      warnings: this.prune(record.warnings, nowMs, ABUSE_WARNING_TTL_MS),
      suspensions: this.prune(
        record.suspensions,
        nowMs,
        ABUSE_SUSPENSION_TTL_MS,
      ),
    };

    if (action.kind === "warn") {
      next.warnings = [
        ...next.warnings,
        { category: signal.category, atMs: nowMs },
      ];
    } else if (action.kind === "suspend" || action.kind === "hold-for-review") {
      next.suspensions = [
        ...next.suspensions,
        {
          category: action.category,
          atMs: nowMs,
          untilMs: action.untilMs,
          review: action.kind === "hold-for-review",
        },
      ];
    }

    if (action.kind !== "record") await this.repository.save(next);

    this.logSafely(() => {
      this.logger.info(
        "abuse_signal_observed",
        "Sinyal penyalahgunaan dinilai.",
        {
          decision: action.kind,
          hintCategory: signal.category,
          certain: signal.grounded,
          warningCount: next.warnings.length,
        },
      );
    });

    if (action.kind === "suspend" || action.kind === "hold-for-review") {
      await this.report({
        ownerId,
        category: action.category,
        action,
        warningCount: next.warnings.length,
      });
    }
    return action;
  }

  /** Data ini ikut terhapus bersama data penggunanya; lihat Pasal 2. */
  async forget(ownerId: string): Promise<void> {
    await this.repository.forget(ownerId);
  }

  private prune<T extends { atMs: number }>(
    items: readonly T[],
    nowMs: number,
    ttlMs: number,
  ): T[] {
    return items.filter((item) => nowMs - item.atMs < ttlMs);
  }

  private async report(report: AbuseReport): Promise<void> {
    if (!this.notifyOperator) return;
    try {
      await this.notifyOperator(report);
    } catch (error) {
      // Laporan yang gagal terkirim tidak boleh membatalkan penangguhannya.
      this.logSafely(() => {
        this.logger.warn(
          "abuse_report_failed",
          "Laporan penyalahgunaan gagal dikirim ke pengelola.",
          { errorType: error instanceof Error ? error.name : "unknown" },
        );
      });
    }
  }

  private logSafely(emit: () => void): void {
    try {
      emit();
    } catch {
      // Pengumpulan bukti tidak boleh menjadi sebab giliran gagal.
    }
  }
}
