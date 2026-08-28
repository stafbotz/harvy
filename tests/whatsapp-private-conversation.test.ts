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
import { CONSENT_VERSION } from "../src/core/profile-service.js";
import type { UserProfile } from "../src/domain/profile.js";
import type { ConversationTurn } from "../src/domain/history.js";
import type { MemoryItem, NewMemory } from "../src/domain/memory.js";
import type { StudentTask } from "../src/domain/task.js";
import type { ActiveSession } from "../src/domain/session.js";
import type { SessionService } from "../src/core/session-service.js";
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
    const harness = createHarness(true, { failContextRead: true });
    const response = await harness.service.handle(
      message("berapa setengah ditambah seperempat?", "hitung-exact"),
    ) as WhatsAppPrivateReply;

    assert.equal(response.text, "Hasilnya 3/4.");
    assert.equal(harness.understandCalls, 0);

    const numbersOnly = await harness.service.handle(
      message("Sekarang jawab 17+28 dengan angka saja.", "hitung-angka-saja"),
    ) as WhatsAppPrivateReply;

    assert.equal(numbersOnly.text, "45");
    assert.equal(harness.understandCalls, 0);
  });

  it("pengingat kosong meminta detail melalui balasan model", async () => {
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
        return "Apa yang perlu kuingatkan, dan kapan waktunya?";
      },
    });

    const response = await harness.service.handle(
      message("buat pengingat dong", "reminder-kosong"),
    ) as WhatsAppPrivateReply;

    assert.equal(replyCalls, 1);
    assert.equal(response.text, "Apa yang perlu kuingatkan, dan kapan waktunya?");
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

  it("tidak mengunduh gambar sebelum consent dan meminta pengguna mengirim ulang", async () => {
    let loads = 0;
    const harness = createHarness(false);
    const response = await harness.service.handle({
      ...message("", "image-before-consent"),
      image: {
        mediaType: "image/png",
        declaredBytes: 8,
        data: Buffer.alloc(0),
        loadData: async () => {
          loads += 1;
          return Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        },
      },
    });

    assert.equal(loads, 0);
    assert.match(privateReplyText(response), /kirim ulang gambarnya/iu);
    assert.equal(harness.understandCalls, 0);
    assert.equal(harness.history.length, 0);

    const accepted = await harness.service.handle(message(
      "SETUJU",
      "image-consent-accepted",
    ));
    assert.equal(harness.understandCalls, 0);
    assert.doesNotMatch(privateReplyText(accepted), /Jawaban privat WhatsApp/u);
  });

  it("meneruskan gambar sesudah consent tanpa menyimpan byte ke history", async () => {
    let loads = 0;
    let runtimeSeen: ConversationRuntime | null = null;
    const harness = createHarness(true, {
      reply: async (_text, runtime) => {
        runtimeSeen = runtime;
        return "Aku melihat bidang berwarna pada gambar.";
      },
    });
    const response = await harness.service.handle({
      ...message("Warna dominannya apa?", "image-after-consent"),
      image: {
        mediaType: "image/png",
        declaredBytes: 8,
        data: Buffer.alloc(0),
        loadData: async () => {
          loads += 1;
          return Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
        },
      },
    }) as WhatsAppPrivateReply;

    assert.equal(loads, 1);
    assert.equal(harness.understandCalls, 0);
    assert.equal(
      (runtimeSeen as ConversationRuntime | null)?.images?.length,
      1,
    );
    assert.equal(
      (runtimeSeen as ConversationRuntime | null)?.images?.[0]?.mediaType,
      "image/png",
    );
    assert.equal(
      (runtimeSeen as ConversationRuntime | null)?.images?.[0]?.detail,
      "low",
    );
    assert.equal(
      (runtimeSeen as ConversationRuntime | null)?.images?.[0]?.data.byteLength,
      8,
    );
    assert.deepEqual(harness.history.map((turn) => turn.text), [
      "Warna dominannya apa?",
    ]);
    assert.doesNotMatch(JSON.stringify(harness.history), /iVBOR|89504e47/iu);
    await response.onDelivered?.();
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

  it("tidak mengubah pertanyaan progres live menjadi usage tanpa receipt usage", async () => {
    const liveMessage =
      "Aku kembali. Apa yang sudah selesai, apa yang masih belum dapat dipercaya, dan apa langkah berikutnya? Jangan minta aku mengulang konteks.";
    let usageRead = 0;
    const harness = createHarness(true, {
      understand: async () =>
        semanticUnderstanding("show-details", liveMessage, "contextual"),
      economyHandle: async () => {
        usageRead += 1;
        return "Penggunaan Harvy yang tidak diminta";
      },
      reply: async () =>
        "Keputusan utama: lanjutkan pekerjaan dari critical incident terakhir.",
    });

    const result = await harness.service.handle(
      message(liveMessage, "live-progress-not-usage"),
    );

    assert.match(privateReplyText(result), /Keputusan utama/u);
    assert.doesNotMatch(privateReplyText(result), /Penggunaan Harvy/u);
    assert.equal(usageRead, 0);
    assert.deepEqual(harness.understandContexts[0]?.interactions, []);
  });

  it("tidak membiarkan usage explicit membajak penilaian produk nonmekanis", async () => {
    const liveMessage =
      "Menurutmu, apakah pengujian live ini cukup membuktikan Harvy siap dipakai sehari-hari? Nilai bukti dan celah yang masih berisiko.";
    let usageRead = 0;
    let agentCalls = 0;
    const harness = createHarness(true, {
      understand: async () => ({
        ...modelPlanningUnderstanding(),
        routingAssessment: {
          complexity: "normal",
          ambiguity: "medium",
          planningRequired: false,
          emotionalNuance: "low",
          executionSize: "medium",
          factualStakes: "low",
          transformationMechanical: false,
          toolNeed: "internal_state",
          confidence: 0.95,
        },
        semanticOperation: {
          version: 1,
          domain: "usage",
          operation: "show-details",
          target: liveMessage,
          subject: "self",
          reference: "none",
          explicitness: "explicit",
          evidence: liveMessage,
          confidence: 0.95,
        },
      }),
      economyHandle: async () => {
        usageRead += 1;
        return "Penggunaan Harvy yang tidak diminta";
      },
      agent: async () => {
        agentCalls += 1;
        throw new Error("internal_state model tanpa preflight bukan authority tool");
      },
      reply: async () =>
        "Penilaian kesiapan produk berdasarkan bukti live.",
    });

    const result = await harness.service.handle(
      message(liveMessage, "live-product-assessment-not-usage"),
    );

    assert.equal(usageRead, 0);
    assert.equal(agentCalls, 0);
    assert.match(privateReplyText(result), /Penilaian kesiapan produk/u);
    assert.doesNotMatch(privateReplyText(result), /Penggunaan Harvy/u);
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
    assert.doesNotMatch(saved.text, /\bID:/u);
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

  it("menyelesaikan task lewat bahasa natural dan tidak hanya mengklaim berhasil", async () => {
    const text = "Tandai tugas mencatat hasil restart itu selesai.";
    const harness = createHarness(true, {
      understand: async () => ({
        ...semanticUnderstanding("show-summary", text, "explicit"),
        intent: "request" as const,
        routingAssessment: {
          complexity: "mechanical" as const,
          ambiguity: "low" as const,
          planningRequired: false,
          emotionalNuance: "low" as const,
          executionSize: "small" as const,
          factualStakes: "low" as const,
          transformationMechanical: true,
          toolNeed: "internal_state" as const,
          confidence: 0.99,
        },
        semanticOperation: {
          version: 1 as const,
          domain: "task" as const,
          operation: "complete" as const,
          target: "mencatat hasil restart",
          subject: "self" as const,
          reference: "recent" as const,
          explicitness: "explicit" as const,
          evidence: text,
          confidence: 0.99,
        },
      }),
    });
    harness.tasks.push({
      id: "task-natural-complete",
      ownerId: "whatsapp-private:tester",
      chatId: "whatsapp-private:tester",
      title: "Mencatat hasil restart",
      dueAt: null,
      importance: 2,
      status: "active",
      createdAt: "2026-08-24T12:00:00.000Z",
      completedAt: null,
      reminderAt: null,
      reminderSentAt: null,
    });

    const result = await harness.service.handle(
      message(text, "task-natural-complete-message"),
    ) as WhatsAppPrivateReply;

    assert.equal(harness.tasks[0]?.status, "completed");
    assert.match(result.text, /Mencatat hasil restart/u);
    assert.doesNotMatch(result.text, /\bID:/u);
  });

  it("mengubah tenggat dan pengingat task natural tanpa membuat record baru", async () => {
    const saveText =
      "Besok pukul 09.00 saya harus meninjau hasil uji live Telegram dan WhatsApp. Catat sebagai tugas penting dan ingatkan saya 30 menit sebelumnya.";
    const updateText =
      "Jadwalnya berubah: ubah tugas peninjauan itu menjadi besok pukul 10.30 dan ingatkan satu jam sebelumnya. Jangan buat tugas baru.";
    const harness = createHarness(true, {
      understand: async (text) => text === saveText
        ? {
            ...semanticUnderstanding("show-summary", text, "explicit"),
            intent: "task" as const,
            taskAction: "save" as const,
            task: {
              title: "Meninjau hasil uji live Telegram dan WhatsApp",
              dueAt: new Date("2099-08-25T02:00:00.000Z"),
              remindAt: new Date("2099-08-25T01:30:00.000Z"),
              importance: 3 as const,
            },
            semanticOperation: {
              version: 1 as const,
              domain: "task" as const,
              operation: "save" as const,
              target: "meninjau hasil uji live Telegram dan WhatsApp",
              subject: "self" as const,
              reference: "none" as const,
              explicitness: "explicit" as const,
              evidence: saveText,
              confidence: 0.99,
            },
          }
        : {
            ...semanticUnderstanding("show-summary", text, "explicit"),
            intent: "task" as const,
            taskAction: "save" as const,
            task: {
              title: "Tugas peninjauan",
              dueAt: new Date("2099-08-25T03:30:00.000Z"),
              remindAt: new Date("2099-08-25T02:30:00.000Z"),
              importance: 2 as const,
            },
            semanticOperation: {
              version: 1 as const,
              domain: "task" as const,
              operation: "update" as const,
              target: "tugas peninjauan",
              subject: "self" as const,
              reference: "recent" as const,
              explicitness: "explicit" as const,
              evidence: updateText,
              confidence: 0.99,
            },
          },
    });

    await harness.service.handle(message(saveText, "task-natural-update-save"));
    const updated = await harness.service.handle(message(
      updateText,
      "task-natural-update-apply",
    )) as WhatsAppPrivateReply;

    assert.equal(harness.tasks.length, 1);
    assert.equal(harness.tasks[0]?.dueAt, "2099-08-25T03:30:00.000Z");
    assert.equal(harness.tasks[0]?.reminderAt, "2099-08-25T02:30:00.000Z");
    assert.match(updated.text, /10\.30/u);
    assert.match(updated.text, /09\.30/u);
  });

  it("membaca daftar task dari bahasa natural tanpa mengekspos ID teknis", async () => {
    const text =
      "Sekarang sebutkan tugas aktifku dan kapan pengingatnya. Jangan tampilkan ID teknis.";
    const harness = createHarness(true, {
      understand: async () => ({
        ...semanticUnderstanding("show-summary", text, "explicit"),
        intent: "request" as const,
        semanticOperation: {
          version: 1 as const,
          domain: "task" as const,
          operation: "list" as const,
          target: null,
          subject: "self" as const,
          reference: "all" as const,
          explicitness: "explicit" as const,
          evidence: text,
          confidence: 0.99,
        },
      }),
    });
    harness.tasks.push({
      id: "task-private-technical",
      ownerId: "whatsapp-private:tester",
      chatId: "whatsapp-private:tester",
      title: "Meninjau hasil uji live Telegram dan WhatsApp",
      dueAt: "2026-08-25T03:30:00.000Z",
      importance: 3,
      status: "active",
      createdAt: "2026-08-24T12:00:00.000Z",
      completedAt: null,
      reminderAt: "2026-08-25T02:30:00.000Z",
      reminderSentAt: null,
    });

    const listed = await harness.service.handle(
      message(text, "task-natural-list"),
    ) as WhatsAppPrivateReply;

    assert.match(listed.text, /Meninjau hasil uji live/u);
    assert.match(listed.text, /10\.30/u);
    assert.match(listed.text, /09\.30/u);
    assert.doesNotMatch(listed.text, /task-private-technical|\bID:/u);
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
      "2099-08-25T12:00:00.000Z",
    );

    const stopped = await harness.service.handle(message(
      "/sesi berhenti",
      "session-stop",
    ));
    assert.match(String(stopped), /berhenti/u);
    assert.equal(harness.activeSession, null);
  });

  it("memakai presentation model bersama untuk empty state dan fakta tetap code-owned", async () => {
    let seenKind = "";
    let seenChannel: ConversationRuntime["channel"];
    const harness = createHarness(true, {
      presentOperation: async (brief, _context, _style, runtime) => {
        seenKind = brief.kind;
        seenChannel = runtime?.channel;
        return `Aku sudah melihat keadaan daftarmu.\n\n${brief.stableBody}`;
      },
    });

    const response = await harness.service.handle(message("/tugas", "dynamic-list"));

    assert.equal(seenKind, "empty-state");
    assert.equal(seenChannel, "whatsapp");
    assert.equal(
      String(response),
      "Aku sudah melihat keadaan daftarmu.\n\nTugas aktif: tidak ada.",
    );
  });

  it("membuat check-in WhatsApp dari model sebelum delivery dan menyimpan teks terkirim", async () => {
    let seenChannel: ConversationRuntime["channel"];
    const harness = createHarness(true, {
      presentScheduledCheckIn: async (_session, _style, runtime) => {
        seenChannel = runtime?.channel;
        return "Sesi tadi masih terasa pas untuk dilanjutkan, atau kamu ingin berhenti dulu?";
      },
      deliverCheckIn: async (candidate, deliver) => {
        await deliver(candidate);
        return true;
      },
    });
    await harness.service.handle(message(
      "/sesi mulai fokus menyelesaikan pendahuluan",
      "dynamic-checkin-session",
    ));
    await harness.service.handle(message(
      "/checkin 30 menit lagi",
      "dynamic-checkin-schedule",
    ));
    const candidate = harness.activeSession!;
    const sent: string[] = [];

    assert.equal(
      await harness.service.sendScheduledCheckIn(
        candidate,
        async (_accountId, _userId, text) => {
          sent.push(text);
        },
      ),
      true,
    );
    assert.equal(seenChannel, "whatsapp");
    assert.deepEqual(sent, [
      "Sesi tadi masih terasa pas untuk dilanjutkan, atau kamu ingin berhenti dulu?",
    ]);
    assert.equal(harness.history.at(-1)?.text, sent[0]);
  });

  it("assessment planning tanpa kata kunci tidak diturunkan menjadi reply sesi biasa", async () => {
    let agentCalls = 0;
    const harness = createHarness(true, {
      understand: async () => modelPlanningUnderstanding(),
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
      "Bantu susun strategi belajar ujian yang saling bergantung.",
      "session-plan-request",
    ));

    assert.equal(agentCalls, 1);
    assert.match(privateReplyText(planned), /Agent Runtime/u);
  });

  it("tidak menjalankan agent ketika pengguna hanya menceritakan pekerjaan rumit", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = createHarness(true, {
      understand: async () => ({
        ...modelPlanningUnderstanding(),
        intent: "feeling",
        taskAction: "offer",
        routingAssessment: {
          complexity: "normal",
          ambiguity: "medium",
          planningRequired: true,
          emotionalNuance: "high",
          executionSize: "medium",
          factualStakes: "medium",
          transformationMechanical: false,
          toolNeed: "none",
          confidence: 0.85,
        },
        suggestedActions: ["listen", "clarify", "prioritize"],
      }),
      agent: async () => {
        agentCalls += 1;
        throw new Error("konteks pekerjaan bukan authority AgentRun");
      },
      reply: async () => {
        replyCalls += 1;
        return "Kita tetap ngobrol dan urai bagian yang terasa paling berat.";
      },
    });

    const response = await harness.service.handle(message(
      "Aku tahu harus mulai dari meninjau catatan temuan produk lalu memilih tiga masalah paling penting. Yang berat itu catatannya berantakan dan aku takut salah memprioritaskan.",
      "live-wrong-route-regression",
    ));

    assert.equal(agentCalls, 0);
    assert.equal(replyCalls, 1);
    assert.match(privateReplyText(response), /tetap ngobrol/iu);
  });

  it("menjawab planning tanpa tool sebagai chat biasa", async () => {
    let agentCalls = 0;
    let replyCalls = 0;
    const harness = createHarness(true, {
      understand: async () => ({
        ...modelPlanningUnderstanding(),
        routingAssessment: {
          ...modelPlanningUnderstanding().routingAssessment!,
          complexity: "normal",
          planningRequired: true,
          executionSize: "medium",
          toolNeed: "none",
        },
      }),
      agent: async () => {
        agentCalls += 1;
        throw new Error("planning jawaban chat bukan authority tool/AgentRun");
      },
      reply: async () => {
        replyCalls += 1;
        return "Tool salah harus diprioritaskan karena merusak kepercayaan.";
      },
    });

    const response = await harness.service.handle(message(
      "Dari prioritas pertama, sebutkan satu eksperimen kecil untuk membuktikan routing tool lebih aman.",
      "planning-without-tool",
    ));

    assert.equal(agentCalls, 0);
    assert.equal(replyCalls, 1);
    assert.match(privateReplyText(response), /merusak kepercayaan/iu);
    assert.doesNotMatch(privateReplyText(response), /Menunggu giliran kerja/iu);
  });

  it("menuntaskan permintaan utama ketika remember model bertentangan dengan negasi", async () => {
    const text =
      "Koreksi: ini hanya konteks pekerjaan sekarang. Jangan ingat untuk ke depan. Tolong langsung urutkan tiga prioritas.";
    let replyCalls = 0;
    const harness = createHarness(true, {
      understand: async () => ({
        ...modelPlanningUnderstanding(),
        memoryAction: "remember",
        memories: [{
          kind: "preference",
          content: "Selalu membahas pekerjaan tanpa tool",
        }],
        semanticOperation: {
          version: 1,
          domain: "memory",
          operation: "remember",
          target: text,
          subject: "self",
          reference: "none",
          explicitness: "explicit",
          evidence: text,
          confidence: 0.95,
        },
        routingAssessment: {
          ...modelPlanningUnderstanding().routingAssessment!,
          complexity: "normal",
          planningRequired: true,
          executionSize: "medium",
          toolNeed: "none",
        },
      }),
      agent: async () => {
        throw new Error("negasi memory tidak boleh membuka agent");
      },
      reply: async () => {
        replyCalls += 1;
        return "Permintaanmu sudah aku catat. Catatannya udah aku hapus.\n\nUrutannya: tool salah, onboarding, lalu kartu penggunaan.";
      },
    });

    const before = harness.memoryCount;
    const response = await harness.service.handle(message(
      text,
      "negative-memory-with-primary-request",
    ));

    assert.equal(harness.memoryCount, before);
    assert.equal(replyCalls, 1);
    assert.match(privateReplyText(response), /tool salah, onboarding/iu);
    assert.doesNotMatch(privateReplyText(response), /udah aku hapus/iu);
    assert.doesNotMatch(privateReplyText(response), /sudah aku catat/iu);
    assert.doesNotMatch(
      privateReplyText(response),
      /belum bisa menyimpan|ingat untuk ke depan|📍/iu,
    );
  });

  it("mencabut dua ingatan lama dan menyimpan koreksi grounded dalam satu turn WhatsApp", async () => {
    const ownerId = "whatsapp-user:628777777777@s.whatsapp.net";
    const text = [
      "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap.",
      "Kebun itu hanya proyek yang sedang dibahas, bukan profilku.",
      "Kalau penjelasan teknis panjang, aku sering kehilangan inti.",
    ].join(" ");
    const harness = createHarness(true, {
      initialMemories: [
        {
          id: "old-english",
          ownerId,
          kind: "preference",
          content: "Prefers coding conversations in English",
          createdAt: "2026-08-23T00:00:00.000Z",
          lastUsedAt: null,
          expiresAt: null,
        },
        {
          id: "old-garden",
          ownerId,
          kind: "context",
          content: "Memiliki kebun kecil",
          createdAt: "2026-08-24T00:00:00.000Z",
          lastUsedAt: null,
          expiresAt: null,
        },
      ],
      understand: async () => ({
        intent: "smalltalk",
        taskAction: null,
        memoryAction: "remember",
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        task: null,
        memories: [
          {
            kind: "preference",
            content:
              "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap",
            sourceEvidence:
              "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap",
            sourceSubject: "self",
            durability: "durable",
          },
          {
            kind: "preference",
            content:
              "Lebih mudah memahami penjelasan teknis bila inti didahulukan",
            sourceEvidence:
              "Kalau penjelasan teknis panjang, aku sering kehilangan inti",
            sourceSubject: "self",
            durability: "durable",
          },
        ],
        memoryRetractions: [
          {
            target: "preferensi bahasa Inggris",
            sourceEvidence:
              "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap",
            explicitness: "explicit",
            confidence: 0.97,
          },
          {
            target: "garden project",
            sourceEvidence:
              "Kebun itu hanya proyek yang sedang dibahas, bukan profilku",
            explicitness: "explicit",
            confidence: 0.96,
          },
        ],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: {
          version: 1,
          domain: "memory",
          operation: "remember",
          target:
            "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap",
          subject: "self",
          reference: "quoted",
          explicitness: "explicit",
          evidence:
            "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap",
          confidence: 0.96,
        },
      }),
      reply: async () =>
        "Oke, dua ingatan lama itu sudah aku hapus. Pola penjelasanmu akan kuingat.",
    });

    const response = await harness.service.handle(message(
      text,
      "memory-retraction-mixed",
    )) as WhatsAppPrivateReply;

    assert.deepEqual(harness.memoryContents, [
      "Suka belajar dengan contoh visual",
      "Kalau penjelasan teknis panjang, aku sering kehilangan inti",
    ]);
    assert.equal(
      harness.rememberedInputs.at(-1)?.content,
      "Kalau penjelasan teknis panjang, aku sering kehilangan inti",
    );
    assert.match(response.text, /sudah aku hapus/iu);
  });

  it("menahan klaim penghapusan bila target koreksi tidak cocok dengan primary memory", async () => {
    const text = "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap.";
    const harness = createHarness(true, {
      understand: async () => ({
        intent: "smalltalk",
        taskAction: null,
        memoryAction: null,
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        task: null,
        memories: [],
        memoryRetractions: [{
          target: "preferensi bahasa Inggris",
          sourceEvidence:
            "Bahasa Inggris tadi hanya untuk satu bagian, bukan preferensi tetap",
          explicitness: "explicit",
          confidence: 0.97,
        }],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: null,
      }),
      reply: async () =>
        "Catatan bahasa Inggris itu sudah aku hapus. Kita lanjut pakai konteks sekarang.",
    });

    const response = await harness.service.handle(message(
      text,
      "memory-retraction-no-match",
    ));

    assert.doesNotMatch(privateReplyText(response), /sudah aku hapus/iu);
    assert.match(privateReplyText(response), /lanjut pakai konteks/iu);
    assert.equal(harness.memoryCount, 1);
  });

  it("sinyal langkah kecil semantik mengalahkan planning kecil di WhatsApp", async () => {
    let agentCalls = 0;
    const harness = createHarness(true, {
      understand: async () => ({
        ...modelPlanningUnderstanding(),
        intent: "feeling",
        taskAction: "offer",
        routingAssessment: {
          complexity: "normal",
          ambiguity: "medium",
          planningRequired: true,
          emotionalNuance: "high",
          executionSize: "small",
          factualStakes: "low",
          transformationMechanical: false,
          toolNeed: "none",
          confidence: 0.9,
        },
        suggestedActions: ["start_small", "plan"],
        actionGoal: "Mulai satu langkah kecil untuk audit acceptance",
      }),
      agent: async () => {
        agentCalls += 1;
        throw new Error("interaksi terpandu ringan tidak boleh menjadi agent");
      },
      reply: async () =>
        "Kita kecilkan dulu: buka satu dokumen yang paling mudah dijangkau.",
    });

    const response = await harness.service.handle(message(
      "Aku kewalahan dengan audit acceptance. Bantu aku mulai satu langkah kecil.",
      "guided-small-step",
    ));

    assert.equal(agentCalls, 0);
    assert.match(privateReplyText(response), /buka satu dokumen/iu);
  });

  it("menyimpan memori personal otomatis setelah consent onboarding", async () => {
    const sensitiveText = "Aku punya kondisi kesehatan yang perlu kamu ingat";
    const harness = createHarness(true, {
      understand: async () => ({
        intent: "smalltalk",
        taskAction: null,
        memoryAction: null,
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        task: null,
        memories: [{
          kind: "personal",
          content: "Punya kondisi kesehatan",
          sourceEvidence: sensitiveText,
          sourceSubject: "self",
          durability: "durable",
        }],
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
    assert.equal(harness.memoryCount, 2);
    assert.equal(harness.rememberedInputs[0]?.sensitiveConsent, true);
    assert.match(response.text, /ingat untuk ke depan|📍/iu);
    assert.doesNotMatch(
      response.text,
      /Boleh aku (?:menyimpan|inget)|SIMPAN MEMORI|JANGAN SIMPAN/iu,
    );
    await response.onDelivered?.();
  });

  it("menyimpan memori biasa implisit tanpa classifier atau izin kedua", async () => {
    const harness = createHarness(true, {
      understand: async () => ({
        intent: "smalltalk",
        taskAction: null,
        memoryAction: null,
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        task: null,
        memories: [{
          kind: "preference",
          content: "Lebih suka jawaban bertahap",
          sourceEvidence: "aku lebih suka jawaban bertahap",
          sourceSubject: "self",
          durability: "durable",
        }],
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
    assert.equal(harness.memoryCount, 2);
    assert.match(response.text, /Aku simpan preferensimu/iu);
    assert.doesNotMatch(
      response.text,
      /Boleh aku (?:menyimpan|inget)|SIMPAN MEMORI|JANGAN SIMPAN/iu,
    );
    await response.onDelivered?.();
  });

  it("tidak mengaku menyimpan memori implisit bila primary write gagal", async () => {
    const harness = createHarness(true, {
      rememberFails: true,
      understand: async () => ({
        intent: "smalltalk",
        taskAction: null,
        memoryAction: null,
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        task: null,
        memories: [{
          kind: "preference",
          content: "Lebih suka contoh konkret",
          sourceEvidence: "aku lebih suka contoh konkret",
          sourceSubject: "self",
          durability: "durable",
        }],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: null,
      }),
      reply: async () => "Oke, preferensi itu aku simpan untuk ke depan.",
    });

    const response = await harness.service.handle(message(
      "aku lebih suka contoh konkret",
      "memory-implicit-write-failed",
    )) as WhatsAppPrivateReply;

    assert.equal(harness.memoryCount, 1);
    assert.doesNotMatch(response.text, /aku simpan|sudah tersimpan|📍/iu);
    assert.doesNotMatch(
      response.text,
      /Boleh aku (?:menyimpan|inget)|SIMPAN MEMORI|JANGAN SIMPAN/iu,
    );
  });

  it("menolak topik kerja dan keadaan sekali pakai sebagai auto-memory WhatsApp", async () => {
    const text =
      "Tolong buat acceptance reminder untuk Harvy. Besok aku harus bangun pagi dan malam ini masih memilih belajar atau tidur.";
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
        memories: [
          {
            kind: "context",
            content: "Acceptance reminder untuk Harvy",
            sourceEvidence: "acceptance reminder untuk Harvy",
            sourceSubject: "work",
            durability: "bounded",
          },
          {
            kind: "context",
            content: "Harus bangun pagi besok dan sedang memilih belajar atau tidur",
            sourceEvidence:
              "Besok aku harus bangun pagi dan malam ini masih memilih belajar atau tidur",
            sourceSubject: "self",
            durability: "transient",
          },
        ],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: null,
      }),
      reply: async () =>
        "Oke, dua hal itu sudah aku simpan untuk percakapan berikutnya.",
    });

    const response = await harness.service.handle(
      message(text, "memory-live-false-positive"),
    ) as WhatsAppPrivateReply;

    assert.equal(harness.memoryCount, 1);
    assert.doesNotMatch(
      response.text,
      /sudah aku simpan|aku ingat untuk ke depan|📍/iu,
    );
  });

  it("tidak mempercayai sinyal remember tanpa perintah write lokal", async () => {
    for (const [index, text] of [
      "jangan ingat kalau Rani pacarku",
      "kamu inget gak Rani itu siapa?",
      "ingetin aku belajar jam 7",
    ].entries()) {
      const harness = createHarness(true, {
        understand: async () => ({
          intent: "smalltalk",
          taskAction: null,
          memoryAction: "remember",
          riskHint: NO_RISK_HINT,
          safetySensitive: false,
          needsStepByStep: false,
          routingAssessment: null,
          task: null,
          memories: [{ kind: "personal", content: "Rani adalah pacarku" }],
          suggestedActions: [],
          actionGoal: null,
          controlAction: null,
          sessionSignal: null,
          semanticOperation: null,
        }),
        reply: async () => "Oke, yang itu aku simpan untuk ke depan.",
      });

      const response = await harness.service.handle(message(
        text,
        `memory-untrusted-remember-${index}`,
      )) as WhatsAppPrivateReply;

      assert.equal(harness.memoryCount, 1, text);
      assert.doesNotMatch(response.text, /aku simpan|sudah tersimpan|📍/iu);
      assert.doesNotMatch(
        response.text,
        /Boleh aku (?:menyimpan|inget)|SIMPAN MEMORI|JANGAN SIMPAN/iu,
      );
    }
  });

  it("tidak mengaku aturan dicatat ketika write memori tidak punya receipt", async () => {
    const harness = createHarness(true, {
      understand: async () => ({
        intent: "memory",
        taskAction: null,
        memoryAction: "remember",
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        task: null,
        memories: [{
          kind: "preference",
          content: "Keputusan utama dulu lalu alasan singkat",
        }],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: null,
      }),
      reply: async () =>
        "Aturan baru dicatat: keputusan utama dulu lalu alasan singkat.",
    });

    const response = await harness.service.handle(message(
      "Kalau membantu pekerjaan produk, jawab dengan keputusan utama dulu.",
      "memory-no-receipt-claim",
    )) as WhatsAppPrivateReply;

    assert.doesNotMatch(response.text, /aturan baru dicatat/iu);
  });

  it("menyimpan instruksi bentuk jawaban tanpa consent kedua", async () => {
    const harness = createHarness(true, {
      understand: async () => ({
        intent: "smalltalk",
        taskAction: null,
        memoryAction: "remember",
        riskHint: NO_RISK_HINT,
        safetySensitive: false,
        needsStepByStep: false,
        routingAssessment: null,
        task: null,
        memories: [{
          kind: "preference",
          content: "Lebih menyukai seluruh jawaban dalam langkah singkat bernomor.",
        }],
        suggestedActions: [],
        actionGoal: null,
        controlAction: null,
        sessionSignal: null,
        semanticOperation: null,
      }),
      reply: async () => "Oke, aku akan menjawab lebih terstruktur.",
    });

    const response = await harness.service.handle(message(
      "Mulai sekarang, aku lebih suka semua jawaban memakai langkah pendek dan bernomor.",
      "memory-local-fallback",
    )) as WhatsAppPrivateReply;

    assert.doesNotMatch(response.text, /SIMPAN MEMORI|JANGAN SIMPAN/iu);
    assert.match(response.text, /ingat|simpan|ke depan/iu);
    assert.equal(harness.memoryCount, 2, "tepat satu preference ditulis");
  });

  it("tidak mengaku menerapkan preferensi bila primary write gagal", async () => {
    const harness = createHarness(true, {
      rememberFails: true,
      reply: async () => "Oke, gaya jawabannya aku ubah mulai sekarang.",
    });

    const response = await harness.service.handle(message(
      "Mulai sekarang, aku lebih suka semua jawaban memakai langkah pendek dan bernomor.",
      "memory-local-fallback-failed",
    )) as WhatsAppPrivateReply;

    assert.match(response.text, /belum bisa menyimpan/iu);
    assert.doesNotMatch(response.text, /gaya jawabannya aku ubah/iu);
    assert.doesNotMatch(response.text, /SIMPAN MEMORI|JANGAN SIMPAN/iu);
    assert.equal(harness.memoryCount, 1);
  });

  it("menjalankan AgentRun durable dan mengirim hasil proaktif di WhatsApp", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-wa-private-agent-"));
    const agentRuns = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const sent: string[] = [];
    const edited: Array<{ messageId: string; text: string }> = [];
    const removed: string[] = [];
    const pinStates: boolean[] = [];
    const ownerId = "whatsapp-user:628777777777@s.whatsapp.net";
    const request =
      "Aku biasanya paling fokus belajar pagi. Tolong buatkan rencana langkah demi langkah untuk ujian.";
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
      understand: async () => ({
        ...modelPlanningUnderstanding(),
        memories: [{
          kind: "preference" as const,
          content: "Biasanya paling fokus belajar pagi",
          sourceEvidence: "Aku biasanya paling fokus belajar pagi",
          sourceSubject: "self" as const,
          durability: "durable" as const,
        }],
      }),
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
          edited.push({ messageId, text });
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
    assert.equal(anchor.presentationBubbles?.length, 2);
    assert.match(anchor.presentationBubbles?.[0] ?? "", /ingat.*ke depan|📍/iu);
    assert.match(anchor.presentationBubbles?.[1] ?? "", /Pekerjaan|Antrean|Menyusun/iu);
    assert.equal(anchor.text, anchor.presentationBubbles?.join("\n\n"));
    await anchor.onDelivered?.({
      text: anchor.text,
      bubbleCount: 2,
      complete: true,
      messageIds: ["wa-memory-notice-1", "wa-anchor-1"],
      messageRefs: ["wa-memory-notice-1", "wa-anchor-1"],
    });

    await waitUntil(async () =>
      (await agentRuns.loadActive("whatsapp", ownerId))?.status === "completed"
    );
    const completed = await agentRuns.loadActive("whatsapp", ownerId);
    assert.equal(completed?.anchor.messageId, "wa-anchor-1");
    assert.equal(completed?.receipts[0]?.effect, "whatsapp.message.send");
    assert.deepEqual(sent, ["Rencana ujian yang sudah memakai state live."]);
    assert.match(edited.at(-1)?.text ?? "", /Selesai/iu);
    assert.ok(edited.every((item) => item.messageId === "wa-anchor-1"));
    assert.equal(harness.memoryCount, 2);
    assert.deepEqual(removed, []);
    assert.deepEqual(pinStates, [true, false]);
    assert.equal(
      harness.history.at(-1)?.text,
      "Rencana ujian yang sudah memakai state live.",
    );
    await harness.service.drain();
  });

  it("mempertahankan memory notice yang sudah terlihat ketika Anchor gagal terkirim", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-wa-memory-anchor-partial-"));
    const agentRuns = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const ownerId = "whatsapp-user:628777777777@s.whatsapp.net";
    const request =
      "Aku biasanya paling fokus belajar pagi. Tolong susun rencana belajar yang rinci.";
    let agentCalls = 0;
    const harness = createHarness(true, {
      understand: async () => ({
        ...modelPlanningUnderstanding(),
        memories: [{
          kind: "preference" as const,
          content: "Biasanya paling fokus belajar pagi",
          sourceEvidence: "Aku biasanya paling fokus belajar pagi",
          sourceSubject: "self" as const,
          durability: "durable" as const,
        }],
      }),
      agentRuns,
      agent: async () => {
        agentCalls += 1;
        throw new Error("work tidak boleh dimulai tanpa Anchor");
      },
      proactive: {
        send: async () => undefined,
        sendTracked: async () => ({ messageIds: ["unused"] }),
        editTracked: async (_accountId, _userId, messageId) => ({ messageId }),
        removeTracked: async () => undefined,
        setPinned: async () => undefined,
      },
    });

    const response = await harness.service.handle(
      message(request, "memory-anchor-partial"),
    ) as WhatsAppPrivateReply;
    const notice = response.presentationBubbles?.[0] ?? "";
    assert.equal(response.presentationBubbles?.length, 2);
    await response.onDeliveryFailed?.({
      text: notice,
      bubbleCount: 1,
      complete: false,
      messageIds: ["wa-memory-visible"],
      messageRefs: ["wa-memory-visible"],
    });

    assert.equal(harness.memoryCount, 2, "klaim write yang terlihat harus tetap benar");
    assert.equal(agentCalls, 0);
    assert.equal(
      (await agentRuns.loadActive("whatsapp", ownerId))?.status,
      "failed",
    );
    await harness.service.drain();
  });

  it("tidak pernah mengikat ID memory notice ketika ID Anchor hilang", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-wa-memory-anchor-id-"));
    const agentRuns = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const ownerId = "whatsapp-user:628777777777@s.whatsapp.net";
    const request =
      "Aku biasanya paling fokus belajar pagi. Tolong susun rencana belajar yang rinci.";
    let agentCalls = 0;
    const harness = createHarness(true, {
      understand: async () => ({
        ...modelPlanningUnderstanding(),
        memories: [{
          kind: "preference" as const,
          content: "Biasanya paling fokus belajar pagi",
          sourceEvidence: "Aku biasanya paling fokus belajar pagi",
          sourceSubject: "self" as const,
          durability: "durable" as const,
        }],
      }),
      agentRuns,
      agent: async () => {
        agentCalls += 1;
        throw new Error("work tidak boleh dimulai tanpa ID Anchor");
      },
      proactive: {
        send: async () => undefined,
        sendTracked: async () => ({ messageIds: ["unused"] }),
        editTracked: async (_accountId, _userId, messageId) => ({ messageId }),
        removeTracked: async () => undefined,
        setPinned: async () => undefined,
      },
    });

    const response = await harness.service.handle(
      message(request, "memory-anchor-missing-id"),
    ) as WhatsAppPrivateReply;
    await response.onDelivered?.({
      text: response.text,
      bubbleCount: 2,
      complete: true,
      messageIds: ["wa-memory-visible"],
      messageRefs: ["wa-memory-visible", null],
    });

    const run = await agentRuns.loadActive("whatsapp", ownerId);
    assert.equal(run?.status, "failed");
    assert.notEqual(run?.anchor.messageId, "wa-memory-visible");
    assert.equal(agentCalls, 0);
    assert.equal(harness.memoryCount, 2);
    await harness.service.drain();
  });

  it("menahan commit ketika reply ke Anchor masih melewati safety", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-wa-private-ingress-race-"));
    const agentRuns = new AgentRunService(
      new FileAgentRunRepository(join(root, "agent-runs.json")),
    );
    const ownerId = "whatsapp-user:628777777777@s.whatsapp.net";
    const request = "Tolong susun rencana audit yang rinci.";
    const correction = "Koreksi: jangan masukkan langkah publikasi.";
    const firstStarted = deferredVoid();
    const releaseFirst = deferredVoid();
    const correctionUnderstandingStarted = deferredVoid();
    const releaseCorrectionUnderstanding = deferredVoid();
    const secondStarted = deferredVoid();
    const proactiveSent: string[] = [];
    const transportSent: Array<{ id: string; text: string }> = [];
    let agentCalls = 0;
    const harness = createHarness(true, {
      understand: async (text) => {
        if (text === correction) {
          correctionUnderstandingStarted.resolve();
          await releaseCorrectionUnderstanding.promise;
        }
        return modelPlanningUnderstanding();
      },
      agentRuns,
      agent: async (
        _messageText,
        _mode,
        _context,
        runtime,
        restored,
      ) => {
        agentCalls += 1;
        assert.ok(runtime?.runId);
        if (agentCalls === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          return {
            status: "completed",
            reply: "HASIL LAMA YANG TIDAK BOLEH TERKIRIM",
            checkpoint: agentCheckpoint(runtime.runId, ownerId, request),
            trace: [],
          };
        }
        assert.ok(restored?.userInputs.some((item) =>
          item.text.includes("jangan masukkan langkah publikasi")
        ));
        secondStarted.resolve();
        return {
          status: "completed",
          reply: "Rencana terkoreksi tanpa langkah publikasi.",
          checkpoint: { ...restored!, pendingInput: null },
          trace: [],
        };
      },
      proactive: {
        send: async (_accountId, _userId, text) => {
          proactiveSent.push(text);
        },
        sendTracked: async (_accountId, _userId, text) => {
          proactiveSent.push(text);
          return { messageIds: [`wa-proactive-${proactiveSent.length}`] };
        },
        editTracked: async (_accountId, _userId, messageId) => ({ messageId }),
        removeTracked: async () => undefined,
        setPinned: async () => undefined,
      },
    });
    const transport: WhatsAppPrivateTransport = {
      isCurrent: () => true,
      send: async (text) => {
        const id = `wa-transport-${transportSent.length + 1}`;
        transportSent.push({ id, text });
        return { messageId: id };
      },
      sendDocument: async () => ({ messageId: "wa-document" }),
      edit: async () => undefined,
      remove: async () => undefined,
      typing: async () => undefined,
    };

    try {
      await harness.service.ingest(message(request, "ingress-race-start"), transport);
      await waitForSignal(firstStarted.promise, "agent pertama tidak dimulai");
      await waitUntil(async () =>
        transportSent.some((item) => item.text.startsWith("📌 "))
      );
      const anchorId = transportSent.find((item) => item.text.startsWith("📌 "))!.id;

      await harness.service.ingest({
        ...message(correction, "ingress-race-correction"),
        at: new Date().toISOString(),
        quotedMessageId: anchorId,
      }, transport);
      await waitForSignal(
        correctionUnderstandingStarted.promise,
        "pemahaman koreksi tidak dimulai",
      );
      releaseFirst.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        proactiveSent.includes("HASIL LAMA YANG TIDAK BOLEH TERKIRIM"),
        false,
      );

      releaseCorrectionUnderstanding.resolve();
      await waitForSignal(secondStarted.promise, "replanning tidak dimulai");
      await waitUntil(async () =>
        (await agentRuns.loadActive("whatsapp", ownerId))?.status === "completed"
      );
      assert.equal(agentCalls, 2);
      assert.equal(
        proactiveSent.includes("HASIL LAMA YANG TIDAK BOLEH TERKIRIM"),
        false,
      );
      assert.ok(proactiveSent.includes("Rencana terkoreksi tanpa langkah publikasi."));
      assert.equal(
        transportSent.filter((item) => item.text.startsWith("📌 ")).length,
        1,
      );
    } finally {
      releaseFirst.resolve();
      releaseCorrectionUnderstanding.resolve();
      await harness.service.drain();
    }
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
      understand: async () => modelPlanningUnderstanding(),
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
    failContextRead?: boolean;
    initialMemories?: MemoryItem[];
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
    rememberFails?: boolean;
    economyHandle?: (
      ownerId: string,
      input: {
        rawText: string;
        semanticOperation: Understanding["semanticOperation"];
      },
    ) => Promise<string | null>;
    agent?: Conversation["agent"];
    presentOperation?: Conversation["presentOperation"];
    presentScheduledCheckIn?: Conversation["presentScheduledCheckIn"];
    deliverCheckIn?: SessionService["deliverCheckIn"];
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
  readonly memoryContents: string[];
  rememberedInputs: NewMemory[];
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
  const memoryItems: MemoryItem[] = [
    {
      id: "memory-1",
      ownerId: "whatsapp-user:628777777777@s.whatsapp.net",
      kind: "preference",
      content: "Suka belajar dengan contoh visual",
      createdAt: "2026-08-22T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    },
    ...(options.initialMemories ?? []).map((item) => ({ ...item })),
  ];
  const rememberedInputs: NewMemory[] = [];
  const profile = (): UserProfile => ({
    ownerId: "whatsapp-user:628777777777@s.whatsapp.net",
    consentVersion: consent ? CONSENT_VERSION : 0,
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
      // Jauh di masa depan agar fixture tidak kedaluwarsa mengikuti jam mesin.
      understandDueDate: async () => new Date("2099-08-25T12:00:00.000Z"),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.presentOperation
        ? { presentOperation: options.presentOperation }
        : {}),
      ...(options.presentScheduledCheckIn
        ? { presentScheduledCheckIn: options.presentScheduledCheckIn }
        : {}),
    },
    history: {
      context: async () => {
        if (options.failContextRead) {
          throw new Error("aritmetika tidak boleh memuat history context");
        }
        return { summary: null, turns: [...history] };
      },
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
      relevantTo: async () => {
        if (options.failContextRead) {
          throw new Error("aritmetika tidak boleh memuat semantic memory");
        }
        return [];
      },
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
      remember: async (input: NewMemory) => {
        rememberedInputs.push(input);
        if (options.rememberFails) return null;
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
      deliverCheckIn: options.deliverCheckIn ?? (async () => false),
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
      updateSchedule: async (
        _ownerId: string,
        id: string,
        update: {
          dueAt?: Date | null;
          reminderAt?: Date | null;
          expected?: { dueAt: string | null; reminderAt: string | null };
        },
      ) => {
        const task = taskItems.find((candidate) => candidate.id === id);
        if (
          !task || task.status !== "active" ||
          (update.expected &&
            (task.dueAt !== update.expected.dueAt ||
              task.reminderAt !== update.expected.reminderAt))
        ) return null;
        if (update.dueAt !== undefined) {
          task.dueAt = update.dueAt?.toISOString() ?? null;
        }
        if (update.reminderAt !== undefined) {
          task.reminderAt = update.reminderAt?.toISOString() ?? null;
          task.reminderSentAt = null;
          task.reminderDelivery = null;
        }
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
    get memoryContents() {
      return memoryItems.map((item) => item.content);
    },
    get deletedAll() {
      return deletedAll;
    },
    history,
    replyChannels,
    replyMessages,
    understandContexts,
    rememberedInputs,
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
    routingAssessment: {
      complexity: "mechanical",
      ambiguity: "low",
      planningRequired: false,
      emotionalNuance: "low",
      executionSize: "small",
      factualStakes: "low",
      transformationMechanical: false,
      toolNeed: "internal_state",
      confidence: 0.98,
    },
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

function modelPlanningUnderstanding(): Understanding {
  return {
    intent: "request",
    taskAction: null,
    memoryAction: null,
    riskHint: NO_RISK_HINT,
    safetySensitive: false,
    needsStepByStep: true,
    routingAssessment: {
      complexity: "deep",
      ambiguity: "medium",
      planningRequired: true,
      emotionalNuance: "low",
      executionSize: "heavy",
      factualStakes: "low",
      transformationMechanical: false,
      toolNeed: "execution",
      confidence: 0.95,
    },
    task: null,
    memories: [],
    suggestedActions: [],
    actionGoal: null,
    controlAction: null,
    sessionSignal: null,
    semanticOperation: null,
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

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForSignal(
  signal: Promise<void>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
