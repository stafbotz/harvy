import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Update } from "grammy/types";
import {
  CALM_TRIAGE,
  DANGER_FALLBACK_REPLY,
  URGENT_ACKNOWLEDGEMENT,
} from "../src/ai/safety.js";
import type { HarvyContext } from "../src/ai/context.js";
import type {
  Conversation,
  ConversationRuntime,
} from "../src/ai/conversation.js";
import type { RoutingAssessment } from "../src/ai/model-policy.js";
import { createBot } from "../src/bot/create-bot.js";
import { PRE_CONSENT_SAFETY } from "../src/bot/onboarding.js";
import type { AppConfig } from "../src/config.js";
import type { DataControlService } from "../src/core/data-control-service.js";
import type { EconomyService } from "../src/core/economy-service.js";
import { AgentRunService } from "../src/core/agent-run-service.js";
import type { HistoryService } from "../src/core/history-service.js";
import type { InsightService } from "../src/core/insight-service.js";
import type { MemoryService } from "../src/core/memory-service.js";
import type { MemoryContextCompiler } from "../src/core/memory-context-compiler.js";
import {
  CONSENT_VERSION,
  ProfileService,
} from "../src/core/profile-service.js";
import type { SessionService } from "../src/core/session-service.js";
import type { TaskService } from "../src/core/task-service.js";
import type { TelemetryService } from "../src/core/telemetry-service.js";
import type {
  UserUsageSummary,
  UserUsageSummaryService,
} from "../src/core/user-usage-summary-service.js";
import type { ConversationTurn } from "../src/domain/history.js";
import type {
  AgentRunRepository,
  DurableAgentRun,
} from "../src/domain/agent-run.js";
import type { MemoryItem, NewMemory } from "../src/domain/memory.js";
import type {
  ProfileRepository,
  UserProfile,
} from "../src/domain/profile.js";
import type { ActiveSession } from "../src/domain/session.js";
import type { NewTask, StudentTask } from "../src/domain/task.js";
import type {
  SemanticDomain,
  SemanticExplicitness,
  SemanticOperation,
  SemanticOperationName,
  SemanticReference,
} from "../src/domain/semantic-operation.js";
import type { AgentRunCheckpoint } from "../src/harness/agent-harness.js";
import { privateAgentScope, scopeKey } from "../src/harness/scope.js";
import { FileAgentRunRepository } from "../src/storage/file-agent-run-repository.js";

describe("alur adapter Telegram", () => {
  it("memakai presentation model bersama untuk empty state Telegram", async () => {
    let seenChannel: ConversationRuntime["channel"];
    let seenKind = "";
    const presentOperation: Conversation["presentOperation"] = async (
      brief,
      _context,
      _style,
      runtime,
    ) => {
      seenChannel = runtime?.channel;
      seenKind = brief.kind;
      return `Aku sudah melihat keadaan daftarmu.\n\n${brief.stableBody}`;
    };
    const harness = basicHarness(
      {
        presentOperation,
      } as unknown as Conversation,
      {
        listActive: async () => [],
      } as unknown as TaskService,
    );

    await harness.bot.handleUpdate(commandUpdate("/tugas", 1));
    await harness.bot.drainPending();

    assert.equal(seenChannel, "telegram");
    assert.equal(seenKind, "empty-state");
    assert.equal(
      harness.sent.at(-1),
      "Aku sudah melihat keadaan daftarmu.\n\nTugas aktif: tidak ada.",
    );
  });

  it("mengubah zona waktu dari bahasa natural ketika extractor kehilangan semantic operation", async () => {
    let currentProfile = profile();
    let understandCalls = 0;
    let setTimeZoneCalls = 0;
    const profileService = {
      needsOnboarding: async () => false,
      load: async () => currentProfile,
      setTimeZone: async (_ownerId: string, timeZone: string) => {
        setTimeZoneCalls += 1;
        currentProfile = { ...currentProfile, timeZone };
        return currentProfile;
      },
    } as unknown as ProfileService;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => {
          understandCalls += 1;
          return understanding({
            intent: "control",
            controlAction: "timezone",
            semanticOperation: null,
          });
        },
        triageRisk: async () => CALM_TRIAGE,
      } as unknown as Conversation,
      {} as TaskService,
      { profiles: profileService },
    );

    await harness.bot.handleUpdate(
      messageUpdate("ubah zona waktuku ke WITA", 1),
    );
    await harness.bot.drainPending();

    assert.equal(
      currentProfile.timeZone,
      "Asia/Makassar",
    );
    assert.equal(understandCalls, 1);
    assert.equal(setTimeZoneCalls, 1);
    assert.match(harness.sent.at(-1) ?? "", /Zona waktu tersimpan/iu);
  });

  it("menyatukan /memori, pertanyaan natural, dan Data & izin pada satu potret", async () => {
    const memory = memoryItem("memory-portrait", "Sekarang kelas 12");
    let portraitCalls = 0;
    let compilerCalls = 0;
    let portraitCompilerCalls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "memory",
          memoryAction: "list",
          semanticOperation: semanticOperation(
            "memory",
            "list",
            "apa yang kamu ingat tentang aku?",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        memoryPortrait: async (context: HarvyContext) => {
          portraitCalls += 1;
          assert.ok(context.memories.some((item) => item.id === memory.id));
          return "Kamu sekarang kelas 12 dan lebih nyaman dengan penjelasan sederhana.";
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          list: async () => [memory],
          relevantTo: async () => [memory],
          markUsed: async () => undefined,
        } as unknown as MemoryService,
        memoryContextCompiler: {
          compilePrivate: async (
            _ownerId: string,
            request: string,
            context: HarvyContext,
          ) => {
            compilerCalls += 1;
            if (/profilku.*preferensi.*hubungan/iu.test(request)) {
              portraitCompilerCalls += 1;
            }
            return {
              context,
              plan: {} as never,
              manifest: {
                selectedCount: 1,
                selectedCharacters: memory.content.length,
                failedRouteCount: 0,
              },
            };
          },
        } as unknown as MemoryContextCompiler,
      },
    );

    await harness.bot.handleUpdate(commandUpdate("/memori", 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(callbackUpdate("control:memories", 2));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(
      messageUpdate("apa yang kamu ingat tentang aku?", 3),
    );
    await harness.bot.drainPending();

    const portraits = harness.sent.filter((text) =>
      text.startsWith("Yang aku ingat tentang kamu\n\n"));
    assert.equal(portraits.length, 3);
    assert.equal(new Set(portraits).size, 1);
    assert.equal(portraitCalls, 3);
    assert.ok(compilerCalls >= 3);
    assert.equal(portraitCompilerCalls, 3);
    assert.equal(findCallbacks(harness.telegramCalls, "memchange:").length, 3);
    assert.equal(findCallbacks(harness.telegramCalls, "memedit:").length, 0);
    assert.equal(findCallbacks(harness.telegramCalls, "memforget:").length, 0);
    assert.doesNotMatch(portraits[0] ?? "", /• .* — /u);
  });

  it("menampilkan empty state tanpa tombol Ubah bila belum ada yang berarti", async () => {
    let portraitCalls = 0;
    const harness = basicHarness(
      {
        memoryPortrait: async () => {
          portraitCalls += 1;
          return "tidak boleh dipanggil";
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          list: async () => [],
          relevantTo: async () => [],
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(commandUpdate("/memori", 1));
    await harness.bot.drainPending();

    assert.equal(portraitCalls, 0);
    assert.match(harness.sent.at(-1) ?? "", /Belum banyak/iu);
    assert.equal(findCallbacks(harness.telegramCalls, "memchange:").length, 0);
  });

  it("membuka Ubah sebagai percakapan biasa tanpa meminta ID atau membuat mode", async () => {
    let understood = "";
    const memory = memoryItem("memory-change", "Sedang mempertimbangkan ITB");
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async (message: string) => {
          understood = message;
          return understanding();
        },
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "Oke, ceritakan bagian yang sekarang lebih pas.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          list: async () => [memory],
          relevantTo: async () => [memory],
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(callbackUpdate("memchange:", 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(
      messageUpdate("bagian kuliah itu kayaknya nggak pas", 2),
    );
    await harness.bot.drainPending();

    assert.ok(harness.sent.includes(
      "Ada yang salah atau udah berubah? Bilang aja. Kamu juga bisa minta aku melupakan sesuatu.",
    ));
    assert.equal(understood, "bagian kuliah itu kayaknya nggak pas");
    assert.equal(harness.sent.some((text) => /ID memori|nomor item/iu.test(text)), false);
  });

  it("melupakan topik natural melalui cascade MemoryService, bukan edit atau delete mentah", async () => {
    const sohit = memoryItem("memory-sohit", "Sohit adalah pacarku");
    const school = memoryItem("memory-school", "Sekarang kelas 12");
    const forgotten: string[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "memory",
          memoryAction: "forget",
          memoryTarget: "Sohit",
          semanticOperation: semanticOperation(
            "memory",
            "forget",
            "lupain semua yang kamu tahu soal Sohit",
            "Sohit",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          list: async () => [sohit, school],
          relevantTo: async () => [sohit],
          forget: async (_ownerId: string, id: string) => {
            forgotten.push(id);
            return id === sohit.id ? sohit : null;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("lupain semua yang kamu tahu soal Sohit"),
    );
    await harness.bot.drainPending();

    assert.deepEqual(forgotten, [sohit.id]);
    assert.match(harness.sent.at(-1) ?? "", /soal Sohit.*sudah aku lupakan/iu);
  });

  it("tetap meminta konfirmasi untuk permintaan natural menghapus semua ingatan", async () => {
    let wipes = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "memory",
          memoryAction: "forget",
          memoryTarget: "semua ingatan tentang aku",
          semanticOperation: semanticOperation(
            "memory",
            "forget",
            "hapus semua ingatanmu tentang aku",
            null,
            "explicit",
            "all",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
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
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("hapus semua ingatanmu tentang aku"),
    );
    await harness.bot.drainPending();

    assert.equal(wipes, 0);
    assert.match(harness.sent.at(-1) ?? "", /mulai mengenal lagi/iu);
    assert.ok(findCallback(harness.telegramCalls, "memallyes:"));
  });

  it("menyimpan explicit personal memory tanpa consent kedua dan memantulkannya di /memori", async () => {
    const stored: MemoryItem[] = [];
    const inputs: NewMemory[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [{ kind: "personal", content: "Sangat mencintai Sohit" }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "harvy inget aku cintaaa banget sama sohit",
            "aku cintaaa banget sama sohit",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () =>
          "Aku bakal inget kok kalau kamu cinta banget sama Sohit.",
        memoryPortrait: async (context: HarvyContext) => {
          assert.equal(context.memories[0]?.content, "Sangat mencintai Sohit");
          return "Kamu sangat mencintai Sohit.";
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          list: async () => [...stored],
          remember: async (input: NewMemory) => {
            inputs.push(input);
            const item = memoryItem("explicit-love", input.content);
            item.kind = input.kind;
            stored.push(item);
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("harvy inget aku cintaaa banget sama sohit", 1),
    );
    await harness.bot.drainPending();

    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.kind, "personal");
    assert.equal(inputs[0]?.sensitiveConsent, true);
    assert.equal(inputs[0]?.sensitivity, "personal");
    assert.equal(stored.length, 1);
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
    assert.equal(findCallbacks(harness.telegramCalls, "memskip:").length, 0);
    assert.equal(harness.sent.some((text) => /Boleh aku inget/iu.test(text)), false);
    assert.equal(
      harness.sent.filter((text) => /(?:ingat|inget)/iu.test(text)).length,
      1,
    );
    assert.doesNotMatch(harness.sent.at(-1) ?? "", /[📍💭]/u);

    await harness.bot.handleUpdate(commandUpdate("/memori", 2));
    await harness.bot.drainPending();
    assert.match(harness.sent.at(-1) ?? "", /Kamu sangat mencintai Sohit/iu);
  });

  it("membiarkan acknowledgement kontekstual memakai 📍 tanpa note kedua", async () => {
    const inputs: NewMemory[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [{
            kind: "preference",
            content: "Lebih nyaman belajar pagi",
          }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "inget ya aku lebih nyaman belajar pagi",
            "aku lebih nyaman belajar pagi",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async (
          _text: string,
          _understanding: unknown,
          _context: unknown,
          _style: unknown,
          _triage: unknown,
          _insight: unknown,
          _raiseHelp: unknown,
          runtime: ConversationRuntime,
        ) => {
          assert.deepEqual(runtime.memoryAcknowledgements, [{
            operation: "saved",
            content: "Lebih nyaman belajar pagi",
            explicit: true,
          }]);
          return "Oke, aku inget kamu lebih nyaman belajar pagi 📍";
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async (input: NewMemory) => {
            inputs.push(input);
            const item = memoryItem("morning-pref", input.content);
            item.kind = input.kind;
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("inget ya aku lebih nyaman belajar pagi"),
    );
    await harness.bot.drainPending();

    assert.equal(inputs.length, 1);
    assert.equal((harness.sent.at(-1)?.match(/📍/gu) ?? []).length, 1);
    assert.equal(
      (harness.sent.at(-1)?.match(/(?:ingat|inget)/giu) ?? []).length,
      1,
    );
    assert.doesNotMatch(harness.sent.at(-1) ?? "", /💭/u);
  });

  it("menyimpan correction implisit setelah onboarding tanpa izin kedua", async () => {
    const inputs: NewMemory[] = [];
    const naturalReply =
      "Ohh, berarti aku salah nangkep sebelumnya. Yang benar kamu lebih produktif pagi.";
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memories: [{
            kind: "preference",
            content: "Lebih produktif pagi",
          }],
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async (
          _text: string,
          _understanding: unknown,
          _context: unknown,
          _style: unknown,
          _triage: unknown,
          _insight: unknown,
          _raiseHelp: unknown,
          runtime: ConversationRuntime,
        ) => {
          assert.deepEqual(runtime.memoryAcknowledgements, [{
            operation: "updated",
            content: "Lebih produktif pagi",
            explicit: false,
          }]);
          return naturalReply;
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async (input: NewMemory) => {
            inputs.push(input);
            const item = memoryItem("morning-correction", input.content);
            item.kind = input.kind;
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("sebenarnya aku lebih produktif pagi, bukan malam"),
    );
    await harness.bot.drainPending();

    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.correction, true);
    assert.ok(harness.sent.join("\n").includes(naturalReply));
    assert.match(harness.sent.at(-1) ?? "", /sudah aku perbarui|📍/iu);
    assert.doesNotMatch(harness.sent.join("\n"), /Boleh aku inget|💭/iu);
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
    assert.equal(findCallbacks(harness.telegramCalls, "memdrop:").length, 0);
  });

  it("tidak membiarkan 💭 menjadi penanda save baru", async () => {
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [{ kind: "profile", content: "Panggil aku Hafizh" }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "ingat ya panggil aku Hafizh",
            "panggil aku Hafizh",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "💭 Aku simpan yang ini.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async (input: NewMemory) => {
            const item = memoryItem("nickname", input.content);
            item.kind = input.kind;
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("ingat ya panggil aku Hafizh"));
    await harness.bot.drainPending();

    assert.equal(harness.sent.at(-1), "📍 Aku simpan yang ini.");
    assert.doesNotMatch(harness.sent.at(-1) ?? "", /💭/u);
  });

  it("menyimpan kandidat implisit dan memakai acknowledgment model yang natural", async () => {
    const inputs: NewMemory[] = [];
    const naturalReply =
      "Oke, dua hal itu aku inget biar nanti kamu nggak perlu ngulang.";
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memories: [
            { kind: "profile", content: "Nama panggilan Hafizh" },
            { kind: "preference", content: "Lebih nyaman belajar pagi" },
          ],
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => naturalReply,
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async (input: NewMemory) => {
            inputs.push(input);
            const item = memoryItem(`multi-${inputs.length}`, input.content);
            item.kind = input.kind;
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("panggil aku Hafizh, aku juga lebih nyaman belajar pagi"),
    );
    await harness.bot.drainPending();

    assert.equal(inputs.length, 2);
    assert.equal(harness.sent.at(-1), naturalReply);
    assert.doesNotMatch(
      harness.sent.join("\n"),
      /Boleh aku inget|SIMPAN MEMORI|JANGAN SIMPAN|[📍💭]/iu,
    );
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
    assert.equal(findCallbacks(harness.telegramCalls, "memdrop:").length, 0);
  });

  it("menyimpan instruksi bentuk jawaban tanpa consent kedua atau kandidat duplikat", async () => {
    const saved: NewMemory[] = [];
    const message =
      "Mulai sekarang, aku lebih suka semua jawaban memakai langkah pendek dan bernomor.";
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        // Parafrasa model tidak menjadi write kedua. Boundary raw-turn lokal
        // membentuk satu canonical preference dan authority item-scoped.
        understand: async () => understanding({
          intent: "memory",
          memoryAction: "remember",
          memories: [{
            kind: "preference",
            content: "Lebih menyukai seluruh jawaban dalam langkah singkat bernomor.",
          }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            message,
            "semua jawaban memakai langkah pendek dan bernomor",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "Oke, aku akan menjawab lebih terstruktur.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async (input: NewMemory) => {
            saved.push(input);
            const item = memoryItem("explicit-response-style", input.content);
            item.kind = input.kind;
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate(message));
    await harness.bot.drainPending();

    assert.equal(saved.length, 1);
    assert.equal(
      saved[0]?.content,
      "Lebih suka semua jawaban memakai langkah pendek dan bernomor.",
    );
    assert.doesNotMatch(harness.sent.join("\n"), /Boleh aku inget/iu);
    assert.equal(findCallback(harness.telegramCalls, "memsave:"), null);
    assert.match(harness.sent.at(-1) ?? "", /ingat|simpan|ke depan/iu);
  });

  it("permintaan langkah kecil mengalahkan task offer dan pelanggaran pertanyaan model", async () => {
    const message =
      "Aku kewalahan dengan audit acceptance. Bantu aku mulai satu langkah kecil.";
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "feeling",
          taskAction: "offer",
          needsStepByStep: true,
          suggestedActions: ["start_small", "plan"],
          actionGoal: "Mulai satu langkah kecil untuk audit acceptance",
          routingAssessment: routingAssessment({
            ambiguity: "medium",
            planningRequired: true,
            emotionalNuance: "high",
            executionSize: "small",
          }),
          task: {
            title: "Audit acceptance",
            dueAt: null,
            remindAt: null,
            importance: 2,
          },
        }),
        triageRisk: async () => CALM_TRIAGE,
        // Pertanyaan ini melanggar arahan planned-action. Tombol yang diminta
        // eksplisit tetap tidak boleh hilang karenanya.
        reply: async () => "Kita bisa mengecilkannya. Kamu siap mulai?",
        agent: async () => {
          throw new Error("interaksi terpandu ringan tidak boleh menjadi agent");
        },
      } as unknown as Conversation,
    );

    await harness.bot.handleUpdate(messageUpdate(message));
    await harness.bot.drainPending();

    const flow = findCallback(harness.telegramCalls, "flow:");
    assert.ok(flow?.endsWith(".start_small"));
    assert.equal(findCallbacks(harness.telegramCalls, "save:").length, 0);
    assert.doesNotMatch(harness.sent.join("\n"), /Mau aku catat/iu);
  });

  it("membolehkan recall lama dengan atau tanpa 💭 tanpa membuat memory baru", async () => {
    for (const recalledReply of [
      "💭 Aku masih inget dulu kamu sempat mempertimbangkan UI.",
      "Aku masih inget dulu kamu sempat mempertimbangkan UI.",
    ]) {
      let saves = 0;
      const harness = basicHarness(
        {
          classifyTurnBoundary: async () => "complete",
          understand: async () => understanding({
            intent: "history",
            memories: [],
          }),
          triageRisk: async () => CALM_TRIAGE,
          reply: async () => recalledReply,
        } as unknown as Conversation,
        {} as TaskService,
        {
          memories: {
            relevantTo: async () => [
              memoryItem("college-memory", "Pernah mempertimbangkan UI"),
            ],
            remember: async () => {
              saves += 1;
              return null;
            },
            markUsed: async () => undefined,
          } as unknown as MemoryService,
        },
      );

      await harness.bot.handleUpdate(messageUpdate("aku bingung pilih kampus lagi"));
      await harness.bot.drainPending();

      assert.equal(saves, 0, recalledReply);
      assert.equal(harness.sent.at(-1), recalledReply);
      assert.doesNotMatch(harness.sent.at(-1) ?? "", /📍/u);
    }
  });

  it("menyimpan explicit relationship dengan metadata derivation normal", async () => {
    const inputs: NewMemory[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [{ kind: "personal", content: "Sohit adalah pacarku" }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "inget ya Sohit pacarku",
            "Sohit pacarku",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "Oke.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async (input: NewMemory) => {
            inputs.push(input);
            const item = memoryItem("explicit-partner", input.content);
            item.kind = input.kind;
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("inget ya Sohit pacarku"));
    await harness.bot.drainPending();

    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.sensitiveConsent, true);
    assert.equal(inputs[0]?.predicate, "romantic_partner");
    assert.equal(inputs[0]?.value, "Sohit");
    assert.equal(inputs[0]?.graphProjection?.relation, "partner_of");
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
    assert.match(harness.sent.at(-1) ?? "", /yang ini aku ingat untuk ke depan.*📍/iu);
    assert.doesNotMatch(harness.sent.at(-1) ?? "", /(?:💭|Sohit adalah pacarku)/iu);
  });

  it("menyimpan personal memory otomatis setelah consent onboarding", async () => {
    const inputs: NewMemory[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memories: [{ kind: "personal", content: "Sohit adalah pacarku" }],
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "Aku dengar ceritamu.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async (input: NewMemory) => {
            inputs.push(input);
            const item = memoryItem("implicit-partner", input.content);
            item.kind = input.kind;
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("Sohit pacarku"));
    await harness.bot.drainPending();

    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.sensitiveConsent, true);
    assert.match(harness.sent.at(-1) ?? "", /ingat untuk ke depan|📍/iu);
    assert.doesNotMatch(
      harness.sent.at(-1) ?? "",
      /Boleh aku (?:menyimpan|inget)|SIMPAN MEMORI|JANGAN SIMPAN/iu,
    );
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
    assert.equal(findCallbacks(harness.telegramCalls, "memskip:").length, 0);
    assert.equal(findCallbacks(harness.telegramCalls, "memdrop:").length, 0);
  });

  it("menyimpan explicit sensitive non-credential tanpa consent kedua", async () => {
    const inputs: NewMemory[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [{ kind: "personal", content: "Memiliki alergi kacang" }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "catat ya aku punya alergi kacang",
            "aku punya alergi kacang",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "Oke, aku paham.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async (input: NewMemory) => {
            inputs.push(input);
            const item = memoryItem("explicit-health", input.content);
            item.kind = input.kind;
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("catat ya aku punya alergi kacang"),
    );
    await harness.bot.drainPending();

    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]?.sensitiveConsent, true);
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
    assert.match(harness.sent.at(-1) ?? "", /yang ini aku ingat untuk ke depan.*📍/iu);
    assert.doesNotMatch(harness.sent.at(-1) ?? "", /💭/u);
  });

  it("tidak mempercayai sinyal remember model tanpa perintah write lokal", async () => {
    for (const text of [
      "jangan ingat kalau Sohit pacarku",
      "kamu inget gak Sohit itu siapa?",
      "ingetin aku belajar jam 7",
    ]) {
      let saves = 0;
      const harness = basicHarness(
        {
          classifyTurnBoundary: async () => "complete",
          understand: async () => understanding({
            memoryAction: "remember",
            memories: [{ kind: "personal", content: "Sohit adalah pacarku" }],
          }),
          triageRisk: async () => CALM_TRIAGE,
          reply: async () => "Aku bakal simpan yang itu.",
        } as unknown as Conversation,
        {} as TaskService,
        {
          memories: {
            relevantTo: async () => [],
            remember: async () => {
              saves += 1;
              return null;
            },
            markUsed: async () => undefined,
          } as unknown as MemoryService,
        },
      );

      await harness.bot.handleUpdate(messageUpdate(text));
      await harness.bot.drainPending();

      assert.equal(saves, 0, text);
      assert.equal(
        findCallbacks(harness.telegramCalls, "memsave:").length,
        0,
        text,
      );
      assert.doesNotMatch(
        harness.sent.at(-1) ?? "",
        /bakal simpan|sudah tersimpan|📍/iu,
        text,
      );
    }
  });

  it("menyimpan kandidat lain dalam turn dari authority onboarding privat", async () => {
    const inputs: NewMemory[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [
            { kind: "personal", content: "Sohit adalah pacarku" },
            { kind: "personal", content: "Baru pulang dari rumah sakit" },
          ],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "inget ya Sohit pacarku, btw tadi aku habis dari rumah sakit",
            "Sohit pacarku",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "Oke.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async (input: NewMemory) => {
            inputs.push(input);
            const item = memoryItem(`scoped-memory-${inputs.length}`, input.content);
            item.kind = input.kind;
            return item;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate(
        "inget ya Sohit pacarku, btw tadi aku habis dari rumah sakit",
      ),
    );
    await harness.bot.drainPending();

    assert.deepEqual(inputs.map((input) => input.content), [
      "Sohit adalah pacarku",
      "Baru pulang dari rumah sakit",
    ]);
    assert.equal(inputs[0]?.sensitiveConsent, true);
    assert.equal(inputs[1]?.sensitiveConsent, true);
    assert.match(harness.sent.at(-1) ?? "", /beberapa hal penting|📍/iu);
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
    assert.equal(findCallbacks(harness.telegramCalls, "memskip:").length, 0);
    assert.equal(findCallbacks(harness.telegramCalls, "memdrop:").length, 0);
  });

  it("menolak secret meski user meminta explicit remember", async () => {
    let saves = 0;
    let replyCalls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [{
            kind: "personal",
            content: "Password email adalah CONTOH_SANDI_123",
          }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "ingat password emailku adalah CONTOH_SANDI_123",
            "password emailku adalah CONTOH_SANDI_123",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => {
          replyCalls += 1;
          return "akan kusimpan";
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async () => {
            saves += 1;
            return null;
          },
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("ingat password emailku adalah CONTOH_SANDI_123"),
    );
    await harness.bot.drainPending();

    assert.equal(saves, 0);
    assert.equal(replyCalls, 0);
    assert.match(harness.sent.at(-1) ?? "", /nggak akan menyimpan password/iu);
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
  });

  it("mengakui duplicate explicit request tanpa menulis atau meminta izin lagi", async () => {
    const existing = memoryItem("known-love", "Sangat mencintai Sohit");
    existing.kind = "personal";
    let attempts = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [{ kind: "personal", content: existing.content }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "inget ya aku cinta banget sama Sohit",
            "aku cinta banget sama Sohit",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "Oke.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async () => {
            attempts += 1;
            return null;
          },
          list: async () => [existing],
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("inget ya aku cinta banget sama Sohit"),
    );
    await harness.bot.drainPending();

    assert.equal(attempts, 1);
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
    assert.match(harness.sent.at(-1) ?? "", /yang itu masih aku ingat/iu);
    assert.doesNotMatch(harness.sent.at(-1) ?? "", /(?:📍|💭|Sangat mencintai Sohit)/iu);
  });

  it("tidak mengaku ingat bila primary write explicit gagal", async () => {
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [{ kind: "personal", content: "Sohit adalah pacarku" }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "ingat ya Sohit pacarku",
            "Sohit pacarku",
          ),
        }),
        triageRisk: async () => CALM_TRIAGE,
        reply: async () => "Aku bakal inget kalau Sohit pacarmu.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async () => null,
          list: async () => [],
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("ingat ya Sohit pacarku"));
    await harness.bot.drainPending();

    assert.match(harness.sent.at(-1) ?? "", /belum bisa menyimpan/iu);
    assert.doesNotMatch(harness.sent.at(-1) ?? "", /bakal inget/iu);
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
  });

  it("menolak /memori di grup dan mengarahkannya ke chat privat", async () => {
    const harness = basicHarness({} as Conversation);

    await harness.bot.handleUpdate(groupCommandUpdate("/memori", 1));
    await harness.bot.drainPending();

    assert.match(harness.sent.at(-1) ?? "", /khusus chat pribadi/iu);
  });

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
        beginTurn: async () => undefined,
        event: async () => undefined,
        noteTurnSignal: async () => undefined,
        recordTurn: async () => undefined,
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
        beginTurn: async () => undefined,
        noteTurnSignal: async () => undefined,
        recordTurn: async () => undefined,
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

  it("mengirim safety pre-consent lokal tanpa menunggu provider", async () => {
    const sent: string[] = [];
    let triageCalls = 0;
    const bot = createBot(
      config(),
      {} as TaskService,
      {
        triageRisk: async () => {
          triageCalls += 1;
          await new Promise<void>(() => undefined);
          return CALM_TRIAGE;
        },
      } as unknown as Conversation,
      {} as MemoryService,
      {} as HistoryService,
      { needsOnboarding: async () => true } as unknown as ProfileService,
      {} as InsightService,
      {} as SessionService,
      {} as DataControlService,
      {
        beginTurn: async () => undefined,
        noteTurnSignal: async () => undefined,
        recordTurn: async () => undefined,
        drain: async () => undefined,
      } as unknown as TelemetryService,
    );
    installFakeTelegram(bot, sent);

    await bot.handleUpdate(messageUpdate("aku mau menyakiti diri sekarang"));
    await bot.drainPending();

    assert.equal(triageCalls, 0);
    assert.ok(sent.includes(PRE_CONSENT_SAFETY));
  });

  it("/menu sebelum consent membuka onboarding tanpa diputar ulang sesudahnya", async () => {
    let consented = false;
    let modelCalls = 0;
    const forbidden = (): never => {
      modelCalls += 1;
      throw new Error("navigasi onboarding tidak boleh memakai model");
    };
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => forbidden(),
        triageRisk: async () => forbidden(),
        understand: async () => forbidden(),
        reply: async () => forbidden(),
      } as unknown as Conversation,
      {} as TaskService,
      {
        profiles: {
          needsOnboarding: async () => !consented,
          acceptConsent: async () => {
            consented = true;
            return profile();
          },
          load: async () => profile(),
        } as unknown as ProfileService,
        telemetry: {
          allow: async () => undefined,
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async () => undefined,
          recordTurn: async () => undefined,
          drain: async () => undefined,
        } as unknown as TelemetryService,
      },
    );

    await harness.bot.handleUpdate(commandUpdate("/menu", 1));
    await harness.bot.drainPending();
    assert.equal(harness.sent[0], "👋");
    assert.equal(harness.sent.some((text) => /^Menu Harvy/u.test(text)), false);

    await harness.bot.handleUpdate(callbackUpdate("consent:yes", 2));
    await harness.bot.drainPending();
    assert.equal(consented, true);
    assert.ok(harness.sent.includes("😉"));
    assert.equal(harness.sent.some((text) => /^Menu Harvy/u.test(text)), false);

    await harness.bot.handleUpdate(commandUpdate("/menu", 3));
    await harness.bot.drainPending();
    assert.equal(
      harness.sent.filter((text) => /^Menu Harvy/u.test(text)).length,
      1,
    );
    assert.equal(modelCalls, 0);
  });

  it("menahan pesan pengguna consent sebelumnya sampai menyetujui versi aktif", async () => {
    const sent: string[] = [];
    let triageCalls = 0;
    let fullProcessingCalls = 0;
    let stored = profile({ consentVersion: CONSENT_VERSION - 1 });
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
        beginTurn: async () => undefined,
        noteTurnSignal: async () => undefined,
        recordTurn: async () => undefined,
        drain: async () => undefined,
      } as unknown as TelemetryService,
    );
    installFakeTelegram(bot, sent);

    await bot.handleUpdate(messageUpdate("pesan setelah consent lama"));
    await bot.drainPending();

    assert.equal(triageCalls, 1);
    assert.equal(fullProcessingCalls, 0);
    assert.equal(stored.consentVersion, CONSENT_VERSION - 1);
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

  it("triage unavailable dengan hint lemah tidak memblokir task aman", async () => {
    let creates = 0;
    let reviews = 0;
    let triageCalls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => ({
          intent: "task",
          taskAction: "save",
          memoryAction: null,
          controlAction: null,
          riskHint: {
            level: "possible",
            category: "acute_distress",
            confidence: 0.45,
          },
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
          semanticOperation: semanticOperation(
            "task",
            "save",
            "tolong catat kumpulkan matematika",
            "kumpulkan matematika",
          ),
        }),
        triageRisk: async () => {
          triageCalls += 1;
          return null;
        },
        reply: async () => "Oke, aku catat tugasnya.",
        reviewReply: async () => {
          reviews += 1;
          return true;
        },
      } as unknown as Conversation,
      {
        create: async (input: NewTask) => {
          creates += 1;
          return taskFrom(input);
        },
      } as unknown as TaskService,
    );

    await harness.bot.handleUpdate(
      messageUpdate("tolong catat kumpulkan matematika"),
    );
    await harness.bot.drainPending();

    assert.equal(triageCalls, 1);
    assert.equal(creates, 1);
    assert.equal(reviews, 0);
    assert.ok(harness.sent.some((text) => text.includes("aku catat")));
  });

  it("memakai triage fallback bila compiler gagal tanpa mengarang krisis", async () => {
    let triageCalls = 0;
    let reviews = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => {
          throw new Error("compiler unavailable");
        },
        triageRisk: async () => {
          triageCalls += 1;
          return null;
        },
        reviewReply: async () => {
          reviews += 1;
          return true;
        },
      } as unknown as Conversation,
      {} as TaskService,
    );

    await harness.bot.handleUpdate(messageUpdate("tolong bantu susun tugas"));
    await harness.bot.drainPending();

    assert.equal(triageCalls, 1);
    assert.equal(reviews, 0);
    assert.ok(
      harness.sent.some((text) => text.includes("sambungan ke otakku")),
    );
  });

  it("support pasti tidak direview dan tetap mengizinkan task eksplisit", async () => {
    let creates = 0;
    let reviews = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "task",
          taskAction: "save",
          riskHint: {
            level: "possible",
            category: "acute_distress",
            confidence: 0.7,
          },
          safetySensitive: true,
          task: {
            title: "Kumpulkan matematika",
            dueAt: null,
            remindAt: null,
            importance: 2,
          },
          semanticOperation: semanticOperation(
            "task",
            "save",
            "aku kewalahan, tolong catat kumpulkan matematika",
            "kumpulkan matematika",
          ),
        }),
        triageRisk: async () => ({
          level: "dukungan",
          alone: false,
          sensitive: false,
          summary: "sedang kewalahan",
          certain: true,
        }),
        reply: async () => "Kedengarannya lagi berat. Tugasnya tetap aku catat.",
        reviewReply: async () => {
          reviews += 1;
          return true;
        },
      } as unknown as Conversation,
      {
        create: async (input: NewTask) => {
          creates += 1;
          return taskFrom(input);
        },
      } as unknown as TaskService,
    );

    await harness.bot.handleUpdate(
      messageUpdate("aku kewalahan, tolong catat kumpulkan matematika"),
    );
    await harness.bot.drainPending();

    assert.equal(creates, 1);
    assert.equal(reviews, 0);
    assert.ok(harness.sent.some((text) => text.includes("lagi berat")));
  });

  it("support tidak menahan hak ekspor data yang diminta eksplisit", async () => {
    let exports = 0;
    let replies = 0;
    let reviews = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "control",
          controlAction: "export",
          riskHint: {
            level: "possible",
            category: "acute_distress",
            confidence: 0.7,
          },
          semanticOperation: semanticOperation(
            "data",
            "export",
            "aku lagi kewalahan, ekspor dataku",
          ),
        }),
        triageRisk: async () => ({
          level: "dukungan",
          alone: false,
          sensitive: false,
          summary: "sedang kewalahan",
          certain: true,
        }),
        reply: async () => {
          replies += 1;
          return "tidak boleh dipanggil";
        },
        reviewReply: async () => {
          reviews += 1;
          return true;
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        dataControls: {
          export: async () => {
            exports += 1;
            return { ownerId: "123" };
          },
        } as unknown as DataControlService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("aku lagi kewalahan, ekspor dataku"),
    );
    await harness.bot.drainPending();

    assert.equal(exports, 1);
    assert.equal(replies, 0);
    assert.equal(reviews, 0);
    assert.ok(harness.telegramCalls.some((call) => call.method === "sendDocument"));
  });

  it("ack dingin memakai pemahaman dan balasan model, bukan tabel kata", async () => {
    let boundary = 0;
    let understandingCalls = 0;
    let triageCalls = 0;
    let replies = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => {
          boundary += 1;
          return "complete";
        },
        understand: async () => {
          understandingCalls += 1;
          return understanding();
        },
        triageRisk: async () => {
          triageCalls += 1;
          return CALM_TRIAGE;
        },
        reply: async () => {
          replies += 1;
          return "balasan model";
        },
      } as unknown as Conversation,
    );

    await harness.bot.handleUpdate(messageUpdate("makasih"));
    await harness.bot.drainPending();

    assert.equal(boundary, 0);
    assert.equal(understandingCalls, 1);
    assert.equal(triageCalls, 0);
    assert.equal(replies, 1);
    assert.ok(harness.sent.includes("balasan model"));
  });

  it("aritmetika sederhana memberi hasil exact tanpa model di Telegram", async () => {
    let understandingCalls = 0;
    let replies = 0;
    const harness = basicHarness({
      understand: async () => {
        understandingCalls += 1;
        return understanding();
      },
      reply: async () => {
        replies += 1;
        return "jangan dipakai";
      },
    } as unknown as Conversation);

    await harness.bot.handleUpdate(
      messageUpdate("kerjakan soal ini untukku: 24 dibagi 6"),
    );
    await harness.bot.drainPending();

    assert.equal(understandingCalls, 0);
    assert.equal(replies, 0);
    assert.equal(harness.sent.at(-1), "Hasilnya 4.");
  });

  it("pengingat kosong meminta detail lewat balasan model tanpa menulis task", async () => {
    let replyCalls = 0;
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      understand: async () => understanding({
        intent: "request",
        routingAssessment: routingAssessment(),
      }),
      reply: async () => {
        replyCalls += 1;
        return "Apa yang perlu kuingatkan, dan kapan waktunya?";
      },
    } as unknown as Conversation);

    await harness.bot.handleUpdate(messageUpdate("buat pengingat dong"));
    await harness.bot.drainPending();

    assert.equal(replyCalls, 1);
    assert.equal(
      harness.sent.at(-1),
      "Apa yang perlu kuingatkan, dan kapan waktunya?",
    );
  });

  it("nilai waktu pending melewati understanding dan triase umum", async () => {
    let understandingCalls = 0;
    let triageCalls = 0;
    let dueDateCalls = 0;
    let dueUpdates = 0;
    let retrievalCalls = 0;
    const dueAt = new Date("2026-08-09T19:00:00+07:00");
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => {
          understandingCalls += 1;
          return understanding();
        },
        triageRisk: async () => {
          triageCalls += 1;
          return CALM_TRIAGE;
        },
        understandDueDate: async () => {
          dueDateCalls += 1;
          return dueAt;
        },
      } as unknown as Conversation,
      {
        setDue: async (ownerId: string, taskId: string, date: Date) => {
          dueUpdates += 1;
          return {
            ...taskFrom({
              ownerId,
              chatId: "123",
              title: "Matematika",
              dueAt: date,
              remindAt: null,
              importance: 2,
            }),
            id: taskId,
            dueAt: date.toISOString(),
          };
        },
      } as unknown as TaskService,
      {
        memoryContextCompiler: {
          compilePrivate: async () => {
            retrievalCalls += 1;
            throw new Error("retrieval tidak boleh dipanggil");
          },
        } as unknown as MemoryContextCompiler,
      },
    );

    await harness.bot.handleUpdate(callbackUpdate("edit:task-1", 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(messageUpdate("besok jam 7", 2));
    await harness.bot.drainPending();

    assert.equal(understandingCalls, 0);
    assert.equal(triageCalls, 0);
    assert.equal(dueDateCalls, 1);
    assert.equal(dueUpdates, 1);
    assert.equal(retrievalCalls, 0);
    assert.ok(harness.sent.some((text) => text.includes("udah aku ubah")));
  });

  it("koreksi membatalkan mutasi tenggat pending yang sudah stale", async () => {
    const firstStarted = deferredVoid();
    const relationStarted = deferredVoid();
    const releaseFirst = deferredVoid();
    const firstDueAt = new Date("2026-08-09T19:00:00+07:00");
    const correctedDueAt = new Date("2026-08-09T20:00:00+07:00");
    const dueUpdates: Date[] = [];
    let dueDateCalls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        classifyTurnInterruption: async () => {
          relationStarted.resolve();
          return "correction";
        },
        understandDueDate: async () => {
          dueDateCalls += 1;
          if (dueDateCalls === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
            return firstDueAt;
          }
          return correctedDueAt;
        },
      } as unknown as Conversation,
      {
        setDue: async (ownerId: string, taskId: string, date: Date) => {
          dueUpdates.push(date);
          return {
            ...taskFrom({
              ownerId,
              chatId: "123",
              title: "Matematika",
              dueAt: date,
              remindAt: null,
              importance: 2,
            }),
            id: taskId,
            dueAt: date.toISOString(),
          };
        },
      } as unknown as TaskService,
      {
        histories: {
          context: async () => ({ summary: null, turns: [] }),
          append: async (
            _ownerId: string,
            role: "user" | "harvy",
            text: string,
          ) => ({
            sequence: 1,
            role,
            text,
            at: new Date().toISOString(),
          }),
          compact: async () => undefined,
          allow: () => undefined,
          suspend: () => undefined,
        } as unknown as HistoryService,
      },
    );

    await harness.bot.handleUpdate(callbackUpdate("edit:task-1", 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(messageUpdate("besok jam 7", 2));
    await firstStarted.promise;

    await harness.bot.handleUpdate(messageUpdate("jam 8", 3));
    await relationStarted.promise;
    releaseFirst.resolve();
    await harness.bot.drainPending();

    assert.equal(dueDateCalls, 2);
    assert.deepEqual(dueUpdates, [correctedDueAt]);
    assert.equal(
      harness.sent.filter((text) => text.includes("udah aku ubah")).length,
      1,
    );
  });

  it("mengikat koreksi dan graph dari giliran user sebelum memori disimpan", async () => {
    const inputs: NewMemory[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [{ kind: "profile", content: "Sekolah di SMAN Baru" }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "ingat ya, ralat, aku sudah pindah sekolah ke SMAN Baru",
            "aku sudah pindah sekolah ke SMAN Baru",
          ),
        }),
        reply: async () => "Oke, aku catat sekolahmu yang baru.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        histories: {
          context: async () => ({ summary: null, turns: [] }),
          append: async (
            _ownerId: string,
            role: "user" | "harvy",
            text: string,
          ) => ({
            sequence: role === "user" ? 41 : 42,
            role,
            text,
            at: "2026-08-10T00:00:00.000Z",
          }),
          compact: async () => undefined,
          allow: () => undefined,
          suspend: () => undefined,
        } as unknown as HistoryService,
        memories: {
          relevantTo: async () => [],
          markUsed: async () => undefined,
          remember: async (input: NewMemory) => {
            inputs.push(input);
            return {
              id: "memory-1",
              ownerId: input.ownerId,
              kind: input.kind,
              content: input.content,
              createdAt: "2026-08-10T00:00:00.000Z",
              lastUsedAt: null,
              expiresAt: null,
            };
          },
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("ingat ya, ralat, aku sudah pindah sekolah ke SMAN Baru"),
    );
    await harness.bot.drainPending();

    assert.equal(inputs.length, 1);
    assert.deepEqual(inputs[0], {
      ownerId: "123",
      kind: "profile",
      content: "Sekolah di SMAN Baru",
      sourceSequences: [41],
      subject: "user",
      predicate: "studies_at",
      value: "SMAN Baru",
      correction: true,
      provenance: "asserted",
      graphProjection: {
        from: { type: "person", canonicalName: "Pengguna" },
        relation: "studies_at",
        to: { type: "place", canonicalName: "SMAN Baru" },
      },
    });
  });

  it("memisahkan auto-memory privat dari acute-safety routing", async () => {
    let triageCalls = 0;
    let saved = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memories: [{
            kind: "preference",
            content: "Kesulitan membaca soal panjang saat ujian",
          }],
        }),
        triageRisk: async () => {
          triageCalls += 1;
          return CALM_TRIAGE;
        },
        reply: async () => "Aku paham maksudmu.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          markUsed: async () => undefined,
          remember: async (input: NewMemory) => {
            saved += 1;
            return memoryItem("reading-preference", input.content);
          },
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("aku kesulitan membaca soal panjang saat ujian"),
    );
    await harness.bot.drainPending();

    assert.equal(triageCalls, 0);
    assert.equal(saved, 1);
    assert.match(harness.sent.at(-1) ?? "", /ingat untuk ke depan|📍/iu);
    assert.doesNotMatch(harness.sent.join("\n"), /Boleh aku inget/iu);
  });

  it("memakai onboarding, bukan classifier privasi, sebagai authority privat", async () => {
    let remembers = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          memories: [{ kind: "preference", content: "Suka warna biru" }],
        }),
        reply: async () => "Aku ingat.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          markUsed: async () => undefined,
          remember: async () => {
            remembers += 1;
            return memoryItem("stale-memory", "Suka warna biru");
          },
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("warna favoritku biru", 1));
    await harness.bot.drainPending();

    assert.equal(remembers, 1);
    assert.doesNotMatch(harness.sent.at(-1) ?? "", /Boleh aku inget/iu);
    assert.equal(findCallbacks(harness.telegramCalls, "memsave:").length, 0);
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
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async () => undefined,
          recordTurn: async () => undefined,
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
    let replyFocus: unknown = "belum diperiksa";
    let controlCalls = 0;
    const signals: string[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "control",
          controlAction: "delete-all",
          sessionSignal: "continue",
          riskHint: {
            level: "strong",
            category: "acute_distress",
            confidence: 0.95,
          },
          publicFocus: {
            kind: "inspect",
            subject: "detail pribadi dari pesan berisiko",
            contrast: null,
            purpose: null,
          },
          semanticOperation: semanticOperation(
            "data",
            "delete-all",
            "hapus semua dataku, aku belum aman",
          ),
        }),
        triageRisk: async () => ({
          level: "bahaya",
          alone: true,
          sensitive: true,
          summary: "sedang tidak aman",
          certain: true,
        }),
        reply: async (...args: unknown[]) => {
          const replyRuntime = args[7] as ConversationRuntime | undefined;
          replySession = replyRuntime?.session;
          replyFocus = replyRuntime?.publicProgressFocus;
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
        telemetry: {
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async (
            _ownerId: string,
            _turnId: string | null,
            signal: string,
          ) => {
            signals.push(signal);
          },
          recordTurn: async () => undefined,
          drain: async () => undefined,
        } as unknown as TelemetryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("hapus semua dataku, aku belum aman"),
    );
    await harness.bot.drainPending();

    assert.equal(controlCalls, 0);
    assert.equal(reviewed, 1);
    assert.equal(replySession, null);
    assert.equal(replyFocus, null);
    assert.ok(signals.includes("safe-action-blocked"));
    assert.ok(harness.sent.some((text) => text.includes("Aku tetap di sini")));
  });

  it("mengirim fallback safety deterministik bila reply danger gagal", async () => {
    const signals: string[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "feeling",
          riskHint: {
            level: "strong",
            category: "self_harm",
            confidence: 0.95,
          },
        }),
        triageRisk: async () => ({
          level: "bahaya",
          alone: false,
          sensitive: false,
          summary: "risiko dekat",
          certain: true,
        }),
        reply: async () => {
          throw new Error("provider reply unavailable");
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        telemetry: {
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async (
            _ownerId: string,
            _turnId: string | null,
            signal: string,
          ) => {
            signals.push(signal);
          },
          discardUndelivered: async () => undefined,
          recordTurn: async () => undefined,
          drain: async () => undefined,
        } as unknown as TelemetryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("aku takut akan menyakiti diri nanti"),
    );
    await harness.bot.drainPending();

    assert.ok(signals.includes("safety-fallback"));
    assert.equal(
      harness.sent.join("\n\n"),
      DANGER_FALLBACK_REPLY,
    );
  });

  it("telemetry lambat tidak menahan ACK urgent lokal", async () => {
    let boundaryCalls = 0;
    let understandingCalls = 0;
    let urgentSignalStarted = false;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => {
          boundaryCalls += 1;
          return "complete";
        },
        understand: async () => {
          understandingCalls += 1;
          return understanding();
        },
        triageRisk: async () => ({
          level: "bahaya",
          alone: false,
          sensitive: true,
          summary: "bahaya langsung",
          certain: true,
        }),
        reply: async () => "Aku tetap di sini bersamamu.",
        reviewReply: async () => true,
      } as unknown as Conversation,
      {} as TaskService,
      {
        telemetry: {
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async (
            _ownerId: string,
            _turnId: string | null,
            signal: string,
          ) => {
            if (signal !== "urgent-acknowledgement") return;
            urgentSignalStarted = true;
            await new Promise<void>(() => undefined);
          },
          recordTurn: async () => undefined,
          drain: async () => undefined,
        } as unknown as TelemetryService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("aku mau menyakiti diri sekarang"),
    );
    await waitFor(() =>
      urgentSignalStarted && harness.sent.includes(URGENT_ACKNOWLEDGEMENT)
    );
    await harness.bot.drainPending();

    assert.equal(boundaryCalls, 0);
    assert.equal(understandingCalls, 0);
    assert.ok(harness.sent.includes(URGENT_ACKNOWLEDGEMENT));
  });

  it("membawa sinyal darurat per-bubble ke safety turn penuh", async () => {
    let boundaryCalls = 0;
    let understandingCalls = 0;
    let triageCalls = 0;
    const safetyReply = "Aku tetap di sini bersamamu.";
    const harness = basicHarness({
      classifyTurnBoundary: async () => {
        boundaryCalls += 1;
        return "complete";
      },
      understand: async () => {
        understandingCalls += 1;
        return understanding();
      },
      triageRisk: async () => {
        triageCalls += 1;
        return {
          level: "bahaya",
          alone: false,
          sensitive: true,
          summary: "bahaya langsung",
          certain: true,
        };
      },
      reply: async () => safetyReply,
      reviewReply: async () => true,
    } as unknown as Conversation);

    await harness.bot.handleUpdate(messageUpdate("contoh untuk tugas", 1));
    await harness.bot.handleUpdate(
      messageUpdate("aku dalam bahaya sekarang", 2),
    );
    await harness.bot.drainPending();

    assert.equal(boundaryCalls, 0);
    assert.equal(understandingCalls, 0);
    assert.equal(triageCalls, 1);
    assert.ok(harness.sent.includes(URGENT_ACKNOWLEDGEMENT));
    assert.ok(harness.sent.includes(safetyReply));
  });

  it("memaksa triase saat fallback boundary menilai turn urgent", async () => {
    let boundaryCalls = 0;
    let understandingCalls = 0;
    let triageCalls = 0;
    const safetyReply = "Aku menemanimu sekarang.";
    const harness = basicHarness({
      classifyTurnBoundary: async () => {
        boundaryCalls += 1;
        return "urgent";
      },
      understand: async () => {
        understandingCalls += 1;
        return understanding();
      },
      triageRisk: async () => {
        triageCalls += 1;
        return {
          level: "bahaya",
          alone: false,
          sensitive: true,
          summary: "bahaya langsung",
          certain: true,
        };
      },
      reply: async () => safetyReply,
      reviewReply: async () => true,
    } as unknown as Conversation);

    await harness.bot.handleUpdate(messageUpdate("aku capek banget"));
    await waitFor(() => boundaryCalls === 1);
    await waitFor(() => harness.sent.includes(URGENT_ACKNOWLEDGEMENT));
    await harness.bot.drainPending();

    assert.equal(boundaryCalls, 1);
    assert.equal(understandingCalls, 1);
    assert.equal(triageCalls, 1);
    assert.ok(harness.sent.includes(URGENT_ACKNOWLEDGEMENT));
    assert.ok(harness.sent.includes(safetyReply));
  });

  it("membawa sinyal darurat bubble tertahan setelah consent diterima", async () => {
    let consented = false;
    let understandingCalls = 0;
    const triageTexts: string[] = [];
    const safetyReply = "Aku fokus menemanimu sekarang.";
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => {
          understandingCalls += 1;
          return understanding();
        },
        triageRisk: async (text: string) => {
          triageTexts.push(text);
          return text.includes("bahaya")
            ? {
                level: "bahaya",
                alone: false,
                sensitive: true,
                summary: "bahaya langsung",
                certain: true,
              }
            : CALM_TRIAGE;
        },
        reply: async () => safetyReply,
        reviewReply: async () => true,
      } as unknown as Conversation,
      {} as TaskService,
      {
        profiles: {
          needsOnboarding: async () => !consented,
          acceptConsent: async () => {
            consented = true;
            return profile();
          },
          load: async () => profile(),
        } as unknown as ProfileService,
        telemetry: {
          allow: async () => undefined,
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async () => undefined,
          recordTurn: async () => undefined,
          drain: async () => undefined,
        } as unknown as TelemetryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("contoh untuk tugas", 1));
    await harness.bot.handleUpdate(
      messageUpdate("aku dalam bahaya sekarang", 2),
    );
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(callbackUpdate("consent:yes", 3));
    await harness.bot.drainPending();

    assert.equal(understandingCalls, 0);
    assert.deepEqual(triageTexts, [
      "contoh untuk tugas",
      "contoh untuk tugas\naku dalam bahaya sekarang",
    ]);
    assert.ok(harness.sent.includes(safetyReply));
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

  it("tidak me-rollback memory setelah acknowledgement utama sudah terkirim", async () => {
    const stored = new Map<string, MemoryItem>();
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({
          memoryAction: "remember",
          memories: [{ kind: "preference", content: "Suka warna biru" }],
          semanticOperation: semanticOperation(
            "memory",
            "remember",
            "ingat ya aku suka warna biru",
            "aku suka warna biru",
          ),
        }),
        reply: async () =>
          "Oke, aku inget kamu suka warna biru.\n\nKita bisa pakai itu buat pilihan berikutnya.",
      } as unknown as Conversation,
      {} as TaskService,
      {
        memories: {
          relevantTo: async () => [],
          remember: async () => {
            const item = memoryItem("mem-blue-visible", "Suka warna biru");
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
        failSend: (text) => text.includes("pilihan berikutnya"),
      },
    );

    await harness.bot.handleUpdate(messageUpdate("ingat ya aku suka warna biru"));
    await harness.bot.drainPending();

    assert.equal(stored.size, 1);
    assert.ok(
      harness.sent.some((text) => /aku inget kamu suka warna biru/iu.test(text)),
    );
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
          semanticOperation: semanticOperation(
            "task",
            "save",
            "ingatkan aku jam 2 pagi minum obat",
            "minum obat",
          ),
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

  it("mengarbiter hint kuat yang bertentangan dengan triase biasa", async () => {
    let controlCalls = 0;
    let reviewedTriage: unknown = null;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        understand: async () => understanding({
          intent: "control",
          controlAction: "delete-all",
          riskHint: {
            level: "strong",
            category: "acute_distress",
            confidence: 0.9,
          },
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
    assert.equal(
      (reviewedTriage as { level?: unknown }).level,
      "dukungan",
    );
    assert.equal(
      (reviewedTriage as { certain?: unknown }).certain,
      false,
    );
    assert.equal(
      (reviewedTriage as { disposition?: unknown }).disposition,
      "support",
    );
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
    let agentRuntime: ConversationRuntime | null = null;
    const publicFocus = {
      kind: "inspect" as const,
      subject: "cara kerja fotosintesis",
      contrast: null,
      purpose: "memahami perubahan cahaya menjadi energi",
    };
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({
          intent: "question",
          publicFocus,
        }),
        agent: async (
          _message: string,
          mode: string,
          _context: HarvyContext,
          runtime: ConversationRuntime,
        ) => {
          agentCalls += 1;
          agentRuntime = runtime;
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
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async () => undefined,
          recordTurn: async () => undefined,
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
    assert.deepEqual(
      (agentRuntime as ConversationRuntime | null)?.publicProgressFocus,
      publicFocus,
    );
  });

  it("assessment normal memakai everyday reply tanpa menyalakan agent graph", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    let runtimeSeen: ConversationRuntime | null = null;
    const publicFocus = {
      kind: "compare" as const,
      subject: "laptop A",
      contrast: "laptop B",
      purpose: "kebutuhan kuliahmu",
    };
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({
        intent: "question",
        routingAssessment: routingAssessment(),
        publicFocus,
      }),
      agent: async () => {
        agentCalls += 1;
        return { status: "completed", reply: "jalur agent" };
      },
      reply: async (...args: unknown[]) => {
        replyCalls += 1;
        runtimeSeen = args[7] as ConversationRuntime;
        return "Fotosintesis mengubah cahaya menjadi energi kimia.";
      },
    } as unknown as Conversation);

    await harness.bot.handleUpdate(messageUpdate("jelaskan fotosintesis"));
    await harness.bot.drainPending();

    assert.equal(agentCalls, 0);
    assert.equal(replyCalls, 1);
    assert.deepEqual(
      (runtimeSeen as ConversationRuntime | null)?.publicProgressFocus,
      publicFocus,
    );
  });

  it("request pendek bernuansa masuk orkestrator meski di bawah 280 karakter", async () => {
    let modeSeen = "";
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({
        intent: "question",
        routingAssessment: routingAssessment({
          complexity: "deep",
          ambiguity: "high",
          emotionalNuance: "high",
          factualStakes: "high",
        }),
      }),
      agent: async (_message: string, mode: string) => {
        modeSeen = mode;
        return { status: "completed", reply: "Kita timbang pilihanmu pelan-pelan." };
      },
    } as unknown as Conversation);

    await harness.bot.handleUpdate(
      messageUpdate("Ayahku meninggal. Besok aku ujian. Aku harus gimana?"),
    );
    await harness.bot.drainPending();

    assert.equal(modeSeen, "orchestrate");
  });

  it("transformasi mekanis panjang tidak otomatis masuk orkestrator", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({
        intent: "request",
        needsStepByStep: true,
        routingAssessment: routingAssessment({
          complexity: "mechanical",
          executionSize: "heavy",
          transformationMechanical: true,
        }),
      }),
      agent: async () => {
        agentCalls += 1;
        return { status: "completed", reply: "jalur agent" };
      },
      reply: async () => {
        replyCalls += 1;
        return "Daftar sudah diformat.";
      },
    } as unknown as Conversation);
    const message = `ubah nama berikut ke format Firstname Surname langkah demi langkah: ${
      "SURNAME, FIRSTNAME; ".repeat(30)
    }`;

    await harness.bot.handleUpdate(messageUpdate(message));
    await harness.bot.drainPending();

    assert.equal(message.length > 280, true);
    assert.equal(agentCalls, 0);
    assert.equal(replyCalls, 1);
  });

  it("memberi copy jujur dan membuang debit saat run awal kehabisan budget", async () => {
    let discarded = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({ intent: "question" }),
        agent: async () => ({
          status: "stopped",
          reason: "budget_model_calls",
          checkpoint: {} as AgentRunCheckpoint,
          trace: [],
        }),
      } as unknown as Conversation,
      {} as TaskService,
      {
        telemetry: {
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async () => undefined,
          recordTurn: async () => undefined,
          discardUndelivered: async () => {
            discarded += 1;
          },
          drain: async () => undefined,
        } as unknown as TelemetryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("buat analisis panjang"));
    await harness.bot.drainPending();

    assert.equal(discarded, 1);
    assert.ok(harness.sent.some((text) =>
      text.includes("batas kerja kumulatifnya tercapai") &&
      text.includes("tidak akan mengarang")
    ));
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

  it("assessment planning memakai root ambitious meski tanpa kata kunci dan sesi aktif", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({
          intent: "request",
          routingAssessment: routingAssessment({
            complexity: "deep",
            planningRequired: true,
            executionSize: "heavy",
          }),
        }),
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
      } as unknown as Conversation,
      {} as TaskService,
      {
        sessions: {
          active: async () => ({
            ...activeTutor(),
            kind: "focus",
            goal: "Menyusun rencana belajar ujian",
            stage: "act",
          }),
          progressAfterDelivery: async (
            _ownerId: string,
            _signal: unknown,
            _sessionId: string,
            deliver: (session: ActiveSession) => Promise<void>,
          ) => {
            const session = {
              ...activeTutor(),
              kind: "focus" as const,
              goal: "Menyusun rencana belajar ujian",
              stage: "act" as const,
            };
            await deliver(session);
            return session;
          },
        } as unknown as SessionService,
      },
    );

    await harness.bot.handleUpdate(
      messageUpdate("Bantu susun strategi belajar ujian yang saling bergantung."),
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
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async () => undefined,
          recordTurn: async () => undefined,
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

  it("membersihkan checkpoint dan memberi copy resume saat budget habis", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-bot-agent-budget-resume-"));
    const runs = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const checkpoint = durableCheckpoint("123", "run-budget-resume");
    let calls = 0;
    let discarded = 0;
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
            : {
                status: "stopped",
                reason: "budget_deadline",
                checkpoint,
                trace: [],
              };
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        agentRuns: runs,
        telemetry: {
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async () => undefined,
          recordTurn: async () => undefined,
          markDelivered: async () => undefined,
          discardUndelivered: async () => {
            discarded += 1;
          },
          drain: async () => undefined,
        } as unknown as TelemetryService,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("buat analisis jadwal", 1));
    await harness.bot.drainPending();
    assert.ok(await runs.loadWaitingInput("telegram", "123"));
    await harness.bot.handleUpdate(messageUpdate("30 hari", 2));
    await harness.bot.drainPending();

    assert.equal(calls, 2);
    assert.equal(discarded, 1);
    assert.equal(await runs.loadWaitingInput("telegram", "123"), null);
    assert.ok(harness.sent.some((text) =>
      text.includes("Batas kerja kumulatif run sebelumnya") &&
      text.includes("hasil setengah jadi")
    ));
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
    let answerUnderstandingCalls = 0;
    const restartedRuns = new AgentRunService(new FileAgentRunRepository(file));
    const restarted = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => {
          answerUnderstandingCalls += 1;
          return understanding({ intent: "smalltalk" });
        },
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
    assert.equal(answerUnderstandingCalls, 1);
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
      expireWaitingActive: async () => null,
      loadForegroundActive: async () => null,
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
    let boundaryCalls = 0;
    let understandCalls = 0;
    let triageCalls = 0;
    let agentCalls = 0;
    let replyCalls = 0;
    let receivedTimeZone = "";
    let retrievalCalls = 0;
    const turnSignals: string[] = [];
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => {
          boundaryCalls += 1;
          return "complete";
        },
        triageRisk: async () => {
          triageCalls += 1;
          return CALM_TRIAGE;
        },
        understand: async () => {
          understandCalls += 1;
          return understanding({ intent: "question" });
        },
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
      {
        profiles: profiles({ timeZone: "Asia/Jayapura" }),
        telemetry: {
          beginTurn: async () => undefined,
          event: async () => undefined,
          noteTurnSignal: async (
            _ownerId: string,
            _turnId: string | null,
            signal: string,
          ) => {
            turnSignals.push(signal);
          },
          recordTurn: async () => undefined,
          drain: async () => undefined,
        } as unknown as TelemetryService,
        memoryContextCompiler: {
          compilePrivate: async () => {
            retrievalCalls += 1;
            return {
              context: {},
              plan: {},
              manifest: {},
            };
          },
        } as unknown as MemoryContextCompiler,
      },
    );

    await harness.bot.handleUpdate(messageUpdate("harvy sekarang jam berapa"));
    await waitFor(() => harness.sent.some((text) => text.includes("01.30 WIT")));
    await harness.bot.drainPending();

    assert.equal(boundaryCalls, 0);
    assert.equal(understandCalls, 0);
    assert.equal(triageCalls, 0);
    assert.equal(agentCalls, 0);
    assert.equal(replyCalls, 0);
    assert.equal(retrievalCalls, 0);
    assert.equal(receivedTimeZone, "Asia/Jayapura");
    assert.ok(harness.sent.some((text) => text.includes("01.30 WIT")));
    assert.deepEqual(turnSignals, ["deterministic-fast-path"]);
  });

  it("smalltalk model dan identitas murni tidak membayar memory retrieval", async () => {
    for (const text of ["makasih", "kamu pakai model apa?"]) {
      let retrievalCalls = 0;
      const harness = basicHarness(
        {
          classifyTurnBoundary: async () => "complete",
          triageRisk: async () => CALM_TRIAGE,
          understand: async () => understanding({
            intent: text === "makasih" ? "smalltalk" : "question",
          }),
          reply: async () => "jalur model",
        } as unknown as Conversation,
        {} as TaskService,
        {
          memoryContextCompiler: {
            compilePrivate: async () => {
              retrievalCalls += 1;
              throw new Error("retrieval tidak boleh dipanggil");
            },
          } as unknown as MemoryContextCompiler,
        },
      );
      await harness.bot.handleUpdate(messageUpdate(text));
      await harness.bot.drainPending();
      assert.equal(retrievalCalls, 0, text);
    }
  });

  it("explicit danger dan urgent boundary tidak menunggu memory retrieval", async () => {
    for (const scenario of [
      { text: "aku mau bunuh diri sekarang", boundary: "complete" as const },
      { text: "aku capek banget", boundary: "urgent" as const },
    ]) {
      let retrievalCalls = 0;
      const harness = basicHarness(
        {
          classifyTurnBoundary: async () => scenario.boundary,
          triageRisk: async () => ({
            level: "bahaya",
            alone: false,
            sensitive: true,
            summary: "butuh bantuan segera",
            certain: true,
          }),
          understand: async () => understanding({
            riskHint: {
              level: "strong",
              category: "self_harm",
              confidence: 1,
            },
          }),
          reply: async () => "Aku fokus menemanimu sekarang.",
          reviewReply: async () => true,
        } as unknown as Conversation,
        {} as TaskService,
        {
          memoryContextCompiler: {
            compilePrivate: async () => {
              retrievalCalls += 1;
              throw new Error("retrieval tidak boleh dipanggil");
            },
          } as unknown as MemoryContextCompiler,
        },
      );
      await harness.bot.handleUpdate(messageUpdate(scenario.text));
      await waitFor(() => harness.sent.includes(URGENT_ACKNOWLEDGEMENT));
      await harness.bot.drainPending();
      assert.equal(retrievalCalls, 0, scenario.text);
      assert.ok(harness.sent.includes("Aku fokus menemanimu sekarang."));
    }
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

  it("mengarahkan pertanyaan fitur semantic ke menu, bukan capability snapshot", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({
        intent: "question",
        semanticOperation: semanticOperation(
          "menu",
          "show",
          "fitur Harvy apa saja?",
        ),
      }),
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
    assert.equal(replyCalls, 0);
    assert.ok(harness.sent.some((text) => text.startsWith("Menu Harvy")));
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

  it("koreksi saat multi-bubble menghentikan continuation dan history unsent", async () => {
    const turns: Array<ConversationTurn & { sequence?: number }> = [];
    let sequence = 0;
    let injected = false;
    let botRef!: ReturnType<typeof createBot>;
    const replyInputs: string[] = [];
    const conversation = {
      assessTurnBoundary: async () => ({
        state: "complete" as const,
        confidence: 0.95,
        continuationLikelihood: 0.05,
        reasonClass: "closed-request" as const,
      }),
      classifyTurnBoundary: async () => "complete",
      classifyTurnInterruption: async () => "correction",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({ intent: "smalltalk" }),
      reply: async (text: string) => {
        replyInputs.push(text);
        return text === "jelaskan pilihan awal?"
          ? "bubble satu\n\nbubble dua\n\nbubble tiga"
          : "jawaban revisi";
      },
    } as unknown as Conversation;
    const harness = basicHarness(conversation, {} as TaskService, {
      histories: {
        context: async () => ({ summary: null, turns: [...turns] }),
        append: async (
          _ownerId: string,
          role: "user" | "harvy",
          text: string,
        ) => {
          sequence += 1;
          const turn = {
            role,
            text,
            at: new Date().toISOString(),
            sequence,
          };
          turns.push(turn);
          return turn;
        },
        compact: async () => undefined,
        allow: () => undefined,
        suspend: () => undefined,
      } as unknown as HistoryService,
      onSend: async (text) => {
        if (text !== "bubble satu" || injected) return;
        injected = true;
        await botRef.handleUpdate(messageUpdate(
          "eh maksudku pilihan yang baru",
          2,
        ));
      },
    });
    botRef = harness.bot;

    await harness.bot.handleUpdate(messageUpdate("jelaskan pilihan awal?", 1));
    await harness.bot.drainPending();

    assert.deepEqual(harness.sent, ["bubble satu", "jawaban revisi"]);
    assert.deepEqual(
      turns.filter((turn) => turn.role === "harvy").map((turn) => turn.text),
      ["bubble satu", "jawaban revisi"],
    );
    assert.deepEqual(replyInputs, [
      "jelaskan pilihan awal?",
      "eh maksudku pilihan yang baru",
    ]);
  });

  it("kegagalan transport multi-bubble hanya mencatat bagian yang terkirim", async () => {
    const conversation = {
      assessTurnBoundary: async () => ({
        state: "complete" as const,
        confidence: 0.95,
        continuationLikelihood: 0.05,
        reasonClass: "closed-request" as const,
      }),
      classifyTurnBoundary: async () => "complete",
      triageRisk: async () => CALM_TRIAGE,
      understand: async () => understanding({ intent: "smalltalk" }),
      reply: async () => "bubble satu\n\nbubble dua\n\nbubble tiga",
    } as unknown as Conversation;
    const harness = basicHarness(conversation, {} as TaskService, {
      failSend: (text) => text === "bubble dua",
    });

    await harness.bot.handleUpdate(messageUpdate("jelaskan secara singkat?", 1));
    await harness.bot.drainPending();

    assert.deepEqual(harness.sent, ["bubble satu"]);
    assert.deepEqual(
      harness.turns
        .filter((turn) => turn.role === "harvy")
        .map((turn) => turn.text),
      ["bubble satu"],
    );
  });

  it("/menu deterministik, category-based, dan berbeda dari /bantuan", async () => {
    let modelCalls = 0;
    const forbidden = (): never => {
      modelCalls += 1;
      throw new Error("menu exact tidak boleh memanggil model");
    };
    const harness = basicHarness({
      classifyTurnBoundary: async () => forbidden(),
      understand: async () => forbidden(),
      triageRisk: async () => forbidden(),
      reply: async () => forbidden(),
    } as unknown as Conversation);

    await harness.bot.handleUpdate(commandUpdate("/menu", 1));
    await harness.bot.drainPending();
    const menu = harness.sent.at(-1) ?? "";
    assert.match(menu, /^Menu Harvy/u);
    assert.match(menu, /Penggunaan & paket/u);
    assert.match(menu, /Pengaturan/u);
    assert.ok(findCallback(harness.telegramCalls, "menu:usage"));
    assert.ok(findCallback(harness.telegramCalls, "menu:settings"));

    await harness.bot.handleUpdate(callbackUpdate("menu:usage", 2));
    await harness.bot.drainPending();
    const categoryEdit = harness.telegramCalls.find((call) =>
      call.method === "editMessageText" &&
      /\/penggunaan/u.test((call.payload as { text?: string }).text ?? "")
    );
    assert.ok(categoryEdit);

    await harness.bot.handleUpdate(callbackUpdate("menu:settings", 3));
    await harness.bot.drainPending();
    const settingsEdit = harness.telegramCalls.find((call) =>
      call.method === "editMessageText" &&
      /^Pengaturan/u.test((call.payload as { text?: string }).text ?? "")
    );
    assert.ok(settingsEdit);
    const settingsCallbacks = (
      (settingsEdit.payload as {
        reply_markup?: {
          inline_keyboard?: Array<Array<{ callback_data?: string }>>;
        };
      }).reply_markup?.inline_keyboard ?? []
    ).flat().map((button) => button.callback_data);
    for (const callback of [
      "control:export",
      "control:timezone",
      "control:delete-all",
    ]) {
      assert.ok(settingsCallbacks.includes(callback), callback);
    }

    await harness.bot.handleUpdate(commandUpdate("/bantuan", 4));
    await harness.bot.drainPending();
    const help = harness.sent.at(-1) ?? "";
    assert.match(help, /Contoh:/u);
    assert.notEqual(help, menu);
    assert.equal(modelCalls, 0);
  });

  it("/penggunaan deterministik, owner-scoped, dan privat di Telegram", async () => {
    let modelCalls = 0;
    let summaryCalls = 0;
    const forbiddenModelCall = (): never => {
      modelCalls += 1;
      throw new Error("model tidak boleh dipanggil oleh /penggunaan");
    };
    const harness = basicHarness({
      classifyTurnBoundary: async () => forbiddenModelCall(),
      understand: async () => forbiddenModelCall(),
      triageRisk: async () => forbiddenModelCall(),
      reply: async () => forbiddenModelCall(),
    } as unknown as Conversation, {} as TaskService, {
      usageDashboard: {
        summary: async (ownerId) => {
          summaryCalls += 1;
          assert.equal(ownerId, "123");
          return usageSummary();
        },
      },
    });

    await harness.bot.handleUpdate(commandUpdate("/penggunaan", 1));
    await harness.bot.drainPending();
    const dashboardCall = harness.telegramCalls.find((call) =>
      call.method === "sendMessage" &&
      (call.payload as { text?: string }).text?.includes("Penggunaan Harvy")
    );
    assert.ok(dashboardCall);
    assert.equal(
      (dashboardCall.payload as { parse_mode?: string }).parse_mode,
      "HTML",
    );
    assert.match(
      (dashboardCall.payload as { text: string }).text,
      /^<b>Penggunaan Harvy<\/b>/u,
    );

    await harness.bot.handleUpdate(commandWithArgumentsUpdate(
      "/penggunaan user-lain",
      2,
    ));
    await harness.bot.drainPending();
    assert.match(
      harness.sent.at(-1) ?? "",
      /tidak menerima nama atau ID pengguna lain/iu,
    );

    await harness.bot.handleUpdate(groupCommandUpdate("/penggunaan", 3));
    await harness.bot.drainPending();
    assert.match(harness.sent.at(-1) ?? "", /chat pribadi/iu);
    assert.equal(summaryCalls, 1);
    assert.equal(modelCalls, 0);
  });

  it("menjaga follow-up usage semantic pada surface yang sama dan membaca state baru", async () => {
    let understandingCalls = 0;
    let replyCalls = 0;
    let summaryCalls = 0;
    const seenContexts: HarvyContext[] = [];
    const first = "harvy berapa sisa penggunaan ku";
    const followUp = "detailnya";
    const harness = basicHarness({
      classifyTurnBoundary: async () => "complete",
      understand: async (message: string, context: HarvyContext) => {
        understandingCalls += 1;
        seenContexts.push(context);
        return understanding({
          intent: "question",
          semanticOperation: semanticOperation(
            "usage",
            message === followUp ? "show-details" : "show-summary",
            message,
            null,
            message === followUp ? "contextual" : "explicit",
            message === followUp ? "recent" : "none",
          ),
        });
      },
      triageRisk: async () => {
        throw new Error("usage tenang tidak perlu triase safety");
      },
      reply: async () => {
        replyCalls += 1;
        throw new Error("usage semantic tidak boleh jatuh ke percakapan/Python");
      },
      memoryPortrait: async () => {
        throw new Error("usage follow-up bukan memory portrait");
      },
    } as unknown as Conversation, {} as TaskService, {
      economy: {} as EconomyService,
      usageDashboard: {
        summary: async () => {
          summaryCalls += 1;
          const current = usageSummary();
          return {
            ...current,
            allowance: {
              ...current.allowance,
              remainingBasisPoints: 6_900 - summaryCalls * 100,
              usedBasisPoints: 3_100 + summaryCalls * 100,
            },
          };
        },
      },
    });

    await harness.bot.handleUpdate(messageUpdate(first, 1));
    await harness.bot.drainPending();
    await harness.bot.handleUpdate(messageUpdate(followUp, 2));
    await harness.bot.drainPending();

    assert.equal(understandingCalls, 2);
    assert.equal(summaryCalls, 2, "follow-up wajib membaca state usage terbaru");
    assert.equal(replyCalls, 0);
    assert.equal(seenContexts[0]?.interactions?.length ?? 0, 0);
    assert.deepEqual(
      seenContexts[1]?.interactions?.map(({ domain, operation }) => ({
        domain,
        operation,
      })),
      [{ domain: "usage", operation: "show-summary" }],
    );
    assert.equal(harness.turns.length, 0, "account surface tidak masuk history");
    assert.equal(
      harness.sent.filter((text) => /Penggunaan Harvy/u.test(text)).length,
      2,
    );
    assert.doesNotMatch(harness.sent.at(-1) ?? "", /Python|memori|maksudmu/iu);
  });
});

describe("work lane active AgentRun Telegram", () => {
  it("menghapus snapshot run ketika memori sumber dilupakan", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-active-run-memory-"));
    const runs = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const memory = memoryItem("memory-active", "Belajar lebih enak pagi.");
    const started = await runs.startActive({
      channel: "telegram",
      ownerId: "123",
      request: "tolong buatkan rencana belajar langkah demi langkah",
      mode: "orchestrate",
      intent: "request",
      timeZone: "Asia/Jakarta",
      style: "advice",
      context: {
        summary: null,
        turns: [],
        memories: [{
          id: memory.id,
          kind: memory.kind,
          content: memory.content,
        }],
      },
      chatId: "123",
      turnId: "turn-memory-active",
    });
    assert.equal(started.status, "started");
    if (started.status !== "started") return;
    await runs.attachActiveAnchor(
      "telegram",
      "123",
      started.run.runId,
      "77",
    );
    let forgotten = false;
    const harness = basicHarness(
      {} as Conversation,
      {} as TaskService,
      {
        agentRuns: runs,
        memories: {
          list: async () => forgotten ? [] : [memory],
          forget: async () => {
            if (forgotten) return null;
            forgotten = true;
            return memory;
          },
          relevantTo: async () => [],
          markUsed: async () => undefined,
        } as unknown as MemoryService,
      },
    );

    await harness.bot.handleUpdate(
      callbackUpdate(`memforget:${memory.id}`, 10),
    );
    await harness.bot.drainPending();

    assert.equal(forgotten, true);
    assert.equal(await runs.loadActive("telegram", "123"), null);
    assert.ok(
      harness.sent.some((text) => /planning.*kuhentikan/iu.test(text)),
    );
    assert.ok(
      harness.telegramCalls.some((call) =>
        call.method === "editMessageText" &&
        /Dibatalkan/iu.test(
          String((call.payload as { text?: unknown }).text ?? ""),
        )
      ),
    );
  });

  it("menjaga chat lane responsif saat pekerjaan durable masih berjalan", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-active-run-chat-lane-"));
    const runs = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const request = "tolong buatkan rencana belajar langkah demi langkah";
    const started = deferredVoid();
    const release = deferredVoid();
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async (message: string) =>
          understanding({
            intent: message === request ? "request" : "smalltalk",
            routingAssessment: message === request
              ? routingAssessment({
                  complexity: "deep",
                  planningRequired: true,
                  executionSize: "heavy",
                })
              : routingAssessment(),
          }),
        agent: async (
          _message: string,
          mode: string,
          _context: HarvyContext,
          runtime: { runId?: string },
        ) => {
          agentCalls += 1;
          assert.equal(mode, "orchestrate");
          assert.ok(runtime.runId);
          started.resolve();
          await release.promise;
          return {
            status: "completed",
            reply: "Rencana durable selesai.",
            checkpoint: activeCheckpoint("123", runtime.runId, request),
            trace: [],
          };
        },
        reply: async () => {
          replyCalls += 1;
          return "Chat tetap jalan sambil rencana dikerjakan.";
        },
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: runs },
    );

    try {
      await harness.bot.handleUpdate(messageUpdate(request, 1));
      await started.promise;
      await waitFor(() => harness.sent.some((text) => text.startsWith("📌 ")));

      await harness.bot.handleUpdate(messageUpdate("makasih ya", 2));
      await waitFor(() =>
        harness.sent.includes("Chat tetap jalan sambil rencana dikerjakan.")
      );

      assert.equal(agentCalls, 1);
      assert.equal(replyCalls, 1);
      release.resolve();
      await waitForAsync(async () =>
        (await runs.loadActive("telegram", "123"))?.status === "completed"
      );

      const completed = await runs.loadActive("telegram", "123");
      assert.equal(completed?.receipts.at(-1)?.status, "committed");
      assert.ok(harness.sent.includes("Rencana durable selesai."));
      await waitFor(() =>
        harness.telegramCalls.some((call) => call.method === "unpinChatMessage")
      );
      const pin = harness.telegramCalls.find((call) =>
        call.method === "pinChatMessage"
      );
      const unpin = harness.telegramCalls.find((call) =>
        call.method === "unpinChatMessage"
      );
      assert.ok(pin);
      assert.ok(unpin);
      assert.equal(
        (pin.payload as { message_id?: unknown }).message_id,
        (unpin.payload as { message_id?: unknown }).message_id,
      );
    } finally {
      release.resolve();
      await harness.bot.drainPending();
    }
  });

  it("tidak menggandakan Run Anchor Telegram bila edit dan delete sama-sama gagal", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-active-run-anchor-fail-"));
    const runs = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const request = "tolong buatkan rencana audit langkah demi langkah";
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({
          intent: "request",
          routingAssessment: routingAssessment({
            complexity: "deep",
            planningRequired: true,
            executionSize: "heavy",
          }),
        }),
        agent: async (
          _message: string,
          _mode: string,
          _context: HarvyContext,
          runtime: { runId?: string },
        ) => {
          assert.ok(runtime.runId);
          return {
            status: "completed",
            reply: "Rencana audit selesai.",
            checkpoint: activeCheckpoint("123", runtime.runId, request),
            trace: [],
          };
        },
      } as unknown as Conversation,
      {} as TaskService,
      {
        agentRuns: runs,
        failTelegramCall: (method) =>
          method === "editMessageText" || method === "deleteMessage",
      },
    );

    await harness.bot.handleUpdate(messageUpdate(request, 1));
    await waitForAsync(async () =>
      (await runs.loadActive("telegram", "123"))?.status === "completed"
    );
    await harness.bot.drainPending();

    const statusCreates = harness.telegramCalls.filter((call) =>
      call.method === "sendMessage" && /^📌\s/u.test(
        String((call.payload as { text?: unknown }).text ?? ""),
      )
    );
    assert.equal(statusCreates.length, 1);
    assert.ok(harness.telegramCalls.some((call) => call.method === "deleteMessage"));
    assert.ok(harness.telegramCalls.some((call) => call.method === "unpinChatMessage"));
  });

  it("me-replan koreksi terikat dan tidak memublikasikan hasil revisi basi", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-active-run-correction-"));
    const runs = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const request = "tolong buatkan rencana belajar langkah demi langkah";
    const firstStarted = deferredVoid();
    const releaseFirst = deferredVoid();
    const secondStarted = deferredVoid();
    let agentCalls = 0;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({
          intent: "request",
          routingAssessment: routingAssessment({
            complexity: "deep",
            planningRequired: true,
            executionSize: "heavy",
          }),
        }),
        agent: async (
          _message: string,
          _mode: string,
          _context: HarvyContext,
          runtime: { runId?: string },
          restored?: AgentRunCheckpoint,
        ) => {
          agentCalls += 1;
          assert.ok(runtime.runId);
          if (agentCalls === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
            return {
              status: "completed",
              reply: "HASIL REVISI LAMA",
              checkpoint: activeCheckpoint("123", runtime.runId, request),
              trace: [],
            };
          }
          assert.ok(restored);
          assert.ok(
            restored.userInputs.some((item) =>
              item.text.includes("Jangan buat reminder dulu")
            ),
          );
          secondStarted.resolve();
          return {
            status: "completed",
            reply: "Rencana terkoreksi tanpa reminder.",
            checkpoint: { ...restored, pendingInput: null },
            trace: [],
          };
        },
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: runs },
    );

    try {
      await harness.bot.handleUpdate(messageUpdate(request, 1));
      await firstStarted.promise;
      await waitFor(() => harness.sent.some((text) => text.startsWith("📌 ")));
      const anchorId = harness.sent.findIndex((text) => text.startsWith("📌 ")) + 1;
      assert.ok(anchorId > 0);

      const correction = replyMessageUpdate(
        "Jangan buat reminder dulu",
        2,
        anchorId,
      );
      await harness.bot.handleUpdate(correction);
      await waitFor(() =>
        harness.sent.some((text) => text.includes("koreksinya masuk"))
      );
      await harness.bot.handleUpdate(correction);
      assert.equal(
        harness.sent.filter((text) => text.includes("koreksinya masuk")).length,
        1,
      );
      assert.equal(
        (await runs.loadActive("telegram", "123"))?.mailbox.length,
        1,
      );
      releaseFirst.resolve();
      await secondStarted.promise;
      await waitForAsync(async () =>
        (await runs.loadActive("telegram", "123"))?.status === "completed"
      );

      const completed = await runs.loadActive("telegram", "123");
      assert.equal(agentCalls, 2);
      assert.equal(completed?.instructionRevision, 2);
      assert.equal(completed?.changeSets.at(-1)?.kind, "correction");
      assert.equal(harness.sent.includes("HASIL REVISI LAMA"), false);
      assert.ok(harness.sent.includes("Rencana terkoreksi tanpa reminder."));
    } finally {
      releaseFirst.resolve();
      await harness.bot.drainPending();
    }
  });

  it("tidak menganggap chat berikutnya sebagai jawaban tanpa binding pertanyaan", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-active-run-question-"));
    const runs = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const request = "tolong buatkan rencana belajar langkah demi langkah";
    const prompt = "Berapa hari waktu belajarnya?";
    let agentCalls = 0;
    let receivedAnswer: string | undefined;
    const harness = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async (message: string) =>
          understanding({
            intent: message === request ? "request" : "smalltalk",
            routingAssessment: message === request
              ? routingAssessment({
                  complexity: "deep",
                  planningRequired: true,
                  executionSize: "heavy",
                })
              : routingAssessment(),
          }),
        agent: async (
          _message: string,
          _mode: string,
          _context: HarvyContext,
          runtime: { runId?: string },
          restored?: AgentRunCheckpoint,
          answer?: string,
        ) => {
          agentCalls += 1;
          assert.ok(runtime.runId);
          if (agentCalls === 1) {
            return {
              status: "needs_input",
              prompt,
              checkpoint: activeCheckpoint(
                "123",
                runtime.runId,
                request,
                prompt,
              ),
              trace: [],
            };
          }
          assert.ok(restored);
          receivedAnswer = answer;
          return {
            status: "completed",
            reply: "Rencana 30 hari selesai.",
            checkpoint: { ...restored, pendingInput: null },
            trace: [],
          };
        },
        reply: async () => "Kopi terdengar enak.",
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: runs },
    );

    try {
      await harness.bot.handleUpdate(messageUpdate(request, 1));
      await waitForAsync(async () =>
        (await runs.loadActive("telegram", "123"))?.status === "waiting_input"
      );
      const waiting = await runs.loadActive("telegram", "123");
      const questionMessageId = Number(waiting?.pendingQuestion?.messageId);
      assert.ok(Number.isSafeInteger(questionMessageId));

      await harness.bot.handleUpdate(messageUpdate("aku lagi minum kopi", 2));
      await waitFor(() => harness.sent.includes("Kopi terdengar enak."));
      assert.equal(agentCalls, 1);
      assert.equal(
        (await runs.loadActive("telegram", "123"))?.mailbox.length,
        0,
      );

      await harness.bot.handleUpdate(
        replyMessageUpdate("30 hari", 3, questionMessageId),
      );
      await waitForAsync(async () =>
        (await runs.loadActive("telegram", "123"))?.status === "completed"
      );

      assert.equal(agentCalls, 2);
      assert.equal(receivedAnswer, "30 hari");
      assert.ok(harness.sent.includes("Rencana 30 hari selesai."));
    } finally {
      await harness.bot.drainPending();
    }
  });

  it("melanjutkan checkpoint paused setelah proses bot diganti", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-active-run-restart-"));
    const file = join(root, "agent-runs.json");
    const request = "tolong buatkan rencana belajar langkah demi langkah";
    const firstRuns = new AgentRunService(new FileAgentRunRepository(file));
    const firstStarted = deferredVoid();
    const first = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({
          intent: "request",
          routingAssessment: routingAssessment({
            complexity: "deep",
            planningRequired: true,
            executionSize: "heavy",
          }),
        }),
        agent: async (
          _message: string,
          _mode: string,
          _context: HarvyContext,
          runtime: { runId?: string; signal?: AbortSignal },
        ) => {
          assert.ok(runtime.runId);
          const checkpoint = activeCheckpoint("123", runtime.runId, request);
          firstStarted.resolve();
          await new Promise<void>((resolve) => {
            if (runtime.signal?.aborted) return resolve();
            runtime.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return {
            status: "stopped",
            reason: "cancelled",
            checkpoint,
            trace: [],
          };
        },
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: firstRuns },
    );

    await first.bot.handleUpdate(messageUpdate(request, 1));
    await firstStarted.promise;
    await first.bot.drainPending();
    assert.equal(
      (await firstRuns.loadActive("telegram", "123"))?.status,
      "paused",
    );

    const restartedRuns = new AgentRunService(new FileAgentRunRepository(file));
    let restoredCheckpoint: AgentRunCheckpoint | undefined;
    const restarted = basicHarness(
      {
        classifyTurnBoundary: async () => "complete",
        triageRisk: async () => CALM_TRIAGE,
        understand: async () => understanding({
          intent: "request",
          routingAssessment: routingAssessment({
            complexity: "deep",
            planningRequired: true,
            executionSize: "heavy",
          }),
        }),
        agent: async (
          _message: string,
          _mode: string,
          _context: HarvyContext,
          _runtime: { runId?: string },
          restored?: AgentRunCheckpoint,
        ) => {
          restoredCheckpoint = restored;
          assert.ok(restored);
          return {
            status: "completed",
            reply: "Pekerjaan pulih setelah restart.",
            checkpoint: { ...restored, pendingInput: null },
            trace: [],
          };
        },
      } as unknown as Conversation,
      {} as TaskService,
      { agentRuns: restartedRuns },
    );

    try {
      await restarted.bot.resumeAgentRuns();
      await waitForAsync(async () =>
        (await restartedRuns.loadActive("telegram", "123"))?.status ===
          "completed"
      );
      assert.ok(restoredCheckpoint);
      assert.ok(restarted.sent.includes("Pekerjaan pulih setelah restart."));
    } finally {
      await restarted.bot.drainPending();
    }
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
    longTermMemoryFile: "unused",
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
      privateEnabled: false,
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

function activeCheckpoint(
  ownerId: string,
  runId: string,
  request: string,
  pendingPrompt: string | null = null,
): AgentRunCheckpoint {
  const startedAt = new Date();
  return {
    version: 1,
    runId,
    scopeKey: scopeKey(privateAgentScope("telegram", ownerId)),
    capabilityHash: "c".repeat(16),
    callableHash: "d".repeat(64),
    request,
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(startedAt.getTime() + 10 * 60 * 1_000).toISOString(),
    maxSteps: 6,
    step: 0,
    observations: [],
    userInputs: [],
    seenActionDigests: [],
    pending: null,
    pendingInput: pendingPrompt === null
      ? null
      : { step: 0, prompt: pendingPrompt },
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

function replyMessageUpdate(
  text: string,
  updateId: number,
  replyToMessageId: number,
): Update {
  const update = messageUpdate(text, updateId);
  if (update.message) {
    update.message.reply_to_message = {
      message_id: replyToMessageId,
      date: 1,
      chat: { id: 123, type: "private", first_name: "Imam" },
      from: {
        id: 999,
        is_bot: true,
        first_name: "Harvy",
        username: "harvy_test_bot",
      },
      text: "pesan Harvy yang di-quote",
    } as unknown as NonNullable<typeof update.message.reply_to_message>;
  }
  return update;
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

function commandWithArgumentsUpdate(text: string, updateId: number): Update {
  const update = messageUpdate(text, updateId);
  if (update.message) {
    update.message.entities = [{
      offset: 0,
      length: text.indexOf(" ") < 0 ? text.length : text.indexOf(" "),
      type: "bot_command",
    }];
  }
  return update;
}

function groupCommandUpdate(text: string, updateId: number): Update {
  const update = commandUpdate(text, updateId);
  if (update.message) {
    update.message.chat = {
      id: -123,
      type: "group",
      title: "Grup uji",
    };
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

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Kondisi async uji tidak tercapai.");
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
  onSend?: (text: string) => Promise<void> | void,
  failTelegramCall?: (method: string, payload: unknown) => boolean,
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
    if (failTelegramCall?.(method, payload)) {
      throw new Error("Telegram operation gagal");
    }
    if (method === "sendMessage") {
      const body = payload as { chat_id: number; text: string };
      if (failSend?.(body.text)) throw new Error("Telegram gagal");
      sent.push(body.text);
      await onSend?.(body.text);
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
    memoryContextCompiler?: MemoryContextCompiler;
    histories?: HistoryService;
    telegramCalls?: TelegramCall[];
    failSend?: (text: string) => boolean;
    onSend?: (text: string) => Promise<void> | void;
    failTelegramCall?: (method: string, payload: unknown) => boolean;
    usageDashboard?: Pick<UserUsageSummaryService, "summary">;
    economy?: EconomyService;
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
    overrides.histories ?? {
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
      beginTurn: async () => undefined,
      event: async () => undefined,
      noteTurnSignal: async () => undefined,
      recordTurn: async () => undefined,
      drain: async () => undefined,
    } as unknown as TelemetryService,
    undefined,
    overrides.agentRuns,
    overrides.memoryContextCompiler,
    undefined,
    overrides.economy,
    overrides.usageDashboard,
  );
  installFakeTelegram(
    bot,
    sent,
    telegramCalls,
    overrides.failSend,
    overrides.onSend,
    overrides.failTelegramCall,
  );
  return { bot, sent, turns, telegramCalls };
}

function usageSummary(): UserUsageSummary {
  return {
    plan: { id: "personal_toro", publicName: "Toro", isFree: false },
    period: {
      startsAt: "2026-08-20T17:00:00.000Z",
      endsAt: "2026-09-20T17:00:00.000Z",
      resetsAt: "2026-09-20T17:00:00.000Z",
    },
    allowance: {
      remainingBasisPoints: 6_800,
      usedBasisPoints: 3_200,
      state: "healthy",
    },
    modelUsage: {
      inputTokens: 184_000,
      cachedInputTokens: 121_000,
      outputTokens: 31_000,
      reasoningTokens: 18_000,
      hasEstimatedUsage: false,
    },
    cost: {
      totalProviderCostUsdNanos: "180000000",
      completeness: "complete",
      providerReportedUsdNanos: "180000000",
      catalogCalculatedUsdNanos: "0",
    },
    funding: {
      includedUsdNanos: "160000000",
      sponsoredUsdNanos: "0",
      byokUsdNanos: "20000000",
      harvyOverheadUsdNanos: "0",
      walletProviderCostUsdNanos: "0",
      paygIdr: "0",
      paygUsed: false,
      paygRelevant: true,
      current: { type: "plan", publicName: "Toro" },
    },
    efficiency: {
      cacheHitPercent: 66,
      cacheSavingsUsdNanos: "108900000",
    },
  };
}

function understanding(
  overrides: Partial<Awaited<ReturnType<Conversation["understand"]>>> = {},
) {
  return {
    intent: "smalltalk" as const,
    taskAction: null,
    memoryAction: null,
    controlAction: null,
    riskHint: { level: "none", confidence: 1 },
    safetySensitive: false,
    needsStepByStep: false,
    sessionSignal: null,
    suggestedActions: [],
    actionGoal: null,
    task: null,
    memories: [],
    semanticOperation: null,
    ...overrides,
  };
}

function semanticOperation(
  domain: SemanticDomain,
  operation: SemanticOperationName,
  evidence: string,
  target: string | null = null,
  explicitness: SemanticExplicitness = "explicit",
  reference: SemanticReference = "none",
): SemanticOperation {
  return {
    version: 1,
    domain,
    operation,
    target,
    subject: "self",
    reference,
    explicitness,
    evidence,
    confidence: 0.95,
  };
}

function routingAssessment(
  overrides: Partial<RoutingAssessment> = {},
): RoutingAssessment {
  return {
    complexity: "normal",
    ambiguity: "low",
    planningRequired: false,
    emotionalNuance: "low",
    executionSize: "small",
    factualStakes: "low",
    transformationMechanical: false,
    toolNeed: "none",
    confidence: 0.95,
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
