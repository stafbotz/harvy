# Status Project Workspace dan Coding

Refreshed: 2026-08-13

## Ada di kode

- Phase G: `ProjectWorkspace` untuk upload ZIP/GitHub archive, snapshot
  content-addressed read-only, artifact upload tanpa bit tulis, revision/rollback,
  quota logical+allocated untuk
  artifact/snapshot/working/trash, retention dan crash-recovery trash, memory
  namespace project, verifikasi target rollback, ACL/CAS, guard authority+
  revision terstruktur, callback snapshot satu-kali, disposal working copy
  terotorisasi, dan safe ZIP parser internal tanpa shell extractor. Penghapusan
  memakai tombstone durable sebelum cleanup, menyembunyikan project dari jalur
  publik, lalu secara resumable mem-fence run/sandbox dan menghapus evidence,
  record run, metadata GitHub lokal, memory, serta payload. Pending commit atau
  effect ambigu menahan saga; tombstone completed mencegah ID hidup kembali.
- Phase H: kontrak `SandboxRunner` ke trust domain `isolated-linux`, binding
  owner+project+snapshot+revision+run, network-off, quota/admission, watchdog,
  bundle snapshot content-addressed tanpa host path, operation/request digest,
  late-allocation cleanup, queued-abort guard, quarantine lease ambigu,
  artifact stream cap+hash verification, monotonic deadline, durable write-ahead lifecycle, startup
  cancellation fence, ACK-lost reconciliation, lifecycle eksplisit
  `start/stop/drain/close` yang menutup admission, menunggu operasi aktif,
  mem-fence seluruh record, dan baru menutup journal setelah ACK exact,
  adapter SQLite lintas proses,
  opaque execution/artifact ID bebas credential, serta default transport yang
  gagal tertutup. Path/content snapshot dan argv yang sensitif atau menyerupai
  credential ditolak sebelum callback/transport. Client HTTP strict dan default-off mengikat protocol,
  audience/origin, proof service HMAC, descriptor/stream, request echo, dan
  AbortSignal; deadline tetap dimiliki wrapper core. Mode loopback hanya
  fixture dev.
- Phase I: `CodingRunEngine`, satu writer, read-only worker yang diserialkan,
  structured patch ber-hash, ChangeSet/instruction freshness, validator receipt
  yang mengikat command+task contract, transactional rollback/quarantine,
  repository-map/plan/task-level review, `code.write` mutation gate, penolakan
  credential pada brief/constraint/plan/path/source sebelum
  persistence/provider, revalidasi authority untuk terminalisasi stale,
  executor workspace berbatas, application controller yang hanya menerima
  actor hasil ingress tepercaya, dan coordinator bounded map→plan→inspect→edit
  →validator→task-review→finalize dengan admission satu invocation per run,
  state-revision fence, active-time budget, serta pending-commit recovery
  sebelum driver dipanggil. Validator artifact disalin ke evidence store
  content-addressed sebelum lease dibuang dan diverifikasi lagi saat completion
  atau recovery. Budget keputusan kumulatif, pause/resume `waiting_input`,
  `sandbox.exec`, dan registri provider in-flight membuat deletion dapat
  abort/join secara berbatas sebelum record dihapus,
  post-read freshness, rolling event ledger, diff/security gate, commit barrier,
  dan recovery tanpa mengulang efek.
- Phase J: local-git effect id/reconcile terpisah dari remote; GitHub broker
  policy/client tanpa credential GitHub/provider, dengan service-identity proof,
  exact schema, ACL/App/ref-head intersection,
  deterministic effect ID, canonical pending receipt, tri-state reconciliation,
  ordered attempt, penolakan field/nilai credential-like, branch `harvy/*`,
  contract confirmation authority/grant tanpa proof durable, workflow approval
  terpisah, server-side operation fence contract, exact non-force push dengan
  descriptor+stream object bundle Git yang mengikat commit/parent/tree, push
  kedua non-force dari head branch Harvy sebelumnya, dan draft PR saja. Client
  HTTP local-git dan GitHub broker tersedia default-off dengan health/protocol
  serta streaming exact, tetapi bukan implementasi daemon atau GitHub App.
  Lifecycle Harvy-side untuk GitHub App kini menulis installation session dan
  repository selection sebelum boundary eksternal, mengikat private-controller
  grant, memakai archive operation ID per selection, memverifikasi byte archive,
  memulihkan project deterministik sesudah crash, lalu mengikat selection+
  repository secara atomik. Raw repository ID connect dinonaktifkan; legacy
  binding wajib reconnect sebelum publish. Confirmation publish mengikat
  interaction ID dan audience `workspace-private`; grant group ditolak.
  Deletion hanya mem-purge connection, approval/receipt, dan selection lokal
  sesudah receipt `unknown` selesai; repository atau installation GitHub remote
  tidak dihapus.
- Capability serta permission granular telah terdaftar, tetapi seluruh surface
  coding/sandbox/git/GitHub tetap `installed: false` secara default.

## Batas yang masih terbuka

- Tidak ada Docker/Podman/runner Linux pada environment verifikasi ini. Boolean
  attestation dan fake transport bukan bukti seccomp/cgroup/mount/network atau
  secret isolation; Phase H live belum diterima.
- Belum ada daemon local-git/object store atau GitHub App broker
  credential-owning nyata, provision secret identitas service + verifier
  server-side, maupun confirmation
  controller produksi. Client HTTP saja tidak membuktikan backend tersebut;
  Harvy dan sandbox tidak menyimpan credential GitHub.
- Boundary controller Workspace sudah ada tetapi belum ada actor resolver,
  ingress/UI/composition-root, worker driver, atau scheduler produksi. Adapter metadata
  project/run/evidence/deletion/GitHub file hanya untuk restart lokal satu proses; journal lease
  SQLite sudah transactional lintas proses, tetapi produksi tetap memerlukan
  distributed admission, implementasi object store/transport live, outbox, dan
  reconciler.
- Sandbox output harus dicap sambil streaming oleh backend. Watchdog client
  mencegah hang, tetapi tidak dapat membuktikan memory cap sebelum response
  materialized pada transport yang tidak tepercaya.
- Confirmation/fence boolean adalah contract trust-domain. Tanpa broker nyata,
  ia belum membuktikan idempotency linearizable atau worker quiescence.
- Tidak ada config/composition untuk ketiga client HTTP. Endpoint loopback dev
  tidak boleh membuat capability `installed`; produksi memerlukan endpoint
  dengan verifier service-auth, backend live, dan conformance positif dari
  service yang sama.
- Coordinator deletion dan store evidence/deletion belum dirangkai pada
  startup/composition produksi. Tombstone lokal bukan bukti remote GitHub sudah
  di-unlink atau konten remote terhapus.

## Bukti

- `npm run check` PASS.
- Tes terarah G–J/authority/HTTP PASS, 138 test dalam 15 suite.
- `npm test` PASS, 1.087 test dalam 134 suite, 0 gagal.
- Belum ada live isolation test, GitHub App test, provider test, atau kanal E2E.
