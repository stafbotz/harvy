# Arsip — Planner tool_choice auto dan tool recall pengguna

## 2026-08-28 — Planner tool_choice auto dan tool recall pengguna

Scope: `src/ai/conversation.ts`, `src/ai/agent.ts`,
`src/agent/memory-executors.ts`, `src/harness/capabilities.ts`, `src/app.ts`.

Changed: `completeAutoTurn`, `parseAgentAutoDecision`, dan
`AGENT_AUTO_PLANNER_PROMPT` berhenti menjadi kode mati. Planner memakai
`tool_choice: "auto"` sebagai kontrak default, sehingga seluruh tool terlihat
tiap giliran dan obrolan biasa dijawab teks tanpa dibungkus `harvy_final_v1`.
Kontrak wajib dipertahankan persis di dua tempat yang memerlukannya: named
tool_choice untuk kelas state-live, dan `required` untuk bentuk jawaban
terstruktur. Teks kosong ditolak `validateResponse`; keputusan action tetap
harus berasal dari tool call karena continuation memerlukan assistant turn.

Tiga capability baru menutup celah "tidak bisa mencari, tidak bisa mencatat":
`history.search`, `memory.list`, dan `memory.remember`. Ketiganya privat-saja
dan memeriksa ulang consent onboarding; jenis `personal` tidak ada di schema dan
`sensitiveConsent` tidak pernah diisi tool. Penolakan `MemoryService` dibedakan
antara `already_known` dan gagal simpan agar Harvy tidak mengaku mengingat
sesuatu yang tidak tersimpan.

Verified: `npm run check` PASS; `memory-executors` 10/10, `agent-conversation`
28/28 termasuk dua kasus auto baru, `agent-runtime` 21/21, serta
`agent-tool-repair` dan `capability-discovery` PASS.

Not verified: perilaku model nyata. Tidak ada `eval:conversation`, probe
provider, atau kanal live untuk kontrak auto maupun ketiga tool recall.
Pencarian web tetap tidak ada; tidak ada konektor jaringan yang dipasang.

Decision: pelebaran gerbang masuk Agent Runtime tidak dikerjakan di sini.
Percobaan menerima label `internal_state` sebagai authority tool dikembalikan
karena saat itu tidak ada bukti terukur dan `tests/create-bot-flow.test.ts`
mengunci aturan sebaliknya. Penulis lain melebarkannya di working tree yang sama
atas dasar probe 2026-08-28; pelebaran itu bergantung pada kontrak auto di sini,
jadi bila default kembali ke `required` pengecualian label harus ikut pulih.

Next: ukur dengan `npm run eval:conversation` dan `probe-chat.ts` apakah kontrak
auto menaikkan pemilihan tool yang tepat.
