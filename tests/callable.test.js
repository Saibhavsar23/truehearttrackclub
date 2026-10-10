'use strict';
// End-to-end checks of the DEPLOYED-SHAPE callable functions (functions emulator + auth emulator):
// proves server-side admin authorization, not just the helper code behind it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { admin, wipeFirestore, PROJECT } = require('./helpers');

const FN = `http://127.0.0.1:5001/${PROJECT}/us-east1`;
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;
const { auth, db } = admin();

async function call(name, data, token) {
  const res = await fetch(`${FN}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return { http: res.status, body: await res.json() };
}
async function signUp(email) {
  const r = await fetch(`${AUTH}/accounts:signUp?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-9', returnSecureToken: true }) });
  return r.json();
}
async function signIn(email) {
  const r = await fetch(`${AUTH}/accounts:signInWithPassword?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-9', returnSecureToken: true }) });
  return (await r.json()).idToken;
}

const product = () => ({ name: 'Callable Tee', description: '', priceCents: 2000, active: true, images: [], variants: [{ size: 'M', color: 'Red' }] });

test.before(async () => { await wipeFirestore(); });

test('admin operations reject anonymous callers', async () => {
  for (const fn of ['adminSaveProduct', 'adminSaveSchedule', 'adminDeleteSchedule', 'adminSaveSettings', 'adminUpdateOrderStatus', 'adminDeleteOrder', 'adminResendMail', 'adminGetMailConfig', 'adminSaveMailWebhook', 'adminSendTestMail']) {
    const r = await call(fn, {});
    assert.equal(r.body.error && r.body.error.status, 'PERMISSION_DENIED', fn);
  }
});

test('admin operations reject garbage tokens', async () => {
  const r = await call('adminSaveProduct', product(), 'not-a-real-token');
  assert.ok(['UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(r.body.error.status), r.body.error.status);
});

test('a signed-in non-admin cannot use admin operations or grant themselves admin', async () => {
  const u = await signUp('visitor@example.com');
  const r = await call('adminSaveProduct', product(), u.idToken);
  assert.equal(r.body.error.status, 'PERMISSION_DENIED');
  // forged client-side hints do nothing: the data payload cannot confer admin
  const r2 = await call('adminSaveProduct', { ...product(), admin: true, token: { admin: true } }, u.idToken);
  assert.equal(r2.body.error.status, 'PERMISSION_DENIED');
  assert.equal((await db.collection('products').get()).size, 0);
});

test('an administrator (custom claim) succeeds, and removing the claim takes effect immediately', async () => {
  const u = await signUp('boss@example.com');
  await auth.setCustomUserClaims(u.localId, { admin: true });
  const token = await signIn('boss@example.com'); // token now carries admin:true
  const ok = await call('adminSaveProduct', product(), token);
  assert.ok(ok.body.result && ok.body.result.id, JSON.stringify(ok.body));
  assert.equal((await db.collection('products').get()).size, 1);

  await auth.setCustomUserClaims(u.localId, {}); // revoke; the old ID token still says admin:true
  const denied = await call('adminSaveProduct', product(), token);
  assert.equal(denied.body.error.status, 'PERMISSION_DENIED');

  await auth.setCustomUserClaims(u.localId, { admin: true });
  await auth.updateUser(u.localId, { disabled: true });
  const disabled = await call('adminSaveProduct', product(), token);
  assert.ok(disabled.body.error, 'disabled admin must be rejected');
});

test('public callables: closed store status and order rejection reach the browser with a machine-readable reason', async () => {
  const s = await call('getStoreStatus', {});
  assert.equal(s.body.result.open, false);
  assert.equal(s.body.result.nextOpensAtMillis, null);
  const pid = (await db.collection('products').get()).docs[0].id;
  const r = await call('submitOrder', {
    idempotencyKey: 'callable-test-key-0001', confirm: true,
    customer: { name: 'Pat', email: 'pat@example.com' }, fulfillment: {}, items: [{ productId: pid, variantId: 'm__red', quantity: 1 }],
  });
  assert.equal(r.body.error.status, 'FAILED_PRECONDITION');
  assert.equal(r.body.error.details.reason, 'store_closed');
});

test('submitOrder through the callable succeeds while open, and a hostile payload is refused', async () => {
  const pid = (await db.collection('products').get()).docs[0].id;
  await db.collection('storeSchedules').add({ name: 'Live', active: true, opensAt: new Date(Date.now() - 1000), closesAt: new Date(Date.now() + 3600e3) });
  const bad = await call('submitOrder', { idempotencyKey: 'x', confirm: true, items: [] });
  assert.equal(bad.body.error.status, 'INVALID_ARGUMENT');
  const good = await call('submitOrder', {
    idempotencyKey: 'callable-test-key-0002', confirm: true,
    customer: { name: 'Pat Runner', email: 'pat@example.com' }, fulfillment: {}, items: [{ productId: pid, variantId: 'm__red', quantity: 2, priceCents: 1 }],
  });
  assert.equal(good.body.result.subtotalCents, 4000);
  assert.equal(good.body.result.orderNumber, 'THTC-00001');
  assert.equal((await db.collection('orders').get()).size, 1);
});

test('admin can store the Make webhook; it is validated server-side and never echoed back', async () => {
  const u = await signUp('mailadmin@example.com');
  await auth.setCustomUserClaims(u.localId, { admin: true });
  const token = await signIn('mailadmin@example.com');
  const bad = await call('adminSaveMailWebhook', { url: 'https://evil.example.com/abcdefghij' }, token);
  assert.equal(bad.body.error.status, 'INVALID_ARGUMENT');
  const ok = await call('adminSaveMailWebhook', { url: 'https://hook.us1.make.com/abcdefghijWXYZ', token: 'k' }, token);
  assert.deepEqual(ok.body.result, { configured: true, host: 'hook.us1.make.com', hint: '...WXYZ', tokenSet: true });
  const got = await call('adminGetMailConfig', {}, token);
  assert.equal(got.body.result.hint, '...WXYZ');
  assert.doesNotMatch(JSON.stringify(got.body), /abcdefghij/);
  const stored = (await db.doc('private/mailWebhook').get()).data();
  assert.equal(stored.url, 'https://hook.us1.make.com/abcdefghijWXYZ');
  // a normal signed-in user cannot read or change it
  const v = await signUp('nobody@example.com');
  assert.equal((await call('adminGetMailConfig', {}, v.idToken)).body.error.status, 'PERMISSION_DENIED');
  assert.equal((await call('adminSaveMailWebhook', { url: 'https://hook.us1.make.com/abcdefghijWXYZ' }, v.idToken)).body.error.status, 'PERMISSION_DENIED');
});