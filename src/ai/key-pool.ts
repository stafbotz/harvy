/**
 * Kumpulan kunci API yang dipakai bergantian.
 *
 * Rotation tetap provider-local: kelas ini tidak memilih provider cadangan dan
 * tidak mengubah batas layanan. Composition GMI saat ini memasang satu key;
 * dukungan lebih dari satu key dipertahankan untuk caller generik dan fault
 * test yang memang membutuhkannya.
 */
export class ApiKeyPool {
  private index = 0;

  constructor(private readonly keys: readonly string[]) {
    if (keys.length === 0) {
      throw new Error("Minimal satu kunci API harus tersedia.");
    }
  }

  get size(): number {
    return this.keys.length;
  }

  /** Mengambil kunci berikutnya secara bergiliran. */
  take(): string {
    const key = this.keys[this.index] as string;
    this.index = (this.index + 1) % this.keys.length;
    return key;
  }

  /**
   * Memisahkan daftar kunci dari satu baris environment.
   *
   * Menerima satu kunci maupun banyak kunci yang dipisah koma atau baris baru.
   */
  static parse(raw: string | undefined): string[] {
    return (raw ?? "")
      .split(/[,\n]/)
      .map((key) => key.trim())
      .filter((key) => key.length > 0);
  }
}
