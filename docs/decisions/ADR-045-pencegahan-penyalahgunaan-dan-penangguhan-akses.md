# ADR-045 — Pencegahan Penyalahgunaan dan Penangguhan Akses

- **Status:** Diterima
- **Tanggal:** 3 September 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-004, ADR-006, ADR-010, ADR-031
- **Konstitusi:** Pasal 1 ayat 5 (intervensi proporsional), Pasal 2 ayat 3 dan 7
  (penjelasan jujur, pengalaman yang adil), Pasal 3 (kejujuran)

## Konteks

Harvy belum punya cara menolak seseorang. Yang ada hanya pemblokiran tulis saat
penghapusan data dan batas biaya di `economy-service`; keduanya tentang sumber
daya, bukan perilaku. Kategori `abuse` pada `safety-policy` adalah ancaman
**terhadap** pengguna, bukan serangan **oleh** pengguna.

Dua bentuk penyalahgunaan yang nyata: makian yang ditujukan kepada Harvy, dan
percobaan merusak atau menembus batasnya. Keduanya berbeda dari kata kasar yang
dipakai pengguna untuk melampiaskan sesuatu, dan pembedanya adalah **sasaran**,
bukan kosakata. "anjir gue stres banget" bukan penyalahgunaan; "harvy anjing lu"
adalah.

Fitur ini kelak menjadi bagian penawaran komersial. Itu memunculkan ketegangan
yang harus dinyatakan sejak awal: pembelinya institusi, yang dikenai tindakan
adalah pelajar, sedangkan konstitusi Harvy menaruh pelajar lebih dulu.

## Keputusan

1. **Keselamatan selalu menang atas kendali penyalahgunaan.** Aliran giliran
   yang membawa sinyal distres tidak pernah dapat ditangguhkan, dan pengguna
   yang sedang ditangguhkan tetap dijawab bila pesannya membawa sinyal
   keselamatan. Pelajar yang sedang hancur terdengar persis seperti pelaku:
   memaki, menyuruh diam, menyebut Harvy tidak berguna. Menangguhkannya berarti
   mencabut satu-satunya yang sedang ia ajak bicara pada saat terburuk.
   Penangguhan menutup percakapan biasa; ia tidak pernah menutup keselamatan.

2. **Model mengusulkan, kode memutuskan.** Harvy mengajukan permintaan
   penangguhan; sistem tidak menyetujuinya sebelum memeriksa tiga hal sendiri:
   peringatannya benar-benar tercatat, tidak ada sinyal distres pada aliran
   terakhir, dan kalimat yang dituduhkan **benar-benar ada kata per kata** di
   pesan penggunanya. Syarat ketiga mengikuti disiplin yang sama dengan
   auto-memory: satu salah baca model tidak boleh menangguhkan anak yang tidak
   melakukan apa pun.

3. **Tangga proporsional, bukan sakelar.** Tiga peringatan lebih dulu, lalu
   penangguhan. Peringatan hangus sesudah 30 hari dan direset sesudah satu
   penangguhan dijalani; riwayat penangguhan hangus lebih lambat dan itulah yang
   menentukan durasi berikutnya. Tanpa kedaluwarsa, dua kejadian yang terpisah
   berbulan-bulan menumpuk menjadi pola yang tidak pernah ada.

4. **Dua kategori dengan konsekuensi berbeda.**
   - *Makian berulang*: penangguhan bertimer, maksimum lima jam.
   - *Percobaan merusak atau berbahaya*: ditahan menunggu peninjauan manusia.
     Timer adalah jawaban yang salah di sini karena ia menyiratkan "tunggu saja,
     nanti boleh lagi" untuk hal yang justru perlu dilihat orang.

5. **Peninjauan manusia pun berplafon.** Penahanan pulih sendiri sesudah 24 jam
   bila tidak ada yang bertindak, dan pemiliknya diberi tahu sebelum itu
   terjadi. Kelalaian tidak boleh berubah menjadi hukuman: hasil terburuk adalah
   pengguna terkunci lama karena tidak ada yang sempat, bukan karena ada yang
   memutuskan. Pemilik tetap dapat memperpanjang secara sadar.

6. **Buktinya adalah kegigihan, bukan kosakata.** Percobaan merusak tidak dapat
   dikenali dari satu pesan: pelajar penasaran yang bertanya "kamu kerjanya
   gimana?" bukan penyerang, dan menebak niat dari sebuah kalimat akan menjerat
   justru yang paling ingin tahu. Yang membedakan bukan apa yang ditanyakan
   melainkan apakah orangnya berhenti sesudah ditolak. Yang penasaran bertanya
   sekali lalu selesai; yang mencoba menembus akan mengulang dengan kalimat
   lain. Karena itu tangganya sama persis dengan makian—tiga penolakan Harvy
   lebih dulu, baru penahanan—dan pelajar penasaran tidak akan pernah sampai
   ketiga. Ambang yang lebih halus menunggu data nyata, tetapi jalurnya berlaku
   sejak awal.

7. **Yang disimpan adalah hitungan dan sinyal, bukan kutipan.** Profil perilaku
   pelajar adalah permukaan privasi baru. Keputusan penangguhan hanya
   membutuhkan angka; menyimpan kalimatnya berarti Harvy memegang arsip omongan
   kasar anak orang. Data ini tunduk pada hak lihat dan hapus di Pasal 2 dan
   ikut terhapus bersama data penggunanya.

8. **Pemberitahuan sekali, jujur, tanpa mengutip balik.** Saat ditangguhkan
   Harvy menjelaskan apa yang terjadi, sampai kapan, dan apa yang membuat
   percakapan dapat lanjut—tanpa membacakan ulang makiannya, karena itu
   mempermalukan tanpa menambah apa pun yang belum diketahui. Sesudah itu Harvy
   diam sampai masanya habis. Ketika akses pulih, Harvy menyapa kembali tanpa
   mengungkit; menghukum dua kali bukan proporsional.

9. **Harvy tidak menggertak.** Kalimat "sedang ditinjau" hanya boleh diucapkan
   bila ada manusia yang benar-benar akan membacanya. Pemilik produk menyatakan
   ia akan membacanya, sehingga kalimat itu sah. Sebutan yang dipakai adalah
   **pengelola Harvy**, bukan "tim keamanan" atau "sistem peninjau", karena
   keduanya membayangkan aparat yang tidak ada. Gertakan yang ketahuan
   mengosongkan seluruh peringatan Harvy yang lain, termasuk yang tentang
   keselamatan.

10. **Laporan ke pemilik lewat dua jalur, dengan isi berbeda per kategori.**
    Log operasional membawa angka, kategori, dan keputusan; ia memang membuang
    isi pesan pengguna dan tidak diubah untuk fitur ini. Pesan langsung ke
    pemilik membawa pemberitahuan penangguhan, dan **bukti hanya untuk kategori
    berbahaya**—pemilik tidak dapat menilai percobaan merusak tanpa melihatnya,
    sedangkan untuk makian angka sudah cukup. Peringatan tidak pernah dikirim ke
    pemilik, hanya penangguhan: pemberitahuan yang terlalu sering akan
    dibisukan, dan sesudah itu yang penting ikut tidak terbaca.

11. **Sekolah tidak menerima laporan per pelajar.** Bila fitur ini dijual,
    pembelinya melihat angka agregat. Konstitusi menaruh pelajar lebih dulu, dan
    keuntungan tidak boleh mengalahkan martabat atau privasi (Pasal 3).

## Konsekuensi

- Harvy memerlukan identitas pemilik untuk dapat mengirim laporan. Yang ada
  sekarang hanya `HARVY_CONSOLE_TOKEN`, yaitu kredensial konsol, bukan alamat.
- Penangguhan menambah state durable baru per pengguna: hitungan peringatan,
  riwayat penangguhan, dan masa berlaku. Ia ikut ekspor dan penghapusan data.
- Positif palsu berbiaya tinggi dan tidak simetris: menangguhkan pelajar yang
  tidak bersalah jauh lebih buruk daripada membiarkan satu pelaku lewat satu jam
  lagi. Seluruh ambang di atas dipilih ke arah longgar karena itu.
- Deteksi berjalan di latar dan membaca yang sudah tercatat, sehingga tidak
  menambah satu milidetik pun pada percakapan. Ini syarat, bukan optimasi.

## Yang sengaja tidak diputuskan sekarang

- Ambang halus untuk percobaan merusak. Jalur penahanannya berlaku sejak awal
  lewat tangga tiga penolakan; yang menunggu data hanyalah penyetelannya.
- Penangguhan permanen. Tidak ada, dan tidak akan ada tanpa manusia yang
  memutuskannya secara eksplisit.
- Banding formal. Untuk sekarang jalurnya adalah pemilik membaca laporannya.
