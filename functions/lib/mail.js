'use strict';
/**
 * Email templates and the durable mail-queue processor.
 *
 * Queue design: mail documents are written in the SAME Firestore transaction that creates the order,
 * so an order can never exist without its notification jobs (and an email can never be sent for an order
 * that failed to save). A Firestore trigger delivers immediately; a scheduled sweeper retries failures
 * with exponential backoff. Each job is claimed with a short lease inside a transaction, so concurrent
 * workers cannot send the same job twice, and the Message-ID is deterministic per job.
 */
const { money } = require('./logic');
const { formatNy } = require('./time');

const MAX_ATTEMPTS = 8;
const LEASE_MS = 2 * 60 * 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function backoffMs(attempt) {
  // 1 min, 2, 4, 8 ... capped at 60 min
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** (attempt - 1));
}

function itemsText(order) {
  return order.items.map((i) => `  - ${i.quantity} x ${i.productName} (${i.size}, ${i.color}) @ ${money(i.unitPriceCents)} = ${money(i.lineTotalCents)}`).join('\n');
}
function itemsHtml(order) {
  const rows = order.items.map((i) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #ddd">${esc(i.productName)}<br><span style="color:#666;font-size:13px">${esc(i.size)} &middot; ${esc(i.color)}${i.sku ? ' &middot; ' + esc(i.sku) : ''}</span></td><td style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:center">${i.quantity}</td><td style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:right">${money(i.unitPriceCents)}</td><td style="padding:6px 8px;border-bottom:1px solid #ddd;text-align:right">${money(i.lineTotalCents)}</td></tr>`).join('');
  return `<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="text-align:left"><th style="padding:6px 8px">Item</th><th style="padding:6px 8px">Qty</th><th style="padding:6px 8px;text-align:right">Unit</th><th style="padding:6px 8px;text-align:right">Total</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="3" style="padding:8px;text-align:right"><strong>Subtotal</strong></td><td style="padding:8px;text-align:right"><strong>${money(order.subtotalCents)}</strong></td></tr></tfoot></table>`;
}
function wrap(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#111"><div style="max-width:620px;margin:0 auto;padding:24px"><div style="background:#0a0a0b;color:#fff;padding:16px 20px;font-size:20px;letter-spacing:.06em;text-transform:uppercase">True Heart Track Club</div><div style="background:#fff;padding:24px 20px"><h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${bodyHtml}</div><p style="font-size:12px;color:#666;padding:12px 4px">True Heart Track Club &middot; Questions? Reply to this email or write to truehearttrackclub@gmail.com</p></div></body></html>`;
}

const NO_PAYMENT_TEXT = 'No payment has been collected online. Payment and fulfillment will be arranged with you separately.';

function fulfillmentLine(order) {
  const m = order.fulfillmentMethod === 'arranged_separately' ? 'To be arranged separately' : order.fulfillmentMethod;
  return order.fulfillmentDetails ? `${m}: ${order.fulfillmentDetails}` : m;
}

function adminNewOrder(order, { siteUrl }) {
  const link = siteUrl ? `${siteUrl.replace(/\/$/, '')}/admin/#order=${encodeURIComponent(order.id)}` : null;
  const created = formatNy(order.createdAtMillis);
  const text = [
    `New merch order ${order.orderNumber}`,
    `Submitted: ${created}`,
    '',
    `Customer: ${order.customerName}`,
    `Email: ${order.customerEmail}`,
    order.customerPhone ? `Phone: ${order.customerPhone}` : null,
    `Fulfillment: ${fulfillmentLine(order)}`,
    '',
    'Items:',
    itemsText(order),
    '',
    `Subtotal: ${money(order.subtotalCents)} (UNPAID: no online payment collected)`,
    link ? `\nAdmin order details: ${link}` : null,
  ].filter((x) => x !== null).join('\n');
  const html = wrap(`New order ${order.orderNumber}`, `<p><strong>Submitted:</strong> ${esc(created)}</p><p><strong>${esc(order.customerName)}</strong><br>${esc(order.customerEmail)}${order.customerPhone ? '<br>' + esc(order.customerPhone) : ''}</p><p><strong>Fulfillment:</strong> ${esc(fulfillmentLine(order))}</p>${itemsHtml(order)}<p style="margin-top:16px"><strong>Unpaid.</strong> No online payment was collected.</p>${link ? `<p><a href="${esc(link)}">Open order in admin</a></p>` : ''}`);
  return { subject: `New merch order ${order.orderNumber}: ${money(order.subtotalCents)} (${order.customerName})`, text, html };
}

function customerConfirmation(order) {
  const text = [
    `Hi ${order.customerName},`,
    '',
    `Thanks for your True Heart Track Club order. We received it as ${order.orderNumber}.`,
    '',
    'Order summary:',
    itemsText(order),
    '',
    `Subtotal: ${money(order.subtotalCents)}`,
    '',
    NO_PAYMENT_TEXT,
    'We will contact you at this email address with the next steps.',
    '',
    '- True Heart Track Club',
  ].join('\n');
  const html = wrap(`We received your order ${order.orderNumber}`, `<p>Hi ${esc(order.customerName)}, thanks for your order.</p>${itemsHtml(order)}<p style="margin-top:16px"><strong>${esc(NO_PAYMENT_TEXT)}</strong></p><p>We'll contact you at this email address with the next steps.</p>`);
  return { subject: `Your True Heart order ${order.orderNumber} (payment not yet collected)`, text, html };
}

/** Wording is deliberately tied to the actual status. Nothing here claims payment, shipping or delivery. */
const STATUS_COPY = {
  confirmed: 'Your order has been confirmed by True Heart Track Club.',
  preparing: 'Your order is now being prepared.',
  ready: 'Your order is marked ready. We will be in touch about how to get it to you.',
  fulfilled: 'Your order has been marked as fulfilled.',
  cancelled: 'Your order has been cancelled. If you did not expect this, reply to this email.',
};

function customerStatus(order, status) {
  const copy = STATUS_COPY[status];
  if (!copy) return null;
  const text = [`Hi ${order.customerName},`, '', `Update on order ${order.orderNumber}: ${copy}`, '', 'Reminder: payment is arranged separately and is never collected on the website.', '', '- True Heart Track Club'].join('\n');
  const html = wrap(`Order ${order.orderNumber}: ${status}`, `<p>Hi ${esc(order.customerName)},</p><p>${esc(copy)}</p><p style="color:#555;font-size:13px">Payment is arranged separately and is never collected on the website.</p>`);
  return { subject: `Update on your True Heart order ${order.orderNumber}`, text, html };
}

/**
 * Claim one job. Returns the job data if this worker now owns it, otherwise null.
 */
async function claim(db, id, now = Date.now()) {
  const ref = db.collection('mail').doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const m = snap.data();
    if (m.status === 'sent' || m.status === 'failed') return null;
    if (m.status === 'sending' && m.leaseUntilMillis > now) return null;
    if (m.nextAttemptAtMillis > now) return null;
    tx.update(ref, { status: 'sending', leaseUntilMillis: now + LEASE_MS, attempts: (m.attempts || 0) + 1, updatedAt: new Date(now) });
    return { ...m, id, attempts: (m.attempts || 0) + 1 };
  });
}

/**
 * Deliver one queued job. `send(job)` must resolve { accepted:[], rejected:[], messageId } from the SMTP server.
 * A job is marked "sent" only when the SMTP server accepted the recipient.
 */
async function processMail(db, id, send, { now = () => Date.now(), logger = console } = {}) {
  const job = await claim(db, id, now());
  if (!job) return { skipped: true };
  const ref = db.collection('mail').doc(id);
  const orderRef = job.orderId ? db.collection('orders').doc(job.orderId) : null;
  const noteOrder = async (patch) => { if (orderRef && job.orderField) { try { await orderRef.update({ [`notificationStatus.${job.orderField}`]: patch, updatedAt: new Date(now()) }); } catch (e) { logger.warn('order notification note failed', e.message); } } };
  try {
    const res = await send(job);
    const accepted = res && Array.isArray(res.accepted) ? res.accepted : [];
    const rejected = res && Array.isArray(res.rejected) ? res.rejected : [];
    if (accepted.length === 0 || rejected.length > 0) throw new Error(`SMTP did not accept the message (rejected: ${rejected.join(', ') || 'all'})`);
    await ref.update({ status: 'sent', sentAt: new Date(now()), messageId: res.messageId || null, lastError: null, leaseUntilMillis: 0, updatedAt: new Date(now()) });
    await noteOrder('sent');
    return { sent: true };
  } catch (err) {
    const failedForGood = job.attempts >= MAX_ATTEMPTS;
    await ref.update({
      status: failedForGood ? 'failed' : 'pending',
      lastError: String(err && err.message ? err.message : err).slice(0, 500),
      nextAttemptAtMillis: now() + backoffMs(job.attempts),
      leaseUntilMillis: 0,
      updatedAt: new Date(now()),
    });
    await noteOrder(failedForGood ? 'failed' : 'retrying');
    logger.warn(`mail ${id} attempt ${job.attempts} failed: ${err && err.message}`);
    return { sent: false, failedForGood };
  }
}

module.exports = { MAX_ATTEMPTS, LEASE_MS, backoffMs, adminNewOrder, customerConfirmation, customerStatus, STATUS_COPY, processMail, claim, esc };
