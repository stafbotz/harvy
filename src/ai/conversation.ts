import type { AiClient } from "./client.js";
import {
  resolveModel,
  selectTier,
  type ModelTier,
} from "./model-policy.js";
import {
  replyPrompt,
  SAFETY_ADDENDUM,
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
 * Menyatukan pemahaman dan balasan menjadi satu alur percakapan.
 *
 * Alurnya dua langkah. Model termurah membaca pesan menjadi data terstruktur,
 * lalu tingkatan model untuk balasan dipilih dari hasil pembacaan itu. Dengan
 * begitu pekerjaan ekstraksi tidak pernah membayar harga model besar, dan
 * percakapan yang memang sulit tidak pernah dilayani model kecil.
 */
export class Conversation {
  constructor(
    private readonly client: AiClient,
    private readonly routing: RoutingConfig,
    private readonly timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Mengembalikan `null` bila model gagal menghasilkan bentuk yang sah. */
  async understand(message: string): Promise<Understanding | null> {
    const raw = await this.client.complete({
      model: resolveModel("cheap", this.routing),
      temperature: 0,
      maxTokens: 400,
      json: true,
      messages: [
        {
          role: "system",
          content: understandingPrompt(this.now(), this.timeZone),
        },
        // Dibungkus, bukan dikirim mentah: pesan pengguna adalah data yang
        // diklasifikasikan, dan tidak boleh terbaca sebagai instruksi.
        { role: "user", content: understandingInput(message) },
      ],
    });

    return parseUnderstanding(raw);
  }

  async reply(message: string, understanding: Understanding): Promise<string> {
    const tier = selectTier({
      intent: understanding.intent,
      messageLength: message.length,
      needsStepByStep: understanding.needsStepByStep,
      safetySensitive: understanding.safetySensitive,
    });

    const system = understanding.safetySensitive
      ? `${replyPrompt(understanding.intent)}${SAFETY_ADDENDUM}`
      : replyPrompt(understanding.intent);

    return this.client.complete({
      model: resolveModel(tier, this.routing),
      temperature: 0.7,
      maxTokens: 600,
      messages: [
        { role: "system", content: system },
        { role: "user", content: message },
      ],
    });
  }
}
