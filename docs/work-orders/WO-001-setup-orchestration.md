# WO-001: Setup Orkestrasi Harvy

- Status: `READY_FOR_ACCEPTANCE`
- Pemilik produk: pengguna Harvy
- Orkestrator: ChatGPT
- Builder: Codex (sesi setup)
- Reviewer: orkestrator
- QA: pemeriksaan otomatis dan penerimaan pengguna
- Base branch: belum ada saat pekerjaan dimulai
- Work branch: `main` sebagai pengecualian bootstrap awal

## Masalah dan hasil pengguna

Codex, Claude Code, dan Antigravity belum memiliki sumber konteks, kepemilikan,
atau cara serah-terima yang sama. Setelah paket ini, pengguna dapat membicarakan
ide dengan orkestrator, lalu satu coding agent mengerjakan satu paket sementara
agent lain meninjau atau menguji tanpa tumpang tindih.

## Dalam ruang lingkup

- Membuat satu instruksi inti dan adaptor untuk tiga coding agent.
- Membuat peta dokumentasi modular.
- Mendefinisikan peran, status Work Order, branch, handoff, review, dan QA.
- Menyediakan template Work Order dan pull request.
- Mendokumentasikan gerbang pengujian yang sesuai dengan proyek saat ini.
- Membentuk snapshot Git awal pada branch `main`.
- Memverifikasi repositori GitHub privat `stafbotz/harvy` dan akses konektor.
- Menerbitkan snapshot awal ke branch `main` sebagai pengecualian bootstrap.
- Memastikan tidak ada secret yang jelas ikut terlacak.

## Di luar ruang lingkup

- Perubahan fitur atau perilaku bot Harvy.
- Capybara v0.2.
- Router model DeepSeek/OpenAI.
- Mengubah pengaturan akun GitHub di luar akses repo yang sudah diberikan.
- Deployment dan perubahan layanan eksternal.

## Keputusan yang sudah dikunci

- Pengguna dan ChatGPT menjadi orkestrator.
- Satu Builder aktif per Work Order; alat lain read-only sebagai Reviewer/QA.
- Satu sumber kebenaran melalui Git dan, setelah terhubung, GitHub privat.
- Instruksi awal pendek; agen mencari dokumen relevan melalui `docs/INDEX.md`.
- Setup awal boleh membuat `main`; setelah bootstrap tidak ada edit langsung ke
  `main`.

## Kriteria penerimaan

- [x] `AGENTS.md` menjadi pintu masuk bersama.
- [x] `CLAUDE.md` hanya mengimpor instruksi inti.
- [x] Rule Antigravity menunjuk ke instruksi inti.
- [x] Peta dokumentasi, protokol orkestrasi, dan keputusan tersedia.
- [x] Template Work Order dan pull request tersedia.
- [x] Riwayat Git bootstrap menggunakan branch `main`; workspace Codex sesi
  ini tidak dapat menulis metadata `.git`, sehingga verifikasi dilakukan
  melalui tree Git sementara dan konektor.
- [x] Repositori GitHub tetap privat dan snapshot awal tersedia di `main`.
- [x] `npm run check` dan `npm test` lulus setelah perubahan.
- [x] Audit file sensitif dan diff akhir selesai.
- [ ] Pengguna menerima setup.

## Konteks yang wajib dibaca

| Dokumen/kode | Alasan |
|---|---|
| `README.md` | Cara kerja dan verifikasi v0.1 |
| `docs/PROJECT.md` | Status produk dan backlog |
| `package.json` | Perintah yang benar-benar tersedia |
| `.gitignore` dan `.env.example` | Batas secret dan data lokal |

## Batas implementasi

- Tidak mengubah file di `src/`, `tests/`, dependency, atau lockfile.
- Tidak memasukkan credential ke berkas baru.
- Tidak membuat klaim tes manual Telegram yang tidak dijalankan.

## Verifikasi wajib

Automated:

- `npm run check`
- `npm test`
- Pemeriksaan link/path internal dan status Git.

Manual:

- Pastikan instruksi Builder, Reviewer, dan QA tidak memberi dua agen izin
  menulis paket yang sama.
- Setelah repo dibuka di tiap alat, verifikasi adaptor sesuai
  `docs/operations/ORCHESTRATION.md`.

## Berhenti dan tanyakan jika

- Git menemukan secret atau data pengguna.
- Struktur proyek nyata bertentangan dengan protokol.
- Target remote, visibilitas privat, atau izin konektor berbeda dari yang
  disetujui pengguna.

## Handoff Builder

- Commit/PR: snapshot bootstrap `2f0be4fa64a9d1c7487c85057569ef21257d3f2c`
  pada `main`; commit dokumentasi handoff ini menjadi HEAD berikutnya; PR tidak
  digunakan untuk initial `main`
- Ringkasan: instruksi inti, adaptor Claude/Antigravity, peta dokumentasi,
  protokol peran, template Work Order, template PR, dan gerbang tes telah dibuat
- Automated: `npm run check` PASS; `npm test` PASS (10/10); seluruh link Markdown
  lokal valid; source, tests, dependency, lockfile, dan konfigurasi TypeScript
  identik dengan arsip v0.1; pemindaian secret tidak menemukan kandidat
- Manual: audit kepemilikan memastikan hanya Builder yang boleh menulis;
  verifikasi adaptor dalam aplikasi Codex/Claude/Antigravity belum dijalankan
- Asumsi: repo `stafbotz/harvy` tetap menjadi sumber kebenaran privat Harvy
- Risiko atau pekerjaan tersisa: workspace Codex sesi ini tidak dapat menulis
  `.git`; gunakan clone baru dari GitHub pada coding agent. Rule Antigravity
  masih perlu dikonfirmasi sebagai `Always On`
- Dokumentasi yang diubah: `README.md`, `AGENTS.md`, `CLAUDE.md`,
  `.agent/rules/`, `.github/`, dan dokumen baru di `docs/`

## Hasil review

- Status: `READY_FOR_ACCEPTANCE`; tree GitHub identik dengan snapshot lokal dan
  seluruh pemeriksaan wajib lulus
- `BLOCKER`/`IMPORTANT`: tidak ada pada audit lokal terakhir
- `MINOR` untuk backlog: tidak ada

## Penerimaan

- Keputusan pengguna: menunggu
- Commit yang diterima: menunggu
- Tanggal: menunggu
