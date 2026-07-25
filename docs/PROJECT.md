# Harvy — Keputusan Proyek dan Backlog

Terakhir diperbarui: 25 Juli 2026.

## Identitas dan produk

- **Harvy** adalah satu-satunya merek yang dilihat pengguna.
- **Harvy Capybara** adalah nama internal AI agent untuk belajar dan keseharian.
- **Harvy Chat** adalah nama internal bot hiburan grup WhatsApp.
- **Harvy Core** kelak memuat akun, aturan keselamatan, memori terstruktur, dan
  routing model yang dipakai bersama.

## Kanal

| Sistem | Kanal utama | Status |
|---|---|---|
| Harvy Capybara | Telegram pribadi | Dikerjakan sekarang |
| Harvy Capybara | WhatsApp pribadi | Beta nanti; nomor terpisah |
| Harvy Chat | Grup WhatsApp melalui Baileys | Setelah Capybara MVP |
| Visualisasi | Web | Setelah alur chat terbukti perlu |

## Prinsip produk

Harvy membantu tetapi tidak mengambil alih. Pengguna tetap menentukan keputusan,
boleh melihat serta menghapus data, dan harus memberi izin sebelum Harvy
melakukan tindakan proaktif. Harvy bukan terapis, psikolog, dokter, alat
diagnosis, atau pengganti bantuan darurat dan hubungan manusia.

## Now — Sprint 1

Tujuan: satu pengguna dapat memasukkan tugas nyata, melihat apa yang perlu
dikerjakan, memasang pengingat, dan menandainya selesai.

- [x] Fondasi Node.js + TypeScript.
- [x] Bot Telegram khusus chat pribadi.
- [x] Tambah, daftar, dan selesaikan tugas.
- [x] Pengurutan prioritas transparan berdasarkan tenggat dan kepentingan.
- [x] Pengingat hanya atas permintaan pengguna.
- [x] Penyimpanan lokal terpisah per pengguna.
- [x] Tes unit untuk parser, prioritas, layanan, dan penyimpanan.
- [ ] Buat bot melalui BotFather dan pasang token.
- [ ] Uji manual dengan satu akun Telegram.
- [ ] Uji mandiri selama tujuh hari dengan tugas nyata.

### Definition of Done

Sprint 1 selesai ketika bot berjalan tujuh hari tanpa kehilangan data, seluruh
perintah utama dapat digunakan dari ponsel, pengingat datang pada waktu yang
benar, dan pengguna dapat memahami urutan prioritas tanpa penjelasan tambahan.

## Next — Sprint 2

- Alur percakapan bertahap agar pengguna tidak perlu menghafal format.
- Tombol tindakan cepat untuk selesai, tunda, dan ubah tenggat.
- Penyimpanan PostgreSQL serta migrasi data.
- Preferensi zona waktu per pengguna.
- Ekspor dan hapus seluruh data pengguna.
- Observabilitas tanpa mencatat isi pesan sensitif.
- Deployment dan backup.
- Integrasi AI murah hanya untuk mengubah pesan bebas menjadi data tugas
  terstruktur; hasil tetap harus dikonfirmasi pengguna.

## Research Waitlist

Wawancara pelajar ditunda karena responden masih sulit ditemukan. Pekerjaan ini
tidak memblokir prototipe, tetapi harus dilakukan sebelum klaim kebutuhan luas
atau peluncuran publik.

- [ ] Tiga wawancara percobaan.
- [ ] Dua belas sampai lima belas wawancara kebutuhan.
- [ ] Enam sampai delapan uji konsep setelah purwarupa siap.
- [ ] Validasi apakah Telegram benar-benar kanal yang dibuka setiap hari.
- [ ] Validasi toleransi terhadap memori, notifikasi proaktif, dan gaya bahasa.
- [ ] Uji apakah akar masalahnya tugas menumpuk, informasi tersebar, sulit
  memulai, instruksi tidak jelas, atau akses bantuan.

Pemicu untuk mengaktifkan kembali riset: tersedia minimal tiga responden yang
bersedia dan proses persetujuan peserta/wali sudah siap.

## Later

- Pendamping belajar berbasis petunjuk bertahap.
- Check-in ringan dan refleksi.
- Memori terstruktur yang dapat dilihat, diedit, dan dihapus.
- Routing model berdasarkan kesulitan tugas, bukan harga paket pengguna.
- Harvy Chat di grup WhatsApp: permainan, poin, polling, dan fitur komunitas.
- Harvy Market sebatas katalog, pencarian, reputasi, dan pelaporan; belum
  menangani atau menjamin transaksi.

## Tidak dikerjakan sekarang

- WhatsApp personal sebagai kanal utama.
- Escrow atau penyelesaian sengketa.
- Diagnosis kesehatan mental.
- Penyimpanan otomatis informasi sensitif.
- Tindakan proaktif tanpa persetujuan.
- Rotasi nomor untuk menghindari pembatasan platform.
