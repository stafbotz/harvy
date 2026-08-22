import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiClient } from "../src/ai/client.js";
import type { RoutingConfig } from "../src/ai/conversation.js";
import type { CognitiveModelRole } from "../src/ai/model-policy.js";
import {
  createConfiguredSpecialistExecutor,
  SPECIALIST_COMPOSITION_ERROR_CODE,
  SpecialistCompositionError,
} from "../src/ai/specialist-runtime.js";
import {
  ModelProfileRegistry,
  type ModelProfile,
} from "../src/ai/model-profile.js";

describe("specialist production composition", () => {
  it("tetap tidak memasang capability ketika gate default-off", () => {
    const executor = createConfiguredSpecialistExecutor(
      client(),
      incompleteRouting(),
      false,
    );
    assert.equal(executor, null);
  });

  it("fail closed bila exact role binding atau profile belum siap", () => {
    assert.throws(
      () => createConfiguredSpecialistExecutor(
        client(),
        incompleteRouting(),
        true,
      ),
      compositionError,
    );
  });

  it("menolak diversity semu dari beberapa role pada model exact yang sama", () => {
    const routing = readyRouting();
    routing.roleBindings = {
      ...routing.roleBindings,
      challenger: { tier: "ambitious", modelId: "model-verifier" },
    };
    assert.throws(
      () => createConfiguredSpecialistExecutor(client(), routing, true),
      compositionError,
    );
  });

  it("memasang executor hanya setelah exact binding distinct dan profile explicit", () => {
    const executor = createConfiguredSpecialistExecutor(
      client(),
      readyRouting(),
      true,
    );
    assert.equal(executor?.capabilityId, "agent.delegate.specialist");
    assert.equal(executor?.capabilityVersion, "1");
  });
});

function readyRouting(): RoutingConfig {
  const models = [
    "model-everyday",
    "model-orchestrator",
    "model-heavy",
    "model-verifier",
    "model-challenger",
  ];
  const roleBindings: Partial<
    Record<CognitiveModelRole, { tier: "efficient" | "ambitious"; modelId: string }>
  > = {
    everyday_conversation: {
      tier: "efficient",
      modelId: "model-everyday",
    },
    orchestrator: { tier: "ambitious", modelId: "model-orchestrator" },
    heavy_executor: { tier: "ambitious", modelId: "model-heavy" },
    verifier: { tier: "ambitious", modelId: "model-verifier" },
    challenger: { tier: "ambitious", modelId: "model-challenger" },
  };
  return {
    mode: "production",
    providerId: "openrouter",
    testingModel: "",
    models: {
      cheap: "model-mechanical",
      efficient: "model-everyday",
      ambitious: "model-orchestrator",
    },
    roleBindings,
    modelProfiles: new ModelProfileRegistry(
      models.map((id) => profile(id, id === "model-orchestrator")),
    ),
  };
}

function incompleteRouting(): RoutingConfig {
  return {
    mode: "production",
    testingModel: "",
    models: {
      cheap: "model-mechanical",
      efficient: "model-everyday",
      ambitious: "model-deep",
    },
  };
}

function profile(id: string, orchestrator: boolean): ModelProfile {
  return {
    provider: "openrouter",
    id,
    verification: "explicit",
    reasoning: {
      mandatory: false,
      defaultEffort: "none",
      supportedEfforts: [],
      wireFormat: "none",
    },
    supports: {
      tools: orchestrator,
      toolChoice: orchestrator,
      namedToolChoice: orchestrator,
      structuredOutput: true,
      temperature: true,
    },
    continuation: {
      preserveReasoning: false,
      preserveAssistantMessage: orchestrator,
    },
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
  };
}

function client(): Pick<AiClient, "complete"> {
  return {
    complete: async () => JSON.stringify({
      version: 1,
      status: "completed",
      workBriefRef: "unused",
      facts: [],
      evidence: [],
      assumptions: [],
      plan: [],
      workProduct: "done",
      openQuestions: [],
      confidence: 1,
      provenance: [],
      failureCodes: [],
    }),
  };
}

function compositionError(error: unknown): boolean {
  return error instanceof SpecialistCompositionError &&
    error.code === SPECIALIST_COMPOSITION_ERROR_CODE;
}
