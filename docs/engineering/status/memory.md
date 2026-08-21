# Status — Memory dan Data

Verified: 21 Agustus 2026 pada working tree long-term memory; archive SQLite,
outbox learning, user model, procedural/error memory, persistent embedding
index, compiler konteks, lifecycle, dan kontrol data teruji otomatis. Baca
untuk memory, history, compaction, learning, storage, atau kontrol data yang
bukan policy safety.

## Keadaan saat ini

- MemoryItem yang dapat dilihat dan disunting pengguna tetap berada di Markdown
  per owner. Layer `_knowledge` adalah proyeksi turunan owner-scoped: semantic
  memory, provenance, validity interval, status `active|superseded|uncertain|
  expired`, suppression receipt, entity, dan relation temporal. Graph tidak
  pernah menjadi authority tanpa semantic source.
- Kandidat faktual dikonsolidasikan sesudah respons. Parser lokal hanya
  membentuk slot/graph untuk pola yang didukung; koreksi menutup interval lama,
  kontradiksi tanpa koreksi menjadi `uncertain`, dan nilai yang berulang
  membentuk interval baru. Personal/sensitif tetap memerlukan consent bertoken;
  inferred sensitive tidak disimpan otomatis.
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
  user model, atau reflection.
- `MEMORY_EMBEDDING_MODEL` mengaktifkan adapter embeddings kompatibel OpenAI.
  Document vector kini dicache durable berdasarkan scope, source ID,
  normalized content hash, exact model ID, dan model version/config; query
  vector tetap ephemeral. Update/delete source menginvalidasi projection yang
  terkait, perubahan model tidak mencampur vector, dan tanpa provider FTS,
  temporal, suppression, graph, procedure, serta lessons tetap bekerja.
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
- Ekspor v4 mencakup primary memory, hot history, cold archive, semantic/graph,
  user model, versioned procedures, error lessons, candidates, dan metadata
  outbox tanpa credential atau payload operational tersembunyi. Insight
  keselamatan tetap tersembunyi.
  Sumber Markdown lama direkonsiliasi secara lazy pada read/write berikutnya
  agar koreksi baru dapat melakukan supersession terhadap data pra-Phase E.
- Namespace private, group-member/group-room, dan project dipisahkan secara
  fisik dan divalidasi fail-closed. Runtime consumer Phase E/F saat ini hanya
  Telegram privat; consumer group/project menunggu fase produk berikutnya.

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
- Dua model masih dapat sama-sama salah menilai isi sensitif sebagai biasa.
  Consent, notice, export, dan forget membatasi dampak, tetapi bukan pengganti
  klasifikasi yang sempurna. Episode juga merupakan ringkasan model; provenance
  membuktikan sumber/coverage, bukan kebenaran klaim.

## Bukti dan pointer

- Kode: `src/core/memory-service.ts`, `src/core/memory-knowledge-service.ts`,
  `src/core/memory-context-compiler.ts`, `src/core/memory-query-plan.ts`,
  `src/core/history-service.ts`, `src/core/history-search.ts`,
  `src/core/long-term-memory-service.ts`,
  `src/storage/sqlite-long-term-memory-repository.ts`,
  `src/storage/file-memory-knowledge-repository.ts`, dan
  `src/ai/embedding-client.ts`.
- Tes: `tests/memory-service.test.ts`,
  `tests/memory-knowledge-service.test.ts`,
  `tests/memory-context-compiler.test.ts`,
  `tests/file-memory-knowledge-repository.test.ts`,
  `tests/history-search.test.ts`, `tests/history-service.test.ts`, dan
  `tests/data-control-service.test.ts`, `tests/long-term-memory.test.ts`, dan
  `tests/persistent-embedding-index.test.ts`.
- Gerbang terakhir: tes terarah memory/runtime 189 test lulus; `npm run check`
  PASS; `npm test` PASS, 1.461/1.461 test dalam 190 suite; `npm run
  context:check` PASS; dan `git diff --check` PASS selain peringatan line-ending
  Windows.
- Keputusan: ADR-006, ADR-014, ADR-030, ADR-031, ADR-032, ADR-042.
