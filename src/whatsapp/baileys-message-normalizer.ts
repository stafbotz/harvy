import {
  extractMessageContent,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  toNumber,
  type WAMessage,
} from "baileys";
import type { GroupMessage } from "../domain/group.js";

export interface BaileysMessageContext {
  accountId: string;
  selfJids: readonly string[];
  groupName: string | null;
  ownMessageIds: ReadonlySet<string>;
  isAdmin(participantJids: readonly string[]): boolean;
  authorityEpoch?: number;
}

/**
 * Memperkecil event Baileys menjadi kontrak domain grup.
 *
 * Hanya teks/caption pesan baru yang lolos. Event history (`append`) ditolak
 * sebelum fungsi ini dipanggil oleh account manager.
 */
export function normalizeBaileysGroupMessage(
  raw: WAMessage,
  context: BaileysMessageContext,
): GroupMessage | null {
  const groupId = raw.key.remoteJid ?? undefined;
  if (
    !groupId ||
    !isJidGroup(groupId) ||
    raw.key.fromMe === true ||
    !raw.key.id
  ) {
    return null;
  }

  const participant = raw.key.participant ?? undefined;
  const participantAlt = raw.key.participantAlt ?? undefined;
  // Baileys dapat menukar PN dan LID antara field utama/alternatif menurut
  // addressing mode. LID dipilih sebagai identitas utama yang stabil; kedua
  // bentuk tetap dibawa agar memori lama dapat digabung dan dihapus bersama.
  const participantId = stableParticipantId(participant, participantAlt);
  if (!participantId) return null;

  const content = extractMessageContent(raw.message);
  const text = messageText(content);
  if (!text) return null;

  const contextInfo = messageContextInfo(content);
  const selfJids = new Set(context.selfJids.map(normalizedJid));
  const mentionedJids = contextInfo?.mentionedJid ?? [];
  const quotedParticipant = contextInfo?.participant ?? undefined;
  const quotedId = contextInfo?.stanzaId ?? undefined;
  const participantJids = [participant, participantAlt].filter(
    (value): value is string => Boolean(value),
  );
  // `fromMe` is the primary signal, but event/addressing glitches must not
  // turn Harvy's own outbound message into a new inbound group turn.
  if (
    participantJids.some((jid) => selfJids.has(normalizedJid(jid)))
  ) {
    return null;
  }

  return {
    scope: { channel: "whatsapp", groupId },
    accountId: context.accountId,
    messageId: raw.key.id,
    participantId,
    participantAliases: uniqueJids(participantJids),
    participantName: cleanDisplayName(raw.pushName),
    groupName: context.groupName,
    text,
    at: timestampIso(raw.messageTimestamp),
    mentionsHarvy: mentionedJids.some((jid) =>
      selfJids.has(normalizedJid(jid)),
    ),
    repliesToHarvy:
      (Boolean(quotedId) && context.ownMessageIds.has(quotedId!)) ||
      (Boolean(quotedParticipant) &&
        selfJids.has(normalizedJid(quotedParticipant!))),
    quotedMessageId: quotedId ?? null,
    quotedParticipantId: quotedParticipant
      ? normalizedJid(quotedParticipant)
      : null,
    isAdmin: context.isAdmin(participantJids),
    authorityEpoch: context.authorityEpoch ?? 0,
  };
}

function messageText(
  content: ReturnType<typeof extractMessageContent>,
): string | null {
  if (!content) return null;
  const value =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.buttonsResponseMessage?.selectedDisplayText ??
    content.templateButtonReplyMessage?.selectedDisplayText ??
    content.listResponseMessage?.title;
  if (typeof value !== "string") return null;

  const clean = value.replace(/\u0000/g, "").trim();
  return clean ? clean.slice(0, 12_000) : null;
}

function messageContextInfo(
  content: ReturnType<typeof extractMessageContent>,
) {
  const type = getContentType(content);
  if (!type || !content) return undefined;
  const node = content[type];
  if (typeof node !== "object" || node === null || !("contextInfo" in node)) {
    return undefined;
  }
  const value = (node as { contextInfo?: unknown }).contextInfo;
  return typeof value === "object" && value !== null
    ? (value as {
        mentionedJid?: string[] | null;
        participant?: string | null;
        stanzaId?: string | null;
      })
    : undefined;
}

function timestampIso(value: WAMessage["messageTimestamp"]): string {
  const seconds =
    value == null || toNumber(value) <= 0
      ? Math.floor(Date.now() / 1_000)
      : toNumber(value);

  const milliseconds = seconds > 10_000_000_000 ? seconds : seconds * 1_000;
  const timestamp = new Date(milliseconds);
  return Number.isFinite(timestamp.getTime())
    ? timestamp.toISOString()
    : new Date().toISOString();
}

function cleanDisplayName(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/[\u0000\r\n<>]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 80) : null;
}

function normalizedJid(value: string): string {
  return jidNormalizedUser(value);
}

function uniqueJids(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizedJid).filter(Boolean))];
}

function stableParticipantId(
  participant: string | undefined,
  participantAlt: string | undefined,
): string | null {
  const values = uniqueJids(
    [participant, participantAlt].filter(
      (value): value is string => Boolean(value),
    ),
  );
  return values.find((value) => value.endsWith("@lid")) ?? values[0] ?? null;
}
