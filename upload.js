/**
 * Upload your own image (catalogue/README.md): pick a file from the phone,
 * then frame it — drag to move, pinch / wheel / the slider to scale — inside
 * the shape the game draws it in. Resolves to a PNG blob of exactly the
 * requested size, or null when cancelled. Areas the image does not cover stay
 * transparent. Saving the blob is the caller's job (`uploadImage` in store.js).
 */

import { esc } from './store.js';

/** Open the file chooser. Call straight from a click, so the browser allows it. */
export function chooseFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not an image this browser can open'));
    };
    img.src = url;
  });
}

/** A huge photo halved step by step to near `limit`, so the final scale-down stays smooth. */
function prescale(img, limit) {
  let src = img;
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  while (Math.max(w, h) > limit * 2) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);
    src = c;
  }
  return { src, w, h };
}

/**
 * Pick a file and frame it.
 * @param {{ title: string, size: [number, number], shape?: string }} o
 *   size: the output in pixels; shape: a class for the frame ('icon' | 'cover').
 */
export async function uploadAndFrame({ title, size, shape = 'icon' }) {
  const file = await chooseFile();
  if (!file) return null;
  const img = await loadImage(file);
  return frame(img, { title, size, shape });
}

function frame(img, { title, size: [W, H], shape }) {
  const { src, w: iw, h: ih } = prescale(img, Math.max(W, H));
  const kFit = Math.min(W / iw, H / ih);
  const kFill = Math.max(W / iw, H / ih);
  const kMin = kFit * 0.2;
  const kMax = kFill * 5;
  const v = { k: kFill, x: (W - iw * kFill) / 2, y: (H - ih * kFill) / 2 };

  const el = document.createElement('div');
  el.className = 'framer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `<div class="framer-sheet">
      <h3>${esc(title)}</h3>
      <div class="framer-stage ${esc(shape)}" style="aspect-ratio:${W} / ${H}"><canvas width="${W}" height="${H}"></canvas></div>
      <div class="framer-size">
        <button type="button" class="framer-step" data-step="-1" aria-label="Smaller">−</button>
        <input type="range" min="${Math.round(100 * Math.log(kMin / kFit))}" max="${Math.round(100 * Math.log(kMax / kFit))}" step="1" aria-label="Size">
        <button type="button" class="framer-step" data-step="1" aria-label="Larger">+</button>
      </div>
      <div class="framer-fits">
        <button type="button" class="chip" data-fit="fit">Whole image</button>
        <button type="button" class="chip" data-fit="fill">Fill the frame</button>
      </div>
      <p class="framer-hint">Drag to move. Pinch or slide to scale.</p>
      <div class="framer-row"><button type="button" class="btn ghost" data-r="0">Cancel</button><button type="button" class="btn primary" data-r="1">Use this</button></div>
    </div>`;
  document.body.append(el);
  const canvas = el.querySelector('canvas');
  const g = canvas.getContext('2d');
  const range = el.querySelector('input[type=range]');

  const draw = () => {
    g.clearRect(0, 0, W, H);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, v.x, v.y, iw * v.k, ih * v.k);
    range.value = String(Math.round(100 * Math.log(v.k / kFit)));
  };
  // At least a tenth of the image stays inside the frame, so it can't be lost off the edge.
  const clampPos = () => {
    v.x = Math.min(W * 0.9, Math.max(W * 0.1 - iw * v.k, v.x));
    v.y = Math.min(H * 0.9, Math.max(H * 0.1 - ih * v.k, v.y));
  };
  const zoomAt = (px, py, k) => {
    k = Math.min(kMax, Math.max(kMin, k));
    v.x = px - ((px - v.x) * k) / v.k;
    v.y = py - ((py - v.y) * k) / v.k;
    v.k = k;
    clampPos();
    draw();
  };
  const set = (k) => {
    v.k = k;
    v.x = (W - iw * k) / 2;
    v.y = (H - ih * k) / 2;
    draw();
  };
  /** A screen point in output pixels. */
  const toOut = (cx, cy) => {
    const r = canvas.getBoundingClientRect();
    return [((cx - r.left) * W) / r.width, ((cy - r.top) * H) / r.height];
  };

  const pts = new Map();
  canvas.addEventListener('pointerdown', (e) => {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks: it just won't be captured */
    }
    pts.set(e.pointerId, [e.clientX, e.clientY]);
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pts.get(e.pointerId);
    if (!prev) return;
    const cur = [e.clientX, e.clientY];
    const scale = W / canvas.getBoundingClientRect().width;
    if (pts.size === 1) {
      v.x += (cur[0] - prev[0]) * scale;
      v.y += (cur[1] - prev[1]) * scale;
      clampPos();
      draw();
    } else if (pts.size === 2) {
      const other = [...pts].find(([id]) => id !== e.pointerId)[1];
      const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
      const d1 = Math.hypot(cur[0] - other[0], cur[1] - other[1]);
      // The midpoint moves by half of this finger's move: pan by that, then scale around it.
      v.x += ((cur[0] - prev[0]) * scale) / 2;
      v.y += ((cur[1] - prev[1]) * scale) / 2;
      const [mx, my] = toOut((cur[0] + other[0]) / 2, (cur[1] + other[1]) / 2);
      if (d0 > 0) zoomAt(mx, my, (v.k * d1) / d0);
    }
    pts.set(e.pointerId, cur);
  });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(t, (e) => pts.delete(e.pointerId));
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const [px, py] = toOut(e.clientX, e.clientY);
      zoomAt(px, py, v.k * Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );
  range.addEventListener('input', () => zoomAt(W / 2, H / 2, kFit * Math.exp(Number(range.value) / 100)));

  draw();
  requestAnimationFrame(() => el.classList.add('on'));

  return new Promise((resolve) => {
    const done = (blob) => {
      el.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(blob);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const step = e.target.closest('[data-step]');
      if (step) return zoomAt(W / 2, H / 2, v.k * Math.exp(0.1 * Number(step.dataset.step)));
      const fit = e.target.closest('[data-fit]');
      if (fit) return set(fit.dataset.fit === 'fit' ? kFit : kFill);
      const r = e.target.closest('[data-r]');
      if (!r) return;
      if (r.dataset.r !== '1') return done(null);
      draw();
      canvas.toBlob((b) => done(b), 'image/png');
    });
  });
}
