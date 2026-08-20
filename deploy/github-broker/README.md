# GitHub App Broker deployment contract

Service ini adalah trust domain terpisah. Ia satu-satunya proses Harvy yang
membaca private key dan client secret GitHub App. Jangan jalankan service ini
dengan environment proses Harvy, credential provider, session WhatsApp,
credential database, `GITHUB_TOKEN`, atau `GH_TOKEN`.

GitHub App wajib dikonfigurasi dengan:

- callback URL exact `https://<broker-callback>/v1/github-app/callback`;
- **Request user authorization (OAuth) during installation** aktif;
- repository permission `Metadata: read`, `Contents: read/write`, dan
  `Pull requests: read/write`;
- `Workflows: read/write` hanya jika capability perubahan workflow ingin
  diaktifkan;
- repository selection oleh installer (bukan akses seluruh GitHub secara
  implisit);
- tidak ada permission administration, members, actions secrets, environments,
  atau repository deletion.

Harvy control plane mengakses RPC broker melalui TLS dan HMAC service identity.
Endpoint callback OAuth bersifat publik tetapi hanya menerima `GET` dengan
`state`, one-time `code`, `installation_id`, dan `setup_action`. Broker menukar
code menjadi user access token sementara, membuktikan user tersebut dapat
mengakses installation, memvalidasi installation terhadap App JWT, lalu
membuang user token. Installation token hanya disimpan di memory sampai sebelum
expiry dan dimintakan ulang dengan exact repository/permission subset.

File environment minimal:

```text
HARVY_GITHUB_BROKER_DATA_ROOT=/var/lib/harvy-github-broker
HARVY_GITHUB_APP_ID=<numeric app id>
HARVY_GITHUB_APP_SLUG=<app slug>
HARVY_GITHUB_APP_CLIENT_ID=<client id>
HARVY_GITHUB_APP_CLIENT_SECRET_FILE=/etc/harvy/secrets/github-client-secret
HARVY_GITHUB_APP_PRIVATE_KEY_FILE=/etc/harvy/secrets/github-app.pem
HARVY_GITHUB_APP_STATE_SECRET_FILE=/etc/harvy/secrets/github-state-secret.base64url
HARVY_GITHUB_APP_CALLBACK_URL=https://github-broker.example/v1/github-app/callback
HARVY_GITHUB_BROKER_HMAC_KEY_ID=harvy-control-plane-v1
HARVY_GITHUB_BROKER_HMAC_SECRET_FILE=/etc/harvy/secrets/github-rpc-hmac.base64url
HARVY_GITHUB_BROKER_RPC_LISTEN_HOST=127.0.0.1
HARVY_GITHUB_BROKER_RPC_LISTEN_PORT=8445
HARVY_GITHUB_BROKER_CALLBACK_LISTEN_HOST=0.0.0.0
HARVY_GITHUB_BROKER_CALLBACK_LISTEN_PORT=8446
HARVY_GITHUB_BROKER_CALLBACK_PUBLIC_ORIGIN=https://github-broker.example
HARVY_GITHUB_BROKER_CALLBACK_TLS_KEY_FILE=/etc/harvy/tls/github-broker.key
HARVY_GITHUB_BROKER_CALLBACK_TLS_CERT_FILE=/etc/harvy/tls/github-broker.crt
```

Secret file HMAC/state berisi sedikitnya 32 random bytes dalam base64url.
Private key, client secret, user token, dan installation token tidak boleh
masuk ke Harvy data root, sandbox, local-git service, model prompt, log, atau
receipt.

Publish v1 menggunakan Git database REST: broker memverifikasi bundle/commit,
mengunggah object content-addressed, mengecek target head, lalu melakukan ref
update dengan `force: false`. Hanya `harvy/*` yang diterima. PR selalu draft.
Direct main push, force push, merge, repository settings, remote delete, dan
generic REST proxy tidak tersedia pada protocol.

## Live acceptance pada repository non-kritis

Jalankan hanya terhadap repository disposable yang sudah dipasang ke App.
Pilih satu file kecil yang memang boleh diubah dan hitung SHA-256 byte awalnya.
Runner ini tidak menerima PAT/App key/provider key. Ia hanya memakai identity
HMAC untuk broker dan local-git trust domain, lalu meninggalkan satu branch
`harvy/live-acceptance-*` dan satu draft PR sebagai evidence; remote delete
sengaja tidak tersedia.

```text
HARVY_GITHUB_ACCEPTANCE_CONFIRM=CREATE_NONCRITICAL_DRAFT_PR
HARVY_GITHUB_ACCEPTANCE_BROKER_ORIGIN=https://github-broker.internal:8445
HARVY_GITHUB_ACCEPTANCE_BROKER_HMAC_KEY_ID=harvy-control-plane-v1
HARVY_GITHUB_ACCEPTANCE_BROKER_HMAC_SECRET_FILE=/run/secrets/github-rpc-hmac.base64url
HARVY_GITHUB_ACCEPTANCE_LOCAL_GIT_ORIGIN=https://local-git.internal:8444
HARVY_GITHUB_ACCEPTANCE_LOCAL_GIT_HMAC_KEY_ID=harvy-control-plane-v1
HARVY_GITHUB_ACCEPTANCE_LOCAL_GIT_HMAC_SECRET_FILE=/run/secrets/local-git-hmac.base64url
HARVY_GITHUB_ACCEPTANCE_OWNER_WORKSPACE_KEY=<opaque workspace key already installed>
HARVY_GITHUB_ACCEPTANCE_INSTALLATION_ID=<numeric installation id>
HARVY_GITHUB_ACCEPTANCE_REPOSITORY_ID=<numeric disposable repository id>
HARVY_GITHUB_ACCEPTANCE_REPOSITORY_FULL_NAME=<owner/repository>
HARVY_GITHUB_ACCEPTANCE_RUN_LABEL=20260815-a1
HARVY_GITHUB_ACCEPTANCE_TARGET_PATH=acceptance/marker.txt
HARVY_GITHUB_ACCEPTANCE_EXPECTED_BEFORE_SHA256=<exact sha256>
HARVY_GITHUB_ACCEPTANCE_NEW_CONTENT_FILE=/run/acceptance/new-marker.txt
```

Kemudian jalankan `npm run acceptance:github`. Output JSON mengikat archive,
snapshot sebelum/sesudah, exact commit, effect IDs, branch, dan draft PR.
Runner juga mengirim satu synthetic stale-base effect dan membuktikan branch
untuk effect tersebut tidak tercipta. Status live hanya boleh dinaikkan setelah
URL/commit pada output diperiksa dari sisi GitHub.
