import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import { WebToolError } from "./web-search.js";

export interface WebOpenRequest {
  url: string;
  maxCharacters: number;
}

export interface WebOpenResponse {
  url: string;
  title: string | null;
  contentType: string;
  text: string;
  retrievedAt: string;
}

export interface PublicWebTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface PinnedWebResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export type WebDnsResolver = (hostname: string) => Promise<LookupAddress[]>;
export type PinnedWebRequest = (
  target: PublicWebTarget,
  signal: AbortSignal,
) => Promise<PinnedWebResponse>;

const WEB_RESPONSE_MAX_BYTES = 1_000_000;
const WEB_REDIRECT_LIMIT = 3;

/**
 * Pembaca HTTP GET yang memvalidasi seluruh A/AAAA lalu mem-pin request ke
 * salah satu alamat yang sudah diperiksa. Redirect tidak dipercaya dan selalu
 * melewati resolusi serta pemeriksaan yang sama dari awal.
 */
export class SafeWebReader {
  private readonly resolver: WebDnsResolver;
  private readonly request: PinnedWebRequest;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: {
    resolver?: WebDnsResolver;
    request?: PinnedWebRequest;
    timeoutMs?: number;
    now?: () => Date;
  } = {}) {
    this.resolver = options.resolver ?? defaultResolver;
    this.request = options.request ?? defaultPinnedRequest;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  async open(input: WebOpenRequest, signal: AbortSignal): Promise<WebOpenResponse> {
    let current = parsePublicWebUrl(input.url);

    for (let redirects = 0; redirects <= WEB_REDIRECT_LIMIT; redirects += 1) {
      const attemptSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.timeoutMs),
      ]);
      let response: PinnedWebResponse;
      try {
        const target = await resolvePublicWebTarget(
          current,
          this.resolver,
          attemptSignal,
        );
        response = await this.request(target, attemptSignal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof WebToolError) throw error;
        if (attemptSignal.aborted) {
          throw new WebToolError(
            "Web open melewati batas waktu.",
            "Halaman web belum merespons sebelum batas waktu.",
          );
        }
        throw new WebToolError(
          "Web open request gagal.",
          "Halaman web sedang tidak dapat dibuka.",
        );
      }

      if (isRedirect(response.status)) {
        const location = response.headers["location"];
        if (!location || redirects === WEB_REDIRECT_LIMIT) {
          throw new WebToolError(
            "Redirect web tidak sah atau terlalu banyak.",
            "Halaman web mengalihkan terlalu banyak atau tanpa tujuan yang sah.",
          );
        }
        current = parsePublicWebUrl(new URL(location, current).toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new WebToolError(
          `Web open HTTP ${response.status}.`,
          `Halaman web menolak pembacaan (HTTP ${response.status}).`,
        );
      }

      const contentType = normalizedContentType(response.headers["content-type"]);
      if (!isReadableContentType(contentType)) {
        throw new WebToolError(
          `Content type web tidak didukung: ${contentType}.`,
          "Halaman itu bukan teks/HTML yang dapat dibaca Harvy saat ini.",
        );
      }
      const decoded = decodeBody(response.body, response.headers["content-type"]);
      const title = contentType.includes("html") ? htmlTitle(decoded) : null;
      const text = contentType.includes("html")
        ? htmlToPlainText(decoded)
        : normalizeText(decoded);
      if (!text) {
        throw new WebToolError(
          "Isi halaman web kosong setelah ekstraksi.",
          "Halaman itu tidak memberi teks yang dapat dibaca.",
        );
      }
      return {
        url: current.toString(),
        title,
        contentType,
        text: clipText(text, input.maxCharacters),
        retrievedAt: this.now().toISOString(),
      };
    }

    throw new WebToolError(
      "Redirect loop tidak selesai.",
      "Halaman web tidak dapat diselesaikan karena pengalihan berulang.",
    );
  }
}

export function parsePublicWebUrl(value: string): URL {
  if (!value || value.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new WebToolError("URL kosong atau terlalu panjang.", "URL halaman tidak sah.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebToolError("URL tidak dapat diurai.", "URL halaman tidak sah.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    throw new WebToolError(
      "Scheme atau credential URL ditolak.",
      "Hanya URL HTTP/HTTPS publik tanpa credential yang dapat dibuka.",
    );
  }
  if (url.port) {
    throw new WebToolError(
      "Port URL non-default ditolak.",
      "Hanya port web standar yang dapat dibuka.",
    );
  }
  url.hash = "";
  return url;
}

export async function resolvePublicWebTarget(
  url: URL,
  resolver: WebDnsResolver = defaultResolver,
  signal?: AbortSignal,
): Promise<PublicWebTarget> {
  const hostname = unbracketedHostname(url.hostname);
  const family = isIP(hostname);
  const addresses: LookupAddress[] = family
    ? [{ address: hostname, family }]
    : await withOptionalAbort(resolver(hostname), signal);
  if (addresses.length === 0) {
    throw new WebToolError(
      "DNS tidak memberi alamat.",
      "Nama host halaman tidak dapat ditemukan.",
    );
  }

  for (const candidate of addresses) {
    if (
      (candidate.family !== 4 && candidate.family !== 6) ||
      !isPublicIpAddress(candidate.address)
    ) {
      throw new WebToolError(
        "DNS mengarah ke alamat non-publik.",
        "URL itu mengarah ke jaringan lokal, privat, atau alamat khusus dan tidak boleh dibuka.",
      );
    }
  }
  const selected = addresses[0]!;
  return {
    url,
    address: selected.address,
    family: selected.family as 4 | 6,
  };
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;

  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  // Hanya global-unicast 2000::/3. Rentang khusus di dalamnya tetap diblokir.
  if (!inIpv6Prefix(value, ipv6Literal("2000::"), 3)) return false;
  const blocked: Array<[bigint, number]> = [
    // Registry IANA menempatkan assignment protokol/non-global di 2001::/23.
    // Memblokir seluruh blok ini sengaja konservatif, termasuk anycast khusus.
    [ipv6Literal("2001::"), 23],
    [ipv6Literal("2001:db8::"), 32], // dokumentasi
    [ipv6Literal("2002::"), 16], // 6to4, dapat membawa IPv4 privat
    [ipv6Literal("3fff::"), 20], // dokumentasi
  ];
  return !blocked.some(([network, prefix]) =>
    inIpv6Prefix(value, network, prefix));
}

async function defaultResolver(hostname: string): Promise<LookupAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

async function defaultPinnedRequest(
  target: PublicWebTarget,
  signal: AbortSignal,
): Promise<PinnedWebResponse> {
  return new Promise<PinnedWebResponse>((resolve, reject) => {
    const requester = target.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requester(target.url, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8",
        "Accept-Encoding": "identity",
        "User-Agent": "HarvyResearch/0.1 (+read-only-web-tool)",
        Host: target.url.host,
      },
      ...(target.url.protocol === "https:"
        ? { servername: unbracketedHostname(target.url.hostname) }
        : {}),
      lookup: (_hostname, _options, callback) => {
        callback(null, target.address, target.family);
      },
    }, (response) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > WEB_RESPONSE_MAX_BYTES) {
          response.destroy(new WebToolError(
            "Web response melewati batas byte.",
            "Halaman terlalu besar untuk dibaca dengan aman.",
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        cleanup();
        resolve({
          status: response.statusCode ?? 0,
          headers: flattenHeaders(response.headers),
          body: Buffer.concat(chunks, total),
        });
      });
      response.on("error", (error) => {
        cleanup();
        reject(error);
      });
    });

    const onAbort = () => {
      request.destroy(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    request.once("error", (error) => {
      cleanup();
      reject(error);
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result[name.toLowerCase()] = value;
    else if (Array.isArray(value)) result[name.toLowerCase()] = value.join(", ");
  }
  return result;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308;
}

function normalizedContentType(value: string | undefined): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

function isReadableContentType(value: string): boolean {
  return value.startsWith("text/") ||
    value === "application/xhtml+xml" ||
    value === "application/json" ||
    value.endsWith("+json");
}

function decodeBody(body: Uint8Array, contentType: string | undefined): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/iu.exec(contentType ?? "")?.[1]
    ?.toLowerCase() ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function htmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1];
  if (!match) return null;
  const title = normalizeText(decodeHtmlEntities(match.replaceAll(/<[^>]+>/gu, " ")));
  return title ? clipText(title, 300) : null;
}

function htmlToPlainText(html: string): string {
  const withoutExecutable = html
    .replaceAll(/<!--[^]*?-->/gu, " ")
    .replaceAll(/<(script|style|noscript|template|svg)\b[^>]*>[^]*?<\/\1\s*>/giu, " ")
    .replaceAll(/<(br|hr)\b[^>]*>/giu, "\n")
    .replaceAll(/<\/(p|div|article|section|main|header|footer|li|h[1-6]|tr)>/giu, "\n")
    .replaceAll(/<[^>]+>/gu, " ");
  return normalizeText(decodeHtmlEntities(withoutExecutable));
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
  };
  return value.replace(
    /&(?:#(\d{1,7})|#x([a-f0-9]{1,6})|([a-z][a-z0-9]{1,15}));/giu,
    (entity, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name) return named[name.toLowerCase()] ?? entity;
      const point = Number.parseInt(decimal ?? hex ?? "", hex ? 16 : 10);
      try {
        return Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : entity;
      } catch {
        return entity;
      }
    },
  );
}

function normalizeText(value: string): string {
  return value
    .replaceAll(/\r\n?/gu, "\n")
    .replaceAll(/[\t\f\v ]+/gu, " ")
    .replaceAll(/ *\n */gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
}

function clipText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  if (maxCharacters <= 1) return value.slice(0, maxCharacters);
  return `${value.slice(0, maxCharacters - 1).trimEnd()}…`;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) =>
    !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function unbracketedHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

async function withOptionalAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function ipv6Literal(value: string): bigint {
  const parsed = ipv6ToBigInt(value);
  if (parsed === null) throw new Error(`Literal IPv6 internal tidak sah: ${value}`);
  return parsed;
}

function ipv6ToBigInt(address: string): bigint | null {
  if (address.includes("%")) return null;
  let source = address.toLowerCase();
  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    const ipv4 = source.slice(lastColon + 1);
    if (!isIP(ipv4)) return null;
    const octets = ipv4.split(".").map(Number);
    source = `${source.slice(0, lastColon)}:${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[a-f0-9]{1,4}$/u.test(word))) {
    return null;
  }
  return words.reduce(
    (total, word) => (total << 16n) | BigInt(Number.parseInt(word, 16)),
    0n,
  );
}

function inIpv6Prefix(value: bigint, network: bigint, bits: number): boolean {
  if (bits === 0) return true;
  const shift = BigInt(128 - bits);
  return (value >> shift) === (network >> shift);
}
