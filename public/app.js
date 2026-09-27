/* Fmc Proxy - frontend logic */

const state = {
  type: '',
  anonymity: '',
  sort: 'latency',
  search: '',
  limit: 100,
  items: [],
  lastRefresh: null,
  nextRefresh: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  tbody: $('tbody'),
  status: $('statusPill'),
  refreshBtn: $('refreshBtn'),
  toast: $('toast'),
};

const nf = new Intl.NumberFormat('id-ID');

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

function buildQuery(extra = {}) {
  const params = new URLSearchParams();
  if (state.type) params.set('type', state.type);
  if (state.anonymity) params.set('anonymity', state.anonymity);
  if (state.search) params.set('search', state.search);
  if (state.sort) params.set('sort', state.sort);
  if (state.limit) params.set('limit', String(state.limit));
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params.toString();
}

function latencyClass(ms) {
  if (ms == null) return '';
  if (ms < 800) return 'good';
  if (ms < 2500) return 'mid';
  return 'bad';
}

function fmtTime(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${Math.max(diff, 0)} detik lalu`;
  if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
  return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Umur sejak pengecekan terakhir, mis. "12s", "4m 05s", "1j 12m". */
function fmtAge(iso) {
  if (!iso) return '–';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 0) return '0s';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, '0')}s`;
  const hour = Math.floor(min / 60);
  return `${hour}j ${String(min % 60).padStart(2, '0')}m`;
}

/** Warna umur cek: makin tua makin perlu waspada. */
function ageClass(iso) {
  if (!iso) return '';
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 90) return 'fresh';
  if (sec < 300) return 'ok';
  if (sec < 600) return 'mid';
  return 'stale';
}

/** Perbarui kolom umur setiap detik tanpa render ulang seluruh tabel. */
function tickAges() {
  document.querySelectorAll('.age[data-checked]').forEach((cell) => {
    const iso = cell.dataset.checked;
    cell.textContent = fmtAge(iso);
    cell.className = `age ${ageClass(iso)}`;
  });
}

function typeBadges(types) {
  return (types || []).map((t) => `<span class="badge ${t}">${t.toUpperCase()}</span>`).join('');
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const { data } = await res.json();

    const sum = data.summary || {};
    const byType = sum.byType || {};
    $('s-total').textContent = nf.format(sum.total || 0);
    $('s-http').textContent = nf.format(byType.http || 0);
    $('s-https').textContent = nf.format(byType.https || 0);
    $('s-socks5').textContent = nf.format(byType.socks5 || 0);
    $('s-elite').textContent = nf.format((sum.byAnonymity || {}).elite || 0);
    $('s-latency').textContent = sum.avgLatencyMs ? `${sum.avgLatencyMs} ms` : '–';
    $('s-last').textContent = fmtTime(data.lastRefresh);
    state.lastRefresh = data.lastRefresh;
    state.nextRefresh = data.nextRefresh;

    if (data.isRefreshing) {
      const p = data.progress || {};
      els.status.className = 'pill busy';
      els.status.textContent = `Sedang cek… ${p.checked || 0}/${p.total || 0} (${p.alive || 0} lolos)`;
      els.refreshBtn.disabled = true;
    } else {
      els.status.className = 'pill';
      els.status.textContent = `${nf.format(sum.total || 0)} proxy aktif`;
      els.refreshBtn.disabled = false;
    }

    if (data.stats && !data.isRefreshing) {
      els.status.title = `${data.stats.alive || 0} lolos dari ${data.stats.candidates || 0} kandidat`;
    }
  } catch {
    els.status.className = 'pill busy';
    els.status.textContent = 'gagal memuat status';
  }
}

function tickCountdown() {
  if (!state.nextRefresh) {
    $('s-next').textContent = '–';
    return;
  }
  const diff = new Date(state.nextRefresh).getTime() - Date.now();
  if (diff <= 0) {
    $('s-next').textContent = 'sebentar lagi…';
    return;
  }
  const m = Math.floor(diff / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  $('s-next').textContent = `${m}m ${s}s`;
}

async function loadProxies() {
  try {
    const res = await fetch(`/api/proxies?${buildQuery()}`);
    const json = await res.json();
    state.items = json.data || [];
    renderTable(json.meta);
  } catch {
    els.tbody.innerHTML = '<tr><td colspan="7" class="empty">Gagal memuat data proxy.</td></tr>';
  }
}

function renderTable(meta) {
  const items = state.items;

  if (meta) {
    $('resultInfo').textContent =
      `Menampilkan ${nf.format(items.length)} dari ${nf.format(meta.total || 0)} proxy aktif` +
      (state.type ? ` · tipe ${state.type.toUpperCase()}` : '') +
      (state.anonymity ? ` · ${state.anonymity}` : '');
  }

  if (!items.length) {
    els.tbody.innerHTML =
      '<tr><td colspan="8" class="empty">Belum ada proxy yang cocok. Coba ubah filter atau tunggu pengecekan selesai.</td></tr>';
    return;
  }

  els.tbody.innerHTML = items
    .map((p, i) => {
      const lat = p.latencyMs == null ? '–' : `${p.latencyMs} ms`;
      const checked = p.lastChecked || '';
      return `<tr>
        <td class="src">${i + 1}</td>
        <td class="mono">${p.host}:${p.port}</td>
        <td>${typeBadges(p.types)}</td>
        <td><span class="badge ${p.anonymity}">${p.anonymity}</span></td>
        <td class="lat ${latencyClass(p.latencyMs)}">${lat}</td>
        <td class="age ${ageClass(checked)}" data-checked="${checked}" title="${
          checked ? new Date(checked).toLocaleString('id-ID') : ''
        }">${fmtAge(checked)}</td>
        <td class="src">${p.source || '–'}</td>
        <td><button class="copy" data-copy="${p.host}:${p.port}">Salin</button></td>
      </tr>`;
    })
    .join('');

  tickAges();
}

// --- events -----------------------------------------------------------------
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    copyText(copyBtn.dataset.copy);
    showToast(`Disalin: ${copyBtn.dataset.copy}`);
  }
});

$('typeTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  state.type = tab.dataset.type;
  loadProxies();
});

$('anonymity').addEventListener('change', (e) => {
  state.anonymity = e.target.value;
  loadProxies();
});

$('sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  loadProxies();
});

$('limit').addEventListener('change', (e) => {
  state.limit = Number(e.target.value);
  loadProxies();
});

let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim();
    loadProxies();
  }, 300);
});

$('copyBtn').addEventListener('click', async () => {
  const res = await fetch(`/api/proxies?${buildQuery({ format: 'text' })}`);
  const text = await res.text();
  if (!text.trim()) return showToast('Tidak ada proxy untuk disalin.');
  await copyText(text);
  showToast('Daftar proxy disalin ke clipboard.');
});

$('downloadBtn').addEventListener('click', (e) => {
  e.preventDefault();
  const url = `/api/proxies?${buildQuery({ format: 'text' })}`;
  window.location.href = url;
});

els.refreshBtn.addEventListener('click', async () => {
  els.refreshBtn.disabled = true;
  showToast('Memulai pengecekan ulang…');
  try {
    await fetch('/api/refresh', { method: 'POST' });
  } catch {
    // diabaikan, status akan ter-update lewat polling
  }
  poll();
});

// --- API docs playground ----------------------------------------------------
const docsBase = (window.location && window.location.origin) || '';
$('baseUrl').textContent = `${docsBase}/`;

const TRY_PRESETS = {
  '/api/proxies': 'type=http&limit=5',
  '/api/proxies/random': 'type=socks5',
  '/api/stats': '',
  '/api/sources': '',
  '/api/health': '',
};

function currentTryPath() {
  const path = $('tryEndpoint').value;
  const params = $('tryParams').value.trim();
  return params ? `${path}?${params}` : path;
}

function syncTryLink() {
  $('tryNewTab').href = currentTryPath();
}

async function runTry() {
  const path = currentTryPath();
  syncTryLink();

  $('tryMeta').className = 'tryit-meta';
  $('tryMeta').textContent = 'Memuat…';
  $('tryOutput').textContent = '// memuat…';

  const started = performance.now();
  try {
    const res = await fetch(path);
    const ms = Math.round(performance.now() - started);
    const text = await res.text();
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // biarkan teks apa adanya (mis. format=text)
    }
    $('tryOutput').textContent =
      pretty.length > 20000 ? `${pretty.slice(0, 20000)}\n… (dipotong)` : pretty;
    $('tryMeta').innerHTML = `<b>${res.status}</b> · ${ms} ms · ${res.headers.get('content-type') || 'unknown'}`;
    $('tryMeta').className = res.ok ? 'tryit-meta' : 'tryit-meta err';
  } catch (error) {
    $('tryMeta').className = 'tryit-meta err';
    $('tryMeta').innerHTML = `<b>Gagal:</b> ${error.message}`;
    $('tryOutput').textContent = '// request gagal';
  }
}

$('tryEndpoint').addEventListener('change', () => {
  const path = $('tryEndpoint').value;
  $('tryParams').value = TRY_PRESETS[path] ?? '';
  runTry();
});

$('tryParams').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runTry();
});

$('tryParams').addEventListener('input', syncTryLink);
$('tryBtn').addEventListener('click', runTry);

$('tryCopyCurl').addEventListener('click', async () => {
  await copyText(`curl "${docsBase}${currentTryPath()}"`);
  showToast('Perintah cURL disalin.');
});

// tombol salin pada blok contoh dokumentasi
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy-text]');
  if (!btn) return;
  copyText(btn.dataset.copyText);
  showToast('Disalin ke clipboard.');
});

runTry();

// --- polling ----------------------------------------------------------------
function poll() {
  loadStats();
}

loadStats();
loadProxies();
tickCountdown();
setInterval(tickCountdown, 1000);
setInterval(tickAges, 1000);
setInterval(poll, 5000); // status + progres
setInterval(loadProxies, 30000); // daftar proxy
