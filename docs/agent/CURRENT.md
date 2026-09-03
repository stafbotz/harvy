# Current Context

Refreshed: 2026-09-03
Baseline: a75ff15
Context-Version: 1

## Verified baseline

- Perubahan material yang dirangkum di sini dimulai di atas commit dasar
  `a75ff15` pada `main`; status commit dan push aktual tetap dibaca dari Git.
- `npm run check` PASS; `npm test` 2188/2188 hijau, dan bagian Aktif
  `docs/engineering/KNOWN-FAILURES.md` kosong.
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

- Pemahaman dipecah dua tahap. Kontrak inti 3.253 karakter menjawab lima field
  yang diperlukan sebelum berat-ringannya giliran diketahui; kontrak penuh
  29.513 karakter hanya dibayar giliran yang memerlukannya. Petunjuk teks
  diperiksa sebelum model dipanggil, sehingga giliran yang sudah jelas berat
  melewati pass inti dan tidak pernah membayar dua kali. Pass inti juga
  dihangatkan selama jendela tunggu batching, dan sinyal risikonya
  memberangkatkan triase keselamatan bersamaan alih-alih berurutan.
- Telemetri yang selama ini dibuang allow-list dibuka: manifest retrieval
  memori (12 field), `httpStatus`/`responseOutcome` pada tiap permintaan AI,
  keputusan keselamatan (`safety_decision`), jalur pemahaman
  (`understanding_pass_chosen`), dan hasil tulis memori
  (`memory_write_outcome`) beserta enam sebab penolakan yang sebelumnya
  seluruhnya mengembalikan `null` identik.
- Retrieval semantik memperoleh penyedia embedding yang berjalan di dalam
  proses Harvy sendiri dan hidup secara bawaan, dengan sakelar mati dan pemutus
  arus. Tidak ada catatan pengguna yang keluar dari mesin. Sapaan onboarding
  juga tidak lagi naskah tetap: ia dikarang model tiap kali, dengan identitas
  Harvy dijamin kode.

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
