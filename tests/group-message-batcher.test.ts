import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GroupMessage } from "../src/domain/group.js";
import {
  GroupMessageBatcher,
  mergeGroupMessages,
} from "../src/whatsapp/group-message-batcher.js";

describe("batch bubble grup WhatsApp", () => {
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
