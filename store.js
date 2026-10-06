/*
 * The catalogue's shared data layer: the exported catalogue, the queue of
 * proposed changes (`pending.json` on the site repo's `edits` branch) and the
 * rules both pages use to read and write it. Imported by the phone app
 * (`app.js`) and the desktop studio (`studio.js`), so every save, wherever it
 * comes from, lands in the queue in exactly the same shape.
 */

/** Shared state. Each page adds its own fields. */
const S = {
  cat: null,
  pending: { version: 1, edits: [], applied: [] },
  sha: null,
  pendingLoaded: false,
  pendingError: null,
  proposed: true,
};

/** What the data layer tells the page: sync state, messages, queue changed, token needed. */
const hooks = {
  sync() {},
  toast() {},
  changed() {},
  needToken() {},
};

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

const token = () => LS.get('token', '');
const repo = () => LS.get('repo', DEFAULT_REPO) || DEFAULT_REPO;

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
  abilities: { one: 'Visitor ability', name: (a) => a.name || a.id },
  general: { one: 'Note', name: () => 'General note' },
};

const trait = (id) => S.cat?.traits.find((t) => t.id === id);
const traitName = (id) => trait(id)?.name ?? cap(id);
const visitorDef = (id) => S.cat?.visitors.find((v) => v.id === id);
/** A visitor ability as proposed: queued edits and new abilities included. */
const ability = (id) => (id ? allAbilities().find((a) => a.id === id) : undefined);
/** Every visitor ability with the queue laid over it, proposed ones last. */
const allAbilities = () => (S.cat ? items('abilities').filter((x) => x.pending?.op !== 'delete').map((x) => x.data) : []);
const hasArt = (kind, id) => S.cat?.art?.[kind]?.includes(id);
const artUrl = (kind, id) => `art/${kind}/${encodeURIComponent(id)}.webp`;
/** The large cut behind the enlarge view; only books, Curios and visitors have one. */
const artLargeUrl = (kind, id) => (['books', 'curios', 'visitors'].includes(kind) ? `art/${kind}-lg/${encodeURIComponent(id)}.webp` : artUrl(kind, id));

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
    hooks.sync('', 'Read-only: add a GitHub token in Settings to see and save changes');
    return;
  }
  hooks.sync('busy');
  try {
    const { data, sha } = await fetchPending();
    S.pending = data;
    S.sha = sha;
    S.pendingLoaded = true;
    S.pendingError = null;
    hooks.sync('ok', 'Synced with GitHub');
  } catch (e) {
    S.pendingError = e.message;
    hooks.sync('err', e.message);
    if (!quiet) hooks.toast(e.message, true);
  }
  hooks.changed();
}

/**
 * Apply `mutate` to the freshest queue and write it back. Retries on a stale
 * sha, so an edit from another device (or Claude clearing applied ones) is
 * never overwritten.
 */
async function commitPending(mutate, message) {
  if (!token()) {
    hooks.toast('Add a GitHub token in Settings first', true);
    hooks.needToken();
    return false;
  }
  hooks.sync('busy');
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
        hooks.sync('ok', 'Saved to GitHub');
        hooks.changed();
        return true;
      }
      if (r.status === 409 || r.status === 422) continue;
      throw new Error(r.status === 401 || r.status === 403 ? `GitHub refused the write (${r.status}) — check the token's Contents permission` : `GitHub: HTTP ${r.status}`);
    }
    throw new Error('Could not save: the queue kept changing underneath. Try again.');
  } catch (e) {
    hooks.sync('err', e.message);
    hooks.toast(e.message, true);
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

/**
 * Switched off: kept in the game's data, but never rolled, shown, bought or
 * found (`disabled: true`; absent means active, so everything starts active).
 */
const isOff = (d) => !!d?.disabled;
const offTag = (d) => (isOff(d) ? '<span class="tag off">Off</span>' : '');

/** A copy of `draft` switched on or off. Active drops the field rather than storing `false`. */
function withActive(draft, active) {
  const d = clone(draft);
  if (active) delete d.disabled;
  else d.disabled = true;
  return d;
}

const findItem = (kind, key) => items(kind).find((x) => x.key === key) ?? items(kind).find((x) => x.data.id === key);

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
  // Bookselling bands never step back along a walk (opening → mid → late).
  const rank = { opening: 0, mid: 1, late: 2 };
  for (const p of paths) {
    const bands = p.filter((n) => n.type === 'encounter-normal' && n.band);
    const back = bands.findIndex((n, i) => i > 0 && rank[n.band] < rank[bands[i - 1].band]);
    if (back > 0) {
      warns.push(`${bands[back].key} is ${bands[back].band} after ${bands[back - 1].band} ${bands[back - 1].key}: bands never step back`);
      break;
    }
  }
  return { errs, warns, paths };
}

/** A select's value into a draft, with the two derived fields (`_trait`, `_kind`). */
function setField(draft, path, value) {
  if (path === '_trait') draft.traits = value ? [value] : [];
  else if (path === '_kind') {
    if (value === 'curse') draft.curse ??= 'bookselling';
    else {
      delete draft.curse;
      draft.rarity ??= 'common';
    }
  } else setPath(draft, path, value === '' ? undefined : value);
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

export {
  allAbilities,
  API,
  BANDS,
  BOOK_FLAGS,
  BRANCHES,
  CATEGORY_LABEL,
  CURIO_RARITIES,
  CURSE_FAMILIES,
  DEFAULT_REPO,
  EDITS_BRANCH,
  EDITS_FILE,
  ENC_CATEGORIES,
  ENC_TYPES,
  KEEP_EMPTY,
  KIND,
  LS,
  NODE_STYLE,
  NODE_TYPES,
  RARITIES,
  S,
  ability,
  ago,
  artLargeUrl,
  artUrl,
  b64dec,
  b64enc,
  cap,
  clone,
  commitPending,
  ensureBranch,
  esc,
  fetchPending,
  findItem,
  freshId,
  getPath,
  gh,
  hasArt,
  hooks,
  isOff,
  items,
  loadCatalogue,
  refreshPending,
  repo,
  routeChecks,
  routePaths,
  same,
  setField,
  setPath,
  slug,
  stable,
  stage,
  thresholds,
  tidy,
  token,
  trait,
  traitName,
  uid,
  visitorDef,
  withActive,
  offTag,
};
