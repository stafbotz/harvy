# Harvy Agent Entry Point

`AGENTS.md` adalah kontrak utama untuk Codex, Claude Code, Antigravity, dan
manusia yang bekerja di repositori Harvy. Adaptor alat harus menunjuk ke file
ini, bukan menyalin aturannya.

## Kontrak ringkas

<!-- SESSION_CONTEXT_START -->
- Klasifikasikan task sebelum memuat konteks. Untuk coding dan diagnosis, mulai
  dari permintaan pengguna, `git status`/diff, kode, tes, konfigurasi, dan error.
- Dokumentasi dibaca bertahap hanya untuk pertanyaan konkret yang belum dijawab
  kode. Jangan membaca seluruh `docs/`, `STATUS.md`, atau `LOG.md` sebagai
  orientasi default.
- Kode dan tes yang benar-benar berjalan adalah bukti keadaan aktual. Jangan
  mengklaim kemampuan, perbaikan, atau hasil tes yang belum diperiksa.
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
| `coding` | Level 0, kode/tes/config terkait | status subsystem; invariant/ADR yang mengikat kontrak |
| `bug investigation` | Level 0, error, diff, kode, tes regresi | maksimal 3 entri LOG relevan; status/known defect subsystem |
| `review` | Level 0, diff, kode, tes | invariant, status, atau ADR yang langsung diuji; jangan edit |
| `architecture` | Level 0–1 dan aliran kode nyata | `ARCHITECTURE.md`, `INVARIANTS.md`, ADR terkait |
| `product behavior` | kode/tes perilaku saat ini | status subsystem, bagian relevan `PROJECT.md`; Constitution bila hak/safety tersentuh |
| `privacy/safety` | kode/tes/policy terkait | bagian relevan `CONSTITUTION.md`, `INVARIANTS.md`, status safety, ADR terkait |
| `documentation` | dokumen target dan bukti kode/tes | INDEX/WORKFLOW/ADR hanya bila kontrak navigasi atau keputusan berubah |
| `research` | pertanyaan dan sumber lokal terkait | sumber eksternal bila diminta atau sumber lokal tidak cukup; pisahkan riset dari status aktual |
| `release/operations` | git state, config, command, diff | `DEVELOPMENT.md`, `TESTING.md`, `WORKFLOW.md`, status platform/console |

Daftar ini adalah izin memilih konteks, bukan daftar bacaan wajib.

## Progressive context loading

- **Level 0:** `AGENTS.md`, task pengguna, dan git state. Snapshot
  `docs/agent/CURRENT.md` boleh hadir dari bootstrap, tetapi bukan authority.
- **Level 1:** file kode, tes, konfigurasi, diff, error, dan call path terkait.
- **Level 2:** ringkasan STATUS subsystem atau maksimal tiga entri LOG yang
  cocok dengan capability, nama file, error, atau fungsi yang sedang ditangani.
- **Level 3:** arsitektur, invariant, product, constitution, testing, atau ADR
  hanya ketika task benar-benar menyentuh kontraknya.

Sebelum implementasi, bacaan dokumentasi idealnya tidak melebihi sekitar 15%
konteks kerja. Ini pedoman, bukan angka yang harus dihitung. Berhenti membaca
setelah kontrak, invariant, dan acceptance criteria yang relevan ditemukan;
lanjutkan ke kode. Jangan membuka dokumen hanya karena tercantum di routing dan
jangan membaca dua sumber yang menjelaskan hal sama bila sumber ringkas cukup.

Untuk dokumen besar, cari dulu lalu baca rentang kecil:

```bash
rg -n "namaSubsystem|namaFungsi|error|^## " src tests docs/engineering/status docs/LOG.md docs/log
sed -n '120,180p' path/to/file.md
# PowerShell ekuivalen: (Get-Content path/to/file.md)[119..179]
```

Jangan membaca `LOG.md`, `STATUS.md`, `TESTING.md`, `INVARIANTS.md`,
`PROJECT.md`, atau `CONSTITUTION.md` penuh kecuali task memang mengaudit
keseluruhan dokumen itu.

## Alur default coding dan diagnosis

1. Baca kontrak ini dan pahami permintaan pengguna.
2. Periksa `git status`, diff, struktur repo, dan file yang disebut.
3. Cari kode serta tes yang relevan; reproduksi atau bentuk hipotesis dari
   bukti, bukan dari dokumentasi.
4. Buka konteks Level 2/3 hanya untuk pertanyaan yang masih belum terjawab.
5. Implementasikan perubahan terkecil yang menyelesaikan akar masalah.
6. Jalankan verifikasi yang proporsional, lalu gerbang repo untuk perubahan
   kode.
7. Perbarui dokumentasi hanya jika keadaan proyek berubah secara material.

## Urutan otoritas dan kejujuran

Dengan tetap tunduk pada instruksi platform, gunakan urutan ini:

1. instruksi eksplisit pengguna dan scope task;
2. batas keselamatan, privasi, permission, serta perlindungan secret/data;
3. kode dan tes yang benar-benar berjalan;
4. status subsystem yang terverifikasi;
5. ADR dan invariant yang masih berlaku;
6. dokumentasi product atau roadmap;
7. histori LOG.

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

`docs/LOG.md` hanya untuk perubahan material, keputusan durable, insiden, hasil
live test, migrasi, atau perubahan status kemampuan. Entri harus ringkas:

```md
## YYYY-MM-DD — Judul singkat

Scope: file atau subsystem utama.
Changed: perubahan perilaku atau kontrak.
Verified: perintah dan hasil penting.
Not verified: yang belum diuji.
Next: hanya bila ada tindak lanjut material.
```

Arsipkan whole entry saat LOG melewati batas yang dijelaskan di file itu.
Detail panjang berada di issue, PR, ADR, atau evidence, bukan LOG.

## Kepemilikan, keselamatan, dan “Jangan lakukan”

- Pengguna menguasai tujuan, scope, dan penerimaan akhir.
- Pilih kerja berurutan, paralel dalam working tree yang sama, atau terisolasi
  berdasarkan scope, overlap file, shared output, dan risiko integrasi.
  Worktree/clone bersifat opsional, bukan syarat bagi penulis kedua.
- Hak edit Reviewer, QA, atau subagent mengikuti task yang diberikan, bukan
  label perannya. Review atau diskusi eksplisit tetap read-only kecuali
  pengguna juga meminta implementasi.
- Periksa git state dan diff yang relevan sebelum menulis. Pertahankan perubahan
  pengguna atau pekerjaan lain yang sudah ada dan koordinasikan setiap overlap.
- Jangan menaruh `.env`, token, API key, credential, identifier pengguna nyata,
  atau kutipan data pengguna nyata di Git, docs, log, output bootstrap, atau
  laporan.
- Jangan menurunkan safety/privacy, melemahkan tes agar hijau, mengarang status,
  atau memperluas tindakan eksternal tanpa otorisasi.
- Jangan memuat seluruh docs, melakukan orientasi panjang sebelum mengetahui
  subsystem, menulis LOG demi administrasi, atau memperbarui semua docs agar
  diff tampak konsisten.

## Gerbang selesai

Untuk perubahan kode: periksa diff, jalankan tes terarah bila ada, lalu
`npm run check` dan `npm test`. Untuk kontrak/bootstrap agent, jalankan juga
`npm run context:check`. Dokumentasikan hanya perubahan material sesuai aturan
di atas. Hasil akhir selalu menyebut hasil nyata dan apa yang tidak diuji.

Untuk review, diskusi, atau diagnosis read-only, tidak diperlukan diff, LOG,
atau gerbang build palsu; cukup bukti yang diperiksa dan batas pemeriksaan.

Quick ref:

```bash
npm ci
npm run check
npm test
npm run build
npm run dev
npm start
```

Detail navigasi ada di `docs/INDEX.md`; detail serah-terima dan operasi Git ada
di `docs/operations/WORKFLOW.md`.
