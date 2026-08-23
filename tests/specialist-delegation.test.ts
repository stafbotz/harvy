import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SpecialistDelegationExecutor,
} from "../src/agent/specialist-delegation.js";
import { createModelSpecialistWorker } from "../src/ai/specialist.js";
import type { AiClient, ChatRequest } from "../src/ai/client.js";
import {
  parseAgentHandoff,
  parseWorkBrief,
  type AgentHandoff,
  type WorkBrief,
} from "../src/domain/agent-handoff.js";
import type { AgentExecutionContext } from "../src/harness/agent-harness.js";
import { privateAgentScope } from "../src/harness/scope.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";

describe("AgentHandoff provider-neutral", () => {
  it("menerima brief/handoff bounded dan menolak field reasoning privat", () => {
    assert.ok(parseWorkBrief(brief()));
    assert.ok(parseAgentHandoff(handoff()));

    for (const forbidden of [
      "chainOfThought",
      "chain_of_thought",
      "privateReasoning",
      "private_reasoning",
      "scratchpad",
    ]) {
      assert.equal(parseWorkBrief({ ...brief(), [forbidden]: "rahasia" }), null);
      assert.equal(parseAgentHandoff({ ...handoff(), [forbidden]: "rahasia" }), null);
    }
  });

  it("mengunci PLAN_CONFLICT sebagai status dan failure code terstruktur", () => {
    assert.ok(parseAgentHandoff(handoff({
      status: "plan_conflict",
      workProduct: null,
      failureCodes: ["plan_conflict"],
    })));
    assert.equal(parseAgentHandoff(handoff({
      status: "plan_conflict",
      workProduct: null,
      failureCodes: [],
    })), null);
  });
});

describe("SpecialistDelegationExecutor", () => {
  it("memanggil challenger langsung tanpa fixed verifier/heavy pipeline", async () => {
    const called: string[] = [];
    const executor = new SpecialistDelegationExecutor(
      async (request) => {
        called.push(request.role);
        return handoff({ workProduct: "Trade-off yang terlewat." });
      },
      ["strong_worker", "heavy_executor", "verifier", "challenger"],
      () => ({ decision: "allow" }),
    );
    const validated = executor.validate({ role: "challenger", brief: brief() });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const result = await executor.execute(validated.value, context());
    const summary = JSON.parse(result.summary) as {
      role: string;
      depth: number;
      recursiveDelegation: boolean;
      handoff: { workProduct: string };
    };
    assert.equal(result.status, "ok");
    assert.deepEqual(called, ["challenger"]);
    assert.equal(summary.role, "challenger");
    assert.equal(summary.depth, 1);
    assert.equal(summary.recursiveDelegation, false);
    assert.equal(summary.handoff.workProduct, "Trade-off yang terlewat.");
  });

  it("memanggil specialist yang sama pada WhatsApp privat", async () => {
    let ownerId = "";
    const executor = new SpecialistDelegationExecutor(
      async (_request, workerContext) => {
        ownerId = workerContext.ownerId;
        return handoff();
      },
      ["challenger"],
      () => ({ decision: "allow" }),
    );
    const validated = executor.validate({ role: "challenger", brief: brief() });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const waContext: AgentExecutionContext = {
      ...context(),
      scope: privateAgentScope("whatsapp", "whatsapp-user:test"),
    };

    const result = await executor.execute(validated.value, waContext);
    assert.equal(result.status, "ok");
    assert.equal(ownerId, "whatsapp-user:test");
  });

  it("menolak brief lintas run sebelum memanggil worker", async () => {
    let calls = 0;
    const executor = new SpecialistDelegationExecutor(async () => {
      calls += 1;
      return handoff();
    });
    const validated = executor.validate({
      role: "verifier",
      brief: { ...brief(), originalRequestRef: "run-lain" },
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const result = await executor.execute(validated.value, context());
    assert.equal(result.status, "error");
    assert.equal(calls, 0);
  });

  it("menolak credential dan permintaan capability sebelum worker", async () => {
    let calls = 0;
    const executor = new SpecialistDelegationExecutor(
      async () => {
        calls += 1;
        return handoff();
      },
      ["challenger"],
      () => ({ decision: "allow" }),
    );
    for (const unsafeBrief of [
      {
        ...brief(),
        facts: ["Authorization: Bearer secret-value-that-must-not-cross"],
      },
      { ...brief(), requestedCapabilities: ["terminal.run"] },
    ]) {
      const validated = executor.validate({
        role: "challenger",
        brief: unsafeBrief,
      });
      assert.equal(validated.ok, true);
      if (!validated.ok) continue;
      const result = await executor.execute(validated.value, context());
      assert.equal(result.status, "error");
      assert.match(result.summary, /minimum-necessary/u);
    }
    assert.equal(calls, 0);
  });

  it("menolak eksekusi bila composition belum memasang policy otorisasi", async () => {
    let calls = 0;
    const executor = new SpecialistDelegationExecutor(async () => {
      calls += 1;
      return handoff();
    });
    const validated = executor.validate({ role: "challenger", brief: brief() });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const result = await executor.execute(validated.value, context());
    assert.equal(result.status, "error");
    assert.match(result.summary, /policy_unavailable/u);
    assert.equal(calls, 0);
  });

  it("policy code-owned dapat menolak verifier saat bukti objektif sudah cukup", async () => {
    let calls = 0;
    const executor = new SpecialistDelegationExecutor(
      async () => {
        calls += 1;
        return handoff();
      },
      ["verifier", "challenger"],
      ({ request }) => request.role === "verifier"
        ? { decision: "deny", code: "objective_validation_sufficient" }
        : { decision: "allow" },
    );
    const validated = executor.validate({ role: "verifier", brief: brief() });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const result = await executor.execute(validated.value, context());
    assert.equal(result.status, "error");
    assert.match(result.summary, /objective_validation_sufficient/u);
    assert.equal(calls, 0);
  });

  it("tidak meneruskan detail error provider/worker ke observation root", async () => {
    const executor = new SpecialistDelegationExecutor(
      async () => {
        throw new Error("SECRET_PROVIDER_BODY_CANARY");
      },
      ["challenger"],
      () => ({ decision: "allow" }),
    );
    const validated = executor.validate({ role: "challenger", brief: brief() });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const result = await executor.execute(validated.value, context());
    assert.equal(result.status, "error");
    assert.doesNotMatch(result.summary, /SECRET_PROVIDER_BODY_CANARY/u);
    assert.match(result.summary, /gagal sebelum handoff sah/u);
  });

  it("model worker memakai exact cognitive role binding dan job prompt", async () => {
    const requests: ChatRequest[] = [];
    const client = {
      async complete(request: ChatRequest): Promise<string> {
        requests.push(request);
        return JSON.stringify(handoff({ workProduct: "Sudut pandang alternatif." }));
      },
    } as Pick<AiClient, "complete">;
    const worker = createModelSpecialistWorker(client, {
      mode: "production",
      testingModel: "",
      models: {
        cheap: "cheap-model",
        efficient: "everyday-model",
        ambitious: "deep-model",
      },
      roleBindings: {
        challenger: { tier: "efficient", modelId: "wisdom-model" },
      },
    });

    const runBudget = new RunBudgetAccount();
    await worker(
      { role: "challenger", brief: parsedBrief() },
      {
        runId: "run-1",
        ownerId: "student",
        role: "challenger",
        signal: new AbortController().signal,
        runBudget,
        workSignals: {
          difficulty: "mechanical",
          stakes: "low",
          uncertainty: "low",
        },
      },
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.model, "wisdom-model");
    assert.equal(requests[0]?.execution?.tier, "efficient");
    assert.equal(requests[0]?.execution?.cognitiveRole, "challenger");
    assert.equal(requests[0]?.execution?.difficulty, "mechanical");
    assert.equal(requests[0]?.execution?.stakes, "low");
    assert.equal(requests[0]?.execution?.uncertainty, "low");
    assert.equal(requests[0]?.execution?.allowTools, false);
    assert.equal(requests[0]?.execution?.allowDelegation, false);
    assert.equal(requests[0]?.tools, undefined);
    assert.equal(requests[0]?.runBudget, runBudget);
    assert.equal(requests[0]?.fallbackPolicy, "disabled");
    assert.match(requests[0]?.messages[0]?.content ?? "", /trade-off/u);
    assert.doesNotMatch(
      JSON.stringify(requests[0]?.messages[1]),
      /chainOfThought|privateReasoning|scratchpad/u,
    );
    assert.doesNotMatch(JSON.stringify(requests[0]?.messages), /student/u);
  });
});

function parsedBrief(): WorkBrief {
  const parsed = parseWorkBrief(brief());
  assert.ok(parsed);
  return parsed;
}

function brief(): WorkBrief {
  return {
    version: 1,
    goal: "Nilai pilihan belajar dan kerja paruh waktu.",
    originalRequestRef: "run-1",
    facts: ["Waktu pengguna terbatas."],
    constraints: ["Jangan mengambil keputusan atas nama pengguna."],
    evidence: [{
      id: "request-1",
      source: "user_request",
      summary: "Pengguna meminta perspektif kedua.",
    }],
    assumptions: [],
    plan: ["Bandingkan trade-off utama."],
    openQuestions: [],
    acceptanceCriteria: ["Menyebut risiko dan alternatif."],
    requestedCapabilities: [],
  };
}

function handoff(
  overrides: Partial<AgentHandoff> = {},
): AgentHandoff {
  return {
    version: 1,
    status: "completed",
    workBriefRef: "run-1",
    facts: ["Waktu terbatas."],
    evidence: [{
      id: "request-1",
      source: "user_request",
      summary: "Permintaan perspektif kedua.",
    }],
    assumptions: [],
    plan: ["Bandingkan pilihan."],
    workProduct: "Pertimbangkan beban dan reversibilitas.",
    openQuestions: [],
    confidence: 0.8,
    provenance: [{ source: "brief", ref: "run-1" }],
    failureCodes: [],
    ...overrides,
  };
}

function context(): AgentExecutionContext {
  return {
    runId: "run-1",
    step: 0,
    scope: privateAgentScope("telegram", "student"),
    idempotencyKey: "idempotent",
    signal: new AbortController().signal,
    runBudget: new RunBudgetAccount(),
  };
}
