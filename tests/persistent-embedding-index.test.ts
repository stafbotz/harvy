import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { MemoryKnowledgeService, memoryContentHash } from
  "../src/core/memory-knowledge-service.js";
import { privateMemoryNamespace } from "../src/core/memory-namespace.js";
import type {
  MemoryKnowledgeNamespace,
  MemoryKnowledgeRepository,
  MemoryKnowledgeState,
  TextEmbeddingProvider,
} from "../src/domain/memory-knowledge.js";
import type { MemoryItem } from "../src/domain/memory.js";
import { SqliteLongTermMemoryRepository } from
  "../src/storage/sqlite-long-term-memory-repository.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("persistent derived embedding index", () => {
  it("meng-embed document sekali per content hash+model dan bertahan restart", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "long-term.sqlite");
    const knowledgeRepository = new KnowledgeRepository();
    let index = new SqliteLongTermMemoryRepository(file);
    let provider = new CountingEmbeddingProvider("embedding-v1");
    let service = new MemoryKnowledgeService(
      knowledgeRepository,
      provider,
      fixedClock,
      () => "one",
      index,
    );
    const namespace = privateMemoryNamespace("owner-a");
    await service.consolidate(namespace, [{
      subject: "project",
      predicate: "deployment_workflow",
      value: "push then deploy",
      displayText: "Workflow deploy: push branch lalu jalankan deploy.",
      confidence: 1,
      validFrom: fixedClock().toISOString(),
      sourceMemoryId: "memory-a",
      provenance: "asserted",
    }]);

    const first = await service.searchSemantic(namespace, "workflow deploy", {
      limit: 4,
    });
    assert.equal(first.length, 1);
    assert.deepEqual(provider.batchSizes, [2], "query + satu cache miss");
    await service.searchSemantic(namespace, "workflow deploy", { limit: 4 });
    assert.deepEqual(provider.batchSizes, [2, 1], "query saja saat cache hit");

    const sourceId = first[0]!.id;
    const document = {
      sourceId,
      contentHash: memoryContentHash(first[0]!.text),
      text: first[0]!.text,
    };
    assert.equal((await index.load(namespace, provider, [document])).size, 1);
    index.close();

    index = new SqliteLongTermMemoryRepository(file);
    provider = new CountingEmbeddingProvider("embedding-v1");
    service = new MemoryKnowledgeService(
      knowledgeRepository,
      provider,
      fixedClock,
      () => "two",
      index,
    );
    await service.searchSemantic(namespace, "workflow deploy", { limit: 4 });
    assert.deepEqual(provider.batchSizes, [1], "document cache survives restart");

    await service.forgetSource(memoryItem());
    assert.equal((await index.load(namespace, provider, [document])).size, 0);
    assert.deepEqual(
      await service.searchSemantic(namespace, "workflow deploy", { limit: 4 }),
      [],
    );
    index.close();
  });

  it("tidak memakai vector model lama setelah identity model berubah", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "long-term.sqlite");
    const index = new SqliteLongTermMemoryRepository(file);
    const namespace = privateMemoryNamespace("owner-a");
    const document = {
      sourceId: "semantic:one",
      contentHash: memoryContentHash("isi"),
      text: "isi",
    };
    const first = new CountingEmbeddingProvider("embedding-v1");
    const second = new CountingEmbeddingProvider("embedding-v2");
    await index.store(namespace, first, [document], [[1, 0]]);

    assert.equal((await index.load(namespace, first, [document])).size, 1);
    assert.equal((await index.load(namespace, second, [document])).size, 0);
    index.close();
  });
});

class CountingEmbeddingProvider implements TextEmbeddingProvider {
  readonly batchSizes: number[] = [];

  constructor(readonly modelId: string) {}

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.batchSizes.push(texts.length);
    return texts.map(() => [1, 0]);
  }
}

class KnowledgeRepository implements MemoryKnowledgeRepository {
  private state: MemoryKnowledgeState | null = null;

  async load(namespace: MemoryKnowledgeNamespace): Promise<MemoryKnowledgeState | null> {
    if (!this.state) return null;
    assert.deepEqual(this.state.namespace, namespace);
    return structuredClone(this.state);
  }

  async save(
    state: MemoryKnowledgeState,
    expectedRevision: number | null,
  ): Promise<"saved" | "conflict"> {
    if ((this.state?.revision ?? null) !== expectedRevision) return "conflict";
    this.state = structuredClone(state);
    return "saved";
  }

  async remove(): Promise<boolean> {
    const existed = this.state !== null;
    this.state = null;
    return existed;
  }
}

function memoryItem(): MemoryItem {
  return {
    id: "memory-a",
    ownerId: "owner-a",
    kind: "context",
    content: "Workflow deploy: push branch lalu jalankan deploy.",
    createdAt: fixedClock().toISOString(),
    lastUsedAt: null,
    expiresAt: null,
  };
}

function fixedClock(): Date {
  return new Date("2026-08-21T00:00:00.000Z");
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harvy-embedding-"));
  temporaryDirectories.push(directory);
  return directory;
}
