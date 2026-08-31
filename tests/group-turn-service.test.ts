import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GroupConversationPort } from "../src/ai/group-conversation.js";
import type { HarvyContext } from "../src/ai/context.js";
import type { Understanding } from "../src/ai/understand.js";
import { CAPYBARA_MODEL_REPLY } from "../src/ai/identity.js";
import {
  CALM_TRIAGE,
  type RiskTriage,
} from "../src/ai/safety.js";
import { GroupMemoryService } from "../src/core/group-memory-service.js";
import {
  CLAIMED_GROUP_AUTHORITY_RESOLVER,
  type GroupAuthorityResolver,
} from "../src/core/group-authority-policy.js";
import { NO_RISK_HINT } from "../src/core/safety-policy.js";
import { groupRuntimeAdmission } from "../src/core/group-runtime-policy.js";
import { USAGE_GROUP_PRIVACY_MESSAGE } from "../src/core/usage-dashboard-renderer.js";
import {
  GROUP_NOTICE_VERSION,
  GroupTurnService,
  groupNotice,
  type GroupMemoryExtractionPort,
  type GroupIngressAssessmentPort,
  type GroupRuntimeAdmissionResolver,
  type GroupSafetyPort,
  type GroupTransport,
  type GroupUsageControlPort,
} from "../src/core/group-turn-service.js";
import type {
  GroupBinding,
  GroupMemberMemory,
  GroupMemory,
  GroupMessage,
  GroupRepository,
  GroupRoomMemory,
  GroupTurn,
} from "../src/domain/group.js";
import type { SemanticOperation } from "../src/domain/semantic-operation.js";

const NOW = new Date("2026-07-29T12:00:00.000Z");

describe("giliran grup", () => {
  it("menyebut retensi file lokal aktual dan batas collector secara jujur", () => {
    const notice = groupNotice(9);
    assert.match(notice, /file lokal Harvy/i);
    assert.match(notice, /setelah 9 hari/i);
    assert.match(notice, /collector perusahaan/i);
    assert.doesNotMatch(notice, /bawaan 14 hari/i);
    assert.match(notice, /satu layanan model AI utama pihak ketiga/i);
    assert.match(notice, /tidak mengirim ulang.*penyedia cadangan/i);
    assert.equal(GROUP_NOTICE_VERSION, 11);
    assert.match(notice, /cache penyedia/i);
    assert.match(notice, /hanya mencatat hitungan token cache tanpa isi/i);
    assert.match(notice, /gambar grup belum diproses/i);
    assert.match(notice, /terpisah per grup dan per anggota/i);
    assert.match(notice, /sensitif tidak pernah kusimpan otomatis/i);
    assert.match(notice, /permintaan awal dan judul pekerjaan/i);
    assert.match(notice, /input anggota yang teratribusi ke peserta dan pesan sumber/i);
    assert.match(notice, /referensi Run Anchor/i);
    assert.match(notice, /ledger teknis upaya kerja dan delivery/i);
    assert.match(notice, /hasil akhir yang sudah terkirim/i);
    assert.match(notice, /audience grup.*file lokal terpisah.*7 hari/i);
    assert.match(notice, /bukan memori privat, riwayat chat privat, atau transcript penyedia\/model/i);
    assert.match(notice, /penghapusan record tersebut langsung dicoba/i);
    assert.match(notice, /tetap tunduk pada batas retensi 7 hari bila cleanup penyimpanan sementara gagal/i);
  });

  it("mengirim notice v11 lagi sebelum memproses grup yang baru melihat v10", async () => {
    const events: string[] = [];
    const runtime = createRuntime({
      events,
      reply: async () => "halo",
    });
    const scope = { channel: "whatsapp" as const, groupId: "grup@g.us" };
    await runtime.memories.activate(scope, "utama", "Grup uji", NOW.toISOString());
    await runtime.memories.markNoticeSent(
      "whatsapp:grup@g.us",
      "utama",
      10,
    );

    assert.equal(
      await runtime.turns.handle(message({ mentionsHarvy: true })),
      "replied",
    );
    assert.deepEqual(events, ["notice", "reply:halo"]);
    assert.equal(
      (await runtime.memories.binding("whatsapp:grup@g.us"))?.noticeVersion,
      11,
    );
  });

  it("mengirim pemberitahuan sebelum membalas tag dan mendeduplikasi event", async () => {
    const events: string[] = [];
    const runtime = createRuntime({
      events,
      reply: async () => "halo juga",
    });
    const incoming = message({ mentionsHarvy: true });

    assert.equal(await runtime.turns.handle(incoming), "replied");
    assert.equal(await runtime.turns.handle(incoming), "duplicate");
    assert.deepEqual(events, ["notice", "reply:halo juga"]);
  });

  it("menahan /penggunaan di grup tanpa membaca billing atau memanggil model", async () => {
    let modelCalls = 0;
    const runtime = createRuntime({
      assessAmbient: async () => {
        modelCalls += 1;
        throw new Error("model tidak boleh dipanggil");
      },
      assessGroupIngress: async () => {
        modelCalls += 1;
        throw new Error("model tidak boleh dipanggil");
      },
      reply: async () => {
        modelCalls += 1;
        throw new Error("model tidak boleh dipanggil");
      },
      triageRisk: async () => {
        modelCalls += 1;
        throw new Error("model tidak boleh dipanggil");
      },
    });

    assert.equal(
      await runtime.turns.handle(message({
        messageId: "penggunaan-grup",
        text: "/penggunaan",
      })),
      "replied",
    );
    assert.deepEqual(runtime.replies, [USAGE_GROUP_PRIVACY_MESSAGE]);
    assert.equal(modelCalls, 0);
  });

  it("menampilkan indikator mengetik sebelum memproses panggilan direct", async () => {
    const events: string[] = [];
    const runtime = createRuntime({
      events,
      sendTyping: async () => {
        events.push("typing");
      },
      reply: async () => "siap",
    });

    assert.equal(
      await runtime.turns.handle(message({ mentionsHarvy: true })),
      "replied",
    );
    assert.deepEqual(events, ["notice", "typing", "reply:siap"]);
  });

  it("memakai satu lifecycle progress grup sampai sebelum reply", async () => {
    const events: string[] = [];
    let finished = false;
    const runtime = createRuntime({
      events,
      createProgress: () => ({
        report: (event) => events.push(`progress:${event.phase}`),
        responding: async () => {
          events.push("progress:responding");
        },
        finish: async () => {
          if (finished) return;
          finished = true;
          events.push("progress:finish");
        },
      }),
      reply: async (
        _message,
        _context,
        _triage,
        _ownerId,
        _signal,
        progress,
      ) => {
        progress?.report({ phase: "thinking", detail: "general" });
        events.push("model");
        return "siap";
      },
    });

    assert.equal(
      await runtime.turns.handle(message({ mentionsHarvy: true })),
      "replied",
    );
    assert.deepEqual(events, [
      "notice",
      "progress:reading",
      "progress:checking",
      "progress:thinking",
      "model",
      "progress:responding",
      "reply:siap",
      "progress:finish",
    ]);
  });

  it("melewati memori biasa implisit di grup tanpa prompt atau write", async () => {
    const runtime = createRuntime({
      memoryExtractor: {
        understand: async () => understanding({
          kind: "preference",
          content: "Warna favoritnya biru",
        }),
      },
      reply: async () => "Oke, biru memang adem.",
    });
    const incoming = message({
      participantId: "anggota-a",
      participantAliases: ["anggota-a"],
      mentionsHarvy: true,
      text: "Harvy, warna favoritku biru",
    });

    assert.equal(await runtime.turns.handle(incoming), "replied");
    assert.equal(runtime.replies[0], "Oke, biru memang adem.");
    assert.doesNotMatch(runtime.replies[0] ?? "", /warna favoritku biru/iu);
    assert.doesNotMatch(runtime.replies[0] ?? "", /simpan memori ini/iu);
    assert.deepEqual(
      await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["anggota-a"],
      ),
      [],
    );
    assert.deepEqual(
      await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["anggota-b"],
      ),
      [],
    );
  });

  it("melewati memori personal implisit di grup tanpa prompt atau write", async () => {
    const runtime = createRuntime({
      memoryExtractor: {
        understand: async () => understanding({
          kind: "personal",
          content: "Sedang menghadapi masalah keluarga",
        }),
      },
    });
    await runtime.turns.handle(
      message({
        participantId: "anggota-a",
        participantAliases: ["anggota-a"],
        mentionsHarvy: true,
      }),
    );

    assert.deepEqual(
      await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["anggota-a"],
      ),
      [],
    );
    assert.doesNotMatch(runtime.replies[0] ?? "", /simpan memori ini/iu);
    assert.doesNotMatch(runtime.replies[0] ?? "", /sudah aku simpan|aku ingat/iu);
  });

  it("menyimpan perintah ingat explicit sebagai member-local memory grup", async () => {
    const runtime = createRuntime({
      reply: async () => "Aku bakal inget yang ini.",
      memoryExtractor: {
        understand: async () => understanding({
          kind: "personal",
          content: "Sedang menghadapi masalah keluarga",
        }, "remember", memorySemantic(
          "Harvy, inget ya aku sedang menghadapi masalah keluarga",
          "aku sedang menghadapi masalah keluarga",
        )),
      },
    });

    await runtime.turns.handle(
      message({
        messageId: "pesan-explicit-memory",
        participantId: "anggota-a",
        participantAliases: ["anggota-a"],
        mentionsHarvy: true,
        text: "Harvy, inget ya aku sedang menghadapi masalah keluarga",
      }),
    );

    const stored = await runtime.memories.memberMemories(
      "whatsapp:grup@g.us",
      ["anggota-a"],
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.consent, "explicit");
    assert.equal(stored[0]?.source, "explicit");
    assert.doesNotMatch(runtime.replies[0] ?? "", /ya, simpan memori ini/iu);
    assert.equal(
      (runtime.replies[0] ?? "").match(/(?:ingat|inget)/giu)?.length,
      1,
    );
  });

  it("menolak credential dari durable member memory meski diminta eksplisit", async () => {
    const runtime = createRuntime({
      memoryExtractor: {
        understand: async () => understanding({
          kind: "personal",
          content: "PIN kartu adalah 4321",
        }, "remember", memorySemantic(
          "Harvy, ingat PIN kartu aku 4321",
          "PIN kartu aku 4321",
        )),
      },
    });

    await runtime.turns.handle(
      message({
        messageId: "pesan-secret-memory",
        participantId: "anggota-a",
        participantAliases: ["anggota-a"],
        mentionsHarvy: true,
        text: "Harvy, ingat PIN kartu aku 4321",
      }),
    );

    assert.deepEqual(
      await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["anggota-a"],
      ),
      [],
    );
    assert.match(runtime.replies[0] ?? "", /nggak akan menyimpan password/iu);
    assert.doesNotMatch(runtime.replies[0] ?? "", /ya, simpan memori ini/iu);
  });

  it("merollback memori anggota bila pengiriman balasan gagal", async () => {
    const runtime = createRuntime({
      memoryExtractor: {
        understand: async () => understanding({
          kind: "profile",
          content: "Nama panggilannya Nara",
        }, "remember", memorySemantic(
          "Harvy, ingat ya nama panggilanku Nara",
          "nama panggilanku Nara",
        )),
      },
      sendReply: async () => {
        throw new Error("gagal kirim");
      },
    });

    await assert.rejects(
      runtime.turns.handle(
        message({
          participantId: "anggota-a",
          participantAliases: ["anggota-a"],
          mentionsHarvy: true,
          text: "Harvy, ingat ya nama panggilanku Nara",
        }),
      ),
      /gagal kirim/u,
    );
    assert.deepEqual(
      await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["anggota-a"],
      ),
      [],
    );
  });

  it("mempertahankan memori grup bila bubble partial sudah mengakui write", async () => {
    const runtime = createRuntime({
      memoryExtractor: {
        understand: async () => understanding({
          kind: "profile",
          content: "Nama panggilannya Nara",
        }, "remember", memorySemantic(
          "Harvy, ingat ya nama panggilanku Nara",
          "nama panggilanku Nara",
        )),
      },
      sendReply: async () => ({
        text: "Sudah kusimpan.",
        bubbleCount: 1,
        complete: false,
      }),
    });

    assert.equal(
      await runtime.turns.handle(message({
        messageId: "partial-write-terlihat",
        participantId: "anggota-a",
        participantAliases: ["anggota-a"],
        mentionsHarvy: true,
        text: "Harvy, ingat ya nama panggilanku Nara",
      })),
      "inactive",
    );
    assert.equal(
      (await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["anggota-a"],
      )).length,
      1,
    );
  });

  it("merollback memori grup bila bubble partial belum mengakui write", async () => {
    const runtime = createRuntime({
      memoryExtractor: {
        understand: async () => understanding({
          kind: "profile",
          content: "Nama panggilannya Nara",
        }, "remember", memorySemantic(
          "Harvy, ingat ya nama panggilanku Nara",
          "nama panggilanku Nara",
        )),
      },
      sendReply: async () => ({
        text: "Aku dengar bagian itu.",
        bubbleCount: 1,
        complete: false,
      }),
    });

    assert.equal(
      await runtime.turns.handle(message({
        messageId: "partial-write-belum-terlihat",
        participantId: "anggota-a",
        participantAliases: ["anggota-a"],
        mentionsHarvy: true,
        text: "Harvy, ingat ya nama panggilanku Nara",
      })),
      "inactive",
    );
    assert.deepEqual(
      await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["anggota-a"],
      ),
      [],
    );
  });

  it("menyimpan shared room memory hanya setelah preview dikonfirmasi admin", async () => {
    const runtime = createRuntime();
    assert.equal(
      await runtime.turns.handle(message({
        messageId: "proposal-room",
        participantId: "anggota",
        participantAliases: ["anggota"],
        mentionsHarvy: true,
        authorityEpoch: 4,
        text: "Harvy, ingat keputusan grup: presentasi dilakukan hari Jumat",
      })),
      "replied",
    );
    const proposalId = /\[#([a-f0-9]{8})\]/u.exec(
      runtime.replies.at(-1) ?? "",
    )?.[1];
    assert.ok(proposalId);
    assert.deepEqual(
      await runtime.memories.roomMemories("whatsapp:grup@g.us"),
      [],
    );

    assert.equal(
      await runtime.turns.handle(message({
        messageId: "confirm-room",
        participantId: "admin",
        participantAliases: ["admin"],
        mentionsHarvy: true,
        isAdmin: true,
        authorityEpoch: 4,
        text: `ya, simpan catatan grup #${proposalId}`,
      })),
      "replied",
    );
    const stored = await runtime.memories.roomMemories("whatsapp:grup@g.us");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.kind, "decision");
    assert.equal(stored[0]?.content, "presentasi dilakukan hari Jumat");

    await runtime.turns.handle(message({
      messageId: "lihat-room",
      participantId: "anggota-lain",
      participantAliases: ["anggota-lain"],
      mentionsHarvy: true,
      authorityEpoch: 4,
      text: "lihat memori grup",
    }));
    assert.match(runtime.replies.at(-1) ?? "", /presentasi dilakukan hari Jumat/iu);
  });

  it("membatalkan proposal shared memory ketika authority epoch berubah", async () => {
    let epoch = 1;
    let adminRole = true;
    const runtime = createRuntime({
      authority: {
        resolveGroupAuthority: async (request) => ({
          role:
            request.participantIds.includes("admin") && adminRole
              ? "admin"
              : "member",
          authorityEpoch: epoch,
        }),
      },
    });
    await runtime.turns.handle(message({
      messageId: "proposal-stale",
      participantId: "anggota",
      participantAliases: ["anggota"],
      mentionsHarvy: true,
      authorityEpoch: 1,
      text: "ingat untuk grup: belajar bersama setiap Kamis",
    }));
    const proposalId = /\[#([a-f0-9]{8})\]/u.exec(
      runtime.replies.at(-1) ?? "",
    )?.[1];
    assert.ok(proposalId);
    epoch = 2;
    adminRole = false;

    await runtime.turns.handle(message({
      messageId: "confirm-stale",
      participantId: "admin",
      participantAliases: ["admin"],
      mentionsHarvy: true,
      isAdmin: true,
      authorityEpoch: 2,
      text: `ya, simpan catatan grup #${proposalId}`,
    }));
    assert.match(runtime.replies.at(-1) ?? "", /hak admin grup berubah/iu);
    assert.deepEqual(
      await runtime.memories.roomMemories("whatsapp:grup@g.us"),
      [],
    );
  });

  it("merollback shared room memory bila acknowledgment admin gagal dikirim", async () => {
    let failConfirmation = false;
    const delivered: string[] = [];
    const runtime = createRuntime({
      sendReply: async (_message, text) => {
        if (failConfirmation) throw new Error("ack room gagal");
        delivered.push(text);
      },
    });
    await runtime.turns.handle(message({
      messageId: "proposal-rollback-room",
      mentionsHarvy: true,
      authorityEpoch: 1,
      text: "ingat agenda grup: rapat hari Senin",
    }));
    const proposalId = /\[#([a-f0-9]{8})\]/u.exec(
      delivered.at(-1) ?? "",
    )?.[1];
    assert.ok(proposalId);
    failConfirmation = true;
    await assert.rejects(
      runtime.turns.handle(message({
        messageId: "confirm-rollback-room",
        participantId: "admin",
        participantAliases: ["admin"],
        mentionsHarvy: true,
        isAdmin: true,
        authorityEpoch: 1,
        text: `ya, simpan catatan grup #${proposalId}`,
      })),
      /ack room gagal/u,
    );
    assert.deepEqual(
      await runtime.memories.roomMemories("whatsapp:grup@g.us"),
      [],
    );
  });

  it("diam ketika planner menolak pesan ambient", async () => {
    const events: string[] = [];
    const runtime = createRuntime({
      events,
      planAmbient: async () => silentPlan(),
    });

    assert.equal(await runtime.turns.handle(message()), "silent");
    assert.deepEqual(events, ["notice"]);
  });

  it("tetap membawa arus ambient tenang ke keputusan nimbrung berikutnya", async () => {
    const contexts: GroupTurn[][] = [];
    const runtime = createRuntime({
      planAmbient: async (_message, context) => {
        contexts.push([...context.turns]);
        return silentPlan();
      },
    });

    await runtime.turns.handle(
      message({ messageId: "ambient-1", text: "game itu rilis besok" }),
    );
    await runtime.turns.handle(
      message({ messageId: "ambient-2", text: "jam berapa ya?" }),
    );

    assert.equal(contexts[0]?.length, 0);
    assert.equal(contexts[1]?.[0]?.text, "game itu rilis besok");
  });

  it("dapat menjawab pertanyaan ambient tanpa nama, tag, atau reply", async () => {
    const runtime = createRuntime({
      planAmbient: async () =>
        speakPlan("Fotosintesis mengubah energi cahaya jadi energi kimia."),
    });

    const outcome = await runtime.turns.handle(
      message({
        text: "fotosintesis itu intinya ngapain sih?",
      }),
    );

    assert.equal(outcome, "replied");
    assert.equal(
      runtime.replies.at(-1),
      "Fotosintesis mengubah energi cahaya jadi energi kimia.",
    );
  });

  it("menahan kandidat ambient yang mengarang pengalaman, DM, diagnosis, atau jaminan", async () => {
    for (const unsafeReply of [
      "aku juga pernah ngalamin itu di kantor",
      "chat aku pribadi aja nanti",
      "japri aku aja",
      "Bima pasti depresi",
      "Ayu jelas selingkuh",
      "aman kok, transfer aja",
    ]) {
      const runtime = createRuntime({
        planAmbient: async () => speakPlan(unsafeReply),
      });

      assert.equal(
        await runtime.turns.handle(
          message({
            messageId: `unsafe-${unsafeReply.length}`,
            text: "ada yang punya saran?",
          }),
        ),
        "silent",
      );
      assert.deepEqual(runtime.replies, []);
    }
  });

  it("mengganti balasan direct yang melanggar pagar output dengan fallback", async () => {
    const unsafeReply = "langsung transfer aja, pasti aman";
    const runtime = createRuntime({
      reply: async () => unsafeReply,
    });

    assert.equal(
      await runtime.turns.handle(
        message({
          messageId: "unsafe-direct",
          text: "Harvy, penjual ini aman kan?",
          mentionsHarvy: true,
        }),
      ),
      "replied",
    );
    assert.equal(runtime.replies.length, 1);
    assert.notEqual(runtime.replies[0], unsafeReply);
    assert.match(runtime.replies[0] ?? "", /gagal terus/iu);
  });

  it("meregenerasi fact correction dengan tier balasan, bukan mengirim kandidat planner", async () => {
    let replyCalls = 0;
    const runtime = createRuntime({
      planAmbient: async () => ({
        ...speakPlan("kandidat murah yang belum diverifikasi"),
        reason: "fact_correction",
      }),
      reply: async () => {
        replyCalls += 1;
        return "Klaim 10% otak itu mitos; pemindaian menunjukkan banyak bagian otak aktif untuk fungsi berbeda.";
      },
    });

    assert.equal(
      await runtime.turns.handle(
        message({
          text: "manusia cuma pakai sepuluh persen otak itu benar?",
        }),
      ),
      "replied",
    );
    assert.equal(replyCalls, 1);
    assert.match(runtime.replies[0] ?? "", /mitos/iu);
    assert.doesNotMatch(runtime.replies[0] ?? "", /kandidat murah/iu);
  });

  it("balasan direct tidak menghabiskan budget partisipasi ambient", async () => {
    const runtime = createRuntime({
      planAmbient: async () => speakPlan("Kalau pilih cepat, opsi B paling ringan."),
      reply: async () => "iya, aku baca",
    });

    assert.equal(
      await runtime.turns.handle(
        message({
          messageId: "direct",
          text: "Harvy, baca ini dong",
          mentionsHarvy: true,
        }),
      ),
      "replied",
    );
    assert.equal(
      await runtime.turns.handle(
        message({
          messageId: "ambient-setelah-direct",
          text: "jadi mending opsi A atau B?",
        }),
      ),
      "replied",
    );
  });

  it("membedakan sapaan Harvy dari percakapan yang hanya membicarakan Harvy", async () => {
    const planned: string[] = [];
    const runtime = createRuntime({
      planAmbient: async (incoming) => {
        planned.push(incoming.text);
        return silentPlan();
      },
    });

    assert.equal(
      await runtime.turns.handle(
        message({
          messageId: "negasi",
          text: "jangan panggil Harvy dulu",
        }),
      ),
      "silent",
    );
    assert.equal(
      await runtime.turns.handle(
        message({
          messageId: "referensi",
          text: "jawaban Harvy tadi kepanjangan",
        }),
      ),
      "silent",
    );
    assert.deepEqual(planned, [
      "jangan panggil Harvy dulu",
      "jawaban Harvy tadi kepanjangan",
    ]);
  });

  it("menandai alias lokal berbentuk vocative sebagai direct sejak batching", async () => {
    const runtime = createRuntime();
    await runtime.turns.handle(
      message({
        messageId: "tambah-alias",
        text: "Harvy, mulai sekarang panggil kamu Kapi",
        mentionsHarvy: true,
        isAdmin: true,
      }),
    );

    const observed = await observeAuthorized(runtime.turns,
      message({
        messageId: "panggil-kapi",
        text: "Kapi, bantu cek ini dong",
      }),
    );

    assert.equal(observed.mentionsHarvy, true);
  });

  it("mendekorasi vocative Harvy sebelum sentinel aktivasi pertama", async () => {
    const runtime = createRuntime();
    const observed = await runtime.turns.observeAuthorized(message({
      messageId: "cold-vocative",
      text: "Harvy, bantu cek ini",
      mentionsHarvy: false,
    }));

    assert.ok(observed);
    assert.equal(observed.mentionsHarvy, true);
    assert.equal(observed.ingressRevision, 0);
    assert.equal(await runtime.turns.handle(observed), "replied");
  });

  it("menghidrasi alias durable sebelum admission pertama setelah restart", async () => {
    const repository = new MemoryGroupRepository();
    const original = createRuntime({ repository });
    await original.turns.handle(message({
      messageId: "simpan-alias-durable",
      text: "Harvy, mulai sekarang panggil kamu Kapi",
      mentionsHarvy: true,
      isAdmin: true,
    }));

    const restarted = createRuntime({ repository });
    const observed = await restarted.turns.observeAuthorized(message({
      messageId: "cold-custom-alias",
      text: "Kapi, bantu cek ini",
      mentionsHarvy: false,
    }));

    assert.ok(observed);
    assert.equal(observed.mentionsHarvy, true);
  });

  it("menahan kontribusi ambient beruntun sampai manusia punya ruang yang cukup", async () => {
    const runtime = createRuntime({
      planAmbient: async () => ({
        ...speakPlan("satu kontribusi"),
        reason: "invited_banter",
        value: 2,
      }),
    });

    assert.equal(
      await runtime.turns.handle(message({ messageId: "ambient-1" })),
      "replied",
    );
    for (const index of [2, 3, 4, 5, 6]) {
      assert.equal(
        await runtime.turns.handle(
          message({
            messageId: `ambient-${index}`,
            text: `obrolan manusia ${index}`,
          }),
        ),
        "silent",
      );
    }
    assert.equal(
      await runtime.turns.handle(
        message({
          messageId: "ambient-7",
          text: "sekarang ada celah baru",
        }),
      ),
      "replied",
    );
  });

  it("membatalkan kandidat ambient ketika pesan manusia lebih baru sudah terlihat", async () => {
    let releasePlan!: () => void;
    let markPlanStarted!: () => void;
    const planGate = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    const planStarted = new Promise<void>((resolve) => {
      markPlanStarted = resolve;
    });
    const runtime = createRuntime({
      planAmbient: async () => {
        markPlanStarted();
        await planGate;
        return speakPlan("jawaban yang sudah basi");
      },
    });
    const first = await observeAuthorized(runtime.turns,
      message({
        messageId: "pertanyaan",
        text: "ada yang tau jawabannya?",
      }),
    );
    const pending = runtime.turns.handle(first);
    await planStarted;

    await observeAuthorized(runtime.turns,
      message({
        messageId: "jawaban-manusia",
        participantId: "p2",
        participantAliases: ["p2"],
        participantName: "Bima",
        text: "aku tau, jawabannya 42",
      }),
    );
    releasePlan();

    assert.equal(await pending, "silent");
    assert.deepEqual(runtime.replies, []);
  });

  it("duplicate dan event akun lain tidak membatalkan kandidat ambient yang sah", async () => {
    let releasePlan!: () => void;
    let markPlanStarted!: () => void;
    const planGate = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    const planStarted = new Promise<void>((resolve) => {
      markPlanStarted = resolve;
    });
    const runtime = createRuntime({
      planAmbient: async () => {
        markPlanStarted();
        await planGate;
        return speakPlan("jawaban tetap relevan");
      },
    });
    const original = await observeAuthorized(runtime.turns,
      message({ messageId: "pertanyaan-valid" }),
    );
    const pending = runtime.turns.handle(original);
    await planStarted;

    await observeAuthorized(runtime.turns,
      message({ messageId: "pertanyaan-valid" }),
    );
    await observeAuthorized(runtime.turns,
      message({
        accountId: "nomor-non-binding",
        messageId: "event-akun-lain",
      }),
    );
    releasePlan();

    assert.equal(await pending, "replied");
    assert.deepEqual(runtime.replies, ["jawaban tetap relevan"]);
  });

  it("replay sebelum waktu bergabung tidak membatalkan kandidat live", async () => {
    let releasePlan!: () => void;
    let markPlanStarted!: () => void;
    const planGate = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    const planStarted = new Promise<void>((resolve) => {
      markPlanStarted = resolve;
    });
    const runtime = createRuntime({
      planAmbient: async () => {
        markPlanStarted();
        await planGate;
        return speakPlan("jawaban untuk pesan live");
      },
    });
    await runtime.turns.activateGroup({
      scope: { channel: "whatsapp", groupId: "grup@g.us" },
      accountId: "utama",
      groupName: "Grup uji",
      at: "2026-07-29T12:05:00.000Z",
    });
    const live = await observeAuthorized(runtime.turns,
      message({
        messageId: "live",
        at: "2026-07-29T12:06:00.000Z",
      }),
    );
    const pending = runtime.turns.handle(live);
    await planStarted;
    const replay = await runtime.turns.observeAuthorized(
      message({
        messageId: "replay-lama",
        at: "2026-07-29T12:00:00.000Z",
      }),
    );
    assert.equal(replay, null);
    releasePlan();

    assert.equal(await pending, "replied");
    assert.deepEqual(runtime.replies, ["jawaban untuk pesan live"]);
  });

  it("membatalkan planner ambient agar panggilan direct tidak menunggu timeout", async () => {
    let markPlannerStarted!: () => void;
    let markTypingStarted!: () => void;
    const plannerStarted = new Promise<void>((resolve) => {
      markPlannerStarted = resolve;
    });
    const typingStarted = new Promise<void>((resolve) => {
      markTypingStarted = resolve;
    });
    const runtime = createRuntime({
      planAmbient: async (
        _message,
        _context,
        _ownerId,
        signal,
      ) => {
        markPlannerStarted();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return null;
      },
      sendTyping: async () => {
        markTypingStarted();
      },
    });

    const ambient = runtime.turns.handle(
      message({
        messageId: "ambient-lambat",
        text: "ada yang tau jawabannya?",
      }),
    );
    await plannerStarted;
    const direct = runtime.turns.handle(
      message({
        messageId: "direct-prioritas",
        text: "Harvy, bantu sekarang",
        mentionsHarvy: true,
      }),
    );

    await typingStarted;
    assert.equal(await ambient, "silent");
    assert.equal(await direct, "replied");
  });

  it("merevalidasi kandidat bernilai tinggi setelah grup kembali hening", async () => {
    let releaseFirstPlan!: () => void;
    let markFirstPlanStarted!: () => void;
    let markReplied!: () => void;
    const firstPlanGate = new Promise<void>((resolve) => {
      releaseFirstPlan = resolve;
    });
    const firstPlanStarted = new Promise<void>((resolve) => {
      markFirstPlanStarted = resolve;
    });
    const replied = new Promise<void>((resolve) => {
      markReplied = resolve;
    });
    const runtime = createRuntime({
      now: () => new Date(),
      planAmbient: async (incoming) => {
        if (incoming.messageId === "target") {
          markFirstPlanStarted();
          await firstPlanGate;
          return speakPlan("kandidat lama");
        }
        return silentPlan();
      },
      revalidateAmbient: async (_message, _candidate, context) => {
        assert.match(
          context.turns.map((turn) => turn.text).join(" "),
          /pesan sela/,
        );
        return speakPlan("jawaban setelah cek ulang");
      },
      sendReply: async (_incoming, text) => {
        if (text === "jawaban setelah cek ulang") markReplied();
      },
    });
    const first = runtime.turns.handle(
      await observeAuthorized(runtime.turns,
        message({
          messageId: "target",
          text: "ada yang tahu jawabannya?",
          at: new Date().toISOString(),
        }),
      ),
    );
    await firstPlanStarted;
    const secondMessage = await observeAuthorized(runtime.turns,
      message({
        messageId: "sela",
        participantId: "p2",
        participantAliases: ["p2"],
        participantName: "Bima",
        text: "pesan sela yang belum menjawab",
        at: new Date().toISOString(),
      }),
    );
    const second = runtime.turns.handle(secondMessage);
    releaseFirstPlan();

    assert.equal(await first, "silent");
    assert.equal(await second, "silent");
    await within(replied, 2_500);
  });

  it("membatalkan kandidat ambient lama ketika mode runtime ditutup", async () => {
    const closedModes = [
      "direct_only",
      "paused",
      "disabled",
    ] as const;

    await Promise.all(closedModes.map(async (closedMode) => {
      let mode: Parameters<typeof groupRuntimeAdmission>[0] = "ambient";
      let releaseFirstPlan!: () => void;
      let markFirstPlanStarted!: () => void;
      const firstPlanGate = new Promise<void>((resolve) => {
        releaseFirstPlan = resolve;
      });
      const firstPlanStarted = new Promise<void>((resolve) => {
        markFirstPlanStarted = resolve;
      });
      let revalidationCalls = 0;
      const runtime = createRuntime({
        now: () => new Date(),
        runtimeAdmission: async (incoming) =>
          groupRuntimeAdmission(mode, incoming),
        planAmbient: async (incoming) => {
          if (incoming.messageId === `target-${closedMode}`) {
            markFirstPlanStarted();
            await firstPlanGate;
            return speakPlan("kandidat lama");
          }
          return silentPlan();
        },
        revalidateAmbient: async () => {
          revalidationCalls += 1;
          return speakPlan("tidak boleh terkirim");
        },
      });
      const first = runtime.turns.handle(
        await observeAuthorized(runtime.turns, message({
          messageId: `target-${closedMode}`,
          text: "ada yang tahu jawabannya?",
          at: new Date().toISOString(),
        })),
      );
      await firstPlanStarted;
      const second = runtime.turns.handle(
        await observeAuthorized(runtime.turns, message({
          messageId: `sela-${closedMode}`,
          participantId: "p2",
          participantAliases: ["p2"],
          participantName: "Bima",
          text: "sebentar, aku cek dulu",
          at: new Date().toISOString(),
        })),
      );
      releaseFirstPlan();

      assert.equal(await first, "silent");
      assert.equal(await second, "silent");
      mode = closedMode;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_050));
      await runtime.turns.drain();

      assert.equal(revalidationCalls, 0, closedMode);
      assert.deepEqual(runtime.replies, [], closedMode);
    }));
  });

  it("memeriksa ulang mode sebelum mengirim hasil ambient aktif", async () => {
    const closedModes = [
      ["direct_only", "silent"],
      ["paused", "silent"],
      ["disabled", "inactive"],
    ] as const;

    for (const [closedMode, expected] of closedModes) {
      let mode: Parameters<typeof groupRuntimeAdmission>[0] = "ambient";
      let releasePlan!: () => void;
      let markPlanStarted!: () => void;
      const planGate = new Promise<void>((resolve) => {
        releasePlan = resolve;
      });
      const planStarted = new Promise<void>((resolve) => {
        markPlanStarted = resolve;
      });
      const runtime = createRuntime({
        runtimeAdmission: async (incoming) =>
          groupRuntimeAdmission(mode, incoming),
        planAmbient: async () => {
          markPlanStarted();
          await planGate;
          return speakPlan("hasil yang sudah kedaluwarsa");
        },
      });
      const turn = runtime.turns.handle(message({
        messageId: `active-${closedMode}`,
        text: "ada yang tahu?",
      }));
      await planStarted;
      mode = closedMode;
      releasePlan();

      assert.equal(await turn, expected, closedMode);
      assert.deepEqual(runtime.replies, [], closedMode);
    }
  });

  it("menunggu seluruh bubble yang sudah terlihat selesai sebelum revalidasi", async () => {
    let releaseFirstPlan!: () => void;
    let markFirstPlanStarted!: () => void;
    let markRevalidated!: () => void;
    const firstPlanGate = new Promise<void>((resolve) => {
      releaseFirstPlan = resolve;
    });
    const firstPlanStarted = new Promise<void>((resolve) => {
      markFirstPlanStarted = resolve;
    });
    const revalidated = new Promise<void>((resolve) => {
      markRevalidated = resolve;
    });
    let revalidationCalls = 0;
    const runtime = createRuntime({
      now: () => new Date(),
      planAmbient: async (incoming) => {
        if (incoming.messageId === "target-belum-settle") {
          markFirstPlanStarted();
          await firstPlanGate;
          return speakPlan("kandidat yang harus menunggu");
        }
        return silentPlan();
      },
      revalidateAmbient: async () => {
        revalidationCalls += 1;
        markRevalidated();
        return speakPlan("jawaban sesudah semua bubble settle");
      },
    });
    const first = runtime.turns.handle(
      await observeAuthorized(runtime.turns,
        message({
          messageId: "target-belum-settle",
          text: "ada yang tahu jawabannya?",
          at: new Date().toISOString(),
        }),
      ),
    );
    await firstPlanStarted;
    const delayed = await observeAuthorized(runtime.turns,
      message({
        messageId: "bubble-terlihat",
        participantId: "p2",
        participantAliases: ["p2"],
        participantName: "Bima",
        text: "aku masih ngetik jawaban",
        at: new Date().toISOString(),
      }),
    );
    releaseFirstPlan();
    assert.equal(await first, "silent");

    await new Promise<void>((resolve) => setTimeout(resolve, 1_050));
    assert.equal(revalidationCalls, 0);

    assert.equal(await runtime.turns.handle(delayed), "silent");
    await within(revalidated, 2_500);
    assert.equal(revalidationCalls, 1);
  });

  it("membatalkan revalidasi aktif agar panggilan langsung tidak tertahan", async () => {
    let releaseFirstPlan!: () => void;
    let markFirstPlanStarted!: () => void;
    let markRevalidationStarted!: () => void;
    const firstPlanGate = new Promise<void>((resolve) => {
      releaseFirstPlan = resolve;
    });
    const firstPlanStarted = new Promise<void>((resolve) => {
      markFirstPlanStarted = resolve;
    });
    const revalidationStarted = new Promise<void>((resolve) => {
      markRevalidationStarted = resolve;
    });
    const runtime = createRuntime({
      now: () => new Date(),
      planAmbient: async (incoming) => {
        if (incoming.messageId === "target-revalidasi") {
          markFirstPlanStarted();
          await firstPlanGate;
          return speakPlan("kandidat lambat");
        }
        return silentPlan();
      },
      revalidateAmbient: async (
        _message,
        _candidate,
        _context,
        _ownerId,
        signal,
      ) => {
        markRevalidationStarted();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return null;
      },
    });
    const first = runtime.turns.handle(
      await observeAuthorized(runtime.turns,
        message({
          messageId: "target-revalidasi",
          text: "ada yang bisa bantu?",
          at: new Date().toISOString(),
        }),
      ),
    );
    await firstPlanStarted;
    const interjection = runtime.turns.handle(
      await observeAuthorized(runtime.turns,
        message({
          messageId: "sela-revalidasi",
          participantId: "p2",
          participantAliases: ["p2"],
          participantName: "Bima",
          text: "sebentar aku cek",
          at: new Date().toISOString(),
        }),
      ),
    );
    releaseFirstPlan();
    assert.equal(await first, "silent");
    assert.equal(await interjection, "silent");
    await within(revalidationStarted, 2_500);

    const direct = runtime.turns.handle(
      message({
        messageId: "direct-saat-revalidasi",
        text: "Harvy, bantu aku sekarang",
        mentionsHarvy: true,
        at: new Date().toISOString(),
      }),
    );
    assert.equal(await within(direct, 500), "replied");
  });

  it("tidak memulai revalidasi bila direct datang saat konteks masih dibaca", async () => {
    let releaseFirstPlan!: () => void;
    let markFirstPlanStarted!: () => void;
    let releaseMemory!: () => void;
    let markMemoryRead!: () => void;
    const firstPlanGate = new Promise<void>((resolve) => {
      releaseFirstPlan = resolve;
    });
    const firstPlanStarted = new Promise<void>((resolve) => {
      markFirstPlanStarted = resolve;
    });
    const memoryGate = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const memoryRead = new Promise<void>((resolve) => {
      markMemoryRead = resolve;
    });
    const repository = new GatedMemoryRepository();
    let revalidationCalls = 0;
    const runtime = createRuntime({
      repository,
      now: () => new Date(),
      planAmbient: async (incoming) => {
        if (incoming.messageId === "target-baca-konteks") {
          markFirstPlanStarted();
          await firstPlanGate;
          return speakPlan("kandidat lama");
        }
        return silentPlan();
      },
      revalidateAmbient: async () => {
        revalidationCalls += 1;
        return speakPlan("tidak boleh dibuat");
      },
    });
    const first = runtime.turns.handle(
      await observeAuthorized(runtime.turns,
        message({
          messageId: "target-baca-konteks",
          text: "ada yang tahu?",
          at: new Date().toISOString(),
        }),
      ),
    );
    await firstPlanStarted;
    const interjection = runtime.turns.handle(
      await observeAuthorized(runtime.turns,
        message({
          messageId: "sela-baca-konteks",
          participantId: "p2",
          participantAliases: ["p2"],
          participantName: "Bima",
          text: "aku cek dulu",
          at: new Date().toISOString(),
        }),
      ),
    );
    releaseFirstPlan();
    assert.equal(await first, "silent");
    assert.equal(await interjection, "silent");

    repository.gateNextMemory = async () => {
      markMemoryRead();
      await memoryGate;
    };
    await within(memoryRead, 2_500);
    const direct = runtime.turns.handle(
      message({
        messageId: "direct-saat-baca-konteks",
        text: "Harvy, bantu sekarang",
        mentionsHarvy: true,
        at: new Date().toISOString(),
      }),
    );
    releaseMemory();

    assert.equal(await within(direct, 500), "replied");
    assert.equal(revalidationCalls, 0);
  });

  it("tidak memulai revalidasi bila mode ditutup saat konteks dibaca", async () => {
    let mode: Parameters<typeof groupRuntimeAdmission>[0] = "ambient";
    let releaseFirstPlan!: () => void;
    let markFirstPlanStarted!: () => void;
    let releaseMemory!: () => void;
    let markMemoryRead!: () => void;
    const firstPlanGate = new Promise<void>((resolve) => {
      releaseFirstPlan = resolve;
    });
    const firstPlanStarted = new Promise<void>((resolve) => {
      markFirstPlanStarted = resolve;
    });
    const memoryGate = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const memoryRead = new Promise<void>((resolve) => {
      markMemoryRead = resolve;
    });
    const repository = new GatedMemoryRepository();
    let revalidationCalls = 0;
    const runtime = createRuntime({
      repository,
      now: () => new Date(),
      runtimeAdmission: async (incoming) =>
        groupRuntimeAdmission(mode, incoming),
      planAmbient: async (incoming) => {
        if (incoming.messageId === "target-mode-baca-konteks") {
          markFirstPlanStarted();
          await firstPlanGate;
          return speakPlan("kandidat lama");
        }
        return silentPlan();
      },
      revalidateAmbient: async () => {
        revalidationCalls += 1;
        return speakPlan("tidak boleh dibuat");
      },
    });
    const first = runtime.turns.handle(
      await observeAuthorized(runtime.turns, message({
        messageId: "target-mode-baca-konteks",
        text: "ada yang tahu?",
        at: new Date().toISOString(),
      })),
    );
    await firstPlanStarted;
    const interjection = runtime.turns.handle(
      await observeAuthorized(runtime.turns, message({
        messageId: "sela-mode-baca-konteks",
        participantId: "p2",
        participantAliases: ["p2"],
        participantName: "Bima",
        text: "aku cek dulu",
        at: new Date().toISOString(),
      })),
    );
    releaseFirstPlan();
    assert.equal(await first, "silent");
    assert.equal(await interjection, "silent");

    repository.gateNextMemory = async () => {
      markMemoryRead();
      await memoryGate;
    };
    await within(memoryRead, 2_500);
    mode = "direct_only";
    releaseMemory();
    await runtime.turns.drain();

    assert.equal(revalidationCalls, 0);
    assert.deepEqual(runtime.replies, []);
  });

  it("tidak memanggil planner untuk pesan yang sedang membalas anggota lain", async () => {
    let plannerCalls = 0;
    const runtime = createRuntime({
      planAmbient: async () => {
        plannerCalls += 1;
        return speakPlan("aku tidak semestinya menyela thread ini");
      },
    });

    const outcome = await runtime.turns.handle(
      message({
        messageId: "reply-ke-bima",
        text: "iya Bim, bagianmu udah pas kok",
        quotedMessageId: "pesan-bima",
        quotedParticipantId: "p2",
      }),
    );

    assert.equal(outcome, "silent");
    assert.equal(plannerCalls, 0);
    assert.deepEqual(runtime.replies, []);
  });

  it("tidak memanggil planner untuk acknowledgment atau izin antaranggota", async () => {
    let plannerCalls = 0;
    const runtime = createRuntime({
      planAmbient: async () => {
        plannerCalls += 1;
        return speakPlan("aku tidak semestinya mengisi penutup ini");
      },
    });

    assert.equal(
      await runtime.turns.handle(
        message({
          messageId: "ack",
          text: "nah itu yg menarik",
        }),
      ),
      "silent",
    );
    assert.equal(
      await runtime.turns.handle(
        message({
          messageId: "izin",
          text: "boleh kirim aja",
        }),
      ),
      "silent",
    );
    assert.equal(plannerCalls, 0);
  });

  it("menolak replay yang lebih tua daripada waktu Harvy bergabung", async () => {
    const runtime = createRuntime();
    await runtime.turns.activateGroup({
      scope: { channel: "whatsapp", groupId: "grup@g.us" },
      accountId: "utama",
      groupName: "Grup uji",
      at: "2026-07-29T12:05:00.000Z",
    });

    const outcome = await runtime.turns.handle(
      message({ at: "2026-07-29T12:00:00.000Z" }),
    );

    assert.equal(outcome, "inactive");
  });

  it("memfilter bubble pra-join sebelum priority assessment model", async () => {
    let releaseOrdinary!: () => void;
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let markOrdinaryBlocked!: () => void;
    const ordinaryBlocked = new Promise<void>((resolve) => {
      markOrdinaryBlocked = resolve;
    });
    let markPriorityAssessed!: () => void;
    const priorityAssessed = new Promise<void>((resolve) => {
      markPriorityAssessed = resolve;
    });
    const assessed: string[] = [];
    const triaged: string[] = [];
    const repliedTo: string[] = [];
    const runtime = createRuntime({
      assessGroupIngress: async (text) => {
        assessed.push(text);
        if (text.includes("PESAN-LIVE")) {
          markPriorityAssessed();
          return {
            riskHint: {
              level: "possible",
              category: "acute_distress",
              confidence: 0.7,
            },
            contextPrivacy: "ordinary",
          };
        }
        return { riskHint: NO_RISK_HINT, contextPrivacy: "ordinary" };
      },
      triageRisk: async (text) => {
        triaged.push(text);
        return CALM_TRIAGE;
      },
      reply: async (incoming) => {
        repliedTo.push(incoming.text);
        if (incoming.messageId === "pemblokir") {
          markOrdinaryBlocked();
          await ordinaryGate;
        }
        return "balasan";
      },
    });
    await runtime.turns.activateGroup({
      scope: { channel: "whatsapp", groupId: "grup@g.us" },
      accountId: "utama",
      groupName: "Grup uji",
      at: "2026-07-29T12:05:00.000Z",
    });
    const ordinary = runtime.turns.handle(message({
      messageId: "pemblokir",
      text: "Harvy tunggu sebentar",
      at: "2026-07-29T12:05:01.000Z",
      mentionsHarvy: true,
    }));
    await within(ordinaryBlocked, 1_000);
    const mixed = runtime.turns.handle(message({
      messageId: "live",
      text: "RAHASIA-SEBELUM-JOIN aku dalam bahaya sekarang\nPESAN-LIVE",
      at: "2026-07-29T12:05:02.000Z",
      mentionsHarvy: true,
      parts: [
        {
          messageId: "old",
          text: "RAHASIA-SEBELUM-JOIN aku dalam bahaya sekarang",
          at: "2026-07-29T12:00:00.000Z",
          mentionsHarvy: true,
          repliesToHarvy: false,
        },
        {
          messageId: "live",
          text: "PESAN-LIVE",
          at: "2026-07-29T12:05:02.000Z",
          mentionsHarvy: true,
          repliesToHarvy: false,
        },
      ],
    }));
    await within(priorityAssessed, 1_000);

    assert.deepEqual(assessed, ["Harvy tunggu sebentar", "PESAN-LIVE"]);
    assert.deepEqual(triaged, ["PESAN-LIVE"]);
    releaseOrdinary();
    await Promise.all([ordinary, mixed]);
    assert.ok(repliedTo.every((text) => !text.includes("RAHASIA-SEBELUM-JOIN")));
    const memory = await runtime.memories.memory("whatsapp:grup@g.us");
    assert.ok(
      memory?.recentMessageIds.some((seen) => seen.messageId === "live"),
    );
    assert.ok(
      memory?.recentMessageIds.every((seen) => seen.messageId !== "old"),
    );
  });

  it("tidak memproses pesan bila pemberitahuan gagal terkirim", async () => {
    let modelCalls = 0;
    const runtime = createRuntime({
      sendNotice: async () => {
        throw new Error("WhatsApp gagal");
      },
      triageRisk: async () => {
        modelCalls += 1;
        return CALM_TRIAGE;
      },
      reply: async () => {
        modelCalls += 1;
        return "tidak boleh terkirim";
      },
    });

    assert.equal(
      await runtime.turns.handle(message({ mentionsHarvy: true })),
      "notice-failed",
    );
    assert.equal(runtime.replies.length, 0);
    assert.equal(modelCalls, 0);
  });

  it("membatalkan aktivasi dan notice ketika fence berubah setelah binding", async () => {
    const allowStarted = deferredVoid();
    const releaseAllow = deferredVoid();
    let fenceCurrent = true;
    let notices = 0;
    let forgotten = 0;
    const runtime = createRuntime({
      usageControl: {
        allow: async () => {
          allowStarted.resolve();
          await releaseAllow.promise;
        },
        forget: async () => {
          forgotten += 1;
        },
      },
      sendNotice: async (_target, _text, runtimeFence) => {
        if (runtimeFence?.() !== false) notices += 1;
      },
    });

    const activation = runtime.turns.activateGroup(
      message({ groupName: "Grup uji" }),
      () => fenceCurrent,
    );
    await allowStarted.promise;
    fenceCurrent = false;
    releaseAllow.resolve();

    assert.equal(await activation, "inactive");
    assert.equal(notices, 0);
    assert.equal(forgotten, 1);
    const binding = await runtime.memories.binding("whatsapp:grup@g.us");
    assert.ok(binding);
    assert.notEqual(binding.disabledAt, null);
    assert.equal(binding.noticeSentAt, null);
  });

  it("mengulang notice gagal lalu memproses pesan berikutnya", async () => {
    let notices = 0;
    const runtime = createRuntime({
      sendNotice: async () => {
        notices += 1;
        if (notices === 1) throw new Error("WhatsApp gagal sementara");
      },
      reply: async () => "notice sudah siap",
    });

    assert.equal(
      await runtime.turns.handle(message({
        messageId: "notice-gagal-pertama",
        text: "Harvy, percobaan pertama",
        mentionsHarvy: false,
      })),
      "notice-failed",
    );
    assert.equal(
      await runtime.turns.handle(message({
        messageId: "notice-berhasil-kedua",
        text: "Harvy, coba lagi",
        mentionsHarvy: false,
      })),
      "replied",
    );
    assert.equal(notices, 2);
    assert.deepEqual(runtime.replies, ["notice sudah siap"]);
  });

  it("mempertahankan identitas pembicara dalam konteks grup", async () => {
    const contexts: GroupTurn[][] = [];
    const runtime = createRuntime({
      reply: async (_message, context) => {
        contexts.push([...context.turns]);
        return "oke";
      },
    });

    await runtime.turns.handle(
      message({
        messageId: "satu",
        participantId: "p1",
        participantName: "Ayu",
        mentionsHarvy: true,
      }),
    );
    await runtime.turns.handle(
      message({
        messageId: "dua",
        participantId: "p2",
        participantAliases: ["p2"],
        participantName: "Bima",
        mentionsHarvy: true,
      }),
    );

    assert.equal(contexts[1]?.[0]?.participantName, "Ayu");
    assert.equal(contexts[1]?.[0]?.text, "halo semua");
    assert.equal(contexts[1]?.[1]?.role, "harvy");
  });

  it("hanya memasukkan bubble grup yang benar-benar terkirim ke konteks", async () => {
    let observedFollowUp: GroupTurn[] = [];
    const runtime = createRuntime({
      reply: async (incoming, context) => {
        if (incoming.messageId === "jawaban-terpotong") {
          return "Bubble terkirim.\n\nContinuation yang tidak terkirim.";
        }
        observedFollowUp = [...context.turns];
        return "Jawaban terbaru.";
      },
      sendReply: async (incoming) => {
        if (incoming.messageId === "jawaban-terpotong") {
          return {
            text: "Bubble terkirim.",
            bubbleCount: 1,
            complete: false,
          };
        }
      },
    });

    assert.equal(
      await runtime.turns.handle(message({
        messageId: "jawaban-terpotong",
        text: "Harvy, bantu dulu",
        mentionsHarvy: true,
      })),
      "inactive",
    );
    assert.equal(
      await runtime.turns.handle(message({
        messageId: "lanjutan-setelah-potong",
        text: "Harvy, lanjut yang terbaru",
        mentionsHarvy: true,
      })),
      "replied",
    );

    const harvyContext = observedFollowUp
      .filter((turn) => turn.role === "harvy")
      .map((turn) => turn.text);
    assert.deepEqual(harvyContext, ["Bubble terkirim."]);
    assert.doesNotMatch(
      observedFollowUp.map((turn) => turn.text).join(" "),
      /Continuation yang tidak terkirim/u,
    );
  });

  it("membatalkan balasan yang selesai setelah Harvy dikeluarkan", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createRuntime({
      reply: async () => {
        await gate;
        return "terlambat";
      },
    });

    const pending = runtime.turns.handle(message({ mentionsHarvy: true }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await runtime.turns.disableGroup("whatsapp:grup@g.us", "utama");
    release();

    assert.equal(await pending, "inactive");
    assert.equal(runtime.replies.length, 0);
  });

  it("mengulang penghapusan telemetry meski cleanup repository sudah commit", async () => {
    let forgetCalls = 0;
    const usageControl: GroupUsageControlPort = {
      allow: async () => undefined,
      forget: async () => {
        forgetCalls += 1;
        if (forgetCalls === 1) throw new Error("telemetry gagal sekali");
      },
    };
    const runtime = createRuntime({ usageControl });
    await runtime.turns.handle(message({ mentionsHarvy: true }));

    await assert.rejects(
      runtime.turns.disableGroup("whatsapp:grup@g.us", "utama"),
      /telemetry gagal sekali/u,
    );
    assert.equal(
      await runtime.turns.disableGroup("whatsapp:grup@g.us", "utama"),
      false,
    );
    assert.equal(forgetCalls, 2);
  });

  it("memeriksa ulang generation setelah read binding yang tertahan", async () => {
    let releaseBinding!: () => void;
    let markBindingRead!: () => void;
    const bindingGate = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });
    const bindingRead = new Promise<void>((resolve) => {
      markBindingRead = resolve;
    });
    const repository = new GatedBindingRepository();
    const runtime = createRuntime({
      repository,
      reply: async () => {
        repository.gateNextLoad = async () => {
          markBindingRead();
          await bindingGate;
        };
        return "jangan sampai terkirim";
      },
    });

    const pending = runtime.turns.handle(
      message({ mentionsHarvy: true }),
    );
    await bindingRead;
    await runtime.turns.disableGroup(
      "whatsapp:grup@g.us",
      "utama",
    );
    releaseBinding();

    assert.equal(await pending, "inactive");
    assert.deepEqual(runtime.replies, []);
  });

  it("tidak mengaktifkan binding setelah self-remove membaca binding kosong", async () => {
    let releaseBinding!: () => void;
    let markBindingRead!: () => void;
    const bindingGate = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });
    const bindingRead = new Promise<void>((resolve) => {
      markBindingRead = resolve;
    });
    const repository = new GatedBindingRepository();
    repository.gateNextLoad = async () => {
      markBindingRead();
      await bindingGate;
    };
    const runtime = createRuntime({ repository });

    const pending = runtime.turns.handle(
      message({ messageId: "aktivasi-tertahan", mentionsHarvy: true }),
    );
    await bindingRead;
    assert.equal(
      await runtime.turns.disableGroup(
        "whatsapp:grup@g.us",
        "utama",
      ),
      false,
    );
    releaseBinding();

    assert.equal(await pending, "inactive");
    assert.equal(
      await runtime.memories.binding("whatsapp:grup@g.us"),
      null,
    );
    assert.deepEqual(runtime.replies, []);
  });

  it("menghapus statistik diri lewat bahasa alami", async () => {
    const deletedActors: { ownerId: string; aliases: readonly string[] }[] = [];
    const runtime = createRuntime({
      usageControl: {
        allow: async () => undefined,
        forget: async () => undefined,
        forgetActor: async (ownerId, aliases) => {
          deletedActors.push({ ownerId, aliases });
          return true;
        },
      },
    });
    await runtime.turns.handle(message({ messageId: "awal" }));

    await runtime.turns.handle(
      message({
        messageId: "hapus",
        text: "Harvy, lupakan tentang aku",
        mentionsHarvy: true,
      }),
    );
    assert.match(
      runtime.replies.at(-1) ?? "",
      /balas lagi.*lupakan (?:aktivitasku|tentang aku)/i,
    );
    assert.equal(
      (await runtime.memories.memory("whatsapp:grup@g.us"))?.participants
        .length,
      1,
    );

    await runtime.turns.handle(
      message({
        messageId: "konfirmasi-hapus",
        text: "ya, lupakan aktivitasku",
        repliesToHarvy: true,
      }),
    );

    assert.match(runtime.replies.at(-1) ?? "", /Catatan aktivitasmu.*atribusi teknis.*kuhapus/i);
    const memory = await runtime.memories.memory("whatsapp:grup@g.us");
    assert.deepEqual(memory?.participants, []);
    assert.equal(deletedActors[0]?.ownerId, "whatsapp:grup@g.us");
    assert.ok(deletedActors[0]?.aliases.includes("p1"));
  });

  it("tidak mengklaim atribusi teknis terhapus ketika adapter usage menolaknya", async () => {
    const runtime = createRuntime({
      usageControl: {
        allow: async () => undefined,
        forget: async () => undefined,
        forgetActor: async () => false,
      },
    });
    await runtime.turns.handle(message({ messageId: "awal-usage-gagal" }));
    await runtime.turns.handle(
      message({
        messageId: "minta-hapus-usage-gagal",
        text: "Harvy, lupakan tentang aku",
        mentionsHarvy: true,
      }),
    );
    await runtime.turns.handle(
      message({
        messageId: "konfirmasi-usage-gagal",
        text: "ya, lupakan aktivitasku",
        repliesToHarvy: true,
      }),
    );

    assert.match(
      runtime.replies.at(-1) ?? "",
      /Catatan aktivitas dan memori.*kuhapus/i,
    );
    assert.match(
      runtime.replies.at(-1) ?? "",
      /atribusi teknis.*tidak dapat dihapus/i,
    );
    assert.doesNotMatch(
      runtime.replies.at(-1) ?? "",
      /atribusi teknis.*kuhapus/i,
    );
  });

  it("memproses pesan live pertama meski jam penerimaan lebih lambat", async () => {
    const runtime = createRuntime({
      now: () => new Date("2026-07-29T12:00:00.900Z"),
    });

    const outcome = await runtime.turns.handle(
      message({
        at: "2026-07-29T12:00:00.000Z",
        mentionsHarvy: true,
      }),
    );

    assert.equal(outcome, "replied");
  });

  it("menjawab identitas model Capybara tanpa memanggil model grup", async () => {
    let modelCalls = 0;
    const runtime = createRuntime({
      triageRisk: async () => {
        modelCalls += 1;
        throw new Error("model tidak tersedia");
      },
      reply: async () => {
        modelCalls += 1;
        throw new Error("model tidak boleh dipanggil");
      },
    });

    assert.equal(
      await runtime.turns.handle(
        message({
          text: "Harvy, kamu ChatGPT?",
          mentionsHarvy: true,
        }),
      ),
      "replied",
    );
    assert.equal(runtime.replies.at(-1), CAPYBARA_MODEL_REPLY);
    assert.equal(modelCalls, 0);
  });

  it("tidak menghidupkan memori lagi bila removal terjadi saat send", async () => {
    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const runtime = createRuntime({
      sendReply: async () => {
        markSendStarted();
        await sendGate;
      },
    });

    const pending = runtime.turns.handle(
      message({ mentionsHarvy: true }),
    );
    await sendStarted;
    await runtime.turns.disableGroup("whatsapp:grup@g.us", "utama");
    releaseSend();

    assert.equal(await pending, "inactive");
    assert.equal(
      await runtime.memories.memory("whatsapp:grup@g.us"),
      null,
    );
  });

  it("menjalankan triase hanya untuk hint possible/strong dan menjaga outage evidence-aware", async () => {
    let triageCalls = 0;
    let reviewCalls = 0;
    const routed = new Map<string, { level: RiskTriage["level"]; certain: boolean }>();
    const runtime = createRuntime({
      assessGroupIngress: async (text) => ({
        riskHint: text.includes("ordinary")
          ? NO_RISK_HINT
          : {
              level: text.includes("strong") ? "strong" : "possible",
              category: "acute_distress",
              confidence: 0.9,
            },
        contextPrivacy: "ordinary",
      }),
      triageRisk: async () => {
        triageCalls += 1;
        return null;
      },
      reviewReply: async () => {
        reviewCalls += 1;
        return true;
      },
      reply: async (incoming, _context, triage) => {
        routed.set(incoming.messageId, {
          level: triage.level,
          certain: triage.certain,
        });
        return "balasan normal";
      },
    });

    await runtime.turns.handle(message({
      messageId: "ordinary",
      text: "Harvy, ordinary",
      mentionsHarvy: true,
    }));
    await runtime.turns.handle(message({
      messageId: "possible",
      text: "Harvy, possible",
      mentionsHarvy: true,
    }));
    await runtime.turns.handle(message({
      messageId: "strong",
      text: "Harvy, strong",
      mentionsHarvy: true,
    }));

    assert.equal(triageCalls, 2);
    assert.deepEqual(routed.get("ordinary"), {
      level: "biasa",
      certain: true,
    });
    assert.deepEqual(routed.get("possible"), {
      level: "biasa",
      certain: false,
    });
    assert.deepEqual(routed.get("strong"), {
      level: "dukungan",
      certain: false,
    });
    assert.equal(reviewCalls, 1);
  });

  it("fallback triase saat ingress unavailable tanpa menyimpan raw context", async () => {
    let triageCalls = 0;
    const contexts = new Map<string, string>();
    const routed = new Map<string, { level: RiskTriage["level"]; certain: boolean }>();
    const runtime = createRuntime({
      assessGroupIngress: async (text) =>
        text.includes("ordinary-after")
          ? {
              riskHint: NO_RISK_HINT,
              contextPrivacy: "ordinary",
            }
          : null,
      triageRisk: async () => {
        triageCalls += 1;
        return null;
      },
      reply: async (incoming, context, triage) => {
        contexts.set(
          incoming.messageId,
          context.turns.map((turn) => turn.text).join(" "),
        );
        routed.set(incoming.messageId, {
          level: triage.level,
          certain: triage.certain,
        });
        return `normal-${incoming.messageId}`;
      },
    });

    await runtime.turns.handle(message({
      messageId: "ingress-unavailable",
      text: "Harvy, ingress unavailable",
      mentionsHarvy: true,
    }));
    await runtime.turns.handle(message({
      messageId: "ordinary-after",
      text: "Harvy, ordinary-after",
      mentionsHarvy: true,
    }));

    assert.equal(triageCalls, 1);
    assert.deepEqual(routed.get("ingress-unavailable"), {
      level: "biasa",
      certain: false,
    });
    assert.doesNotMatch(
      contexts.get("ordinary-after") ?? "",
      /ingress unavailable|normal-ingress-unavailable/u,
    );
  });

  it("mereview danger tetapi tidak membayar reviewer kedua untuk support yang pasti", async () => {
    let reviews = 0;
    const support: RiskTriage = {
      level: "dukungan",
      alone: false,
      sensitive: false,
      summary: "butuh dukungan",
      certain: true,
    };
    const danger: RiskTriage = {
      ...support,
      level: "bahaya",
      summary: "bahaya dekat",
    };
    const runtime = createRuntime({
      assessGroupIngress: async () => ({
        riskHint: {
          level: "possible",
          category: "acute_distress",
          confidence: 0.7,
        },
        contextPrivacy: "ordinary",
      }),
      triageRisk: async (text) =>
        text.includes("danger-result") ? danger : support,
      reviewReply: async () => {
        reviews += 1;
        return true;
      },
    });

    await runtime.turns.handle(message({
      messageId: "support-certain",
      text: "Harvy, support-result",
      mentionsHarvy: true,
    }));
    assert.equal(reviews, 0);
    await runtime.turns.handle(message({
      messageId: "danger-certain",
      text: "Harvy, danger-result",
      mentionsHarvy: true,
    }));
    assert.equal(reviews, 1);
  });

  it("privacy sensitive atau unavailable menahan raw context tanpa mengubah UX normal", async () => {
    const contexts = new Map<string, string>();
    let triageCalls = 0;
    const runtime = createRuntime({
      assessGroupIngress: async (text) => ({
        riskHint: NO_RISK_HINT,
        contextPrivacy: text.includes("sensitive")
          ? "sensitive"
          : text.includes("unknown")
            ? null
            : "ordinary",
      }),
      triageRisk: async () => {
        triageCalls += 1;
        return CALM_TRIAGE;
      },
      reply: async (incoming, context, triage) => {
        contexts.set(
          incoming.messageId,
          context.turns.map((turn) => turn.text).join(" "),
        );
        assert.equal(triage.level, "biasa");
        return `normal-${incoming.messageId}`;
      },
    });

    await runtime.turns.handle(message({
      messageId: "sensitive",
      text: "Harvy, sensitive story",
      mentionsHarvy: true,
    }));
    await runtime.turns.handle(message({
      messageId: "unknown",
      text: "Harvy, unknown privacy",
      mentionsHarvy: true,
    }));
    await runtime.turns.handle(message({
      messageId: "ordinary-after",
      text: "Harvy, ordinary after",
      mentionsHarvy: true,
    }));

    assert.equal(triageCalls, 0);
    assert.doesNotMatch(
      contexts.get("ordinary-after") ?? "",
      /sensitive story|unknown privacy|normal-sensitive|normal-unknown/u,
    );
  });

  it("kandidat grup implisit tidak menjadi durable memory", async () => {
    const runtime = createRuntime({
      memoryExtractor: {
        understand: async (text) =>
          text.includes("candidate")
            ? understanding({
                kind: "preference",
                content: "Suka belajar pagi",
              })
            : { ...understanding({
                kind: "preference",
                content: "tidak dipakai",
              }), memories: [] },
      },
      assessGroupIngress: async () => ({
        riskHint: NO_RISK_HINT,
        contextPrivacy: "ordinary",
      }),
    });

    await runtime.turns.handle(message({
      messageId: "tanpa-candidate",
      text: "Harvy, halo",
      mentionsHarvy: true,
    }));
    await runtime.turns.handle(message({
      messageId: "dengan-candidate",
      text: "Harvy, candidate",
      mentionsHarvy: true,
    }));

    assert.deepEqual(
      await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["p1"],
      ),
      [],
    );
    assert.doesNotMatch(runtime.replies.at(-1) ?? "", /simpan memori ini/iu);
  });

  it("menolak semua model call ketika authority ingress tidak terbukti", async () => {
    let ingressCalls = 0;
    let triageCalls = 0;
    let replyCalls = 0;
    const runtime = createRuntime({
      authority: {
        resolveGroupAuthority: async () => null,
      },
      assessGroupIngress: async () => {
        ingressCalls += 1;
        return { riskHint: NO_RISK_HINT, contextPrivacy: "ordinary" };
      },
      triageRisk: async () => {
        triageCalls += 1;
        return CALM_TRIAGE;
      },
      reply: async () => {
        replyCalls += 1;
        return "tidak boleh terkirim";
      },
    });

    assert.equal(
      await runtime.turns.handle(message({
        text: "aku dalam bahaya sekarang",
        mentionsHarvy: true,
      })),
      "inactive",
    );
    assert.equal(ingressCalls, 0);
    assert.equal(triageCalls, 0);
    assert.equal(replyCalls, 0);
    assert.deepEqual(runtime.replies, []);
  });

  it("ingress tanpa authority tidak membatalkan planner sah yang sedang berjalan", async () => {
    let denySecondParticipant = false;
    let plannerSignal: AbortSignal | undefined;
    const plannerStarted = deferredVoid();
    const releasePlanner = deferredVoid();
    const runtime = createRuntime({
      authority: {
        resolveGroupAuthority: async ({ participantIds }) =>
          denySecondParticipant && participantIds.includes("p2")
            ? null
            : { role: "member", authorityEpoch: 1 },
      },
      planAmbient: async (
        _incoming,
        _context,
        _ownerId,
        signal,
      ) => {
        plannerSignal = signal;
        plannerStarted.resolve();
        await releasePlanner.promise;
        return speakPlan("jawaban sah tetap terkirim");
      },
    });

    const valid = runtime.turns.handle(message({
      messageId: "ambient-sah",
      text: "ada yang tahu jawabannya?",
    }));
    await plannerStarted.promise;
    denySecondParticipant = true;
    const denied = runtime.turns.handle(message({
      messageId: "direct-tanpa-authority",
      participantId: "p2",
      participantAliases: ["p2"],
      mentionsHarvy: true,
      text: "Harvy, batalkan yang tadi",
    }));

    assert.equal(await denied, "inactive");
    assert.equal(plannerSignal?.aborted, false);
    releasePlanner.resolve();
    assert.equal(await valid, "replied");
    assert.deepEqual(runtime.replies, ["jawaban sah tetap terkirim"]);
  });

  it("menandai committed observation sebagai settled saat revalidasi menolak turn", async () => {
    let authorityCalls = 0;
    const runtime = createRuntime({
      authority: {
        resolveGroupAuthority: async () => {
          authorityCalls += 1;
          return authorityCalls === 1
            ? { role: "member", authorityEpoch: 1 }
            : null;
        },
      },
    });
    await runtime.turns.activateGroup({
      scope: { channel: "whatsapp", groupId: "grup@g.us" },
      accountId: "utama",
      groupName: "Grup uji",
      at: NOW.toISOString(),
    });
    const observed = await runtime.turns.observeAuthorized(message({
      messageId: "committed-lalu-ditolak",
      mentionsHarvy: true,
    }));
    assert.ok(observed);
    assert.equal(observed.ingressRevision, 1);

    assert.equal(await runtime.turns.handle(observed), "inactive");
    const state = runtime.turns as unknown as {
      settledObservations: Map<string, number>;
    };
    assert.equal(
      state.settledObservations.get("whatsapp:grup@g.us\u0000account:utama"),
      1,
    );
  });

  it("menyelesaikan watermark observation yang ditolak runtime admission", async () => {
    const runtime = createRuntime();
    await runtime.turns.activateGroup({
      scope: { channel: "whatsapp", groupId: "grup@g.us" },
      accountId: "utama",
      groupName: "Grup uji",
      at: NOW.toISOString(),
    });
    const observed = await observeAuthorized(runtime.turns, message({
      messageId: "ditolak-admission",
    }));

    runtime.turns.settleRejectedObservation(observed);
    const state = runtime.turns as unknown as {
      settledObservations: Map<string, number>;
    };
    assert.equal(
      state.settledObservations.get("whatsapp:grup@g.us\u0000account:utama"),
      observed.ingressRevision,
    );
  });

  it("menserialisasi observasi authority agar resolusi lambat tidak membalik ingress", async () => {
    const firstAuthorityStarted = deferredVoid();
    const releaseFirstAuthority = deferredVoid();
    const resolvedParticipants: string[] = [];
    const runtime = createRuntime({
      authority: {
        resolveGroupAuthority: async ({ participantIds }) => {
          const participant = participantIds[0] ?? "unknown";
          resolvedParticipants.push(participant);
          if (participant === "p1") {
            firstAuthorityStarted.resolve();
            await releaseFirstAuthority.promise;
          }
          return { role: "member", authorityEpoch: 1 };
        },
      },
    });
    await runtime.turns.activateGroup({
      scope: { channel: "whatsapp", groupId: "grup@g.us" },
      accountId: "utama",
      groupName: "Grup uji",
      at: NOW.toISOString(),
    });

    const first = runtime.turns.observeAuthorized(message({
      messageId: "observasi-a",
      participantId: "p1",
      participantAliases: ["p1"],
    }));
    await firstAuthorityStarted.promise;
    const second = runtime.turns.observeAuthorized(message({
      messageId: "observasi-b",
      participantId: "p2",
      participantAliases: ["p2"],
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(resolvedParticipants, ["p1"]);

    releaseFirstAuthority.resolve();
    const [observedFirst, observedSecond] = await Promise.all([first, second]);
    assert.equal(observedFirst?.ingressRevision, 1);
    assert.equal(observedSecond?.ingressRevision, 2);
    assert.deepEqual(resolvedParticipants, ["p1", "p2"]);
  });

  it("hak hapus data tetap mencapai control flow pada support yang pasti", async () => {
    const support: RiskTriage = {
      level: "dukungan",
      alone: false,
      sensitive: false,
      summary: "butuh dukungan",
      certain: true,
    };
    const runtime = createRuntime({
      assessGroupIngress: async () => ({
        riskHint: {
          level: "possible",
          category: "acute_distress",
          confidence: 0.7,
        },
        contextPrivacy: "ordinary",
      }),
      triageRisk: async () => support,
    });

    assert.equal(
      await runtime.turns.handle(message({
        messageId: "forget-support",
        text: "Harvy, lupakan tentang aku",
        mentionsHarvy: true,
      })),
      "replied",
    );
    assert.match(runtime.replies.at(-1) ?? "", /balas.*ya.*lupakan/iu);
  });

  it("kontrol eksplisit berotoritas tetap berjalan pada support yang pasti", async () => {
    const support: RiskTriage = {
      level: "dukungan",
      alone: false,
      sensitive: false,
      summary: "butuh dukungan",
      certain: true,
    };
    const runtime = createRuntime({
      assessGroupIngress: async () => ({
        riskHint: {
          level: "possible",
          category: "acute_distress",
          confidence: 0.7,
        },
        contextPrivacy: "ordinary",
      }),
      triageRisk: async () => support,
    });

    assert.equal(
      await runtime.turns.handle(message({
        messageId: "alias-support",
        text: "Harvy, mulai sekarang panggil kamu Kapi",
        mentionsHarvy: true,
        isAdmin: true,
      })),
      "replied",
    );
    assert.deepEqual(
      (await runtime.memories.memory("whatsapp:grup@g.us"))?.harvyAliases,
      ["Harvy", "Kapi"],
    );
  });

  it("memberi triase konteks orang yang sama beserta balasan Harvy", async () => {
    const followUpContexts: HarvyContext[] = [];
    const runtime = createRuntime({
      triageRisk: async (text, _ownerId, context) => {
        if (text === "belum" && context) followUpContexts.push(context);
        return CALM_TRIAGE;
      },
      reply: async (incoming) =>
        incoming.participantId === "p1"
          ? "kamu sudah di tempat aman?"
          : "jawaban untuk Bima",
    });

    await runtime.turns.handle(
      message({
        messageId: "ayu-awal",
        participantId: "p1",
        participantAliases: ["p1"],
        participantName: "Ayu",
        mentionsHarvy: true,
      }),
    );
    await runtime.turns.handle(
      message({
        messageId: "bima",
        participantId: "p2",
        participantAliases: ["p2"],
        participantName: "Bima",
        mentionsHarvy: true,
      }),
    );
    await runtime.turns.handle(
      message({
        messageId: "ayu-lanjut",
        participantId: "p1",
        participantAliases: ["p1"],
        participantName: "Ayu",
        text: "belum",
        repliesToHarvy: true,
      }),
    );

    assert.match(
      followUpContexts[0]?.turns.map((turn) => turn.text).join(" ") ?? "",
      /tempat aman/,
    );
    assert.doesNotMatch(
      followUpContexts[0]?.turns.map((turn) => turn.text).join(" ") ?? "",
      /Bima/,
    );
  });

  it("menyimpan penanda risiko minimal tanpa memutar ulang isi sensitif", async () => {
    const danger: RiskTriage = {
      level: "bahaya",
      alone: false,
      sensitive: true,
      summary: "bahaya dekat",
      certain: true,
    };
    const followUpContexts: HarvyContext[] = [];
    let followUpLevel: RiskTriage["level"] | null = null;
    const runtime = createRuntime({
      triageRisk: async (text, _ownerId, context) => {
        if (text === "aku dalam bahaya sekarang") return danger;
        if (context) followUpContexts.push(context);
        return CALM_TRIAGE;
      },
      reply: async (incoming, _context, triage) => {
        if (incoming.text === "belum") followUpLevel = triage.level;
        return incoming.text === "belum"
          ? "aku tetap menanggapimu hati-hati"
          : "balasan yang mungkin memparafrasekan bahaya";
      },
    });

    await runtime.turns.handle(
      message({
        messageId: "bahaya",
        text: "aku dalam bahaya sekarang",
        mentionsHarvy: true,
      }),
    );
    await runtime.turns.handle(
      message({
        messageId: "lanjut",
        text: "belum",
        repliesToHarvy: true,
      }),
    );

    const contextText =
      followUpContexts[0]?.turns.map((turn) => turn.text).join(" ") ?? "";
    assert.match(contextText, /Catatan keselamatan sementara/);
    assert.doesNotMatch(contextText, /aku dalam bahaya sekarang/);
    assert.doesNotMatch(contextText, /memparafrasekan bahaya/);
    assert.equal(followUpLevel, "dukungan");
  });

  it("marker dukungan tidak menurunkan strong hint pada lanjutan pendek", async () => {
    const support: RiskTriage = {
      level: "dukungan",
      alone: false,
      sensitive: true,
      summary: "butuh dukungan",
      certain: true,
    };
    let reviews = 0;
    const followUpTriages: RiskTriage[] = [];
    const runtime = createRuntime({
      assessGroupIngress: async (text) => ({
        riskHint: text === "belum"
          ? {
              level: "strong",
              category: "acute_distress",
              confidence: 0.95,
            }
          : {
              level: "possible",
              category: "acute_distress",
              confidence: 0.7,
            },
        contextPrivacy: "sensitive",
      }),
      triageRisk: async (text) => text === "belum" ? null : support,
      reviewReply: async () => {
        reviews += 1;
        return true;
      },
      reply: async (incoming, _context, triage) => {
        if (incoming.text === "belum") followUpTriages.push(triage);
        return "balasan hati-hati";
      },
    });

    await runtime.turns.handle(message({
      messageId: "support-awal",
      text: "Harvy, aku sedang tertekan",
      mentionsHarvy: true,
    }));
    await runtime.turns.handle(message({
      messageId: "support-lanjut-strong",
      text: "belum",
      repliesToHarvy: true,
    }));

    assert.equal(followUpTriages[0]?.level, "dukungan");
    assert.equal(followUpTriages[0]?.certain, false);
    assert.equal(reviews, 1);
  });

  it("tidak mewariskan marker atau konteks dari triase yang selesai setelah removal", async () => {
    let releaseTriage!: () => void;
    let markTriageStarted!: () => void;
    const triageGate = new Promise<void>((resolve) => {
      releaseTriage = resolve;
    });
    const triageStarted = new Promise<void>((resolve) => {
      markTriageStarted = resolve;
    });
    const danger: RiskTriage = {
      level: "bahaya",
      alone: false,
      sensitive: true,
      summary: "bahaya tertahan",
      certain: true,
    };
    let followUpLevel: RiskTriage["level"] | null = null;
    let followUpContext = "";
    const runtime = createRuntime({
      triageRisk: async (text, _ownerId, context) => {
        if (text === "bahaya tertahan") {
          markTriageStarted();
          await triageGate;
          return danger;
        }
        if (text === "belum") {
          followUpContext =
            context?.turns.map((turn) => turn.text).join(" ") ?? "";
        }
        return CALM_TRIAGE;
      },
      reply: async (incoming, _context, triage) => {
        if (incoming.text === "belum") followUpLevel = triage.level;
        return "jawaban aman";
      },
    });
    await runtime.turns.handle(
      message({
        messageId: "konteks-sebelum-remove",
        text: "percakapan lama",
        mentionsHarvy: true,
      }),
    );
    const stale = runtime.turns.handle(
      message({
        messageId: "triase-tertahan",
        text: "bahaya tertahan",
        mentionsHarvy: true,
      }),
    );
    await triageStarted;
    await runtime.turns.disableGroup("whatsapp:grup@g.us", "utama");
    const reactivated = runtime.turns.activateGroup(
      message({
        messageId: "readd",
        groupName: "Grup uji",
        at: NOW.toISOString(),
      }),
    );
    releaseTriage();
    assert.equal(await stale, "inactive");
    assert.equal(await reactivated, "active");

    assert.equal(
      await runtime.turns.handle(
        message({
          messageId: "sesudah-readd",
          text: "belum",
          repliesToHarvy: true,
        }),
      ),
      "replied",
    );
    assert.equal(followUpLevel, "biasa");
    assert.doesNotMatch(followUpContext, /Catatan keselamatan|percakapan lama/);
  });

  it("mengizinkan kontrol eksplisit sensitif tetapi menolak bentuk negatif", async () => {
    const runtime = createRuntime({
      assessGroupIngress: async (text) => ({
        riskHint: NO_RISK_HINT,
        contextPrivacy: text.includes("Kapi") ? "sensitive" : "ordinary",
      }),
    });

    await runtime.turns.handle(
      message({
        messageId: "sensitif",
        text: "Harvy, panggil kamu Kapi",
        mentionsHarvy: true,
        isAdmin: true,
      }),
    );
    await runtime.turns.handle(
      message({
        messageId: "negatif",
        text: "Harvy, jangan panggil kamu Budi",
        mentionsHarvy: true,
        isAdmin: true,
      }),
    );

    const memory = await runtime.memories.memory("whatsapp:grup@g.us");
    assert.deepEqual(memory?.harvyAliases, ["Harvy", "Kapi"]);
  });

  it("membedakan koreksi nama anggota dari julukan Harvy", async () => {
    const runtime = createRuntime();
    await runtime.turns.handle(
      message({
        messageId: "awal-nama",
        mentionsHarvy: true,
      }),
    );
    await runtime.turns.handle(
      message({
        messageId: "koreksi",
        text: "Harvy, koreksi nama aku jadi Budi",
        mentionsHarvy: true,
      }),
    );
    await runtime.turns.handle(
      message({
        messageId: "alias",
        text: "Harvy, mulai sekarang panggil kamu Kapi",
        mentionsHarvy: true,
        isAdmin: true,
      }),
    );

    const memory = await runtime.memories.memory("whatsapp:grup@g.us");
    assert.equal(memory?.participants[0]?.displayNameOverride, "Budi");
    assert.deepEqual(memory?.harvyAliases, ["Harvy", "Kapi"]);
  });

  it("memeriksa ulang mode tepat sebelum fixed urgent ACK", async () => {
    const cases = [
      ["direct_only", 1],
      ["paused", 0],
      ["disabled", 0],
    ] as const;

    for (const [closedMode, expectedAckCount] of cases) {
      let mode: Parameters<typeof groupRuntimeAdmission>[0] = "ambient";
      let releaseAdmission!: () => void;
      let markAdmissionStarted!: () => void;
      const admissionGate = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const admissionStarted = new Promise<void>((resolve) => {
        markAdmissionStarted = resolve;
      });
      const runtime = createRuntime({
        runtimeAdmission: async (incoming) => {
          markAdmissionStarted();
          await admissionGate;
          return groupRuntimeAdmission(mode, incoming);
        },
      });
      await runtime.turns.activateGroup({
        scope: { channel: "whatsapp", groupId: "grup@g.us" },
        accountId: "utama",
        groupName: "Grup uji",
        at: NOW.toISOString(),
      });
      const preflight = runtime.turns.preflightUrgent(message({
        messageId: `urgent-mode-${closedMode}`,
        text: "aku dalam bahaya sekarang",
        mentionsHarvy: false,
      }));
      await within(admissionStarted, 1_000);
      mode = closedMode;
      releaseAdmission();
      await preflight;

      assert.equal(runtime.replies.length, expectedAckCount, closedMode);
    }
  });

  it("mengirim acknowledgment bahaya tanpa menunggu giliran biasa selesai", async () => {
    let releaseOrdinary!: () => void;
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    const replies: string[] = [];
    const danger: RiskTriage = {
      level: "bahaya",
      alone: false,
      sensitive: true,
      summary: "bahaya dekat",
      certain: true,
    };
    const runtime = createRuntime({
      triageRisk: async (text) =>
        text.includes("bahaya") ? danger : CALM_TRIAGE,
      reply: async (incoming) => {
        if (incoming.messageId === "lambat") await ordinaryGate;
        return "balasan penuh";
      },
      sendReply: async (_incoming, text) => {
        replies.push(text);
      },
    });

    const ordinary = runtime.turns.handle(
      message({
        messageId: "lambat",
        text: "Harvy, jelaskan ini",
        mentionsHarvy: true,
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const urgent = runtime.turns.handle(
      message({
        messageId: "mendesak",
        text: "aku dalam bahaya",
        mentionsHarvy: true,
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.match(replies[0] ?? "", /mungkin mendesak/i);
    releaseOrdinary();
    await Promise.all([ordinary, urgent]);
  });

  it("mengirim acknowledgment bahaya tepat sekali untuk duplicate", async () => {
    let releaseOrdinary!: () => void;
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    const replies: string[] = [];
    const danger: RiskTriage = {
      level: "bahaya",
      alone: false,
      sensitive: true,
      summary: "bahaya dekat",
      certain: true,
    };
    const runtime = createRuntime({
      triageRisk: async (text) =>
        text.includes("bahaya") ? danger : CALM_TRIAGE,
      reply: async (incoming) => {
        if (incoming.messageId === "lambat") await ordinaryGate;
        return "balasan penuh";
      },
      sendReply: async (_incoming, text) => {
        replies.push(text);
      },
    });
    const ordinary = runtime.turns.handle(
      message({
        messageId: "lambat",
        mentionsHarvy: true,
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const urgentMessage = message({
      messageId: "bahaya-sama",
      text: "aku dalam bahaya",
      mentionsHarvy: true,
    });
    const first = runtime.turns.handle(urgentMessage);
    const duplicate = runtime.turns.handle(urgentMessage);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      replies.filter((text) => /mungkin mendesak/i.test(text)).length,
      1,
    );
    releaseOrdinary();
    await Promise.all([ordinary, first, duplicate]);
  });

  it("ACK urgent tidak menelan triase prioritas full turn", async () => {
    let releaseOrdinary!: () => void;
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let releaseTriage!: () => void;
    const triageGate = new Promise<void>((resolve) => {
      releaseTriage = resolve;
    });
    let markTriageStarted!: () => void;
    const triageStarted = new Promise<void>((resolve) => {
      markTriageStarted = resolve;
    });
    const replies: string[] = [];
    const ingressTexts: string[] = [];
    let understandingCalls = 0;
    const danger: RiskTriage = {
      level: "bahaya",
      alone: false,
      sensitive: true,
      summary: "bahaya dekat",
      certain: true,
    };
    const runtime = createRuntime({
      assessGroupIngress: async (text) => {
        ingressTexts.push(text);
        return { riskHint: NO_RISK_HINT, contextPrivacy: "ordinary" };
      },
      memoryExtractor: {
        understand: async () => {
          understandingCalls += 1;
          return null;
        },
      },
      triageRisk: async (text) => {
        if (text.includes("bahaya")) {
          markTriageStarted();
          await triageGate;
          return danger;
        }
        return CALM_TRIAGE;
      },
      reply: async (incoming) => {
        if (incoming.messageId === "lambat-preflight") {
          await ordinaryGate;
        }
        return "balasan penuh";
      },
      sendReply: async (_incoming, text) => {
        replies.push(text);
      },
    });
    const ordinary = runtime.turns.handle(message({
      messageId: "lambat-preflight",
      text: "Harvy, jelaskan ini",
      mentionsHarvy: true,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const urgentMessage = message({
      messageId: "urgent-preflight",
      text: "aku dalam bahaya sekarang",
      mentionsHarvy: true,
    });

    await runtime.turns.preflightUrgent(urgentMessage);
    const urgent = runtime.turns.handle(urgentMessage);
    await within(triageStarted, 1_000);

    assert.equal(
      replies.filter((text) => /mungkin mendesak/i.test(text)).length,
      1,
    );
    assert.ok(!ingressTexts.includes(urgentMessage.text));
    assert.equal(understandingCalls, 1);
    releaseTriage();
    releaseOrdinary();
    await Promise.all([ordinary, urgent]);
    assert.equal(
      replies.filter((text) => /mungkin mendesak/i.test(text)).length,
      1,
    );
  });

  it("emergency ambient tetap mendapat final safety reply saat triase tidak mengonfirmasi danger", async () => {
    for (const triage of [null, CALM_TRIAGE] as const) {
      const replies: string[] = [];
      let reviews = 0;
      const runtime = createRuntime({
        assessGroupIngress: async () => {
          throw new Error("Emergency lokal tidak boleh menunggu ingress.");
        },
        triageRisk: async () => triage,
        reviewReply: async () => {
          reviews += 1;
          return true;
        },
        reply: async (_incoming, _context, assessment) => {
          assert.equal(assessment.level, "dukungan");
          assert.equal(assessment.certain, false);
          return "Aku tetap menanggapimu dengan hati-hati.";
        },
        sendReply: async (_incoming, text) => {
          replies.push(text);
        },
      });
      await runtime.turns.activateGroup({
        scope: { channel: "whatsapp", groupId: "grup@g.us" },
        accountId: "utama",
        groupName: "Grup uji",
        at: NOW.toISOString(),
      });
      const incoming = message({
        messageId: triage === null ? "ambient-null" : "ambient-calm",
        text: "contoh untuk tugas\naku dalam bahaya sekarang",
        at: "2026-07-29T12:00:01.000Z",
        parts: [
          {
            messageId: triage === null ? "context-null" : "context-calm",
            text: "contoh untuk tugas",
            at: NOW.toISOString(),
            mentionsHarvy: false,
            repliesToHarvy: false,
          },
          {
            messageId: triage === null ? "ambient-null" : "ambient-calm",
            text: "aku dalam bahaya sekarang",
            at: "2026-07-29T12:00:01.000Z",
            mentionsHarvy: false,
            repliesToHarvy: false,
          },
        ],
      });

      await runtime.turns.preflightUrgent(incoming);
      const outcome = runtime.turns.handle(incoming);
      await observeAuthorized(runtime.turns, message({
        messageId: `${incoming.messageId}-lebih-baru`,
        text: "pesan ambient yang lebih baru",
      }));
      assert.equal(await outcome, "replied");
      await runtime.turns.drain();

      assert.equal(
        replies.filter((text) => /mungkin mendesak/i.test(text)).length,
        1,
      );
      assert.equal(
        replies.filter((text) => /tetap menanggapimu/i.test(text)).length,
        1,
      );
      assert.equal(reviews, 1);
    }
  });

  it("revocation membatalkan priority assessment yang sedang berjalan", async () => {
    let releaseOrdinary!: () => void;
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let releaseIngress!: () => void;
    const ingressGate = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    let markIngressStarted!: () => void;
    const ingressStarted = new Promise<void>((resolve) => {
      markIngressStarted = resolve;
    });
    let markOrdinaryBlocked!: () => void;
    const ordinaryBlocked = new Promise<void>((resolve) => {
      markOrdinaryBlocked = resolve;
    });
    let authorized = true;
    let runningSignal: AbortSignal | undefined;
    let triageCalls = 0;
    const runtime = createRuntime({
      assessGroupIngress: async (text, _context, _ownerId, signal) => {
        if (text === "priority-running") {
          runningSignal = signal;
          markIngressStarted();
          await ingressGate;
        }
        return {
          riskHint: text === "priority-running"
            ? {
                level: "possible",
                category: "acute_distress",
                confidence: 0.7,
              }
            : NO_RISK_HINT,
          contextPrivacy: "ordinary",
        };
      },
      triageRisk: async () => {
        triageCalls += 1;
        return CALM_TRIAGE;
      },
      reply: async (incoming) => {
        if (incoming.messageId === "ordinary-running") {
          markOrdinaryBlocked();
          await ordinaryGate;
        }
        return "balasan";
      },
      authority: {
        resolveGroupAuthority: async (request) => authorized
          ? {
              role: request.claimedAdmin ? "admin" : "member",
              authorityEpoch: request.claimedAuthorityEpoch,
            }
          : null,
      },
    });
    const ordinary = runtime.turns.handle(message({
      messageId: "ordinary-running",
      mentionsHarvy: true,
    }));
    await within(ordinaryBlocked, 1_000);
    const priority = runtime.turns.handle(message({
      messageId: "priority-running",
      text: "priority-running",
      mentionsHarvy: true,
    }));
    await within(ingressStarted, 1_000);

    authorized = false;
    runtime.turns.invalidateAuthority(
      "whatsapp:grup@g.us",
      "utama",
      2,
    );
    assert.equal(runningSignal?.aborted, true);
    releaseIngress();
    releaseOrdinary();

    assert.equal(await within(priority, 1_000), "inactive");
    assert.equal(await ordinary, "inactive");
    assert.equal(triageCalls, 0);
    assert.deepEqual(runtime.replies, []);
  });

  it("revocation menghapus priority assessment yang masih mengantre", async () => {
    let releaseOrdinary!: () => void;
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let releaseIngress!: () => void;
    const ingressGate = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    let started = 0;
    let markFourStarted!: () => void;
    const fourStarted = new Promise<void>((resolve) => {
      markFourStarted = resolve;
    });
    let markOrdinaryBlocked!: () => void;
    const ordinaryBlocked = new Promise<void>((resolve) => {
      markOrdinaryBlocked = resolve;
    });
    const ingressTexts: string[] = [];
    const runningSignals: AbortSignal[] = [];
    const runtime = createRuntime({
      assessGroupIngress: async (text, _context, _ownerId, signal) => {
        ingressTexts.push(text);
        if (text.startsWith("priority-queued-")) {
          if (signal) runningSignals.push(signal);
          started += 1;
          if (started === 4) markFourStarted();
          await ingressGate;
        }
        return { riskHint: NO_RISK_HINT, contextPrivacy: "ordinary" };
      },
      reply: async (incoming) => {
        if (incoming.messageId === "ordinary-queued") {
          markOrdinaryBlocked();
          await ordinaryGate;
        }
        return "balasan";
      },
    });
    const ordinary = runtime.turns.handle(message({
      messageId: "ordinary-queued",
      mentionsHarvy: true,
    }));
    await within(ordinaryBlocked, 1_000);
    const priorities = Array.from({ length: 5 }, (_unused, index) =>
      runtime.turns.handle(message({
        messageId: `priority-queued-${index}`,
        text: `priority-queued-${index}`,
        mentionsHarvy: true,
      })),
    );
    await within(fourStarted, 1_000);
    const priorityState = runtime.turns as unknown as {
      priorityQueue: Array<() => void>;
    };
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(priorityState.priorityQueue.length, 1);

    runtime.turns.invalidateAuthority(
      "whatsapp:grup@g.us",
      "utama",
      2,
    );
    assert.equal(priorityState.priorityQueue.length, 0);
    assert.ok(runningSignals.every((signal) => signal.aborted));
    assert.ok(!ingressTexts.includes("priority-queued-4"));
    releaseOrdinary();

    assert.deepEqual(
      await within(Promise.all(priorities), 1_000),
      Array.from({ length: 5 }, () => "inactive"),
    );
    assert.equal(await ordinary, "inactive");
    releaseIngress();
    await runtime.turns.drain();
    assert.equal(started, 4);
  });

  it("burst ambient ordinary tidak memulai assessment prioritas", async () => {
    let releaseOrdinary!: () => void;
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    let triageCalls = 0;
    const ingressTexts: string[] = [];
    let ambientAssessments = 0;
    const runtime = createRuntime({
      assessGroupIngress: async (text) => {
        ingressTexts.push(text);
        return { riskHint: NO_RISK_HINT, contextPrivacy: "ordinary" };
      },
      assessAmbient: async () => {
        ambientAssessments += 1;
        return {
          plan: silentPlan(),
          riskHint: NO_RISK_HINT,
          contextPrivacy: "ordinary",
        };
      },
      triageRisk: async () => {
        triageCalls += 1;
        return CALM_TRIAGE;
      },
      reply: async (incoming) => {
        if (incoming.messageId === "lambat-ordinary") {
          await ordinaryGate;
        }
        return "balasan";
      },
    });
    const ordinary = runtime.turns.handle(message({
      messageId: "lambat-ordinary",
      mentionsHarvy: true,
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const burst = Array.from({ length: 60 }, (_unused, index) =>
      runtime.turns.handle(message({
        messageId: `ordinary-${index}`,
        text: `obrolan biasa ${index}`,
      })),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(triageCalls, 0);
    assert.deepEqual(ingressTexts, ["halo semua"]);
    assert.equal(ambientAssessments, 0);
    releaseOrdinary();
    await Promise.all([ordinary, ...burst]);
    assert.equal(triageCalls, 0);
    assert.equal(ingressTexts.length + ambientAssessments, 61);
  });

  it("ambient normal memakai satu envelope planner tanpa ingress call kedua", async () => {
    let ambientAssessments = 0;
    let ingressCalls = 0;
    let triageCalls = 0;
    const runtime = createRuntime({
      assessAmbient: async () => {
        ambientAssessments += 1;
        return {
          plan: silentPlan(),
          riskHint: NO_RISK_HINT,
          contextPrivacy: "ordinary",
        };
      },
      assessGroupIngress: async () => {
        ingressCalls += 1;
        return { riskHint: NO_RISK_HINT, contextPrivacy: "ordinary" };
      },
      triageRisk: async () => {
        triageCalls += 1;
        return CALM_TRIAGE;
      },
    });

    assert.equal(
      await runtime.turns.handle(message({
        messageId: "ambient-envelope",
        text: "obrolan ambient biasa",
      })),
      "silent",
    );
    assert.equal(ambientAssessments, 1);
    assert.equal(ingressCalls, 0);
    assert.equal(triageCalls, 0);
  });

  it("membatasi konkurensi triase prioritas ketika grup mengalami burst", async () => {
    let releaseOrdinary!: () => void;
    let releaseTriage!: () => void;
    const ordinaryGate = new Promise<void>((resolve) => {
      releaseOrdinary = resolve;
    });
    const triageGate = new Promise<void>((resolve) => {
      releaseTriage = resolve;
    });
    let active = 0;
    let maximum = 0;
    const runtime = createRuntime({
      assessGroupIngress: async (text) => ({
        riskHint: text.startsWith("burst-")
          ? {
              level: "possible",
              category: "acute_distress",
              confidence: 0.7,
            }
          : NO_RISK_HINT,
        contextPrivacy: "ordinary",
      }),
      triageRisk: async (text) => {
        if (!text.startsWith("burst-")) return CALM_TRIAGE;
        active += 1;
        maximum = Math.max(maximum, active);
        await triageGate;
        active -= 1;
        return CALM_TRIAGE;
      },
      reply: async (incoming) => {
        if (incoming.messageId === "lambat") await ordinaryGate;
        return "balasan";
      },
    });
    const ordinary = runtime.turns.handle(
      message({
        messageId: "lambat",
        mentionsHarvy: true,
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const burst = Array.from({ length: 60 }, (_unused, index) =>
      runtime.turns.handle(
        message({
          messageId: `burst-${index}`,
          text: `burst-${index}`,
          mentionsHarvy: true,
        }),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(maximum > 0);
    assert.ok(maximum <= 4, `konkurensi aktual ${maximum}`);
    releaseTriage();
    releaseOrdinary();
    await Promise.all([ordinary, ...burst]);
  });
});

interface RuntimeOptions {
  events?: string[];
  assessAmbient?: NonNullable<GroupConversationPort["assessAmbient"]>;
  planAmbient?: GroupConversationPort["planAmbient"];
  revalidateAmbient?: GroupConversationPort["revalidateAmbient"];
  reply?: GroupConversationPort["reply"];
  triageRisk?: GroupSafetyPort["triageRisk"];
  reviewReply?: GroupSafetyPort["reviewReply"];
  sendNotice?: GroupTransport["sendNotice"];
  sendReply?: GroupTransport["sendReply"];
  sendTyping?: NonNullable<GroupTransport["sendTyping"]>;
  createProgress?: NonNullable<GroupTransport["createProgress"]>;
  now?: () => Date;
  repository?: MemoryGroupRepository;
  memoryExtractor?: GroupMemoryExtractionPort;
  assessGroupIngress?: GroupIngressAssessmentPort["assessGroupIngress"];
  usageControl?: GroupUsageControlPort;
  authority?: GroupAuthorityResolver;
  runtimeAdmission?: GroupRuntimeAdmissionResolver;
}

function createRuntime(options: RuntimeOptions = {}): {
  turns: GroupTurnService;
  memories: GroupMemoryService;
  replies: string[];
} {
  const repository = options.repository ?? new MemoryGroupRepository();
  const now = options.now ?? (() => NOW);
  const memories = new GroupMemoryService(repository, now);
  const replies: string[] = [];
  const events = options.events ?? [];
  const planAmbient =
    options.planAmbient ??
    (async () => {
      return silentPlan();
    });
  const conversation: GroupConversationPort = {
    assessAmbient:
      options.assessAmbient ??
      (async (...args) => ({
        plan: await planAmbient(...args),
        riskHint: options.triageRisk
          ? {
              level: "possible" as const,
              category: "acute_distress" as const,
              confidence: 0.5,
            }
          : NO_RISK_HINT,
        contextPrivacy: "ordinary" as const,
      })),
    planAmbient,
    ...(options.revalidateAmbient
      ? { revalidateAmbient: options.revalidateAmbient }
      : {}),
    reply:
      options.reply ??
      (async () => {
        return "jawaban";
      }),
  };
  const safety: GroupSafetyPort = {
    triageRisk: options.triageRisk ?? (async () => CALM_TRIAGE),
    reviewReply: options.reviewReply ?? (async () => true),
  };
  const transport: GroupTransport = {
    sendNotice:
      options.sendNotice ??
      (async () => {
        events.push("notice");
      }),
    sendReply:
      options.sendReply ??
      (async (_message, text) => {
        replies.push(text);
        events.push(`reply:${text}`);
      }),
    sendTyping: options.sendTyping ?? (async () => undefined),
    ...(options.createProgress
      ? { createProgress: options.createProgress }
      : {}),
  };
  const memoryExtractor: GroupMemoryExtractionPort | null =
    options.memoryExtractor
      ? {
          understand: (...args) =>
            options.memoryExtractor!.understand(...args),
        }
      : null;
  const ingressAssessment: GroupIngressAssessmentPort = {
    assessGroupIngress:
      options.assessGroupIngress ??
      (async () => ({
        riskHint: options.triageRisk
          ? {
              level: "possible",
              category: "acute_distress",
              confidence: 0.5,
            }
          : NO_RISK_HINT,
        contextPrivacy: "ordinary",
      })),
  };

  return {
    turns: new GroupTurnService(
      memories,
      conversation,
      safety,
      transport,
      GROUP_NOTICE_VERSION,
      now,
      options.usageControl,
      undefined,
      14,
      "Asia/Jakarta",
      memoryExtractor,
      options.authority ?? CLAIMED_GROUP_AUTHORITY_RESOLVER,
      ingressAssessment,
      options.runtimeAdmission,
    ),
    memories,
    replies,
  };
}

function understanding(
  memory: Understanding["memories"][number],
  memoryAction: Understanding["memoryAction"] = null,
  semanticOperation: SemanticOperation | null = null,
): Understanding {
  return {
    intent: "smalltalk",
    taskAction: null,
    memoryAction,
    riskHint: { level: "none", confidence: 1 },
    safetySensitive: false,
    needsStepByStep: false,
    task: null,
    memories: [memory],
    semanticOperation,
  };
}

function memorySemantic(message: string, target: string): SemanticOperation {
  return {
    version: 1,
    domain: "memory",
    operation: "remember",
    target,
    subject: "self",
    reference: "none",
    explicitness: "explicit",
    evidence: message,
    confidence: 0.95,
  };
}

class MemoryGroupRepository implements GroupRepository {
  readonly bindings = new Map<string, GroupBinding>();
  readonly memories = new Map<string, GroupMemory>();
  readonly memberMemories = new Map<string, GroupMemberMemory[]>();
  readonly roomMemories = new Map<string, GroupRoomMemory>();

  async loadBinding(scopeKey: string): Promise<GroupBinding | null> {
    const binding = this.bindings.get(scopeKey);
    return binding ? structuredClone(binding) : null;
  }

  async saveBinding(binding: GroupBinding): Promise<void> {
    this.bindings.set(binding.scopeKey, structuredClone(binding));
  }

  async loadMemory(scopeKey: string): Promise<GroupMemory | null> {
    const memory = this.memories.get(scopeKey);
    return memory ? structuredClone(memory) : null;
  }

  async listMemories(): Promise<GroupMemory[]> {
    return [...this.memories.values()].map((memory) => structuredClone(memory));
  }

  async saveMemory(memory: GroupMemory): Promise<void> {
    this.memories.set(memory.scopeKey, structuredClone(memory));
  }

  async removeMemory(scopeKey: string): Promise<boolean> {
    return this.memories.delete(scopeKey);
  }

  async loadMemberMemories(scopeKey: string): Promise<GroupMemberMemory[]> {
    return structuredClone(this.memberMemories.get(scopeKey) ?? []);
  }

  async saveMemberMemories(
    scopeKey: string,
    memories: GroupMemberMemory[],
  ): Promise<void> {
    this.memberMemories.set(scopeKey, structuredClone(memories));
  }

  async removeMemberMemories(scopeKey: string): Promise<number> {
    const count = this.memberMemories.get(scopeKey)?.length ?? 0;
    this.memberMemories.delete(scopeKey);
    return count;
  }

  async loadRoomMemory(scopeKey: string): Promise<GroupRoomMemory | null> {
    const memory = this.roomMemories.get(scopeKey);
    return memory ? structuredClone(memory) : null;
  }

  async saveRoomMemory(memory: GroupRoomMemory): Promise<void> {
    this.roomMemories.set(memory.scopeKey, structuredClone(memory));
  }

  async removeRoomMemory(scopeKey: string): Promise<boolean> {
    return this.roomMemories.delete(scopeKey);
  }

  async listRoomMemoryScopes(): Promise<string[]> {
    return [...this.roomMemories.keys()];
  }
}

class GatedBindingRepository extends MemoryGroupRepository {
  gateNextLoad: (() => Promise<void>) | null = null;

  override async loadBinding(
    scopeKey: string,
  ): Promise<GroupBinding | null> {
    const gate = this.gateNextLoad;
    this.gateNextLoad = null;
    if (gate) await gate();
    return super.loadBinding(scopeKey);
  }
}

class GatedMemoryRepository extends MemoryGroupRepository {
  gateNextMemory: (() => Promise<void>) | null = null;

  override async loadMemory(scopeKey: string): Promise<GroupMemory | null> {
    const gate = this.gateNextMemory;
    this.gateNextMemory = null;
    if (gate) await gate();
    return super.loadMemory(scopeKey);
  }
}

function silentPlan(): Awaited<
  ReturnType<GroupConversationPort["planAmbient"]>
> {
  return {
    decision: "silent",
    reason: "human_exchange",
    value: 0,
    confidence: 0.95,
    reply: null,
  };
}

function speakPlan(
  reply: string,
): NonNullable<
  Awaited<ReturnType<GroupConversationPort["planAmbient"]>>
> {
  return {
    decision: "speak",
    reason: "unanswered_question",
    value: 3,
    confidence: 0.95,
    reply,
  };
}

async function observeAuthorized(
  turns: GroupTurnService,
  incoming: GroupMessage,
): Promise<GroupMessage> {
  const observed = await turns.observeAuthorized(incoming);
  assert.ok(observed, "fixture harus memiliki authority dan binding aktif");
  return observed;
}

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "grup@g.us" },
    accountId: "utama",
    messageId: "pesan-1",
    participantId: "p1",
    participantAliases: ["p1"],
    participantName: "Ayu",
    groupName: "Grup uji",
    text: "halo semua",
    at: NOW.toISOString(),
    mentionsHarvy: false,
    repliesToHarvy: false,
    isAdmin: false,
    ...overrides,
  };
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Batas tunggu tes terlampaui.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
