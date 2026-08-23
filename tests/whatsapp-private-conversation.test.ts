import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HarvyContext } from "../src/ai/context.js";
import type { Conversation, ConversationRuntime } from "../src/ai/conversation.js";
import type { RiskTriage } from "../src/ai/safety.js";
import type { Understanding } from "../src/ai/understand.js";
import { NO_RISK_HINT } from "../src/core/safety-policy.js";
import type { UserProfile } from "../src/domain/profile.js";
import type { ConversationTurn } from "../src/domain/history.js";
import type { MemoryItem } from "../src/domain/memory.js";
import type { StudentTask } from "../src/domain/task.js";
import type { ActiveSession } from "../src/domain/session.js";
import { AgentRunService } from "../src/core/agent-run-service.js";
import { FileAgentRunRepository } from
  "../src/storage/file-agent-run-repository.js";
import { privateAgentScope, scopeKey } from "../src/harness/scope.js";
import type { AgentRunCheckpoint } from "../src/harness/agent-harness.js";
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
  it("aritmetika sederhana memberi hasil exact tanpa model di WhatsApp", async () => {
    const harness = createHarness(true);
    const response = await harness.service.handle(
      message("berapa setengah ditambah seperempat?", "hitung-exact"),
    ) as WhatsAppPrivateReply;

    assert.equal(response.text, "Hasilnya 3/4.");
    assert.equal(harness.understandCalls, 0);
  });

  it("pengingat kosong mengumpulkan isi dan waktu tanpa balasan model", async () => {
    let replyCalls = 0;
    const harness = createHarness(true, {
      understand: async () => ({
        intent: "request",
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
        semanticOperation: null,
      }),
      reply: async () => {
        replyCalls += 1;
        return "jangan dipakai";
      },
    });

    const response = await harness.service.handle(
      message("buat pengingat dong", "reminder-kosong"),
    ) as WhatsAppPrivateReply;

    assert.equal(replyCalls, 0);
    assert.match(response.text, /apa.*kapan/iu);
    assert.equal(harness.tasks.length, 0);
  });

  it("mengubah zona waktu natural dengan capability yang sama seperti Telegram", async () => {
    const harness = createHarness(true, {
      understand: async () => ({
        intent: "control",
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
        controlAction: "timezone",
        sessionSignal: null,
        semanticOperation: null,
      }),
    });

    const response = await harness.service.handle(
      message("ubah zona waktuku ke WITA", "zona-natural"),
    ) as WhatsAppPrivateReply;

    assert.equal(harness.timeZone, "Asia/Makassar");
    assert.match(response.text, /WITA|Asia\/Makassar/iu);
  });

  it("menahan pesan pertama sampai consent lalu memakai pipeline WhatsApp", async () => {
    const harness = createHarness(false);
    const first = await harness.service.handle(message(
      "Tolong jelaskan konsep fotosintesis dengan contoh yang gampang dipahami.",
      "pesan-1",
    ));

    assert.equal(typeof first, "object");
    const onboarding = first as WhatsAppPrivateReply;
    assert.equal(onboarding.presentationBubbles?.[0], "👋");
    assert.equal(
      onboarding.presentationBubbles?.join("\n\n"),
      onboarding.text,
    );
    assert.match(onboarding.text, /balas SETUJU/i);
    assert.equal(harness.understandCalls, 0);
    assert.equal(harness.history.length, 0);

    const accepted = await harness.service.handle(message("SETUJU", "pesan-2"));
    assert.equal(typeof accepted, "object");
    const reply = accepted as WhatsAppPrivateReply;
    assert.match(reply.text, /Aku lanjutkan pesanmu yang tadi/i);
    assert.match(reply.text, /Jawaban privat WhatsApp/u);
    assert.deepEqual(reply.presentationBubbles?.slice(0, 2), [
      "😉",
      "Oke, kita mulai. Aku lanjutkan pesanmu yang tadi.",
    ]);
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

  it("meneruskan semantic public focus melalui runtime core yang sama", async () => {
    let runtimeSeen: ConversationRuntime | null = null;
    const publicFocus = {
      kind: "compare" as const,
      subject: "laptop A",
      contrast: "laptop B",
      purpose: "kebutuhan kuliahmu",
    };
    const harness = createHarness(true, {
      understand: async () => ({
        intent: "question",
        taskAction: null,
        memoryAction: null,
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        publicFocus,
        task: null,
        memories: [],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: null,
      }),
      reply: async (_text, runtime) => {
        runtimeSeen = runtime;
        return "Laptopnya sedang dibandingkan.";
      },
    });

    const result = await harness.service.handle(message(
      "laptop A atau B buat kuliah?",
      "progress-focus",
    ));

    assert.equal(typeof result, "object");
    assert.deepEqual(
      (runtimeSeen as ConversationRuntime | null)?.publicProgressFocus,
      publicFocus,
    );
  });

  it("menahan public focus ketika triase final masuk lane safety", async () => {
    let runtimeSeen: ConversationRuntime | null = null;
    const harness = createHarness(true, {
      understand: async () => ({
        intent: "feeling",
        taskAction: null,
        memoryAction: null,
        riskHint: {
          level: "possible",
          category: "acute_distress",
          confidence: 0.8,
        },
        safetySensitive: true,
        needsStepByStep: false,
        routingAssessment: null,
        publicFocus: {
          kind: "inspect",
          subject: "detail pribadi dari pesan berisiko",
          contrast: null,
          purpose: null,
        },
        task: null,
        memories: [],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: null,
      }),
      triageRisk: async () => ({
        level: "bahaya",
        alone: true,
        sensitive: true,
        summary: "sedang tidak aman",
        certain: true,
      }),
      reply: async (_text, runtime) => {
        runtimeSeen = runtime;
        return "Aku tetap di sini.";
      },
    });

    const result = await harness.service.handle(message(
      "situasinya rumit dan aku belum aman",
      "progress-safety",
    ));

    assert.equal(typeof result, "object");
    assert.equal(
      (runtimeSeen as ConversationRuntime | null)?.publicProgressFocus,
      null,
    );
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
    assert.match(privateReplyText(casualReply), /SETUJU/u);
  });

  it("tidak menahan atau memutar ulang command navigasi setelah consent", async () => {
    const harness = createHarness(false);

    const onboarding = await harness.service.handle(message("/menu", "nav-1"));
    assert.match(privateReplyText(onboarding), /balas SETUJU/iu);
    assert.equal(harness.understandCalls, 0);

    const accepted = await harness.service.handle(message("SETUJU", "nav-2"));
    const acceptedText = privateReplyText(accepted);
    assert.match(acceptedText, /Tulis aja apa yang ada di kepalamu/iu);
    assert.doesNotMatch(acceptedText, /Menu Harvy/iu);
    assert.equal(harness.understandCalls, 0);

    const menu = await harness.service.handle(message("/menu", "nav-3"));
    assert.match(privateReplyText(menu), /Menu Harvy/iu);
  });

  it("menjelaskan capability privat yang sama dengan surface teks WhatsApp", async () => {
    const harness = createHarness(false);
    const detail = String(await harness.service.handle(message(
      "/izin",
      "izin-detail",
    )));

    assert.match(detail, /pekerjaan planning yang berjalan di latar/iu);
    assert.match(detail, /sesi atau check-in/iu);
    assert.match(detail, /mengekspor data yang boleh kamu lihat/iu);
    assert.match(detail, /balas SETUJU/iu);
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
      sendDocument: async () => ({ messageId: "document-1" }),
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
    assert.equal(typeof listed, "object");
    assert.match((listed as WhatsAppPrivateReply).text, /Suka belajar dengan contoh visual/u);
    await (listed as WhatsAppPrivateReply).onDelivered?.();

    const forgotten = await harness.service.handle(message(
      "/lupakan 1",
      "memori-2",
    ));
    assert.match(String(forgotten), /sudah aku lupakan/u);
    assert.equal(harness.memoryCount, 0);
    assert.equal(harness.understandCalls, 0);
  });

  it("menampilkan /menu teks yang berbeda dari /bantuan tanpa model", async () => {
    const harness = createHarness(true);
    const menu = await harness.service.handle(message("/menu", "menu-1")) as
      WhatsAppPrivateReply;
    const help = await harness.service.handle(message("/bantuan", "menu-2")) as
      WhatsAppPrivateReply;
    assert.match(menu.text, /^Menu Harvy/u);
    assert.match(menu.text, /Penggunaan & paket/u);
    assert.match(help.text, /Contoh:/u);
    assert.notEqual(menu.text, help.text);
    assert.equal(harness.understandCalls, 0);
  });

  it("merender kategori menu natural dari katalog WhatsApp yang sama", async () => {
    const text = "tampilkan menu memori";
    const harness = createHarness(true, {
      understand: async () => ({
        ...semanticUnderstanding("show-summary", text, "explicit"),
        semanticOperation: {
          version: 1,
          domain: "menu",
          operation: "show-category",
          target: "memory",
          subject: "self",
          reference: "none",
          explicitness: "explicit",
          evidence: text,
          confidence: 0.98,
        },
      }),
    });

    const result = await harness.service.handle(message(text, "menu-natural")) as
      WhatsAppPrivateReply;
    assert.match(result.text, /^Memori & data/u);
    assert.match(result.text, /\/memori|\/lupakan/u);
    assert.doesNotMatch(result.text, /\/project|\/tugas/u);
    await result.onDelivered?.();
    assert.equal(harness.replyMessages.length, 0);
    assert.equal(harness.history.length, 0);
  });

  it("tidak mempertahankan transient surface yang gagal dikirim", async () => {
    const harness = createHarness(true);
    const menu = await harness.service.handle(message("/menu", "menu-fail")) as
      WhatsAppPrivateReply;
    await menu.onDeliveryFailed?.();

    const ordinary = await harness.service.handle(message(
      "aku ingin ngobrol biasa",
      "after-menu-fail",
    )) as WhatsAppPrivateReply;
    assert.deepEqual(harness.understandContexts[0]?.interactions, []);
    await ordinary.onDeliveryFailed?.();
  });

  it("membersihkan transient surface ketika consent ditarik", async () => {
    const harness = createHarness(true);
    const menu = await harness.service.handle(message("/menu", "menu-before-withdraw")) as
      WhatsAppPrivateReply;
    await menu.onDelivered?.();

    await harness.service.handle(message("/tarik-izin", "withdraw-after-menu"));
    await harness.service.handle(message("SETUJU", "accept-again"));
    const ordinary = await harness.service.handle(message(
      "aku ingin ngobrol biasa",
      "after-accept-again",
    )) as WhatsAppPrivateReply;

    assert.deepEqual(harness.understandContexts[0]?.interactions, []);
    await ordinary.onDeliveryFailed?.();
  });

  it("mempertahankan referen usage untuk follow-up natural tanpa history", async () => {
    let usageRead = 0;
    const harness = createHarness(true, {
      understand: async (text) => semanticUnderstanding(
        text === "detailnya" ? "show-details" : "show-summary",
        text,
        text === "detailnya" ? "contextual" : "explicit",
      ),
      economyHandle: async (_ownerId, input) => {
        usageRead += 1;
        return input.semanticOperation?.operation === "show-details"
          ? `detail usage terbaru ${usageRead}`
          : `ringkasan usage terbaru ${usageRead}`;
      },
    });

    const first = await harness.service.handle(message(
      "harvy berapa sisa penggunaan ku",
      "usage-natural-1",
    )) as WhatsAppPrivateReply;
    assert.match(first.text, /ringkasan usage terbaru 1/u);
    await first.onDelivered?.();

    const second = await harness.service.handle(message(
      "detailnya",
      "usage-natural-2",
    )) as WhatsAppPrivateReply;
    assert.match(second.text, /detail usage terbaru 2/u);
    const recentInteraction = harness.understandContexts[1]?.interactions?.[0];
    assert.equal(recentInteraction?.version, 1);
    assert.equal(recentInteraction?.domain, "usage");
    assert.equal(recentInteraction?.operation, "show-summary");
    assert.equal(recentInteraction?.reference, "current");
    assert.doesNotMatch(JSON.stringify(recentInteraction), /saldo|rupiah|token/iu);
    await second.onDelivered?.();

    assert.equal(usageRead, 2);
    assert.equal(harness.history.length, 0);
    assert.equal(harness.replyMessages.length, 0);
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

  it("mengirim ekspor data sebagai dokumen JSON, bukan memotongnya di chat", async () => {
    const harness = createHarness(true);
    const result = await harness.service.handle(message(
      "/ekspor",
      "export-data",
    )) as WhatsAppPrivateReply;

    assert.match(result.text, /berkas JSON/iu);
    assert.equal(result.document?.fileName, "harvy-data.json");
    assert.equal(result.document?.mimetype, "application/json");
    assert.match(result.document?.data.toString("utf8") ?? "", /whatsapp-user/iu);
  });

  it("menyimpan tugas natural lalu mengelolanya lewat surface teks WhatsApp", async () => {
    const text = "ingatkan aku mengumpulkan laporan besok";
    const harness = createHarness(true, {
      understand: async () => ({
        intent: "task",
        taskAction: "save",
        memoryAction: null,
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        task: {
          title: "Mengumpulkan laporan",
          dueAt: new Date("2026-08-24T12:00:00.000Z"),
          remindAt: null,
          importance: 2,
        },
        memories: [],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: {
          version: 1,
          domain: "task",
          operation: "save",
          target: "mengumpulkan laporan",
          subject: "self",
          reference: "none",
          explicitness: "explicit",
          evidence: text,
          confidence: 0.99,
        },
      }),
    });

    const saved = await harness.service.handle(message(text, "task-natural")) as
      WhatsAppPrivateReply;
    assert.match(saved.text, /Mengumpulkan laporan/u);
    assert.equal(harness.tasks.length, 1);
    assert.match(harness.tasks[0]!.chatId, /^whatsapp-private:/u);
    await saved.onDelivered?.();

    const listed = await harness.service.handle(message("/tugas", "task-list"));
    assert.match(String(listed), /task-1/u);
    const completed = await harness.service.handle(message(
      "/selesai task-1",
      "task-done",
    ));
    assert.match(String(completed), /Selesai|Beres|Kelar/u);
    assert.equal(harness.tasks[0]!.status, "completed");
    assert.equal(harness.replyMessages.length, 0);
  });

  it("menjalankan sesi dan menjadwalkan check-in lewat WhatsApp privat", async () => {
    const harness = createHarness(true);
    const started = await harness.service.handle(message(
      "/sesi mulai fokus menyelesaikan pendahuluan",
      "session-start",
    ));
    assert.match(String(started), /Sesi dimulai/u);
    assert.equal(harness.activeSession?.kind, "focus");
    assert.match(harness.activeSession?.chatId ?? "", /^whatsapp-private:/u);

    const scheduled = await harness.service.handle(message(
      "/checkin 30 menit lagi",
      "session-checkin",
    ));
    assert.match(String(scheduled), /bertanya sekali/u);
    assert.equal(
      harness.activeSession?.checkIn?.at,
      "2026-08-24T12:00:00.000Z",
    );

    const stopped = await harness.service.handle(message(
      "/sesi berhenti",
      "session-stop",
    ));
    assert.match(String(stopped), /berhenti/u);
    assert.equal(harness.activeSession, null);
  });

  it("planning eksplisit tidak diturunkan menjadi reply sesi biasa di WhatsApp", async () => {
    let agentCalls = 0;
    const harness = createHarness(true, {
      agent: async (_text, mode, _context, runtime) => {
        agentCalls += 1;
        assert.equal(mode, "orchestrate");
        assert.equal(runtime?.channel, "whatsapp");
        return {
          status: "completed",
          reply: "Rencana mendalam dari Agent Runtime.",
          checkpoint: {} as never,
          trace: [],
        };
      },
      reply: async () => {
        throw new Error("planning explicit tidak boleh memakai reply sesi biasa");
      },
    });
    await harness.service.handle(message(
      "/sesi mulai fokus menyusun rencana belajar ujian",
      "session-plan-start",
    ));

    const planned = await harness.service.handle(message(
      "Tolong buatkan rencana belajar ujian langkah demi langkah.",
      "session-plan-request",
    ));

    assert.equal(agentCalls, 1);
    assert.match(privateReplyText(planned), /Agent Runtime/u);
  });

  it("menahan memori sensitif sampai izin eksplisit terlihat", async () => {
    const sensitiveText = "Aku punya kondisi kesehatan yang perlu kamu ingat";
    const harness = createHarness(true, {
      memoryPrivacy: true,
      understand: async () => ({
        intent: "smalltalk",
        taskAction: null,
        memoryAction: null,
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        task: null,
        memories: [{ kind: "personal", content: "Punya kondisi kesehatan" }],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: null,
      }),
    });

    const response = await harness.service.handle(message(
      sensitiveText,
      "memory-sensitive",
    )) as WhatsAppPrivateReply;
    assert.match(response.text, /SIMPAN MEMORI/u);
    assert.equal(harness.memoryCount, 1);
    await response.onDelivered?.();

    const confirmed = await harness.service.handle(message(
      "SIMPAN MEMORI",
      "memory-sensitive-confirm",
    ));
    assert.match(String(confirmed), /izinmu/u);
    assert.equal(harness.memoryCount, 2);
  });

  it("menahan memori biasa implisit meski classifier model menilainya aman", async () => {
    const harness = createHarness(true, {
      memoryPrivacy: false,
      understand: async () => ({
        intent: "smalltalk",
        taskAction: null,
        memoryAction: null,
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        task: null,
        memories: [{ kind: "preference", content: "Lebih suka jawaban bertahap" }],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: null,
      }),
      reply: async () => "Aku simpan preferensimu ya.",
    });

    const response = await harness.service.handle(message(
      "aku lebih suka jawaban bertahap",
      "memory-ordinary",
    )) as WhatsAppPrivateReply;
    assert.equal(harness.memoryCount, 1);
    assert.doesNotMatch(response.text, /Aku simpan preferensimu/iu);
    assert.match(response.text, /SIMPAN MEMORI/u);
    await response.onDelivered?.();

    const confirmed = await harness.service.handle(message(
      "SIMPAN MEMORI",
      "memory-ordinary-confirm",
    ));
    assert.match(String(confirmed), /izinmu/u);
    assert.equal(harness.memoryCount, 2);
  });

  it("menawarkan preferensi durable yang jelas ketika extractor model melewatkannya", async () => {
    const harness = createHarness(true, {
      reply: async () => "Oke, aku akan menjawab lebih terstruktur.",
    });

    const response = await harness.service.handle(message(
      "Mulai sekarang, aku lebih suka semua jawaban memakai langkah pendek dan bernomor.",
      "memory-local-fallback",
    )) as WhatsAppPrivateReply;

    assert.match(response.text, /SIMPAN MEMORI|JANGAN SIMPAN/iu);
    assert.equal(harness.memoryCount, 1, "kandidat belum boleh ditulis");
  });

  it("menjalankan AgentRun durable dan mengirim hasil proaktif di WhatsApp", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-wa-private-agent-"));
    const agentRuns = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const sent: string[] = [];
    const edited: string[] = [];
    const removed: string[] = [];
    const pinStates: boolean[] = [];
    const ownerId = "whatsapp-user:628777777777@s.whatsapp.net";
    const request = "Tolong buatkan rencana langkah demi langkah untuk ujian.";
    const agent: Conversation["agent"] = async (
      messageText,
      _mode,
      _context,
      runtime,
    ) => ({
      status: "completed",
      reply: "Rencana ujian yang sudah memakai state live.",
      checkpoint: agentCheckpoint(
        runtime?.runId ?? "missing-run-id",
        ownerId,
        messageText,
      ),
      trace: [],
    });
    const harness = createHarness(true, {
      agent,
      agentRuns,
      proactive: {
        send: async (_accountId, _userId, text) => {
          sent.push(text);
        },
        sendTracked: async (_accountId, _userId, text) => {
          sent.push(text);
          return { messageIds: [`wa-out-${sent.length}`] };
        },
        editTracked: async (_accountId, _userId, messageId, text) => {
          edited.push(text);
          return { messageId };
        },
        removeTracked: async (_accountId, _userId, messageId) => {
          removed.push(messageId);
        },
        setPinned: async (_accountId, _userId, _messageId, pinned) => {
          pinStates.push(pinned);
        },
      },
    });

    const anchor = await harness.service.handle(message(request, "agent-start")) as
      WhatsAppPrivateReply;
    assert.match(anchor.text, /Pekerjaan|Antrean|Menyusun/iu);
    assert.deepEqual(anchor.presentationBubbles, [anchor.text]);
    await anchor.onDelivered?.({
      text: anchor.text,
      bubbleCount: 1,
      complete: true,
      messageIds: ["wa-anchor-1"],
    });

    await waitUntil(async () =>
      (await agentRuns.loadActive("whatsapp", ownerId))?.status === "completed"
    );
    const completed = await agentRuns.loadActive("whatsapp", ownerId);
    assert.equal(completed?.anchor.messageId, "wa-anchor-1");
    assert.equal(completed?.receipts[0]?.effect, "whatsapp.message.send");
    assert.deepEqual(sent, ["Rencana ujian yang sudah memakai state live."]);
    assert.match(edited.at(-1) ?? "", /Selesai/iu);
    assert.deepEqual(removed, []);
    assert.deepEqual(pinStates, [true, false]);
    assert.equal(
      harness.history.at(-1)?.text,
      "Rencana ujian yang sudah memakai state live.",
    );
    await harness.service.drain();
  });

  it("tidak menggandakan Run Anchor bila edit dan penghapusan lama sama-sama gagal", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-wa-private-anchor-fail-"));
    const agentRuns = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const ownerId = "whatsapp-user:628777777777@s.whatsapp.net";
    const request = "Tolong buatkan rencana audit langkah demi langkah.";
    let replacementSends = 0;
    let removeAttempts = 0;
    const pinStates: boolean[] = [];
    const harness = createHarness(true, {
      agentRuns,
      agent: async (messageText, _mode, _context, runtime) => ({
        status: "completed",
        reply: "Rencana audit selesai tanpa menggandakan anchor.",
        checkpoint: agentCheckpoint(
          runtime?.runId ?? "missing-run-id",
          ownerId,
          messageText,
        ),
        trace: [],
      }),
      proactive: {
        send: async () => undefined,
        sendTracked: async (_accountId, _userId, text) => {
          if (/^📌\s/u.test(text)) replacementSends += 1;
          return { messageIds: ["tracked-message"] };
        },
        editTracked: async () => {
          throw new Error("simulated edit failure");
        },
        removeTracked: async () => {
          removeAttempts += 1;
          throw new Error("simulated remove failure");
        },
        setPinned: async (_accountId, _userId, _messageId, pinned) => {
          pinStates.push(pinned);
        },
      },
    });

    const anchor = await harness.service.handle(message(request, "anchor-fail")) as
      WhatsAppPrivateReply;
    await anchor.onDelivered?.({
      text: anchor.text,
      bubbleCount: 1,
      complete: true,
      messageIds: ["original-anchor"],
    });
    await waitUntil(async () =>
      (await agentRuns.loadActive("whatsapp", ownerId))?.status === "completed"
    );
    await harness.service.drain();

    assert.ok(removeAttempts >= 1);
    assert.equal(replacementSends, 0);
    assert.deepEqual(pinStates, [true, false]);
  });

  it("mengimpor ZIP project melalui authority privat WhatsApp yang tepercaya", async () => {
    let uploaded = Buffer.alloc(0);
    let actorChannel = "";
    const codingRuntime = {
      issuePrivateActor: (source: { channel: string }) => {
        actorChannel = source.channel;
        return { actor: "trusted" };
      },
      application: {
        uploadZip: async (_actor: unknown, data: Buffer) => {
          uploaded = Buffer.from(data);
          return {
            workspaceKey: "workspace:wa",
            projectId: "project-wa",
            projectRevision: 1,
          };
        },
      },
      privateGitHub: null,
    } as unknown as NonNullable<
      WhatsAppPrivateConversationDependencies["codingRuntime"]
    >;
    const harness = createHarness(true, { codingRuntime });
    const response = await harness.service.handle({
      ...message("", "zip-upload"),
      document: {
        fileName: "project.zip",
        mimetype: "application/zip",
        declaredBytes: 7,
        data: Buffer.from("PK fixture", "utf8"),
      },
    });

    assert.match(String(response), /Project ZIP sudah diimpor/u);
    assert.equal(actorChannel, "whatsapp");
    assert.equal(uploaded.toString("utf8"), "PK fixture");
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
    understand?: (
      text: string,
      context: HarvyContext,
    ) => Promise<Understanding | null>;
    triageRisk?: () => Promise<RiskTriage>;
    memoryPrivacy?: boolean;
    economyHandle?: (
      ownerId: string,
      input: {
        rawText: string;
        semanticOperation: Understanding["semanticOperation"];
      },
    ) => Promise<string | null>;
    agent?: Conversation["agent"];
    agentRuns?: AgentRunService;
    proactive?: NonNullable<WhatsAppPrivateConversationDependencies["proactive"]>;
    codingRuntime?: NonNullable<
      WhatsAppPrivateConversationDependencies["codingRuntime"]
    >;
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
  understandContexts: HarvyContext[];
  turnOutcomes: string[];
  tasks: StudentTask[];
  readonly activeSession: ActiveSession | null;
  readonly timeZone: string | null;
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
  const understandContexts: HarvyContext[] = [];
  const turnOutcomes: string[] = [];
  const taskItems: StudentTask[] = [];
  let activeSession: ActiveSession | null = null;
  let storedTimeZone: string | null = null;
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
    timeZone: storedTimeZone,
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
    semanticOperation: null,
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
      understand: async (text: string, context: HarvyContext) => {
        understandCalls += 1;
        understandContexts.push(context);
        return options.understand
          ? options.understand(text, context)
          : understanding;
      },
      triageRisk: async () => options.triageRisk
        ? options.triageRisk()
        : ({
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
      understandDueDate: async () => new Date("2026-08-24T12:00:00.000Z"),
      assessMemoryPrivacy: async () => options.memoryPrivacy ?? false,
      ...(options.agent ? { agent: options.agent } : {}),
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
      remember: async (input: {
        ownerId: string;
        kind: MemoryItem["kind"];
        content: string;
      }) => {
        const item: MemoryItem = {
          id: `memory-${memoryItems.length + 1}`,
          ownerId: input.ownerId,
          kind: input.kind,
          content: input.content,
          createdAt: "2026-08-22T00:00:00.000Z",
          lastUsedAt: null,
          expiresAt: null,
        };
        memoryItems.push(item);
        return item;
      },
      markUsed: async () => undefined,
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
      rememberStyle: async () => profile(),
      setTimeZone: async (_ownerId: string, timeZone: string) => {
        storedTimeZone = timeZone;
        return profile();
      },
      setQuietHours: async () => profile(),
    },
    sessions: {
      active: async () => activeSession,
      start: async (input: {
        ownerId: string;
        chatId: string;
        kind: ActiveSession["kind"];
        goal: string;
      }) => {
        activeSession = {
          id: "session-wa-1",
          ownerId: input.ownerId,
          chatId: input.chatId,
          kind: input.kind,
          goal: input.goal,
          stage: input.kind === "tutor" ? "assess" : "act",
          taskId: null,
          checkIn: null,
          createdAt: "2026-08-22T00:00:00.000Z",
          updatedAt: "2026-08-22T00:00:00.000Z",
          expiresAt: "2026-08-30T00:00:00.000Z",
        };
        return activeSession;
      },
      progress: async (_ownerId: string, signal: string | null) => {
        if (!activeSession) return null;
        if (signal === "done" || signal === "cancel") {
          activeSession = null;
          return null;
        }
        return activeSession;
      },
      scheduleCheckIn: async (_ownerId: string, at: Date) => {
        if (!activeSession) return null;
        activeSession = {
          ...activeSession,
          checkIn: { at: at.toISOString(), sentAt: null },
        };
        return activeSession;
      },
      stop: async () => {
        const stopped = activeSession;
        activeSession = null;
        return stopped;
      },
      deliverCheckIn: async () => false,
    },
    tasks: {
      create: async (input: {
        ownerId: string;
        chatId: string;
        title: string;
        dueAt: Date | null;
        remindAt: Date | null;
        importance: 1 | 2 | 3;
      }) => {
        const task: StudentTask = {
          id: `task-${taskItems.length + 1}`,
          ownerId: input.ownerId,
          chatId: input.chatId,
          title: input.title,
          dueAt: input.dueAt?.toISOString() ?? null,
          importance: input.importance,
          status: "active",
          createdAt: "2026-08-22T00:00:00.000Z",
          completedAt: null,
          reminderAt: input.remindAt?.toISOString() ?? null,
          reminderSentAt: null,
        };
        taskItems.push(task);
        return task;
      },
      listActive: async () => taskItems.filter((task) => task.status === "active"),
      find: async (_ownerId: string, id: string) =>
        taskItems.find((task) => task.id === id) ?? null,
      complete: async (_ownerId: string, id: string) => {
        const index = taskItems.findIndex((task) => task.id === id);
        if (index < 0) return null;
        taskItems[index] = {
          ...taskItems[index]!,
          status: "completed",
          completedAt: "2026-08-22T01:00:00.000Z",
        };
        return taskItems[index]!;
      },
      remove: async (_ownerId: string, id: string) => {
        const index = taskItems.findIndex((task) => task.id === id);
        return index < 0 ? null : taskItems.splice(index, 1)[0] ?? null;
      },
      setDue: async (_ownerId: string, id: string, at: Date | null) => {
        const task = taskItems.find((candidate) => candidate.id === id);
        if (!task) return null;
        task.dueAt = at?.toISOString() ?? null;
        return task;
      },
      setReminder: async (_ownerId: string, id: string, at: Date) => {
        const task = taskItems.find((candidate) => candidate.id === id);
        if (!task) return null;
        task.reminderAt = at.toISOString();
        return task;
      },
      deliverReminder: async () => false,
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
      export: async (ownerId: string) => ({
        version: 4,
        exportedAt: "2026-08-22T00:00:00.000Z",
        ownerId,
      }),
      deleteAll: async () => {
        deletedAll += 1;
        consent = false;
        history.splice(0, history.length);
        memoryItems.splice(0, memoryItems.length);
      },
    },
    ...(options.agentRuns ? { agentRuns: options.agentRuns } : {}),
    ...(options.proactive ? { proactive: options.proactive } : {}),
    ...(options.codingRuntime ? { codingRuntime: options.codingRuntime } : {}),
    economyCommands: {
      handle: async (
        ownerId: string,
        input: {
          rawText: string;
          semanticOperation: Understanding["semanticOperation"];
        },
      ) => options.economyHandle?.(ownerId, input) ?? null,
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
    understandContexts,
    turnOutcomes,
    tasks: taskItems,
    get activeSession() {
      return activeSession;
    },
    get timeZone() {
      return storedTimeZone;
    },
  };
}

function semanticUnderstanding(
  operation: "show-summary" | "show-details",
  evidence: string,
  explicitness: "explicit" | "contextual",
): Understanding {
  return {
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
    semanticOperation: {
      version: 1,
      domain: "usage",
      operation,
      target: null,
      subject: "self",
      reference: explicitness === "contextual" ? "recent" : "none",
      explicitness,
      evidence,
      confidence: 0.98,
    },
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

function privateReplyText(result: unknown): string {
  if (typeof result === "string") return result;
  if (
    result && typeof result === "object" && "text" in result &&
    typeof result.text === "string"
  ) {
    return result.text;
  }
  return "";
}

function agentCheckpoint(
  runId: string,
  ownerId: string,
  request: string,
): AgentRunCheckpoint {
  const startedAt = new Date();
  return {
    version: 1,
    runId,
    scopeKey: scopeKey(privateAgentScope("whatsapp", ownerId)),
    capabilityHash: "a".repeat(16),
    callableHash: "b".repeat(64),
    request,
    startedAt: startedAt.toISOString(),
    deadlineAt: new Date(startedAt.getTime() + 9 * 60_000).toISOString(),
    maxSteps: 6,
    step: 0,
    observations: [],
    userInputs: [],
    seenActionDigests: [],
    pending: null,
    pendingInput: null,
  };
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Kondisi async tidak tercapai sebelum timeout.");
}
