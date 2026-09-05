# Current Context

Refreshed: 2026-09-06
Baseline: 5b294a1
Context-Version: 1

## Verified baseline

- Perubahan material yang dirangkum di sini dimulai di atas commit dasar
  `5b294a1` pada `main`; status commit dan push aktual tetap dibaca dari Git.
- `npm run check` PASS; `npm test` hijau, dan bagian Aktif
  `docs/engineering/KNOWN-FAILURES.md` kosong. Rujukan berkas dan simbol pada
  dokumen hidup dijaga `tests/periksa-dokumentasi.test.ts`, bukan ingatan.
- Telemetri pemakaian nyata 3 September 2026, 13 giliran Telegram: jalur
  pemahaman 5 `core-only`, 5 `core-escalated`, 3 `direct-full`; keputusan
  keselamatan 13/13 `calm`+`certain`, sehingga izin tulis memori terbuka penuh
  dan tidak satu pun giliran ditandai berisiko.
- Biaya terukur dari lalu lintas yang sama: pass pemahaman 1.018 token dan
  2.179 ms lawan kontrak penuh 7.646 token dan 4.410 ms, yaitu 48% lebih hemat.
- Pencarian memori berdasarkan makna diuji pada model lokal sungguhan dengan
  kalimat Indonesia; celah kemiripannya lebar (0,63-0,69 lawan 0,13-0,23) dan
  satu pencarian 29-199 ms sesudah model dimuat.

## Recent material changes

- Jalur planning durable: tiga sebab kegagalan diperbaiki 6 September 2026.
  (1) Renderer `harvy_structured_steps_v1` membuang seluruh jawaban bila satu
  field melewati ceiling tetap 1.200 karakter padahal anggarannya 2.452; satu
  langkah 1.305 karakter membuang rencana lengkap dan membeli sintesis ulang
  11-18 detik. Anjuran kini terpisah dari yang ditegakkan
  (`structuredFieldBudgetCharacters`); penolakan sisanya berjejak lewat
  `agent_structured_final_rejected`. (2) Lane durable tidak lagi memakai
  anggaran lane chat: `DURABLE_AGENT_RUN_DEADLINE_MS` 75 detik bila adapter
  menyalakan `durableWork`, chat tetap 45. Dari 15 run orchestrate, 11 selesai
  20,5-42,1 detik dan 4 terpotong tepat di 45,0 padahal hanya sintesis akhir
  yang tersisa—dan run terpotong sudah membayar planner beserta seluruh worker.
  (3) Klien tidak lagi mengulang timeout ketika sisa waktu run tinggal jatah
  jawaban akhir (`RunBudgetAccount.remainingWorkMs`, 18 detik dari 14 sintesis
  4,3-17,6 detik); empat pengulangan begitu di seluruh riwayat, semua nol.
- Kanal Telegram tidak lagi bisa tuli tanpa diketahui (ADR-046). Transformer
  API memberi `getUpdates` batas 55 detik menggantikan 500 detik bawaan grammY,
  mematuhi `retry_after` saat mengirim, dan mencatat kegagalan yang selama ini
  ditelan grammY. Balasan yang belum terbukti sampai punya janji durable.
- Acceptance Telegram pribadi dari akun penguji berdedikasi 5-6 September 2026:
  enam stage PASS—onboarding, tugas + pengingat, zona waktu + sesi + check-in
  proaktif, gambar, memori implisit, dan pembersihan akun.
  `durable_planning_runtime` lulus 3 dari 6 lalu 0 dari 4; sesudah perbaikan di
  atas, 6 dari 6 dalam 36,5-79,2 detik. Rincian:
  `docs/engineering/status/telegram.md`.

## Active cross-subsystem blockers

- `AI_MODE=testing` membuat keempat tingkatan model jatuh ke satu model yang
  sama, sehingga seluruh pemilihan peran kognitif berjalan tanpa tujuan yang
  berbeda. 21 dari 37 capability terdefinisi tidak terpasang: seluruh domain
  coding, sandbox, git, GitHub, delegasi spesialis, dan memori lintas scope.
  WhatsApp pribadi maupun grup mati karena belum ada kredensial armada.
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
