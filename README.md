# Harvy

Fondasi MVP **Harvy Capybara**, AI pendamping kehidupan pelajar Indonesia yang
diakses lewat chat pribadi Telegram. Versi yang berjalan saat ini masih berupa
prototipe terbatas untuk pemilik produk dewasa: gerbang kelas 8+, percakapan AI
dengan konteks aktif sementara, dan pengelolaan tugas.

## Yang sudah dapat dilakukan

- Memeriksa bahwa pengguna sudah kelas 8 SMP atau tingkat setara dengan
  pernyataan mandiri.
- Menyimpan hanya status memenuhi/tidak memenuhi syarat, tanpa kelas persis,
  sekolah, atau kartu pelajar.
- Mengizinkan pengguna mengoreksi jawaban kelayakan.
- Meminta persetujuan terpisah sebelum pesan bebas diproses oleh OpenAI.
- Menjawab pesan bebas tentang kewajiban, belajar, keputusan, kewalahan ringan,
  dan permintaan bantuan kepada manusia.
- Mengizinkan pengguna melihat atau menarik izin AI melalui `/privasi`.
- Memoderasi input dan output AI serta mengalihkan ungkapan bahaya serius yang
  eksplisit ke bantuan manusia.
- Menambahkan tugas beserta tenggat dan tingkat kepentingan.
- Menampilkan tugas aktif berdasarkan prioritas.
- Menandai tugas selesai.
- Membuat pengingat dengan izin eksplisit pengguna.
- Menyimpan data tiap pengguna secara terpisah dalam berkas lokal.
- Menolak penggunaan di grup; MVP ini khusus pendamping pribadi.

## Menjalankan

Syarat:

- Node.js 22 atau lebih baru.
- Token bot dari [@BotFather](https://t.me/BotFather).
- API key proyek OpenAI yang mempunyai billing/credit aktif. Model
  `gpt-5.6-luna` tidak tersedia pada free tier.

```bash
npm install
cp .env.example .env
```

Isi `TELEGRAM_BOT_TOKEN` dan `OPENAI_API_KEY` di `.env`. Jangan mengirim atau
melakukan commit file `.env`. Lalu jalankan:

```bash
npm run dev
```

Untuk pemeriksaan lengkap:

```bash
npm run check
npm test
npm run build
```

## Mencoba alur masuk

1. Kirim `/start` lewat chat pribadi.
2. Jawab pemeriksaan kelas melalui tombol.
3. Baca penjelasan pemrosesan AI, lalu pilih setuju atau menolak.
4. Setelah setuju, kirim pesan biasa dengan bahasa alami.
5. Gunakan `/privasi` untuk melihat atau menarik izin.
6. Jika jawaban kelas keliru, gunakan tombol **Koreksi jawaban kelas**.

## Perintah pengguna

```text
/tambah Matematika halaman 20 | 2026-07-28 19:00 | tinggi
/tambah Bawa buku sejarah
/tugas
/selesai 1a2b3c4d
/ingatkan 1a2b3c4d | 2026-07-28 17:00
/hapuspercakapan
/privasi
/bantuan
```

Format waktu mengikuti `DEFAULT_TIMEZONE`. Implementasi awal memakai offset
`DEFAULT_UTC_OFFSET`; sebelum dipakai lintas zona waktu, profil zona waktu per
pengguna perlu ditambahkan.

## Model, privasi, dan batas versi awal

- Model default adalah `gpt-5.6-luna` dengan reasoning effort `low`; ubah hanya
  melalui `OPENAI_MODEL` setelah evaluasi.
- Harvy mengirim paling banyak enam pesan terbaru sebagai konteks aktif agar
  balasan lanjutan tetap nyambung. Konteks berada di RAM maksimal 30 menit,
  tidak ditulis ke disk, hilang saat restart, dan dapat dihapus lewat
  `/hapuspercakapan`.
- Konteks aktif bukan memori jangka panjang dan tidak dipakai lintas restart.
- Request memakai `store: false`, sehingga percakapan tidak disimpan sebagai
  state Response. Menurut dokumentasi OpenAI, data API tidak dipakai melatih
  model secara default, tetapi prompt dan respons dapat berada dalam log
  pemantauan penyalahgunaan hingga 30 hari pada pengaturan standar.
- Harvy tidak menyimpan isi pesan atau jawaban AI ke berkas lokal.
- Moderasi OpenAI memberi skor input dan memblokir output yang ditandai. Filter
  lokal menangani beberapa ungkapan bahaya serius yang eksplisit, tetapi ini
  belum merupakan sistem keselamatan lengkap.
- Tidak membaca grup Telegram atau WhatsApp.
- Tidak membaca foto, mencari web, mengirim pesan, atau melakukan tindakan atas
  nama pengguna.
- Tidak menghubungi pengguna tanpa pengingat yang ia pasang sendiri.
- Penyimpanan berkas cocok untuk prototipe satu proses, belum untuk produksi
  dengan banyak server.
- Belum boleh diuji dengan data pribadi pelajar sungguhan atau dirilis publik
  sebelum tinjauan perlindungan data, hukum, dan keselamatan pengguna remaja.

Keputusan produk dan backlog ada di [docs/PROJECT.md](docs/PROJECT.md).
Konstitusi dan definisi MVP yang disahkan ada di
[docs/product/](docs/product/).

## Pengembangan dengan coding agent

Codex, Claude Code, dan Antigravity menggunakan satu protokol bersama. Mulai
dari [AGENTS.md](AGENTS.md), pilih dokumentasi melalui
[docs/INDEX.md](docs/INDEX.md), dan jangan mengubah kode tanpa Work Order yang
menetapkan satu Builder serta satu branch.

Alur peran, handoff, review, dan setup GitHub dijelaskan di
[docs/operations/ORCHESTRATION.md](docs/operations/ORCHESTRATION.md).
