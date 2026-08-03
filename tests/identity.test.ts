import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiClient, ChatRequest } from "../src/ai/client.js";
import { Conversation, type RoutingConfig } from "../src/ai/conversation.js";
import {
  CAPYBARA_MODEL_REPLY,
  isModelIdentityQuestion,
  isPureModelIdentityQuestion,
} from "../src/ai/identity.js";
import type { Understanding } from "../src/ai/understand.js";

const ROUTING: RoutingConfig = {
  mode: "testing",
  testingModel: "model-uji",
  models: { cheap: "", efficient: "", ambitious: "" },
};

const QUESTION: Understanding = {
  intent: "question",
  taskAction: null,
  memoryAction: null,
  controlAction: null,
  safetySensitive: false,
  needsStepByStep: false,
  sessionSignal: null,
  suggestedActions: [],
  actionGoal: null,
  task: null,
  memories: [],
};

describe("identitas model Capybara", () => {
  it("mengenali pertanyaan model yang ditujukan kepada Harvy", () => {
    assert.equal(isModelIdentityQuestion("Harvy kamu pakai model apa?"), true);
    assert.equal(isModelIdentityQuestion("AI apa yang kamu pake?"), true);
    assert.equal(isModelIdentityQuestion("modelmu apaan"), true);
    assert.equal(isModelIdentityQuestion("kamu ChatGPT?"), true);
    assert.equal(isModelIdentityQuestion("pakai GPT ya?"), true);
    assert.equal(
      isModelIdentityQuestion("which model are you using?"),
      true,
    );
    assert.equal(
      isModelIdentityQuestion("Harvy dibuat pakai model apa?"),
      true,
    );
    assert.equal(isModelIdentityQuestion("model matematika apa yang dipakai?"), false);
    assert.equal(isModelIdentityQuestion("apa itu model atom Bohr?"), false);
    assert.equal(
      isModelIdentityQuestion("menurut kamu AI apa yang cocok buat coding?"),
      false,
    );
    assert.equal(
      isPureModelIdentityQuestion(
        "model apa, sekalian jelasin fotosintesis",
      ),
      false,
    );
    assert.equal(
      isPureModelIdentityQuestion(
        "kamu model apa aku sedang nggak aman",
      ),
      false,
    );
  });

  it("tetap mengerjakan bagian lain pada pertanyaan campuran", async () => {
    const conversation = new Conversation(
      {
        complete: async () =>
          "Fotosintesis adalah cara tumbuhan mengubah energi cahaya.",
      } as unknown as AiClient,
      ROUTING,
      "Asia/Jakarta",
    );

    const reply = await conversation.reply(
      "kamu pakai model apa, sekalian jelasin fotosintesis",
      QUESTION,
    );

    assert.match(reply, /model Capybara/);
    assert.match(reply, /Fotosintesis/);
  });

  it("menjawab dari identitas produk tanpa bergantung pada model dasar", async () => {
    const requests: ChatRequest[] = [];
    const conversation = new Conversation(
      {
        complete: async (request: ChatRequest) => {
          requests.push(request);
          return "jawaban yang seharusnya tidak dipakai";
        },
      } as unknown as AiClient,
      ROUTING,
      "Asia/Jakarta",
    );

    const reply = await conversation.reply(
      "Harvy, kamu pakai model apa?",
      QUESTION,
    );

    assert.equal(reply, CAPYBARA_MODEL_REPLY);
    assert.deepEqual(requests, []);
  });

  it("tidak membiarkan pertanyaan model mengalahkan jalur keselamatan", async () => {
    const requests: ChatRequest[] = [];
    const conversation = new Conversation(
      {
        complete: async (request: ChatRequest) => {
          requests.push(request);
          return "aku tetap menanggapi keadaanmu";
        },
      } as unknown as AiClient,
      ROUTING,
      "Asia/Jakarta",
    );

    const reply = await conversation.reply(
      "kamu model apa? aku sedang nggak aman",
      { ...QUESTION, safetySensitive: true },
      undefined,
      null,
      {
        level: "bahaya",
        alone: false,
        sensitive: true,
        summary: "tidak aman",
        certain: true,
      },
    );

    assert.equal(reply, "aku tetap menanggapi keadaanmu");
    assert.equal(requests.length, 1);
    assert.match(
      requests[0]?.messages[0]?.content ?? "",
      /bahaya yang dekat/i,
    );
  });
});
