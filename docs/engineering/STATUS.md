# Status Kemampuan Harvy

Dokumen ini menjawab satu pertanyaan saja: **apa yang benar-benar berjalan hari
ini.** Dokumen lain di repositori ini menjelaskan tujuan, keputusan, dan batas
moral — semuanya sah, tetapi tidak satu pun menyatakan keadaan kode. Perbedaan
itu pernah membuat agent dan manusia sama-sama mengira kemampuan yang masih
berupa rencana sudah tersedia.

Aturannya: **jika sebuah kemampuan tidak tercatat “Ada” di sini, jangan
mengklaimnya ada.** Kalau dokumen lain terdengar lebih optimistis, dokumen ini
yang menang, dan perbedaannya dilaporkan.

- Terakhir diverifikasi: 27 Juli 2026.
- Basis: commit `2a9cb35` ditambah perubahan rasa percakapan, onboarding, dan
  perbaikan pasca-transkrip yang belum di-commit.
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
| Perkenalan pada kontak pertama | Ada, sekali diuji Telegram lalu diperbaiki | Dipicu pesan bebas maupun `/start`. Dua bubble, tombol "Oke, mulai" dan "Aku mau tanya dulu". Pesan yang telanjur dikirim ditahan di memori proses lalu diproses sendiri setelah tombol ditekan. Pengguna lama disapa dari jumlah tugas aktifnya, bukan dari ingatan yang dikarang |
| Preferensi gaya menemani | Ada, belum diuji Telegram | Satu pertanyaan setelah percakapan punya isi — sejak 27 Juli 2026 baru muncul ketika riwayat sudah mencapai enam giliran, karena pada uji pertama ia menyusul pesan pembuka "p". Ditanyakan sekali, dijawab atau tidak, dan tidak muncul bila ada pertanyaan lain yang menunggu |
| Pesan bebas dipahami model | Ada | Jalur utama. Dua langkah: ekstraksi `cheap`, lalu balasan sesuai tingkatan. Intent dipisahkan dari aksi agar output model yang kontradiktif tidak langsung mengubah data |
| Penggabungan bubble pengguna | Ada; timer lama terbukti terlalu pendek, perbaikan adaptif belum diuji Telegram | Enqueue langsung mengembalikan kendali ke grammY; jeda 650 ms menggabungkan burst, lalu model `cheap` memilih `complete/open/incomplete/urgent` dengan pagar lokal. Pesan tunggal lengkap langsung diproses; gabungan lengkap, pembuka, dan fragmen menggantung masing-masing diberi 4/7/12 detik sejak bubble terakhir. Bahaya segera lokal tidak menunggu model. Pemeriksaan per pemilik tidak tumpang tindih; command/callback masuk antrean per pengguna tanpa menahan polling global; shutdown normal menguras antrean |
| Balasan dalam beberapa bubble | Ada, belum teruji Telegram setelah perbaikan | Paragraf dikirim terpisah, maksimal tiga bubble. Blok kode tetap utuh bila muat; pesan di atas 4.000 karakter dipecah agar tidak ditolak Telegram. Sejak 26 Juli 2026 ada indikator mengetik dan jeda 0,3–1,2 detik antar bubble, dan prompt memang meminta balasan ditulis sebagai satu sampai tiga paragraf pendek |
| Balasan yang tidak terdengar seperti mesin | Sebagian; terbukti gagal di Telegram lalu diperbaiki | Uji pertama justru menghasilkan balasan jutek — "Gitu aja sih." — karena aturan anti-pola terlalu keras. Aturannya diseimbangkan pada 27 Juli 2026: larangan balasan datar yang menutup obrolan, panjang mengikuti apa yang dibawa pengguna, dan keluhan ringan tidak boleh dijawab dengan saran istirahat. Pesan di atas 400 karakter mendapat `depthDirective` berisi kerangka isi pesannya sendiri. Probe ulang membaik pada semua skenario kecuali satu, lihat di bawah |
| Balasan tahu waktu | Ada, belum diuji Telegram | `replyPrompt` menerima jam dan zona waktu. Sebelumnya hanya langkah pemahaman yang tahu, dan Harvy menyuruh penggunanya rebahan pada pukul 23.02 |
| Permintaan hasil langsung | Ada, terbukti pada probe model | Intent `request` memenuhi permintaan yang dapat dikerjakan di chat, misalnya menulis kode; tidak membuat atau menawarkan tugas. Plafon balasan 4.096 token, lalu pesan panjang dibagi sesuai batas Telegram |
| Curhat tidak otomatis jadi tugas | Ada | Harvy menjawab dulu, pencatatan ditawarkan lewat tombol |
| Pencatatan tugas + tombol tindakan | Ada, terbukti sebelum perubahan balasan | Tugas tercatat dan tombol Selesai berfungsi pada percakapan nyata 26 Juli 2026. Sejak 26 Juli 2026 kartunya didahului balasan percakapan; sebelumnya kalimat yang membawa perasaan sekaligus tugas hanya dijawab struk pencatatan. Bila balasan gagal dibuat, tugasnya tetap dicatat dengan kalimat pembuka dari kode |
| Tombol adaptif yang disusun AI | Belum | Seluruh papan tombol ditulis tangan dan tetap di `src/bot/messages.ts`. Model tidak ikut menentukan tindakan apa yang ditawarkan |
| `/start`, `/tugas`, `/bantuan` | Ada, sebagai pelengkap | Bukan cara utama. Tidak ada perintah lain; pesan `/` lain dijawab dengan bantuan |
| Pengurutan prioritas | Ada | Murni dan teruji unit di `src/core/prioritizer.ts` |
| Pengingat | Sebagian | Dapat diminta lewat kalimat ("ingetin aku jam 8") atau tombol. Pengiriman oleh worker **dilaporkan pengguna** berhasil pada 26 Juli 2026; penulis kode belum mengamatinya sendiri. Lewat tombol waktunya masih ditetapkan Harvy, satu jam sebelum tenggat. Jam tenang dan frekuensi belum ada |
| Penyimpanan per pengguna | Ada | JSON atomik, terisolasi lewat `ownerId`. Berlaku sama untuk tugas, memori, dan riwayat |
| Rotasi kunci mode uji | Ada | Teruji unit; perilaku terhadap kuota nyata belum diamati |
| Tutoring bertahap | Belum | Promptnya ada dan riwayat percakapan kini tersedia, tetapi pola lima langkah Pasal 3.4 belum ditulis sebagai alur dan belum pernah diamati berjalan lintas pesan |
| Riwayat percakapan | Ada, terbukti gagal sebelum perbaikan; perbaikan belum teruji Telegram | Enam giliran terakhir dibawa ke pemahaman **dan** balasan; intent `history` membedakannya dari daftar memori. Sejak 26 Juli 2026 langkah balasan mengirimnya sebagai pesan chat sungguhan, bukan kutipan di dalam prompt; pemahaman tetap memakai `<konteks>`. Setelah 16 giliran, pemadatan berjalan di latar setelah balasan dan mempertahankan pesan baru |
| Memori terstruktur dan kendalinya | Ada, terbukti sebagian | Lima jenis. `personal` dan isi yang terdeteksi sensitif selalu minta izin; sisanya disimpan otomatis. Sejak 26 Juli 2026 pemberitahuannya menempel sebagai satu baris `📎` di ujung balasan berikut tombol Lupakan, menggantikan bubble tersendiri yang harus ditutup. Daftar, lupakan satu, dan lupakan semua ada. Transkrip nyata membuktikan simpan biasa dan tawaran sensitif tampil; bentuk barunya belum diuji Telegram |
| Pemeriksaan keselamatan sebagai lapisan | Belum | Batas giliran punya pengaman lokal agar bahaya segera tidak menunggu classifier, tetapi handler lengkapnya masih FIFO di belakang balasan aktif. Isi respons keselamatan juga masih hanya mengandalkan satu field JSON dari model ekstraksi lalu tambahan prompt; belum ada preemption atau acknowledgment prioritas |
| Pemeriksaan respons sebelum dikirim | Belum | Balasan model langsung diteruskan ke pengguna |
| Pemberitahuan dan persetujuan privasi | Ada, belum diuji Telegram | Sejak 26 Juli 2026 pesan tidak dikirim ke penyedia sebelum pengguna menyetujuinya. Gerbangnya berada sebelum `MessageBatcher.enqueue`, jadi klasifikasi batas giliran pun tidak berjalan lebih dulu. Persetujuannya berversi (`CONSENT_VERSION`) dan disimpan terpisah dari memori serta riwayat. Belum ada cara menarik persetujuan selain berhenti memakai Harvy |
| Zona waktu per pengguna | Belum | Satu zona untuk semua, dari `.env` |
| Ekspor dan hapus seluruh data | Sebagian | "Lupakan semua tentang aku" menghapus memori, riwayat, dan preferensi gaya dari dalam chat. Catatan persetujuan sengaja bertahan supaya menghapus data tidak berubah menjadi perkenalan ulang. Tugas belum ikut, dan ekspor belum ada sama sekali |
| Batas pemakaian dan pemantauan biaya | Belum | Tidak ada penghitungan token |
| Ukuran keberhasilan Pasal 8 | Belum | Tidak ada yang diukur, termasuk yang boleh diukur |
| WhatsApp dan website | Belum | Belum dimulai, dan memang belum dijadwalkan |

## Cacat yang diketahui

**Uji Telegram 26 Juli 2026 (transkrip pengguna nyata) menemukan sepuluh cacat.**
Seluruhnya sudah diperbaiki di working tree dan dijaga tes, tetapi **belum satu
pun diuji ulang lewat Telegram**:

1. Balasan terdengar jutek. "Aku jalan pakai sistem dari Google. Gitu aja sih."
   Aturan anti-pola yang ditambahkan sehari sebelumnya terlalu keras dan
   berubah menjadi kekakuan.
2. Curhat sembilan paragraf dijawab satu kalimat.
3. Harvy tidak tahu jam berapa sekarang: pukul 23.02 ia menyuruh "rebahan dulu"
   lalu mengajak "ngobrol sambil nunggu malam".
4. Pesan pertama seseorang dijawab "Ada yang mau dibahas lagi?" — percakapan
   yang tidak pernah ada.
5. **Orientasi seksual tersimpan otomatis tanpa izin.** "menyukai seseorang
   berjenis kelamin pria" lolos dari pagar sensitif karena `jenis kelamin`
   tidak cocok dengan "berjenis kelamin" dan "pria" tidak ada di daftarnya. Ini
   pelanggaran Pasal 4 nomor 3, dan cacat yang sama pernah terjadi pada 26 Juli
   dengan susunan kalimat yang berbeda.
6. "iya kan aku udah tulis di situ kamu pahami aja" membuka seluruh daftar
   memori berikut tombol Lupakan semua — yang kemudian benar-benar ditekan, dan
   seluruh riwayat pengguna hilang.
7. "eh buat pengingat dong" langsung tersimpan sebagai tugas berjudul "Membuat
   pengingat" tanpa tenggat, padahal Harvy sendiri sedang menanyakan isinya.
8. Tombol "Aku mau tanya dulu" tetap hidup setelah ditekan, sehingga penjelasan
   persetujuan terkirim dua kali.
9. Naskah statis terpenggal di tengah kalimat karena baris sudah dipatahkan di
   kode; Telegram membungkusnya sekali lagi.
10. Catatan memori memanggil pemiliknya "Pengguna" di layarnya sendiri.

Pertanyaan gaya juga muncul terlalu dini, tepat setelah pesan pembuka "p".

Tidak ada cacat terbuka lain yang tercatat pada kode saat ini. Transkrip Telegram
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
menunggu ACK callback maupun pemadatan latar. Pesan yang ditahan sebelum
persetujuan juga hanya berada di memori proses: restart sebelum tombolnya
ditekan membuat pesan itu hilang, dan pengguna harus menulisnya lagi.

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

**Probe balasan, 26 Juli 2026.** `scripts/coba-balasan.ts` dijalankan terhadap
Gemini 3.5 Flash-Lite untuk lima kalimat: curhat dua bubble, lanjutan dengan
riwayat contoh, kalimat tugas bertenggat, permintaan pengingat, dan kebingungan
memulai dengan gaya `advice`. Semuanya menghasilkan balasan satu sampai dua
bubble pendek, tanpa menyebut nama pengguna, tanpa merangkum ulang, dan tanpa
mengulang pembuka giliran sebelumnya. Permintaan pengingat dijawab kalimat biasa
lebih dulu, bukan struk pencatatan.

Ini bukti tentang bentuk balasan pada beberapa kalimat, bukan bukti bahwa Harvy
terasa alami sepanjang percakapan panjang. Model produksi juga belum dipakai.

**Uji Telegram pertama alur kenalan, 26 Juli 2026.** Transkrip pengguna nyata
membuktikan alur perkenalan sampai persetujuan berjalan, pesan pertama benar
ditahan lalu diproses, memori tersimpan, dan pengingat dapat diminta. Transkrip
yang sama menemukan sepuluh cacat di atas — termasuk satu pelanggaran Pasal 4
nomor 3 dan satu kehilangan seluruh riwayat pengguna.

**Uji ulang lewat probe model, 27 Juli 2026.** Dua belas skenario dari transkrip
dijalankan ulang lewat `scripts/coba-balasan.ts` dan `scripts/coba-pemahaman.ts`
pada Gemini 3.5 Flash-Lite. Delapan skenario membaik dan lulus: pesan pertama
tidak lagi mengarang percakapan lama, pertanyaan tentang model dijawab hangat,
"kok jutek banget sih" ditanggapi mengundang, curhat panjang menyentuh empat
topik berbeda, saran waktunya cocok dengan tengah malam, dan ketiga pagar
klasifikasi — tugas kosong, daftar memori, jenis memori sensitif — berperilaku
benar.

Yang masih lemah setelah perbaikan:

- Keluhan ringan sempat dijawab terlalu berat; setelah panduan `feeling` dibagi
  menurut beratnya, probe ulang menghasilkan balasan yang ringan dan pas.
- Saran yang ditawarkan pada dua giliran berturut-turut masih sejenis meskipun
  kalimatnya berbeda.
- **Pesan panjang yang dibuka satu kalimat pengarah tetap dijawab hanya tentang
  kalimat pembuka itu.** Lima variasi penempatan perintah kedalaman dicoba dan
  tidak satu pun mengubahnya. Isi yang sama tanpa kalimat pembuka itu dijawab
  penuh, jadi penyebabnya bukan panjang pesan melainkan kalimat pengarahnya.
  Ini tampak sebagai batas kemampuan model kecil, dan mode `testing` memakai
  satu model kecil untuk semua tingkatan sehingga tidak dapat dibedakan dari
  sini. Harus diuji ulang dengan `AI_MODE=production` sebelum disebut selesai.

Masih belum pernah terjadi setelah perbaikan adaptif terbaru `ADR-007`:

- satu rangkaian bubble dengan jeda 3–4,5 detik diproses sebagai satu giliran
  pada Telegram;
- permintaan membuat kode dijawab dengan hasil tanpa membuat tugas;
- preferensi baru ditanggapi dan diingat tanpa membuka daftar memori;
- pertanyaan riwayat yang dijawab benar pada Telegram;
- peringkasan riwayat latar pada percakapan nyata;
- percakapan keselamatan;
- pemakaian lebih dari beberapa menit berturut-turut.

Belum pernah terjadi sama sekali, dari perubahan 26 Juli 2026:

- perkenalan kontak pertama pada Telegram, termasuk penahanan pesan pertama dan
  pemrosesannya setelah tombol ditekan;
- arahan keselamatan pra-persetujuan;
- pertanyaan preferensi gaya dan pengaruhnya pada balasan berikutnya;
- catatan memori `📎` yang menempel di balasan berikut tombol Lupakan;
- jeda dan indikator mengetik antar bubble;
- injeksi lewat giliran lama sekarang bahwa riwayat berperan `user` sungguhan.
  Tesnya hanya membuktikan penegasannya ada di prompt, bukan bahwa model
  menaatinya.

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
