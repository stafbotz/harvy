# ADR-007: Bubble dan Riwayat Percakapan yang Natural

- Status: Disahkan
- Tanggal: 26 Juli 2026
- Pemilik keputusan: pengguna Harvy
- Terkait: `ADR-003` (routing model), `ADR-006` (memori dan riwayat),
  Konstitusi Pasal 3.6, 3.9, 3.11, dan Pasal 4

> **Supersesi parsial 8 Agustus 2026.** [`ADR-021`](ADR-021-emergency-preflight-dan-boundary-local-first.md)
> menjadikan policy lokal sebagai penilai pertama untuk bentuk tertutup dan
> emergency langsung. Model `cheap` sekarang fallback untuk boundary ambigu,
> bukan biaya wajib setiap batch. Timer, revision guard, FIFO, dan shutdown
> contract ADR ini tetap berlaku.

> **Supersesi parsial 22 Agustus 2026.** Ketentuan “balasan paling banyak tiga
> bubble”, pemisahan paragraf mekanis, dan keputusan boundary berbasis regex
> luas tidak berlaku lagi. Boundary kini semantic-first dengan metadata
> terstruktur; Telegram dan WhatsApp memakai satu `ResponsePresentationPlan`;
> delivery setiap bubble dapat dibatalkan; dan history hanya mencatat teks yang
> benar-benar terkirim. Pagar lokal tetap dipakai hanya untuk bentuk
> deterministik serta emergency eksplisit.

> **Supersesi parsial 24 Agustus 2026.** Ketentuan historis bahwa candidate
> `personal` selalu meminta izin per-item diganti oleh Konstitusi v0.8 dan
> ADR-006: consent onboarding privat versi aktif mengotorisasi auto-memory
> ordinary maupun personal; credential tetap hard-excluded. Grup tidak
> mewarisi authority tersebut.

## Konteks

Uji Telegram nyata menunjukkan empat kegagalan yang saling berkaitan.

1. Pertanyaan "kamu ingat isi chat kita kah" dan "isi chat sebelumnya apa"
   diklasifikasikan sebagai pengelolaan memori. Adapter bot lalu menampilkan
   daftar memori terstruktur, bukan menjawab dari riwayat percakapan.
2. Tiga bubble berurutan diproses sebagai tiga percakapan terpisah. Harvy
   menjawab pembuka curhat sebelum pengguna selesai menulis dan menghasilkan
   rentetan balasan serta notifikasi memori.
3. Orientasi seksual diberi label `profile` oleh model lalu disimpan otomatis.
   Privasi bergantung pada satu label model yang tidak tepercaya.
4. Pemadatan riwayat menunggu model di jalur sebelum balasan. Pada transkrip,
   "ya yang tadi" tertahan sekitar sepuluh menit; kegagalan model peringkas
   ikut terasa seperti Harvy lupa dan tidak merespons.

Selain itu, pemberitahuan "Aku ingat ini" hanya punya tombol Lupakan dan tetap
memenuhi chat setelah pengguna melanjutkan pembicaraan. Balasan model juga
dikirim sebagai satu bubble panjang meskipun sudah tersusun dalam beberapa
paragraf pendek.

Uji lanjutan pada hari yang sama menemukan dua bentuk tumpang tindih lain.
Permintaan agar Harvy membuat kode dianggap sebagai pekerjaan pengguna dan
langsung disimpan. Sebaliknya, pernyataan preferensi baru dianggap sebagai
permintaan melihat memori, sehingga adapter membuka daftar lama dan membuang
usulan fakta barunya.

## Keputusan

### 1. Riwayat chat berbeda dari memori terstruktur

Intent `history` ditambahkan untuk pertanyaan kemampuan mengingat, isi chat
sebelumnya, dan rujukan seperti "yang tadi". Intent ini dijawab model dari
ringkasan serta giliran di konteks.

Intent `memory` hanya untuk melihat, menyunting, atau menghapus catatan
terstruktur tentang pengguna. Adapter bot hanya membuka kontrol memori untuk
intent ini.

### 2. Beberapa bubble dapat menjadi satu giliran semantik

Adapter memasukkan bubble ke `MessageBatcher` lalu **langsung mengembalikan
kendali** ke grammY. Ini wajib karena long-polling grammY menangani update satu
per satu; menunggu model di handler membuat bubble berikutnya tertahan sampai
Harvy selesai membalas bubble sebelumnya.

- Settle awal memakai 650 milidetik sebelum cukup sampel, lalu menyesuaikan p90
  gap content-free per pemilik. Burst cepat dikumpulkan sebelum work utama,
  sehingga bukan satu panggilan model per bubble.
- Bentuk deterministik yang sempit—command, hitungan sederhana, pertanyaan
  jelas, acknowledgment tertutup, serta fragmen sintaksis keras—boleh diputus
  lokal. Bahasa natural ambigu dinilai dari seluruh batch saat ini, konteks
  percakapan terbaru, jumlah bubble, dan timing content-free.
- Assessment semantik mengeluarkan `complete|open|incomplete|urgent` beserta
  confidence, continuation likelihood, dan reason class closed-set. Metadata
  ini bukan reasoning privat dan tidak boleh memuat isi percakapan.
- `complete` yang yakin langsung masuk antrean kerja setelah settle adaptif;
  `complete` multi-bubble yang ragu boleh mendapat ruang sampai 4 detik.
  `open` menunggu 7 detik dan fragmen `incomplete` 12 detik, semuanya dihitung
  sejak bubble terakhir. Model lambat atau keluaran rusak tidak boleh
  memperpanjang deadline tersebut.
- Emergency eksplisit lokal tetap dapat mengirim acknowledgment tetap sebelum
  debounce. Hasil semantic `urgent` juga mempercepat flush; full turn tetap
  menjalani triase/review dan pagar mutasi yang berlaku.
- Hanya satu request batas giliran per pengguna yang boleh aktif. Bila bubble
  lain melewati jeda saat request lama masih berjalan, revisi perantara
  dilewati dan hanya gabungan terbaru yang dinilai sesudahnya. Tambahan yang
  datang setelah request dimulai dapat memerlukan satu penilaian ulang, tetapi
  request batas tidak pernah tumpang tindih untuk pemilik yang sama.
- Bubble baru membatalkan keputusan dan timer lama, lalu seluruh potongan
  digabung dengan baris baru.
- Keputusan model dibatasi dua detik dan satu percobaan kunci. Fail-safe 12
  detik tetap berjalan selama model berpikir; model lambat, timeout, atau
  keluaran rusak tidak dapat menggantung chat. Pada kegagalan itu kebijakan
  lokal tetap dapat mempertahankan pembuka atau fragmen yang jelas.
- Saat masih menilai batas giliran Harvy diam: tidak ada typing atau status.
  Indikator/status baru boleh muncul setelah work nyata mulai dan kegagalannya
  dianggap kosmetik.
- Pesan yang masuk saat work aktif diklasifikasikan sebagai `addition`,
  `correction`, `redirect`, atau `independent`. Tiga hubungan pertama
  membatalkan `AbortController` lama dan menyupersesi output/efek yang belum
  commit; addition/correction menggabungkan konteks yang belum durable,
  sedangkan redirect meninggalkan arah lama. Pesan independen tetap diantrekan
  tanpa otomatis menghancurkan work aktif.
- Setiap efek dan bubble outbound menunggu relation barrier lalu memeriksa
  signal serta generation/revision current. Karena itu hasil tool/model lama,
  tombol, memory note, dan continuation yang basi tidak dapat keluar setelah
  koreksi atau redirect.
- Balasan untuk satu pengguna tetap diproses berurutan agar riwayat tidak
  saling menyalip.
- Command mengantrekan aksinya di belakang handler aktif tanpa ditunggu oleh
  handler grammY. `/start` dan `/bantuan` membatalkan batch yang belum mulai;
  `/tugas` mengurasnya agar pernyataan tugas tepat sebelum command tidak hilang.
  Token generasi juga membatalkan batch yang sudah berada di chain tetapi belum
  mulai. Karena itu balasan lama tidak muncul sesudah command, tetapi
  long-polling global tetap dapat menerima update pengguna lain.
- Callback menguras batch yang sudah lebih dulu masuk dan menunggu chain
  percakapan sebelum mengubah data. Permintaan ACK callback dikirim segera
  secara fire-and-forget dan aksi tidak menunggu request kosmetik tersebut;
  aksinya berjalan dari antrean latar. Karena itu tindakan seperti **Lupakan
  semua** benar-benar menjadi operasi terakhir dan tidak dapat “dibatalkan”
  oleh handler lama yang menyimpan memori atau riwayat sesudah penghapusan,
  tanpa membuat spinner atau polling Telegram menunggu generasi model.
- Shutdown normal menghentikan polling lalu menguras seluruh entry, chain, dan
  evaluator aktif sebelum proses selesai. Proses keluar paksa bila grace period
  60 detik terlewati. Ini melindungi restart terencana tanpa menggantung
  deployment selamanya; antreannya tetap in-memory dan bukan jurnal tahan-crash.
  ACK callback, cleanup notice yang fire-and-forget, dan pemadatan riwayat latar
  tidak menjadi bagian dari drain ini.

Produksi memakai tingkatan `cheap` yang direncanakan sebagai
`deepseek/deepseek-v4-flash`. Mode testing memakai
`gemini-3.5-flash-lite`. Kedua ID diverifikasi pada daftar resmi penyedia
tanggal 26 Juli 2026 dan tetap berada di environment, bukan kode.

### 3. Balasan memakai satu rencana presentasi lintas kanal

Tidak ada lagi target atau batas kepribadian tiga bubble. Core membentuk satu
`ResponsePresentationPlan` dari respons logis, lalu Telegram dan WhatsApp
merender segmen yang sama. Reaksi atau follow-up pendek boleh menjadi beat
terpisah; penjelasan terstruktur, paragraf panjang yang koheren, dan blok kode
tetap bersama selama batas transport mengizinkan. Blank line adalah sinyal,
bukan perintah split mekanis.

Anti-spam ceiling delapan segmen hanya menjadi pagar ekstrem dan menggabungkan
overflow tanpa membuang teks. Sesudah keputusan semantik, hard splitter
menerapkan batas 4.000 karakter Telegram atau 12.000 karakter WhatsApp dengan
menjaga seluruh code point. Jeda pendek antar-bubble hanyalah hint dan dapat
berhenti lebih awal ketika signal/revision menjadi stale.

Plafon keluaran balasan dinaikkan dari 1.536 menjadi 4.096 token agar permintaan
hasil lengkap, terutama HTML/CSS/JavaScript, tidak berhenti di tengah. Ini
plafon, bukan jumlah yang selalu dihasilkan atau ditagihkan.

Riwayat tetap menyimpan beberapa bubble sebagai satu giliran logis. Namun
setiap bubble diperiksa tepat sebelum send; jika pengguna menyela setelah
bubble pertama, continuation yang belum dikirim dihentikan dan history hanya
menyimpan gabungan bubble yang benar-benar mendapat receipt delivery. Efek
pasca-respons dan tombol hanya boleh commit jika giliran masih current.

### 4. Pemberitahuan memori menempel pada balasan

Koreksi 26 Juli 2026 menghapus bubble pemberitahuan sementara dan
`EphemeralMessageStore`.

Amandemen 22 Agustus 2026 (ADR-043) menggantikan bentuk `📎` dan tombol
**Lupakan** per item. Memory write kini diakui di dalam balasan utama yang
kontekstual sesudah primary commit. Jika balasan itu sudah jelas, tidak ada
baris kedua; fallback hanya satu kalimat tanpa dump content atau daftar record.
`📍` opsional berarti write/update terkonfirmasi, sedangkan `💭` opsional hanya
untuk recall pemahaman lama. Callback `memdrop:` tetap dibaca hanya untuk pesan
legacy yang sudah terlanjur terkirim.

### 5. Sensitivitas tidak dipercaya dari satu label model

`personal` tetap selalu meminta izin. Pagar daftar kata deterministik dihapus
27 Juli 2026 atas keputusan pemilik produk. Sebagai pemeriksaan terpisah,
triase risiko menilai apakah isi sensitif; hasil sensitif memaksa jalur izin
meskipun ekstraksi memberinya jenis biasa. Konsekuensi yang diterima: keputusan
ini tetap bergantung pada model, tetapi tidak lagi pada satu field dari satu
panggilan ekstraksi.

### 6. Pemadatan berjalan setelah balasan

Menyimpan giliran tidak lagi memanggil model peringkas. Adapter meminta
pemadatan tanpa menunggu setelah balasan utama selesai.

Ringkasan dibuat dari snapshot, lalu hanya awalan yang benar-benar diringkas
yang dibuang dari versi terbaru. Bubble yang datang saat model bekerja tetap
dipertahankan. Kegagalan memberi cooldown satu menit agar penyedia yang sedang
bermasalah tidak dipanggil ulang pada setiap giliran.

**Amandemen 2 Agustus 2026.** `ADR-014` mempertahankan lifecycle nonblocking
ini tetapi mengganti satu ringkasan bergulir dengan episode v2 terstruktur,
berprovenance, berbatas retensi, dan tidak diringkas ulang.

Balasan dengan `finish_reason=length` ditolak sebagai galat, bukan diteruskan
atau disimpan sebagai teks setengah jadi.

### 7. Intent menyatakan tujuan; action memberi izin tindakan

Kewajiban pengguna dan permintaan kepada Harvy adalah dua hal berbeda.

- `request` berarti Harvy diminta menghasilkan sesuatu di chat. Harvy menjawab
  langsung dan tidak membuat ataupun menawarkan tugas.
- `task + taskAction: save + task` adalah satu-satunya kombinasi yang boleh
  langsung menyimpan pekerjaan pengguna.
- `feeling + taskAction: offer + task` adalah satu-satunya kombinasi yang boleh
  menawarkan pencatatan setelah balasan empatik.
- `memory + memoryAction: list|forget|edit`, tanpa usulan fakta baru, membuka
  kontrol memori.
- Fakta atau preferensi baru tetap berada pada percakapan biasa dan dibawa lewat
  `memoryAction: remember` serta field `memories`; keberadaan fakta bukan
  perintah membuka daftar.

Parser menormalkan kombinasi ini sebelum adapter melihatnya. Task/action yang
berkontradiksi dibuang, intent asing ditolak kecuali alias `reminder` yang
didaftarkan eksplisit, dan adapter mengulangi pemeriksaan pasangan intent/action
sebagai pertahanan kedua. Output model tidak dipercaya hanya karena JSON-nya
sah.

Alur yang tindakannya sudah dipilih lewat tombol tidak kembali melewati
klasifikasi intent umum. Jawaban **Ubah tenggat** memakai kontrak khusus yang
hanya mengeluarkan `dueAt`; parser menolak tanggal tanpa waktu dan offset agar
zona waktu proses tidak diam-diam menggeser hasilnya.

### 8. Progress adalah satu surface sementara yang mengikuti kerja nyata

Respons yang selesai di dalam grace period tidak menampilkan status. Untuk work
yang lebih lama, transport boleh membuat tepat satu surface sementara, mengedit
surface yang sama ketika aktivitas backend benar-benar berpindah, lalu
menghapusnya sebelum bubble jawaban pertama. Fase seperti mencari, membaca,
membandingkan, menghitung, memeriksa, menyesuaikan, atau menyusun hanya boleh
berasal dari capability/execution event yang sungguh dimulai; requested
reasoning tidak boleh ditampilkan seolah effective reasoning telah diberikan.

Copy progress tetap singkat dan manusiawi. Raw input, prompt, tool output,
confidence, nama model, reasoning effort, chain-of-thought, serta istilah
internal dilarang. Edit/delete/typing yang gagal bersifat best-effort dan tidak
boleh menggagalkan work atau final response. Kontrak fase dan lifecycle berada
di core; Telegram serta WhatsApp hanya menyediakan primitive send/edit/delete
dan typing/presence masing-masing. Pada grup WhatsApp, surface hanya dibuat
untuk direct turn setelah authority serta notice terbukti; ambient planner yang
mungkin memilih diam tidak boleh lebih dulu mengirim status.

## Konsekuensi

Positif:

- pertanyaan tentang isi chat dijawab dari riwayat yang memang tersedia;
- permintaan hasil langsung tidak lagi mengambil alih daftar tugas pengguna;
- preferensi baru dapat ditanggapi dan diingat tanpa membuka daftar lama;
- curhat yang dipenggal tidak menghasilkan beberapa percakapan yang saling
  mengejar;
- koreksi atau redirect dapat menghentikan model, efek, dan bubble lanjutan
  yang sudah basi, sedangkan pesan independen tetap terantre;
- jumlah bubble mengikuti bentuk jawaban, bukan kuota tiga, dengan guard
  anti-spam dan batas transport tetap berlaku;
- progress yang terlihat dapat ditelusuri ke aktivitas backend nyata dan tidak
  berkedip untuk jawaban cepat;
- informasi sensitif tidak bergantung pada ketepatan satu label model;
- kegagalan peringkas tidak lagi menahan balasan utama; dan
- chat lebih ringkas tanpa menghilangkan kontrol memori.

Trade-off:

- boundary ambigu menambah satu panggilan model murah; bentuk deterministik
  sempit tidak membayar panggilan itu. Settle adaptif tetap menambah jeda kecil
  agar burst dapat terkumpul;
- plafon balasan yang lebih besar memungkinkan biaya keluaran lebih tinggi bila
  model memang menghasilkan jawaban panjang; token yang tidak dihasilkan tidak
  ditagihkan;
- model dapat salah memilih menunggu atau langsung merespons; pagar lokal
  mengurangi kesalahan yang jelas dan batas maksimum 12 detik mencegahnya
  menggantung tanpa akhir. Konsekuensinya, pembuka curhat yang tidak dilanjutkan
  memang terasa lebih lambat daripada pesan lengkap;
- aksi command dan tombol dapat menunggu balasan aktif selesai di antrean
  pengguna. Ini menjaga urutan update serta mencegah data yang sudah dihapus
  hidup kembali, dengan trade-off bahwa aksi berikutnya tidak menyalip giliran
  percakapan yang sedang berjalan; polling global dan pengguna lain tidak ikut
  menunggu;
- restart normal menunggu antrean habis, tetapi crash paksa setelah Telegram
  menganggap update selesai atau shutdown yang melewati 60 detik masih dapat
  kehilangan giliran yang belum diproses;
- satu operasi I/O yang tidak pernah selesai dapat menahan antrean pengguna itu
  sendiri, meskipun pengguna lain dan polling global tetap berjalan;
- keadaan `urgent` menghapus penantian normal dan membatalkan work conversational
  lama yang belum commit; fixed acknowledgment boleh berjalan out-of-band,
  sedangkan full safety turn dan mutasi tetap mengikuti ordering yang aman;
- klasifikasi hubungan interupsi dapat salah. Fallback harus menahan output
  stale dan gagal tertutup, bukan mengirim jawaban lama berdasarkan asumsi;
- kontrak JSON memiliki dua field aksi tambahan; model yang menghilangkan atau
  mengontradiksikannya akan kehilangan tindakan mutasi, bukan ditebak; dan
- triase model dapat salah menilai isi sensitif. Jenis `personal` tetap menjadi
  pagar lokal terakhir, tetapi jenis biasa bergantung pada hasil triase.

## Yang belum terbukti

Tes otomatis mencakup burst, boundary semantik, addition/correction/redirect/
independent, interupsi saat model bekerja dan di tengah multi-bubble, lifecycle
progress, partial history, serta parity rencana presentasi Telegram/WhatsApp.
Alur live Telegram dan WhatsApp setelah amandemen ini—termasuk kualitas timing,
edit/delete status, interruption di jaringan nyata, reconnect, dan persepsi
jumlah bubble—belum diuji ulang. Hasil otomatis tidak boleh disebut sebagai
bukti parity kanal live.
