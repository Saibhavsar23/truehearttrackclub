'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/time');

const iso = (ms) => new Date(ms).toISOString();

test('winter local time uses EST (UTC-5)', () => {
  const r = T.nyLocalToMillis('2026-01-15T09:00');
  assert.ok(r.ok);
  assert.equal(iso(r.millis), '2026-01-15T14:00:00.000Z');
});

test('summer local time uses EDT (UTC-4)', () => {
  const r = T.nyLocalToMillis('2026-07-15T09:00');
  assert.equal(iso(r.millis), '2026-07-15T13:00:00.000Z');
});

test('spring-forward: 02:30 on 2026-03-08 does not exist and is rejected', () => {
  const r = T.nyLocalToMillis('2026-03-08T02:30');
  assert.equal(r.ok, false);
  assert.match(r.error, /does not exist/);
});

test('spring-forward: the instants either side of the gap are one hour apart', () => {
  const a = T.nyLocalToMillis('2026-03-08T01:59');
  const b = T.nyLocalToMillis('2026-03-08T03:00');
  assert.equal(iso(a.millis), '2026-03-08T06:59:00.000Z'); // still EST
  assert.equal(iso(b.millis), '2026-03-08T07:00:00.000Z'); // EDT
  assert.equal(b.millis - a.millis, 60 * 1000);
});

test('fall-back: 01:30 on 2026-11-01 happens twice and resolves to the first (EDT) occurrence', () => {
  const r = T.nyLocalToMillis('2026-11-01T01:30');
  assert.ok(r.ok);
  assert.equal(iso(r.millis), '2026-11-01T05:30:00.000Z');
  assert.equal(T.millisToNyLocal(r.millis), '2026-11-01T01:30');
});

test('after fall-back 03:00 is EST (UTC-5)', () => {
  assert.equal(iso(T.nyLocalToMillis('2026-11-01T03:00').millis), '2026-11-01T08:00:00.000Z');
});

test('a schedule spanning spring-forward is 23 real hours', () => {
  const a = T.nyLocalToMillis('2026-03-07T20:00').millis;
  const b = T.nyLocalToMillis('2026-03-08T20:00').millis;
  assert.equal((b - a) / 3600000, 23);
});

test('a schedule spanning fall-back is 25 real hours', () => {
  const a = T.nyLocalToMillis('2026-10-31T20:00').millis;
  const b = T.nyLocalToMillis('2026-11-01T20:00').millis;
  assert.equal((b - a) / 3600000, 25);
});

test('rejects malformed and impossible input', () => {
  for (const bad of ['', 'tomorrow', '2026-13-01T10:00', '2026-02-30T10:00', '2026-01-01 10:00', null, 5, '2026-01-01T25:00']) {
    assert.equal(T.nyLocalToMillis(bad).ok, false, String(bad));
  }
});

test('interval is half-open: opensAt <= now < closesAt', () => {
  const s = { active: true, opensAtMillis: 1000, closesAtMillis: 2000 };
  assert.equal(T.isScheduleOpen(s, 999), false);
  assert.equal(T.isScheduleOpen(s, 1000), true);
  assert.equal(T.isScheduleOpen(s, 1999), true);
  assert.equal(T.isScheduleOpen(s, 2000), false);
  assert.equal(T.isScheduleOpen({ ...s, active: false }, 1500), false);
});

test('evaluateStatus: open, closed with next opening, closed with none', () => {
  const list = [
    { id: 'a', name: 'Drop 1', active: true, opensAtMillis: 1000, closesAtMillis: 2000 },
    { id: 'b', name: 'Drop 2', active: true, opensAtMillis: 5000, closesAtMillis: 6000 },
    { id: 'c', name: 'Off', active: false, opensAtMillis: 3000, closesAtMillis: 4000 },
  ];
  assert.deepEqual([T.evaluateStatus(list, 1500).open, T.evaluateStatus(list, 1500).closesAtMillis], [true, 2000]);
  const mid = T.evaluateStatus(list, 2000);
  assert.equal(mid.open, false);
  assert.equal(mid.nextOpensAtMillis, 5000); // inactive schedule is ignored
  const after = T.evaluateStatus(list, 6000);
  assert.equal(after.open, false);
  assert.equal(after.nextOpensAtMillis, null); // never invents a reopening date
});

test('intervalsOverlap treats touching intervals as non-overlapping', () => {
  assert.equal(T.intervalsOverlap(0, 10, 10, 20), false);
  assert.equal(T.intervalsOverlap(0, 11, 10, 20), true);
});
