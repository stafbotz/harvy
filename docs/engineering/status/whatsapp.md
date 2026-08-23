# Status — WhatsApp

Refreshed: 23 Agustus 2026 pada acceptance nyata WhatsApp privat. Angka gerbang
penuh terbaru dicatat di `docs/LOG.md`; baseline privat terbaru sudah lulus,
sedangkan bukti grup, reconnect, coding, dan GitHub tetap belum lengkap.

## Keadaan saat ini

- Baileys menyediakan fondasi beta grup terpisah dari state privat Telegram.
  Direct, ambient, membership lifecycle, binding, batching, dan generation
  guard tersedia.
- WhatsApp privat tersedia di balik `WHATSAPP_PRIVATE_ENABLED=true`, terpisah
  dari `WHATSAPP_ENABLED`. Default-nya `false`; transport membuang ingress
  privat sebelum normalisasi/callback saat flag mati, sementara ingress grup
  tetap berjalan.
- Telegram privat dan WhatsApp privat adalah dua surface produk dengan kontrak
  kemampuan yang sama, bukan versi “lengkap” dan “ringan”. Capability catalog
  mengaktifkan task, reminder, sesi, pembacaan state internal, terminal virtual,
  dan delegasi pada kedua kanal. Perbedaan tombol Telegram dan perintah teks
  WhatsApp adalah perbedaan UX, bukan pengurangan capability.
- Saat aktif, teks privat memakai `WhatsAppPrivateConversation`: owner scope
  WhatsApp terpisah dari Telegram, pesan pertama ditahan hanya di RAM sampai
  pengguna membalas `SETUJU`, lalu core conversation, profile, recent/retrieved
  memory context, history, selective safety review, telemetry, funding, dan
  `/penggunaan` dipakai dengan atribusi kanal WhatsApp. Task/reminder,
  sesi/check-in, zona waktu/jam tenang/gaya, `/izin`, `/tarik-izin`, ekspor,
  lihat/hapus memori, serta `/hapus-data` dengan konfirmasi exact mempunyai
  perintah teks tertutup. Kontrol lihat/hapus/ekspor tetap dapat dipakai tanpa
  consent AI aktif.
- `/menu` dan `/bantuan` mempunyai renderer teks berbeda dari satu katalog
  user-facing yang sama dengan Telegram, tetapi hanya memuat command WhatsApp
  yang benar-benar tersedia. Free-text account/menu memakai bounded
  `SemanticOperation`; code tetap memeriksa raw evidence, explicitness,
  subject, confidence, owner, dan operation sebelum renderer/service
  deterministic dipanggil.
- Private upsert dideduplikasi per account+pengirim lalu dilepas dari callback
  event agar bubble baru tetap dapat masuk selama model bekerja. Setelah
  consent, `MessageBatcher` dan semantic boundary yang sama dengan Telegram
  menggabungkan burst serta membedakan addition/correction/redirect/independent.
  Related input membatalkan `AbortController` lama; independent tetap FIFO.
  History balasan dan settlement usage baru di-commit setelah socket mengakui
  send. Jika delivery terputus, hanya bubble yang sungguh terkirim masuk satu
  logical assistant turn dan unsent continuation tidak diakui.
- Referen usage/menu/memory juga baru dicatat setelah socket mengakui send.
  Store process-local terisolasi per owner+channel+conversation, maksimal tiga
  entry/sepuluh menit, dan hanya membawa domain/operation/reference—bukan isi
  chat, account value, memory, atau credential. Kegagalan delivery tidak
  meninggalkan referen atau selection memori yang tak pernah terlihat;
  withdrawal/full deletion juga membersihkan scope transient.
- WhatsApp privat memakai shared `ResponsePresentationPlan`, sehingga tidak ada
  aturan maksimal tiga bubble atau truncation respons. Keputusan beat tetap
  sama dengan Telegram; hard splitter 12.000 karakter baru berjalan sesudah
  rencana semantik dan tidak membuang code point. Setiap send dipagari socket
  generation/current turn. Satu transient progress message dapat dikirim,
  diedit, lalu dihapus dari event kerja backend nyata. Note memakai semantic
  `publicFocus` tervalidasi dari core yang sama dengan Telegram, tanpa call AI
  tambahan dan hanya setelah triase final biasa; respons cepat dan fase
  listening tetap tanpa status.
- Metadata membership pengirim dan Harvy harus segar sebelum ingress diterima;
  core melakukan revalidation sebelum binding atau mutasi. Observation authority
  async diserialkan per runtime; hanya observation authorized/live yang boleh
  menaikkan revision atau menyupersesi ambient. Alias default maupun durable
  dihidrasi sebelum admission, termasuk cold start, dan observation yang
  sengaja ditolak menutup watermark hanya pada generation yang sama.
- Direct/ambient memakai fallback settle 350 ms/1,2 detik lalu p90 gap
  content-free per `scope+account+participant` setelah tiga sampel, termasuk
  antar-batch yang sudah ter-flush; speaker switch memutus sampel A→B→A.
  Profile hanya di RAM, berbatas, ber-TTL, dan dibersihkan saat scope diinvalidasi.
  Direct tetap membatalkan kandidat ambient; ambient tetap revalidate terhadap
  quiet gap, freshness, dan human-flow policy. Mode runtime efektif diperiksa
  lagi sebelum model revalidation, fixed ACK, dan delivery; work lama
  dibatalkan bila admission terbaru bukan `process`. Emergency eksplisit tetap
  menjadi pengecualian yang diizinkan pada `direct_only`.
- Batcher grup menilai seluruh burst dengan kontrak semantic boundary yang sama
  setelah authority observation; hitungan jelas dan fragmen keras tetap jalur
  lokal sempit. Balasan grup memakai presentation plan bersama. Core membawa
  fence generation+ingress revision ke setiap bubble; pesan authorized yang
  lebih baru menghentikan continuation. Transport mengembalikan receipt
  partial sehingga context grup hanya menyimpan teks yang terkirim dan mutasi
  yang belum diakui dapat di-rollback. Direct turn yang lolos authority dan
  notice memakai lifecycle progress core yang sama: grace period, phase dari
  execution aktual, satu pesan editable, dan penghapusan sebelum reply.
  Native typing langsung tetap hanya fallback bila transport tidak menyediakan
  surface tersebut; ambient turn yang mungkin memilih diam tidak menampilkan
  progress.
- Core membuktikan membership, binding account aktif, dan notice live sebelum
  assessment model. Direct memakai ingress compiler; ambient menggabungkan
  `riskHint` dan `contextPrivacy` dengan planner. Ordinary melewati triage,
  sedangkan hint possible/strong, compiler unavailable, marker continuation,
  dan emergency lokal memakai acute triage evidence-aware.
- Raw message/reply hanya masuk context dua jam ketika privacy ordinary dan
  safety calm+certain. Memori durable memakai classifier privacy candidate-only
  yang terpisah. Support pasti tidak membayar reviewer kedua; danger dan
  support tidak pasti tetap review fail-closed.
- Emergency lokal berpresisi tinggi melewati debounce, reservation/dedupe, dan
  fixed ACK-nya dapat keluar sebelum FIFO setelah authority+binding+notice.
  ACK dan assessment memakai reservation terpisah; emergency acute triage tidak
  menunggu ingress/memory extraction, sementara full turn lintas speaker tetap
  FIFO. Emergency ambient tetap mendapat final reviewed safety reply ketika
  triage unavailable/tidak mengonfirmasi danger. Assessment prioritas berbatas
  empat aktif+32 queued dan dibatalkan oleh
  generation/AbortSignal. Paket `direct_only` tetap menerima emergency tanpa
  tag; `disabled/paused` tidak memprosesnya.
- Member-local memory dan shared room memory ada di core dengan authority guard,
  preview/confirmation, retensi, dan kontrol member/admin. Record baru
  di-rollback bila tidak ada acknowledgment yang terkirim; acknowledgment pada
  bubble partial yang sudah terlihat mempertahankan write agar UX tidak
  mengarang kegagalan.
- Fondasi core Group AgentRun terpisah menyimpan scope+account, initiator,
  participant/audience group-safe, anchor/question reference, input
  teratribusi, ChangeSet, ledger work, hasil final committed, event, revision,
  dan expiry. Policy lokal menolak
  ambient serta mixed bubble, membedakan self-info/proposal/control, mengikat
  assigned answer dan override admin eksplisit, menyisakan slot cancel, serta
  menegakkan satu foreground per grup melalui CAS serta menolak replay lintas
  account. Anchor tidak auto-pin.
- Anchor dan assigned question kini melewati `pendingEffect` durable sebelum
  send. Effect mengikat digest konten, revision, purpose, dan snapshot authority;
  request delivery menurunkan expected epoch serta actor/role initiator atau
  assignee exact dari effect itu. Anchor/question baru diikat sesudah transport
  mengembalikan ID pesan. Receipt append-only membedakan `committed`,
  `not_committed`, dan `unknown`; replay committed tidak mengirim ulang,
  sedangkan delivery ambigu atau recovery restart menjadi `partial|unknown`
  tanpa retry. Watermark assigned answer diambil sesudah delivery.
- Notice v9 mengungkap record GroupAgentRun kondisional, ledger upaya/delivery,
  hasil final committed, data/provenance, audience grup, file lokal terpisah,
  retensi maksimal tujuh hari, batas terhadap memori/riwayat privat dan
  transcript model, serta cleanup saat Harvy dinonaktifkan/dikeluarkan.
- Adapter Baileys menyediakan delivery GroupRun yang dapat quote pesan inbound
  maupun outbound, meminta ID pesan deterministik dari effect ID/idempotency
  key, dan gagal tertutup bila ID aktual kosong atau berbeda. Setiap send juga
  wajib membawa expected authority epoch, actor/role, dan runtime fence. Dalam
  antrean per grup, adapter menyegarkan metadata, menunggu runtime fence, lalu
  memeriksa ulang socket/generation, epoch, membership Harvy, dan role actor
  secara sinkron tepat sebelum socket dipanggil. Fence false/error tidak
  memanggil socket. Validator repository menolak receipt/pending-effect dirusak.
- Quote raw inbound untuk control-copy hanya in-memory, memakai key exact
  grup+message, TTL 60 detik, cap 1.000 per akun, dan dibersihkan pada socket
  close/reconnect atau self-removal. Refresh membership transient dibedakan dari
  absence agar retry aktivasi tetap fail-closed tanpa kehilangan wake.
- Ledger work-attempt membatasi satu attempt running, claim sesudah anchor,
  replay exact revision, recovery/requeue, expiry, waiting-input, cancel, dan
  batas 32 attempt. Hasil komputasi tetap `finalizing`; hanya final delivery
  committed yang atomik mengikat receipt, result, attempt, event
  `run.completed`, dan terminal run. Cap 256 event menolak setiap transisi
  nonterminal yang tidak menyisakan slot outcome/penutupan; guard yang sama ada
  pada service dan repository. Migrasi v1/v2 tanpa ledger work menormalkan
  state aktif ke `queued|waiting_input`; legacy `completed` tanpa bukti final
  committed menjadi `partial`, tanpa mengarang work, receipt, atau result.
- `GroupAgentRunWorker` mempunyai concurrency/cap queue, trailing resume,
  abort/stop/drain, lease ABA, recovery failure port, startup/periodic resume,
  dan composition ke service/model ketika flag eksplisit aktif.
- Executor group-safe dan work processor sekarang tersedia. Executor hanya
  menerima initial request serta update run teratribusi, tanpa private history,
  memory, capability operasional, atau transcript provider; ia membuat tepat
  satu final/question native decision dalam RunBudget. Checkpoint content-free
  mengikat attempt, instruction revision, input digest, dan budget. Processor
  memeriksa lease, menulis checkpoint sebelum delivery, mensyaratkan receipt
  exact, lalu baru menyelesaikan usage sebagai committed/discarded. Adapter
  runtime mengikat repository, service, watermark sesudah send, transport
  fenced, usage, dan recovery failure ke worker/composition root.
- Worker lifecycle memulai recovery sebelum purge, tidak menjalankan siklus
  overlap, mencoba ulang recovery/purge yang gagal, dan mendukung stop/drain.
  Runtime WhatsApp juga mempunyai file intent cleanup terpisah. Startup
  menjalankan recovery cleanup lebih dulu dan gagal readiness bila masih
  pending, kemudian recovery delivery+purge, baru `whatsapp.start()` dan resume
  work lane. Semua worker dan ingress ikut stop/drain. Config menolak collision
  path state grup, GroupAgentRun, dan cleanup.
- Disable mempersistenkan intent exact `scope+account` sebelum mencoba
  `disableGroup` dan `forgetScope` dengan `allSettled`; intent selesai hanya
  sesudah keduanya fulfilled. Revision+token intent dan pemeriksaan
  matches-before-effects menutup ABA/stale attempt. Coordinator per binding
  menyatukan request, recovery, dan activation; reaktivasi serta ingress ditahan
  ketika cleanup masih pending. Setelah cleanup tuntas, retry merevalidasi live
  membership dan membawa lease sampai commit binding/notice.
- Admission service fail-closed pada start, mutasi, prepare, CAS, dan pre-send.
  Resolver produksi mensyaratkan binding live ke account exact, tidak ada cleanup
  pending, serta mode bukan `disabled|paused`; error resolver ditolak. Claim
  work memakai admission runtime `scope+account` dan revalidasi actor/epoch
  authority live pada setiap claim sebelum model berjalan.
- Exact start parser dan `GroupAgentRunIngressRouter` guarded sudah teruji.
  Parser hanya menerima grammar closed-set satu bubble live serta membiarkan
  danger ke safety. Controller memisahkan target run sebelum batching,
  menyerialkan start, memakai deterministic control ID+authority/runtime fence,
  dan memiliki stop/drain. Composition menempatkannya sesudah observation
  authority dan sebelum merge batch; command serta work lane hanya reachable
  ketika `WHATSAPP_GROUP_AGENT_RUN_ENABLED=true` dan runtime admission live.
- Phase L group-coding kini dirangkai sesudah observation authority dan sebelum
  ambient batching ketika coding runtime aktif. Resolver membuat actor opaque
  dari account/scope/participant/message tepercaya; controller tetap
  merevalidasi live group epoch, membership Workspace, permission, dan link
  durable sebelum serta sesudah admission. Start/status/correction/cancel dan
  anchor mutable group-safe tersedia. Source/diff/path/error/repository metadata
  tidak mempunyai renderer grup.
- Link Workspace dibuka lewat handoff Telegram private: admin grup meminta link,
  owner Workspace menyetujui interaction exact, lalu principal WhatsApp baru
  mendapat membership. Request publish grup hanya membuat offer confirmation
  Telegram Workspace-private; approval/effect broker tidak pernah berasal dari
  bubble grup.
- Disable, removal, dan authority epoch change mencabut link serta handoff,
  menginterupsi scheduler exact, mem-fence run/sandbox/working copy, dan
  mempertahankan pending commit barrier. Recovery startup juga menutup group
  reference stale dan orphan admission sebelum ingress dibuka.
- `npm run acceptance:whatsapp` menyediakan harness live nonkritis dengan
  confirmation environment explicit, auth tester yang sudah dipasangkan, dan
  output digest-only. Ia menguji remove/re-add, notice, start/anchor, ambient,
  quote correction, duplicate replay, status quote, emergency routing, dan
  admin cancel; harness sengaja berakhir non-sukses bila scope participant,
  crash/reconnect, waiting input, atau workspace publish belum dijalankan.
- `npm run acceptance:whatsapp-private` memakai akun tester terpisah yang sudah
  paired, dua konfirmasi environment explicit, dan output tanpa JID/nomor/isi
  pesan/path auth. Implementasi saat ini menguji consent+menu, task+reminder,
  sesi+check-in, penolakan consent memori, safety nonkrisis, planning AgentRun,
  ekspor, lalu penghapusan seluruh data akun uji. Evaluator menunggu burst
  multi-bubble sampai quiet gap sebelum membaca consent atau mengirim command
  berikutnya. Ia belum menguji interupsi di tengah burst, Workspace ZIP,
  CodingRun, atau GitHub live.
- Pairing fixed-role `harvy`/`tester` dan
  `npm run acceptance:whatsapp-private:managed` kini dapat menurunkan identitas
  dari auth lokal, menyalakan build Harvy dengan state produk sementara,
  menjalankan harness privat tersebut, melakukan graceful drain, dan membuang
  state sementara tanpa meminta operator menyalin nomor/JID. Launcher menunggu
  account WhatsApp Harvy benar-benar `open`, bukan sekadar IPC proses siap,
  memakai import `tsx` absolut dari cwd terisolasi, menerima pasangan JID
  PN/LID, mencatat receipt tahap yang gagal, lalu berhenti sebelum skenario
  berikutnya agar respons tertunda tidak mencemari bukti tahap lain; cleanup
  tetap berjalan. Linked device dapat menerima mutasi anchor sebelum event
  create, sehingga evaluator mengikat create/edit/pin/unpin ke target bubble
  exact dan tetap menolak target ganda. Trace live hanya membawa counter
  lifecycle allowlist; parent memberi waktu shutdown 75 detik untuk grace child
  60 detik dan cleanup state sementara retry-bounded.
- Acceptance akun nyata terbaru 23 Agustus 2026 lulus 10/10 tahap: reset akun
  khusus, consent+menu, pembuatan tugas natural, reminder, sesi+check-in,
  penolakan memori implisit, planning durable, safety nonkrisis tersimulasi,
  ekspor dokumen, dan full data cleanup. Sebanyak 17 ingress menjadi `notify`
  dan 29/29 delivery Harvy berhasil, tanpa pipeline/delivery failure, restart,
  crash loop, atau shutdown timeout; isolated state terhapus. Planning selesai
  dalam sekitar 19 detik dengan satu Run Anchor yang dipin, diedit, dan dilepas;
  satu transient surface dibuang dan hasil akhir berada pada bubble terpisah.
  Evaluator menerima 3/3 langkah bertindakan, berbukti, dan berkriteria lulus.
  Receipt tidak membawa isi pesan atau identifier akun.
- Readiness credential tidak hanya memakai flag `registered`: Baileys 7 rc14
  pada QR menyimpan identitas, account signature, dan signal identity hasil
  pair-success tetapi membiarkan flag itu `false`. Console, runtime utama,
  revoke, pemeriksaan beda-identitas, serta runner acceptance memakai satu
  validator material pair-success yang sama dan tetap menolak state `me`-only.
- `WHATSAPP_ACCOUNTS` mendukung beberapa alias account satu proses, masing-masing
  dengan auth folder, socket, cache, reconnect, generation, dan queue sendiri.
- Satu nomor nyata pernah QR/login/`open` dan membalas satu jalur dasar.

## Batas dan defect aktif

- Notice/privacy terbaru, memory member/room, timing ambient, removal, safety,
  dan shutdown belum diuji end-to-end di grup nyata.
- WhatsApp privat sudah mempunyai parity otomatis untuk percakapan, task dan
  reminder, sesi dan check-in, memori/safety/kontrol data, ekspor, Workspace
  ZIP, private coding, GitHub, dan active AgentRun durable. Pairing serta runner
  dua akun khusus kini tersedia. WhatsApp A Harvy uji dan WhatsApp B tester
  telah mencapai durable pair-success nyata dengan credential terpisah.
  Baseline percakapan/task/session/memory/safety/planning/export/delete kini
  terbukti live, termasuk delivery receipt `delivered`; reconnect, interupsi
  burst, Workspace/CodingRun/GitHub, dan kualitas UX dogfood tetap belum
  terbukti.
- Percobaan tersebut juga membuktikan dependency Signal dapat menulis object
  session kriptografis langsung ke stdout meski logger Baileys silent. Guard
  call-site sekarang membuang direct console output itu. Session tester sudah
  dirotasi dan run penuh berikutnya tidak memancarkan material tersebut.
- WhatsApp memakai perintah teks untuk sebagian kontrol yang di Telegram berupa
  tombol/callback. Ini sengaja bukan bentuk UI yang identik, tetapi operasi dan
  authority akhirnya harus tetap setara.
- Saat dua session baru pertama diuji, B→A tidak menghasilkan upsert, sedangkan
  handshake langsung A→B menghasilkan `notify`; blocklist kedua akun kosong.
  Setelah peer session itu terbentuk, probe B→A dan acceptance penuh lulus.
  Penyebab platform/Signal awal belum dibuktikan, sehingga credential-ready
  tetap tidak boleh dianggap bukti transport-ready. Tidak ada failover atau
  rebind otomatis antar-account.
- Pending confirmation dan authority epoch grup tidak durable lintas restart.
- Group AgentRun dan group-coding composition dibuktikan otomatis, belum diuji
  fault/live end-to-end lengkap pada WhatsApp nyata. Flag tetap opt-in; tidak
  ada klaim deduplikasi server, reconnect delivery, atau kualitas executor pada
  grup nyata.
- Cleanup retry durable hanya terkoordinasi dalam satu proses. Startup menahan
  WhatsApp dan reaktivasi ditahan bila intent tidak dapat dituntaskan; retry
  aktivasi otomatis tetap in-memory. Belum ada lease/supervisor multi-instance,
  bukti crash/restart nyata, atau fault-injection crash setelah commit binding.
- Adapter file hanya satu proses dan belum mempunyai lease/outbox/dispatcher
  atau reconciler multi-instance. Crash antara send dan receipt ditutup
  konservatif sebagai `unknown|partial` tanpa retry; belum ada reconciliation
  eksternal. ID deterministik Baileys baru diuji dengan fake socket dan belum
  membuktikan deduplikasi WhatsApp live/reconnect.
- Edit, delete, reset, alias, dan self-delete belum mempunyai kompensasi generik
  bila acknowledgment gagal sesudah mutasi commit.
- Store sosial legacy masih memakai PN/LID mentah untuk bridging; semantic
  record baru memakai alias hash scoped. Account linking lintas kanal belum ada.
- Satu stream grup belum mempunyai conversation disentanglement sempurna. Quote
  control-copy sengaja dikirim tanpa quote bila cache raw 60 detik kedaluwarsa.
- Adaptive timing, selective safety/privacy, emergency ACK, dan authority-first
  preflight, semantic boundary, serta per-bubble interruption belum diuji di
  grup nyata.

## Bukti dan pointer

- Kode: `src/whatsapp/`, `src/core/group-turn-service.ts`,
  `src/core/response-presentation.ts`, `src/core/conversation-progress.ts`,
  `src/core/group-memory-service.ts`, `src/core/group-authority-policy.ts`,
  `src/core/group-agent-run-service.ts`, `src/core/group-agent-run-policy.ts`,
  `src/core/group-agent-run-ingress.ts`, `src/core/group-agent-run-start-policy.ts`,
  `src/core/group-agent-run-worker.ts`,
  `src/core/group-agent-run-work-processor.ts`,
  `src/core/group-agent-run-runtime.ts`,
  `src/core/group-agent-run-activation-retry.ts`,
  `src/core/group-agent-run-cleanup-service.ts`,
  `src/core/group-agent-run-cleanup-worker.ts`,
  `src/core/group-agent-run-lifecycle-coordinator.ts`,
  `src/core/group-agent-run-retention-worker.ts`,
  `src/domain/group-agent-run.ts`, `src/domain/group-agent-run-cleanup.ts`,
  `src/storage/file-group-agent-run-repository.ts`,
  `src/storage/file-group-agent-run-cleanup-repository.ts`,
  `src/bot/group-run-anchor.ts`, `src/ai/group-ingress.ts`,
  `src/ai/group-agent-run-executor.ts`,
  `src/core/group-workspace-coding-controller.ts`,
  `src/core/group-runtime-policy.ts`, `src/whatsapp/group-message-batcher.ts`.
- Tes: `tests/baileys-account-manager.test.ts`,
  `tests/whatsapp-private-conversation.test.ts`,
  `tests/whatsapp-config.test.ts`,
  `tests/group-conversation.test.ts`, `tests/group-turn-service.test.ts`,
  `tests/group-memory-service.test.ts`, `tests/group-ingress.test.ts`,
  `tests/group-runtime-policy.test.ts`, `tests/group-message-batcher.test.ts`,
  `tests/group-agent-run-policy.test.ts`, `tests/group-agent-run-service.test.ts`,
  `tests/group-agent-run-delivery.test.ts`,
  `tests/group-agent-run-runtime-admission.test.ts`,
  `tests/group-agent-run-start-policy.test.ts`,
  `tests/group-agent-run-activation-retry.test.ts`,
  `tests/group-agent-run-cleanup-repository.test.ts`,
  `tests/group-agent-run-cleanup-service.test.ts`,
  `tests/group-agent-run-cleanup-worker.test.ts`,
  `tests/group-agent-run-lifecycle-coordinator.test.ts`,
  `tests/group-agent-run-forget.test.ts`, `tests/group-agent-run-ingress.test.ts`,
  `tests/group-agent-run-final-delivery.test.ts`,
  `tests/group-agent-run-purge-safety.test.ts`,
  `tests/group-agent-run-retention-worker.test.ts`,
  `tests/group-agent-run-work-lifecycle.test.ts`,
  `tests/group-agent-run-work-processor.test.ts`,
  `tests/group-agent-run-executor.test.ts`,
  `tests/group-agent-run-worker.test.ts`, dan
  `tests/group-run-anchor.test.ts`,
  `tests/group-workspace-coding-controller.test.ts`,
  `tests/group-coding-ingress.test.ts`,
  `tests/group-coding-delivery-service.test.ts`,
  `tests/group-coding-run-driver.test.ts`, dan
  `tests/group-coding-lifecycle-fence.test.ts`.
- Keputusan: ADR-009, ADR-011, ADR-016, ADR-023, ADR-024, ADR-037, ADR-039,
  ADR-044.
