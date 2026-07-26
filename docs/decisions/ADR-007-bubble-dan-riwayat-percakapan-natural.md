# ADR-007: Bubble dan Riwayat Percakapan yang Natural

- Status: Disahkan
- Tanggal: 26 Juli 2026
- Pemilik keputusan: pengguna Harvy
- Terkait: `ADR-003` (routing model), `ADR-006` (memori dan riwayat),
  Konstitusi Pasal 3.6, 3.9, 3.11, dan Pasal 4

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

Intent `memory` hanya untuk melihat atau menghapus catatan terstruktur tentang
pengguna. Adapter bot hanya membuka daftar memori untuk intent ini.

### 2. Beberapa bubble dapat menjadi satu giliran

Adapter memasukkan bubble ke `MessageBatcher` lalu **langsung mengembalikan
kendali** ke grammY. Ini wajib karena long-polling grammY menangani update satu
per satu; menunggu model di handler membuat bubble berikutnya tertahan sampai
Harvy selesai membalas bubble sebelumnya.

- Setiap bubble memulai ulang jeda hening 650 milidetik. Burst cepat terkumpul
  sebelum model dipanggil, sehingga bukan satu panggilan model per bubble.
- Setelah jeda hening, model `cheap` menerima seluruh potongan dan mengeluarkan
  salah satu keadaan: `complete`, `open`, `incomplete`, atau `urgent`.
- Kebijakan lokal mengoreksi kasus yang tidak boleh bergantung penuh pada
  jaringan: pembuka curhat, emosi/narasi terbuka, kata sambung yang menggantung,
  penutup eksplisit, dan bahaya segera yang konkret. Bahaya segera yang sudah
  dikenali lokal melewati debounce maupun request model batas giliran. Handler
  lengkapnya tetap mengikuti chain FIFO pengguna; keputusan ini belum
  menggantikan alur keselamatan khusus yang statusnya masih `Belum`.
- Hanya satu request batas giliran per pengguna yang boleh aktif. Bila bubble
  lain melewati jeda saat request lama masih berjalan, revisi perantara
  dilewati dan hanya gabungan terbaru yang dinilai sesudahnya. Tambahan yang
  datang setelah request dimulai dapat memerlukan satu penilaian ulang, tetapi
  request batas tidak pernah tumpang tindih untuk pemilik yang sama.
- Pesan lengkap tunggal diproses segera setelah keputusan model. Bila satu
  giliran sudah berisi beberapa bubble tetapi dinilai lengkap, Harvy memberi
  ruang 4 detik sejak bubble terakhir.
- Pembuka sosial, pengantar curhat, dan narasi/perasaan terbuka menunggu 7
  detik. Fragmen tata bahasa yang keras seperti akhiran "karna" menunggu paling
  lama 12 detik. Semua jendela dihitung sejak **bubble terakhir tiba**, bukan
  setelah model selesai berpikir.
- Bubble baru membatalkan keputusan dan timer lama, lalu seluruh potongan
  digabung dengan baris baru.
- Keputusan model dibatasi dua detik dan satu percobaan kunci. Fail-safe 12
  detik tetap berjalan selama model berpikir; model lambat, timeout, atau
  keluaran rusak tidak dapat menggantung chat. Pada kegagalan itu kebijakan
  lokal tetap dapat mempertahankan pembuka atau fragmen yang jelas.
- Indikator “mengetik” baru dikirim ketika satu batch benar-benar mulai
  ditangani, bukan pada setiap bubble saat Harvy masih menyimak. Kegagalannya
  dianggap kosmetik dan tidak boleh menghentikan giliran.
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

### 3. Balasan boleh menjadi beberapa bubble

Paragraf balasan dikirim sebagai bubble terpisah, paling banyak tiga. Paragraf
lebih banyak digabung pada bubble terakhir. Balasan yang mengandung blok kode
tidak dipecah agar kode tidak rusak selama masih muat. Batas aman pesan Telegram
adalah 4.000 karakter; teks yang lebih panjang dibagi tanpa kehilangan
karakter, sekalipun akibatnya perlu lebih dari tiga bubble.

Plafon keluaran balasan dinaikkan dari 1.536 menjadi 4.096 token agar permintaan
hasil lengkap, terutama HTML/CSS/JavaScript, tidak berhenti di tengah. Ini
plafon, bukan jumlah yang selalu dihasilkan atau ditagihkan.

Riwayat menyimpan balasan itu sebagai satu giliran logis, sehingga tiga bubble
Harvy tidak menghabiskan jendela konteks tiga kali lebih cepat.

### 4. Pemberitahuan memori bersifat sementara

Memori biasa tetap disimpan otomatis dan diumumkan, tetapi pemberitahuannya
sekarang memiliki tombol **Oke** dan **Lupakan**. Menekan Oke menghapus bubble
pemberitahuan. Bila pengguna langsung mengirim pesan berikutnya, pemberitahuan
lama juga dihapus otomatis; memorinya tetap ada sampai pengguna memilih
Lupakan.

Referensi pesan sementara hanya berada di memori proses. Restart boleh
meninggalkannya di Telegram; itu lebih baik daripada menyimpan metadata chat
tambahan hanya untuk merapikan tampilan. Bila penghapusan Telegram gagal,
referensinya dimasukkan kembali dengan deduplikasi agar chat berikutnya mencoba
lagi, bukan melupakan bubble yang masih terlihat. Lease dan tombstone mencegah
hasil delete yang terlambat menghidupkan ref setelah pengguna menekan
Oke/Lupakan pada saat request masih berjalan. Setelah tiga kegagalan,
referensinya dilepas agar error permanen tidak memenuhi memori dan memanggil
Telegram pada setiap chat selamanya.

### 5. Sensitivitas tidak dipercaya dari label model saja

`personal` tetap selalu meminta izin. Sebagai pagar kedua, isi yang jelas
menyinggung kesehatan, keluarga, hubungan romantis, identitas gender, orientasi
seksual, atau tekanan emosional juga dipaksa ke jalur izin meskipun model
memberinya jenis biasa.

Pagar deterministik ini sengaja konservatif. Salah positif hanya menghasilkan
pertanyaan izin; salah negatif dapat menyimpan informasi sensitif diam-diam.

### 6. Pemadatan berjalan setelah balasan

Menyimpan giliran tidak lagi memanggil model peringkas. Adapter meminta
pemadatan tanpa menunggu setelah balasan utama selesai.

Ringkasan dibuat dari snapshot, lalu hanya awalan yang benar-benar diringkas
yang dibuang dari versi terbaru. Bubble yang datang saat model bekerja tetap
dipertahankan. Kegagalan memberi cooldown satu menit agar penyedia yang sedang
bermasalah tidak dipanggil ulang pada setiap giliran.

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
- `memory + memoryAction: list|forget`, tanpa usulan fakta baru, membuka kontrol
  memori.
- Fakta atau preferensi baru tetap berada pada percakapan biasa dan dibawa lewat
  field `memories`; keberadaan fakta bukan perintah membuka daftar.

Parser menormalkan kombinasi ini sebelum adapter melihatnya. Task/action yang
berkontradiksi dibuang, intent asing ditolak kecuali alias `reminder` yang
didaftarkan eksplisit, dan adapter mengulangi pemeriksaan pasangan intent/action
sebagai pertahanan kedua. Output model tidak dipercaya hanya karena JSON-nya
sah.

Alur yang tindakannya sudah dipilih lewat tombol tidak kembali melewati
klasifikasi intent umum. Jawaban **Ubah tenggat** memakai kontrak khusus yang
hanya mengeluarkan `dueAt`; parser menolak tanggal tanpa waktu dan offset agar
zona waktu proses tidak diam-diam menggeser hasilnya.

## Konsekuensi

Positif:

- pertanyaan tentang isi chat dijawab dari riwayat yang memang tersedia;
- permintaan hasil langsung tidak lagi mengambil alih daftar tugas pengguna;
- preferensi baru dapat ditanggapi dan diingat tanpa membuka daftar lama;
- curhat yang dipenggal tidak menghasilkan tiga percakapan yang saling mengejar;
- informasi sensitif tidak bergantung pada ketepatan satu label model;
- kegagalan peringkas tidak lagi menahan balasan utama; dan
- chat lebih ringkas tanpa menghilangkan kontrol memori.

Trade-off:

- keputusan batas bubble menambah satu panggilan model murah per kumpulan
  pesan, sehingga ada biaya dan jeda kecil;
- selain bahaya segera yang dikenali lokal, pesan bebas menunggu sekurangnya
  jeda hening 650 milidetik; pesan lengkap terasa sedikit kurang instan, tetapi
  burst percakapan tidak lagi dipotong per bubble;
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
- keadaan `urgent` menghapus penantian batas bubble, tetapi belum dapat
  membatalkan balasan pengguna yang sudah aktif. Prioritas atau acknowledgment
  keselamatan independen memerlukan desain alur keselamatan tersendiri agar
  urutan riwayat tidak rusak;
- penghapusan bubble pemberitahuan bergantung pada hak Telegram; kegagalan
  dicoba lagi sampai tiga kali, tetapi kegagalan permanen tetap dapat
  meninggalkan bubble lama; dan
- kontrak JSON memiliki dua field aksi tambahan; model yang menghilangkan atau
  mengontradiksikannya akan kehilangan tindakan mutasi, bukan ditebak; dan
- pagar kata sensitif dapat meminta izin pada kalimat yang sebenarnya tidak
  sensitif, tetapi tidak pernah menyimpan lebih longgar karena salah tebak.

## Yang belum terbukti

Gerbang otomatis dan probe model langsung sudah lulus. Alur Telegram
end-to-end setelah perubahan ini—termasuk jeda tiga bubble, tombol Oke,
penghapusan pemberitahuan, permintaan kode, preferensi baru, dan riwayat setelah
restart—masih harus dicoba pada bot nyata.
