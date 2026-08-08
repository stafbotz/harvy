# Catatan Material Harvy

Dokumen ini hanya mencatat perubahan material, keputusan durable, insiden,
migrasi, hasil live test, atau perubahan status kemampuan. Ia bukan jurnal
setiap sesi atau setiap commit.

Cari entri yang relevan dengan `rg -n "istilah|nama-file|error" docs/LOG.md
docs/log`. Baca maksimal tiga entri yang terkait task. Arsip histori dan fakta
material lama berada di:

- [`log/2026-08-02-sampai-2026-08-06.md`](log/2026-08-02-sampai-2026-08-06.md)
- [`log/2026-07-25-sampai-2026-08-02.md`](log/2026-07-25-sampai-2026-08-02.md)

## Kebijakan entri

Tambahkan entri hanya bila fakta atau kontrak proyek berubah material. Gunakan
beberapa paragraf pendek; pindahkan detail panjang ke issue, PR, ADR, atau
evidence. Diskusi tanpa keputusan, investigasi tanpa fakta baru, typo,
formatting, rename internal, refactor murni, dan commit kecil tidak memerlukan
entri.

Format:

```md
## YYYY-MM-DD — Judul singkat

Scope: file atau subsystem utama.
Changed: perubahan perilaku atau kontrak.
Verified: perintah dan hasil penting.
Not verified: yang belum diuji.
Next: hanya bila ada tindak lanjut material.
```

Arsipkan whole entry tertua ke `docs/log/` ketika file ini melewati 24 KiB atau
12 entri material. Jangan memecah entri dan jangan memindahkan entri yang masih
memiliki perubahan pengguna yang belum diselesaikan.

## 2026-08-08 — Emergency preflight dan boundary local-first

Scope: safety/turn-taking policy, batching dan adapter Telegram privat,
telemetry turn, fast path waktu, kontrak arsitektur, serta tes regresinya.

Changed: free-text pasca-consent kini menjalankan emergency preflight
berpresisi tinggi sebelum debounce dan memakai closed set lokal untuk boundary
yang jelas; classifier model menjadi fallback bentuk ambigu. ACK urgent tidak
bergantung pada telemetry, batch biasa lama yang belum mulai dibatalkan lewat
generation guard, dan sinyal ACK tidak lagi kalah race dari penutupan span.
Pertanyaan waktu tanpa episode hangat 30 menit melewati boundary,
understanding, triage, dan reply model. ADR-021 merekonsiliasi supersesi parsial
kontrak AI-only lama; triase tetap menentukan disposition dan closed set ini
belum menyelesaikan Phase B seluruhnya.

Verified: tes terarah policy/batcher/adapter/telemetry/agent PASS, 129 test dalam
13 suite. `npm run check` PASS. `npm test` PASS, 674 test dalam 95 suite, 0
gagal. `npm run context:check` PASS dengan output bootstrap 3.627 byte
(estimasi 907 token).

Not verified: provider/model live, Telegram live, WhatsApp live, latency ACK
<500 ms pada jaringan nyata, dan perilaku multi-instance tidak dijalankan.
Preflight pra-consent/command/callback/grup/WhatsApp serta debounce adaptif
belum diimplementasikan.

Next: lanjutkan Phase B dengan `RiskHint`/`RiskDisposition`, semantics triage
`unavailable`, dan selective triage sebelum memisahkan privacy sensitivity dan
izin tindakan per efek.

## 2026-08-07 — Baseline telemetry per giliran

Scope: telemetry domain/service/storage, batching Telegram privat, kontrak
observabilitas, serta tes regresinya.

Changed: satu `turnId` acak kini mengikuti bubble dari evaluasi boundary sampai
handler selesai. Telemetry content-free mencatat outcome, jumlah bubble,
batch/queue/handling/total latency, jumlah dan tujuan logical model call, serta
sinyal fast path, triage unavailable, safety fallback, dan urgent
acknowledgement. File telemetry bermigrasi kompatibel dari version 1/2 ke
version 3 dengan koleksi `turns`; retensi, ekspor data, dan forget ikut mencakup
record baru. Ringkasan per pemilik menyediakan p50/p95 dan rate dengan seluruh
turn sebagai denominator. ADR-020 mengikat batas privasi dan ruang lingkup
baseline ini.

Verified: `npm run check` PASS. `npm test` PASS, 663 test dalam 94 suite, 0
gagal. `npm run context:check` PASS dengan output bootstrap 3.627 byte
(estimasi 907 token). `git diff --check` PASS.

Not verified: provider/model live, Telegram live, WhatsApp live, multi-instance
durability, dashboard, dan TTFR terpisah tidak dijalankan atau belum
diimplementasikan.

Next: Phase B harus merekonsiliasi ADR/invariant safety lama sebelum mengubah
boundary, triage unavailable, review, atau izin mutasi.

## 2026-08-06 — Bootstrap agent menjadi code-first dan berbatas

Scope: `AGENTS.md`, bootstrap Claude/Antigravity, context tooling, workflow,
STATUS, LOG, hook, dan tes kontrak agent.

Changed: satu kontrak utama kini memakai klasifikasi task dan Level 0–3; docs
dibaca on-demand dengan budget sekitar 15%. SessionStart hanya mencetak kontrak
ringkas plus `CURRENT.md`. STATUS menjadi indeks delapan subsystem dan snapshot
monolit dipindah ke arsip. LOG lama—termasuk perubahan working tree yang sudah
ada—diarsipkan dengan urutan dan fakta tetap utuh; satu credential-like value
serta kutipan pengguna sensitif direduksi tanpa mengulang nilainya. Hook tidak
lagi memaksa LOG dan hanya memvalidasi snapshot staged ketika sumber konteks
berubah. ADR-019 mencatat keputusan durable ini.

Verified: `npm run context:check` PASS dengan output bootstrap 3.627 byte
(estimasi 907 token; sebelumnya 16.434 byte). `npm run check` PASS. `npm test`
PASS, 654 test dalam 94 suite, 0 gagal. Smoke test index sementara menerima
snapshot staged lengkap serta menolak penghapusan `AGENTS.md` dan hilangnya
mode executable hook.

Not verified: runtime produk, provider/model live, Telegram, WhatsApp, dan
perilaku UI tidak dijalankan karena kode produk tidak berubah.
