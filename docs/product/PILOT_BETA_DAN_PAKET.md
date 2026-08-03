# Pilot Beta dan Katalog Paket Harvy

Dokumen ini memisahkan empat hal yang mudah tercampur: akses produk, cohort
beta, paket/kapasitas, dan persetujuan evaluasi. Keempatnya mempunyai status
sendiri. Tidak satu pun menjadi izin otomatis untuk membaca isi percakapan.

## Status pilot

Katalog berikut sudah menjadi default control plane untuk eksperimen, tetapi
belum dijual dan belum memiliki checkout. Angka kapasitas adalah kelipatan
`AI_ROLLING_24H_TOKEN_LIMIT` dalam jendela bergulir 24 jam.

| ID stabil | Tier | Nama publik | Sasaran | Harga hipotesis/bulan | Kapasitas | Perilaku grup |
|---|---|---|---|---:|---:|---|
| `personal_perkenalan` | Free | Perkenalan | pribadi | Rp0 | 1× | — |
| `personal_toro` | Plus | Toro | pribadi ringan | Rp19.000 | 2× | — |
| `personal_sora` | Pro | Sora | pribadi rutin | Rp39.000 | 5× | — |
| `personal_kuro` | Max | Kuro | pribadi intensif | Rp69.000 | 10× | — |
| `group_direct` | — | Sapa | grup yang memanggil Harvy | Rp99.000 | 5× | direct only |
| `group_ambient` | — | Nimbrung | grup dengan partisipasi ambient | Rp249.000 | 15× | ambient |
| `workspace` | — | Ruang | komunitas/institusi | Rp599.000 | 30× | workspace; runtime saat ini ambient |

ID lama `personal_free`, `personal_sprout`, `personal_bloom`, dan
`personal_canopy` hanya dikenali sebagai alias migrasi. Control plane mengganti
ID pada seluruh versi katalog, enrollment, dan target audit dalam satu tulis
atomik; provider ledger serta entitlement ledger menulis ulang referensinya
secara atomik saat pertama dimuat. Migrasi idempoten, dan semua jalur tulis baru
menormalisasi alias lama agar ID itu tidak muncul kembali.

Paket grup mempunyai kantong sendiri. Penggunaan grup tidak mengurangi paket
pribadi anggota, dan pembayaran grup tidak memberi paket pribadi berbayar
kepada setiap anggota. Ukuran grup saja bukan dasar biaya: frekuensi, mode
ambient, jumlah logical request, dan attempt provider lebih menentukan.

Angka kapasitas bukan tagihan provider. Provider ledger tetap menghitung semua
attempt fisik, termasuk retry, fallback, planner yang memilih diam, kegagalan,
dan keselamatan. Kapasitas paket hanya berkurang untuk `reply`, `session`, atau
`group-reply` yang benar-benar berhasil dikirim. Pembacaan tenggat, boundary,
understanding, triase, review, ringkasan, insight, planner/revalidasi grup,
keluaran schema rusak, dan balasan gagal kirim menjadi biaya Harvy—bukan debit
peserta. Aturan konservatif ini diuji lebih dulu agar pilot tidak menagih
kegagalan internal.

## Cohort beta

`beta` bukan paket, diskon, atau environment deployment. Ia adalah overlay
eksperimen yang secara bawaan memberi 4× batas paket aktif agar pengujian tidak
cepat berhenti. Multiplier dapat diubah lewat `BETA_QUOTA_MULTIPLIER`, dan
enrollment dapat memiliki override/masa berakhir sendiri.

Ketika beta berakhir, cohort kembali `standard`; paket dan data tidak otomatis
berubah. Beta tidak menentukan model yang dipakai. Routing tetap menurut
kesulitan pekerjaan dan aturan keselamatan.

## Persetujuan evaluasi

Operator boleh mengundang dan mencabut evaluasi, tetapi tidak boleh mengubah
status menjadi `granted`. Persetujuan harus datang dari peserta, terpisah dari
persetujuan pemrosesan Harvy biasa, dapat ditarik, memiliki scope/retensi yang
jelas, dan tidak menjadi syarat memperoleh keselamatan dasar.

Versi sekarang belum menyimpan transcript review atau sampel chat beta di
Console. Sampai alur participant consent dan penyimpanan khusus dibuat,
evaluasi dilakukan dari telemetry tanpa isi percakapan, feedback sukarela, dan
observasi langsung yang memang disepakati di grup beta.

## Strategi kemauan membayar

Tangga harga memakai prinsip pilihan yang mudah dipahami, bukan manipulasi:

- Perkenalan (Free) membuktikan manfaat inti, bukan versi yang sengaja dibuat
  menyebalkan.
- Toro (Plus) adalah pintu masuk pelajar yang ringan.
- Sora (Pro) menjadi pilihan utama untuk penggunaan rutin: selisih harga
  sebanding dengan lonjakan kapasitas dari 2× ke 5×.
- Kuro (Max) memberi ruang intensif tanpa harga “10× paket” yang tidak masuk
  akal; ia menjadi anchor kapasitas, bukan umpan rasa takut.
- Sapa menjual respons saat dipanggil. Nimbrung menjual pembeda Harvy—kehadiran
  ambient yang terukur—dan karena itu menanggung biaya serta risiko lebih besar.
- Ruang hanya untuk pilot terarah sampai administrasi, moderasi, dan operasi
  institusi benar-benar ada.

Harvy boleh merekomendasikan paket dari pola usage dan batas yang benar-benar
tercapai. Harvy juga harus menyarankan turun paket bila kapasitas terus tidak
terpakai. Emosi, risiko keselamatan, kerentanan, atau isi pribadi tidak boleh
dipakai untuk upsell. Tidak ada countdown palsu, dark pattern auto-renew,
penyembunyian kuota, atau penurunan bantuan keselamatan.

## Kriteria sebelum menerima uang

- Ledger provider dan entitlement stabil pada beta nyata, termasuk fallback,
  timeout, cache/reasoning, dan rekonsiliasi biaya.
- Pengalaman tiap paket terbukti berbeda secara bermanfaat, bukan sekadar cap.
- Kuota, reset, downgrade, penghentian, renewal, dan refund dapat dijelaskan
  sebelum membayar.
- Paket grup diuji end-to-end pada beberapa grup nyata dengan notice dan
  kontrol data, bukan hanya socket/corpus sintetis.
- Payment ledger, invoice, webhook idempotency, dukungan, pajak, serta prosedur
  insiden tersedia.
- Margin dihitung dari data cohort tanpa membaca transcript: pendapatan bersih
  dikurangi biaya model, pembayaran, infrastruktur, dukungan, refund, dan pajak.

Sebelum kriteria ini lulus, seluruh harga adalah hipotesis pilot dan Console
tidak boleh menampilkan tombol beli.
