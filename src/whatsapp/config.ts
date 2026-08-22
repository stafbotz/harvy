export interface WhatsAppAccountConfig {
  /** Alias operasional stabil; wajib bukan nomor telepon atau identitas JID. */
  id: string;
  /** E.164 tanpa tanda +, hanya dipakai ketika akun belum pernah dipasangkan. */
  phoneNumber: string;
}

export type WhatsAppPairingMode = "qr" | "code";

export interface WhatsAppConfig {
  enabled: boolean;
  /** Ingress dan delivery chat pribadi; sengaja default-off dari kanal grup. */
  privateEnabled: boolean;
  accounts: WhatsAppAccountConfig[];
  pairingMode: WhatsAppPairingMode;
  authFolder: string;
  groupFile: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

export function parseWhatsAppAccounts(
  raw: string | undefined,
): WhatsAppAccountConfig[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw whatsAppConfigurationError(
      "CONFIG_WHATSAPP_ACCOUNTS_JSON",
      "WHATSAPP_ACCOUNTS harus berupa JSON array yang sah.",
    );
  }
  if (!Array.isArray(parsed)) {
    throw whatsAppConfigurationError(
      "CONFIG_WHATSAPP_ACCOUNTS_NOT_ARRAY",
      "WHATSAPP_ACCOUNTS harus berupa JSON array.",
    );
  }

  const seen = new Set<string>();
  const seenPhoneNumbers = new Set<string>();
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw whatsAppConfigurationError(
        "CONFIG_WHATSAPP_ACCOUNT_NOT_OBJECT",
        `WHATSAPP_ACCOUNTS[${index}] harus berupa object.`,
      );
    }
    const record = item as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"].trim() : "";
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(id)) {
      throw whatsAppConfigurationError(
        "CONFIG_WHATSAPP_ACCOUNT_ALIAS_INVALID",
        `WHATSAPP_ACCOUNTS[${index}].id harus berupa alias operasional yang diawali huruf; setelahnya hanya boleh huruf, angka, _ atau - (maksimal 32). Jangan gunakan nomor telepon atau JID.`,
      );
    }
    const uniqueId = id.toLocaleLowerCase("en-US");
    if (seen.has(uniqueId)) {
      throw whatsAppConfigurationError(
        "CONFIG_WHATSAPP_ACCOUNT_ALIAS_DUPLICATE",
        `ID akun WhatsApp duplikat: ${id}.`,
      );
    }
    seen.add(uniqueId);

    const rawPhone =
      typeof record["phoneNumber"] === "string"
        ? record["phoneNumber"].trim()
        : "";
    const phoneNumber = rawPhone.replace(/[+\s()-]/g, "");
    if (!/^[1-9]\d{7,14}$/.test(phoneNumber)) {
      throw whatsAppConfigurationError(
        "CONFIG_WHATSAPP_PHONE_INVALID",
        `WHATSAPP_ACCOUNTS[${index}].phoneNumber harus E.164 8–15 digit tanpa awalan 0.`,
      );
    }
    if (seenPhoneNumbers.has(phoneNumber)) {
      throw whatsAppConfigurationError(
        "CONFIG_WHATSAPP_PHONE_DUPLICATE",
        `Nomor akun WhatsApp duplikat: ${phoneNumber}.`,
      );
    }
    seenPhoneNumbers.add(phoneNumber);

    return { id, phoneNumber };
  });
}

export function parsePairingMode(
  value: string | undefined,
): WhatsAppPairingMode {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  if (!normalized || normalized === "qr") return "qr";
  if (normalized === "code") return "code";
  throw whatsAppConfigurationError(
    "CONFIG_WHATSAPP_PAIRING_MODE_INVALID",
    "WHATSAPP_PAIRING_MODE harus qr atau code.",
  );
}

export function parseEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  if (!normalized) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw whatsAppConfigurationError(
    "CONFIG_WHATSAPP_ENABLED_INVALID",
    "WHATSAPP_ENABLED harus true atau false.",
  );
}

export function parsePrivateEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase("en-US");
  if (!normalized) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw whatsAppConfigurationError(
    "CONFIG_WHATSAPP_PRIVATE_ENABLED_INVALID",
    "WHATSAPP_PRIVATE_ENABLED harus true atau false.",
  );
}

function whatsAppConfigurationError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: "ConfigurationError",
    code,
  });
}
