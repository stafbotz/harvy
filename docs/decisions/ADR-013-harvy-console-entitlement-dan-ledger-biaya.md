# ADR-013 — Harvy Console, Entitlement, dan Ledger Biaya

- **Status:** Diterima bersyarat
- **Tanggal:** 1 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** Konstitusi v0.4, ADR-003, ADR-009, ADR-010, ADR-011, ADR-012

## Konteks

Harvy akan dibuka kepada pengguna dan grup standar maupun beta. Pemilik produk
perlu mengetahui biaya pengembangan, keberhasilan provider, pemakaian per ruang,
serta perilaku teknis Harvy tanpa mengubah log menjadi arsip percakapan. Harvy
juga memerlukan fondasi paket berbayar agar biaya model dapat ditanggung secara
berkelanjutan.

Telemetry v1 belum cukup untuk tujuan itu. Ia mencatat satu record per fetch
tanpa hubungan request/attempt, menghitung harga berdasarkan tier, memakai
floating point, tidak menyimpan origin fallback, dan menggabungkan biaya
provider dengan kuota pengguna. Pemakaian grup dapat dijumlahkan per scope,
tetapi belum dapat diatribusikan kepada anggota pemicu. Repository berkas juga
hanya aman untuk satu proses.

## Keputusan

1. **Console adalah control plane lokal.** Versi awal berjalan di proses Harvy
   yang sama, bind hanya ke loopback, memakai API `/api/v1`, session operator
   in-memory, CSRF, pemeriksaan Host/Origin, CSP, schema input tertutup, dan audit
   setiap mutasi. Frontend tidak membaca berkas langsung.
2. **Empat dimensi tidak boleh dilebur.** Setiap subject mempunyai `cohort`
   standar/beta, paket komersial, kebijakan kuota, dan status persetujuan
   evaluasi yang terpisah. Beta bukan paket maupun environment. Membayar atau
   menjadi beta tidak memberi izin membaca isi percakapan.
3. **Operator tidak dapat memberi persetujuan atas nama peserta.** Console hanya
   dapat membuat undangan evaluasi, melihat status, atau mencabutnya. MVP
   monitoring bersifat event-only dan tidak menyimpan prompt, balasan, atau
   transkrip.
4. **Katalog paket berversi.** Katalog individu adalah `personal_perkenalan`
   (Perkenalan/Free), `personal_toro` (Toro/Plus, Rp19.000),
   `personal_sora` (Sora/Pro, Rp39.000), dan `personal_kuro` (Kuro/Max,
   Rp69.000). Katalog grup adalah `group_direct` (Sapa, Rp99.000),
   `group_ambient` (Nimbrung, Rp249.000), dan `workspace` (Ruang, mulai
   Rp599.000). Nama publik paket pribadi diamendemen pada 2 Agustus 2026.
   Amandemen lanjutan pada tanggal yang sama mengganti ID internal sesuai nama
   publik atas keputusan pemilik produk. ID sebelumnya hanya menjadi alias
   migrasi untuk katalog, enrollment, audit, provider ledger, dan entitlement
   ledger; keluaran serta tulisan baru selalu memakai ID baru. Harga merupakan
   hipotesis pilot, bukan checkout aktif. Benefit yang belum tersedia tidak
   boleh ditampilkan.
5. **Model tetap dirutekan menurut pekerjaan.** Paket hanya mengatur kapasitas
   dan capability yang benar-benar tersedia; ia tidak menurunkan kualitas model
   untuk orang yang membayar lebih sedikit. Keselamatan selalu menembus cap.
6. **Biaya dan entitlement memakai ledger berbeda.** Provider-attempt ledger
   mencatat setiap fetch sungguhan, termasuk retry, fallback, silent ambient,
   kegagalan, keluaran yang ditolak parser, dan keselamatan. Entitlement
   mengotorisasi satu logical request, tetapi debit `reply`, `session`, atau
   `group-reply` baru di-commit setelah adapter memastikan balasannya berhasil
   dikirim. Retry/fallback tidak mendebit ulang; `due-date`, boundary,
   understanding, triase, review, ringkasan, insight, dan planner/revalidasi
   grup merupakan overhead perusahaan. Keselamatan juga tidak mengurangi
   kapasitas biasa. Balasan gagal, diganti, atau tidak pernah dikirim tidak
   menjadi debit.
7. **Tiga ID menghubungkan pekerjaan.** Satu giliran dapat membawa `turnId`;
   setiap `AiClient.complete` membuat `requestId`; setiap fetch membuat
   `attemptId` dan nomor attempt monotonik. Seluruh retry dan fallback satu
   request mempertahankan request ID yang sama.
8. **Ledger menyimpan model aktual.** Attempt mencatat provider, origin
   primary/fallback, model, tier, purpose, environment, cost center, scope,
   principal pemicu pseudonim, token provider/estimasi, cache/reasoning bila
   tersedia, generation ID, outcome, latency, dan finish reason. Respons HTTP
   sukses yang ditolak parser domain ditandai `schema_rejected`; timeout tanpa
   usage tidak boleh disebut biaya nol pasti.
9. **Uang tidak diakumulasi dengan floating point.** Harga provider+model
   disimpan sebagai versi append-only dan nilai decimal. Attempt menyimpan
   snapshot versi harga. Perhitungan memakai integer nano-USD; provider-reported
   dan hasil katalog disimpan berdampingan, sedangkan effective cost menyatakan
   sumbernya. Nilai environment `0/0` hanya berarti token-only dan tidak
   membuat harga gratis palsu; tarif nol sungguhan harus dibuat sebagai versi
   harga eksplisit di Console.
10. **Atribusi anggota berarti pemicu, bukan kepemilikan isi prompt.** Total
    grup dipartisi ke principal pemicu atau bucket shared. Alias PN/LID
    dipetakan ke principal acak per scope; identifier platform mentah tidak
    masuk ledger. Breakdown ini hanya untuk operator internal dan tidak
    diberikan kepada pembayar/admin grup sebagai penilaian perilaku. Label
    operator bersifat opsional, manual, dan pseudonim; label tidak pernah
    diambil dari nama atau nomor platform.
11. **Retensi dan penghapusan tetap berlaku.** Penghapusan subject atau removal
    grup menghapus detail usage yang masih dapat dikaitkan. Agregat keuangan
    boleh dipertahankan kelak hanya setelah benar-benar dianonimkan dan notice
    menjelaskannya. Versi lokal sekarang tidak membuat pengecualian baru itu.
    Kontrol “lupakan tentang aku” di grup juga menghapus seluruh alias
    principal serta attempt provider anggota tersebut; entitlement agregat
    ruang yang tidak mempunyai atribusi anggota tetap terpisah.
12. **Satu set berkas hanya boleh dimiliki satu proses.** Runtime, probe, dan
    evaluator mengambil lock atomik yang sama sebelum membuka repository JSON.
    Proses kedua gagal tertutup. Lock yang tertinggal setelah crash tidak
    dihapus otomatis; operator wajib memastikan PID sudah mati sebelum
    menghapusnya manual.
13. **Transisi produksi bukan sekadar mengganti host.** Sebelum Console dibuka
    melalui domain atau proses dipisah, state control plane, price, audit,
    entitlement, usage, dan outbox harus dipindah ke PostgreSQL; auth operator
    memakai OIDC/MFA/RBAC; TLS, secret manager, backup/PITR, reconciliation,
    serta auth Baileys terenkripsi harus tersedia.
14. **Environment adalah authority katalog model; Console hanya mengatur
    harga.** Pada startup, semua slot model testing default/override, fallback,
    dan production yang nonkosong dibentuk menjadi snapshot aman. API hanya
    membawa ID provider/model, mode, origin, tier, nama slot, dan status aktif;
    base URL, key, dan credential dilarang ikut. Form memilih satu pasangan
    katalog dan server menolak pasangan buatan. Katalog tidak dipersistenkan,
    sehingga perubahan `.env` memerlukan restart; histori harga tetap
    append-only ketika model dihapus atau diganti.
15. **Estimasi historis adalah tampilan turunan, bukan rekonsiliasi.** Attempt
    yang terjadi sebelum versi harga tersedia tetap menyimpan biaya efektif
    `null` dan tidak pernah ditulis ulang. Bila usage attempt tersedia serta
    pasangan provider/model mempunyai harga aktif sekarang, laporan boleh
    menghitung `current_catalog_estimate` secara read-only. Console wajib
    menandainya dengan `≈`, menyebut jumlah attempt yang diestimasi, dan tetap
    memisahkannya dari biaya provider/katalog yang tercatat. Tanpa usage atau
    harga aktif, Console menulis alasan yang dapat ditindaklanjuti; ia tidak
    menampilkan enum internal sebagai harga dan tidak mengubahnya menjadi nol.

## Batas rilis sekarang

Checkout, webhook pembayaran, auto-renew, pajak, refund, overage otomatis,
review transkrip, dan penjualan paket grup/SLA ditunda. WhatsApp grup masih
beta Baileys dan belum mempunyai bukti operasi nyata yang cukup. Console dan
katalog pada tahap ini adalah alat pengukuran, konfigurasi, dan pilot internal.

## Konsekuensi

- Harvy dapat mengukur biaya model primer maupun fallback dan membedakannya dari
  debit kapasitas pengguna.
- Katalog harga yang salah tidak menulis ulang histori, tetapi operator tetap
  dapat membuat versi baru; seluruh mutasi harus terlihat pada audit.
- Model yang tidak lagi ada di environment tetap mempunyai histori harga,
  tetapi tidak dapat diberi versi baru sampai dikonfigurasi kembali. Perubahan
  ejaan provider/model membuat identitas baru dan tidak memindahkan histori.
- Angka provider dapat tetap tidak lengkap ketika timeout terjadi setelah
  provider memproses request. Console menampilkan “Menunggu data provider”,
  “Harga belum tersedia”, atau “Sebagian belum dihitung”. Attempt lama yang
  dapat dihitung memakai harga aktif tampil sebagai estimasi `≈`; tidak satu
  pun keadaan itu boleh disamarkan menjadi biaya tercatat atau US$0.
- File JSON tetap hanya layak untuk satu proses localhost. Runtime lock
  mencegah dua proses Harvy yang patuh berjalan bersamaan, tetapi tidak
  menjadikannya sumber billing produksi atau aman dibuka proses lain.
- Paket pilot belum membuktikan margin atau kemauan membayar. Putusan bisnis
  tetap `belum terbukti` sampai ledger dan beta menghasilkan sampel nyata.

## Gerbang penerimaan

- Primary gagal lalu fallback berhasil menghasilkan dua attempt dengan satu
  request ID dan model aktual berbeda, tetapi maksimal satu kandidat debit.
  Kandidat baru menjadi debit setelah delivery berhasil.
- Retry, JSON downgrade, response terpotong, dan provider failure tercatat
  tanpa double charge.
- HTTP sukses dengan keluaran schema rusak tercatat `schema_rejected`; balasan
  yang gagal dikirim atau tidak terbentuk tidak mendebit kapasitas.
- Safety tercatat sebagai biaya tetapi tidak mengurangi sisa kuota biasa.
- Perubahan versi harga tidak mengubah biaya historis dan agregasi nano-USD
  bebas floating drift; estimasi harga aktif bersifat read-only dan provenance
  `current_catalog_estimate` terlihat pada API.
- Console menampilkan seluruh model environment tanpa credential, hanya
  menawarkan pasangan katalog pada form harga, dan API menolak pasangan model
  yang dibuat bebas.
- Total bucket anggota pemicu ditambah shared persis sama dengan total grup;
  alias PN/LID tidak menjadi dua principal, dan penghapusan diri menghilangkan
  seluruh alias serta attempt anggota itu.
- Cohort, paket, consent, dan runtime mode dapat berubah secara independen;
  routing model tidak berubah karena paket.
- Console menolak non-loopback, Host/Origin/CSRF yang salah, body berlebih, dan
  sesi kedaluwarsa; seluruh mutation sukses maupun gagal diaudit tanpa secret
  atau isi percakapan.
- Runtime dan evaluator tidak dapat membuka set berkas lokal yang sama secara
  bersamaan; lock stale hanya dibersihkan dengan keputusan operator.
- Kontrol data dan keselamatan tetap dapat dipakai saat cap tercapai atau plan
  diturunkan.
- Gerbang tipe dan seluruh tes otomatis lulus.
