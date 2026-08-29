import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderHelpMessage,
  renderUnknownCommand,
  shortcutCommandCatalog,
  userCommandCatalog,
} from "../src/bot/commands.js";

const OPTIONS = { codingRuntime: true, githubPublishing: true };

describe("permukaan jalan pintas per kanal", () => {
  // WhatsApp tidak punya tombol, jadi 29 command lama tampil sebagai satu
  // daftar rata di dalam gelembung chat. Sekitar dua pertiganya menduplikasi
  // kemampuan yang sudah punya pintu bahasa alami.
  it("memangkas daftar WhatsApp tanpa mengurangi yang dapat dijalankan", () => {
    const dijalankan = userCommandCatalog(OPTIONS, "whatsapp");
    const ditampilkan = shortcutCommandCatalog(OPTIONS, "whatsapp");

    assert.ok(
      ditampilkan.length < dijalankan.length / 2,
      `ditampilkan ${ditampilkan.length} dari ${dijalankan.length}`,
    );
    for (const command of ditampilkan) {
      assert.ok(
        dijalankan.some((entry) => entry.command === command.command),
        command.command,
      );
    }
  });

  // Yang tersisa dipilih karena alasannya, bukan jumlahnya: tindakan yang tidak
  // dapat dibatalkan, yang memegang credential, dan dua pintu navigasi.
  it("mempertahankan aksi yang memang menuntut invokasi tegas", () => {
    const shown = shortcutCommandCatalog(OPTIONS, "whatsapp")
      .map((command) => command.command);
    for (
      const command of [
        "menu",
        "bantuan",
        "hapus-data",
        "tarik-izin",
        "lupakan-semua",
        "ekspor",
        "github",
        "publish",
        "code",
      ]
    ) {
      assert.ok(shown.includes(command), command);
    }
  });

  // Command lama tetap dikenali. Menyembunyikan bukan menghapus; pengguna yang
  // sudah menghafal /tugas tidak boleh mendadak kehilangan jalannya.
  it("tidak melepas satu pun command dari katalog eksekusi", () => {
    const dijalankan = userCommandCatalog(OPTIONS, "whatsapp")
      .map((command) => command.command);
    for (const command of ["tugas", "memori", "zona", "code_status", "sesi"]) {
      assert.ok(dijalankan.includes(command), command);
    }
  });

  // Telegram menaruh command di menu native yang dapat dicari dan mengelola
  // sisanya lewat tombol. Memangkasnya di sana menyembunyikan pintu yang tetap
  // terdaftar di menu native.
  it("tidak memangkas kanal yang punya permukaan native", () => {
    assert.equal(
      shortcutCommandCatalog(OPTIONS, "telegram").length,
      userCommandCatalog(OPTIONS, "telegram").length,
    );
  });

  it("menjelaskan bahwa yang tidak terdaftar tetap dapat ditulis biasa", () => {
    const help = renderHelpMessage(OPTIONS, "whatsapp");
    assert.match(help, /tulis saja/iu);
    assert.doesNotMatch(help, /\/zona/u);
  });

  // Salah ketik satu huruf pernah membuang 28 baris jalan pintas ke layar.
  it("menjawab slash tak dikenal tanpa membuang seluruh katalog", () => {
    const unknown = renderUnknownCommand(OPTIONS, "whatsapp");
    const help = renderHelpMessage(OPTIONS, "whatsapp");

    assert.ok(unknown.length < help.length / 2, `${unknown.length} vs ${help.length}`);
    assert.match(unknown, /belum punya perintah itu/iu);
    assert.match(unknown, /\/bantuan/u);
  });
});
