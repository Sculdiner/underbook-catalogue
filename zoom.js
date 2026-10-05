/**
 * The enlarge view, shared by the phone catalogue and the Studio
 * (catalogue/README.md): any element carrying zoomAttrs() opens its image
 * full-screen on click, Enter or Space. The thumbnail shows at once and is
 * swapped for the large cut (art/<kind>-lg/) once that has loaded. A click,
 * the ✕, Escape or Back closes it.
 */

import { artLargeUrl, artUrl, esc } from './store.js';

export const ZOOM_BADGE = `<span class="zoom-badge" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

/** Marks an element as opening an image in the enlarge view. */
export const zoomAttrs = (kind, id, title) =>
  `data-zoom="${esc(kind)}" data-zoom-id="${esc(id)}" data-zoom-title="${esc(title ?? '')}" role="button" tabindex="0" aria-label="Enlarge" title="Enlarge"`;

const current = () => document.getElementById('zoom');

export function openZoom(kind, id, title) {
  closeZoom(true);
  const z = document.createElement('div');
  z.className = 'zoom';
  z.id = 'zoom';
  z.setAttribute('role', 'dialog');
  z.setAttribute('aria-modal', 'true');
  z.innerHTML = `<button type="button" class="zoom-close" aria-label="Close"><svg viewBox="0 0 24 24" width="24" height="24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>
    <div class="zoom-frame ${kind}"><img class="zoom-img" src="${artUrl(kind, id)}" alt="${esc(title ?? '')}"></div>
    ${title ? `<div class="zoom-title">${esc(title)}</div>` : ''}`;
  document.body.append(z);
  const big = artLargeUrl(kind, id);
  if (big !== artUrl(kind, id)) {
    const pre = new Image();
    pre.onload = () => {
      const img = z.querySelector('.zoom-img');
      if (img) img.src = big;
    };
    pre.src = big;
  }
  z.addEventListener('click', () => closeZoom());
  // Back closes the view instead of leaving the page.
  history.pushState({ zoom: true }, '');
  requestAnimationFrame(() => z.classList.add('on'));
  z.querySelector('.zoom-close').focus({ preventScroll: true });
}

/** Close the enlarge view; `quiet` skips the history step (Back already took it). */
export function closeZoom(quiet = false) {
  const z = current();
  if (!z) return;
  z.remove();
  if (!quiet && history.state?.zoom) history.back();
}

window.addEventListener('popstate', () => closeZoom(true));

// Capture, so neither a click on an enlargeable image nor a key pressed while
// the view is open reaches the page's own handlers beneath it.
document.addEventListener(
  'keydown',
  (e) => {
    if (current()) {
      if (e.key === 'Escape') closeZoom();
      if (e.key !== 'Tab') {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    const t = e.target.closest?.('[data-zoom]');
    if (t && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      e.stopPropagation();
      openZoom(t.dataset.zoom, t.dataset.zoomId, t.dataset.zoomTitle);
    }
  },
  true,
);
for (const type of ['click', 'mousedown', 'pointerdown']) {
  document.addEventListener(
    type,
    (e) => {
      const t = e.target.closest?.('[data-zoom]');
      if (!t) return;
      e.stopPropagation();
      if (type !== 'click') return;
      e.preventDefault();
      openZoom(t.dataset.zoom, t.dataset.zoomId, t.dataset.zoomTitle);
    },
    true,
  );
}
