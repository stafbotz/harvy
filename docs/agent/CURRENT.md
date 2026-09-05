# Current Context

Refreshed: 2026-09-05
Baseline: 78c24cc
Context-Version: 1

## Verified baseline

- Perubahan material yang dirangkum di sini dimulai di atas commit dasar
  `78c24cc` pada `main`; status commit dan push aktual tetap dibaca dari Git.
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

- `npm run eval:compaction` mengukur recall sesudah pemadatan, dan sudah
  dijalankan. Transkrip `ujian-biologi`, tiga repetisi, `AI_MODE=testing`:
  `utuh` 97,9% (93,8-100) pada 4.896 karakter, `episode` 20,8% (12,5-25,0)
  pada 3.172, `episode+cari` 60,4% (56,3-68,8) pada 3.596. Rentangnya tidak
  bertumpang tindih: **pencarian riwayat menopang, bukan melengkapi**—konteks
  episode otomatis sendirian menahan kurang dari seperempat fakta spesifik.
  Anchor index karena itu tidak dirender ke prompt; pengukurannya tidak
  mendukung, dan penunjuk pemulihan pada konteks episode yang justru terbukti
  menunjuk ke jalur bernilai ~40 poin recall.
- Pasal 2 konstitusi dapat dijalankan untuk pertama kalinya (ADR-047). Sesi
  tutor yang selesai meninggalkan `LearningTrace`, dan
  `src/core/mastery-policy.ts` memakainya untuk memendekkan tahap pembuka
  sesudah tiga penyelesaian mandiri berturut. Yang memudar **hanya** tahap
  pembuka. Episode juga memperoleh field `progress` (schema v3, v2 tetap
  dibaca), dan memori wajib ditulis sebagai fakta, bukan perintah.
- Kanal Telegram tidak lagi bisa tuli tanpa diketahui (ADR-046). Transformer
  API memberi `getUpdates` batas 55 detik menggantikan 500 detik bawaan
  grammY, mematuhi `retry_after` saat mengirim, dan mencatat kegagalan yang
  selama ini ditelan grammY. Balasan yang belum terbukti sampai punya janji
  durable, dikirim ulang bertanda hanya dari proses yang sudah mati.
- Acceptance Telegram pribadi dari akun penguji berdedikasi 5 September 2026:
  enam stage PASS—onboarding, tugas + pengingat, zona waktu + sesi + check-in
  proaktif, gambar, memori implisit, dan pembersihan akun.
  `durable_planning_runtime` FAIL karena stage-nya menunggu AgentRun yang
  memang sengaja tidak lagi dibuka untuk permintaan tanpa tool. Dua stage lain
  juga ternyata menguji hal yang bukan kontrak Harvy dan sudah diperbaiki; satu
  temuan perilaku dibiarkan terbuka karena perbaikannya keputusan produk.
  Rinciannya di `docs/engineering/status/telegram.md`.

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
