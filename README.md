# True Heart Track Club: website + merch store

The existing single-page site (`index.html`, hosted on Vercel from this repo) now has a merchandise store:
a storefront at `/shop/`, an admin dashboard at `/admin/`, and a Firebase backend (Firestore, Auth, Storage, Cloud Functions).
**There is no payment processing.** Customers submit an order; payment and fulfillment are arranged separately.

> **Status: built and tested locally against the Firebase Emulator Suite. Not yet connected to a real Firebase project,
> a real Make.com email scenario, or deployed.** See [Status](#status) for exactly what is and isn't verified.
> Do not treat it as production-ready until the checklist at the bottom is done.

## Status

| Area | State |
|---|---|
| Existing site (design, content, nav, links) | Unchanged except 13 lines: Shop links in nav/menu/footer + a cart-count badge (`git diff main -- index.html`) |
| Storefront (catalog, variants, cart, checkout, confirmation, closed page, empty/loading/error states) | Implemented. Driven end to end in a browser against the emulators |
| Cart persistence (localStorage, stale-item handling) | Implemented. Verified across reload |
| Order backend (validation, authoritative pricing, schedule check, idempotency, rate limit) | Implemented and tested (emulator tests incl. 12 concurrent orders) |
| Store schedules (New York time, DST, overlap rules, server-side enforcement) | Implemented and tested (spring-forward gap, fall-back overlap, 23 h / 25 h days, open/close boundaries) |
| Admin dashboard (overview, orders, products + photo upload, schedules, settings) | Implemented. Exercised in a browser against the emulators |
| Admin authorization (custom claim, re-checked server-side on every call; rules deny all client writes) | Implemented and tested (6 callable tests, 7 rules tests incl. Storage) |
| Email (queue, retry/backoff, lease, dedupe, templates; delivered by a **Make.com webhook** you paste into Admin → Settings) | Implemented and tested against a local fake webhook. **A real Make scenario and real email delivery have NOT been tested** |
| Accessibility | axe-core (WCAG 2 A/AA) found 0 violations on the shop, cart, checkout (with errors), and every admin screen. **Not tested** with a real screen reader, or on real iOS/Android devices |
| Firebase deploy, Make scenario + webhook, first admin | **Awaiting your configuration** (steps below) |
| Vercel deploy of these changes | **Not done / not verified.** Changes are on branch `merch-store`, not pushed |

Test counts: 24 unit + 30 emulator (rules, orders, mail) + 6 callable-auth = **60 passing**.

## Architecture

```
Browser (Vercel, static files)                 Firebase (separate backend)
  index.html  (existing site)                    Auth ........ admin sign-in; custom claim admin:true
  shop/index.html + assets/js/shop.js  ──read──> Firestore ... products, variants (public: active only), settings
  admin/index.html + assets/js/admin.js          Storage ..... product photos (public read, admin write)
        │                                        Functions ... ALL writes + trusted logic (Admin SDK):
        └── httpsCallable ─────────────────────►   getStoreStatus, submitOrder, admin* , deliverMail, retryMail
```

* **No build step.** Plain static files + ES modules; the Firebase web SDK loads from `gstatic.com` pinned to `11.10.0`.
  Vercel keeps deploying `main` exactly as before.
* **Browsers cannot write to Firestore at all.** `firestore.rules` allows only reads (public catalog; admin-only orders,
  mail, schedules). Everything else is denied and tested.
* **There is no inventory.** Every drop is a pre-order: the shop is open for a window, then you order exactly what was requested.
  Admin → Overview → "What to order" totals every non-cancelled order per product / size / color.
* The **server** recomputes prices from the database; client prices/subtotals are ignored. See [`docs/SCHEMA.md`](docs/SCHEMA.md).

### What changed in the repo
```
index.html                 (13 lines: Shop nav links + cart badge)
shop/ , admin/             new pages
assets/                    logo.webp/favicon extracted from index.html's data URIs; css/ js/
functions/                 Cloud Functions (Node 22): index.js, lib/{time,logic,service,mail}.js, unit tests
firestore.rules, storage.rules, firestore.indexes.json, firebase.json, .firebaserc
scripts/                   set-admin.js (grant/revoke admin), seed-emulator.js (DEV ONLY)
tests/                     emulator tests (rules, orders, mail queue, callable auth)
docs/SCHEMA.md             database schema, schedule/DST rules, order lifecycle
.gitignore, .vercelignore  secrets/node_modules excluded
```

### Vercel
Nothing about hosting changes: same repo, same project, `index.html` still at the root, no `vercel.json`, no build command, no
DNS/domain changes. New pages are folders with an `index.html`, so `/shop/` and `/admin/` work as static routes.
`.vercelignore` keeps backend/test files out of CLI deployments (Git-integration deployments serve the checkout as-is; the backend
files contain no secrets and are not linked from any page). **No Vercel environment variables are needed**: the Firebase web config
is public and lives in `assets/js/firebase-config.js`. Never put the service account or the Make webhook URL in Vercel or in git.

## Firebase setup (one time)

1. **Create a Firebase project** at https://console.firebase.google.com and upgrade it to the **Blaze** plan (Cloud Functions and
   Secret Manager require it; usage for a small store stays within free quotas, but set a budget alert).
2. **Enable these services/APIs** (the console and `firebase deploy` enable most automatically; confirm in Google Cloud > APIs):
   * Authentication → Sign-in method → **Email/Password** only. Do not enable anonymous or other providers. In Authentication →
     Settings → User actions, **disable "Enable create (sign-up)"** if offered (Identity Platform); even if sign-up stays on,
     a new account has no `admin` claim and can do nothing.
   * Cloud Firestore (production mode, a US region), Cloud Storage (a US region), Cloud Functions (2nd gen), Cloud Run,
     Cloud Build, Artifact Registry, Eventarc, Cloud Scheduler, Pub/Sub, Identity Toolkit API.
   * Optional but recommended: Firebase App Check (reCAPTCHA v3).
3. **Register a Web app** (Project settings → Your apps → `</>`). Copy the config into `assets/js/firebase-config.js`
   (replace every `REPLACE_ME`). These values are public identifiers, not secrets.
4. **Set the project id** in `.firebaserc` (`demo-thtc-store` → your project id), or run `firebase use --add`.
5. **Authentication → Settings → Authorized domains**: add your production domain(s) (and the Vercel `*.vercel.app` preview domain
   if you want to test there). `localhost` is there by default.
6. **Deploy rules, indexes, and functions** (install the CLI: `npm i -g firebase-tools`, then `firebase login`):
   ```bash
   cd functions && npm install && cd ..
   firebase deploy --only firestore:rules,firestore:indexes,storage
   firebase deploy --only functions
   ```
   Index builds take a few minutes; the admin Orders/Overview tabs need them. Confirm the two TTL policies
   (`rateLimits.expireAt`, `idempotency.expireAt`) in Firestore → TTL (create them there if the CLI skipped them).
7. If `functions` region should differ from `us-east1`, change `REGION` in `functions/index.js` **and** `functionsRegion` in
   `assets/js/firebase-config.js`.

### Function configuration
Non-secret settings are function *parameters* (the CLI prompts for them on first deploy, or put them in
`functions/.env.<your-project-id>`, which is gitignored):

| param | meaning | default |
|---|---|---|
| `SITE_URL` | **set to your production URL**, e.g. `https://truehearttrackclub.com` (used for the admin link in emails) | empty |
| `ADMIN_EMAIL` | where new-order notifications go, and the Reply-To on customer emails | `truehearttrackclub@gmail.com` |
| `ENFORCE_APP_CHECK` | reject calls without a valid App Check token (leave `false` unless you set up App Check) | `false` |

There are **no email passwords or secrets to deploy**. Email is sent by Make.com (next section).

### Email via Make.com
The store never talks to an email server. For each email it POSTs one JSON document to a Make **custom webhook**, and a Make scenario
sends the real email from your own Gmail/Outlook/etc. connection.

1. In Make: **Create a scenario** → first module **Webhooks → Custom webhook → Add** → copy the URL (looks like
   `https://hook.us1.make.com/...`).
2. In the store admin: **Settings → Email (Make.com)** → paste the URL → **Save webhook**. (Optional: enable API-key
   authentication on the Make webhook and paste the same key; the function sends it in the `x-make-apikey` header. Verify the header
   name in Make's webhook settings.)
3. Click **Send test email to admin**. Make's webhook module will "learn" the data structure: `to, subject, text, html, kind, replyTo, fromName, id, orderId`.
4. Add a second module, e.g. **Gmail → Send an email**: To = `to`, Subject = `subject`, Content type = HTML, Content = `html`
   (optional Reply-To = `replyTo`). Turn the scenario **ON** (scheduling: Immediately). Send another test.
5. That one scenario handles every email: new-order notification, customer confirmation, and status updates (`kind` tells them apart).

Behaviour to know:
* The webhook URL is stored in `private/mailWebhook` in Firestore, which **no browser can read (admins included)**; the admin page shows
  only a masked hint. Only URLs shaped like `https://hook.<region>.make.com/<id>` are accepted. Treat the URL as a password: anyone who has it
  can make your scenario send email.
* Orders never depend on email. If the webhook is missing or Make is down, orders are still saved and the emails **wait and retry
  automatically** (backoff up to an hour, 8 attempts) and are delivered once the webhook works; failed ones can be retried from the order view.
* "Sent" in the order view means **Make accepted the payload**. If the scenario fails afterwards (e.g. Gmail disconnects), check
  Make → History. Each payload has a stable `id` (and `x-thtc-idempotency` header); use it with a Make data store if you ever need hard de-duplication.
* Make plan limits apply: every email costs a few Make operations (webhook + send module); a typical order sends two emails. Check your
  current Make plan's monthly operation allowance.
### Adding and removing administrators
Admin = a Firebase Auth user with the custom claim `admin: true`. There is no admin sign-up page, no hardcoded password, and no
Firestore field that grants access. Every privileged function re-reads the user record on the server, so revocation is immediate
for writes.

1. Create the person's account: Firebase console → Authentication → Users → **Add user** (email + password they will change).
2. Grant from a trusted machine (needs Application Default Credentials: `gcloud auth application-default login`, or a
   service-account key kept **outside** this repo and referenced by `GOOGLE_APPLICATION_CREDENTIALS`):
   ```bash
   node scripts/set-admin.js add    person@example.com --project=<project-id>
   node scripts/set-admin.js remove person@example.com --project=<project-id>
   node scripts/set-admin.js list --project=<project-id>
   ```
3. They sign in at `/admin/`. A newly granted admin may need to sign out and in once. After `remove`, refresh tokens are revoked and
   all server operations fail immediately; their *read* access via an already-issued ID token can linger up to 1 hour (Firebase
   token lifetime), but they cannot change anything.

Treat service-account keys as secrets: never commit them (`.gitignore` blocks common names).

### Optional: App Check
Create a reCAPTCHA v3 key, register it in Firebase → App Check, paste the **site key** into `appCheckSiteKey` in
`assets/js/firebase-config.js`, deploy, watch App Check metrics until legitimate traffic is verified, then set
`ENFORCE_APP_CHECK=true` and redeploy functions. (Firestore/Storage enforcement can be switched on in the console too.)

### CORS
Callable functions accept browser calls from any origin by default; every sensitive operation is protected by validation and
admin-claim checks, not by origin. To restrict to your domain, add `cors: ['https://your-domain']` to the options in
`functions/index.js` (`base`).

## Running it locally
```bash
cd functions && npm install && cd ..           # once
cd tests && npm install && cd ..               # once
firebase emulators:start --only auth,firestore,functions,storage     # terminal 1
node scripts/seed-emulator.js                                          # terminal 2 (DEV ONLY demo data + admin)
npx http-server . -p 5000 -c-1                                         # terminal 3 (any static server)
```
Open `http://localhost:5000/shop/?emulator=1` and `/admin/?emulator=1` (the flag only works on localhost). Demo admin printed by the
seed script. Emulated functions will try to send mail and fail with "Missing credentials": expected; the queue/retry state is
visible in the admin order view.

### Tests
```bash
npm --prefix functions test     # 24 unit tests: NY time/DST, validation, pricing, transitions
npm --prefix tests test         # 36 emulator tests: rules (Firestore+Storage), orders, concurrency, mail queue, callable auth
```
Requires Java (for the Firestore emulator) and `firebase-tools`. The tests use a local fake webhook and never send email or create real orders.

## How the important behaviours work
* **Order submission** (`submitOrder`): validates input → rate-limits (IP, email) → in **one Firestore transaction**: idempotency check,
  store-open check with server time, read product/variant, price in integer cents, reject if anything is inactive or removed,
  write the order + two email jobs + counter + idempotency record. Nothing is partially applied. The cart is
  cleared in the browser only after success. Emails are sent *after* the order is committed.
* **Duplicate submissions:** the browser keeps one idempotency key per unchanged cart; retries/double-clicks return the same order.
* **Closing mid-checkout:** orders are rejected at/after `closesAt` regardless of the page state; the browser keeps the cart and switches to
  the closed view.
* **Stale carts:** prices refresh from the live catalog; removed items are flagged and block checkout until removed.
* **Deleting orders:** Admin → Orders → open an order → "Delete order permanently" erases it and its email records (no email is sent).
* **Fulfillment** is deliberately undecided: Admin → Settings lets you define options (pickup, shipping...) later with no code change.
  Nothing (rates, locations, payment instructions) is invented.
* **Emails:** new-order (to `ADMIN_EMAIL`), customer confirmation (states payment was not collected), and status updates
  (wording tied to the real status; never claims paid/shipped/delivered).

## Known limitations / decisions to review
* Customers cannot look up past orders (no accounts); they get a confirmation page and email.
* Rate limiting is per IP/email in Firestore; add App Check for stronger bot resistance.
* Admin Firestore *reads* rely on the token claim (≤ 1 hour after revocation); all writes re-verify live.
* Email is at-least-once (see `docs/SCHEMA.md`) and depends on Make being up; failed sends are retried and visible in the admin order view.
* Variant removal retires a variant instead of deleting it; products are deactivated, not deleted.
* Product photos are resized in the browser to 1600 px WebP before upload (5 MB hard limit in Storage rules).
* Times: all admin/customer-facing times are New York time. Fall-back ambiguity resolves to the first occurrence.

## Go-live checklist (nothing below is done yet)
- [ ] Firebase project + Blaze plan + budget alert; `.firebaserc` and `assets/js/firebase-config.js` filled in
- [ ] `firebase deploy` rules/indexes/storage/functions succeed; indexes show **Enabled**; TTL policies exist
- [ ] `SITE_URL` param set; Make scenario built and **ON**; webhook saved in Admin → Settings → Email; test email received
- [ ] First admin created with `scripts/set-admin.js`; sign-in works at `/admin/`
- [ ] Authorized domains include the production domain
- [ ] **Send one real test order with your own email** (this will send real emails; do it deliberately), then cancel it; confirm both
      emails arrive and the order shows `sent`
- [ ] Add a real product + a schedule in the dashboard; check the shop on a real phone
- [ ] Review `git diff main` and merge `merch-store` to `main` (Vercel deploys on merge). Verify the live site afterwards
- [ ] (Recommended) App Check; screen-reader pass (VoiceOver/NVDA) on checkout
