/*
 * Underbook Studio — the desktop editor for Encounters and route layouts.
 *
 * Shares the catalogue and the change queue with the phone site (`store.js`):
 * every edit here is folded into `pending.json` exactly as a phone edit is,
 * for Claude to apply. Edits save themselves a moment after they are made;
 * Ctrl+Z / Ctrl+Y step through this session's history of the open item.
 *
 * Encounters: arrival waves are columns; visitor cards drag between them,
 * Need and Patience step with −/+, portraits and abilities come from pickers
 * or are dragged in from the right-hand palette.
 * Routes: a grid canvas; nodes drag to a cell, a node's handle drags out a
 * connection, node types drag in from the palette; paths are checked live.
 */

import {
  S,
  allAbilities,
  hooks,
  LS,
  token,
  items,
  findItem,
  stage,
  commitPending,
  refreshPending,
  loadCatalogue,
  tidy,
  freshId,
  clone,
  esc,
  cap,
  ago,
  thresholds,
  routeChecks,
  routePaths,
  setPath,
  getPath,
  NODE_STYLE,
  NODE_TYPES,
  BRANCHES,
  BANDS,
  ENC_TYPES,
  ENC_CATEGORIES,
  CATEGORY_LABEL,
  visitorDef,
  ability,
  hasArt,
  artUrl,
  isOff,
  offTag,
  withActive,
} from './store.js';
import { ZOOM_BADGE, zoomAttrs } from './zoom.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
S.proposed = true;

/** The open item: its working copy, history and save state. */
let ED = null;
let filterText = '';
let lastNodeType = 'event';

// ------------------------------------------------------------------ chrome

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), err ? 5000 : 1800);
}
function setSync(state, title = '') {
  $('#sync').className = 'sync ' + state;
  $('#sync').title = title;
}
const setSaved = (txt) => ($('#saved').textContent = txt);
hooks.sync = setSync;
hooks.toast = toast;
hooks.changed = () => drawSide();
hooks.needToken = () => $('#token-in')?.focus();

/** A small centred dialog. Resolves to the form values, or null. */
function dialog(html, ok = 'OK', danger = false) {
  return new Promise((resolve) => {
    const d = $('#dialog');
    d.innerHTML = `<div class="box">${html}<div class="row"><button class="btn" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div></div>`;
    d.hidden = false;
    const first = d.querySelector('input, select, textarea');
    first?.focus();
    const done = (r) => {
      d.hidden = true;
      d.innerHTML = '';
      d.onclick = d.onkeydown = null;
      resolve(r);
    };
    const values = () => Object.fromEntries($$('[data-f]', d).map((el) => [el.dataset.f, el.value.trim()]));
    d.onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (e.target === d || b?.dataset.r === '0') return done(null);
      if (b) done(values());
    };
    d.onkeydown = (e) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') done(values());
    };
  });
}

// ------------------------------------------------------------------ routing

function parseHash() {
  const [mode = 'encounters', key] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return { mode: mode === 'routes' ? 'routes' : 'encounters', key };
}

function render() {
  const { mode, key } = parseHash();
  for (const a of $$('.modes a')) a.classList.toggle('on', a.dataset.mode === mode);
  $('#token-banner').hidden = !!token();
  if (!S.cat) return;
  if (key) openEditor(mode, key);
  else ED = null;
  drawSide();
  drawMain();
  drawRail();
}

/** Load the item into the editor, keeping unsaved work and history when it is already open. */
function openEditor(mode, key) {
  const it = findItem(mode, key);
  if (!it) {
    ED = null;
    return;
  }
  const same = ED && ED.mode === mode && ED.key === it.key;
  if (same && (ED.dirty || ED.busy)) return;
  ED = {
    mode,
    key: it.key,
    op: it.pending?.op === 'add' ? 'add' : 'edit',
    orig: it.orig,
    draft: clone(it.pending?.after ?? it.orig ?? it.data),
    note: it.pending?.note ?? '',
    live: it.pending?.op !== 'delete',
    undo: same ? ED.undo : [],
    redo: same ? ED.redo : [],
    sel: same ? ED.sel : null,
    hoverPath: null,
    dirty: false,
    busy: false,
  };
}

// ------------------------------------------------------------------ editing, history, saving

/** Change the draft through `fn`, record history, redraw and schedule a save. */
function edit(fn, redraw = true) {
  if (!ED?.live) return;
  ED.undo.push(clone(ED.draft));
  if (ED.undo.length > 200) ED.undo.shift();
  ED.redo = [];
  fn(ED.draft);
  changed();
  if (redraw) drawEditor();
}

function changed() {
  ED.dirty = true;
  setSaved('Unsaved…');
  clearTimeout(ED.timer);
  const E = ED;
  E.timer = setTimeout(() => flush(E), 700);
}

function stepHistory(from, to) {
  if (!ED?.live || !ED[from].length) return;
  ED[to].push(clone(ED.draft));
  ED.draft = ED[from].pop();
  changed();
  drawEditor();
}

/** The draft as it goes into the queue. */
function finished(E) {
  const d = tidy(E.draft);
  if (E.mode === 'encounters') {
    d.visitors ??= [];
    if (d.category !== 'normal') delete d.band;
    if (d.type !== 'boss') delete d.intro;
    if (E.orig && E.orig.stage === undefined && d.stage === 1) delete d.stage;
  } else {
    d.nodes ??= [];
    for (const n of d.nodes) {
      n.next ??= [];
      if (n.type !== 'encounter-normal') delete n.band;
    }
    d.boss = d.nodes.find((n) => n.type === 'encounter-boss')?.key;
    d.merchant = d.nodes.find((n) => n.type === 'merchant')?.key;
  }
  return d;
}

async function flush(E = ED) {
  if (!E || !E.dirty) return;
  clearTimeout(E.timer);
  if (E.busy) return void (E.again = true);
  if (!(E.draft.name ?? '').trim()) return void setSaved('A name is needed before this can save');
  E.busy = true;
  E.dirty = false;
  setSaved('Saving…');
  const after = finished(E);
  const ok = await commitPending(
    (q) => stage(q, { kind: E.mode, key: E.key, op: E.op, before: clone(E.orig), after, note: E.note }),
    `${E.op === 'add' ? 'Propose' : 'Edit'} ${E.mode.slice(0, -1)} ${E.key} (Studio)`,
  );
  E.busy = false;
  if (!ok) E.dirty = true;
  if (E.again) {
    E.again = false;
    E.dirty = true;
    return flush(E);
  }
  if (ok && !E.dirty) {
    E.savedAt = new Date().toISOString();
    if (ED === E) {
      setSaved('Saved');
      drawSide();
      drawBanner();
    }
  } else if (!ok) setSaved('Not saved: check the token or connection');
}

// ------------------------------------------------------------------ side list

function drawSide() {
  const { mode, key } = parseHash();
  const all = items(mode).filter(({ data }) => !filterText || (data.name ?? '').toLowerCase().includes(filterText.toLowerCase()));
  const tag = (it) =>
    it.pending ? `<span class="tag p-${it.pending.op}">${{ add: 'New', edit: 'Edited', delete: 'Delete' }[it.pending.op]}</span>` : '';
  const row = (it, sub) =>
    `<a class="side-item ${it.key === key ? 'on' : ''} ${it.pending?.op === 'delete' ? 'deleted' : ''} ${isOff(it.data) ? 'off' : ''}" href="#/${mode}/${encodeURIComponent(it.key)}"><span class="nm">${esc(it.data.name || 'Untitled')}</span>${offTag(it.data)}${tag(it)}<span class="sub">${esc(sub)}</span></a>`;
  let html = `<div class="side-head"><input class="search" id="side-search" placeholder="Search ${mode}…" value="${esc(filterText)}"><button class="btn primary" data-act="new" title="New">+ New</button></div>`;
  if (mode === 'encounters') {
    const stages = [...new Set(all.map((x) => x.data.stage ?? 1))].sort((a, b) => a - b);
    const rank = (e) => ENC_CATEGORIES.indexOf(e.category) * 10 + (e.band ? BANDS.indexOf(e.band) : 0);
    for (const s of stages) {
      html += `<div class="side-group label">${s === 0 ? 'Tutorial' : `Stage ${s}`}</div>`;
      for (const it of all.filter((x) => (x.data.stage ?? 1) === s).sort((a, b) => rank(a.data) - rank(b.data)))
        html += row(it, `${{ normal: 'N', distinguished: 'D', 'elite-boss': 'E/B' }[it.data.category] ?? ''}${it.data.band ? ' ' + it.data.band[0].toUpperCase() : ''} · ${it.data.visitors?.length ?? 0}`);
    }
  } else {
    html += `<div class="side-group label">Stage layouts</div>`;
    for (const it of all) html += row(it, `${it.data.nodes?.length ?? 0} nodes`);
  }
  const side = $('#side');
  const focused = document.activeElement?.id === 'side-search';
  const pos = focused ? document.activeElement.selectionStart : 0;
  side.innerHTML = html;
  if (focused) {
    const s = $('#side-search');
    s.focus();
    s.setSelectionRange(pos, pos);
  }
}

// ------------------------------------------------------------------ main

function drawEditor() {
  drawMain();
  drawRail();
}

function drawMain() {
  const main = $('#main');
  if (!ED) {
    main.innerHTML = `<div class="empty-main"><div><h2>${parseHash().mode === 'routes' ? 'Pick a route layout' : 'Pick an encounter'}</h2><p>…or start a new one with <b>+ New</b>.</p>
      <p class="hint">Everything saves by itself. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes, <kbd>Ctrl</kbd>+<kbd>Y</kbd> redoes.</p></div></div>`;
    return;
  }
  const scroll = [main.scrollLeft, main.scrollTop];
  main.innerHTML = `<fieldset ${ED.live ? '' : 'disabled'} style="border:0;margin:0;padding:0;min-width:0">${ED.mode === 'encounters' ? encounterMain() : routeMain()}</fieldset>`;
  [main.scrollLeft, main.scrollTop] = scroll;
  drawBanner();
}

function headActions() {
  const it = findItem(ED.mode, ED.key);
  return `<div class="ed-actions">
    <button class="icon" data-act="undo" title="Undo (Ctrl+Z)" ${ED.undo.length ? '' : 'disabled'}>↶</button>
    <button class="icon" data-act="redo" title="Redo (Ctrl+Y)" ${ED.redo.length ? '' : 'disabled'}>↷</button>
    <button class="btn sm active-toggle ${isOff(ED.draft) ? '' : 'on'}" data-act="toggle-active" role="switch" aria-checked="${!isOff(ED.draft)}" title="${isOff(ED.draft) ? `Off: kept, but ${ED.mode === 'routes' ? 'never drawn for a Stage' : 'never rolled on the route'}. Click to switch it back on.` : 'In the game. Click to switch it off.'}"><span class="knob"></span>${isOff(ED.draft) ? 'Off' : 'Active'}</button>
    <button class="btn sm" data-act="dup">Duplicate</button>
    <button class="btn sm danger" data-act="delete">${it?.pending?.op === 'add' ? 'Remove proposal' : 'Delete'}</button>
  </div>`;
}

/** The "not in the game yet" line under the header (redrawn after each save). */
function drawBanner() {
  const slot = $('#banner');
  if (!slot || !ED) return;
  const it = findItem(ED.mode, ED.key);
  const p = it?.pending;
  if (!p) return void (slot.innerHTML = '');
  const txt = { add: 'New, waiting for Claude to add it to the game.', edit: 'Edited, waiting for Claude to apply it.', delete: 'Marked for deletion.' }[p.op];
  slot.innerHTML = `<div class="banner ${p.op === 'delete' ? 'del' : ''}"><span class="tag p-${p.op}">${{ add: 'New', edit: 'Edited', delete: 'Delete' }[p.op]}</span>${txt}
    <button class="btn sm" style="margin-left:auto" data-act="discard">${p.op === 'delete' ? 'Undo delete' : p.op === 'add' ? 'Remove proposal' : 'Discard my changes'}</button></div>`;
}

// ------------------------------------------------------------------ encounter editor

const STAGES = [0, 1, 2, 3, 4, 5];
const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');

function portraitHtml(id, attrs = '') {
  const art = id && hasArt('visitors', id);
  const bg = art ? `style="background-image:url('${artUrl('visitors', id)}')"` : '';
  // The corner ⤢ (shown on hover) enlarges it; a click anywhere else keeps the portrait's own action.
  const zoom = art ? `<span class="zoom-hit" ${zoomAttrs('visitors', id, visitorDef(id)?.name)}>${ZOOM_BADGE}</span>` : '';
  return `<button type="button" class="portrait" ${bg} ${attrs}>${art ? zoom : '?'}</button>`;
}

function encounterMain() {
  const d = ED.draft;
  const t = thresholds(d);
  const total = d.visitors.reduce((s, v) => s + (Number(v.fulfillment) || 0), 0);
  const maxWave = Math.max(0, ...d.visitors.map((v) => Number(v.arriveAfterTurn) || 0));
  const waves = Array.from({ length: maxWave + 2 }, (_, w) => w);
  return `
    <div class="ed-head"><div class="grow">
      <input class="inl ed-name" data-bind="name" value="${esc(d.name)}" placeholder="Encounter name">
      <div class="ed-meta">
        <select class="chip-select" data-sel="stage">${opt(STAGES.map((s) => [s, s === 0 ? 'Tutorial' : `Stage ${s}`]), d.stage ?? 1)}</select>
        <select class="chip-select" data-sel="category">${opt(ENC_CATEGORIES.map((c) => [c, CATEGORY_LABEL[c]]), d.category)}</select>
        ${d.category === 'normal' ? `<select class="chip-select" data-sel="band">${opt(BANDS.map((b) => [b, `${cap(b)} band`]), d.band ?? 'opening')}</select>` : ''}
        <select class="chip-select" data-sel="type">${opt(ENC_TYPES.map((x) => [x, `${cap(x)} reward`]), d.type)}</select>
      </div>
      <textarea class="inl ed-purpose" data-bind="purpose" rows="1" placeholder="Design note: what this encounter is for">${esc(d.purpose ?? '')}</textarea>
    </div>${headActions()}</div>
    <div id="banner"></div>
    ${
      d.type === 'boss'
        ? `<div class="titlecard"><div><div class="label">Title</div><input class="inl" data-bind="intro.title" value="${esc(d.intro?.title ?? '')}" placeholder="The Duchess"></div>
           <div><div class="label">Epithet</div><input class="inl" data-bind="intro.epithet" value="${esc(d.intro?.epithet ?? '')}" placeholder="Twice Risen"></div>
           <div><div class="label">Their line</div><input class="inl" data-bind="intro.line" value="${esc(d.intro?.line ?? '')}" placeholder="One line in their own voice"></div></div>`
        : ''
    }
    <div class="statbar">
      <div class="stat"><b>${d.visitors.length}</b><span>Visitors</span></div>
      <div class="stat"><b>${total}</b><span>Total Need</span></div>
      <div class="stat" title="${d.stage === 2 ? 'All but the two largest Needs' : 'The three easiest visitors'}"><b>${t.survival}</b><span>Survival</span></div>
      <div class="stat" title="${d.stage === 2 ? 'All but the largest Need' : 'The four easiest visitors'}"><b>${t.strong}</b><span>Strong</span></div>
      <div class="stat" title="Everyone"><b>${t.perfect}</b><span>Perfect</span></div>
    </div>
    <div class="board">${waves.map((w) => waveHtml(d, w)).join('')}</div>`;
}

function waveHtml(d, w) {
  const cards = d.visitors.map((v, i) => [v, i]).filter(([v]) => (Number(v.arriveAfterTurn) || 0) === w);
  const need = cards.reduce((s, [v]) => s + (Number(v.fulfillment) || 0), 0);
  return `<div class="wave ${cards.length ? '' : 'empty'}" data-wave="${w}">
    <div class="wave-h"><b>${w === 0 ? 'At the open' : `After turn ${w}`}</b><span>${cards.length ? `${cards.length} · Need ${need}` : 'empty'}</span></div>
    ${cards.map(([v, i]) => visitorCard(v, i)).join('')}
    ${cards.length ? '' : `<div class="wave-drop">Drop a visitor or a portrait here</div>`}
    <button type="button" class="add-v" data-act="add-visitor" data-wave="${w}">+ Visitor</button>
  </div>`;
}

function stepper(i, field, label, v) {
  return `<div class="stepper"><button type="button" data-act="step" data-i="${i}" data-f="${field}" data-d="-1">−</button>
    <div class="mid"><input type="number" class="num" data-bind="visitors.${i}.${field}" data-num value="${v ?? 0}"><small>${label}</small></div>
    <button type="button" data-act="step" data-i="${i}" data-f="${field}" data-d="1">+</button></div>`;
}

function visitorCard(v, i) {
  const id = visitorDef(v.visitorDefId);
  const a = ability(v.abilityId);
  return `<div class="vcard ${v.headliner ? 'head' : ''}" draggable="true" data-vi="${i}">
    <div class="vtools"><button type="button" class="icon" data-act="v-dup" data-i="${i}" title="Duplicate">⧉</button><button type="button" class="icon" data-act="v-del" data-i="${i}" title="Remove">✕</button></div>
    <div class="vtop">${portraitHtml(v.visitorDefId, `data-act="pick-id" data-i="${i}" title="Change portrait"`)}
      <div class="vname"><input class="inl" data-bind="visitors.${i}.name" value="${esc(v.name ?? '')}" placeholder="${esc(id?.name ?? 'Visitor')}">
        <div class="idn">${id ? esc(id.name) : 'Random from the crowd'}</div></div></div>
    <div class="steppers">${stepper(i, 'fulfillment', 'Need', v.fulfillment)}${stepper(i, 'patience', 'Patience', v.patience)}</div>
    ${abilitySlot(v, i, a)}
    <div class="vfoot"><button type="button" class="star ${v.headliner ? 'on' : ''}" data-act="v-head" data-i="${i}" title="Headliner: if they walk out, the run ends">★</button>
      <input class="inl" data-bind="visitors.${i}.tag" value="${esc(v.tag ?? '')}" placeholder="cast tag"></div>
  </div>`;
}

/**
 * A visitor's ability, edited in place: its name and rule are fields on the
 * card. An ability can be shared, and editing it edits it for everyone using
 * it, so the card says when it is.
 */
function abilitySlot(v, i, a) {
  if (!v.abilityId) return `<button type="button" class="vab none" data-act="pick-ab" data-i="${i}" data-drop-ability="${i}">+ Ability</button>`;
  const others = abilityUsers(v.abilityId).filter((u) => !(u.mine && u.index === i));
  const id = esc(v.abilityId);
  return `<div class="vab edit" data-drop-ability="${i}">
    <div class="vab-head">
      <input class="inl ab-name" data-ab-id="${id}" data-ab-field="name" value="${esc(a?.name ?? v.abilityId)}" placeholder="Ability name">
      <button type="button" class="icon" data-act="pick-ab" data-i="${i}" title="Choose a different ability">⇄</button>
      <button type="button" class="icon" data-act="ab-clear" data-i="${i}" title="Take the ability off this visitor">✕</button>
    </div>
    <textarea class="inl ab-text" rows="1" data-ab-id="${id}" data-ab-field="text" placeholder="What it does…">${esc(a?.text ?? '')}</textarea>
    ${
      others.length
        ? `<div class="ab-shared" title="${esc(others.map((u) => `${u.encounter}: ${u.visitor}`).join('\n'))}">Shared — editing changes it for ${others.length} other visitor${others.length === 1 ? '' : 's'} too</div>`
        : ''
    }
  </div>`;
}

/** Everyone carrying an ability: this encounter from the working copy, the rest as proposed. */
function abilityUsers(id) {
  const out = [];
  for (const it of items('encounters')) {
    const mine = ED?.mode === 'encounters' && it.key === ED.key;
    const enc = mine ? ED.draft : it.data;
    enc.visitors?.forEach((v, index) => {
      if (v.abilityId === id) out.push({ mine, index, encounter: enc.name, visitor: v.name || visitorDef(v.visitorDefId)?.name || 'Visitor' });
    });
  }
  return out;
}

/** Save one field of a visitor ability to the queue (an unknown id becomes a new ability). */
async function saveAbility(id, field, value) {
  const it = findItem('abilities', id);
  const after = clone(it?.pending?.after ?? it?.orig ?? { id, name: id, text: '' });
  if ((after[field] ?? '') === value) return;
  after[field] = value;
  if (!after.name) {
    toast('An ability needs a name', true);
    return drawMain();
  }
  const op = !it || it.pending?.op === 'add' ? 'add' : 'edit';
  setSaved('Saving…');
  const ok = await commitPending(
    (q) =>
      stage(q, {
        kind: 'abilities',
        key: id,
        op,
        before: clone(it?.orig ?? null),
        after,
        note: q.edits.find((e) => e.kind === 'abilities' && e.targetId === id)?.note ?? '',
      }),
    `${op === 'add' ? 'Propose' : 'Edit'} ability ${id} (Studio)`,
  );
  if (!ok) return setSaved('Not saved: check the token or connection');
  setSaved('Saved');
  // Every other card showing this ability follows, without disturbing the field being typed in.
  for (const el of $$(`[data-ab-id="${CSS.escape(id)}"][data-ab-field="${field}"]`)) if (el !== document.activeElement) el.value = value;
  if (!$('#rail').contains(document.activeElement)) drawRail();
}

/** "+ New ability": name it and say what it does; it is proposed and given to the visitor. */
async function newAbility(i) {
  const f = await dialog(
    `<h3>New visitor ability</h3>
     <div class="field-row"><span>Name</span><input data-f="name" placeholder="e.g. Haggler"></div>
     <textarea class="note-box" data-f="text" placeholder="What it does, as the player reads it on the visitor's plate."></textarea>
     <p class="hint">Claude implements the behaviour when you sync, and asks if the wording leaves something open.</p>`,
    'Create',
  );
  if (!f) return;
  if (!f.name) return toast('An ability needs a name', true);
  const id = freshId('abilities', f.name);
  const ok = await commitPending(
    (q) => stage(q, { kind: 'abilities', key: id, op: 'add', before: null, after: { id, name: f.name, text: f.text ?? '' }, note: '' }),
    `Propose ability ${id} (Studio)`,
  );
  if (ok) setAbility(i, id);
}

/** Re-sort visitors by wave, keeping their order inside each wave. */
const byWave = (d) => {
  d.visitors = d.visitors.map((v, i) => [v, i]).sort(([a, i], [b, j]) => (Number(a.arriveAfterTurn) || 0) - (Number(b.arriveAfterTurn) || 0) || i - j).map(([v]) => v);
};

/** Put `v` into wave `w`, before the visitor now at index `before` (or at the wave's end). */
function placeVisitor(d, v, w, before) {
  v.arriveAfterTurn = w;
  if (before == null) {
    let at = d.visitors.length;
    for (let k = 0; k < d.visitors.length; k++) if ((Number(d.visitors[k].arriveAfterTurn) || 0) > w) { at = k; break; }
    d.visitors.splice(at, 0, v);
  } else d.visitors.splice(before, 0, v);
  byWave(d);
}

// ------------------------------------------------------------------ route editor

const CW = 104, CH = 78, PAD = 56, R = 25;
let GEO = null;

/** The game's own route-map medallion for a node type (cut to its ring by the exporter). */
const nodeIcon = (type) => (hasArt('nodes', type) ? artUrl('nodes', type) : null);
const iconImg = (type, size) => {
  const src = nodeIcon(type);
  return src ? `<img src="${src}" width="${size}" height="${size}" alt="" draggable="false">` : `<i style="background:${NODE_STYLE[type].c}">${NODE_STYLE[type].l}</i>`;
};

function geometry(d) {
  const lanes = d.nodes.map((n) => Number(n.lane) || 0);
  const depths = d.nodes.map((n) => Number(n.depth) || 0);
  const laneMin = Math.min(0, ...lanes) - 2;
  const laneMax = Math.max(0, ...lanes) + 2;
  const depthMax = Math.max(0, ...depths) + 2;
  return { laneMin, laneMax, depthMax, w: PAD * 2 + depthMax * CW, h: PAD * 2 + (laneMax - laneMin) * CH };
}
const px = (g, depth, lane) => [PAD + depth * CW, PAD + (lane - g.laneMin) * CH];
const cellAt = (g, x, y) => ({
  depth: Math.max(0, Math.min(g.depthMax, Math.round((x - PAD) / CW))),
  lane: Math.max(g.laneMin, Math.min(g.laneMax, Math.round((y - PAD) / CH) + g.laneMin)),
});

function routeMain() {
  const d = ED.draft;
  return `
    <div class="ed-head"><div class="grow">
      <input class="inl ed-name" data-bind="name" value="${esc(d.name)}" placeholder="Route name">
      <div class="ed-meta"><span class="tag">${d.nodes.length} nodes</span><span class="muted" style="font-size:.82rem">Every Stage currently draws one of the four layouts at random.</span></div>
    </div>${headActions()}</div>
    <div id="banner"></div>
    <div class="route-tools">
      <div class="palette">${NODE_TYPES.map((t) => `<span class="pal" draggable="true" data-node-type="${t}">${iconImg(t, 30)}${NODE_STYLE[t].name}</span>`).join('')}</div>
    </div>
    <p class="hint" style="margin:8px 0 0">Drag a type onto the grid to add a node · drag a node to move it · drag from its <b>◯</b> handle onto another node to connect · double-click empty space to add a ${NODE_STYLE[lastNodeType].name} · <kbd>Del</kbd> removes the selection</p>
    <div class="canvas-wrap" id="canvas-wrap">${canvasSvg()}</div>`;
}

function canvasSvg(dragging = null) {
  const d = ED.draft;
  const g = (GEO = dragging?.geo ?? geometry(d));
  const pos = (n) => (dragging?.key === n.key ? [dragging.x, dragging.y] : px(g, Number(n.depth) || 0, Number(n.lane) || 0));
  const byKey = Object.fromEntries(d.nodes.map((n) => [n.key, n]));
  const path = ED.hoverPath != null ? routePaths(d)[ED.hoverPath] : null;
  const onPath = path ? new Set(path.map((n) => n.key)) : null;
  const pathEdge = (a, b) => path && path.some((n, i) => n.key === a && path[i + 1]?.key === b);
  let grid = '';
  for (let x = 0; x <= g.depthMax; x++) {
    const [gx] = px(g, x, 0);
    grid += `<line class="gridline" x1="${gx}" y1="${PAD - 22}" x2="${gx}" y2="${g.h - PAD + 22}"/><text class="axis" x="${gx}" y="${PAD - 28}" text-anchor="middle">${x}</text>`;
  }
  for (let l = g.laneMin; l <= g.laneMax; l++) {
    const [, gy] = px(g, 0, l);
    grid += `<line class="gridline" x1="${PAD - 22}" y1="${gy}" x2="${g.w - PAD + 22}" y2="${gy}"/>`;
  }
  let edges = '';
  for (const n of d.nodes) {
    const [x1, y1] = pos(n);
    for (const k of n.next ?? []) {
      const m = byKey[k];
      if (!m) continue;
      const [x2, y2] = pos(m);
      const fwd = x2 > x1;
      const sx = x1 + (fwd ? R : 0), ex = x2 - (fwd ? R + 5 + (m.type === 'encounter-boss' ? 5 : 0) : 0);
      const mx = (sx + ex) / 2;
      const dd = fwd ? `M${sx} ${y1} C${mx} ${y1} ${mx} ${y2} ${ex} ${y2}` : `M${x1} ${y1} L${x2} ${y2}`;
      const sel = ED.sel?.edge && ED.sel.edge[0] === n.key && ED.sel.edge[1] === k;
      const hard = n.branch === 'hard' || m.branch === 'hard';
      edges += `<g data-edge="${esc(n.key)}|${esc(k)}"><path class="edge-hit" d="${dd}"/><path class="edge ${hard ? 'hard' : ''} ${sel ? 'sel' : ''} ${pathEdge(n.key, k) ? 'hl' : ''}" d="${dd}" marker-end="url(#arrow)"/></g>`;
    }
  }
  let nodes = '';
  for (const n of d.nodes) {
    const [x, y] = pos(n);
    const st = NODE_STYLE[n.type] ?? { c: '#888', l: '?' };
    const r = n.type === 'encounter-boss' ? R + 6 : R;
    const band = n.type === 'encounter-normal' && n.band ? n.band[0].toUpperCase() : '';
    const sel = ED.sel?.node === n.key;
    const icon = nodeIcon(n.type);
    const boss = n.type === 'encounter-boss';
    const s = r * 2 * 1.04;
    nodes += `<g class="node ${sel ? 'sel' : ''} ${onPath && !onPath.has(n.key) ? 'dim' : ''}" data-node="${esc(n.key)}" transform="translate(${x} ${y})">
      <circle class="sel-ring" r="${r + 5}"/>
      ${
        icon
          ? `${boss ? `<circle r="${r * 0.8}" fill="#3a1512"/><text class="boss-l" y="4" text-anchor="middle">BOSS</text>` : ''}<image href="${icon}" x="${-s / 2}" y="${-s / 2}" width="${s}" height="${s}"/>`
          : `<circle r="${r}" fill="${st.c}"/><text class="l" y="5" text-anchor="middle">${st.l}</text>`
      }
      <circle class="body" r="${r}"/>
      ${band ? `<g class="band" transform="translate(${r * 0.78} ${-r * 0.78})"><circle r="8.5"/><text y="3.5" text-anchor="middle">${band}</text></g>` : ''}
      <text class="k" y="${r + 16}" text-anchor="middle">${esc(n.key)}${n.branch && n.branch !== 'shared' ? ` · ${esc(n.branch)}` : ''}</text>
      <circle class="port" cx="${r + 10}" cy="0" r="6.5" data-port="${esc(n.key)}"/>
    </g>`;
  }
  return `<svg class="canvas" id="canvas" width="${g.w}" height="${g.h}" viewBox="0 0 ${g.w} ${g.h}">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#7a6a55"/></marker></defs>
    <rect class="cell" id="cell-hl" width="${CW - 8}" height="${CH - 8}" rx="12" style="display:none"/>
    ${grid}${edges}${nodes}<path class="temp" id="temp" d="" style="display:none"/></svg>`;
}

function drawCanvas(dragging = null) {
  const wrap = $('#canvas-wrap');
  if (!wrap) return;
  const [l, t] = [wrap.scrollLeft, wrap.scrollTop];
  wrap.innerHTML = canvasSvg(dragging);
  [wrap.scrollLeft, wrap.scrollTop] = [l, t];
}

function svgPoint(e) {
  const svg = $('#canvas');
  const p = svg.createSVGPoint();
  p.x = e.clientX;
  p.y = e.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}

function freshKey(d, type) {
  const base = NODE_STYLE[type].l.toLowerCase();
  let n = 1;
  while (d.nodes.some((x) => x.key === `${base}${n}`)) n++;
  return `${base}${n}`;
}

function addNode(type, cell) {
  edit((d) => {
    let { depth, lane } = cell;
    while (d.nodes.some((n) => n.depth === depth && n.lane === lane)) lane++;
    const key = freshKey(d, type);
    d.nodes.push({ key, type, ...(type === 'encounter-normal' ? { band: 'mid' } : {}), branch: 'shared', depth, lane, next: [] });
    ED.sel = { node: key };
  });
  lastNodeType = type;
}

function removeSelection() {
  if (!ED?.sel || ED.mode !== 'routes') return;
  if (ED.sel.node) {
    const k = ED.sel.node;
    edit((d) => {
      d.nodes = d.nodes.filter((n) => n.key !== k);
      for (const n of d.nodes) n.next = (n.next ?? []).filter((x) => x !== k);
    });
  } else if (ED.sel.edge) {
    const [a, b] = ED.sel.edge;
    edit((d) => {
      const n = d.nodes.find((x) => x.key === a);
      if (n) n.next = n.next.filter((x) => x !== b);
    });
  }
  ED.sel = null;
  drawEditor();
}

// ------------------------------------------------------------------ right rail

function drawRail() {
  const rail = $('#rail');
  if (!ED) {
    rail.innerHTML = `<p class="hint">Open an item to see its tools here.</p>`;
    return;
  }
  const searchFocus = document.activeElement?.dataset?.railSearch;
  const pos = searchFocus ? document.activeElement.selectionStart : 0;
  rail.innerHTML = ED.mode === 'encounters' ? encounterRail() : routeRail();
  rail.insertAdjacentHTML(
    'beforeend',
    `<section><h3>Note to Claude</h3><textarea class="note-box" data-note placeholder="Anything the fields can't say: a new ability, the intent, a question…">${esc(ED.note)}</textarea></section>`,
  );
  if (searchFocus) {
    const s = $(`[data-rail-search="${searchFocus}"]`);
    s?.focus();
    s?.setSelectionRange(pos, pos);
  }
}

const railFilter = { cast: '', abil: '' };

function encounterRail() {
  const q = railFilter.cast.toLowerCase();
  const people = S.cat.visitors.filter((v) => !q || v.name.toLowerCase().includes(q));
  const qa = railFilter.abil.toLowerCase();
  const abil = allAbilities().filter((a) => !qa || (a.name + a.text).toLowerCase().includes(qa));
  const castItem = (v) =>
    `<div class="cast-item" draggable="true" data-identity="${esc(v.id)}" title="${esc(v.name)}">${portraitHtml(v.id, 'tabindex="-1"')}<span>${esc(v.name)}</span></div>`;
  return `
    <section><h3>Cast</h3>
      <input class="search" data-rail-search="cast" placeholder="Search portraits…" value="${esc(railFilter.cast)}">
      <p class="hint">Drag onto a wave to add a visitor, or onto a portrait to recast.</p>
      <div class="cast"><div class="cast-item" draggable="true" data-identity="" title="Random from the crowd">${portraitHtml('', 'tabindex="-1"')}<span>Random</span></div>${people.filter((v) => !v.castOnly).map(castItem).join('')}</div>
      ${people.some((v) => v.castOnly) ? `<div class="label" style="margin-top:12px">Authored cast</div><div class="cast">${people.filter((v) => v.castOnly).map(castItem).join('')}</div>` : ''}
    </section>
    <section><h3>Abilities</h3>
      <input class="search" data-rail-search="abil" placeholder="Search abilities…" value="${esc(railFilter.abil)}">
      <p class="hint">Drag onto a visitor's ability slot.</p>
      ${abil.map((a) => `<div class="abil" draggable="true" data-ability="${esc(a.id)}"><b>${esc(a.name)}</b>${esc(a.text)}</div>`).join('')}
    </section>`;
}

function routeRail() {
  const d = ED.draft;
  const { errs, warns, paths } = routeChecks(d);
  const n = ED.sel?.node ? d.nodes.find((x) => x.key === ED.sel.node) : null;
  let insp = '<p class="hint">Click a node or a connection to edit it.</p>';
  if (n) {
    const incoming = d.nodes.filter((m) => (m.next ?? []).includes(n.key));
    insp = `
      <div class="insp-types">${NODE_TYPES.map((t) => `<button type="button" class="${n.type === t ? 'on' : ''}" data-act="node-type" data-type="${t}">${iconImg(t, 36)}${NODE_STYLE[t].name}</button>`).join('')}</div>
      ${n.type === 'encounter-normal' ? `<div class="field-row"><span>Band</span><div class="seg">${BANDS.map((b) => `<button type="button" class="${n.band === b ? 'on' : ''}" data-act="node-band" data-band="${b}">${cap(b)}</button>`).join('')}</div></div>` : ''}
      <div class="field-row"><span>Branch</span><input list="branch-list" data-node-field="branch" value="${esc(n.branch ?? 'shared')}"><datalist id="branch-list">${BRANCHES.map((b) => `<option value="${b}">`).join('')}</datalist></div>
      <div class="field-row"><span>Key</span><input data-node-field="key" value="${esc(n.key)}"></div>
      <div class="field-row"><span>Leads to</span><div class="links">${(n.next ?? []).map((k) => `<span>${esc(k)}<button type="button" data-act="unlink" data-a="${esc(n.key)}" data-b="${esc(k)}" title="Remove">✕</button></span>`).join('') || '<span class="muted" style="background:none">nothing</span>'}</div></div>
      <div class="field-row"><span>From</span><div class="links">${incoming.map((m) => `<span>${esc(m.key)}<button type="button" data-act="unlink" data-a="${esc(m.key)}" data-b="${esc(n.key)}" title="Remove">✕</button></span>`).join('') || '<span class="muted" style="background:none">nothing (a start)</span>'}</div></div>
      <button class="btn sm danger" data-act="del-node">Delete node</button>`;
  } else if (ED.sel?.edge) {
    insp = `<p>${esc(ED.sel.edge[0])} → ${esc(ED.sel.edge[1])}</p><button class="btn sm danger" data-act="del-edge">Remove connection</button>`;
  }
  const budget = S.cat.budgets?.early;
  const cols = ['encounter-normal', 'encounter-elite', 'event', 'reward', 'shrine', 'treasure', 'merchant'];
  const bad = (t, c) => budget && ((budget.min[t] != null && c < budget.min[t]) || (budget.max[t] != null && c > budget.max[t]));
  const table = paths.length
    ? `<table class="paths"><thead><tr><th>Path</th>${cols.map((c) => `<th title="${NODE_STYLE[c].name}">${NODE_STYLE[c].l}</th>`).join('')}</tr></thead><tbody>${paths
        .map((p, i) => {
          const branch = p.find((x) => x.branch !== 'shared')?.branch ?? 'shared';
          return `<tr data-path="${i}"><td title="${esc(p.map((x) => x.key).join(' → '))}">${i + 1}. ${esc(branch)}</td>${cols
            .map((c) => {
              const k = p.filter((x) => x.type === c).length;
              return `<td class="${bad(c, k) ? 'bad' : ''}">${k}</td>`;
            })
            .join('')}</tr>`;
        })
        .join('')}</tbody></table><p class="hint">Hover a path to trace it. Red = outside the Stage 1–2 budget for one walk.</p>`
    : '<p class="hint">No complete paths yet.</p>';
  const problems = [...errs.map((e) => `<li class="err">${esc(e)}</li>`), ...warns.map((w) => `<li class="warn">${esc(w)}</li>`)];
  return `
    <section><h3>${n ? `Node ${esc(n.key)}` : ED.sel?.edge ? 'Connection' : 'Inspector'}</h3>${insp}</section>
    <section><h3>Checks</h3><ul class="problems">${problems.join('') || '<li class="ok">One Boss, one Merchant, every path complete.</li>'}</ul></section>
    <section><h3>Paths <span class="muted" style="font:600 .8rem var(--sans)">${paths.length}</span></h3>${table}</section>`;
}

// ------------------------------------------------------------------ pickers

function popover(anchor, html, onPick) {
  const pop = $('#pop');
  pop.innerHTML = html;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  pop.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  const search = $('input', pop);
  search?.focus();
  const filter = () => {
    const q = search.value.toLowerCase();
    for (const el of $$('[data-pick]', pop)) el.hidden = q && !el.textContent.toLowerCase().includes(q);
  };
  search?.addEventListener('input', filter);
  pop.onclick = (e) => {
    const el = e.target.closest('[data-pick]');
    if (!el) return;
    closePop();
    onPick(el.dataset.pick);
  };
}
const closePop = () => {
  $('#pop').hidden = true;
  $('#pop').onclick = null;
};

function pickIdentity(anchor, i) {
  const v = ED.draft.visitors[i];
  const cell = (id, name) => `<div class="pop-item ${(v.visitorDefId ?? '') === id ? 'on' : ''}" data-pick="${esc(id)}">${portraitHtml(id, 'tabindex="-1"')}${esc(name)}</div>`;
  popover(
    anchor,
    `<input class="search" placeholder="Search portraits…"><div class="list"><div class="grid">${cell('', 'Random')}${S.cat.visitors.map((x) => cell(x.id, x.name)).join('')}</div></div>`,
    (id) => recast(i, id),
  );
}

function recast(i, id) {
  edit((d) => {
    const v = d.visitors[i];
    const oldName = visitorDef(v.visitorDefId)?.name;
    if (id) v.visitorDefId = id;
    else delete v.visitorDefId;
    if (!v.name || v.name === oldName) v.name = visitorDef(id)?.name ?? '';
  });
}

function pickAbility(anchor, i) {
  const v = ED.draft.visitors[i];
  popover(
    anchor,
    `<input class="search" placeholder="Search abilities…"><div class="list">
      <div class="pop-item new" data-pick="__new"><b>+ New ability…</b>Name it and say what it does</div>
      <div class="pop-item ${v.abilityId ? '' : 'on'}" data-pick=""><b>None</b>Need and Patience only</div>
      ${allAbilities().map((a) => `<div class="pop-item ${v.abilityId === a.id ? 'on' : ''}" data-pick="${esc(a.id)}"><b>${esc(a.name)}</b>${esc(a.text)}</div>`).join('')}</div>`,
    (id) => (id === '__new' ? newAbility(i) : setAbility(i, id)),
  );
}

function setAbility(i, id) {
  edit((d) => {
    if (id) d.visitors[i].abilityId = id;
    else delete d.visitors[i].abilityId;
  });
}

// ------------------------------------------------------------------ new / duplicate / delete / discard

async function createNew() {
  const mode = parseHash().mode;
  if (!token()) return toast('Connect a GitHub token first', true);
  const enc = mode === 'encounters';
  const f = await dialog(
    `<h3>${enc ? 'New encounter' : 'New route layout'}</h3>
     <div class="field-row"><span>Name</span><input data-f="name" placeholder="${enc ? 'e.g. Night Market' : 'e.g. The Spiral'}"></div>
     ${enc ? `<div class="field-row"><span>Stage</span><select data-f="stage">${opt(STAGES.map((s) => [s, s === 0 ? 'Tutorial' : `Stage ${s}`]), 1)}</select></div>
     <div class="field-row"><span>Category</span><select data-f="category">${opt(ENC_CATEGORIES.map((c) => [c, CATEGORY_LABEL[c]]), 'normal')}</select></div>` : ''}`,
    'Create',
  );
  if (!f) return;
  if (!f.name) return toast('A name is needed', true);
  const d = enc
    ? { name: f.name, stage: Number(f.stage), type: f.category === 'elite-boss' ? 'boss' : f.category === 'distinguished' ? 'elite' : 'normal', category: f.category, ...(f.category === 'normal' ? { band: 'opening' } : {}), visitors: [] }
    : {
        name: f.name,
        nodes: [
          { key: 'n1', type: 'encounter-normal', band: 'opening', branch: 'shared', depth: 0, lane: 0, next: ['m'] },
          { key: 'm', type: 'merchant', branch: 'shared', depth: 1, lane: 0, next: ['b'] },
          { key: 'b', type: 'encounter-boss', branch: 'shared', depth: 2, lane: 0, next: [] },
        ],
        boss: 'b',
        merchant: 'm',
      };
  d.id = freshId(mode, f.name);
  if (await commitPending((q) => stage(q, { kind: mode, key: d.id, op: 'add', before: null, after: tidy(d), note: '' }), `Propose ${mode.slice(0, -1)} ${d.id} (Studio)`)) {
    toast('Created');
    location.hash = `#/${mode}/${encodeURIComponent(d.id)}`;
  }
}

async function duplicate() {
  await flush();
  const d = clone(ED.draft);
  d.name = `${d.name} (copy)`;
  d.id = freshId(ED.mode, d.name);
  const mode = ED.mode;
  if (await commitPending((q) => stage(q, { kind: mode, key: d.id, op: 'add', before: null, after: finished({ ...ED, draft: d, orig: null }), note: '' }), `Duplicate ${ED.key} (Studio)`)) {
    toast('Copy created');
    location.hash = `#/${mode}/${encodeURIComponent(d.id)}`;
  }
}

async function removeItem() {
  await flush();
  const it = findItem(ED.mode, ED.key);
  const adding = it.pending?.op === 'add';
  const f = await dialog(
    `<h3>${adding ? 'Remove this proposal?' : `Delete ${esc(it.data.name)}?`}</h3><p class="muted">${adding ? 'It was never in the game; it simply goes.' : 'Claude will remove it from the game when applying changes.'}</p>
     ${adding ? '' : '<textarea class="note-box" data-f="note" placeholder="Why? (optional)"></textarea>'}`,
    adding ? 'Remove' : 'Mark for deletion',
    true,
  );
  if (!f) return;
  const mode = ED.mode;
  if (await commitPending((q) => stage(q, { kind: mode, key: it.key, op: 'delete', before: clone(it.orig), after: null, note: f.note ?? '' }), `Delete ${it.key} (Studio)`)) {
    ED = null;
    if (adding) location.hash = `#/${mode}`;
    else render();
  }
}

async function discard() {
  const it = findItem(ED.mode, ED.key);
  if (!it?.pending) return;
  const f = await dialog(`<h3>${it.pending.op === 'delete' ? 'Undo the delete?' : 'Discard your changes?'}</h3><p class="muted">The queued change for Claude is removed; the game version stays as it is.</p>`, 'Yes', it.pending.op !== 'delete');
  if (!f) return;
  clearTimeout(ED.timer);
  const mode = ED.mode;
  if (await commitPending((q) => (q.edits = q.edits.filter((e) => e.id !== it.pending.id)), `Discard ${it.key} (Studio)`)) {
    ED = null;
    if (it.pending.op === 'add') location.hash = `#/${mode}`;
    else render();
  }
}

// ------------------------------------------------------------------ events: typing

document.addEventListener('focusin', (e) => {
  if (e.target.dataset?.bind && ED) ED.focusSnap = clone(ED.draft);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'side-search') {
    filterText = t.value;
    return drawSide();
  }
  if (t.dataset.railSearch) {
    railFilter[t.dataset.railSearch] = t.value;
    return drawRail();
  }
  if (!ED?.live) return;
  if (t.dataset.note != null) {
    ED.note = t.value;
    return;
  }
  if (t.dataset.bind) {
    const v = t.dataset.num != null ? (t.value === '' ? 0 : Number(t.value)) : t.value;
    setPath(ED.draft, t.dataset.bind, v);
    if (t.dataset.bind.startsWith('intro.') && !ED.draft.intro) ED.draft.intro = {};
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!ED?.live) return;
  if (t.dataset.abField) return void saveAbility(t.dataset.abId, t.dataset.abField, t.value.trim());
  if (t.dataset.note != null) return changed();
  if (t.dataset.bind) {
    // One history step per finished field, not per keystroke.
    if (ED.focusSnap) {
      ED.undo.push(ED.focusSnap);
      ED.redo = [];
      ED.focusSnap = null;
    }
    changed();
    if (t.dataset.num != null || t.dataset.bind === 'name') {
      drawSide();
      if (ED.mode === 'encounters') drawMain();
    }
    return;
  }
  if (t.dataset.sel) {
    const f = t.dataset.sel;
    return edit((d) => {
      if (f === 'stage') d.stage = Number(t.value);
      else d[f] = t.value;
      if (f === 'category' && t.value === 'normal') d.band ??= 'opening';
      if (f === 'type' && t.value === 'boss') d.intro ??= {};
    });
  }
  if (t.dataset.nodeField && ED.sel?.node) {
    const k = ED.sel.node;
    const v = t.value.trim();
    if (t.dataset.nodeField === 'key') {
      if (!v || v === k) return drawRail();
      if (ED.draft.nodes.some((n) => n.key === v)) {
        toast(`There is already a node “${v}”`, true);
        return drawRail();
      }
      edit((d) => {
        for (const n of d.nodes) {
          if (n.key === k) n.key = v;
          n.next = (n.next ?? []).map((x) => (x === k ? v : x));
        }
      });
      ED.sel = { node: v };
      return drawEditor();
    }
    edit((d) => (d.nodes.find((n) => n.key === k).branch = v || 'shared'));
  }
});

// ------------------------------------------------------------------ events: clicks

document.addEventListener('click', async (e) => {
  if (!$('#pop').hidden && !e.target.closest('#pop')) closePop();
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'new') return createNew();
  if (!ED) return;
  const i = Number(b.dataset.i);
  switch (act) {
    case 'undo':
      return stepHistory('undo', 'redo');
    case 'redo':
      return stepHistory('redo', 'undo');
    case 'dup':
      return duplicate();
    case 'delete':
      return removeItem();
    case 'discard':
      return discard();
  }
  if (!ED.live) return;
  switch (act) {
    case 'toggle-active':
      // One more edit: it saves by itself and Ctrl+Z takes it back.
      return edit((d) => {
        const next = withActive(d, isOff(d));
        for (const k of Object.keys(d)) delete d[k];
        Object.assign(d, next);
      });
    case 'add-visitor':
      return edit((d) => placeVisitor(d, { arriveAfterTurn: 0, name: '', fulfillment: 5, patience: 2 }, Number(b.dataset.wave), null));
    case 'step':
      return edit((d) => {
        const v = d.visitors[i];
        v[b.dataset.f] = Math.max(b.dataset.f === 'patience' ? 1 : 0, (Number(v[b.dataset.f]) || 0) + Number(b.dataset.d));
      });
    case 'v-del':
      return edit((d) => d.visitors.splice(i, 1));
    case 'v-dup':
      return edit((d) => d.visitors.splice(i + 1, 0, clone(d.visitors[i])));
    case 'v-head':
      return edit((d) => {
        if (d.visitors[i].headliner) delete d.visitors[i].headliner;
        else d.visitors[i].headliner = true;
      });
    case 'pick-id':
      e.stopPropagation();
      return pickIdentity(b, i);
    case 'pick-ab':
      e.stopPropagation();
      return pickAbility(b, i);
    case 'ab-clear':
      return setAbility(i, '');
    case 'node-type':
      return edit((d) => {
        const n = d.nodes.find((x) => x.key === ED.sel.node);
        n.type = b.dataset.type;
        if (n.type === 'encounter-normal') n.band ??= 'mid';
        else delete n.band;
        lastNodeType = n.type;
      });
    case 'node-band':
      return edit((d) => (d.nodes.find((x) => x.key === ED.sel.node).band = b.dataset.band));
    case 'unlink':
      return edit((d) => {
        const n = d.nodes.find((x) => x.key === b.dataset.a);
        n.next = n.next.filter((x) => x !== b.dataset.b);
      });
    case 'del-node':
    case 'del-edge':
      return removeSelection();
  }
});

// ------------------------------------------------------------------ events: drag and drop (encounters, palette)

let dragKind = null;

document.addEventListener('pointerdown', (e) => {
  // A card drags by its body; its fields and buttons stay usable.
  const card = e.target.closest('.vcard');
  if (card) card.draggable = !e.target.closest('input, button, textarea, select');
});

document.addEventListener('dragstart', (e) => {
  const t = e.target;
  if (!ED?.live) return e.preventDefault();
  const set = (kind, value) => {
    dragKind = kind;
    e.dataTransfer.setData('text/plain', value);
    e.dataTransfer.effectAllowed = kind === 'visitor' ? 'move' : 'copy';
  };
  if (t.classList?.contains('vcard')) {
    set('visitor', t.dataset.vi);
    requestAnimationFrame(() => t.classList.add('dragging'));
  } else if (t.dataset?.identity != null) set('identity', t.dataset.identity);
  else if (t.dataset?.ability) set('ability', t.dataset.ability);
  else if (t.dataset?.nodeType) set('node', t.dataset.nodeType);
});

document.addEventListener('dragend', () => {
  dragKind = null;
  for (const el of $$('.dragging, .over, .drop-before')) el.classList.remove('dragging', 'over', 'drop-before');
  const hl = $('#cell-hl');
  if (hl) hl.style.display = 'none';
});

/** Where a visitor or portrait dropped on a wave lands: before the card under the pointer, or at the end. */
function dropTarget(wave, y) {
  const cards = $$('.vcard', wave).filter((c) => !c.classList.contains('dragging'));
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) return c;
  }
  return null;
}

document.addEventListener('dragover', (e) => {
  if (!dragKind) return;
  for (const el of $$('.over, .drop-before')) el.classList.remove('over', 'drop-before');
  if (dragKind === 'ability') {
    const slot = e.target.closest('[data-drop-ability]');
    if (slot) {
      e.preventDefault();
      slot.closest('.vcard').classList.add('over');
    }
    return;
  }
  if (dragKind === 'identity') {
    const p = e.target.closest('.vcard .portrait');
    if (p) {
      e.preventDefault();
      return p.closest('.vcard').classList.add('over');
    }
  }
  if (dragKind === 'visitor' || dragKind === 'identity') {
    const wave = e.target.closest('.wave');
    if (!wave) return;
    e.preventDefault();
    wave.classList.add('over');
    dropTarget(wave, e.clientY)?.classList.add('drop-before');
    return;
  }
  if (dragKind === 'node') {
    const svg = e.target.closest('#canvas');
    if (!svg) return;
    e.preventDefault();
    const p = svgPoint(e);
    const c = cellAt(GEO, p.x, p.y);
    const [x, y] = px(GEO, c.depth, c.lane);
    const hl = $('#cell-hl');
    hl.style.display = '';
    hl.setAttribute('x', x - (CW - 8) / 2);
    hl.setAttribute('y', y - (CH - 8) / 2);
  }
});

document.addEventListener('drop', (e) => {
  if (!dragKind || !ED?.live) return;
  e.preventDefault();
  const value = e.dataTransfer.getData('text/plain');
  const kind = dragKind;
  dragKind = null;
  if (kind === 'ability') {
    const slot = e.target.closest('[data-drop-ability]');
    if (slot) setAbility(Number(slot.dataset.dropAbility), value);
    return;
  }
  if (kind === 'identity' && e.target.closest('.vcard .portrait')) {
    return recast(Number(e.target.closest('.vcard').dataset.vi), value);
  }
  if (kind === 'node') {
    const p = svgPoint(e);
    return addNode(value, cellAt(GEO, p.x, p.y));
  }
  const wave = e.target.closest('.wave');
  if (!wave) return;
  const w = Number(wave.dataset.wave);
  const before = dropTarget(wave, e.clientY);
  edit((d) => {
    if (kind === 'visitor') {
      const from = Number(value);
      const v = d.visitors[from];
      const beforeV = before ? d.visitors[Number(before.dataset.vi)] : null;
      d.visitors.splice(from, 1);
      placeVisitor(d, v, w, beforeV ? d.visitors.indexOf(beforeV) : null);
    } else {
      const id = visitorDef(value);
      const nv = { arriveAfterTurn: w, name: id?.name ?? '', fulfillment: 5, patience: 2, ...(value ? { visitorDefId: value } : {}) };
      placeVisitor(d, nv, w, before ? Number(before.dataset.vi) : null);
    }
  });
});

// ------------------------------------------------------------------ events: route canvas (pointer)

let drag = null;

document.addEventListener('pointerdown', (e) => {
  const svg = e.target.closest?.('#canvas');
  if (!svg || !ED || ED.mode !== 'routes' || e.button !== 0) return;
  const port = e.target.closest('[data-port]');
  const node = e.target.closest('[data-node]');
  const edge = e.target.closest('[data-edge]');
  const p = svgPoint(e);
  if (port && ED.live) {
    e.preventDefault();
    const from = ED.draft.nodes.find((n) => n.key === port.dataset.port);
    drag = { kind: 'link', from: from.key, start: px(GEO, from.depth, from.lane) };
  } else if (node) {
    e.preventDefault();
    ED.sel = { node: node.dataset.node };
    const n = ED.draft.nodes.find((x) => x.key === node.dataset.node);
    drag = { kind: 'move', key: n.key, geo: GEO, ox: p.x, oy: p.y, start: px(GEO, n.depth, n.lane), moved: false };
    drawRail();
    drawCanvas();
  } else if (edge) {
    ED.sel = { edge: edge.dataset.edge.split('|') };
    drawRail();
    drawCanvas();
  } else {
    ED.sel = null;
    drawRail();
    drawCanvas();
  }
});

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = svgPoint(e);
  if (drag.kind === 'link') {
    const [x, y] = drag.start;
    const t = $('#temp');
    t.style.display = '';
    t.setAttribute('d', `M${x + R} ${y} L${p.x} ${p.y}`);
  } else if (drag.kind === 'move' && ED.live) {
    if (!drag.moved && Math.hypot(p.x - drag.ox, p.y - drag.oy) < 4) return;
    drag.moved = true;
    drawCanvas({ key: drag.key, geo: drag.geo, x: drag.start[0] + p.x - drag.ox, y: drag.start[1] + p.y - drag.oy });
  }
});

document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d0 = drag;
  drag = null;
  if (d0.kind === 'link') {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-node]');
    const to = el?.dataset.node;
    if (to && to !== d0.from && !ED.draft.nodes.find((n) => n.key === d0.from).next?.includes(to)) {
      edit((d) => d.nodes.find((n) => n.key === d0.from).next.push(to));
    } else drawCanvas();
    return;
  }
  if (d0.kind === 'move' && d0.moved && ED.live) {
    const p = svgPoint(e);
    const c = cellAt(d0.geo, d0.start[0] + p.x - d0.ox, d0.start[1] + p.y - d0.oy);
    edit((d) => {
      const n = d.nodes.find((x) => x.key === d0.key);
      const other = d.nodes.find((x) => x !== n && x.depth === c.depth && x.lane === c.lane);
      // Dropping onto a taken cell swaps the two nodes.
      if (other) [other.depth, other.lane] = [n.depth, n.lane];
      n.depth = c.depth;
      n.lane = c.lane;
    });
  }
});

document.addEventListener('dblclick', (e) => {
  const svg = e.target.closest?.('#canvas');
  if (!svg || !ED?.live || e.target.closest('[data-node], [data-edge]')) return;
  const p = svgPoint(e);
  addNode(lastNodeType, cellAt(GEO, p.x, p.y));
});

document.addEventListener('mouseover', (e) => {
  const row = e.target.closest?.('tr[data-path]');
  const v = row ? Number(row.dataset.path) : null;
  if (!ED || ED.mode !== 'routes' || v === ED.hoverPath) return;
  ED.hoverPath = v;
  drawCanvas();
});

// ------------------------------------------------------------------ keys

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select');
  if (e.key === 'Escape') closePop();
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    stepHistory('undo', 'redo');
  } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    stepHistory('redo', 'undo');
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && ED?.mode === 'routes' && ED.sel) {
    e.preventDefault();
    removeSelection();
  }
});

// ------------------------------------------------------------------ lifecycle

$('#token-save').addEventListener('click', async () => {
  LS.set('token', $('#token-in').value.trim());
  await refreshPending();
  if (token() && !S.pendingError) toast('Connected');
  render();
});

window.addEventListener('hashchange', () => {
  flush();
  closePop();
  render();
});

window.addEventListener('beforeunload', (e) => {
  if (ED?.dirty || ED?.busy) {
    flush();
    e.preventDefault();
  }
});

// Pick up Claude's applied changes when coming back to the tab.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') return void flush();
  if (ED?.dirty || ED?.busy) return;
  await loadCatalogue().catch(() => {});
  await refreshPending({ quiet: true });
  render();
});

setInterval(() => {
  if (ED?.savedAt && !ED.dirty && !ED.busy) setSaved(`Saved ${ago(ED.savedAt)}`);
}, 30000);

(async function boot() {
  try {
    await loadCatalogue();
  } catch (e) {
    $('#main').innerHTML = `<div class="empty-main">Could not load the catalogue: ${esc(e.message)}</div>`;
    return;
  }
  render();
  await refreshPending({ quiet: true });
  render();
})();
