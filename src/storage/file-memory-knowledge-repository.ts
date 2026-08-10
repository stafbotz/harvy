import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type MemoryKnowledgeNamespace,
  type MemoryKnowledgeRepository,
  type MemoryKnowledgeState,
} from "../domain/memory-knowledge.js";
import {
  memoryNamespaceKey,
  memoryNamespaceOwnerId,
  sameMemoryNamespace,
  validateMemoryNamespace,
} from "../core/memory-namespace.js";

const FILE_QUEUES = new Map<string, Promise<void>>();
const MAX_STATE_BYTES = 8 * 1024 * 1024;

/**
 * Adapter lokal bounded. Jenis scope menjadi direktori fisik terpisah dan
 * nama file adalah hash namespace kanonik, sehingga ID platform tidak menjadi
 * path serta private/group/project tidak dapat berbagi record.
 */
export class FileMemoryKnowledgeRepository
implements MemoryKnowledgeRepository {
  constructor(private readonly root: string) {}

  async load(
    namespace: MemoryKnowledgeNamespace,
  ): Promise<MemoryKnowledgeState | null> {
    const valid = validateMemoryNamespace(namespace);
    return this.readState(valid);
  }

  async save(
    state: MemoryKnowledgeState,
    expectedRevision: number | null,
  ): Promise<"saved" | "conflict"> {
    validateState(state);
    const path = this.pathOf(state.namespace);
    return this.exclusive(path, async () => {
      const current = await this.readState(state.namespace);
      if (
        (expectedRevision === null && current !== null) ||
        (expectedRevision !== null && current?.revision !== expectedRevision)
      ) {
        return "conflict";
      }
      const requiredRevision = expectedRevision === null
        ? 1
        : expectedRevision + 1;
      if (state.revision !== requiredRevision) {
        throw new Error("Revision memory knowledge harus naik tepat satu.");
      }

      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
        throw new Error("State memory knowledge melewati batas penyimpanan.");
      }
      await mkdir(join(this.root, state.namespace.kind), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, serialized, "utf8");
      await rename(temporary, path);
      return "saved";
    });
  }

  async remove(namespace: MemoryKnowledgeNamespace): Promise<boolean> {
    const valid = validateMemoryNamespace(namespace);
    const path = this.pathOf(valid);
    return this.exclusive(path, async () => {
      const finalRemoved = await unlinkIfPresent(path);
      const temporaryRemoved = await unlinkIfPresent(`${path}.tmp`);
      return finalRemoved || temporaryRemoved;
    });
  }

  private async readState(
    namespace: MemoryKnowledgeNamespace,
  ): Promise<MemoryKnowledgeState | null> {
    const path = this.pathOf(namespace);
    try {
      const raw = await readFile(path, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) {
        throw new Error("State memory knowledge melewati batas penyimpanan.");
      }
      const parsed = JSON.parse(raw) as MemoryKnowledgeState;
      validateState(parsed, namespace);
      return structuredClone(parsed);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private pathOf(namespace: MemoryKnowledgeNamespace): string {
    const valid = validateMemoryNamespace(namespace);
    const digest = createHash("sha256")
      .update(memoryNamespaceKey(valid), "utf8")
      .digest("hex")
      .slice(0, 48);
    return join(this.root, valid.kind, `${digest}.json`);
  }

  private async exclusive<T>(
    path: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = FILE_QUEUES.get(path) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate, () => gate);
    FILE_QUEUES.set(path, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (FILE_QUEUES.get(path) === tail) FILE_QUEUES.delete(path);
    }
  }
}

function validateState(
  state: MemoryKnowledgeState,
  expectedNamespace?: MemoryKnowledgeNamespace,
): void {
  if (
    !state ||
    typeof state !== "object" ||
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1 ||
    !validDate(state.updatedAt) ||
    !Array.isArray(state.semanticMemories) ||
    state.semanticMemories.length > 512 ||
    !Array.isArray(state.entities) ||
    state.entities.length > 1_024 ||
    !Array.isArray(state.relations) ||
    state.relations.length > 512 ||
    !Array.isArray(state.suppressions)
  ) {
    throw new Error("State memory knowledge tidak sah.");
  }
  const namespace = validateMemoryNamespace(state.namespace);
  const ownerId = memoryNamespaceOwnerId(namespace);
  if (
    expectedNamespace &&
    !sameMemoryNamespace(namespace, expectedNamespace)
  ) {
    throw new Error("Namespace state memory knowledge tidak cocok.");
  }

  uniqueIds(state.semanticMemories.map((memory) => memory.id), "semantic memory");
  uniqueIds(state.entities.map((entity) => entity.id), "entity memory");
  uniqueIds(state.relations.map((relation) => relation.id), "relation memory");
  uniqueIds(state.suppressions.map((item) => item.id), "suppression memory");

  for (const memory of state.semanticMemories) {
    validateSemanticMemory(memory, ownerId);
  }
  const expectedEntities = new Map<string, {
    type: MemoryKnowledgeState["entities"][number]["type"];
    canonicalName: string;
    aliases: string[];
  }>();
  const expectedRelations = new Map<string, {
    source: MemoryKnowledgeState["semanticMemories"][number];
    fromEntityId: string;
    relation: string;
    toEntityId: string | null;
    scalarValue: string | null;
  }>();
  for (const source of state.semanticMemories) {
    const projection = source.graphProjection;
    if (
      !projection ||
      source.status === "expired" ||
      (source.sourceEpisodes.length === 0 &&
        source.sourceSequences.length === 0 &&
        source.sourceMemoryIds.length === 0)
    ) continue;
    const fromEntityId = expectedEntityId(namespace, projection.from);
    mergeExpectedEntity(expectedEntities, fromEntityId, projection.from);
    const toEntityId = projection.to
      ? expectedEntityId(namespace, projection.to)
      : null;
    if (projection.to && toEntityId) {
      mergeExpectedEntity(expectedEntities, toEntityId, projection.to);
    }
    const relationId = expectedRelationId(source.id, projection.relation);
    expectedRelations.set(relationId, {
      source,
      fromEntityId,
      relation: projection.relation,
      toEntityId,
      scalarValue: projection.scalarValue ?? null,
    });
  }
  const semanticIds = new Set(state.semanticMemories.map((memory) => memory.id));
  const entityIds = new Set(state.entities.map((entity) => entity.id));
  if (
    expectedEntities.size !== state.entities.length ||
    expectedRelations.size !== state.relations.length
  ) {
    throw new Error("Projection graph memory knowledge tidak lengkap.");
  }
  for (const entity of state.entities) {
    const expected = expectedEntities.get(entity.id);
    if (
      !expected ||
      entity.ownerId !== ownerId ||
      entity.scope !== namespace.kind ||
      !ENTITY_TYPES.has(entity.type) ||
      !boundedText(entity.canonicalName, 280) ||
      !stringArray(entity.aliases, 16, 280) ||
      entity.type !== expected.type ||
      entity.canonicalName !== expected.canonicalName ||
      !sameStringSet(entity.aliases, expected.aliases)
    ) {
      throw new Error("Entity memory knowledge tidak sah.");
    }
  }
  for (const relation of state.relations) {
    const source = state.semanticMemories.find((memory) =>
      memory.id === relation.semanticMemoryId);
    const expected = expectedRelations.get(relation.id);
    if (
      !expected ||
      relation.ownerId !== ownerId ||
      !entityIds.has(relation.fromEntityId) ||
      (relation.toEntityId !== null && !entityIds.has(relation.toEntityId)) ||
      !boundedText(relation.relation, 120) ||
      (relation.scalarValue !== null &&
        !boundedText(relation.scalarValue, 280)) ||
      !validOptionalDate(relation.validFrom) ||
      !validOptionalDate(relation.validUntil) ||
      !validDate(relation.learnedAt) ||
      !validConfidence(relation.confidence) ||
      !stringArray(relation.sourceEpisodeIds, 64, 256) ||
      !sequenceArray(relation.sourceSequences) ||
      !stringArray(relation.sourceMemoryIds, 64, 256) ||
      !semanticIds.has(relation.semanticMemoryId) ||
      !SENSITIVITIES.has(relation.sensitivity) ||
      !RELATION_STATUSES.has(relation.status) ||
      (relation.sourceEpisodeIds.length === 0 &&
        relation.sourceSequences.length === 0 &&
        relation.sourceMemoryIds.length === 0) ||
      !source ||
      !sameStringSet(relation.sourceEpisodeIds, source.sourceEpisodes) ||
      !sameNumberSet(relation.sourceSequences, source.sourceSequences) ||
      !sameStringSet(relation.sourceMemoryIds, source.sourceMemoryIds) ||
      relation.sensitivity !== source.sensitivity ||
      relation.confidence !== source.confidence ||
      relation.validFrom !== source.validFrom ||
      relation.validUntil !== source.validUntil ||
      relation.status !== relationStatusFor(source.status) ||
      relation.learnedAt !== source.createdAt ||
      relation.fromEntityId !== expected.fromEntityId ||
      relation.relation !== expected.relation ||
      relation.toEntityId !== expected.toEntityId ||
      relation.scalarValue !== expected.scalarValue ||
      relation.semanticMemoryId !== expected.source.id
    ) {
      throw new Error("Relation memory knowledge tidak sah.");
    }
  }
  for (const item of state.suppressions) {
    if (
      !boundedText(item.sourceMemoryId, 256) ||
      !/^[a-f0-9]{64}$/u.test(item.contentHash) ||
      !stringArray(item.termHashes, 64, 64) ||
      item.termHashes.some((hash) => !/^[a-f0-9]{64}$/u.test(hash)) ||
      !stringArray(item.sourceEpisodeIds, 64, 256) ||
      !sequenceArray(item.sourceSequences) ||
      !validDate(item.createdAt) ||
      !SUPPRESSION_REASONS.has(item.reason)
    ) {
      throw new Error("Suppression memory knowledge tidak sah.");
    }
  }
}

function expectedEntityId(
  namespace: MemoryKnowledgeNamespace,
  draft: NonNullable<
    MemoryKnowledgeState["semanticMemories"][number]["graphProjection"]
  >["from"],
): string {
  return `me-${hash24(
    `${memoryNamespaceKey(namespace)}\0${draft.type}\0${normalizeGraphName(draft.canonicalName)}`,
  )}`;
}

function expectedRelationId(memoryId: string, relation: string): string {
  return `mr-${hash24(`${memoryId}\0${relation}`)}`;
}

function hash24(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function normalizeGraphName(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("id-ID")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function mergeExpectedEntity(
  entities: Map<string, {
    type: MemoryKnowledgeState["entities"][number]["type"];
    canonicalName: string;
    aliases: string[];
  }>,
  id: string,
  draft: NonNullable<
    MemoryKnowledgeState["semanticMemories"][number]["graphProjection"]
  >["from"],
): void {
  const current = entities.get(id);
  if (!current) {
    entities.set(id, {
      type: draft.type,
      canonicalName: draft.canonicalName,
      aliases: [...new Set(draft.aliases ?? [])],
    });
    return;
  }
  current.aliases = [...new Set([
    ...current.aliases,
    ...(draft.aliases ?? []),
  ])];
}

function validateSemanticMemory(
  memory: MemoryKnowledgeState["semanticMemories"][number],
  ownerId: string,
): void {
  if (
    memory.ownerId !== ownerId ||
    !boundedText(memory.subject, 280) ||
    !boundedText(memory.predicate, 120) ||
    !boundedText(memory.value, 500) ||
    !boundedText(memory.displayText, 500) ||
    !validConfidence(memory.confidence) ||
    !validOptionalDate(memory.validFrom) ||
    !validOptionalDate(memory.validUntil) ||
    !stringArray(memory.sourceEpisodes, 64, 256) ||
    !sequenceArray(memory.sourceSequences) ||
    !stringArray(memory.sourceMemoryIds, 64, 256) ||
    !Array.isArray(memory.evidence) ||
    memory.evidence.length > 64 ||
    !validDate(memory.createdAt) ||
    !validOptionalDate(memory.lastVerifiedAt) ||
    !validOptionalDate(memory.lastUsedAt) ||
    !SENSITIVITIES.has(memory.sensitivity) ||
    !PROVENANCES.has(memory.provenance) ||
    !SEMANTIC_STATUSES.has(memory.status)
  ) {
    throw new Error("Semantic memory knowledge tidak sah.");
  }
  for (const evidence of memory.evidence) {
    if (
      (evidence.sourceMemoryId !== null &&
        !boundedText(evidence.sourceMemoryId, 256)) ||
      (evidence.sourceEpisodeId !== null &&
        !boundedText(evidence.sourceEpisodeId, 256)) ||
      !sequenceArray(evidence.sourceSequences) ||
      (evidence.sourceMemoryId === null &&
        evidence.sourceEpisodeId === null &&
        evidence.sourceSequences.length === 0)
    ) {
      throw new Error("Evidence semantic memory tidak sah.");
    }
  }
  const sourceMemoryIds = memory.evidence.flatMap((evidence) =>
    evidence.sourceMemoryId === null ? [] : [evidence.sourceMemoryId]);
  const sourceEpisodes = memory.evidence.flatMap((evidence) =>
    evidence.sourceEpisodeId === null ? [] : [evidence.sourceEpisodeId]);
  const sourceSequences = memory.evidence.flatMap((evidence) =>
    evidence.sourceSequences);
  if (
    !sameStringSet(memory.sourceMemoryIds, sourceMemoryIds) ||
    !sameStringSet(memory.sourceEpisodes, sourceEpisodes) ||
    !sameNumberSet(memory.sourceSequences, sourceSequences)
  ) {
    throw new Error("Aggregate provenance semantic memory tidak sah.");
  }
  const projection = memory.graphProjection;
  if (projection !== null) {
    if (
      !validEntityDraft(projection.from) ||
      !boundedText(projection.relation, 120) ||
      (projection.to !== undefined && !validEntityDraft(projection.to)) ||
      (projection.scalarValue !== undefined &&
        !boundedText(projection.scalarValue, 280)) ||
      (projection.to === undefined && projection.scalarValue === undefined) ||
      (projection.to !== undefined && projection.scalarValue !== undefined)
    ) {
      throw new Error("Proyeksi graph semantic memory tidak sah.");
    }
  }
}

function relationStatusFor(
  status: MemoryKnowledgeState["semanticMemories"][number]["status"],
): MemoryKnowledgeState["relations"][number]["status"] {
  if (status === "superseded") return "superseded";
  if (status === "uncertain") return "uncertain";
  return "active";
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify([...new Set(left)].sort()) ===
    JSON.stringify([...new Set(right)].sort());
}

function sameNumberSet(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return JSON.stringify([...new Set(left)].sort((a, b) => a - b)) ===
    JSON.stringify([...new Set(right)].sort((a, b) => a - b));
}

function validEntityDraft(
  draft: NonNullable<
    MemoryKnowledgeState["semanticMemories"][number]["graphProjection"]
  >["from"],
): boolean {
  return Boolean(
    draft &&
    ENTITY_TYPES.has(draft.type) &&
    boundedText(draft.canonicalName, 280) &&
    (draft.aliases === undefined || stringArray(draft.aliases, 16, 280)),
  );
}

function uniqueIds(ids: string[], label: string): void {
  if (ids.some((id) => !boundedText(id, 256)) || new Set(ids).size !== ids.length) {
    throw new Error(`ID ${label} tidak sah atau duplikat.`);
  }
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/\p{Cc}/u.test(value);
}

function stringArray(
  value: unknown,
  maximumItems: number,
  maximumCharacters: number,
): value is string[] {
  return Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => boundedText(item, maximumCharacters)) &&
    new Set(value).size === value.length;
}

function sequenceArray(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length <= 256 &&
    value.every((sequence) => Number.isSafeInteger(sequence) && sequence > 0) &&
    new Set(value).size === value.length;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validOptionalDate(value: unknown): value is string | null {
  return value === null || validDate(value);
}

function validConfidence(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function unlinkIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

const ENTITY_TYPES = new Set([
  "person",
  "subject",
  "course",
  "exam",
  "project",
  "goal",
  "activity",
  "place",
  "concept",
]);
const SENSITIVITIES = new Set(["normal", "personal", "restricted"]);
const PROVENANCES = new Set(["asserted", "observed", "inferred"]);
const SEMANTIC_STATUSES = new Set([
  "active",
  "superseded",
  "uncertain",
  "expired",
]);
const RELATION_STATUSES = new Set(["active", "superseded", "uncertain"]);
const SUPPRESSION_REASONS = new Set(["forgotten", "edited", "expired"]);
