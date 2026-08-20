# ADR-036 — GitHub App Broker dan Exact Effect

- **Status:** Diterima
- **Tanggal:** 11 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-016, ADR-027, ADR-033, ADR-035

## Konteks

Commit lokal bukan izin publish. Credential GitHub tidak boleh masuk proses
Harvy, sandbox, prompt, metadata project, atau receipt.

## Keputusan

1. GitHub App broker adalah trust domain credential-owning; Harvy hanya membawa
   installation/repository binding opaque dan exact effect tanpa token/key.
2. Branch create, exact non-force push, dan draft PR adalah capability serta
   approval terpisah. V1 hanya branch `harvy/*`; default branch, force,
   deletion/history rewrite, merge, dan settings/protection ditolak. Perubahan
   workflow hanya dapat lewat exact effect + approval
   `github.workflow.write`, dengan `github.push`, ACL, dan attestation App
   `canWriteWorkflows` yang semuanya fresh.
3. Setiap efek mengikat workspace/project/run/instruction revision,
   installation/repository, branch, commit, base commit, expected remote target
   head, dan metadata PR. Unknown field serta credential-like value ditolak
   dari canonical effect dan metadata durable.
4. Approval hanya dapat dibuat dari `GitHubConfirmationGrant` yang diterbitkan
   controller tepercaya dan mengikat exact effect digest, capability,
   membership, ACL epoch, interaction ID, serta audience `workspace-private`.
   Grant group atau replay lintas interaction ditolak. `confirmationId` single-use disimpan; opaque
   proof hanya diverifikasi transient dan tidak pernah dipersistenkan.
5. Efek mempunyai ID deterministik. Approval dikonsumsi dan receipt `unknown`
   ditulis sebelum boundary eksternal; retry tidak mengirim ulang. Broker
   merekonsiliasi marker/ref/PR exact sebelum mengubah receipt ke `committed`.
6. Authority saat efek adalah irisan ACL terkini, App repository access,
   project/run freshness, remote base+target ref, capability policy, dan exact
   approval. PR selalu draft dan memerlukan receipt push exact commit.
7. Transport wajib memakai effect/operation ID sebagai idempotency key
   server-side. `not_committed` hanya terminal setelah seluruh invocation lama
   quiescent/fenced; timeout atau abort client sendiri menghasilkan `unknown`.
8. Local git memakai operation ID deterministik dan reconcile pada transport;
   status/diff/log/commit membawa provenance binding exact. Commit menghasilkan
   descriptor object bundle Git content-addressed yang mengikat commit, parent,
   dan tree. Exact push mengikat descriptor itu di effect/approval dan
   mengalirkan byte tanpa host path ke broker; broker harus mengonsumsi seluruh
   stream dan mencocokkan size+SHA-256 sebelum ACK dapat diterima.
9. Commit lanjutan pada branch Harvy mengikat immediate parent ke remote head
   branch sebelumnya dan tetap non-force; freshness default base tetap binding
   terpisah. Client HTTP local-git/GitHub memakai protocol+audience tetap, proof
   service, schema/echo exact, AbortSignal, dan stream hash tanpa retry efek;
   wrapper core tetap memiliki deadline.
   Client tersebut default-off dan bukan implementasi daemon git, object store,
   GitHub App installation, atau confirmation controller.
10. Harvy menyimpan installation connection dan repository selection sebagai
    WAL credential-free sebelum memanggil broker. Listing/selection/provision/
    revoke memerlukan permission owner dan private-controller grant exact.
    Archive preparation memakai operation ID yang berasal dari selection,
    descriptor harus hidup setidaknya sepanjang selection, dan byte ZIP harus
    cocok size+SHA-256. Project ID deterministik menutup crash window sebelum
    `project_created`; selection dan repository binding dipromosikan atomik.
    Revocation lokal membuat efek lama gagal tertutup; remote App unlink tetap
    tanggung jawab broker credential-owning.
11. Project deletion hanya mem-purge connection, approval/receipt, dan
    repository selection credential-free lokal setelah receipt ambigu selesai.
    Ia tidak menghapus repository, branch, PR, atau installation GitHub remote.
12. Receipt `unknown` dapat dienumerasi sebagai locator content-free dan
    direkonsiliasi oleh worker observation-only tanpa scope pengguna. Worker
    hanya memanggil endpoint reconcile, memproses satu page per siklus,
    non-overlap, dan mencatat agregat. Authority historis exact boleh menerima
    installation yang sudah revoked agar outcome efek terkirim dapat diketahui,
    tetapi prepare/approve/execute baru tetap ditolak. ACK terminal harus exact
    dan fenced; timeout, schema salah, atau CAS kontradiktif tidak membuka retry.

## Konsekuensi

Policy broker dapat menolak stale/replay/force dan bundle substitution tanpa
melihat credential GitHub. Daemon local-git, credential-owning GitHub App
broker, HMAC verifier server-side, installation flow, private confirmation,
exact bundle push, draft PR, serta startup reconciliation kini tersedia dan
tetap default-off. Ledger service masih file/single-service dan GitHub E2E belum
live-accepted dengan App+repository uji; conformance fake bukan bukti remote
effect linearizable atau publish production multi-instance.
