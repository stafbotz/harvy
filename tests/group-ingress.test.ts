import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GROUP_INGRESS_PROMPT,
  parseGroupIngressAssessment,
} from "../src/ai/group-ingress.js";
import {
  parseGroupAmbientAssessment,
} from "../src/ai/group-conversation.js";

describe("assessment ingress grup", () => {
  it("membaca risk hint dan privacy sebagai field independen", () => {
    assert.deepEqual(
      parseGroupIngressAssessment(JSON.stringify({
        riskHint: {
          level: "strong",
          category: "violence",
          confidence: 0.91,
        },
        contextPrivacy: "ordinary",
      })),
      {
        riskHint: {
          level: "strong",
          category: "violence",
          confidence: 0.91,
        },
        contextPrivacy: "ordinary",
      },
    );

    assert.deepEqual(
      parseGroupIngressAssessment(
        '{"riskHint":"rusak","contextPrivacy":"sensitive"}',
      ),
      { riskHint: null, contextPrivacy: "sensitive" },
    );
    assert.deepEqual(
      parseGroupIngressAssessment(JSON.stringify({
        riskHint: { level: "none", category: null, confidence: 1 },
        contextPrivacy: "unknown",
      })),
      {
        riskHint: { level: "none", confidence: 1 },
        contextPrivacy: null,
      },
    );
  });

  it("tidak menebak field yang hilang sebagai none atau ordinary", () => {
    assert.deepEqual(
      parseGroupIngressAssessment('{"contextPrivacy":"ordinary"}'),
      { riskHint: null, contextPrivacy: "ordinary" },
    );
    assert.deepEqual(
      parseGroupIngressAssessment(
        '{"riskHint":{"level":"none","confidence":0.9}}',
      ),
      {
        riskHint: { level: "none", confidence: 0.9 },
        contextPrivacy: null,
      },
    );
    assert.equal(parseGroupIngressAssessment("{}"), null);
  });

  it("mempertahankan strong hint ketika plan ambient rusak", () => {
    const assessment = parseGroupAmbientAssessment(JSON.stringify({
      decision: "speak",
      reason: "low_value",
      value: 0,
      confidence: 0.1,
      reply: "iya",
      riskHint: {
        level: "strong",
        category: "self_harm",
        confidence: 0.99,
      },
      contextPrivacy: "sensitive",
    }));

    assert.equal(assessment?.plan, null);
    assert.equal(assessment?.riskHint?.level, "strong");
    assert.equal(assessment?.contextPrivacy, "sensitive");
  });

  it("prompt melarang menyamakan cerita personal dengan acute risk", () => {
    assert.match(
      GROUP_INGRESS_PROMPT,
      /cerita personal.*tanpa bukti bahaya akut.*level none/isu,
    );
    assert.match(GROUP_INGRESS_PROMPT, /jika ragu.*sensitive/isu);
    assert.match(
      GROUP_INGRESS_PROMPT,
      /tidak memberi izin.*memori durable/isu,
    );
  });
});
