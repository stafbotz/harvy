# ADR-016 — Scope dan Otoritas v1

- **Status:** Diterima
- **Tanggal:** 2 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** Konstitusi v0.5, ADR-009, ADR-011, ADR-012, ADR-015

## Konteks

Harness Harvy sudah membedakan ruang privat dan grup, tetapi durable research
kelak juga membutuhkan Workspace yang dapat dipakai beberapa principal tanpa
membuka data privat atau grup asal. Di sisi grup, profil sosial ruang dan memori
anggota sudah ada, tetapi hak member/admin masih tersebar sebagai pemeriksaan
boolean dan belum ada memori semantik yang sungguh dimiliki ruang bersama.

Dua kekurangan ini berbahaya bila dibiarkan sampai executor bertambah kuat.
Checkpoint lama dapat terus berjalan setelah role berubah, klaim admin dari
pesan lama dapat dipakai sebagai authority, dan istilah “reset memori grup”
dapat menghapus data member-local yang seharusnya hanya dikuasai anggotanya.

## Keputusan Workspace

1. **`AgentScope` mempunyai varian Workspace.** Scope membawa
   `workspaceKey`, principal pseudonim, `membershipId`, role, permission tetap,
   `aclEpoch`, serta namespace percakapan, memori bersama, artifact, dan
   authority. Scope hanya dipercaya setelah dibentuk dan diperiksa ulang oleh
   `WorkspaceAuthorityService`; object atau output model yang kebetulan
   berbentuk sama bukan authority.
2. **Principal tidak menyimpan ID kanal mentah.** ID Telegram/WhatsApp diubah
   menjadi HMAC-SHA256 dengan secret deployment dan domain separator kanal.
   Kesamaan display name atau ID di kanal lain tidak menghubungkan akun.
3. **Role v1 tertutup dan deny-by-default.** `owner`, `admin`, `editor`, dan
   `viewer` dipetakan kode ke permission workspace/artifact/run/membership.
   Permission yang dibawa scope harus sama persis dengan role saat ini;
   tambahan permission buatan membuat scope ditolak.
4. **Setiap perubahan membership atau role menaikkan `aclEpoch`.** Tambah,
   ganti role, keluar, dan revoke ditulis bersama state authority dalam satu
   commit repository. Scope dan checkpoint lama menjadi stale. Rejoin membuat
   `membershipId` baru. Owner tidak dapat dihapus atau keluar pada v1; admin
   tidak dapat mengelola owner/admin.
5. **Harness wajib merevalidasi Workspace.** Run Workspace tanpa callback
   freshness berhenti sebelum planner. `authorityKey` mengikat workspace,
   membership, principal, dan epoch; perubahan ACL mengubah kunci scope.
   Capability snapshot juga menyaring permission role, tetapi snapshot bukan
   pengganti pemeriksaan ACL tepat sebelum efek.
6. **Belum ada surface Workspace.** Registry default tidak mengaktifkan
   `workspace:telegram` atau `workspace:whatsapp`; composition root juga belum
   memasang repository/service ini. Adapter berkas v1 hanya fondasi satu proses
   untuk tes dan pengembangan, bukan database produksi atau fitur yang dapat
   dipakai pengguna hari ini.

## Keputusan Grup

1. **Matriks authority grup menjadi tipe tertutup.** Member dapat membaca
   profil sosial/room memory, mengelola data dirinya, dan mengusulkan catatan
   ruang. Admin juga dapat mengonfirmasi/menghapus catatan ruang, reset state
   bersama, dan mengelola alias. Hanya lifecycle sistem dapat menonaktifkan
   scope. Aksi yang tidak tercantum ditolak.
2. **Hak admin diperiksa lagi pada saat efek.** Adapter WhatsApp menyediakan
   resolver dari metadata grup terkini. Reconnect atau event membership
   mengosongkan cache/menaikkan epoch serta membatalkan batch/pending pada call
   stack event yang sama; selama metadata belum tersedia, otorisasi gagal
   tertutup. Role lama tidak boleh dipasangkan dengan epoch baru. Membership
   Harvy dan pengirim dibuktikan sebelum ingress, lalu core merevalidasi lagi
   sebelum binding atau state ditulis. Cache metadata mempunyai TTL; refresh
   berbatas ditunggu untuk pesan yang sama agar cache kedaluwarsa tidak
   menghilangkan pesan, sedangkan completion lama ditolak bila socket/epoch
   berubah. Epoch tetap monoton selama proses (bukan ledger durable lintas
   restart). Semua API mutasi grup membawa guard authority wajib yang diperiksa
   di dalam antrean tepat sebelum commit.
3. **Shared room memory hanya lahir dari usulan eksplisit.** Anggota dapat
   menulis bentuk seperti `ingat keputusan grup: ...`. Harvy mengirim preview
   persis dengan ID pendek; pending baru dipasang setelah preview terkirim.
   Admin saat ini harus mengonfirmasi ID yang sama dalam 10 menit. Tidak ada
   ekstraksi ambient otomatis atau promosi dari member-local memory.
4. **Catatan ruang terlihat dan berbatas.** Record menyimpan jenis
   `decision|agenda|norm|activity|note`, alias pengusul yang scoped, provenance
   `admin-confirmed` dan `explicit`, serta kedaluwarsa 60 hari. Maksimum 20
   record per grup; hanya empat terbaru masuk context model sebagai data tak
   tepercaya. Semua anggota dapat melihatnya lewat kontrol memori grup dan
   admin dapat menghapus satu.
5. **Delivery tetap menentukan commit pengguna.** Bila acknowledgment setelah
   penyimpanan gagal terkirim, write room memory di-rollback. Pending proposal,
   konfirmasi, dan timer tetap in-memory dan dibersihkan saat disable/shutdown.
6. **Kepemilikan reset dikoreksi.** `reset memori grup` oleh admin hanya
   menghapus profil sosial bersama dan shared room memory. Ia tidak menghapus
   member-local semantic memory atau kontrol dedupe milik anggota. Disable atau
   removal Harvy tetap menghapus seluruh state scope karena ruang itu tidak lagi
   aktif. Penghapusan diri pada repository file menghapus profil sosial,
   member-local memory, dan atribusi pengusul room dalam satu commit; kegagalan
   penghapusan ledger teknis disebut apa adanya dan tidak disamarkan sebagai
   sukses penuh.
7. **Notice naik ke v7.** Pemberitahuan menjelaskan perbedaan memori anggota dan
   catatan bersama, proposal+konfirmasi admin, visibilitas/retensi, kontrol
   hapus/reset, serta batas bahwa reset admin tidak mengambil data member-local.

## Batas yang sengaja tersisa

- Workspace belum mempunyai ingress, UI membership, artifact store, account
  linking, config deployment, atau integrasi composition root. Repository
  berkas tidak aman untuk beberapa proses dan belum menggantikan PostgreSQL.
- `groupEpoch` berasal dari satu runtime Baileys dan tidak durable. Ia adalah
  token freshness monoton selama proses, bukan ledger membership lintas restart.
  Metadata WhatsApp yang tidak tersedia atau tidak memuat Harvy selalu menolak
  aksi admin dan memicu disable binding bila Harvy ternyata sudah keluar.
- Pending shared-memory hilang saat restart. Tidak ada workflow persetujuan
  durable, riwayat moderator, transfer owner Workspace, custom role, atau ACL
  per artifact.
- Preview eksplisit dan triase giliran mengurangi risiko penyimpanan isi yang
  tidak pantas, tetapi bukan classifier privasi sempurna. Shared room memory
  hanya untuk catatan operasional ruang; ia tidak memberi admin hak menyalin
  private/member-local memory.
- Kompensasi delivery v1 menjamin rollback untuk record member/room yang baru
  dibuat sebelum acknowledgment. Edit, delete, reset, alias, dan penghapusan
  diri belum mempunyai transaksi undo generik bila mutasi sudah commit lalu
  acknowledgment gagal; batas ini harus ditutup bersama outbox/receipt, bukan
  disamarkan sebagai exactly-once.
- Gerbang Brave+Telegram nyata belum lulus karena deployment saat implementasi
  tidak mempunyai `WEB_SEARCH_API_KEY` maupun flag web aktif. Bukti tahap ini
  adalah tes deterministik, bukan klaim end-to-end provider/channel.
- Durable PostgreSQL `RunStore`, progress/cancellation lintas restart, report
  artifact, native tool calling, X/Threads, outbox, receipt, dan reconciler
  tetap tahap berikutnya.

## Konsekuensi

Perubahan role atau membership sekarang membatalkan seluruh scope Workspace
lama, bukan hanya menyembunyikan tombol. Admin grup tidak otomatis menjadi
admin Workspace dan owner Workspace tidak mendapat akses ke private/group
memory. Shared room memory kini berguna untuk keputusan/agenda/norma ruang,
tetapi selalu melalui proposal yang terlihat dan konfirmasi admin—biaya satu
langkah tambahan yang sengaja dipilih agar Harvy tidak membentuk “kebenaran
kelompok” dari percakapan ambient sendiri.

Tes deterministik mencakup pemisahan principal kanal/workspace, role matrix,
permission forgery, epoch stale/revocation, repository atomik/migrasi, harness
freshness, capability filtering, matriks grup, demotion/cache invalidation,
membership self/pengirim, penolakan self-echo, proposal→preview→konfirmasi,
epoch stale, cross-group isolation, expiry/context tak tepercaya, guard mutasi,
rollback delivery create, reset tanpa menghapus member-local, penghapusan diri
atomik, dan disable atomik.
