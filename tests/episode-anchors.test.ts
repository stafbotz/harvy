import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EPISODE_ANCHORS_LIMIT,
  EPISODE_ANCHORS_PER_KIND_LIMIT,
  harvestEpisodeAnchors,
  renderEpisodeAnchors,
} from "../src/core/episode-anchors.js";
import type { StoredConversationTurn } from "../src/domain/history.js";

function turns(...texts: string[]): StoredConversationTurn[] {
  return texts.map((text, index) => ({
    role: index % 2 === 0 ? "user" : "harvy",
    text,
    at: "2026-09-04T00:00:00.000Z",
    sequence: index + 1,
  }));
}

function textsOf(turnList: StoredConversationTurn[]): string[] {
  return harvestEpisodeAnchors(turnList).map((anchor) => anchor.text);
}

describe("panen fakta persis dari episode", () => {
  it("menangkap tanggal, hari, dan jam apa adanya", () => {
    const found = textsOf(turns(
      "ujian biologi Selasa 16 September jam 07.00",
    ));
    assert.ok(found.includes("16 September"), found.join("|"));
    assert.ok(found.includes("Selasa"), found.join("|"));
    assert.ok(found.includes("jam 07.00"), found.join("|"));
  });

  it("menangkap bab, halaman, dan nomor soal", () => {
    const found = textsOf(turns(
      "yang keluar bab 7 sampai bab 9, halaman 142, soal nomor 12-20",
    ));
    assert.ok(found.includes("bab 7"), found.join("|"));
    assert.ok(found.includes("bab 9"), found.join("|"));
    assert.ok(found.includes("halaman 142"), found.join("|"));
    assert.ok(found.some((text) => text.includes("12-20")), found.join("|"));
  });

  it("menangkap nilai dan KKM", () => {
    const found = textsOf(turns("kemarin nilai 68, padahal KKM 75"));
    assert.ok(found.includes("nilai 68"), found.join("|"));
    assert.ok(found.includes("KKM 75"), found.join("|"));
  });

  it("menangkap kelas beserta jurusannya", () => {
    const found = textsOf(turns("aku kelas 11 IPA 3"));
    assert.ok(
      found.some((text) => text.toLowerCase().startsWith("kelas 11")),
      found.join("|"),
    );
  });

  it("tidak menghitung 'minggu' sebagai nama hari", () => {
    // Dalam bahasa Indonesia ia jauh lebih sering berarti satuan waktu.
    // Menangkapnya akan menaruh anchor palsu di setiap konteks giliran.
    const found = textsOf(turns("ujiannya minggu depan kayaknya"));
    assert.equal(found.includes("minggu"), false, found.join("|"));
    assert.equal(found.includes("Minggu"), false, found.join("|"));
  });

  it("tidak menangkap desimal biasa sebagai jam", () => {
    const found = textsOf(turns("rata-ratanya naik 1.5 poin aja"));
    assert.deepEqual(found, [], found.join("|"));
  });

  it("mengembalikan daftar kosong ketika tidak ada yang persis", () => {
    assert.deepEqual(
      harvestEpisodeAnchors(turns("aku bingung banget sama tugas ini")),
      [],
    );
  });

  it("mencatat giliran tempat anchor muncul", () => {
    const anchors = harvestEpisodeAnchors(turns(
      "ujiannya 16 September",
      "oke, 16 September ya",
      "iya",
    ));
    const tanggal = anchors.find((anchor) => anchor.text === "16 September");
    assert.deepEqual(tanggal?.sourceSequences, [1, 2]);
    assert.equal(tanggal?.count, 2);
  });

  it("mengurutkan yang paling sering muncul lebih dulu", () => {
    const anchors = harvestEpisodeAnchors(turns(
      "bab 7 dulu",
      "bab 7 ya",
      "bab 7 sama bab 9",
    ));
    const materi = anchors.filter((anchor) => anchor.kind === "materi");
    assert.equal(materi[0]?.text, "bab 7");
    assert.equal(materi[0]?.count, 3);
  });

  it("membatasi jumlah per jenis dan keseluruhan", () => {
    const banyak = Array.from(
      { length: 40 },
      (_unused, index) => `bab ${index + 1} dan halaman ${index + 100}`,
    );
    const anchors = harvestEpisodeAnchors(turns(...banyak));
    assert.ok(anchors.length <= EPISODE_ANCHORS_LIMIT);
    const materi = anchors.filter((anchor) => anchor.kind === "materi");
    assert.ok(materi.length <= EPISODE_ANCHORS_PER_KIND_LIMIT);
  });

  it("deterministik: masukan sama menghasilkan keluaran sama", () => {
    // Seluruh nilainya bergantung pada tidak adanya model di jalur ini.
    const sumber = turns(
      "ujian Selasa 16 September jam 07.00, bab 7, KKM 75",
      "iya bab 7 lagi",
    );
    assert.deepEqual(
      harvestEpisodeAnchors(sumber),
      harvestEpisodeAnchors(sumber),
    );
  });

  it("memindai seluruh giliran, bukan berhenti di yang pertama", () => {
    // Regex global dipakai berulang; `lastIndex` yang tidak dinolkan akan
    // melewatkan giliran berikutnya secara diam-diam.
    const found = textsOf(turns(
      "bab 1",
      "bab 2",
      "bab 3",
    ));
    assert.equal(found.length, 3, found.join("|"));
  });

  it("merender per jenis, atau null bila kosong", () => {
    const anchors = harvestEpisodeAnchors(turns(
      "ujian 16 September, bab 7",
    ));
    const rendered = renderEpisodeAnchors(anchors) ?? "";
    assert.match(rendered, /waktu persis: .*16 September/u);
    assert.match(rendered, /materi persis: .*bab 7/u);
    assert.equal(renderEpisodeAnchors([]), null);
  });
});
