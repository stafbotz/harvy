# Harvy — Keputusan Proyek dan Backlog

Terakhir diperbarui: 26 Juli 2026.

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
melakukan tindakan proaktif atau mengirim isi pesan ke layanan AI. Harvy bukan
terapis, psikolog, dokter, alat diagnosis, atau pengganti bantuan darurat dan
hubungan manusia.

## Now — Fondasi dan Percakapan Prototipe

Tujuan: pemilik produk dewasa dapat menguji alur masuk, pesan AI dengan konteks
aktif sementara, pengelolaan tugas, dan pengingat dengan data sintetis.

- [x] Fondasi Node.js + TypeScript.
- [x] Bot Telegram khusus chat pribadi.
- [x] Tambah, daftar, dan selesaikan tugas.
- [x] Pengurutan prioritas transparan berdasarkan tenggat dan kepentingan.
- [x] Pengingat hanya atas permintaan pengguna.
- [x] Penyimpanan lokal terpisah per pengguna.
- [x] Tes unit untuk parser, prioritas, layanan, dan penyimpanan.
- [x] Gerbang kelas 8+ dengan data minimum.
- [x] Persetujuan terpisah sebelum pemrosesan pesan oleh OpenAI.
- [x] Integrasi Responses API dengan `store: false` dan konteks aktif di RAM
  maksimal 30 menit.
- [x] Prompt Harvy untuk lima konteks MVP dan batas kemampuan yang jujur.
- [x] Moderasi input/output serta alur lokal untuk risiko eksplisit.
- [ ] Buat bot melalui BotFather dan pasang token.
- [ ] Buat API key proyek OpenAI dengan billing/credit aktif.
- [ ] Uji manual dengan pemilik produk dewasa dan data sintetis.
- [ ] Uji mandiri selama tujuh hari tanpa data pelajar sungguhan.

### Definition of Done tahap prototipe

Tahap ini selesai ketika bot berjalan tujuh hari tanpa kehilangan data, alur
kelas dan izin dapat dipahami, lima konteks percakapan sintetis menghasilkan
bantuan awal yang berguna, seluruh perintah tugas berfungsi dari ponsel, dan
pengingat datang pada waktu yang benar.

## Next

- Evaluasi kualitas prompt dengan skenario tetap dan catatan hasil.
- Tombol tindakan cepat untuk selesai, tunda, dan ubah tenggat.
- Konfirmasi terstruktur sebelum AI membuat atau mengubah tugas.
- Penyimpanan PostgreSQL serta migrasi data.
- Preferensi zona waktu per pengguna.
- Ekspor dan hapus seluruh data pengguna.
- Observabilitas tanpa mencatat isi pesan sensitif.
- Deployment, spend limit, rate limit, dan backup.
- Desain keselamatan, pelaporan, dan eskalasi yang ditinjau untuk pengguna
  remaja.

## Research Waitlist

Wawancara pelajar ditunda karena responden masih sulit ditemukan. Pekerjaan ini
tidak memblokir prototipe oleh pemilik produk dewasa, tetapi wajib dilakukan
secara aman sebelum klaim kebutuhan luas atau peluncuran publik.

- [ ] Tiga wawancara percobaan.
- [ ] Dua belas sampai lima belas wawancara kebutuhan.
- [ ] Enam sampai delapan uji konsep setelah purwarupa siap.
- [ ] Validasi apakah Telegram benar-benar kanal yang dibuka setiap hari.
- [ ] Validasi toleransi terhadap memori, notifikasi proaktif, dan gaya bahasa.
- [ ] Uji apakah akar masalahnya tugas menumpuk, informasi tersebar, sulit
  memulai, instruksi tidak jelas, atau akses bantuan.

Pemicu untuk mengaktifkan kembali riset: tersedia minimal tiga responden yang
bersedia dan proses persetujuan peserta/wali serta perlindungan data sudah siap.

## Later

- Pendamping belajar berbasis petunjuk bertahap yang dievaluasi per pelajaran.
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
- Penggunaan pelajar nyata atau peluncuran publik sebelum tinjauan hukum,
  privasi, keselamatan, dan pengujian usia yang memadai.
