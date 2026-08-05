# Cara Bekerja di Repositori Harvy

Dokumen ini pendek dengan sengaja. Sejak
[`ADR-005`](../decisions/ADR-005-konteks-menggantikan-work-order.md), Harvy tidak
memakai Work Order. Yang menggantikannya adalah konteks yang dapat dibaca sendiri
dan catatan pekerjaan yang jujur.

## Sebelum menulis apa pun

Jawab empat pertanyaan ini dari repositori, bukan dari ingatan atau tebakan:

| Pertanyaan | Dokumen |
|---|---|
| Proyek ini apa dan untuk siapa? | [`PROJECT.md`](../PROJECT.md) |
| Apa batas moral dan hak penggunanya? | [`CONSTITUTION.md`](../CONSTITUTION.md) |
| Apa yang sudah benar-benar berjalan? | [`engineering/STATUS.md`](../engineering/STATUS.md) |
| Apa yang dikerjakan terakhir kali? | [`LOG.md`](../LOG.md) |

Kalau dokumen dan kode bertentangan, kode yang menang dan perbedaannya
dilaporkan. Jangan diam-diam memilih salah satu.

## Satu penulis pada satu waktu

Manusia dan beberapa AI bekerja bergantian di folder yang sama. Aturannya
sederhana:

- Hanya satu pihak yang menulis file pada satu waktu.
- Sebelum berpindah alat, pastikan pekerjaan sudah di-commit atau folder kerja
  bersih. Alat berikutnya tidak dapat melihat perubahan yang masih menggantung
  di kepala alat sebelumnya.
- Yang meninjau atau menguji tidak ikut mengedit. Perbaikan kembali ke penulis
  yang sama, supaya tidak ada dua versi niat pada file yang sama.
- Jika dua pekerjaan benar-benar harus berjalan bersamaan, pakai clone atau Git
  worktree terpisah — bukan dua penulis pada satu folder.

## Branch dan `main`

- Agent boleh bekerja dan membuat commit langsung pada branch aktif, termasuk
  `main`.
- Branch bernama seperti `fix/tombol-callback` atau
  `feat/riwayat-percakapan` bersifat opsional. Gunakan bila pemisahan pekerjaan
  atau proses review memang membutuhkannya.
- Pull request tidak wajib. Buat hanya bila diminta atau berguna untuk review.
- Push, force-push, merge, rebase, dan penghapusan branch hanya dilakukan bila
  diminta.

## Selesai berarti apa

Sebuah pekerjaan selesai ketika ada:

1. perubahan yang dapat dilihat pada diff;
2. hasil `npm run check` dan `npm test` yang benar-benar dijalankan, beserta
   angkanya;
3. keterangan jujur tentang apa yang **tidak** diuji — terutama percakapan,
   tombol, dan pengingat, yang tidak tersentuh gerbang otomatis; dan
4. satu entri baru di [`LOG.md`](../LOG.md).

Chat yang berkata "selesai" tanpa empat hal itu belum selesai. Rinciannya ada di
[`../engineering/TESTING.md`](../engineering/TESTING.md).

## Yang menegakkan ini

Instruksi tertulis saja tidak cukup. Agent melewatinya, dan manusia lupa. Karena
itu ada tiga lapis, dari yang paling lemah ke yang paling keras.

| Lapis | Berlaku untuk | Kekuatan |
|---|---|---|
| Kontrak di `AGENTS.md` | Codex, Claude Code, Antigravity, manusia | Bergantung pada kepatuhan |
| Hook `SessionStart` di `.claude/settings.json` | Claude Code saja | Konteks hadir tanpa diminta |
| Hook `pre-commit` di `.githooks/` | Siapa pun yang melakukan commit | Menolak commit |

Hook Git menolak commit yang menyentuh `src/`, `tests/`, `docs/`, `AGENTS.md`,
atau `README.md` tanpa menyertakan perubahan pada `docs/LOG.md`. Aktifkan sekali
per clone:

```bash
git config core.hooksPath .githooks
```

Perlu jujur soal batasnya. Hook `pre-commit` dapat dilewati dengan
`git commit --no-verify`, dan itu memang disengaja: kadang sebuah commit benar
tidak layak dicatat. Yang dijaga hook ini adalah kelupaan, bukan niat. Hook
`SessionStart` juga hanya mengikat Claude Code; Codex dan Antigravity tetap
bergantung pada `AGENTS.md` dan hook Git.

## Kapan berhenti dan bertanya

Kumpulkan pertanyaan lalu tanyakan sekaligus, jangan satu per satu. Berhenti
bila jawabannya dapat mengubah:

- pengalaman pengguna;
- bentuk, retensi, atau privasi data;
- keamanan, credential, atau tindakan ke layanan luar;
- dependency, model, atau biaya operasional; atau
- batas yang ditetapkan Konstitusi.

Pilihan implementasi kecil yang mudah dibalik tidak perlu menunggu. Ambil yang
paling sederhana dan konsisten dengan kode di sekitarnya, lalu catat asumsinya.

## Bobot temuan saat meninjau

- `BLOCKER` — kehilangan atau kebocoran data, celah keamanan, tes gagal, atau
  fitur utama rusak.
- `IMPORTANT` — bug atau risiko material yang besar kemungkinan dirasakan
  pengguna.
- `MINOR` — kosmetik dan perbaikan opsional; masuk backlog di
  [`PROJECT.md`](../PROJECT.md), bukan menghalangi.

Setiap temuan menyebut bukti, lokasi, dampak, dan cara memverifikasinya.
Reviewer tidak mengejar kuota temuan.

## Tiga alat, satu instruksi

- Codex membaca `AGENTS.md` dari root Git.
- Claude Code membaca `CLAUDE.md`, yang hanya mengimpor `AGENTS.md`.
- Antigravity membaca `.agent/rules/00-harvy-bootstrap.md`, yang menunjuk ke
  `AGENTS.md`. Di panel Rules, atur sebagai **Always On**.

Ketiganya membuka clone dari repositori yang sama. Jangan memakai tiga salinan
dengan riwayat berbeda.

## Batas teknis dan verifikasi

- Gunakan Node.js 22 atau lebih baru.
- Pemeriksaan minimum perubahan kode: `npm run check` dan `npm test`.
- Jangan menambah dependency, mengubah kontrak data, pengalaman pengguna,
  keamanan, layanan eksternal, atau biaya tanpa diminta.
- Keputusan teknis kecil boleh diambil dan dicatat di `LOG.md`.
- **Gerbang otomatis tidak menyentuh model sungguhan maupun grammY.** Yang
  teruji hanya bagian murni. `npm test` yang hijau tidak membuktikan Harvy dapat
  berbicara, tombolnya hidup, atau pengingatnya terkirim; itu hanya dapat
  dibuktikan lewat uji manual dengan kunci API sungguhan.
- Baca `docs/engineering/STATUS.md` sebelum mengklaim sebuah kemampuan sudah
  ada. Dokumen lain menjelaskan tujuan dan keputusan, bukan keadaan kode.
- Baca `docs/engineering/TESTING.md` untuk bukti tes dan pengujian manual.

## Repositori dan secret

Remote `stafbotz/harvy` bersifat privat dan harus tetap begitu. Jangan pernah
memasukkan `.env`, token Telegram, API key, data pengguna nyata, atau credential
lain ke Git maupun ke laporan. Credential dimasukkan lewat login resmi alat,
bukan ditulis di chat, terminal, atau berkas proyek.
