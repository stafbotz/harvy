# Panduan kerja di repositori Harvy

Harvy adalah pendamping AI berbahasa Indonesia untuk pelajar: chat pribadi
Telegram (aktif), grup WhatsApp (beta), penyimpanan berkas lokal satu proses.
Status beta — belum siap produksi.

Berkas ini adalah satu-satunya panduan untuk agent dan manusia. `CLAUDE.md` dan
`.agent/rules/00-harvy-bootstrap.md` hanya menunjuk ke sini.

## Perintah

Node.js >= 22.16.0, ESM.

| Perintah | Biaya | Kapan |
|---|---|---|
| `npm run check` | ~6 detik | type-check seluruh proyek |
| `npm run test:file -- tests/X.test.ts` | ~4 detik | loop utama saat menulis kode |
| `npm test` | ~6,5 menit | build + seluruh `dist/tests/*.test.js` |
| `npm run dev` | — | jalankan dari sumber, reload otomatis |
| `npm run console:setup` | — | isi token kanal (token tidak di `.env`) |

`test:file` menjalankan TypeScript langsung lewat `tsx`, jadi argumennya
`tests/*.test.ts`, bukan `dist/`.

## Yang dibuktikan tes, dan yang tidak

Ini satu-satunya hal paling penting di berkas ini.

`npm test` menstub setiap panggilan model. Suite hijau membuktikan pipa dan
kontrak kode tidak rusak — **bukan** bahwa Harvy menjawab lebih baik. Bukti
perilaku hanya datang dari model nyata:

```bash
npm run eval:conversation -- --case=id-kasus,id-lain   # loop utama
npm run eval:conversation                              # 12 kasus default
npm run eval:conversation:full                         # seluruh corpus, lambat
npx tsx scripts/probe-chat.ts --message="..."          # satu giliran, cetak biaya token
```

Varians antar-run besar: tiga run penuh pernah memberi 50, 55, dan 53 lulus
pada corpus yang sama. Selisih beberapa kasus bukan sinyal — ambil baseline
dulu, dan ulangi kasus yang berubah secara terisolasi sebelum mengklaim
perbaikan.

Jangan menyebut sesuatu lulus bila belum dijalankan. Bila belum diperiksa,
tulis `belum diperiksa`.

## Seberapa banyak verifikasi

| Perubahan | Gerbang |
|---|---|
| satu subsystem | tes berkas terkait + `npm run check` |
| lintas subsystem | seluruh tes terkait + `npm run check` |
| safety, privasi, permission, storage, penghapusan, concurrency | tambah `npm test` |

Working tree sering membawa pekerjaan belum selesai, jadi sebagian tes bisa
merah sebelum kamu menyentuh apa pun. Baca
`docs/engineering/KNOWN-FAILURES.md` sebelum menyimpulkan kamu merusak sesuatu,
dan catat di sana bila meninggalkan tes merah.

## Peta arsitektur

Aliran satu arah: **adapter kanal -> layanan -> port penyimpanan.** Logika inti
tidak mengenal grammY, Baileys, maupun berkas. Detail di
`docs/engineering/ARCHITECTURE.md`.

- `src/app.ts` — satu-satunya composition root. Semua flag kemampuan besar
  default-off dan gagal tertutup.
- `src/domain/` — bentuk data dan port repository (antarmuka). Inti bergantung
  ke sini, bukan ke penyimpanan.
- `src/core/` — bebas kanal. `*-policy.ts` murni dan bisa diuji tanpa I/O;
  `*-service.ts` memegang orkestrasi.
- `src/ai/` — `persona.ts` (prompt), `understand.ts` (baca keluaran model
  sebagai masukan tidak tepercaya), `client.ts` (HTTP OpenAI-compatible),
  `safety.ts` (triase risiko + review balasan), `conversation.ts` (penyatu).
- `src/harness/` + `src/agent/` — kontrak dan executor Agent Runtime.
- `src/bot/` (Telegram) dan `src/whatsapp/` (Baileys) — adapter kanal. Grup
  WhatsApp punya pipeline sendiri, tidak lewat grammY.
- `src/storage/` — adapter berkas/SQLite. Pola tulis `.tmp` lalu `rename`,
  antrean promise. Semuanya **satu proses**.
- `src/sandbox-service.ts`, `src/local-git-service.ts`,
  `src/github-broker-service.ts` — trust domain terpisah. Broker memegang
  credential GitHub; Harvy dan sandbox tidak.

Menambah perilaku pribadi biasanya berurutan: tipe di `domain/`, port
repository bila datanya baru, logika + tes di `core/`, adapter di
`bot/create-bot.ts`, teks di `bot/messages.ts`.

Model hanya melihat capability yang benar-benar terpasang. `web.search` dan
`web.open` sudah dicabut.

## Jebakan yang memakan waktu

- ESM `NodeNext`: impor antarmodul wajib berakhiran `.js` walau sumbernya `.ts`.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, dan
  `noUnusedLocals` aktif. Impor atau variabel tak terpakai menggagalkan
  `npm run check`.
- `tsconfig.json` mencakup `src/`, `tests/`, **dan** `scripts/`. Skrip ikut
  type-check, tapi tidak ikut `npm test` (globnya hanya `dist/tests/*.test.js`).
- `incremental` aktif — jangan hapus `dist/.tsbuildinfo`.
- Prompt di `persona.ts` dan `safety.ts` dikunci tes yang mencocokkan frasa
  persis, termasuk pergantian baris. Bila tes prompt gagal, bedakan dulu: kamu
  menghapus **isi** aturannya, atau hanya mengganti **kata**-nya? Yang pertama
  dikembalikan, yang kedua diselaraskan. Jangan melonggarkan assertion-nya.
- `HARVY_REPLY_CACHE_SPINE` harus tetap di atas 4.096 byte demi prompt caching.

## Batas yang tidak boleh dilanggar

- Jangan menaruh `.env`, token, API key, credential, identifier pengguna nyata,
  atau kutipan data pengguna di Git, docs, atau laporan.
- Jangan menurunkan safety atau privasi, melemahkan tes agar hijau, atau
  mengarang status yang belum diverifikasi.
- Jangan push, merge, rebase, atau membuat PR kecuali diminta.
- Perubahan pada batas safety/privasi/permission wajib gagal tertutup.

## Dokumentasi

Repositori ini punya dokumentasi jauh lebih banyak daripada yang bisa dibaca
utuh (~1,7 MB). Perlakukan sebagai rujukan yang dicari, bukan bacaan awal:
mulai dari kode, `git status`, tes, dan error.

```bash
rg -n "namaFungsi|pesan error" src tests docs
```

Perbarui dokumen hanya bila fakta berubah material — kemampuan menjadi
ada/tidak ada, perilaku pengguna, known defect, kontrak data/API/storage, atau
prosedur verifikasi. Typo, refactor murni, dan investigasi tanpa temuan tidak
perlu entri.

Status terverifikasi terakhir: `docs/agent/CURRENT.md`. Peta dokumen:
`docs/INDEX.md`. Operasi Git: `docs/operations/WORKFLOW.md`.
