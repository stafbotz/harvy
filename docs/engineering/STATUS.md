# Status Kemampuan Harvy

Ringkasan ini adalah peta, bukan bootstrap wajib. Buka hanya baris subsystem
yang terkait task. Keadaan aktual tetap dibuktikan oleh kode dan tes yang
benar-benar berjalan; jika detail status berbeda, laporkan perbedaannya.

- Baseline kemampuan terakhir: production-composition vertical slice di atas
  commit dasar `ee8f1ef` pada branch `main` (20 Agustus 2026).
- Bukti baseline: `npm run check` PASS; `npm test` PASS, 1.413 test dalam 183
  suite, 0 gagal; `npm run context:check` PASS; `git diff --check` PASS selain
  peringatan line-ending.
- Arti `Ada`: ada di kode dan lulus bukti yang disebut, bukan otomatis sudah
  terbukti pada kanal nyata.

| Area | Status ringkas | Blocker utama | Diverifikasi | Detail |
|---|---|---|---|---|
| Agent Runtime | Planner native, provider-aware continuation, cumulative RunBudget, context-pressure recovery, visible verbosity terpisah, active AgentRun durable lokal, targeted CodingRun input, dan validator-driven `toughest` ada | Target `toughest`, CodingRun/channel live, RunStore distributed, dan kalibrasi estimator belum live/ada | 2026-08-25 | [`status/agent-runtime.md`](status/agent-runtime.md) |
| Telegram privat | Percakapan/safety/work lane, semantic control, usage natural, primary-only memory portrait, output guard, Workspace/CodingRun, dan GitHub surface ada; adaptive tester current-build lulus focused routing/context/correction | Dogfood tujuh hari, image lewat kanal, private coding/GitHub E2E, dan cancellation provider live belum lulus | 2026-08-26 | [`status/telegram.md`](status/telegram.md) |
| WhatsApp privat & grup | Privat mempunyai parity operasi Telegram dan grup mempunyai GroupAgentRun/group-coding opt-in dengan authority fence | Rerun current-build privat terblokir session tester 401; participant kedua grup, reconnect/crash exact, coding/GitHub live, dan outbox multi-instance belum lulus | 2026-08-26 | [`status/whatsapp.md`](status/whatsapp.md) |
| Tasks & sessions | Tugas, pengingat, tutoring, sesi, check-in, dan waktu ada | Delivery worker masih punya jendela at-least-once; banyak jalur belum live | 2026-08-06 | [`status/tasks.md`](status/tasks.md) |
| Memory & data | Auto-memory privat berbasis onboarding, primary-only portrait, receipt claim, history/episode terpisah, ekspor/hapus, dan lifecycle cascade ada | FP/FN belum terkalibrasi, embedding provider belum live, dan storage masih satu proses | 2026-08-26 | [`status/memory.md`](status/memory.md) |
| Project & coding | Rootless OCI sandbox service+harness, private/group production composition, iterative CodingRun+targeted input+validators, real local Git CAS/object bundle, credential-owning GitHub App broker, exact per-stage publish/draft PR, dan startup recovery tersedia | CodingRun provider/channel live, Linux hostile acceptance, GitHub/WhatsApp live, target `toughest`, serta distributed store/outbox belum lulus | 2026-08-25 | [`status/coding.md`](status/coding.md) |
| Safety & privacy | Emergency preflight, selective triage, consent v10/notice v11, transient image boundary, receipt lifecycle, dan kontrol data ada | FP/FN bahasa luas belum diukur; salah klasifikasi memori/safety dan live image channel belum tertutup | 2026-08-26 | [`status/safety-privacy.md`](status/safety-privacy.md) |
| Console & control plane | Console localhost, paket pilot, entitlement, dan ledger ada | Belum internet-ready atau billing production | 2026-08-06 | [`status/console.md`](status/console.md) |
| Platform | Exact GMI/MiniMax profile, strict provider wire, automatic-cache/image smoke, runtime lock/log, trust-domain service auth, startup conformance, serta TTFR/final p50/p95 ada; runtime testing GMI-only tanpa provider fallback | Retry lintas key, dashboard/SLO, provider privacy/SLA, dan mayoritas storage/log masih satu proses | 2026-08-25 | [`status/platform.md`](status/platform.md) |

Known defect berada di detail subsystem, bukan di bootstrap. Narasi status lama
dan bukti historis tetap tersedia di
[`status/archive/2026-08-06-monolith.md`](status/archive/2026-08-06-monolith.md),
tetapi arsip itu tidak menyatakan keadaan terbaru.

Perbarui hanya baris dan detail subsystem yang faktanya berubah. Jangan ubah
tanggal verifikasi tanpa pemeriksaan baru, dan jangan menghapus defect hanya
karena ada niat memperbaiki.
