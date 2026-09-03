import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ApiKeyPool } from "../src/ai/key-pool.js";
import type { ChatRequest } from "../src/ai/client.js";
import { CodingValidatorToughestRecovery } from
  "../src/ai/coding-validator-escalation.js";
import { ModelProfileRegistry, type ModelProfile } from
  "../src/ai/model-profile.js";
import type { AiConfig } from "../src/config.js";
import type { CodingCoordinatorRunView } from
  "../src/core/coding-run-coordinator.js";
import { OneShotModelEscalationService } from
  "../src/core/model-escalation-policy.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import { FileModelEscalationRepository } from
  "../src/storage/file-model-escalation-repository.js";

describe("CodingValidatorToughestRecovery", () => {
  it("memanggil critic tanpa tool tepat sekali setelah test gagal berulang", async () => {
    await withRepository(async (repository) => {
      const requests: ChatRequest[] = [];
      const client = {
        async complete(request: ChatRequest): Promise<string> {
          requests.push(request);
          return JSON.stringify({
            recoveryHint: "Periksa normalisasi nilai sebelum assertion lalu ulangi test exact.",
          });
        },
      };
      const run = runView();
      const recovery = new CodingValidatorToughestRecovery(
        client,
        routing(),
        new OneShotModelEscalationService(repository),
        () => budget(),
        { sourcePrivacyDomain: "workspace.private" },
      );
      const input = {
        run,
        receipt: run.validators[1]!,
        diagnostic: {
          status: "exited" as const,
          exitCode: 1,
          signal: null,
          stdout: "AssertionError: expected 2 but received 3",
          stderr: "",
          truncated: false,
          artifacts: [],
        },
      };
      const accepted = await recovery.recover(input);
      assert.equal(accepted.status, "accepted");
      assert.match(accepted.recoveryHint ?? "", /ulangi test exact/u);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.fallbackPolicy, "disabled");
      assert.equal(requests[0]?.tools, undefined);
      assert.equal(requests[0]?.execution?.routeTier, "toughest");
      assert.equal(requests[0]?.execution?.allowTools, false);
      assert.equal(requests[0]?.execution?.allowDelegation, false);
      assert.equal(requests[0]?.execution?.verbosity, "low");
      assert.equal(requests[0]?.execution?.effectiveEffort, "high");

      const replay = await recovery.recover(input);
      assert.deepEqual(replay, {
        status: "already_used",
        code: "stage_already_used",
      });
      assert.equal(requests.length, 1);
    });
  });

  it("tidak memanggil provider untuk satu failure atau privacy path berbeda", async () => {
    await withRepository(async (repository) => {
      let calls = 0;
      const client = {
        async complete(): Promise<string> {
          calls += 1;
          return JSON.stringify({ recoveryHint: "hint" });
        },
      };
      const single = runView();
      single.validators = [single.validators[0]!];
      const ordinary = new CodingValidatorToughestRecovery(
        client,
        routing(),
        new OneShotModelEscalationService(repository),
        () => budget(),
        { sourcePrivacyDomain: "workspace.private" },
      );
      assert.deepEqual(await ordinary.recover({
        run: single,
        receipt: single.validators[0]!,
        diagnostic: null,
      }), {
        status: "not_escalated",
        code: "failure_not_repeated",
      });

      const repeated = runView();
      const privateBoundary = new CodingValidatorToughestRecovery(
        client,
        routing("provider.other"),
        new OneShotModelEscalationService(repository),
        () => budget(),
        { sourcePrivacyDomain: "workspace.private" },
      );
      assert.deepEqual(await privateBoundary.recover({
        run: repeated,
        receipt: repeated.validators[1]!,
        diagnostic: null,
      }), {
        status: "not_escalated",
        code: "privacy_path_denied",
      });
      assert.equal(calls, 0);
    });
  });
});

function routing(privacyDomain = "workspace.private"): AiConfig {
  const target = profile();
  return {
    mode: "production",
    providerId: "openrouter",
    keys: new ApiKeyPool(["test-key-never-used"]),
    baseUrl: "https://provider.invalid/v1",
    testingModel: "",
    testingModels: {},
    models: {
      cheap: "model-cheap",
      efficient: "model-efficient",
      ambitious: "model-ambitious",
    },
    specialistDelegationEnabled: false,
    toughest: { modelId: target.id, privacyDomain },
    modelProfiles: new ModelProfileRegistry([target]),
    configuredModels: [],
    memoryEmbeddingModel: null,
    memoryEmbeddingLocalModel: null,
    memoryEmbeddingCacheFolder: "./data/model-cache",
    operatorChatId: null,
    rollingTokenLimit: 1_000_000,
    prices: {
      cheap: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      efficient: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      ambitious: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
    },
  };
}

function profile(): ModelProfile {
  return {
    provider: "openrouter",
    id: "model-toughest",
    verification: "explicit",
    reasoning: {
      mandatory: true,
      defaultEffort: "high",
      supportedEfforts: ["low", "medium", "high"],
      wireFormat: "openrouter-reasoning",
    },
    supports: {
      tools: false,
      toolChoice: false,
      namedToolChoice: false,
      structuredOutput: true,
      temperature: true,
      promptCaching: false,
      imageInput: false,
    },
    continuation: {
      preserveReasoning: true,
      preserveAssistantMessage: true,
    },
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
  };
}

function budget(): RunBudgetAccount {
  return new RunBudgetAccount({
    limits: {
      maxTotalTokens: 200_000,
      maxCostUsd: 10,
      maxSteps: 64,
      maxToolCalls: 64,
      maxModelCalls: 64,
      deadlineMs: 120_000,
      compactAtContextRatio: 0.82,
      maxConcurrentWorkers: 1,
    },
  });
}

function runView(): CodingCoordinatorRunView {
  return {
    runId: "coding-run-1",
    projectId: "project-1",
    status: "running",
    phase: "editing",
    instructionRevision: 1,
    appliedInstructionRevision: 1,
    stateRevision: 9,
    taskBrief: {
      request: "Perbaiki penjumlahan.",
      objective: "Hasil penjumlahan benar.",
      acceptanceCriteria: ["Test penjumlahan lulus."],
      initialConstraints: [],
    },
    constraints: [],
    repositoryMap: null,
    plan: null,
    diff: {
      baseSnapshot: "a".repeat(64),
      workingSnapshot: "b".repeat(64),
      files: [{
        path: "src/add.ts",
        status: "modified",
        beforeSha256: "c".repeat(64),
        afterSha256: "d".repeat(64),
        beforeSize: 20,
        afterSize: 21,
        binary: false,
      }],
      addedBytes: 1,
      removedBytes: 0,
      generatedAt: "2026-08-15T00:00:00.000Z",
    },
    validators: [1, 2].map((index) => ({
      receiptId: `validator-${index}`,
      kind: "test" as const,
      status: "failed" as const,
      instructionRevision: 1,
      completedAt: `2026-08-15T00:00:0${index}.000Z`,
    })),
    taskReviews: [],
    counters: {
      patches: 2,
      sandboxCalls: 2,
      activeElapsedMs: 1_000,
      coordinatorDecisions: 4,
    },
    limits: {
      maxPatches: 64,
      maxSandboxCalls: 32,
      maxChangedFiles: 256,
      maxChangedBytes: 32 * 1024 * 1024,
      maxActiveMs: 2 * 60 * 60_000,
      maxCoordinatorDecisions: 512,
    },
  };
}

async function withRepository(
  action: (repository: FileModelEscalationRepository) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "harvy-coding-escalation-"));
  try {
    await action(new FileModelEscalationRepository(join(directory, "state.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
