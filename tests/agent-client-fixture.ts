import type {
  AiClient,
  ChatAssistantToolMessage,
  ChatCompletion,
  ChatFunctionTool,
  ChatRequest,
} from "../src/ai/client.js";

export type NativeToolRequest = ChatRequest & {
  tools: readonly ChatFunctionTool[];
};

type ToolTurn = (
  request: NativeToolRequest,
) => Promise<ChatAssistantToolMessage>;

/**
 * Klien double planner yang menyediakan kedua kontrak giliran native.
 *
 * Planner produksi memilih `completeAutoTurn` ketika `tool_choice` bernilai
 * `auto` dan `completeToolTurn` ketika kontrak wajib (named tool state-live atau
 * final terstruktur). Double yang hanya memasang satu metode akan lulus tanpa
 * pernah menyentuh jalur yang benar-benar dipakai, jadi keduanya berasal dari
 * satu implementasi giliran di sini.
 *
 * Giliran yang ingin menguji jawaban teks biasa memakai `agentTextClientDouble`.
 */
export function agentClientDouble<T extends { completeToolTurn: ToolTurn }>(
  client: T,
): AiClient {
  return {
    ...client,
    async completeAutoTurn(
      request: NativeToolRequest,
    ): Promise<ChatCompletion> {
      const assistant = await client.completeToolTurn(request);
      return {
        kind: "tool_calls",
        toolCalls: assistant.tool_calls,
        assistant,
      };
    },
  } as unknown as AiClient;
}

/**
 * Double untuk giliran `auto` yang boleh dijawab teks biasa maupun tool call.
 *
 * `completeToolTurn` tetap dipasang dan menolak teks dengan cara yang sama
 * dengan klien nyata, sehingga tes tidak dapat menyembunyikan jalur wajib yang
 * seharusnya gagal.
 */
export function agentTextClientDouble(
  turn: (request: NativeToolRequest) => Promise<ChatCompletion>,
): AiClient {
  return {
    async completeAutoTurn(request: NativeToolRequest): Promise<ChatCompletion> {
      return turn(request);
    },
    async completeToolTurn(
      request: NativeToolRequest,
    ): Promise<ChatAssistantToolMessage> {
      const completion = await turn(request);
      if (completion.kind !== "tool_calls") {
        throw new Error("Double menerima teks pada giliran tool wajib.");
      }
      return completion.assistant;
    },
  } as unknown as AiClient;
}
