# Status — Platform dan Operasi Runtime

Refreshed: 25 Agustus 2026 pada migrasi provider testing GMI-only.
Angka gerbang penuh terbaru dicatat di `docs/LOG.md`.

## Keadaan saat ini

- Mode testing memakai satu primary OpenAI-compatible `gmi-serving`; production
  memakai satu gateway OpenRouter. Composition runtime kedua mode tidak
  mempunyai provider fallback. Setiap physical retry tetap mempertahankan
  request ID dan dicatat sebagai attempt terpisah pada provider yang sama.
- Timeout, network error, 429, dan 5xx gagal tertutup setelah retry bounded pada
  provider aktif. Lifecycle cancellation, 4xx lain, invalid output, dan local
  limit juga tidak pernah dialihkan ke provider lain.
- `AI_BASE_URL` primary divalidasi sebagai HTTPS atau HTTP loopback tanpa
  credential/query/fragment/path completion penuh sebelum key dapat dikirim.
  Respons chat sukses mempunyai hard cap 64 MiB sebelum buffering, memakai
  decoder UTF-8 fatal dan JSON strict; body error dibatalkan. Oversize atau
  malformed 2xx tetap menahan reservation RunBudget sebagai usage unknown,
  sehingga hardening transport tidak memberi retry budget optimistis.
- SecretStore BYOK mempublikasikan snapshot cache immutable hanya setelah
  replacement atomik-durable berhasil. Initial read dikoaleskan tanpa
  menyerialisasi semua cache hit; mutation tetap berurutan, write gagal tidak
  mengekspos secret baru, dan record/ref lokal yang rusak gagal tertutup.
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
  mempertahankan wire dasar tanpa reasoning; deklarasi `AI_MODEL_PROFILES`
  schema-valid atau profile code-owned yang sudah dibuktikan live diperlukan
  untuk capability baru. `gmi-serving/MiniMaxAI/MiniMax-M3` pada endpoint resmi
  kini mempunyai profile exact code-owned; custom gateway dan model lain tidak
  mewarisi bukti itu.
- Respons tanpa terminal finish reason, content filter, reason asing, dan
  pasangan text/tool reason yang salah ditolak. Ledger menormalkan reason asing
  ke `other` dan membedakan `incomplete` dari `truncated` tanpa menyimpan isi.
  Respons 2xx yang kehilangan terminal marker dapat dicoba sekali lagi secara
  berbatas pada provider yang sama; `content_filter` dan reason terminal lain
  tetap tidak di-retry. Bukti recovery provider lama bersifat historis dan
  belum membuktikan perilaku GMI/MiniMax.
- Repository telemetry v3 menambah turn record content-free yang ikut retensi,
  export, full deletion, flush, dan shutdown drain. Service menyediakan
  nearest-rank p50/p95 serta rate boundary/triage/review/fast-path per owner;
  retry fisik tetap dicatat terpisah di provider-attempt ledger.
- Telemetry turn sekarang mencatat `timeToFirstResponseMs` dari delivery pertama
  dan `timeToFinalResponseMs` dari delivery terminal, lalu mengagregasikan p50/
  p95 terpisah. Nilai ini content-free dan membedakan feedback awal dari durasi
  sampai hasil akhir; total model latency tidak dipakai sebagai proxy TTFR.
- Coding production composition dipasang di `app.ts` secara opt-in dan wajib
  melewati recovery+conformance sebelum command kanal didaftarkan. Trust-domain
  sandbox, local-git, dan GitHub broker memakai service HMAC dari secret file;
  loopback insecure memerlukan flag development explicit.
- `npm start` memakai supervisor satu-child dengan exponential backoff dan
  crash-loop breaker. Shutdown normal dikirim melalui IPC lintas platform agar
  aplikasi sempat menguras worker, menghentikan transport, dan melepas lock;
  kill paksa hanya fallback setelah timeout. Klaim local runtime lock memakai
  staging tersinkron lalu publikasi hard-link no-replace, sehingga proses tidak
  menerbitkan authority file setengah tertulis. Lock milik PID mati direklamasi
  otomatis secara fail-closed.
- Fault acceptance satu kali membuktikan supervisor memulai child kedua dan
  kanal kembali menjawab lewat akun Telegram maupun WhatsApp nyata. Kedua run
  mencatat attempt 1/2 ready, restart terjadwal, shutdown bersih, dan state
  acceptance terhapus. Ini bukan bukti crash pada exact send/receipt window.
- Backup lokal mengenkripsi seluruh archive dengan AES-256-GCM, mencatat hash
  dan inventaris target logis, menolak symlink/traversal serta mutasi sumber,
  dan hanya restore ke direktori baru. Verifikasi/restore mendekripsi sebagai
  stream tanpa membuat archive plaintext sementara. Drill terbaru pada state
  Harvy terkonfigurasi berhasil create→verify→restore 3.588 entry/4.371.589
  byte dari 14 target yang hadir (18 target terdaftar) dan membersihkan artifact
  uji. Kunci drill dibuat acak di memori dan dihapus, bukan kunci operasional.

## Batas dan defect aktif

- Storage dan operational log hanya aman untuk satu proses; belum PostgreSQL,
  collector terpusat, alerting, immutable audit, atau deployment hardening.
- Crash masih dapat meninggalkan lock stale, tetapi startup berikutnya hanya
  mereklamasinya setelah payload valid dan PID pemilik terbukti mati. Lock
  malformed dari luar tetap gagal tertutup dan memerlukan pemeriksaan operator.
- Smoke exact GMI/MiniMax 25 Agustus membuktikan completion, structured JSON,
  native tool + tool-result continuation, truncation, rejection context lokal,
  timeout, input gambar, serta automatic cache reuse. Provider melaporkan
  cache-read tetapi tidak melaporkan cache-write; populasi cache disimpulkan
  dari prefix unik yang pertama uncached lalu terbaca cache pada request kedua.
- Hanya satu key tersedia saat smoke, sehingga rotasi/retry lintas key tidak
  dapat dijalankan. Kebijakan privacy/retention dan SLA GMI tetap belum
  diverifikasi oleh kode.
- Reservasi RunBudget memakai rasio karakter-per-token yang dikalibrasi per
  model dari `usage` provider nyata (`TokenRatioCalibration`, dipakai
  `AiClient` saat `reserveModelCall`). Kalibrasi itu in-memory per instance
  `AiClient` dan butuh lima observasi, jadi restart mengembalikannya ke default
  4 karakter per token. Selection konteks, pemadatan, dan context-pressure tetap
  memakai default itu tanpa kalibrasi; belum ada tokenizer maupun kalibrasi per
  route.
- Turn summary belum menjadi dashboard agregat lintas owner. TTFR/final p50/p95
  tersedia pada service/repository, tetapi alert/SLO exporter dan pengukuran
  live lintas Telegram/WhatsApp belum dikalibrasi.
- Drill backup memakai kunci acak in-memory dan menghapus hasilnya; belum ada
  kunci backup durable, media eksternal/offline, jadwal retensi, atau bukti
  restore lintas mesin. Ini belum boleh disebut backup operasional permanen.

## Bukti dan pointer

- Kode: `src/ai/client.ts`, `src/ai/key-pool.ts`, `src/ai/token-estimate.ts`,
  `src/config.ts`,
  `src/transport/bounded-response-body.ts`, `src/core/secret-store.ts`,
  `src/core/local-runtime-lock.ts`,
  `src/core/telemetry-service.ts`, `src/core/coding-runtime-composition.ts`,
  `src/observability/`, `src/operations/local-backup.ts`,
  `src/operations/runtime-supervisor.ts`, `scripts/dev-runner.ts`, dan
  `scripts/local-backup-drill.ts`.
- Tes: `tests/client.test.ts`, `tests/ai-config.test.ts`,
  `tests/secret-store.test.ts`, `tests/key-pool.test.ts`,
  `tests/local-runtime-lock.test.ts`, `tests/operational-logger.test.ts`,
  `tests/dev-runner.test.ts`, `tests/app-startup-shutdown.test.ts`,
  `tests/local-backup.test.ts`, `tests/runtime-supervisor.test.ts`.
- Keputusan: ADR-003, ADR-010, ADR-025. Setup:
  `docs/engineering/DEVELOPMENT.md`.
