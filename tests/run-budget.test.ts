import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isValidRunBudgetCheckpoint,
  RunBudgetAccount,
  RunBudgetExceededError,
  type RunBudget,
} from "../src/core/run-budget.js";

const BASE_LIMITS: RunBudget = {
  maxTotalTokens: 100,
  maxCostUsd: 1,
  maxSteps: 6,
  maxToolCalls: 5,
  maxModelCalls: 6,
  deadlineMs: 1_000,
  compactAtContextRatio: 0.8,
  maxConcurrentWorkers: 3,
};

describe("RunBudgetAccount", () => {
  it("mengakumulasi usage dan biaya aktual lintas model call", () => {
    const budget = account();
    budget.reserveModelCall({
      tier: "cheap",
      inputTokenEstimate: 10,
      maxOutputTokens: 20,
    }).settle({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimated: false,
    });
    budget.reserveModelCall({
      tier: "efficient",
      inputTokenEstimate: 10,
      maxOutputTokens: 20,
    }).settle({
      inputTokens: 8,
      outputTokens: 7,
      totalTokens: 15,
      estimated: false,
    });

    const checkpoint = budget.checkpoint();
    assert.equal(checkpoint.consumedTokens, 30);
    assert.equal(checkpoint.modelCalls, 2);
    // cheap: 10*1 + 5*2; efficient: 8*3 + 7*4 USD/million.
    assert.equal(checkpoint.consumedCostUsdNanos, "72000");
    assert.equal(budget.view(2).remainingTokens, 70);
    assert.equal(budget.view(2).remainingSteps, 4);
  });

  it("mereservasi atomik agar worker paralel tidak melampaui token", () => {
    const budget = account({ maxTotalTokens: 60 });
    const first = budget.reserveModelCall({
      tier: "cheap",
      inputTokenEstimate: 10,
      maxOutputTokens: 20,
    });

    assert.throws(
      () => budget.reserveModelCall({
        tier: "cheap",
        inputTokenEstimate: 10,
        maxOutputTokens: 20,
      }),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_tokens",
    );
    first.release();
    assert.doesNotThrow(() =>
      budget.reserveModelCall({
        tier: "cheap",
        inputTokenEstimate: 10,
        maxOutputTokens: 20,
      }).release()
    );
    assert.equal(budget.checkpoint().modelCalls, 2);
  });

  it("menahan reservation penuh saat usage attempt tidak diketahui", () => {
    const budget = account({ maxTotalTokens: 30 });
    budget.reserveModelCall({
      tier: "cheap",
      budgetClass: "final",
      inputTokenEstimate: 10,
      maxOutputTokens: 20,
    }).consumeUnknown();

    assert.equal(budget.checkpoint().consumedTokens, 30);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 1);
    assert.throws(
      () => budget.reserveModelCall({
        tier: "cheap",
        inputTokenEstimate: 0,
        maxOutputTokens: 1,
      }),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_tokens",
    );
  });

  it("mempertahankan reported cost yang diketahui pada attempt unknown", () => {
    const budget = account({ maxTotalTokens: 30 });
    budget.reserveModelCall({
      tier: "cheap",
      budgetClass: "final",
      inputTokenEstimate: 10,
      maxOutputTokens: 20,
    }).consumeUnknown("2");

    assert.equal(budget.checkpoint().consumedTokens, 30);
    assert.equal(budget.checkpoint().consumedCostUsdNanos, "2000000000");
    assert.equal(budget.overageReason(), "budget_cost");
  });

  it("memperlakukan usage runtime yang melampaui integer aman sebagai unknown", () => {
    const budget = account({ maxTotalTokens: 30 });
    budget.reserveModelCall({
      tier: "cheap",
      budgetClass: "final",
      inputTokenEstimate: 10,
      maxOutputTokens: 20,
    }).settle({
      inputTokens: Number.MAX_SAFE_INTEGER + 1,
      outputTokens: 0,
      totalTokens: Number.MAX_SAFE_INTEGER + 1,
      estimated: false,
    });

    assert.equal(budget.checkpoint().consumedTokens, 30);
    assert.equal(budget.checkpoint().unknownUsageAttempts, 1);
  });

  it("menulis reservation yang masih live sebagai usage unknown pada checkpoint", () => {
    const budget = account({ maxTotalTokens: 30 });
    budget.reserveModelCall({
      tier: "cheap",
      budgetClass: "final",
      inputTokenEstimate: 10,
      maxOutputTokens: 20,
    });

    const checkpoint = budget.checkpoint();
    assert.equal(checkpoint.consumedTokens, 30);
    assert.equal(checkpoint.modelCalls, 1);
    assert.equal(checkpoint.unknownUsageAttempts, 1);
  });

  it("menyisakan waktu untuk jawaban akhir, bukan hanya token dan biaya", () => {
    // Sintesis akhir terukur 4,3-17,6 detik pada model sungguhan; anggaran
    // work karena itu berhenti 18 detik sebelum dinding, sementara sisa waktu
    // aktif tetap dilaporkan apa adanya.
    let now = 1_000;
    const budget = account({ deadlineMs: 45_000 }, () => now);
    assert.equal(budget.remainingActiveMs(), 45_000);
    assert.equal(budget.remainingWorkMs(), 27_000);

    now = 1_000 + 30_000;
    assert.equal(budget.remainingActiveMs(), 15_000);
    assert.equal(budget.remainingWorkMs(), 0, "sisa 15 detik milik jawaban akhir");

    now = 1_000 + 45_000;
    assert.equal(budget.remainingActiveMs(), 0);
    assert.equal(budget.remainingWorkMs(), 0);
  });

  it("mempertahankan waktu aktif saat resume tanpa menghitung jeda pengguna", () => {
    let now = 1_000;
    const first = account({}, () => now);
    now = 1_400;
    const checkpoint = first.checkpoint();
    assert.equal(checkpoint.activeElapsedMs, 400);

    now = 50_000;
    const resumed = account({}, () => now);
    resumed.restore(checkpoint);
    assert.equal(resumed.remainingActiveMs(), 600);
    now = 50_200;
    assert.equal(resumed.remainingActiveMs(), 400);
  });

  it("memakai biaya provider yang lebih tinggi dan menutup call berikutnya", () => {
    const budget = account({ maxCostUsd: 0.00002 });
    budget.reserveModelCall({
      tier: "cheap",
      budgetClass: "final",
      inputTokenEstimate: 0,
      maxOutputTokens: 10,
    }).settle(
      { inputTokens: 0, outputTokens: 1, totalTokens: 1, estimated: false },
      "0.00003",
    );

    assert.equal(budget.checkpoint().consumedCostUsdNanos, "30000");
    assert.equal(budget.view(0).remainingCostUsd, "0");
    assert.throws(
      () => budget.reserveModelCall({
        tier: "cheap",
        inputTokenEstimate: 0,
        maxOutputTokens: 1,
      }),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_cost",
    );
    assert.throws(
      () => budget.consumeToolCall(),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_cost",
    );
  });

  it("tidak memulai tool setelah usage aktual melewati budget token", () => {
    const budget = account({ maxTotalTokens: 100 });
    budget.reserveModelCall({
      tier: "cheap",
      inputTokenEstimate: 1,
      maxOutputTokens: 1,
    }).settle({
      inputTokens: 100,
      outputTokens: 1,
      totalTokens: 101,
      estimated: false,
    });

    assert.equal(budget.overageReason(), "budget_tokens");
    assert.throws(
      () => budget.consumeToolCall(),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_tokens",
    );
  });

  it("mengkanonisasi nilai USD kecil tanpa menghilangkan biaya", () => {
    const budget = new RunBudgetAccount({
      limits: {
        ...BASE_LIMITS,
        maxTotalTokens: 1_000_000,
        maxCostUsd: 0.0000001,
      },
      prices: {
        cheap: {
          inputPerMillionUsd: 0.0000001,
          outputPerMillionUsd: 0.0000001,
        },
      },
    }, () => 1_000);
    budget.reserveModelCall({
      tier: "cheap",
      budgetClass: "final",
      inputTokenEstimate: 1,
      maxOutputTokens: 999_999,
    }).consumeUnknown();

    assert.equal(budget.checkpoint().consumedCostUsdNanos, "100");
    assert.equal(budget.view(0).remainingCostUsd, "0");
    assert.throws(
      () => new RunBudgetAccount({
        limits: { maxCostUsd: 0.0000000001 },
      }),
      /Kebijakan RunBudget tidak sah/u,
    );
  });

  it("melindungi token dan biaya untuk final synthesis", () => {
    const tokens = account({ maxTotalTokens: 90 });
    tokens.reserveModelCall({
      tier: "cheap",
      budgetClass: "work",
      inputTokenEstimate: 0,
      maxOutputTokens: 45,
    }).consumeUnknown();

    assert.equal(tokens.view(0).remainingWorkTokens, 0);
    assert.equal(tokens.view(0).protectedFinalTokens, 45);
    const resumedTokens = account({ maxTotalTokens: 90 });
    resumedTokens.restore(tokens.checkpoint());
    assert.equal(resumedTokens.view(0).remainingWorkTokens, 0);
    assert.equal(resumedTokens.view(0).protectedFinalTokens, 45);
    assert.throws(
      () => tokens.reserveModelCall({
        tier: "cheap",
        budgetClass: "work",
        inputTokenEstimate: 0,
        maxOutputTokens: 1,
      }),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_tokens",
    );
    assert.doesNotThrow(() =>
      resumedTokens.reserveModelCall({
        tier: "cheap",
        budgetClass: "final",
        inputTokenEstimate: 15,
        maxOutputTokens: 30,
      }).release()
    );

    const costs = new RunBudgetAccount({
      limits: { ...BASE_LIMITS, maxCostUsd: 4 },
      prices: {
        cheap: { inputPerMillionUsd: 0, outputPerMillionUsd: 1_000_000 },
      },
    }, () => 1_000);
    const work = costs.reserveModelCall({
      tier: "cheap",
      budgetClass: "work",
      inputTokenEstimate: 0,
      maxOutputTokens: 2,
    });
    assert.equal(costs.view(0).remainingWorkCostUsd, "0");
    assert.equal(costs.view(0).protectedFinalCostUsd, "2");
    assert.throws(
      () => costs.reserveModelCall({
        tier: "cheap",
        budgetClass: "work",
        inputTokenEstimate: 0,
        maxOutputTokens: 1,
      }),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_cost",
    );
    const final = costs.reserveModelCall({
      tier: "cheap",
      budgetClass: "final",
      inputTokenEstimate: 0,
      maxOutputTokens: 2,
    });
    final.release();
    work.release();
  });

  it("mengunci headroom final pada budget default 96.000 token", () => {
    const budget = new RunBudgetAccount({}, () => 1_000);
    budget.reserveModelCall({
      tier: "cheap",
      budgetClass: "work",
      inputTokenEstimate: 0,
      maxOutputTokens: 48_000,
    }).consumeUnknown();

    assert.equal(budget.view(0).remainingWorkTokens, 0);
    assert.equal(budget.view(0).protectedFinalTokens, 48_000);
    assert.doesNotThrow(() =>
      budget.reserveModelCall({
        tier: "ambitious",
        budgetClass: "final",
        inputTokenEstimate: 15_232,
        maxOutputTokens: 32_768,
      }).release()
    );
    assert.throws(
      () => budget.reserveModelCall({
        tier: "ambitious",
        budgetClass: "final",
        inputTokenEstimate: 15_233,
        maxOutputTokens: 32_768,
      }),
      (error: unknown) =>
        error instanceof RunBudgetExceededError &&
        error.reason === "budget_tokens",
    );
  });

  it("menolak checkpoint dengan field asing atau counter rusak", () => {
    const checkpoint = account().checkpoint();
    assert.equal(isValidRunBudgetCheckpoint(checkpoint), true);
    assert.equal(isValidRunBudgetCheckpoint({ ...checkpoint, secret: "x" }), false);
    assert.equal(isValidRunBudgetCheckpoint({
      ...checkpoint,
      unknownUsageAttempts: checkpoint.modelCalls + 1,
    }), false);
  });
});

function account(
  limits: Partial<RunBudget> = {},
  now: () => number = () => 1_000,
): RunBudgetAccount {
  return new RunBudgetAccount({
    limits: { ...BASE_LIMITS, ...limits },
    prices: {
      cheap: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
      efficient: { inputPerMillionUsd: 3, outputPerMillionUsd: 4 },
      ambitious: { inputPerMillionUsd: 5, outputPerMillionUsd: 6 },
    },
  }, now);
}
