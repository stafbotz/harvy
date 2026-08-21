# ADR-042 — Long-Term Memory dan Evidence-Backed Learning

- **Status:** Diterima
- **Tanggal:** 21 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-006, ADR-014, ADR-019, ADR-030, ADR-031, ADR-032

## Konteks

Hot history Harvy dibatasi 32 episode dan embedding dihitung ulang dari corpus
bounded pada query. Batas ini benar untuk RAM/context, tetapi menyamakan hot
retention dengan lifetime retention membuat pengalaman lama hilang dan tidak
menyediakan tempat canonical bagi procedure, failure recovery, outcome, atau
user model yang berkembang. Menaikkan cap JSON tidak menyelesaikan startup,
search, delete race, maupun token growth.

## Keputusan

1. **Hot context, warm knowledge, dan cold evidence dipisahkan.** Compaction
   wajib mengarsipkan episode secara idempoten sebelum hot JSON memangkasnya.
   Cold archive tidak dimuat saat startup atau otomatis masuk prompt; FTS5
   memilih candidate owner-scoped secara lazy.
2. **Local source/evidence memakai adapter SQLite yang dapat diganti.** Schema
   STRICT, WAL, `synchronous=FULL`, foreign-key cascade, dan generation record
   menyimpan archive, outbox, candidate, user model, procedure, error lesson,
   serta derived embeddings. Service/domain menerima port async dan tidak
   bergantung pada SQL di retrieval/promotion policy sehingga adapter masa
   depan dapat memakai PostgreSQL/pgvector/object storage.
3. **Learning bersifat event-driven dan candidate-first.** Runtime hanya
   mempersistenkan event kecil pada boundary task/memory; worker bounded
   mengekstrak candidate di luar jalur balasan. Idempotency key menahan replay,
   status `processing` kembali ke `pending` setelah crash, dan canonical commit
   memeriksa scope generation dalam transaksi yang sama.
4. **Promotion ditentukan kode dari evidence observable.** User assertion dan
   correction menghasilkan temporal user-model fact; inference dibatasi
   confidence dan dapat turun prioritasnya. Procedure dimulai sebagai candidate,
   aktif setelah keberhasilan terverifikasi berulang, degraded setelah failure
   berulang, dan berubah melalui versi baru tanpa overwrite. Error lesson
   memakai fingerprint tool/operation/code/type/message/environment yang sudah
   dinormalisasi dan menjadi aktif setelah recovery terverifikasi.
5. **Derived index tidak menjadi authority.** Document embedding dicache dengan
   scope, source ID, normalized content hash, exact model ID, serta model
   version/config. Query vector tetap ephemeral. Source update/delete
   menginvalidasi projection terkait; model berbeda tidak berbagi vector.
6. **Selective retrieval dan satu context budget tetap berlaku.** Query plan
   dapat memilih archive, user model, procedure, atau error lesson selain
   semantic/graph. Sapaan dan request sederhana melewati seluruh route berat.
   Procedure dipilih dari trigger, scope, environment, health, confidence, dan
   evidence; hanya procedure terpilih yang dirender bounded.
7. **Delete, consent, dan current intent selalu menang.** Consent withdrawal
   menaikkan generation scope secara durable dan memblokir archive/outbox
   lintas restart tanpa menghapus data; `allow` baru membuka generation itu
   setelah consent baru. Forget source menghapus learned
   record/event/candidate yang hanya ditopang source itu. Full delete memblokir
   archive/worker, menaikkan generation, lalu menghapus canonical dan derived
   rows; extractor lama tidak dapat commit. Retrieved preference selalu data
   tidak tepercaya dan tidak pernah mengalahkan instruksi eksplisit saat ini.

## Konsekuensi

Positif:

- lifetime episode dapat tumbuh tanpa membuat startup, fast path, atau context
  tumbuh linear;
- workflow dan recovery yang terbukti menjadi pengalaman reusable dengan
  provenance, health, version, dan scope;
- restart/retry tidak menggandakan canonical learning; dan
- export/delete mencakup hot, cold, learned, serta derived lifecycle.

Trade-off dan batas:

- implementasi ini benar untuk satu node lokal, bukan worker horizontal;
- SQLite lokal belum menyediakan ANN, sehingga cold discovery masih lexical
  FTS dan vector persisten meranking candidate bounded;
- producer runtime awal hanya primary memory yang sudah lolos policy dan
  observable Telegram private AgentRun; group/project/connector/multimodal,
  LLM synthesis, user-acceptance pasca-delivery, dan skill promotion menyusul;
- episode yang sudah hilang sebelum migrasi tidak dapat direkonstruksi; dan
- provider embedding serta kanal live belum diverifikasi pada perubahan ini.

## Bukti

Tes otomatis mencakup archive setelah hot eviction dan restart, owner
isolation, FTS tanpa provider, procedure promotion/degradation/versioning,
error recovery, temporal correction, source cascade, crash retry, delete race,
persistent embedding hit/miss/model invalidation, fast-path skip, satu context
budget, export v4, dan shutdown/runtime regression. Bukti full repository gate
dicatat di `docs/LOG.md` setelah dijalankan.
