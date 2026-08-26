import type { ModelProfile } from "./model-profile.js";

const GMI_HOST = "api.gmi-serving.com";
const GMI_PATH = "/v1";

/**
 * Exact wire profile untuk MiniMax-M3 di endpoint resmi GMI Serving.
 *
 * Probe live 2026-08-25 membuktikan completion, temperature, JSON object,
 * named native tool, assistant/tool continuation, input gambar data URL, dan
 * passive prefix cache. Endpoint `/models` melaporkan context 1_048_576.
 * Model tidak mengembalikan reasoning continuation pada wire ini, sehingga
 * Harvy sengaja tidak mengaktifkan reasoning/replay yang belum terbukti.
 */
const GMI_MINIMAX_M3: ModelProfile = {
  id: "MiniMaxAI/MiniMax-M3",
  provider: "gmi-serving",
  verification: "explicit",
  reasoning: {
    mandatory: false,
    defaultEffort: "none",
    supportedEfforts: [],
    wireFormat: "none",
  },
  supports: {
    tools: true,
    toolChoice: true,
    namedToolChoice: true,
    structuredOutput: true,
    temperature: true,
    promptCaching: true,
    imageInput: true,
  },
  continuation: {
    preserveReasoning: false,
    preserveAssistantMessage: true,
  },
  contextWindow: 1_048_576,
  maxOutputTokens: null,
};

/**
 * Capability code-owned hanya berlaku pada kombinasi provider, model, dan
 * endpoint resmi yang persis sama. Gateway kompatibel harus membawa profile
 * operatornya sendiri dan menjalani smoke terpisah.
 */
export function liveVerifiedModelProfiles(
  providerId: string,
  baseUrl: string,
): readonly ModelProfile[] {
  if (providerId !== "gmi-serving" || !isOfficialGmiEndpoint(baseUrl)) {
    return [];
  }
  return [GMI_MINIMAX_M3];
}

function isOfficialGmiEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      parsed.hostname === GMI_HOST &&
      parsed.port === "" &&
      parsed.username === "" && parsed.password === "" &&
      parsed.search === "" && parsed.hash === "" &&
      parsed.pathname.replace(/\/+$/u, "") === GMI_PATH;
  } catch {
    return false;
  }
}
