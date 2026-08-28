# Cara Bekerja di Repositori Harvy

`AGENTS.md` adalah kontrak utama. Dokumen ini hanya merinci Git, serah-terima,
verifikasi, dan perubahan dokumentasi; ia bukan daftar bacaan bootstrap.

## Mulai dari pekerjaan, bukan dokumentasi

Ikuti kontrak code-first di `AGENTS.md`, lalu untuk coding/diagnosis:

1. periksa permintaan, `git status`, diff, dan file yang disebut;
2. cari kode, tes, konfigurasi, error, dan call path terkait;
3. buka status subsystem atau dokumen kontrak hanya untuk pertanyaan yang belum
   terjawab;
4. berhenti membaca docs ketika invariant dan acceptance criteria relevan sudah
   ditemukan.

Review dan diskusi tetap read-only. Riset tidak boleh diubah menjadi klaim
kemampuan tanpa bukti kode/tes atau status subsystem terverifikasi.

## Koordinasi perubahan

- Agent menentukan sendiri apakah pekerjaan paling aman dan efisien dilakukan
  berurutan, paralel dalam working tree yang sama, atau terisolasi lewat
  worktree/clone. Tidak ada mandat satu penulis untuk seluruh working tree.
- Periksa dirty state sebelum edit. Perubahan yang sudah ada adalah milik
  pengguna atau pekerjaan lain; pertahankan dan jangan menimpanya.
- Reviewer, QA, dan subagent tidak otomatis read-only hanya karena bekerja
  paralel. Hak edit mengikuti scope tugas yang diberikan; task yang memang
  berupa review atau diskusi tetap read-only sesuai `AGENTS.md`.
- Untuk pekerjaan paralel, pilih pembagian scope, koordinasi overlap, dan
  isolasi berdasarkan file yang disentuh, shared output, serta risiko konflik.
  Worktree/clone adalah alat opsional, bukan syarat bagi penulis kedua.
- Pengguna menguasai scope dan penerimaan akhir. Jangan memperluas mutasi atau
  tindakan eksternal hanya karena secara teknis memungkinkan.

## Branch dan operasi remote

- Agent boleh bekerja dan commit pada branch aktif, termasuk `main`.
- Branch/PR opsional dan digunakan bila pemisahan atau review membutuhkannya.
- Push, force-push, merge, rebase, publish, dan penghapusan branch hanya bila
  diminta.
- Gunakan command Git non-interaktif. Jangan memakai destructive reset atau
  checkout untuk membersihkan perubahan yang tidak dibuat sendiri.

## Verifikasi proporsional

Perubahan harus memiliki bukti paling dekat dengan risikonya:

- bug fix: reproduksi atau tes regresi bila dapat diotomatisasi;
- perubahan perilaku: tes yang membuktikan kontrak baru;
- refactor: tes existing yang membuktikan perilaku tetap;
- docs-only: link, command, ukuran, atau verifier yang relevan.

Loop default untuk perubahan lokal:

```bash
npm run test:file -- tests/<berkas>.test.ts
npm run check
```

Perubahan lintas subsystem menjalankan seluruh tes terkait. Tambahkan
`npm test` sekali pada checkpoint akhir hanya untuk perubahan safety, privacy,
permission, storage, deletion, concurrency, atau release. Jangan memakai suite
penuh sebagai baseline dan final rutin.

Tes hijau tidak membuktikan Telegram, WhatsApp, provider, tombol, reminder,
atau deployment nyata bekerja. Laporan akhir menyebut command dan hasil yang
benar-benar dijalankan, serta bagian yang tidak diuji. Jangan menjalankan live
provider, kanal, atau data nyata tanpa scope/otorisasi yang sesuai.

## Dokumentasi berdasarkan materialitas

Perubahan kode tidak otomatis mewajibkan dokumentasi. Perbarui sumber yang
tepat bila ada perubahan capability/status, user behavior, data/API/storage,
permission/privacy, architecture/invariant, setup/testing procedure, durable
decision, migration, incident, live evidence, atau known defect.

Tidak perlu mengubah docs untuk typo, formatting, rename internal, refactor
murni, tes yang mengunci perilaku yang sudah tercatat, diskusi tanpa keputusan,
atau investigasi tanpa perubahan fakta.

Pilih tujuan yang paling kecil:

| Fakta yang berubah | Tujuan |
|---|---|
| Keadaan capability/blocker | `docs/engineering/STATUS.md` + satu detail subsystem |
| Snapshot lintas subsystem | `docs/agent/CURRENT.md` dengan mengganti bullet lama |
| Keputusan durable | ADR terkait atau ADR baru |
| Bukti panjang | `docs/evidence/`, issue, atau PR |
| Perubahan material/insiden/live test | entri ringkas `docs/LOG.md` |
| Navigasi | `docs/INDEX.md` |

LOG bukan jurnal sesi. Ikuti format dan ambang arsip yang tertulis di file
aktif. Jangan menyalin raw logs, prompt, identifier pengguna nyata, credential,
atau kutipan pengguna ke LOG/STATUS/CURRENT.

## Kapan berhenti dan bertanya

Berhenti bila jawaban dapat mengubah pengalaman pengguna, retensi/privasi data,
permission/security/credential, tindakan ke layanan luar, dependency/model/
biaya, atau batas Constitution. Kumpulkan pertanyaan dan ajukan sekaligus.
Pilihan implementasi kecil yang mudah dibalik boleh diambil konsisten dengan
kode sekitar dan dilaporkan sebagai asumsi.

## Serah-terima

Hasil akhir cukup memuat:

1. outcome dan file/subsystem yang berubah;
2. diagnosis atau keputusan penting;
3. command verifikasi dan hasil nyata;
4. apa yang tidak diuji;
5. risiko atau tindak lanjut material.

Review menyebut severity, lokasi, bukti, dampak, dan cara verifikasi. Jika tidak
ada temuan, katakan demikian beserta batas review; jangan membuat edit
administratif untuk memenuhi gerbang yang tidak berlaku.

## Secret dan data pengguna

Remote Harvy harus tetap privat. Jangan pernah memasukkan `.env`, token, API
key, credential, identifier pengguna nyata, raw transcript, atau data pengguna
nyata ke Git, docs, output bootstrap, terminal report, atau chat. Gunakan
akun/fixture uji dan login resmi alat. Redaksi credential-like text yang sudah
telanjur ditemukan tanpa mengulang nilainya di output.
