# Current Context

Refreshed: 2026-08-28
Baseline: d4a56ef
Context-Version: 1

## Verified baseline

- Perubahan material yang dirangkum di sini dimulai di atas commit dasar
  `d4a56ef` pada `main`; status commit dan push aktual tetap dibaca dari Git.
- `npm run check` PASS; `npm test` 1.974 lulus dengan 2 gagal yang tercatat di
  `docs/engineering/KNOWN-FAILURES.md`; `git diff --check` PASS selain warning
  line-ending Windows.
- Smoke Edge nyata PASS pada desktop/mobile: login, navigasi tiga langkah setup,
  isi/simpan/verifikasi Compute+GitHub, non-reflection secret, dan layout. Ini
  memakai probe/storage sementara dan bukan bukti remote live.

## Recent material changes

- Percakapan privat kini punya tool tulis (`task.manage`, `reminder.schedule`)
  dengan policy otorisasi kontekstual; penghapusan tugas ditolak dengan alasan
  terbaca model. Native tool call salah bentuk mendapat satu koreksi, dan
  penghentian run dijelaskan model untuk kelas invalid_planner_output/max_steps.
- Planner memakai `tool_choice: "auto"` sebagai kontrak default; obrolan biasa
  dijawab teks tanpa dibungkus function, sedangkan kelas state-live dan kontrak
  bentuk terstruktur tetap wajib memanggil tool. Tiga capability recall
  ditambahkan: `history.search`, `memory.list`, dan `memory.remember`, privat
  saja dan memeriksa ulang consent. Keduanya baru dibuktikan unit test; belum
  ada eval provider atau kanal live, dan pencarian web tetap tidak ada.
  Gerbang masuk Agent Runtime sengaja tidak dilebarkan pada sesi ini.
- `HARVY_IDENTITY` menyatakan dua register: santai saat mengobrol, rapi saat
  bekerja, boleh berpindah dalam satu balasan. `resolveActiveTaskReference`
  tidak lagi memilih kandidat tunggal tanpa memeriksa sebutan pengguna.
- Anggaran konteks naik ke 48.000 karakter, 40 giliran, 24 memori. Biaya token
  terukur: satu giliran 11.000–15.000 token, `understandingPrompt` ~8.200 di
  antaranya. `response_format` tidak dihormati provider; rute memori semantik
  mati karena tidak ada model embedding dan GMI tidak melayani `/embeddings`.

## Active cross-subsystem blockers

- Build terdahulu sudah dipakai lewat akun Telegram tester dan dua akun WhatsApp
  terpisah, tetapi perubahan coding/Console terbaru belum diuji end-to-end dari
  kanal nyata. Dogfood tujuh hari, tiga wawancara, image live, interruption
  panjang, reconnect, dan fault window send/receipt masih terbuka.
- Host ini Windows tanpa runtime OCI Linux non-root dan tidak mempunyai GitHub
  App/repository uji nonkritis. Hostile-code conformance, bootstrap repository
  kosong, branch/push/draft PR remote, CodingRun provider live, serta critic
  `toughest` belum terbukti live.
- Backup belum mempunyai kunci durable, jadwal, atau salinan eksternal/lintas
  mesin. Control-plane/coding/group/GitHub storage masih single-service tanpa
  distributed lease, outbox/dispatcher, shared store, dan reconciliation
  multi-instance; jangan klaim siap horizontal atau siap peluncuran publik.
- Corpus provider adalah regresi terbatas, bukan pengukuran FP/FN safety/memory
  yang terkalibrasi. Jangan menyamakan suite fake/local, smoke provider, atau
  browser Console dengan bukti usefulness pengguna dan efek remote.

## Route to detail

- [Agent Runtime](../engineering/status/agent-runtime.md)
- [Telegram](../engineering/status/telegram.md)
- [WhatsApp](../engineering/status/whatsapp.md)
- [Memory and data](../engineering/status/memory.md)
- [Project workspace and coding](../engineering/status/coding.md)
- [Safety and privacy](../engineering/status/safety-privacy.md)
- [Platform](../engineering/status/platform.md)

## Maintenance

Replace stale bullets; do not append chronology. Keep at most three recent
changes and only cross-subsystem blockers. Never include credentials,
identifiers, raw logs, prompts, or user quotations. This file must remain at
most 5,120 bytes and total bootstrap output at most 8,192 bytes.
