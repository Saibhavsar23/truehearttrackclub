'use strict';
/** Pure business logic (no Firebase imports) so it can be unit tested directly. */
const crypto = require('node:crypto');

const LIMITS = {
  maxLineQty: 10,
  maxLines: 20,
  maxTotalUnits: 25,
  nameMax: 100,
  emailMax: 254,
  phoneMax: 30,
  detailsMax: 1000,
  priceMaxCents: 100000, // $1,000 per unit sanity cap
};

const ORDER_STATUSES = ['submitted', 'confirmed', 'preparing', 'ready', 'fulfilled', 'cancelled'];

/** Allowed transitions. fulfilled and cancelled are terminal. */
const TRANSITIONS = {
  submitted: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'ready', 'fulfilled', 'cancelled'],
  preparing: ['ready', 'fulfilled', 'cancelled'],
  ready: ['fulfilled', 'cancelled'],
  fulfilled: [],
  cancelled: [],
};

function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

class HttpError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code; // firebase-functions HttpsError code
    this.details = details;
  }
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

function cleanText(v, max, label, { required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError('invalid-argument', `${label} must be text.`);
  // strip control characters; collapse whitespace on single-line fields is done by caller where needed
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (required && !s) throw new HttpError('invalid-argument', `${label} is required.`);
  if (s.length > max) throw new HttpError('invalid-argument', `${label} must be ${max} characters or fewer.`);
  return s;
}

/** Validate and normalise the order request body. Never trusts price/subtotal from the client. */
function validateOrderRequest(data, settings) {
  if (!data || typeof data !== 'object') throw new HttpError('invalid-argument', 'Invalid request.');
  const key = data.idempotencyKey;
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(key)) {
    throw new HttpError('invalid-argument', 'Missing or invalid idempotency key.');
  }
  if (data.confirm !== true) {
    throw new HttpError('invalid-argument', 'You must confirm that you understand no online payment is collected.');
  }
  const c = data.customer || {};
  const customerName = cleanText(c.name, LIMITS.nameMax, 'Full name', { required: true }).replace(/\s+/g, ' ');
  if (customerName.length < 2) throw new HttpError('invalid-argument', 'Please enter your full name.');
  const customerEmail = cleanText(c.email, LIMITS.emailMax, 'Email', { required: true }).toLowerCase();
  if (!EMAIL_RE.test(customerEmail)) throw new HttpError('invalid-argument', 'Please enter a valid email address.');
  const customerPhone = cleanText(c.phone, LIMITS.phoneMax, 'Phone');
  if (customerPhone && !/^[0-9+()\-.\s]{7,30}$/.test(customerPhone)) {
    throw new HttpError('invalid-argument', 'Phone number contains invalid characters.');
  }

  // Fulfillment: extensible. Methods come from settings/public.fulfillmentMethods; if none are
  // configured the order records "arranged_separately" with optional notes.
  const f = data.fulfillment || {};
  const methods = (settings && Array.isArray(settings.fulfillmentMethods) ? settings.fulfillmentMethods : []).filter((m) => m && m.enabled !== false);
  let fulfillmentMethod;
  let fulfillmentDetails;
  if (methods.length === 0) {
    fulfillmentMethod = 'arranged_separately';
    fulfillmentDetails = cleanText(f.details, LIMITS.detailsMax, 'Notes');
  } else {
    const chosen = methods.find((m) => m.id === f.method);
    if (!chosen) throw new HttpError('invalid-argument', 'Please choose a fulfillment option.');
    fulfillmentMethod = chosen.id;
    fulfillmentDetails = cleanText(f.details, LIMITS.detailsMax, chosen.detailsLabel || 'Fulfillment details', { required: !!chosen.requiresDetails });
  }

  if (!Array.isArray(data.items) || data.items.length === 0) throw new HttpError('invalid-argument', 'Your cart is empty.');
  if (data.items.length > LIMITS.maxLines) throw new HttpError('invalid-argument', 'Too many different items in one order.');
  const merged = new Map();
  for (const raw of data.items) {
    if (!raw || typeof raw.productId !== 'string' || typeof raw.variantId !== 'string') throw new HttpError('invalid-argument', 'Invalid cart item.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw.productId) || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.variantId)) throw new HttpError('invalid-argument', 'Invalid cart item.');
    const qty = raw.quantity;
    if (!Number.isInteger(qty) || qty < 1 || qty > LIMITS.maxLineQty) {
      throw new HttpError('invalid-argument', `Quantity must be a whole number from 1 to ${LIMITS.maxLineQty}.`);
    }
    const k = `${raw.productId}/${raw.variantId}`;
    merged.set(k, (merged.get(k) || 0) + qty);
  }
  const items = [...merged.entries()].map(([k, quantity]) => {
    const [productId, variantId] = k.split('/');
    return { productId, variantId, quantity };
  });
  for (const it of items) {
    if (it.quantity > LIMITS.maxLineQty) throw new HttpError('invalid-argument', `You can order at most ${LIMITS.maxLineQty} of one item.`);
  }
  const total = items.reduce((n, i) => n + i.quantity, 0);
  if (total > LIMITS.maxTotalUnits) throw new HttpError('invalid-argument', `Orders are limited to ${LIMITS.maxTotalUnits} items in total.`);

  return { idempotencyKey: key, customerName, customerEmail, customerPhone, fulfillmentMethod, fulfillmentDetails, items };
}

/**
 * Build order line snapshots from AUTHORITATIVE product/variant data and compute totals in integer cents.
 * `lookup(productId, variantId)` returns { product, variant } (either may be undefined).
 * Collects every problem so the client can fix the cart in one pass.
 */
function priceOrder(items, lookup) {
  const problems = [];
  const lines = [];
  let subtotalCents = 0;
  for (const it of items) {
    const { product, variant } = lookup(it.productId, it.variantId);
    if (!product || product.active !== true) { problems.push({ productId: it.productId, variantId: it.variantId, reason: 'product_unavailable' }); continue; }
    if (!variant || variant.active !== true) { problems.push({ productId: it.productId, variantId: it.variantId, reason: 'variant_unavailable' }); continue; }
    const unit = product.priceCents;
    if (!Number.isInteger(unit) || unit < 0 || unit > LIMITS.priceMaxCents) { problems.push({ productId: it.productId, variantId: it.variantId, reason: 'product_unavailable' }); continue; }
    const lineTotal = unit * it.quantity;
    subtotalCents += lineTotal;
    lines.push({
      productId: it.productId,
      variantId: it.variantId,
      productName: product.name,
      size: variant.size,
      color: variant.color,
      sku: variant.sku || null,
      quantity: it.quantity,
      unitPriceCents: unit,
      lineTotalCents: lineTotal,
    });
  }
  return { lines, subtotalCents, problems };
}

/** Variant id derived from size/color so a combination can only exist once. */
function variantIdFor(size, color) {
  const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug(size)}__${slug(color)}`.slice(0, 64);
}

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'product';
}

/** Product images must be served from Firebase Storage (https). The local emulator's http://127.0.0.1 URLs are accepted only when running in the emulator. */
function isAllowedImageUrl(url) {
  if (url.length > 2000) return false;
  if (/^https:\/\/(firebasestorage\.googleapis\.com|storage\.googleapis\.com)\//.test(url)) return true;
  return process.env.FUNCTIONS_EMULATOR === 'true' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url);
}
/** Validate an admin product payload. */
function validateProductInput(data) {
  if (!data || typeof data !== 'object') throw new HttpError('invalid-argument', 'Invalid product.');
  const name = cleanText(data.name, 120, 'Name', { required: true });
  const description = cleanText(data.description, 4000, 'Description');
  if (!Number.isInteger(data.priceCents) || data.priceCents < 0 || data.priceCents > LIMITS.priceMaxCents) {
    throw new HttpError('invalid-argument', `Price must be a whole number of cents between 0 and ${LIMITS.priceMaxCents}.`);
  }
  const images = [];
  for (const im of Array.isArray(data.images) ? data.images : []) {
    if (!im || typeof im.url !== 'string' || !isAllowedImageUrl(im.url)) throw new HttpError('invalid-argument', 'Invalid image URL.');
    if (typeof im.path !== 'string' || !/^products\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._-]{1,120}$/.test(im.path)) throw new HttpError('invalid-argument', 'Invalid image path.');
    images.push({ url: im.url, path: im.path, alt: cleanText(im.alt, 200, 'Image description') });
  }
  if (images.length > 10) throw new HttpError('invalid-argument', 'A product can have at most 10 images.');
  const seen = new Set();
  const variants = [];
  if (!Array.isArray(data.variants)) throw new HttpError('invalid-argument', 'Variants are required.');
  if (data.variants.length > 100) throw new HttpError('invalid-argument', 'Too many variants.');
  for (const v of data.variants) {
    const size = cleanText(v && v.size, 30, 'Size', { required: true });
    const color = cleanText(v && v.color, 40, 'Color', { required: true });
    const id = variantIdFor(size, color);
    if (!id || seen.has(id)) throw new HttpError('invalid-argument', `Duplicate variant: ${size} / ${color}.`);
    seen.add(id);
    const sku = cleanText(v.sku, 60, 'SKU');
    variants.push({ id, size, color, sku: sku || null, active: v.active !== false });
  }
  return { name, description, priceCents: data.priceCents, images, variants, active: data.active === true, featured: data.featured === true };
}

function validateScheduleName(name) {
  return cleanText(name, 100, 'Schedule name', { required: true });
}

function hashKey(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function formatOrderNumber(n) {
  return `THTC-${String(n).padStart(5, '0')}`;
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = {
  LIMITS, ORDER_STATUSES, TRANSITIONS, canTransition, HttpError, cleanText,
  validateOrderRequest, priceOrder, variantIdFor, slugify, validateProductInput, validateScheduleName,
  hashKey, formatOrderNumber, money,
};
