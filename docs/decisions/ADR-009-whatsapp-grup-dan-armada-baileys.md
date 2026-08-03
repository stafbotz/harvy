# ADR-009 — WhatsApp Grup dan Armada Baileys

- **Status:** Diterima
- **Tanggal:** 29 Juli 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** Konstitusi v0.4, ADR-003, ADR-004, ADR-008, ADR-011

**Catatan 30 Juli 2026.** Keputusan tentang batching, planner ambient,
supersession kandidat, listener nonblocking, dan urutan shutdown diperluas oleh
[`ADR-011`](ADR-011-partisipasi-natural-dan-evaluasi-grup.md). ADR ini tetap
menjadi sumber keputusan isolasi state, notice, memori sosial, binding akun,
dan lifecycle Baileys.

## Konteks

Harvy perlu hadir di grup WhatsApp sebagai anggota sosial yang memahami
percakapan, tahu ketika dipanggil, dapat memilih kapan nimbrung, dan mempunyai
memori yang hanya berlaku di grup asal. Produk juga harus mampu menjalankan
banyak nomor Harvy melalui Baileys.

Adapter Telegram pribadi tidak dapat dipakai langsung. Ia menganggap satu
`ownerId` sebagai satu pembicara, menggabungkan bubble tanpa identitas anggota,
dan mempunyai profil, memori, tugas, sesi, consent, serta kontrol data pribadi.
Meneruskan event grup ke pipeline itu akan mencampur anggota dan berisiko
membocorkan memori pribadi.

Baileys adalah klien WhatsApp Web tidak resmi. Satu socket membawa satu auth
state; kredensial linked-device memberi akses jangka panjang terhadap akun.
Repository berkas Harvy saat ini hanya aman untuk satu proses.

## Keputusan

1. Grup memakai core netral kanal dan pipeline tersendiri. `GroupMessage`
   mempertahankan group, account, message, participant, nama snapshot, waktu,
   metadata tag/reply, status admin, serta pasangan identitas PN/LID. Burst
   bubble satu anggota digabung setelah 1,2 detik, tetapi setiap ID dan waktu
   bubble tetap dibawa untuk dedupe serta statistik.
2. Seluruh state dikunci ke `scopeKey = channel + groupId`. Peserta yang sama di
   dua grup adalah dua identitas lokal; memori pribadi sama sekali tidak
   menjadi dependency pipeline grup.
3. Tag, reply ke pesan Harvy, dan julukan grup selalu dianggap panggilan.
   Pesan ambient melewati planner `speak | silent` dan cooldown sosial. Planner
   yang gagal berarti diam.
4. Triase risiko berjalan sebelum balasan. Kegagalan pada panggilan langsung
   memakai jalur fail-closed; kegagalan pada pesan ambient berarti diam.
   Balasan berisiko tetap direview. Ketika satu giliran lama menahan FIFO,
   triase awal giliran baru boleh mengirim acknowledgment tetap untuk `bahaya`;
   pemrosesan lengkapnya tetap FIFO. Konteks keselamatan hanya membawa giliran
   anggota yang sama dan balasan Harvy yang ditujukan kepadanya.
5. Harvy mengirim pemberitahuan grup segera setelah event penambahan diri
   sebelum pemrosesan aktif, tidak memproses `append`/history, dan menolak
   pesan bertimestamp sebelum `joinedAt`. Pesan live pertama yang membentuk
   binding memakai timestamp pesannya sendiri agar tidak kalah oleh presisi
   jam penerimaan lokal.
6. Memori persisten beta memuat nama grup/julukan Harvy selama binding aktif,
   identitas teknis PN/LID beserta nama tampilan/koreksi, `lastSeenAt`, hitungan
   harian dalam jendela 30 hari, dedupe 24 jam, dan waktu balasan Harvy untuk
   cooldown. Statistik yang ditampilkan memakai jendela 7 hari dan bukan
   profil kepribadian. Pembersihan retensi berjalan saat baca/tulis, startup,
   dan berkala selama proses hidup. Seluruh memori sosial dihapus ketika
   binding dinonaktifkan.
7. Raw context berada paling lama 24 giliran atau dua jam di memori proses dan hilang saat
   restart. Pesan maupun balasan Harvy pada giliran sensitif/berisiko tidak
   dimasukkan. Hanya penanda tingkat risiko tanpa isi bertahan 30 menit untuk
   menjaga jawaban pendek seperti “belum” tetap fail-closed.
8. Anggota dapat melihat memori grup, mengoreksi nama tampilannya, serta
   meminta penghapusan statistik dirinya lewat bahasa alami. Admin dapat
   menambahkan julukan dan meminta reset memori sosial grup. Penghapusan diri
   serta reset memerlukan konfirmasi kedua yang terikat identitas selama 10 menit.
   Penanda dedupe teknis tidak ikut reset admin agar replay tidak hidup kembali.
9. Banyak nomor dijalankan sebagai satu `BaileysAccountManager`: satu auth
   namespace, socket, cache, generation, backoff, dan status per `accountId`.
   Binding persisten menolak akun kedua dan tidak pernah failover otomatis.
10. Disconnect sementara memakai exponential backoff berjitter.
   `restartRequired` membuat socket baru segera; logout, session buruk,
   connection replacement, forbidden, dan multidevice mismatch berhenti dan
   meminta operator. Reconnect selalu menunggu antrean `creds.update` selesai
   sebelum membaca auth state kembali.
11. Listener Baileys memproses seluruh array `messages.upsert` bertipe
    `notify`; kegagalan satu pesan tidak membatalkan pesan lain. Pekerjaan event
    dilacak dan dikuras. Event self-remove menonaktifkan binding, sedangkan
    self-add mengaktifkan lagi akun yang sama dan memicu notice baru.
12. Shutdown lokal memakai `socket.end(undefined)`, bukan logout. Ingress
    batching dihentikan dan dikuras, socket serta pekerjaan event ditutup,
    antrean grup dikuras, lalu telemetry dikuras paling akhir.
13. Auth multi-file Baileys hanya adapter beta lokal satu proses. Produksi wajib
   memakai auth store database terenkripsi dengan single writer dan kontrol
   akses; folder auth tidak boleh masuk Git atau log.
14. Bila ditanya AI/model, Harvy menyebut sistem multi-modelnya **model
    Capybara**. Pertanyaan identitas murni dijawab tanpa model dasar; pesan
    campuran tetap menjalani pemahaman dan keselamatan lalu menyertakan jawaban
    Capybara tanpa membuka model/pemasok yang sedang dirutekan.

## Konsekuensi

Harvy kini dapat dikembangkan untuk grup WhatsApp tanpa melemahkan batas
pribadi Telegram. Dua grup dapat diproses paralel, sedangkan giliran dalam satu
grup tetap FIFO dan tidak kehilangan identitas pembicara. Bubble satu anggota
tidak disela balasan di tengah. Kegagalan satu nomor tidak memutus supervisor
nomor lain.

Fondasi ini belum membuktikan kompatibilitas WhatsApp nyata, kualitas timing
sosial, keamanan penyimpanan produksi, atau memori semantik lanjutan seperti
keputusan bersama dan inside joke. Baileys dapat berubah tanpa pemberitahuan;
nomor uji nonkritis dan pengamatan operasional tetap diperlukan.

## Alternatif yang ditolak

- **Memakai `createBot`/history pribadi untuk grup.** Ditolak karena identitas
  anggota hilang dan memori pribadi berisiko masuk ke ruang publik.
- **Satu auth state untuk banyak nomor.** Ditolak karena mencampur kredensial
  dan lifecycle akun.
- **Memindahkan grup ke nomor cadangan ketika koneksi gagal.** Ditolak karena
  mengubah identitas Harvy secara diam-diam dan dapat dipakai menghindari
  pembatasan platform.
- **Menyimpan seluruh transkrip grup.** Ditolak untuk beta karena memperbesar
  risiko sensitif dan membuat ringkasan terselubung sulit dikendalikan.
- **`shouldSyncHistoryMessage: () => false` tanpa pengecualian.** Ditolak karena
  Baileys v7 dapat membutuhkan bootstrap protokol untuk pemetaan LID. Full
  history tetap ditolak dan event `append` tidak pernah masuk domain.
