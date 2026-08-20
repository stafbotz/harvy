import { createHash } from "node:crypto";
import type { GroupMessage } from "../domain/group.js";
import type { WorkspacePrincipal } from "../domain/workspace.js";
import type {
  AuthenticatedGroupCodingActor,
  GroupCodingActorResolver,
  ResolvedGroupCodingActor,
} from "./group-workspace-coding-controller.js";
import { containsSecretLikeValue } from "../security/credential-like.js";

/** Object-capability registry populated only after trusted group ingress. */
export class TrustedGroupCodingActorRegistry implements GroupCodingActorResolver {
  readonly #actors = new WeakMap<object, ResolvedGroupCodingActor>();

  issue(message: GroupMessage, principal: WorkspacePrincipal): AuthenticatedGroupCodingActor {
    if (
      message.scope.channel !== "whatsapp" ||
      !Number.isSafeInteger(message.authorityEpoch) ||
      (message.authorityEpoch ?? 0) < 1 ||
      !Number.isSafeInteger(message.ingressRevision) ||
      (message.ingressRevision ?? 0) < 1
    ) throw new Error("Group coding actor hanya dapat diterbitkan dari ingress live.");
    const participantIds = [...new Set([
      safeKey(message.participantId, "participantId"),
      ...message.participantAliases.map((id) => safeKey(id, "participant alias")),
    ])].slice(0, 16);
    const handle = Object.freeze(Object.create(null)) as object;
    this.#actors.set(handle, Object.freeze({
      audience: "group" as const,
      interactionId: `group-coding-interaction-${digest([
        message.accountId,
        message.scope.groupId,
        message.messageId,
      ].join("\0"))}`,
      principal: structuredClone(principal),
      scope: structuredClone(message.scope),
      accountId: safeKey(message.accountId, "accountId"),
      participantIds: Object.freeze(participantIds),
      claimedAdmin: message.isAdmin,
      claimedAuthorityEpoch: message.authorityEpoch!,
    }));
    return handle as AuthenticatedGroupCodingActor;
  }

  async resolve(
    actor: AuthenticatedGroupCodingActor,
  ): Promise<ResolvedGroupCodingActor | null> {
    const resolved = actor && typeof actor === "object"
      ? this.#actors.get(actor as object)
      : null;
    return resolved ? structuredClone(resolved) : null;
  }
}

function safeKey(value: string, field: string): string {
  if (
    !value || value.length > 512 || /\p{Cc}/u.test(value) || /[\\/]/u.test(value) ||
    containsSecretLikeValue(value)
  ) throw new Error(`${field} group coding tidak sah.`);
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
