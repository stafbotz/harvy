# Current Context

Refreshed: 2026-09-06
Baseline: 6c65494
Context-Version: 1

## Verified baseline

- Diperiksa terhadap `6c65494`; perubahan material yang dirangkum di sini
  dimulai di atas `5b294a1`. Status commit dan push dibaca dari Git.
- `npm run check` PASS dan `npm test` 2.373 lulus 0 gagal; bagian Aktif
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

- Dogfood terpadatkan pertama lewat akun penguji (`tg-dogfood-20260906a`, 35
  giliran) menemukan empat cacat yang tidak pernah terlihat probe, dan
  keempatnya diperbaiki: balasan mengaku menyimpan tanpa receipt code-owned
  (gerbangnya dulu menuntut adanya kandidat yang gagal, bukan adanya receipt);
  "udah kelar" yang tidak mengubah state tugas kini disertai baris code-owned;
  animasi status yang menahan jawaban sungguhan sampai 4 menit 12 detik kini
  digabung, berhenti sesudah satu penolakan kanal, dan tidak lagi ditunggu tanpa
  batas; serta narasi protokol tool di dalam balasan dan tawaran "Dengerin dulu"
  kepada pengguna yang memilih "Langsung saran". Run kedua melengkapi delapan
  marker mode full dan memverifikasi tiga di antaranya dari kanal. Kuota plan
  Perkenalan (200.000 token per 24 jam, ~30 giliran) menghentikan run pertama di
  giliran 35 dengan copy yang menyebutnya "jeda singkat"; itu belum diperbaiki.
- Ingatan jahitan pada `history.search` ditutup. `scoreEpisode` membuang klaim
  yang tidak berbagi satu kata pun dengan kueri sebelum bonus jenis berlaku, dan
  klaim `unresolved` justru jarang mengulang kata topiknya. Sebelum: 24 run
  memberi 18 tepat, 4 jujur tidak menemukan, 2 menjahit klaim dua percakapan
  menjadi ingatan yang tidak pernah terjadi—keenamnya dari kueri topik-saja,
  yang 0 dari 6 benar. Sesudah `withRequestedFields`: 48 run, nol jahitan,
  nol tidak menemukan, dan kueri topik-saja 3 dari 3 benar.
- Jalur planning durable: penolakan bentuk jawaban yang membuang sintesis
  (`structuredFieldBudgetCharacters`), anggaran waktu lane durable yang terpisah
  dari lane chat (`DURABLE_AGENT_RUN_DEADLINE_MS` 75 detik), dan pengulangan
  timeout yang tidak menyisakan waktu menjawab (`remainingWorkMs`).
  `durable_planning_runtime` yang lulus 3 dari 6 lalu 0 dari 4 kini 6 dari 6
  dalam 36,5-79,2 detik.

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
  terkalibrasi. Suite fake/local, smoke provider, dan browser Console bukan
  bukti usefulness pengguna maupun efek remote.

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
