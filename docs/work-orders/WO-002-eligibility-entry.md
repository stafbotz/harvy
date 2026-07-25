# WO-002: Gerbang Kelas 8+ dan Pintu Masuk Harvy

- Status: `READY_FOR_REVIEW`
- Pemilik produk: pengguna Harvy
- Orkestrator: ChatGPT Work
- Pelaksana historis aktual: ChatGPT Work melalui konektor GitHub
- Builder perbaikan berikutnya: Codex (GPT-5.6 Sol), hanya setelah dispatch baru
- Reviewer: Claude Code (Opus 5), read-only
- QA/integrasi: Antigravity (Gemini 3.6 Flash), read-only
- Base branch: `main` pada `9971ac2b3835ae69a2f16c65a6c6835f2b233f8a`
- Work branch: `work/wo-002-eligibility-entry`

> **Koreksi provenance, 26 Juli 2026:** implementasi ini dibuat langsung oleh
> ChatGPT Work melalui konektor GitHub. Label lama “Codex (Work Mode)” salah dan
> telah dikoreksi. Kode tetap dipertahankan sebagai prototipe, tetapi belum
> direview atau diuji secara independen.

## Masalah dan hasil pengguna

Harvy hanya boleh digunakan mulai kelas 8 SMP atau tingkat setara, tetapi
prototipe sebelumnya langsung membuka fitur tugas dan memperkenalkan Harvy
seolah hanya aplikasi daftar tugas.

Setelah paket ini, pengguna baru bertemu pembuka yang jujur dan manusiawi,
menjawab pemeriksaan kelas dengan satu tombol, lalu hanya dapat memakai fitur
prototipe setelah memenuhi batas penggunaan. Pengguna dapat mengoreksi jawaban.

## Dalam ruang lingkup

- Pemeriksaan kelayakan berbasis pernyataan mandiri pada chat pribadi Telegram.
- Status `eligible` atau `ineligible` yang terpisah per ID pengguna.
- Penyimpanan data minimum dalam berkas lokal terpisah.
- Tombol untuk jawaban dan koreksi.
- Gerbang untuk seluruh fitur lama selain `/start` dan alur koreksi.
- Pembuka yang menyatakan Harvy adalah AI pendamping kehidupan pelajar.
- Pesan jujur bahwa pemahaman cerita bebas belum tersambung pada build ini.
- Tes unit repository/service dan tes integrasi update Telegram.
- Dokumentasi produk yang sudah disahkan sebagai sumber kebenaran repo.

## Di luar ruang lingkup

- Model AI, API berbayar, dan pemahaman bahasa alami.
- Sistem percakapan untuk lima konteks MVP.
- Foto, OCR, memori percakapan, atau data sensitif.
- Alur keselamatan risiko tinggi.
- Verifikasi umur atau kelas melalui sekolah, kartu pelajar, atau identitas.
- Tinjauan hukum untuk rilis publik.
- PostgreSQL, deployment, dan migrasi data.

## Keputusan yang sudah dikunci

- Harvy adalah AI pendamping kehidupan pelajar, bukan hanya pendamping belajar.
- Pengguna minimum adalah kelas 8 SMP atau tingkat setara.
- Prototipe memakai pernyataan mandiri.
- Hanya status memenuhi/tidak memenuhi syarat yang disimpan.
- Nama sekolah, kelas persis, alamat, dan kartu pelajar tidak dikumpulkan.
- Telegram pribadi adalah kanal percobaan pertama.
- Harvy tidak berpura-pura memahami pesan bebas sebelum mesin percakapan tersedia.

## Kriteria penerimaan

- [x] `/start` untuk pengguna baru menjelaskan bahwa Harvy adalah AI dan
      menanyakan batas kelas 8+ dengan tombol.
- [x] Pengguna `eligible` melihat pembuka percakapan dan dapat memakai fitur
      tugas yang sudah ada.
- [x] Pengguna `ineligible` mendapat penolakan ramah dan tidak dapat memakai
      fitur lain.
- [x] Pengguna dapat mengoreksi jawaban kelayakan.
- [x] Status dipisahkan per pengguna dan bertahan setelah repository dibuka
      ulang.
- [x] Berkas status tidak memuat kelas persis, sekolah, atau identitas tambahan.
- [x] Pembatasan chat pribadi tetap berlaku.
- [x] Seluruh tes lama tetap lulus.

## Konteks yang wajib dibaca

| Dokumen/kode | Alasan |
|---|---|
| `docs/product/CONSTITUTION.md` | Privasi, kejujuran AI, kendali, dan tahap perkembangan |
| `docs/product/MVP-v0.1.md` | Batas kelas dan pengalaman masuk yang disahkan |
| `docs/engineering/TESTING.md` | Gerbang verifikasi |
| `src/bot/create-bot.ts` | Alur Telegram saat ini |
| `src/storage/file-task-repository.ts` | Pola penyimpanan prototipe |

## Batas implementasi

- Tidak menambah dependency atau layanan eksternal.
- Tidak mengubah format `data/tasks.json`.
- Status baru berada di `data/eligibility.json`.
- Tidak memasukkan token atau data pengguna nyata.
- Pesan bebas tidak boleh diteruskan ke model atau disimpan.

## Verifikasi wajib

Automated:

- `npm run check`
- `npm test`

Manual:

- Jalankan skenario kelayakan dan perintah tugas pada akun Telegram uji.
- Restart proses dan pastikan status tetap berlaku.

## Berhenti dan tanyakan jika

- Implementasi membutuhkan verifikasi identitas atau pengumpulan data tambahan.
- Diperlukan model, API, dependency, atau biaya baru.
- Perubahan menyentuh keselamatan psikologis atau rilis publik.

## Catatan komunikasi

| Waktu | Alat/model aktual | Mode/peran | Tindakan | Branch/commit/bukti | Hasil | Belum terbukti | Pemilik berikutnya |
|---|---|---|---|---|---|---|---|
| 25 Juli 2026 | ChatGPT Work | `BUILD` historis (penyimpangan) | Membuat gerbang kelas dan PR #1 secara langsung | `work/wo-002-eligibility-entry`; implementasi `60cddd3`; head sebelum koreksi `4611288` | Pelaksana melaporkan check dan 18 tes lulus | Review independen dan Telegram nyata | Orkestrator |
| 26 Juli 2026 | ChatGPT Work | `ORCHESTRATE` dokumentasi | Mengoreksi identitas pelaksana dan menetapkan jalur review/QA | PR #1 dan Work Order ini | Dokumentasi saja; tidak mengubah kode aplikasi | Hasil Claude Code dan Antigravity | Claude Code |

## Handoff implementasi historis

- Pelaksana aktual: ChatGPT Work melalui konektor GitHub; bukan Codex.
- Commit/PR: implementasi `60cddd314c8b32abbdafae9813064f708233dcaf`;
  draft PR `https://github.com/stafbotz/harvy/pull/1`.
- Ringkasan: gerbang kelas 8+, penyimpanan status minimum, koreksi jawaban,
  pembuka manusiawi, perlindungan fitur lama, dan dokumentasi acuan.
- Automated yang dilaporkan pelaksana:
  - `npm run check` — PASS.
  - `npm test` — PASS (18 test dalam 7 suite).
- Manual: `NOT RUN` — tidak ada token dan akun Telegram uji pada sesi
  pelaksana.
- Status bukti: laporan di atas belum diulang oleh Reviewer atau QA independen.
- Asumsi: pemeriksaan mandiri cukup untuk prototipe terbatas, sesuai definisi
  MVP yang disahkan.
- Risiko tersisa: copy, tombol, penyimpanan, dan restart belum diuji pada
  Telegram nyata; percakapan bebas belum tersedia.
- Dokumentasi yang diubah saat implementasi: README, INDEX, TESTING,
  Konstitusi, Definisi MVP, dan WO-002.
- Pemilik berikutnya: Claude Code untuk review read-only.

## Hasil review

- Reviewer yang ditugaskan: Claude Code (Opus 5), read-only.
- Base/head: `main@9971ac2...work/wo-002-eligibility-entry@<head yang dikunci saat dispatch>`.
- Status: `NOT RUN`.
- `BLOCKER`/`IMPORTANT`: menunggu laporan.
- `MINOR`: menunggu laporan.
- Catatan: reviewer wajib melaporkan alat/model aktual; profil yang berbeda
  tidak boleh disubstitusi diam-diam.

## Hasil QA/integrasi

- QA yang ditugaskan: Antigravity (Gemini 3.6 Flash), read-only.
- Commit target: ditentukan setelah review awal.
- Status: `NOT RUN`.
- Skenario minimum: gerbang baru, lolos, ditolak, koreksi, perintah tugas,
  persistensi setelah restart, dan pembatasan chat pribadi.
- Data: akun uji dan data sintetis; jangan masukkan token ke chat/repo.

## Rencana kelanjutan

1. Claude Code meninjau PR #1 tanpa mengedit.
2. Antigravity menjalankan QA pada commit yang dikunci tanpa mengedit.
3. ChatGPT Work menggabungkan temuan dan menjelaskannya kepada pengguna.
4. Jika pengguna menyetujui perbaikan, Codex (GPT-5.6 Sol) menerima dispatch
   baru sebagai satu-satunya Builder.

## Penerimaan

- Keputusan pengguna: menunggu uji hasil WO-002.
- Commit yang diterima: menunggu.
- Tanggal: menunggu.
