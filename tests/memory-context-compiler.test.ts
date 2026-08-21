import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_CONTEXT } from "../src/ai/context.js";
import {
  MemoryContextCompiler,
  reciprocalRankFusion,
} from "../src/core/memory-context-compiler.js";
import { MemoryKnowledgeService } from "../src/core/memory-knowledge-service.js";
import { privateMemoryNamespace } from "../src/core/memory-namespace.js";
import {
  memoryPlanUsesRetrieval,
  planMemoryQuery,
} from "../src/core/memory-query-plan.js";
import { HistoryService } from "../src/core/history-service.js";
import type {
  ConversationEpisode,
  ConversationHistory,
  HistoryRepository,
} from "../src/domain/history.js";
import type { MemoryItem } from "../src/domain/memory.js";
import type {
  MemoryKnowledgeNamespace,
  MemoryKnowledgeRepository,
  MemoryKnowledgeState,
  TextEmbeddingProvider,
} from "../src/domain/memory-knowledge.js";
import type { LongTermMemoryRetriever } from
  "../src/domain/long-term-memory.js";

const NOW = new Date("2026-08-09T10:00:00.000Z");

describe("memory query plan", () => {
  it("mempertahankan raw request dan tidak membawa authority", () => {
    const raw = "  Apa yang pernah aku ceritakan tentang aljabar?  ";
    const plan = planMemoryQuery(raw, { now: NOW });
    assert.equal(
      plan.taskBrief.rawRequest,
      "Apa yang pernah aku ceritakan tentang aljabar?",
    );
    assert.equal(plan.routes.episodic, true);
    assert.equal(plan.routes.semantic, true);
    assert.equal("capabilities" in plan, false);
    assert.equal("provider" in plan, false);
    assert.equal("scope" in plan, false);
  });

  it("melewati sapaan, aritmetika, identitas, dan waktu lokal", () => {
    for (const text of [
      "halo",
      "2 + 2 berapa?",
      "kamu siapa?",
      "jam berapa sekarang?",
    ]) {
      assert.equal(memoryPlanUsesRetrieval(planMemoryQuery(text)), false, text);
    }
  });

  it("memperlakukan tanggal eksplisit sebagai as-of historis", () => {
    const plan = planMemoryQuery(
      "Pada 2026-07-15 sekolahku di mana?",
      { now: NOW },
    );
    assert.equal(plan.temporal.mode, "historical");
    assert.equal(plan.temporal.asOf, "2026-07-15T23:59:59.999Z");
    assert.equal(plan.routes.semantic, true);
    assert.equal(plan.routes.graph, true);
  });

  it("tidak menyamakan pertanyaan waktu memory dengan clock lokal", () => {
    for (const text of [
      "Tanggal berapa aku pindah sekolah?",
      "Hari apa aku pernah bilang ujian matematika?",
      "Jam berapa biasanya aku belajar?",
    ]) {
      assert.equal(memoryPlanUsesRetrieval(planMemoryQuery(text)), true, text);
    }
  });

  it("tidak mengaktifkan retrieval untuk pesan biasa tanpa memory intent", () => {
    const plan = planMemoryQuery("tolong jelaskan rumus kuadrat ini", { now: NOW });
    assert.equal(memoryPlanUsesRetrieval(plan), false);
    assert.deepEqual(plan.routes, {
      episodic: false,
      semantic: false,
      graph: false,
      personalization: false,
      procedural: false,
      errorLessons: false,
    });
  });

  it("membatasi potret pengguna pada episode, semantic, graph, dan user model", () => {
    const plan = planMemoryQuery(
      "Apa yang kamu ingat tentangku sekarang dan dulu: profilku, preferensi, kebiasaan, tujuan, hubungan, proyek, serta hal penting yang berubah?",
      { now: NOW },
    );

    assert.equal(plan.temporal.mode, "historical");
    assert.deepEqual(plan.routes, {
      episodic: true,
      semantic: true,
      graph: true,
      personalization: true,
      procedural: false,
      errorLessons: false,
    });
    assert.equal(plan.limits.contextItems, 8);
    assert.equal(plan.limits.contextCharacters, 3_000);
  });
});

describe("memory context compiler", () => {
  it("fast path tidak memanggil archive, embedding, procedure, lesson, atau user model", async () => {
    const calls = {
      archive: 0,
      userModel: 0,
      procedures: 0,
      lessons: 0,
    };
    const historyService = {
      episodesForRetrieval: async () => [],
      episodesForContext: async () => [],
      search: async () => {
        calls.archive += 1;
        return [];
      },
    } as unknown as HistoryService;
    const longTerm = {
      async searchUserModel() {
        calls.userModel += 1;
        return [];
      },
      async searchProcedures() {
        calls.procedures += 1;
        return [];
      },
      async searchErrorLessons() {
        calls.lessons += 1;
        return [];
      },
    } satisfies LongTermMemoryRetriever;
    const knowledge = new MemoryKnowledgeService(new KnowledgeStore());
    const compiler = new MemoryContextCompiler(
      historyService,
      knowledge,
      () => NOW,
      undefined,
      longTerm,
    );

    const compiled = await compiler.compilePrivate(
      "student",
      "halo",
      EMPTY_CONTEXT,
    );
    assert.equal(memoryPlanUsesRetrieval(compiled.plan), false);
    assert.deepEqual(calls, {
      archive: 0,
      userModel: 0,
      procedures: 0,
      lessons: 0,
    });
    assert.equal(compiled.manifest.semanticRequested, false);
  });

  it("menggunakan satu budget bersama untuk user model, procedure, dan error lesson", async () => {
    const historyService = {
      episodesForRetrieval: async () => [],
      episodesForContext: async () => [],
      search: async () => [],
    } as unknown as HistoryService;
    const evidence = (source: "user-model" | "procedure" | "error-lesson") =>
      Array.from({ length: 12 }, (_, index) => ({
        id: `${source}:${index}`,
        sources: [source],
        text: `${source} ${index} ${"x".repeat(480)}`,
        score: 10 - index / 10,
        validFrom: null,
        validUntil: null,
        status: "active" as const,
        sensitivity: "normal" as const,
        sourceEpisodeIds: [],
        sourceSequences: [],
        sourceMemoryIds: [],
      }));
    const longTerm: LongTermMemoryRetriever = {
      async searchUserModel() { return evidence("user-model"); },
      async searchProcedures() { return evidence("procedure"); },
      async searchErrorLessons() { return evidence("error-lesson"); },
    };
    const compiler = new MemoryContextCompiler(
      historyService,
      new MemoryKnowledgeService(new KnowledgeStore()),
      () => NOW,
      undefined,
      longTerm,
    );

    const compiled = await compiler.compilePrivate(
      "student",
      "Tolong review implementasi error deployment repository ini",
      EMPTY_CONTEXT,
    );
    const selected = compiled.context.retrieved ?? [];
    assert.ok(selected.length <= compiled.plan.limits.contextItems);
    assert.ok(
      selected.reduce((total, item) => total + item.text.length, 0) <=
        compiled.plan.limits.contextCharacters,
    );
    assert.equal(compiled.manifest.personalizationRequested, true);
    assert.equal(compiled.manifest.proceduralRequested, true);
    assert.equal(compiled.manifest.errorLessonsRequested, true);
  });

  it("tidak memuat seluruh episode ketika semantic provider tidak tersedia", async () => {
    let episodeLoads = 0;
    let contextEpisodeLoads = 0;
    const historyService = {
      episodesForRetrieval: async () => {
        episodeLoads += 1;
        return [];
      },
      episodesForContext: async () => {
        contextEpisodeLoads += 1;
        return [];
      },
      search: async () => [],
    } as unknown as HistoryService;
    const compiler = new MemoryContextCompiler(
      historyService,
      new MemoryKnowledgeService(new KnowledgeStore()),
      () => NOW,
    );
    await compiler.compilePrivate(
      "student",
      "Siapa guru matematikaku sekarang?",
      EMPTY_CONTEXT,
    );
    assert.equal(episodeLoads, 0);
    assert.equal(contextEpisodeLoads, 1);
  });

  it("membawa episode lama relevan tanpa episode baru yang tidak cocok", async () => {
    const historyStore = new HistoryStore(history([
      episode("old", "Aljabar matriks akan keluar di ujian.", 1, "2026-07-01T00:00:00.000Z"),
      episode("new", "Latihan basket hari Jumat.", 2, "2026-08-08T00:00:00.000Z"),
    ]));
    const historyService = new HistoryService(historyStore, async () => emptyDraft());
    const knowledge = new MemoryKnowledgeService(new KnowledgeStore());
    const compiler = new MemoryContextCompiler(
      historyService,
      knowledge,
      () => NOW,
    );

    const compiled = await compiler.compilePrivate(
      "student",
      "Apa yang pernah kubahas tentang aljabar?",
      EMPTY_CONTEXT,
    );
    assert.equal(compiled.context.retrieved?.length, 1);
    assert.match(compiled.context.retrieved?.[0]?.text ?? "", /Aljabar/u);
    assert.doesNotMatch(
      JSON.stringify(compiled.context.retrieved),
      /basket/iu,
    );
    assert.equal(compiled.manifest.episodicResultCount, 1);
    assert.equal(compiled.manifest.selectedCount, 1);
  });

  it("menerapkan suppression sebelum episode masuk Context Pack", async () => {
    const historyStore = new HistoryStore(history([
      episode("old", "Warna favorit pengguna adalah biru.", 10),
      episode("kept", "Sedang belajar aljabar.", 11),
    ]));
    const historyService = new HistoryService(historyStore, async () => emptyDraft());
    const knowledge = new MemoryKnowledgeService(new KnowledgeStore());
    const forgotten = memory("Warna favoritku biru");
    await knowledge.rememberSource(forgotten, {
      ownerId: "student",
      kind: "preference",
      content: forgotten.content,
      sourceSequences: [10],
    });
    await knowledge.forgetSource(forgotten);
    const compiler = new MemoryContextCompiler(historyService, knowledge, () => NOW);

    const compiled = await compiler.compilePrivate(
      "student",
      "Apa warna favorit yang pernah kuceritakan?",
      EMPTY_CONTEXT,
    );
    assert.deepEqual(compiled.context.retrieved ?? [], []);
    assert.ok(compiled.manifest.suppressedCount >= 1);
  });

  it("menggabungkan semantic dan graph secara deterministik tanpa graph-only authority", async () => {
    const historyService = new HistoryService(
      new HistoryStore(history([])),
      async () => emptyDraft(),
    );
    const knowledge = new MemoryKnowledgeService(
      new KnowledgeStore(),
      new VisualEmbeddingProvider(),
      () => NOW,
      () => "one",
    );
    const namespace = privateMemoryNamespace("student");
    await knowledge.consolidate(namespace, [{
      subject: "Matematika",
      predicate: "taught_by",
      value: "Pak Ardi",
      displayText: "Guru Matematika adalah Pak Ardi dan menjelaskan lewat diagram.",
      sourceSequences: [8],
      provenance: "asserted",
      graphProjection: {
        from: { type: "course", canonicalName: "Matematika" },
        relation: "taught_by",
        to: { type: "person", canonicalName: "Pak Ardi" },
      },
    }]);
    const compiler = new MemoryContextCompiler(historyService, knowledge, () => NOW);

    const compiled = await compiler.compilePrivate(
      "student",
      "Siapa guru matematika yang memakai penjelasan visual?",
      EMPTY_CONTEXT,
    );
    assert.equal(compiled.context.retrieved?.length, 1);
    assert.deepEqual(
      compiled.context.retrieved?.[0]?.sources,
      ["semantic", "graph"],
    );
    assert.equal(compiled.manifest.semanticResultCount, 1);
    assert.equal(compiled.manifest.graphResultCount, 1);
  });

  it("fallback ke lexical bila provider semantic gagal", async () => {
    const historyService = new HistoryService(
      new HistoryStore(history([
        episode("old", "Ujian aljabar membahas matriks.", 1),
      ])),
      async () => emptyDraft(),
    );
    const failing: TextEmbeddingProvider = {
      modelId: "broken",
      embed: async () => {
        throw new Error("provider down");
      },
    };
    const knowledge = new MemoryKnowledgeService(new KnowledgeStore(), failing);
    await knowledge.consolidate(privateMemoryNamespace("student"), [{
      subject: "user",
      predicate: "studies",
      value: "aljabar",
      displayText: "Sedang belajar aljabar.",
      sourceSequences: [2],
      provenance: "asserted",
    }]);
    const compiler = new MemoryContextCompiler(historyService, knowledge, () => NOW);
    const compiled = await compiler.compilePrivate(
      "student",
      "Ingat ujian aljabar matriks?",
      EMPTY_CONTEXT,
    );

    assert.equal(compiled.context.retrieved?.length, 1);
    assert.equal(compiled.context.retrieved?.[0]?.sources[0], "episode");
    assert.equal(compiled.manifest.failedRouteCount, 1);
  });

  it("query current tidak membawa episode sekolah lama setelah correction", async () => {
    const historyService = new HistoryService(
      new HistoryStore(history([
        episode("old-school", "Sekolah di SMAN Lama", 1, "2026-07-01T00:00:00.000Z"),
      ])),
      async () => emptyDraft(),
    );
    const knowledge = new MemoryKnowledgeService(
      new KnowledgeStore(),
      new VisualEmbeddingProvider(),
      () => NOW,
      (() => {
        let id = 0;
        return () => `school-${id += 1}`;
      })(),
    );
    const namespace = privateMemoryNamespace("student");
    await knowledge.consolidate(namespace, [{
      subject: "user",
      predicate: "studies_at",
      value: "SMAN Lama",
      displayText: "Sekolah di SMAN Lama",
      validFrom: "2026-07-01T00:00:00.000Z",
      sourceSequences: [1],
      provenance: "asserted",
      graphProjection: {
        from: { type: "person", canonicalName: "Pengguna" },
        relation: "studies_at",
        to: { type: "place", canonicalName: "SMAN Lama" },
      },
    }]);
    await knowledge.consolidate(namespace, [{
      subject: "user",
      predicate: "studies_at",
      value: "SMAN Baru",
      displayText: "Sekolah di SMAN Baru",
      validFrom: "2026-08-01T00:00:00.000Z",
      sourceSequences: [2],
      provenance: "asserted",
      correction: true,
      graphProjection: {
        from: { type: "person", canonicalName: "Pengguna" },
        relation: "studies_at",
        to: { type: "place", canonicalName: "SMAN Baru" },
      },
    }]);
    const compiled = await new MemoryContextCompiler(
      historyService,
      knowledge,
      () => NOW,
    ).compilePrivate("student", "Ingat sekolahku sekarang apa?", EMPTY_CONTEXT);

    assert.equal(compiled.plan.routes.episodic, true);
    assert.ok(compiled.context.retrieved?.some((item) =>
      item.text.includes("SMAN Baru")));
    assert.equal(compiled.context.retrieved?.some((item) =>
      item.text.includes("SMAN Lama")), false);
    assert.doesNotMatch(compiled.context.summary ?? "", /SMAN Lama/u);
  });

  it("mengganti primary superseded dengan evidence current meski route off", async () => {
    const knowledge = new MemoryKnowledgeService(
      new KnowledgeStore(),
      null,
      () => NOW,
      (() => {
        let id = 0;
        return () => `base-${id += 1}`;
      })(),
    );
    const old: MemoryItem = {
      ...memory("Sekolah di SMAN Lama"),
      id: "memory-old",
      kind: "profile",
    };
    const current: MemoryItem = {
      ...memory("Sekolah di SMAN Baru"),
      id: "memory-current",
      kind: "profile",
    };
    await knowledge.rememberSource(old, {
      ownerId: "student",
      kind: "profile",
      content: old.content,
      subject: "user",
      predicate: "studies_at",
      value: "SMAN Lama",
      sourceSequences: [1],
      provenance: "asserted",
    });
    await knowledge.rememberSource(current, {
      ownerId: "student",
      kind: "profile",
      content: current.content,
      subject: "user",
      predicate: "studies_at",
      value: "SMAN Baru",
      sourceSequences: [2],
      provenance: "asserted",
      correction: true,
    });
    const compiler = new MemoryContextCompiler(
      new HistoryService(new HistoryStore(history([])), async () => emptyDraft()),
      knowledge,
      () => NOW,
    );
    const compiled = await compiler.compilePrivate("student", "halo", {
      summary: null,
      turns: [],
      memories: [current, old],
    });
    assert.equal(memoryPlanUsesRetrieval(compiled.plan), false);
    assert.deepEqual(compiled.context.memories, []);
    assert.deepEqual(
      compiled.context.retrieved?.map((item) => item.text),
      ["Sekolah di SMAN Baru"],
    );
  });

  it("historical tanpa tanggal membawa interval lama sebagai historis", async () => {
    const knowledge = new MemoryKnowledgeService(
      new KnowledgeStore(),
      new VisualEmbeddingProvider(),
      () => NOW,
      (() => {
        let id = 0;
        return () => `history-${id += 1}`;
      })(),
    );
    const namespace = privateMemoryNamespace("student");
    await knowledge.consolidate(namespace, [{
      subject: "user",
      predicate: "studies_at",
      value: "SMAN Lama",
      displayText: "Sekolah di SMAN Lama",
      validFrom: "2026-07-01T00:00:00.000Z",
      sourceSequences: [1],
      provenance: "asserted",
      graphProjection: {
        from: { type: "person", canonicalName: "Pengguna" },
        relation: "studies_at",
        to: { type: "place", canonicalName: "SMAN Lama" },
      },
    }]);
    await knowledge.consolidate(namespace, [{
      subject: "user",
      predicate: "studies_at",
      value: "SMAN Baru",
      displayText: "Sekolah di SMAN Baru",
      validFrom: "2026-08-01T00:00:00.000Z",
      sourceSequences: [2],
      provenance: "asserted",
      correction: true,
      graphProjection: {
        from: { type: "person", canonicalName: "Pengguna" },
        relation: "studies_at",
        to: { type: "place", canonicalName: "SMAN Baru" },
      },
    }]);
    const compiler = new MemoryContextCompiler(
      new HistoryService(new HistoryStore(history([])), async () => emptyDraft()),
      knowledge,
      () => NOW,
    );
    const compiled = await compiler.compilePrivate(
      "student",
      "Dulu sekolahku di mana?",
      EMPTY_CONTEXT,
    );
    const old = compiled.context.retrieved?.find((item) =>
      item.text.includes("SMAN Lama"));
    assert.ok(old);
    assert.equal(old.status, "superseded");
    assert.equal(old.validUntil, "2026-08-01T00:00:00.000Z");
  });

  it("as-of mengecualikan episode yang baru dibuat sesudah tanggal query", async () => {
    const compiler = new MemoryContextCompiler(
      new HistoryService(
        new HistoryStore(history([
          episode("before", "Membahas matriks aljabar", 1, "2026-07-01T00:00:00.000Z"),
          episode("after", "Membahas matriks aljabar lagi", 2, "2026-08-01T00:00:00.000Z"),
        ])),
        async () => emptyDraft(),
      ),
      new MemoryKnowledgeService(new KnowledgeStore()),
      () => NOW,
    );
    const compiled = await compiler.compilePrivate(
      "student",
      "Pada 2026-07-15 apa yang pernah kubahas tentang matriks aljabar?",
      EMPTY_CONTEXT,
    );
    assert.deepEqual(
      compiled.context.retrieved?.map((item) => item.sourceEpisodeIds[0]),
      ["episode-before"],
    );
    assert.doesNotMatch(compiled.context.summary ?? "", /lagi/u);
  });

  it("memfilter episode tombstone sebelum RRF agar reassertion baru bertahan", async () => {
    const historyService = new HistoryService(
      new HistoryStore(history([
        episode("old", "Suka diagram", 1, "2026-07-01T00:00:00.000Z"),
      ])),
      async () => emptyDraft(),
    );
    const knowledge = new MemoryKnowledgeService(
      new KnowledgeStore(),
      new VisualEmbeddingProvider(),
      () => NOW,
      (() => {
        let id = 0;
        return () => `reassert-${id += 1}`;
      })(),
    );
    const old = memory("Suka diagram");
    await knowledge.rememberSource(old, {
      ownerId: "student",
      kind: "preference",
      content: old.content,
      sourceSequences: [1],
    });
    await knowledge.forgetSource(old);
    await knowledge.rememberSource({ ...old, id: "memory-new" }, {
      ownerId: "student",
      kind: "preference",
      content: old.content,
      sourceSequences: [2],
    });
    const compiled = await new MemoryContextCompiler(
      historyService,
      knowledge,
      () => NOW,
    ).compilePrivate(
      "student",
      "Apa yang pernah kuceritakan soal diagram?",
      EMPTY_CONTEXT,
    );
    assert.equal(compiled.context.retrieved?.length, 1);
    assert.ok(compiled.context.retrieved?.[0]?.sources.includes("semantic"));
    assert.deepEqual(compiled.context.retrieved?.[0]?.sourceMemoryIds, [
      "memory-new",
    ]);
  });
});

describe("memory retrieval fusion identity", () => {
  it("memisahkan recurrence teks sama pada interval berbeda", () => {
    const base = {
      sources: ["semantic" as const],
      text: "Sekolah di SMAN A",
      score: 1,
      sensitivity: "normal" as const,
      sourceEpisodeIds: [] as string[],
      sourceMemoryIds: [] as string[],
    };
    const fused = reciprocalRankFusion({
      episodic: [],
      graph: [],
      semantic: [
        {
          ...base,
          id: "semantic:old-a",
          validFrom: "2026-07-01T00:00:00.000Z",
          validUntil: "2026-08-01T00:00:00.000Z",
          status: "superseded",
          sourceSequences: [1],
        },
        {
          ...base,
          id: "semantic:new-a",
          validFrom: "2026-09-01T00:00:00.000Z",
          validUntil: null,
          status: "active",
          sourceSequences: [3],
        },
      ],
    });
    assert.equal(fused.length, 2);
    assert.deepEqual(
      new Set(fused.map((item) => item.sourceSequences[0])),
      new Set([1, 3]),
    );
  });
});

class HistoryStore implements HistoryRepository {
  constructor(private state: ConversationHistory | null) {}

  async load(ownerId: string): Promise<ConversationHistory | null> {
    return this.state?.ownerId === ownerId ? structuredClone(this.state) : null;
  }

  async save(value: ConversationHistory): Promise<void> {
    this.state = structuredClone(value);
  }

  async remove(ownerId: string): Promise<boolean> {
    if (this.state?.ownerId !== ownerId) return false;
    this.state = null;
    return true;
  }
}

class KnowledgeStore implements MemoryKnowledgeRepository {
  private readonly states = new Map<string, MemoryKnowledgeState>();

  async load(namespace: MemoryKnowledgeNamespace): Promise<MemoryKnowledgeState | null> {
    const value = this.states.get(JSON.stringify(namespace));
    return value ? structuredClone(value) : null;
  }

  async save(
    state: MemoryKnowledgeState,
    expectedRevision: number | null,
  ): Promise<"saved" | "conflict"> {
    const key = JSON.stringify(state.namespace);
    const current = this.states.get(key);
    if (
      (expectedRevision === null && current) ||
      (expectedRevision !== null && current?.revision !== expectedRevision)
    ) {
      return "conflict";
    }
    this.states.set(key, structuredClone(state));
    return "saved";
  }

  async remove(namespace: MemoryKnowledgeNamespace): Promise<boolean> {
    return this.states.delete(JSON.stringify(namespace));
  }
}

class VisualEmbeddingProvider implements TextEmbeddingProvider {
  readonly modelId = "visual-test";

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) =>
      /visual|diagram|guru|matematika/iu.test(text) ? [1, 0] : [0, 1]);
  }
}

function history(episodes: ConversationEpisode[]): ConversationHistory {
  return {
    ownerId: "student",
    episodes,
    turns: [],
    nextSequence: 100,
    updatedAt: NOW.toISOString(),
  };
}

function episode(
  id: string,
  fact: string,
  sequence: number,
  createdAt = NOW.toISOString(),
): ConversationEpisode {
  return {
    ...emptyDraft(),
    schemaVersion: 2,
    episodeId: `episode-${id}`,
    facts: [{ text: fact, sourceSequences: [sequence] }],
    source: {
      kind: "turn-range",
      fromSequence: sequence,
      throughSequence: sequence,
      turnCount: 1,
      sourceHash: "a".repeat(64),
    },
    createdAt,
    summarizerVersion: "test",
  };
}

function emptyDraft() {
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

function memory(content: string): MemoryItem {
  return {
    id: "memory-1",
    ownerId: "student",
    kind: "preference",
    content,
    createdAt: NOW.toISOString(),
    lastUsedAt: null,
    expiresAt: null,
  };
}
