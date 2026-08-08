# Peta Konteks Harvy

Ini indeks pencarian, bukan checklist bootstrap. Mulai dari `AGENTS.md`, task,
git state, kode, tes, dan diff; gunakan peta ini setelah subsystem atau
pertanyaan konkret diketahui. Jangan memuat seluruh `docs/`.

## Snapshot ringkas

| Kebutuhan | Sumber |
|---|---|
| Risiko/blocker lintas subsystem | [`agent/CURRENT.md`](agent/CURRENT.md) |
| Ringkasan capability per area | [`engineering/STATUS.md`](engineering/STATUS.md) |
| Perubahan material terbaru | [`LOG.md`](LOG.md), cari maksimal 3 entri relevan |
| Cara kerja agent/Git | [`../AGENTS.md`](../AGENTS.md), lalu [`operations/WORKFLOW.md`](operations/WORKFLOW.md) bila perlu |

Snapshot membantu navigasi, bukan menggantikan kode dan tes sebagai bukti
keadaan aktual.

## Status per subsystem

| Area kode/task | Detail status |
|---|---|
| `src/agent`, `src/harness`, planner, tool, checkpoint, scope | [`engineering/status/agent-runtime.md`](engineering/status/agent-runtime.md) |
| `src/bot`, onboarding, private conversation, batching | [`engineering/status/telegram.md`](engineering/status/telegram.md) |
| `src/whatsapp`, group turn/memory/authority | [`engineering/status/whatsapp.md`](engineering/status/whatsapp.md) |
| task, reminder, check-in, session, tutoring, time | [`engineering/status/tasks.md`](engineering/status/tasks.md) |
| memory, history, compaction, file data | [`engineering/status/memory.md`](engineering/status/memory.md) |
| triage, review, consent, export/delete, privacy | [`engineering/status/safety-privacy.md`](engineering/status/safety-privacy.md) |
| Console, control plane, package, quota, cost | [`engineering/status/console.md`](engineering/status/console.md) |
| provider/fallback, runtime lock, logs, dev runner | [`engineering/status/platform.md`](engineering/status/platform.md) |

Buka satu detail yang cocok. Status monolit lama berada di
[`engineering/status/archive/`](engineering/status/archive/) hanya untuk
histori; jangan gunakan sebagai status terbaru.

## Dokumen kontrak menurut pertanyaan

| Pertanyaan konkret | Baca bagian relevan |
|---|---|
| Visi, target pengguna, roadmap, atau perilaku product yang diinginkan | [`PROJECT.md`](PROJECT.md) |
| Hak pengguna, privacy, safety, atau batas moral | [`CONSTITUTION.md`](CONSTITUTION.md) |
| Refactor lintas modul atau aliran data | [`engineering/ARCHITECTURE.md`](engineering/ARCHITECTURE.md) |
| Mutasi, adapter, UI, safety, group, atau authority | [`engineering/INVARIANTS.md`](engineering/INVARIANTS.md) |
| Setup, env, debug, model routing, probe | [`engineering/DEVELOPMENT.md`](engineering/DEVELOPMENT.md) |
| Strategi tes, bukti otomatis/manual | [`engineering/TESTING.md`](engineering/TESTING.md) |
| Branch, handoff, materialitas docs, hook | [`operations/WORKFLOW.md`](operations/WORKFLOW.md) |
| Console localhost dan operasi pilot | [`operations/HARVY_CONSOLE.md`](operations/HARVY_CONSOLE.md) |
| Paket/cohort pilot | [`product/PILOT_BETA_DAN_PAKET.md`](product/PILOT_BETA_DAN_PAKET.md) |
| Riset sementara agent engineering | [`research/AGENT_ENGINEERING_RESEARCH.md`](research/AGENT_ENGINEERING_RESEARCH.md) |
| Menjalankan Harvy | [`../README.md`](../README.md) |

Gunakan pencarian heading/istilah sebelum membuka rentang:

```bash
rg -n "subsystem|capability|namaFungsi|error|^## " docs src tests
sed -n '40,100p' docs/path-yang-relevan.md
```

## Keputusan durable

ADR dibaca hanya bila task menyentuh keputusan tersebut:

| ADR | Area |
|---|---|
| [`ADR-001`](decisions/ADR-001-agent-orchestration.md) | satu sumber instruksi dan satu penulis |
| [`ADR-002`](decisions/ADR-002-percakapan-bahasa-alami.md) | bahasa alami dan tombol |
| [`ADR-003`](decisions/ADR-003-routing-model.md) | routing model/provider/biaya |
| [`ADR-004`](decisions/ADR-004-percakapan-sepenuhnya-lewat-ai.md) | understanding/prompt/persona |
| [`ADR-005`](decisions/ADR-005-konteks-menggantikan-work-order.md) | konteks menggantikan work order; logging lama disupersesi ADR-019 |
| [`ADR-006`](decisions/ADR-006-memori-dan-riwayat-percakapan.md) | memory dan history privat |
| [`ADR-007`](decisions/ADR-007-bubble-dan-riwayat-percakapan-natural.md) | bubble, history, natural reply |
| [`ADR-008`](decisions/ADR-008-rencana-giliran-dan-fail-closed.md) | mutation gate, safety fail-closed, session |
| [`ADR-009`](decisions/ADR-009-whatsapp-grup-dan-armada-baileys.md) | WhatsApp group/multi-account |
| [`ADR-010`](decisions/ADR-010-log-operasional-produksi.md) | operational logging runtime |
| [`ADR-011`](decisions/ADR-011-partisipasi-natural-dan-evaluasi-grup.md) | ambient group/evaluation |
| [`ADR-012`](decisions/ADR-012-harness-agent-dan-scope-memori.md) | harness, capability, context, scope |
| [`ADR-013`](decisions/ADR-013-harvy-console-entitlement-dan-ledger-biaya.md) | Console, plan, quota, ledger |
| [`ADR-014`](decisions/ADR-014-structured-episodic-compaction-v2.md) | episodic compaction |
| [`ADR-015`](decisions/ADR-015-executor-web-baca-saja.md) | keputusan executor web yang telah dicabut |
| [`ADR-016`](decisions/ADR-016-scope-dan-otoritas-v1.md) | Workspace/group authority |
| [`ADR-017`](decisions/ADR-017-agent-runtime-internal-dan-delegasi.md) | internal agent runtime/delegation |
| [`ADR-018`](decisions/ADR-018-checkpoint-klarifikasi-agent-durable-lokal.md) | durable clarification checkpoint |
| [`ADR-019`](decisions/ADR-019-code-first-progressive-context.md) | code-first context, material docs, bounded bootstrap |
| [`ADR-020`](decisions/ADR-020-baseline-telemetry-per-giliran.md) | baseline turn telemetry, korelasi, latency/rate p50-p95 |
| [`ADR-021`](decisions/ADR-021-emergency-preflight-dan-boundary-local-first.md) | emergency preflight, local-first boundary, deterministic time fast path |
| [`ADR-022`](decisions/ADR-022-selective-safety-routing-dan-privacy-memory.md) | selective safety routing, unavailable, privacy memory, izin per efek |

ADR adalah rekaman keputusan, bukan status kemampuan. Bila ADR lama berisi
aturan yang telah disupersesi, ikuti ADR penerus dan kontrak aktif.

## Evidence dan histori

- Agent Runtime acceptance: [`evidence/agent-acceptance-v1-2026-08-04/`](evidence/agent-acceptance-v1-2026-08-04/)
- Group evaluation: [`evidence/group-conversation-2026-07-30/`](evidence/group-conversation-2026-07-30/)
- LOG lama: [`log/`](log/)
- Status snapshot lama: [`engineering/status/archive/`](engineering/status/archive/)

Evidence menjawab skenario spesifik pada baseline tertentu. Jangan menganggap
evidence lama membuktikan working tree terbaru tanpa memeriksa diff.

## Jika sumber berbeda

Untuk diagnosis, ikuti kode dan tes yang benar-benar berjalan, laporkan
perbedaan, dan jangan diam-diam menyelaraskan docs. Status subsystem adalah
ringkasan terverifikasi; product/ADR menjelaskan tujuan atau keputusan; LOG
menjelaskan histori. Perbarui hanya sumber yang material terhadap scope task.
