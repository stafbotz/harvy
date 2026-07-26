/**
 * Memilih model berdasarkan kesulitan pekerjaan, bukan paket yang dibayar
 * pengguna.
 *
 * Ini keputusan produk, bukan sekadar penghematan. `docs/PROJECT.md`
 * menetapkan routing berdasarkan kesulitan tugas, dan Konstitusi Pasal 3.13
 * menempatkan model AI sebagai alat yang tunduk pada kepentingan pengguna.
 * Pelajar yang tidak membayar tetap berhak mendapat model terbaik ketika
 * persoalannya memang sulit.
 *
 * Modul ini murni: tidak memanggil jaringan dan tidak membaca konfigurasi.
 */
export type ModelTier = "cheap" | "efficient" | "ambitious";

export type ConversationIntent =
  | "task"
  | "feeling"
  | "question"
  | "smalltalk"
  | "memory";

export interface RoutingInput {
  intent: ConversationIntent;
  /** Panjang pesan pengguna dalam karakter. */
  messageLength: number;
  /** Pengguna meminta dituntun bertahap, bukan sekadar jawaban. */
  needsStepByStep?: boolean;
  /**
   * Percakapan menyinggung keselamatan, seperti menyakiti diri, kekerasan,
   * pelecehan, atau eksploitasi.
   */
  safetySensitive?: boolean;
}

/** Di atas panjang ini, sebuah pertanyaan dianggap berpotensi berlapis. */
const LONG_MESSAGE = 280;

export function selectTier(input: RoutingInput): ModelTier {
  // Keselamatan tidak pernah dihemat. Pasal 3.8 menuntut respons yang
  // proporsional dan hati-hati, dan itu butuh model terkuat yang tersedia.
  if (input.safetySensitive) return "ambitious";

  switch (input.intent) {
    case "question":
      return input.needsStepByStep || input.messageLength > LONG_MESSAGE
        ? "ambitious"
        : "efficient";

    case "feeling":
      // Menanggapi keadaan diri butuh kepekaan bahasa, bukan penalaran berat.
      return "efficient";

    case "task":
    case "smalltalk":
      // Balasan pendek dan rutin; pekerjaan beratnya sudah selesai di ekstraksi.
      return "cheap";

    case "memory":
      // Pengguna sedang mengurus apa yang Harvy ingat tentang dirinya. Jawabannya
      // disusun kode dari daftar memori, bukan dikarang model.
      return "cheap";
  }
}

/**
 * Menerjemahkan tingkatan menjadi ID model yang benar-benar dipanggil.
 *
 * Selama masa pengembangan seluruh tingkatan mengarah ke satu model uji agar
 * biaya tetap nol. Menghentikan mode uji cukup dengan mengubah `AI_MODE`.
 */
export function resolveModel(
  tier: ModelTier,
  routing: {
    mode: "testing" | "production";
    testingModel: string;
    models: Record<ModelTier, string>;
  },
): string {
  return routing.mode === "testing"
    ? routing.testingModel
    : routing.models[tier];
}
