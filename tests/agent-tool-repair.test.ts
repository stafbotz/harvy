import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AiToolShapeError,
  type AiClient,
  type ChatAssistantToolMessage,
  type ChatFunctionTool,
  type ChatRequest,
  type ChatToolCall,
} from "../src/ai/client.js";
import { Conversation } from "../src/ai/conversation.js";

const PRODUCTION_ROUTING = {
  mode: "production" as const,
  testingModel: "",
  models: {
    cheap: "cheap-model",
    efficient: "efficient-model",
    ambitious: "ambitious-model",
  },
};

const NOW = new Date("2026-08-27T05:00:00.000Z");

/**
 * Sebelum perbaikan ini, satu penyimpangan bentuk mengakhiri seluruh run dan
 * pengguna menerima kalimat buntu tanpa model pernah tahu apa yang salah. Tes
 * ini mengunci koreksi yang dibatasi satu kali beserta isi koreksinya.
 */
describe("perbaikan bentuk native tool call", () => {
  it("memberi koreksi konkret saat model menjawab teks biasa, lalu meneruskan run", async () => {
    const requests: ChatRequest[] = [];
    let call = 0;
    const client = {
      async completeToolTurn(
        request: ChatRequest & { tools: readonly ChatFunctionTool[] },
      ): Promise<ChatAssistantToolMessage> {
        requests.push(request);
        call += 1;
        if (call === 1) {
          throw new AiToolShapeError(
            "missing_tool_call",
            "Model tidak menghasilkan native tool call yang diwajibkan.",
          );
        }
        return assistant([
          toolCall("harvy_final_v1", { reply: "Sudah kucatat ulanganmu." }),
        ]);
      },
    } as unknown as AiClient;

    const result = await conversation(client).agent(
      "Ingetin aku ulangan fisika besok",
      "tools",
      undefined,
      { ownerId: "siswa", channel: "telegram" },
    );

    assert.equal(result.status, "completed");
    assert.equal(requests.length, 2);
    const correction = requests[1]?.messages[0]?.content ?? "";
    assert.match(correction, /teks biasa, bukan function call/u);
    assert.match(correction, /tidak dijalankan maupun dikirim kepada pengguna/u);
  });

  it("mengoreksi argumen yang tidak cocok schema tanpa mengakhiri run", async () => {
    const requests: ChatRequest[] = [];
    let call = 0;
    const client = {
      async completeToolTurn(
        request: ChatRequest & { tools: readonly ChatFunctionTool[] },
      ): Promise<ChatAssistantToolMessage> {
        requests.push(request);
        call += 1;
        // Nama function benar, tetapi field-nya bukan milik schema. Client tidak
        // melempar untuk kasus ini, jadi dulu berakhir sebagai "keputusan tidak
        // sah" dan run mati.
        return assistant([
          call === 1
            ? toolCall("harvy_final_v1", { jawaban: "salah field" })
            : toolCall("harvy_final_v1", { reply: "Ulanganmu sudah kucatat." }),
        ]);
      },
    } as unknown as AiClient;

    const result = await conversation(client).agent(
      "Catat PR matematika buat Jumat",
      "tools",
      undefined,
      { ownerId: "siswa", channel: "telegram" },
    );

    assert.equal(result.status, "completed");
    assert.equal(requests.length, 2);
    assert.match(
      requests[1]?.messages[0]?.content ?? "",
      /argumennya tidak cocok schema/u,
    );
  });

  it("berhenti setelah satu koreksi dan tidak mengulang tanpa batas", async () => {
    let call = 0;
    const client = {
      async completeToolTurn(): Promise<ChatAssistantToolMessage> {
        call += 1;
        return assistant([toolCall("harvy_final_v1", { jawaban: "tetap salah" })]);
      },
    } as unknown as AiClient;

    const result = await conversation(client).agent(
      "Catat PR matematika buat Jumat",
      "tools",
      undefined,
      { ownerId: "siswa", channel: "telegram" },
    );

    // Dua panggilan: percobaan awal dan satu koreksi. Sesudah itu run berhenti
    // tanpa mengarang hasil.
    assert.equal(call, 2);
    assert.equal(result.status, "stopped");
  });
});

function conversation(client: AiClient): Conversation {
  return new Conversation(
    client,
    PRODUCTION_ROUTING,
    "Asia/Jakarta",
    () => NOW,
  );
}

function assistant(calls: readonly ChatToolCall[]): ChatAssistantToolMessage {
  return { role: "assistant", content: null, tool_calls: [...calls] };
}

function toolCall(name: string, input: unknown, index = 0): ChatToolCall {
  return {
    id: `call-${index}-${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(input) },
  };
}
