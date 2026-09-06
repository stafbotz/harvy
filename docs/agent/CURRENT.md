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
  pemahaman 5 `core-only`, 5 `core-escalated`, 3 `direct-full`; keselamatan
  13/13 `calm`+`certain`, jadi izin tulis memori terbuka penuh.
- Biaya dari lalu lintas yang sama: pass pemahaman 1.018 token dan 2.179 ms
  lawan kontrak penuh 7.646 token dan 4.410 ms, 48% lebih hemat.
- Pencarian memori berdasarkan makna diuji pada model lokal sungguhan dengan
  kalimat Indonesia; celah kemiripannya lebar (0,63-0,69 lawan 0,13-0,23).

## Recent material changes

- Jalur planning durable: tiga sebab kegagalan diperbaiki. (1) Renderer
  `harvy_structured_steps_v1` membuang seluruh jawaban bila satu field melewati
  ceiling anjuran 1.200 karakter padahal anggarannya 2.452; anjuran kini
  terpisah dari yang ditegakkan (`structuredFieldBudgetCharacters`), dan
  penolakan sisanya berjejak lewat `agent_structured_final_rejected`. (2) Lane
  durable memakai `DURABLE_AGENT_RUN_DEADLINE_MS` 75 detik bila adapter
  menyalakan `durableWork`, chat tetap 45: dari 15 run orchestrate, 4 terpotong
  tepat di 45,0 detik padahal hanya sintesis akhir yang tersisa. (3) Klien
  tidak lagi mengulang timeout ketika sisa waktu run tinggal jatah jawaban
  akhir (`RunBudgetAccount.remainingWorkMs`); empat pengulangan begitu di
  seluruh riwayat, semua memberi pengguna nol.
- Ingatan jahitan pada `history.search` ditutup. `scoreEpisode` membuang klaim
  yang tidak berbagi satu kata pun dengan kueri sebelum bonus jenis berlaku,
  dan klaim `unresolved` justru jarang mengulang kata topiknya. Diukur dengan
  `scripts/coba-agent.ts --kasus=recall`: sebelum, 24 run memberi 18 tepat, 4
  jujur tidak menemukan, dan 2 menjahit klaim dua percakapan menjadi ingatan
  yang tidak pernah terjadi—keenamnya dari bentuk kueri yang sama, topik saja,
  yang 0 dari 6 benar. `withRequestedFields` kini membawa klaim yang jenisnya
  diminta dengan skor nol, hanya dari episode yang sudah cocok, tanpa menggeser
  peringkat antar-episode. Sesudah, 48 run: nol jahitan, nol tidak menemukan,
  dan kueri topik-saja 3 dari 3 benar.
- Acceptance Telegram pribadi dari akun penguji berdedikasi 5-6 September 2026:
  enam stage PASS—onboarding, tugas + pengingat, zona waktu + sesi + check-in
  proaktif, gambar, memori implisit, dan pembersihan akun.
  `durable_planning_runtime` lulus 3 dari 6 lalu 0 dari 4; sesudah perbaikan di
  atas, 6 dari 6 dalam 36,5-79,2 detik.

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
