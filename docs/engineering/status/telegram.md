# Status — Telegram Privat

Refreshed: 22 Agustus 2026 pada orchestration percakapan semantic-first dan
interruptible. Angka gerbang penuh terbaru dicatat di `docs/LOG.md`; bukti
Telegram live belum diperbarui.

## Keadaan saat ini

- Surface utama adalah chat pribadi Telegram dengan percakapan biasa dan
  tombol; `/start`, `/tugas`, dan `/bantuan` hanya pelengkap.
- Onboarding menahan pesan pertama sampai consent, mempertahankan urutan bubble,
  dan menyediakan jalur safety tanpa consent. Bubble setelah pesan pertama
  tidak dikirim ke model atau dinilai safety sebelum consent. Setelah consent,
  batas bubble yang ditahan dipertahankan dan matcher lokal menilai tiap bagian.
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
- Work yang melewati grace period memakai satu transient progress message.
  Surface yang sama diedit hanya dari activity event backend nyata, dihapus
  sebelum jawaban pertama, dan gagal secara kosmetik. Jawaban cepat serta fase
  listening tidak menampilkan status; copy tidak membawa model, effort,
  chain-of-thought, raw input, atau istilah internal.
- Route privat mencakup percakapan, action offer, task, session, data control,
  memory, safety, serta Agent Runtime. Waktu berdiri sendiri tanpa episode
  hangat memakai fast path tanpa boundary/understanding/triage model.
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

- Perbaikan batching, naturalness, waktu, onboarding, tombol, preference, dan
  Agent Runtime terbaru belum diuji ulang end-to-end lewat Telegram.
- Runtime hanya chat pribadi; Telegram grup belum menjadi surface produk.
- Antrean percakapan dan pesan pra-consent masih in-memory. Crash atau force
  stop dapat kehilangan giliran chat yang belum selesai. Active work
  `orchestrate` tahan restart lokal, tetapi query agent `tools` masih sinkron.
- `AbortSignal` sudah mencapai model dan AgentHarness percakapan, tetapi
  cancellation provider/socket live serta efek eksternal yang telanjur mulai
  belum diuji end-to-end; pre-send/current-generation guard tetap pertahanan
  terakhir.
- Emergency preflight closed-set Telegram belum mencakup command/callback dan
  bukan pengganti triase; false negative tetap mungkin. WhatsApp grup memakai
  matcher yang sama melalui jalur terpisah ADR-024.
- Adaptive profile, semantic boundary, progress, shared presentation, dan
  interruption baru teruji otomatis; kualitas timing/status/bubble aktual
  belum diuji end-to-end lewat Telegram.
- Metrik turn mempunyai TTFR dan final terpisah untuk delivery yang
  diinstrumentasi, tetapi coverage command/callback/durable run serta dashboard
  agregat belum lengkap dan belum dikalibrasi live.
- Private coding/GitHub surface baru dibuktikan otomatis. Sandbox Linux,
  provider exact, GitHub App remote, Telegram upload/callback, dan draft PR
  belum diuji end-to-end live pada deployment ini; runtime tetap default-off.
- Work lane baru satu foreground dan belum mempunyai job queue kedua,
  replacement policy, pin/archive Anchor, storage multi-instance, atau receipt
  selain outbound Telegram.
- Ada bukti live lama untuk onboarding/task/tombol dasar, tetapi bukti lama
  tidak membuktikan build terbaru.

## Bukti dan pointer

- Kode: `src/bot/`, `src/ai/conversation.ts`, `src/app.ts`.
- Tes: `tests/create-bot.test.ts`, `tests/conversation.test.ts`,
  `tests/message-batcher.test.ts`, `tests/create-bot-flow.test.ts`,
  `tests/turn-taking-policy.test.ts`, `tests/conversation-progress.test.ts`,
  `tests/response-presentation.test.ts`, `tests/onboarding.test.ts`, dan
  `tests/private-coding-application-e2e.test.ts`.
- Keputusan: ADR-002, ADR-004, ADR-007, ADR-008, ADR-021, ADR-023, ADR-027.
