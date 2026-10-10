import { loadCore, callable, isConfigured, useEmulator } from './firebase.js';
import { money, fmtNY, h, $, clear, announce, toast, icon } from './common.js';
import * as Cart from './cart.js';

const stage = $('#stage');
const chip = $('#status-chip');
const cartDlg = $('#cart');
const pdpDlg = $('#pdp');
const coDlg = $('#checkout');
$('#yr').textContent = new Date().getFullYear();

const S = {
  status: null,       // { open, closesAtMillis, nextOpensAtMillis, scheduleName }
  skew: 0,            // server time - local time
  catalog: null,      // [{ id, name, description, priceCents, images, featured, variants:[{id,size,color,inStock,sku}] }]
  settings: { fulfillmentMethods: [], checkoutNotice: '' },
  notes: new Map(),   // `${productId}/${variantId}` -> message about a cart line
  submitting: false,
};
const now = () => Date.now() + S.skew;
const lineKey = (i) => `${i.productId}/${i.variantId}`;

/* ------------------------------------------------------------------ helpers */

function openDialog(dlg) { if (!dlg.open) dlg.showModal(); document.body.classList.add('lock'); }
function closeDialog(dlg) { if (dlg.open) dlg.close(); }
for (const dlg of [cartDlg, pdpDlg, coDlg]) {
  dlg.addEventListener('close', () => { if (![cartDlg, pdpDlg, coDlg].some((d) => d.open)) document.body.classList.remove('lock'); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(dlg); });          // backdrop click
  dlg.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeDialog(dlg); });
}

function errMessage(e) {
  const code = String(e && e.code || '').replace('functions/', '');
  if (code === 'unavailable' || code === 'deadline-exceeded' || /network|fetch/i.test(String(e && e.message))) return 'We could not reach the server. Check your connection and try again. Your cart is saved.';
  if (code === 'resource-exhausted') return e.message;
  return (e && e.message && !/^internal$/i.test(e.message)) ? e.message : 'Something went wrong. Please try again.';
}

function productImage(p, cls = '') {
  const im = p.images && p.images[0];
  if (im) return h('img', { src: im.url, alt: im.alt || p.name, loading: 'lazy', decoding: 'async', class: cls });
  return h('div', { class: 'noimg' }, 'Photo coming soon');
}
const soldOut = (p) => !p.variants.some((v) => v.inStock);

const SIZE_RANK = ['XXS','XS','S','M','L','XL','XXL','2XL','XXXL','3XL','4XL'];
const sizeRank = (s) => { const i = SIZE_RANK.indexOf(String(s).toUpperCase().trim()); return i === -1 ? 100 : i; };
const bySize = (a, b) => (sizeRank(a.size) - sizeRank(b.size)) || String(a.size).localeCompare(String(b.size), undefined, { numeric: true }) || String(a.color).localeCompare(String(b.color));

/* ------------------------------------------------------------------ data */

async function loadStatus() {
  const r = await callable('getStoreStatus', {});
  S.status = r;
  S.skew = r.serverNowMillis - Date.now();
  return r;
}

async function loadCatalog() {
  const { db, fs } = await loadCore();
  const [prodSnap, setSnap] = await Promise.all([
    fs.getDocs(fs.query(fs.collection(db, 'products'), fs.where('active', '==', true), fs.orderBy('createdAt', 'desc'))),
    fs.getDoc(fs.doc(db, 'settings', 'public')).catch(() => null),
  ]);
  if (setSnap && setSnap.exists()) S.settings = { fulfillmentMethods: [], checkoutNotice: '', ...setSnap.data() };
  const list = await Promise.all(prodSnap.docs.map(async (d) => {
    const vs = await fs.getDocs(fs.query(fs.collection(db, 'products', d.id, 'variants'), fs.where('active', '==', true)));
    const p = d.data();
    return {
      id: d.id, name: p.name, description: p.description || '', priceCents: p.priceCents, images: p.images || [], featured: p.featured === true,
      variants: vs.docs.map((v) => ({ id: v.id, ...v.data() })).sort(bySize),
    };
  }));
  S.catalog = list.sort((a, b) => Number(b.featured) - Number(a.featured));
  reconcileCart();
  return S.catalog;
}

/** Compare saved cart lines against the live catalog; update changed prices, flag unavailable lines. */
function reconcileCart() {
  if (!S.catalog) return false;
  let changed = false;
  S.notes.clear();
  for (const it of Cart.getCart().items) {
    const p = S.catalog.find((x) => x.id === it.productId);
    const v = p && p.variants.find((x) => x.id === it.variantId);
    if (!p || !v) { S.notes.set(lineKey(it), { bad: true, text: 'No longer available. Remove it to continue.' }); changed = true; continue; }
    if (!v.inStock) { S.notes.set(lineKey(it), { bad: true, text: 'Sold out. Remove it to continue.' }); changed = true; continue; }
    if (p.priceCents !== it.priceCents) {
      S.notes.set(lineKey(it), { bad: false, text: `Price updated from ${money(it.priceCents)} to ${money(p.priceCents)}.` });
      Cart.updateSnapshot(it.productId, it.variantId, { priceCents: p.priceCents, name: p.name, image: p.images[0] ? p.images[0].url : null });
      changed = true;
    }
  }
  return changed;
}

/* ------------------------------------------------------------------ stage rendering */

function setChip() {
  if (!S.status) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.classList.toggle('status-chip--closed', !S.status.open);
  if (S.status.open) chip.textContent = S.status.closesAtMillis ? `Open now · closes ${fmtNY(S.status.closesAtMillis)}` : 'Open now';
  else chip.textContent = S.status.nextOpensAtMillis ? `Closed · opens ${fmtNY(S.status.nextOpensAtMillis)}` : 'Closed right now';
}

function renderLoading() {
  stage.setAttribute('aria-busy', 'true');
  clear(stage).append(
    h('p', { class: 'sr-only' }, 'Loading the shop'),
    h('div', { class: 'catalog' }, h('div', { class: 'grid', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => h('div', {}, h('div', { class: 'skeleton', style: 'aspect-ratio:4/5' }), h('div', { class: 'skeleton', style: 'height:16px;margin-top:12px;width:70%' }), h('div', { class: 'skeleton', style: 'height:14px;margin-top:8px;width:30%' }))))),
  );
}

function stateBlock({ title, body, center = false, actions = [], extra = [], art = true }) {
  stage.setAttribute('aria-busy', 'false');
  const node = h('section', { class: `state${center ? ' state--center' : ''}`, 'aria-labelledby': 'state-h' },
    art && h('div', { class: 'state__art' }, icon.shirt()),
    h('h2', { class: 'h2', id: 'state-h', tabindex: '-1' }, title),
    body && h('p', { class: 'lede' }, body),
    ...extra,
    actions.length ? h('div', { style: 'display:flex;gap:.8rem;flex-wrap:wrap;margin-top:.5rem' }, actions) : null,
  );
  clear(stage).append(node);
  return node;
}

function renderNotConfigured() {
  chip.hidden = true;
  stateBlock({ title: 'Shop coming soon', body: 'We are getting the shop ready. Follow @truehearttrackclub on Instagram to hear about the first drop.', center: true, actions: [h('a', { class: 'btn btn--primary', href: 'https://www.instagram.com/truehearttrackclub/', target: '_blank', rel: 'noopener' }, 'Follow on Instagram')] });
}

function renderError(e, retry) {
  stateBlock({ title: 'The shop did not load', body: errMessage(e), center: true, actions: [h('button', { class: 'btn btn--primary', type: 'button', onclick: retry }, 'Try again')] });
}

function renderClosed() {
  setChip();
  const st = S.status;
  const extra = [];
  let body;
  if (st.nextOpensAtMillis) {
    body = `The next drop opens ${fmtNY(st.nextOpensAtMillis, { year: true })}${st.scheduleName ? ` (${st.scheduleName})` : ''}.`;
    extra.push(h('div', { class: 'countdown', id: 'countdown', role: 'timer', 'aria-label': 'Time until the shop opens' }));
  } else {
    body = 'There is no drop scheduled right now. Follow us on Instagram and you will hear about it first.';
  }
  const saved = Cart.cartCount();
  if (saved) extra.push(h('p', { class: 'fine' }, `Your cart (${saved} item${saved === 1 ? '' : 's'}) is saved and will be waiting when the shop opens.`));
  stateBlock({
    title: 'The shop is closed', body, center: true, extra,
    actions: [h('a', { class: 'btn btn--primary', href: 'https://www.instagram.com/truehearttrackclub/', target: '_blank', rel: 'noopener' }, 'Follow on Instagram'), h('a', { class: 'btn btn--ghost', href: '/' }, 'Back to home')],
  });
  tickCountdown();
}

function tickCountdown() {
  const el = $('#countdown');
  if (!el || !S.status || !S.status.nextOpensAtMillis) return;
  let ms = Math.max(0, S.status.nextOpensAtMillis - now());
  const d = Math.floor(ms / 864e5); ms -= d * 864e5;
  const hr = Math.floor(ms / 36e5); ms -= hr * 36e5;
  const mi = Math.floor(ms / 6e4); ms -= mi * 6e4;
  const se = Math.floor(ms / 1e3);
  const cell = (n, l) => h('div', {}, h('b', {}, String(n).padStart(2, '0')), h('span', {}, l));
  el.replaceChildren(cell(d, 'Days'), cell(hr, 'Hours'), cell(mi, 'Min'), cell(se, 'Sec'));
}

function renderCatalog() {
  setChip();
  stage.setAttribute('aria-busy', 'false');
  const list = S.catalog;
  if (!list.length) {
    stateBlock({ title: 'Merch is on the way', body: 'The first products are not up yet. Check back soon, or follow us on Instagram for the reveal.', center: true, actions: [h('a', { class: 'btn btn--primary', href: 'https://www.instagram.com/truehearttrackclub/', target: '_blank', rel: 'noopener' }, 'Follow on Instagram')] });
    return;
  }
  const grid = h('ul', { class: 'grid', 'aria-label': 'Products' }, list.map((p) => {
    const out = soldOut(p);
    return h('li', {}, h('button', { class: `pcard${out ? ' pcard--soldout' : ''}`, type: 'button', 'aria-haspopup': 'dialog', onclick: () => openProduct(p.id), 'aria-label': `${p.name}, ${money(p.priceCents)}${out ? ', sold out' : ''}` },
      h('div', { class: 'pcard__media' }, productImage(p), out ? h('span', { class: 'pcard__badge pcard__badge--soldout' }, 'Sold out') : (p.featured ? h('span', { class: 'pcard__badge' }, 'Featured') : null)),
      h('span', { class: 'pcard__name' }, p.name),
      h('span', { class: 'pcard__price' }, money(p.priceCents)),
    ));
  }));
  clear(stage).append(h('div', { class: 'catalog' }, h('h2', { class: 'sr-only' }, 'Products'), grid));
}

/* ------------------------------------------------------------------ product dialog */

function openProduct(id) {
  const p = S.catalog.find((x) => x.id === id);
  if (!p) return;
  const sizes = [...new Set(p.variants.map((v) => v.size))];
  const colors = [...new Set(p.variants.map((v) => v.color))];
  const sel = { size: sizes.length === 1 ? sizes[0] : null, color: colors.length === 1 ? colors[0] : null, qty: 1, img: 0 };
  const vOf = (s, c) => p.variants.find((v) => v.size === s && v.color === c);
  const out = soldOut(p);

  const main = h('div', { class: 'pdp__main' });
  const thumbs = h('div', { class: 'thumbs', role: 'group', 'aria-label': 'Product photos' });
  const drawImg = () => {
    const im = p.images[sel.img];
    main.replaceChildren(im ? h('img', { src: im.url, alt: im.alt || p.name, decoding: 'async' }) : h('div', { class: 'noimg' }, 'Photo coming soon'));
    [...thumbs.children].forEach((b, i) => b.setAttribute('aria-current', String(i === sel.img)));
  };
  p.images.forEach((im, i) => thumbs.append(h('button', { type: 'button', 'aria-label': `Show photo ${i + 1} of ${p.images.length}`, onclick: () => { sel.img = i; drawImg(); } }, h('img', { src: im.url, alt: '', loading: 'lazy' }))));

  const mkGroup = (label, name, values) => {
    const val = h('b', {});
    const legend = h('legend', {}, label, val);
    const wrap = h('div', { class: 'chips' }, values.map((v) => h('label', { class: 'chip' },
      h('input', { type: 'radio', name, value: v, checked: sel[name] === v, onchange: () => { sel[name] = v; fixSelection(name); update(); } }),
      h('span', {}, v))));
    return { node: h('fieldset', { class: 'opt', id: `grp-${name}` }, legend, wrap), val, inputs: () => [...wrap.querySelectorAll('input')] };
  };
  const gSize = mkGroup('Size', 'size', sizes);
  const gColor = mkGroup('Color', 'color', colors);
  const avail = h('p', { class: 'avail', id: 'avail', 'aria-live': 'polite' });
  const qtyOut = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Quantity', value: '1', onchange: () => setQty(parseInt(qtyOut.value, 10)) });
  const minus = h('button', { type: 'button', 'aria-label': 'Decrease quantity', onclick: () => setQty(sel.qty - 1) }, '−');
  const plus = h('button', { type: 'button', 'aria-label': 'Increase quantity', onclick: () => setQty(sel.qty + 1) }, '+');
  const msg = h('p', { class: 'avail avail--bad', role: 'alert', id: 'pdp-msg' });
  const addBtn = h('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: add }, 'Add to cart');

  function maxQty() {
    const v = sel.size && sel.color && vOf(sel.size, sel.color);
    return Math.max(1, Cart.MAX_LINE_QTY - (v ? Cart.qtyInCart(p.id, v.id) : 0));
  }
  function setQty(n) {
    sel.qty = Math.min(maxQty(), Math.max(1, Number.isFinite(n) ? n : 1));
    qtyOut.value = String(sel.qty);
    minus.disabled = sel.qty <= 1; plus.disabled = sel.qty >= maxQty();
  }
  /** Sizes are only disabled when sold out entirely; if the chosen size makes the chosen color impossible, reset the color. */
  function fixSelection(changed) {
    if (changed === 'size' && sel.color && !(vOf(sel.size, sel.color) || {}).inStock) {
      const was = sel.color; sel.color = null;
      gColor.inputs().forEach((i) => { i.checked = false; });
      msg.textContent = `${was} is not available in size ${sel.size}, so the color was cleared. Pick another.`;
    } else msg.textContent = '';
  }
  function update() {
    gSize.val.textContent = sel.size || '';
    gColor.val.textContent = sel.color || '';
    gSize.inputs().forEach((i) => { i.disabled = !p.variants.some((v) => v.size === i.value && v.inStock); });
    gColor.inputs().forEach((i) => {
      const ok = sel.size ? (vOf(sel.size, i.value) || {}).inStock : p.variants.some((v) => v.color === i.value && v.inStock);
      i.disabled = !ok;
    });
    const v = sel.size && sel.color && vOf(sel.size, sel.color);
    avail.className = 'avail';
    if (out) { avail.textContent = 'This item is currently sold out.'; avail.classList.add('avail--bad'); }
    else if (!sel.size && !sel.color) avail.textContent = 'Choose a size and color.';
    else if (!sel.size) avail.textContent = 'Choose a size.';
    else if (!sel.color) avail.textContent = 'Choose a color.';
    else if (v && v.inStock) { avail.textContent = 'In stock.'; avail.classList.add('avail--ok'); }
    else { avail.textContent = 'Sold out in this size and color.'; avail.classList.add('avail--bad'); }
    const ready = !out && v && v.inStock;
    addBtn.setAttribute('aria-disabled', String(!ready));
    addBtn.classList.toggle('is-disabled', !ready);
    addBtn.style.opacity = ready ? '' : '.5';
    setQty(sel.qty);
  }
  function add() {
    msg.textContent = '';
    const v = sel.size && sel.color && vOf(sel.size, sel.color);
    if (out) { msg.textContent = 'This item is sold out.'; return; }
    if (!sel.size) { msg.textContent = 'Choose a size first.'; gSize.inputs().find((i) => !i.disabled)?.focus(); return; }
    if (!sel.color) { msg.textContent = 'Choose a color first.'; gColor.inputs().find((i) => !i.disabled)?.focus(); return; }
    if (!v || !v.inStock) { msg.textContent = 'That size and color is sold out. Try another combination.'; return; }
    if (Cart.qtyInCart(p.id, v.id) + sel.qty > Cart.MAX_LINE_QTY) { msg.textContent = `You can order up to ${Cart.MAX_LINE_QTY} of one item.`; return; }
    Cart.addItem({ productId: p.id, variantId: v.id, qty: sel.qty, name: p.name, size: v.size, color: v.color, priceCents: p.priceCents, image: p.images[0] ? p.images[0].url : null });
    closeDialog(pdpDlg);
    announce(`${sel.qty} ${p.name}, ${v.size}, ${v.color} added to cart.`);
    openCart();
  }

  clear(pdpDlg).append(
    h('div', { class: 'dlg-head' }, h('h2', { id: 'pdp-title', class: 'sr-only' }, p.name), h('span', { class: 'kicker' }, 'Product details'), h('button', { class: 'iconbtn', type: 'button', 'data-close': '', 'aria-label': 'Close product details' }, icon.close())),
    h('div', { class: 'pdp' },
      h('div', { class: 'pdp__gallery' }, main, p.images.length > 1 ? thumbs : null),
      h('div', { class: 'pdp__info' },
        h('h3', { class: 'pdp__title' }, p.name),
        h('p', { class: 'pdp__price' }, money(p.priceCents)),
        p.description ? h('p', { class: 'pdp__desc' }, p.description) : null,
        gSize.node, gColor.node,
        h('fieldset', { class: 'opt' }, h('legend', {}, 'Quantity'), h('div', { class: 'qty' }, minus, qtyOut, plus)),
        avail, msg, addBtn,
        h('p', { class: 'fine' }, 'No payment is collected online. After you submit an order we contact you to arrange payment and pickup.'),
      )),
  );
  drawImg(); update();
  history.replaceState(null, '', `#p=${p.id}`);
  pdpDlg.addEventListener('close', () => { if (location.hash.startsWith('#p=')) history.replaceState(null, '', location.pathname + location.search); }, { once: true });
  openDialog(pdpDlg);
}

/* ------------------------------------------------------------------ cart */

function renderCartButton() {
  const n = Cart.cartCount();
  const c = $('#cart-count');
  c.textContent = String(n); c.hidden = n === 0;
  $('#cart-open').setAttribute('aria-label', `Open cart, ${n} item${n === 1 ? '' : 's'}`);
}

function renderCart() {
  const body = $('#cart-body'); const foot = $('#cart-foot');
  const cart = Cart.getCart();
  clear(body); clear(foot);
  if (!cart.items.length) {
    body.append(h('div', { class: 'state', style: 'padding:2.5rem 0' }, h('p', { class: 'lede' }, 'Your cart is empty.'), h('button', { class: 'btn btn--ghost', type: 'button', 'data-close': '' }, 'Continue shopping')));
    return;
  }
  for (const it of cart.items) {
    const note = S.notes.get(lineKey(it));
    const id = `qty-${it.productId}-${it.variantId}`;
    const qty = h('input', { type: 'text', inputmode: 'numeric', id, 'aria-label': `Quantity for ${it.name}`, value: String(it.qty), onchange: (e) => { const n = parseInt(e.target.value, 10); Cart.setQty(it.productId, it.variantId, Number.isFinite(n) ? n : it.qty); } });
    body.append(h('div', { class: 'cart-line' },
      h('div', { class: 'cart-line__img' }, it.image ? h('img', { src: it.image, alt: '' }) : h('div', { class: 'noimg' }, '')),
      h('div', {},
        h('p', { class: 'cart-line__name' }, it.name),
        h('p', { class: 'cart-line__meta' }, `Size ${it.size} · ${it.color}`),
        h('p', { class: 'cart-line__meta' }, `${money(it.priceCents)} each`),
        h('div', { class: 'cart-line__row' },
          h('div', { class: 'qty qty--sm' },
            h('button', { type: 'button', 'aria-label': `Decrease quantity of ${it.name}, ${it.size} ${it.color}`, onclick: () => Cart.setQty(it.productId, it.variantId, it.qty - 1) }, '−'),
            qty,
            h('button', { type: 'button', 'aria-label': `Increase quantity of ${it.name}, ${it.size} ${it.color}`, disabled: it.qty >= Cart.MAX_LINE_QTY, onclick: () => Cart.setQty(it.productId, it.variantId, it.qty + 1) }, '+')),
          h('span', { class: 'cart-line__total' }, money(it.qty * it.priceCents))),
        note ? h('p', { class: `alert${note.bad ? ' alert--bad' : ''}`, role: 'status' }, note.text) : null,
        h('button', { class: 'linkbtn', type: 'button', onclick: () => { Cart.removeItem(it.productId, it.variantId); announce(`${it.name} removed from cart.`); } }, `Remove`, h('span', { class: 'sr-only' }, ` ${it.name}, ${it.size} ${it.color}`)),
      )));
  }
  const blocked = [...S.notes.values()].some((n) => n.bad);
  const closed = S.status && !S.status.open;
  foot.append(...[
    h('div', { class: 'totals' }, h('span', {}, 'Subtotal'), h('span', {}, money(Cart.cartSubtotal(cart)))),
    h('p', { class: 'fine' }, 'No payment is collected online. You review everything before submitting.'),
    closed ? h('p', { class: 'alert alert--bad', role: 'alert' }, 'The shop is closed, so orders cannot be submitted right now.') : null,
    h('button', { class: 'btn btn--primary btn--block', type: 'button', disabled: blocked || closed || !S.catalog, onclick: startCheckout }, 'Review & check out'),
    h('button', { class: 'btn btn--ghost btn--block', type: 'button', 'data-close': '' }, 'Continue shopping'),
  ].filter(Boolean));
}

function openCart() { renderCart(); openDialog(cartDlg); }
$('#cart-open').addEventListener('click', openCart);
Cart.subscribe(() => { renderCartButton(); if (cartDlg.open) renderCart(); });

/* ------------------------------------------------------------------ checkout */

async function startCheckout() {
  const btn = cartDlg.querySelector('.cart-foot .btn--primary');
  if (btn) btn.setAttribute('aria-busy', 'true');
  try {
    await loadStatus();
    if (!S.status.open) { closeDialog(cartDlg); showStage(); return; }
    await loadCatalog(); // fresh prices/availability
  } catch (e) { toast(errMessage(e)); if (btn) btn.removeAttribute('aria-busy'); return; }
  if (btn) btn.removeAttribute('aria-busy');
  if ([...S.notes.values()].length) { renderCart(); toast('Your cart changed. Please review it before checking out.'); return; }
  closeDialog(cartDlg);
  renderCheckout();
  openDialog(coDlg);
}

function renderCheckout(prefill = {}) {
  const cart = Cart.getCart();
  const methods = (S.settings.fulfillmentMethods || []).filter((m) => m.enabled !== false);
  const f = { name: prefill.name || '', email: prefill.email || '', phone: prefill.phone || '', method: prefill.method || (methods[0] && methods[0].id) || '', details: prefill.details || '' };

  const err = (id) => h('p', { class: 'err', id: `${id}-err`, role: 'alert' });
  const field = (id, label, input, opts = {}) => h('div', { class: 'field' }, h('label', { for: id }, label, opts.optional ? h('span', { class: 'opt-tag' }, ' (optional)') : null), input, err(id));
  const name = h('input', { type: 'text', id: 'f-name', name: 'name', autocomplete: 'name', value: f.name, required: true, 'aria-describedby': 'f-name-err' });
  const email = h('input', { type: 'email', id: 'f-email', name: 'email', autocomplete: 'email', inputmode: 'email', value: f.email, required: true, 'aria-describedby': 'f-email-err' });
  const phone = h('input', { type: 'tel', id: 'f-phone', name: 'phone', autocomplete: 'tel', value: f.phone, 'aria-describedby': 'f-phone-err' });
  const details = h('textarea', { id: 'f-details', name: 'details', rows: 3, maxlength: 1000, 'aria-describedby': 'f-details-err' }, f.details);
  const confirm = h('input', { type: 'checkbox', id: 'f-confirm', 'aria-describedby': 'f-confirm-err' });
  const summary = h('div', { class: 'errsum', role: 'alert', tabindex: '-1', hidden: true });
  const submit = h('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Submit order (no payment)');
  const serverErr = h('div', { class: 'notice notice--error', role: 'alert', hidden: true });

  let methodBlock = null; let detailsLabel = 'Notes for pickup or delivery'; let detailsOptional = true;
  const methodInputs = [];
  if (methods.length) {
    methodBlock = h('fieldset', { class: 'field', style: 'border:0;padding:0;margin:0 0 1rem' }, h('legend', { class: 'lbl', style: 'margin-bottom:.5rem' }, 'How would you like to get your order?'),
      h('div', { class: 'radios' }, methods.map((m) => {
        const r = h('input', { type: 'radio', name: 'method', value: m.id, checked: f.method === m.id, onchange: () => syncMethod() });
        methodInputs.push(r);
        return h('label', { class: 'radio' }, r, h('span', {}, m.label));
      })));
  }
  const detailsLabelEl = h('label', { for: 'f-details' });
  const detailsField = h('div', { class: 'field' }, detailsLabelEl, details, err('f-details'));
  function syncMethod() {
    if (methods.length) {
      const m = methods.find((x) => x.id === (methodInputs.find((r) => r.checked) || {}).value) || methods[0];
      detailsLabel = m.detailsLabel || 'Details'; detailsOptional = !m.requiresDetails;
    }
    detailsLabelEl.replaceChildren(detailsLabel, detailsOptional ? h('span', { class: 'opt-tag' }, ' (optional)') : '');
    details.required = !detailsOptional;
  }
  syncMethod();

  const review = h('div', { class: 'review', 'aria-label': 'Order review' },
    ...cart.items.map((it) => h('div', { class: 'review__line' }, h('span', {}, `${it.qty} × ${it.name}`, h('small', {}, `Size ${it.size} · ${it.color} · ${money(it.priceCents)} each`)), h('span', {}, money(it.qty * it.priceCents)))),
    h('div', { class: 'review__line', style: 'border-top:1px solid var(--line);padding-top:.8rem;font-weight:700' }, h('span', {}, 'Subtotal'), h('span', {}, money(Cart.cartSubtotal(cart)))),
    h('div', { class: 'notice' }, h('strong', {}, 'No payment is collected on this website.'), ' Submitting sends us your order request. We will email you to arrange payment and fulfillment. Your order is not paid for until we agree on that with you.'),
    S.settings.checkoutNotice ? h('div', { class: 'notice' }, S.settings.checkoutNotice) : null,
  );

  const form = h('form', { novalidate: true, id: 'co-form' },
    summary,
    h('h3', {}, 'Your details'),
    field('f-name', 'Full name', name), field('f-email', 'Email', email), field('f-phone', 'Phone', phone, { optional: true }),
    methodBlock, detailsField,
  );
  const right = h('div', {}, h('h3', {}, 'Review'), review,
    h('label', { class: 'checkrow', style: 'margin:1rem 0' }, confirm, h('span', {}, 'I understand that no payment is collected online and that payment and fulfillment will be arranged with me separately.')),
    err('f-confirm'), serverErr, submit,
    h('button', { class: 'linkbtn', type: 'button', style: 'margin-top:.4rem', onclick: () => { closeDialog(coDlg); openCart(); } }, '← Back to cart'));

  const setErr = (id, text) => { const e = $(`#${id}-err`); const input = $(`#${id}`); if (e) e.textContent = text || ''; if (input) { if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); } };
  function validate() {
    const errors = [];
    const need = (id, ok, text) => { setErr(id, ok ? '' : text); if (!ok) errors.push({ id, text }); };
    need('f-name', name.value.trim().length >= 2, 'Enter your full name.');
    need('f-email', /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim()), 'Enter a valid email address.');
    need('f-phone', !phone.value.trim() || /^[0-9+()\-.\s]{7,30}$/.test(phone.value.trim()), 'Phone numbers can only use digits, spaces, + ( ) - and .');
    need('f-details', detailsOptional || details.value.trim().length > 0, `${detailsLabel} is required.`);
    need('f-confirm', confirm.checked, 'Please confirm that you understand no payment is collected online.');
    return errors;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (S.submitting) return;
    serverErr.hidden = true;
    const errors = validate();
    if (errors.length) {
      summary.hidden = false;
      clear(summary).append(h('strong', {}, `Please fix ${errors.length} problem${errors.length === 1 ? '' : 's'}:`), h('ul', {}, errors.map((x) => h('li', {}, h('a', { href: `#${x.id}`, onclick: (ev) => { ev.preventDefault(); $(`#${x.id}`).focus(); } }, x.text)))));
      summary.focus();
      return;
    }
    summary.hidden = true;
    S.submitting = true; submit.setAttribute('aria-busy', 'true'); submit.setAttribute('aria-disabled', 'true');
    const items = cart.items.map((i) => ({ productId: i.productId, variantId: i.variantId, quantity: i.qty }));
    try {
      const res = await callable('submitOrder', {
        idempotencyKey: Cart.checkoutKey(), confirm: true,
        customer: { name: name.value.trim(), email: email.value.trim(), phone: phone.value.trim() },
        fulfillment: { method: (methodInputs.find((r) => r.checked) || {}).value || null, details: details.value.trim() },
        items,
      });
      Cart.clearCart();               // only after the order is safely stored
      try { sessionStorage.setItem('thtc_last_order', JSON.stringify(res)); } catch (_) {}
      closeDialog(coDlg);
      showConfirmation(res);
    } catch (ex) {
      handleSubmitError(ex, serverErr, { name: name.value, email: email.value, phone: phone.value, details: details.value, method: (methodInputs.find((r) => r.checked) || {}).value });
    } finally {
      S.submitting = false; submit.removeAttribute('aria-busy'); submit.removeAttribute('aria-disabled');
    }
  });

  clear(coDlg).append(
    h('div', { class: 'dlg-head' }, h('h2', { id: 'co-title' }, 'Checkout'), h('button', { class: 'iconbtn', type: 'button', 'data-close': '', 'aria-label': 'Close checkout' }, icon.close())),
    h('div', { class: 'co' }, form, right),
  );
  // the submit button/right column live outside the <form> element for layout; associate them
  submit.setAttribute('form', 'co-form');
}

function handleSubmitError(ex, box, keep) {
  const code = String(ex.code || '').replace('functions/', '');
  const d = ex.details || {};
  const show = (text) => { box.hidden = false; box.textContent = text; box.focus?.(); };
  if (code === 'failed-precondition' && d.reason === 'store_closed') {
    closeDialog(coDlg);
    loadStatus().then(showStage).catch(() => {});
    toast('The shop just closed. Your cart is saved.');
    return;
  }
  if (code === 'failed-precondition' && d.reason === 'cart_invalid') {
    const lines = (d.problems || []).map((p) => {
      const it = Cart.getCart().items.find((i) => i.productId === p.productId && i.variantId === p.variantId);
      const nm = it ? `${it.name} (${it.size}, ${it.color})` : 'An item';
      if (p.reason === 'insufficient_stock') return `${nm}: only ${p.available} left.`;
      return `${nm}: no longer available.`;
    });
    for (const p of d.problems || []) {
      if (p.reason === 'insufficient_stock' && p.available > 0) Cart.setQty(p.productId, p.variantId, p.available);
      S.notes.set(`${p.productId}/${p.variantId}`, { bad: true, text: p.reason === 'insufficient_stock' ? (p.available > 0 ? `Only ${p.available} left. Quantity adjusted.` : 'Sold out. Remove it to continue.') : 'No longer available. Remove it to continue.' });
    }
    show(`Your cart changed while you were checking out. ${lines.join(' ')} Your order was NOT submitted. Review your cart and try again.`);
    loadCatalog().then(() => { if (cartDlg.open) renderCart(); }).catch(() => {});
    return;
  }
  show(`${errMessage(ex)} Your order was NOT submitted.`.replace('Your cart is saved. Your order was NOT submitted.', 'Your cart is saved and your order was not submitted.'));
}

/* ------------------------------------------------------------------ confirmation */

function showConfirmation(res) {
  const box = $('#confirmation');
  box.hidden = false;
  clear(box).append(h('section', { class: 'confirm', 'aria-labelledby': 'conf-h' },
    h('p', { class: 'kicker' }, 'Order received'),
    h('h2', { class: 'h2', id: 'conf-h', tabindex: '-1' }, 'Thank you!'),
    h('div', {}, h('p', { class: 'fine' }, 'Order reference'), h('p', { class: 'confirm__ref' }, res.orderNumber)),
    h('div', { class: 'review' },
      ...res.items.map((it) => h('div', { class: 'review__line' }, h('span', {}, `${it.quantity} × ${it.productName}`, h('small', {}, `Size ${it.size} · ${it.color} · ${money(it.unitPriceCents)} each`)), h('span', {}, money(it.lineTotalCents)))),
      h('div', { class: 'review__line', style: 'border-top:1px solid var(--line);padding-top:.8rem;font-weight:700' }, h('span', {}, 'Total'), h('span', {}, money(res.subtotalCents)))),
    h('div', { class: 'notice notice--warn' }, h('strong', {}, 'Payment has not been collected.'), ' Nothing was charged on this website, and this order is not paid yet.'),
    h('div', {}, h('h3', { style: 'font:600 1rem/1.3 var(--body);margin-bottom:.6rem' }, 'What happens next'),
      h('ol', { class: 'steps' },
        h('li', {}, 'We review your order and email you to confirm it.'),
        h('li', {}, 'We arrange payment and fulfillment with you directly.'),
        h('li', {}, `A confirmation email should arrive at ${res.customerEmail} shortly. If you do not see it within a few minutes, check your spam folder or write to truehearttrackclub@gmail.com with ${res.orderNumber}.`))),
    h('div', {}, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => { box.hidden = true; clear(box); try { sessionStorage.removeItem('thtc_last_order'); } catch (_) {} } }, 'Dismiss')),
  ));
  box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  $('#conf-h').focus({ preventScroll: true });
  announce(`Order ${res.orderNumber} received. Payment has not been collected.`);
}

/* ------------------------------------------------------------------ boot */

function showStage() {
  if (!S.status) return;
  if (S.status.open && S.catalog) renderCatalog(); else if (!S.status.open) renderClosed();
  setChip();
  if (cartDlg.open) renderCart();
}

async function init() {
  renderCartButton();
  try { const raw = sessionStorage.getItem('thtc_last_order'); if (raw) showConfirmation(JSON.parse(raw)); } catch (_) {}
  if (!isConfigured) { renderNotConfigured(); return; }
  renderLoading();
  try {
    await loadStatus();
    if (S.status.open) await loadCatalog();
    showStage();
    if (S.status.open && location.hash.startsWith('#p=')) openProduct(location.hash.slice(3));
    if (location.hash === '#cart') openCart();
  } catch (e) {
    renderError(e, init);
    return;
  }
  if (useEmulator) chip.append(' (emulator)');

  setInterval(() => {
    tickCountdown();
    if (!S.status) return;
    const t = now();
    const due = (S.status.open && S.status.closesAtMillis && t >= S.status.closesAtMillis) || (!S.status.open && S.status.nextOpensAtMillis && t >= S.status.nextOpensAtMillis);
    if (due) refresh();
  }, 1000);
  setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

let refreshing = false;
async function refresh() {
  if (refreshing || S.submitting) return;
  refreshing = true;
  try {
    const wasOpen = S.status && S.status.open;
    await loadStatus();
    if (S.status.open && (!wasOpen || !S.catalog)) await loadCatalog();
    if (wasOpen !== S.status.open) {
      if (!S.status.open) { closeDialog(pdpDlg); closeDialog(coDlg); announce('The shop has closed.'); }
      showStage();
    } else setChip();
  } catch (_) { /* keep showing what we have */ }
  refreshing = false;
}

init();
