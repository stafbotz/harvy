# Status — Platform dan Operasi Runtime

Verified: 15 Agustus 2026 pada working tree composition GroupAgentRun dan
startup cancellation; `npm test` PASS, 1.348 test dalam 169 suite, 0 gagal;
smoke provider baru belum dijalankan.

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
  Control IPC kini aktif sebelum request jaringan Telegram pertama; stop saat
  startup mengabort request itu, mencegah polling baru menjadi ready, dan
  melepas lock melalui cleanup normal. Smoke konfigurasi lokal mencapai
  `application_ready` lalu `shutdown_completed`, exit 0, tanpa lock tersisa.
- Context manifest dan token estimate tersedia sebagai metadata lokal; usage
  provider dipakai bila ada.
- Registry capability mengikat exact provider+model. Default compatibility
  mempertahankan wire lama tanpa reasoning; deklarasi `AI_MODEL_PROFILES`
  schema-valid diperlukan untuk effort/reasoning continuation baru. Adapter
  mengirim allowlist message dan field Google/OpenRouter/DeepSeek yang sesuai
  profile, termasuk omission temperature/tool choice yang tidak didukung.
- Respons tanpa terminal finish reason, content filter, reason asing, dan
  pasangan text/tool reason yang salah ditolak. Ledger menormalkan reason asing
  ke `other` dan membedakan `incomplete` dari `truncated` tanpa menyimpan isi.
- Repository telemetry v3 menambah turn record content-free yang ikut retensi,
  export, full deletion, flush, dan shutdown drain. Service menyediakan
  nearest-rank p50/p95 serta rate boundary/triage/review/fast-path per owner;
  retry fisik tetap dicatat terpisah di provider-attempt ledger.

## Batas dan defect aktif

- Storage dan operational log hanya aman untuk satu proses; belum PostgreSQL,
  collector terpusat, alerting, immutable audit, atau deployment hardening.
- Force stop/crash dapat meninggalkan runtime lock stale. Hapus hanya setelah
  PID pemilik di payload diverifikasi sudah mati.
- Native tool calling masih primary-only; compatibility fallback belum terbukti.
- Capability explicit provider fallback sengaja ditolak sampai execution plan
  dapat dihitung ulang secara aman untuk provider/model fallback.
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
  `tests/dev-runner.test.ts`, `tests/app-startup-shutdown.test.ts`.
- Keputusan: ADR-003, ADR-010, ADR-025. Setup:
  `docs/engineering/DEVELOPMENT.md`.
