# Catatan Pekerjaan Harvy

Dokumen ini menjawab: **apa yang dikerjakan terakhir kali, dan kenapa.**

Sesi kerja Harvy dilakukan bergantian oleh manusia dan beberapa AI yang tidak
saling membaca riwayat percakapan. Tanpa catatan ini, setiap sesi baru harus
menebak keadaan dari kode — dan dugaan yang masuk akal pernah masuk ke dokumen
sebagai fakta yang tidak pernah terjadi. Lihat
[`ADR-005`](decisions/ADR-005-konteks-menggantikan-work-order.md).

Urutan terbaru di atas. Tulis entri sebelum sesi berakhir, bukan setelah
diminta.

Bagian sebuah entri:

| Bagian | Isi |
|---|---|
| **Kenapa** | Alasan pekerjaan itu dilakukan |
| **Yang berubah** | Berkas dan perilaku yang bergeser |
| **Dibahas** | Keputusan, kesimpulan, atau arah yang muncul dari diskusi — meski belum ada kode yang ditulis |
| **Bukti** | Perintah verifikasi yang benar-benar dijalankan beserta hasilnya, dan apa yang tidak diuji |
| **Sengaja ditinggalkan** | Pekerjaan yang diketahui tetapi tidak dikerjakan |

Bagian yang tidak relevan boleh dihilangkan, kecuali satu: **sesi yang hanya
berdiskusi tetap wajib menulis entri dengan bagian "Dibahas"**. Keputusan yang
hanya hidup di percakapan akan hilang, karena sesi berikutnya — manusia maupun
AI — tidak dapat membacanya.

---

## 26 Juli 2026 — Kerja langsung di `main` diizinkan

**Kenapa.** Pemilik produk meminta agar agent boleh mengedit branch `main`
langsung tanpa wajib membuat pull request, serta meminta larangan lama dihapus
atau diselaraskan.

**Yang berubah.**

- `AGENTS.md` dan `docs/operations/WORKFLOW.md` kini mengizinkan agent menulis
  serta membuat commit pada branch aktif, termasuk `main`.
- Branch terpisah dan pull request dinyatakan opsional—dipakai hanya bila
  diminta atau berguna untuk isolasi pekerjaan dan review.
- Push, force-push, merge, rebase, dan penghapusan branch tetap hanya dilakukan
  bila diminta; izin bekerja langsung di `main` bukan izin melakukan perubahan
  eksternal diam-diam.
- Catatan keputusan di `ADR-001` dan `ADR-005` diperbarui agar aturan historis
  tidak bertentangan dengan instruksi aktif.

**Bukti.** Seluruh larangan aktif terhadap tulisan langsung di `main` dicari di
`AGENTS.md`, `README.md`, `docs/`, dan `.githooks`; sumber yang ditemukan telah
diselaraskan. `git diff --check` lulus dan `npm run check` lulus. Pemanggilan
awal `npm test` menemukan tiga tes JavaScript lama di `dist/` dari branch lain,
bukan kegagalan sumber saat ini. Setelah memastikan target lalu menghapus hanya
hasil build `C:\Users\imamh\harvy\dist`, `npm test` membangun ulang dan lulus:
63 tes dalam 11 suite, 0 gagal. Perubahan hanya menyentuh dokumentasi dan aturan
kerja.

Yang **tidak** dilakukan: tidak ada branch yang dipindah, tidak ada commit,
push, merge, rebase, pull request, kode produk, konfigurasi runtime, atau proses
bot yang diubah.
## 26 Juli 2026 — Onboarding dipicu kontak pertama, bukan `/start`

**Dibahas.** Pemilik produk meluruskan rancangan UX kenalan. Perkenalan Harvy
harus terjadi pada kontak pertama pengguna, baik ia mengirim `/start` maupun
langsung menulis pesan biasa. `/start` hanyalah salah satu pintu masuk dan
tidak boleh menjadi syarat memperoleh onboarding.

Jika pesan pertama sudah membawa isi—misalnya pengguna langsung bercerita—pesan
itu perlu ditahan lokal, perkenalan serta persetujuan ditampilkan, lalu pesan
aslinya diproses otomatis setelah pengguna melanjutkan. Pengguna tidak diminta
mengetik ulang. Pengguna lama yang menjalankan `/start` tidak mengulang
onboarding atau kehilangan konteks.

Frasa “AI pendamping” dinilai kaku dan membuat kemampuan Harvy terdengar sempit.
Perkenalan sebaiknya berfokus pada hal luas yang dapat dibawa pengguna:
cerita yang masih acak, pertanyaan, tugas, ide, rencana, atau sesuatu yang belum
tahu harus dimulai dari mana. Transparansi bahwa Harvy menggunakan AI tetap
diperlukan oleh Konstitusi, tetapi disampaikan terpisah dan alami bersama
penjelasan keterbatasan serta pemrosesan pihak ketiga—bukan dijadikan label
utama identitas Harvy.

Status onboarding sebaiknya terpisah dari keberadaan riwayat: menghapus riwayat
tidak otomatis menjadikan pengguna “baru”. Persetujuan juga perlu memiliki
versi agar dapat diminta ulang hanya ketika ketentuannya benar-benar berubah.

Belum diputuskan naskah akhir perkenalan, perilaku saat pengguna mengirim pesan
lanjutan sebelum menekan consent, dan pengecualian untuk pesan pertama yang
menunjukkan bahaya segera. Tidak ada kode, konfigurasi, status kemampuan, tes,
atau proses bot yang diubah.

## 26 Juli 2026 — UX kenalan dan rasa percakapan diusulkan

**Dibahas.** Pemilik produk ingin Harvy memberi kesan “ini AI yang aku
butuhkan”: hangat dan senyaman chat dengan teman, tetapi tetap jujur sebagai AI.
Pengalaman pengguna pertama juga belum ada; seharusnya Harvy berkenalan sebelum
menumpahkan petunjuk penggunaan.

Pemeriksaan alur saat ini menunjukkan `/start` langsung mengirim satu blok
panjang berisi fokus tugas, contoh, memori, dan daftar perintah. Belum ada status
pengguna baru/kembali, consent pemrosesan pihak ketiga, pertanyaan panggilan,
atau preferensi cara didampingi. Pengguna mendapat manual sebelum merasakan
percakapan.

Arah yang diusulkan bernama sementara **“Kenalan & Cara Harvy Menemani”**:

1. perkenalan dalam dua atau tiga bubble pendek: nama Harvy, identitas sebagai
   AI pendamping, dan manfaat utama tanpa daftar fitur;
2. pemberitahuan privasi ringkas serta persetujuan sebelum pesan pertama
   dikirim ke penyedia model;
3. nama panggilan bersifat opsional, dapat memakai nama Telegram atau dilewati;
4. Harvy menanyakan satu preferensi yang benar-benar berguna—misalnya lebih
   suka didengarkan dulu atau langsung diberi saran—bukan mengumpulkan profil;
5. pesan pertama yang sudah telanjur dikirim ditahan lokal lalu diproses
   otomatis setelah consent, bukan diminta diketik ulang;
6. pengguna lama tidak mengulang onboarding ketika memakai `/start`; Harvy
   cukup menyapa dan menawarkan melanjutkan topik lama atau memulai hal baru;
7. semua tombol hanya jalan pintas; pengguna selalu boleh langsung menulis
   bebas.

Rasa “seperti teman” diartikan sebagai ritme dan perhatian, bukan kepura-puraan
bahwa Harvy manusia. Balasan perlu menghindari pola berulang seperti selalu
menyebut nama pengguna, selalu berkata “Harvy dengerin”, atau selalu menutup
dengan pertanyaan. Harvy sebaiknya membedakan keadaan menyimak, berdiskusi, dan
membantu bertindak; merujuk detail yang baru dikatakan; memberi satu respons
yang relevan per bubble; dan baru menawarkan solusi ketika dibutuhkan.

Belum diputuskan apakah preferensi gaya ngobrol ditanyakan saat onboarding atau
setelah interaksi pertama yang berhasil. Belum diputuskan pula naskah akhir,
jumlah bubble, tombol, ataupun bentuk penyimpanan status onboarding. Alur
keselamatan tetap kandidat penting dan tidak dianggap selesai oleh rancangan
onboarding ini.

Yang **tidak** dilakukan: tidak ada kode, konfigurasi, status kemampuan, tes,
atau proses bot yang diubah.

## 26 Juli 2026 — Prioritas fitur berikutnya dibahas, belum dipilih

**Dibahas.** Pemilik produk meminta diskusi saja mengenai fitur berikutnya.
Tidak ada implementasi atau keputusan final.

Sebelum menambah kemampuan, perbaikan terbaru tetap perlu diuji ulang lewat
Telegram dan Sprint 1 masih mempunyai uji mandiri tujuh hari yang belum
selesai. Sesudah itu, kandidat terkuat adalah **lapisan keselamatan mandiri dan
alur bantuan manusia**. Alasannya berdasarkan keadaan produk, bukan sekadar
backlog: pengguna sudah memakai Harvy untuk curhat, audiens mencakup pelajar di
bawah 18 tahun, sementara `STATUS.md` masih mencatat penilaian keselamatan hanya
berasal dari satu field model. Pagar `urgent` terbaru hanya melewati keputusan
batas bubble; ia belum memprioritaskan handler di atas balasan aktif dan belum
menjadi alur keselamatan khusus.

Arah awal yang layak dirancang kemudian:

1. membedakan tekanan biasa, kebutuhan dukungan manusia, dan bahaya segera
   secara proporsional;
2. menjalankan pemeriksaan terpisah sebelum intent umum;
3. memberi jalur prioritas atau acknowledgment aman tanpa merusak urutan
   riwayat;
4. tidak menyimpan isi sensitif otomatis; dan
5. mengarahkan pengguna kepada manusia aman tanpa membuat Harvy tampak seperti
   terapis atau layanan darurat.

Urutan kandidat setelah keselamatan adalah pemberitahuan serta persetujuan
pemrosesan pihak ketiga, tombol tindakan adaptif dan kontrol pengingat milik
pengguna, lalu tutoring lima langkah. Keselamatan dan privasi dipandang sebagai
gerbang sebelum memperluas penggunaan, sedangkan PostgreSQL, website, dan
WhatsApp belum menjadi prioritas berikutnya.

Yang **tidak** dilakukan: tidak ada kode, konfigurasi, status kemampuan, tes,
proses bot, atau keputusan arsitektur yang diubah. Pilihan akhir fitur berikutnya
tetap milik pemilik produk.

## 26 Juli 2026 — Batas giliran menjadi adaptif terhadap cara pengguna mengetik

**Kenapa.** Uji Telegram kelima membuktikan bahwa adapter nonblocking saja belum
cukup. Rangkaian "eh tau ga" sampai ungkapan takut terpecah menjadi tiga
giliran, dan rangkaian "aku mau curhat" yang berakhir sementara pada "karna"
terpecah menjadi dua. Riwayat aktual menunjukkan bubble memang sempat digabung,
tetapi hanya tiga lalu satu lalu satu pada rangkaian pertama, serta dua lalu dua
pada rangkaian kedua. Proses bot sudah menjalankan source terbaru; penyebabnya
bukan build lama atau instance ganda, melainkan deadline universal 2,5 detik
yang lebih pendek daripada jeda alami pengguna sekitar 3–4,5 detik.

**Yang diputuskan.** Tidak ada sinyal Telegram yang menyatakan pengguna benar-
benar selesai mengetik, sehingga batas giliran tetap merupakan perkiraan dari
isi dan waktu hening. Satu angka tidak cukup untuk sapaan lengkap, pembuka
cerita, kalimat menggantung, dan keadaan darurat. Keputusan model diubah menjadi
empat keadaan dengan jendela berbeda, serta pagar lokal untuk kasus yang jelas.

**Yang berubah.**

- `Conversation.classifyTurnBoundary` meminta model `cheap` mengeluarkan
  `complete`, `open`, `incomplete`, atau `urgent`; parser masih menerima bentuk
  boolean lama secara defensif.
- `turn-taking-policy.ts` menjadi sumber kebijakan murni. Pesan lengkap tunggal
  diproses setelah debounce dan pemeriksaan model; gabungan lengkap diberi
  ruang 4 detik, pembuka/narasi terbuka 7 detik, dan fragmen keras seperti
  "karna" 12 detik sejak bubble terakhir.
- Pengaman lokal mengenali pembuka seperti "eh tau ga" dan "aku boleh curhat
  kah", emosi samar, kata sambung menggantung, serta penutup eksplisit seperti
  "udah itu aja" dan "nggak jadi". Penutup menang atas pembuka lama agar Harvy
  tidak menunggu setelah pengguna jelas selesai.
- Bahaya segera yang konkret diproses langsung ketika bubble masuk, sebelum
  debounce atau request jaringan batas giliran. Kata takut/capek tanpa ancaman
  konkret tetap dianggap percakapan terbuka, bukan otomatis darurat. Handler
  lengkapnya masih menjaga urutan FIFO dengan balasan yang sudah aktif.
- `MessageBatcher` tetap memakai satu evaluator per pemilik, revision guard,
  antrean per pengguna, serta fail-safe dari waktu bubble terakhir. Keputusan
  model yang gagal jatuh ke kebijakan lokal; satu kegagalan jaringan tidak lagi
  memaksa pembuka atau fragmen jelas ditutup cepat.
- Prompt, skrip diagnostik, README, ADR, status, kontrak agent, dan panduan uji
  diselaraskan dengan state serta jendela adaptif baru.

**Bukti.**

- `npm run check` PASS.
- Target absolut `C:\Users\imamh\harvy\dist` diverifikasi lalu hasil build lama
  dihapus sebelum gerbang akhir.
- Tes terarah `conversation`, `MessageBatcher`, dan kebijakan giliran PASS —
  **35 test dalam 4 suite**, 0 gagal. Regresinya memakai dua rangkaian persis
  dari uji Telegram, sengaja memberi jarak lebih panjang daripada debounce, dan
  memaksa model palsu salah memilih `complete`.
- `npm test` PASS — **122 test dalam 20 suite**, 0 gagal.
- Putaran bersih pertama sempat menghasilkan 121 lulus dan satu kegagalan:
  tes regresi memakai timer mini 70/140 milidetik dan di mesin yang sedang berat
  jeda test runner sendiri melewati jendelanya sebelum bubble berikut dikirim.
  Tes diubah memakai margin panjang serta `drain` eksplisit; aturan angka
  4/7/12 detik tetap diuji murni tanpa jam dinding. Tes terarah dan gerbang
  penuh sesudah koreksi sama-sama lulus.
- `git diff --check` PASS; peringatan yang tampil hanya normalisasi LF ke CRLF.
- Probe Gemini 3.5 Flash-Lite sungguhan pada `AI_MODE=testing`:
  - rangkaian "eh tau ga" sampai ungkapan takut sempat timeout pada percobaan
    pertama, lalu menghasilkan `{"state":"open"}` pada pengulangan;
  - rangkaian yang berakhir "karna" menghasilkan
    `{"state":"incomplete"}`; dan
  - "halo" menghasilkan `{"state":"complete"}`.
  Timeout pertama penting: tes otomatis juga membuktikan pagar lokal tetap
  menahan rangkaian dan batas giliran darurat tetap dilewati ketika classifier
  tidak pernah selesai.

Yang **tidak** diuji: Telegram belum dicoba lagi setelah kebijakan adaptif
ditulis. Karena itu belum ada klaim bahwa jeda 4/7/12 detik terasa tepat pada
pengguna nyata atau bahwa satu rangkaian terbaru benar-benar tersimpan sebagai
satu giliran. Model produksi `deepseek/deepseek-v4-flash`, tombol, pengingat,
dan shutdown nyata juga `NOT RUN` pada sesi koreksi ini.

Proses dev yang lama ternyata sudah tidak aktif. `npm run dev` dinyalakan lagi
setelah gerbang lulus; pemeriksaan proses menunjukkan satu watcher `tsx` dan
satu child `src/app.ts`, sehingga bot siap menerima uji Telegram terbaru tanpa
instance aplikasi ganda.

**Sengaja ditinggalkan.** Jendela belum dipersonalisasi dari kecepatan ketik
masing-masing pengguna; itu memerlukan data perilaku tambahan dan keputusan
privasi yang tidak diambil diam-diam. Antrean tetap in-memory dan tidak tahan
crash paksa. Keadaan `urgent` belum membatalkan handler yang sudah aktif atau
mengirim acknowledgment keselamatan independen; keduanya memerlukan desain
alur keselamatan agar tidak merusak urutan riwayat.

## 26 Juli 2026 — Bubble cepat benar-benar disimak sebagai satu giliran

**Kenapa.** Uji Telegram keempat memperlihatkan bahwa perbaikan penggabungan
bubble sebelumnya belum bekerja pada adapter nyata. Empat potongan curhat yang
dikirim pada detik yang sama masih menghasilkan tiga balasan Harvy sebelum
pengguna selesai. Penyebabnya bukan keputusan model: handler Telegram menunggu
model batas giliran dan seluruh balasan Harvy, sedangkan long-polling grammY
baru menyerahkan update berikutnya setelah handler itu kembali. Dengan urutan
tersebut, bubble berikutnya memang tidak pernah sempat masuk ke batch yang sama.

**Yang berubah.**

- `MessageBatcher.enqueue` kini hanya menaruh bubble dan langsung kembali.
  Setiap bubble memulai ulang jeda hening 650 milidetik serta deadline keras 2,5
  detik dari bubble terakhir. Setelah jeda hening, model `cheap` menilai
  gabungannya; keputusan yang kalah cepat dari bubble atau deadline baru
  diabaikan melalui revision guard. Hanya satu evaluator per pemilik yang aktif
  dan revisi perantara dikoaleskan ke gabungan terbaru.
- Prompt batas giliran menilai apakah pengguna **selesai menulis**, bukan apakah
  Harvy sudah dapat memberi balasan sopan. Pembuka curhat dan narasi pribadi
  ditunggu; sapaan, permintaan lengkap, penutup, serta pesan keselamatan yang
  mendesak langsung diproses.
- Indikator mengetik dipindahkan ke awal penanganan batch, sehingga Harvy tidak
  tampak mengetik pada setiap potongan ketika sebenarnya sedang menyimak.
  Kegagalan indikator kini best-effort dan tidak membuang giliran.
- Handler satu pengguna tetap berurutan, tetapi berjalan dari antrean latar.
  Command dan callback masuk ke chain pemiliknya tanpa menahan long-polling
  global. Permintaan ACK callback dikirim segera secara fire-and-forget dan
  aksi tidak menunggunya.
- Shutdown normal menghentikan polling lalu menguras seluruh batch dan aksi
  latar serta evaluator aktif sebelum proses selesai, dengan batas 60 detik
  agar deployment tidak menggantung tanpa akhir. ACK callback, cleanup notice
  fire-and-forget, dan pemadatan riwayat latar berada di luar drain.
- `/start` dan `/bantuan` membatalkan potongan yang belum mulai. `/tugas`
  mengurasnya lebih dulu agar pernyataan tugas yang baru dikirim tidak hilang.
  Token generasi turut membatalkan batch yang sudah masuk chain tetapi belum
  mulai. Callback juga menguras giliran terdahulu sebelum mutasi, sehingga
  Lupakan semua tidak dapat diikuti penyimpanan terlambat dari handler lama.
- Status **Ubah tenggat** sekarang diperiksa ketika batch mendapat giliran,
  bukan saat update tiba. Ini menjaga jawaban tanggal yang dikirim segera
  setelah tombol, meskipun tindakan tombol masih mengantre di belakang balasan
  lama.
- Pembersihan pemberitahuan memori diulang saat handler benar-benar berjalan.
  Notifikasi yang dibuat terlambat oleh giliran sebelumnya tetap hilang ketika
  chat berikutnya dimulai. Referensi yang gagal dihapus dari Telegram disimpan
  ulang dengan deduplikasi untuk percobaan berikutnya. Lease/tombstone mencegah
  retry menghidupkan ref yang sudah ditanggapi saat delete masih berjalan;
  retry berhenti setelah tiga kegagalan permanen.
- `scripts/coba-pemahaman.ts --boundary` dapat memeriksa keputusan ini langsung
  ke model; `AGENTS.md`, `ADR-007`, `STATUS.md`, `TESTING.md`, dan `README.md`
  diselaraskan.

**Bukti.**

- `npm run check` PASS.
- `dist/` dihapus setelah target absolut
  `C:\Users\imamh\harvy\dist` diverifikasi; `npm test` PASS —
  **113 test dalam 19 suite**, 0 gagal.
- Suite `MessageBatcher` sendiri PASS — **15 test**, termasuk burst empat
  bubble, model lambat, keputusan basi, deadline, urutan A aktif → B tertunda →
  tombol, kelanjutan setelah handler gagal, pembatalan evaluator dan batch
  queued, deduplikasi request, isolasi dua pengguna, serta drain seluruh batch
  dan evaluator saat shutdown.
- Tes indikator mengetik membuktikan kegagalan API kosmetik tidak melempar;
  enam tes store notice membuktikan referensi retry tidak digandakan maupun
  dihidupkan kembali setelah callback, lease selesai bersih, dan retry berhenti
  setelah tiga kegagalan.
- Gemini 3.5 Flash-Lite sungguhan pada `AI_MODE=testing`:
  - pembuka curhat → `{"wait":true}`;
  - sapaan mandiri → `{"wait":false}`;
  - lima bubble curhat gabungan → `{"wait":true}`; dan
  - pemahaman lima bubble itu → intent `feeling`, tanpa tugas, dengan satu
    usulan memori `personal` yang wajib meminta izin.
- Satu probe batas giliran sempat timeout pada dua detik; percobaan ulang
  berhasil. Deadline `MessageBatcher` tetap berjalan selama model berpikir, jadi
  kegagalan semacam ini tidak dapat memperpanjang hening melewati 2,5 detik.

Yang **tidak** diuji: bot Telegram belum dijalankan ulang setelah perubahan.
Penggabungan update nyata, ketiadaan indikator/balasan di sela bubble, callback
yang langsung menutup spinner, urutan Lupakan semua, serta respons akun kedua
ketika akun pertama menunggu model dan drain shutdown nyata tetap `NOT RUN`.
Model
`deepseek/deepseek-v4-flash` produksi juga tidak dipanggil.

**Sengaja ditinggalkan.** Pesan, tugas, atau memori dari uji lama tidak dihapus
atau dimigrasikan. Pengguna tetap menguasai penghapusannya melalui tombol.
Antrean belum persisten: crash paksa masih dapat kehilangan update yang sudah
diterima, dan shutdown yang melewati 60 detik keluar paksa. Cleanup kosmetik
dan pemadatan latar tidak ikut ditunggu drain.

## 26 Juli 2026 — Harvy membedakan siapa yang harus mengerjakan

**Kenapa.** Uji Telegram lanjutan menemukan dua salah arah yang berasal dari
kontrak intent, bukan sekadar pilihan kata balasan. Permintaan agar Harvy
membuat kode langsung disimpan sebagai tugas pengguna. Setelah itu, pernyataan
preferensi baru justru membuka daftar memori lama; fakta barunya tidak diproses.

**Yang diputuskan.** Intent menyatakan tujuan percakapan, sedangkan field action
memberi izin terhadap tindakan tertentu.

- `request` berarti Harvy harus menghasilkan sesuatu di chat, bukan mencatat
  pekerjaan.
- Hanya `task + taskAction: save + task` yang boleh menyimpan tugas.
- Hanya `feeling + taskAction: offer + task` yang boleh menawarkan tugas.
- Hanya `memory + memoryAction: list|forget`, tanpa usulan fakta baru, yang
  boleh membuka kontrol memori.
- Fakta atau preferensi baru tetap menjadi percakapan dengan usulan pada
  `memories`; keberadaannya tidak berarti pengguna meminta daftar.

**Yang berubah.**

- `persona.ts` menambah intent `request`, `taskAction`, `memoryAction`, aturan
  aktor pekerjaan, dan lima contoh JSON kontras.
- `understand.ts` memperlakukan output model sebagai kombinasi terdiskriminasi:
  task/action yang bertentangan dibuang, intent asing ditolak kecuali alias
  `reminder` yang terdaftar, dan fakta baru tidak boleh kalah oleh aksi daftar
  memori yang kontradiktif.
- `understanding-route.ts` menjadi pertahanan kedua di adapter. Cabang yang
  berhenti sebelum balasan hanya menerima pasangan intent/action yang sah.
- Alur Ubah tenggat dipisahkan dari intent umum melalui
  `Conversation.understandDueDate`. Parser hanya menerima ISO dengan waktu dan
  offset, dan skrip diagnostik mendapat flag `--due`.
- Balasan programatik untuk pencatatan, tawaran tugas, dan perubahan tenggat
  ikut ditulis ke riwayat; pemecahan bubble tidak lagi mengubah teks asli yang
  disimpan.
- Intent `request` memakai tier balasan seperti pertanyaan: `efficient` untuk
  permintaan biasa dan `ambitious` bila panjang atau perlu langkah bertahap.
- Plafon balasan dinaikkan dari 1.536 menjadi 4.096 token agar kode lengkap
  tidak terpotong sebelum dapat dibagi menjadi beberapa pesan.
- `messages.ts` menjaga setiap bubble di bawah 4.000 karakter. Blok kode pendek
  tetap utuh; kode panjang dibagi tanpa kehilangan karakter agar tidak ditolak
  Telegram.
- Tes parser, routing adapter, pemilihan model, prompt balasan, dan ukuran
  bubble diperluas. `ADR-007`, `PROJECT.md`, `STATUS.md`, `TESTING.md`,
  `README.md`, serta `AGENTS.md` diselaraskan.

**Bukti.**

- `npm run check` PASS.
- `dist/` dihapus setelah target absolut diverifikasi berada di root repo;
  `npm test` PASS — **96 test dalam 18 suite**, 0 gagal.
- Gemini 3.5 Flash-Lite sungguhan pada `AI_MODE=testing`:
  - "oiya buatin dong kode tictactoenya" → `request`, tanpa task/action;
  - "aku harus bikin kode tic-tac-toe" → `task + save`;
  - "aku kewalahan karena harus belajar biologi" → `feeling + offer`;
  - "warna favoritku biru" → `smalltalk` dengan memori `preference`; dan
  - "apa yang kamu ingat tentang aku" → `memory + list`.
- `npx tsx scripts/coba-pemahaman.ts --due "besok jam 7 malam"` →
  27 Juli 2026 pukul 19.00 WIB dengan offset `+07:00`.

Yang **tidak** diuji: bot Telegram tidak dijalankan ulang. Jadi pengiriman kode
sebagai balasan nyata, absennya tugas baru di penyimpanan, pemberitahuan
Oke/Lupakan untuk preferensi, pemecahan pesan panjang oleh API Telegram, dan
model DeepSeek V4 Flash produksi tetap `NOT RUN`.

**Sengaja ditinggalkan.** Tugas atau memori yang sudah salah tersimpan pada uji
lama tidak dihapus atau dimigrasikan diam-diam. Pengguna tetap menguasai
penghapusannya melalui tombol yang tersedia.

## 26 Juli 2026 — Harvy menunggu cerita selesai dan benar-benar membaca riwayat

**Kenapa.** Pemilik produk memberikan transkrip uji Telegram dan meminta lima
perbaikan UX: pertanyaan kemampuan/isi chat harus dijawab dari riwayat, Harvy
tidak boleh pikun pada "yang tadi", bubble pengguna yang dipenggal perlu
ditunggu dan digabung, pemberitahuan memori perlu tombol Oke serta dibersihkan
saat chat berlanjut, dan balasan panjang perlu terasa seperti beberapa bubble.

Transkrip juga membuka dua masalah yang lebih berat daripada UX: orientasi
seksual tersimpan otomatis sebagai `profile`, dan pemadatan riwayat menahan
balasan sekitar sepuluh menit sebelum berakhir dengan balasan terpotong/timeout.

**Yang diputuskan.** Lengkap di
[`ADR-007`](decisions/ADR-007-bubble-dan-riwayat-percakapan-natural.md).

1. Intent `history` dipisahkan dari `memory`. Yang pertama menjawab kemampuan,
   isi chat, dan "yang tadi" dari konteks; yang kedua hanya mengurus catatan
   terstruktur.
2. Model `cheap` memutuskan apakah bubble tampak belum selesai. Keputusannya
   maksimal dua detik dan satu percobaan; waktu menunggu lanjutan maksimal 2,5
   detik. Pesan lengkap diproses langsung.
3. Paragraf balasan menjadi maksimal tiga bubble; blok kode tidak dipecah.
4. Pemberitahuan memori biasa punya Oke dan Lupakan. Oke atau chat pengguna
   berikutnya menghapus bubble pemberitahuan, bukan memorinya.
5. Label sensitivitas model tidak dipercaya sendirian. Isi tentang kesehatan,
   keluarga, relasi, gender, orientasi seksual, dan tekanan emosional dipaksa
   meminta izin.
6. Pemadatan berjalan setelah balasan, mempertahankan pesan yang masuk ketika
   model bekerja, dan memakai cooldown satu menit setelah gagal.

ID `gemini-3.5-flash-lite` dan `deepseek/deepseek-v4-flash` diverifikasi pada
dokumentasi resmi [Google](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
dan [OpenRouter](https://openrouter.ai/deepseek/deepseek-v4-flash/api). `.env`
lokal diarahkan ke Gemini 3.5 Flash-Lite untuk testing dan DeepSeek V4 Flash
sebagai model `cheap` produksi; berkas itu tetap tidak masuk Git.

**Yang berubah.**

- Baru: `src/bot/message-batcher.ts`,
  `src/bot/ephemeral-message-store.ts`, `ADR-007`, serta empat suite tes untuk
  klien AI, batch bubble, pesan sementara, dan format bubble/tombol.
- `understand.ts`, `model-policy.ts`, dan `persona.ts`: intent `history`, prompt
  batas bubble, instruksi riwayat, klasifikasi sensitif yang lebih tegas, dan
  ringkasan yang mempertahankan topik belum selesai.
- `conversation.ts` dan `client.ts`: keputusan batas bubble lewat model murah,
  timeout/percobaan per request, dan `finish_reason=length` menjadi galat
  sungguhan alih-alih teks setengah jadi.
- `create-bot.ts` dan `messages.ts`: penggabungan bubble, pemrosesan per pengguna
  secara berurutan, balasan multi-bubble, tombol Oke, serta pembersihan
  pemberitahuan memori.
- `memory-policy.ts`: pagar deterministik untuk isi sensitif yang salah diberi
  jenis biasa oleh model.
- `history-service.ts`: append bebas model; pemadatan eksplisit di latar,
  penyimpanan berantre per pengguna, penggabungan aman dengan pesan terbaru,
  invalidasi setelah Lupakan semua, dan cooldown kegagalan.
- `PROJECT.md`, `STATUS.md`, `TESTING.md`, `INDEX.md`, `AGENTS.md`, `ADR-003`,
  dan `ADR-006` diselaraskan dengan keputusan serta keadaan baru.

**Bukti.**

- Tes regresi ditulis lebih dulu; `npm run check` awal gagal karena intent,
  metode, dan modul baru memang belum ada.
- Setelah implementasi, `npm run check` PASS.
- `npm test` PASS — **79 test dalam 16 suite**, 0 gagal; naik dari 63/11.
- Gemini 3.5 Flash-Lite, model sungguhan:
  - "kamu ingat isi chat kita kah" → intent `history`;
  - `halo` → tidak menunggu;
  - "aku boleh curhat kah" → menunggu;
  - tiga bubble curhat digabung → tidak menunggu lagi;
  - curhat gabungan → intent `feeling` dan memori `personal`;
  - dengan konteks sintetis "halo", pertanyaan kemampuan dijawab, "Iya, ingat.
    Tadi kita baru saja saling menyapa".

Yang **tidak** diuji: bot Telegram tidak dijalankan setelah perubahan. Jeda dan
penggabungan tiga update nyata, tombol Oke/Lupakan, penghapusan bubble melalui
API Telegram, riwayat setelah restart, pemadatan model di latar, dan perilaku
DeepSeek V4 Flash produksi tetap `NOT RUN`. Percakapan keselamatan, pengingat,
dan isolasi dua akun juga tidak disentuh.

**Sengaja ditinggalkan.** Pemberitahuan izin pemrosesan pihak ketiga, pemeriksaan
keselamatan tersendiri, pemeriksaan isi respons, dan pemantauan biaya tetap
belum ada. Keputusan batas bubble menambah satu panggilan model murah per
kumpulan pesan; biaya itu belum diukur.

## 26 Juli 2026 — Gerbang otomatis dan ekstraksi model diuji ulang

**Kenapa.** Diminta melakukan debug dan uji coba pada keadaan branch
`feat/memori-dan-riwayat-percakapan`. Sesi ini bersifat diagnosis: tidak ada
perbaikan perilaku yang diminta atau diterapkan.

**Dibahas.** Gerbang otomatis tetap sehat. Satu perilaku yang perlu diputuskan
sebelum disebut cacat ditemukan pada jalur pemadatan riwayat: ketika peringkas
melempar galat, `HistoryService` mempertahankan seluruh riwayat (benar, supaya
konteks tidak hilang), tetapi mencoba memanggil peringkas lagi pada **setiap
giliran baru** yang masih melewati ambang. Tes dengan 20 giliran mencetak empat
percobaan gagal setelah ambang 16; pada alur bot, pesan pengguna dan balasan
Harvy sama-sama ditambahkan sebagai giliran. Saat penyedia sedang bermasalah,
perilaku ini dapat menghasilkan panggilan model dan log berulang. Belum diubah;
pilihan seperti cooldown atau backoff memengaruhi kapan pemadatan dicoba lagi
dan berada di luar diagnosis ini.

**Bukti.**

- `npm run check` PASS.
- `dist/` dibuang setelah target absolutnya diverifikasi berada di root
  repository, lalu `npm test` PASS — **63 test dalam 11 suite**, 0 gagal.
- `npx tsx scripts/coba-pemahaman.ts "ingetin aku jam 8 minum obat"` PASS
  terhadap model sungguhan dalam `AI_MODE=testing`: terbaca sebagai tugas
  "Minum obat" dengan pengingat 20.00 WIB (`13:00Z`).
- `npx tsx scripts/coba-pemahaman.ts "aku kelas 11 IPA"` PASS: model mengusulkan
  memori biasa berjenis `profile`.
- `npx tsx scripts/coba-pemahaman.ts "aku punya penyakit jantung"` PASS: model
  mengusulkan memori sensitif berjenis `personal`.

Percobaan model pertama gagal karena koneksi keluar ditolak sandbox (`EACCES`);
perintah yang sama berhasil setelah izin jaringan diberikan. Tidak ada secret
yang dicetak.

Yang **tidak** diuji: bot Telegram tidak dijalankan, jadi penyimpanan memori,
tombol izin/Lupakan, riwayat lintas pesan dan restart, peringkasan nyata,
isolasi dua akun, pengiriman pengingat, serta percakapan keselamatan tetap
`NOT RUN`. Probe diagnostik hanya membuktikan keluaran langkah pemahaman model,
bukan alur end-to-end.

**Sengaja ditinggalkan.** Retry pemadatan tanpa cooldown tidak diperbaiki.
Tidak ada kemampuan di `STATUS.md` yang dinaikkan menjadi "terbukti", karena
belum ada uji Telegram end-to-end.

## 26 Juli 2026 — Harvy mulai mengingat penggunanya

**Kenapa.** Diminta memutuskan pekerjaan berikutnya, pemilik produk memilih
memori: Harvy menjengkelkan karena setiap giliran dimulai dari nol, dan tanpa
riwayat percakapan tutoring bertahap tidak pernah benar-benar mungkin. Pemilik
produk juga menegaskan Harvy **boleh** mengingat curhat, karena itu membantu.

**Yang diputuskan.** Ditulis lengkap di
[`ADR-006`](decisions/ADR-006-memori-dan-riwayat-percakapan.md). Empat yang
paling menentukan:

1. Memori dan riwayat adalah **dua barang terpisah**, bukan satu. Menggabungkan
   keduanya menghasilkan transkrip mentah yang disebut memori — prompt
   membengkak, dan pengguna tidak dapat menghapus "satu hal" karena tidak ada
   satu hal yang dapat ditunjuk.
2. Memori biasa disimpan otomatis tetapi selalu diumumkan; memori sensitif
   hanya dengan izin. Konstitusi tidak melarang Harvy mengingat curhat — yang
   dilarang Pasal 4 nomor 3 adalah menyimpannya diam-diam. Keinginan pemilik
   produk dan Konstitusi ternyata tidak bertabrakan, asal bentuknya benar.
3. Riwayat disimpan ke disk (pilihan pemilik produk; usulan saya di memori
   proses ditolak), lalu diringkas dan dibuang setelah 16 giliran.
4. Pemilihan memori untuk prompt dilakukan deterministik di `core/`, bukan
   dengan panggilan model kedua.

**Yang berubah.** Baru: `src/domain/memory.ts`, `src/domain/history.ts`,
`src/core/memory-policy.ts`, `src/core/memory-service.ts`,
`src/core/history-policy.ts`, `src/core/history-service.ts`,
`src/storage/file-memory-repository.ts`, `src/storage/file-history-repository.ts`,
`src/ai/context.ts`, dan tiga berkas tes.

Yang disambungkan: `understand.ts` membaca usulan memori, `persona.ts` menyusun
bagian `<konteks>` dan prompt peringkas, `conversation.ts` membawa konteks ke
**dua** langkah sekaligus menambah `summarize`, `create-bot.ts` menyimpan,
menawarkan, mendaftar, dan melupakan, `model-policy.ts` mengenal intent
`memory`, `config.ts` dan `app.ts` merangkai semuanya.

`persona.ts` juga berhenti mewajibkan Harvy mengaku tanpa ingatan. Baris itu
ditambahkan 26 Juli pagi justru karena Harvy pernah berbohong ke arah
sebaliknya; membiarkannya berarti mengubah kejujuran kemarin menjadi kebohongan
baru hari ini.

**Dibahas.** Dua hal yang tidak terlihat dari daftar berkas.

Pertama, **memori adalah masukan tidak tepercaya yang diputar ulang.** Invarian
repositori ini sudah melindungi pesan pengguna dengan `<pesan>`, tetapi memori
bocor lewat pintu lain: kalimat yang ditulis hari ini masuk kembali ke prompt
besok, kali ini dari sisi sistem. Karena itu konteks dibungkus `<konteks>`
berikut penegasan bahwa isinya catatan, bukan perintah — dan ada tes yang
menjaganya.

Kedua, **kendali harus lahir bersamaan dengan fiturnya.** Memori tanpa tombol
Lupakan melanggar Pasal 4 nomor 4 sejak hari pertama, jadi daftar memori,
lupakan satu, dan lupakan semua ikut dalam perubahan yang sama, bukan
dijadwalkan menyusul.

Satu tes sempat gagal dan itu berguna: saya mengira riwayat akan tersisa enam
giliran setelah dua puluh pesan, padahal jawabannya sembilan — pemadatan
berjalan di ambang lalu riwayat terisi lagi. Yang salah ekspektasi tesnya, bukan
kodenya, jadi tesnya diubah untuk menguji maksudnya: riwayat tidak pernah tumbuh
tanpa batas, dan teks yang sudah diringkas benar-benar hilang.

**Bukti.** `npm run check` PASS. `rm -rf dist && npm test` PASS — **63 test
dalam 11 suite**, naik dari 36 dalam 7.

Yang **tidak** diuji, dan ini bagian terpentingnya: **seluruh fitur ini belum
pernah dijalankan sekali pun dengan kunci sungguhan.** Yang hijau hanya bagian
murni — kebijakan memori, pemadatan riwayat, pembacaan usulan model, dan
pembungkusan konteks. Bahwa Harvy benar-benar mengingat nama penggunanya,
benar-benar bertanya sebelum menyimpan hal sensitif, dan benar-benar memahami
"yang tadi itu" belum dibuktikan apa pun. `docs/engineering/TESTING.md` kini
memuat sepuluh langkah uji manual untuk itu, seluruhnya masih `NOT RUN`.

**Sengaja ditinggalkan.**

- Pengingat yang dikirim worker tidak ikut tercatat ke riwayat, sehingga Harvy
  tidak tahu ia baru saja menegur penggunanya. `reminder-worker.ts` tidak
  mengenal `HistoryService`, dan menyambungkannya di luar permintaan.
- Satu langkah tertunda per pengguna berarti tawaran tugas dan tawaran memori
  sensitif tidak dapat hidup bersamaan; tawaran tugas menang, memorinya
  dilewatkan. Sengaja, supaya pengguna tidak dihadapkan dua pertanyaan sekaligus.
- Menyunting memori belum ada; Pasal 4 nomor 4 menyebut "mengubah", dan yang
  tersedia baru melihat dan menghapus. Dicatat sebagai Later di `PROJECT.md`.
- Persetujuan privasi pihak ketiga masih belum ada, dan kini lebih mendesak:
  yang dikirim ke penyedia model bukan lagi hanya pesan hari ini.
- Tabel `STATUS.md` menandai memori dan riwayat "Ada, belum teruji manual" —
  bentuk yang sengaja dipisahkan dari "Ada, terbukti".

## 26 Juli 2026 — Dokumen usang dibuang; alat diagnostik disambungkan

**Kenapa.** Sesi ini dimulai dari `/init` Claude Code, yang meminta CLAUDE.md
dibuat atau diperbaiki. CLAUDE.md tidak diubah: `ADR-001` nomor 6 masih berlaku,
dan menyalin arsitektur ke sana justru menghidupkan alternatif yang ADR itu tolak
— tiga berkas instruksi yang cepat basi. Yang dikerjakan adalah hasil
sampingannya: pemeriksaan AGENTS.md terhadap kode menemukan tiga percanggahan.
Setelah ketiganya diperbaiki, dua kekurangan `AGENTS.md` dan celah gerbang statis
yang semula hanya dilaporkan ikut diminta untuk dikerjakan.

**Yang berubah.**

- `docs/engineering/ARCHITECTURE.md` **dihapus.** Berkas ini belum pernah masuk
  Git dan tidak terdaftar di `docs/INDEX.md`, tetapi isinya menggambarkan Harvy
  sebelum `ADR-004`: pesan bebas katanya dijawab dengan arahan ke `/bantuan`
  "karena v0.1 sengaja tanpa model AI", pengguna disebut mengetik ID pada
  `/selesai` dan `/ingatkan`, `core/` disebut berisi parser masukan, tabel
  konfigurasinya tanpa satu pun `AI_*`, dan pekerjaan masih dibatasi Work Order
  yang sudah dicabut `ADR-005`. Sebuah dokumen arsitektur yang salah lebih
  berbahaya daripada tidak ada, karena ia dibaca lebih dulu daripada kode.
- `docs/engineering/TESTING.md`: baseline diperbarui dari 33 menjadi **36 test
  dalam 7 suite**. Langkah 33 tetap ditulis sebagai riwayat, bukan ditimpa.
- `scripts/coba-pemahaman.ts`: `maxTokens` tidak lagi ditulis sendiri, melainkan
  diimpor dari `src/ai/conversation.ts`.
- `src/ai/conversation.ts`: `UNDERSTANDING_MAX_TOKENS` diekspor agar impor itu
  mungkin.
- `tsconfig.json`: `noUnusedLocals` diaktifkan, dan `include` diperluas ke
  `scripts/`. Sebelumnya seluruh `scripts/` tidak pernah tersentuh
  `npm run check` sama sekali — itulah sebabnya `maxTokens: 400` dapat
  tertinggal tanpa ketahuan gerbang mana pun.
- `AGENTS.md`: menyebut `.githooks/pre-commit` beserta langkah
  `git config core.hooksPath .githooks` pada bagian Kontrak, memasukkan
  `scripts/coba-pemahaman.ts` ke daftar perintah pengembangan, dan memperbarui
  invarian `tsconfig.json`.
- `docs/engineering/STATUS.md`: paragraf pola cacat diperbarui — cacat keempat
  yang dikhawatirkan ternyata benar-benar terjadi, dan batas gerbang barunya
  ditulis apa adanya.

**Dibahas.** Temuan yang paling perlu diingat adalah skrip diagnostiknya sendiri.
`scripts/coba-pemahaman.ts` ditulis pada sesi sebelumnya untuk mendiagnosis
balasan terpotong, dan perbaikannya menaikkan batas token di `conversation.ts`
dari 400 ke 2048 — tetapi skripnya tetap tertinggal di 400. Alat pemeriksanya
mereproduksi persis cacat yang ia dibuat untuk mencari, sehingga kalimat yang
sebenarnya dipahami Harvy akan dilaporkan "GAGAL DIBACA" dan mengirim sesi
berikutnya memburu cacat yang sudah tidak ada. Karena itu angkanya kini diimpor,
bukan disalin: penyimpangan yang sama tidak dapat terjadi dua kali.

Ini juga contoh keempat dari pola yang dicatat `STATUS.md` — kode ditulis lengkap
lalu tidak disambungkan — dan pola itu lolos gerbang statis lagi, kali ini dengan
alasan tambahan: `tsconfig.json` hanya menyertakan `src/` dan `tests/`, sehingga
`scripts/` tidak pernah tersentuh `npm run check` sama sekali.

Gerbangnya kini diperketat, tetapi jangan disimpulkan berlebihan. `noUnusedLocals`
hanya menangkap impor dan nilai lokal yang menganggur; **angka yang salah tetapi
dipakai tidak terlihat olehnya** — dan cacat keempat itu justru berbentuk
demikian. Yang benar-benar mencegahnya berulang adalah satu sumber nilai, bukan
flag kompiler. Memperluas `include` ke `scripts/` juga bukan pilihan yang netral:
konsekuensinya `scripts/` ikut dibangun ke `dist/scripts/`. Itu aman selama glob
tes tetap `dist/tests/*.test.js`, dan sudah diperiksa bahwa jumlah test tidak
berubah setelah perluasan itu.

**Bukti.** `npm run check` PASS. `rm -rf dist && npm test` PASS — 36 test dalam 7
suite, angka yang sama sebelum dan sesudah perubahan, termasuk sesudah `scripts/`
masuk ke `include`. `noUnusedLocals` tidak menemukan satu pun pelanggaran di kode
yang ada, jadi mengaktifkannya tidak menuntut perubahan lain.

`scripts/coba-pemahaman.ts` sempat diperiksa terpisah dengan `npx tsc --noEmit
--ignoreConfig --module NodeNext --moduleResolution NodeNext --target ES2023
--strict --types node scripts/coba-pemahaman.ts` — PASS. Perintah itu kini tidak
diperlukan lagi: `npm run check` sudah menjangkaunya.

Yang **tidak** diuji: skrip itu tidak dijalankan terhadap model sungguhan, jadi
yang terbukti baru bahwa ia mengompilasi dan memakai angka yang benar — bukan
bahwa keluarannya untuk kalimat panjang sudah berubah. Percakapan, tombol, dan
pengingat tidak tersentuh sesi ini.

**Sengaja ditinggalkan.** Baris "Basis" pada `STATUS.md` masih menyebut commit
`9971ac2` ditambah perubahan yang belum di-commit, padahal perubahan itu sudah
masuk lewat `91ec013`. Tidak diperbarui karena memperbarui baris itu berarti
mengklaim seluruh tabel kemampuan sudah diverifikasi ulang hari ini, dan yang
benar-benar diperiksa sesi ini hanya bagian arsitektur dan perintah — bukan
seluruh tabelnya. Biarkan sesi yang benar-benar memverifikasi yang mengubahnya.

`noUnusedParameters` tidak ikut diaktifkan; hanya `noUnusedLocals` yang memang
disebut sebagai celah di `STATUS.md`. Riwayat percakapan, tombol adaptif, dan
pengingat yang terkirim worker tetap belum tersentuh — tidak ada yang bergeser
pada tabel kemampuan, jadi tabel itu tidak diubah.

## 26 Juli 2026 — Tugas pertama tercatat; Harvy menyangkal ingatannya

**Kenapa.** Kegagalan pengingat pada dua percobaan sebelumnya akhirnya
terdiagnosis lewat `scripts/coba-pemahaman.ts`, yang menampilkan balasan mentah
model. Balasannya terpotong di tengah:
`{ "intent": "task", "safetySensitive": false` — bukan salah format, melainkan
kehabisan token.

**Yang berubah.**

- `src/ai/conversation.ts`: batas token pemahaman 400 → 2048, balasan 600 →
  1536. `gemini-3.6-flash` adalah model penalaran yang memakai token keluaran
  untuk berpikir, sehingga batas sempit menghabiskan jatah sebelum JSON ditutup.
  Alasannya ditulis panjang di kode, lengkap dengan balasan yang terpotong itu,
  supaya angka ini tidak diturunkan lagi demi penghematan semu.
- `src/ai/client.ts`: `finish_reason=length` dicatat ke log dan diberi pesan
  galat tersendiri. Tanpa itu, balasan terpotong tidak dapat dibedakan dari
  balasan rusak — dan perbedaan itu menghabiskan dua putaran perbaikan.
- `src/ai/persona.ts`: Harvy wajib mengaku belum punya ingatan percakapan.
- `scripts/coba-pemahaman.ts` (baru): menguji pemahaman satu kalimat langsung ke
  model tanpa lewat Telegram, dan menampilkan balasan mentahnya.
- `tests/conversation.test.ts`: penjaga agar jatah token pemahaman tidak
  disempitkan lagi di bawah 1024.

**Dibahas.** Cacat token ini punya bentuk yang perlu diingat: **ia hanya
menyerang pesan yang paling penting.** Sapaan lolos karena hampir tidak butuh
penalaran; kalimat berisi waktu dan pekerjaan gagal. Pengujian dengan sapaan
saja akan menyimpulkan Harvy sehat sempurna.

Temuan kedua lebih berat. Ditanya "aku tanya apa tadi", Harvy menjawab "ini
pesan pertama kamu di obrolan kita". Itu bukan sekadar riwayat percakapan yang
belum ada — itu Harvy menyatakan sesuatu yang tidak benar tentang pengalaman
penggunanya, dan melanggar Pasal 3.6 serta Pasal 5 nomor 6. Perbaikan promptnya
murah; yang mahal adalah menyadari bahwa fitur yang belum ada dapat berubah
menjadi ketidakjujuran kalau modelnya dibiarkan menutupi kekosongan itu.

**Bukti.** `npm run check` PASS. `rm -rf dist && npm test` PASS — 36 test dalam
7 suite. Percakapan nyata: tugas pertama tercatat berikut pengingatnya, **tombol
Selesai benar-benar bekerja** — sekaligus membuktikan perbaikan `allowed_updates`
— dan tutoring satu giliran menuntun alih-alih menjawab langsung.

**Sengaja ditinggalkan.** Riwayat percakapan tetap belum ada; yang diperbaiki
baru kejujurannya. Pengingat yang benar-benar terkirim worker pada waktunya juga
belum pernah teramati. Satu hal perlu diperiksa ulang: konfirmasi tombol Selesai
muncul tanpa judul tugas pada transkrip, padahal kode menyusunnya dengan judul.

---

## 26 Juli 2026 — Harvy berjalan pertama kali, dan gagal pada pesan ketiga

**Kenapa.** Pemilik produk menjalankan bot dengan token dan kunci sungguhan.
Sapaan dan obrolan ringan berhasil; permintaan pengingat dijawab "Aku belum
menangkap maksudnya".

**Yang berubah.**

- `src/ai/conversation.ts`: balasan model yang gagal dibaca kini dicatat ke log,
  dipotong 300 karakter. Sebelumnya kegagalan sama sekali tidak berjejak,
  sehingga penyebabnya hanya bisa ditebak.
- `src/ai/understand.ts`: `readIntent` menerima label yang huruf besar-kecilnya
  berbeda, dan **menyelamatkan pesan ketika label dikarang** — misalnya
  `"reminder"` — selama data tugasnya sah. Tanpa data tugas, Harvy tetap mengaku
  tidak paham daripada menebak.
- `src/ai/persona.ts`: prompt menegaskan `intent` wajib salah satu dari empat
  nilai, menyebut permintaan pengingat sebagai `task`, dan memberi contoh
  pembacaan waktu "pukul 11 lewat 21" serta "setengah 8".
- `src/bot/messages.ts`: `understandingNote` tidak lagi menanyakan tenggat pada
  tugas yang lahir dari permintaan pengingat. Pengguna sudah menyebut waktunya.
- `tests/understand.test.ts`: dua tes untuk label yang dikarang dan yang berbeda
  huruf.

**Dibahas.** Penyebab kegagalan **belum dipastikan**, hanya dipersempit ke dua
kemungkinan: balasan model bukan JSON yang sah, atau `intent` di luar empat
nilai yang dikenal. Perbaikan hari ini menutup kemungkinan kedua dan membuat
kemungkinan pertama terlihat di log. Kalau kegagalan berulang, log akan menyebut
penyebabnya tanpa perlu menebak lagi.

**Bukti.** `npm run check` PASS. `rm -rf dist && npm test` PASS — 35 test dalam
7 suite. Percakapan nyata membuktikan sapaan, perkenalan diri, dan obrolan
ringan berjalan. Permintaan pengingat **belum diuji ulang** setelah perbaikan.
Tombol, pencatatan tugas, dan pengingat terkirim masih belum pernah terjadi
sekali pun.

**Sengaja ditinggalkan.** Kata "tunggubisa" yang tersambung tanpa spasi tidak
ditangani khusus; prompt sudah meminta model memperbaiki salah ketik yang jelas.

---

## 26 Juli 2026 — Kontrak konteks dibuat mengikat

**Kenapa.** Kewajiban membaca konteks dan menulis `LOG.md` sudah tertulis, tetapi
hanya berupa harapan. Agent melewati instruksi, dan manusia lupa. Sepanjang hari
ini terbukti berkali-kali bahwa dokumen yang tidak dipaksa dibaca memang tidak
dibaca.

**Yang berubah.**

- `AGENTS.md`: bagian **Kontrak** dipasang paling atas — baca konteks, jangan
  mengklaim yang belum diperiksa, tulis entri `LOG.md`. Disertai alasan
  konkretnya, yaitu kekeliruan tiga berkas yang tidak pernah ada.
- `docs/LOG.md`: format entri diperjelas dan bagian **Dibahas** ditambahkan,
  supaya sesi yang hanya berdiskusi tetap meninggalkan jejak.
- `.githooks/pre-commit` (baru): menolak commit yang menyentuh `src/`, `tests/`,
  `docs/`, `AGENTS.md`, atau `README.md` tanpa perubahan pada `docs/LOG.md`.
  Berlaku untuk siapa pun yang melakukan commit, alat apa pun.
- `scripts/session-context.sh` dan `.claude/settings.json` (baru): hook
  `SessionStart` menyuntikkan kontrak, entri LOG terakhir, dan daftar cacat yang
  diketahui ke awal sesi Claude Code.
- `docs/operations/WORKFLOW.md` dan `README.md`: tiga lapis penegakan
  didokumentasikan beserta perintah pengaktifannya.

**Dibahas.** Work Order ditinggalkan bukan karena buruk, melainkan karena yang
kurang selama ini bukan proses melainkan konteks — lihat `ADR-005`. Kesimpulan
lain: instruksi tertulis adalah lapisan terlemah, dan satu-satunya penegakan yang
berlaku lintas alat adalah hook Git, karena hanya commit yang dilalui semua
penulis.

**Bukti.** `git config core.hooksPath .githooks` sudah diaktifkan pada clone ini.
Hook diuji dua arah: menolak (exit 1) ketika `docs/LOG.md` tidak ikut di-staging,
dan lolos (exit 0) setelah disertakan. `scripts/session-context.sh` dijalankan
dan keluarannya benar. `npm run check` PASS, `npm test` PASS (33 test, 7 suite).

**Sengaja ditinggalkan.** Hook `SessionStart` hanya mengikat Claude Code; Codex
dan Antigravity tetap bergantung pada `AGENTS.md` dan hook Git. `--no-verify`
juga tetap dibiarkan bisa dipakai — yang dijaga adalah kelupaan, bukan niat.

---

## 26 Juli 2026 — Tiga cacat sambungan diperbaiki

**Kenapa.** Ketiganya punya pola yang sama: kode ditulis lengkap, lalu tidak
pernah dipanggil. Gerbang statis meloloskannya karena `noUnusedLocals` tidak
aktif.

**Yang berubah.**

- `src/ai/conversation.ts`: `understandingInput()` akhirnya dipakai, sehingga
  pesan pengguna dibungkus tag `<pesan>` dan tidak lagi dikirim mentah ke model.
  Permintaan pemahaman juga menyalakan `json: true`, memakai jalur mundur yang
  sudah ada di `AiClient` bila penyedia menolaknya.
- `src/domain/task.ts` dan `src/core/task-service.ts`: `NewTask` menerima
  `remindAt`, dan `create` memasangnya sebagai `reminderAt`. Pengingat yang
  waktunya sudah lewat **diabaikan** — kalau dipasang, Harvy akan menegur pada
  detik yang sama dengan pencatatan, dan itu salah baca model, bukan permintaan
  pengguna.
- `src/bot/create-bot.ts`: `saveTask` meneruskan `remindAt` hasil ekstraksi.
  Akibatnya "ingetin aku jam 8" kini benar-benar memasang pengingat, dan
  `formatTask` menampilkannya sebagai 🔔 tanpa perubahan lain.
- `tests/conversation.test.ts` (baru): menjaga agar pembungkus anti-injeksi dan
  mode JSON tidak lepas lagi, memakai klien palsu tanpa menyentuh jaringan.
- `tests/task-service.test.ts`: dua tes pengingat, termasuk yang waktunya sudah
  lewat.

**Bukti.** `npm run check` PASS. `rm -rf dist && npm test` PASS — naik dari 29
test / 6 suite menjadi **33 test / 7 suite**. Tetap tidak ada uji manual: bot
belum pernah dijalankan dengan token dan kunci sungguhan, jadi perilaku
sesungguhnya di Telegram masih belum terbukti.

**Sengaja ditinggalkan.** Urutan pemeriksaan keselamatan masih terbalik dari
alur di `ADR-003`. `noUnusedLocals` juga tetap dibiarkan mati, sehingga cacat
keempat yang berpola sama masih akan lolos gerbang statis.

---

## 26 Juli 2026 — Dokumentasi diluruskan dan konteks dibenahi

**Kenapa.** Beberapa dokumen keliru karena ditulis dari dugaan, bukan dari kode.
Kekeliruan itu saling menguatkan dan membuat sesi berikutnya sulit berpijak.

**Yang berubah.**

- `src/app.ts`: `allowed_updates` menambahkan `callback_query`. Sebelumnya
  Telegram tidak pernah mengirim update tombol, sehingga **seluruh tombol inline
  mati** — padahal tombol adalah antarmuka utama Harvy.
- `ADR-002` dan `ADR-004`: nama modul yang tidak pernah ada dalam riwayat Git
  (`intent.ts`, `natural-language.ts`, `time.ts`) diganti menjadi
  `src/core/input-parser.ts`, disertai catatan koreksi bertanggal.
- `AGENTS.md`: invarian chat non-pribadi diperjelas; alur percakapan dua langkah,
  perilaku mode `testing`, `PendingStore`, dan batas gerbang otomatis
  ditambahkan; ditegaskan bahwa percakapan dan tombol adalah antarmuka utama,
  bukan perintah `/`.
- `README.md`: klaim usang "belum memakai model AI" dihapus.
- `docs/engineering/STATUS.md` (baru): tabel kemampuan yang sebenarnya, tiga
  cacat kode yang diketahui, dan penegasan bahwa Harvy belum pernah dijalankan
  dengan kunci sungguhan.
- `docs/PROJECT.md`: aturan ejaan "Harvy, bukan Harvey", audiens Gen Z dan Gen
  Alpha, sifat kapibara lengkap, posisi dan tujuh pembeda, sembilan masalah
  pengguna, sepuluh komponen sistem, isi website, dan arah monetisasi.
- `ADR-005` (baru), `docs/LOG.md` (baru), `docs/operations/WORKFLOW.md` (baru):
  Work Order dihentikan, digantikan konteks dan catatan pekerjaan.
  `docs/work-orders/` dan `docs/operations/ORCHESTRATION.md` dihapus.

**Bukti.** `npm run check` PASS. `npm test` PASS (29 test, 6 suite). Tidak ada
uji manual: bot belum pernah dijalankan dengan token dan kunci sungguhan,
sehingga perbaikan tombol **belum terbukti**, baru masuk akal secara kode.

**Sengaja ditinggalkan.** Tiga cacat di `STATUS.md` belum diperbaiki:
`understandingInput()` yang tidak dipanggil, `remindAt` yang dibuang, dan mode
JSON yang tidak dipakai. Pemeriksaan keselamatan juga masih terbalik urutannya
dari alur di `ADR-003`.

---

## 26 Juli 2026 — Seluruh percakapan dipindahkan ke model AI

**Kenapa.** Penguraian berbasis aturan tidak cukup untuk pendamping belajar yang
harus menjelaskan materi dan menanggapi keadaan pengguna. Lihat
[`ADR-004`](decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md).

**Yang berubah.** `src/core/input-parser.ts` dan tesnya dihapus. Lapisan
`src/ai/` dibuat: `persona.ts`, `model-policy.ts`, `understand.ts`, `client.ts`,
`key-pool.ts`, `conversation.ts`. `src/bot/pending.ts` menyimpan satu langkah
percakapan. `ADR-002` menjadi superseded sebagian; `ADR-003` menetapkan tiga
tingkatan model dan dua penyedia.

**Bukti.** Tes naik dari 10 test / 4 suite menjadi 29 test / 6 suite.

**Sengaja ditinggalkan.** Riwayat percakapan, pemeriksaan keselamatan sebagai
lapisan tersendiri, pemeriksaan respons, pemberitahuan privasi, dan batas biaya.

**Perlu diketahui.** Seluruh pekerjaan ini **belum di-commit** dan masih berada
di working tree pada branch `main`.

---

## 25 Juli 2026 — Bootstrap orkestrasi

**Kenapa.** Tiga coding agent bekerja pada repositori yang sama tanpa sumber
konteks bersama. Lihat [`ADR-001`](decisions/ADR-001-agent-orchestration.md).

**Yang berubah.** `AGENTS.md` sebagai instruksi inti, adaptor tipis untuk Claude
Code dan Antigravity, peta dokumentasi `docs/INDEX.md`, protokol kerja, gerbang
pengujian, serta snapshot awal ke repositori privat `stafbotz/harvy`.

**Bukti.** `npm run check` PASS, `npm test` PASS (10 test, 4 suite). Diterima
pengguna pada commit `af6ad73`.

**Catatan kemudian.** Protokol Work Order yang lahir di sini dihentikan pada
26 Juli 2026 lewat `ADR-005`. Yang tetap dipakai: satu penulis aktif, tidak
menulis langsung ke `main`, dan bukti tes wajib.
