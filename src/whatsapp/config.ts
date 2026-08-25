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
  /** Scope kausal private yang hanya sah pada exploratory live acceptance. */
  liveExplorationMessageScope?: string | null;
}

export function parseLiveExplorationMessageScope(
  value: string | undefined,
  gate: {
    environment: string | undefined;
    release: string | undefined;
    trace: string | undefined;
  },
): string | null {
  if (!value?.trim()) return null;
  if (
    gate.environment !== "development" ||
    gate.release !== "live-acceptance" ||
    gate.trace !== "content-free-v1"
  ) {
    throw whatsAppConfigurationError(
      "CONFIG_WHATSAPP_LIVE_EXPLORATION_SCOPE_FORBIDDEN",
      "Scope exploratory WhatsApp hanya boleh aktif pada live acceptance development.",
    );
  }
  const normalized = value.trim();
  if (!/^HARVYEXP[A-F0-9]{12}$/u.test(normalized)) {
    throw whatsAppConfigurationError(
      "CONFIG_WHATSAPP_LIVE_EXPLORATION_SCOPE_INVALID",
      "Scope exploratory WhatsApp tidak sah.",
    );
  }
  return normalized;
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
    const id = parseWhatsAppAccountAlias(record["id"],
      `WHATSAPP_ACCOUNTS[${index}].id`);
    const uniqueId = id.toLocaleLowerCase("en-US");
    if (seen.has(uniqueId)) {
      throw whatsAppConfigurationError(
        "CONFIG_WHATSAPP_ACCOUNT_ALIAS_DUPLICATE",
        `ID akun WhatsApp duplikat: ${id}.`,
      );
    }
    seen.add(uniqueId);

    const phoneNumber = parseWhatsAppPhoneNumber(
      record["phoneNumber"],
      `WHATSAPP_ACCOUNTS[${index}].phoneNumber`,
    );
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

export function parseWhatsAppAccountAlias(
  value: unknown,
  field = "Alias akun WhatsApp",
): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z][a-z0-9_-]{0,31}$/iu.test(id)) {
    throw whatsAppConfigurationError(
      "CONFIG_WHATSAPP_ACCOUNT_ALIAS_INVALID",
      `${field} harus berupa alias operasional yang diawali huruf; setelahnya hanya boleh huruf, angka, _ atau - (maksimal 32). Jangan gunakan nomor telepon atau JID.`,
    );
  }
  return id;
}

export function parseWhatsAppPhoneNumber(
  value: unknown,
  field = "Nomor akun WhatsApp",
): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const phoneNumber = raw.replace(/[+\s()-]/gu, "");
  if (!/^[1-9]\d{7,14}$/u.test(phoneNumber)) {
    throw whatsAppConfigurationError(
      "CONFIG_WHATSAPP_PHONE_INVALID",
      `${field} harus E.164 8–15 digit tanpa awalan 0.`,
    );
  }
  return phoneNumber;
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
