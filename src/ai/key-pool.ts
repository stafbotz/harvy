/**
 * Kumpulan kunci API yang dipakai bergantian.
 *
 * Mode uji memakai kuota gratis Google AI Studio, yang habis lebih cepat
 * daripada pemakaian normal. Menyebar permintaan ke beberapa kunci membuat
 * pengembangan tidak berhenti setiap kali satu kunci kena batas.
 *
 * Ini alat pengembangan, bukan cara menghindari batas layanan. Setiap kunci
 * tetap milik akun yang sama dan tunduk pada ketentuan penyedia.
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
