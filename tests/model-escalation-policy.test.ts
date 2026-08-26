import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ModelProfile } from "../src/ai/model-profile.js";
import {
  ModelEscalationPolicy,
  ModelEscalationProviderError,
  OneShotModelEscalationService,
  type ExecuteModelEscalationInput,
  type ToughestModelTarget,
} from "../src/core/model-escalation-policy.js";
import { FileModelEscalationRepository } from
  "../src/storage/file-model-escalation-repository.js";

describe("ModelEscalationPolicy", () => {
  const policy = new ModelEscalationPolicy();

  it("memisahkan retry provider dari eskalasi intelligence dan gagal tertutup", () => {
    assert.deepEqual(policy.decide(input({ providerFailure: true })), {
      decision: "none",
      code: "provider_retry_or_fallback",
    });
    assert.deepEqual(policy.decide(input({ validationFailures: [] })), {
      decision: "none",
      code: "no_validator_failure",
    });
    assert.deepEqual(policy.decide(input({ target: null })), {
      decision: "none",
      code: "toughest_unavailable",
    });
    assert.deepEqual(policy.decide(input({ remainingModelCalls: 0 })), {
      decision: "none",
      code: "budget_exhausted",
    });
    assert.deepEqual(policy.decide(input({
      target: target({ profile: profile({ verification: "compatibility" }) }),
    })), {
      decision: "none",
      code: "target_profile_unverified",
    });
    assert.throws(
      () => policy.decide(input({
        validationFailures: ["invalid_schema", "invalid_schema"],
      })),
      /duplikat/u,
    );
  });

  it("mengikat keputusan ke privacy path dan execution plan one-shot", () => {
    assert.deepEqual(policy.decide(input({
      sensitivity: "sensitive",
      sourcePrivacyDomain: "workspace.private",
      crossProviderApproved: false,
    })), {
      decision: "none",
      code: "privacy_path_denied",
    });

    const decision = policy.decide(input({
      sensitivity: "sensitive",
      crossProviderApproved: true,
      validationFailures: [
        "missing_constraint",
        "low_confidence_high_consequence",
      ],
    }));
    assert.equal(decision.decision, "escalate");
    if (decision.decision !== "escalate") return;
    assert.equal(decision.reason, "low_confidence_high_consequence");
    assert.equal(decision.execution.tier, "ambitious");
    assert.equal(decision.execution.routeTier, "toughest");
    assert.equal(decision.execution.routeReason, "validator_escalation");
    assert.equal(decision.execution.promptMaterial, "structured-brief+candidate");
    assert.equal(decision.execution.maxSteps, 1);
    assert.equal(decision.execution.allowTools, false);
    assert.equal(decision.execution.allowDelegation, false);
    assert.equal(decision.execution.sourcePrivacyDomain, "workspace.private");
    assert.equal(decision.execution.targetPrivacyDomain, "provider.approved");
  });
});

describe("OneShotModelEscalationService", () => {
  it("mereservasi sebelum invoke dan tidak memanggil ulang setelah restart", async () => {
    await withRepository(async (file, repository) => {
      let calls = 0;
      const service = escalationService(repository);
      const first = await service.execute(
        input(),
        async (route) => {
          calls += 1;
          assert.equal(route.execution.routeTier, "toughest");
          return { value: { answer: 42 }, outputDigest: "b".repeat(64) };
        },
        (value) => value.answer === 42,
      );
      assert.equal(first.status, "accepted");
      if (first.status === "accepted") {
        assert.equal(first.record.status, "completed");
        assert.equal(first.record.outcomeCode, "accepted");
        assert.equal(first.record.outputDigest, "b".repeat(64));
      }

      const restarted = escalationService(
        new FileModelEscalationRepository(file),
      );
      const replay = await restarted.execute(
        input(),
        async () => {
          calls += 1;
          return { value: { answer: 99 }, outputDigest: "c".repeat(64) };
        },
        () => true,
      );
      assert.equal(replay.status, "already_used");
      assert.equal(calls, 1);
    });
  });

  it("menutup candidate/provider failure dan tidak mengulang stage", async () => {
    await withRepository(async (_file, repository) => {
      const service = escalationService(repository);
      const rejectedInput = input({ stageKey: "run-1:critic-rejected" });
      const rejected = await service.execute(
        rejectedInput,
        async () => ({ value: "candidate", outputDigest: "c".repeat(64) }),
        () => false,
      );
      assert.equal(rejected.status, "failed");
      if (rejected.status === "failed") {
        assert.equal(rejected.code, "candidate_rejected");
      }

      const providerInput = input({ stageKey: "run-1:critic-provider" });
      let calls = 0;
      const failed = await service.execute(
        providerInput,
        async () => {
          calls += 1;
          throw new ModelEscalationProviderError();
        },
        () => true,
      );
      assert.equal(failed.status, "failed");
      if (failed.status === "failed") assert.equal(failed.code, "provider_failure");
      const replay = await service.execute(
        providerInput,
        async () => {
          calls += 1;
          return { value: "late", outputDigest: "d".repeat(64) };
        },
        () => true,
      );
      assert.equal(replay.status, "already_used");
      assert.equal(calls, 1);
    });
  });

  it("menutup reservation ambigu saat startup dan menolak collision", async () => {
    await withRepository(async (_file, repository) => {
      const service = escalationService(repository);
      const ambiguous = input({ stageKey: "run-1:critic-ambiguous" });
      await repository.reserve(reservation(ambiguous));
      const recovered = await service.markReservedUnknown(ambiguous.stageKey);
      assert.equal(recovered?.status, "unknown");
      assert.equal(recovered?.outcomeCode, "outcome_unknown");
      const replay = await service.execute(
        ambiguous,
        async () => ({ value: true, outputDigest: "e".repeat(64) }),
        () => true,
      );
      assert.equal(replay.status, "already_used");

      const acceptedInput = input({ stageKey: "run-1:critic-collision" });
      await service.execute(
        acceptedInput,
        async () => ({ value: true, outputDigest: "f".repeat(64) }),
        () => true,
      );
      await assert.rejects(
        () => service.execute(
          { ...acceptedInput, requestDigest: "9".repeat(64) },
          async () => ({ value: true, outputDigest: "8".repeat(64) }),
          () => true,
        ),
        /bertabrakan/u,
      );
    });
  });

  it("menutup seluruh reservation menggantung sebelum admission startup", async () => {
    await withRepository(async (_file, repository) => {
      const service = escalationService(repository);
      const first = input({ stageKey: "run-1:startup-first" });
      const second = input({ stageKey: "run-1:startup-second" });
      await repository.reserve(reservation(first));
      await repository.reserve(reservation(second));
      assert.equal((await repository.listReserved()).length, 2);
      assert.equal(await service.recoverReserved(), 2);
      assert.equal((await repository.listReserved()).length, 0);
      assert.equal((await repository.load(first.stageKey))?.status, "unknown");
      assert.equal((await repository.load(second.stageKey))?.outcomeCode, "outcome_unknown");
    });
  });

  it("menolak schema outcome asing dan settlement kedua", async () => {
    await withRepository(async (file, repository) => {
      const candidate = input({ stageKey: "run-1:critic-schema" });
      const reserved = await repository.reserve(reservation(candidate));
      assert.equal(reserved.status, "reserved");
      if (reserved.status !== "reserved") return;
      const completed = await repository.save({
        ...withoutRevision(reserved.record),
        status: "completed",
        outcomeCode: "accepted",
        outputDigest: "7".repeat(64),
        settledAt: "2026-08-15T00:00:01.000Z",
      }, reserved.record.stateRevision);
      assert.equal(completed.status, "saved");
      if (completed.status !== "saved") return;
      await assert.rejects(
        () => repository.save({
          ...withoutRevision(completed.record),
          status: "failed",
          outcomeCode: "execution_failure",
          outputDigest: null,
          settledAt: "2026-08-15T00:00:02.000Z",
        }, completed.record.stateRevision),
        /hanya dapat disettle sekali/u,
      );

      const database = JSON.parse(await readFile(file, "utf8")) as {
        records: Array<Record<string, unknown>>;
      };
      database.records[0]!["outcomeCode"] = "invented_outcome";
      await writeFile(file, `${JSON.stringify(database)}\n`, "utf8");
      await assert.rejects(
        () => new FileModelEscalationRepository(file).load(candidate.stageKey),
        /tidak sah/u,
      );
    });
  });
});

function input(
  overrides: Partial<ExecuteModelEscalationInput> = {},
): ExecuteModelEscalationInput {
  return {
    stageKey: "run-1:critic",
    requestDigest: "a".repeat(64),
    role: "critic",
    validationFailures: ["observation_contradiction"],
    providerFailure: false,
    sensitivity: "ordinary",
    sourcePrivacyDomain: "workspace.private",
    crossProviderApproved: false,
    remainingModelCalls: 1,
    remainingOutputTokens: 4_096,
    maxOutputTokens: 2_048,
    deadlineMs: 20_000,
    target: target(),
    ...overrides,
  };
}

function target(
  overrides: Partial<ToughestModelTarget> = {},
): ToughestModelTarget {
  return {
    providerId: "openrouter",
    modelId: "model-toughest",
    privacyDomain: "provider.approved",
    profile: profile(),
    ...overrides,
  };
}

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    provider: "openrouter",
    id: "model-toughest",
    verification: "explicit",
    reasoning: {
      mandatory: false,
      defaultEffort: "medium",
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
    contextWindow: null,
    maxOutputTokens: null,
    ...overrides,
  };
}

function reservation(inputValue: ExecuteModelEscalationInput) {
  const selectedTarget = inputValue.target;
  if (!selectedTarget) throw new Error("Fixture target wajib tersedia.");
  return {
    version: 1 as const,
    stageKey: inputValue.stageKey,
    reservationId: `reservation-${inputValue.stageKey.replace(/[^a-z0-9]/giu, "-")}`,
    requestDigest: inputValue.requestDigest,
    reason: inputValue.validationFailures[0]!,
    role: inputValue.role,
    sourcePrivacyDomain: inputValue.sourcePrivacyDomain,
    targetPrivacyDomain: selectedTarget.privacyDomain,
    targetProviderId: selectedTarget.providerId,
    targetModelId: selectedTarget.modelId,
    promptMaterial: "structured-brief+candidate" as const,
    status: "reserved" as const,
    outcomeCode: null,
    outputDigest: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    settledAt: null,
  };
}

function escalationService(repository: FileModelEscalationRepository) {
  return new OneShotModelEscalationService(
    repository,
    undefined,
    () => new Date("2026-08-15T00:00:01.000Z"),
    () => "fixed-id",
  );
}

function withoutRevision<T extends { stateRevision: number }>(record: T) {
  const { stateRevision: _revision, ...rest } = record;
  return rest;
}

async function withRepository(
  action: (
    file: string,
    repository: FileModelEscalationRepository,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "harvy-model-escalation-"));
  const file = join(directory, "escalations.json");
  try {
    await action(file, new FileModelEscalationRepository(file));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
