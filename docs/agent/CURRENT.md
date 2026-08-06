# Current Context

Refreshed: 2026-08-06

## Verified baseline

- Product capability baseline: commit `43d8e16` (6 Agustus 2026).
- Last recorded product gates: `npm run check` PASS; `npm test` PASS, 644 test
  dalam 93 suite.
- Context-system working tree: `npm run context:check` PASS;
  `npm run check` PASS; `npm test` PASS, 654 test dalam 94 suite.

## Recent material changes

- Native agent continuation now replays exact assistant tool calls, matching
  tool-call IDs, and provider thought signatures during one invocation; the
  post-fix path is automatically tested but not yet live-tested.
- The agent harness now uses native tool calling with closed schemas and keeps
  executor validation as execution authority.
- Agent instructions now use code-first progressive loading with a compact
  status index and bounded bootstrap; product runtime code is unchanged.

## Active cross-subsystem blockers

- Agent Runtime after the latest continuation fix has not been smoke-tested
  again against the primary provider or Telegram.
- Storage/checkpoints, operational logs, entitlement, and authority durability
  remain single-process/file based. Active runs are not durable or recoverable;
  production RunStore/outbox/reconciliation do not exist.
- Dual model misclassification can still miss pre-save consent for sensitive
  memory. Do not claim this privacy gap is closed.
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
