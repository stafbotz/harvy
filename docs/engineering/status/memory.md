# Status — Memory dan Data

Verified: 10 Agustus 2026 pada working tree fondasi Phase E/F di atas
`fb3c188`; repository lokal, compiler konteks, lifecycle, retrieval semantik,
dan graph temporal teruji otomatis. Baca untuk memory, history, compaction,
storage, atau kontrol data yang bukan policy safety.

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
  drain shutdown. Maksimal 32 episode disimpan sebagai corpus retrieval;
  context otomatis tetap maksimal 12 episode/3.000 karakter.
- `MemoryQueryPlan` lokal memilih episodic, semantic, dan graph hanya untuk
  permintaan recall/temporal/relasional yang relevan. `MemoryContextCompiler`
  menggabungkan FTS episode, cosine embedding opsional, dan traversal graph
  lewat RRF, lalu menerapkan validity, privacy/suppression, provenance,
  freshness, serta satu budget context bersama. Episode lama tidak dimuat pada
  fast path biasa, bahaya langsung, atau ACK mendesak.
- `MEMORY_EMBEDDING_MODEL` mengaktifkan adapter embeddings kompatibel OpenAI.
  Tanpa konfigurasi itu, FTS, normalisasi temporal, suppression, dan graph
  lokal tetap bekerja; jalur vector tidak dipanggil. Vector dihitung ephemeral
  dan tidak disimpan atau dicatat ke log.
- Lupakan/sunting satu butir melakukan cascade atomik pada semantic/graph dan
  memasang suppression agar episode tidak menghidupkan fakta lama. Lupakan
  semua, tarik persetujuan, dan hapus seluruh data memakai suspension,
  generation/revision checks, serta tombstone-first deletion. Context AgentRun
  lama dibuang sebelum mutasi memory user-facing.
- Ekspor v3 mencakup primary memory, history, serta snapshot semantic/graph
  turunan yang dapat dilihat pengguna; insight keselamatan tetap tersembunyi.
  Sumber Markdown lama direkonsiliasi secara lazy pada read/write berikutnya
  agar koreksi baru dapat melakukan supersession terhadap data pra-Phase E.
- Namespace private, group-member/group-room, dan project dipisahkan secara
  fisik dan divalidasi fail-closed. Runtime consumer Phase E/F saat ini hanya
  Telegram privat; consumer group/project menunggu fase produk berikutnya.

## Batas dan defect aktif

- Adapter file dan CAS hanya menjamin restart lokal satu proses; belum ada
  lease/outbox atau koordinasi multi-instance. Recovery primary tanpa turunan
  terjadi pada read/write memory berikutnya, bukan melalui startup outbox.
- Embedding produksi bersifat opt-in dan belum diuji dengan provider nyata.
  Vector tidak dipersistenkan, sehingga tiap query menghitung batch kembali.
- Repository knowledge dibatasi 8 MiB dan operasi yang tidak lagi muat gagal
  tertutup. Suppression tidak dipotong diam-diam, tetapi akumulasi ekstrem dapat
  memerlukan full owner deletion atau migrasi storage sebelum write berikutnya.
- Parser faktual/graph sengaja sempit dan bukan extractor pengetahuan umum.
  Procedural memory, consumer group/project, dan graph database eksternal belum
  diimplementasikan.
- Dua model masih dapat sama-sama salah menilai isi sensitif sebagai biasa.
  Consent, notice, export, dan forget membatasi dampak, tetapi bukan pengganti
  klasifikasi yang sempurna. Episode juga merupakan ringkasan model; provenance
  membuktikan sumber/coverage, bukan kebenaran klaim.

## Bukti dan pointer

- Kode: `src/core/memory-service.ts`, `src/core/memory-knowledge-service.ts`,
  `src/core/memory-context-compiler.ts`, `src/core/memory-query-plan.ts`,
  `src/core/history-service.ts`, `src/core/history-search.ts`,
  `src/storage/file-memory-knowledge-repository.ts`, dan
  `src/ai/embedding-client.ts`.
- Tes: `tests/memory-service.test.ts`,
  `tests/memory-knowledge-service.test.ts`,
  `tests/memory-context-compiler.test.ts`,
  `tests/file-memory-knowledge-repository.test.ts`,
  `tests/history-search.test.ts`, `tests/history-service.test.ts`, dan
  `tests/data-control-service.test.ts`.
- Gerbang terakhir: `npm test` — 953 test dalam 120 suite, 953 lulus, 0 gagal.
- Keputusan: ADR-006, ADR-014, ADR-030, ADR-031, ADR-032.
