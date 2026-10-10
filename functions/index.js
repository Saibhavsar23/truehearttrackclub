'use strict';
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineString, defineBoolean } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

const svc = require('./lib/service');
const M = require('./lib/mail');
const W = require('./lib/webhook');
const { HttpError } = require('./lib/logic');

initializeApp();
const db = getFirestore();

// ---- configuration (all non-secret; the Make webhook URL lives in a private Firestore doc set from Admin > Settings) ----
const ADMIN_EMAIL = defineString('ADMIN_EMAIL', { default: 'truehearttrackclub@gmail.com' });
const SITE_URL = defineString('SITE_URL', { default: '' });
const ENFORCE_APP_CHECK = defineBoolean('ENFORCE_APP_CHECK', { default: false });

const REGION = 'us-east1';
const base = { region: REGION, maxInstances: 10 };

/** Convert domain errors to the HttpsError the client SDK understands. */
function wrap(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (e) {
      if (e instanceof HttpError) throw new HttpsError(e.code, e.message, e.details);
      if (e instanceof HttpsError) throw e;
      logger.error('unhandled', e);
      throw new HttpsError('internal', 'Something went wrong on our side. Please try again.');
    }
  };
}

function checkAppCheck(request) {
  if (ENFORCE_APP_CHECK.value() && !request.app) throw new HttpsError('failed-precondition', 'App Check verification failed. Reload the page and try again.');
}

/**
 * Server-side admin authorization. The ID-token claim is a fast first check, then the live user record is
 * re-read so that removing an admin takes effect immediately for every privileged operation.
 */
async function requireAdmin(request) {
  checkAppCheck(request);
  if (!request.auth || request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Administrator access required.');
  const user = await getAuth().getUser(request.auth.uid);
  if (user.disabled || !user.customClaims || user.customClaims.admin !== true) throw new HttpsError('permission-denied', 'Administrator access required.');
  return request.auth.uid;
}

// ----------------------------------- public -----------------------------------

exports.getStoreStatus = onCall(base, wrap(async (request) => {
  checkAppCheck(request);
  return svc.getStoreStatus(db);
}));

exports.submitOrder = onCall(base, wrap(async (request) => {
  checkAppCheck(request);
  const ip = (request.rawRequest && (request.rawRequest.headers['x-forwarded-for'] || request.rawRequest.ip)) || 'unknown';
  return svc.submitOrder(db, request.data, {
    ip: String(ip).split(',')[0].trim(),
    adminEmail: ADMIN_EMAIL.value(),
    siteUrl: SITE_URL.value(),
  });
}));

// ------------------------------------ admin ------------------------------------

exports.adminSaveProduct = onCall(base, wrap(async (request) => svc.adminSaveProduct(db, await requireAdmin(request), request.data)));
exports.adminSaveSchedule = onCall(base, wrap(async (request) => svc.adminSaveSchedule(db, await requireAdmin(request), request.data)));
exports.adminDeleteSchedule = onCall(base, wrap(async (request) => svc.adminDeleteSchedule(db, await requireAdmin(request), request.data && request.data.id)));
exports.adminSaveSettings = onCall(base, wrap(async (request) => svc.adminSaveSettings(db, await requireAdmin(request), request.data)));
exports.adminUpdateOrderStatus = onCall(base, wrap(async (request) => {
  const uid = await requireAdmin(request);
  return svc.adminUpdateOrderStatus(db, uid, request.data && request.data.orderId, request.data && request.data.status);
}));
exports.adminResendMail = onCall(base, wrap(async (request) => {
  await requireAdmin(request);
  const id = request.data && request.data.mailId;
  const out = await svc.adminResendMail(db, id);
  await M.processMail(db, id, send, { logger });
  return out;
}));

// ------------------------------------- mail (Make.com webhook) -------------------------------------

exports.adminGetMailConfig = onCall(base, wrap(async (request) => { await requireAdmin(request); return svc.adminGetMailConfig(db); }));
exports.adminSaveMailWebhook = onCall(base, wrap(async (request) => svc.adminSaveMailWebhook(db, await requireAdmin(request), request.data)));
exports.adminSendTestMail = onCall(base, wrap(async (request) => {
  await requireAdmin(request);
  return svc.adminSendTestMail(db, ADMIN_EMAIL.value(), send);
}));

/** Hand one job to the Make webhook (config is read fresh each time so a newly saved URL applies immediately). */
async function send(job) {
  const cfg = await svc.getMailWebhook(db);
  return W.sendViaWebhook(job, cfg, { replyTo: ADMIN_EMAIL.value() });
}

/** Deliver immediately when an order (or status update) queues a job. Retries are handled by the sweeper below. */
exports.deliverMail = onDocumentCreated({ ...base, document: 'mail/{id}' }, async (event) => {
  await M.processMail(db, event.params.id, send, { logger });
});

/** Every 5 minutes: retry jobs that failed (with backoff) or whose worker died mid-send (expired lease). */
exports.retryMail = onSchedule({ ...base, schedule: 'every 5 minutes', timeZone: 'America/New_York' }, async () => {
  const now = Date.now();
  const snap = await db.collection('mail').where('status', 'in', ['pending', 'sending']).limit(50).get();
  for (const d of snap.docs) {
    const m = d.data();
    const due = m.status === 'pending' ? m.nextAttemptAtMillis <= now : m.leaseUntilMillis <= now;
    if (!due) continue;
    await M.processMail(db, d.id, send, { logger });
  }
});