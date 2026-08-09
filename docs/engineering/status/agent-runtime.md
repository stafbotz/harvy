# Status — Agent Runtime

Verified: 9 Agustus 2026 pada working tree output policy Phase C di atas
`7cc5abb`; `npm run check` PASS dan `npm test` PASS, 846 test dalam 108 suite,
0 gagal.
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
  sebelum key/fetch; failure ambigu dibebankan penuh sebagai unknown. Work call
  tidak dapat memakai separuh token/biaya yang dilindungi untuk final
  synthesis—48.000 token pada default, maksimal 49.152; view dan checkpoint
  mempertahankan reserve.
- Ceiling general kini dimiliki execution policy: conversationalist/worker
  8.192 token, planner/synthesizer/recovery 32.768, critic 4.096, lalu di-clamp
  profile exact. Classifier/extractor dan call product-bounded tetap memakai
  ceiling eksplisit yang sempit.
- Checkpoint `waiting_input` sinkron privat tetap tahan restart lewat record v1
  owner-scoped, CAS, horizon absolut sepuluh menit, dan hash capability/executor.
  Writer checkpoint memakai v2 dengan snapshot RunBudget; jeda manusia tidak
  memakai waktu aktif.
- Permintaan `orchestrate` eksplisit privat Telegram sekarang memakai active
  AgentRun v2 di work lane durable: snapshot konteks transaksi, satu foreground,
  RunMailbox/ChangeSet, instruction revision, work unit/event, Run Anchor,
  checkpoint, commit barrier, dan receipt outbound Telegram. Chat tak terkait
  tetap berjalan; quote/target eksplisit diperlukan untuk update atau answer.
  Startup melanjutkan queued/paused work, menutup expiry, dan mengubah delivery
  ambigu menjadi `partial|unknown` tanpa retry otomatis. Ekspor membawa isi
  mailbox, progress/perubahan, dan receipt teredaksi, bukan snapshot/policy/
  harga/hash. Hanya record terbaru per scope yang diretensi; edit/hapus memori
  atau wipe history membatalkan dan menghapus snapshot run terlebih dahulu.
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
- Context-pressure compaction, recovery truncation, visible verbosity control,
  validator-driven escalation, finalizer terminal terpisah, dan K3/toughest
  belum ada.
- `compactAtContextRatio` baru data policy. Limit RunBudget belum bisa dituning
  lewat Console dan belum punya telemetry outcome khusus. Guard biaya preflight
  memerlukan harga tier nonnol atau reported provider cost; token/attempt tetap
  terjaga bila harga belum lengkap. Actual provider usage satu attempt dapat
  melewati reservation, lalu work non-final berikutnya dihentikan.
- Active store/receipt/recovery di atas baru file lokal satu proses dan hanya
  untuk mode `orchestrate` privat Telegram. Belum ada RunStore produksi,
  lease/CAS multi-instance, dispatcher/outbox exactly-once, reconciler eksternal,
  job kedua, pin/archive anchor, atau workstream durable. Receipt hanya melacak
  pesan Telegram; crash sebelum checkpoint pertama dapat mengulang inference
  dan tool read. Query `tools` tetap sinkron.
- Agent root menerima konteks privat terpilih sebagai data tak tepercaya;
  worker tidak menerimanya. Memori tidak boleh menjadi authority permission,
  actor, credential, live schedule, atau outcome tool.
- Tool tidak dapat membaca host filesystem/process/environment, menjalankan
  program host, memakai network, atau bertindak di aplikasi eksternal.

## Bukti dan pointer

- Kode: `src/agent/`, `src/agent/time-fast-path.ts`, `src/harness/`,
  `src/ai/agent.ts`, `src/core/run-budget.ts`,
  `src/core/agent-run-service.ts`, `src/core/run-mailbox-policy.ts`,
  `src/bot/run-anchor.ts`, dan `src/storage/file-agent-run-repository.ts`.
- Tes: `tests/agent-runtime.test.ts`, `tests/agent-harness.test.ts`,
  `tests/create-bot-flow.test.ts`, `tests/harness-context-budget.test.ts`,
  `tests/harness-scope-capabilities.test.ts`, `tests/model-profile.test.ts`,
  `tests/execution-policy.test.ts`, `tests/provider-adapter.test.ts`,
  `tests/run-budget.test.ts`, `tests/active-agent-run-service.test.ts`,
  `tests/run-mailbox-anchor.test.ts`, dan `tests/client.test.ts`.
- Keputusan: ADR-012, ADR-016, ADR-017, ADR-018, ADR-021, ADR-025, ADR-026,
  ADR-027, ADR-028.
