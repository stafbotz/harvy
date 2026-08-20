import { randomBytes } from "node:crypto";
import type {
  GitHubConfirmationAuthority,
  GitHubConfirmationBinding,
  GitHubConfirmationGrant,
  GitHubExactEffect,
  GitHubInteractiveAction,
  GitHubInteractiveAuthority,
  GitHubInteractiveBinding,
  GitHubInteractiveGrant,
} from "../domain/github.js";
import type { WorkspaceAgentScope } from "../harness/scope.js";
import { effectDigest } from "./github-broker.js";

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_PENDING = 4_096;

type PendingGrant =
  | { kind: "interactive"; grant: GitHubInteractiveGrant; binding: GitHubInteractiveBinding }
  | { kind: "effect"; grant: GitHubConfirmationGrant; binding: GitHubConfirmationBinding };

/** Process-private exact confirmation vault. Chat receives only UI callback IDs. */
export class PrivateGitHubConfirmationController
  implements GitHubInteractiveAuthority, GitHubConfirmationAuthority {
  readonly #pending = new Map<string, PendingGrant>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60_000) {
      throw new Error("TTL confirmation GitHub tidak sah.");
    }
  }

  issueInteractive(
    scope: WorkspaceAgentScope,
    interactionId: string,
    input: {
      action: GitHubInteractiveAction;
      connectionId: string | null;
      repositoryId: string | null;
      selectionId: string | null;
    },
  ): GitHubInteractiveGrant {
    const grant = this.#grant(interactionId);
    const interactive: GitHubInteractiveGrant = { ...grant };
    this.#pending.set(interactive.proof, {
      kind: "interactive",
      grant: interactive,
      binding: {
        action: input.action,
        interactionId: interactive.interactionId,
        audience: "workspace-private",
        ownerWorkspaceKey: scope.workspaceKey,
        membershipId: scope.membershipId,
        aclEpoch: scope.aclEpoch,
        connectionId: input.connectionId,
        repositoryId: input.repositoryId,
        selectionId: input.selectionId,
      },
    });
    this.#prune();
    return structuredClone(interactive);
  }

  issueEffect(
    scope: WorkspaceAgentScope,
    interactionId: string,
    effect: GitHubExactEffect,
  ): GitHubConfirmationGrant {
    const grant: GitHubConfirmationGrant = this.#grant(interactionId);
    this.#pending.set(grant.proof, {
      kind: "effect",
      grant,
      binding: {
        effectId: effect.effectId,
        effectDigest: effectDigest(effect),
        capability: effect.capability,
        interactionId: grant.interactionId,
        audience: "workspace-private",
        ownerWorkspaceKey: scope.workspaceKey,
        membershipId: scope.membershipId,
        aclEpoch: scope.aclEpoch,
      },
    });
    this.#prune();
    return structuredClone(grant);
  }

  async verify(
    grant: GitHubInteractiveGrant | GitHubConfirmationGrant,
    binding: GitHubInteractiveBinding | GitHubConfirmationBinding,
  ): Promise<boolean> {
    const pending = this.#pending.get(grant.proof);
    if (!pending || Date.parse(pending.grant.expiresAt) <= this.now().getTime()) {
      this.#pending.delete(grant.proof);
      return false;
    }
    return JSON.stringify(pending.grant) === JSON.stringify(grant) &&
      JSON.stringify(pending.binding) === JSON.stringify(binding);
  }

  #grant(interactionId: string): GitHubInteractiveGrant {
    if (
      typeof interactionId !== "string" || !interactionId ||
      interactionId.length > 512 || /\p{Cc}/u.test(interactionId)
    ) throw new Error("Interaction ID confirmation GitHub tidak sah.");
    const now = this.now();
    return {
      confirmationId: `github-confirmation-${randomBytes(16).toString("hex")}`,
      interactionId,
      audience: "workspace-private",
      proof: randomBytes(32).toString("base64url"),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
  }

  #prune(): void {
    const now = this.now().getTime();
    for (const [proof, pending] of this.#pending) {
      if (Date.parse(pending.grant.expiresAt) <= now) this.#pending.delete(proof);
    }
    while (this.#pending.size > MAX_PENDING) {
      const oldest = this.#pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#pending.delete(oldest);
    }
  }
}
