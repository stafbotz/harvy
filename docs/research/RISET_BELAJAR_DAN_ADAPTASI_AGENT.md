# Riset Mendalam: Mekanisme Belajar & Adaptasi AI Agent (Continuous Agent Learning & Adaptation)

- **Status:** Riset Mendalam & Rekomendasi Fitur
- **Tanggal:** 6 Agustus 2026
- **Lokasi:** `docs/research/RISET_BELAJAR_DAN_ADAPTASI_AGENT.md`
- **Subjek:** Analisis Teknik **Continuous Learning, Episodic Memory, Self-Reflection (Reflexion/ExpeL), MemGPT Hierarchical Memory, dan Adaptasi Berkesinambungan** untuk Harvy dengan Pagar Batas Konstitusi.

---

## Ringkasan Eksekutif

Dalam pengembangan AI Agent modern, **kemampuan belajar dan beradaptasi (continual learning & adaptation)** tidak lagi dilakukan dengan *fine-tuning* bobot model dasar secara langsung—karena proses tersebut mahal, lambat, dan berisiko *catastrophic forgetting* serta kebocoran data.

Sebaliknya, agentic adaptation dilakukan melalui **Verbal Reinforcement Learning**, **Self-Editing Hierarchical Memory**, **Skill Synthesis**, dan **Dynamic Context Modulation**. Bagi Harvy, mekanisme ini memungkinkan agen semakin relevan dan personal bagi pengguna tanpa merusak konstitusi, privasi, atau batas moral.

---

## 1. Empat Pilar Utama Mekanisme Belajar Agent

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                    EXPLICIT USER INTERACTIONS                    │
  └────────────────────────────────┬─────────────────────────────────┘
                                   │
                                   ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │                    HARNESS EVALUATION LOOP                       │
  └──────┬─────────────────────────┬──────────────────────────┬──────┘
         │                         │                          │
         ▼                         ▼                          ▼
┌──────────────────┐    ┌────────────────────┐     ┌─────────────────────┐
│  SELF-REFLECTION │    │  HIERARCHICAL MEM  │     │   SKILL SYNTHESIS   │
│ (Reflexion/ExpeL)│    │(Core/Recall/Arch)  │     │  (Reusable Templates│
└────────┬─────────┘    └──────────┬─────────┘     └──────────┬──────────┘
         │                         │                          │
         └─────────────────────────┼──────────────────────────┘
                                   │ Context Compilation
                                   ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │               DYNAMIC PROMPT MODULATION & ADAPTATION             │
  └──────────────────────────────────────────────────────────────────┘
```

### A. Self-Reflection & Verbal Reinforcement Learning (Reflexion & ExpeL)
- **Konsep:** Agen mengevaluasi hasil aksinya sendiri (*success/failure critique*). Jika suatu alur gagal atau mendapat koreksi pengguna, agen menghasilkan *verbal insight* dalam bahasa alami.
- **Mekanisme:**
  - *Reflexion:* "Ketika pengguna meminta bantuan belajar matematika, jangan langsung berikan jawaban akhir, tetapi berikan petunjuk langkah pertama dulu."
  - *Insight Bank (ExpeL):* Pengetahuan dari refleksi disimpan dalam storan terstruktur. Saat kasus serupa muncul di masa depan, refleksi ini ditarik ke dalam prompt (*in-context wisdom transfer*).

### B. Hierarchical Self-Editing Memory (Pola MemGPT / Letta)
Membagi memori menjadi 3 tingkat terstruktur agar agen dapat hidup lama (*long-lived agent*) dan memperbarui pengetahuannya secara mandiri:
1. **Core Memory (RAM / Active Working Memory):**
   - Terdiri dari *Memory Blocks* yang selalu terlihat oleh LLM (misal: `user_profile`, `learning_style`, `persona_rules`).
   - Agen dapat mengeksekusi tool bawaan (`update_core_memory`) untuk memperbarui blok ini secara mandiri ketika pengguna menyatakan preferensi baru.
2. **Recall Memory (Searchable History / RAG):**
   - Basis data pencarian semantik untuk kejadian atau percakapan lampau yang sudah keluar dari *context window*.
3. **Archival Memory (Knowledge Repository):**
   - Catatan pelajaran, dokumen, atau tugas lama yang ditarik hanya jika relevan dengan topik saat ini.

### C. Dynamic Context & Style Modulation (Adaptasi Gaya Bicara)
- Agen menyesuaikan gaya komunikasi berdasarkan preferensi yang terverifikasi (misal: *mode pendengar "Dengerin dulu"* vs *mode aksi "Langsung saran"*, penggunaan analogi sederhana untuk topik rumit, atau ritme pengingat).
- *System Prompt* secara dinamis menyusun parameter kepribadian berdasarkan memori preferensi aktif di Core Memory.

### D. Skill Synthesis & Discovery (Pola Voyager)
- Untuk tugas berulang (seperti membuat *study plan* mingguan atau merangkum materi ujian), agen dapat mengekstrak urutan instruksi yang berhasil menjadi **Skill Template**.
- Skill Template ini disimpan dalam *Skill Library* terindeks yang dapat dipanggil kembali kapan pun tugas serupa diminta.

---

## 2. Tantangan & Masalah dalam Adaptasi Agent (serta Solusinya)

| Masalah Utama | Risiko | Solusi Rekayasa |
|---|---|---|
| **Echo Gap & Error Propagation** | Agen mengulang kesalahan yang dipercayai benar akibat evaluasi yang salah. | Verifikasi *rule-based* / guardrails deterministik sebelum memvalidasi memori baru. |
| **Context Rot & Token Bloat** | Menumpuk semua riwayat/refleksi membuat prompt terlalu panjang & lambat. | Pemadatan episodik (*Structured Episodic Compaction*) & seleksi *Top-K Retrieval*. |
| **Hallucinated Preferences** | Agen menyimpulkan preferensi palsu yang tidak pernah dinyatakan pengguna. | Memulai dari konfirmasi eksplisit atau ambang batas keyakinan (*confidence threshold*) yang tinggi. |

---

## 3. Penerapan Spesifik & Pagar Batas Konstitusional untuk Harvy

Mekanisme belajar Harvy wajib tunduk pada **Konstitusi Harvy (`CONSTITUTION.md`)** dan **Invarian Keamanan (`INVARIANTS.md`)**:

### 1. Prinsip Utama: "Harvy Membantu, Tetapi Tidak Mengambil Alih"
- Pembelajaran Harvy bertujuan untuk meningkatkan **kemandirian dan agensi pengguna**, bukan untuk membuat pengguna bergantung secara emosional atau kognitif pada Harvy.

### 2. Scoped Isolation (Pemisahan Ruang Strict)
- Memori dan preferensi yang dipelajari Harvy **terisolasi ketat** per pengguna dan per grup (`AgentScope`).
- Pembelajaran di Grup WhatsApp A tidak boleh memengaruhi atau membocorkan data ke Grup B atau percakapan pribadi Telegram.

### 3. Hak Koreksi & Transparansi Pengguna (Data Control Center)
- Pengguna memiliki hak penuh untuk melihat apa saja yang telah dipelajari Harvy tentang dirinya (*View Learned Memories*).
- Pengguna berhak mengedit, mengoreksi, atau menghapus memori tersebut kapan saja (*Right to Edit/Delete*).

### 4. Direct Confirmation untuk Mutasi Memori Shared
- Untuk grup atau memori bersama (*shared room memory*), usulan memori baru dari hasil belajar wajib melalui alur:  
  `Proposal oleh Harvy` $\rightarrow$ `Pratinjau` $\rightarrow$ `Persetujuan Eksplisit Admin/Pengguna`.

---

## 4. Rencana Langkah Implementasi (Roadmap Adapting Harvy)

1. **Fase 1 — Core Memory Blocks (`user_profile` & `gaya_menemani`):**
   - Menyediakan blok memori terstruktur dalam `AgentScope` privat untuk menyimpan preferensi pengguna secara aman.
2. **Fase 2 — Self-Reflection & Episodic Insight Extraction:**
   - Memanfaatkan *Structured Episodic Compaction v2* (`ADR-014`) untuk mengekstrak rangkuman pembelajaran di latar belakang setelah sesi selesai.
3. **Fase 3 — Control Center & Human Verification UI:**
   - Menyediakan antarmuka bagi pengguna untuk meninjau, mengedit, atau menghapus memori preferensi yang dipelajari Harvy.
