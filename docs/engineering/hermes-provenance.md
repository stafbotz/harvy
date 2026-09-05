# Provenance: Hermes Agent

Beberapa modul Harvy membawa komentar berbentuk "Asalnya `hermes/…`". Berkas
ini mencatat apa yang dirujuk komentar-komentar itu, karena salinan sumbernya
tidak lagi ada di repositori ini.

## Sumbernya

- **Proyek:** Hermes Agent, Nous Research.
- **Repositori:** `https://github.com/NousResearch/hermes-agent`
- **Lisensi:** MIT, Copyright (c) 2025 Nous Research.
- **Bentuk salinan:** direktori `hermes/` di working tree, **bukan klon Git** —
  tidak ada `.git`, sehingga tidak ada SHA commit yang dapat dicatat.
- **Dibaca:** 4 September 2026. Salinannya bertanggal 3 September 2026
  (mtime seluruh berkas), `pyproject.toml` menyebut versi `0.21.0`, dan nomor
  issue tertinggi yang muncul di komentar sumbernya adalah `#112954`.
- **Dihapus dari working tree:** 5 September 2026, sesudah catatan ini dibuat.

Salinan itu berukuran 185 MB dan sekitar 11.000 berkas. Ia tidak pernah masuk
Git, tidak pernah disentuh `tsconfig.json`, dan tidak pernah diperiksa
`periksa-dokumentasi` — rujukan `hermes/…` tidak dapat membuat gerbang mana pun
merah, dulu maupun sekarang.

## Kenapa versinya perlu dicatat

Repositori itu berubah cepat, dan sumbernya sendiri memuat catatan bahwa
rancangan yang dijelaskan sebuah dokumen sudah diganti sesudahnya. Klon baru
dari upstream karena itu belum tentu memuat berkas yang sama seperti yang
dikutip. Komentar "Asalnya `hermes/…`" adalah **kutipan pada versi di atas**,
bukan tautan hidup.

## Apa yang benar-benar diambil

Yang diadaptasi selalu mekanismenya, bukan kodenya; tidak ada satu baris pun
yang disalin. Setiap modul menuliskan sendiri apa yang **tidak** ditiru dan
kenapa.

| Modul Harvy | Berkas yang dirujuk | Yang diambil |
|---|---|---|
| `src/bot/telegram-api-resilience.ts` | `plugins/platforms/telegram/adapter.py` | Deteksi polling yang mati diam-diam. Tiga detektornya tidak ditiru: grammY memberi titik cegat yang tidak dimiliki python-telegram-bot, jadi satu deadline di lapisan yang benar sudah cukup. |
| `src/core/reply-obligation-service.ts` | `gateway/delivery_ledger.py` | Empat keadaan janji pengiriman beserta penanda untuk keadaan yang ambigu. |
| `src/core/memory-curator-policy.ts` | `agent/curator.py`, `tools/skill_usage.py` | Penuaan berbasis pemakaian, jenis yang kebal, dan larangan menghapus diam-diam. |
| `src/core/offer-fatigue-policy.ts` | `cron/suggestions.py` | Latch penolakan: yang ditolak tidak ditawarkan lagi, dan daftarnya berplafon. |
| `src/core/repetition-guard.ts` | `agent/repetition_guard.py` | Ambang deteksi perulangan. Uji jendela verbatim-nya **tidak** ditiru; ia salah menuduh daftar langkah paralel, jadi diganti uji periodisitas. |
| `src/core/attachment-policy.ts` | `gateway/platforms/base.py` | Magic bytes memutuskan wadah berkas, bukan mimetype dari kanal. |
| `src/core/episode-anchors.ts` | `agent/context_compressor.py` | Panen identifier tanpa model. **Hipotesisnya tidak lolos pengukuran** dan tidak dirender ke prompt; lihat ADR-047. |
| `src/core/mastery-policy.ts`, `src/core/learning-trace-service.ts` | `agent/turn_context.py`, `agent/turn_finalizer.py` | Kadensi tinjauan pertumbuhan, dibalik arahnya: Hermes menumbuhkan agennya, Harvy mencatat kemampuan pelajarnya. Lihat ADR-047. |
| `scripts/eval-pemadatan.ts` | `evals/compaction/` | Bank pertanyaan tetap, arm kendali sebagai langit-langit, dan recall dilaporkan pada biaya konteks. |
| `docs/engineering/TESTING.md` | `AGENTS.md` bagian pengujian | Larangan tes change-detector dan tes yang membaca sumber untuk menilai perilaku. |

Aturan penulisan memori deklaratif di `src/ai/persona.ts` juga berasal dari
`agent/prompt_builder.py`, beserta sebabnya: kalimat perintah terbaca ulang
sebagai aturan berdiri pada giliran berikutnya.

## Yang belum digali ketika salinannya dihapus

Satu utas terbuka menunjuk balik ke sana. Pengukuran 4 September 2026
menemukan pencarian riwayat menaikkan recall dari 20,8% ke 60,4%, dan
menyisakan selisih 37 poin ke langit-langit yang belum terjelaskan.
`tools/session_search_tool.py` di repositori itu — empat mode pemanggilan,
dedup lineage, dan demosi sumber untuk melawan apa yang mereka sebut *recall
blindness* — belum pernah dibaca lebih dari headernya. Scorecard pemadatan
mereka memuat temuan yang menunjuk ke celah yang sama: kegagalan pemulihan
kebanyakan soal perumusan query.

Bila utas itu dilanjutkan, klon ulang dari upstream cukup; catat versinya lagi
di sini karena isinya kemungkinan sudah bergeser dari yang dikutip di atas.
