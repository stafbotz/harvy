# Peta Dokumentasi Harvy

Dokumen ini adalah peta, bukan daftar bacaan wajib. Jangan memuat seluruh folder
`docs/` ke konteks. Baca Work Order terlebih dahulu, lalu pilih dokumen sesuai
kolom **Baca ketika**.

| Dokumen | Baca ketika | Kewenangan |
|---|---|---|
| [`PROJECT.md`](PROJECT.md) | Mengubah tujuan produk, kanal, backlog, atau batas MVP | Keputusan produk saat ini |
| [`engineering/TESTING.md`](engineering/TESTING.md) | Melakukan `BUILD`, `REVIEW`, atau `QA` | Gerbang verifikasi |
| [`operations/ORCHESTRATION.md`](operations/ORCHESTRATION.md) | Menetapkan peran, branch, handoff, review, atau kerja paralel | Protokol kerja |
| [`decisions/ADR-001-agent-orchestration.md`](decisions/ADR-001-agent-orchestration.md) | Mengusulkan perubahan pada sistem orkestrasi | Alasan keputusan permanen |
| [`work-orders/TEMPLATE.md`](work-orders/TEMPLATE.md) | Membuat paket kerja baru | Format Work Order |
| [`work-orders/WO-001-setup-orchestration.md`](work-orders/WO-001-setup-orchestration.md) | Meninjau setup orkestrasi awal | Paket setup pertama |
| [`../README.md`](../README.md) | Menjalankan atau mencoba Harvy v0.1 | Panduan penggunaan lokal |

## Urutan pencarian konteks

1. `AGENTS.md`.
2. Work Order yang disebutkan dalam permintaan.
3. Baris relevan dalam peta ini.
4. Kode, tes, dan konfigurasi yang benar-benar terkait.
5. Dokumentasi resmi versi dependency atau layanan yang digunakan, hanya bila
   informasi lokal belum cukup.

Jika dokumen dan kode bertentangan, jangan diam-diam memilih salah satunya.
Untuk perbedaan yang memengaruhi kriteria penerimaan, berhenti dan tanyakan
orkestrator. Untuk perbedaan kecil, ikuti perilaku yang sudah teruji dan catat
dalam handoff.
