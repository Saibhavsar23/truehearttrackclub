'use strict';
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString, defineBoolean } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const nodemailer = require('nodemailer');

const svc = require('./lib/service');
const M = require('./lib/mail');
const { HttpError } = require('./lib/logic');

initializeApp();
const db = getFirestore();

// ---- configuration (non-secret values are plain params; credentials are Secret Manager secrets) ----
const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const SMTP_HOST = defineString('SMTP_HOST', { default: 'smtp.gmail.com' });
const SMTP_PORT = defineString('SMTP_PORT', { default: '465' });
const MAIL_FROM = defineString('MAIL_FROM', { default: 'True Heart Track Club <truehearttrackclub@gmail.com>' });
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
exports.adminResendMail = onCall({ ...base, secrets: [SMTP_USER, SMTP_PASS] }, wrap(async (request) => {
  await requireAdmin(request);
  const id = request.data && request.data.mailId;
  const out = await svc.adminResendMail(db, id);
  await M.processMail(db, id, send, { logger });
  return out;
}));

// ------------------------------------- mail -------------------------------------

function transporter() {
  const port = Number(SMTP_PORT.value());
  return nodemailer.createTransport({
    host: SMTP_HOST.value(),
    port,
    secure: port === 465,
    auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() },
    connectionTimeout: 15000,
    socketTimeout: 20000,
  });
}

async function send(job) {
  const info = await transporter().sendMail({
    from: MAIL_FROM.value(),
    to: job.to,
    subject: job.subject,
    text: job.text,
    html: job.html,
    messageId: `<${job.id}@thtc.store>`, // deterministic per job: a retry never looks like a new message
    replyTo: ADMIN_EMAIL.value(),
  });
  return { accepted: info.accepted || [], rejected: info.rejected || [], messageId: info.messageId };
}

/** Deliver immediately when an order (or status update) queues a job. Retries are handled by the sweeper below. */
exports.deliverMail = onDocumentCreated({ ...base, document: 'mail/{id}', secrets: [SMTP_USER, SMTP_PASS] }, async (event) => {
  await M.processMail(db, event.params.id, send, { logger });
});

/** Every 5 minutes: retry jobs that failed (with backoff) or whose worker died mid-send (expired lease). */
exports.retryMail = onSchedule({ ...base, schedule: 'every 5 minutes', timeZone: 'America/New_York', secrets: [SMTP_USER, SMTP_PASS] }, async () => {
  const now = Date.now();
  const snap = await db.collection('mail').where('status', 'in', ['pending', 'sending']).limit(50).get();
  for (const d of snap.docs) {
    const m = d.data();
    const due = m.status === 'pending' ? m.nextAttemptAtMillis <= now : m.leaseUntilMillis <= now;
    if (!due) continue;
    await M.processMail(db, d.id, send, { logger });
  }
});
