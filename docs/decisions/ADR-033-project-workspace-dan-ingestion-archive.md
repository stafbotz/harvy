# ADR-033 — Project Workspace dan Ingestion Archive

- **Status:** Diterima
- **Tanggal:** 10 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-016, ADR-031, ADR-032

## Konteks

Coding membutuhkan project yang dapat berasal dari upload atau GitHub tanpa
menjadikan folder proses Harvy, archive, maupun metadata `.git` sebagai
authority. Snapshot juga harus dapat direvisi dan di-rollback tanpa menimpa
base yang sedang dipakai run.

## Keputusan

1. `ProjectWorkspace` terpisah dari `WorkspaceRecord`; Workspace tetap container
   ACL, sedangkan project mengikat owner workspace, source, revision, snapshot,
   git state, dan accounting storage.
2. ZIP diparse oleh kode dengan allowlist stored/deflate. Traversal, path
   absolute/ambigu, VCS metadata, collision Unicode/case/Windows, link/special
   file, encryption, Zip64, nested archive by extension/magic, bomb, dan header
   mismatch gagal sebelum snapshot dipromosikan. Archive tidak dieksekusi.
3. Snapshot adalah content-addressed, read-only, diverifikasi ulang terhadap
   manifest sebelum materialisasi, dan working copy selalu terpisah. Commit dan
   rollback membuat revision baru; snapshot lama tidak ditimpa. Artifact upload
   yang sudah dipromosikan juga disimpan tanpa bit tulis.
4. Quota project/owner, jumlah project/revision/staged snapshot, cleanup
   unreferenced snapshot, namespace memory project, ACL freshness, dan CAS
   adalah bagian lifecycle, bukan instruksi model.
5. Storage root wajib absolute dan terpisah dari root proses; parent symlink
   ditolak sebelum operasi terkelola.
6. Penghapusan project menulis tombstone durable sebelum cleanup. Tombstone
   langsung menyembunyikan/memblokir project dan dipertahankan sesudah selesai.
   Saga resumable mem-fence run/provider/sandbox, lalu menghapus evidence,
   record run, metadata GitHub lokal, memory, dan payload dengan urutan exact.
   Pending commit atau efek ambigu menahan cleanup; remote GitHub tidak dihapus.

## Konsekuensi

Project archive dapat dipakai sebagai input data tanpa shell extractor atau
trust pada repository content. Adapter file tetap hanya satu proses; storage
object/transactional production dan ingress pengguna belum dipasang.
