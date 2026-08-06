# Status — Console dan Control Plane

Verified: 6 Agustus 2026 pada baseline `43d8e16`; HTTP tests dan browser smoke
terisolasi tersedia. Console adalah surface operator localhost, bukan website
pengguna.

## Keadaan saat ini

- Server bind wajib `127.0.0.1` dan memakai token-to-session `HttpOnly`, CSRF,
  Host/Origin checks, CSP/no-CORS, schema/body/rate/version guards, serta audit.
- UI menampilkan provider/model yang dikonfigurasi tanpa key/base URL, usage,
  biaya, request, fallback, grup, enrollment, cohort, package, dan runtime mode.
- Control plane mendukung standard/beta cohort, paket pilot personal/grup,
  quota override, expiry, consent evaluasi, dan mode grup.
- Entitlement reservation dan provider-attempt ledger tersedia satu proses.
  Delivery/discard mengikat debit logical pada owner+turn; physical attempt
  tetap dicatat untuk retry/fallback/gagal.
- Cost report membedakan reported dan estimated dengan provenance/cakupan;
  attempt historis tidak ditulis ulang saat katalog harga berubah.

## Batas dan defect aktif

- Console belum internet-ready: belum ada OIDC/MFA/RBAC/TLS, PostgreSQL,
  outbox/reconciliation, backup-restore drill, atau threat-model deployment.
- Tidak ada subscription, checkout, renewal, invoice, refund, webhook, atau SLA.
- Ledger dan repository tetap file lokal satu proses; billing provider belum
  diuji end-to-end pada kanal nyata.
- Website pengguna belum ada.

## Bukti dan pointer

- Kode: `src/console/`, `src/core/control-plane-service.ts`,
  `src/core/usage-ledger-service.ts`, `src/core/telemetry-service.ts`.
- Tes: `tests/console-server.test.ts`, `tests/control-plane-service.test.ts`,
  `tests/usage-ledger-service.test.ts`, `tests/telemetry-service.test.ts`.
- Keputusan: ADR-013. Operasi: `docs/operations/HARVY_CONSOLE.md`.

