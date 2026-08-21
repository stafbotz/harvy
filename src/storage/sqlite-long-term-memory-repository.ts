import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationEpisode } from "../domain/history.js";
import type {
  EmbeddingDocument,
  ErrorLesson,
  LearningCandidate,
  LearningEvent,
  LongTermMemorySnapshot,
  PersistentEmbeddingIndex,
  ProcedureMemory,
  UserModelFact,
} from "../domain/long-term-memory.js";
import type {
  MemoryKnowledgeNamespace,
  TextEmbeddingProvider,
} from "../domain/memory-knowledge.js";
import { searchConversationEpisodes } from "../core/history-search.js";
import {
  memoryNamespaceKey,
  validateMemoryNamespace,
} from "../core/memory-namespace.js";

interface JsonRow {
  record_json: string;
}

interface ScopeRow {
  generation: number;
  blocked: number;
}

interface EventRow extends JsonRow {
  generation: number;
  status: string;
  attempts: number;
}

interface SearchRow extends JsonRow {
  rank: number;
}

interface EmbeddingRow {
  source_id: string;
  content_hash: string;
  vector_json: string;
}

export interface LearningCommit {
  candidate?: LearningCandidate;
  userFacts?: UserModelFact[];
  procedures?: ProcedureMemory[];
  errorLesson?: ErrorLesson;
}

/**
 * Single-node durable adapter for cold memory and learning state.
 *
 * SQLite is the local source of truth for archive/procedure/evidence. FTS and
 * embeddings are derived projections and are rebuilt/invalidated with their
 * canonical rows. The interface exposed by this class is deliberately async so
 * a future PostgreSQL/object-store adapter does not leak into domain callers.
 */
export class SqliteLongTermMemoryRepository
implements PersistentEmbeddingIndex {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(filePath: string) {
    const file = resolve(filePath);
    mkdirSync(dirname(file), { recursive: true });
    this.database = new DatabaseSync(file, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS memory_scope (
        scope_key TEXT PRIMARY KEY NOT NULL,
        namespace_json TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
        blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS archived_episode (
        archive_row_id INTEGER PRIMARY KEY,
        scope_key TEXT NOT NULL REFERENCES memory_scope(scope_key) ON DELETE CASCADE,
        episode_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        search_text TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE (scope_key, episode_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS archived_episode_scope_time
        ON archived_episode(scope_key, created_at, episode_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS archived_episode_fts USING fts5(
        search_text,
        scope_key UNINDEXED,
        episode_id UNINDEXED,
        content='archived_episode',
        content_rowid='archive_row_id',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS archived_episode_ai AFTER INSERT ON archived_episode BEGIN
        INSERT INTO archived_episode_fts(rowid, search_text, scope_key, episode_id)
        VALUES (new.archive_row_id, new.search_text, new.scope_key, new.episode_id);
      END;
      CREATE TRIGGER IF NOT EXISTS archived_episode_ad AFTER DELETE ON archived_episode BEGIN
        INSERT INTO archived_episode_fts(archived_episode_fts, rowid, search_text, scope_key, episode_id)
        VALUES ('delete', old.archive_row_id, old.search_text, old.scope_key, old.episode_id);
      END;
      CREATE TRIGGER IF NOT EXISTS archived_episode_au AFTER UPDATE ON archived_episode BEGIN
        INSERT INTO archived_episode_fts(archived_episode_fts, rowid, search_text, scope_key, episode_id)
        VALUES ('delete', old.archive_row_id, old.search_text, old.scope_key, old.episode_id);
        INSERT INTO archived_episode_fts(rowid, search_text, scope_key, episode_id)
        VALUES (new.archive_row_id, new.search_text, new.scope_key, new.episode_id);
      END;

      CREATE TABLE IF NOT EXISTS learning_event (
        event_id TEXT PRIMARY KEY NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        scope_key TEXT NOT NULL REFERENCES memory_scope(scope_key) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        record_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS learning_event_pending
        ON learning_event(status, created_at, event_id);

      CREATE TABLE IF NOT EXISTS learning_candidate (
        candidate_id TEXT PRIMARY KEY NOT NULL,
        scope_key TEXT NOT NULL REFERENCES memory_scope(scope_key) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE (scope_key, kind, fingerprint)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS user_model_fact (
        fact_row_id INTEGER PRIMARY KEY,
        fact_id TEXT NOT NULL UNIQUE,
        scope_key TEXT NOT NULL REFERENCES memory_scope(scope_key) ON DELETE CASCADE,
        slot_key TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        search_text TEXT NOT NULL,
        record_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS user_model_fact_slot
        ON user_model_fact(scope_key, slot_key, status);
      CREATE VIRTUAL TABLE IF NOT EXISTS user_model_fact_fts USING fts5(
        search_text,
        scope_key UNINDEXED,
        fact_id UNINDEXED,
        content='user_model_fact',
        content_rowid='fact_row_id',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS user_model_fact_ai AFTER INSERT ON user_model_fact BEGIN
        INSERT INTO user_model_fact_fts(rowid, search_text, scope_key, fact_id)
        VALUES (new.fact_row_id, new.search_text, new.scope_key, new.fact_id);
      END;
      CREATE TRIGGER IF NOT EXISTS user_model_fact_ad AFTER DELETE ON user_model_fact BEGIN
        INSERT INTO user_model_fact_fts(user_model_fact_fts, rowid, search_text, scope_key, fact_id)
        VALUES ('delete', old.fact_row_id, old.search_text, old.scope_key, old.fact_id);
      END;
      CREATE TRIGGER IF NOT EXISTS user_model_fact_au AFTER UPDATE ON user_model_fact BEGIN
        INSERT INTO user_model_fact_fts(user_model_fact_fts, rowid, search_text, scope_key, fact_id)
        VALUES ('delete', old.fact_row_id, old.search_text, old.scope_key, old.fact_id);
        INSERT INTO user_model_fact_fts(rowid, search_text, scope_key, fact_id)
        VALUES (new.fact_row_id, new.search_text, new.scope_key, new.fact_id);
      END;

      CREATE TABLE IF NOT EXISTS procedure_memory (
        procedure_row_id INTEGER PRIMARY KEY,
        procedure_id TEXT NOT NULL UNIQUE,
        scope_key TEXT NOT NULL REFERENCES memory_scope(scope_key) ON DELETE CASCADE,
        logical_key TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        search_text TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE (scope_key, logical_key, version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS procedure_memory_current
        ON procedure_memory(scope_key, logical_key, version DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS procedure_memory_fts USING fts5(
        search_text,
        scope_key UNINDEXED,
        procedure_id UNINDEXED,
        content='procedure_memory',
        content_rowid='procedure_row_id',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS procedure_memory_ai AFTER INSERT ON procedure_memory BEGIN
        INSERT INTO procedure_memory_fts(rowid, search_text, scope_key, procedure_id)
        VALUES (new.procedure_row_id, new.search_text, new.scope_key, new.procedure_id);
      END;
      CREATE TRIGGER IF NOT EXISTS procedure_memory_ad AFTER DELETE ON procedure_memory BEGIN
        INSERT INTO procedure_memory_fts(procedure_memory_fts, rowid, search_text, scope_key, procedure_id)
        VALUES ('delete', old.procedure_row_id, old.search_text, old.scope_key, old.procedure_id);
      END;
      CREATE TRIGGER IF NOT EXISTS procedure_memory_au AFTER UPDATE ON procedure_memory BEGIN
        INSERT INTO procedure_memory_fts(procedure_memory_fts, rowid, search_text, scope_key, procedure_id)
        VALUES ('delete', old.procedure_row_id, old.search_text, old.scope_key, old.procedure_id);
        INSERT INTO procedure_memory_fts(rowid, search_text, scope_key, procedure_id)
        VALUES (new.procedure_row_id, new.search_text, new.scope_key, new.procedure_id);
      END;

      CREATE TABLE IF NOT EXISTS error_lesson (
        lesson_row_id INTEGER PRIMARY KEY,
        lesson_id TEXT NOT NULL UNIQUE,
        scope_key TEXT NOT NULL REFERENCES memory_scope(scope_key) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        search_text TEXT NOT NULL,
        record_json TEXT NOT NULL,
        UNIQUE (scope_key, fingerprint)
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS error_lesson_fts USING fts5(
        search_text,
        scope_key UNINDEXED,
        lesson_id UNINDEXED,
        content='error_lesson',
        content_rowid='lesson_row_id',
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS error_lesson_ai AFTER INSERT ON error_lesson BEGIN
        INSERT INTO error_lesson_fts(rowid, search_text, scope_key, lesson_id)
        VALUES (new.lesson_row_id, new.search_text, new.scope_key, new.lesson_id);
      END;
      CREATE TRIGGER IF NOT EXISTS error_lesson_ad AFTER DELETE ON error_lesson BEGIN
        INSERT INTO error_lesson_fts(error_lesson_fts, rowid, search_text, scope_key, lesson_id)
        VALUES ('delete', old.lesson_row_id, old.search_text, old.scope_key, old.lesson_id);
      END;
      CREATE TRIGGER IF NOT EXISTS error_lesson_au AFTER UPDATE ON error_lesson BEGIN
        INSERT INTO error_lesson_fts(error_lesson_fts, rowid, search_text, scope_key, lesson_id)
        VALUES ('delete', old.lesson_row_id, old.search_text, old.scope_key, old.lesson_id);
        INSERT INTO error_lesson_fts(rowid, search_text, scope_key, lesson_id)
        VALUES (new.lesson_row_id, new.search_text, new.scope_key, new.lesson_id);
      END;

      CREATE TABLE IF NOT EXISTS derived_embedding (
        scope_key TEXT NOT NULL REFERENCES memory_scope(scope_key) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model_identity TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, source_id, model_identity)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS derived_embedding_content
        ON derived_embedding(content_hash, model_identity);
    `);
    const version = this.database.prepare("PRAGMA user_version").get() as
      | Record<string, unknown>
      | undefined;
    const current = version ? Object.values(version)[0] : undefined;
    if (current === 0) this.database.exec("PRAGMA user_version = 1");
    else if (current !== 1) {
      this.database.close();
      this.closed = true;
      throw new Error("Versi SQLite long-term memory tidak dikenali.");
    }
    // A crash after claim but before commit is safe to retry. Event idempotency
    // and the generation check in commit prevent duplicate/resurrection.
    this.database.exec(
      "UPDATE learning_event SET status = 'pending' WHERE status = 'processing'",
    );
  }

  async archiveEpisode(
    namespaceInput: MemoryKnowledgeNamespace,
    episode: ConversationEpisode,
    now = new Date(),
  ): Promise<boolean> {
    this.assertOpen();
    const namespace = validateMemoryNamespace(namespaceInput);
    const scopeKey = this.ensureScope(namespace, now.toISOString());
    const state = this.scopeState(scopeKey);
    if (state.blocked === 1) return false;
    const sourceHash = episode.source.sourceHash;
    const result = this.database.prepare(`
      INSERT INTO archived_episode (
        scope_key, episode_id, created_at, source_hash, search_text, record_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, episode_id) DO UPDATE SET
        created_at = excluded.created_at,
        source_hash = excluded.source_hash,
        search_text = excluded.search_text,
        record_json = excluded.record_json
      WHERE archived_episode.source_hash = excluded.source_hash
    `).run(
      scopeKey,
      episode.episodeId,
      episode.createdAt,
      sourceHash,
      episodeSearchText(episode),
      serialize(episode),
    );
    if (result.changes === 0) {
      const existing = this.database.prepare(`
        SELECT source_hash FROM archived_episode
        WHERE scope_key = ? AND episode_id = ?
      `).get(scopeKey, episode.episodeId) as
        | { source_hash: string }
        | undefined;
      if (existing?.source_hash !== sourceHash) {
        throw new Error("ID archive episode bertabrakan dengan source berbeda.");
      }
    }
    return true;
  }

  async searchArchive(
    namespaceInput: MemoryKnowledgeNamespace,
    query: string,
    limit = 8,
  ) {
    this.assertOpen();
    const namespace = validateMemoryNamespace(namespaceInput);
    const scopeKey = memoryNamespaceKey(namespace);
    if (this.scopeState(scopeKey, false)?.blocked === 1) return [];
    const match = ftsQuery(query);
    if (!match) return [];
    const bounded = boundedLimit(limit, 8, 16);
    const rows = this.database.prepare(`
      SELECT archived_episode.record_json AS record_json,
             bm25(archived_episode_fts) AS rank
      FROM archived_episode_fts
      JOIN archived_episode ON archived_episode.archive_row_id = archived_episode_fts.rowid
      WHERE archived_episode_fts MATCH ? AND archived_episode.scope_key = ?
      ORDER BY rank ASC, archived_episode.created_at DESC
      LIMIT ?
    `).all(match, scopeKey, Math.min(64, Math.max(bounded * 4, bounded))) as
      unknown as SearchRow[];
    const episodes = rows.map((row) => parseJson<ConversationEpisode>(
      row.record_json,
      "archive episode",
    ));
    return searchConversationEpisodes(episodes, query, { limit: bounded });
  }

  async listArchive(
    namespaceInput: MemoryKnowledgeNamespace,
  ): Promise<ConversationEpisode[]> {
    this.assertOpen();
    const namespace = validateMemoryNamespace(namespaceInput);
    const scopeKey = memoryNamespaceKey(namespace);
    if (this.scopeState(scopeKey, false)?.blocked === 1) return [];
    const rows = this.database.prepare(`
      SELECT record_json FROM archived_episode
      WHERE scope_key = ? ORDER BY created_at, episode_id
    `).all(scopeKey) as unknown as JsonRow[];
    return rows.map((row) => parseJson<ConversationEpisode>(
      row.record_json,
      "archive episode",
    ));
  }

  async removeArchive(namespaceInput: MemoryKnowledgeNamespace): Promise<boolean> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    return this.database.prepare(
      "DELETE FROM archived_episode WHERE scope_key = ?",
    ).run(scopeKey).changes > 0;
  }

  async currentGeneration(
    namespaceInput: MemoryKnowledgeNamespace,
  ): Promise<{ generation: number; blocked: boolean }> {
    this.assertOpen();
    const namespace = validateMemoryNamespace(namespaceInput);
    const scopeKey = this.ensureScope(namespace, new Date().toISOString());
    const row = this.scopeState(scopeKey);
    return { generation: row.generation, blocked: row.blocked === 1 };
  }

  async blockAndForget(
    namespaceInput: MemoryKnowledgeNamespace,
    at: string,
  ): Promise<number> {
    this.assertOpen();
    const namespace = validateMemoryNamespace(namespaceInput);
    const scopeKey = this.ensureScope(namespace, at);
    return this.transaction(() => {
      const row = this.scopeState(scopeKey);
      const generation = row.generation + 1;
      this.database.prepare(`
        UPDATE memory_scope
        SET generation = ?, blocked = 1, updated_at = ?
        WHERE scope_key = ?
      `).run(generation, at, scopeKey);
      // Keep only the generation tombstone. ON DELETE/FTS triggers ensure no
      // canonical or derived layer can resurrect the deleted scope.
      for (const table of [
        "archived_episode",
        "learning_event",
        "learning_candidate",
        "user_model_fact",
        "procedure_memory",
        "error_lesson",
        "derived_embedding",
      ]) {
        this.database.prepare(`DELETE FROM ${table} WHERE scope_key = ?`).run(scopeKey);
      }
      return generation;
    });
  }

  /** Persist consent withdrawal without deleting the user's durable data. */
  suspend(namespaceInput: MemoryKnowledgeNamespace, at: string): number {
    this.assertOpen();
    const namespace = validateMemoryNamespace(namespaceInput);
    const scopeKey = this.ensureScope(namespace, at);
    return this.transaction(() => {
      const row = this.scopeState(scopeKey);
      const generation = row.generation + 1;
      this.database.prepare(`
        UPDATE memory_scope
        SET generation = ?, blocked = 1, updated_at = ?
        WHERE scope_key = ?
      `).run(generation, at, scopeKey);
      return generation;
    });
  }

  async allow(namespaceInput: MemoryKnowledgeNamespace, at: string): Promise<void> {
    this.assertOpen();
    const namespace = validateMemoryNamespace(namespaceInput);
    const scopeKey = this.ensureScope(namespace, at);
    this.database.prepare(`
      UPDATE memory_scope SET blocked = 0, updated_at = ? WHERE scope_key = ?
    `).run(at, scopeKey);
  }

  async enqueue(event: LearningEvent): Promise<"enqueued" | "deduped" | "blocked"> {
    this.assertOpen();
    const namespace = validateMemoryNamespace(event.namespace);
    const scopeKey = this.ensureScope(namespace, event.createdAt);
    const state = this.scopeState(scopeKey);
    if (state.blocked === 1 || state.generation !== event.generation) {
      return "blocked";
    }
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO learning_event (
        event_id, idempotency_key, scope_key, generation, kind, occurred_at,
        created_at, status, attempts, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `).run(
      event.eventId,
      event.idempotencyKey,
      scopeKey,
      event.generation,
      event.kind,
      event.occurredAt,
      event.createdAt,
      serialize({ ...event, status: "pending", attempts: 0 }),
    );
    return result.changes === 1 ? "enqueued" : "deduped";
  }

  async claimNext(): Promise<LearningEvent | null> {
    this.assertOpen();
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT record_json, generation, status, attempts
        FROM learning_event
        WHERE status = 'pending'
        ORDER BY created_at, event_id
        LIMIT 1
      `).get() as unknown as EventRow | undefined;
      if (!row) return null;
      const event = parseJson<LearningEvent>(row.record_json, "learning event");
      const attempts = row.attempts + 1;
      const claimed: LearningEvent = {
        ...event,
        status: "processing",
        attempts,
      };
      const changed = this.database.prepare(`
        UPDATE learning_event
        SET status = 'processing', attempts = ?, record_json = ?
        WHERE event_id = ? AND status = 'pending'
      `).run(attempts, serialize(claimed), event.eventId);
      return changed.changes === 1 ? claimed : null;
    });
  }

  async requeue(event: LearningEvent): Promise<void> {
    this.assertOpen();
    this.database.prepare(`
      UPDATE learning_event SET status = 'pending', record_json = ?
      WHERE event_id = ? AND status = 'processing'
    `).run(serialize({ ...event, status: "pending" }), event.eventId);
  }

  async commitLearning(
    event: LearningEvent,
    commit: LearningCommit,
  ): Promise<"committed" | "stale" | "missing"> {
    this.assertOpen();
    const namespace = validateMemoryNamespace(event.namespace);
    const scopeKey = memoryNamespaceKey(namespace);
    return this.transaction(() => {
      const state = this.scopeState(scopeKey, false);
      if (!state || state.blocked === 1 || state.generation !== event.generation) {
        return "stale";
      }
      const stored = this.database.prepare(`
        SELECT status FROM learning_event WHERE event_id = ?
      `).get(event.eventId) as { status: string } | undefined;
      if (!stored) return "missing";
      if (stored.status === "processed") return "committed";
      if (stored.status !== "processing") return "missing";

      if (commit.candidate) this.upsertCandidate(scopeKey, commit.candidate);
      for (const fact of commit.userFacts ?? []) {
        this.upsertUserFact(scopeKey, fact);
      }
      for (const procedure of commit.procedures ?? []) {
        this.upsertProcedure(scopeKey, procedure);
      }
      if (commit.errorLesson) this.upsertErrorLesson(scopeKey, commit.errorLesson);

      const processed: LearningEvent = { ...event, status: "processed" };
      const changed = this.database.prepare(`
        UPDATE learning_event SET status = 'processed', record_json = ?
        WHERE event_id = ? AND status = 'processing'
      `).run(serialize(processed), event.eventId);
      if (changed.changes !== 1) {
        throw new Error("Commit learning event kehilangan claim.");
      }
      return "committed";
    });
  }

  async loadUserFactSlot(
    namespaceInput: MemoryKnowledgeNamespace,
    subject: string,
    predicate: string,
  ): Promise<UserModelFact[]> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    const rows = this.database.prepare(`
      SELECT record_json FROM user_model_fact
      WHERE scope_key = ? AND slot_key = ?
      ORDER BY updated_at, fact_id
    `).all(scopeKey, slotKey(subject, predicate)) as unknown as JsonRow[];
    return rows.map((row) => parseJson<UserModelFact>(row.record_json, "user fact"));
  }

  async loadCurrentProcedure(
    namespaceInput: MemoryKnowledgeNamespace,
    logicalKey: string,
  ): Promise<ProcedureMemory | null> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    const row = this.database.prepare(`
      SELECT record_json FROM procedure_memory
      WHERE scope_key = ? AND logical_key = ?
      ORDER BY version DESC LIMIT 1
    `).get(scopeKey, logicalKey) as unknown as JsonRow | undefined;
    return row ? parseJson<ProcedureMemory>(row.record_json, "procedure") : null;
  }

  async loadErrorLesson(
    namespaceInput: MemoryKnowledgeNamespace,
    fingerprint: string,
  ): Promise<ErrorLesson | null> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    const row = this.database.prepare(`
      SELECT record_json FROM error_lesson
      WHERE scope_key = ? AND fingerprint = ? LIMIT 1
    `).get(scopeKey, fingerprint) as unknown as JsonRow | undefined;
    return row ? parseJson<ErrorLesson>(row.record_json, "error lesson") : null;
  }

  async searchUserFacts(
    namespaceInput: MemoryKnowledgeNamespace,
    query: string,
    limit: number,
  ): Promise<UserModelFact[]> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    if (this.scopeState(scopeKey, false)?.blocked === 1) return [];
    const bounded = boundedLimit(limit, 4, 12);
    const globals = this.database.prepare(`
      SELECT record_json FROM user_model_fact
      WHERE scope_key = ? AND status = 'active'
        AND json_extract(record_json, '$.category') IN (
          'communication_preference', 'working_style', 'stable_preference'
        )
      ORDER BY json_extract(record_json, '$.confidence') DESC, updated_at DESC
      LIMIT ?
    `).all(scopeKey, bounded) as unknown as JsonRow[];
    const match = ftsQuery(query);
    const lexical = match
      ? this.database.prepare(`
          SELECT user_model_fact.record_json AS record_json,
                 bm25(user_model_fact_fts) AS rank
          FROM user_model_fact_fts
          JOIN user_model_fact ON user_model_fact.fact_row_id = user_model_fact_fts.rowid
          WHERE user_model_fact_fts MATCH ?
            AND user_model_fact.scope_key = ?
            AND user_model_fact.status = 'active'
          ORDER BY rank ASC, user_model_fact.updated_at DESC
          LIMIT ?
        `).all(match, scopeKey, bounded) as unknown as SearchRow[]
      : [];
    return dedupeRecords(
      [...globals, ...lexical].map((row) =>
        parseJson<UserModelFact>(row.record_json, "user fact")),
      (fact) => fact.id,
    ).slice(0, bounded);
  }

  async searchProcedureRecords(
    namespaceInput: MemoryKnowledgeNamespace,
    query: string,
    limit: number,
  ): Promise<ProcedureMemory[]> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    if (this.scopeState(scopeKey, false)?.blocked === 1) return [];
    const match = ftsQuery(query);
    if (!match) return [];
    const bounded = boundedLimit(limit, 4, 12);
    const rows = this.database.prepare(`
      SELECT procedure_memory.record_json AS record_json,
             bm25(procedure_memory_fts) AS rank
      FROM procedure_memory_fts
      JOIN procedure_memory ON procedure_memory.procedure_row_id = procedure_memory_fts.rowid
      WHERE procedure_memory_fts MATCH ?
        AND procedure_memory.scope_key = ?
        AND procedure_memory.status IN ('active', 'candidate', 'degraded', 'uncertain')
      ORDER BY
        CASE procedure_memory.status
          WHEN 'active' THEN 0 WHEN 'candidate' THEN 1
          WHEN 'uncertain' THEN 2 ELSE 3 END,
        rank ASC,
        procedure_memory.updated_at DESC
      LIMIT ?
    `).all(match, scopeKey, bounded * 3) as unknown as SearchRow[];
    return rows.map((row) => parseJson<ProcedureMemory>(row.record_json, "procedure"));
  }

  async searchErrorLessonRecords(
    namespaceInput: MemoryKnowledgeNamespace,
    query: string,
    limit: number,
  ): Promise<ErrorLesson[]> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    if (this.scopeState(scopeKey, false)?.blocked === 1) return [];
    const match = ftsQuery(query);
    if (!match) return [];
    const bounded = boundedLimit(limit, 4, 12);
    const rows = this.database.prepare(`
      SELECT error_lesson.record_json AS record_json,
             bm25(error_lesson_fts) AS rank
      FROM error_lesson_fts
      JOIN error_lesson ON error_lesson.lesson_row_id = error_lesson_fts.rowid
      WHERE error_lesson_fts MATCH ?
        AND error_lesson.scope_key = ?
        AND error_lesson.status IN ('active', 'candidate', 'uncertain')
      ORDER BY
        CASE error_lesson.status WHEN 'active' THEN 0 ELSE 1 END,
        rank ASC,
        error_lesson.updated_at DESC
      LIMIT ?
    `).all(match, scopeKey, bounded) as unknown as SearchRow[];
    return rows.map((row) => parseJson<ErrorLesson>(row.record_json, "error lesson"));
  }

  async snapshot(
    namespaceInput: MemoryKnowledgeNamespace,
  ): Promise<LongTermMemorySnapshot> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    const read = <T>(table: string, order: string): T[] => {
      const rows = this.database.prepare(
        `SELECT record_json FROM ${table} WHERE scope_key = ? ORDER BY ${order}`,
      ).all(scopeKey) as unknown as JsonRow[];
      return rows.map((row) => parseJson<T>(row.record_json, table));
    };
    const events = read<LearningEvent>("learning_event", "created_at, event_id")
      .map(({ eventId, kind, occurredAt, status, attempts }) => ({
        eventId,
        kind,
        occurredAt,
        status,
        attempts,
      }));
    return {
      userModel: read<UserModelFact>("user_model_fact", "updated_at, fact_id"),
      procedures: read<ProcedureMemory>(
        "procedure_memory",
        "logical_key, version",
      ),
      errorLessons: read<ErrorLesson>("error_lesson", "updated_at, lesson_id"),
      candidates: read<LearningCandidate>(
        "learning_candidate",
        "updated_at, candidate_id",
      ),
      learningEvents: events,
    };
  }

  async removeSource(
    namespaceInput: MemoryKnowledgeNamespace,
    sourceMemoryId: string,
  ): Promise<void> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    this.transaction(() => {
      const facts = this.database.prepare(`
        SELECT record_json FROM user_model_fact WHERE scope_key = ?
      `).all(scopeKey) as unknown as JsonRow[];
      for (const row of facts) {
        const fact = parseJson<UserModelFact>(row.record_json, "user fact");
        if (!fact.sourceMemoryIds.includes(sourceMemoryId)) continue;
        const remaining = fact.sourceMemoryIds.filter((id) => id !== sourceMemoryId);
        if (remaining.length === 0) {
          this.database.prepare("DELETE FROM user_model_fact WHERE fact_id = ?")
            .run(fact.id);
        } else {
          this.upsertUserFact(scopeKey, {
            ...fact,
            sourceMemoryIds: remaining,
            evidence: fact.evidence.filter((item) =>
              item.sourceId !== `memory:${sourceMemoryId}`),
          });
        }
      }
      const eventRows = this.database.prepare(`
        SELECT record_json FROM learning_event WHERE scope_key = ?
      `).all(scopeKey) as unknown as JsonRow[];
      const removedEventIds = new Set<string>();
      for (const row of eventRows) {
        const event = parseJson<LearningEvent>(row.record_json, "learning event");
        if (!(event.payload.sourceMemoryIds ?? []).includes(sourceMemoryId)) continue;
        removedEventIds.add(event.eventId);
        this.database.prepare("DELETE FROM learning_event WHERE event_id = ?")
          .run(event.eventId);
      }
      const candidateRows = this.database.prepare(`
        SELECT record_json FROM learning_candidate WHERE scope_key = ?
      `).all(scopeKey) as unknown as JsonRow[];
      for (const row of candidateRows) {
        const candidate = parseJson<LearningCandidate>(
          row.record_json,
          "learning candidate",
        );
        const remaining = candidate.sourceEventIds.filter(
          (eventId) => !removedEventIds.has(eventId),
        );
        if (remaining.length === 0) {
          this.database.prepare(
            "DELETE FROM learning_candidate WHERE candidate_id = ?",
          ).run(candidate.candidateId);
        } else {
          this.upsertCandidate(scopeKey, {
            ...candidate,
            sourceEventIds: remaining,
          });
        }
      }
      const procedureRows = this.database.prepare(`
        SELECT record_json FROM procedure_memory WHERE scope_key = ?
      `).all(scopeKey) as unknown as JsonRow[];
      for (const row of procedureRows) {
        const procedure = parseJson<ProcedureMemory>(row.record_json, "procedure");
        const sourceMemoryIds = (procedure.sourceMemoryIds ?? [])
          .filter((id) => id !== sourceMemoryId);
        const sourceEventIds = procedure.sourceEventIds.filter(
          (eventId) => !removedEventIds.has(eventId),
        );
        const evidence = procedure.evidence.filter((item) =>
          item.sourceId !== `memory:${sourceMemoryId}`);
        if (
          sourceMemoryIds.length === 0 &&
          procedure.sourceRunIds.length === 0 &&
          procedure.sourceEpisodeIds.length === 0 &&
          sourceEventIds.length === 0 &&
          evidence.length === 0
        ) {
          this.database.prepare(
            "DELETE FROM procedure_memory WHERE procedure_id = ?",
          ).run(procedure.procedureId);
        } else if ((procedure.sourceMemoryIds ?? []).includes(sourceMemoryId)) {
          this.upsertProcedure(scopeKey, {
            ...procedure,
            sourceMemoryIds,
            sourceEventIds,
            evidence,
          });
        }
      }
      const lessonRows = this.database.prepare(`
        SELECT record_json FROM error_lesson WHERE scope_key = ?
      `).all(scopeKey) as unknown as JsonRow[];
      for (const row of lessonRows) {
        const lesson = parseJson<ErrorLesson>(row.record_json, "error lesson");
        const sourceMemoryIds = (lesson.sourceMemoryIds ?? [])
          .filter((id) => id !== sourceMemoryId);
        const sourceEventIds = lesson.sourceEventIds.filter(
          (eventId) => !removedEventIds.has(eventId),
        );
        const evidence = lesson.evidence.filter((item) =>
          item.sourceId !== `memory:${sourceMemoryId}`);
        if (
          sourceMemoryIds.length === 0 &&
          sourceEventIds.length === 0 &&
          evidence.length === 0
        ) {
          this.database.prepare("DELETE FROM error_lesson WHERE lesson_id = ?")
            .run(lesson.lessonId);
        } else if ((lesson.sourceMemoryIds ?? []).includes(sourceMemoryId)) {
          this.upsertErrorLesson(scopeKey, {
            ...lesson,
            sourceMemoryIds,
            sourceEventIds,
            evidence,
          });
        }
      }
      this.database.prepare(`
        DELETE FROM derived_embedding
        WHERE scope_key = ? AND source_id LIKE ? ESCAPE '\\'
      `).run(scopeKey, `user-model:%${escapeLike(sourceMemoryId)}%`);
    });
  }

  async load(
    namespaceInput: MemoryKnowledgeNamespace,
    provider: TextEmbeddingProvider,
    documents: readonly EmbeddingDocument[],
  ): Promise<Map<string, number[]>> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    const identity = modelIdentity(provider);
    const result = new Map<string, number[]>();
    const statement = this.database.prepare(`
      SELECT source_id, content_hash, vector_json
      FROM derived_embedding
      WHERE scope_key = ? AND source_id = ? AND model_identity = ?
    `);
    for (const document of documents) {
      const row = statement.get(scopeKey, document.sourceId, identity) as
        unknown as EmbeddingRow | undefined;
      if (!row || row.content_hash !== document.contentHash) continue;
      const vector = parseJson<unknown>(row.vector_json, "embedding vector");
      if (!validVector(vector)) {
        throw new Error("Vector cache long-term memory rusak.");
      }
      result.set(document.sourceId, vector);
    }
    return result;
  }

  async store(
    namespaceInput: MemoryKnowledgeNamespace,
    provider: TextEmbeddingProvider,
    documents: readonly EmbeddingDocument[],
    vectors: readonly number[][],
  ): Promise<void> {
    this.assertOpen();
    if (documents.length !== vectors.length) {
      throw new Error("Jumlah document dan vector cache tidak cocok.");
    }
    const namespace = validateMemoryNamespace(namespaceInput);
    const scopeKey = this.ensureScope(namespace, new Date().toISOString());
    if (this.scopeState(scopeKey).blocked === 1) return;
    const identity = modelIdentity(provider);
    const statement = this.database.prepare(`
      INSERT INTO derived_embedding (
        scope_key, source_id, content_hash, model_identity, dimensions,
        vector_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, source_id, model_identity) DO UPDATE SET
        content_hash = excluded.content_hash,
        dimensions = excluded.dimensions,
        vector_json = excluded.vector_json,
        updated_at = excluded.updated_at
    `);
    const at = new Date().toISOString();
    this.transaction(() => {
      for (let index = 0; index < documents.length; index += 1) {
        const document = documents[index]!;
        const vector = vectors[index]!;
        if (!validVector(vector)) throw new Error("Vector cache tidak sah.");
        statement.run(
          scopeKey,
          document.sourceId,
          document.contentHash,
          identity,
          vector.length,
          serialize(vector),
          at,
        );
      }
    });
  }

  async removeSources(
    namespaceInput: MemoryKnowledgeNamespace,
    sourceIds: readonly string[],
  ): Promise<void> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    const statement = this.database.prepare(`
      DELETE FROM derived_embedding WHERE scope_key = ? AND source_id = ?
    `);
    this.transaction(() => {
      for (const sourceId of new Set(sourceIds)) statement.run(scopeKey, sourceId);
    });
  }

  async removeEpisodeSources(
    namespaceInput: MemoryKnowledgeNamespace,
    episodeIds: readonly string[],
  ): Promise<void> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    const statement = this.database.prepare(`
      DELETE FROM derived_embedding
      WHERE scope_key = ? AND source_id LIKE ? ESCAPE '\\'
    `);
    this.transaction(() => {
      for (const episodeId of new Set(episodeIds)) {
        statement.run(scopeKey, `episode:${escapeLike(episodeId)}:%`);
      }
    });
  }

  async removeScope(namespaceInput: MemoryKnowledgeNamespace): Promise<void> {
    this.assertOpen();
    const scopeKey = memoryNamespaceKey(validateMemoryNamespace(namespaceInput));
    this.database.prepare("DELETE FROM derived_embedding WHERE scope_key = ?")
      .run(scopeKey);
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private upsertCandidate(scopeKey: string, candidate: LearningCandidate): void {
    const row = this.database.prepare(`
      SELECT record_json FROM learning_candidate
      WHERE scope_key = ? AND kind = ? AND fingerprint = ?
    `).get(scopeKey, candidate.kind, candidate.fingerprint) as
      unknown as JsonRow | undefined;
    const existing = row
      ? parseJson<LearningCandidate>(row.record_json, "learning candidate")
      : null;
    const merged: LearningCandidate = existing
      ? {
          ...candidate,
          candidateId: existing.candidateId,
          createdAt: existing.createdAt,
          sourceEventIds: [...new Set([
            ...existing.sourceEventIds,
            ...candidate.sourceEventIds,
          ])].sort(),
        }
      : candidate;
    this.database.prepare(`
      INSERT INTO learning_candidate (
        candidate_id, scope_key, kind, fingerprint, status, updated_at, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, kind, fingerprint) DO UPDATE SET
        candidate_id = excluded.candidate_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `).run(
      merged.candidateId,
      scopeKey,
      merged.kind,
      merged.fingerprint,
      merged.status,
      merged.updatedAt,
      serialize(merged),
    );
  }

  private upsertUserFact(scopeKey: string, fact: UserModelFact): void {
    this.database.prepare(`
      INSERT INTO user_model_fact (
        fact_id, scope_key, slot_key, status, updated_at, search_text, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fact_id) DO UPDATE SET
        slot_key = excluded.slot_key,
        status = excluded.status,
        updated_at = excluded.updated_at,
        search_text = excluded.search_text,
        record_json = excluded.record_json
    `).run(
      fact.id,
      scopeKey,
      slotKey(fact.subject, fact.predicate),
      fact.status,
      fact.lastObservedAt,
      [fact.category, fact.subject, fact.predicate, fact.value, fact.displayText]
        .join(" "),
      serialize(fact),
    );
  }

  private upsertProcedure(scopeKey: string, procedure: ProcedureMemory): void {
    this.database.prepare(`
      INSERT INTO procedure_memory (
        procedure_id, scope_key, logical_key, version, status, updated_at,
        search_text, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(procedure_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        search_text = excluded.search_text,
        record_json = excluded.record_json
    `).run(
      procedure.procedureId,
      scopeKey,
      procedure.logicalKey,
      procedure.version,
      procedure.status,
      procedure.updatedAt,
      procedureSearchText(procedure),
      serialize(procedure),
    );
  }

  private upsertErrorLesson(scopeKey: string, lesson: ErrorLesson): void {
    this.database.prepare(`
      INSERT INTO error_lesson (
        lesson_id, scope_key, fingerprint, status, updated_at, search_text,
        record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, fingerprint) DO UPDATE SET
        lesson_id = excluded.lesson_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        search_text = excluded.search_text,
        record_json = excluded.record_json
    `).run(
      lesson.lessonId,
      scopeKey,
      lesson.signature.fingerprint,
      lesson.status,
      lesson.lastSeenAt,
      errorLessonSearchText(lesson),
      serialize(lesson),
    );
  }

  private ensureScope(
    namespace: MemoryKnowledgeNamespace,
    at: string,
  ): string {
    const scopeKey = memoryNamespaceKey(namespace);
    this.database.prepare(`
      INSERT OR IGNORE INTO memory_scope (
        scope_key, namespace_json, generation, blocked, updated_at
      ) VALUES (?, ?, 0, 0, ?)
    `).run(scopeKey, serialize(namespace), at);
    return scopeKey;
  }

  private scopeState(scopeKey: string): ScopeRow;
  private scopeState(scopeKey: string, required: true): ScopeRow;
  private scopeState(scopeKey: string, required: false): ScopeRow | null;
  private scopeState(scopeKey: string, required = true): ScopeRow | null {
    const row = this.database.prepare(`
      SELECT generation, blocked FROM memory_scope WHERE scope_key = ?
    `).get(scopeKey) as unknown as ScopeRow | undefined;
    if (!row && required) throw new Error("Scope long-term memory tidak tersedia.");
    return row ?? null;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve original error; later operations still fail closed.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SQLite long-term memory sudah ditutup.");
  }
}

function episodeSearchText(episode: ConversationEpisode): string {
  return [
    ...episode.topics,
    ...episode.facts,
    ...episode.goals,
    ...episode.decisions,
    ...episode.corrections,
    ...episode.commitments,
    ...episode.unresolved,
    ...episode.temporalAnchors,
    ...episode.uncertainties,
  ].map((claim) => claim.text).join("\n");
}

function procedureSearchText(procedure: ProcedureMemory): string {
  return [
    procedure.name,
    procedure.description,
    ...procedure.triggerSignatures,
    ...procedure.preconditions,
    ...procedure.toolRequirements,
    ...procedure.environmentConstraints,
    ...procedure.steps.flatMap((step) => [
      step.action,
      step.tool ?? "",
      step.expectedOutcome ?? "",
    ]),
    ...procedure.pitfalls,
    ...procedure.recoveryStrategies,
    ...procedure.verification,
  ].join("\n");
}

function errorLessonSearchText(lesson: ErrorLesson): string {
  return [
    lesson.signature.tool,
    lesson.signature.operation,
    lesson.signature.errorCode ?? "",
    lesson.signature.exceptionType ?? "",
    lesson.signature.normalizedMessage,
    lesson.rootCause ?? "",
    ...lesson.successfulRecovery,
    ...lesson.unsuccessfulRecoveries,
  ].join("\n");
}

function slotKey(subject: string, predicate: string): string {
  return createHash("sha256")
    .update(`${normalize(subject)}\0${normalize(predicate)}`, "utf8")
    .digest("hex");
}

function ftsQuery(value: string): string | null {
  const terms = [...new Set(
    normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [],
  )].filter((term) => term.length >= 2).slice(0, 16);
  return terms.length > 0
    ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
    : null;
}

function normalize(value: string): string {
  return value.normalize("NFKD").replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("id-ID").replaceAll(/\s+/gu, " ").trim();
}

function modelIdentity(provider: TextEmbeddingProvider): string {
  const version = provider.modelVersion?.trim() || provider.modelId;
  return `${provider.modelId}\0${version}`;
}

function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 16_384 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function boundedLimit(value: number, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(maximum, Math.floor(value)));
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`JSON ${label} long-term memory rusak.`);
  }
}

function dedupeRecords<T>(
  values: readonly T[],
  identity: (value: T) => string,
): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = identity(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
