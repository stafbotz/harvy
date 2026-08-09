# Invarian Harvy

Dokumen ini berisi aturan-aturan yang **harus dijaga** ketika mengubah kode
Harvy. Baca bagian yang relevan dengan area yang sedang dikerjakan — tidak
perlu membaca seluruh dokumen.

Invarian ini dipindahkan dari `AGENTS.md` agar agent coding hanya memuatnya
saat menyentuh area terkait, alih-alih membawa seluruhnya di setiap sesi.

---

## Tugas dan mutasi

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
- `TaskService` menerima `now: () => Date` agar dapat diuji. Tes memakai
  `MemoryRepository` yang mengimplementasi `TaskRepository`, bukan berkas nyata.
- ID tugas tidak pernah ditampilkan kepada pengguna. Semua tindakan berjalan
  lewat tombol inline yang membawa ID di `callback_data`.
- Waktu disimpan sebagai ISO UTC. Input dan tampilan memakai zona IANA profil
  pengguna; `DEFAULT_TIMEZONE` hanya fallback untuk profil lama atau yang belum
  memilih. Jangan mengasumsikan zona waktu proses. Pengingat dan check-in
  menolak waktu lampau atau jam tenang, bukan menggesernya diam-diam. Ini juga
  berlaku pada `remindAt` yang diekstrak langsung dari pesan, bukan hanya alur
  pemilih waktu lewat tombol.

## Percakapan dan balasan

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
- **Percakapan dan tombol adalah antarmuka utama, bukan perintah `/`.** Perintah
  hanya pelengkap opsional. Jangan menambah perintah baru sebagai cara memakai
  sebuah fitur; jalannya lewat pesan bebas dan tombol. Untuk tindakan adaptif,
  model hanya boleh mengusulkan ID dari allowlist; label/callback dibangun kode,
  maksimum satu tindakan adaptif per giliran, terikat pemilik, kedaluwarsa, dan
  sekali pakai. Tombol
  operasional untuk objek nyata seperti tugas tetap boleh disusun kode.

## Bubble dan giliran

- **Satu giliran dapat terdiri dari beberapa bubble.** Emergency preflight
  berpresisi tinggi berjalan saat `enqueue`, sebelum debounce; hasil
  positif hanya mengirim acknowledgment tetap dan mempercepat flush, bukan
  menetapkan disposition atau izin mutasi. Pada jalur boundary umum setelah
  fast path/pending dikecualikan, satu bubble dalam closed set diputus lokal
  sebagai `complete`/`incomplete`; multi-bubble dan bentuk ambigu memakai model
  `cheap` sebagai fallback `complete|open|incomplete|urgent`. Guard lokal tetap
  mengoreksi bentuk hasil itu. Debounce mempelajari p90 gap antar-arrival,
  termasuk lintas batch yang sudah ter-flush, dari maksimum 32 sampel
  content-free per pemilik setelah tiga sampel; state hanya di RAM, kedaluwarsa
  dua jam tanpa diperpanjang oleh akses, dibatasi 5.000 subjek, dan dilupakan
  saat invalidasi.
  Sebelum cukup sampel, settle tetap 650 ms. Estimasi adaptif mengubah settle
  awal dan ruang gabungan lengkap, sedangkan pembuka/narasi terbuka dan fragmen
  keras tetap menunggu 7/12 detik sejak bubble terakhir. Emergency lokal maupun hasil `urgent` model
  mengirim acknowledgment di luar FIFO; timer 12 detik tetap fail-safe saat
  model berpikir. Sinyal `explicitImmediateDanger` per bubble dan
  `urgentBoundary` wajib bertahan sebagai metadata sampai handler; merge teks
  tidak boleh menghapus kewajiban acute triage. Jalur urgent menaikkan
  generation dan mengirim `AbortSignal`:
  batch biasa lama yang belum mulai dibatalkan, sedangkan handler lengkap dan
  semua mutasi tetap FIFO di belakang handler pengguna yang masih aktif.
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

## Memori

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
- **Memori yang dinilai sensitif tidak pernah disimpan tanpa jawaban
  pengguna.** Jenis `personal` atau classifier `memory-privacy` yang menandai
  kandidat sensitif selalu lewat tombol izin bertoken. Classifier itu hanya
  dipanggil setelah compiler benar-benar menghasilkan kandidat; parse invalid,
  timeout, atau error dianggap sensitif. Karena pengenalan isi dilakukan model
  dan tidak ada daftar kata lokal, bila ekstraksi dan classifier sama-sama
  salah menilai kandidat sensitif sebagai biasa, jalur otomatis masih dapat
  terlewati. Ini keterbatasan yang wajib disebut apa adanya, bukan diklaim sudah
  tertutup.
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

## Keselamatan

- **Keselamatan adalah pemeriksaan tersendiri dan dipanggil secara selektif.**
  Pada chat privat pasca-consent, compiler `cheap` menghasilkan `RiskHint`
  `none|possible|strong`; hint adalah routing data, bukan disposition. Hint
  `none` melewati acute triage, sedangkan `possible|strong` memanggil
  `Conversation.triageRisk`. Emergency lokal langsung masuk lane triage tanpa
  compiler umum setelah consent; pada pesan pertama pra-consent ia mengirim
  copy safety lokal tanpa menunggu/provider call. Bila compiler gagal, triage
  tetap dipanggil karena ketiadaan hint bukan bukti aman.
- **Outage tidak sama dengan krisis.** Policy privat mempertahankan disposition
  `calm|support|danger|unavailable`. `possible + calm` kembali normal;
  `strong + calm` menjadi support belum pasti; triage unavailable tanpa bukti
  kuat tetap memakai jalur biasa, sedangkan bukti kuat memakai jalur safety
  konservatif. `strong + support` tetap high-consequence uncertainty. Support
  pasti biasanya langsung; support belum pasti dan danger wajib lewat
  `reviewReply`. Kegagalan generation atau review pada jalur safety memakai
  fallback berbeda untuk support dan danger, sehingga support tidak menerima
  copy darurat/112.
- **Keselamatan memberi izin per efek, bukan global mutation switch.**
  Task/reminder biasa yang diminta eksplisit boleh berjalan pada support pasti
  atau unavailable tanpa bukti kuat. Kontrol eksplisit atas data pengguna
  sendiri—list/edit/forget memory, export, delete, dan withdraw consent—memakai
  izin low-risk yang sama; emotional support tidak boleh mencabut hak Pasal
  2.5. Kandidat memori baru, pending implisit, sesi, tawaran, dan state
  percakapan lain hanya boleh berubah pada calm yang pasti. Emergency lokal,
  danger, dan bukti kuat yang belum terselesaikan tidak boleh memulai efek yang
  bersaing dengan lane safety. Session context hanya masuk prompt ketika izin
  general-state terbuka. Penolakan explicit route dicatat content-free sebagai
  `safe-action-blocked`; tidak ada jalur fail-open untuk efek berbahaya atau
  tidak relevan.
- **Mengarahkan ke manusia tidak boleh menjadi cara menolak membantu.**
  Konstitusi v0.3 Pasal 3.7 dan Pasal 5 nomor 15. Ketika triase menandai
  `alone`, arahan wajib melarang pengulangan saran menghubungi orang terdekat
  dan menggantinya dengan bantuan yang tidak menuntut kepercayaan lebih dulu.
  Nudge profesional otomatis ditangguhkan sejak `ADR-008` sampai false positive
  triase dievaluasi; jangan mengaktifkannya kembali hanya dari satu label model.
- **Disposition keselamatan tetap milik triase, bukan daftar kata.** Sejak
  `ADR-021`, pure policy terpisah boleh mengenali pernyataan bahaya langsung
  dengan pelaku/korban yang cukup jelas dan berjangka segera untuk satu tujuan
  sempit: acknowledgment sebelum debounce. Ia tidak menyatakan pengguna aman/bahaya, tidak menyimpan
  memory, dan tidak memberi izin atau menolak mutasi; pipeline triase penuh dan
  review sesuai disposition/policy tetap berjalan. Kutipan, negasi, histori,
  contoh, idiom, distress samar, dan bentuk lain tetap jatuh ke model. Policy
  boundary terpisah hanya menilai
  bentuk satu bubble dari closed set; pada jalur boundary umum, multi-bubble dan
  ambiguitas memakai model.

## Onboarding dan persetujuan

- **Kontak pertama berkenalan dulu, dan gerbangnya sebelum `enqueue`.** Pengguna
  yang `consentVersion`-nya belum sama dengan `CONSENT_VERSION` hanya boleh
  mengirim **pesan pertama** ke satu triase keselamatan bila emergency policy
  lokal tidak sudah memilih copy deterministik; ekstraksi, klasifikasi batas
  bubble, personalisasi, telemetry berbasis pemilik, dan bubble berikutnya tidak
  boleh sampai ke model. Gerbang wajib berada di handler `message:text`
  sebelum `MessageBatcher.enqueue`, karena batcher memanggil
  `classifyTurnBoundary`. Pesan pertama ditahan `HeldMessageStore` di memori
  proses — tidak pernah ke berkas — lalu diproses sendiri setelah tombolnya
  ditekan; pengguna tidak diminta mengetik ulang. Batas bubble wajib tetap
  disimpan, tetapi bubble selain yang pertama baru boleh diperiksa per bagian
  setelah consent aktif; marker konteks lama tidak boleh memveto emergency pada
  bubble baru. `/start` hanya salah satu
  pintu masuk, bukan syarat. Pengecualian triase pertama disahkan Konstitusi
  v0.3 Pasal 3.9 dan naskah perkenalan mengatakannya apa adanya; emergency
  lokal justru tidak mengirim teks ke provider. Menghapus
  seluruh memori tidak mereset persetujuan; menarik persetujuan memang
  mengembalikan pesan berikutnya ke gerbang ini tanpa menghapus tugas, memori,
  sesi, atau check-in. Ingress pesan, triase/intro, callback persetujuan, dan
  callback penarikan persetujuan memakai satu rantai per pemilik; callback
  tidak boleh hanya mengambil snapshot sekali lalu membiarkan pesan yang datang
  saat perubahan persetujuan hilang atau terproses ganda.
- **Hak menarik izin dan menghapus data tidak boleh digagalkan pre-clear run.**
  Penarikan izin menutup ingress/history dan mempersistenkan profil lebih dulu,
  lalu cleanup checkpoint dilakukan best-effort dengan scope tetap diblokir
  bila I/O gagal. Penghapusan penuh harus mencapai tombstone profil sebelum
  store run disentuh. Sebaliknya, consent baru tidak boleh dipersistenkan sampai
  cleanup checkpoint consent lama benar-benar berhasil; hanya sesudah itu scope
  boleh dibuka lagi.
- **State percakapan mengikuti delivery.** Pertanyaan preferensi gaya baru
  ditandai sudah diajukan setelah Telegram berhasil mengirimnya. Aturan yang
  sama berlaku untuk sesi baru dan kemajuan tahap: kegagalan kirim tidak boleh
  meninggalkan state yang tidak pernah dilihat pengguna. Seluruh prompt
  `PendingStore` juga dibatalkan bila pengirimannya gagal. Bila pembuka sesi
  sudah terlihat tetapi penyimpanan sesi gagal, state parsial dibersihkan dan
  keyboard pesan itu dilepas sebagai kompensasi terbaik.

## Sesi dan check-in

- **Hanya satu sesi aktif per pengguna.** Sesi menjernihkan, memprioritaskan,
  fokus, tutoring, rencana, dan jembatan manusia disimpan persisten. Memulai
  sesi kedua tidak boleh menimpa tujuan pertama. Sesi baru maupun tahap
  tutoring baru hanya di-commit sesudah pesan Telegram yang mewakilinya
  berhasil dikirim; giliran berisiko tidak memajukan tahap. Sesi adalah konteks
  lunak: topik yang tidak berkaitan tidak menerima prompt/tombol sesi dan tidak
  memajukan state, tetapi sesi tetap dapat dilanjutkan. Bentuk jawaban yang
  jelas seperti "karena …" boleh melanjutkan sesi; kalimat pendek biasa tidak
  otomatis dianggap terkait; kata generik "masih", "belum", "udah", atau
  "sudah" bukan bukti hubungan sesi. `done` dari model hanya sah bila kata
  selesai juga merujuk sesi atau tumpang tindih dengan tujuan sesi; `cancel`
  tetap memerlukan teks pengguna yang jelas.
- **Check-in adalah satu kali dan selalu opt-in.** Pengguna memilih waktunya;
  notifikasi generik tidak memuat tujuan. Diabaikan atau dijawab "masih jalan"
  tidak membuat nudge baru. Worker menunggu owner idle dan jam tenang berakhir.
  Penarikan persetujuan tidak menghapus sesi/check-in, tetapi worker menahan
  pengirimannya sampai pengguna menyetujui lagi. Kegagalan membaca kandidat
  reminder/check-in ditangkap agar tick berikutnya tetap berjalan.

## Catatan tersembunyi

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

## Ekspor dan penghapusan

- **Ekspor dan penghapusan penuh berbeda dari kontrol memori.** Ekspor memuat
  data yang dapat dilihat pengguna dan mengecualikan insight tersembunyi.
  Ekspor AgentRun hanya membawa request, status/revision, progress, observation,
  input, isi mailbox, ChangeSet/work unit, receipt yang sudah membuang effect
  ID, hasil, dan counter usage. Snapshot konteks, capability/scope hash, price
  snapshot, serta limit anti-abuse internal tidak boleh keluar bersama
  checkpoint mentah.
  Penghapusan penuh memasang tombstone profil lebih dulu, menghapus seluruh
  store termasuk insight dan telemetry, lalu menghapus profil terakhir.
  Startup wajib meneruskan tombstone; pekerjaan latar memakai lock/generation
  agar data tidak hidup kembali. Penghapusan menunggu pemadatan riwayat aktif,
  memblokir append/compact baru sampai persetujuan berikutnya, dan memblokir
  request telemetry/model sebelum store lain dibersihkan. Hanya penerimaan
  persetujuan baru yang boleh memanggil `history.allow` dan `telemetry.allow`.

## Telemetry

- **Telemetry tidak boleh menyimpan isi.** Schema event tertutup hanya memuat
  owner, tier, tujuan, model, token/perkiraan, latensi, keberhasilan, dan biaya.
  Harga, retensi, dan batas 24 jam berasal dari environment. Reservasi kuota per
  owner harus atomik; triase dan review keselamatan tidak pernah diblokir batas
  biasa tetapi tetap dicatat. Penulisan repository berjalan di latar; summary,
  ekspor, penghapusan, dan shutdown wajib memperhitungkan atau menguras antrean.
  `drain` wajib menunggu antrean eksklusif per pemilik beserta flush
  lanjutannya; kegagalan penulis tidak boleh dilaporkan seolah sudah terkuras.
  Provider-attempt ledger tetap mencatat setiap fetch termasuk fallback,
  kegagalan, `schema_rejected`, `truncated`, dan `incomplete`; harga tak
  diketahui tidak boleh disebut nol. Role, requested/effective effort, dan
  verbosity boleh dicatat sebagai metadata tertutup, tetapi raw reasoning dan
  assistant turn provider tetap dilarang. Ledger entitlement adalah authority
  kapasitas: `reply`, `session`, dan
  `group-reply` baru mendebit setelah adapter memastikan delivery. Due-date,
  boundary, understanding, triase, review, ringkasan, insight,
  group-participation, kegagalan parser/delivery, serta keselamatan tidak boleh
  mengurangi paket. Runtime/probe/evaluator wajib memegang local runtime lock
  karena repository JSON hanya aman satu proses.
- **Satu giliran free-text Telegram memakai satu `turnId` dari boundary sampai
  handler terminal.** Telemetry v3 memisahkan waktu menunggu bubble, FIFO, dan
  handler; menghitung logical model purpose serta sinyal operasional tertutup;
  lalu menutup outcome sebagai completed/failed/cancelled. Turn tanpa model
  tetap menjadi denominator rate. Record dilarang membawa prompt, balasan,
  reasoning, tool output, atau label risiko seseorang dan wajib ikut retensi,
  export, full deletion, generation block, flush, serta drain telemetry. Retry
  terminal turn wajib idempoten lintas restart untuk pasangan owner+turn;
  `forget`/`allow` harus tetap terbarier sampai deletion selesai. Retry fisik
  provider tetap milik provider-attempt ledger. Observer turn tidak boleh
  mengubah delivery, authority, mutasi, atau safety bila pencatatannya gagal.

## AI dan model

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
- **Capability model harus exact dan explicit.** Registry memakai
  `provider + modelId`, bukan base URL, tier, atau substring nama. Model tanpa
  deklarasi `AI_MODEL_PROFILES` hanya mendapat profile compatibility dan tidak
  boleh mengaktifkan reasoning wire/replay baru. Profile asing, duplikat,
  kontradiktif, atau limit/enum rusak menggagalkan startup. Tier, model role,
  reasoning effort, dan visible verbosity adalah keputusan berbeda; prompt,
  model, serta tool output tidak dapat menaikkan authority atau effort.
- **Respons provider harus terminal dan cocok bentuknya.** Teks hanya sah pada
  `finish_reason=stop`; native calls hanya sah pada
  `finish_reason=tool_calls`. Length, content filter, reason asing/hilang, dan
  pasangan bentuk/reason yang tidak cocok tidak boleh menjadi final sukses.

## Log operasional

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

## Agent harness dan capability

- **Capability snapshot, bukan prompt, adalah authority.** Model hanya boleh
  mengusulkan tindakan; kode memeriksa ID+versi capability, surface aktif,
  schema input, policy/approval, idempotency, deadline, cancellation, dan
  generation sebelum executor boleh commit. Isi chat tidak dapat memasang
  capability. Executor web dan aplikasi eksternal belum terpasang; jangan
  mengklaim pencarian, pembacaan URL, atau aksi luar pernah dilakukan.
- **Native tool calling tidak memindahkan authority ke provider.** Definisi
  function action berasal dari executor pada irisan `callableCapabilities`,
  bukan dari model atau daftar prompt terpisah. Nama+schema dibekukan dan ikut
  hash checkpoint. Balasan provider harus tepat satu function call; plain text,
  nama di luar registry, argumen non-JSON, dan multi-call gagal tertutup. Hasil
  yang sah baru dinormalisasi menjadi `AgentPlannerDecision` dan tetap masuk
  seluruh validasi kernel sebelum executor dipanggil.
- **Continuation native adalah transcript sementara, bukan authority.** Dalam
  satu invocation, setiap observation harus mengikuti exact assistant turn
  dengan pesan `tool` dan `tool_call_id` yang cocok. Field yang diketahui—
  `reasoning`, `reasoning_content`, `reasoning_details`, dan Gemini thought
  signature—hanya boleh diputar ulang bila schema/size/binding provider+model
  sah dan profile exact mengizinkannya. Adapter mengirim allowlist wire, bukan
  object internal mentah. Call ID dan metadata continuation hanya untuk
  kontinuitas provider, tidak boleh menjadi approval, idempotency, scope,
  checkpoint durable, memory, telemetry content, atau isi log. Loop reasoning
  wajib memakai `completeToolTurn()`; wrapper call-only hanya one-shot.
  Kebutuhan live-state harus memilih
  named function sebelum inference, bukan mengganti keputusan model sesudah
  raw call terbentuk. Setelah observation, planner tetap boleh memilih tool
  berbeda; cycle guard fingerprint, bukan terminasi paksa, yang menahan proposal
  identik. Resume klarifikasi menyimpan pasangan prompt+jawaban sebagai state
  provider-neutral agar referen tidak bergantung pada transcript provider.
- **Fallback AI tidak otomatis mewarisi dukungan native tool.** Request native
  tetap primary-only sampai provider cadangan diuji dengan wire contract yang
  sama. Jangan menurunkannya diam-diam menjadi JSON/text atau mengirim schema
  tool ke fallback yang belum diverifikasi.
- **RunBudget adalah authority kode per logical AgentRun.** Satu akun yang sama
  wajib dipakai root, physical retry/fallback, executor, dan semua worker;
  planner hanya menerima view angka informatif. Setiap fetch harus mereservasi
  token+biaya atomik sebelum API key/fetch. Usage aktual—termasuk respons
  nonterminal—disettle; HTTP 408/5xx, timeout/network, payload/usage 2xx yang
  ambigu, serta reservation live saat checkpoint menahan reservation penuh
  sebagai unknown. Reported provider cost yang diketahui tetap menang bila
  lebih tinggi. HTTP 4xx selain 408 boleh melepas token/biaya, tetapi physical
  model-call tetap dihitung. Resume tidak boleh mereset atau memperluas akun.
  Actual overage tidak dapat membatalkan attempt yang sudah terjadi, tetapi
  policy/tool non-final berikutnya wajib berhenti fail-closed. Harga tier nol
  berarti cost preflight belum mempunyai coverage; jangan menyebutnya model
  gratis atau ceiling biaya universal.
- **Output ceiling general berasal dari ExecutionPolicy.** Caller mekanis boleh
  memasang ceiling sempit, tetapi reply/planner/worker/synthesizer general tidak
  boleh kembali ke fallback tersebar 800/1.536/4.096. Default role wajib
  di-clamp ke profile exact, dan request client harus sama persis dengan plan.
- **Final synthesis mempunyai reserve code-owned.** Kelas `work|final` berasal
  dari role tepercaya, bukan prompt/model. Work reservation tidak boleh memakai
  separuh token/biaya cumulative budget yang dilindungi—48.000 token pada
  budget default, maksimal 49.152.
  Actual work overage menahan tool/work baru, sedangkan final lengkap tetap
  boleh keluar. Reserve diturunkan dari limits+counter agar checkpoint/resume
  tidak memperoleh atau kehilangan budget secara diam-diam.

## Active AgentRun, RunMailbox, dan commit

- **Active run memakai snapshot transaksi, bukan live chat tail.** Hanya
  konteks terpilih saat start dan pesan yang dirutekan eksplisit ke RunMailbox
  boleh memengaruhi planner. Transcript/reasoning provider, credential, dan
  chat lain tidak boleh masuk record. Snapshot tetap data privat: ia wajib
  owner-scoped, berbatas, ikut penghapusan, dan diredaksi dari ekspor.
- **Satu scope hanya mempunyai satu foreground nonterminal.** Work lane v2 saat
  ini hanya untuk mode `orchestrate` privat Telegram. Foreground tidak boleh
  menahan chat lane; job kedua tidak boleh diam-diam mengganti run pertama.
  Store hanya mempertahankan record v1 atau v2 terbaru per scope; memulai run
  baru boleh mengganti terminal lama agar tidak ada data tertahan di luar
  bentuk ekspor tunggal.
- **Tidak ada semantik “pesan berikutnya adalah jawaban”.** Answer/update/cancel
  harus terikat ke Run Anchor, pesan pertanyaan, atau target run closed-set yang
  eksplisit. Answer juga wajib cocok dengan `runId`, `questionId`, dan watermark
  ingress setelah delivery. Ambiguitas kembali menjadi chat biasa.
- **Revision kode mengalahkan hasil model.** Setiap mailbox update membentuk
  ChangeSet dan menaikkan instruction revision. Freshness diperiksa tepat
  sebelum delivery; hasil revision lama tidak boleh mencapai efek eksternal.
  Observation tepercaya boleh dipakai ulang, tetapi work unit terdampak wajib
  stale dan action digest lama tidak boleh menjadi authority.
- **Efek run melewati commit barrier.** Intent efek disimpan sebagai
  `pendingEffect`, kemudian adapter mengirim, baru receipt `committed` ditulis.
  Effect in-flight saat crash atau kegagalan setelah boundary delivery menjadi
  receipt `unknown` dan status `partial`; recovery tidak boleh mengirim ulang
  otomatis. Kontrak ini baru mencakup outbound Telegram dan adapter file satu
  proses, bukan exactly-once multi-instance atau izin membuka tool write.
- **Run Anchor hanya merender fakta runtime.** Status/fase/work summary berasal
  dari record/event code-owned; nama model/tool/worker, persentase, dan ETA
  rekaan dilarang. Waiting input tidak boleh tampak sebagai spinner. Anchor
  dikirim sebagai satu pesan editable dan harus disegarkan saat recovery atau
  transisi expiry yang teramati.
- **Lifecycle hak data menang atas work lane.** Shutdown meng-abort dan mem-pause
  checkpoint sebelum drain. Startup merekonsiliasi running/paused/queued,
  pertanyaan kedaluwarsa, dan delivery ambigu. Penarikan consent/penghapusan
  memblokir scope serta meng-abort worker sebelum record dihapus; hasil lambat
  tidak boleh menghidupkan data atau delivery baru. Edit/hapus memori dan
  penghapusan history harus membatalkan worker serta menghapus record yang
  menyalin konteks lama sebelum mutasi sumber dinyatakan berhasil.
- **Retensi active run adalah bagian consent.** Pertanyaan mempunyai batas
  jawaban 10 menit. Record aktif mempunyai horizon maksimal tujuh hari sejak
  dibuat dan terminal maksimal tujuh hari sejak berhenti; record terbaru saja
  diretensi, dengan penarikan consent/penghapusan sebagai jalur hapus lebih
  cepat. Perubahan jenis serta horizon data ini terikat `CONSENT_VERSION` 7.

## Isolasi data

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

## Grup

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
  Sebelum isi pesan mencapai assessment/preflight model, core wajib sudah
  membuktikan `social.read`, binding account aktif, dan notice versi live;
  authority ingress dari adapter bukan pengganti revalidation core. Batch yang
  melintasi waktu join wajib difilter per bubble sebelum matcher, ACK, typing,
  atau model. Revocation authority wajib menaikkan generation, mengirim abort
  ke assessment aktif, dan menghapus assessment yang belum mulai dari antrean.
  Pemeriksaan authority observation async wajib FIFO per runtime. Hanya
  observation authorized/live yang boleh menaikkan revision atau menyupersesi
  ambient; alias default/durable harus dihidrasi setelah authority tetapi
  sebelum admission, dan observation yang kemudian ditolak hanya boleh
  disettle bila revision+generation masih cocok.
- **Panggilan grup dan pesan ambient berbeda.** Metadata platform untuk tag dan
  quote serta julukan lokal berbentuk vocative selalu dianggap panggilan;
  penyebutan Harvy sebagai topik bukan panggilan. Direct memakai fallback
  settle 350 ms,
  membatalkan planner ambient aktif, dan tidak menghabiskan budget sosial.
  Ambient memakai fallback 1,2 detik. Keduanya memakai p90 gap content-free
  per `scope+account+participant` setelah tiga sampel, termasuk lintas batch;
  pergantian speaker memutus sampel A→B→A. Timing tetap tunduk pada deadline
  empat detik dan profile dihapus saat scope diinvalidasi. Pesan
  ambient melewati planner `speak|silent`, pagar bentuk lokal, serta
  budget adaptif. Planner ambient sekaligus menghasilkan `riskHint` acute-only
  dan `contextPrivacy` raw-retention-only; direct memakai compiler ingress
  dengan schema yang sama. Plan, hint, dan privacy wajib diparse independen:
  field rusak menjadi null, bukan `none`/`ordinary`. Kandidat bernilai tinggi
  yang tersusul boleh menjadi satu pending candidate per runtime:
  tunggu quiet gap 900 ms, kedaluwarsa 15 detik/empat giliran, lalu revalidasi
  terhadap konteks aman. Revalidasi baru boleh mulai bila semua observation
  yang sudah terlihat juga sudah settled; timer 900 ms tidak boleh mendahului
  settle adapter yang berlaku. Keputusan mode saat ingress bukan authority
  durable: mode efektif wajib dibaca ulang tepat sebelum model revalidation,
  fixed ACK, dan delivery. Hasil selain `process` membatalkan work lama tanpa
  mengirim balasan. Direct call, bahaya, kelanjutan pengirim target,
  quote target, removal, atau shutdown wajib membatalkan timer dan request
  revalidation/fact-reply yang sedang aktif. `RiskHint none` melewati acute
  triage; possible/strong, compiler unavailable, marker continuation, dan
  emergency lokal memanggil triage. Outage tanpa bukti kuat tetap normal;
  strong unresolved memakai support konservatif. Hanya danger dan support
  tidak pasti yang direview. Emergency lokal berpresisi tinggi melewati
  debounce dan paket `direct_only`, tetapi baru boleh ACK setelah
  authority+binding+notice; `disabled/paused` tetap tertutup. Fixed ACK adalah
  satu-satunya efek out-of-band; full turn lintas speaker tetap diserialkan.
  Matcher local emergency wajib dinilai per bubble setelah filter join; kata
  konteks pada bubble lama tidak boleh memveto emergency eksplisit pada bubble
  berikutnya, sementara quote/negasi di bubble emergency itu sendiri tetap
  gagal tertutup.
  Reservation ACK dan assessment harus terpisah agar ACK tidak menelan triase.
  Emergency acute triage tidak menunggu ingress/memory extraction. Direct yang
  tertahan FIFO boleh memakai risk preflight dengan privacy no-retain; ambient
  biasa tidak boleh mengisi antrean itu dan memakai satu envelope planner.
  Emergency ambient yang berakhir sebagai support tetap wajib mendapat final
  safety reply ter-review, bukan ACK lalu diam, dan origin safety tidak boleh
  dibatalkan oleh observation ambient yang lebih baru.
  Dedupe, batas empat assessment aktif, antrean 32, generation, dan
  `AbortSignal` wajib dipertahankan. Harvy tidak mengirim DM dari otorisasi grup.
- **Ingress grup tidak menunggu AI.** Normalisasi dan enqueue berurutan per
  grup, tetapi listener Baileys hanya melacak task `onMessage`; ia tidak boleh
  menahan pesan berikutnya sampai planner/balasan selesai. Metadata refresh
  adalah gerbang membership: refresh yang kedaluwarsa boleh ditunggu untuk
  pesan yang sama tetapi wajib berbatas waktu, sedangkan metadata kosong,
  pengirim nonmember, Harvy yang tidak ada di peserta, dan self-echo gagal
  tertutup. Event authority menghapus cache serta membatalkan batch/pending
  pada call stack yang sama sebelum pekerjaan antrean berjalan. Observation
  authority dan insert batch diserialkan hanya sampai ingress commit agar await
  resolver yang lambat tidak membalik FIFO. Revision dipasang sebelum speaker
  switch menutup batch lama; duplicate, replay sebelum join, akun non-binding,
  dan turn yang ditolak admission tidak boleh membatalkan atau menggantung
  kandidat sah.
- **Natural bukan berarti menyamar sebagai manusia.** Riwayat grup masuk sebagai
  giliran chat beridentitas. Harvy perlu memahami lowercase, singkatan,
  code-mix, elongation, emoji, dan beberapa bubble, tetapi tidak meniru typo,
  mengarang pengalaman/kegiatan fisik, menawarkan DM, mendiagnosis/menuduh
  pasti, atau menjamin transaksi. `fact_correction` harus diregenerasi lewat
  tier `efficient`, bukan mengirim kandidat model cheap sebagai fakta final.
- **Memori grup mempunyai room context dan member memory yang berbeda.** Raw
  context beridentitas hanya berada 24 giliran atau dua jam di memori proses.
  Message dan reply hanya boleh masuk bila `contextPrivacy=ordinary` dan
  safety `calm+certain`; privacy null/sensitive gagal tertutup ke no-retain
  tanpa mengubah UX menjadi support. Pending ambient wajib membawa keputusan
  retensi yang sama sampai revalidation/delivery. Penanda tingkat risiko tanpa
  isi boleh hidup 30 menit agar
  jawaban pendek tetap fail-closed. Repository menyimpan nama grup/julukan
  selama aktif, pasangan PN/LID, nama tampilan/koreksi, last-seen dan aktivitas
  harian 30 hari, dedupe 24 jam, serta cooldown; ranking selalu menyebut
  jendela 7 hari dan bukan sifat permanen. Pembersihan berjalan berkala dan
  seluruh memori sosial dihapus saat disable. Memori semantik hanya milik satu
  kanal+grup+anggota, tidak boleh masuk state privat/grup lain, dan hanya boleh
  dipakai saat anggota itu berbicara. `contextPrivacy` bukan consent authority
  memori durable. Setelah direct menghasilkan kandidat, classifier
  `memory-privacy` khusus kandidat menentukan sensitivitas; jenis personal,
  hasil sensitive, port/parse null, timeout, atau error tidak boleh otomatis
  tersimpan. Tidak ada kandidat berarti tidak ada call privacy. Memori biasa
  boleh ditulis setelah notice lalu diumumkan pada balasan yang sama; kegagalan
  kirim wajib rollback. Usulan sensitif hanya boleh disimpan sesudah anggota
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
  Kontrol eksplisit berisiko rendah yang diizinkan policy safety tetap harus
  mencapai flow ini pada support yang pasti; output model tidak pernah
  menggantikan guard member/admin untuk menjalankannya.
  Semua mutator user-facing wajib membawa guard authority yang diperiksa di
  dalam antrean service tepat sebelum write. Pada repository file, lupakan diri
  menghapus profil sosial, member-local memory, dan atribusi pengusul room dalam
  satu commit; copy tidak boleh mengaku ledger teknis terhapus bila adapter
  ledger menolak atau gagal.

## WhatsApp dan Baileys

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

## Riwayat percakapan

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

## Pending store

- `PendingStore` adalah mirror in-memory satu langkah bertoken per pengguna.
  Tawaran pencatatan, Ubah tenggat, sunting memori, pemilihan waktu
  pengingat/check-in, jam tenang custom, izin memori sensitif, dan konfirmasi
  destruktif bergantung padanya, jadi semuanya memang mati setelah restart.
  Callback wajib membawa token proposal; klik lama tidak boleh menyimpan
  proposal baru atau menghapus data baru. Pending baru hanya bertahan bila
  promptnya berhasil dikirim. Sesi aktif tidak memakai `PendingStore` dan tetap
  ada setelah restart.
- `agent-input` adalah pengecualian legacy untuk flow sinkron: authority-nya
  berada pada `AgentRunService`, hanya untuk status `waiting_input` privat
  Telegram v1. Record
  wajib terikat scope/owner/run/mode/intent, revision CAS, codec checkpoint,
  serta `expiresAt === deadlineAt` dengan horizon absolut maksimal 10 menit.
  Writer baru wajib memakai checkpoint agent v2 dengan embedded RunBudget
  checkpoint v1; v2 tanpa budget ditolak. Agent checkpoint v1 hanya boleh
  masuk migrasi konservatif dan hasil migrasi harus menyelaraskan max step.
  Jeda menunggu jawaban tidak mengurangi waktu aktif, tetapi tidak memperpanjang
  horizon absolut.
  Ia baru disimpan setelah seluruh bubble prompt terkirim dan wajib masuk
  ekspor/penghapusan data. Startup, load, dan worker retensi berkala membuang
  expiry; `.tmp` yatim tidak boleh dipromosikan.
- Active AgentRun v2 tidak memakai `PendingStore`; binding pertanyaan, mailbox,
  revision, checkpoint, dan receipt berada di record durable sesuai bagian
  Active AgentRun di atas. Checkpoint v1 dan record v2 tidak boleh sama-sama
  menjadi foreground pada scope yang sama.
- Classifier batas giliran tidak boleh memulihkan `PendingStore`, karena ia
  berjalan di luar chain owner. Pemulihan durable hanya terjadi di handler
  owner. Sebuah batch hanya boleh menjawab checkpoint agent bila sequence
  bubble pertamanya lebih baru dari watermark delivery; bubble pra-prompt tidak
  boleh ikut terseret oleh carrier bubble yang lebih baru.
- Resume wajib claim dengan `runId + revision` sebelum model dipanggil. Prompt
  lanjutan/final yang sudah terlihat tetapi gagal di-commit harus membatalkan
  run secara fail-closed dan mengirim notice jujur. Gap delivery→save ini tetap
  berlaku untuk flow v1. Active v2 mempersistenkan intent dan receipt lokal,
  tetapi boundary Telegram/file belum atomik serta block cleanup belum durable
  lintas proses; status `unknown` wajib dipertahankan sampai RunStore dan
  reconciler produksi tersedia.
- Jawaban pending dari closed set tanggal/waktu/durasi/pilihan tidak menjalankan
  compiler atau triase umum setelah emergency preflight negatif; ia langsung
  menuju parser khusus. Edit memori, konfirmasi destruktif, `agent-input` tanpa
  schema jawaban terikat, dan bentuk bebas tetap keluar dari fast path. Sinyal
  emergency tidak pernah dikonsumsi sebagai nilai pending.
