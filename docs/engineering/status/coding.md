# Status Project Workspace dan Coding

Refreshed: 2026-08-20 pada targeted-input dan private-publish vertical slice. Bukti penuh
terakhir harus dibaca di `docs/LOG.md`; status live tetap dipisahkan dari test
otomatis.

## Ada di kode

- `ProjectWorkspaceService` menerima ZIP biasa maupun archive GitHub yang
  terikat selection, memakai parser ZIP internal tanpa shell, menghapus satu
  root sintetis zipball, menetralkan executable bit upload biasa, dan
  mempertahankan Git executable bit archive broker. Snapshot immutable,
  manifest content-addressed, quota, revision, rollback, working copy, dan
  tombstone-first deletion tetap berlaku. Metadata executable Git dibawa lewat
  manifest pada Windows; deployment POSIX tetap memverifikasi mode filesystem
  nyata.
- Backend sandbox production tersedia sebagai service Linux non-root terpisah:
  rootless Podman, image digest-pinned, seccomp profile, user namespace,
  capability drop, `no-new-privileges`, read-only root, private PID/IPC/UTS/
  cgroup namespace, CPU/memory/swap/PID quota, tmpfs project+scratch berquota,
  wall-clock/output/artifact cap, dan `network=none`. Snapshot masuk lewat
  bundle terverifikasi ke tmpfs melalui stdin; tidak ada host/project mount,
  Docker socket, atau credential environment. Abort/timeout mematikan process
  group dan container disposable.
- Service sandbox memakai protocol exact dan HMAC service identity. Health
  membawa digest identity runtime/image/policy; composition hanya membuka
  scheduler bila receipt conformance exact, digest-pinned, lengkap, dan fresh.
  Lease production memakai SQLite WAL + `synchronous=FULL`; startup mem-fence
  lease lama, shutdown menutup admission, drain, lalu dispose.
- Harness live hostile-code berisi 15 skenario: `/proc/*/environ`, host/Harvy
  data, Docker socket, fork/child explosion, disk, memory, infinite loop,
  outbound HTTP, DNS, symlink/path escape, timeout, oversized artifact,
  malformed output, dan proses sesudah cancellation. Generator receipt hanya
  menerima seluruh hasil dari runtime identity exact; fake transport tidak
  dapat membuat receipt production.
- `CodingRun` kini mempunyai composition production di `src/app.ts`: principal
  private berasal dari ingress Telegram tepercaya, Workspace dapat dibuat/
  dipilih dari ZIP atau GitHub selection, satu Run Anchor mutable mengikuti
  event nyata, dan chat biasa tetap memakai lane percakapan terpisah. Command
  private `/project`, `/code`, `/code_status`, dan `/code_cancel` hanya
  didaftarkan ketika runtime berhasil di-compose.
- `AiCodingWorkerDriver` menjalankan loop tool-call bounded map → plan →
  search/read → structured patch → sandbox → validator → task review →
  finalize. Satu budget kumulatif dan continuation exact dipakai; provider
  fallback coding dinonaktifkan sampai profile fallback live-proven. Hanya
  integration writer yang menulis. Validator test/lint/typecheck/build berasal
  dari image sandbox immutable, bukan command model.
- RunMailbox/ChangeSet/instruction revision, state CAS, provider+sandbox
  quiescence, stale action discard, cancellation, durable evidence, commit
  barrier, dan recovery tetap menjadi gate. ZIP acceptance otomatis membuktikan
  create workspace → iterative run → validator evidence → snapshot → commit Git
  nyata, termasuk constraint mid-run dan cancellation.
- `waiting_input` CodingRun kini membawa pertanyaan durable yang terikat
  instruction revision dan dirender pada Run Anchor. Hanya reply ke anchor
  tepercaya yang menjadi revision; pesan biasa tetap di chat lane. Checkpoint
  internal antar-invocation tidak lagi menyamar sebagai permintaan input.
- Local-git service credential-free memakai binary `git` dengan argv
  terstruktur untuk prepare/status/diff/log/add/commit, memverifikasi object,
  tree, parent, dan bundle. Update ref memakai compare-and-swap terhadap OID
  parent; drift tidak dapat ditimpa. Operation dan object bundle disimpan di
  root service terpisah dan dapat direkonsiliasi exact.
- GitHub App Broker credential-owning tersedia sebagai service terpisah. App
  private key, OAuth client secret, dan installation token short-lived hanya
  dibaca di proses broker. Harvy dan sandbox hanya mengirim binding/effect
  credential-free melalui HMAC service-auth. Broker melakukan installation
  OAuth callback, repository listing/access refresh, archive exact, create
  `harvy/*`, non-force exact push dari object bundle, draft PR, dan
  reconciliation fail-closed.
- Approval publish mengikat repository, branch, commit, base commit, expected
  target head, effect ID, actor, audience `workspace-private`, membership, ACL
  epoch, authority revision, dan interaction. Perubahan commit/authority
  membatalkan approval. Default branch, force push, auto-merge, remote delete,
  settings/protection, dan workflow write tanpa permission+approval terpisah
  tetap ditolak.
- Acceptance aplikasi privat otomatis membuktikan urutan offer/confirmation
  branch → push exact → draft PR dengan tiga confirmation berbeda, serta
  menolak offer sebelum transport ketika ACL epoch berubah. Ini bukti wiring
  control-plane lokal, bukan klaim efek GitHub live.
- `CodingRuntimeSupervisor` benar-benar dipanggil startup sebelum Telegram/
  WhatsApp network admission. Urutannya sandbox lease recovery, receipt GitHub
  ambigu, deletion tombstone, CodingRun/pending barrier, lalu conformance gate.
  Shutdown menyegel scheduler/worker/reconciler sebelum sandbox ditutup.
- Group coding sekarang reachable sesudah observation authority WhatsApp dan
  sebelum ambient batching. Actor dibentuk dari message normalized tepercaya;
  link memerlukan admin grup + `workspace.manage`, reference run durable, dan
  setiap admission direvalidasi setelah persistence. Output grup hanya agregat
  group-safe. Permintaan publish membuat handoff durable ke Telegram Workspace
  privat, bukan broker call dari grup.
- Authority change, disable, atau Harvy removal mencabut link/handoff lalu
  mem-fence run exact, sandbox, dan working copy. Pending local commit barrier
  sengaja dipertahankan dan membuat recovery gagal tertutup sampai outcome-nya
  direkonsiliasi. Startup juga mem-fence orphan group admission.
- `toughest` optional sudah terhubung hanya setelah validator yang sama gagal
  berulang pada revision yang sama. Ia satu critic call, tanpa tool/delegasi,
  primary-only, privacy-domain dan budget aware; integration writer tetap harus
  menerapkan hint dan menjalankan validator ulang.

## Batas yang masih terbuka

- Host verifikasi ini adalah Windows tanpa Docker, Podman, nerdctl, maupun WSL
  Linux terpasang. Karena itu hostile-code harness dan receipt conformance belum
  dijalankan pada runtime Linux nyata. Backend tersedia di kode/deployment,
  tetapi capability production harus tetap off sampai seluruh 15 skenario lulus
  pada image+seccomp+host exact.
- GitHub App credential, installation, dan repository uji nonkritis tidak
  tersedia. Broker dan conformance test otomatis ada, tetapi branch/commit/PR
  remote belum diverifikasi live. GitHub runtime tetap opt-in dan setup harus
  menyediakan private key, OAuth secret, state secret, service HMAC, callback,
  dan repository test.
- Profile primary exact `google-ai-studio/gemini-3.5-flash-lite` pada endpoint
  resmi lulus live smoke reasoning/tool continuation, thought-signature replay,
  finish/truncation, pressure, timeout, retry, dan output ceiling. Fallback
  coding tetap tertutup; target `toughest` belum dikonfigurasi dan belum live.
- WhatsApp GroupAgentRun/group coding belum menjalani acceptance lengkap pada
  grup dan participant uji nyata. Harness live tersedia, tetapi sengaja gagal
  non-sukses bila scope participant/crash/reconnect/workspace-publish belum
  seluruhnya dijalankan.
- Store control-plane project/run/evidence/deletion/GitHub/group, broker ledger,
  local-git operation ledger, dan outbound delivery masih file/single-service.
  SQLite lease sandbox memberi CAS lintas proses hanya untuk lease itu. Belum
  ada distributed authority lease, outbox/dispatcher, object store bersama,
  atau exactly-once reconciliation lintas instance; jangan mengklaim
  horizontal-safe.
- Pencabutan link grup menghentikan reachability grup tetapi tidak otomatis
  menghapus membership Workspace yang sebelumnya disetujui owner. Perubahan ACL
  generik tetap tindakan Workspace terpisah agar lifecycle grup tidak diam-diam
  mencabut hak di luar scope-nya.
- Procedural memory belum diimplementasikan; blocker live P0/P1 dan durability
  masih lebih prioritas.

## Bukti dan entry point

- Service: `npm run start:sandbox`, `npm run start:local-git`, dan
  `npm run start:github-broker`.
- Acceptance: `npm run acceptance:sandbox`, `npm run acceptance:github`,
  `npm run acceptance:provider`, dan `npm run acceptance:whatsapp`.
- Deployment contract: `deploy/sandbox/`, `deploy/local-git/`,
  `deploy/github-broker/`, `deploy/whatsapp/`, serta `.env.example`.
- Test utama: `sandbox-live-conformance`, `oci-sandbox-backend`,
  `private-coding-application-e2e`, `local-git-service-integration`,
  `github-app-broker-integration`, private publish pada `github-broker`,
  `group-coding-*`, dan lifecycle/supervisor
  suites. Angka gerbang terakhir dicatat di `docs/LOG.md` sesudah suite penuh.
