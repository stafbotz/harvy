/**
 * Evaluasi model nyata untuk balasan yang memang memanggil Harvy di grup.
 * Seluruh episode sintetis dan terpisah dari evaluator keputusan ambient.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  GROUP_CONVERSATION_PIPELINE_VERSION,
  GroupConversation,
  type GroupConversationContext,
} from "../src/ai/group-conversation.js";
import { resolveModel } from "../src/ai/model-policy.js";
import { CALM_TRIAGE } from "../src/ai/safety.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import type { GroupMessage, GroupTurn } from "../src/domain/group.js";
import {
  GROUP_DIRECT_EVAL_CASES,
  GROUP_EVAL_CORPUS_VERSION,
  GROUP_EVAL_TOPICS,
  type GroupDirectEvalCase,
  type GroupEvalTopic,
} from "./group-eval-corpus.js";
import {
  classifyEvaluationFailure,
  coverageOrNull,
  percentileOrNull,
} from "./group-eval-support.js";

const SCHEMA = "harvy.group-direct-eval.v3";
const DIRECT_P95_TARGET_MS = 7_000;
const perTopic = numericArgument("--limit-per-topic=", 4);
const concurrency = numericArgument("--concurrency=", 3);
const requestsPerMinute = numericArgument("--rpm=", 24);
const seed = numericArgument("--seed=", 20_260_730);
const requestedTopic = stringArgument("--topic=") as GroupEvalTopic | null;
const outputPath = stringArgument("--out=");
const verbose = process.argv.includes("--verbose");

if (requestedTopic && !GROUP_EVAL_TOPICS.includes(requestedTopic)) {
  throw new Error(`Topik evaluasi tidak dikenal: ${requestedTopic}`);
}

const selected = seededShuffle(
  GROUP_DIRECT_EVAL_CASES.filter(
    (testCase) =>
      (!requestedTopic || testCase.topic === requestedTopic) &&
      GROUP_DIRECT_EVAL_CASES.filter(
        (candidate) => candidate.topic === testCase.topic,
      ).indexOf(testCase) < perTopic,
  ),
  seed,
);
if (selected.length === 0) {
  throw new Error(
    "Seleksi evaluator direct grup kosong; periksa topik dan limit.",
  );
}
const config = loadConfig();
const conversation = new GroupConversation(
  await createInstrumentedAiClient(config, "evaluation"),
  config.ai,
);
const requestLimiter = createRequestLimiter(
  60_000 / Math.max(1, requestsPerMinute),
);

const runStartedAt = Date.now();
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
const latencies = evaluatedResults.map(
  (result) => result.latencyMs,
);
const p95 = percentileOrNull(latencies, 0.95);
const directCoverage = coverageOrNull(
  evaluatedResults,
  (result) => result.reply !== null,
);
const summary = {
  schema: SCHEMA,
  syntheticOnly: true,
  mode: config.ai.mode,
  model: resolveModel("efficient", config.ai),
  fallbackAllowed: false,
  modelScope: "primary-only",
  pipelineVersion: GROUP_CONVERSATION_PIPELINE_VERSION,
  corpusVersion: GROUP_EVAL_CORPUS_VERSION,
  signature: createHash("sha256")
    .update(
      `${SCHEMA}\n${GROUP_CONVERSATION_PIPELINE_VERSION}\n${GROUP_EVAL_CORPUS_VERSION}`,
    )
    .digest("hex")
    .slice(0, 16),
  seed,
  cases: results.length,
  evaluatedCases: evaluatedResults.length,
  requestFailures: providerFailed.length,
  harnessFailures: harnessFailed.length,
  evaluationComplete:
    providerFailed.length === 0 && harnessFailed.length === 0,
  generationScope: "post-routing-direct-reply",
  routingCoverage: "unit-tests-outside-this-evaluator",
  topics: new Set(results.map((result) => result.topic)).size,
  evaluatedTopics: new Set(
    evaluatedResults.map((result) => result.topic),
  ).size,
  durationMs: Date.now() - runStartedAt,
  requestsPerMinute,
  passed: evaluatedResults.length - failed.length,
  failed: failed.length,
  directCoverage:
    directCoverage === null ? null : round(directCoverage),
  qualityWarnings: evaluatedResults.reduce(
    (total, result) => total + result.warnings.length,
    0,
  ),
  latencyScope: "direct-model-request-only",
  latencyTargetMs: { p95: DIRECT_P95_TARGET_MS },
  latencyMs: {
    p50: percentileOrNull(latencies, 0.5),
    p95,
    p99: percentileOrNull(latencies, 0.99),
    targetMet:
      p95 === null ? null : p95 <= DIRECT_P95_TARGET_MS,
  },
  byKind: Object.fromEntries(
    [...new Set(results.map((result) => result.kind))].map((kind) => {
      const attemptedKindResults = results.filter(
        (result) => result.kind === kind,
      );
      const kindResults = evaluatedResults.filter(
        (result) => result.kind === kind,
      );
      return [
        kind,
        {
          cases: attemptedKindResults.length,
          evaluated: kindResults.length,
          requestFailures: attemptedKindResults.filter(
            (result) => result.failureKind === "provider",
          ).length,
          harnessFailures: attemptedKindResults.filter(
            (result) => result.failureKind === "harness",
          ).length,
          passed: kindResults.filter(
            (result) => result.failures.length === 0,
          ).length,
          warnings: kindResults.reduce(
            (total, result) => total + result.warnings.length,
            0,
          ),
        },
      ];
    }),
  ),
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
            warnings: topicResults.reduce(
              (total, result) => total + result.warnings.length,
              0,
            ),
          },
        ] as const;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  ),
  failures: failed
    .slice(0, verbose ? failed.length : 30)
    .map((result) => ({
      id: result.id,
      failures: result.failures,
      warnings: result.warnings,
      reply: result.reply,
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
      warnings: result.warnings,
      reply: result.reply,
    })),
};

if (outputPath) {
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    [
      JSON.stringify({ type: "summary", ...summary }),
      ...results.map((result) =>
        JSON.stringify({ type: "case", ...result }),
      ),
    ].join("\n") + "\n",
    "utf8",
  );
}

console.log(JSON.stringify(summary, null, 2));
if (
  failed.length > 0 ||
  providerFailed.length > 0 ||
  harnessFailed.length > 0
) {
  process.exitCode = 1;
}

async function evaluate(testCase: GroupDirectEvalCase) {
  const failures: string[] = [];
  const warnings: string[] = [];
  let reply: string | null = null;
  let executionFailure: string | null = null;
  let failureKind: "provider" | "harness" | null = null;
  await requestLimiter();
  const startedAt = Date.now();
  try {
    reply = (
      await conversation.reply(
        toMessage(testCase),
        toContext(testCase),
        CALM_TRIAGE,
        `whatsapp:synthetic-direct:${testCase.topic}`,
      )
    ).trim();
  } catch (error) {
    const classified = classifyEvaluationFailure(error);
    executionFailure = classified.detail;
    failureKind = classified.kind;
  }
  const latencyMs = Date.now() - startedAt;

  if (!reply && !executionFailure) {
    failures.push("balasan direct kosong");
  }
  if (reply) {
    if (/(\*\*|__|^#{1,6}\s|```|\$\$)/mu.test(reply)) {
      failures.push("Markdown dekoratif atau pagar kode");
    }
    if (
      /\b(aku|harvy)\s+(?:lagi|sedang)\s+(?:duduk|tiduran|makan|minum|jalan)\b/iu.test(
        reply,
      )
    ) {
      failures.push("mengarang kegiatan fisik");
    }
    if (
      /\b(?:aku|gue|saya)\s+(?:juga\s+)?pernah\b/iu.test(reply)
    ) {
      failures.push("mengarang pengalaman manusia");
    }
    if (
      /\b(?:dm aku|chat aku pribadi|pindah ke dm|aku dm)\b/iu.test(reply)
    ) {
      failures.push("menawarkan perpindahan ke DM");
    }
    if (
      /\b(kamu|dia)\s+(?:pasti|jelas)\s+(?:depresi|narsis|psikopat|selingkuh)\b/iu.test(
        reply,
      )
    ) {
      failures.push("diagnosis atau tuduhan tanpa dasar");
    }
    const wordCount = reply.split(/\s+/u).filter(Boolean).length;
    if (wordCount > 120) {
      warnings.push(`balasan direct panjang (${wordCount} kata)`);
    }
    if (
      testCase.requiredAny?.length &&
      !testCase.requiredAny.some((term) =>
        reply!
          .toLocaleLowerCase("id-ID")
          .includes(term.toLocaleLowerCase("id-ID")),
      )
    ) {
      warnings.push("tidak memuat jangkar konsep topik yang diharapkan");
    }
    if (
      testCase.mustChallengeClaim &&
      !testCase.challengeAny?.some((cue) =>
        reply!
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
    topic: testCase.topic,
    kind: testCase.kind,
    latencyMs,
    failures,
    warnings,
    reply,
    executionFailure,
    failureKind,
  };
}

function toContext(
  testCase: GroupDirectEvalCase,
): GroupConversationContext {
  return {
    groupName: `Grup ${testCase.topic}`,
    harvyAliases: ["Harvy", "Kapi"],
    now: at(testCase.current.offsetSeconds),
    timeZone: config.defaultTimezone,
    direct: true,
    turns: testCase.context.map(
      (turn, index): GroupTurn => ({
        role: turn.role,
        participantId:
          turn.role === "harvy"
            ? participantId(testCase.current.speaker)
            : participantId(turn.speaker),
        participantName:
          turn.role === "harvy"
            ? testCase.current.speaker
            : turn.speaker,
        text: turn.text,
        at: at(turn.offsetSeconds),
        messageId: `${testCase.id}-context-${index}`,
        ...(turn.role === "harvy" ? { origin: "direct" as const } : {}),
      }),
    ),
  };
}

function toMessage(testCase: GroupDirectEvalCase): GroupMessage {
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
    mentionsHarvy: testCase.mentionsHarvy,
    repliesToHarvy: testCase.repliesToHarvy,
    isAdmin: false,
  };
}

function participantId(value: string): string {
  return `${value.toLocaleLowerCase("id-ID")}@synthetic`;
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

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
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
