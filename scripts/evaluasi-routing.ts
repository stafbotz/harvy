import { resolveModel } from "../src/ai/model-policy.js";
import { resolveModelProfile } from "../src/ai/model-profile.js";
import { AiError, AiResponseError } from "../src/ai/client.js";
import { loadConfig } from "../src/config.js";
import { ExecutionPolicy } from "../src/core/execution-policy.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import {
  buildRoutingEvalEnvelope,
  ROUTING_EVAL_CASES,
  routingVariantsForCase,
  type RoutingEvalCase,
  type RoutingEvalVariant,
} from "./routing-eval-corpus.js";

const all = process.argv.includes("--all");
const selectedCases = all ? ROUTING_EVAL_CASES : ROUTING_EVAL_CASES.slice(0, 1);
const config = loadConfig();
const client = await createInstrumentedAiClient(
  config,
  "evaluation",
);
const model = resolveModel("ambitious", config.ai);
const profile = resolveModelProfile("ambitious", config.ai);
const maxOutputTokens = Math.min(4_096, profile?.maxOutputTokens ?? 4_096);
const policy = new ExecutionPolicy();

const jobs = selectedCases.flatMap((testCase) =>
  routingVariantsForCase(testCase).map((variant) => ({ testCase, variant }))
);
const results = await mapConcurrent(jobs, 2, evaluate);
const failed = results.filter((result) => result.failures.length > 0);

console.log(JSON.stringify({
  mode: config.ai.mode,
  model,
  fallbackAllowed: false,
  cases: selectedCases.length,
  variants: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}, null, 2));

if (failed.length > 0) process.exitCode = 1;

async function evaluate(job: {
  testCase: RoutingEvalCase;
  variant: RoutingEvalVariant;
}) {
  const envelope = buildRoutingEvalEnvelope(job.testCase, job.variant);
  try {
    const execution = policy.decide({
      tier: "ambitious",
      role: "synthesizer",
      workClass: "agent",
      profile,
      maxOutputTokens,
      deadlineMs: 60_000,
      promptMaterial: envelope.promptMaterial,
    });
    const response = await client.complete({
      model,
      temperature: 0,
      maxTokens: execution.maxOutputTokens,
      execution,
      messages: [{ role: "user", content: envelope.prompt }],
      usage: {
        ownerId: "evaluation-routing",
        channel: "system",
        subjectKind: "private",
        tier: "ambitious",
        purpose: "research",
        safetyCritical: false,
      },
    });
    const normalized = response.toLocaleLowerCase("id-ID");
    const failures: string[] = [];
    for (const group of job.testCase.requiredSignalGroups) {
      if (!group.some((signal) => normalized.includes(signal.toLocaleLowerCase("id-ID")))) {
        failures.push(`sinyal wajib tidak ditemukan: ${group.join("|")}`);
      }
    }
    for (const signal of job.testCase.forbiddenSignals ?? []) {
      if (normalized.includes(signal.toLocaleLowerCase("id-ID"))) {
        failures.push(`sinyal terlarang ditemukan: ${signal}`);
      }
    }
    return {
      caseId: job.testCase.id,
      variant: job.variant,
      promptMaterial: envelope.promptMaterial,
      exposure: envelope.exposure,
      failures,
      response,
    };
  } catch (error) {
    return {
      caseId: job.testCase.id,
      variant: job.variant,
      promptMaterial: envelope.promptMaterial,
      exposure: envelope.exposure,
      failureSource: "provider_or_execution",
      failures: [`permintaan evaluasi gagal (${safeEvaluationError(error)})`],
      response: null,
    };
  }
}

function safeEvaluationError(error: unknown): string {
  if (error instanceof AiResponseError) {
    return `AiResponseError:${error.reason}`;
  }
  if (error instanceof AiError && error.status !== undefined) {
    return `AiError:http_${error.status}`;
  }
  if (error instanceof Error && /^(?:Abort|Timeout|Type)Error$/u.test(error.name)) {
    return error.name;
  }
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/u.test(error.name)
    ? error.name
    : "unknown";
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  }));
  return results;
}
