'use strict';
// Integration tests: the real order/admin/mail code against the Firestore emulator.
const test = require('node:test');
const assert = require('node:assert/strict');
const { admin, wipeFirestore, fnLib } = require('./helpers');

const svc = fnLib('service');
const M = fnLib('mail');
const T = fnLib('time');
const { db } = admin();

const SITE = 'https://example.test';
const ADMIN_EMAIL = 'admin@example.test';
const ctx = (over = {}) => ({ ip: '1.1.1.1', adminEmail: ADMIN_EMAIL, siteUrl: SITE, ...over });
let n = 0;
const key = () => `key${String(++n).padStart(6, '0')}abcdefghij`;

const orderReq = (productId, variantId, quantity, over = {}) => ({
  idempotencyKey: key(),
  confirm: true,
  customer: { name: 'Pat Runner', email: `pat${n}@example.com`, phone: '' },
  fulfillment: { details: '' },
  items: [{ productId, variantId, quantity }],
  ...over,
});

async function openSchedule(opens = Date.now() - 3600e3, closes = Date.now() + 3600e3, active = true) {
  const ref = db.collection('storeSchedules').doc();
  await ref.set({ name: 'Test drop', active, opensAt: new Date(opens), closesAt: new Date(closes), createdAt: new Date(), updatedAt: new Date() });
  return ref.id;
}
async function makeProduct(over = {}) {
  const r = await svc.adminSaveProduct(db, 'adminuid', {
    name: 'Team Hoodie', description: 'Warm', priceCents: 4500, active: true, images: [],
    variants: [{ size: 'M', color: 'Black' }, { size: 'L', color: 'Black' }],
    ...over,
  });
  return r.id;
}
const M_BLACK = 'm__black';

test.beforeEach(async () => { await wipeFirestore(); });

test('product save writes public variant docs and no inventory records at all', async () => {
  const pid = await makeProduct();
  const v = (await db.doc(`products/${pid}/variants/${M_BLACK}`).get()).data();
  assert.equal(v.active, true);
  assert.equal('stockQuantity' in v, false);
  assert.equal('inStock' in v, false);
  assert.equal((await db.collection('inventory').get()).size, 0);
});

test('removing a size/color in the editor retires that variant instead of deleting it', async () => {
  const pid = await makeProduct();
  await svc.adminSaveProduct(db, 'adminuid', { id: pid, name: 'Team Hoodie', description: '', priceCents: 4500, active: true, images: [], variants: [{ size: 'M', color: 'Black' }] });
  assert.equal((await db.doc(`products/${pid}/variants/l__black`).get()).data().active, false);
  assert.equal((await db.doc(`products/${pid}/variants/${M_BLACK}`).get()).data().active, true);
});

test('successful order: authoritative pricing, order + 2 mail jobs + counter committed', async () => {
  await openSchedule();
  const pid = await makeProduct();
  const req = orderReq(pid, M_BLACK, 2);
  req.items[0].priceCents = 1; req.subtotalCents = 1; // hostile client values must be ignored
  const res = await svc.submitOrder(db, req, ctx());
  assert.equal(res.orderNumber, 'THTC-00001');
  assert.equal(res.subtotalCents, 9000);
  const orders = await db.collection('orders').get();
  assert.equal(orders.size, 1);
  const o = orders.docs[0].data();
  assert.equal(o.status, 'submitted');
  assert.equal(o.paymentStatus, 'not_collected_online');
  assert.equal(o.items[0].unitPriceCents, 4500);
  assert.equal(o.items[0].productName, 'Team Hoodie');
  const mail = await db.collection('mail').get();
  assert.deepEqual(mail.docs.map((d) => d.data().to).sort(), [ADMIN_EMAIL, req.customer.email].sort());
  const cust = mail.docs.find((d) => d.data().kind === 'customer_confirmation').data();
  assert.match(cust.text, /No payment has been collected online/);
  assert.doesNotMatch(cust.text, /\bpaid\b(?! online)/i);
  const adm = mail.docs.find((d) => d.data().kind === 'admin_new_order').data();
  assert.ok(adm.text.includes('Pat Runner') && adm.text.includes('Team Hoodie') && adm.text.includes('$90.00') && adm.text.includes(`${SITE}/admin/#order=`));
});

test('order snapshot is immutable when the product later changes', async () => {
  await openSchedule();
  const pid = await makeProduct(5);
  await svc.submitOrder(db, orderReq(pid, M_BLACK, 1), ctx());
  await svc.adminSaveProduct(db, 'adminuid', { id: pid, name: 'Renamed', description: '', priceCents: 9999, active: true, images: [], variants: [{ size: 'M', color: 'Black' }] });
  const o = (await db.collection('orders').get()).docs[0].data();
  assert.equal(o.items[0].productName, 'Team Hoodie');
  assert.equal(o.items[0].unitPriceCents, 4500);
});

test('idempotency: same key returns the same order and never creates a second one', async () => {
  await openSchedule();
  const pid = await makeProduct(5);
  const req = orderReq(pid, M_BLACK, 2);
  const a = await svc.submitOrder(db, req, ctx());
  const b = await svc.submitOrder(db, req, ctx());
  assert.equal(b.orderNumber, a.orderNumber);
  assert.equal(b.duplicate, true);
  assert.equal((await db.collection('orders').get()).size, 1);
  assert.equal((await db.collection('mail').get()).size, 2);
  // concurrent double-click
  const req2 = orderReq(pid, M_BLACK, 1);
  const [x, y] = await Promise.all([svc.submitOrder(db, req2, ctx()), svc.submitOrder(db, req2, ctx())]);
  assert.equal(x.orderNumber, y.orderNumber);
  assert.equal((await db.collection('orders').get()).size, 2);
});

test('idempotency key reused for a different cart is rejected', async () => {
  await openSchedule();
  const pid = await makeProduct(5);
  const req = orderReq(pid, M_BLACK, 1);
  await svc.submitOrder(db, req, ctx());
  await assert.rejects(svc.submitOrder(db, { ...req, items: [{ productId: pid, variantId: M_BLACK, quantity: 3 }] }, ctx()), (e) => e.code === 'already-exists');
});

test('pre-order drop: there is no stock limit, every order for an active size/color is accepted with unique order numbers', async () => {
  await openSchedule();
  const pid = await makeProduct();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => svc.submitOrder(db, orderReq(pid, M_BLACK, 9), ctx({ ip: `10.0.0.${i}` })).then((r) => r.orderNumber, (e) => e.code)));
  assert.equal(new Set(results).size, 12, JSON.stringify(results));
  assert.ok(results.every((r) => /^THTC-\d{5}$/.test(r)));
  assert.equal((await db.collection('orders').get()).size, 12);
});

test('inactive and unknown items are rejected with details; nothing is written', async () => {
  await openSchedule();
  const pid = await makeProduct();
  await assert.rejects(svc.submitOrder(db, orderReq(pid, 'xxl__pink', 1), ctx()), (e) => e.code === 'failed-precondition' && ['product_unavailable', 'variant_unavailable'].includes(e.details.problems[0].reason));
  const draft = await makeProduct({ active: false });
  await assert.rejects(svc.submitOrder(db, orderReq(draft, M_BLACK, 1), ctx()), (e) => e.details.problems[0].reason === 'product_unavailable');
  assert.equal((await db.collection('orders').get()).size, 0);
});

test('an order with one bad line is rejected as a whole', async () => {
  await openSchedule();
  const pid = await makeProduct();
  const req = orderReq(pid, M_BLACK, 1);
  req.items.push({ productId: pid, variantId: 'xxl__pink', quantity: 1 });
  await assert.rejects(svc.submitOrder(db, req, ctx()), (e) => e.code === 'failed-precondition');
  assert.equal((await db.collection('orders').get()).size, 0);
});

test('closed store: before opening, at closing instant, after closing and with no schedule', async () => {
  const pid = await makeProduct();
  const t = Date.UTC(2026, 5, 1, 15, 0, 0);
  const at = (ms) => ctx({ now: () => ms, ip: `9.9.9.${ms % 250}` });
  await assert.rejects(svc.submitOrder(db, orderReq(pid, M_BLACK, 1), at(t)), (e) => e.details.reason === 'store_closed'); // no schedule at all
  await openSchedule(t, t + 3600e3);
  await assert.rejects(svc.submitOrder(db, orderReq(pid, M_BLACK, 1), at(t - 1)), (e) => e.details.reason === 'store_closed' && e.details.nextOpensAtMillis === t);
  await assert.doesNotReject(svc.submitOrder(db, orderReq(pid, M_BLACK, 1), at(t)));          // opensAt is inclusive
  await assert.doesNotReject(svc.submitOrder(db, orderReq(pid, M_BLACK, 1), at(t + 3600e3 - 1)));
  await assert.rejects(svc.submitOrder(db, orderReq(pid, M_BLACK, 1), at(t + 3600e3)), (e) => e.details.reason === 'store_closed'); // closesAt is exclusive
  await assert.rejects(svc.submitOrder(db, orderReq(pid, M_BLACK, 1), at(t + 7200e3)), (e) => e.details.reason === 'store_closed');
  assert.equal((await db.collection('orders').get()).size, 2);
});

test('inactive schedules never open the store; schedule edits apply without redeploying', async () => {
  const pid = await makeProduct(5);
  const sid = await openSchedule(undefined, undefined, false);
  await assert.rejects(svc.submitOrder(db, orderReq(pid, M_BLACK, 1), ctx()), (e) => e.details.reason === 'store_closed');
  await db.doc(`storeSchedules/${sid}`).update({ active: true });
  await assert.doesNotReject(svc.submitOrder(db, orderReq(pid, M_BLACK, 1), ctx()));
  await db.doc(`storeSchedules/${sid}`).update({ closesAt: new Date(Date.now() - 1000) });
  await assert.rejects(svc.submitOrder(db, orderReq(pid, M_BLACK, 1), ctx()), (e) => e.details.reason === 'store_closed');
});

test('rate limiting: too many attempts from one IP', async () => {
  await openSchedule();
  const pid = await makeProduct(100);
  let limited = 0;
  for (let i = 0; i < svc.RATE.perIp + 2; i++) {
    try { await svc.submitOrder(db, orderReq(pid, M_BLACK, 1), ctx({ ip: '7.7.7.7' })); } catch (e) { if (e.code === 'resource-exhausted') limited++; }
  }
  assert.equal(limited, 2);
});

test('getStoreStatus uses server time and never invents a reopening date', async () => {
  const t = Date.UTC(2026, 5, 1, 15, 0, 0);
  assert.deepEqual(await svc.getStoreStatus(db, t), { open: false, serverNowMillis: t, scheduleName: null, closesAtMillis: null, nextOpensAtMillis: null });
  await openSchedule(t + 1000, t + 5000);
  const s = await svc.getStoreStatus(db, t);
  assert.equal(s.open, false); assert.equal(s.nextOpensAtMillis, t + 1000);
  assert.equal((await svc.getStoreStatus(db, t + 1000)).open, true);
});

/* --------------------------- admin: schedules --------------------------- */

test('schedule save converts New York wall time (DST aware), validates, and blocks overlaps', async () => {
  const a = await svc.adminSaveSchedule(db, 'u', { name: 'Spring drop', opensAtLocal: '2026-03-07T20:00', closesAtLocal: '2026-03-08T20:00', active: true });
  const d = (await db.doc(`storeSchedules/${a.id}`).get()).data();
  assert.equal(d.opensAt.toDate().toISOString(), '2026-03-08T01:00:00.000Z'); // EST
  assert.equal(d.closesAt.toDate().toISOString(), '2026-03-09T00:00:00.000Z'); // EDT
  await assert.rejects(svc.adminSaveSchedule(db, 'u', { name: 'Overlap', opensAtLocal: '2026-03-08T10:00', closesAtLocal: '2026-03-09T10:00', active: true }), (e) => e.code === 'failed-precondition' && /overlaps/.test(e.message));
  await assert.doesNotReject(svc.adminSaveSchedule(db, 'u', { name: 'Touching', opensAtLocal: '2026-03-08T20:00', closesAtLocal: '2026-03-09T20:00', active: true }));
  await assert.doesNotReject(svc.adminSaveSchedule(db, 'u', { name: 'Inactive overlap ok', opensAtLocal: '2026-03-08T10:00', closesAtLocal: '2026-03-09T10:00', active: false }));
  await assert.rejects(svc.adminSaveSchedule(db, 'u', { name: 'Backwards', opensAtLocal: '2026-04-02T10:00', closesAtLocal: '2026-04-01T10:00', active: true }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.adminSaveSchedule(db, 'u', { name: 'Gap', opensAtLocal: '2026-03-08T02:30', closesAtLocal: '2026-03-09T10:00', active: true }), (e) => /does not exist/.test(e.message));
  // edit in place keeps the id and does not conflict with itself
  await assert.doesNotReject(svc.adminSaveSchedule(db, 'u', { id: a.id, name: 'Spring drop v2', opensAtLocal: '2026-03-07T21:00', closesAtLocal: '2026-03-08T20:00', active: true }));
});

test('a currently open schedule cannot be deleted; a closed one can', async () => {
  const open = await openSchedule();
  await assert.rejects(svc.adminDeleteSchedule(db, 'u', open), (e) => e.code === 'failed-precondition');
  const past = await openSchedule(Date.now() - 7200e3, Date.now() - 3600e3);
  await assert.doesNotReject(svc.adminDeleteSchedule(db, 'u', past));
});

/* ------------------------- admin: order lifecycle ------------------------- */

async function placeOrder(qty = 2) {
  await openSchedule();
  const pid = await makeProduct();
  const res = await svc.submitOrder(db, orderReq(pid, M_BLACK, qty), ctx());
  const order = (await db.collection('orders').get()).docs[0];
  return { pid, orderId: order.id, res };
}

test('status transitions are validated; status emails never claim payment/shipping', async () => {
  const { orderId } = await placeOrder();
  await assert.rejects(svc.adminUpdateOrderStatus(db, 'u', orderId, 'fulfilled'), (e) => e.code === 'failed-precondition');
  for (const s of ['confirmed', 'preparing', 'ready', 'fulfilled']) await svc.adminUpdateOrderStatus(db, 'u', orderId, s);
  await assert.rejects(svc.adminUpdateOrderStatus(db, 'u', orderId, 'cancelled'), (e) => e.code === 'failed-precondition');
  await assert.rejects(svc.adminUpdateOrderStatus(db, 'u', orderId, 'bogus'), (e) => e.code === 'invalid-argument');
  const o = (await db.doc(`orders/${orderId}`).get()).data();
  assert.deepEqual(o.statusHistory.map((h) => h.status), ['submitted', 'confirmed', 'preparing', 'ready', 'fulfilled']);
  assert.equal(o.paymentStatus, 'not_collected_online');
  const statusMail = (await db.collection('mail').where('kind', '==', 'customer_status').get()).docs.map((d) => d.data());
  assert.equal(statusMail.length, 4);
  for (const m of statusMail) assert.doesNotMatch(m.text, /shipped|delivered|has been paid|payment received/i);
});

test('cancelling is final and emails the customer; a cancelled order cannot change again', async () => {
  const { orderId } = await placeOrder();
  await svc.adminUpdateOrderStatus(db, 'u', orderId, 'cancelled');
  await assert.rejects(svc.adminUpdateOrderStatus(db, 'u', orderId, 'cancelled'), (e) => e.code === 'failed-precondition');
  await assert.rejects(svc.adminUpdateOrderStatus(db, 'u', orderId, 'confirmed'), (e) => e.code === 'failed-precondition');
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().status, 'cancelled');
  assert.equal((await db.collection('mail').where('kind', '==', 'customer_status').get()).size, 1);
});

test('payment is recorded by an admin only: needs a method, is reversible, and a cancelled order cannot be marked paid', async () => {
  const { orderId } = await placeOrder();
  let o = (await db.doc(`orders/${orderId}`).get()).data();
  assert.equal(o.paid, false);
  assert.equal(o.paymentStatus, 'not_collected_online');
  await assert.rejects(svc.adminSetOrderPayment(db, 'u', orderId, { paid: true }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.adminSetOrderPayment(db, 'u', orderId, { paid: true, method: 'bitcoin' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.adminSetOrderPayment(db, 'u', orderId, { paid: 'yes', method: 'cash' }), (e) => e.code === 'invalid-argument');
  const r = await svc.adminSetOrderPayment(db, 'u', orderId, { paid: true, method: 'venmo' }, () => 1700000000000);
  assert.deepEqual(r, { paid: true, paymentMethod: 'venmo', paidAtMillis: 1700000000000 });
  o = (await db.doc(`orders/${orderId}`).get()).data();
  assert.equal(o.paid, true); assert.equal(o.paymentMethod, 'venmo'); assert.equal(o.status, 'submitted');
  await svc.adminSetOrderPayment(db, 'u', orderId, { paid: false, method: null });
  o = (await db.doc(`orders/${orderId}`).get()).data();
  assert.equal(o.paid, false); assert.equal(o.paymentMethod, null); assert.equal(o.paidAtMillis, null);
  assert.equal(o.paymentHistory.length, 2);
  await svc.adminUpdateOrderStatus(db, 'u', orderId, 'cancelled');
  await assert.rejects(svc.adminSetOrderPayment(db, 'u', orderId, { paid: true, method: 'cash' }), (e) => e.code === 'failed-precondition');
  await assert.rejects(svc.adminSetOrderPayment(db, 'u', 'doesnotexist1', { paid: false }), (e) => e.code === 'not-found');
});

test('an order can be deleted completely, together with its email records; nothing else is touched', async () => {
  const { orderId, pid } = await placeOrder();
  await svc.submitOrder(db, orderReq(pid, M_BLACK, 1), ctx({ ip: '4.4.4.4' }));       // a second order that must survive
  assert.equal((await db.collection('orders').get()).size, 2);
  const out = await svc.adminDeleteOrder(db, orderId);
  assert.equal(out.deleted, true);
  assert.equal((await db.doc(`orders/${orderId}`).get()).exists, false);
  assert.equal((await db.collection('mail').where('orderId', '==', orderId).get()).size, 0);
  assert.equal((await db.collection('orders').get()).size, 1);
  assert.equal((await db.collection('mail').get()).size, 2);
  await assert.rejects(svc.adminDeleteOrder(db, orderId), (e) => e.code === 'not-found');
  await assert.rejects(svc.adminDeleteOrder(db, '../x'), (e) => e.code === 'invalid-argument');
});

/* --------------------------------- mail queue --------------------------------- */

const okSend = (log = []) => async (job) => { log.push(job.id); return { accepted: [job.to], rejected: [], messageId: `<${job.id}@t>` }; };

test('mail: delivered after the order is committed, marked sent only when SMTP accepts', async () => {
  const { orderId } = await placeOrder();
  const log = [];
  const id = `${orderId}_customer`;
  assert.equal((await db.doc(`mail/${id}`).get()).data().status, 'pending');
  await M.processMail(db, id, okSend(log), { logger: { warn() {} } });
  const m = (await db.doc(`mail/${id}`).get()).data();
  assert.equal(m.status, 'sent');
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().notificationStatus.customer, 'sent');
  // a second delivery attempt for a sent job does nothing (no duplicate email)
  await M.processMail(db, id, okSend(log), { logger: { warn() {} } });
  assert.equal(log.length, 1);
});

test('mail: concurrent workers send a job only once', async () => {
  const { orderId } = await placeOrder();
  const log = [];
  const slow = async (job) => { await new Promise((r) => setTimeout(r, 150)); return okSend(log)(job); };
  const id = `${orderId}_admin`;
  await Promise.all([1, 2, 3, 4].map(() => M.processMail(db, id, slow, { logger: { warn() {} } })));
  assert.equal(log.length, 1);
});

test('mail: failures back off, retry later, and fail permanently after the maximum attempts', async () => {
  const { orderId } = await placeOrder();
  const id = `${orderId}_customer`;
  const failing = async () => { throw new Error('SMTP down'); };
  const quiet = { warn() {} };
  let now = Date.now();
  await M.processMail(db, id, failing, { now: () => now, logger: quiet });
  let m = (await db.doc(`mail/${id}`).get()).data();
  assert.equal(m.status, 'pending'); assert.equal(m.attempts, 1); assert.match(m.lastError, /SMTP down/);
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().notificationStatus.customer, 'retrying');
  // too early: not retried
  const early = await M.processMail(db, id, okSend(), { now: () => now + 1000, logger: quiet });
  assert.equal(early.skipped, true);
  // after backoff: succeeds
  await M.processMail(db, id, okSend(), { now: () => now + 61e3, logger: quiet });
  assert.equal((await db.doc(`mail/${id}`).get()).data().status, 'sent');

  // permanent failure
  const id2 = `${orderId}_admin`;
  for (let i = 0; i < M.MAX_ATTEMPTS; i++) { now += 3600e3 + 1; await M.processMail(db, id2, failing, { now: () => now, logger: quiet }); }
  m = (await db.doc(`mail/${id2}`).get()).data();
  assert.equal(m.status, 'failed');
  assert.equal((await db.doc(`orders/${orderId}`).get()).data().notificationStatus.admin, 'failed');
  assert.equal((await M.processMail(db, id2, okSend(), { now: () => now + 9e9, logger: quiet })).skipped, true);
  // admin can manually requeue a failed email
  await svc.adminResendMail(db, id2);
  await M.processMail(db, id2, okSend(), { logger: quiet });
  assert.equal((await db.doc(`mail/${id2}`).get()).data().status, 'sent');
});

test('mail: an SMTP server that rejects the recipient is not reported as delivered', async () => {
  const { orderId } = await placeOrder();
  const id = `${orderId}_customer`;
  await M.processMail(db, id, async (job) => ({ accepted: [], rejected: [job.to], messageId: 'x' }), { logger: { warn() {} } });
  assert.equal((await db.doc(`mail/${id}`).get()).data().status, 'pending');
});

test('mail: a crashed worker (expired lease) is picked up again', async () => {
  const { orderId } = await placeOrder();
  const id = `${orderId}_customer`;
  const now = Date.now();
  await db.doc(`mail/${id}`).update({ status: 'sending', leaseUntilMillis: now - 1, attempts: 1 });
  await M.processMail(db, id, okSend(), { now: () => now, logger: { warn() {} } });
  assert.equal((await db.doc(`mail/${id}`).get()).data().status, 'sent');
});

test('mail templates escape HTML from customer-controlled fields', async () => {
  const html = M.customerConfirmation({ customerName: '<script>alert(1)</script>', orderNumber: 'THTC-00001', items: [{ productName: '<b>x</b>', size: 'M', color: 'Red', quantity: 1, unitPriceCents: 100, lineTotalCents: 100 }], subtotalCents: 100 }).html;
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

/* ---------------------------- settings / fulfillment ---------------------------- */

test('fulfillment options are admin-configurable and enforced at checkout', async () => {
  await openSchedule();
  const pid = await makeProduct(5);
  await svc.adminSaveSettings(db, 'u', { fulfillmentMethods: [{ id: 'pickup', label: 'Local pickup', requiresDetails: false }, { id: 'ship', label: 'Ship', requiresDetails: true, detailsLabel: 'Address' }], checkoutNotice: '' });
  await assert.rejects(svc.submitOrder(db, orderReq(pid, M_BLACK, 1), ctx()), (e) => e.code === 'invalid-argument');
  await assert.doesNotReject(svc.submitOrder(db, orderReq(pid, M_BLACK, 1, { fulfillment: { method: 'pickup' } }), ctx()));
  await assert.rejects(svc.submitOrder(db, orderReq(pid, M_BLACK, 1, { fulfillment: { method: 'ship' } }), ctx({ ip: '3.3.3.3' })), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.adminSaveSettings(db, 'u', { fulfillmentMethods: [{ id: 'Bad Id!', label: 'x' }] }), (e) => e.code === 'invalid-argument');
});

/* --------------------------- Make.com email webhook --------------------------- */

test('webhook config: saved privately, returned only masked, validated, clearable', async () => {
  const hint = await svc.adminSaveMailWebhook(db, 'u', { url: 'https://hook.us1.make.com/abcdefghijSECRET9876', token: 'topsecret' });
  assert.deepEqual(hint, { configured: true, host: 'hook.us1.make.com', hint: '...9876', tokenSet: true });
  const got = await svc.adminGetMailConfig(db);
  assert.equal(got.configured, true);
  assert.doesNotMatch(JSON.stringify(got), /SECRET|topsecret/);
  await assert.rejects(svc.adminSaveMailWebhook(db, 'u', { url: 'https://evil.example.com/abcdefghij' }), (e) => e.code === 'invalid-argument');
  assert.equal((await svc.getMailWebhook(db)).url, 'https://hook.us1.make.com/abcdefghijSECRET9876'); // bad save did not overwrite
  await svc.adminSaveMailWebhook(db, 'u', { clear: true });
  assert.equal((await svc.adminGetMailConfig(db)).configured, false);
});

test('webhook test email goes straight through and reports failures to the admin', async () => {
  const sent = [];
  await svc.adminSendTestMail(db, ADMIN_EMAIL, async (job) => { sent.push(job); });
  assert.equal(sent[0].to, ADMIN_EMAIL); assert.equal(sent[0].kind, 'test');
  await assert.rejects(svc.adminSendTestMail(db, ADMIN_EMAIL, async () => { throw new Error('Make webhook answered 410'); }), (e) => e.code === 'failed-precondition' && /410/.test(e.message));
});

test('end to end: an order\'s emails are POSTed to the configured webhook; before configuration they wait and retry', async () => {
  const http = require('node:http');
  const W = fnLib('webhook');
  const received = [];
  const server = await new Promise((resolve) => { const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { received.push({ key: req.headers['x-make-apikey'], body: JSON.parse(b) }); res.end('Accepted'); }); }).listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  const send = async (job) => W.sendViaWebhook(job, await svc.getMailWebhook(db));

  await openSchedule();
  const pid = await makeProduct(5);
  await svc.submitOrder(db, orderReq(pid, M_BLACK, 1), ctx());
  const jobs = (await db.collection('mail').get()).docs.map((d) => d.id);
  const quiet = { warn() {} };

  // not configured yet: the job is kept and retried, the order is unaffected
  await M.processMail(db, jobs[0], send, { logger: quiet });
  let m = (await db.doc(`mail/${jobs[0]}`).get()).data();
  assert.equal(m.status, 'pending'); assert.match(m.lastError, /not configured/);
  assert.equal((await db.collection('orders').get()).size, 1);

  // configure (the real save validates Make URLs; write the local test URL directly), then the retry delivers
  await db.collection('private').doc('mailWebhook').set({ url, token: 'abc' });
  for (const id of jobs) await db.doc(`mail/${id}`).update({ nextAttemptAtMillis: 0 });
  for (const id of jobs) await M.processMail(db, id, send, { logger: quiet });
  server.close();
  assert.equal(received.length, 2);
  assert.deepEqual(received.map((r) => r.body.kind).sort(), ['admin_new_order', 'customer_confirmation']);
  assert.ok(received.every((r) => r.key === 'abc' && r.body.html.includes('THTC-00001') === (r.body.kind !== 'x')));
  for (const id of jobs) assert.equal((await db.doc(`mail/${id}`).get()).data().status, 'sent');
});
