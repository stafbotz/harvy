# Status — Memory dan Data

Verified: 22 Agustus 2026 pada working tree long-term memory, explicit remember,
acknowledgement kontekstual, dan UX `/memori`;
archive SQLite, outbox learning, user model, procedural/error memory,
persistent embedding index, compiler konteks, lifecycle, kontrol data, serta
renderer Telegram teruji otomatis. Baca untuk memory, history, compaction,
learning, storage, atau kontrol data yang bukan policy safety.

## Keadaan saat ini

- MemoryItem yang dapat dikendalikan pengguna tetap berada di Markdown per
  owner. `/memori`, pertanyaan natural, dan Data & izin kini memakai satu
  renderer potret naratif, bukan daftar `content — kind`. Potret disintesis
  ulang dari context pack bounded dan tidak menjadi source memory baru.
  Tombol tunggal `Ubah` hanya mengembalikan pengguna ke percakapan bebas;
  scoped forget memakai topik natural, sedangkan hapus semua ingatan tetap
  bertoken dan terpisah di Data & izin. Layer `_knowledge` adalah proyeksi
  turunan owner-scoped: semantic
  memory, provenance, validity interval, status `active|superseded|uncertain|
  expired`, suppression receipt, entity, dan relation temporal. Graph tidak
  pernah menjadi authority tanpa semantic source.
- Kandidat faktual melewati policy dan primary commit sebelum acknowledgement
  balasan disusun. Receipt code-owned membedakan `saved`, `updated`, dan
  `already-known`; model hanya memilih bahasa percakapannya dan kata/emoji tidak
  pernah menjadi bukti write. Acknowledgement menyatu dengan jawaban utama,
  mengikuti konteks, dan tidak menjadi notifikasi record kedua. `📍` opsional
  hanya untuk save/update, sedangkan `💭` opsional hanya untuk recall; beberapa
  write tidak dicetak sebagai rentetan log. Parser lokal hanya membentuk
  slot/graph untuk pola yang didukung; koreksi menutup interval lama,
  kontradiksi tanpa koreksi menjadi `uncertain`, dan nilai yang berulang
  membentuk interval baru. Personal/sensitif yang hanya diceritakan tetap
  memerlukan consent bertoken dan inferred sensitive tidak disimpan otomatis.
  Jika user turn secara eksplisit memerintahkan Harvy mengingat satu item,
  kombinasi `memoryAction: "remember"` dan `SemanticOperation` exact tervalidasi;
  code mengikat evidence+target ke raw turn dan memberi consent hanya kepada
  candidate yang cocok. Item itu langsung masuk primary
  memory beserta derivation normal tanpa prompt izin kedua. Negasi, retrieval,
  reminder, signal tanpa candidate match, serta fakta lain dalam turn yang sama
  tidak memperoleh authority. Credential ditolak di adapter dan service.
- Riwayat mentah terbaru dibatasi 24 giliran. Awalan kontigu dipadatkan menjadi
  episode terstruktur dengan source sequence/hash, CAS, generation guard, dan
  drain shutdown. Episode ditulis idempoten ke cold SQLite archive sebelum hot
  JSON boleh memangkasnya ke 32; archive owner-scoped bertahan restart dan
  dicari lazy lewat FTS5. Context otomatis tetap maksimal 12 episode/3.000
  karakter dan archive tidak dimuat saat startup atau sapaan sederhana.
- `MemoryQueryPlan` lokal memilih episodic, semantic, graph, personalization,
  procedure, dan error lesson hanya bila query relevan. Compiler menggabungkan
  FTS hot+cold episode, cosine embedding opsional, graph, user model, procedure,
  dan lesson lewat RRF, lalu menerapkan validity, privacy/suppression,
  provenance, health, serta satu budget context bersama. Sapaan/perhitungan
  biasa tidak memanggil archive, embedding, graph berat, procedure, lesson,
  user model, atau reflection. Semantic memory/history recall dapat mengaktifkan
  route lintas bahasa; pattern lexical lama tetap fallback/ranking, bukan satu-
  satunya parser makna.
- Potret `/memori` adalah satu-satunya jalur UI yang sengaja membayar synthesis
  khusus. Query potret memilih primary, episode relevan, semantic, graph, dan
  user model dalam budget compiler 8 item/3.000 karakter; procedure dan error
  lesson tidak dimuat. Prompt synthesis menerima maksimal 16 primary, 12
  evidence, dan 1.800 karakter shared experience, menyatakan status uncertain
  secara manusiawi, serta menolak output berupa daftar atau metadata internal.
  Sapaan dan giliran biasa tidak menjalankan synthesis ini.
- `MEMORY_EMBEDDING_MODEL` mengaktifkan adapter embeddings kompatibel OpenAI.
  Document vector kini dicache durable berdasarkan scope, source ID,
  normalized content hash, exact model ID, dan model version/config; query
  vector tetap ephemeral. Respons provider embedding dibaca streaming dengan
  hard cap 32 MiB sebelum decode/JSON, dan status gagal, UTF-8 rusak, payload
  oversized, atau vector invalid gagal tertutup tanpa menonaktifkan fallback
  lexical. Update/delete source menginvalidasi projection yang terkait,
  perubahan model tidak mencampur vector, dan tanpa provider FTS, temporal,
  suppression, graph, procedure, serta lessons tetap bekerja.
- `_long-term` SQLite memisahkan canonical user-model fact, versioned procedure,
  error lesson, candidate, observable evidence reference, durable learning
  event, dan derived embedding. Event didedupe dengan idempotency key, diretry
  setelah crash, dan dipromosikan deterministic: dua keberhasilan terverifikasi
  mengaktifkan procedure, dua failure terbaru mendegradasikannya, correction
  men-supersede fact, serta recovery terverifikasi mengaktifkan error lesson.
  Agent run tidak menyimpan chain-of-thought; hanya capability/status/hash dan
  reference evidence bounded.
- Lupakan/sunting satu butir melakukan cascade pada semantic/graph, user model,
  source-only procedure/candidate/event, dan embedding, serta memasang
  suppression agar cold archive tidak menghidupkan fakta lama. Full delete
  menghapus archive, outbox, learned records, dan seluruh projection dalam
  generation fence; completion extractor lama gagal commit. Penarikan consent
  juga dipersistenkan sebagai blocked scope + generation baru sehingga pending
  learning tidak berjalan lagi setelah restart sampai consent diberikan ulang.
- Acknowledgement ordinary/explicit memory menyatu dengan balasan utama. Jika
  reply sudah mengatakan ingat/simpan/catat/perbarui, tidak ada note kedua;
  fallback tidak mencetak content/kind dan beberapa write menjadi satu kalimat.
  `📍` bersifat opsional untuk write/update terkonfirmasi, `💭` opsional hanya
  untuk recall lama, dan balasan tanpa emoji tetap sah. Tidak ada tombol
  `Lupakan itu` per item.
  Pengguna tetap dapat meminta secara natural agar yang tadi atau topik X
  dilupakan, atau memakai kontrol Data & izin. Mutasi scoped forget memerlukan
  `SemanticOperation` explicit dengan evidence dari raw turn sebelum matcher
  lexical owner-local boleh meranking source; model tidak diberi kuasa
  menghapus hanya dari klasifikasinya. Forget-all tetap masuk confirmation.
- Ekspor v4 mencakup primary memory, hot history, cold archive, semantic/graph,
  user model, versioned procedures, error lessons, candidates, dan metadata
  outbox tanpa credential atau payload operational tersembunyi. Insight
  keselamatan tetap tersembunyi.
  Sumber Markdown lama direkonsiliasi secara lazy pada read/write berikutnya
  agar koreksi baru dapat melakukan supersession terhadap data pra-Phase E.
- Namespace private, group-member/group-room, dan project dipisahkan secara
  fisik dan divalidasi fail-closed. Runtime long-term semantic/learning Phase
  E/F kini dapat menyusun recent/retrieved context untuk Telegram dan WhatsApp
  privat dengan owner scope terpisah. Adapter WhatsApp menyediakan lihat/hapus
  memori lewat perintah teks, tetapi extraction/confirmation memori baru dan
  seluruh surface kontrol Telegram belum ported. Group member memory tetap
  memakai service terpisah yang mengikat explicit remember pada
  anggota+turn+grup, sedangkan shared room dan project memory tetap memakai
  authority masing-masing dan tidak mewarisi consent itu.

## Batas dan defect aktif

- SQLite long-term memakai WAL+synchronous FULL dan benar untuk satu node lokal;
  belum ada distributed lease/worker, PostgreSQL/pgvector, object store, atau
  klaim horizontal-safe. Outbox restart-durable tetapi hanya satu worker lokal.
- Embedding produksi tetap opt-in dan belum diuji dengan provider nyata. Local
  SQLite belum mempunyai ANN/vector extension: persistent vector menghindari
  re-embedding dan meranking candidate semantic bounded, sedangkan discovery
  cold archive tetap berawal dari lexical FTS.
- Repository knowledge dibatasi 8 MiB dan operasi yang tidak lagi muat gagal
  tertutup. Suppression tidak dipotong diam-diam, tetapi akumulasi ekstrem dapat
  memerlukan full owner deletion atau migrasi storage sebelum write berikutnya.
- Extractor learning runtime saat ini deterministic dan konservatif: user model
  berasal dari primary memory yang sudah lolos policy, sedangkan procedure dari
  observable Telegram private AgentRun. Synthesis workflow kompleks, explicit
  user acceptance pasca-delivery, runtime group/project, skill promotion, dan
  connector/multimodal producer belum dirangkai. Namespace/data model sudah
  generic, tetapi mapping authority lintas channel tidak ditebak.
- Potret menerima status dan validity dari Context Pack, tetapi bentuk evidence
  terpilih saat ini tidak membawa nilai confidence dan stability user-model
  secara terpisah. Target forget topikal juga hanya dapat menghapus primary
  source yang cocok secara lexical/alias; detail episode-only tanpa primary
  source memerlukan permintaan yang lebih spesifik atau hapus semua ingatan.
- Pada cerita implicit, dua model masih dapat sama-sama salah menilai isi
  sensitif sebagai biasa. Consent, notice, export, dan forget membatasi dampak,
  tetapi bukan pengganti klasifikasi yang sempurna. Guard explicit remember
  juga sengaja konservatif setelah evidence semantik: parafrasa candidate yang
  tidak dapat dicocokkan gagal tertutup tanpa write, bukan menebak izin.
  Episode merupakan ringkasan model; provenance membuktikan source/coverage,
  bukan kebenaran klaim.

## Bukti dan pointer

- Kode: `src/core/memory-service.ts`, `src/core/memory-knowledge-service.ts`,
  `src/core/memory-explicit-consent.ts`,
  `src/core/memory-context-compiler.ts`, `src/core/memory-query-plan.ts`,
  `src/core/history-service.ts`, `src/core/history-search.ts`,
  `src/core/long-term-memory-service.ts`,
  `src/core/memory-natural-control.ts`, `src/ai/memory-portrait.ts`,
  `src/bot/create-bot.ts`, `src/core/group-memory-service.ts`,
  `src/core/group-turn-service.ts`,
  `src/storage/sqlite-long-term-memory-repository.ts`,
  `src/storage/file-memory-knowledge-repository.ts`, dan
  `src/ai/embedding-client.ts`.
- Tes: `tests/memory-service.test.ts`,
  `tests/memory-explicit-consent.test.ts`,
  `tests/memory-knowledge-service.test.ts`,
  `tests/memory-context-compiler.test.ts`,
  `tests/file-memory-knowledge-repository.test.ts`,
  `tests/history-search.test.ts`, `tests/history-service.test.ts`, dan
  `tests/data-control-service.test.ts`, `tests/long-term-memory.test.ts`, dan
  `tests/persistent-embedding-index.test.ts`, `tests/memory-portrait.test.ts`,
  `tests/memory-natural-control.test.ts`, `tests/group-memory-service.test.ts`,
  `tests/group-turn-service.test.ts`, `tests/project-memory-service.test.ts`,
  `tests/memory-query-plan.test.ts`, dan `tests/create-bot-flow.test.ts`.
  Boundary provider embedding juga dikunci oleh
  `tests/embedding-client.test.ts`.
- Gerbang terakhir 22 Agustus 2026: suite terarah perubahan 339/339 dan recheck
  hardening final 52/52 lulus; `npm run check` PASS; `npm test` PASS,
  1.663/1.663 test dalam 208 suite; `npm run context:check` PASS; dan
  `git diff --check` PASS selain peringatan line-ending Windows.
- Keputusan: ADR-006, ADR-014, ADR-030, ADR-031, ADR-032, ADR-042, ADR-043,
  ADR-044.
