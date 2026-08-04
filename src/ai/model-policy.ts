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
import type { RiskLevel } from "../core/safety-policy.js";

export type ModelTier = "cheap" | "efficient" | "ambitious";

export type ConversationIntent =
  | "task"
  | "feeling"
  | "question"
  | "request"
  | "research"
  | "smalltalk"
  | "history"
  | "memory"
  | "control";

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
  /** Hasil triase risiko, bila pemeriksaannya sempat berjalan. */
  risk?: RiskLevel;
}

export type AgentRoutingMode = "tools" | "orchestrate";

/** Di atas panjang ini, sebuah pertanyaan dianggap berpotensi berlapis. */
const LONG_MESSAGE = 280;

/**
 * Route agent baru cheap-first. Ia hanya dipanggil sesudah triase menyatakan
 * giliran biasa dan pasti; keselamatan serta sesi tetap memakai policy lama.
 */
export function selectAgentMode(input: RoutingInput): AgentRoutingMode {
  return input.needsStepByStep || input.messageLength > LONG_MESSAGE
    ? "orchestrate"
    : "tools";
}

export function selectTier(input: RoutingInput): ModelTier {
  // Keselamatan memakai `efficient`, bukan `ambitious`. Keputusan pemilik
  // produk pada 27 Juli 2026: di produksi tingkatan ini adalah GPT 5.6 Luna,
  // dan itu dinilai cukup untuk percakapan yang berat. Tingkatan tertinggi
  // disimpan untuk pekerjaan yang memang membutuhkan penalaran panjang.
  // `PROJECT.md` dan `ADR-003` sudah diselaraskan dengan keputusan ini.
  if (input.risk === "dukungan" || input.risk === "bahaya") return "efficient";
  if (input.safetySensitive) return "efficient";

  switch (input.intent) {
    case "question":
    case "request":
      return input.needsStepByStep || input.messageLength > LONG_MESSAGE
        ? "ambitious"
        : "efficient";

    case "research":
      // Planner awal boleh murah, tetapi jawaban biasa yang sampai ke jalur
      // percakapan tetap perlu memahami permintaan sumber dengan baik.
      return "efficient";

    case "feeling":
      // Menanggapi keadaan diri butuh kepekaan bahasa, bukan penalaran berat.
      return "efficient";

    case "task":
    case "smalltalk":
    case "history":
    case "control":
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
    testingModels?: Partial<Record<ModelTier, string>>;
    models: Record<ModelTier, string>;
  },
): string {
  if (routing.mode !== "testing") return routing.models[tier];

  // Peta per tingkatan boleh diisi sebagian. Yang tidak diisi jatuh ke satu
  // model uji, seperti sebelumnya — tetapi begitu satu tingkatan diberi model
  // sendiri, routing akhirnya dapat diamati tanpa membayar harga produksi.
  return routing.testingModels?.[tier] || routing.testingModel;
}
