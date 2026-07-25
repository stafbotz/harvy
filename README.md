# Harvy

Fondasi MVP **Harvy Capybara**, AI pendamping kehidupan pelajar Indonesia yang
diakses lewat chat pribadi Telegram. Versi yang berjalan saat ini masih berupa
prototipe terbatas: gerbang kelas 8+ dan pengelolaan tugas sudah aktif, sedangkan
percakapan alami yang lebih luas belum tersambung.

## Yang sudah dapat dilakukan

- Memeriksa bahwa pengguna sudah kelas 8 SMP atau tingkat setara dengan
  pernyataan mandiri.
- Menyimpan hanya status memenuhi/tidak memenuhi syarat, tanpa kelas persis,
  sekolah, atau kartu pelajar.
- Mengizinkan pengguna mengoreksi jawaban kelayakan.
- Menambahkan tugas beserta tenggat dan tingkat kepentingan.
- Menampilkan tugas aktif berdasarkan prioritas.
- Menandai tugas selesai.
- Membuat pengingat dengan izin eksplisit pengguna.
- Menyimpan data tiap pengguna secara terpisah dalam berkas lokal.
- Menolak penggunaan di grup; MVP ini khusus pendamping pribadi.

## Menjalankan

Syarat: Node.js 22 atau lebih baru dan sebuah token bot dari
[@BotFather](https://t.me/BotFather).

```bash
npm install
cp .env.example .env
```

Isi `TELEGRAM_BOT_TOKEN` di `.env`, lalu:

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
3. Jika jawaban keliru, gunakan tombol **Koreksi jawaban kelas**.
4. Setelah lolos, gunakan perintah tugas di bawah.

## Perintah pengguna

```text
/tambah Matematika halaman 20 | 2026-07-28 19:00 | tinggi
/tambah Bawa buku sejarah
/tugas
/selesai 1a2b3c4d
/ingatkan 1a2b3c4d | 2026-07-28 17:00
/bantuan
```

Format waktu mengikuti `DEFAULT_TIMEZONE`. Implementasi awal memakai offset
`DEFAULT_UTC_OFFSET`; sebelum dipakai lintas zona waktu, profil zona waktu per
pengguna perlu ditambahkan.

## Batas versi awal

- Belum memahami pesan bebas dengan model AI.
- Tidak membaca grup Telegram atau WhatsApp.
- Tidak memberikan jawaban pelajaran.
- Tidak menyimpan curhat, kondisi kesehatan, atau memori sensitif.
- Tidak menghubungi pengguna tanpa pengingat yang ia pasang sendiri.
- Penyimpanan berkas cocok untuk prototipe satu proses, belum untuk produksi
  dengan banyak server.

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
