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
