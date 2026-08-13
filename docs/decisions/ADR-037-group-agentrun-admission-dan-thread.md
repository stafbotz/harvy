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
boleh mengirim group context ke planner, menjalankan work lane, atau mengaktifkan
fitur kanal sebelum notice, lifecycle, delivery receipt, dan composition siap.

## Keputusan

1. **GroupAgentRun adalah aggregate terpisah.** Record mengikat scope
   kanal+grup, account Harvy, initiator, participant berscope, audience
   `group-safe`, anchor WhatsApp, input teratribusi, ChangeSet, pertanyaan
   assigned, event, revision, dan retensi. Private memory, private history,
   provider transcript, serta credential tidak mempunyai field pada aggregate.
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

## Batas change set ini

- Service belum dirangkai ke `GroupTurnService`, Baileys, startup, notice,
  entitlement, model/work lane, atau transport delivery. Tidak ada kemampuan
  pengguna baru pada kanal produksi.
- Adapter JSON + CAS hanya restart-durable satu proses; belum ada database,
  lease, dispatcher, outbox, atau reconciler multi-instance.
- Anchor/question delivery belum mempunyai pending-effect receipt. Caller baru
  boleh memasangnya setelah transport berhasil, tetapi crash di antara send dan
  persist belum direkonsiliasi.
- Tidak ada pin API, assigned notification delivery, final publication,
  partial result, group-safe artifact, Workspace-private output, atau Group
  Coding Phase L.
- Purge tersedia sebagai lifecycle method tetapi belum dirangkai ke supervisor
  produksi. Notice/consent grup belum dinaikkan karena service belum reachable.

## Konsekuensi

Phase K kini mempunyai batas data dan authority yang dapat diuji tanpa
meminjam state privat. Integrasi berikutnya harus memasang delivery/outbox dan
lifecycle terlebih dahulu, lalu merutekan bubble target sebelum batching;
menyambungkan aggregate langsung ke planner atau mengaktifkan capability belum
diizinkan oleh keputusan ini.

## Bukti

Tes terarah mengunci ambient/mixed-batch isolation, targeting, proposal vs
self-info, initiator/admin control, assignee/admin override, alias attribution,
authority race di commit barrier, foreground CAS, replay/collision, cancel saat
waiting, expiry, tamper rejection, serta copy anchor manual-only. Bukti gerbang
repo dicatat di `docs/LOG.md`.
