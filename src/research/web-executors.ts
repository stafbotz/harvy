import { isIP } from "node:net";
import type {
  AgentCapabilityExecutor,
  AgentExecutionContext,
  AgentExecutorResult,
} from "../harness/agent-harness.js";
import {
  isPublicIpAddress,
  parsePublicWebUrl,
  type SafeWebReader,
} from "./safe-web-reader.js";
import {
  WebToolError,
  type WebSearchFreshness,
  type WebSearchProvider,
  type WebSearchQuery,
} from "./web-search.js";

export class WebSearchExecutor implements AgentCapabilityExecutor<WebSearchQuery> {
  readonly capabilityId = "web.search";
  readonly capabilityVersion = "1";

  constructor(private readonly provider: WebSearchProvider) {}

  validate(input: unknown) {
    if (!isExactRecord(input, ["query", "count", "freshness"])) {
      return { ok: false as const, reason: "Input web.search harus object query/count/freshness tertutup." };
    }
    const query = typeof input["query"] === "string"
      ? input["query"].trim().replaceAll(/\s+/gu, " ")
      : "";
    if (
      query.length < 2 ||
      query.length > 500 ||
      /[\u0000-\u001f\u007f]/u.test(query)
    ) {
      return { ok: false as const, reason: "Query pencarian harus 2-500 karakter tanpa karakter kontrol." };
    }
    const rawCount = input["count"];
    const count = rawCount === undefined ? 5 : rawCount;
    if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 8) {
      return { ok: false as const, reason: "Jumlah hasil web.search harus bilangan 1-8." };
    }
    const freshness = readFreshness(input["freshness"]);
    if (freshness === undefined) {
      return { ok: false as const, reason: "Freshness web.search harus day/week/month/year/null." };
    }
    return {
      ok: true as const,
      value: { query, count: count as number, freshness },
    };
  }

  async execute(
    input: WebSearchQuery,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    try {
      const response = await this.provider.search(input, context.signal);
      return {
        status: "ok",
        summary: searchObservation(response),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return webErrorResult(error, "Pencarian web gagal tanpa hasil.");
    }
  }
}

export interface WebOpenInput {
  url: string;
  maxCharacters: number;
}

export class WebOpenExecutor implements AgentCapabilityExecutor<WebOpenInput> {
  readonly capabilityId = "web.open";
  readonly capabilityVersion = "1";

  constructor(private readonly reader: SafeWebReader) {}

  validate(input: unknown) {
    if (!isExactRecord(input, ["url", "maxCharacters"])) {
      return { ok: false as const, reason: "Input web.open harus object url/maxCharacters tertutup." };
    }
    if (typeof input["url"] !== "string") {
      return { ok: false as const, reason: "URL web.open wajib berupa string." };
    }
    let url: URL;
    try {
      url = parsePublicWebUrl(input["url"].trim());
    } catch (error) {
      return {
        ok: false as const,
        reason: error instanceof WebToolError
          ? error.publicMessage
          : "URL web.open tidak sah.",
      };
    }
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    if (isIP(hostname) && !isPublicIpAddress(hostname)) {
      return {
        ok: false as const,
        reason: "URL jaringan lokal, privat, atau alamat khusus tidak boleh dibuka.",
      };
    }
    const rawMaximum = input["maxCharacters"];
    const maxCharacters = rawMaximum === undefined ? 2_500 : rawMaximum;
    if (
      !Number.isSafeInteger(maxCharacters) ||
      (maxCharacters as number) < 500 ||
      (maxCharacters as number) > 3_000
    ) {
      return { ok: false as const, reason: "maxCharacters web.open harus 500-3000." };
    }
    return {
      ok: true as const,
      value: { url: url.toString(), maxCharacters: maxCharacters as number },
    };
  }

  async execute(
    input: WebOpenInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    try {
      const page = await this.reader.open(input, context.signal);
      return {
        status: "ok",
        summary: JSON.stringify({
          kind: "web.open.page",
          trust: "untrusted_web_content",
          url: page.url,
          title: page.title,
          contentType: page.contentType,
          retrievedAt: page.retrievedAt,
          text: page.text,
        }),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return webErrorResult(error, "Halaman web gagal dibuka tanpa hasil.");
    }
  }
}

function readFreshness(value: unknown): WebSearchFreshness | null | undefined {
  if (value === undefined || value === null) return null;
  return value === "day" || value === "week" || value === "month" || value === "year"
    ? value
    : undefined;
}

function webErrorResult(error: unknown, fallback: string): AgentExecutorResult {
  return {
    status: "error",
    summary: error instanceof WebToolError ? error.publicMessage : fallback,
  };
}

function searchObservation(response: Awaited<ReturnType<WebSearchProvider["search"]>>): string {
  const results = response.results.map((result) => ({
    title: result.title.slice(0, 200),
    url: result.url,
    snippet: result.snippet.slice(0, 320),
    age: result.age,
  }));
  const base = {
    kind: "web.search.results",
    trust: "untrusted_web_content",
    query: response.query,
    alteredQuery: response.alteredQuery,
    moreResultsAvailable: response.moreResultsAvailable,
  };
  while (results.length > 0) {
    const serialized = JSON.stringify({ ...base, results });
    if (serialized.length <= 3_700) return serialized;
    results.pop();
  }
  return JSON.stringify({ ...base, results: [] });
}

function isExactRecord(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
