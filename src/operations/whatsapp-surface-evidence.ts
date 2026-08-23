import {
  proto,
  type WAMessage,
} from "baileys";

export type WhatsAppSurfaceOperation =
  | "create"
  | "edit"
  | "delete"
  | "pin"
  | "unpin"
  | "other";

/**
 * Bukti user-facing yang dilihat akun tester. `eventMessageId` adalah envelope
 * protokol; `surfaceMessageId` adalah bubble yang dibuat atau dimutasi.
 */
export interface WhatsAppSurfaceEvent {
  operation: WhatsAppSurfaceOperation;
  eventMessageId: string | null;
  surfaceMessageId: string | null;
  text: string;
  hasDocument: boolean;
}

export interface WhatsAppSurfaceSummary {
  created: number;
  edited: number;
  deleted: number;
  pinned: number;
  unpinned: number;
  distinctCreatedSurfaces: number;
  distinctMutatedSurfaces: number;
}

export interface ObservedWhatsAppRunAnchor {
  surfaceMessageId: string;
  firstEvent: WhatsAppSurfaceEvent;
  createEvents: number;
  editEvents: number;
  pinEvents: number;
  unpinEvents: number;
  deleteEvents: number;
  consistentTextTarget: boolean;
}

export function parseWhatsAppSurfaceEvent(
  message: WAMessage,
): WhatsAppSurfaceEvent {
  const envelope = unwrapTransientMessage(message.message);
  const eventMessageId = message.key.id ?? null;
  const protocol = envelope?.protocolMessage;
  if (protocol?.editedMessage) {
    return {
      operation: "edit",
      eventMessageId,
      surfaceMessageId: protocol.key?.id ?? null,
      text: messageContentText(protocol.editedMessage),
      hasDocument: messageContentHasDocument(protocol.editedMessage),
    };
  }
  if (protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE) {
    return {
      operation: "delete",
      eventMessageId,
      surfaceMessageId: protocol.key?.id ?? null,
      text: "",
      hasDocument: false,
    };
  }

  const pin = envelope?.pinInChatMessage;
  if (pin) {
    const operation = pin.type === proto.Message.PinInChatMessage.Type.PIN_FOR_ALL
      ? "pin"
      : pin.type === proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL
      ? "unpin"
      : "other";
    return {
      operation,
      eventMessageId,
      surfaceMessageId: pin.key?.id ?? null,
      text: "",
      hasDocument: false,
    };
  }

  const text = messageContentText(envelope);
  const hasDocument = messageContentHasDocument(envelope);
  return {
    operation: text || hasDocument ? "create" : "other",
    eventMessageId,
    surfaceMessageId: eventMessageId,
    text,
    hasDocument,
  };
}

export function summarizeWhatsAppSurfaceEvents(
  events: readonly WhatsAppSurfaceEvent[],
): WhatsAppSurfaceSummary {
  const created = events.filter((event) => event.operation === "create");
  const mutated = events.filter((event) =>
    event.operation === "edit" || event.operation === "delete" ||
    event.operation === "pin" || event.operation === "unpin"
  );
  return {
    created: created.length,
    edited: events.filter((event) => event.operation === "edit").length,
    deleted: events.filter((event) => event.operation === "delete").length,
    pinned: events.filter((event) => event.operation === "pin").length,
    unpinned: events.filter((event) => event.operation === "unpin").length,
    distinctCreatedSurfaces: distinctSurfaceCount(created),
    distinctMutatedSurfaces: distinctSurfaceCount(mutated),
  };
}

/**
 * Menemukan target Run Anchor dari event create maupun edit. Linked device
 * WhatsApp dapat menerima mutasi untuk sebuah bubble tanpa sempat menerima
 * event create-nya, jadi target mutasi adalah bukti surface yang sah dan tidak
 * boleh dianggap sebagai anchor yang hilang.
 */
export function observeWhatsAppRunAnchor(
  events: readonly WhatsAppSurfaceEvent[],
  isRunAnchorText: (text: string) => boolean,
): ObservedWhatsAppRunAnchor | null {
  const textEvents = events.filter((event) =>
    (event.operation === "create" || event.operation === "edit") &&
    Boolean(event.surfaceMessageId) && isRunAnchorText(event.text)
  );
  const firstEvent = textEvents[0];
  const surfaceMessageId = firstEvent?.surfaceMessageId;
  if (!firstEvent || !surfaceMessageId) return null;

  const textTargets = new Set(
    textEvents.map((event) => event.surfaceMessageId).filter(
      (value): value is string => Boolean(value),
    ),
  );
  const targetsAnchor = (event: WhatsAppSurfaceEvent): boolean =>
    event.surfaceMessageId === surfaceMessageId;

  return {
    surfaceMessageId,
    firstEvent,
    createEvents: textEvents.filter((event) => event.operation === "create")
      .length,
    editEvents: textEvents.filter((event) => event.operation === "edit")
      .length,
    pinEvents: events.filter((event) =>
      event.operation === "pin" && targetsAnchor(event)
    ).length,
    unpinEvents: events.filter((event) =>
      event.operation === "unpin" && targetsAnchor(event)
    ).length,
    deleteEvents: events.filter((event) =>
      event.operation === "delete" && targetsAnchor(event)
    ).length,
    consistentTextTarget: textTargets.size === 1,
  };
}

function distinctSurfaceCount(events: readonly WhatsAppSurfaceEvent[]): number {
  return new Set(
    events.map((event) => event.surfaceMessageId).filter(
      (value): value is string => Boolean(value),
    ),
  ).size;
}

function unwrapTransientMessage(
  value: proto.IMessage | null | undefined,
): proto.IMessage | null {
  let current = value ?? null;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    return current;
  }
  return current;
}

function messageContentText(
  value: proto.IMessage | null | undefined,
): string {
  const current = unwrapTransientMessage(value);
  if (!current) return "";
  if (current.conversation) return current.conversation.trim();
  if (current.extendedTextMessage?.text) {
    return current.extendedTextMessage.text.trim();
  }
  if (current.documentMessage?.caption) {
    return current.documentMessage.caption.trim();
  }
  return "";
}

function messageContentHasDocument(
  value: proto.IMessage | null | undefined,
): boolean {
  return Boolean(unwrapTransientMessage(value)?.documentMessage);
}
