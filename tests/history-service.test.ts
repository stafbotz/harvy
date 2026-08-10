import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HISTORY_EPISODE_RETENTION_LIMIT,
  episodeSourceHash,
} from "../src/core/episodic-compaction.js";
import {
  HISTORY_COMPACTION_CHUNK_MAX_CHARS,
  HISTORY_COMPACTION_CHUNK_MAX_TURNS,
  HISTORY_WINDOW,
} from "../src/core/history-policy.js";
import { HistoryService } from "../src/core/history-service.js";
import type {
  ConversationEpisode,
  ConversationHistory,
  EpisodeSummaryDraft,
  HistoryRepository,
  StoredConversationTurn,
} from "../src/domain/history.js";

describe("HistoryService", () => {
  it("mengisolasi riwayat berdasarkan pemilik", async () => {
    const service = new HistoryService(new HistoryStore(), neverSummarize);

    await service.append("student-a", "user", "halo");
    await service.append("student-b", "user", "hai");

    const mine = await service.context("student-a");
    assert.equal(mine.turns.length, 1);
    assert.equal(mine.turns[0]?.text, "halo");
  });

  it("mencari episode hanya dalam scope pemilik dan berhenti saat history diblokir", async () => {
    const store = new HistoryStore();
    await store.save(historyWithEpisode(
      "student-a",
      "Persiapan ujian biologi tentang mitosis.",
    ));
    await store.save(historyWithEpisode(
      "student-b",
      "Persiapan ujian biologi tentang meiosis.",
    ));
    const service = new HistoryService(store, neverSummarize);

    const mine = await service.search("student-a", "biologi mitosis");
    assert.equal(mine.length, 1);
    assert.match(mine[0]?.claims[0]?.text ?? "", /mitosis/u);
    assert.equal(
      mine.some((match) => match.claims.some((claim) => /meiosis/u.test(claim.text))),
      false,
    );

    service.suspend("student-a");
    assert.deepEqual(await service.search("student-a", "mitosis"), []);
    service.allow("student-a");
    assert.equal((await service.search("student-a", "mitosis")).length, 1);

    assert.equal(await service.forget("student-a", true), true);
    assert.deepEqual(await service.search("student-a", "mitosis"), []);
  });

  it("membuang hasil search yang selesai setelah consent diblokir", async () => {
    const stored = historyWithEpisode(
      "student",
      "Persiapan ujian kimia tentang stoikiometri.",
    );
    let releaseLoad: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const repository: HistoryRepository = {
      load: async () => {
        markStarted?.();
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
        return structuredClone(stored);
      },
      save: async () => undefined,
      remove: async () => true,
    };
    const service = new HistoryService(repository, neverSummarize);

    const searching = service.search("student", "stoikiometri");
    await started;
    service.suspend("student");
    releaseLoad?.();

    assert.deepEqual(await searching, []);
  });

  it("hanya membawa jendela darurat terbaru ke dalam prompt", async () => {
    const service = new HistoryService(new HistoryStore(), neverSummarize);

    for (let index = 0; index < HISTORY_WINDOW; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }

    const context = await service.context("student");
    assert.equal(context.turns.length, HISTORY_WINDOW);
    assert.equal(context.turns.at(-1)?.text, `pesan ${HISTORY_WINDOW - 1}`);
    assert.equal("sequence" in (context.turns[0] ?? {}), false);
  });

  it("tidak membuat celah tengah sebelum pemadatan berhasil", async () => {
    const service = new HistoryService(new HistoryStore(), neverSummarize);

    for (let index = 0; index < 12; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }

    const context = await service.context("student");
    assert.equal(context.turns.length, 12);
    assert.equal(context.turns[0]?.text, "pesan 0");
    assert.equal(context.turns.at(-1)?.text, "pesan 11");
  });

  it("menyimpan episode dengan provenance lalu membuang sumber mentahnya", async () => {
    const store = new HistoryStore();
    const summarized: StoredConversationTurn[][] = [];
    const service = new HistoryService(store, async (turns) => {
      summarized.push(structuredClone(turns));
      return draft(
        "Pengguna sedang menyiapkan ujian biologi.",
        [turns[0]!.sequence],
      );
    });

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }
    await service.compact("student");

    const stored = await store.load("student");
    assert.equal(stored?.episodes.length, 1);
    assert.ok(summarized.length > 0, "peringkas tidak pernah dipanggil");
    const episode = stored?.episodes[0];
    assert.equal(episode?.source.kind, "turn-range");
    if (episode?.source.kind !== "turn-range") {
      assert.fail("episode tidak mempunyai rentang sumber");
    }
    assert.equal(episode.source.fromSequence, summarized[0]![0]!.sequence);
    assert.equal(episode.source.throughSequence, summarized[0]!.at(-1)!.sequence);
    assert.equal(episode.source.turnCount, summarized[0]!.length);
    assert.equal(episode.source.sourceHash, episodeSourceHash(summarized[0]!));
    assert.deepEqual(
      episode.facts[0]?.sourceSequences,
      [summarized[0]![0]!.sequence],
    );

    assert.ok((stored?.turns.length ?? 0) >= HISTORY_WINDOW);
    assert.equal(stored?.turns.some((turn) => turn.text === "pesan 0"), false);
    assert.equal(stored?.turns.at(-1)?.text, "pesan 19");
    assert.match(
      (await service.context("student")).summary ?? "",
      /menyiapkan ujian biologi/u,
    );
  });

  it("mempertahankan riwayat ketika peringkasan gagal dan menahan retry", async () => {
    const store = new HistoryStore();
    let attempts = 0;
    const service = new HistoryService(store, async () => {
      attempts += 1;
      throw new Error("model sedang tidak bisa dihubungi");
    });

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }
    await service.compact("student");
    await service.compact("student");

    const stored = await store.load("student");
    assert.equal(stored?.episodes.length, 0);
    assert.equal(stored?.turns.length, 20);
    assert.equal(attempts, 1, "retry harus menunggu cooldown");
  });

  it("menolak klaim tanpa provenance dari rentang sumber", async () => {
    const store = new HistoryStore();
    const service = new HistoryService(store, async () =>
      draft("klaim yang menunjuk sumber lain", [999]));

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }
    await service.compact("student");

    const stored = await store.load("student");
    assert.equal(stored?.episodes.length, 0);
    assert.equal(stored?.turns.length, 20);
  });

  it("tidak memanggil peringkas dari jalur append", async () => {
    let summarized = false;
    const service = new HistoryService(new HistoryStore(), async () => {
      summarized = true;
      return emptyDraft();
    });

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }

    assert.equal(summarized, false);
  });

  it("mempertahankan giliran yang masuk saat episode sedang dibuat", async () => {
    const store = new HistoryStore();
    let finishSummary: ((summary: EpisodeSummaryDraft) => void) | undefined;
    let sourceSequence = 0;
    const service = new HistoryService(
      store,
      (turns) => {
        sourceSequence = turns[0]!.sequence;
        return new Promise<EpisodeSummaryDraft>((resolve) => {
          finishSummary = resolve;
        });
      },
    );

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }

    const compacting = service.compact("student");
    while (!finishSummary) await Promise.resolve();

    await service.append("student", "user", "bubble yang datang belakangan");
    finishSummary(draft("Episode lama tetap sah.", [sourceSequence]));
    await compacting;

    const stored = await store.load("student");
    assert.equal(stored?.turns.at(-1)?.text, "bubble yang datang belakangan");
    assert.equal(stored?.episodes.length, 1);
  });

  it("mengejar backlog baru dalam chunk terbatas tanpa satu request raksasa", async () => {
    const store = new HistoryStore();
    const chunks: StoredConversationTurn[][] = [];
    const service = new HistoryService(store, async (turns) => {
      chunks.push(structuredClone(turns));
      return emptyDraft();
    });

    for (let index = 0; index < 45; index += 1) {
      await service.append(
        "student",
        "user",
        `${index}-${"x".repeat(990)}`,
      );
    }
    await service.compact("student");

    const stored = await store.load("student");
    assert.ok(chunks.length > 1);
    assert.ok((stored?.turns.length ?? Infinity) <= 16);
    assert.ok((stored?.turns.length ?? 0) >= HISTORY_WINDOW);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= HISTORY_COMPACTION_CHUNK_MAX_TURNS);
      assert.ok(
        chunk.reduce((total, turn) => total + turn.text.length, 0) <=
          HISTORY_COMPACTION_CHUNK_MAX_CHARS,
      );
    }
  });

  it("menggabungkan permintaan compact yang datang ketika model masih aktif", async () => {
    const store = new HistoryStore();
    let firstFinish: ((summary: EpisodeSummaryDraft) => void) | undefined;
    let calls = 0;
    const service = new HistoryService(store, async () => {
      calls += 1;
      if (calls > 1) return emptyDraft();
      return new Promise<EpisodeSummaryDraft>((resolve) => {
        firstFinish = resolve;
      });
    });

    for (let index = 0; index < 17; index += 1) {
      await service.append("student", "user", `awal ${index}`);
    }
    const first = service.compact("student");
    while (!firstFinish) await Promise.resolve();

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `baru ${index}`);
    }
    const coalesced = service.compact("student");
    firstFinish(emptyDraft());
    await Promise.all([first, coalesced]);

    assert.ok(calls > 1);
    assert.ok(((await store.load("student"))?.turns.length ?? Infinity) <= 16);
  });

  it("membatalkan commit bila sumber lama berubah selama model bekerja", async () => {
    const store = new HistoryStore();
    let finishSummary: ((summary: EpisodeSummaryDraft) => void) | undefined;
    let sourceSequence = 0;
    const service = new HistoryService(store, (turns) => {
      sourceSequence = turns[0]!.sequence;
      return new Promise<EpisodeSummaryDraft>((resolve) => {
        finishSummary = resolve;
      });
    });

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }
    const compacting = service.compact("student");
    while (!finishSummary) await Promise.resolve();

    store.replaceTurnText("student", sourceSequence, "sumber telah berubah");
    finishSummary(draft("Episode dari snapshot lama.", [sourceSequence]));
    await compacting;

    const stored = await store.load("student");
    assert.equal(stored?.episodes.length, 0);
    assert.equal(stored?.turns.length, 20);
    assert.equal(stored?.turns[0]?.text, "sumber telah berubah");
  });

  it("membatalkan commit bila cakupan episode berubah selama model bekerja", async () => {
    const store = new HistoryStore();
    let finishSummary: ((summary: EpisodeSummaryDraft) => void) | undefined;
    let sourceSequence = 0;
    const service = new HistoryService(store, (turns) => {
      sourceSequence = turns[0]!.sequence;
      return new Promise<EpisodeSummaryDraft>((resolve) => {
        finishSummary = resolve;
      });
    });

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }
    const compacting = service.compact("student");
    while (!finishSummary) await Promise.resolve();

    store.addLegacyEpisode("student");
    finishSummary(draft("Episode dari cakupan lama.", [sourceSequence]));
    await compacting;

    const stored = await store.load("student");
    assert.equal(stored?.episodes.length, 1);
    assert.equal(stored?.episodes[0]?.source.kind, "legacy-summary");
    assert.equal(stored?.turns.length, 20);
  });

  it("tidak merangkum ulang episode lama setelah sepuluh siklus", async () => {
    const store = new HistoryStore();
    const ranges: Array<[number, number]> = [];
    const service = new HistoryService(store, async (turns) => {
      const range: [number, number] = [
        turns[0]!.sequence,
        turns.at(-1)!.sequence,
      ];
      ranges.push(range);
      return draft(`Rentang ${range[0]}-${range[1]}.`, [range[0], range[1]]);
    });

    for (let cycle = 0; cycle < 10; cycle += 1) {
      const additions = cycle === 0 ? 17 : 11;
      for (let index = 0; index < additions; index += 1) {
        await service.append("student", "user", `siklus ${cycle} pesan ${index}`);
      }
      await service.compact("student");
    }

    const stored = await store.load("student");
    assert.equal(stored?.episodes.length, 10);
    assert.equal(ranges.length, 10);
    for (let index = 1; index < ranges.length; index += 1) {
      assert.equal(ranges[index]![0], ranges[index - 1]![1] + 1);
    }
    assert.equal(stored?.episodes[0]?.facts[0]?.text, "Rentang 1-11.");
    assert.equal(stored?.episodes[0]?.source.kind, "turn-range");
    assert.equal(stored?.turns.length, HISTORY_WINDOW);
  });

  it("membatasi retensi episode tanpa membuat riwayat permanen tersembunyi", async () => {
    const store = new HistoryStore();
    const service = new HistoryService(store, async (turns) =>
      draft(`Rentang mulai ${turns[0]!.sequence}.`, [turns[0]!.sequence]));

    for (let cycle = 0; cycle < HISTORY_EPISODE_RETENTION_LIMIT + 2; cycle += 1) {
      const additions = cycle === 0 ? 17 : 11;
      for (let index = 0; index < additions; index += 1) {
        await service.append("student", "user", `pesan ${cycle}-${index}`);
      }
      await service.compact("student");
    }

    const episodes = (await store.load("student"))?.episodes ?? [];
    assert.equal(episodes.length, HISTORY_EPISODE_RETENTION_LIMIT);
    assert.notEqual(episodes[0]?.facts[0]?.text, "Rentang mulai 1.");
  });

  it("membatasi dua compaction model aktif secara global", async () => {
    const store = new HistoryStore();
    const pending = new Map<
      string,
      { turns: StoredConversationTurn[]; finish: (draft: EpisodeSummaryDraft) => void }
    >();
    const started: string[] = [];
    const service = new HistoryService(store, (turns, ownerId) => {
      const owner = ownerId ?? "unknown";
      started.push(owner);
      return new Promise<EpisodeSummaryDraft>((finish) => {
        pending.set(owner, { turns, finish });
      });
    });

    for (const owner of ["a", "b", "c"]) {
      for (let index = 0; index < 17; index += 1) {
        await service.append(owner, "user", `${owner}-${index}`);
      }
    }
    const compactions = ["a", "b", "c"].map((owner) => service.compact(owner));
    while (started.length < 2) await Promise.resolve();
    assert.deepEqual(started, ["a", "b"]);

    const first = pending.get("a")!;
    first.finish(draft("episode a", [first.turns[0]!.sequence]));
    while (started.length < 3) await Promise.resolve();
    assert.equal(started[2], "c");

    for (const owner of ["b", "c"]) {
      const item = pending.get(owner)!;
      item.finish(draft(`episode ${owner}`, [item.turns[0]!.sequence]));
    }
    await Promise.all(compactions);
  });

  it("penarikan izin menghentikan compaction yang masih menunggu slot", async () => {
    const store = new HistoryStore();
    const pending = new Map<
      string,
      { turns: StoredConversationTurn[]; finish: (draft: EpisodeSummaryDraft) => void }
    >();
    const started: string[] = [];
    const service = new HistoryService(store, (turns, ownerId) => {
      const owner = ownerId ?? "unknown";
      started.push(owner);
      return new Promise<EpisodeSummaryDraft>((finish) => {
        pending.set(owner, { turns, finish });
      });
    });

    for (const owner of ["a", "b", "c"]) {
      for (let index = 0; index < 17; index += 1) {
        await service.append(owner, "user", `${owner}-${index}`);
      }
    }
    const compactions = ["a", "b", "c"].map((owner) => service.compact(owner));
    while (started.length < 2) await Promise.resolve();

    service.suspend("c");
    const first = pending.get("a")!;
    first.finish(draft("episode a", [first.turns[0]!.sequence]));
    await compactions[2];
    assert.deepEqual(started, ["a", "b"]);
    assert.deepEqual(await service.context("c"), { summary: null, turns: [] });

    const second = pending.get("b")!;
    second.finish(draft("episode b", [second.turns[0]!.sequence]));
    await Promise.all(compactions);
    assert.equal((await store.load("c"))?.turns.length, 17);
  });

  it("melupakan seluruh riwayat seorang pengguna", async () => {
    const service = new HistoryService(new HistoryStore(), neverSummarize);

    await service.append("student", "user", "halo");
    assert.equal(await service.forget("student"), true);
    assert.equal((await service.context("student")).turns.length, 0);
  });

  it("penghapusan penuh menunggu pemadatan dan memblokir resurrection", async () => {
    const store = new HistoryStore();
    let finishSummary: ((summary: EpisodeSummaryDraft) => void) | undefined;
    let sourceSequence = 0;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const service = new HistoryService(store, (turns) => {
      sourceSequence = turns[0]!.sequence;
      return new Promise<EpisodeSummaryDraft>((finish) => {
        finishSummary = finish;
        markStarted?.();
      });
    });

    for (let index = 0; index < 20; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }
    const compacting = service.compact("student");
    await started;

    let forgotten = false;
    const forgetting = service.forget("student", true).then(() => {
      forgotten = true;
    });
    await Promise.resolve();
    assert.equal(forgotten, false);

    finishSummary?.(draft("Episode yang terlambat.", [sourceSequence]));
    await Promise.all([compacting, forgetting]);
    assert.equal(await store.load("student"), null);

    await service.append("student", "user", "tidak boleh hidup lagi");
    assert.equal(await store.load("student"), null);

    service.allow("student");
    await service.append("student", "user", "mulai lagi setelah izin");
    assert.equal((await store.load("student"))?.turns.length, 1);
    assert.equal((await store.load("student"))?.turns[0]?.sequence, 1);
  });

  it("drain menunggu compaction aktif", async () => {
    let finishSummary: ((summary: EpisodeSummaryDraft) => void) | undefined;
    let sourceSequence = 0;
    const service = new HistoryService(new HistoryStore(), (turns) => {
      sourceSequence = turns[0]!.sequence;
      return new Promise<EpisodeSummaryDraft>((finish) => {
        finishSummary = finish;
      });
    });
    for (let index = 0; index < 17; index += 1) {
      await service.append("student", "user", `pesan ${index}`);
    }
    void service.compact("student");
    while (!finishSummary) await Promise.resolve();

    let drained = false;
    const draining = service.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    finishSummary(draft("selesai", [sourceSequence]));
    await draining;
    assert.equal(drained, true);
  });

  it("membuang context dan episode retrieval yang selesai sesudah consent ditarik", async () => {
    const stored = historyWithEpisode("student", "Rahasia lama");
    stored.turns.push({
      sequence: 3,
      role: "user",
      text: "Pesan terbaru",
      at: "2026-08-09T00:00:00.000Z",
    });
    const contextStore = new SlowLoadHistoryStore(stored);
    const contextService = new HistoryService(contextStore, neverSummarize);
    const pendingContext = contextService.context("student");
    await contextStore.started;
    contextService.suspend("student");
    contextStore.release();
    assert.deepEqual(await pendingContext, { summary: null, turns: [] });

    const episodeStore = new SlowLoadHistoryStore(stored);
    const episodeService = new HistoryService(episodeStore, neverSummarize);
    const pendingEpisodes = episodeService.episodesForRetrieval("student");
    await episodeStore.started;
    episodeService.suspend("student");
    episodeStore.release();
    assert.deepEqual(await pendingEpisodes, []);
  });

  it("generation guard menutup suspend-allow ABA untuk read dan append", async () => {
    const stored = historyWithEpisode("student", "Rahasia lama");
    const contextStore = new SlowLoadHistoryStore(stored);
    const contextService = new HistoryService(contextStore, neverSummarize);
    const pendingContext = contextService.context("student");
    await contextStore.started;
    contextService.suspend("student");
    contextService.allow("student");
    contextStore.release();
    assert.deepEqual(await pendingContext, { summary: null, turns: [] });

    const appendStore = new SlowLoadHistoryStore(stored);
    const appendService = new HistoryService(appendStore, neverSummarize);
    const pendingAppend = appendService.append("student", "user", "pesan basi");
    await appendStore.started;
    appendService.suspend("student");
    appendService.allow("student");
    appendStore.release();
    assert.equal(await pendingAppend, null);
  });

  it("mengabaikan giliran kosong", async () => {
    const service = new HistoryService(new HistoryStore(), neverSummarize);

    await service.append("student", "user", "   ");
    assert.equal((await service.context("student")).turns.length, 0);
  });
});

function draft(text: string, sourceSequences: number[]): EpisodeSummaryDraft {
  return {
    ...emptyDraft(),
    facts: [{ text, sourceSequences }],
  };
}

function emptyDraft(): EpisodeSummaryDraft {
  return {
    topics: [],
    facts: [],
    goals: [],
    decisions: [],
    corrections: [],
    commitments: [],
    unresolved: [],
    temporalAnchors: [],
    uncertainties: [],
  };
}

function historyWithEpisode(ownerId: string, text: string): ConversationHistory {
  return {
    ownerId,
    episodes: [{
      schemaVersion: 2,
      episodeId: `episode_${ownerId}`,
      source: {
        kind: "turn-range",
        fromSequence: 1,
        throughSequence: 2,
        turnCount: 2,
        sourceHash: "a".repeat(64),
      },
      summarizerVersion: "test",
      createdAt: "2026-08-01T00:00:00.000Z",
      ...emptyDraft(),
      facts: [{ text, sourceSequences: [1] }],
    }],
    turns: [],
    nextSequence: 3,
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

async function neverSummarize(): Promise<EpisodeSummaryDraft> {
  throw new Error("peringkas tidak seharusnya dipanggil pada tes ini");
}

/** Penyimpanan di memori proses, agar tes tidak menyentuh berkas nyata. */
class HistoryStore implements HistoryRepository {
  private histories: ConversationHistory[] = [];

  async load(ownerId: string): Promise<ConversationHistory | null> {
    const found = this.histories.find((history) => history.ownerId === ownerId);
    return found ? structuredClone(found) : null;
  }

  async save(history: ConversationHistory): Promise<void> {
    const index = this.histories.findIndex(
      (stored) => stored.ownerId === history.ownerId,
    );
    if (index >= 0) {
      this.histories[index] = structuredClone(history);
    } else {
      this.histories.push(structuredClone(history));
    }
  }

  async remove(ownerId: string): Promise<boolean> {
    const index = this.histories.findIndex((history) => history.ownerId === ownerId);
    if (index < 0) return false;
    this.histories.splice(index, 1);
    return true;
  }

  replaceTurnText(ownerId: string, sequence: number, text: string): void {
    const turn = this.histories
      .find((history) => history.ownerId === ownerId)
      ?.turns.find((candidate) => candidate.sequence === sequence);
    if (turn) turn.text = text;
  }

  addLegacyEpisode(ownerId: string): void {
    const history = this.histories.find((item) => item.ownerId === ownerId);
    if (!history) return;
    const episode: ConversationEpisode = {
      schemaVersion: 2,
      episodeId: "legacy_concurrent",
      source: { kind: "legacy-summary", sourceHash: "f".repeat(64) },
      summarizerVersion: "rolling-v1",
      createdAt: "2026-08-02T01:00:00.000Z",
      ...emptyDraft(),
      facts: [{ text: "Episode lain masuk bersamaan.", sourceSequences: [] }],
    };
    history.episodes.push(episode);
  }
}

class SlowLoadHistoryStore implements HistoryRepository {
  readonly started: Promise<void>;
  private markStarted: (() => void) | undefined;
  private finish: (() => void) | undefined;
  private readonly gate: Promise<void>;

  constructor(private readonly history: ConversationHistory) {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }

  release(): void {
    this.finish?.();
  }

  async load(ownerId: string): Promise<ConversationHistory | null> {
    this.markStarted?.();
    await this.gate;
    return ownerId === this.history.ownerId
      ? structuredClone(this.history)
      : null;
  }

  async save(): Promise<void> {
    throw new Error("save tidak diharapkan");
  }

  async remove(): Promise<boolean> {
    return false;
  }
}
