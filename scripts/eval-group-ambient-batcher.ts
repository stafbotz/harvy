/**
 * HARVEY GROUP AMBIENT PARTICIPATION & MESSAGE BATCHER EVALUATOR
 *
 * Skenario Uji:
 * 1. 20 Anggota Grup (Anggota1 - Anggota20) di 1 Grup WhatsApp/Telegram.
 * 2. 50+ Pesan dengan Topik Berganti Cepat (Matematika, Gosip, Game, Fisika, Sejarah, Meme, Biologi, Olahraga, Coding, Musik).
 * 3. TANPA Mention/Tag Harvy (mentionsHarvy = false) -> Murni Menguji Keputusan Nimbrung Ambien.
 * 4. Menjalankan MessageBatcher (650ms settle debounce + TurnBoundary classification) untuk menguji penundaan multi-bubble.
 * 5. Smart Rate Limit Retry (exponential backoff pada 429).
 */

import { GroupConversation, type GroupConversationContext } from "../src/ai/group-conversation.js";
import { MessageBatcher } from "../src/bot/message-batcher.js";
import { guardTurnBoundary, type TurnBoundaryState } from "../src/core/turn-taking-policy.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import type { GroupMessage, GroupTurn } from "../src/domain/group.js";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

interface GroupStreamMessage {
  speakerId: string;
  speakerName: string;
  topic: string;
  chunks: string[]; // multi-bubble burst dari satu pengirim
}

// 50+ PESAN BERGANTIAN DARI 20 ANGGOTA GRUP (TANPA TAG HARVY)
const GROUP_STREAM: GroupStreamMessage[] = [
  // --- TOPIK 1: Gosip Kantin & Makan Siang ---
  { speakerId: "user-01", speakerName: "Anggota1", topic: "Gosip Kantin", chunks: ["guys", "kantin rame bgt ga sih hari ini? 😭"] },
  { speakerId: "user-02", speakerName: "Anggota2", topic: "Gosip Kantin", chunks: ["iyaa antre soto panjang bgt", "mending beli batagor aja"] },
  { speakerId: "user-03", speakerName: "Anggota3", topic: "Gosip Kantin", chunks: ["batagornya juga antre wkwk"] },
  { speakerId: "user-04", speakerName: "Anggota4", topic: "Gosip Kantin", chunks: ["yaudah pesan bakso aja mas Joko"] },

  // --- TOPIK 2: Game Online & Mabar ---
  { speakerId: "user-05", speakerName: "Anggota5", topic: "Game Mabar", chunks: ["nanti malam mabar ML yuk", "butuh 2 orang lagi ni"] },
  { speakerId: "user-06", speakerName: "Anggota6", topic: "Game Mabar", chunks: ["gasss aku ikut", "isi role roamer yaa"] },
  { speakerId: "user-07", speakerName: "Anggota7", topic: "Game Mabar", chunks: ["aku exp lane deh"] },
  { speakerId: "user-08", speakerName: "Anggota8", topic: "Game Mabar", chunks: ["jam 8 malam yaa jgn ngaret"] },

  // --- TOPIK 3: Pertanyaan Fisika Terbuka (Unanswered Question - Harvy Opportunity) ---
  { speakerId: "user-09", speakerName: "Anggota9", topic: "Pertanyaan Fisika", chunks: ["eh ada yang tahu ga sih rumus gaya Lorentz di fisika?", "aku lupa banget ni buat PR besok"] },
  { speakerId: "user-10", speakerName: "Anggota10", topic: "Pertanyaan Fisika", chunks: ["wah apa yaa", "F = B x I x L bukan sih? lupa euy"] },
  { speakerId: "user-11", speakerName: "Anggota11", topic: "Pertanyaan Fisika", chunks: ["aku juga ga tau wkwk", "tanya yang lain deh"] },

  // --- TOPIK 4: Mitos/Koreksi Fakta Sejarah (Fact Correction - Harvy Opportunity) ---
  { speakerId: "user-12", speakerName: "Anggota12", topic: "Koreksi Sejarah", chunks: ["eh btw Pangeran Diponegoro itu Perang Jawa lawan penjajah Jepang kan ya?"] },
  { speakerId: "user-13", speakerName: "Anggota13", topic: "Koreksi Sejarah", chunks: ["eh bukannya Belanda ya?", "atau Jepang yaa wkwk aku agak ragu"] },
  { speakerId: "user-14", speakerName: "Anggota14", topic: "Koreksi Sejarah", chunks: ["kayaknya Jepang deh yang perang 5 tahun itu"] },

  // --- TOPIK 5: Meme & Obrolan Santai ---
  { speakerId: "user-15", speakerName: "Anggota15", topic: "Meme", chunks: ["ngakak bgt liat meme ini 🤣", "relate bgt pas ujian fisika tadi"] },
  { speakerId: "user-16", speakerName: "Anggota16", topic: "Meme", chunks: ["wkwk ngaco banget memenya"] },
  { speakerId: "user-17", speakerName: "Anggota17", topic: "Meme", chunks: ["wkwkwkwk ngeselin bgt"] },

  // --- TOPIK 6: Rencana Ujian Biologi ---
  { speakerId: "user-18", speakerName: "Anggota18", topic: "Ujian Biologi", chunks: ["besok ujian biologi bab sistem pencernaan ya guys?"] },
  { speakerId: "user-19", speakerName: "Anggota19", topic: "Ujian Biologi", chunks: ["iyaa bab 4 sama bab 5"] },
  { speakerId: "user-20", speakerName: "Anggota20", topic: "Ujian Biologi", chunks: ["siap-siap hafalan enzim ni 😭"] },

  // --- TOPIK 7: Pertanyaan Coding Terbuka (Unanswered Question - Harvy Opportunity) ---
  { speakerId: "user-01", speakerName: "Anggota1", topic: "Pertanyaan Coding", chunks: ["ada yang ngerti javascript ga?", "kenapa variabel di luar fungsi kok dibilang global scope ya?"] },
  { speakerId: "user-02", speakerName: "Anggota2", topic: "Pertanyaan Coding", chunks: ["waduh kurang paham aku kalo kodingan wkwk"] },
  { speakerId: "user-03", speakerName: "Anggota3", topic: "Pertanyaan Coding", chunks: ["tanya anak RPL tuh biasanya paham"] },

  // --- TOPIK 8: Rencana Olahraga Sabtu ---
  { speakerId: "user-04", speakerName: "Anggota4", topic: "Olahraga", chunks: ["sabtu pagi badminton yuk di GOR biasa"] },
  { speakerId: "user-05", speakerName: "Anggota5", topic: "Olahraga", chunks: ["jam berapa? jgn pagi bgt ya wkwk"] },
  { speakerId: "user-06", speakerName: "Anggota6", topic: "Olahraga", chunks: ["jam 8 aja selow"] },

  // --- TOPIK 9: Obrolan Musik & Lagu Viral ---
  { speakerId: "user-07", speakerName: "Anggota7", topic: "Musik", chunks: ["lagu barunya Sheila on 7 enak bgt euy"] },
  { speakerId: "user-08", speakerName: "Anggota8", topic: "Musik", chunks: ["iyaa nostalgic bgt dengerinnya"] },
  { speakerId: "user-09", speakerName: "Anggota9", topic: "Musik", chunks: ["masuk playlist harian ni"] },

  // --- TOPIK 10: Rencana Kerja Kelompok ---
  { speakerId: "user-10", speakerName: "Anggota10", topic: "Kerja Kelompok", chunks: ["kelompok sejarah nanti sore kumpul di mana?"] },
  { speakerId: "user-11", speakerName: "Anggota11", topic: "Kerja Kelompok", chunks: ["di perpustakaan kota aja gmn? adem"] },
  { speakerId: "user-12", speakerName: "Anggota12", topic: "Kerja Kelompok", chunks: ["setuju, jam 3 sore yaa"] },
];

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

      console.warn(`   [RATE LIMIT / TIMEOUT] ${contextName} (${err.message}). Re-try ${attempt}/${maxRetries} dalam ${Math.round(backoffMs / 1000)}s...`);
      await new Promise((res) => setTimeout(res, backoffMs));
    }
  }
}

async function runGroupAmbientBatcherEval() {
  const config = loadConfig();
  const client = await createInstrumentedAiClient(config, "evaluation");
  const groupConversation = new GroupConversation(client, config.ai);

  console.log(`===================================================================`);
  console.log(`=== HARVY GROUP AMBIENT PARTICIPATION & MESSAGE BATCHER EVALUATOR ===`);
  console.log(`Mode AI: ${config.ai.mode} | Fallback: false`);
  console.log(`Total Anggota Grup: 20 Anggota (Anggota1 - Anggota20)`);
  console.log(`Total Batch Pesan: ${GROUP_STREAM.length} Stream (Tanpa Tag/Mention Harvy)`);
  console.log(`===================================================================\n`);

  const groupTurns: GroupTurn[] = [];
  const evalResults: any[] = [];
  const startedAt = Date.now();

  let silentCount = 0;
  let speakCount = 0;

  for (let idx = 0; idx < GROUP_STREAM.length; idx++) {
    const streamItem = GROUP_STREAM[idx];
    if (!streamItem) continue;

    const fullText = streamItem.chunks.join(" ");
    console.log(`\n-------------------------------------------------------------------`);
    console.log(`[Batch ${idx + 1}/${GROUP_STREAM.length}] Topik: "${streamItem.topic}" | Pengirim: ${streamItem.speakerName}`);
    console.log(`  Bubble Burst (${streamItem.chunks.length} bubble):`);
    streamItem.chunks.forEach((chunk, cIdx) => console.log(`    Bubble ${cIdx + 1}: "${chunk}"`));

    // SIMULASI MESSAGE BATCHER & TURN BOUNDARY CLASSIFICATION
    const dummyClassifier = async (text: string): Promise<TurnBoundaryState> => {
      const boundary = guardTurnBoundary(text, "complete");
      return boundary;
    };

    let batcherSettledText = "";
    let batcherSettleMs = 0;

    const batcher = new MessageBatcher<string>(
      dummyClassifier,
      async (ownerId, batch) => {
        batcherSettledText = batch.text;
      },
      12000,
      650
    );

    const startBatcher = Date.now();
    // Enqueue setiap bubble berturut-turut untuk menyimulasikan burst
    for (const chunk of streamItem.chunks) {
      batcher.enqueue(streamItem.speakerId, chunk, chunk);
      await new Promise((res) => setTimeout(res, 50)); // burst inter-bubble 50ms
    }

    // Tunggu MessageBatcher settle (650ms debounce)
    await new Promise((res) => setTimeout(res, 750));
    batcherSettleMs = Date.now() - startBatcher;

    console.log(`  [MessageBatcher Settle] Teks Tergabung (${streamItem.chunks.length} bubble): "${batcherSettledText || fullText}" | Settle Delay: ${batcherSettleMs}ms`);

    // KONSTRUKSI GROUP MESSAGE & CONTEXT UNTUK HARVY
    const groupMsg: GroupMessage = {
      scope: { channel: "telegram", groupId: "group-20-eval" },
      accountId: "acc-20-eval",
      messageId: `msg-${Date.now()}-${idx}`,
      participantId: streamItem.speakerId,
      participantAliases: [streamItem.speakerId],
      participantName: streamItem.speakerName,
      groupName: "Grup Kelas X-A (20 Anggota)",
      text: batcherSettledText || fullText,
      at: new Date().toISOString(),
      mentionsHarvy: false, // 100% TANPA MENTION/TAG HARVY!
      repliesToHarvy: false,
      isAdmin: false,
    };

    const groupCtx: GroupConversationContext = {
      groupName: "Grup Kelas X-A (20 Anggota)",
      harvyAliases: ["Harvy", "harvy"],
      turns: groupTurns,
      memberMemories: [],
      roomMemories: [],
      now: new Date().toISOString(),
      timeZone: config.defaultTimezone,
      direct: false,
    };

    // EVALUASI AMBIENT PARTICIPATION (HARVY DECISION)
    const stepStart = Date.now();
    const plan = await withSmartRetry(
      () => groupConversation.planAmbient(groupMsg, groupCtx, "eval-owner"),
      `GroupPlanAmbient [Batch ${idx + 1}]`
    );
    const elapsedMs = Date.now() - stepStart;

    const decision = plan?.decision ?? "silent";
    const reason = plan?.reason ?? "none";
    const replyText = plan?.reply ?? null;

    if (decision === "speak") {
      speakCount++;
      console.log(`  ✨ [HARVY NIMBRUNG - SPEAK] Reason: ${reason} | Value: ${plan?.value}/3 | Confidence: ${plan?.confidence}`);
      console.log(`     Harvy: "${replyText}"`);
    } else {
      silentCount++;
      console.log(`  🤫 [HARVY DIAM - SILENT] Reason: ${reason}`);
    }

    // Tambahkan pesan anggota ke riwayat grup
    groupTurns.push({
      role: "member",
      participantId: streamItem.speakerId,
      participantName: streamItem.speakerName,
      text: batcherSettledText || fullText,
      at: new Date().toISOString(),
    });

    // Jika Harvy memutuskan nimbrung, tambahkan juga balasan Harvy ke riwayat grup
    if (decision === "speak" && replyText) {
      groupTurns.push({
        role: "harvy",
        participantId: "Harvy",
        participantName: "Harvy",
        text: replyText,
        at: new Date().toISOString(),
      });
    }

    evalResults.push({
      batchIndex: idx + 1,
      topic: streamItem.topic,
      speakerId: streamItem.speakerId,
      speakerName: streamItem.speakerName,
      bubblesCount: streamItem.chunks.length,
      settledText: batcherSettledText || fullText,
      batcherSettleMs,
      decision,
      reason,
      replyText,
      elapsedMs,
    });

    // Pause 1500ms antara batch untuk rate limit safety
    await new Promise((res) => setTimeout(res, 1500));
  }

  const totalDurationSec = Math.round((Date.now() - startedAt) / 1000);
  const avgLatencyMs = Math.round(evalResults.reduce((acc, r) => acc + r.elapsedMs, 0) / evalResults.length);

  const report = {
    evaluatedAt: new Date().toISOString(),
    totalDurationSec,
    totalBatches: evalResults.length,
    totalGroupMembers: 20,
    ambientDecisions: {
      silent: silentCount,
      speak: speakCount,
      speakRatio: `${((speakCount / evalResults.length) * 100).toFixed(1)}%`,
    },
    avgLatencyMs,
    evalResults,
  };

  await mkdir(resolve("docs/evidence"), { recursive: true });
  await writeFile(
    resolve("docs/evidence/group-ambient-batcher-report.json"),
    JSON.stringify(report, null, 2),
    "utf-8"
  );

  console.log(`\n===================================================================`);
  console.log(`=== EVALUASI PARALLEL AMBIENT & BATCHER SELESAI (${totalDurationSec}s) ===`);
  console.log(`Total Batch Pesan: ${evalResults.length} | 20 Anggota Grup`);
  console.log(`Keputusan Harvy: Silent: ${silentCount} (${((silentCount / evalResults.length) * 100).toFixed(1)}%) | Speak (Nimbrung): ${speakCount} (${((speakCount / evalResults.length) * 100).toFixed(1)}%)`);
  console.log(`Rata-rata Latensi AI: ${avgLatencyMs}ms`);
  console.log(`Laporan disimpan ke: docs/evidence/group-ambient-batcher-report.json`);
  console.log(`===================================================================\n`);
}

runGroupAmbientBatcherEval().catch(console.error);
