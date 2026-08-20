import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { groupScopeKey } from "../domain/group.js";
import type {
  GroupCodingRepository,
  GroupCodingDeliveryEffect,
  GroupCodingDeliveryEffectSaveResult,
  GroupCodingRunReference,
  GroupCodingRunReferenceSaveResult,
  GroupWorkspaceLink,
  GroupWorkspaceLinkRequest,
  GroupWorkspaceLinkRequestSaveResult,
  GroupWorkspaceLinkSaveResult,
} from "../domain/group-coding.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import { writeDurableFileAtomic } from "./durable-file.js";

const FILE_QUEUES = new Map<string, Promise<void>>();
const MAX_LINKS = 4_096;
const MAX_RUN_REFERENCES = 16_384;
const MAX_DELIVERY_EFFECTS = 32_768;
const MAX_LINK_REQUESTS = 8_192;

interface GroupCodingDatabase {
  version: 5;
  links: GroupWorkspaceLink[];
  linkRequests: GroupWorkspaceLinkRequest[];
  runReferences: GroupCodingRunReference[];
  deliveryEffects: GroupCodingDeliveryEffect[];
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

  async loadLinkRequest(
    requestIdInput: string,
  ): Promise<GroupWorkspaceLinkRequest | null> {
    const requestId = safeKey(requestIdInput, "group workspace link requestId");
    return this.exclusive(async () => {
      const request = (await this.readDatabase()).linkRequests.find(
        (candidate) => candidate.requestId === requestId,
      );
      return request ? structuredClone(request) : null;
    });
  }

  async listLinkRequests(): Promise<GroupWorkspaceLinkRequest[]> {
    return this.exclusive(async () => (await this.readDatabase()).linkRequests
      .map((request) => structuredClone(request)));
  }

  async saveLinkRequest(
    input: Omit<GroupWorkspaceLinkRequest, "stateRevision">,
    expectedStateRevision: number | null,
  ): Promise<GroupWorkspaceLinkRequestSaveResult> {
    if (
      expectedStateRevision !== null &&
      (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 1)
    ) throw new Error("Expected revision request link group-coding tidak sah.");
    const request: GroupWorkspaceLinkRequest = {
      ...structuredClone(input),
      stateRevision: (expectedStateRevision ?? 0) + 1,
    };
    validateLinkRequest(request);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.linkRequests.findIndex(
        (candidate) => candidate.requestId === request.requestId,
      );
      const current = index < 0 ? null : database.linkRequests[index]!;
      if (
        (expectedStateRevision === null && current !== null) ||
        (expectedStateRevision !== null && current?.stateRevision !== expectedStateRevision)
      ) return { status: "conflict" };
      if (current) assertLinkRequestTransition(current, request);
      if (!current && database.linkRequests.length >= MAX_LINK_REQUESTS) {
        throw new Error("Batas request link group-coding tercapai.");
      }
      if (index < 0) database.linkRequests.push(request);
      else database.linkRequests[index] = request;
      await this.writeDatabase(database);
      return { status: "saved", request: structuredClone(request) };
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

  async listRunReferences(): Promise<GroupCodingRunReference[]> {
    return this.exclusive(async () => (await this.readDatabase()).runReferences
      .map((reference) => structuredClone(reference)));
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

  async loadDeliveryEffect(
    effectIdInput: string,
  ): Promise<GroupCodingDeliveryEffect | null> {
    const effectId = safeKey(effectIdInput, "delivery effectId");
    return this.exclusive(async () => {
      const effect = (await this.readDatabase()).deliveryEffects.find(
        (candidate) => candidate.effectId === effectId,
      );
      return effect ? structuredClone(effect) : null;
    });
  }

  async listDeliveryEffects(
    status?: GroupCodingDeliveryEffect["status"],
  ): Promise<GroupCodingDeliveryEffect[]> {
    if (
      status !== undefined && status !== "prepared" && status !== "committed" &&
      status !== "not_committed" && status !== "unknown"
    ) throw new Error("Status delivery group-coding tidak sah.");
    return this.exclusive(async () => (await this.readDatabase()).deliveryEffects
      .filter((effect) => status === undefined || effect.status === status)
      .map((effect) => structuredClone(effect)));
  }

  async saveDeliveryEffect(
    input: Omit<GroupCodingDeliveryEffect, "stateRevision">,
    expectedStateRevision: number | null,
  ): Promise<GroupCodingDeliveryEffectSaveResult> {
    if (
      expectedStateRevision !== null &&
      (!Number.isSafeInteger(expectedStateRevision) || expectedStateRevision < 1)
    ) throw new Error("Expected state revision delivery group-coding tidak sah.");
    const effect: GroupCodingDeliveryEffect = {
      ...structuredClone(input),
      stateRevision: (expectedStateRevision ?? 0) + 1,
    };
    validateDeliveryEffect(effect);
    return this.exclusive(async () => {
      const database = await this.readDatabase();
      const index = database.deliveryEffects.findIndex(
        (candidate) => candidate.effectId === effect.effectId,
      );
      const current = index < 0 ? null : database.deliveryEffects[index]!;
      if (
        (expectedStateRevision === null && current !== null) ||
        (expectedStateRevision !== null && current?.stateRevision !== expectedStateRevision)
      ) return { status: "conflict" };
      if (current) assertDeliveryTransition(current, effect);
      if (!current && database.deliveryEffects.length >= MAX_DELIVERY_EFFECTS) {
        throw new Error("Batas delivery effect group-coding tercapai.");
      }
      if (index < 0) database.deliveryEffects.push(effect);
      else database.deliveryEffects[index] = effect;
      await this.writeDatabase(database);
      return { status: "saved", effect: structuredClone(effect) };
    });
  }

  private async readDatabase(): Promise<GroupCodingDatabase> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Format basis data group-coding tidak dikenali.");
      }
      const raw = value as Record<string, unknown>;
      let database: GroupCodingDatabase;
      if (raw["version"] === 1) {
        assertExactKeys(value, ["version", "links", "runReferences"], "database v1");
        database = {
          version: 5,
          links: raw["links"] as GroupWorkspaceLink[],
          linkRequests: [],
          runReferences: raw["runReferences"] as GroupCodingRunReference[],
          deliveryEffects: [],
        };
      } else if (raw["version"] === 2) {
        assertExactKeys(
          value,
          ["version", "links", "runReferences", "deliveryEffects"],
          "database v2",
        );
        database = {
          version: 5,
          links: raw["links"] as GroupWorkspaceLink[],
          linkRequests: [],
          runReferences: raw["runReferences"] as GroupCodingRunReference[],
          deliveryEffects: (raw["deliveryEffects"] as Array<
            Omit<GroupCodingDeliveryEffect, "mode" | "targetMessageId">
          >).map((effect) => ({
            ...effect,
            mode: "send" as const,
            targetMessageId: null,
          })),
        };
      } else if (raw["version"] === 3) {
        assertExactKeys(
          value,
          ["version", "links", "runReferences", "deliveryEffects"],
          "database v3",
        );
        database = {
          version: 5,
          links: raw["links"] as GroupWorkspaceLink[],
          linkRequests: [],
          runReferences: raw["runReferences"] as GroupCodingRunReference[],
          deliveryEffects: raw["deliveryEffects"] as GroupCodingDeliveryEffect[],
        };
      } else if (raw["version"] === 4) {
        assertExactKeys(
          value,
          ["version", "links", "linkRequests", "runReferences", "deliveryEffects"],
          "database v4",
        );
        database = {
          version: 5,
          links: raw["links"] as GroupWorkspaceLink[],
          linkRequests: (raw["linkRequests"] as Array<
            Omit<GroupWorkspaceLinkRequest, "revokedAt">
          >).map((request) => ({ ...request, revokedAt: null })),
          runReferences: raw["runReferences"] as GroupCodingRunReference[],
          deliveryEffects: raw["deliveryEffects"] as GroupCodingDeliveryEffect[],
        };
      } else {
        assertExactKeys(
          value,
          ["version", "links", "linkRequests", "runReferences", "deliveryEffects"],
          "database",
        );
        database = value as GroupCodingDatabase;
      }
      if (
        database.version !== 5 || !Array.isArray(database.links) ||
        !Array.isArray(database.linkRequests) ||
        database.linkRequests.length > MAX_LINK_REQUESTS ||
        !Array.isArray(database.runReferences) || database.links.length > MAX_LINKS ||
        database.runReferences.length > MAX_RUN_REFERENCES ||
        !Array.isArray(database.deliveryEffects) ||
        database.deliveryEffects.length > MAX_DELIVERY_EFFECTS
      ) throw new Error("Format basis data group-coding tidak dikenali.");
      database.links.forEach(validateLink);
      database.linkRequests.forEach(validateLinkRequest);
      database.runReferences.forEach(validateReference);
      database.deliveryEffects.forEach(validateDeliveryEffect);
      assertUnique(database);
      return structuredClone(database);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          version: 5,
          links: [],
          linkRequests: [],
          runReferences: [],
          deliveryEffects: [],
        };
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

function validateLinkRequest(
  value: unknown,
): asserts value is GroupWorkspaceLinkRequest {
  assertExactKeys(value, [
    "version", "requestId", "scopeKey", "scope", "accountId",
    "groupJoinedAt", "participantPrincipal", "requestedByParticipantId",
    "requestedAtAuthorityEpoch", "status", "workspaceKey",
    "grantedMembershipId", "approvedByMembershipId", "approvedAclEpoch",
    "stateRevision", "createdAt", "expiresAt", "approvedAt", "consumedAt",
    "revokedAt", "updatedAt",
  ], "group workspace link request");
  const request = value as GroupWorkspaceLinkRequest;
  assertExactKeys(request.scope, ["channel", "groupId"], "link request.scope");
  assertExactKeys(
    request.participantPrincipal,
    ["channel", "principalKey"],
    "link request.participantPrincipal",
  );
  if (
    request.version !== 1 || request.scope.channel !== "whatsapp" ||
    request.participantPrincipal.channel !== "whatsapp" ||
    !/^[a-f0-9]{64}$/u.test(request.participantPrincipal.principalKey) ||
    request.scopeKey !== groupScopeKey(request.scope) ||
    !Number.isSafeInteger(request.requestedAtAuthorityEpoch) ||
    request.requestedAtAuthorityEpoch < 1 ||
    !Number.isSafeInteger(request.stateRevision) || request.stateRevision < 1 ||
    !["pending", "approving", "approved", "consumed", "expired", "revoked"]
      .includes(request.status)
  ) throw new Error("Request link group-coding tidak sah.");
  for (const [field, item] of [
    ["requestId", request.requestId], ["scopeKey", request.scopeKey],
    ["groupId", request.scope.groupId], ["accountId", request.accountId],
    ["requestedByParticipantId", request.requestedByParticipantId],
  ] as const) safeKey(item, `link request.${field}`);
  for (const [field, item] of [
    ["workspaceKey", request.workspaceKey],
    ["grantedMembershipId", request.grantedMembershipId],
    ["approvedByMembershipId", request.approvedByMembershipId],
  ] as const) if (item !== null) safeKey(item, `link request.${field}`);
  validIso(request.groupJoinedAt, "link request.groupJoinedAt");
  validIso(request.createdAt, "link request.createdAt");
  validIso(request.expiresAt, "link request.expiresAt");
  validIso(request.updatedAt, "link request.updatedAt");
  if (request.approvedAt !== null) validIso(request.approvedAt, "link request.approvedAt");
  if (request.consumedAt !== null) validIso(request.consumedAt, "link request.consumedAt");
  if (request.revokedAt !== null) validIso(request.revokedAt, "link request.revokedAt");
  if (
    request.approvedAclEpoch !== null &&
    (!Number.isSafeInteger(request.approvedAclEpoch) || request.approvedAclEpoch < 1)
  ) throw new Error("ACL epoch request link group-coding tidak sah.");
  const emptyApproval = request.workspaceKey === null &&
    request.grantedMembershipId === null && request.approvedByMembershipId === null &&
    request.approvedAclEpoch === null && request.approvedAt === null;
  const reservedApproval = request.workspaceKey !== null &&
    request.grantedMembershipId === null && request.approvedByMembershipId !== null &&
    request.approvedAclEpoch !== null && request.approvedAt === null;
  const completeApproval = request.workspaceKey !== null &&
    request.grantedMembershipId !== null && request.approvedByMembershipId !== null &&
    request.approvedAclEpoch !== null && request.approvedAt !== null;
  const lifecycleValid =
    ((request.status === "pending" || request.status === "expired") &&
      emptyApproval && request.consumedAt === null && request.revokedAt === null) ||
    (request.status === "approving" && reservedApproval &&
      request.consumedAt === null && request.revokedAt === null) ||
    (request.status === "approved" && completeApproval &&
      request.consumedAt === null && request.revokedAt === null) ||
    (request.status === "consumed" && completeApproval &&
      request.consumedAt !== null && request.revokedAt === null) ||
    (request.status === "revoked" &&
      (emptyApproval || reservedApproval || completeApproval) &&
      request.consumedAt === null && request.revokedAt !== null);
  if (!lifecycleValid) {
    throw new Error("Lifecycle request link group-coding tidak konsisten.");
  }
}

function assertLinkRequestTransition(
  current: GroupWorkspaceLinkRequest,
  next: GroupWorkspaceLinkRequest,
): void {
  const immutable = [
    "version", "requestId", "scopeKey", "scope", "accountId",
    "groupJoinedAt", "participantPrincipal", "requestedByParticipantId",
    "requestedAtAuthorityEpoch", "createdAt", "expiresAt",
  ] as const;
  if (immutable.some((field) =>
    canonicalJson(current[field]) !== canonicalJson(next[field])
  )) throw new Error("Binding immutable request link group-coding berubah.");
  const permitted =
    (current.status === "pending" &&
      (next.status === "approving" || next.status === "expired")) ||
    (current.status === "approving" && next.status === "approved") ||
    (current.status === "approved" && next.status === "consumed") ||
    (["pending", "approving", "approved"].includes(current.status) &&
      next.status === "revoked" && requestApprovalBindingEqual(current, next));
  if (!permitted) throw new Error("Transisi request link group-coding tidak sah.");
}

function requestApprovalBindingEqual(
  current: GroupWorkspaceLinkRequest,
  next: GroupWorkspaceLinkRequest,
): boolean {
  return ([
    "workspaceKey", "grantedMembershipId", "approvedByMembershipId",
    "approvedAclEpoch", "approvedAt", "consumedAt",
  ] as const).every((field) =>
    canonicalJson(current[field]) === canonicalJson(next[field])
  );
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
    "initiatedByPrincipalKey", "initiatedByParticipantId", "createdAt",
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
  if (!/^[a-f0-9]{64}$/u.test(reference.initiatedByPrincipalKey)) {
    throw new Error("Principal reference Group CodingRun tidak sah.");
  }
  validIso(reference.groupJoinedAt, "reference.groupJoinedAt");
  validIso(reference.createdAt, "reference.createdAt");
}

function validateDeliveryEffect(
  value: unknown,
): asserts value is GroupCodingDeliveryEffect {
  assertExactKeys(value, [
    "version", "effectId", "commandDigest", "purpose", "scopeKey", "scope",
    "accountId", "groupJoinedAt", "runId", "sourceMessageId", "quoteMessageId",
    "mode", "targetMessageId", "text", "textDigest", "authority", "status", "stateRevision",
    "externalMessageId", "preparedAt", "settledAt",
  ], "delivery effect");
  const effect = value as GroupCodingDeliveryEffect;
  assertExactKeys(effect.scope, ["channel", "groupId"], "delivery effect.scope");
  assertExactKeys(
    effect.authority,
    ["expectedAuthorityEpoch", "actors"],
    "delivery effect.authority",
  );
  if (
    effect.version !== 1 || effect.scope.channel !== "whatsapp" ||
    effect.scopeKey !== groupScopeKey(effect.scope) ||
    !digest(effect.commandDigest) || !digest(effect.textDigest) ||
    sha256(effect.text) !== effect.textDigest ||
    (effect.purpose !== "command_reply" && effect.purpose !== "anchor_progress" &&
      effect.purpose !== "terminal_result") ||
    (effect.status !== "prepared" && effect.status !== "committed" &&
      effect.status !== "not_committed" && effect.status !== "unknown") ||
    !Number.isSafeInteger(effect.stateRevision) || effect.stateRevision < 1 ||
    !Number.isSafeInteger(effect.authority.expectedAuthorityEpoch) ||
    effect.authority.expectedAuthorityEpoch < 1 ||
    !Array.isArray(effect.authority.actors) || effect.authority.actors.length < 1 ||
    effect.authority.actors.length > 8 || effect.text.length > 12_000 ||
    !effect.text.trim() || containsSecretLikeValue(effect.text)
  ) throw new Error("Delivery effect group-coding tidak sah.");
  for (const [field, item] of [
    ["delivery.effectId", effect.effectId], ["delivery.scopeKey", effect.scopeKey],
    ["delivery.groupId", effect.scope.groupId], ["delivery.accountId", effect.accountId],
    ["delivery.sourceMessageId", effect.sourceMessageId],
  ] as const) safeKey(item, field);
  if (effect.runId !== null) safeKey(effect.runId, "delivery.runId");
  if (effect.quoteMessageId !== null) {
    safeKey(effect.quoteMessageId, "delivery.quoteMessageId");
  }
  if (effect.externalMessageId !== null) {
    safeKey(effect.externalMessageId, "delivery.externalMessageId");
  }
  if (
    (effect.mode !== "send" && effect.mode !== "edit") ||
    (effect.mode === "send" && effect.targetMessageId !== null) ||
    (effect.mode === "edit" && effect.targetMessageId === null)
  ) throw new Error("Mode delivery effect group-coding tidak konsisten.");
  if (effect.targetMessageId !== null) {
    safeKey(effect.targetMessageId, "delivery.targetMessageId");
  }
  for (const actor of effect.authority.actors) {
    assertExactKeys(actor, ["participantIds", "expectedRole"], "delivery actor");
    if (
      (actor.expectedRole !== "member" && actor.expectedRole !== "admin") ||
      !Array.isArray(actor.participantIds) || actor.participantIds.length < 1 ||
      actor.participantIds.length > 16 ||
      new Set(actor.participantIds).size !== actor.participantIds.length
    ) throw new Error("Authority actor delivery group-coding tidak sah.");
    actor.participantIds.forEach((id) => safeKey(id, "delivery participantId"));
  }
  validIso(effect.groupJoinedAt, "delivery.groupJoinedAt");
  validIso(effect.preparedAt, "delivery.preparedAt");
  if (effect.settledAt !== null) validIso(effect.settledAt, "delivery.settledAt");
  if (
    effect.status === "prepared"
      ? effect.externalMessageId !== null || effect.settledAt !== null
      : effect.settledAt === null ||
        (effect.status === "committed") !== (effect.externalMessageId !== null)
  ) throw new Error("Settlement delivery effect group-coding tidak konsisten.");
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

function assertDeliveryTransition(
  current: GroupCodingDeliveryEffect,
  next: GroupCodingDeliveryEffect,
): void {
  const immutable = [
    "version", "effectId", "commandDigest", "purpose", "scopeKey", "scope",
    "accountId", "groupJoinedAt", "runId", "sourceMessageId", "quoteMessageId",
    "mode", "targetMessageId", "text", "textDigest", "authority",
  ] as const;
  if (immutable.some((field) =>
    canonicalJson(current[field]) !== canonicalJson(next[field])
  )) throw new Error("Binding immutable delivery effect group-coding berubah.");
  const permitted =
    (current.status === "prepared" &&
      (next.status === "committed" || next.status === "not_committed" ||
        next.status === "unknown")) ||
    (current.status === "not_committed" && next.status === "prepared");
  if (!permitted) {
    throw new Error("Transisi delivery effect group-coding tidak sah.");
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
  const linkRequestIds = new Set<string>();
  for (const request of database.linkRequests) {
    validateLinkRequest(request);
    if (linkRequestIds.has(request.requestId)) {
      throw new Error("Request link group-coding duplikat.");
    }
    linkRequestIds.add(request.requestId);
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
  const deliveryEffects = new Set<string>();
  for (const effect of database.deliveryEffects) {
    validateDeliveryEffect(effect);
    if (deliveryEffects.has(effect.effectId)) {
      throw new Error("Delivery effect group-coding duplikat.");
    }
    deliveryEffects.add(effect.effectId);
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
