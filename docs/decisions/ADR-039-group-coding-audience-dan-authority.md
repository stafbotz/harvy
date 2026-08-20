# ADR-039 — Group Coding Audience dan Authority

- **Status:** Diterima
- **Tanggal:** 15 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-016, ADR-033, ADR-035, ADR-036, ADR-037

## Konteks

Membership WhatsApp/Telegram hanya membuktikan partisipasi pada ruang kanal.
Ia bukan membership Workspace, izin membaca source, ataupun otorisasi GitHub.
Sebaliknya, permission Workspace seorang principal tidak memberi hak untuk
membuka detail project kepada seluruh anggota grup. Phase L memerlukan irisan
kedua trust domain tanpa membiarkan command, prompt, atau output model membuat
principal maupun grant sendiri.

## Keputusan

1. **Actor group-coding berasal dari ingress tepercaya.** Controller hanya
   menerima handle opaque yang di-resolve menjadi principal Workspace,
   scope+account grup, participant, interaction, dan claimed authority epoch.
   Bentuk command tidak mempunyai field principal, membership, role, atau
   permission.
2. **Link grup ke Workspace memerlukan dua authority live.** Pembentukan dan
   pencabutan link memerlukan admin grup pada generation binding aktif serta
   membership Workspace dengan `workspace.manage`. Guard grup adalah lease:
   removal, unbind, dan perubahan epoch harus memakai koordinasi yang sama.
   Guard yang tidak tersedia menolak semua operasi.
3. **Setiap aksi memakai irisan permission terbaru.** Create memerlukan
   `run.create+code.read+code.write`, status memerlukan `code.read`, dan offer
   publish memerlukan `code.read` bersama `github.push` atau
   `github.pr.create`. Workspace ACL diperiksa di dalam authority lock; link dan
   generation grup diperiksa lagi sebelum callback.
4. **CodingRun membawa admission idempoten.** Effect berasal dari link dan
   interaction tepercaya. Engine menyimpan admission `group/group-safe`,
   menolak collision, dan mereplay command exact tanpa writer kedua. Reference
   audience durable mengikat run ke link, group generation, Workspace, project,
   initiator, interaction digest, dan command digest.
5. **Surface grup hanya menerima proyeksi code-owned.** Status, fase, jumlah
   file, dan status validator boleh dibagikan. Source, diff, path, snapshot,
   task brief, log, error detail, repository metadata, credential, serta
   approval tidak mempunyai jalur keluaran grup.
6. **Permintaan grup tidak pernah menjadi approval GitHub.** Setelah run lokal
   completed, surface grup hanya dapat menawarkan kelanjutan
   `workspace-private-confirmation-required`. Exact commit/repository approval
   dan broker effect tetap mengikuti ADR-036 pada audience privat.
7. **Revoke dan remove/re-add tidak mewarisi link lama.** Link active hanya
   dapat dicabut; generation baru membuat link ID baru. Reference run lama
   tidak dapat dibaca melalui link pengganti walaupun group ID sama.

## Konsekuensi

Core Phase L sekarang dirangkai ke observation-authorized ingress `app.ts`,
actor resolver tepercaya, link/handoff private durable, Run Anchor group-safe,
background driver, dan lifecycle fence revocation. Reachability tetap opt-in
bersama coding runtime serta binding WhatsApp live. Acceptance grup nyata belum
lengkap dan adapter file belum multi-instance; wiring otomatis tidak menjadi
bukti audience/privacy pada kanal live.

## Bukti

Tes `group-workspace-coding-controller` mengunci admin+Workspace intersection,
viewer policy, replay, audience run exact, generation/epoch stale, proyeksi
tanpa sentinel privat, private confirmation GitHub, persistence restart, schema
tertutup, dan transisi revoke. Tes admission `CodingRunEngine` mengunci replay
exact serta collision command. Suite `group-coding-ingress`, delivery, driver,
dan lifecycle-fence mengunci routing sebelum ambient, output allowlist,
workspace-private handoff, authority-race cancellation, disable/removal, orphan
admission, serta pending-commit fail-closed.
