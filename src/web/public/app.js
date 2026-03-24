/* IPM Web Dashboard */

// ── Agent metadata ────────────────────────────────────────────────────────────
const AGENT = {
  TLI:            { color: '#FF6400', label: 'Agent TLI' },
  PMC:            { color: '#38bdf8', label: 'Agent PMC' },
  CRM:            { color: '#22c55e', label: 'Agent CRM' },
  TSP:            { color: '#fbbf24', label: 'Agent TSP' },
  DCL:            { color: '#f87171', label: 'Agent DCL' },
  MNC:            { color: '#c084fc', label: 'Agent MNC' },
  cursor:         { color: '#22c55e', label: 'Cursor' },
  tui:            { color: '#f2f2f2', label: 'System' },
  runner:         { color: '#888',    label: 'Runner' },
};

const MSG_META = {
  info:      { sender: 'System',    icon: 'icon-cpu' },
  thinking:  { sender: 'Thinking',   icon: 'icon-loader' },
  prompting: { sender: 'Prompting', icon: 'icon-arrow-right' },
  cursor:    { sender: 'Cursor',    icon: 'icon-zap' },
  reading:   { sender: 'Reading',    icon: 'icon-eye' },
  done:      { sender: 'Done',      icon: 'icon-check' },
  error:     { sender: 'Error',     icon: 'icon-x' },
  detail:    { sender: 'Detail',    icon: 'icon-cpu' },
};

const STATE_LABEL = {
  idle:              'Idle',
  writing:           'Writing',
  thinking:          'Thinking',
  waiting_for_input: 'Input Needed',
};

// ── Theme ─────────────────────────────────────────────────────────────────────
const NOTION_DARK  = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ16vftkaN8OYW8rNPvNjpuemjEUmumeibwyw&s';
const NOTION_LIGHT = 'https://www.pngall.com/wp-content/uploads/15/Notion-Logo-PNG-File.png';
const CURSOR_DARK  = 'https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/dark/cursor.png';
const CURSOR_LIGHT = 'https://www.logoshape.com/wp-content/uploads/2025/03/Cursor_Vector_Logo.png';

function setupTheme() {
  const isLight = localStorage.getItem('theme') === 'light';
  applyTheme(isLight);

  $('theme-toggle').addEventListener('click', () => {
    const nowLight = !document.body.classList.contains('light');
    localStorage.setItem('theme', nowLight ? 'light' : 'dark');
    applyTheme(nowLight);
  });
}

function applyTheme(light) {
  document.body.classList.toggle('light', light);
  $('theme-icon-sun').classList.toggle('hidden', light);
  $('theme-icon-moon').classList.toggle('hidden', !light);
  $('theme-label').textContent = light ? 'Dark mode' : 'Light mode';

  // Swap all theme-aware images
  document.querySelectorAll('[data-dark-src]').forEach(img => {
    img.src = light ? img.dataset.lightSrc : img.dataset.darkSrc;
  });
}


let selectedIde = 'cursor';
let runStartedAt = null;
let elapsedTimer = null;
let currentView = 'dashboard';

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setupNav();
  setupIdeSelector();
  setupTheme();

  const res = await fetch('/docs').then(r => r.json()).catch(() => ({ error: 'network' }));
  if (res.error === 'no_token' || res.error === 'network') {
    showView('token-screen');
  } else if (res.error === 'no_cursor_key') {
    showView('cursor-screen');
  } else if (res.ok) {
    renderDocs(res.docs);
  }

  const status = await fetch('/run/status').then(r => r.json()).catch(() => ({}));
  if (status.running) {
    showView('dashboard-view');
    startRunUI(status.run?.docTitle || '', status.run?.startedAt || Date.now());
  }

  connectSSE();
  startFramePoller();
}

// ── Navigation ────────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      if (view === 'dashboard') showView('dashboard-view');
      if (view === 'preview')   showView('preview-view');
    });
  });
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $(id)?.classList.remove('hidden');
  currentView = id;
}

// ── IDE selector ──────────────────────────────────────────────────────────────
function setupIdeSelector() {
  document.querySelectorAll('.ide-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ide-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedIde = btn.dataset.ide;
    });
  });
}

// ── Token setup ───────────────────────────────────────────────────────────────
$('token-btn').addEventListener('click', async () => {
  const token = $('token-input').value.trim();
  if (!token) return;
  $('token-btn').disabled = true;
  $('token-error').classList.add('hidden');

  const res = await fetch('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));

  $('token-btn').disabled = false;
  if (res.ok) {
    const docs = await fetch('/docs').then(r => r.json());
    if (docs.error === 'no_cursor_key') {
      showView('cursor-screen');
    } else {
      renderDocs(docs.docs || []);
    }
  } else {
    $('token-error').textContent = res.error;
    $('token-error').classList.remove('hidden');
  }
});

$('token-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('token-btn').click(); });

// ── Cursor key setup ──────────────────────────────────────────────────────────
$('cursor-key-btn').addEventListener('click', async () => {
  const key = $('cursor-key-input').value.trim();
  if (!key) return;
  $('cursor-key-btn').disabled = true;
  $('cursor-key-error').classList.add('hidden');

  const res = await fetch('/cursor-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));

  $('cursor-key-btn').disabled = false;
  if (res.ok) {
    const docs = await fetch('/docs').then(r => r.json());
    renderDocs(docs.docs || []);
  } else {
    $('cursor-key-error').textContent = res.error;
    $('cursor-key-error').classList.remove('hidden');
  }
});

$('cursor-key-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('cursor-key-btn').click(); });

// ── Doc picker ────────────────────────────────────────────────────────────────
function renderDocs(docs) {
  const list = $('docs-list');
  list.innerHTML = '';
  if (!docs.length) {
    list.innerHTML = '<div style="color:var(--text-3);padding:20px;grid-column:1/-1">No documents found in your Notion workspace.</div>';
  }
  docs.forEach(doc => {
    const card = document.createElement('div');
    card.className = 'doc-card';
    const notionSrc = document.body.classList.contains('light') ? NOTION_LIGHT : NOTION_DARK;    card.innerHTML = `
      <img src="${notionSrc}"
        data-dark-src="${NOTION_DARK}"
        data-light-src="${NOTION_LIGHT}"
        class="doc-card-icon" alt="" />
      <span class="doc-card-title">${esc(doc.title)}</span>
    `;
    card.addEventListener('click', () => startRun(doc));
    list.appendChild(card);
  });
  showView('docs-screen');
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function startRun(doc) {
  showView('dashboard-view');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-view="dashboard"]')?.classList.add('active');
  $('log').innerHTML = '';
  startRunUI(doc.title, Date.now());

  await fetch('/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId: doc.id, docTitle: doc.title, ide: selectedIde }),
  });
}

function startRunUI(title, startedAt) {
  runStartedAt = startedAt;
  $('run-info-bar').classList.remove('hidden');
  $('run-doc-label').textContent = title;
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - runStartedAt) / 1000);
    $('run-elapsed').textContent = `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  }, 1000);
}

function stopRunUI() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  $('run-info-bar').classList.add('hidden');
}

$('new-run-btn').addEventListener('click', async () => {
  const docs = await fetch('/docs').then(r => r.json());
  renderDocs(docs.docs || []);
});

$('clear-log').addEventListener('click', () => { $('log').innerHTML = ''; });

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/events');

  es.addEventListener('log',          e => { const d = JSON.parse(e.data); appendMsg(d.msg, d.type); });
  es.addEventListener('bus',           e => appendBus(JSON.parse(e.data)));
  es.addEventListener('cursor_state',  e => { const d = JSON.parse(e.data); updateState(d.state, d.lastResponseText); });
  es.addEventListener('run_start',     e => { const d = JSON.parse(e.data); appendMsg(`Started: ${d.docTitle} via ${d.ide || 'cursor'}`, 'cursor'); });
  es.addEventListener('run_done',      e => { const d = JSON.parse(e.data); appendMsg(`Build complete → ${d.projectPath}`, 'done'); stopRunUI(); });
  es.addEventListener('run_error',     e => { const d = JSON.parse(e.data); appendMsg(d.error, 'error'); stopRunUI(); });

  es.onerror = () => setTimeout(connectSSE, 2000);
}

// ── Log rendering ─────────────────────────────────────────────────────────────
function appendMsg(text, type = 'info') {
  const meta = MSG_META[type] || MSG_META.info;
  const row = document.createElement('div');
  row.className = `msg msg-${type}`;
  row.innerHTML = `
    <div class="msg-avatar">
      <svg><use href="#${meta.icon}"/></svg>
    </div>
    <div class="msg-body">
      <div class="msg-sender">${meta.sender}</div>
      <div class="msg-text">${esc(text)}</div>
    </div>
  `;
  $('log').appendChild(row);
  $('log').scrollTop = $('log').scrollHeight;
}

function appendBus(entry) {
  const fromMeta = AGENT[entry.from] || { color: '#888', label: entry.from };
  const toMeta   = AGENT[entry.to]   || { color: '#888', label: entry.to };
  const row = document.createElement('div');
  row.className = 'msg-bus';
  row.innerHTML = `
    <span class="bus-from" style="color:${fromMeta.color}">${esc(fromMeta.label)}</span>
    <span class="bus-arrow">→</span>
    <span class="bus-to" style="color:${toMeta.color}">${esc(toMeta.label)}</span>
    <span class="bus-msg">${esc(entry.content || '')}</span>
  `;
  $('log').appendChild(row);
  $('log').scrollTop = $('log').scrollHeight;
}

// ── State updates ─────────────────────────────────────────────────────────────
function updateState(state, lastResponseText) {
  const label = STATE_LABEL[state] || state;

  // Sidebar
  const sidebarState = $('sidebar-state');
  sidebarState.className = `sidebar-state state-${state}`;
  $('sidebar-state-text').textContent = label;

  // Badges
  [$('cursor-state-badge'), $('cursor-state-badge-2')].forEach(el => {
    if (!el) return;
    el.className = `kiro-badge badge-${state}`;
  });
  [$('cursor-state-text'), $('cursor-state-text-2')].forEach(el => {
    if (el) el.textContent = label;
  });

  // Last response
  if (lastResponseText) {
    [$('last-response-text'), $('last-response-text-2')].forEach(el => {
      if (el) el.textContent = lastResponseText;
    });
  }
}

// ── Frame poller ──────────────────────────────────────────────────────────────
function startFramePoller() {
  const imgs = [$('preview-img'), $('preview-img-2')];
  const placeholder = $('preview-placeholder');

  setInterval(() => {
    const src = `/frame?t=${Date.now()}`;
    imgs.forEach(img => { if (img) img.src = src; });
  }, 350);

  imgs.forEach(img => {
    if (!img) return;
    img.addEventListener('load',  () => { if (placeholder) placeholder.style.display = 'none'; img.style.opacity = '1'; });
    img.addEventListener('error', () => { if (placeholder) placeholder.style.display = 'flex'; img.style.opacity = '0'; });
  });
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

init();
