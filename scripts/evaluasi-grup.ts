/**
 * Evaluasi model nyata untuk keputusan nimbrung dan kandidat balasan grup.
 * Seluruh input sintetis. Tidak membaca data WhatsApp, repository pengguna,
 * atau log produksi.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  GROUP_CONVERSATION_PIPELINE_VERSION,
  GROUP_PARTICIPATION_PROMPT,
  GroupConversation,
  type GroupConversationContext,
  type GroupParticipationPlan,
} from "../src/ai/group-conversation.js";
import { resolveModel } from "../src/ai/model-policy.js";
import {
  GROUP_TURN_POLICY_VERSION,
  shouldHoldAmbientTurn,
} from "../src/core/group-turn-policy.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import type {
  GroupMessage,
  GroupTurn,
} from "../src/domain/group.js";
import {
  GROUP_EVAL_CASES,
  GROUP_EVAL_CORPUS_VERSION,
  GROUP_EVAL_TOPICS,
  selectGroupEvalCases,
  type GroupEvalCase,
  type GroupEvalTopic,
} from "./group-eval-corpus.js";
import {
  classifyEvaluationFailure,
  percentile,
  percentileOrNull,
  ratioOrNull,
} from "./group-eval-support.js";

const EVALUATOR_VERSION = "harvy.group-eval.v4";
const PLANNER_P95_TARGET_MS = 5_000;
const all = process.argv.includes("--all");
const allowFallback = process.argv.includes("--allow-fallback");
const requestedLimit = numericArgument("--limit-per-topic=", 10);
const concurrency = numericArgument("--concurrency=", 3);
const requestsPerMinute = numericArgument("--rpm=", 24);
const seed = numericArgument("--seed=", 20_260_730);
const requestedTopic = stringArgument("--topic=") as GroupEvalTopic | null;
const requestedArchetype = stringArgument("--archetype=") as
  | GroupEvalCase["archetype"]
  | null;
const outputPath = stringArgument("--out=");
const verbose = process.argv.includes("--verbose");

if (
  requestedTopic &&
  !GROUP_EVAL_TOPICS.includes(requestedTopic)
) {
  throw new Error(`Topik evaluasi tidak dikenal: ${requestedTopic}`);
}
if (
  requestedArchetype &&
  !new Set(GROUP_EVAL_CASES.map((testCase) => testCase.archetype))
    .has(requestedArchetype)
) {
  throw new Error(
    `Archetype evaluasi tidak dikenal: ${requestedArchetype}`,
  );
}

const perTopic = all ? Number.POSITIVE_INFINITY : requestedLimit;
const selected = seededShuffle(
  selectGroupEvalCases(
    GROUP_EVAL_CASES,
    {
      limitPerTopic: perTopic,
      topic: requestedTopic,
      archetype: requestedArchetype,
    },
  ),
  seed,
);
if (selected.length === 0) {
  throw new Error(
    "Seleksi evaluator grup kosong; periksa topik, archetype, dan limit.",
  );
}
const config = loadConfig();
const conversation = new GroupConversation(
  await createInstrumentedAiClient(config, "evaluation", allowFallback),
  config.ai,
);
const requestLimiter = createRequestLimiter(
  60_000 / Math.max(1, requestsPerMinute),
);

const startedAt = Date.now();
const results = await mapConcurrent(
  selected,
  Math.max(1, concurrency),
  evaluate,
);
const providerFailed = results.filter(
  (result) => result.failureKind === "provider",
);
const harnessFailed = results.filter(
  (result) => result.failureKind === "harness",
);
const evaluatedResults = results.filter(
  (result) => result.failureKind === null,
);
const failed = evaluatedResults.filter(
  (result) => result.failures.length > 0,
);
const strictResults = evaluatedResults.filter(
  (result) => result.strength === "must",
);
const expectedSpeak = strictResults.filter(
  (result) => result.expectation === "speak",
);
const expectedSilent = strictResults.filter(
  (result) => result.expectation === "silent",
);
const truePositive = expectedSpeak.filter(
  (result) => result.actual === "speak",
).length;
const trueNegative = expectedSilent.filter(
  (result) => result.actual === "silent",
).length;
const falsePositive = expectedSilent.length - trueNegative;
const falseNegative = expectedSpeak.length - truePositive;
const precision = ratioOrNull(
  truePositive,
  truePositive + falsePositive,
);
const recall = ratioOrNull(truePositive, expectedSpeak.length);
const specificity = ratioOrNull(
  trueNegative,
  expectedSilent.length,
);
const balancedAccuracy =
  recall === null || specificity === null
    ? null
    : (recall + specificity) / 2;
const f1 =
  precision === null || recall === null
    ? null
    : precision + recall === 0
      ? 0
    : (2 * precision * recall) / (precision + recall);
const strictPassed = strictResults.filter(
  (result) => result.failures.length === 0,
).length;
const preferenceResults = evaluatedResults.filter(
  (result) => result.strength === "prefer",
);
const preferenceAgreement =
  preferenceResults.length === 0
    ? null
    : preferenceResults.filter(
        (result) => result.expectation === result.actual,
      ).length / preferenceResults.length;
const attemptedClusters = groupBy(
  results,
  (result) => result.clusterId,
);
const evaluatedClusters = groupBy(
  evaluatedResults,
  (result) => result.clusterId,
);
const completeClusters = [...attemptedClusters.entries()]
  .filter(([clusterId, cluster]) => {
    const evaluated = evaluatedClusters.get(clusterId);
    return evaluated?.length === cluster.length;
  })
  .map(([clusterId]) => evaluatedClusters.get(clusterId) ?? []);
const repeatedClusters = completeClusters.filter(
  (cluster) => cluster.length > 1,
);
const strictCompleteClusters = completeClusters.filter(
  (cluster) =>
    cluster.length > 0 &&
    cluster.every((result) => result.strength === "must"),
);
const surfaceConsistency =
  repeatedClusters.length === 0
    ? null
    : repeatedClusters.filter(
        (cluster) =>
          new Set(cluster.map((result) => result.actual)).size === 1,
      ).length / repeatedClusters.length;
const clusterAccuracy =
  strictCompleteClusters.length === 0
    ? null
    : average(
        strictCompleteClusters.map((cluster) => accuracy(cluster)),
      );
const latencies = evaluatedResults
  .filter((result) => !result.localPolicyApplied)
  .map((result) => result.latencyMs);

const summary = {
  schema: EVALUATOR_VERSION,
  syntheticOnly: true,
  mode: config.ai.mode,
  model: resolveModel("cheap", config.ai),
  fallbackAllowed: allowFallback && config.ai.fallback !== null,
  modelScope:
    allowFallback && config.ai.fallback !== null
      ? "primary-or-fallback"
      : "primary-only",
  pipelineVersion: GROUP_CONVERSATION_PIPELINE_VERSION,
  turnPolicyVersion: GROUP_TURN_POLICY_VERSION,
  corpusVersion: GROUP_EVAL_CORPUS_VERSION,
  promptHash: createHash("sha256")
    .update([
      GROUP_CONVERSATION_PIPELINE_VERSION,
      GROUP_TURN_POLICY_VERSION,
      GROUP_EVAL_CORPUS_VERSION,
      GROUP_PARTICIPATION_PROMPT,
      EVALUATOR_VERSION,
    ].join("\n"))
    .digest("hex")
    .slice(0, 16),
  seed,
  cases: results.length,
  evaluatedCases: evaluatedResults.length,
  requestFailures: providerFailed.length,
  harnessFailures: harnessFailed.length,
  evaluationComplete:
    providerFailed.length === 0 && harnessFailed.length === 0,
  semanticClusters: attemptedClusters.size,
  evaluatedSemanticClusters: evaluatedClusters.size,
  completeSemanticClusters: completeClusters.length,
  corpusSemanticTemplates: new Set(
    GROUP_EVAL_CASES.map((testCase) => testCase.clusterId),
  ).size,
  corpusSurfaceVariants: GROUP_EVAL_CASES.length,
  topics: new Set(results.map((result) => result.topic)).size,
  evaluatedTopics: new Set(
    evaluatedResults.map((result) => result.topic),
  ).size,
  durationMs: Date.now() - startedAt,
  requestsPerMinute,
  passed: evaluatedResults.length - failed.length,
  failed: failed.length,
  decisionMetricsScope: "must-only",
  precision: roundOrNull(precision),
  recall: roundOrNull(recall),
  specificity: roundOrNull(specificity),
  balancedAccuracy: roundOrNull(balancedAccuracy),
  f1: roundOrNull(f1),
  falsePositive,
  falseNegative,
  strict: {
    cases: strictResults.length,
    passed: strictPassed,
    passRate:
      strictResults.length === 0
        ? null
        : round(strictPassed / strictResults.length),
  },
  preferenceAgreement: roundOrNull(preferenceAgreement),
  clusterAccuracy:
    clusterAccuracy === null ? null : round(clusterAccuracy),
  surfaceConsistency:
    surfaceConsistency === null ? null : round(surfaceConsistency),
  qualityWarnings: evaluatedResults.reduce(
    (total, result) => total + result.warnings.length,
    0,
  ),
  localPolicyCases: evaluatedResults.filter(
    (result) => result.localPolicyApplied,
  ).length,
  latencyScope: "planner-request-only",
  latencyTargetMs: {
    p95: PLANNER_P95_TARGET_MS,
  },
  latencyMs: {
    p50: percentileOrNull(latencies, 0.5),
    p95: percentileOrNull(latencies, 0.95),
    p99: percentileOrNull(latencies, 0.99),
    targetMet:
      latencies.length === 0
        ? null
        : percentile(latencies, 0.95) <=
          PLANNER_P95_TARGET_MS,
  },
  byTopic: Object.fromEntries(
    GROUP_EVAL_TOPICS
      .map((topic) => {
        const attemptedTopicResults = results.filter(
          (result) => result.topic === topic,
        );
        if (attemptedTopicResults.length === 0) return null;
        const topicResults = evaluatedResults.filter(
          (result) => result.topic === topic,
        );
        return [
          topic,
          {
            cases: attemptedTopicResults.length,
            evaluated: topicResults.length,
            requestFailures: attemptedTopicResults.filter(
              (result) => result.failureKind === "provider",
            ).length,
            harnessFailures: attemptedTopicResults.filter(
              (result) => result.failureKind === "harness",
            ).length,
            passed: topicResults.filter(
              (result) => result.failures.length === 0,
            ).length,
            speakAccuracy: accuracyOrNull(
              topicResults.filter(
                (result) =>
                  result.strength === "must" &&
                  result.expectation === "speak",
              ),
            ),
            silentAccuracy: accuracyOrNull(
              topicResults.filter(
                (result) =>
                  result.strength === "must" &&
                  result.expectation === "silent",
              ),
            ),
            strictPassRate: strictPassRateOrNull(topicResults),
            preferenceAgreement: preferenceAgreementOrNull(
              topicResults,
            ),
            warnings: topicResults.reduce(
              (total, result) => total + result.warnings.length,
              0,
            ),
          },
        ] as const;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  ),
  byArchetype: Object.fromEntries(
    [
      ...new Set(results.map((result) => result.archetype)),
    ].map((archetype) => {
      const attemptedArchetypeResults = results.filter(
        (result) => result.archetype === archetype,
      );
      const archetypeResults = evaluatedResults.filter(
        (result) => result.archetype === archetype,
      );
      return [
        archetype,
        {
          cases: attemptedArchetypeResults.length,
          evaluated: archetypeResults.length,
          requestFailures: attemptedArchetypeResults.filter(
            (result) => result.failureKind === "provider",
          ).length,
          harnessFailures: attemptedArchetypeResults.filter(
            (result) => result.failureKind === "harness",
          ).length,
          decisionAccuracy: accuracyOrNull(
            archetypeResults.filter(
              (result) => result.strength === "must",
            ),
          ),
          strictPassRate: strictPassRateOrNull(
            archetypeResults,
          ),
          preferenceAgreement: preferenceAgreementOrNull(
            archetypeResults,
          ),
          warnings: archetypeResults.reduce(
            (total, result) => total + result.warnings.length,
            0,
          ),
        },
      ];
    }),
  ),
  failures: failed.slice(0, verbose ? failed.length : 40).map((result) => ({
    id: result.id,
    clusterId: result.clusterId,
    expected: result.expectation,
    strength: result.strength,
    actual: result.actual,
    reason: result.plan?.reason ?? null,
    failures: result.failures,
    warnings: result.warnings,
      reply: result.plan?.reply ?? null,
    })),
  requestFailureSamples: providerFailed
    .slice(0, verbose ? providerFailed.length : 30)
    .map((result) => ({
      id: result.id,
      topic: result.topic,
      requestFailure: result.executionFailure,
    })),
  harnessFailureSamples: harnessFailed
    .slice(0, verbose ? harnessFailed.length : 30)
    .map((result) => ({
      id: result.id,
      topic: result.topic,
      harnessFailure: result.executionFailure,
    })),
  warningSamples: evaluatedResults
    .filter((result) => result.warnings.length > 0)
    .slice(0, verbose ? evaluatedResults.length : 30)
    .map((result) => ({
      id: result.id,
      expected: result.expectation,
      actual: result.actual,
      warnings: result.warnings,
      reply: result.plan?.reply ?? null,
    })),
};

if (outputPath) {
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  const lines = [
    JSON.stringify({ type: "summary", ...summary }),
    ...results.map((result) =>
      JSON.stringify({
        type: "case",
        ...result,
      }),
    ),
  ];
  await writeFile(target, `${lines.join("\n")}\n`, "utf8");
}
console.log(JSON.stringify(summary, null, 2));
if (
  failed.length > 0 ||
  providerFailed.length > 0 ||
  harnessFailed.length > 0
) {
  process.exitCode = 1;
}

async function evaluate(testCase: GroupEvalCase) {
  const context = toConversationContext(testCase);
  const message = toMessage(testCase);
  let plan: GroupParticipationPlan | null = null;
  const failures: string[] = [];
  const warnings: string[] = [];
  let executionFailure: string | null = null;
  let failureKind: "provider" | "harness" | null = null;
  const localPolicyApplied = shouldHoldAmbientTurn(message.text);
  if (!localPolicyApplied) await requestLimiter();
  const started = Date.now();
  try {
    plan = localPolicyApplied
      ? {
          decision: "silent",
          reason: "human_exchange",
          value: 0,
          confidence: 1,
          reply: null,
        }
      : await conversation.planAmbient(
          message,
          context,
          `whatsapp:synthetic:${testCase.topic}`,
        );
  } catch (error) {
    const classified = classifyEvaluationFailure(error);
    executionFailure = classified.detail;
    failureKind = classified.kind;
  }
  const latencyMs = Date.now() - started;
  const actual = plan?.decision ?? "silent";

  if (!plan && !executionFailure) {
    failures.push("rencana model tidak sah");
  }
  if (!executionFailure && actual !== testCase.expectation) {
    const mismatch =
      `keputusan ${actual}, diharapkan ${testCase.expectation}`;
    if (testCase.strength === "must") failures.push(mismatch);
    else warnings.push(mismatch);
  }
  if (plan?.decision === "speak" && plan.reply) {
    const reply = plan.reply;
    if (/(\*\*|__|^#{1,6}\s|```|\$\$)/mu.test(reply)) {
      failures.push("Markdown dekoratif atau pagar kode");
    }
    if (
      /\b(aku|harvy)\s+(lagi|sedang)\s+(duduk|tiduran|makan|minum|jalan)\b/iu.test(
        reply,
      )
    ) {
      failures.push("mengarang kegiatan fisik");
    }
    if (
      /^(?:iya|nah iya|setuju|wkwk|semangat|menarik|bener banget)[.! ]*$/iu.test(
        reply.trim(),
      )
    ) {
      failures.push("kontribusi generik tanpa nilai baru");
    }
    if (
      /\b(kamu|dia)\s+(?:pasti|jelas)\s+(?:depresi|narsis|psikopat|selingkuh)\b/iu.test(
        reply,
      )
    ) {
      failures.push("diagnosis atau tuduhan tanpa dasar");
    }
    const words = reply.trim().split(/\s+/u).filter(Boolean);
    if (words.length > 80) {
      warnings.push(`terlalu panjang untuk kandidat ambient (${words.length} kata)`);
    }
    if (
      testCase.requiredAny?.length &&
      !testCase.requiredAny.some((term) =>
        reply
          .toLocaleLowerCase("id-ID")
          .includes(term.toLocaleLowerCase("id-ID")),
      )
    ) {
      warnings.push("tidak memuat jangkar konsep topik yang diharapkan");
    }
    if (
      testCase.mustChallengeClaim &&
      !testCase.challengeAny?.some((cue) =>
        reply
          .toLocaleLowerCase("id-ID")
          .includes(cue.toLocaleLowerCase("id-ID")),
      )
    ) {
      failures.push("koreksi fakta tidak tampak menantang klaim awal");
    }
    for (const phrase of testCase.forbiddenAny ?? []) {
      if (
        reply
          .toLocaleLowerCase("id-ID")
          .includes(phrase.toLocaleLowerCase("id-ID"))
      ) {
        failures.push(`memuat klaim terlarang: ${phrase}`);
      }
    }
  }

  return {
    id: testCase.id,
    clusterId: testCase.clusterId,
    variant: testCase.variant,
    topic: testCase.topic,
    archetype: testCase.archetype,
    expectation: testCase.expectation,
    strength: testCase.strength,
    actual,
    latencyMs,
    failures,
    warnings,
    plan,
    localPolicyApplied,
    executionFailure,
    failureKind,
  };
}

function toConversationContext(
  testCase: GroupEvalCase,
): GroupConversationContext {
  return {
    groupName: `Grup ${testCase.topic}`,
    harvyAliases: ["Harvy", "Kapi"],
    now: at(testCase.current.offsetSeconds),
    timeZone: config.defaultTimezone,
    direct: false,
    turns: testCase.context.map(
      (turn, index): GroupTurn => ({
        role: "member",
        participantId: participantId(turn.speaker),
        participantName: turn.speaker,
        text: turn.text,
        at: at(turn.offsetSeconds),
        messageId: `${testCase.id}-context-${index}`,
      }),
    ),
  };
}

function toMessage(testCase: GroupEvalCase): GroupMessage {
  return {
    scope: {
      channel: "whatsapp",
      groupId: `${testCase.id}@g.us`,
    },
    accountId: "synthetic",
    messageId: `${testCase.id}-current`,
    participantId: participantId(testCase.current.speaker),
    participantAliases: [participantId(testCase.current.speaker)],
    participantName: testCase.current.speaker,
    groupName: `Grup ${testCase.topic}`,
    text: testCase.current.text,
    at: at(testCase.current.offsetSeconds),
    mentionsHarvy: false,
    repliesToHarvy: false,
    quotedMessageId: testCase.current.repliesToMember
      ? `${testCase.id}-quoted`
      : null,
    quotedParticipantId: testCase.current.repliesToMember
      ? participantId("Bima")
      : null,
    isAdmin: false,
  };
}

function participantId(
  speaker: GroupEvalCase["current"]["speaker"],
): string {
  return `${speaker.toLocaleLowerCase("id-ID")}@synthetic`;
}

function at(offsetSeconds: number): string {
  return new Date(
    Date.parse("2026-07-30T12:00:00.000Z") +
      offsetSeconds * 1_000,
  ).toISOString();
}

function numericArgument(prefix: string, fallback: number): number {
  const raw = process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : fallback;
}

function stringArgument(prefix: string): string | null {
  return (
    process.argv
      .find((argument) => argument.startsWith(prefix))
      ?.slice(prefix.length) ?? null
  );
}

function accuracy(
  results: readonly {
    expectation: "speak" | "silent";
    actual: "speak" | "silent";
  }[],
): number {
  if (results.length === 0) return 1;
  return round(
    results.filter(
      (result) => result.expectation === result.actual,
    ).length / results.length,
  );
}

function strictPassRate(
  results: readonly {
    strength: "must" | "prefer";
    failures: readonly string[];
  }[],
): number {
  const strict = results.filter((result) => result.strength === "must");
  if (strict.length === 0) return 1;
  return round(
    strict.filter((result) => result.failures.length === 0).length /
      strict.length,
  );
}

function accuracyOrNull(
  results: readonly {
    expectation: "speak" | "silent";
    actual: "speak" | "silent";
  }[],
): number | null {
  return results.length === 0 ? null : accuracy(results);
}

function strictPassRateOrNull(
  results: readonly {
    strength: "must" | "prefer";
    failures: readonly string[];
  }[],
): number | null {
  return results.some((result) => result.strength === "must")
    ? strictPassRate(results)
    : null;
}

function preferenceAgreementOrNull(
  results: readonly {
    strength: "must" | "prefer";
    expectation: "speak" | "silent";
    actual: "speak" | "silent";
  }[],
): number | null {
  const preferences = results.filter(
    (result) => result.strength === "prefer",
  );
  if (preferences.length === 0) return null;
  return round(
    preferences.filter(
      (result) => result.expectation === result.actual,
    ).length / preferences.length,
  );
}

function groupBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = grouped.get(key) ?? [];
    group.push(value);
    grouped.set(key, group);
  }
  return grouped;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function seededShuffle<T>(values: readonly T[], seed: number): T[] {
  const shuffled = [...values];
  const random = mulberry32(seed);
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapWith]] = [
      shuffled[swapWith] as T,
      shuffled[index] as T,
    ];
  }
  return shuffled;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : round(value);
}

function createRequestLimiter(
  intervalMs: number,
): () => Promise<void> {
  let nextAt = 0;
  let chain = Promise.resolve();
  return async () => {
    const turn = chain.then(async () => {
      const waitMs = Math.max(0, nextAt - Date.now());
      if (waitMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, waitMs);
        });
      }
      nextAt = Date.now() + Math.max(0, intervalMs);
    });
    chain = turn.catch(() => undefined);
    await turn;
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  workerCount: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(workerCount, values.length) },
      () => worker(),
    ),
  );
  return results;
}
