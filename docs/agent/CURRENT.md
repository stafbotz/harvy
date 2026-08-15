# Current Context

Refreshed: 2026-08-15

## Verified baseline

- Product capability baseline: working tree composition GroupAgentRun di atas
  commit dasar `d6560cb` (15 Agustus 2026).
- Product gate: `npm test` PASS, 1.348 test dalam 169 suite, 0 gagal. Suite
  terarah GroupAgentRun+startup PASS 40/40. Smoke dev mencapai ready, shutdown
  bersih, exit 0, dan tidak menyisakan runtime lock.
- Context contract: `npm run context:check` PASS; bootstrap 5.125 byte,
  estimasi 1.282 token.

## Recent material changes

- Fase G–M menyediakan ProjectWorkspace/safe ZIP, sandbox/coding/GitHub policy
  fail-closed, GroupAgentRun/group-coding core, dan escalation `toughest`.
  Coding/GitHub tetap default-off tanpa backend trust-domain serta conformance.
- GroupAgentRun kini dirangkai sesudah observation authority dan sebelum batch
  chat ke guarded controller, executor/processor, worker durable, usage, serta
  Baileys delivery fence. Reachability tetap flag eksplisit dan admission live;
  group-coding masih tidak reachable.
- Dev control dipasang sebelum network Telegram. Stop/reload saat startup
  mengabort request, menghentikan polling yang terlambat hidup, dan melepas
  runtime lock melalui cleanup normal.

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
- Metadata project/run/evidence/deletion/GitHub masih file/single-process;
  produksi perlu distributed admission, transport/object store, dan outbox.
  Supervisor/worker coding lokal belum dirangkai di `app.ts`; local detach
  bukan remote GitHub unlink/delete.
- Procedural memory privat yang belajar strategi bantuan dari bukti berulang
  belum ada; semantic/episodic/graph dan procedure project tidak menggantikannya.
- Dual model misclassification can still miss pre-save consent for sensitive
  memory. Do not claim this privacy gap is closed.
- False-positive/false-negative safety pada corpus model aktual belum diukur;
  selective routing baru terverifikasi otomatis dan belum membuktikan kanal
  nyata.
- Forced shutdown/crash tetap dapat meninggalkan runtime lock stale. Pastikan
  PID pemilik sudah mati sebelum menghapus lock.
- WhatsApp group behavior dan GroupAgentRun composition masih beta; full
  behavior, fault/reconnect delivery, dan dua akun nyata belum diuji end-to-end.

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
