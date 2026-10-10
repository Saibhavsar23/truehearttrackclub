'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/logic');

const goodReq = () => ({
  idempotencyKey: 'abcdefghijklmnop1234',
  confirm: true,
  customer: { name: 'Pat Runner', email: 'Pat@Example.com', phone: '' },
  fulfillment: { details: 'pickup at practice' },
  items: [{ productId: 'p1', variantId: 'm__black', quantity: 2 }],
});
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof L.HttpError && (code ? e.code === code : true));

test('valid order request is normalised', () => {
  const r = L.validateOrderRequest(goodReq(), { fulfillmentMethods: [] });
  assert.equal(r.customerEmail, 'pat@example.com');
  assert.equal(r.fulfillmentMethod, 'arranged_separately');
  assert.deepEqual(r.items, [{ productId: 'p1', variantId: 'm__black', quantity: 2 }]);
});

test('client-supplied prices are ignored entirely', () => {
  const req = goodReq();
  req.items[0].priceCents = 1; req.subtotalCents = 1;
  const r = L.validateOrderRequest(req, {});
  assert.equal('priceCents' in r.items[0], false);
  assert.equal('subtotalCents' in r, false);
});

test('rejects missing confirmation, bad email, bad key, empty cart', () => {
  let r = goodReq(); r.confirm = false; throwsCode(() => L.validateOrderRequest(r, {}), 'invalid-argument');
  r = goodReq(); r.customer.email = 'nope'; throwsCode(() => L.validateOrderRequest(r, {}), 'invalid-argument');
  r = goodReq(); r.idempotencyKey = 'short'; throwsCode(() => L.validateOrderRequest(r, {}), 'invalid-argument');
  r = goodReq(); r.items = []; throwsCode(() => L.validateOrderRequest(r, {}), 'invalid-argument');
  r = goodReq(); r.customer.name = ''; throwsCode(() => L.validateOrderRequest(r, {}), 'invalid-argument');
});

test('rejects invalid quantities', () => {
  for (const q of [0, -1, 1.5, '2', 11, NaN, null, 1e9]) {
    const r = goodReq(); r.items[0].quantity = q;
    throwsCode(() => L.validateOrderRequest(r, {}), 'invalid-argument');
  }
});

test('duplicate lines are merged and the per-line cap applies to the merged total', () => {
  const r = goodReq(); r.items = [{ productId: 'p1', variantId: 'v', quantity: 4 }, { productId: 'p1', variantId: 'v', quantity: 5 }];
  assert.equal(L.validateOrderRequest(r, {}).items[0].quantity, 9);
  r.items.push({ productId: 'p1', variantId: 'v', quantity: 5 });
  throwsCode(() => L.validateOrderRequest(r, {}));
});

test('configured fulfillment methods are enforced', () => {
  const settings = { fulfillmentMethods: [{ id: 'pickup', label: 'Pickup', requiresDetails: false }, { id: 'ship', label: 'Ship', requiresDetails: true, detailsLabel: 'Address' }] };
  let r = goodReq(); r.fulfillment = { method: 'ship', details: '' };
  throwsCode(() => L.validateOrderRequest(r, settings), 'invalid-argument'); // address required
  r.fulfillment = { method: 'drone', details: 'x' };
  throwsCode(() => L.validateOrderRequest(r, settings), 'invalid-argument');
  r.fulfillment = { method: 'pickup' };
  assert.equal(L.validateOrderRequest(r, settings).fulfillmentMethod, 'pickup');
});

const catalog = {
  'p1/a': { product: { active: true, name: 'Hoodie', priceCents: 4500 }, variant: { active: true, size: 'M', color: 'Black', sku: 'H-M-BLK' }, stock: 5 },
  'p1/b': { product: { active: true, name: 'Hoodie', priceCents: 4500 }, variant: { active: true, size: 'L', color: 'Black' }, stock: 1 },
  'p2/a': { product: { active: false, name: 'Hidden', priceCents: 100 }, variant: { active: true, size: 'S', color: 'Red' }, stock: 9 },
};
const lookup = (p, v) => catalog[`${p}/${v}`] || {};

test('prices come from authoritative data, in integer cents', () => {
  const r = L.priceOrder([{ productId: 'p1', variantId: 'a', quantity: 3 }, { productId: 'p1', variantId: 'b', quantity: 1 }], lookup);
  assert.equal(r.problems.length, 0);
  assert.equal(r.subtotalCents, 4500 * 4);
  assert.equal(r.lines[0].lineTotalCents, 13500);
  assert.equal(r.lines[0].sku, 'H-M-BLK');
  assert.equal(r.lines[1].sku, null);
});

test('reports inactive products, unknown variants and insufficient stock together', () => {
  const r = L.priceOrder([
    { productId: 'p1', variantId: 'b', quantity: 2 },
    { productId: 'p2', variantId: 'a', quantity: 1 },
    { productId: 'p1', variantId: 'zzz', quantity: 1 },
  ], lookup);
  assert.deepEqual(r.problems.map((p) => p.reason), ['insufficient_stock', 'product_unavailable', 'product_unavailable']);
  assert.equal(r.problems[0].available, 1);
  assert.equal(r.lines.length, 0);
});

test('order status transitions', () => {
  assert.ok(L.canTransition('submitted', 'confirmed'));
  assert.ok(L.canTransition('preparing', 'cancelled'));
  assert.ok(!L.canTransition('submitted', 'fulfilled'));
  assert.ok(!L.canTransition('fulfilled', 'cancelled'));
  assert.ok(!L.canTransition('cancelled', 'confirmed'));
  assert.ok(!L.canTransition('nonsense', 'confirmed'));
});

test('variant ids are stable and valid for Firestore document ids', () => {
  assert.equal(L.variantIdFor('XL', 'Heather Grey'), 'xl__heather-grey');
  assert.equal(L.variantIdFor(' M ', 'black'), 'm__black');
});

const goodProduct = () => ({
  name: 'Team Tee', description: 'Soft', priceCents: 2500, active: true,
  images: [{ url: 'https://firebasestorage.googleapis.com/v0/b/x/o/products%2Fabc%2Fa.jpg?alt=media', path: 'products/abc/a.jpg', alt: 'front' }],
  variants: [{ size: 'S', color: 'Red', stockQuantity: 3 }, { size: 'M', color: 'Red', stockQuantity: 0 }],
});

test('product validation accepts good data and rejects bad prices/duplicates/stock', () => {
  const p = L.validateProductInput(goodProduct());
  assert.equal(p.variants.length, 2);
  for (const mutate of [
    (x) => { x.priceCents = 19.99; }, (x) => { x.priceCents = -1; }, (x) => { x.name = ' '; },
    (x) => { x.variants.push({ size: 's', color: 'RED', stockQuantity: 1 }); },
    (x) => { x.variants[0].stockQuantity = -2; }, (x) => { x.variants[0].stockQuantity = 1.5; },
    (x) => { x.images[0].url = 'javascript:alert(1)'; }, (x) => { x.images[0].url = 'https://evil.example.com/a.jpg'; }, (x) => { x.images[0].url = 'http://127.0.0.1:9199/x'; }, (x) => { x.images[0].path = '../evil'; },
  ]) {
    const x = goodProduct(); mutate(x);
    throwsCode(() => L.validateProductInput(x), 'invalid-argument');
  }
});

test('order numbers and money formatting', () => {
  assert.equal(L.formatOrderNumber(7), 'THTC-00007');
  assert.equal(L.money(4505), '$45.05');
});
