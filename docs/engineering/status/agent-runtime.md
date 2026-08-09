# Status — Agent Runtime

Verified: 9 Agustus 2026 pada working tree RunBudget Phase C di atas `8e34410`;
`npm run check` PASS dan `npm test` PASS, 819 test dalam 104 suite, 0 gagal.
Detail ini dibaca hanya untuk task di `src/agent/`, `src/harness/`, planner
agent, scope/authority, atau executor internal.

## Keadaan saat ini

- Capability catalog menghasilkan snapshot immutable per scope/surface dan
  hanya mengekspos executor dengan versi serta schema native yang terpasang.
- Planner memakai native tool calling tertutup. Plain text, function asing,
  multi-call, argumen rusak, dan control output kosong ditolak sebelum kernel.
- Seluruh call conversation/group/worker production membawa execution plan
  code-owned berisi role, work class, requested/effective effort, verbosity,
  deadline, output ceiling, dan izin tool/delegasi. Tier/model routing lama
  tetap authority pemilihan model.
- Planner memegang assistant turn provider selama invocation dan memutar ulang
  reasoning/reasoning details/content serta Gemini thought signature hanya
  melalui exact profile dan binding provider+model. Metadata ini tidak masuk
  checkpoint, memory, atau log.
- Tool callable saat ini read-only: daftar/detail tugas, status sesi, waktu,
  agenda internal Harvy, terminal virtual in-memory, dan delegasi read-only.
- Pertanyaan waktu sempit tetap dijawab dari clock deterministik. Ia melewati
  boundary/understanding/triage hanya bila tidak ada episode hangat dalam 30
  menit; episode hangat tetap menjalani pipeline keselamatan dan pemahaman.
- Delegasi hanya dari root ambitious pada langkah awal, depth satu, 2–3 worker,
  tanpa memory/history/tool/credential, dengan deadline dan output berbatas.
- Satu `RunBudgetAccount` code-owned mengikat root, physical retry/fallback,
  tool, dan seluruh worker. Default: 96.000 token, USD 1, 6 langkah, 5 tool,
  12 model attempt, 45 detik aktif, dan 3 worker konkuren. Reservation dibuat
  sebelum key/fetch; failure ambigu dibebankan penuh sebagai unknown.
- Checkpoint `waiting_input` privat tahan restart normal lewat file repository
  satu proses, owner-scoped, CAS, horizon absolut sepuluh menit, dan hash
  capability/executor. Writer baru memakai checkpoint v2 dengan snapshot
  RunBudget; jeda menunggu manusia tidak memakai waktu aktif. Run aktif belum
  durable. Ekspor pengguna membawa progress+counter, bukan policy/harga/hash.
- `AgentScope` dan Workspace authority v1 ada di core dengan membership, role,
  permission tertutup, `aclEpoch`, dan stale-authority rejection. Workspace
  belum terhubung ke composition root atau surface pengguna.

## Batas dan defect aktif

- Percobaan primary+Telegram sebelum fix menerima native calls tetapi berhenti
  sebelum reply. Continuation dan fast path sesudah fix baru terbukti otomatis;
  smoke primary dan Telegram post-fix belum dilakukan.
- Native fallback sengaja nonaktif sampai wire contract provider cadangan
  dibuktikan kompatibel.
- Profile compatibility tidak mengaktifkan reasoning. `AI_MODEL_PROFILES`
  exact belum di-smoke pada provider nyata; capability explicit fallback
  sengaja ditolak.
- Context-pressure compaction, output-ceiling overhaul, reserved final
  synthesis, recovery truncation, visible verbosity control,
  validator-driven escalation, dan K3/toughest belum ada.
- `compactAtContextRatio` baru data policy. Limit RunBudget belum bisa dituning
  lewat Console dan belum punya telemetry outcome khusus. Guard biaya preflight
  memerlukan harga tier nonnol atau reported provider cost; token/attempt tetap
  terjaga bila harga belum lengkap. Actual provider usage satu attempt dapat
  melewati reservation, lalu work non-final berikutnya dihentikan.
- Belum ada RunStore production, outbox, receipt, reconciliation, atau recovery
  run aktif. Delivery prompt dan commit checkpoint tidak atomik.
- Agent root menerima konteks privat terpilih sebagai data tak tepercaya;
  worker tidak menerimanya. Memori tidak boleh menjadi authority permission,
  actor, credential, live schedule, atau outcome tool.
- Tool tidak dapat membaca host filesystem/process/environment, menjalankan
  program host, memakai network, atau bertindak di aplikasi eksternal.

## Bukti dan pointer

- Kode: `src/agent/`, `src/agent/time-fast-path.ts`, `src/harness/`,
  `src/ai/agent.ts`, `src/core/run-budget.ts`,
  `src/core/agent-run-service.ts`.
- Tes: `tests/agent-runtime.test.ts`, `tests/agent-harness.test.ts`,
  `tests/create-bot-flow.test.ts`, `tests/harness-context-budget.test.ts`,
  `tests/harness-scope-capabilities.test.ts`, `tests/model-profile.test.ts`,
  `tests/execution-policy.test.ts`, `tests/provider-adapter.test.ts`,
  `tests/run-budget.test.ts`, dan `tests/client.test.ts`.
- Keputusan: ADR-012, ADR-016, ADR-017, ADR-018, ADR-021, ADR-025, ADR-026.
