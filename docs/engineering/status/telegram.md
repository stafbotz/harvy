# Status — Telegram Privat

Refreshed: 24 Agustus 2026 pada auto-memory privat berbasis onboarding.
Angka gerbang penuh terbaru dicatat di `docs/LOG.md`; focus live policy baru
sudah lulus, sedangkan dogfood tujuh hari dan coding/GitHub live belum selesai.

## Keadaan saat ini

- Surface utama adalah chat pribadi Telegram dengan percakapan biasa dan
  tombol; `/start`, `/menu`, `/tugas`, dan `/bantuan` hanya pelengkap.
- Telegram privat dan WhatsApp privat memakai kontrak capability yang sama;
  Telegram mempertahankan tombol/callback untuk UX kanal, bukan hak fitur yang
  sengaja ditahan dari WhatsApp.
- Harness pengguna nyata kini tersedia melalui akun tester MTProto terpisah.
  Pairing QR menyimpan `api_id`, `api_hash`, session pengguna, dan token bot uji
  di vault lokal terenkripsi; acceptance menyalakan build dalam state sementara,
  menghasilkan receipt content-free, lalu memakai kontrol produk untuk cleanup.
  Pairing dan run penuh sudah dilakukan pada 23 Agustus 2026; credential uji
  tetap terpisah dari bot utama.
- Onboarding menahan pesan pertama sampai consent, mempertahankan urutan bubble,
  dan menyediakan jalur safety tanpa consent. Bubble setelah pesan pertama
  tidak dikirim ke model atau dinilai safety sebelum consent. Setelah consent,
  batas bubble yang ditahan dipertahankan dan matcher lokal menilai tiap bagian.
- Consent onboarding versi 8 mengotorisasi auto-memory ordinary maupun personal
  pada scope Telegram privat. Candidate baru tidak meminta izin atau memberi
  tombol lupakan/urungkan per-item; Harvy baru memberi acknowledgment natural
  setelah commit. Credential tetap ditolak dan kontrol lihat/koreksi/hapus
  tersedia lewat percakapan serta `/memori`.
- Ingress pesan nonblocking memakai boundary semantic-first untuk bahasa
  natural: model menerima seluruh current batch, konteks terbaru, dan timing
  content-free lalu mengembalikan state, confidence, continuation likelihood,
  serta reason class closed-set. Regex lokal hanya memutus command, hitungan,
  pertanyaan/acknowledgment yang jelas, fragmen sintaksis keras, dan emergency
  eksplisit. Settle awal memakai fallback 650 ms lalu p90 gap antar-arrival
  content-free per pemilik setelah tiga sampel, termasuk lintas batch yang
  sudah ter-flush; state RAM berbatas/ber-TTL. Complete yang yakin langsung
  diproses setelah settle, complete multi-bubble yang ragu dapat menunggu 4
  detik, dan open/incomplete tetap 7/12 detik. Command/callback diserialkan per
  owner.
- Pesan baru tetap dapat masuk selama model/tool/output aktif. Classifier
  hubungan membedakan addition, correction, redirect, dan independent;
  tiga yang pertama menyupersesi work lama melalui `AbortController`, relation
  barrier, serta generation guard, sedangkan independent tetap diantrekan.
  User turn yang belum durable dapat digabung ulang; history, memory/action
  offer, tombol, dan output lama diperiksa lagi sebelum commit atau send.
  Parser waktu pending menerima signal yang sama; mutasi tenggat, reminder,
  check-in, memory, dan jam tenang dipagari ulang tepat sebelum commit.
- Emergency preflight lokal berpresisi tinggi dapat mengirim ACK sebelum
  debounce; full triage, review sesuai policy, handler, dan mutasi tetap memakai
  pipeline/FIFO. Batch biasa lama yang belum mulai dibatalkan lewat generation
  guard ketika giliran urgent masuk. Metadata immediate-danger per bubble dan
  hasil boundary `urgent` bertahan sampai handler, sehingga merge teks tidak
  dapat menghapus kewajiban triage/review akhir.
- Balasan memakai shared `ResponsePresentationPlan` yang sama dengan WhatsApp,
  tanpa aturan maksimal tiga bubble. Beat/follow-up pendek boleh terpisah;
  penjelasan terstruktur dan blok kode tetap koheren. Anti-spam delapan segmen
  hanya guard ekstrem, lalu hard splitter 4.000 karakter menjaga semua code
  point. Setiap bubble dan jedanya interruptible; history hanya mencatat bubble
  yang benar-benar terkirim.
- Receipt task/reminder/session/check-in/preference privat memakai presenter
  model bersama WhatsApp. Model hanya menulis satu acknowledgment dan boleh
  memilih satu next-step allowlisted; daftar/status/waktu/ID/tombol tetap
  dirender kode, dengan fallback deterministik berdeadline tiga detik. Summary
  dan memori durable tidak dikirim ke call presentasi tambahan. Pertanyaan
  check-in proaktif juga dinamis, tetapi sengaja tidak menerima goal atau
  riwayat agar preview notifikasi tidak membocorkan topik sesi.
- Work yang melewati grace period memakai satu transient progress message.
  Surface yang sama diedit hanya dari activity event backend nyata, dihapus
  sebelum jawaban pertama, dan gagal secara kosmetik. Jawaban cepat serta fase
  listening tidak menampilkan status. Note utamanya kini direalisasikan dari
  `publicFocus` semantic yang dibentuk oleh understanding pass yang sudah ada,
  tetapi baru dibawa ke surface setelah triase final biasa. Nilainya
  tervalidasi/bounded dan phrase generik hanya fallback; copy tidak membawa
  model, effort, chain-of-thought, raw input, credential, atau istilah internal.
- Route privat mencakup percakapan, action offer, task, session, data control,
  memory, safety, serta Agent Runtime. Waktu berdiri sendiri tanpa episode
  hangat memakai fast path tanpa boundary/understanding/triage model.
- Understanding pass yang sama kini dapat mengusulkan `SemanticOperation`
  closed-set untuk account/menu/task/memory/session/data. Proposal ini tidak
  membawa authority: adapter memeriksa evidence dari raw turn, explicitness,
  subject, confidence, owner/scope, confirmation, dan policy effect. Exact
  command tetap deterministic. Natural usage dan follow-up seperti `detailnya`
  memakai renderer account yang membaca state terbaru, bukan phrase list atau
  snapshot saldo lama.
- Cold smalltalk dan reminder tanpa isi tidak lagi dijawab tabel regex statis;
  keduanya memakai understanding/reply model. Planning durable juga tidak lagi
  dipaksa dari kata seperti `rencana` atau `langkah`: adapter hanya menerima
  `RoutingAssessment.planningRequired` yang tepercaya dan nonmekanis.
- Surface yang berhasil terkirim mencatat maksimal tiga referen interaksi
  content-free selama sepuluh menit, terisolasi per owner+channel+conversation.
  State ini hanya membantu anaphora, hilang saat restart, dan tidak masuk
  history/memory; withdrawal atau full deletion juga membersihkan scope-nya.
  `/menu` category-based, `/bantuan` tetap panduan yang berbeda, dan keduanya
  beserta native command registration berasal dari satu katalog user-facing
  yang difilter menurut composition aktif.
- Permintaan planning eksplisit memakai tiga lane: chat tetap diproses
  `MessageBatcher`, quote/target run masuk RunMailbox, dan work lane active
  AgentRun berjalan di latar. Satu Run Anchor editable menampilkan state nyata.
  Correction menaikkan revision dan menahan hasil lama; jawaban wajib terikat
  ke anchor/question+watermark. Shutdown mem-pause, startup melanjutkan, dan
  delivery ambigu tidak di-retry otomatis.
- Bila coding runtime melewati startup recovery+conformance, command
  `/project`, `/code`, `/code_status`, dan `/code_cancel` tersedia. Actor
  Workspace diterbitkan dari `from.id`+interaction tepercaya, bukan command atau
  model. Upload ZIP, select project, run background, correction/cancel, dan Run
  Anchor mutable dirangkai; pertanyaan `waiting_input` tampil dari state durable
  dan hanya reply anchor yang menjadi revision. Chat biasa tetap responsif pada
  lane lama.
- Bila GitHub broker juga aktif, `/github` memakai browser GitHub App
  installation/selection tanpa PAT chat. `/publish` hanya menyiapkan effect
  exact dan confirmation workspace-private per tahap branch/push/draft PR;
  callback lama atau commit/ACL yang berubah ditolak.
- Model mengusulkan action dari allowlist; kode tetap menguasai callback,
  ownership, expiry, dan batas pilihan.
- Free-text memakai satu `turnId` dari boundary sampai handler terminal.
  Telemetry content-free memisahkan waktu batch, FIFO, handler, total, jumlah
  model per purpose, fallback safety, dan outcome completed/failed/cancelled.
  Delivery pertama dan final juga mengisi TTFR/time-to-final content-free.

## Batas dan defect aktif

- Current build policy auto-memory versi 8 diuji melalui akun tester nyata.
  Focus memori lulus 3/3: onboarding/menu mengungkap penyimpanan otomatis,
  preferensi cara belajar implicit disimpan tanpa consent atau tombol per-item
  dan ditemukan kembali lewat `/memori`, lalu cleanup; runtime shutdown bersih
  dan receipt tetap content-free.
- Baseline full 8/8 masih berasal dari build tepat sebelum perubahan authority
  memori. Rerun full current build 23 Agustus 2026 melewati onboarding/menu dan
  task/reminder, lalu timeout pada rangkaian timezone+sesi+check-in. Stage memori
  sesudah timeout sempat menangkap respons tertunda yang salah; harness kemudian
  diperbaiki memakai predicate acknowledgement yang sama dengan produk dan
  focus terisolasi di atas lulus. Planning serta stage setelahnya pada run full
  itu bukan bukti current build dan masih perlu diulang. Acceptance juga belum
  menunggu reminder/check-in proaktif benar-benar jatuh tempo, sehingga copy
  notifikasi dinamisnya masih baru dibuktikan otomatis.
- Latest build sudah mencapai `application_ready` dengan polling Telegram aktif
  setelah recovery, lalu berhenti melalui IPC dengan `shutdown_completed` dan
  lock terlepas. Preflight Bot API `getMe` juga berhasil. Ini membuktikan
  credential/transport dan lifecycle startup, bukan percakapan user→Harvy.
- Runtime hanya chat pribadi; Telegram grup belum menjadi surface produk.
- Antrean percakapan dan pesan pra-consent masih in-memory. Crash atau force
  stop dapat kehilangan giliran chat yang belum selesai. Active work
  `orchestrate` tahan restart lokal, tetapi query agent `tools` masih sinkron.
- Transient interaction context juga sengaja process-local; follow-up setelah
  restart atau lewat TTL dapat meminta pengguna menyebut surface lagi.
- `AbortSignal` sudah mencapai model dan AgentHarness percakapan, tetapi
  cancellation provider/socket live serta efek eksternal yang telanjur mulai
  belum diuji end-to-end; pre-send/current-generation guard tetap pertahanan
  terakhir.
- Emergency preflight closed-set Telegram belum mencakup command/callback dan
  bukan pengganti triase; false negative tetap mungkin. WhatsApp grup memakai
  matcher yang sama melalui jalur terpisah ADR-024.
- Baseline full sebelumnya sudah membuktikan onboarding multi-bubble, tombol
  sesi, task/reminder, safety route, ekspor, serta topologi Run Anchor; focus
  current build membuktikan auto-memory implicit beserta recall tanpa consent
  kedua.
  Adaptive timing pada rangkaian bubble bebas, interruption/correction saat
  provider aktif, reconnect transport, dan kualitas penggunaan harian masih
  baru teruji otomatis atau belum masuk baseline live.
- Metrik turn mempunyai TTFR dan final terpisah untuk delivery yang
  diinstrumentasi, tetapi coverage command/callback/durable run serta dashboard
  agregat belum lengkap dan belum dikalibrasi live.
- Private coding/GitHub surface baru dibuktikan otomatis. Sandbox Linux,
  provider exact, GitHub App remote, Telegram upload/callback, dan draft PR
  belum diuji end-to-end live pada deployment ini; runtime tetap default-off.
- Work lane baru satu foreground dan belum mempunyai job queue kedua,
  replacement policy, archive Anchor, storage multi-instance, atau receipt
  selain outbound Telegram.
- Latest build kini mempunyai bukti baseline live untuk operasi Indonesia yang
  dipakai acceptance. Kualitas `SemanticOperation` lintas bahasa dan parafrasa
  luas tetap baru dibuktikan schema/policy, fixture, serta eval provider.

## Bukti dan pointer

- Kode: `src/bot/`, `src/ai/conversation.ts`, `src/app.ts`,
  `src/operations/live-acceptance.ts`, dan
  `scripts/telegram-private-live-acceptance.ts`.
- Tes: `tests/create-bot.test.ts`, `tests/conversation.test.ts`,
  `tests/message-batcher.test.ts`, `tests/create-bot-flow.test.ts`,
  `tests/turn-taking-policy.test.ts`, `tests/conversation-progress.test.ts`,
  `tests/response-presentation.test.ts`, `tests/onboarding.test.ts`, dan
  `tests/private-coding-application-e2e.test.ts`, serta
  `tests/live-acceptance.test.ts` untuk boundary vault/runtime (bukan bukti
  transport live).
- Keputusan: ADR-002, ADR-004, ADR-007, ADR-008, ADR-021, ADR-023, ADR-027,
  ADR-044.
