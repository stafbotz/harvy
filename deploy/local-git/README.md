# Credentialless local-git service

Service ini menyimpan snapshot, object Git, commit, tree, dan bundle exact. Ia
tidak mempunyai remote URL, PAT, GitHub App key, installation token, provider
key, database credential, atau API generic untuk menjalankan command model.
Semua subprocess memakai argv terstruktur dan hanya command Git code-owned.

Konfigurasi minimum:

```text
HARVY_LOCAL_GIT_LISTEN_HOST=10.20.0.13
HARVY_LOCAL_GIT_LISTEN_PORT=8444
HARVY_LOCAL_GIT_PUBLIC_ORIGIN=https://local-git.internal.example:8444
HARVY_LOCAL_GIT_HMAC_KEY_ID=harvy-control-v1
HARVY_LOCAL_GIT_HMAC_SECRET_FILE=/etc/harvy/secrets/local-git-hmac.b64url
HARVY_LOCAL_GIT_TLS_KEY_FILE=/etc/harvy/tls/local-git.key
HARVY_LOCAL_GIT_TLS_CERT_FILE=/etc/harvy/tls/local-git.crt
HARVY_LOCAL_GIT_DATA_ROOT=/var/lib/harvy-local-git/runtime
HARVY_LOCAL_GIT_COMMAND=/usr/bin/git
```

Data volume harus durable dan memiliki quota. Untuk multi-instance, hanya satu
instance boleh memiliki volume ini sampai distributed lease/CAS backend
dipasang; composition Harvy tetap menolak status horizontal-safe sebelumnya.
