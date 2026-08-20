import type { ModelProfile } from "./model-profile.js";

const GOOGLE_OPENAI_HOST = "generativelanguage.googleapis.com";
const GOOGLE_OPENAI_PATH = "/v1beta/openai";

/**
 * Capability record promoted only after the exact wire profile passed
 * `scripts/provider-live-smoke.ts` against Google AI Studio on 2026-08-20.
 * Digest after ModelProfileRegistry normalization:
 * 4d4c4f299b84b5a1767c96a54e6591a53c06a90807aba16d78a04fe4967d7d5c
 */
const GEMINI_3_5_FLASH_LITE: ModelProfile = {
  id: "gemini-3.5-flash-lite",
  provider: "google-ai-studio",
  verification: "explicit",
  reasoning: {
    mandatory: true,
    defaultEffort: "minimal",
    supportedEfforts: ["minimal", "low", "medium", "high"],
    wireFormat: "openai-reasoning-effort",
  },
  supports: {
    tools: true,
    toolChoice: true,
    // Live smoke deliberately proved the portable `required` form. A named
    // choice remains closed until its exact Google compatibility wire is run.
    namedToolChoice: false,
    structuredOutput: true,
    // Google deprecated sampling parameters for this model generation.
    temperature: false,
  },
  continuation: {
    preserveReasoning: true,
    preserveAssistantMessage: true,
  },
  contextWindow: 1_048_576,
  maxOutputTokens: 65_536,
};

/**
 * Return code-owned profiles only for the exact official trust endpoint.
 * A gateway or provider-compatible URL must declare and verify its own wire.
 */
export function liveVerifiedModelProfiles(
  providerId: string,
  baseUrl: string,
): readonly ModelProfile[] {
  if (
    providerId !== "google-ai-studio" ||
    !isOfficialGoogleOpenAiEndpoint(baseUrl)
  ) return [];
  return [GEMINI_3_5_FLASH_LITE];
}

function isOfficialGoogleOpenAiEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      parsed.hostname === GOOGLE_OPENAI_HOST &&
      parsed.username === "" && parsed.password === "" &&
      parsed.search === "" && parsed.hash === "" &&
      parsed.pathname.replace(/\/+$/u, "") === GOOGLE_OPENAI_PATH;
  } catch {
    return false;
  }
}
