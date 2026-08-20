import { createHash } from "node:crypto";
import type { CodingRun } from "../domain/coding-run.js";
import type { GroupMessage } from "../domain/group.js";
import { groupScopeKey } from "../domain/group.js";
import type {
  GroupCodingDeliveryEffect,
  GroupCodingDeliveryPurpose,
  GroupCodingRepository,
  GroupCodingRunReference,
} from "../domain/group-coding.js";
import { renderGroupSafeCodingRun } from "../domain/group-coding.js";
import { GroupAgentRunDeliveryNotCommittedError } from
  "./group-agent-run-service.js";
import type {
  GroupCodingIngressTransport,
  GroupCodingRuntimeAdmission,
} from "./group-coding-ingress.js";
import type { GroupRuntimeBindingReader } from
  "./group-workspace-coding-controller.js";

export interface GroupCodingDeliveryResult {
  effectId: string;
  status: "committed";
  externalMessageId: string;
  replayed: boolean;
}

export interface GroupCodingDeliveryRecoveryReport {
  preparedFound: number;
  closedUnknown: number;
}

/**
 * Durable exact-effect barrier around WhatsApp group-safe coding messages.
 * Unknown effects are terminal: without a provider-side receipt lookup, a
 * possibly committed socket send is never replayed automatically.
 */
export class GroupCodingDeliveryService {
  constructor(
    private readonly repository: GroupCodingRepository,
    private readonly transport: GroupCodingIngressTransport,
    private readonly runtimeAdmission: GroupCodingRuntimeAdmission,
    private readonly bindings: GroupRuntimeBindingReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(input: {
    message: GroupMessage;
    commandDigest: string;
    purpose: GroupCodingDeliveryPurpose;
    text: string;
    runId?: string | null;
  }): Promise<GroupCodingDeliveryResult> {
    const { message } = input;
    const scopeKey = groupScopeKey(message.scope);
    const binding = await this.bindings.binding(scopeKey);
    if (
      !binding || binding.disabledAt !== null ||
      binding.accountId !== message.accountId ||
      binding.channel !== message.scope.channel ||
      binding.groupId !== message.scope.groupId
    ) {
      throw new GroupCodingDeliveryNotCommittedError(
        "Delivery group-coding tidak mempunyai binding grup durable yang current.",
      );
    }
    const effectId = groupCodingDeliveryEffectId(message, input.commandDigest);
    let current = await this.repository.loadDeliveryEffect(effectId);
    if (current) {
      assertExactDelivery(current, input, binding.joinedAt);
      if (current.status === "committed" && current.externalMessageId) {
        return {
          effectId,
          status: "committed",
          externalMessageId: current.externalMessageId,
          replayed: true,
        };
      }
      if (current.status === "unknown") throw new GroupCodingDeliveryUnknownError();
      if (current.status === "prepared") {
        await this.settle(current, "unknown", null);
        throw new GroupCodingDeliveryUnknownError();
      }
    }

    const at = this.now().toISOString();
    const preparedInput: Omit<GroupCodingDeliveryEffect, "stateRevision"> = {
      version: 1,
      effectId,
      commandDigest: input.commandDigest,
      purpose: input.purpose,
      scopeKey,
      scope: structuredClone(message.scope),
      accountId: message.accountId,
      groupJoinedAt: binding.joinedAt,
      runId: input.runId ?? null,
      sourceMessageId: message.messageId,
      quoteMessageId: message.messageId,
      mode: "send",
      targetMessageId: null,
      text: input.text.trim(),
      textDigest: sha256(input.text.trim()),
      authority: {
        expectedAuthorityEpoch: message.authorityEpoch!,
        actors: [{
          participantIds: [...new Set([
            message.participantId,
            ...message.participantAliases,
          ])],
          expectedRole: message.isAdmin ? "admin" : "member",
        }],
      },
      status: "prepared",
      externalMessageId: null,
      preparedAt: at,
      settledAt: null,
    };
    const prepared = await this.repository.saveDeliveryEffect(
      preparedInput,
      current?.stateRevision ?? null,
    );
    if (prepared.status !== "saved") {
      current = await this.repository.loadDeliveryEffect(effectId);
      if (!current) throw new GroupCodingDeliveryUnknownError();
      assertExactDelivery(current, input, binding.joinedAt);
      if (current.status === "committed" && current.externalMessageId) {
        return {
          effectId,
          status: "committed",
          externalMessageId: current.externalMessageId,
          replayed: true,
        };
      }
      throw new GroupCodingDeliveryUnknownError();
    }

    try {
      const delivery = await this.transport.sendGroupRunMessage(
        { scope: message.scope, accountId: message.accountId },
        prepared.effect.text,
        prepared.effect.quoteMessageId ?? undefined,
        effectId,
        structuredClone(prepared.effect.authority),
        async () => this.runtimeAdmission({ scopeKey, accountId: message.accountId }),
      );
      const settled = await this.settle(
        prepared.effect,
        "committed",
        delivery.messageId,
      );
      return {
        effectId,
        status: "committed",
        externalMessageId: settled.externalMessageId!,
        replayed: false,
      };
    } catch (error) {
      if (error instanceof GroupAgentRunDeliveryNotCommittedError) {
        await this.settle(prepared.effect, "not_committed", null);
        throw new GroupCodingDeliveryNotCommittedError(error.message);
      }
      await this.settle(prepared.effect, "unknown", null).catch(() => undefined);
      throw new GroupCodingDeliveryUnknownError(undefined, { cause: error });
    }
  }

  async anchoredRunIds(): Promise<string[]> {
    const references = await this.repository.listRunReferences();
    const effects = await this.repository.listDeliveryEffects("committed");
    const anchored = new Set(
      effects.filter((effect) =>
        effect.purpose === "command_reply" && effect.mode === "send" &&
        effect.runId !== null && effect.externalMessageId !== null
      ).map((effect) => effect.runId!),
    );
    return references.map((reference) => reference.runId)
      .filter((runId) => anchored.has(runId));
  }

  /** Edits the original group-safe message; raw run details never cross this projection. */
  async deliverRunUpdate(run: CodingRun): Promise<GroupCodingDeliveryResult> {
    const reference = await this.repository.loadRunReference(run.runId);
    if (!reference) {
      throw new GroupCodingDeliveryNotCommittedError(
        "Reference audience Group CodingRun tidak tersedia.",
      );
    }
    assertRunMatchesReference(run, reference);
    const anchor = await this.anchorEffect(reference);
    const link = await this.repository.loadLink(reference.scopeKey, reference.accountId);
    const binding = await this.bindings.binding(reference.scopeKey);
    if (
      !link || link.status !== "active" || link.linkId !== reference.linkId ||
      link.stateRevision !== reference.linkStateRevision ||
      link.groupJoinedAt !== reference.groupJoinedAt ||
      !binding || binding.disabledAt !== null ||
      binding.accountId !== reference.accountId ||
      binding.joinedAt !== reference.groupJoinedAt ||
      !await this.runtimeAdmission({
        scopeKey: reference.scopeKey,
        accountId: reference.accountId,
      })
    ) {
      throw new GroupCodingDeliveryNotCommittedError(
        "Authority atau runtime Group CodingRun tidak lagi current.",
      );
    }
    const view = renderGroupSafeCodingRun(run);
    const purpose: GroupCodingDeliveryPurpose = terminalCodingRun(run)
      ? "terminal_result"
      : "anchor_progress";
    const commandDigest = sha256(canonicalJson({
      version: 1,
      runId: run.runId,
      stateRevision: run.stateRevision,
      instructionRevision: run.instructionRevision,
      status: run.status,
      phase: run.phase,
      purpose,
      textDigest: sha256(view.text),
      anchorMessageId: anchor.externalMessageId,
    }));
    const effectId = groupCodingDeliveryEffectId({
      accountId: anchor.accountId,
      scope: anchor.scope,
      messageId: anchor.sourceMessageId,
    }, commandDigest);
    let current = await this.repository.loadDeliveryEffect(effectId);
    if (current) {
      assertExactRunUpdate(
        current,
        reference,
        anchor,
        commandDigest,
        purpose,
        view.text,
      );
      if (current.status === "committed" && current.externalMessageId) {
        return {
          effectId,
          status: "committed",
          externalMessageId: current.externalMessageId,
          replayed: true,
        };
      }
      if (current.status === "unknown") throw new GroupCodingDeliveryUnknownError();
      if (current.status === "prepared") {
        await this.settle(current, "unknown", null);
        throw new GroupCodingDeliveryUnknownError();
      }
    }
    const at = this.now().toISOString();
    const preparedInput: Omit<GroupCodingDeliveryEffect, "stateRevision"> = {
      version: 1,
      effectId,
      commandDigest,
      purpose,
      scopeKey: reference.scopeKey,
      scope: structuredClone(anchor.scope),
      accountId: reference.accountId,
      groupJoinedAt: reference.groupJoinedAt,
      runId: run.runId,
      sourceMessageId: anchor.sourceMessageId,
      quoteMessageId: null,
      mode: "edit",
      targetMessageId: anchor.externalMessageId!,
      text: view.text,
      textDigest: sha256(view.text),
      authority: structuredClone(anchor.authority),
      status: "prepared",
      externalMessageId: null,
      preparedAt: at,
      settledAt: null,
    };
    const prepared = await this.repository.saveDeliveryEffect(
      preparedInput,
      current?.stateRevision ?? null,
    );
    if (prepared.status !== "saved") {
      current = await this.repository.loadDeliveryEffect(effectId);
      if (!current) throw new GroupCodingDeliveryUnknownError();
      assertExactRunUpdate(
        current,
        reference,
        anchor,
        commandDigest,
        purpose,
        view.text,
      );
      if (current.status === "committed" && current.externalMessageId) {
        return {
          effectId,
          status: "committed",
          externalMessageId: current.externalMessageId,
          replayed: true,
        };
      }
      throw new GroupCodingDeliveryUnknownError();
    }
    try {
      const delivery = await this.transport.editGroupRunMessage(
        { scope: prepared.effect.scope, accountId: prepared.effect.accountId },
        prepared.effect.text,
        prepared.effect.targetMessageId!,
        effectId,
        structuredClone(prepared.effect.authority),
        async () => this.runtimeAdmission({
          scopeKey: reference.scopeKey,
          accountId: reference.accountId,
        }),
      );
      const settled = await this.settle(
        prepared.effect,
        "committed",
        delivery.messageId,
      );
      return {
        effectId,
        status: "committed",
        externalMessageId: settled.externalMessageId!,
        replayed: false,
      };
    } catch (error) {
      if (error instanceof GroupAgentRunDeliveryNotCommittedError) {
        await this.settle(prepared.effect, "not_committed", null);
        throw new GroupCodingDeliveryNotCommittedError(error.message);
      }
      await this.settle(prepared.effect, "unknown", null).catch(() => undefined);
      throw new GroupCodingDeliveryUnknownError(undefined, { cause: error });
    }
  }

  async recoverPrepared(): Promise<GroupCodingDeliveryRecoveryReport> {
    const prepared = await this.repository.listDeliveryEffects("prepared");
    let closedUnknown = 0;
    for (const effect of prepared) {
      const current = await this.repository.loadDeliveryEffect(effect.effectId);
      if (!current || current.status !== "prepared") continue;
      await this.settle(current, "unknown", null);
      closedUnknown += 1;
    }
    return { preparedFound: prepared.length, closedUnknown };
  }

  private async anchorEffect(
    reference: GroupCodingRunReference,
  ): Promise<GroupCodingDeliveryEffect> {
    const candidates = (await this.repository.listDeliveryEffects("committed"))
      .filter((effect) =>
        effect.runId === reference.runId && effect.purpose === "command_reply" &&
        effect.mode === "send" && effect.externalMessageId !== null &&
        effect.scopeKey === reference.scopeKey &&
        effect.accountId === reference.accountId &&
        effect.groupJoinedAt === reference.groupJoinedAt
      )
      .sort((left, right) => left.preparedAt.localeCompare(right.preparedAt));
    const anchor = candidates[0];
    if (!anchor) {
      throw new GroupCodingDeliveryNotCommittedError(
        "Anchor awal Group CodingRun belum mempunyai receipt committed.",
      );
    }
    return anchor;
  }

  private async settle(
    current: GroupCodingDeliveryEffect,
    status: "committed" | "not_committed" | "unknown",
    externalMessageId: string | null,
  ): Promise<GroupCodingDeliveryEffect> {
    const saved = await this.repository.saveDeliveryEffect({
      ...withoutRevision(current),
      status,
      externalMessageId,
      settledAt: this.now().toISOString(),
    }, current.stateRevision);
    if (saved.status === "saved") return saved.effect;
    const replay = await this.repository.loadDeliveryEffect(current.effectId);
    if (
      replay?.status === status &&
      replay.externalMessageId === externalMessageId
    ) return replay;
    throw new GroupCodingDeliveryUnknownError();
  }
}

export class GroupCodingDeliveryNotCommittedError extends Error {
  constructor(message = "Delivery group-coding ditolak sebelum socket send.") {
    super(message);
    this.name = "GroupCodingDeliveryNotCommittedError";
  }
}

export class GroupCodingDeliveryUnknownError extends Error {
  constructor(
    message = "Hasil delivery group-coding ambigu dan tidak akan diulang otomatis.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GroupCodingDeliveryUnknownError";
  }
}

export function groupCodingDeliveryEffectId(
  message: Pick<GroupMessage, "accountId" | "scope" | "messageId">,
  commandDigest: string,
): string {
  if (!/^[a-f0-9]{64}$/u.test(commandDigest)) {
    throw new Error("Command digest delivery group-coding tidak sah.");
  }
  return `group-coding-delivery-${sha256([
    message.accountId,
    groupScopeKey(message.scope),
    message.messageId,
    commandDigest,
  ].join("\0"))}`;
}

function assertExactDelivery(
  effect: GroupCodingDeliveryEffect,
  input: {
    message: GroupMessage;
    commandDigest: string;
    purpose: GroupCodingDeliveryPurpose;
    text: string;
    runId?: string | null;
  },
  groupJoinedAt: string,
): void {
  const participantIds = [...new Set([
    input.message.participantId,
    ...input.message.participantAliases,
  ])];
  if (
    effect.commandDigest !== input.commandDigest ||
    effect.purpose !== input.purpose ||
    effect.scopeKey !== groupScopeKey(input.message.scope) ||
    effect.accountId !== input.message.accountId ||
    effect.groupJoinedAt !== groupJoinedAt ||
    effect.runId !== (input.runId ?? null) ||
    effect.sourceMessageId !== input.message.messageId ||
    effect.quoteMessageId !== input.message.messageId ||
    effect.mode !== "send" || effect.targetMessageId !== null ||
    effect.text !== input.text.trim() ||
    effect.textDigest !== sha256(input.text.trim()) ||
    effect.authority.expectedAuthorityEpoch !== input.message.authorityEpoch ||
    effect.authority.actors.length !== 1 ||
    effect.authority.actors[0]!.expectedRole !==
      (input.message.isAdmin ? "admin" : "member") ||
    canonicalJson(effect.authority.actors[0]!.participantIds) !==
      canonicalJson(participantIds)
  ) throw new Error("Replay delivery group-coding bertabrakan dengan effect exact lain.");
}

function assertRunMatchesReference(
  run: CodingRun,
  reference: GroupCodingRunReference,
): void {
  if (
    run.runId !== reference.runId ||
    run.binding.ownerWorkspaceKey !== reference.workspaceKey ||
    run.binding.projectId !== reference.projectId ||
    run.admission?.source !== "group" ||
    run.admission.effectId !== reference.effectId ||
    run.admission.authorityRef !== reference.linkId ||
    run.admission.audience !== "group-safe"
  ) throw new Error("CodingRun tidak cocok reference audience grup.");
}

function assertExactRunUpdate(
  effect: GroupCodingDeliveryEffect,
  reference: GroupCodingRunReference,
  anchor: GroupCodingDeliveryEffect,
  commandDigest: string,
  purpose: GroupCodingDeliveryPurpose,
  text: string,
): void {
  if (
    effect.commandDigest !== commandDigest || effect.purpose !== purpose ||
    effect.scopeKey !== reference.scopeKey || effect.accountId !== reference.accountId ||
    effect.groupJoinedAt !== reference.groupJoinedAt || effect.runId !== reference.runId ||
    effect.sourceMessageId !== anchor.sourceMessageId || effect.quoteMessageId !== null ||
    effect.mode !== "edit" || effect.targetMessageId !== anchor.externalMessageId ||
    effect.text !== text || effect.textDigest !== sha256(text) ||
    canonicalJson(effect.scope) !== canonicalJson(anchor.scope) ||
    canonicalJson(effect.authority) !== canonicalJson(anchor.authority)
  ) throw new Error("Replay update anchor group-coding bertabrakan dengan effect exact lain.");
}

function terminalCodingRun(run: Pick<CodingRun, "status">): boolean {
  return run.status === "completed" || run.status === "failed" ||
    run.status === "cancelled" || run.status === "stale" ||
    run.status === "partial";
}

function withoutRevision(
  effect: GroupCodingDeliveryEffect,
): Omit<GroupCodingDeliveryEffect, "stateRevision"> {
  const { stateRevision: _revision, ...rest } = effect;
  return rest;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}
