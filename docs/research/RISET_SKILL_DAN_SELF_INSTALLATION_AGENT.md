# Riset Mendalam: Pembuatan & Pemasangan Skill Mandiri oleh AI Agent (Dynamic Agent Skill Synthesis & Self-Installation)

- **Status:** Riset Mendalam & Rekomendasi Fitur
- **Tanggal:** 6 Agustus 2026
- **Lokasi:** `docs/research/RISET_SKILL_DAN_SELF_INSTALLATION_AGENT.md`
- **Subjek:** Analisis Teknik **Dynamic Skill Synthesis, Self-Installation, Voyager Skill Library Paradigm, dan Pagar Batas Keamanan (Sandboxing & Human Approval)**.

---

## Ringkasan Eksekutif

Pertanyaan mendasar: **Apakah AI Agent bisa diinstruksikan untuk membuat dan memasang skill-nya sendiri secara mandiri?**

**Jawaban: SANGAT BISA, dan ini merupakan salah satu terobosan paling aktif dalam rekayasa AI Agent (2024–2026).**

Kemampuan agen untuk sintetis dan memasang skill sendiri menggeser paradigma dari *Static Tool Use* (agen hanya memakai alat yang dipasang developer) menjadi *Dynamic Skill Synthesis* (agen menciptakan, memverifikasi, menyimpan, dan memasang alat baru secara otonom di runtime).

---

## 1. Alur Kerja Pembuatan & Pemasangan Skill Mandiri (Step-by-Step Architecture)

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                      1. GAP DETECTION & GOAL                             │
 │  (Agen menyadari belum memiliki tool/kemampuan untuk menyelesaikan tugas)│
 └────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                     2. SKILL SYNTHESIS (LLM CODE/PROMPT)                 │
 │      (Agen menulis skrip/instruksi/schema fungsi baru, contoh: SKILL.md) │
 └────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                   3. SANDBOX TEST & VERIFICATION                         │
 │   (Agen menguji skill di Virtual Sandbox; jika error ──> Self-Debug)     │
 └────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │               4. GUARDIAN / HUMAN-IN-THE-LOOP APPROVAL                   │
 │   (Persetujuan pengguna/admin sebelum skill didaftarkan ke sistem)       │
 └────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                5. SKILL REGISTRATION & REUSABLE INDEXING                 │
 │     (Skill disimpan di Skill Library & diindeks via Vector/Registry)     │
 └──────────────────────────────────────────────────────────────────────────┘
```

### Langkah 1: Gap Detection (Deteksi Kebutuhan)
Agen menerima permintaan pengguna. Setelah memeriksa *Capability Catalog*, agen mendeteksi bahwa belum ada alat yang cocok.

### Langkah 2: Skill Code Synthesis (Sintesis Kode / Instruksi Skill)
Agen menulis definisi skill baru. Bentuk skill bisa berupa:
- **Prompt/Instructional Skill:** Berkas markdown instruksi (seperti format `SKILL.md`).
- **Code-Based Tool:** Fungsi Python/TypeScript yang memiliki deskripsi JSON Schema.
- **MCP Server Configuration:** Konfigurasi konektor data/API eksternal.

### Langkah 3: Sandbox Testing & Self-Debugging (Verifikasi Sandboxing)
Sebelum skill baru aktif, agen menjalankannya di dalam **Virtual Sandbox** (seperti Docker, WASM, E2B, atau In-Memory Isolated Runner):
- Jika eksekusi sukses $\rightarrow$ Lanjut ke verifikasi persetujuan.
- Jika terjadi galat (*error traceback*) $\rightarrow$ Agen membaca log error, memperbaiki kodenya sendiri (*self-correction*), dan menguji ulang (ReAct Loop).

### Langkah 4: Human-in-the-Loop & Deterministic Approval (Persetujuan Keamanan)
Untuk mencegah *Malicious Code Execution (RCE)* atau pembuatan tool yang merusak, sistem *Harness* menahan pendaftaran skill hingga mendapat persetujuan pengguna/admin (*Human-in-the-Loop Approval*).

### Langkah 5: Registration & Vector Indexing (Pemasangan & Penyimpanan)
Setelah disetujui, skill baru disimpan di folder `skills/` atau `Skill Registry` dan diindeks. Pada tugas-tugas berikutnya, agen dapat melakukan pencarian semantik (*RAG over skills*) untuk memuat dan menggunakan skill tersebut.

---

## 2. Bukti Empiris & Framework Terkenal

1. **Voyager (Minecraft Lifelong Agent — Anima Anandkumar / Jim Fan):**
   - Pelopor utama *Skill Library Paradigm*. Voyager secara mandiri membuat kode JavaScript untuk tindakan kompleks (seperti membuat rumah atau pedang), menyimpan kode tersebut di *Skill Library*, dan menggabungkan skill-skill kecil menjadi skill yang lebih rumit secara hirarkis.
2. **OpenCode & Antigravity Customizations (`skills/` & `SKILL.md`):**
   - Agen dapat membuat dan menyunting berkas `skills/<skill_name>/SKILL.md` yang memuat petunjuk langkah-demi-langkah, aturan, atau *cheat sheets* untuk menyelesaikan alur kerja tertentu secara persisten.
3. **ToolkenGPT & Dynamic MCP Loading:**
   - LLM yang dapat menambahkan token alat baru (*tool tokens*) ke dalam kamusnya saat runtime dan mendaftarkan endpoint MCP Server baru secara otomatis.

---

## 3. Penerapan & Pagar Batas Keamanan untuk Harvy

Jika Harvy diinstruksikan untuk membuat atau memasang skill-nya sendiri:

### A. Format Skill yang Aman untuk Harvy
1. **Instructional Skills (`SKILL.md` / Dynamic Prompt Templates):**
   - Harvy menulis panduan belajar, template ringkasan, atau alur penyelesaian masalah baru dalam bentuk berkas markdown terstruktur di folder `skills/`. Ini **paling aman** karena tidak mengeksekusi kode biner di host.
2. **Sandboxed Virtual Terminal Tools:**
   - Jika skill membutuhkan eksekusi komputasi, ia wajib dijalankan di dalam *In-Memory Virtual Terminal* (`/workspace` terisolasi) tanpa akses ke host OS atau jaringan luar.

### B. Pagar Batas Konstitusi & Safety Harness
- **Fail-Closed Safety:** Skill yang dibuat agen tidak pernah boleh melompati *Scope & Authority (ACL)* atau Konstitusi Harvy.
- **Explicit User Approval:** Pembuatan skill baru di ruang publik/grup wajib memerlukan konfirmasi admin (`Proposal -> Preview -> Approval`).
- **Right to Prune / Reset:** Pengguna dapat meninjau seluruh *Skill Library* yang telah dibuat Harvy dan menghapus skill yang tidak lagi relevan.
