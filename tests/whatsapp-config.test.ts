import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseEnabled,
  parsePairingMode,
  parseWhatsAppAccounts,
} from "../src/whatsapp/config.js";

describe("konfigurasi WhatsApp", () => {
  it("membaca banyak akun dan menormalkan nomor pairing", () => {
    assert.deepEqual(
      parseWhatsAppAccounts(
        JSON.stringify([
          { id: "utama", phoneNumber: "+62 812-3456-7890" },
          { id: "kelas_2", phoneNumber: "628111111111" },
        ]),
      ),
      [
        { id: "utama", phoneNumber: "6281234567890" },
        { id: "kelas_2", phoneNumber: "628111111111" },
      ],
    );
  });

  it("menolak ID duplikat, nomor/JID sebagai ID, dan jalur terselubung", () => {
    assert.throws(
      () =>
        parseWhatsAppAccounts(
          JSON.stringify([
            { id: "Utama", phoneNumber: "628123456789" },
            { id: "utama", phoneNumber: "628111111111" },
          ]),
        ),
      /duplikat/i,
    );
    assert.throws(
      () =>
        parseWhatsAppAccounts(
          JSON.stringify([
            { id: "../akun", phoneNumber: "628123456789" },
          ]),
        ),
      /hanya boleh/i,
    );
    assert.throws(
      () =>
        parseWhatsAppAccounts(
          JSON.stringify([
            { id: "62812345", phoneNumber: "62812345" },
          ]),
        ),
      /alias operasional/i,
    );
    assert.throws(
      () =>
        parseWhatsAppAccounts(
          JSON.stringify([
            { id: "62812345@lid", phoneNumber: "62812345" },
          ]),
        ),
      /alias operasional/i,
    );
  });

  it("membaca sakelar eksplisit", () => {
    assert.equal(parseEnabled(undefined), false);
    assert.equal(parseEnabled("true"), true);
    assert.equal(parseEnabled("0"), false);
    assert.throws(() => parseEnabled("barangkali"), /true atau false/i);
  });

  it("memakai QR sebagai pairing default dan menerima code secara eksplisit", () => {
    assert.equal(parsePairingMode(undefined), "qr");
    assert.equal(parsePairingMode("QR"), "qr");
    assert.equal(parsePairingMode("code"), "code");
    assert.throws(() => parsePairingMode("otomatis"), /qr atau code/i);
  });
});
