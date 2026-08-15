# ADR-038 — Koordinasi Penulisan Adaptif

- **Status:** Diterima
- **Tanggal:** 14 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Menggantikan sebagian:** [`ADR-001`](ADR-001-agent-orchestration.md) dan
  [`ADR-005`](ADR-005-konteks-menggantikan-work-order.md)
- **Tidak mengubah:** [`ADR-035`](ADR-035-coding-run-single-writer-dan-bukti.md)

## Konteks

Aturan kontribusi repository awal membatasi satu penulis aktif, menjadikan
coding agent lain Reviewer/QA read-only, dan mengharuskan isolasi ketika
pekerjaan paralel. Aturan itu mengurangi konflik pada tooling generasi awal,
tetapi juga menserialisasi pekerjaan independen dan mengabaikan kemampuan coding
agent untuk menilai dirty state, overlap file, shared output, serta risiko
integrasi.

## Keputusan

1. Repository tidak menetapkan satu penulis untuk seluruh working tree. Agent
   memilih kerja berurutan atau paralel berdasarkan scope dan risiko aktual.
2. Label Reviewer, QA, atau subagent pada kontributor repository tidak otomatis
   membuatnya read-only. Hak edit mengikuti tugas yang diberikan. Task yang
   secara eksplisit berupa review atau diskusi tetap read-only kecuali pengguna
   juga meminta implementasi.
3. Penulis kedua tidak wajib memakai worktree atau clone terpisah. Isolasi itu
   tetap boleh dipilih ketika overlap, shared output, atau risiko integrasi
   membuatnya berguna.
4. Setiap penulis tetap wajib memeriksa git state dan diff yang relevan,
   mempertahankan perubahan yang sudah ada, serta tidak menimpa pekerjaan lain.
   Pembagian scope dan koordinasi overlap ditentukan secara adaptif.
5. Pengguna tetap menguasai tujuan, scope, dan penerimaan akhir. Keputusan ini
   tidak memperluas izin untuk operasi eksternal atau destruktif.
6. Keputusan ini mengatur manusia dan coding agent yang berkontribusi ke working
   tree, bukan worker internal Harvy. Invariant runtime `CodingRun` single-writer
   per project serta mapper/test/critic worker read-only tetap berlaku sesuai
   [`ADR-035`](ADR-035-coding-run-single-writer-dan-bukti.md). Batas itu
   melindungi state dan efek produk, bukan mengatur kontribusi ke repository.

## Konsekuensi

Pekerjaan independen dapat berjalan paralel tanpa ritual worktree wajib, dan
agent dapat memilih isolasi hanya ketika nilainya nyata. Trade-off-nya adalah
koordinasi bergantung pada penilaian agent; karena itu inspeksi git state,
perlindungan perubahan yang ada, dan kejujuran saat konflik tetap wajib.

## Alternatif yang tidak dipilih

- Satu penulis permanen per working tree: terlalu membatasi pekerjaan yang dapat
  diparalelkan dengan aman.
- Paralelisasi tanpa inspeksi atau koordinasi: berisiko menimpa perubahan dan
  menghasilkan integrasi yang tidak dapat dipercaya.
- Worktree wajib untuk setiap penulis tambahan: biaya operasionalnya tidak
  sebanding untuk perubahan kecil atau scope yang tidak tumpang tindih.
