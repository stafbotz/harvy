# Catatan 28 Agustus 2026 — Estimator token dan cakupan eval understanding

Dipindahkan dari `docs/LOG.md` pada 4 September 2026 karena berkas aktif
melewati batas 24 KiB. Isinya utuh.

## 2026-08-28 — Estimator token tunggal dan cakupan eval understanding

Scope: `src/ai/token-estimate.ts`, `src/ai/client.ts`,
`src/harness/context-budget.ts`, `scripts/eval-corpus.ts`,
`scripts/evaluasi-percakapan.ts`, prompt dan tes yang memuat contoh nama.

Changed: nama orang spesifik pada contoh prompt dan tes diganti nama umum;
sebelumnya satu nama yang sama muncul 112 kali di 12 berkas, membawa risiko
identifier nyata sekaligus anchoring pada token langka. Perkiraan token kini
punya satu sumber: `estimateTokens` dengan default 4 karakter per token, dan
`TokenRatioCalibration` per instance klien yang menajamkan rasio per model dari
`usage` nyata. Sebelumnya `client.ts` memakai pembagi 4 sementara anggaran
konteks memakai 4,18 sendiri. `requestWireCharacters` dipakai bersama supaya
kalibrasi mengoreksi kesalahan yang sama dengan yang dihitung estimator.

Korpus eval percakapan mendapat assertion untuk `semanticOperation`
(domain/operation/explicitness) dan `routingAssessment` (`toolNeed`,
`complexity`) beserta delapan kasus baru. Sebelumnya kesepuluh field itu tidak
pernah diuji sama sekali, padahal mayoritas aturan `understandingPrompt`
membahasnya dan `toolNeed` menentukan apakah Harvy memperoleh tool.

Cakupan diperluas lagi ke `publicFocus`, `memoryRetractions`, `durability`, dan
`sourceEvidence`, sehingga kesepuluh field yang tadinya buta kini punya
assertion. Korpus percakapan 44 → 57 kasus, dan seluruh id baru didaftarkan
wajib di `tests/evaluation-corpus.test.ts` agar tidak hilang diam-diam.

Cakupan itu langsung menemukan dua defect yang sebelumnya tidak terlihat.
`semantic-none-on-mention` sering memilih domain usage untuk kalimat yang justru
menyangkal menanyakannya, padahal prompt sudah memuat aturan eksplisit tentang
itu. `semantic-task-list-readonly` kadang memberi intent task dan `toolNeed`
none untuk permintaan membaca daftar tugas—field yang menentukan apakah Harvy
memperoleh tool sama sekali. Keduanya nondeterministik: lulus saat dijalankan
sendiri, gagal pada run penuh.

Verified: `npm run check` PASS; `npm test` 1.980 lulus, 2 gagal dalam 242 suite;
baseline korpus penuh 57 kasus dijalankan seluruhnya dengan 50 lulus, 6 gagal
kualitas, 1 derau provider.

Not verified: restrukturisasi `understandingPrompt` belum dikerjakan; baseline
di atas disiapkan untuk memvalidasinya. Rencana menerjemahkan prompt itu ke
bahasa Inggris ditinjau ulang setelah isinya dibaca utuh—mayoritas aturannya
adalah spesifikasi parsing bahasa Indonesia, bukan kontrak teknis.
