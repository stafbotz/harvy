export type WebSearchFreshness = "day" | "week" | "month" | "year";

export interface WebSearchQuery {
  query: string;
  count: number;
  freshness: WebSearchFreshness | null;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  age: string | null;
}

export interface WebSearchResponse {
  query: string;
  alteredQuery: string | null;
  moreResultsAvailable: boolean;
  results: WebSearchResult[];
}

export interface WebSearchProvider {
  search(input: WebSearchQuery, signal: AbortSignal): Promise<WebSearchResponse>;
}

export class WebToolError extends Error {
  constructor(
    message: string,
    readonly publicMessage: string,
  ) {
    super(message);
    this.name = "WebToolError";
  }
}

const BRAVE_WEB_SEARCH_ENDPOINT =
  "https://api.search.brave.com/res/v1/web/search";
const SEARCH_RESPONSE_MAX_BYTES = 1_000_000;

/** Adapter resmi Brave Search API; endpoint tidak dapat diarahkan lewat env. */
export class BraveWebSearchProvider implements WebSearchProvider {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: { request?: typeof fetch; timeoutMs?: number } = {},
  ) {
    if (!apiKey.trim()) throw new Error("Brave Search API key kosong.");
    this.request = options.request ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async search(
    input: WebSearchQuery,
    signal: AbortSignal,
  ): Promise<WebSearchResponse> {
    const parameters = new URLSearchParams({
      q: input.query,
      count: String(input.count),
      country: "ID",
      search_lang: "id",
      ui_lang: "id-ID",
      safesearch: "strict",
      spellcheck: "true",
      text_decorations: "false",
      result_filter: "web",
    });
    const freshness = braveFreshness(input.freshness);
    if (freshness) parameters.set("freshness", freshness);

    let response: Response;
    try {
      response = await this.request(
        `${BRAVE_WEB_SEARCH_ENDPOINT}?${parameters.toString()}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": this.apiKey,
          },
          redirect: "error",
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(this.timeoutMs),
          ]),
        },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new WebToolError(
        "Brave Search request gagal.",
        "Pencarian web sedang tidak dapat dihubungi.",
      );
    }

    if (!response.ok) throw searchHttpError(response.status);

    let parsed: unknown;
    try {
      const raw = await readResponseText(response, SEARCH_RESPONSE_MAX_BYTES);
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error instanceof WebToolError) throw error;
      throw new WebToolError(
        "Brave Search response tidak dapat dibaca.",
        "Hasil pencarian web tidak mempunyai bentuk yang dapat dipercaya.",
      );
    }
    return parseBraveResponse(parsed, input.query, input.count);
  }
}

function parseBraveResponse(
  value: unknown,
  fallbackQuery: string,
  limit: number,
): WebSearchResponse {
  if (!isRecord(value)) {
    throw new WebToolError(
      "Brave Search response bukan object.",
      "Hasil pencarian web tidak mempunyai bentuk yang dapat dipercaya.",
    );
  }
  const queryRecord = isRecord(value["query"]) ? value["query"] : {};
  const webRecord = isRecord(value["web"]) ? value["web"] : {};
  const rawResults = Array.isArray(webRecord["results"])
    ? webRecord["results"]
    : [];
  const results: WebSearchResult[] = [];

  for (const rawResult of rawResults) {
    if (!isRecord(rawResult)) continue;
    const title = cleanText(rawResult["title"], 300);
    const url = cleanResultUrl(rawResult["url"]);
    const snippet = cleanText(rawResult["description"], 700) ?? "";
    if (!title || !url) continue;
    results.push({
      title,
      url,
      snippet,
      age: cleanText(rawResult["age"], 80),
    });
    if (results.length >= limit) break;
  }

  return {
    query: cleanText(queryRecord["original"], 500) ?? fallbackQuery,
    alteredQuery: cleanText(queryRecord["altered"], 500),
    moreResultsAvailable: queryRecord["more_results_available"] === true,
    results,
  };
}

function searchHttpError(status: number): WebToolError {
  if (status === 401 || status === 403) {
    return new WebToolError(
      `Brave Search menolak credential (${status}).`,
      "Credential pencarian web belum diterima provider.",
    );
  }
  if (status === 429) {
    return new WebToolError(
      "Brave Search rate limit.",
      "Batas pencarian web sedang tercapai. Coba lagi nanti.",
    );
  }
  return new WebToolError(
    `Brave Search HTTP ${status}.`,
    status >= 500
      ? "Provider pencarian web sedang terganggu."
      : "Provider pencarian web menolak permintaan ini.",
  );
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new WebToolError(
        "Brave Search response melewati batas byte.",
        "Hasil pencarian web terlalu besar untuk diproses dengan aman.",
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

function braveFreshness(value: WebSearchFreshness | null): string | null {
  switch (value) {
    case "day": return "pd";
    case "week": return "pw";
    case "month": return "pm";
    case "year": return "py";
    case null: return null;
  }
}

function cleanResultUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function cleanText(value: unknown, maxCharacters: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replaceAll(/\s+/gu, " ");
  if (!clean) return null;
  return clean.slice(0, maxCharacters);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
