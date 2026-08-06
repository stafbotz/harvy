# Riset Sementara — Context, Harness, Loop, Graph, dan Agent Sosial Harvy

- **Status:** draf riset non-normatif; bukan spesifikasi dan bukan kemampuan aktif
- **Tanggal:** 2 Agustus 2026
- **Tujuan:** menjaga hasil riset tetap dapat dibaca sesi berikutnya sebelum
  keputusan arsitektur dipromosikan ke ADR dan dokumen produk
- **Aturan hapus:** hapus dokumen ini setelah keputusan yang diterima telah
  dipindahkan ke `PROJECT.md`, ADR terkait, spesifikasi implementasi, dan
  `engineering/STATUS.md`; jangan menghapusnya hanya karena satu sesi riset
  selesai

Dokumen ini sengaja berada di folder `research/`. Ia mencatat hipotesis,
rekomendasi, dan pertanyaan terbuka. Kalimat di sini tidak boleh dipakai untuk
mengklaim Harvy sudah mempunyai capability baru.

Catatan status 5 Agustus 2026: vertical slice research web yang pernah dibangun
kemudian dicabut dari runtime. Bagian yang menyebut executor web adalah riwayat
rancangan, bukan kemampuan Harvy saat ini.

## Pertanyaan yang diteliti

1. Bagaimana Harvy membawa percakapan panjang tanpa kehilangan hal penting?
2. Kapan riwayat perlu dipadatkan dan apa yang harus bertahan sesudahnya?
3. Bagaimana context engineering, harness engineering, loop engineering, dan
   graph engineering berhubungan?
4. Apa yang dapat dipelajari dari Codex, Claude Code, dan karya Andrej Karpathy?
5. Bagaimana Harvy terasa berbeda di grup 1, grup 2, grup 3, individu 1, dan
   individu 2 tanpa kebocoran data atau perubahan identitas moral?
6. Bagaimana kemampuan agent meningkatkan kecakapan sosial Harvy tanpa membuat
   Harvy terlalu banyak bicara atau mengoptimalkan keterlibatan?

## Kesimpulan eksekutif

Intuisi pemilik produk benar pada dua hal pokok.

Pertama, Harvy sebaiknya mempertahankan beberapa giliran terbaru secara utuh
dan memadatkannya ketika anggaran token mulai tertekan. Koreksinya: pemadatan
tidak menunggu jendela hampir penuh dan tidak memakai satu angka untuk semua
model atau route. Harvy harus menghitung proyeksi input berikutnya, menyisakan
ruang bagi keluaran, tool schema, observation, dan keselamatan, lalu membuat
ringkasan episodik terstruktur secara asinkron.

Kedua, ruang harus benar-benar terisolasi. Orang yang sama di dua grup bukan
satu identitas sosial global. Harvy boleh memakai alias dan norma yang diminta,
keputusan ruang, serta statistik mekanis agregat yang berjendela; ritme giliran
hanya menjadi konteks sesaat. Harvy tidak menyimpulkan sifat, relasi, emosi,
status sosial, atau preferensi anggota dari percakapan. Prinsip, keselamatan,
kejujuran, dan hak data Harvy tetap sama; yang menyesuaikan adalah konteks lokal
dan cara hadirnya.

Rekomendasi arsitekturnya adalah:

> **recent verbatim + structured episodes + scoped retrieval + durable run
> state + bounded agent loop + verified effects**

Agent yang hebat tidak lahir dari loop tanpa batas. Ia lahir dari konteks
bermutu, tool sempit, state yang dapat dipulihkan, feedback nyata, batas yang
jelas, dan evaluator yang dapat membuktikan outcome.

## Keadaan Harvy yang sudah diperiksa

Fondasi saat ini lebih maju daripada produk agent yang terlihat pengguna.

- [`history-policy.ts`](../../src/core/history-policy.ts) memakai jumlah
  giliran: pemadatan setelah lebih dari 16 giliran, menyisakan 6 giliran, dan
  hard cap prompt 24 giliran. Ia belum memakai token model.
- [`context-budget.ts`](../../src/harness/context-budget.ts) membatasi konteks
  dengan 16.000 karakter, maksimum 18 giliran, dan 8 memori. Sejak 2 Agustus
  2026, selection yang sama juga menghasilkan
  [`context-manifest.ts`](../../src/harness/context-manifest.ts): manifest v1
  bebas isi yang membedakan source/eligible/included/clipped/dropped per route,
  karakter budget, estimasi token bernama, dan utilisasi. Ia terpasang pada
  inference privat serta planner, revalidasi, dan reply grup, tanpa dikirim ke
  provider; log operasional hanya mempertahankan metrik kapasitas agregat,
  sedangkan rincian struktur context tetap transient. Estimasi seluruh prompt
  juga dipasangkan dengan usage provider aktual sebagai error bertanda dan
  rasio permille; label operasi lokal membedakan planner, revalidasi, dan reply
  tanpa ikut ke provider. Respons tanpa usage ditandai sebagai estimasi dan
  tidak menghasilkan rasio palsu. Ini baru dataset kalibrasi observability:
  estimator belum beradaptasi dan selection/pemadatan belum memakai tokenizer,
  route budget nyata, atau tool schema.
- [`history-service.ts`](../../src/core/history-service.ts) dan
  [`episodic-compaction.ts`](../../src/core/episodic-compaction.ts) sudah
  melakukan compaction v2 di latar menjadi episode terstruktur berprovenance,
  tanpa merangkum ulang episode lama. Commit memeriksa generation, coverage,
  awalan, dan source hash; chunk/backlog, suspend setelah penarikan izin,
  retensi, concurrency global, migrasi v1, serta drain shutdown sudah dibatasi
  dan diuji. Provenance itu receipt struktural, bukan audit semantik setelah
  sumber mentah dibuang.
- [`scope.ts`](../../src/harness/scope.ts) sudah memisahkan privat
  `channel + user`, grup `channel + group + member`, dan Workspace
  `workspace + membership + principal + aclEpoch`. Workspace authority memakai
  role/permission matrix, canonical namespace, dan CAS epoch; surface Workspace
  belum dipasang ke aplikasi.
- Grup menyimpan konteks mentah hanya di RAM sampai 24 giliran atau dua jam.
  Memori semantik anggota sudah terpisah per grup+anggota. Shared room memory
  untuk keputusan, agenda, norma, kegiatan, dan catatan kini ada sebagai
  proposal eksplisit→preview→konfirmasi admin, dengan retensi 60 hari dan
  reset yang tidak mengambil member-local memory. Membership Harvy/pengirim,
  epoch, cache, batch, dan guard mutasi direvalidasi fail-closed; repository
  file juga menghapus state satu anggota secara atomik. Room social profile
  yang kaya (formality, panjang reply, emoji, dan norma budaya) belum dibuat.
- [`agent-harness.ts`](../../src/harness/agent-harness.ts) sudah mempunyai
  capability snapshot, loop `final|need_input|action`, input validation,
  approval binding, idempotency key, checkpoint serializable, step/deadline/
  cycle limit, cancellation, dan generation freshness.
- Runtime privat Telegram kini memanggil `AgentHarness.run()` untuk tool state
  internal baca-saja, terminal virtual, dan delegasi berbatas. `AiClient`
  mengirim native function tools; setiap executor memiliki nama+schema yang
  ikut hash callable checkpoint, lalu respons provider dinormalisasi kembali ke
  kontrak kernel. Checkpoint `waiting_input` privat durable pada adapter file
  satu-proses, tetapi run aktif, workspace artifact, outbox, receipt, dan
  reconciler belum ada. Executor web sudah dicabut. Status sahnya tetap
  [`engineering/STATUS.md`](../engineering/STATUS.md).

Implikasinya: Harvy tidak memerlukan framework agent baru sebagai langkah
pertama. Ia perlu memperdalam kontrak yang sudah ada dan memasang penyimpanan
serta executor di bawahnya.

## Empat istilah yang dipelajari

| Istilah | Makna yang berguna | Yang bukan |
|---|---|---|
| Context engineering | Memilih, mengurutkan, mengambil, dan memadatkan token yang paling berguna bagi satu inference | Mengirim semua data karena model punya jendela besar |
| Harness engineering | Seluruh perangkat lunak di sekitar model: context compiler, capability, tools, policy, executor, approval, trace, dan eval | Prompt panjang yang berharap model menegakkan semua aturan |
| Loop engineering | Pengendali `plan → act → observe → decide`, lengkap dengan exit condition, budget, cancellation, dan error semantics | Perintah “terus coba sampai bisa” tanpa batas |
| Graph engineering | State machine/workflow graph bertipe, dengan node, transisi, checkpoint, interrupt, retry, dan versioning | Diagram rumit yang dengan sendirinya membuat sistem durable |

`Harness engineering`, `loop engineering`, dan `graph engineering` masih sering
dipakai sebagai istilah informal. Komponen teknik di baliknya nyata, tetapi
nama itu tidak boleh diperlakukan sebagai standar yang otomatis menentukan
arsitektur.

## Prinsip arsitektur: state bukan context

Empat benda berikut tidak boleh dilebur.

| Benda | Fungsi | Authority |
|---|---|---|
| Context aktif | Proyeksi token yang dilihat model pada langkah ini | Sementara dan dapat hilang |
| Memori | Fakta/preferensi/episode yang boleh dipakai lagi | Store berscope dan berkendali pengguna |
| Run checkpoint | Goal, step, approval, action, receipt, dan status pelaksanaan | State eksekusi otoritatif |
| Artifact | Laporan, sumber, task, polling, atau hasil kerja | Objek domain yang dapat diperiksa |

Ringkasan percakapan tidak boleh menjadi satu-satunya tempat menyimpan action
ID, payload approval, deadline, idempotency key, receipt provider, status
`unknown`, atau pertanyaan yang sedang menunggu jawaban. Semua itu adalah state
bertipe.

## Model scope Harvy

Identitas inti Harvy global, tetapi data dan adaptasi selalu lokal.

```text
HarvyCore
├── PrivateSpace(channel, principal)
│   ├── ConversationEpisode
│   ├── PrivateMemory
│   └── AgentRun
├── WorkspaceSpace(workspace)
│   ├── Membership(principal, role)
│   ├── SharedArtifact + ACL
│   ├── AgentRun
│   └── ScopeEpoch
└── GroupRoom(channel, group)
    ├── RecentRoomEpisode
    ├── SharedRoomMemory
    ├── RoomSocialProfile
    ├── AgentRun
    └── MemberInRoom(member)
        └── MemberLocalMemory
```

Aturan akses minimum:

| Data | Privat sama | Grup sama | Anggota sama di grup | Grup lain | Privat anggota |
|---|---:|---:|---:|---:|---:|
| Private memory | Ya | Tidak | Tidak | Tidak | Tidak otomatis; hanya scope privat asli atau account link terverifikasi dan berizin |
| Shared room memory | Tidak | Ya | Ya | Tidak | Tidak |
| Member-in-room memory | Tidak | Hanya saat anggota itu bicara | Ya | Tidak | Tidak |
| Room social profile | Tidak | Ya | Ya | Tidak | Tidak |
| Workspace research artifact | Sesuai ACL | Sesuai ACL | Sesuai ACL | Sesuai ACL | Tidak otomatis |
| Run/checkpoint | Pemilik/scope run | Scope run | Sesuai otoritas | Tidak | Tidak otomatis |

ACL Workspace tidak memperluas izin atas data grup. Artefak yang diturunkan
dari percakapan, ringkasan, atau memori sebuah grup tetap terikat ke grup asal
secara default. Berbagi lintas ruang harus menjadi tindakan eksplisit dengan
preview, otoritas yang benar, provenance, dan penyaringan data privat maupun
member-in-room; status admin atau pembayar Workspace saja tidak cukup.

`WorkspaceScope` kini sudah menjadi varian `AgentScope` Harvy sebagai fondasi
teruji. Ia membawa `workspaceKey`, principal peminta, membership terverifikasi,
role, permission, namespace artifact, dan `aclEpoch`; service membentuk scope
kanonik dan repository memakai CAS saat epoch berubah. Nilai-nilai itu tetap
harus berasal dari membership store dan ingress, bukan teks atau keputusan
model. Belum ada ingress/UI Workspace, artifact store, account linking,
PostgreSQL, atau durable run.

Scope selalu berasal dari ingress tepercaya. Model, display name, nomor telepon,
kesamaan nama, atau isi pesan tidak pernah menentukan bahwa dua principal adalah
orang yang sama. Account linking kelak harus terverifikasi, selektif, dapat
diputus, dan mendapat persetujuan.

Retrieval juga harus dimulai dari scope:

```text
resolve trusted scope
→ ACL/metadata filter di query penyimpanan
→ lexical + semantic + temporal retrieval
→ rerank
→ fit ke token budget
```

Pencarian global lalu memfilter hasil sesudah retrieval terlalu berisiko. Data
yang tidak berhak dibaca seharusnya tidak pernah menjadi kandidat.

## Context architecture yang disarankan

Urutan konteks untuk satu inference:

1. identitas, Konstitusi, dan hard policy Harvy;
2. capability snapshot dan aturan surface yang benar-benar aktif;
3. scope label tepercaya tanpa membocorkan ID platform;
4. pesan sekarang dan active episode terbaru;
5. unresolved goal, constraint, dan run state yang relevan;
6. ringkasan episode lama;
7. memori semantik yang lolos scope dan relevance threshold;
8. tool/source observation just-in-time;
9. instruksi bentuk keluaran untuk langkah tersebut.

Harvy harus mempertahankan tiga trust lane ketika menyusun maupun memadatkan
konteks:

- **trusted code state:** policy, capability, approval, dan state domain;
- **user-authored untrusted data:** pesan, riwayat, dan memori dari perkataan
  pengguna;
- **external untrusted data:** web, X, Threads, file, MCP, serta keluaran tool.

Compactor tidak boleh mengubah kalimat dari dua lane tidak tepercaya menjadi
instruksi atau fakta sistem yang dianggap benar.

### Anggaran berbasis token

Rumus konseptual:

```text
active_input_budget = model_context_window
                    - reserved_output
                    - reserved_tool_and_observation_growth
                    - safety_margin
```

`reserved_output` dan margin berbeda menurut model dan route. Percakapan biasa,
triase, tutoring, planner agent, serta synthesis riset tidak harus memakai
budget sama.

Hipotesis awal untuk diuji, bukan angka kontrak:

- sekitar 60%: siapkan compaction snapshot di latar;
- sekitar 75%: ganti episode lama dengan summary terstruktur;
- sekitar 90%: hard guard; kurangi tool/schema tidak relevan dan lakukan reset
  terkontrol bila continuity sudah tidak aman.

Untuk preflight, gunakan tokenizer lokal atau endpoint count-token provider bila
tersedia. Usage aktual dari respons baru diketahui setelah inference dan hanya
dipakai mengkalibrasi estimator bagi request berikutnya; ia tidak dapat
menentukan budget request yang sedang berjalan. Fallback memakai estimator
konservatif. Batas karakter tetap berguna sebagai pagar payload, tetapi bukan
budget perhatian utama.

### Bentuk ringkasan episode

```ts
interface EpisodeSummary {
  scopeKey: string;
  episodeId: string;
  fromSequence: number;
  throughSequence: number;
  goals: SummaryClaim[];
  decisions: SummaryClaim[];
  corrections: SummaryClaim[];
  commitments: SummaryClaim[];
  unresolved: SummaryClaim[];
  temporalAnchors: SummaryClaim[];
  artifactRefs: string[];
  uncertainty: string[];
  sourceMessageIds: string[];
  sourceHash: string;
  schemaVersion: number;
  summarizerVersion: string;
  createdAt: string;
}
```

Satu summary blob yang terus diringkas ulang akan mudah drift. Gunakan episode
berurutan dengan range, provenance, dan koreksi. Model boleh membuat kandidat
summary, tetapi parser dan merge code menjaga schema, coverage cursor,
concurrency, dan invalidation.

Compaction harus:

- berjalan setelah delivery atau di background, bukan menahan balasan;
- mengambil snapshot sampai sequence tertentu;
- membiarkan tail baru tetap verbatim;
- commit hanya ketika source hash, generation, dan coverage cursor masih cocok;
- mempertahankan state lama bila peringkas gagal;
- memiliki bounded concurrency dan retry cooldown;
- dapat dibatalkan oleh penghapusan;
- menjaga provenance serta penanda ketidakpastian;
- diuji setelah 1, 5, dan 10 siklus agar drift terlihat.

### Penyimpanan dan konteks prompt bukan hal yang sama

Harvy tidak perlu memasukkan seluruh transcript ke prompt. Raw private history
dapat tetap tersedia sesuai kebijakan retensi, ekspor, dan penghapusan; context
assembler hanya membawa bagian yang relevan. Untuk grup, default yang lebih
aman tetap tidak menyimpan transcript mentah jangka panjang. Kesinambungan grup
dibangun dari recent RAM episode dan shared memory terstruktur yang dapat
dilihat/reset, bukan hidden transcript archive.

Keputusan retensi final belum diambil di dokumen ini.

## Harvy berbeda per individu dan per grup

Harvy adalah satu karakter. Yang berbeda adalah cara ia memahami ruang dan
memberi respons.

Contoh:

- Individu 1: “Jawab langsung, singkat, minim emoji.”
- Individu 2: “Kalau belajar, tuntun langkah demi langkah dan jangan beri
  jawaban akhir dulu.”
- Grup 1: “Di sini panggil dirimu Kapi; nimbrung hanya kalau pertanyaan belum
  terjawab.”
- Grup 2: “Grup ini untuk belajar; gunakan jawaban agak rinci dan sertakan
  sumber.”
- Grup 3: “Harvy hanya merespons tag dan membantu mencatat keputusan rapat.”
- Anggota di grup: “Kalau menjawab aku di grup ini, singkat saja.”

Permintaan tetap memakai bahasa alami. Parser/model mengusulkan interpretasi,
tetapi perubahan preferensi atau memori melalui layanan bertipe dan kontrol
yang dapat dibatalkan.

### Room social profile

Social profile harus terlihat, terbatas, dapat direset, dan tidak memuat label
psikologis.

```ts
interface RoomSocialProfile {
  scopeKey: string;
  explicit: {
    harvyAliases: string[];
    participationMode: "direct" | "selective" | "paused";
    replyLength: "short" | "balanced" | "detailed";
    formality: "casual" | "balanced" | "formal";
    emojiLevel: "none" | "low" | "balanced";
  };
  observedWindow: {
    from: string;
    through: string;
    expiresAt: string;
    sampleCount: number;
    medianTurnCharacters: number | null;
    medianBubbleCount: number | null;
    paceBucket: "quiet" | "normal" | "busy" | null;
  } | null;
  version: number;
  updatedAt: string;
}
```

Bagian `explicit` berasal dari kontrol grup. Bagian `observedWindow` hanya
statistik mekanis berjendela dan kedaluwarsa. Kosakata mentah, konflik, tuduhan,
preferensi politik, kesehatan, kerentanan, peran psikologis, atau label seperti
“pemalu”, “paling pintar”, dan “bermasalah” tidak masuk profile.
Expiry observasi wajib, periodenya terlihat, dan reset harus segera
menginvalidasi context/cache. Observasi tidak boleh dipakai lagi setelah Harvy
dikeluarkan dari ruang. Pengaturan eksplisit bertahan hanya sesuai retensi dan
kontrol ruang yang akhirnya disepakati.

Matriks otoritas minimum adalah release blocker: pengelola ruang hanya boleh
mengatur perilaku Harvy yang berlaku bagi ruang; setiap anggota menguasai
preferensi serta data tentang dirinya; pengelola tidak dapat melihat, mengubah,
atau menghapus member-local/private memory. Preferensi individual menang untuk
balasan kepada anggota itu sejauh tidak mengubah hak anggota lain, sedangkan
Konstitusi dan keselamatan selalu berada di atas keduanya. Cara ruang menunjuk
pengelola dan menyetujui keputusan kolektif tetap perlu diputuskan sebelum
fitur ini hidup.

Adaptasi Harvy terlihat melalui:

- alias yang dipilih ruang;
- panjang dan struktur jawaban;
- tingkat formalitas dan emoji yang wajar;
- keputusan kapan bicara atau diam;
- threading dan addressee yang benar;
- referensi pada keputusan/agenda grup yang memang tersimpan;
- kemampuan menerima koreksi tanpa mempertahankan inferensi lama.

Harvy tidak sengaja meniru typo, penghinaan, kebohongan, atau pengalaman
manusia. Harvy juga tidak mengubah identitas, keselamatan, kejujuran, atau
hak pengguna agar terasa cocok.

### Tiga jenis “belajar sosial”

1. **Ephemeral adaptation:** memahami ritme, addressee, thread, serta giliran
   terbaru dari recent room episode; hilang dalam jam.
2. **Room-local memory:** alias, norma eksplisit, agenda, dan keputusan biasa
   yang terlihat serta dapat dihapus/reset di grup tersebut.
3. **Global social improvement:** kebijakan kapan bicara, timing, dan bentuk
   balasan diperbaiki secara offline dari corpus sintetis. Pesan produksi hanya
   boleh masuk corpus evaluasi melalui opt-in terpisah setiap peserta yang
   pesannya dipakai—persetujuan admin tidak mewakili anggota—beserta tujuan,
   retensi, hak penghapusan, dan persetujuan wali bila diwajibkan. Pesan anggota
   yang tidak menyetujui harus dikeluarkan sebelum de-identification; anonimasi
   bukan pengganti consent. Isi satu grup tidak menjadi pengetahuan global.

Tidak ada online self-training langsung dari chat produksi. Perubahan social
policy melewati dataset, evaluator, review, versi, dan release gate.

```text
recent observations
→ safe feature extraction
→ decayed room-local profile
→ scoped context assembly
→ candidate response/silence
→ policy + stale revalidation
→ delivery
→ offline evaluation and release learning
```

Tujuan evaluator sosial adalah naturalness, usefulness, ketepatan addressee,
dan kendali pengguna—bukan jumlah pesan, waktu penggunaan, atau retensi.

## Harness Harvy yang dituju

```text
Ingress / trusted scope
        ↓
Safety + consent + deterministic controls
        ↓
Fast router ─────────────────────────→ Fast conversation path
        │
        └──→ Context compiler
                  ↓
             Planner adapter
                  ↓
          Canonical tool proposal
                  ↓
      Schema + capability + policy gate
                  ↓
          Approval / durable pause
                  ↓
         Outbox / read executor
                  ↓
      Observation + receipt + verifier
                  ↓
           Replan or finalize
```

Komponen harness:

- `ContextCompiler`: membuat proyeksi token berscope dan bertanda trust;
- `PlannerAdapter`: menerjemahkan native tool call atau structured output ke
  bentuk internal yang sama;
- `CapabilityCatalog`: authority kemampuan nyata per surface;
- `PolicyEngine`: scope, consent, approval, cost, dan safety gate;
- `ExecutorRegistry`: validator serta pelaksana tool sempit;
- `RunStore`: checkpoint dan transisi durable;
- `OutboxDispatcher`: mengeksekusi command setelah transaksi lokal commit;
- `Reconciler`: memeriksa outcome provider yang ambigu;
- `TraceStore/Evals`: trajectory, biaya, latency, dan outcome tanpa
  menyembunyikan kegagalan.

Model tetap planner, bukan authority. Ia tidak memegang credential, memilih
scope, memberi approval, atau menandai tindakan eksternal berhasil.

## Dua jalur: cepat dan durable

Percakapan, tutoring, keselamatan, pengaturan data, dan tugas sederhana tetap
memakai workflow cepat/deterministik. Menjalankan agent loop panjang pada setiap
pesan akan membuat Harvy lambat dan terlalu mudah menyela grup.

Pekerjaan seperti research web/X/Threads, perbandingan banyak sumber,
monitoring, atau tindakan lintas aplikasi memakai durable run:

```mermaid
flowchart LR
    A["Permintaan"] --> B["ACK cepat"]
    B --> C["Create durable run"]
    C --> D["Plan"]
    D --> E["Parallel read tools"]
    E --> F["Normalize dan verify"]
    F --> G["Synthesis bersitasi"]
    G --> H["Shared report"]
    H --> I["Propose action"]
    I --> J["Approval"]
    J --> K["Outbox dan executor"]
    K --> L["Receipt atau reconcile"]
```

Progress dikirim hemat dan tidak memblokir FIFO chat. Research ambient tidak
dimulai hanya karena topik tampak menarik; Harvy menunggu permintaan langsung
atau tawaran yang diterima.

## Loop dan graph state

State machine minimum:

```text
created
→ planning
→ executing_read
→ planning | synthesizing
→ completed | proposed_action

planning/executing_read
→ waiting_input
→ planning | cancelled | expired

proposed_action
→ waiting_approval
→ authorized | rejected | cancelled | expired
→ dispatch_pending
→ executing_action
→ succeeded | failed | unknown

unknown
→ reconciling
→ succeeded | failed | manual_review

setiap state nonterminal
→ cancelled | expired

lease hilang / worker crash
→ resumable_queued → state checkpoint terakhir

kegagalan infrastruktur berulang melewati retry budget
→ dead_letter → manual_review
```

State terminal adalah `completed`, `succeeded`, `failed`, `rejected`,
`cancelled`, `expired`, dan `manual_review`. `dead_letter` bukan keberhasilan
atau kegagalan outcome eksternal; ia menahan run sampai operator meninjaunya.
Resume selalu membaca checkpoint persisten, memperoleh lease baru, dan
memeriksa ulang scope epoch, cancellation, approval, serta capability hash.

Setiap run mempunyai:

- `scope_key`, `requester`, `goal`, `flow_version`, dan `capability_hash`;
- max step, deadline, token/tool/cost budget, dan cancellation state;
- optimistic version serta worker lease;
- checkpoint dan observation yang JSON-serializable;
- privacy generation serta retention class;
- final artifact atau alasan berhenti yang jujur.

Setiap node harus menjelaskan retry semantics. Read-only search boleh dicoba
ulang dengan batas. Mutasi eksternal yang timeout setelah send menjadi
`unknown`, bukan langsung retry.

Graph adalah cara memodelkan control flow. Harvy dapat memulai dengan state
machine TypeScript + PostgreSQL di bawah `AgentHarness`. LangGraph menawarkan
checkpoint, interrupt, dan replay; Temporal menawarkan durable workflow yang
lebih kuat. Keduanya tidak menghilangkan kebutuhan scope, policy, approval,
idempotency, outbox, atau rekonsiliasi. Pemilihan dependency ditunda sampai
vertical slice dan beban operasi terukur.

### Penyimpanan durable minimum

- `agent_runs`
- `agent_steps`
- `agent_approvals`
- `agent_actions`
- `agent_outbox`
- `agent_inbox`
- `agent_reconciliation_jobs`
- `conversation_events`
- `episode_summaries`
- `memories`
- `group_social_profiles`
- `research_sources`
- `research_reports`
- `scope_epochs`

Approval dan penulisan outbox berlangsung dalam satu transaksi database.
Network call berada di luar transaksi. Hanya receipt terverifikasi atau
reconciler yang boleh memindahkan action ke `succeeded`.

Setiap connector tulis wajib mendeklarasikan dukungan idempotency, cara
verifikasi outcome (query, event, webhook, atau receipt), batas waktu ambiguitas,
dan prosedur manual. Bila provider tidak memberi bukti yang cukup untuk
membedakan “tidak terjadi” dari “terjadi tetapi respons hilang”, write
capability tersebut tetap `unavailable`; reconciler tidak boleh mengarang
kepastian. Status `manual_review` dapat menjadi hasil akhir yang jujur.

## Pelajaran dari Codex

Codex membedakan beberapa permukaan yang berguna:

- prompt/thread untuk constraint satu pekerjaan;
- `AGENTS.md` untuk aturan repository yang durable;
- skill untuk workflow berulang;
- MCP untuk data dan tindakan eksternal;
- subagent untuk pekerjaan bounded yang akan mengotori main context;
- chat terpisah untuk outcome yang benar-benar berbeda;
- manual/automatic compaction berbasis token saat chat memanjang;
- goal panjang yang menyebut outcome, constraints, dan verification.

Terjemahan bagi Harvy: jangan simpan aturan wajib hanya di conversation
summary; pisahkan instruksi inti dari memori; gunakan worker context terisolasi
untuk riset yang bising; dan kembalikan ringkasan serta artifact, bukan seluruh
trace tool, ke percakapan utama.

## Pelajaran dari Claude Code

Claude Code juga menunjukkan pemisahan penting:

- `CLAUDE.md` dan auto-memory memberi context, bukan hard enforcement;
- permissions, sandbox, dan hooks menjadi gate mekanis;
- root instructions dimuat kembali sesudah compaction;
- auto-memory memakai index pendek dan topic files yang dibaca just-in-time;
- subagent biasanya mendapat context baru dan mengembalikan ringkasan;
- session resume atau file checkpoint tidak membuktikan external side effect;
- tool search/lazy schemas mengurangi context yang tidak relevan.

Terjemahan bagi Harvy: Konstitusi, scope isolation, dan approval harus hidup di
kode; memori hanya recall layer; tool schema dimuat menurut route; dan durable
action state terpisah dari chat transcript.

## Pelajaran dari Andrej Karpathy

Yang diambil adalah prinsip engineering, bukan peniruan persona.

1. **Software 2.0:** ketika perilaku sulit ditulis sebagai aturan tetapi dapat
   dievaluasi, dataset dan evaluator menjadi bagian spesifikasi. Social Harvy
   membutuhkan corpus, rubric, dan regression gate.
2. **Autonomy slider:** LLM bersifat stokastik dan tidak rata kemampuannya.
   Produk perlu tingkat otonomi: jawab → usulkan → minta izin → otomatisasi
   terbatas, bukan sakelar chatbot versus agent penuh.
3. **Autoresearch loop:** scope mutable sempit, satu metric mekanis, baseline,
   fixed time budget, hasil machine-readable, serta keep/discard yang dapat
   dibalik membuat iterasi agent jauh lebih berguna.
4. **Build for agents:** sumber dan tool harus dapat dinavigasi secara jelas;
   API, schema, error, dan artifact harus ramah mesin sekaligus manusia.

Instruksi eksperimen seperti “never stop” atau menonaktifkan semua izin tidak
boleh disalin ke Harvy. `autoresearch` bekerja pada sandbox eksperimen yang
sempit dan mempunyai metric objektif. Harvy berinteraksi dengan pelajar,
privasi, grup, serta tindakan luar; loop-nya harus dapat berhenti, dibatalkan,
dan diperiksa.

## Failure modes yang harus dirancang sejak awal

- context panjang mengubur constraint penting;
- summary drift atau salah atribusi pembicara;
- stored prompt injection dipromosikan menjadi instruksi;
- cross-group/private leakage;
- deletion resurrection dari compactor, cache, atau worker lama;
- model mengarang capability atau argumen tool;
- loop mengulangi action yang sama;
- dua worker menjalankan run yang sama;
- capability/policy berubah ketika run sedang pause;
- approval terpakai untuk payload berbeda;
- provider berhasil tetapi respons hilang;
- webhook duplikat atau hilang;
- cancellation dianggap bukti action tidak terjadi;
- flow/version baru merusak run lama;
- Harvy salah addressee, memotong manusia, atau membalas kandidat basi;
- social adaptation berubah menjadi profiling atau imitasi berlebihan;
- evaluator model memuji hasilnya sendiri tanpa bukti.

## Evaluasi dan gerbang rilis

| Area | Metrik/eval | Hard gate |
|---|---|---|
| Context | recall constraint, keputusan, koreksi, unresolved item sebelum/sesudah compact | Tidak kehilangan approval/action state |
| Long context | fakta penting ditempatkan di awal, tengah, akhir | Tidak mengarang bila bukti tidak dibawa |
| Memory | temporal/version accuracy, contradiction, provenance, abstention | Deletion resurrection = 0 |
| Scope | canary unik di private/G1/G2/G3 | Cross-scope leakage = 0 |
| Agent tool | valid tool+args, unknown tool, injection, pagination | Forbidden tool execution = 0 |
| Durable run | crash di setiap boundary, stale lease, duplicate dispatch, resume | Success tanpa receipt = 0 |
| External action | timeout-after-send, webhook loss/duplicate, reconciliation | Blind retry saat `unknown` = 0 |
| Research | citation coverage, groundedness, recency, source diversity | Unsupported factual claim di atas threshold yang disepakati = 0 |
| Grup sosial | addressee, speak/silent, interruption, stale reply, style control | Kebocoran memori pribadi = 0 |
| Manusia | blind rating naturalness, usefulness, control, rasa didengar | Tidak mengoptimalkan engagement |

Trajectory dinilai, tetapi evaluator tidak boleh mengunci satu urutan tool yang
sempurna ketika beberapa jalur sama-sama valid. Outcome nyata—record, source,
receipt, atau pesan yang benar-benar terkirim—lebih penting daripada klaim
agent dalam teks.

## Urutan pembangunan yang disarankan

1. **Baseline selesai 2 Agustus 2026:** instrumentasi estimasi token dan context
   manifest privat+grup ditambahkan tanpa mengubah selection. Usage provider
   aktual kini menghasilkan dataset error/rasio yang dapat dipilah per model dan
   route; estimator adaptif, tokenizer, serta route budget nyata masih pekerjaan
   tahap berikutnya.
2. **Selesai 2 Agustus 2026:** private context compaction v2 terstruktur,
   berversi, berprovenance, tanpa recursive summary, dengan migration/race/
   backlog/suspend/retention/drain test.
3. **Vertical slice selesai 2 Agustus 2026:** loop research sinkron dan executor
   opsional `web.search`/`web.open` dengan capability dinamis, pagar egress,
   isolation context privat, observation tak tepercaya, satu search per run,
   serta validasi asal URL/final. Slice ini dicabut 5 Agustus; native tool
   calling kemudian selesai untuk Agent Runtime internal, sedangkan
   groundedness semantik dan provider/Telegram nyata belum terbukti.
4. **Selesai terbatas, diperkuat 3 Agustus 2026:** matriks otoritas grup,
   shared room memory eksplisit, reset state bersama, membership self/pengirim,
   invalidasi cache+batch sinkron, guard mutasi, dan revalidasi admin/epoch
   sudah ada di core serta tes; room social profile kaya dan WhatsApp nyata
   belum terbukti.
5. **Selesai terbatas, diperkuat 3 Agustus 2026:** `WorkspaceScope`,
   membership/role, permission, canonical namespace, CAS ACL epoch lintas
   service, capability filtering, dan harness freshness berbatas sudah ada
   sebagai fondasi; belum ada surface atau artifact.
6. Bangun PostgreSQL `RunStore`, state machine durable, progress, dan artifact
   report bersitasi untuk tool baca yang sudah ada.
7. **Selesai 6 Agustus 2026 untuk runtime internal:** native/canonical tool
   calling dengan schema executor, normalisasi fail-closed, dan binding
   checkpoint. Pagination, groundedness per klaim, source-diversity eval, serta
   konektor X/Threads tetap belum dibangun.
8. Tambahkan outbox, receipt, reconciler, dan capability gate per connector
   sebelum external write.
9. Uji social adaptation hanya di grup yang setiap pesertanya telah memberi
   izin evaluasi; perbaiki policy secara offline dan berversi.

Setiap tahap harus menghasilkan satu kemampuan pengguna atau bukti yang dapat
dinilai. Infrastruktur yang belum dipakai tidak dihitung sebagai nilai produk.

## Keputusan yang masih diperlukan dari pemilik produk

1. Berapa retensi raw private transcript, episode summary, shared room memory,
   dan room social profile?
2. Apakah satu Workspace dapat memiliki banyak grup, dan siapa yang dapat
   membaca artifact lintas grup?
3. Bagaimana ruang menunjuk pengelola, menyetujui norma kolektif, dan menangani
   konflik pengaturan tanpa mengurangi kendali individual?
4. Apa bentuk UI “Apa yang Harvy pelajari di grup ini?” dan tombol reset-nya?
5. Apakah room social profile kelak boleh belajar formality/panjang reply/emoji,
   dan bagaimana setiap anggota dapat melihat atau menolaknya?
6. Ambang token awal per route/model dan ukuran output reserve berapa?
7. Apakah vertical slice durable memakai state machine Postgres sendiri,
   LangGraph, Temporal, atau kombinasi setelah spike?
8. Siapa pengguna uji grup dan bagaimana consent evaluasi naturalness
   dikumpulkan dengan aman bagi pelajar?

## Sumber primer

### Context, agent, harness, dan eval

- Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Anthropic, [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Anthropic, [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- OpenAI, [A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
- Liu dkk., [Lost in the Middle](https://arxiv.org/abs/2307.03172)

### Codex

- OpenAI, [Codex best practices](https://learn.chatgpt.com/guides/best-practices.md)
- OpenAI, [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
- OpenAI, [Codex `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md)
- OpenAI, [Codex long-running work](https://learn.chatgpt.com/docs/long-running-work.md)
- OpenAI, [Codex memories](https://learn.chatgpt.com/docs/customization/memories.md)
- OpenAI, [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

### Claude Code

- Anthropic, [How Claude remembers a project](https://code.claude.com/docs/en/memory)
- Anthropic, [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- Anthropic, [Context window and compaction](https://code.claude.com/docs/en/context-window)
- Anthropic, [Subagents](https://code.claude.com/docs/en/sub-agents)
- Anthropic, [Hooks](https://code.claude.com/docs/en/hooks)
- Anthropic, [MCP](https://code.claude.com/docs/en/mcp)
- Anthropic, [Permissions](https://code.claude.com/docs/en/permissions)
- Anthropic, [Sessions](https://code.claude.com/docs/en/sessions)
- Anthropic, [Checkpointing](https://code.claude.com/docs/en/checkpointing)

### Graph dan durable execution

- LangChain, [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- LangChain, [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- LangChain, [LangGraph Graph API](https://langchain-ai.github.io/langgraph/how-tos/state-reducers/)
- Temporal, [Temporal documentation](https://docs.temporal.io/)
- Temporal, [AI agent reference architecture](https://go.temporal.io/platform-hub/ai-engineering/ai-reference-architecture)

### Agent loop dan Andrej Karpathy

- Andrej Karpathy, [Software 2.0](https://karpathy.medium.com/software-2-0-a64152b37c35)
- Andrej Karpathy, [Software Is Changing (Again)](https://www.youtube.com/watch?v=LCEmiRjPEtQ)
- Andrej Karpathy, [`autoresearch`](https://github.com/karpathy/autoresearch)
- Andrej Karpathy, [`autoresearch/program.md`](https://raw.githubusercontent.com/karpathy/autoresearch/master/program.md)

### Percakapan grup

- Inoue dkk., [Addressee recognition in multi-party dialogue](https://aclanthology.org/2025.iwsds-1.36/)
- Kummerfeld dkk., [Conversation disentanglement](https://aclanthology.org/P19-1374/)
- Ekstedt dan Skantze, [Turn-taking prediction conditioned on upcoming response](https://aclanthology.org/2023.findings-acl.776/)
- Miehle dkk., [Adapting elaborateness and indirectness](https://aclanthology.org/2022.dnd-13.7/)

## Kapan riset ini dianggap selesai

Riset tidak selesai hanya karena dokumen ini sudah ada. Ia selesai ketika:

1. pemilik produk menerima, menolak, atau mengubah keputusan terbuka;
2. keputusan arsitektur dipindahkan ke satu atau beberapa ADR;
3. rencana implementasi mempunyai vertical slice dan acceptance criteria;
4. `STATUS.md` tetap jujur membedakan rancangan dari kemampuan;
5. temuan yang relevan masuk corpus/eval;
6. dokumen sementara ini tidak lagi menjadi satu-satunya tempat keputusan
   material hidup.

Pada titik itu, dokumen ini dihapus dan penghapusannya dicatat di `LOG.md`.
