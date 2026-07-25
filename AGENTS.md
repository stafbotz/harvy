# Harvy Agent Entry Point

Instruksi ini berlaku untuk Codex, Claude Code, Antigravity, dan coding agent
lain yang bekerja di repositori Harvy. Peran ditentukan oleh Work Order, bukan
oleh nama alat.

## Sebelum bekerja

1. Kenali mode tugas: `DISCUSS`, `BUILD`, `REVIEW`, atau `QA`.
2. Untuk `BUILD`, `REVIEW`, atau `QA`, baca Work Order yang disebutkan dalam
   permintaan. Jika tidak ada Work Order, jangan mengubah file; minta
   orkestrator menunjukkannya.
3. Buka `docs/INDEX.md`, lalu baca hanya dokumentasi yang relevan.
4. Periksa kode, konfigurasi, dan tes terkait. Jika dokumentasi berbeda dari
   kenyataan kode, laporkan perbedaannya.

## Kepemilikan

- Pengguna Harvy dan orkestrator ChatGPT menguasai tujuan produk, ruang lingkup,
  keputusan material, dan penerimaan akhir.
- Tepat satu `BUILD` agent menjadi penulis aktif untuk satu Work Order dan
  branch.
- Agent `REVIEW` dan `QA` tidak mengedit. Perbaikan kembali ke penulis yang
  sama, kecuali orkestrator membuat Work Order baru.
- Jangan membuat penulis tambahan, mendelegasikan edit, atau menjalankan
  pekerjaan paralel yang menulis file tanpa izin eksplisit dalam Work Order.
- Jangan mengubah atau melakukan push langsung ke `main`.

## Perilaku per mode

- `DISCUSS`: jelaskan pilihan dan risiko; jangan mengubah file.
- `BUILD`: selesaikan seluruh Work Order, tetap di ruang lingkup, perbarui tes
  dan dokumentasi yang memang berubah, lalu siapkan serah-terima.
- `REVIEW`: periksa diff terhadap base branch dan laporkan hanya temuan yang
  material beserta bukti; jangan memperbaiki sendiri.
- `QA`: uji kriteria penerimaan dari sudut pengguna dan catat hasil yang dapat
  diulang; jangan mengubah implementasi.

## Batas dan verifikasi

- Jangan memasukkan `.env`, token, credential, data pengguna nyata, atau secret
  lain ke Git maupun laporan.
- Jangan menambah dependency, mengubah kontrak data, pengalaman pengguna,
  keamanan, layanan eksternal, atau biaya tanpa dasar dalam Work Order.
- Keputusan teknis kecil boleh diambil dan dicatat dalam serah-terima.
- Kumpulkan pertanyaan yang memengaruhi UX, data, keamanan, biaya, atau ruang
  lingkup dan tanyakan sekaligus.
- Gunakan Node.js 22 atau lebih baru.
- Pemeriksaan minimum perubahan kode: `npm run check` dan `npm test`.
- Baca `docs/engineering/TESTING.md` untuk bukti tes dan pengujian manual.

## Selesai berarti

Serah-terima harus menyebut Work Order, branch dan commit, ringkasan perubahan,
perintah tes beserta hasilnya, asumsi, risiko tersisa, serta dokumentasi yang
diubah. Chat yang berkata “selesai” tanpa bukti tersebut belum merupakan
serah-terima.

Protokol lengkap ada di `docs/operations/ORCHESTRATION.md`.
