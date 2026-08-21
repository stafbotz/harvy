import type {
  ModelTier,
  ResolvedModelRoute,
  RoleAwareRoutingConfig,
} from "./model-policy.js";
import { resolveModel } from "./model-policy.js";
import type { ReasoningEffort } from "../domain/model-execution.js";

export type ReasoningWireFormat =
  | "none"
  | "openai-reasoning-effort"
  | "openrouter-reasoning"
  | "deepseek-thinking";

export interface ModelProfile {
  id: string;
  provider: string;
  /** `compatibility` mempertahankan kontrak lama; capability baru tidak aktif. */
  verification: "compatibility" | "explicit";
  reasoning: {
    mandatory: boolean;
    defaultEffort: ReasoningEffort;
    supportedEfforts: readonly ReasoningEffort[];
    wireFormat: ReasoningWireFormat;
  };
  supports: {
    tools: boolean;
    toolChoice: boolean;
    namedToolChoice: boolean;
    structuredOutput: boolean;
    temperature: boolean;
  };
  continuation: {
    preserveReasoning: boolean;
    preserveAssistantMessage: boolean;
  };
  /** `null` berarti belum diverifikasi; jangan mengarang angka dari nama model. */
  contextWindow: number | null;
  /** `null` berarti belum diverifikasi; caller tetap memasang emergency ceiling. */
  maxOutputTokens: number | null;
}

const EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const WIRE_FORMATS = new Set<ReasoningWireFormat>([
  "none",
  "openai-reasoning-effort",
  "openrouter-reasoning",
  "deepseek-thinking",
]);
const PROFILE_ID = /^[^\u0000-\u001f<>]{1,160}$/u;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u;

/** Registry immutable dengan key tegas `provider + model`; tidak menebak substring. */
export class ModelProfileRegistry {
  private readonly profiles: ReadonlyMap<string, ModelProfile>;

  constructor(profiles: readonly ModelProfile[]) {
    const entries = new Map<string, ModelProfile>();
    for (const candidate of profiles) {
      const profile = immutableProfile(candidate);
      const key = profileKey(profile.provider, profile.id);
      if (entries.has(key)) {
        throw new Error(`Profile model duplikat: ${profile.provider}/${profile.id}.`);
      }
      entries.set(key, profile);
    }
    this.profiles = entries;
  }

  get(provider: string, model: string): ModelProfile | null {
    return this.profiles.get(profileKey(provider, model)) ?? null;
  }

  require(provider: string, model: string): ModelProfile {
    const profile = this.get(provider, model);
    if (!profile) {
      throw new Error(`Profile model tidak terdaftar: ${provider}/${model}.`);
    }
    return profile;
  }

  list(): readonly ModelProfile[] {
    return Object.freeze([...this.profiles.values()]);
  }
}

export interface ProfiledRoutingConfig extends RoleAwareRoutingConfig {
  providerId?: string;
  modelProfiles?: ModelProfileRegistry;
}

/**
 * Compatibility mode hanya berlaku bagi fixture/probe lama yang belum membawa
 * registry. Composition root production selalu membawa provider + registry;
 * pasangan yang hilang di sana gagal tertutup.
 */
export function resolveModelProfile(
  tier: ModelTier,
  routing: ProfiledRoutingConfig,
): ModelProfile | null {
  return resolveModelProfileById(resolveModel(tier, routing), routing);
}

/** Resolve profile exact untuk route role-aware tanpa menebak dari tier. */
export function resolveModelRouteProfile(
  route: ResolvedModelRoute,
  routing: ProfiledRoutingConfig,
): ModelProfile | null {
  return resolveModelProfileById(route.modelId, routing);
}

export function resolveModelProfileById(
  modelId: string,
  routing: ProfiledRoutingConfig,
): ModelProfile | null {
  if (!routing.providerId && !routing.modelProfiles) return null;
  if (!routing.providerId || !routing.modelProfiles) {
    throw new Error("Provider dan registry model harus dikonfigurasi bersama.");
  }
  return routing.modelProfiles.require(routing.providerId, modelId);
}

function immutableProfile(candidate: ModelProfile): ModelProfile {
  if (!PROFILE_ID.test(candidate.id) || !PROVIDER_ID.test(candidate.provider)) {
    throw new Error("ID provider atau model pada profile tidak sah.");
  }
  const efforts = [...candidate.reasoning.supportedEfforts];
  if (
    candidate.verification !== "compatibility" &&
    candidate.verification !== "explicit"
  ) {
    throw new Error("Status verifikasi profile tidak sah.");
  }
  if (
    new Set(efforts).size !== efforts.length ||
    efforts.some((effort) => !EFFORTS.has(effort))
  ) {
    throw new Error("Daftar reasoning effort profile tidak sah.");
  }
  if (!EFFORTS.has(candidate.reasoning.defaultEffort)) {
    throw new Error("Default reasoning effort profile tidak sah.");
  }
  if (!WIRE_FORMATS.has(candidate.reasoning.wireFormat)) {
    throw new Error("Wire format reasoning profile tidak sah.");
  }
  const providerWire = candidate.reasoning.wireFormat;
  if (
    (candidate.provider === "openrouter" &&
      providerWire !== "none" && providerWire !== "openrouter-reasoning") ||
    (candidate.provider === "google-ai-studio" &&
      providerWire !== "none" && providerWire !== "openai-reasoning-effort") ||
    (candidate.provider === "deepseek" &&
      providerWire !== "none" && providerWire !== "deepseek-thinking")
  ) {
    throw new Error("Wire format reasoning tidak cocok dengan provider.");
  }
  if (
    candidate.reasoning.wireFormat === "none" &&
    (efforts.length > 0 || candidate.reasoning.defaultEffort !== "none")
  ) {
    throw new Error("Profile tanpa wire reasoning harus memakai effort none.");
  }
  if (
    candidate.reasoning.wireFormat !== "none" &&
    efforts.length === 0
  ) {
    throw new Error("Profile reasoning harus mempunyai effort yang didukung.");
  }
  if (
    efforts.length > 0 &&
    !efforts.includes(candidate.reasoning.defaultEffort)
  ) {
    throw new Error("Default reasoning effort tidak didukung profile.");
  }
  if (
    candidate.reasoning.mandatory &&
    candidate.reasoning.defaultEffort === "none"
  ) {
    throw new Error("Reasoning wajib tidak boleh memakai default none.");
  }
  if (
    candidate.verification === "compatibility" &&
    candidate.reasoning.wireFormat !== "none"
  ) {
    throw new Error("Profile compatibility tidak boleh mengaktifkan reasoning wire.");
  }
  if (
    candidate.verification === "compatibility" &&
    candidate.continuation.preserveReasoning
  ) {
    throw new Error("Profile compatibility tidak boleh mengaktifkan reasoning replay.");
  }
  if (candidate.supports.namedToolChoice && !candidate.supports.toolChoice) {
    throw new Error("Named tool choice memerlukan dukungan tool choice.");
  }
  if (candidate.supports.toolChoice && !candidate.supports.tools) {
    throw new Error("Tool choice memerlukan dukungan tool.");
  }
  validateOptionalLimit(candidate.contextWindow, "context window");
  validateOptionalLimit(candidate.maxOutputTokens, "max output token");

  return Object.freeze({
    id: candidate.id,
    provider: candidate.provider,
    verification: candidate.verification,
    reasoning: Object.freeze({
      ...candidate.reasoning,
      supportedEfforts: Object.freeze(efforts),
    }),
    supports: Object.freeze({ ...candidate.supports }),
    continuation: Object.freeze({ ...candidate.continuation }),
    contextWindow: candidate.contextWindow,
    maxOutputTokens: candidate.maxOutputTokens,
  });
}

function validateOptionalLimit(value: number | null, label: string): void {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error(`${label} profile tidak sah.`);
  }
}

function profileKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}
