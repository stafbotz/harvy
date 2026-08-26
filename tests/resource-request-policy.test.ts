import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelProfile } from "../src/ai/model-profile.js";
import {
  parseResourceRequest,
  ResourceRequestPolicy,
  type ResourcePolicyInput,
} from "../src/core/resource-request-policy.js";

describe("ResourceRequestPolicy", () => {
  const policy = new ResourceRequestPolicy();

  it("memparse proposal tertutup dan menolak budget/provider injection", () => {
    assert.deepEqual(parseResourceRequest({
      kind: "more_steps",
      reason: "progress_evidence",
      requestedAmount: 4,
      progress: ["new_evidence", "unresolved_set_reduced"],
    }), {
      kind: "more_steps",
      reason: "progress_evidence",
      requestedAmount: 4,
      progress: ["new_evidence", "unresolved_set_reduced"],
    });
    assert.equal(parseResourceRequest({
      kind: "more_steps",
      reason: "progress_evidence",
      requestedAmount: 4,
      resetBudget: true,
    }), null);
    assert.equal(parseResourceRequest({
      kind: "more_reasoning",
      reason: "provider_failure",
    }), null);
  });

  it("memberi adaptive step reserve hanya saat ada progress terstruktur", () => {
    assert.deepEqual(policy.decide(input({
      request: {
        kind: "more_steps",
        reason: "progress_evidence",
        requestedAmount: 5,
        progress: ["validator_state_changed"],
      },
      hardRemaining: { steps: 4, contextTokens: 0, toolCalls: 0 },
      adaptiveReserve: { steps: 2, contextTokens: 0, toolCalls: 0 },
    })), {
      decision: "grant",
      kind: "more_steps",
      amount: 2,
    });
    assert.deepEqual(policy.decide(input({
      request: {
        kind: "more_steps",
        reason: "progress_evidence",
        requestedAmount: 2,
      },
    })), { decision: "deny", code: "no_progress" });
  });

  it("menaikkan reasoning satu tingkat sesuai profile, bukan angka model", () => {
    assert.deepEqual(policy.decide(input({
      request: {
        kind: "more_reasoning",
        reason: "high_consequence_uncertainty",
      },
      difficulty: "deep",
      currentEffort: "medium",
      profile: profile(),
    })), {
      decision: "grant",
      kind: "more_reasoning",
      amount: 1,
      reasoningEffort: "high",
    });
    assert.deepEqual(policy.decide(input({
      request: {
        kind: "more_reasoning",
        reason: "unresolved_constraints",
      },
      difficulty: "normal",
      stakes: "low",
      uncertainty: "low",
    })), { decision: "deny", code: "insufficient_need" });
  });

  it("memisahkan capability dan specialist request dari authority", () => {
    assert.deepEqual(policy.decide(input({
      request: {
        kind: "specialist",
        reason: "high_consequence_uncertainty",
      },
      specialistEligible: true,
    })), { decision: "grant", kind: "specialist", amount: 1 });
    assert.deepEqual(policy.decide(input({
      request: {
        kind: "capability",
        reason: "required_capability",
        requiredCapability: "epub.read",
      },
      capabilityDiscoverable: false,
    })), { decision: "deny", code: "capability_ineligible" });
  });
});

function input(
  overrides: Partial<ResourcePolicyInput> = {},
): ResourcePolicyInput {
  return {
    request: {
      kind: "more_steps",
      reason: "progress_evidence",
      progress: ["new_evidence"],
    },
    difficulty: "normal",
    stakes: "medium",
    uncertainty: "medium",
    currentEffort: "medium",
    profile: profile(),
    hardRemaining: { steps: 6, contextTokens: 8_000, toolCalls: 4 },
    adaptiveReserve: { steps: 2, contextTokens: 2_000, toolCalls: 1 },
    capabilityDiscoverable: false,
    specialistEligible: false,
    ...overrides,
  };
}

function profile(): ModelProfile {
  return {
    provider: "openrouter",
    id: "model-uji",
    verification: "explicit",
    reasoning: {
      mandatory: false,
      defaultEffort: "medium",
      supportedEfforts: ["low", "medium", "high", "max"],
      wireFormat: "openrouter-reasoning",
    },
    supports: {
      tools: true,
      toolChoice: true,
      namedToolChoice: true,
      structuredOutput: true,
      temperature: true,
      promptCaching: false,
      imageInput: false,
    },
    continuation: {
      preserveReasoning: true,
      preserveAssistantMessage: true,
    },
    contextWindow: null,
    maxOutputTokens: null,
  };
}
