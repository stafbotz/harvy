# Catatan Material Harvy

Dokumen ini hanya mencatat perubahan material, keputusan durable, insiden,
migrasi, hasil live test, atau perubahan status kemampuan. Ia bukan jurnal
setiap sesi atau setiap commit.

Cari entri yang relevan dengan `rg -n "istilah|nama-file|error" docs/LOG.md
docs/log`. Baca maksimal tiga entri yang terkait task. Arsip histori dan fakta
material lama berada di:

- [`log/2026-08-02-sampai-2026-08-06.md`](log/2026-08-02-sampai-2026-08-06.md)
- [`log/2026-07-25-sampai-2026-08-02.md`](log/2026-07-25-sampai-2026-08-02.md)

## Kebijakan entri

Tambahkan entri hanya bila fakta atau kontrak proyek berubah material. Gunakan
beberapa paragraf pendek; pindahkan detail panjang ke issue, PR, ADR, atau
evidence. Diskusi tanpa keputusan, investigasi tanpa fakta baru, typo,
formatting, rename internal, refactor murni, dan commit kecil tidak memerlukan
entri.

Format:

```md
## YYYY-MM-DD — Judul singkat

Scope: file atau subsystem utama.
Changed: perubahan perilaku atau kontrak.
Verified: perintah dan hasil penting.
Not verified: yang belum diuji.
Next: hanya bila ada tindak lanjut material.
```

Arsipkan whole entry tertua ke `docs/log/` ketika file ini melewati 24 KiB atau
12 entri material. Jangan memecah entri dan jangan memindahkan entri yang masih
memiliki perubahan pengguna yang belum diselesaikan.

## 2026-08-06 — Bootstrap agent menjadi code-first dan berbatas

Scope: `AGENTS.md`, bootstrap Claude/Antigravity, context tooling, workflow,
STATUS, LOG, hook, dan tes kontrak agent.

Changed: satu kontrak utama kini memakai klasifikasi task dan Level 0–3; docs
dibaca on-demand dengan budget sekitar 15%. SessionStart hanya mencetak kontrak
ringkas plus `CURRENT.md`. STATUS menjadi indeks delapan subsystem dan snapshot
monolit dipindah ke arsip. LOG lama—termasuk perubahan working tree yang sudah
ada—diarsipkan dengan urutan dan fakta tetap utuh; satu credential-like value
serta kutipan pengguna sensitif direduksi tanpa mengulang nilainya. Hook tidak
lagi memaksa LOG dan hanya memvalidasi snapshot staged ketika sumber konteks
berubah. ADR-019 mencatat keputusan durable ini.

Verified: `npm run context:check` PASS dengan output bootstrap 3.627 byte
(estimasi 907 token; sebelumnya 16.434 byte). `npm run check` PASS. `npm test`
PASS, 654 test dalam 94 suite, 0 gagal. Smoke test index sementara menerima
snapshot staged lengkap serta menolak penghapusan `AGENTS.md` dan hilangnya
mode executable hook.

Not verified: runtime produk, provider/model live, Telegram, WhatsApp, dan
perilaku UI tidak dijalankan karena kode produk tidak berubah.
