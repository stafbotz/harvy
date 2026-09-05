import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemoryItem, MemoryKind } from "../src/domain/memory.js";
import {
  classifyMemoryActivity,
  dormancyPenalty,
  dormantMemories,
  DORMANT_AFTER_DAYS,
  retirableMemory,
  STALE_AFTER_DAYS,
} from "../src/core/memory-curator-policy.js";

const NOW = new Date("2026-09-04T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function memory(
  id: string,
  kind: MemoryKind,
  createdDaysAgo: number,
  usedDaysAgo: number | null,
): MemoryItem {
  return {
    id,
    ownerId: "ayu",
    kind,
    content: `catatan ${id}`,
    createdAt: daysAgo(createdDaysAgo),
    lastUsedAt: usedDaysAgo === null ? null : daysAgo(usedDaysAgo),
    expiresAt: null,
  };
}

describe("kurator memori berbasis pemakaian", () => {
  it("menghitung dormansi dari pemakaian terakhir, bukan dari kelahiran", () => {
    // Lahir setahun lalu tetapi minggu lalu masih membantu: tetap aktif.
    const dipakai = memory("a", "preference", 365, 7);
    assert.equal(classifyMemoryActivity(dipakai, NOW), "active");

    // Lahir setahun lalu dan tidak pernah sekali pun terpakai: dorman.
    const terbengkalai = memory("b", "preference", 365, null);
    assert.equal(classifyMemoryActivity(terbengkalai, NOW), "dormant");
  });

  it("tidak menganggap memori yang baru dibuat terbengkalai", () => {
    assert.equal(classifyMemoryActivity(memory("c", "context", 0, null), NOW), "active");
    assert.equal(classifyMemoryActivity(memory("d", "context", 3, null), NOW), "active");
  });

  it("melewati ambang menua lalu ambang dorman", () => {
    const menua = memory("e", "routine", STALE_AFTER_DAYS + 1, null);
    const dorman = memory("f", "routine", DORMANT_AFTER_DAYS + 1, null);
    assert.equal(classifyMemoryActivity(menua, NOW), "stale");
    assert.equal(classifyMemoryActivity(dorman, NOW), "dormant");
  });

  it("membuat profile kebal karena nama tidak menua karena jarang dipakai", () => {
    const nama = memory("g", "profile", 400, null);
    assert.equal(classifyMemoryActivity(nama, NOW), "active");
    assert.equal(dormancyPenalty(nama, NOW), 0);
    assert.equal(retirableMemory([nama], NOW), null);
  });

  it("memberi pengurang skor bertingkat, bukan diskualifikasi", () => {
    assert.equal(dormancyPenalty(memory("h", "context", 1, null), NOW), 0);
    assert.equal(
      dormancyPenalty(memory("i", "context", STALE_AFTER_DAYS + 1, null), NOW),
      1,
    );
    assert.equal(
      dormancyPenalty(memory("j", "context", DORMANT_AFTER_DAYS + 1, null), NOW),
      2,
    );
  });

  it("tidak memberi apa pun untuk dipensiunkan ketika semuanya masih terpakai", () => {
    const items = [
      memory("k", "preference", 300, 2),
      memory("l", "routine", 300, 20),
      memory("m", "profile", 300, null),
    ];
    assert.equal(retirableMemory(items, NOW), null);
  });

  it("memilih yang paling lama tidak tersentuh", () => {
    const items = [
      memory("baru", "preference", 200, 100),
      memory("paling-lama", "preference", 400, 300),
      memory("tengah", "routine", 250, 150),
    ];
    assert.equal(retirableMemory(items, NOW)?.id, "paling-lama");
  });

  it("memutus seri dengan yang lebih tua agar hasilnya tidak bergantung urutan", () => {
    const muda = memory("muda", "preference", 100, 95);
    const tua = memory("tua", "preference", 300, 95);
    assert.equal(retirableMemory([muda, tua], NOW)?.id, "tua");
    assert.equal(retirableMemory([tua, muda], NOW)?.id, "tua");
  });

  it("mendaftar yang layak ditanyakan ulang kepada pemiliknya", () => {
    const items = [
      memory("aktif", "preference", 10, 1),
      memory("dorman-1", "context", 200, null),
      memory("dorman-2", "personal", 400, 200),
    ];
    assert.deepEqual(
      dormantMemories(items, NOW).map((item) => item.id),
      ["dorman-1", "dorman-2"],
    );
  });
});
