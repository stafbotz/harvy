# ADR-005: Konteks Menggantikan Work Order

- Status: Superseded sebagian
- Tanggal: 26 Juli 2026
- Pemilik keputusan: pengguna Harvy
- Menggantikan sebagian: [`ADR-001`](ADR-001-agent-orchestration.md)
- Diganti sebagian oleh: [`ADR-019`](ADR-019-code-first-progressive-context.md)
  dan [`ADR-038`](ADR-038-koordinasi-penulisan-adaptif.md)

> **Perubahan keputusan 6 Agustus 2026.** Konteks tetap menggantikan Work Order,
> tetapi kewajiban membaca empat dokumen sebelum bekerja dan menulis LOG pada
> setiap sesi tidak lagi berlaku. `ADR-019` menetapkan code-first progressive
> loading, snapshot berbatas, status per subsystem, dan LOG material saja.
>
> **Perubahan keputusan 14 Agustus 2026.** Mandat satu penulis aktif pada satu
> waktu tidak lagi berlaku. `ADR-038` menyerahkan pilihan kerja berurutan,
> paralel, atau terisolasi kepada penilaian agent berdasarkan risiko overlap.

## Konteks

[`ADR-001`](ADR-001-agent-orchestration.md) menetapkan Work Order sebagai satuan
kerja: satu paket tertulis berisi ruang lingkup, kriteria penerimaan, dan
serah-terima, dikerjakan satu Builder pada satu branch.

Setelah dipakai beberapa hari, hasilnya dapat diperiksa: **Work Order hanya
pernah dibuat satu kali**, yaitu `WO-001` untuk bootstrap orkestrasi. Seluruh
pekerjaan berikutnya — lapisan AI, `ADR-002`, `ADR-003`, `ADR-004`, dan semua
kode di `src/ai/` — berjalan tanpa Work Order sama sekali.

Yang lebih penting: kekeliruan yang muncul kemudian bukan kekeliruan proses.
ADR mencatat penghapusan tiga modul yang tidak pernah ada. Fungsi
`understandingInput()` ditulis lalu tidak pernah dipasang. Nilai `remindAt`
diekstraksi lalu dibuang. Tidak satu pun dari itu terjadi karena ruang lingkup
kurang jelas. Semuanya terjadi karena **penulis berikutnya tidak tahu keadaan
sebenarnya**, lalu menulis dokumen berdasarkan dugaan yang masuk akal.

Formulir tidak menyembuhkan itu. Konteks yang menyembuhkannya.

## Keputusan historis

1. **Work Order tidak lagi menjadi syarat untuk bekerja.** Folder
   `docs/work-orders/` dihapus beserta templatnya. Tidak ada lagi status
   `DRAFT`/`READY`/`ACCEPTED`, prompt peran, maupun aturan 5×1.
2. **[Disupersesi ADR-019] Konteks menjadi kewajiban yang menggantikannya.**
   Siapa pun yang mulai bekerja — manusia maupun AI — harus dapat menjawab
   empat pertanyaan tanpa bertanya kepada siapa pun:

   | Pertanyaan | Dijawab oleh |
   |---|---|
   | Proyek ini apa dan untuk siapa? | [`PROJECT.md`](../PROJECT.md) |
   | Apa yang boleh dan tidak boleh dilakukan Harvy? | [`CONSTITUTION.md`](../CONSTITUTION.md) |
   | Apa yang sudah benar-benar berjalan? | [`engineering/STATUS.md`](../engineering/STATUS.md) |
   | Apa yang dikerjakan terakhir kali, dan kenapa? | [`LOG.md`](../LOG.md) |

3. **[Disupersesi ADR-019] Setiap sesi kerja meninggalkan catatan di
   `docs/LOG.md`.** Ini pengganti serah-terima. Satu entri berisi tanggal, apa
   yang berubah, alasannya, bukti verifikasi, dan apa yang sengaja
   ditinggalkan.
4. **[Disupersesi sebagian ADR-038] Yang tetap berlaku dari ADR-001:** bukti tes
   wajib disebut dan dokumentasi keputusan permanen tetap di
   `docs/decisions/`. Kebijakan historis satu penulis aktif dicabut pada
   14 Agustus 2026. Keputusan pemilik produk pada 26 Juli 2026 tetap
   mengizinkan tulisan serta commit langsung pada `main`; branch terpisah dan
   pull request bersifat opsional.

## Alasan

Work Order menjawab pertanyaan "apa yang harus saya kerjakan sekarang". Itu
pertanyaan yang paling mudah dijawab, karena orang yang meminta sedang ada di
sana untuk menjelaskannya.

Pertanyaan yang benar-benar mahal adalah "apa yang sudah terjadi sebelum saya".
Itu yang tidak dapat ditanyakan kepada siapa pun ketika penulis sebelumnya
adalah sesi AI yang riwayatnya tidak dapat dibaca. Repositori harus menjawabnya
sendiri.

## Konsekuensi

Positif:

- Pekerjaan kecil tidak lagi memerlukan dokumen sebelum boleh dimulai.
- Dokumen yang dirawat adalah dokumen yang benar-benar dibaca setiap sesi.
- Konteks berumur panjang, sedangkan Work Order kehilangan gunanya setelah
  diterima.

Trade-off yang harus diterima:

- **Batas ruang lingkup tidak lagi tertulis di muka.** Tanpa bagian "di luar
  ruang lingkup", yang menahan pekerjaan agar tidak melebar hanyalah permintaan
  itu sendiri dan penilaian penulisnya. Untuk perubahan yang menyentuh perilaku
  produk, data, biaya, atau keselamatan, batas itu perlu disebut dalam
  permintaan.
- **Kriteria penerimaan tidak lagi berupa daftar centang.** Bukti verifikasi
  tetap wajib, tetapi kelengkapannya kini bergantung pada kejujuran laporan,
  bukan pada formulir.
- Catatan di `LOG.md` hanya berguna bila benar-benar ditulis. Sesi yang selesai
  tanpa entri membuat sesi berikutnya kembali menebak.
