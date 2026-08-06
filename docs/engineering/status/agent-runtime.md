# Status — Agent Runtime

Verified: 6 Agustus 2026 pada baseline `43d8e16`; gerbang otomatis 644 test / 93
suite. Detail ini dibaca hanya untuk task di `src/agent/`, `src/harness/`,
planner agent, scope/authority, atau executor internal.

## Keadaan saat ini

- Capability catalog menghasilkan snapshot immutable per scope/surface dan
  hanya mengekspos executor dengan versi serta schema native yang terpasang.
- Planner memakai native tool calling tertutup. Plain text, function asing,
  multi-call, argumen rusak, dan control output kosong ditolak sebelum kernel.
- Tool callable saat ini read-only: daftar/detail tugas, status sesi, waktu,
  agenda internal Harvy, terminal virtual in-memory, dan delegasi read-only.
- Delegasi hanya dari root ambitious pada langkah awal, depth satu, 2–3 worker,
  tanpa memory/history/tool/credential, dengan deadline dan output berbatas.
- Checkpoint `waiting_input` privat tahan restart normal lewat file repository
  satu proses, owner-scoped, CAS, horizon absolut sepuluh menit, dan hash
  capability/executor. Run aktif belum durable.
- `AgentScope` dan Workspace authority v1 ada di core dengan membership, role,
  permission tertutup, `aclEpoch`, dan stale-authority rejection. Workspace
  belum terhubung ke composition root atau surface pengguna.

## Batas dan defect aktif

- Percobaan primary+Telegram sebelum fix menerima native calls tetapi berhenti
  sebelum reply. Continuation dan fast path sesudah fix baru terbukti otomatis;
  smoke primary dan Telegram post-fix belum dilakukan.
- Native fallback sengaja nonaktif sampai wire contract provider cadangan
  dibuktikan kompatibel.
- Belum ada RunStore production, outbox, receipt, reconciliation, atau recovery
  run aktif. Delivery prompt dan commit checkpoint tidak atomik.
- Agent root menerima konteks privat terpilih sebagai data tak tepercaya;
  worker tidak menerimanya. Memori tidak boleh menjadi authority permission,
  actor, credential, live schedule, atau outcome tool.
- Tool tidak dapat membaca host filesystem/process/environment, menjalankan
  program host, memakai network, atau bertindak di aplikasi eksternal.

## Bukti dan pointer

- Kode: `src/agent/`, `src/harness/`, `src/ai/agent.ts`,
  `src/core/agent-run-service.ts`.
- Tes: `tests/agent-runtime.test.ts`, `tests/agent-harness.test.ts`,
  `tests/harness-context-budget.test.ts`, `tests/harness-scope-capabilities.test.ts`.
- Keputusan: ADR-012, ADR-016, ADR-017, ADR-018.

