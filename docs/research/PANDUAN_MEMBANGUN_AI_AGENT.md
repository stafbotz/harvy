# Panduan Lengkap Membangun AI Agent (Comprehensive AI Agent Engineering Guide)

- **Status:** Riset & Panduan Komprehensif (Dokumen Riset Produk & Engineering)
- **Tanggal:** 6 Agustus 2026
- **Lokasi:** `docs/research/PANDUAN_MEMBANGUN_AI_AGENT.md`
- **Sumber Data:** Riset Web, Repositori GitHub (LangGraph, CrewAI, AutoGen, PydanticAI, Smolagents, Agent SDKs), Artikel Rekayasa (Anthropic, OpenAI, Lilian Weng, LangChain, Vercel), serta Diskusi Komunitas (X.com, Threads, Substack).

---

## Ringkasan Eksekutif

Dalam lanskap rekayasa kecerdasan buatan (AI Engineering) tahun 2025–2026, **AI Agent** didefinisikan sebagai sistem berbasis Large Language Model (LLM) yang mampu **mengamati lingkungan (perception)**, **membuat rencana (planning)**, **menjalankan alat/fungsi (tool execution)**, dan **mengevaluasi hasil tindakan secara otonom atau semi-otonom** untuk mencapai tujuan spesifik.

Perbedaan fundamental antara Chatbot biasa dengan AI Agent:
- **Chatbot / Standard LLM:** *Input $\rightarrow$ Prompt $\rightarrow$ Output Teks Direct (Single-pass).*
- **AI Workflow:** *Pre-defined sequence of steps (Chain/Pipeline deterministik).*
- **AI Agent:** *Dynamic Loop (LLM secara dinamis menentukan langkah berikutnya, memilih tool yang sesuai, menerima evaluasi/observation, dan mengulang loop sampai tujuan tercapai).*

---

## 1. Komponen Utama yang Diperlukan (What is Needed)

Arsitektur AI Agent modern terdiri dari **6 Pilar Utama**:

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                              HUMAN / USER                              │
 └───────────────────────────────────┬────────────────────────────────────┘
                                     │ Intent / Task
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      HARNESS & CONTROL PLANE                           │
 │     (State Machine, Guardrails, Scope/ACL, Context Budgeting)          │
 └──────┬────────────────────────────┬─────────────────────────────┬──────┘
        │                            │                             │
        ▼                            ▼                             ▼
┌──────────────┐             ┌──────────────┐             ┌────────────────┐
│  REASONING   │             │   MEMORY     │             │    TOOLING     │
│    ENGINE    │────────────►│   SYSTEM     │────────────►│  ENVIRONMENT   │
│ (LLM Brain)  │             │ (Short/Long) │             │ (MCP / APIs)   │
└──────────────┘             └──────────────┘             └────────────────┘
```

### A. Reasoning Engine (Otak Agent / LLM)
- **Fungsi:** Tempat pemrosesan logika, pembacaan konteks, evaluasi intent, dan pembuat keputusan.
- **Model Populer 2025-2026:**
  - Anthropic Claude 3.5 / 3.7 Sonnet (sangat kuat untuk coding, tool calling, dan agentic loop).
  - OpenAI GPT-4o / o3 / o1 (kuat untuk penalaran kompleks & structured output).
  - DeepSeek R1 & Llama 3 / 3.3 (opsi open-weights untuk deployment independen/lokal).
- **Pengaturan:** System Prompt (instruksi peran & batas), Temperature (rendah $0.0 - 0.2$ untuk ketepatan tool), dan Structured Outputs (JSON Schema/Function Calling).

### B. Memory System (Sistem Memori)
Memori terbagi menjadi 3 lapisan:
1. **Short-Term Memory (In-Context Memory):**
   - Riwayat giliran pesan percakapan (*conversation turns*).
   - Dibatasi oleh *context window* model. Memerlukan strategi pemadatan (*compaction/summarization*) saat mendekati batas token.
2. **Long-Term Memory (Episodic & Semantic Storage):**
   - Storan fakta, preferensi pengguna, atau artefak sebelumnya.
   - Menggunakan **Vector Database** (Chroma, Qdrant, Pinecone, pgvector) dengan teknik RAG (Retrieval-Augmented Generation) untuk pencarian berbasis kemiripan vektor.
3. **Working State Store (KV / Document State):**
   - Menyimpan *checkpoint* variabel runtime (misal: `task_id`, `step_count`, `variables`) agar agent bisa di-*pause*, di-*resume*, atau diretas kembali (*time-travel debugging*).

### C. Planning & Reflection (Perencanaan & Evaluasi Diri)
- **Chain of Thought (CoT):** Meminta LLM "berpikir langkah demi langkah".
- **ReAct (Reason + Act):** Pola giliran: *Thought $\rightarrow$ Action $\rightarrow$ Observation $\rightarrow$ Thought*.
- **Tree of Thoughts (ToT):** Menguji beberapa cabang jalur penyelesaian masalah sebelum mengeksekusi.
- **Plan-and-Solve / Plan-and-Execute:** Membagi tugas besar menjadi daftar sub-tugas (*todo list*), lalu mengeksekusi sub-tugas satu per satu.
- **Self-Reflection & Refinement:** Agent membaca hasil output/error-nya sendiri, menganalisis kegagalan, dan memperbaiki argumen sebelum mencoba ulang.

### D. Tools & Environment Interactivity (Integrasi Alat)
- **Native Tool Calling / Function Calling:** Agen diberikan deskripsi fungsi (JSON Schema) dan memilih kapan harus memanggil fungsi tersebut.
- **Model Context Protocol (MCP):** Standar industri modern dari Anthropic yang menghubungkan Agent (*MCP Client*) dengan alat/data eksternal (*MCP Server*) via JSON-RPC (Stdio atau HTTP/SSE). MCP memungkinkan alat dibangun sekali dan dipakai oleh berbagai agent.
- **Sandboxed Execution Environment:** Lingkungan aman untuk mengeksekusi kode atau perintah sistem (misalnya Docker container, E2B sandbox, WASM, atau in-memory virtual terminal) tanpa merusak host.

### E. Harness, Control Flow & State Machine
- **State Machine / DAG (Directed Acyclic Graph):** Menjaga agen agar tidak terjebak dalam *infinite loop* dengan membatasi transisi keadaan (*state transitions*) secara terstruktur.
- **Durable Checkpointing:** Menyimpan status eksekusi di basis data sehingga jika server restarts, eksekusi agent dapat dilanjutkan dari langkah terakhir.
- **Fail-Closed Safety & Scope/ACL:** Memastikan agent hanya memiliki izin (*authority*) pada resource milik pengguna yang sah.

### F. Observability, Evaluation & Safety
- **Guardrails:** Validasi masukan/keluaran (mencegah *prompt injection*, *hallucination*, kebocoran data rahasia).
- **Observability & Tracing:** Monitoring rantai pemanggilan LLM dan Tool (menggunakan LangSmith, Langfuse, Phoenix, atau OpenTelemetry).
- **Human-in-the-Loop (HITL):** Mekanisme konfirmasi manusia sebelum agent mengeksekusi tindakan berisiko tinggi (misal: menghapus data, mengirim email, melakukan transaksi).

---

## 2. Cara Membuat AI Agent (Step-by-Step Implementation)

### Pendekatan 1: Membangun dari Nol (From Scratch - Pure Python / TypeScript)

Membangun agent sederhana dari nol tanpa framework berat sangat disarankan untuk memahami mekanismenya.

#### Algoritma Utama (Core Agent Loop):
1. **Inisialisasi:** Terima input pengguna dan muat System Prompt + Tool Schemas.
2. **Prompt LLM:** Kirim pesan + daftar tools ke LLM.
3. **Evaluasi Respons:**
   - Jika LLM mengembalikan teks biasa $\rightarrow$ Berikan ke pengguna, **selesai**.
   - Jika LLM mengembalikan *Tool Call* $\rightarrow$ Lanjut ke langkah 4.
4. **Eksekusi Tool:** Cari fungsi terkait, jalankan fungsi dengan argumen dari LLM, dan ambil hasilnya (*Observation*).
5. **Update Konteks:** Tambahkan hasil *Tool Call* dan *Observation* ke riwayat percakapan.
6. **Iterasi:** Kembali ke langkah 2 (dengan batas maksimum *step count*, misal max 10 langkah).

#### Contoh Implementasi Sederhana dalam Python:

```python
import json
from openai import OpenAI

client = OpenAI()

# 1. Definisi Tool (Fungsi Asli & Schema)
def get_weather(location: str) -> str:
    # Simulasi panggil API cuaca
    return f"Cuaca di {location} saat ini cerah, 28°C."

tools_map = {
    "get_weather": get_weather
}

tools_schema = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Mendapatkan informasi cuaca terkini untuk suatu kota",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "Nama kota, contoh: Jakarta"}
                },
                "required": ["location"]
            }
        }
    }
]

# 2. Core Agent Loop (ReAct)
def run_agent(user_query: str, max_steps: int = 5):
    messages = [
        {"role": "system", "content": "Anda adalah AI Agent pembantu yang teliti dan menggunakan tool jika diperlukan."},
        {"role": "user", "content": user_query}
    ]
    
    for step in range(max_steps):
        print(f"\n--- Step {step + 1} ---")
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            tools=tools_schema,
            tool_choice="auto"
        )
        
        message = response.choices[0].message
        messages.append(message)
        
        # Jika LLM selesai tanpa panggil tool
        if not message.tool_calls:
            print("Agent Answer:", message.content)
            return message.content
            
        # Eksekusi Tool Call
        for tool_call in message.tool_calls:
            fn_name = tool_call.function.name
            fn_args = json.loads(tool_call.function.arguments)
            print(f"Tool Executed: {fn_name}({fn_args})")
            
            if fn_name in tools_map:
                tool_result = tools_map[fn_name](**fn_args)
            else:
                tool_result = f"Error: Tool {fn_name} tidak ditemukan."
                
            # Masukkan Observation ke messages
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": str(tool_result)
            })

run_agent("Bagaimana cuaca di Jakarta hari ini?")
```

---

### Pendekatan 2: Menggunakan Framework Populer (Ekosistem 2025–2026)

Untuk aplikasi skala produksi yang kompleks, disarankan menggunakan framework teruji:

| Framework | Bahasa | Keunggulan Utama | Kapan Digunakan |
|---|---|---|---|
| **LangGraph** | Python / JS/TS | State machine berbasis grafik, *time-travel*, checkpointing durable. | Aplikasi produksi enterprise dengan alur kerja kompleks & stateful. |
| **CrewAI** | Python | Kolaborasi multi-agent berbasis peran (*Role, Backstory, Tasks*). | Tim agent terintegrasi (misal: Agent Riset + Agent Penulis + Agent Editor). |
| **PydanticAI** | Python | Validasi tipe data ketat (*type-safe*) menggunakan Pydantic, ringan. | Aplikasi Python modern yang mengutamakan reliabilitas tipe & sintaks bersih. |
| **Microsoft Agent Framework** | Python / .NET | Penggabungan AutoGen & Semantic Kernel, skala enterprise. | Ekosistem Microsoft / Azure & aplikasi enterprise terdistribusi. |
| **Smolagents** | Python | Sangat ringan (*minimalist*), mengeksekusi kode Python langsung sebagai tool. | Prototipe cepat & tugas otomatisasi sederhana tanpa overhead. |
| **Claude / OpenAI Agent SDK** | TS / Python | SDK resmi provider untuk native tool calling & loop control. | Integrasi langsung dengan API resmi Anthropic/OpenAI. |

---

## 3. Wawasan & Diskusi Komunitas (X.com, Threads, GitHub, Substack)

Rangkuman pandangan dari para pakar industri (Andrej Karpathy, Harrison Chase, Anthropic Engineering, Lilian Weng):

### 1. Anthropic — "Start Simple: Workflows vs Agents"
- **Pelajaran:** Jangan terburu-buru memakai agentik loop otonom tanpa batas (*unbounded agent*) jika masalah bisa diselesaikan dengan alur kerja deterministik (*workflows* seperti routing, parallelization, atau orchestrator-workers).
- **Rekomendasi:** Mulai dari pola yang paling sederhana. Tambahkan otonomi hanya ketika tugas membutuhkan fleksibilitas dinamik yang tidak bisa diprediksi sebelumnya.

### 2. Andrej Karpathy — "LLM sebagai Operating System (LLM OS)"
- **Pelajaran:** AI Agent pada dasarnya mirip dengan Sistem Operasi.
  - LLM = CPU (Reasoning Engine).
  - Context Window = RAM (Short-term Working Memory).
  - Vector DB / MCP / Disk = Storage (Long-term Memory & External Tools).
  - Safety Harness = OS Kernel (Permission & Isolation).

### 3. Tren Utama 2026 — Standardisasi via Model Context Protocol (MCP)
- Diterbitkan oleh Anthropic dan diadopsi secara luas oleh industri (Juli 2026 spec update).
- MCP menyelesaikan masalah $M \times N$ integrasi. Daripada setiap framework agent membuat plugin custom untuk GitHub, Slack, Postgres, dll., cukup buat **MCP Server**. Semua Agent (*MCP Client*) langsung bisa menggunakan server tersebut.

### 4. Evaluasi & Harness Lebih Penting daripada Prompting
- Performa agent di dunia nyata (seperti SWE-bench untuk otomatisasi koding) sangat ditentukan oleh **Harness Engineering** (bagaimana state dikelola, bagaimana error ditangani, bagaimana sandboxing dijalankan) daripada sekadar menyempurnakan System Prompt.

---

## 4. Checklist & Best Practices Membangun AI Agent

1. **Gunakan Fail-Closed Architecture:** Jika terjadi kesalahan pada tool call atau API timeout, agent harus berhenti secara aman (*fail-closed*), bukan melakukan retry tanpa batas atau mengeksekusi tindakan acak.
2. **Batasi Maksimum Steps & Budget:** Selalu tetapkan `max_steps` (misal: 10–15 langkah) dan `token_budget` untuk mencegah agen berjalan terus menerus (*infinite loops*) yang menghabiskan biaya API.
3. **Validasi Input/Output secara Ketat:** Gunakan JSON Schema atau Pydantic untuk memastikan data yang dipasok ke/dari tool selalu valid.
4. **Implementasikan Human-in-the-Loop (HITL):** Berikan jeda atau konfirmasi manual (*approval checkpoint*) untuk operasi yang bersifat mutasi (Write/Delete/Send/Pay).
5. **Gunakan Log & Tracing:** Catat setiap *Thought*, *Action*, dan *Observation* secara terstruktur agar mudah melakukan debugging saat agent melakukan galat penalaran (*hallucination*).

---

## 5. Referensi & Bacaan Lanjutan

- **Anthropic:** *Building Effective AI Agents* (Anthropic Research)
- **Lilian Weng (OpenAI):** *LLM Powered Autonomous Agents*
- **LangChain / LangGraph Documentation:** *Stateful Agent Architectures*
- **Model Context Protocol:** `https://modelcontextprotocol.io`
- **GitHub Repositories:**
  - `langchain-ai/langgraph`
  - `crewAIInc/crewAI`
  - `pydantic/pydantic-ai`
  - `huggingface/smolagents`
  - `microsoft/autogen`
