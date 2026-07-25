# WO-003: Percakapan AI Pertama Harvy

- Status: `READY_FOR_REVIEW`
- Pemilik produk: pengguna Harvy
- Orkestrator: ChatGPT Work
- Pelaksana historis aktual: ChatGPT Work melalui konektor GitHub
- Builder perbaikan berikutnya: Codex (GPT-5.6 Sol), hanya setelah dispatch baru
- Reviewer: Claude Code (Opus 5), read-only
- QA/integrasi: Antigravity (Gemini 3.6 Flash), read-only
- Base implementasi historis: `work/wo-002-eligibility-entry` pada `461128847c9fb19c97a065400f8e489bb44b5824`
- Base review: head `work/wo-002-eligibility-entry` yang dikunci dalam dispatch Reviewer
- Work branch: `work/wo-003-ai-conversation`

> **Koreksi provenance, 26 Juli 2026:** implementasi ini dibuat langsung oleh
> ChatGPT Work melalui konektor GitHub. Label lama “Codex (Work Mode)” salah dan
> telah dikoreksi. Kode dipertahankan sebagai prototipe, tetapi belum direview
> atau diuji secara independen.

## Masalah dan hasil pengguna

Setelah lolos gerbang kelas 8+, Harvy masih menolak pesan bebas karena model AI
belum tersambung. Pengguna belum dapat membawa cerita, kebingungan, keputusan,
materi belajar, atau keadaan harian dengan bahasa alami.

Setelah paket ini, pengguna prototipe yang sudah memenuhi batas kelas dan
memberi persetujuan pemrosesan AI dapat mengirim pesan bebas melalui Telegram.
Harvy memberikan satu respons awal yang tenang, relevan, dan mengarah pada
pemahaman atau langkah nyata tanpa mengaku memiliki memori atau kemampuan yang
belum tersedia.

## Dalam ruang lingkup

- Persetujuan terpisah sebelum isi pesan dikirim ke OpenAI.
- Cara melihat, menolak, menarik, atau memberikan kembali persetujuan AI.
- Integrasi OpenAI Responses API untuk pesan teks pengguna yang memenuhi syarat.
- Model awal `gpt-5.6-luna`, dapat diganti melalui konfigurasi.
- Instruksi Harvy yang mencakup lima konteks MVP tanpa menu atau mode kaku:
  kewajiban, belajar, keputusan, kewalahan ringan, dan bantuan manusia.
- Permintaan API menggunakan `store: false`; ID Telegram tidak dikirimkan.
- Moderasi resmi OpenAI memberi skor pada input dan memblokir output yang
  ditandai, sebagai lapisan tambahan untuk prototipe pengguna remaja.
- Konteks aktif maksimal enam pesan berada di RAM selama maksimal 30 menit agar
  balasan lanjutan tetap nyambung.
- Konteks aktif tidak ditulis ke disk, hilang saat restart, dapat dihapus lewat
  `/hapuspercakapan`, dan langsung dibersihkan ketika izin AI ditarik.
- Pemeriksaan lokal untuk ungkapan bahaya serius yang eksplisit sebelum respons
  AI biasa, disertai respons bantuan manusia yang proporsional.
- Batas panjang masukan, batas keluaran, timeout, serta fallback aman saat API
  tidak tersedia.
- Tes unit dan integrasi Telegram dengan klien/model palsu; tidak memakai biaya
  API dalam tes otomatis.
- Pembaruan README, konfigurasi contoh, dokumentasi pengujian, indeks, dan Work
  Order ini.

## Di luar ruang lingkup

- Memori jangka panjang atau konteks lintas restart.
- Penyimpanan otomatis cerita, keadaan emosional, atau informasi sensitif.
- Foto/OCR, suara, web search, RAG, atau sumber real-time.
- Pembuatan atau perubahan tugas otomatis dari jawaban model.
- Pengiriman pesan, transaksi, kalender, atau tindakan eksternal oleh model.
- Sistem keselamatan lengkap, nomor hotline yang ditanam tetap, diagnosis, atau
  klaim layanan darurat.
- Moderasi dan tinjauan hukum yang diperlukan untuk rilis publik.
- Streaming, deployment, PostgreSQL, analitik isi pesan, atau penggunaan publik.
- Penggabungan PR #1 atau perubahan langsung ke `main`.

## Keputusan yang sudah dikunci

- Harvy adalah pendamping kehidupan pelajar, bukan hanya tutor atau daftar tugas.
- Pengguna minimum adalah kelas 8 SMP atau tingkat setara.
- Telegram pribadi adalah kanal percobaan pertama.
- Bahasa alami adalah pintu utama.
- Harvy membantu tetapi tidak mengambil alih.
- Harvy jujur sebagai AI dan tidak berpura-pura mempunyai perasaan atau memori.
- Isi pesan hanya diproses model setelah penjelasan singkat dan persetujuan.
- Penjelasan persetujuan menyatakan bahwa `store: false` menonaktifkan
  penyimpanan state Response, tetapi log pemantauan penyalahgunaan OpenAI pada
  pengaturan standar dapat menyimpan isi hingga 30 hari.
- Konteks aktif sementara bukan memori jangka panjang dan batasnya dijelaskan
  sebelum pengguna memberi izin.
- Arah arsitektur produk yang ditetapkan pengguna memakai DeepSeek V4 Flash
  untuk volume tinggi/risiko rendah, GPT-5.6 Luna untuk percakapan generatif
  utama, dan GPT-5.6 Terra untuk masalah tersulit, verifikasi, serta perencanaan
  kompleks.
- Paket ini hanya prototipe jalur langsung satu model `gpt-5.6-luna`; router
  tiga model belum dibuat dan tidak boleh dianggap selesai.
- Model tetap dikonfigurasi melalui environment agar dapat dievaluasi atau
  diganti tanpa mengubah kontrak bot.
- Ketersediaan, slug API, harga, dan batas provider belum diverifikasi ulang
  secara independen dalam koreksi dokumentasi ini; verifikasi resmi wajib
  dilakukan sebelum uji live atau keputusan arsitektur final.

## Kriteria penerimaan

- [x] Pengguna belum lolos kelas 8+ tidak pernah memanggil model AI.
- [x] Pengguna eligible melihat penjelasan pemrosesan OpenAI sebelum pesan bebas
      pertama dan dapat memilih setuju atau tidak.
- [x] Persetujuan AI disimpan sebagai data minimum per ID pengguna dan dapat
      ditarik melalui `/privasi`.
- [x] Setelah setuju, pesan bebas menghasilkan jawaban Harvy melalui Responses
      API; perintah tugas lama tetap berfungsi.
- [x] Request memakai model konfigurasi, `store: false`, moderasi input/output,
      batas keluaran, dan tidak memuat ID Telegram.
- [x] Isi pesan dan jawaban tidak ditulis ke file lokal, log, atau memori
      jangka panjang.
- [x] Paling banyak enam pesan konteks aktif berada di RAM maksimal 30 menit;
      `/hapuspercakapan` dan penarikan izin membersihkannya.
- [x] Prompt menyatakan identitas/batas Harvy dan mendukung lima konteks MVP.
- [x] Ungkapan bahaya serius yang eksplisit tidak masuk ke alur AI biasa dan
      menerima arahan bantuan manusia yang proporsional.
- [x] Pesan terlalu panjang, timeout, API gagal, atau output kosong mendapat
      fallback yang jelas tanpa membocorkan error atau credential.
- [x] Bot tetap hanya merespons lewat chat pribadi.
- [x] Semua tes lama dan baru lulus.

Catatan bukti: tanda centang di atas berasal dari implementasi dan tes yang
  dilaporkan pelaksana historis. Tanda tersebut belum merupakan review Claude
  Code, QA Antigravity, atau penerimaan pengguna.

## Konteks yang wajib dibaca

| Dokumen/kode | Alasan |
|---|---|
| `AGENTS.md` | Aturan kerja dan serah-terima |
| `docs/product/CONSTITUTION.md` | Agensi, privasi, keselamatan, dan identitas AI |
| `docs/product/MVP-v0.1.md` | Lima konteks dan siklus pengalaman |
| `docs/engineering/TESTING.md` | Bukti verifikasi |
| `docs/operations/ORCHESTRATION.md` | Branch, peran, dan status |
| `src/bot/create-bot.ts` | Routing pesan Telegram |
| `src/config.ts` | Konfigurasi runtime |
| `src/domain/user-profile.ts` | Status pengguna dan persetujuan minimum |

## Batas implementasi

- Path utama: `src/ai/`, `src/safety/`, `src/bot/`, `src/config.ts`,
  `src/app.ts`, `src/domain/user-profile.ts`, repository status pengguna,
  tes terkait, `package*.json`, `.env.example`, README, dan dokumentasi
  relevan.
- Gunakan SDK JavaScript resmi OpenAI dan Responses API.
- API key hanya dibaca dari `OPENAI_API_KEY`; jangan ditulis ke Git, output,
  tes, atau dokumentasi sebagai nilai nyata.
- Model default `gpt-5.6-luna`, reasoning effort `low`, dan dapat dioverride.
- Hanya konteks aktif maksimal enam pesan yang dikirim ulang. Tidak ada konteks
  lintas restart atau penyimpanan transkrip ke disk.
- Perubahan data harus kompatibel dengan record kelayakan WO-002 yang sudah ada.
- Jangan mengubah format `data/tasks.json`.
- Jangan mengklaim fitur telah diuji live tanpa token Telegram dan API key.

## Verifikasi wajib

Automated:

- `npm run check`
- `npm test`
- pemindaian kandidat secret pada diff/file kerja

Manual:

- Jalankan bot dengan akun Telegram uji dan API key proyek.
- Pastikan gerbang kelas, persetujuan AI, pesan bebas, `/privasi`, penolakan
  persetujuan, `/hapuspercakapan`, fallback API, perintah tugas, dan restart
  status.
- Gunakan pemilik produk dewasa, akun uji, dan data sintetis; jangan memakai
  cerita atau data pribadi pelajar sungguhan pada tahap ini.
- Uji sekurang-kurangnya satu contoh sintetis dari masing-masing lima konteks
  MVP.
- Catat model aktual, hasil, waktu respons, serta bagian yang belum diuji.

## Berhenti dan tanyakan jika

- Implementasi memerlukan API key atau token nyata di repository/chat.
- Integrasi mengharuskan penyimpanan transkrip ke disk, konteks lebih lama dari
  batas paket, atau data sensitif sebagai memori.
- Model yang dikunci tidak tersedia pada akun pengguna dan penggantinya mengubah
  biaya atau kualitas secara material.
- Diperlukan tindakan eksternal, memori lintas sesi, foto, atau perluasan lain.
- Ditemukan konflik antara Konstitusi, MVP, dan perilaku yang diminta.

## Catatan komunikasi

| Waktu | Alat/model aktual | Mode/peran | Tindakan | Branch/commit/bukti | Hasil | Belum terbukti | Pemilik berikutnya |
|---|---|---|---|---|---|---|---|
| 25 Juli 2026 | ChatGPT Work | `BUILD` historis (penyimpangan) | Membuat prototipe percakapan AI dan PR #2 secara langsung | `work/wo-003-ai-conversation`; implementasi `53fea95`; head sebelum koreksi `ff3fe2f` | Pelaksana melaporkan check, 39 tes, audit, dan pemindaian secret lulus | Review independen, Telegram + provider AI nyata, router tiga model | Orkestrator |
| 26 Juli 2026 | ChatGPT Work | `ORCHESTRATE` dokumentasi | Mengoreksi identitas, membedakan model alat/produk, dan menetapkan jalur review/QA | PR #2 dan Work Order ini | Dokumentasi saja; tidak mengubah kode aplikasi | Hasil Claude Code dan Antigravity | Claude Code |

## Handoff implementasi historis

- Pelaksana aktual: ChatGPT Work melalui konektor GitHub; bukan Codex.
- Commit/PR: implementasi `53fea954ddfc482da29562b0ba10b06d4bb3f041`;
  head sebelum koreksi dokumentasi `ff3fe2f98b4a05739bc7c2427af1974c5508fd5e`;
  draft PR `https://github.com/stafbotz/harvy/pull/2`.
- Ringkasan: persetujuan AI, Responses API, konfigurasi satu model
  `gpt-5.6-luna`, moderasi, konteks aktif sementara, kontrol penghapusan, alur
  risiko eksplisit, fallback, serta dokumentasi operasional.
- Automated yang dilaporkan pelaksana:
  - `npm ci` — PASS.
  - `npm run check` — PASS.
  - `npm test` — PASS (39 test dalam 11 suite).
  - `npm audit --omit=dev --audit-level=high` — PASS (0 vulnerability).
  - Pemindaian kandidat secret — PASS.
- Manual: `NOT RUN` — sesi pelaksana tidak memiliki token Telegram dan API key
  proyek AI.
- Status bukti: laporan di atas belum diulang oleh Reviewer atau QA independen.
- Asumsi historis: `gpt-5.6-luna` tersedia pada proyek pengguna. Asumsi ini
  belum diverifikasi dan tidak menggantikan arsitektur produk tiga model.
- Risiko atau pekerjaan tersisa:
  - kualitas, latensi, biaya, moderasi, dan copy belum diuji pada API nyata;
  - filter risiko lokal bukan sistem keselamatan lengkap;
  - akun belum dikonfirmasi mempunyai Zero Data Retention;
  - belum ada rate limit, spend limit, deployment, tinjauan hukum, atau izin
    untuk pelajar nyata;
  - router DeepSeek/Luna/Terra belum dibuat;
  - PR #2 bergantung pada PR #1.
- Dokumentasi yang diubah saat implementasi: README, `.env.example`, INDEX,
  PROJECT, TESTING, dan WO-003.
- Pemilik berikutnya: Claude Code untuk review read-only.

## Hasil review

- Reviewer yang ditugaskan: Claude Code (Opus 5), read-only.
- Compare: `work/wo-002-eligibility-entry@<base yang dikunci>...work/wo-003-ai-conversation@<head yang dikunci>`.
- Status: `NOT RUN`.
- `BLOCKER`/`IMPORTANT`: menunggu laporan.
- `MINOR`: menunggu laporan.
- Fokus minimum: kebenaran kontrak SDK/provider, privasi, persetujuan,
  penyimpanan konteks, moderasi, jalur risiko, fallback, regresi WO-002, dan
  ketidaksesuaian terhadap arsitektur tiga model.
- Catatan: reviewer wajib melaporkan alat/model aktual; profil yang berbeda
  tidak boleh disubstitusi diam-diam.

## Hasil QA/integrasi

- QA yang ditugaskan: Antigravity (Gemini 3.6 Flash), read-only.
- Commit target: ditentukan setelah review awal.
- Status: `NOT RUN`.
- Environment: komputer pengguna dengan secret lokal; secret tidak boleh masuk
  chat, repo, screenshot, atau laporan.
- Skenario minimum: kelayakan, izin/setop izin, lima konteks sintetis,
  percakapan lanjutan, hapus konteks, fallback API, risiko eksplisit, perintah
  tugas, restart, dan chat non-pribadi.
- Catat model runtime aktual, waktu respons, expected/observed, dan
  `PASS`/`FAIL`/`NOT RUN`.

## Rencana kelanjutan

1. Claude Code meninjau PR #1, lalu PR #2, tanpa mengedit.
2. Antigravity menjalankan QA pada commit yang dikunci tanpa mengedit.
3. ChatGPT Work menggabungkan temuan, bukti, dan hal yang belum terbukti untuk
   pengguna.
4. Jika pengguna menyetujui perbaikan, Codex (GPT-5.6 Sol) menerima dispatch
   baru sebagai satu-satunya Builder.

## Penerimaan

- Keputusan pengguna: menunggu uji hasil WO-003.
- Commit yang diterima: menunggu.
- Tanggal: menunggu.
