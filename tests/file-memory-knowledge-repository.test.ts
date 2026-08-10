import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  groupMemoryNamespace,
  privateMemoryNamespace,
  projectMemoryNamespace,
} from "../src/core/memory-namespace.js";
import { MemoryKnowledgeService } from "../src/core/memory-knowledge-service.js";
import { deriveMemoryMetadata } from "../src/core/memory-candidate.js";
import type { MemoryItem } from "../src/domain/memory.js";
import type {
  MemoryKnowledgeNamespace,
  MemoryKnowledgeState,
} from "../src/domain/memory-knowledge.js";
import { FileMemoryKnowledgeRepository } from "../src/storage/file-memory-knowledge-repository.js";

const AT = "2026-08-09T10:00:00.000Z";

describe("file memory knowledge repository", () => {
  it("mengisolasi private, group, dan project secara fisik", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-memory-knowledge-"));
    const repository = new FileMemoryKnowledgeRepository(root);
    const privateScope = privateMemoryNamespace("same-id");
    const groupScope = groupMemoryNamespace("same-id", "same-id");
    const projectScope = projectMemoryNamespace("same-id", "same-id");

    await repository.save(state(privateScope), null);
    await repository.save(state(groupScope), null);
    await repository.save(state(projectScope), null);

    assert.equal((await repository.load(privateScope))?.namespace.kind, "private");
    assert.equal((await repository.load(groupScope))?.namespace.kind, "group");
    assert.equal((await repository.load(projectScope))?.namespace.kind, "project");
    assert.deepEqual((await readdir(root)).sort(), ["group", "private", "project"]);
    for (const kind of ["private", "group", "project"] as const) {
      const names = await readdir(join(root, kind));
      assert.equal(names.length, 1);
      assert.match(names[0] ?? "", /^[a-f0-9]{48}\.json$/u);
      assert.doesNotMatch(names[0] ?? "", /same-id/u);
    }
  });

  it("menegakkan CAS dan penghapusan hanya pada namespace target", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-memory-knowledge-"));
    const repository = new FileMemoryKnowledgeRepository(root);
    const first = privateMemoryNamespace("first");
    const second = privateMemoryNamespace("second");
    assert.equal(await repository.save(state(first), null), "saved");
    assert.equal(await repository.save(state(second), null), "saved");

    const next = state(first, 2);
    assert.equal(await repository.save(next, 1), "saved");
    assert.equal(await repository.save(next, 1), "conflict");
    assert.equal(await repository.remove(first), true);
    assert.equal(await repository.remove(first), false);
    assert.equal(await repository.load(first), null);
    assert.ok(await repository.load(second));
  });

  it("menolak file dengan namespace yang tidak cocok dengan nama hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-memory-knowledge-"));
    const repository = new FileMemoryKnowledgeRepository(root);
    const namespace = privateMemoryNamespace("owner-a");
    await repository.save(state(namespace), null);
    const [name] = await readdir(join(root, "private"));
    const path = join(root, "private", name!);
    const parsed = JSON.parse(await readFile(path, "utf8")) as MemoryKnowledgeState;
    parsed.namespace = privateMemoryNamespace("owner-b");
    await writeFile(path, JSON.stringify(parsed), "utf8");
    await assert.rejects(
      repository.load(namespace),
      /namespace.*tidak cocok/iu,
    );
  });

  it("mempertahankan suppression setelah repository dibuka ulang", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-memory-knowledge-"));
    const item: MemoryItem = {
      id: "mem-1",
      ownerId: "owner-a",
      kind: "preference",
      content: "Warna favoritku biru",
      createdAt: AT,
      lastUsedAt: null,
      expiresAt: null,
    };
    const first = new MemoryKnowledgeService(
      new FileMemoryKnowledgeRepository(root),
      null,
      () => new Date(AT),
      () => "first-id",
    );
    await first.rememberSource(item, {
      ownerId: item.ownerId,
      kind: item.kind,
      content: item.content,
      sourceSequences: [7],
    });
    await first.forgetSource(item);

    const reopened = new MemoryKnowledgeService(
      new FileMemoryKnowledgeRepository(root),
      null,
      () => new Date(AT),
      () => "reopened-id",
    );
    assert.deepEqual(
      await reopened.filterSuppressed(privateMemoryNamespace("owner-a"), [
        { text: "Pengguna menyukai warna biru.", sourceSequences: [99] },
      ]),
      [],
    );
    assert.equal(
      (await reopened.snapshot(privateMemoryNamespace("owner-a")))
        ?.suppressions.length,
      1,
    );
  });

  it("full delete juga membersihkan orphan temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-memory-knowledge-"));
    const repository = new FileMemoryKnowledgeRepository(root);
    const namespace = privateMemoryNamespace("owner-a");
    await repository.save(state(namespace), null);
    const [name] = await readdir(join(root, "private"));
    const finalPath = join(root, "private", name!);
    assert.equal(await repository.remove(namespace), true);
    await writeFile(`${finalPath}.tmp`, "raw semantic content", "utf8");

    assert.equal(await repository.remove(namespace), true);
    assert.deepEqual(await readdir(join(root, "private")), []);
  });

  it("menolak nested owner dan aggregate provenance yang tidak cocok", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-memory-knowledge-"));
    const namespace = privateMemoryNamespace("owner-a");
    const repository = new FileMemoryKnowledgeRepository(root);
    const service = new MemoryKnowledgeService(
      repository,
      null,
      () => new Date(AT),
      () => "nested-id",
    );
    const item: MemoryItem = {
      id: "mem-owner",
      ownerId: "owner-a",
      kind: "preference",
      content: "Suka diagram",
      createdAt: AT,
      lastUsedAt: null,
      expiresAt: null,
    };
    await service.rememberSource(item, {
      ownerId: item.ownerId,
      kind: item.kind,
      content: item.content,
      sourceSequences: [7],
    });
    const [name] = await readdir(join(root, "private"));
    const path = join(root, "private", name!);
    const original = JSON.parse(await readFile(path, "utf8")) as MemoryKnowledgeState;

    const wrongOwner = structuredClone(original);
    wrongOwner.semanticMemories[0]!.ownerId = "owner-b";
    await writeFile(path, JSON.stringify(wrongOwner), "utf8");
    await assert.rejects(repository.load(namespace), /Semantic memory/iu);

    const wrongProvenance = structuredClone(original);
    wrongProvenance.semanticMemories[0]!.sourceSequences = [99];
    await writeFile(path, JSON.stringify(wrongProvenance), "utf8");
    await assert.rejects(repository.load(namespace), /provenance/iu);
  });

  it("mempertahankan semantic dan graph edit setelah restart lalu menghapusnya penuh", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-memory-knowledge-"));
    const namespace = privateMemoryNamespace("owner-a");
    const repository = new FileMemoryKnowledgeRepository(root);
    const service = new MemoryKnowledgeService(
      repository,
      null,
      () => new Date(AT),
      () => "edit-file-id",
    );
    const previous: MemoryItem = {
      id: "mem-edit",
      ownerId: "owner-a",
      kind: "preference",
      content: "Suka belajar malam",
      createdAt: AT,
      lastUsedAt: null,
      expiresAt: null,
    };
    await service.rememberSource(previous, {
      ownerId: previous.ownerId,
      kind: previous.kind,
      content: previous.content,
      sourceSequences: [8],
    });
    await service.editSource(previous, {
      ...previous,
      content: "Suka belajar pagi",
    });

    const reopened = new MemoryKnowledgeService(
      new FileMemoryKnowledgeRepository(root),
      null,
      () => new Date(AT),
    );
    const snapshot = await reopened.snapshot(namespace);
    assert.equal(snapshot?.semanticMemories[0]?.displayText, "Suka belajar pagi");
    assert.equal(snapshot?.relations[0]?.scalarValue, "Suka belajar pagi");
    await reopened.forgetPrivateOwner("owner-a");
    assert.equal(
      await new FileMemoryKnowledgeRepository(root).load(namespace),
      null,
    );
  });

  it("menolak relation yang tidak cocok dengan graph projection sumber", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-memory-knowledge-"));
    const namespace = privateMemoryNamespace("owner-a");
    const repository = new FileMemoryKnowledgeRepository(root);
    const service = new MemoryKnowledgeService(
      repository,
      null,
      () => new Date(AT),
      () => randomUUID(),
    );
    for (const [id, content] of [
      ["school", "Sekolah di SMAN A"],
      ["teacher", "Matematika diajar oleh Bu Rina"],
    ] as const) {
      const item: MemoryItem = {
        id,
        ownerId: "owner-a",
        kind: "profile",
        content,
        createdAt: AT,
        lastUsedAt: null,
        expiresAt: null,
      };
      await service.rememberSource(item, {
        ownerId: item.ownerId,
        kind: item.kind,
        content,
        sourceSequences: [id === "school" ? 1 : 2],
        ...deriveMemoryMetadata(item.kind, content, content),
      });
    }
    const [name] = await readdir(join(root, "private"));
    const path = join(root, "private", name!);
    const parsed = JSON.parse(await readFile(path, "utf8")) as MemoryKnowledgeState;
    assert.equal(parsed.relations.length, 2);
    parsed.relations[0]!.toEntityId = parsed.relations[1]!.toEntityId;
    await writeFile(path, JSON.stringify(parsed), "utf8");
    await assert.rejects(repository.load(namespace), /Relation memory/iu);
  });

  it("membatasi term hash tanpa membuat forget input 200 karakter gagal", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-memory-knowledge-"));
    const repository = new FileMemoryKnowledgeRepository(root);
    const service = new MemoryKnowledgeService(
      repository,
      null,
      () => new Date(AT),
      () => "long-forget-id",
    );
    const content = Array.from({ length: 65 }, (_, index) =>
      `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`)
      .join(" ");
    assert.ok(content.length <= 200);
    const item: MemoryItem = {
      id: "long-memory",
      ownerId: "owner-a",
      kind: "context",
      content,
      createdAt: AT,
      lastUsedAt: null,
      expiresAt: null,
    };
    await service.rememberSource(item, {
      ownerId: item.ownerId,
      kind: item.kind,
      content,
      sourceSequences: [7],
    });
    await service.forgetSource(item);
    const suppression = (await service.snapshot(privateMemoryNamespace("owner-a")))
      ?.suppressions[0];
    assert.equal(suppression?.termHashes.length, 64);
  });

  it("tidak menolak atau memotong tombstone ke-1025", async () => {
    const root = await mkdtemp(join(tmpdir(), "harvy-memory-knowledge-"));
    const repository = new FileMemoryKnowledgeRepository(root);
    const namespace = privateMemoryNamespace("owner-a");
    const value = state(namespace);
    value.suppressions = Array.from({ length: 1_025 }, (_, index) => ({
      id: `suppression-${index}`,
      sourceMemoryId: `memory-${index}`,
      contentHash: index.toString(16).padStart(64, "0"),
      termHashes: [],
      sourceEpisodeIds: [],
      sourceSequences: [index + 1],
      createdAt: AT,
      reason: "forgotten" as const,
    }));
    assert.equal(await repository.save(value, null), "saved");
    assert.equal((await repository.load(namespace))?.suppressions.length, 1_025);
  });
});

function state(
  namespace: MemoryKnowledgeNamespace,
  revision = 1,
): MemoryKnowledgeState {
  return {
    schemaVersion: 1,
    namespace,
    revision,
    semanticMemories: [],
    entities: [],
    relations: [],
    suppressions: [],
    updatedAt: AT,
  };
}
