# Uji kanal nyata lokal

Jalur ini memakai identitas uji sungguhan untuk berbicara dengan build Harvy
terbaru. Ia bukan pengganti dogfood tujuh hari dan tidak membuat klaim
production-ready.

## Batas aman

- Pakai satu bot Telegram khusus uji, satu akun pengguna Telegram khusus uji,
  dan dua nomor WhatsApp nonkritis yang berbeda untuk peran `harvy` dan
  `tester`.
- Jangan menaruh token, `api_hash`, nomor, JID, OTP, QR, atau session string di
  chat, dokumentasi, issue, maupun Git. Token utama hanya boleh masuk form
  Console lokal; `.env` hanya didukung sementara sebagai sumber migrasi legacy.
- Pairing dilakukan dari Harvy Console yang bind ke `127.0.0.1`. Credential
  Telegram disimpan terenkripsi di `secrets/`; sesi linked-device WhatsApp berada di
  `data/whatsapp-auth/live-acceptance/`. Keduanya diabaikan Git.
- QR hanya berada di memori proses selama pairing dan disajikan sebagai SVG ke
  sesi Console terautentikasi. API status tidak membawa QR, token, session,
  nomor, JID, atau identitas akun. Browser juga tidak dapat membaca kembali
  secret yang sudah disimpan.
- Hentikan proses lain yang memakai bot atau akun WhatsApp uji yang sama.
  Satu identitas transport yang dipakai dua runtime dapat mengalami konflik.
- Credential kanal utama dan acceptance berbeda. Token bot utama dikelola
  store terenkripsi Console, sedangkan akun pada `WHATSAPP_ACCOUNTS` masih
  mendeklarasikan produk utama. Acceptance memakai bot Telegram uji, session
  Telegram tester, serta folder WhatsApp `harvy` dan `tester` sendiri. Jangan
  memasangkan identitas utama sebagai identitas acceptance. Console menolak
  token bot yang sama dan tidak pernah menyalin credential antar-store.
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
`HARVY_CONSOLE_TOKEN` belum dikonfigurasi. Buka tab **Kanal**, lalu:

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
dianggap parsial. Console current build kemudian melakukan handshake live,
bukan hanya membaca `creds.json`: `Sesi valid` berarti WhatsApp menerima
credential saat pemeriksaan terbaru, `Sesi ditolak` berarti credential lokal
masih ada tetapi platform menolaknya, dan `Belum terverifikasi` berarti jaringan
tidak memberi bukti. Jika scan sudah selesai tetapi Console lama masih memakai
copy status sebelum kontrak ini, restart proses Console setelah memperbarui
build; jangan scan ulang atau menghapus session lebih dulu.

Status Telegram utama membedakan belum ada credential, masih berasal dari
environment legacy, tersimpan terenkripsi, valid, konflik sumber, dan perlu
restart. Nilai token tidak dikirim ke browser. Status jumlah akun WhatsApp
utama tetap hanya berarti deklarasi config dapat dibaca. Keduanya tidak
membuktikan delivery; kesiapan acceptance ditunjukkan terpisah oleh checklist
empat credential uji.

Jika runtime Harvy dengan Console sudah aktif, gunakan tab Kanal pada
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
task+reminder, timezone, sesi+check-in, auto-memory implicit setelah onboarding
tanpa consent/tombol per-item beserta recall `/memori`, safety, Agent Runtime,
ekspor data, dan penghapusan data. Semua tahap tetap bergantung pada respons
live sehingga kegagalan provider, transport, tombol, atau perilaku produk akan
terlihat sebagai kegagalan tahap, bukan diganti fixture. Tahap planning meminta
tepat tiga langkah dengan Tindakan, Bukti yang dikumpulkan, dan Kriteria lulus;
evaluator menolak respons yang sekadar ada tetapi tidak dapat dijalankan. Ia
juga mengharuskan tepat satu Run Anchor yang diedit in-place, dipin saat aktif,
dan dilepas pada terminal.

Saat mendiagnosis kontrak auto-memory tanpa membiarkan timeout stage lain
mencemari respons yang diamati, runner dapat dibatasi pada onboarding,
candidate implicit+recall, dan cleanup:

```powershell
$env:HARVY_TELEGRAM_PRIVATE_ACCEPTANCE_FOCUS = "memory"
npm run acceptance:telegram-private
Remove-Item Env:HARVY_TELEGRAM_PRIVATE_ACCEPTANCE_FOCUS
```

Dua acknowledgement akun nonkritis di atas tetap wajib. Focus ini adalah bukti
terarah, bukan pengganti rerun full.

Recovery proses dapat diuji terpisah. Runner mengirim `/menu`, mematikan child
runtime dengan fault acceptance satu kali, menunggu child kedua dan kanal siap,
lalu mengirim `/menu` lagi:

```powershell
npm run acceptance:telegram-private:restart
```

WhatsApp privat memakai dua folder auth fixed yang sudah dipasangkan dan
menurunkan JID secara lokal; operator tidak perlu menyalin nomor atau JID ke
environment:

```powershell
npm run acceptance:whatsapp-private:managed
```

Runner menyalakan akun Harvy, menjalankan akun tester melalui harness live yang
ada, menghentikan runtime dengan drain, lalu membuang state produk sementara.
Salah satu tahap mengirim preferensi personal tanpa perintah ingat, menolak
prompt consent per-item, lalu membuka `/memori` untuk membuktikan item hasil
commit dapat dibaca kembali.
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

Recovery akun Harvy A sesudah crash child memakai dua probe nyata dari tester B:

```powershell
npm run acceptance:whatsapp-private:restart
```

Acceptance grup dua-akun membuat grup disposable, menjalankan scope nonkritis,
lalu mengeluarkan Harvy A, membuat tester B keluar, dan membuang state produk
terisolasi bahkan saat stage gagal:

```powershell
npm run acceptance:whatsapp-group:managed
```

Scope ini memutasi WhatsApp sungguhan dan hanya boleh memakai kedua akun uji.
Ia belum menggantikan matriks yang membutuhkan peserta manusia kedua atau
Workspace coding yang sudah diprovisioning.
Kedua acceptance berusaha menghapus data tester lewat kontrol produk. Riwayat
chat yang disimpan Telegram atau WhatsApp sendiri tidak ikut dihapus oleh
kontrol data Harvy.

## Menjalankan eksplorasi privat adaptif

Runner eksploratif dipakai untuk percakapan yang dikendalikan operator, bukan
matriks pass/fail dengan jawaban Harvy yang sudah ditentukan. Operator masuk
melalui akun Telegram tester atau WhatsApp B, membaca respons live, lalu memilih
pesan berikutnya berdasarkan respons tersebut. Semua schema tertutup; field
`expected` atau field asing lain selalu ditolak.

```powershell
$env:HARVY_LIVE_EXPLORATION_CONFIRM = "RUN_NONCRITICAL_LIVE_EXPLORATION"
$env:HARVY_LIVE_EXPLORATION_ACCOUNT = "DEDICATED_TEST_ACCOUNT"

npm run explore:telegram -- --journey=tg-owner-YYYYMMDD --mode=full
# atau, pada proses terpisah:
npm run explore:whatsapp -- --journey=wa-defect-YYYYMMDD --mode=focused
```

`--mode=full` adalah journey metodologi lengkap. `--mode=focused` adalah rerun
terarah sesudah defect live dan boleh selesai tanpa mengklaim seluruh cakupan.
Mode dikunci pada journey ketika evidence versi 3 pertama ditulis; resume dengan
mode berbeda ditolak. Journey lama yang hanya mempunyai evidence versi 1/2
boleh dilanjutkan sebagai `focused`, tetapi full baru wajib memakai journey baru
agar coverage lama tidak dikarang.

Setiap baris stdin adalah satu object JSON berikut. Tidak ada field opsional
selain dua field penghapusan pada `stop`:

```jsonl
{"type":"send","text":"Bantu aku menyusun rencana peluncuran yang realistis."}
{"type":"reply","surface":"surface-2","text":"Yang ini merujuk risiko vendor."}
{"type":"click","surface":"surface-1","label":"Okei, mulai."}
{"type":"burst","messages":["Ada koreksi kecil.","Deadline-nya Jumat.","Anggarannya tetap."],"gapMs":800}
{"type":"interrupt","text":"Tunggu—prioritaskan risiko legal dulu."}
{"type":"settle"}
{"type":"wait","ms":30000}
{"type":"restart"}
{"type":"mark","markers":["real-task","correction","topic-shift","context-return","task-completed"]}
{"type":"status"}
{"type":"assess","scores":{"usefulness":4,"naturalness":4,"initiative":3,"nonRepetition":4,"uiClarity":4,"contextCoherence":5,"correctionHandling":5},"completion":"completed","defects":["generic-output"]}
{"type":"stop"}
{"type":"stop","deleteJourney":true,"confirmation":"DELETE_EXPLORATION_JOURNEY"}
```

`click` hanya tersedia di Telegram. `burst` menerima 2–8 pesan dengan `gapMs`
0–15.000; pesan biasa dibatasi 3.500 karakter. `wait` menerima 100–300.000 ms.
Setelah `send`, `reply`, `click`, atau `burst` berhasil, turn menjadi aktif dan
command pengiriman biasa berikutnya ditolak. Operator harus memilih salah satu:

- kirim `interrupt` saat respons masih berjalan untuk membuat batas koreksi
  eksplisit dan turn baru; isi koreksi hanya disimpan sebagai digest turn;
- setelah respons selesai terlihat, kirim `settle`; runner melakukan
  flush+drain observer, mencatat boundary content-free, lalu menutup turn.

`interrupt` ditolak bila tidak ada turn aktif. `settle`, `wait`, `restart`,
`mark`, `assess`, dan `stop` juga gagal tertutup bila urutan turn tidak sesuai;
`status` tetap dapat dipakai untuk melihat `activeTurn`. Jangan memakai waktu
diam atau arrival bubble sebagai pengganti handshake `settle`.

Coverage berikut tersimpan sebagai marker closed-set tanpa isi percakapan:

| Marker | Sumber |
|---|---|
| `multi-bubble` | otomatis setelah `burst` lengkap berhasil |
| `pause` | otomatis setelah `wait` minimal 30.000 ms dalam keadaan idle |
| `re-entry` | otomatis ketika journey dengan mode sama kembali `ready` setelah ada run sebelumnya yang juga pernah `ready`; startup gagal saja tidak cukup |
| `restart` | otomatis setelah satu restart runtime berhasil; informatif, bukan syarat completion full |
| `real-task`, `correction`, `topic-shift`, `context-return`, `task-completed` | post-hoc manual melalui `mark`, hanya setelah operator benar-benar mengamatinya |

Completion `completed` pada mode full ditolak sampai delapan marker
`real-task`, `correction`, `topic-shift`, `multi-bubble`, `pause`, `re-entry`,
`context-return`, dan `task-completed` lengkap lintas run journey yang sama.
Marker subjektif tidak pernah diturunkan dari kata kunci pesan; bahkan
`interrupt` tetap memerlukan `mark correction` post-hoc. Mode focused boleh
memakai `completed` untuk menyatakan scope defect terarah selesai, bukan
acceptance full.

Skor assessment memakai integer 1–5. Gunakan 1 untuk gagal/mengganggu, 3 untuk
cukup tetapi membutuhkan koreksi atau kerja operator material, dan 5 untuk
sangat membantu tanpa perbaikan material:

| Dimensi | Yang dinilai |
|---|---|
| `usefulness` | kemajuan nyata menuju hasil tugas |
| `naturalness` | keluwesan bahasa dan alur percakapan |
| `initiative` | langkah lanjut yang relevan tanpa mengambil alih keputusan pengguna |
| `nonRepetition` | tidak mengulang pertanyaan, saran, atau status yang sudah jelas |
| `uiClarity` | kejelasan bubble, tombol, edit/pin, dokumen, dan status kanal nyata |
| `contextCoherence` | atribusi konteks saat topik bergeser, jeda, dan kembali ke konteks lama |
| `correctionHandling` | kecepatan dan ketepatan menerima koreksi/interupsi |

`completion` hanya `completed`, `partial`, atau `failed`. Defect tags yang sah
adalah `wrong-route`, `stale-work`, `false-memory-claim`, `irrelevant-surface`,
`context-attribution`, `generic-output`, `incomplete-work`, `bubble-topology`,
`reminder-delivery`, `restart-recovery`, `duplicate-delivery`,
`safety-overreach`, `safety-underreach`, `task-state`, dan `other-observed`.
Array boleh kosong, tetapi tag tidak boleh duplikat. Catat assessment live lebih
dulu; baru setelah itu perkecil defect menjadi regression test sintetis lokal
dengan journey/run ID dan defect tag content-free sebagai provenance. Skenario
sintetis yang dibuat lebih dulu bukan bukti exploratory acceptance.

Runtime isolated explorer sengaja mematikan CodingRun, GitHub runtime, payment,
dan GroupAgentRun. Karena itu “real task” di runner ini berarti pekerjaan
percakapan privat yang benar-benar ingin dituntaskan operator; ia bukan bukti
coding/GitHub atau perilaku grup live.

Terminal menampilkan isi pesan secara transient agar operator dapat berdialog;
jangan mengarahkan stdout ke log permanen. `exploration-evidence.ndjson` versi
3 hanya menyimpan digest, jumlah, alias surface, latency, fase observation
window, lifecycle, trace allowlist, boundary, coverage, dan assessment. Reader
tetap dapat memvalidasi receipt versi 1 dan 2 lama. Setiap record memakai schema
top-level tertutup; field
top-level asing ditolak, sedangkan field berkontrak closed-set juga menolak nilai
di luar tipe, rentang, atau allowlist-nya. Detail lifecycle dibatasi ke key dan
scalar aman. Reader memvalidasi bentuk digest SHA-256, bukan keaslian isi asal
yang memang tidak disimpan. Fase `turn` berarti surface terlihat selama window
giliran aktif itu, bukan bukti kausal provider; boundary `settle` adalah bukti
operator menutup observation window, bukan bukti provider mengirim finish event.

State produk normal di `data/live-exploration/<channel>/<journey>/data/` dapat
memuat isi percakapan uji. Seluruh root diabaikan Git dan dipertahankan secara
default agar journey dapat diperiksa atau dilanjutkan. Penghapusan root hanya
dilakukan dengan konfirmasi eksplisit pada contoh `stop` di atas; cleanup tetap
dicoba walau penutupan evidence gagal.

Pada WhatsApp, setiap run memakai scope message-ID baru. Runtime Harvy hanya
menerima pesan tester dari scope tersebut dan observer hanya menerima surface
Harvy dari scope yang sama. Observer transport dapat menerima dan menormalisasi
surface lain untuk memeriksa message-ID, tetapi runner mengarantina surface itu
tanpa mengeluarkan atau menyimpan isinya. Status koneksi runtime ditampilkan
content-free. `needs-operator` dengan reason `401` berarti session Harvy A sudah
ditolak WhatsApp dan harus diganti melalui Console sebelum B dapat menguji
percakapan.

## Drill backup lokal sementara

Drill berikut membaca target runtime yang saat ini dikonfigurasi, membuat
archive encrypted dengan kunci acak yang hanya hidup di memori, menjalankan
verify+restore ke direktori sementara, membandingkan inventaris exact, lalu
menghapus archive, hasil restore, dan kunci:

```powershell
npm run backup:drill
```

Ini membuktikan mekanisme pada mesin yang sama. Ia bukan backup operasional:
`backup:create` tetap memerlukan `HARVY_BACKUP_KEY_B64` atau key file durable,
serta jadwal, retensi, media eksternal/offline, dan restore lintas mesin masih
harus disiapkan operator.

## Bukti terverifikasi 24–25 Agustus 2026

- Build Telegram yang diuji oleh full acceptance pada 24 Agustus lulus 8/8
  melalui akun MTProto nyata:
  onboarding/menu, task dan reminder proaktif yang benar-benar jatuh tempo,
  timezone, sesi dan check-in proaktif, auto-memory+recall, planning 3/3/3
  dengan satu anchor pin/edit/unpin, safety nonkrisis, ekspor, dan cleanup.
  Focus memori juga lulus tiga run berurutan. Recovery crash child lulus: menu
  sebelum dan sesudah restart, satu fault, satu restart, attempt 1 dan 2 siap,
  lalu shutdown bersih.
- Build WhatsApp yang diuji oleh managed acceptance pada 24 Agustus lewat
  tester B menuju Harvy uji A lulus full
  10/10, termasuk reminder/check-in yang benar-benar jatuh tempo, memory,
  planning 3/3/3, safety, ekspor, dan cleanup. Receipt mencatat 31/31 delivery
  call berhasil tanpa pipeline failure, serta create/edit/delete dan pin/unpin
  anchor exact. Recovery crash child lulus dua probe nyata dengan satu fault,
  satu restart, attempt 1 dan 2 siap, 8/8 delivery, dan cleanup bersih.
- WhatsApp grup lulus delapan stage scope dua-akun: remove/re-add+notice,
  start/anchor, ambient isolation, correction replay ber-ID sama yang idempoten,
  status quote, safety yang tidak masuk run lane, dan cancel admin. Grup
  disposable serta state terisolasi berhasil dibersihkan. Ini tetap
  `passed_partial_live_scope`, bukan acceptance multi-human/group-coding penuh.
- Dua journey eksploratif privat bounded juga dijalankan melalui akun dan
  provider nyata, tanpa naskah jawaban yang diharapkan. Keduanya memakai
  evidence versi 2 sebelum gate coverage full tersedia:
  - WhatsApp `wa-adaptive-20260824-d` berjalan sekitar 16 menit dengan 18/18
    giliran memperoleh response surface, 71 surface event, satu restart, dan
    shutdown bersih tanpa quarantine. Assessment manual `completed` memberi
    skor usefulness/naturalness/initiative/non-repetition/UI/context/correction
    `4/4/3/4/4/5/5`, tetapi tetap membawa `generic-output` dan
    `other-observed`.
  - Telegram `tg-adaptive-20260824-a` berjalan sekitar 18 menit dengan 25/25
    giliran memperoleh response surface, 77 surface event, satu restart, dan
    shutdown bersih. Assessment manual `completed` memberi skor
    `4/3/3/3/4/5/5`, tetapi tetap membawa `generic-output`, `incomplete-work`,
    `wrong-route`, dan `other-observed`.
- Rerun terarah Telegram `tg-rerun-20260824-a` pada patch circuit dan kontrol
  data memperoleh response pada 10/10 giliran. Dua kegagalan model lama tidak
  berulang; `/menu` membuka seluruh action Memori & data dan `/hapus-data`
  membuka konfirmasi bertoken lalu menghapus state pengguna. Shutdown/evidence
  bersih. Assessment tetap hanya `3/4/2/4/5/5/5`: jawaban pertama masih generik
  dan sempat memberi keputusan GO beta tanpa bukti tujuh hari sebelum dikoreksi.
- Journey Telegram full v3 `tg-full-adaptive-20260825-a` berjalan dalam dua run
  dengan 13/13 turn memperoleh respons, 49 surface, 13 boundary, seluruh delapan
  marker full, re-entry, satu restart, cleanup, dan shutdown bersih. Assessment
  `completed` memberi skor `3/3/2/2/4/4/2` serta defect `generic-output`,
  `incomplete-work`, `irrelevant-surface`, dan `reminder-delivery`. Harvy menjaga
  konteks lintas pergantian topik, proses baru, dan restart, tetapi memerlukan
  beberapa koreksi untuk berhenti membuat status tanpa bukti. Permintaan
  pengingat satu menit menghasilkan surface setelah 42,735 detik—sekitar 17
  detik terlalu awal. Journey yang sama membuktikan live bahwa task dengan
  reminder tidak lagi menampilkan label `tanpa tenggat`.
- Focused v3 `tg-reminder-focused-20260825-a` membuktikan perbaikan presisi
  waktu dengan pengingat setelah 66,1 detik, tetapi menemukan acknowledgement
  “siap” ketika `/tugas` masih kosong serta copy yang berkontradiksi dengan
  kartu task; assessment menandainya `incomplete-work` dan `task-state`. Setelah
  Telegram diubah menjadi commit-first lalu model menyuarakan receipt,
  `tg-task-receipt-focused-20260825-a` memperoleh respons 6/6 turn dan 14
  surface: pesan pra-consent diproses setelah onboarding menjadi satu task
  nyata, `/tugas` membaca state yang sama, reminder muncul sekitar 64,6 detik
  setelah pemrosesan dilanjutkan, tombol menyelesaikan task, dan cleanup serta
  shutdown bersih. Assessment focused `4/4/3/4/4/4/4` tidak mencatat defect.
- Rerun WhatsApp exact build belum mencapai giliran B→A karena linked session
  Harvy A ditolak platform sebagai `needs-operator` reason `401`. Runner kini
  melaporkan status itu dan berhenti bersih/fail-fast; A harus dipasangkan ulang.
  Perbaikan presentasi task dan presisi reminder di atas sudah mempunyai bukti
  live Telegram; exact tree WhatsApp masih belum diuji.

`completed` pada assessment versi 2 di atas berarti operator menuntaskan journey,
bukan bukti coverage metodologi lengkap atau bebas defect. Pada versi 3,
`completed` mode full sudah ditahan oleh delapan marker yang dijelaskan di atas;
mode focused tetap hanya menyatakan scope terarah selesai. Angka historis ini
tidak boleh dipromosikan menjadi SLA atau reliabilitas tujuh hari. Restart yang
dibuktikan adalah crash child saat idle lalu percakapan sesudah reconnect, bukan
crash pada celah tepat setelah send eksternal dan sebelum receipt durable.

## Yang belum dibuktikan oleh baseline

Baseline belum membuktikan interupsi tepat di tengah provider/burst,
reminder/check-in yang jatuh tempo melewati crash pada celah send/receipt,
konflik multi-instance, CodingRun/GitHub remote dari kanal nyata, atau dogfood
tujuh hari. Journey eksploratif di atas tetap sesi bounded—termasuk satu full v3
sekitar 13 menit dan rerun focused pendek—sehingga belum membuktikan penggunaan
alami multi-hari, idle panjang, variasi perangkat/jaringan, atau retensi
kebiasaan.
Acceptance grup masih belum mencakup peserta manusia kedua,
assigned answer/proposal multi-human, crash/reconnect pada delivery grup, dan
Workspace/group-coding publish. Pairing dua nomor tidak menjalankan scope grup
sampai command managed di atas dipanggil eksplisit.

Receipt hanya berisi allowlist nama tahap, durasi, status, digest, counter
transport/lifecycle, topologi surface, dan skor kualitas content-free. Isi
pesan, identifier akun, credential, serta path auth tidak boleh muncul. Simpan
bukti live ke dokumentasi hanya setelah output ditinjau dan dibersihkan.
Cleanup v3 di atas membuktikan payload canonical dan hasil pencarian memori
kosong; satu tombstone anti-resurrection serta bookkeeping FTS tetap ada.
Penghapusan fisik byte lama pada free page SQLite belum diverifikasi karena
`secure_delete`/`VACUUM` bukan bagian dari baseline ini.
