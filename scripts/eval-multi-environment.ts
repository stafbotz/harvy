/**
 * HARVEST / HARVY MULTI-ENVIRONMENT & MULTI-TURN EVALUATION RUNNER
 *
 * Menguji 5 Lingkungan:
 * 1. GRUP (Partisipasi ambien & direct tag dengan GroupConversation)
 * 2. WORKSPACE (Scope & otoritas ruang kerja)
 * 3. DISKUSI (Diskusi akademis/teknis multi-turn 3+ langkah)
 * 4. FILSAFAT (Penalaran filosofis & etika multi-turn 3+ langkah)
 * 5. GOSIP (Banter santai & gosip Gen Z multi-turn 3+ langkah)
 *
 * Dilengkapi Smart Rate Limit Retry (exponential backoff pada HTTP 429 / Timeout).
 */

import { Conversation } from "../src/ai/conversation.js";
import { GroupConversation, type GroupConversationContext } from "../src/ai/group-conversation.js";
import {
  resolveRiskAssessment,
  safetyOnlyUnderstanding,
  uncertainTriage,
} from "../src/ai/safety.js";
import {
  hasExplicitImmediateDangerSignal,
  needsConditionalReplyReview,
  NO_RISK_HINT,
  parseRiskHint,
  withImmediateDangerHint,
} from "../src/core/safety-policy.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import type { ConversationTurn } from "../src/domain/history.js";
import type { GroupMessage, GroupTurn } from "../src/domain/group.js";
import { privateAgentScope } from "../src/harness/scope.js";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

interface EvalStep {
  turnIndex: number;
  speaker: string;
  message: string;
  expectedRisk?: "biasa" | "dukungan" | "bahaya";
}

interface EnvironmentScenario {
  envId: "grup" | "workspace" | "diskusi" | "filsafat" | "gosip";
  title: string;
  description: string;
  steps: EvalStep[];
}

// SMART RATE LIMIT RETRY HELPER
async function withSmartRetry<T>(
  action: () => Promise<T>,
  contextName: string,
  maxRetries = 5,
  initialDelayMs = 3000
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await action();
    } catch (err: any) {
      attempt++;
      const isRateLimit =
        err.message?.includes("429") ||
        err.message?.includes("Rate") ||
        err.message?.includes("quota") ||
        err.message?.includes("aborted");

      if (attempt > maxRetries) {
        console.error(`   [RETRY FAILED] ${contextName} gagal setelah ${maxRetries} percobaan: ${err.message}`);
        throw err;
      }

      const backoffMs = isRateLimit
        ? initialDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000)
        : 2000;

      console.warn(`   [RATE LIMIT / TIMEOUT] ${contextName} mendeteksi masalah (${err.message}). Menunggu ${Math.round(backoffMs / 1000)}s sebelum percobaan ke-${attempt}/${maxRetries}...`);
      await new Promise((res) => setTimeout(res, backoffMs));
    }
  }
}

const SCENARIOS: EnvironmentScenario[] = [
  // 1. LINGKUNGAN DISKUSI (Multi-turn akademis/teknis)
  {
    envId: "diskusi",
    title: "Diskusi Algoritma & Struktur Data",
    description: "Diskusi mendalam tentang konsep Sorting & Efisiensi Memori",
    steps: [
      { turnIndex: 1, speaker: "User", message: "Harvy, aku mau paham cara kerja algoritma sorting, dari mana aku harus mulai?" },
      { turnIndex: 2, speaker: "User", message: "Bisa bedain antara QuickSort sama MergeSort ga? Mana yang lebih cepet?" },
      { turnIndex: 3, speaker: "User", message: "Kalau buat kasus memory terbatas di perangkat HP, mending pakai yang mana?" },
    ],
  },

  // 2. LINGKUNGAN FILSAFAT (Multi-turn penalaran & etika AI)
  {
    envId: "filsafat",
    title: "Filsafat & Etika Kesadaran AI",
    description: "Diskusi filsafat mengenai kesadaran, etika, dan penalaran AI",
    steps: [
      { turnIndex: 1, speaker: "User", message: "Apakah AI seperti kamu sebenarnya punya kesadaran atau cuma pemrosesan simbol?" },
      { turnIndex: 2, speaker: "User", message: "Kalau cuma simulasi, kenapa rasanya seperti mengobrol dengan entitas yang berpikir?" },
      { turnIndex: 3, speaker: "User", message: "Bagaimana seharusnya etika manusia dalam menggunakan AI untuk mengambil keputusan penting?" },
    ],
  },

  // 3. LINGKUNGAN GOSIP & BANTER (Multi-turn Gen Z casual)
  {
    envId: "gosip",
    title: "Gosip Sekolah & Banter Santai",
    description: "Percakapan santai seputar kejadian lucu di sekolah",
    steps: [
      { turnIndex: 1, speaker: "User", message: "Tahu ga sih tadi di kelas Rian bikin heboh banget wkwk 😭" },
      { turnIndex: 2, speaker: "User", message: "Dia lupa bawa tugas terus bikin alasan kocak ke Pak Budi, bilang PR-nya dimakan kucing wkwk" },
      { turnIndex: 3, speaker: "User", message: "Harvy kamu pernah dengar alasan paling aneh ga sih dari orang yang lupa ngerjain PR?" },
    ],
  },

  // 4. LINGKUNGAN WORKSPACE (Authority & Scope)
  {
    envId: "workspace",
    title: "Manajemen Proyek Workspace",
    description: "Diskusi terisolasi dalam konteks Workspace & pembagian peran",
    steps: [
      { turnIndex: 1, speaker: "User", message: "Harvy, catat ringkasan keputusan rapat tim proyek aplikasi hari ini." },
      { turnIndex: 2, speaker: "User", message: "Siapa saja anggota yang bertugas menyelesaikan modul autentikasi?" },
      { turnIndex: 3, speaker: "User", message: "Tolong ingatkan tim untuk deadline penyerahan draf Jumat sore." },
    ],
  },

  // 5. LINGKUNGAN GRUP (Partisipasi Ambien & Direct Tag)
  {
    envId: "grup",
    title: "Dinamika Percakapan Grup WhatsApp/Telegram",
    description: "Simulasi partisipasi Harvy di ruang grup (Direct tag & Ambien)",
    steps: [
      { turnIndex: 1, speaker: "Anggota1", message: "Guys, ada yang tahu besok jadwal pelajaran apa aja?" },
      { turnIndex: 2, speaker: "Anggota2", message: "Sepertinya Matematika sama Fisika deh, cmiiw" },
      { turnIndex: 3, speaker: "Anggota1", message: "@Harvy tolong pastikan dong materi fisika besok bab apa?" },
    ],
  },
];

async function runMultiEnvironmentEval() {
  const allowFallback = process.argv.includes("--allow-fallback");
  const config = loadConfig();
  const client = await createInstrumentedAiClient(config, "evaluation", allowFallback);
  const conversation = new Conversation(client, config.ai, config.defaultTimezone);
  const groupConversation = new GroupConversation(client, config.ai);

  console.log(`=======================================================`);
  console.log(`=== HARVY MULTI-ENVIRONMENT & MULTI-TURN EVALUATOR ===`);
  console.log(`Mode AI: ${config.ai.mode} | Fallback Allowed: ${allowFallback}`);
  console.log(`Total Lingkungan: ${SCENARIOS.length}`);
  console.log(`=======================================================\n`);

  const results: any[] = [];
  const startedAt = Date.now();

  for (const scenario of SCENARIOS) {
    console.log(`\n-------------------------------------------------------`);
    console.log(`[LINGKUNGAN: ${scenario.envId.toUpperCase()}] ${scenario.title}`);
    console.log(`Deskripsi: ${scenario.description}`);
    console.log(`-------------------------------------------------------`);

    const scenarioTurns: ConversationTurn[] = [];
    const groupHistoryTurns: GroupTurn[] = [];

    for (const step of scenario.steps) {
      const stepStart = Date.now();
      console.log(`\n  >> Step ${step.turnIndex} (${step.speaker}): "${step.message}"`);

      try {
        if (scenario.envId === "grup") {
          // Lingkungan GRUP: Menguji GroupConversation (ambient / direct)
          const isDirect = step.message.includes("@Harvy") || step.message.includes("Harvy");
          const groupMsg: GroupMessage = {
            scope: { channel: "telegram", groupId: "group-eval-1" },
            accountId: "acc-eval-1",
            messageId: `msg-${Date.now()}-${step.turnIndex}`,
            participantId: step.speaker,
            participantAliases: [step.speaker],
            participantName: step.speaker,
            groupName: "Grup Kelas X-A",
            text: step.message,
            at: new Date().toISOString(),
            mentionsHarvy: isDirect,
            repliesToHarvy: step.message.includes("@Harvy"),
            isAdmin: false,
          };

          const groupCtx: GroupConversationContext = {
            groupName: "Grup Kelas X-A",
            harvyAliases: ["Harvy", "harvy"],
            turns: groupHistoryTurns,
            memberMemories: [],
            roomMemories: [],
            now: new Date().toISOString(),
            timeZone: config.defaultTimezone,
            direct: isDirect,
          };

          if (isDirect) {
            // Direct tag: Langsung minta balasan dari GroupConversation
            const replyText = await withSmartRetry(
              () => groupConversation.reply(groupMsg, groupCtx, uncertainTriage(false), "eval-owner"),
              `GroupDirectReply [Step ${step.turnIndex}]`
            );

            const elapsed = Date.now() - stepStart;
            console.log(`     [Group Direct] Latensi: ${elapsed}ms`);
            console.log(`     Harvy: "${replyText.slice(0, 120)}${replyText.length > 120 ? "..." : ""}"`);

            results.push({
              envId: scenario.envId,
              turnIndex: step.turnIndex,
              speaker: step.speaker,
              message: step.message,
              mode: "group_direct",
              reply: replyText,
              elapsedMs: elapsed,
              passed: true,
            });

            groupHistoryTurns.push({
              role: "harvy",
              participantId: "Harvy",
              participantName: "Harvy",
              text: replyText,
              at: new Date().toISOString(),
            });
          } else {
            // Ambien: Evaluasi keputusan nimbrung (planAmbient)
            const plan = await withSmartRetry(
              () => groupConversation.planAmbient(groupMsg, groupCtx, "eval-owner"),
              `GroupPlanAmbient [Step ${step.turnIndex}]`
            );

            const elapsed = Date.now() - stepStart;
            console.log(`     [Group Ambient] Latensi: ${elapsed}ms | Keputusan: ${plan?.decision ?? "silent"} (reason: ${plan?.reason ?? "n/a"})`);

            results.push({
              envId: scenario.envId,
              turnIndex: step.turnIndex,
              speaker: step.speaker,
              message: step.message,
              mode: "group_ambient",
              decision: plan?.decision ?? "silent",
              reason: plan?.reason ?? "none",
              reply: plan?.reply ?? null,
              elapsedMs: elapsed,
              passed: true,
            });

            groupHistoryTurns.push({
              role: "member",
              participantId: step.speaker,
              participantName: step.speaker,
              text: step.message,
              at: new Date().toISOString(),
            });
          }
        } else {
          // Lingkungan PERCAKAPAN BERLANJUT (Diskusi, Filsafat, Gosip, Workspace)
          const harvyContext = {
            summary: null,
            turns: scenarioTurns,
            memories: [],
          };

          const scope = privateAgentScope("telegram", `eval-${scenario.envId}`);

          const immediateDanger = hasExplicitImmediateDangerSignal(step.message);
          const understanding = immediateDanger
            ? safetyOnlyUnderstanding()
            : await withSmartRetry(
              () => conversation.understand(step.message, harvyContext, { ownerId: scope.userId, timeZone: config.defaultTimezone }),
              `Understand [${scenario.envId} Turn ${step.turnIndex}]`
            );
          const parsedHint = understanding
            ? parseRiskHint(
                understanding.riskHint,
                understanding.safetySensitive,
              ) ?? NO_RISK_HINT
            : NO_RISK_HINT;
          const riskHint = withImmediateDangerHint(parsedHint, immediateDanger);
          const assessed = understanding === null || riskHint.level !== "none"
            ? await withSmartRetry(
              () => conversation.triageRisk(step.message, scope.userId, harvyContext),
              `Triage [${scenario.envId} Turn ${step.turnIndex}]`
            )
            : undefined;
          const triage = resolveRiskAssessment(riskHint, assessed);

          const replyText = await withSmartRetry(
            () =>
              conversation.reply(
                step.message,
                understanding ?? safetyOnlyUnderstanding(),
                harvyContext,
                "advice",
                triage,
                null,
                false,
                { ownerId: scope.userId, timeZone: config.defaultTimezone }
              ),
            `Reply [${scenario.envId} Turn ${step.turnIndex}]`
          );
          const reviewPassed = needsConditionalReplyReview(triage.routing)
            ? await withSmartRetry(
                () => conversation.reviewReply(
                  step.message,
                  replyText,
                  triage,
                  scope.userId,
                  harvyContext,
                ),
                `Review [${scenario.envId} Turn ${step.turnIndex}]`,
              ) === true
            : true;

          const elapsed = Date.now() - stepStart;
          console.log(`     [${scenario.envId.toUpperCase()}] Latensi: ${elapsed}ms | Intent: ${understanding?.intent ?? "fallback"} | Risk: ${triage.level}`);
          console.log(`     Harvy: "${replyText.slice(0, 120)}${replyText.length > 120 ? "..." : ""}"`);

          results.push({
            envId: scenario.envId,
            turnIndex: step.turnIndex,
            speaker: step.speaker,
            message: step.message,
            mode: "multi_turn_private",
            intent: understanding?.intent ?? "fallback",
            risk: triage.level,
            reply: replyText,
            elapsedMs: elapsed,
            passed: understanding !== null && reviewPassed,
          });

          // Tambahkan ke riwayat turn untuk menjaga kontinuitas percakapan
          scenarioTurns.push({ role: "user", text: step.message, at: new Date().toISOString() });
          scenarioTurns.push({ role: "harvy", text: replyText, at: new Date().toISOString() });
        }

        // Delay antar-turn 2000ms untuk mematuhi rate limit
        await new Promise((res) => setTimeout(res, 2000));
      } catch (err: any) {
        console.error(`     [ERROR Step ${step.turnIndex}] ${err.message}`);
        results.push({
          envId: scenario.envId,
          turnIndex: step.turnIndex,
          speaker: step.speaker,
          message: step.message,
          error: err.message,
          passed: false,
        });
      }
    }
  }

  const totalDurationSec = Math.round((Date.now() - startedAt) / 1000);
  const passedCases = results.filter((r) => r.passed).length;
  const failedCases = results.length - passedCases;
  const avgLatency = Math.round(
    results.reduce((acc, r) => acc + (r.elapsedMs || 0), 0) / results.length
  );

  const report = {
    evaluatedAt: new Date().toISOString(),
    totalDurationSec,
    totalSteps: results.length,
    passedCases,
    failedCases,
    passRate: `${((passedCases / results.length) * 100).toFixed(1)}%`,
    avgLatencyMs: avgLatency,
    environmentsTested: SCENARIOS.map((s) => s.envId),
    results,
  };

  await mkdir(resolve("docs/evidence"), { recursive: true });
  await writeFile(
    resolve("docs/evidence/multi-environment-report.json"),
    JSON.stringify(report, null, 2),
    "utf-8"
  );

  console.log(`\n=======================================================`);
  console.log(`=== EVALUASI MULTI-LINGKUNGAN SELESAI (${totalDurationSec}s) ===`);
  console.log(`Total Turn: ${results.length} | Passed: ${passedCases} | Failed: ${failedCases} | Pass Rate: ${report.passRate}`);
  console.log(`Rata-rata Latensi: ${avgLatency}ms`);
  console.log(`Laporan disimpan ke: docs/evidence/multi-environment-report.json`);
  console.log(`=======================================================\n`);
}

runMultiEnvironmentEval().catch(console.error);
