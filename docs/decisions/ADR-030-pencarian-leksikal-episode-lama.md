# ADR-030 — Pencarian Leksikal Episode Lama

- **Status:** Diterima
- **Tanggal:** 9 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-006, ADR-014, ADR-019, ADR-022, ADR-027, ADR-029
- **Ditindaklanjuti:** ADR-031 memasang query plan, privacy/suppression filter,
  dan ContextCompiler; ADR-032 memasang graph temporal turunan.

## Konteks

Compaction v2 mempertahankan episode berprovenance, tetapi seluruh episode yang
tersimpan juga menjadi context otomatis dan record dipangkas pada dua belas
episode. Batas itu baik sebagai attention budget, namun membuat percakapan lama
yang relevan tidak dapat ditemukan secara selektif ketika episode baru yang
tidak relevan lebih banyak. Spesifikasi arsitektur Phase E meminta full-text
historical retrieval sebelum embedding, graph, atau procedural memory.

Memasang SQLite/FTS persisten atau provider embedding sekarang akan menciptakan
salinan data dan lifecycle penghapusan baru sebelum query planning, suppression
`forget one`, serta kebijakan provider tersedia. Catatan keselamatan tersembunyi
juga tidak boleh masuk jalur retrieval biasa.

## Keputusan

1. **Sumber pencarian hanya episode privat v2/legacy yang sudah ada.** Search
   tidak membaca semantic memory, insight keselamatan tersembunyi, group state,
   workspace, credential, atau giliran mentah. Hasil mempertahankan field klaim,
   episode ID, rentang/hash sumber, dan source sequence. Skor hanya relevansi
   retrieval, bukan confidence, fakta, atau authority.
2. **Index leksikal dibangun ulang di memori dari record sumber.** Maksimum
   episode per owner kecil dan bounded, sehingga Phase E.1 tidak membuat file,
   cache, atau database turunan. Setelah history dihapus, tidak ada secondary
   index yang dapat menghidupkannya kembali. Bentuk persisten baru kelak wajib
   mempunyai transaksi rebuild/delete/revocation sendiri.
3. **Search deterministik dan code-owned.** Normalisasi Unicode/case, tokenisasi,
   stop-word sempit, IDF, coverage query, dan exact-phrase bonus menentukan
   ranking. Query dibatasi 500 karakter/16 term; hasil default empat, maksimum
   delapan; satu episode membawa maksimum enam klaim cocok. Tidak ada panggilan
   model dan tidak ada query/hasil yang masuk log operasional.
4. **Scope dan consent diperiksa sebelum dan sesudah load.** `HistoryService`
   selalu memuat berdasarkan `ownerId`; owner yang disuspensi atau sedang
   dihapus mendapat hasil kosong. Pemeriksaan kedua menutup race ketika
   penarikan consent terjadi saat adapter storage masih membaca.
5. **Storage retention dan prompt attention dipisahkan.** Maksimum 32 episode
   padat tetap berada di record history agar dapat dicari. Context otomatis
   tetap hanya merender 12 episode terbaru dan maksimum 3.000 karakter. Giliran
   mentah tetap memakai batas lama dan tetap dibuang setelah compaction.
6. **Pada slice ADR-030, search belum menjadi input prompt atau surface
   pengguna.** Consumer berikutnya wajib mempunyai `MemoryQueryPlan`/
   ContextCompiler, privacy filter, manifest bebas isi, dan suppression yang
   mencegah fakta terlupakan muncul kembali. ADR-031 kemudian memenuhi syarat
   itu dan membuka consumer prompt secara bounded; keputusan historis untuk
   tidak membuka search sebelum guard tersedia tetap berlaku.

## Konsekuensi

Positif:

- episode relevan yang lebih tua dari attention window dapat ditemukan tanpa
  mengirim semua riwayat atau memakai provider lain;
- provenance tidak hilang selama ranking dan hanya klaim cocok yang keluar;
- consent withdrawal, `forget all`, serta full deletion langsung menutup
  retrieval karena tidak ada index persisten kedua; dan
- hidden safety insight terpisah secara struktural dari corpus pencarian.

Trade-off:

- record history dapat menyimpan sampai 32 episode padat, naik dari 12, walau
  prompt otomatis tetap 12; export dan deletion yang sama mencakup semuanya;
- ranking exact-token belum menangkap sinonim atau makna semantik;
- episode adalah ringkasan model, sehingga source sequence/hash membuktikan
  coverage dan concurrency, bukan kebenaran semantik klaim; dan
- pada slice ini user-facing old-history retrieval, semantic embedding,
  contradiction, supersession, temporal validity, graph, dan deletion per
  klaim belum ada; status setelahnya berada di ADR-031/032, bukan ADR ini.

## Bukti

Tes deterministik mengunci ranking old-relevant vs recent-irrelevant,
normalisasi Unicode/case, claim/source provenance, query/result bounds,
pemisahan 32 episode storage dari 12 episode attention, owner isolation,
consent race, dan penghapusan tanpa resurrection. Provider/model dan kanal live
tidak dipanggil oleh change set ini.
