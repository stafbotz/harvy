import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatMemories,
  HELP_MESSAGE,
  memoryNoteLines,
} from "../src/bot/messages.js";
import {
  CONSENT_ACCEPTED,
  CONSENT_ACCEPTED_HELD,
  CONSENT_DETAIL,
  HOLD_REMINDER,
  introBubbles,
  PRE_CONSENT_SAFETY,
  STYLE_QUESTION,
  styleAck,
  welcomeBack,
} from "../src/bot/onboarding.js";

const TEST_TERMS_URL = "https://harvy.id/terms";
import {
  emptyListNote,
  nothingLeftNote,
  notUnderstoodNote,
  taskDeclinedNote,
  taskDroppedHeading,
  taskListLead,
  taskMissingNote,
  taskSavedHeading,
} from "../src/bot/phrasing.js";
import type { MemoryItem } from "../src/domain/memory.js";

/**
 * Baris yang dipenggal di tengah kalimat.
 *
 * Telegram membungkus teks sendiri sesuai lebar layar. Baris yang sudah
 * dipenggal di kode akan dibungkus dua kali, dan hasilnya bergerigi — pemilik
 * produk menyebutnya "kayak LDR" ketika melihatnya di ponsel. Ini bukan selera:
 * naskah yang sama terlihat rapi di editor dan rusak di layar pengguna.
 */
function hardWrappedLine(text: string): string | null {
  const lines = text.split("\n");

  for (const [index, line] of lines.entries()) {
    const next = lines[index + 1];
    if (!line.trim() || !next?.trim()) continue;

    const endsSentence = /[.!?:•]$|[.!?]"$/u.test(line.trim());
    const continues = /^[a-z“(]/u.test(next.trim());

    if (!endsSentence && continues) return `${line} ⏎ ${next}`;
  }

  return null;
}

function memory(): MemoryItem {
  return {
    id: "mem00001",
    ownerId: "student",
    kind: "profile",
    content: "Kelas 11 IPA di SMAN 3 Bandung",
    createdAt: "2026-07-26T10:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };
}

const SCREENS: [string, string][] = [
  ["intro 0", introBubbles("Dimas", false, TEST_TERMS_URL)[0] ?? ""],
  ["intro 1", introBubbles("Dimas", false, TEST_TERMS_URL)[1] ?? ""],
  ["intro 2", introBubbles("Dimas", false, TEST_TERMS_URL)[2] ?? ""],
  ["intro 2 dengan pesan tertahan", introBubbles(null, true, TEST_TERMS_URL)[2] ?? ""],
  ["penjelasan persetujuan", CONSENT_DETAIL],
  ["arahan keselamatan", PRE_CONSENT_SAFETY],
  ["pengingat pesan tertahan", HOLD_REMINDER],
  ["setelah setuju", CONSENT_ACCEPTED],
  ["setelah setuju dengan pesan tertahan", CONSENT_ACCEPTED_HELD],
  ["pertanyaan gaya", STYLE_QUESTION],
  ["gaya didengarkan", styleAck("listen")],
  ["gaya saran", styleAck("advice")],
  ["sapaan pengguna lama", welcomeBack(0)],
  ["sapaan pengguna lama dengan tugas", welcomeBack(3)],
  ["bantuan", HELP_MESSAGE],
  ["daftar memori kosong", formatMemories([])],
  ["daftar memori", formatMemories([memory()])],
  ["catatan memori", memoryNoteLines([memory()])],
  ["tugas tercatat", taskSavedHeading(() => 0)],
  ["tugas ditolak", taskDeclinedNote(() => 0)],
  ["tugas dibatalkan", taskDroppedHeading(() => 0)],
  ["tugas hilang", taskMissingNote(() => 0)],
  ["daftar kosong", emptyListNote(() => 0)],
  ["pembuka daftar", taskListLead(() => 0)],
  ["tidak paham", notUnderstoodNote(() => 0)],
  ["semua beres", nothingLeftNote(() => 0)],
];

describe("naskah yang dilihat pengguna", () => {
  it("membiarkan Telegram yang membungkus baris, bukan kodenya", () => {
    for (const [name, text] of SCREENS) {
      const broken = hardWrappedLine(text);
      assert.equal(broken, null, `${name} terpenggal di tengah kalimat: ${broken}`);
    }
  });

  it("tidak menyebut pengguna sebagai orang ketiga di layarnya sendiri", () => {
    for (const [name, text] of SCREENS) {
      assert.doesNotMatch(text, /\bPengguna\b/, name);
    }
  });
});
