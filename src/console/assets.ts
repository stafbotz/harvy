export const CONSOLE_HTML = `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#091712">
  <title>Harvy Console</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <a class="skip-link" href="#main-content">Lewati ke konten utama</a>

  <main id="login-view" class="login-shell">
    <section class="login-brand" aria-labelledby="login-title">
      <div class="brand-mark" aria-hidden="true">H</div>
      <p class="eyebrow">HARVY · CONTROL PLANE LOKAL</p>
      <h1 id="login-title">Pantau Harvy dengan konteks yang jernih.</h1>
      <p class="login-copy">Biaya, penggunaan model, akses beta, dan audit operator berada di satu tempat—tanpa menyimpan isi percakapan di Console.</p>
      <div class="trust-list" aria-label="Batas Console">
        <span>Loopback saja</span><span>Tanpa isi chat</span><span>Sesi terbatas</span>
      </div>
    </section>
    <section class="login-card" aria-labelledby="login-form-title">
      <p class="eyebrow">AKSES OPERATOR</p>
      <h2 id="login-form-title">Masuk ke Console</h2>
      <p>Gunakan token operator yang dicetak saat Harvy mulai.</p>
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
        <button id="nav-access" role="tab" aria-selected="false" aria-controls="tab-access" tabindex="-1" data-tab="access"><span aria-hidden="true">◇</span>Akses</button>
        <button id="nav-groups" role="tab" aria-selected="false" aria-controls="tab-groups" tabindex="-1" data-tab="groups"><span aria-hidden="true">◎</span>Grup</button>
        <button id="nav-plans" role="tab" aria-selected="false" aria-controls="tab-plans" tabindex="-1" data-tab="plans"><span aria-hidden="true">▤</span>Paket</button>
        <button id="nav-prices" role="tab" aria-selected="false" aria-controls="tab-prices" tabindex="-1" data-tab="prices"><span aria-hidden="true">$</span>Harga model</button>
        <button id="nav-usage" role="tab" aria-selected="false" aria-controls="tab-usage" tabindex="-1" data-tab="usage"><span aria-hidden="true">↗</span>Penggunaan</button>
        <button id="nav-audit" role="tab" aria-selected="false" aria-controls="tab-audit" tabindex="-1" data-tab="audit"><span aria-hidden="true">✓</span>Audit</button>
      </nav>
      <div class="sidebar-foot">
        <span class="privacy-dot" aria-hidden="true"></span>
        <p><strong>Privasi aktif</strong><br>Console tidak menerima isi pesan.</p>
      </div>
    </aside>

    <main id="main-content" class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">HARVY CONSOLE</p>
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
        <div class="section-intro"><div><p class="kicker">AKUNTABILITAS</p><h2>Audit operator</h2><p>Riwayat perubahan control plane tanpa isi percakapan atau kredensial.</p></div></div>
        <article class="panel"><div id="audits"></div></article>
      </section>
    </main>
  </div>
  <script src="/app.js" defer></script>
</body>
</html>`;

export const CONSOLE_CSS = `:root{
  color-scheme:dark;
  --bg:#08130f;--bg-soft:#0d1d17;--panel:#10231b;--panel-strong:#142c22;
  --line:#254337;--line-soft:#1c352a;--text:#f4f8f5;--muted:#9fb5aa;--faint:#6e887b;
  --mint:#8de0b5;--mint-strong:#54c98f;--mint-ink:#082217;--amber:#f2c66e;--amber-bg:#352b16;
  --red:#ff9d91;--red-bg:#321b18;--blue:#9dc8ff;--shadow:0 24px 70px rgba(0,0,0,.28);
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:radial-gradient(circle at 75% -10%,rgba(64,139,103,.16),transparent 38%),var(--bg);color:var(--text);min-height:100vh;font-size:15px}
button,input,select{font:inherit;border-radius:10px;border:1px solid var(--line)}
button{cursor:pointer;min-height:42px;padding:10px 15px;background:var(--mint);border-color:transparent;color:var(--mint-ink);font-weight:750;transition:transform .15s ease,filter .15s ease,border-color .15s ease}
button:hover:not(:disabled){filter:brightness(1.07);transform:translateY(-1px)}button:disabled{cursor:not-allowed;opacity:.48}
button.ghost{background:transparent;color:var(--text);border-color:var(--line)}button.compact{min-height:36px;padding:7px 11px;font-size:.84rem}
input,select{width:100%;min-height:42px;padding:9px 11px;color:var(--text);background:#0a1913;outline:none}
input:focus,select:focus{border-color:var(--mint-strong);box-shadow:0 0 0 3px rgba(84,201,143,.13)}
button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid var(--amber);outline-offset:3px}
label{display:grid;gap:7px;color:var(--muted);font-size:.82rem;font-weight:650}
h1,h2,h3,p{margin-top:0}h1{font-size:clamp(1.65rem,3vw,2.35rem);line-height:1.08;letter-spacing:-.035em;margin-bottom:7px}
h2{font-size:1.35rem;margin-bottom:7px;letter-spacing:-.015em}h3{font-size:1.05rem;margin-bottom:6px}p{color:var(--muted);line-height:1.55}
code{color:var(--mint);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.hidden{display:none!important}.visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.skip-link{position:fixed;z-index:100;top:10px;left:10px;transform:translateY(-160%);background:var(--amber);color:#211704;padding:9px 12px;border-radius:8px;font-weight:700}.skip-link:focus{transform:none}
.eyebrow,.kicker,.period-label{margin:0 0 7px;color:var(--mint);font-size:.69rem;font-weight:800;letter-spacing:.16em}
.brand-mark{display:grid;place-items:center;width:54px;height:54px;border-radius:17px;background:linear-gradient(145deg,var(--mint),#4aba82);color:#082016;font-size:1.5rem;font-weight:900;box-shadow:0 15px 35px rgba(84,201,143,.18)}
.brand-mark.small{width:39px;height:39px;border-radius:12px;font-size:1.05rem;box-shadow:none}
.login-shell{width:min(1080px,calc(100% - 36px));min-height:100vh;margin:auto;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.72fr);gap:70px;align-items:center;padding:50px 0}
.login-brand h1{max-width:640px;font-size:clamp(2.2rem,5.5vw,4.5rem);margin:25px 0 18px}.login-copy{max-width:620px;font-size:1.05rem}
.trust-list{display:flex;gap:8px;flex-wrap:wrap;margin-top:28px}
.trust-list span,.status-badge,.badge{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:6px 10px;color:var(--muted);font-size:.76rem;font-weight:700;background:rgba(13,29,23,.8)}
.login-card,.panel{background:linear-gradient(145deg,rgba(18,42,32,.97),rgba(13,29,23,.97));border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}
.login-card{padding:28px}.login-card form{display:grid;gap:12px;margin:24px 0 8px}.form-error,.field-error{color:var(--red);font-size:.8rem;min-height:1.2em}.fineprint{font-size:.77rem;color:var(--faint)}
.app-shell{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;padding:26px 17px 20px;border-right:1px solid var(--line-soft);background:rgba(7,18,13,.91);backdrop-filter:blur(18px);display:flex;flex-direction:column;z-index:10}
.sidebar-brand{display:flex;align-items:center;gap:11px;padding:0 8px 25px}.sidebar-brand strong,.sidebar-brand span{display:block}.sidebar-brand strong{font-size:1.05rem}.sidebar-brand span{font-size:.78rem;color:var(--muted)}
.nav-tabs{display:grid;gap:5px}.nav-tabs button{display:flex;align-items:center;gap:11px;justify-content:flex-start;min-height:43px;background:transparent;color:var(--muted);border-color:transparent;text-align:left}
.nav-tabs button span{width:20px;text-align:center;color:var(--faint);font-size:1rem}.nav-tabs button.active{background:var(--panel-strong);border-color:var(--line);color:var(--text)}.nav-tabs button.active span{color:var(--mint)}
.sidebar-foot{margin-top:auto;display:flex;gap:9px;align-items:flex-start;padding:14px 8px 0;border-top:1px solid var(--line-soft)}.sidebar-foot p{margin:0;font-size:.72rem;line-height:1.45}.sidebar-foot strong{color:var(--text)}
.privacy-dot{width:8px;height:8px;margin-top:4px;border-radius:50%;background:var(--mint);box-shadow:0 0 0 4px rgba(141,224,181,.1)}
.workspace{width:min(1400px,100%);padding:30px clamp(22px,4vw,58px) 70px;overflow:hidden}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:28px}.page-description{margin:0}.top-actions{display:flex;align-items:center;gap:9px}
.sync-state{display:grid;text-align:right;justify-items:end;gap:5px;margin-right:4px}.sync-state>span:last-child{font-size:.69rem;color:var(--faint)}
.status-badge{padding:4px 9px}.status-badge.ready{color:var(--mint);border-color:#37614c}.status-badge.warning{color:var(--amber);border-color:#685528}.status-badge.neutral{color:var(--muted)}
.icon-button{width:42px;padding:0;font-size:1.2rem;background:transparent;color:var(--text);border-color:var(--line)}
.loading-bar{height:3px;position:fixed;z-index:30;top:0;left:236px;right:0;overflow:hidden;background:rgba(141,224,181,.12)}.loading-bar:after{content:"";display:block;width:36%;height:100%;background:var(--mint);animation:loading 1.05s ease-in-out infinite}
@keyframes loading{from{transform:translateX(-120%)}to{transform:translateX(390%)}}
.notice,.error-banner{border-radius:12px;padding:12px 14px;margin:-8px 0 20px}.notice{border:1px solid #355d49;background:#102a1f;color:var(--mint)}
.error-banner{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid #684039;background:var(--red-bg);color:var(--red)}.error-banner div{display:grid;gap:3px}.error-banner span{font-size:.82rem}
.tabpanel{outline:none}.period-label{color:var(--faint);margin-bottom:12px}
.summary-grid{display:grid;grid-template-columns:1.25fr repeat(3,1fr);gap:13px}.summary-card{position:relative;min-height:145px;padding:19px;border:1px solid var(--line);border-radius:17px;background:linear-gradient(145deg,var(--panel-strong),var(--bg-soft));overflow:hidden}
.summary-card.primary:after{content:"";position:absolute;width:120px;height:120px;right:-40px;top:-55px;border-radius:50%;background:rgba(141,224,181,.08)}
.summary-label{display:block;color:var(--muted);font-size:.76rem;font-weight:700}.summary-value{display:block;margin:15px 0 8px;font-size:clamp(1.45rem,2.6vw,2.15rem);line-height:1;font-weight:800;letter-spacing:-.035em}.summary-detail{color:var(--faint);font-size:.73rem;line-height:1.4}
.cost-banner{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-top:14px;padding:15px 17px;border:1px solid #66552d;border-radius:14px;background:linear-gradient(90deg,var(--amber-bg),rgba(53,43,22,.4))}
.cost-banner strong{display:block;color:var(--amber);margin-bottom:3px}.cost-banner span{font-size:.8rem;color:#d8c79e}
.content-grid{display:grid;gap:16px;margin-top:16px}.content-grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{padding:20px;box-shadow:none}
.panel-head,.section-intro{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.panel-head p,.section-intro p{margin-bottom:0}.section-intro{margin-bottom:18px}.section-intro>div{max-width:760px}.section-intro h2{font-size:1.55rem}
.diagnostics{margin-top:16px}.diagnostics summary{cursor:pointer;color:var(--muted);font-weight:700}.diagnostics[open] summary{margin-bottom:18px;color:var(--text)}
.diagnostic-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.diagnostic-item{padding:12px;border-radius:11px;background:rgba(7,20,14,.55);border:1px solid var(--line-soft)}
.diagnostic-item span,.diagnostic-item strong{display:block}.diagnostic-item span{font-size:.7rem;color:var(--faint)}.diagnostic-item strong{margin-top:5px;font-size:1rem}
.form-panel{margin-bottom:16px}.form-grid{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr)) auto;align-items:start;gap:12px;margin-top:16px}.form-grid button{align-self:end}
.price-form{grid-template-columns:minmax(220px,1.4fr) repeat(2,minmax(170px,1fr)) auto}.filter-grid{grid-template-columns:repeat(2,minmax(160px,240px)) auto;margin-top:0}.filter-panel{margin-bottom:14px}
.table-scroll{width:100%;overflow:auto}table{width:100%;border-collapse:collapse}caption{text-align:left;color:var(--faint);padding:0 0 10px;font-size:.75rem}
th,td{text-align:left;border-bottom:1px solid var(--line-soft);padding:12px 9px;font-size:.79rem;vertical-align:middle}th{color:var(--faint);font-weight:700;white-space:nowrap}tbody tr:last-child td{border-bottom:0}td code{font-size:.74rem;overflow-wrap:anywhere}
.cell-stack{display:grid;gap:3px}.cell-stack small{color:var(--faint);font-size:.69rem}.actions{display:flex;gap:7px;align-items:center}.actions button{white-space:nowrap}
.badge{padding:4px 8px}.badge.good{color:var(--mint);border-color:#37614c}.badge.warn{color:var(--amber);border-color:#66552d}.badge.bad{color:var(--red);border-color:#684039}.badge.info{color:var(--blue);border-color:#39506b}
.empty-state{display:grid;place-items:center;text-align:center;min-height:160px;padding:25px;border:1px dashed var(--line);border-radius:14px;color:var(--muted)}.empty-state.compact{min-height:90px}.empty-state strong{display:block;color:var(--text);margin-bottom:5px}.empty-state p{max-width:440px;margin:0;font-size:.82rem}
.model-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px;margin-bottom:16px}.model-card{padding:16px;border:1px solid var(--line);border-radius:15px;background:var(--bg-soft)}
.model-card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.model-card h3{overflow-wrap:anywhere}.model-card p{font-size:.75rem;margin:8px 0 0}
.model-price{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:14px}.model-price div{padding:9px;border-radius:9px;background:#091710}.model-price span,.model-price strong{display:block}.model-price span{color:var(--faint);font-size:.65rem}.model-price strong{margin-top:3px;font-size:.83rem}
.price-editor{margin-bottom:16px}.group-list{display:grid;gap:13px}.group-card{border:1px solid var(--line);border-radius:17px;background:var(--panel);overflow:hidden}
.group-card-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding:17px 19px;border-bottom:1px solid var(--line-soft)}.group-card-head h3{margin:0}.group-meta{display:flex;gap:6px;flex-wrap:wrap}.group-body{padding:6px 15px 12px}
.usage-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}.usage-chip{padding:13px 15px;border:1px solid var(--line);border-radius:13px;background:var(--bg-soft)}.usage-chip span,.usage-chip strong{display:block}.usage-chip span{font-size:.69rem;color:var(--faint)}.usage-chip strong{margin-top:5px}
@media(max-width:1100px){.summary-grid{grid-template-columns:repeat(2,1fr)}.diagnostic-grid{grid-template-columns:repeat(3,1fr)}.form-grid,.price-form{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:900px){.app-shell{display:block}.sidebar{position:sticky;height:auto;padding:12px 16px 10px;border-right:0;border-bottom:1px solid var(--line-soft)}.sidebar-brand{padding:0 0 10px}.sidebar-brand .brand-mark{width:33px;height:33px}.nav-tabs{display:flex;overflow:auto;gap:6px;padding-bottom:2px}.nav-tabs button{white-space:nowrap;min-height:38px;padding:7px 10px}.sidebar-foot{display:none}.workspace{padding:24px 20px 60px}.loading-bar{left:0}.login-shell{grid-template-columns:1fr;gap:30px;max-width:660px}.login-brand h1{font-size:clamp(2.2rem,9vw,3.6rem)}}
@media(max-width:720px){body{font-size:14px}.workspace{padding:20px 12px 50px}.topbar{display:grid;gap:14px}.top-actions{width:100%}.sync-state{margin-right:auto;text-align:left;justify-items:start}.summary-grid,.content-grid.two,.usage-summary{grid-template-columns:1fr}.summary-card{min-height:122px}.summary-value{margin:12px 0 7px}.cost-banner,.section-intro,.panel-head,.group-card-head{align-items:flex-start;flex-direction:column}.diagnostic-grid{grid-template-columns:repeat(2,1fr)}.form-grid,.price-form,.filter-grid{grid-template-columns:1fr}.panel,.login-card{padding:16px;border-radius:15px}.login-shell{width:min(100% - 24px,660px);padding:30px 0}.login-brand{padding:8px}.table-scroll{overflow:visible}table.responsive thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}table.responsive,table.responsive tbody,table.responsive tr,table.responsive td{display:block;width:100%}table.responsive tr{padding:10px 0;border-bottom:1px solid var(--line-soft)}table.responsive tr:last-child{border-bottom:0}table.responsive td{display:grid;grid-template-columns:minmax(105px,38%) minmax(0,1fr);gap:10px;border:0;padding:6px 3px;overflow-wrap:anywhere}table.responsive td:before{content:attr(data-label);color:var(--faint);font-size:.7rem;font-weight:700}table.responsive td:empty{display:none}.actions{flex-wrap:wrap}.group-body{padding:4px 14px 10px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition:none!important}}
`;

export const CONSOLE_JS = `"use strict";
let csrf=null;
let state={dashboard:null,plans:[],prices:[],configuredModels:[],enrollments:[],attempts:[],usageSummary:null,audit:[],groupDetails:null};
let activeTab="overview",busy=false,groupLoading=false,activeLoad=null;
const byId=(id)=>document.getElementById(id);
const el=(tag,text,klass)=>{const node=document.createElement(tag);if(text!==undefined&&text!==null)node.textContent=String(text);if(klass)node.className=klass;return node};
const labels={
  cohort:{standard:"Standar",beta:"Beta"},kind:{private:"Pribadi",group:"Grup"},channel:{telegram:"Telegram",whatsapp:"WhatsApp",system:"Sistem"},
  mode:{direct_only:"Hanya saat dipanggil",ambient:"Boleh nimbrung",paused:"Dijeda",disabled:"Dinonaktifkan",none:"Tanpa mode",workspace:"Workspace"},
  audience:{personal:"Pribadi",group:"Grup",workspace:"Workspace"},planStatus:{pilot:"Pilot",active:"Aktif",retired:"Dipensiunkan"},
  consent:{not_invited:"Belum diundang",invited:"Menunggu persetujuan",granted:"Disetujui",withdrawn:"Dicabut",expired:"Kedaluwarsa"},
  origin:{primary:"Utama",fallback:"Cadangan"},tier:{cheap:"Ringan",efficient:"Efisien",ambitious:"Mendalam"},
  purpose:{"turn-boundary":"Batas giliran",understanding:"Pemahaman","due-date":"Membaca waktu","risk-triage":"Triase keselamatan","memory-privacy":"Privasi memori","group-ingress":"Ingress grup",reply:"Balasan","reply-review":"Review balasan",summary:"Ringkasan",agent:"Agent",research:"Research web","insight":"Catatan keselamatan",session:"Sesi","group-participation":"Rencana partisipasi grup","group-reply":"Balasan grup"},
  attemptStatus:{started:"Sedang berjalan",completed:"Selesai",http_error:"Gangguan HTTP",network_error:"Gangguan jaringan",timeout:"Waktu habis",cancelled:"Dibatalkan",response_rejected:"Respons ditolak",unknown:"Status belum dipastikan"},
  auditAction:{session_login:"Masuk Console",session_logout:"Keluar Console",enrollment_create:"Tambah akses",enrollment_update:"Ubah akses",evaluation_invite:"Undang evaluasi",evaluation_revoke:"Cabut evaluasi",plan_version_create:"Buat versi paket",price_version_create:"Buat versi harga",runtime_mode_update:"Ubah mode runtime",unknown_mutation:"Perubahan tidak dikenal"},
  outcome:{succeeded:"Berhasil",rejected:"Ditolak",failed:"Gagal"},
  source:{provider:"Dilaporkan provider",catalog:"Katalog saat request","current_catalog_estimate":"Estimasi tarif sekarang",unavailable:"Belum dapat dihitung",unpriced:"Belum bertarif"}
};
const pageCopy={overview:["Ringkasan","Kesehatan dan biaya operasional dalam 24 jam terakhir."],access:["Akses","Atur pengguna, grup, paket, dan persetujuan evaluasi."],groups:["Grup","Pantau biaya grup dan bucket anggota pemicu secara pseudonim."],plans:["Paket","Lihat batas dan posisi katalog paket pilot."],prices:["Harga model","Tetapkan harga untuk model yang ditemukan dari environment."],usage:["Penggunaan","Telusuri attempt provider, token, dan asal biayanya."],audit:["Audit","Periksa perubahan operator tanpa membuka isi percakapan."]};
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
function showNotice(message){const box=byId("notice");box.textContent=message;box.classList.toggle("hidden",!message);clearTimeout(showNotice.timer);if(message)showNotice.timer=setTimeout(()=>box.classList.add("hidden"),5500)}
function showGlobalError(error){byId("global-error-text").textContent=error?.message||"Terjadi kesalahan yang tidak dikenali.";byId("global-error").classList.remove("hidden")}
function clearGlobalError(){byId("global-error").classList.add("hidden")}
async function withButton(button,pendingLabel,operation){const previous=button.textContent;button.disabled=true;button.textContent=pendingLabel;try{return await operation()}catch(error){showGlobalError(error);throw error}finally{button.disabled=false;button.textContent=previous;if(button.id==="price-submit")validatePriceForm()}}
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
function breakdownRows(items,key){return items.map((item)=>{const cost=costPresentation(item.summary);return [key==="cohort"?translated("cohort",item[key]):item[key],number(item.summary.logicalRequests),number(item.summary.totalTokens),stack(cost.value,cost.detail),costBadge(item.summary)]})}
function renderBreakdowns(){const breakdown=state.dashboard?.breakdown||{byCohort:[],byPlan:[]};byId("cohort-breakdown").replaceChildren(table(["Akses","Request","Token","Biaya indikatif","Cakupan"],breakdownRows(breakdown.byCohort,"cohort"),"Penggunaan per akses"));byId("plan-breakdown").replaceChildren(table(["Paket","Request","Token","Biaya indikatif","Cakupan"],breakdownRows(breakdown.byPlan,"planId"),"Penggunaan per paket"))}
function renderPlans(){const rows=latestPlans().map((plan)=>[stack(plan.publicName,plan.planId),translated("audience",plan.audience),rupiah(plan.monthlyPriceIdr),number(plan.rolling24hTokenLimit),plan.activeMemberLimit===null?"—":number(plan.activeMemberLimit),translated("mode",plan.groupMode),badge(translated("planStatus",plan.status),plan.status==="active"?"good":plan.status==="retired"?"bad":"warn")]);byId("plans").replaceChildren(table(["Paket","Audiens","Harga / bulan","Token / 24 jam","Anggota aktif","Mode","Status"],rows,"Katalog paket"))}
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
  renderSummary();renderBreakdowns();renderPlans();
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
    const results=await Promise.allSettled([api("/api/v1/dashboard"),api("/api/v1/control-plane"),api(usagePath()),api("/api/v1/audit")]);
    if(results[0].status==="rejected")throw results[0].reason;if(results[1].status==="rejected")throw results[1].reason;
    const dashboard=results[0].value,control=results[1].value,usage=results[2].status==="fulfilled"?results[2].value:{summary:null,attempts:[]},audit=results[3].status==="fulfilled"?results[3].value:{records:[]};
    state={...state,...control,dashboard,attempts:usage.attempts,usageSummary:usage.summary,audit:audit.records,groupDetails:null};renderAll({preserveForms:options.preserveForms===true});
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
function showLogin(){csrf=null;byId("app-view").classList.add("hidden");byId("login-view").classList.remove("hidden")}
async function restore(){try{const session=await api("/api/v1/session");csrf=session.csrfToken;showApp();await load()}catch(error){showLogin();if(error?.status!==401)byId("login-error").textContent=error.message}}
function switchTab(name,focus=false){
  activeTab=name;const tabs=[...document.querySelectorAll("[data-tab]")];
  tabs.forEach((button)=>{const selected=button.dataset.tab===name;button.classList.toggle("active",selected);button.setAttribute("aria-selected",String(selected));button.tabIndex=selected?0:-1;if(selected&&focus)button.focus()});
  document.querySelectorAll(".tabpanel").forEach((panel)=>panel.classList.toggle("hidden",panel.id!=="tab-"+name));
  const copy=pageCopy[name]||pageCopy.overview;byId("page-title").textContent=copy[0];byId("page-description").textContent=copy[1];if(name==="groups")loadGroups().catch(showGlobalError);
}
byId("login-form").addEventListener("submit",(event)=>{
  event.preventDefault();const button=byId("login-submit");byId("login-error").textContent="";
  withButton(button,"Memeriksa…",async()=>{const result=await api("/api/v1/session",{method:"POST",body:{token:byId("operator-token").value}});csrf=result.csrfToken;byId("operator-token").value="";showApp();await load()}).catch((error)=>{byId("global-error").classList.add("hidden");byId("login-error").textContent=error.message});
});
byId("logout").addEventListener("click",()=>withButton(byId("logout"),"Keluar…",async()=>{await api("/api/v1/session",{method:"DELETE",body:{}}).catch(()=>{});showLogin()}).catch(()=>{}));
byId("refresh").addEventListener("click",()=>load({forceGroups:activeTab==="groups"}));byId("retry-load").addEventListener("click",()=>load({forceGroups:activeTab==="groups"}));
byId("refresh-groups").addEventListener("click",()=>withButton(byId("refresh-groups"),"Menyegarkan…",()=>loadGroups(true)).catch(()=>{}));
document.querySelectorAll("[data-tab]").forEach((button)=>{
  button.addEventListener("click",()=>switchTab(button.dataset.tab));
  button.addEventListener("keydown",(event)=>{const tabs=[...document.querySelectorAll("[data-tab]")],current=tabs.indexOf(button);let next=null;if(event.key==="ArrowDown"||event.key==="ArrowRight")next=(current+1)%tabs.length;if(event.key==="ArrowUp"||event.key==="ArrowLeft")next=(current-1+tabs.length)%tabs.length;if(event.key==="Home")next=0;if(event.key==="End")next=tabs.length-1;if(next!==null){event.preventDefault();switchTab(tabs[next].dataset.tab,true)}});
});
byId("enroll-form").addEventListener("submit",(event)=>{
  event.preventDefault();const button=byId("enroll-submit");
  withButton(button,"Menambahkan…",async()=>{clearGlobalError();await api("/api/v1/enrollments",{method:"POST",body:{kind:byId("enroll-kind").value,channel:byId("enroll-channel").value,externalId:byId("enroll-id").value,operatorLabel:byId("enroll-label").value||null}});byId("enroll-id").value="";byId("enroll-label").value="";await load({quiet:true,requireFresh:true});showNotice("Akses pseudonim berhasil ditambahkan.")}).catch(()=>{});
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
restore();`;
