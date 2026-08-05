# Riset Arsitektur AI Agent: Codex CLI, OpenClaw, Hermes Agent & Graph-Based Architecture

- **Status:** Dokumen Riset Arsitektur & Rekomendasi Adopsi
- **Tanggal:** 6 Agustus 2026
- **Lokasi:** `docs/research/ARSIKTEKUR_CODEX_OPENCLAW_HERMES_GRAPH.md`
- **Subjek:** Analisis Perbandingan Arsitektur **Codex CLI**, **OpenClaw**, **Hermes Agent (Nous Research)**, dan **Graph-Based Architecture (LangGraph)** serta Hal-hal yang Dapat Ditiru untuk Harvy.

---

## 1. Analisis Arsitektur Codex CLI (OpenAI)

### Konsep & Karakteristik Utama
Codex CLI dirancang sebagai agen koding / otomatisasi terminal yang beroperasi secara *autonomous pair programmer* langsung di repositori pengguna.

- **Iterative Agent Loop:** ReAct cycle (*Think $\rightarrow$ Plan $\rightarrow$ Tool Call $\rightarrow$ Observe $\rightarrow$ Reflect*).
- **Environment Boundary (Sandboxing):** Mengisolasi perintah eksekusi terminal menggunakan teknologi sandbox OS (Apple Seatbelt pada macOS, Landlock/seccomp pada Linux) untuk mencegah perintah berbahaya pada host machine.
- **Guardian / Policy Engine:** Memiliki tingkatan mode persetujuan (misal `auto-edit` vs `full-auto`). Sebelum tindakan berdampak tinggi dilakukan (misal install dependency atau jalankan command destruktif), Guardian menahan eksekusi untuk minta persetujuan pengguna.
- **Diff-Based Operations:** Pengubahan kode/data menggunakan pembuatan unified diff/patch terlebih dahulu sebelum diaplikasikan, sehingga perubahan dapat diverifikasi.
- **Context Governance (`AGENTS.md`):** Membaca berkas tata tertib/instruksi lokal di repositori sebagai aturan permanen agen.

### Apa yang Bisa Ditiru oleh Harvy:
1. **Tiered Approval Engine (Guardian):** Menerapkan kelas tindakan (*read-only*, *safe mutation*, *high-risk mutation*). Tindakan membaca cukup berjalan otomatis, tetapi mutasi data sensitif wajib melewati persetujuan eksplisit.
2. **Diff / Preview Mode:** Sebelum merubah state atau data pengguna (seperti menyelesaikan tugas atau mengubah jadwal), hasil perubahannya dipratinjaukan terlebih dahulu (*diff preview*).
3. **OS-Level Execution Isolation:** Mengamankan alat eksekusi (seperti terminal virtual) dalam sandbox terisolasi.

---

## 2. Analisis Arsitektur OpenClaw

### Konsep & Karakteristik Utama
OpenClaw dibangun dengan filosofi **Control-Plane Gateway**—fokus pada sistem gateway terpusat yang menghubungkan banyak agen dengan berbagai kanal komunikasi (*multi-channel/multi-surface* seperti Slack, WhatsApp, Telegram, Discord).

- **Gateway Daemon Terpusat:** Satu daemon utama mengelola antrean pesan, routing pengguna, rate-limiting, dan manajemen sesi.
- **Multi-Tenant & Multi-Surface ACL:** Pemisahan ketat identitas dan hak akses di setiap surface. Agen mengenali konteks spesifik di kanal tertentu tanpa membocorkan data ke kanal lain.
- **Strict Orchestration Over Random LLM:** Menganggap LLM sebagai mesin stokastik yang harus dibatasi oleh aturan alur kerja yang ketat (*structured workflow & gating*).

### Apa yang Bisa Ditiru oleh Harvy:
1. **Central Control-Plane Architecture:** Memisahkan ingress adapter (Telegram, WhatsApp, Web) dengan kernel agent utama melalui Router/Control Plane tunggal.
2. **Strict Session & Scope Isolation:** Memastikan data percakapan di grup WhatsApp tidak pernah bocor ke ruang pribadi Telegram atau sebaliknya (sesuai dengan arsitektur `AgentScope` Harvy).
3. **Queue & Rate Limiting Management:** Pengelolaan *message batching*, penundaan adaptif, dan antrean pesan per pengguna agar agen tidak kewalahan menghadapi burst pesan.

---

## 3. Analisis Arsitektur Hermes Agent (Nous Research)

### Konsep & Karakteristik Utama
Hermes Agent mengusung filosofi **Self-Improving Runtime & Deep Personalization**. Fokus utamanya adalah kedalaman kognitif (*cognitive depth*) dan kemampuan agen untuk belajar dari pengalaman masa lalu.

- **Do, Learn, Improve Loop:** Selain menyelesaikan tugas, agen mengevaluasi hasil aksinya sendiri untuk memperbarui instruksi/memori internal (*skill acquisition & refinement*).
- **Personalized Context & User Modeling:** Membangun pemahaman mendalam tentang pola, preferensi, dan gaya interaksi pengguna dari waktu ke waktu secara inkremental.
- **Modular Python Runtime:** Arsitektur yang sangat modular di mana setiap kapabilitas (*skills*) dapat ditambahkan atau diperbaiki oleh agen itu sendiri.

### Apa yang Bisa Ditiru oleh Harvy:
1. **Self-Reflective Episode Summarization:** Setelah sesi percakapan selesai, agen melakukan sintesis asinkron tentang apa yang berhasil dan apa yang perlu diperbaiki (sejalan dengan *structured episodic compaction* Harvy).
2. **Dynamic Skill/Memory Adaptation:** Agen memperbarui strategi pendekatannya kepada pengguna berdasarkan preferensi yang diamati tanpa mengubah moral boundary atau konstitusi utama.

---

## 4. Analisis Arsitektur Berbasis Grafik (Graph Architecture / LangGraph)

### Konsep Utama (Nodes, Edges, State Machine)
Graph Architecture menggantikan pola ReAct loop bebas/tanpa batas dengan **Finite State Machine terarah (Directed Graph)**.

```
 ┌─────────────┐     Normal Edge     ┌──────────────┐
 │ Input Node  ├────────────────────►│ Planner Node │
 └─────────────┘                     └──────┬───────┘
                                            │
                                            ▼
 ┌─────────────┐   False (Reflect)   ┌──────────────┐
 │  Tool Node  │◄────────────────────┤ Conditional  │
 └──────┬──────┘                     │  Check Edge  │
        │                            └──────┬───────┘
        │      True (Approved)              │ True (Done)
        └───────────────────────────────────┴─────────────► [ Final Output Node ]
```

- **State:** Struct data bersama yang menyimpan riwayat, variabel runtime, dan hasil observasi.
- **Nodes:** Fungsi individual (LLM pass, tool execution, atau kode bisnis deterministik). Setiap node menerima *State* saat ini dan mengembalikan pembaruan (*State Update*).
- **Edges:**
  - *Normal Edges:* Alur pasti dari Node A ke Node B.
  - *Conditional Edges:* Routing dinamis berdasarkan keputusan LLM atau kondisi logika (contoh: jika hasil validasi gagal $\rightarrow$ kembali ke Node Reflection; jika butuh persetujuan $\rightarrow$ masuk Node Wait Approval).
- **Time-Travel & Checkpointing:** Karena setiap transisi node mencatat *State Snapshot*, agen dapat di-*pause*, di-*resume*, atau dikembalikan ke langkah sebelumnya jika terjadi kegagalan.

### Keuntungan Graph Architecture dibanding ReAct Loop Biasa:
1. **Determinisme & Kontrol Terukur:** Pengembang dapat memadukan langkah pasti yang wajib melewati aturan bisnis dengan langkah kreatif LLM.
2. **Siklus Koreksi Diri (Cyclical Loops):** Agen bisa melakukan iterasi perbaikan (*reflect/retry*) hanya pada node tertentu tanpa mengulang dari awal.
3. **Durable Pause & Resume (Human-in-the-Loop):** Grafik dapat dihentikan di *node approval*, menunggu masukan pengguna via tombol Telegram/WhatsApp, lalu dilanjutkan persis dari state tersebut.

---

## 5. Ringkasan Peta Komparasi & Rekomendasi Adopsi Harvy

| Arsitektur | Fokus Utama | Konsep Kunci yang Patut Ditiru Harvy |
|---|---|---|
| **Codex CLI** | Developer & Terminal Sandbox | **Tiered Guardian & Diff-based Preview** (mencegah mutasi destruktif tanpa konfirmasi). |
| **OpenClaw** | Control-Plane Gateway & Multi-Surface | **Central Session Router & Scope Isolation** (pemisahan data privat Telegram & grup WhatsApp). |
| **Hermes Agent** | Self-Improvement & Learning Loop | **Episodic Refinement & Adaptive User Modeling** (pembelajaran dari riwayat tanpa bocor data). |
| **Graph-Based (LangGraph)** | State Machine & Deterministic Routing | **Nodes + Conditional Edges + Checkpointing** (mengganti loop ReAct tak berujung dengan grafik terarah yang dapat di-pause). |

---

## 6. Pola Arsitektur Ideal untuk Harvy (Rekomendasi Kombinasi)

Dengan menggabungkan wawasan dari keempat arsitektur di atas, arsitektur masa depan yang ideal untuk Harvy adalah:

> **OpenClaw Control Gateway** *(Routing & Isolation)*  
> $\rightarrow$ **Graph State Machine** *(Deterministic Nodes & Conditional Edges)*  
> $\rightarrow$ **Codex-style Guardian** *(Tiered Approval & Diff Preview)*  
> $\rightarrow$ **Hermes Episodic Learning** *(Compaction & Refinement)*

Pola kombinasi ini menjamin Harvy tetap **aman, dapat diprediksi, tanggap pada multi-kanal, serta mampu belajar berkembang secara konsisten**.
