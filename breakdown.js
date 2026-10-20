// The archetype breakdown (2026-10-21): per Trait, per archetype, per rarity.
// Shared by the phone catalogue (#/archetypes) and the PC Studio (#/archetypes).
// Reads the books as proposed (queued edits included) and counts only books
// that can turn up in a run: switched-off books and tokens are left out.

import { S, items, isOff, esc, traitName } from './store.js';

/** The Traits shown for now (user, 2026-10-21: Magic and Monsters only). */
const TRAITS = ['magic', 'monsters'];
const RARITIES = ['common', 'uncommon', 'rare'];
const RARITY_NAME = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare' };

const inPools = (b) =>
  !isOff(b) && (b.copies ?? 1) > 0 && !(b.flags ?? []).some((f) => f === 'token' || f === 'summon-only' || f === 'tutorial-only');

function archetypeList() {
  return [...(S.cat.archetypes ?? []).map((a) => ({ id: a.id, name: a.name, traits: a.traits ?? {} })), { id: 'untagged', name: 'Untagged', traits: {} }];
}

const tagsOf = (b) => ((b.archetypes ?? []).length ? b.archetypes : ['untagged']);

/**
 * The whole page. `bookHref(id)` links a title to the book: its own page on
 * the phone, the phone catalogue in a new tab from the Studio.
 */
export function breakdownHtml({ bookHref, newTab = false }) {
  const books = items('books').map((x) => x.data).filter(inPools);
  const arcs = archetypeList();
  const of = (trait) => books.filter((b) => (b.traits ?? []).includes(trait));
  const link = (b) =>
    `<a class="bd-book ${esc(b.rarity)}" href="${esc(bookHref(b.id))}"${newTab ? ' target="_blank" rel="noopener"' : ''}>${esc(b.title)}${b.onDisplay ? ' <i>OD</i>' : ''}</a>`;

  // Magic + Monsters together: archetype x Trait, with its share of the pool.
  const pool = TRAITS.flatMap(of);
  const poolSize = pool.length;
  const summaryRows = arcs
    .map((a) => {
      const per = TRAITS.map((t) => of(t).filter((b) => tagsOf(b).includes(a.id)).length);
      const total = pool.filter((b) => tagsOf(b).includes(a.id)).length;
      if (!total) return '';
      const homes = TRAITS.map((t) => (a.traits[t] ? `<small class="bd-size">${esc(a.traits[t])}</small>` : '')).map((s, i) => `<td>${per[i] || '–'} ${s}</td>`).join('');
      return `<tr class="${a.id === 'untagged' ? 'bd-muted' : ''}"><th><span class="bd-dot arch-${esc(a.id)}"></span>${esc(a.name)}</th>${homes}<td><b>${total}</b></td><td>${Math.round((100 * total) / Math.max(1, poolSize))}%</td></tr>`;
    })
    .join('');
  const rarityTotals = RARITIES.map((r) => `<td>${TRAITS.map((t) => of(t).filter((b) => b.rarity === r).length).join(' + ')}</td>`).join('');

  const summary = `<section class="bd-card">
    <h2>Magic + Monsters <small>${poolSize} books in a run's pool</small></h2>
    <div class="bd-scroll"><table class="bd-table">
      <thead><tr><th>Archetype</th>${TRAITS.map((t) => `<th>${esc(traitName(t))}</th>`).join('')}<th>Total</th><th>Share</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table></div>
    <div class="bd-scroll"><table class="bd-table bd-rar">
      <thead><tr><th>Rarity</th>${RARITIES.map((r) => `<th class="${r}">${RARITY_NAME[r]}</th>`).join('')}</tr></thead>
      <tbody><tr><th>${TRAITS.map((t) => esc(traitName(t))).join(' + ')}</th>${rarityTotals}</tr></tbody>
    </table></div>
    <p class="bd-note">A book tagged with two archetypes counts in both. Switched-off books and tokens are left out.</p>
  </section>`;

  const traitCol = (t) => {
    const list = of(t);
    const counts = RARITIES.map((r) => `<span class="bd-count ${r}">${RARITY_NAME[r]} <b>${list.filter((b) => b.rarity === r).length}</b></span>`).join('');
    const blocks = arcs
      .map((a) => {
        const mine = list.filter((b) => tagsOf(b).includes(a.id));
        if (!mine.length) return '';
        const size = a.traits[t] ? `<small class="bd-size">${esc(a.traits[t])}</small>` : a.id === 'untagged' ? '' : '<small class="bd-size bridge">bridge</small>';
        const rows = RARITIES.map((r) => {
          const xs = mine.filter((b) => b.rarity === r).sort((x, y) => x.title.localeCompare(y.title));
          return `<div class="bd-row"><span class="bd-r ${r}">${RARITY_NAME[r]} <b>${xs.length}</b></span><span class="bd-books">${xs.map(link).join('') || '<span class="bd-none">—</span>'}</span></div>`;
        }).join('');
        return `<div class="bd-arch ${a.id === 'untagged' ? 'bd-muted' : ''}"><h3><span class="bd-dot arch-${esc(a.id)}"></span>${esc(a.name)} <b>${mine.length}</b> ${size}</h3>${rows}</div>`;
      })
      .join('');
    return `<section class="bd-card bd-trait"><h2>${esc(traitName(t))} <small>${list.length} books</small></h2><div class="bd-counts">${counts}</div>${blocks}</section>`;
  };

  return `<div class="bd">${summary}<div class="bd-traits">${TRAITS.map(traitCol).join('')}</div></div>`;
}
