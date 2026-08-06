# Cara Bekerja di Repositori Harvy

`AGENTS.md` adalah kontrak utama. Dokumen ini hanya merinci Git, serah-terima,
verifikasi, dan perubahan dokumentasi; ia bukan daftar bacaan bootstrap.

## Mulai dari pekerjaan, bukan dokumentasi

Klasifikasikan task menurut `AGENTS.md`, lalu untuk coding/diagnosis:

1. periksa permintaan, `git status`, diff, dan file yang disebut;
2. cari kode, tes, konfigurasi, error, dan call path terkait;
3. buka status subsystem atau dokumen kontrak hanya untuk pertanyaan yang belum
   terjawab;
4. berhenti membaca docs ketika invariant dan acceptance criteria relevan sudah
   ditemukan.

Review dan diskusi tetap read-only. Riset tidak boleh diubah menjadi klaim
kemampuan tanpa bukti kode/tes atau status subsystem terverifikasi.

## Satu penulis pada satu working tree

- Hanya satu pihak menulis file pada satu waktu. Reviewer/QA boleh bekerja
  paralel secara baca-saja dan mengembalikan temuan kepada penulis.
- Periksa dirty state sebelum edit. Perubahan yang sudah ada adalah milik
  pengguna atau pekerjaan lain; pertahankan dan jangan menimpanya.
- Bila dua penulis benar-benar diperlukan, gunakan worktree/clone terpisah.
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

Perubahan kode harus memiliki bukti paling dekat dengan risikonya:

- bug fix: reproduksi atau tes regresi bila dapat diotomatisasi;
- perubahan perilaku: tes yang membuktikan kontrak baru;
- refactor: tes existing yang membuktikan perilaku tetap;
- bootstrap agent: `npm run context:check` dan tes kontrak;
- docs-only: link, command, ukuran, atau verifier yang relevan.

Untuk kode produk, gerbang default tetap:

```bash
npm run check
npm test
```

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

## Hook dan batas enforcement

Aktifkan sekali per clone:

```bash
git config core.hooksPath .githooks
```

Hook hanya menjalankan verifier ketika kontrak/bootstrap/status, CURRENT, atau
LOG aktif ikut staged. Ia memvalidasi snapshot index—termasuk deletion/rename—
tanpa memaksa dokumentasi untuk perubahan kecil atau menebak materialitas dari
path. Verifier menjaga pointer lintas-agent, ukuran snapshot/output/LOG, dan
larangan bootstrap besar.

Batasnya disengaja: hook dapat dilewati dengan `--no-verify` dan hanya menilai
struktur snapshot staged, bukan makna diff. Ia tidak dapat menentukan apakah
perilaku atau keputusan benar-benar berubah. Materialitas, budget 15%,
relevansi bacaan, serta kebenaran semantik tetap diperiksa penulis dan reviewer.

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
