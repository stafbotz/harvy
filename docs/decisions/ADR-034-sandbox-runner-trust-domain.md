# ADR-034 — SandboxRunner sebagai Trust Domain Terpisah

- **Status:** Diterima
- **Tanggal:** 11 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-012, ADR-016, ADR-026, ADR-033

## Konteks

Menjalankan kode repository tidak aman di proses Harvy atau melalui terminal
virtual. Environment pengembangan saat keputusan ini tidak mempunyai backend
container yang dapat membuktikan isolasi nyata.

## Keputusan

1. `SandboxRunner` adalah port ke trust domain `isolated-linux`; tidak ada
   fallback `child_process`, host temp directory, atau `VirtualTerminal`.
2. Harvy membentuk binding owner+project+snapshot+workspace revision+run dan
   argv terstruktur. Model tidak memilih host root, mount, credential, atau
   network policy.
3. Network default `off`; unprivileged user, read-only root, dropped capability,
   syscall filter, no host/Harvy/secret/Docker-socket mount, CPU/memory/disk/PID,
   wall clock, output, artifact, admission, dan lease horizon wajib dibuktikan
   backend serta divalidasi client.
4. Backend unavailable gagal tertutup. Capability hanya boleh `installed` bila
   backend nyata lolos conformance fixture berbahaya dan scheduling global.
5. Lifecycle lease adalah write-ahead state machine durable:
   `allocating → active|quarantined|disposing`, lalu
   `active → quarantined|disposing` dan `quarantined → disposing`. Intent
   `allocating` harus
   committed sebelum transport dipanggil; startup tidak me-reattach lease lama,
   melainkan memasang cancellation fence untuk seluruh record terbuka. Record
   baru boleh dihapus setelah exact `cancelAndDispose` ACK. ACK journal yang
   hilang sesudah commit harus direkonsiliasi dari store sebelum backend boleh
   dipakai lagi.
6. `SqliteSandboxLeaseJournal` dengan transaksi lintas proses dan
   `synchronous=FULL` adalah adapter lokal yang disiapkan untuk jalur live.
   Journal JSON rename tetap hanya adapter restart lokal; pada Windows ia tidak
   dapat membuktikan fsync metadata direktori ketika host mengembalikan `EPERM`.
7. Snapshot masuk lewat bundle versioned content-addressed yang tidak membawa
   host path atau mount. Transport wajib mengonsumsi seluruh byte sesuai
   descriptor. Setiap execute memakai operation ID + request digest code-owned;
   result wajib menggemakan keduanya. Artifact keluar hanya melalui stream
   berbatas yang diverifikasi size dan SHA-256 terhadap descriptor exact lease.
8. Client HTTP trust-domain memakai origin+audience tetap, path/method tertutup,
   no redirect, proof HMAC service-bound atas envelope+konten, response cap,
   exact echo, dan streaming size+hash. HTTP loopback hanya fixture dev dan
   tidak boleh menjadi dasar `installed: true`; backend live tetap memerlukan
   identitas service serta conformance isolasi positif.
9. Source snapshot dan argv diperiksa sebelum callback/transport; path atau isi
   yang dikenal sensitif maupun menyerupai credential ditolak tanpa menyalin
   nama/nilai tersebut ke error. Ini defense-in-depth, bukan bukti bahwa semua
   bentuk secret arbitrer atau encoded dapat dikenali.
10. Runtime memakai lifecycle eksplisit. `start` menuntaskan recovery journal
    sebelum health/readiness; `stop` menutup admission sinkron; `drain` menunggu
    operasi yang sudah diterima lalu mem-fence semua record; `close` baru
    menutup journal setelah drain kosong. Kegagalan fence mempertahankan record
    `disposing` dan menggagalkan shutdown bersih agar ID exact dapat di-retry.

## Konsekuensi

Policy/client contract, transfer konten, artifact verification, dan recovery
durable dapat diuji tanpa mengarang host isolation. Implementasi rootless OCI,
service terpisah, deployment unit, 15-scenario hostile harness, receipt
generator, serta composition gate kini tersedia. Phase H live tetap belum
diterima sampai harness itu lulus pada host Linux+image+seccomp exact;
watchdog/AbortSignal client atau test fake bukan bukti worker sudah quiescent
dan bukan pengganti streaming cap/cgroup/seccomp backend.
