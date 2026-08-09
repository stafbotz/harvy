# ADR-023: Adaptive Debounce Per Subjek

- Status: Accepted
- Tanggal: 8 Agustus 2026
- Pemilik keputusan: pengguna Harvy
- Terkait: `ADR-007`, `ADR-009`, `ADR-011`, `ADR-020`, `ADR-021`
- Supersesi parsial: settle selalu tetap 650 ms pada Telegram privat serta
  settle selalu tetap 350 ms/1,2 detik pada direct/ambient WhatsApp grup

## Konteks

Phase A sudah mengukur `batchWaitMs`, total latency, dan p50/p95 tanpa isi
percakapan. Phase B membuat boundary lokal dan selektif, tetapi semua orang
masih menerima timing yang sama walau ritme mengirim bubble berbeda. Memotong
jeda terlalu cepat memecah satu pikiran menjadi dua giliran; menunggu terlalu
lama membuat acknowledgment dan pesan lengkap terasa lambat.

Timing tidak boleh dipelajari dari teks, profil psikologis, atau label risiko.
Ia juga tidak boleh menghapus jendela semantik untuk pembuka cerita dan
fragmen yang jelas belum selesai sebelum ada bukti telemetry bahwa perubahan
itu aman.

## Keputusan

1. `AdaptiveDebouncePolicy` menyimpan gap waktu antar-arrival berurutan milik
   subjek yang sama, termasuk ketika batch sebelumnya sudah ter-flush. Pada
   grup, pergantian pembicara memutus urutan sehingga pola A→B→A tidak menjadi
   sampel A. State sepenuhnya in-memory, content-free, dan tidak dipersistenkan,
   diekspor, atau ditulis ke log/telemetry.
2. Telegram memakai key pemilik. WhatsApp grup memakai
   `scope grup + account Harvy + participant`, sehingga ritme dua anggota,
   grup, atau nomor Harvy tidak bercampur.
3. Satu subjek menyimpan maksimum 32 sampel terbaru. Policy baru aktif setelah
   tiga sampel valid, mengabaikan gap nol/negatif atau di luar batas gap,
   kedaluwarsa setelah dua jam, dan menampung maksimum 5.000 subjek dengan
   eviction least-recently-used.
4. Estimasi memakai p90. Cushion adalah 20% yang dibatasi 200–300 ms, lalu
   hasil dibatasi 300–2.500 ms pada konfigurasi produksi. Contoh normatif:
   p90 800 ms menghasilkan settle 1.000 ms; p90 1.600 ms menghasilkan settle
   1.900 ms.
5. Sebelum sampel minimum tersedia, timing lama tetap fallback. Setelahnya,
   estimasi mengubah settle awal dan ruang untuk multi-bubble yang sudah
   diputus lengkap. Jendela `open` dan hard-`incomplete` tetap 7/12 detik;
   keduanya membawa makna, bukan sekadar ritme ketik, dan baru boleh diubah
   setelah bukti telemetry/eval tersendiri.
6. Direct group tidak diberi cap satu detik yang akan membatalkan hasil p90
   untuk slow typist; semua timing tetap tunduk pada deadline maksimum batch.
   Pergantian pembicara tetap menutup batch lama seketika.
7. Emergency Telegram tetap melewati debounce. Emergency grup diatur terpisah
   oleh ADR-024. Policy timing tidak menentukan risiko, privacy, authority,
   atau izin tindakan pada kanal mana pun.
8. Pembatalan/invalidation privat melupakan profile subjek tersebut. Removal
   atau invalidasi scope grup melupakan seluruh profile scope/account terkait;
   shutdown membersihkan semuanya.
9. Dampak operasional diukur dari telemetry `batchWaitMs` dan p50/p95 yang
   sudah ada. Sampel gap dan identifier key tidak ditambahkan ke record.

## Konsekuensi

Positif:

- pengguna dengan ritme bubble terukur mendapat jeda yang mengikuti perilaku
  aktual tanpa model tambahan;
- satu slow typist tidak memperlambat orang atau grup lain;
- state kecil, sementara, dan dapat dibuang tanpa migrasi data;
- urgent lane, FIFO, generation guard, drain, dan authority tidak berubah.

Trade-off dan batas:

- arrival berurutan yang cepat tetapi sebenarnya merupakan dua giliran tetap
  dapat menjadi sampel; batas gap, rolling window, TTL, dan pemutusan speaker
  grup membatasi pengaruhnya;
- tiga sampel pertama masih memakai fallback lama;
- open/incomplete belum adaptif;
- belum ada bukti latency Telegram/WhatsApp nyata atau kualitas split bubble
  dari pengguna produksi.

## Verifikasi

Tes pure policy mengunci minimum sample, p90/cushion, isolasi, outlier, rolling
window, expiry yang tidak diperpanjang oleh akses, forget-prefix, eviction, dan
arrival lintas boundary batch. Tes batcher mengunci pembelajaran endogen tanpa
pre-seed, A→B→A yang tidak menjadi sampel, hard-incomplete yang tidak
dipendekkan, scope invalidation, serta regresi urgent/FIFO/drain. Hasil gerbang
repository dicatat di `docs/LOG.md`.
