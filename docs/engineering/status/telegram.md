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

- Ketahanan jalur API dipasang di transformer grammY
  (`src/bot/telegram-api-resilience.ts`), bukan sebagai pengawas dari luar.
  `getUpdates` dibatasi 55 detik; soket mati membatalkan dirinya lalu grammY
  membangun ulang koneksi dengan mesin retry-nya sendiri. Kegagalan transport
  dan penolakan API dicatat ke `OperationalLogger`, diringkas satu baris per
  menit per jenis. Sebelum ini grammY melaporkannya hanya lewat `debugErr`
  dan galat polling tidak pernah sampai ke `bot.catch`, sehingga Harvy dapat
  berhenti menerima pesan berjam-jam dengan nol baris log.
- Diuji dari kanal sungguhan 5 September 2026 lewat
  `npm run acceptance:telegram-private` dengan akun penguji berdedikasi. Run
  pertama menemukan regresi berat pada transformer itu sendiri: grammY
  meneruskan `AbortSignal` dari paket polyfill, `AbortSignal.any` menolaknya,
  dan lemparan itu terjadi sebelum permintaan berangkat sehingga grammY
  mengulang diam-diam selamanya—Harvy hidup, polling "berjalan", nol pesan
  sampai. Suite tidak menangkapnya karena tes tidak pernah memberi sinyal
  pemanggil. Diperbaiki, dan empat tes regresi memakai sinyal tiruan bergaya
  polyfill kini mengunci kelasnya.
- Sesudah perbaikan: `onboarding_and_capability_menu` PASS (18,0 dtk, 6
  bubble), `natural_task_and_reminder` PASS (88,9 dtk),
  `dedicated_account_cleanup` PASS. `timezone_session_and_checkin` FAIL dengan
  `EXPECTED_RESPONSE_TIMEOUT` sesudah 185,9 dtk. Attribusinya dikejar terpisah
  dan **bukan berasal dari perubahan itu**; rinciannya di dua butir berikut.
  Rate limit dan gangguan jaringan tetap belum diuji.

- Dua stage acceptance ternyata menguji hal yang bukan kontrak Harvy, dan
  keduanya diperbaiki 5 September 2026 di
  `scripts/telegram-private-live-acceptance.ts`. Keduanya cacat lama, bukan
  akibat perubahan ketahanan kanal.
  - `onboarding_and_capability_menu` menuntut frasa "aku Harvy" dan "AI agent"
    dari naskah perkenalan tetap. Sejak 1 September sapaan pertama dikarang
    model, dan `parseIntroduction` justru **menolak** sapaan yang menyebut AI.
    Stage ini karena itu hanya hijau ketika penyusunan sapaan gagal—ia mengikuti
    kesehatan provider, bukan Harvy. Sekarang tiap gelembung diperiksa pada
    janjinya sendiri: yang dikarang cukup menyebut namanya, sedangkan
    transparansi AI, memori, dan kendali pengguna tetap wajib utuh di gelembung
    persetujuan yang memang naskah tetap.
  - `timezone_session_and_checkin` membuka dengan "Aku kewalahan dengan audit
    …". Harvy hanya menampilkan satu tombol tawaran, dan untuk kalimat yang
    dibuka rasa kewalahan model menaruh `listen` lebih dulu—`listen` tidak
    membuka sesi, sehingga seluruh sisa stage tidak pernah tercapai. Diukur
    lewat `understand()` sungguhan: kalimat lama menghasilkan tombol pembuka
    sesi pada 1 dari 6 percobaan, kalimat penggantinya pada 6 dari 6. Sesudah
    diganti, stage ini PASS (96,7 dtk) sampai check-in proaktif benar-benar
    terkirim beserta kontrolnya.

- Run penuh sesudah kedua perbaikan itu: `onboarding_and_capability_menu`
  PASS (12,7 dtk), `natural_task_and_reminder` PASS (80,8 dtk),
  `timezone_session_and_checkin` PASS (102,6 dtk),
  `multimodal_image_through_private_channel` PASS (31,7 dtk),
  `implicit_memory_after_onboarding_without_item_consent` PASS (29,2 dtk),
  `dedicated_account_cleanup` PASS. `durable_planning_runtime` FAIL dengan
  `EXPECTED_RESPONSE_TIMEOUT` sesudah 180,6 dtk—stage ini belum pernah
  tercapai sebelumnya karena stage zona waktu selalu berhenti lebih dulu.

- **Stage `durable_planning_runtime` menunggu perilaku yang sengaja dihapus,
  dan naskahnya sudah diganti.** Ia meminta rencana audit kualitas Harvy
  sendiri. Pemahaman atas naskah itu sudah tepat—intent request,
  `planningRequired` true, complexity deep, executionSize heavy, confidence
  0,78—tetapi `toolNeed` bernilai `none` pada 3 dari 3 percobaan, dan sejak
  27 Agustus `requiresPlannedExecution` mensyaratkan `execution` atau
  `external`. Syarat itu justru perbaikan atas defect eksplorasi 26 Agustus:
  analisis chat-only membuka AgentRun padahal tidak perlu. Isinya pun tidak
  lagi dilayani: diminta mengaudit dirinya sendiri, Harvy menjawab bahwa ia
  tidak punya akses ke kode, log, maupun telemetry, lalu menawarkan checklist
  dari sisi pengguna. Naskahnya kini pekerjaan riset yang memang berat dan
  membutuhkan pengumpulan sumber, yang membuka jalur durable pada 4 dari 4
  percobaan.

- **Jalur planning durable memang hidup, dan pertama kali terbukti dari kanal
  sungguhan sejak 24 Agustus.** Dengan naskah baru, stage ini pernah PASS penuh:
  anchor dibuat, disematkan selama berjalan, disunting di tempat, dilepas
  sematannya pada keadaan akhir, satu gelembung anchor terlihat, dan rencananya
  lulus penilaian—tiga langkah bernomor, ketiganya memuat Tindakan, Bukti, dan
  Kriteria lulus.

- **Defect: run orchestrate kehabisan deadline sebelum penyintesisnya selesai.**
  Stage ini lulus hanya 3 dari 6 percobaan, dan 0 dari 4 pada batch berikutnya.
  Bagi pengguna akibatnya satu: anchor berakhir "Berhenti" tanpa satu pun
  hasil. Sesudah dua perbaikan 6 September 2026 di bawah, stage ini lulus 6 dari
  6 dari kanal sungguhnya dalam 36,5-79,2 detik, semuanya dengan tiga langkah
  bernomor yang lengkap Tindakan, Bukti, dan Kriteria lulus, satu gelembung
  anchor yang disunting di tempat, disematkan saat berjalan, dan dilepas
  sematannya pada keadaan akhir. Batas waktunya 45.000 ms, ditulis langsung di `Conversation.agent`
  (nilainya sama dengan `DEFAULT_AGENT_RUN_LIMITS.deadlineMs`), dan bentuk
  orchestrate yang Harvy pilih sendiri—planner, worker paralel, penyintesis—
  memang sering hampir tidak muat di dalamnya.

  Sebab pertamanya sudah diperbaiki 6 September 2026, dan sebab itu bukan
  panjangnya pekerjaan melainkan **satu sintesis yang dibuang kode lalu
  dibayar dua kali.** Lihat butir berikut.

- **Diperbaiki: jawaban yang benar dibuang karena melewati angka anjuran.**
  Permintaan yang menyebut "tepat tiga langkah" menurunkan
  `ReplyStructureContract`, dan jawaban akhirnya wajib lewat
  `harvy_structured_steps_v1`. Renderer menolak seluruh jawaban bila satu field
  melewati batas panjang. Batas itu dihitung `structuredFieldMaxCharacters`,
  yang memakai ceiling tetap 1.200 karakter—padahal anggaran sesungguhnya pada
  kontrak tiga langkah tanpa label adalah 2.452, dan yang benar-benar dijaga
  adalah panjang seluruh balasan.

  Terukur pada model sungguhan lewat `scripts/probe-chat.ts` dengan naskah
  acceptance yang sama: model membalas rencana lengkap yang satu langkahnya
  1.305 karakter, kode membuang **seluruh** jawaban karena 105 karakter di atas
  angka anjuran, lalu membayar satu sintesis ulang selama 11-18 detik. Dua dari
  delapan run kena; pada salah satunya sintesis ulang itu dibatalkan deadline
  dan pengguna tidak menerima apa pun.

  Sekarang angka anjuran dan angka yang ditegakkan dipisah:
  `structuredFieldMaxCharacters` tetap memberi 1.200 kepada schema supaya model
  membidik jawaban padat, sementara `structuredFieldBudgetCharacters` yang
  ditegakkan renderer hanya menjaga agar seluruh balasan tetap muat. Delapan
  run sesudahnya: nol penolakan bentuk, dan balasan yang sampai ke pengguna
  memanjang dari 2.358-3.110 menjadi 2.358-3.384 karakter.

- **Penolakan bentuk kini menyebutkan sebabnya.** Sampai 6 September 2026
  penolakan itu tidak meninggalkan satu baris pun: yang terlihat hanya run yang
  berhenti karena deadline, sehingga sebabnya terbaca sebagai "pekerjaannya
  terlalu berat". `structuredStepsRejection` menamai kelasnya beserta angkanya
  —nomor langkah, nomor field, panjang, batas—dan
  `agent_structured_final_rejected` mencatatnya. Isinya angka dan enum saja;
  tidak ada potongan jawaban model.

- **Diperbaiki: lane durable tidak lagi memakai anggaran waktu lane chat.**
  Sesudah penolakan bentuk hilang, sisa kegagalannya satu kelas: satu atau dua
  worker memakan 25-30 detik, penyintesis mulai terlalu dekat dengan dinding,
  lalu dibatalkan. Dua dari delapan probe kena.

  Diukur lebih dulu, bukan ditebak. Lima belas run orchestrate pada model
  sungguhan: sebelas selesai dalam 20,5-42,1 detik, empat sisanya terpotong
  tepat di 45,0 detik. Pada keempatnya worker sudah selesai sekitar detik ke-34
  dan hanya sintesis akhir yang tersisa, sedangkan sintesis terukur 9,4-17,6
  detik—jadi keempatnya membutuhkan sekitar 46-52 detik. Batas 45 detik
  memotong distribusinya tepat di bahu atas. Run yang terpotong juga bukan run
  yang hemat: planner dan seluruh worker sudah dibayar penuh lalu dibuang.

  `DURABLE_AGENT_RUN_DEADLINE_MS` = 75.000 ms sekarang berlaku hanya ketika
  adapter durable menyalakan `durableWork`; lane chat tetap
  `CHAT_AGENT_RUN_DEADLINE_MS` = 45.000 ms karena pengguna menunggunya di
  layar. Lane durable sudah memberi tahu pengguna bahwa ia boleh terus
  mengobrol dan menandai kemajuannya pada anchor yang disematkan, jadi yang
  dibeli di sini bukan kesabaran pengguna di depan layar. Telegram dan WhatsApp
  memakai pagar yang sama.

  Tiga run acceptance sesudahnya lulus, dan salah satunya memakan 79,2 detik
  untuk seluruh stage—bentuk yang tidak akan selesai pada anggaran lama.
  Enam run acceptance berturut-turut sejak kedua perbaikan: semuanya lulus,
  36,5-79,2 detik, ketiganya dengan penilaian kualitas hijau.

- **Yang masih terbuka.** Hipotesis bahwa latensi worker 25-30 detik berasal
  dari `AI_MODE=testing`—yang memetakan ketiga tier ke satu model yang sama,
  sehingga planner dan tiga worker paralel mengantre pada endpoint yang sama—
  belum dapat diuji di host ini. Pada mode testing `resolveModel` memang jatuh
  ke satu model untuk semua tier kecuali override per-tier diisi, dan override
  itu harus menyebut model yang dilayani provider testing; belum ada yang
  dipilih. Model tier production sengaja dikosongkan selama masih testing.
  Selama tier belum benar-benar terpisah, anggaran 75 detik menutupi gejalanya,
  bukan sebabnya.


- **Diperbaiki: percobaan ulang yang tidak menyisakan waktu untuk menjawab.**
  Klien mengulang permintaan yang kena timeout dengan anggaran lebih panjang.
  Di luar AgentRun itu benar—latensi provider ini terukur sangat bervariasi dan
  satu cegukan tidak boleh langsung menjadi "maaf" di layar. Di dalam AgentRun
  ia menghabiskan sisa jendela.

  Seluruh riwayat ledger memuat empat percobaan ulang di dalam run agent,
  semuanya worker, dengan sisa waktu 8,3-10,5 detik. Tiga dibatalkan deadline.
  Yang keempat **selesai**—10,0 detik, 1.061 token—dan runnya tetap berakhir
  tanpa hasil, karena keberhasilan itu memakai seluruh sisa jendela dan tidak
  menyisakan waktu untuk menyusun jawaban. Empat dari empat memakai anggaran
  penuh dan memberi pengguna nol.

  Karena itu yang diperiksa bukan peluang percobaan kedua berhasil, melainkan
  apakah run masih sempat memakai hasilnya. `RunBudgetAccount.remainingWorkMs`
  menyisakan 18 detik terakhir untuk jawaban akhir—diukur dari 14 sintesis yang
  selesai, 4,3-17,6 detik dengan p50 12,0—dan `retryStillFitsRun` menahan
  pengulangan work ketika sisa itu sudah masuk wilayah tersebut. Panggilan
  final tidak ditahan: ia justru yang dilindungi. Di luar AgentRun tidak ada
  RunBudget dan perilaku lama berlaku utuh.

  Terbukti dari lapangan: empat probe sesudahnya memuat tiga timeout worker dan
  **nol** percobaan ulang, dan pada kedua run yang kena, penyintesis
  benar-benar mendapat gilirannya—pada salah satunya ia selesai dalam 5,3
  detik, sesuatu yang tidak pernah terjadi ketika pengulangan masih memakan
  sisa waktunya.
  Tingkat kelulusan batch itu sendiri tidak dapat dibandingkan: worker pada
  batch tersebut berjalan 14-30 detik lawan 4-13 detik pada batch sebelumnya,
  dan empat run bukan sampel.

- **Temuan `unknown_tool`: diberi nama, tidak diperbaiki.** Satu run gagal
  karena penyintesis memanggil tool yang tidak ditawarkan pada langkah itu, dan
  perbaikan yang dibayar penuh untuk itu dibatalkan deadline. Dugaan pertamanya
  delegasi—dicabut dari daftar callable sesudah langkah pertama, sementara
  transcript native masih memuat panggilan model sendiri kepadanya.

  Dugaan itu tidak dapat diuji, karena lognya tidak menyebut tool mana. Itu
  yang diperbaiki lebih dulu: `AiToolShapeError` kini membawa nama tool yang
  ditolak, `classifyUnavailableTool` menggolongkannya menjadi enum tertutup—
  fungsi final teks bebas saat kontrak terstruktur berlaku, delegasi sesudah
  langkah pertama, capability yang tidak callable, atau nama karangan—dan
  `agent_tool_shape_repair` mencatat golongan itu beserta nomor langkahnya.
  Nama dari model tidak pernah masuk log.

  Sesudah itu kelasnya dicoba direproduksi dan **tidak muncul**: 20 run kontrak
  terstruktur pada mode tools dan 10 run orchestrate dengan delegasi, nol
  `unknown_tool`. Yang muncul dua golongan lain—`missing_tool_call` dan
  `multiple_tool_calls`, masing-masing sekali—dan keduanya pulih lewat satu
  perbaikan. Jadi perbaikan bentuk bukan pemborosan yang sistematis; yang
  merugikan hanya perbaikan yang dimulai terlalu dekat dengan dinding waktu.

  Tidak ada perubahan perilaku pada tahap itu. Menukar kebijakan penawaran tool
  atas satu kejadian adalah persis yang dilarang `KNOWN-FAILURES.md`: sebab
  adalah hipotesis sampai dibuktikan.

- **Dugaan itu akhirnya dibuktikan, dari kode dan bukan dari model.** Tiga
  puluh run tidak pernah dapat menunjukkannya, tetapi jalurnya dapat dibaca:
  `agent.delegate.parallel` disaring keluar dari `callableCapabilities` ketika
  `input.step > 0`, sementara `continueAgentNativeThread` tetap mendorong
  panggilan assistant beserta hasilnya ke transcript. Pada langkah kedua model
  membaca riwayat yang memperlihatkan panggilan berhasil ke tool yang sudah
  tidak ada di daftarnya. Itu bukan kebetulan yang menunggu reproduksi; itu
  undangan yang tertulis di dalam permintaan.

  Dua perbaikan menyusul, dan keduanya tidak menyentuh apa yang ditawarkan.
  Hasil tool kini membawa `callableAgain` bernilai false ketika capability-nya
  memang sudah tidak ada di daftar langkah itu, dan `AGENT_PLANNER_SHARED`
  menjelaskan artinya supaya field itu terbaca sebagai aturan. Capability yang
  masih callable tidak diberi penanda apa pun—penanda yang muncul di mana-mana
  akan mengajari model mengabaikannya. Lalu koreksi `unknown_tool` menyebut
  nama function yang ditolak, sejajar dengan koreksi schema di sebelahnya yang
  sudah lama menyebutkannya; sebelumnya ia hanya mengulang aturan yang sudah
  ada di prompt, sehingga satu-satunya perbaikan yang dibayar run itu habis
  untuk teguran tanpa informasi baru. Nama itu berasal dari model dan kembali
  kepada model saja: dipotong 64 karakter, paling banyak dua, tanpa pergantian
  baris, dan tidak pernah masuk log.

  Karena modelnya tidak dapat diminta mengulangi kesalahan itu, buktinya
  dibangun dari kode. Klien double memanggil nama yang pernah ada, dan tesnya
  mengunci dua hal sekaligus: koreksinya menyebut nama yang ditolak, dan run
  tetap selesai. Penanda pencabutannya diperiksa pada tes delegasi yang memang
  sudah ada—langkah kedua di sana sudah lama dikunci tidak lagi menawarkan
  delegasi, dan sekarang hasil tool-nya ikut mengatakannya. Assertion itu
  dibuktikan bukan kosong dengan mematikan satu barisnya: tes yang tepat
  menjadi merah, lalu hijau lagi sesudah dipulihkan.

  Diukur sesudahnya, dan yang dicari adalah regresi, bukan perbaikan. Probe
  delegasi 10 run: nol tool ditolak, sama seperti baseline. Probe terstruktur
  10 run: `multiple_tool_calls` satu kali, nol `unknown_tool`—kelas yang sama
  dengan baseline 20 run. Selisih penyelesaian di kedua probe tidak dianggap
  sinyal; n-nya sepuluh, dan varians corpus di repositori ini pernah memberi
  50, 55, dan 53 lulus pada tiga run penuh yang sama.

- Dua kasus probe baru menyertainya dan tetap ada:
  `npx tsx scripts/coba-agent.ts --kasus=terstruktur --ulangi=N` mengukur
  kontrak bentuk jawaban, dan `--kasus=delegasi --ulangi=N` mengukur bentuk
  orchestrate; keduanya menghitung kejadian log, bukan menebaknya dari balasan.

- Dua alat dibuat untuk mengejar stage ini dan tetap ada.
  `HARVY_TELEGRAM_PRIVATE_ACCEPTANCE_FOCUS=planning` menjalankannya sendirian
  (~1,5 menit, lawan ~8 menit run penuh), dan
  `HARVY_ACCEPTANCE_KEEP_ROOT=1` menahan direktori runtime terisolasi supaya
  log operasionalnya dapat dibaca sesudah run gagal. Laporan run juga kini
  memuat `restartExits` berisi `code` dan `signal` tiap restart; tanpa itu
  satu restart di tengah stage hanya terbaca sebagai angka.

- **Temuan terbuka, tidak diperbaiki di sini.** Untuk "aku kewalahan …, bantu
  aku mulai satu langkah kecil", Harvy menawarkan "Dengerin dulu" saja dan
  menjatuhkan hal yang justru diminta secara eksplisit. Sebabnya
  `adaptiveActions` memotong daftar pada satu tindakan, sementara model
  memberi `listen` peringkat pertama karena nuansa emosinya tinggi. Menaikkan
  `start_small` di atas `listen` akan mendorong tindakan kepada orang yang
  sedang bercerita—wilayah yang dijaga Pasal 3—jadi ini keputusan produk, bukan
  perbaikan tes.

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
- Journey eksploratif terpadatkan `tg-dogfood-20260906a` menyelesaikan 35
  giliran lewat akun penguji, satu restart runtime, shutdown bersih, dan journey
  dipertahankan. Jadwal dipendekkan supaya yang hanya dapat dibuktikan oleh
  waktu berlalu tetap teruji dalam hitungan jam: pengingat lima menit
  benar-benar jatuh sendiri sebagai pesan proaktif berkancing, jeda empat menit
  idle tidak merusak apa pun, konteks bertahan saat topik pindah lalu kembali,
  dan sesudah restart Harvy masih menjawab angka yang disebut sebelum restart.
  Penilaian content-free: usefulness 4, naturalness 3, initiative 4,
  nonRepetition 3, uiClarity 3, contextCoherence 4, correctionHandling 5,
  completion `partial`. **Ini bukan bukti dogfood tujuh hari**—seluruh giliran
  penggunanya dikarang, jadi yang terukur kelas mekanis, bukan kegunaan.

  Journey itu berhenti di giliran 35 karena kuota, dan angkanya layak dicatat
  sendiri: plan `personal_perkenalan` memberi `rolling24hTokenLimit` 200.000
  dengan `rollingWindowHours` 24, sehingga sekitar 30 giliran percakapan seperti
  ini menghabiskan jatah sehari penuh. Copy yang muncul—"Batas pemakaian
  singkat Harvy tercapai. Coba lagi setelah jeda"—membuat pengguna mengira
  jedanya menit, bukan sampai 24 jam. Belum diperbaiki; itu keputusan produk.

- **Diperbaiki: balasan mengaku menyimpan tanpa receipt.** Harvy menjawab
  koreksi dengan "50 yang aku pegang sekarang, yang 30 aku lepas ya 📍",
  sementara seluruh run hanya memuat satu `memory_write_outcome`—dan bukan dari
  giliran itu. Penyimpanannya benar berisi satu catatan. Gerbang penghapus klaim
  dulu menuntut `remembered.uncommitted`, yaitu adanya kandidat yang gagal
  commit, sehingga giliran yang tidak punya kandidat sama sekali lolos utuh.
  Yang menentukan sekarang hanya ada tidaknya receipt code-owned, pada Telegram,
  WhatsApp, maupun grup.

- **Diperbaiki: "udah kelar" tanpa mengubah apa pun.** Pengguna menyatakan tugas
  selesai, Harvy mengiyakan, dan tugasnya tetap `active` di penyimpanan. Rutenya
  benar menolak—`semantic-task-complete` datang dengan confidence 0,72,
  di bawah ambang 0,9—dan giliran dieskalasikan ke Agent Runtime persis seperti
  rancangannya. Log run itu `plannerMode: tools`, `capabilities: none`:
  modelnya memegang `task.manage` dan tidak memanggilnya. Kalimat Harvy sendiri
  bukan klaim palsu, melainkan gema ucapan pengguna, jadi yang ditambahkan
  bukan sensor melainkan satu baris code-owned—`TASK_COMPLETION_NOT_APPLIED`—
  yang hanya muncul ketika tidak ada capability tulis tugas yang benar-benar
  berhasil pada giliran itu.

  Penyebab penolakannya sendiri tidak dapat dipilih dari log: domain, operasi,
  explicitness, dan reference semuanya tercatat di dalam allowlist. Tiga
  pemeriksaan terakhir `semanticOperationAuthorized` karena itu ikut dicatat
  sekarang—ambang confidence, subject, dan kecocokan evidence—dan semuanya
  bebas isi.

- **Diperbaiki: animasi status menahan jawaban sungguhan.** Satu giliran chat
  biasa memakan 4 menit 12 detik (`handlingLatencyMs` 244.596) sementara
  tetangganya 11-28 detik. Di tengahnya `telegram_request_rejected` dan
  `telegram_progress_operation_failed`. Sebabnya bentuk antreannya: 355 dari 434
  surface event journey itu adalah edit animasi pada irama satu detik, dan
  `finish()` menunggu **seluruh** antrean sebelum jawaban dikirim—termasuk edit
  kosmetik yang tertahan batas laju kanal. Tiga hal berubah: denyut yang datang
  selagi render sebelumnya berjalan dibuang alih-alih menumpuk, satu render yang
  ditolak menghentikan denyut seterusnya, dan penutupan berhenti menunggu
  antrean sesudah `closeTimeoutMs`. Penghapusan surface tetap dijalankan; yang
  dilepas hanya kewajiban jawaban ikut menunggunya.

- **Diperbaiki: dua kebocoran kecil yang membuat kontrak terasa kosong.**
  Balasan sempat membacakan protokol kita sendiri—"jadi aku pakai teks biasa
  aja, tanpa perlu panggil tool apa-apa"—padahal aturan promptnya sudah lama
  melarang menyebut nama tool; `withoutToolProtocolNarration` kini membuang
  kalimat yang menceritakan pemanggilan function, dan hanya itu. Dan dua giliran
  sesudah pengguna menekan "Langsung saran", Harvy masih menawarkan "Dengerin
  dulu"; `adaptiveActions` sekarang menerima `stylePreference` dan tidak
  menawarkan mendengarkan kepada pengguna yang sudah memilih saran.

- Yang teramati tetapi tidak diperbaiki: empat kata rusak dalam 35 giliran
  ("ataucampuran", "ngali", "ngebuatanya", "diempetin"), dan satu jawaban basi
  soal jam tenang yang muncul sesudah restart padahal pengaturannya sudah
  tersimpan. Keduanya belum punya sebab yang terbukti.

- **Diperbaiki: "sisa penggunaan" menjawab anggaran yang bukan penghentinya.**
  Run ketiga journey yang sama menguji pertanyaan yang paling sering diajukan
  pengguna. Dashboard `/penggunaan` menjawab dari kuota **periode tagihan**,
  satu-satunya angka yang pernah ditampilkannya, sedangkan yang benar-benar
  menghentikan percakapan adalah jendela **24 jam** pada `rollingComputeLimit`.
  Keduanya nyata, keduanya benar, dan selisihnya besar: dihitung dari
  penyimpanan journey pada plan Perkenalan, periode menyisakan 97% pada saat
  jendela 24 jam tinggal 22,9%—dan sehari sebelumnya jendela itu habis di
  tengah kerja sementara dashboard tetap terbaca 97% dengan "Reset: 6 Oktober".

  Terlihat paling jelas pada giliran ini: pengguna bertanya "sisa penggunaanku
  berapa ya sekarang? kemarin sempat kena batas soalnya", dan jawabannya 97%.
  Bahasa alami dan `/penggunaan` memakai renderer code-owned yang sama, jadi
  tidak ada angka yang dikarang model—yang salah bukan pengambilan angkanya
  melainkan angka mana yang diambil.

  `EconomyUsageView` kini membawa jendela pendek beserta pemakaiannya, dan
  `UserUsageSummary` menurunkan dua hal darinya: `rollingAllowance` dan
  `effectiveAllowance`—anggaran yang sisa **absolut**-nya paling kecil.
  Perbandingannya absolut, bukan persentase, karena dua anggaran ini berbeda
  ukuran: pada plan Perkenalan kolam periode tepat 30 kali jatah hariannya,
  sehingga 97% kolam itu masih jauh lebih besar daripada 100% jatah sehari.

  "Sisa penggunaan" karena itu tidak lagi menampilkan kolam periode melainkan
  anggaran yang mengikat, dan menyebutkan yang mana. Kolam periodenya tidak
  hilang—ia turun menjadi baris "Kuota periode" di bawahnya. Baris "Terpakai"
  juga kini pelengkap dari batang di atasnya, bukan persentase kolam periode
  yang kebetulan berdampingan dengan batang anggaran lain.

  Diverifikasi dari kanal sesudah kuota dikembalikan ke batas paket asli:

      Sisa penggunaan
      █████░░░░░░░░░░░░░░░ 22%
      Yang membatasi sekarang: jatah 24 jam terakhir. Jendela berjalan—yang
      terpakai pulih 24 jam kemudian, bukan pada pergantian hari.

      Kuota periode
      ███████████████████▌ 97%

  Judulnya sempat "Sisa hari ini" pada percobaan pertama, dan itu mengulang
  kekeliruan yang sama dari sisi lain: jendelanya berjalan, bukan hari kalender.
  Yang terpakai pukul sembilan kemarin pulih pukul sembilan hari ini.

  Copy penolakannya ikut dibetulkan. "Batas pemakaian singkat Harvy tercapai.
  Coba lagi setelah jeda" terbaca seperti jeda menit padahal mekanismenya 24
  jam; sekarang ia menyebut batas harian, kapan jatahnya pulih, dan ke mana
  melihat sisanya.

- Run ketiga: tiga giliran, satu restart runtime, shutdown bersih, journey
  dipertahankan. Penilaian usefulness 4, naturalness 4, initiative 3,
  nonRepetition 4, uiClarity 3, contextCoherence 5, correctionHandling 4,
  completion `partial`—scope-nya memang satu pertanyaan, bukan perjalanan penuh.

- **Run keempat: satu masalah yang berjalan, bukan daftar fitur.** 12 giliran di
  atas 43 giliran sebelumnya, satu restart runtime, shutdown bersih, journey
  dipertahankan. Skenarionya pengumpulan data skripsi yang gagal—kuesioner
  terisi 23 dari 60, bimbingan Rabu—supaya yang diukur bukan lagi "apakah
  mekanismenya jalan" melainkan "apakah jawabannya dipakai". Penilaian:
  usefulness 5, contextCoherence 5, correctionHandling 3, initiative 3,
  uiClarity 3, naturalness 2, nonRepetition 2, completion `partial`. Seluruh
  giliran penggunanya tetap dikarang, jadi ini masih bukan dogfood tujuh hari.

  Isinya naik kelas: Harvy memisahkan 23 yang mengisi dari 17 yang memenuhi
  kriteria, menyusun paragraf bab 3 yang memakai ketiga angka dengan benar
  beserta saran sub-bab keterbatasan, dan ketika angka targetnya dikoreksi di
  tengah jalan—dosen menulis minimal 30, yang 60 target sendiri—selisihnya
  berubah 43 menjadi 13 dan kelayakannya dinilai ulang. Diminta mencari jurnal
  untuk dikutip, ia menolak dengan jujur alih-alih mengarang sitasi.

- **Diperbaiki: sapaan berpindah ke lo-gue dan janji berhentinya dilanggar.**
  3 dari 16 bubble jawaban, delapan kejadian, mulai giliran sembilan. Ditegur,
  Harvy menjawab "maaf, kelepasan. balik ke aku-kamu ya"—lalu bubble berikutnya
  pada giliran yang sama memakai lo dan gue empat kali. Sapaan sekarang dimiliki
  kode lewat `harvyPronounRegister`, sejajar dengan ketikan santai dan
  pengakuan-memotong. Ini bukan cermin: pengguna yang menulis lo-gue tetap
  dijawab aku-kamu, karena sapaan bagian dari siapa Harvy, bukan cara menulis.
  Kutipan, pagar kode, dan "gua" yang berarti rongga bukit tidak disentuh.

- **Diperbaiki: kosakata internal bocor ke balasan.** Satu jawaban dibuka dengan
  "Root agen tidak memakai tool untuk menyusun teks."
  `withoutToolProtocolNarration` melewatkannya karena polanya menuntut kata
  kerja memanggil sedangkan kalimat itu memakai "memakai"—dan asumsi yang
  tertulis di komentarnya, bahwa kalimat batas capability yang jujur tidak
  memuat kata kerja memanggil, tidak berlaku untuk laporan tentang eksekusi
  sendiri. Dua bentuk ditambahkan: menyangkal memakai tool, dan menyebut root
  agen. Saran "kamu bisa pakai tool gratis seperti Zotero" tetap utuh.

- **Diperbaiki: rangkuman menyebut hari yang salah.** "buat dibaca pas bimbingan
  besok" pada hari Minggu untuk bimbingan Rabu; seluruh isi rangkumannya benar
  dan hanya bingkai waktunya meleset. Tanggal lengkap sudah lama ada di prompt,
  jadi yang kurang bukan informasinya melainkan hitungannya. `clockNote` kini
  membawa peta empat hari terdekat lengkap dengan nama harinya, dan melarang
  "besok" atau "lusa" untuk hari yang tidak ada di peta itu.

- **Diperbaiki: tiga giliran pertama bertanya tanpa memberi langkah** kepada
  pengguna yang profilnya sudah `stylePreference: advice`. Pertanyaannya
  relevan, tapi orang dengan tenggat dua hari membayar tiga giliran sebelum
  menerima apa pun yang bisa dikerjakan. `styleGuidance` sisi saran dulu tidak
  menyinggung pertanyaan sama sekali; sekarang bertanya boleh, satu saja, dan
  wajib disertai satu langkah yang bisa dikerjakan sekarang.

- **Diperbaiki: syarat dari dosen tidak masuk memori.** "dosenku nulisnya
  minimal 30, bukan 60" hanya hidup di riwayat percakapan sementara catatan
  lama soal purposive sampling—kalimat yang bentuknya sama persis—tersimpan.
  Diukur, bukan ditebak: enam probe pemahaman memberi `memories` kosong enam
  kali. Batas self/work pada aturan ekstraksi tidak pernah menyebut syarat yang
  dijatuhkan orang lain kepada pengguna, sehingga syarat skripsi terbaca sebagai
  isi pekerjaan. Sesudah aturannya ditambah: lima dari enam mengusulkan
  kandidat, dengan sourceSubject `self`.

- **Tidak diperbaiki: kata rusak.** "bimbing rabu" dan "meresponsinnya" pada run
  ini, digabung empat dari run pertama menjadi delapan kejadian. Tidak ada sebab
  di kode yang ditemukan: keluaran provider tidak di-stream, tidak ada pemotongan
  pada jalur balasan, dan log journey tidak memuat pembuangan aksara. Yang
  tersisa adalah mutu keluaran model, dan itu belum dapat dipisahkan selama
  `AI_MODE=testing` memetakan keempat tier ke satu model.

- **Batas giliran gagal 8 dari 48 panggilan**, seluruhnya `aborterror` pada
  tier `cheap`. Distribusinya punya tebing: 40 panggilan yang selesai
  mencatat p50 1.417 ms, p90 2.567 ms, dan maksimum 2.876 ms—tidak satu pun
  mendarat di antara 2.876 ms dan batas 3.500 ms. Karena itu batasnya tidak
  dinaikkan; yang gagal bukan ekor yang mepet melainkan permintaan yang
  tertahan jauh lebih lama, dan itu konsisten dengan empat peran mengantre di
  endpoint yang sama.

- **Verifikasi dari kanal, empat giliran sesudah perbaikan.** Peta hari terbukti
  dipakai: ditanya deadline, Harvy menjawab "hari ini minggu, 6 september. rabu
  9 september berarti sisa tiga hari lagi"—hitungan yang persis meleset pada run
  sebelumnya. Sapaan bersih: nol lo/gue pada sembilan bubble jawaban. Dua cacat
  baru muncul justru dari verifikasi ini.

- **Diperbaiki: klaim menyimpan berbentuk ter- lolos gerbang receipt.** "beres,
  drafnya sudah tersimpan" terkirim utuh pada giliran tanpa satu pun
  `memory_write_outcome`, dan tidak ada berkas yang benar-benar ditulis—
  `terminal.run` memang ditawarkan pada langkah itu, tetapi tidak ada workspace
  maupun artefak sesudahnya. `replyAcknowledgesMemoryWrite` memuat `disimpan`
  dan `dicatat` tetapi tidak `tersimpan` maupun `tercatat`: kata kerja yang sama
  dengan awalan berbeda. Keduanya ditambahkan pada daftar positif sekaligus pada
  penjagaan negasinya, sehingga "belum tersimpan" tetap bukan klaim. `teringat`
  sengaja tidak ikut karena ia penanda recall.

- **Diperbaiki: gaya `advice` dijawab pertanyaan telanjang.** Arahan prompt
  sudah menyebut syaratnya—bertanya boleh, satu saja, wajib menyertakan satu
  langkah—dan tetap dilanggar dua dari empat giliran verifikasi, satu di
  antaranya terhadap permintaan "bikin rencana singkat". Karena itu syaratnya
  ikut menjadi kontrak keluaran: `questionOnlyReply` memeriksa apakah seluruh
  kalimat prosa berbentuk tanya, dan bila pengguna memilih saran, balasan
  seperti itu masuk ke jalur regenerasi yang sama dengan pelanggaran aksara dan
  constraint explicit. Balasan berbutir dan yang menyertakan satu langkah tidak
  tersentuh.

  Diverifikasi ulang dari kanal: pesan yang sama—"bikin rencana singkat: aku
  harus ngapain tiap hari sampai hari pengumpulan"—kini dijawab rencana harian
  Minggu sampai Rabu, dengan nama hari yang benar dan pengingat Selasa ikut
  dirangkai, lalu satu pertanyaan di akhir. Regenerasinya sendiri tidak
  terpanggil pada giliran itu; draf pertamanya sudah memuat langkah, jadi yang
  bekerja adalah promptnya dan `questionOnlyReply` berdiri sebagai jaring.
  Giliran ambigu berikutnya menunjukkan jaring itu tidak terlalu lebar:
  "hah, mana nih? kamu nanya hal apa? aku agak lupa, coba ulangi sebentar"
  tidak dianggap pelanggaran karena kalimat terakhirnya bukan pertanyaan.



- **Tampilan `/penggunaan` diringkas dari 35 baris menjadi 9.** Baris terpanjang
  turun dari 129 karakter menjadi 55. Bentuk lamanya memberi ruang yang sama
  besar kepada hal yang paling sering ditanya dan hal yang hampir tidak pernah
  ditanya: sembilan seksi, tiap label memakan tiga baris, dan "Efisiensi ·
  Hemat dari cache ≈ $0.00" sepadan dengan sisa penggunaan. Jawaban dari
  pertanyaan yang membuat orang membukanya ada di baris 11.

      Penggunaan Harvy · Perkenalan

      Sisa sekarang
      █████░░░░░░░░░░░░░░░ 22%
      Jatah nambah lagi sekitar besok pukul 12.51

      Kuota periode 97% · reset 6 Oktober
      Aktivitas 529.8k masuk (172.1k cache) · 17.5k keluar
      Ditanggung Harvy $0.00 · sebagian biaya belum terhitung

  Yang dihapus dari tampilan hanyalah seksi Efisiensi—cache hit dan hemat
  cache—beserta dua seksi yang mengatakan hal sama dengan cara berbeda ("Sumber
  biaya" dan "Saat ini menggunakan", kini satu baris). Nilainya tetap ada pada
  `UserUsageSummary` bagi pemanggil lain. Peringatan kuota hampir habis tidak
  ikut hilang; ia menempati baris keterangan yang sama.

- **Baris keterangan menyesuaikan diri.** Saat jatah masih longgar ia
  menjelaskan mekanismenya sekali—"Batas 24 jam terakhir, bukan per hari".
  Begitu tinggal seperempat, ia berhenti menjelaskan dan menjawab pertanyaan
  yang sebenarnya: pukul berapa jatahnya bertambah lagi, dihitung dari
  pemakaian tertua yang masih di dalam jendela plus lebar jendelanya
  (`rollingRecoversAt`). Ambang seperempat dipilih dari pengukuran: satu
  giliran percakapan memakan sekitar 2% jatah harian pada plan Perkenalan, jadi
  seperempat berarti belasan giliran lagi—titik ketika "kapan aku bisa lanjut"
  mulai menjadi pertanyaan nyata.

  Keluaran pertamanya di kanal berbunyi "sekitar pukul 12.51" pada pukul
  19.00—jam yang sudah lewat hari itu. Jendela berjalan membuat pemulihan
  selalu berada di dalam 24 jam ke depan, jadi tanggal yang berbeda hanya bisa
  berarti besok, dan sekarang kata itu ikut ditulis.

- Run kedua journey yang sama, 6 September 2026, sesudah keempat perbaikan di
  atas dan sesudah kuota akun penguji dinaikkan lewat kontrol operator
  (`quotaOverride`, hanya pada root journey ini). `resumed: true`, lima giliran,
  satu restart runtime, shutdown bersih, dan seluruh delapan marker mode full
  lengkap. Penilaian: usefulness 4, naturalness 4, initiative 4, nonRepetition
  4, uiClarity 5, contextCoherence 5, correctionHandling 3,
  completion `completed`.

  Tiga perbaikan terverifikasi dari kanal: giliran "aku capek banget, semua
  tugas numpuk" tidak lagi menawarkan "Dengerin dulu" kepada pengguna yang sudah
  memilih "Langsung saran"; dua tugas benar-benar berpindah ke `completed` di
  penyimpanan lewat rute deterministik; dan tidak ada giliran yang tertahan
  seperti 4 menit 12 detik itu. Konteks lintas run juga utuh—Harvy menyebut
  pekerjaan bab 3 dari run pertama dengan tepat.

- **Sisa yang sama, kata yang berbeda.** Pada permintaan "bukan 50, sekarang 60,
  tolong yang 50 dilupakan", Harvy menjawab "oke, 60 bukan 50, udah diganti"
  sementara tidak ada `memory_write_outcome` sama sekali dan penyimpanan tetap
  berisi satu catatan lama. Penanda 📍 memang tidak lagi lolos, tetapi
  "diganti" bukan bagian dari kosakata yang diperiksa
  `replyAcknowledgesMemoryWrite` (`dicatat`, `disimpan`, `diingat`,
  `diperbarui`). Belum diperbaiki: menambah "ganti"/"ubah" ke daftar itu ikut
  menghapus kalimat yang jujur soal dunia pengguna—misalnya "jadwalnya udah
  diganti"—dan buktinya baru satu kejadian.

  Penolakan rutenya sendiri terbukti **benar**: giliran itu membawa
  `intent: control` sekaligus `semantic: memory.forget`, dua sinyal yang
  bertentangan, dan `memoryControlAuthorized` memang menolak memutasi memori
  atas kontradiksi.

- **Regresi yang ditemukan dan diperbaiki di tengah run.** Tiga pemeriksaan
  otorisasi yang ditambahkan pagi itu semula disambung ke string `decision`.
  String itu sudah berada di tepi batas 160 karakter sanitizer log, sehingga
  tambahannya justru membuat **seluruh** keterangan menjadi
  `[REDACTED_SCALAR]`—baris yang paling banyak isinya menjadi yang paling dulu
  hilang. Ketiganya kini menjadi field terstruktur tersendiri di sebelah
  `semanticReference`, dan ketiga kuncinya didaftarkan pada allowlist
  `ALLOWED_DATA_KEYS`; tanpa itu field baru dibuang diam-diam.

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
- Masukan yang dapat diproses hanya teks dan gambar. Dokumen non-gambar,
  pesan suara, dan video dijawab dengan permintaan maaf beserta saran
  screenshot (`src/core/attachment-policy.ts`); tidak ada transkripsi audio
  maupun pembacaan isi PDF/Office, dan tidak direncanakan. ZIP tetap menjadi
  jalur upload project hanya ketika runtime coding terpasang.
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
