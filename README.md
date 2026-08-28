<div align="center">

# Harvy

### Pendamping AI berbahasa Indonesia untuk pelajar

Mengubah obrolan sehari-hari menjadi tugas, pengingat, dan langkah kecil yang
bisa dilakukan — dengan kapibara sebagai teman ngobrol.

</div>

> **Status: beta lokal.** Harvy sudah memiliki chat pribadi Telegram dan fondasi
> grup WhatsApp, tetapi penyimpanan masih berbasis berkas satu proses dan belum
> siap untuk deployment produksi.

## Peta isi

- [Ringkasan](#ringkasan)
- [Cara menggunakan](#cara-menggunakan)
- [Mulai cepat](#mulai-cepat)
- [Kemampuan inti](#kemampuan-inti)
- [WhatsApp grup](#whatsapp-grup)
- [Harvy Console](#harvy-console)
- [Privasi dan batas safety](#privasi-dan-batas-safety)
- [Operasional dan pengujian](#operasional-dan-pengujian)
- [Batas versi beta](#batas-versi-beta)
- [Dokumentasi](#dokumentasi)
- [Pengembangan](#pengembangan)

## Ringkasan

Harvy adalah pendamping AI untuk pelajar Indonesia. Kamu dapat menulis seperti
sedang mengobrol biasa; Harvy memahami konteks, membantu menentukan langkah
berikutnya, dan tidak memaksa setiap pesan menjadi tugas.

| Area | Kondisi saat ini |
|---|---|
| Chat pribadi | Telegram, aktif |
| Chat grup | WhatsApp, beta dan opt-in |
| Telegram grup | Belum tersedia |
| WhatsApp pribadi | Beta lokal, opt-in dan default-off |
| Runtime | Node.js 22.16.0 atau lebih baru |
| Bahasa utama | Bahasa Indonesia sehari-hari, dengan dukungan code-mix terbatas |
| Penyimpanan | Berkas lokal, satu proses |
| Model AI | Lapisan multi-model Harvy yang diperkenalkan sebagai **Capybara** |

Capybara adalah nama sistem multi-model milik Harvy, bukan klaim bahwa seluruh
sistem memakai satu foundation model atau satu penyedia tertentu.

### Alur singkat

~~~text
Pesan pengguna
      │
      ▼
Adapter Telegram / WhatsApp
      │
      ▼
Harvy Core ── memahami konteks ── memilih respons atau aksi
      │
      ├── tugas, sesi, memori, dan pengingat
      └── balasan dengan kontrol yang bisa dipilih pengguna
~~~

## Cara menggunakan

Tidak ada format khusus dan tidak ada ID yang perlu dihafal:

~~~text
besok jam 7 malam kumpulin matematika halaman 20
senin ada ulangan biologi, penting banget
30 agustus daftar lomba
bawa buku sejarah
~~~

Harvy dapat membalas dengan tugas yang sudah dirapikan beserta tombol **Selesai**,
**Ingatkan**, **Ubah tenggat**, dan **Batalkan**.

| Jika kamu... | Harvy akan... |
|---|---|
| Menyebut tenggat atau pengingat | Membantu mencatatnya dengan tanggal dan waktu yang dipahami |
| Menulis keluhan atau cerita | Menanggapi keadaanmu lebih dulu, lalu menawarkan langkah yang relevan |
| Meminta dibuatkan sesuatu di chat | Mengerjakannya, bukan memasukkannya ke daftar tugas |
| Bertanya tentang pelajaran | Menuntun proses berpikir, bukan langsung memberi jawaban akhir |
| Tidak sengaja mengirim beberapa bubble cepat | Menunggu dan membacanya sebagai satu giliran |
| Tidak memahami pesan | Mengatakannya dengan jelas dan meminta konteks yang diperlukan |

Di chat pribadi, hanya ada tiga perintah dan semuanya opsional:

~~~text
/start     mulai atau lihat sapaan
/tugas     lihat yang harus dikerjakan
/bantuan   lihat cara pakai
~~~

### Bahasa waktu dan prioritas

| Contoh yang kamu tulis | Yang dipahami |
|---|---|
| <code>besok</code>, <code>lusa</code>, <code>hari ini</code> | Tanggal relatif |
| <code>senin</code>, <code>jumat depan</code>, <code>minggu depan</code> | Hari berikutnya |
| <code>30 agustus</code>, <code>28/7</code>, <code>2026-07-28</code> | Tanggal pasti |
| <code>jam 7 malam</code>, <code>19.30</code>, <code>sore</code> | Waktu |
| <code>ingetin aku jam 8</code> | Permintaan pengingat |
| <code>penting banget</code>, <code>santai</code>, <code>nggak penting</code> | Tingkat kepentingan |

Tanggal tanpa jam dianggap berlaku sampai akhir hari itu. Pengingat dan check-in
mengikuti zona waktu pengguna, jam tenang, serta waktu pilihan pengguna sendiri.

## Mulai cepat

### Prasyarat

- Node.js **22.16.0 atau lebih baru**
- Token bot Telegram dari [@BotFather](https://t.me/BotFather)
- Kunci dan ID model AI dari provider yang dipilih

### 1. Pasang dependensi

~~~bash
npm ci
cp .env.example .env
~~~

PowerShell:

~~~powershell
npm ci
Copy-Item .env.example .env
~~~

### 2. Isi konfigurasi minimal

Mode testing adalah titik awal yang paling sederhana:

~~~dotenv
AI_MODE=testing
GOOGLE_AI_STUDIO_API_KEYS=isi_kunci_di_sini
AI_MODEL_TESTING=isi_id_model_di_sini
DEFAULT_TIMEZONE=Asia/Jakarta
~~~

Gunakan ID model persis seperti yang tercantum di dashboard provider.

| Mode | Konfigurasi utama | Keterangan |
|---|---|---|
| <code>testing</code> | <code>GOOGLE_AI_STUDIO_API_KEYS</code>, <code>AI_MODEL_TESTING</code> | Satu model default lewat Google AI Studio; fallback OpenAI-compatible opsional |
| <code>production</code> | <code>OPENROUTER_API_KEY</code>, <code>AI_MODEL_CHEAP</code>, <code>AI_MODEL_EFFICIENT</code>, <code>AI_MODEL_AMBITIOUS</code> | Tiga slot tier kompatibel; binding role ke exact model bersifat opsional |

Daftar lengkap variabel, default, retensi, harga, dan lokasi berkas ada di
[<code>.env.example</code>](.env.example). Jangan commit <code>.env</code>,
token, atau folder autentikasi WhatsApp.

### 3. Atur bot Telegram utama

Token BotFather tidak lagi diletakkan di <code>.env</code>. Buka Console setup:

~~~bash
npm run console:setup
~~~

Di bagian **Harvy utama**, masukkan token bot Telegram utama. Console
memverifikasinya langsung ke Telegram lalu menyimpan ciphertext dan kunci lokal
di <code>secrets/</code>; nilainya tidak dapat dibaca kembali dari browser. Jika
instalasi lama masih memiliki <code>TELEGRAM_BOT_TOKEN</code> di
<code>.env</code>, gunakan aksi migrasi yang tampil agar Console menyimpan secret
lebih dulu lalu menghapus baris legacy tersebut.

### 4. Jalankan Harvy

~~~bash
npm run dev
~~~

Untuk menjalankan hasil build:

~~~bash
npm run build
npm start
~~~

<code>npm run dev</code> memuat ulang aplikasi ketika <code>src/</code>,
<code>.env</code>, <code>package.json</code>, atau <code>tsconfig.json</code>
berubah. Tekan <code>Ctrl+C</code> untuk shutdown normal.

## Kemampuan inti

### Tugas, sesi, dan dukungan kontekstual

Harvy tidak mengubah setiap pesan menjadi tugas. Dalam satu percakapan, Harvy
dapat menawarkan hingga tiga tindakan yang paling sesuai dengan keadaan:

- menjernihkan cerita;
- memilih prioritas;
- memulai satu langkah kecil;
- tutoring;
- menyusun rencana;
- mendengarkan dulu; atau
- membantu membuat draf pesan untuk meminta bantuan manusia.

Satu proses dapat disimpan sebagai sesi aktif dan dilanjutkan setelah restart.
Check-in hanya dijadwalkan satu kali setelah pengguna memilih waktunya sendiri;
check-in yang diabaikan tidak memicu nudge berulang.

### Memori yang bisa dilihat dan dikendalikan

Harvy dapat mengingat kelas, cara belajar, kebiasaan, dan hal yang sedang
dihadapi agar pengguna tidak perlu mengulang konteks. Setiap penyimpanan
diumumkan dengan catatan <code>📎</code> dan tombol **Lupakan**.

| Kontrol | Fungsi |
|---|---|
| <code>apa yang kamu ingat tentang aku</code> | Melihat daftar memori |
| Menyunting satu memori | Mengoreksi konteks yang keliru |
| Menghapus satu memori | Melupakan catatan tertentu |
| Menghapus semua data | Menghapus tugas, riwayat, memori, sesi, profil, dan telemetry |
| Ekspor atau tarik persetujuan | Mengelola data yang dapat dilihat pengguna |

Untuk kesehatan, keluarga, relasi, gender, orientasi seksual, atau tekanan berat,
Harvy meminta persetujuan sebelum menyimpan. Penilaian AI dapat keliru; karena
itu setiap penyimpanan tetap diumumkan dan menyediakan kontrol **Lupakan**.

Beberapa giliran terakhir dipakai untuk memahami rujukan seperti “yang tadi
itu”. Percakapan lama dipadatkan menjadi episode terstruktur dengan rujukan
sequence sumber, lalu teks mentahnya dibuang sesuai retensi. Ringkasan model
tetap dapat salah dan bukan bukti bahwa maknanya pasti benar.

Harvy tidak melatih ulang bobot model secara tersembunyi dari chat produksi.
Perbaikan global harus dilakukan secara offline, berversi, dapat diuji, dan
memakai data sintetis atau data dengan opt-in.

### Ketika Harvy tidak yakin

Pesan tunggal yang sudah jelas diproses setelah pemeriksaan singkat. Beberapa
bubble lengkap diberi ruang sekitar 4 detik, pembuka cerita sekitar 7 detik,
dan kalimat yang menggantung sampai 12 detik sejak bubble terakhir. Model dapat
menandai giliran <code>urgent</code> untuk memotong jeda itu; pengenalan bahaya
tidak bergantung pada daftar kata lokal. Balasan tetap menjaga urutan terhadap
balasan yang sedang aktif.

## WhatsApp

Socket WhatsApp **mati secara bawaan**. Chat grup dan pribadi berbagi socket
Baileys, tetapi ingress pribadi mempunyai sakelar default-off tersendiri. Untuk
beta lokal grup saja, tambahkan konfigurasi berikut ke <code>.env</code>:

~~~dotenv
WHATSAPP_ENABLED=true
WHATSAPP_PRIVATE_ENABLED=false
WHATSAPP_PAIRING_MODE=qr
WHATSAPP_ACCOUNTS=[{"id":"utama","phoneNumber":"6281234567890"}]
~~~

Beberapa nomor dapat dijalankan sebagai socket dan namespace autentikasi yang
terisolasi:

~~~text
WHATSAPP_ACCOUNTS=[{"id":"utama","phoneNumber":"6281234567890"},{"id":"kelas","phoneNumber":"6281111111111"}]
~~~

<code>id</code> adalah alias operasional unik yang diawali huruf. Jangan
mengisinya dengan nomor telepon atau JID. Satu grup tetap terikat pada satu
account ID dan tidak dipindahkan otomatis ketika socket tersebut gagal atau
dibatasi.

### Perilaku pribadi

Ubah <code>WHATSAPP_PRIVATE_ENABLED=true</code> hanya bila chat pribadi memang
ingin dibuka. Saat nilainya <code>false</code> atau tidak diisi, pesan pribadi
dibuang sebelum handler dan Harvy tetap melayani grup. Saat aktif, pengguna
menulis seperti di chat pribadi Telegram; kontak pertama harus membalas
<code>SETUJU</code> sebelum teks diproses sebagai percakapan. Core conversation,
context memory, history, safety review, usage, dan funding memakai scope
WhatsApp terpisah. Perintah teks yang tersedia mencakup
<code>/penggunaan</code>, <code>/izin</code>, <code>/tarik-izin</code>, dan
<code>/memori</code>. <code>/hapus-data</code> menghapus seluruh data scope
WhatsApp setelah frasa konfirmasi exact. Ekspor file, edit memori, dan surface
yang bergantung pada tombol/callback Telegram belum seluruhnya tersedia; lihat
status WhatsApp untuk batas terverifikasi.

### Perilaku grup

- Harvy menjelaskan cara kerjanya sebelum memproses pesan grup.
- Riwayat sebelum Harvy hadir tidak diimpor.
- Tag atau reply selalu ditanggapi; percakapan ambient dinilai planner AI.
- Kandidat ambient yang tersusul menunggu grup hening lalu diperiksa ulang.
- Burst dari anggota yang sama dibatch sekitar 1,2 detik; panggilan direct memakai
  jeda 350 ms dan membatalkan planner ambient yang masih berjalan.
- Setiap bubble dihitung dan dideduplikasi sendiri.
- Memori grup tidak masuk ke chat pribadi atau grup lain.

QR hanya ditampilkan pada terminal interaktif lokal ketika
<code>APP_ENV</code> bukan <code>production</code>. Folder
<code>data/whatsapp-auth/</code> setara dengan kredensial sesi: jangan disalin,
di-log, atau dimasukkan ke Git. Mode <code>code</code> tersedia, tetapi bukan
default karena pairing-code Baileys masih memiliki kegagalan upstream pada
sebagian akun/server. Baileys bukan API resmi WhatsApp; nomor dapat terputus
atau dibatasi.

Detail corpus, hasil evaluator, dan batas bukti grup ada di
[docs/evidence/group-conversation-2026-07-30/](docs/evidence/group-conversation-2026-07-30/README.md).

<details>
<summary>Detail memori grup dan kontrol admin</summary>

Memori personal tetap terpisah per anggota dan per grup. Untuk usulan personal,
anggota yang sama harus membalas “ya, simpan memori ini” dalam 10 menit.
Catatan yang benar-benar dimiliki ruang dibuat lewat usulan eksplisit seperti
<code>ingat keputusan grup: ...</code>; Harvy menampilkan preview dan ID, lalu
admin harus mengonfirmasi ID yang sama dalam 10 menit.

Catatan bersama terlihat oleh semua anggota, berakhir setelah 60 hari, dan
maksimal empat catatan terbaru masuk ke konteks model sebagai data tidak tepercaya.
Konteks mentah berada paling lama 24 giliran atau 2 jam di RAM. Pesan dan
balasan sensitif atau berisiko tidak dimasukkan ke konteks itu. Metadata anggota
dibersihkan dalam jendela 30 hari, ID pesan untuk deduplikasi bertahan 24 jam,
dan daftar “paling aktif” hanya menggunakan 7 hari.

Anggota dapat meminta:

- <code>lihat memori grup</code>
- <code>ubah memori #ID jadi ...</code>
- <code>hapus memori #ID</code>
- koreksi nama tampilan
- <code>lupakan tentang aku</code>

Admin dapat meminta <code>hapus catatan grup #ID</code>, menambahkan julukan
Harvy, atau meminta <code>reset memori grup</code>. Penghapusan diri dan reset
grup memerlukan konfirmasi kedua dalam 10 menit. Reset admin hanya menghapus
profil sosial dan catatan bersama; memori semantik lokal anggota tetap berada
dalam kendalinya. Harvy dikeluarkan atau dinonaktifkan akan menghapus seluruh
scope grup.

</details>

## Harvy Console

Harvy Console adalah control plane operator lokal untuk mengelola cohort, paket
pilot, kuota, mode grup, undangan evaluasi, versi harga provider/model, usage,
biaya, dan audit. Console bukan website chat pengguna dan tidak menyimpan
prompt, balasan, atau transcript.

Aktifkan di <code>.env</code>:

~~~dotenv
HARVY_CONSOLE_ENABLED=true
HARVY_CONSOLE_HOST=127.0.0.1
HARVY_CONSOLE_PORT=3210
~~~

Saat development, token operator acak ditampilkan satu kali di terminal lokal.
Buka <code>http://127.0.0.1:3210</code>, lalu masukkan token tersebut. Pada
<code>APP_ENV=production</code>, gunakan <code>HARVY_CONSOLE_TOKEN</code>
dengan panjang minimal 32 karakter.

Console sengaja menolak bind non-loopback dan belum aman untuk domain, reverse
proxy publik, atau tunnel. Ia belum menerima pembayaran; semua paket dan harga
masih berstatus pilot. Detail ledger, backup, dan gerbang sebelum transisi VPS
ada di [runbook Harvy Console](docs/operations/HARVY_CONSOLE.md). Strategi
paket pilot ada di [dokumen beta dan paket](docs/product/PILOT_BETA_DAN_PAKET.md).

## Privasi dan batas safety

> Isi pesan, memori, dan ringkasan percakapan dapat dikirim ke satu atau lebih
> provider model pihak ketiga. Provider cadangan dapat menerima ulang permintaan
> yang gagal pada provider utama. Baca konfigurasi provider sebelum memakai data
> sensitif.

- Kontak pertama menjelaskan penggunaan provider dan meminta persetujuan.
  Persetujuan dapat ditarik dari dalam chat.
- Permintaan kompleks yang aman dapat dipecah menjadi dua atau tiga worker
  paralel. Worker hanya menerima submasalahnya; ia tidak menerima memori,
  riwayat, tool, credential, atau hak delegasi.
- Ekspor mencakup data yang dapat dilihat pengguna, tetapi mengecualikan catatan
  safety tersembunyi. Penghapusan penuh tetap menghapus catatan tersebut.
- Log operasional tidak menyimpan isi chat, prompt/balasan AI, identitas
  pengguna/grup, nomor, QR, token, atau credential.
- Memori dan episode hanya konteks kesinambungan yang tidak tepercaya. Keduanya
  bukan bukti izin, identitas, credential, waktu kini, jadwal live, atau
  keberhasilan tool.
- Harvy tidak menghubungi pengguna di luar pengingat atau check-in yang dipilih
  pengguna sendiri.

### Tool dan runtime yang tersedia

Harvy memakai satu capability catalog bertipe untuk chat privat dan grup.
Snapshot capability ikut dikirim ke prompt agar model tidak mengaku memiliki
tool yang tidak dipasang.

| Capability | Batas |
|---|---|
| <code>calendar.agenda</code> | Hanya tenggat, pengingat, dan check-in Harvy dalam jendela 1–31 hari; bukan Google Calendar atau Outlook |
| <code>terminal.run</code> | Scratchpad virtual kosong per action; tanpa process, network, environment, atau data Harvy |
| Clock runtime | Pertanyaan jam yang berdiri sendiri dijawab dari clock runtime |
| <code>web.search</code> dan <code>web.open</code> | Sudah dicabut dari runtime |

Pencarian web langsung, pembacaan file host/lampiran, X/Threads, kalender
eksternal, email, shell/program host, function calling ke aplikasi luar, dan
memori lintas kanal belum tersedia. Riwayat keputusan pencabutan executor web
ada di [ADR-015](docs/decisions/ADR-015-executor-web-baca-saja.md).

<details>
<summary>Batas teknis Agent Runtime</summary>

Pertanyaan tenang tanpa sesi aktif memakai root agent <code>cheap</code>.
Pekerjaan bertahap atau panjang dapat naik ke root <code>ambitious</code>, yang
boleh mendelegasikan 2–3 subpekerjaan read-only kepada worker
<code>cheap</code> atau <code>efficient</code>. Root menyatukan hasil worker
tanpa memberikan memori, riwayat, tool, credential, atau hak delegasi kepada
worker.

Setiap action aktif dibatasi 45 detik. Checkpoint
<code>waiting_input</code> privat Telegram disimpan setelah prompt terkirim dan
dapat dipulihkan setelah restart normal melalui adapter file satu proses.
Horizon jawab ulang checkpoint adalah 10 menit. Run aktif belum dipulihkan dan
Harvy belum mempunyai RunStore PostgreSQL, outbox, receipt, status
<code>unknown</code>, atau reconciler.

Fondasi Workspace sudah memiliki principal pseudonim, membership, role,
permission tertutup, dan <code>aclEpoch</code>, tetapi belum menjadi fitur
pengguna: belum ada ingress Workspace, UI membership, artifact store,
PostgreSQL, atau wiring Workspace pada aplikasi.

</details>

## Operasional dan pengujian

### Log operasional

Harvy menulis log terstruktur NDJSON ke <code>data/logs/</code> dan, bila
diaktifkan, record aman yang sama ke terminal. Log berisi waktu, komponen,
event, trace acak, durasi, status, kode error aman, frame stack, dan fingerprint.

Default log:

- rotasi pada 25 MiB atau pergantian hari UTC;
- total maksimum 250 MiB;
- segmen lokal dihapus setelah 14 hari;
- <code>LOG_LEVEL=debug</code> hanya untuk diagnosis;
- collector produksi sebaiknya memakai <code>APP_ENV=production</code> dan
  <code>LOG_CONSOLE_FORMAT=json</code>.

Kontrak lengkap dan keterbatasan logger ada di
[ADR-010](docs/decisions/ADR-010-log-operasional-produksi.md).

### Perintah verifikasi

~~~bash
npm run check
npm test
~~~

<code>npm test</code> membangun TypeScript lalu menjalankan test Node hasil build.
Evaluator tambahan yang tersedia:

~~~bash
npm run eval:conversation
npm run eval:routing
npm run eval:group
npm run eval:group:full
npm run eval:group:direct
~~~

## Batas versi beta

Harvy belum dapat diperlakukan sebagai layanan produksi. Batas paling penting:

| Area | Batas saat ini |
|---|---|
| Provider AI | Harus memiliki kunci API; tidak ada fallback berbasis aturan. Jika semua provider gagal, Harvy mengaku tidak bisa memproses |
| Kualitas pemahaman | Ringkasan dan pembacaan tenggat dibuat model dan dapat keliru; tugas selalu dapat dikoreksi lewat tombol |
| Bahasa | Fokus pada bahasa Indonesia sehari-hari; bahasa daerah dan code-mix berat belum tertangani |
| Safety memory | Salah klasifikasi serentak oleh dua pemeriksa AI masih mungkin terjadi |
| Telegram | Chat pribadi tersedia; grup Telegram belum |
| WhatsApp | Beta satu proses; Baileys bukan API resmi dan belum menjalani seluruh acceptance end-to-end nyata |
| Penyimpanan | Berkas lokal cocok untuk prototipe satu proses, bukan armada multi-proses atau produksi |
| Pengiriman | Pengingat dan check-in at-least-once dalam jendela sempit; crash setelah delivery sebelum status tersimpan dapat menyebabkan retry |
| Queue | Bubble dan aksi tombol dikuras saat shutdown normal dengan grace period 60 detik, tetapi antrean masih hanya di memori |
| Workspace dan run | Fondasi core sudah teruji otomatis, tetapi belum ada kanal Workspace atau run durable |
| Console | Localhost control plane untuk pilot; belum ada pembayaran, subscription lifecycle, OIDC/MFA/RBAC/TLS, atau internet-ready deployment |

<details>
<summary>Bukti pengujian yang belum lengkap</summary>

Memori, riwayat percakapan, sesi persisten, tutoring lima langkah, tombol
adaptif, check-in, kontrol data, dan telemetry telah memiliki tes otomatis atau
probe model. Sebagian alur memori dan riwayat pernah dicoba pada percakapan
nyata dan masih menemukan kegagalan; belum ada verifikasi ulang end-to-end di
Telegram untuk seluruh alur.

Satu nomor WhatsApp telah berhasil pairing QR, login, <code>open</code>, dan
membalas grup nyata. Notice, ritme ambient terbaru, revalidasi kandidat, seluruh
kontrol memori, removal, safety, shutdown baru, serta dua nomor nyata sekaligus
belum diuji end-to-end. Angka latency evaluator hanya mengukur request model
sintetis, bukan delivery WhatsApp nyata.

Rollback delivery sudah tersedia untuk record memori baru. Edit, delete, reset,
dan alias belum memiliki transaksi kompensasi generik jika acknowledgment gagal
setelah commit. GroupAgentRun dapat diaktifkan eksplisit pada composition lokal,
tetapi jalurnya baru lulus tes otomatis dan belum merupakan acceptance
GroupAgentRun di WhatsApp nyata.

</details>

## Dokumentasi

Mulai dari [peta konteks](docs/INDEX.md) untuk memilih dokumen yang tepat.

| Kebutuhan | Dokumen |
|---|---|
| Visi, kanal, backlog, dan keputusan produk | [docs/PROJECT.md](docs/PROJECT.md) |
| Prinsip moral, safety, dan batas data | [docs/CONSTITUTION.md](docs/CONSTITUTION.md) |
| Strategi tes dan bukti manual/otomatis | [docs/engineering/TESTING.md](docs/engineering/TESTING.md) |
| Cara kerja repo, hook, dan operasi Git | [docs/operations/WORKFLOW.md](docs/operations/WORKFLOW.md) |
| Console, ledger, backup, dan persiapan VPS | [docs/operations/HARVY_CONSOLE.md](docs/operations/HARVY_CONSOLE.md) |
| Strategi beta dan paket pilot | [docs/product/PILOT_BETA_DAN_PAKET.md](docs/product/PILOT_BETA_DAN_PAKET.md) |

## Pengembangan

Kontrak kerja untuk Codex, Claude Code, Antigravity, dan manusia ada di
[AGENTS.md](AGENTS.md). Baca kontrak itu sebelum mengubah kode, tes,
konfigurasi, atau dokumentasi.

Panduan itu memuat perintah, gerbang verifikasi, peta arsitektur, dan batas
keselamatan. Tidak ada hook repository atau validator kontrak; verifikasi
dilakukan lewat `npm run check`, `npm run test:file`, dan `npm test` sesuai
risiko perubahan.
