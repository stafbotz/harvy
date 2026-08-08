# Status Kemampuan Harvy

Ringkasan ini adalah peta, bukan bootstrap wajib. Buka hanya baris subsystem
yang terkait task. Keadaan aktual tetap dibuktikan oleh kode dan tes yang
benar-benar berjalan; jika detail status berbeda, laporkan perbedaannya.

- Baseline kemampuan terakhir: commit `43d8e16` (6 Agustus 2026).
- Bukti baseline: `npm run check` PASS; `npm test` PASS, 644 test dalam 93 suite.
- Arti `Ada`: ada di kode dan lulus bukti yang disebut, bukan otomatis sudah
  terbukti pada kanal nyata.

| Area | Status ringkas | Blocker utama | Diverifikasi | Detail |
|---|---|---|---|---|
| Agent Runtime | Native planner, tool internal read-only, terminal virtual, delegasi, checkpoint klarifikasi, dan fast path waktu berbatas ada | Post-fix belum smoke primary/Telegram; RunStore produksi belum ada | 2026-08-08 | [`status/agent-runtime.md`](status/agent-runtime.md) |
| Telegram privat | Percakapan, onboarding, local-first batching, dan route privat ada | Banyak perubahan terakhir baru teruji otomatis, belum E2E ulang | 2026-08-08 | [`status/telegram.md`](status/telegram.md) |
| WhatsApp grup | Fondasi beta grup dan multi-account satu proses ada | Perilaku lengkap dan dua nomor nyata belum diuji | 2026-08-06 | [`status/whatsapp.md`](status/whatsapp.md) |
| Tasks & sessions | Tugas, pengingat, tutoring, sesi, check-in, dan waktu ada | Delivery worker masih punya jendela at-least-once; banyak jalur belum live | 2026-08-06 | [`status/tasks.md`](status/tasks.md) |
| Memory & data | Memori, history, episodic compaction, ekspor/hapus, dan file storage ada | Storage satu proses; klasifikasi sensitif dan scrub sumber belum sempurna | 2026-08-06 | [`status/memory.md`](status/memory.md) |
| Safety & privacy | Emergency preflight, triase fail-closed, review, consent, dan kontrol data ada | Preflight sempit; salah klasifikasi ganda memori sensitif belum tertutup | 2026-08-08 | [`status/safety-privacy.md`](status/safety-privacy.md) |
| Console & control plane | Console localhost, paket pilot, entitlement, dan ledger ada | Belum internet-ready atau billing production | 2026-08-06 | [`status/console.md`](status/console.md) |
| Platform | Provider routing/fallback, runtime lock, dan log operasional ada | Storage/log satu proses; lock stale pasca penghentian paksa masih mungkin | 2026-08-06 | [`status/platform.md`](status/platform.md) |

Known defect berada di detail subsystem, bukan di bootstrap. Narasi status lama
dan bukti historis tetap tersedia di
[`status/archive/2026-08-06-monolith.md`](status/archive/2026-08-06-monolith.md),
tetapi arsip itu tidak menyatakan keadaan terbaru.

Perbarui hanya baris dan detail subsystem yang faktanya berubah. Jangan ubah
tanggal verifikasi tanpa pemeriksaan baru, dan jangan menghapus defect hanya
karena ada niat memperbaiki.
