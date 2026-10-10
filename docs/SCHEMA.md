# Firestore schema

All money is **integer cents** (USD). All writes go through Cloud Functions (Admin SDK); the browser may only read what the
rules allow (see `firestore.rules`). Field names marked **(private)** are never readable by the public.

## `products/{productId}`  (public read when `active == true`)
| field | type | notes |
|---|---|---|
| `name`, `slug`, `description` | string | slug is fixed at creation |
| `priceCents` | int | 0 to 100000 |
| `currency` | `"USD"` | |
| `images` | `[{url, path, alt}]` | first image is the main one; `path` is `products/{productId}/{file}` in Storage |
| `active` | bool | only active products are public |
| `featured` | bool | listed first |
| `createdAt`, `updatedAt`, `updatedBy` | timestamp / uid | |

## `products/{productId}/variants/{variantId}`  (public read when variant **and** product are active)
`variantId` = `{size-slug}__{color-slug}`, so a size/color combination can exist only once.

| field | type | notes |
|---|---|---|
| `sku` | string \| null | optional |
| `size`, `color` | string | |
| `active` | bool | removing a row in the admin editor sets this to `false` (history is kept). There are no stock counts: drops are pre-orders |
| `createdAt`, `updatedAt` | timestamp | |

## `inventory/*`  (legacy, unused)
Earlier versions tracked stock here. Nothing reads or writes it any more; the rules still deny public access.

## `storeSchedules/{scheduleId}`  (private, admin read; public status comes from the `getStoreStatus` function)
| field | type | notes |
|---|---|---|
| `name` | string | |
| `opensAt`, `closesAt` | timestamp | absolute instants. Open when `opensAt <= now < closesAt` |
| `active` | bool | |
| `createdAt`, `updatedAt`, `updatedBy` | | |

**New York time conversion.** The admin enters `YYYY-MM-DDTHH:mm` as *New York wall time*. The function converts it with luxon and the
IANA `America/New_York` zone (no hardcoded EST/EDT offsets):
* a wall time that does not exist (spring-forward gap, e.g. 02:30 on 2027-03-14) is rejected;
* a wall time that happens twice (fall-back, e.g. 01:30 on 2026-11-01) resolves to the **first** occurrence (still daylight time);
* the result is stored as a UTC timestamp, so a schedule spanning a DST change is correctly 23 or 25 real hours long.

**Overlaps.** Two *active* schedules may not overlap (rejected on save, naming the conflicting schedule); touching intervals are fine
(`[a,b)` then `[b,c)`). Inactive schedules may overlap anything. As a safety net, at runtime the store is open if *any* active
schedule contains "now".

## `settings/public`  (public read)
`{ fulfillmentMethods: [{id, label, requiresDetails, detailsLabel, enabled}], checkoutNotice, updatedAt, updatedBy }`.
Empty by default. When empty, orders record `fulfillmentMethod: "arranged_separately"` with optional customer notes.

## `orders/{orderId}`  (private, admin read; contains customer PII)
| field | notes |
|---|---|
| `orderNumber` | `THTC-00001`, from a transactional counter |
| `customerName`, `customerEmail`, `customerPhone` | phone optional |
| `fulfillmentMethod`, `fulfillmentDetails` | |
| `items[]` | **immutable snapshot**: `productId, variantId, productName, size, color, sku, quantity, unitPriceCents, lineTotalCents` |
| `subtotalCents`, `currency` | |
| `status` | `submitted → confirmed → preparing → ready → fulfilled`, or `cancelled` |
| `paymentStatus` | always `"not_collected_online"`. The system never marks an order paid |
| `statusHistory[]` | `{status, byUid, atMillis}` |
| `notificationStatus` | `{admin, customer}`: `pending / retrying / sent / failed` |
| `createdAt`, `updatedAt` | |

### Status transitions
| from | allowed next |
|---|---|
| submitted | confirmed, cancelled |
| confirmed | preparing, ready, fulfilled, cancelled |
| preparing | ready, fulfilled, cancelled |
| ready | fulfilled, cancelled |
| fulfilled, cancelled | none (terminal) |

**Cancellation policy:** a non-terminal order can be cancelled (the customer is emailed). A fulfilled order cannot be cancelled. No status change implies payment.

**Deleting:** `adminDeleteOrder` permanently removes an order and its `mail` records (admin only, irreversible, no email sent).

## `mail/{orderId}_{admin|customer|status_N}`  (private, admin read)
Durable email queue. Written **in the same transaction as the order** (or the status change).
`{kind, orderId, orderField, to, subject, text, html, status: pending|sending|sent|failed, attempts, nextAttemptAtMillis, leaseUntilMillis, lastError, sentAt, messageId}`.
Delivery is claimed with a 2-minute lease in a transaction (no concurrent double send), retried with exponential backoff
(1, 2, 4 ... capped at 60 minutes), and marked `failed` after 8 attempts (an admin can requeue it). `sent` is written only when the
Make webhook answered 2xx (Make accepted the payload). The payload `id` is deterministic per job. Delivery is *at-least-once*: a crash in the milliseconds between Make accepting and the `sent` write could repeat one email.

## `private/mailWebhook`  (no client access at all, admins included)
`{ url, token, updatedAt, updatedBy }`: the Make.com webhook. Written only by the `adminSaveMailWebhook` function; the admin UI sees a masked hint.

## Internal collections (no client access at all)
* `counters/orders`: `{next}` order number counter.
* `idempotency/{sha256(key)}`: `{payloadHash, response, orderId, expireAt}`. Same key + same cart returns the original order;
  same key + different cart is rejected.
* `rateLimits/{hash}`: `{windowStartMillis, count, expireAt}`. 10 attempts / 10 min per IP, 5 / 10 min per email.

TTL policies on `expireAt` for `rateLimits` and `idempotency` are declared in `firestore.indexes.json`.

## Indexes (`firestore.indexes.json`)
`products(active, createdAt desc)`, `orders(status, createdAt desc)`, `mail(status, createdAt desc)`.
