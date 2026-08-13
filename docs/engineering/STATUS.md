# Status Kemampuan Harvy

Ringkasan ini adalah peta, bukan bootstrap wajib. Buka hanya baris subsystem
yang terkait task. Keadaan aktual tetap dibuktikan oleh kode dan tes yang
benar-benar berjalan; jika detail status berbeda, laporkan perbedaannya.

- Baseline kemampuan terakhir: working tree fondasi ProjectWorkspace/Coding
  Phase G–J di atas commit dasar `f29b143` (10 Agustus 2026), diverifikasi
  ulang 13 Agustus 2026.
- Bukti baseline: `npm run check` PASS; `npm test` PASS, 1.101 test dalam 136
  suite, 0 gagal; `npm run context:check` PASS.
- Arti `Ada`: ada di kode dan lulus bukti yang disebut, bukan otomatis sudah
  terbukti pada kanal nyata.

| Area | Status ringkas | Blocker utama | Diverifikasi | Detail |
|---|---|---|---|---|
| Agent Runtime | Planner native, context-pressure compaction, typed truncation recovery, output ceiling/reserve final RunBudget, tool/delegasi read-only, serta active AgentRun durable lokal ada | Provider belum live-smoke; RunStore produksi dan kalibrasi estimator belum ada | 2026-08-09 | [`status/agent-runtime.md`](status/agent-runtime.md) |
| Telegram privat | Percakapan, onboarding, adaptive batching, selective safety route, dan work lane planning ada | Work lane dan banyak perubahan terakhir baru teruji otomatis, belum E2E ulang | 2026-08-09 | [`status/telegram.md`](status/telegram.md) |
| WhatsApp grup | Fondasi beta, adaptive batching, selective ingress, dan lifecycle guard ada | Perilaku lengkap dan dua nomor nyata belum diuji | 2026-08-09 | [`status/whatsapp.md`](status/whatsapp.md) |
| Tasks & sessions | Tugas, pengingat, tutoring, sesi, check-in, dan waktu ada | Delivery worker masih punya jendela at-least-once; banyak jalur belum live | 2026-08-06 | [`status/tasks.md`](status/tasks.md) |
| Memory & data | Memori, history, episodic compaction, ekspor/hapus, dan file storage ada | Storage satu proses; klasifikasi sensitif dan scrub sumber belum sempurna | 2026-08-06 | [`status/memory.md`](status/memory.md) |
| Project & coding | Safe ProjectWorkspace, tombstone-first deletion saga + worker recovery scope-free, durable sandbox/evidence policy dengan startup/shutdown fence eksplisit, CodingRun map/plan/task-review single-writer, private-audience local-git/GitHub exact-effect, worker observasi receipt ambigu, dan client HTTP trust-domain dengan service-auth proof ada default-off | Belum ada runner Linux, daemon local-git/object store, GitHub App broker, secret+verifier service live, Workspace ingress/composition, wiring startup worker recovery, atau metadata project/run/evidence/deletion/GitHub multi-instance | 2026-08-13 | [`status/coding.md`](status/coding.md) |
| Safety & privacy | Emergency preflight, selective triage, privacy terpisah, consent, dan kontrol data ada | FP/FN corpus model aktual belum diukur; salah klasifikasi ganda memori sensitif belum tertutup | 2026-08-09 | [`status/safety-privacy.md`](status/safety-privacy.md) |
| Console & control plane | Console localhost, paket pilot, entitlement, dan ledger ada | Belum internet-ready atau billing production | 2026-08-06 | [`status/console.md`](status/console.md) |
| Platform | Exact capability registry, provider adapter, strict terminal response, routing/fallback, runtime lock, dan log operasional ada | Capability explicit belum live-smoke; storage/log satu proses | 2026-08-09 | [`status/platform.md`](status/platform.md) |

Known defect berada di detail subsystem, bukan di bootstrap. Narasi status lama
dan bukti historis tetap tersedia di
[`status/archive/2026-08-06-monolith.md`](status/archive/2026-08-06-monolith.md),
tetapi arsip itu tidak menyatakan keadaan terbaru.

Perbarui hanya baris dan detail subsystem yang faktanya berubah. Jangan ubah
tanggal verifikasi tanpa pemeriksaan baru, dan jangan menghapus defect hanya
karena ada niat memperbaiki.
