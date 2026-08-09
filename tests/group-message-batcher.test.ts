import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { GroupMessage } from "../src/domain/group.js";
import {
  GroupMessageBatcher,
  mergeGroupMessages,
} from "../src/whatsapp/group-message-batcher.js";
import { AdaptiveDebouncePolicy } from "../src/core/adaptive-debounce-policy.js";

describe("batch bubble grup WhatsApp", () => {
  it("melewati debounce untuk emergency lokal berpresisi tinggi", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handled: GroupMessage[] = [];
    const batcher = new GroupMessageBatcher(
      async (incoming) => {
        handled.push(incoming);
        markStarted();
      },
      10_000,
      10_000,
    );

    const pending = batcher.enqueue(message({
      text: "aku dalam bahaya sekarang",
    }));
    await Promise.race([
      started,
      new Promise<void>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("Emergency masih tertahan debounce.")),
          200,
        );
      }),
    ]);
    await pending;

    assert.equal(handled.length, 1);
    assert.equal(handled[0]?.text, "aku dalam bahaya sekarang");
  });

  it("menggabungkan bubble lama dan emergency anggota yang sama tanpa membalik FIFO", async () => {
    const handled: GroupMessage[] = [];
    const batcher = new GroupMessageBatcher(
      async (incoming) => {
        handled.push(incoming);
      },
      10_000,
      10_000,
    );

    const older = batcher.enqueue(message({
      messageId: "lama",
      text: "Harvy aku perlu cerita",
      mentionsHarvy: true,
    }));
    const urgent = batcher.enqueue(message({
      messageId: "darurat",
      text: "aku dalam bahaya sekarang",
    }));
    await Promise.all([older, urgent]);

    assert.equal(handled.length, 1);
    assert.equal(
      handled[0]?.text,
      "Harvy aku perlu cerita\naku dalam bahaya sekarang",
    );
    assert.deepEqual(
      handled[0]?.parts?.map((part) => part.messageId),
      ["lama", "darurat"],
    );
  });

  it("memulai giliran pembicara lama sebelum emergency pembicara baru", async () => {
    const handled: string[] = [];
    const batcher = new GroupMessageBatcher(
      async (incoming) => {
        handled.push(incoming.messageId);
      },
      10_000,
      10_000,
    );

    const older = batcher.enqueue(message({ messageId: "lama" }));
    const urgent = batcher.enqueue(message({
      messageId: "darurat",
      participantId: "456@lid",
      participantAliases: ["456@lid"],
      text: "aku dalam bahaya sekarang",
    }));
    await Promise.all([older, urgent]);

    assert.deepEqual(handled, ["lama", "darurat"]);
  });

  it("menjalankan hanya fixed urgent preflight di luar FIFO full-turn", async () => {
    let releaseOlder!: () => void;
    const olderGate = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    let markPreflight!: () => void;
    const preflightStarted = new Promise<void>((resolve) => {
      markPreflight = resolve;
    });
    const handled: string[] = [];
    const batcher = new GroupMessageBatcher(
      async (incoming) => {
        handled.push(incoming.messageId);
        if (incoming.messageId === "lama") await olderGate;
      },
      10_000,
      10_000,
      20,
      24_000,
      undefined,
      350,
      undefined,
      undefined,
      async () => {
        markPreflight();
      },
    );

    const older = batcher.enqueue(message({ messageId: "lama" }));
    const urgent = batcher.enqueue(message({
      messageId: "darurat",
      participantId: "456@lid",
      participantAliases: ["456@lid"],
      text: "aku dalam bahaya sekarang",
    }));
    await Promise.race([
      preflightStarted,
      delay(200).then(() => {
        throw new Error("Urgent preflight masih tertahan full-turn FIFO.");
      }),
    ]);
    assert.deepEqual(handled, ["lama"]);
    releaseOlder();
    await Promise.all([older, urgent]);
    assert.deepEqual(handled, ["lama", "darurat"]);
  });

  it("memakai timing adaptif per anggota tanpa menunggu settle tetap", async () => {
    const handled: GroupMessage[] = [];
    const policy = new AdaptiveDebouncePolicy({
      minSamples: 1,
      minDelayMs: 20,
      maxDelayMs: 20,
      maxGapMs: 500,
    });
    policy.observe(
      "whatsapp:grup@g.us\u0000utama\u0000123@lid",
      10,
    );
    const batcher = new GroupMessageBatcher(
      async (incoming) => {
        handled.push(incoming);
      },
      250,
      500,
      20,
      24_000,
      undefined,
      250,
      undefined,
      policy,
    );

    await batcher.enqueue(message());

    assert.equal(handled.length, 1);
  });

  it("mempelajari ritme lintas batch tanpa pre-seed manual", async () => {
    const handled: GroupMessage[] = [];
    const policy = new AdaptiveDebouncePolicy({
      minSamples: 1,
      minDelayMs: 80,
      maxDelayMs: 80,
      maxGapMs: 10_000,
    });
    const batcher = new GroupMessageBatcher(
      async (incoming) => {
        handled.push(incoming);
      },
      10,
      500,
      20,
      24_000,
      undefined,
      10,
      undefined,
      policy,
    );

    await batcher.enqueue(message({ messageId: "pertama" }));
    await delay(40);
    const second = batcher.enqueue(message({ messageId: "kedua" }));
    await delay(30);
    assert.equal(handled.length, 1);
    await second;
    assert.equal(handled.length, 2);
  });

  it("tidak mempelajari A ke A bila pembicara B memutus urutannya", async () => {
    const policy = new AdaptiveDebouncePolicy({
      minSamples: 1,
      maxGapMs: 500,
    });
    const subject = "whatsapp:grup@g.us\u0000utama\u0000123@lid";
    const batcher = new GroupMessageBatcher(
      async () => undefined,
      10,
      500,
      20,
      24_000,
      undefined,
      10,
      undefined,
      policy,
    );

    const firstA = batcher.enqueue(message({ messageId: "a-1" }));
    const b = batcher.enqueue(message({
      messageId: "b-1",
      participantId: "456@lid",
      participantAliases: ["456@lid"],
    }));
    const secondA = batcher.enqueue(message({ messageId: "a-2" }));
    await Promise.all([firstA, b, secondA]);

    assert.equal(policy.estimate(subject, 1_200).adaptive, false);
  });

  it("melupakan timing seluruh anggota ketika scope diinvalidasi", () => {
    const policy = new AdaptiveDebouncePolicy({ minSamples: 1 });
    const subject = "whatsapp:grup@g.us\u0000utama\u0000123@lid";
    policy.observe(subject, 800);
    const batcher = new GroupMessageBatcher(
      async () => undefined,
      250,
      500,
      20,
      24_000,
      undefined,
      250,
      undefined,
      policy,
    );

    batcher.invalidateScope("whatsapp:grup@g.us", "utama");

    assert.equal(policy.estimate(subject, 1_200).adaptive, false);
  });

  it("menggabungkan burst anggota yang sama dan mempertahankan semua ID", async () => {
    const handled: GroupMessage[] = [];
    const batcher = new GroupMessageBatcher(async (incoming) => {
      handled.push(incoming);
    }, 5);

    const first = batcher.enqueue(
      message({
        messageId: "satu",
        text: "Harvy aku mau nanya",
        mentionsHarvy: true,
      }),
    );
    const second = batcher.enqueue(
      message({
        messageId: "dua",
        text: "soal fotosintesis",
      }),
    );
    await Promise.all([first, second]);

    assert.equal(handled.length, 1);
    assert.equal(
      handled[0]?.text,
      "Harvy aku mau nanya\nsoal fotosintesis",
    );
    assert.equal(handled[0]?.mentionsHarvy, true);
    assert.deepEqual(
      handled[0]?.parts?.map((part) => part.messageId),
      ["satu", "dua"],
    );
  });

  it("membatalkan batch tertunda ketika Harvy dikeluarkan", async () => {
    let handled = 0;
    const batcher = new GroupMessageBatcher(async () => {
      handled += 1;
    }, 50);
    const pending = batcher.enqueue(message());

    batcher.invalidateScope("whatsapp:grup@g.us");
    await pending;
    await batcher.drainAll();

    assert.equal(handled, 0);
  });

  it("menyatukan alias teknis dari seluruh bubble", () => {
    const merged = mergeGroupMessages([
      message({ participantAliases: ["123@lid"] }),
      message({
        messageId: "dua",
        participantAliases: ["6281@s.whatsapp.net"],
      }),
    ]);

    assert.deepEqual(merged.participantAliases, [
      "123@lid",
      "6281@s.whatsapp.net",
    ]);
  });

  it("mengobservasi pembicara baru sebelum menutup batch lama", async () => {
    let revision = 0;
    const observed: string[] = [];
    const handled: GroupMessage[] = [];
    const batcher = new GroupMessageBatcher(
      async (incoming) => {
        handled.push(incoming);
      },
      5,
      50,
      20,
      24_000,
      undefined,
      2,
      (incoming) => {
        observed.push(incoming.messageId);
        revision += 1;
        return { ...incoming, ingressRevision: revision };
      },
    );

    const first = batcher.enqueue(message({ messageId: "A" }));
    const second = batcher.enqueue(
      message({
        messageId: "B",
        participantId: "456@lid",
        participantAliases: ["456@lid"],
      }),
    );
    await Promise.all([first, second]);

    assert.deepEqual(observed, ["A", "B"]);
    assert.equal(handled[0]?.messageId, "A");
    assert.equal(handled[0]?.ingressRevision, 1);
    assert.equal(handled[1]?.messageId, "B");
    assert.equal(handled[1]?.ingressRevision, 2);
  });

  it("menserialisasi observasi async agar resolusi lambat tidak membalik FIFO", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const observed: string[] = [];
    const handled: string[] = [];
    const batcher = new GroupMessageBatcher(
      async (incoming) => {
        handled.push(incoming.messageId);
      },
      2,
      100,
      20,
      24_000,
      undefined,
      2,
      async (incoming) => {
        observed.push(incoming.messageId);
        if (incoming.messageId === "A-lambat") {
          markFirstStarted();
          await firstGate;
        }
        return incoming;
      },
    );

    const first = batcher.enqueue(message({ messageId: "A-lambat" }));
    await firstStarted;
    const second = batcher.enqueue(message({
      messageId: "B-cepat",
      participantId: "456@lid",
      participantAliases: ["456@lid"],
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(observed, ["A-lambat"]);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(observed, ["A-lambat", "B-cepat"]);
    assert.deepEqual(handled, ["A-lambat", "B-cepat"]);
  });
});

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "grup@g.us" },
    accountId: "utama",
    messageId: "satu",
    participantId: "123@lid",
    participantAliases: ["123@lid"],
    participantName: "Ayu",
    groupName: "Grup",
    text: "halo",
    at: "2026-07-29T12:00:00.000Z",
    mentionsHarvy: false,
    repliesToHarvy: false,
    isAdmin: false,
    ...overrides,
  };
}
