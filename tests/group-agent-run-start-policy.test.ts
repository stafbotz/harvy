import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasGroupAgentRunStartIntent,
  parseGroupAgentRunStart,
} from
  "../src/core/group-agent-run-start-policy.js";
import type { GroupMessage } from "../src/domain/group.js";

describe("GroupAgentRun exact start grammar", () => {
  it("menerima hanya command explicit pada satu bubble live", () => {
    assert.deepEqual(
      parseGroupAgentRunStart(message({
        text: "Harvy, mulai pekerjaan: susun jadwal presentasi kelompok",
      })),
      { request: "susun jadwal presentasi kelompok" },
    );
    assert.deepEqual(
      parseGroupAgentRunStart(message({
        text: "mulai pekerjaan: cek pembagian tugas",
      })),
      { request: "cek pembagian tugas" },
    );
  });

  it("menolak mention, sinonim, command cacat, reply sosial, dan sentinel notice", () => {
    const rejected: Partial<GroupMessage>[] = [
      { text: "Harvy, bantu susun jadwal" },
      { text: "Harvy, buat pekerjaan: susun jadwal" },
      { text: "Harvy, mulai pekerjaan susun jadwal" },
      { text: "Harvy, mulai pekerjaan:" },
      { text: "Harvy, mulai pekerjaan: susun jadwal", mentionsHarvy: false },
      {
        text: "Harvy, mulai pekerjaan: susun jadwal",
        repliesToHarvy: true,
        quotedMessageId: "pesan-sosial",
      },
      { text: "Harvy, mulai pekerjaan: susun jadwal", ingressRevision: 0 },
      {
        text: "Harvy, mulai pekerjaan: susun jadwal",
        parts: [part("satu"), part("dua")],
      },
    ];
    for (const candidate of rejected) {
      assert.equal(parseGroupAgentRunStart(message(candidate)), null);
    }
  });

  it("membiarkan pesan bahaya menuju jalur safety tanpa membuat command", () => {
    assert.equal(
      parseGroupAgentRunStart(message({
        text: "Harvy, mulai pekerjaan: aku mau bunuh diri sekarang",
      })),
      null,
    );
  });

  it("menolak kanal lain, control character, dan request di atas batas", () => {
    assert.equal(
      parseGroupAgentRunStart(message({
        scope: { channel: "telegram", groupId: "group" },
      })),
      null,
    );
    assert.equal(
      parseGroupAgentRunStart(message({
        text: "Harvy, mulai pekerjaan: isi\u0000rusak",
      })),
      null,
    );
    assert.equal(
      parseGroupAgentRunStart(message({
        text: `Harvy, mulai pekerjaan: ${"x".repeat(8_001)}`,
      })),
      null,
    );
  });

  it("mendeteksi envelope start cacat untuk dikarantina sebelum route existing", () => {
    assert.equal(
      hasGroupAgentRunStartIntent(
        "Harvy , mulai pekerjaan: ubah pekerjaan yang aktif",
      ),
      true,
    );
    assert.equal(
      hasGroupAgentRunStartIntent("mulai   pekerjaan tanpa titik dua"),
      true,
    );
    assert.equal(
      hasGroupAgentRunStartIntent(
        "Harvy, tolong mulai pekerjaan: ubah pekerjaan yang aktif",
      ),
      true,
    );
    assert.equal(
      hasGroupAgentRunStartIntent("ubah pekerjaan yang aktif"),
      false,
    );
  });
});

function message(overrides: Partial<GroupMessage> = {}): GroupMessage {
  return {
    scope: { channel: "whatsapp", groupId: "start-policy@g.us" },
    accountId: "utama",
    messageId: "start-policy-message",
    participantId: "participant-1",
    participantAliases: [],
    participantName: "Ayu",
    groupName: "Grup start policy",
    text: "Harvy, mulai pekerjaan: susun jadwal presentasi",
    at: "2026-08-14T09:00:00.000Z",
    mentionsHarvy: true,
    repliesToHarvy: false,
    quotedMessageId: null,
    quotedParticipantId: null,
    isAdmin: false,
    authorityEpoch: 5,
    ingressRevision: 1,
    ...overrides,
  };
}

function part(text: string) {
  return {
    messageId: `part-${text}`,
    text,
    at: "2026-08-14T09:00:00.000Z",
    mentionsHarvy: true,
    repliesToHarvy: false,
    quotedMessageId: null,
    quotedParticipantId: null,
    ingressRevision: 1,
  };
}
