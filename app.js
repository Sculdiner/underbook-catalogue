/*
 * Underbook Catalogue — a phone-friendly view of the game's books, Curios,
 * route layouts and Encounters, plus a queue of proposed changes.
 *
 * The catalogue itself (data/catalogue.json) is exported from the game repo
 * and is read-only here. Every add / edit / delete made on this site is
 * written to `pending.json` on the site repo's `edits` branch through the
 * GitHub API; Claude reads that queue from the game project, implements the
 * changes in the real content files, republishes the catalogue and moves the
 * edits to the `applied` log. See catalogue/README.md in the game repo.
 */

const DEFAULT_REPO = 'Sculdiner/underbook-catalogue';
const EDITS_BRANCH = 'edits';
const EDITS_FILE = 'pending.json';
const API = 'https://api.github.com';

// ------------------------------------------------------------------ storage

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem('ubc.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('ubc.' + k, JSON.stringify(v));
    } catch {
      /* private mode: settings just won't stick */
    }
  },
};

const S = {
  cat: null,
  pending: { version: 1, edits: [], applied: [] },
  sha: null,
  pendingLoaded: false,
  pendingError: null,
  proposed: LS.get('proposed', true),
  filters: { books: {}, curios: {}, encounters: {}, routes: {} },
  form: null,
};

const token = () => LS.get('token', '');
const repo = () => LS.get('repo', DEFAULT_REPO) || DEFAULT_REPO;

// ------------------------------------------------------------------ helpers

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const stable = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );
const same = (a, b) => stable(a) === stable(b);
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const b64enc = (str) => {
  let bin = '';
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), err ? 4500 : 2200);
}

function setSync(state, title = '') {
  const el = $('#sync');
  el.className = 'sync ' + state;
  el.title = title;
}

/** A small bottom sheet. Resolves to the note text (input) / true, or null on cancel. */
function ask({ title, body = '', input = false, placeholder = '', ok = 'OK', danger = false, value = '' }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">
      <h3 style="margin-top:0">${esc(title)}</h3>
      ${body ? `<p>${esc(body)}</p>` : ''}
      ${input ? `<div class="field note-field"><textarea id="ask-in" placeholder="${esc(placeholder)}">${esc(value)}</textarea></div>` : ''}
      <div class="row"><button class="btn ghost" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>
    </div>`;
    m.hidden = false;
    const done = (r) => {
      m.hidden = true;
      m.innerHTML = '';
      resolve(r);
    };
    m.onclick = (e) => {
      if (e.target === m) return done(null);
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === '0') return done(null);
      done(input ? $('#ask-in').value.trim() : true);
    };
    if (input) setTimeout(() => $('#ask-in')?.focus(), 50);
  });
}

// ------------------------------------------------------------------ vocab

const RARITIES = ['common', 'uncommon', 'rare'];
const CURIO_RARITIES = ['common', 'uncommon', 'rare', 'legendary'];
const CURSE_FAMILIES = ['bookselling', 'economy', 'summoning', 'curio'];
const BOOK_FLAGS = ['summon-only', 'token', 'tutorial-only'];
const ENC_TYPES = ['normal', 'elite', 'boss'];
const ENC_CATEGORIES = ['normal', 'distinguished', 'elite-boss'];
const CATEGORY_LABEL = { normal: 'Normal', distinguished: 'Distinguished', 'elite-boss': 'Elite / Boss' };
const BANDS = ['opening', 'mid', 'late'];
const NODE_TYPES = ['encounter-normal', 'encounter-elite', 'encounter-boss', 'event', 'reward', 'merchant', 'shrine', 'treasure'];
const NODE_STYLE = {
  'encounter-normal': { c: '#c9b48a', l: 'N', name: 'Bookselling' },
  'encounter-elite': { c: '#d9823f', l: 'D', name: 'Distinguished' },
  'encounter-boss': { c: '#d0574c', l: 'B', name: 'Boss' },
  event: { c: '#7d9be0', l: 'E', name: 'Event' },
  reward: { c: '#6fae8f', l: 'F', name: 'Finding' },
  merchant: { c: '#e2b04f', l: 'M', name: 'Merchant' },
  shrine: { c: '#b07ad0', l: 'S', name: 'Curio Shrine' },
  treasure: { c: '#efd877', l: 'T', name: 'Treasure' },
};
const BRANCHES = ['shared', 'hard', 'safe', 'long', 'steady', 'shrine', 'explorer', 'short', 'wander'];
const KIND = {
  books: { one: 'Book', name: (b) => b.title || b.id },
  curios: { one: 'Curio', name: (c) => c.name || c.id },
  routes: { one: 'Route', name: (r) => r.name || r.id },
  encounters: { one: 'Encounter', name: (e) => e.name || e.id },
  general: { one: 'Note', name: () => 'General note' },
};

const trait = (id) => S.cat?.traits.find((t) => t.id === id);
const traitName = (id) => trait(id)?.name ?? cap(id);
const visitorDef = (id) => S.cat?.visitors.find((v) => v.id === id);
const ability = (id) => S.cat?.abilities.find((a) => a.id === id);
const hasArt = (kind, id) => S.cat?.art?.[kind]?.includes(id);
const artUrl = (kind, id) => `art/${kind}/${encodeURIComponent(id)}.webp`;

// ------------------------------------------------------------------ data

async function loadCatalogue() {
  const r = await fetch(`data/catalogue.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`catalogue.json: HTTP ${r.status}`);
  S.cat = await r.json();
}

async function gh(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return r;
}

/** Read the pending queue fresh. A missing file is an empty queue. */
async function fetchPending() {
  const r = await gh(`/repos/${repo()}/contents/${EDITS_FILE}?ref=${EDITS_BRANCH}&t=${Date.now()}`);
  if (r.status === 404) return { data: { version: 1, edits: [], applied: [] }, sha: null, missing: true };
  if (!r.ok) throw new Error(r.status === 401 ? 'GitHub token rejected (401)' : `GitHub: HTTP ${r.status}`);
  const j = await r.json();
  const data = JSON.parse(b64dec(j.content));
  data.edits ??= [];
  data.applied ??= [];
  return { data, sha: j.sha };
}

async function ensureBranch() {
  const r = await gh(`/repos/${repo()}/git/ref/heads/${EDITS_BRANCH}`);
  if (r.ok) return;
  const main = await gh(`/repos/${repo()}/git/ref/heads/main`);
  if (!main.ok) throw new Error(`Cannot find ${repo()} main branch (HTTP ${main.status})`);
  const sha = (await main.json()).object.sha;
  const c = await gh(`/repos/${repo()}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${EDITS_BRANCH}`, sha }) });
  if (!c.ok) throw new Error(`Cannot create the ${EDITS_BRANCH} branch (HTTP ${c.status})`);
}

async function refreshPending({ quiet = false } = {}) {
  if (!token()) {
    setSync('', 'Read-only: add a GitHub token in Settings to see and save changes');
    return;
  }
  setSync('busy');
  try {
    const { data, sha } = await fetchPending();
    S.pending = data;
    S.sha = sha;
    S.pendingLoaded = true;
    S.pendingError = null;
    setSync('ok', 'Synced with GitHub');
  } catch (e) {
    S.pendingError = e.message;
    setSync('err', e.message);
    if (!quiet) toast(e.message, true);
  }
  renderBadge();
}

/**
 * Apply `mutate` to the freshest queue and write it back. Retries on a stale
 * sha, so an edit from another device (or Claude clearing applied ones) is
 * never overwritten.
 */
async function commitPending(mutate, message) {
  if (!token()) {
    toast('Add a GitHub token in Settings first', true);
    location.hash = '#/settings';
    return false;
  }
  setSync('busy');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      let fresh;
      try {
        fresh = await fetchPending();
      } catch (e) {
        throw e;
      }
      const next = clone(fresh.data);
      mutate(next);
      next.updatedAt = new Date().toISOString();
      const body = { message, content: b64enc(JSON.stringify(next, null, 2) + '\n'), branch: EDITS_BRANCH };
      if (fresh.sha) body.sha = fresh.sha;
      let r = await gh(`/repos/${repo()}/contents/${EDITS_FILE}`, { method: 'PUT', body: JSON.stringify(body) });
      if (r.status === 404 || (r.status === 422 && !fresh.sha)) {
        await ensureBranch();
        r = await gh(`/repos/${repo()}/contents/${EDITS_FILE}`, { method: 'PUT', body: JSON.stringify(body) });
      }
      if (r.ok) {
        S.pending = next;
        S.sha = (await r.json()).content.sha;
        S.pendingLoaded = true;
        setSync('ok', 'Saved to GitHub');
        renderBadge();
        return true;
      }
      if (r.status === 409 || r.status === 422) continue;
      throw new Error(r.status === 401 || r.status === 403 ? `GitHub refused the write (${r.status}) — check the token's Contents permission` : `GitHub: HTTP ${r.status}`);
    }
    throw new Error('Could not save: the queue kept changing underneath. Try again.');
  } catch (e) {
    setSync('err', e.message);
    toast(e.message, true);
    return false;
  }
}

/** Fold a new change into the queue, merging with any change already pending on the same item. */
function stage(data, { kind, key, op, before, after, note }) {
  const edits = data.edits;
  const i = edits.findIndex((e) => e.kind === kind && e.targetId === key);
  const ex = i >= 0 ? edits[i] : null;
  const at = new Date().toISOString();
  const put = (rec) => (ex ? (edits[i] = rec) : edits.push(rec));
  if (op === 'delete') {
    if (ex?.op === 'add') return void edits.splice(i, 1);
    return put({ id: ex?.id ?? uid(), kind, op: 'delete', targetId: key, before: ex?.before ?? before, after: null, note, at });
  }
  if (ex?.op === 'add') return put({ ...ex, targetId: after.id, after, note, at });
  if (op === 'add') return put({ id: uid(), kind, op: 'add', targetId: after.id, before: null, after, note, at });
  const orig = ex?.before ?? before;
  if (same(orig, after) && !note) return ex ? void edits.splice(i, 1) : undefined;
  put({ id: ex?.id ?? uid(), kind, op: 'edit', targetId: key, before: orig, after, note, at });
}

/** The catalogue with the pending queue laid over it. */
function items(kind) {
  const list = (S.cat?.[kind] ?? []).map((x) => ({ key: x.id, data: x, orig: x, pending: null }));
  for (const e of S.pending.edits) {
    if (e.kind !== kind) continue;
    if (e.op === 'add') {
      list.push({ key: e.targetId, data: e.after, orig: null, pending: e });
      continue;
    }
    const it = list.find((x) => x.key === e.targetId);
    if (!it) continue;
    it.pending = e;
    if (e.op === 'edit' && S.proposed) it.data = e.after;
  }
  return list;
}

const findItem = (kind, key) => items(kind).find((x) => x.key === key) ?? items(kind).find((x) => x.data.id === key);

function pendingTag(it) {
  if (!it.pending) return '';
  const label = { add: 'New', edit: it.pending.note && same(it.pending.before, it.pending.after) ? 'Note' : 'Edited', delete: 'Delete' }[it.pending.op];
  return `<span class="tag p-${it.pending.op}">${label}</span>`;
}

// ------------------------------------------------------------------ router

const views = {};

function parseHash() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'books').split('/').map(decodeURIComponent);
  return { tab: parts[0], id: parts[1], mode: parts[2] };
}

function render() {
  const r = parseHash();
  const isForm = r.mode === 'edit' || r.id === 'new' || r.mode === 'duplicate';
  for (const a of document.querySelectorAll('.tabbar a')) a.classList.toggle('on', a.dataset.tab === r.tab);
  const listTab = ['books', 'curios', 'routes', 'encounters'].includes(r.tab);
  $('#back').hidden = !r.id;
  const fab = $('#fab');
  fab.hidden = !(listTab && !r.id);
  fab.href = `#/${r.tab}/new`;
  const view = $('#view');
  if (!S.cat) {
    view.innerHTML = `<div class="empty">Loading the catalogue…</div>`;
    return;
  }
  let title = 'Underbook';
  if (r.tab === 'settings') title = 'Settings';
  else if (r.tab === 'changes') title = 'Changes';
  else if (listTab && !r.id) title = cap(r.tab);
  if (r.tab === 'encounters' && isForm) {
    location.replace(r.id === 'new' ? '#/encounters' : `#/encounters/${encodeURIComponent(r.id)}`);
    if (r.id === 'new') editEncounterDetails();
    return;
  }
  if (listTab && isForm) {
    if (S.form?.hash !== location.hash) {
      S.form = newForm(r);
      if (S.form) S.form.hash = location.hash;
    }
    if (!S.form) {
      view.innerHTML = `<div class="empty">Nothing called “${esc(r.id)}” here.</div>`;
      return;
    }
  } else S.form = null;
  const editor = $('#editor');
  if (listTab && isForm) {
    // The page stays underneath: the item itself, or the list when proposing something new.
    const base = r.id !== 'new' ? findItem(r.tab, r.id) : null;
    title = base ? KIND[r.tab].name(base.data) : cap(r.tab);
    view.innerHTML = base ? views.detail[r.tab](base) : views.list[r.tab]();
    $('#editor-title').textContent = S.form.op === 'add' ? `New ${KIND[r.tab].one.toLowerCase()}` : `Edit ${KIND[r.tab].one.toLowerCase()}`;
    const opening = editor.hidden;
    const body = $('#editor-body');
    const y = body.scrollTop;
    body.innerHTML = formHtml();
    body.scrollTop = opening ? 0 : y;
    editor.hidden = false;
    document.body.classList.add('locked');
  } else {
    editor.hidden = true;
    document.body.classList.remove('locked');
  }
  if (listTab && isForm) {
    /* drawn above */
  } else if (listTab && r.id) {
    const it = findItem(r.tab, r.id);
    title = it ? KIND[r.tab].name(it.data) : 'Not found';
    view.innerHTML = it ? views.detail[r.tab](it) : `<div class="empty">Nothing called “${esc(r.id)}” here.<br><a href="#/${r.tab}">Back to ${r.tab}</a></div>`;
  } else if (listTab) {
    view.innerHTML = views.list[r.tab]();
  } else if (views[r.tab]) {
    view.innerHTML = views[r.tab]();
  } else {
    location.hash = '#/books';
    return;
  }
  $('#title').textContent = title;
  document.title = `${title} · Underbook Catalogue`;
}

function renderBadge() {
  const n = S.pending.edits.length;
  const b = $('#badge');
  b.hidden = n === 0;
  b.textContent = n;
}

// ------------------------------------------------------------------ lists

function filterBar(kind, chipsets) {
  const f = S.filters[kind];
  return `<div class="search"><input type="search" placeholder="Search ${kind}…" value="${esc(f.q ?? '')}" data-filter="${kind}" autocomplete="off">
    ${chipsets
      .map(
        (cs) => `<div class="chips">${[['', 'All'], ...cs.options]
          .map(([v, l]) => `<button class="chip ${(f[cs.key] ?? '') === v ? 'on' : ''}" data-chip="${kind}" data-key="${cs.key}" data-val="${esc(v)}">${esc(l)}</button>`)
          .join('')}</div>`,
      )
      .join('')}</div>`;
}

const matches = (q, ...fields) => !q || fields.some((s) => String(s ?? '').toLowerCase().includes(q.toLowerCase()));

function bookCover(b, extra = '') {
  const v = `<span class="vbadge">V${b.value ?? '?'} · ${b.actionCost ?? 1}A</span>`;
  if (hasArt('books', b.id)) return `<div class="cover ${extra}" style="background-image:url('${artUrl('books', b.id)}')">${v}</div>`;
  return `<div class="cover placeholder ${extra}">${esc(b.title || b.id)}${v}</div>`;
}

/** One book as the game's deck list draws it: rarity stripe, cropped cover, title, Value. */
function bookRow(it) {
  const b = it.data;
  const thumb = hasArt('books', b.id)
    ? `<span class="deck-thumb"><i style="background-image:url('${artUrl('books', b.id)}')"></i></span>`
    : `<span class="deck-thumb blank">${esc((b.title || '?')[0])}</span>`;
  const sub = [(b.actionCost ?? 1) !== 1 ? `${b.actionCost} Actions` : '', b.extension ? 'Extension' : '', ...(b.flags ?? [])].filter(Boolean);
  return `<a class="deck-row ${b.rarity} ${it.pending?.op === 'delete' ? 'deleted' : ''}" href="#/books/${encodeURIComponent(it.key)}">
    ${thumb}
    <span class="deck-name"><span class="deck-title name">${esc(b.title)}</span>${sub.length ? `<span class="deck-sub">${esc(sub.join(' · '))}</span>` : ''}</span>
    ${pendingTag(it)}<span class="deck-value">${b.value ?? '?'}</span></a>`;
}

function bookGroup(b) {
  if (b.flags?.some((f) => f === 'token' || f === 'tutorial-only')) return 'special';
  return b.traits?.[0] ?? 'basics';
}

views.list = {
  books() {
    const f = S.filters.books;
    const traitsIn = [...new Set(S.cat.books.flatMap((b) => b.traits))];
    const order = ['basics', ...S.cat.traits.map((t) => t.id), 'special'];
    const all = items('books').filter(
      ({ data: b }) =>
        matches(f.q, b.title, b.id, b.rulesText, b.shortText) &&
        (!f.trait || (f.trait === 'basics' ? !b.traits.length : b.traits.includes(f.trait))) &&
        (!f.rarity || b.rarity === f.rarity),
    );
    const groups = order
      .map((g) => [g, all.filter((x) => bookGroup(x.data) === g)])
      .filter(([, xs]) => xs.length);
    const label = (g) => (g === 'basics' ? 'Basics' : g === 'special' ? 'Tokens & special' : traitName(g));
    return (
      filterBar('books', [
        { key: 'trait', options: [['basics', 'Basics'], ...traitsIn.map((t) => [t, traitName(t)])] },
        { key: 'rarity', options: RARITIES.map((r) => [r, cap(r)]) },
      ]) +
      '<div id="results">' +
      (groups.length
        ? groups
            .map(
              ([g, xs]) => `<div class="group-h">${esc(label(g))} <span class="small muted">${xs.length}</span></div>
          <div class="deck-list">${xs.map(bookRow).join('')}</div>`,
            )
            .join('')
        : `<div class="empty">No books match.</div>`) +
      '</div>'
    );
  },

  curios() {
    const f = S.filters.curios;
    const all = items('curios').filter(
      ({ data: c }) =>
        matches(f.q, c.name, c.id, c.text) && (!f.rarity || (f.rarity === 'curse' ? !!c.curse : c.rarity === f.rarity)),
    );
    const groups = [...CURIO_RARITIES.map((r) => [cap(r), all.filter((x) => !x.data.curse && x.data.rarity === r)]), ['Curses', all.filter((x) => x.data.curse)]].filter(
      ([, xs]) => xs.length,
    );
    return (
      filterBar('curios', [{ key: 'rarity', options: [...CURIO_RARITIES.map((r) => [r, cap(r)]), ['curse', 'Curses']] }]) +
      '<div id="results">' +
      (groups.length
        ? groups
            .map(
              ([g, xs]) => `<div class="group-h">${esc(g)} <span class="small muted">${xs.length}</span></div><div class="rows">${xs.map(curioRow).join('')}</div>`,
            )
            .join('')
        : `<div class="empty">No curios match.</div>`) +
      '</div>'
    );
  },

  routes() {
    const f = S.filters.routes;
    const all = items('routes').filter(({ data: r }) => matches(f.q, r.name, r.id));
    return (
      filterBar('routes', []) +
      '<div id="results">' +
      `<p class="small muted" style="margin-top:0">Every Stage currently draws one of these layouts at random.</p>` +
      (all.length
        ? all
            .map(
              (it) => `<a class="route-card ${it.pending?.op === 'delete' ? 'deleted' : ''}" href="#/routes/${encodeURIComponent(it.key)}">
          <div class="name"><span>${esc(it.data.name)}</span>${pendingTag(it)}<span class="small muted" style="margin-left:auto">${it.data.nodes.length} nodes</span></div>
          <div class="map-wrap" style="margin:0">${routeSvg(it.data, { mini: true })}</div></a>`,
            )
            .join('')
        : `<div class="empty">No routes match.</div>`) +
      '</div>'
    );
  },

  encounters() {
    const f = S.filters.encounters;
    const stages = [...new Set(items('encounters').map((x) => x.data.stage ?? 1))].sort((a, b) => a - b);
    const all = items('encounters').filter(
      ({ data: e }) =>
        matches(f.q, e.name, e.id, e.purpose, ...e.visitors.map((v) => v.name)) &&
        (!f.stage || String(e.stage ?? 1) === f.stage) &&
        (!f.category || e.category === f.category),
    );
    const stageLabel = (s) => (s === 0 ? 'Tutorial' : `Stage ${s}`);
    const rank = (e) => ENC_CATEGORIES.indexOf(e.category) * 10 + (e.band ? BANDS.indexOf(e.band) : 0);
    const groups = stages
      .map((s) => [s, all.filter((x) => (x.data.stage ?? 1) === s).sort((a, b) => rank(a.data) - rank(b.data))])
      .filter(([, xs]) => xs.length);
    return (
      filterBar('encounters', [
        { key: 'stage', options: stages.map((s) => [String(s), stageLabel(s)]) },
        { key: 'category', options: ENC_CATEGORIES.map((c) => [c, CATEGORY_LABEL[c]]) },
      ]) +
      '<div id="results">' +
      (groups.length
        ? groups
            .map(
              ([s, xs]) => `<div class="group-h">${stageLabel(s)} <span class="small muted">${xs.length}</span></div><div class="rows">${xs
                .map((it) => {
                  const e = it.data;
                  const t = thresholds(e);
                  return `<a class="row-item ${it.pending?.op === 'delete' ? 'deleted' : ''}" href="#/encounters/${encodeURIComponent(it.key)}">
                  <div class="body"><div class="name">${esc(e.name)} ${pendingTag(it)}</div>
                  <div class="tags" style="margin:4px 0 0"><span class="tag">${CATEGORY_LABEL[e.category] ?? e.category}</span>${e.band ? `<span class="tag">${cap(e.band)}</span>` : ''}${e.type !== 'normal' ? `<span class="tag">${cap(e.type)}</span>` : ''}</div></div>
                  <div class="meta">${e.visitors.length} visitors<br>${t.survival} / ${t.strong} / ${t.perfect}</div></a>`;
                })
                .join('')}</div>`,
            )
            .join('')
        : `<div class="empty">No encounters match.</div>`) +
      '</div>'
    );
  },
};

function curioRow(it) {
  const c = it.data;
  const cls = c.curse ? 'curse' : c.rarity;
  const icon = hasArt('curios', c.id) ? `style="background-image:url('${artUrl('curios', c.id)}')"` : '';
  return `<a class="row-item ${it.pending?.op === 'delete' ? 'deleted' : ''}" href="#/curios/${encodeURIComponent(it.key)}">
    <div class="curio-icon ${cls}" ${icon}></div>
    <div class="body"><div class="name">${esc(c.name)} ${pendingTag(it)}</div><div class="sub">${esc(c.text)}</div></div>
    <div class="meta">${c.curse ? esc(cap(c.curse)) : c.price != null ? `${c.price}G` : ''}</div></a>`;
}

/** Mirrors `needThresholds` in content/encounters.ts. */
function thresholds(e) {
  const sorted = e.visitors.map((v) => Number(v.fulfillment) || 0).sort((a, b) => a - b);
  const upTo = (n) => sorted.slice(0, n).reduce((s, x) => s + x, 0);
  const oss = e.stage === 2;
  return {
    survival: upTo(oss ? Math.max(0, sorted.length - 2) : 3),
    strong: upTo(oss ? Math.max(0, sorted.length - 1) : 4),
    perfect: upTo(sorted.length),
  };
}

// ------------------------------------------------------------------ route map

function routeSvg(r, { mini = false } = {}) {
  const nodes = r.nodes ?? [];
  if (!nodes.length) return `<div class="empty">No nodes</div>`;
  const colW = mini ? 34 : 62;
  const rowH = mini ? 13 : 30;
  const rad = mini ? 7 : 14;
  const pad = mini ? 12 : 26;
  const lanes = nodes.map((n) => Number(n.lane) || 0);
  const depths = nodes.map((n) => Number(n.depth) || 0);
  const minL = Math.min(...lanes);
  const maxL = Math.max(...lanes);
  const maxD = Math.max(...depths);
  const W = pad * 2 + maxD * colW;
  const H = pad * 2 + (maxL - minL) * rowH;
  const pos = (n) => [pad + (Number(n.depth) || 0) * colW, pad + ((Number(n.lane) || 0) - minL) * rowH];
  const byKey = Object.fromEntries(nodes.map((n) => [n.key, n]));
  let edges = '';
  for (const n of nodes) {
    const [x1, y1] = pos(n);
    for (const k of n.next ?? []) {
      const m = byKey[k];
      if (!m) continue;
      const [x2, y2] = pos(m);
      const mx = (x1 + x2) / 2;
      edges += `<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="${n.branch === 'hard' || m.branch === 'hard' ? '#7a3b33' : '#5b4e40'}" stroke-width="${mini ? 1.5 : 2.2}"/>`;
    }
  }
  let dots = '';
  for (const n of nodes) {
    const [x, y] = pos(n);
    const st = NODE_STYLE[n.type] ?? { c: '#888', l: '?' };
    const big = n.type === 'encounter-boss' ? 1.35 : 1;
    const band = n.type === 'encounter-normal' && n.band ? n.band[0].toUpperCase() : '';
    dots += `<g data-node="${esc(n.key)}"><circle cx="${x}" cy="${y}" r="${rad * big}" fill="${st.c}" stroke="#15110e" stroke-width="2"/>`;
    if (!mini)
      dots += `<text x="${x}" y="${y + 4.5}" text-anchor="middle" font-size="13" font-weight="700" fill="#15110e" font-family="system-ui">${st.l}${band ? `<tspan font-size="8" dy="-5">${band}</tspan>` : ''}</text>
        <text x="${x}" y="${y + rad * big + 12}" text-anchor="middle" font-size="9.5" fill="#85775f" font-family="system-ui">${esc(n.key)}</text>`;
    dots += `</g>`;
  }
  return `<svg width="${W}" height="${H + (mini ? 0 : 12)}" viewBox="0 0 ${W} ${H + (mini ? 0 : 12)}" role="img" aria-label="Route map">${edges}${dots}</svg>`;
}

/** Every start → Boss walk, with how many of each node type it meets. */
function routePaths(r) {
  const byKey = Object.fromEntries(r.nodes.map((n) => [n.key, n]));
  const incoming = new Set(r.nodes.flatMap((n) => n.next ?? []));
  const starts = r.nodes.filter((n) => !incoming.has(n.key));
  const out = [];
  const walk = (n, path, seen) => {
    if (out.length > 60 || seen.has(n.key)) return;
    const p = [...path, n];
    const next = (n.next ?? []).map((k) => byKey[k]).filter(Boolean);
    if (!next.length) return void out.push(p);
    const s = new Set(seen).add(n.key);
    for (const m of next) walk(m, p, s);
  };
  for (const s of starts) walk(s, [], new Set());
  return out;
}

function routeChecks(r) {
  const errs = [];
  const keys = r.nodes.map((n) => n.key);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) errs.push(`Duplicate node keys: ${[...new Set(dup)].join(', ')}`);
  if (keys.some((k) => !k)) errs.push('A node has no key');
  const bosses = r.nodes.filter((n) => n.type === 'encounter-boss');
  const merchants = r.nodes.filter((n) => n.type === 'merchant');
  if (bosses.length !== 1) errs.push(`Needs exactly one Boss node (has ${bosses.length})`);
  if (merchants.length !== 1) errs.push(`Needs exactly one Merchant node (has ${merchants.length})`);
  for (const n of r.nodes) for (const k of n.next ?? []) if (!keys.includes(k)) errs.push(`${n.key} → “${k}” does not exist`);
  const warns = [];
  for (const n of r.nodes) if (n.type !== 'encounter-boss' && !(n.next ?? []).length) warns.push(`${n.key} is a dead end`);
  const paths = routePaths(r);
  if (merchants.length === 1 && paths.some((p) => !p.some((n) => n.type === 'merchant'))) warns.push('Some paths skip the Merchant');
  return { errs, warns, paths };
}

function routePathTable(r) {
  const paths = routePaths(r);
  if (!paths.length) return '';
  const cols = ['encounter-normal', 'encounter-elite', 'event', 'reward', 'shrine', 'treasure', 'merchant'];
  const budget = S.cat.budgets?.early;
  const cell = (t, n) => {
    const bad = budget && ((budget.min[t] != null && n < budget.min[t]) || (budget.max[t] != null && n > budget.max[t]));
    return `<td style="${bad ? 'color:var(--danger);font-weight:700' : ''}">${n}</td>`;
  };
  return `<div class="table-wrap"><table class="paths"><thead><tr><th>Path</th>${cols
    .map((c) => `<th title="${NODE_STYLE[c].name}">${NODE_STYLE[c].l}</th>`)
    .join('')}</tr></thead><tbody>${paths
    .map(
      (p, i) =>
        `<tr><td title="${esc(p.map((n) => n.key).join(' → '))}">${i + 1}. ${esc(p.find((n) => n.branch !== 'shared')?.branch ?? 'shared')}</td>${cols
          .map((c) => cell(c, p.filter((n) => n.type === c).length))
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>
    ${budget ? `<p class="small muted">Red = outside the Stage 1–2 path budget (min–max per walk).</p>` : ''}`;
}

const legend = () =>
  `<div class="legend">${Object.values(NODE_STYLE)
    .map((s) => `<span><i style="background:${s.c}"></i>${s.l} ${s.name}</span>`)
    .join('')}</div>`;

// ------------------------------------------------------------------ detail

function pendingNotice(it) {
  const p = it.pending;
  if (!p) return '';
  const what = { add: 'This is a new item waiting for Claude to add it.', edit: S.proposed ? 'Showing your proposed version (not in the game yet).' : 'Showing the game version — you have a pending edit.', delete: 'Marked for deletion.' }[p.op];
  return `<div class="notice warn">${pendingTag(it)} ${what}${p.note ? `<div class="change" style="margin:8px 0 0;padding:0;border:0;background:none"><div class="note">${esc(p.note)}</div></div>` : ''}</div>`;
}

function detailActions(kind, it) {
  const k = encodeURIComponent(it.key);
  if (it.pending?.op === 'delete')
    return `<div class="actions"><button class="btn" data-act="discard" data-id="${it.pending.id}">Undo delete</button></div>`;
  const inline = kind === 'encounters';
  return `<div class="actions">
    ${inline ? '' : `<a class="btn primary" href="#/${kind}/${k}/edit">Edit</a>`}
    ${inline ? `<button class="btn" data-act="enc-duplicate" data-key="${esc(it.key)}">Duplicate</button>` : `<a class="btn" href="#/${kind}/${k}/duplicate">Duplicate</a>`}
    <button class="btn" data-act="note" data-kind="${kind}" data-key="${esc(it.key)}">Note to Claude</button>
    ${it.pending ? `<button class="btn" data-act="discard" data-id="${it.pending.id}">Discard my change</button>` : ''}
    <button class="btn danger" data-act="delete" data-kind="${kind}" data-key="${esc(it.key)}">Delete</button>
  </div>`;
}

const ENGINE_SKIP = new Set(['id', 'title', 'traits', 'rarity', 'value', 'actionCost', 'copies', 'shortText', 'rulesText', 'flavor', 'flags', 'extension', 'rebinds', 'reminders']);

views.detail = {
  books(it) {
    const b = it.data;
    const sig = S.cat.traits.find((t) => t.signatureBook === b.id);
    const engine = Object.entries(b).filter(([k]) => !ENGINE_SKIP.has(k));
    return `${pendingNotice(it)}
      <div class="hero">${bookCover(b)}
        <div class="info"><h2>${esc(b.title)}</h2>
          <div class="tags">${b.traits.map((t) => `<span class="tag" style="border-color:${trait(t)?.accent ?? ''}">${esc(traitName(t))}</span>`).join('') || '<span class="tag">Traitless</span>'}
            <span class="tag ${b.rarity}">${cap(b.rarity)}</span>${b.extension ? '<span class="tag">Extension</span>' : ''}${(b.flags ?? []).map((f) => `<span class="tag">${esc(f)}</span>`).join('')}${sig ? `<span class="tag legendary">${esc(sig.name)} signature</span>` : ''}</div>
          <div class="stats"><div class="stat"><b>${b.value}</b><span>Value</span></div><div class="stat"><b>${b.actionCost ?? 1}</b><span>Actions</span></div></div>
        </div></div>
      ${b.rulesText ? `<h3>Rules</h3><div class="rules">${esc(b.rulesText)}</div>` : ''}
      ${b.rebinds?.length ? `<h3>Rebinds</h3>${b.rebinds.map((u) => `<div class="rebind"><div class="rn">${esc(u.name)}</div><div class="ba">${esc(u.before)} → ${esc(u.after)}</div><div>${esc(u.text)}</div></div>`).join('')}` : ''}
      ${engine.length ? `<h3>Engine fields</h3><dl class="kv">${engine.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>` : ''}
      ${detailActions('books', it)}`;
  },

  curios(it) {
    const c = it.data;
    const cls = c.curse ? 'curse' : c.rarity;
    const icon = hasArt('curios', c.id) ? `style="background-image:url('${artUrl('curios', c.id)}')"` : '';
    return `${pendingNotice(it)}
      <div class="hero"><div class="curio-icon big ${cls}" ${icon}></div>
        <div class="info"><h2>${esc(c.name)}</h2>
          <div class="tags">${c.curse ? `<span class="tag curse">${esc(cap(c.curse))} curse</span>` : `<span class="tag ${c.rarity}">${cap(c.rarity)}</span>`}${c.trait ? `<span class="tag">${esc(traitName(c.trait))} only</span>` : ''}</div>
          ${c.price != null ? `<div class="stats"><div class="stat"><b>${c.price}</b><span>Gold</span></div></div>` : ''}
        </div></div>
      <h3>Effect</h3><div class="rules">${esc(c.text)}</div>
      ${detailActions('curios', it)}`;
  },

  routes(it) {
    const r = it.data;
    const { errs, warns } = routeChecks(r);
    return `${pendingNotice(it)}<h2>${esc(r.name)}</h2>
      ${errs.map((e) => `<div class="notice err">${esc(e)}</div>`).join('')}${warns.map((e) => `<div class="notice warn">${esc(e)}</div>`).join('')}
      <div class="map-wrap">${routeSvg(r)}</div>${legend()}
      <h3>Paths</h3>${routePathTable(r)}
      <h3>Nodes</h3><div class="table-wrap"><table class="paths"><thead><tr><th>Key</th><th>Type</th><th>Branch</th><th>D</th><th>L</th><th>Next</th></tr></thead><tbody>
      ${[...r.nodes]
        .sort((a, b) => a.depth - b.depth || a.lane - b.lane)
        .map((n) => `<tr><td>${esc(n.key)}</td><td>${NODE_STYLE[n.type]?.l ?? '?'}${n.band ? `<sup>${n.band[0].toUpperCase()}</sup>` : ''}</td><td>${esc(n.branch)}</td><td>${n.depth}</td><td>${n.lane}</td><td>${esc((n.next ?? []).join(', '))}</td></tr>`)
        .join('')}</tbody></table></div>
      ${detailActions('routes', it)}`;
  },

  encounters(it) {
    const e = it.data;
    const t = thresholds(e);
    const live = it.pending?.op !== 'delete';
    const key = esc(it.key);
    const waves = [...new Set(e.visitors.map((v) => v.arriveAfterTurn))].sort((a, b) => a - b);
    return `${pendingNotice(it)}
      <button type="button" class="tap-edit" ${live ? `data-act="enc-details" data-key="${key}"` : 'disabled'}>
        <h2>${esc(e.name)}${live ? ' <span class="pencil">✎</span>' : ''}</h2>
        <div class="tags"><span class="tag">${e.stage === 0 ? 'Tutorial' : `Stage ${e.stage ?? 1}`}</span><span class="tag">${CATEGORY_LABEL[e.category] ?? e.category}</span>${e.band ? `<span class="tag">${cap(e.band)} band</span>` : ''}<span class="tag">${cap(e.type)} reward</span></div>
        ${e.purpose ? `<p class="muted" style="margin:6px 0 0">${esc(e.purpose)}</p>` : ''}
        ${e.intro ? `<div class="notice"><b>${esc(e.intro.title)}</b> — <i>${esc(e.intro.epithet)}</i><br>“${esc(e.intro.line)}”</div>` : ''}
      </button>
      <div class="stats"><div class="stat"><b>${e.visitors.length}</b><span>Visitors</span></div><div class="stat"><b>${t.survival}</b><span>Survival</span></div><div class="stat"><b>${t.strong}</b><span>Strong</span></div><div class="stat"><b>${t.perfect}</b><span>Perfect</span></div></div>
      ${e.ruleText ? `<div class="notice warn">${esc(e.ruleText)}</div>` : ''}
      ${e.visitors.length ? '' : '<div class="empty" style="padding:20px 0">No visitors yet.</div>'}
      ${waves
        .map(
          (w) => `<div class="wave-h">${w === 0 ? 'At the open' : `After turn ${w}`}</div>${e.visitors
            .map((v, i) => [v, i])
            .filter(([v]) => v.arriveAfterTurn === w)
            .map(([v, i]) => visitorCard(v, live ? { key: it.key, i } : null))
            .join('')}`,
        )
        .join('')}
      ${live ? `<button class="btn" style="width:100%;margin-top:6px" data-act="visitor-add" data-key="${key}">+ Add visitor</button>` : ''}
      ${detailActions('encounters', it)}`;
  },
};

function portrait(id) {
  if (id && hasArt('visitors', id)) return `<div class="portrait" style="background-image:url('${artUrl('visitors', id)}')"></div>`;
  return `<div class="portrait" title="Drawn from the crowd">?</div>`;
}

function visitorCard(v, edit = null) {
  const a = ability(v.abilityId);
  const attrs = edit ? `type="button" data-act="visitor-edit" data-key="${esc(edit.key)}" data-i="${edit.i}"` : 'type="button" disabled';
  return `<button class="visitor ${v.headliner ? 'head' : ''}" ${attrs}>${portrait(v.visitorDefId)}
    <div class="vb"><div class="vn">${esc(v.name || visitorDef(v.visitorDefId)?.name || 'Visitor')} ${v.headliner ? '<span class="tag legendary">Headliner</span>' : ''}</div>
    <div class="np"><span>Need <b>${v.fulfillment}</b></span><span>Patience <b>${v.patience}</b></span>${v.tag ? `<span>tag: ${esc(v.tag)}</span>` : ''}</div>
    ${a ? `<div class="ab"><b>${esc(a.name)}.</b> ${esc(a.text)}</div>` : v.abilityId ? `<div class="ab"><b>${esc(v.abilityId)}</b> <span class="muted">(new ability — describe it in the note)</span></div>` : ''}</div></button>`;
}

// ------------------------------------------------------------------ sheets (inline encounter editing)

/** A bottom sheet holding a small form. Resolves to { action, values } or null on cancel. */
function sheet(html, onChange) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<div class="sheet tall" role="dialog" aria-modal="true">${html}</div>`;
    m.hidden = false;
    const done = (r) => {
      m.hidden = true;
      m.innerHTML = '';
      m.onclick = m.onchange = null;
      resolve(r);
    };
    m.onclick = (e) => {
      if (e.target === m) return done(null);
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === 'cancel') return done(null);
      const values = {};
      for (const el of m.querySelectorAll('[data-f]')) {
        const k = el.dataset.f;
        if (el.type === 'checkbox') values[k] = el.checked;
        else if (el.type === 'number') values[k] = el.value === '' ? undefined : Number(el.value);
        else values[k] = el.value.trim();
      }
      done({ action: b.dataset.r, values });
    };
    m.onchange = (e) => onChange?.(e.target, m);
  });
}

const sf = {
  num: (k, l, v) => `<div class="field"><label>${esc(l)}</label><input type="number" data-f="${k}" value="${v ?? ''}"></div>`,
  text: (k, l, v, area = false) =>
    `<div class="field"><label>${esc(l)}</label>${area ? `<textarea data-f="${k}">${esc(v ?? '')}</textarea>` : `<input type="text" data-f="${k}" value="${esc(v ?? '')}" autocomplete="off">`}</div>`,
  select: (k, l, v, opts, blank = null) =>
    `<div class="field"><label>${esc(l)}</label><select data-f="${k}">${blank != null ? `<option value="">${esc(blank)}</option>` : ''}${opts
      .map(([o, ol]) => `<option value="${esc(o)}" ${String(v ?? '') === String(o) ? 'selected' : ''}>${esc(ol)}</option>`)
      .join('')}</select></div>`,
  check: (k, l, v) => `<div class="field check"><label><input type="checkbox" data-f="${k}" ${v ? 'checked' : ''}> ${esc(l)}</label></div>`,
  note: (v) => `<div class="field note-field"><label>Note to Claude (optional)</label><textarea data-f="_note" placeholder="Why, or anything I should know…">${esc(v ?? '')}</textarea></div>`,
  buttons: (del = '') =>
    `<div class="row">${del ? `<button class="btn danger" data-r="delete" style="margin-right:auto">${esc(del)}</button>` : ''}<button class="btn ghost" data-r="cancel">Cancel</button><button class="btn primary" data-r="save">Save</button></div>`,
};

/** Write a changed encounter to the queue, folding into any change already pending on it. */
function commitEncounter(it, after, note, message) {
  const op = it.pending?.op === 'add' ? 'add' : 'edit';
  return commitPending((d) => stage(d, { kind: 'encounters', key: it.key, op, before: clone(it.orig), after: tidy(after), note }), message);
}

const encounterDraft = (it) => clone(it.pending?.after ?? it.orig ?? it.data);

async function editVisitor(key, i) {
  const it = findItem('encounters', key);
  const isNew = i == null;
  const draft = encounterDraft(it);
  const last = draft.visitors[draft.visitors.length - 1];
  const v = isNew ? { arriveAfterTurn: last?.arriveAfterTurn ?? 0, name: '', fulfillment: 5, patience: 2 } : draft.visitors[i];
  const abilityText = (id) => ability(id)?.text ?? '';
  const res = await sheet(
    `<div class="sheet-h">${portrait(v.visitorDefId)}<h3>${isNew ? 'New visitor' : esc(v.name || 'Visitor')}</h3></div>
     <div class="three">${sf.num('arriveAfterTurn', 'Arrives after turn', v.arriveAfterTurn)}${sf.num('fulfillment', 'Need', v.fulfillment)}${sf.num('patience', 'Patience', v.patience)}</div>
     ${sf.text('name', 'Name', v.name)}
     ${sf.select('visitorDefId', 'Portrait / identity', v.visitorDefId, S.cat.visitors.map((x) => [x.id, `${x.name}${x.castOnly ? ' (cast)' : ''}`]), 'Random from the crowd')}
     ${sf.select('abilityId', 'Ability', v.abilityId, S.cat.abilities.map((a) => [a.id, a.name]), 'None (Need + Patience only)')}
     <div class="hint" id="ab-text">${esc(abilityText(v.abilityId))}</div>
     <div class="two">${sf.text('tag', 'Cast tag', v.tag)}${sf.check('headliner', 'Headliner', v.headliner)}</div>
     ${sf.note(it.pending?.note)}
     ${sf.buttons(isNew ? '' : 'Remove visitor')}`,
    (el, m) => {
      if (el.dataset.f === 'visitorDefId') {
        m.querySelector('.sheet-h .portrait').outerHTML = portrait(el.value);
        const name = m.querySelector('[data-f="name"]');
        if (!name.value && el.value) name.value = visitorDef(el.value)?.name ?? '';
      }
      if (el.dataset.f === 'abilityId') m.querySelector('#ab-text').textContent = abilityText(el.value);
    },
  );
  if (!res) return;
  const { _note, ...f } = res.values;
  if (res.action === 'delete') {
    if (!(await ask({ title: `Remove ${v.name || 'this visitor'}?`, ok: 'Remove', danger: true }))) return;
    draft.visitors.splice(i, 1);
  } else {
    const nv = {
      ...f,
      arriveAfterTurn: f.arriveAfterTurn ?? 0,
      fulfillment: f.fulfillment ?? 0,
      patience: f.patience ?? 1,
      name: f.name || visitorDef(f.visitorDefId)?.name || '',
    };
    if (isNew) draft.visitors.push(nv);
    else draft.visitors[i] = nv;
  }
  const verb = res.action === 'delete' ? 'Remove' : isNew ? 'Add' : 'Edit';
  if (await commitEncounter(it, draft, _note, `${verb} a visitor in ${it.key}`)) {
    toast(res.action === 'delete' ? 'Visitor removed' : 'Saved');
    render();
  }
}

/** The encounter's own fields; with no `key`, creates a new encounter. */
async function editEncounterDetails(key = null) {
  const it = key ? findItem('encounters', key) : null;
  const d = it ? encounterDraft(it) : { name: '', stage: 1, type: 'normal', category: 'normal', band: 'opening', purpose: '', visitors: [] };
  const show = (m) => {
    m.querySelector('#band-wrap').hidden = m.querySelector('[data-f="category"]').value !== 'normal';
    m.querySelector('#intro-wrap').hidden = m.querySelector('[data-f="type"]').value !== 'boss';
  };
  const res = await sheet(
    `<h3 style="margin-top:0">${it ? 'Encounter details' : 'New encounter'}</h3>
     ${sf.text('name', 'Name', d.name)}
     <div class="two">${sf.num('stage', 'Stage (0 = tutorial)', d.stage ?? 1)}${sf.select('type', 'Reward tier', d.type, ENC_TYPES.map((x) => [x, cap(x)]))}</div>
     <div class="two">${sf.select('category', 'Category', d.category, ENC_CATEGORIES.map((c) => [c, CATEGORY_LABEL[c]]))}<div id="band-wrap" ${d.category === 'normal' ? '' : 'hidden'}>${sf.select('band', 'Band', d.band ?? 'opening', BANDS.map((b) => [b, cap(b)]))}</div></div>
     ${sf.text('purpose', 'Purpose / design note', d.purpose, true)}
     <div id="intro-wrap" class="sub-card" ${d.type === 'boss' ? '' : 'hidden'}><b>Boss title card</b>${sf.text('introTitle', 'Title', d.intro?.title)}${sf.text('introEpithet', 'Epithet', d.intro?.epithet)}${sf.text('introLine', 'Line', d.intro?.line, true)}</div>
     ${sf.note(it?.pending?.note)}
     ${sf.buttons()}`,
    (_el, m) => show(m),
  );
  if (!res) return;
  const f = res.values;
  if (!f.name) return toast('Name is required', true);
  const next = { ...d, name: f.name, stage: f.stage ?? 1, type: f.type, category: f.category, purpose: f.purpose };
  // An encounter that never had a stage is Stage 1 by default; don't invent the field.
  if (it && it.orig && it.orig.stage === undefined && next.stage === 1) delete next.stage;
  if (f.category === 'normal') next.band = f.band;
  else delete next.band;
  if (f.type === 'boss') next.intro = { ...(d.intro ?? {}), title: f.introTitle, epithet: f.introEpithet, line: f.introLine };
  else delete next.intro;
  if (it) {
    if (await commitEncounter(it, next, f._note, `Edit encounter ${it.key}`)) {
      toast('Saved');
      render();
    }
    return;
  }
  next.id = freshId('encounters', f.name);
  if (await commitPending((q) => stage(q, { kind: 'encounters', key: next.id, op: 'add', before: null, after: tidy(next), note: f._note }), `Propose encounter ${next.id}`)) {
    toast('Proposed — now add its visitors');
    location.hash = `#/encounters/${encodeURIComponent(next.id)}`;
  }
}

async function duplicateEncounter(key) {
  const it = findItem('encounters', key);
  const d = clone(it.data);
  d.name = `${d.name} (copy)`;
  d.id = freshId('encounters', d.name);
  if (await commitPending((q) => stage(q, { kind: 'encounters', key: d.id, op: 'add', before: null, after: tidy(d), note: '' }), `Duplicate encounter ${key}`)) {
    toast('Copy proposed');
    location.hash = `#/encounters/${encodeURIComponent(d.id)}`;
  }
}

// ------------------------------------------------------------------ changes

function summarize(kind, key, v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => lineOf(kind, key, x));
  if (typeof v === 'object') return [JSON.stringify(v)];
  return [String(v)];
}

function lineOf(kind, key, x) {
  if (x == null || typeof x !== 'object') return String(x);
  if (key === 'visitors') return `T${x.arriveAfterTurn} ${x.name || x.visitorDefId || '?'} · Need ${x.fulfillment} · P${x.patience}${x.abilityId ? ` · ${x.abilityId}` : ''}${x.tag ? ` · #${x.tag}` : ''}${x.headliner ? ' · headliner' : ''}`;
  if (key === 'nodes') return `${x.key} ${NODE_STYLE[x.type]?.l ?? x.type}${x.band ? `(${x.band})` : ''} ${x.branch} d${x.depth} l${x.lane} → ${(x.next ?? []).join(',') || '∅'}`;
  if (key === 'rebinds') return `${x.name}: ${x.before} → ${x.after} — ${x.text}`;
  return JSON.stringify(x);
}

function diffHtml(e) {
  if (e.op === 'delete') return '';
  if (e.op === 'add' || !e.before) {
    return `<div class="diff">${Object.entries(e.after ?? {})
      .filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `<div class="dk">${esc(k)}</div>${summarize(e.kind, k, v).map((l) => `<div class="plus">${esc(l)}</div>`).join('')}`)
      .join('')}</div>`;
  }
  const keys = [...new Set([...Object.keys(e.before), ...Object.keys(e.after)])];
  return `<div class="diff">${keys
    .filter((k) => !same(e.before[k], e.after[k]))
    .map((k) => {
      const a = summarize(e.kind, k, e.before[k]) || [];
      const b = summarize(e.kind, k, e.after[k]) || [];
      const minus = a.filter((l) => !b.includes(l));
      const plus = b.filter((l) => !a.includes(l));
      return `<div class="dk">${esc(k)}</div>${minus.map((l) => `<div class="minus">${esc(l)}</div>`).join('')}${plus.map((l) => `<div class="plus">${esc(l)}</div>`).join('')}${!minus.length && !plus.length ? '<div class="muted">reordered</div>' : ''}`;
    })
    .join('')}</div>`;
}

function changeCard(e, applied = false) {
  const kind = KIND[e.kind] ?? { one: e.kind, name: () => e.targetId };
  const name = e.kind === 'general' ? 'General note' : kind.name(e.after ?? e.before ?? { id: e.targetId });
  const opLabel = { add: 'New', edit: same(e.before, e.after) ? 'Note' : 'Edit', delete: 'Delete', note: 'Note' }[e.op];
  const link = e.kind !== 'general' && !applied && e.op !== 'delete' ? `href="#/${e.kind}/${encodeURIComponent(e.targetId)}"` : '';
  return `<div class="change">
    <div class="ch"><span class="tag p-${e.op === 'note' ? 'edit' : e.op}">${opLabel}</span><span class="tag">${esc(kind.one)}</span>
      <a class="nm" ${link} style="color:inherit;text-decoration:none">${esc(name)}</a>
      <span class="when">${esc(ago(applied ? e.appliedAt : e.at))}</span></div>
    ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
    ${applied ? (e.result ? `<div class="note" style="border-color:var(--ok)">Claude: ${esc(e.result)}</div>` : '') : diffHtml(e)}
    ${applied ? '' : `<div class="actions" style="margin-top:10px"><button class="btn sm danger" data-act="discard" data-id="${e.id}">Discard</button></div>`}
  </div>`;
}

views.changes = () => {
  if (!token())
    return `<div class="notice warn">This browser has no GitHub token yet, so it can only view. Paste one to make and see changes.</div>
      <div class="form"><div class="field"><label for="quick-token">GitHub token</label><input type="text" id="quick-token" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false" style="-webkit-text-security:disc">
      <div class="hint">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>: Repository access → only <b>${esc(repo())}</b>; Permissions → <b>Contents: Read and write</b>.</div></div>
      <div class="actions"><button class="btn primary" data-act="quick-token">Connect</button></div></div>`;
  const edits = [...S.pending.edits].reverse();
  const applied = [...(S.pending.applied ?? [])].reverse().slice(0, 40);
  return `${S.pendingError ? `<div class="notice err">${esc(S.pendingError)}</div>` : ''}
    <div class="notice">${edits.length ? `<b>${edits.length}</b> change${edits.length === 1 ? '' : 's'} waiting.` : 'Nothing waiting.'} When you're ready, tell Claude in the project: <i>“apply the catalogue changes”</i>.</div>
    <div class="actions"><button class="btn" data-act="general-note">+ General note for Claude</button><button class="btn ghost" data-act="refresh">Refresh</button></div>
    ${edits.length ? `<h3>Waiting</h3>${edits.map((e) => changeCard(e)).join('')}` : ''}
    ${applied.length ? `<h3>Applied by Claude</h3>${applied.map((e) => changeCard(e, true)).join('')}` : ''}`;
};

// ------------------------------------------------------------------ settings

views.settings = () => `
  <div class="form">
    <div class="field"><label for="set-token">GitHub token</label>
      <input type="text" id="set-token" value="${esc(token())}" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false" style="-webkit-text-security:disc">
      <div class="hint">Stored only in this browser. Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> with access to <b>only ${esc(repo())}</b> and the <b>Contents: Read and write</b> permission.</div></div>
    <div class="field"><label for="set-repo">Catalogue repo</label><input type="text" id="set-repo" value="${esc(repo())}" autocapitalize="off" spellcheck="false"></div>
    <div class="field check"><label><input type="checkbox" id="set-proposed" ${S.proposed ? 'checked' : ''}> Show my proposed changes in place of the game versions</label></div>
    <div class="actions"><button class="btn primary" data-act="save-settings">Save &amp; test</button><button class="btn" data-act="reload">Reload catalogue</button></div>
    <div class="notice small">Catalogue exported from the game ${esc(ago(S.cat?.exportedAt))} (${esc(S.cat ? new Date(S.cat.exportedAt).toLocaleString() : '—')}).<br>
      ${S.cat ? `${S.cat.books.length} books · ${S.cat.curios.length} curios · ${S.cat.routes.length} routes · ${S.cat.encounters.length} encounters` : ''}</div>
  </div>`;

// ------------------------------------------------------------------ forms

const BLANK = {
  books: () => ({ id: '', title: '', traits: [], rarity: 'common', value: 2, actionCost: 1, copies: 1, rebinds: [] }),
  curios: () => ({ id: '', name: '', text: '', rarity: 'common', price: 65 }),
  routes: () => ({
    id: '',
    name: '',
    nodes: [
      { key: 'n1', type: 'encounter-normal', band: 'opening', branch: 'shared', depth: 0, lane: 0, next: ['m'] },
      { key: 'm', type: 'merchant', branch: 'shared', depth: 1, lane: 0, next: ['b'] },
      { key: 'b', type: 'encounter-boss', branch: 'shared', depth: 2, lane: 0, next: [] },
    ],
    boss: 'b',
    merchant: 'm',
  }),
};

function newForm(r) {
  const kind = r.tab;
  if (r.id === 'new') return { kind, op: 'add', key: null, orig: null, draft: BLANK[kind](), note: '' };
  const it = findItem(kind, r.id);
  if (!it) return null;
  if (r.mode === 'duplicate') {
    const d = clone(it.data);
    d.id = `${d.id}-copy`;
    if (kind === 'books') {
      d.title = `${d.title} (copy)`;
      d.rebinds = (d.rebinds ?? []).map((u) => ({ ...u, id: undefined }));
    } else d.name = `${d.name} (copy)`;
    return { kind, op: 'add', key: null, orig: null, draft: d, note: '' };
  }
  const op = it.pending?.op === 'add' ? 'add' : 'edit';
  return { kind, op, key: it.key, orig: it.orig, draft: clone(it.pending?.after ?? it.data), note: it.pending?.note ?? '' };
}

const fieldText = (path, label, value, { area = false, hint = '', ph = '' } = {}) =>
  `<div class="field"><label>${esc(label)}</label>${
    area
      ? `<textarea data-path="${path}" placeholder="${esc(ph)}">${esc(value ?? '')}</textarea>`
      : `<input type="text" data-path="${path}" value="${esc(value ?? '')}" placeholder="${esc(ph)}" autocomplete="off">`
  }${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
const fieldNum = (path, label, value, { opt = false } = {}) =>
  `<div class="field"><label>${esc(label)}</label><input type="number" data-path="${path}" data-type="number" ${opt ? 'data-opt="1"' : ''} value="${value ?? ''}"></div>`;
const fieldSelect = (path, label, value, options, { rerender = false, blank = null } = {}) =>
  `<div class="field"><label>${esc(label)}</label><select data-path="${path}" ${rerender ? 'data-rerender="1"' : ''}>${
    blank != null ? `<option value="">${esc(blank)}</option>` : ''
  }${options.map(([v, l]) => `<option value="${esc(v)}" ${String(value ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
const fieldCheck = (path, label, value) =>
  `<div class="field check"><label><input type="checkbox" data-path="${path}" data-type="check" ${value ? 'checked' : ''}> ${esc(label)}</label></div>`;
const fieldChips = (path, label, values, options) =>
  `<div class="field">${label ? `<span class="lbl">${esc(label)}</span>` : ''}<div class="chips" style="flex-wrap:wrap;overflow:visible">${options
    .map(([v, l]) => `<button type="button" class="chip ${(values ?? []).includes(v) ? 'on' : ''}" data-toggle="${path}" data-val="${esc(v)}">${esc(l)}</button>`)
    .join('')}</div></div>`;
const miniBtns = (list, i) =>
  `<div class="mini-btns"><button type="button" data-act="row-up" data-list="${list}" data-i="${i}" aria-label="Move up">↑</button><button type="button" data-act="row-down" data-list="${list}" data-i="${i}" aria-label="Move down">↓</button><button type="button" data-act="row-copy" data-list="${list}" data-i="${i}" aria-label="Duplicate">⧉</button><button type="button" data-act="row-del" data-list="${list}" data-i="${i}" aria-label="Remove">✕</button></div>`;

const formBody = {
  books(d) {
    const rebinds = d.rebinds ?? [];
    return `
      <section class="fsec">
        ${fieldText('title', 'Title', d.title)}
        <div class="two">${fieldSelect('_trait', 'Trait', d.traits?.[0] ?? '', S.cat.traits.map((t) => [t.id, t.name]), { blank: 'None (Basic)' })}${fieldSelect('rarity', 'Rarity', d.rarity, RARITIES.map((r) => [r, cap(r)]))}</div>
        <div class="two">${fieldNum('value', 'Value', d.value)}${fieldNum('actionCost', 'Action cost', d.actionCost)}</div>
      </section>
      <section class="fsec"><h3 class="fsec-h">Rules</h3>
        ${fieldText('rulesText', 'Rules text', d.rulesText, { area: true, ph: 'On Assign: …' })}
      </section>
      <section class="fsec"><h3 class="fsec-h">Rebinds <small>${rebinds.length}</small></h3>
        <p class="fsec-hint">A Rebind patches one copy: the player is offered 2 of these and keeps 1.</p>
        ${rebinds
          .map(
            (u, i) => `<div class="sub-card"><div class="sub-h"><b>${esc(u.name || `Rebind ${i + 1}`)}</b>${miniBtns('rebinds', i)}</div>
              ${fieldText(`rebinds.${i}.name`, 'Name', u.name)}
              <div class="two">${fieldText(`rebinds.${i}.before`, 'Before', u.before, { ph: 'Value 2' })}${fieldText(`rebinds.${i}.after`, 'After', u.after, { ph: 'Value 4' })}</div>
              ${fieldText(`rebinds.${i}.text`, 'Rule', u.text, { area: true })}</div>`,
          )
          .join('')}
        <button type="button" class="btn ghost add-row" data-act="add-rebind">+ Add rebind</button>
      </section>
      <section class="fsec"><h3 class="fsec-h">Flags</h3>
        ${fieldChips('flags', '', d.flags, BOOK_FLAGS.map((f) => [f, f]))}
        ${fieldCheck('extension', 'Extension book (beyond its Trait’s core ten)', d.extension)}
      </section>`;
  },

  curios(d) {
    const curse = d.curse != null;
    return `
      ${fieldText('name', 'Name', d.name)}
      ${fieldSelect('_kind', 'Kind', curse ? 'curse' : 'positive', [['positive', 'Positive Curio'], ['curse', 'Curse (negative Curio)']], { rerender: true })}
      ${
        curse
          ? fieldSelect('curse', 'Curse family', d.curse, CURSE_FAMILIES.map((f) => [f, cap(f)]))
          : `<div class="two">${fieldSelect('rarity', 'Rarity', d.rarity, CURIO_RARITIES.map((r) => [r, cap(r)]))}${fieldNum('price', 'Merchant price (Gold)', d.price, { opt: true })}</div>`
      }
      ${fieldSelect('trait', 'Only with Trait', d.trait, S.cat.traits.map((t) => [t.id, t.name]), { blank: 'Any run' })}
      ${fieldText('text', 'Effect', d.text, { area: true })}`;
  },

  routes(d) {
    const { errs, warns } = routeChecks(d);
    const sorted = d.nodes.map((n, i) => [n, i]).sort(([a], [b]) => a.depth - b.depth || a.lane - b.lane);
    return `
      ${fieldText('name', 'Name', d.name)}
      <div class="map-wrap">${routeSvg(d)}</div>${legend()}
      ${errs.map((e) => `<div class="notice err">${esc(e)}</div>`).join('')}${warns.map((e) => `<div class="notice warn">${esc(e)}</div>`).join('')}
      <details><summary class="muted small" style="padding:6px 0">Path counts</summary>${routePathTable(d)}</details>
      <h3>Nodes</h3><p class="small muted" style="margin-top:0">Depth = column along the descent, lane = row (negative is up). Tap the keys a node leads to.</p>
      ${sorted
        .map(([n, i]) => {
          const others = d.nodes.filter((m) => m.key !== n.key && ((Number(m.depth) || 0) > (Number(n.depth) || 0) || (n.next ?? []).includes(m.key)));
          return `<div class="sub-card"><div class="sub-h"><span class="tag" style="background:${NODE_STYLE[n.type]?.c};color:#15110e;border:0">${NODE_STYLE[n.type]?.l}</span><b>${esc(n.key)}</b>${miniBtns('nodes', i)}</div>
            <div class="two"><div class="field"><label>Key</label><input type="text" value="${esc(n.key)}" data-act-change="rename-node" data-i="${i}" autocomplete="off" autocapitalize="off"></div>
            ${fieldSelect(`nodes.${i}.type`, 'Type', n.type, NODE_TYPES.map((t) => [t, NODE_STYLE[t].name]), { rerender: true })}</div>
            <div class="two">${n.type === 'encounter-normal' ? fieldSelect(`nodes.${i}.band`, 'Band', n.band, BANDS.map((b) => [b, cap(b)]), { rerender: true }) : '<div></div>'}
            ${fieldSelect(`nodes.${i}.branch`, 'Branch', n.branch, [...new Set([...BRANCHES, n.branch])].map((b) => [b, b]), { rerender: true })}</div>
            <div class="two">${fieldNum(`nodes.${i}.depth`, 'Depth', n.depth)}${fieldNum(`nodes.${i}.lane`, 'Lane', n.lane)}</div>
            <div class="field"><span class="lbl">Leads to</span><div class="chips" style="flex-wrap:wrap;overflow:visible">${
              others.length
                ? others
                    .sort((a, b) => a.depth - b.depth || a.lane - b.lane)
                    .map((m) => `<button type="button" class="chip ${(n.next ?? []).includes(m.key) ? 'on' : ''}" data-toggle="nodes.${i}.next" data-val="${esc(m.key)}">${esc(m.key)}</button>`)
                    .join('')
                : '<span class="small muted">Nothing deeper</span>'
            }</div></div></div>`;
        })
        .join('')}
      <button type="button" class="btn" data-act="add-node">+ Add node</button>`;
  },
};

function formHtml() {
  const F = S.form;
  return `<form class="form" id="edit-form" onsubmit="return false">
    ${formBody[F.kind](F.draft)}
    <section class="fsec"><h3 class="fsec-h">Note to Claude <small>optional</small></h3>
      <div class="field note-field"><textarea data-note="1" placeholder="Why, or anything I should know when implementing this (new mechanics, art, balance intent)…">${esc(F.note)}</textarea></div></section>
    <div class="sticky-save"><button type="button" class="btn ghost" data-act="cancel">Cancel</button><button type="button" class="btn primary" data-act="save">${F.op === 'add' ? 'Propose new' : 'Save change'}</button></div>
  </form>`;
}

function rerenderForm() {
  const body = $('#editor-body');
  const y = body.scrollTop;
  body.innerHTML = formHtml();
  body.scrollTop = y;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    o[ks[i]] ??= /^\d+$/.test(ks[i + 1]) ? [] : {};
    o = o[ks[i]];
  }
  const last = ks[ks.length - 1];
  if (val === undefined) delete o[last];
  else o[last] = val;
}

const KEEP_EMPTY = new Set(['traits', 'visitors', 'nodes', 'next', 'rebinds', 'id']);
/** Drop blank optional fields so the queue carries what was actually authored. */
function tidy(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => tidy(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('_')) continue;
      const t = tidy(x, k);
      if (t === undefined || t === null) continue;
      if (!KEEP_EMPTY.has(k) && (t === '' || t === false || (Array.isArray(t) && !t.length))) continue;
      if (t && typeof t === 'object' && !Array.isArray(t) && !Object.keys(t).length) continue;
      o[k] = t;
    }
    return o;
  }
  return typeof v === 'string' ? v.trim() : v;
}

/** An id for something new, derived from its name and never clashing with another. */
function freshId(kind, name, ownKey = null) {
  const base = slug(name) || kind.slice(0, -1);
  const taken = new Set(items(kind).filter((x) => x.key !== ownKey).map((x) => x.data.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function validate(F, d) {
  const errs = [];
  if (F.kind === 'books' && !d.title) errs.push('Title is required');
  if (F.kind === 'curios' && !d.name) errs.push('Name is required');
  if (F.kind === 'encounters') {
    if (!d.name) errs.push('Name is required');
    if (!d.visitors.length) errs.push('An Encounter needs at least one visitor');
    if (d.category === 'normal' && !d.band) errs.push('A Normal Encounter needs a band');
  }
  if (F.kind === 'routes') {
    if (!d.name) errs.push('Name is required');
    errs.push(...routeChecks(d).errs);
  }
  return errs;
}

function finalize(F) {
  const d = tidy(F.draft);
  // Ids are never shown: a new item takes one from its name; an existing one keeps its own.
  if (F.op === 'add') d.id = freshId(F.kind, d.title ?? d.name, F.key);
  if (F.kind === 'books') d.rebinds = (d.rebinds ?? []).map((u) => ({ ...u, id: u.id ?? `${d.id}:${slug(u.name)}` }));
  if (F.kind === 'curios') {
    if (d.curse) {
      delete d.rarity;
      delete d.price;
    } else delete d.curse;
  }
  if (F.kind === 'encounters' && d.category !== 'normal') delete d.band;
  if (F.kind === 'encounters' && d.type !== 'boss') delete d.intro;
  if (F.kind === 'routes') {
    for (const n of d.nodes) {
      n.next ??= [];
      if (n.type !== 'encounter-normal') delete n.band;
    }
    d.boss = d.nodes.find((n) => n.type === 'encounter-boss')?.key;
    d.merchant = d.nodes.find((n) => n.type === 'merchant')?.key;
  }
  return d;
}

async function saveForm() {
  const F = S.form;
  const d = finalize(F);
  const errs = validate(F, d);
  if (errs.length) return toast(errs[0], true);
  const before = F.orig ? clone(F.orig) : null;
  const ok = await commitPending(
    (data) => stage(data, { kind: F.kind, key: F.op === 'add' ? F.key ?? d.id : F.key, op: F.op, before, after: d, note: F.note.trim() }),
    `${F.op === 'add' ? 'Propose' : 'Edit'} ${F.kind.slice(0, -1)} ${d.id}`,
  );
  if (!ok) return;
  toast(F.op === 'add' ? 'Proposed — waiting for Claude' : 'Saved — waiting for Claude');
  S.form = null;
  location.replace(`#/${F.kind}/${encodeURIComponent(d.id)}`);
  render();
}

// ------------------------------------------------------------------ events

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.filter) {
    S.filters[t.dataset.filter].q = t.value;
    const tmp = document.createElement('div');
    tmp.innerHTML = views.list[t.dataset.filter]();
    $('#results')?.replaceWith(tmp.querySelector('#results'));
    return;
  }
  const F = S.form;
  if (!F) return;
  if (t.dataset.note) return void (F.note = t.value);
  const path = t.dataset.path;
  if (!path || t.tagName === 'SELECT' || t.type === 'checkbox') return;
  let v = t.value;
  if (t.dataset.type === 'number') v = v === '' ? (t.dataset.opt ? undefined : 0) : Number(v);
  setPath(F.draft, path, v);
  if (F.kind === 'routes' && /^nodes\.\d+\.(depth|lane)$/.test(path)) {
    const wrap = $('#editor-body .map-wrap');
    if (wrap) wrap.innerHTML = routeSvg(F.draft);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'set-token') {
    LS.set('token', t.value.trim());
    refreshPending().then(render);
    return;
  }
  const F = S.form;
  if (!F) return;
  if (t.dataset.actChange === 'rename-node') {
    const n = F.draft.nodes[+t.dataset.i];
    const old = n.key;
    const nk = t.value.trim();
    if (!nk || nk === old) return void (t.value = old);
    n.key = nk;
    for (const m of F.draft.nodes) m.next = (m.next ?? []).map((k) => (k === old ? nk : k));
    return rerenderForm();
  }
  const path = t.dataset.path;
  if (!path) return;
  if (t.type === 'checkbox') setPath(F.draft, path, t.checked || undefined);
  else if (t.tagName === 'SELECT') {
    if (path === '_trait') F.draft.traits = t.value ? [t.value] : [];
    else if (path === '_kind') {
      if (t.value === 'curse') F.draft.curse = F.draft.curse ?? 'bookselling';
      else {
        delete F.draft.curse;
        F.draft.rarity ??= 'common';
      }
    } else setPath(F.draft, path, t.value === '' ? undefined : t.value);
    if (F.kind === 'routes' && /\.type$/.test(path)) {
      const n = getPath(F.draft, path.replace(/\.type$/, ''));
      if (n.type === 'encounter-normal') n.band ??= 'mid';
    }
    if (t.dataset.rerender) rerenderForm();
  }
});

document.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-chip]');
  if (chip) {
    S.filters[chip.dataset.chip][chip.dataset.key] = chip.dataset.val;
    return render();
  }
  const tog = e.target.closest('[data-toggle]');
  if (tog && S.form) {
    const arr = getPath(S.form.draft, tog.dataset.toggle) ?? [];
    const v = tog.dataset.val;
    setPath(S.form.draft, tog.dataset.toggle, arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    return rerenderForm();
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const F = S.form;
  const list = b.dataset.list && F ? (F.draft[b.dataset.list] ??= []) : null;
  const i = +b.dataset.i;
  switch (act) {
    case 'row-up':
      if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      return rerenderForm();
    case 'row-down':
      if (i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      return rerenderForm();
    case 'row-copy': {
      const c = clone(list[i]);
      if (b.dataset.list === 'nodes') {
        c.key = `${c.key}-2`;
        c.next = [...(c.next ?? [])];
      }
      if (b.dataset.list === 'rebinds') delete c.id;
      list.splice(i + 1, 0, c);
      return rerenderForm();
    }
    case 'row-del': {
      const gone = list.splice(i, 1)[0];
      if (b.dataset.list === 'nodes') for (const m of list) m.next = (m.next ?? []).filter((k) => k !== gone.key);
      return rerenderForm();
    }
    case 'add-rebind':
      (F.draft.rebinds ??= []).push({ name: '', before: '', after: '', text: '' });
      return rerenderForm();
    case 'add-visitor': {
      const last = F.draft.visitors[F.draft.visitors.length - 1];
      F.draft.visitors.push({ arriveAfterTurn: last?.arriveAfterTurn ?? 0, name: '', fulfillment: 5, patience: 2 });
      return rerenderForm();
    }
    case 'add-node': {
      const maxD = Math.max(0, ...F.draft.nodes.map((n) => Number(n.depth) || 0));
      let k = F.draft.nodes.length + 1;
      while (F.draft.nodes.some((n) => n.key === `x${k}`)) k++;
      F.draft.nodes.push({ key: `x${k}`, type: 'event', branch: 'shared', depth: maxD, lane: 0, next: [] });
      return rerenderForm();
    }
    case 'cancel': {
      S.form = null;
      // Back when the editor was opened from inside the site; otherwise close onto its page.
      if (S.hops > 0) return history.back();
      const r = parseHash();
      return location.replace(r.id && r.id !== 'new' ? `#/${r.tab}/${encodeURIComponent(r.id)}` : `#/${r.tab}`);
    }
    case 'save':
      b.disabled = true;
      await saveForm();
      b.disabled = false;
      return;
    case 'delete': {
      const it = findItem(b.dataset.kind, b.dataset.key);
      const note = await ask({ title: `Delete ${KIND[b.dataset.kind].name(it.data)}?`, body: 'Claude will remove it from the game when applying changes.', input: true, placeholder: 'Why? (optional)', ok: 'Mark for deletion', danger: true });
      if (note === null) return;
      if (await commitPending((d) => stage(d, { kind: b.dataset.kind, key: it.key, op: 'delete', before: clone(it.orig), after: null, note }), `Delete ${b.dataset.kind.slice(0, -1)} ${it.key}`)) {
        toast(it.pending?.op === 'add' ? 'Proposal removed' : 'Marked for deletion');
        if (it.pending?.op === 'add') location.hash = `#/${b.dataset.kind}`;
        else render();
      }
      return;
    }
    case 'note': {
      const it = findItem(b.dataset.kind, b.dataset.key);
      const note = await ask({ title: `Note on ${KIND[b.dataset.kind].name(it.data)}`, body: 'Ask for something without editing fields yourself — e.g. “make this stronger, you choose how”.', input: true, value: it.pending?.note ?? '', ok: 'Save note' });
      if (!note) return;
      const op = it.pending?.op === 'add' ? 'add' : 'edit';
      if (await commitPending((d) => stage(d, { kind: b.dataset.kind, key: it.key, op, before: clone(it.orig), after: clone(it.pending?.after ?? it.orig), note }), `Note on ${it.key}`)) {
        toast('Note saved');
        render();
      }
      return;
    }
    case 'discard': {
      if (!(await ask({ title: 'Discard this change?', body: 'It will be removed from the queue for Claude.', ok: 'Discard', danger: true }))) return;
      if (await commitPending((d) => (d.edits = d.edits.filter((x) => x.id !== b.dataset.id)), 'Discard a pending change')) {
        toast('Discarded');
        render();
      }
      return;
    }
    case 'general-note': {
      const note = await ask({ title: 'General note for Claude', body: 'Anything not tied to one item: a new system, a batch request, a question.', input: true, ok: 'Add' });
      if (!note) return;
      if (await commitPending((d) => d.edits.push({ id: uid(), kind: 'general', op: 'note', targetId: '', before: null, after: null, note, at: new Date().toISOString() }), 'General note')) {
        toast('Note added');
        render();
      }
      return;
    }
    case 'visitor-edit':
      return editVisitor(b.dataset.key, +b.dataset.i);
    case 'visitor-add':
      return editVisitor(b.dataset.key, null);
    case 'enc-details':
      return editEncounterDetails(b.dataset.key);
    case 'enc-duplicate':
      return duplicateEncounter(b.dataset.key);
    case 'quick-token':
      LS.set('token', $('#quick-token').value.trim());
      await refreshPending();
      if (token() && !S.pendingError) toast('Connected — changes will save to GitHub');
      return render();
    case 'refresh':
      await refreshPending();
      return render();
    case 'save-settings': {
      LS.set('token', $('#set-token').value.trim());
      LS.set('repo', $('#set-repo').value.trim() || DEFAULT_REPO);
      S.proposed = $('#set-proposed').checked;
      LS.set('proposed', S.proposed);
      await refreshPending();
      if (token() && !S.pendingError) toast('Connected — changes will save to GitHub');
      return render();
    }
    case 'reload':
      await boot();
      return toast('Catalogue reloaded');
  }
});

$('#fab').addEventListener('click', (e) => {
  if (parseHash().tab !== 'encounters') return;
  e.preventDefault();
  editEncounterDetails();
});

$('#back').addEventListener('click', () => {
  const r = parseHash();
  if (history.length > 1) history.back();
  else location.hash = `#/${r.tab}`;
});

window.addEventListener('hashchange', () => {
  S.hops = (S.hops ?? 0) + 1;
  render();
  if (!S.form) window.scrollTo(0, 0);
});

// Pick up Claude's applied changes when the phone comes back to the tab.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && S.cat && !S.form) {
    await loadCatalogue().catch(() => {});
    await refreshPending({ quiet: true });
    render();
  }
});

async function boot() {
  try {
    await loadCatalogue();
  } catch (e) {
    $('#view').innerHTML = `<div class="notice err">Could not load the catalogue: ${esc(e.message)}</div>`;
    return;
  }
  render();
  await refreshPending({ quiet: true });
  render();
}

boot();
