# Current Context

Refreshed: 2026-08-13

## Verified baseline

- Product capability baseline: working tree fondasi ProjectWorkspace/Coding
  Phase G–J di atas commit dasar `f29b143` (10 Agustus 2026), diverifikasi
  ulang 13 Agustus 2026.
- Product gates: `npm run check` PASS; `npm test` PASS, 1.101 test dalam 136
  suite, 0 gagal.
- Context system: `npm run context:check` PASS; output 6.024 byte dengan
  estimasi 1.506 token.

## Recent material changes

- ProjectWorkspace kini mempunyai safe ZIP ingestion, immutable snapshot,
  revision/rollback, quota+retention, ACL/CAS, project-memory lifecycle, serta
  tombstone-first deletion saga yang mem-fence run/sandbox dan menghapus
  evidence/run/GitHub-local/memory/payload secara resumable. Tombstone belum
  selesai dapat dipage sebagai locator content-free dan dilanjutkan worker
  bounded tanpa membentuk scope pengguna.
- Sandbox policy dengan content-addressed snapshot/artifact protocol, durable
  lease journal/recovery, serta lifecycle eksplisit `start/stop/drain/close`
  yang menutup admission dan mem-fence seluruh lease sebelum journal ditutup;
  CodingRun
  single-writer dengan map/plan/task-review evidence dan commit recovery, serta
  local-git/GitHub exact-effect + Git object-bundle reconciliation tersedia
  sebagai service/policy default-off. Client HTTP strict yang mendukung
  service-auth proof untuk tiga trust domain ada, tetapi belum dirangkai atau
  didukung backend live.
- Validator artifact kini durable sebelum sandbox dispose; coordinator coding
  mempunyai budget keputusan kumulatif, pause/resume, state fence, sandbox
  action, dan provider-deletion fence. Publish grant terikat interaction
  `workspace-private`; deletion tidak menghapus konten GitHub remote.
- Receipt GitHub `unknown` dan tombstone project yang belum selesai kini dapat
  ditemukan lewat locator content-free dan diproses worker bounded satu proses.
  Worker GitHub hanya mengamati reconcile tanpa replay branch/push/PR; worker
  deletion hanya melanjutkan cleanup lokal exact tanpa scope pengguna.
- Capability coding/GitHub dan permission granular terdaftar; tidak ada
  surface yang diam-diam aktif tanpa executor live.

## Active cross-subsystem blockers

- Agent Runtime setelah perubahan continuation/context-pressure belum
  di-smoke-test ulang terhadap provider utama atau Telegram.
- Tidak ada runner Linux terverifikasi pada environment ini; Phase H live,
  seccomp/cgroup/mount/network/secret isolation, dan output streaming belum
  dibuktikan. Capability sandbox wajib tetap mati.
- Daemon local-git/object store, GitHub App broker live, provision secret
  identitas service + verifier server-side,
  trusted confirmation controller, dan Workspace ingress/UI belum ada. GitHub
  capability tetap mati; credential GitHub tidak boleh masuk metadata project,
  prompt, atau sandbox.
- Storage/checkpoints/log/authority dan adapter metadata project/run/evidence/
  deletion/GitHub
  masih single-process/file. Journal lease SQLite memberi CAS lintas proses,
  tetapi produksi tetap memerlukan distributed admission, implementasi
  transport/object store live dan outbox/reconciler terdistribusi. Worker
  recovery GitHub/deletion lokal sudah ada, tetapi belum dirangkai di `app.ts`.
- Deletion/evidence coordinator dan worker recovery belum dirangkai pada
  startup/composition produksi; local detach tidak sama dengan remote GitHub
  unlink/delete.
- Dual model misclassification can still miss pre-save consent for sensitive
  memory. Do not claim this privacy gap is closed.
- False-positive/false-negative safety pada corpus model aktual belum diukur;
  selective routing baru terverifikasi otomatis dan belum membuktikan kanal
  nyata.
- Forced shutdown can leave a stale runtime lock, and a startup-cancel race
  remains open. Verify the recorded owner process is dead before removing a
  stale lock.
- WhatsApp group behavior is beta; full current behavior and two real accounts
  have not been tested end-to-end.

## Route to detail

- [Agent Runtime](../engineering/status/agent-runtime.md)
- [Telegram](../engineering/status/telegram.md)
- [WhatsApp](../engineering/status/whatsapp.md)
- [Tasks and sessions](../engineering/status/tasks.md)
- [Memory and data](../engineering/status/memory.md)
- [Project workspace and coding](../engineering/status/coding.md)
- [Safety and privacy](../engineering/status/safety-privacy.md)
- [Console](../engineering/status/console.md)
- [Platform](../engineering/status/platform.md)

## Maintenance

Replace stale bullets; do not append chronology. Refresh baseline and gate
results from actual Git/test output, carry at most three recent material changes
from `docs/LOG.md`, and keep only cross-subsystem blockers here. Never include
credentials, identifiers, raw logs, prompts, or user quotations. Run
`npm run context:check`; this file must remain at most 5,120 bytes and total
bootstrap output at most 8,192 bytes.
