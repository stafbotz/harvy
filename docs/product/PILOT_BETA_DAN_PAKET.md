# Pilot Beta dan Katalog Paket Harvy

Dokumen ini memisahkan empat hal yang mudah tercampur: akses produk, cohort
beta, paket/kapasitas, dan persetujuan evaluasi. Keempatnya mempunyai status
sendiri. Tidak satu pun menjadi izin otomatis untuk membaca isi percakapan.

## Status pilot

Katalog berikut tetap menjadi default control plane untuk eksperimen. ID dan
harga adalah `PlanVersion` yang dapat berubah melalui katalog versioned; harga
di tabel adalah hipotesis pilot, bukan konstanta routing atau janji checkout.
Runtime memberi setiap subject periode billing eksplisit dengan allowance
**Harvy Compute** fixed-point (logical compute units) dan ceiling rolling
anti-abuse. State lama yang hanya memiliki rolling token limit dibaca melalui
overlay kompatibilitas tanpa mengubah arti ledger historis.
Jika instalasi lama memakai nilai rolling `0` untuk arti “tanpa batas”, policy
compute forward-only tetap memakai baseline Free yang finite; tidak ada akun
Free yang berubah menjadi subsidi inference unlimited.

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
dan keselamatan. Kapasitas paket hanya berkurang untuk `reply`, `agent`,
`research`, atau `group-reply` yang benar-benar berhasil dikirim. Pembacaan
tenggat, boundary,
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

Plan tidak pernah menjadi proxy kecerdasan: task dan konteks yang identik
mempertahankan role, model eligibility, tool, memory, dan escalation ceiling
yang sama di Free maupun paket berbayar. Perbedaan plan hanya allowance dan
kapasitas operasional. Bila allowance habis, funding resolver memilih secara
deterministik `included → sponsored → PAYG (hanya bila consent) → BYOK`, atau
memberi jalur tunggu/limit; sistem tidak diam-diam mengganti ke model lebih
buruk.

## Sumber funding dan jalur control-plane

`EconomyService` melakukan preflight, reservation atomic, execution, lalu
settlement setelah delivery. Reservation memakai request/logical-run ID dan
ledger idempoten sehingga retry, crash, webhook ganda, refund, dan request
paralel tidak menggandakan debit. `RunBudget` tetap merupakan batas teknis
satu agent run dan bukan quota subscription.

Free, subscription, sponsored grant, dan PAYG disimpan sebagai entitlement
terpisah. Wallet PAYG prepaid tidak digunakan otomatis kecuali preference
subject mengizinkannya. BYOK menyimpan metadata credential di economy state dan
raw key hanya di secret store terenkripsi yang terpisah; key tidak pernah masuk
memory, prompt, telemetry, ledger, atau Console. Instalasi tanpa master key
menonaktifkan setup BYOK secara fail-closed, sementara Free/subscription tetap
berfungsi.

Control-plane/account commands (penggunaan, reset, paket, funding preference,
cancel, BYOK setup, dan bantuan billing) tetap dapat dijalankan ketika
inference berbayar diblokir. Jika payment gateway belum dikonfigurasi, UX
menyatakan hal itu secara eksplisit; `LocalPaymentGateway` hanya fake untuk
test/development dan bukan penerimaan uang production.

`/penggunaan` tersedia sebagai dashboard deterministik di chat pribadi
Telegram dan WhatsApp. Tampilan memakai nama publik plan dan periode persisted,
sisa allowance dalam persen, aktivitas token provider, total physical AI cost,
sumber biaya dengan bahasa pengguna, serta efisiensi cache bila snapshot harga
historis cukup. Total biaya bukan otomatis tagihan pengguna. Query selalu
terikat ke akun pengirim, tidak membaca isi chat, tidak memanggil model, dan
tidak membuka detail paket/saldo/API pribadi di grup.

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
terpakai; implementasi menunggu setidaknya setengah periode aktif sebelum
memberi saran downgrade agar periode yang baru dimulai tidak dianggap bukti
penggunaan rendah. Rekomendasi memilih plan aktif termurah yang cukup dari
settlement delivery content-free. Emosi, risiko keselamatan, kerentanan, atau
isi pribadi tidak boleh dipakai untuk upsell. Tidak ada countdown palsu, dark
pattern auto-renew, penyembunyian kuota, atau penurunan bantuan keselamatan.

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

Sebelum kriteria ini lulus, seluruh harga adalah hipotesis pilot. Console dapat
menampilkan katalog, allowance, reservation, wallet, payment state, provider
cost, settlement, dan metadata BYOK tanpa secret, tetapi tidak boleh berpura-
pura telah mengaktifkan checkout production. Kontribusi **Dukung Harvy / Harvy
Commons** adalah voluntary contribution terpisah dari subscription dan tidak
meningkatkan intelligence atau menjadi syarat Free.

Ledger revenue membedakan subscription, PAYG, contribution, sponsor,
enterprise, service fee, dan marketplace fee sebagai extension point—bukan
implementasi marketplace sekarang. Margin sumber-sumber itu kelak boleh
dialokasikan ke Free/Commons tanpa mengubah routing kecerdasan. Jika layanan
yang direkomendasikan menghasilkan fee, hubungan komersial wajib diungkapkan
dan fee tidak boleh menjadi bobot ranking tersembunyi.
