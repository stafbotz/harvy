# ADR-002: Percakapan Bahasa Alami Menggantikan Perintah Berformat

- Status: Superseded sebagian
- Tanggal: 26 Juli 2026
- Pemilik keputusan: pengguna Harvy
- Diganti sebagian oleh: [`ADR-004`](ADR-004-percakapan-sepenuhnya-lewat-ai.md)

> **Catatan.** Keputusan menghapus perintah berformat, menyembunyikan ID teknis,
> memakai tombol, dan meminta persetujuan sebelum mencatat **tetap berlaku**.
> Yang dibatalkan adalah keputusan memakai aturan alih-alih model AI; modul
> `src/core/input-parser.ts` sudah dihapus beserta `tests/input-parser.test.ts`.
> Lihat `ADR-004`.
>
> **Koreksi 26 Juli 2026.** Catatan ini sebelumnya menyebut modul `intent.ts`,
> `natural-language.ts`, dan `time.ts`, yang tidak ditemukan pada commit mana pun
> dalam riwayat Git repositori ini.

## Konteks

Konstitusi Harvy v0.2 disahkan pada 26 Juli 2026. Pasal 3.11 menyatakan bahasa
alami adalah cara utama berinteraksi dan pengguna tidak boleh dipaksa menghafal
perintah, format tanggal, kode, atau ID teknis. Tabel Contoh Penerapan bahkan
menilai **Lulus** untuk desain "menulis tugas dengan bahasa alami lalu memilih
tombol Ubah atau Batalkan", dengan alasan tidak menampilkan ID teknis.

Implementasi v0.1 melanggar pasal itu pada tiga titik sekaligus:

1. tugas hanya dapat dicatat dengan format `/tambah judul | YYYY-MM-DD HH:mm |
   tinggi`;
2. ID heksadesimal delapan karakter ditampilkan dan harus diketik ulang untuk
   `/selesai` maupun `/ingatkan`; dan
3. pesan bebas ditolak dengan permintaan agar pengguna membuka `/bantuan`.

Konteks produk juga menegaskan Harvy bukan tiga fitur terpisah, melainkan satu
pengalaman percakapan yang berpindah antara kewajiban, belajar, keputusan,
keadaan diri, dan permintaan bantuan. Manajemen tugas adalah pintu masuk, bukan
keseluruhan produk.

## Keputusan

1. Pesan bebas menjadi cara utama memakai Harvy. Perintah tersisa hanya
   `/start`, `/tugas`, dan `/bantuan`.
2. Perintah `/tambah`, `/selesai`, dan `/ingatkan` beserta format pemisah `|`
   dihapus sepenuhnya, bukan disembunyikan. ID tidak lagi ditampilkan, sehingga
   perintah berbasis ID tidak akan dapat dipakai siapa pun dan hanya akan
   menyesatkan.
3. Seluruh tindakan berjalan lewat tombol inline: Selesai, Ingatkan, Ubah
   tenggat, dan Batalkan. ID tugas dibawa diam-diam dalam `callback_data`.
4. Penerjemahan bahasa alami memakai aturan, bukan model AI. Harvy tetap dapat
   diuji tanpa biaya inferensi, sesuai batas v0.1.
5. **Maksud pesan dikenali sebelum apa pun dicatat.** Pesan bebas tidak otomatis
   menjadi tugas. Ketika Harvy tidak yakin, ia bertanya dan menunggu tombol
   persetujuan.
6. Ketika pesan berisi keluhan atau kelelahan, Harvy menanggapi keadaan itu
   lebih dulu dan hanya *menawarkan* mencatat pekerjaan yang tersirat.
7. Ketika pesan berupa pertanyaan pelajaran, Harvy mengaku belum bisa
   menjelaskan materi alih-alih menebak.

## Alasan keputusan nomor 5

Ini yang paling menentukan. Tanpa pengenalan maksud, seorang pelajar yang
menulis "aku capek banget hari ini" akan mendapati Harvy membuat tugas berjudul
"Aku capek banget hari ini".

Perilaku itu melanggar Pasal 3.11 karena bertindak tanpa menunjukkan
konsekuensi, dan melanggar semangat Pasal 3.7 karena memperlakukan curhat
sebagai pekerjaan administratif. Karena itu default-nya adalah bertanya.
Lebih baik Harvy bertanya sekali daripada mencatat sesuatu yang tidak diminta.

## Konsekuensi

Positif:

- Pengguna tidak perlu menghafal apa pun untuk mulai memakai Harvy.
- Tidak ada ID teknis yang terlihat.
- Curhat, pertanyaan, dan tugas ditangani berbeda, sehingga Harvy terasa seperti
  satu teman bicara, bukan formulir.
- Biaya inferensi tetap nol.

Trade-off:

- Parser berbasis aturan pasti kalah luwes dibanding model bahasa. Ia akan gagal
  pada kalimat di luar pola yang dikenali. Harvy menanganinya dengan mengakui
  ketidaktahuan, bukan menebak.
- Kosakata parser condong ke bahasa Indonesia sehari-hari dan gaul ringan. Bahasa
  daerah, campur kode yang berat, dan singkatan tidak lazim belum tertangani.
- Langkah percakapan yang menggantung disimpan di memori proses dan hilang saat
  restart. Ini dipilih agar Harvy tidak menyimpan lebih banyak dari yang perlu.
- Lapisan bot belum punya tes otomatis; yang teruji adalah inti di `src/core/`.

## Alternatif yang ditolak

- **Mempertahankan perintah lama sebagai cadangan.** Ditolak karena ID tidak
  lagi ditampilkan, sehingga jalur itu mati dalam praktik tetapi tetap harus
  dirawat dan diuji.
- **Menunggu integrasi model AI sebelum menerima bahasa alami.** Ditolak karena
  menunda pemenuhan Pasal 3.11 tanpa alasan yang kuat, padahal sebagian besar
  kalimat pelajar tentang tugas cukup sederhana untuk diurai dengan aturan.
- **Mencatat setiap pesan bebas sebagai tugas lalu menyediakan tombol Batalkan.**
  Ditolak karena memindahkan beban koreksi kepada pengguna dan memperlakukan
  curhat sebagai pekerjaan.

## Yang belum diputuskan

- Waktu bawaan tombol Ingatkan. Sementara ini satu jam sebelum tenggat, dipilih
  agar paket dapat berjalan. Pasal 4 menyatakan pengguna yang menentukan jenis
  dan frekuensi pengingat, jadi ini masih perlu keputusan pemilik produk.
- Ekspor dan penghapusan seluruh data pengguna, yang dijamin Pasal 2.5 dan
  Pasal 4 tetapi belum ada implementasinya.
- Alur keselamatan untuk risiko serius. Konteks produk menegaskan prompt
  karakter saja tidak cukup, dan sebagian pengguna dapat berusia di bawah 18
  tahun.
