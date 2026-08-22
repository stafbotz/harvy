import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WAMessage } from "baileys";
import {
  normalizeBaileysGroupMessage,
  normalizeBaileysPrivateMessage,
  whatsappPrivateOwnerId,
} from "../src/whatsapp/baileys-message-normalizer.js";

describe("normalisasi pesan Baileys", () => {
  it("membaca teks, participant LID/PN, mention metadata, dan admin", () => {
    let adminCandidates: readonly string[] = [];
    const normalized = normalizeBaileysGroupMessage(
      message({
        message: {
          extendedTextMessage: {
            text: "Harvy bantu dong",
            contextInfo: {
              mentionedJid: ["628123456789:3@s.whatsapp.net"],
            },
          },
        },
      }),
      {
        accountId: "utama",
        selfJids: ["628123456789@s.whatsapp.net"],
        groupName: "Kelas XI",
        ownMessageIds: new Set(),
        authorityEpoch: 7,
        isAdmin: (participants) => {
          adminCandidates = participants;
          return true;
        },
      },
    );

    assert.equal(normalized?.text, "Harvy bantu dong");
    assert.equal(normalized?.participantId, "12345@lid");
    assert.equal(normalized?.mentionsHarvy, true);
    assert.equal(normalized?.isAdmin, true);
    assert.equal(normalized?.authorityEpoch, 7);
    assert.deepEqual(adminCandidates, [
      "12345@lid",
      "628777777777@s.whatsapp.net",
    ]);
  });

  it("mengenali reply dari stanza pesan Harvy", () => {
    const normalized = normalizeBaileysGroupMessage(
      message({
        message: {
          extendedTextMessage: {
            text: "yang tadi maksudnya apa?",
            contextInfo: { stanzaId: "harvy-1" },
          },
        },
      }),
      {
        accountId: "utama",
        selfJids: [],
        groupName: null,
        ownMessageIds: new Set(["harvy-1"]),
        isAdmin: () => false,
      },
    );

    assert.equal(normalized?.repliesToHarvy, true);
  });

  it("memilih LID sebagai identitas utama saat Baileys menukar field PN/LID", () => {
    const normalized = normalizeBaileysGroupMessage(
      message({
        key: {
          ...message().key,
          participant: "628777777777@s.whatsapp.net",
          participantAlt: "12345@lid",
        },
      }),
      {
        accountId: "utama",
        selfJids: [],
        groupName: null,
        ownMessageIds: new Set(),
        isAdmin: () => false,
      },
    );

    assert.equal(normalized?.participantId, "12345@lid");
    assert.deepEqual(normalized?.participantAliases, [
      "628777777777@s.whatsapp.net",
      "12345@lid",
    ]);
  });

  it("mengabaikan echo sendiri, chat pribadi, dan pesan tanpa teks", () => {
    const context = {
      accountId: "utama",
      selfJids: [] as string[],
      groupName: null,
      ownMessageIds: new Set<string>(),
      isAdmin: () => false,
    };

    assert.equal(
      normalizeBaileysGroupMessage(
        message({ key: { ...message().key, fromMe: true } }),
        context,
      ),
      null,
    );
    assert.equal(
      normalizeBaileysGroupMessage(message(), {
        ...context,
        selfJids: ["12345@lid"],
      }),
      null,
    );
    assert.equal(
      normalizeBaileysGroupMessage(
        message({
          key: {
            ...message().key,
            remoteJid: "628111111111@s.whatsapp.net",
          },
        }),
        context,
      ),
      null,
    );
    assert.equal(
      normalizeBaileysGroupMessage(
        message({ message: { reactionMessage: { text: "👍" } } }),
        context,
      ),
      null,
    );
  });

  it("menormalisasi pesan privat tanpa mencampurnya dengan scope grup", () => {
    const normalized = normalizeBaileysPrivateMessage(
      message({
        key: {
          id: "private-1",
          remoteJid: "628777777777@s.whatsapp.net",
          fromMe: false,
        },
        message: { conversation: "/penggunaan" },
      }),
      { accountId: "utama", selfJids: ["628123456789@s.whatsapp.net"] },
    );

    assert.deepEqual(normalized, {
      accountId: "utama",
      userId: "628777777777@s.whatsapp.net",
      messageId: "private-1",
      text: "/penggunaan",
      at: "2026-03-31T23:33:20.000Z",
    });
    assert.equal(
      whatsappPrivateOwnerId(normalized?.userId ?? ""),
      "whatsapp-user:628777777777@s.whatsapp.net",
    );
    assert.equal(
      normalizeBaileysPrivateMessage(
        message({
          key: {
            id: "echo-private",
            remoteJid: "628777777777@s.whatsapp.net",
            fromMe: true,
          },
        }),
        { accountId: "utama", selfJids: [] },
      ),
      null,
    );
  });
});

function message(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: {
      id: "pesan-1",
      remoteJid: "120363000000@g.us",
      participant: "12345@lid",
      participantAlt: "628777777777@s.whatsapp.net",
      fromMe: false,
    },
    pushName: "Ayu",
    messageTimestamp: 1_775_000_000,
    message: { conversation: "halo" },
    ...overrides,
  };
}
