# ADR-014 — Structured Episodic Compaction v2

- **Status:** Diterima
- **Tanggal:** 2 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** Konstitusi v0.4, ADR-006, ADR-007, ADR-008, ADR-012
- **Disupersesi sebagian:** ADR-030 memisahkan retensi storage 32 episode padat
  dari attention context otomatis 12 episode.
- **Ditindaklanjuti:** ADR-031 memfilter episode untuk retrieval/context dengan
  query plan, temporal validity, dan suppression; ADR-032 memakai provenance
  episode sebagai salah satu source graph turunan.

## Konteks

Riwayat privat sebelumnya memakai satu paragraf bergulir: giliran lama dan
ringkasan lama dikirim lagi ke model, lalu hasilnya menimpa ringkasan itu. Cara
ini sudah nonblocking dan menjaga bubble baru, tetapi setiap siklus dapat
menggeser arti, menghapus koreksi, serta membuat asal sebuah klaim tidak dapat
dibedakan secara struktural. Satu blob juga sulit diberi retensi tanpa memilih antara menghapus
seluruh kesinambungan atau menyimpannya selamanya.

Pemadatan bukan memori semantik. Ia hanya proyeksi terbatas dari riwayat
percakapan privat agar rujukan dekat tetap dapat dipahami. Fakta yang memang
perlu bertahan tetap harus masuk fitur memori beserta notice dan kontrolnya.

## Keputusan

1. **Setiap giliran privat mendapat sequence monoton.** Giliran mentah tetap
   disimpan verbatim setelah clipping yang sudah berlaku. Sequence dibuat kode,
   bukan model, dan menjadi unit provenance episode.
2. **Satu rentang mentah hanya diringkas sekali.** Compactor mengambil awalan
   kontigu dari snapshot dan tidak pernah memasukkan episode lama kembali ke
   peringkas. Satu request dibatasi 12 giliran/12.000 karakter; bila backlog
   masih melewati ambang 16 giliran, pass berikutnya berjalan setelah slot
   global dilepas. Hasil akhirnya mempertahankan 6–16 giliran terbaru. Episode
   baru harus dimulai tepat sesudah rentang episode terakhir yang masih
   tersimpan.
3. **Keluaran model adalah draft bertipe, bukan record penyimpanan.** Draft
   mempunyai tepat sembilan kategori: topik, fakta, tujuan, keputusan, koreksi,
   komitmen, hal belum selesai, jangkar waktu, dan ketidakpastian. Setiap klaim
   dibatasi panjang/jumlah dan wajib menunjuk sedikitnya satu sequence yang ada
   pada snapshot. Parser gagal tertutup.
4. **Metadata provenance dibuat kode.** `HistoryService` membuat ID episode,
   schema/summarizer version, waktu, rentang, jumlah giliran, serta SHA-256 dari
   sequence, peran, waktu, dan teks sumber. Sebelum commit, kode memeriksa ulang
   generation, coverage hash episode, awalan giliran, dan source hash terhadap
   versi terbaru.
5. **Pemadatan tetap di luar jalur balasan.** Maksimal dua model compaction
   berjalan bersamaan untuk seluruh pengguna. Kegagalan mempertahankan sumber
   mentah dan mendapat cooldown satu menit. Backlog yang tumbuh selama model
   aktif dikejar selama masih melewati ambang, tanpa memonopoli slot global.
   Shutdown normal menunggu seluruh compaction yang sudah dimulai.
6. **Penghapusan mempunyai generation guard.** Penghapusan penuh menaikkan
   generation, memblokir write baru, menunggu compaction aktif, lalu menghapus
   record. Completion lama tidak boleh menghidupkan data kembali; riwayat baru
   hanya boleh dimulai setelah persetujuan dibuka lagi. Penarikan persetujuan
   segera menyuspensi pemakaian riwayat dan mencegah compaction yang masih
   menunggu slot mulai memanggil model.
7. **Episode mempunyai retensi dan attention cap.** Keputusan awal menyimpan
   maksimal 12 episode. Sejak ADR-030, maksimal 32 episode padat disimpan untuk
   search lokal, tetapi konteks model tetap hanya merender 12 terbaru dari yang
   terbaru ke terlama dengan batas 3.000 karakter; metadata hash/ID tidak ikut
   prompt.
8. **Migrasi v1 tidak mengarang provenance.** Ringkasan lama dipindahkan
   atomik ke episode `legacy-summary`, tanpa sequence palsu. Saat dirender ia
   diberi label ringkasan lama yang belum terklasifikasi, bukan fakta yang sudah
   terbukti. Migrasi ditulis ke schema v2 sebelum operasi berikutnya.

## Konsekuensi

- Sepuluh siklus pemadatan dapat diuji tanpa merangkum ulang episode lama.
  Koreksi dan unresolved item mempunyai tempat eksplisit, sedangkan sumber
  mentah baru yang datang saat model bekerja tetap dipertahankan.
- Provenance struktural membuktikan klaim menunjuk rentang yang benar, tetapi
  **tidak membuktikan makna klaim benar-benar didukung teks itu**. Model masih
  dapat salah merangkum; evaluasi recall, attribution, dan hallucinated-memory
  tetap diperlukan. Setelah teks mentah sumber dibuang, sequence dan hash hanya
  menjadi receipt concurrency/coverage; keduanya tidak memungkinkan audit
  semantik ulang terhadap teks yang sudah tidak disimpan.
- Episode kosong sah agar sapaan/basa-basi dapat dibuang. Setelah batas retensi,
  episode tertua sengaja hilang. Ini riwayat terbatas, bukan arsip permanen.
- Threshold masih berbasis jumlah giliran dan selection masih berbasis
  karakter. Tokenizer, budget per model/route, retrieval semantik, compaction
  grup, dan keputusan retensi berbasis riset pengguna belum termasuk ADR ini.
- Schema v2 mengubah bentuk `HISTORY_FILE`; downgrade ke kode lama tidak
  didukung setelah migrasi. Backup operasional tetap diperlukan sebelum rilis.

## Bukti penerimaan

Tes deterministik mencakup parser sembilan kategori, provenance di luar
snapshot, hash/rentang sumber, bubble yang datang saat peringkas bekerja,
perubahan sumber/coverage, sepuluh siklus tanpa recursive summary, batas
retensi, chunk dan pengejaran backlog, dua compaction global, suspend antrean
setelah izin ditarik, cooldown kegagalan, drain shutdown, race penghapusan,
migrasi v1 atomik, dan larangan provenance palsu. Angka gerbang
final dicatat di `docs/engineering/STATUS.md` dan `docs/LOG.md`.
