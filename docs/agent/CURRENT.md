# Current Context

Refreshed: 2026-08-27
Baseline: d4a56ef
Context-Version: 1

## Verified baseline

- Perubahan material yang dirangkum di sini dimulai di atas commit dasar
  `d4a56ef` pada `main`; status commit dan push aktual tetap dibaca dari Git.
- `npm run check` PASS; tes integrasi coding/GitHub/Console terarah PASS 95/95;
  `npm test` PASS 1.948/1.948 dalam 236 suite; `git diff --check` PASS selain
  warning line-ending Windows.
- Smoke Edge nyata PASS pada desktop/mobile: login, navigasi tiga langkah setup,
  isi/simpan/verifikasi Compute+GitHub, non-reflection secret, dan layout. Ini
  memakai probe/storage sementara dan bukan bukti remote live.

## Recent material changes

- Testing memakai GMI/MiniMax sebagai provider tunggal tanpa fallback. Cache
  otomatis hanya dicatat content-free; input gambar privat bersifat transient.
  Routing memisahkan authority dari assessment model, auto-memory privat consent
  v10 tidak meminta izin per item, dan `/memori` hanya menampilkan primary memory
  yang dapat dikendalikan pengguna.
- Project dapat dimulai kosong, mempunyai ProjectGoal durable serta skill
  deklaratif evidence-bound, dan memakai intent natural yang tetap melewati
  authority code-owned. CodingRun menjalankan challenger+verifier read-only
  sebelum satu integration writer dan baru mencatat evidence sesudah commit.
- Console setup memisahkan Kanal, Komputer kerja, dan GitHub. Repository private
  kosong memakai konfirmasi bootstrap exact, WAL/idempotency/reconciliation,
  satu README code-owned, lalu provisioning; branch/push/draft PR tetap approval
  terpisah. Race klik verifikasi WhatsApp sesudah status terminal juga ditutup.

## Active cross-subsystem blockers

- Build terdahulu sudah dipakai lewat akun Telegram tester dan dua akun WhatsApp
  terpisah, tetapi perubahan coding/Console terbaru belum diuji end-to-end dari
  kanal nyata. Dogfood tujuh hari, tiga wawancara, image live, interruption
  panjang, reconnect, dan fault window send/receipt masih terbuka.
- Host ini Windows tanpa runtime OCI Linux non-root dan tidak mempunyai GitHub
  App/repository uji nonkritis. Hostile-code conformance, bootstrap repository
  kosong, branch/push/draft PR remote, CodingRun provider live, serta critic
  `toughest` belum terbukti live.
- Backup belum mempunyai kunci durable, jadwal, atau salinan eksternal/lintas
  mesin. Control-plane/coding/group/GitHub storage masih single-service tanpa
  distributed lease, outbox/dispatcher, shared store, dan reconciliation
  multi-instance; jangan klaim siap horizontal atau siap peluncuran publik.
- Corpus provider adalah regresi terbatas, bukan pengukuran FP/FN safety/memory
  yang terkalibrasi. Jangan menyamakan suite fake/local, smoke provider, atau
  browser Console dengan bukti usefulness pengguna dan efek remote.

## Route to detail

- [Agent Runtime](../engineering/status/agent-runtime.md)
- [Telegram](../engineering/status/telegram.md)
- [WhatsApp](../engineering/status/whatsapp.md)
- [Memory and data](../engineering/status/memory.md)
- [Project workspace and coding](../engineering/status/coding.md)
- [Safety and privacy](../engineering/status/safety-privacy.md)
- [Platform](../engineering/status/platform.md)

## Maintenance

Replace stale bullets; do not append chronology. Keep at most three recent
changes and only cross-subsystem blockers. Never include credentials,
identifiers, raw logs, prompts, or user quotations. This file must remain at
most 5,120 bytes and total bootstrap output at most 8,192 bytes.
