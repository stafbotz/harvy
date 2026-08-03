import type { OperationalLogger } from "./operational-logger.js";

interface BaileysLogger {
  level: string;
  child(bindings: Record<string, unknown>): BaileysLogger;
  trace(object: unknown, message?: string): void;
  debug(object: unknown, message?: string): void;
  info(object: unknown, message?: string): void;
  warn(object: unknown, message?: string): void;
  error(object: unknown, message?: string): void;
}

/**
 * Baileys membawa logger yang secara default mencetak object protokol mentah.
 * Adapter ini sengaja hanya meneruskan kategori dan scalar teknis yang sudah
 * dikenal. Object, message node, auth state, serta payload history diabaikan.
 */
export function createBaileysLogger(
  logger: OperationalLogger,
  accountId: string,
): BaileysLogger {
  return new SafeBaileysLogger(
    logger.child("whatsapp.baileys", { accountId }),
  );
}

class SafeBaileysLogger implements BaileysLogger {
  level = "warn";

  constructor(private readonly logger: OperationalLogger) {}

  child(_bindings: Record<string, unknown>): BaileysLogger {
    return new SafeBaileysLogger(this.logger);
  }

  trace(_object: unknown, _message?: string): void {}
  debug(_object: unknown, _message?: string): void {}
  info(_object: unknown, _message?: string): void {}

  warn(object: unknown, message?: string): void {
    const details = safeBaileysDetails(object);
    this.logger.warn(
      classifyEvent(message, "baileys_warning"),
      safeDescription(message, "Baileys melaporkan peringatan internal."),
      details,
    );
  }

  error(object: unknown, message?: string): void {
    const details = safeBaileysDetails(object);
    const code = details["code"];
    if (code === 515 || code === "515") {
      this.logger.info(
        "baileys_restart_required",
        "Baileys meminta koneksi dimulai ulang setelah pairing.",
        details,
      );
      return;
    }

    const description = safeDescription(
      message,
      "Baileys melaporkan kegagalan internal.",
    );
    const error = Object.assign(new Error(description), {
      ...(code !== undefined ? { code } : {}),
      ...(details["status"] !== undefined
        ? { status: details["status"] }
        : {}),
    });
    this.logger.error(
      classifyEvent(message, "baileys_error"),
      description,
      error,
      details,
    );
  }
}

function safeBaileysDetails(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return compact({
    code:
      readScalar(value["code"]) ??
      readNestedScalar(value, ["fullErrorNode", "attrs", "code"]),
    status:
      readScalar(value["statusCode"]) ??
      readScalar(value["status"]) ??
      readNestedScalar(value, ["output", "statusCode"]),
    attempt: readScalar(value["attempt"]),
    version: safeVersion(value["version"]),
  });
}

function classifyEvent(message: string | undefined, fallback: string): string {
  const normalized = message?.toLocaleLowerCase("en-US") ?? "";
  if (normalized.includes("connection errored")) {
    return "baileys_connection_error";
  }
  if (normalized.includes("stream errored")) return "baileys_stream_error";
  if (normalized.includes("critical block")) {
    return "baileys_critical_block_retry";
  }
  if (normalized.includes("no name present")) {
    return "baileys_contact_name_missing";
  }
  return fallback;
}

function safeDescription(
  message: string | undefined,
  fallback: string,
): string {
  const event = classifyEvent(message, "");
  switch (event) {
    case "baileys_connection_error":
      return "Koneksi internal Baileys mengalami kegagalan.";
    case "baileys_stream_error":
      return "Stream internal Baileys ditutup dengan galat.";
    case "baileys_critical_block_retry":
      return "Baileys mengulang pembacaan blok protokol penting.";
    case "baileys_contact_name_missing":
      return "Metadata nama kontak tidak tersedia di Baileys.";
    default:
      return fallback;
  }
}

function readNestedScalar(
  value: Record<string, unknown>,
  path: string[],
): string | number | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return readScalar(current);
}

function readScalar(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value)) {
    return value;
  }
  return undefined;
}

function safeVersion(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  if (
    !value.every(
      (item) =>
        typeof item === "number" &&
        Number.isInteger(item) &&
        item >= 0,
    )
  ) {
    return undefined;
  }
  return value.join(".");
}

function compact(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
