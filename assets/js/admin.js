import { loadAdmin, callable, isConfigured } from './firebase.js';
import { money, fmtNY, toNyLocalInput, h, $, clear, toast, icon } from './common.js';

/* Everything here is a convenience UI. Authorization is enforced by Firestore/Storage rules (reads) and by the
   Cloud Functions (every write re-verifies the admin claim server-side). */

const app = $('#app');
const STATUS_NEXT = { submitted: ['confirmed', 'cancelled'], confirmed: ['preparing', 'ready', 'fulfilled', 'cancelled'], preparing: ['ready', 'fulfilled', 'cancelled'], ready: ['fulfilled', 'cancelled'], fulfilled: [], cancelled: [] };
const STATUS_LABEL = { submitted: 'Submitted', confirmed: 'Confirmed', preparing: 'Preparing', ready: 'Ready', fulfilled: 'Fulfilled', cancelled: 'Cancelled' };
const PAY_LABEL = { cash: 'Cash', venmo: 'Venmo', zelle: 'Zelle' };
const ACTION_LABEL = { confirmed: 'Confirm order', preparing: 'Mark preparing', ready: 'Mark ready', fulfilled: 'Mark fulfilled', cancelled: 'Cancel order' };

let F;                      // firebase handles
const cache = { products: null };
let tab = 'overview';
let user = null;

const tag = (cls, text) => h('span', { class: `tag tag--${cls}` }, text);
const ms = (ts) => (ts && ts.toMillis ? ts.toMillis() : null);

function fail(e) {
  const m = String(e && e.message || e);
  toast(m || 'Something went wrong.');
  console.error(e);
}
async function guarded(btn, fn) {
  if (btn.getAttribute('aria-busy') === 'true') return;   // ignore double clicks while the first is still running
  btn.setAttribute('aria-busy', 'true'); btn.setAttribute('aria-disabled', 'true');
  try { return await fn(); } catch (e) { fail(e); } finally { btn.removeAttribute('aria-busy'); btn.removeAttribute('aria-disabled'); }
}

/* ============================== auth ============================== */

async function boot() {
  if (!isConfigured) {
    clear(app).append(h('div', { class: 'login' }, h('h1', {}, 'Admin'), h('p', { class: 'lede' }, 'Firebase is not configured yet. Fill in assets/js/firebase-config.js (see README), or open this page on localhost with ?emulator=1.')));
    return;
  }
  try { F = await loadAdmin(); } catch (e) { clear(app).append(h('div', { class: 'login' }, h('h1', {}, 'Admin'), h('p', { class: 'notice notice--error' }, 'Could not load Firebase: ' + e.message))); return; }
  F.au.onAuthStateChanged(F.auth, async (u) => {
    user = u;
    if (!u) return renderLogin();
    let tok;
    try { tok = await u.getIdTokenResult(true); } // force refresh so a newly granted claim is picked up
    catch (e) { clear(app).append(h('div', { class: 'login' }, h('h1', {}, 'Admin'), h('p', { class: 'notice notice--error', role: 'alert' }, 'Could not verify your account. Check your connection and reload. ' + (e.message || '')), h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => location.reload() }, 'Reload'))); return; }
    if (tok.claims.admin !== true) return renderDenied();
    renderShell();
  });
}

function renderLogin(message) {
  const email = h('input', { type: 'email', id: 'l-email', autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', id: 'l-pass', autocomplete: 'current-password', required: true });
  const err = h('p', { class: 'err', role: 'alert' }, message || '');
  const btn = h('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Sign in');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    await guarded(btn, async () => {
      try { await F.au.signInWithEmailAndPassword(F.auth, email.value.trim(), pass.value); }
      catch (ex) { err.textContent = 'Sign-in failed. Check your email and password.'; }
    });
  } },
  h('div', { class: 'field' }, h('label', { for: 'l-email' }, 'Email'), email),
  h('div', { class: 'field' }, h('label', { for: 'l-pass' }, 'Password'), pass), err, btn,
  h('button', { class: 'linkbtn', type: 'button', style: 'margin-top:.8rem', onclick: async () => {
    err.textContent = '';
    if (!email.value.trim()) { err.textContent = 'Type your email above first, then press Forgot password.'; email.focus(); return; }
    try { await F.au.sendPasswordResetEmail(F.auth, email.value.trim()); } catch (_) { /* do not reveal whether the account exists */ }
    toast('If that account exists, a password reset email is on its way.');
  } }, 'Forgot password?'));
  clear(app).append(h('div', { class: 'login' }, h('h1', {}, 'Admin sign-in'), h('p', { class: 'fine', style: 'margin-bottom:1.2rem' }, 'True Heart store dashboard. Administrator accounts are created by the site owner.'), form));
  email.focus();
}

function renderDenied() {
  clear(app).append(h('div', { class: 'login' }, h('h1', {}, 'No access'), h('p', { class: 'lede', style: 'margin:.6rem 0 1.2rem' }, `${user.email} is signed in but is not an administrator. Ask the site owner to grant access, then sign in again.`), h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => F.au.signOut(F.auth) }, 'Sign out')));
}

/* ============================== shell ============================== */

const TABS = [['overview', 'Overview'], ['orders', 'Orders'], ['products', 'Products'], ['schedules', 'Schedules'], ['settings', 'Settings']];
let panel;

function renderShell() {
  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Dashboard sections' }, TABS.map(([id, label]) => h('button', {
    role: 'tab', id: `tab-${id}`, 'aria-selected': String(id === tab), 'aria-controls': 'panel', tabindex: id === tab ? '0' : '-1',
    onclick: () => go(id),
    onkeydown: (e) => {
      const i = TABS.findIndex(([x]) => x === tab);
      if (e.key === 'ArrowRight') go(TABS[(i + 1) % TABS.length][0], true);
      if (e.key === 'ArrowLeft') go(TABS[(i + TABS.length - 1) % TABS.length][0], true);
    },
  }, label)));
  panel = h('div', { id: 'panel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` });
  clear(app).append(h('div', { class: 'adm-wrap' },
    h('div', { class: 'adm-top' }, h('h1', {}, 'Store dashboard'), h('div', { class: 'adm-who' }, h('span', {}, user.email), h('a', { class: 'linkbtn', href: '/shop/' }, 'View shop'), h('button', { class: 'linkbtn', type: 'button', onclick: () => F.au.signOut(F.auth) }, 'Sign out'))),
    tablist, panel));
  go(location.hash.startsWith('#order=') ? 'orders' : tab, false, true);
}

function go(id, focus, initial) {
  tab = id;
  $$tabs().forEach((b) => { const on = b.id === `tab-${id}`; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
  // each navigation gets a fresh panel: a slow view that finishes late writes into a detached node instead of the current tab
  const fresh = h('div', { id: 'panel', role: 'tabpanel', 'aria-labelledby': `tab-${id}` }, h('p', { class: 'empty' }, 'Loading...'));
  panel.replaceWith(fresh); panel = fresh;
  const mine = panel;
  const view = { overview: viewOverview, orders: viewOrders, products: viewProducts, schedules: viewSchedules, settings: viewSettings }[id];
  view().catch((e) => { clear(mine).append(h('div', { class: 'notice notice--error', role: 'alert' }, 'Could not load this section: ' + e.message)); console.error(e); });
}
const $$tabs = () => [...document.querySelectorAll('.tabs [role=tab]')];

/* ============================== data ============================== */

async function loadProducts(force) {
  if (cache.products && !force) return cache.products;
  const { db, fs } = F;
  const snap = await fs.getDocs(fs.collection(db, 'products'));
  cache.products = await Promise.all(snap.docs.map(async (d) => {
    const vs = await fs.getDocs(fs.collection(db, 'products', d.id, 'variants'));
    return { id: d.id, ...d.data(), variants: vs.docs.map((v) => ({ id: v.id, ...v.data() })) };
  }));
  cache.products.sort((a, b) => (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0));
  return cache.products;
}

/* ============================== overview ============================== */

async function viewOverview() {
  const { db, fs } = F; const out = panel;
  const [status, products, recent, scheds, all, failedSnap] = await Promise.all([
    callable('getStoreStatus', {}), loadProducts(true),
    fs.getDocs(fs.query(fs.collection(db, 'orders'), fs.orderBy('createdAt', 'desc'), fs.limit(8))),
    fs.getDocs(fs.collection(db, 'storeSchedules')),
    fs.getDocs(fs.query(fs.collection(db, 'orders'), fs.orderBy('createdAt', 'desc'), fs.limit(1000))),
    fs.getDocs(fs.query(fs.collection(db, 'mail'), fs.where('status', '==', 'failed'), fs.limit(20))),
  ]);

  // ---- numbers (every order that is not cancelled counts as a sale; "paid" is what you recorded by hand) ----
  const orders = all.docs.map(snapOrder);
  const live = orders.filter((o) => o.status !== 'cancelled');
  const sum = (arr, f) => arr.reduce((n, x) => n + f(x), 0);
  const unitsOf = (o) => sum(o.items || [], (i) => i.quantity);
  const units = sum(live, unitsOf);
  const revenue = sum(live, (o) => o.subtotalCents);
  const paidOrders = live.filter((o) => o.paid === true);
  const unpaidOrders = live.filter((o) => o.paid !== true);
  const collected = sum(paidOrders, (o) => o.subtotalCents);
  const awaitingAction = live.filter((o) => o.status === 'submitted').length;
  const failedMail = failedSnap.size;
  const customers = new Set(live.map((o) => String(o.customerEmail || '').toLowerCase())).size;
  const times = live.map((o) => o.createdAtMillis).filter(Boolean);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '0%');

  const byStatus = Object.keys(STATUS_LABEL).map((s) => {
    const list = orders.filter((o) => o.status === s);
    return [tag(s, STATUS_LABEL[s]), String(list.length), s === 'cancelled' ? '-' : String(list.filter((o) => o.paid === true).length), s === 'cancelled' ? '-' : String(list.filter((o) => o.paid !== true).length), money(sum(list, (o) => o.subtotalCents))];
  });
  const byMethod = Object.keys(PAY_LABEL).map((m) => {
    const list = paidOrders.filter((o) => o.paymentMethod === m);
    return [PAY_LABEL[m], String(list.length), money(sum(list, (o) => o.subtotalCents))];
  });
  const noMethod = paidOrders.filter((o) => !PAY_LABEL[o.paymentMethod]);
  if (noMethod.length) byMethod.push(['Paid (method not recorded)', String(noMethod.length), money(sum(noMethod, (o) => o.subtotalCents))]);

  const prod = new Map();
  for (const o of live) {
    const seen = new Set();
    for (const i of o.items || []) {
      const p = prod.get(i.productName) || { name: i.productName, units: 0, orders: 0, revenue: 0, paidRevenue: 0 };
      p.units += i.quantity; p.revenue += i.lineTotalCents; if (o.paid === true) p.paidRevenue += i.lineTotalCents;
      if (!seen.has(i.productName)) { p.orders++; seen.add(i.productName); }
      prod.set(i.productName, p);
    }
  }
  const byProduct = [...prod.values()].sort((a, b) => b.units - a.units);

  const days = new Map();
  for (const o of live) {
    if (!o.createdAtMillis) continue;
    const k = toNyLocalInput(o.createdAtMillis).slice(0, 10);
    const d = days.get(k) || { orders: 0, units: 0 }; d.orders++; d.units += unitsOf(o); days.set(k, d);
  }
  const dayList = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const maxDay = Math.max(1, ...dayList.map(([, d]) => d.orders));

  // What has to be ordered from the supplier: every non-cancelled order, summed per product / size / color.
  const totals = new Map();
  for (const o of live) for (const i of o.items || []) {
    const k = `${i.productName}|${i.size}|${i.color}`;
    const t = totals.get(k) || { name: i.productName, size: i.size, color: i.color, qty: 0 };
    t.qty += i.quantity; totals.set(k, t);
  }
  const want = [...totals.values()].sort((a, b) => a.name.localeCompare(b.name) || a.size.localeCompare(b.size, undefined, { numeric: true }) || a.color.localeCompare(b.color));

  const next = status.nextOpensAtMillis;
  const card = (title, big, sub) => h('div', { class: 'card2' }, h('h3', {}, title), h('p', { class: 'big' }, big), h('p', { class: 'fine', style: 'margin-top:.5rem' }, sub));
  const table = (heads, rows, foot) => h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, heads.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))), foot ? h('tr', {}, foot.map((c) => h('td', { style: 'font-weight:700' }, c))) : null)));
  const section = (id, title, ...kids) => h('section', { class: 'panel', 'aria-labelledby': id }, h('h2', { id }, title), ...kids);

  clear(out).append(
    h('div', { class: 'cards' },
      card('Store status', status.open ? 'Open' : 'Closed', status.open ? `Closes ${fmtNY(status.closesAtMillis)}` : (next ? `Opens ${fmtNY(next, { year: true })}` : 'No upcoming schedule')),
      card('Orders', String(live.length), `${orders.length - live.length} cancelled`),
      card('Items sold', String(units), live.length ? `${(units / live.length).toFixed(1)} per order on average` : 'No orders yet'),
      card('Order value', money(revenue), `${money(collected)} paid · ${money(revenue - collected)} still to collect`),
      card('Paid', `${paidOrders.length} / ${live.length}`, `${pct(paidOrders.length, live.length)} of orders marked paid`),
      card('Not paid yet', String(unpaidOrders.length), `${awaitingAction} still "submitted" (not confirmed)`),
      card('Failed emails', String(failedMail), failedMail ? 'Open the order to retry' : 'None'),
    ),
    section('ov-status', 'Orders by status', table(['Status', 'Orders', 'Paid', 'Not paid', 'Value'], byStatus, ['Total (not cancelled)', String(live.length), String(paidOrders.length), String(unpaidOrders.length), money(revenue)])),
    section('ov-pay', 'Payments received', h('p', { class: 'fine', style: 'margin-bottom:.8rem' }, 'Based on the Paid checkbox you set on each order.'),
      table(['Method', 'Orders', 'Amount'], byMethod, ['Total collected', String(paidOrders.length), money(collected)]),
      h('p', { class: 'fine', style: 'margin-top:.6rem' }, `Still to collect: ${money(revenue - collected)} across ${unpaidOrders.length} order${unpaidOrders.length === 1 ? '' : 's'}.`)),
    section('ov-prod', 'Sales by product', byProduct.length ? table(['Product', 'Units', 'Orders', 'Order value', 'Paid'], byProduct.map((p) => [p.name, String(p.units), String(p.orders), money(p.revenue), money(p.paidRevenue)])) : h('p', { class: 'empty' }, 'No orders yet.')),
    section('ov-days', 'Orders per day (New York time)', dayList.length
      ? h('div', { class: 'bars' }, dayList.map(([k, d]) => h('div', { class: 'barrow' }, h('span', { class: 'barrow__l' }, k), h('span', { class: 'barrow__b' }, h('span', { style: `width:${Math.max(2, Math.round((d.orders / maxDay) * 100))}%` })), h('span', { class: 'barrow__v' }, `${d.orders} order${d.orders === 1 ? '' : 's'} · ${d.units} item${d.units === 1 ? '' : 's'}`))))
      : h('p', { class: 'empty' }, 'No orders yet.')),
    section('ov-inv', 'What to order', h('p', { class: 'fine', style: 'margin-bottom:.8rem' }, 'Totals across all orders that are not cancelled. Use this when the drop has closed and you place the supplier order.'),
      want.length ? table(['Product', 'Size', 'Color', 'Quantity'], want.map((a) => [a.name, a.size, a.color, String(a.qty)]), ['', '', 'Total', String(units)]) : h('p', { class: 'empty' }, 'No orders yet.'),
      all.size >= 1000 ? h('p', { class: 'fine' }, 'Showing the latest 1000 orders only.') : null),
    section('ov-recent', 'Recent orders', ordersTable(recent.docs.map(snapOrder))),
    section('ov-store', 'Store details', h('dl', { class: 'kv' },
      h('dt', {}, 'Customers'), h('dd', {}, `${customers} unique email${customers === 1 ? '' : 's'}`),
      h('dt', {}, 'Average order'), h('dd', {}, live.length ? money(Math.round(revenue / live.length)) : '-'),
      h('dt', {}, 'First order'), h('dd', {}, times.length ? fmtNY(Math.min(...times), { year: true }) : '-'),
      h('dt', {}, 'Latest order'), h('dd', {}, times.length ? fmtNY(Math.max(...times), { year: true }) : '-'),
      h('dt', {}, 'Products'), h('dd', {}, `${products.filter((p) => p.active).length} active, ${products.filter((p) => !p.active).length} hidden`),
      h('dt', {}, 'Schedules'), h('dd', {}, `${scheds.size} configured`))),
  );
}


/* ============================== orders ============================== */

const snapOrder = (d) => ({ id: d.id, ...d.data(), createdAtMillis: ms(d.data().createdAt) });

const payTag = (o) => (o.status === 'cancelled' ? tag('cancelled', '-') : (o.paid === true ? tag('paid', `Paid${PAY_LABEL[o.paymentMethod] ? ` · ${PAY_LABEL[o.paymentMethod]}` : ''}`) : tag('unpaid', 'Not paid')));

function ordersTable(orders, onOpen) {
  if (!orders.length) return h('p', { class: 'empty' }, 'No orders yet.');
  const open = onOpen || ((o) => { tab = 'orders'; location.hash = `order=${o.id}`; go('orders'); });
  return h('div', { class: 'tablewrap' }, h('table', { class: 't' },
    h('thead', {}, h('tr', {}, ['Order', 'Placed (ET)', 'Customer', 'Total', 'Status', 'Payment', ''].map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', {}, orders.map((o) => h('tr', { class: 'click', onclick: () => open(o) },
      h('td', { class: 'mono' }, o.orderNumber), h('td', {}, fmtNY(o.createdAtMillis)),
      h('td', {}, o.customerName, h('br'), h('span', { class: 'fine' }, o.customerEmail)),
      h('td', {}, money(o.subtotalCents)), h('td', {}, tag(o.status, STATUS_LABEL[o.status] || o.status)), h('td', {}, payTag(o)),
      h('td', {}, h('button', { class: 'linkbtn', type: 'button', onclick: (e) => { e.stopPropagation(); open(o); } }, 'Open', h('span', { class: 'sr-only' }, ` ${o.orderNumber}`))))))));
}

async function viewOrders() {
  const { db, fs } = F; const out = panel;
  const state = { status: '', pay: '', q: '', rows: [], last: null, done: false };
  const list = h('div', {});
  const more = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => fetchPage(true) }, 'Load more');
  const statusSel = h('select', { id: 'o-status', onchange: () => { state.status = statusSel.value; reset(); } },
    h('option', { value: '' }, 'All statuses'), ...Object.keys(STATUS_LABEL).map((s) => h('option', { value: s }, STATUS_LABEL[s])));
  const paySel = h('select', { id: 'o-pay', onchange: () => { state.pay = paySel.value; draw(); } }, h('option', { value: '' }, 'Paid and not paid'), h('option', { value: 'paid' }, 'Paid only'), h('option', { value: 'unpaid' }, 'Not paid only'));
  const search = h('input', { type: 'text', id: 'o-q', placeholder: 'Order number, name or email', 'aria-describedby': 'o-help', oninput: () => { state.q = search.value.trim(); draw(); } });
  const find = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => findExact().catch(fail) }, 'Find order number');

  async function fetchPage(append) {
    const cons = [];
    if (state.status) cons.push(fs.where('status', '==', state.status));
    cons.push(fs.orderBy('createdAt', 'desc'));
    if (append && state.last) cons.push(fs.startAfter(state.last));
    cons.push(fs.limit(25));
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'orders'), ...cons));
    state.rows = append ? state.rows.concat(snap.docs.map(snapOrder)) : snap.docs.map(snapOrder);
    state.last = snap.docs[snap.docs.length - 1] || state.last;
    state.done = snap.size < 25;
    draw();
  }
  function reset() { state.rows = []; state.last = null; fetchPage(false).catch(fail); }
  function draw() {
    const q = state.q.toLowerCase();
    let rows = state.rows;
    if (state.pay === 'paid') rows = rows.filter((o) => o.paid === true);
    if (state.pay === 'unpaid') rows = rows.filter((o) => o.paid !== true && o.status !== 'cancelled');
    if (q) rows = rows.filter((o) => [o.orderNumber, o.customerName, o.customerEmail, o.customerPhone].some((x) => String(x || '').toLowerCase().includes(q)));
    clear(list).append(ordersTable(rows, safeOpen));
    more.hidden = state.done;
    if (q && !rows.length && !state.done) list.append(h('p', { class: 'fine' }, 'No match in the orders loaded so far. Load more, or use "Find order number" for an exact order number.'));
  }
  async function findExact() {
    const n = state.q.toUpperCase();
    if (!/^THTC-\d{3,}$/.test(n)) { toast('Type a full order number such as THTC-00012.'); return; }
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'orders'), fs.where('orderNumber', '==', n), fs.limit(1)));
    if (snap.empty) { toast('No order with that number.'); return; }
    safeOpen(snapOrder(snap.docs[0]));
  }

  clear(out).append(
    h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: 'o-status' }, 'Status'), statusSel), h('div', { class: 'field' }, h('label', { for: 'o-pay' }, 'Payment'), paySel), h('div', { class: 'field', style: 'flex:1 1 260px' }, h('label', { for: 'o-q' }, 'Search'), search), find),
    h('p', { class: 'fine', id: 'o-help', style: 'margin-bottom:1rem' }, 'Search filters the orders loaded below. Payment is never collected online: every order is unpaid until you arrange it with the customer.'),
    h('section', { class: 'panel' }, list, h('div', { style: 'margin-top:1rem' }, more)));
  await fetchPage(false);
  if (location.hash.startsWith('#order=')) {
    const id = location.hash.slice(7);
    const snap = await fs.getDoc(fs.doc(db, 'orders', id)).catch(() => null);
    if (snap && snap.exists()) safeOpen(snapOrder(snap));
  }
}

function paymentBox(o) {
  const locked = o.status === 'cancelled';
  const cb = h('input', { type: 'checkbox', id: 'pay-paid', checked: o.paid === true, disabled: locked });
  const sel = h('select', { id: 'pay-method', disabled: locked }, h('option', { value: '' }, 'Choose method...'), ...Object.entries(PAY_LABEL).map(([v, l]) => h('option', { value: v, selected: o.paymentMethod === v }, l)));
  const save = h('button', { class: 'btn btn--primary btn--sm', type: 'button', disabled: locked }, 'Save payment');
  save.onclick = () => guarded(save, async () => {
    if (cb.checked && !sel.value) { toast('Choose how they paid: cash, Venmo or Zelle.'); sel.focus(); return; }
    await callable('adminSetOrderPayment', { orderId: o.id, paid: cb.checked, method: sel.value || null });
    ordersDirty = true; toast(`${o.orderNumber} marked ${cb.checked ? 'paid' : 'not paid'}`); await openOrder(o);
  });
  return h('div', {},
    h('h3', { style: 'font:600 .75rem/1 var(--body);letter-spacing:.15em;text-transform:uppercase;color:var(--faint);margin-bottom:.6rem' }, 'Payment'),
    h('div', { class: 'row-actions', style: 'align-items:center' },
      h('label', { for: 'pay-paid', style: 'display:inline-flex;gap:.5rem;align-items:center;min-height:44px' }, cb, 'Paid'),
      h('label', { for: 'pay-method', class: 'sr-only' }, 'Payment method'), sel, save),
    h('p', { class: 'fine', style: 'margin-top:.5rem' }, locked ? 'This order is cancelled, so it cannot be marked paid.' : (o.paid === true && o.paidAtMillis ? `Marked paid ${fmtNY(o.paidAtMillis, { year: true })}. ` : '') + 'Money is never collected on the website: tick Paid after you receive it by cash, Venmo or Zelle.'));
}

let ordersDirty = false;     // set when an order changed, so the lists behind the dialog are refreshed when it closes
const safeOpen = (o) => openOrder(o).catch(fail);

async function openOrder(o) {
  const { db, fs } = F;
  history.replaceState(null, '', `#order=${o.id}`);
  const mailSnap = await fs.getDocs(fs.query(fs.collection(db, 'mail'), fs.where('orderId', '==', o.id))).catch(() => ({ docs: [] }));
  const fresh = await fs.getDoc(fs.doc(db, 'orders', o.id));
  if (!fresh.exists()) throw new Error('That order no longer exists.');
  o = snapOrder(fresh);
  const mails = mailSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0));
  const actions = h('div', { class: 'row-actions' });
  for (const next of STATUS_NEXT[o.status] || []) {
    const btn = h('button', { class: next === 'cancelled' ? 'btn btn--ghost btn--sm' : 'btn btn--primary btn--sm', type: 'button' }, ACTION_LABEL[next]);
    btn.onclick = () => {
      const msg = next === 'cancelled' ? `Cancel ${o.orderNumber}? The customer is emailed. This cannot be undone.` : `Mark ${o.orderNumber} as ${STATUS_LABEL[next].toLowerCase()}? The customer will be emailed.`;
      if (!confirm(msg)) return;
      guarded(btn, async () => { await callable('adminUpdateOrderStatus', { orderId: o.id, status: next }); ordersDirty = true; toast(`${o.orderNumber}: ${STATUS_LABEL[next]}`); await openOrder(o); });
    };
    actions.append(btn);
  }
  const del = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Delete order permanently');
  del.onclick = () => {
    if (!confirm(`Permanently delete ${o.orderNumber} (${o.customerName})? The order and its email records are erased and cannot be recovered. No email is sent to the customer.`)) return;
    guarded(del, async () => { await callable('adminDeleteOrder', { orderId: o.id }); ordersDirty = true; toast(`${o.orderNumber} deleted`); ensureDialog('order-dlg').close(); });
  };
  const dlg = ensureDialog('order-dlg');
  clear(dlg).append(
    h('div', { class: 'dlg-head' }, h('h2', { id: 'order-dlg-t' }, `Order ${o.orderNumber}`), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close order', onclick: () => dlg.close() }, icon.close())),
    h('div', { style: 'padding:1.25rem;display:grid;gap:1.25rem' },
      h('div', {}, tag(o.status, STATUS_LABEL[o.status]), ' ', payTag(o)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Placed'), h('dd', {}, fmtNY(o.createdAtMillis, { year: true })),
        h('dt', {}, 'Customer'), h('dd', {}, o.customerName),
        h('dt', {}, 'Email'), h('dd', {}, h('a', { href: `mailto:${o.customerEmail}` }, o.customerEmail)),
        o.customerPhone ? [h('dt', {}, 'Phone'), h('dd', {}, h('a', { href: `tel:${o.customerPhone}` }, o.customerPhone))] : null,
        h('dt', {}, 'Fulfillment'), h('dd', {}, (o.fulfillmentMethod === 'arranged_separately' ? 'To be arranged separately' : o.fulfillmentMethod) + (o.fulfillmentDetails ? `: ${o.fulfillmentDetails}` : ''))),
      paymentBox(o),
      h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Item', 'Size', 'Color', 'SKU', 'Qty', 'Unit', 'Total'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, o.items.map((i) => h('tr', {}, h('td', {}, i.productName), h('td', {}, i.size), h('td', {}, i.color), h('td', { class: 'mono' }, i.sku || ''), h('td', {}, String(i.quantity)), h('td', {}, money(i.unitPriceCents)), h('td', {}, money(i.lineTotalCents)))),
          h('tr', {}, h('td', { colspan: 6, style: 'text-align:right;font-weight:700' }, 'Subtotal'), h('td', { style: 'font-weight:700' }, money(o.subtotalCents)))))),
      actions.children.length ? h('div', {}, h('h3', { class: 'lbl', style: 'font:600 .75rem/1 var(--body);letter-spacing:.15em;text-transform:uppercase;color:var(--faint);margin-bottom:.6rem' }, 'Change status'), actions, h('p', { class: 'fine', style: 'margin-top:.5rem' }, 'Changing status never marks anything as paid. Allowed next steps are shown.')) : h('p', { class: 'fine' }, 'This order is in a final state.'),
      h('div', {}, h('h3', { style: 'font:600 .75rem/1 var(--body);letter-spacing:.15em;text-transform:uppercase;color:var(--faint);margin-bottom:.6rem' }, 'History'), h('ul', {}, (o.statusHistory || []).map((x) => h('li', { class: 'fine' }, `${fmtNY(x.atMillis)}: ${STATUS_LABEL[x.status] || x.status}`)))),
      h('div', {}, h('h3', { style: 'font:600 .75rem/1 var(--body);letter-spacing:.15em;text-transform:uppercase;color:var(--faint);margin-bottom:.6rem' }, 'Emails'),
        mails.length ? h('ul', {}, mails.map((m) => h('li', { class: 'fine', style: 'display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;padding:.3rem 0' }, tag(m.status === 'sent' ? 'sent' : m.status === 'failed' ? 'failed' : 'pending', m.status === 'sent' ? 'sent to Make' : m.status), `${m.kind.replace(/_/g, ' ')} → ${m.to}`, m.attempts ? `(attempts: ${m.attempts})` : '', m.lastError && m.status !== 'sent' ? h('span', { class: 'alert' }, m.lastError) : null,
          m.status === 'failed' ? h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: (e) => guarded(e.currentTarget, async () => { await callable('adminResendMail', { mailId: m.id }); ordersDirty = true; toast('Email re-queued'); await openOrder(o); }) }, 'Retry') : null))) : h('p', { class: 'fine' }, 'No email records.')),
      h('div', {}, del, h('p', { class: 'fine', style: 'margin-top:.4rem' }, 'Permanently removes this order and its email records. This cannot be undone.')),
    ),
  );
  dlg.addEventListener('close', () => {
    history.replaceState(null, '', location.pathname);
    if (ordersDirty) { ordersDirty = false; if (tab === 'orders' || tab === 'overview') go(tab); }
  }, { once: true });
  if (!dlg.open) dlg.showModal();
}

function ensureDialog(id) {
  let d = document.getElementById(id);
  if (!d) {
    d = h('dialog', { id, class: 'sheet', 'aria-labelledby': `${id}-t` });
    // only the read-only order view closes on a backdrop click; editors must not lose unsaved work to a stray click
    let down = false;
    d.addEventListener('pointerdown', (e) => { down = e.target === d; });
    d.addEventListener('click', (e) => { if (e.target === d && down && id === 'order-dlg') d.close(); down = false; });
    document.body.append(d);
  }
  return d;
}

/* ============================== products ============================== */

async function viewProducts() {
  const out = panel;
  const products = await loadProducts(true);
  clear(out).append(
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => editProduct(null) }, 'New product')),
    h('section', { class: 'panel' }, h('h2', {}, 'Products'),
      products.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Product', 'Price', 'Variants', 'Status', ''].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, products.map((p) => {
          return h('tr', { class: 'click', onclick: () => editProduct(p) }, h('td', {}, p.name, p.featured ? ' ★' : ''), h('td', {}, money(p.priceCents)), h('td', {}, String(p.variants.filter((v) => v.active).length)), h('td', {}, tag(p.active ? 'open' : 'inactive', p.active ? 'Active' : 'Inactive')),
            h('td', {}, h('button', { class: 'linkbtn', type: 'button', onclick: (e) => { e.stopPropagation(); editProduct(p); } }, 'Edit', h('span', { class: 'sr-only' }, ` ${p.name}`))));
        })))) : h('p', { class: 'empty' }, 'No products yet. Add your first product; nothing appears on the shop until it is active and the store is open.')));
}

function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image'))), 'image/webp', 0.86);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a readable image.')); };
    img.src = url;
  });
}

function editProduct(existing) {
  const { db, fs, storage, st } = F;
  const id = existing ? existing.id : fs.doc(fs.collection(db, 'products')).id;
  const m = {
    name: existing ? existing.name : '', description: existing ? existing.description || '' : '',
    price: existing ? (existing.priceCents / 100).toFixed(2) : '', active: existing ? existing.active : false, featured: existing ? existing.featured === true : false,
    images: existing ? (existing.images || []).map((x) => ({ ...x })) : [],
    variants: existing ? existing.variants.filter((v) => v.active).map((v) => ({ size: v.size, color: v.color, sku: v.sku || '', active: v.active })) : [],
  };
  const dlg = ensureDialog('product-dlg');
  const err = h('div', { class: 'errsum', role: 'alert', tabindex: '-1', hidden: true });
  const name = h('input', { type: 'text', id: 'p-name', value: m.name, required: true, maxlength: 120 });
  const desc = h('textarea', { id: 'p-desc', rows: 5, maxlength: 4000 }, m.description);
  const price = h('input', { type: 'text', id: 'p-price', inputmode: 'decimal', value: m.price, placeholder: '45.00', required: true });
  const active = h('input', { type: 'checkbox', id: 'p-active', checked: m.active });
  const featured = h('input', { type: 'checkbox', id: 'p-feat', checked: m.featured });
  const imgBox = h('div', {});
  const vBox = h('tbody', {});
  const sizesIn = h('input', { type: 'text', id: 'gen-sizes', placeholder: 'S, M, L, XL' });
  const colorsIn = h('input', { type: 'text', id: 'gen-colors', placeholder: 'Black, White' });

  const drawImages = () => {
    clear(imgBox);
    if (!m.images.length) imgBox.append(h('p', { class: 'fine' }, 'No photos yet. The first photo is the main image.'));
    m.images.forEach((im, i) => imgBox.append(h('div', { class: 'imgrow' },
      h('img', { src: im.url, alt: '' }),
      h('div', { class: 'field' }, h('label', { for: `alt-${i}` }, `Photo ${i + 1} description (for screen readers)`), h('input', { type: 'text', id: `alt-${i}`, value: im.alt || '', maxlength: 200, oninput: (e) => { im.alt = e.target.value; } })),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: i === 0, 'aria-label': `Move photo ${i + 1} earlier`, onclick: () => { m.images.splice(i - 1, 0, m.images.splice(i, 1)[0]); drawImages(); } }, '↑'),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', disabled: i === m.images.length - 1, 'aria-label': `Move photo ${i + 1} later`, onclick: () => { m.images.splice(i + 1, 0, m.images.splice(i, 1)[0]); drawImages(); } }, '↓'),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { m.images.splice(i, 1); drawImages(); } }, 'Remove')))));
  };
  const drawVariants = () => {
    clear(vBox);
    m.variants.forEach((v, i) => vBox.append(h('tr', {},
      h('td', {}, h('input', { type: 'text', value: v.size, 'aria-label': `Size, row ${i + 1}`, maxlength: 30, oninput: (e) => { v.size = e.target.value; } })),
      h('td', {}, h('input', { type: 'text', value: v.color, 'aria-label': `Color, row ${i + 1}`, maxlength: 40, oninput: (e) => { v.color = e.target.value; } })),
      h('td', {}, h('input', { type: 'text', value: v.sku, 'aria-label': `SKU, row ${i + 1}`, maxlength: 60, oninput: (e) => { v.sku = e.target.value; } })),
      h('td', {}, h('button', { class: 'linkbtn', type: 'button', onclick: () => { m.variants.splice(i, 1); drawVariants(); } }, 'Remove', h('span', { class: 'sr-only' }, ` row ${i + 1}`))))));
    if (!m.variants.length) vBox.append(h('tr', {}, h('td', { colspan: 4, class: 'fine' }, 'No variants yet. Add a row, or generate sizes × colors below.')));
  };
  let uploading = 0;
  const upload = h('input', { type: 'file', id: 'p-file', accept: 'image/jpeg,image/png,image/webp,image/avif', multiple: true, onchange: async (e) => {
    for (const f of [...e.target.files]) {
      uploading++;
      try {
        toast(`Uploading ${f.name}...`);
        const blob = await resizeImage(f);
        const path = `products/${id}/${Date.now()}-${f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 50) || 'photo'}.webp`;
        const r = st.ref(storage, path);
        await st.uploadBytes(r, blob, { contentType: 'image/webp' });
        m.images.push({ url: await st.getDownloadURL(r), path, alt: '' });
        drawImages();
      } catch (ex) { fail(ex); }
      finally { uploading--; }
    }
    e.target.value = '';
  } });

  const save = h('button', { class: 'btn btn--primary', type: 'button' }, 'Save product');
  save.onclick = () => guarded(save, async () => {
    err.hidden = true;
    const dollars = Number(String(price.value).replace(/[$,\s]/g, ''));
    const priceCents = Math.round(dollars * 100);
    const problems = [];
    if (!name.value.trim()) problems.push('Name is required.');
    if (uploading) problems.push('A photo is still uploading. Wait a moment and save again.');
    if (!String(price.value).trim() || !Number.isFinite(dollars) || dollars < 0 || Math.abs(dollars * 100 - priceCents) > 1e-6) problems.push('Price must be a dollar amount with at most 2 decimals, e.g. 45.00.');
    for (const [i, v] of m.variants.entries()) {
      if (!String(v.size).trim() || !String(v.color).trim()) problems.push(`Variant row ${i + 1}: size and color are required.`);
    }
    const seen = new Set();
    for (const [i, v] of m.variants.entries()) {
      const k = `${String(v.size).trim().toLowerCase()}|${String(v.color).trim().toLowerCase()}`;
      if (String(v.size).trim() && String(v.color).trim() && seen.has(k)) problems.push(`Variant row ${i + 1}: ${v.size} / ${v.color} appears more than once.`);
      seen.add(k);
    }
    if (active.checked && !m.variants.length) problems.push('Add at least one variant before activating the product.');
    if (problems.length) { err.hidden = false; clear(err).append(h('strong', {}, 'Please fix:'), h('ul', {}, problems.map((x) => h('li', {}, x)))); err.focus(); return; }
    try {
      await callable('adminSaveProduct', {
        id, name: name.value.trim(), description: desc.value.trim(), priceCents, active: active.checked, featured: featured.checked,
        images: m.images.map((x) => ({ url: x.url, path: x.path, alt: x.alt || '' })),
        variants: m.variants.map((v) => ({ size: String(v.size).trim(), color: String(v.color).trim(), sku: String(v.sku || '').trim(), active: true })),
      });
    } catch (ex) { err.hidden = false; err.textContent = ex.message; err.focus(); return; }
    toast('Product saved');
    dlg.close();
    go('products');
  });

  clear(dlg).append(
    h('div', { class: 'dlg-head' }, h('h2', { id: 'product-dlg-t' }, existing ? 'Edit product' : 'New product'), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon.close())),
    h('div', { style: 'padding:1.25rem' },
      err,
      h('div', { class: 'formgrid' }, h('div', { class: 'field' }, h('label', { for: 'p-name' }, 'Name'), name), h('div', { class: 'field' }, h('label', { for: 'p-price' }, 'Price (USD)'), price)),
      h('div', { class: 'field' }, h('label', { for: 'p-desc' }, 'Description'), desc),
      h('div', { class: 'checks' }, h('label', { for: 'p-active' }, active, 'Active (visible on the shop)'), h('label', { for: 'p-feat' }, featured, 'Featured (listed first)')),
      h('h3', { style: 'font:400 1.2rem/1 var(--display);letter-spacing:.05em;text-transform:uppercase;margin:1rem 0 .6rem' }, 'Photos'),
      imgBox, h('div', { class: 'field', style: 'margin-top:.8rem' }, h('label', { for: 'p-file' }, 'Add photos (JPEG, PNG, WebP; resized to 1600px)'), upload),
      h('h3', { style: 'font:400 1.2rem/1 var(--display);letter-spacing:.05em;text-transform:uppercase;margin:1.4rem 0 .6rem' }, 'Sizes & colors'),
      h('div', { class: 'tablewrap' }, h('table', { class: 't vtable' }, h('thead', {}, h('tr', {}, ['Size', 'Color', 'SKU (optional)', ''].map((x) => h('th', { scope: 'col' }, x)))), vBox)),
      h('div', { class: 'toolbar', style: 'margin-top:.8rem' },
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { m.variants.push({ size: '', color: '', sku: '', active: true }); drawVariants(); } }, 'Add row'),
        h('div', { class: 'field' }, h('label', { for: 'gen-sizes' }, 'Sizes'), sizesIn), h('div', { class: 'field' }, h('label', { for: 'gen-colors' }, 'Colors'), colorsIn),
        h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => {
          const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
          for (const s of split(sizesIn.value)) for (const c of split(colorsIn.value)) {
            if (!m.variants.some((v) => v.size.toLowerCase() === s.toLowerCase() && v.color.toLowerCase() === c.toLowerCase())) m.variants.push({ size: s, color: c, sku: '', active: true });
          }
          drawVariants();
        } }, 'Generate sizes × colors')),
      h('p', { class: 'fine' }, 'Removing a row retires that size/color (past orders keep their details). There are no stock counts: every drop is a pre-order and you order exactly what was requested.'),
      h('div', { class: 'row-actions', style: 'margin-top:1.4rem' }, save, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel')),
    ));
  drawImages(); drawVariants();
  dlg.showModal();
  name.focus();
}

/* ============================== schedules ============================== */

async function viewSchedules() {
  const { db, fs } = F; const out = panel;
  const [status, snap] = await Promise.all([callable('getStoreStatus', {}), fs.getDocs(fs.query(fs.collection(db, 'storeSchedules'), fs.orderBy('opensAt', 'desc')))]);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data(), opens: ms(d.data().opensAt), closes: ms(d.data().closesAt) }));
  const nowMs = status.serverNowMillis;
  const stateOf = (s) => !s.active ? ['inactive', 'Inactive'] : (s.opens <= nowMs && nowMs < s.closes ? ['open', 'Open now'] : (s.opens > nowMs ? ['upcoming', 'Upcoming'] : ['ended', 'Ended']));

  clear(out).append(
    h('div', { class: 'cards' }, h('div', { class: 'card2' }, h('h3', {}, 'Right now'), h('p', { class: 'big' }, status.open ? 'Open' : 'Closed'), h('p', { class: 'fine', style: 'margin-top:.5rem' }, status.open ? `Closes ${fmtNY(status.closesAtMillis)}` : (status.nextOpensAtMillis ? `Next opening ${fmtNY(status.nextOpensAtMillis, { year: true })}` : 'No upcoming schedule. The shop stays closed.')))),
    h('p', { class: 'notice', style: 'margin-bottom:1rem' }, h('strong', {}, 'All times are New York time (Eastern, daylight-saving aware).'), ' The shop is open when opening time ≤ now < closing time. Active schedules cannot overlap. Changes apply immediately; no redeploy needed.'),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => editSchedule(null) }, 'New schedule')),
    h('section', { class: 'panel' }, h('h2', {}, 'Schedules'),
      rows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Name', 'Opens (ET)', 'Closes (ET)', 'State', ''].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, rows.map((s) => { const [c, label] = stateOf(s); return h('tr', {}, h('td', {}, s.name), h('td', {}, fmtNY(s.opens, { year: true })), h('td', {}, fmtNY(s.closes, { year: true })), h('td', {}, tag(c, label)),
          h('td', {}, h('div', { class: 'row-actions' }, h('button', { class: 'linkbtn', type: 'button', onclick: () => editSchedule(s) }, 'Edit', h('span', { class: 'sr-only' }, ` ${s.name}`)),
            h('button', { class: 'linkbtn', type: 'button', onclick: (e) => { if (!confirm(`Delete schedule "${s.name}"?`)) return; guarded(e.currentTarget, async () => { await callable('adminDeleteSchedule', { id: s.id }); toast('Schedule deleted'); go('schedules'); }); } }, 'Delete', h('span', { class: 'sr-only' }, ` ${s.name}`))))); })))) : h('p', { class: 'empty' }, 'No schedules yet. The shop is closed until you add and activate one.')));
}

function editSchedule(s) {
  const dlg = ensureDialog('sched-dlg');
  const err = h('div', { class: 'errsum', role: 'alert', tabindex: '-1', hidden: true });
  const name = h('input', { type: 'text', id: 's-name', value: s ? s.name : '', maxlength: 100, required: true });
  const opens = h('input', { type: 'datetime-local', id: 's-open', value: s ? toNyLocalInput(s.opens) : '', required: true });
  const closes = h('input', { type: 'datetime-local', id: 's-close', value: s ? toNyLocalInput(s.closes) : '', required: true });
  const active = h('input', { type: 'checkbox', id: 's-active', checked: s ? s.active : true });
  const save = h('button', { class: 'btn btn--primary', type: 'button' }, 'Save schedule');
  save.onclick = () => guarded(save, async () => {
    err.hidden = true;
    try { await callable('adminSaveSchedule', { id: s ? s.id : undefined, name: name.value.trim(), opensAtLocal: opens.value, closesAtLocal: closes.value, active: active.checked }); }
    catch (ex) { err.hidden = false; err.textContent = ex.message; err.focus(); return; }
    toast('Schedule saved'); dlg.close(); go('schedules');
  });
  clear(dlg).append(
    h('div', { class: 'dlg-head' }, h('h2', { id: 'sched-dlg-t' }, s ? 'Edit schedule' : 'New schedule'), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon.close())),
    h('div', { style: 'padding:1.25rem;max-width:560px' }, err,
      h('div', { class: 'field' }, h('label', { for: 's-name' }, 'Name (e.g. "Fall drop")'), name),
      h('div', { class: 'formgrid' }, h('div', { class: 'field' }, h('label', { for: 's-open' }, 'Opens (New York time)'), opens), h('div', { class: 'field' }, h('label', { for: 's-close' }, 'Closes (New York time)'), closes)),
      h('p', { class: 'fine', style: 'margin-bottom:1rem' }, 'Times you enter are New York time no matter where you are. Wall times that do not exist (spring-forward hour) are rejected; times that occur twice (fall-back hour) use the first occurrence.'),
      h('div', { class: 'checks' }, h('label', { for: 's-active' }, active, 'Active')),
      h('div', { class: 'row-actions' }, save, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel'))));
  dlg.showModal(); name.focus();
}

/* ============================== settings ============================== */

async function viewSettings() {
  const { db, fs } = F; const out = panel;
  const snap = await fs.getDoc(fs.doc(db, 'settings', 'public'));
  const mailHolder = h('div', {}, h('section', { class: 'panel' }, h('h2', {}, 'Email (Make.com)'), h('p', { class: 'empty' }, 'Loading email settings...')));
  const cur = snap.exists() ? snap.data() : { fulfillmentMethods: [], checkoutNotice: '' };
  const methods = (cur.fulfillmentMethods || []).map((x) => ({ ...x }));
  const box = h('div', {});
  const notice = h('textarea', { id: 'set-notice', rows: 3, maxlength: 600 }, cur.checkoutNotice || '');
  const draw = () => {
    clear(box);
    if (!methods.length) box.append(h('p', { class: 'fine' }, 'No options configured: checkout shows an optional notes box and records "to be arranged separately".'));
    methods.forEach((m, i) => box.append(h('div', { class: 'imgrow' },
      h('div', { class: 'field' }, h('label', { for: `m-id-${i}` }, 'Id (lowercase, e.g. pickup)'), h('input', { type: 'text', id: `m-id-${i}`, value: m.id || '', maxlength: 40, oninput: (e) => { m.id = e.target.value.trim(); } })),
      h('div', { class: 'field' }, h('label', { for: `m-l-${i}` }, 'Label shown to customers'), h('input', { type: 'text', id: `m-l-${i}`, value: m.label || '', maxlength: 80, oninput: (e) => { m.label = e.target.value; } })),
      h('div', { class: 'field' }, h('label', { for: `m-d-${i}` }, 'Details box label'), h('input', { type: 'text', id: `m-d-${i}`, value: m.detailsLabel || '', maxlength: 80, placeholder: 'e.g. Delivery address', oninput: (e) => { m.detailsLabel = e.target.value; } })),
      h('div', { class: 'checks', style: 'margin:0' }, h('label', {}, h('input', { type: 'checkbox', checked: !!m.requiresDetails, onchange: (e) => { m.requiresDetails = e.target.checked; } }), 'Details required'), h('label', {}, h('input', { type: 'checkbox', checked: m.enabled !== false, onchange: (e) => { m.enabled = e.target.checked; } }), 'Enabled')),
      h('button', { class: 'btn btn--ghost btn--sm', type: 'button', onclick: () => { methods.splice(i, 1); draw(); } }, 'Remove'))));
  };
  const save = h('button', { class: 'btn btn--primary', type: 'button' }, 'Save settings');
  save.onclick = () => guarded(save, async () => {
    for (const m of methods) if (!m.id && m.label) m.id = m.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    await callable('adminSaveSettings', { fulfillmentMethods: methods, checkoutNotice: notice.value.trim() }); toast('Settings saved'); });
  clear(out).append(
    h('section', { class: 'panel' }, h('h2', {}, 'Fulfillment options'),
      h('p', { class: 'fine', style: 'margin-bottom:1rem' }, 'Fulfillment is undecided, so none are required. Add options (e.g. local pickup, shipping) when you decide; nothing is invented for you. Do not add prices here: this store does not calculate shipping.'),
      box, h('button', { class: 'btn btn--ghost btn--sm', type: 'button', style: 'margin-top:.8rem', onclick: () => { methods.push({ id: '', label: '', requiresDetails: false, detailsLabel: '', enabled: true }); draw(); } }, 'Add option'),
      h('div', { class: 'field', style: 'margin-top:1.2rem' }, h('label', { for: 'set-notice' }, 'Extra checkout notice (optional): shown above the Submit button, e.g. pickup or payment instructions once decided'), notice),
      save),
    mailHolder,
    h('section', { class: 'panel' }, h('h2', {}, 'Administrators'), h('p', { class: 'fine' }, 'Admin access is granted only by the site owner from a terminal, never from this page: ', h('code', { class: 'mono' }, 'node scripts/set-admin.js add person@example.com'), '. See the README, "Adding and removing administrators".')),
  );
  draw();
  callable('adminGetMailConfig', {}).then((cfg) => mailHolder.replaceChildren(mailPanel(cfg)))
    .catch((e) => mailHolder.replaceChildren(h('section', { class: 'panel' }, h('div', { class: 'notice notice--error', role: 'alert' }, 'Could not load email settings: ' + e.message))));
}

function mailPanel(cfg) {
  const status = h('p', { class: cfg.configured ? 'notice' : 'notice notice--warn', role: 'status', style: 'margin-bottom:1rem' });
  const paint = (c) => {
    status.className = c.configured ? 'notice' : 'notice notice--warn';
    status.replaceChildren(...(c.configured
      ? [h('strong', {}, 'Connected to Make'), ` (${c.host}, ends ${c.hint}). API key: ${c.tokenSet ? 'set' : 'not set'}. For safety the saved URL is never shown again; paste a new one to replace it.`]
      : [h('strong', {}, 'Email is not set up yet.'), ' Orders are still saved. Emails wait and are retried automatically, and are delivered as soon as you save a webhook below.']));
  };
  paint(cfg);
  const url = h('input', { type: 'text', id: 'mail-url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://hook.us1.make.com/...' });
  const key = h('input', { type: 'password', id: 'mail-key', autocomplete: 'new-password', placeholder: cfg.tokenSet ? '(unchanged unless you type a new one)' : 'optional' });
  const save = h('button', { class: 'btn btn--primary btn--sm', type: 'button' }, 'Save webhook');
  save.onclick = () => guarded(save, async () => {
    if (!url.value.trim()) { toast('Paste the Make webhook URL first.'); return; }
    paint(await callable('adminSaveMailWebhook', { url: url.value.trim(), token: key.value.trim() }));
    url.value = ''; key.value = ''; toast('Webhook saved. Now send a test email.');
  });
  const test = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Send test email to admin');
  test.onclick = () => guarded(test, async () => { const r = await callable('adminSendTestMail', {}); toast(`Test sent to ${r.sentTo}. Check that inbox (and Make's history).`); });
  const remove = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, 'Remove webhook');
  remove.onclick = () => { if (!confirm('Remove the webhook? Emails will stop going out until you add one again.')) return; guarded(remove, async () => { paint(await callable('adminSaveMailWebhook', { clear: true })); toast('Webhook removed'); }); };
  return h('section', { class: 'panel', 'aria-labelledby': 'mail-h' }, h('h2', { id: 'mail-h' }, 'Email (Make.com)'),
    status,
    h('div', { class: 'field' }, h('label', { for: 'mail-url' }, 'Make webhook URL'), url),
    h('div', { class: 'field' }, h('label', { for: 'mail-key' }, 'Make API key (optional, recommended)'), key),
    h('div', { class: 'row-actions' }, save, test, remove),
    h('details', { style: 'margin-top:1.2rem' }, h('summary', { style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, 'How to set up the Make scenario'),
      h('ol', { class: 'steps', style: 'margin-top:.6rem' },
        h('li', {}, 'In Make: Create a scenario. First module: Webhooks → Custom webhook → Add. Copy the URL it shows and paste it above.'),
        h('li', {}, 'In that webhook\'s settings you can turn on API key authentication. If you do, use the same key above. Skip it if unsure.'),
        h('li', {}, 'Click "Save webhook", then "Send test email". The Make webhook module will say it learned the data structure (to, subject, text, html, kind, replyTo, id).'),
        h('li', {}, 'Add a second module: Gmail → Send an email (or the Email module). Map To = to, Subject = subject, Content type = HTML, Content = html. Optionally Reply-To = replyTo.'),
        h('li', {}, 'Turn the scenario ON (scheduling: Immediately). Send another test and confirm it arrives. Every email the store sends (new order, confirmation, status updates) uses this one scenario.')),
      h('p', { class: 'fine' }, '"Sent" in the order view means Make accepted the email. If the Make scenario itself errors later (for example Gmail disconnects), check Make → History.')));
}
boot();
