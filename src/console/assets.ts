export const CONSOLE_HTML = `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f5f6f2">
  <title>Harvy Console</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <a class="skip-link" href="#main-content">Lewati ke konten utama</a>

  <main id="login-view" class="login-shell">
    <section class="login-brand" aria-labelledby="login-title">
      <div class="brand-mark" aria-hidden="true">H</div>
      <p class="eyebrow">HARVY · CONTROL PLANE LOKAL</p>
      <h1 id="login-title">Kelola Harvy dengan konteks yang jernih.</h1>
      <p class="login-copy">Kanal, biaya, penggunaan model, akses beta, dan audit operator berada di satu tempat—tanpa menyimpan isi percakapan di Console.</p>
      <div class="trust-list" aria-label="Batas Console">
        <span>Loopback saja</span><span>Tanpa isi chat</span><span>Sesi terbatas</span>
      </div>
    </section>
    <section class="login-card" aria-labelledby="login-form-title">
      <p class="eyebrow">AKSES OPERATOR</p>
      <h2 id="login-form-title">Masuk ke Console</h2>
      <p>Gunakan <code>HARVY_CONSOLE_TOKEN</code> dari konfigurasi lokal. Token baru hanya dicetak sekali bila belum dikonfigurasi.</p>
      <form id="login-form">
        <label for="operator-token">Token operator</label>
        <input id="operator-token" type="password" autocomplete="current-password" required autofocus>
        <button id="login-submit" type="submit">Masuk dengan aman</button>
      </form>
      <p id="login-error" class="form-error" role="alert"></p>
      <p class="fineprint">Console hanya menerima koneksi dari perangkat ini melalui <code>127.0.0.1</code>.</p>
    </section>
  </main>

  <div id="app-view" class="app-shell hidden">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="brand-mark small" aria-hidden="true">H</div>
        <div><strong>Harvy</strong><span>Console</span></div>
      </div>
      <nav id="console-tabs" class="nav-tabs" role="tablist" aria-label="Bagian Console" aria-orientation="vertical">
        <button id="nav-overview" class="active" role="tab" aria-selected="true" aria-controls="tab-overview" tabindex="0" data-tab="overview"><span aria-hidden="true">⌂</span>Ringkasan</button>
        <button id="nav-channels" role="tab" aria-selected="false" aria-controls="tab-channels" tabindex="-1" data-tab="channels"><span aria-hidden="true">⇄</span>Kanal</button>
        <button id="nav-compute" role="tab" aria-selected="false" aria-controls="tab-compute" tabindex="-1" data-tab="compute"><span aria-hidden="true">▣</span>Komputer kerja</button>
        <button id="nav-github" role="tab" aria-selected="false" aria-controls="tab-github" tabindex="-1" data-tab="github"><span aria-hidden="true">⑂</span>GitHub</button>
        <button id="nav-access" role="tab" aria-selected="false" aria-controls="tab-access" tabindex="-1" data-tab="access"><span aria-hidden="true">◇</span>Akses</button>
        <button id="nav-groups" role="tab" aria-selected="false" aria-controls="tab-groups" tabindex="-1" data-tab="groups"><span aria-hidden="true">◎</span>Grup</button>
        <button id="nav-plans" role="tab" aria-selected="false" aria-controls="tab-plans" tabindex="-1" data-tab="plans"><span aria-hidden="true">▤</span>Paket</button>
        <button id="nav-prices" role="tab" aria-selected="false" aria-controls="tab-prices" tabindex="-1" data-tab="prices"><span aria-hidden="true">$</span>Harga model</button>
        <button id="nav-usage" role="tab" aria-selected="false" aria-controls="tab-usage" tabindex="-1" data-tab="usage"><span aria-hidden="true">↗</span>Penggunaan</button>
        <button id="nav-audit" role="tab" aria-selected="false" aria-controls="tab-audit" tabindex="-1" data-tab="audit"><span aria-hidden="true">✓</span>Audit</button>
      </nav>
    </aside>

    <main id="main-content" class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">Harvy Console</p>
          <h1 id="page-title">Ringkasan</h1>
          <p id="page-description" class="page-description">Kesehatan dan biaya operasional dalam 24 jam terakhir.</p>
        </div>
        <div class="top-actions">
          <div class="sync-state">
            <span id="health" class="status-badge neutral">Memeriksa</span>
            <span id="last-updated">Belum disegarkan</span>
          </div>
          <button id="refresh" class="icon-button" type="button" aria-label="Segarkan data" title="Segarkan data">↻</button>
          <button id="logout" class="ghost compact" type="button">Keluar</button>
        </div>
      </header>

      <nav id="setup-section-nav" class="setup-section-nav hidden" aria-label="Tahap konfigurasi Harvy">
        <button class="active" type="button" data-setup-tab="channels"><span>01</span><strong>Kanal</strong><small>Telegram dan WhatsApp</small></button>
        <button type="button" data-setup-tab="compute"><span>02</span><strong>Komputer kerja</strong><small>Sandbox Linux dan Git lokal</small></button>
        <button type="button" data-setup-tab="github"><span>03</span><strong>GitHub</strong><small>App, broker, dan callback</small></button>
      </nav>

      <div id="loading-bar" class="loading-bar hidden" role="progressbar" aria-label="Memuat data Console"></div>
      <div id="notice" class="notice hidden" role="status" aria-live="polite"></div>
      <div id="global-error" class="error-banner hidden" role="alert">
        <div><strong>Data belum berhasil dimuat.</strong><span id="global-error-text"></span></div>
        <button id="retry-load" class="ghost compact" type="button">Coba lagi</button>
      </div>

      <section id="tab-overview" class="tabpanel" role="tabpanel" aria-labelledby="nav-overview">
        <div class="period-label">24 JAM TERAKHIR</div>
        <div id="summary-cards" class="summary-grid" aria-live="polite"></div>
        <div id="cost-banner" class="cost-banner hidden"></div>
        <article class="panel economy-panel" aria-labelledby="economy-title">
          <div class="panel-head"><div><p class="kicker">HARVY COMPUTE</p><h2 id="economy-title">Entitlement dan funding</h2><p>Ringkasan content-free untuk rekonsiliasi operator; raw credential dan transcript tidak pernah ditampilkan.</p></div></div>
          <div id="economy-summary" class="usage-summary" aria-live="polite"></div>
          <p id="economy-detail" class="economy-note"></p>
        </article>
        <div class="content-grid two">
          <article class="panel">
            <div class="panel-head"><div><p class="kicker">AKSES</p><h2>Beta dan standar</h2></div></div>
            <div id="cohort-breakdown"></div>
          </article>
          <article class="panel">
            <div class="panel-head"><div><p class="kicker">PAKET</p><h2>Distribusi penggunaan</h2></div></div>
            <div id="plan-breakdown"></div>
          </article>
        </div>
        <details class="panel diagnostics">
          <summary>Diagnostik request dan entitlement</summary>
          <div id="diagnostic-metrics" class="diagnostic-grid"></div>
        </details>
      </section>

      <section id="tab-channels" class="tabpanel hidden" role="tabpanel" aria-labelledby="nav-channels">
        <div class="channel-environment-nav">
          <div class="channel-environment-tabs" role="tablist" aria-label="Jenis kanal Harvy">
            <button id="channel-environment-service" class="channel-environment-tab active" type="button" role="tab" aria-selected="true" aria-controls="channel-environment-service-panel" data-channel-environment="service">
              <span><strong>Layanan</strong><small>Kanal yang digunakan pengguna</small></span>
              <span id="service-tab-status" class="badge">Memeriksa</span>
            </button>
            <button id="channel-environment-testing" class="channel-environment-tab" type="button" role="tab" aria-selected="false" aria-controls="channel-environment-testing-panel" data-channel-environment="testing">
              <span><strong>Pengujian</strong><small>Akun terpisah untuk menguji build</small></span>
              <span id="testing-tab-status" class="badge">Memeriksa</span>
            </button>
          </div>
          <button id="channels-refresh" class="ghost compact refresh-action" type="button"><span aria-hidden="true">↻</span> Periksa koneksi</button>
        </div>

        <div class="channel-environments">
          <section id="channel-environment-service-panel" class="channel-environment-view active" role="tabpanel" aria-labelledby="channel-environment-service">
            <section class="environment-card primary-environment" aria-labelledby="primary-environment-title">
              <header class="environment-head">
                <span class="environment-kind">Kanal pengguna</span>
                <span id="primary-environment-status" class="badge">Memeriksa</span>
              </header>
              <div class="environment-title">
                <h3 id="primary-environment-title">Kanal layanan</h3>
                <p id="primary-config-source">Memeriksa sumber konfigurasi tanpa membuka credential.</p>
              </div>
              <div class="environment-connections">
                <div class="environment-row">
                  <div class="channel-symbol telegram-symbol" aria-hidden="true">TG</div>
                  <div><strong>Telegram</strong><p id="primary-telegram-detail">Memeriksa konfigurasi tanpa membaca token.</p></div>
                  <span id="primary-telegram-status" class="badge">Memeriksa</span>
                </div>
                <div class="environment-row">
                  <div class="channel-symbol whatsapp-symbol" aria-hidden="true">WA</div>
                  <div><strong>WhatsApp</strong><p id="primary-whatsapp-detail">Memeriksa deklarasi akun tanpa menampilkan nomor.</p></div>
                  <span id="primary-whatsapp-status" class="badge">Memeriksa</span>
                </div>
              </div>
              <footer class="environment-footer">
                <p>Perubahan di sini memengaruhi kanal yang digunakan pengguna.</p>
                <button id="primary-manage-open" class="ghost compact" type="button">Kelola kanal</button>
              </footer>
            </section>
          </section>

          <section id="channel-environment-testing-panel" class="channel-environment-view" role="tabpanel" aria-labelledby="channel-environment-testing" hidden>
            <section id="channel-readiness" class="channel-readiness" aria-labelledby="channel-readiness-title" aria-live="polite">
              <div class="readiness-state">
                <span id="channel-readiness-mark" class="readiness-mark" aria-hidden="true">·</span>
                <div>
                  <p id="channel-readiness-label" class="readiness-label">Memeriksa kanal</p>
                  <h2 id="channel-readiness-title">Menyiapkan status pengujian</h2>
                  <p id="channel-readiness-detail">Console sedang memastikan seluruh akun pengujian tersedia.</p>
                </div>
              </div>
            </section>

            <section class="environment-card acceptance-environment" aria-labelledby="acceptance-environment-title">
              <header class="environment-head">
                <span class="environment-kind test">Akun terpisah</span>
                <span id="setup-progress-badge" class="badge warn">0 dari 4 siap</span>
              </header>
              <div class="environment-title">
                <h3 id="acceptance-environment-title">Koneksi pengujian</h3>
                <p>Penguji berbicara kepada Harvy melalui akun yang terpisah dari layanan.</p>
              </div>
              <div class="acceptance-routes">
                <article id="telegram-route" class="connection-row">
                  <div class="channel-symbol telegram-symbol" aria-hidden="true">TG</div>
                  <div class="connection-copy">
                    <strong>Telegram</strong>
                    <div class="route-map"><span><small>PENGUJI</small><b>Akun Telegram</b></span><i aria-hidden="true">→</i><span><small>HARVY</small><b>Bot Telegram</b></span></div>
                  </div>
                  <div class="connection-actions"><span id="telegram-route-status" class="connection-status">Memeriksa</span><button id="telegram-manage-open" class="ghost compact" type="button">Kelola</button></div>
                </article>
                <article id="whatsapp-route" class="connection-row">
                  <div class="channel-symbol whatsapp-symbol" aria-hidden="true">WA</div>
                  <div class="connection-copy">
                    <strong>WhatsApp</strong>
                    <div class="route-map"><span><small>PENGUJI</small><b>Akun WhatsApp</b></span><i aria-hidden="true">→</i><span><small>HARVY</small><b>Akun WhatsApp</b></span></div>
                  </div>
                  <div class="connection-actions"><span id="whatsapp-route-status" class="connection-status">Memeriksa</span><button id="whatsapp-manage-open" class="ghost compact" type="button">Kelola</button></div>
                </article>
              </div>
              <ol class="setup-checklist" aria-label="Progres koneksi pengujian">
                <li id="setup-step-telegram-bot"><span>1</span>Harvy Telegram</li>
                <li id="setup-step-telegram-tester"><span>2</span>Penguji Telegram</li>
                <li id="setup-step-whatsapp-harvy"><span>3</span>Harvy WhatsApp</li>
                <li id="setup-step-whatsapp-tester"><span>4</span>Penguji WhatsApp</li>
              </ol>
              <div class="setup-progress-track" aria-hidden="true"><span id="setup-progress-fill"></span></div>
            </section>
          </section>
        </div>

        <section id="channel-settings" class="channel-settings hidden" aria-labelledby="settings-context-label">
          <header class="channel-settings-head">
            <div><p class="kicker">PENGATURAN KONEKSI</p><strong id="settings-context-label">Pilih kanal</strong><span>Token, penautan akun, dan pemulihan sesi hanya ditampilkan saat diperlukan.</span></div>
            <button id="channel-settings-close" class="ghost compact" type="button">Tutup</button>
          </header>
          <div class="channel-settings-body">

            <section id="primary-settings" class="channel-panel settings-panel active" aria-labelledby="primary-settings-title" tabindex="-1">
              <div class="panel-head"><div><h3 id="primary-settings-title">Kanal layanan</h3><p>Identitas Telegram dan WhatsApp yang digunakan Harvy untuk melayani pengguna.</p></div><span id="primary-ready" class="badge">Belum siap</span></div>
              <div class="channel-grid primary-service-grid">
                <section id="primary-telegram-bot-card" class="channel-card" aria-labelledby="primary-telegram-bot-title">
                  <div class="channel-card-head"><div><h3 id="primary-telegram-bot-title">Bot Telegram</h3><p id="primary-telegram-bot-detail">Belum diperiksa.</p></div><span id="primary-telegram-bot-status" class="badge">Memeriksa</span></div>
                  <details id="primary-telegram-bot-editor" class="credential-editor" open>
                    <summary id="primary-telegram-bot-editor-summary">Tambahkan token bot layanan</summary>
                    <form id="primary-telegram-bot-form" class="channel-form">
                      <label for="primary-telegram-bot-token">Token baru dari BotFather<input id="primary-telegram-bot-token" type="password" autocomplete="off" maxlength="256" required></label>
                      <button id="primary-telegram-bot-save" type="submit">Verifikasi dan simpan</button>
                    </form>
                    <div id="primary-telegram-migrate-zone" class="credential-migration hidden"><strong>Pindahkan dari environment</strong><p>Token lama akan diverifikasi, disimpan terenkripsi, lalu barisnya dihapus dari <code>.env</code>. Nilainya tidak ditampilkan kembali.</p><label class="check-label"><input id="primary-telegram-migrate-confirm" type="checkbox">Saya memahami bahwa Console menjadi sumber credential layanan.</label><button id="primary-telegram-migrate" type="button">Pindahkan ke Console</button></div>
                    <div id="primary-telegram-verify-zone" class="credential-actions hidden"><button id="primary-telegram-verify" class="ghost compact" type="button">Periksa token sekarang</button></div>
                    <div id="primary-telegram-delete-zone" class="credential-danger hidden"><strong>Hapus token bot layanan</strong><p>Runtime yang sedang hidup tidak langsung berhenti, tetapi Harvy tidak dapat memulai lagi sebelum token baru disimpan.</p><label for="primary-telegram-delete-confirm">Ketik <code>DELETE_PRIMARY_TELEGRAM_BOT</code><input id="primary-telegram-delete-confirm" autocomplete="off"></label><button id="primary-telegram-delete" class="ghost compact" type="button">Hapus token</button></div>
                  </details>
                </section>

                <section id="primary-whatsapp-card" class="channel-card" aria-labelledby="primary-whatsapp-card-title">
                  <div class="channel-card-head"><div><h3 id="primary-whatsapp-card-title">Akun WhatsApp layanan</h3><p id="primary-whatsapp-card-detail">Belum diperiksa.</p></div><span id="primary-whatsapp-card-status" class="badge">Memeriksa</span></div>
                  <div id="primary-whatsapp-runtime-note" class="inline-note hidden">Runtime Harvy sedang memakai sesi ini. Hentikan runtime lalu buka <code>npm run console:setup</code> untuk mengubahnya.</div>
                  <div id="primary-whatsapp-migrate-zone" class="credential-migration hidden">
                    <strong>Pindahkan konfigurasi lama ke Console</strong>
                    <p>Alias akun dan pengaturan akan disimpan terenkripsi setelah setiap sesi lokal cocok. Tiga field WhatsApp layanan lalu dihapus dari <code>.env</code>.</p>
                    <label class="check-label"><input id="primary-whatsapp-migrate-confirm" type="checkbox">Saya memahami bahwa Console menjadi satu-satunya sumber daftar akun layanan.</label>
                    <button id="primary-whatsapp-migrate" type="button">Pindahkan ke Console</button>
                  </div>
                  <div id="primary-whatsapp-managed-zone" class="service-fleet hidden">
                    <form id="primary-whatsapp-settings-form" class="service-settings-form">
                      <div><strong>Perilaku kanal</strong><p>Perubahan diterapkan saat Harvy dijalankan kembali.</p></div>
                      <label class="check-label"><input id="primary-whatsapp-enabled" type="checkbox">Aktifkan layanan WhatsApp</label>
                      <label class="check-label"><input id="primary-whatsapp-private-enabled" type="checkbox">Layani percakapan pribadi</label>
                      <div class="credential-actions"><button id="primary-whatsapp-settings-save" type="submit">Simpan pengaturan</button><button id="primary-whatsapp-verify" class="ghost compact" type="button">Periksa semua sesi</button></div>
                    </form>
                    <div class="service-account-section">
                      <div class="service-account-heading"><div><strong>Akun layanan</strong><p>Alias dipakai Harvy untuk routing; nomor telepon tidak ditampilkan.</p></div><span id="primary-whatsapp-account-count" class="badge">0 akun</span></div>
                      <div id="primary-whatsapp-account-list" class="service-account-list"></div>
                      <form id="primary-whatsapp-account-form" class="channel-form service-account-add">
                        <label for="primary-whatsapp-account-alias">Alias akun baru<input id="primary-whatsapp-account-alias" autocomplete="off" maxlength="32" pattern="[A-Za-z][A-Za-z0-9_-]{0,31}" placeholder="misalnya layanan_kelas" required><span>Nama internal stabil—bukan nomor telepon atau JID.</span></label>
                        <label class="check-label"><input id="primary-whatsapp-account-confirm" type="checkbox" required>Saya memahami akun ini dapat menerima pesan pengguna sebagai Harvy.</label>
                        <button id="primary-whatsapp-account-add" type="submit">Tambahkan dan pasangkan</button>
                      </form>
                    </div>
                  </div>
                </section>
              </div>
            </section>

            <section id="telegram-settings" class="channel-panel settings-panel" aria-labelledby="telegram-settings-title" tabindex="-1">
              <div class="panel-head"><div><h3 id="telegram-settings-title">Telegram</h3><p>Akun penguji berbicara kepada Harvy melalui bot Telegram yang terpisah dari layanan.</p></div><span id="telegram-ready" class="badge">Belum siap</span></div>
              <div class="channel-grid">
                <section id="telegram-bot-card" class="channel-card" aria-labelledby="telegram-bot-title">
                  <div class="channel-card-head"><div><h3 id="telegram-bot-title">Harvy · Bot Telegram</h3><p id="telegram-bot-detail">Belum diperiksa.</p></div><span id="telegram-bot-status" class="badge">Memeriksa</span></div>
                  <details id="telegram-bot-editor" class="credential-editor" open>
                    <summary id="telegram-bot-editor-summary">Tambahkan token bot pengujian</summary>
                    <form id="telegram-bot-form" class="channel-form">
                      <label for="telegram-bot-token">Token baru dari BotFather<input id="telegram-bot-token" type="password" autocomplete="off" maxlength="256" required></label>
                      <button id="telegram-bot-save" type="submit">Verifikasi dan simpan</button>
                    </form>
                    <div id="telegram-bot-delete-zone" class="credential-danger hidden"><strong>Hapus token bot pengujian</strong><p>Telegram tidak dapat diuji sampai token baru disimpan.</p><label for="telegram-bot-delete-confirm">Ketik <code>DELETE_TELEGRAM_TEST_BOT</code><input id="telegram-bot-delete-confirm" autocomplete="off"></label><button id="telegram-bot-delete" class="ghost compact" type="button">Hapus token</button></div>
                  </details>
                </section>

                <section id="telegram-tester-card" class="channel-card" aria-labelledby="telegram-tester-title">
                  <div class="channel-card-head"><div><h3 id="telegram-tester-title">Penguji · Akun Telegram</h3><p id="telegram-tester-detail">Belum diperiksa.</p></div><span id="telegram-tester-status" class="badge">Memeriksa</span></div>
                  <form id="telegram-tester-form" class="channel-form">
                    <label for="telegram-api-id">api_id<input id="telegram-api-id" inputmode="numeric" autocomplete="off" maxlength="12" required></label>
                    <label for="telegram-api-hash">api_hash<input id="telegram-api-hash" type="password" autocomplete="off" maxlength="64" required></label>
                    <label class="check-label"><input id="telegram-dedicated" type="checkbox" required>Ini akun khusus pengujian, bukan akun pribadi.</label>
                    <button id="telegram-tester-pair" type="submit">Mulai pairing QR</button>
                  </form>
                  <div id="telegram-tester-qr-stage" class="qr-stage hidden"><div id="telegram-tester-qr" class="qr-image" role="img" aria-label="QR pairing akun Telegram penguji"></div><p>Pindai dari Telegram → Settings → Devices → Link Desktop Device.</p><p id="telegram-tester-qr-load-status" class="qr-load-status" aria-live="polite"></p><button id="telegram-tester-qr-retry" class="ghost compact hidden" type="button">Coba muat QR lagi</button></div>
                  <form id="telegram-password-form" class="channel-form hidden"><label for="telegram-password">Password verifikasi dua langkah<input id="telegram-password" type="password" autocomplete="off" maxlength="256" required></label><button id="telegram-password-submit" type="submit">Kirim password</button></form>
                  <div class="channel-actions"><button id="telegram-tester-cancel" class="ghost compact hidden" type="button">Batalkan pairing</button></div>
                  <details id="telegram-tester-manage" class="danger-zone hidden"><summary>Ganti atau cabut sesi penguji</summary><p>Cabut hanya bila akun akan diganti. Console logout ke Telegram lebih dulu; bila jaringan gagal, credential lokal dipertahankan.</p><label for="telegram-tester-delete-confirm">Ketik <code>DELETE_TELEGRAM_TEST_SESSION</code><input id="telegram-tester-delete-confirm" autocomplete="off"></label><button id="telegram-tester-delete" class="ghost compact" type="button">Cabut dan hapus</button></details>
                </section>
              </div>
            </section>

            <section id="whatsapp-settings" class="channel-panel settings-panel" aria-labelledby="whatsapp-settings-title" tabindex="-1">
              <div class="panel-head"><div><h3 id="whatsapp-settings-title">WhatsApp</h3><p>Akun penguji berbicara kepada Harvy melalui dua akun WhatsApp yang terpisah.</p></div><span id="whatsapp-ready" class="badge">Belum siap</span></div>
              <div class="channel-grid">
                <section id="whatsapp-harvy-card" class="channel-card" data-whatsapp-role="harvy">
                  <div class="channel-card-head"><div><h3>Harvy · Akun WhatsApp</h3><p id="whatsapp-harvy-detail">Belum diperiksa.</p></div><span id="whatsapp-harvy-status" class="badge">Memeriksa</span></div>
                  <div id="whatsapp-harvy-setup" class="channel-form"><label class="check-label"><input id="whatsapp-harvy-dedicated" type="checkbox">Ini akun nonkritis khusus pengujian dan bukan sesi layanan.</label><button id="whatsapp-harvy-pair" type="button">Mulai pairing QR</button></div>
                  <div id="whatsapp-harvy-qr-stage" class="qr-stage hidden"><div id="whatsapp-harvy-qr" class="qr-image" role="img" aria-label="QR pairing akun WhatsApp Harvy"></div><p>Pindai dari akun WhatsApp Harvy → Perangkat tertaut.</p><p id="whatsapp-harvy-qr-load-status" class="qr-load-status" aria-live="polite"></p><button id="whatsapp-harvy-qr-retry" class="ghost compact hidden" type="button">Coba muat QR lagi</button></div>
                  <button id="whatsapp-harvy-cancel" class="ghost compact hidden" type="button">Batalkan operasi</button>
                  <details id="whatsapp-harvy-manage" class="session-manager hidden"><summary id="whatsapp-harvy-manage-summary">Kelola sesi Harvy</summary><div class="session-manager-body"><div class="session-replace"><strong>Pasangkan ulang akun Harvy</strong><p>Console mencabut sesi lama lebih dulu, lalu menampilkan QR baru. Credential lokal tetap dipertahankan jika pencabutan tidak dapat dibuktikan.</p><label class="check-label"><input id="whatsapp-harvy-replace-confirm" type="checkbox">Akun Harvy siap dipindai ulang sebagai akun khusus pengujian.</label><button id="whatsapp-harvy-replace" type="button">Pasangkan ulang</button></div><details class="danger-zone"><summary>Cabut tanpa memasangkan ulang</summary><p>Gunakan hanya bila akun ini tidak lagi dipakai untuk pengujian.</p><label for="whatsapp-harvy-revoke-confirm">Ketik <code>REVOKE_WHATSAPP_HARVY_SESSION</code><input id="whatsapp-harvy-revoke-confirm" autocomplete="off"></label><button id="whatsapp-harvy-revoke" class="ghost compact" type="button">Cabut dan hapus</button></details></div></details>
                </section>
                <section id="whatsapp-tester-card" class="channel-card" data-whatsapp-role="tester">
                  <div class="channel-card-head"><div><h3>Penguji · Akun WhatsApp</h3><p id="whatsapp-tester-detail">Belum diperiksa.</p></div><span id="whatsapp-tester-status" class="badge">Memeriksa</span></div>
                  <div id="whatsapp-tester-setup" class="channel-form"><label class="check-label"><input id="whatsapp-tester-dedicated" type="checkbox">Ini akun nonkritis khusus pengujian dan berbeda dari akun Harvy.</label><button id="whatsapp-tester-pair" type="button">Mulai pairing QR</button></div>
                  <div id="whatsapp-tester-qr-stage" class="qr-stage hidden"><div id="whatsapp-tester-qr" class="qr-image" role="img" aria-label="QR pairing akun WhatsApp penguji"></div><p>Pindai dari akun WhatsApp penguji → Perangkat tertaut.</p><p id="whatsapp-tester-qr-load-status" class="qr-load-status" aria-live="polite"></p><button id="whatsapp-tester-qr-retry" class="ghost compact hidden" type="button">Coba muat QR lagi</button></div>
                  <button id="whatsapp-tester-cancel" class="ghost compact hidden" type="button">Batalkan operasi</button>
                  <details id="whatsapp-tester-manage" class="session-manager hidden"><summary id="whatsapp-tester-manage-summary">Kelola sesi penguji</summary><div class="session-manager-body"><div class="session-replace"><strong>Pasangkan ulang akun penguji</strong><p>Console mencabut sesi lama lebih dulu, lalu menampilkan QR baru. Jika perangkat telah dihapus dari ponsel, bukti logged out digunakan untuk membersihkan credential lokal.</p><label class="check-label"><input id="whatsapp-tester-replace-confirm" type="checkbox">Akun penguji siap dipindai ulang dan tetap berbeda dari akun Harvy.</label><button id="whatsapp-tester-replace" type="button">Pasangkan ulang</button></div><details class="danger-zone"><summary>Cabut tanpa memasangkan ulang</summary><p>Gunakan hanya bila akun penguji tidak lagi dipakai untuk pengujian.</p><label for="whatsapp-tester-revoke-confirm">Ketik <code>REVOKE_WHATSAPP_TESTER_SESSION</code><input id="whatsapp-tester-revoke-confirm" autocomplete="off"></label><button id="whatsapp-tester-revoke" class="ghost compact" type="button">Cabut dan hapus</button></details></div></details>
                </section>
              </div>
            </section>
          </div>
        </section>
      </section>

      <section id="tab-compute" class="tabpanel hidden" role="tabpanel" aria-labelledby="nav-compute">
        <div class="section-intro setup-intro">
          <div><p class="kicker">CODING · COMPUTE</p><h2>Komputer kerja yang terisolasi</h2><p>Hubungkan service sandbox Linux dan Git lokal yang sudah Anda deploy. Harvy baru dapat menggunakannya setelah health, identitas runtime, dan receipt hostile-code cocok.</p></div>
        </div>
        <article id="compute-summary-card" class="environment-card setup-capability-card" aria-labelledby="compute-summary-title">
          <header class="environment-head"><span class="environment-kind">Trust domain</span><span id="compute-status" class="badge">Belum diatur</span></header>
          <div class="environment-title"><h3 id="compute-summary-title">Compute coding</h3><p id="compute-summary-detail">Belum ada koneksi yang disimpan.</p></div>
          <div class="environment-connections">
            <div class="environment-row"><div class="channel-symbol compute-symbol" aria-hidden="true">SB</div><div><strong>Sandbox Linux</strong><p id="compute-sandbox-origin">Belum dihubungkan.</p></div><span id="compute-sandbox-status" class="badge">Belum siap</span></div>
            <div class="environment-row"><div class="channel-symbol compute-symbol" aria-hidden="true">GT</div><div><strong>Git lokal</strong><p id="compute-git-origin">Belum dihubungkan.</p></div><span id="compute-git-status" class="badge">Belum siap</span></div>
          </div>
          <footer class="environment-footer"><p id="compute-receipt-detail">Receipt conformance Linux belum tersedia.</p><button id="compute-manage-open" class="ghost compact" type="button">Atur koneksi</button></footer>
        </article>
        <details id="compute-editor" class="panel setup-editor">
          <summary><span><strong>Pengaturan compute</strong><small>Origin service, service identity, dan receipt conformance</small></span><span aria-hidden="true">⌄</span></summary>
          <form id="compute-form" class="setup-form">
            <div class="form-section"><div><span class="form-step">01</span><strong>Sandbox Linux</strong><p>Deploy lebih dahulu pada VM Linux non-root, lalu masukkan origin yang dapat dijangkau Harvy.</p></div><div class="form-grid two-fields"><label for="compute-sandbox-origin-input">Origin sandbox<input id="compute-sandbox-origin-input" type="url" placeholder="https://sandbox.example:8443" required></label><label for="compute-sandbox-key-id">Key ID<input id="compute-sandbox-key-id" value="harvy-control-v1" maxlength="64" required></label><label class="wide-field" for="compute-sandbox-secret">HMAC secret<input id="compute-sandbox-secret" type="password" autocomplete="new-password" placeholder="Kosongkan untuk mempertahankan secret tersimpan"><span>Base64url minimal 32 byte; nilainya tidak ditampilkan kembali.</span></label></div></div>
            <div class="form-section"><div><span class="form-step">02</span><strong>Git lokal</strong><p>Service ini menyimpan object Git tanpa credential provider.</p></div><div class="form-grid two-fields"><label for="compute-git-origin-input">Origin Git lokal<input id="compute-git-origin-input" type="url" placeholder="https://local-git.example:8444" required></label><label for="compute-git-key-id">Key ID<input id="compute-git-key-id" value="harvy-control-v1" maxlength="64" required></label><label class="wide-field" for="compute-git-secret">HMAC secret<input id="compute-git-secret" type="password" autocomplete="new-password" placeholder="Kosongkan untuk mempertahankan secret tersimpan"><span>Gunakan identity berbeda dari sandbox.</span></label></div></div>
            <div class="form-section"><div><span class="form-step">03</span><strong>Bukti conformance</strong><p>Tempel JSON receipt dari <code>npm run conformance:sandbox</code>. Console menghitung pin SHA-256 sendiri dan menolak receipt kedaluwarsa.</p></div><div class="form-stack"><label for="compute-receipt">Receipt hostile-sandbox<textarea id="compute-receipt" rows="8" spellcheck="false" placeholder="Kosongkan untuk mempertahankan receipt tersimpan"></textarea></label><label for="compute-privacy-domain">Privacy domain coding<input id="compute-privacy-domain" maxlength="128" placeholder="misalnya workspace.private"></label><label class="check-label"><input id="compute-insecure-loopback" type="checkbox">Izinkan HTTP hanya untuk service loopback pada development.</label></div></div>
            <div class="setup-form-actions"><button id="compute-save" type="submit">Simpan konfigurasi</button><span>Perubahan menonaktifkan compute sampai diverifikasi ulang.</span></div>
          </form>
        </details>
        <div class="activation-bar"><div><strong>Aktivasi compute</strong><p id="compute-activation-detail">Simpan konfigurasi lengkap lebih dahulu.</p></div><div><button id="compute-verify" type="button">Verifikasi dan aktifkan</button><button id="compute-disable" class="ghost compact hidden" type="button">Nonaktifkan</button></div></div>
      </section>

      <section id="tab-github" class="tabpanel hidden" role="tabpanel" aria-labelledby="nav-github">
        <div class="section-intro setup-intro">
          <div><p class="kicker">CODING · GITHUB</p><h2>Publikasi melalui GitHub App</h2><p>Harvy tidak menerima PAT. Private key dan client secret hanya dibaca proses Broker; push tetap non-force dan pembuatan pull request selalu draft.</p></div>
        </div>
        <article class="environment-card setup-capability-card" aria-labelledby="github-summary-title">
          <header class="environment-head"><span class="environment-kind">Credential domain</span><span id="github-status" class="badge">Belum diatur</span></header>
          <div class="environment-title"><h3 id="github-summary-title">GitHub Broker</h3><p id="github-summary-detail">Belum ada GitHub App yang disimpan.</p></div>
          <div class="environment-connections">
            <div class="environment-row"><div class="channel-symbol github-symbol" aria-hidden="true">GH</div><div><strong id="github-app-name">GitHub App</strong><p id="github-callback-origin">Callback HTTPS belum diatur.</p></div><span id="github-credential-status" class="badge">Belum siap</span></div>
            <div class="environment-row"><div class="channel-symbol github-symbol" aria-hidden="true">BR</div><div><strong>Broker</strong><p id="github-broker-origin">Belum dihubungkan.</p></div><span id="github-broker-status" class="badge">Belum siap</span></div>
          </div>
          <footer class="environment-footer"><p>Jalankan Broker setelah menyimpan atau mengganti credential.</p><button id="github-manage-open" class="ghost compact" type="button">Atur GitHub</button></footer>
        </article>
        <details id="github-editor" class="panel setup-editor">
          <summary><span><strong>Pengaturan GitHub App</strong><small>App terbatas, broker, dan callback pada domain HTTPS milik Anda</small></span><span aria-hidden="true">⌄</span></summary>
          <form id="github-form" class="setup-form">
            <div class="form-section"><div><span class="form-step">01</span><strong>Identitas App</strong><p>Gunakan GitHub App khusus Harvy dengan akses hanya ke repository yang dipilih.</p></div><div class="form-grid two-fields"><label for="github-app-id">App ID<input id="github-app-id" inputmode="numeric" maxlength="20" required></label><label for="github-app-slug">App slug<input id="github-app-slug" maxlength="100" required></label><label for="github-client-id">Client ID<input id="github-client-id" maxlength="256" required></label><label for="github-client-secret">Client secret<input id="github-client-secret" type="password" autocomplete="new-password" placeholder="Kosongkan untuk mempertahankan" required></label></div></div>
            <div class="form-section"><div><span class="form-step">02</span><strong>Private key dan callback</strong><p>Callback harus berada pada domain HTTPS yang Anda kuasai; query OAuth ditangani satu kali oleh Broker.</p></div><div class="form-stack"><label for="github-private-key">Private key PEM<textarea id="github-private-key" rows="8" spellcheck="false" placeholder="Kosongkan untuk mempertahankan private key tersimpan" required></textarea></label><label for="github-callback-url">Callback URL<input id="github-callback-url" type="url" placeholder="https://github.example/v1/github-app/callback" required></label></div></div>
            <div class="form-section"><div><span class="form-step">03</span><strong>Koneksi Broker</strong><p>Origin ini adalah RPC internal yang dijangkau Harvy, bukan halaman callback publik.</p></div><div class="form-grid two-fields"><label for="github-broker-origin-input">Origin Broker<input id="github-broker-origin-input" type="url" placeholder="https://github-broker.internal:8445" required></label><label for="github-broker-key-id">Key ID<input id="github-broker-key-id" value="harvy-control-v1" maxlength="64" required></label><label class="wide-field" for="github-broker-secret">HMAC secret<input id="github-broker-secret" type="password" autocomplete="new-password" placeholder="Kosongkan untuk mempertahankan secret tersimpan"><span>Secret service-to-service; bukan token GitHub.</span></label></div></div>
            <div class="setup-form-actions"><button id="github-save" type="submit">Simpan credential</button><span>Credential tidak pernah dibaca kembali ke browser.</span></div>
          </form>
        </details>
        <div class="activation-bar"><div><strong>Aktivasi GitHub</strong><p id="github-activation-detail">Compute harus aktif dan Broker harus berjalan.</p></div><div><button id="github-verify" type="button">Verifikasi dan aktifkan</button><button id="github-disable" class="ghost compact hidden" type="button">Nonaktifkan</button></div></div>
      </section>

      <section id="tab-access" class="tabpanel hidden" role="tabpanel" aria-labelledby="nav-access">
        <div class="section-intro">
          <div><p class="kicker">CONTROL PLANE</p><h2>Akses pengguna dan grup</h2><p>Atur beta, paket, kuota, serta undangan evaluasi secara terpisah. Gunakan label pseudonim, bukan nama atau nomor asli.</p></div>
        </div>
        <article class="panel form-panel">
          <h3>Tambahkan akses</h3>
          <form id="enroll-form" class="form-grid">
            <label for="enroll-kind">Jenis<select id="enroll-kind"><option value="private">Pribadi</option><option value="group">Grup</option></select></label>
            <label for="enroll-channel">Kanal<select id="enroll-channel"><option value="telegram">Telegram</option><option value="whatsapp">WhatsApp</option></select></label>
            <label for="enroll-id">ID platform<input id="enroll-id" required maxlength="256"></label>
            <label for="enroll-label">Label pseudonim<input id="enroll-label" maxlength="64" placeholder="Contoh: Grup belajar A"></label>
            <button id="enroll-submit" type="submit">Tambahkan akses</button>
          </form>
        </article>
        <article class="panel">
          <div class="panel-head"><div><h3>Akses terdaftar</h3><p id="enrollment-count"></p></div></div>
          <div id="enrollments"></div>
        </article>
      </section>

      <section id="tab-groups" class="tabpanel hidden" role="tabpanel" aria-labelledby="nav-groups">
        <div class="section-intro">
          <div><p class="kicker">ATRIBUSI AMAN</p><h2>Grup dan anggota pemicu</h2><p>Bucket anggota bersifat pseudonim dan hanya menunjukkan siapa yang memicu request. Ini bukan penilaian isi ataupun perilaku anggota.</p></div>
          <button id="refresh-groups" class="ghost compact" type="button">Segarkan grup</button>
        </div>
        <div id="groups"></div>
      </section>

      <section id="tab-plans" class="tabpanel hidden" role="tabpanel" aria-labelledby="nav-plans">
        <div class="section-intro"><div><p class="kicker">MONETISASI</p><h2>Katalog paket pilot</h2><p>Paket masih berupa control plane; checkout belum aktif. Pilihan model tetap mengikuti kebutuhan pekerjaan, bukan harga paket.</p></div></div>
        <article class="panel"><div id="plans"></div></article>
      </section>

      <section id="tab-prices" class="tabpanel hidden" role="tabpanel" aria-labelledby="nav-prices">
        <div class="section-intro"><div><p class="kicker">KATALOG MODEL</p><h2>Harga model yang tersedia di environment</h2><p>Model dibaca otomatis dari konfigurasi Harvy. Di sini Anda hanya menetapkan harganya.</p></div></div>
        <div id="configured-models" class="model-grid"></div>
        <article class="panel price-editor">
          <div class="panel-head">
            <div><h3>Buat versi harga baru</h3><p>Versi berlaku untuk request berikutnya. Ledger lama tidak ditulis ulang; estimasi historis akan tetap ditandai dengan <strong>≈</strong>.</p></div>
          </div>
          <form id="price-form" class="form-grid price-form" novalidate>
            <label for="price-model">Model terkonfigurasi<select id="price-model" required></select></label>
            <label for="price-input">Input / 1 juta token (USD)<input id="price-input" inputmode="decimal" autocomplete="off" placeholder="0,30" required><span id="price-input-error" class="field-error"></span></label>
            <label for="price-output">Output / 1 juta token (USD)<input id="price-output" inputmode="decimal" autocomplete="off" placeholder="2,50" required><span id="price-output-error" class="field-error"></span></label>
            <button id="price-submit" type="submit">Simpan versi harga</button>
          </form>
        </article>
        <article class="panel">
          <div class="panel-head"><div><h3>Riwayat versi harga</h3><p>Versi sebelumnya dipertahankan agar biaya tercatat dapat diaudit.</p></div></div>
          <div id="prices"></div>
        </article>
      </section>

      <section id="tab-usage" class="tabpanel hidden" role="tabpanel" aria-labelledby="nav-usage">
        <div class="section-intro"><div><p class="kicker">LEDGER MODEL</p><h2>Penggunaan provider</h2><p>Satu request logis dapat memiliki beberapa attempt karena retry atau fallback.</p></div></div>
        <article class="panel filter-panel">
          <div class="form-grid filter-grid">
            <label for="usage-cohort">Akses<select id="usage-cohort"><option value="">Semua</option><option value="standard">Standar</option><option value="beta">Beta</option></select></label>
            <label for="usage-plan">Paket<select id="usage-plan"><option value="">Semua</option></select></label>
            <button id="usage-apply" type="button">Terapkan filter</button>
          </div>
        </article>
        <div id="usage-summary" class="usage-summary"></div>
        <article class="panel"><div id="attempts"></div></article>
      </section>

      <section id="tab-audit" class="tabpanel hidden" role="tabpanel" aria-labelledby="nav-audit">
        <div class="section-intro"><div><p class="kicker">AKUNTABILITAS</p><h2>Audit operator</h2><p>Console mencatat status dan perubahan operasional, bukan isi percakapan atau kredensial.</p></div></div>
        <article class="panel"><div id="audits"></div></article>
      </section>
    </main>
  </div>
  <script src="/app.js" defer></script>
</body>
</html>`;

export const CONSOLE_CSS = `:root{
  color-scheme:light;
  --bg:#f5f6f2;--bg-soft:#f0f3ee;--panel:#ffffff;--panel-strong:#e9f0eb;
  --line:#d6ddd7;--line-soft:#e7ebe7;--text:#17211b;--muted:#5e6b63;--faint:#7e8982;
  --mint:#25694b;--mint-strong:#18583d;--mint-ink:#ffffff;--amber:#8c6218;--amber-bg:#fff7e6;
  --red:#ad3e34;--red-bg:#fff1ef;--blue:#356b8c;--shadow:0 20px 60px rgba(23,45,32,.09);
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:linear-gradient(180deg,#fafbf8 0,var(--bg) 72%);color:var(--text);min-height:100vh;font-size:15px}
button,input,select,textarea{font:inherit;border-radius:10px;border:1px solid var(--line)}
button{cursor:pointer;min-height:42px;padding:10px 15px;background:var(--mint);border-color:transparent;color:var(--mint-ink);font-weight:750;transition:background-color .15s ease,border-color .15s ease,color .15s ease}
button:hover:not(:disabled){background:var(--mint-strong)}button:disabled{cursor:not-allowed;opacity:.48}
button.ghost{background:transparent;color:var(--text);border-color:var(--line)}button.ghost:hover:not(:disabled){background:var(--bg-soft)}button.compact{min-height:36px;padding:7px 11px;font-size:.84rem}
input,select,textarea{width:100%;min-height:42px;padding:9px 11px;color:var(--text);background:#fff;outline:none}textarea{resize:vertical;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.78rem}
input:focus,select:focus,textarea:focus{border-color:var(--mint);box-shadow:0 0 0 3px rgba(37,105,75,.14)}
button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #d2a23d;outline-offset:3px}
label{display:grid;gap:7px;color:var(--muted);font-size:.82rem;font-weight:650}
h1,h2,h3,p{margin-top:0}h1{font-size:clamp(1.65rem,3vw,2.35rem);line-height:1.08;letter-spacing:-.035em;margin-bottom:7px}
h2{font-size:1.35rem;margin-bottom:7px;letter-spacing:-.015em}h3{font-size:1.05rem;margin-bottom:6px}p{color:var(--muted);line-height:1.55}
code{color:var(--mint);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.hidden{display:none!important}.visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.skip-link{position:fixed;z-index:100;top:10px;left:10px;transform:translateY(-160%);background:var(--amber);color:#211704;padding:9px 12px;border-radius:8px;font-weight:700}.skip-link:focus{transform:none}
.eyebrow,.kicker,.period-label{margin:0 0 7px;color:var(--mint);font-size:.69rem;font-weight:800;letter-spacing:.11em}
.brand-mark{display:grid;place-items:center;width:54px;height:54px;border-radius:15px;background:var(--mint);color:#fff;font-size:1.5rem;font-weight:900;box-shadow:0 13px 30px rgba(37,105,75,.16)}
.brand-mark.small{width:39px;height:39px;border-radius:12px;font-size:1.05rem;box-shadow:none}
.login-shell{width:min(1080px,calc(100% - 36px));min-height:100vh;margin:auto;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.72fr);gap:70px;align-items:center;padding:50px 0}
.login-brand h1{max-width:640px;font-size:clamp(2.2rem,5.5vw,4.5rem);margin:25px 0 18px}.login-copy{max-width:620px;font-size:1.05rem}
.trust-list{display:flex;gap:8px;flex-wrap:wrap;margin-top:28px}
.trust-list span,.status-badge,.badge{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:6px 10px;color:var(--muted);font-size:.76rem;font-weight:700;background:#f8faf8}
.login-card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}
.login-card{padding:28px}.login-card form{display:grid;gap:12px;margin:24px 0 8px}.form-error,.field-error{color:var(--red);font-size:.8rem;min-height:1.2em}.fineprint{font-size:.77rem;color:var(--faint)}
.app-shell{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;padding:26px 17px 20px;border-right:1px solid var(--line);background:rgba(250,251,248,.96);backdrop-filter:blur(18px);display:flex;flex-direction:column;z-index:10}
.sidebar-brand{display:flex;align-items:center;gap:11px;padding:0 8px 25px}.sidebar-brand strong,.sidebar-brand span{display:block}.sidebar-brand strong{font-size:1.05rem}.sidebar-brand span{font-size:.78rem;color:var(--muted)}
.nav-tabs{display:grid;gap:5px}.nav-tabs button{display:flex;align-items:center;gap:11px;justify-content:flex-start;min-height:43px;background:transparent;color:var(--muted);border-color:transparent;text-align:left}
.nav-tabs button span{width:20px;text-align:center;color:var(--faint);font-size:1rem}.nav-tabs button:hover:not(:disabled){background:var(--bg-soft);color:var(--text)}.nav-tabs button.active{background:var(--panel-strong);border-color:transparent;color:var(--text)}.nav-tabs button.active span{color:var(--mint)}
.workspace{width:min(1400px,100%);padding:30px clamp(22px,4vw,58px) 70px;overflow:hidden}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:28px}.page-description{margin:0}.top-actions{display:flex;align-items:center;gap:9px}
.sync-state{display:grid;text-align:right;justify-items:end;gap:5px;margin-right:4px}.sync-state>span:last-child{font-size:.69rem;color:var(--faint)}
.status-badge{padding:4px 9px}.status-badge.ready{color:var(--mint);border-color:#bad4c4;background:#f0f7f2}.status-badge.warning{color:var(--amber);border-color:#ead9ad;background:var(--amber-bg)}.status-badge.neutral{color:var(--muted)}
.icon-button{width:42px;padding:0;font-size:1.2rem;background:transparent;color:var(--text);border-color:var(--line)}.setup-only #refresh{display:none}
.setup-only{display:block;background:linear-gradient(180deg,#fafbf8 0,#f5f6f2 340px)}.setup-only .sidebar{display:none}.setup-only .workspace{width:min(1040px,100%);margin:0 auto;padding:24px 32px 72px;overflow:visible}.setup-only .topbar{align-items:center;padding-bottom:21px;border-bottom:1px solid var(--line-soft)}.setup-only .loading-bar{left:0}.setup-only #page-title{font-size:1.9rem}.setup-only .page-description{max-width:620px}
.setup-section-nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:-9px 0 28px;border:1px solid var(--line);border-radius:16px;background:var(--panel);overflow:hidden}.setup-section-nav button{display:grid;grid-template-columns:28px minmax(0,1fr);grid-template-rows:auto auto;column-gap:9px;min-height:70px;padding:12px 14px;border:0;border-right:1px solid var(--line-soft);border-radius:0;background:transparent;color:var(--muted);text-align:left}.setup-section-nav button:last-child{border-right:0}.setup-section-nav button:hover:not(:disabled){background:var(--bg-soft);color:var(--text)}.setup-section-nav button.active{background:var(--panel-strong);color:var(--text);box-shadow:inset 0 -3px 0 var(--mint)}.setup-section-nav button>span{grid-row:1/3;display:grid;place-items:center;width:28px;height:28px;border:1px solid var(--line);border-radius:9px;color:var(--faint);font-size:.66rem}.setup-section-nav button.active>span{border-color:#b8d3c2;background:#f4faf6;color:var(--mint)}.setup-section-nav strong{font-size:.82rem}.setup-section-nav small{margin-top:2px;color:var(--faint);font-size:.65rem;font-weight:550}
.loading-bar{height:3px;position:fixed;z-index:30;top:0;left:236px;right:0;overflow:hidden;background:rgba(37,105,75,.1)}.loading-bar:after{content:"";display:block;width:36%;height:100%;background:var(--mint);animation:loading 1.05s ease-in-out infinite}
@keyframes loading{from{transform:translateX(-120%)}to{transform:translateX(390%)}}
.notice,.error-banner{border-radius:12px;padding:12px 14px;margin:-8px 0 20px}.notice{border:1px solid #bad4c4;background:#eff8f2;color:var(--mint)}.notice.warning{border-color:#ead9ad;background:var(--amber-bg);color:var(--amber)}
.error-banner{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid #e3b9b4;background:var(--red-bg);color:var(--red)}.error-banner div{display:grid;gap:3px}.error-banner span{font-size:.82rem}
.tabpanel{outline:none}.period-label{color:var(--faint);margin-bottom:12px}
.summary-grid{display:grid;grid-template-columns:1.25fr repeat(3,1fr);gap:13px}.summary-card{position:relative;min-height:145px;padding:19px;border:1px solid var(--line);border-radius:17px;background:var(--panel);overflow:hidden}
.summary-card.primary:after{content:"";position:absolute;width:120px;height:120px;right:-40px;top:-55px;border-radius:50%;background:rgba(37,105,75,.07)}
.summary-label{display:block;color:var(--muted);font-size:.76rem;font-weight:700}.summary-value{display:block;margin:15px 0 8px;font-size:clamp(1.45rem,2.6vw,2.15rem);line-height:1;font-weight:800;letter-spacing:-.035em}.summary-detail{color:var(--faint);font-size:.73rem;line-height:1.4}
.cost-banner{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:14px;padding:15px 17px;border:1px solid #ead9ad;border-radius:14px;background:var(--amber-bg)}
.cost-banner strong{display:block;color:var(--amber);margin-bottom:3px}.cost-banner span{font-size:.8rem;color:#735f32}
.content-grid{display:grid;gap:16px;margin-top:16px}.content-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{padding:20px;box-shadow:none}
.panel-head,.section-intro{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.panel-head p,.section-intro p{margin-bottom:0}.section-intro{margin-bottom:18px}.section-intro>div{max-width:760px}.section-intro h2{font-size:1.55rem}
.diagnostics{margin-top:16px}.diagnostics summary{cursor:pointer;color:var(--muted);font-weight:700}.diagnostics[open] summary{margin-bottom:18px;color:var(--text)}
.diagnostic-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.diagnostic-item{padding:12px;border-radius:11px;background:var(--bg-soft);border:1px solid var(--line-soft)}
.diagnostic-item span,.diagnostic-item strong{display:block}.diagnostic-item span{font-size:.7rem;color:var(--faint)}.diagnostic-item strong{margin-top:5px;font-size:1rem}
.form-panel{margin-bottom:16px}.form-grid{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr)) auto;align-items:start;gap:12px;margin-top:16px}.form-grid button{align-self:end}
.price-form{grid-template-columns:minmax(220px,1.4fr) repeat(2,minmax(170px,1fr)) auto}.filter-grid{grid-template-columns:repeat(2,minmax(160px,240px)) auto;margin-top:0}.filter-panel{margin-bottom:14px}
.table-scroll{width:100%;overflow:auto}table{width:100%;border-collapse:collapse}caption{text-align:left;color:var(--faint);padding:0 0 10px;font-size:.75rem}
th,td{text-align:left;border-bottom:1px solid var(--line-soft);padding:12px 9px;font-size:.79rem;vertical-align:middle}th{color:var(--faint);font-weight:700;white-space:nowrap}tbody tr:last-child td{border-bottom:0}td code{font-size:.74rem;overflow-wrap:anywhere}
.cell-stack{display:grid;gap:3px}.cell-stack small{color:var(--faint);font-size:.69rem}.actions{display:flex;gap:7px;align-items:center}.actions button{white-space:nowrap}
.badge{padding:4px 8px}.badge.good{color:var(--mint);border-color:#bad4c4;background:#f0f7f2}.badge.warn{color:var(--amber);border-color:#ead9ad;background:var(--amber-bg)}.badge.bad{color:var(--red);border-color:#e3b9b4;background:var(--red-bg)}.badge.info{color:var(--blue);border-color:#bfd2df;background:#f0f6fa}
.empty-state{display:grid;place-items:center;text-align:center;min-height:160px;padding:25px;border:1px dashed var(--line);border-radius:14px;color:var(--muted)}.empty-state.compact{min-height:90px}.empty-state strong{display:block;color:var(--text);margin-bottom:5px}.empty-state p{max-width:440px;margin:0;font-size:.82rem}
.model-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px;margin-bottom:16px}.model-card{padding:16px;border:1px solid var(--line);border-radius:15px;background:var(--bg-soft)}
.model-card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.model-card h3{overflow-wrap:anywhere}.model-card p{font-size:.75rem;margin:8px 0 0}
.model-price{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:14px}.model-price div{padding:9px;border-radius:9px;background:var(--bg-soft)}.model-price span,.model-price strong{display:block}.model-price span{color:var(--faint);font-size:.65rem}.model-price strong{margin-top:3px;font-size:.83rem}
.price-editor{margin-bottom:16px}.group-list{display:grid;gap:13px}.group-card{border:1px solid var(--line);border-radius:17px;background:var(--panel);overflow:hidden}
.group-card-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding:17px 19px;border-bottom:1px solid var(--line-soft)}.group-card-head h3{margin:0}.group-meta{display:flex;gap:6px;flex-wrap:wrap}.group-body{padding:6px 15px 12px}
.usage-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}.usage-chip{padding:13px 15px;border:1px solid var(--line);border-radius:13px;background:var(--bg-soft)}.usage-chip span,.usage-chip strong{display:block}.usage-chip span{font-size:.69rem;color:var(--faint)}.usage-chip strong{margin-top:5px}.economy-note{margin:0;font-size:.78rem;color:var(--faint)}
.channel-environment-nav{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:stretch;gap:14px;margin-bottom:20px}.channel-environment-tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--line);border-radius:15px;background:var(--panel);overflow:hidden}.channel-environment-tab{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:66px;padding:12px 15px;border:0;border-right:1px solid var(--line-soft);border-radius:0;background:transparent;color:var(--muted);text-align:left}.channel-environment-tab:last-child{border-right:0}.channel-environment-tab:hover:not(:disabled){background:var(--bg-soft);color:var(--text)}.channel-environment-tab.active{background:var(--panel-strong);color:var(--text);box-shadow:inset 0 -3px 0 var(--mint)}.channel-environment-tab>span:first-child{display:grid;gap:2px}.channel-environment-tab strong{font-size:.88rem}.channel-environment-tab small{color:var(--faint);font-size:.68rem;font-weight:550}.channel-environment-tab.active small{color:var(--muted)}.refresh-action{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:142px;flex:0 0 auto}.refresh-action span{font-size:1.05rem}.channel-environments{display:block}.channel-environment-view{display:none}.channel-environment-view.active{display:block}.channel-readiness{display:flex;align-items:center;gap:16px;padding:0 0 18px}.readiness-state{display:flex;align-items:flex-start;gap:16px}.readiness-mark{display:grid;place-items:center;width:46px;height:46px;flex:0 0 46px;border-radius:14px;background:var(--panel-strong);color:var(--mint);font-size:1.2rem;font-weight:850}.readiness-label{margin:1px 0 5px;color:var(--faint);font-size:.74rem;font-weight:750}.channel-readiness h2{margin-bottom:5px;font-size:1.35rem}.channel-readiness p:last-child{margin:0}.ready-mode .readiness-mark{background:var(--mint);color:#fff}.ready-mode .readiness-label{color:var(--mint)}
.environment-card{border:1px solid var(--line);border-radius:18px;background:var(--panel);overflow:hidden;box-shadow:0 10px 35px rgba(23,45,32,.045)}.primary-environment{border-top:3px solid #c5d1c8}.acceptance-environment{border-top:3px solid var(--mint)}.environment-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 20px 0}.environment-kind{color:#6f603e;font-size:.68rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.environment-kind.test{color:var(--mint)}.environment-title{padding:12px 20px 17px}.environment-title h3{margin-bottom:5px;font-size:1.24rem}.environment-title p{margin:0;font-size:.79rem}.environment-connections,.acceptance-routes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border-top:1px solid var(--line-soft)}.environment-row{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:start;gap:13px;padding:17px 20px}.environment-row:first-child{border-right:1px solid var(--line-soft)}.environment-row strong{font-size:.84rem}.environment-row p{margin:4px 0 0;font-size:.73rem}.environment-footer{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 20px;border-top:1px solid var(--line-soft);background:#fafbf9}.environment-footer p{margin:0;font-size:.72rem}.channel-symbol{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--bg-soft);color:var(--muted);font-size:.67rem;font-weight:850;letter-spacing:.03em}.telegram-symbol{color:#24678f;background:#eef6fb}.whatsapp-symbol{color:var(--mint);background:#edf7f1}.connection-row{display:grid;grid-template-columns:40px minmax(0,1fr);align-items:start;gap:13px;padding:17px 20px}.connection-row:first-child{border-right:1px solid var(--line-soft)}.connection-copy{display:grid;gap:8px}.connection-copy>strong{font-size:.88rem}.route-map{display:grid;grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr);align-items:center;gap:5px;color:var(--muted);font-size:.75rem;text-align:center}.route-map span{display:grid;gap:2px;min-width:0}.route-map small{color:var(--faint);font-size:.59rem;font-weight:750;letter-spacing:.08em}.route-map b{overflow-wrap:anywhere;font-size:.72rem;font-weight:650}.route-map i{color:var(--faint);font-size:.95rem;font-style:normal}.connection-actions{grid-column:2;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:4px}.connection-status{display:inline-flex;align-items:center;gap:7px;color:var(--muted);font-size:.73rem;font-weight:700}.connection-status:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--faint)}.connection-status.good{color:var(--mint)}.connection-status.good:before{background:var(--mint)}.connection-status.warn{color:var(--amber)}.connection-status.warn:before{background:var(--amber)}.connection-status.bad{color:var(--red)}.connection-status.bad:before{background:var(--red)}.acceptance-environment>.setup-checklist{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0;padding:13px 20px 11px;border-top:1px solid var(--line-soft);list-style:none;background:#fafbf9}.setup-checklist li{display:flex;align-items:center;justify-content:center;gap:7px;color:var(--muted);font-size:.68rem;white-space:nowrap}.setup-checklist li span{display:grid;place-items:center;width:20px;height:20px;flex:0 0 20px;border:1px solid var(--line);border-radius:50%;font-size:.61rem;font-weight:800}.setup-checklist li.complete{color:var(--text)}.setup-checklist li.complete span{color:#fff;background:var(--mint);border-color:var(--mint)}.setup-progress-track{height:3px;background:#e3ebe5;overflow:hidden}.setup-progress-track span{display:block;width:0;height:100%;background:var(--mint);transition:width .25s ease}
.setup-intro{margin-bottom:16px}.setup-capability-card{border-top:3px solid #c5d1c8}.setup-capability-card.enabled{border-top-color:var(--mint)}.compute-symbol{color:#4d6658;background:#eef4ef}.github-symbol{color:#342f43;background:#f1eff6}.setup-editor{margin-top:16px;padding:0;overflow:hidden}.setup-editor>summary{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 19px;cursor:pointer;list-style:none}.setup-editor>summary::-webkit-details-marker{display:none}.setup-editor>summary>span:first-child{display:grid;gap:3px}.setup-editor>summary strong{font-size:.88rem}.setup-editor>summary small{color:var(--faint);font-size:.7rem}.setup-editor[open]>summary{border-bottom:1px solid var(--line-soft);background:#fafbf9}.setup-editor[open]>summary>span:last-child{transform:rotate(180deg)}.setup-form{display:grid}.form-section{display:grid;grid-template-columns:minmax(190px,.72fr) minmax(0,1.55fr);gap:24px;padding:20px;border-bottom:1px solid var(--line-soft)}.form-section>div:first-child>strong{display:block;margin:4px 0 5px;font-size:.88rem}.form-section>div:first-child>p{margin:0;font-size:.73rem}.form-step{color:var(--mint);font-size:.65rem;font-weight:850;letter-spacing:.08em}.form-grid.two-fields{grid-template-columns:repeat(2,minmax(0,1fr));margin:0}.form-grid.two-fields .wide-field{grid-column:1/-1}.form-stack{display:grid;gap:12px}.setup-form label>span{color:var(--faint);font-size:.67rem;font-weight:500}.setup-form-actions{display:flex;align-items:center;gap:14px;padding:16px 20px;background:#fafbf9}.setup-form-actions span{color:var(--faint);font-size:.7rem}.activation-bar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:16px;padding:16px 19px;border:1px solid var(--line);border-radius:15px;background:var(--panel)}.activation-bar strong{font-size:.88rem}.activation-bar p{margin:3px 0 0;font-size:.72rem}.activation-bar>div:last-child{display:flex;gap:8px;flex-wrap:wrap}
.channel-settings{margin-top:18px;border:1px solid var(--line);border-radius:18px;background:var(--panel);overflow:hidden;box-shadow:0 10px 35px rgba(23,45,32,.04)}.channel-settings-head{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px 20px;border-bottom:1px solid var(--line-soft);background:#fafbf9}.channel-settings-head>div{display:grid;gap:3px}.channel-settings-head .kicker{margin:0}.channel-settings-head strong{font-size:.93rem}.channel-settings-head span{color:var(--faint);font-size:.72rem}.channel-settings-body{background:#fff}
.channel-panel{display:none;margin:0;border:0;border-radius:0;background:var(--panel);overflow:hidden}.channel-panel.active{display:block}.channel-panel>.panel-head{padding:19px 21px;border-bottom:1px solid var(--line-soft)}.channel-panel>.panel-head h3{margin-bottom:4px}.channel-panel>.panel-head p{font-size:.79rem}.channel-grid{display:block}.channel-card{display:grid;align-content:start;gap:13px;padding:17px 21px;border-bottom:1px solid var(--line-soft);background:transparent}.channel-card:last-child{border-bottom:0}.channel-card.ready{background:#fcfdfc}.channel-card-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.channel-card-head h3,.channel-card-head p{margin-bottom:0}.channel-card-head p{font-size:.78rem;margin-top:4px}.channel-form{display:grid;gap:11px}.channel-actions{display:flex;gap:8px;flex-wrap:wrap}.check-label{display:flex;grid-template-columns:none;align-items:flex-start;gap:9px;font-weight:500;line-height:1.4}.check-label input{width:18px;min-height:18px;height:18px;margin:1px 0 0;flex:0 0 auto}
.credential-editor{border:1px solid var(--line);border-radius:11px;background:var(--bg-soft);overflow:hidden}.credential-editor summary{cursor:pointer;padding:11px 12px;color:var(--muted);font-size:.79rem;font-weight:750}.credential-editor[open] summary{color:var(--text);border-bottom:1px solid var(--line)}.credential-editor .channel-form{padding:13px}.credential-actions,.credential-migration{margin:0 13px 13px;padding-top:12px;border-top:1px solid var(--line)}.credential-migration strong{display:block;font-size:.78rem}.credential-migration p,.credential-migration label,.credential-migration button{margin-top:9px}.credential-migration p{margin-bottom:0;font-size:.73rem}.credential-danger{margin:0 13px 13px;padding-top:12px;border-top:1px solid #e3b9b4}.credential-danger strong{display:block;color:var(--red);font-size:.78rem}.credential-danger p,.credential-danger label,.credential-danger button{margin-top:9px}.credential-danger p{margin-bottom:0;font-size:.73rem}
.inline-note{padding:11px 12px;border:1px solid #ead9ad;border-radius:11px;background:var(--amber-bg);color:#6f561d;font-size:.74rem;line-height:1.55}.service-fleet{display:grid;gap:16px}.service-settings-form{display:grid;grid-template-columns:minmax(180px,1fr) repeat(2,minmax(150px,auto));align-items:center;gap:12px;padding:14px;border:1px solid var(--line);border-radius:13px;background:var(--bg-soft)}.service-settings-form p,.service-account-heading p{margin:3px 0 0;font-size:.71rem}.service-settings-form>.credential-actions{display:flex;grid-column:1/-1;gap:8px;margin:0;padding-top:12px}.service-account-section{display:grid;gap:12px}.service-account-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.service-account-list{display:grid;gap:9px}.service-account-empty{padding:17px;border:1px dashed var(--line);border-radius:12px;color:var(--muted);font-size:.76rem;text-align:center}.service-account{display:grid;gap:12px;padding:13px;border:1px solid var(--line);border-radius:13px;background:#fff}.service-account-main{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.service-account-copy{display:grid;gap:3px;min-width:0}.service-account-copy strong{overflow-wrap:anywhere;font-size:.83rem}.service-account-copy p{margin:0;font-size:.72rem}.service-account-actions{display:flex;gap:8px;flex-wrap:wrap}.service-account-actions button{min-height:34px;padding:7px 10px}.service-account .qr-stage{margin-top:1px}.service-account-danger{padding-top:10px;border-top:1px solid var(--line-soft)}.service-account-danger summary{cursor:pointer;color:var(--muted);font-size:.73rem;font-weight:700}.service-account-danger[open] summary{color:var(--red)}.service-account-danger p{margin:8px 0;font-size:.72rem}.service-account-add{padding-top:14px;border-top:1px solid var(--line-soft)}.service-account-add label>span{display:block;margin-top:4px;color:var(--faint);font-size:.68rem;font-weight:500}
.qr-stage{display:grid;justify-items:center;gap:10px;padding:14px;border:1px solid var(--line);border-radius:13px;background:#fff}.qr-image{display:grid;place-items:center;width:min(100%,320px);aspect-ratio:1;overflow:hidden;background:#f5f8f5;transition:opacity .16s ease}.qr-image svg{display:block;width:100%;height:100%}.qr-image.qr-loading{opacity:.58}.qr-image.qr-loading:empty:after{content:"";width:28px;height:28px;border:3px solid #d9e5dc;border-top-color:var(--mint);border-radius:50%;animation:spin .8s linear infinite}.qr-image.qr-failed{display:none}.qr-stage p{margin:0;color:#33483d;text-align:center;font-size:.78rem}.qr-stage .qr-load-status{min-height:1.2em;color:var(--muted);font-weight:700}.qr-stage .qr-load-status.good{color:var(--green)}.qr-stage .qr-load-status.bad{color:var(--red)}.qr-stage .qr-load-status:empty{display:none}.qr-stage .qr-load-status+button{justify-self:center}.session-manager{padding-top:11px;border-top:1px solid var(--line-soft)}.session-manager>summary{cursor:pointer;color:var(--muted);font-size:.8rem;font-weight:700}.session-manager[open]>summary{color:var(--text)}.session-manager-body{display:grid;gap:13px;padding-top:12px}.session-replace{display:grid;gap:9px;padding:13px;border:1px solid #cfe2d5;border-radius:11px;background:#f4faf6}.session-replace strong{color:#294a35;font-size:.8rem}.session-replace p{margin:0;font-size:.75rem}.session-replace button{justify-self:start}.danger-zone{padding-top:11px;border-top:1px solid var(--line-soft)}.danger-zone summary{cursor:pointer;color:var(--muted);font-size:.8rem;font-weight:700}.danger-zone[open] summary{color:var(--red)}.danger-zone label,.danger-zone p,.danger-zone button{margin-top:10px}.danger-zone p{font-size:.75rem;margin-bottom:0}
@media(max-width:1100px){.summary-grid{grid-template-columns:repeat(2,1fr)}.diagnostic-grid{grid-template-columns:repeat(3,1fr)}.form-grid,.price-form{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:900px){.app-shell{display:block}.sidebar{position:sticky;height:auto;padding:12px 16px 10px;border-right:0;border-bottom:1px solid var(--line-soft)}.sidebar-brand{padding:0 0 10px}.sidebar-brand .brand-mark{width:33px;height:33px}.nav-tabs{display:flex;overflow:auto;gap:6px;padding-bottom:2px}.nav-tabs button{white-space:nowrap;min-height:38px;padding:7px 10px}.workspace{padding:24px 20px 60px}.setup-only .workspace{padding:22px 20px 60px}.loading-bar{left:0}.login-shell{grid-template-columns:1fr;gap:30px;max-width:660px}.login-brand h1{font-size:clamp(2.2rem,9vw,3.6rem)}}
@media(max-width:720px){body{font-size:14px}.workspace,.setup-only .workspace{padding:18px 12px 50px}.topbar{display:grid;gap:14px}.setup-only .topbar{align-items:start}.top-actions{width:100%}.sync-state{margin-right:auto;text-align:left;justify-items:start}.summary-grid,.content-grid.two,.usage-summary{grid-template-columns:1fr}.summary-card{min-height:122px}.summary-value{margin:12px 0 7px}.cost-banner,.section-intro,.panel-head,.group-card-head,.channel-card-head,.service-account-main,.service-account-heading{align-items:flex-start;flex-direction:column}.diagnostic-grid{grid-template-columns:repeat(2,1fr)}.form-grid,.price-form,.filter-grid,.service-settings-form{grid-template-columns:1fr}.service-settings-form>.credential-actions{grid-column:auto}.panel,.login-card{padding:16px;border-radius:15px}.setup-editor{padding:0}.login-shell{width:min(100% - 24px,660px);padding:30px 0}.login-brand{padding:8px}.channel-environment-nav{grid-template-columns:1fr;gap:10px}.refresh-action{width:100%}.channel-readiness{padding-bottom:16px}.environment-card,.channel-settings{border-radius:15px}.environment-head{padding:15px 16px 0}.environment-title{padding:10px 16px 14px}.environment-connections,.acceptance-routes{grid-template-columns:1fr}.environment-row,.connection-row{padding:14px 16px}.environment-row:first-child,.connection-row:first-child{border-right:0;border-bottom:1px solid var(--line-soft)}.environment-row{grid-template-columns:40px minmax(0,1fr)}.environment-row>.badge{grid-column:2;justify-self:start}.environment-footer{align-items:flex-start;flex-direction:column;padding:13px 16px}.connection-actions{grid-column:2}.acceptance-environment>.setup-checklist{grid-template-columns:1fr 1fr;padding:12px 16px}.setup-checklist li{justify-content:flex-start}.channel-settings-head{align-items:flex-start;padding:15px}.channel-panel>.panel-head,.channel-card{padding:15px}.form-section{grid-template-columns:1fr;gap:14px;padding:17px}.form-grid.two-fields{grid-template-columns:1fr}.form-grid.two-fields .wide-field{grid-column:auto}.setup-form-actions,.activation-bar{align-items:flex-start;flex-direction:column}.table-scroll{overflow:visible}table.responsive thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}table.responsive,table.responsive tbody,table.responsive tr,table.responsive td{display:block;width:100%}table.responsive tr{padding:10px 0;border-bottom:1px solid var(--line-soft)}table.responsive tr:last-child{border-bottom:0}table.responsive td{display:grid;grid-template-columns:minmax(105px,38%) minmax(0,1fr);gap:10px;border:0;padding:6px 3px;overflow-wrap:anywhere}table.responsive td:before{content:attr(data-label);color:var(--faint);font-size:.7rem;font-weight:700}table.responsive td:empty{display:none}.actions{flex-wrap:wrap}.group-body{padding:4px 14px 10px}}
@media(max-width:520px){.setup-section-nav button{display:flex;align-items:center;justify-content:center;min-height:52px;padding:9px}.setup-section-nav button>span,.setup-section-nav button small{display:none}.channel-environment-tab{min-height:54px;padding:10px 11px}.channel-environment-tab small{display:none}.channel-environment-tab>.badge{padding:3px 6px;font-size:.65rem}.route-map{grid-template-columns:minmax(0,1fr) 18px minmax(0,1fr)}.channel-settings-head{display:grid}.channel-settings-head button{justify-self:start}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition:none!important}}
`;

export const CONSOLE_JS = `"use strict";
let csrf=null;
let state={dashboard:null,economy:null,plans:[],prices:[],configuredModels:[],enrollments:[],attempts:[],usageSummary:null,audit:[],groupDetails:null,channels:null,coding:null};
let activeTab="overview",activeChannelEnvironment=null,channelSettingsTrigger=null,busy=false,groupLoading=false,channelLoading=false,activeLoad=null,authEpoch=0;
const byId=(id)=>document.getElementById(id);
const el=(tag,text,klass)=>{const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=String(text);if(klass)node.className=klass;return node};
const labels={
  cohort:{standard:"Standar",beta:"Beta"},kind:{private:"Pribadi",group:"Grup"},channel:{telegram:"Telegram",whatsapp:"WhatsApp",system:"Sistem"},
  mode:{direct_only:"Hanya saat dipanggil",ambient:"Boleh nimbrung",paused:"Dijeda",disabled:"Dinonaktifkan",none:"Tanpa mode",workspace:"Workspace"},
  audience:{personal:"Pribadi",group:"Grup",workspace:"Workspace"},planStatus:{pilot:"Pilot",active:"Aktif",retired:"Dipensiunkan"},
  consent:{not_invited:"Belum diundang",invited:"Menunggu persetujuan",granted:"Disetujui",withdrawn:"Dicabut",expired:"Kedaluwarsa"},
  origin:{primary:"Utama",fallback:"Cadangan"},tier:{cheap:"Ringan",efficient:"Efisien",ambitious:"Mendalam",toughest:"Eskalasi"},
  purpose:{"turn-boundary":"Batas giliran",understanding:"Pemahaman","due-date":"Membaca waktu","risk-triage":"Triase keselamatan","memory-privacy":"Privasi memori","group-ingress":"Ingress grup",reply:"Balasan","reply-review":"Review balasan",summary:"Ringkasan",agent:"Agent",research:"Research web","insight":"Catatan keselamatan",session:"Sesi","group-participation":"Rencana partisipasi grup","group-reply":"Balasan grup"},
  attemptStatus:{started:"Sedang berjalan",completed:"Selesai",http_error:"Gangguan HTTP",network_error:"Gangguan jaringan",timeout:"Waktu habis",cancelled:"Dibatalkan",response_rejected:"Respons ditolak",unknown:"Status belum dipastikan"},
  auditAction:{session_login:"Masuk Console",session_logout:"Keluar Console",enrollment_create:"Tambah akses",enrollment_update:"Ubah akses",evaluation_invite:"Undang evaluasi",evaluation_revoke:"Cabut evaluasi",plan_version_create:"Buat versi paket",price_version_create:"Buat versi harga",economy_credential_create:"Pasang BYOK",economy_credential_revoke:"Cabut BYOK",channel_pairing_start:"Mulai pairing kanal",channel_pairing_cancel:"Batalkan pairing kanal",channel_connection_verify:"Periksa koneksi kanal",channel_credential_update:"Perbarui credential kanal",channel_credential_revoke:"Cabut credential kanal",coding_configuration_update:"Ubah konfigurasi coding",coding_connection_verify:"Verifikasi koneksi coding",runtime_mode_update:"Ubah mode runtime",unknown_mutation:"Perubahan tidak dikenal"},
  outcome:{succeeded:"Berhasil",rejected:"Ditolak",failed:"Gagal"},
  source:{provider:"Dilaporkan provider",catalog:"Katalog saat request","current_catalog_estimate":"Estimasi tarif sekarang",unavailable:"Belum dapat dihitung",unpriced:"Belum bertarif"}
};
const pageCopy={overview:["Ringkasan","Kesehatan dan biaya operasional dalam 24 jam terakhir."],channels:["Kanal","Hubungkan layanan dan lingkungan pengujian Harvy tanpa mencampur identitasnya."],compute:["Komputer kerja","Hubungkan sandbox Linux dan Git lokal dengan bukti conformance yang dipin."],github:["GitHub","Kelola GitHub App dan Broker tanpa memberikan personal access token kepada Harvy."],access:["Akses","Atur pengguna, grup, paket, dan persetujuan evaluasi."],groups:["Grup","Pantau biaya grup dan bucket anggota pemicu secara pseudonim."],plans:["Paket","Lihat batas dan posisi katalog paket pilot."],prices:["Harga model","Tetapkan harga untuk model yang ditemukan dari environment."],usage:["Penggunaan","Telusuri attempt provider, token, dan asal biayanya."],audit:["Audit","Periksa perubahan operator tanpa membuka isi percakapan."]};
class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code}}
async function api(path,options={}){
  const headers={...(options.headers||{})};
  if(options.body!==undefined)headers["content-type"]="application/json";
  if(csrf&&options.method&&options.method!=="GET")headers["x-csrf-token"]=csrf;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(path,{...options,headers,signal:controller.signal,body:options.body===undefined?undefined:JSON.stringify(options.body)});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new ApiError(payload.error?.message||"Permintaan gagal.",response.status,payload.error?.code||null);
    return payload;
  }catch(error){
    if(error?.name==="AbortError")throw new ApiError("Permintaan terlalu lama. Periksa proses Harvy lalu coba lagi.",0,"timeout");
    throw error;
  }finally{clearTimeout(timer)}
}
function readable(value){if(value===null||value===undefined||value==="")return "—";return String(value).replace(/[_-]+/g," ").replace(/\\b\\w/g,(letter)=>letter.toUpperCase())}
function translated(group,value){return labels[group]?.[value]||readable(value)}
function number(value){return new Intl.NumberFormat("id-ID").format(Number(value)||0)}
function rupiah(value){return new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(Number(value)||0)}
function money(nanos){
  if(nanos===null||nanos===undefined)return "—";
  const usd=Number(nanos)/1e9,digits=usd!==0&&Math.abs(usd)<.01?6:usd!==0&&Math.abs(usd)<1?4:2;
  return new Intl.NumberFormat("id-ID",{style:"currency",currency:"USD",minimumFractionDigits:digits,maximumFractionDigits:digits}).format(usd);
}
function dateTime(value){return value?new Intl.DateTimeFormat("id-ID",{dateStyle:"medium",timeStyle:"short"}).format(new Date(value)):"—"}
function localDateTime(value){const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)}
function shortRef(value,length=16){if(!value)return "—";return value.length>length?value.slice(0,length)+"…":value}
function badge(text,tone=""){return el("span",text,"badge"+(tone?" "+tone:""))}
function stack(primary,secondary){const node=el("div",null,"cell-stack");node.append(el("span",primary));if(secondary)node.append(el("small",secondary));return node}
function emptyState(title,detail,compact=false){const box=el("div",null,"empty-state"+(compact?" compact":"")),content=el("div");content.append(el("strong",title),el("p",detail));box.append(content);return box}
function table(headers,rows,captionText){
  if(rows.length===0)return emptyState("Belum ada data","Data akan muncul setelah Harvy menerima aktivitas yang sesuai.",true);
  const wrap=el("div",null,"table-scroll"),node=el("table",null,"responsive");
  if(captionText){const caption=el("caption",captionText);caption.className="visually-hidden";node.append(caption)}
  const head=el("thead"),headRow=el("tr");
  headers.forEach((header)=>{const th=el("th",header);th.scope="col";headRow.append(th)});head.append(headRow);node.append(head);
  const body=el("tbody");
  rows.forEach((cells)=>{const row=el("tr");cells.forEach((cell,index)=>{const td=el("td");td.dataset.label=headers[index]||"";if(cell instanceof Node)td.append(cell);else td.textContent=String(cell??"");row.append(td)});body.append(row)});
  node.append(body);wrap.append(node);return wrap;
}
function setBusy(value,quiet=false){busy=value;byId("main-content").setAttribute("aria-busy",String(value));byId("loading-bar").classList.toggle("hidden",!value||quiet);byId("refresh").disabled=value;byId("refresh").setAttribute("aria-label",value?"Sedang menyegarkan data":"Segarkan data")}
function showNotice(message,tone="success"){const box=byId("notice");box.textContent=message;box.className="notice"+(tone==="warning"?" warning":"")+(message?"":" hidden");clearTimeout(showNotice.timer);if(message)showNotice.timer=setTimeout(()=>box.classList.add("hidden"),5500)}
function userError(message){return Object.assign(new Error(message),{userFacing:true})}
function safeErrorMessage(error){return error instanceof ApiError||error?.userFacing===true?error.message:"Antarmuka Console tidak dapat merender data. Muat ulang halaman. Kode: CONSOLE_UI_RENDER_FAILED."}
function showGlobalError(error){if(!(error instanceof ApiError)&&error?.userFacing!==true)console.error("HARVY_CONSOLE_UI_RENDER_FAILED");byId("global-error-text").textContent=safeErrorMessage(error);byId("global-error").classList.remove("hidden")}
function clearGlobalError(){byId("global-error").classList.add("hidden")}
async function withButton(button,pendingLabel,operation){const previous=button.textContent;button.disabled=true;button.textContent=pendingLabel;try{return await operation()}catch(error){showGlobalError(error);throw error}finally{button.disabled=false;button.textContent=previous;if(button.id==="price-submit")validatePriceForm();if(state.channels&&button.closest("#tab-channels")){try{renderChannels()}catch(error){showGlobalError(error)}}}}
function latestPlans(){const map=new Map();state.plans.forEach((plan)=>{if(!map.has(plan.planId))map.set(plan.planId,plan)});return [...map.values()]}
function latestModelPrice(model){return state.prices.find((price)=>price.providerId===model.providerId&&price.modelId===model.modelId&&price.effectiveTo===null&&price.status!=="retired")||state.prices.find((price)=>price.providerId===model.providerId&&price.modelId===model.modelId)||null}
function costPresentation(summary){
  const coverage=summary.costCoverage||(summary.costCompleteness==="complete"?"complete":summary.costCompleteness==="partial"?"partial":"unavailable");
  const amount=summary.indicativeCostUsdNanos??summary.effectiveCostUsdNanos;
  if(summary.attempts===0)return {value:money("0"),detail:"Belum ada request model",coverage:"complete"};
  if(coverage==="complete")return {value:money(amount),detail:"Seluruh biaya memiliki sumber tercatat",coverage};
  if(coverage==="estimated")return {value:"≈ "+money(amount),detail:number(summary.currentPriceEstimatedAttempts)+" attempt lama memakai tarif terbaru",coverage};
  if(coverage==="partial")return {value:"≈ "+money(amount)+" + tertunda",detail:number(summary.unavailableCostAttempts)+" attempt belum dapat dihitung",coverage};
  return {value:"Belum dapat dihitung",detail:"Harga atau usage provider belum tersedia",coverage};
}
function costBadge(summary){const view=costPresentation(summary),label=view.coverage==="complete"?"Tercatat penuh":view.coverage==="estimated"?"Mengandung estimasi":view.coverage==="partial"?"Sebagian tertunda":"Belum dapat dihitung";return badge(label,view.coverage==="complete"?"good":view.coverage==="unavailable"?"bad":"warn")}
function renderSummary(){
  if(!state.dashboard)return;
  const summary=state.dashboard.usage,entitlement=state.dashboard.entitlement,cost=costPresentation(summary),fallbackRate=summary.attempts?summary.fallbackAttempts/summary.attempts:0;
  const cards=[
    {label:"Biaya model",value:cost.value,detail:cost.detail,primary:true},
    {label:"Token aktual",value:number(summary.totalTokens),detail:number(summary.inputTokens)+" masuk · "+number(summary.outputTokens)+" keluar"},
    {label:"Request logis",value:number(summary.logicalRequests),detail:number(summary.attempts)+" attempt provider"},
    {label:"Fallback",value:new Intl.NumberFormat("id-ID",{style:"percent",maximumFractionDigits:1}).format(fallbackRate),detail:number(summary.fallbackAttempts)+" attempt cadangan"}
  ];
  const box=byId("summary-cards");box.replaceChildren();
  cards.forEach((item)=>{const card=el("article",null,"summary-card"+(item.primary?" primary":""));card.append(el("span",item.label,"summary-label"),el("strong",item.value,"summary-value"),el("span",item.detail,"summary-detail"));box.append(card)});
  const banner=byId("cost-banner");
  if(cost.coverage==="complete"){banner.classList.add("hidden");banner.replaceChildren()}
  else{
    const copy=el("div");
    copy.append(el("strong",cost.coverage==="estimated"?"Biaya memuat estimasi transparan.":"Sebagian biaya belum dapat dihitung."),el("span",cost.coverage==="estimated"?"Attempt lama tidak memiliki snapshot harga. Nilainya dihitung secara read-only memakai tarif aktif sekarang.":"Buka katalog harga untuk memastikan setiap model memiliki tarif; usage provider yang hilang tetap tidak dipaksa menjadi nol."));
    const action=el("button","Atur harga","ghost compact");action.type="button";action.addEventListener("click",()=>switchTab("prices",true));banner.replaceChildren(copy,action);banner.classList.remove("hidden");
  }
  const diagnostics=[
    ["Input perkiraan saat request",number(summary.inputTokenEstimateRequested)],["Batas output diminta",number(summary.maxOutputTokensRequested)],
    ["Token didebit",number(entitlement.debitedTokens)],["Overhead termasuk paket",number(entitlement.includedTokens)],["Keselamatan bebas kuota",number(entitlement.safetyExemptTokens)],
    ["Usage diperkirakan",number(summary.estimatedAttempts)],["Harga historis tidak ada",number(summary.historicalPriceGapAttempts??summary.unpricedAttempts)],["Menunggu data provider",number(summary.missingUsageAttempts??summary.pendingAttempts)]
  ];
  const diagnosticBox=byId("diagnostic-metrics");diagnosticBox.replaceChildren();
  diagnostics.forEach(([label,value])=>{const item=el("div",null,"diagnostic-item");item.append(el("span",label),el("strong",value));diagnosticBox.append(item)});
}
function computeAmount(value){try{return new Intl.NumberFormat("id-ID").format(BigInt(value||"0"))}catch{return "—"}}
function renderEconomy(){
  const box=byId("economy-summary"),detail=byId("economy-detail"),economy=state.economy;
  box.replaceChildren();
  if(!economy){box.append(emptyState("Data economy belum tersedia","Runtime lama atau endpoint economy belum aktif.",true));detail.textContent="";return}
  const latest=new Map(),now=Date.now();economy.periods.forEach((period)=>{if(Date.parse(period.startsAt)>now||Date.parse(period.endsAt)<=now)return;const current=latest.get(period.subjectRef);if(!current||period.startsAt>current.startsAt)latest.set(period.subjectRef,period)});
  const includedRemaining=[...latest.values()].reduce((sum,period)=>sum+BigInt(period.includedGranted||"0")-BigInt(period.includedUsed||"0")-BigInt(period.includedReserved||"0"),0n);
  const reserved=[...latest.values()].reduce((sum,period)=>sum+BigInt(period.includedReserved||"0"),0n);
  const wallet=economy.walletAccounts.reduce((sum,item)=>sum+BigInt(item.availableComputeUnits||"0"),0n);
  const sponsored=economy.sponsoredGrants.filter((item)=>Date.parse(item.effectiveFrom)<=now&&(item.expiresAt===null||Date.parse(item.expiresAt)>now)).reduce((sum,item)=>sum+BigInt(item.amount||"0")-BigInt(item.used||"0")-BigInt(item.reserved||"0"),0n);
  const activeSubscriptions=economy.subscriptions.filter((item)=>["trial","active","past_due","cancel_at_period_end"].includes(item.status)).length;
  const activeCredentials=economy.credentials.filter((item)=>item.status==="active").length;
  [["Subject dengan periode",number(latest.size)], ["Included tersisa",computeAmount(includedRemaining.toString())], ["Reserved",computeAmount(reserved.toString())], ["Wallet PAYG",computeAmount(wallet.toString())], ["Sponsored tersisa",computeAmount(sponsored.toString())], ["BYOK aktif",number(activeCredentials)], ["Subscription aktif",number(activeSubscriptions)], ["Settlement logical",number(economy.settlements.length)]].forEach(([label,value])=>{const chip=el("div",null,"usage-chip");chip.append(el("span",label),el("strong",value));box.append(chip)});
  const costByFunding=state.dashboard?.economy?.physicalCostByFundingSource||{};
  const costText=Object.keys(costByFunding).length
    ? " Biaya provider 24 jam per funding: "+Object.entries(costByFunding).map(([source,value])=>source+"="+computeAmount(value)+" nanos USD").join(", ")+"."
    : "";
  const byokSetup=economy.secureByokSetupAvailable?" Secure setup BYOK lokal tersedia melalui API Console terautentikasi.":" Secure setup BYOK belum dikonfigurasi; raw key tidak dapat diterima.";
  detail.textContent="Projection allowance dibaca dari periode terbaru tiap subject; ledger reservation, payment, dan provider cost tetap dapat direkonsiliasi tanpa membuka isi percakapan."+byokSetup+costText;
}
function breakdownRows(items,key){return items.map((item)=>{const cost=costPresentation(item.summary);return [key==="cohort"?translated("cohort",item[key]):item[key],number(item.summary.logicalRequests),number(item.summary.totalTokens),stack(cost.value,cost.detail),costBadge(item.summary)]})}
function renderBreakdowns(){const breakdown=state.dashboard?.breakdown||{byCohort:[],byPlan:[]};byId("cohort-breakdown").replaceChildren(table(["Akses","Request","Token","Biaya indikatif","Cakupan"],breakdownRows(breakdown.byCohort,"cohort"),"Penggunaan per akses"));byId("plan-breakdown").replaceChildren(table(["Paket","Request","Token","Biaya indikatif","Cakupan"],breakdownRows(breakdown.byPlan,"planId"),"Penggunaan per paket"))}
function renderPlans(){const rows=latestPlans().map((plan)=>[stack(plan.publicName,plan.planId),translated("audience",plan.audience),rupiah(plan.monthlyPriceIdr),stack(computeAmount(plan.computePolicy?.includedComputeUnits||"0"),"periode "+(plan.computePolicy?.billingPeriodDays||"—")+" hari"),stack(computeAmount(plan.computePolicy?.rollingComputeLimit||"0"),"rolling anti-abuse"),plan.activeMemberLimit===null?"—":number(plan.activeMemberLimit),translated("mode",plan.groupMode),badge(translated("planStatus",plan.status),plan.status==="active"?"good":plan.status==="retired"?"bad":"warn")]);byId("plans").replaceChildren(table(["Paket","Audiens","Harga / bulan","Compute termasuk","Ceiling rolling","Anggota aktif","Mode","Status"],rows,"Katalog paket"))}
function selectedConfiguredModel(){const index=Number(byId("price-model").value);return Number.isSafeInteger(index)?state.configuredModels[index]||null:null}
function normalizeDecimal(value){return value.trim().replace(",",".")}
function validPrice(value){return /^(?:0|[1-9]\\d*)(?:\\.\\d{1,12})?$/.test(normalizeDecimal(value))}
function syncPriceInputs(){const model=selectedConfiguredModel(),price=model?latestModelPrice(model):null;byId("price-input").value=price?.rates.inputPerMillionUsd||"";byId("price-output").value=price?.rates.outputPerMillionUsd||"";byId("price-input").dataset.original=byId("price-input").value;byId("price-output").dataset.original=byId("price-output").value;validatePriceForm()}
function validatePriceForm(){
  const input=byId("price-input"),output=byId("price-output"),inputOk=validPrice(input.value),outputOk=validPrice(output.value);
  byId("price-input-error").textContent=input.value&&!inputOk?"Gunakan angka USD positif atau nol, misalnya 0,30.":"";
  byId("price-output-error").textContent=output.value&&!outputOk?"Gunakan angka USD positif atau nol, misalnya 2,50.":"";
  const unchanged=normalizeDecimal(input.value)===normalizeDecimal(input.dataset.original||"")&&normalizeDecimal(output.value)===normalizeDecimal(output.dataset.original||"");
  byId("price-submit").disabled=!selectedConfiguredModel()||!inputOk||!outputOk||unchanged;return inputOk&&outputOk&&!unchanged;
}
function renderPrices(){
  const select=byId("price-model"),previous=select.value;select.replaceChildren();
  state.configuredModels.forEach((model,index)=>{const option=el("option",model.providerId+" / "+model.modelId+(model.active?" · aktif":" · tidak aktif"));option.value=String(index);option.selected=previous===option.value;select.append(option)});
  if(select.selectedIndex<0&&state.configuredModels.length){const activeIndex=state.configuredModels.findIndex((model)=>model.active);select.selectedIndex=activeIndex>=0?activeIndex:0}
  const inventory=byId("configured-models");inventory.replaceChildren();
  if(!state.configuredModels.length)inventory.append(emptyState("Belum ada model di environment","Isi slot AI_MODEL_* lalu mulai ulang Harvy. Console tidak membuat ID model sendiri."));
  else state.configuredModels.forEach((model)=>{
    const current=latestModelPrice(model),card=el("article",null,"model-card"),head=el("div",null,"model-card-head"),title=el("div");
    title.append(el("h3",model.modelId),el("p",model.providerId));head.append(title,badge(model.active?"Aktif di runtime":"Tersedia, tidak aktif",model.active?"good":""));
    const sources=model.sources.map((source)=>translated("origin",source.origin)+" · "+readable(source.mode)+" · "+source.tiers.map((tier)=>translated("tier",tier)).join(", ")).join(" | "),env=model.sources.map((source)=>source.environmentVariable).join(", ");
    const rates=el("div",null,"model-price"),input=el("div"),output=el("div");
    input.append(el("span","INPUT / 1 JUTA"),el("strong",current?"US$"+current.rates.inputPerMillionUsd:"Belum diberi harga"));
    output.append(el("span","OUTPUT / 1 JUTA"),el("strong",current?"US$"+current.rates.outputPerMillionUsd:"Belum diberi harga"));rates.append(input,output);
    card.append(head,el("p",sources),el("p","Slot: "+env),rates);inventory.append(card);
  });
  syncPriceInputs();
  const rows=state.prices.map((price)=>[stack(price.modelId,price.providerId),"v"+number(price.version),"US$"+price.rates.inputPerMillionUsd,"US$"+price.rates.outputPerMillionUsd,stack(dateTime(price.effectiveFrom),price.effectiveTo?"Berakhir "+dateTime(price.effectiveTo):"Masih berlaku"),badge(translated("planStatus",price.status),price.status==="retired"?"bad":price.effectiveTo===null?"good":"")]);
  byId("prices").replaceChildren(table(["Model","Versi","Input / 1 juta","Output / 1 juta","Masa berlaku","Status"],rows,"Riwayat harga model"));
}
function renderEnrollments(){
  const plans=latestPlans();byId("enrollment-count").textContent=number(state.enrollments.length)+" akses";
  const rows=state.enrollments.map((item)=>{
    const labelInput=el("input");labelInput.maxLength=64;labelInput.placeholder="Label pseudonim";labelInput.value=item.operatorLabel||"";labelInput.setAttribute("aria-label","Label pseudonim untuk "+shortRef(item.subjectRef));
    const cohort=el("select");cohort.setAttribute("aria-label","Akses untuk "+(item.operatorLabel||shortRef(item.subjectRef)));
    ["standard","beta"].forEach((value)=>{const option=el("option",translated("cohort",value));option.value=value;option.selected=item.cohort===value;cohort.append(option)});
    const plan=el("select");plan.setAttribute("aria-label","Paket untuk "+(item.operatorLabel||shortRef(item.subjectRef)));
    plans.filter((candidate)=>item.kind==="private"?candidate.audience==="personal":candidate.audience!=="personal").forEach((candidate)=>{const option=el("option",candidate.publicName);option.value=candidate.planId;option.selected=item.planId===candidate.planId;plan.append(option)});
    const mode=item.kind==="group"?el("select"):el("span","—");
    if(item.kind==="group"){mode.setAttribute("aria-label","Mode grup "+(item.operatorLabel||shortRef(item.subjectRef)));["direct_only","ambient","paused","disabled"].forEach((value)=>{const option=el("option",translated("mode",value));option.value=value;option.selected=item.groupRuntimeMode===value;mode.append(option)})}
    const quota=el("input");quota.type="number";quota.min="0";quota.placeholder="Ikuti paket";quota.value=item.quotaOverride??"";quota.setAttribute("aria-label","Override kuota untuk "+(item.operatorLabel||shortRef(item.subjectRef)));
    const expiry=el("input");expiry.type="datetime-local";expiry.setAttribute("aria-label","Masa beta untuk "+(item.operatorLabel||shortRef(item.subjectRef)));if(item.betaExpiresAt&&Date.parse(item.betaExpiresAt)>Date.now())expiry.value=localDateTime(item.betaExpiresAt);
    const actions=el("div",null,"actions"),save=el("button","Simpan","compact");save.type="button";
    save.addEventListener("click",()=>withButton(save,"Menyimpan…",async()=>{
      clearGlobalError();const body={operatorLabel:labelInput.value||null,cohort:cohort.value,planId:plan.value,quotaOverride:quota.value===""?null:Number(quota.value),betaExpiresAt:expiry.value?new Date(expiry.value).toISOString():null};if(item.kind==="group")body.groupRuntimeMode=mode.value;
      await api("/api/v1/enrollments/"+encodeURIComponent(item.subjectRef),{method:"PUT",headers:{"if-match":String(item.version)},body});await load({quiet:true,requireFresh:true});showNotice("Akses berhasil diperbarui.");
    }).catch(()=>{}));
    const granted=item.evaluationConsent.status==="granted",consent=el("button",granted?"Cabut evaluasi":"Undang evaluasi","ghost compact");consent.type="button";
    consent.addEventListener("click",()=>withButton(consent,granted?"Mencabut…":"Mengundang…",async()=>{
      clearGlobalError();const operation=granted?"revoke":"invite";await api("/api/v1/evaluation-consents/"+encodeURIComponent(item.subjectRef)+"/"+operation,{method:"POST",headers:{"if-match":String(item.version)},body:{}});await load({quiet:true,requireFresh:true});showNotice(granted?"Persetujuan evaluasi dicabut.":"Undangan dicatat; persetujuan belum otomatis diberikan.");
    }).catch(()=>{}));actions.append(save,consent);
    return [labelInput,stack(shortRef(item.subjectRef),translated("kind",item.kind)+" · "+translated("channel",item.channel)),cohort,plan,mode,quota,expiry,badge(translated("consent",item.evaluationConsent.status),granted?"good":item.evaluationConsent.status==="invited"?"warn":""),actions];
  });
  byId("enrollments").replaceChildren(table(["Label","Scope","Akses","Paket","Mode","Override token","Beta sampai","Evaluasi","Aksi"],rows,"Daftar akses Harvy"));
}
function groupCost(member){const view=costPresentation({attempts:member.attempts,costCoverage:member.costCoverage,indicativeCostUsdNanos:member.indicativeCostUsdNanos,effectiveCostUsdNanos:member.costUsdNanos,currentPriceEstimatedAttempts:member.currentPriceEstimatedAttempts,unavailableCostAttempts:member.unavailableCostAttempts});return stack(view.value,view.detail)}
function groupStatus(member){
  if(member.pendingAttempts)return badge(number(member.pendingAttempts)+" menunggu provider","warn");
  if(member.costCoverage==="complete")return badge("Tercatat penuh","good");
  if(member.costCoverage==="estimated")return badge("Mengandung estimasi","warn");
  if(member.costCoverage==="partial")return badge("Sebagian tertunda","warn");
  return badge("Belum dapat dihitung","bad");
}
function renderGroups(){
  const box=byId("groups");box.replaceChildren();const details=state.groupDetails;
  if(details===null){box.append(emptyState("Memuat data grup…","Penggunaan anggota dimuat terpisah agar Console lain tetap dapat digunakan."));return}
  if(details.length===0){box.append(emptyState("Belum ada grup","Tambahkan akses grup dari halaman Akses untuk mulai memantau penggunaan."));return}
  const list=el("div",null,"group-list"),planNames=new Map(latestPlans().map((plan)=>[plan.planId,plan.publicName]));
  details.forEach(({group,members,error})=>{
    const card=el("article",null,"group-card"),head=el("div",null,"group-card-head"),title=el("div");title.append(el("h3",group.operatorLabel||shortRef(group.subjectRef,22)),el("p",(planNames.get(group.planId)||group.planId)+" · "+translated("cohort",group.cohort)));
    const meta=el("div",null,"group-meta");meta.append(badge(translated("mode",group.groupRuntimeMode||"direct_only"),group.groupRuntimeMode==="disabled"?"bad":group.groupRuntimeMode==="paused"?"warn":"good"));head.append(title,meta);
    const body=el("div",null,"group-body");
    if(error){const retry=el("button","Coba muat lagi","ghost compact");retry.type="button";retry.addEventListener("click",()=>loadGroups(true));const empty=emptyState("Penggunaan grup belum termuat",error,true);empty.append(retry);body.append(empty)}
    else if(!members.length)body.append(emptyState("Belum ada penggunaan","Harvy belum memanggil model untuk grup ini selama masa retensi ledger.",true));
    else{const rows=members.map((member)=>[member.actorRef==="shared"?"Bersama":shortRef(member.actorRef),number(member.attempts),number(member.tokens),groupCost(member),groupStatus(member)]);body.append(table(["Bucket pemicu","Percobaan","Token","Biaya indikatif","Status data"],rows,"Penggunaan anggota grup"))}
    card.append(head,body);list.append(card);
  });box.append(list);
}
function pairingActive(item){return ["connecting","awaiting_scan","awaiting_password","revoking"].includes(item.phase)}
const pairingErrorMessages={
  CHANNEL_WHATSAPP_CONNECTION_CLOSED:"Sesi tidak lagi diterima WhatsApp. Pasangkan ulang untuk membuat koneksi baru.",
  CHANNEL_WHATSAPP_SESSION_REJECTED:"Pairing sempat tersambung, tetapi sesi tersimpan ditolak saat diperiksa ulang. Pasangkan ulang akun ini.",
  CHANNEL_WHATSAPP_SESSION_REVOKED:"Sesi telah dicabut dari WhatsApp. Pasangkan ulang untuk melanjutkan.",
  CHANNEL_WHATSAPP_REPLACE_TIMEOUT:"Pemulihan belum selesai dalam batas waktu. Pastikan ponsel terhubung lalu coba lagi.",
  CHANNEL_WHATSAPP_REPLACE_FAILED:"Sesi belum dapat dipulihkan. Pastikan ponsel terhubung lalu coba lagi.",
  CHANNEL_WHATSAPP_PAIRING_TIMEOUT:"QR kedaluwarsa sebelum pairing selesai. Mulai pairing kembali.",
  CHANNEL_WHATSAPP_REVOKE_TIMEOUT:"Pencabutan belum dapat dibuktikan. Credential lokal tetap aman dan belum dihapus."
};
function pairingErrorDetail(item){return pairingErrorMessages[item.errorCode]||"Operasi belum selesai. Credential lokal tidak diubah; coba kembali dari pengelolaan sesi."}
function pairingPresentation(item){
  if(item.phase==="connecting")return ["Menghubungkan","Console sedang membuka koneksi aman.","warn"];
  if(item.phase==="awaiting_scan")return ["Menunggu scan","QR hanya hidup sementara di browser ini.","warn"];
  if(item.phase==="awaiting_password")return ["Perlu password 2FA","Kirim password dua langkah; nilainya tidak disimpan.","warn"];
  if(item.phase==="revoking")return ["Mencabut session","Console sedang logout ke platform sebelum menghapus lokal.","warn"];
  if(item.phase==="error")return ["Perlu tindakan",pairingErrorDetail(item),"bad"];
  if(item.session?.status==="checking")return ["Memeriksa sesi","Credential lokal ditemukan; Console sedang meminta bukti langsung dari WhatsApp.","warn"];
  if(item.session?.status==="accepted")return ["Sesi valid","WhatsApp menerima sesi ini pada pemeriksaan koneksi terbaru.","good"];
  if(item.session?.status==="rejected")return ["Sesi ditolak","Credential lokal masih ada, tetapi WhatsApp menolaknya. Pasangkan ulang sesi ini.","bad"];
  if(item.session?.status==="unreachable")return ["Belum terverifikasi","Credential lokal ada, tetapi WhatsApp tidak dapat dijangkau saat pemeriksaan terakhir. Segarkan untuk mencoba lagi.","warn"];
  if(item.session?.status==="unchecked")return ["Belum diperiksa","Credential lokal ada, tetapi validitasnya ke WhatsApp belum dibuktikan.","warn"];
  if(item.configured)return ["Credential tersimpan","Credential lokal tersedia; status koneksi belum diperiksa oleh Console.","warn"];
  return ["Belum dipasangkan","Mulai pairing dengan akun khusus pengujian.",""];
}
function renderPairingControls(prefix,item){
  const stored=item.configured===true,isWhatsApp=Boolean(item.session),ready=stored&&(!isWhatsApp||item.session.status==="accepted"),active=pairingActive(item),card=byId(prefix+"-card");
  const wasReady=card.dataset.ready==="true";card.classList.toggle("ready",ready);card.dataset.ready=String(ready);
  const setup=byId(prefix+"-setup")||byId(prefix+"-form");if(setup)setup.classList.toggle("hidden",stored||active);
  const recovery=stored&&(item.phase==="error"||item.session?.status==="rejected"),manage=byId(prefix+"-manage");if(manage){manage.classList.toggle("hidden",!stored||active);if(recovery&&!active)manage.open=true;else if(!stored||active)manage.open=false}
  const manageSummary=byId(prefix+"-manage-summary");if(manageSummary){const subject=prefix==="whatsapp-harvy"?"sesi Harvy":"sesi penguji";manageSummary.textContent=recovery?"Pulihkan "+subject:"Kelola "+subject}
  if(wasReady&&!ready){const dedicated=byId(prefix+"-dedicated");if(dedicated)dedicated.checked=false;const replaceConfirm=byId(prefix+"-replace-confirm");if(replaceConfirm)replaceConfirm.checked=false}
}
function setQrImageState(prefix,status){
  const surface=byId(prefix+"-qr"),message=byId(prefix+"-qr-load-status"),retry=byId(prefix+"-qr-retry");
  surface.dataset.loadState=status;surface.classList.toggle("qr-loading",status==="loading");surface.classList.toggle("qr-failed",status==="error");
  message.textContent=status==="loading"?"Memuat QR…":status==="ready"?"QR siap dipindai.":status==="error"?"QR gagal dimuat. Pairing tetap berjalan.":"";
  message.className="qr-load-status"+(status==="ready"?" good":status==="error"?" bad":"");retry.classList.toggle("hidden",status!=="error");retry.disabled=status==="loading";
}
function parseQrSvg(source){
  if(typeof source!=="string"||source.length<100||source.length>500000)throw new Error("QR_SVG_INVALID_SIZE");
  const parsed=new DOMParser().parseFromString(source,"image/svg+xml"),root=parsed.documentElement;
  if(root.localName!=="svg"||root.namespaceURI!=="http://www.w3.org/2000/svg"||root.querySelector("parsererror,script,foreignObject,image,use,style"))throw new Error("QR_SVG_INVALID_ROOT");
  const children=[...root.children],background=children[0],path=children[1],commands=path?.getAttribute("d")||"";
  if(children.length!==2||background?.localName!=="rect"||path?.localName!=="path"||background.getAttribute("fill")!=="#fff"||path.getAttribute("fill")!=="#000"||!/^(?:M\\d+ \\d+h1v1h-1z)+$/u.test(commands))throw new Error("QR_SVG_INVALID_CONTENT");
  for(const element of [root,...children])for(const attribute of [...element.attributes])if(attribute.name.toLowerCase().startsWith("on"))throw new Error("QR_SVG_EVENT_ATTRIBUTE");
  root.removeAttribute("role");root.setAttribute("aria-hidden","true");root.setAttribute("focusable","false");
  return document.importNode(root,true);
}
function requestQrImage(prefix,path,revision,attempt=0){
  const surface=byId(prefix+"-qr"),stage=byId(prefix+"-qr-stage"),revisionKey=String(revision),requestId=String(Number(surface.dataset.requestId||"0")+1);
  surface.dataset.path=path;surface.dataset.revision=revisionKey;surface.dataset.requestId=requestId;surface.dataset.attempt=String(attempt);surface.replaceChildren();setQrImageState(prefix,"loading");
  const current=()=>surface.dataset.requestId===requestId&&surface.dataset.revision===revisionKey&&!stage.classList.contains("hidden");
  const failed=()=>{if(!current())return;if(attempt<1){setTimeout(()=>{if(current())requestQrImage(prefix,path,revision,attempt+1)},220);return}setQrImageState(prefix,"error")};
  const url=path+"?revision="+encodeURIComponent(revisionKey)+"&attempt="+attempt+"&request="+encodeURIComponent(requestId);
  void fetch(url,{method:"GET",credentials:"same-origin",cache:"no-store",headers:{accept:"image/svg+xml"}}).then(async(response)=>{
    if(response.status===401){if(current())showLogin();throw new Error("QR_AUTHENTICATION_REQUIRED")}
    if(!response.ok||!String(response.headers.get("content-type")||"").toLowerCase().startsWith("image/svg+xml"))throw new Error("QR_RESPONSE_INVALID");
    const svg=parseQrSvg(await response.text());if(!current())return;surface.replaceChildren(svg);setQrImageState(prefix,"ready");
  }).catch(failed);
}
function retryQrImage(prefix){
  const surface=byId(prefix+"-qr"),revision=Number(surface.dataset.revision),path=surface.dataset.path;
  if(!path||!Number.isSafeInteger(revision)||revision<1)return;requestQrImage(prefix,path,revision,0);
}
function syncQr(prefix,item,path){
  const stage=byId(prefix+"-qr-stage"),surface=byId(prefix+"-qr"),visible=item.qrAvailable===true&&item.phase==="awaiting_scan";
  stage.classList.toggle("hidden",!visible);
  if(visible&&surface.dataset.revision!==String(item.qrRevision))requestQrImage(prefix,path,item.qrRevision);
  if(!visible){surface.replaceChildren();for(const key of ["path","revision","requestId","attempt","loadState"])delete surface.dataset[key];setQrImageState(prefix,"idle")}
}
function renderPairing(prefix,item,qrPath){
  const [label,detail,tone]=pairingPresentation(item),status=byId(prefix+"-status");
  status.textContent=label;status.className="badge"+(tone?" "+tone:"");byId(prefix+"-detail").textContent=detail;
  renderPairingControls(prefix,item);syncQr(prefix,item,qrPath);
  const cancel=byId(prefix+"-cancel");if(cancel)cancel.classList.toggle("hidden",!pairingActive(item));
  const pair=byId(prefix+"-pair");if(pair)pair.disabled=pairingActive(item)||item.configured===true;
}
function setChannelBadge(id,label,tone){const badge=byId(id);badge.textContent=label;badge.className="badge"+(tone?" "+tone:"")}
function setConnectionStatus(id,label,tone){const status=byId(id);status.textContent=label;status.className="connection-status"+(tone?" "+tone:"")}
function primaryTelegramPresentation(item){
  if(item.source==="conflict"||item.phase==="error")return ["Perlu tindakan",item.source==="conflict"?"Credential Console dan environment bertentangan. Selesaikan satu sumber sebelum menjalankan Harvy.":"Token layanan belum dapat diverifikasi. Periksa kembali token atau koneksi Telegram.","bad"];
  if(item.phase==="validating")return ["Memverifikasi","Console sedang meminta bukti langsung dari Telegram.","warn"];
  if(item.phase==="ready")return ["Bot valid",item.runtimeActive?(item.restartRequired?"Token valid tersimpan. Restart Harvy agar runtime memakainya.":"Token valid dan sedang dipakai runtime Harvy."):"Token valid tersimpan. Jalankan Harvy untuk mengaktifkan kanal Telegram.","good"];
  if(item.configured)return ["Credential tersimpan",item.source==="environment"?"Token masih berada di .env. Pindahkan ke Console agar hanya ada satu sumber credential.":item.runtimeActive&&item.restartRequired?"Perubahan tersimpan dan membutuhkan restart Harvy.":"Token tersimpan terenkripsi tetapi belum diperiksa pada proses Console ini.","warn"];
  return ["Belum dikonfigurasi","Tambahkan token BotFather untuk bot Telegram layanan.",""];
}
function primaryWhatsAppPresentation(item){
  if(item.source==="conflict"||item.configurationValid===false||item.phase==="error")return ["Perlu tindakan",item.source==="conflict"?"Konfigurasi Console dan environment bertumpuk. Selesaikan migrasi sebelum menjalankan Harvy.":"Satu sesi atau konfigurasi WhatsApp layanan perlu dipulihkan.","bad"];
  if(item.phase==="checking")return ["Memeriksa","Console sedang memeriksa sesi WhatsApp layanan.","warn"];
  if(item.runtimeActive&&!item.restartRequired)return [item.enabled?"Sedang digunakan":"Dinonaktifkan",item.enabled?String(item.accountCount||0)+" akun sedang dimiliki runtime Harvy.":"Armada tersimpan, tetapi layanan WhatsApp dinonaktifkan.",item.enabled?"good":"warn"];
  if(item.phase==="ready")return [item.enabled?"Siap":"Dinonaktifkan",item.enabled?String(item.accountCount||0)+" akun siap digunakan setelah Harvy dijalankan.":"Sesi tersimpan dan kanal sengaja dinonaktifkan.",item.enabled?"good":"warn"];
  if(item.source==="environment")return ["Masih dari .env","Pindahkan daftar akun dan pengaturan agar Console menjadi satu-satunya sumber.","warn"];
  if(item.source==="console"&&(item.accounts||[]).length>0)return ["Belum lengkap","Selesaikan atau periksa sesi akun yang ditandai.","warn"];
  return ["Belum dikonfigurasi","Tambahkan akun WhatsApp layanan dan pindai QR dari ponsel yang akan bertindak sebagai Harvy.",""];
}
function primaryWhatsAppPrefix(id){return "primary-whatsapp-account-"+String(id).toLocaleLowerCase("en-US")}
function createPrimaryWhatsAppAccountNode(account){
  const prefix=primaryWhatsAppPrefix(account.id),card=el("section",null,"service-account");card.id=prefix+"-card";card.dataset.accountId=account.id;
  const main=el("div",null,"service-account-main"),copy=el("div",null,"service-account-copy"),name=el("strong",account.id),detail=el("p","Belum diperiksa.");detail.id=prefix+"-detail";const status=el("span","Memeriksa","badge");status.id=prefix+"-status";copy.append(name,detail);main.append(copy,status);
  const actions=el("div",null,"service-account-actions"),pair=el("button","Lanjutkan pairing","ghost compact");pair.type="button";pair.dataset.primaryWhatsappAction="pair";pair.id=prefix+"-pair";const cancel=el("button","Batalkan operasi","ghost compact hidden");cancel.type="button";cancel.dataset.primaryWhatsappAction="cancel";cancel.id=prefix+"-cancel";actions.append(pair,cancel);
  const qrStage=el("div",null,"qr-stage hidden");qrStage.id=prefix+"-qr-stage";const qr=el("div",null,"qr-image");qr.id=prefix+"-qr";qr.setAttribute("role","img");qr.setAttribute("aria-label","QR pairing akun WhatsApp layanan "+account.id);const qrHelp=el("p","Pindai dari WhatsApp → Perangkat tertaut."),qrStatus=el("p",null,"qr-load-status");qrStatus.id=prefix+"-qr-load-status";qrStatus.setAttribute("aria-live","polite");const retry=el("button","Coba muat QR lagi","ghost compact hidden");retry.type="button";retry.id=prefix+"-qr-retry";retry.dataset.primaryWhatsappAction="retry";qrStage.append(qr,qrHelp,qrStatus,retry);
  const replaceManager=document.createElement("details");replaceManager.className="session-manager";replaceManager.id=prefix+"-replace-manager";const replaceSummary=el("summary","Pasangkan ulang sesi"),replaceBody=el("div",null,"session-manager-body"),replaceBox=el("div",null,"session-replace"),replaceText=el("p","Sesi lama dicabut lebih dulu. Alias dan routing Harvy tetap dipertahankan."),replaceLabel=el("label",null,"check-label"),replaceCheck=document.createElement("input");replaceCheck.type="checkbox";replaceCheck.id=prefix+"-replace-confirm";replaceLabel.append(replaceCheck,document.createTextNode("Saya siap memindai ulang akun layanan ini."));const replace=el("button","Cabut lalu pasangkan ulang");replace.type="button";replace.dataset.primaryWhatsappAction="replace";replace.id=prefix+"-replace";replaceBox.append(replaceText,replaceLabel,replace);replaceBody.append(replaceBox);replaceManager.append(replaceSummary,replaceBody);
  const danger=document.createElement("details");danger.className="service-account-danger";const summary=el("summary","Hapus akun dari layanan"),warning=el("p","Sesi akan dicabut dari WhatsApp, lalu alias dikeluarkan dari armada Harvy."),label=el("label","Ketik "+account.id+" untuk mengonfirmasi"),input=document.createElement("input");input.autocomplete="off";input.id=prefix+"-remove-confirm";label.htmlFor=input.id;label.append(input);const remove=el("button","Cabut dan hapus","ghost compact");remove.type="button";remove.dataset.primaryWhatsappAction="remove";remove.id=prefix+"-remove";danger.append(summary,warning,label,remove);
  card.append(main,actions,qrStage,replaceManager,danger);return card;
}
function renderPrimaryWhatsAppAccount(account,runtimeActive){
  const list=byId("primary-whatsapp-account-list"),prefix=primaryWhatsAppPrefix(account.id);let card=byId(prefix+"-card");if(!card){card=createPrimaryWhatsAppAccountNode(account);list.append(card)}
  card.dataset.accountId=account.id;const [baseLabel,baseDetail,tone]=pairingPresentation(account);let label=baseLabel,detail=baseDetail;
  if(account.lifecycle==="pending"&&!pairingActive(account)){label=account.phase==="error"?"Pairing gagal":"Menunggu pairing";detail=account.phase==="error"?baseDetail:"Alias tersimpan aman, tetapi sesi ini belum diaktifkan."}
  if(account.lifecycle==="removing"){label=pairingActive(account)?"Mencabut sesi":"Penghapusan tertunda";detail=pairingActive(account)?"Console sedang mencabut sesi sebelum menghapus alias.":"Lanjutkan penghapusan untuk membersihkan sesi dan alias."}
  const accountTone=tone||(account.lifecycle!=="active"?"warn":"");setChannelBadge(prefix+"-status",label,accountTone);byId(prefix+"-detail").textContent=detail;
  const busy=pairingActive(account),disabled=runtimeActive||busy;byId(prefix+"-pair").classList.toggle("hidden",account.lifecycle==="active"||account.lifecycle==="removing");byId(prefix+"-replace-manager").classList.toggle("hidden",account.lifecycle!=="active"||busy);byId(prefix+"-cancel").classList.toggle("hidden",!busy);byId(prefix+"-pair").disabled=disabled;byId(prefix+"-replace").disabled=disabled;byId(prefix+"-replace-confirm").disabled=disabled;byId(prefix+"-remove").disabled=runtimeActive||busy;
  syncQr(prefix,account,"/api/v1/channel-setup/primary/whatsapp/accounts/"+encodeURIComponent(account.id)+"/qr.svg");card.classList.toggle("ready",account.lifecycle==="active"&&account.session?.status==="accepted");
}
function renderPrimaryWhatsAppFleet(whatsapp){
  const [label,detail,tone]=primaryWhatsAppPresentation(whatsapp);setChannelBadge("primary-whatsapp-card-status",label,tone);byId("primary-whatsapp-card-detail").textContent=detail;byId("primary-whatsapp-card").classList.toggle("ready",whatsapp.phase==="ready"&&whatsapp.enabled===true);
  const runtimeActive=whatsapp.runtimeActive===true;byId("primary-whatsapp-runtime-note").classList.toggle("hidden",!runtimeActive);const legacy=whatsapp.source==="environment"||whatsapp.source==="conflict"&&whatsapp.legacyEnvironment===true;byId("primary-whatsapp-migrate-zone").classList.toggle("hidden",!legacy);byId("primary-whatsapp-migrate").disabled=runtimeActive||whatsapp.migrationAvailable!==true;
  const managed=whatsapp.source==="console"||whatsapp.source==="missing";byId("primary-whatsapp-managed-zone").classList.toggle("hidden",!managed);const settings=byId("primary-whatsapp-settings-form");if(!settings.contains(document.activeElement)){byId("primary-whatsapp-enabled").checked=whatsapp.enabled===true;byId("primary-whatsapp-private-enabled").checked=whatsapp.privateEnabled===true}settings.querySelectorAll("input,button").forEach((control)=>control.disabled=runtimeActive);
  const accounts=Array.isArray(whatsapp.accounts)?whatsapp.accounts:[],list=byId("primary-whatsapp-account-list"),known=new Set(accounts.map((account)=>primaryWhatsAppPrefix(account.id)+"-card"));list.querySelectorAll(".service-account").forEach((node)=>{if(!known.has(node.id))node.remove()});list.querySelector(".service-account-empty")?.remove();if(accounts.length===0)list.append(el("div","Belum ada akun layanan. Tambahkan alias pertama untuk memulai pairing.","service-account-empty"));else accounts.forEach((account)=>renderPrimaryWhatsAppAccount(account,runtimeActive));
  const active=accounts.filter((account)=>account.lifecycle==="active").length;setChannelBadge("primary-whatsapp-account-count",active+" aktif · "+accounts.length+" total",active>0?"good":"warn");byId("primary-whatsapp-account-add").disabled=runtimeActive||accounts.some(pairingActive);byId("primary-whatsapp-account-alias").disabled=runtimeActive;byId("primary-whatsapp-account-confirm").disabled=runtimeActive;byId("primary-whatsapp-verify").disabled=runtimeActive||active===0||accounts.some(pairingActive);
}
function renderPrimaryChannelBoundary(channels){
  const primary=channels.identityBoundary?.primary;
  const telegram=primary?.telegram||{},[telegramLabel,telegramDetail,telegramTone]=primaryTelegramPresentation(telegram);
  setChannelBadge("primary-telegram-status",telegramLabel,telegramTone);
  byId("primary-telegram-detail").textContent=telegramDetail;
  byId("primary-config-source").textContent=telegram.source==="console"?"Telegram dikelola Console":telegram.source==="environment"?"Telegram masih dari environment":telegram.source==="conflict"?"Sumber Telegram bertentangan":"Belum lengkap";
  const card=byId("primary-telegram-bot-card"),status=byId("primary-telegram-bot-status"),detail=byId("primary-telegram-bot-detail"),editor=byId("primary-telegram-bot-editor"),wasConfigured=editor.dataset.configured==="true";
  status.textContent=telegramLabel;status.className="badge"+(telegramTone?" "+telegramTone:"");detail.textContent=telegramDetail;card.classList.toggle("ready",telegram.phase==="ready");editor.dataset.configured=String(telegram.configured===true);
  const source=telegram.source||"missing",legacy=source==="environment",managed=source==="console",busy=telegram.phase==="validating";
  byId("primary-telegram-bot-form").classList.toggle("hidden",legacy||source==="conflict");
  byId("primary-telegram-migrate-zone").classList.toggle("hidden",!legacy);
  byId("primary-telegram-migrate").disabled=busy||telegram.migrationAvailable!==true;
  byId("primary-telegram-verify-zone").classList.toggle("hidden",telegram.configured!==true);
  byId("primary-telegram-verify").disabled=busy;
  byId("primary-telegram-delete-zone").classList.toggle("hidden",!managed);
  byId("primary-telegram-bot-save").disabled=busy;
  byId("primary-telegram-delete").disabled=busy;
  byId("primary-telegram-bot-editor-summary").textContent=legacy?"Pindahkan token layanan ke Console":managed?"Ganti atau kelola token layanan":"Tambahkan token bot layanan";
  if(source==="missing"||legacy||source==="conflict"||telegram.phase==="error")editor.open=true;else if(!wasConfigured)editor.open=false;
  const primaryReady=byId("primary-ready");
  const whatsapp=primary?.whatsapp||{};renderPrimaryWhatsAppFleet(whatsapp);const [whatsappLabel,whatsappDetail,whatsappTone]=primaryWhatsAppPresentation(whatsapp);setChannelBadge("primary-whatsapp-status",whatsappLabel,whatsappTone);byId("primary-whatsapp-detail").textContent=whatsappDetail;const sources=[telegram.source,whatsapp.source];byId("primary-config-source").textContent=sources.includes("conflict")?"Sumber konfigurasi perlu diselesaikan":sources.every((item)=>item==="console")?"Telegram dan WhatsApp dikelola Console":sources.includes("environment")?"Masih ada konfigurasi layanan di environment":"Konfigurasi layanan belum lengkap";
  const whatsappConfigured=whatsapp.configurationValid!==false&&whatsapp.enabled===true&&(whatsapp.accountCount||0)>0&&(whatsapp.phase==="ready"||whatsapp.runtimeActive===true&&whatsapp.restartRequired!==true);
  const primaryError=telegram.phase==="error"||source==="conflict"||whatsapp.configurationValid===false||whatsapp.phase==="error";
  const primaryConfigured=telegram.configured===true&&whatsappConfigured;
  const primaryLabel=primaryError?"Perlu tindakan":primaryConfigured?"Dikonfigurasi":"Belum lengkap";
  const primaryTone=primaryError?"bad":primaryConfigured?"good":"warn";
  setChannelBadge("primary-environment-status",primaryLabel,primaryTone);
  setChannelBadge("service-tab-status",primaryError?"Perlu dicek":primaryLabel,primaryTone);
  primaryReady.textContent=primaryLabel;primaryReady.className="badge "+primaryTone;
}
function renderSetupProgress(channels){
  const steps=[
    ["setup-step-telegram-bot",channels.telegram.bot.configured===true&&channels.telegram.bot.phase!=="error"],
    ["setup-step-telegram-tester",channels.telegram.tester.configured===true&&!pairingActive(channels.telegram.tester)&&channels.telegram.tester.phase!=="error"],
    ["setup-step-whatsapp-harvy",channels.whatsapp.harvy.session?.status==="accepted"&&!pairingActive(channels.whatsapp.harvy)&&channels.whatsapp.harvy.phase!=="error"],
    ["setup-step-whatsapp-tester",channels.whatsapp.tester.session?.status==="accepted"&&!pairingActive(channels.whatsapp.tester)&&channels.whatsapp.tester.phase!=="error"],
  ];
  let ready=0;steps.forEach(([id,complete])=>{byId(id).classList.toggle("complete",complete);if(complete)ready+=1});
  setChannelBadge("setup-progress-badge",String(ready)+" dari 4 siap",ready===4?"good":"warn");
  byId("setup-progress-fill").style.width=String(ready*25)+"%";
  return ready;
}
function renderChannelOverview(channels,readyCount){
  const telegramReady=channels.telegram.ready===true&&channels.telegram.bot.phase!=="error"&&channels.telegram.tester.phase!=="error";
  const whatsappReady=channels.whatsapp.ready===true;
  const allReady=telegramReady&&whatsappReady;
  const whatsappChecking=channels.whatsapp.harvy.session?.status==="checking"||channels.whatsapp.tester.session?.status==="checking";
  const whatsappRejected=channels.whatsapp.harvy.session?.status==="rejected"||channels.whatsapp.tester.session?.status==="rejected";
  const pairingInProgress=pairingActive(channels.telegram.tester)||pairingActive(channels.whatsapp.harvy)||pairingActive(channels.whatsapp.tester)||whatsappChecking||channels.telegram.bot.phase==="validating";
  const hasError=channels.telegram.bot.phase==="error"||channels.telegram.tester.phase==="error"||channels.whatsapp.harvy.phase==="error"||channels.whatsapp.tester.phase==="error"||whatsappRejected;
  const root=byId("tab-channels"),settings=byId("channel-settings");
  root.classList.toggle("ready-mode",allReady);settings.dataset.ready=String(allReady);
  const suggestedContext=!telegramReady?"telegram":!whatsappReady?"whatsapp":"telegram";
  if(!settings.dataset.section)selectChannelSettings(suggestedContext);
  if(activeChannelEnvironment===null)selectChannelEnvironment("service");
  if(allReady){
    byId("channel-readiness-mark").textContent="✓";
    byId("channel-readiness-label").textContent="Pemeriksaan live selesai";
    byId("channel-readiness-title").textContent="Siap untuk pengujian langsung";
    byId("channel-readiness-detail").textContent="Telegram dan WhatsApp pengujian siap digunakan.";
  }else if(hasError){
    byId("channel-readiness-mark").textContent="!";
    byId("channel-readiness-label").textContent="Perlu tindakan";
    byId("channel-readiness-title").textContent="Satu koneksi perlu perhatian";
    byId("channel-readiness-detail").textContent="Buka koneksi yang ditandai untuk melihat penyebab dan mencoba kembali.";
  }else if(pairingInProgress){
    byId("channel-readiness-mark").textContent="…";
    byId("channel-readiness-label").textContent=whatsappChecking?"Pemeriksaan berlangsung":"Pairing berlangsung";
    byId("channel-readiness-title").textContent=whatsappChecking?"Sedang memeriksa sesi WhatsApp":"Sedang menghubungkan kanal";
    byId("channel-readiness-detail").textContent="Selesaikan langkah yang tampil di pengaturan akun dan sesi.";
  }else{
    byId("channel-readiness-mark").textContent=String(readyCount);
    byId("channel-readiness-label").textContent=String(readyCount)+" dari 4 identitas siap";
    byId("channel-readiness-title").textContent="Selesaikan koneksi kanal";
    byId("channel-readiness-detail").textContent="Lengkapi identitas yang belum tersedia agar Telegram dan WhatsApp dapat diuji.";
  }
  const testingLabel=allReady?"Siap":hasError?"Perlu dicek":pairingInProgress?"Menghubungkan":String(readyCount)+" dari 4";
  const testingTone=allReady?"good":hasError?"bad":"warn";
  setChannelBadge("testing-tab-status",testingLabel,testingTone);
  setConnectionStatus("telegram-route-status",telegramReady?"Siap":channels.telegram.bot.phase==="error"||channels.telegram.tester.phase==="error"?"Perlu tindakan":pairingActive(channels.telegram.tester)||channels.telegram.bot.phase==="validating"?"Menghubungkan":"Belum lengkap",telegramReady?"good":channels.telegram.bot.phase==="error"||channels.telegram.tester.phase==="error"?"bad":"warn");
  const whatsappUnreachable=channels.whatsapp.harvy.session?.status==="unreachable"||channels.whatsapp.tester.session?.status==="unreachable";
  setConnectionStatus("whatsapp-route-status",whatsappReady?"Sesi valid":whatsappRejected?"Sesi ditolak":whatsappChecking?"Memeriksa":channels.whatsapp.harvy.phase==="error"||channels.whatsapp.tester.phase==="error"?"Perlu tindakan":pairingActive(channels.whatsapp.harvy)||pairingActive(channels.whatsapp.tester)?"Menghubungkan":whatsappUnreachable?"Belum terverifikasi":"Belum lengkap",whatsappReady?"good":whatsappRejected||channels.whatsapp.harvy.phase==="error"||channels.whatsapp.tester.phase==="error"?"bad":"warn");
  byId("telegram-manage-open").textContent=telegramReady?"Kelola":"Selesaikan";
  byId("whatsapp-manage-open").textContent=whatsappReady?"Kelola":"Selesaikan";
}
function renderChannels(){
  const channels=state.channels;if(!channels)return;
  renderPrimaryChannelBoundary(channels);const readyCount=renderSetupProgress(channels);renderChannelOverview(channels,readyCount);
  const bot=channels.telegram.bot,botStatus=byId("telegram-bot-status"),botReady=bot.configured===true;
  botStatus.textContent=bot.phase==="validating"?"Memverifikasi":bot.phase==="error"?"Ditolak":bot.configured?"Tersimpan":"Belum ada";
  botStatus.className="badge "+(bot.phase==="error"?"bad":bot.phase==="validating"?"warn":bot.configured?"good":"");
  byId("telegram-bot-detail").textContent=bot.phase==="error"?(bot.errorCode?readable(bot.errorCode):"Token tidak dapat diverifikasi."):bot.configured?"Selesai. Token tersimpan terenkripsi dan tidak perlu dimasukkan ulang.":"Simpan token bot pengujian yang terpisah dari layanan.";
  const botCard=byId("telegram-bot-card"),botEditor=byId("telegram-bot-editor"),botWasReady=botEditor.dataset.ready==="true";
  botCard.classList.toggle("ready",botReady);botEditor.dataset.ready=String(botReady);
  if(!botReady||bot.phase==="error")botEditor.open=true;else if(!botWasReady)botEditor.open=false;
  byId("telegram-bot-editor-summary").textContent=botReady?"Ganti atau hapus token bot pengujian":"Tambahkan token bot pengujian";
  byId("telegram-bot-save").textContent=botReady?"Verifikasi dan ganti":"Verifikasi dan simpan";
  byId("telegram-bot-delete-zone").classList.toggle("hidden",!botReady);
  byId("telegram-bot-save").disabled=bot.phase==="validating";
  byId("telegram-bot-delete").disabled=bot.phase==="validating";
  const ready=byId("telegram-ready");ready.textContent=channels.telegram.ready?"Lengkap":"Belum lengkap";ready.className="badge "+(channels.telegram.ready?"good":"warn");
  renderPairing("telegram-tester",channels.telegram.tester,"/api/v1/channel-setup/telegram/qr.svg");
  byId("telegram-tester-delete").disabled=pairingActive(channels.telegram.tester);
  byId("telegram-password-form").classList.toggle("hidden",channels.telegram.tester.phase!=="awaiting_password");
  renderPairing("whatsapp-harvy",channels.whatsapp.harvy,"/api/v1/channel-setup/whatsapp/harvy/qr.svg");
  renderPairing("whatsapp-tester",channels.whatsapp.tester,"/api/v1/channel-setup/whatsapp/tester/qr.svg");
  setChannelBadge("whatsapp-ready",channels.whatsapp.ready?"2 sesi valid":"Belum lengkap",channels.whatsapp.ready?"good":"warn");
  const whatsappBusy=pairingActive(channels.whatsapp.harvy)||pairingActive(channels.whatsapp.tester);
  const whatsappVerifying=channels.whatsapp.harvy.session?.status==="checking"||channels.whatsapp.tester.session?.status==="checking";
  ["harvy","tester"].forEach((role)=>{byId("whatsapp-"+role+"-pair").disabled=whatsappBusy||whatsappVerifying||channels.whatsapp[role].configured===true;byId("whatsapp-"+role+"-replace").disabled=whatsappBusy||whatsappVerifying||channels.whatsapp[role].configured!==true;byId("whatsapp-"+role+"-revoke").disabled=whatsappBusy||whatsappVerifying});
}
async function loadChannels(quiet=false){
  if(channelLoading)return;channelLoading=true;
  try{state.channels=await api("/api/v1/channel-setup");renderChannels()}
  catch(error){if(error?.status===401){showLogin();return}if(!quiet)showGlobalError(error)}
  finally{channelLoading=false}
}
function renderCodingSetup(){
  const setup=state.coding;if(!setup)return;const compute=setup.compute,github=setup.github,receiptExpired=compute.receiptExpiresAt&&Date.parse(compute.receiptExpiresAt)<=Date.now();
  const computeTone=compute.enabled&&compute.verificationCurrent?"good":compute.configured?"warn":"";const computeLabel=compute.enabled&&compute.verificationCurrent?"Aktif":compute.configured?"Menunggu verifikasi":"Belum diatur";
  setChannelBadge("compute-status",computeLabel,computeTone);setChannelBadge("compute-sandbox-status",compute.configured?"Tersimpan":"Belum siap",compute.configured?"good":"");setChannelBadge("compute-git-status",compute.configured?"Tersimpan":"Belum siap",compute.configured?"good":"");
  byId("compute-summary-card").classList.toggle("enabled",compute.enabled===true);byId("compute-summary-detail").textContent=compute.enabled?"Runtime coding siap digunakan setelah proses Harvy memuat konfigurasi ini.":compute.configured?"Koneksi tersimpan, tetapi belum menjadi capability aktif.":"Hubungkan dua trust domain dan receipt Linux untuk memulai.";
  byId("compute-sandbox-origin").textContent=compute.sandboxOrigin||"Belum dihubungkan.";byId("compute-git-origin").textContent=compute.localGitOrigin||"Belum dihubungkan.";
  byId("compute-receipt-detail").textContent=!compute.receiptConfigured?"Receipt conformance Linux belum tersedia.":receiptExpired?"Receipt conformance sudah kedaluwarsa; jalankan suite hostile-code lagi.":"Receipt berlaku sampai "+dateTime(compute.receiptExpiresAt)+".";
  const computeEditor=byId("compute-editor"),computeWasConfigured=computeEditor.dataset.configured==="true";computeEditor.dataset.configured=String(compute.configured===true);if(!compute.configured||receiptExpired)computeEditor.open=true;else if(!computeWasConfigured)computeEditor.open=false;
  if(!byId("compute-form").contains(document.activeElement)){byId("compute-sandbox-origin-input").value=compute.sandboxOrigin||"";byId("compute-sandbox-key-id").value=compute.sandboxKeyId||"harvy-control-v1";byId("compute-git-origin-input").value=compute.localGitOrigin||"";byId("compute-git-key-id").value=compute.localGitKeyId||"harvy-control-v1";byId("compute-insecure-loopback").checked=compute.allowInsecureLoopback===true;byId("compute-privacy-domain").value=compute.codingAiPrivacyDomain||""}
  byId("compute-verify").disabled=!compute.configured||receiptExpired;byId("compute-disable").classList.toggle("hidden",!compute.enabled);byId("compute-activation-detail").textContent=setup.restartRequired?"Konfigurasi berubah. Restart Harvy setelah verifikasi selesai.":compute.enabled?"Health dan identity receipt cocok pada verifikasi terakhir.":compute.configured?"Verifikasi akan menghubungi kedua service dan mencocokkan identity sandbox.":"Simpan konfigurasi lengkap lebih dahulu.";
  const githubTone=github.enabled&&github.verificationCurrent?"good":github.configured?"warn":"";const githubLabel=github.enabled&&github.verificationCurrent?"Aktif":github.configured?"Menunggu Broker":"Belum diatur";
  setChannelBadge("github-status",githubLabel,githubTone);setChannelBadge("github-credential-status",github.credentialsStored?"Tersimpan":"Belum siap",github.credentialsStored?"good":"");setChannelBadge("github-broker-status",github.enabled?"Terhubung":github.configured?"Belum diverifikasi":"Belum siap",github.enabled?"good":github.configured?"warn":"");
  byId("github-app-name").textContent=github.appSlug?"GitHub App · "+github.appSlug:"GitHub App";byId("github-callback-origin").textContent=github.callbackOrigin?"Callback: "+github.callbackOrigin:"Callback HTTPS belum diatur.";byId("github-broker-origin").textContent=github.brokerOrigin||"Belum dihubungkan.";byId("github-summary-detail").textContent=github.enabled?"Broker siap menerima installation dan efek GitHub yang disetujui.":github.configured?"Credential tersimpan. Jalankan Broker lalu verifikasi koneksi.":"Simpan GitHub App khusus Harvy dan koneksi Broker.";
  const githubEditor=byId("github-editor"),githubWasConfigured=githubEditor.dataset.configured==="true";githubEditor.dataset.configured=String(github.configured===true);if(!github.configured)githubEditor.open=true;else if(!githubWasConfigured)githubEditor.open=false;
  if(!byId("github-form").contains(document.activeElement)){byId("github-broker-origin-input").value=github.brokerOrigin||"";byId("github-broker-key-id").value=github.brokerKeyId||"harvy-control-v1";byId("github-app-id").value=github.appId||"";byId("github-app-slug").value=github.appSlug||"";byId("github-client-id").value=github.clientId||"";byId("github-callback-url").value=github.callbackUrl||""}
  byId("github-client-secret").required=!github.credentialsStored;byId("github-private-key").required=!github.credentialsStored;byId("github-verify").disabled=!github.configured||!compute.enabled;byId("github-disable").classList.toggle("hidden",!github.enabled);byId("github-activation-detail").textContent=setup.restartRequired?"Konfigurasi berubah. Restart service terkait dan Harvy setelah verifikasi.":github.enabled?"Broker health berhasil diverifikasi. Installation repository tetap dilakukan per Workspace.":!compute.enabled?"Aktifkan compute lebih dahulu agar commit lokal menjadi gate sebelum push.":github.configured?"Jalankan npm run start:github-broker, lalu verifikasi koneksi.":"Simpan GitHub App dan koneksi Broker lebih dahulu.";
}
async function loadCodingSetup(quiet=false){
  try{state.coding=await api("/api/v1/coding-setup");renderCodingSetup()}
  catch(error){if(error?.status===401){showLogin();return}if(!quiet)showGlobalError(error)}
}
function channelVerificationActive(channels){const primaryWhatsapp=channels?.identityBoundary?.primary?.whatsapp;return channels?.identityBoundary?.primary?.telegram?.phase==="validating"||primaryWhatsapp?.phase==="checking"||(primaryWhatsapp?.accounts||[]).some((account)=>account.session?.status==="checking")||channels?.whatsapp?.harvy?.session?.status==="checking"||channels?.whatsapp?.tester?.session?.status==="checking"}
function channelNeedsAttention(channels){const primary=channels?.identityBoundary?.primary?.telegram,primaryWhatsapp=channels?.identityBoundary?.primary?.whatsapp;return primary?.phase==="error"||primary?.source==="conflict"||primaryWhatsapp?.phase==="error"||primaryWhatsapp?.source==="conflict"||channels?.telegram?.bot?.phase==="error"||channels?.telegram?.tester?.phase==="error"||channels?.whatsapp?.ready!==true}
async function waitForChannelVerification(){for(let attempt=0;attempt<50;attempt+=1){await loadChannels(true);if(!channelVerificationActive(state.channels))return true;await new Promise((resolve)=>setTimeout(resolve,400))}return false}
async function verifyChannels(){clearGlobalError();const checks=[api("/api/v1/channel-setup/whatsapp/verify",{method:"POST",body:{}})],primary=state.channels?.identityBoundary?.primary?.telegram,primaryWhatsapp=state.channels?.identityBoundary?.primary?.whatsapp;if(primary?.configured===true&&primary.source!=="conflict")checks.push(api("/api/v1/channel-setup/primary/telegram/verify",{method:"POST",body:{}}));if(primaryWhatsapp?.source==="console"&&primaryWhatsapp.runtimeActive!==true&&(primaryWhatsapp.accountCount||0)>0)checks.push(api("/api/v1/channel-setup/primary/whatsapp/verify",{method:"POST",body:{}}));await Promise.all(checks);await loadChannels();return channelVerificationActive(state.channels)?waitForChannelVerification():true}
function attemptCost(item){
  const view=item.costView;
  if(view?.source==="recorded")return stack(money(view.costUsdNanos),translated("source",item.cost.effectiveSource));
  if(view?.source==="current_catalog_estimate")return stack("≈ "+money(view.costUsdNanos),"Estimasi dengan tarif aktif sekarang");
  if(view?.reason==="current_price_missing")return stack("Harga belum tersedia","Atur tarif model di Harga model");
  if(view?.reason==="usage_missing")return stack("Menunggu data provider",item.status==="started"?"Request masih berjalan":"Usage tidak tersedia");
  if(item.cost.effectiveUsdNanos!==null)return stack(money(item.cost.effectiveUsdNanos),translated("source",item.cost.effectiveSource));
  return stack("Belum dapat dihitung","Harga atau usage belum tersedia");
}
function renderAttempts(){
  const rows=state.attempts.map((item)=>[dateTime(item.startedAt),stack(item.modelId,item.providerId),stack(translated("origin",item.origin),translated("purpose",item.purpose)+" · "+translated("tier",item.tier)),number(item.usage.totalTokens),attemptCost(item),badge(translated("attemptStatus",item.status),item.status==="completed"?"good":item.status==="started"?"warn":"bad"),item.actorRef?shortRef(item.actorRef):"Bersama"]);
  byId("attempts").replaceChildren(table(["Waktu","Model","Rute","Token","Biaya","Status","Pemicu"],rows,"Attempt provider terbaru"));
  const summary=state.usageSummary,box=byId("usage-summary");box.replaceChildren();if(!summary)return;const cost=costPresentation(summary);
  [["Request",number(summary.logicalRequests)],["Attempt",number(summary.attempts)],["Token",number(summary.totalTokens)],["Biaya",cost.value]].forEach(([label,value])=>{const chip=el("div",null,"usage-chip");chip.append(el("span",label),el("strong",value));box.append(chip)});
}
function renderAudit(){const rows=state.audit.map((item)=>[dateTime(item.at),translated("auditAction",item.action),item.targetRef?shortRef(item.targetRef,20):"—",badge(translated("outcome",item.outcome),item.outcome==="succeeded"?"good":item.outcome==="rejected"?"warn":"bad"),item.reasonCode?readable(item.reasonCode):"—"]);byId("audits").replaceChildren(table(["Waktu","Aksi","Target pseudonim","Hasil","Kode"],rows,"Audit operator"))}
function renderUsagePlans(){const select=byId("usage-plan"),selected=select.value;select.replaceChildren();const all=el("option","Semua paket");all.value="";select.append(all);latestPlans().forEach((plan)=>{const option=el("option",plan.publicName);option.value=plan.planId;option.selected=selected===plan.planId;select.append(option)})}
function renderAll(options={}){
  renderSummary();renderEconomy();renderBreakdowns();renderPlans();
  if(!options.preserveForms){renderPrices();renderEnrollments()}
  renderUsagePlans();renderAttempts();renderAudit();if(state.groupDetails!==null)renderGroups();
  const status=state.dashboard?.status||"starting";byId("health").textContent=status==="ready"?"Siap":status==="draining"?"Sedang ditutup":"Menyiapkan";byId("health").className="status-badge "+(status==="ready"?"ready":status==="draining"?"warning":"neutral");
}
function usagePath(){const query=new URLSearchParams({limit:"250"});if(byId("usage-cohort").value)query.set("cohort",byId("usage-cohort").value);if(byId("usage-plan").value)query.set("planId",byId("usage-plan").value);return "/api/v1/usage?"+query.toString()}
function load(options={}){
  if(activeLoad){
    return options.requireFresh===true
      ?activeLoad.then(()=>load({...options,requireFresh:false}))
      :activeLoad;
  }
  const operation=performLoad(options);
  const tracked=operation.finally(()=>{if(activeLoad===tracked)activeLoad=null});
  activeLoad=tracked;
  return tracked;
}
async function performLoad(options={}){
  const quiet=options.quiet===true;setBusy(true,quiet);clearGlobalError();
  try{
    const results=await Promise.allSettled([api("/api/v1/dashboard"),api("/api/v1/control-plane"),api(usagePath()),api("/api/v1/audit"),api("/api/v1/economy")]);
    if(results[0].status==="rejected")throw results[0].reason;if(results[1].status==="rejected")throw results[1].reason;
    const dashboard=results[0].value,control=results[1].value,usage=results[2].status==="fulfilled"?results[2].value:{summary:null,attempts:[]},audit=results[3].status==="fulfilled"?results[3].value:{records:[]},economy=results[4].status==="fulfilled"?results[4].value:null;
    state={...state,...control,dashboard,economy,attempts:usage.attempts,usageSummary:usage.summary,audit:audit.records,groupDetails:null};renderAll({preserveForms:options.preserveForms===true});
    byId("last-updated").textContent="Diperbarui "+new Intl.DateTimeFormat("id-ID",{hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date());
    if(results[2].status==="rejected")showGlobalError(new Error("Ringkasan tersedia, tetapi detail penggunaan gagal dimuat: "+results[2].reason.message));
    else if(results[3].status==="rejected")showGlobalError(new Error("Data utama tersedia, tetapi audit gagal dimuat: "+results[3].reason.message));
    if(activeTab==="groups")await loadGroups(options.forceGroups===true);
  }catch(error){if(error?.status===401){showLogin();return}showGlobalError(error)}
  finally{setBusy(false,quiet)}
}
async function loadGroups(force=false){
  if(groupLoading||(!force&&state.groupDetails!==null))return;groupLoading=true;state.groupDetails=null;renderGroups();
  try{
    const groups=state.enrollments.filter((item)=>item.kind==="group"),results=await Promise.allSettled(groups.map((group)=>api("/api/v1/groups/"+encodeURIComponent(group.subjectRef)+"/members")));
    state.groupDetails=groups.map((group,index)=>{const result=results[index];return result.status==="fulfilled"?{group,members:result.value.records,error:null}:{group,members:[],error:result.reason?.message||"Permintaan gagal."}});
  }finally{groupLoading=false;renderGroups()}
}
function showApp(){byId("login-view").classList.add("hidden");byId("app-view").classList.remove("hidden")}
function showLogin(){csrf=null;activeChannelEnvironment=null;channelSettingsTrigger=null;byId("channel-settings").classList.add("hidden");byId("app-view").classList.add("hidden");byId("login-view").classList.remove("hidden")}
function configureConsoleMode(setupOnly){byId("app-view").classList.toggle("setup-only",setupOnly);byId("setup-section-nav").classList.toggle("hidden",!setupOnly);document.querySelectorAll("[data-tab]").forEach((button)=>button.classList.toggle("hidden",setupOnly&&!['channels','compute','github'].includes(button.dataset.tab)));if(!setupOnly)return;byId("health").textContent="Mode konfigurasi";byId("health").className="status-badge ready";byId("last-updated").textContent="Runtime tidak dipantau"}
async function restore(){const epoch=authEpoch;try{const session=await api("/api/v1/session");if(epoch!==authEpoch)return;csrf=session.csrfToken;configureConsoleMode(session.setupOnly===true);showApp();if(session.setupOnly===true){switchTab("channels");return}await load();if(epoch!==authEpoch)return;if(location.hash==="#channels")switchTab("channels")}catch(error){if(epoch!==authEpoch)return;showLogin();if(error?.status!==401)byId("login-error").textContent=safeErrorMessage(error)}}
function switchTab(name,focus=false){
  activeTab=name;const tabs=[...document.querySelectorAll("[data-tab]")];
  tabs.forEach((button)=>{const selected=button.dataset.tab===name;button.classList.toggle("active",selected);button.setAttribute("aria-selected",String(selected));button.tabIndex=selected?0:-1;if(selected&&focus)button.focus()});
  document.querySelectorAll("[data-setup-tab]").forEach((button)=>{const selected=button.dataset.setupTab===name;button.classList.toggle("active",selected);button.setAttribute("aria-current",selected?"step":"false")});
  document.querySelectorAll(".tabpanel").forEach((panel)=>panel.classList.toggle("hidden",panel.id!=="tab-"+name));
  const copy=pageCopy[name]||pageCopy.overview;byId("page-title").textContent=copy[0];byId("page-description").textContent=copy[1];if(name==="groups")loadGroups().catch(showGlobalError);if(name==="channels")loadChannels().catch(showGlobalError);if(name==="compute"||name==="github")loadCodingSetup().catch(showGlobalError);
}
byId("login-form").addEventListener("submit",(event)=>{
  event.preventDefault();const button=byId("login-submit"),epoch=++authEpoch;byId("login-error").textContent="";
  withButton(button,"Memeriksa…",async()=>{const result=await api("/api/v1/session",{method:"POST",body:{token:byId("operator-token").value}});if(epoch!==authEpoch)return;csrf=result.csrfToken;byId("operator-token").value="";configureConsoleMode(result.setupOnly===true);showApp();if(result.setupOnly===true)switchTab("channels");else await load()}).catch((error)=>{if(epoch!==authEpoch)return;byId("global-error").classList.add("hidden");byId("login-error").textContent=safeErrorMessage(error)});
});
byId("logout").addEventListener("click",()=>{const epoch=++authEpoch;withButton(byId("logout"),"Keluar…",async()=>{await api("/api/v1/session",{method:"DELETE",body:{}}).catch(()=>{});if(epoch===authEpoch)showLogin()}).catch(()=>{})});
byId("refresh").addEventListener("click",()=>activeTab==="channels"?verifyChannels().catch(showGlobalError):activeTab==="compute"||activeTab==="github"?loadCodingSetup().catch(showGlobalError):load({forceGroups:activeTab==="groups"}));byId("retry-load").addEventListener("click",()=>activeTab==="channels"?verifyChannels().catch(showGlobalError):activeTab==="compute"||activeTab==="github"?loadCodingSetup().catch(showGlobalError):load({forceGroups:activeTab==="groups"}));
byId("refresh-groups").addEventListener("click",()=>withButton(byId("refresh-groups"),"Menyegarkan…",()=>loadGroups(true)).catch(()=>{}));
byId("channels-refresh").addEventListener("click",()=>withButton(byId("channels-refresh"),"Memeriksa…",async()=>{const settled=await verifyChannels(),attention=channelNeedsAttention(state.channels);showNotice(!settled?"Pemeriksaan masih berjalan. Status akan diperbarui otomatis.":attention?"Pemeriksaan selesai. Satu koneksi perlu perhatian.":"Semua koneksi berhasil diperiksa.",!settled||attention?"warning":"success")}).catch(()=>{}));
function selectChannelEnvironment(environment,focus=false){
  activeChannelEnvironment=environment;const settings=byId("channel-settings");
  document.querySelectorAll("[data-channel-environment]").forEach((button)=>{const active=button.dataset.channelEnvironment===environment;button.classList.toggle("active",active);button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;if(active&&focus)button.focus()});
  document.querySelectorAll(".channel-environment-view").forEach((panel)=>{const active=panel.id==="channel-environment-"+environment+"-panel";panel.classList.toggle("active",active);panel.hidden=!active});
  if(!settings.classList.contains("hidden")&&settings.dataset.environment!==environment){settings.classList.add("hidden");channelSettingsTrigger=null}
}
function selectChannelSettings(channel){
  const labels={primary:"Kanal layanan",telegram:"Telegram · Pengujian",whatsapp:"WhatsApp · Pengujian"},settings=byId("channel-settings"),environment=channel==="primary"?"service":"testing";settings.dataset.section=channel;settings.dataset.environment=environment;byId("settings-context-label").textContent=labels[channel]||"Pilih kanal";
  document.querySelectorAll(".settings-panel").forEach((panel)=>{const active=panel.id===channel+"-settings";panel.classList.toggle("active",active);panel.setAttribute("aria-hidden",String(!active))});
}
function openChannelSettings(channel,trigger){const environment=channel==="primary"?"service":"testing",settings=byId("channel-settings");channelSettingsTrigger=trigger||null;selectChannelEnvironment(environment);selectChannelSettings(channel);settings.classList.remove("hidden");requestAnimationFrame(()=>{settings.scrollIntoView({behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"});byId("channel-settings-close").focus({preventScroll:true})})}
function closeChannelSettings(){byId("channel-settings").classList.add("hidden");const trigger=channelSettingsTrigger;channelSettingsTrigger=null;if(trigger&&document.contains(trigger))trigger.focus({preventScroll:true})}
byId("primary-manage-open").addEventListener("click",(event)=>openChannelSettings("primary",event.currentTarget));
byId("telegram-manage-open").addEventListener("click",(event)=>openChannelSettings("telegram",event.currentTarget));
byId("whatsapp-manage-open").addEventListener("click",(event)=>openChannelSettings("whatsapp",event.currentTarget));
byId("channel-settings-close").addEventListener("click",closeChannelSettings);
document.querySelectorAll("[data-channel-environment]").forEach((button)=>{
  button.addEventListener("click",()=>selectChannelEnvironment(button.dataset.channelEnvironment,true));
  button.addEventListener("keydown",(event)=>{const tabs=[...document.querySelectorAll("[data-channel-environment]")],current=tabs.indexOf(button);let next=null;if(event.key==="ArrowRight")next=(current+1)%tabs.length;if(event.key==="ArrowLeft")next=(current-1+tabs.length)%tabs.length;if(event.key==="Home")next=0;if(event.key==="End")next=tabs.length-1;if(next!==null){event.preventDefault();selectChannelEnvironment(tabs[next].dataset.channelEnvironment,true)}});
});
document.querySelectorAll("[data-tab]").forEach((button)=>{
  button.addEventListener("click",()=>switchTab(button.dataset.tab));
  button.addEventListener("keydown",(event)=>{const tabs=[...document.querySelectorAll("[data-tab]")],current=tabs.indexOf(button);let next=null;if(event.key==="ArrowDown"||event.key==="ArrowRight")next=(current+1)%tabs.length;if(event.key==="ArrowUp"||event.key==="ArrowLeft")next=(current-1+tabs.length)%tabs.length;if(event.key==="Home")next=0;if(event.key==="End")next=tabs.length-1;if(next!==null){event.preventDefault();switchTab(tabs[next].dataset.tab,true)}});
});
byId("enroll-form").addEventListener("submit",(event)=>{
  event.preventDefault();const button=byId("enroll-submit");
  withButton(button,"Menambahkan…",async()=>{clearGlobalError();await api("/api/v1/enrollments",{method:"POST",body:{kind:byId("enroll-kind").value,channel:byId("enroll-channel").value,externalId:byId("enroll-id").value,operatorLabel:byId("enroll-label").value||null}});byId("enroll-id").value="";byId("enroll-label").value="";await load({quiet:true,requireFresh:true});showNotice("Akses pseudonim berhasil ditambahkan.")}).catch(()=>{});
});
document.querySelectorAll("[data-setup-tab]").forEach((button)=>button.addEventListener("click",()=>switchTab(button.dataset.setupTab)));
function openSetupEditor(id){const editor=byId(id);editor.open=true;requestAnimationFrame(()=>editor.scrollIntoView({behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"}))}
byId("compute-manage-open").addEventListener("click",()=>openSetupEditor("compute-editor"));
byId("github-manage-open").addEventListener("click",()=>openSetupEditor("github-editor"));
byId("compute-form").addEventListener("submit",(event)=>{
  event.preventDefault();const button=byId("compute-save");withButton(button,"Menyimpan…",async()=>{clearGlobalError();const result=await api("/api/v1/coding-setup/compute",{method:"POST",body:{sandboxOrigin:byId("compute-sandbox-origin-input").value,sandboxKeyId:byId("compute-sandbox-key-id").value,sandboxHmacSecret:byId("compute-sandbox-secret").value||null,localGitOrigin:byId("compute-git-origin-input").value,localGitKeyId:byId("compute-git-key-id").value,localGitHmacSecret:byId("compute-git-secret").value||null,conformanceReceipt:byId("compute-receipt").value||null,allowInsecureLoopback:byId("compute-insecure-loopback").checked,codingAiPrivacyDomain:byId("compute-privacy-domain").value||null}});byId("compute-sandbox-secret").value="";byId("compute-git-secret").value="";byId("compute-receipt").value="";state.coding=result;renderCodingSetup();byId("compute-editor").open=false;showNotice("Konfigurasi compute disimpan. Verifikasi live masih diperlukan.","warning")}).catch(()=>{});
});
byId("compute-verify").addEventListener("click",()=>withButton(byId("compute-verify"),"Memverifikasi…",async()=>{clearGlobalError();state.coding=await api("/api/v1/coding-setup/compute/verify",{method:"POST",body:{}});renderCodingSetup();showNotice(state.coding.restartRequired?"Compute aktif pada konfigurasi tersimpan. Restart Harvy untuk memakainya.":"Compute berhasil diverifikasi dan aktif.")}).catch(()=>{}));
byId("compute-disable").addEventListener("click",()=>withButton(byId("compute-disable"),"Menonaktifkan…",async()=>{state.coding=await api("/api/v1/coding-setup/compute/disable",{method:"POST",body:{}});renderCodingSetup();showNotice("Compute dan GitHub coding dinonaktifkan.","warning")}).catch(()=>{}));
byId("github-form").addEventListener("submit",(event)=>{
  event.preventDefault();const button=byId("github-save");withButton(button,"Menyimpan…",async()=>{clearGlobalError();const result=await api("/api/v1/coding-setup/github",{method:"POST",body:{brokerOrigin:byId("github-broker-origin-input").value,brokerKeyId:byId("github-broker-key-id").value,brokerHmacSecret:byId("github-broker-secret").value||null,appId:byId("github-app-id").value,appSlug:byId("github-app-slug").value,clientId:byId("github-client-id").value,clientSecret:byId("github-client-secret").value||null,privateKeyPem:byId("github-private-key").value||null,callbackUrl:byId("github-callback-url").value}});byId("github-broker-secret").value="";byId("github-client-secret").value="";byId("github-private-key").value="";state.coding=result;renderCodingSetup();byId("github-editor").open=false;showNotice("Credential GitHub tersimpan. Jalankan ulang Broker lalu verifikasi koneksi.","warning")}).catch(()=>{});
});
byId("github-verify").addEventListener("click",()=>withButton(byId("github-verify"),"Memverifikasi…",async()=>{clearGlobalError();state.coding=await api("/api/v1/coding-setup/github/verify",{method:"POST",body:{}});renderCodingSetup();showNotice(state.coding.restartRequired?"GitHub aktif pada konfigurasi tersimpan. Restart Harvy untuk memakainya.":"GitHub Broker berhasil diverifikasi dan aktif.")}).catch(()=>{}));
byId("github-disable").addEventListener("click",()=>withButton(byId("github-disable"),"Menonaktifkan…",async()=>{state.coding=await api("/api/v1/coding-setup/github/disable",{method:"POST",body:{}});renderCodingSetup();showNotice("Integrasi GitHub coding dinonaktifkan.","warning")}).catch(()=>{}));
byId("primary-telegram-bot-form").addEventListener("submit",(event)=>{
  event.preventDefault();const button=byId("primary-telegram-bot-save");
  withButton(button,"Memverifikasi…",async()=>{clearGlobalError();await api("/api/v1/channel-setup/primary/telegram/bot-token",{method:"POST",body:{token:byId("primary-telegram-bot-token").value}});byId("primary-telegram-bot-token").value="";await loadChannels();showNotice(state.channels?.identityBoundary?.primary?.telegram?.restartRequired?"Token layanan tersimpan. Restart Harvy untuk menerapkannya.":"Token layanan berhasil diverifikasi dan disimpan.")}).catch(()=>{});
});
byId("primary-telegram-migrate").addEventListener("click",()=>{if(!byId("primary-telegram-migrate-confirm").checked){showGlobalError(userError("Konfirmasikan bahwa Console akan menjadi sumber credential Telegram layanan."));return}withButton(byId("primary-telegram-migrate"),"Memindahkan…",async()=>{clearGlobalError();await api("/api/v1/channel-setup/primary/telegram/migrate",{method:"POST",body:{confirmation:"MIGRATE_PRIMARY_TELEGRAM_TO_CONSOLE"}});byId("primary-telegram-migrate-confirm").checked=false;await loadChannels();showNotice("Token layanan dipindahkan ke penyimpanan terenkripsi dan dihapus dari .env.")}).catch(()=>{})});
byId("primary-telegram-verify").addEventListener("click",()=>withButton(byId("primary-telegram-verify"),"Memeriksa…",async()=>{await api("/api/v1/channel-setup/primary/telegram/verify",{method:"POST",body:{}});await loadChannels();showNotice("Token Telegram layanan diterima oleh platform.")}).catch(()=>{}));
byId("primary-telegram-delete").addEventListener("click",()=>withButton(byId("primary-telegram-delete"),"Menghapus…",async()=>{await api("/api/v1/channel-setup/primary/telegram/bot-token",{method:"DELETE",body:{confirmation:byId("primary-telegram-delete-confirm").value}});byId("primary-telegram-delete-confirm").value="";await loadChannels();showNotice("Token Telegram layanan dihapus. Simpan token baru sebelum menjalankan ulang Harvy.")}).catch(()=>{}));
byId("primary-whatsapp-migrate").addEventListener("click",()=>{if(!byId("primary-whatsapp-migrate-confirm").checked){showGlobalError(userError("Konfirmasikan bahwa Console akan menjadi sumber daftar akun WhatsApp layanan."));return}withButton(byId("primary-whatsapp-migrate"),"Memindahkan…",async()=>{clearGlobalError();await api("/api/v1/channel-setup/primary/whatsapp/migrate",{method:"POST",body:{confirmation:"MIGRATE_PRIMARY_WHATSAPP_TO_CONSOLE"}});byId("primary-whatsapp-migrate-confirm").checked=false;await loadChannels();showNotice("Akun WhatsApp layanan dipindahkan ke Console. Nomor dan credential tetap tidak ditampilkan.")}).catch(()=>{})});
byId("primary-whatsapp-settings-form").addEventListener("submit",(event)=>{event.preventDefault();const button=byId("primary-whatsapp-settings-save");withButton(button,"Menyimpan…",async()=>{clearGlobalError();await api("/api/v1/channel-setup/primary/whatsapp/settings",{method:"POST",body:{enabled:byId("primary-whatsapp-enabled").checked,privateEnabled:byId("primary-whatsapp-private-enabled").checked}});await loadChannels();showNotice("Pengaturan WhatsApp layanan tersimpan. Jalankan ulang Harvy untuk menerapkannya.")}).catch(()=>{})});
byId("primary-whatsapp-verify").addEventListener("click",()=>withButton(byId("primary-whatsapp-verify"),"Memeriksa…",async()=>{clearGlobalError();await api("/api/v1/channel-setup/primary/whatsapp/verify",{method:"POST",body:{}});await loadChannels();showNotice("Pemeriksaan sesi WhatsApp layanan dimulai.")}).catch(()=>{}));
byId("primary-whatsapp-account-form").addEventListener("submit",(event)=>{event.preventDefault();if(!byId("primary-whatsapp-account-confirm").checked){showGlobalError(userError("Konfirmasikan bahwa akun baru akan menerima pesan sebagai Harvy."));return}const button=byId("primary-whatsapp-account-add"),alias=byId("primary-whatsapp-account-alias").value;withButton(button,"Menyiapkan…",async()=>{clearGlobalError();await api("/api/v1/channel-setup/primary/whatsapp/accounts",{method:"POST",body:{alias,confirmation:"PAIR_PRIMARY_WHATSAPP_ACCOUNT"}});byId("primary-whatsapp-account-alias").value="";byId("primary-whatsapp-account-confirm").checked=false;await loadChannels();showNotice("Alias layanan disimpan. Tunggu QR lalu pindai dari akun WhatsApp Harvy.")}).catch(()=>{})});
byId("primary-whatsapp-account-list").addEventListener("click",(event)=>{const button=event.target.closest("[data-primary-whatsapp-action]");if(!button)return;const card=button.closest(".service-account"),alias=card?.dataset.accountId,action=button.dataset.primaryWhatsappAction;if(!alias)return;const prefix=primaryWhatsAppPrefix(alias);if(action==="retry"){retryQrImage(prefix);return}if(action==="replace"&&!byId(prefix+"-replace-confirm").checked){showGlobalError(userError("Konfirmasikan bahwa akun "+alias+" siap dipindai ulang."));return}if(action==="remove"&&byId(prefix+"-remove-confirm").value!==alias){showGlobalError(userError("Ketik alias "+alias+" dengan tepat untuk menghapus akun."));return}const pendingLabel=action==="remove"?"Mencabut…":action==="cancel"?"Membatalkan…":"Memulai…";withButton(button,pendingLabel,async()=>{clearGlobalError();if(action==="pair")await api("/api/v1/channel-setup/primary/whatsapp/accounts/"+encodeURIComponent(alias)+"/pair",{method:"POST",body:{}});else if(action==="replace")await api("/api/v1/channel-setup/primary/whatsapp/accounts/"+encodeURIComponent(alias)+"/replace",{method:"POST",body:{confirmation:"REPLACE_PRIMARY_WHATSAPP_SESSION"}});else if(action==="cancel")await api("/api/v1/channel-setup/primary/whatsapp/accounts/"+encodeURIComponent(alias)+"/cancel",{method:"POST",body:{}});else if(action==="remove")await api("/api/v1/channel-setup/primary/whatsapp/accounts/"+encodeURIComponent(alias),{method:"DELETE",body:{confirmation:"REMOVE_PRIMARY_WHATSAPP_ACCOUNT"}});await loadChannels();showNotice(action==="remove"?"Pencabutan akun dimulai.":action==="cancel"?"Operasi dibatalkan.":"Pairing akun layanan dimulai; tunggu QR muncul.")}).catch(()=>{})});
byId("telegram-bot-form").addEventListener("submit",(event)=>{
  event.preventDefault();const button=byId("telegram-bot-save");
  withButton(button,"Memverifikasi…",async()=>{clearGlobalError();await api("/api/v1/channel-setup/telegram/bot-token",{method:"POST",body:{token:byId("telegram-bot-token").value}});byId("telegram-bot-token").value="";await loadChannels();showNotice("Token bot pengujian berhasil diverifikasi dan disimpan.")}).catch(()=>{});
});
byId("telegram-bot-delete").addEventListener("click",()=>withButton(byId("telegram-bot-delete"),"Menghapus…",async()=>{await api("/api/v1/channel-setup/telegram/bot-token",{method:"DELETE",body:{confirmation:byId("telegram-bot-delete-confirm").value}});byId("telegram-bot-delete-confirm").value="";await loadChannels();showNotice("Token bot pengujian dihapus.")}).catch(()=>{}));
byId("telegram-tester-form").addEventListener("submit",(event)=>{
  event.preventDefault();if(!byId("telegram-dedicated").checked){showGlobalError(userError("Konfirmasikan bahwa akun Telegram memang khusus pengujian."));return}const button=byId("telegram-tester-pair");
  withButton(button,"Memulai…",async()=>{clearGlobalError();await api("/api/v1/channel-setup/telegram/tester/pair",{method:"POST",body:{apiId:Number(byId("telegram-api-id").value),apiHash:byId("telegram-api-hash").value,confirmation:"DEDICATED_TEST_ACCOUNT"}});byId("telegram-api-id").value="";byId("telegram-api-hash").value="";await loadChannels();showNotice("Pairing Telegram dimulai; tunggu QR muncul.")}).catch(()=>{});
});
byId("telegram-password-form").addEventListener("submit",(event)=>{
  event.preventDefault();const button=byId("telegram-password-submit");withButton(button,"Mengirim…",async()=>{await api("/api/v1/channel-setup/telegram/tester/password",{method:"POST",body:{password:byId("telegram-password").value}});byId("telegram-password").value="";await loadChannels()}).catch(()=>{});
});
byId("telegram-tester-cancel").addEventListener("click",()=>withButton(byId("telegram-tester-cancel"),"Membatalkan…",async()=>{await api("/api/v1/channel-setup/telegram/tester/cancel",{method:"POST",body:{}});await loadChannels();showNotice("Pairing Telegram dibatalkan.")}).catch(()=>{}));
byId("telegram-tester-delete").addEventListener("click",()=>withButton(byId("telegram-tester-delete"),"Memulai pencabutan…",async()=>{await api("/api/v1/channel-setup/telegram/tester",{method:"DELETE",body:{confirmation:byId("telegram-tester-delete-confirm").value}});byId("telegram-tester-delete-confirm").value="";await loadChannels();showNotice("Pencabutan sesi akun Telegram penguji dimulai.")}).catch(()=>{}));
["telegram-tester","whatsapp-harvy","whatsapp-tester"].forEach((prefix)=>byId(prefix+"-qr-retry").addEventListener("click",()=>retryQrImage(prefix)));
["harvy","tester"].forEach((role)=>{
  const roleLabel=role==="harvy"?"Harvy":"penguji";
  byId("whatsapp-"+role+"-pair").addEventListener("click",()=>{if(!byId("whatsapp-"+role+"-dedicated").checked){showGlobalError(userError("Konfirmasikan bahwa akun WhatsApp "+roleLabel+" memang khusus pengujian."));return}const button=byId("whatsapp-"+role+"-pair");withButton(button,"Memulai…",async()=>{clearGlobalError();await api("/api/v1/channel-setup/whatsapp/"+role+"/pair",{method:"POST",body:{confirmation:"DEDICATED_TEST_ACCOUNT"}});await loadChannels();showNotice("Pairing akun WhatsApp "+roleLabel+" dimulai; tunggu QR muncul.")}).catch(()=>{})});
  byId("whatsapp-"+role+"-replace").addEventListener("click",()=>{if(!byId("whatsapp-"+role+"-replace-confirm").checked){showGlobalError(userError("Konfirmasikan bahwa akun WhatsApp "+roleLabel+" siap dipasangkan ulang."));return}const button=byId("whatsapp-"+role+"-replace");withButton(button,"Menyiapkan…",async()=>{clearGlobalError();await api("/api/v1/channel-setup/whatsapp/"+role+"/replace",{method:"POST",body:{confirmation:role==="harvy"?"REPLACE_WHATSAPP_HARVY_SESSION":"REPLACE_WHATSAPP_TESTER_SESSION"}});byId("whatsapp-"+role+"-replace-confirm").checked=false;await loadChannels();showNotice("Sesi lama sedang dicabut. QR baru akan muncul otomatis setelah aman.")}).catch(()=>{})});
  byId("whatsapp-"+role+"-cancel").addEventListener("click",()=>withButton(byId("whatsapp-"+role+"-cancel"),"Membatalkan…",async()=>{await api("/api/v1/channel-setup/whatsapp/"+role+"/cancel",{method:"POST",body:{}});await loadChannels();showNotice("Operasi akun WhatsApp "+roleLabel+" dibatalkan.")}).catch(()=>{}));
  byId("whatsapp-"+role+"-revoke").addEventListener("click",()=>withButton(byId("whatsapp-"+role+"-revoke"),"Memulai pencabutan…",async()=>{await api("/api/v1/channel-setup/whatsapp/"+role+"/session",{method:"DELETE",body:{confirmation:byId("whatsapp-"+role+"-revoke-confirm").value}});byId("whatsapp-"+role+"-revoke-confirm").value="";await loadChannels();showNotice("Pencabutan sesi akun WhatsApp "+roleLabel+" dimulai.")}).catch(()=>{}));
});
byId("price-model").addEventListener("change",syncPriceInputs);byId("price-input").addEventListener("input",validatePriceForm);byId("price-output").addEventListener("input",validatePriceForm);
byId("price-form").addEventListener("submit",(event)=>{
  event.preventDefault();if(!validatePriceForm())return;const button=byId("price-submit");
  withButton(button,"Menyimpan…",async()=>{clearGlobalError();const model=selectedConfiguredModel();if(!model)throw new Error("Tidak ada model environment yang dapat dipilih.");await api("/api/v1/prices/versions",{method:"POST",body:{providerId:model.providerId,modelId:model.modelId,inputPerMillionUsd:normalizeDecimal(byId("price-input").value),outputPerMillionUsd:normalizeDecimal(byId("price-output").value),effectiveFrom:new Date().toISOString()}});await load({quiet:true,requireFresh:true});showNotice("Versi harga baru dibuat. Biaya tercatat lama tidak berubah.")}).catch(()=>{});
});
byId("usage-apply").addEventListener("click",()=>withButton(byId("usage-apply"),"Memuat…",async()=>{const usage=await api(usagePath());state.attempts=usage.attempts;state.usageSummary=usage.summary;renderAttempts()}).catch(()=>{}));
function canAutoRefresh(){return activeTab==="overview"||activeTab==="groups"||activeTab==="usage"||activeTab==="audit"}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&csrf&&!busy&&canAutoRefresh())load({quiet:true,preserveForms:true})});
setInterval(()=>{if(document.visibilityState==="visible"&&csrf&&!busy&&canAutoRefresh())load({quiet:true,preserveForms:true})},60000);
setInterval(()=>{if(document.visibilityState==="visible"&&csrf&&activeTab==="channels")loadChannels(true)},1500);
restore();`;
