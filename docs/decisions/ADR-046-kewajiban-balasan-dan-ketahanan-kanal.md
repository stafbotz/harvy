# ADR-046 — Kewajiban Balasan dan Ketahanan Kanal Telegram

- **Status:** Diterima
- **Tanggal:** 4 September 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-006 (memori), ADR-031 (retrieval), ADR-045 (penangguhan)
- **Konstitusi:** Pasal 2 ayat 3 dan 7 (penjelasan jujur, pengalaman yang
  adil), Pasal 3 (kejujuran), Pasal 3.9 (data sesedikit mungkin, ada batas
  penyimpanan), Pasal 4 nomor 4 (hak menghapus)

## Konteks

Harvy memercayai grammY sepenuhnya untuk kanal Telegram — satu-satunya kanal
yang benar-benar hidup. Pembacaan kode grammY 1.45 pada 4 September 2026
menemukan tiga hal yang tidak pernah dinyatakan di mana pun:

1. **Kegagalan polling tidak pernah tercatat.** `fetchUpdates` menangkap galat
   `getUpdates`, melaporkannya lewat `debugErr` — paket `debug`, mati kecuali
   variabel lingkungan `DEBUG` diisi — lalu tidur tiga detik dan mengulang
   tanpa batas. Galat itu tidak pernah sampai ke `bot.catch`, yang hanya
   menangani galat handler. Harvy dapat berhenti menerima pesan berjam-jam
   sambil menghasilkan nol baris log.
2. **Soket mati menggantung 500 detik.** Batas bawaan grammY adalah
   `timeoutSeconds: 500`, sedangkan long-poll sehat dijawab dalam ~30 detik.
3. **`retry_after` diabaikan saat mengirim.** Tidak ada plugin auto-retry dan
   tidak ada transformer. Bubble yang ditolak 429 melempar seketika.

Selain itu, satu artefak dapat hilang tanpa jejak: balasan yang sudah disusun
tetapi belum terbukti sampai. Gilirannya sudah membayar token, pesan
penggunanya sudah tercatat di riwayat, dan teks jawabannya hanya ada di satu
variabel di memori. Proses yang mati di antara "jawaban jadi" dan "jawaban
terkirim" membuangnya tanpa siapa pun tahu.

Pembandingnya adalah Hermes Agent (Nous Research), yang membangun tiga detektor
polling terpisah beserta watchdog untuk watchdog-nya, dan sebuah ledger
kewajiban pengiriman berbasis SQLite.

## Keputusan

1. **Ketahanan kanal dipasang di transformer API grammY, bukan sebagai
   pengawas dari luar.** Hermes memakai python-telegram-bot yang tidak memberi
   titik cegat pada jalur HTTP-nya, sehingga ia terpaksa menyelidiki polling
   dari luar: probe `get_me()`, `getWebhookInfo().pending_update_count`, dan
   watchdog stall berbasis state lokal. grammY memberi Harvy tempat yang tidak
   dimiliki Hermes. `getUpdates` diberi batas 55 detik pada permintaannya
   sendiri; soket mati membatalkan dirinya lalu grammY membangun ulang koneksi
   dengan mesin retry yang sudah ia punya. Yang di Hermes butuh tiga detektor,
   di sini cukup satu deadline di lapisan yang benar.

2. **Kegagalan Telegram wajib terlihat.** Transformer mencatat kegagalan
   transport dan penolakan API ke `OperationalLogger`, diringkas satu baris per
   menit per jenis agar gangguan panjang tidak membanjiri berkas.
   `SAFE_ERROR_TYPES` menerima `grammyerror` dan `httperror`, dan `error_code`
   ikut dibaca sebagai status. **`description` milik Telegram sengaja tidak
   ikut**, meski di situlah pembedanya paling tajam: ia teks dari server yang
   pada beberapa bentuk galat mengutip kembali isi pesan penggunanya. Membuang
   seluruh pesan galat adalah posisi yang sudah dipilih `operational-logger`
   sejak awal, dan mengembalikannya lewat pintu ini akan menjadi keputusan
   privasi yang tidak pernah dinyatakan.

3. **Hanya 429 yang diulang saat mengirim.** 429 berarti Telegram *menolak*
   permintaannya, jadi mengulang tidak mungkin menghasilkan duplikat. Galat 5xx
   tidak diulang karena sebaliknya — permintaannya mungkin sudah diterima, dan
   pengulangan dapat mengirim bubble yang sama dua kali kepada seorang pelajar.

4. **Balasan percakapan memakai at-least-once dengan penanda; efek terjadwal
   tetap at-most-once.** Ini pembalikan sadar terhadap pilihan
   `ScheduledDeliveryAttempt`, dan bukan ketidakkonsistenan:

   - Pengingat tugas yang terkirim dua kali adalah **gangguan**. Pengingat yang
     hilang paling jauh berarti pelajar mengecek daftarnya sendiri. Karena itu
     `in_flight` di sana tidak pernah diulang.
   - Balasan percakapan yang hilang berarti seorang pelajar **bertanya lalu
     tidak dijawab sama sekali**, sementara pertanyaannya sudah telanjur masuk
     riwayat sehingga Harvy pun mengira ia sudah menjawab. Balasan yang
     terkirim dua kali hanya membingungkan sesaat.

   Janji yang pengirimannya sempat dimulai dikirim ulang **dengan kalimat yang
   mengakuinya** (`RECOVERED_REPLY_NOTE`). Duplikat diam-diam akan membuat
   Harvy tampak bingung; satu kalimat mengubahnya menjadi pengiriman ulang yang
   dapat dimengerti. Pasal 3 menuntut kejujuran tentang keadaan Harvy sendiri,
   dan ini termasuk.

5. **Janji berumur pendek, berplafon, dan ikut terhapus.** Batasnya 15 menit,
   dua percobaan, 8.000 karakter, dan 64 baris. Balasan yang tiba lima belas
   menit terlambat lebih buruk daripada tidak ada: percakapannya sudah bergerak
   — alasan yang sama dipakai `DeferredTurnRetry` untuk membatalkan diri begitu
   penggunanya bicara lagi. Isinya adalah percakapan pengguna, jadi
   `DataControlService.deleteAll` menghapusnya, dan menghapusnya **lebih dulu**
   daripada store lain karena satu-satunya hal yang dapat menuliskannya kembali
   adalah pengiriman yang sedang berjalan.

6. **Janji hanya diklaim dari proses yang sudah mati.** Identitas proses adalah
   PID *bersama* waktu mulai, karena sistem operasi memakai ulang nomor PID.
   Baris milik proses yang masih hidup tidak pernah diambil: pengirimannya
   barangkali sedang berjalan.

7. **Kegagalan ledger tidak pernah menahan pengiriman.** Seluruh metode
   best-effort dan menelan galatnya sendiri. Aturan yang sama sudah berlaku di
   `AGENTS.md` untuk pengumpulan bukti; di sini taruhannya lebih tinggi, karena
   yang dijaga justru pengiriman itu sendiri.

## Yang tidak diputuskan di sini

**Janji balasan tidak ikut ekspor data.** Ia state infrastruktur yang hidup
paling lama lima belas menit dan hampir selalu kosong; pada saat ekspor
dijalankan, satu-satunya baris yang mungkin ada adalah balasan ekspor itu
sendiri. Harvy sudah memperlakukan state proses transient sebagai di luar
lingkup ekspor (`NumberedOptionStore`, batcher). Bedanya, yang ini menyentuh
disk. Keputusan untuk **tidak** mengekspornya diambil karena nilainya bagi
pengguna mendekati nol sementara ia menambah field pada kontrak ekspor, tetapi
ia layak ditinjau ulang pemilik produk bila kelak umurnya diperpanjang.

## Konsekuensi

Yang didapat: kegagalan kanal Telegram berpindah dari tak terlihat menjadi
terbaca; jendela tuli mengecil dari 500 detik menjadi 55; bubble yang kena
rate limit tidak lagi hilang; dan balasan yang tertahan oleh crash dikirim
ulang alih-alih lenyap.

Yang dibayar: satu berkas JSON baru berisi isi percakapan, walau berumur
pendek dan ikut terhapus. Satu tulis berkas yang ditunggu pada jalur balasan —
kecil, tetapi ada. Dan kemungkinan seorang pelajar melihat jawaban yang sama
dua kali sesudah Harvy mati mendadak, dengan satu kalimat yang menjelaskannya.

Risiko yang diketahui dan diterima: pola tulisnya `.tmp` + `rename` dengan
antrean promise, sama seperti adapter berkas lain, sehingga **aman untuk satu
proses dan tidak untuk dua**. Menjalankan dua instance Harvy pada berkas yang
sama akan membuat keduanya saling mengklaim janji. Batas itu sudah berlaku
untuk seluruh storage Harvy hari ini dan dicatat di `CURRENT.md`; ADR ini tidak
memperbaikinya dan tidak memperburuknya.
