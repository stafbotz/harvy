# ADR-037 — Group AgentRun Admission dan Thread Durable Lokal

- **Status:** Diterima
- **Tanggal:** 13 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-009, ADR-011, ADR-016, ADR-023, ADR-024, ADR-027
- **Mengamendemen:** batas private-only pada ADR-027, hanya sebagai fondasi core

## Konteks

Active AgentRun privat sudah membuktikan snapshot, RunMailbox, revision, dan
Run Anchor lokal, tetapi bentuknya mengikat satu owner Telegram. Grup WhatsApp
sudah membawa identitas PN/LID, quote message ID, authority member/admin, serta
scope ruang yang terisolasi. Menyamakan `groupId` dengan owner privat akan
menghilangkan atribusi, assignee, audience, dan hak kontrol per peserta.

Slice pertama Phase K harus membentuk authority/persistence lebih dulu. Ia belum
boleh mengaktifkan fitur kanal sebelum seluruh fence composition siap. Notice
v9, ledger work-attempt, commit barrier delivery termasuk hasil final,
recovery/retention, cleanup durable, admission runtime, adapter guard,
coordinator `GroupAgentRunWorker`, executor/checkpoint group-safe, work
processor, exact start parser, dan controller pre-batch kini tersedia. Jalur
ingress, processor, dan worker belum dikomposisikan, sehingga admission kanal
dan execution tetap tertutup.

## Keputusan

1. **GroupAgentRun adalah aggregate terpisah.** Record mengikat scope
   kanal+grup, account Harvy, initiator, participant berscope, audience
   `group-safe`, anchor WhatsApp, input teratribusi, ChangeSet, pertanyaan
   assigned, work-attempt, hasil final committed, event, revision, dan retensi.
   Private memory, private history, provider transcript, serta credential tidak
   mempunyai field pada aggregate.
2. **Satu foreground mutable per grup ditegakkan CAS.** Adapter file menolak
   foreground kedua dalam critical section yang sama dan memvalidasi ulang
   seluruh schema/transisi saat read maupun write. Source message awal dan
   mailbox idempotent; replay identik no-op, collision dan replay lintas account
   gagal tertutup tanpa membocorkan record account aktif.
3. **Ambient bukan input.** Kandidat hanya berasal dari quote anchor, quote
   pertanyaan, mention Harvy dengan referensi run closed-set, atau command
   initiator/admin closed-set. Mention tanpa referensi dan chat biasa tetap
   independen. Batch multi-bubble yang mencampur target dan ambient ditolak;
   integrasi kanal harus merutekan bubble target sebelum merge.
4. **Atribusi dan authority dipisahkan.** Informasi eksplisit tentang
   ketersediaan diri boleh diterapkan oleh anggota. Constraint kelompok dari
   anggota biasa menjadi proposal tanpa menaikkan instruction revision.
   Initiator/admin dapat mengubah objective atau cancel; status dapat dilihat
   anggota. Resolver authority tepercaya diperiksa lagi oleh guard di dalam
   antrean repository tepat sebelum commit.
5. **Assigned input tidak diwariskan kepada pesan berikutnya.** Jawaban harus
   quote pertanyaan atau anchor; hanya identitas assignee yang diterima.
   Jawaban pihak lain ditolak. Admin dapat override hanya dengan marker
   eksplisit dan provenance tetap menunjuk aktor sebenarnya. Watermark ingress
   setelah delivery menghalangi reply tertunda memenuhi pertanyaan yang lebih
   baru; reply ke pertanyaan lama tidak dipetakan ke pertanyaan terbuka lain.
6. **Waiting/cancel/expiry konsisten.** Hanya satu pertanyaan terbuka. Cancel
   menutupnya tanpa berpura-pura ada jawaban. Horizon pertanyaan maksimal 10
   menit dan tidak melampaui run; jawaban terlambat tidak menjadi input. Ledger
   menyisakan slot cancel dan record mempunyai horizon maksimal tujuh hari.
7. **Anchor group-safe tidak auto-pin.** Renderer hanya memakai status/fase,
   jumlah input/proposal, initiator, dan pertanyaan code-owned; tidak membuat
   persentase, ETA, atau detail worker/model. Pin policy v1 selalu
   `manual-only`.
8. **Delivery mempunyai commit barrier durable dan gagal tertutup.** Intent
   anchor atau assigned question dipersistenkan sebagai satu `pendingEffect`
   sebelum transport dipanggil. Intent mengikat effect ID, digest konten,
   instruction/state revision, purpose, serta snapshot authority initiator dan
   assignee. Authority, expiry, revision, dan pending intent diperiksa lagi
   sebelum send. ID pesan eksternal wajib ada sebelum anchor/question
   dimaterialisasi; hasilnya menjadi receipt append-only `committed`. Authority
   yang berubah sebelum send menjadi `not_committed`, sedangkan error, ID kosong,
   atau commit sesudah send yang ambigu menjadi `unknown` dan run `partial`.
   Receipt committed boleh direplay sebagai no-op; `unknown` tidak dikirim ulang.
   Delivery request membawa `authorityExpectation` exact yang dibentuk dari
   pending effect durable, termasuk epoch dan actor/role initiator atau assignee.
9. **Recovery mendahului retensi.** Recovery restart menutup pending delivery
   aktif sebagai `unknown|partial` tanpa memanggil transport. Worker lifecycle
   memulai recovery segera, menahan purge sampai recovery berhasil, mencegah
   siklus overlap, dan menyediakan `stop`/`drain`. Record aggregate v1 dibaca
   secara konservatif sebagai v2 dengan `pendingEffect: null` dan receipt kosong;
   v1/v2 tanpa ledger work menormalkan `running|paused` menjadi
   `queued|waiting_input`, sedangkan legacy `completed` tanpa bukti final
   committed menjadi `partial`. Migrasi tidak mengarang histori delivery atau
   hasil final. Cap 256 event tidak di-roll: prepare delivery ditolak sebelum
   send bila slot outcome tidak cukup, sementara recovery intent legacy pada cap
   exact hanya boleh mengganti event `delivery.prepared` terakhir dengan
   `delivery.unknown`. Adapter Baileys dapat meminta ID pesan deterministik dari
   effect ID/idempotency key dan menolak ID aktual yang hilang atau berbeda. Ini
   belum merupakan bukti deduplikasi server WhatsApp atau exactly-once lintas
   proses.
10. **Composition membuka lifecycle dan admission guard, bukan capability.**
    Ketika WhatsApp aktif, runtime membuat repository GroupAgentRun dan cleanup
    pada file khusus yang tidak boleh berkolisi dengan state grup. Startup
    menuntaskan cleanup pending lebih dulu, lalu recovery delivery dan purge,
    seluruhnya fail-closed sebelum `whatsapp.start()`. Worker ikut `stop`/`drain`
    saat shutdown. Resolver admission service hanya mengizinkan exact
    `scope+account` dengan binding live, tanpa intent cleanup pending, dan mode
    bukan `disabled|paused`; error resolver ditolak. Controller ingress,
    executor/processor, dan worker work belum dirangkai pada composition root,
    jadi guard ini belum membuka command atau execution kanal.
11. **Notice dan penghapusan scope mendahului reachability.** Notice v9
    menjelaskan record GroupAgentRun kondisional: request/judul, input anggota
    teratribusi beserta pesan sumber, Run Anchor, ledger work/delivery, hasil
    final committed, audience grup, file lokal terpisah, retensi maksimal tujuh
    hari, dan batas bahwa record bukan memori/riwayat privat atau transcript
    model. Repository menyediakan `removeScope` atomik-idempotent untuk seluruh
    run exact
    `scope+account`; service mengekspos `forgetScope`. Disable lebih dulu
    menginvalidasi batch/authority, lalu mempersistenkan intent cleanup pada file
    terpisah sebelum efek `disableGroup` dan `forgetScope` dicoba bersama. Setiap
    attempt mencocokkan scope, account, revision, dan token intent sebelum efek;
    token mencegah completion lama menghapus intent baru pada revision yang
    dipakai ulang. Intent baru selesai setelah kedua efek fulfilled. Coordinator
    per binding yang sama menyerialkan request, recovery worker, dan aktivasi;
    reaktivasi ditahan selama intent lama belum tuntas. Notice tetap menyatakan
    cleanup langsung dicoba dan batas retensi tujuh hari bila penyimpanan
    sementara gagal.
12. **Fence transport berada di antrean grup.** Delivery GroupRun pada Baileys
    wajib menerima expected authority epoch dan actor beserta expected role.
    Di dalam antrean per grup, adapter menyegarkan metadata bila perlu, menunggu
    runtime fence fail-closed, lalu memeriksa ulang socket/generation, epoch,
    membership Harvy, serta membership+role setiap actor secara sinkron tepat
    sebelum memanggil socket. Fence salah atau melempar tidak mengirim pesan.
13. **Grammar start dan controller tetap code-owned.** Start hanya menerima
    bentuk exact `Harvy, mulai pekerjaan: <request>` (prefix `Harvy,` opsional)
    dari mention satu bubble live yang bukan reply/quote; payload bahaya atau
    envelope cacat tetap independen agar jalur safety menanganinya. Controller
    menyerialkan start per binding, merutekan target run sebelum batching, dan
    mengirim anchor maupun control-copy hanya melalui guarded transport dengan
    idempotency key serta runtime fence. `stopIngress`/`drain` melacak tugas
    background. Controller ini selesai dan teruji, tetapi belum dikomposisikan
    atau reachable dari ingress produksi; model dan work lane tetap tertutup.
14. **Eksekusi dan completion mempunyai ledger durable terpisah.** Claim work
    wajib terjadi setelah anchor committed, memakai attempt ID, claim key,
    instruction revision, CAS, runtime admission, dan batas 32 attempt. Restart
    merequeue attempt aktif tanpa menjalankan model atau transport; expiry,
    cancel, waiting-input, dan batas attempt menutup state secara eksplisit.
    Hasil komputasi saja tidak men-terminalkan run. Final baru `completed` bila
    pending intent dipersistenkan sebelum send dan satu CAS sesudah send mengikat
    receipt committed, result group-safe, attempt completed, dan terminal run.
    Ledger maksimal 256 event wajib menyisakan slot outcome/penutupan pada setiap
    state nonterminal; service dan repository sama-sama menolak bypass yang dapat
    meninggalkan attempt atau pertanyaan tanpa jalur recovery/cancel/expiry.
    Claim service memagari runtime `scope+account` dan merevalidasi authority
    live initiator/epoch di dalam commit fence. Worker tetap belum boleh
    dikomposisikan sebelum seluruh port processor dan ingress dirangkai bersama.
15. **Aktivasi dan quote membawa authority hingga efek terakhir.** Aktivasi
    direct membawa fence socket/generation/epoch sampai commit binding, notice,
    dan invocation socket. Retry memakai lease membership live, token ABA, serta
    coordinator lifecycle; unavailable transient dicoba lagi, absence tetap
    fail-closed. Raw quote inbound hanya in-memory, exact grup+message, maksimal
    60 detik/1.000 pesan per akun, dan dibersihkan pada close, reconnect, atau
    self-removal.
16. **Executor group-safe tidak memperoleh capability ambient.** Paket model
    hanya berisi initial request dan update run yang applied serta teratribusi.
    Private history, memory, transcript ambient, credential, tool operasional,
    dan delegasi tidak mempunyai jalur input. Satu attempt membuat tepat satu
    native final/question decision dalam RunBudget; checkpoint content-free
    mengikat engine, attempt, sequence, instruction revision, input digest,
    waiting-question, dan budget. Work processor merevalidasi lease/revision,
    mempersistenkan checkpoint sebelum delivery, memerlukan receipt final atau
    question exact, lalu baru menyelesaikan usage scope. Cancellation atau
    correction membuang output basi; crash membiarkan state durable
    direkonsiliasi tanpa mengakui hasil model sebagai committed.

## Batas change set ini

- Notice v9, lifecycle, cleanup durable, resolver admission, dan retry aktivasi
  sudah dirangkai. Exact parser, controller pre-batch, `GroupAgentRunWorker`,
  authority-on-claim, executor/checkpoint, work processor, work-attempt, dan
  final barrier tersedia serta teruji, tetapi jalur tersebut belum composed
  sehingga tidak reachable; tidak ada kemampuan pengguna baru pada kanal
  produksi.
- Adapter JSON + CAS hanya restart-durable satu proses; belum ada database,
  lease, dispatcher, outbox, atau reconciler multi-instance.
- Efek `unknown` sengaja tidak di-retry dan belum mempunyai reconciler eksternal.
  Deterministic requested message ID pada adapter baru dibuktikan dengan fake
  socket, bukan reconnect atau WhatsApp live.
- Tidak ada pin API, hasil parsial user-visible, group-safe artifact, atau
  composition Workspace-private/group-coding pada kanal.
- Worker cleanup/recovery/retention dan retry aktivasi sudah dirangkai lokal;
  startup menolak membuka WhatsApp bila cleanup pending belum tuntas. Worker
  `GroupAgentRunWorker` masih uncomposed. Belum ada lease atau supervisor lintas
  proses.

## Konsekuensi

Phase K kini mempunyai batas data, authority, work-attempt, final commit barrier,
serta recovery/retention/cleanup yang dapat diuji tanpa meminjam state privat.
Authority expectation, admission runtime, exact parser, controller, worker
coordinator, activation lease, dan adapter fence mempunyai kontrak yang selaras.
Integrasi berikutnya adalah merangkai executor/processor/worker dan controller
sesudah observation authority serta sebelum batching. Execution tetap tertutup
sampai seluruh jalur itu terbukti pada composition nyata.

## Bukti

Tes terarah mengunci ambient/mixed-batch isolation, targeting, proposal vs
self-info, initiator/admin control, assignee/admin override, alias attribution,
authority race, foreground CAS, replay/collision, cancel saat waiting, expiry,
pending-before-send, receipt/tamper rejection, recovery tanpa retry, migrasi
v1/v2 konservatif, event-cap reservation, repository bypass rejection, work
claim/requeue/recovery/cap, final-result atomicity, worker
retention/coordinator, exact scope deletion tanpa late
resurrection, durable cleanup dan ABA token, activation lease, admission
CAS/pre-send, guarded delivery saat runtime/epoch/role berubah di antrean,
quote isolation/expiry, exact start/routing pre-batch, shutdown drain, notice
v9, executor/checkpoint tanpa private context, processor commit/usage ordering,
ID delivery adapter, serta copy anchor manual-only. Bukti perintah dan
batas dicatat di `docs/LOG.md`.
