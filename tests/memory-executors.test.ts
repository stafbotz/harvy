import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createMemoryAgentExecutors,
  HistorySearchExecutor,
  MemoryListExecutor,
  MemoryRememberExecutor,
  type AgentConsentReader,
  type AgentHistorySearch,
  type AgentMemoryStore,
} from "../src/agent/memory-executors.js";
import { privateConversationAuthorizationPolicy } from "../src/ai/conversation.js";
import { RunBudgetAccount } from "../src/core/run-budget.js";
import { createHarvyCapabilityCatalog } from "../src/harness/capabilities.js";
import type { AgentExecutionContext } from "../src/harness/agent-harness.js";
import type { CapabilitySnapshotEntry } from "../src/harness/capabilities.js";
import type { HistoricalEpisodeMatch } from "../src/domain/history.js";
import type { MemoryItem, NewMemory } from "../src/domain/memory.js";
import {
  groupAgentScope,
  privateAgentScope,
} from "../src/harness/scope.js";

describe("tool ingatan dan pencarian riwayat", () => {
  it("mencari riwayat sendiri dan menandai hasilnya bukan pencarian web", async () => {
    const queries: { query: string; limit: number | undefined }[] = [];
    const executor = new HistorySearchExecutor(
      () => ({
        search: async (_ownerId, query, options) => {
          queries.push({ query, limit: options?.limit });
          return [match("ep-1", "Ujian biologi pekan depan.")];
        },
      }),
      consented(),
    );

    const validated = executor.validate({ query: "  biologi  ", limit: 2 });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    assert.equal(validated.value.query, "biologi");

    const result = await executor.execute(validated.value, context("siswa"));
    assert.equal(result.status, "ok");
    const payload = JSON.parse(result.summary) as {
      externalSearch: boolean;
      trust: string;
      total: number;
      matches: { episodeId: string; claims: { text: string }[] }[];
    };
    // Model harus melihat bahwa sumbernya riwayat Harvy sendiri, supaya ia
    // tidak menjanjikan hasil internet yang memang tidak pernah ada.
    assert.equal(payload.externalSearch, false);
    assert.equal(payload.trust, "user-authored-data");
    assert.equal(payload.total, 1);
    assert.equal(payload.matches[0]?.episodeId, "ep-1");
    assert.equal(payload.matches[0]?.claims[0]?.text, "Ujian biologi pekan depan.");
    assert.deepEqual(queries, [{ query: "biologi", limit: 2 }]);
  });

  it("menolak query kosong dan limit di luar rentang", () => {
    const executor = new HistorySearchExecutor(
      () => ({ search: async () => [] }),
      consented(),
    );
    assert.equal(executor.validate({ query: " " }).ok, false);
    assert.equal(executor.validate({ query: "biologi", limit: 0 }).ok, false);
    assert.equal(executor.validate({ query: "biologi", limit: 99 }).ok, false);
    assert.equal(
      executor.validate({ query: "biologi", sumber: "web" }).ok,
      false,
    );
  });

  it("menyimpan catatan lalu mengembalikan buktinya", async () => {
    const store = memoryStore();
    const executor = new MemoryRememberExecutor(store, consented());
    const validated = executor.validate({
      kind: "preference",
      content: "  Lebih suka penjelasan lewat contoh soal.  ",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const result = await executor.execute(validated.value, context("siswa"));
    assert.equal(result.status, "ok");
    const payload = JSON.parse(result.summary) as {
      changed: boolean;
      note: { kind: string; content: string };
    };
    assert.equal(payload.changed, true);
    assert.equal(payload.note.kind, "preference");
    assert.equal(
      payload.note.content,
      "Lebih suka penjelasan lewat contoh soal.",
    );
    assert.equal(store.saved.length, 1);
    // Authority jenis sensitif milik boundary adapter; tool tidak pernah
    // mengaku sudah mendapat persetujuannya.
    assert.equal(store.saved[0]?.sensitiveConsent, undefined);
  });

  it("tidak menawarkan jenis sensitif pada schema maupun validator", () => {
    const executor = new MemoryRememberExecutor(memoryStore(), consented());
    const properties = executor.nativeTool.inputSchema.properties as {
      kind: { enum: string[] };
    };
    assert.deepEqual(properties.kind.enum, [
      "profile",
      "preference",
      "routine",
      "context",
    ]);
    const validated = executor.validate({
      kind: "personal",
      content: "Sedang bertengkar dengan orang tua.",
    });
    assert.equal(validated.ok, false);
    if (validated.ok) return;
    assert.match(validated.reason, /sensitif tidak dapat disimpan/u);
  });

  it("membedakan catatan yang sudah diketahui dari yang gagal disimpan", async () => {
    const known = memoryStore([note("m1", "Kelas 11 IPA.")]);
    const duplicate = new MemoryRememberExecutor(known, consented());
    const validatedDuplicate = duplicate.validate({
      kind: "profile",
      content: "kelas 11 ipa.",
    });
    assert.equal(validatedDuplicate.ok, true);
    if (!validatedDuplicate.ok) return;
    const duplicateResult = await duplicate.execute(
      validatedDuplicate.value,
      context("siswa"),
    );
    assert.equal(duplicateResult.status, "ok");
    const duplicatePayload = JSON.parse(duplicateResult.summary) as {
      changed: boolean;
      reason: string;
    };
    assert.equal(duplicatePayload.changed, false);
    assert.equal(duplicatePayload.reason, "already_known");

    const rejecting: AgentMemoryStore = {
      remember: async () => null,
      list: async () => [],
    };
    const blocked = new MemoryRememberExecutor(rejecting, consented());
    const validatedBlocked = blocked.validate({
      kind: "context",
      content: "Token rahasia yang ditolak service.",
    });
    assert.equal(validatedBlocked.ok, true);
    if (!validatedBlocked.ok) return;
    const blockedResult = await blocked.execute(
      validatedBlocked.value,
      context("siswa"),
    );
    // Penolakan wajib terbaca sebagai kegagalan supaya Harvy tidak mengaku
    // sudah mengingat sesuatu yang tidak pernah tersimpan.
    assert.equal(blockedResult.status, "error");
    assert.match(blockedResult.summary, /Jangan menyatakan sudah mengingatnya/u);
  });

  it("membaca catatan tersimpan milik pemilik scope", async () => {
    const executor = new MemoryListExecutor(
      memoryStore([note("m1", "Kelas 11 IPA."), note("m2", "Belajar pagi.")]),
      consented(),
    );
    const validated = executor.validate({});
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const result = await executor.execute(validated.value, context("siswa"));
    const payload = JSON.parse(result.summary) as {
      total: number;
      notes: { content: string }[];
    };
    assert.equal(payload.total, 2);
    assert.deepEqual(
      payload.notes.map((entry) => entry.content),
      ["Kelas 11 IPA.", "Belajar pagi."],
    );
  });

  it("gagal tertutup di luar ruang privat, tanpa consent, dan saat status tak terbaca", async () => {
    const store = memoryStore();
    const executor = new MemoryRememberExecutor(store, consented());
    const validated = executor.validate({
      kind: "profile",
      content: "Kelas 11 IPA.",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const inGroup = await executor.execute(validated.value, {
      ...context("siswa"),
      scope: groupAgentScope("whatsapp", "grup", "siswa"),
    });
    assert.equal(inGroup.status, "error");
    assert.match(inGroup.summary, /ruang privat/u);

    const withoutConsent = new MemoryRememberExecutor(store, {
      needsOnboarding: async () => true,
    });
    const denied = await withoutConsent.execute(validated.value, context("siswa"));
    assert.equal(denied.status, "error");
    assert.match(denied.summary, /Persetujuan penyimpanan belum aktif/u);

    const unreadable = new MemoryRememberExecutor(store, {
      needsOnboarding: async () => {
        throw new Error("berkas profil tidak terbaca");
      },
    });
    const unknown = await unreadable.execute(validated.value, context("siswa"));
    assert.equal(unknown.status, "unknown");
    assert.equal(store.saved.length, 0);
  });

  it("hanya tersedia ketika executor recall benar-benar dipasang", () => {
    const scope = privateAgentScope("telegram", "siswa");
    const off = createHarvyCapabilityCatalog({}).snapshot(scope);
    const on = createHarvyCapabilityCatalog({ recallToolsInstalled: true })
      .snapshot(scope);
    for (const id of ["history.search", "memory.list", "memory.remember"]) {
      assert.equal(
        off.entries.find((entry) => entry.id === id)?.available,
        false,
        `${id} tidak boleh tersedia tanpa executor`,
      );
      assert.equal(
        on.entries.find((entry) => entry.id === id)?.available,
        true,
        `${id} seharusnya tersedia setelah dipasang`,
      );
    }
    // Ruang grup tidak pernah melihat catatan privat.
    const group = createHarvyCapabilityCatalog({ recallToolsInstalled: true })
      .snapshot(groupAgentScope("whatsapp", "grup", "siswa"));
    assert.equal(
      group.entries.find((entry) => entry.id === "memory.remember")?.available,
      false,
    );
  });

  it("membentuk ketiga executor dengan capability yang diharapkan", () => {
    const executors = createMemoryAgentExecutors({
      history: () => ({ search: async () => [] }),
      memories: memoryStore(),
      profiles: consented(),
    });
    assert.deepEqual(
      executors.map((executor) => executor.capabilityId),
      ["history.search", "memory.list", "memory.remember"],
    );
    assert.deepEqual(
      executors.map((executor) => executor.nativeTool?.name),
      [
        "harvy_history_search_v1",
        "harvy_memory_list_v1",
        "harvy_memory_remember_v1",
      ],
    );
  });

  it("mengizinkan tulis catatan tanpa giliran approval terpisah", async () => {
    const decision = await privateConversationAuthorizationPolicy()({
      scope: privateAgentScope("telegram", "siswa"),
      capability: capability("memory.remember", "write"),
      value: { kind: "profile", content: "Kelas 11 IPA." },
      runId: "run",
      step: 0,
      signal: new AbortController().signal,
    });
    assert.equal(decision.decision, "allow");
  });
});

function consented(): AgentConsentReader {
  return { needsOnboarding: async () => false };
}

interface RecordingMemoryStore extends AgentMemoryStore {
  saved: NewMemory[];
}

function memoryStore(initial: MemoryItem[] = []): RecordingMemoryStore {
  const notes = [...initial];
  const saved: NewMemory[] = [];
  return {
    saved,
    async remember(input: NewMemory): Promise<MemoryItem | null> {
      const duplicate = notes.some(
        (entry) => entry.content.toLowerCase() === input.content.toLowerCase(),
      );
      if (duplicate) return null;
      saved.push(input);
      const stored = note(`m${notes.length + 1}`, input.content, input.kind);
      notes.push(stored);
      return stored;
    },
    async list(): Promise<MemoryItem[]> {
      return [...notes];
    },
  };
}

function note(
  id: string,
  content: string,
  kind: MemoryItem["kind"] = "profile",
): MemoryItem {
  return {
    id,
    ownerId: "siswa",
    kind,
    content,
    createdAt: "2026-08-20T02:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };
}

function match(episodeId: string, text: string): HistoricalEpisodeMatch {
  return {
    episodeId,
    createdAt: "2026-08-20T02:00:00.000Z",
    source: {
      kind: "turn-range",
      fromSequence: 1,
      throughSequence: 4,
      turnCount: 4,
      sourceHash: "hash",
    },
    score: 1,
    claims: [{
      field: "facts",
      claimIndex: 0,
      score: 1,
      text,
      sourceSequences: [1],
    }],
  };
}

function capability(
  id: string,
  effect: CapabilitySnapshotEntry["effect"],
): CapabilitySnapshotEntry {
  return {
    id,
    version: "1",
    title: id,
    description: id,
    effect,
    confirmation: "contextual",
    idempotency: "keyed",
    available: true,
    unavailableReason: null,
  };
}

function context(ownerId: string): AgentExecutionContext {
  return {
    runId: "run",
    step: 0,
    scope: privateAgentScope("telegram", ownerId),
    idempotencyKey: "key",
    signal: new AbortController().signal,
    runBudget: new RunBudgetAccount(),
  };
}

// Referensi tipe agar pergeseran kontrak `AgentHistorySearch` terlihat di sini.
const _historyContract: AgentHistorySearch = { search: async () => [] };
void _historyContract;
