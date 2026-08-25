# Status — Agent Runtime

Refreshed: 24 Agustus 2026 pada provider smoke, routing evaluation, dan live
restart AgentRun privat. Bukti gerbang terbaru dicatat di
`docs/LOG.md`.
Detail ini dibaca hanya untuk task di `src/agent/`, `src/harness/`, planner
agent, scope/authority, atau executor internal.

## Keadaan saat ini

- Capability catalog menghasilkan snapshot immutable per scope/surface dan
  hanya mengekspos executor dengan versi serta schema native yang terpasang.
- Capability availability tidak lagi membuat global catalog hadir di setiap
  final conversation prompt. `Conversation.reply` biasa hanya menerima human
  context relevan yang bounded; callable tool schema tetap berada pada planner
  agent ketika composition benar-benar memasang dan mengotorisasinya.
- Planner memakai native tool calling tertutup. Plain text, function asing,
  multi-call, argumen rusak, dan control output kosong ditolak sebelum kernel.
- Seluruh call conversation/group/worker production membawa execution plan
  code-owned berisi stage role, cognitive role bila berlaku, work class,
  requested/effective effort, verbosity, deadline, output ceiling, dan izin
  tool/delegasi. Cognitive role terpisah dari tier accounting; optional exact
  binding berasal dari `AI_MODEL_ROLE_BINDINGS`, bukan nama provider/model di
  business policy.
- Global route baru memilih handler pertama melalui
  `deterministic|conversation|specialized|orchestrate`. Assessment semantic
  tertutup memakai complexity, ambiguity, planning, emotional nuance,
  execution size, factual stakes, mechanical transformation, tool need, dan
  confidence. Payload hilang/low-confidence tetap memakai fallback lama;
  panjang 280 karakter bukan lagi proxy utama runtime baru.
- Planner memegang assistant turn provider selama invocation dan memutar ulang
  reasoning/reasoning details/content serta Gemini thought signature hanya
  melalui exact profile dan binding provider+model. Metadata ini tidak masuk
  checkpoint, memory, atau log.
- Bila profile exact menyediakan context window, compiler memeriksa estimasi
  input plus output ceiling sebelum call berikutnya. Di bawah threshold native
  continuation tetap utuh; di atasnya transcript diganti state
  provider-neutral dari kernel. Observation besar menyimpan head/tail, ukuran
  asli, dan artifact reference bila tersedia; limit runtime di bawah 96
  karakter ditolak agar envelope bukti tetap utuh. Typed truncation boleh
  mendapat satu recovery tanpa delegasi setelah freshness diperiksa ulang,
  tetap dalam RunBudget yang sama; incomplete/content filter lain tidak
  di-retry.
- Tool callable composition saat ini read-only: daftar/detail tugas, status
  sesi, waktu, agenda internal Harvy, terminal virtual in-memory, delegasi
  paralel, serta specialist opt-in. Metadata discovery dapat membuat
  shortlist/high-recall ter-page tanpa schema atau authority baru, tetapi belum
  dirangkai ke planner karena callable subset masih kecil.
- Pertanyaan waktu sempit tetap dijawab dari clock deterministik. Ia melewati
  boundary/understanding/triage hanya bila tidak ada episode hangat dalam 30
  menit; episode hangat tetap menjalani pipeline keselamatan dan pemahaman.
- Root everyday menangani tool atomik; root orchestrator menangani deep route
  dan berbicara langsung tanpa rewrite model lain. Delegasi paralel tetap pada
  langkah awal. Kontrak specialist one-hop dapat meminta strong worker, heavy
  executor, verifier, atau challenger secara langsung, maksimal dua aksi
  delegasi per run. Composition production kini memasang executor hanya ketika
  `AI_SPECIALIST_DELEGATION_ENABLED=true`; default tetap off. Aktivasi
  memerlukan exact model berbeda untuk everyday/orchestrator/heavy/verifier/
  challenger, profile explicit, native tool support pada orchestrator, dan
  structured output pada semua route specialist. Specialist call primary-only;
  setup parsial gagal startup.
  Saat aktif, edge specialist menggantikan parallel legacy: orkestrator melihat
  konteks relevan, sedangkan worker hanya menerima WorkBrief minimum-necessary
  tanpa tool, raw memory/history, credential, continuation root, atau recursion.
  Boundary menolak credential-like brief, capability request nonkosong, serta
  salinan verbatim fragmen privat panjang dari konteks root.
- Satu `RunBudgetAccount` code-owned mengikat root, physical retry/fallback,
  tool, dan seluruh worker. Default: 96.000 token, USD 1, 6 langkah, 5 tool,
  12 model attempt, 45 detik aktif, dan 3 worker konkuren. Reservation dibuat
  sebelum key/fetch; failure ambigu dibebankan penuh sebagai unknown. Work call
  tidak dapat memakai separuh token/biaya yang dilindungi untuk final
  synthesis—48.000 token pada default, maksimal 49.152; view dan checkpoint
  mempertahankan reserve.
- `ResourceRequestPolicy` menambah proposal closed-set untuk reasoning, step,
  context, specialist, capability, atau tool tambahan. Grant hanya berasal dari
  adaptive reserve dan hard remainder code-owned; step tambahan memerlukan
  progress marker terstruktur. Primitive ini belum mengubah default RunBudget,
  checkpoint, atau scheduler aktif.
- Intelligence safety kini mempunyai hook role code-owned yang orthogonal
  terhadap authority operasional. Default masih everyday; bahkan bila role
  lebih kuat dipilih oleh composition, work class safety tetap tanpa tool dan
  delegasi. Belum ada safety eval/live config yang mengubah default tersebut.
- Ceiling general kini dimiliki execution policy: conversationalist/worker
  8.192 token, planner/synthesizer/recovery 32.768, critic 4.096, lalu di-clamp
  profile exact. Classifier/extractor dan call product-bounded tetap memakai
  ceiling eksplisit yang sempit.
- Checkpoint `waiting_input` sinkron privat tetap tahan restart lewat record v1
  owner-scoped, CAS, horizon absolut sepuluh menit, dan hash capability/executor.
  Writer checkpoint memakai v2 dengan snapshot RunBudget; jeda manusia tidak
  memakai waktu aktif.
- CodingRun memakai kontrak serupa tetapi state terpisah: pertanyaan manusia
  disimpan credential-free bersama reason code dan instruction revision, lalu
  hanya reply Run Anchor tepercaya yang dikompilasi menjadi ChangeSet. Batas
  action internal tetap `running` dan tidak pernah mengonsumsi pesan chat biasa.
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
  Replay envelope yang sama pada `sourceMessageId` menjadi no-op, collision
  ditolak, dan mailbox/ChangeSet dipersistenkan berpasangan. Update pending
  dikompilasi utuh serta kronologis ke beberapa input berbatas; bila envelope
  atau checkpoint tidak muat, adapter memberi backpressure sebelum revision
  naik. Ledger menyisakan kapasitas pembatalan sehingga update nonterminal
  tidak dikeluarkan diam-diam.
- `AgentScope` dan Workspace authority v1 memakai membership, role, permission
  tertutup, `aclEpoch`, dan stale-authority rejection. Private Telegram serta
  WhatsApp group-coding sekarang membentuk principal hanya dari ingress
  tepercaya dan terhubung ke composition runtime opt-in; isi model/chat tidak
  dapat membentuk scope atau ACL.
- Phase M menambah slot escalation-only `toughest` yang default-off dan hanya
  sah dengan model+privacy-domain+profile exact explicit. Pure policy hanya
  menerima closed validator failure, role critic/recovery/synthesizer, satu
  step tanpa tool/delegasi, serta budget call/token/deadline yang masih cukup.
  Provider/network failure tetap retry/fallback dan tidak menaikkan tier.
- Reservation toughest ditulis durable sebelum provider call. Satu stage hanya
  dapat dipakai sekali; replay, rejection, provider/execution failure, dan
  outcome ambigu sesudah restart tidak memanggil provider lagi. Sensitive
  cross-domain memerlukan approval code-owned. Record dan provider-attempt
  ledger hanya menyimpan digest/route/provider/model/effort/kelas material serta
  privacy domain, bukan prompt, candidate, output, atau reasoning.
- Harness routing sintetis A–E tersedia lewat `npm run eval:routing`. Rewrite
  only adalah variant eksperimen, raw request tetap hadir pada C–E, semua
  materi turunan berlabel untrusted, dan E hanya untuk case sulit terpilih.
- Coding validator memasang `toughest` optional ke repeated deterministic
  validator failure pada revision yang sama. Call ini primary-only, satu-shot,
  read-only critic tanpa tool/delegasi; hint tidak menjadi patch atau approval
  sampai integration writer menerapkan dan validator code-owned lulus ulang.
- Execution policy memakai `verbosity` terpisah dari requested/effective
  reasoning effort. Deep orchestrator, heavy executor, verifier, dan challenger
  dapat memperoleh effort lebih tinggi berdasarkan difficulty/stakes/
  uncertainty serta profile exact, sementara visible answer tetap ringkas.
  Tier maupun effort tidak mengubah panjang jawaban pengguna secara implisit.
- `WorkBrief`/`AgentHandoff` exact dan bounded menjadi kontrak lintas model.
  `workBriefRef` opaque dari kernel mengikat request/handoff ke run tanpa
  membuka user ID atau isi request sebagai authority.
  Raw reasoning, scratchpad, credential, provider continuation, dan field
  authority ditolak; PLAN_CONFLICT serta evidence gap memakai status/failure
  code provider-neutral.

## Batas dan defect aktif

- Provider primary current lulus native tool call, thought-signature reasoning
  continuation, tool-result replay, truncation/pressure, timeout, dan retry.
  Full Telegram current juga meluluskan planning 3/3/3 melalui satu anchor
  mutable. Tool/action CodingRun dari kanal tetap belum diuji live.
- Native fallback sengaja nonaktif sampai wire contract provider cadangan
  dibuktikan kompatibel.
- Profile compatibility tidak mengaktifkan reasoning. Profile code-owned
  `google-ai-studio/gemini-3.5-flash-lite` pada endpoint resmi lulus live smoke
  effort/tool/thought-signature replay/finish/pressure/timeout/retry; capability
  explicit fallback tetap sengaja ditolak.
- Visible verbosity sudah menjadi field policy terpisah, tetapi belum ada
  dashboard/UX tuning lintas seluruh surface. Validator-driven `toughest`
  sudah dirangkai untuk coding, tetap tidak mempunyai target aktif secara
  default, dan belum diuji live sebagai critic. Context-pressure baru memakai estimator
  karakter dan hanya aktif untuk context window profile exact; threshold belum
  dikalibrasi pada tokenizer/usage provider nyata.
- Limit RunBudget dan `compactAtContextRatio` belum bisa dituning lewat Console
  dan belum punya telemetry outcome khusus. Guard biaya preflight memerlukan
  harga tier nonnol atau reported provider cost; token/attempt tetap terjaga
  bila harga belum lengkap. Actual provider usage satu attempt dapat melewati
  reservation, lalu work non-final berikutnya dihentikan.
- Evaluasi routing A–E current selesai 9 varian setelah harness dinaikkan dari
  768 ke 4.096 output token dan dibuat request-local saat provider gagal. Hanya
  5/9 memenuhi seluruh sinyal: rewrite-only B kehilangan batasan sebagaimana
  eksperimen dirancang, sedangkan C/D/E juga menunjukkan retensi constraint
  tidak konsisten. Ini defect kualitas/evaluator terbuka, bukan bukti routing
  production siap. `RoutingAssessment` belum diuji pada corpus percakapan
  production yang representatif. Role binding exact baru terbukti melalui config/unit test; tidak ada
  klaim model role production aktif. Wiring specialist sudah ada tetapi gate
  production default-off dan belum dibuktikan lewat provider smoke; runtime
  resource grant dan capability discovery planner masih foundation yang belum
  terangkai.
- Active store/receipt/recovery di atas baru file lokal satu proses dan hanya
  untuk mode `orchestrate` privat Telegram. Belum ada RunStore produksi,
  lease/CAS multi-instance, dispatcher/outbox exactly-once, reconciler eksternal,
  job kedua, pin/archive anchor, atau workstream durable. Receipt hanya melacak
  pesan Telegram; crash sebelum checkpoint pertama dapat mengulang inference
  dan tool read. Idempotency ingress hanya terikat record lokal yang diretensi,
  bukan exactly-once lintas instance; ledger berbatas menolak update baru
  secara eksplisit ketika penuh. Query `tools` tetap sinkron.
- CodingRun mempunyai lane/composition terpisah dan tidak memakai active
  AgentRun privat ini sebagai store. Ia juga masih memakai file control-plane
  lokal, sehingga wiring tersebut bukan RunStore distributed atau izin
  horizontal scale.
- Agent root menerima konteks privat terpilih sebagai data tak tepercaya;
  worker tidak menerimanya. Memori tidak boleh menjadi authority permission,
  actor, credential, live schedule, atau outcome tool.
- Tool tidak dapat membaca host filesystem/process/environment, menjalankan
  program host, memakai network, atau bertindak di aplikasi eksternal.

## Bukti dan pointer

- Kode: `src/agent/`, `src/agent/time-fast-path.ts`, `src/harness/`,
  `src/harness/observation-compaction.ts`, `src/ai/agent.ts`,
  `src/ai/agent-context-pressure.ts`, `src/ai/model-policy.ts`,
  `src/ai/specialist.ts`, `src/ai/specialist-runtime.ts`,
  `src/agent/specialist-delegation.ts`,
  `src/domain/agent-handoff.ts`, `src/core/resource-request-policy.ts`,
  `src/harness/capability-discovery.ts`, `src/core/run-budget.ts`,
  `src/core/agent-run-service.ts`, `src/core/run-mailbox-policy.ts`,
  `src/bot/run-anchor.ts`, dan `src/storage/file-agent-run-repository.ts`.
- Tes: `tests/agent-runtime.test.ts`, `tests/agent-harness.test.ts`,
  `tests/create-bot-flow.test.ts`, `tests/harness-context-budget.test.ts`,
  `tests/harness-scope-capabilities.test.ts`, `tests/model-profile.test.ts`,
  `tests/model-policy.test.ts`, `tests/capability-discovery.test.ts`,
  `tests/specialist-delegation.test.ts`, `tests/specialist-runtime.test.ts`,
  `tests/model-architecture-contract.test.ts`,
  `tests/resource-request-policy.test.ts`, `tests/execution-policy.test.ts`,
  `tests/provider-adapter.test.ts`,
  `tests/run-budget.test.ts`, `tests/active-agent-run-service.test.ts`,
  `tests/run-mailbox-anchor.test.ts`, `tests/agent-context-pressure.test.ts`,
  `tests/observation-compaction.test.ts`, dan `tests/client.test.ts`.
- Phase M: `src/core/model-escalation-policy.ts`,
  `src/storage/file-model-escalation-repository.ts`,
  `scripts/routing-eval-corpus.ts`, `scripts/evaluasi-routing.ts`,
  `tests/model-escalation-policy.test.ts`, dan
  `tests/routing-evaluation-corpus.test.ts`.
- Wiring coding: `src/ai/coding-worker-driver.ts`,
  `src/ai/coding-validator-escalation.ts`,
  `src/coding/production-coding-validator-policy.ts`, dan
  `src/core/coding-runtime-composition.ts`.
- Keputusan: ADR-012, ADR-016, ADR-017, ADR-018, ADR-021, ADR-025, ADR-026,
  ADR-027, ADR-028, ADR-029, ADR-040, ADR-041.
