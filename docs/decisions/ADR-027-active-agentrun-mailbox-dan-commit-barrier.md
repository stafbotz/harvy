# ADR-027 — Active AgentRun, RunMailbox, dan Commit Barrier Lokal

- **Status:** Diterima
- **Tanggal:** 9 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** Konstitusi v0.5, ADR-008, ADR-012, ADR-017, ADR-018, ADR-020,
  ADR-022, ADR-025, ADR-026
- **Mengamendemen:** batas run sinkron pada ADR-018 dan ADR-026

## Konteks

Agent Runtime sudah mempunyai planner native, tool read-only, checkpoint,
delegasi, serta RunBudget kumulatif. Namun permintaan orkestrasi Telegram masih
menahan antrean percakapan sampai planner selesai. Pesan baru juga belum
mempunyai cara aman untuk dibedakan antara chat biasa, koreksi pekerjaan, dan
jawaban atas pertanyaan run. Menjalankan inference di latar tanpa state durable
akan membuat restart, hasil basi, dan delivery ambigu terlihat berhasil padahal
tidak dapat dibuktikan.

Slice ini harus mempertahankan hak data, safety routing, authority kode, dan
kompatibilitas checkpoint klarifikasi v1. Tool write tetap tertutup; efek
eksternal baru yang perlu dipertanggungjawabkan hanya pesan Telegram hasil run.

## Keputusan

1. **Work lane hanya untuk orkestrasi eksplisit privat Telegram.** Permintaan
   yang dipilih sebagai mode `orchestrate` memperoleh `ActiveAgentRun` v2 dan
   segera mengembalikan satu Run Anchor. Query mode `tools`, flow tugas/memori/
   sesi, WhatsApp, dan Workspace belum dipindahkan. Satu scope hanya boleh
   mempunyai satu foreground nonterminal; chat biasa tetap dapat berjalan.
2. **Run menyimpan snapshot transaksi, bukan live chat tail.** Record memuat
   request awal, konteks terpilih, timezone/gaya, revision, checkpoint,
   RunMailbox, ChangeSet, work unit, event, anchor, pending question/effect,
   receipt, dan hasil. Transcript provider, reasoning metadata, credential,
   capability authority mentah, serta isi chat yang tidak dirutekan tidak ikut.
3. **Pesan harus terikat eksplisit sebelum menjadi input run.** Quote terhadap
   Run Anchor atau pesan pertanyaan mengikat constraint/correction/scope/answer;
   frasa target run yang sempit boleh mengikat update atau cancel. Status dan
   cancel tertentu diputus lokal. Pesan berikutnya tanpa binding selalu tetap
   chat dan tidak pernah otomatis menjawab checkpoint.
4. **Instruction revision adalah freshness gate.** Setiap mailbox update
   membentuk ChangeSet baru dan menaikkan revision instruksi. Hasil dari revision
   lama tidak boleh mencapai callback delivery. Observation checkpoint yang
   sudah sah dipertahankan saat rebase, sementara action digest dan input yang
   terdampak dibentuk ulang; work unit lama ditandai stale. Dalam satu run,
   `sourceMessageId` mengikat envelope kind/content/question: replay identik
   adalah no-op lintas restart lokal, sedangkan collision gagal tertutup.
   Mailbox dan ChangeSet disimpan berpasangan. Compiler membawa update pending
   utuh dan kronologis ke beberapa input berbatas; bila seluruhnya tidak dapat
   direpresentasikan di checkpoint, ingress ditolak sebelum revision naik dan
   pengguna diminta mengirim ulang sesudah work bergerak. Update nonterminal
   tidak boleh di-evict untuk terlihat berhasil; ledger menyisakan slot cancel.
5. **Delivery memakai commit barrier lokal.** Service memvalidasi revision dan
   checkpoint, mempersistenkan `pendingEffect`, baru memanggil Telegram, lalu
   menulis receipt `committed`. Bila proses mati atau hasil delivery tidak dapat
   dipastikan, recovery menulis receipt `unknown`, status `partial`, dan tidak
   mengirim ulang otomatis. Receipt ini belum merupakan exactly-once lintas
   proses; ia adalah fail-closed ledger pada adapter file satu proses.
6. **Run Anchor berasal dari event/state tepercaya.** Anchor adalah satu pesan
   yang dapat diedit dan menampilkan status, fase, work summary, perubahan
   terakhir, serta pertanyaan bila benar-benar waiting. Ia tidak menampilkan
   nama model/tool/worker atau persentase rekaan. Chat tetap dapat berjalan saat
   anchor aktif; waiting tidak ditampilkan sebagai spinner.
7. **Lifecycle proses dan hak data menutup work lane.** Shutdown kooperatif
   mem-pause checkpoint lalu menunggu worker. Startup mengubah running/paused
   menjadi queued, melanjutkan queued work, menyegarkan anchor, menutup
   pertanyaan kedaluwarsa, dan mengubah effect in-flight menjadi partial tanpa
   retry. Penarikan consent dan penghapusan penuh meng-abort worker serta
   memblokir/menghapus scope melalui lifecycle yang sudah ada. Edit/hapus
   memori dan penghapusan seluruh riwayat juga membatalkan worker lalu menghapus
   snapshot run agar salinan konteks lama tidak bertahan atau dipakai lagi.
8. **Checkpoint v1 tetap kompatibel.** Record `waiting_input` lama dan mirror
   `PendingStore` tetap dibaca untuk mode sinkron. Active record v2 masuk ekspor
   dan penghapusan, tetapi snapshot konteks, effect ID, hash authority, harga,
   serta limit internal tetap diredaksi.
9. **Retensi dan consent mengikuti data baru.** Pertanyaan aktif tetap mempunyai
   batas jawaban 10 menit. Seluruh record v2, termasuk snapshot, mailbox, event,
   hasil, dan receipt, mempunyai horizon aktif paling lama tujuh hari sejak run
   dibuat; state terminal memperoleh horizon baru paling lama tujuh hari sejak
   selesai atau berhenti. Record dapat dibuang lebih cepat lewat penarikan
   consent, penghapusan penuh, atau ketika run/checkpoint baru pada scope yang
   sama menggantikan terminal lama. Store dan ekspor hanya mempertahankan satu
   record terbaru per scope.
   Karena jenis dan lama penyimpanan berubah material, `CONSENT_VERSION`
   dinaikkan ke 7 dan penjelasan onboarding menyebutkannya.

## Batas change set ini

- Adapter tetap JSON lokal satu proses: belum ada lease, CAS database,
  multi-instance dispatcher, fsync guarantee, atau RunStore produksi.
- Receipt baru mencakup outbound Telegram milik run. Tool tetap read-only;
  kalender/email/task write, coding sandbox, artifact pipeline, dan efek aplikasi
  eksternal belum tersedia.
- Belum ada antrean job kedua, replacement policy, pin/archive protocol, atau
  workstream specialist durable. Foreground kedua hanya diberi status run yang
  sedang aktif.
- Progress masih coarse dari lifecycle planner; bukan estimasi waktu atau
  streaming event provider. Model/provider dan Telegram nyata belum di-smoke.
- Crash sebelum checkpoint pertama dapat mengulang inference/tool read setelah
  recovery. Commit barrier mencegah publikasi hasil basi dan retry delivery
  ambigu, bukan menjamin exactly-once inference.

## Konsekuensi

Positif:

- pekerjaan orkestrasi tidak lagi head-of-line blocking chat privat;
- restart, koreksi, cancel, pertanyaan, dan delivery ambigu mempunyai state yang
  dapat dijelaskan dan diuji;
- unrelated chat tidak menjadi authority checkpoint; dan
- hasil basi ditahan sebelum efek eksternal.

Trade-off:

- snapshot konteks dan event menambah data privat yang harus dihapus, dibatasi,
  dan diretensi; mailbox/result ikut ekspor run, sedangkan snapshot yang
  menduplikasi sumber history/memory tetap diredaksi;
- serialisasi file dan lock service hanya valid dalam satu proses; dan
- status `unknown` sengaja dapat menghentikan run walau Telegram sebenarnya
  gagal sebelum menerima pesan, demi mencegah duplikasi yang lebih berbahaya.

## Bukti

Tes deterministik mencakup CAS/restart, foreground tunggal, ChangeSet dan rebase
tanpa membuang observation, stale-result gate, commit receipt, outcome delivery
unknown, redaksi ekspor, expiry pertanyaan, binding quote+question+watermark,
chat lane konkuren, correction replan, wake-up tanpa race, pause shutdown, serta
resume proses baru. Hardening berikutnya menambah replay/collision lintas
restart, duplicate answer, update panjang lossless sebelum/sesudah checkpoint,
backpressure envelope/ledger, kompatibilitas replay record lama, serta dedupe
ack Telegram. `npm run check` PASS dan `npm test` PASS, 866 test dalam 110 suite,
0 gagal. Uji provider dan Telegram nyata belum dilakukan.
