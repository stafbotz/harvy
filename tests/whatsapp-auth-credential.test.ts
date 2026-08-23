import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isWhatsAppCredentialReady,
  whatsAppCredentialJids,
} from "../src/whatsapp/auth-credential.js";

describe("status credential WhatsApp", () => {
  it("menerima flag registered lama hanya bersama identitas", () => {
    assert.equal(isWhatsAppCredentialReady({
      registered: true,
      me: { id: "628123456789:1@s.whatsapp.net" },
    }), true);
    assert.equal(isWhatsAppCredentialReady({ registered: true }), false);
  });

  it("mengenali pair-success QR Baileys 7 meski flag registered tetap false", () => {
    const credential = qrPairSuccessCredential();
    assert.equal(isWhatsAppCredentialReady(credential), true);
    assert.equal(
      isWhatsAppCredentialReady(JSON.parse(JSON.stringify(credential)) as unknown),
      true,
    );
  });

  it("menolak state parsial me-only dan material pair-success yang rusak", () => {
    assert.equal(isWhatsAppCredentialReady({
      registered: false,
      me: { id: "628123456789:1@s.whatsapp.net" },
    }), false);
    const incomplete = qrPairSuccessCredential();
    delete incomplete.account.deviceSignature;
    assert.equal(isWhatsAppCredentialReady(incomplete), false);
  });

  it("mengambil identitas PN dan LID credential tanpa menerima JID lain", () => {
    assert.deepEqual(whatsAppCredentialJids({
      me: {
        id: "628123456789:3@s.whatsapp.net",
        phoneNumber: "628123456789@s.whatsapp.net",
        lid: "101234567890:3@lid",
        name: "Tester",
      },
    }), [
      "628123456789@s.whatsapp.net",
      "101234567890@lid",
    ]);
    assert.deepEqual(whatsAppCredentialJids({
      me: { id: "status@broadcast", lid: "invalid" },
    }), []);
  });
});

function qrPairSuccessCredential() {
  return {
    registered: false,
    me: { id: "628123456789:1@s.whatsapp.net" },
    account: {
      details: Buffer.from([1]),
      accountSignatureKey: Buffer.from([2]),
      accountSignature: Buffer.from([3]),
      deviceSignature: Buffer.from([4]),
    } as {
      details: Buffer;
      accountSignatureKey: Buffer;
      accountSignature: Buffer;
      deviceSignature?: Buffer;
    },
    signalIdentities: [{
      identifier: { name: "628123456789", deviceId: 1 },
      identifierKey: Buffer.from([5]),
    }],
  };
}
