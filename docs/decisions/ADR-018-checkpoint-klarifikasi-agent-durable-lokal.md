# ADR-018 — Checkpoint Klarifikasi Agent Durable Lokal

- **Status:** Diterima
- **Tanggal:** 4 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** Konstitusi v0.5, ADR-006, ADR-008, ADR-012, ADR-014, ADR-017,
  ADR-026
- **Diamendemen oleh:** ADR-026 untuk checkpoint writer v2 dengan embedded
  RunBudget dan bentuk ekspor user-facing yang meredaksi policy internal

## Konteks

`ADR-017` membolehkan Agent Runtime read-only berhenti pada `need_input` dan
melanjutkan checkpoint yang sama selama horizon absolut sepuluh menit. Bentuk
checkpoint sudah serializable dan terikat ke scope, capability, executor,
deadline, serta budget langkah, tetapi adapter Telegram hanya menyimpannya di
`PendingStore` dalam memori. Restart proses menghilangkan pertanyaan yang sudah
terlihat pengguna.

Checkpoint memuat data pribadi: permintaan awal, jawaban pengguna, observation
tool internal, serta progress planner. Menaruhnya di file tanpa lifecycle
ekspor, penghapusan, consent, expiry fisik, dan concurrency guard akan membuat
cache sementara menjadi penyimpanan tersembunyi. Di sisi lain, membuka tool
write sekarang akan memerlukan transaksi, outbox, receipt, status `unknown`,
dan reconciler yang belum tersedia.

## Keputusan

1. **Slice durable pertama hanya `waiting_input` read-only privat Telegram.**
   Run aktif tetap sinkron dan tidak dipulihkan diam-diam setelah crash. Tool
   callable tetap `read`/`none`/virtual; task write, kalender eksternal, email,
   shell host, dan efek eksternal tetap ditutup.
2. **Checkpoint memakai port domain dan adapter file terpisah.** Satu record
   aktif per scope menyimpan scope/owner kanonis, `runId`, mode, intent,
   checkpoint, revision CAS, batas update Telegram yang boleh menjawab,
   `createdAt`, `updatedAt`, dan `expiresAt`. Codec checkpoint yang sama dipakai
   harness dan storage; record corrupt/tampered gagal tertutup. Save, claim,
   dan clear bersyarat memakai `runId`+revision agar handler basi tidak menimpa
   state baru.
3. **Horizon tidak pernah diperpanjang.** `expiresAt` persis
   `checkpoint.deadlineAt`, maksimal sepuluh menit dari `startedAt` dan tidak
   boleh dimulai di masa depan. Startup dan worker satu-menit menghapus record
   kedaluwarsa walau owner tidak kembali. File `.tmp` yatim dibuang di bawah
   queue path yang sama, bukan dipromosikan sebagai commit yang seolah pasti.
4. **Causal delivery mengikat jawaban.** Record baru disimpan hanya setelah
   seluruh bubble prompt berhasil dikirim. Watermark menyimpan update Telegram
   terbaru pada saat delivery; sebuah batch hanya boleh menjadi jawaban bila
   bubble pertamanya lebih baru dari watermark. Classifier boundary hanya
   membaca durable state dan tidak boleh memulihkan `PendingStore` di luar
   chain owner.
5. **Resume mengambil claim CAS sebelum model dipanggil.** Hanya satu jawaban
   untuk revision yang sama yang menang. Completion, stop, command pengganti,
   expiry, penarikan consent, dan penghapusan penuh membersihkan record.
   Kegagalan commit setelah delivery membatalkan run secara fail-closed pada
   proses aktif dan memberi peringatan jujur; balasan panjang memakai pemecahan
   Telegram yang sama dengan balasan awal.
6. **Checkpoint tunduk pada hak data.** Consent naik dari versi 5 ke 6 dan
   menjelaskan isi serta lifecycle checkpoint. Run aktif masuk ekspor data.
   Penarikan consent memblokir scope sebelum cleanup; consent baru tidak boleh
   diterima sampai checkpoint lama berhasil dihapus. Penghapusan penuh memasang
   tombstone profil sebelum store run dibersihkan, sehingga file rusak tidak
   dapat membatalkan hak pengguna sebelum tombstone ada.
7. **Adapter ini hanya untuk satu proses lokal.** Queue statik per path dan
   replace `.tmp`→`rename` melindungi writer dalam proses yang sama; ini bukan
   lease/CAS lintas instance, fsync durability, atau PostgreSQL `RunStore`.
   External/write actions tetap menunggu storage produksi dan lifecycle efek
   lengkap.

## Konsekuensi

Positif:

- Klarifikasi read-only dapat dilanjutkan setelah restart normal tanpa
  memperpanjang deadline atau memberi capability baru.
- Checkpoint mempunyai owner isolation, CAS, retensi aktif, ekspor,
  penghapusan, dan consent yang eksplisit.
- Pesan yang sudah masuk sebelum prompt tidak dapat keliru dipakai sebagai
  jawabannya, termasuk bila bercampur dengan bubble yang datang sesudah prompt.
- Delivery parsial dan kegagalan persistence tidak disamarkan sebagai run yang
  aman dilanjutkan.

Trade-off dan batas terbuka:

- Telegram delivery dan commit file tidak atomik. Crash setelah prompt
  diterima Telegram tetapi sebelum save masih dapat kehilangan checkpoint;
  save sebelum delivery sengaja tidak dilakukan karena dapat membuat prompt
  yatim. Ini baru dapat ditutup dengan outbox/receipt/reconciler.
- Crash setelah claim dapat kehilangan jawaban yang sedang diproses dan retry
  dapat mengulang inference/tool read. Batas ini aman hanya selama capability
  tetap read-only/virtual.
- Bila persistence pasca-delivery dan cleanup fallback sama-sama gagal,
  `blockedScopes` mencegah restore selama proses hidup. Block itu belum durable;
  restart di dalam horizon sepuluh menit masih dapat melihat record lama bila
  storage pulih. Peringatan pengguna dan dokumentasi harus jujur tentang gap
  ini sampai abandonment marker/outbox produksi tersedia.
- File JSON menulis ulang database dan tidak cocok untuk multi-instance atau
  background run berskala besar.

## Bukti

Tes deterministik mencakup restart lintas instance repository, CAS/claim
konkuren, expiry absolut dan worker retensi, file corrupt/tampered, timestamp
masa depan, owner nonkanonis, `.tmp` yatim, ekspor/penghapusan/consent, race
forget dengan load/save/claim, classifier lambat, watermark batch, prompt
gagal/parsial, balasan resume panjang, serta fault-injection save/clear/cleanup.
Angka gerbang penuh dicatat di `docs/engineering/TESTING.md` dan `docs/LOG.md`.
