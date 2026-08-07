# ADR-020: Baseline Telemetry Per Giliran

- Status: Accepted
- Tanggal: 7 Agustus 2026
- Pemilik keputusan: pengguna Harvy
- Terkait: `ADR-007`, `ADR-010`, `ADR-019`

## Konteks

Telemetry Harvy sudah mencatat setiap logical request model beserta purpose,
tier, token, latensi, keberhasilan, dan biaya tanpa isi percakapan. Namun
boundary bubble berjalan sebelum atribusi giliran dibuat, sedangkan log selesai
Telegram hanya membawa jumlah bubble dan satu durasi dari saat batch masuk FIFO.
Akibatnya baseline berikut belum dapat dihitung dengan benar:

- berapa panggilan model yang dibayar satu giliran;
- seberapa sering boundary, triase, dan review dipanggil;
- berapa waktu yang habis untuk menunggu bubble, FIFO, dan handler;
- p50/p95 jalur kritis;
- berapa giliran memakai fallback keselamatan atau fast path deterministik; dan
- apakah cancellation/error benar-benar menutup span observability.

Phase A pada spesifikasi arsitektur agent mensyaratkan baseline ini sebelum
optimasi batching dan safety mengubah perilaku produksi.

## Keputusan

1. `MessageBatcher` membuat satu UUID acak ketika bubble pertama suatu giliran
   masuk. ID yang sama dibawa dari evaluasi boundary sampai handler dan record
   terminal; ia bukan ID pengguna maupun sumber authority.
2. Telemetry persisten naik ke schema v3 dengan koleksi `turns`. Satu record
   hanya berisi enum, count, durasi, kanal/scope, outcome, dan ID korelasi.
   Prompt, balasan, ringkasan, label risiko seseorang, tool output, serta
   reasoning provider dilarang masuk.
3. Span memisahkan `batchWaitMs`, `queueWaitMs`, `handlingLatencyMs`, dan
   `totalLatencyMs`. Outcome tertutup adalah `completed`, `failed`, atau
   `cancelled`; invalidasi sebelum handler tetap menghasilkan record terminal.
4. Logical model call dihitung sesudah reservation lokal diterima dan sebelum
   request provider dimulai. Retry/fallback fisik tetap menjadi authority
   provider-attempt ledger; ia tidak diduplikasi sebagai logical call baru.
5. Count purpose yang disimpan meliputi boundary, understanding, risk triage,
   reply, reply review, serta agent. Sinyal tertutup tambahan mencatat fast path
   deterministik, triage unavailable, fallback keselamatan, dan urgent
   acknowledgement tanpa menyimpan isi atau disposition pengguna.
6. `TelemetryService.performanceSummary` menghitung nearest-rank p50/p95,
   average model calls, dan rate per turn. Turn tanpa model tetap menjadi
   denominator sehingga fast path tidak menghilang dari pengukuran.
7. Turn record mengikuti lifecycle telemetry yang sama: retensi, export,
   penghapusan owner, block/generation setelah full deletion, background flush,
   dan drain shutdown. Record yang datang sesudah owner dilupakan tidak boleh
   menghidupkan telemetry kembali. `forget` dan `allow` diserialkan sampai I/O
   penghapusan selesai; kegagalan deletion mempertahankan block.
8. Observer metrics tidak menjadi dependency correctness chat. Kegagalan
   pencatatan dilog secara tersaring dan tidak mengubah balasan, authority,
   mutasi, atau hasil safety.
9. ID record diturunkan secara deterministik dari pasangan owner+turn, dan
   repository meng-upsert pasangan itu secara idempoten. Replay setelah restart
   tidak boleh menggandakan denominator atau mengubah p50/p95.

## Konsekuensi

Harvy kini dapat membandingkan model-call rate dan latensi sebelum/sesudah
Phase B tanpa membaca percakapan. Boundary dan handler privat Telegram memakai
`turnId` yang sama, termasuk pada cancellation, dan storage lama v1/v2
dimigrasikan menjadi v3 dengan `turns: []`.

Trade-off yang diterima:

- record per giliran menambah storage telemetry berbatas retensi;
- summary saat ini owner-scoped dan belum mempunyai dashboard agregat;
- time-to-first-response belum diukur terpisah dari total latency;
- wiring terminal baru mencakup alur free-text Telegram privat; metrik grup,
  command, callback, dan durable AgentRun memerlukan span masing-masing; dan
- ini hanya Phase A observability, bukan implementasi local-first boundary,
  selective triage, atau concurrent AgentRun.

## Verifikasi

Tes mengunci korelasi satu `turnId`, agregasi purpose/sinyal, denominator turn
tanpa model, p50/p95, isolasi dua turn concurrent, cancellation terminal,
migrasi repository, export tanpa isi, serta penghapusan yang mencegah
resurrection. Hasil perintah aktual dicatat di `docs/LOG.md` setelah gerbang
repository selesai.
