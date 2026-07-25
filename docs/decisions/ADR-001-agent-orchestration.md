# ADR-001: Satu Sumber Kebenaran untuk Coding Agent

- Status: Accepted; amended
- Tanggal awal: 25 Juli 2026
- Amandemen pembagian dan komunikasi: 26 Juli 2026
- Pemilik keputusan: pengguna Harvy dan orkestrator

## Konteks

Harvy dikembangkan dengan Codex, Claude Code, dan Antigravity. Ketiganya dapat
membaca atau menulis kode, tetapi setiap alat memiliki sesi, model, riwayat
percakapan, dan kondisi workspace yang terpisah. ChatGPT Work menjadi
orkestrator, bukan pengganti otomatis untuk coding agent.

Memberi fitur yang sama kepada beberapa penulis sekaligus menimbulkan konflik,
pengulangan, serta provenance yang tidak jelas. Mengandalkan chat juga membuat
alat berikutnya tidak mengetahui apa yang benar-benar dikerjakan, diuji, atau
belum terbukti.

## Keputusan

Harvy menggunakan:

1. satu repositori Git/GitHub privat sebagai sumber kebenaran;
2. satu Work Order untuk satu hasil pengguna;
3. satu Builder aktif pada satu branch;
4. Reviewer dan QA read-only;
5. commit, PR, bukti tes, catatan review/QA, dan dokumen keputusan sebagai
   media komunikasi;
6. `AGENTS.md` sebagai instruksi inti, dengan adaptor tipis untuk Claude Code
   dan Antigravity;
7. dispatch mandiri serta pengakuan identitas/model/commit pada awal tugas;
8. format pertanyaan dan handoff yang membedakan fakta, klaim, bukti, dan hal
   yang belum diuji;
9. provenance berdasarkan pelaksana aktual, bukan label alat yang diharapkan.

Pembagian default terbaru:

| Pihak | Profil default | Peran default |
|---|---|---|
| Pengguna | Pemilik produk | Pengarah dan penerima akhir |
| ChatGPT Work | Orkestrator | Instruksi, keputusan, dokumentasi, dan pemeriksaan bukti |
| Codex | GPT-5.6 Sol | Builder |
| Claude Code | Opus 5 | Reviewer |
| Antigravity | Gemini 3.6 Flash | QA/integrasi |

Peran dapat dirotasi hanya melalui Work Order. Model aktual harus dilaporkan
setiap sesi; perbedaan tidak boleh disubstitusi diam-diam.

Model alat pengembangan tidak sama dengan model runtime produk Harvy. Arah
produk DeepSeek V4 Flash, GPT-5.6 Luna, dan GPT-5.6 Terra dicatat terpisah dan
tidak boleh dianggap telah diimplementasikan hanya karena nama model muncul
dalam prototipe.

ChatGPT Work tidak mengoding atau menerbitkan perubahan kecuali pengguna
memerintahkannya secara eksplisit. Pembaruan dokumentasi koordinasi dapat
dilakukan setelah disetujui pengguna.

## Penanganan penyimpangan historis

PR #1 dan PR #2 dibuat langsung oleh ChatGPT Work melalui konektor GitHub,
walaupun Work Order awal melabelkannya sebagai Codex. Dokumen harus menyebut
pelaksana aktual. Kode tidak dihapus, tetapi sebelum diterima harus:

1. ditinjau Claude Code secara read-only;
2. diuji Antigravity secara read-only;
3. temuan digabungkan orkestrator;
4. perbaikan, bila disetujui, diberikan kepada Codex melalui dispatch baru.

## Konsekuensi

Positif:

- Pengguna dapat mengetahui siapa mengerjakan apa dan apa buktinya.
- Agen baru dapat melanjutkan tanpa membaca chat agen lama.
- Tidak ada dua penulis yang saling menimpa.
- Klaim “selesai” atau “siap” dapat dibedakan dari tes nyata.
- Pergantian alat/model dapat diaudit.

Trade-off:

- Setiap perpindahan alat memerlukan dispatch, ACK, dan handoff singkat.
- Pekerjaan menunggu jika ada keputusan material atau identitas tidak cocok.
- Work Order dan PR harus dijaga akurat.

## Alternatif yang ditolak

- Tiga agen menulis fitur yang sama: terlalu mahal dan rawan konflik.
- Mengandalkan percakapan sebagai memori bersama: konteks tidak otomatis
  berpindah.
- Menamai pelaksana berdasarkan alat yang diharapkan, bukan alat aktual:
  menyesatkan.
- Reviewer atau QA memperbaiki kode di tengah pemeriksaan: menghilangkan
  independensi bukti.
- Menggabungkan model coding agent dan model runtime Harvy: mencampur dua
  keputusan arsitektur yang berbeda.
