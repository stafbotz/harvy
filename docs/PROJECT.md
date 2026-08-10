# Harvy — Keputusan Proyek dan Backlog

Terakhir diperbarui: 9 Agustus 2026.

## Identitas dan produk

- **Harvy** adalah satu-satunya merek yang dilihat pengguna.
- **Ejaannya selalu "Harvy".** "Harvey" adalah ejaan yang jauh lebih umum dalam
  bahasa Inggris, sehingga model AI dan penulis baru cenderung memakainya tanpa
  sadar. Ejaan itu tidak boleh dipakai lagi di mana pun: kode, dokumen, teks
  antarmuka, maupun materi produk.
- **Harvy adalah satu produk**, baik dalam percakapan pribadi maupun grup.
  “Harvy Capybara” dan “Harvy Chat” tidak lagi menjadi nama agent atau produk
  terpisah.
- **Kapibara adalah maskot, ikon, dan filosofi Harvy.** Ia membentuk sifat dan
  bahasa visual produk, bukan nama mode.
- **Capybara adalah nama sistem model Harvy.** Ketika ditanya AI/model apa yang
  dipakai, Harvy menjawab “model Capybara”: lapisan Harvy yang merutekan
  beberapa model sesuai kebutuhan, bukan nama satu foundation model atau satu
  penyedia. Harvy tetap jujur bahwa dirinya AI.
- Lapisan inti Harvy memuat akun, aturan keselamatan, memori terstruktur,
  kemampuan percakapan, dan routing model yang dipakai bersama oleh semua
  kanal. “Harvy Core” boleh menjadi istilah arsitektur internal, bukan merek
  yang dilihat pengguna.
- Sejak `ADR-012`, lapisan itu juga mempunyai satu capability catalog, scope
  bertipe, context budget, dan kernel agent berbatas untuk seluruh kanal.
  Model hanya mengusulkan tindakan; kode, kebijakan, persetujuan, dan executor
  yang menentukan apa yang sungguh dijalankan. Katalog yang sama tidak boleh
  menyamarkan adapter yang belum ada: Telegram grup dan WhatsApp privat tetap
  belum tersedia.

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

| Pengalaman | Kanal | Status |
|---|---|---|
| Harvy pribadi | Telegram | Dikerjakan sekarang |
| Harvy di grup | Telegram | Nanti; belum dimulai |
| Harvy di grup | WhatsApp melalui Baileys | Fondasi beta lokal; satu nomor tersambung dan membalas grup nyata, ambient/direct teruji otomatis dan sintetis, perilaku lengkap belum diuji di grup nyata |
| Harvy pribadi | WhatsApp melalui Baileys | Beta nanti |
| Visualisasi | Web | Setelah alur chat terbukti perlu |

WhatsApp dirancang untuk dapat memakai **banyak nomor Harvy**. Setiap nomor
adalah sesi Baileys terisolasi dengan auth state, koneksi, kesehatan, dan
identitas operasionalnya sendiri, sementara kemampuan Harvy, kebijakan, dan
penyimpanan domain tetap dibagi melalui lapisan layanan yang sama. Grup harus
terikat pada nomor yang menanganinya agar reconnect atau kegagalan satu nomor
tidak memindahkan identitas Harvy secara diam-diam.

Banyak nomor dipakai untuk pembagian beban, isolasi kegagalan, dan pengelolaan
operasional yang sah. Ia **tidak** boleh menjadi rotasi otomatis untuk
menghindari pembatasan, pemblokiran, penegakan aturan, atau ketentuan WhatsApp.
Baileys adalah klien tidak resmi berbasis WhatsApp Web; risiko perubahan
protokol, putus sesi, pemblokiran, dan kompatibilitas adalah risiko produk yang
harus diuji, dipantau, dan tidak disamarkan sebagai jaminan.

Fondasi beta 29 Juli 2026 mengelola seluruh nomor dalam **satu proses** karena
repository berkas Harvy belum aman untuk multi-proses. Setiap akun mempunyai
auth namespace, socket, generation guard, backoff, pairing, cache metadata, dan
shutdown sendiri. Binding grup persisten menolak dua akun menangani grup yang
sama; kegagalan satu akun tidak memindahkan grup ke akun lain.

Pipeline grup memisahkan state per kanal+grup, menggabungkan burst bubble satu
anggota, mempertahankan pasangan PN/LID, dan memilih giliran ambient melalui
planner sosial. Planner boleh merespons tanpa tag bila kontribusinya benar-benar
bernilai, tetapi memberi ruang manusia lewat budget adaptif, pagar bentuk
giliran, serta revalidation kandidat yang tersusul setelah semua bubble terlihat
selesai diproses. Panggilan direct membatalkan planner maupun revalidation
ambient aktif dan memakai jalur batch lebih cepat. Removal dilindungi
generation guard, sementara cache metadata/admin dilindungi generation socket
dan epoch per grup. Membership pengirim serta Harvy sendiri diverifikasi dari
metadata segar sebelum ingress; event perubahan authority menghapus cache dan
membatalkan batch/pending secara sinkron agar role lama tidak dapat dipasangkan
dengan epoch baru. Konteks mentah hanya di RAM sampai 24 giliran atau dua jam
dan tidak menerima giliran yang ditandai sensitif/berisiko. Statistik aktivitas
dibatasi 30 hari, dedupe 24 jam, ranking 7 hari, dan seluruh memori sosial
dihapus saat Harvy dikeluarkan atau dinonaktifkan. Pesan direct juga dapat
menghasilkan memori semantik biasa yang terpisah per anggota dan per grup;
memori itu diumumkan, dapat dilihat/dikoreksi/dihapus anggota, tidak dibawa ke
ruang lain, dan isi sensitif tidak boleh disimpan otomatis. Lihat
[`ADR-011`](decisions/ADR-011-partisipasi-natural-dan-evaluasi-grup.md) dan
[`ADR-012`](decisions/ADR-012-harness-agent-dan-scope-memori.md). Sejak
[`ADR-016`](decisions/ADR-016-scope-dan-otoritas-v1.md), anggota juga dapat
mengusulkan keputusan, agenda, norma, kegiatan, atau catatan ruang dengan
preview persis; admin terkini harus mengonfirmasi sebelum catatan bersama itu
disimpan selama 60 hari. Reset admin hanya menghapus profil sosial dan catatan
bersama, bukan member-local memory.

Auth state beta memakai adapter multi-file Baileys di folder yang diabaikan
Git. Bentuk itu memadai untuk pengembangan lokal tetapi bukan penyimpanan
produksi: auth linked-device adalah kredensial jangka panjang dan kelak wajib
dipindah ke database terenkripsi dengan single writer, kontrol akses, backup,
dan audit yang sesuai. Pairing awal memakai QR yang dirender lokal di terminal
interaktif sebagai default pengembangan; `APP_ENV=production` dan stdout
noninteraktif tidak pernah menampilkannya. Pairing code tetap tersedia secara
eksplisit pada jalur operator lokal, tetapi tidak menjadi default karena
kegagalan upstream Baileys masih dapat menutup koneksi sebelum code diterima.

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

Seluruh prinsip produk tunduk pada [`CONSTITUTION.md`](CONSTITUTION.md)
(Konstitusi Harvy v0.5).

Harvy membantu tetapi tidak mengambil alih. Pengguna tetap menentukan keputusan,
boleh melihat serta menghapus data, dan harus memberi izin sebelum Harvy
melakukan tindakan proaktif. Pengecualian keselamatan v0.3 mengatur pemeriksaan
bahaya pesan pertama dan catatan keselamatan tersembunyi. Pengecualian grup
v0.4 mengizinkan pemrosesan pesan baru tanpa consent individual setelah
pengelola memasukkan Harvy, dengan pemberitahuan, isolasi grup, dan kendali
memori. Harvy bukan terapis, psikolog, dokter, alat diagnosis, atau pengganti
bantuan darurat dan hubungan manusia.

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
- [x] Boundary local-first untuk bentuk satu bubble yang jelas, fallback model
  untuk ambiguitas, serta emergency acknowledgment sebelum debounce. Pertanyaan
  waktu tanpa episode hangat juga tidak lagi membayar understanding/triage.
  Lihat [`ADR-021`](decisions/ADR-021-emergency-preflight-dan-boundary-local-first.md).
- [x] Safety routing privat selektif melalui `RiskHint`, disposition
  `unavailable`, privacy-memory classifier candidate-only, conditional review,
  pending/ack fast path sempit, serta izin per efek yang mempertahankan kontrol
  eksplisit atas data sendiri. Lihat
  [`ADR-022`](decisions/ADR-022-selective-safety-routing-dan-privacy-memory.md).
- [x] Debounce adaptif content-free mengikuti p90 gap bubble per pemilik atau
  anggota+scope grup setelah sampel minimum, termasuk lintas batch yang sudah
  ter-flush, dengan TTL/cap in-memory dan fallback timing lama. Speaker switch
  memutus sampel grup; jendela semantik open/incomplete belum dipendekkan.
  Lihat [`ADR-023`](decisions/ADR-023-adaptive-debounce-per-subjek.md).
- [x] Safety grup selektif melalui `riskHint`, privacy raw-context terpisah,
  memory-privacy candidate-only, authority sebelum model, conditional review,
  serta emergency bypass debounce yang tetap tunduk binding dan notice.
  Lihat
  [`ADR-024`](decisions/ADR-024-selective-safety-dan-privacy-ingress-grup.md).
- [x] Tombol tindakan cepat untuk selesai, ingatkan, ubah tenggat, dan batalkan.
- [x] Tombol adaptif menurut keadaan percakapan. Model hanya boleh mengusulkan
  ID tindakan dari daftar tertutup; kode memilih maksimum satu sebelum balasan
  dibuat, memberi tahu model labelnya, dan menyembunyikannya bila ada pertanyaan
  bebas. Tujuan memakai `actionGoal`, bukan curhat mentah. Kepemilikan,
  kedaluwarsa, dan pencegahan klik ganda dijaga kode.
- [x] Pengenalan maksud agar curhat, pertanyaan, dan permintaan yang harus
  dikerjakan Harvy tidak berubah menjadi tugas pengguna.
- [x] Izin mutasi tugas diperiksa dari teks pengguna, bukan label model saja.
  Permintaan prioritas dan pengingat kosong tidak menulis data; konfirmasi tugas
  tersirat bertoken dan terikat proposal.
- [x] Waktu pengingat dan check-in dipilih pengguna. Harvy menanyakan waktunya,
  menolak waktu lampau atau jam tenang, dan tidak menggesernya diam-diam.
- [ ] Penyimpanan PostgreSQL serta migrasi data.
- [x] Preferensi zona waktu WIB, WITA, atau WIT dan jam tenang per pengguna.
- [x] Ekspor data yang terlihat pengguna, penarikan persetujuan, serta
  penghapusan seluruh data termasuk catatan tersembunyi.
- [x] Observabilitas pemakaian dan biaya tanpa mencatat isi pesan, prompt,
  atau balasan. Retensi dan routing model berasal dari environment; harga
  provider+model dikelola sebagai versi append-only di Console, dengan nilai
  environment lama hanya sebagai bootstrap. Sejak ADR-020, free-text Telegram
  juga mempunyai baseline per giliran: korelasi boundary→handler, waktu tunggu
  batch/FIFO/handler/total, model-call rate, safety fallback, serta ringkasan
  p50/p95 tanpa menyimpan isi. ADR-022 menambah purpose privacy-memory sebagai
  overhead dan `safeActionBlockedRate`. Dashboard agregat dan TTFR terpisah
  belum ada.
- [x] Log operasional produksi terpisah dari telemetry: NDJSON terstruktur,
  trace per giliran, allowlist scalar tanpa pesan error bebas, redaksi
  isi/identitas/kredensial, rotasi ukuran+hari, retensi dan batas disk,
  jalur darurat berbatas, fallback stderr, antrean/file mutex berbatas,
  backpressure console, pemulihan tail crash, adapter Baileys aman, serta
  pencatatan warning/crash/shutdown. Lihat
  [`ADR-010`](decisions/ADR-010-log-operasional-produksi.md).
- [ ] Collector terpusat, dashboard health, alert berdasarkan fingerprint,
  dan hardening ACL/enkripsi log untuk deployment multi-instance.
- Deployment dan backup.
- [x] Kebijakan routing model dan konfigurasi tiga tingkatan. Lihat
  [`decisions/ADR-003-routing-model.md`](decisions/ADR-003-routing-model.md).
- [x] Percakapan generatif dan pemahaman pesan di luar closed set diproses
  model AI. Parser tugas berbasis aturan lama tetap dihapus; boundary jelas,
  emergency preflight, waktu tanpa episode hangat, dan identitas model murni
  menjadi pengecualian deterministik menurut
  [`ADR-021`](decisions/ADR-021-emergency-preflight-dan-boundary-local-first.md).
- [x] Memasang pembungkus anti-injeksi, menyambungkan `remindAt` ke pembuatan
  tugas, dan menyalakan mode JSON penyedia. Ketiganya sudah ditulis tetapi tidak
  pernah tersambung.
- [x] Memindahkan penilaian keselamatan ke pemeriksaan tersendiri, sesuai alur
  teknis di `ADR-003`. Sejak ADR-022, chat privat hanya memanggil acute triage
  untuk emergency lokal, RiskHint `possible|strong`, atau compiler failure;
  sejak ADR-024 grup memakai risk hint acute-only, privacy raw-context terpisah,
  dan envelope ambient tunggal setelah authority+binding+notice.
- [x] Memberi tahu pengguna bahwa pesannya diproses penyedia model pihak ketiga,
  dan meminta persetujuannya. Dijamin Konstitusi Pasal 3.9. Masuk 26 Juli 2026
  bersama perkenalan kontak pertama. Pesan pertama boleh menjalani satu triase
  keselamatan sebelum persetujuan, lalu ditahan; emergency closed-set memakai
  copy lokal tanpa provider. Pemahaman, personalisasi,
  analitik, dan pesan berikutnya menunggu tombol persetujuan. Persetujuan kini
  dapat ditarik dari dalam chat tanpa menghapus data. Versi 5 juga menjelaskan
  fan-out 2–3 worker untuk permintaan kompleks yang aman; worker tidak mendapat
  memori, riwayat, credential, atau tool. Perubahan terakhir ini sudah teruji
  otomatis, tetapi belum diuji lewat Telegram.
- [x] Pengalaman pengguna pertama: Harvy berkenalan sebelum menjelaskan cara
  pakai, dipicu kontak pertama dan bukan oleh `/start`. Pesan yang telanjur
  dikirim ditahan lalu diproses sendiri setelah persetujuan.
- [x] Balasan yang tidak terdengar seperti mesin: riwayat dikirim sebagai pesan
  chat pada langkah balasan, kalimat tetap Harvy diberi variasi, pemberitahuan
  memori menempel di balasan, dan kalimat yang membawa perasaan sekaligus tugas
  dijawab dulu sebelum kartunya muncul.
- [x] Riwayat percakapan, agar tutoring bertahap benar-benar mungkin. Riwayatnya
  ada sejak 26 Juli 2026 lewat [`ADR-006`](decisions/ADR-006-memori-dan-riwayat-percakapan.md);
  compaction v2 kini menyimpan episode terstruktur berprovenance tanpa
  merangkum ulang episode lama. Alur tutoring lima langkah
  `ukur → coba → petunjuk → penjelasan → coba lagi` disimpan sebagai satu sesi
  aktif yang dapat dilanjutkan setelah restart.
- [x] Fondasi factual memory Phase E: FTS episode lama, semantic projection,
  embedding vector opt-in, consolidation contradiction/supersession,
  `MemoryQueryPlan`, dan Context Pack bounded kini tersambung ke prompt privat.
  Temporal/privacy/suppression filter menutup recent summary maupun retrieval
  setelah `forget one`; export dan full deletion juga mencakup state turunan.
  Lihat `ADR-030` dan `ADR-031`.
- [x] Fondasi temporal graph Phase F: entity/relation hanya diproyeksikan dari
  semantic source berprovenance, mempunyai validity/status, traversal bounded,
  namespace private/group/project yang terpisah, dan cascade delete/rebuild.
  Consumer runtime masih privat; group/project consumer dan procedural memory
  tetap fase berikutnya. Lihat `ADR-032`.
- [x] “Sesi Langkah Kecil” persisten untuk menjernihkan keadaan, memilih
  prioritas, fokus pada satu langkah, tutoring, menyusun rencana, dan membuat
  draf pesan untuk meminta bantuan manusia. Satu pengguna hanya punya satu sesi
  aktif agar tujuan lama tidak tertimpa diam-diam. Sesi adalah konteks lunak:
  topik baru tidak diambil alih, tetapi sesi lama tetap dapat dilanjutkan.
- [x] Check-in satu kali yang hanya dibuat setelah pengguna memilihnya sendiri.
  Waktu, zona waktu, dan jam tenang berada dalam kendali pengguna; mengabaikan
  check-in tidak memicu pengingat kedua.
- [ ] Research web baca-saja ditunda; implementasi vertical slice sebelumnya
  sudah dicabut dari runtime. Pengaktifan kembali memerlukan keputusan baru
  untuk scope, provider, egress, penyimpanan, dan acceptance end-to-end.
- [x] Agent Runtime privat cheap-first untuk pertanyaan dan permintaan tenang:
  tool baca tugas/sesi/waktu/agenda Harvy, fast path jam deterministik, terminal
  virtual sementara, serta root ambitious yang dapat mendelegasikan 2–3
  subpekerjaan read-only kepada worker cheap/efficient secara paralel. Worker
  tidak menerima tool/memori/delegasi. Planner memakai native function calling;
  definisi action berasal dari executor callable dan hasilnya tetap proposal
  bagi kernel, bukan izin eksekusi. Shell host, kalender eksternal, dan seluruh
  tool write tetap ditutup. Checkpoint klarifikasi dapat dilanjutkan
  selama horizon absolut 10 menit dan `waiting_input` privat Telegram bertahan
  pada restart normal lewat adapter file satu-proses. Satu RunBudget kumulatif
  mengikat root, retry/fallback, tool, dan worker serta bertahan melewati
  checkpoint tanpa menagih waktu tunggu manusia. Planning `orchestrate`
  eksplisit privat Telegram kini berjalan sebagai active AgentRun durable di
  work lane, dengan Run Anchor, RunMailbox/ChangeSet, stale-result gate,
  checkpoint recovery, receipt delivery lokal, replay ingress idempotent, dan
  backpressure sebelum koreksi terpotong atau revision palsu. Query `tools`
  masih sinkron;
  adapter ini belum RunStore produksi, multi-instance outbox/reconciler,
  job queue kedua, atau authority tool write. Lihat `ADR-017`, `ADR-018`,
  `ADR-026`, dan `ADR-027`.
- [x] Scope & Authority v1 sebagai fondasi core: `WorkspaceScope`, principal
  pseudonim, membership/role/permission, `aclEpoch`, invalidasi scope lama,
  capability filter, dan adapter file atomik. Belum ada ingress, UI, artifact,
  atau wiring Workspace untuk pengguna; lihat `ADR-016`.
- [x] Matriks authority grup dan shared room memory eksplisit: anggota
  mengusulkan preview, admin terkini mengonfirmasi ID yang sama, delivery gagal
  me-rollback write, dan reset admin tidak mengambil member-local memory.
  Perilaku ini baru teruji otomatis, belum melalui WhatsApp nyata.
- [x] Memori terstruktur per pengguna yang dapat dilihat dan dihapus. Memori
  biasa disimpan otomatis disertai pemberitahuan, memori sensitif hanya dengan
  izin. Lihat `ADR-006`. Pengenalan sensitivitas saat ini bergantung pada jenis
  ekstraksi dan triase model; salah klasifikasi serentak keduanya masih
  keterbatasan terbuka di `STATUS.md`, sehingga kata “hanya” di sini adalah
  kontrak produk yang belum dijamin sempurna oleh implementasi.
- [x] Pemeriksaan keselamatan sebagai lapisan tersendiri: triase risiko tiga
  tingkat, arahan yang melarang menolak lalu menutup, dan pemeriksaan balasan
  sebelum dikirim. Penanganan pengguna di bawah 18 tahun berjalan tanpa pernah
  menanyakan umur — perlindungannya menyesuaikan isi percakapan.
- [x] Acknowledgment prioritas untuk emergency preflight lokal atau boundary
  model `urgent`, dikirim di luar FIFO. Handler lengkap dan mutasi tetap FIFO
  agar state tidak korup.
- [ ] Pembatalan kooperatif request biasa yang belum commit ketika pesan urgent
  masuk.
- [x] Batas pemakaian token 24 jam dan pemantauan biaya per pengguna. Jalur
  keselamatan tetap berjalan saat batas biasa habis dan tetap dicatat.
- [x] Control plane localhost, cohort standard/beta, katalog paket/harga
  berversi, inventaris aman seluruh model environment, pemilih harga tanpa ID
  bebas, provider-attempt ledger, entitlement delivery-confirmed, atribusi grup
  per principal pseudonim, dan lock satu proses. Pembayaran dan Console
  internet-ready belum ada.
- [x] Corpus evaluasi sintetis 42 skenario, hard invariant, dan harness adapter
  Telegram palsu. Evaluasi model nyata tetap manual karena mengirim prompt ke
  penyedia eksternal.
- [x] Corpus grup sintetis 150 skenario semantik × empat variasi permukaan
  (600 ambient) dan 60 episode generasi direct, lengkap dengan JSONL, seed,
  metrik strict/preference, konsistensi cluster, latency, serta pemisahan
  gangguan provider/harness. Kombinasi corpus/evaluator terbaru belum
  dijalankan penuh dan belum menggantikan uji grup WhatsApp nyata.

## Model AI

Harvy memakai tiga tingkatan model yang dipilih menurut **kesulitan pekerjaan,
bukan paket yang dibayar pengguna**. Percakapan keselamatan memakai tingkatan
`efficient` — keputusan pemilik produk 27 Juli 2026, menggantikan aturan lama
yang selalu menaikkannya ke tingkatan tertinggi.

| Tingkatan | Rencana model | Dipakai untuk |
|---|---|---|
| `cheap` | DeepSeek V4 Flash | Mengurai tugas, klasifikasi, balasan rutin, root agent/tool sederhana, worker murah |
| `efficient` | GPT 5.6 Luna | Percakapan sehari-hari, keselamatan, langkah kecil, worker yang perlu bahasa lebih kuat |
| `ambitious` | GPT 5.6 Terra | Tutoring bertahap, root orkestrator, sintesis dan perencanaan panjang |

Produksi memakai OpenRouter sebagai gerbang tunggal agar tagihan tidak tersebar.
Selama pengembangan, `AI_MODE=testing` mengarahkan seluruh tingkatan—termasuk
root ambitious dan worker—ke satu model cepat (Gemini 3.5 Flash-Lite dari
Google AI Studio) kecuali override tier diisi. Mode testing boleh
memasang satu provider OpenAI-compatible sebagai cadangan agar gangguan
sementara primary tidak menghentikan seluruh percakapan. Cadangan tidak pernah
aktif di production, tidak menggantikan batas keselamatan, dan dapat menerima
permintaan yang sama setelah primary gagal; persetujuan pengguna dan notice
grup menjelaskan kemungkinan lebih dari satu penyedia. Menghentikan mode uji
cukup mengubah `AI_MODE` menjadi `production`.

Seluruh ID model berada di `.env`, tidak ditulis di kode. Nama dan harga model
berubah cepat, jadi **verifikasi ejaan persisnya di daftar model penyedia
sebelum dinyalakan**. Harvy Console membaca seluruh slot model yang nonkosong
pada startup dan hanya mengizinkan operator mengatur harga pasangan itu;
credential dan base URL tidak ikut ke browser.

Capability baru juga tidak ditebak dari tier atau gateway. Registry memasangkan
provider+ID exact; tanpa `AI_MODEL_PROFILES`, model memakai kontrak
compatibility dan reasoning control baru tetap mati. Execution policy kini
memisahkan role, requested/effective effort, dan verbosity metadata dari tier,
tetapi routing model masih tiga tier. RunBudget kumulatif sekarang menjadi
prerequisite yang tersedia untuk Agent Runtime privat. Ceiling general sekarang
berasal dari role lalu di-clamp profile exact; work call juga tidak dapat
memakai separuh token/biaya yang dilindungi untuk final synthesis.
Compaction tekanan konteks dan satu recovery untuk typed truncation kini ada.
`toughest`/K3, wire visible verbosity, tokenizer calibration, dan finalizer
terminal tetap berada di change set Phase C lanjutan; lihat ADR-025, ADR-026,
ADR-028, dan ADR-029.

Fondasi Phase D untuk active run sekarang tersedia khusus orkestrasi eksplisit
Telegram privat. Ia belum berarti coding sandbox, artifact pipeline, app
connectors, atau orkestrasi lintas kanal sudah aktif; batas detailnya ada pada
ADR-027.

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

Ada dua produk web yang tidak boleh dicampur. **Harvy Console** sudah ada
sebagai control plane localhost khusus operator untuk akses pilot, paket,
harga, usage, biaya, dan audit. Daftar modelnya merupakan snapshot aman `.env`,
sedangkan input operator dibatasi pada harga. Ia memakai label operator
pseudonim serta breakdown cohort/paket tanpa mengambil nama platform. Ia bukan kanal
percakapan dan belum boleh dibuka ke internet. **Harvy Web** untuk pengguna
masih belum ada; kelak ia menjadi tempat
untuk hal yang memang lebih baik dilihat daripada dibicarakan setelah alur chat
terbukti perlu.

Isi yang direncanakan: daftar tugas, kalender, prioritas, peta belajar,
perkembangan, tujuan jangka panjang, memori, izin, notifikasi, dan ruang belajar
bersama.

Ruang belajar bersama mempertemukan pengguna satu sama lain, sehingga tunduk
pada Pasal 5 nomor 10: memerlukan verifikasi, moderasi, pelaporan, pemblokiran,
dan perlindungan tambahan sebelum boleh ada. Hal yang sama berlaku untuk
pencocokan teman dan perencanaan kuliah bersama.

## Monetisasi

Fondasi pengukuran dan katalog pilot sudah dikerjakan, tetapi Harvy belum
menerima pembayaran. Katalog individu default adalah Perkenalan (Free) Rp0,
Toro (Plus) Rp19.000, Sora (Pro) Rp39.000, dan Kuro (Max) Rp69.000; paket grup
tetap Sapa Rp99.000, Nimbrung Rp249.000, dan Ruang Rp599.000 per bulan.
Seluruhnya berstatus **harga hipotesis pilot**, bukan penawaran publik atau
janji kapasitas produksi. Detail kapasitas dan batas validasinya ada di
[`product/PILOT_BETA_DAN_PAKET.md`](product/PILOT_BETA_DAN_PAKET.md).

Tujuan awal bisnis bukan pendapatan, melainkan:

1. membuktikan manfaat nyata;
2. memahami biaya per pengguna;
3. mengetahui pola penggunaan;
4. mencegah pertumbuhan yang merugikan; dan
5. menguji kemauan membayar.

Free/Plus/Pro/Max hanya menjadi kategori pembanding; nama publiknya adalah
Perkenalan/Toro/Sora/Kuro. Tiga pilihan pribadi berbayar memberi pintu masuk
ringan, pilihan utama rutin, dan anchor penggunaan intensif. Psikologi pilihan
hanya boleh mempermudah perbandingan nilai; countdown palsu, rasa takut,
auto-renew tersembunyi, atau pemanfaatan keadaan emosional dilarang.

Paket grup mempunyai entitlement sendiri dan tidak menghabiskan paket pribadi
anggota. Cohort beta juga terpisah dari paket: overlay beta memberi kapasitas
uji lebih besar tetapi tidak menjadi hak berbayar, tidak memilih model, dan
tidak memberi izin evaluasi. Model tetap dirutekan menurut pekerjaan.

Ledger provider mencatat setiap percobaan fisik, termasuk retry/fallback,
sedangkan ledger entitlement mencatat settlement idempoten per logical request
dan baru mendebit balasan bernilai setelah adapter memastikan delivery.
Overhead internal, kegagalan parser/delivery, dan keselamatan tidak mengurangi
paket meski biayanya tetap terlihat di provider ledger. Console dapat
menghitung token/biaya per subject grup dan principal anggota pseudonim tanpa
menyimpan transcript. Angka `estimated`, `unpriced`, `pending`, `partial`, atau
`unknown` tidak boleh dipresentasikan sebagai nol maupun invoice final.

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

- Merancang ulang research workspace durable, bila diputuskan untuk diaktifkan
  kembali, di atas fondasi scope+ACL v1 yang sudah ada: ingress membership,
  artifact bersitasi, groundedness per klaim, retrieval/RAG, pagination dan
  keragaman sumber, cancellation lintas proses dan crash recovery, lalu
  konektor khusus X/Threads setelah durable run terbukti.
- Memperluas fondasi grup WhatsApp dan menyambungkan core yang sama ke
  Telegram. Shared room memory eksplisit untuk keputusan/agenda/norma/kegiatan
  sudah ada di core; room social adaptation yang berizin, inside joke yang
  tetap dapat diperiksa, permainan, poin sementara, polling, diskusi, dan
  kegiatan komunitas masih nanti. Memori anggota per grup tidak boleh dilebur
  dengan shared room memory.
- Harvy Market sebatas katalog, pencarian, reputasi, dan pelaporan; belum
  menangani atau menjamin transaksi.

## Tidak dikerjakan sekarang

- WhatsApp personal sebagai kanal utama.
- Escrow atau penyelesaian sengketa.
- Diagnosis kesehatan mental.
- Penyimpanan otomatis informasi sensitif.
- Tindakan proaktif tanpa persetujuan.
- Rotasi nomor untuk menghindari pembatasan platform.
