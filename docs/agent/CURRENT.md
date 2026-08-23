# Current Context

Refreshed: 2026-08-23
Baseline: fe363c9
Context-Version: 1

## Verified baseline

- Working tree material berada di atas commit dasar `fe363c9` pada `main`;
  tidak ada commit implementasi, push, atau PR baru.
- `npm run check` PASS. `npm test` PASS 1.708/1.708 dalam 210 suite. Evaluasi
  provider nyata PASS 60/60 (42 percakapan + 18 boundary/interruption) tanpa
  fallback, provider failure, atau execution failure.
- Smoke build final mencapai `application_ready` lalu IPC
  `shutdown_completed`, tanpa proses/lock tersisa. Drill backup state lokal
  PASS create→verify→restore terenkripsi; preflight WhatsApp privat gagal
  tertutup sebelum koneksi karena konfirmasi operator belum tersedia.

## Recent material changes

- Telegram privat dan WhatsApp privat kini memakai katalog capability serta
  executor yang sama: percakapan, task/reminder, session/check-in, data control,
  Workspace ZIP, private coding, GitHub, dan AgentRun durable. UI tetap mengikuti
  kanal; WhatsApp grup tetap aktif sebagai produk beta, bukan dibekukan.
- Reminder/check-in memakai intent delivery at-most-once dan owner queue untuk
  menahan duplikat setelah crash, dengan trade-off hasil ambigu dapat kehilangan
  satu kiriman. Semua kandidat memori implicit privat/grup meminta izin
  item-spesifik; model/classifier tidak lagi mempunyai authority write.
- Supervisor single-child menambah restart berbatas, graceful IPC, dan runtime
  lock recovery. Backup lokal memakai archive authenticated-encrypted dan
  restore ke direktori baru. Evaluator menilai outcome nyata seperti hasil
  hitung, reminder kosong, timezone, sesi, safety, dan human bridge.

## Active cross-subsystem blockers

- Latest build belum dipakai bercakap oleh tester nyata di Telegram atau
  WhatsApp. Akun WhatsApp lokal belum paired dengan akun tester terpisah; grup
  latest build, dua nomor, reconnect, receipt transport, dogfood tujuh hari,
  dan tiga wawancara belum selesai.
- Host ini Windows tanpa runtime OCI Linux non-root dan tidak mempunyai GitHub
  App/repository uji. Hostile-code conformance, branch/push/draft PR, provider
  fallback, dan critic `toughest` masih belum terbukti live.
- Backup belum mempunyai kunci durable, jadwal, atau salinan eksternal/lintas
  mesin. Control-plane/coding/group/GitHub storage masih single-service tanpa
  distributed lease, outbox/dispatcher, shared store, dan reconciliation
  multi-instance; jangan klaim siap horizontal atau siap peluncuran publik.
- Corpus provider adalah regresi terbatas, bukan pengukuran FP/FN safety yang
  terkalibrasi. Learning group/project/connector/multimodal, LLM synthesis,
  cold ANN, dan skill promotion belum dirangkai.

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
