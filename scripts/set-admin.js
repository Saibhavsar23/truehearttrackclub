#!/usr/bin/env node
'use strict';
/**
 * Grant or revoke administrator access (Firebase Auth custom claim `admin`).
 * This is the ONLY way to create an admin: there is no public registration path and no Firestore field that grants access.
 *
 *   node scripts/set-admin.js add    person@example.com
 *   node scripts/set-admin.js remove person@example.com
 *   node scripts/set-admin.js list
 *
 * Requires Application Default Credentials for the project (see README: "Adding and removing administrators").
 * Set the project with GOOGLE_CLOUD_PROJECT or --project=<id>.
 */
const path = require('node:path');
const req = require('node:module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
const { initializeApp } = req('firebase-admin/app');
const { getAuth } = req('firebase-admin/auth');

const args = process.argv.slice(2);
const projectArg = args.find((a) => a.startsWith('--project='));
const positional = args.filter((a) => !a.startsWith('--'));
const [action, email] = positional;
const projectId = projectArg ? projectArg.split('=')[1] : (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT);

if (!projectId) { console.error('Set the project: --project=<firebase-project-id> or GOOGLE_CLOUD_PROJECT.'); process.exit(1); }
if (!['add', 'remove', 'list'].includes(action) || (action !== 'list' && !email)) {
  console.error('Usage: node scripts/set-admin.js <add|remove> <email> [--project=<id>]\n       node scripts/set-admin.js list [--project=<id>]');
  process.exit(1);
}

initializeApp({ projectId });
const auth = getAuth();

(async () => {
  if (action === 'list') {
    let token; let found = 0;
    do {
      const page = await auth.listUsers(1000, token);
      for (const u of page.users) if (u.customClaims && u.customClaims.admin === true) { console.log(`${u.email || u.uid}${u.disabled ? '  (disabled)' : ''}`); found++; }
      token = page.pageToken;
    } while (token);
    if (!found) console.log('No administrators.');
    return;
  }
  const user = await auth.getUserByEmail(email).catch((e) => { if (e && e.code === 'auth/user-not-found') return null; throw e; });
  if (!user) { console.error(`No Firebase Auth user with email ${email}. Create the user first (Firebase console > Authentication > Users > Add user).`); process.exit(1); }
  const claims = { ...(user.customClaims || {}) };
  if (action === 'add') {
    claims.admin = true;
    await auth.setCustomUserClaims(user.uid, claims);
    console.log(`${email} is now an administrator. They must sign out and back in (or wait up to 1 hour) for their browser session to pick it up.`);
  } else {
    delete claims.admin;
    await auth.setCustomUserClaims(user.uid, claims);
    await auth.revokeRefreshTokens(user.uid);
    console.log(`${email} is no longer an administrator. Server operations are blocked immediately; their existing sessions are revoked.`);
  }
})().catch((e) => {
  console.error(e.message);
  if (/credential|default credentials|permission|403|401|ADC/i.test(String(e.message) + String(e.code))) console.error('\nThis looks like a credentials problem, not a missing user. Run:  gcloud auth application-default login   (then retry)');
  process.exit(1);
});
