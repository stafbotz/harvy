# Uji kanal nyata lokal

Jalur ini memakai identitas uji sungguhan untuk berbicara dengan build Harvy
terbaru. Ia bukan pengganti dogfood tujuh hari dan tidak membuat klaim
production-ready.

## Batas aman

- Pakai satu bot Telegram khusus uji, satu akun pengguna Telegram khusus uji,
  dan dua nomor WhatsApp nonkritis yang berbeda untuk peran `harvy` dan
  `tester`.
- Jangan menaruh token, `api_hash`, nomor, JID, OTP, QR, atau session string di
  chat, `.env`, dokumentasi, issue, maupun Git.
- Pairing dilakukan dari Harvy Console yang bind ke `127.0.0.1`. Credential
  Telegram disimpan terenkripsi di `secrets/`; sesi linked-device WhatsApp berada di
  `data/whatsapp-auth/live-acceptance/`. Keduanya diabaikan Git.
- QR hanya berada di memori proses selama pairing dan disajikan sebagai SVG ke
  sesi Console terautentikasi. API status tidak membawa QR, token, session,
  nomor, JID, atau identitas akun. Browser juga tidak dapat membaca kembali
  secret yang sudah disimpan.
- Hentikan proses lain yang memakai bot atau akun WhatsApp uji yang sama.
  Satu identitas transport yang dipakai dua runtime dapat mengalami konflik.
- Credential kanal utama dan acceptance berbeda. `TELEGRAM_BOT_TOKEN` serta
  akun pada `WHATSAPP_ACCOUNTS` mendeklarasikan produk utama; acceptance memakai
  bot Telegram uji, session Telegram tester, serta folder WhatsApp `harvy` dan
  `tester` sendiri. Jangan memasangkan identitas utama sebagai identitas
  acceptance. Console hanya menampilkan ringkasan aman konfigurasi utama agar
  boundary ini terlihat dan tidak pernah menyalin credential-nya.
- Runtime acceptance memakai konfigurasi model dari `.env`, sehingga isi
  skenario uji tetap dikirim ke provider AI yang dikonfigurasi. State produk,
  log, ledger, memori, task, sesi, dan AgentRun dibuat di direktori sementara;
  capability coding, GitHub, Console, pembayaran, dan GroupAgentRun dipaksa
  mati pada baseline ini.

## Pairing dan pengelolaan session melalui Console

Telegram membutuhkan `api_id` dan `api_hash` aplikasi milik operator dari
`https://my.telegram.org/apps`, serta token bot uji dari BotFather. Mulai
Console setup tanpa membutuhkan `TELEGRAM_BOT_TOKEN` pada bootstrap:

```powershell
npm run console:setup
```

Command menampilkan URL localhost dan token operator satu kali bila
`HARVY_CONSOLE_TOKEN` belum dikonfigurasi. Buka tab **Kanal pengujian**, lalu:

1. verifikasi dan simpan token bot Telegram uji;
2. masukkan `api_id` serta `api_hash`, mulai pairing akun Telegram tester, lalu
   pindai QR; bila akun memakai 2FA, form password muncul setelah scan dan
   nilainya tidak disimpan;
3. pasangkan WhatsApp A sebagai `harvy`;
4. pasangkan WhatsApp B sebagai `tester`.

Pada Baileys 7, pairing QR yang sah dapat menyimpan material `pair-success`
lengkap sementara flag kompatibilitas `registered` tetap `false`. Console dan
runner menilai kesiapan dari identitas serta material pair-success
kriptografis yang lengkap, bukan dari flag itu saja. State `me`-only tetap
dianggap parsial. Jika scan sudah selesai tetapi Console lama masih menampilkan
`Belum dipasangkan`, restart proses Console setelah memperbarui build; jangan
scan ulang atau menghapus session lebih dulu.

Status `Dikonfigurasi` pada Telegram utama berarti token tersedia di
environment. Status jumlah akun WhatsApp utama berarti deklarasi config dapat
dibaca. Keduanya tidak membuktikan linked session aktif; kesiapan acceptance
ditunjukkan terpisah oleh checklist empat credential uji.

Jika runtime Harvy dengan Console sudah aktif, gunakan tab Kanal pengujian pada
Console itu dan jangan menjalankan `console:setup` kedua. Console pairing
memegang satu lock lintas proses untuk seluruh credential live-acceptance,
sehingga instance kedua gagal tertutup meskipun memakai port berbeda.

Console menolak bila kedua peran WhatsApp berakhir pada identitas yang sama.
Pairing ulang Telegram baru menimpa session lama setelah login baru berhasil.
Untuk pencabutan, Console mencoba logout ke Telegram atau WhatsApp lebih dulu;
bila koneksi platform gagal, credential lokal dipertahankan agar tidak
menciptakan linked session yang tampak sudah dicabut padahal belum.

Alias command lama `setup:telegram-tester`, `setup:whatsapp-harvy`, dan
`setup:whatsapp-tester` sekarang membuka Console yang sama; tidak ada lagi QR
acceptance yang dirender oleh script prompt terminal.

## Menjalankan acceptance privat

Tutup Console pairing sebelum memulai runner. Runner Telegram maupun WhatsApp
memegang lock credential yang sama selama seluruh acceptance, sehingga pairing,
revoke, dan acceptance tidak dapat memutasi session secara bersamaan.

Telegram tetap meminta dua acknowledgement eksplisit sebelum mengirim pesan
nyata:

```powershell
$env:HARVY_TELEGRAM_PRIVATE_ACCEPTANCE_CONFIRM = "RUN_NONCRITICAL_TELEGRAM_PRIVATE"
$env:HARVY_TELEGRAM_PRIVATE_ACCEPTANCE_ACCOUNT = "DEDICATED_TEST_ACCOUNT"
npm run acceptance:telegram-private
Remove-Item Env:HARVY_TELEGRAM_PRIVATE_ACCEPTANCE_CONFIRM
Remove-Item Env:HARVY_TELEGRAM_PRIVATE_ACCEPTANCE_ACCOUNT
```

Runner Telegram menyalakan build terisolasi dan memeriksa consent/menu,
task+reminder, timezone, sesi+check-in, consent memori, safety, Agent Runtime,
ekspor data, dan penghapusan data. Semua tahap tetap bergantung pada respons
live sehingga kegagalan provider, transport, tombol, atau perilaku produk akan
terlihat sebagai kegagalan tahap, bukan diganti fixture. Tahap planning meminta
tepat tiga langkah dengan Tindakan, Bukti yang dikumpulkan, dan Kriteria lulus;
evaluator menolak respons yang sekadar ada tetapi tidak dapat dijalankan. Ia
juga mengharuskan tepat satu Run Anchor yang diedit in-place, dipin saat aktif,
dan dilepas pada terminal.

WhatsApp privat memakai dua folder auth fixed yang sudah dipasangkan dan
menurunkan JID secara lokal; operator tidak perlu menyalin nomor atau JID ke
environment:

```powershell
npm run acceptance:whatsapp-private:managed
```

Runner menyalakan akun Harvy, menjalankan akun tester melalui harness live yang
ada, menghentikan runtime dengan drain, lalu membuang state produk sementara.
Launcher menunggu account WhatsApp A benar-benar berstatus `open`; IPC kontrol
proses saja bukan readiness kanal. Ia memuat runtime `tsx` melalui URL absolut
walau cwd produk terisolasi, mengirim ke identitas LID bila tersedia, dan
mencocokkan balasan melalui seluruh pasangan PN/LID credential A. Evaluator
menunggu burst multi-bubble sampai quiet gap sebelum membaca hasil atau
mengirim command berikutnya. Receipt gagal tetap membawa status dan subcommand
yang sudah dijalankan, ack transport, serta counter lifecycle allowlist tanpa
identifier. Tahap pertama yang gagal menghentikan skenario berikutnya agar
respons tertunda tidak salah dinilai sebagai bukti prompt lain; full data
cleanup tetap berjalan di `finally`. Direct output Signal dibuang sebelum
socket tester dibuka. Parent
memberi 75 detik untuk grace shutdown child 60 detik dan mengulang penghapusan
root sementara secara bounded bila Windows masih melepas file handle. Planning
memakai evaluator kegunaan dan kontrak Run Anchor yang sama dengan Telegram;
transient progress boleh menjadi surface terpisah hanya bila akhirnya dibuang.
Karena linked device dapat menerima edit sebelum event create, evaluator boleh
menemukan anchor dari create atau edit, tetapi seluruh status harus menunjuk ID
bubble yang sama, maksimal satu create anchor boleh terlihat, dan anchor tetap
wajib diedit, dipin, dilepas dari pin, serta tidak diganti melalui delete.

Probe read-only percakapan dapat dijalankan tanpa consent, task, atau cleanup
produk:

```powershell
$env:HARVY_WHATSAPP_PRIVATE_MANAGED_MODE = "probe"
npm run acceptance:whatsapp-private:managed
Remove-Item Env:HARVY_WHATSAPP_PRIVATE_MANAGED_MODE
```
Kedua acceptance berusaha menghapus data tester lewat kontrol produk. Riwayat
chat yang disimpan Telegram atau WhatsApp sendiri tidak ikut dihapus oleh
kontrol data Harvy.

## Baseline terverifikasi 23 Agustus 2026

- Telegram privat latest build lulus 8/8 tahap lewat akun tester MTProto nyata.
  Planning lulus dalam sekitar 22 detik dengan dua bubble durable yang terlihat:
  satu Anchor mutable dan satu hasil; kualitas langkah/aksi/bukti/kriteria adalah
  3/3/3. Runtime berhenti bersih dan cleanup produk lulus.
- WhatsApp privat managed latest build lulus 10/10 tahap lewat nomor tester B
  menuju nomor Harvy uji A. Harness melihat 17 ingress `notify`, 29/29 delivery
  berhasil, ack tertinggi `delivered`, tanpa pipeline/delivery failure. Planning
  lulus dalam sekitar 19 detik; satu Anchor dipin/diedit/dilepas, satu transient
  surface dihapus, dan hasil akhir dikirim terpisah. Runtime berhenti bersih dan
  isolated product state terhapus.

Angka ini adalah receipt satu run baseline dan tidak boleh dipromosikan menjadi
SLA, reliabilitas tujuh hari, atau bukti reconnect/crash recovery.

## Yang belum dibuktikan oleh baseline

Baseline privat sudah membuktikan onboarding multi-bubble, tetapi belum
membuktikan interupsi di tengah burst, CodingRun/GitHub live, reminder atau check-in
yang benar-benar jatuh tempo setelah crash, konflik multi-instance, maupun
dogfood tujuh hari. WhatsApp grup tetap memakai
`npm run acceptance:whatsapp` dan prasyarat grup disposable pada
`deploy/whatsapp/README.md`; pairing dua nomor di atas tidak otomatis membuat
atau memutasi grup.

Receipt hanya berisi allowlist nama tahap, durasi, status, digest, counter
transport/lifecycle, topologi surface, dan skor kualitas content-free. Isi
pesan, identifier akun, credential, serta path auth tidak boleh muncul. Simpan
bukti live ke dokumentasi hanya setelah output ditinjau dan dibersihkan.
