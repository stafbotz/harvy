# Harvy Agent Entry Point

Instruksi ini berlaku untuk Codex, Claude Code, Antigravity, dan coding agent
lain yang bekerja di repositori Harvy, sekaligus untuk manusia yang baru
bergabung.

## Kontrak

1. **Baca konteks sebelum menjawab apa pun.** Konteks diambil dari repositori,
   bukan dari ingatan atau dugaan. Lihat § Konteks Wajib dan § Rute Konteks.
2. **Jangan mengklaim apa pun yang belum diperiksa.** Kalau sebuah kemampuan
   tidak tercatat di `docs/engineering/STATUS.md` dan tidak terlihat di kode,
   katakan "belum diperiksa".
3. **Tulis entri `docs/LOG.md` sebelum sesi berakhir** — termasuk sesi yang
   hanya berdiskusi. `.githooks/pre-commit` menolak commit yang menyentuh
   `src/`, `tests/`, `docs/`, `AGENTS.md`, atau `README.md` tanpa perubahan
   pada `docs/LOG.md`. Aktifkan sekali per clone:
   ```bash
   git config core.hooksPath .githooks
   ```
   Lewati dengan `git commit --no-verify` hanya bila commit memang tidak layak
   dicatat. Latar belakang kontrak ini: `ADR-002`, `ADR-004`.

## Konteks wajib

Selalu baca sebelum bekerja:

| Apa | Dokumen |
|---|---|
| Yang dikerjakan terakhir kali | `docs/LOG.md` (~15 entri terbaru) |
| Yang sudah benar-benar berjalan | `docs/engineering/STATUS.md` |

## Rute konteks

Baca **hanya** dokumen yang relevan dengan tugas saat ini:

| Menyentuh | Baca |
|---|---|
| Perilaku produk, visi, roadmap | `docs/PROJECT.md` |
| Privasi, keselamatan, hak pengguna | `docs/CONSTITUTION.md` (hierarki tertinggi) |
| Arsitektur, modul baru, aliran data | `docs/engineering/ARCHITECTURE.md` |
| Mutasi, safety, adapter, UI, grup | `docs/engineering/INVARIANTS.md` |
| Setup, debug, env config, probe | `docs/engineering/DEVELOPMENT.md` |
| Menulis tes, evaluator, bukti | `docs/engineering/TESTING.md` |
| Branch, commit, alur serah-terima | `docs/operations/WORKFLOW.md` |

`docs/INDEX.md` memetakan sisanya termasuk 18 ADR. Jangan memuat seluruh
`docs/`. Jika dokumentasi berbeda dari kode, ikuti kode dan laporkan.

## Kepemilikan dan ruang lingkup

- Pengguna Harvy menguasai tujuan, ruang lingkup, dan penerimaan akhir.
- Satu penulis aktif pada satu waktu; reviewer tidak ikut mengedit.
- Jangan mendelegasikan edit ke agent lain atau bekerja paralel menulis file,
  kecuali diminta.
- Commit langsung pada branch aktif termasuk `main`; branch/PR opsional.
  Push hanya bila diminta.
- Kerjakan yang diminta sampai tuntas, lalu berhenti. Ketika diminta berdiskusi,
  jangan mengubah file. Ketika diminta meninjau, jangan memperbaiki sendiri.
- Perbarui tes dan dokumentasi yang ikut berubah, termasuk
  `docs/engineering/STATUS.md` bila kemampuannya bergeser.

## Quick ref

```bash
npm ci                 # instal dari lockfile
npm run check          # tsc --noEmit, gerbang tipe
npm test               # build lalu node --test dist/tests/*.test.js
npm run build          # tsc ke dist/
npm run dev            # hot reload; perlu .env
npm start              # jalankan hasil build
```

Detail lengkap: `docs/engineering/DEVELOPMENT.md`.

## Gerbang selesai

1. Perubahan terlihat pada diff.
2. `npm run check` dan `npm test` dijalankan, hasilnya dicatat.
3. Keterangan jujur tentang apa yang **tidak** diuji.
4. Satu entri baru di `docs/LOG.md`.

Detail dan batas teknis: `docs/operations/WORKFLOW.md`.
