import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  memoryPlanUsesRetrieval,
  planMemoryQuery,
} from "../src/core/memory-query-plan.js";
import type { SemanticOperation } from "../src/domain/semantic-operation.js";

describe("semantic memory query plan", () => {
  it("mengaktifkan retrieval lintas bahasa dari semantic meaning", () => {
    for (const message of [
      "What did we discuss before?",
      "naon nu tadi urang bahas?",
      "wingi awake dhewe ngomong apa?",
      "tadi kita discuss apa sih?",
    ]) {
      const plan = planMemoryQuery(message, {
        semanticOperation: recall(message, "history"),
      });
      assert.equal(memoryPlanUsesRetrieval(plan), true, message);
      assert.equal(plan.routes.episodic, true, message);
      assert.equal(plan.taskBrief.rawRequest, message, message);
    }
  });

  it("memory recall menyalakan evidence relevan tanpa kamus lokal", () => {
    const message = "what are my learning preferences?";
    const plan = planMemoryQuery(message, {
      semanticOperation: recall(message, "memory", "learning preferences"),
    });
    assert.equal(plan.routes.semantic, true);
    assert.equal(plan.routes.personalization, true);
    assert.match(plan.query, /learning preferences/u);
  });

  it("evidence semantic yang tidak berasal dari raw turn gagal tertutup", () => {
    const message = "naon nu tadi?";
    const semantic = recall("different evidence", "history");
    assert.equal(
      memoryPlanUsesRetrieval(planMemoryQuery(message, { semanticOperation: semantic })),
      false,
    );
  });
});

function recall(
  message: string,
  domain: "memory" | "history",
  target: string | null = null,
): SemanticOperation {
  return {
    version: 1,
    domain,
    operation: "recall",
    target,
    subject: "self",
    reference: "recent",
    explicitness: "explicit",
    evidence: message,
    confidence: 0.95,
  };
}
