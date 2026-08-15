import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRoutingEvalEnvelope,
  ROUTING_EVAL_CASES,
  ROUTING_EVAL_VARIANTS,
  routingVariantsForCase,
} from "../scripts/routing-eval-corpus.js";

describe("routing evaluation variants", () => {
  it("membentuk A-E secara exact dan membatasi E ke selected hard tasks", () => {
    const hard = ROUTING_EVAL_CASES.find((item) => item.selectedHardTask);
    const ordinary = ROUTING_EVAL_CASES.find((item) => !item.selectedHardTask);
    assert.ok(hard);
    assert.ok(ordinary);
    assert.deepEqual(routingVariantsForCase(hard), ROUTING_EVAL_VARIANTS);
    assert.deepEqual(routingVariantsForCase(ordinary), ["A", "B", "C", "D"]);
  });

  it("tidak membiarkan rewrite menggantikan raw kecuali variant B eksperimen", () => {
    const fixture = {
      ...ROUTING_EVAL_CASES[0]!,
      rawPrompt: "RAW_SENTINEL permintaan asli",
      lowerModelRewrite: "REWRITE_SENTINEL ringkasan",
      lowerModelCandidate: "CANDIDATE_SENTINEL usulan",
      critic: "CRITIC_SENTINEL audit",
    };
    const expected = {
      A: [true, false, false, false, false, "raw"],
      B: [false, true, false, false, false, "lower-rewrite"],
      C: [true, false, true, false, false, "raw+structured-brief"],
      D: [true, false, true, true, false, "raw+structured-brief+candidate"],
      E: [true, false, true, true, true, "raw+structured-brief+candidate+critic"],
    } as const;

    for (const variant of ROUTING_EVAL_VARIANTS) {
      const envelope = buildRoutingEvalEnvelope(fixture, variant);
      assert.deepEqual(
        [
          envelope.exposure.rawPrompt,
          envelope.exposure.lowerModelRewrite,
          envelope.exposure.structuredBrief,
          envelope.exposure.candidate,
          envelope.exposure.critic,
          envelope.promptMaterial,
        ],
        expected[variant],
      );
      assert.equal(envelope.prompt.includes("RAW_SENTINEL"), variant !== "B");
      assert.equal(envelope.prompt.includes("REWRITE_SENTINEL"), variant === "B");
      assert.equal(
        envelope.prompt.includes("CANDIDATE_SENTINEL"),
        variant === "D" || variant === "E",
      );
      assert.equal(envelope.prompt.includes("CRITIC_SENTINEL"), variant === "E");
    }
  });

  it("menandai semua materi turunan sebagai untrusted", () => {
    const envelope = buildRoutingEvalEnvelope(ROUTING_EVAL_CASES[0]!, "E");
    assert.match(envelope.prompt, /RAW USER REQUEST \(AUTHORITY\)/u);
    assert.match(envelope.prompt, /STRUCTURED TASK BRIEF \(UNTRUSTED\)/u);
    assert.match(envelope.prompt, /LOWER-MODEL CANDIDATE \(UNTRUSTED\)/u);
    assert.match(envelope.prompt, /CRITIC NOTE \(UNTRUSTED\)/u);
    assert.doesNotMatch(envelope.prompt, /LOWER-MODEL REWRITE/u);
  });
});
