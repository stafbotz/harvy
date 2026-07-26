# Status Kemampuan Harvy

Dokumen ini menjawab satu pertanyaan saja: **apa yang benar-benar berjalan hari
ini.** Dokumen lain di repositori ini menjelaskan tujuan, keputusan, dan batas
moral — semuanya sah, tetapi tidak satu pun menyatakan keadaan kode. Perbedaan
itu pernah membuat agent dan manusia sama-sama mengira kemampuan yang masih
berupa rencana sudah tersedia.

Aturannya: **jika sebuah kemampuan tidak tercatat “Ada” di sini, jangan
mengklaimnya ada.** Kalau dokumen lain terdengar lebih optimistis, dokumen ini
yang menang, dan perbedaannya dilaporkan.

- Terakhir diverifikasi: 26 Juli 2026.
- Basis: commit `7337b91` ditambah perubahan UX bubble/riwayat yang belum
  di-commit.
- Cara verifikasi: membaca kode secara langsung, bukan membaca dokumen lain.

## Cara memakai Harvy

Harvy Capybara dipakai lewat **percakapan biasa dan tombol**, bukan lewat
perintah `/`. Pengguna menulis apa adanya; Harvy memahami maksudnya, lalu
menyediakan tindakan sebagai tombol. Perintah `/` hanya pelengkap opsional dan
tidak boleh menjadi cara utama apa pun — Konstitusi Pasal 3.11 melarang pengguna
dipaksa menghafal perintah.

Tombolnya sendiri seharusnya **adaptif dan disusun AI menurut keadaan**, bukan
papan tombol tetap. Ini belum terjadi; lihat tabel di bawah.

## Kemampuan

| Kemampuan | Status | Catatan |
|---|---|---|
| Bot Telegram khusus chat pribadi | Ada | Chat non-pribadi hanya dijawab bila pesannya perintah |
| Pesan bebas dipahami model | Ada | Jalur utama. Dua langkah: ekstraksi `cheap`, lalu balasan sesuai tingkatan. Intent dipisahkan dari aksi agar output model yang kontradiktif tidak langsung mengubah data |
| Penggabungan bubble pengguna | Ada; timer lama terbukti terlalu pendek, perbaikan adaptif belum diuji Telegram | Enqueue langsung mengembalikan kendali ke grammY; jeda 650 ms menggabungkan burst, lalu model `cheap` memilih `complete/open/incomplete/urgent` dengan pagar lokal. Pesan tunggal lengkap langsung diproses; gabungan lengkap, pembuka, dan fragmen menggantung masing-masing diberi 4/7/12 detik sejak bubble terakhir. Bahaya segera lokal tidak menunggu model. Pemeriksaan per pemilik tidak tumpang tindih; command/callback masuk antrean per pengguna tanpa menahan polling global; shutdown normal menguras antrean |
| Balasan dalam beberapa bubble | Ada, belum teruji Telegram setelah perbaikan | Paragraf dikirim terpisah, maksimal tiga bubble. Blok kode tetap utuh bila muat; pesan di atas 4.000 karakter dipecah agar tidak ditolak Telegram |
| Permintaan hasil langsung | Ada, terbukti pada probe model | Intent `request` memenuhi permintaan yang dapat dikerjakan di chat, misalnya menulis kode; tidak membuat atau menawarkan tugas. Plafon balasan 4.096 token, lalu pesan panjang dibagi sesuai batas Telegram |
| Curhat tidak otomatis jadi tugas | Ada | Harvy menjawab dulu, pencatatan ditawarkan lewat tombol |
| Pencatatan tugas + tombol tindakan | Ada, terbukti | Tugas tercatat dan tombol Selesai berfungsi pada percakapan nyata 26 Juli 2026 |
| Tombol adaptif yang disusun AI | Belum | Seluruh papan tombol ditulis tangan dan tetap di `src/bot/messages.ts`. Model tidak ikut menentukan tindakan apa yang ditawarkan |
| `/start`, `/tugas`, `/bantuan` | Ada, sebagai pelengkap | Bukan cara utama. Tidak ada perintah lain; pesan `/` lain dijawab dengan bantuan |
| Pengurutan prioritas | Ada | Murni dan teruji unit di `src/core/prioritizer.ts` |
| Pengingat | Sebagian | Dapat diminta lewat kalimat ("ingetin aku jam 8") atau tombol. Pengiriman oleh worker **dilaporkan pengguna** berhasil pada 26 Juli 2026; penulis kode belum mengamatinya sendiri. Lewat tombol waktunya masih ditetapkan Harvy, satu jam sebelum tenggat. Jam tenang dan frekuensi belum ada |
| Penyimpanan per pengguna | Ada | JSON atomik, terisolasi lewat `ownerId`. Berlaku sama untuk tugas, memori, dan riwayat |
| Rotasi kunci mode uji | Ada | Teruji unit; perilaku terhadap kuota nyata belum diamati |
| Tutoring bertahap | Belum | Promptnya ada dan riwayat percakapan kini tersedia, tetapi pola lima langkah Pasal 3.4 belum ditulis sebagai alur dan belum pernah diamati berjalan lintas pesan |
| Riwayat percakapan | Ada, terbukti gagal sebelum perbaikan; perbaikan belum teruji Telegram | Enam giliran terakhir dibawa ke pemahaman **dan** balasan; intent `history` membedakannya dari daftar memori. Setelah 16 giliran, pemadatan berjalan di latar setelah balasan dan mempertahankan pesan baru. Transkrip nyata membuktikan riwayat tersambung tetapi salah dijawab sebelum `ADR-007` |
| Memori terstruktur dan kendalinya | Ada, terbukti sebagian | Lima jenis. `personal` dan isi yang terdeteksi sensitif selalu minta izin; sisanya disimpan otomatis disertai pemberitahuan sementara serta tombol Oke/Lupakan. Penghapusan notice yang gagal dicoba sampai tiga kali; lease/tombstone mencegah ref hidup kembali setelah callback. Daftar, lupakan satu, dan lupakan semua ada. Transkrip nyata membuktikan simpan biasa dan tawaran sensitif tampil; tombol baru belum diuji Telegram |
| Pemeriksaan keselamatan sebagai lapisan | Belum | Batas giliran punya pengaman lokal agar bahaya segera tidak menunggu classifier, tetapi handler lengkapnya masih FIFO di belakang balasan aktif. Isi respons keselamatan juga masih hanya mengandalkan satu field JSON dari model ekstraksi lalu tambahan prompt; belum ada preemption atau acknowledgment prioritas |
| Pemeriksaan respons sebelum dikirim | Belum | Balasan model langsung diteruskan ke pengguna |
| Pemberitahuan dan persetujuan privasi | Belum | Isi pesan sudah dikirim ke penyedia pihak ketiga tanpa diberitahukan. Sejak memori dan riwayat ada, yang dikirim bukan lagi hanya pesan hari ini — ini menjadi lebih mendesak, bukan kurang |
| Zona waktu per pengguna | Belum | Satu zona untuk semua, dari `.env` |
| Ekspor dan hapus seluruh data | Sebagian | "Lupakan semua tentang aku" menghapus memori dan riwayat dari dalam chat. Tugas belum ikut, dan ekspor belum ada sama sekali |
| Batas pemakaian dan pemantauan biaya | Belum | Tidak ada penghitungan token |
| Ukuran keberhasilan Pasal 8 | Belum | Tidak ada yang diukur, termasuk yang boleh diukur |
| WhatsApp dan website | Belum | Belum dimulai, dan memang belum dijadwalkan |

## Cacat yang diketahui

Tidak ada cacat terbuka yang tercatat pada kode saat ini. Transkrip Telegram
26 Juli 2026 menemukan delapan cacat yang sudah diperbaiki di working tree tetapi
belum diuji ulang end-to-end:

1. pertanyaan isi chat dibajak menjadi daftar memori;
2. bubble pengguna diproses satu per satu tanpa menunggu lanjutan; implementasi
   pertamanya juga masih menunggu model dan seluruh balasan di handler update,
   sehingga long-polling grammY yang berurutan tetap menahan bubble berikutnya;
3. orientasi seksual tersimpan otomatis karena model salah memberi jenis;
4. pemadatan riwayat menahan balasan dan mencoba ulang tanpa cooldown; dan
5. `finish_reason=length` hanya dicatat tetapi teks terpotong masih diteruskan;
6. permintaan agar Harvy membuat sesuatu disimpan sebagai tugas pengguna;
7. pernyataan preferensi baru membuka daftar memori lama, sementara usulan
   fakta barunya tidak diproses; dan
8. deadline universal 2,5 detik memecah cerita dengan jeda alami 3–4,5 detik
   meskipun adapter sudah nonblocking.

Tiga cacat sebelumnya — pagar injeksi yang
tidak terpasang, `remindAt` yang dibuang, dan mode JSON yang tidak dipakai —
diperbaiki pada 26 Juli 2026 dan kini dijaga tes di `tests/conversation.test.ts`
serta `tests/task-service.test.ts`.

Ketiganya punya pola yang sama dan pantas diingat: **kode ditulis lengkap lalu
tidak pernah disambungkan.** Cacat keempat memang muncul, persis seperti yang
dikhawatirkan: `scripts/coba-pemahaman.ts` tetap memakai batas token 400 setelah
angka di `src/ai/conversation.ts` dinaikkan ke 2048, sehingga alat diagnostiknya
sendiri mereproduksi cacat yang ia dibuat untuk mencari.

Review kontrak action menemukan satu regresi sebelum diuji Telegram: alur Ubah
tenggat sempat mengirim kalimat sintetis ke klasifikasi intent umum, sehingga
aturan `request` baru dapat membuang tanggalnya. Jalur itu kini memakai schema
`dueAt` khusus, menolak ISO tanpa offset, lulus tes, dan lulus probe Gemini
langsung. Telegram tetap belum diuji ulang.

Sejak 26 Juli 2026 gerbang statis diperketat: `noUnusedLocals` aktif, dan
`include` `tsconfig.json` mencakup `scripts/` yang sebelumnya tidak pernah
tersentuh `npm run check` sama sekali.

Jangan menyimpulkan lebih dari itu. `noUnusedLocals` hanya menangkap impor dan
nilai lokal yang tidak terpakai; **angka yang salah tetapi dipakai tetap tidak
terlihat olehnya**, dan cacat keempat itu justru berbentuk demikian. Yang
mencegahnya berulang bukan flag, melainkan satu sumber nilai: batas token kini
diimpor dari `conversation.ts`, tidak ditulis ulang. Pola yang sama pantas
dipakai untuk nilai lain yang harus sama di dua tempat.

## Bukti dari pemakaian nyata

**26 Juli 2026 — Harvy berjalan untuk pertama kalinya** dengan token bot dan
kunci sungguhan.

Terbukti bekerja:

- sapaan dan perkenalan diri sebagai AI berbentuk kapibara;
- obrolan ringan yang tidak berubah menjadi tugas;
- persona dan gaya bahasa sesuai `persona.ts`.

- pencatatan tugas dari kalimat, lengkap dengan pengingat: "ingetin aku pukul
  sebelas lewat 43 menit untuk minum obat" tercatat benar berikut 🔔;
- **tombol inline benar-benar hidup.** Tombol Selesai ditekan dan bekerja, yang
  sekaligus membuktikan perbaikan `allowed_updates`;
- tutoring satu giliran: "ajarin aku kalkulus" dijawab dengan memecah topik dan
  bertanya balik, bukan langsung menceramahi.

**Uji percakapan kedua, 26 Juli 2026.** Transkrip pengguna membuktikan memori
dan riwayat benar-benar tersambung ke bot, sekaligus menemukan cacatnya:

- nama panggilan pengguna disimpan dan pemberitahuan memori muncul;
- informasi relasi ditawarkan untuk diingat lebih dulu;
- pertanyaan kemampuan/isi chat salah dijawab sebagai daftar memori kosong;
- tiga bubble curhat menghasilkan tiga rangkaian balasan;
- gender dan orientasi seksual tersimpan otomatis, yang melanggar aturan
  informasi sensitif; dan
- balasan "ya yang tadi" tertahan sekitar sepuluh menit ketika pemadatan
  berjalan, lalu Harvy gagal membawa topik lama dengan benar.

Perbaikan `ADR-007` sudah lulus gerbang otomatis dan probe model langsung, tetapi
belum dijalankan ulang melalui Telegram. Bukti kegagalan lama bukan bukti
perbaikan end-to-end.

**Uji percakapan ketiga, 26 Juli 2026.** Transkrip lanjutan menemukan pemisahan
aktor dan tindakan yang masih kabur:

- permintaan agar Harvy membuat kode langsung berubah menjadi tugas tanpa
  tenggat; dan
- pernyataan warna favorit membuka seluruh daftar memori, bukan menanggapi lalu
  mengingat preferensi baru.

Kontrak ekstraksi kini membedakan intent `request` dari kewajiban pengguna,
`taskAction` dari isi tugas, serta `memoryAction` dari usulan fakta baru. Probe
Gemini 3.5 Flash-Lite untuk kedua kalimat itu dan tiga pembanding lulus, tetapi
jalur Telegram sesudah perbaikannya belum diamati.

**Uji percakapan keempat, 26 Juli 2026.** Empat bubble curhat yang dikirim pada
detik yang sama masih menghasilkan tiga balasan Harvy sebelum cerita pengguna
selesai. Pemeriksaan kode dan implementasi long-polling grammY menunjukkan
penyebabnya: adapter menunggu `MessageBatcher` sampai model dan balasan selesai,
sementara grammY baru menyerahkan update berikutnya setelah handler itu kembali.

Adapter kemudian hanya memasukkan bubble lalu langsung kembali. Burst
dikumpulkan 650 milidetik, deadline universal 2,5 detik dimulai ulang dari
bubble terakhir, dan keputusan model yang terlambat tidak dapat memproses batch
dua kali. Evaluator satu pemilik tidak tumpang tindih dan hanya revisi terbaru
yang dinilai ulang. Perintah serta tombol juga diberi antrean per pengguna
terhadap handler latar agar urutan tetap aman. Callback diakui segera dan
polling global tidak menunggu antrean tersebut. Perubahan ini memperbaiki
blocking adapter, tetapi uji berikutnya membuktikan angka 2,5 detiknya sendiri
masih terlalu pendek.

**Uji percakapan kelima, 26 Juli 2026.** Dua rangkaian curhat dengan jeda alami
masih terpecah. Riwayat aktual menunjukkan rangkaian pertama masuk sebagai tiga
bubble gabungan, lalu satu, lalu satu; rangkaian kedua masuk sebagai dua bubble
lalu dua bubble. Proses bot sudah memakai source terbaru, jadi ini bukan build
lama atau dua instance bot. Selisih antar-batch sekitar 3–4,5 detik membuktikan
deadline universal 2,5 detik menutup giliran terlalu dini.

Kebijakan sekarang memakai empat keadaan. Pesan lengkap tunggal diproses
setelah pemeriksaan; beberapa bubble lengkap diberi 4 detik, pembuka/narasi
terbuka 7 detik, dan fragmen seperti "karna" 12 detik sejak bubble terakhir.
Bahaya segera yang konkret dikenali lokal dan langsung diproses tanpa menunggu
debounce atau jaringan batas giliran; handler lengkap tetap mengikuti antrean
pengguna. Pagar lokal juga mengenali "aku boleh curhat kah",
penutup seperti "udah itu aja", serta membedakan kata sambung "jadi" dari
penutup "nggak jadi". Perbaikan adaptif lulus tes otomatis dan probe Gemini
langsung, tetapi belum dicoba lagi melalui Telegram.

Antrean percakapan masih berada di memori proses. Shutdown normal mengurasnya,
tetapi keluar paksa setelah grace period 60 detik atau crash setelah update
diterima Telegram dapat kehilangan giliran yang belum selesai. Operasi I/O yang
tidak pernah selesai juga dapat menahan chain satu pengguna sampai batas
shutdown, tanpa menahan polling global atau pengguna lain. Drain tidak
menunggu ACK callback, cleanup notice kosmetik, atau pemadatan latar.

Pernah gagal, sudah diperbaiki:

- **Balasan model terpotong.** Dua percobaan pengingat pertama dijawab "Aku
  belum menangkap maksudnya". Penyebabnya bukan format, melainkan panjang:
  `gemini-3.6-flash` memakai token keluaran untuk berpikir, dan batas 400 token
  habis sebelum JSON-nya ditutup. Sapaan pendek tetap lolos, sehingga cacatnya
  hanya menyerang pesan yang paling perlu dipahami. Batas dinaikkan dan
  `finish_reason=length` kini dicatat ke log.
- **Harvy menyangkal riwayat yang tidak diingatnya.** Ditanya "aku tanya apa
  tadi", ia menjawab "ini pesan pertama kamu di obrolan kita" — pernyataan yang
  tidak benar tentang pengalaman penggunanya sendiri. Prompt kini mewajibkannya
  mengaku tidak punya ingatan percakapan. Ini pelanggaran Pasal 3.6 dan Pasal 5
  nomor 6, bukan sekadar fitur yang belum ada.

Masih belum pernah terjadi setelah perbaikan adaptif terbaru `ADR-007`:

- satu rangkaian bubble dengan jeda 3–4,5 detik diproses sebagai satu giliran
  pada Telegram;
- permintaan membuat kode dijawab dengan hasil tanpa membuat tugas;
- preferensi baru ditanggapi dan diingat tanpa membuka daftar memori;
- pertanyaan riwayat yang dijawab benar pada Telegram;
- tombol Oke serta penghapusan otomatis pemberitahuan memori;
- peringkasan riwayat latar pada percakapan nyata;
- percakapan keselamatan;
- pemakaian lebih dari beberapa menit berturut-turut.

Dilaporkan pengguna, belum diamati penulis kode:

- pengingat benar-benar terkirim oleh worker pada waktunya. Dicatat di sini
  karena laporan pengguna adalah bukti yang sah, tetapi jenisnya berbeda dari
  pengamatan langsung dan tidak boleh ditulis seolah sama.

Untuk baris yang masih "Ada" tanpa keterangan terbukti, artinya *ada di kode dan
lolos gerbang otomatis*, bukan *terbukti bekerja bagi pengguna*.

### Perlu diperiksa

Pada transkrip 26 Juli 2026, konfirmasi setelah tombol Selesai muncul sebagai
"Selesai ✓" tanpa judul tugas, padahal `refreshAfterChange` menyusunnya sebagai
`Selesai ✓ <judul>`. Belum jelas apakah judulnya benar-benar hilang atau hanya
tidak ikut tersalin saat transkrip disalin. Perlu diamati sekali lagi.

## Cara merawat dokumen ini

Perbarui tabel pada sesi yang mengubah kemampuannya, bukan belakangan. Hapus
baris dari "Cacat yang diketahui" hanya setelah ada bukti, bukan setelah ada
niat. Bila sebuah baris berubah menjadi "Ada", sebutkan bukti apa yang membuatnya
berubah — gerbang otomatis, uji manual, atau keduanya — dan catat perubahannya di
[`../LOG.md`](../LOG.md).
