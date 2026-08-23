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

export interface WhatsAppPrivateMessage {
  accountId: string;
  userId: string;
  messageId: string;
  text: string;
  at: string;
  quotedMessageId?: string | null;
  document?: WhatsAppPrivateInboundDocument | null;
}

export interface WhatsAppPrivateInboundDocument {
  fileName: string;
  mimetype: string;
  declaredBytes: number | null;
  data: Buffer;
}

export interface WhatsAppPrivateReply {
  text: string;
  document?: WhatsAppPrivateOutboundDocument;
  /** Dipanggil adapter hanya setelah socket mengakui send. */
  onDelivered?(delivery?: WhatsAppPrivateDelivery): Promise<void>;
  /** Dipanggil ketika reply dibuat tetapi tidak mencapai boundary send. */
  onDeliveryFailed?(delivery?: WhatsAppPrivateDelivery): Promise<void>;
}

export interface WhatsAppPrivateOutboundDocument {
  fileName: string;
  mimetype: string;
  data: Buffer;
  caption?: string;
}

export type WhatsAppPrivateReplyResult = WhatsAppPrivateReply | string | null;

export interface WhatsAppPrivateDelivery {
  text: string;
  bubbleCount: number;
  complete: boolean;
  messageIds?: string[];
}

export interface WhatsAppPrivateMessageRef {
  messageId: string | null;
}

/** Socket-scoped transport; setiap operasi memeriksa generation akun. */
export interface WhatsAppPrivateTransport {
  isCurrent(): boolean;
  send(text: string): Promise<WhatsAppPrivateMessageRef>;
  sendDocument(document: WhatsAppPrivateOutboundDocument): Promise<WhatsAppPrivateMessageRef>;
  edit(reference: WhatsAppPrivateMessageRef, text: string): Promise<void>;
  remove(reference: WhatsAppPrivateMessageRef): Promise<void>;
  typing(): Promise<void>;
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

/** Ingress teks privat; pemrosesan tetap dikunci oleh flag transport. */
export function normalizeBaileysPrivateMessage(
  raw: WAMessage,
  context: Pick<BaileysMessageContext, "accountId" | "selfJids">,
): WhatsAppPrivateMessage | null {
  const key = raw.key as typeof raw.key & { remoteJidAlt?: string | null };
  const remoteJid = key.remoteJid ?? undefined;
  const remoteJidAlt = key.remoteJidAlt ?? undefined;
  if (
    !remoteJid ||
    isJidGroup(remoteJid) ||
    raw.key.fromMe === true ||
    !raw.key.id
  ) {
    return null;
  }
  const userId = stablePrivateId(remoteJid, remoteJidAlt);
  if (!userId || context.selfJids.some((jid) => normalizedJid(jid) === userId)) {
    return null;
  }
  const content = extractMessageContent(raw.message);
  const text = messageText(content) ?? "";
  const descriptor = privateDocumentDescriptor(content);
  const contextInfo = messageContextInfo(content);
  if (!text && !descriptor) return null;
  return {
    accountId: context.accountId,
    userId,
    messageId: raw.key.id,
    text,
    at: timestampIso(raw.messageTimestamp),
    quotedMessageId: contextInfo?.stanzaId ?? null,
    document: descriptor
      ? { ...descriptor, data: Buffer.alloc(0) }
      : null,
  };
}

export function whatsappPrivateOwnerId(userId: string): string {
  const normalized = normalizedJid(userId);
  if (!isPrivateUserJid(normalized)) {
    throw new Error("Identitas private WhatsApp tidak sah.");
  }
  return `whatsapp-user:${normalized}`;
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

function privateDocumentDescriptor(
  content: ReturnType<typeof extractMessageContent>,
): Omit<WhatsAppPrivateInboundDocument, "data"> | null {
  const document = content?.documentMessage;
  if (!document) return null;
  const fileName = (document.fileName ?? "project.zip")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, "_")
    .trim()
    .slice(0, 160);
  const mimetype = (document.mimetype ?? "application/octet-stream")
    .trim()
    .slice(0, 120);
  const declared = document.fileLength == null
    ? null
    : toNumber(document.fileLength);
  return {
    fileName: fileName || "project.zip",
    mimetype,
    declaredBytes: declared !== null && Number.isSafeInteger(declared) &&
        declared >= 0
      ? declared
      : null,
  };
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

function stablePrivateId(
  remoteJid: string,
  remoteJidAlt: string | undefined,
): string | null {
  const values = uniqueJids([remoteJid, remoteJidAlt].filter(
    (value): value is string => Boolean(value),
  )).filter(isPrivateUserJid);
  return values.find((value) => value.endsWith("@lid")) ?? values[0] ?? null;
}

function isPrivateUserJid(value: string): boolean {
  return value.endsWith("@s.whatsapp.net") || value.endsWith("@lid");
}
