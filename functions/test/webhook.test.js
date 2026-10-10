'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const W = require('../lib/webhook');

test('only genuine Make webhook URLs are accepted', () => {
  for (const ok of ['https://hook.us1.make.com/abcdefghij1234567890', 'https://hook.eu2.make.com/abcdefgh', 'https://hook.eu1.integromat.com/abcdefghijk']) {
    assert.equal(W.validateWebhookConfig(ok, '').ok, true, ok);
  }
  for (const bad of ['', 'http://hook.us1.make.com/abcdefghij', 'https://evil.example.com/abcdefghij', 'https://hook.us1.make.com.evil.com/abcdefghij', 'https://hook.us1.make.com/abc', 'https://hook.us1.make.com/abcdefghij/extra', 'https://user@hook.us1.make.com/abcdefghij', 'https://169.254.169.254/latest/meta-data', null, 5, 'https://hook.us1.make.com/abcdefghij?x=1']) {
    assert.equal(W.validateWebhookConfig(bad, '').ok, false, String(bad));
  }
  assert.equal(W.validateWebhookConfig('https://hook.us1.make.com/abcdefghij', 'has space').ok, false);
  assert.equal(W.validateWebhookConfig(' https://hook.us1.make.com/abcdefghij ', ' key123 ').token, 'key123');
});

test('describeWebhook never reveals the full URL or the key', () => {
  const d = W.describeWebhook({ url: 'https://hook.us1.make.com/SECRETSECRET1234', token: 'k' });
  assert.deepEqual(d, { configured: true, host: 'hook.us1.make.com', hint: '...1234', tokenSet: true });
  assert.doesNotMatch(JSON.stringify(d), /SECRETSECRET/);
  assert.deepEqual(W.describeWebhook(null), { configured: false });
});

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}/hook` }));
  });
}
const job = { id: 'order1_customer', kind: 'customer_confirmation', to: 'pat@example.com', subject: 'Hi', text: 't', html: '<p>h</p>', orderId: 'order1' };

test('2xx from the webhook counts as accepted and the payload/headers are right', async () => {
  let seen;
  const { s, url } = await server((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { seen = { headers: req.headers, body: JSON.parse(b) }; res.end('Accepted'); }); });
  const r = await W.sendViaWebhook(job, { url, token: 'k3y' }, { replyTo: 'admin@x.com' });
  s.close();
  assert.deepEqual(r.accepted, ['pat@example.com']);
  assert.equal(seen.body.to, 'pat@example.com');
  assert.equal(seen.body.subject, 'Hi');
  assert.equal(seen.body.html, '<p>h</p>');
  assert.equal(seen.body.kind, 'customer_confirmation');
  assert.equal(seen.body.id, 'order1_customer');
  assert.equal(seen.body.replyTo, 'admin@x.com');
  assert.equal(seen.headers['x-make-apikey'], 'k3y');
  assert.equal(seen.headers['x-thtc-idempotency'], 'order1_customer');
});

test('no key header is sent when no key is configured', async () => {
  let h;
  const { s, url } = await server((req, res) => { h = req.headers; res.end('ok'); });
  await W.sendViaWebhook(job, { url, token: null });
  s.close();
  assert.equal(h['x-make-apikey'], undefined);
});

test('non-2xx answers, redirects, timeouts and a missing config are failures (so the queue retries)', async () => {
  const a = await server((req, res) => { res.statusCode = 429; res.end('rate limited'); });
  await assert.rejects(W.sendViaWebhook(job, { url: a.url }), /answered 429: rate limited/);
  a.s.close();
  const b = await server((req, res) => { res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.1:1/'); res.end(); });
  await assert.rejects(W.sendViaWebhook(job, { url: b.url }));
  b.s.close();
  const c = await server(() => { /* never answers */ });
  await assert.rejects(W.sendViaWebhook(job, { url: c.url }, { timeoutMs: 150 }), /timed out/);
  c.s.closeAllConnections(); c.s.close();
  await assert.rejects(W.sendViaWebhook(job, null), /not configured/);
  await assert.rejects(W.sendViaWebhook(job, { url: 'http://127.0.0.1:1/x' }), /Could not reach Make/);
});
