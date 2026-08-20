import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import type { AddressInfo } from "node:net";
import { GitHubAppBackend } from "./github-app-backend.js";

export interface GitHubInstallationCallbackServerOptions {
  host: string;
  port: number;
  backend: GitHubAppBackend;
  publicOrigin?: string;
  tls?: Pick<HttpsServerOptions, "key" | "cert" | "ca" | "requestCert" | "rejectUnauthorized">;
}

/** Public OAuth callback. It exposes no broker RPC and returns no repository data. */
export class GitHubInstallationCallbackServer {
  readonly #host: string;
  readonly #port: number;
  readonly #backend: GitHubAppBackend;
  readonly #configuredOrigin: string | null;
  readonly #server: Server;

  constructor(options: GitHubInstallationCallbackServerOptions) {
    this.#host = safeHost(options.host);
    this.#port = port(options.port);
    this.#backend = options.backend;
    this.#configuredOrigin = options.publicOrigin ?? null;
    const listener = (request: IncomingMessage, response: ServerResponse): void => {
      void this.#handle(request, response);
    };
    this.#server = options.tls ? createHttpsServer(options.tls, listener) : createHttpServer(listener);
  }

  async start(): Promise<{ origin: string; port: number }> {
    if (!isLoopback(this.#host) && !this.#configuredOrigin) {
      throw new Error("Public origin HTTPS callback GitHub wajib untuk listener non-loopback.");
    }
    await new Promise<void>((resolve, reject) => {
      const error = (reason: Error): void => reject(reason);
      this.#server.once("error", error);
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.off("error", error);
        resolve();
      });
    });
    const address = this.#server.address() as AddressInfo | null;
    if (!address) throw new Error("Alamat callback GitHub tidak tersedia.");
    const origin = this.#configuredOrigin ?? `http://${this.#host === "::1" ? "[::1]" : this.#host}:${address.port}`;
    return { origin, port: address.port };
  }

  async close(): Promise<void> {
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
      this.#server.closeIdleConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    try {
      if (request.method !== "GET" || !request.url) throw new Error("CALLBACK_REJECTED");
      const url = new URL(request.url, "https://callback.invalid");
      if (url.pathname !== "/v1/github-app/callback" || url.hash ||
        [...url.searchParams.keys()].some((key) =>
          key !== "state" && key !== "code" && key !== "installation_id" && key !== "setup_action"
        )) {
        throw new Error("CALLBACK_REJECTED");
      }
      const state = single(url, "state");
      const code = single(url, "code");
      const installationId = single(url, "installation_id");
      const setupAction = single(url, "setup_action");
      if (setupAction !== "install" && setupAction !== "update") throw new Error("CALLBACK_REJECTED");
      await this.#backend.completeInstallationCallback({
        state,
        code,
        installationId,
        setupAction,
      }, controller.signal);
      send(response, 200, "GitHub tersambung. Kamu dapat menutup halaman ini dan kembali ke Harvy.");
    } catch {
      send(response, 400, "Koneksi GitHub tidak dapat diverifikasi. Kembali ke Harvy dan mulai ulang proses koneksi.");
    }
  }
}

function send(response: ServerResponse, status: number, message: string): void {
  const escaped = message.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  const bytes = Buffer.from(
    `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
      `<title>Harvy GitHub</title><body><p>${escaped}</p></body></html>`,
    "utf8",
  );
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(bytes.byteLength),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'none'; img-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

function single(url: URL, name: string): string {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1 || values[0]!.length < 1 || values[0]!.length > 2_048 ||
    /[\r\n\0]/u.test(values[0]!)) throw new Error("CALLBACK_REJECTED");
  return values[0]!;
}

function safeHost(value: string): string {
  if (typeof value !== "string" || !value || value.length > 255 || /[\s\0/]/u.test(value)) {
    throw new Error("Host callback GitHub tidak sah.");
  }
  return value;
}

function port(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("Port callback GitHub tidak sah.");
  }
  return value;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
