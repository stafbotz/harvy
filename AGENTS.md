# Harvy Agent Entry Point

Instruksi ini berlaku untuk Codex, Claude Code, Antigravity, dan coding agent
lain yang bekerja di repositori Harvy, sekaligus untuk manusia yang baru
bergabung.

## Kontrak

Tiga hal ini tidak boleh dilewati, sependek apa pun pekerjaannya.

1. **Baca konteks sebelum menjawab apa pun.** `docs/PROJECT.md`,
   `docs/CONSTITUTION.md`, `docs/engineering/STATUS.md`, dan `docs/LOG.md`.
   Jangan menjawab pertanyaan tentang keadaan proyek dari ingatan, dari nama
   berkas, atau dari dugaan yang terdengar masuk akal.
2. **Jangan mengklaim apa pun yang belum diperiksa.** Kalau sebuah kemampuan
   tidak tercatat di `STATUS.md` dan tidak terlihat di kode, kemampuan itu
   dianggap belum ada. Katakan "belum diperiksa" alih-alih menebak.
3. **Tulis entri `docs/LOG.md` sebelum sesi berakhir** — untuk sesi yang menulis
   kode maupun yang hanya berdiskusi. Diskusi yang menghasilkan keputusan tetapi
   tidak dicatat akan hilang, karena sesi berikutnya tidak dapat membaca
   percakapan ini.

Kontrak ini ada karena pernah dilanggar. Dokumen di repositori ini sempat
mencatat penghapusan tiga berkas yang tidak pernah ada, hanya karena penulisnya
menyusun riwayat yang masuk akal alih-alih memeriksanya. Lihat catatan koreksi
di `ADR-002` dan `ADR-004`.

Nomor 3 tidak bergantung pada niat baik. `.githooks/pre-commit` menolak commit
yang menyentuh `src/`, `tests/`, `docs/`, `AGENTS.md`, atau `README.md` tanpa
perubahan pada `docs/LOG.md`. Instruksi hanya berharap dibaca; hook ini tidak.
Aktifkan sekali per clone — termasuk clone milik agent:

```bash
git config core.hooksPath .githooks
```

Kalau sebuah commit memang tidak layak dicatat, lewati dengan sadar memakai
`git commit --no-verify`, bukan dengan mematikan hook-nya.

## Sebelum bekerja

Repositori ini dikerjakan bergantian oleh manusia dan beberapa AI yang tidak
dapat membaca riwayat percakapan satu sama lain. Karena itu konteks diambil dari
repositori, bukan dari ingatan atau dugaan. Jawab empat pertanyaan ini lebih
dulu:

1. **Proyek ini apa dan untuk siapa?** → `docs/PROJECT.md`
2. **Apa batas moral dan hak penggunanya?** → `docs/CONSTITUTION.md`.
   Konstitusi berkedudukan lebih tinggi daripada dokumen lain di repositori ini,
   dan wajib dibaca untuk perubahan yang menyentuh perilaku produk, memori,
   notifikasi, privasi, keselamatan, atau agensi pengguna.
3. **Apa yang sudah benar-benar berjalan?** → `docs/engineering/STATUS.md`.
   Jangan mengklaim sebuah kemampuan sudah ada tanpa memeriksa dokumen ini atau
   kodenya langsung.
4. **Apa yang dikerjakan terakhir kali, dan kenapa?** → `docs/LOG.md`.

`docs/INDEX.md` memetakan sisanya; baca hanya yang relevan, jangan memuat
seluruh `docs/`. Jika dokumentasi berbeda dari kenyataan kode, ikuti kode dan
laporkan perbedaannya.

## Kepemilikan

- Pengguna Harvy menguasai tujuan produk, ruang lingkup, keputusan material, dan
  penerimaan akhir.
- Satu penulis aktif pada satu waktu. Yang meninjau atau menguji tidak ikut
  mengedit; perbaikan kembali ke penulis yang sama.
- Jangan mendelegasikan edit kepada agent lain atau menjalankan pekerjaan
  paralel yang menulis file, kecuali diminta.
- Agent boleh menulis dan membuat commit langsung pada branch aktif, termasuk
  `main`. Branch terpisah dan pull request bersifat opsional; gunakan hanya bila
  diminta atau memang membantu proses peninjauan. Push tetap hanya dilakukan
  bila diminta.
- Sebelum berpindah alat, commit pekerjaan atau pastikan folder kerja bersih.
  Alat berikutnya tidak dapat melihat perubahan yang masih menggantung.

## Ruang lingkup

Kerjakan yang diminta sampai tuntas, lalu berhenti di situ. Sejak `ADR-005`
tidak ada Work Order, sehingga yang menahan pekerjaan agar tidak melebar hanya
permintaannya sendiri dan penilaian penulisnya.

- Ketika diminta berdiskusi, jelaskan pilihan dan risikonya; jangan mengubah
  file.
- Ketika diminta meninjau atau menguji, laporkan temuan beserta bukti; jangan
  memperbaiki sendiri.
- Ketika menulis, perbarui tes dan dokumentasi yang memang ikut berubah,
  termasuk `docs/engineering/STATUS.md` bila kemampuannya bergeser.

## Perintah pengembangan

```bash
npm ci                 # instal dari lockfile
npm run check          # tsc --noEmit, gerbang tipe
npm test               # build lalu node --test dist/tests/*.test.js
npm run build          # tsc ke dist/
npm run dev            # tsx watch src/app.ts, perlu .env berisi TELEGRAM_BOT_TOKEN
npm start              # jalankan hasil build
```

Tidak ada linter atau formatter terpasang; `npm run check` adalah satu-satunya
gerbang statis. Tes dijalankan dari hasil build, bukan dari `tests/*.ts`, jadi
selalu `npm run build` sebelum memanggil `node --test` secara manual.

`npm run build` tidak membersihkan `dist/`. Setelah menghapus atau mengganti
nama berkas sumber, jalankan `rm -rf dist` lebih dulu agar hasil build lama
tidak ikut dijalankan sebagai tes.

Menjalankan satu berkas tes atau satu kasus:

```bash
npm run build && node --test dist/tests/prioritizer.test.js
npm run build && node --test --test-name-pattern="menandai tugas selesai" dist/tests/*.test.js
```

Menguji pemahaman satu kalimat langsung ke model, tanpa lewat Telegram:

```bash
npx tsx scripts/coba-pemahaman.ts "ingetin aku jam 8 minum obat"
npx tsx scripts/coba-pemahaman.ts --due "besok jam 7 malam"
npx tsx scripts/coba-pemahaman.ts --boundary "aku mau curhat"
```

Menguji bagaimana Harvy *terdengar*, bukan bagaimana ia membaca:

```bash
npx tsx scripts/coba-balasan.ts "aku capek banget hari ini"
npx tsx scripts/coba-balasan.ts --riwayat "yang tadi gimana"
npx tsx scripts/coba-balasan.ts --riwayat=percakapan.json "lanjut dong"
npx tsx scripts/coba-balasan.ts --listen "besok ada ulangan biologi"
```

Keduanya satu-satunya cara memeriksa jalur percakapan tanpa membuka Telegram,
dan satu-satunya yang menampilkan balasan mentah model — termasuk jalur sempit
Ubah tenggat dengan `--due` dan keputusan menyimak bubble dengan `--boundary`.
`coba-balasan.ts` menjalankan lapisan model (pemahaman dan triase paralel,
balasan, lalu review) dan menampilkan normalisasi/pemecahan bubble; ia tidak
menjalankan tombol atau state adapter. `--riwayat`
menyisipkan giliran contoh sehingga kesinambungan dan pengulangan pembuka ikut
terlihat. Tuliskan `\n` di argumen untuk menguji beberapa bubble sekaligus. Ini
membedakan balasan terpotong dari balasan rusak. Perlu `.env` berisi kunci
sungguhan; pakai `AI_MODE=testing` agar gratis. Skrip ini memanggil model, jadi
ia tidak boleh masuk gerbang otomatis. Kedua probe primary-only secara default
agar model tidak salah atribusi; `--allow-fallback` harus dipilih eksplisit dan
menampilkan model cadangannya. Runtime, probe, dan evaluator mengambil lock
atomik yang sama dari `<CONTROL_PLANE_FILE>.runtime.lock`; jangan menjalankan
probe/evaluator pada set data yang sedang dipakai aplikasi. Lock crash tidak
boleh dihapus sebelum PID pemilik dipastikan sudah mati.

Konfigurasi runtime berasal dari `.env` (lihat `.env.example`):
`TELEGRAM_BOT_TOKEN`, `DATA_FILE`, `MEMORY_FILE`, `HISTORY_FILE`,
`MEMORY_FOLDER`, `PROFILE_FILE`, `SESSION_FILE`, `TELEMETRY_FILE`,
`TELEMETRY_RETENTION_DAYS`, `DEFAULT_TIMEZONE`, `REMINDER_INTERVAL_MS`, serta
kelompok `AI_*` termasuk `AI_BASE_URL`, batas token 24 jam, dan harga input /
output tiap tier. Executor web opsional memakai `WEB_SEARCH_ENABLED`,
`WEB_SEARCH_API_KEY`, `WEB_SEARCH_TIMEOUT_MS`, `WEB_OPEN_ENABLED`, dan
`WEB_OPEN_TIMEOUT_MS`; search dan egress open mati secara default serta
diaktifkan terpisah. Control plane lokal memakai `CONTROL_PLANE_FILE`,
`USAGE_LEDGER_FILE`, `ENTITLEMENT_LEDGER_FILE`, retensi ledger,
`BETA_QUOTA_MULTIPLIER`, serta kelompok `HARVY_CONSOLE_*`; Console saat ini
wajib loopback dan bukan server internet-ready. Cadangan mode uji memakai
`AI_TESTING_FALLBACK_BASE_URL`, `AI_TESTING_FALLBACK_API_KEY`,
`AI_TESTING_FALLBACK_MODEL`, `AI_TESTING_FALLBACK_PROVIDER_ID`, dan
`AI_TESTING_FALLBACK_COOLDOWN_MS`; tiga nilai
pertama wajib diisi bersama. WhatsApp beta memakai `WHATSAPP_ENABLED`,
`WHATSAPP_PAIRING_MODE`, `WHATSAPP_ACCOUNTS`, `WHATSAPP_AUTH_FOLDER`,
`WHATSAPP_GROUP_FILE`, serta batas reconnect. Pairing QR lokal adalah default
pengembangan hanya pada terminal interaktif dan tidak pernah ditampilkan saat
`APP_ENV=production`; mode pairing code hanya opsi karena masih mempunyai
kegagalan upstream Baileys. Log operasional memakai `APP_ENV`, `RELEASE_SHA`, `LOG_LEVEL`,
`LOG_FOLDER`, retensi, batas segmen/total/antrean, format console, dan
`LOG_FILE_REQUIRED`. `HISTORY_FILE` berisi kata-kata pengguna apa adanya;
perlakukan sebagai data pribadi, bukan cache. `PROFILE_FILE` menyimpan catatan
persetujuan, preferensi waktu, dan tombstone penghapusan; menghapusnya membuat
semua pengguna diminta menyetujui ketentuannya lagi. Berkas `.env` dibaca lewat
`process.loadEnvFile()`, tanpa dependency tambahan.

ID model tidak boleh ditulis di kode. Nama dan harga model berubah cepat, jadi
semuanya dibaca dari environment agar koreksi cukup satu baris `.env`.
`AI_MODE=testing` memakai model gratis lewat Google AI Studio dengan beberapa
kunci bergantian dan boleh memakai satu provider OpenAI-compatible sebagai
cadangan; `AI_MODE=production` memakai tiga model lewat OpenRouter dan selalu
mengabaikan konfigurasi cadangan testing. Tanpa kunci, bot menolak start.

Harvy Console menginventarisasi seluruh slot model environment yang nonkosong
pada startup—testing default/override, fallback, dan production—tetapi hanya
mengekspos provider/model, mode, origin, tier, nama slot, dan status aktif.
Base URL, key, token pool, dan credential tidak boleh masuk kontrak Console.
Operator memilih satu pasangan katalog dan hanya mengatur harga; server wajib
menolak pasangan buatan. Menghapus model dari `.env` tidak menghapus histori
harganya, tetapi mencegah versi harga baru sampai model dikonfigurasi kembali.

Cadangan testing menerima base URL tanpa `/chat/completions`, query, atau
kredensial. Kuncinya dikirim lewat `Authorization: Bearer`; model dikirim lewat
body dan query karena gateway yang sedang dipakai membutuhkannya. Timeout,
gangguan jaringan, dan HTTP 5xx pada primary langsung pindah provider; HTTP 429
lebih dulu mengikuti batas rotasi kunci primary pada request tersebut (secara
default seluruh kunci). Pembatalan lifecycle, HTTP 4xx lain, keluaran rusak,
serta penolakan kuota lokal tidak boleh memicu cadangan.
Satu kegagalan provider-wide atau 429 yang sudah mengenai seluruh kunci primary
membuka circuit selama cooldown in-memory. Bila request sengaja membatasi
percobaan sebelum semua kunci dicoba, 429 itu boleh failover untuk request
tersebut tetapi tidak membuka circuit bagi request berikutnya.
Evaluator model nyata tetap primary-only secara default agar satu run tidak
diam-diam mencampur model; `--allow-fallback` hanya untuk run availability dan
wajib tercatat pada ringkasannya.

Dalam mode `testing`, `resolveModel` memakai `AI_MODEL_TESTING` untuk semua
tingkatan kecuali yang diberi model sendiri lewat `AI_MODEL_TESTING_CHEAP`,
`AI_MODEL_TESTING_EFFICIENT`, atau `AI_MODEL_TESTING_AMBITIOUS`. Selama peta itu
kosong, routing tetap dihitung tetapi tidak dapat diamati — jangan mengklaim
routing sudah terbukti setelah menguji dalam keadaan itu.

Percakapan yang menyentuh keselamatan memakai tingkatan `efficient`, bukan
`ambitious`. Keputusan pemilik produk 27 Juli 2026: di produksi tingkatan itu
adalah GPT 5.6 Luna dan dinilai cukup.

## Arsitektur

Aliran satu arah: adapter Telegram → layanan → port penyimpanan. Logika inti
tidak mengenal grammY maupun berkas.

- `src/app.ts` — satu-satunya composition root. Merangkai `loadConfig` →
  repository tugas/memori/riwayat/profil/insight/sesi/telemetry → layanan inti
  dan `DataControlService` → `createBot` → worker pengingat dan check-in,
  meneruskan tombstone penghapusan sebelum bot menerima update, mendaftarkan
  command Telegram, dan menangani shutdown.
- `src/domain/` — bentuk data sekaligus port penyimpanan: `task.ts`
  (`StudentTask`, `TaskRepository`), `memory.ts` (`MemoryItem`,
  `MemoryRepository`), `history.ts` (`ConversationHistory`,
  `HistoryRepository`), `profile.ts` (`UserProfile`, `ProfileRepository` —
  status kenalan, versi persetujuan, preferensi gaya/waktu, dan tombstone),
  `insight.ts` (satu-satunya catatan tersembunyi), `session.ts` (sesi aktif dan
  check-in), serta `telemetry.ts` (schema event tertutup tanpa isi percakapan).
  Inti bergantung pada antarmuka ini, bukan pada penyimpanan.
- `src/core/` — bebas I/O dan bebas Telegram: `prioritizer.ts` (skor prioritas
  murni), `task-service.ts`, `memory-policy.ts` (jenis sensitif, masa berlaku,
  pemilihan memori untuk prompt), `memory-service.ts`, `history-policy.ts`
  (jendela dan ambang pemadatan), `history-service.ts`, `profile-service.ts`
  (`CONSENT_VERSION`, `needsOnboarding`, `shouldAskStyle`),
  `safety-policy.ts` (`RiskLevel`, `needsReplyReview`,
  `shouldRaiseProfessionalHelp`), `insight-service.ts` (catatan tersembunyi dan
  riwayat giliran berisiko), `action-policy.ts` (allowlist tindakan adaptif),
  `session-policy.ts` (hubungan sesi lunak dan izin sinyal destruktif),
  `time-policy.ts` (zona waktu dan jam tenang), `session-service.ts` (satu sesi
  persisten dan check-in satu kali), `telemetry-service.ts` (reservasi kuota,
  antrean tulis latar, biaya, retensi, drain, dan generation guard),
  `data-control-service.ts` (ekspor,
  tombstone, dan penghapusan lintas store), serta
  `turn-taking-policy.ts` (jendela adaptif batas giliran dan koreksi bentuk
  kalimat; pagar bahaya lokalnya dipindahkan ke triase risiko).
  `HistoryService` menerima fungsi peringkas episode dari luar supaya `core/`
  tetap bebas jaringan. `episodic-compaction.ts` membuat provenance/hash,
  retensi, dan rendering context v2 tanpa merangkum ulang episode lama;
  compaction membatasi satu request lalu mengejar backlog antar-slot.
  Core grup berada di `group-memory-service.ts` dan `group-turn-service.ts`:
  binding akun, statistik sosial berjendela, konteks pendek beridentitas, FIFO
  per grup, notice, kontrol dua langkah, planner nimbrung, triase/review,
  acknowledgment bahaya di luar FIFO, penanda risiko minimal, generation guard
  removal, matriks authority member/admin, dan shared room memory eksplisit
  dengan preview+konfirmasi admin. Ia tidak menerima dependency memori/profil/
  sesi pribadi.
- `src/ai/` — lapisan Harvy di atas model: `persona.ts` (kepribadian, batas
  moral, aturan keselamatan), `model-policy.ts` (memilih tingkatan model dari
  kesulitan), `understand.ts` (membaca balasan model sebagai masukan tidak
  tepercaya), `client.ts` (HTTP kompatibel OpenAI dengan rotasi kunci),
  `key-pool.ts`, `identity.ts` (jawaban produk "model Capybara"),
  `group-conversation.ts` (planner dan balasan grup), `episode-summary.ts`
  (prompt/parser compaction v2), `research.ts` (planner research serta pagar
  URL sitasi), `context.ts`
  (`HarvyContext`: ringkasan, giliran terakhir, dan
  memori), `safety.ts` (triase risiko, arahan anti-penolakan, pemeriksaan
  balasan, dan prompt pemahaman), dan `conversation.ts` (menyatukan pemahaman,
  balasan, peringkasan episode, dan loop research web).
  Sebelum percakapan, model `cheap` menggolongkan batas bubble sebagai
  `complete`, `open`, `incomplete`, atau `urgent`; kebijakan lokal mengoreksi
  bentuk fragmen, bukan mengenali orang atau bahaya. Giliran yang sudah utuh
  menjalankan ekstraksi dan triase risiko secara paralel, lalu memilih tier
  balasan. Ekstraksi tidak pernah membayar harga model besar; giliran
  `dukungan`/`bahaya` selalu memakai `efficient` dan diperiksa fail-closed
  sebelum dikirim. Tutor memakai `ambitious` hanya pada giliran tenang.
- `src/harness/` — kontrak agent channel-neutral: `scope.ts` membentuk ruang
  privat, grup+anggota, dan Workspace tanpa delimiter collision; Workspace
  membawa membership/role/permission/ACL epoch dan hanya dipercaya setelah
  authority resolver. `capabilities.ts`
  menghasilkan snapshot kemampuan ter-hash sesuai adapter yang benar-benar
  aktif; `context-budget.ts` membatasi perhatian prompt; dan
  `agent-harness.ts` menyediakan loop plan/action/observation berbatas,
  checkpoint pause/resume, approval binding, idempotency key, cancellation,
  cycle guard, dan generation guard. Kernel ini kini dipakai executor baca-saja
  pertama pada research privat; run-nya masih sinkron/in-memory dan workflow
  tugas/memori/sesi tetap deterministik. Workspace surface belum dipasang.
- `src/research/` — executor `web.search`/`web.open`: adapter Brave Search
  endpoint tetap, schema input tertutup, observation berbatas, serta HTTP reader
  yang memvalidasi seluruh DNS publik, mem-pin IP, memeriksa ulang redirect,
  membatasi ukuran/content type, dan membersihkan HTML aktif. Keduanya opsional
  dan hanya tersedia pada privat Telegram ketika dikonfigurasi.
- `src/bot/` — adapter grammY: `create-bot.ts` memasang guard chat pribadi,
  gerbang perkenalan, kontrol data/waktu, alur sesi, dan tombol;
  `message-batcher.ts` menggabungkan bubble serta menyediakan antrean idle bagi
  worker; `onboarding.ts` memuat naskah kenalan, arahan keselamatan
  pra-persetujuan, dan `HeldMessageStore`; `action-offers.ts` menyimpan tawaran
  adaptif bertoken; `phrasing.ts` menyimpan beberapa bentuk untuk tiap kalimat
  tetap Harvy; `messages.ts` memformat keluaran, memecah balasan menjadi bubble,
  serta menyusun keyboard; `understanding-route.ts` memeriksa pasangan
  intent/action sebelum adapter mengubah data; `pending.ts` menyimpan satu
  langkah sementara yang sedang menunggu jawaban.
- `src/storage/` — enam adapter berkas JSON aktif dengan pola yang sama: tulis atomik
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
  satu proses saja.
- `src/whatsapp/` — adapter grup WhatsApp beta berbasis `baileys@7.0.0-rc14`.
  `baileys-account-manager.ts` menjalankan satu auth namespace/socket/reconnect
  supervisor per `accountId`; `baileys-message-normalizer.ts` mempertahankan
  participant PN/LID, tag, quote, dan timestamp;
  `group-message-batcher.ts` menggabungkan burst satu anggota tanpa membuang ID
  bubble; `config.ts` memvalidasi registry banyak nomor. Auth multi-file hanya
  untuk pengembangan lokal, bukan penyimpanan produksi.
- `src/observability/` — logger operasional NDJSON terstruktur yang terpisah
  dari telemetry pengguna: allowlist scalar/redaksi, schema, trace
  `AsyncLocalStorage`, antrean dan file mutex berbatas, rotasi/retensi, repair
  tail crash, backpressure console, process diagnostics, serta adapter logger
  Baileys. QR dan pairing code memakai keluaran operator khusus yang tidak
  persisten dan dilarang pada production/non-TTY.
- `src/reminders/` — worker pengingat tugas dan check-in memakai `setInterval`
  dengan penjaga reentrancy, menunggu owner idle, dan menghormati jam tenang.
  Check-in satu kali memakai transaksi kirim-lalu-tandai. Keduanya masih
  mempunyai jendela at-least-once bila proses mati setelah Telegram menerima
  pesan tetapi sebelum status tersimpan.

Invarian yang harus dijaga:

- **Aktor pekerjaan harus jelas sebelum mengubah tugas.** Permintaan agar Harvy
  membuat, menulis, menerjemahkan, merangkum, menghitung, atau menghasilkan
  sesuatu adalah intent `request`: kerjakan di chat, jangan masukkan ke daftar
  tugas. `task + taskAction: save + task` baru boleh langsung mencatat bila teks
  pengguna sendiri meminta catat/simpan/ingatkan dan payloadnya konkret. Hanya
  `feeling + taskAction: offer + task` yang boleh menawarkan pencatatan setelah
  menjawab; konfirmasinya bertoken. Parser dan adapter sama-sama memeriksa
  kombinasi itu.
- **Langkah tertunda tidak diklasifikasikan ulang sebagai percakapan baru.**
  Khusus Ubah tenggat, pengguna sudah memilih tindakannya lewat tombol; jawaban
  waktunya wajib masuk `Conversation.understandDueDate`, bukan disisipkan ke
  kalimat sintetis lalu dikirim ke `understand`. Tanggal dari model hanya sah
  bila ISO memuat waktu dan offset.
- **Balasan model adalah masukan yang tidak tepercaya.** Selalu lewat
  `understand.ts`; jangan pernah memakai hasil `JSON.parse` mentah dari model.
- **Mutasi tidak boleh bergantung pada klasifikasi model saja.** Daftar memori
  yang terbuka salah dan tugas kosong yang tertulis sama-sama pernah terjadi:
  "kamu pahami aja" membuka seluruh catatan pribadi seseorang lengkap dengan
  tombol Lupakan semua, dan "buat pengingat dong" tersimpan sebagai tugas
  berjudul "Membuat pengingat". Sejak `ADR-008`, penyimpanan tugas mempunyai
  pagar kode lagi: teks pengguna harus meminta catat/simpan/ingatkan dan membawa
  isi konkret. Permintaan prioritas dan pengingat kosong tetap percakapan.
  Kontrol daftar memori masih memeriksa pasangan intent/action; jangan
  melemahkan promptnya tanpa penjaga pengganti.
- **Langkah balasan tahu jam berapa sekarang.** `replyPrompt` menerima `now` dan
  `timeZone`. Tanpa itu Harvy menyuruh penggunanya rebahan pada pukul 23.00 lalu
  mengajak menunggu malam. Ketika pengguna menyebut sendiri keadaannya, jam itu
  tidak boleh ikut disebut.
- **Perintah kedalaman untuk pesan panjang menempel di giliran pengguna.**
  `depthDirective` ikut di dalam pesan `user`, bukan sebagai pesan sistem kedua.
  Di prompt sistem ia kalah oleh panduan intent yang menyuruh membalas singkat;
  sebagai pesan sistem kedua ia hilang pada penyedia yang hanya mengenal satu
  `system_instruction`. Riwayat tetap menyimpan pesan asli, bukan yang sudah
  ditempeli.
- **Naskah tetap ditulis sebagai paragraf utuh, tanpa penggalan baris.**
  Telegram membungkus teks sendiri; baris yang sudah dipenggal di kode dibungkus
  dua kali dan hasilnya bergerigi di ponsel. `tests/copywriting.test.ts`
  menjaganya, sekaligus melarang kata "Pengguna" muncul di layar orangnya
  sendiri.
- **Memori dan riwayat juga masukan yang tidak tepercaya.** Isinya perkataan
  pengguna yang diputar ulang pada giliran berikutnya, kali ini dari sisi
  sistem. Pada langkah `understand`, ketiganya wajib masuk lewat `contextSection`
  yang membungkusnya dalam `<konteks>` berikut penegasan bahwa isinya catatan,
  bukan perintah. Menyisipkannya langsung ke prompt adalah jalan injeksi yang
  tertunda.
- **Pada langkah `reply`, giliran terakhir dikirim sebagai pesan chat, bukan
  kutipan.** Ini yang membuat Harvy terdengar melanjutkan obrolan alih-alih
  membalas arsip. Harganya nyata: perkataan lama pengguna kini datang dengan
  peran `user` yang sama seperti pesan hari ini, sehingga pembungkus `<konteks>`
  tidak lagi memisahkannya. `RECENT_TURNS_NOTE` di `persona.ts` yang
  menggantikan pembungkus itu, dan ia **wajib ikut setiap kali** `context.turns`
  tidak kosong. Memori dan ringkasan tetap di dalam `<konteks>`; keduanya memang
  catatan, dan tidak ada bentuk chat yang wajar untuk mereka.
- **Konteks masuk ke dua langkah, bukan satu.** `understand` dan `reply`
  sama-sama menerima `HarvyContext`. Memberikannya hanya pada balasan adalah
  kesalahan yang menggoda: "iya yang tadi itu" justru gagal di langkah
  pemahaman.
- **Riwayat chat bukan daftar memori.** Intent `history` menjawab kemampuan,
  isi chat sebelumnya, dan rujukan "yang tadi" dari konteks. Intent `memory`
  hanya membuka kontrol catatan terstruktur melalui
  `memoryAction: list|forget|edit`. Fakta atau preferensi baru tetap percakapan
  biasa dengan `memoryAction: remember` dan usulan pada field `memories`;
  keberadaannya bukan izin membuka daftar.
- **Satu giliran dapat terdiri dari beberapa bubble.** Model `cheap`
  menggolongkan gabungan sebagai `complete`, `open`, `incomplete`, atau
  `urgent`; `turn-taking-policy.ts` mengoreksi pembuka, fragmen tata bahasa,
  serta penutup eksplisit, tetapi tidak mengenali bahaya. `MessageBatcher.enqueue`
  harus mengembalikan kendali segera karena long-polling grammY memproses update
  satu per satu. Jeda hening 650 milidetik mengumpulkan burst. Sesudah
  pemeriksaan, pesan lengkap tunggal diproses langsung, gabungan lengkap diberi
  ruang 4 detik, pembuka/narasi terbuka 7 detik, dan fragmen keras 12 detik
  sejak bubble terakhir. Hanya hasil `urgent` dari model yang memotong debounce
  dan mengirim acknowledgment tetap di luar FIFO; timer 12 detik tetap menjadi
  fail-safe saat model berpikir. Handler lengkap dan semua mutasi tetap FIFO di
  belakang handler pengguna yang sudah aktif.
  Satu pemilik hanya boleh memiliki satu pemeriksaan batas yang aktif; revisi
  perantara dikoaleskan ke bubble terbaru. Indikator mengetik hanya dikirim
  setelah batch mulai ditangani dan kegagalannya wajib dianggap kosmetik.
  Balasan pengguna yang sama selalu diproses berurutan. Command menaikkan
  generasi untuk membatalkan batch tertunda—termasuk yang sudah masuk chain
  tetapi belum mulai—lalu menunggu handler aktif; callback menguras batch yang
  lebih dulu masuk sebelum melakukan mutasi. Barrier ini wajib agar balasan lama
  tidak muncul setelah command dan Lupakan semua tidak dapat diikuti
  penyimpanan dari handler lama. Command dan callback hanya **mengantrekan** aksi ini; handler
  grammY tidak boleh menunggu chain tersebut karena long-polling global akan
  menahan update pengguna lain. Permintaan ACK callback dikirim segera secara
  fire-and-forget dan tidak boleh menjadi dependency aksi. Shutdown normal
  menghentikan sumber kerja reminder/check-in dan `bot.stop`, menunggu kedua
  worker aktif selesai, baru memanggil `HarvyBot.drainPending` sebagai gerbang
  terakhir untuk batch, action, evaluator, dan telemetry. Urutan itu wajib
  karena worker dapat menambahkan riwayat atau telemetry terakhir. `app.ts`
  memberi batas shutdown 60 detik sebelum keluar paksa; logger operasional
  di-flush paling akhir setelah seluruh drain dan memakai append sinkron untuk
  catatan fatal timeout. Antrean ini tidak
  persisten dan crash paksa tetap dapat kehilangan update yang sudah diterima.
- **Memori yang dinilai sensitif tidak pernah disimpan tanpa jawaban
  pengguna.** Jenis `personal` atau triase yang menandai isi sensitif selalu
  lewat tombol izin bertoken. Karena pengenalan isi dilakukan model dan tidak
  ada lagi daftar kata lokal, bila ekstraksi **dan** triase sama-sama salah
  menilai isi sensitif sebagai biasa, jalur otomatis masih dapat terlewati.
  Ini keterbatasan yang wajib disebut apa adanya, bukan diklaim sudah tertutup.
  Jenis biasa wajib diumumkan berikut jalan keluarnya di pesan yang sama; bila
  pemberitahuan itu gagal terkirim, catatan yang baru ditulis wajib dibatalkan.
- **Pemberitahuan memori menempel di balasan, bukan menjadi bubble sendiri.**
  `withMemoryNotes` menambahkan satu baris `📎` di ujung bubble terakhir dan
  `memoryNoteActions` memasang tombol Lupakan pada pesan yang sama. Bubble
  tersendiri memenuhi Pasal 4 nomor 2 tetapi memotong percakapan seperti pop-up.
  Karena balasan itu pesan sungguhan, tombolnya memakai `memdrop:` yang hanya
  membuang barisnya lewat `withoutMemoryNote` — bukan `memforget:` yang menimpa
  seluruh pesan dengan daftar memori.
- **Fitur memori tidak boleh hidup tanpa kendalinya.** Daftar, sunting satu,
  lupakan satu, dan lupakan semua adalah bagian dari fiturnya, bukan pekerjaan
  susulan — Pasal 4 nomor 4. Penyuntingan mempertahankan ID, jenis, dan metadata
  serta memeriksa pemilik sebelum menulis. Konfirmasi Lupakan semua, tarik
  persetujuan, dan hapus seluruh data wajib membawa token pending sekali pakai;
  callback lama tidak boleh berlaku pada data yang dibuat setelah promptnya.
- **Kontak pertama berkenalan dulu, dan gerbangnya sebelum `enqueue`.** Pengguna
  yang `consentVersion`-nya belum sama dengan `CONSENT_VERSION` hanya boleh
  mengirim **pesan pertama** ke satu triase keselamatan; ekstraksi, klasifikasi
  batas bubble, personalisasi, telemetry berbasis pemilik, dan bubble berikutnya
  tidak boleh sampai ke model. Gerbang wajib berada di handler `message:text`
  sebelum `MessageBatcher.enqueue`, karena batcher memanggil
  `classifyTurnBoundary`. Pesan pertama ditahan `HeldMessageStore` di memori
  proses — tidak pernah ke berkas — lalu diproses sendiri setelah tombolnya
  ditekan; pengguna tidak diminta mengetik ulang. `/start` hanya salah satu
  pintu masuk, bukan syarat. Pengecualian triase pertama disahkan Konstitusi
  v0.3 Pasal 3.9 dan naskah perkenalan mengatakannya apa adanya. Menghapus
  seluruh memori tidak mereset persetujuan; menarik persetujuan memang
  mengembalikan pesan berikutnya ke gerbang ini tanpa menghapus tugas, memori,
  sesi, atau check-in. Ingress pesan, triase/intro, callback persetujuan, dan
  callback penarikan persetujuan memakai satu rantai per pemilik; callback
  tidak boleh hanya mengambil snapshot sekali lalu membiarkan pesan yang datang
  saat perubahan persetujuan hilang atau terproses ganda.
- **State percakapan mengikuti delivery.** Pertanyaan preferensi gaya baru
  ditandai sudah diajukan setelah Telegram berhasil mengirimnya. Aturan yang
  sama berlaku untuk sesi baru dan kemajuan tahap: kegagalan kirim tidak boleh
  meninggalkan state yang tidak pernah dilihat pengguna. Seluruh prompt
  `PendingStore` juga dibatalkan bila pengirimannya gagal. Bila pembuka sesi
  sudah terlihat tetapi penyimpanan sesi gagal, state parsial dibersihkan dan
  keyboard pesan itu dilepas sebagai kompensasi terbaik.
- **Keselamatan adalah pemeriksaan tersendiri, bukan satu field di antara
  belasan field lain.** `Conversation.triageRisk` berjalan **paralel** dengan
  `understand`, bukan sesudahnya: keduanya memakai model termurah, jadi giliran
  menunggu yang terlama dari dua, bukan jumlahnya. Triase yang gagal tidak
  boleh terlihat seperti percakapan yang baik-baik saja — `parseRiskTriage`
  mengembalikan `null`, dan `understanding.safetySensitive` menjadi jaring
  terakhirnya. Bila ekstraksi menandai sensitif sementara triase berkata biasa,
  konflik itu juga naik ke `dukungan` belum pasti. Semua keadaan belum pasti
  wajib direview dan tidak boleh memutasi tugas, memori, pending, atau sesi.
  Giliran `dukungan` dan `bahaya` memakai tier `efficient` dan balasannya wajib
  lewat `reviewReply` sebelum dikirim. Pemeriksa menerima konteks episode,
  `alone`, dan `certain`; pada triase gagal ia dilarang mengarang bahwa orang
  tua, guru, keluarga, atau teman pasti aman. Penolakan maupun kegagalan review
  memakai fallback berbeda untuk `dukungan` dan `bahaya`, sehingga percakapan
  dukungan tidak menerima copy darurat/112. Tidak ada jalur fail-open.
  Keselamatan menang atas semua route kontrol dan sesi: pada triase non-biasa
  atau belum pasti, hasil operasional ekstraksi dibuang dan sesi tidak masuk
  prompt.
- **Mengarahkan ke manusia tidak boleh menjadi cara menolak membantu.**
  Konstitusi v0.3 Pasal 3.7 dan Pasal 5 nomor 15. Ketika triase menandai
  `alone`, arahan wajib melarang pengulangan saran menghubungi orang terdekat
  dan menggantinya dengan bantuan yang tidak menuntut kepercayaan lebih dulu.
  Nudge profesional otomatis ditangguhkan sejak `ADR-008` sampai false positive
  triase dievaluasi; jangan mengaktifkannya kembali hanya dari satu label model.
- **Pengenalan tentang penggunanya dilakukan model, bukan daftar kata.** Daftar
  kata sensitif, pagar daftar memori, dan pagar bahaya lokal dihapus pada 27
  Juli 2026. `ADR-008` mengembalikan hanya pagar bentuk izin tugas dan payload
  konkret; ia tidak menilai keadaan pribadi. Yang tersisa di
  `turn-taking-policy.ts` hanya penilaian bentuk kalimat — apakah pengguna
  tampak selesai mengetik — dan itu memang bukan pengenalan tentang orangnya.
  Akibat yang diketahui dan diterima: bahaya tidak lagi memotong antrean batas
  giliran kecuali model batas giliran sendiri menyebut `urgent`.
- **Catatan tersembunyi hanya satu jenis, dan batasnya tertulis.**
  `domain/insight.ts` adalah satu-satunya tempat data yang tidak dapat dilihat
  penggunanya. Menambah field di sana berarti memperluas pengecualian terhadap
  Larangan Mutlak; jangan melakukannya tanpa keputusan pemilik produk. Ia ikut
  terhapus pada "Lupakan semua tentang aku" maupun penghapusan penuh. Ia tidak
  masuk ekspor pengguna, sesuai pengecualian Konstitusi, tetapi generation guard
  wajib mencegah refresh latar menghidupkannya kembali setelah penghapusan.
  Runtime hanya menulis triase `bahaya` yang berhasil diparse setelah balasan
  terkirim, menyimpannya 30 hari, dan tidak memasukkan inferensi gaya/tahap/
  kerentanan ke prompt. Saat catatan lama dibaca, field inferensi warisan itu
  dibersihkan secara fisik dan disimpan kembali; `refresh` tidak lagi memanggil
  model atau menghidupkannya.
- **Harvy tidak punya cadangan berbasis aturan.** Provider AI cadangan mode uji
  tidak mengubah invarian ini. Tanpa kunci API yang bekerja, bot tidak dapat
  memproses pesan dan harus mengatakannya terus terang. Cancellation lifecycle
  tidak boleh dianggap gangguan provider lalu menghidupkan failover.
- **"Model Capybara" adalah identitas lapisan Harvy, bukan ID penyedia.**
  Pertanyaan AI/model murni dijawab deterministik oleh `ai/identity.ts` sebelum
  ekstraksi/triase biasa; ia tetap mengakui Harvy sebagai AI dan menjelaskan
  bahwa Capybara memakai beberapa model. Pesan campuran tetap menjalani jalur
  penuh agar permintaan lain/keselamatan tidak dibuang. Nilai `AI_MODEL_*`
  harus tetap berisi ID model penyedia sebenarnya untuk routing dan telemetry.
- **Katalog model Console berasal dari environment, bukan input operator.**
  Snapshot aman dibuat sekali saat startup dari semua slot model yang dikenal.
  Console hanya boleh membuat versi harga bagi pasangan provider+model pada
  snapshot itu; ID environment yang tidak sah menggagalkan startup, bukan
  diam-diam hilang. Katalog tidak dipersistenkan, sedangkan histori harga tetap
  append-only walau model kemudian dihapus atau diganti di `.env`.
- **Log operasional bukan telemetry dan tidak boleh menjadi arsip percakapan.**
  Event boleh membawa waktu, komponen, tahap, trace acak, durasi, status,
  jumlah, tipe/kode/status error, frame stack tanpa baris pesan, dan
  fingerprint. Nama event stabil adalah deskripsi persisten; argumen deskripsi
  bebas sengaja tidak ditulis. Detail event memakai allowlist scalar tertutup;
  `Error.message`, thrown string bebas, serta object tak dikenal tidak
  disimpan. Jangan pernah
  menyerahkan update Telegram, `WAMessage`, node Baileys, request/response
  model, isi chat, prompt/balasan, nama/ID pengguna atau grup, nomor, QR, token,
  atau kredensial kepada logger. Account ID WhatsApp wajib alias operasional
  non-pribadi yang diawali huruf. Trace tidak boleh berasal dari hash identitas.
  `warn`/`error` dicatat di boundary yang mengetahui operasinya; pure core tetap
  melempar error biasa. `LOG_RETENTION_DAYS` hanya menegakkan file lokal;
  collector mempunyai kebijakan retensi terpisah. Lihat `ADR-010`.
- **Capability snapshot, bukan prompt, adalah authority.** Model hanya boleh
  mengusulkan tindakan; kode memeriksa ID+versi capability, surface aktif,
  schema input, policy/approval, idempotency, deadline, cancellation, dan
  generation sebelum executor boleh commit. Isi chat tidak dapat memasang
  capability. `web.search`/`web.open` hanya boleh ditandai tersedia pada privat
  Telegram bila konfigurasi dan executor-nya hidup; jangan memperluas klaim itu
  ke X/Threads, konektor lain, Telegram grup, atau WhatsApp privat.
- **Research read-only tetap mempunyai pagar egress.** Context percakapan lama
  dan memori privat tidak masuk planner research. Satu run hanya boleh
  mengeksekusi satu `web.search`; `web.open` hanya menerima URL kanonik dari
  pesan pengguna atau hasil search sukses run yang sama. Final wajib mempunyai
  observation sukses, dan URL/domain lain harus ditahan. Normalisasi copy
  Telegram tidak boleh mengubah karakter URL. Ini belum menggantikan durable
  run, cancellation dari command/generation luar, atau groundedness per klaim.
- `ownerId` (Telegram `from.id`) adalah batas isolasi data privat lama. Setiap
  metode repository pribadi menerima `ownerId`; jangan menambah kueri tugas
  tanpa itu. Kode channel-neutral baru memakai `AgentScope`: privat adalah
  kanal+owner, anggota grup adalah kanal+grup+anggota, dan Workspace adalah
  workspace+membership+principal+ACL epoch. Kesamaan ID atau nama tidak
  mengizinkan pembacaan lintas scope. Workspace scope harus dibentuk oleh
  authority service, dicocokkan dengan namespace kanonik, dan direvalidasi
  dengan resolver tepercaya sebelum planner atau executor berjalan. Perubahan
  role/membership menaikkan `aclEpoch`; repository authority memakai CAS dan
  scope lama wajib stale. Admin grup tidak menjadi admin Workspace.
- **Grup tidak pernah memakai state pribadi.** `scopeKey` kanal+grup adalah
  batas binding, memori, antrean, dedupe, konteks, dan telemetry grup. Nama atau
  participant yang sama pada dua grup tidak boleh digabung. `GroupTurnService`
  tidak boleh menerima `MemoryService`, `ProfileService`, `InsightService`,
  `SessionService`, tugas, atau history pribadi sebagai dependency.
- **Notice grup harus terkirim sebelum pesan diproses.** Binding menyimpan
  `joinedAt`, notice version, account, dan status disable. `append`/history,
  echo sendiri, pesan tanpa teks, serta timestamp sebelum `joinedAt` diabaikan.
  Event self-add mengaktifkan akun yang sama dan mencoba notice segera; pesan
  live pertama menjadi fallback tanpa kalah oleh presisi jam penerimaan.
  Kegagalan notice menghentikan giliran; removal menaikkan generation sebelum
  menulis disable, membatalkan batch, dan menghapus memori sosial. Disable
  tetap harus masuk antrean penyimpanan saat snapshot binding masih kosong;
  pemeriksaan generation sesudah setiap I/O wajib mencegah implicit activation,
  notice, alias, konteks, atau marker risiko hidup lagi setelah removal.
- **Panggilan grup dan pesan ambient berbeda.** Metadata platform untuk tag dan
  quote serta julukan lokal berbentuk vocative selalu dianggap panggilan;
  penyebutan Harvy sebagai topik bukan panggilan. Direct memakai settle 350 ms,
  membatalkan planner ambient aktif, dan tidak menghabiskan budget sosial.
  Pesan ambient melewati planner `speak|silent`, pagar bentuk lokal, serta
  budget adaptif; planner atau triase yang gagal berarti diam. Kandidat bernilai
  tinggi yang tersusul boleh menjadi satu pending candidate per runtime:
  tunggu quiet gap 900 ms, kedaluwarsa 15 detik/empat giliran, lalu revalidasi
  terhadap konteks aman. Revalidasi baru boleh mulai bila semua observation
  yang sudah terlihat juga sudah settled; timer 900 ms tidak boleh mendahului
  settle adapter 1,2 detik. Direct call, bahaya, kelanjutan pengirim target,
  quote target, removal, atau shutdown wajib membatalkan timer dan request
  revalidation/fact-reply yang sedang aktif. Panggilan langsung
  dengan triase gagal memakai `uncertainTriage` dan review fail-closed. Ketika
  FIFO sedang sibuk, triase awal boleh mengirim acknowledgment tetap untuk
  `bahaya`; reservation/dedupe, batas empat aktif, dan antrean 32 wajib
  dipertahankan. Balasan lengkap tetap FIFO. Harvy tidak mengirim DM dari
  otorisasi grup.
- **Ingress grup tidak menunggu AI.** Normalisasi dan enqueue berurutan per
  grup, tetapi listener Baileys hanya melacak task `onMessage`; ia tidak boleh
  menahan pesan berikutnya sampai planner/balasan selesai. Metadata refresh
  adalah gerbang membership: refresh yang kedaluwarsa boleh ditunggu untuk
  pesan yang sama tetapi wajib berbatas waktu, sedangkan metadata kosong,
  pengirim nonmember, Harvy yang tidak ada di peserta, dan self-echo gagal
  tertutup. Event authority menghapus cache serta membatalkan batch/pending
  pada call stack yang sama sebelum pekerjaan antrean berjalan. Observation
  revision dipasang sebelum speaker switch menutup batch lama; duplicate,
  replay sebelum join, dan akun non-binding tidak boleh membatalkan kandidat
  sah.
- **Natural bukan berarti menyamar sebagai manusia.** Riwayat grup masuk sebagai
  giliran chat beridentitas. Harvy perlu memahami lowercase, singkatan,
  code-mix, elongation, emoji, dan beberapa bubble, tetapi tidak meniru typo,
  mengarang pengalaman/kegiatan fisik, menawarkan DM, mendiagnosis/menuduh
  pasti, atau menjamin transaksi. `fact_correction` harus diregenerasi lewat
  tier `efficient`, bukan mengirim kandidat model cheap sebagai fakta final.
- **Memori grup mempunyai room context dan member memory yang berbeda.** Raw
  context beridentitas hanya berada
  24 giliran atau dua jam di memori proses; pesan **dan balasan** giliran sensitif/berisiko
  tidak masuk. Penanda tingkat risiko tanpa isi boleh hidup 30 menit agar
  jawaban pendek tetap fail-closed. Repository menyimpan nama grup/julukan
  selama aktif, pasangan PN/LID, nama tampilan/koreksi, last-seen dan aktivitas
  harian 30 hari, dedupe 24 jam, serta cooldown; ranking selalu menyebut
  jendela 7 hari dan bukan sifat permanen. Pembersihan berjalan berkala dan
  seluruh memori sosial dihapus saat disable. Memori semantik hanya milik satu
  kanal+grup+anggota, tidak boleh masuk state privat/grup lain, dan hanya boleh
  dipakai saat anggota itu berbicara. Memori biasa hasil pesan direct boleh
  ditulis setelah notice lalu diumumkan pada balasan yang sama; kegagalan kirim
  wajib rollback. Jenis personal atau hasil triase sensitif tidak boleh
  otomatis tersimpan; usulan personal hanya boleh disimpan sesudah anggota
  yang sama mengonfirmasi pending 10 menit dalam scope yang sama. Pending baru
  dipasang setelah promptnya berhasil dikirim dan baru dibersihkan setelah
  acknowledgment sukses; kegagalan acknowledgment wajib rollback write dengan
  identitas proposal yang dipakai saat menyimpan, bukan identitas pesan
  konfirmasi terbaru. Lihat, koreksi, hapus satu, lupakan diri, dan reset admin
  hadir bersama; penghapusan diri/reset wajib konfirmasi kedua 10 menit. Hanya
  admin dapat menambah julukan Harvy. Shared room memory hanya lahir dari
  proposal eksplisit anggota dan konfirmasi admin, kedaluwarsa 60 hari, terlihat
  seluruh grup, dan tidak boleh disamakan dengan member-local memory. Reset
  admin menghapus state bersama tetapi mempertahankan member-local memory.
  Semua mutator user-facing wajib membawa guard authority yang diperiksa di
  dalam antrean service tepat sebelum write. Pada repository file, lupakan diri
  menghapus profil sosial, member-local memory, dan atribusi pengusul room dalam
  satu commit; copy tidak boleh mengaku ledger teknis terhapus bila adapter
  ledger menolak atau gagal.
- **Satu nomor Baileys berarti satu runtime terisolasi.** Auth folder, socket,
  generation, cache metadata, reconnect, dan status tidak boleh dibagi.
  Reconnect wajib mengosongkan cache metadata/admin; refresh memakai epoch per
  grup sehingga completion dari socket lama atau sebelum self-remove tidak
  boleh menghidupkan hak admin basi.
  Binding grup menolak akun kedua dan tidak boleh dipindah otomatis ketika
  nomor gagal. Semua nomor tinggal dalam satu proses selama repository masih
  berbasis berkas. Reconnect wajib menunggu antrean save credentials; listener
  wajib melanjutkan sisa array upsert bila satu pesan gagal dan shutdown wajib
  menunggu pekerjaan event. Shutdown menghentikan ingress, menguras event saat
  socket masih dapat mengirim, menguras batch/pending candidate, baru menutup
  socket dengan `socket.end(undefined)`, bukan `logout()`, lalu menguras
  telemetry/logger paling akhir. Auth multi-file adalah kredensial beta lokal
  yang dilarang masuk Git; produksi memerlukan store database terenkripsi
  dengan single writer.
- **Percakapan dan tombol adalah antarmuka utama, bukan perintah `/`.** Perintah
  hanya pelengkap opsional. Jangan menambah perintah baru sebagai cara memakai
  sebuah fitur; jalannya lewat pesan bebas dan tombol. Untuk tindakan adaptif,
  model hanya boleh mengusulkan ID dari allowlist; label/callback dibangun kode,
  maksimum satu tindakan adaptif per giliran, terikat pemilik, kedaluwarsa, dan
  sekali pakai. Tombol
  operasional untuk objek nyata seperti tugas tetap boleh disusun kode.
- ID tugas tidak pernah ditampilkan kepada pengguna. Semua tindakan berjalan
  lewat tombol inline yang membawa ID di `callback_data`.
- Waktu disimpan sebagai ISO UTC. Input dan tampilan memakai zona IANA profil
  pengguna; `DEFAULT_TIMEZONE` hanya fallback untuk profil lama atau yang belum
  memilih. Jangan mengasumsikan zona waktu proses. Pengingat dan check-in
  menolak waktu lampau atau jam tenang, bukan menggesernya diam-diam. Ini juga
  berlaku pada `remindAt` yang diekstrak langsung dari pesan, bukan hanya alur
  pemilih waktu lewat tombol.
- **Hanya satu sesi aktif per pengguna.** Sesi menjernihkan, memprioritaskan,
  fokus, tutoring, rencana, dan jembatan manusia disimpan persisten. Memulai
  sesi kedua tidak boleh menimpa tujuan pertama. Sesi baru maupun tahap
  tutoring baru hanya di-commit sesudah pesan Telegram yang mewakilinya
  berhasil dikirim; giliran berisiko tidak memajukan tahap. Sesi adalah konteks
  lunak: topik yang tidak berkaitan tidak menerima prompt/tombol sesi dan tidak
  memajukan state, tetapi sesi tetap dapat dilanjutkan. Bentuk jawaban yang
  jelas seperti “karena …” boleh melanjutkan sesi; kalimat pendek biasa tidak
  otomatis dianggap terkait; kata generik “masih”, “belum”, “udah”, atau
  “sudah” bukan bukti hubungan sesi. `done` dari model hanya sah bila kata
  selesai juga merujuk sesi atau tumpang tindih dengan tujuan sesi; `cancel`
  tetap memerlukan teks pengguna yang jelas.
- **Check-in adalah satu kali dan selalu opt-in.** Pengguna memilih waktunya;
  notifikasi generik tidak memuat tujuan. Diabaikan atau dijawab “masih jalan”
  tidak membuat nudge baru. Worker menunggu owner idle dan jam tenang berakhir.
  Penarikan persetujuan tidak menghapus sesi/check-in, tetapi worker menahan
  pengirimannya sampai pengguna menyetujui lagi. Kegagalan membaca kandidat
  reminder/check-in ditangkap agar tick berikutnya tetap berjalan.
- **Ekspor dan penghapusan penuh berbeda dari kontrol memori.** Ekspor memuat
  data yang dapat dilihat pengguna dan mengecualikan insight tersembunyi.
  Penghapusan penuh memasang tombstone profil lebih dulu, menghapus seluruh
  store termasuk insight dan telemetry, lalu menghapus profil terakhir.
  Startup wajib meneruskan tombstone; pekerjaan latar memakai lock/generation
  agar data tidak hidup kembali. Penghapusan menunggu pemadatan riwayat aktif,
  memblokir append/compact baru sampai persetujuan berikutnya, dan memblokir
  request telemetry/model sebelum store lain dibersihkan. Hanya penerimaan
  persetujuan baru yang boleh memanggil `history.allow` dan `telemetry.allow`.
- **Telemetry tidak boleh menyimpan isi.** Schema event tertutup hanya memuat
  owner, tier, tujuan, model, token/perkiraan, latensi, keberhasilan, dan biaya.
  Harga, retensi, dan batas 24 jam berasal dari environment. Reservasi kuota per
  owner harus atomik; triase dan review keselamatan tidak pernah diblokir batas
  biasa tetapi tetap dicatat. Penulisan repository berjalan di latar; summary,
  ekspor, penghapusan, dan shutdown wajib memperhitungkan atau menguras antrean.
  `drain` wajib menunggu antrean eksklusif per pemilik beserta flush
  lanjutannya; kegagalan penulis tidak boleh dilaporkan seolah sudah terkuras.
  Provider-attempt ledger tetap mencatat setiap fetch termasuk fallback,
  kegagalan, dan `schema_rejected`; harga tak diketahui tidak boleh disebut
  nol. Ledger entitlement adalah authority kapasitas: `reply`, `session`, dan
  `group-reply` baru mendebit setelah adapter memastikan delivery. Due-date,
  boundary, understanding, triase, review, ringkasan, insight,
  group-participation, kegagalan parser/delivery, serta keselamatan tidak boleh
  mengurangi paket. Runtime/probe/evaluator wajib memegang local runtime lock
  karena repository JSON hanya aman satu proses.
- `TaskService` menerima `now: () => Date` agar dapat diuji. Tes memakai
  `MemoryRepository` yang mengimplementasi `TaskRepository`, bukan berkas nyata.
- `PendingStore` hanya di memori, satu langkah bertoken per pengguna, hangus
  setelah 10
  menit. Tawaran pencatatan, Ubah tenggat, sunting memori, pemilihan waktu
  pengingat/check-in, jam tenang custom, izin memori sensitif, dan konfirmasi
  destruktif bergantung padanya, jadi semuanya memang mati setelah restart.
  Callback wajib membawa token proposal; klik lama tidak boleh menyimpan
  proposal baru atau menghapus data baru. Pending baru hanya bertahan bila
  promptnya berhasil dikirim. Sesi aktif tidak memakai `PendingStore` dan tetap
  ada setelah restart.
- Jawaban pending tidak menjalankan classifier/ekstraksi umum: burst pendek
  langsung menuju triase lalu parser khusus; triase gagal/berisiko tidak
  mengonsumsi pending.
- Pemadatan riwayat berjalan setelah balasan dan tidak ditunggu pengguna.
  `HistoryService.compact` hanya merangkum awalan mentah satu kali menjadi
  episode v2; model wajib memberi provenance sequence, sedangkan kode membuat
  rentang/source hash dan memeriksa generation, coverage, awalan, serta hash
  sebelum commit. Bubble baru tidak tertimpa, kegagalan menunggu satu menit,
  satu request dibatasi 12 giliran/12.000 karakter, backlog di atas ambang
  dikejar setelah slot dilepas, maksimal dua compaction model berjalan global,
  dan shutdown mengurasnya. Penarikan persetujuan wajib memanggil `suspend`
  sebelum queued compaction dapat mulai memakai model.
  Seluruh giliran mentah yang belum diringkas ikut prompt dengan hard cap 24;
  episode dibatasi 12 dan context hasil render dibatasi 3.000 karakter. Setelah
  raw source dibuang, sequence/hash hanya receipt concurrency/coverage, bukan
  bukti bahwa klaim episode benar secara semantik.
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

Menambah perilaku pribadi biasanya menyentuh, berurutan: tipe di `domain/`, port
repository bila datanya baru, logika dan tes di `core/`, adapter di
`bot/create-bot.ts`, lalu teks di `bot/messages.ts`. Perilaku grup harus masuk
core grup dan adapter kanalnya sendiri; jangan memperluas state grammY pribadi.

## Batas dan verifikasi

- Jangan memasukkan `.env`, token, credential, data pengguna nyata, atau secret
  lain ke Git maupun laporan.
- Jangan menambah dependency, mengubah kontrak data, pengalaman pengguna,
  keamanan, layanan eksternal, atau biaya tanpa diminta.
- Keputusan teknis kecil boleh diambil dan dicatat dalam serah-terima.
- Kumpulkan pertanyaan yang memengaruhi UX, data, keamanan, biaya, atau ruang
  lingkup dan tanyakan sekaligus.
- Gunakan Node.js 22 atau lebih baru.
- Pemeriksaan minimum perubahan kode: `npm run check` dan `npm test`.
- **Gerbang otomatis tidak menyentuh model sungguhan maupun grammY.** Yang
  teruji hanya bagian murni. `npm test` yang hijau tidak membuktikan Harvy dapat
  berbicara, tombolnya hidup, atau pengingatnya terkirim; itu hanya dapat
  dibuktikan lewat uji manual dengan kunci API sungguhan.
- Baca `docs/engineering/STATUS.md` sebelum mengklaim sebuah kemampuan sudah
  ada. Dokumen lain menjelaskan tujuan dan keputusan, bukan keadaan kode.
- Baca `docs/engineering/TESTING.md` untuk bukti tes dan pengujian manual.

## Selesai berarti

Sebuah pekerjaan selesai ketika ada empat hal:

1. perubahan yang terlihat pada diff;
2. hasil `npm run check` dan `npm test` yang benar-benar dijalankan, beserta
   angkanya;
3. keterangan terus terang tentang apa yang **tidak** diuji — percakapan,
   tombol, dan pengingat tidak tersentuh gerbang otomatis; dan
4. satu entri baru di `docs/LOG.md`, ditulis sebelum sesi berakhir.

Entri `LOG.md` adalah satu-satunya cara sesi berikutnya mengetahui apa yang
sudah terjadi. Melewatkannya berarti memaksa penulis berikutnya menebak, dan
tebakan yang masuk akal pernah masuk ke dokumen sebagai fakta yang tidak pernah
terjadi.

Chat yang berkata “selesai” tanpa empat hal itu belum selesai.

Cara kerja selengkapnya ada di `docs/operations/WORKFLOW.md`.
