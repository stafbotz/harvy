import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proto, type WAMessage } from "baileys";
import {
  observeWhatsAppRunAnchor,
  parseWhatsAppSurfaceEvent,
  summarizeWhatsAppSurfaceEvents,
} from "../src/operations/whatsapp-surface-evidence.js";

describe("bukti topologi bubble WhatsApp", () => {
  it("membedakan bubble baru dari edit pada bubble yang sama", () => {
    const created = parseWhatsAppSurfaceEvent(message("event-create", {
      conversation: "Menunggu giliran kerja",
    }));
    const edited = parseWhatsAppSurfaceEvent(message("event-edit", {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        key: { id: "event-create", fromMe: false },
        editedMessage: { conversation: "Sekarang: menyiapkan pekerjaan" },
      },
    }));

    assert.deepEqual(created, {
      operation: "create",
      eventMessageId: "event-create",
      surfaceMessageId: "event-create",
      text: "Menunggu giliran kerja",
      hasDocument: false,
    });
    assert.deepEqual(edited, {
      operation: "edit",
      eventMessageId: "event-edit",
      surfaceMessageId: "event-create",
      text: "Sekarang: menyiapkan pekerjaan",
      hasDocument: false,
    });
  });

  it("mencatat delete, pin, dan unpin terhadap target exact", () => {
    const deleted = parseWhatsAppSurfaceEvent(message("event-delete", {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.REVOKE,
        key: { id: "anchor-1", fromMe: false },
      },
    }));
    const pinned = parseWhatsAppSurfaceEvent(message("event-pin", {
      pinInChatMessage: {
        key: { id: "anchor-1", fromMe: false },
        type: proto.Message.PinInChatMessage.Type.PIN_FOR_ALL,
      },
    }));
    const unpinned = parseWhatsAppSurfaceEvent(message("event-unpin", {
      pinInChatMessage: {
        key: { id: "anchor-1", fromMe: false },
        type: proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL,
      },
    }));

    assert.equal(deleted.operation, "delete");
    assert.equal(pinned.operation, "pin");
    assert.equal(unpinned.operation, "unpin");
    assert.equal(deleted.surfaceMessageId, "anchor-1");
    assert.equal(pinned.surfaceMessageId, "anchor-1");
    assert.equal(unpinned.surfaceMessageId, "anchor-1");
    assert.deepEqual(
      summarizeWhatsAppSurfaceEvents([deleted, pinned, unpinned]),
      {
        created: 0,
        edited: 0,
        deleted: 1,
        pinned: 1,
        unpinned: 1,
        distinctCreatedSurfaces: 0,
        distinctMutatedSurfaces: 1,
      },
    );
  });

  it("menemukan Run Anchor saat linked device menerima edit sebelum create", () => {
    const edited = parseWhatsAppSurfaceEvent(message("event-edit", {
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        key: { id: "anchor-1", fromMe: false },
        editedMessage: {
          conversation:
            "🟢 Selesai\n\nSekarang: selesai\nPerubahan terakhir: rencana siap",
        },
      },
    }));
    const unpinned = parseWhatsAppSurfaceEvent(message("event-unpin", {
      pinInChatMessage: {
        key: { id: "anchor-1", fromMe: false },
        type: proto.Message.PinInChatMessage.Type.UNPIN_FOR_ALL,
      },
    }));

    const observed = observeWhatsAppRunAnchor(
      [edited, unpinned],
      isRunAnchorText,
    );

    assert.ok(observed);
    assert.equal(observed.surfaceMessageId, "anchor-1");
    assert.equal(observed.createEvents, 0);
    assert.equal(observed.editEvents, 1);
    assert.equal(observed.unpinEvents, 1);
    assert.equal(observed.consistentTextTarget, true);
  });

  it("menandai status Run Anchor yang berpindah ke bubble kedua", () => {
    const first = parseWhatsAppSurfaceEvent(message("anchor-1", {
      conversation:
        "🟡 Menunggu giliran kerja\n\nSekarang: antre\nPerubahan terakhir: belum ada",
    }));
    const replacement = parseWhatsAppSurfaceEvent(message("anchor-2", {
      conversation:
        "🟢 Selesai\n\nSekarang: selesai\nPerubahan terakhir: rencana siap",
    }));

    const observed = observeWhatsAppRunAnchor(
      [first, replacement],
      isRunAnchorText,
    );

    assert.ok(observed);
    assert.equal(observed.createEvents, 2);
    assert.equal(observed.consistentTextTarget, false);
  });
});

function isRunAnchorText(text: string): boolean {
  return /Sekarang:/u.test(text) && /Perubahan terakhir:/u.test(text);
}

function message(id: string, content: proto.IMessage): WAMessage {
  return {
    key: {
      id,
      remoteJid: "628000000000@s.whatsapp.net",
      fromMe: false,
    },
    message: content,
    messageTimestamp: 1,
  };
}
