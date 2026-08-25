# Harvy Console: Operasi Lokal dan Jalur Produksi

Harvy Console adalah control plane operator, bukan kanal percakapan pengguna.
Versi runtime sengaja hidup di proses Harvy yang sama; mode pairing dapat
dibootstrap sendiri sebelum runtime utama. Keduanya hanya menerima koneksi
`127.0.0.1`. Tujuannya adalah mengelola akses pilot serta memahami usage dan
biaya tanpa menjadikan log sebagai arsip percakapan.

Keputusan yang mengikat desain ini berada di
[`ADR-013`](../decisions/ADR-013-harvy-console-entitlement-dan-ledger-biaya.md).

## Menyalakan di localhost

Isi `.env`:

```text
HARVY_CONSOLE_ENABLED=true
HARVY_CONSOLE_HOST=127.0.0.1
HARVY_CONSOLE_PORT=3210
```

Pada development, `HARVY_CONSOLE_TOKEN` boleh kosong. Harvy membuat token acak
dan menampilkannya satu kali di terminal interaktif; token tidak ditulis ke
log. Pada `APP_ENV=production`, token minimal 32 karakter wajib disediakan.
Setelah `npm run dev`, buka `http://127.0.0.1:3210`.

Perintah itu memakai watcher Harvy di `scripts/dev-runner.ts`. Perubahan di
`src/`, `.env`, `package.json`, atau `tsconfig.json` tetap memicu reload, tetapi
runner meminta child shutdown lewat IPC dan menunggu runtime lock dilepas
sebelum menjalankan child baru. Pada Windows, `tsx watch` tidak dipakai karena
ia meneruskan `Ctrl+C` dengan penghentian child yang melewati cleanup aplikasi.

Login menukar token operator menjadi sesi in-memory dengan cookie `HttpOnly`
dan `SameSite=Strict`. Browser tidak menyimpan token di `localStorage` atau
`sessionStorage`. Restart proses membatalkan seluruh sesi.

## Mode setup kanal tanpa bootstrap Telegram

Pairing akun uji tidak bergantung pada runtime utama yang sudah memiliki token
Telegram. Jalankan:

```powershell
npm run console:setup
```

Mode ini memakai server Console, login, Origin, CSRF, rate limit, CSP, dan audit
yang sama, tetapi control-plane pendampingnya berada di direktori sementara.
URL diarahkan ke tab **Kanal**. Token bot Telegram serta armada akun WhatsApp
layanan ditulis ke store credential layanan lokal; token bot pengujian, session
penguji, dan dua session WhatsApp acceptance ditulis ke storage live-acceptance
yang berbeda. Keduanya permanen dan diabaikan Git; dashboard sementara bukan
sumber status produk. Mode setup juga memegang lock runtime utama, sehingga
sesi layanan tidak pernah dipasangkan, dicabut, atau diperiksa oleh dua proses
Baileys sekaligus. Hentikan Harvy sebelum membuka mode ini.

Mode setup tidak memakai sidebar satu-item. Dua tab halaman dengan lebar setara
memisahkan **Layanan** dari **Pengujian**, dan badge pada keduanya tetap memberi
ringkasan keadaan lingkungan yang sedang tidak dibuka. Tab **Layanan** mengelola
token BotFather dan armada WhatsApp layanan. Snapshot browser hanya membawa
sumber, fase verifikasi, status runtime, kebutuhan restart, alias operasional,
dan lifecycle akun—tidak pernah nilai token, nomor, JID, atau path. Token serta
metadata armada yang lolos validasi disimpan dengan AES-GCM di
`secrets/primary-channels.secrets.json`; kunci lokal terpisah berada di
`secrets/primary-channels.key`; material linked-device tetap berada per alias di
`data/whatsapp-auth/`. Tab **Pengujian** memakai bot Telegram, akun
Telegram penguji, dan dua session WhatsApp sendiri. Console menolak bot layanan
dan bot pengujian yang identik, serta menolak identitas WhatsApp layanan yang
sama dengan akun acceptance atau akun layanan lain.

Instalasi lama yang masih mempunyai `TELEGRAM_BOT_TOKEN` di `.env` mendapat
aksi migrasi eksplisit. Migrasi hanya berjalan bila ada tepat satu entri yang
sama dengan environment proses, memverifikasi bot ke Telegram, menulis store
terenkripsi lebih dahulu, lalu menghapus baris `.env` secara atomik. Sumber
Console dan environment yang berbeda gagal tertutup. Setelah token diubah pada
runtime aktif, Console meminta restart; ia tidak mengklaim proses lama sudah
memakai credential baru.

Instalasi lama dengan `WHATSAPP_ENABLED`, `WHATSAPP_PRIVATE_ENABLED`, dan
`WHATSAPP_ACCOUNTS` mendapat migrasi eksplisit yang serupa. Console hanya
menawarkan migrasi bila ketiga sumber tidak ambigu; setiap folder session harus
lengkap dan nomor di credential harus cocok dengan deklarasi legacy. Store
terenkripsi ditulis lebih dulu, lalu tiga baris legacy dihapus atomik dari
`.env`. `WHATSAPP_AUTH_FOLDER` tetap boleh dipakai sebagai tuning path; nilai
default `./data/whatsapp-auth` tidak perlu ditulis di environment.

Untuk menambah nomor layanan, buka **Layanan → Kelola kanal**, beri alias
operasional yang stabil, lalu pindai QR dari akun WhatsApp yang akan bertindak
sebagai Harvy. Console tidak meminta nomor dan tidak menampilkannya kembali.
Setiap akun melewati lifecycle durable `pending → active`; runtime hanya memuat
akun `active`. Penggantian menurunkan akun ke `pending` sebelum logout dan QR
baru, sedangkan penghapusan memakai `removing` sebelum revoke. Karena itu crash
di tengah operasi terlihat dan dapat dilanjutkan, bukan diam-diam mengaktifkan
session setengah jadi. Sakelar layanan dan percakapan pribadi berlaku untuk
seluruh armada setelah restart.

Seluruh mutasi armada dijalankan satu per satu. Polling status tidak membaca
folder session yang sedang dipasangkan, diganti, atau dicabut; reset folder
mengulang kegagalan filesystem Windows yang bersifat sementara. Akses ke file
credential kanal utama juga diserialkan per path agar penyimpanan Telegram dan
WhatsApp tidak saling menimpa ketika terjadi bersamaan. Kontrak ini berlaku di
dalam proses; lock runtime utama tetap wajib untuk mencegah dua proses membuka
session layanan yang sama.

Ringkasan kanal tetap tenang saat belum lengkap: masalah terlihat pada badge dan
tombol **Selesaikan**, sedangkan **Pengaturan koneksi** baru muncul setelah
operator memilih **Kelola**. Hanya satu dari kanal layanan, Telegram pengujian,
atau WhatsApp pengujian yang terlihat pada satu waktu; form token dan
pairing tetap tersembunyi setelah credential tersedia. Untuk WhatsApp, Console memisahkan
`credential tersimpan` dari validitas session: credential yang ditemukan
menjalani handshake bounded ke platform dan memperoleh state `Memeriksa sesi`,
`Sesi valid`, `Sesi ditolak`, atau `Belum terverifikasi`. Hasil diterima
dicache lima menit; tombol **Periksa sesi WhatsApp** memaksa pemeriksaan baru.
Gangguan jaringan tidak disamakan dengan session ditolak.

Setelah empat identitas siap—termasuk kedua session WhatsApp diterima pada
pemeriksaan terbaru—tab Pengujian menampilkan dua alur berbasis peran:
`Penguji (Akun Telegram) → Harvy (Bot Telegram)` serta
`Penguji (Akun WhatsApp) → Harvy (Akun WhatsApp)`. Status **Siap untuk pengujian
langsung** berarti material empat identitas tersedia dan kedua handshake
WhatsApp terbaru diterima. Ia tetap bukan bukti pengiriman penguji→Harvy, kualitas
respons, atau session Telegram yang direvalidasi setelah proses restart; itu
baru dibuktikan runner.

Mode setup dan tab Kanal runtime memegang satu lock credential lintas
proses. Console kedua serta runner acceptance akan gagal tertutup selama lock
aktif. Tutup Console sebelum menjalankan acceptance agar session tidak berubah
di tengah percakapan nyata.

QR Telegram/WhatsApp hanya disimpan di memori selama operasi aktif. Endpoint
status tidak mengembalikan payload QR, token, session, `api_hash`, nomor, atau
JID. Endpoint QR mengubah payload menjadi matriks SVG dan hanya dapat dibaca
oleh sesi operator. Token dan session tersimpan tidak pernah dikirim kembali
ke browser. Console mengambil SVG dengan `fetch`, memvalidasi struktur terbatas
`svg`/`rect`/`path`, lalu menyisipkannya langsung ke permukaan QR; status HTTP
atau MIME yang salah tidak lagi dapat menjadi kotak gambar putih. Browser baru
menyatakan QR siap setelah SVG tervalidasi dan terpasang; satu kegagalan
sementara dicoba ulang sekali. Bila tetap gagal, Console
menampilkan **Coba muat QR lagi** tanpa memulai ulang atau mencabut pairing.
Pencabutan session mencoba logout ke platform sebelum credential
lokal dihapus dan gagal tertutup bila logout tidak dapat dibuktikan. Bila
perangkat sudah dicabut dari ponsel, status terminal `loggedOut` dihitung
sebagai bukti pencabutan; operator dapat memilih **Pasangkan ulang** dan Console
akan membersihkan credential lokal yatim lalu menampilkan QR baru dalam satu
alur. Close jaringan biasa tetap mempertahankan credential lokal. Error
diterjemahkan menjadi langkah pemulihan dan kode internal tidak menjadi copy
utama. Direct console output dependency Signal disaring karena dapat memuat
material ratchet walau logger Baileys sudah silent.

Regresi UI setup dapat diperiksa dengan browser Chromium/Edge nyata, termasuk
login, pemuatan API, exception JavaScript, dan layout desktop/mobile:

```powershell
npm run test:console-browser
```

Command ini memakai server serta storage sementara dan tidak melakukan pairing
atau mengirim pesan ke platform.

Untuk audit read-only terhadap credential dan session yang benar-benar sudah
dipasangkan, tutup Console setup lain lalu jalankan:

```powershell
npm run test:console-browser:live
```

Mode live membuka Edge/Chromium, mengunjungi tiga konteks **Kelola**, memaksa
pemeriksaan Telegram dan WhatsApp nyata, serta memeriksa layout desktop/mobile.
Ia tidak menekan aksi pairing, penggantian, pencabutan, atau penghapusan dan
tidak mengirim pesan. Command dapat melaporkan `Sesi ditolak`; itu adalah bukti
platform atas session saat ini, bukan kegagalan renderer Console.

Saat Console setup sedang hidup dan QR pairing memang aktif, renderer QR live
dapat diaudit pada proses dan credential yang sama tanpa mencetak atau menyimpan
payload QR:

```powershell
npm run test:console-browser:external-qr
```

Audit ini masuk sebagai operator, membuka panel WhatsApp, lalu membuktikan SVG
inline mempunyai ukuran layar, warna hitam/putih, serta modul QR nonkosong. Ia
tidak memulai atau membatalkan pairing.

Saat `console:setup` hidup, surface akun layanan yang nyata dapat diaudit tanpa
mutasi atau refleksi identifier:

```powershell
npm run test:console-browser:external-service
```

Audit ini masuk melalui browser nyata, membuka **Layanan**, memastikan sumber
legacy/Console disajikan jujur, memeriksa kesimetrian kartu dan overflow pada
desktop/mobile, lalu keluar tanpa pairing, revoke, atau perubahan pengaturan.

## Yang dapat diatur

- Mendaftarkan chat pribadi atau grup dari ID platform. ID mentah hanya dipakai
  saat operasi itu; control plane menyimpan reference HMAC per instalasi.
  Operator boleh memberi label pseudonim manual agar daftar mudah dipahami,
  tetapi Console mengingatkan agar tidak memakai nama asli atau nomor.
- Mengubah cohort `standard|beta`, paket, override kuota, masa beta, dan mode
  grup secara terpisah. Mengganti paket grup menyelaraskan mode bawaan, tetapi
  operator masih dapat memilih `direct_only`, `ambient`, `paused`, atau
  `disabled`.
- Mengundang atau mencabut evaluasi. Operator tidak mempunyai endpoint untuk
  memberi persetujuan atas nama peserta; status `granted` hanya boleh datang
  dari alur persetujuan peserta yang kelak disambungkan.
- Membuat versi katalog paket. Untuk harga, operator memilih pasangan
  provider+model yang sudah dibaca dari environment lalu hanya mengisi tarif.
  Versi lama ditutup pada waktu efektif versi baru, bukan ditimpa.
- Melihat logical request, setiap provider attempt, fallback, token, biaya,
  status rekonsiliasi, entitlement, subject grup, principal anggota
  pseudonim, dan audit operator. Dashboard memecah standard/beta serta paket;
  tabel usage dapat difilter menurut cohort dan paket.
- Memverifikasi dan mengganti token bot Telegram uji, memasangkan akun Telegram
  tester (termasuk 2FA tanpa persist password), serta memasangkan atau mencabut
  dua role WhatsApp live acceptance yang wajib berbeda.
- Memverifikasi, menyimpan, mengganti, atau menghapus token bot Telegram utama
  tanpa memantulkan secret ke browser. Backup lokal terenkripsi memasukkan key
  dan ciphertext sebagai dua slot credential; media eksternal dan restore
  lintas mesin tetap tanggung jawab operator.
- Memigrasikan daftar akun WhatsApp layanan dari `.env`, menambah banyak akun
  beralias, memeriksa session ke platform, memasangkan ulang, mencabut akun,
  serta mengatur aktivasi grup/privat tanpa menampilkan nomor atau JID.

Tidak ada checkout, pembayaran, auto-renew, invoice, refund, webhook, atau SLA
komersial pada versi ini. Paket berstatus `pilot` adalah hipotesis produk.

## Sumber daftar model

Saat startup, server membentuk inventaris dari seluruh slot model yang
nonkosong: `AI_MODEL_TESTING`, override testing per tier,
`AI_TESTING_FALLBACK_MODEL`, serta tiga `AI_MODEL_*` production. Model untuk
mode yang sedang tidak aktif tetap terlihat sebagai “tersedia, tidak aktif”;
status aktif menunjukkan routing proses sekarang, bukan kesehatan provider.
Model yang sama pada beberapa tier tampil satu kali dengan seluruh sumbernya.

Respons API hanya membawa `providerId`, `modelId`, mode, origin, tier, nama
variabel model, dan status aktif. Base URL, API key, token pool, maupun
credential lain tidak menjadi bagian katalog. `AI_TESTING_FALLBACK_PROVIDER_ID`
harus diisi eksplisit bila label ledger perlu bernama `always-codex`; Harvy
tidak menebak provider dari URL.

Form harga memakai satu pemilih pasangan katalog. Server tetap memeriksa
allowlist yang sama dan menolak POST untuk provider/model buatan. Perubahan
model di `.env` baru terlihat setelah restart Harvy. Model yang dihapus tidak
lagi dapat menerima versi harga baru, tetapi seluruh harga dan attempt
historisnya tetap dapat dibaca. Mengganti ejaan provider atau model membuat
identitas harga baru dan tidak memindahkan histori lama.

## Arti angka usage

Satu giliran dapat membuat beberapa logical request. Satu logical request dapat
memiliki beberapa provider attempt karena rotasi kunci, penurunan mode JSON,
retry, atau fallback. Setiap `fetch` memperoleh `attemptId`; seluruh retry dan
fallback dari permintaan yang sama mempertahankan `requestId`.

Biaya efektif memakai biaya yang dilaporkan provider bila tersedia. Jika tidak,
ledger menghitung dari snapshot harga yang aktif saat attempt dimulai. Uang
disimpan sebagai integer nano-USD dan harga sebagai decimal string agar tidak
terkena pembulatan floating point. Cache read/write dan reasoning dihitung
terpisah ketika provider melaporkannya, sehingga token tidak dihitung dua kali.
Nilai harga `0/0` dari environment adalah bootstrap lama yang berarti
**token-only**, bukan bukti model gratis, sehingga ia tidak membuat versi
harga. Pengelolaan harga berikutnya dilakukan di Console. Jika tarif provider
memang nol, buat versi harga nol secara eksplisit agar keputusan itu tercatat
dan dapat diaudit.

Provenance biaya yang harus dibaca jujur:

- `provider`: biaya berasal dari provider;
- `catalog`: biaya dihitung dari katalog harga Harvy;
- `unpriced`: harga atau usage belum cukup;
- `estimated`: token diperkirakan karena provider tidak mengirim usage;
- `pending`: provider mungkin telah menerima request, tetapi biaya belum dapat
  dipastikan;
- `adjusted`: biaya provider dan perhitungan katalog berbeda.

Attempt lama tanpa snapshot harga tidak direkonsiliasi diam-diam. Jika usage
tersedia dan model mempunyai tarif aktif sekarang, laporan membentuk estimasi
read-only `current_catalog_estimate`. Console menampilkannya dengan tanda `≈`
dan keterangan jumlah attempt lama yang diestimasi; mengganti tarif aktif dapat
mengubah estimasi ini, tetapi tidak mengubah biaya efektif yang tersimpan.

Tampilan operator memakai empat keadaan cakupan: tercatat penuh, mengandung
estimasi, sebagian tertunda, atau belum dapat dihitung. “Harga belum tersedia”
berarti operator perlu mengisi katalog. “Menunggu data provider” berarti harga
saja tidak cukup karena usage belum ada. Grup tanpa attempt menampilkan “Belum
ada penggunaan”, bukan status biaya palsu. Enum ledger internal tetap tersedia
untuk audit/API kompatibel, tetapi tidak ditampilkan sebagai harga mentah dan
tidak pernah diubah menjadi US$0.

Dashboard dan ekspor membaca seluruh ledger yang cocok. Batas 250/1.000/10.000
hanya membatasi baris tabel API, bukan total. Retensi tetap dapat menghapus data
lama sesuai kebijakan; total di luar jendela retensi memang tidak tersedia.

Ledger entitlement terpisah dari ledger provider. `reply`, `session`, dan
`group-reply` hanya menjadi kandidat debit saat model berhasil. Debit baru
ditulis setelah adapter memastikan balasannya berhasil dikirim; kegagalan
delivery, balasan kosong/diganti, dan keluaran `schema_rejected` tidak
mengurangi paket. `due-date`, boundary, understanding, triase, review,
ringkasan, insight, serta planner/revalidasi `group-participation` dicatat
sebagai overhead termasuk. Semua request keselamatan dicatat tetapi tidak
mendebit kapasitas. Settlement tetap idempoten per `requestId`, dan gerbang
kuota 24 jam membaca debit delivery ini sebagai sumber otoritas—bukan sekadar
provider success.

Pada grup, penggunaan dikaitkan dengan principal pseudonim anggota yang memicu
giliran; PN dan LID dapat digabung ketika satu pesan membuktikan keduanya.
Attempt tanpa pemicu anggota masuk bucket `shared`. Jumlah seluruh bucket
anggota+shared sama dengan total grup. Breakdown ini hanya untuk operator,
bukan admin/pembayar grup. Ketika anggota memakai kontrol “lupakan tentang
aku”, alias PN/LID, principal mapping, dan detail attempt provider miliknya
ikut dihapus. Entitlement ruang tetap agregat dan tidak menjadi profil anggota.

## Berkas dan retensi

Konfigurasi bawaan:

| Data | Berkas | Isi |
|---|---|---|
| Control plane | `data/control-plane.json` | installation key, paket, harga, enrollment, principal pseudonim, audit |
| Provider ledger | `data/usage-ledger.json` | metadata attempt dan biaya tanpa prompt/balasan |
| Entitlement ledger | `data/entitlement-ledger.json` | debit/overhead/safety per logical request |
| Product telemetry | `data/telemetry.json` | usage logical dan event produk lama/aktif |

Harvy juga membuat `<CONTROL_PLANE_FILE>.runtime.lock`. Isinya hanya versi,
PID, token acak, peran proses, dan waktu mulai—tanpa identitas atau isi chat.
Runtime, probe, dan evaluator memakai lock yang sama agar dua cache repository
JSON tidak saling menimpa. Proses kedua berhenti dengan `LOCAL_DATA_LOCKED`.
Pada format console `pretty`, kode aman itu ditampilkan langsung bersama
fingerprint; isi pesan error bebas tetap tidak dicetak. `Ctrl+C` dan reload dari
`npm run dev` meminta shutdown normal dan menunggu lock dilepas setelah antrean
selesai dikuras. Setelah crash atau penghentian paksa, lock sengaja tidak
dibersihkan otomatis: pastikan PID di berkas sudah mati, baru hapus lock itu
secara manual. Jangan menghapusnya hanya karena proses kedua ingin cepat
berjalan.

Ketiganya ditulis atomik tetapi hanya aman untuk satu proses. Provider dan
entitlement ledger mengikuti `USAGE_LEDGER_RETENTION_DAYS` (bawaan 90 hari).
Product telemetry mengikuti `TELEMETRY_RETENTION_DAYS`. Penghapusan data Harvy
ikut menghapus subject dari kedua ledger dan control plane.

Telemetry v1 dimigrasikan atomik menjadi v2 saat dibaca. Record lama tetap
telemetry produk dan mempertahankan semantik debit historis; ia tidak diberi
provider/origin/attempt palsu. Karena itu total provider sebelum pemasangan
ledger detail tidak dapat direkonstruksi.

### Backup dan pemulihan lokal

1. Hentikan Harvy secara normal agar antrean telemetry dan ledger selesai.
2. Salin seluruh folder `data/` ke media yang aksesnya dibatasi. Berkas control
   plane mengandung installation key; kehilangannya memutus kemampuan
   merekonsiliasi subject/principal lama.
3. Uji restore di folder terpisah dengan konfigurasi file yang diarahkan ke
   salinan. Jangan menyalakan dua proses pada berkas yang sama; lock akan
   menolak evaluator/probe bila runtime masih aktif.
4. Setelah restore, cocokkan jumlah enrollment, versi harga, total attempt,
   total entitlement, dan audit terakhir sebelum membuka kanal.

Rollback kode boleh memakai berkas hasil backup, tetapi jangan menurunkan
schema dengan mengedit JSON manual. Bila binary lama tidak mengenali schema,
kembalikan seluruh snapshot aplikasi+data yang sepasang.

## Boundary keamanan lokal

Server menolak bind selain `127.0.0.1`, remote non-loopback, Host dan Origin
yang salah, mutasi tanpa CSRF, content type non-JSON, field tak dikenal, body di
atas 64 KiB, versi stale tanpa `If-Match`, dan rate berlebih. CSP menolak inline
script, framing, object, serta koneksi lintas origin. Tidak ada CORS. Mutasi
berhasil, ditolak, atau gagal masuk audit dengan session reference pseudonim.

Boundary ini tidak menjadikan server aman untuk internet. Jangan membuka port,
memasang tunnel publik, atau sekadar menaruh reverse proxy/domain di depannya.

## Gerbang transisi ke VPS/domain

Console baru boleh dipisahkan atau dipublikasikan setelah seluruh berikut ada:

1. PostgreSQL untuk enrollment, katalog berversi, principal alias, attempt,
   entitlement, audit, dan idempotency key; transaksi dan unique constraint
   menggantikan mutex file satu proses.
2. Migrasi terukur dengan checksum/count/cost reconciliation, backup sebelum
   cutover, rehearsal restore, dual-read atau shadow comparison, dan rollback
   yang sudah diuji.
3. OIDC dengan MFA, RBAC least privilege, session revocation, rotasi secret,
   TLS, CSRF/Origin allowlist sesuai domain admin, serta domain admin terpisah
   dari web pengguna.
4. Audit append-only dengan retensi yang ditetapkan, alert untuk gap writer,
   attempt `started` yang menggantung, lonjakan fallback, biaya `unpriced`, dan
   selisih provider versus katalog.
5. Outbox/idempotent consumer untuk pemisahan proses, serta rekonsiliasi
   invoice/generation provider. Request yang timeout tidak boleh otomatis
   dianggap berbiaya nol.
6. Secret manager, backup terenkripsi, disaster-recovery drill, monitoring,
   rate limit terdistribusi, dan prosedur incident response.
7. Threat-model review dan uji penetrasi boundary operator. Console produksi
   tidak boleh memakai token bersama tunggal.
8. Payment ledger terpisah dan integrasi checkout/webhook hanya setelah paket,
   hak refund, renewal, pajak, dan dukungan telah diputuskan eksplisit.

Sebelum delapan gerbang itu lulus, Console tetap alat localhost untuk pemilik
produk. Harvy Web sebagai kanal pengguna adalah produk berbeda dan masih belum
ada.
