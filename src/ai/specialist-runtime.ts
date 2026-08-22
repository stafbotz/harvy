import type { AiClient } from "./client.js";
import type { RoutingConfig } from "./conversation.js";
import {
  resolveModelRoute,
  type CognitiveModelRole,
} from "./model-policy.js";
import { resolveModelRouteProfile } from "./model-profile.js";
import { createModelSpecialistWorker } from "./specialist.js";
import {
  SPECIALIST_ROLES,
  SpecialistDelegationExecutor,
} from "../agent/specialist-delegation.js";

export const SPECIALIST_COMPOSITION_ERROR_CODE =
  "CONFIG_AI_SPECIALIST_DELEGATION_INVALID";

const EXACT_DISTINCT_ROLES = Object.freeze([
  "everyday_conversation",
  "orchestrator",
  "heavy_executor",
  "verifier",
  "challenger",
] as const satisfies readonly CognitiveModelRole[]);

/**
 * Production composition tetap default-off. Saat diaktifkan, startup gagal
 * tertutup kecuali role kritis mempunyai model exact, profile explicit, dan
 * diversity nyata; tier fallback tidak boleh menyamar sebagai specialist.
 */
export function createConfiguredSpecialistExecutor(
  client: Pick<AiClient, "complete">,
  routing: RoutingConfig,
  enabled: boolean,
): SpecialistDelegationExecutor | null {
  if (!enabled) return null;
  assertSpecialistCompositionReady(routing);
  return new SpecialistDelegationExecutor(
    createModelSpecialistWorker(client, routing),
    SPECIALIST_ROLES,
    ({ context }) => {
      const remaining = context.runBudget.view(context.step);
      if (
        context.runBudget.isTimeExhausted() ||
        context.runBudget.workOverageReason() !== null ||
        remaining.remainingModelCalls < 1 ||
        remaining.remainingWorkTokens < 1
      ) {
        return { decision: "deny", code: "budget_unavailable" };
      }
      return { decision: "allow" };
    },
  );
}

export function assertSpecialistCompositionReady(
  routing: RoutingConfig,
): void {
  if (!routing.providerId || !routing.modelProfiles) {
    invalidComposition(
      "Provider dan registry profile exact wajib tersedia.",
    );
  }

  const exactModels = new Map<CognitiveModelRole, string>();
  for (const role of EXACT_DISTINCT_ROLES) {
    const modelId = routing.roleBindings?.[role]?.modelId?.trim();
    if (!modelId) {
      invalidComposition(`Role ${role} wajib mempunyai exact model binding.`);
    }
    exactModels.set(role, modelId);
    const profile = explicitProfile(role, routing);
    if (role === "orchestrator") {
      if (
        !profile.supports.tools || !profile.supports.toolChoice ||
        !profile.supports.namedToolChoice
      ) {
        invalidComposition(
          "Profile orchestrator wajib mendukung tools dan named tool choice.",
        );
      }
    }
  }

  if (new Set(exactModels.values()).size !== EXACT_DISTINCT_ROLES.length) {
    invalidComposition(
      "Role conversation/orchestrator/heavy/verifier/challenger harus memakai model exact yang berbeda.",
    );
  }

  for (const role of SPECIALIST_ROLES) {
    const profile = explicitProfile(role, routing);
    if (!profile.supports.structuredOutput) {
      invalidComposition(
        `Profile specialist ${role} wajib mendukung structured output.`,
      );
    }
  }
}

function explicitProfile(role: CognitiveModelRole, routing: RoutingConfig) {
  try {
    const route = resolveModelRoute(role, routing);
    const profile = resolveModelRouteProfile(route, routing);
    if (!profile || profile.verification !== "explicit") {
      invalidComposition(`Role ${role} wajib mempunyai profile explicit.`);
    }
    return profile;
  } catch (error) {
    if (error instanceof SpecialistCompositionError) throw error;
    invalidComposition(`Profile exact untuk role ${role} tidak tersedia.`);
  }
}

export class SpecialistCompositionError extends Error {
  readonly code = SPECIALIST_COMPOSITION_ERROR_CODE;

  constructor(message: string) {
    super(`${SPECIALIST_COMPOSITION_ERROR_CODE}: ${message}`);
    this.name = "SpecialistCompositionError";
  }
}

function invalidComposition(message: string): never {
  throw new SpecialistCompositionError(message);
}
