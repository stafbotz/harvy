import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiClient, ChatRequest } from "../src/ai/client.js";
import { AiCodingWorkerDriver } from "../src/ai/coding-worker-driver.js";
import { ApiKeyPool } from "../src/ai/key-pool.js";
import {
  ModelProfileRegistry,
  type ModelProfile,
} from "../src/ai/model-profile.js";
import type { AiConfig } from "../src/config.js";
import type { CodingAdvisoryInput } from
  "../src/core/coding-run-coordinator.js";
import type { AgentHandoff } from "../src/domain/agent-handoff.js";

describe("AiCodingWorkerDriver advisory", () => {
  it("menjalankan challenger dan verifier paralel tanpa tool atau delegasi", async () => {
    const requests: ChatRequest[] = [];
    let active = 0;
    let peak = 0;
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fallbackRelease = setTimeout(release, 250);
    const client = {
      async complete(request: ChatRequest): Promise<string> {
        requests.push(request);
        arrivals += 1;
        active += 1;
        peak = Math.max(peak, active);
        if (arrivals === 2) release();
        await gate;
        active -= 1;
        const role = request.model === "model-challenger"
          ? "challenger"
          : "verifier";
        return JSON.stringify(handoff(role));
      },
      async completeToolTurn(): Promise<never> {
        throw new Error("Integration writer tidak boleh dipanggil oleh advisory.");
      },
    } satisfies Pick<AiClient, "complete" | "completeToolTurn">;
    const driver = new AiCodingWorkerDriver(client, routing());

    try {
      const drafts = await driver.advise(advisoryInput());

      assert.equal(peak, 2);
      assert.equal(requests.length, 2);
      assert.deepEqual(
        requests.map((request) => request.model).sort(),
        ["model-challenger", "model-verifier"],
      );
      assert.equal(
        requests.every((request) => request.execution?.allowTools === false),
        true,
      );
      assert.equal(
        requests.every((request) => request.execution?.allowDelegation === false),
        true,
      );
      assert.equal(requests.every((request) => request.tools === undefined), true);
      assert.equal(
        requests.every((request) => request.fallbackPolicy === "disabled"),
        true,
      );
      assert.equal(
        requests.every((request) => request.usage?.purpose === "agent"),
        true,
      );
      assert.deepEqual(
        drafts.map((draft) => draft.role).sort(),
        ["challenger", "verifier"],
      );
      assert.equal(drafts.every((draft) => draft.status === "completed"), true);
      assert.match(
        drafts.find((draft) => draft.role === "verifier")?.summary ?? "",
        /validator deterministik/u,
      );
    } finally {
      clearTimeout(fallbackRelease);
    }
  });

  it("mengubah kegagalan satu advisor menjadi receipt gagal tanpa membatalkan yang lain", async () => {
    const client = {
      async complete(request: ChatRequest): Promise<string> {
        if (request.model === "model-challenger") {
          throw new Error("provider body yang tidak boleh bocor");
        }
        return JSON.stringify(handoff("verifier"));
      },
      async completeToolTurn(): Promise<never> {
        throw new Error("Integration writer tidak boleh dipanggil oleh advisory.");
      },
    } satisfies Pick<AiClient, "complete" | "completeToolTurn">;

    const drafts = await new AiCodingWorkerDriver(client, routing()).advise(
      advisoryInput(),
    );

    const challenger = drafts.find((draft) => draft.role === "challenger");
    const verifier = drafts.find((draft) => draft.role === "verifier");
    assert.equal(challenger?.status, "failed");
    assert.doesNotMatch(challenger?.summary ?? "", /provider body/iu);
    assert.equal(verifier?.status, "completed");
  });
});

function routing(): AiConfig {
  const models = [
    "model-writer",
    "model-challenger",
    "model-verifier",
  ];
  return {
    mode: "production",
    providerId: "openrouter",
    keys: new ApiKeyPool(["test-key-never-used"]),
    baseUrl: "https://provider.invalid/v1",
    testingModel: "",
    testingModels: {},
    models: {
      cheap: "model-writer",
      efficient: "model-writer",
      ambitious: "model-writer",
    },
    roleBindings: {
      challenger: { tier: "ambitious", modelId: "model-challenger" },
      verifier: { tier: "ambitious", modelId: "model-verifier" },
    },
    specialistDelegationEnabled: true,
    toughest: null,
    modelProfiles: new ModelProfileRegistry(models.map(profile)),
    configuredModels: [],
    memoryEmbeddingModel: null,
    rollingTokenLimit: 1_000_000,
    prices: {
      cheap: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      efficient: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      ambitious: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
    },
  };
}

function profile(id: string): ModelProfile {
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
      tools: id === "model-writer",
      toolChoice: id === "model-writer",
      namedToolChoice: false,
      structuredOutput: true,
      temperature: true,
      promptCaching: false,
      imageInput: false,
    },
    continuation: {
      preserveReasoning: false,
      preserveAssistantMessage: id === "model-writer",
    },
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  };
}

function advisoryInput(): CodingAdvisoryInput {
  return {
    run: {
      runId: "coding-run-advisor-1",
      projectId: "project-advisor-1",
      status: "running",
      phase: "planning",
      instructionRevision: 0,
      appliedInstructionRevision: 0,
      stateRevision: 2,
      taskBrief: {
        request: "Audit repository lalu perbaiki satu cacat penting.",
        objective: "Repository mempunyai pemeriksaan Repo Doctor yang andal.",
        acceptanceCriteria: ["Semua validator deterministik lulus."],
        initialConstraints: ["Pertahankan public API."],
      },
      constraints: [],
      repositoryMap: {
        instructionRevision: 0,
        workingSnapshot: "a".repeat(64),
        treeDigest: "b".repeat(64),
        symbolDigest: "c".repeat(64),
        entryCount: 12,
        symbolCount: 3,
        treeComplete: true,
        symbolsComplete: true,
        mapDigest: "d".repeat(64),
        completedAt: "2026-08-26T09:00:00.000Z",
      },
      plan: null,
      diff: null,
      validators: [],
      taskReviews: [],
      advisories: [],
      counters: {
        patches: 0,
        sandboxCalls: 0,
        activeElapsedMs: 0,
        coordinatorDecisions: 1,
      },
      limits: {
        maxPatches: 8,
        maxSandboxCalls: 8,
        maxChangedFiles: 32,
        maxChangedBytes: 1_000_000,
        maxActiveMs: 60_000,
        maxCoordinatorDecisions: 64,
      },
    },
    repositoryEvidence: {
      tree: observation("workspace.tree", "e"),
      diff: observation("workspace.diff", "f"),
    },
  };
}

function observation(kind: string, character: string) {
  return {
    kind,
    payload: { bounded: true },
    digest: character.repeat(64),
    compacted: false,
    originalCharacters: 16,
  };
}

function handoff(role: "challenger" | "verifier"): AgentHandoff {
  return {
    version: 1,
    status: "completed",
    workBriefRef: "coding-run-advisor-1",
    facts: role === "challenger"
      ? ["Scope harus tetap kecil."]
      : ["Validator deterministik menjadi bukti utama."],
    evidence: [{
      id: "tree:bounded",
      source: "tool_observation",
      summary: "Tree dan diff dibaca secara read-only.",
    }],
    assumptions: [],
    plan: role === "challenger"
      ? ["Tantang asumsi perubahan lintas file."]
      : ["Jalankan validator deterministik pada snapshot yang sama."],
    workProduct: role === "challenger"
      ? "Batasi scope dan pertahankan API publik."
      : "Gunakan test, lint, typecheck, dan build sebagai rubric.",
    openQuestions: [],
    confidence: 0.85,
    provenance: [{ source: "brief", ref: "coding-run-advisor-1" }],
    failureCodes: [],
  };
}
