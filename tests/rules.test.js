'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { setLogLevel, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, addDoc } = require('firebase/firestore');
const { ref, uploadBytes, getBytes } = require('firebase/storage');
const { PROJECT } = require('./helpers');

setLogLevel('silent');
let env;
const root = path.join(__dirname, '..');

test.before(async () => {
  const [fh, fp] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const [sh, sp] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':');
  env = await initializeTestEnvironment({
    projectId: PROJECT + '-rules',
    firestore: { host: fh, port: Number(fp), rules: fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8') },
    storage: { host: sh, port: Number(sp), rules: fs.readFileSync(path.join(root, 'storage.rules'), 'utf8') },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'products/live'), { name: 'Live', active: true, priceCents: 1000 });
    await setDoc(doc(db, 'products/live/variants/m__red'), { size: 'M', color: 'Red', active: true, inStock: true });
    await setDoc(doc(db, 'products/live/variants/old__red'), { size: 'Old', color: 'Red', active: false, inStock: false });
    await setDoc(doc(db, 'products/draft'), { name: 'Draft', active: false, priceCents: 1000 });
    await setDoc(doc(db, 'products/draft/variants/m__red'), { size: 'M', color: 'Red', active: true, inStock: true });
    await setDoc(doc(db, 'inventory/live__m__red'), { stockQuantity: 5 });
    await setDoc(doc(db, 'orders/o1'), { customerEmail: 'a@b.com', customerName: 'Secret Person', status: 'submitted' });
    await setDoc(doc(db, 'mail/m1'), { to: 'a@b.com' });
    await setDoc(doc(db, 'storeSchedules/s1'), { name: 'Drop', active: true });
    await setDoc(doc(db, 'settings/public'), { fulfillmentMethods: [] });
    await setDoc(doc(db, 'counters/orders'), { next: 4 });
    await setDoc(doc(db, 'idempotency/x'), { a: 1 });
    await setDoc(doc(db, 'rateLimits/x'), { a: 1 });
  });
});
test.after(async () => { await env.cleanup(); });

const anon = () => env.unauthenticatedContext().firestore();
const user = () => env.authenticatedContext('u1', { email: 'u@example.com' }).firestore();
const admin = () => env.authenticatedContext('a1', { admin: true }).firestore();
const fakeAdminClaimFalse = () => env.authenticatedContext('a2', { admin: false }).firestore();

test('public can read active products and active variants only', async () => {
  await assertSucceeds(getDoc(doc(anon(), 'products/live')));
  await assertSucceeds(getDocs(query(collection(anon(), 'products'), where('active', '==', true))));
  await assertFails(getDoc(doc(anon(), 'products/draft')));
  await assertFails(getDocs(collection(anon(), 'products'))); // unfiltered list would include inactive products
  await assertSucceeds(getDoc(doc(anon(), 'products/live/variants/m__red')));
  await assertFails(getDoc(doc(anon(), 'products/live/variants/old__red')));
  await assertFails(getDoc(doc(anon(), 'products/draft/variants/m__red'))); // variant of an inactive product
});

test('public cannot read stock counts, orders, customer info, mail, schedules or internals', async () => {
  for (const p of ['inventory/live__m__red', 'orders/o1', 'mail/m1', 'storeSchedules/s1', 'counters/orders', 'idempotency/x', 'rateLimits/x']) {
    await assertFails(getDoc(doc(anon(), p)));
    await assertFails(getDoc(doc(user(), p)));
    await assertFails(getDoc(doc(fakeAdminClaimFalse(), p)));
  }
  await assertFails(getDocs(collection(anon(), 'orders')));
  await assertFails(getDocs(collection(user(), 'orders')));
});

test('public settings are readable', async () => {
  await assertSucceeds(getDoc(doc(anon(), 'settings/public')));
});

test('nobody can write from the client: prices, stock, schedules, statuses, orders, settings', async () => {
  for (const [label, db] of [['anon', anon()], ['user', user()], ['admin', admin()]]) {
    await assertFails(setDoc(doc(db, 'products/live'), { name: 'Hacked', active: true, priceCents: 1 }));
    await assertFails(updateDoc(doc(db, 'products/live'), { priceCents: 1 }));
    await assertFails(setDoc(doc(db, 'products/live/variants/m__red'), { inStock: true }));
    await assertFails(updateDoc(doc(db, 'inventory/live__m__red'), { stockQuantity: 9999 }));
    await assertFails(setDoc(doc(db, 'storeSchedules/s2'), { active: true }));
    await assertFails(updateDoc(doc(db, 'storeSchedules/s1'), { active: false }));
    await assertFails(updateDoc(doc(db, 'orders/o1'), { status: 'fulfilled' }));
    await assertFails(addDoc(collection(db, 'orders'), { status: 'submitted', subtotalCents: 1 }));
    await assertFails(deleteDoc(doc(db, 'orders/o1')));
    await assertFails(setDoc(doc(db, 'settings/public'), { fulfillmentMethods: [] }));
    await assertFails(addDoc(collection(db, 'mail'), { to: 'victim@example.com', subject: 'spam' }));
    await assertFails(setDoc(doc(db, 'counters/orders'), { next: 1 }));
    await assertFails(setDoc(doc(db, 'users/u1'), { admin: true })); // no self-service admin flag exists anywhere
  }
});

test('a user cannot grant themselves admin through a field on their own document', async () => {
  await assertFails(setDoc(doc(user(), 'users/u1'), { admin: true, role: 'admin' }));
  await assertFails(setDoc(doc(user(), 'admins/u1'), { admin: true }));
  await assertFails(getDocs(collection(user(), 'orders')));
});

test('admin claim can read operational data', async () => {
  for (const p of ['inventory/live__m__red', 'orders/o1', 'mail/m1', 'storeSchedules/s1', 'products/draft', 'products/draft/variants/m__red']) {
    await assertSucceeds(getDoc(doc(admin(), p)));
  }
  await assertSucceeds(getDocs(collection(admin(), 'orders')));
  await assertFails(getDoc(doc(admin(), 'counters/orders'))); // internals stay server-only even for admins
});

test('storage: public can read product photos; only admins can upload small images', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), 'products/live/a.png'), new Uint8Array([1, 2, 3]), { contentType: 'image/png' });
  });
  const png = new Uint8Array([137, 80, 78, 71]);
  await assertSucceeds(getBytes(ref(env.unauthenticatedContext().storage(), 'products/live/a.png')));
  await assertFails(uploadBytes(ref(env.unauthenticatedContext().storage(), 'products/live/b.png'), png, { contentType: 'image/png' }));
  await assertFails(uploadBytes(ref(env.authenticatedContext('u1').storage(), 'products/live/b.png'), png, { contentType: 'image/png' }));
  const adminStorage = env.authenticatedContext('a1', { admin: true }).storage();
  await assertSucceeds(uploadBytes(ref(adminStorage, 'products/live/b.png'), png, { contentType: 'image/png' }));
  await assertFails(uploadBytes(ref(adminStorage, 'products/live/c.html'), png, { contentType: 'text/html' }));
  await assertFails(uploadBytes(ref(adminStorage, 'elsewhere/x.png'), png, { contentType: 'image/png' }));
  await assertFails(uploadBytes(ref(adminStorage, 'products/live/big.png'), new Uint8Array(5 * 1024 * 1024 + 1), { contentType: 'image/png' }));
});
