'use strict';
/**
 * Trusted server-side operations. `db` is a Firestore Admin instance (injected so the emulator tests can use it).
 * The Admin SDK bypasses Firestore Security Rules, therefore every function here validates its own input and
 * the HTTP wrappers in index.js verify administrator authorization before calling the admin* functions.
 */
const { FieldValue } = require('firebase-admin/firestore');
const L = require('./logic');
const T = require('./time');
const M = require('./mail');
const W = require('./webhook');

const { HttpError } = L;
const RATE = { windowMs: 10 * 60 * 1000, perIp: 10, perEmail: 5, dayMs: 24 * 60 * 60 * 1000, perEmailDay: 10 };

const toDate = (ms) => new Date(ms);

/* -------------------------------- schedules -------------------------------- */

function scheduleFromDoc(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    name: d.name,
    active: d.active === true,
    opensAtMillis: d.opensAt.toMillis(),
    closesAtMillis: d.closesAt.toMillis(),
  };
}

/** Public store status computed with TRUSTED server time. */
async function getStoreStatus(db, nowMillis = Date.now()) {
  const snap = await db.collection('storeSchedules').where('active', '==', true).get();
  const st = T.evaluateStatus(snap.docs.map(scheduleFromDoc), nowMillis);
  return {
    open: st.open,
    serverNowMillis: nowMillis,
    scheduleName: st.open ? st.schedule.name : (st.nextSchedule ? st.nextSchedule.name : null),
    closesAtMillis: st.closesAtMillis,
    nextOpensAtMillis: st.nextOpensAtMillis,
  };
}

async function adminSaveSchedule(db, uid, data) {
  if (!data || typeof data !== 'object') throw new HttpError('invalid-argument', 'Invalid schedule.');
  const name = L.validateScheduleName(data.name);
  const o = T.nyLocalToMillis(data.opensAtLocal);
  if (!o.ok) throw new HttpError('invalid-argument', `Opening time: ${o.error}`);
  const c = T.nyLocalToMillis(data.closesAtLocal);
  if (!c.ok) throw new HttpError('invalid-argument', `Closing time: ${c.error}`);
  if (!(o.millis < c.millis)) throw new HttpError('invalid-argument', 'The closing time must be after the opening time.');
  if (c.millis - o.millis > 366 * 24 * 3600 * 1000) throw new HttpError('invalid-argument', 'A single schedule cannot be longer than one year.');
  const active = data.active === true;
  let id = data.id;
  if (id !== undefined && id !== null && !/^[A-Za-z0-9]{10,40}$/.test(id)) throw new HttpError('invalid-argument', 'Invalid schedule id.');
  const col = db.collection('storeSchedules');
  const ref = id ? col.doc(id) : col.doc();
  return db.runTransaction(async (tx) => {
    const all = await tx.get(col);
    const existing = all.docs.find((d) => d.id === ref.id);
    if (id && !existing) throw new HttpError('not-found', 'That schedule no longer exists.');
    if (active) {
      for (const d of all.docs) {
        if (d.id === ref.id) continue;
        const s = scheduleFromDoc(d);
        if (s.active && T.intervalsOverlap(o.millis, c.millis, s.opensAtMillis, s.closesAtMillis)) {
          throw new HttpError('failed-precondition', `This overlaps the active schedule "${s.name}" (${T.formatNy(s.opensAtMillis)} to ${T.formatNy(s.closesAtMillis)}). Deactivate or edit that one first.`);
        }
      }
    }
    const now = FieldValue.serverTimestamp();
    tx.set(ref, {
      name, active, opensAt: toDate(o.millis), closesAt: toDate(c.millis),
      createdAt: existing ? existing.data().createdAt : now, updatedAt: now, updatedBy: uid,
    });
    return { id: ref.id };
  });
}

async function adminDeleteSchedule(db, uid, id, nowMillis = Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(id)) throw new HttpError('invalid-argument', 'Invalid schedule id.');
  const ref = db.collection('storeSchedules').doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError('not-found', 'That schedule no longer exists.');
    if (T.isScheduleOpen(scheduleFromDoc(snap), nowMillis)) throw new HttpError('failed-precondition', 'This schedule is open right now. Deactivate it (or edit its closing time) before deleting.');
    tx.delete(ref);
    return { deleted: true };
  });
}

/* --------------------------------- settings -------------------------------- */

async function getPublicSettings(db) {
  const s = await db.collection('settings').doc('public').get();
  return s.exists ? s.data() : { fulfillmentMethods: [] };
}

async function adminSaveSettings(db, uid, data) {
  const list = Array.isArray(data && data.fulfillmentMethods) ? data.fulfillmentMethods : [];
  if (list.length > 6) throw new HttpError('invalid-argument', 'At most 6 fulfillment options.');
  const seen = new Set();
  const methods = list.map((m) => {
    const id = L.cleanText(m && m.id, 40, 'Option id', { required: true });
    if (!/^[a-z0-9_-]+$/.test(id) || id === 'arranged_separately' || seen.has(id)) throw new HttpError('invalid-argument', 'Option ids must be unique lowercase letters, numbers, - or _.');
    seen.add(id);
    return {
      id,
      label: L.cleanText(m.label, 80, 'Option label', { required: true }),
      requiresDetails: m.requiresDetails === true,
      detailsLabel: L.cleanText(m.detailsLabel, 80, 'Details label') || 'Details',
      enabled: m.enabled !== false,
    };
  });
  const notice = L.cleanText(data && data.checkoutNotice, 600, 'Checkout notice');
  await db.collection('settings').doc('public').set({ fulfillmentMethods: methods, checkoutNotice: notice, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  return { saved: true };
}

/* --------------------------------- products -------------------------------- */

async function adminSaveProduct(db, uid, raw, storage) {
  const p = L.validateProductInput(raw);
  let id = raw.id;
  if (id !== undefined && id !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError('invalid-argument', 'Invalid product id.');
  const pref = id ? db.collection('products').doc(id) : db.collection('products').doc();
  id = pref.id;
  for (const im of p.images) if (!im.path.startsWith(`products/${id}/`) || (im.thumbPath && !im.thumbPath.startsWith(`products/${id}/`))) throw new HttpError('invalid-argument', 'Image does not belong to this product.');
  for (const v of p.variants) if (!/^[a-z0-9][a-z0-9-]*__[a-z0-9][a-z0-9-]*$/.test(v.id)) throw new HttpError('invalid-argument', `Size and color must contain letters or numbers (${v.size} / ${v.color}).`);
  if (p.active && p.variants.filter((v) => v.active).length === 0) throw new HttpError('invalid-argument', 'Add at least one active size/color variant before activating a product.');

  const result = await db.runTransaction(async (tx) => {
    const [psnap, vsnap] = await Promise.all([tx.get(pref), tx.get(pref.collection('variants'))]);
    const now = FieldValue.serverTimestamp();
    const newIds = new Set(p.variants.map((v) => v.id));
    tx.set(pref, {
      name: p.name,
      slug: psnap.exists ? psnap.data().slug : L.slugify(p.name),
      description: p.description,
      priceCents: p.priceCents,
      currency: 'USD',
      images: p.images,
      // a copy of the active sizes/colors lives on the product itself, so the shop needs ONE read instead of one per product
      variants: p.variants.filter((v) => v.active).map((v) => ({ id: v.id, size: v.size, color: v.color, sku: v.sku })),
      active: p.active,
      // saving a product as active brings it back from the archive
      archivedAt: (psnap.exists && !p.active && psnap.data().archivedAt) ? psnap.data().archivedAt : null,
      featured: p.featured,
      createdAt: psnap.exists ? psnap.data().createdAt : now,
      updatedAt: now,
      updatedBy: uid,
    });
    p.variants.forEach((v) => {
      const vref = pref.collection('variants').doc(v.id);
      const prev = vsnap.docs.find((d) => d.id === v.id);
      tx.set(vref, { sku: v.sku, size: v.size, color: v.color, active: v.active, createdAt: prev ? prev.data().createdAt : now, updatedAt: now });
    });
    // Variants removed in the editor are retired (kept for history) rather than deleted.
    for (const d of vsnap.docs) {
      if (!newIds.has(d.id) && d.data().active) tx.update(d.ref, { active: false, updatedAt: now });
    }
    const keep = new Set(p.images.flatMap((im) => [im.path, im.thumbPath].filter(Boolean)));
    const removedPaths = psnap.exists ? (psnap.data().images || []).flatMap((im) => [im.path, im.thumbPath].filter(Boolean)).filter((x) => !keep.has(x)) : [];
    return { id, removedPaths };
  });
  // photos taken off the product are deleted from storage too (best effort; never fails the save)
  if (storage && result.removedPaths.length) await storage.deleteFiles(result.removedPaths);
  return { id: result.id };
}

/* ------------------------------ email webhook (Make.com) ------------------------------ */
// Stored in a collection that NO client can read (see firestore.rules). The admin UI can set it and sees only a masked hint.

async function getMailWebhook(db) {
  const s = await db.collection('private').doc('mailWebhook').get();
  return s.exists ? s.data() : null;
}

async function adminGetMailConfig(db) {
  const cfg = await getMailWebhook(db);
  return { ...W.describeWebhook(cfg), updatedAtMillis: cfg && cfg.updatedAt ? cfg.updatedAt.toMillis() : null };
}

async function adminSaveMailWebhook(db, uid, data) {
  if (data && data.clear === true) {
    await db.collection('private').doc('mailWebhook').delete();
    return { configured: false };
  }
  const v = W.validateWebhookConfig(data && data.url, data && data.token);
  if (!v.ok) throw new HttpError('invalid-argument', v.error);
  await db.collection('private').doc('mailWebhook').set({ url: v.url, token: v.token || null, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  return W.describeWebhook({ url: v.url, token: v.token });
}

/** Sends one test email straight through the webhook (not queued) so the admin gets an immediate answer. */
async function adminSendTestMail(db, adminEmail, send) {
  const job = {
    id: `test_${Date.now()}`, kind: 'test', to: adminEmail, orderId: null,
    subject: 'True Heart store: test email',
    text: 'This is a test from the True Heart store admin. If you can read this, the Make scenario is sending email correctly.',
    html: '<p>This is a test from the <strong>True Heart store admin</strong>. If you can read this, the Make scenario is sending email correctly.</p>',
  };
  try { await send(job); } catch (e) { throw new HttpError('failed-precondition', e.message); }
  return { sentTo: adminEmail };
}
/* ---------------------------------- orders --------------------------------- */

async function hit(db, key, limit, now, windowMs = RATE.windowMs) {
  const ref = db.collection('rateLimits').doc(key);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const d = s.exists ? s.data() : null;
    if (d && now - d.windowStartMillis < windowMs) {
      if (d.count >= limit) throw new HttpError('resource-exhausted', 'Too many order attempts. Please wait a few minutes and try again.');
      tx.update(ref, { count: d.count + 1 });
    } else {
      tx.set(ref, { windowStartMillis: now, count: 1, expireAt: toDate(now + 2 * 24 * 3600 * 1000) });
    }
  });
}

function orderForMail(id, o, createdAtMillis) {
  return { id, orderNumber: o.orderNumber, customerName: o.customerName, customerEmail: o.customerEmail, customerPhone: o.customerPhone, fulfillmentMethod: o.fulfillmentMethod, fulfillmentDetails: o.fulfillmentDetails, items: o.items, subtotalCents: o.subtotalCents, createdAtMillis };
}

/**
 * Create an order. All-or-nothing: validation, schedule check, authoritative pricing,
 * order document, mail jobs and idempotency record commit together or not at all.
 */
async function submitOrder(db, data, ctx) {
  const { ip = 'unknown', adminEmail, siteUrl, now = () => Date.now() } = ctx;
  const settings = await getPublicSettings(db);
  const req = L.validateOrderRequest(data, settings);
  const t0 = now();
  await hit(db, `ip_${L.hashKey(ip)}`, RATE.perIp, t0);
  await hit(db, `em_${L.hashKey(req.customerEmail)}`, RATE.perEmail, t0);
  // a second, daily cap per address: stops someone from using the shop to flood a victim's inbox with confirmation emails
  await hit(db, `emd_${L.hashKey(req.customerEmail)}`, RATE.perEmailDay, t0, RATE.dayMs);

  const payloadHash = L.hashKey(JSON.stringify([req.customerEmail, req.items.map((i) => [i.productId, i.variantId, i.quantity]).sort()]));
  const idemRef = db.collection('idempotency').doc(L.hashKey(req.idempotencyKey));
  const counterRef = db.collection('counters').doc('orders');
  const schedQuery = db.collection('storeSchedules').where('active', '==', true);
  const orderRef = db.collection('orders').doc();

  return db.runTransaction(async (tx) => {
    const idem = await tx.get(idemRef);
    if (idem.exists) {
      const d = idem.data();
      if (d.payloadHash !== payloadHash) throw new HttpError('already-exists', 'This submission key was already used for a different order. Reload the page and try again.');
      return { ...d.response, duplicate: true };
    }

    const nowMs = now(); // trusted server time
    const schedSnap = await tx.get(schedQuery);
    const status = T.evaluateStatus(schedSnap.docs.map(scheduleFromDoc), nowMs);
    if (!status.open) {
      throw new HttpError('failed-precondition', 'The store is closed, so orders cannot be submitted right now.', { reason: 'store_closed', nextOpensAtMillis: status.nextOpensAtMillis });
    }

    const refs = [];
    for (const it of req.items) {
      const pref = db.collection('products').doc(it.productId);
      refs.push(pref, pref.collection('variants').doc(it.variantId));
    }
    const snaps = await tx.getAll(...refs);
    const counter = await tx.get(counterRef);

    const lookup = (pid, vid) => {
      const idx = req.items.findIndex((i) => i.productId === pid && i.variantId === vid);
      const [p, v] = snaps.slice(idx * 2, idx * 2 + 2);
      return { product: p.exists ? p.data() : undefined, variant: v.exists ? v.data() : undefined };
    };
    const priced = L.priceOrder(req.items, lookup);
    if (priced.problems.length) {
      throw new HttpError('failed-precondition', 'Some items in your cart changed or are no longer available.', { reason: 'cart_invalid', problems: priced.problems });
    }

    const next = (counter.exists ? counter.data().next : 1);
    const orderNumber = L.formatOrderNumber(next);
    const nowDate = toDate(nowMs);
    const response = {
      orderNumber,
      items: priced.lines.map((l) => ({ productName: l.productName, size: l.size, color: l.color, quantity: l.quantity, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents })),
      subtotalCents: priced.subtotalCents,
      currency: 'USD',
      customerEmail: req.customerEmail,
      createdAtMillis: nowMs,
    };

    // ---- writes ----
    const orderDoc = {
      orderNumber,
      customerName: req.customerName,
      customerEmail: req.customerEmail,
      customerPhone: req.customerPhone || null,
      fulfillmentMethod: req.fulfillmentMethod,
      fulfillmentDetails: req.fulfillmentDetails || null,
      items: priced.lines,
      subtotalCents: priced.subtotalCents,
      currency: 'USD',
      status: 'ordered',
      paymentStatus: 'not_collected_online',   // the website never collects money; `paid` below is recorded by hand by an admin
      paid: false,
      paymentMethod: null,
      paidAtMillis: null,
      statusHistory: [{ status: 'ordered', byUid: null, atMillis: nowMs }],
      notificationStatus: { admin: 'pending', customer: 'pending' },
      createdAt: nowDate,
      updatedAt: nowDate,
    };
    tx.set(orderRef, orderDoc);
    const mailOrder = orderForMail(orderRef.id, orderDoc, nowMs);
    const queue = (suffix, kind, to, tpl, orderField) => tx.set(db.collection('mail').doc(`${orderRef.id}_${suffix}`), {
      kind, orderId: orderRef.id, orderField, to, subject: tpl.subject, text: tpl.text, html: tpl.html,
      status: 'pending', attempts: 0, nextAttemptAtMillis: 0, leaseUntilMillis: 0, lastError: null, createdAt: nowDate, updatedAt: nowDate,
    });
    queue('admin', 'admin_new_order', adminEmail, M.adminNewOrder(mailOrder, { siteUrl }), 'admin');
    queue('customer', 'customer_confirmation', req.customerEmail, M.customerConfirmation(mailOrder), 'customer');
    tx.set(counterRef, { next: next + 1 });
    tx.set(idemRef, { payloadHash, response, orderId: orderRef.id, createdAt: nowDate, expireAt: toDate(nowMs + 30 * 24 * 3600 * 1000) });
    return response;
  }, { maxAttempts: 25 });   // a busy drop makes many orders fight over the counter; keep retrying instead of failing
}

async function adminUpdateOrderStatus(db, uid, orderId, newStatus, now = () => Date.now()) {
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(orderId)) throw new HttpError('invalid-argument', 'Invalid order id.');
  if (!L.ORDER_STATUSES.includes(newStatus)) throw new HttpError('invalid-argument', 'Invalid status.');
  const ref = db.collection('orders').doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError('not-found', 'Order not found.');
    const o = snap.data();
    if (o.deletedMillis) throw new HttpError('failed-precondition', 'This order is in the Trash. Restore it first.');
    const current = L.normalizeStatus(o.status);
    if (!L.canTransition(current, newStatus)) throw new HttpError('failed-precondition', `An order that is "${current}" cannot be changed to "${newStatus}".`);
    if (newStatus === 'cancelled' && o.paid === true) throw new HttpError('failed-precondition', 'This order is marked paid. Refund the customer, change it to Not paid, then cancel it.');
    const nowMs = now();
    const nowDate = toDate(nowMs);
    const patch = { status: newStatus, updatedAt: nowDate, statusHistory: [...(o.statusHistory || []), { status: newStatus, byUid: uid, atMillis: nowMs }] };
    tx.update(ref, patch);
    const tpl = M.customerStatus(o, newStatus);
    if (tpl) {
      const n = patch.statusHistory.length;
      tx.set(db.collection('mail').doc(`${orderId}_status_${n}`), {
        kind: 'customer_status', orderId, orderField: null, to: o.customerEmail, subject: tpl.subject, text: tpl.text, html: tpl.html,
        status: 'pending', attempts: 0, nextAttemptAtMillis: 0, leaseUntilMillis: 0, lastError: null, createdAt: nowDate, updatedAt: nowDate,
      });
    }
    return { status: newStatus };
  });
}

/** An admin records that an order was (or was not) paid, and how. Payment happens outside the website. */
async function adminSetOrderPayment(db, uid, orderId, data, now = () => Date.now()) {
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(orderId)) throw new HttpError('invalid-argument', 'Invalid order id.');
  if (!data || typeof data.paid !== 'boolean') throw new HttpError('invalid-argument', 'Say whether the order is paid.');
  const method = data.method === undefined || data.method === null || data.method === '' ? null : data.method;
  if (method !== null && !L.PAYMENT_METHODS.includes(method)) throw new HttpError('invalid-argument', 'Payment method must be cash, Venmo or Zelle.');
  if (data.paid && method === null) throw new HttpError('invalid-argument', 'Choose how it was paid: cash, Venmo or Zelle.');
  const ref = db.collection('orders').doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError('not-found', 'Order not found.');
    const o = snap.data();
    if (o.deletedMillis) throw new HttpError('failed-precondition', 'This order is in the Trash. Restore it first.');
    if (data.paid && o.status === 'cancelled') throw new HttpError('failed-precondition', 'A cancelled order cannot be marked paid.');
    const nowMs = now();
    const patch = {
      paid: data.paid,
      paymentMethod: data.paid ? method : null,
      paidAtMillis: data.paid ? nowMs : null,
      paidByUid: data.paid ? uid : null,
      paymentHistory: [...(o.paymentHistory || []), { paid: data.paid, method: data.paid ? method : null, byUid: uid, atMillis: nowMs }],
      updatedAt: toDate(nowMs),
    };
    tx.update(ref, patch);
    return { paid: patch.paid, paymentMethod: patch.paymentMethod, paidAtMillis: patch.paidAtMillis };
  });
}

/* ------------------------------- administrators ------------------------------ */
// Admin = Firebase Auth custom claim { admin: true }. Only an existing admin can reach these (checked in index.js).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function listAdmins(auth) {
  const out = [];
  let token;
  do {
    const page = await auth.listUsers(1000, token);
    for (const u of page.users) {
      if (u.customClaims && u.customClaims.admin === true) {
        out.push({ uid: u.uid, email: u.email || '', disabled: u.disabled === true, createdMillis: u.metadata.creationTime ? Date.parse(u.metadata.creationTime) : null, lastSignInMillis: u.metadata.lastSignInTime ? Date.parse(u.metadata.lastSignInTime) : null });
      }
    }
    token = page.pageToken;
  } while (token);
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

/** Grant or revoke admin for an EXISTING account, identified by email. */
async function setAdmin(auth, callerUid, rawEmail, makeAdmin) {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError('invalid-argument', 'Enter the email address of an existing account.');
  if (typeof makeAdmin !== 'boolean') throw new HttpError('invalid-argument', 'Say whether to add or remove the administrator.');
  const user = await auth.getUserByEmail(email).catch((e) => { if (e && e.code === 'auth/user-not-found') return null; throw e; });
  if (!user) throw new HttpError('not-found', 'There is no account with that email. They need to have an account first (create it in Firebase console > Authentication > Users).');
  const claims = { ...(user.customClaims || {}) };
  if (makeAdmin) {
    if (user.disabled) throw new HttpError('failed-precondition', 'That account is disabled, so it cannot be made an administrator.');
    if (claims.admin === true) throw new HttpError('already-exists', `${email} is already an administrator.`);
    claims.admin = true;
    await auth.setCustomUserClaims(user.uid, claims);
    return { email, admin: true };
  }
  if (user.uid === callerUid) throw new HttpError('failed-precondition', 'You cannot remove your own administrator access. Ask another administrator to do it.');
  if (claims.admin !== true) throw new HttpError('failed-precondition', `${email} is not an administrator.`);
  const admins = await listAdmins(auth);
  if (admins.filter((a) => !a.disabled).length <= 1) throw new HttpError('failed-precondition', 'You cannot remove the last administrator.');
  delete claims.admin;
  await auth.setCustomUserClaims(user.uid, claims);
  await auth.revokeRefreshTokens(user.uid);   // their existing sign-ins stop working
  return { email, admin: false };
}

/** One-off tidy-up: rename old statuses (submitted/confirmed/preparing/ready/fulfilled) to the three-stage ones. Safe to run any number of times. */
async function normalizeLegacyOrders(db) {
  let migrated = 0;
  for (const old of Object.keys(L.LEGACY_STATUS)) {
    const snap = await db.collection('orders').where('status', '==', old).get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      const part = snap.docs.slice(i, i + 400);
      part.forEach((d) => batch.update(d.ref, { status: L.LEGACY_STATUS[old] }));
      await batch.commit();
      migrated += part.length;
    }
  }
  return { migrated };
}

/* ------------------------------ deleting things safely ------------------------------ */
// Orders:   Move to Trash (hidden everywhere, restorable for 30 days) -> deleted for good, by hand or automatically.
// Products: Archive (hidden from the shop, restorable) -> Delete forever (also removes the photos).
// Orders keep their own copy of every product detail, so neither action can damage an existing order.

const TRASH_DAYS = 30;
const TRASH_MS = TRASH_DAYS * 24 * 3600 * 1000;
const ORDER_ID_RE = /^[A-Za-z0-9]{10,40}$/;

/** How many orders contain a product (trashed ones counted separately). Orders carry their own snapshot, so this is information, not a dependency. */
async function productImpact(db, productId) {
  if (typeof productId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(productId)) throw new HttpError('invalid-argument', 'Invalid product id.');
  const snap = await db.collection('orders').select('items', 'status', 'deletedMillis').get();
  const out = { orders: 0, notDelivered: 0, units: 0, trashed: 0 };
  for (const d of snap.docs) {
    const o = d.data();
    const lines = (o.items || []).filter((i) => i.productId === productId);
    if (!lines.length) continue;
    if (o.deletedMillis) { out.trashed++; continue; }
    const st = L.normalizeStatus(o.status);
    out.orders++;
    if (st === 'ordered') out.notDelivered++;
    if (st !== 'cancelled') out.units += lines.reduce((n, i) => n + (i.quantity || 0), 0);
  }
  return out;
}

async function adminArchiveProduct(db, uid, id, now = () => Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError('invalid-argument', 'Invalid product id.');
  const ref = db.collection('products').doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError('not-found', 'That product no longer exists.');
    if (snap.data().archivedAt) return { archived: true };
    tx.update(ref, { active: false, featured: false, archivedAt: toDate(now()), archivedBy: uid, updatedAt: toDate(now()) });
    return { archived: true };
  });
}

/** Brings an archived product back as HIDDEN: the admin switches it on when ready. */
async function adminRestoreProduct(db, uid, id, now = () => Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError('invalid-argument', 'Invalid product id.');
  const ref = db.collection('products').doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError('not-found', 'That product no longer exists.');
    tx.update(ref, { archivedAt: null, archivedBy: null, updatedAt: toDate(now()) });
    return { restored: true };
  });
}

/** Removes an ARCHIVED product, its sizes/colors and its photos for good. Existing orders are untouched. */
async function adminPurgeProduct(db, id, storage) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpError('invalid-argument', 'Invalid product id.');
  const ref = db.collection('products').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError('not-found', 'That product no longer exists.');
  if (!snap.data().archivedAt) throw new HttpError('failed-precondition', 'Archive the product first. Only archived products can be deleted for good.');
  const variants = await ref.collection('variants').get();
  const legacy = await db.collection('inventory').where('productId', '==', id).get();
  const batch = db.batch();
  variants.docs.forEach((d) => batch.delete(d.ref));
  legacy.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(ref);
  await batch.commit();
  if (storage) await storage.deletePrefix(`products/${id}/`);
  return { deleted: true };
}

/** Order -> Trash. Refuses PAID orders (settle the money first), skips emails not yet sent, and can be undone. */
async function adminTrashOrder(db, uid, orderId, now = () => Date.now()) {
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) throw new HttpError('invalid-argument', 'Invalid order id.');
  const ref = db.collection('orders').doc(orderId);
  const mailQ = db.collection('mail').where('orderId', '==', orderId);
  return db.runTransaction(async (tx) => {
    const [snap, mails] = await Promise.all([tx.get(ref), tx.get(mailQ)]);
    if (!snap.exists) throw new HttpError('not-found', 'Order not found.');
    const o = snap.data();
    if (o.deletedMillis) throw new HttpError('failed-precondition', 'This order is already in the Trash.');
    if (o.paid === true) throw new HttpError('failed-precondition', 'This order is marked paid. Refund the customer and set it to Not paid first, or keep it for your records.');
    const nowMs = now();
    tx.update(ref, { deletedMillis: nowMs, deletedByUid: uid, updatedAt: toDate(nowMs) });
    mails.docs.forEach((d) => { const st = d.data().status; if (st !== 'sent' && st !== 'failed') tx.update(d.ref, { status: 'skipped', updatedAt: toDate(nowMs) }); });
    return { orderNumber: o.orderNumber, purgeAtMillis: nowMs + TRASH_MS };
  });
}

async function adminRestoreOrder(db, orderId, now = () => Date.now()) {
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) throw new HttpError('invalid-argument', 'Invalid order id.');
  const ref = db.collection('orders').doc(orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError('not-found', 'Order not found.');
    if (!snap.data().deletedMillis) throw new HttpError('failed-precondition', 'This order is not in the Trash.');
    tx.update(ref, { deletedMillis: null, deletedByUid: null, updatedAt: toDate(now()) });
    return { orderNumber: snap.data().orderNumber };
  });
}

/** Erases an order, its email records and its duplicate-protection record. Used by "Delete forever" and the nightly clean-up. */
async function hardDeleteOrder(db, orderId) {
  const ref = db.collection('orders').doc(orderId);
  const [mail, idem] = await Promise.all([
    db.collection('mail').where('orderId', '==', orderId).get(),
    db.collection('idempotency').where('orderId', '==', orderId).get(),
  ]);
  const batch = db.batch();
  mail.docs.forEach((d) => batch.delete(d.ref));
  idem.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(ref);
  await batch.commit();
}

/** "Delete forever": only for orders that are already in the Trash. */
async function adminDeleteOrder(db, orderId) {
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) throw new HttpError('invalid-argument', 'Invalid order id.');
  const snap = await db.collection('orders').doc(orderId).get();
  if (!snap.exists) throw new HttpError('not-found', 'Order not found.');
  if (!snap.data().deletedMillis) throw new HttpError('failed-precondition', 'Move the order to the Trash first. It can be deleted for good from there.');
  await hardDeleteOrder(db, orderId);
  return { deleted: true, orderNumber: snap.data().orderNumber };
}

/** Nightly: orders that have been in the Trash for 30 days are erased. */
async function purgeTrash(db, nowMs = Date.now()) {
  const snap = await db.collection('orders').where('deletedMillis', '<', nowMs - TRASH_MS).limit(200).get();
  for (const d of snap.docs) await hardDeleteOrder(db, d.id);
  return { purged: snap.size };
}

async function adminResendMail(db, mailId, now = () => Date.now()) {
  if (typeof mailId !== 'string' || !/^[A-Za-z0-9_]{10,80}$/.test(mailId)) throw new HttpError('invalid-argument', 'Invalid mail id.');
  const ref = db.collection('mail').doc(mailId);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpError('not-found', 'Mail job not found.');
    if (s.data().status !== 'failed') throw new HttpError('failed-precondition', 'Only failed emails can be retried manually.');
    tx.update(ref, { status: 'pending', attempts: 0, nextAttemptAtMillis: 0, leaseUntilMillis: 0, updatedAt: toDate(now()) });
  });
  return { requeued: true };
}

module.exports = {
  RATE, getStoreStatus, adminSaveSchedule, adminDeleteSchedule, getPublicSettings, adminSaveSettings,
  adminSaveProduct, submitOrder, normalizeLegacyOrders, productImpact, adminArchiveProduct, adminRestoreProduct, adminPurgeProduct, adminTrashOrder, adminRestoreOrder, purgeTrash, TRASH_DAYS, listAdmins, setAdmin, adminUpdateOrderStatus, adminSetOrderPayment, adminDeleteOrder, adminResendMail, scheduleFromDoc,
  getMailWebhook, adminGetMailConfig, adminSaveMailWebhook, adminSendTestMail,
};
