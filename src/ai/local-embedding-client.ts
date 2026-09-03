import type { TextEmbeddingProvider } from "../domain/memory-knowledge.js";

/**
 * Penyedia embedding yang berjalan di dalam proses Harvy sendiri.
 *
 * Pencarian memori berdasarkan makna menuntut vektor, dan sampai 3 September
 * 2026 tidak ada satu pun penyedia yang dapat dipakai: GMI melayani 83 model
 * chat tanpa satu pun embedding, daftar OpenRouter 424 model juga nol, dan
 * kuncinya kosong. `searchSemantic` karena itu selalu pulang kosong bukan
 * karena rusak, melainkan karena tidak pernah punya mesin.
 *
 * Menyewa layanan menyelesaikannya, tetapi membuka tiga ongkos sekaligus:
 * setiap hal yang Harvy ingat tentang penggunanya harus dikirim ke perusahaan
 * lain, tiap giliran menambah satu panggilan jaringan (~2,1 detik biaya tetap
 * terukur), dan ada tagihan bulanan. Untuk pendamping pelajar yang seluruh
 * penyimpanannya lokal, yang pertama bukan detail teknis.
 *
 * Model lokal menutup ketiganya. Tidak ada data yang keluar, tidak ada biaya
 * tetap jaringan, tidak ada pihak ketiga yang perlu dipercaya.
 *
 * Harganya jujur: pustakanya berat (`onnxruntime-node` sendiri ~296 MB) dan
 * bobot modelnya diunduh sekali (~120 MB). Karena itu ia dimuat **malas**:
 * tidak ada apa pun yang tersentuh sampai embedding pertama benar-benar
 * diminta, sehingga Harvy yang tidak memakainya tidak membayar apa pun saat
 * start.
 */

/** Simetris, multibahasa, dan tidak menuntut awalan query/passage. */
export const DEFAULT_LOCAL_EMBEDDING_MODEL =
  "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

const MAX_INPUT_CHARACTERS = 2_000;
const MAX_BATCH = 32;
/** Kegagalan memuat berturut-turut sebelum route ini berhenti dicoba. */
const LOAD_FAILURE_LIMIT = 3;
/** Berapa lama berhenti mencoba sesudah batas itu tercapai. */
const LOAD_COOLDOWN_MS = 10 * 60 * 1000;

export interface LocalEmbeddingOptions {
  model?: string;
  /** Folder cache bobot model; default mengikuti pustaka. */
  cacheFolder?: string;
}

/** Bentuk minimal yang dipakai dari pustaka, supaya ia tidak perlu tipe penuh. */
interface FeatureExtractor {
  (
    texts: readonly string[],
    options: { pooling: "mean"; normalize: boolean },
  ): Promise<{ dims: readonly number[]; data: ArrayLike<number> }>;
}

export class LocalTextEmbeddingProvider implements TextEmbeddingProvider {
  readonly modelId: string;
  readonly modelVersion: string;
  private extractor: Promise<FeatureExtractor> | null = null;
  private loadFailures = 0;
  private silentUntil = 0;

  constructor(
    private readonly options: LocalEmbeddingOptions = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.modelId = options.model ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
    // Versi mengikat cache embedding ke model yang menghasilkannya. Tanpa ini,
    // mengganti model membuat vektor lama dan baru tercampur dalam satu ruang
    // yang berbeda, dan kemiripannya menjadi angka yang tidak berarti apa-apa.
    this.modelVersion = `local:${this.modelId}`;
  }

  /**
   * Memuat model sekali, malas, dan hanya sekali walau dipanggil bersamaan.
   *
   * Kegagalan tidak di-cache: pustaka yang belum terpasang atau unduhan yang
   * putus harus dapat dicoba lagi pada giliran berikutnya, bukan mematikan
   * route ini sampai Harvy dimulai ulang.
   */
  private load(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    // Pemutus arus.
    //
    // Route ini hidup secara bawaan, jadi mesin tanpa jaringan untuk
    // unduhan pertama akan mencoba memuat 130 MB pada SETIAP giliran yang
    // memakai pencarian makna, masing-masing dengan jeda panjangnya
    // sendiri. Sesudah beberapa kegagalan berturut-turut, berhenti mencoba
    // sebentar: satu route yang diam jauh lebih murah daripada setiap
    // giliran yang tertahan.
    if (this.now() < this.silentUntil) {
      return Promise.reject(
        new Error("Model embedding lokal sedang dijeda sesudah gagal dimuat."),
      );
    }
    const pending = (async (): Promise<FeatureExtractor> => {
      const library = await import("@huggingface/transformers");
      if (this.options.cacheFolder) {
        library.env.cacheDir = this.options.cacheFolder;
      }
      // Bobot terkuantisasi 8-bit, bukan presisi penuh.
      //
      // Bawaan pustaka pada Node adalah fp32, dan itu mengunduh sekitar
      // empat kali lipat lebih besar serta lebih lambat dihitung. Untuk
      // pencarian kemiripan, yang dipakai hanya urutan peringkat, dan
      // selisih presisinya tidak mengubah urutan itu secara berarti.
      const pipe = await library.pipeline(
        "feature-extraction",
        this.modelId,
        { dtype: "q8" },
      );
      return pipe as unknown as FeatureExtractor;
    })();
    this.extractor = pending;
    pending.then(
      () => {
        this.loadFailures = 0;
      },
      () => {
        // Kegagalan tidak di-cache sebagai keadaan permanen: pustaka yang
        // baru dipasang atau jaringan yang kembali harus bisa dipakai
        // tanpa memulai ulang Harvy.
        this.extractor = null;
        this.loadFailures += 1;
        if (this.loadFailures >= LOAD_FAILURE_LIMIT) {
          this.loadFailures = 0;
          this.silentUntil = this.now() + LOAD_COOLDOWN_MS;
        }
      },
    );
    return pending;
  }

  async embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > MAX_BATCH) {
      throw new Error(
        `Batch embedding lokal dibatasi ${MAX_BATCH} teks per panggilan.`,
      );
    }
    signal?.throwIfAborted();
    const extractor = await this.load();
    signal?.throwIfAborted();

    const bounded = texts.map((text) => {
      const clean = text.replace(/\s+/gu, " ").trim();
      if (!clean) {
        throw new Error("Teks kosong tidak dapat diubah menjadi embedding.");
      }
      return clean.slice(0, MAX_INPUT_CHARACTERS);
    });

    const output = await extractor(bounded, {
      pooling: "mean",
      normalize: true,
    });
    signal?.throwIfAborted();

    const dimension = output.dims.at(-1) ?? 0;
    if (dimension < 1 || output.data.length !== bounded.length * dimension) {
      throw new Error("Keluaran embedding lokal tidak berbentuk sah.");
    }
    // Keluarannya satu larik datar; dipotong per teks. Normalisasi ulang tidak
    // dilakukan di sini karena `validateEmbeddings` sudah melakukannya.
    const vectors: number[][] = [];
    for (let index = 0; index < bounded.length; index += 1) {
      const start = index * dimension;
      const vector: number[] = new Array(dimension);
      for (let axis = 0; axis < dimension; axis += 1) {
        vector[axis] = Number(output.data[start + axis]);
      }
      vectors.push(vector);
    }
    return vectors;
  }
}
