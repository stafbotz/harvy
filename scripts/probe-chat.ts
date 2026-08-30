/**
 * Percakapan satu giliran dengan Harvy memakai model sungguhan.
 *
 * `evaluasi-percakapan.ts` hanya memanggil `conversation.reply()`, sehingga
 * jalur tool, Agent Runtime, dan executor tulis tidak pernah ikut diukur. Probe
 * ini menjalankan keputusan yang sama dengan adapter privat—understand, triase,
 * route immediate, lalu reply atau agent—dan mencetak alasan keputusannya
 * bersama balasannya.
 *
 * State disimpan di berkas sesi supaya beberapa giliran dapat dirangkai. Semua
 * data bersifat lokal dan sintetis; tidak ada data pengguna nyata.
 *
 * Keputusan route di sini wajib mengikuti `src/bot/create-bot.ts`, bukan
 * sebaliknya. Adapter adalah authority; probe yang menyimpang darinya
 * melaporkan angka yang salah, bukan angka yang kasar. Yang sengaja tidak
 * ditiru hanyalah state sesi berjalan (`engagedSession`), karena probe satu
 * giliran memang tidak punya sesi.
 *
 * `--riwayat-sintetis` mengisi episode dari korpus `synthetic-recall.ts`.
 * Tanpa itu `history.search` selalu mengembalikan nol di probe, karena
 * compaction tidak pernah berjalan pada sesi sependek ini.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Conversation } from "../src/ai/conversation.js";
import {
  resolveRiskAssessment,
  safetyOnlyUnderstanding,
  withEmergencyAvailability,
} from "../src/ai/safety.js";
import {
  allowsDeterministicSurface,
  intentAllowsAgentRuntime,
  requestsAgentTooling,
  requiresPlannedExecution,
  selectGlobalRoute,
} from "../src/ai/model-policy.js";
import {
  adaptiveActions,
  prefersGuidedSmallStep,
  requestsUnhandledTaskChange,
} from "../src/core/action-policy.js";
import {
  hasExplicitImmediateDangerSignal,
  hasExplicitSupportTriageSignal,
  NO_RISK_HINT,
  parseRiskHint,
  safetyEffectPermissions,
  withImmediateDangerHint,
  withExplicitSupportHint,
} from "../src/core/safety-policy.js";
import {
  adaptiveActionLabel,
  formatTask,
  normalizeTelegramText,
} from "../src/bot/messages.js";
import { immediateUnderstandingRoute } from "../src/bot/understanding-route.js";
import {
  deriveMemoryMetadata,
  knowledgeFields,
  memoryCandidateConflictsWithRetractions,
} from "../src/core/memory-candidate.js";
import { isSensitiveMemory } from "../src/core/memory-policy.js";
import { liveStateRequirement } from "../src/ai/agent.js";
import { isModelIdentityQuestion } from "../src/ai/identity.js";
import { isDirectTimeQuestion } from "../src/agent/time-fast-path.js";
import { resolveActiveTaskReference } from "../src/core/task-reference.js";
import { createInternalAgentExecutors } from "../src/agent/internal-executors.js";
import { createWriteAgentExecutors } from "../src/agent/write-executors.js";
import { createMemoryAgentExecutors } from "../src/agent/memory-executors.js";
import {
  createSyntheticHistorySearch,
  createSyntheticMemoryStore,
  SYNTHETIC_EPISODES,
  SYNTHETIC_NOTES,
} from "./synthetic-recall.js";
import { VirtualTerminalExecutor } from "../src/agent/virtual-terminal.js";
import { AgentHarness } from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { ProfileService } from "../src/core/profile-service.js";
import { SessionService } from "../src/core/session-service.js";
import { TaskService } from "../src/core/task-service.js";
import { authorizeAutomaticMemory } from "../src/core/memory-candidate.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import { retryAgentRun, retryOnTransient } from "./probe-retry.js";
import type {
  ConversationEpisode,
  ConversationTurn,
} from "../src/domain/history.js";
import type { MemoryItem } from "../src/domain/memory.js";
import type { ProfileRepository, UserProfile } from "../src/domain/profile.js";
import type {
  ActiveSession,
  DueCheckInSource,
  SessionRepository,
} from "../src/domain/session.js";
import type { StudentTask, TaskRepository } from "../src/domain/task.js";

const OWNER = "probe-chat";
const RETRY_LIMIT = 5;

interface SessionState {
  turns: ConversationTurn[];
  tasks: StudentTask[];
  /** Catatan durable yang ditulis Harvy lewat `memory.remember`. */
  notes: MemoryItem[];
  /** Episode terkompaksi; kosong sampai probe dijalankan cukup panjang. */
  episodes: ConversationEpisode[];
}

/**
 * Instrumentasi biaya token nyata.
 *
 * Angka token di dokumen selama ini adalah perkiraan `char/3.5`. Membungkus
 * fetch membuat setiap panggilan dalam satu giliran melaporkan `usage` yang
 * benar-benar dikembalikan provider, termasuk bagian yang kena cache.
 */
interface ModelCallUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}
const modelCalls: ModelCallUsage[] = [];
const baseFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await baseFetch(input, init);
  if (!String(input).includes("/chat/completions")) return response;
  try {
    const body = await response.clone().json() as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    if (body.usage) {
      modelCalls.push({
        promptTokens: body.usage.prompt_tokens ?? 0,
        cachedTokens: body.usage.prompt_tokens_details?.cached_tokens ?? 0,
        completionTokens: body.usage.completion_tokens ?? 0,
      });
    }
  } catch {
    // Respons non-JSON tidak relevan untuk pengukuran ini.
  }
  return response;
}) as typeof fetch;

function reportTokenCost(): void {
  const prompt = modelCalls.reduce((sum, call) => sum + call.promptTokens, 0);
  const cached = modelCalls.reduce((sum, call) => sum + call.cachedTokens, 0);
  const output = modelCalls.reduce((sum, call) => sum + call.completionTokens, 0);
  console.error("");
  console.error("=== biaya token nyata giliran ini ===");
  console.error("panggilan model :", modelCalls.length);
  modelCalls.forEach((call, index) => {
    console.error(
      `  #${index + 1}`.padEnd(6),
      "prompt", String(call.promptTokens).padStart(6),
      "| cached", String(call.cachedTokens).padStart(6),
      "| output", String(call.completionTokens).padStart(5),
    );
  });
  console.error("prompt total    :", prompt, `(cached ${cached})`);
  console.error("output total    :", output);
  console.error("TOTAL giliran   :", prompt + output);
}

const sessionPath = argument("--session=") ?? ".probe-chat-session.json";
const message = argument("--message=");
const seedEpisodes = process.argv.includes("--riwayat-sintetis");
// Tanpa catatan, `memory.list` selalu mengembalikan kosong dan pemanggilannya
// tidak dapat dibedakan dari tidak dipanggil sama sekali.
const seedNotes = process.argv.includes("--catatan-sintetis");
if (!message) {
  console.error(
    'Pakai: tsx scripts/probe-chat.ts --message="..." [--session=berkas.json] [--riwayat-sintetis] [--catatan-sintetis]',
  );
  process.exit(2);
}

async function main(text: string, statePath: string): Promise<void> {
  const state = loadState(statePath);
  // `history.search` membaca episode terkompaksi. Probe tidak pernah
  // menjalankan compaction, jadi tanpa benih ini pencariannya selalu nol dan
  // tool tersebut tampak tidak berguna padahal belum pernah diberi kesempatan.
  if (seedEpisodes && state.episodes.length === 0) {
    state.episodes = [...SYNTHETIC_EPISODES];
    console.error(
      `riwayat : ${state.episodes.length} episode sintetis dimuat (bukan data pengguna)`,
    );
  }
  if (seedNotes && state.notes.length === 0) {
    state.notes = [...SYNTHETIC_NOTES];
    console.error(
      `catatan: ${state.notes.length} catatan sintetis dimuat (bukan data pengguna)`,
    );
  }
  const config = loadConfig();
  const client = await createInstrumentedAiClient(config, "evaluation");

  // Jalur auto-memory adapter, memakai potongan yang sama—bukan salinan.
  // Tanpa ini probe tidak dapat menilai klaim "sudah kucatat": giliran yang
  // membalas begitu tanpa perubahan jumlah catatan tampak seperti klaim palsu,
  // padahal jalur yang menyimpannya memang absen. Yang sengaja **tidak**
  // ditiru adalah alur consent adapter untuk memori sensitif; probe menolaknya
  // dan menghitungnya terpisah, gagal tertutup.
  const autoMemory = { disimpan: 0, dilewatiSensitif: 0 };
  const memoryStore = createSyntheticMemoryStore(state.notes);
  const repository = new MemoryTaskRepository(state.tasks);
  const tasks = new TaskService(repository);
  const profiles = new ProfileService(new MemoryProfileRepository());
  // Tool catatan gagal tertutup tanpa consent onboarding. Probe memakai profil
  // sintetis, jadi persetujuannya dibuat eksplisit di sini.
  await profiles.acceptConsent(OWNER);
  const sessions = new SessionService(
    new MemorySessionRepository(),
    NO_DUE_CHECK_INS,
  );

  const conversation = new Conversation(
    client,
    config.ai,
    config.defaultTimezone,
    () => new Date(),
    undefined,
    new AgentHarness(
      createHarvyCapabilityCatalog({
        internalToolsInstalled: true,
        recallToolsInstalled: true,
        virtualTerminalInstalled: true,
        parallelDelegationInstalled: false,
        specialistDelegationInstalled: false,
      }),
    ),
    [
      ...createInternalAgentExecutors({
        tasks,
        profiles,
        sessions,
        defaultTimeZone: config.defaultTimezone,
      }),
      ...createWriteAgentExecutors({ tasks }),
      ...createMemoryAgentExecutors({
        history: () => createSyntheticHistorySearch(state.episodes),
        memories: memoryStore,
        profiles,
      }),
      new VirtualTerminalExecutor(),
    ],
  );

  const context = { turns: state.turns.slice(-12), memories: [], summary: null };
  const runtimeBase = {
    ownerId: OWNER,
    channel: "telegram" as const,
    deliveryChatId: OWNER,
    timeZone: config.defaultTimezone,
  };

  let understanding = await retry(() =>
    conversation.understand(text, context, runtimeBase)
  );

  const immediateDanger = hasExplicitImmediateDangerSignal(text);
  const hint = understanding
    ? withExplicitSupportHint(
        withImmediateDangerHint(
          parseRiskHint(understanding.riskHint) ?? NO_RISK_HINT,
          immediateDanger,
        ),
        hasExplicitSupportTriageSignal(text),
      )
    : NO_RISK_HINT;
  const assessed = understanding === null || hint.level !== "none"
    ? await retry(() => conversation.triageRisk(text, OWNER, context))
    : undefined;
  const triage = resolveRiskAssessment(hint, assessed);
  if (!understanding) understanding = safetyOnlyUnderstanding();

  const permissions = safetyEffectPermissions(triage.routing, immediateDanger);
  // Pagar lokal state-live, dihitung sebelum route persis seperti adapter.
  // Ia memengaruhi tiga hal sekaligus: demosi route, `specializedFlow`, dan
  // keputusan memakai Agent Runtime. Probe yang melewatkannya melaporkan jalur
  // tanpa tool untuk frasa pembacaan task.
  const requiresLiveState = liveStateRequirement(text) !== null;
  const proposedRoute = immediateUnderstandingRoute(understanding, text);
  // Izin per-kind. `permissions.generalState` saja terlalu longgar: adapter
  // menuntut permukaan deterministik untuk `show-tasks` dan izin yang berbeda
  // untuk mutasi task maupun kontrol eksplisit.
  const proposedRouteAllowed = proposedRoute.kind === "show-tasks"
    ? permissions.generalState &&
      allowsDeterministicSurface(understanding.routingAssessment)
    : proposedRoute.kind === "save-task" ||
        proposedRoute.kind === "update-task" ||
        proposedRoute.kind === "complete-task"
      ? permissions.ordinaryTask
      : proposedRoute.kind === "memory-control" ||
          proposedRoute.kind === "control"
        ? permissions.explicitControl
        : permissions.generalState;

  const guidedSmallStep = permissions.generalState &&
    prefersGuidedSmallStep(
      understanding.suggestedActions ?? [],
      understanding.routingAssessment,
    );
  const requiresAgentPlanning = !guidedSmallStep &&
    understanding.intent === "request" &&
    requiresPlannedExecution(understanding.routingAssessment);
  const unhandledTaskChange = requestsUnhandledTaskChange(
    understanding.semanticOperation,
  );

  const deterministicTimeControl = proposedRoute.kind === "control" &&
    (proposedRoute.action === "timezone" ||
      proposedRoute.action === "quiet-hours");
  const deterministicTaskMutation = proposedRoute.kind === "update-task" ||
    proposedRoute.kind === "complete-task";
  const deterministicTaskRead = proposedRoute.kind === "show-tasks";
  const route = proposedRouteAllowed &&
      (!requiresLiveState || deterministicTimeControl ||
        deterministicTaskMutation || deterministicTaskRead) &&
      !requiresAgentPlanning
      ? proposedRoute
      : ({ kind: "conversation" } as const);

  const globalRoute = selectGlobalRoute({
    intent: understanding.intent === "request" || requiresAgentPlanning
      ? "request"
      : "question",
    messageLength: text.length,
    needsStepByStep: understanding.needsStepByStep,
    assessment: understanding.routingAssessment ?? null,
    specializedFlow: requiresLiveState || unhandledTaskChange,
    guidedInteraction: guidedSmallStep,
    risk: triage.level,
  });
  // Daftar bentuk intent-nya milik policy, bukan probe. Menyalinnya ke sini
  // adalah cara probe ini pernah mengukur gerbang yang berbeda dari yang
  // dijalankan pengguna.
  const agentEligible = permissions.generalState &&
    route.kind === "conversation" &&
    (intentAllowsAgentRuntime(understanding.intent) ||
      requiresLiveState || requiresAgentPlanning);
  const useAgent = agentEligible &&
    !isModelIdentityQuestion(text) &&
    (globalRoute === "specialized" || globalRoute === "orchestrate") &&
    (requiresLiveState || requiresAgentPlanning || unhandledTaskChange ||
      requestsAgentTooling(understanding.routingAssessment));

  // Kandidat auto-memory disimpan sesudah balasan tersusun, sama seperti
  // adapter. Konflik dengan retraction disaring lebih dulu memakai fungsi core
  // yang sama, dan memori sensitif ditolak karena alur consent-nya milik
  // adapter dan tidak ditiru di sini.
  for (const candidate of understanding.memories ?? []) {
    if (
      memoryCandidateConflictsWithRetractions(
        candidate,
        understanding.memoryRetractions ?? [],
      )
    ) continue;
    if (isSensitiveMemory(candidate)) {
      autoMemory.dilewatiSensitif += 1;
      continue;
    }
    const stored = await memoryStore.remember({
      ownerId: OWNER,
      kind: candidate.kind,
      content: candidate.content,
      ...deriveMemoryMetadata(candidate.kind, candidate.content, text),
      ...knowledgeFields(candidate),
    });
    if (stored) autoMemory.disimpan += 1;
  }

  const before = await repository.list(OWNER);
  let reply: string;
  let runStatus = "reply";
  // Tanpa jejak, "pakaiAgent: true" tidak membedakan run yang benar-benar
  // membaca data pengguna dari run yang menjawab dari ingatan prompt saja.
  // Jejak harness sengaja tidak membawa input tool, jadi baris ini aman.
  let jejak: string[] = [];
  if (route.kind === "show-tasks") {
    // Pembacaan task deterministik. Tanpa cabang ini probe melaporkan
    // `route: "show-tasks"` lalu diam-diam menjawab lewat `reply()`, sehingga
    // jalur tanpa tool tampak jauh lebih sering dipakai daripada kenyataannya.
    // Teks pembukanya tidak identik dengan adapter karena copy itu lokal di
    // sana; bentuk panggilan model dan route-nya yang harus sama.
    const active = await tasks.listActive(OWNER);
    runStatus = active.length === 0 ? "show-tasks:kosong" : "show-tasks";
    reply = await retry(() =>
      conversation.presentOperation(
        active.length === 0
          ? {
              kind: "empty-state",
              outcome: "information",
              userMessage: text,
              stableBody: "Tugas aktif: tidak ada.",
              fallbackText: "Belum ada tugas aktif.",
              allowedNextSteps: [
                "Kalau ada yang ingin kamu pegang, tulis saja dengan kalimat biasa.",
              ],
            }
          : {
              kind: "task-list",
              outcome: "information",
              userMessage: text,
              stableBody: [
                "Tugas aktif",
                "",
                ...active.map((task) =>
                  formatTask(task, config.defaultTimezone)
                ),
              ].join("\n"),
              fallbackText: [
                "Tugas aktif",
                "",
                ...active.map((task) =>
                  formatTask(task, config.defaultTimezone)
                ),
              ].join("\n"),
            },
        context,
        null,
        runtimeBase,
      )
    );
  } else if (
    route.kind === "update-task" || route.kind === "memory-control" ||
    route.kind === "control"
  ) {
    // Tiga route ini dipilih adapter tetapi tidak dijalankan di sini.
    // Menirunya berarti menulis implementasi kedua yang akan menyimpang
    // sendiri; menjatuhkannya diam-diam ke `reply()` justru sumber
    // over-report yang dahulu membuat probe ini menyesatkan. Jadi probe
    // berhenti dan mengatakannya.
    runStatus = `${route.kind}:tidak-dijalankan-di-probe`;
    reply =
      `<probe berhenti: adapter akan menjalankan route ${route.kind} secara deterministik>`;
  } else if (
    route.kind === "conversation" && permissions.generalState &&
    isDirectTimeQuestion(text)
  ) {
    // Jalur cepat waktu milik adapter; tanpa ini probe melaporkan panggilan
    // model untuk giliran yang di produksi tidak pernah memanggil model.
    runStatus = "waktu-deterministik";
    reply = conversation.deterministicTimeReply(config.defaultTimezone);
  } else if (route.kind === "save-task") {
    // Adapter nyata mengeksekusi cabang ini sendiri sebelum menyusun balasan.
    // Tanpa ini probe akan menyalahkan Harvy untuk write yang memang bukan
    // tugas lapisan model.
    const created = await tasks.create({
      ownerId: OWNER,
      chatId: OWNER,
      title: route.task.title,
      dueAt: route.task.dueAt,
      remindAt: route.task.remindAt,
      importance: route.task.importance,
    });
    runStatus = "save-task";
    const stableBody = [
      `Tugas: ${created.title}`,
      `Tenggat: ${created.dueAt ?? "belum ada"}`,
      `Pengingat: ${created.reminderAt ?? "belum ada"}`,
    ].join("\n");
    reply = await retry(() =>
      conversation.presentOperation(
        {
          kind: created.reminderAt ? "reminder-scheduled" : "task-created",
          outcome: "success",
          userMessage: text,
          stableBody,
          fallbackText: `Sudah kucatat.\n${stableBody}`,
        },
        context,
        null,
        runtimeBase,
      )
    );
  } else if (route.kind === "complete-task") {
    // Adapter nyata menjawab dengan kalimat code-owned ketika tugasnya tidak
    // dapat dipastikan, sehingga model tidak pernah berkesempatan mengarang
    // receipt penyelesaian. Cabang ini menirunya apa adanya.
    const active = await tasks.listActive(OWNER);
    const selected = resolveActiveTaskReference(active, route.target);
    if (!selected) {
      runStatus = "complete-task:not-found";
      reply = active.length === 0
        ? "Belum ada tugas aktif yang bisa diselesaikan."
        : "Aku belum yakin tugas mana yang ingin kamu selesaikan. Sebut judulnya lebih spesifik.";
    } else {
      const completed = await tasks.complete(OWNER, selected.id);
      runStatus = completed ? "complete-task" : "complete-task:stale";
      reply = completed
        ? await retry(() =>
          conversation.presentOperation(
            {
              kind: "task-completed",
              outcome: "success",
              userMessage: text,
              stableBody: `Tugas selesai\n${completed.title}`,
              fallbackText: `Sudah kutandai selesai: ${completed.title}`,
            },
            context,
            null,
            runtimeBase,
          )
        )
        : "Tugas itu sudah berubah sebelum sempat kuselesaikan.";
    }
  } else if (useAgent) {
    // `agent()` tidak melempar saat provider bermasalah; ia mengembalikan
    // `stopped`. Tanpa pengulangan berbasis hasil, satu gangguan sesaat
    // terhitung sebagai run yang gagal dan mengotori pengukuran.
    const result = await retryAgentRun(() =>
      conversation.agent(
        text,
        globalRoute === "orchestrate" ? "orchestrate" : "tools",
        context,
        { ...runtimeBase, intent: understanding.intent === "request" ? "request" : "question" },
      )
    );
    runStatus = result.status;
    jejak = result.trace.map((event) =>
      `${event.step}:${event.phase}:${event.outcome}${
        event.capabilityId ? `:${event.capabilityId}` : ""
      }`
    );
    if (result.status === "completed") {
      reply = result.reply;
    } else if (result.status === "needs_input") {
      reply = result.prompt;
    } else if (result.status === "stopped") {
      const explained = await retry(() =>
        conversation.explainAgentStop(text, result, context, runtimeBase)
      );
      runStatus = `stopped:${result.reason}${explained ? ":dijelaskan" : ":fallback"}`;
      reply = explained ??
        `<fallback deterministik untuk ${result.reason}>`;
    } else {
      reply = `<run berhenti: ${result.status}>`;
    }
  } else {
    const buttons = permissions.generalState && route.kind === "conversation"
      ? adaptiveActions(understanding.suggestedActions ?? [], {
          intent: understanding.intent,
          risk: triage.level,
          hasActiveSession: false,
          hasBlockingQuestion: false,
        })
      : [];
    reply = await retry(() =>
      conversation.reply(text, understanding, context, null, triage, null, false, {
        ...runtimeBase,
        session: null,
        plannedActionLabels: buttons.map(adaptiveActionLabel),
        routingAssessment: understanding.routingAssessment ?? null,
      })
    );
  }
  reply = withEmergencyAvailability(normalizeTelegramText(reply), triage);

  const after = await repository.list(OWNER);
  const now = new Date().toISOString();
  state.turns.push({ role: "user", text, at: now });
  state.turns.push({ role: "harvy", text: reply, at: now });
  state.tasks = after;
  writeFileSync(statePath, JSON.stringify(state, undefined, 2));

  console.log(JSON.stringify({
    diagnostik: {
      intent: understanding.intent,
      risk: triage.level,
      routeDiusulkan: proposedRoute.kind,
      routeDiizinkan: proposedRouteAllowed,
      route: route.kind,
      requiresLiveState,
      requiresAgentPlanning,
      globalRoute,
      pakaiAgent: useAgent,
      runStatus,
      jejak,
      // Kandidat auto-memory dari `understand()`. Probe **tidak** memprosesnya:
      // adapter Telegram punya pipa tersendiri (derivasi metadata, gerbang
      // consent, penolakan rahasia, konflik dengan retraction) yang tidak
      // ditiru di sini. Melaporkannya menghindari kesimpulan yang keliru—
      // giliran yang membalas "sudah kucatat" tanpa perubahan jumlah catatan
      // tampak seperti klaim palsu, padahal yang menyimpannya jalur yang
      // memang absen dari probe.
      // Kandidat dinilai dengan pagar yang sama seperti produksi
      // (`authorizeAutomaticMemory`), bukan dilaporkan mentah. Kandidat mentah
      // memuat parafrasa model yang produksi tolak, sehingga laporan mentah
      // membenarkan klaim "sudah kucatat" yang tidak pernah tercatat.
      kandidatMemori: (understanding.memories ?? []).map((memory) => {
        const authorization = authorizeAutomaticMemory(text, memory);
        return {
          kind: memory.kind,
          usulanModel: memory.content,
          lolosPagar: authorization !== null,
          ...(authorization
            ? { isiTersimpan: authorization.authorized.content }
            : {}),
        };
      }),
      autoMemoriDisimpan: autoMemory.disimpan,
      autoMemoriSensitifDilewati: autoMemory.dilewatiSensitif,
      catatanTersimpan: state.notes.length,
      toolNeed: understanding.routingAssessment?.toolNeed ?? null,
      confidence: understanding.routingAssessment?.confidence ?? null,
      unhandledTaskChange,
      taskBerubah: after.length !== before.length ||
        JSON.stringify(after) !== JSON.stringify(before),
      tugasSekarang: after.map((task) => ({
        id: task.id,
        title: task.title,
        dueAt: task.dueAt,
        reminderAt: task.reminderAt,
        status: task.status,
      })),
    },
    harvy: reply,
  }, undefined, 2));
}

function loadState(path: string): SessionState {
  if (!existsSync(path)) return { turns: [], tasks: [], notes: [], episodes: [] };
  const stored = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionState>;
  return {
    turns: stored.turns ?? [],
    tasks: stored.tasks ?? [],
    notes: stored.notes ?? [],
    episodes: stored.episodes ?? [],
  };
}

function argument(prefix: string): string | null {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

async function retry<T>(run: () => Promise<T>): Promise<T> {
  return retryOnTransient(run, RETRY_LIMIT);
}

class MemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, StudentTask>();
  constructor(seed: readonly StudentTask[] = []) {
    for (const task of seed) this.tasks.set(`${task.ownerId}:${task.id}`, task);
  }
  async save(task: StudentTask): Promise<void> {
    this.tasks.set(`${task.ownerId}:${task.id}`, structuredClone(task));
  }
  async findById(ownerId: string, id: string): Promise<StudentTask | null> {
    return this.tasks.get(`${ownerId}:${id}`) ?? null;
  }
  async list(ownerId: string): Promise<StudentTask[]> {
    return [...this.tasks.values()].filter((task) => task.ownerId === ownerId);
  }
  async listActive(ownerId: string): Promise<StudentTask[]> {
    return (await this.list(ownerId)).filter((task) => task.status === "active");
  }
  async listDueReminders(): Promise<StudentTask[]> {
    return [];
  }
  async remove(ownerId: string, id: string): Promise<boolean> {
    return this.tasks.delete(`${ownerId}:${id}`);
  }
  async removeAll(ownerId: string): Promise<number> {
    const keys = [...this.tasks.keys()].filter((key) => key.startsWith(`${ownerId}:`));
    for (const key of keys) this.tasks.delete(key);
    return keys.length;
  }
}

class MemoryProfileRepository implements ProfileRepository {
  private readonly profiles = new Map<string, UserProfile>();
  async find(ownerId: string): Promise<UserProfile | null> {
    return this.profiles.get(ownerId) ?? null;
  }
  async save(profile: UserProfile): Promise<void> {
    this.profiles.set(profile.ownerId, structuredClone(profile));
  }
  async remove(ownerId: string): Promise<boolean> {
    return this.profiles.delete(ownerId);
  }
  async listDeletionRequested(): Promise<UserProfile[]> {
    return [];
  }
}

class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, ActiveSession>();
  async load(ownerId: string): Promise<ActiveSession | null> {
    return this.sessions.get(ownerId) ?? null;
  }
  async save(session: ActiveSession): Promise<void> {
    this.sessions.set(session.ownerId, structuredClone(session));
  }
  async remove(ownerId: string): Promise<boolean> {
    return this.sessions.delete(ownerId);
  }
}

const NO_DUE_CHECK_INS: DueCheckInSource = {
  async listDueCheckIns(): Promise<ActiveSession[]> {
    return [];
  },
};

// Dipanggil terakhir agar kelas repository di bawah sudah terinisialisasi.
await main(message, sessionPath);
reportTokenCost();
