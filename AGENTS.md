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
`coba-balasan.ts` menjalankan giliran penuh (pemahaman lalu balasan) dan
menampilkan pemecahan bubble persis seperti yang akan dikirim; `--riwayat`
menyisipkan giliran contoh sehingga kesinambungan dan pengulangan pembuka ikut
terlihat. Tuliskan `\n` di argumen untuk menguji beberapa bubble sekaligus. Ini
membedakan balasan terpotong dari balasan rusak. Perlu `.env` berisi kunci
sungguhan; pakai `AI_MODE=testing` agar gratis. Skrip ini memanggil model, jadi
ia tidak boleh masuk gerbang otomatis.

Konfigurasi runtime berasal dari `.env` (lihat `.env.example`):
`TELEGRAM_BOT_TOKEN`, `DATA_FILE`, `MEMORY_FILE`, `HISTORY_FILE`,
`MEMORY_FOLDER`, `PROFILE_FILE`, `DEFAULT_TIMEZONE`, `DEFAULT_UTC_OFFSET`,
`REMINDER_INTERVAL_MS`, serta kelompok `AI_*` termasuk `AI_BASE_URL` yang
menimpa alamat bawaan penyedia. `HISTORY_FILE` berisi kata-kata pengguna apa
adanya; perlakukan sebagai data pribadi, bukan cache. `PROFILE_FILE` menyimpan
catatan persetujuan; menghapusnya membuat semua pengguna diminta menyetujui
ketentuannya lagi. Berkas `.env` dibaca lewat `process.loadEnvFile()`, tanpa
dependency tambahan.

ID model tidak boleh ditulis di kode. Nama dan harga model berubah cepat, jadi
semuanya dibaca dari environment agar koreksi cukup satu baris `.env`.
`AI_MODE=testing` memakai model gratis lewat Google AI Studio dengan beberapa
kunci bergantian; `AI_MODE=production` memakai tiga model lewat OpenRouter.
Tanpa kunci, bot menolak start.

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
  `FileTaskRepository` → `TaskService` → `createBot` → `startReminderWorker`,
  mendaftarkan command Telegram, dan menangani shutdown.
- `src/domain/` — bentuk data sekaligus port penyimpanan: `task.ts`
  (`StudentTask`, `TaskRepository`), `memory.ts` (`MemoryItem`,
  `MemoryRepository`), `history.ts` (`ConversationHistory`,
  `HistoryRepository`), dan `profile.ts` (`UserProfile`, `ProfileRepository` —
  status kenalan, versi persetujuan, dan preferensi gaya). Inti bergantung pada
  antarmuka ini, bukan pada penyimpanan.
- `src/core/` — bebas I/O dan bebas Telegram: `prioritizer.ts` (skor prioritas
  murni), `task-service.ts`, `memory-policy.ts` (jenis sensitif, masa berlaku,
  pemilihan memori untuk prompt), `memory-service.ts`, `history-policy.ts`
  (jendela dan ambang pemadatan), `history-service.ts`, `profile-service.ts`
  (`CONSENT_VERSION`, `needsOnboarding`, `shouldAskStyle`),
  `safety-policy.ts` (`RiskLevel`, `needsReplyReview`,
  `shouldRaiseProfessionalHelp`), `insight-service.ts` (catatan tersembunyi dan
  riwayat giliran berisiko), serta
  `turn-taking-policy.ts` (jendela adaptif batas giliran dan koreksi bentuk
  kalimat; pagar bahaya lokalnya dipindahkan ke triase risiko).
  `HistoryService` menerima fungsi peringkas dari luar supaya `core/` tetap
  bebas jaringan.
- `src/ai/` — lapisan Harvy di atas model: `persona.ts` (kepribadian, batas
  moral, aturan keselamatan), `model-policy.ts` (memilih tingkatan model dari
  kesulitan), `understand.ts` (membaca balasan model sebagai masukan tidak
  tepercaya), `client.ts` (HTTP kompatibel OpenAI dengan rotasi kunci),
  `key-pool.ts`, `context.ts` (`HarvyContext`: ringkasan, giliran terakhir, dan
  memori), `safety.ts` (triase risiko, arahan anti-penolakan, pemeriksaan
  balasan, dan prompt pemahaman), dan `conversation.ts` (menyatukan pemahaman,
  balasan, dan peringkasan).
  Sebelum percakapan, model `cheap` menggolongkan batas bubble sebagai
  `complete`, `open`, `incomplete`, atau `urgent`; kebijakan lokal mengoreksi
  fragmen dan risiko yang jelas. Giliran yang sudah utuh berjalan dua langkah:
  model `cheap` membaca pesan menjadi JSON, lalu tingkatan model untuk balasan
  dipilih dari hasil bacaan itu. Ekstraksi tidak pernah membayar harga model
  besar, dan `safetySensitive` selalu naik ke `ambitious` sekaligus menambahkan
  `SAFETY_ADDENDUM` ke prompt.
- `src/bot/` — adapter grammY: `create-bot.ts` memasang guard chat pribadi,
  gerbang perkenalan, alur percakapan, dan tombol; `message-batcher.ts`
  menggabungkan bubble yang dipenggal; `onboarding.ts` memuat naskah kenalan,
  arahan keselamatan pra-persetujuan, dan `HeldMessageStore`; `phrasing.ts`
  menyimpan beberapa bentuk untuk tiap kalimat tetap Harvy; `messages.ts`
  memformat keluaran, memecah balasan menjadi bubble, serta menyusun papan
  tombol; `understanding-route.ts` memeriksa pasangan intent/action sebelum
  adapter mengubah data; `pending.ts` menyimpan satu langkah percakapan yang
  sedang menunggu jawaban.
- `src/storage/` — empat adapter berkas JSON dengan pola yang sama: tulis atomik
  melalui berkas `.tmp` lalu `rename`, dan serialisasi tulis melalui antrian
  promise agar tidak ada pembaruan yang hilang. `file-task-repository.ts`,
  `file-history-repository.ts`, dan `file-profile-repository.ts`. Memori dan
  catatan tersembunyi memakai bentuk lain: `markdown-memory-repository.ts` dan
  `markdown-insight-repository.ts` menulis satu folder Markdown per pengguna di
  bawah `MEMORY_FOLDER`, sehingga batas isolasi datanya terlihat dari struktur
  direktori dan isinya dapat dibuka manusia. `file-memory-repository.ts` masih
  ada, tetapi hanya sebagai sumber impor sekali jalan. Semuanya aman untuk satu
  proses saja.
- `src/reminders/reminder-worker.ts` — `setInterval` dengan penjaga reentrancy;
  `reminderSentAt` mencegah satu pengingat terkirim dua kali.

Invarian yang harus dijaga:

- **Aktor pekerjaan harus jelas sebelum mengubah tugas.** Permintaan agar Harvy
  membuat, menulis, menerjemahkan, merangkum, menghitung, atau menghasilkan
  sesuatu adalah intent `request`: kerjakan di chat, jangan masukkan ke daftar
  tugas. Hanya `task + taskAction: save + task` yang boleh langsung mencatat
  kewajiban pengguna. Hanya `feeling + taskAction: offer + task` yang boleh
  menawarkan pencatatan setelah menjawab. Parser dan adapter sama-sama
  memeriksa kombinasi itu.
- **Langkah tertunda tidak diklasifikasikan ulang sebagai percakapan baru.**
  Khusus Ubah tenggat, pengguna sudah memilih tindakannya lewat tombol; jawaban
  waktunya wajib masuk `Conversation.understandDueDate`, bukan disisipkan ke
  kalimat sintetis lalu dikirim ke `understand`. Tanggal dari model hanya sah
  bila ISO memuat waktu dan offset.
- **Balasan model adalah masukan yang tidak tepercaya.** Selalu lewat
  `understand.ts`; jangan pernah memakai hasil `JSON.parse` mentah dari model.
- **Dua cabang yang sulit ditarik kembali hanya dijaga prompt.** Daftar memori
  yang terbuka salah dan tugas kosong yang tertulis sama-sama pernah terjadi:
  "kamu pahami aja" membuka seluruh catatan pribadi seseorang lengkap dengan
  tombol Lupakan semua, dan "buat pengingat dong" tersimpan sebagai tugas
  berjudul "Membuat pengingat". Pagar lokalnya dihapus pada 27 Juli 2026 atas
  keputusan pemilik produk, sehingga yang menahannya sekarang hanya aturan
  eksplisit di dalam prompt ekstraksi. Jangan melemahkan aturan itu tanpa
  menggantinya dengan penjaga lain.
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
  hanya membuka atau menghapus catatan terstruktur melalui
  `memoryAction: list|forget`. Fakta atau preferensi baru tetap percakapan biasa
  dengan usulan pada field `memories`; keberadaannya bukan izin membuka daftar.
- **Satu giliran dapat terdiri dari beberapa bubble.** Model `cheap`
  menggolongkan gabungan sebagai `complete`, `open`, `incomplete`, atau
  `urgent`; `turn-taking-policy.ts` mengoreksi pembuka, fragmen tata bahasa,
  penutup eksplisit, dan bahaya segera yang jelas. `MessageBatcher.enqueue`
  harus mengembalikan kendali segera karena long-polling grammY memproses update
  satu per satu. Jeda hening 650 milidetik mengumpulkan burst. Sesudah
  pemeriksaan, pesan lengkap tunggal diproses langsung, gabungan lengkap diberi
  ruang 4 detik, pembuka/narasi terbuka 7 detik, dan fragmen keras 12 detik
  sejak bubble terakhir. Bahaya segera yang dikenali lokal diproses sebelum
  debounce atau request model; timer 12 detik tetap menjadi fail-safe saat
  model berpikir. Ini hanya memotong penantian batas giliran: handler lengkapnya
  tetap FIFO di belakang handler pengguna yang sudah aktif sampai alur
  keselamatan khusus memiliki mekanisme prioritas sendiri.
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
  wajib memanggil `HarvyBot.drainPending` setelah `bot.stop`; drain menunggu
  batch, action, dan evaluator aktif. `app.ts` memberi batas shutdown 60 detik
  sebelum keluar paksa. Antrean ini tidak persisten dan crash paksa tetap dapat
  kehilangan update yang sudah diterima.
- **Memori sensitif tidak pernah disimpan tanpa jawaban pengguna.** Jenis
  `personal` selalu lewat tombol izin. Isi tentang kesehatan, keluarga, relasi,
  gender, orientasi seksual, atau tekanan emosional juga dipaksa ke jalur izin
  meskipun model salah memberi jenis biasa. Jenis lain boleh otomatis tetapi
  wajib diumumkan berikut jalan keluarnya di pesan yang sama. Ini menegakkan
  Konstitusi Pasal 4 nomor 2 dan 3.
- **Pemberitahuan memori menempel di balasan, bukan menjadi bubble sendiri.**
  `withMemoryNotes` menambahkan satu baris `📎` di ujung bubble terakhir dan
  `memoryNoteActions` memasang tombol Lupakan pada pesan yang sama. Bubble
  tersendiri memenuhi Pasal 4 nomor 2 tetapi memotong percakapan seperti pop-up.
  Karena balasan itu pesan sungguhan, tombolnya memakai `memdrop:` yang hanya
  membuang barisnya lewat `withoutMemoryNote` — bukan `memforget:` yang menimpa
  seluruh pesan dengan daftar memori.
- **Fitur memori tidak boleh hidup tanpa kendalinya.** Daftar memori, lupakan
  satu, dan lupakan semua adalah bagian dari fiturnya, bukan pekerjaan susulan —
  Pasal 4 nomor 4.
- **Kontak pertama berkenalan dulu, dan gerbangnya sebelum `enqueue`.** Pengguna
  yang `consentVersion`-nya belum sama dengan `CONSENT_VERSION` tidak boleh
  pesannya sampai ke model. Gerbang wajib berada di handler `message:text`
  sebelum `MessageBatcher.enqueue`, karena batcher memanggil
  `classifyTurnBoundary` dan panggilan itu sudah mengirim teks pengguna ke
  penyedia. Pesan yang telanjur dikirim ditahan `HeldMessageStore` di memori
  proses — tidak pernah ke berkas — lalu diproses sendiri setelah tombolnya
  ditekan; pengguna tidak diminta mengetik ulang. `/start` hanya salah satu
  pintu masuk, bukan syarat. Pesan pertama tetap ditriase lebih dulu untuk
  memeriksa bahaya — pengecualian yang disahkan Konstitusi v0.3 Pasal 3.9 —
  dan naskah perkenalan mengatakannya apa adanya. Menghapus seluruh memori
  tidak mereset persetujuan.
- **Keselamatan adalah pemeriksaan tersendiri, bukan satu field di antara
  belasan field lain.** `Conversation.triageRisk` berjalan **paralel** dengan
  `understand`, bukan sesudahnya: keduanya memakai model termurah, jadi giliran
  menunggu yang terlama dari dua, bukan jumlahnya. Triase yang gagal tidak
  boleh terlihat seperti percakapan yang baik-baik saja — `parseRiskTriage`
  mengembalikan `null`, dan `understanding.safetySensitive` menjadi jaring
  terakhirnya. Giliran `dukungan` dan `bahaya` memakai tier `efficient` dan
  balasannya wajib lewat `reviewReply` sebelum dikirim.
- **Mengarahkan ke manusia tidak boleh menjadi cara menolak membantu.**
  Konstitusi v0.3 Pasal 3.7 dan Pasal 5 nomor 15. Ketika triase menandai
  `alone`, arahan wajib melarang pengulangan saran menghubungi orang terdekat
  dan menggantinya dengan bantuan yang tidak menuntut kepercayaan lebih dulu.
  Bantuan profesional diangkat kembali hanya pada percakapan tenang setelah
  jarak beberapa hari — `shouldRaiseProfessionalHelp`, bukan pada giliran yang
  sedang berat.
- **Pengenalan tentang penggunanya dilakukan model, bukan daftar kata.** Daftar
  kata sensitif, pagar daftar memori, pagar tugas kosong, dan pagar bahaya lokal
  dihapus pada 27 Juli 2026 atas keputusan pemilik produk. Yang tersisa di
  `turn-taking-policy.ts` hanya penilaian bentuk kalimat — apakah pengguna
  tampak selesai mengetik — dan itu memang bukan pengenalan tentang orangnya.
  Akibat yang diketahui dan diterima: bahaya tidak lagi memotong antrean batas
  giliran kecuali model batas giliran sendiri menyebut `urgent`.
- **Catatan tersembunyi hanya satu jenis, dan batasnya tertulis.**
  `domain/insight.ts` adalah satu-satunya tempat data yang tidak dapat dilihat
  penggunanya. Menambah field di sana berarti memperluas pengecualian terhadap
  Larangan Mutlak; jangan melakukannya tanpa keputusan pemilik produk. Ia ikut
  terhapus pada "Lupakan semua tentang aku".
- **Harvy tidak punya cadangan berbasis aturan.** Tanpa kunci API, bot tidak
  dapat memproses pesan dan harus mengatakannya terus terang.
- `ownerId` (Telegram `from.id`) adalah batas isolasi data. Setiap metode
  repository menerima `ownerId`; jangan menambah kueri tugas tanpa itu.
- **Percakapan dan tombol adalah antarmuka utama, bukan perintah `/`.** Perintah
  hanya pelengkap opsional. Jangan menambah perintah baru sebagai cara memakai
  sebuah fitur; jalannya lewat pesan bebas dan tombol. Tombol yang ditawarkan
  seharusnya adaptif menurut keadaan percakapan, disusun AI — saat ini masih
  papan tombol tetap di `bot/messages.ts`, dan itu tercatat sebagai kesenjangan
  di `docs/engineering/STATUS.md`.
- ID tugas tidak pernah ditampilkan kepada pengguna. Semua tindakan berjalan
  lewat tombol inline yang membawa ID di `callback_data`.
- Waktu disimpan sebagai ISO UTC. Input diurai memakai `DEFAULT_UTC_OFFSET`,
  tampilan memakai `DEFAULT_TIMEZONE`. Belum ada zona waktu per pengguna;
  jangan mengasumsikan zona waktu proses.
- `TaskService` menerima `now: () => Date` agar dapat diuji. Tes memakai
  `MemoryRepository` yang mengimplementasi `TaskRepository`, bukan berkas nyata.
- `PendingStore` hanya di memori, satu langkah per pengguna, hangus setelah 10
  menit. Tombol "Ya, catat" dan alur "Ubah tenggat" bergantung padanya, jadi
  keduanya memang mati setelah proses restart. Itu keadaan normal, bukan galat.
- Pemadatan riwayat berjalan setelah balasan dan tidak ditunggu pengguna.
  `HistoryService.compact` menggabungkan hasil ke versi terbaru agar bubble yang
  datang selama model bekerja tidak tertimpa; kegagalan menunggu satu menit
  sebelum dicoba lagi.
- Proyek ini ESM dengan `module: NodeNext`. Impor antarmodul wajib berakhiran
  `.js` meskipun sumbernya `.ts`.
- `tsconfig.json` memakai `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, dan `noUnusedLocals`. Indeks array menghasilkan
  tipe opsional, dan impor atau fungsi lokal yang tidak pernah dipakai
  menggagalkan `npm run check` alih-alih diam-diam lolos.
- `include` mencakup `src/`, `tests/`, **dan** `scripts/`. Skrip diagnostik ikut
  diperiksa tipe dan ikut dibangun ke `dist/scripts/`; ia tidak ikut dijalankan
  `npm test`, karena glob tesnya hanya `dist/tests/*.test.js`.
- Di chat non-pribadi, Harvy hanya menjawab perintah dan mengabaikan pesan lain.
  Pesan bebas hanya diproses di chat pribadi, dan di sana itulah jalur utamanya.

Menambah perilaku baru biasanya menyentuh, berurutan: tipe di `domain/`, port
`TaskRepository` bila datanya baru, logika dan tes di `core/`, perintah di
`bot/create-bot.ts`, lalu teks di `bot/messages.ts`.

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
