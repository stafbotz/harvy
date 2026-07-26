# ADR-001: Satu Sumber Kebenaran untuk Coding Agent

- Status: Superseded sebagian
- Tanggal: 25 Juli 2026
- Pemilik keputusan: pengguna Harvy dan orkestrator
- Diganti sebagian oleh: [`ADR-005`](ADR-005-konteks-menggantikan-work-order.md)

> **Catatan 26 Juli 2026.** Keputusan nomor 1, 4, 5, 6, dan 7 **tetap berlaku**:
> satu repositori sebagai sumber kebenaran, peninjau yang tidak mengedit, commit
> dan dokumen keputusan sebagai media serah-terima, `AGENTS.md` sebagai
> instruksi inti, dan dokumentasi modular lewat `docs/INDEX.md`.
>
> Yang dibatalkan adalah Work Order sebagai satuan kerja (nomor 2) beserta
> peran Builder yang terikat padanya (nomor 3). Penggantinya adalah konteks yang
> dapat dibaca sendiri dan catatan pekerjaan di `docs/LOG.md`. Lihat `ADR-005`.

## Konteks

Harvy akan dikembangkan dengan Codex, Claude Code, dan Antigravity. Ketiganya
dapat membaca serta menulis kode, sehingga memberi fitur yang sama kepada tiga
alat sekaligus akan menimbulkan konflik, pengulangan implementasi, dan biaya
review yang tidak perlu. Riwayat percakapan masing-masing alat juga tidak dapat
diandalkan sebagai memori bersama.

## Keputusan

Harvy menggunakan:

1. satu repositori Git sebagai sumber kebenaran;
2. satu Work Order besar untuk satu hasil pengguna;
3. satu Builder aktif pada satu branch;
4. agent lain sebagai Reviewer atau QA read-only;
5. commit, pull request, bukti tes, dan dokumen keputusan sebagai media
   serah-terima;
6. `AGENTS.md` sebagai instruksi inti, dengan adaptor tipis untuk Claude Code
   dan Antigravity;
7. dokumentasi modular yang ditemukan melalui `docs/INDEX.md`, bukan seluruh
   dokumentasi dimuat pada awal setiap sesi.

Peran dapat berotasi antaralat pada Work Order berikutnya. Kerja paralel hanya
diizinkan untuk paket dan folder kerja yang benar-benar terisolasi.

## Konsekuensi

Positif:

- Tidak ada tiga implementasi untuk fitur yang sama.
- Orkestrator dan pengguna dapat melihat ruang lingkup, diff, serta bukti yang
  sama.
- Agen baru dapat melanjutkan tanpa membaca chat agen lama.
- Aturan awal tetap pendek dan penggunaan konteks lebih terkendali.

Trade-off:

- Agen harus melakukan commit dan handoff sebelum berpindah alat.
- Pengembangan menunggu satu Builder jika paket belum selesai.
- Dokumen Work Order dan keputusan harus dijaga akurat.

## Alternatif yang ditolak

- Tiga agen menulis fitur yang sama lalu memilih hasil terbaik: terlalu mahal
  dan memperbesar review.
- Menaruh seluruh pengetahuan proyek di tiga file instruksi: duplikatif, cepat
  basi, dan menghabiskan konteks.
- Mengandalkan salinan chat atau ZIP sebagai komunikasi rutin: sulit diaudit
  dan tidak memiliki riwayat perubahan yang jelas.
