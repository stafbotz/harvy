# ADR-008: Rencana Giliran dan Mutasi yang Fail-Closed

- Status: Disahkan
- Tanggal: 27 Juli 2026
- Pemilik keputusan: pengguna Harvy
- Terkait: `ADR-002`, `ADR-003`, `ADR-004`, `ADR-006`, `ADR-007`,
  Konstitusi Pasal 3, 4, dan 5

> **Supersesi parsial 8 Agustus 2026.** [`ADR-021`](ADR-021-emergency-preflight-dan-boundary-local-first.md)
> menambah emergency preflight lokal berpresisi tinggi sebelum debounce.
> Keputusan ini hanya mempercepat acknowledgment; triase penuh, review sesuai
> policy, mutation gate, consent, dan FIFO fail-closed di ADR ini saat itu tidak
> berubah.

> **Supersesi parsial lanjutan 8 Agustus 2026.**
> [`ADR-022`](ADR-022-selective-safety-routing-dan-privacy-memory.md) mengganti
> keputusan 6 dan 12 serta amandemen 1, 6, dan 9 untuk chat privat: outage
> menjadi disposition `unavailable`, acute triage dan review selektif, privacy
> memory terpisah, pending closed-set dapat melewati triase umum, dan izin
> dinilai per efek. Danger, bukti kuat unresolved, consent, delivery rollback,
> serta port grup lama tetap fail-closed.

## Konteks

Audit percakapan menemukan bahwa ekstraksi, balasan, tombol, tugas, memori,
sesi, dan keselamatan mengambil keputusan terpisah. Dalam satu probe, pengguna
meminta Harvy memilih prioritas tanpa bertanya balik, tetapi model sekaligus
mengusulkan penyimpanan tugas. Adapter akan mengubah data, balasan memberi satu
arah, dan tombol yang relevan justru hilang.

Audit yang sama menemukan triase gagal dapat terlihat tenang, sesi lama dapat
menguasai topik baru selama tujuh hari, “Dengerin dulu” tidak bertahan ke
giliran berikutnya, dan satu false positive dukungan dapat menjadi catatan
tersembunyi serta rujukan profesional beberapa hari kemudian.

## Keputusan

1. Keluaran model adalah usulan, bukan izin. Tugas hanya boleh langsung ditulis
   bila teks pengguna sendiri meminta pencatatan atau pengingat dan membawa isi
   tugas yang konkret. Permintaan memilih prioritas dan “buat pengingat dong”
   tidak mengubah data.
2. Konfirmasi tugas tersirat membawa token per proposal, terikat pemilik,
   kedaluwarsa, dan sekali pakai. Tombol lama tidak boleh menyetujui proposal
   baru.
3. Tindakan adaptif direncanakan sebelum balasan, maksimum satu. Model diberi
   tahu label yang benar-benar akan muncul. Tujuannya memakai `actionGoal` atau
   judul tugas konkret, bukan salinan curhat. Jika balasan masih menunggu
   jawaban bebas, tombol disembunyikan.
4. “Dengerin dulu” menyimpan preferensi `listen` sampai pengguna memilih
   “Langsung saran”. Pada cerita biasa, mode ini menahan tindakan
   produktivitas.
5. Sesi adalah konteks lunak. Hanya pesan yang berkaitan, rujukan eksplisit,
   atau jawaban pendek yang masuk ke prompt sesi. Topik lain tidak menghapus
   sesi, tetapi juga tidak ditarik kembali ke tujuan lama. `done` dan `cancel`
   hanya mengubah state bila kata pengguna sendiri jelas.
6. Triase `null`, timeout, atau JSON rusak naik ke jalur `dukungan` yang belum
   pasti. Balasannya direview, sementara tugas, memori, pending, dan kemajuan
   sesi gagal tertutup.
7. Sebelum persetujuan, hanya pesan pertama boleh menjalani triase eksternal.
   Urutannya diserialisasi per pemilik. Bubble berikutnya ditahan lokal dan
   mendapat arahan bersyarat. Tombol “Aku sedang nggak aman” selalu tersedia
   dan memakai teks tetap tanpa mengirim bubble tambahan ke model.
8. Hasil classifier `urgent` boleh mengirim acknowledgment tetap di luar FIFO.
   Pemrosesan penuh dan mutasi tetap berurutan agar state tidak korup.
9. Ketersediaan 112 selalu dijelaskan oleh teks milik kode: hanya di daerah
   yang sudah mengoperasikannya; bila tidak tersambung, gunakan jalur darurat
   setempat. Catatan itu ditempel sebelum review balasan bahaya.
10. Catatan tersembunyi hanya ditulis untuk triase `bahaya` yang berhasil
    diparse dan setelah balasan terkirim. Catatan `dukungan`, inferensi gaya/
    tahap/kerentanan latar, dan nudge profesional otomatis ditangguhkan. Catatan
    bahaya memiliki retensi fisik 30 hari.
11. Seluruh giliran mentah yang belum diringkas ikut prompt, dengan hard cap 24
    sebagai fail-safe. Teks model dinormalisasi menjadi teks Telegram biasa di
    luar blok kode sebelum dikirim dan disimpan ke riwayat.
12. Jawaban pending melewati classifier/ekstraksi umum: setelah burst pendek,
    ia hanya menjalani triase dan parser khusus. Telemetry menulis di latar,
    tetapi kuota, ekspor, penghapusan, dan shutdown tetap memperhitungkan atau
    menguras antreannya.
13. Gerbang kualitas mencakup adapter `bot.handleUpdate` dengan API Telegram
    palsu dan corpus 42 skenario sintetis. Corpus model nyata tetap manual dan
    tidak boleh mengirim data pengguna.

## Konsekuensi

- Salah klasifikasi model tidak lagi cukup untuk mengubah data pengguna.
- Harvy dapat kehilangan satu tombol atau menunda mutasi ketika triase gagal;
  ini biaya yang disengaja untuk agensi dan keselamatan.
- Acknowledgment urgent memperbaiki waktu respons yang terlihat, tetapi belum
  merupakan pembatalan kooperatif request model yang sedang aktif.
- Preferensi `listen` bertahan lintas restart dan dapat diubah dari pusat
  kontrol data.
- Catatan dukungan lama tidak lagi memengaruhi persona. Kemampuan mengangkat
  bantuan profesional beberapa hari kemudian sengaja dinonaktifkan sampai
  false positive dievaluasi dengan pengguna.
- Evaluasi model nyata memerlukan persetujuan khusus untuk mengirim corpus dan
  prompt ke penyedia eksternal; gerbang otomatis tetap bebas jaringan.

## Amandemen review regresi — 28 Juli 2026

Review read-only setelah implementasi menemukan beberapa keputusan di atas
belum tertutup pada batas delivery dan pekerjaan latar. Keputusan tambahannya:

1. Keselamatan menang atas seluruh route kontrol dan sesi. Pada triase
   non-biasa atau belum pasti, hasil operasional ekstraksi dibuang, sesi tidak
   masuk prompt, dan pemeriksa akhir menerima konteks episode serta flag
   `alone`.
2. Callback izin memori sensitif membawa token proposal. Catatan biasa yang
   sudah ditulis tetapi gagal diumumkan lewat Telegram dibatalkan; pertanyaan
   gaya, sesi baru, dan tahap sesi baru baru di-commit setelah pesan yang
   mewakilinya berhasil dikirim.
3. Ingress pesan, triase/intro, dan callback persetujuan memakai satu rantai per
   pemilik. Pesan yang tiba selama `acceptConsent` tidak boleh lolos di antara
   dua snapshot state.
4. Penghapusan penuh lebih dulu memblokir request telemetry/model, menunggu
   pemadatan riwayat aktif, lalu memblokir append/compact baru sampai
   persetujuan berikutnya. Drain telemetry menunggu antrean eksklusif dan flush
   lanjutan; kegagalan writer tetap merupakan kegagalan.
5. Pengingat hasil ekstraksi langsung tunduk pada jam tenang yang sama dengan
   alur tombol. Pagar sesi lunak menerima bentuk jawaban eksplisit seperti
   “karena …”, tetapi tidak menganggap semua kalimat pendek sebagai lanjutan.
6. Tidak ada klaim bahwa semua isi sensitif dapat dikenali tanpa salah. Jenis
   `personal` atau flag triase sensitif selalu meminta izin, tetapi salah
   klasifikasi serentak oleh kedua model tetap keterbatasan terbuka selama
   keputusan produk mempertahankan pengenalan berbasis model tanpa pagar lokal.
7. Konfirmasi Lupakan semua, tarik persetujuan, dan hapus seluruh data membawa
   token pending sekali pakai. Seluruh prompt pending dibatalkan bila Telegram
   gagal mengirimnya; callback lama tidak boleh menghapus data yang dibuat
   setelah prompt awal.
8. Penarikan persetujuan memakai rantai pemilik yang sama dengan ingress dan
   penerimaan persetujuan. Ia mempertahankan tugas, memori, sesi, dan check-in;
   worker check-in menahan pengiriman sampai persetujuan diberikan kembali.
9. Konflik ketika ekstraksi menandai sensitif tetapi triase berkata biasa
   diperlakukan sebagai triase belum pasti. Reviewer menerima flag `certain`
   dan dilarang mengarang bahwa orang tua, guru, keluarga, atau teman pasti
   aman. Kegagalan review memakai fallback terpisah: jalur dukungan tidak
   menerima copy bahaya/112, sedangkan jalur bahaya mempertahankan batas
   layanan darurat.
10. Kata generik “masih”, “belum”, “udah”, dan “sudah” bukan bukti bahwa topik
    baru berkaitan dengan sesi. Sinyal `done` hanya sah bila kalimat selesai
    merujuk sesi atau tumpang tindih dengan tujuannya.
11. Inferensi tersembunyi gaya/tahap/kerentanan warisan dihapus fisik saat
    catatan lama dibaca. Jalur `refresh` tidak lagi memanggil model. Bila
    pembuka sesi sudah terkirim tetapi penyimpanan gagal, state parsial
    dibersihkan dan keyboard dilepas sebagai kompensasi terbaik.
12. Kegagalan membaca kandidat reminder/check-in ditangkap per tick agar worker
    dapat mencoba lagi. Shutdown menghentikan sumber kerja dan menunggu worker
    aktif sebelum drain akhir bot/telemetry, sebab worker dapat menambahkan
    pekerjaan terakhir setelah Telegram berhenti menerima update.
13. Evaluator sintetis harus memeriksa larangan saran/tombol pada mode
    menyimak, kedalaman jawaban cerita panjang, dan sinyal selesai sesi, serta
    mencerminkan precedence keselamatan produksi. Ia tetap bukti struktur,
    bukan pengganti uji model atau Telegram nyata.
