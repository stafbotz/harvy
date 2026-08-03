# Bukti Evaluasi Percakapan Grup — 30 Juli 2026

Seluruh artefak di folder ini memakai percakapan sintetis. Tidak ada pesan,
identitas, atau data WhatsApp pengguna. Baris pertama setiap JSONL adalah
ringkasan run; baris berikutnya menyimpan seluruh kasus agar keputusan dan
balasan yang dinilai dapat diaudit.

Artefak ini **bukan** satu run final pada seluruh kode terbaru. Versi sumber
setelah perbaikan adalah pipeline `2026-07-30.4`, kebijakan giliran
`2026-07-30.2`, corpus `2026-07-30.5`, evaluator ambient
`harvy.group-eval.v4`, dan evaluator direct `harvy.group-direct-eval.v3`.
Kuota penyedia habis sebelum kombinasi final itu dapat dijalankan penuh.
Jalur kode finalnya tetap diverifikasi tanpa jaringan melalui suite otomatis:
`npm test` lulus 390/390 tes dalam 64 suite, termasuk ambient tanpa tag,
pembatalan planner/revalidation untuk direct call, observation-settled
watermark, race removal/re-add, guard output, serta invalidasi metadata admin.
Angka ini membuktikan invarian kode, bukan naturalness model atau delivery
WhatsApp nyata.

## Artefak

| Berkas | Yang benar-benar dibuktikan | Batas bukti |
|---|---|---|
| `ambient-600-pre-policy.jsonl` | Pipeline `2026-07-30.4` pada 600 variasi permukaan: 584 lulus menurut evaluator v3; strict pass rate 0,993; p50/p95/p99 request planner 860/1.443/2.966 ms | Corpus v2, sebelum pagar lokal human-flow. Angka 600 berasal dari 150 skenario semantik × 4 variasi, bukan 600 percakapan independen. Audit manual menemukan 13 dari 16 hard failure adalah oracle kata-kunci yang terlalu sempit dan 3 sisanya false-positive bicara pada human-flow |
| `human-flow-60-post-policy.jsonl` | Seluruh 60 variasi human-flow diam setelah kebijakan lokal: 60/60, dengan 36 ditahan lokal dan 24 dinilai model; p95 request model 1.599 ms | Corpus v3 dan evaluator v3; hanya satu archetype, bukan seluruh perilaku grup |
| `direct-60-old-oracle.jsonl` | Balasan setelah routing direct tersedia pada 60/60 episode lintas 15 topik dan empat bentuk; p50/p95/p99 request balasan 878/1.378/1.767 ms | Evaluator direct v1 belum mewajibkan setiap fact-check menantang klaim salah. Karena itu hasil ini membuktikan coverage dan pagar bentuk lama, bukan ketepatan 15 fact-check. Routing alias sendiri dibuktikan tes service, bukan runner ini |
| `fact-correction-60-quota-contaminated.jsonl` | Menyimpan kegagalan run agar penyebabnya dapat diaudit | **Tidak sah sebagai skor kualitas.** Sebanyak 35 dari 60 request gagal dengan HTTP 429; evaluator v3 lama mencampurnya dengan product failure. Empat kegagalan lain berasal dari oracle kata-kunci yang kemudian diperluas |

Runner terbaru memisahkan `provider` (`429`, `5xx`, timeout, dan jaringan) dari
`harness` (`400/401/403/404/422` dan exception lokal), mengecualikan keduanya
dari metrik perilaku, memberi `null` ketika tidak ada sampel, dan tetap keluar
dengan status gagal bila salah satunya terjadi. Fact-check direct terbaru juga
mempunyai oracle tantangan klaim pada semua 15 topik.

## Interpretasi yang diizinkan

- Ada bukti model bahwa Harvy dapat memilih nimbrung tanpa tag pada banyak
  topik, dan bukti otomatis bahwa jalur produksi meneruskan keputusan itu.
- Ada bukti request model testing berada jauh di bawah target p95 planner
  5 detik dan direct 7 detik pada run yang lengkap.
- Belum ada bukti latency end-to-end WhatsApp nyata: angka di atas tidak
  mencakup jaringan WhatsApp, antrean device, atau delivery.
- Belum ada run penuh corpus v5/evaluator v4, uji manusia buta atas
  naturalness, atau uji perilaku lengkap di grup WhatsApp nyata.
