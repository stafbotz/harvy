import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationRuntime } from "../src/ai/conversation.js";
import type { Understanding } from "../src/ai/understand.js";
import { NO_RISK_HINT } from "../src/core/safety-policy.js";
import type { UserProfile } from "../src/domain/profile.js";
import type { ConversationTurn } from "../src/domain/history.js";
import type { MemoryItem } from "../src/domain/memory.js";
import type {
  WhatsAppPrivateMessage,
  WhatsAppPrivateTransport,
} from
  "../src/whatsapp/baileys-message-normalizer.js";
import {
  WhatsAppPrivateConversation,
  type WhatsAppPrivateConversationDependencies,
  type WhatsAppPrivateReply,
} from "../src/whatsapp/private-conversation.js";

describe("WhatsAppPrivateConversation", () => {
  it("menahan pesan pertama sampai consent lalu memakai pipeline WhatsApp", async () => {
    const harness = createHarness(false);
    const first = await harness.service.handle(message(
      "Tolong jelaskan konsep fotosintesis dengan contoh yang gampang dipahami.",
      "pesan-1",
    ));

    assert.equal(typeof first, "string");
    assert.match(String(first), /balas SETUJU/i);
    assert.equal(harness.understandCalls, 0);
    assert.equal(harness.history.length, 0);

    const accepted = await harness.service.handle(message("SETUJU", "pesan-2"));
    assert.equal(typeof accepted, "object");
    const reply = accepted as WhatsAppPrivateReply;
    assert.match(reply.text, /Aku baca pesanmu yang tadi/i);
    assert.match(reply.text, /Jawaban privat WhatsApp/u);
    assert.equal(harness.consent, true);
    assert.equal(harness.understandCalls, 1);
    assert.deepEqual(harness.replyChannels, ["whatsapp"]);
    assert.deepEqual(
      harness.history.map((turn) => turn.role),
      ["user"],
    );

    await reply.onDelivered?.();
    assert.deepEqual(
      harness.history.map((turn) => turn.role),
      ["user", "harvy"],
    );
    assert.equal(harness.delivered, 1);
    assert.equal(harness.discarded, 0);
    assert.deepEqual(harness.turnOutcomes, ["completed"]);
  });

  it("hanya menerima SETUJU sebagai authority consent teks", async () => {
    const harness = createHarness(false);
    await harness.service.handle(message("Aku mau bertanya.", "izin-1"));

    const casualReply = await harness.service.handle(message(
      "oke, mulai",
      "izin-2",
    ));

    assert.equal(harness.consent, false);
    assert.equal(harness.understandCalls, 0);
    assert.match(String(casualReply), /SETUJU/u);
  });

  it("menjelaskan batas fitur WhatsApp tanpa mengklaim surface Telegram", async () => {
    const harness = createHarness(false);
    const detail = String(await harness.service.handle(message(
      "/izin",
      "izin-detail",
    )));

    assert.doesNotMatch(detail, /pekerjaan planning yang berjalan di latar/iu);
    assert.doesNotMatch(detail, /Kalau kamu memilih sesi atau check-in/iu);
    assert.match(detail, /mengekspor file data belum tersedia/iu);
    assert.match(detail, /\/hapus-data/u);
  });

  it("tidak mengakui usage atau history balasan ketika delivery gagal", async () => {
    const harness = createHarness(true);
    const result = await harness.service.handle(message(
      "Bantu aku memahami perbedaan mitosis dan meiosis secara runtut.",
      "pesan-gagal",
    ));
    assert.equal(typeof result, "object");
    const reply = result as WhatsAppPrivateReply;

    await reply.onDeliveryFailed?.();
    await reply.onDeliveryFailed?.();

    assert.deepEqual(
      harness.history.map((turn) => turn.role),
      ["user"],
    );
    assert.equal(harness.delivered, 0);
    assert.equal(harness.discarded, 1);
    assert.deepEqual(harness.turnOutcomes, ["failed"]);
  });

  it("mencatat hanya bubble yang benar-benar terkirim saat delivery terpotong", async () => {
    const harness = createHarness(true);
    const result = await harness.service.handle(message(
      "Jelaskan topik ini secara bertahap.",
      "pesan-parsial",
    ));
    const reply = result as WhatsAppPrivateReply;

    await reply.onDeliveryFailed?.({
      text: "Bagian pertama yang sempat terlihat.",
      bubbleCount: 1,
      complete: false,
    });

    assert.deepEqual(
      harness.history.map(({ role, text }) => ({ role, text })),
      [
        { role: "user", text: "Jelaskan topik ini secara bertahap." },
        { role: "harvy", text: "Bagian pertama yang sempat terlihat." },
      ],
    );
    assert.equal(harness.delivered, 1);
    assert.equal(harness.discarded, 0);
    assert.deepEqual(harness.turnOutcomes, ["cancelled"]);
  });

  it("menghentikan bubble lama di tengah delivery lalu menjawab koreksi", async () => {
    const harness = createHarness(true, {
      interruptionRelation: "correction",
      reply: async (text) =>
        text === "jelaskan pilihan awal?"
          ? "bubble satu\n\nbubble dua\n\nbubble tiga"
          : "jawaban revisi",
    });
    const sent: string[] = [];
    let injected = false;
    const transport: WhatsAppPrivateTransport = {
      isCurrent: () => true,
      send: async (text) => {
        sent.push(text);
        if (text === "bubble satu" && !injected) {
          injected = true;
          await harness.service.ingest(
            message("eh maksudku pilihan yang baru", "koreksi-2"),
            transport,
          );
        }
        return { messageId: `sent-${sent.length}` };
      },
      edit: async () => undefined,
      remove: async () => undefined,
      typing: async () => undefined,
    };

    await harness.service.ingest(
      message("jelaskan pilihan awal?", "koreksi-1"),
      transport,
    );
    await harness.service.drain();

    assert.deepEqual(sent, ["bubble satu", "jawaban revisi"]);
    assert.deepEqual(
      harness.history.filter((turn) => turn.role === "harvy")
        .map((turn) => turn.text),
      ["bubble satu", "jawaban revisi"],
    );
    assert.deepEqual(harness.replyMessages, [
      "jelaskan pilihan awal?",
      "eh maksudku pilihan yang baru",
    ]);
  });

  it("tetap menyelesaikan commit delivery ketika satu pencatatan lokal gagal", async () => {
    const harness = createHarness(true, { noteTurnResponseFails: true });
    const result = await harness.service.handle(message(
      "Jelaskan kenapa langit tampak biru dengan bahasa sederhana.",
      "pesan-commit",
    ));
    assert.equal(typeof result, "object");
    const reply = result as WhatsAppPrivateReply;

    await reply.onDelivered?.();

    assert.equal(harness.delivered, 1);
    assert.deepEqual(
      harness.history.map((turn) => turn.role),
      ["user", "harvy"],
    );
    assert.deepEqual(harness.turnOutcomes, ["completed"]);
  });

  it("menarik consent melalui perintah teks tertutup", async () => {
    const harness = createHarness(true);
    const response = await harness.service.handle(message(
      "/tarik-izin",
      "pesan-tarik",
    ));

    assert.equal(typeof response, "string");
    assert.match(String(response), /Izin AI sudah ditarik/u);
    assert.equal(harness.consent, false);
    assert.equal(harness.historySuspended, 1);
    assert.equal(harness.memoriesSuspended, 1);
    assert.equal(harness.understandCalls, 0);
  });

  it("menampilkan dan menghapus memori melalui perintah teks", async () => {
    const harness = createHarness(true);
    const listed = await harness.service.handle(message("/memori", "memori-1"));
    assert.equal(typeof listed, "string");
    assert.match(String(listed), /Suka belajar dengan contoh visual/u);

    const forgotten = await harness.service.handle(message(
      "/lupakan 1",
      "memori-2",
    ));
    assert.match(String(forgotten), /sudah aku lupakan/u);
    assert.equal(harness.memoryCount, 0);
    assert.equal(harness.understandCalls, 0);
  });

  it("menghapus seluruh data lewat konfirmasi meski consent belum aktif", async () => {
    const harness = createHarness(false);
    const warning = await harness.service.handle(message(
      "/hapus-data",
      "hapus-data-1",
    ));
    assert.match(String(warning), /HAPUS SEMUA DATA/u);

    const deleted = await harness.service.handle(message(
      "HAPUS SEMUA DATA",
      "hapus-data-2",
    ));

    assert.match(String(deleted), /sudah dihapus/u);
    assert.equal(harness.deletedAll, 1);
    assert.equal(harness.consent, false);
    assert.equal(harness.understandCalls, 0);
  });
});

function createHarness(
  initialConsent: boolean,
  options: {
    noteTurnResponseFails?: boolean;
    interruptionRelation?: "addition" | "correction" | "redirect" |
      "independent";
    reply?: (
      text: string,
      runtime: ConversationRuntime,
    ) => Promise<string>;
  } = {},
): {
  service: WhatsAppPrivateConversation;
  readonly consent: boolean;
  readonly understandCalls: number;
  readonly delivered: number;
  readonly discarded: number;
  readonly historySuspended: number;
  readonly memoriesSuspended: number;
  readonly memoryCount: number;
  readonly deletedAll: number;
  history: ConversationTurn[];
  replyChannels: Array<ConversationRuntime["channel"]>;
  replyMessages: string[];
  turnOutcomes: string[];
} {
  let consent = initialConsent;
  let understandCalls = 0;
  let delivered = 0;
  let discarded = 0;
  let historySuspended = 0;
  let memoriesSuspended = 0;
  let deletedAll = 0;
  let sequence = 0;
  const history: ConversationTurn[] = [];
  const replyChannels: Array<ConversationRuntime["channel"]> = [];
  const replyMessages: string[] = [];
  const turnOutcomes: string[] = [];
  const memoryItems: MemoryItem[] = [{
    id: "memory-1",
    ownerId: "whatsapp-user:628777777777@s.whatsapp.net",
    kind: "preference",
    content: "Suka belajar dengan contoh visual",
    createdAt: "2026-08-22T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  }];
  const profile = (): UserProfile => ({
    ownerId: "whatsapp-user:628777777777@s.whatsapp.net",
    consentVersion: consent ? 7 : 0,
    onboardedAt: consent ? "2026-08-22T00:00:00.000Z" : null,
    stylePreference: null,
    styleAskedAt: null,
    timeZone: null,
    quietHours: null,
    quietHoursSetAt: null,
    consentWithdrawnAt: consent ? null : "2026-08-22T00:00:00.000Z",
    deletionRequestedAt: null,
  });
  const understanding: Understanding = {
    intent: "question",
    taskAction: null,
    memoryAction: null,
    riskHint: NO_RISK_HINT,
    safetySensitive: false,
    needsStepByStep: false,
    routingAssessment: null,
    task: null,
    memories: [],
    suggestedActions: [],
    actionGoal: null,
    controlAction: null,
    sessionSignal: null,
  };
  const dependencies = {
    conversation: {
      assessTurnBoundary: async () => ({
        state: "complete" as const,
        confidence: 0.95,
        continuationLikelihood: 0.05,
        reasonClass: "closed-request" as const,
      }),
      classifyTurnInterruption: async () =>
        options.interruptionRelation ?? "independent",
      understand: async () => {
        understandCalls += 1;
        return understanding;
      },
      triageRisk: async () => ({
        level: "biasa" as const,
        alone: false,
        sensitive: false,
        summary: "",
        certain: true,
      }),
      reply: async (
        _message: string,
        _understanding: Understanding,
        _context: unknown,
        _style: unknown,
        _triage: unknown,
        _insight: unknown,
        _raiseHelp: unknown,
        runtime: ConversationRuntime,
      ) => {
        replyChannels.push(runtime.channel);
        replyMessages.push(_message);
        return options.reply
          ? options.reply(_message, runtime)
          : "Jawaban privat WhatsApp";
      },
      reviewReply: async () => true,
      deterministicTimeReply: () => "Sekarang waktu uji.",
    },
    history: {
      context: async () => ({ summary: null, turns: [...history] }),
      append: async (_ownerId: string, role: "user" | "harvy", text: string) => {
        sequence += 1;
        const turn = {
          role,
          text,
          at: "2026-08-22T00:00:00.000Z",
          sequence,
        };
        history.push(turn);
        return turn;
      },
      compact: async () => undefined,
      allow: () => undefined,
      suspend: () => {
        historySuspended += 1;
      },
    },
    memories: {
      relevantTo: async () => [],
      list: async () => [...memoryItems],
      forget: async (_ownerId: string, id: string) => {
        const index = memoryItems.findIndex((item) => item.id === id);
        if (index < 0) return null;
        return memoryItems.splice(index, 1)[0] ?? null;
      },
      forgetAll: async () => {
        const count = memoryItems.length;
        memoryItems.splice(0, memoryItems.length);
        return count;
      },
      allow: () => undefined,
      suspend: () => {
        memoriesSuspended += 1;
      },
    },
    profiles: {
      load: async () => profile(),
      needsOnboarding: async () => !consent,
      acceptConsent: async () => {
        consent = true;
        return profile();
      },
      withdrawConsent: async () => {
        consent = false;
        return profile();
      },
    },
    sessions: {
      active: async () => null,
    },
    telemetry: {
      allow: async () => undefined,
      beginTurn: async () => undefined,
      noteTurnSignal: async () => undefined,
      noteTurnResponse: async () => {
        if (options.noteTurnResponseFails) {
          throw new Error("simulated telemetry failure");
        }
      },
      recordTurn: async (record: { outcome: string }) => {
        turnOutcomes.push(record.outcome);
      },
      markDelivered: async () => {
        delivered += 1;
        return null;
      },
      discardUndelivered: async () => {
        discarded += 1;
      },
    },
    dataControls: {
      deleteAll: async () => {
        deletedAll += 1;
        consent = false;
        history.splice(0, history.length);
        memoryItems.splice(0, memoryItems.length);
      },
    },
  } as unknown as WhatsAppPrivateConversationDependencies;
  const service = new WhatsAppPrivateConversation(
    dependencies,
    {
      defaultTimezone: "Asia/Jakarta",
      termsUrl: "https://harvy.id/terms",
      telemetryRetentionDays: 30,
      operationalLogRetentionDays: 14,
    },
  );

  return {
    service,
    get consent() {
      return consent;
    },
    get understandCalls() {
      return understandCalls;
    },
    get delivered() {
      return delivered;
    },
    get discarded() {
      return discarded;
    },
    get historySuspended() {
      return historySuspended;
    },
    get memoriesSuspended() {
      return memoriesSuspended;
    },
    get memoryCount() {
      return memoryItems.length;
    },
    get deletedAll() {
      return deletedAll;
    },
    history,
    replyChannels,
    replyMessages,
    turnOutcomes,
  };
}

function message(text: string, messageId: string): WhatsAppPrivateMessage {
  return {
    accountId: "utama",
    userId: "628777777777@s.whatsapp.net",
    messageId,
    text,
    at: "2026-08-22T00:00:00.000Z",
  };
}
