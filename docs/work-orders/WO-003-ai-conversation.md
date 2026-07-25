# WO-003: Percakapan AI Pertama Harvy

- Status: `IN_PROGRESS`
- Pemilik produk: pengguna Harvy
- Orkestrator: ChatGPT
- Builder: Codex (Work Mode)
- Reviewer: `UNASSIGNED`
- QA: pengguna Harvy
- Base branch: `work/wo-002-eligibility-entry` pada `461128847c9fb19c97a065400f8e489bb44b5824`
- Work branch: `work/wo-003-ai-conversation`

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
- Keputusan sebelumnya memilih keluarga GPT-5.6 Luna untuk beban percakapan
  awal; dokumentasi OpenAI pada 26 Juli 2026 memverifikasi slug
  `gpt-5.6-luna` sebagai pilihan efisien untuk beban volume tinggi.
- Model tetap dikonfigurasi melalui environment agar dapat dievaluasi atau
  diganti tanpa mengubah kontrak bot.

## Kriteria penerimaan

- [ ] Pengguna belum lolos kelas 8+ tidak pernah memanggil model AI.
- [ ] Pengguna eligible melihat penjelasan pemrosesan OpenAI sebelum pesan bebas
      pertama dan dapat memilih setuju atau tidak.
- [ ] Persetujuan AI disimpan sebagai data minimum per ID pengguna dan dapat
      ditarik melalui `/privasi`.
- [ ] Setelah setuju, pesan bebas menghasilkan jawaban Harvy melalui Responses
      API; perintah tugas lama tetap berfungsi.
- [ ] Request memakai model konfigurasi, `store: false`, moderasi input/output,
      batas keluaran, dan tidak memuat ID Telegram.
- [ ] Isi pesan dan jawaban tidak ditulis ke file lokal, log, atau memori
      jangka panjang.
- [ ] Paling banyak enam pesan konteks aktif berada di RAM maksimal 30 menit;
      `/hapuspercakapan` dan penarikan izin membersihkannya.
- [ ] Prompt menyatakan identitas/batas Harvy dan mendukung lima konteks MVP.
- [ ] Ungkapan bahaya serius yang eksplisit tidak masuk ke alur AI biasa dan
      menerima arahan bantuan manusia yang proporsional.
- [ ] Pesan terlalu panjang, timeout, API gagal, atau output kosong mendapat
      fallback yang jelas tanpa membocorkan error atau credential.
- [ ] Bot tetap hanya merespons lewat chat pribadi.
- [ ] Semua tes lama dan baru lulus.

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

## Handoff Builder

- Commit/PR:
- Ringkasan:
- Automated:
- Manual:
- Asumsi:
- Risiko atau pekerjaan tersisa:
- Dokumentasi yang diubah:

## Hasil review

- Status:
- `BLOCKER`/`IMPORTANT`:
- `MINOR` untuk backlog:

## Penerimaan

- Keputusan pengguna:
- Commit yang diterima:
- Tanggal:
