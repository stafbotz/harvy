# Catatan 28 Agustus 2026 — Biaya token dan anggaran konteks

Dipindahkan dari `docs/LOG.md` pada 4 September 2026 karena berkas aktif
melewati batas 24 KiB. Isinya utuh.

## 2026-08-28 — Biaya token terukur dan anggaran konteks dinaikkan

Scope: `src/harness/context-budget.ts`, `src/ai/persona.ts`,
`scripts/probe-chat.ts`, `tests/harness-context-budget.test.ts`.

Changed: anggaran konteks default naik dari 16.000 ke 48.000 karakter, giliran
18 → 40, memori 8 → 24, interaksi 3 → 6. Angka lama hanyalah 0,37% dari jendela
1.048.576 token MiniMax-M3 dan membuat percakapan panjang kehilangan awalnya.
Penegakan tetap memakai karakter karena deterministik, tetapi modul kini
mengekspor `approximateTokens()` agar anggaran dapat ditalar dalam token.
Konstanta rasio yang sempat hidup di modul ini disatukan ke
`src/ai/token-estimate.ts` pada entri berikutnya hari yang sama. Contoh kontras
pada `understandingPrompt` disamakan dengan gaya ringkas yang sudah dipakai di
seksi yang sama, menghapus boilerplate JSON yang berulang.

Pengukuran live pada 2026-08-28 mengoreksi beberapa angka yang sebelumnya hanya
perkiraan: rasio sebenarnya 4,18 karakter/token, bukan 3,5. Satu giliran
percakapan berbiaya 11.000–15.000 token, dan `understandingPrompt` sendiri
memakan ~8.200 token atau sekitar 60% giliran. Prompt cache provider bersifat
prefix dan sehat: mengubah hanya baris jam di akhir tetap menyisakan 99% token
ter-cache. `response_format` `json_object` maupun `json_schema` tidak dihormati
model ini—keduanya tetap mengembalikan JSON berpagar—sehingga deskripsi skema
dalam prosa tetap wajib dan tidak boleh dihapus.

Verified: `npm run check` PASS; `npm test` 1.974 lulus, 2 gagal dalam 241 suite;
22 kasus eval sebelum/sesudah pemangkasan prompt sama-sama 21/22; biaya giliran
nyata pada percakapan empat giliran 11.610 token, praktis tidak berubah karena
anggaran adalah plafon, bukan lantai.

Not verified: biaya pada percakapan yang benar-benar mengisi plafon baru belum
diukur; secara analitis batas penuh menambah ~7.600 token per panggilan ke dua
panggilan. Pemangkasan prompt tidak menunjukkan perbaikan akurasi terukur, hanya
455 token lebih murah.
