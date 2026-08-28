import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiClient, ChatRequest } from "../src/ai/client.js";
import { Conversation } from "../src/ai/conversation.js";
import type { AgentRunResult } from "../src/harness/agent-harness.js";

const ROUTING = {
  mode: "production" as const,
  testingModel: "",
  models: { cheap: "cheap-model", efficient: "efficient-model", ambitious: "ambitious-model" },
};

/**
 * Penghentian run dulu selalu dibalas string kaleng, sehingga pengguna yang
 * meminta sesuatu di luar kemampuan Harvy menerima kalimat rusak alih-alih
 * penjelasan. Tes ini mengunci bahwa alasan dan observation benar-benar sampai
 * ke model, dan bahwa kegagalan panggilan itu sendiri gagal tertutup.
 */
describe("penjelasan penghentian run agent", () => {
  it("mengirim alasan berhenti dan observation sebagai data ke model", async () => {
    const requests: ChatRequest[] = [];
    const conversation = new Conversation(
      recorder(requests, "Aku belum bisa mencari di internet."),
      ROUTING,
      "Asia/Jakarta",
      () => new Date("2026-08-27T05:00:00.000Z"),
    );

    const reply = await conversation.explainAgentStop(
      "cariin di internet lalu kirim email",
      stopped("invalid_planner_output", [
        {
          step: 0,
          capabilityId: "task.list_active",
          status: "ok",
          summary: "{\"kind\":\"task.list_active.result\",\"total\":0}",
        },
      ]),
      undefined,
      { ownerId: "siswa", timeZone: "Asia/Jakarta" },
    );

    assert.equal(reply, "Aku belum bisa mencari di internet.");
    const system = requests[0]?.messages[0]?.content ?? "";
    assert.match(system, /invalid_planner_output/u);
    assert.match(system, /task\.list_active/u);
    // Batas yang dijaga: model diminta jujur soal kemampuan yang tidak ada dan
    // dilarang mengaku sudah mengerjakan sesuatu.
    assert.match(system, /mengirim email atau pesan/u);
    assert.match(system, /Jangan mengaku sudah mengerjakan apa pun/u);
    // Istilah internal tidak boleh bocor ke pengguna lewat balasan ini.
    assert.match(system, /jangan menyebut istilah run, agent,[\s\S]*checkpoint/u);
    // Permintaan pengguna tetap dibungkus sebagai data, bukan instruksi.
    assert.match(requests[0]?.messages[1]?.content ?? "", /<permintaan>/u);
  });

  it("mengembalikan null ketika panggilan penjelasan gagal", async () => {
    const conversation = new Conversation(
      {
        async complete(): Promise<string> {
          throw new Error("provider mati");
        },
      } as unknown as AiClient,
      ROUTING,
      "Asia/Jakarta",
    );

    const reply = await conversation.explainAgentStop(
      "cariin di internet",
      stopped("deadline", []),
    );
    // Pemanggil memakai teks deterministik ketika hasilnya null; penjelasan
    // yang gagal tidak boleh menjadi balasan kosong.
    assert.equal(reply, null);
  });

  it("mengembalikan null ketika model menjawab kosong", async () => {
    const conversation = new Conversation(
      recorder([], "   "),
      ROUTING,
      "Asia/Jakarta",
    );
    assert.equal(
      await conversation.explainAgentStop("apa pun", stopped("max_steps", [])),
      null,
    );
  });
});

function stopped(
  reason: Extract<AgentRunResult, { status: "stopped" }>["reason"],
  observations: Extract<AgentRunResult, { status: "stopped" }>["checkpoint"]["observations"],
): Extract<AgentRunResult, { status: "stopped" }> {
  return {
    status: "stopped",
    reason,
    checkpoint: {
      version: 2,
      runId: "run",
      scopeKey: "v1:private:telegram:user:siswa:conversation",
      capabilityHash: "hash",
      callableHash: "hash",
      request: "cariin di internet",
      startedAt: "2026-08-27T05:00:00.000Z",
      deadlineAt: "2026-08-27T05:01:00.000Z",
      maxSteps: 6,
      step: observations.length,
      observations,
      userInputs: [],
      seenActionDigests: [],
      pending: null,
      pendingInput: null,
    },
    trace: [],
  };
}

function recorder(requests: ChatRequest[], reply: string): AiClient {
  return {
    async complete(request: ChatRequest): Promise<string> {
      requests.push(request);
      return reply;
    },
  } as unknown as AiClient;
}
