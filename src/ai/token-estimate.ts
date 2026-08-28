/**
 * Satu sumber kebenaran untuk perkiraan token.
 *
 * Sebelumnya angka ini tersebar: `client.ts` membagi karakter dengan 4 di dua
 * tempat, sementara anggaran konteks memakai konstanta 4,18 sendiri. Dua sumber
 * yang tidak saling tahu berarti anggaran dan reservasi budget dapat berbeda
 * pendapat tentang request yang sama.
 *
 * Nilai default sengaja 4, bukan 4,18 yang terukur untuk prosa Indonesia pada
 * MiniMax-M3. Perkiraan yang sedikit terlalu tinggi membuat reservasi budget
 * gagal ke sisi aman; perkiraan yang terlalu rendah menjanjikan ruang yang tidak
 * ada. Selisih ~4% itu adalah margin yang dipilih, bukan kekeliruan.
 *
 * Harvy tidak akan memakai satu model selamanya, jadi rasio yang benar berbeda
 * per model dan tidak dapat dipatok di kode. `TokenRatioCalibration` menajamkan
 * angka itu dari `usage` yang memang sudah dikembalikan provider pada setiap
 * respons.
 */

/** Dipakai sebelum sebuah model punya observasi nyata. */
export const DEFAULT_CHARACTERS_PER_TOKEN = 4;

/** Batas kewarasan; rasio di luar rentang ini menandakan payload aneh. */
const MIN_CHARACTERS_PER_TOKEN = 1.5;
const MAX_CHARACTERS_PER_TOKEN = 12;

/** Observasi minimum sebelum kalibrasi menggantikan default. */
const MIN_OBSERVATIONS = 5;

/** Bobot observasi terbaru pada rata-rata bergerak eksponensial. */
const SMOOTHING = 0.2;

export function estimateTokens(
  characters: number,
  charactersPerToken: number = DEFAULT_CHARACTERS_PER_TOKEN,
): number {
  if (characters <= 0) return 0;
  const ratio = usableRatio(charactersPerToken)
    ? charactersPerToken
    : DEFAULT_CHARACTERS_PER_TOKEN;
  return Math.ceil(characters / ratio);
}

interface ModelRatio {
  ratio: number;
  observations: number;
}

/**
 * Kalibrasi karakter-per-token per model dari pemakaian nyata.
 *
 * Sengaja dimiliki per instance `AiClient`, bukan global. State global akan
 * membuat urutan tes saling memengaruhi, dan deployment dengan beberapa
 * provider akan mencampur rasio yang tidak sebanding.
 */
export class TokenRatioCalibration {
  private readonly byModel = new Map<string, ModelRatio>();

  /**
   * Mencatat satu pengamatan. `characters` adalah ukuran wire yang dipakai
   * saat memperkirakan, `tokens` adalah angka yang benar-benar dilaporkan
   * provider. Pengamatan yang tidak masuk akal diabaikan diam-diam agar satu
   * respons rusak tidak merusak anggaran seluruh proses.
   */
  observe(modelId: string, characters: number, tokens: number): void {
    if (!modelId || characters <= 0 || !Number.isFinite(tokens) || tokens <= 0) {
      return;
    }
    const observed = characters / tokens;
    if (!usableRatio(observed)) return;

    const current = this.byModel.get(modelId);
    if (!current) {
      this.byModel.set(modelId, { ratio: observed, observations: 1 });
      return;
    }
    this.byModel.set(modelId, {
      ratio: current.ratio + (observed - current.ratio) * SMOOTHING,
      observations: current.observations + 1,
    });
  }

  /** Rasio terkalibrasi bila cukup bukti; selain itu default konservatif. */
  charactersPerToken(modelId: string): number {
    const current = this.byModel.get(modelId);
    return current && current.observations >= MIN_OBSERVATIONS
      ? current.ratio
      : DEFAULT_CHARACTERS_PER_TOKEN;
  }

  /** Bebas isi; aman untuk observability. */
  snapshot(): ReadonlyArray<{ modelId: string; ratio: number; observations: number }> {
    return [...this.byModel].map(([modelId, value]) => ({
      modelId,
      ratio: Math.round(value.ratio * 100) / 100,
      observations: value.observations,
    }));
  }
}

function usableRatio(value: number): boolean {
  return Number.isFinite(value) &&
    value >= MIN_CHARACTERS_PER_TOKEN &&
    value <= MAX_CHARACTERS_PER_TOKEN;
}
