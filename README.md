# Harvy

Fondasi MVP **Harvy**, satu produk AI bermaskot kapibara yang saat ini mempunyai
chat pribadi Telegram dan fondasi beta untuk grup WhatsApp melalui Baileys.
Seluruh percakapan dipahami oleh model AI, tanpa cadangan berbasis aturan,
sesuai
[ADR-004](docs/decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md). Mode uji
memakai satu model gratis, jadi tugas, prioritas, dan pengingat tetap dapat
dicoba tanpa biaya inferensi.

## Cara pakai

Tulis saja seperti mengobrol biasa. Tidak ada format yang perlu dihafal dan
tidak ada ID yang perlu diketik.

```text
besok jam 7 malam kumpulin matematika halaman 20
senin ada ulangan biologi, penting banget
30 agustus daftar lomba
bawa buku sejarah
```

Harvy membalas dengan tugas yang sudah dirapikan beserta tombol **Selesai**,
**Ingatkan**, **Ubah tenggat**, dan **Batalkan**.

Dalam percakapan lain, Harvy dapat menawarkan sampai tiga tindakan yang sesuai
keadaan: menjernihkan cerita, memilih prioritas, memulai satu langkah kecil,
tutoring, menyusun rencana, mendengarkan dulu, atau membantu membuat draf pesan
untuk meminta bantuan manusia. Satu proses dapat disimpan sebagai sesi aktif
dan dilanjutkan setelah restart. Check-in hanya dijadwalkan satu kali setelah
pengguna memilih waktu sendiri.

Hanya ada tiga perintah, dan semuanya opsional:

```text
/start     mulai atau lihat sapaan
/tugas     lihat yang harus dikerjakan
/bantuan   lihat cara pakai
```

### Yang dipahami Harvy

| Kamu tulis | Harvy mengerti |
|---|---|
| `besok`, `lusa`, `hari ini` | tanggal relatif |
| `senin`, `jumat depan`, `minggu depan` | hari berikutnya |
| `30 agustus`, `28/7`, `2026-07-28` | tanggal pasti |
| `jam 7 malam`, `19.30`, `sore` | waktu |
| `ingetin aku jam 8` | permintaan pengingat |
| `penting banget`, `santai`, `nggak penting` | tingkat kepentingan |

Tanggal tanpa jam dianggap berlaku sampai akhir hari itu.

### Yang Harvy ingat

Harvy mengingat beberapa hal supaya kamu tidak perlu mengulang dirimu:
kelasmu, cara belajar yang cocok, kebiasaan, dan apa yang sedang kamu hadapi.
Setiap kali ada yang disimpan, Harvy menambahkan catatan `📎` pada balasannya
berikut tombol **Lupakan**.

Untuk hal pribadi — kesehatan, keluarga, tekanan yang berat — yang dikenali AI
sebagai sensitif, Harvy bertanya dulu dan tidak menyimpan tanpa jawabanmu.
Penilaian AI dapat keliru; bila kedua pemeriksa sama-sama luput, catatan biasa
masih dapat tersimpan otomatis. Karena itu setiap penyimpanan selalu diumumkan
dan memberi tombol **Lupakan**.

Beberapa giliran terakhir juga diingat supaya "yang tadi itu" bisa dimengerti.
Percakapan lama dipadatkan menjadi episode terstruktur dengan rujukan ke
sequence sumber, lalu teks mentah sumbernya dibuang. Episode lama tidak
diringkas ulang dan riwayat tetap mempunyai batas retensi. Rujukan/hash ini
menjaga cakupan saat commit, bukan bukti bahwa makna ringkasan pasti benar
setelah teks sumbernya sudah dibuang.

Tanya "apa yang kamu ingat tentang aku" kapan saja untuk melihat daftarnya,
menyunting atau menghapus satu, atau menghapus semuanya sekaligus. Dari kontrol
data, pengguna juga dapat mengekspor data, menarik persetujuan, atau menghapus
seluruh data.

Untuk Agent Runtime, memori dan episode hanya dipakai sebagai konteks
kesinambungan yang tidak tepercaya—bukan bukti izin, identitas, credential,
jam, jadwal live, atau keberhasilan tool. Sub-agent tidak menerima memori.
Harvy tidak melatih ulang bobot model secara tersembunyi dari chat produksi;
perbaikan global harus offline, berversi, dapat diuji, dan memakai data
sintetis atau opt-in.

### Harvy di grup WhatsApp

Mode grup adalah jalur terpisah dari chat pribadi. Harvy mengumumkan cara
kerjanya sebelum memproses pesan grup, tidak mengimpor riwayat sebelum
kehadirannya, mempertahankan siapa yang berbicara, selalu menanggapi tag atau
reply, dan memakai planner AI untuk memilih apakah percakapan ambient memang
layak disela. Harvy dapat nimbrung tanpa namanya dipanggil ketika ada pertanyaan
belum terjawab, konteks baru yang berguna, koreksi fakta, atau banter yang
memang mengundang; acknowledgment dan percakapan manusia yang sudah mengalir
ditinggalkan. Kandidat yang tersusul menunggu grup hening lalu diperiksa ulang,
bukan dikirim basi. Burst ambient dari anggota yang sama ditunggu 1,2 detik;
panggilan direct memakai jeda 350 ms dan membatalkan planner ambient yang masih
berjalan. Setiap bubble tetap dihitung dan dideduplikasi sendiri.

Harvy memahami lowercase, singkatan, code-mix, emoji, dan beberapa bubble tanpa
sengaja meniru typo atau mengarang pengalaman manusia. Corpus sintetis grup
memuat 15 topik, 150 skenario semantik × empat variasi permukaan, serta 60
episode direct. Artefak dan batas buktinya ada di
[`docs/evidence/group-conversation-2026-07-30/`](docs/evidence/group-conversation-2026-07-30/README.md).

Memori grup tidak masuk ke chat pribadi atau grup lain. Shared room context
tetap pendek dan berada di RAM. Untuk pesan direct, Harvy juga dapat menyimpan
memori biasa yang terpisah per anggota dan per grup, lalu mengumumkannya dengan
baris `📎`; memori personal atau yang ditandai sensitif tidak disimpan otomatis.
Untuk usulan personal, Harvy meminta anggota yang sama membalas “ya, simpan
memori ini” dalam 10 menit; permintaan itu hanya berlaku di grup tersebut dan
hilang ketika proses dimulai ulang.
Catatan yang sungguh dimiliki ruang dibuat lewat usulan eksplisit seperti
`ingat keputusan grup: ...`, bukan disimpulkan dari percakapan ambient. Harvy
menampilkan preview persis beserta ID; admin terkini harus membalas konfirmasi
ID yang sama dalam 10 menit. Catatan bersama terlihat oleh semua anggota,
berakhir setelah 60 hari, dan maksimal empat catatan terbaru masuk context
model sebagai data tak tepercaya.
Versi beta juga menyimpan nama grup dan julukan Harvy selama Harvy masih aktif;
pasangan ID teknis
PN/LID, nama tampilan/koreksi, waktu terakhir terlihat, dan aktivitas harian
anggota dibersihkan dalam jendela 30 hari. ID pesan untuk dedupe bertahan 24
jam, sedangkan daftar “paling aktif” selalu memakai 7 hari dan bukan cap
kepribadian. Konteks chat mentah berada paling lama 24 giliran atau 2 jam di RAM; pesan dan
balasan yang ditandai sensitif/berisiko tidak dimasukkan ke sana. Seluruh
memori sosial dihapus saat Harvy dikeluarkan atau dinonaktifkan.

Anggota dapat meminta `lihat memori grup`, `ubah memori #ID jadi ...`, `hapus
memori #ID`, mengoreksi nama tampilannya, atau meminta `lupakan tentang aku`;
admin dapat menambahkan julukan Harvy, meminta `hapus catatan grup #ID`, dan
meminta `reset memori grup`. Penghapusan diri dan reset grup memerlukan
konfirmasi kedua dalam 10 menit. Reset admin hanya menghapus profil sosial dan
catatan bersama; memori semantik lokal setiap anggota tetap berada dalam
kendali anggotanya. Removal/disable Harvy tetap menghapus seluruh scope grup.
Sebelum pesan grup masuk core, cache metadata berbatas waktu harus membuktikan
Harvy dan pengirim masih menjadi peserta; event perubahan membership langsung
membatalkan batch serta hak lama. Pada repository file, penghapusan diri
menghapus profil sosial, memori anggota, dan atribusi pengusul catatan ruang
dalam satu commit.

Harvy memakai satu capability catalog dan scope bertipe pada percakapan privat
maupun grup. Snapshot itu ikut ke prompt agar model tidak mengaku mempunyai alat
yang tidak dipasang. Executor `web.search` dan `web.open` sudah dicabut dari
runtime; Harvy saat ini tidak dapat melakukan pencarian web langsung. X/Threads,
function calling ke aplikasi luar, kalender eksternal/email, pembacaan file
host, dan memori lintas kanal juga belum tersedia. Pengetahuan bawaan model
bukan hasil pencarian atau verifikasi sumber terkini.

Pertanyaan dan permintaan tenang tanpa sesi aktif kini memakai root agent
`cheap`; pekerjaan bertahap/panjang naik ke root `ambitious`, yang boleh
mendelegasikan 2–3 subpekerjaan read-only secara paralel kepada worker
`cheap|efficient`. Worker hanya menerima submasalahnya—tanpa memori, riwayat,
tool, credential, atau hak delegasi—lalu root menyatukan hasilnya. Tool internal
dapat membaca tugas, sesi, jam, dan agenda Harvy. Pertanyaan jam yang berdiri
sendiri dijawab langsung dari clock runtime. Untuk frasa personal yang dikenali
seperti “agenda besok” atau “tugas terdekat”, jawaban wajib mempunyai observation
live dengan cakupan yang memadai; pagar ini sengaja berpresisi tinggi dan belum
mencakup setiap kemungkinan parafrasa.
`calendar.agenda` bukan Google/Outlook: isinya hanya tenggat, pengingat, dan
check-in Harvy dalam jendela berjalan 1–31 hari. `terminal.run` juga bukan shell host; ia scratchpad virtual
kosong per action untuk hitung serta file sementara, tanpa process, network,
environment, atau data Harvy. Kernel memvalidasi action, schema, policy,
idempotency key, cycle guard, dan pause/resume. Setiap pemanggilan aktif dibatasi
45 detik; checkpoint Agent Runtime dapat dijawab ulang dalam horizon absolut 10
menit tanpa menambah jatah langkah. Checkpoint `waiting_input` privat Telegram
disimpan setelah prompt terkirim dan dapat dipulihkan setelah restart normal
melalui adapter file satu-proses; expiry, ekspor, penghapusan, consent, serta CAS
ikut ditegakkan. Run aktif belum dipulihkan dan Harvy belum mempunyai RunStore
PostgreSQL, outbox, receipt, status `unknown`, atau reconciler.

Harvy “belajar” dalam arti memakai memori semantik yang dapat dilihat,
dikoreksi, dan dihapus pengguna serta episode percakapan untuk kesinambungan.
Ia tidak melatih ulang bobot model atau membuat hidden self-training dari chat
produksi. Memori juga bukan bukti izin, waktu kini, jadwal live, atau keberhasilan
tool—hal-hal itu harus datang dari state atau observation yang berwenang.

Tipe scope juga sudah mempunyai fondasi Workspace dengan principal pseudonim,
membership, role, permission tertutup, dan `aclEpoch` yang membatalkan scope
lama ketika hak berubah. Ini belum menjadi fitur pengguna: belum ada ingress,
UI membership, artifact store, PostgreSQL, atau wiring Workspace pada aplikasi.

Harvy memperkenalkan sistem AI-nya sebagai **model Capybara**. Capybara adalah
nama lapisan multi-model milik Harvy, bukan klaim bahwa seluruh sistem memakai
satu foundation model atau satu penyedia tertentu.

### Yang Harvy lakukan saat tidak yakin

Harvy **tidak** mengubah setiap pesan menjadi tugas. Kalau kamu menulis keluhan,
ia menanggapi keadaanmu dulu, lalu menawarkan mencatat pekerjaannya lewat
tombol. Kalau kamu meminta Harvy membuat sesuatu di chat, seperti kode atau
ringkasan, ia mengerjakannya alih-alih memasukkannya ke daftar tugas. Kalau kamu
bertanya soal pelajaran, ia menuntun alih-alih langsung memberi jawaban akhir.
Kalau ia tidak paham, ia mengatakannya.

Kalau kamu memenggal cerita menjadi beberapa bubble cepat, Harvy menyimaknya
sebagai satu giliran sebelum menjawab. Pesan tunggal yang sudah jelas diproses
segera setelah pemeriksaan singkat; beberapa bubble lengkap diberi ruang 4
detik, pembuka cerita 7 detik, dan kalimat yang benar-benar menggantung 12
detik sejak bubble terakhir. Model dapat menandai giliran `urgent` untuk
memotong jeda itu; pengenalan bahaya tidak memakai daftar kata lokal. Balasan
lengkap tetap menjaga urutan dengan balasan yang sudah aktif.

## Menjalankan

Syarat: Node.js 22 atau lebih baru, token bot dari
[@BotFather](https://t.me/BotFather), dan kunci model AI.

```bash
npm install
cp .env.example .env
```

Isi `TELEGRAM_BOT_TOKEN`, lalu pilih mode di `.env`:

- **`AI_MODE=testing`** — satu model gratis lewat Google AI Studio. Isi
  `GOOGLE_AI_STUDIO_API_KEYS` (boleh beberapa kunci dipisah koma, dipakai
  bergantian supaya kuota gratis tidak cepat habis) dan `AI_MODEL_TESTING`.
  Provider OpenAI-compatible kedua dapat dipasang sebagai cadangan lewat empat
  `AI_TESTING_FALLBACK_*`; kunci dikirim sebagai Bearer header, bukan query.
  Cadangan ini hanya aktif pada mode testing.
- **`AI_MODE=production`** — tiga model lewat OpenRouter, dipilih menurut
  kesulitan pekerjaan. Isi `OPENROUTER_API_KEY` beserta `AI_MODEL_CHEAP`,
  `AI_MODEL_EFFICIENT`, dan `AI_MODEL_AMBITIOUS`.

Verifikasi ejaan persis ID model di daftar model penyedia sebelum dipakai.
Zona waktu bawaan, lokasi berkas sesi/telemetry/log, retensi, batas token 24
jam, dan harga tiap model juga dapat diatur lewat `.env`; lihat
[`.env.example`](.env.example) untuk daftar lengkap.

Konfigurasi `WEB_SEARCH_*` dan `WEB_OPEN_*` sudah dihapus bersama executor web.
Riwayat keputusannya dipertahankan di
[`ADR-015`](docs/decisions/ADR-015-executor-web-baca-saja.md), bukan sebagai
petunjuk setup aktif.

Setelah itu:

```bash
npm run dev
```

Perintah development tetap memuat ulang Harvy saat `src/`, `.env`,
`package.json`, atau `tsconfig.json` berubah. Watcher Harvy meminta proses lama
shutdown lewat IPC dan menunggu lock dilepas sebelum memulai proses baru.
Tekan `Ctrl+C` untuk berhenti; runner menunggu proses lama menyelesaikan
shutdown (ditandai log `shutdown_completed`) sebelum ikut keluar.
`tsx watch` tidak dipakai karena pada Windows ia dapat mematikan child sebelum
cleanup Harvy sempat berjalan.

WhatsApp tidak aktif secara bawaan. Untuk beta lokal, isi
`WHATSAPP_ENABLED=true`, `WHATSAPP_PAIRING_MODE=qr`, dan
`WHATSAPP_ACCOUNTS` di `.env`. Array berikut
menjalankan dua nomor sebagai dua socket dan dua auth namespace terisolasi:

```text
WHATSAPP_ACCOUNTS=[{"id":"utama","phoneNumber":"6281234567890"},{"id":"kelas","phoneNumber":"6281111111111"}]
```

Array dapat berisi lebih banyak akun dengan `id` unik. `id` adalah alias
operasional non-pribadi yang harus diawali huruf; jangan isi nomor telepon atau
JID karena alias ini dipakai untuk membedakan insiden antar-socket. Satu grup
tetap terikat ke satu account ID; Harvy tidak memindahkannya otomatis ke nomor
lain ketika satu socket gagal atau dibatasi.

Saat akun belum dipasangkan, mode `qr` menampilkan QR lokal hanya pada terminal
interaktif dan hanya bila `APP_ENV` bukan `production`. Pindai melalui menu
**Perangkat tertaut** WhatsApp dan jangan membagikannya. Stdout production dan
pipe noninteraktif sengaja tidak pernah menampilkan QR/kode pairing karena
keduanya lazim dikumpulkan sebagai log; deployment production harus
memprovisikan auth lewat prosedur operator aman. Mode `code` juga tersedia,
tetapi bukan default karena pairing-code Baileys sedang mempunyai kegagalan
upstream pada sebagian akun/server. Folder `data/whatsapp-auth/` setara
kredensial sesi dan tidak boleh disalin, di-log, atau dimasukkan Git.

### Harvy Console lokal

Console operator tersedia untuk mengelola cohort standard/beta, paket pilot,
kuota, mode grup, undangan evaluasi, versi harga provider+model, usage, biaya,
dan audit. Daftar model dibaca dari seluruh slot model `.env` saat startup;
operator memilih pasangan yang tersedia dan hanya mengisi harga. API tidak
mengekspos base URL atau credential, dan server menolak pasangan model buatan.
Ia juga mendukung label pseudonim manual, breakdown/filter cohort dan paket,
biaya `complete/partial/unknown`, serta bucket anggota grup pseudonim. Console
bukan website chat pengguna dan tidak menyimpan prompt, balasan, atau
transcript.

Aktifkan di `.env`:

```text
HARVY_CONSOLE_ENABLED=true
HARVY_CONSOLE_HOST=127.0.0.1
HARVY_CONSOLE_PORT=3210
```

Saat development, token operator acak ditampilkan satu kali di terminal lokal.
Buka `http://127.0.0.1:3210`, masukkan token itu, lalu browser menerima sesi
`HttpOnly`; token tidak disimpan di storage browser. Bila `APP_ENV=production`,
isi `HARVY_CONSOLE_TOKEN` minimal 32 karakter.

Versi ini sengaja menolak bind non-loopback dan belum aman untuk domain,
reverse proxy publik, atau tunnel. Ia juga belum menerima pembayaran; seluruh
paket/harga berstatus pilot. Runtime, probe, dan evaluator memakai lock berkas
yang sama sehingga tidak dapat membuka repository JSON secara bersamaan.
Kapasitas paket baru berkurang setelah balasan berhasil dikirim; attempt gagal,
fallback, planner, keselamatan, dan biaya tak diketahui tetap terlihat sebagai
biaya teknis tanpa dijadikan debit palsu. Arti angka ledger, backup, dan daftar gerbang
PostgreSQL/OIDC/MFA/RBAC/TLS sebelum transisi VPS dijelaskan di
[runbook Harvy Console](docs/operations/HARVY_CONSOLE.md). Strategi paket pilot
berada di [dokumen beta dan paket](docs/product/PILOT_BETA_DAN_PAKET.md).

### Log operasional

Harvy menulis log terstruktur NDJSON ke `data/logs/` dan, bila diaktifkan,
record aman yang sama ke terminal (`pretty` atau JSON). Log ini terpisah dari
telemetry pemakaian pengguna. Isinya adalah waktu, komponen, event, trace acak,
durasi, status, kode error aman, frame stack, dan fingerprint—bukan
deskripsi bebas dari call site, `Error.message`, isi chat, prompt/balasan AI,
identitas pengguna/grup, nomor, QR, token, atau kredensial. Nama `event` stabil
menjadi deskripsi yang dapat dicari. Field detail memakai allowlist scalar
tertutup; payload/object mentah dibuang.

Bawaan merotasi file pada 25 MiB atau pergantian hari UTC, membatasi total
250 MiB, dan menghapus segmen file lokal berdasarkan tanggal UTC namanya
setelah 14 hari. Jalur darurat error juga tidak boleh melewati cap tersebut.
Jika sink file opsional gagal, Harvy tetap memakai `stderr` tersaring meski
`LOG_CONSOLE=false`. Retensi stdout yang
diteruskan ke Docker/systemd/cloud collector berada di kebijakan collector
tersebut dan harus dibatasi operator secara terpisah. Atur `LOG_LEVEL=debug`
hanya ketika perlu diagnosis lebih rinci; untuk collector produksi gunakan
`APP_ENV=production` dan `LOG_CONSOLE_FORMAT=json`. Backpressure console
membuang record berikutnya secara berbatas dan mencatat jumlahnya ke health,
sementara sink file tetap berjalan. `LOG_FILE_REQUIRED=true` membuat startup
gagal bila file atau retensi awal yang diwajibkan tidak sehat. Detail kontrak
dan keterbatasannya ada di
[ADR-010](docs/decisions/ADR-010-log-operasional-produksi.md).

Untuk pemeriksaan lengkap:

```bash
npm run check
npm test
```

## Batas versi awal

- **Butuh kunci API untuk berjalan.** Tidak ada cadangan berbasis aturan; pada
  mode testing boleh ada provider AI cadangan, tetapi bila semua provider
  terganggu Harvy tetap mengaku sedang tidak bisa memproses. Batas pemakaian
  Harvy dapat menolak percakapan biasa, tetapi tidak memblokir pemeriksaan
  keselamatan.
- **Isi pesanmu dapat dikirim ke satu atau lebih penyedia model pihak ketiga**,
  kini termasuk memori dan ringkasan percakapan. Permintaan yang gagal pada
  provider utama dapat dikirim ulang ke provider cadangan. Permintaan rumit
  yang aman juga dapat dipecah menjadi dua atau tiga panggilan worker paralel;
  worker tidak menerima memori, riwayat, atau tool. Kontak pertama menjelaskan
  ini dan meminta persetujuan; hanya pesan pertama boleh menjalani satu triase
  keselamatan sebelum persetujuan. Persetujuan dapat ditarik dari dalam chat.
- Memori dan riwayat percakapan sudah dicoba pada percakapan sungguhan dan
  menemukan kegagalan. Perbaikannya sudah lolos tes otomatis serta probe model,
  tetapi belum diuji ulang end-to-end di Telegram. Sesi persisten, tutoring lima
  langkah, tombol adaptif, check-in, kontrol data, dan telemetry juga baru
  terbukti lewat tes otomatis.
- Ringkasan percakapan disusun model, jadi ia bisa keliru. Keliru meringkas
  berarti Harvy salah mengingat, bukan sekadar lupa.
- Pengingat dan check-in meminta waktu pilihan pengguna serta menghormati zona
  waktu dan jam tenang. Pengiriman yang jatuh ketika pengguna sedang aktif atau
  sedang berada dalam jam tenang akan ditunda.
- Pembacaan tenggat oleh model tidak selalu tepat. Setiap tugas yang tercatat
  selalu ditampilkan lengkap beserta tombol Ubah tenggat dan Batalkan.
- Kosakata condong ke bahasa Indonesia sehari-hari; bahasa daerah dan campur
  kode berat belum tertangani.
- Profil dapat memilih WIB, WITA, atau WIT; `DEFAULT_TIMEZONE` menjadi fallback
  untuk profil lama atau yang belum memilih.
- Ekspor mencakup data yang dapat dilihat pengguna tetapi sengaja mengecualikan
  catatan keselamatan tersembunyi sesuai Konstitusi. Penghapusan penuh tetap
  menghapus catatan tersembunyi itu beserta tugas, riwayat, memori, sesi,
  profil, dan telemetry.
- Grup Telegram belum tersedia. Grup WhatsApp baru berupa beta satu proses:
  unit dan integrasinya dengan socket palsu sudah diuji, termasuk reconnect,
  re-add, batching, pembatalan planner/revalidation, race removal, epoch cache
  admin, dan shutdown. Satu nomor sudah berhasil pairing QR, login, `open`, dan
  membalas grup nyata; notice, ritme ambient terbaru, revalidation kandidat,
  kontrol memori, removal, keselamatan, shutdown baru, serta dua nomor nyata
  sekaligus belum diuji end-to-end. Angka latency evaluator hanya mengukur
  request model sintetis, bukan delivery WhatsApp nyata. Rollback delivery
  sudah ada untuk record memori baru, tetapi edit/delete/reset/alias belum
  mempunyai transaksi kompensasi generik bila acknowledgment gagal setelah
  commit.
- Harvy Core dan capability catalog sudah channel-neutral, tetapi kesetaraan
  surface belum tercapai: chat privat masih hanya Telegram dan grup yang aktif
  masih hanya WhatsApp. Registry sengaja menandai Telegram grup dan WhatsApp
  privat tidak tersedia sampai adapter-nya benar-benar disambungkan.
- Tool state internal, agenda Harvy, terminal virtual, dan delegasi read-only
  baru teruji otomatis/adapter palsu. Executor `web.search`/`web.open` telah
  dicabut; pembacaan dokumen/lampiran/host, X/Threads khusus, kalender eksternal,
  email, shell/program, dan aksi aplikasi belum dibuat. Pengetahuan bawaan
  model bukan hasil pencarian langsung.
- Workspace Scope & Authority v1 baru merupakan fondasi core teruji. Tidak ada
  kanal Workspace, UI membership, artifact, account linking, atau durable run;
  adapter authority file hanya aman untuk satu proses.
- Baileys bukan API resmi WhatsApp. Protokol dapat berubah dan nomor dapat
  terputus atau dibatasi. Auth multi-file saat ini sengaja hanya fondasi lokal;
  produksi memerlukan penyimpanan database terenkripsi dan pengujian dengan
  nomor nonkritis.
- Hal sensitif — kesehatan, keluarga, relasi, gender, orientasi seksual, dan
  tekanan berat — secara kontrak hanya boleh disimpan setelah izin. Kode
  memaksa jalur izin bila salah satu dari dua penilai AI menandainya sensitif,
  tetapi salah klasifikasi serentak keduanya masih menjadi keterbatasan terbuka.
- Tidak menghubungi pengguna tanpa pengingat atau check-in yang ia pilih
  sendiri. Check-in satu kali yang diabaikan tidak menghasilkan nudge kedua.
- Penyimpanan berkas cocok untuk prototipe satu proses, termasuk banyak socket
  Baileys di proses yang sama; belum aman untuk armada multi-proses atau
  produksi.
- Harvy Console sekarang ada sebagai control plane localhost, tetapi website
  percakapan pengguna, pembayaran, subscription lifecycle, serta Console
  internet-ready belum ada. Ledger detail hanya mempunyai provenance provider
  sejak fitur ini dipasang; telemetry lama tidak diubah menjadi attempt palsu.
  File lokal dijaga lock satu proses, tetapi tetap bukan billing database
  produksi. `Ctrl+C` pada `npm run dev` menjalankan shutdown normal dan melepas
  lock; lock stale sesudah crash atau penghentian paksa hanya boleh dihapus
  setelah PID pemilik dipastikan mati.
- Bubble dan aksi tombol yang sedang diproses dikuras saat Harvy dimatikan
  normal, dengan grace period 60 detik, tetapi antreannya masih hanya di memori.
  Crash atau penghentian paksa pada saat itu dapat menghilangkan satu giliran
  yang belum selesai.
- Pengingat dan check-in bersifat at-least-once pada satu jendela sempit: bila
  Telegram sudah menerima pesan tetapi proses mati sebelum status tersimpan,
  pesan itu dapat dicoba lagi setelah restart.

Keputusan produk dan backlog ada di [docs/PROJECT.md](docs/PROJECT.md). Arah
moral dan batasnya ada di [docs/CONSTITUTION.md](docs/CONSTITUTION.md).

## Pengembangan dengan coding agent

Codex, Claude Code, dan Antigravity menggunakan satu protokol bersama. Mulai
dari [AGENTS.md](AGENTS.md), lalu pilih dokumentasi melalui
[docs/INDEX.md](docs/INDEX.md).

Sekali per clone, aktifkan hook yang memvalidasi pointer dan batas konteks agent
ketika file bootstrap/status terkait berubah:

```bash
git config core.hooksPath .githooks
```

Hook tidak mewajibkan LOG untuk setiap commit; aturan materialitas dokumentasi
ada di [AGENTS.md](AGENTS.md).
