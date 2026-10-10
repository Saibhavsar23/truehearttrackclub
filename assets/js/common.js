const NY = 'America/New_York';

export const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);

/** e.g. "Sat, Mar 8, 9:30 AM EST": always New York time, DST-correct, regardless of the visitor's own time zone. */
export function fmtNY(ms, { year = false } = {}) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY, weekday: 'short', month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(ms));
}

/** Millis -> "YYYY-MM-DDTHH:mm" in New York (the format admin <input type=datetime-local> uses). */
export function toNyLocalInput(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: NY, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Tiny hyperscript helper. Text is always inserted as text nodes, never as HTML. */
export function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function clear(node) { node.replaceChildren(); return node; }

let liveEl;
/** Screen-reader announcement (polite). */
export function announce(msg) {
  liveEl ??= (() => { const e = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' }); document.body.append(e); return e; })();
  liveEl.textContent = '';
  setTimeout(() => { liveEl.textContent = msg; }, 30);
}

let toastTimer;
export function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3500);
  announce(msg);
}

export const icon = {
  bag: () => svg('M6 8h12l1 12H5L6 8zM9 8V6a3 3 0 0 1 6 0v2'),
  close: () => svg('M5 5l14 14M19 5L5 19'),
  shirt: () => svg('M8 4l-5 3 2 4 3-1v10h8V10l3 1 2-4-5-3a4 4 0 0 1-8 0z'),
};
function svg(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.append(p);
  return s;
}
