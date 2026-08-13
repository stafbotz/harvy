# Status — WhatsApp Grup

Verified: 13 Agustus 2026 pada working tree fondasi Group AgentRun Phase K di
atas `e6d7fbf`; hasil gerbang terbaru dicatat di `docs/LOG.md`. Bukti kanal
nyata tetap sempit.

## Keadaan saat ini

- Baileys menyediakan fondasi beta grup terpisah dari state privat Telegram.
  Direct, ambient, membership lifecycle, binding, batching, dan generation
  guard tersedia.
- Metadata membership pengirim dan Harvy harus segar sebelum ingress diterima;
  core melakukan revalidation sebelum binding atau mutasi. Observation authority
  async diserialkan per runtime; hanya observation authorized/live yang boleh
  menaikkan revision atau menyupersesi ambient. Alias default maupun durable
  dihidrasi sebelum admission, termasuk cold start, dan observation yang
  sengaja ditolak menutup watermark hanya pada generation yang sama.
- Direct/ambient memakai fallback settle 350 ms/1,2 detik lalu p90 gap
  content-free per `scope+account+participant` setelah tiga sampel, termasuk
  antar-batch yang sudah ter-flush; speaker switch memutus sampel A→B→A.
  Profile hanya di RAM, berbatas, ber-TTL, dan dibersihkan saat scope diinvalidasi.
  Direct tetap membatalkan kandidat ambient; ambient tetap revalidate terhadap
  quiet gap, freshness, dan human-flow policy. Mode runtime efektif diperiksa
  lagi sebelum model revalidation, fixed ACK, dan delivery; work lama
  dibatalkan bila admission terbaru bukan `process`. Emergency eksplisit tetap
  menjadi pengecualian yang diizinkan pada `direct_only`.
- Core membuktikan membership, binding account aktif, dan notice live sebelum
  assessment model. Direct memakai ingress compiler; ambient menggabungkan
  `riskHint` dan `contextPrivacy` dengan planner. Ordinary melewati triage,
  sedangkan hint possible/strong, compiler unavailable, marker continuation,
  dan emergency lokal memakai acute triage evidence-aware.
- Raw message/reply hanya masuk context dua jam ketika privacy ordinary dan
  safety calm+certain. Memori durable memakai classifier privacy candidate-only
  yang terpisah. Support pasti tidak membayar reviewer kedua; danger dan
  support tidak pasti tetap review fail-closed.
- Emergency lokal berpresisi tinggi melewati debounce, reservation/dedupe, dan
  fixed ACK-nya dapat keluar sebelum FIFO setelah authority+binding+notice.
  ACK dan assessment memakai reservation terpisah; emergency acute triage tidak
  menunggu ingress/memory extraction, sementara full turn lintas speaker tetap
  FIFO. Emergency ambient tetap mendapat final reviewed safety reply ketika
  triage unavailable/tidak mengonfirmasi danger. Assessment prioritas berbatas
  empat aktif+32 queued dan dibatalkan oleh
  generation/AbortSignal. Paket `direct_only` tetap menerima emergency tanpa
  tag; `disabled/paused` tidak memprosesnya.
- Member-local memory dan shared room memory ada di core dengan authority guard,
  preview/confirmation, retensi, dan kontrol member/admin. Rollback delivery
  lengkap hanya untuk record member/room yang baru dibuat.
- Fondasi core Group AgentRun terpisah menyimpan scope+account, initiator,
  participant/audience group-safe, anchor/question reference, input
  teratribusi, ChangeSet, event, revision, dan expiry. Policy lokal menolak
  ambient serta mixed bubble, membedakan self-info/proposal/control, mengikat
  assigned answer dan override admin eksplisit, menyisakan slot cancel, serta
  menegakkan satu foreground per grup melalui CAS serta menolak replay lintas
  account. Anchor tidak auto-pin.
- `WHATSAPP_ACCOUNTS` mendukung beberapa alias account satu proses, masing-masing
  dengan auth folder, socket, cache, reconnect, generation, dan queue sendiri.
- Satu nomor nyata pernah QR/login/`open` dan membalas satu jalur dasar.

## Batas dan defect aktif

- Notice/privacy terbaru, memory member/room, timing ambient, removal, safety,
  dan shutdown belum diuji end-to-end di grup nyata.
- Dua nomor nyata sekaligus belum diuji. Tidak ada failover atau rebind otomatis
  antar-account.
- Pending confirmation dan authority epoch grup tidak durable lintas restart.
- Group AgentRun belum dirangkai ke `GroupTurnService`, Baileys, notice,
  entitlement, model/work lane, startup/shutdown, atau transport. Adapter file
  hanya satu proses; anchor/question belum mempunyai outbox/receipt sehingga
  crash antara delivery dan binding belum dapat direkonsiliasi. Purge expiry
  tersedia tetapi belum dijadwalkan pada composition root.
- Edit, delete, reset, alias, dan self-delete belum mempunyai kompensasi generik
  bila acknowledgment gagal sesudah mutasi commit.
- Store sosial legacy masih memakai PN/LID mentah untuk bridging; semantic
  record baru memakai alias hash scoped. Account linking lintas kanal belum ada.
- Satu stream grup belum mempunyai conversation disentanglement sempurna dan
  quote kandidat dapat hilang saat cache Baileys kedaluwarsa.
- Adaptive timing, selective safety/privacy, emergency ACK, dan authority-first
  preflight belum diuji di grup nyata.

## Bukti dan pointer

- Kode: `src/whatsapp/`, `src/core/group-turn-service.ts`,
  `src/core/group-memory-service.ts`, `src/core/group-authority-policy.ts`,
  `src/core/group-agent-run-service.ts`, `src/core/group-agent-run-policy.ts`,
  `src/domain/group-agent-run.ts`, `src/storage/file-group-agent-run-repository.ts`,
  `src/bot/group-run-anchor.ts`, `src/ai/group-ingress.ts`,
  `src/core/group-runtime-policy.ts`, `src/whatsapp/group-message-batcher.ts`.
- Tes: `tests/baileys-account-manager.test.ts`,
  `tests/group-conversation.test.ts`, `tests/group-turn-service.test.ts`,
  `tests/group-memory-service.test.ts`, `tests/group-ingress.test.ts`,
  `tests/group-runtime-policy.test.ts`, `tests/group-message-batcher.test.ts`,
  `tests/group-agent-run-policy.test.ts`, `tests/group-agent-run-service.test.ts`,
  dan `tests/group-run-anchor.test.ts`.
- Keputusan: ADR-009, ADR-011, ADR-016, ADR-023, ADR-024, ADR-037.
