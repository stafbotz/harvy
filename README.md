# Harvy

Fondasi MVP **Harvy Capybara**, pendamping pelajar yang diakses lewat chat
pribadi Telegram. Versi pertama ini sengaja belum memakai model AI: tugas,
prioritas, dan pengingat dapat diuji tanpa biaya inferensi.

## Yang sudah dapat dilakukan

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

- Tidak membaca grup Telegram atau WhatsApp.
- Tidak memberikan jawaban pelajaran.
- Tidak menyimpan curhat, kondisi kesehatan, atau memori sensitif.
- Tidak menghubungi pengguna tanpa pengingat yang ia pasang sendiri.
- Penyimpanan berkas cocok untuk prototipe satu proses, belum untuk produksi
  dengan banyak server.

Keputusan produk dan backlog ada di [docs/PROJECT.md](docs/PROJECT.md).

## Pengembangan dengan coding agent

Codex, Claude Code, dan Antigravity menggunakan satu protokol bersama. Mulai
dari [AGENTS.md](AGENTS.md), pilih dokumentasi melalui
[docs/INDEX.md](docs/INDEX.md), dan jangan mengubah kode tanpa Work Order yang
menetapkan satu Builder serta satu branch.

Alur peran, handoff, review, dan setup GitHub dijelaskan di
[docs/operations/ORCHESTRATION.md](docs/operations/ORCHESTRATION.md).
