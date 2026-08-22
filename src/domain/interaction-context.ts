import type {
  SemanticDomain,
  SemanticOperationName,
  SemanticReference,
} from "./semantic-operation.js";

/**
 * Privacy-safe reference to a recently rendered surface.
 *
 * It intentionally contains no raw message, response, account value, memory,
 * task title, credential, storage ID, or provider/model detail.
 */
export interface TransientInteractionContext {
  version: 1;
  domain: SemanticDomain;
  operation: SemanticOperationName;
  reference: Exclude<SemanticReference, "quoted">;
  createdAt: string;
  expiresAt: string;
  generation: number;
}
