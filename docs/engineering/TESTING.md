# Pengujian Harvy

Dokumen ini mendefinisikan bukti minimum bahwa perubahan aman untuk ditinjau.

Sebelum menyusun skenario, baca [`STATUS.md`](STATUS.md). Menguji kemampuan yang
memang belum ada menghasilkan laporan `FAIL` yang menyesatkan, dan `PASS` untuk
kemampuan yang sebenarnya belum tersambung jauh lebih berbahaya lagi.

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
4 suite. Setelah seluruh percakapan dipindahkan ke model AI pada 26 Juli 2026,
baseline menjadi 29 test dalam 6 suite. Setelah tiga cacat sambungan diperbaiki
pada hari yang sama, baseline menjadi **33 test lulus dalam 7 suite**.

**Tes yang memanggil model sungguhan tidak boleh masuk gerbang otomatis.**
Biayanya tidak dapat diprediksi dan hasilnya tidak dapat diulang. Yang diuji
otomatis hanya bagian murni: kebijakan routing, rotasi kunci, dan pembacaan
balasan model dari contoh teks.

Akibatnya, gerbang otomatis **tidak** membuktikan Harvy dapat berbicara. Sejak
`ADR-004`, jalur berbasis aturan sudah dihapus, sehingga percakapan hanya dapat
dibuktikan lewat pengujian manual dengan kunci API sungguhan.

`npm run build` tidak membersihkan `dist/`. Setelah berkas sumber dihapus atau
diganti nama, jalankan `rm -rf dist` sebelum `npm test`; kalau tidak, tes lama
hasil build sebelumnya ikut dijalankan dan hasilnya menyesatkan.

## Kapan menambah tes

- Perubahan perilaku harus memiliki tes yang gagal sebelum perbaikan atau tes
  baru yang membuktikan perilaku tersebut.
- Perbaikan bug harus memiliki tes regresi jika dapat diuji secara otomatis.
- Perubahan dokumentasi atau konfigurasi agen tidak memerlukan tes unit baru,
  tetapi gerbang otomatis tetap dijalankan untuk mendeteksi kerusakan tak
  sengaja.
- Jangan menghapus atau melemahkan tes hanya agar build lulus. Kalau sebuah tes
  memang harus berubah, tulis alasannya di [`../LOG.md`](../LOG.md).

## Uji manual Telegram

Lakukan bagian ini jika perubahan menyentuh bot, konfigurasi waktu,
penyimpanan, atau pengingat:

Bagian ini memerlukan kunci API sungguhan. Jalankan dengan `AI_MODE=testing`
supaya tidak berbiaya.

1. Gunakan bot dan akun uji, bukan data pengguna nyata.
2. Jalankan `/start` dan `/bantuan`.
3. Tulis tugas dengan bahasa biasa, misalnya "besok jam 7 malam kumpulin
   matematika halaman 20". Pastikan tenggat dan kepentingannya terbaca benar,
   termasuk zona waktunya.
4. Uji setiap tombol: Selesai, Ingatkan, Ubah tenggat, dan Batalkan.
5. Tulis keluhan seperti "aku capek banget". Pastikan Harvy menanggapi
   keadaannya dan **tidak** membuat tugas dari kalimat itu.
6. Tulis keluhan yang menyembunyikan pekerjaan, misalnya "aku kewalahan, besok
   ada ulangan biologi". Pastikan Harvy menjawab dulu, lalu *menawarkan*
   pencatatan lewat tombol.
7. Tulis pertanyaan pelajaran. Pastikan Harvy menuntun, bukan langsung memberi
   jawaban akhir.
8. Lihat `/tugas` dan pastikan tidak ada ID teknis yang muncul di mana pun.
9. Pastikan perintah di grup ditolak.
10. Matikan sambungan internet lalu kirim pesan. Pastikan Harvy mengaku sedang
    tidak bisa memproses, bukan diam atau membalas kacau.
11. Untuk mode uji dengan beberapa kunci, pastikan pesan tetap terjawab setelah
    satu kunci mencapai batas kuota.
12. Jika penyimpanan atau pengingat berubah, restart proses dan pastikan data
    tetap ada serta satu pengingat tidak terkirim dua kali. Ingat bahwa langkah
    percakapan yang menggantung memang hilang setelah restart.

### Keselamatan

Diuji terpisah dan tidak boleh dilewati sebelum ada pengguna nyata. Gunakan
kalimat uji yang menyinggung risiko serius, lalu pastikan Harvy mengarahkan ke
bantuan manusia, tidak mendiagnosis, dan tidak berjanji menangani sendiri.
Catat bahwa penilaian keselamatan saat ini hanya berasal dari model; belum ada
lapisan pemeriksa tersendiri.

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
