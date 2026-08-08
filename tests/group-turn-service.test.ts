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
import {
  GROUP_NOTICE_VERSION,
  GroupTurnService,
  groupNotice,
  type GroupMemoryExtractionPort,
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

const NOW = new Date("2026-07-29T12:00:00.000Z");

describe("giliran grup", () => {
  it("menyebut retensi file lokal aktual dan batas collector secara jujur", () => {
    const notice = groupNotice(9);
    assert.match(notice, /file lokal Harvy/i);
    assert.match(notice, /setelah 9 hari/i);
    assert.match(notice, /collector perusahaan/i);
    assert.doesNotMatch(notice, /bawaan 14 hari/i);
    assert.match(notice, /satu atau lebih penyedia/i);
    assert.match(notice, /dikirim ulang ke penyedia cadangan/i);
    assert.equal(GROUP_NOTICE_VERSION, 7);
    assert.match(notice, /terpisah per grup dan per anggota/i);
    assert.match(notice, /sensitif tidak pernah kusimpan otomatis/i);
  });

  it("mengirim notice v7 lagi sebelum memproses grup yang baru melihat v6", async () => {
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
      6,
    );

    assert.equal(
      await runtime.turns.handle(message({ mentionsHarvy: true })),
      "replied",
    );
    assert.deepEqual(events, ["notice", "reply:halo"]);
    assert.equal(
      (await runtime.memories.binding("whatsapp:grup@g.us"))?.noticeVersion,
      7,
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

  it("menyimpan memori biasa hanya untuk anggota lokal dan menempelkannya pada balasan", async () => {
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
    assert.match(runtime.replies[0] ?? "", /📎 Untuk grup ini, kuingat/iu);
    assert.equal(
      (await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["anggota-a"],
      ))[0]?.content,
      "Warna favoritnya biru",
    );
    assert.deepEqual(
      await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["anggota-b"],
      ),
      [],
    );
  });

  it("meminta izin lalu menyimpan memori sensitif grup hanya setelah konfirmasi", async () => {
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
    assert.match(runtime.replies[0] ?? "", /belum kusimpan/iu);
    assert.match(runtime.replies[0] ?? "", /ya, simpan memori ini/iu);

    await runtime.turns.handle(
      message({
        messageId: "pesan-izin-memori",
        participantId: "anggota-a",
        participantAliases: ["anggota-a"],
        mentionsHarvy: true,
        text: "ya, simpan memori ini",
      }),
    );
    const stored = await runtime.memories.memberMemories(
      "whatsapp:grup@g.us",
      ["anggota-a"],
    );
    assert.equal(stored[0]?.content, "Sedang menghadapi masalah keluarga");
    assert.equal(stored[0]?.consent, "explicit");
  });

  it("merollback memori sensitif bila balasan konfirmasinya gagal", async () => {
    let sends = 0;
    const runtime = createRuntime({
      memoryExtractor: {
        understand: async () => understanding({
          kind: "personal",
          content: "Sedang menghadapi masalah keluarga",
        }),
      },
      sendReply: async () => {
        sends += 1;
        if (sends === 2) throw new Error("gagal kirim konfirmasi");
      },
    });
    await runtime.turns.handle(message({
      messageId: "jembatan-identitas",
      participantId: "pn-anggota",
      participantAliases: ["pn-anggota", "lid-anggota"],
      mentionsHarvy: false,
    }));
    await runtime.turns.handle(message({
      messageId: "usulan-sensitif",
      participantId: "pn-anggota",
      participantAliases: ["pn-anggota"],
      mentionsHarvy: true,
    }));

    await assert.rejects(
      runtime.turns.handle(message({
        messageId: "izin-gagal",
        participantId: "lid-anggota",
        participantAliases: ["lid-anggota"],
        mentionsHarvy: true,
        text: "ya, simpan memori ini",
      })),
      /gagal kirim konfirmasi/u,
    );
    assert.deepEqual(
      await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["pn-anggota"],
      ),
      [],
    );

    await runtime.turns.handle(message({
      messageId: "izin-coba-lagi",
      participantId: "lid-anggota",
      participantAliases: ["lid-anggota"],
      mentionsHarvy: true,
      text: "ya, simpan memori ini",
    }));
    assert.equal(
      (await runtime.memories.memberMemories(
        "whatsapp:grup@g.us",
        ["pn-anggota"],
      ))[0]?.consent,
      "explicit",
    );
  });

  it("merollback memori anggota bila pengiriman balasan gagal", async () => {
    const runtime = createRuntime({
      memoryExtractor: {
        understand: async () => understanding({
          kind: "profile",
          content: "Nama panggilannya Nara",
        }),
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
    assert.match(runtime.replies[0] ?? "", /nggak bisa memproses/iu);
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

    const observed = runtime.turns.observe(
      message({
        messageId: "panggil-kapi",
        text: "Kapi, bantu cek ini dong",
      }),
    );

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
    const first = runtime.turns.observe(
      message({
        messageId: "pertanyaan",
        text: "ada yang tau jawabannya?",
      }),
    );
    const pending = runtime.turns.handle(first);
    await planStarted;

    runtime.turns.observe(
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
    const original = runtime.turns.observe(
      message({ messageId: "pertanyaan-valid" }),
    );
    const pending = runtime.turns.handle(original);
    await planStarted;

    runtime.turns.observe(
      message({ messageId: "pertanyaan-valid" }),
    );
    runtime.turns.observe(
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
    const live = runtime.turns.observe(
      message({
        messageId: "live",
        at: "2026-07-29T12:06:00.000Z",
      }),
    );
    const pending = runtime.turns.handle(live);
    await planStarted;
    runtime.turns.observe(
      message({
        messageId: "replay-lama",
        at: "2026-07-29T12:00:00.000Z",
      }),
    );
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
      runtime.turns.observe(
        message({
          messageId: "target",
          text: "ada yang tahu jawabannya?",
          at: new Date().toISOString(),
        }),
      ),
    );
    await firstPlanStarted;
    const secondMessage = runtime.turns.observe(
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
      runtime.turns.observe(
        message({
          messageId: "target-belum-settle",
          text: "ada yang tahu jawabannya?",
          at: new Date().toISOString(),
        }),
      ),
    );
    await firstPlanStarted;
    const delayed = runtime.turns.observe(
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
      runtime.turns.observe(
        message({
          messageId: "target-revalidasi",
          text: "ada yang bisa bantu?",
          at: new Date().toISOString(),
        }),
      ),
    );
    await firstPlanStarted;
    const interjection = runtime.turns.handle(
      runtime.turns.observe(
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
      runtime.turns.observe(
        message({
          messageId: "target-baca-konteks",
          text: "ada yang tahu?",
          at: new Date().toISOString(),
        }),
      ),
    );
    await firstPlanStarted;
    const interjection = runtime.turns.handle(
      runtime.turns.observe(
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

    assert.equal(outcome, "before-join");
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

  it("tidak menjalankan mutasi memori dari pesan sensitif atau negatif", async () => {
    const sensitive: RiskTriage = {
      ...CALM_TRIAGE,
      sensitive: true,
    };
    const runtime = createRuntime({
      triageRisk: async (text) =>
        text.includes("Kapi") ? sensitive : CALM_TRIAGE,
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
    assert.deepEqual(memory?.harvyAliases, ["Harvy"]);
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
  planAmbient?: GroupConversationPort["planAmbient"];
  revalidateAmbient?: GroupConversationPort["revalidateAmbient"];
  reply?: GroupConversationPort["reply"];
  triageRisk?: GroupSafetyPort["triageRisk"];
  reviewReply?: GroupSafetyPort["reviewReply"];
  sendNotice?: GroupTransport["sendNotice"];
  sendReply?: GroupTransport["sendReply"];
  sendTyping?: NonNullable<GroupTransport["sendTyping"]>;
  now?: () => Date;
  repository?: MemoryGroupRepository;
  memoryExtractor?: GroupMemoryExtractionPort;
  usageControl?: GroupUsageControlPort;
  authority?: GroupAuthorityResolver;
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
  const conversation: GroupConversationPort = {
    planAmbient:
      options.planAmbient ??
      (async () => {
        return silentPlan();
      }),
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
      options.memoryExtractor ?? null,
      options.authority ?? CLAIMED_GROUP_AUTHORITY_RESOLVER,
    ),
    memories,
    replies,
  };
}

function understanding(
  memory: Understanding["memories"][number],
): Understanding {
  return {
    intent: "smalltalk",
    taskAction: null,
    memoryAction: "remember",
    riskHint: { level: "none", confidence: 1 },
    safetySensitive: false,
    needsStepByStep: false,
    task: null,
    memories: [memory],
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
