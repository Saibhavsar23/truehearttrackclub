#!/usr/bin/env node
'use strict';
/**
 * DEV ONLY: fills the Firebase EMULATORS with demo data so you can click through the shop and admin locally.
 * Refuses to run unless the Firestore emulator is configured, so it can never touch your real project.
 *   firebase emulators:start --only auth,firestore,functions,storage   (terminal 1)
 *   node scripts/seed-emulator.js                                       (terminal 2)
 */
const path = require('node:path');
if (!process.env.FIRESTORE_EMULATOR_HOST) process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const req = require('node:module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = req('firebase-admin/app');
const { getFirestore } = req('firebase-admin/firestore');
const { getAuth } = req('firebase-admin/auth');
const svc = require('../functions/lib/service');

const PROJECT = 'demo-thtc-store';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

(async () => {
  const email = 'admin@example.test'; const password = 'emulator-admin-1';
  let u = await auth.getUserByEmail(email).catch(() => null);
  if (!u) u = await auth.createUser({ email, password });
  await auth.setCustomUserClaims(u.uid, { admin: true });
  console.log(`Admin (emulator only): ${email} / ${password}`);

  const open = process.argv.includes('--closed') ? null : Date.now();
  if (open) await db.collection('storeSchedules').add({ name: 'Emulator demo drop', active: true, opensAt: new Date(open - 3600e3), closesAt: new Date(open + 7 * 24 * 3600e3), createdAt: new Date(), updatedAt: new Date() });
  else await db.collection('storeSchedules').add({ name: 'Emulator future drop', active: true, opensAt: new Date(Date.now() + 2 * 24 * 3600e3 + 5000), closesAt: new Date(Date.now() + 9 * 24 * 3600e3), createdAt: new Date(), updatedAt: new Date() });

  if (!process.argv.includes('--empty')) {
    await svc.adminSaveProduct(db, u.uid, { name: 'DEMO Team Hoodie', description: 'Emulator demo product (not real merchandise).', priceCents: 4500, active: true, featured: true, images: [], variants: [
      { size: 'S', color: 'Black' }, { size: 'M', color: 'Black' }, { size: 'L', color: 'Black' }, { size: 'M', color: 'White' }] });
    await svc.adminSaveProduct(db, u.uid, { name: 'DEMO Tee', description: 'Emulator demo product.', priceCents: 2500, active: true, images: [], variants: [{ size: 'M', color: 'Red' }] });
  }
  console.log('Seeded emulator data.');
})().catch((e) => { console.error(e); process.exit(1); });
