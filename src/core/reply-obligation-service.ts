import { randomUUID } from "node:crypto";
import type {
  ReplyObligation,
  ReplyObligationChannel,
  ReplyObligationOwnerProcess,
  ReplyObligationRepository,
} from "../domain/reply-obligation.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";

/**
 * Batas usia sebuah janji.
 *
 * Balasan yang tiba lima belas menit terlambat lebih buruk daripada tidak ada:
 * percakapannya sudah bergerak, dan jawaban atas pertanyaan lama justru
 * mengganggu. Alasan yang sama dipakai `DeferredTurnRetry` untuk membatalkan
 * diri begitu penggunanya bicara lagi.
 */
export const REPLY_OBLIGATION_MAX_AGE_MS = 15 * 60 * 1_000;

/** Berapa kali sebuah janji boleh dicoba sebelum ditinggalkan. */
export const REPLY_OBLIGATION_MAX_ATTEMPTS = 2;

/** Plafon panjang teks yang disimpan; balasan lebih panjang dipotong. */
export const REPLY_OBLIGATION_MAX_CHARACTERS = 8_000;

/** Plafon jumlah janji tertunggak, agar berkasnya tidak pernah membengkak. */
export const REPLY_OBLIGATION_LIMIT = 64;

export interface RecoverableReply {
  obligation: ReplyObligation;
  /**
   * `true` bila pengiriman sudah sempat dimulai, sehingga Telegram mungkin
   * telah menerimanya. Pemanggil wajib menandai balasan seperti ini.
   */
  possiblyDelivered: boolean;
}

/**
 * Mengurus janji balasan yang belum terbukti sampai.
 *
 * Seluruh metode **best-effort**: kegagalan penyimpanan tidak boleh menahan
 * atau memperlambat pengiriman yang sebenarnya. Aturan yang sama dengan yang
 * sudah berlaku di `AGENTS.md` untuk pengumpulan bukti—observability tidak
 * pernah menjadi sebab giliran gagal—dan di sini taruhannya lebih tinggi,
 * karena yang dijaga justru pengiriman itu sendiri.
 */
export class ReplyObligationService {
  constructor(
    private readonly repository: ReplyObligationRepository,
    private readonly ownerProcess: ReplyObligationOwnerProcess,
    private readonly now: () => Date = () => new Date(),
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.reply-obligation"),
  ) {}

  /**
   * Mencatat bahwa satu balasan akan dikirim.
   *
   * Ditunggu pemanggil, dan hanya ini yang ditunggu: baris ini harus sudah
   * durable sebelum byte pertama berangkat, kalau tidak crash pada jendela
   * yang sama persis tidak meninggalkan apa pun untuk dipulihkan.
   *
   * Mengembalikan `null` bila pencatatan gagal atau tidak diperlukan.
   * Pemanggil tetap mengirim; yang hilang hanya jaring pengamannya.
   */
  async record(input: {
    ownerId: string;
    chatId: string;
    channel: ReplyObligationChannel;
    text: string;
  }): Promise<string | null> {
    const text = input.text.trim();
    if (!text) return null;
    const at = this.now().toISOString();
    const obligation: ReplyObligation = {
      id: randomUUID().replaceAll("-", "").slice(0, 12),
      ownerId: input.ownerId,
      chatId: input.chatId,
      channel: input.channel,
      text: text.length > REPLY_OBLIGATION_MAX_CHARACTERS
        ? text.slice(0, REPLY_OBLIGATION_MAX_CHARACTERS)
        : text,
      state: "pending",
      attempts: 0,
      createdAt: at,
      updatedAt: at,
      ownerProcess: this.ownerProcess,
    };
    try {
      await this.repository.save(obligation);
      return obligation.id;
    } catch (error) {
      this.logger.warn(
        "reply_obligation_record_failed",
        "Janji balasan gagal dicatat; pengiriman tetap berjalan tanpa jaring pengaman.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
      return null;
    }
  }

  /**
   * Menandai bahwa I/O pengiriman dimulai.
   *
   * Sesudah titik ini hasilnya tidak lagi dapat dibuktikan dari sisi Harvy,
   * dan pemulihan wajib memakai penanda.
   */
  async markAttempting(id: string | null): Promise<void> {
    await this.transition(id, (obligation) => ({
      ...obligation,
      state: "attempting",
      attempts: obligation.attempts + 1,
      updatedAt: this.now().toISOString(),
    }));
  }

  /** Menandai bahwa balasan benar-benar sampai. Janji dilepas. */
  async settle(id: string | null): Promise<void> {
    if (!id) return;
    try {
      await this.repository.remove(id);
    } catch (error) {
      this.logger.warn(
        "reply_obligation_settle_failed",
        "Janji balasan gagal dilepas; sapuan berikutnya akan menanganinya.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    }
  }

  /**
   * Janji yang layak dikirim ulang setelah restart.
   *
   * Hanya milik proses yang sudah mati. Baris milik proses yang masih hidup
   * tidak pernah diklaim: pengirimannya barangkali sedang berjalan, dan
   * mengambilnya berarti mengirim dua kali dengan sengaja.
   *
   * Yang terlalu tua atau sudah kehabisan percobaan ditinggalkan, bukan
   * dikirim. Fungsi ini membersihkannya sekaligus.
   */
  async recover(): Promise<RecoverableReply[]> {
    let unsettled: ReplyObligation[];
    try {
      unsettled = await this.repository.listUnsettled();
    } catch (error) {
      this.logger.warn(
        "reply_obligation_sweep_failed",
        "Sapuan janji balasan gagal dibaca.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
      return [];
    }

    const at = this.now();
    const recoverable: RecoverableReply[] = [];
    for (const obligation of unsettled) {
      if (this.processIsAlive(obligation.ownerProcess)) continue;
      const tooOld = at.getTime() - Date.parse(obligation.createdAt) >
        REPLY_OBLIGATION_MAX_AGE_MS;
      const exhausted = obligation.attempts >= REPLY_OBLIGATION_MAX_ATTEMPTS;
      if (tooOld || exhausted) {
        this.logger.info(
          "reply_obligation_abandoned",
          "Janji balasan ditinggalkan tanpa dikirim ulang.",
          {
            reason: tooOld ? "kedaluwarsa" : "percobaan_habis",
            attempts: obligation.attempts,
          },
        );
        await this.settle(obligation.id);
        continue;
      }
      recoverable.push({
        obligation,
        possiblyDelivered: obligation.state === "attempting",
      });
    }
    return recoverable;
  }

  /** Seluruh janji milik seorang pengguna, untuk ekspor data. */
  async list(ownerId: string): Promise<ReplyObligation[]> {
    try {
      return await this.repository.list(ownerId);
    } catch {
      return [];
    }
  }

  /** Menghapus seluruh janji milik seorang pengguna. */
  async forgetOwner(ownerId: string): Promise<number> {
    try {
      return await this.repository.removeAll(ownerId);
    } catch (error) {
      this.logger.warn(
        "reply_obligation_delete_failed",
        "Janji balasan gagal dihapus bersama data pengguna.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
      return 0;
    }
  }

  /**
   * Apakah proses pemegang janji masih hidup.
   *
   * PID dibandingkan bersama waktu mulai, karena sistem operasi memakai ulang
   * nomor PID. Proses yang sedang berjalan sekarang selalu dianggap hidup.
   */
  private processIsAlive(owner: ReplyObligationOwnerProcess): boolean {
    return owner.pid === this.ownerProcess.pid &&
      owner.startedAt === this.ownerProcess.startedAt;
  }

  private async transition(
    id: string | null,
    change: (obligation: ReplyObligation) => ReplyObligation,
  ): Promise<void> {
    if (!id) return;
    try {
      const stored = (await this.repository.listUnsettled())
        .find((item) => item.id === id);
      if (!stored) return;
      await this.repository.save(change(stored));
    } catch (error) {
      this.logger.warn(
        "reply_obligation_transition_failed",
        "Perubahan keadaan janji balasan gagal disimpan.",
        { errorType: error instanceof Error ? error.name : "unknown" },
      );
    }
  }
}
