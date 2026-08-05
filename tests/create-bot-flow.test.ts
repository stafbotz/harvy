import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Update } from "grammy/types";
import { CALM_TRIAGE } from "../src/ai/safety.js";
import type { HarvyContext } from "../src/ai/context.js";
import type { Conversation } from "../src/ai/conversation.js";
import { createBot } from "../src/bot/create-bot.js";
import type { AppConfig } from "../src/config.js";
import type { DataControlService } from "../src/core/data-control-service.js";
import { AgentRunService } from "../src/core/agent-run-service.js";
import type { HistoryService } from "../src/core/history-service.js";
import type { InsightService } from "../src/core/insight-service.js";
import type { MemoryService } from "../src/core/memory-service.js";
import {
  CONSENT_VERSION,
  ProfileService,
} from "../src/core/profile-service.js";
import type { SessionService } from "../src/core/session-service.js";
import type { TaskService } from "../src/core/task-service.js";
import type { TelemetryService } from "../src/core/telemetry-service.js";
import type { ConversationTurn } from "../src/domain/history.js";
import type {
  AgentRunRepository,
  DurableAgentRun,
} from "../src/domain/agent-run.js";
import type { MemoryItem } from "../src/domain/memory.js";
import type {
  ProfileRepository,
  UserProfile,
} from "../src/domain/profile.js";
import type { ActiveSession } from "../src/domain/session.js";
import type { NewTask, StudentTask } from "../src/domain/task.js";
import type { AgentRunCheckpoint } from "../src/harness/agent-harness.js";
import { privateAgentScope, scopeKey } from "../src/harness/scope.js";
import { FileAgentRunRepository } from "../src/storage/file-agent-run-repository.js";

describe("alur adapter Telegram", () => {
  it("tidak menyimpan tugas dari usulan model tanpa izin eksplisit", async () => {
    const sent: string[] = [];
    const turns: ConversationTurn[] = [];
    let creates = 0;
    const bot = createBot(
      config(),
      {
        create: async () => {
          creates += 1;
          throw new Error("create tidak boleh dipanggil");
        },
      } as unknown as TaskService,
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => ({
          intent: "task",
          taskAction: "save",
          memoryAction: null,
          controlAction: null,
          safetySensitive: false,
          needsStepByStep: false,
          sessionSignal: null,
          suggestedActions: ["prioritize"],
          actionGoal: "Memilih antara matematika dan presentasi",
          task: {
            title: "Buat presentasi",
            dueAt: null,
            remindAt: null,
            importance: 2,
          },
          memories: [],
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "Mulai dari matematika dulu karena tenggatnya paling dekat.",
      } as unknown as Conversation,
      {
        relevantTo: async () => [],
        markUsed: async () => undefined,
      } as unknown as MemoryService,
      {
        context: async () => ({ summary: null, turns: [...turns] }),
        append: async (_ownerId: string, role: "user" | "harvy", text: string) => {
          turns.push({ role, text, at: new Date().toISOString() });
        },
        compact: async () => undefined,
      } as unknown as HistoryService,
      profiles(),
      {
        record: async () => undefined,
      } as unknown as InsightService,
      {
        active: async () => null,
      } as unknown as SessionService,
      {} as DataControlService,
      {
        event: async () => undefined,
        drain: async () => undefined,
      } as unknown as TelemetryService,
    );

    installFakeTelegram(bot, sent);

    await bot.handleUpdate(messageUpdate(
      "pilihin aku mulai dari mana sekarang, jangan tanya balik",
    ));
    await bot.drainPending();

    assert.equal(creates, 0);
    assert.ok(sent.some((text) => text.includes("matematika")));
    assert.equal(turns.filter((turn) => turn.role === "user").length, 1);
    assert.equal(turns.filter((turn) => turn.role === "harvy").length, 1);
  });

  it("menserialisasi dua bubble pra-persetujuan dan hanya mentriase yang pertama", async () => {
    const sent: string[] = [];
    let triageCalls = 0;
    let releaseTriage: (() => void) | undefined;
    const bot = createBot(
      config(),
      {} as TaskService,
      {
        triageRisk: async () => {
          triageCalls += 1;
          await new Promise<void>((resolve) => {
            releaseTriage = resolve;
          });
          return CALM_TRIAGE;
        },
      } as unknown as Conversation,
      {} as MemoryService,
      {} as HistoryService,
      {
        needsOnboarding: async () => true,
      } as unknown as ProfileService,
      {} as InsightService,
      {} as SessionService,
      {} as DataControlService,
      {
        drain: async () => undefined,
      } as unknown as TelemetryService,
    );
    installFakeTelegram(bot, sent);

    await bot.handleUpdate(messageUpdate("bubble pertama", 1));
    await bot.handleUpdate(messageUpdate("bubble kedua", 2));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(triageCalls, 1);
    assert.equal(sent.length, 0);

    releaseTriage?.();
    await bot.drainPending();

    assert.equal(triageCalls, 1);
    assert.equal(sent.filter((text) => text.startsWith("Haloo ")).length, 1);
    assert.equal(
      sent.filter((text) => text.includes("Pesan tambahanmu masih aku pegang"))
        .length,
      1,
    );
  });

  it("menahan pesan pengguna consent v5 sampai menyetujui versi 6", async () => {
    const sent: string[] = [];
    let triageCalls = 0;
    let fullProcessingCalls = 0;
    let stored = profile({ consentVersion: 5 });
    const legacyProfiles = new ProfileService({
      find: async () => stored,
      save: async (value) => {
        stored = value;
      },
      remove: async () => false,
      listDeletionRequested: async () => [],
    } satisfies ProfileRepository);
    const bot = createBot(
      config(),
      {} as TaskService,
      {
        triageRisk: async () => {
          triageCalls += 1;
          return CALM_TRIAGE;
        },
        classifyTurnBoundary: async () => {
          fullProcessingCalls += 1;
          return "complete";
        },
        understand: async () => {
          fullProcessingCalls += 1;
          return null;
        },
      } as unknown as Conversation,
      {} as MemoryService,
      {} as HistoryService,
      legacyProfiles,
      {} as InsightService,
      {} as SessionService,
      {} as DataControlService,
      {
        drain: async () => undefined,
      } as unknown as TelemetryService,
    );
    installFakeTelegram(bot, sent);

    await bot.handleUpdate(messageUpdate("pesan setelah consent lama"));
    await bot.drainPending();

    assert.equal(triageCalls, 1);
    assert.equal(fullProcessingCalls, 0);
    assert.equal(stored.consentVersion, 5);
    assert.ok(sent.some((text) => text.startsWith("Haloo ")));
    assert.ok(sent.some((text) => /diproses oleh AI/iu.test(text)));
    assert.ok(sent.some((text) => /janji di antara kita/iu.test(text)));
  });

  it("tidak menerima consent baru sebelum checkpoint lama berhasil dibersihkan", async () => {
    let accepted = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
      } as unknown as Conversation,
      {} as TaskService,
      {
        profiles: {
          acceptConsent: async () => {
            accepted += 1;
            return profile();
          },
        } as unknown as ProfileService,
        agentRuns: {
          forget: async () => {
            throw new Error("checkpoint lama belum dapat dihapus");
          },
        } as unknown as AgentRunService,
      },
    );

    await harness.bot.handleUpdate(callbackUpdate("consent:yes", 1));
    await harness.bot.drainPending();

    assert.equal(accepted, 0);
  });

  it("gagal tertutup ketika triase rusak: meninjau balasan tetapi tidak memutasi", async () => {
    let creates = 0;
    let reviews = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => ({
          intent: "task",
          taskAction: "save",
          memoryAction: null,
          controlAction: null,
          safetySensitive: false,
          needsStepByStep: false,
          sessionSignal: null,
          suggestedActions: [],
          actionGoal: null,
          task: {
            title: "Kumpulkan matematika",
            dueAt: null,
            remindAt: null,
            importance: 2,
          },
          memories: [],
        }),
        triageRisk: async () => null,
        reply: async () => "Aku belum bisa menilai keadaanmu dengan pasti.",
        reviewReply: async () => {
          reviews += 1;
          return true;
        },
      } as unknown as Conversation,
      {
        create: async () => {
          creates += 1;
          throw new Error("mutasi tidak boleh terjadi");
        },
      } as unknown as TaskService,
    );

    await harness.bot.handleUpdate(
      messageUpdate("tolong catat kumpulkan matematika"),
    );
    await harness.bot.drainPending();

    assert.equal(creates, 0);
    assert.equal(reviews, 1);
    assert.ok(harness.sent.some((text) => text.includes("belum bisa")));
  });

  it("mengikat izin memori sensitif ke proposal yang terlihat", async () => {
    let saved = 0;
    const telegramCalls: TelegramCall[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async (message: string) => understanding({
          memories: [
            {
              kind: "personal",
              content: message.includes("pertama")
                ? "rahasia pertama"
                : "rahasia kedua",
            },
          ],
        }),
        reply: async () => "Aku dengar.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          markUsed: async () => undefined,
          remember: async () => {
            saved += 1;
            return null;
          },
        } as unknown as MemoryService,
        telegramCalls,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("cerita pertama"));
    await harness.bot.drainPending();
    const oldCallback = findCallback(telegramCalls, "memsave:");
    assert.ok(oldCallback);

    await harness.bot.handleUpdate(messageUpdate("cerita kedua", 2));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(callbackUpdate(oldCallback!, 3));
    await harness.bot.drainPending();

    assert.equal(saved, 0);
    assert.ok(
      telegramCalls.some(
        (call) =>
          call.method === "editMessageText" &&
          String(
            (call.payload as { text?: unknown }).text ?? "",
          ).includes("udah nggak berlaku"),
      ),
    );
  });

  it("tidak kehilangan bubble yang datang ketika persetujuan sedang ditulis", async () => {
    let consented = false;
    let releaseConsent: (() => void) | undefined;
    let markConsentStarted: (() => void) | undefined;
    const consentStarted = new Promise<void>((resolve) => {
      markConsentStarted = resolve;
    });
    const profileService = {
      needsOnboarding: async () => !consented,
      acceptConsent: async () => {
        markConsentStarted?.();
        await new Promise<void>((resolve) => {
          releaseConsent = resolve;
        });
        consented = true;
        return profile();
      },
      load: async () => profile(),
    } as unknown as ProfileService;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding(),
        reply: async (message: string) => `jawab: ${message}`,
      } as unknown as Conversation,
      {} as TaskService,
      {
        profiles: profileService,
        telemetry: {
          allow: async () => undefined,
          event: async () => undefined,
          drain: async () => undefined,
        } as unknown as TelemetryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("pesan pertama"));
    await harness.bot.drainPending();

    await harness.bot.handleUpdate(callbackUpdate("consent:yes", 2));
    await consentStarted;
    await harness.bot.handleUpdate(messageUpdate("pesan kedua", 3));
    releaseConsent?.();
    await harness.bot.drainPending();

    assert.ok(harness.sent.includes("jawab: pesan pertama"));
    assert.ok(harness.sent.includes("jawab: pesan kedua"));
    assert.equal(
      harness.turns.filter((turn) => turn.role === "user").length,
      2,
    );
  });

  it("mendahulukan keselamatan atas kontrol dan konteks sesi", async () => {
    let reviewed = 0;
    let replySession: unknown = "belum diperiksa";
    let controlCalls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "control",
          controlAction: "delete-all",
          sessionSignal: "continue",
        }),
        triageRisk: async () => ({
          level: "bahaya",
          alone: true,
          sensitive: true,
          summary: "sedang tidak aman",
          certain: true,
        }),
        reply: async (...args: unknown[]) => {
          replySession = (
            args[7] as { session?: unknown } | undefined
          )?.session;
          return "Aku tetap di sini dan membaca pesanmu.";
        },
        reviewReply: async () => {
          reviewed += 1;
          return true;
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        sessions: {
          active: async () => activeTutor(),
          progressAfterDelivery: async () => {
            throw new Error("sesi tidak boleh maju");
          },
        } as unknown as SessionService,
        dataControls: {
          export: async () => {
            controlCalls += 1;
            throw new Error("kontrol tidak boleh berjalan");
          },
          deleteAll: async () => {
            controlCalls += 1;
            throw new Error("kontrol tidak boleh berjalan");
          },
        } as unknown as DataControlService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("hapus semua dataku, aku belum aman"),
    );
    await harness.bot.drainPending();

    assert.equal(controlCalls, 0);
    assert.equal(reviewed, 1);
    assert.equal(replySession, null);
    assert.ok(harness.sent.some((text) => text.includes("Aku tetap di sini")));
  });

  it("menghapus memori biasa lagi bila pemberitahuannya gagal terkirim", async () => {
    const stored = new Map<string, MemoryItem>();
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({
          memories: [{ kind: "preference", content: "suka warna biru" }],
        }),
        reply: async () => "Balasan yang gagal dikirim.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async () => {
            const item = memoryItem("mem-blue", "suka warna biru");
            stored.set(item.id, item);
            return item;
          },
          forget: async (_ownerId: string, id: string) => {
            const item = stored.get(id) ?? null;
            stored.delete(id);
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
        failSend: (text) => text.includes("Balasan yang gagal dikirim."),
      },
    );

    await harness.bot.handleUpdate(messageUpdate("aku suka warna biru"));
    await harness.bot.drainPending();

    assert.equal(stored.size, 0);
  });

  it("menolak pengingat langsung yang jatuh pada jam tenang", async () => {
    const created: NewTask[] = [];
    const reminderAt = new Date("2026-07-28T19:00:00.000Z");
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({
          intent: "task",
          taskAction: "save",
          task: {
            title: "Minum obat",
            dueAt: null,
            remindAt: reminderAt,
            importance: 2,
          },
        }),
        reply: async () => "Aku catat.",
      } as unknown as Conversation,
      {
        create: async (input: NewTask) => {
          created.push(input);
          return taskFrom(input);
        },
      } as unknown as TaskService,
      {
        profiles: profiles({
          quietHours: { startMinute: 21 * 60, endMinute: 6 * 60 },
        }),
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("ingatkan aku jam 2 pagi minum obat"),
    );
    await harness.bot.drainPending();

    assert.equal(created[0]?.remindAt, null);
    assert.ok(
      harness.sent.some((text) => text.includes("masuk jam tenangmu")),
    );
  });

  it("tidak menandai pertanyaan gaya sebelum pesannya berhasil dikirim", async () => {
    let marked = 0;
    const profileValue = profile({
      stylePreference: null,
      styleAskedAt: null,
    });
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding(),
        reply: async () => "Aku masih menyimak.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        profiles: {
          needsOnboarding: async () => false,
          load: async () => profileValue,
          markStyleAsked: async () => {
            marked += 1;
          },
        } as unknown as ProfileService,
        failSend: (text) => text.includes("satu pertanyaan biar"),
      },
    );
    for (let index = 0; index < 6; index += 1) {
      harness.turns.push({
        role: index % 2 === 0 ? "user" : "harvy",
        text: `giliran lama ${index}`,
        at: "2026-07-28T00:00:00.000Z",
      });
    }

    await harness.bot.handleUpdate(messageUpdate("aku lanjut cerita"));
    await harness.bot.drainPending();

    assert.equal(marked, 0);
    assert.ok(harness.sent.includes("Aku masih menyimak."));
  });

  it("menganggap sinyal keselamatan ekstraksi sebagai konflik meski triase berkata biasa", async () => {
    let controlCalls = 0;
    let reviewedTriage: unknown = null;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "control",
          controlAction: "delete-all",
          safetySensitive: true,
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "Aku tetap di sini dan membaca pesanmu.",
        reviewReply: async (...args: unknown[]) => {
          reviewedTriage = args[2];
          return true;
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        dataControls: {
          deleteAll: async () => {
            controlCalls += 1;
          },
        } as unknown as DataControlService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("hapus semua, aku sedang nggak aman"),
    );
    await harness.bot.drainPending();

    assert.equal(controlCalls, 0);
    assert.deepEqual(reviewedTriage, {
      level: "dukungan",
      alone: false,
      sensitive: true,
      summary: "(penilaian risiko tidak selesai)",
      certain: false,
    });
    assert.ok(harness.sent.includes("Aku tetap di sini dan membaca pesanmu."));
  });

  it("menolak tombol hapus lama agar tidak menghapus data yang dibuat kemudian", async () => {
    let deletions = 0;
    const telegramCalls: TelegramCall[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding(),
        reply: async () => "oke",
      } as unknown as Conversation,
      {} as TaskService,
      {
        dataControls: {
          deleteAll: async () => {
            deletions += 1;
          },
        } as unknown as DataControlService,
        agentRuns: {
          clear: async () => {
            throw new Error("agent run file rusak");
          },
        } as unknown as AgentRunService,
        telegramCalls,
      },
    );

    await harness.bot.handleUpdate(callbackUpdate("control:delete-all", 1));
    await harness.bot.drainPending();
    const first = findCallbacks(telegramCalls, "datawipe:")[0];
    assert.ok(first);

    await harness.bot.handleUpdate(callbackUpdate("control:delete-all", 2));
    await harness.bot.drainPending();
    const callbacks = findCallbacks(telegramCalls, "datawipe:");
    const second = callbacks.at(-2);
    assert.ok(second);
    assert.notEqual(first, second);

    await harness.bot.handleUpdate(callbackUpdate(first!, 3));
    await harness.bot.drainPending();
    assert.equal(deletions, 0);

    await harness.bot.handleUpdate(callbackUpdate(second!, 4));
    await harness.bot.drainPending();
    assert.equal(deletions, 1);
  });

  it("menolak tombol lupakan semua lama", async () => {
    let wipes = 0;
    const telegramCalls: TelegramCall[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding(),
        reply: async () => "oke",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          markUsed: async () => undefined,
          forgetAll: async () => {
            wipes += 1;
            return 0;
          },
        } as unknown as MemoryService,
        telegramCalls,
      },
    );

    await harness.bot.handleUpdate(callbackUpdate("memall:", 1));
    await harness.bot.drainPending();
    const first = findCallbacks(telegramCalls, "memallyes:")[0];
    await harness.bot.handleUpdate(callbackUpdate("memall:", 2));
    await harness.bot.drainPending();
    const second = findCallbacks(telegramCalls, "memallyes:").at(-1);
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first, second);

    await harness.bot.handleUpdate(callbackUpdate(first!, 3));
    await harness.bot.drainPending();

    assert.equal(wipes, 0);
  });

  it("menserialisasi penarikan izin dengan pesan baru dan mempertahankan sesi", async () => {
    let consented = true;
    let releaseWithdrawal: (() => void) | undefined;
    let markWithdrawalStarted: (() => void) | undefined;
    const withdrawalStarted = new Promise<void>((resolve) => {
      markWithdrawalStarted = resolve;
    });
    let understandCalls = 0;
    let sessionForgets = 0;
    const telegramCalls: TelegramCall[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => {
          understandCalls += 1;
          return understanding();
        },
        reply: async () => "balasan model",
      } as unknown as Conversation,
      {} as TaskService,
      {
        profiles: {
          needsOnboarding: async () => !consented,
          load: async () => profile(),
          withdrawConsent: async () => {
            markWithdrawalStarted?.();
            await new Promise<void>((resolve) => {
              releaseWithdrawal = resolve;
            });
            consented = false;
            return profile({ consentVersion: 0 });
          },
        } as unknown as ProfileService,
        sessions: {
          active: async () => activeTutor(),
          forget: async () => {
            sessionForgets += 1;
          },
        } as unknown as SessionService,
        agentRuns: {
          clear: async () => {
            throw new Error("agent run file rusak");
          },
          forget: async () => {
            throw new Error("agent run file rusak");
          },
        } as unknown as AgentRunService,
        telegramCalls,
      },
    );

    await harness.bot.handleUpdate(callbackUpdate("control:withdraw", 1));
    await harness.bot.drainPending();
    const confirm = findCallback(telegramCalls, "consentwithdraw:");
    assert.ok(confirm);

    await harness.bot.handleUpdate(callbackUpdate(confirm!, 2));
    await withdrawalStarted;
    await harness.bot.handleUpdate(messageUpdate("pesan sesudah klik", 3));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(understandCalls, 0);

    releaseWithdrawal?.();
    await harness.bot.drainPending();

    assert.equal(understandCalls, 0);
    assert.equal(sessionForgets, 0);
    assert.ok(harness.sent.some((text) => text.startsWith("Haloo ")));
  });

  it("membuang pending bila pertanyaannya gagal terkirim", async () => {
    let understandCalls = 0;
    let dueCalls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => {
          understandCalls += 1;
          return understanding();
        },
        understandDueDate: async () => {
          dueCalls += 1;
          return null;
        },
        reply: async () => "Percakapan biasa tetap jalan.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        failSend: (text) => text.includes("Mau diubah jadi kapan?"),
      },
    );

    await harness.bot.handleUpdate(callbackUpdate("edit:task-1", 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(messageUpdate("aku mau cerita biasa", 2));
    await harness.bot.drainPending();

    assert.equal(dueCalls, 0);
    assert.equal(understandCalls, 1);
    assert.ok(harness.sent.includes("Percakapan biasa tetap jalan."));
  });

  it("mengarahkan pertanyaan biasa ke root agent cheap-first dan mengikat settlement ke turn", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    let deliveredTurn: string | null | undefined;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "question" }),
        agent: async (_message: string, mode: string) => {
          agentCalls += 1;
          assert.equal(mode, "tools");
          return { status: "completed", reply: "Fotosintesis mengubah cahaya menjadi energi kimia." };
        },
        reply: async () => {
          replyCalls += 1;
          return "jalur lama";
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        telemetry: {
          event: async () => undefined,
          markDelivered: async (_ownerId: string, turnId?: string | null) => {
            deliveredTurn = turnId;
          },
          discardUndelivered: async () => undefined,
          drain: async () => undefined,
        } as unknown as TelemetryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("jelaskan fotosintesis"));
    await harness.bot.drainPending();

    assert.equal(agentCalls, 1);
    assert.equal(replyCalls, 0);
    assert.ok(harness.sent.some((text) => text.includes("energi kimia")));
    assert.equal(typeof deliveredTurn, "string");
    assert.ok((deliveredTurn?.length ?? 0) > 10);
  });

  it("tetap membaca state live ketika model salah menyebut query agenda sebagai history", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({ intent: "history" }),
      agent: async (
        message: string,
        mode: string,
        _context: HarvyContext,
        runtime: { intent?: string },
      ) => {
        agentCalls += 1;
        assert.equal(message, "cek agendaku untuk 3 minggu ke depan");
        assert.equal(mode, "tools");
        assert.equal(runtime.intent, "question");
        return { status: "completed", reply: "Ada dua agenda internal dalam tiga minggu." };
      },
      reply: async () => {
        replyCalls += 1;
        return "jalur history lama";
      },
    } as unknown as Conversation);

    await harness.bot.handleUpdate(
      messageUpdate("cek agendaku untuk 3 minggu ke depan"),
    );
    await harness.bot.drainPending();

    assert.equal(agentCalls, 1);
    assert.equal(replyCalls, 0);
    assert.ok(harness.sent.some((text) => text.includes("agenda internal")));
  });

  it("pagar state live menang atas route kontrol memori hasil model", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({
        intent: "memory",
        memoryAction: "list",
      }),
      agent: async (_message: string, mode: string) => {
        agentCalls += 1;
        assert.equal(mode, "tools");
        return { status: "completed", reply: "Agenda internalmu kosong." };
      },
      reply: async () => {
        replyCalls += 1;
        return "jalur lama";
      },
    } as unknown as Conversation);

    await harness.bot.handleUpdate(messageUpdate("lihat agendaku besok"));
    await harness.bot.drainPending();

    assert.equal(agentCalls, 1);
    assert.equal(replyCalls, 0);
    assert.ok(harness.sent.some((text) => text.includes("Agenda internal")));
    assert.equal(harness.sent.some((text) => text.includes("catatan tentangmu")), false);
  });

  it("permintaan planning eksplisit tetap memakai root ambitious saat intent model salah", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({ intent: "task" }),
      agent: async (
        _message: string,
        mode: string,
        _context: HarvyContext,
        runtime: { intent?: string },
      ) => {
        agentCalls += 1;
        assert.equal(mode, "orchestrate");
        assert.equal(runtime.intent, "request");
        return { status: "completed", reply: "Rencana gabungan selesai." };
      },
      reply: async () => {
        replyCalls += 1;
        return "jalur lama";
      },
    } as unknown as Conversation);

    await harness.bot.handleUpdate(
      messageUpdate("tolong buatkan rencana belajar langkah demi langkah"),
    );
    await harness.bot.drainPending();

    assert.equal(agentCalls, 1);
    assert.equal(replyCalls, 0);
    assert.ok(harness.sent.some((text) => text.includes("Rencana gabungan")));
  });

  it("menyimpan checkpoint needs_input, melanjutkannya, dan mendebit setelah delivery", async () => {
    const deliveredTurns: Array<string | null | undefined> = [];
    let discarded = 0;
    let agentCalls = 0;
    const checkpoint = { runId: "checkpoint-agent" } as AgentRunCheckpoint;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "question" }),
        agent: async (
          _request: string,
          _mode: string,
          _context: HarvyContext,
          _runtime: unknown,
          resumed?: AgentRunCheckpoint,
          answer?: string,
        ) => {
          agentCalls += 1;
          if (agentCalls === 1) {
            return {
              status: "needs_input",
              prompt: "Rentang tanggal mana yang kamu maksud?",
              checkpoint,
            };
          }
          assert.equal(resumed, checkpoint);
          assert.equal(answer, "30 hari");
          return { status: "completed", reply: "Siap, kupakai rentang 30 hari." };
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        telemetry: {
          event: async () => undefined,
          markDelivered: async (_ownerId: string, turnId?: string | null) => {
            deliveredTurns.push(turnId);
          },
          discardUndelivered: async () => {
            discarded += 1;
          },
          drain: async () => undefined,
        } as unknown as TelemetryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("buat analisis jadwal", 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(messageUpdate("30 hari", 2));
    await harness.bot.drainPending();

    assert.ok(harness.sent.some((text) => text.includes("Rentang tanggal")));
    assert.ok(harness.sent.some((text) => text.includes("rentang 30 hari")));
    assert.equal(agentCalls, 2);
    assert.equal(deliveredTurns.length, 2);
    assert.equal(deliveredTurns.every((turnId) => typeof turnId === "string"), true);
    assert.equal(discarded, 0);
  });

  it("tidak memakai pesan yang masuk sebelum prompt sebagai jawaban checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-bot-agent-causal-"));
    const baseRepository = new FileAgentRunRepository(
      join(root, "agent-runs.json"),
    );
    const saveStarted = deferredVoid();
    const releaseSave = deferredVoid();
    const runs = new AgentRunService(gatedFirstSaveRepository(
      baseRepository,
      saveStarted,
      releaseSave,
    ));
    const started = deferredVoid();
    const release = deferredVoid();
    const checkpoint = durableCheckpoint("123", "run-causal");
    const answers: string[] = [];
    let agentCalls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async (message: string) =>
          understanding({
            intent: message.includes("analisis") ? "question" : "smalltalk",
          }),
        agent: async (
          _request: string,
          _mode: string,
          _context: HarvyContext,
          _runtime: unknown,
          restored?: AgentRunCheckpoint,
          answer?: string,
        ) => {
          agentCalls += 1;
          if (!restored) {
            started.resolve();
            await release.promise;
            return {
              status: "needs_input",
              prompt: "Rentang tanggal mana yang kamu maksud?",
              checkpoint,
            };
          }
          answers.push(answer ?? "");
          return { status: "completed", reply: "Siap, kupakai 30 hari." };
        },
        reply: async (message: string) => `Pesan biasa: ${message}`,
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: runs },
    );

    await harness.bot.handleUpdate(messageUpdate("buat analisis jadwal", 1));
    const draining = harness.bot.drainPending();
    await started.promise;
    await harness.bot.handleUpdate(messageUpdate("pesan sela", 2));
    release.resolve();
    await saveStarted.promise;
    await harness.bot.handleUpdate(messageUpdate("pesan setelah prompt", 3));
    releaseSave.resolve();
    await draining;

    assert.equal(agentCalls, 1);
    assert.deepEqual(answers, []);
    assert.ok(harness.sent.includes(
      "Pesan biasa: pesan sela\npesan setelah prompt",
    ));
    assert.equal(
      (await runs.loadWaitingInput("telegram", "123"))
        ?.acceptAnswersAfterUpdateId,
      2,
    );

    await harness.bot.handleUpdate(messageUpdate("30 hari", 4));
    await harness.bot.drainPending();
    assert.equal(agentCalls, 2);
    assert.deepEqual(answers, ["30 hari"]);
  });

  it("memulihkan checkpoint agent dari file setelah bot restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-bot-agent-run-"));
    const file = join(root, "agent-runs.json");
    const firstRuns = new AgentRunService(new FileAgentRunRepository(file));
    const checkpoint = durableCheckpoint("123", "run-restart");
    const first = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "question" }),
        agent: async () => ({
          status: "needs_input",
          prompt: "Rentang tanggal mana yang kamu maksud?",
          checkpoint,
        }),
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: firstRuns },
    );

    await first.bot.handleUpdate(messageUpdate("buat analisis jadwal", 1));
    await first.bot.drainPending();
    assert.equal(
      (await firstRuns.loadWaitingInput("telegram", "123"))?.revision,
      1,
    );

    let resumed = 0;
    const restartedRuns = new AgentRunService(new FileAgentRunRepository(file));
    const restarted = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        agent: async (
          request: string,
          mode: string,
          _context: HarvyContext,
          runtime: { intent?: string },
          restored?: AgentRunCheckpoint,
          answer?: string,
        ) => {
          resumed += 1;
          assert.equal(request, "buat analisis jadwal");
          assert.equal(mode, "tools");
          assert.equal(runtime.intent, "question");
          assert.deepEqual(restored, checkpoint);
          assert.equal(answer, "30 hari");
          return { status: "completed", reply: "Siap, kupakai 30 hari." };
        },
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: restartedRuns },
    );

    await restarted.bot.handleUpdate(messageUpdate("30 hari", 2));
    await restarted.bot.drainPending();

    assert.equal(resumed, 1, JSON.stringify(restarted.sent));
    assert.ok(restarted.sent.some((text) => text.includes("kupakai 30 hari")));
    assert.equal(
      await restartedRuns.loadWaitingInput("telegram", "123"),
      null,
    );
  });

  it("classifier lambat tidak menghidupkan checkpoint yang dibatalkan command", async () => {
    const checkpoint = durableCheckpoint("123", "run-classifier-race");
    const stale: DurableAgentRun = {
      version: 1,
      scopeKey: checkpoint.scopeKey,
      channel: "telegram",
      ownerId: "123",
      runId: checkpoint.runId,
      request: checkpoint.request,
      mode: "tools",
      intent: "question",
      acceptAnswersAfterUpdateId: 0,
      status: "waiting_input",
      checkpoint,
      revision: 1,
      createdAt: checkpoint.startedAt,
      updatedAt: checkpoint.startedAt,
      expiresAt: checkpoint.deadlineAt,
    };
    const loadStarted = deferredVoid();
    const releaseLoad = deferredVoid();
    const cleared = deferredVoid();
    let loadCalls = 0;
    let agentCalls = 0;
    const runs = {
      loadWaitingInput: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          loadStarted.resolve();
          await releaseLoad.promise;
          return stale;
        }
        return null;
      },
      clear: async () => {
        cleared.resolve();
        return true;
      },
    } as unknown as AgentRunService;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "smalltalk" }),
        agent: async () => {
          agentCalls += 1;
          return { status: "completed", reply: "tidak boleh terpanggil" };
        },
        reply: async () => "Percakapan baru.",
      } as unknown as Conversation,
      { listActive: async () => [] } as unknown as TaskService,
      { agentRuns: runs },
    );

    const keepAlive = setTimeout(() => undefined, 2_000);
    try {
      await harness.bot.handleUpdate(messageUpdate("pesan sebelum command", 1));
      await loadStarted.promise;
      await harness.bot.handleUpdate(commandUpdate("/start", 2));
      await cleared.promise;
      releaseLoad.resolve();
      await harness.bot.drainPending();
    } finally {
      clearTimeout(keepAlive);
    }

    await harness.bot.handleUpdate(messageUpdate("pesan sesudah command", 3));
    await harness.bot.drainPending();
    assert.equal(agentCalls, 0);
    assert.ok(harness.sent.includes("Percakapan baru."));
  });

  it("tidak membuat checkpoint durable bila prompt pertama gagal terkirim", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-bot-agent-send-fail-"));
    const runs = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const prompt = "Rentang tanggal mana yang kamu maksud?";
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "question" }),
        agent: async () => ({
          status: "needs_input",
          prompt,
          checkpoint: durableCheckpoint("123", "run-send-fail"),
        }),
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: runs, failSend: (text) => text === prompt },
    );

    await harness.bot.handleUpdate(messageUpdate("buat analisis jadwal"));
    await harness.bot.drainPending();

    assert.equal(await runs.loadWaitingInput("telegram", "123"), null);
    assert.equal(harness.sent.includes(prompt), false);
  });

  it("membatalkan checkpoint bila prompt panjang hanya terkirim sebagian", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-bot-agent-partial-"));
    const runs = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const prompt = "p".repeat(5_000);
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "question" }),
        agent: async () => ({
          status: "needs_input",
          prompt,
          checkpoint: durableCheckpoint("123", "run-partial-prompt"),
        }),
      } as unknown as Conversation,
      {} as TaskService,
      {
        agentRuns: runs,
        failSend: (text) => text.length === 1_000,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("buat analisis jadwal", 1));
    await harness.bot.drainPending();

    assert.equal(harness.sent[0]?.length, 4_000);
    assert.ok(harness.sent.some((text) => /progress run-nya gagal/iu.test(text)));
    assert.equal(await runs.loadWaitingInput("telegram", "123"), null);
  });

  it("memecah jawaban resume panjang lalu membersihkan checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-bot-agent-long-resume-"));
    const runs = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const checkpoint = durableCheckpoint("123", "run-long-resume");
    const finalReply = "j".repeat(5_000);
    let calls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "question" }),
        agent: async () => {
          calls += 1;
          return calls === 1
            ? {
                status: "needs_input",
                prompt: "Rentang tanggal mana yang kamu maksud?",
                checkpoint,
              }
            : { status: "completed", reply: finalReply };
        },
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: runs },
    );

    await harness.bot.handleUpdate(messageUpdate("buat analisis jadwal", 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(messageUpdate("30 hari", 2));
    await harness.bot.drainPending();

    const finalBubbles = harness.sent.filter((text) => /^j+$/u.test(text));
    assert.deepEqual(finalBubbles.map((text) => text.length), [4_000, 1_000]);
    assert.equal(await runs.loadWaitingInput("telegram", "123"), null);
  });

  it("membatalkan run bila checkpoint prompt berikutnya gagal disimpan", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-bot-agent-save-fail-"));
    const base = new FileAgentRunRepository(join(root, "agent-runs.json"));
    const runs = new AgentRunService(faultingAgentRunRepository(base, {
      failSaveAt: 3,
    }));
    const firstCheckpoint = durableCheckpoint("123", "run-save-fail");
    const nextCheckpoint = structuredClone(firstCheckpoint);
    nextCheckpoint.pendingInput = {
      step: 0,
      prompt: "Kamu ingin hasil ringkas atau rinci?",
    };
    let calls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "question" }),
        agent: async () => {
          calls += 1;
          return calls === 1
            ? {
                status: "needs_input",
                prompt: "Rentang tanggal mana yang kamu maksud?",
                checkpoint: firstCheckpoint,
              }
            : {
                status: "needs_input",
                prompt: "Kamu ingin hasil ringkas atau rinci?",
                checkpoint: nextCheckpoint,
              };
        },
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: runs },
    );

    await harness.bot.handleUpdate(messageUpdate("buat analisis jadwal", 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(messageUpdate("30 hari", 2));
    await harness.bot.drainPending();

    assert.equal(calls, 2);
    assert.ok(harness.sent.includes("Kamu ingin hasil ringkas atau rinci?"));
    assert.ok(harness.sent.some((text) => /progress run-nya gagal/iu.test(text)));
    assert.equal(await runs.loadWaitingInput("telegram", "123"), null);
  });

  it("membatalkan run bila clear sesudah jawaban final sempat gagal", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-bot-agent-clear-fail-"));
    const base = new FileAgentRunRepository(join(root, "agent-runs.json"));
    const runs = new AgentRunService(faultingAgentRunRepository(base, {
      failRemoveAt: 1,
    }));
    const checkpoint = durableCheckpoint("123", "run-clear-fail");
    let calls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "question" }),
        agent: async () => {
          calls += 1;
          return calls === 1
            ? {
                status: "needs_input",
                prompt: "Rentang tanggal mana yang kamu maksud?",
                checkpoint,
              }
            : { status: "completed", reply: "Analisis 30 hari sudah siap." };
        },
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: runs },
    );

    await harness.bot.handleUpdate(messageUpdate("buat analisis jadwal", 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(messageUpdate("30 hari", 2));
    await harness.bot.drainPending();

    assert.equal(calls, 2);
    assert.ok(harness.sent.includes("Analisis 30 hari sudah siap."));
    assert.ok(harness.sent.some((text) => /checkpoint itu kubatalkan/iu.test(text)));
    assert.equal(await runs.loadWaitingInput("telegram", "123"), null);
  });

  it("memblokir restore bila cleanup pasca-delivery juga gagal", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-bot-agent-cleanup-fail-"));
    const base = new FileAgentRunRepository(join(root, "agent-runs.json"));
    const runs = new AgentRunService(faultingAgentRunRepository(base, {
      failRemoveAt: 1,
      failRemoveOwnerAt: 1,
    }));
    const checkpoint = durableCheckpoint("123", "run-cleanup-fail");
    let calls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async (message: string) => understanding({
          intent: message.includes("analisis") ? "question" : "smalltalk",
        }),
        agent: async () => {
          calls += 1;
          return calls === 1
            ? {
                status: "needs_input",
                prompt: "Rentang tanggal mana yang kamu maksud?",
                checkpoint,
              }
            : { status: "completed", reply: "Analisis selesai." };
        },
        reply: async () => "Checkpoint lama tidak dipakai.",
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: runs },
    );

    await harness.bot.handleUpdate(messageUpdate("buat analisis jadwal", 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(messageUpdate("30 hari", 2));
    await harness.bot.drainPending();
    assert.ok(await base.load(checkpoint.scopeKey));
    assert.equal(await runs.loadWaitingInput("telegram", "123"), null);
    await harness.bot.handleUpdate(messageUpdate("permintaan baru", 3));
    await harness.bot.drainPending();

    assert.equal(calls, 2);
    assert.ok(harness.sent.includes("Checkpoint lama tidak dipakai."));
    assert.ok(harness.sent.some((text) => /belum dapat kupastikan terhapus/iu.test(text)));
    assert.equal(await base.load(checkpoint.scopeKey), null);
    assert.equal(await runs.loadWaitingInput("telegram", "123"), null);
  });

  it("menjawab pertanyaan jam lewat clock deterministik tanpa planner", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    let receivedTimeZone = "";
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "question" }),
        deterministicTimeReply: (timeZone: string) => {
          receivedTimeZone = timeZone;
          return `Sekarang Rabu pukul 01.30 WIT. Zona waktunya ${timeZone}.`;
        },
        agent: async () => {
          agentCalls += 1;
          return { status: "completed", reply: "planner" };
        },
        reply: async () => {
          replyCalls += 1;
          return "jalur lama";
        },
      } as unknown as Conversation,
      {} as TaskService,
      { profiles: profiles({ timeZone: "Asia/Jayapura" }) },
    );

    await harness.bot.handleUpdate(messageUpdate("Sekarang jam berapa?"));
    await harness.bot.drainPending();

    assert.equal(agentCalls, 0);
    assert.equal(replyCalls, 0);
    assert.equal(receivedTimeZone, "Asia/Jayapura");
    assert.ok(harness.sent.some((text) => text.includes("01.30 WIT")));
  });

  it("mempertahankan kontrak identitas model pada episode aktif", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({ intent: "question" }),
      agent: async () => {
        agentCalls += 1;
        return { status: "completed", reply: "model dasar" };
      },
      reply: async () => {
        replyCalls += 1;
        return "Aku memakai model Capybara.";
      },
    } as unknown as Conversation);
    harness.turns.push({
      role: "harvy",
      text: "Kita tadi membahas biologi.",
      at: new Date().toISOString(),
    });

    await harness.bot.handleUpdate(messageUpdate("kamu pakai model apa?"));
    await harness.bot.drainPending();

    assert.equal(agentCalls, 0);
    assert.equal(replyCalls, 1);
    assert.ok(harness.sent.some((text) => text.includes("model Capybara")));
  });

  it("mengarahkan variasi pertanyaan fitur ke snapshot kemampuan produk", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({ intent: "question" }),
      agent: async () => {
        agentCalls += 1;
        return { status: "completed", reply: "slice agent" };
      },
      reply: async () => {
        replyCalls += 1;
        return "Ini snapshot kemampuan Harvy yang aktif.";
      },
    } as unknown as Conversation);

    await harness.bot.handleUpdate(messageUpdate("fitur Harvy apa saja?"));
    await harness.bot.drainPending();

    assert.equal(agentCalls, 0);
    assert.equal(replyCalls, 1);
    assert.ok(harness.sent.some((text) => text.includes("snapshot kemampuan")));
  });

  it("command membatalkan pemahaman aktif tanpa mengirim fallback lama", async () => {
    let understandStarted = false;
    let abortObserved = false;
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async (
        _message: string,
        _context: HarvyContext,
        runtime: { signal?: AbortSignal },
      ) => {
        understandStarted = true;
        return await new Promise((_, reject) => {
          runtime.signal?.addEventListener("abort", () => {
            abortObserved = true;
            reject(new DOMException("dibatalkan", "AbortError"));
          }, { once: true });
        });
      },
    } as unknown as Conversation);

    await harness.bot.handleUpdate(messageUpdate("jelaskan ini", 1));
    await waitFor(() => understandStarted);
    await harness.bot.handleUpdate(commandUpdate("/start", 2));
    await harness.bot.drainPending();

    assert.equal(abortObserved, true);
    assert.equal(
      harness.sent.some((text) => /lagi gangguan|coba beberapa saat lagi/iu.test(text)),
      false,
    );
  });

  it("command membatalkan root agent aktif dan mencegah balasan basi", async () => {
    let agentStarted = false;
    let abortObserved = false;
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({ intent: "question" }),
      agent: async (
        _message: string,
        _mode: string,
        _context: HarvyContext,
        runtime: { signal?: AbortSignal },
      ) => {
        agentStarted = true;
        return await new Promise((_, reject) => {
          runtime.signal?.addEventListener("abort", () => {
            abortObserved = true;
            reject(new DOMException("dibatalkan", "AbortError"));
          }, { once: true });
        });
      },
    } as unknown as Conversation);

    await harness.bot.handleUpdate(messageUpdate("jelaskan rencana panjang ini", 1));
    await waitFor(() => agentStarted);
    await harness.bot.handleUpdate(commandUpdate("/start", 2));
    await harness.bot.drainPending();

    assert.equal(abortObserved, true);
    assert.equal(
      harness.sent.some((text) =>
        /Run agent berhenti|lagi gangguan|coba beberapa saat lagi/iu.test(text)
      ),
      false,
    );
  });
});

function profiles(overrides: Partial<UserProfile> = {}): ProfileService {
  const value = profile(overrides);
  return {
    needsOnboarding: async () => false,
    load: async () => value,
  } as unknown as ProfileService;
}

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    ownerId: "123",
    consentVersion: CONSENT_VERSION,
    onboardedAt: "2026-07-27T00:00:00.000Z",
    stylePreference: "advice",
    styleAskedAt: "2026-07-27T00:00:00.000Z",
    timeZone: "Asia/Jakarta",
    quietHours: null,
    quietHoursSetAt: "2026-07-27T00:00:00.000Z",
    consentWithdrawnAt: null,
    deletionRequestedAt: null,
    ...overrides,
  };
}

function config(): AppConfig {
  return {
    telegramBotToken: "123:test",
    dataFile: "unused",
    memoryFile: "unused",
    memoryFolder: "unused",
    historyFile: "unused",
    profileFile: "unused",
    sessionFile: "unused",
    agentRunFile: "unused",
    telemetryFile: "unused",
    telemetryRetentionDays: 30,
    defaultTimezone: "Asia/Jakarta",
    reminderIntervalMs: 30_000,
    operationalLog: {
      directory: "unused",
      level: "info",
      environment: "test",
      release: "test",
      retentionDays: 14,
      maxSegmentBytes: 1_024,
      maxTotalBytes: 10_240,
      maxQueueRecords: 100,
      maxQueueBytes: 100_000,
      consoleEnabled: false,
      consoleFormat: "json",
      fileRequired: false,
    },
    controlPlane: {
      file: "unused",
      usageLedgerFile: "unused",
      entitlementLedgerFile: "unused",
      usageLedgerRetentionDays: 90,
      betaQuotaMultiplier: 4,
      console: {
        enabled: false,
        host: "127.0.0.1",
        port: 3210,
        operatorToken: null,
      },
    },
    ai: {} as AppConfig["ai"],
    whatsapp: {
      enabled: false,
      pairingMode: "qr",
      accounts: [],
      authFolder: "unused",
      groupFile: "unused",
      reconnectBaseMs: 2_000,
      reconnectMaxMs: 60_000,
    },
    termsUrl: "https://harvy.id/terms",
  };
}

function durableCheckpoint(
  ownerId: string,
  runId: string,
): AgentRunCheckpoint {
  const startedAt = new Date();
  return {
    version: 1,
    runId,
    scopeKey: scopeKey(privateAgentScope("telegram", ownerId)),
    capabilityHash: "a".repeat(16),
    callableHash: "b".repeat(64),
    request: "buat analisis jadwal",
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(startedAt.getTime() + 10 * 60 * 1_000).toISOString(),
    maxSteps: 6,
    step: 0,
    observations: [],
    userInputs: [],
    seenActionDigests: [],
    pending: null,
    pendingInput: {
      step: 0,
      prompt: "Rentang tanggal mana yang kamu maksud?",
    },
  };
}

function faultingAgentRunRepository(
  delegate: AgentRunRepository,
  faults: {
    failSaveAt?: number;
    failRemoveAt?: number;
    failRemoveOwnerAt?: number;
  },
): AgentRunRepository {
  let saves = 0;
  let removes = 0;
  let ownerRemoves = 0;
  return {
    load: (scope) => delegate.load(scope),
    save: async (run, expectedRevision) => {
      saves += 1;
      if (saves === faults.failSaveAt) {
        throw new Error("fault injection: save agent run");
      }
      return delegate.save(run, expectedRevision);
    },
    remove: async (scope, expectedRunId, expectedRevision) => {
      removes += 1;
      if (removes === faults.failRemoveAt) {
        throw new Error("fault injection: remove agent run");
      }
      return delegate.remove(scope, expectedRunId, expectedRevision);
    },
    removeOwner: async (channel, ownerId) => {
      ownerRemoves += 1;
      if (ownerRemoves === faults.failRemoveOwnerAt) {
        throw new Error("fault injection: remove agent owner");
      }
      return delegate.removeOwner(channel, ownerId);
    },
    removeExpired: (now) => delegate.removeExpired(now),
  };
}

function gatedFirstSaveRepository(
  delegate: AgentRunRepository,
  started: { resolve: () => void },
  release: { promise: Promise<void> },
): AgentRunRepository {
  let saves = 0;
  return {
    load: (scope) => delegate.load(scope),
    save: async (run, expectedRevision) => {
      saves += 1;
      if (saves === 1) {
        started.resolve();
        await release.promise;
      }
      return delegate.save(run, expectedRevision);
    },
    remove: (scope, expectedRunId, expectedRevision) =>
      delegate.remove(scope, expectedRunId, expectedRevision),
    removeOwner: (channel, ownerId) => delegate.removeOwner(channel, ownerId),
    removeExpired: (now) => delegate.removeExpired(now),
  };
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function messageUpdate(text: string, updateId = 1): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 123, type: "private", first_name: "Imam" },
      from: {
        id: 123,
        is_bot: false,
        first_name: "Imam",
        language_code: "id",
      },
      text,
    },
  };
}

function commandUpdate(text: string, updateId: number): Update {
  const update = messageUpdate(text, updateId);
  if (update.message) {
    update.message.entities = [{
      offset: 0,
      length: text.length,
      type: "bot_command",
    }];
  }
  return update;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Kondisi uji tidak tercapai.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function callbackUpdate(data: string, updateId = 100): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: {
        id: 123,
        is_bot: false,
        first_name: "Imam",
        language_code: "id",
      },
      chat_instance: "chat-instance",
      data,
      message: {
        message_id: updateId,
        date: 1,
        chat: { id: 123, type: "private", first_name: "Imam" },
        text: "pesan bertombol",
      },
    },
  };
}

interface TelegramCall {
  method: string;
  payload: unknown;
}

function installFakeTelegram(
  bot: ReturnType<typeof createBot>,
  sent: string[],
  calls: TelegramCall[] = [],
  failSend?: (text: string) => boolean,
): void {
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Harvy",
    username: "harvy_test_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  bot.api.config.use((async (_previous, method, payload) => {
    calls.push({ method, payload });
    if (method === "sendMessage") {
      const body = payload as { chat_id: number; text: string };
      if (failSend?.(body.text)) throw new Error("Telegram gagal");
      sent.push(body.text);
      return {
        ok: true,
        result: {
          message_id: sent.length,
          date: 1,
          chat: { id: body.chat_id, type: "private" },
          text: body.text,
        },
      };
    }
    return { ok: true, result: true };
  }) as Parameters<typeof bot.api.config.use>[0]);
}

function basicHarness(
  conversation: Conversation,
  tasks: TaskService = {} as TaskService,
  overrides: {
    memories?: MemoryService;
    profiles?: ProfileService;
    sessions?: SessionService;
    dataControls?: DataControlService;
    telemetry?: TelemetryService;
    agentRuns?: AgentRunService;
    telegramCalls?: TelegramCall[];
    failSend?: (text: string) => boolean;
  } = {},
): {
  bot: ReturnType<typeof createBot>;
  sent: string[];
  turns: ConversationTurn[];
  telegramCalls: TelegramCall[];
} {
  const sent: string[] = [];
  const turns: ConversationTurn[] = [];
  const telegramCalls = overrides.telegramCalls ?? [];
  const bot = createBot(
    config(),
    tasks,
    conversation,
    overrides.memories ?? {
      relevantTo: async () => [],
      markUsed: async () => undefined,
    } as unknown as MemoryService,
    {
      context: async () => ({ summary: null, turns: [...turns] }),
      append: async (_ownerId: string, role: "user" | "harvy", text: string) => {
        turns.push({ role, text, at: new Date().toISOString() });
      },
      compact: async () => undefined,
      allow: () => undefined,
      suspend: () => undefined,
    } as unknown as HistoryService,
    overrides.profiles ?? profiles(),
    {
      record: async () => undefined,
    } as unknown as InsightService,
    overrides.sessions ?? {
      active: async () => null,
    } as unknown as SessionService,
    overrides.dataControls ?? ({} as DataControlService),
    overrides.telemetry ?? {
      event: async () => undefined,
      drain: async () => undefined,
    } as unknown as TelemetryService,
    undefined,
    overrides.agentRuns,
  );
  installFakeTelegram(bot, sent, telegramCalls, overrides.failSend);
  return { bot, sent, turns, telegramCalls };
}

function understanding(
  overrides: Partial<Awaited<ReturnType<Conversation["understand"]>>> = {},
) {
  return {
    intent: "smalltalk" as const,
    taskAction: null,
    memoryAction: null,
    controlAction: null,
    safetySensitive: false,
    needsStepByStep: false,
    sessionSignal: null,
    suggestedActions: [],
    actionGoal: null,
    task: null,
    memories: [],
    ...overrides,
  };
}

function findCallback(
  calls: TelegramCall[],
  prefix: string,
): string | null {
  for (const call of calls) {
    if (call.method !== "sendMessage") continue;
    const keyboard = (
      call.payload as {
        reply_markup?: {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        };
      }
    ).reply_markup?.inline_keyboard;
    for (const row of keyboard ?? []) {
      for (const button of row) {
        if (button.callback_data?.startsWith(prefix)) {
          return button.callback_data;
        }
      }
    }
  }
  return null;
}

function findCallbacks(
  calls: TelegramCall[],
  prefix: string,
): string[] {
  const callbacks: string[] = [];
  for (const call of calls) {
    if (call.method !== "sendMessage") continue;
    const keyboard = (
      call.payload as {
        reply_markup?: {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        };
      }
    ).reply_markup?.inline_keyboard;
    for (const row of keyboard ?? []) {
      for (const button of row) {
        if (button.callback_data?.startsWith(prefix)) {
          callbacks.push(button.callback_data);
        }
      }
    }
  }
  return callbacks;
}

function memoryItem(id: string, content: string): MemoryItem {
  return {
    id,
    ownerId: "123",
    kind: "preference",
    content,
    createdAt: "2026-07-28T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };
}

function activeTutor(): ActiveSession {
  return {
    id: "session-1",
    ownerId: "123",
    chatId: "123",
    kind: "tutor",
    goal: "Memahami matematika",
    stage: "attempt",
    taskId: null,
    checkIn: null,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    expiresAt: "2026-08-04T00:00:00.000Z",
  };
}

function taskFrom(input: NewTask): StudentTask {
  return {
    id: "task-1",
    ownerId: input.ownerId,
    chatId: input.chatId,
    title: input.title,
    dueAt: input.dueAt?.toISOString() ?? null,
    importance: input.importance,
    status: "active",
    createdAt: "2026-07-28T00:00:00.000Z",
    completedAt: null,
    reminderAt: input.remindAt?.toISOString() ?? null,
    reminderSentAt: null,
  };
}
