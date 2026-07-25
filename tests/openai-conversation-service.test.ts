import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_AI_OUTPUT_TOKENS,
  OpenAIConversationService,
  type OpenAIResponseRequest,
  type OpenAIResponsesClient,
} from "../src/ai/conversation-service.js";
import { HARVY_INSTRUCTIONS } from "../src/ai/harvy-instructions.js";

describe("OpenAIConversationService", () => {
  it("memakai Responses API tanpa penyimpanan dan tanpa ID pengguna", async () => {
    const client = new RecordingResponsesClient("  Jawaban Harvy  ");
    const service = new OpenAIConversationService(
      {
        apiKey: "test-api-key",
        model: "gpt-5.6-luna",
        timeoutMs: 30_000,
      },
      client,
    );

    const result = await service.reply({
      message: "Aku bingung memilih kegiatan.",
      history: [
        { role: "user", content: "Aku punya dua pilihan." },
        { role: "assistant", content: "Apa dua pilihannya?" },
      ],
    });

    assert.equal(result, "Jawaban Harvy");
    assert.deepEqual(client.requests, [
      {
        model: "gpt-5.6-luna",
        instructions: HARVY_INSTRUCTIONS,
        input: [
          { role: "user", content: "Aku punya dua pilihan." },
          { role: "assistant", content: "Apa dua pilihannya?" },
          { role: "user", content: "Aku bingung memilih kegiatan." },
        ],
        store: false,
        max_output_tokens: MAX_AI_OUTPUT_TOKENS,
        reasoning: { effort: "low" },
        moderation: {
          model: "omni-moderation-latest",
          policy: {
            input: { mode: "score" },
            output: { mode: "block" },
          },
        },
      },
    ]);
    assert.equal(JSON.stringify(client.requests).includes("telegram"), false);
    assert.equal(JSON.stringify(client.requests).includes("ownerId"), false);
  });

  it("menolak output kosong agar bot dapat memberi fallback", async () => {
    const service = new OpenAIConversationService(
      {
        apiKey: "test-api-key",
        model: "gpt-5.6-luna",
        timeoutMs: 30_000,
      },
      new RecordingResponsesClient("   "),
    );

    await assert.rejects(
      service.reply({ message: "Halo", history: [] }),
      /Model mengembalikan respons kosong/,
    );
  });

  it("instruksi memuat identitas, lima konteks, dan batas utama Harvy", () => {
    for (const phrase of [
      "AI pendamping kehidupan pelajar Indonesia",
      "kewajiban sehari-hari",
      "belajar lintas pelajaran",
      "keputusan dan perencanaan",
      "kewalahan atau refleksi ringan",
      "meminta bantuan kepada manusia",
      "konteks aktif sementara",
      "Jangan mendiagnosis",
    ]) {
      assert.equal(HARVY_INSTRUCTIONS.includes(phrase), true, phrase);
    }
  });
});

class RecordingResponsesClient implements OpenAIResponsesClient {
  readonly requests: OpenAIResponseRequest[] = [];

  constructor(private readonly response: string) {}

  async create(request: OpenAIResponseRequest): Promise<{
    output_text: string;
  }> {
    this.requests.push(request);
    return { output_text: this.response };
  }
}
