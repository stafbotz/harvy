# Status — Telegram Privat

Refreshed: 25 Agustus 2026 pada full exploratory v3, reminder relatif,
commit-first task receipt, dan crash/restart privat. Angka gerbang penuh
terbaru dicatat di `docs/LOG.md`;
dogfood tujuh hari dan coding/GitHub live belum selesai.

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
- Bot Telegram utama tidak lagi bergantung pada plaintext
  `TELEGRAM_BOT_TOKEN` di `.env`. Console memverifikasi dan menyimpan token pada
  store AES-GCM lokal; bootstrap membaca store itu secara sinkron, sumber
  environment hanya jalur migrasi legacy, dan konflik dua sumber gagal
  tertutup. Token acceptance tetap berada pada store terpisah dan tidak boleh
  sama dengan bot utama.
- Onboarding menahan pesan pertama sampai consent, mempertahankan urutan bubble,
  dan menyediakan jalur safety tanpa consent. Bubble setelah pesan pertama
  tidak dikirim ke model atau dinilai safety sebelum consent. Setelah consent,
  batas bubble yang ditahan dipertahankan dan matcher lokal menilai tiap bagian.
- Consent onboarding versi 10 mengotorisasi auto-memory ordinary maupun personal
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
  current intent `request` dengan `RoutingAssessment.planningRequired`
  tepercaya, nonmekanis, `executionSize medium|heavy`, dan `toolNeed
  execution|external`. `toolNeed:none` atau `internal_state` dari model tidak
  memberi authority untuk membuka AgentRun.
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

- Exploratory current-build 26 Agustus benar-benar dijalankan dari akun
  Telegram tester dan pesan berikutnya dipilih dari respons Harvy, bukan dari
  expected transcript. Perjalanan menyelesaikan tugas format evaluasi nyata,
  mengganti topik, meminta usage secara eksplisit, kembali ke konteks lama, dan
  memberi koreksi. Run awal menemukan chat-only analysis salah membuka
  AgentRun, kandidat hypothetical/current-work, klaim record/delete tanpa
  receipt, `/memori` yang mencampur history, penutup generik, serta satu aksara
  asing dan typo. Setelah perbaikan, focused rerun tidak membuka AgentRun untuk
  chat tanpa tool, tidak menampilkan usage kecuali diminta, mempertahankan
  konteks saat topik kembali, menjawab koreksi tanpa klaim storage, dan
  mempertahankan `/memori` empty walau history panjang. Assessment content-free
  final adalah usefulness 5, naturalness 4, initiative 4, non-repetition 5,
  UI clarity 5, context coherence 5, correction handling 5, selesai tanpa
  defect baru pada scope focused tersebut. Ini bukan bukti dogfood tujuh hari.
- Build yang diuji oleh full live acceptance pada 24 Agustus lulus 8/8 melalui
  akun tester nyata. Scope mencakup
  consent/menu, task+reminder proaktif yang benar-benar jatuh tempo,
  timezone+sesi+check-in proaktif, auto-memory+recall, planning 3/3/3 dengan
  satu Run Anchor pin/edit/unpin, safety nonkrisis, ekspor, dan cleanup; runtime
  shutdown bersih dan receipt tetap content-free. Focus memori juga lulus tiga
  run berurutan setelah satu kegagalan intermittent ditemukan dan prompt
  ekstraksi diperkuat.
- Exploratory journey bounded `tg-adaptive-20260824-a` menyelesaikan 25/25
  giliran dengan response surface, 77 surface event, satu restart, dan shutdown
  bersih. Assessment manual `completed` tetap membawa `generic-output`,
  `incomplete-work`, `wrong-route`, dan `other-observed`; ini bukan dogfood
  tujuh hari.
- Full v3 `tg-full-adaptive-20260825-a` menyelesaikan 13/13 turn dalam dua run,
  49 surface, seluruh coverage full, re-entry, satu restart, cleanup, dan
  shutdown bersih. Konteks bertahan ketika topik kembali, proses diganti, dan
  runtime direstart. Assessment `3/3/2/2/4/4/2` tetap membawa
  `generic-output`, `incomplete-work`, `irrelevant-surface`, dan
  `reminder-delivery`: Harvy beberapa kali mengakui koreksi tanpa melakukan
  perubahan serta menyimpulkan status yang belum diamati.
- Journey tersebut menemukan dua kegagalan model setelah timeout classifier
  `turn-boundary` salah membuka circuit primary bagi understanding/risk-triage.
  Timeout bounded itu sekarang tetap boleh failover untuk request-nya sendiri
  tetapi tidak membuka circuit global. Rerun akun nyata
  `tg-rerun-20260824-a` memperoleh response pada 10/10 giliran tanpa kegagalan
  yang sama.
- `/hapus-data` juga ditemukan live masuk fallback unknown dan kategori Memori
  & data tidak menampilkan kontrol penghapusan. Shortcut exact serta action menu
  kini memakai konfirmasi bertoken yang sama dan lulus rerun nyata sampai full
  deletion. Namun rerun masih menemukan output awal generik/incomplete dan
  keputusan GO beta yang tidak ditopang bukti sebelum koreksi pengguna; kualitas
  reasoning itu belum ditutup.
- Journey full v3 menemukan reminder “satu menit lagi” muncul setelah 42,735
  detik. General understanding prompt saat itu hanya membawa menit; parser,
  store, dan worker tidak membulatkan. Prompt kini membawa detik dan aturan
  durasi relatif. Focused rerun menerima reminder setelah 66,1 detik.
- Focused rerun tersebut juga menemukan Telegram dapat berkata pengingat siap
  sebelum task commit dan kemudian menghasilkan copy yang bertentangan dengan
  kartu task. Telegram kini commit task terlebih dahulu lalu meminta model
  menyuarakan receipt code-owned, sama dengan WhatsApp privat. Exact build
  `tg-task-receipt-focused-20260825-a` membuktikan live pesan pra-consent menjadi
  satu task nyata, `/tugas` membaca state yang sama, reminder muncul sekitar
  64,6 detik setelah pemrosesan pasca-consent dilanjutkan, completion tombol,
  cleanup, dan shutdown bersih tanpa defect assessment focused.
- Fault acceptance mematikan child sesudah satu `/menu`, menunggu supervisor
  menjadwalkan restart dan child attempt kedua siap, lalu akun MTProto tester
  mendapat `/menu` lagi. Satu fault, satu restart, attempt 1/2 ready, cleanup,
  dan shutdown lulus. Ini membuktikan reconnect percakapan setelah crash idle,
  bukan crash tepat pada celah send eksternal dan receipt durable.
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
- Full acceptance 24 Agustus dan full exploratory v3 membuktikan onboarding
  multi-bubble, tombol sesi, task/reminder/check-in jatuh tempo, safety route,
  ekspor, auto-memory+recall, topologi Run Anchor, burst bebas, jeda, koreksi,
  topic-return, serta re-entry proses. Interupsi tepat ketika provider masih
  aktif, reconnect transport murni, dan kualitas penggunaan harian tetap belum
  masuk baseline live.
- Metrik turn mempunyai TTFR dan final terpisah untuk delivery yang
  diinstrumentasi, tetapi coverage command/callback/durable run serta dashboard
  agregat belum lengkap dan belum dikalibrasi live.
- Private coding/GitHub surface baru dibuktikan otomatis. Provider exact sudah
  lulus smoke resmi, tetapi sandbox Linux, GitHub App remote, Telegram
  upload/callback CodingRun, dan draft PR belum diuji end-to-end live pada
  deployment ini; runtime tetap default-off.
- Input gambar sudah lulus smoke provider nyata dan tes adapter, tetapi belum
  dikirim lewat akun Telegram tester pada build ini; jangan menyebutnya live
  channel-proven.
- Work lane baru satu foreground dan belum mempunyai job queue kedua,
  replacement policy, archive Anchor, storage multi-instance, atau receipt
  selain outbound Telegram.
- Build yang menjalani focused journey 25 Agustus mempunyai bukti live untuk
  commit-first task dan reminder relatif Indonesia. Journey 26 Agustus memberi
  bukti live tambahan untuk usage natural, routing chat-vs-work, kontrol memori,
  context return, dan correction; `SemanticOperation` lintas bahasa serta
  parafrasa luas tetap belum terkalibrasi.

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
