# Scratchpad — Pekerjaan Belum Selesai

Berkas kerja, bukan status. Ia mencatat sisa pekerjaan yang sudah punya bentuk
konkret supaya penulis berikutnya tidak menurunkannya ulang dari nol. Fakta yang
sudah terbukti ada di `docs/engineering/STATUS.md` dan `docs/LOG.md`; hapus
butir di sini begitu ia selesai atau ternyata tidak diperlukan.

## Kontrak planner `tool_choice: "auto"` dan tool recall

Kode dan unit test sudah masuk (lihat entri LOG 2026-08-28 "Planner tool_choice
auto dan tool recall pengguna"). Yang tersisa:

- **Gerbang repo belum ditutup.** Verifikasi baru berupa `npm run check` dan
  berkas tes terarah (`memory-executors`, `agent-conversation`, `agent-runtime`,
  `agent-tool-repair`, `capability-discovery`, `model-policy`). `npm test` penuh
  belum pernah selesai dijalankan untuk perubahan ini.
- **Belum ada bukti perilaku.** Tidak ada `npm run eval:conversation`,
  `probe-chat.ts`, atau kanal live untuk kontrak auto maupun ketiga tool recall.
  Sampai itu ada, tidak boleh ada klaim bahwa pemilihan tool Harvy membaik.
  Baseline sebelum/sesudah perlu diambil terpisah karena varians antar-run
  besar.
- **`history.search` praktis kosong di probe.** `scripts/probe-chat.ts` mencari
  ke `state.episodes`, dan probe tidak pernah menjalankan compaction, jadi
  hasilnya hampir selalu nol. Untuk mengukur tool ini perlu korpus episode
  sintetis atau menjalankan compaction di probe.
- **Script lain belum memasang tool recall.** `scripts/coba-agent.ts`,
  `scripts/coba-balasan.ts`, dan `scripts/probe-error-recovery.ts` tidak
  mengaktifkan `recallToolsInstalled`, sehingga ketiga capability tampil
  sebagai belum terpasang di sana. Konsisten, tetapi membuat ketiganya tidak
  dapat dipakai mengukur tool baru.

## Gerbang tool `internal_state` — perubahan setengah jalan

Membuka jalur tool untuk pertanyaan yang menunjuk state pengguna sendiri.
Bergantung pada kontrak `tool_choice: "auto"` di bagian atas berkas ini: di
bawah kontrak `required` yang lama, pengecualian `internal_state` benar dan
tidak boleh dibuka.

**Sudah masuk:**

- `src/ai/model-policy.ts` — `requestsAgentTooling` kini menerima
  `toolNeed === "internal_state"`. Komentar di sana mencatat bug asal
  pengecualian, alasan pembalikannya, dan syarat pemulihannya bila kontrak
  planner kembali menjadi `required`. Satu perubahan ini menutup ketiga
  pemanggil sekaligus: `create-bot.ts`, `whatsapp/private-conversation.ts`,
  dan `scripts/probe-chat.ts`.
- `tests/model-policy.test.ts` — assertion `internal_state` dibalik ke `true`.
- `tests/create-bot-flow.test.ts` — tes "tidak membiarkan proposal usage
  explicit membajak penilaian produk nonmekanis" disesuaikan: stub `agent`
  tidak lagi melempar, dan assertion inti bergeser ke `summaryCalls === 0`
  (surface usage tidak dibajak) alih-alih memaksa jalur `reply()`.

**Belum selesai:**

- **`tests/create-bot-flow.test.ts` belum dijalankan ulang** setelah suntingan
  tes di atas. Ini butir pertama yang harus dikerjakan.
- **`tests/whatsapp-private-conversation.test.ts` belum disentuh.** Sekitar
  baris 676–697 ada stub yang melempar `"internal_state model tanpa preflight
  bukan authority tool"`; ia akan merah dengan cara yang sama dan memerlukan
  penyesuaian setara dengan yang sudah dilakukan di `create-bot-flow`.
- **Situs `internal_state` lain belum diperiksa:** `create-bot-flow.test.ts`
  baris 185, 293, 427, 475; `whatsapp-private-conversation.test.ts` baris 814
  dan 2629. Semuanya hijau pada run terakhir, tetapi run itu terjadi sebelum
  suntingan tes terakhir.
- **`npm run check` dan `npm test` belum dijalankan** untuk perubahan ini.
- **Belum ada bukti perilaku.** Berlaku sama seperti butir kontrak auto:
  tidak boleh ada klaim bahwa pemilihan tool membaik tanpa baseline
  `eval:conversation` sebelum/sesudah.

**Risiko yang sudah diketahui:** giliran bernuansa emosi kini dapat masuk lane
agent. `selectGlobalRoute` tetap memaksa `conversation` untuk risk
`dukungan`/`bahaya` dan `safetySensitive`, jadi jalur safety tidak berubah;
yang berubah adalah giliran `feeling` bernuansa tinggi dengan risk `biasa`.
Ini bagian yang paling perlu dilihat saat eval.

**Bukti yang mendasarinya** (probe 2026-08-28, tiga frasa, model sungguhan):
extractor melabeli `internal_state` dengan confidence 0,70–0,95 di 10 dari 10
pengukuran, dan policy membuangnya setiap kali. `"aku ngerasa numpuk banget,
ada yang mendesak nggak?"` tidak memperoleh tool di 3 dari 3 run dan dijawab
dengan meminta pengguna menyebutkan tugasnya, padahal ada tugas jatuh tempo
besok. `"apa saja tugasku?"` lolos hanya karena cocok regex
`liveStateRequirement`. `"minggu ini aku harus ngapain aja ya"` tidak stabil:
3 dari 4 run diselamatkan rute deterministik `show-tasks`, 1 run jatuh ke
balasan tanpa tool.

## Tes merah yang belum tercatat pemiliknya

`tidak menggandakan Run Anchor Telegram bila edit dan delete sama-sama gagal`
(`tests/create-bot-flow.test.ts`) merah di working tree dan **bukan** berasal
dari perubahan gerbang `internal_state`: dengan perubahan itu di-stash, hasilnya
tetap 113 lulus / 1 gagal. Kemungkinan besar milik pekerjaan berjalan di
`src/bot/run-anchor.ts` dan `src/core/conversation-progress.ts`. Belum ada
entri untuknya di `docs/engineering/KNOWN-FAILURES.md`; pemiliknya yang
sebaiknya mencatat atau memperbaikinya.

## Divergensi `scripts/probe-chat.ts` dari adapter

Probe menghitung route tanpa gerbang `allowsDeterministicSurface` dan tanpa
interaksi `requiresLiveState` yang dipakai `src/bot/create-bot.ts`, dan tidak
punya cabang `show-tasks` sama sekali. Akibatnya ia melaporkan
`route: "show-tasks"` lalu diam-diam jatuh ke `conversation.reply()`, sehingga
over-report jalur tanpa tool untuk frasa pembacaan task. AGENTS.md menunjuk
probe ini sebagai alat bukti perilaku, jadi selisih ini membuat pengukuran
routing menyesatkan sampai diselaraskan. Adapter adalah authority; probe yang
harus mengikuti, bukan sebaliknya.

## Lane yang masih memakai kontrak wajib

`src/ai/group-agent-run-executor.ts` tetap memakai `completeToolTurn` dengan
`parseAgentNativeDecision` dan `tool_choice: "required"`. Ini sengaja tidak
diubah bersama jalur privat; belum diputuskan apakah lane grup sebaiknya ikut
memakai kontrak auto, dan keputusannya memerlukan pertimbangan turn-taking grup
sendiri, bukan sekadar konsistensi.

## UX percakapan — tiga perbaikan yang belum ditutup gerbangnya

Berasal dari telaah UX 2026-08-28 atas permukaan slash command, surface status
transient, dan copy kegagalan. Tiga butir pertama dari lima yang diidentifikasi;
dua sisanya belum disentuh sama sekali (lihat bagian bawah).

**Sudah masuk ke working tree:**

- `src/bot/create-bot.ts` — status transient Telegram dikirim dengan
  `disable_notification: true`. Sebelumnya tiap giliran yang lebih lambat dari
  grace period mengirim getar dan preview layar kunci untuk pesan yang beberapa
  detik kemudian dihapus lagi.
- `src/core/conversation-progress.ts` — detail baru `initial` pada phase
  `thinking` dengan satu note netral, plus `initialProgressEvent()`.
- `src/bot/create-bot.ts` dan `src/whatsapp/private-conversation.ts` — event itu
  dilaporkan **sebelum** `understand()`, bukan sesudah. Laporan non-interupsi
  paling awal dahulu terjadi setelah understanding, triase, dan retrieval
  memori selesai, sehingga surface status baru menyala ketika Harvy hampir siap
  menjawab dan pengguna menunggu layar kosong pada bagian giliran yang paling
  lama.
- `src/bot/agent-stop-copy.ts` (baru) — satu sumber untuk teks penghentian
  deterministik, menggantikan tangga if/ternary yang terduplikasi di tiga
  tempat dengan kata-kata yang sudah saling menyimpang. Tiga call site
  diganti: dua di `create-bot.ts`, satu di `agentResultMessage`
  (`whatsapp/private-conversation.ts`).
- `src/bot/run-anchor.ts` — tiga string membocorkan kosakata internal
  (`checkpoint`, `update run`); diganti dan `input_expired` kini membawa satu
  langkah lanjutan.
- `tests/create-bot-flow.test.ts` — dua assertion diselaraskan ke copy baru.

**Keputusan yang jangan dibalik tanpa membaca alasannya:**

- `initialProgressEvent()` sengaja tidak membawa `publicFocus`. Ia menyala
  sebelum triase final, jadi tidak boleh ada bagian keluaran model yang tampil
  di sana. Note-nya juga sengaja netral ("Aku baca dulu pesanmu") supaya benar
  untuk giliran apa pun, termasuk yang ternyata masuk lane keselamatan.
- Laporan awal itu dilewati saat `immediateDanger`, `urgentBoundary`, dan
  `hasImageInput`. Dua yang pertama menjaga lane safety tetap sunyi; yang
  ketiga tidak memanggil model sama sekali sehingga tidak pernah menunggu.
- Copy `budget_*` wajib tetap memuat substring `batas kerja kumulatifnya
  tercapai` dan `tidak akan mengarang`; ada assertion yang mengikatnya.
- Aturan isi `agent-stop-copy.ts` ada di header berkasnya: tanpa kosakata
  internal, satu langkah konkret, dan tidak menyuruh pengguna sekadar mengulang
  pesannya. Yang terakhir dahulu bertabrakan langsung dengan larangan yang sama
  di prompt `explainAgentStop`.

**Belum selesai:**

- **Gerbang repo belum ditutup.** Yang dijalankan baru `npm run check` (PASS),
  `npm run build` (PASS), dan `dist/tests/conversation-progress.test.js`
  (9/9 PASS). `npm test` penuh belum dijalankan.
- **`dist/tests/create-bot-flow.test.js` hasilnya belum stabil.** Satu run
  114/114 lulus; dua run lain gagal 2–3 tes. Baseline dengan seluruh perubahan
  ini di-stash juga gagal 2 tes, dan himpunan tes yang merah berpindah-pindah
  antar-run — jadi indikasinya flaky karena timing di host yang sedang sibuk,
  bukan regresi. Ini **belum dibuktikan tuntas**; perlu run berulang di host
  yang tenang sebelum disimpulkan. Bersinggungan dengan bagian "Tes merah yang
  belum tercatat pemiliknya" di atas.
- **Berkas tes lain belum dijalankan:** `whatsapp-private-conversation`,
  `run-mailbox-anchor` (mengassert `runFailureCopy`, yang ikut berubah), dan
  seluruh berkas yang menyentuh `run-anchor`.
- **`tests/agent-conversation.test.ts` baris ~241** masih memakai string yang
  sudah dipensiunkan (`"Run agent berhenti sebelum menghasilkan jawaban yang
  dapat dipercaya."`) sebagai teks riwayat fixture. Tidak merusak apa pun —
  hanya teks giliran sebelumnya — tetapi menyesatkan pembaca berikutnya.
  Berkas itu sedang diubah pekerjaan lain, jadi sengaja tidak disentuh.
- **Dokumentasi belum diperbarui.** Perubahan copy kegagalan dan waktu
  munculnya status adalah perilaku pengguna yang berubah, jadi menurut aturan
  di `AGENTS.md` ia menuntut `docs/engineering/status/agent-runtime.md` dan
  satu entri `docs/LOG.md`. Keduanya belum ditulis.
- **Belum ada bukti perilaku.** Tidak ada eval maupun kanal live. Khususnya:
  apakah status yang kini menyala lebih awal benar-benar terasa membantu, dan
  apakah copy penghentian baru terbaca wajar dalam suara Harvy, belum diuji
  pada siapa pun.

**Dua butir sisanya dari telaah yang sama, belum dimulai:**

- **Permukaan slash WhatsApp.** Katalog `src/bot/commands.ts` berisi 29
  command; Telegram menampilkan 14 karena sisanya diganti tombol, WhatsApp
  menampilkan seluruh 29 karena tidak punya tombol. Sekitar 20 di antaranya
  menduplikasi kemampuan yang sudah punya jalur bahasa alami lewat
  `semanticOperation`. Slash tak dikenal di WhatsApp juga membuang seluruh
  daftar shortcut ke layar. Arah yang diusulkan: sisakan slash untuk aksi
  destruktif/irreversible yang memang butuh invokasi tegas plus dua pintu
  navigasi, dan ganti sisanya dengan pola balasan bernomor. Ini mengubah
  kontrak permukaan pengguna, jadi perlu keputusan pemilik produk lebih dulu.
- **Domain `coding` pada semantic operation.** `DOMAIN_OPERATIONS` di
  `src/domain/semantic-operation.ts` tidak punya domain untuk coding, sehingga
  `/code`, `/code_status`, `/code_cancel`, `/github`, dan `/publish` adalah
  satu-satunya pintu ke kemampuan itu — satu-satunya kelompok yang benar-benar
  memaksa slash.

## Kemampuan yang absen secara rancangan

Harvy masih tidak dapat mencari apa pun di luar datanya sendiri. `history.search`
membaca riwayat pengguna, bukan web. Menambah pencarian web berarti membuka
trust domain jaringan baru (konektor, kredensial, kebijakan egress, penanganan
konten tidak tepercaya sebagai data), jadi ia proyek tersendiri dan bukan
perluasan `memory-executors.ts`.
