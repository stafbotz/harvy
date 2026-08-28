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
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Conversation } from "../src/ai/conversation.js";
import { AiError, AiResponseError } from "../src/ai/client.js";
import {
  resolveRiskAssessment,
  safetyOnlyUnderstanding,
  withEmergencyAvailability,
} from "../src/ai/safety.js";
import {
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
  normalizeTelegramText,
} from "../src/bot/messages.js";
import { immediateUnderstandingRoute } from "../src/bot/understanding-route.js";
import { resolveActiveTaskReference } from "../src/core/task-reference.js";
import { createInternalAgentExecutors } from "../src/agent/internal-executors.js";
import { createWriteAgentExecutors } from "../src/agent/write-executors.js";
import {
  createMemoryAgentExecutors,
  type AgentMemoryStore,
} from "../src/agent/memory-executors.js";
import { searchConversationEpisodes } from "../src/core/history-search.js";
import { VirtualTerminalExecutor } from "../src/agent/virtual-terminal.js";
import { AgentHarness } from "../src/harness/agent-harness.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import { ProfileService } from "../src/core/profile-service.js";
import { SessionService } from "../src/core/session-service.js";
import { TaskService } from "../src/core/task-service.js";
import { loadConfig } from "../src/config.js";
import { createInstrumentedAiClient } from "./instrumented-ai-client.js";
import type {
  ConversationEpisode,
  ConversationTurn,
} from "../src/domain/history.js";
import type { MemoryItem, NewMemory } from "../src/domain/memory.js";
import type { ProfileRepository, UserProfile } from "../src/domain/profile.js";
import type {
  ActiveSession,
  DueCheckInSource,
  SessionRepository,
} from "../src/domain/session.js";
import type { StudentTask, TaskRepository } from "../src/domain/task.js";

const OWNER = "probe-chat";
const RETRY_LIMIT = 5;
const BACKOFF_BASE_MS = 4_000;

interface SessionState {
  turns: ConversationTurn[];
  tasks: StudentTask[];
  /** Catatan durable yang ditulis Harvy lewat `memory.remember`. */
  notes: MemoryItem[];
  /** Episode terkompaksi; kosong sampai probe dijalankan cukup panjang. */
  episodes: ConversationEpisode[];
}

/**
 * Penyimpan catatan lokal untuk probe.
 *
 * `MemoryService` sungguhan menulis Markdown per pengguna, dan probe tidak
 * boleh menyentuh folder memori nyata. Batas yang penting tetap diuji di sini:
 * duplikat ditolak, dan penolakan dikembalikan sebagai `null` persis seperti
 * service aslinya.
 */
function probeMemoryStore(state: SessionState): AgentMemoryStore {
  return {
    async remember(input: NewMemory): Promise<MemoryItem | null> {
      const content = input.content.trim();
      if (!content) return null;
      const duplicate = state.notes.some(
        (note) => note.content.toLowerCase() === content.toLowerCase(),
      );
      if (duplicate) return null;
      const note: MemoryItem = {
        id: `probe-${state.notes.length + 1}`,
        ownerId: input.ownerId,
        kind: input.kind,
        content,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        expiresAt: null,
      };
      state.notes.push(note);
      return note;
    },
    async list(): Promise<MemoryItem[]> {
      return [...state.notes];
    },
  };
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
if (!message) {
  console.error("Pakai: tsx scripts/probe-chat.ts --message=\"...\" [--session=berkas.json]");
  process.exit(2);
}

async function main(text: string, statePath: string): Promise<void> {
  const state = loadState(statePath);
  const config = loadConfig();
  const client = await createInstrumentedAiClient(config, "evaluation");

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
        history: () => ({
          search: async (_ownerId, query, options) =>
            searchConversationEpisodes(state.episodes, query, options ?? {}),
        }),
        memories: probeMemoryStore(state),
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
  const proposed = immediateUnderstandingRoute(understanding, text);
  const route = permissions.generalState ? proposed : ({ kind: "conversation" } as const);

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
  const globalRoute = selectGlobalRoute({
    intent: understanding.intent === "request" || requiresAgentPlanning
      ? "request"
      : "question",
    messageLength: text.length,
    needsStepByStep: understanding.needsStepByStep,
    assessment: understanding.routingAssessment ?? null,
    specializedFlow: unhandledTaskChange,
    guidedInteraction: guidedSmallStep,
    risk: triage.level,
  });
  const useAgent = route.kind === "conversation" &&
    permissions.generalState &&
    (globalRoute === "specialized" || globalRoute === "orchestrate") &&
    (requiresAgentPlanning || unhandledTaskChange ||
      requestsAgentTooling(understanding.routingAssessment));

  const before = await repository.list(OWNER);
  let reply: string;
  let runStatus = "reply";
  if (route.kind === "save-task") {
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
    const result = await retry(() =>
      conversation.agent(
        text,
        globalRoute === "orchestrate" ? "orchestrate" : "tools",
        context,
        { ...runtimeBase, intent: understanding.intent === "request" ? "request" : "question" },
      )
    );
    runStatus = result.status;
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
      route: route.kind,
      globalRoute,
      pakaiAgent: useAgent,
      runStatus,
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
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const retryable = !(error instanceof AiResponseError) &&
        ((error instanceof AiError && error.status !== undefined &&
          (error.status === 408 || error.status === 429 || error.status >= 500)) ||
          (error instanceof Error && error.name === "AbortError"));
      if (attempt >= RETRY_LIMIT || !retryable) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 500))
      );
    }
  }
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
