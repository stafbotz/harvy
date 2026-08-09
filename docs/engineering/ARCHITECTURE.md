# Arsitektur Harvy

Dokumen ini menjelaskan arsitektur modul Harvy secara lengkap. Baca ketika
melakukan refactor besar, menambah modul baru, atau perlu memahami aliran
data antar-komponen.

Ringkasan satu baris: **aliran satu arah — adapter Telegram → layanan → port
penyimpanan.** Logika inti tidak mengenal grammY maupun berkas.

---

## Composition root

- `src/app.ts` — satu-satunya composition root. Merangkai `loadConfig` →
  repository tugas/memori/riwayat/profil/insight/sesi/telemetry/agent-run →
  layanan inti dan `DataControlService` → `createBot` → worker pengingat,
  check-in, dan retensi checkpoint agent,
  meneruskan tombstone penghapusan sebelum bot menerima update, mendaftarkan
  command Telegram, dan menangani shutdown.

## Domain

- `src/domain/` — bentuk data sekaligus port penyimpanan: `task.ts`
  (`StudentTask`, `TaskRepository`), `memory.ts` (`MemoryItem`,
  `MemoryRepository`), `history.ts` (`ConversationHistory`,
  `HistoryRepository`), `profile.ts` (`UserProfile`, `ProfileRepository` —
  status kenalan, versi persetujuan, preferensi gaya/waktu, dan tombstone),
  `insight.ts` (satu-satunya catatan tersembunyi), `session.ts` (sesi aktif dan
  check-in), `agent-run.ts` (record `waiting_input` dan port CAS), serta
  `telemetry.ts` (schema event tertutup tanpa isi percakapan).
  Inti bergantung pada antarmuka ini, bukan pada penyimpanan.

## Core

- `src/core/` — bebas I/O dan bebas Telegram: `prioritizer.ts` (skor prioritas
  murni), `task-service.ts`, `memory-policy.ts` (jenis sensitif, masa berlaku,
  pemilihan memori untuk prompt), `memory-service.ts`, `history-policy.ts`
  (jendela dan ambang pemadatan), `history-service.ts`, `profile-service.ts`
  (`CONSENT_VERSION`, `needsOnboarding`, `shouldAskStyle`),
  `safety-policy.ts` (`RiskHint`, `RiskDisposition`, sinyal immediate-danger,
  routing selektif, permission per efek, conditional reply review, dan
  `shouldRaiseProfessionalHelp`), `insight-service.ts`
  (catatan tersembunyi dan
  riwayat giliran berisiko), `action-policy.ts` (allowlist tindakan adaptif),
  `session-policy.ts` (hubungan sesi lunak dan izin sinyal destruktif),
  `time-policy.ts` (zona waktu dan jam tenang), `session-service.ts` (satu sesi
  persisten dan check-in satu kali), `telemetry-service.ts` (reservasi kuota,
  antrean tulis latar, biaya, retensi, drain, dan generation guard),
  `agent-run-service.ts` (validasi/claim/CAS, block saat penghapusan, ekspor,
  expiry absolut, dan lifecycle checkpoint klarifikasi),
  `data-control-service.ts` (ekspor,
  tombstone, dan penghapusan lintas store), serta
  `adaptive-debounce-policy.ts` (p90 gap content-free per subjek, TTL, dan LRU),
  `turn-taking-policy.ts` (closed set boundary lokal, koreksi bentuk, serta
  jendela state-aware 4/7/12 detik). Policy emergency dan policy bentuk giliran
  sengaja terpisah; disposition keselamatan tetap milik triase risiko.
  `HistoryService` menerima fungsi peringkas episode dari luar supaya `core/`
  tetap bebas jaringan. `episodic-compaction.ts` membuat provenance/hash,
  retensi, dan rendering context v2 tanpa merangkum ulang episode lama;
  compaction membatasi satu request lalu mengejar backlog antar-slot.
  Core grup berada di `group-memory-service.ts` dan `group-turn-service.ts`:
  binding akun, statistik sosial berjendela, konteks pendek beridentitas, FIFO
  per grup, notice, kontrol dua langkah, planner nimbrung, triase/review,
  fixed acknowledgment bahaya di luar FIFO, full-turn chain lintas speaker,
  penanda risiko minimal, generation/abort guard removal atau revocation,
  authorized-observation chain per runtime, hidrasi alias sebelum admission,
  settled-observation watermark, revalidasi mode efektif sebelum pending/model/
  delivery, matriks authority member/admin, dan shared room memory eksplisit
  dengan preview+konfirmasi admin. Ia tidak menerima dependency memori/profil/
  sesi pribadi.

## AI

- `src/ai/` — lapisan Harvy di atas model: `persona.ts` (kepribadian, batas
  moral, aturan keselamatan), `model-policy.ts` (memilih tingkatan model dari
  kesulitan), `model-profile.ts` (capability exact provider+model),
  `provider-adapter.ts` (allowlist message dan reasoning wire per provider),
  `understand.ts` (membaca balasan model sebagai masukan tidak tepercaya),
  `client.ts` (HTTP kompatibel OpenAI dengan rotasi kunci, execution-plan
  validation, dan boundary native `tools`/`tool_choice`),
  `key-pool.ts`, `identity.ts` (jawaban produk "model Capybara"),
  `group-conversation.ts` (planner dan balasan grup), `episode-summary.ts`
  (prompt/parser compaction v2), `context.ts`
  (`HarvyContext`: ringkasan, giliran terakhir, dan
  memori), `safety.ts` (acute-risk triage, disposition resolution, arahan
  anti-penolakan, dan pemeriksaan balasan), `memory-privacy.ts` (classifier
  sensitivitas candidate-only), `group-ingress.ts` (risk hint dan privacy raw
  context grup), dan `conversation.ts` (menyatukan pemahaman, balasan,
  peringkasan episode, dan Agent Runtime).
  Pada free-text Telegram privat pasca-consent, pure policy immediate-danger
  berjalan saat ingress sebelum debounce dan hanya dapat mempercepat ACK.
  Sesudah settle, closed set lokal memutus satu bubble yang jelas sebagai
  `complete`/`incomplete`; model `cheap` hanya menjadi fallback
  `complete|open|incomplete|urgent` untuk jalur boundary yang ambigu. Giliran
  Metadata immediate-danger per bubble dan hasil boundary `urgent` bertahan
  sampai handler. Sebelum consent hanya pesan pertama boleh dinilai; batas
  bubble lain dipertahankan dan baru diperiksa per bagian setelah consent.
  Giliran yang sudah utuh menjalankan compiler `cheap`; hanya RiskHint
  `possible|strong` atau kegagalan compiler yang memanggil acute triage.
  Emergency lokal langsung mentriase tanpa compiler. Privacy memory hanya
  dinilai ketika ada kandidat, dan support pasti tidak rutin direview; danger
  serta support belum pasti tetap fail-closed. Ekstraksi tidak pernah membayar
  harga model besar, sementara tutor memakai `ambitious` hanya pada giliran
  tenang. Grup memakai kontrak selektif yang sama setelah authority, binding,
  dan notice live: direct memakai compiler ingress, ambient menggabungkannya
  dengan planner, raw-context privacy dan durable-memory privacy tetap terpisah,
  serta emergency lokal dapat melewati debounce dan memulai acute triage tanpa
  compiler umum tanpa memberi authority mutasi.

## Harness

- `src/harness/` — kontrak agent channel-neutral: `scope.ts` membentuk ruang
  privat, grup+anggota, dan Workspace tanpa delimiter collision; Workspace
  membawa membership/role/permission/ACL epoch dan hanya dipercaya setelah
  authority resolver. `capabilities.ts`
  menghasilkan snapshot kemampuan ter-hash sesuai adapter yang benar-benar
  aktif; `context-budget.ts` membatasi perhatian prompt; dan
  `agent-harness.ts` menyediakan loop plan/action/observation berbatas,
  checkpoint pause/resume, approval binding, idempotency key, cancellation,
  cycle guard, generation guard, deadline aktif per invocation, horizon resume
  absolut, serta irisan capability available dengan executor callable.
  Executor dapat membawa nama, deskripsi, dan JSON Schema native yang
  dibekukan bersama irisan callable; hash checkpoint mengikat metadata itu
  agar kontrak provider tidak berubah saat resume. Native call tetap proposal
  yang dinormalisasi menjadi `final|need_input|action`; kernel
  memvalidasi capability dan input sebelum eksekusi. Checkpoint juga membekukan
  batas langkah. `conversation.ts` memegang transcript provider hanya selama
  satu invocation: exact assistant turn diteruskan dengan pesan `tool` dan
  `tool_call_id` yang cocok. Profile explicit mengizinkan replay berbatas untuk
  `reasoning`, `reasoning_content`, `reasoning_details`, sedangkan thought
  signature Gemini tetap dipertahankan; semuanya terikat provider+model dan
  tidak masuk log. Transcript ini dibuang saat invocation berakhir; checkpoint tetap
  provider-neutral dan resume membangun transcript baru dari state tepercaya.
  Untuk klarifikasi, checkpoint memasangkan prompt `need_input` dengan jawaban
  pengguna sehingga jawaban pendek tetap mempunyai referen tanpa menyimpan
  call ID atau metadata provider.
  `src/core/execution-policy.ts` memisahkan role, work class, requested/effective
  reasoning effort, verbosity metadata, deadline, output ceiling, serta izin
  tool/delegasi dari tier/model routing lama. Seluruh call production membawa
  plan, tetapi cumulative RunBudget dan context-pressure compaction belum ada.
  Kernel
  dipakai Agent Runtime read-only; kernel tetap stateless,
  sedangkan adapter Telegram dapat mempersistenkan hanya status
  `waiting_input`. Run aktif masih sinkron dan workflow mutasi tugas/memori/
  sesi tetap deterministik.
  Workspace surface belum dipasang.

## Agent

- `src/agent/` — executor Agent Runtime privat sekaligus pemilik definisi
  native function-nya: baca tugas/sesi/waktu/agenda internal, fast path jam
  deterministik, terminal virtual in-memory tanpa
  shell/host/network, serta delegasi satu tingkat maksimal tiga worker
  `cheap|efficient`. Worker tidak menerima tool, memori, atau hak delegasi;
  hanya root `ambitious` pada giliran kompleks yang dapat melakukan fan-out.
  `agent-run-retention-worker.ts` menghapus checkpoint kedaluwarsa berkala dan
  dapat dihentikan/drain saat shutdown.

## Bot (Telegram)

- `src/bot/` — adapter grammY: `create-bot.ts` memasang guard chat pribadi,
  gerbang perkenalan, kontrol data/waktu, alur sesi, dan tombol;
  `message-batcher.ts` menggabungkan bubble serta menyediakan antrean idle bagi
  worker; `onboarding.ts` memuat naskah kenalan, arahan keselamatan
  pra-persetujuan, dan `HeldMessageStore`; `action-offers.ts` menyimpan tawaran
  adaptif bertoken; `phrasing.ts` menyimpan beberapa bentuk untuk tiap kalimat
  tetap Harvy; `messages.ts` memformat keluaran, memecah balasan menjadi bubble,
  serta menyusun keyboard; `understanding-route.ts` memeriksa pasangan
  intent/action sebelum adapter mengubah data; `fast-path-policy.ts` membatasi
  acknowledgment dingin dan jawaban pending yang boleh melewati compiler;
  `pending.ts` menyimpan satu langkah sementara yang sedang menunggu jawaban.
  Sebagian besar pending tetap
  ephemeral; hanya `agent-input` yang menjadi mirror record durable dan
  dipulihkan di dalam chain owner.

## Storage

- `src/storage/` — adapter berkas JSON aktif dengan pola yang sama: tulis atomik
  melalui berkas `.tmp` lalu `rename`, dan serialisasi tulis melalui antrian
  promise agar tidak ada pembaruan yang hilang. `file-task-repository.ts`,
  `file-history-repository.ts`, `file-profile-repository.ts`,
  `file-session-repository.ts`, dan `file-telemetry-repository.ts`. Memori dan
  catatan tersembunyi memakai bentuk lain: `markdown-memory-repository.ts` dan
  `markdown-insight-repository.ts` menulis satu folder Markdown per pengguna di
  bawah `MEMORY_FOLDER`. `file-memory-repository.ts` hanya sumber impor sekali
  jalan. `file-group-repository.ts` menyimpan binding akun, memori sosial grup,
  member-local memory, dan shared room memory yang terpisah per scope; reset
  state bersama tersedia atomik. `file-workspace-repository.ts` menyimpan
  authority state Workspace dengan CAS `aclEpoch`. Keduanya aman hanya untuk
  satu proses saja. `file-agent-run-repository.ts` menyimpan satu
  `waiting_input` per scope dengan revision CAS, validasi codec checkpoint,
  queue statik per path, expiry, dan pembuangan `.tmp` yatim; ia juga hanya
  menjamin restart lokal satu proses, bukan durability multi-instance.

## WhatsApp

- `src/whatsapp/` — adapter grup WhatsApp beta berbasis `baileys@7.0.0-rc14`.
  `baileys-account-manager.ts` menjalankan satu auth namespace/socket/reconnect
  supervisor per `accountId`; `baileys-message-normalizer.ts` mempertahankan
  participant PN/LID, tag, quote, dan timestamp;
  `group-message-batcher.ts` menggabungkan burst satu anggota tanpa membuang ID
  bubble; `config.ts` memvalidasi registry banyak nomor. Auth multi-file hanya
  untuk pengembangan lokal, bukan penyimpanan produksi.

## Observability

- `src/observability/` — logger operasional NDJSON terstruktur yang terpisah
  dari telemetry pengguna: allowlist scalar/redaksi, schema, trace
  `AsyncLocalStorage`, antrean dan file mutex berbatas, rotasi/retensi, repair
  tail crash, backpressure console, process diagnostics, serta adapter logger
  Baileys. QR dan pairing code memakai keluaran operator khusus yang tidak
  persisten dan dilarang pada production/non-TTY.

## Reminders

- `src/reminders/` — worker pengingat tugas dan check-in memakai `setInterval`
  dengan penjaga reentrancy, menunggu owner idle, dan menghormati jam tenang.
  Check-in satu kali memakai transaksi kirim-lalu-tandai. Keduanya masih
  mempunyai jendela at-least-once bila proses mati setelah Telegram menerima
  pesan tetapi sebelum status tersimpan.

---

## Pola menambah perilaku

Menambah perilaku pribadi biasanya menyentuh, berurutan: tipe di `domain/`, port
repository bila datanya baru, logika dan tes di `core/`, adapter di
`bot/create-bot.ts`, lalu teks di `bot/messages.ts`. Perilaku grup harus masuk
core grup dan adapter kanalnya sendiri; jangan memperluas state grammY pribadi.

## Aturan modul

- Proyek ini ESM dengan `module: NodeNext`. Impor antarmodul wajib berakhiran
  `.js` meskipun sumbernya `.ts`.
- `tsconfig.json` memakai `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, dan `noUnusedLocals`. Indeks array menghasilkan
  tipe opsional, dan impor atau fungsi lokal yang tidak pernah dipakai
  menggagalkan `npm run check` alih-alih diam-diam lolos.
- `include` mencakup `src/`, `tests/`, **dan** `scripts/`. Skrip diagnostik ikut
  diperiksa tipe dan ikut dibangun ke `dist/scripts/`; ia tidak ikut dijalankan
  `npm test`, karena glob tesnya hanya `dist/tests/*.test.js`.
- Di adapter Telegram, chat non-pribadi masih hanya menjawab perintah dan
  mengabaikan pesan lain; pesan bebas tetap khusus chat pribadi. Grup WhatsApp
  tidak melewati adapter grammY itu—ia memakai pipeline grup tersendiri.
