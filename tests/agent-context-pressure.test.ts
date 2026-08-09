import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  prepareAgentContext,
} from "../src/ai/agent-context-pressure.js";
import type {
  ChatAssistantToolMessage,
  ChatMessage,
  ChatRequest,
} from "../src/ai/client.js";
import type { HarvyContext } from "../src/ai/context.js";
import type { ModelProfile } from "../src/ai/model-profile.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import type { AgentPlannerInput } from "../src/harness/agent-harness.js";
import { compileHarvyContext } from "../src/harness/context-budget.js";

describe("agent context pressure", () => {
  it("tidak memutus continuation ketika masih di bawah threshold", () => {
    const source = context();
    const compiled = compileHarvyContext(source);
    const nativeMessages = nativeThread("reasoning-exact");
    const request = requestWith(compiled, nativeMessages, 1_000);

    const prepared = prepareAgentContext({
      normalRequest: request,
      sourceContext: source,
      plannerInput: plannerInput(),
      mode: "tools",
      nativeMessages,
      profile: profile(100_000),
      compactAtContextRatio: 0.82,
      recovery: false,
      rebuild: (candidate, messages) =>
        requestWith(candidate, messages, 1_000),
    });

    assert.equal(prepared.resetNativeThread, false);
    assert.equal(prepared.request.messages, request.messages);
    assert.equal(prepared.nativeMessages, nativeMessages);
    assert.equal(prepared.request.contextManifest?.pressure?.applied, false);
    const assistant = prepared.request.messages.find(
      (message): message is ChatAssistantToolMessage =>
        message.role === "assistant" && "tool_calls" in message,
    );
    assert.equal(assistant?.continuation?.reasoning, "reasoning-exact");
  });

  it("tidak mengaktifkan pressure dari metadata profile compatibility", () => {
    const source = context();
    const compiled = compileHarvyContext(source);
    const nativeMessages = nativeThread("r".repeat(48_000));
    const request = requestWith(compiled, nativeMessages, 1_000);

    const prepared = prepareAgentContext({
      normalRequest: request,
      sourceContext: source,
      plannerInput: plannerInput(),
      mode: "tools",
      nativeMessages,
      profile: { ...profile(12_000), verification: "compatibility" },
      compactAtContextRatio: 0.82,
      recovery: false,
      rebuild: (candidate, messages) =>
        requestWith(candidate, messages, 1_000),
    });

    assert.equal(prepared.resetNativeThread, false);
    assert.equal(prepared.request.messages, request.messages);
    assert.equal(
      prepared.request.contextManifest?.pressure?.contextWindowTokens,
      null,
    );
  });

  it("memadatkan sebelum hard window dan membangun ulang state provider-neutral", () => {
    const source = context();
    const compiled = compileHarvyContext(source);
    const reasoningCanary = `OPAQUE_REASONING_${"r".repeat(48_000)}`;
    const nativeMessages = nativeThread(reasoningCanary);
    const planner = plannerInput();
    const request = requestWith(compiled, nativeMessages, 1_000);

    const prepared = prepareAgentContext({
      normalRequest: request,
      sourceContext: source,
      plannerInput: planner,
      mode: "tools",
      nativeMessages,
      profile: profile(12_000),
      compactAtContextRatio: 0.82,
      recovery: false,
      rebuild: (candidate, messages) =>
        requestWith(candidate, messages, 1_000),
    });

    const serialized = prepared.request.messages
      .map((message) => message.content ?? "")
      .join("\n");
    const pressure = prepared.request.contextManifest?.pressure;
    assert.equal(prepared.resetNativeThread, true);
    assert.equal(prepared.nativeMessages.length, 1);
    assert.equal(prepared.nativeMessages[0]?.role, "user");
    assert.match(serialized, /STABLE_SYSTEM/u);
    assert.match(serialized, /RAW_REQUEST_CANARY/u);
    assert.match(serialized, /LATEST_CONSTRAINT_MIDDLE_CANARY/u);
    assert.match(serialized, /originalCharacters/u);
    assert.doesNotMatch(serialized, /OPAQUE_REASONING/u);
    assert.equal(pressure?.applied, true);
    assert.equal(pressure?.recovery, false);
    assert.equal(pressure?.nativeMessagesBefore, 3);
    assert.equal(pressure?.nativeMessagesAfter, 1);
    assert.equal(pressure?.clippedObservationCount, 1);
    assert.ok(
      (pressure?.inputTokensAfter ?? Number.MAX_SAFE_INTEGER) <
        (pressure?.inputTokensBefore ?? 0),
    );
    assert.ok(
      (pressure?.inputTokensAfter ?? Number.MAX_SAFE_INTEGER) + 1_000 <
        (pressure?.thresholdTokens ?? 0),
    );
  });

  it("mempertahankan seluruh instruction revision lalu gagal tertutup bila tetap tak muat", () => {
    const source = context();
    const compiled = compileHarvyContext(source);
    const nativeMessages = nativeThread("r".repeat(8_000));
    const planner = plannerInput();
    const rebuilt: ChatRequest[] = [];

    assert.throws(
      () =>
        prepareAgentContext({
          normalRequest: requestWith(compiled, nativeMessages, 1_000),
          sourceContext: source,
          plannerInput: planner,
          mode: "tools",
          nativeMessages,
          profile: profile(1_200),
          compactAtContextRatio: 0.82,
          recovery: false,
          rebuild: (candidate, messages) => {
            const request = requestWith(candidate, messages, 1_000);
            rebuilt.push(request);
            return request;
          },
        }),
      /tidak dapat dipadatkan/u,
    );
    assert.equal(rebuilt.length, 5);
    for (const request of rebuilt) {
      const serialized = request.messages
        .map((message) => message.content ?? "")
        .join("\n");
      assert.match(serialized, /LATEST_CONSTRAINT_MIDDLE_CANARY/u);
    }
  });

  it("mencatat rasio RunBudget ekstrem tanpa metadata permille invalid", () => {
    for (const [ratio, expected] of [[0.0001, 1], [0.9999, 999]] as const) {
      const source = context();
      const compiled = compileHarvyContext(source);
      const nativeMessages: ChatMessage[] = [{
        role: "user",
        content: "RAW_REQUEST_CANARY",
      }];
      const prepared = prepareAgentContext({
        normalRequest: requestWith(compiled, nativeMessages, 100),
        sourceContext: source,
        plannerInput: plannerInput(),
        mode: "tools",
        nativeMessages,
        profile: profile(100_000),
        compactAtContextRatio: ratio,
        recovery: false,
        rebuild: (candidate, messages) =>
          requestWith(candidate, messages, 100),
      });
      assert.equal(
        prepared.request.contextManifest?.pressure
          ?.compactAtRatioPermille,
        expected,
      );
    }
  });
});

function plannerInput(): AgentPlannerInput {
  const budget = new RunBudgetAccount().view(1);
  return {
    runId: "run-pressure",
    step: 1,
    request: "RAW_REQUEST_CANARY",
    scope: { kind: "private", channel: "telegram" },
    callableCapabilities: [],
    capabilities: {
      version: 1,
      scope: "private:telegram",
      hash: "0000000000000000",
      entries: [],
    },
    observations: [{
      step: 0,
      capabilityId: "terminal.run",
      status: "ok",
      summary: JSON.stringify({
        kind: "terminal.result",
        output: `HEAD-${"o".repeat(5_000)}-TAIL`,
      }),
    }],
    userInputs: [{
      step: 0,
      prompt: "Tambahkan batasan terbaru.",
      text: `awal-${"x".repeat(500)}-LATEST_CONSTRAINT_MIDDLE_CANARY-${"y".repeat(500)}-akhir`,
    }],
    budget,
  };
}

function context(): HarvyContext {
  return {
    summary: "SUMMARY_CANARY",
    turns: [
      { role: "user", text: "OLD_TURN_CANARY", at: "1" },
      { role: "harvy", text: "LATEST_TURN_CANARY", at: "2" },
    ],
    memories: [],
  };
}

function nativeThread(reasoning: string): ChatMessage[] {
  return [
    { role: "user", content: "RAW_REQUEST_CANARY" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "test_tool", arguments: "{}" },
      }],
      continuation: {
        providerId: "test-provider",
        modelId: "test-model",
        reasoning,
      },
    },
    {
      role: "tool",
      tool_call_id: "call-1",
      name: "test_tool",
      content: "observation",
    },
  ];
}

function requestWith(
  compiled: ReturnType<typeof compileHarvyContext>,
  nativeMessages: readonly ChatMessage[],
  maxTokens: number,
): ChatRequest {
  return {
    model: "test-model",
    maxTokens,
    contextManifest: compiled.manifest,
    messages: [
      { role: "system", content: "STABLE_SYSTEM" },
      ...compiled.context.turns.map((turn): ChatMessage => ({
        role: turn.role === "user" ? "user" : "assistant",
        content: turn.text,
      })),
      ...nativeMessages,
    ],
  };
}

function profile(contextWindow: number): ModelProfile {
  return {
    id: "test-model",
    provider: "test-provider",
    verification: "explicit",
    reasoning: {
      mandatory: false,
      defaultEffort: "none",
      supportedEfforts: [],
      wireFormat: "none",
    },
    supports: {
      tools: true,
      toolChoice: true,
      namedToolChoice: true,
      structuredOutput: true,
      temperature: true,
    },
    continuation: {
      preserveReasoning: false,
      preserveAssistantMessage: true,
    },
    contextWindow,
    maxOutputTokens: null,
  };
}
