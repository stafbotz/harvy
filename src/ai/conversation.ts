import type { ConversationTurn } from "../domain/history.js";
import type { AiClient } from "./client.js";
import { EMPTY_CONTEXT, type HarvyContext } from "./context.js";
import {
  resolveModel,
  selectTier,
  type ModelTier,
} from "./model-policy.js";
import {
  replyPrompt,
  SAFETY_ADDENDUM,
  summaryInput,
  SUMMARY_PROMPT,
  understandingInput,
  understandingPrompt,
} from "./persona.js";
import { parseUnderstanding, type Understanding } from "./understand.js";

export interface RoutingConfig {
  mode: "testing" | "production";
  testingModel: string;
  models: Record<ModelTier, string>;
}

/**
 * Batas token yang lapang, bukan boros.
 *
 * Model penalaran memakai token keluaran untuk berpikir sebelum menulis
 * jawabannya. Dengan batas sempit, seluruh jatah habis di bagian berpikir dan
 * jawabannya terpotong di tengah.
 *
 * Ini bukan dugaan. Pada 26 Juli 2026, dengan batas 400 token,
 * "ingetin aku pukul sebelas lewat 36 menit untuk minum obat" menghasilkan
 * balasan yang berhenti setelah dua baris:
 * `{ "intent": "task", "safetySensitive": false` — tanpa penutup. Sapaan pendek
 * tetap lolos karena hampir tidak perlu berpikir, sehingga cacatnya hanya
 * muncul pada kalimat yang justru paling penting.
 *
 * Batas ini plafon, bukan tagihan: yang dibayar hanya token yang benar-benar
 * dihasilkan.
 */
// Diekspor agar `scripts/coba-pemahaman.ts` memakai angka yang sama persis.
// Skrip itu pernah tertinggal di 400 setelah angka di sini dinaikkan, sehingga
// alat diagnostiknya sendiri mereproduksi cacat yang ia dibuat untuk mencari.
export const UNDERSTANDING_MAX_TOKENS = 2048;
const REPLY_MAX_TOKENS = 1536;

/**
 * Ringkasan sengaja diberi jatah kecil.
 *
 * Ia menggantikan giliran mentah yang dibuang, jadi ringkasan yang panjang
 * menghapus alasan pemadatan itu sendiri.
 */
const SUMMARY_MAX_TOKENS = 512;

/**
 * Menyatukan pemahaman dan balasan menjadi satu alur percakapan.
 *
 * Alurnya dua langkah. Model termurah membaca pesan menjadi data terstruktur,
 * lalu tingkatan model untuk balasan dipilih dari hasil pembacaan itu. Dengan
 * begitu pekerjaan ekstraksi tidak pernah membayar harga model besar, dan
 * percakapan yang memang sulit tidak pernah dilayani model kecil.
 *
 * Konteks — ingatan Harvy tentang penggunanya — masuk ke **kedua** langkah.
 * Memberikannya hanya pada langkah balasan adalah kesalahan yang menggoda:
 * "iya yang tadi itu" gagal dipahami justru di langkah pertama.
 */
export class Conversation {
  constructor(
    private readonly client: AiClient,
    private readonly routing: RoutingConfig,
    private readonly timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Mengembalikan `null` bila model gagal menghasilkan bentuk yang sah. */
  async understand(
    message: string,
    context: HarvyContext = EMPTY_CONTEXT,
  ): Promise<Understanding | null> {
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: UNDERSTANDING_MAX_TOKENS,
      json: true,
      messages: [
        {
          role: "system",
          content: understandingPrompt(this.now(), this.timeZone),
        },
        // Dibungkus, bukan dikirim mentah: pesan pengguna adalah data yang
        // diklasifikasikan, dan tidak boleh terbaca sebagai instruksi. Konteks
        // ikut dibungkus karena isinya juga berasal dari pengguna.
        { role: "user", content: understandingInput(message, context) },
      ],
    });

    const understanding = parseUnderstanding(raw);

    if (!understanding) {
      // Tanpa ini, kegagalan membaca balasan model tidak meninggalkan jejak sama
      // sekali dan hanya terlihat sebagai "aku belum menangkap maksudnya" di
      // sisi pengguna. Dipotong agar log tidak menyimpan seluruh isi percakapan.
      console.warn(
        "Balasan model tidak dapat dibaca:",
        JSON.stringify(raw.slice(0, 300)),
      );
    }

    return understanding;
  }

  async reply(
    message: string,
    understanding: Understanding,
    context: HarvyContext = EMPTY_CONTEXT,
  ): Promise<string> {
    const tier = selectTier({
      intent: understanding.intent,
      messageLength: message.length,
      needsStepByStep: understanding.needsStepByStep,
      safetySensitive: understanding.safetySensitive,
    });

    const base = replyPrompt(understanding.intent, context);
    const system = understanding.safetySensitive
      ? `${base}${SAFETY_ADDENDUM}`
      : base;

    return this.client.complete({
      model: resolveModel(tier, this.routing),
      temperature: 0.7,
      maxTokens: REPLY_MAX_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message },
      ],
    });
  }

  /**
   * Memadatkan giliran lama menjadi satu paragraf.
   *
   * Memakai tingkatan termurah: ini pekerjaan mekanis, dan ia berjalan di luar
   * giliran percakapan sehingga pengguna tidak menunggunya.
   */
  async summarize(
    previousSummary: string | null,
    turns: ConversationTurn[],
  ): Promise<string> {
    return this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: SUMMARY_MAX_TOKENS,
      messages: [
        { role: "system", content: SUMMARY_PROMPT },
        { role: "user", content: summaryInput(previousSummary, turns) },
      ],
    });
  }
}
