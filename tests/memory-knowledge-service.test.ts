import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MemoryKnowledgeService,
  type MemoryConsolidationCandidate,
} from "../src/core/memory-knowledge-service.js";
import { MemoryService } from "../src/core/memory-service.js";
import { deriveMemoryMetadata } from "../src/core/memory-candidate.js";
import {
  privateMemoryNamespace,
} from "../src/core/memory-namespace.js";
import type { MemoryItem, MemoryRepository } from "../src/domain/memory.js";
import type {
  MemoryKnowledgeNamespace,
  MemoryKnowledgeRepository,
  MemoryKnowledgeState,
  TextEmbeddingProvider,
} from "../src/domain/memory-knowledge.js";

const NOW = new Date("2026-08-09T10:00:00.000Z");

describe("memory knowledge consolidation", () => {
  it("menggabungkan duplicate dan merepresentasikan correction sebagai supersession temporal", async () => {
    const service = createService();
    const namespace = privateMemoryNamespace("student");
    const first = schoolCandidate("SMAN Lama", 1, "2026-07-01T00:00:00.000Z");
    const duplicate = schoolCandidate("SMAN Lama", 2, "2026-07-01T00:00:00.000Z");
    const correction = {
      ...schoolCandidate("SMAN Baru", 3, "2026-08-01T00:00:00.000Z"),
      correction: true,
    };

    assert.deepEqual(await service.consolidate(namespace, [first]), {
      saved: 1,
      merged: 0,
      superseded: 0,
      uncertain: 0,
      rejected: 0,
    });
    assert.equal((await service.consolidate(namespace, [duplicate])).merged, 1);
    assert.equal((await service.consolidate(namespace, [correction])).superseded, 1);

    const state = await service.snapshot(namespace);
    assert.ok(state);
    assert.equal(state.semanticMemories.length, 2);
    const old = state.semanticMemories.find((memory) => memory.value === "SMAN Lama");
    const current = state.semanticMemories.find((memory) => memory.value === "SMAN Baru");
    assert.equal(old?.status, "superseded");
    assert.equal(old?.validUntil, "2026-08-01T00:00:00.000Z");
    assert.deepEqual(old?.sourceSequences, [1, 2]);
    assert.equal(current?.status, "active");
    assert.ok(state.relations.every((relation) =>
      relation.sourceSequences.length > 0));

    const historical = await service.searchGraph(namespace, "SMAN Lama", {
      asOf: "2026-07-15T00:00:00.000Z",
      includeHistorical: true,
    });
    const latest = await service.searchGraph(namespace, "SMAN Baru");
    assert.equal(historical[0]?.text, "Sekolah di SMAN Lama");
    assert.equal(latest[0]?.text, "Sekolah di SMAN Baru");
  });

  it("menandai contradiction ambigu uncertain dan menolak inferred sensitive", async () => {
    const service = createService();
    const namespace = privateMemoryNamespace("student");
    const first = preferenceCandidate("visual", 1);
    const conflict = preferenceCandidate("audio", 2);
    const result = await service.consolidate(namespace, [first, conflict]);
    assert.equal(result.saved, 2);
    assert.equal(result.uncertain, 2);
    assert.deepEqual(
      (await service.snapshot(namespace))?.semanticMemories.map((memory) =>
        memory.status),
      ["uncertain", "uncertain"],
    );

    const rejected = await service.consolidate(namespace, [{
      ...preferenceCandidate("rahasia", 3),
      provenance: "inferred",
      sensitivity: "personal",
    }], { sensitiveConsent: true });
    assert.equal(rejected.rejected, 1);
  });

  it("koreksi eksplisit menyelesaikan seluruh nilai uncertain pada slot", async () => {
    const service = createService();
    const namespace = privateMemoryNamespace("student");
    await service.consolidate(namespace, [
      preferenceCandidate("visual", 1),
      preferenceCandidate("audio", 2),
    ]);
    const resolved = await service.consolidate(namespace, [{
      ...preferenceCandidate("kinestetik", 3),
      correction: true,
    }]);

    assert.equal(resolved.superseded, 2);
    const state = await service.snapshot(namespace);
    assert.deepEqual(
      state?.semanticMemories.map((item) => item.status).sort(),
      ["active", "superseded", "superseded"],
    );
    assert.equal(
      state?.semanticMemories.find((item) => item.value === "kinestetik")?.status,
      "active",
    );
  });

  it("tidak menganggap dua preference berbeda sebagai contradiction satu slot", async () => {
    const service = createService();
    const namespace = privateMemoryNamespace("student");
    const visual = memory("student", "visual", "Suka belajar visual");
    const morning = memory("student", "morning", "Suka belajar pagi");
    await service.rememberSource(visual, {
      ownerId: "student",
      kind: "preference",
      content: visual.content,
      sourceSequences: [1],
      ...deriveMemoryMetadata("preference", visual.content, "aku suka belajar visual"),
    });
    await service.rememberSource(morning, {
      ownerId: "student",
      kind: "preference",
      content: morning.content,
      sourceSequences: [2],
      ...deriveMemoryMetadata("preference", morning.content, "aku suka belajar pagi"),
    });

    assert.deepEqual(
      (await service.snapshot(namespace))?.semanticMemories.map((item) =>
        item.status),
      ["active", "active"],
    );
  });

  it("membuat interval baru ketika nilai lama berlaku lagi setelah dua koreksi", async () => {
    const service = createService();
    const namespace = privateMemoryNamespace("student");
    await service.consolidate(namespace, [schoolCandidate(
      "SMAN A",
      1,
      "2026-07-01T00:00:00.000Z",
    )]);
    await service.consolidate(namespace, [{
      ...schoolCandidate("SMAN B", 2, "2026-08-01T00:00:00.000Z"),
      correction: true,
    }]);
    await service.consolidate(namespace, [{
      ...schoolCandidate("SMAN A", 3, "2026-09-01T00:00:00.000Z"),
      correction: true,
    }]);

    const records = [
      ...((await service.snapshot(namespace))?.semanticMemories ?? []),
    ].sort((left, right) =>
      Date.parse(left.validFrom ?? left.createdAt) -
      Date.parse(right.validFrom ?? right.createdAt));
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((item) => item.value), ["SMAN A", "SMAN B", "SMAN A"]);
    assert.deepEqual(records.map((item) => item.status), [
      "superseded",
      "superseded",
      "active",
    ]);
    assert.equal(records[0]?.validUntil, "2026-08-01T00:00:00.000Z");
    assert.equal(records[1]?.validUntil, "2026-09-01T00:00:00.000Z");
  });

  it("memakai interval lama sampai correction future benar-benar berlaku", async () => {
    const service = createService();
    const namespace = privateMemoryNamespace("student");
    await service.consolidate(namespace, [schoolCandidate(
      "SMAN Lama",
      1,
      "2026-07-01T00:00:00.000Z",
    )]);
    await service.consolidate(namespace, [{
      ...schoolCandidate("SMAN Future", 2, "2026-09-01T00:00:00.000Z"),
      correction: true,
    }]);

    const current = await service.searchGraph(namespace, "SMAN Lama");
    assert.equal(current[0]?.text, "Sekolah di SMAN Lama");
    assert.equal(current[0]?.status, "active");
    assert.equal(
      (await service.searchGraph(namespace, "SMAN Future"))
        .some((item) => item.text.includes("SMAN Future")),
      false,
    );
  });

  it("mengembalikan counter hanya dari CAS attempt yang berhasil", async () => {
    const store = new ConflictOnceKnowledgeStore();
    const service = new MemoryKnowledgeService(store, null, () => NOW, () => "cas-id");
    const result = await service.consolidate(
      privateMemoryNamespace("student"),
      [preferenceCandidate("visual", 1)],
    );
    assert.equal(result.saved, 1);
    assert.equal(
      (await service.snapshot(privateMemoryNamespace("student")))
        ?.semanticMemories.length,
      1,
    );
  });

  it("melakukan lazy backfill sebelum correction atas primary memory lama", async () => {
    const knowledge = createService();
    const source = new SourceMemoryStore();
    const old: MemoryItem = {
      ...memory("student", "legacy-school", "Sekolah di SMAN Lama"),
      kind: "profile",
    };
    await source.save(old);
    const memories = new MemoryService(source, () => NOW, knowledge);
    const saved = await memories.remember({
      ownerId: "student",
      kind: "profile",
      content: "Sekolah di SMAN Baru",
      sourceSequences: [2],
      ...deriveMemoryMetadata(
        "profile",
        "Sekolah di SMAN Baru",
        "Ralat, aku sudah pindah sekolah ke SMAN Baru",
      ),
    });
    assert.ok(saved);
    await memories.drain();
    const state = await knowledge.snapshot(privateMemoryNamespace("student"));
    assert.equal(
      state?.semanticMemories.find((item) =>
        item.sourceMemoryIds.includes("legacy-school"))?.status,
      "superseded",
    );
    assert.equal(
      state?.semanticMemories.find((item) =>
        item.sourceMemoryIds.includes(saved.id))?.status,
      "active",
    );
  });
});

describe("semantic retrieval dan temporal graph", () => {
  it("menemukan sinonim tanpa lexical overlap melalui provider embedding terinjeksi", async () => {
    const provider = new ConceptEmbeddingProvider();
    const service = createService(provider);
    const namespace = privateMemoryNamespace("student");
    await service.consolidate(namespace, [{
      subject: "user",
      predicate: "prefers_learning_style",
      value: "diagram",
      displayText: "Lebih mudah paham lewat gambar dan skema.",
      confidence: 1,
      sourceSequences: [4],
      provenance: "asserted",
      graphProjection: {
        from: { type: "person", canonicalName: "Pengguna" },
        relation: "prefers",
        to: { type: "concept", canonicalName: "Diagram" },
      },
    }]);

    const matches = await service.searchSemantic(
      namespace,
      "metode belajar visual",
    );
    assert.equal(matches[0]?.text, "Lebih mudah paham lewat gambar dan skema.");
    assert.ok((matches[0]?.score ?? 0) > 0.9);
    assert.deepEqual(provider.calls[0], [
      "metode belajar visual",
      "Lebih mudah paham lewat gambar dan skema.",
    ]);
  });

  it("menjalankan traversal multi-hop tetapi tetap menyebut semantic source", async () => {
    const service = createService();
    const namespace = privateMemoryNamespace("student");
    await service.consolidate(namespace, [
      {
        subject: "user",
        predicate: "enrolled_in",
        value: "Matematika",
        displayText: "Mengikuti kelas Matematika.",
        sourceSequences: [1],
        provenance: "asserted",
        graphProjection: {
          from: { type: "person", canonicalName: "Pengguna" },
          relation: "enrolled_in",
          to: { type: "course", canonicalName: "Matematika" },
        },
      },
      {
        subject: "Matematika",
        predicate: "taught_by",
        value: "Pak Ardi",
        displayText: "Matematika diajar oleh Pak Ardi.",
        sourceSequences: [2],
        provenance: "asserted",
        graphProjection: {
          from: { type: "course", canonicalName: "Matematika" },
          relation: "taught_by",
          to: { type: "person", canonicalName: "Pak Ardi" },
        },
      },
    ]);

    const matches = await service.searchGraph(
      namespace,
      "siapa guru Matematika",
      { maxDepth: 3 },
    );
    const teacher = matches.find((match) => match.text.includes("Pak Ardi"));
    assert.ok(teacher);
    assert.deepEqual(teacher.sources, ["semantic", "graph"]);
    assert.deepEqual(teacher.sourceSequences, [2]);
  });

  it("membuang completion embedding yang selesai setelah scope disuspend", async () => {
    let release: (() => void) | undefined;
    const provider: TextEmbeddingProvider = {
      modelId: "delayed-semantic",
      embed: async (texts) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return texts.map(() => [1, 0]);
      },
    };
    const service = createService(provider);
    const namespace = privateMemoryNamespace("student");
    await service.consolidate(namespace, [preferenceCandidate("visual", 1)]);
    const pending = service.searchSemantic(namespace, "belajar");
    await new Promise((resolve) => setImmediate(resolve));
    service.suspend(namespace);
    release?.();
    assert.deepEqual(await pending, []);
  });

  it("membuang completion embedding yang selesai setelah forget satu source", async () => {
    let release: (() => void) | undefined;
    const provider: TextEmbeddingProvider = {
      modelId: "delayed-forget",
      embed: async (texts) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return texts.map(() => [1, 0]);
      },
    };
    const service = createService(provider);
    const item = memory("student", "delayed-source", "Suka diagram");
    await service.rememberSource(item, {
      ownerId: "student",
      kind: "preference",
      content: item.content,
      sourceSequences: [1],
    });
    const pending = service.searchSemantic(
      privateMemoryNamespace("student"),
      "diagram",
    );
    await new Promise((resolve) => setImmediate(resolve));
    await service.forgetSource(item);
    release?.();
    assert.deepEqual(await pending, []);
  });

  it("membuang vector orthogonal atau berlawanan di bawah relevance floor", async () => {
    const provider: TextEmbeddingProvider = {
      modelId: "threshold-test",
      embed: async (texts) => texts.map((text) => {
        if (text === "metode visual") return [1, 0];
        if (text.includes("diagram")) return [0.9, 0.1];
        if (text.includes("basket")) return [0, 1];
        return [-1, 0];
      }),
    };
    const service = createService(provider);
    const namespace = privateMemoryNamespace("student");
    await service.consolidate(namespace, [
      preferenceCandidate("diagram", 1),
      {
        ...preferenceCandidate("basket", 2),
        predicate: "hobby",
        displayText: "Latihan basket hari Jumat",
      },
      {
        ...preferenceCandidate("tidur", 3),
        predicate: "routine",
        displayText: "Tidur lebih awal",
      },
    ]);

    assert.deepEqual(
      (await service.searchSemantic(namespace, "metode visual")).map((item) =>
        item.text),
      ["Lebih suka belajar diagram"],
    );
  });

  it("mencari episode secara semantic walau owner belum punya knowledge file", async () => {
    const provider = new ConceptEmbeddingProvider();
    const service = createService(provider);
    const matches = await service.searchSemantic(
      privateMemoryNamespace("student"),
      "metode belajar visual",
      {
        includeHistorical: true,
        episodeDocuments: [{
          id: "ep-only:facts:0",
          episodeId: "ep-only",
          field: "facts",
          text: "Lebih mudah paham lewat gambar dan skema.",
          createdAt: "2026-07-01T00:00:00.000Z",
          sourceSequences: [1],
        }],
      },
    );
    assert.equal(matches[0]?.id, "episode:ep-only:facts:0");
    assert.equal(matches[0]?.status, "superseded");
    assert.equal(provider.calls.length, 1);
  });

  it("menyisihkan document pool untuk episode saat semantic store padat", async () => {
    const provider = new ConceptEmbeddingProvider();
    const service = createService(provider);
    const namespace = privateMemoryNamespace("student");
    for (let offset = 0; offset < 160; offset += 32) {
      await service.consolidate(
        namespace,
        Array.from({ length: 32 }, (_, index) => {
          const sequence = offset + index + 1;
          return {
            subject: "user",
            predicate: `fact_${sequence}`,
            value: `nilai ${sequence}`,
            displayText: `Catatan netral ${sequence}`,
            sourceSequences: [sequence],
            provenance: "asserted" as const,
          };
        }),
      );
    }
    const matches = await service.searchSemantic(
      namespace,
      "metode belajar visual",
      {
        includeHistorical: true,
        episodeDocuments: [{
          id: "ep-reserved:facts:0",
          episodeId: "ep-reserved",
          field: "facts",
          text: "Belajar memakai gambar dan diagram.",
          createdAt: "2026-07-01T00:00:00.000Z",
          sourceSequences: [999],
        }],
      },
    );
    assert.ok(matches.some((item) => item.id === "episode:ep-reserved:facts:0"));
  });

  it("menghormati graph maxDepth pada edge, bukan hanya node yang tercapai", async () => {
    const service = createService();
    const namespace = privateMemoryNamespace("student");
    await service.consolidate(namespace, [
      {
        subject: "Alpha",
        predicate: "linked",
        value: "Beta",
        displayText: "Alpha terhubung Beta",
        sourceSequences: [1],
        provenance: "asserted",
        graphProjection: {
          from: { type: "concept", canonicalName: "Alpha" },
          relation: "linked",
          to: { type: "concept", canonicalName: "Beta" },
        },
      },
      {
        subject: "Beta",
        predicate: "linked",
        value: "Gamma",
        displayText: "Beta terhubung Gamma",
        sourceSequences: [2],
        provenance: "asserted",
        graphProjection: {
          from: { type: "concept", canonicalName: "Beta" },
          relation: "linked",
          to: { type: "concept", canonicalName: "Gamma" },
        },
      },
    ]);
    assert.deepEqual(
      (await service.searchGraph(namespace, "Alpha", { maxDepth: 1 }))
        .map((item) => item.text),
      ["Alpha terhubung Beta"],
    );
    assert.deepEqual(
      new Set((await service.searchGraph(namespace, "Alpha", { maxDepth: 2 }))
        .map((item) => item.text)),
      new Set(["Alpha terhubung Beta", "Beta terhubung Gamma"]),
    );
  });
});

describe("suppression dan deletion cascade", () => {
  it("forget saat suspended tetap membersihkan derivative sebelum allow", async () => {
    const knowledgeStore = new MemoryKnowledgeStore();
    const knowledge = new MemoryKnowledgeService(
      knowledgeStore,
      null,
      () => NOW,
      () => "knowledge-id",
    );
    const source = new SourceMemoryStore();
    const memories = new MemoryService(source, () => NOW, knowledge);
    const saved = await memories.remember({
      ownerId: "student",
      kind: "preference",
      content: "Warna favoritku biru",
      sourceSequences: [10],
    });
    assert.ok(saved);
    await memories.drain();
    memories.suspend("student");
    assert.ok(await memories.forget("student", saved.id));
    memories.allow("student");

    assert.equal(
      (await knowledge.snapshot(privateMemoryNamespace("student")))
        ?.semanticMemories.length,
      0,
    );
    assert.deepEqual(
      await knowledge.searchGraph(
        privateMemoryNamespace("student"),
        "warna favorit biru",
      ),
      [],
    );
  });

  it("callback deletion basi tidak membuat state setelah owner full-delete", async () => {
    const service = createService();
    const item = memory("student", "mem-stale", "Suka diagram");
    await service.rememberSource(item, {
      ownerId: "student",
      kind: "preference",
      content: item.content,
      sourceSequences: [4],
    });
    await service.forgetPrivateOwner("student");
    await service.forgetSource(item);
    await service.removeEpisodeSources(
      privateMemoryNamespace("student"),
      ["episode-old"],
    );
    assert.equal(await service.snapshot(privateMemoryNamespace("student")), null);
  });

  it("menolak owner mismatch sebelum namespace mana pun dimutasi", async () => {
    const service = createService();
    const item = memory("owner-a", "mem-owner", "Suka diagram");
    await assert.rejects(service.rememberSource(item, {
      ownerId: "owner-b",
      kind: "preference",
      content: item.content,
    }), /owner/iu);
    await assert.rejects(service.editSource(
      item,
      { ...item, ownerId: "owner-b", content: "Suka audio" },
    ), /owner/iu);
    assert.equal(await service.snapshot(privateMemoryNamespace("owner-a")), null);
    assert.equal(await service.snapshot(privateMemoryNamespace("owner-b")), null);
  });

  it("edit menekan episode lama tetapi replacement tetap retrievable setelah service dibuka ulang", async () => {
    const knowledgeStore = new MemoryKnowledgeStore();
    const provider = new ConceptEmbeddingProvider();
    const knowledge = new MemoryKnowledgeService(
      knowledgeStore,
      provider,
      () => NOW,
      () => "edit-id",
    );
    const source = new SourceMemoryStore();
    const memories = new MemoryService(source, () => NOW, knowledge);
    const saved = await memories.remember({
      ownerId: "student",
      kind: "preference",
      content: "Lebih suka belajar malam",
      sourceSequences: [7],
    });
    assert.ok(saved);
    await memories.drain();
    assert.ok(await memories.edit(
      "student",
      saved.id,
      "Lebih suka belajar pagi",
    ));

    const reopened = new MemoryKnowledgeService(knowledgeStore, provider, () => NOW);
    assert.equal(
      (await reopened.searchSemantic(
        privateMemoryNamespace("student"),
        "belajar pagi",
      ))[0]?.text,
      "Lebih suka belajar pagi",
    );
    assert.deepEqual(await reopened.filterSuppressed(
      privateMemoryNamespace("student"),
      [{ text: "Lebih suka belajar malam", sourceSequences: [7] }],
    ), []);
    assert.equal(
      (await reopened.searchGraph(
        privateMemoryNamespace("student"),
        "belajar pagi",
      ))[0]?.text,
      "Lebih suka belajar pagi",
    );
  });

  it("reassertion baru tidak diracuni tombstone episode lama", async () => {
    const service = createService();
    const first = memory("student", "old-source", "Suka diagram");
    const second = memory("student", "new-source", "Suka diagram");
    await service.rememberSource(first, {
      ownerId: "student",
      kind: "preference",
      content: first.content,
      sourceSequences: [1],
    });
    await service.forgetSource(first);
    await service.rememberSource(second, {
      ownerId: "student",
      kind: "preference",
      content: second.content,
      sourceSequences: [2],
    });
    assert.equal(
      (await service.searchGraph(
        privateMemoryNamespace("student"),
        "suka diagram",
      )).length,
      1,
    );
  });

  it("menghapus satu dari dua episode juga membuang sequence pasangannya", async () => {
    const service = createService();
    const namespace = privateMemoryNamespace("student");
    await service.consolidate(namespace, [{
      subject: "user",
      predicate: "studies_at",
      value: "SMAN A",
      displayText: "Sekolah di SMAN A",
      provenance: "asserted",
      sourceEpisodeIds: ["ep-1", "ep-2"],
      sourceSequences: [1, 2],
    }]);
    await service.removeEpisodeSources(namespace, ["ep-1"]);
    const remaining = (await service.snapshot(namespace))?.semanticMemories[0];
    assert.deepEqual(remaining?.sourceEpisodes, ["ep-2"]);
    assert.deepEqual(remaining?.sourceSequences, [2]);
  });

  it("mempertahankan graph selama masih ada provenance source lain", async () => {
    const service = createService();
    const first = memory("student", "mem-1", "Warna favoritku biru");
    const second = memory("student", "mem-2", "Warna favoritku biru");
    await service.rememberSource(first, {
      ownerId: "student",
      kind: "preference",
      content: first.content,
      sourceSequences: [10],
    });
    await service.rememberSource(second, {
      ownerId: "student",
      kind: "preference",
      content: second.content,
      sourceSequences: [11],
    });
    const namespace = privateMemoryNamespace("student");
    assert.deepEqual(
      (await service.snapshot(namespace))?.relations[0]?.sourceMemoryIds,
      ["mem-1", "mem-2"],
    );

    await service.forgetSource(first);
    const retained = await service.snapshot(namespace);
    assert.equal(retained?.semanticMemories.length, 1);
    assert.equal(retained?.relations.length, 1);
    assert.deepEqual(retained?.relations[0]?.sourceMemoryIds, ["mem-2"]);
    assert.deepEqual(retained?.relations[0]?.sourceSequences, [11]);
    assert.equal(
      (await service.searchGraph(namespace, "warna favorit biru")).length,
      1,
    );

    await service.forgetSource(second);
    const removed = await service.snapshot(namespace);
    assert.equal(removed?.semanticMemories.length, 0);
    assert.equal(removed?.relations.length, 0);
  });

  it("forget satu fakta tidak menekan fakta lain pada sequence yang sama", async () => {
    const service = createService();
    const first = memory("student", "mem-a", "Suka diagram");
    const second = memory("student", "mem-b", "Alergi kacang");
    await service.rememberSource(first, {
      ownerId: "student",
      kind: "preference",
      content: first.content,
      sourceSequences: [10],
    });
    await service.rememberSource(second, {
      ownerId: "student",
      kind: "personal",
      content: second.content,
      sourceSequences: [10],
      sensitiveConsent: true,
    });
    await service.forgetSource(first);
    assert.equal(
      (await service.searchGraph(
        privateMemoryNamespace("student"),
        "alergi kacang",
      )).length,
      1,
    );
    assert.equal(
      (await service.filterSuppressed(privateMemoryNamespace("student"), [{
        text: second.content,
        sourceSequences: [10],
        sourceMemoryIds: [second.id],
      }])).length,
      1,
    );
  });

  it("edit derivative gagal atomik tanpa meninggalkan tombstone parsial", async () => {
    const store = new FailableMemoryKnowledgeStore();
    const service = new MemoryKnowledgeService(store, null, () => NOW, () => "edit-cas");
    const previous = memory("student", "mem-edit", "Sekolah di SMAN Lama");
    await service.rememberSource(previous, {
      ownerId: "student",
      kind: "profile",
      content: previous.content,
      sourceSequences: [1],
      ...deriveMemoryMetadata("profile", previous.content, previous.content),
    });
    store.failNext = true;
    await assert.rejects(service.editSource(
      previous,
      { ...previous, content: "Sekolah di SMAN Baru" },
      {
        ownerId: "student",
        kind: "profile",
        content: "Sekolah di SMAN Baru",
        ...deriveMemoryMetadata("profile", "Sekolah di SMAN Baru", "Sekolah di SMAN Baru"),
        correction: true,
      },
    ), /write gagal/iu);
    const state = await service.snapshot(privateMemoryNamespace("student"));
    assert.equal(state?.semanticMemories[0]?.displayText, "Sekolah di SMAN Lama");
    assert.equal(state?.suppressions.length, 0);
  });

  it("edit saat suspended memperbarui semantic dan target graph sesudah allow", async () => {
    const knowledge = createService();
    const source = new SourceMemoryStore();
    const memories = new MemoryService(source, () => NOW, knowledge);
    const saved = await memories.remember({
      ownerId: "student",
      kind: "profile",
      content: "Sekolah di SMAN Lama",
      sourceSequences: [1],
      ...deriveMemoryMetadata("profile", "Sekolah di SMAN Lama", "Sekolah di SMAN Lama"),
    });
    assert.ok(saved);
    await memories.drain();
    memories.suspend("student");
    assert.ok(await memories.edit("student", saved.id, "Sekolah di SMAN Baru"));
    memories.allow("student");
    const graph = await knowledge.searchGraph(
      privateMemoryNamespace("student"),
      "SMAN Baru",
    );
    assert.equal(graph[0]?.text, "Sekolah di SMAN Baru");
    const state = await knowledge.snapshot(privateMemoryNamespace("student"));
    const target = state?.entities.find((entity) =>
      entity.id === state.relations[0]?.toEntityId);
    assert.equal(target?.canonicalName, "SMAN Baru");
  });

  it("forget one menghapus semantic/edge dan menekan episode legacy serupa", async () => {
    const service = createService();
    const item = memory("student", "mem-1", "Warna favoritku biru");
    await service.rememberSource(item, {
      ownerId: "student",
      kind: "preference",
      content: item.content,
      sourceSequences: [10],
    });
    const namespace = privateMemoryNamespace("student");
    assert.equal((await service.snapshot(namespace))?.relations.length, 1);

    await service.forgetSource(item);
    const state = await service.snapshot(namespace);
    assert.equal(state?.semanticMemories.length, 0);
    assert.equal(state?.relations.length, 0);
    assert.equal(state?.suppressions.length, 1);
    const filtered = await service.filterSuppressed(namespace, [
      {
        text: "Pengguna menyukai warna biru.",
        sourceSequences: [999],
      },
      {
        text: "Pengguna menyukai warna hijau.",
        sourceSequences: [11],
      },
      {
        text: "Klaim lain pada episode yang sama.",
        sourceSequences: [12],
      },
    ]);
    assert.deepEqual(filtered.map((entry) => entry.text), [
      "Pengguna menyukai warna hijau.",
      "Klaim lain pada episode yang sama.",
    ]);
  });

  it("suppression dan forget-all tidak memengaruhi owner lain", async () => {
    const service = createService();
    const first = memory("first", "same", "Suka diagram");
    const second = memory("second", "same", "Suka diagram");
    await service.rememberSource(first, {
      ownerId: "first",
      kind: "preference",
      content: first.content,
      sourceSequences: [1],
    });
    await service.rememberSource(second, {
      ownerId: "second",
      kind: "preference",
      content: second.content,
      sourceSequences: [1],
    });
    await service.forgetSource(first);
    assert.deepEqual(
      await service.filterSuppressed(privateMemoryNamespace("first"), [
        { text: "Suka diagram", sourceSequences: [1] },
      ]),
      [],
    );
    assert.equal(
      (await service.filterSuppressed(privateMemoryNamespace("second"), [
        { text: "Suka diagram", sourceSequences: [1] },
      ])).length,
      1,
    );
    await service.forgetPrivateOwner("first");
    assert.equal(await service.snapshot(privateMemoryNamespace("first")), null);
    assert.ok(await service.snapshot(privateMemoryNamespace("second")));
  });

});

class ConceptEmbeddingProvider implements TextEmbeddingProvider {
  readonly modelId = "test-semantic";
  readonly calls: string[][] = [];

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (/visual|gambar|diagram|skema/u.test(normalized)) return [1, 0, 0];
      if (/audio|dengar/u.test(normalized)) return [0, 1, 0];
      return [0, 0, 1];
    });
  }
}

class MemoryKnowledgeStore implements MemoryKnowledgeRepository {
  readonly states = new Map<string, MemoryKnowledgeState>();

  async load(namespace: MemoryKnowledgeNamespace): Promise<MemoryKnowledgeState | null> {
    const state = this.states.get(key(namespace));
    return state ? structuredClone(state) : null;
  }

  async save(
    state: MemoryKnowledgeState,
    expectedRevision: number | null,
  ): Promise<"saved" | "conflict"> {
    const current = this.states.get(key(state.namespace));
    if (
      (expectedRevision === null && current) ||
      (expectedRevision !== null && current?.revision !== expectedRevision)
    ) {
      return "conflict";
    }
    this.states.set(key(state.namespace), structuredClone(state));
    return "saved";
  }

  async remove(namespace: MemoryKnowledgeNamespace): Promise<boolean> {
    return this.states.delete(key(namespace));
  }
}

class ConflictOnceKnowledgeStore extends MemoryKnowledgeStore {
  private conflict = true;

  override async save(
    state: MemoryKnowledgeState,
    expectedRevision: number | null,
  ): Promise<"saved" | "conflict"> {
    if (this.conflict) {
      this.conflict = false;
      return "conflict";
    }
    return super.save(state, expectedRevision);
  }
}

class FailableMemoryKnowledgeStore extends MemoryKnowledgeStore {
  failNext = false;

  override async save(
    state: MemoryKnowledgeState,
    expectedRevision: number | null,
  ): Promise<"saved" | "conflict"> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("write gagal");
    }
    return super.save(state, expectedRevision);
  }
}

class SourceMemoryStore implements MemoryRepository {
  private readonly items = new Map<string, MemoryItem>();

  async save(item: MemoryItem): Promise<void> {
    this.items.set(`${item.ownerId}:${item.id}`, structuredClone(item));
  }

  async list(ownerId: string): Promise<MemoryItem[]> {
    return [...this.items.values()]
      .filter((item) => item.ownerId === ownerId)
      .map((item) => structuredClone(item));
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    return this.items.delete(`${ownerId}:${id}`);
  }

  async removeAll(ownerId: string): Promise<number> {
    const before = this.items.size;
    for (const [key, item] of this.items) {
      if (item.ownerId === ownerId) this.items.delete(key);
    }
    return before - this.items.size;
  }
}

function createService(
  provider: TextEmbeddingProvider | null = null,
): MemoryKnowledgeService {
  let sequence = 0;
  return new MemoryKnowledgeService(
    new MemoryKnowledgeStore(),
    provider,
    () => NOW,
    () => `id-${sequence += 1}`,
  );
}

function schoolCandidate(
  school: string,
  sequence: number,
  validFrom: string,
): MemoryConsolidationCandidate {
  return {
    subject: "user",
    predicate: "studies_at",
    value: school,
    displayText: `Sekolah di ${school}`,
    confidence: 1,
    validFrom,
    sourceSequences: [sequence],
    provenance: "asserted",
    graphProjection: {
      from: { type: "person", canonicalName: "Pengguna" },
      relation: "studies_at",
      to: { type: "place", canonicalName: school },
    },
  };
}

function preferenceCandidate(
  value: string,
  sequence: number,
): MemoryConsolidationCandidate {
  return {
    subject: "user",
    predicate: "prefers_learning_style",
    value,
    displayText: `Lebih suka belajar ${value}`,
    confidence: 1,
    sourceSequences: [sequence],
    provenance: "asserted",
  };
}

function memory(ownerId: string, id: string, content: string): MemoryItem {
  return {
    id,
    ownerId,
    kind: "preference",
    content,
    createdAt: NOW.toISOString(),
    lastUsedAt: null,
    expiresAt: null,
  };
}

function key(namespace: MemoryKnowledgeNamespace): string {
  return JSON.stringify(namespace);
}
