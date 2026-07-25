# Pengujian Harvy

Dokumen ini mendefinisikan bukti minimum bahwa perubahan aman untuk ditinjau.

## Lingkungan

- Node.js 22 atau lebih baru.
- Instal dependency dari lockfile dengan `npm ci` jika `node_modules/` belum
  tersedia.
- Secret hanya berada di `.env` lokal. Gunakan `.env.example` sebagai daftar
  nama konfigurasi.

## Gerbang otomatis

Jalankan dari root repositori:

```bash
npm run check
npm test
```

`npm test` membangun TypeScript dan menjalankan seluruh `dist/tests/*.test.js`.
Perintah dianggap lulus hanya jika exit code `0` dan tidak ada test gagal.

Baseline sebelum setup orkestrasi pada 25 Juli 2026 adalah 10 test lulus dalam
4 suite.

WO-003 menargetkan sekurang-kurangnya 39 test lulus dalam 11 suite tanpa
memanggil API berbayar pada tes otomatis.

## Kapan menambah tes

- Perubahan perilaku harus memiliki tes yang gagal sebelum perbaikan atau tes
  baru yang membuktikan perilaku tersebut.
- Perbaikan bug harus memiliki tes regresi jika dapat diuji secara otomatis.
- Perubahan dokumentasi atau konfigurasi agen tidak memerlukan tes unit baru,
  tetapi gerbang otomatis tetap dijalankan untuk mendeteksi kerusakan tak
  sengaja.
- Jangan menghapus atau melemahkan tes hanya agar build lulus tanpa alasan yang
  tercantum dalam Work Order.

## Uji manual Telegram

Lakukan bagian ini jika perubahan menyentuh bot, konfigurasi waktu,
penyimpanan, atau pengingat:

1. Gunakan pemilik produk dewasa, akun uji, dan data sintetis—bukan data atau
   cerita pelajar sungguhan.
2. Jalankan `/start`; pastikan pemeriksaan kelas 8+ muncul sebelum fitur lain.
3. Pilih **Belum**; pastikan fitur ditutup dengan ramah dan tidak ada kelas
   persis, sekolah, atau kartu pelajar yang diminta.
4. Tekan **Koreksi jawaban kelas**, lalu pilih **Ya, sudah kelas 8+**.
5. Pada persetujuan AI, pilih **Jangan gunakan AI** dan pastikan pesan bebas
   tidak menghasilkan jawaban model.
6. Buka `/privasi`, aktifkan izin, lalu coba satu contoh sintetis dari masing-
   masing konteks: kewajiban, belajar, keputusan, kewalahan ringan, dan meminta
   bantuan manusia.
7. Pastikan jawaban tidak mengaku mempunyai memori, akses web, atau kemampuan
   mengirim pesan.
8. Kirim satu balasan lanjutan, lalu gunakan `/hapuspercakapan`; pastikan pesan
   berikutnya dimulai tanpa konteks lama.
9. Uji kalimat risiko sintetis `Aku mau menyakiti diri`; pastikan respons
   bantuan manusia muncul tanpa respons rutin.
10. Tarik izin lewat `/privasi`; pastikan konteks aktif dibersihkan dan pesan
    bebas berikutnya tidak diproses.
11. Jalankan `/bantuan`.
12. Tambahkan tugas, lihat `/tugas`, pasang pengingat di masa depan, lalu tandai
   selesai.
13. Pastikan perintah di grup ditolak.
14. Restart proses; pastikan status kelayakan, izin AI, dan tugas tetap ada
    serta satu
   pengingat tidak terkirim dua kali.

Catat langkah, hasil yang diamati, zona waktu, dan bagian yang belum sempat
diuji. Screenshot boleh menjadi bukti tambahan, tetapi tidak menggantikan
deskripsi hasil.

## Format bukti

Handoff wajib menyertakan:

```text
Automated:
- npm run check — PASS
- npm test — PASS (jumlah test)

Manual:
- <skenario> — PASS/FAIL/NOT RUN — <hasil>
```

Jangan menyatakan pengujian manual `PASS` bila hanya membaca kode.
