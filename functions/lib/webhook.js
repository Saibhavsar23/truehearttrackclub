'use strict';
/**
 * Email delivery through a Make.com (Integromat) custom webhook.
 *
 * Our function POSTs one JSON document per email job; a Make scenario turns it into a real email
 * (Gmail / Email module). Make answers 200 "Accepted" as soon as it has queued the payload, so
 * "sent" in our queue means "Make accepted it". Failures inside the scenario after that point are
 * visible only in Make's execution history.
 */

const MAKE_URL_RE = /^https:\/\/hook\.[a-z0-9-]+\.(make|integromat)\.com\/[A-Za-z0-9]{8,64}$/;
const TOKEN_RE = /^[\x21-\x7e]{1,200}$/;

/** Only genuine Make webhook URLs are accepted, so the function can never be pointed at an arbitrary host. */
function validateWebhookConfig(url, token) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!MAKE_URL_RE.test(u)) {
    return { ok: false, error: 'That does not look like a Make webhook URL. It should be like https://hook.us1.make.com/abc123...' };
  }
  const t = typeof token === 'string' ? token.trim() : '';
  if (t && !TOKEN_RE.test(t)) return { ok: false, error: 'The API key may only contain visible characters (no spaces), up to 200 long.' };
  return { ok: true, url: u, token: t };
}

/** Masked description that is safe to show in the admin UI. */
function describeWebhook(cfg) {
  if (!cfg || !cfg.url) return { configured: false };
  const u = new URL(cfg.url);
  return { configured: true, host: u.hostname, hint: `...${u.pathname.slice(-4)}`, tokenSet: !!cfg.token };
}

/**
 * POST a mail job to the webhook. Resolves in the shape processMail expects, but only for a 2xx answer.
 * `fetchImpl` is injectable for tests.
 */
async function sendViaWebhook(job, cfg, { fetchImpl = fetch, timeoutMs = 15000, fromName = 'True Heart Track Club', replyTo } = {}) {
  if (!cfg || !cfg.url) throw new Error('Email webhook is not configured yet (Admin > Settings > Email).');
  const body = {
    version: 1,
    id: job.id,                 // stable per email: use it in Make to de-duplicate if you wish
    kind: job.kind,             // admin_new_order | customer_confirmation | customer_status | test
    to: job.to,
    subject: job.subject,
    text: job.text,
    html: job.html,
    fromName,
    replyTo: replyTo || null,
    orderId: job.orderId || null,
  };
  const headers = { 'Content-Type': 'application/json', 'x-thtc-idempotency': String(job.id) };
  if (cfg.token) { headers['x-make-apikey'] = cfg.token; headers['x-thtc-token'] = cfg.token; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal, redirect: 'error' });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? `Make webhook timed out after ${timeoutMs} ms` : `Could not reach Make: ${e && e.message}`);
  } finally { clearTimeout(timer); }
  if (res.status < 200 || res.status >= 300) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 120); } catch (_) {}
    throw new Error(`Make webhook answered ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return { accepted: [job.to], rejected: [], messageId: `make:${job.id}` };
}

module.exports = { validateWebhookConfig, describeWebhook, sendViaWebhook, MAKE_URL_RE };
