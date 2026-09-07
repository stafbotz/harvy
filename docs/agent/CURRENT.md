# Current Context

Refreshed: 2026-09-07
Baseline: 5148077
Context-Version: 1

## Verified baseline

- Diperiksa terhadap `5148077`; perubahan di sini dimulai di atas `5b294a1`.
- `npm run check` PASS dan `npm test` 2.414 lulus 0 gagal; bagian Aktif
  `docs/engineering/KNOWN-FAILURES.md` kosong. Rujukan berkas dan simbol pada
  dokumen hidup dijaga `tests/periksa-dokumentasi.test.ts`, bukan ingatan.
- Telemetri nyata 3 September 2026, 13 giliran Telegram: 5 `core-only`, 5
  `core-escalated`, 3 `direct-full`; keselamatan 13/13 `calm`+`certain`. Pass
  pemahaman 1.018 token lawan kontrak penuh 7.646, 48% lebih hemat.
- Pencarian memori berdasarkan makna diuji pada model lokal; celahnya lebar
  (0,63-0,69 lawan 0,13-0,23).

## Recent material changes

- Dogfood terpadatkan lewat akun penguji (`tg-dogfood-20260906a`, enam run)
  menemukan tiga belas cacat yang tidak terlihat probe; dua belas diperbaiki.
  Empat run pertama: klaim menyimpan tanpa receipt, "udah kelar" yang tidak
  mengubah state tugas, animasi status yang menahan jawaban 4 menit 12 detik,
  narasi protokol tool, tawaran "Dengerin dulu" kepada yang memilih saran, dan
  "sisa penggunaan" yang menjawab kuota periode padahal jendela 24 jam yang
  menghentikannya. Tampilannya sekaligus diringkas jadi 9 baris.
- Run kelima memakai satu masalah yang berjalan, bukan daftar fitur: usefulness
  5, naturalness 2. Sapaan berpindah ke lo-gue lalu janji berhentinya dilanggar
  di bubble berikutnya, jadi sapaan kini dimiliki kode (`harvyPronounRegister`).
  Ikut diperbaiki: "Root agen tidak memakai tool" yang lolos penyaring narasi,
  "besok" untuk hari Rabu (`clockNote` membawa peta hari terdekat), dan syarat
  dosen yang tidak masuk memori—nol dari enam probe sebelum aturan self/work
  diperjelas, lima dari enam sesudahnya. Verifikasi empat giliran menemukan dua
  lagi: klaim "sudah tersimpan" lolos gerbang receipt karena daftarnya memuat
  awalan di- bukan ter-, dan gaya `advice` tetap dijawab pertanyaan telanjang
  (`questionOnlyReply`). Kata rusak terbuka: delapan kejadian.
- `unknown_tool` ditutup. Sebabnya terbaca dari kode—delegasi disaring keluar
  saat `input.step > 0` sementara transcript tetap memperlihatkan panggilannya
  berhasil—lalu direproduksi begitu probe `delegasi-ulang` meminta putaran
  delegasi kedua: 9 dari 10 run mati. Memberi tahu model bahwa tool-nya dicabut
  tidak menolong (11 dari 10). Yang bekerja: berhenti menyembunyikan, dan
  menjawab panggilannya `unavailable` lewat executor yang memang sudah menolak
  `step !== 0`. Kelasnya nol, run selesai 6 dari 10, batasnya tidak berubah.
  Batas fan-out menyusul ke `SpecialistDelegationExecutor` lewat
  `priorSuccesses`, jadi tidak ada capability yang disembunyikan dari model
  lagi; buktinya deterministik, sebab delegasi specialist belum terpasang.

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
