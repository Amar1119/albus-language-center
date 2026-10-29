/* Albus — админ самбар */

const PAGE = 50;
const REFRESH_MS = 30_000;
const STATUS = {
  new: { label: 'Шинэ', color: 'var(--new)' },
  contacted: { label: 'Холбогдсон', color: 'var(--contacted)' },
  enrolled: { label: 'Элссэн', color: 'var(--enrolled)' },
  cancelled: { label: 'Цуцалсан', color: 'var(--cancelled)' },
};

const $ = (id) => document.getElementById(id);
const state = { status: '', course: '', q: '', rows: [], total: 0, knownIds: new Set(), firstLoad: true };
const baseTitle = document.title;

// Улаанбаатарын цагаар, YYYY-MM-DD HH:mm (браузерын хэлнээс үл хамааран)
const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Ulaanbaatar', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const formatDate = (iso) => {
  const p = Object.fromEntries(dateFmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const formatPhone = (p) => (p.length === 8 ? `${p.slice(0, 4)} ${p.slice(4)}` : p);

/* ---------- API ---------- */
class AuthError extends Error {}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/admin/login') throw new AuthError();
  if (!res.ok) throw new Error(body.error || `Алдаа (${res.status})`);
  return body;
}

/* ---------- UI туслах ---------- */
let toastTimer;
function toast(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') node.style.cssText = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

function showLogin() {
  $('appView').hidden = true;
  $('loginView').hidden = false;
  stopRefresh();
  $('password').focus();
}

function showApp() {
  $('loginView').hidden = true;
  $('appView').hidden = false;
  refreshAll();
  startRefresh();
}

function handleError(err) {
  if (err instanceof AuthError) { toast('Холболт дууссан. Дахин нэвтэрнэ үү.', true); showLogin(); return; }
  toast(err.message || 'Алдаа гарлаа', true);
}

/* ---------- Мөр зурах ---------- */
function renderRow(r, flash) {
  const status = el('select', { className: 'status-select', 'aria-label': 'Төлөв', style: `--c:${STATUS[r.status].color}` },
    Object.entries(STATUS).map(([value, s]) => el('option', { value, textContent: s.label, selected: value === r.status })));
  status.addEventListener('change', async () => {
    const prev = r.status;
    try {
      const { row } = await api(`/api/admin/registrations/${r.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: status.value }),
      });
      Object.assign(r, row);
      status.style.setProperty('--c', STATUS[row.status].color);
      tr.classList.toggle('is-new', row.status === 'new');
      toast(`Төлөв: ${STATUS[row.status].label}`);
      loadStats();
    } catch (err) { status.value = prev; handleError(err); }
  });

  const note = el('textarea', { className: 'note', rows: 1, value: r.admin_note, placeholder: 'Тэмдэглэл…', maxLength: 1000, 'aria-label': 'Тэмдэглэл' });
  note.addEventListener('change', async () => {
    try {
      const { row } = await api(`/api/admin/registrations/${r.id}`, {
        method: 'PATCH', body: JSON.stringify({ admin_note: note.value }),
      });
      Object.assign(r, row);
      toast('Тэмдэглэл хадгалагдлаа');
    } catch (err) { handleError(err); }
  });

  const del = el('button', { className: 'del', type: 'button', title: 'Устгах', 'aria-label': `${r.name}-ийн бүртгэлийг устгах`, textContent: '×' });
  del.addEventListener('click', async () => {
    if (!confirm(`${r.name} (${formatPhone(r.phone)}) — энэ бүртгэлийг бүр мөсөн устгах уу?`)) return;
    try {
      await api(`/api/admin/registrations/${r.id}`, { method: 'DELETE' });
      tr.remove();
      state.rows = state.rows.filter((x) => x.id !== r.id);
      state.total--;
      updateCount();
      loadStats();
      toast('Устгагдлаа');
    } catch (err) { handleError(err); }
  });

  const tr = el('tr', { className: [r.status === 'new' ? 'is-new' : '', flash ? 'flash' : ''].join(' ').trim(), dataset: { id: r.id } }, [
    el('td', { className: 'c-date', dataset: { label: 'Огноо' }, textContent: formatDate(r.created_at) }),
    el('td', { className: 'c-name', dataset: { label: 'Нэр' }, textContent: r.name }),
    el('td', { className: 'c-phone', dataset: { label: 'Утас' } },
      el('a', { href: `tel:+976${r.phone}`, textContent: formatPhone(r.phone) })),
    el('td', { dataset: { label: 'Сургалт' } }, el('span', { className: 'course-pill', textContent: r.course })),
    el('td', { className: 'c-msg', dataset: { label: 'Нэмэлт' }, textContent: r.message || '—' }),
    el('td', { dataset: { label: 'Төлөв' } }, status),
    el('td', { dataset: { label: 'Тэмдэглэл' } }, note),
    el('td', { className: 'c-del' }, del),
  ]);
  return tr;
}

function updateCount() {
  $('countText').textContent = state.total ? `${state.rows.length} / ${state.total} бүртгэл` : '';
  $('moreBtn').hidden = state.rows.length >= state.total;
  $('empty').hidden = state.total > 0;
}

/* ---------- Ачаалах ---------- */
function query(offset) {
  const p = new URLSearchParams({ limit: PAGE, offset });
  if (state.status) p.set('status', state.status);
  if (state.course) p.set('course', state.course);
  if (state.q) p.set('q', state.q);
  return `/api/admin/registrations?${p}`;
}

async function loadRows({ append = false, silent = false } = {}) {
  try {
    const offset = append ? state.rows.length : 0;
    // Шинэчлэхдээ одоо харагдаж буй хэмжээгээр нь дахин татна (хуудас "үсрэхгүй").
    const url = append ? query(offset) : query(0).replace(`limit=${PAGE}`, `limit=${Math.max(PAGE, state.rows.length)}`);
    const data = await api(url);

    const tbody = $('rows');
    if (!append) {
      // Тэмдэглэл бичиж байх үед дахин зурж, бичсэнийг устгахгүй.
      if (silent && document.activeElement?.closest('#rows')) return;
      tbody.replaceChildren();
      state.rows = [];
    }
    let fresh = 0;
    for (const r of data.rows) {
      const isFresh = !state.firstLoad && !state.knownIds.has(r.id);
      if (isFresh) fresh++;
      state.knownIds.add(r.id);
      tbody.append(renderRow(r, isFresh));
      state.rows.push(r);
    }
    state.total = data.total;
    state.firstLoad = false;
    updateCount();
    if (fresh && silent) {
      toast(`🆕 ${fresh} шинэ бүртгэл ирлээ`);
      if (document.hidden) document.title = `(${fresh}) ${baseTitle}`;
    }
  } catch (err) { handleError(err); }
}

async function loadStats() {
  try {
    const s = await api('/api/admin/stats');
    const values = { total: s.total, today: s.today, ...s.byStatus };
    document.querySelectorAll('[data-stat]').forEach((n) => { n.textContent = values[n.dataset.stat] ?? 0; });
    document.querySelector('[data-count="new"]').textContent = s.byStatus.new || '';
  } catch (err) { handleError(err); }
}

const refreshAll = (silent = false) => Promise.all([loadRows({ silent }), loadStats()]);

let refreshTimer;
function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => { if (!document.hidden) refreshAll(true); }, REFRESH_MS);
}
function stopRefresh() { clearInterval(refreshTimer); }

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { document.title = baseTitle; if (!$('appView').hidden) refreshAll(true); }
});

/* ---------- Үйлдлүүд ---------- */
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  $('loginError').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    showApp();
  } catch (err) {
    $('loginError').textContent = err.message;
  } finally { btn.disabled = false; }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
  showLogin();
});

$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  state.status = tab.dataset.status;
  state.rows = [];
  loadRows();
});

$('courseFilter').addEventListener('change', (e) => { state.course = e.target.value; state.rows = []; loadRows(); });

let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); state.rows = []; loadRows(); }, 300);
});

$('moreBtn').addEventListener('click', () => loadRows({ append: true }));

/* ---------- Эхлэл ---------- */
(async function init() {
  try {
    const { courses } = await api('/api/courses');
    $('courseFilter').append(...courses.map((c) => el('option', { value: c, textContent: c })));
  } catch { /* шүүлтүүргүй ажиллана */ }

  try {
    const { authenticated } = await api('/api/admin/me');
    authenticated ? showApp() : showLogin();
  } catch { showLogin(); }
})();
