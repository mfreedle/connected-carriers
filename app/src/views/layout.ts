interface LayoutOptions {
  title: string;
  userName: string;
  content: string;
}

export function layout({ title, userName, content }: LayoutOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Connected Carriers</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --slate:  #1C2B3A;
    --slate2: #243447;
    --slate3: #2E4058;
    --amber:  #C8892A;
    --amber2: #E09B35;
    --cream:  #F7F5F0;
    --cream2: #EDE9E1;
    --cream3: #E0DAD0;
    --ink:    #141414;
    --muted:  #6B7A8A;
    --serif:  'Playfair Display', Georgia, serif;
    --sans:   'DM Sans', system-ui, sans-serif;
    --radius: 3px;
  }
  html, body { height: 100%; }
  body {
    font-family: var(--sans);
    background: #f0ede7;
    color: var(--ink);
    font-size: 14px;
    line-height: 1.5;
  }

  /* ── NAV ─────────────────────────────── */
  .nav {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    background: var(--slate);
    height: 56px;
    display: flex; align-items: center;
    padding: 0 28px;
    border-bottom: 1px solid var(--slate3);
    gap: 32px;
  }
  .nav-brand {
    font-family: var(--serif);
    font-size: 17px;
    color: var(--cream);
    text-decoration: none;
    white-space: nowrap;
  }
  .nav-brand span { color: var(--amber); }
  .nav-links { display: flex; align-items: center; gap: 4px; flex: 1; }
  .nav-link {
    padding: 6px 12px;
    border-radius: var(--radius);
    color: rgba(247,245,240,0.55);
    text-decoration: none;
    font-size: 13px;
    font-weight: 400;
    letter-spacing: 0.02em;
    transition: color 0.15s, background 0.15s;
  }
  .nav-link:hover { color: var(--cream); background: rgba(255,255,255,0.06); }
  .nav-link.active { color: var(--cream); background: rgba(255,255,255,0.1); }
  .nav-user {
    margin-left: auto;
    font-size: 12px;
    color: rgba(247,245,240,0.45);
    display: flex; align-items: center; gap: 12px;
  }
  .nav-user span { color: rgba(247,245,240,0.65); }
  .logout-btn {
    background: none; border: 1px solid rgba(255,255,255,0.15);
    color: rgba(247,245,240,0.55); padding: 4px 10px;
    border-radius: var(--radius); cursor: pointer;
    font-size: 12px; font-family: var(--sans);
    transition: all 0.15s;
  }
  .logout-btn:hover { border-color: rgba(255,255,255,0.3); color: var(--cream); }

  /* ── LAYOUT ──────────────────────────── */
  .main { margin-top: 56px; padding: 32px 28px; max-width: 1400px; margin-left: auto; margin-right: auto; }

  /* ── PAGE HEADER ─────────────────────── */
  .page-header { margin-bottom: 24px; }
  .back-link { font-size: 12px; color: var(--muted); text-decoration: none; display: block; margin-bottom: 8px; }
  .back-link:hover { color: var(--amber); }
  .page-title { font-family: var(--serif); font-size: 26px; font-weight: 400; color: var(--slate); }
  .page-sub { font-size: 13px; color: var(--muted); margin-top: 4px; }
  .page-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 13px; }
  .sep { color: var(--cream3); }

  /* ── CARDS ───────────────────────────── */
  .card {
    background: white;
    border-radius: 4px;
    border: 1px solid var(--cream3);
    padding: 20px 22px;
    margin-bottom: 16px;
  }
  .card-title {
    font-size: 11px; font-weight: 500; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--muted);
    margin-bottom: 14px; padding-bottom: 10px;
    border-bottom: 1px solid var(--cream2);
  }

  /* ── TABS ────────────────────────────── */
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--cream3); padding-bottom: 0; }
  .tab {
    padding: 8px 14px;
    font-size: 13px; color: var(--muted);
    text-decoration: none; border-radius: 3px 3px 0 0;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px; transition: all 0.15s;
  }
  .tab:hover { color: var(--slate); }
  .tab.active { color: var(--slate); border-bottom-color: var(--amber); font-weight: 500; }
  .tab-count {
    display: inline-block; background: var(--cream2); color: var(--muted);
    border-radius: 10px; padding: 1px 7px; font-size: 11px; margin-left: 4px;
  }
  .tab.active .tab-count { background: var(--amber); color: white; }

  /* ── TABLE ───────────────────────────── */
  .table-wrap { background: white; border-radius: 4px; border: 1px solid var(--cream3); overflow: hidden; }
  .data-table { width: 100%; border-collapse: collapse; }
  .data-table th {
    text-align: left; padding: 10px 14px;
    font-size: 11px; font-weight: 500; letter-spacing: 0.07em;
    text-transform: uppercase; color: var(--muted);
    background: var(--cream); border-bottom: 1px solid var(--cream3);
  }
  .data-table td { padding: 12px 14px; border-bottom: 1px solid var(--cream2); vertical-align: middle; }
  .data-table tr:last-child td { border-bottom: none; }
  .data-table tr:hover td { background: #faf9f7; }
  .carrier-name { font-weight: 500; color: var(--slate); font-size: 14px; }
  .carrier-contact { font-size: 12px; margin-top: 2px; }
  .fmcsa-cell { font-size: 12px; }
  .tier-cell { font-size: 12px; color: var(--muted); }
  .empty { padding: 40px; text-align: center; color: var(--muted); font-size: 14px; }

  /* ── BADGES ──────────────────────────── */
  .badge { padding: 3px 8px; border-radius: 2px; font-size: 11px; font-weight: 500; letter-spacing: 0.03em; }

  /* ── DETAIL GRID ─────────────────────── */
  .detail-grid { display: grid; grid-template-columns: 1fr 380px; gap: 20px; align-items: start; }
  .detail-left, .detail-right { display: flex; flex-direction: column; }

  /* ── INFO GRID ───────────────────────── */
  .info-grid { display: flex; flex-direction: column; gap: 8px; }
  .info-row { display: flex; gap: 12px; font-size: 13px; }
  .info-label { min-width: 120px; color: var(--muted); font-size: 12px; flex-shrink: 0; padding-top: 1px; }

  /* ── FMCSA BLOCK ─────────────────────── */
  .fmcsa-status { font-size: 14px; font-weight: 500; padding: 8px 12px; border-radius: 3px; }
  .fmcsa-status.pass { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
  .fmcsa-status.fail { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }

  /* ── FLAGS ───────────────────────────── */
  .flag-item { font-size: 12px; color: #b45309; background: #fffbeb; border: 1px solid #fde68a; padding: 6px 10px; border-radius: 2px; margin-bottom: 6px; }
  .flag-auto { color: #b91c1c; background: #fef2f2; border-color: #fecaca; }

  /* ── DOCS ────────────────────────────── */
  .doc-list { display: flex; flex-direction: column; gap: 8px; }
  .doc-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px; background: var(--cream); border-radius: 2px; }
  .doc-type { font-size: 13px; font-weight: 500; color: var(--slate); }
  .doc-expiry { font-size: 11px; margin-top: 2px; }
  .doc-status { font-size: 11px; font-weight: 500; }
  .doc-status.verified { color: #15803d; }
  .doc-status.pending { color: var(--muted); }

  /* ── DECISION PANEL ──────────────────── */
  .decision-card { border-left: 3px solid var(--amber); }
  .decision-reason { background: var(--cream); padding: 10px 12px; border-radius: 2px; font-size: 13px; margin-bottom: 14px; }
  .decision-reason .info-label { margin-bottom: 4px; }
  .decision-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
  .btn-decision {
    padding: 9px 12px; border: none; border-radius: 2px;
    font-family: var(--sans); font-size: 13px; font-weight: 500;
    cursor: pointer; transition: opacity 0.15s;
  }
  .btn-decision:hover { opacity: 0.85; }
  .btn-decision.approve { background: #10b981; color: white; }
  .btn-decision.conditional { background: #f97316; color: white; }
  .btn-decision.reject { background: #ef4444; color: white; }
  .btn-decision.more-info { background: var(--slate); color: white; }

  /* ── NOTES ───────────────────────────── */
  .note-list { display: flex; flex-direction: column; gap: 12px; }
  .note-item { padding: 10px 12px; background: var(--cream); border-radius: 2px; }
  .note-author { font-size: 11px; font-weight: 500; color: var(--slate); margin-bottom: 4px; }
  .note-time { font-weight: 400; }
  .note-body { font-size: 13px; color: var(--ink); line-height: 1.5; }

  /* ── ACTIVITY ────────────────────────── */
  .activity-list { display: flex; flex-direction: column; }
  .activity-item { padding: 10px 0; border-bottom: 1px solid var(--cream2); }
  .activity-item:last-child { border-bottom: none; }
  .activity-action { font-size: 13px; color: var(--slate); font-weight: 500; }
  .activity-time { font-size: 11px; margin-top: 2px; }
  .activity-meta { font-size: 12px; margin-top: 3px; font-style: italic; }

  /* ── FORMS ───────────────────────────── */
  .form-field { margin-bottom: 14px; }
  .field-label { display: block; font-size: 11px; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin-bottom: 5px; }
  .field-input {
    width: 100%; padding: 9px 12px;
    border: 1px solid var(--cream3); background: white;
    border-radius: 2px; font-family: var(--sans); font-size: 14px;
    color: var(--ink); outline: none; transition: border-color 0.15s;
    resize: vertical;
  }
  .field-input:focus { border-color: var(--amber); }
  .field-hint { font-size: 11px; color: var(--muted); margin-top: 4px; display: block; }

  /* ── SETTINGS ────────────────────────── */
  .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .toggle-row { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--cream2); }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-label { display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 13px; color: var(--slate); }
  .toggle-input { width: 16px; height: 16px; accent-color: var(--amber); flex-shrink: 0; }
  .settings-save { margin-top: 20px; padding-top: 20px; }

  /* ── ALERTS ──────────────────────────── */
  .alert { padding: 12px 16px; border-radius: 3px; margin-bottom: 20px; font-size: 13px; }
  .alert-success { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
  .alert-error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }

  /* ── BUTTONS ─────────────────────────── */
  .btn-primary {
    padding: 10px 22px; background: var(--amber); color: var(--slate);
    border: none; border-radius: 2px; font-family: var(--sans);
    font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.15s;
  }
  .btn-primary:hover { background: var(--amber2); }
  .btn-sm {
    padding: 6px 14px; background: var(--slate); color: var(--cream);
    border: none; border-radius: 2px; font-family: var(--sans);
    font-size: 12px; cursor: pointer; transition: background 0.15s;
  }
  .btn-sm:hover { background: var(--slate2); }
  .btn-link { color: var(--amber); text-decoration: none; font-size: 12px; font-weight: 500; white-space: nowrap; }
  .btn-link:hover { text-decoration: underline; }

  /* ── UTILS ───────────────────────────── */
  .muted { color: var(--muted); }
  code { font-family: 'Courier New', monospace; font-size: 12px; background: var(--cream); padding: 2px 5px; border-radius: 2px; color: var(--slate); }

  @media (max-width: 900px) {
    .detail-grid { grid-template-columns: 1fr; }
    .settings-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<nav class="nav">
  <a href="/dashboard" class="nav-brand">Connected<span>Carriers</span></a>
  <div class="nav-links">
    <a href="/dashboard" class="nav-link">Queue</a>
    <a href="/settings" class="nav-link">Settings</a>
  </div>
  <div class="nav-user">
    <span>${userName}</span>
    <form method="POST" action="/logout" style="display:inline">
      <button type="submit" class="logout-btn">Sign out</button>
    </form>
  </div>
</nav>
<main class="main">
  ${content}
</main>
</body>
</html>`;
}
