'use strict';
// Shared helpers for emulator tests. Uses the same firebase-admin copy the functions use.
const path = require('node:path');
const fnRequire = require('node:module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp, getApps } = fnRequire('firebase-admin/app');
const { getFirestore } = fnRequire('firebase-admin/firestore');
const { getAuth } = fnRequire('firebase-admin/auth');

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-thtc-store';

function admin() {
  if (!getApps().length) initializeApp({ projectId: PROJECT });
  return { db: getFirestore(), auth: getAuth() };
}

async function wipeFirestore() {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  await fetch(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
}

module.exports = { admin, wipeFirestore, PROJECT, fnLib: (n) => require(path.join(__dirname, '..', 'functions', 'lib', n)) };
