# ADR-010 — Log operasional produksi yang terpisah dan minim data

- **Status:** Diterima
- **Tanggal:** 29 Juli 2026

## Konteks

Runtime Harvy sebelumnya memakai `console.*` pada batas error yang berbeda.
Keluaran itu tidak persisten, tidak mempunyai schema, tidak dapat menghubungkan
satu tahap dengan tahap lain, dan tidak menjamin error latar ikut terlihat.
Lebih buruk lagi, logger bawaan Baileys mencetak object protokol mentah pada
level info. Pada koneksi WhatsApp nyata, keluaran itu memuat payload history
terenkripsi, media key, dan direct path walaupun Harvy sendiri menolak impor
riwayat chat.

Harvy sudah mempunyai telemetry bertipe tertutup untuk token, biaya, dan event
produk. Telemetry itu terikat pemilik, ikut ekspor/penghapusan, serta dipakai
untuk batas pemakaian. Menjadikannya tempat error runtime akan mencampur dua
tujuan, memperluas data pengguna, dan membuat format whole-file JSON tumbuh
sebagai log.

Permintaan untuk mencatat “apa pun yang terjadi” ditafsirkan sebagai cakupan
kejadian teknis, bukan izin menyimpan isi kehidupan pengguna. Konstitusi
mewajibkan minimisasi data, tujuan yang jelas, retensi terbatas, dan
pemberitahuan.

## Keputusan

### 1. Log operasional terpisah dari telemetry

Harvy mempunyai sink NDJSON append-only sendiri di `data/logs/`. Satu record
memakai schema `harvy.operational-log.v1` dan membawa:

- timestamp UTC, level, service, release, environment, run ID, sequence, PID,
  dan hostname;
- komponen dan nama event stabil;
- trace acak, kanal, operasi, serta alias akun operasional non-telepon bila
  relevan;
- scalar teknis seperti jumlah, durasi, percobaan, status, dan kode; serta
- error ternormalisasi berisi jenis, kode/status yang mengikuti format aman,
  frame stack terbatas tanpa baris pesan, cause terbatas dengan aturan yang
  sama, dan fingerprint.

Telemetry pengguna tetap menyimpan usage/event bertipe tertutup. Log
operasional tidak dipakai untuk kuota, ekspor data, atau analitik perilaku.

### 2. Isi dan identitas dilarang masuk log

Logger menyaring record sebelum menulis ke file **dan** console. Yang tidak
boleh dicatat meliputi:

- isi chat, prompt, balasan model, ringkasan, history, caption, nama grup, dan
  nama tampilan;
- owner/chat/group/participant/message/task/session ID, JID, serta nomor
  telepon;
- QR, pairing code, token, API key, cookie, auth state, credentials, signal
  key, media key, direct path, dan object request/response mentah;
- inferensi mental, label risiko seseorang, atau profil kepribadian.

Deskripsi bebas yang diberikan call site tidak dipersistenkan; nama event
stabil menjadi deskripsi yang dapat dicari. Data event memakai **allowlist
scalar tertutup**. Key sensitif disensor,
identifier diganti penanda `[PRIVATE_IDENTIFIER]`, alias akun hanya diterima
bila diawali huruf dan berisi karakter operasional yang dibatasi, pola
secret/JID/nomor/base64 disaring, sedangkan object/array/binary dan field tak
dikenal dibuang. `Error.message` dan thrown string bebas tidak pernah disimpan:
kalimat biasa tidak dapat dibedakan secara aman dari isi percakapan. Tiap
record dibatasi 32 KiB. Trace adalah UUID acak per ingress; ia tidak merupakan
hash identitas dan tidak stabil lintas proses.

Call site tidak boleh menyerahkan update Telegram, `WAMessage`, node Baileys,
konfigurasi, request, response, atau payload model mentah kepada logger.

### 3. Level dan korelasi

- `info`: lifecycle aplikasi, perubahan status akun, hasil satu giliran tanpa
  isi, delivery terjadwal, retensi, dan pemakaian model.
- `warn`: fallback yang pulih, parse keluaran model yang gagal, gangguan
  kosmetik, retensi opsional, atau antrean tertekan.
- `error`: operasi, penyimpanan, jaringan, delivery, atau pipeline yang gagal.
- `fatal`: kegagalan proses, bootstrap, dan shutdown paksa.
- `debug`/`trace`: detail state machine tanpa isi; mati pada level produksi
  bawaan.

`AsyncLocalStorage` mempertahankan trace Telegram/WhatsApp melewati promise,
timer batch, FIFO, panggilan model, dan pengiriman. Log tidak memakai ID
pengguna sebagai kunci korelasi.

### 4. File berbatas dan kegagalan yang terkontrol

File bernama `harvy-YYYYMMDD-NNNN.ndjson`. Writer:

- menulis berurutan lewat antrean tanpa menahan jalur chat;
- merotasi pada pergantian hari UTC atau batas ukuran tanpa rename file aktif,
  supaya aman di Windows;
- membersihkan segmen menurut tanggal UTC pada nama file—bukan `mtime` yang
  dapat berubah saat copy/restore—dan batas total disk, hanya untuk nama file
  Harvy yang cocok;
- menyerialkan append, rotasi, maintenance, dan close lewat satu mutex I/O;
- memotong fragmen crash sampai newline valid terakhir—atau menambahkan
  newline bila record schema v1 sebenarnya lengkap—sebelum append berikutnya;
- memakai antrean berbatas record dan byte; record prioritas rendah dibuang
  lebih dulu dan jumlah yang dibuang dicatat;
- mempertahankan `warn`/`error` sejauh kapasitas memungkinkan dan memakai
  append sinkron sebagai jalur darurat; jalur ini tetap tunduk pada batas
  segmen/total dan mulai menghitung drop bila error storm menghabiskan ruang;
- mencoba permission `0700` untuk folder dan `0600` untuk file pada platform
  yang mendukungnya; ACL Windows tetap tanggung jawab deployment.

Bawaan saat ini adalah 25 MiB per segmen, 250 MiB total, retensi 14 hari,
10.000 record/8 MiB antrean, dan level `info`. Semuanya dapat dikonfigurasi
lewat environment.

`LOG_FILE_REQUIRED=false` membuat gangguan sink tidak mematikan percakapan:
Harvy beralih ke `stderr` yang sudah disaring—meski `LOG_CONSOLE=false`—dan
menandai health sebagai degraded. Deployment yang mewajibkan audit file dapat memakai
`LOG_FILE_REQUIRED=true` agar kegagalan sink **atau retensi awal** menghentikan
proses. Health membedakan kesehatan tulis dan retensi; keberhasilan append tidak
menyembunyikan retensi yang masih gagal.

Console tidak mempunyai antrean internal kedua milik Harvy. Ketika
`Writable.write()` memberi sinyal backpressure, logger berhenti menambah record
ke stream itu sampai event `drain`, menghitung record console yang dilewati,
serta menulis onset/recovery ke sink file. Ini mencegah buffer proses tumbuh
tanpa batas ketika collector tersendat.

### 5. Lifecycle, crash, dan dependency

Shutdown mencatat permintaan dan hasil, menghentikan ingress, menguras worker,
pipeline, serta telemetry, lalu menguras logger **paling akhir**. Timeout 60
detik melakukan append fatal sinkron sebelum proses dipaksa berhenti.

Handler eksplisit `uncaughtException` dan `unhandledRejection` mencatat metadata
fatal secara sinkron lalu menghentikan proses dengan status 1. Dengan begitu
Node tidak mencetak stack mentah ke collector dan Harvy tidak mencoba
melanjutkan state proses yang mungkin korup. Runtime warning juga dicatat.
Supervisor eksternal tetap diperlukan untuk restart dan alerting produksi.

Baileys menerima adapter logger struktural milik Harvy. Log info/debug bawaan
Baileys dibuang; warning/error hanya dipetakan ke kategori dan scalar teknis
yang dikenal. Restart protokol `515` setelah pairing dicatat sebagai lifecycle
normal, bukan kegagalan fatal. QR dan pairing code memakai keluaran terminal
operator khusus yang tidak melewati logger, hanya ketika stdout benar-benar TTY
dan `APP_ENV` bukan `production`. Production tidak menampilkan secret pairing
ke stdout; auth harus diprovisikan lewat prosedur operator aman.

## Konsekuensi

- Error yang sebelumnya hanya terlihat sesaat kini dapat dicari menurut waktu,
  event, komponen, trace, durasi, dan fingerprint tanpa membaca percakapan.
- Log dapat tetap kehilangan record ketika disk sangat lambat, antrean penuh,
  atau error storm mencapai cap file. Kehilangan itu dihitung dan berbatas,
  bukan pertumbuhan RAM/file tanpa batas.
- File lokal ini masih solusi satu proses. Ia belum merupakan audit trail
  immutable, metrics store, alerting, SIEM, atau collector terpusat. Produksi
  multi-instance kelak perlu mengirim JSON stdout/file ke collector dengan
  enkripsi, kontrol akses, alert, dan kebijakan backup tersendiri.
- `LOG_RETENTION_DAYS` hanya dapat menegakkan retensi file lokal. Bila JSON
  console dikumpulkan Docker, systemd, atau layanan cloud, retensinya mengikuti
  kebijakan collector yang terpisah dan wajib dikonfigurasi operator secara
  eksplisit.
- Karena log sengaja tidak membawa identitas yang dapat menghubungkannya ke
  pengguna/grup, penghapusan data pengguna tidak mencoba mencari record log.
  Kebijakan ini wajib tetap dijelaskan pada onboarding dan notice grup.
