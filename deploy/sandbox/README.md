# Isolated Linux SandboxRunner deployment

Service ini harus dipasang pada host Linux terpisah dari proses Harvy. Host
menjalankan Podman rootless dengan cgroup v2, subordinate UID/GID untuk user
`harvy-sandbox`, dan seccomp profile `containers/common` yang telah diaudit.
Jangan memasang source/data Harvy, Docker socket, credential provider, GitHub,
database, Telegram, atau WhatsApp pada host/service ini.

Build toolchain image dengan base image yang sudah diikat digest, lalu catat
digest image hasil build. Runtime tidak pernah melakukan pull:

```bash
podman build \
  --build-arg BASE_IMAGE=ubuntu@sha256:<verified-digest> \
  -t localhost/harvy-sandbox-toolchain:2026-08-15 \
  -f deploy/sandbox/Containerfile .
podman image inspect localhost/harvy-sandbox-toolchain:2026-08-15 --format '{{.Digest}}'
```

File `/etc/harvy/sandbox-service.env` hanya boleh dibaca root dan memuat
konfigurasi berikut. HMAC adalah credential service-to-service khusus sandbox,
bukan credential Harvy/provider/GitHub.

```text
HARVY_SANDBOX_LISTEN_HOST=10.20.0.12
HARVY_SANDBOX_LISTEN_PORT=8443
HARVY_SANDBOX_PUBLIC_ORIGIN=https://sandbox.internal.example:8443
HARVY_SANDBOX_HMAC_KEY_ID=harvy-control-v1
HARVY_SANDBOX_HMAC_SECRET_FILE=/etc/harvy/secrets/sandbox-hmac.b64url
HARVY_SANDBOX_TLS_KEY_FILE=/etc/harvy/tls/sandbox.key
HARVY_SANDBOX_TLS_CERT_FILE=/etc/harvy/tls/sandbox.crt
HARVY_SANDBOX_DATA_ROOT=/var/lib/harvy-sandbox/runtime
HARVY_SANDBOX_IMAGE=localhost/harvy-sandbox-toolchain@sha256:<built-digest>
HARVY_SANDBOX_SECCOMP_PROFILE=/usr/share/containers/seccomp.json
HARVY_SANDBOX_OCI_COMMAND=podman
HARVY_SANDBOX_TAR_COMMAND=/usr/bin/tar
```

Provision HMAC dengan minimal 32 random byte yang disimpan sebagai base64url.
TLS atau private service mesh wajib untuk listener non-loopback. Harvy baru
boleh memasang capability sandbox sesudah `health` sukses dan live hostile-code
acceptance lulus terhadap endpoint deployment yang sama.

Sebelum acceptance, buat sentinel host yang benar-benar ada tetapi tidak pernah
di-mount ke container. Jalankan acceptance **pada host sandbox yang sama** agar
script dapat membuktikan sentinel itu ada di host sebelum mencoba membacanya
dari project hostile:

```bash
sudo install -d -m 0700 -o harvy-sandbox -g harvy-sandbox /var/lib/harvy-sandbox
openssl rand -base64 48 | sudo tee /var/lib/harvy-sandbox/host-sentinel >/dev/null
sudo chown harvy-sandbox:harvy-sandbox /var/lib/harvy-sandbox/host-sentinel
sudo chmod 0400 /var/lib/harvy-sandbox/host-sentinel
```

Jalankan suite tanpa menyalin credential Harvy/provider/GitHub lain. Keluaran
stdout adalah observation JSON; semua diagnostic tetap di stderr:

```bash
HARVY_SANDBOX_ACCEPTANCE_ORIGIN=https://sandbox.internal.example:8443 \
HARVY_SANDBOX_ACCEPTANCE_HMAC_KEY_ID=harvy-control-v1 \
HARVY_SANDBOX_ACCEPTANCE_HMAC_SECRET_FILE=/run/secrets/sandbox-hmac.b64url \
HARVY_SANDBOX_ACCEPTANCE_HOST_SENTINEL_FILE=/var/lib/harvy-sandbox/host-sentinel \
npm run acceptance:sandbox > sandbox-observation.json
```

Observation hanya sah untuk source suite exact dan maksimum 15 menit. Buat
receipt berumur maksimum tujuh hari, simpan file JSON-nya di control plane, lalu
pin SHA-256 yang dicetak ke stderr sebagai
`HARVY_CODING_CONFORMANCE_RECEIPT_SHA256`:

```bash
npm run conformance:sandbox -- sandbox-observation.json \
  > /etc/harvy/sandbox-conformance-receipt.json
```

Admission coding membandingkan receipt dengan health identity runtime saat
startup. Perubahan HMAC service identity, digest image, kernel, versi Podman,
versi OCI runtime, cgroup manager, atau byte seccomp profile mengubah identity
dan menutup admission sampai suite live dijalankan ulang. Receipt tidak boleh
dibuat manual atau digunakan setelah deployment berubah.

Network container selalu `none`. Dependency fetch bukan bagian service ini dan
harus memakai capability broker terpisah dengan artifact content-addressed.
