/* Anonymous persistent cart (localStorage, with an in-memory fallback if storage is blocked).
   Lines store display data only. The server re-reads product, price, variant and stock on every order. */
const KEY = 'thtc_cart_v1';
export const MAX_LINE_QTY = 10;

let memory = { v: 1, items: [] };
const listeners = new Set();

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return memory;
    const c = JSON.parse(raw);
    if (!c || !Array.isArray(c.items)) return { v: 1, items: [] };
    c.items = c.items.filter((i) => i && typeof i.productId === 'string' && typeof i.variantId === 'string' && Number.isInteger(i.qty) && i.qty > 0)
      .map((i) => ({ ...i, qty: Math.min(i.qty, MAX_LINE_QTY) }));
    return c;
  } catch (_) { return memory; }
}
function write(c) {
  memory = c;
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (_) { /* storage blocked: keep in memory */ }
  listeners.forEach((fn) => fn(c));
}

export const getCart = () => read();
export const cartCount = (c = read()) => c.items.reduce((n, i) => n + i.qty, 0);
export const cartSubtotal = (c = read()) => c.items.reduce((n, i) => n + i.qty * i.priceCents, 0);
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
addEventListener('storage', (e) => { if (e.key === KEY) listeners.forEach((fn) => fn(read())); });

export function addItem(line) {
  const c = read();
  const ex = c.items.find((i) => i.productId === line.productId && i.variantId === line.variantId);
  if (ex) { ex.qty = Math.min(MAX_LINE_QTY, ex.qty + line.qty); Object.assign(ex, { name: line.name, size: line.size, color: line.color, priceCents: line.priceCents, image: line.image }); }
  else c.items.push({ ...line, qty: Math.min(MAX_LINE_QTY, line.qty) });
  write(c);
}
export function setQty(productId, variantId, qty) {
  const c = read();
  const ex = c.items.find((i) => i.productId === productId && i.variantId === variantId);
  if (!ex) return;
  if (qty <= 0) c.items = c.items.filter((i) => i !== ex); else ex.qty = Math.min(MAX_LINE_QTY, qty);
  write(c);
}
export const removeItem = (p, v) => setQty(p, v, 0);
export function updateSnapshot(productId, variantId, patch) {
  const c = read();
  const ex = c.items.find((i) => i.productId === productId && i.variantId === variantId);
  if (ex) { Object.assign(ex, patch); write(c); }
}
export function clearCart() { write({ v: 1, items: [] }); }
export function qtyInCart(productId, variantId) {
  return read().items.find((i) => i.productId === productId && i.variantId === variantId)?.qty || 0;
}

/* Idempotency key: stable for an unchanged cart so a retry or double-click can never create two orders;
   regenerated when the cart contents change. */
function sig(c) { return c.items.map((i) => `${i.productId}/${i.variantId}/${i.qty}`).sort().join('|'); }
function newKey() {
  const a = new Uint8Array(18); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function checkoutKey() {
  const c = read();
  if (!c.checkout || c.checkout.sig !== sig(c)) { c.checkout = { sig: sig(c), key: newKey() }; write(c); }
  return c.checkout.key;
}
