import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { FileHistoryRepository } from "../src/storage/file-history-repository.js";
import type { ConversationHistory } from "../src/domain/history.js";
import { renderEpisodeContext } from "../src/core/episodic-compaction.js";

describe("FileHistoryRepository", () => {
  it("memigrasikan summary v1 sebagai episode warisan tanpa mengarang provenance", async () => {
    await withHistoryFile(async (file) => {
      await writeFile(file, JSON.stringify({
        version: 1,
        histories: [{
          ownerId: "student",
          summary: "Pengguna sedang menyiapkan ujian biologi.",
          turns: [
            {
              role: "user",
              text: "yang tadi lanjut",
              at: "2026-08-02T01:00:00.000Z",
            },
            {
              role: "harvy",
              text: "ayo",
              at: "2026-08-02T01:00:01.000Z",
            },
          ],
          updatedAt: "2026-08-02T01:00:01.000Z",
        }],
      }), "utf8");

      const history = await new FileHistoryRepository(file).load("student");
      assert.equal(history?.nextSequence, 3);
      assert.deepEqual(history?.turns.map((turn) => turn.sequence), [1, 2]);
      assert.equal(history?.episodes.length, 1);
      const legacy = history?.episodes[0];
      assert.equal(legacy?.source.kind, "legacy-summary");
      assert.deepEqual(legacy?.facts[0]?.sourceSequences, []);
      assert.equal(legacy?.summarizerVersion, "rolling-v1");
      assert.match(
        renderEpisodeContext(history?.episodes ?? []) ?? "",
        /ringkasan lama, belum terklasifikasi/u,
      );
      assert.doesNotMatch(
        renderEpisodeContext(history?.episodes ?? []) ?? "",
        /- fakta:/u,
      );

      const migrated = JSON.parse(await readFile(file, "utf8")) as {
        version: number;
        histories: Array<Record<string, unknown>>;
      };
      assert.equal(migrated.version, 2);
      assert.equal("summary" in migrated.histories[0]!, false);
      await assert.rejects(readFile(`${file}.tmp`, "utf8"), /ENOENT/u);
    });
  });

  it("mempertahankan ringkasan v1 yang lebih panjang dari satu klaim v2", async () => {
    await withHistoryFile(async (file) => {
      const legacySummary = `ringkasan lama ${"panjang ".repeat(80)}`.trim();
      await writeFile(file, JSON.stringify({
        version: 1,
        histories: [{
          ownerId: "student",
          summary: legacySummary,
          turns: [],
          updatedAt: "2026-08-02T01:00:00.000Z",
        }],
      }), "utf8");

      const repository = new FileHistoryRepository(file);
      assert.equal(
        (await repository.load("student"))?.episodes[0]?.facts[0]?.text,
        legacySummary,
      );
      assert.equal(
        (await new FileHistoryRepository(file).load("student"))
          ?.episodes[0]?.facts[0]?.text,
        legacySummary,
      );
    });
  });

  it("menyimpan dan membaca schema v2 tanpa kehilangan sequence", async () => {
    await withHistoryFile(async (file) => {
      const repository = new FileHistoryRepository(file);
      await repository.save(history("student-a", "halo"));
      await repository.save(history("student-b", "hai"));

      const reloaded = new FileHistoryRepository(file);
      assert.equal((await reloaded.load("student-a"))?.turns[0]?.sequence, 1);
      assert.equal((await reloaded.load("student-b"))?.turns[0]?.text, "hai");
    });
  });

  it("menserialisasi migrasi baca dan write yang datang bersamaan", async () => {
    await withHistoryFile(async (file) => {
      await writeFile(file, JSON.stringify({
        version: 1,
        histories: [{
          ownerId: "legacy",
          summary: null,
          turns: [],
          updatedAt: "2026-08-02T01:00:00.000Z",
        }],
      }), "utf8");
      const repository = new FileHistoryRepository(file);

      await Promise.all([
        repository.load("legacy"),
        repository.save(history("baru", "pesan baru")),
      ]);

      assert.notEqual(await repository.load("legacy"), null);
      assert.equal((await repository.load("baru"))?.turns[0]?.text, "pesan baru");
    });
  });

  it("menolak episode dengan klaim di luar rentang sumber", async () => {
    await withHistoryFile(async (file) => {
      const invalid = {
        version: 2,
        histories: [{
          ownerId: "student",
          episodes: [{
            schemaVersion: 2,
            episodeId: "episode_invalid",
            source: {
              kind: "turn-range",
              fromSequence: 1,
              throughSequence: 2,
              turnCount: 2,
              sourceHash: "a".repeat(64),
            },
            summarizerVersion: "episodic-v2.0",
            createdAt: "2026-08-02T01:00:00.000Z",
            topics: [],
            facts: [{ text: "di luar sumber", sourceSequences: [9] }],
            goals: [],
            decisions: [],
            corrections: [],
            commitments: [],
            unresolved: [],
            temporalAnchors: [],
            uncertainties: [],
          }],
          turns: [],
          nextSequence: 3,
          updatedAt: "2026-08-02T01:00:00.000Z",
        }],
      };
      await writeFile(file, JSON.stringify(invalid), "utf8");

      await assert.rejects(
        new FileHistoryRepository(file).load("student"),
        /riwayat v2 tidak sah/u,
      );
    });
  });

  it("menolak jumlah dan panjang klaim yang melewati batas schema", async () => {
    await withHistoryFile(async (file) => {
      const tooMany = episode(1, 2);
      tooMany.facts = Array.from({ length: 5 }, (_, index) => ({
        text: `fakta ${index}`,
        sourceSequences: [1],
      }));
      await writeFile(file, JSON.stringify(database([tooMany], [], 3)), "utf8");
      await assert.rejects(
        new FileHistoryRepository(file).load("student"),
        /riwayat v2 tidak sah/u,
      );

      const tooLong = episode(1, 2);
      tooLong.facts = [{ text: "x".repeat(281), sourceSequences: [1] }];
      await writeFile(file, JSON.stringify(database([tooLong], [], 3)), "utf8");
      await assert.rejects(
        new FileHistoryRepository(file).load("student"),
        /riwayat v2 tidak sah/u,
      );
    });
  });

  it("menolak celah cakupan episode maupun giliran mentah", async () => {
    await withHistoryFile(async (file) => {
      await writeFile(file, JSON.stringify(database([
        episode(1, 2),
        episode(4, 5),
      ], [], 6)), "utf8");
      await assert.rejects(
        new FileHistoryRepository(file).load("student"),
        /riwayat v2 tidak sah/u,
      );

      await writeFile(file, JSON.stringify(database(
        [episode(1, 2)],
        [{
          sequence: 4,
          role: "user",
          text: "sequence tiga hilang",
          at: "2026-08-02T01:00:00.000Z",
        }],
        5,
      )), "utf8");
      await assert.rejects(
        new FileHistoryRepository(file).load("student"),
        /riwayat v2 tidak sah/u,
      );
    });
  });

  it("menolak episode melampaui batas retensi", async () => {
    await withHistoryFile(async (file) => {
      const episodes = Array.from({ length: 13 }, (_, index) =>
        episode(index + 1, index + 1));
      await writeFile(file, JSON.stringify(database(episodes, [], 14)), "utf8");
      await assert.rejects(
        new FileHistoryRepository(file).load("student"),
        /riwayat v2 tidak sah/u,
      );
    });
  });

  it("tidak menghidupkan kembali data v1 setelah hasil migrasi dihapus", async () => {
    await withHistoryFile(async (file) => {
      await writeFile(file, JSON.stringify({
        version: 1,
        histories: [{
          ownerId: "student",
          summary: "ringkasan lama",
          turns: [],
          updatedAt: "2026-08-02T01:00:00.000Z",
        }],
      }), "utf8");
      const repository = new FileHistoryRepository(file);
      assert.notEqual(await repository.load("student"), null);
      assert.equal(await repository.remove("student"), true);

      assert.equal(
        await new FileHistoryRepository(file).load("student"),
        null,
      );
    });
  });
});

function history(ownerId: string, text: string): ConversationHistory {
  return {
    ownerId,
    episodes: [],
    turns: [{
      sequence: 1,
      role: "user",
      text,
      at: "2026-08-02T01:00:00.000Z",
    }],
    nextSequence: 2,
    updatedAt: "2026-08-02T01:00:00.000Z",
  };
}

function episode(fromSequence: number, throughSequence: number) {
  return {
    schemaVersion: 2,
    episodeId: `episode_${fromSequence}_${throughSequence}`,
    source: {
      kind: "turn-range",
      fromSequence,
      throughSequence,
      turnCount: throughSequence - fromSequence + 1,
      sourceHash: "a".repeat(64),
    },
    summarizerVersion: "episodic-v2.0",
    createdAt: "2026-08-02T01:00:00.000Z",
    topics: [],
    facts: [] as Array<{ text: string; sourceSequences: number[] }>,
    goals: [],
    decisions: [],
    corrections: [],
    commitments: [],
    unresolved: [],
    temporalAnchors: [],
    uncertainties: [],
  };
}

function database(
  episodes: ReturnType<typeof episode>[],
  turns: Array<{ sequence: number; role: string; text: string; at: string }>,
  nextSequence: number,
) {
  return {
    version: 2,
    histories: [{
      ownerId: "student",
      episodes,
      turns,
      nextSequence,
      updatedAt: "2026-08-02T01:00:00.000Z",
    }],
  };
}

async function withHistoryFile(
  run: (file: string) => Promise<void>,
): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), "harvy-history-v2-"));
  const absolute = resolve(folder);
  assert.ok(absolute.startsWith(resolve(tmpdir())));
  try {
    await run(join(absolute, "history.json"));
  } finally {
    await rm(absolute, { recursive: true, force: true });
  }
}
