import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProjectIntentProposal } from "../src/ai/project-intent-interpreter.js";
import {
  parseSemanticOperation,
  semanticOperationAuthorized,
} from "../src/domain/semantic-operation.js";

describe("project intent interpreter", () => {
  it("membaca goal terstruktur hanya untuk semantic operation yang cocok", () => {
    const raw = JSON.stringify({
      kind: "goal-set",
      objective: "Bangun Repo Doctor CLI",
      acceptanceCriteria: [
        { kind: "code", text: "CLI memeriksa project dan test lulus." },
        { kind: "github", text: "Draft PR tersedia." },
      ],
      milestones: ["Audit", "Implementasi"],
    });
    const proposal = parseProjectIntentProposal(raw, {
      domain: "goal",
      operation: "set",
    });
    assert.equal(proposal?.kind, "goal-set");
    assert.equal(proposal?.acceptanceCriteria.length, 2);
    assert.equal(parseProjectIntentProposal(raw, {
      domain: "project",
      operation: "create",
    }), null);
  });

  it("menolak field tambahan dan tool skill di luar allowlist", () => {
    const base = {
      kind: "skill-create",
      name: "Repo quality",
      description: "Audit kualitas project.",
      semanticTriggers: ["audit repo"],
      preconditions: ["Project aktif."],
      steps: ["Baca project.", "Jalankan validator."],
      toolRequirements: ["workspace.read", "sandbox.test"],
      verification: ["Validator lulus."],
    };
    assert.equal(
      parseProjectIntentProposal(JSON.stringify({ ...base, permission: "admin" }), {
        domain: "skill",
        operation: "create",
      }),
      null,
    );
    assert.equal(
      parseProjectIntentProposal(JSON.stringify({
        ...base,
        toolRequirements: ["host.shell"],
      }), {
        domain: "skill",
        operation: "create",
      }),
      null,
    );
  });

  it("mengotorisasi operasi project natural hanya dari evidence current", () => {
    const message = "Buat project kosong bernama Repo Doctor";
    const semantic = parseSemanticOperation({
      version: 1,
      domain: "project",
      operation: "create",
      target: "Repo Doctor",
      subject: "self",
      reference: "none",
      explicitness: "explicit",
      evidence: "Buat project kosong",
      confidence: 0.94,
    });
    assert.ok(semantic);
    assert.equal(semanticOperationAuthorized(message, semantic, {
      domain: "project",
      operations: ["create"],
      minConfidence: 0.85,
      explicitness: ["explicit"],
    }), true);
    assert.equal(semanticOperationAuthorized("Aku membahas project kosong", semantic, {
      domain: "project",
      operations: ["create"],
      minConfidence: 0.85,
      explicitness: ["explicit"],
    }), false);
  });
});
