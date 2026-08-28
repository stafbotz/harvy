# Harvy Agent Entry Point

Kontrak utama untuk agent dan manusia di repositori Harvy. Adaptor alat harus
menunjuk ke berkas ini, bukan menyalin aturannya.

## Kontrak ringkas

<!-- SESSION_CONTEXT_START -->
- Klasifikasikan task sebelum memuat konteks. Untuk coding dan diagnosis, mulai
  dari permintaan pengguna, `git status`/diff, kode, tes, konfigurasi, dan error.
- Dokumentasi dibaca bertahap hanya untuk pertanyaan konkret yang belum dijawab
  kode. Jangan membaca seluruh `docs/`, `STATUS.md`, atau `LOG.md` sebagai
  orientasi default.
- Kode yang benar-benar dijalankan adalah bukti keadaan aktual. `npm test`
  menstub setiap panggilan model, jadi ia membuktikan pipa dan kontrak, bukan
  perilaku Harvy. Bukti perilaku hanya datang dari eval atau kanal nyata.
  Jangan mengklaim kemampuan, perbaikan, atau hasil tes yang belum diperiksa.
- Suite penuh ≈ 7 menit. Iterasi dengan `npm run test:file -- dist/tests/X.js`
  (≈8 detik); jalankan `npm test` sekali sebelum selesai. Sebelum menyimpulkan
  kamu merusak sesuatu, cek `docs/engineering/KNOWN-FAILURES.md`.
- Jaga keselamatan, privasi, permission, secret, dan data pengguna. Perubahan
  pada batas tersebut wajib membaca kontrak terkait dan gagal tertutup.
- Dokumentasi dan LOG hanya diperbarui bila fakta, perilaku, kontrak, keputusan
  durable, bukti live, defect, atau prosedur proyek berubah secara material.
- Koordinasikan penulisan secara adaptif: pilih kerja berurutan, paralel, atau
  terisolasi berdasarkan scope, overlap, shared output, dan risiko. Peran agent
  tidak otomatis menentukan hak edit; review/diskusi eksplisit tetap read-only.
- Jangan push, merge, rebase, atau membuat PR kecuali diminta.
<!-- SESSION_CONTEXT_END -->

## Pilih kelas kerja lebih dulu

| Kelas | Konteks minimum | Tambahan bila pertanyaan konkret menuntutnya |
|---|---|---|
| `coding` | Level 0, kode/tes/config terkait | status subsystem; invariant/ADR yang mengikat |
| `bug investigation` | Level 0, error, diff, kode, tes regresi | maks 3 entri LOG; known defect subsystem |
| `review` | Level 0, diff, kode, tes | invariant/status/ADR yang diuji; jangan edit |
| `architecture` | Level 0–1 dan aliran kode nyata | `ARCHITECTURE.md`, `INVARIANTS.md`, ADR |
| `product behavior` | kode/tes perilaku saat ini | status subsystem, `PROJECT.md`; Constitution bila hak/safety tersentuh |
| `privacy/safety` | kode/tes/policy terkait | `CONSTITUTION.md`, `INVARIANTS.md`, status safety |
| `documentation` | dokumen target dan bukti kode/tes | INDEX/WORKFLOW/ADR bila kontrak navigasi berubah |
| `research` | pertanyaan dan sumber lokal | sumber eksternal bila diminta; pisahkan riset dari status |
| `release/operations` | git state, config, command, diff | `DEVELOPMENT.md`, `TESTING.md`, `WORKFLOW.md` |

Daftar ini adalah izin memilih konteks, bukan daftar bacaan wajib.

## Progressive context loading

- **Level 0:** `AGENTS.md`, task pengguna, dan git state. Snapshot
  `docs/agent/CURRENT.md` boleh hadir dari bootstrap, tetapi bukan authority.
- **Level 1:** file kode, tes, konfigurasi, diff, error, dan call path terkait.
- **Level 2:** ringkasan STATUS subsystem atau maksimal tiga entri LOG yang
  cocok dengan capability, nama file, error, atau fungsi yang sedang ditangani.
- **Level 3:** arsitektur, invariant, product, constitution, testing, atau ADR
  hanya ketika task benar-benar menyentuh kontraknya.

Sebelum implementasi, bacaan dokumentasi idealnya di bawah sekitar 15% konteks
kerja; ini pedoman, bukan angka yang dihitung. Berhenti membaca setelah
kontrak, invariant, dan acceptance criteria yang relevan ditemukan. Jangan membuka dokumen hanya karena
tercantum di routing, dan jangan membaca dua sumber yang menjelaskan hal sama.
Untuk dokumen besar, cari dulu lalu baca rentang kecil:

```bash
rg -n "namaSubsystem|namaFungsi|error|^## " src tests docs/engineering/status docs/LOG.md
sed -n '120,180p' path/to/file.md
```

Jangan membaca `LOG.md`, `STATUS.md`, `TESTING.md`, `INVARIANTS.md`,
`PROJECT.md`, atau `CONSTITUTION.md` penuh kecuali task memang mengaudit
keseluruhan dokumen itu.

## Alur default coding dan diagnosis

1. Periksa `git status`, diff, dan file yang disebut pengguna.
2. Cari kode serta tes yang relevan; bentuk hipotesis dari bukti, bukan dari
   dokumentasi.
3. Buka konteks Level 2/3 hanya untuk pertanyaan yang masih belum terjawab.
4. Implementasikan perubahan terkecil yang menyelesaikan akar masalah.
5. Jalankan verifikasi proporsional, lalu gerbang repo.

## Urutan otoritas dan kejujuran

Dengan tetap tunduk pada instruksi platform, gunakan urutan ini:

1. instruksi eksplisit pengguna dan scope task;
2. batas keselamatan, privasi, permission, serta perlindungan secret/data;
3. perilaku yang benar-benar dijalankan: eval provider nyata dan pengujian
   kanal live untuk pertanyaan perilaku;
4. kode yang dibaca dan unit test yang dijalankan, untuk pertanyaan pipa,
   kontrak, dan regresi;
5. status subsystem yang terverifikasi;
6. ADR dan invariant yang masih berlaku;
7. dokumentasi product atau roadmap;
8. histori LOG.

Nomor 3 dan 4 bukan hal yang sama dan tidak saling menggantikan. Seluruh unit
test Harvy menstub model, jadi suite hijau menjawab "apakah aku merusak
sesuatu", bukan "apakah Harvy menjadi lebih baik". Untuk klaim perilaku —
kualitas percakapan, pemilihan tool, pemahaman maksud pengguna — bukti yang sah
hanya `npm run eval:conversation` terhadap model nyata atau percakapan di kanal
sungguhan. Jangan pernah menyimpulkan Harvy membaik dari `npm test`.

Jika kode dan docs berbeda, gunakan perilaku kode yang terbukti untuk
diagnosis, laporkan selisihnya, dan jangan diam-diam mengubah salah satunya.
Perbaiki docs hanya bila termasuk scope atau diperlukan agar repository tidak
menyesatkan. Jika bukti belum diperiksa, katakan `belum diperiksa`; jika tes
belum dijalankan, jangan menyebutnya lulus.

## Kapan dokumentasi berubah

Wajib memperbarui sumber yang relevan bila perubahan material mencakup:

- kemampuan menjadi ada/tidak ada, perilaku pengguna, atau known defect;
- kontrak data/API/storage/permission/privacy;
- arsitektur, invariant, command setup, atau prosedur testing;
- keputusan durable, migrasi, insiden, atau hasil live test yang penting bagi
  penulis berikutnya.

Tidak wajib untuk typo, formatting, rename internal, refactor murni, tes yang
hanya mengunci perilaku terdokumentasi, diskusi tanpa keputusan, atau
investigasi yang tidak mengubah fakta. Menyentuh kode saja bukan alasan
memperbarui docs.

"Sumber yang relevan" berarti permukaan berikut, bukan hanya LOG. Sesi
2026-08-28 memperbarui LOG, CURRENT, kontrak ini, dan TESTING lalu berhenti,
sehingga `status/agent-runtime.md` tetap menyatakan tool callable "read-only"
padahal executor tulis sudah ada. Dokumen yang menyatakan kebalikan dari kode
lebih berbahaya daripada dokumen yang tidak ada.

| Yang berubah | Perbarui juga |
|---|---|
| kemampuan ada/tidak ada | `status/<subsystem>.md` dan barisnya di `engineering/STATUS.md` |
| perilaku pengguna atau known defect | status subsystem; `engineering/KNOWN-FAILURES.md` bila meninggalkan tes merah |
| command atau prosedur verifikasi | `engineering/TESTING.md` dan gerbang di kontrak ini |
| navigasi atau dokumen baru | `docs/INDEX.md` |
| apa pun di atas | satu entri `docs/LOG.md`, dan `docs/agent/CURRENT.md` bila basi |

Sebelum menyatakan selesai, cari klaim yang kini keliru, bukan hanya menambah
klaim baru: `rg -n "read-only|belum ada|tidak dapat" docs/engineering/status`.

Aturan LOG ada di sini, bukan hanya di dalam berkasnya, karena kontrak ini
melarang membacanya utuh sebagai orientasi. Satu entri memakai judul
`## YYYY-MM-DD — Judul singkat` lalu baris Scope, Changed, Verified, Not
verified, dan Next bila ada tindak lanjut; isinya beberapa paragraf pendek, dan
melewati ±2 KiB berarti seharusnya menjadi ADR atau evidence. Berkas aktif
maksimal 24 KiB atau 12 entri; saat terlampaui, pindahkan satu entri terlama
secara utuh ke `docs/log/YYYY-MM-DD.md` dan tautkan di kepala `LOG.md`. Jangan
memecah entri atau memindahkan yang masih memuat pekerjaan belum selesai.

## Kepemilikan, keselamatan, dan “Jangan lakukan”

- Pengguna menguasai tujuan, scope, dan penerimaan akhir.
- Pilih kerja berurutan, paralel, atau terisolasi berdasarkan scope, overlap
  file, shared output, dan risiko. Worktree opsional, bukan syarat.
- Hak edit mengikuti task yang diberikan, bukan label peran. Review atau
  diskusi eksplisit tetap read-only kecuali pengguna meminta implementasi.
- Periksa git state dan diff sebelum menulis. Pertahankan pekerjaan yang sudah
  ada dan koordinasikan setiap overlap.
- Jangan menaruh `.env`, token, API key, credential, identifier pengguna nyata,
  atau kutipan data pengguna nyata di Git, docs, log, output bootstrap, atau
  laporan.
- Jangan menurunkan safety/privacy, melemahkan tes agar hijau, mengarang status,
  atau memperluas tindakan eksternal tanpa otorisasi.
- Jangan memuat seluruh docs, melakukan orientasi panjang sebelum mengetahui
  subsystem, menulis LOG demi administrasi, atau memperbarui semua docs agar
  diff tampak konsisten.

## Gerbang selesai

Untuk perubahan kode: periksa diff, jalankan tes terarah, lalu `npm run check`
dan `npm test`. Untuk kontrak/bootstrap agent, jalankan juga
`npm run context:check`. Dokumentasikan hanya perubahan material sesuai aturan
di atas. Hasil akhir selalu menyebut hasil nyata dan apa yang tidak diuji.

Biaya perintah pada host 2 core, sebagai orde besaran:

| Perintah | Biaya | Kapan |
|---|---|---|
| `npm run check` | ≈7 detik | sesering mungkin |
| `npm run test:file -- dist/tests/X.test.js` | ≈8 detik | loop utama saat menulis kode |
| `npm test` | ≈7 menit | sekali, sebelum menyatakan selesai |
| `npm run context:check` | ≈3 detik | setelah menyentuh AGENTS/docs bootstrap |
| `npm run eval:conversation` | lambat, berbayar | saat mengubah prompt, routing, atau tool |

Menjalankan `npm test` berulang sebagai loop kerja adalah pemborosan terbesar
di repositori ini; `test:file` melakukan pekerjaan yang sama 56 kali lebih
cepat. `tsconfig.json` memakai `incremental`, jadi jangan menghapus
`dist/.tsbuildinfo`.

### Kegagalan tes yang sudah ada sebelumnya

Working tree repositori ini sering membawa pekerjaan yang belum selesai, jadi
sebagian tes dapat merah sebelum kamu menyentuh apa pun. Baca
`docs/engineering/KNOWN-FAILURES.md` sebelum menyimpulkan kamu menyebabkan
regresi; bila kegagalan tidak tercatat di sana, buktikan asalnya lebih dulu.
Bila kamu meninggalkan tes merah, catat di berkas itu.

### Bekerja pada prompt model

Prompt Harvy adalah kode yang dikunci tes: puluhan assertion mencocokkan frasa
persis di `persona.ts` dan `safety.ts`, dan pergantian baris ikut memutus
pencocokan. Ketika tes prompt gagal, pisahkan dulu apakah kamu menghapus **isi**
aturannya atau hanya mengganti **kata**-nya. Yang pertama dikembalikan; yang
kedua diselaraskan ke frasa yang dijaga tes. Melonggarkan assertion menghapus
aturan yang lahir dari bug nyata.

Aturan yang dikelompokkan per field keluaran lebih dipatuhi model daripada
aturan yang tersebar. Menambah aturan bukan cara menaikkan akurasi; ukur dulu.

### Mengukur perilaku model

`npm test` tidak menjawab pertanyaan perilaku. Yang bisa:

```bash
npm run eval:conversation -- --conversation-only --limit=22 --compact
npx tsx scripts/probe-chat.ts --message="..." --session=/tmp/sesi.json
```

Probe lain di `scripts/probe-*` mengukur kestabilan triase dan review safety.

`probe-chat.ts` menjalankan keputusan yang sama dengan adapter privat lalu
mencetak alasannya—intent, risk, route, pemakaian agent, dan biaya token nyata.

Ambil baseline sebelum mengubah prompt. Varians antar-run besar, jadi selisih
beberapa kasus bukan sinyal—ulangi kasus yang berubah secara terisolasi sebelum
mengklaim perbaikan. `--case=` hanya membaca argumen pertama; pisahkan dengan
koma.

Untuk review atau diagnosis read-only, cukup bukti yang diperiksa dan batas
pemeriksaannya; tidak perlu diff, LOG, atau gerbang build palsu.

Perintah lain: `npm ci`, `npm run build`, `npm run dev`, `npm start`. Detail
navigasi ada di `docs/INDEX.md`; serah-terima dan operasi Git di
`docs/operations/WORKFLOW.md`.
