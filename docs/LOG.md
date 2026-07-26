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
