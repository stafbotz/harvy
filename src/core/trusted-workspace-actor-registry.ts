import type {
  AuthenticatedWorkspaceActor,
  ResolvedWorkspaceActor,
  WorkspaceActorResolver,
} from "./workspace-coding-controller.js";
import type { WorkspacePrincipal } from "../domain/workspace.js";

/**
 * Actor handles are object capabilities issued inside an authenticated ingress
 * callback. They cannot be reconstructed from JSON, model output, or command
 * text because resolution is backed by a WeakMap identity check.
 */
export class TrustedWorkspaceActorRegistry implements WorkspaceActorResolver {
  readonly #actors = new WeakMap<object, ResolvedWorkspaceActor>();

  issue(input: {
    principal: WorkspacePrincipal;
    interactionId: string;
    audience: ResolvedWorkspaceActor["audience"];
  }): AuthenticatedWorkspaceActor {
    const handle = Object.freeze({});
    this.#actors.set(handle, structuredClone(input));
    return handle as AuthenticatedWorkspaceActor;
  }

  async resolve(
    actor: AuthenticatedWorkspaceActor,
  ): Promise<ResolvedWorkspaceActor | null> {
    if (!actor || typeof actor !== "object") return null;
    const resolved = this.#actors.get(actor as object);
    return resolved ? structuredClone(resolved) : null;
  }
}
