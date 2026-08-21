import type { CognitiveModelRole } from "../ai/model-policy.js";
import {
  parseAgentHandoff,
  parseWorkBrief,
  type AgentHandoff,
  type WorkBrief,
} from "../domain/agent-handoff.js";
import type {
  AgentCapabilityExecutor,
  AgentExecutionContext,
  AgentExecutorResult,
  AgentNativeToolDefinition,
} from "../harness/agent-harness.js";

export type SpecialistRole = Extract<
  CognitiveModelRole,
  "strong_worker" | "heavy_executor" | "verifier" | "challenger"
>;

export interface SpecialistRequest {
  role: SpecialistRole;
  brief: WorkBrief;
}

export interface SpecialistWorkerContext {
  runId: string;
  ownerId: string;
  role: SpecialistRole;
  signal: AbortSignal;
  runBudget: AgentExecutionContext["runBudget"];
}

export type SpecialistWorker = (
  request: SpecialistRequest,
  context: SpecialistWorkerContext,
) => Promise<AgentHandoff>;

export type SpecialistAuthorizationPolicy = (input: {
  request: SpecialistRequest;
  context: AgentExecutionContext;
}) =>
  | { decision: "allow" }
  | { decision: "deny"; code: SpecialistDenialCode }
  | Promise<
      { decision: "allow" } |
      { decision: "deny"; code: SpecialistDenialCode }
    >;

export type SpecialistDenialCode =
  | "policy_unavailable"
  | "role_unavailable"
  | "privacy_domain_denied"
  | "budget_unavailable"
  | "objective_validation_sufficient";

const SPECIALIST_ROLES: readonly SpecialistRole[] = [
  "strong_worker",
  "heavy_executor",
  "verifier",
  "challenger",
];
const MAX_SUMMARY_CHARACTERS = 3_600;

const SPECIALIST_NATIVE_TOOL = {
  name: "harvy_agent_delegate_specialist_v1",
  description: [
    "Minta tepat satu specialist read-only memakai WorkBrief provider-neutral.",
    "Isi brief.originalRequestRef persis dari workBriefRef pada agent-input; jangan menebaknya.",
    "Gunakan heavy_executor untuk eksekusi berat, verifier untuk verifikasi independen,",
    "challenger untuk perspektif/trade-off yang mungkin terlewat, atau strong_worker",
    "untuk satu pekerjaan menengah. Jangan gunakan sebagai ritual bila hasil tool",
    "deterministik sudah cukup atau orkestrator dapat menyelesaikan sendiri.",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      role: { type: "string", enum: SPECIALIST_ROLES },
      brief: {
        type: "object",
        additionalProperties: false,
        properties: {
          version: { type: "integer", enum: [1] },
          goal: { type: "string", minLength: 1, maxLength: 2_000 },
          originalRequestRef: { type: "string", minLength: 1, maxLength: 128 },
          facts: stringArraySchema(24, 1_000),
          constraints: stringArraySchema(24, 1_000),
          evidence: {
            type: "array",
            maxItems: 24,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1, maxLength: 128 },
                source: {
                  type: "string",
                  enum: ["user_request", "tool_observation", "validator", "code"],
                },
                summary: { type: "string", minLength: 1, maxLength: 1_500 },
              },
              required: ["id", "source", "summary"],
            },
          },
          assumptions: stringArraySchema(16, 1_000),
          plan: stringArraySchema(24, 1_000),
          openQuestions: stringArraySchema(16, 1_000),
          acceptanceCriteria: stringArraySchema(24, 1_000),
          requestedCapabilities: {
            type: "array",
            maxItems: 16,
            items: { type: "string", minLength: 3, maxLength: 128 },
          },
        },
        required: [
          "version",
          "goal",
          "originalRequestRef",
          "facts",
          "constraints",
          "evidence",
          "assumptions",
          "plan",
          "openQuestions",
          "acceptanceCriteria",
          "requestedCapabilities",
        ],
      },
    },
    required: ["role", "brief"],
  },
} satisfies AgentNativeToolDefinition;

/**
 * Satu-hop specialist boundary. Worker tidak menerima harness, tool registry,
 * memory, provider continuation, credential, atau API delegasi.
 */
export class SpecialistDelegationExecutor
implements AgentCapabilityExecutor<SpecialistRequest> {
  readonly capabilityId = "agent.delegate.specialist";
  readonly capabilityVersion = "1";
  readonly nativeTool = SPECIALIST_NATIVE_TOOL;
  private readonly allowedRoles: ReadonlySet<SpecialistRole>;

  constructor(
    private readonly worker: SpecialistWorker,
    allowedRoles: readonly SpecialistRole[] = SPECIALIST_ROLES,
    private readonly authorize: SpecialistAuthorizationPolicy = () => ({
      decision: "deny",
      code: "policy_unavailable",
    }),
  ) {
    if (
      allowedRoles.length === 0 || new Set(allowedRoles).size !== allowedRoles.length ||
      allowedRoles.some((role) => !SPECIALIST_ROLES.includes(role))
    ) throw new Error("Daftar specialist yang diizinkan tidak sah.");
    this.allowedRoles = new Set(allowedRoles);
  }

  validate(input: unknown) {
    if (!exactRecord(input, ["role", "brief"])) {
      return { ok: false as const, reason: "Request specialist hanya boleh memuat role dan brief." };
    }
    const role = typeof input.role === "string" &&
        SPECIALIST_ROLES.includes(input.role as SpecialistRole)
      ? input.role as SpecialistRole
      : null;
    const brief = parseWorkBrief(input.brief);
    if (!role || !this.allowedRoles.has(role) || !brief) {
      return {
        ok: false as const,
        reason: "Role specialist atau WorkBrief tidak sah/tidak diizinkan.",
      };
    }
    return { ok: true as const, value: { role, brief } };
  }

  async execute(
    input: SpecialistRequest,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    if (context.scope.kind !== "private" || context.scope.channel !== "telegram") {
      return failure(input.role, "Specialist hanya tersedia pada ruang privat Telegram.");
    }
    if (input.brief.originalRequestRef !== context.runId) {
      return failure(input.role, "WorkBrief tidak terikat ke run aktif.");
    }
    try {
      const authorization = await this.authorize({ request: input, context });
      if (authorization.decision === "deny") {
        return failure(
          input.role,
          `Specialist ditolak policy: ${authorization.code}.`,
        );
      }
      const result = parseAgentHandoff(await this.worker(input, {
        runId: context.runId,
        ownerId: context.scope.userId,
        role: input.role,
        signal: context.signal,
        runBudget: context.runBudget,
      }));
      if (!result || result.workBriefRef !== input.brief.originalRequestRef) {
        return failure(input.role, "Specialist mengembalikan handoff yang tidak sah.");
      }
      return {
        status: result.status === "failed" ? "error" : "ok",
        summary: boundedSummary(input.role, result),
      };
    } catch {
      return failure(input.role, "Specialist gagal sebelum handoff sah.");
    }
  }
}

function boundedSummary(role: SpecialistRole, handoff: AgentHandoff): string {
  const mutable = {
    ...handoff,
    facts: [...handoff.facts],
    evidence: [...handoff.evidence],
    assumptions: [...handoff.assumptions],
    plan: [...handoff.plan],
    openQuestions: [...handoff.openQuestions],
    provenance: [...handoff.provenance],
    failureCodes: [...handoff.failureCodes],
    workProduct: handoff.workProduct,
  };
  let serialized = JSON.stringify({
    kind: "agent.delegate.specialist.result",
    trust: "model-specialist-output-untrusted",
    depth: 1,
    recursiveDelegation: false,
    role,
    handoff: mutable,
  });
  if (serialized.length <= MAX_SUMMARY_CHARACTERS) return serialized;
  const overflow = serialized.length - MAX_SUMMARY_CHARACTERS;
  const product = mutable.workProduct ?? "";
  mutable.workProduct = product.slice(0, Math.max(0, product.length - overflow - 64));
  serialized = JSON.stringify({
    kind: "agent.delegate.specialist.result",
    trust: "model-specialist-output-untrusted",
    depth: 1,
    recursiveDelegation: false,
    role,
    handoff: mutable,
    truncated: true,
  });
  return serialized.length <= MAX_SUMMARY_CHARACTERS
    ? serialized
    : failureSummary(role, "Handoff specialist melebihi batas observation.");
}

function failure(role: SpecialistRole, reason: string): AgentExecutorResult {
  return { status: "error", summary: failureSummary(role, reason) };
}

function failureSummary(role: SpecialistRole, reason: string): string {
  return JSON.stringify({
    kind: "agent.delegate.specialist.result",
    trust: "model-specialist-output-untrusted",
    depth: 1,
    recursiveDelegation: false,
    role,
    status: "error",
    reason: reason.slice(0, 240),
  });
}

function stringArraySchema(maxItems: number, maxLength: number) {
  return {
    type: "array",
    maxItems,
    items: { type: "string", minLength: 1, maxLength },
  } as const;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
