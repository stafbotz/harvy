# ADR-032 — Graph Temporal Turunan

- **Status:** Diterima
- **Tanggal:** 10 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-012, ADR-016, ADR-027, ADR-031

## Konteks

Beberapa pertanyaan memerlukan hubungan dan waktu—misalnya sekolah pada tanggal
tertentu atau relasi beberapa entitas—yang tidak cukup dijawab oleh similarity
teks. Namun graph yang dipasang sebagai sumber kebenaran baru akan sulit
dihapus, mudah mencampur scope, dan dapat mengubah hasil ekstraksi model menjadi
fakta tanpa provenance. Phase F karena itu membutuhkan graph yang sepenuhnya
derived dari semantic source dan tetap tunduk pada lifecycle yang sama.

## Keputusan

1. **Setiap entity/relation berasal dari semantic memory.** Relation membawa
   owner/scope, validity, confidence, sensitivity, status, semantic source ID,
   source MemoryItem/episode/sequence, dan tidak boleh bertahan tanpa source
   tersebut. Graph-only evidence ditolak oleh repository dan AgentRun codec.
2. **Projection deterministic dan terbatas pada fakta durable yang didukung.**
   Parser lokal membentuk entity-valued atau scalar projection untuk pola
   sempit seperti sekolah, guru, kelas, jurusan, preferensi, dan waktu belajar.
   Chatter, hidden safety insight, dan inferensi relasional bebas tidak masuk
   graph. Edit menjalankan derivation ulang; bila projection tidak dapat
   dibentuk aman, edge lama tidak dipertahankan.
3. **Interval, bukan label current, menentukan visibility pada waktu query.**
   Correction menutup relation lama pada `validUntil`, future correction tidak
   menghilangkan relation yang masih berlaku hari ini, dan A→B→A membentuk
   interval terpisah. Historical tanpa tanggal dapat membaca sejarah sampai
   sekarang; as-of tidak boleh melihat future evidence.
4. **Graph adalah salah satu route hybrid.** Ia dipakai hanya untuk query
   relasional/temporal, traversal bounded mengikuti depth plan, lalu hasilnya
   masuk fusion FTS + vector + graph. Canonical identity menyatukan graph dan
   semantic dari record yang sama tetapi tidak menyatukan dua validity interval
   yang kebetulan mempunyai display text sama.
5. **Namespace dipisahkan secara fisik.** Private owner, group member/room, dan
   workspace+project mempunyai namespace/hash/path berbeda; nested owner dan
   seluruh provenance harus cocok dengan namespace. Saat ini hanya private
   runtime yang menjadi consumer. Bentuk group/project disediakan agar Phase G
   tidak perlu mencampur data ketika consumer baru dipasang.
6. **Mutasi source membangun ulang graph dalam CAS yang sama.** Forget/edit,
   expiry, episode-source removal, consent suspension, dan full owner deletion
   tidak meninggalkan edge yatim. Repository memproyeksikan ulang entity dan
   relation yang diharapkan dari semantic source saat validasi, sehingga file
   dengan target/relation/provenance yang ditukar ditolak.
7. **Tidak memasang graph database eksternal.** Bounded file projection cukup
   untuk corpus privat saat ini dan menjaga delete/export/restart dalam satu
   lifecycle. Neo4j/Graphiti atau multi-instance graph store memerlukan ADR,
   migrasi, consent/deletion design, dan evaluasi baru.

## Konsekuensi

Graph dapat menjawab current/history dan traversal multi-hop dengan provenance
tanpa menjadi authority terpisah. Deletion/revocation dapat menghapus atau
menghitung ulang seluruh entity/edge dari source yang tersisa, dan corruption
storage gagal tertutup.

Trade-off-nya: coverage graph mengikuti parser lokal yang sempit; query umum
tetap mengandalkan semantic/episodic evidence. Runtime group/project, procedural
memory, graph provider eksternal, dan koordinasi multi-instance belum ada.

## Bukti

Tes otomatis mengunci projection scalar/entity, temporal correction dan
recurrence, current/as-of/future visibility, depth traversal, owner/scope
isolation, source cascade, graph rebuild, atomic edit lintas restart, orphan
`.tmp` deletion, dan rejection atas graph tanpa/mismatched provenance. Gerbang
10 Agustus 2026 menjalankan 953 test dalam 120 suite: seluruhnya lulus. Tidak
ada uji provider graph atau kanal live karena keduanya tidak digunakan.
