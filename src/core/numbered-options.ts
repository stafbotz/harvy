/**
 * Pilihan bernomor yang baru saja ditampilkan kepada satu pengguna.
 *
 * Menjawab dengan mengetik "2" hanya berguna bila nomor itu menunjuk hal yang
 * sama dengan yang orangnya lihat. Dua sifat menjaga itu, dan keduanya dipilih
 * karena mode kegagalannya mahal—salah nomor pada pembatalan berarti menghapus
 * tugas yang salah:
 *
 * 1. **Nomor menyimpan kalimat, bukan identifier.** Yang tercatat adalah frasa
 *    yang setara dengan mengetiknya sendiri, lalu frasa itu mengalir lewat
 *    jalur biasa dengan seluruh pagar authority-nya. Nomor karena itu tidak
 *    pernah memberi wewenang apa pun; pemetaan yang basi paling jauh
 *    menghasilkan pertanyaan, bukan tindakan yang salah.
 * 2. **Hanya satu pemetaan per pengguna, dan ia kedaluwarsa.** Daftar yang lebih
 *    baru menggantikan yang lama seluruhnya. Tidak ada tumpukan nomor dari dua
 *    daftar berbeda yang dapat tertukar.
 *
 * State ini process-local dan hilang saat restart. Itu disengaja: ia navigasi,
 * bukan data pengguna.
 */
export interface NumberedOptionSet {
  /** Frasa per nomor, indeks 0 untuk nomor 1. */
  phrases: readonly string[];
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const MAX_OPTIONS = 9;

/**
 * Bentuk balasan yang benar-benar berarti "pilih nomor sekian".
 *
 * Sengaja sempit. "2" dan "nomor 2" jelas; kalimat yang kebetulan memuat angka
 * tidak. Pengguna yang menulis "aku mau yang 2 dulu" sedang bicara, bukan
 * memilih dari menu, dan menafsirkannya sebagai pilihan menu akan salah pada
 * kalimat yang paling wajar.
 */
const NUMBERED_REPLY =
  /^(?:no\.?|nomor|nomer|pilih(?:an)?|opsi)?\s*([1-9])\s*(?:\.|\))?$/iu;

export function parseNumberedReply(message: string): number | null {
  const match = NUMBERED_REPLY.exec(message.trim());
  if (!match?.[1]) return null;
  return Number(match[1]);
}

export class NumberedOptionStore {
  private readonly entries = new Map<string, NumberedOptionSet>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Daftar baru menggantikan yang lama seluruhnya. */
  record(ownerId: string, phrases: readonly string[]): void {
    const bounded = phrases.slice(0, MAX_OPTIONS).map((phrase) => phrase.trim())
      .filter(Boolean);
    if (bounded.length === 0) {
      this.entries.delete(ownerId);
      return;
    }
    this.entries.set(ownerId, {
      phrases: Object.freeze(bounded),
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /** Frasa untuk nomor tersebut, atau null bila tidak ada atau sudah lewat. */
  resolve(ownerId: string, choice: number): string | null {
    const entry = this.entries.get(ownerId);
    if (!entry) return null;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(ownerId);
      return null;
    }
    return entry.phrases[choice - 1] ?? null;
  }

  forget(ownerId: string): void {
    this.entries.delete(ownerId);
  }
}
