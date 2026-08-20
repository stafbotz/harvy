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
| Agent Runtime | Planner native, provider-aware continuation, cumulative RunBudget, context-pressure recovery, visible verbosity terpisah, active AgentRun durable lokal, targeted CodingRun input, validator-driven `toughest`, dan satu profile provider exact live-proven ada | Target `toughest`, provider fallback, RunStore distributed, dan kalibrasi estimator belum live/ada | 2026-08-20 | [`status/agent-runtime.md`](status/agent-runtime.md) |
| Telegram privat | Percakapan/safety/work lane tetap ada; Workspace upload/select, CodingRun background/Anchor, targeted input, GitHub App selection, dan exact private confirmation per tahap dirangkai opt-in | Private coding/GitHub/Telegram flow belum live E2E; runtime trust-domain default-off | 2026-08-20 | [`status/telegram.md`](status/telegram.md) |
| WhatsApp grup | GroupAgentRun dan group-coding reachable opt-in setelah authority observation; anchor/quote, audience-safe delivery, private publish handoff, dan revocation fence ada | Acceptance grup nyata, reconnect/crash, participant kedua, dan multi-instance outbox belum lulus | 2026-08-15 | [`status/whatsapp.md`](status/whatsapp.md) |
| Tasks & sessions | Tugas, pengingat, tutoring, sesi, check-in, dan waktu ada | Delivery worker masih punya jendela at-least-once; banyak jalur belum live | 2026-08-06 | [`status/tasks.md`](status/tasks.md) |
| Memory & data | Memori, history, episodic compaction, ekspor/hapus, dan file storage ada | Storage satu proses; klasifikasi sensitif dan scrub sumber belum sempurna | 2026-08-06 | [`status/memory.md`](status/memory.md) |
| Project & coding | Rootless OCI sandbox service+harness, private/group production composition, iterative CodingRun+targeted input+validators, real local Git CAS/object bundle, credential-owning GitHub App broker, exact per-stage publish/draft PR, startup recovery, dan provider primary exact tersedia | Linux hostile acceptance, GitHub/WhatsApp live, target `toughest`, serta distributed store/outbox belum lulus | 2026-08-20 | [`status/coding.md`](status/coding.md) |
| Safety & privacy | Emergency preflight, selective triage, privacy terpisah, consent, dan kontrol data ada | FP/FN corpus model aktual belum diukur; salah klasifikasi ganda memori sensitif belum tertutup | 2026-08-09 | [`status/safety-privacy.md`](status/safety-privacy.md) |
| Console & control plane | Console localhost, paket pilot, entitlement, dan ledger ada | Belum internet-ready atau billing production | 2026-08-06 | [`status/console.md`](status/console.md) |
| Platform | Exact capability registry, satu Google profile code-owned live-proven, strict provider wire, runtime lock/log, trust-domain service auth, startup conformance, serta TTFR/final p50/p95 ada | Provider fallback, dashboard/SLO, dan mayoritas storage/log masih satu proses | 2026-08-20 | [`status/platform.md`](status/platform.md) |

Known defect berada di detail subsystem, bukan di bootstrap. Narasi status lama
dan bukti historis tetap tersedia di
[`status/archive/2026-08-06-monolith.md`](status/archive/2026-08-06-monolith.md),
tetapi arsip itu tidak menyatakan keadaan terbaru.

Perbarui hanya baris dan detail subsystem yang faktanya berubah. Jangan ubah
tanggal verifikasi tanpa pemeriksaan baru, dan jangan menghapus defect hanya
karena ada niat memperbaiki.
