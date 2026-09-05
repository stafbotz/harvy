# ADR-047 — Jejak Belajar dan Bantuan yang Memudar

- **Status:** Diterima
- **Tanggal:** 4 September 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-006 (memori), ADR-043 (potret naratif), ADR-046 (kanal)
- **Konstitusi:** Pasal 2 (agensi dan kemandirian yang terhubung), Pasal 3
  (bantuan mengikuti keadaan pengguna), Pasal 4 (kemampuan dibangun melalui
  bantuan bertahap), Pasal 3.9 (data sesedikit mungkin)

## Konteks

Konstitusi menuntut satu perilaku yang belum pernah dapat dijalankan. Pasal 2:

> "Untuk kemampuan yang sudah dikuasai pengguna, Harvy **mengurangi bantuan
> secara bertahap** apabila sesuai dengan tujuan pengguna."

Pasal 4 menutup tangga bantuan belajar dengan langkah kelima: "Harvy mengurangi
bantuan ketika pengguna siap."

Harvy sudah punya tangganya. `TutorStage` menjalankan `assess → attempt → hint
→ explain → retry` persis seperti Pasal 4 menuliskannya. Tetapi tangga itu
hanya hidup **di dalam satu sesi**. Penelusuran 4 September 2026 menemukan
rantai yang putus di tiga tempat:

1. **Sesi dihapus saat selesai.** `SessionService.progress` memanggil
   `repository.remove` begitu sinyalnya `done`. Alasannya benar—minimisasi
   data—tetapi akibatnya sebuah sesi tutor yang membawa pelajar dari buntu
   sampai bisa menghilang tanpa jejak.
2. **Episode tidak punya sisi kemajuan.** Sembilan field klaim merekam
   `unresolved` dan `uncertainties`, yaitu apa yang masih terbuka. Tidak ada
   pasangannya untuk apa yang sudah selesai dikuasai. `corrections` pun soal
   mengoreksi pemahaman Harvy, bukan pelajarnya belajar.
3. **Potret memori adalah titik waktu.** `memoryPortrait` menulis "bagaimana
   Harvy memahami penggunanya **saat ini**", bukan lintasannya.

Hasilnya: `grep -rn "dikuasai\|mengurangi bantuan" src/` mengembalikan nol.
Pasal 2 tidak dapat dilaksanakan karena Harvy tidak punya cara mengetahui
pelajarnya sudah bisa.

Pembandingnya Hermes Agent, yang membangun mesin persis untuk ini—dua penghitung
terpisah (giliran pengguna untuk memori, iterasi tool untuk skill), tinjauan
latar yang berjalan **sesudah** balasan terkirim, dan koreksi di tempat saat
kekeliruan ketahuan. Tetapi arah pertumbuhannya berlawanan: Hermes menumbuhkan
**agennya**, sedangkan konstitusi Harvy menaruh pertumbuhan pada **pelajarnya**
dan melarang ketergantungan.

## Keputusan

1. **Sesi tutor yang selesai meninggalkan jejak; yang dibatalkan tidak.**
   `LearningTrace` menyimpan empat hal: topik, kedalaman bantuan, tahap
   terdalam, dan waktu. Tidak ada transkrip, tidak ada penilaian, tidak ada
   skor. Membatalkan bukan menyelesaikan—menghitungnya sebagai kemajuan akan
   membuat Harvy mundur dari bantuan justru ketika pelajarnya menyerah.

2. **Kedalaman dibaca dari tangga, bukan dinilai model.** Tangga tutor bergerak
   satu arah dan `stuck` hanya melompat lebih dalam, sehingga tahap saat sesi
   ditutup memang tahap terdalamnya. `assess`/`attempt` → `mandiri`; `hint` →
   `berpetunjuk`; `explain`/`retry` → `dijelaskan`. Keputusan yang mengubah cara
   Harvy membuka sesi harus dapat dibaca dan diuji tanpa memanggil apa pun.

3. **Hanya kind `tutor`.** `clarify`, `prioritize`, `focus`, `plan`, dan
   `human-bridge` bukan pemerolehan kemampuan, dan tahapnya bukan tangga
   kedalaman. Mencatatnya akan menghasilkan angka yang terlihat berarti padahal
   tidak. Pasal 4 berbicara tentang pola bantuan **belajar**, dan itulah
   batasnya.

4. **Yang memudar hanya tahap pembuka.** Ini pembatasan yang paling penting di
   ADR ini. Pasal 3 melarang "sengaja mempersulit pengguna dengan dalih
   membangun kemandirian", dan tabel evaluasi konstitusi menandai "Harvy selalu
   menolak memberi jawaban dengan alasan 'demi kemandirian'" sebagai **perlu
   dirancang ulang**, dengan sebab paternalistik. Karena itu
   `mastery-policy` tidak pernah menolak menjawab, tidak pernah mengunci tahap,
   dan tidak pernah menahan bantuan. Sinyal `stuck` tetap membawa pelajarnya ke
   `hint` lalu `explain` pada giliran yang sama seperti sebelumnya. Yang berubah
   hanya dari mana sesi dimulai: pelajar yang sudah tiga kali mengerjakan
   turunan sendiri tidak perlu ditanya lagi apa yang sudah ia pahami.

5. **Tiga penyelesaian mandiri berturut-turut, dan satu kesulitan
   mengembalikannya.** Sekali berhasil bisa berarti soalnya kebetulan mudah;
   tiga kali berturut adalah pola. Sebaliknya satu sesi yang perlu dijelaskan
   mengembalikan bantuan ke penuh seketika—kesulitan yang baru muncul lebih
   berarti daripada keberhasilan bulan lalu. Jejak yang lebih tua dari 120 hari
   tidak lagi dihitung: kemampuan memudar dan pelajar berganti semester.

6. **Pencocokan topik ketat, dan salah arahnya dipilih sadar.** Dua topik
   dianggap sama hanya bila kata beratinya beririsan sebagian besar. Salah
   menganggap sama berarti mundur pada topik yang belum pernah dikerjakan, dan
   itu kesalahan yang merugikan pelajarnya; salah menganggap beda paling jauh
   berarti satu pertanyaan pembuka yang tidak perlu.

7. **Episode memperoleh field `progress`.** Pasangan `unresolved`: hal yang
   penggunanya berhasil kerjakan, pahami, atau selesaikan **sendiri**, dan hanya
   bila sumber menyatakannya. Bukan pujian, bukan penilaian kemampuan, dan bukan
   pekerjaan yang Harvy yang mengerjakannya. Schema episode naik ke versi 3;
   episode versi 2 tetap dibaca apa adanya dan memperoleh `progress` kosong,
   karena riwayat yang sudah dipadatkan tidak dapat dibuat ulang dari mana pun.

8. **Memori ditulis sebagai fakta, bukan perintah.** Aturan baru di kontrak
   pemahaman: "Lebih suka jawaban ringkas" benar; "Selalu jawab ringkas" salah.
   Kalimat perintah terbaca ulang sebagai aturan berdiri pada giliran-giliran
   berikutnya dan dapat mengalahkan permintaan pengguna saat itu—termasuk ketika
   ia justru meminta kebalikannya. Diambil dari `build_memory_guidance` milik
   Hermes, yang menuliskan sebabnya persis begitu.

9. **Jejak ikut terhapus, tidak ikut ekspor.** `DataControlService.deleteAll`
   menghapusnya bersama sesi. Ia tidak masuk ekspor dengan alasan yang sama
   seperti janji balasan pada ADR-046: nilainya bagi pengguna mendekati nol
   sementara ia menambah field pada kontrak ekspor. Tidak seperti janji balasan,
   jejak ini **berumur panjang**, jadi keputusan itu lebih layak ditinjau ulang
   dan sengaja dicatat di sini sebagai terbuka.

## Yang tidak diputuskan di sini

**Tidak ada permukaan yang menunjukkan lintasan kepada pelajarnya.** Hermes
punya `hermes journey`—garis waktu yang dapat dilihat dan disunting
penggunanya. Harvy punya potret memori, tetapi ia titik waktu. Menunjukkan
"sejauh ini kamu sudah…" adalah bacaan Harvy-native yang paling kuat atas
"grow with you", dan ia menyentuh wilayah yang berbahaya: Larangan Mutlak nomor
12 melarang mengoptimalkan retensi dan keterlibatan, dan papan kemajuan adalah
bentuk klasik dari itu. Ia layak ADR sendiri, bukan diselipkan.

**Tidak ada kadensi tinjauan berkala.** Hermes meninjau tiap 10 giliran atau 10
iterasi tool. Harvy belum memerlukannya: jejaknya lahir dari peristiwa yang
sudah pasti—sesi yang selesai—bukan dari pemindaian berkala. Menambah fork
model berkala akan menambah biaya dan permukaan tanpa pertanyaan yang belum
terjawab.

## Konsekuensi

Yang didapat: Pasal 2 dan langkah kelima Pasal 4 dapat dijalankan untuk pertama
kalinya. Riwayat Harvy merekam sisi kemajuan, bukan hanya sisi masalah. Dan
preferensi lama tidak lagi dapat berubah menjadi perintah yang melawan
permintaan pengguna hari ini.

Yang dibayar: satu berkas JSON baru berisi topik yang pernah dipelajari
seseorang—data pengguna, walau tanpa isi percakapan. Satu pembacaan berkas pada
pembukaan sesi tutor. Dan satu kenaikan schema episode yang wajib mempertahankan
bentuk lama.

Risiko yang diketahui dan diterima: pencocokan topik berbasis kata akan gagal
pada penulisan yang sangat berbeda untuk hal yang sama ("turunan" lawan
"diferensial"), sehingga Harvy kadang membuka penuh padahal tidak perlu. Arah
kegagalan itu dipilih sadar. Pola tulisnya `.tmp` + `rename` dengan antrean
promise—aman satu proses, tidak untuk dua, sama seperti seluruh storage Harvy.
