# Arsitektur Harvy

Dokumen ini menjelaskan arsitektur modul Harvy secara lengkap. Baca ketika
melakukan refactor besar, menambah modul baru, atau perlu memahami aliran
data antar-komponen.

Ringkasan jalur percakapan: **aliran satu arah — adapter Telegram → layanan →
port penyimpanan.** Logika percakapan inti tidak mengenal grammY maupun berkas;
ProjectWorkspace menjadi boundary filesystem terkelola yang eksplisit.

---

## Composition root

- `src/app.ts` — satu-satunya composition root. Merangkai `loadConfig` →
  repository tugas/memori/riwayat/profil/insight/sesi/telemetry/agent-run →
  layanan inti dan `DataControlService` → `createBot` → worker pengingat,
  check-in, dan retensi record agent, memulai recovery active AgentRun sesudah
  polling siap,
  meneruskan tombstone penghapusan sebelum bot menerima update, mendaftarkan
  command Telegram, serta menangani shutdown. Saat flag GroupAgentRun aktif,
  composition yang sama merutekan observation grup authorized sebelum batching
  ke controller, executor/processor, worker, delivery Baileys fenced, recovery,
  dan drain. Saat `HARVY_CODING_RUNTIME_ENABLED=true`, root yang sama merangkai
  Workspace authority, project/run/evidence store, AI coding writer, validator,
  sandbox/local-git trust-domain client, optional GitHub App broker, private
  Telegram controllers, group-coding ingress, recovery supervisor, dan
  shutdown fence. Runtime tetap gagal tertutup sebelum receipt conformance
  sandbox exact dan health identity cocok; semua flag default-off.

## Domain

- `src/domain/` — bentuk data sekaligus port penyimpanan: `task.ts`
  (`StudentTask`, `TaskRepository`), `memory.ts` (`MemoryItem`,
  `MemoryRepository`), `memory-knowledge.ts` (`SemanticMemory`, evidence,
  suppression, temporal entity/relation, namespace, repository CAS, dan port
  embedding), `history.ts` (`ConversationHistory`,
  `HistoryRepository`), `profile.ts` (`UserProfile`, `ProfileRepository` —
  status kenalan, versi persetujuan, preferensi gaya/waktu, dan tombstone),
  `insight.ts` (satu-satunya catatan tersembunyi), `session.ts` (sesi aktif dan
  check-in), `agent-run.ts` (checkpoint `waiting_input` v1, active run v2,
  snapshot konteks, mailbox/ChangeSet/work unit/event/receipt, dan port CAS), serta
  `telemetry.ts` (schema event tertutup tanpa isi percakapan).
  `project-workspace.ts`, `project-deletion.ts`, `project-transfer.ts`, `sandbox.ts`, `coding-run.ts`,
  `local-git.ts`, dan
  `github.ts` menambah snapshot/revision project, runner binding+quota, coding
  evidence/commit barrier, local effect reconciliation, descriptor object
  bundle Git content-addressed, serta GitHub exact-effect ports tanpa
  credential atau host path.
  Inti bergantung pada antarmuka ini, bukan pada penyimpanan.

## Core

- `src/core/` — bebas Telegram. Layanan percakapan mengikuti port I/O, sedangkan
  ProjectWorkspace/safe-ZIP secara eksplisit mengelola filesystem terkelola
  yang terpisah dari root aplikasi, bukan boundary isolasi:
  `prioritizer.ts` (skor prioritas
  murni), `task-service.ts`, `memory-policy.ts` (jenis sensitif, hard exclusion
  credential, masa berlaku, pemilihan memori untuk prompt),
  `memory-explicit-consent.ts` (bukti lokal item-scoped untuk perintah remember),
  `memory-service.ts`, `history-policy.ts`
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
  expiry absolut, active revision/freshness gate, commit barrier, receipt,
  recovery, dan lifecycle checkpoint klarifikasi),
  `run-mailbox-policy.ts` (routing lokal konservatif berdasarkan quote atau
  target eksplisit),
  `project-workspace-service.ts` + `safe-zip.ts` + `project-files.ts`
  (ingestion, immutable snapshot, quota/retention), `sandbox/snapshot-bundle.ts`
  (transfer snapshot deterministik content-addressed),
  `sandbox-runner-service.ts` (policy client trust-domain fail-closed,
  request digest dan artifact-byte verification),
  `coding-run-engine.ts` + `coding-run-coordinator.ts` +
  `coding-run-scheduler.ts` (single writer, immediate bounded admission,
  durable revision reservation, provider quiescence),
  `coding-runtime-supervisor.ts` (startup maintenance berurutan dan shutdown
  caller-before-sandbox yang tetap menutup coding admission); rangkaian ini
  memiliki bounded provider/action lifecycle, map/plan/task review, ChangeSet,
  validator, serta commit recovery. `coding-runtime-composition.ts` memasang
  private/group controllers dan `group-coding-lifecycle-fence.ts` menutup
  authority revocation tanpa membentuk user scope baru.
  `project-deletion-coordinator.ts`
  (tombstone-first cleanup run, sandbox, evidence, GitHub lokal, memory, dan
  payload), `project-deletion-recovery-worker.ts` (enumerasi locator
  content-free dan cleanup scope-free satu page per siklus),
  `github-installation-service.ts` (WAL install/selection/
  provisioning), `local-git-service.ts` (commit deterministic/reconcile + object
  bundle receipt), dan `github-broker.ts` (ACL/App/ref freshness, approval,
  exact receipt, dan verified bundle streaming),
  `github-reconciliation-worker.ts` (enumerasi locator content-free dan
  observasi receipt `unknown` satu page per siklus tanpa replay efek),
  `run-budget.ts` (akun kumulatif root/retry/fallback/worker, reservation
  token+biaya, waktu aktif, dan codec checkpoint),
  `data-control-service.ts` (ekspor,
  tombstone, dan penghapusan lintas store), serta
  `adaptive-debounce-policy.ts` (p90 gap content-free per subjek, TTL, dan LRU),
  `turn-taking-policy.ts` (closed set boundary lokal, koreksi bentuk, serta
  jendela state-aware 4/7/12 detik). Policy emergency dan policy bentuk giliran
  sengaja terpisah; disposition keselamatan tetap milik triase risiko.
  `HistoryService` menerima fungsi peringkas episode dari luar supaya `core/`
  tetap bebas jaringan. `episodic-compaction.ts` membuat provenance/hash,
  hot retention, dan rendering context v2 tanpa merangkum ulang episode lama;
  `HistoryService` menulis episode ke `DurableEpisodeArchive` sebelum hot
  eviction. `history-search.ts` menjadi scorer leksikal bersama untuk candidate
  hot dan cold, mengembalikan provenance minimal, dan tidak menyentuh insight
  keselamatan. `memory-candidate.ts` melakukan derivation faktual lokal yang
  sempit; `memory-knowledge-service.ts` mengonsolidasikan semantic memory,
  contradiction/supersession, suppression, vector retrieval, dan graph temporal
  derived. `long-term-memory-service.ts` mengelola archive, typed user model,
  versioned procedure, normalized error lesson, outcome evidence, deterministic
  promotion/health, dan durable event worker dengan generation fence.
  `memory-query-plan.ts` memilih route lokal; `memory-context-compiler.ts`
  membentuk Context Pack bounded melalui hot+cold FTS, vector, graph,
  personalization, procedure, dan lesson fusion, temporal/privacy filter, serta
  manifest content-free. Compaction membatasi satu request lalu mengejar backlog
  antar-slot; learning processing tidak berada pada jalur sapaan biasa.
  Pada adapter privat, kandidat durable melewati authority/privacy lalu primary
  commit sebelum penyusunan balasan. Hanya receipt code-owned
  `saved|updated|already-known` yang masuk `replyPrompt`; model memilih wording
  kontekstual tetapi tidak menentukan apakah write terjadi. Delivery yang
  gagal sebelum acknowledgement terlihat me-rollback primary write baru;
  sesudah acknowledgement pada bubble awal benar-benar terkirim, write
  dipertahankan agar klaim user-facing tidak menjadi palsu.
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
  Fondasi Phase K terpisah berada di `group-agent-run-service.ts` dan
  `group-agent-run-policy.ts`, dengan adapter composition
  `group-agent-run-runtime.ts`: aggregate group-safe, satu foreground CAS,
  routing thread closed-set, atribusi participant, assigned input, guard
  authority commit, checkpoint/model work, dan final receipt. `app.ts`
  memasangnya sesudah observation authority dan sebelum batch chat hanya ketika
  flag eksplisit aktif; admission binding/mode/cleanup serta transport fence
  tetap diperiksa pada claim dan send.

## Trust-domain service production

- `src/sandbox-service.ts` + `src/sandbox/oci-sandbox-backend.ts` menjalankan
  project hostile pada rootless OCI Linux yang disposable. Snapshot dikirim
  sebagai bundle ke tmpfs, bukan host mount. Image, seccomp, quota, namespace,
  network-off, output/artifact, dan lifecycle adalah config/policy code-owned.
- `src/local-git-service.ts` + `src/local-git/local-git-backend.ts` memiliki
  repository/object/operation root sendiri tanpa credential remote. Ia memakai
  Git plumbing terstruktur, object verification, atomic ref CAS, dan bundle
  content-addressed.
- `src/github-broker-service.ts` + `src/github-app/` adalah trust domain
  credential-owning. App key/OAuth secret/installation token tidak masuk Harvy
  atau sandbox. Broker melakukan repository archive, exact non-force publish,
  draft PR, effect ledger, dan reconciliation di balik service-auth.
- Ketiga service dapat dideploy terpisah melalui `deploy/`. Implementasi
  tersedia tidak sama dengan live acceptance; runtime control plane hanya
  mengaktifkan coding sesudah conformance receipt exact.
- Private CodingRun menyimpan pertanyaan `waiting_input` pada record run dan
  menampilkannya lewat satu Run Anchor mutable. Reply anchor menjadi ChangeSet
  baru; traffic percakapan lain tetap pada chat lane. Publish privat bergerak
  sebagai tiga offer exact terpisah—branch, push, lalu draft PR—dan setiap
  callback membentuk confirmation grant baru sesudah authority dire-resolve.

## AI

- `src/ai/` — lapisan Harvy di atas model: `persona.ts` (kepribadian, batas
  moral, aturan keselamatan), `model-policy.ts` (memilih tingkatan model dari
  kesulitan), `model-profile.ts` (capability exact provider+model),
  `provider-adapter.ts` (allowlist message dan reasoning wire per provider),
  `understand.ts` (membaca balasan model sebagai masukan tidak tepercaya),
  `client.ts` (HTTP kompatibel OpenAI dengan rotasi kunci, execution-plan
  validation, dan boundary native `tools`/`tool_choice`),
  `key-pool.ts`, `identity.ts` (jawaban produk "model Capybara"),
  `embedding-client.ts` (adapter embedding kompatibel OpenAI yang opt-in,
  berbatas deadline/batch/schema, dan tidak menyimpan vector),
  `group-conversation.ts` (planner dan balasan grup), `episode-summary.ts`
  (prompt/parser compaction v2), `context.ts`
  (`HarvyContext`: ringkasan, giliran terakhir, primary memory, dan retrieved
  evidence terstruktur), `safety.ts` (acute-risk triage, disposition resolution, arahan
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
  `src/core/execution-policy.ts` memisahkan stage role, cognitive role, work
  class, requested/effective reasoning effort, verbosity metadata, deadline,
  output ceiling, serta izin tool/delegasi dari tier accounting dan exact model
  binding. Difficulty/stakes/uncertainty dapat menaikkan reasoning envelope
  tanpa menaikkan visible verbosity. Seluruh call production membawa plan.
  Call general yang tidak memasang ceiling sempit memperoleh emergency
  ceiling per role lalu di-clamp profile exact; mekanis tetap eksplisit kecil.
  Agent Runtime privat juga membawa satu `RunBudgetAccount` dari root ke setiap
  physical retry/fallback, executor, dan worker. Model call mereservasi
  token+biaya sebelum key/fetch; actual usage menyelesaikannya dan failure
  ambigu menahan reservation penuh. Work call tidak dapat memakai separuh
  budget yang dilindungi untuk final synthesis—48.000 pada default, maksimal
  49.152 token;
  checkpoint v2 menurunkannya kembali dari counter+policy saat resume tanpa
  menghitung jeda pengguna. Planner hanya menerima view angka informatif.
  `agent-context-pressure.ts` mengaktifkan compaction sebelum hard context
  failure hanya bila profile exact menyediakan context window. Di bawah
  threshold, continuation tetap lossless; di atasnya, transcript provider
  diputus dan dibangun ulang sebagai state provider-neutral dari request,
  context terpilih, observation, input pengguna yang diterima compiler, dan
  RunBudget view terbaru. Observation besar memakai envelope JSON head/tail
  dengan ukuran asli dan artifact reference bila tersedia. Respons typed
  `finish_reason=length` boleh mendapat satu attempt recovery tanpa delegasi,
  setelah freshness diperiksa ulang dan tetap pada akun RunBudget yang sama;
  incomplete/content-filter lain berhenti fail-closed.
  Kernel dipakai Agent Runtime read-only; kernel tetap stateless. Checkpoint
  klarifikasi sinkron v1 tetap tersedia, sedangkan permintaan `orchestrate`
  eksplisit privat Telegram memakai active AgentRun v2 di work lane. Snapshot
  konteksnya tetap provider-neutral dan mailbox baru hanya masuk lewat routing
  eksplisit. `sourceMessageId` mengikat replay idempotent; update pending dibawa
  utuh melalui input checkpoint kronologis atau ditolak sebelum revision naik
  bila envelope berbatas tidak cukup. Query mode `tools` dan workflow mutasi
  tugas/memori/sesi tetap sinkron/deterministik.
  Catalog mendefinisikan capability `workspace.*`, `sandbox.*`, `git.*`, dan
  `github.*`; semuanya unavailable kecuali executor serta surface konkret
  dipasang. Workspace surface belum dipasang.

## Economy dan funding runtime

`ControlPlaneService` tetap menjadi authority plan/version dan model price,
sedangkan `EconomyService` (`src/domain/economy.ts` dan
`src/core/economy-service.ts`) menjadi authority entitlement/funding. Jalur
logical request sekarang ialah:

```text
plan version → billing period/allowance → funding resolver
→ atomic compute reservation → AiClient/provider attempts
→ usage quote/physical ledger → delivery settlement atau release
```

`RunBudget` tidak digantikan: ia tetap membatasi satu AgentRun. Economy ledger
menyimpan fixed-point compute, reservation, settlement, wallet/payment,
sponsored grant, subscription, contribution, dan credential metadata secara
terpisah. `FileEconomyRepository` menulis state atomik/idempoten dalam satu
proses lokal; projection period/wallet/rolling dipakai pada hot path sehingga
resolver tidak menghitung ulang seluruh usage ledger. Backend ini belum
merupakan transaction store multi-node. Provider ledger tetap mencatat
physical cost dan tidak membawa isi transcript. Wallet reservation/debit,
release, dan refund ditulis sebagai record lifecycle immutable; refund yang
beradu dengan reservation aktif membatalkan funding itu agar saldo yang sudah
direfund tidak muncul kembali.

BYOK memakai `SecretStore` terenkripsi terpisah. Resolver hanya memberikan raw
secret ke provider invocation yang sudah di-reserve, dan fallback provider
Harvy dinonaktifkan untuk request BYOK kecuali policy eksplisit masa depan.
Secure setup/revoke tersedia pada API Harvy Console loopback yang
terautentikasi, ber-CSRF, dan audited; response hanya mengandung metadata
non-secret serta bentuk key tersamarkan. Subscription checkout membekukan plan-version dan action
activation/renewal, sementara active period—bukan callback order—menentukan
plan yang sedang berlaku.
Payment gateway adalah interface dengan `UnavailablePaymentGateway` default;
`LocalPaymentGateway` hanya fake test/development sampai signature webhook,
reconciliation, refund, dan secret operations production tersedia.

Dashboard percakapan `/penggunaan` memakai read model
`UserUsageSummaryService`: owner kanal diubah menjadi subject oleh economy
authority, lalu provider-attempt ledger dibaca hanya untuk period aktif dan
subject tersebut. Total biaya tetap mewakili physical provider cost, sedangkan
breakdown sumber biaya memakai delivery settlement; retry/failure internal
masuk overhead Harvy. Cache hit memakai cache-read/input yang ternormalisasi,
dan cache saving hanya dihitung dari price snapshot historis attempt. DTO
semantik kemudian dirender oleh formatter Telegram HTML, WhatsApp, atau plain;
jalur ini tidak membaca transcript dan tidak memanggil model.

## Agent

- `src/agent/` — executor Agent Runtime privat sekaligus pemilik definisi
  native function-nya: baca tugas/sesi/waktu/agenda internal, fast path jam
  deterministik, terminal virtual in-memory tanpa
  shell/host/network, serta delegasi satu tingkat maksimal tiga worker
  `cheap|efficient`. Worker tidak menerima tool, memori, atau hak delegasi;
  hanya root `ambitious` pada giliran kompleks yang dapat melakukan fan-out.
  Semaphore per-run dari RunBudget bekerja di samping semaphore provider global
  dan seluruh worker memakai object akun yang sama.
  `coding-executors.ts` membentuk executor workspace/sandbox/local-git
  berschema tertutup dan state-bound. Bundle hanya mengiklankan sandbox setelah
  health `isolated-linux` positif dan local-git setelah bounded positive health
  dari instance `LocalGitService` yang sama; GitHub tidak model-callable.
  `SandboxRunnerService` sendiri menyediakan lifecycle
  `start/stop/drain/close`: startup memulihkan journal tanpa reattach, shutdown
  menutup admission dan mem-fence seluruh lease sebelum adapter journal
  ditutup. `CodingRuntimeSupervisor` mengurutkan recovery sandbox → GitHub
  unknown initial pass → deletion initial pass dan menutup caller sebelum
  sandbox drain/close. Scheduler hanya dapat dimulai dengan conformance receipt
  deployment exact; supervisor maintenance sendiri selalu melaporkan admission
  tertutup. Keduanya belum dirangkai ke `app.ts`, sehingga tidak mengubah
  capability default-off menjadi live.
  `agent-run-retention-worker.ts` menghapus record kedaluwarsa berkala dan
  dapat dihentikan/drain saat shutdown.

## Client trust-domain

- `src/transport/trust-domain-http.ts` adalah codec/client HTTP strict untuk
  service terpisah: origin dan audience tetap, path+method tertutup, redirect
  dilarang, response fatal-UTF8 berbatas, upload/download di-hash selama
  streaming, dan request/response wajib menggemakan ID/protocol exact.
  `HmacTrustDomainRequestProofProvider` mengikat proof ke origin, audience,
  request, envelope, media type, ukuran, hash konten, dan waktu. Secret proof
  service bukan credential provider/GitHub dan harus diprovision dari luar
  metadata/prompt/sandbox.
- `HttpSandboxTransport`, `HttpLocalGitTransport`, dan
  `HttpGitHubBrokerTransport` mengimplementasikan sisi client kontrak tersebut
  tanpa retry efek. HTTP loopback eksplisit hanya fixture dev; client tidak
  membuktikan isolasi Linux, operasi git, object retention, installation GitHub
  App, ataupun idempotency server. Tidak satu pun dirangkai di `app.ts`.

## Bot (Telegram)

- `src/bot/` — adapter grammY: `create-bot.ts` memasang guard chat pribadi,
  gerbang perkenalan, kontrol data/waktu, alur sesi, tombol, serta fast path
  `/penggunaan`; command usage di grup hanya mengarahkan ke chat pribadi;
  `message-batcher.ts` menggabungkan bubble serta menyediakan antrean idle bagi
  worker; `onboarding.ts` memuat naskah kenalan, arahan keselamatan
  pra-persetujuan, dan `HeldMessageStore`; `action-offers.ts` menyimpan tawaran
  adaptif bertoken; `phrasing.ts` menyimpan beberapa bentuk untuk tiap kalimat
  tetap Harvy; `messages.ts` memformat keluaran, memecah balasan menjadi bubble,
  serta menyusun keyboard; `understanding-route.ts` memeriksa pasangan
  intent/action sebelum adapter mengubah data; `fast-path-policy.ts` membatasi
  acknowledgment dingin dan jawaban pending yang boleh melewati compiler;
  `pending.ts` menyimpan satu langkah sementara yang sedang menunggu jawaban;
  `run-anchor.ts` merender status/event durable tanpa progres rekaan.
  Sebagian besar pending tetap ephemeral; `agent-input` adalah mirror
  checkpoint v1. Untuk orkestrasi eksplisit, adapter memisahkan tiga lane:
  `MessageBatcher` tetap menangani chat, ingress terikat masuk RunMailbox, dan
  work lane berjalan di luar chain owner. Run Anchor dikirim sebagai satu pesan
  editable. Hanya quote anchor/question atau target run yang sempit boleh
  merevisi work; chat lain tetap bebas berjalan.

## Storage

- `src/storage/` — adapter berkas JSON aktif dengan pola yang sama: tulis atomik
  melalui berkas `.tmp` lalu `rename`, dan serialisasi tulis melalui antrian
  promise agar tidak ada pembaruan yang hilang. `file-task-repository.ts`,
  `file-history-repository.ts`, `file-profile-repository.ts`,
  `file-session-repository.ts`, dan `file-telemetry-repository.ts`. Memori dan
  catatan tersembunyi memakai bentuk lain: `markdown-memory-repository.ts` dan
  `markdown-insight-repository.ts` menulis satu folder Markdown per pengguna di
  bawah `MEMORY_FOLDER`. `file-memory-knowledge-repository.ts` menyimpan
  semantic/graph projection di `_knowledge` dengan namespace hash, revision
  CAS, validasi owner/provenance/projection, batas 8 MiB, serta delete final dan
  `.tmp`; adapter ini juga hanya single-process.
  `sqlite-long-term-memory-repository.ts` memakai WAL+synchronous FULL, schema
  STRICT, FTS5, foreign-key cascade, idempotency key, dan scope generation untuk
  cold archive, learning outbox/candidate, user model, procedure/error lesson,
  serta derived embedding cache. Canonical JSON record dapat dipindah ke adapter
  database lain; FTS/vector tetap projection yang dapat dibangun ulang.
  `file-memory-repository.ts`
  hanya sumber impor sekali jalan. `file-group-repository.ts` menyimpan binding akun, memori sosial grup,
  member-local memory, dan shared room memory yang terpisah per scope; reset
  state bersama tersedia atomik. `file-workspace-repository.ts` menyimpan
  authority state Workspace dengan CAS `aclEpoch`. Keduanya aman hanya untuk
  satu proses saja. Adapter metadata baru
  `file-project-workspace-repository.ts`, `file-coding-run-repository.ts`,
  `file-coding-evidence-store.ts`, `file-project-deletion-repository.ts`,
  `file-sandbox-lease-journal.ts`, dan
  `file-github-connection-repository.ts` memakai CAS, validasi schema/transisi,
  temp unik `wx`+rename, serta tidak menyimpan project bytes atau credential;
  adapter file ini juga hanya untuk restart lokal satu proses.
  `sqlite-sandbox-lease-journal.ts` memakai transaksi SQLite lintas proses,
  WAL, dan `synchronous=FULL` untuk lifecycle lease; ia bukan pengganti backend
  isolation. Project bytes berada di root terkelola yang terpisah dari root
  aplikasi, tetapi tetap diakses oleh service Harvy in-process.
  `file-agent-run-repository.ts` menyimpan checkpoint
  `waiting_input` v1 atau satu active/terminal v2 terbaru per scope. Read/write
  diserialkan dalam queue statik per path, revision CAS
  menjaga identity scope, codec/record divalidasi, expiry diterapkan, dan `.tmp`
  yatim dibuang. Adapter ini hanya menjamin restart lokal satu proses, bukan
  durability atau koordinasi multi-instance.
  `file-group-agent-run-repository.ts` menyimpan aggregate Phase K tersendiri
  dengan schema/transisi tertutup, CAS, satu foreground per grup, expiry, dan
  guard authority tepat sebelum write; ia juga hanya adapter lokal satu proses.

## WhatsApp

- `src/whatsapp/` — adapter grup WhatsApp beta berbasis `baileys@7.0.0-rc14`
  serta jalur private command deterministik untuk `/penggunaan`.
  `baileys-account-manager.ts` menjalankan satu auth namespace/socket/reconnect
  supervisor per `accountId`; `baileys-message-normalizer.ts` mempertahankan
  participant PN/LID, tag, quote, dan timestamp;
  `group-message-batcher.ts` menggabungkan burst satu anggota tanpa membuang ID
  bubble; `config.ts` memvalidasi registry banyak nomor. Ingress private hanya
  menghasilkan respons untuk command yang dikenali, dideduplikasi dengan ID
  content-free, dan tidak mengaktifkan percakapan private umum. Detail billing
  tidak pernah dikirim ke grup. Auth multi-file hanya untuk pengembangan lokal,
  bukan penyimpanan produksi.

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
