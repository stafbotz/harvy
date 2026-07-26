# Harvy — Keputusan Proyek dan Backlog

Terakhir diperbarui: 26 Juli 2026.

## Identitas dan produk

- **Harvy** adalah satu-satunya merek yang dilihat pengguna.
- **Ejaannya selalu "Harvy".** "Harvey" adalah ejaan yang jauh lebih umum dalam
  bahasa Inggris, sehingga model AI dan penulis baru cenderung memakainya tanpa
  sadar. Ejaan itu tidak boleh dipakai lagi di mana pun: kode, dokumen, teks
  antarmuka, maupun materi produk.
- **Harvy Capybara** adalah nama internal AI agent untuk belajar dan keseharian.
- **Harvy Chat** adalah nama internal bot hiburan grup WhatsApp.
- **Harvy Core** kelak memuat akun, aturan keselamatan, memori terstruktur, dan
  routing model yang dipakai bersama.

Pengguna yang dituju adalah pelajar Indonesia, terutama Gen Z dan Gen Alpha.
Ini memengaruhi pilihan kanal, gaya bahasa, dan tingkat perlindungan: sebagian
calon pengguna berusia di bawah 18 tahun.

Harvy berwujud kapibara. Sifat yang dibawa karakter itu: tenang, ramah,
tangguh, **dapat hidup berdampingan**, tidak mudah reaktif, tidak menghakimi,
dan terhubung dengan manusia serta dunia nyata. Sifat "dapat hidup
berdampingan" adalah alasan maskotnya kapibara dan bukan hewan lain: Harvy
menempati ruang hidup pengguna tanpa mendominasinya.

Nilai yang menaungi seluruh keputusan: tenang, tangguh, terhubung, mandiri,
jujur, tidak manipulatif, dan menghormati kendali pengguna.

## Kanal

| Sistem | Kanal utama | Status |
|---|---|---|
| Harvy Capybara | Telegram pribadi | Dikerjakan sekarang |
| Harvy Capybara | WhatsApp pribadi | Beta nanti; nomor terpisah |
| Harvy Chat | Grup WhatsApp melalui Baileys | Setelah Capybara MVP |
| Visualisasi | Web | Setelah alur chat terbukti perlu |

## Posisi dan pembeda

Harvy **bukan "ChatGPT murah untuk pelajar"**. Kalau nilai jualnya hanya model
bahasa yang lebih murah, Harvy tidak layak ada; pengguna cukup memakai asisten
umum yang sudah tersedia.

Harvy juga **bukan chatbot yang menunggu pertanyaan**. Pelajar yang kewalahan
sering tidak tahu harus bertanya apa. Harvy diharapkan memahami keadaan yang
belum rapi, membantu menjernihkannya, lalu mengubahnya menjadi langkah kecil
yang dapat dilakukan. Ini pula yang membenarkan Harvy boleh proaktif sama
sekali — selalu dengan izin, sesuai Pasal 4.

Tujuh hal yang membedakan Harvy, dan yang harus diperkuat setiap fitur baru:

1. memahami kehidupan pelajar Indonesia sehari-hari;
2. memahami bahasa dan konteks sekolah;
3. memori yang dikendalikan pengguna;
4. bantuan proaktif yang memakai izin;
5. tutoring yang tidak mengambil alih;
6. keselamatan remaja; dan
7. ukuran keberhasilan yang menilai kemandirian, bukan keterlibatan.

Fitur yang tidak memperkuat satu pun dari tujuh hal ini perlu ditanya ulang:
apakah ia benar-benar membuat Harvy berbeda, atau hanya menambah pekerjaan?

## Masalah pengguna

Masalah yang hendak Harvy selesaikan:

1. tugas administratif dan repetitif yang menumpuk;
2. kebingungan menentukan prioritas dan memulai;
3. kesulitan menemukan cara belajar yang cocok;
4. kesulitan mencari jawaban, sumber, atau orang yang dapat membantu;
5. keadaan emosional yang menghambat tindakan;
6. rencana belajar dan kuliah jangka panjang;
7. kebutuhan akan pendamping yang mengenali kebiasaan dan tujuan, dengan izin;
8. kebutuhan tetap terhubung dengan teman, keluarga, guru, komunitas, dan dunia
   nyata; serta
9. risiko AI melemahkan kemampuan berpikir, kreativitas, keberanian meminta
   bantuan, dan kemandirian.

Nomor 9 berbeda sifatnya dari yang lain: ia adalah masalah yang dapat
**diciptakan** Harvy sendiri, bukan yang dibawa pengguna. Karena itu ia dijaga
oleh Konstitusi, bukan oleh backlog.

Daftar ini belum tervalidasi lewat wawancara; lihat Research Waitlist di bawah.

## Prinsip produk

Seluruh prinsip produk tunduk pada [`CONSTITUTION.md`](CONSTITUTION.md) (Konstitusi Harvy v0.2).

Harvy membantu tetapi tidak mengambil alih. Pengguna tetap menentukan keputusan,
boleh melihat serta menghapus data, dan harus memberi izin sebelum Harvy
melakukan tindakan proaktif. Harvy bukan terapis, psikolog, dokter, alat
diagnosis, atau pengganti bantuan darurat dan hubungan manusia.

## Now — Sprint 1

Tujuan: satu pengguna dapat memasukkan tugas nyata, melihat apa yang perlu
dikerjakan, memasang pengingat, dan menandainya selesai.

- [x] Fondasi Node.js + TypeScript.
- [x] Bot Telegram khusus chat pribadi.
- [x] Tambah, daftar, dan selesaikan tugas.
- [x] Pengurutan prioritas transparan berdasarkan tenggat dan kepentingan.
- [x] Pengingat hanya atas permintaan pengguna.
- [x] Penyimpanan lokal terpisah per pengguna.
- [x] Tes unit untuk prioritas, layanan, dan penyimpanan. Tes parser terhapus
  bersama jalur berbasis aturan pada ADR-004, digantikan tes untuk pembacaan
  balasan model, kebijakan routing, dan rotasi kunci.
- [x] Buat bot melalui BotFather dan pasang token. Harvy berjalan sungguhan
  pertama kali pada 26 Juli 2026.
- [x] Uji manual dengan satu akun Telegram. Pencatatan tugas, tombol Selesai,
  dan pengiriman pengingat sudah teramati; pengingat dilaporkan pengguna, bukan
  penulis kode.
- [ ] Uji mandiri selama tujuh hari dengan tugas nyata.

### Definition of Done

Sprint 1 selesai ketika bot berjalan tujuh hari tanpa kehilangan data, seluruh
perintah utama dapat digunakan dari ponsel, pengingat datang pada waktu yang
benar, dan pengguna dapat memahami urutan prioritas tanpa penjelasan tambahan.

## Next — Sprint 2

- [x] Alur percakapan bahasa alami agar pengguna tidak perlu menghafal format.
  Lihat [`decisions/ADR-002-percakapan-bahasa-alami.md`](decisions/ADR-002-percakapan-bahasa-alami.md).
- [x] Bubble yang dipenggal dapat digabung menjadi satu giliran, dan balasan
  panjang dapat dikirim sebagai beberapa bubble. Lihat
  [`ADR-007`](decisions/ADR-007-bubble-dan-riwayat-percakapan-natural.md).
- [x] Tombol tindakan cepat untuk selesai, ingatkan, ubah tenggat, dan batalkan.
- [ ] Tombol adaptif yang disusun AI menurut keadaan percakapan, menggantikan
  papan tombol tetap. Percakapan dan tombol adalah antarmuka utama Harvy
  Capybara, bukan perintah `/`, sehingga tindakan yang ditawarkan tidak
  seharusnya ditentukan sekali di kode untuk semua keadaan.
- [x] Pengenalan maksud agar curhat, pertanyaan, dan permintaan yang harus
  dikerjakan Harvy tidak berubah menjadi tugas pengguna.
- [ ] Waktu bawaan tombol Ingatkan masih ditetapkan Harvy, bukan pengguna.
  Pasal 4 meminta pengguna yang menentukan.
- [ ] Penyimpanan PostgreSQL serta migrasi data.
- Preferensi zona waktu per pengguna.
- Ekspor dan hapus seluruh data pengguna.
- Observabilitas tanpa mencatat isi pesan sensitif.
- Deployment dan backup.
- [x] Kebijakan routing model dan konfigurasi tiga tingkatan. Lihat
  [`decisions/ADR-003-routing-model.md`](decisions/ADR-003-routing-model.md).
- [x] Seluruh percakapan diproses model AI; jalur berbasis aturan dihapus. Lihat
  [`decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md`](decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md).
- [x] Memasang pembungkus anti-injeksi, menyambungkan `remindAt` ke pembuatan
  tugas, dan menyalakan mode JSON penyedia. Ketiganya sudah ditulis tetapi tidak
  pernah tersambung.
- [ ] Memindahkan penilaian keselamatan ke pemeriksaan tersendiri sebelum
  klasifikasi, sesuai alur teknis di `ADR-003`. Sekarang urutannya terbalik.
- [ ] Memberi tahu pengguna bahwa pesannya diproses penyedia model pihak ketiga,
  dan meminta persetujuannya. Dijamin Konstitusi Pasal 3.9.
- [x] Riwayat percakapan, agar tutoring bertahap benar-benar mungkin. Riwayatnya
  ada sejak 26 Juli 2026 lewat [`ADR-006`](decisions/ADR-006-memori-dan-riwayat-percakapan.md);
  alur lima langkahnya sendiri masih harus ditulis.
- [x] Memori terstruktur per pengguna yang dapat dilihat dan dihapus. Memori
  biasa disimpan otomatis disertai pemberitahuan, memori sensitif hanya dengan
  izin. Lihat `ADR-006`.
- [ ] Pemeriksaan keselamatan sebagai lapisan tersendiri, bukan hanya penilaian
  model. Termasuk penanganan pengguna di bawah 18 tahun.
- [ ] Batas pemakaian dan pemantauan biaya per pengguna.

## Model AI

Harvy memakai tiga tingkatan model yang dipilih menurut **kesulitan pekerjaan,
bukan paket yang dibayar pengguna**. Percakapan keselamatan selalu memakai
tingkatan tertinggi.

| Tingkatan | Rencana model | Dipakai untuk |
|---|---|---|
| `cheap` | DeepSeek V4 Flash | Mengurai tugas, klasifikasi, balasan rutin |
| `efficient` | GPT 5.6 Luna | Percakapan sehari-hari, langkah kecil, penjelasan ringan |
| `ambitious` | GPT 5.6 Terra | Tutoring bertahap, perencanaan panjang, keselamatan |

Produksi memakai OpenRouter sebagai gerbang tunggal agar tagihan tidak tersebar.
Selama pengembangan, `AI_MODE=testing` mengarahkan seluruh tingkatan ke satu
model cepat (Gemini 3.5 Flash-Lite dari Google AI Studio). Menghentikan
mode uji cukup mengubah `AI_MODE` menjadi `production`.

Seluruh ID model berada di `.env`, tidak ditulis di kode. Nama dan harga model
berubah cepat, jadi **verifikasi ejaan persisnya di daftar model penyedia
sebelum dinyalakan**.

## Komponen sistem

Model bahasa bukan keseluruhan Harvy. Model adalah satu komponen yang dapat
diganti; identitas Harvy justru berada di komponen lain. Sepuluh komponen yang
diperlukan Harvy utuh:

| Komponen | Keterangan |
|---|---|
| Pedoman kepribadian | Kepribadian, batas moral, dan gaya bicara |
| Sistem tutoring dan tugas | Pola bantuan bertahap dan pengelolaan pekerjaan |
| Kalender dan pengingat | Waktu, tenggat, dan kontak berizin |
| Memori | Terstruktur, dapat dilihat dan dihapus pengguna |
| Keselamatan dan moderasi | Lapisan tersendiri, bukan hanya prompt |
| Database | Penyimpanan yang tahan pertumbuhan |
| Pencarian atau RAG | Sumber di luar ingatan model, untuk informasi yang harus benar |
| Kanal | Telegram, WhatsApp, dan website |
| Analitik | Tanpa mencatat isi pesan sensitif |
| Kontrol privasi | Persetujuan, ekspor, dan penghapusan |

Kepribadian, aturan tutoring, keselamatan, memori, dan identitas merek **wajib
berada di lapisan Harvy**, bukan menempel pada satu model. Konstitusi Pasal 3.13
menuntut model dapat diganti tanpa mengubah siapa Harvy. Keadaan tiap komponen
saat ini ada di [`engineering/STATUS.md`](engineering/STATUS.md); sebagian besar
belum dimulai.

## Website

Website bukan kanal percakapan, melainkan tempat untuk hal yang memang lebih
baik dilihat daripada dibicarakan. Dibangun setelah alur chat terbukti perlu.

Isi yang direncanakan: daftar tugas, kalender, prioritas, peta belajar,
perkembangan, tujuan jangka panjang, memori, izin, notifikasi, dan ruang belajar
bersama.

Ruang belajar bersama mempertemukan pengguna satu sama lain, sehingga tunduk
pada Pasal 5 nomor 10: memerlukan verifikasi, moderasi, pelaporan, pemblokiran,
dan perlindungan tambahan sebelum boleh ada. Hal yang sama berlaku untuk
pencocokan teman dan perencanaan kuliah bersama.

## Monetisasi

Belum dikerjakan, tetapi arahnya sudah ditetapkan agar tidak diputuskan
tergesa-gesa saat biaya mulai terasa.

Tujuan awal bisnis bukan pendapatan, melainkan:

1. membuktikan manfaat nyata;
2. memahami biaya per pengguna;
3. mengetahui pola penggunaan;
4. mencegah pertumbuhan yang merugikan; dan
5. menguji kemauan membayar.

Nama paket harus punya cerita dan estetika yang cocok dengan Harvy, kapibara,
bunga, dan selera Gen Z. Nama generik seperti "Pro", "Plus", atau "Max"
**ditolak** — bukan karena selera, melainkan karena nama seperti itu memisahkan
pengalaman membayar dari karakter produknya.

Keuntungan boleh menopang keberlanjutan Harvy, tetapi tidak boleh mengalahkan
keselamatan, privasi, kejujuran, atau agensi pengguna. Konstitusi Pasal 3.13 dan
Pasal 6 berlaku penuh di sini.

## Research Waitlist

Wawancara pelajar ditunda karena responden masih sulit ditemukan. Pekerjaan ini
tidak memblokir prototipe, tetapi harus dilakukan sebelum klaim kebutuhan luas
atau peluncuran publik.

- [ ] Tiga wawancara percobaan.
- [ ] Dua belas sampai lima belas wawancara kebutuhan.
- [ ] Enam sampai delapan uji konsep setelah purwarupa siap.
- [ ] Validasi apakah Telegram benar-benar kanal yang dibuka setiap hari.
- [ ] Validasi toleransi terhadap memori, notifikasi proaktif, dan gaya bahasa.
- [ ] Uji apakah akar masalahnya tugas menumpuk, informasi tersebar, sulit
  memulai, instruksi tidak jelas, atau akses bantuan.

Pemicu untuk mengaktifkan kembali riset: tersedia minimal tiga responden yang
bersedia dan proses persetujuan peserta/wali sudah siap.

## Later

- Pendamping belajar berbasis petunjuk bertahap.
- Check-in ringan dan refleksi.
- Menyunting memori, bukan hanya melihat dan menghapusnya. Pasal 4 nomor 4
  menyebut "mengubah", dan itu bagian yang belum ada.
- Pencarian atau RAG, agar informasi yang harus benar tidak bergantung pada
  ingatan model.
- Harvy Chat di grup WhatsApp: permainan, poin, polling, dan fitur komunitas.
- Harvy Market sebatas katalog, pencarian, reputasi, dan pelaporan; belum
  menangani atau menjamin transaksi.

## Tidak dikerjakan sekarang

- WhatsApp personal sebagai kanal utama.
- Escrow atau penyelesaian sengketa.
- Diagnosis kesehatan mental.
- Penyimpanan otomatis informasi sensitif.
- Tindakan proaktif tanpa persetujuan.
- Rotasi nomor untuk menghindari pembatasan platform.
