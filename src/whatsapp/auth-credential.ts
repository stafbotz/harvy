/**
 * Baileys 7 QR pairing persists the cryptographically verified pair-success
 * material before the required 515 reconnect, but rc14 does not set the legacy
 * `registered` flag on that QR path. Treat that exact durable material as a
 * ready credential while keeping partial `me`-only state fail-closed.
 */
export function isWhatsAppCredentialReady(value: unknown): boolean {
  const credentials = record(value);
  if (!credentials || !hasWhatsAppIdentity(credentials["me"])) return false;
  if (credentials["registered"] === true) return true;

  const account = record(credentials["account"]);
  const identities = credentials["signalIdentities"];
  if (
    !account ||
    !binaryMaterial(account["details"]) ||
    !binaryMaterial(account["accountSignatureKey"]) ||
    !binaryMaterial(account["accountSignature"]) ||
    !binaryMaterial(account["deviceSignature"]) ||
    !Array.isArray(identities) ||
    identities.length < 1
  ) return false;

  return identities.some((candidate) => {
    const identity = record(candidate);
    const identifier = record(identity?.["identifier"]);
    return Boolean(
      identity &&
      identifier &&
      typeof identifier["name"] === "string" &&
      identifier["name"].length > 0 &&
      Number.isSafeInteger(identifier["deviceId"]) &&
      binaryMaterial(identity["identifierKey"]),
    );
  });
}

/**
 * Mengambil seluruh identitas peer yang terikat pada credential Baileys.
 * WhatsApp multi-device dapat mengirim event memakai PN atau LID; caller yang
 * membandingkan akun wajib menerima keduanya tanpa pernah mencatat nilainya.
 */
export function whatsAppCredentialJids(value: unknown): string[] {
  const credentials = record(value);
  const identity = record(credentials?.["me"]);
  if (!identity) return [];
  const jids = new Set<string>();
  for (const key of ["phoneNumber", "id", "lid"] as const) {
    const candidate = identity[key];
    if (typeof candidate !== "string" || candidate.length > 160) continue;
    const normalized = jidNormalizedUser(candidate);
    if (
      /^\d{5,20}@s\.whatsapp\.net$/u.test(normalized) ||
      /^\d{5,20}@lid$/u.test(normalized)
    ) {
      jids.add(normalized);
    }
  }
  return [...jids];
}

function hasWhatsAppIdentity(value: unknown): boolean {
  const identity = record(value);
  return Boolean(
    identity &&
    typeof identity["id"] === "string" &&
    identity["id"].length > 0 &&
    identity["id"].length <= 160 &&
    identity["id"].includes("@"),
  );
}

function binaryMaterial(value: unknown): boolean {
  if (value instanceof Uint8Array) return value.byteLength > 0;
  if (typeof value === "string") return base64Material(value);
  const serialized = record(value);
  const data = serialized?.["data"];
  return Boolean(
    serialized?.["type"] === "Buffer" &&
    (
      (Array.isArray(data) &&
        data.length > 0 &&
        data.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) ||
      (typeof data === "string" && base64Material(data))
    ),
  );
}

function base64Material(value: string): boolean {
  return value.length >= 4 &&
    value.length <= 65_536 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
import { jidNormalizedUser } from "baileys";
