# Riset Arsitektur OpenCode & 9Router: Pelajaran & Rekomendasi Adopsi Harvy

- **Status:** Dokumen Riset Arsitektur & Rekomendasi Fitur
- **Tanggal:** 6 Agustus 2026
- **Lokasi:** `docs/research/OPENCODE_DAN_9ROUTER_RESEARCH.md`
- **Subjek:** Analisis Arsitektur **OpenCode** (Terminal-Native Agent Runtime) dan **9Router** (Local AI Gateway & Token Optimizer) serta Hal-hal yang Dapat Ditiru untuk Harvy.

---

## 1. Analisis OpenCode

### Konsep & Karakteristik Utama
OpenCode adalah *open-source terminal-native AI coding agent & runtime* berbasis Go yang menyediakan antarmuka TUI (Terminal User Interface) untuk membantu pengembangan perangkat lunak.

- **Modular Skills & Agent Framework:** Mengelompokkan agen berdasarkan peran spesifik (arsitektur, keamanan, QA) dan menggunakan kumpulan *skills* yang dapat digunakan kembali (*reusable skills*).
- **Model Agnostic & MCP Support:** Mendukung berbagai penyedia LLM (OpenAI, Anthropic, Gemini, Groq, Ollama) dan terintegrasi native dengan *Model Context Protocol* (MCP).
- **GitHub & Issue Tracker Workflow:** Dapat dipicu dalam alur kerja GitHub (PR dan Issues) via perintah `/opencode`.
- **TUI & Developer Dashboard:** Menyediakan antarmuka terminal interaktif untuk pemantauan alur agen, eksekusi perintah, dan navigasi file secara cepat.

### Apa yang Bisa Ditiru oleh Harvy:
1. **Modular Agent & Skills Registry:** Mengadopsi pola pendaftaran *skills* modular yang dapat dinikmati oleh sub-agent tanpa harus mengulang definisi prompt atau schema tool.
2. **Interactive CLI / Console Administration:** Mengembangkan antarmuka administrasi CLI/TUI yang responsif untuk menguji dan memantau status kernel Harvy.

---

## 2. Analisis 9Router (9-router)

### Konsep & Karakteristik Utama
9Router adalah *open-source local-first AI Gateway & Proxy platform* yang berada di antara aplikasi AI (Cursor, Claude Code, Cline, Codex CLI) dan berbagai *LLM providers*.

- **Unified OpenAI-Compatible Endpoint (`localhost:20128`):** Menyediakan satu pintu gerbang HTTP lokal untuk seluruh alat AI.
- **Automatic Fallback & Routing Cascading:** Jika penyedia utama terkena *rate limit* (HTTP 429) atau kehabisan kuota, 9Router secara otomatis memindahkan *request* ke penyedia cadangan (misal: beralih dari Claude Sonnet ke DeepSeek R1 / Llama 3) tanpa menggagalkan sesi pengguna.
- **RTK (Real-Time Token Saver):** Melakukan kompresi pintar pada keluaran alat (*tool output*) yang berukuran besar (seperti `git diff`, hasil `grep`, atau daftar file) sebelum dikirim kembali ke LLM, menghemat 20–40% *input tokens*.
- **Caveman Mode (Terse Output Optimization):** Mode instruksi khusus untuk memaksa LLM mengembalikan jawaban yang ultra-ringkas, menghemat hingga 65% *output tokens*.
- **Local Web Dashboard & Telemetry:** Dashboard visual untuk memantau penggunaan token, biaya, status kuota, dan jejak rute model secara *real-time*.

### Apa yang Bisa Ditiru oleh Harvy:
1. **Tool Output Compression (RTK / Observation Trimming):**
   - Sebelum hasil observasi tool yang berukuran besar (seperti daftar tugas, agenda, atau log) dimasukkan ke dalam *context window*, Harvy dapat melakukan pemangkasan/kompresi pintar (*smart trimming*) untuk menghemat *context budget*.
2. **Automatic Provider Fallback & Cascading Chain:**
   - Jika provider utama Harvy mengalami kegagalan/rate-limit, sistem secara transparan mengalihkan *request* ke provider cadangan (sejalan dengan routing model `ADR-003` Harvy).
3. **Compact / Ultra-Terse Response Mode:**
   - Menyediakan mode balasan hemat token (mirip *Caveman Mode*) untuk pengguna dengan batas kuota ketat atau koneksi jaringan lambat.
4. **Unified Local Proxy / Gateway Layer:**
   - Memisahkan logika koneksi API provider ke dalam layer proxy terisolasi sehingga pergantian provider/kunci API tidak mengganggu logika agent kernel.

---

## 3. Matriks Perbandingan & Rekomendasi Adopsi Harvy

| Fitur / Konsep | OpenCode | 9Router | Rekomendasi Penerapan di Harvy |
|---|---|---|---|
| **Pintu Masuk Integrasi** | CLI / TUI / GitHub Issues | Local OpenAI Proxy (`localhost:20128`) | Menguatkan Harvy Control Plane & Router. |
| **Optimasi Token** | Tergantung Prompt & Compaction | **RTK (Tool Output Compression)** & **Caveman Mode** | **Sangat Direkomendasikan:** Pasang kompresi keluaran tool pada `context-budget.ts`. |
| **Keandalan Network** | Direct LLM Calls | **Automatic Fallback Cascading** | **Sangat Direkomendasikan:** Otomatisasi fallback provider saat HTTP 429 / Rate Limit. |
| **Struktur Kapabilitas** | Modular Skills & Agents | Provider Routing Rules | Menggabungkan Capability Catalog Harvy (`ADR-012`) dengan fallback routing 9Router. |
