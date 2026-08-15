import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { groupScopeKey } from "../domain/group.js";
import type {
  GroupCodingRepository,
  GroupCodingRunReference,
  GroupCodingRunReferenceSaveResult,
  GroupWorkspaceLink,
  GroupWorkspaceLinkSaveResult,
} from "../domain/group-coding.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { writeDurableFileAtomic } from "./durable-file.js";

const FILE_QUEUES = new Map<string, Promise<void>>();
const MAX_LINKS = 4_096;
const MAX_RUN_REFERENCES = 16_384;

interface GroupCodingDatabase {
  version: 1;
  links: GroupWorkspaceLink[];
  runReferences: GroupCodingRunReference[];
}

/** Local single-process adapter; production still needs distributed CAS. */
export class FileGroupCodingRepository implements GroupCodingRepository {
  readonly coordinationKey: string;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
    this.coordinationKey = `file:${this.filePath}`;
  }

  async loadLink(
    scopeKeyInput: string,
    accountIdInput: string,
  ): Promise<GroupWorkspaceLink | null> {
    const scopeKey = safeKey(scopeKeyInput, "scopeKey");
    const accountId = safeKey(accountIdInput, "accountId");
    return this.exclusive(async () => {
      const link = (await this.readDatabase()).links.find((candidate) =>
        candidate.scopeKey === scopeKey && candidate.accountId === accountId
      );
      return link ? structuredClone(link) : null;
    });
  }

  async saveLink(
    input: Omit<GroupWorkspaceLink, "stateRevision">,
    expectedStateRevision: number | null,
  ): Promise<GroupWorkspaceLinkSaveResult> {
    if (
      expectedStateRevision !== null &&
      (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 1)
    ) throw new Error("Expected state revision link group-coding tidak sah.");
    const link: GroupWorkspaceLink = {
      ...structuredClone(input),
      stateRevision: (expectedStateRevision ?? 0) + 1,
    };
    validateLink(link);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.links.findIndex((candidate) =>
        candidate.scopeKey === link.scopeKey && candidate.accountId === link.accountId
      );
      const current = index >= 0 ? database.links[index]! : null;
      if (
        (expectedStateRevision === null && current) ||
        (expectedStateRevision !== null &&
          (!current || current.stateRevision !== expectedStateRevision))
      ) return { status: "conflict" };
      if (current) assertLinkTransition(current, link);
      if (!current && database.links.length >= MAX_LINKS) {
        throw new Error("Batas link group-coding tercapai.");
      }
      if (index >= 0) database.links[index] = link;
      else database.links.push(link);
      await this.writeDatabase(database);
      return { status: "saved", link: structuredClone(link) };
    });
  }

  async loadRunReference(runIdInput: string): Promise<GroupCodingRunReference | null> {
    const runId = safeKey(runIdInput, "runId");
    return this.exclusive(async () => {
      const reference = (await this.readDatabase()).runReferences.find(
        (candidate) => candidate.runId === runId,
      );
      return reference ? structuredClone(reference) : null;
    });
  }

  async loadRunReferenceByEffect(
    effectIdInput: string,
  ): Promise<GroupCodingRunReference | null> {
    const effectId = safeKey(effectIdInput, "effectId");
    return this.exclusive(async () => {
      const reference = (await this.readDatabase()).runReferences.find(
        (candidate) => candidate.effectId === effectId,
      );
      return reference ? structuredClone(reference) : null;
    });
  }

  async saveRunReference(
    input: GroupCodingRunReference,
  ): Promise<GroupCodingRunReferenceSaveResult> {
    const reference = structuredClone(input);
    validateReference(reference);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const replay = database.runReferences.find((candidate) =>
        candidate.effectId === reference.effectId ||
        candidate.runId === reference.runId ||
        candidate.referenceId === reference.referenceId
      );
      if (replay) {
        return canonicalJson(replay) === canonicalJson(reference)
          ? { status: "saved", reference: structuredClone(replay) }
          : { status: "conflict" };
      }
      if (database.runReferences.length >= MAX_RUN_REFERENCES) {
        throw new Error("Batas reference Group CodingRun tercapai.");
      }
      const link = database.links.find((candidate) =>
        candidate.linkId === reference.linkId &&
        candidate.scopeKey === reference.scopeKey &&
        candidate.accountId === reference.accountId &&
        candidate.groupJoinedAt === reference.groupJoinedAt &&
        candidate.workspaceKey === reference.workspaceKey &&
        candidate.stateRevision === reference.linkStateRevision &&
        candidate.status === "active"
      );
      if (!link) return { status: "conflict" };
      database.runReferences.push(reference);
      await this.writeDatabase(database);
      return { status: "saved", reference: structuredClone(reference) };
    });
  }

  private async readDatabase(): Promise<GroupCodingDatabase> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      assertExactKeys(value, ["version", "links", "runReferences"], "database");
      const database = value as GroupCodingDatabase;
      if (
        database.version !== 1 || !Array.isArray(database.links) ||
        !Array.isArray(database.runReferences) || database.links.length > MAX_LINKS ||
        database.runReferences.length > MAX_RUN_REFERENCES
      ) throw new Error("Format basis data group-coding tidak dikenali.");
      database.links.forEach(validateLink);
      database.runReferences.forEach(validateReference);
      assertUnique(database);
      return structuredClone(database);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, links: [], runReferences: [] };
      }
      throw error;
    }
  }

  private async writeDatabase(database: GroupCodingDatabase): Promise<void> {
    assertUnique(database);
    await writeDurableFileAtomic(
      this.filePath,
      `${JSON.stringify(database, null, 2)}\n`,
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = FILE_QUEUES.get(this.filePath) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tail = next.then(() => undefined, () => undefined);
    FILE_QUEUES.set(this.filePath, tail);
    try {
      return await next;
    } finally {
      if (FILE_QUEUES.get(this.filePath) === tail) FILE_QUEUES.delete(this.filePath);
    }
  }
}

function validateLink(value: unknown): asserts value is GroupWorkspaceLink {
  assertExactKeys(value, [
    "version", "linkId", "scopeKey", "scope", "accountId", "groupJoinedAt",
    "workspaceKey", "linkedByMembershipId", "linkedByParticipantId",
    "linkedAtAuthorityEpoch", "stateRevision", "status", "createdAt",
    "updatedAt", "revokedAt",
  ], "link");
  const link = value as GroupWorkspaceLink;
  assertExactKeys(link.scope, ["channel", "groupId"], "link.scope");
  if (
    link.version !== 1 ||
    (link.scope.channel !== "whatsapp" && link.scope.channel !== "telegram") ||
    link.scopeKey !== groupScopeKey(link.scope) ||
    (link.status !== "active" && link.status !== "revoked") ||
    !Number.isSafeInteger(link.linkedAtAuthorityEpoch) ||
    link.linkedAtAuthorityEpoch < 0 ||
    !Number.isSafeInteger(link.stateRevision) || link.stateRevision < 1
  ) throw new Error("Link group-coding tidak sah.");
  for (const [field, item] of [
    ["linkId", link.linkId], ["scopeKey", link.scopeKey],
    ["groupId", link.scope.groupId], ["accountId", link.accountId],
    ["workspaceKey", link.workspaceKey],
    ["linkedByMembershipId", link.linkedByMembershipId],
    ["linkedByParticipantId", link.linkedByParticipantId],
  ] as const) safeKey(item, field);
  validIso(link.groupJoinedAt, "groupJoinedAt");
  validIso(link.createdAt, "createdAt");
  validIso(link.updatedAt, "updatedAt");
  if (link.revokedAt !== null) validIso(link.revokedAt, "revokedAt");
  if ((link.status === "revoked") !== (link.revokedAt !== null)) {
    throw new Error("Status revoke link group-coding tidak konsisten.");
  }
}

function validateReference(value: unknown): asserts value is GroupCodingRunReference {
  assertExactKeys(value, [
    "version", "referenceId", "effectId", "interactionDigest", "commandDigest",
    "runId", "linkId", "linkStateRevision", "scopeKey", "accountId",
    "groupJoinedAt", "workspaceKey", "projectId", "initiatedByMembershipId",
    "initiatedByParticipantId", "createdAt",
  ], "run reference");
  const reference = value as GroupCodingRunReference;
  if (
    reference.version !== 1 ||
    !Number.isSafeInteger(reference.linkStateRevision) ||
    reference.linkStateRevision < 1 ||
    !digest(reference.interactionDigest) || !digest(reference.commandDigest)
  ) throw new Error("Reference Group CodingRun tidak sah.");
  for (const [field, item] of [
    ["referenceId", reference.referenceId], ["effectId", reference.effectId],
    ["runId", reference.runId], ["linkId", reference.linkId],
    ["scopeKey", reference.scopeKey], ["accountId", reference.accountId],
    ["workspaceKey", reference.workspaceKey], ["projectId", reference.projectId],
    ["initiatedByMembershipId", reference.initiatedByMembershipId],
    ["initiatedByParticipantId", reference.initiatedByParticipantId],
  ] as const) safeKey(item, field);
  validIso(reference.groupJoinedAt, "reference.groupJoinedAt");
  validIso(reference.createdAt, "reference.createdAt");
}

function assertLinkTransition(current: GroupWorkspaceLink, next: GroupWorkspaceLink): void {
  if (current.status === "revoked" && next.status === "active") {
    if (
      current.scopeKey !== next.scopeKey || current.accountId !== next.accountId ||
      next.revokedAt !== null
    ) throw new Error("Replacement link group-coding tidak sah.");
    return;
  }
  if (
    current.status === "active" && next.status === "active" &&
    current.groupJoinedAt !== next.groupJoinedAt
  ) {
    if (
      current.scopeKey !== next.scopeKey || current.accountId !== next.accountId ||
      next.revokedAt !== null
    ) throw new Error("Replacement generation link group-coding tidak sah.");
    return;
  }
  const immutable = [
    "version", "linkId", "scopeKey", "scope", "accountId", "groupJoinedAt",
    "workspaceKey", "linkedByMembershipId", "linkedByParticipantId",
    "linkedAtAuthorityEpoch", "createdAt",
  ] as const;
  if (immutable.some((field) => canonicalJson(current[field]) !== canonicalJson(next[field]))) {
    throw new Error("Field immutable link group-coding berubah.");
  }
  if (current.status === "revoked" || next.status !== "revoked") {
    throw new Error("Link group-coding hanya dapat bertransisi active ke revoked.");
  }
}

function assertUnique(database: GroupCodingDatabase): void {
  const linkKeys = new Set<string>();
  const linkIds = new Set<string>();
  for (const link of database.links) {
    validateLink(link);
    const key = `${link.scopeKey}\0${link.accountId}`;
    if (linkKeys.has(key) || linkIds.has(link.linkId)) {
      throw new Error("Link group-coding duplikat.");
    }
    linkKeys.add(key);
    linkIds.add(link.linkId);
  }
  const references = new Set<string>();
  for (const reference of database.runReferences) {
    validateReference(reference);
    for (const key of [
      `reference:${reference.referenceId}`,
      `effect:${reference.effectId}`,
      `run:${reference.runId}`,
    ]) {
      if (references.has(key)) throw new Error("Reference Group CodingRun duplikat.");
      references.add(key);
    }
  }
}

function safeKey(value: unknown, field: string): string {
  if (
    typeof value !== "string" || !value || value.length > 512 ||
    /\p{Cc}/u.test(value) || containsSecretLikeValue(value)
  ) throw new Error(`${field} group-coding tidak sah.`);
  return value;
}

function validIso(value: unknown, field: string): void {
  if (
    typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) throw new Error(`${field} group-coding bukan timestamp ISO yang sah.`);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): void {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) throw new Error(`Schema ${label} group-coding memuat field asing atau hilang.`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
