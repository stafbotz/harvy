# ADR-035 — CodingRun Single Writer dan Bukti Completion

- **Status:** Diterima
- **Tanggal:** 11 Agustus 2026
- **Pemilik keputusan:** pemilik produk Harvy
- **Terkait:** ADR-026, ADR-027, ADR-033, ADR-034

## Konteks

Loop coding perlu membaca, mengedit, mengetes, dan menyimpan hasil tanpa
memberi model akses path/lease atau membiarkan worker paralel menulis state
campuran. Exit code saja juga tidak cukup bila command atau instruksi berubah.

## Keputusan

1. Satu `CodingRun` nonterminal menjadi writer project. Semua patch melalui
   engine queue/CAS/budget; worker hanya mendapat view baca yang diserialkan
   terhadap patch multi-file.
2. Binding memuat project, immutable base snapshot, workspace revision, dan
   instruction revision. ChangeSet membuat hasil lama stale; project yang maju
   men-terminalkan run lama agar tidak menjadi zombie.
3. Patch memakai path kanonik dan expected file hash. Rollback yang tidak dapat
   dibuktikan mengarantina working copy.
4. Validator berjalan di sandbox snapshot. Receipt mengikat exact command,
   task brief/acceptance/constraints, instruction revision, working snapshot,
   execution, exit, dan artifact evidence. Sedikitnya satu validator required;
   `not run`, stale, gagal, infrastructure error, secret/binary/generated
   surprise, atau diff di luar limit tidak boleh dirender lulus.
5. Commit workspace memakai durable pending intent. Saat pending, semua mutasi
   lain ditutup. Recovery menunggu writer horizon dan hanya mengakui snapshot
   exact, tidak mengulang efek ambigu.
6. Mapping repository, plan, dan task review adalah evidence durable, bukan
   prose final. Task review mengikat request, objective, acceptance, constraint,
   diff, validator, repository-map, plan, instruction revision, dan snapshot.
7. Executor `workspace.*`, `sandbox.*`, dan `git.*` memakai schema tertutup,
   state token exact, output berbatas, dan hanya menerima
   `WorkspaceAgentScope`. Sandbox executor baru tersedia setelah bounded
   positive health; local-git executor juga baru tersedia setelah bounded
   positive `LocalGitService.health()` dari instance yang sama. Executor GitHub
   sengaja tidak berada pada jalur
   model-callable karena memerlukan confirmation controller tepercaya.
8. Authority Workspace dan antrean ProjectWorkspace adalah critical section
   terstruktur: child re-entrant ditunggu sebelum lock dilepas, descendant yang
   lolos wajib revalidasi, dan repository realm tidak dapat saling meminjam
   guard. Snapshot diserahkan lewat callback single-open selama guard aktif;
   escaped source dan disposal working copy tanpa permission gagal tertutup.
9. `WorkspaceCodingController` hanya menerima handle actor dari resolver
   ingress tepercaya; body tidak boleh membawa scope, role, history, memory,
   atau transcript. `CodingRunCoordinator` memegang admission satu invocation
   per run, membuktikan `code.write` sebelum driver/provider, membuang action
   bila state revision berubah, menyaring metadata kanal, menerapkan budget
   aktif, dan merekonsiliasi pending commit sebelum meminta keputusan baru.
10. Required validator artifact disalin ke evidence store content-addressed
    sebelum lease sandbox dibuang dan diverifikasi ulang saat finalize/recovery.
    Coordinator memakai decision budget kumulatif, pause/resume
    `waiting_input`, exact state fence, dan registri provider in-flight;
    deletion meng-abort lalu menunggu quiescence berbatas sebelum menghapus
    evidence atau record run.
11. Admission coordinator aplikasi adalah immediate dan berbatas; ia tidak
    mengantre `WorkspaceAgentScope` yang dapat menjadi basi. Command membawa
    `expectedStateRevision` yang dicadangkan lewat CAS durable sebelum loop,
    concurrency dibatasi global+per-workspace, dan stop menutup admission serta
    meng-abort invocation aktif. Slot baru dilepas setelah provider asli
    quiescent, bukan ketika client-side abort race selesai. Admission hanya
    boleh dibuka dengan conformance receipt deployment yang masih berlaku;
    health transport saja tidak cukup. Jalur scheduler menahan pending commit
    secara fail-closed; reconciliation barrier tetap memerlukan authority
    recovery terpisah, sedangkan coordinator langsung yang berscope pengguna
    tetap dapat menjalankannya.
12. Supervisor maintenance menjalankan urutan sandbox recovery → satu initial
    pass GitHub unknown → satu initial pass deletion, lalu tetap melaporkan
    coding admission tertutup. Shutdown menyegel scheduler/worker/sandbox,
    men-drain semua caller, lalu men-drain dan menutup sandbox paling akhir.
    Primitive ini single-process dan belum menjadi composition aplikasi.

## Konsekuensi

Fondasi coordinator, scheduler lifecycle, supervisor maintenance, loop tool
iteratif, dan bukti completion ada, tetapi belum ada worker driver,
composition/surface Workspace produksi, verifier conformance deployment,
kalibrasi model/cost budget coding, atau store/lease run multi-instance.
