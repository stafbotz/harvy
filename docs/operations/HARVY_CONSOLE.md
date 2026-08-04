# Harvy Console: Operasi Lokal dan Jalur Produksi

Harvy Console adalah control plane operator, bukan kanal percakapan pengguna.
Versi sekarang sengaja hidup di proses Harvy yang sama dan hanya menerima
koneksi `127.0.0.1`. Tujuannya adalah mengelola akses pilot serta memahami
usage dan biaya tanpa menjadikan log sebagai arsip percakapan.

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
