## 2026-08-25 — Testing beralih ke GMI tanpa provider fallback

Scope: konfigurasi AI, migrasi environment lokal, evaluator/probe, disclosure
privasi, model profile, dan dokumentasi operasi.

Changed: Google AI Studio dan AlwaysCodex dicabut dari composition testing;
runtime, probe, dan evaluator kini selalu memakai satu provider aktif tanpa
flag fallback. Mode testing memakai endpoint OpenAI-compatible GMI Serving,
`GMI_API_KEY`, dan target `MiniMaxAI/MiniMax-M3`. Migrasi lokal atomik menghapus
enam entri provider lama tanpa memindahkan atau mencetak secret, serta kini
menulis ulang atau membuang komentar konfigurasi legacy agar `.env` tidak
menampilkan setup yang sudah dicabut. Profile live Google dihapus; sesudah
smoke exact lulus, profile code-owned MiniMax hanya terbuka untuk endpoint resmi
GMI dan model exact, sedangkan gateway/model lain tetap compatibility.
Dokumentasi/status aktif,
label fixture generik, dan provider-wire binding juga diselaraskan ke GMI;
penyebutan lama hanya dipertahankan pada migrasi, denylist, ledger historis,
serta histori keputusan yang ditandai superseded.
Perubahan penyedia, cache otomatis, dan input gambar transient menaikkan consent
privat ke v10 dan notice grup ke v11 dengan disclosure satu layanan AI utama
tanpa pengiriman ulang ke provider cadangan.

Verified: migrasi `.env` menghapus keenam entri lama dan meninggalkan slot GMI
kosong; suite terarah PASS 134/134, tes WhatsApp privat PASS 47/47,
suite cleanup provider PASS 89/89, `npm run check` PASS, dan `npm test` PASS
1.864/1.864 dalam 227 suite. Dua
artefak build Google yang stale dihapus sebelum run penuh terakhir sehingga
hasil hanya berasal dari source aktif. Setelah key tersedia lokal,
`npm run acceptance:provider` lulus terhadap endpoint/model exact untuk basic,
structured JSON, native tool+continuation, terminal/truncation, context reject,
timeout, automatic cache reuse, dan input gambar.

Not verified: rotasi/retry lintas key karena hanya satu key tersedia, SLA dan
retensi provider, serta input gambar melalui kanal Telegram/WhatsApp nyata.

Next: ukur latency/kualitas lewat dogfood kanal dan ulangi smoke rotation hanya
bila key uji kedua tersedia.
