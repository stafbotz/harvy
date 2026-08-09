# Current Context

Refreshed: 2026-08-09

## Verified baseline

- Product capability baseline: working tree context-pressure Phase C di atas
  `fc6e799`
  (9 Agustus 2026).
- Product gates: `npm run check` PASS; `npm test` PASS, 860 test dalam 110
  suite, 0 gagal.
- Context system: `npm run context:check` PASS; output 4.150 byte dengan
  estimasi 1.038 token.

## Recent material changes

- Agent Runtime kini memadatkan transcript secara provider-neutral saat profile
  exact mendekati context window; typed truncation mendapat paling banyak satu
  recovery fresh tanpa delegasi dalam RunBudget yang sama.
- Ceiling reply/agent/worker general kini code-owned per role dan di-clamp exact
  profile; RunBudget melindungi separuh token/biaya untuk final synthesis.
- Planning eksplisit Telegram privat kini memakai active AgentRun durable lokal
  dengan Run Anchor, mailbox terikat, revision freshness, commit barrier, dan
  recovery konservatif tanpa memblokir chat biasa.

## Active cross-subsystem blockers

- Agent Runtime setelah perubahan continuation/context-pressure belum
  di-smoke-test ulang terhadap provider utama atau Telegram.
- Active-run mailbox belum dedupe `sourceMessageId`; agregasi 4.000 karakter
  juga dapat menandai revision diterapkan setelah koreksi terbaru terpotong.
  Jangan mengklaim rebase instruction lossless sampai keduanya diperbaiki.
- Storage/checkpoints, operational logs, entitlement, and authority durability
  remain single-process/file based. Active runs are durable and recoverable
  locally, but production RunStore, leases, outbox, and reconciliation do not
  exist.
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
