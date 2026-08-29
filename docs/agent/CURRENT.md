# Current Context

Refreshed: 2026-08-29
Baseline: deb2d46
Context-Version: 1

## Verified baseline

- Perubahan material yang dirangkum di sini dimulai di atas commit dasar
  `deb2d46` pada `main`; status commit dan push aktual tetap dibaca dari Git.
- `npm run check` PASS; `npm test` hijau tanpa kegagalan tercatat, dan bagian
  Aktif `docs/engineering/KNOWN-FAILURES.md` kosong.
- `npm run eval:conversation` 12/12 pada model sungguhan. Probe recall
  memanggil `history.search` 3 dari 3 run; `scripts/coba-agent.ts` membuktikan
  `terminal.run`, `agent.delegate.parallel`, `calendar.agenda`, dan
  `history.search` benar-benar dipanggil. Ketepatan isi hasil recall belum
  stabil dan dicatat di `docs/agent/SCRATCHPAD.md`.
- Smoke Edge nyata PASS pada desktop/mobile: login, navigasi tiga langkah setup,
  isi/simpan/verifikasi Compute+GitHub, non-reflection secret, dan layout. Ini
  memakai probe/storage sementara dan bukan bukti remote live.

## Recent material changes

- Gerbang bentuk intent menuju Agent Runtime menjadi satu fungsi,
  `intentAllowsAgentRuntime`, dan menerima `history` serta `memory` di samping
  `question`/`request`. Sebelumnya kedua adapter menuliskan daftarnya sendiri
  dan ketiga tool recall tidak dapat dijangkau kalimat yang paling khas bagi
  mereka. Kontrak `tool_choice: "auto"` dan `history.search` kini punya bukti
  provider nyata; `memory.list` dan `memory.remember` belum.
- Kegagalan transport provider punya alasan sendiri, `provider_unavailable`,
  terpisah dari `invalid_planner_output`. Penolakan 4xx lain sengaja tetap
  `invalid_planner_output` karena itu request yang kita susun sendiri.
- Domain semantic `coding` (`show`, `cancel`) memberi padanan bahasa alami untuk
  `/code_status` dan `/code_cancel` di kedua adapter. Permukaan slash WhatsApp
  turun dari 29 menjadi 12 yang ditampilkan tanpa melepas satu pun dari katalog
  eksekusi; slash tak dikenal tidak lagi membuang seluruh katalog ke layar.

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
