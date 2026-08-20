# Status — Telegram Privat

Refreshed: 20 Agustus 2026 pada targeted CodingRun input/private publish. Angka gerbang
penuh terbaru dicatat di `docs/LOG.md`; bukti Telegram live belum diperbarui.

## Keadaan saat ini

- Surface utama adalah chat pribadi Telegram dengan percakapan biasa dan
  tombol; `/start`, `/tugas`, dan `/bantuan` hanya pelengkap.
- Onboarding menahan pesan pertama sampai consent, mempertahankan urutan bubble,
  dan menyediakan jalur safety tanpa consent. Bubble setelah pesan pertama
  tidak dikirim ke model atau dinilai safety sebelum consent. Setelah consent,
  batas bubble yang ditahan dipertahankan dan matcher lokal menilai tiap bagian.
- Ingress pesan nonblocking memakai boundary local-first untuk satu bubble
  jelas dan model fallback untuk ambiguitas. Settle awal memakai fallback 650
  ms lalu p90 gap antar-arrival content-free per pemilik setelah tiga sampel,
  termasuk lintas batch yang sudah ter-flush; state RAM berbatas/ber-TTL.
  Jendela semantik open/incomplete tetap 7/12 detik.
  Command/callback diserialkan per owner.
- Emergency preflight lokal berpresisi tinggi dapat mengirim ACK sebelum
  debounce; full triage, review sesuai policy, handler, dan mutasi tetap memakai
  pipeline/FIFO. Batch biasa lama yang belum mulai dibatalkan lewat generation
  guard ketika giliran urgent masuk. Metadata immediate-danger per bubble dan
  hasil boundary `urgent` bertahan sampai handler, sehingga merge teks tidak
  dapat menghapus kewajiban triage/review akhir.
- Balasan dibagi maksimal tiga bubble, teks Telegram dinormalisasi, dan blok
  kode dipertahankan bila muat.
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
- Request model biasa yang aktif belum mempunyai cancellation kooperatif penuh.
- Emergency preflight closed-set Telegram belum mencakup command/callback dan
  bukan pengganti triase; false negative tetap mungkin. WhatsApp grup memakai
  matcher yang sama melalui jalur terpisah ADR-024.
- Adaptive profile baru teruji otomatis; kualitas split bubble dan latency
  aktual belum diuji end-to-end lewat Telegram.
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
  `tests/onboarding.test.ts`, dan
  `tests/private-coding-application-e2e.test.ts`.
- Keputusan: ADR-002, ADR-004, ADR-007, ADR-008, ADR-021, ADR-023, ADR-027.
