# Current Context

Refreshed: 2026-08-21
Baseline: ee8f1ef
Context-Version: 1

## Verified baseline

- Working tree vertical slice berada di atas `main`/`origin/main` commit dasar
  `ee8f1ef`; tidak ada commit implementasi atau PR baru.
- `npm run check` PASS. `npm test` PASS 1.413/1.413 dalam 183 suite, 0 gagal.
  `npm run context:check` dan `git diff --check` PASS; diff check hanya memberi
  peringatan line-ending Windows.
- Provider exact `google-ai-studio/gemini-3.5-flash-lite` PASS live smoke pada
  20 Agustus 2026. Sandbox, GitHub, dan WhatsApp guard tetap berhenti sebelum
  efek karena masing-masing memerlukan Linux, confirmation draft-PR nonkritis,
  dan confirmation grup uji nonkritis.

## Recent material changes

- Long-term memory kini memisahkan hot JSON dari cold SQLite archive FTS5.
  User-model facts, versioned evidence-backed procedures, error lessons,
  durable learning outbox, persistent embedding cache, selective retrieval,
  generation-fenced forget, serta export v4 sudah dirangkai ke runtime.
  Fast-path tidak mencari archive/vector/procedure dan context tetap satu budget.
- Production coding composition kini menghubungkan private Telegram Workspace,
  ZIP/GitHub selection, iterative CodingRun, Run Anchor, validator/evidence,
  local Git commit, exact GitHub confirmation, startup recovery, serta shutdown
  fence. Runtime tetap default-off dan hanya membuka scheduler setelah receipt
  conformance sandbox exact. Trust-domain service rootless OCI, credential-free
  local-git/object bundle, dan credential-owning GitHub App broker tersedia;
  hostile-code/GitHub live evidence belum tersedia pada host ini.
- CodingRun `waiting_input` kini menyimpan pertanyaan target durable dan hanya
  reply Anchor tepercaya yang menjadi revision; checkpoint internal tetap
  `running`. Publish privat membuktikan branch, exact push, dan draft PR memakai
  confirmation berbeda, serta menolak offer setelah ACL epoch berubah. Profile
  provider exact code-owned hanya berlaku pada model+endpoint Google yang lulus
  effort/tool/signature replay/finish/pressure/timeout/retry smoke.
- Group coding dirangkai setelah authority observation dan sebelum ambient
  batching, dengan trusted actor, durable Workspace link/handoff, audience-safe
  status, private publish confirmation, dan lifecycle fence pada disable/
  removal/epoch change. `toughest` hanya one-shot critic setelah validator gagal
  berulang. Telemetry memisahkan TTFR dari time-to-final.

## Active cross-subsystem blockers

- Host ini Windows tanpa Docker/Podman/nerdctl/WSL Linux. Seluruh 15 hostile
  scenario harus lulus pada Linux non-root, image+seccomp+runtime exact sebelum
  receipt diterbitkan dan sandbox/coding production diaktifkan.
- GitHub App private credential, installation, callback deployment, dan
  repository uji nonkritis tidak tersedia. Branch `harvy/*`, exact push, stale
  remote, cancellation setelah push, dan draft PR belum diamati live.
- Provider primary exact sudah live-smoke, tetapi provider fallback tetap tanpa
  wire evidence dan sengaja nonaktif untuk coding. Tidak ada target model
  `toughest`+privacy domain yang dikonfigurasi, jadi critic live belum diuji.
- WhatsApp GroupAgentRun/group-coding belum menjalani participant kedua,
  assigned waiting input, crash-after-send, reconnect proses, authority churn,
  dan private publish flow pada grup nyata.
- Control-plane Workspace/project/run/evidence/GitHub/group, local-git dan
  broker ledger masih file/single-service. Hanya lease sandbox memakai SQLite
  CAS lintas proses. Distributed authority lease, shared object store, outbox/
  dispatcher, dan reconciliation multi-instance belum ada; jangan klaim
  horizontal-safe.
- Long-term learning masih single-node SQLite/lexical cold search; producer
  runtime awal baru primary memory dan observable Telegram private AgentRun.
  Group/project/connector/multimodal learning, LLM synthesis, ANN/vector
  ranking cold, dan skill promotion belum dirangkai. Gap privacy/safety lama
  tetap berlaku: dual-model sensitive-memory misclassification dan FP/FN corpus
  model aktual belum diukur live.

## Route to detail

- [Agent Runtime](../engineering/status/agent-runtime.md)
- [Telegram](../engineering/status/telegram.md)
- [WhatsApp](../engineering/status/whatsapp.md)
- [Memory and data](../engineering/status/memory.md)
- [Project workspace and coding](../engineering/status/coding.md)
- [Safety and privacy](../engineering/status/safety-privacy.md)
- [Platform](../engineering/status/platform.md)

## Maintenance

Replace stale bullets; do not append chronology. Keep at most three recent
changes and only cross-subsystem blockers. Never include credentials,
identifiers, raw logs, prompts, or user quotations. This file must remain at
most 5,120 bytes and total bootstrap output at most 8,192 bytes.
