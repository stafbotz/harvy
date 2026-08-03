import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGroupParticipationPlan } from "../src/ai/group-conversation.js";
import {
  GROUP_DIRECT_EVAL_CASES,
  GROUP_EVAL_CASES,
  GROUP_EVAL_TOPICS,
  selectGroupEvalCases,
} from "../scripts/group-eval-corpus.js";

describe("corpus evaluasi grup masif", () => {
  it("memuat empat puluh snapshot per topik dari sepuluh skenario semantik", () => {
    assert.equal(GROUP_EVAL_TOPICS.length, 15);
    assert.equal(GROUP_EVAL_CASES.length, 600);
    assert.equal(
      new Set(GROUP_EVAL_CASES.map((testCase) => testCase.id)).size,
      GROUP_EVAL_CASES.length,
    );

    for (const topic of GROUP_EVAL_TOPICS) {
      const cases = GROUP_EVAL_CASES.filter(
        (testCase) => testCase.topic === topic,
      );
      assert.equal(cases.length, 40, topic);
      assert.equal(
        cases.filter((testCase) => testCase.expectation === "speak")
          .length,
        16,
        topic,
      );
      assert.equal(
        cases.filter((testCase) => testCase.expectation === "silent")
          .length,
        24,
        topic,
      );
      const byArchetype = new Map<
        (typeof cases)[number]["archetype"],
        typeof cases
      >();
      for (const testCase of cases) {
        const variants = byArchetype.get(testCase.archetype) ?? [];
        variants.push(testCase);
        byArchetype.set(testCase.archetype, variants);
      }
      assert.equal(byArchetype.size, 10, topic);
      for (const variants of byArchetype.values()) {
        assert.equal(variants.length, 4, topic);
        assert.equal(
          new Set(variants.map((testCase) => testCase.clusterId)).size,
          1,
          topic,
        );
        assert.deepEqual(
          variants.map((testCase) => testCase.variant),
          [1, 2, 3, 4],
          topic,
        );
      }
    }
  });

  it("menjaga urutan multianggota, variasi bentuk chat, dan data tetap sintetis", () => {
    for (const testCase of GROUP_EVAL_CASES) {
      assert.ok(testCase.context.length >= 2, testCase.id);
      const offsets = [
        ...testCase.context.map((turn) => turn.offsetSeconds),
        testCase.current.offsetSeconds,
      ];
      assert.deepEqual(
        offsets,
        [...offsets].sort((left, right) => left - right),
        testCase.id,
      );
      const transcript = [
        ...testCase.context.map((turn) => turn.text),
        testCase.current.text,
      ].join(" ");
      assert.doesNotMatch(
        transcript,
        /\b(?:\+?62|08)\d{8,13}\b/u,
        testCase.id,
      );
      assert.doesNotMatch(transcript, /@(?:s\.whatsapp\.net|lid)\b/u);
    }

    assert.ok(
      GROUP_EVAL_CASES.some((testCase) =>
        testCase.current.text.includes("😭"),
      ),
    );
    assert.ok(
      GROUP_EVAL_CASES.some((testCase) =>
        /\b(?:yg|dgn|udah)\b/u.test(testCase.current.text),
      ),
    );
    assert.ok(
      GROUP_EVAL_CASES.some(
        (testCase) => testCase.archetype === "prompt-injection",
      ),
    );
  });

  it("memisahkan enam puluh episode direct dari corpus planner ambient", () => {
    assert.equal(GROUP_DIRECT_EVAL_CASES.length, 60);
    assert.equal(
      new Set(GROUP_DIRECT_EVAL_CASES.map((testCase) => testCase.id)).size,
      60,
    );
    for (const topic of GROUP_EVAL_TOPICS) {
      const cases = GROUP_DIRECT_EVAL_CASES.filter(
        (testCase) => testCase.topic === topic,
      );
      assert.equal(cases.length, 4, topic);
      assert.deepEqual(
        new Set(cases.map((testCase) => testCase.kind)),
        new Set([
          "metadata-mention",
          "reply-followup",
          "alias-addressed",
          "fact-check",
        ]),
      );
    }
    assert.ok(
      GROUP_DIRECT_EVAL_CASES.some(
        (testCase) =>
          testCase.kind === "reply-followup" &&
          testCase.context.some((turn) => turn.role === "harvy"),
      ),
    );
    for (const factCheck of GROUP_DIRECT_EVAL_CASES.filter(
      (testCase) => testCase.kind === "fact-check",
    )) {
      assert.equal(factCheck.mustChallengeClaim, true, factCheck.id);
      assert.ok(factCheck.challengeAny?.length, factCheck.id);
    }
  });

  it("memilih archetype sebelum membatasi jumlah kasus per topik", () => {
    const selected = selectGroupEvalCases(GROUP_EVAL_CASES, {
      limitPerTopic: 10,
      archetype: "fact-correction",
    });
    assert.equal(selected.length, 60);
    for (const topic of GROUP_EVAL_TOPICS) {
      const topicCases = selected.filter(
        (testCase) => testCase.topic === topic,
      );
      assert.equal(topicCases.length, 4, topic);
      assert.ok(
        topicCases.every(
          (testCase) =>
            testCase.archetype === "fact-correction",
        ),
        topic,
      );
    }
  });

  it("memastikan seluruh label corpus dapat direpresentasikan parser", () => {
    for (const testCase of GROUP_EVAL_CASES) {
      const speak = testCase.expectation === "speak";
      const parsed = parseGroupParticipationPlan(
        JSON.stringify({
          decision: speak ? "speak" : "silent",
          reason: speak ? "unanswered_question" : "human_exchange",
          value: speak ? 3 : 0,
          confidence: 0.99,
          reply: speak ? "Kontribusi sintetis yang relevan." : null,
        }),
      );
      assert.equal(parsed?.decision, testCase.expectation, testCase.id);
    }
  });
});
