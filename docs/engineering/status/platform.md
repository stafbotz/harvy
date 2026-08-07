# Status — Platform dan Operasi Runtime

Verified: 7 Agustus 2026 pada working tree Phase A di atas `8be00be`;
unit/integration lokal dan smoke provider lama yang terbatas tersedia.

## Keadaan saat ini

- Mode testing dapat memakai gateway OpenAI-compatible cadangan; production
  mengabaikannya. Retry/fallback mempertahankan request ID dan mencatat setiap
  physical attempt secara terpisah.
- Timeout/network/5xx dapat failover; 429 mengikuti key-rotation policy lalu
  circuit sementara. Lifecycle cancellation, 4xx lain, invalid output, dan
  local limit tidak diam-diam dialihkan.
- Operational log NDJSON memakai allowlist metadata, redaksi, size/UTC rotation,
  retention, bounded queue, tail repair, health, dan flush shutdown. Isi,
  identity, credential, dan object mentah tidak boleh masuk.
- Runtime, probe, dan evaluator memakai local file lock yang sama. Dev runner
  meminta shutdown child lewat IPC dan menunggu lock dilepas sebelum restart.
- Context manifest dan token estimate tersedia sebagai metadata lokal; usage
  provider dipakai bila ada.
- Repository telemetry v3 menambah turn record content-free yang ikut retensi,
  export, full deletion, flush, dan shutdown drain. Service menyediakan
  nearest-rank p50/p95 serta rate boundary/triage/review/fast-path per owner;
  retry fisik tetap dicatat terpisah di provider-attempt ledger.

## Batas dan defect aktif

- Storage dan operational log hanya aman untuk satu proses; belum PostgreSQL,
  collector terpusat, alerting, immutable audit, atau deployment hardening.
- Force stop/crash dapat meninggalkan runtime lock stale. Hapus hanya setelah
  PID pemilik di payload diverifikasi sudah mati.
- Startup pernah melanjutkan sampai ready setelah menerima `dev-restart`, lalu
  meninggalkan lock stale. Race startup-cancel itu belum diperbaiki.
- Native tool calling masih primary-only; compatibility fallback belum terbukti.
- Kebijakan privacy/retention provider cadangan belum diverifikasi.
- Token selection masih character/count-based; belum ada tokenizer atau
  adaptive calibration per route/model.
- Turn summary belum menjadi dashboard agregat lintas owner dan belum mengukur
  time-to-first-response; wiring terminal saat ini baru free-text Telegram.

## Bukti dan pointer

- Kode: `src/ai/client.ts`, `src/ai/key-pool.ts`, `src/core/local-runtime-lock.ts`,
  `src/observability/`, `scripts/dev-runner.ts`.
- Tes: `tests/client.test.ts`, `tests/key-pool.test.ts`,
  `tests/local-runtime-lock.test.ts`, `tests/operational-logger.test.ts`,
  `tests/dev-runner.test.ts`.
- Keputusan: ADR-003, ADR-010. Setup: `docs/engineering/DEVELOPMENT.md`.
