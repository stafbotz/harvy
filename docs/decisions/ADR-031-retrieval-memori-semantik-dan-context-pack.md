# ADR-031 — Retrieval Memori Semantik dan Context Pack

- **Status:** Diterima
- **Tanggal:** 10 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-006, ADR-014, ADR-019, ADR-022, ADR-030, ADR-032

## Konteks

ADR-030 memisahkan retensi episode dari attention context dan menyediakan FTS
lokal, tetapi sengaja belum mengirim hasilnya ke prompt. Consumer yang aman
harus dapat memilih sumber secara on-demand, membedakan keadaan sekarang dari
sejarah, mencegah `forget one` muncul kembali melalui episode, dan tidak
mengubah memori menjadi instruksi sistem. Sinonim juga memerlukan retrieval
semantik nyata, bukan skor keyword yang diberi nama embedding.

Primary MemoryItem Markdown tetap diperlukan untuk kontrol pengguna. Ia tidak
cukup untuk contradiction, provenance, atau valid-time, dan data lama yang
sudah ada tidak boleh menjadi current hanya karena belum pernah diproyeksikan.

## Keputusan

1. **Semantic memory adalah proyeksi turunan, bukan pengganti primary memory.**
   Record membawa owner/scope, subject-predicate-value, display text,
   confidence, sensitivity, status, validity interval, source MemoryItem,
   episode, dan sequence. Sumber Markdown lama direkonsiliasi secara lazy pada
   read/write berikutnya. Semantic/graph ikut ekspor dan dapat dibangun ulang;
   insight keselamatan tidak pernah menjadi corpus.
2. **Capture, consolidation, dan retrieval dipisahkan.** Bot menyimpan kandidat
   yang sudah melewati policy, lalu derivation berjalan sesudah respons.
   Consolidator menggabungkan nilai sama, menandai slot eksklusif yang
   berkontradiksi sebagai `uncertain`, dan hanya correction eksplisit yang
   menutup lawan serta membuka interval baru. Parser lokal sengaja sempit;
   inferred personal/sensitive tidak dipersistenkan otomatis.
3. **`MemoryQueryPlan` code-owned menentukan retrieval.** Recall/sejarah dapat
   memakai episode, pertanyaan semantik memakai vector, dan relasi/waktu dapat
   memakai graph. Tanggal eksplisit menjadi query historical. Jam lokal, ACK,
   pending sempit, identity, immediate danger, dan urgent boundary tidak
   memanggil provider retrieval. Teks/model tidak dapat memperluas owner,
   namespace, capability, atau limit melalui plan.
4. **`MemoryContextCompiler` menghasilkan Context Pack bounded.** Ia
   menggabungkan FTS, vector, dan graph melalui reciprocal-rank fusion,
   membedakan interval temporal, menyediakan slot bagi evidence hasil query,
   serta menerapkan validity, privacy/suppression, owner, dan freshness filter
   sebelum hasil masuk prompt. Summary episode otomatis juga difilter dengan
   aturan yang sama. Seluruh evidence dirender sebagai data tidak tepercaya;
   manifest/log hanya membawa route dan counter, bukan isi.
5. **Embedding benar-benar provider vector dan bersifat opt-in.** Runtime hanya
   membuat adapter kompatibel OpenAI ketika `MEMORY_EMBEDDING_MODEL` terisi;
   model chat tidak pernah ditebak sebagai embedding model. Batch, panjang
   input, deadline, response size/dimension, dan cosine score divalidasi.
   Vector dan payload provider tidak disimpan atau dicatat. Untuk OpenRouter,
   request meminta `provider.data_collection=deny`. Kontrak endpoint diverifikasi
   terhadap dokumentasi resmi [Google OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
   dan [OpenRouter embeddings](https://openrouter.ai/docs/api/reference/embeddings).
6. **Lifecycle sumber selalu menang atas turunan.** Forget memasang suppression
   berprovenance dan menghapus evidence source; edit menghapus nilai lama dan
   menulis replacement dalam satu CAS mutation; full delete memblokir history
   dan memory sejak awal. Retrieval yang menunggu provider memeriksa revision
   lagi sebelum mengembalikan hasil. Tombstone tidak dipotong dengan item cap
   yang dapat menghidupkan klaim, dan state yang melewati 8 MiB gagal tertutup.
7. **Satu budget context berlaku untuk primary dan retrieved evidence.** Item
   query tidak boleh selalu kalah oleh profile ambient. Context snapshot
   AgentRun menyimpan provenance terstruktur, menolak graph-only evidence, dan
   dibuang sebelum edit/forget memory user-facing.

## Konsekuensi

Positif:

- episode lama relevan dapat mengalahkan episode baru yang tidak relevan tanpa
  mengirim seluruh arsip;
- correction, contradiction, recurrence, current, dan as-of mempunyai bentuk
  temporal yang eksplisit;
- consent withdrawal, forget, edit, dan delete menutup semua route retrieval;
  dan
- manifest observability tetap content-free.

Trade-off dan batas:

- adapter file/CAS hanya aman untuk satu proses dan lazy reconciliation bukan
  durable startup outbox;
- tanpa `MEMORY_EMBEDDING_MODEL`, vector route tidak tersedia walau FTS,
  temporal filtering, suppression, dan graph lokal tetap tersedia;
- embedding dihitung ulang setiap query dan belum diuji terhadap provider
  nyata; dan
- procedural memory serta consumer group/project bukan bagian keputusan ini.

## Bukti

Tes otomatis mengunci semantic cosine threshold, synonym episode tanpa state
knowledge, document-pool fairness, query planning temporal, RRF/provenance,
supersession/recurrence, correction atomik lintas restart, deletion races,
suppression reassertion, primary legacy reconciliation, shared context budget,
dan prompt escaping. Gerbang 10 Agustus 2026 menjalankan 953 test dalam 120
suite: seluruhnya lulus. Provider nyata dan kanal live tidak dijalankan.
