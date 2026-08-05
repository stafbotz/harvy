# ADR-017 — Agent Runtime Internal dan Delegasi Berbatas

- **Status:** Diterima
- **Tanggal:** 4 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** Konstitusi v0.5, ADR-003, ADR-006, ADR-008, ADR-012, ADR-013, ADR-015, ADR-016
- **Diamendemen oleh:** ADR-018 untuk persistence checkpoint `waiting_input`;
  run aktif dan tool write tetap mengikuti batas ADR ini
- **Amendemen 5 Agustus 2026:** planner Agent Runtime memakai native function
  calling; bentuk kanonik `final|need_input|action` tetap menjadi kontrak kernel

## Konteks

Kernel `AgentHarness` dan dua executor web baca-saja sudah ada, tetapi belum
menjadi agent umum. Harvy belum mempunyai tool atomik untuk membaca tugas,
sesi, pengaturan waktu, atau agenda internal; belum ada terminal aman; dan
belum dapat membagi pekerjaan kompleks kepada beberapa worker. Capability
catalog juga masih mencampur fitur produk yang tersedia lewat workflow
deterministik dengan tool yang benar-benar mempunyai executor agent.

Permintaan produk 4 Agustus 2026 menetapkan arah baru: pekerjaan agent biasa
harus dapat berjalan dengan satu model murah, pekerjaan kompleks boleh naik ke
model ambitious sebagai orkestrator, dan orkestrator dapat mendelegasikan
subpekerjaan independen secara paralel kepada model cheap atau efficient.
Harvy juga harus dapat menjawab jam secara pasti, membaca agenda, memakai
terminal sederhana, merencanakan, dan memanfaatkan ingatan dengan disiplin
memory engineering yang baik.

Terminal host dan kalender eksternal membawa risiko berbeda dari chat. Proses
Harvy menyimpan token Telegram/AI, auth WhatsApp, history, dan memory. Memberi
model `child_process` atau filesystem host akan mengubah prompt injection
menjadi akses credential dan data privat. Mutasi kalender eksternal juga belum
memiliki OAuth per pengguna, durable run store, approval preview persis,
outbox, receipt, atau reconciler. Karena itu kemampuan tersebut tidak boleh
diklaim selesai dengan menyamarkan kekurangannya.

## Keputusan

1. **Jalur agent berada setelah pagar yang sudah ada.** Consent, triase
   keselamatan, kontrol data, mutasi tugas/memori/sesi, dan intent research
   tetap memakai route lama. Agent umum hanya menerima intent `question` atau
   `request` pada giliran privat Telegram yang ditriase `biasa` dan `certain`,
   serta tidak sedang membawa sesi aktif. Keselamatan tetap memakai tier
   `efficient` dan review fail-closed; ia tidak pernah didelegasikan.
2. **Root agent cheap-first.** Pesan biasa dan tool atomik memakai root
   `cheap`. Kode—bukan paket, cohort, model, atau prompt—menaikkan root menjadi
   `ambitious` bila ekstraksi meminta langkah bertahap atau pesan melebihi 280
   karakter. Root ambitious menjadi planner sekaligus synthesizer. Pada mode
   testing, seluruh role tetap boleh dipetakan ke satu `testingModel`, sehingga
   arsitektur yang sama dapat dijalankan dengan satu model.
3. **Planner hanya melihat capability callable.** Snapshot produk tetap
   menjelaskan seluruh kemampuan dan batas runtime, tetapi `AgentPlannerInput`
   membawa irisan entry `available` dengan executor yang benar-benar terpasang
   pada run. Executor yang sama memiliki nama dan JSON Schema native; hanya
   definisi function dari irisan callable itu yang dikirim pada langkah
   tersebut. Fitur seperti `task.manage` tidak lagi tampak callable hanya
   karena workflow deterministiknya ada. Metadata native ikut hash authority
   checkpoint agar resume tidak memperoleh kontrak tool yang berubah.
4. **Tool internal v1 bersifat atomik dan baca-saja.** Runtime memasang
   `task.list_active`, `task.get`, `session.status`, `settings.time.get`, dan
   `calendar.agenda`. Seluruh schema tertutup dan berbatas. Owner selalu
   diambil dari `PrivateAgentScope`; model tidak dapat memilih owner, chat,
   credential, atau scope. Judul tugas dan tujuan sesi ditandai sebagai data
   buatan pengguna yang tidak tepercaya.
5. **Jam mempunyai fast path deterministik.** Pertanyaan sempit seperti
   “sekarang jam berapa?” dijawab dari clock runtime dan zona waktu profil tanpa
   planner. Tool `settings.time.get` menyediakan instant UTC, bentuk lokal,
   zona waktu, dan jam tenang bagi rencana yang lebih luas. Ini tidak bergantung
   pada pengetahuan tanggal model.
6. **Kalender v1 berarti agenda internal Harvy.** `calendar.agenda` hanya
   memproyeksikan tenggat, pengingat tugas, dan check-in yang sudah ada di state
   Harvy untuk 1–31 hari. Observation selalu menyatakan
   `externalCalendar:false`. Harvy belum membaca atau mengubah Google Calendar,
   Outlook, maupun kalender perangkat.
7. **Terminal v1 adalah scratchpad virtual, bukan shell host.** `terminal.run`
   menerima paling banyak 12 command bertipe: `pwd`, `date`, `echo`,
   `calculate`, `write`, `append`, `cat`, `list`, dan `remove`. Setiap action
   mulai dengan filesystem kosong di RAM di bawah `/workspace`; tidak ada
   child process, host mount, environment, network, TTY, background job, atau
   state lintas action. Path traversal, absolute host path, token aritmetika
   asing, ukuran file, kompleksitas hitung, dan output berlebihan ditolak.
8. **Delegasi hanya satu tingkat dan read-only.** Capability
   `agent.delegate.parallel` menerima dua atau tiga subpekerjaan independen.
   Pada root ambitious, pass langkah nol sengaja tidak menerima history/memory
   dan hanya hasil `action` delegasi yang diterima; bila tidak mendelegasikan,
   kode menjalankan pass context-aware tanpa capability delegasi. Ini mencegah
   fan-out menjadi saluran konteks privat sekaligus mempertahankan kualitas
   jawaban non-delegasi.
   Tier worker hanya `cheap|efficient`; worker tidak menerima harness, tool,
   history, memory, credential, capability delegasi, atau pilihan scope/model
   ID. Semua child mewarisi owner, run, cancellation, dan deadline dari kode.
   Satu semaphore membatasi tiga panggilan provider aktif, `Promise.allSettled`
   menunggu sibling, dan hasil parsial dilaporkan eksplisit. Tiap output worker
   dibatasi 800 karakter; envelope gabungan dibatasi 3.600 karakter dengan JSON
   tetap valid dan pembagian ruang yang fair. Semuanya ditandai tak tepercaya,
   lalu hanya root ambitious yang menyintesis.
   Karena fan-out menambah cara isi permintaan diproses, persetujuan privat
   naik ke versi 5 dan menjelaskan batas tiga worker serta ketiadaan
   memori/riwayat/tool pada worker sebelum fitur ini boleh dipakai.
9. **Budget aktif dan horizon resume dipisahkan.** Checkpoint v1 menyimpan
   `startedAt`, `deadlineAt`, `maxSteps`, dan hash authority callable. Setiap
   invocation Agent Runtime aktif dibatasi 45 detik, sedangkan checkpoint
   `need_input` dapat dilanjutkan pada run yang sama dalam horizon absolut 10
   menit. Resume tidak menggeser horizon, menambah langkah, atau menerima
   executor/capability versi lain. Prompt klarifikasi baru disimpan
   owner-scoped setelah delivery berhasil. Checkpoint masih berada di
   `PendingStore` in-memory dan hilang saat restart.
10. **Settlement penggunaan terikat giliran.** Ingress privat mendapat
    `turnId` acak di `AsyncLocalStorage`. Kandidat entitlement diselesaikan atau
    dibuang berdasarkan `ownerId + turnId`, bukan seluruh kandidat satu owner.
    Grup membaca `turnId` dari attribution yang sama. Satu balasan paralel tidak
    boleh mendebit atau membuang run lain.
11. **“Belajar” dipisah menurut authority.** Semantic memory yang terlihat dan
    dapat dikoreksi pengguna membantu preferensi/fakta; episodic history hanya
    membantu kesinambungan; task/calendar/session adalah state domain live;
    checkpoint adalah progress run; receipt kelak menjadi bukti outcome tool.
    Memori dan episode tidak pernah menjadi bukti izin, credential, actor,
    waktu kini, jadwal live, atau keberhasilan aksi. Sub-agent tidak menerima
    memori sama sekali. Harvy tidak mengubah bobot model atau membuat hidden
    self-training dari chat produksi. Perbaikan global harus offline, berversi,
    dapat dievaluasi/di-rollback, dan memakai data sintetis atau opt-in.
12. **Mutasi agent tetap ditutup.** Task write, reminder scheduling, session
    write, external calendar, email, dan shell host belum menjadi executor
    agent. Sebelum dibuka, masing-masing memerlukan revision/CAS, preview
    approval persis, durable RunStore, idempotent outbox, receipt, status
    `unknown`, reconciliation, export/deletion, dan uji crash recovery.

## Konsekuensi

Positif:

- Harvy dapat menjawab pertanyaan jam tanpa halusinasi model, membaca state
  internal yang relevan, memakai scratchpad aman, serta membagi analisis
  kompleks kepada maksimal tiga worker dengan model yang sesuai.
- Mode murah dan mode orkestrasi mempunyai batas kode yang dapat diuji. Model
  tidak dapat menaikkan worker menjadi ambitious atau mendelegasikan kembali.
- Capability prompt tidak lagi menyamakan fitur produk dengan tool callable.
- Parallelism tidak mencampur entitlement antar-run dan hasil parsial tidak
  disamarkan sebagai sukses penuh.

Trade-off dan batas terbuka:

- Root agent memakai `tools` dan `tool_choice: required` pada endpoint chat
  completion kompatibel OpenAI, lalu menormalisasi tepat satu function call ke
  keputusan kernel. Plain text, function asing, argumen rusak, dan multi-call
  gagal tertutup. Native request masih primary-only; fallback baru boleh dipakai
  setelah kompatibilitas function calling-nya dibuktikan. Smoke model primary
  dan Telegram staging untuk amendemen ini belum dijalankan.
- Run masih sinkron dan checkpoint tidak durable. Signal command/generation
  Telegram sudah diteruskan ke jalur agent/research, tetapi delivery network
  tidak dapat dibuat atomik olehnya; belum ada cancellation lintas proses,
  background run, atau crash recovery.
- Terminal tidak dapat menjalankan program atau membaca repository/host.
- Agenda tidak tersambung ke kalender eksternal dan tidak mempunyai mutasi.
- Memory privat lama belum mempunyai provenance/revision/valid-time/supersede;
  “Lupakan satu” juga belum melakukan scrub sumber dari recent history/episode.
  Karena agent v1 read-only dan terminalnya virtual, gap ini tidak memberi
  authority mutasi, tetapi tetap menjadi pekerjaan memory engineering sebelum
  tool write dibuka.

## Bukti

Tes deterministik mencakup pemilihan root cheap/ambitious, satu model testing,
wire `tools`/`tool_choice`, schema native milik executor, penolakan plain text/
function asing/multi-call, binding schema ke checkpoint, pass delegasi
context-free, peran chat pada sintesis,
checkpoint `need_input`, deadline aktif+horizon resume, perubahan executor,
isolasi owner, WIB/WITA, agenda internal dan cakupannya, path escape/resource
limit terminal, fan-out paralel nyata, tier+fair output worker, hasil parsial,
fast path jam, live-evidence gate, cancellation command/generation, routing
adapter Telegram, serta settlement entitlement per turn. Gerbang penuh dan
jumlah tes dicatat di `docs/engineering/STATUS.md` dan `docs/LOG.md`.

Arah memory engineering mengikuti pemisahan state/context dan evaluasi memori
jangka panjang dari sumber primer: [LongMemEval](https://arxiv.org/abs/2410.10813),
[LoCoMo](https://arxiv.org/abs/2402.17753), serta
[Keep Me Updated](https://aclanthology.org/2022.findings-emnlp.276/). Prinsip
context minimum dan sub-agent terisolasi juga selaras dengan
[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
Pemisahan observation/planning/reflection pada
[Generative Agents](https://arxiv.org/abs/2304.03442), hierarki konteks pada
[MemGPT](https://arxiv.org/abs/2310.08560), dan feedback episodik pada
[Reflexion](https://arxiv.org/abs/2303.11366) menjadi bahan desain, bukan klaim
fitur: Harvy v1 belum menjalankan reflection otomatis, belajar mandiri lintas
pengguna, atau pembaruan bobot model.
