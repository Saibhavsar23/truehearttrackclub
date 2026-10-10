'use strict';
/**
 * Time helpers. Every store schedule is entered and displayed in America/New_York,
 * and stored as an absolute instant (Firestore Timestamp). No EST/EDT offsets are
 * hardcoded: luxon resolves the correct offset from the IANA tz database.
 */
const { DateTime } = require('luxon');

const ZONE = 'America/New_York';
const LOCAL_FORMAT = "yyyy-LL-dd'T'HH:mm";

/**
 * Convert a New York wall-clock string ("2026-03-08T09:30") to an absolute instant.
 *
 * - A wall time that does not exist (spring-forward gap, e.g. 02:30 on 2026-03-08) is rejected.
 * - A wall time that occurs twice (fall-back overlap, e.g. 01:30 on 2026-11-01) resolves to the
 *   FIRST occurrence (the earlier instant, still on daylight time). This is documented in the README.
 * Returns { ok: true, millis } or { ok: false, error }.
 */
function nyLocalToMillis(local) {
  if (typeof local !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) {
    return { ok: false, error: 'Date/time must look like YYYY-MM-DDTHH:mm (New York time).' };
  }
  const dt = DateTime.fromFormat(local, LOCAL_FORMAT, { zone: ZONE });
  if (!dt.isValid) return { ok: false, error: 'That is not a valid calendar date/time.' };
  // Gap detection: luxon shifts a non-existent time forward, so the round trip will not match.
  if (dt.toFormat(LOCAL_FORMAT) !== local) {
    return { ok: false, error: 'That local time does not exist in New York (daylight-saving gap). Pick another time.' };
  }
  // Overlap: luxon returns the first occurrence for ambiguous local times; make that explicit.
  const earlier = dt.minus({ hours: 1 });
  const first = earlier.toFormat(LOCAL_FORMAT) === local ? earlier : dt;
  return { ok: true, millis: first.toMillis() };
}

/** Format an instant as a New York wall-clock string suitable for <input type="datetime-local">. */
function millisToNyLocal(millis) {
  return DateTime.fromMillis(millis, { zone: ZONE }).toFormat(LOCAL_FORMAT);
}

/** Human readable New York time, e.g. "Sat, Mar 8, 2026, 9:30 AM EST". */
function formatNy(millis) {
  return DateTime.fromMillis(millis, { zone: ZONE }).toFormat("ccc, LLL d, yyyy, h:mm a ZZZZ");
}

/** The store is open when opensAt <= now < closesAt for any ACTIVE schedule. */
function isScheduleOpen(schedule, nowMillis) {
  return schedule.active === true && schedule.opensAtMillis <= nowMillis && nowMillis < schedule.closesAtMillis;
}

/**
 * Evaluate store status from a list of schedules ({active, opensAtMillis, closesAtMillis, name, id}).
 * Overlap policy at runtime: the store is open if ANY active schedule contains `now` (union),
 * and the effective close time is the latest closesAt among the schedules that contain `now`
 * chained together. Overlapping active schedules are also rejected at save time, so this is a safety net.
 */
function evaluateStatus(schedules, nowMillis) {
  const active = schedules.filter((s) => s.active === true).sort((a, b) => a.opensAtMillis - b.opensAtMillis);
  const current = active.filter((s) => isScheduleOpen(s, nowMillis));
  if (current.length) {
    const closesAtMillis = Math.max(...current.map((s) => s.closesAtMillis));
    return { open: true, schedule: current[0], closesAtMillis, nextOpensAtMillis: null };
  }
  const upcoming = active.find((s) => s.opensAtMillis > nowMillis);
  return { open: false, schedule: null, closesAtMillis: null, nextOpensAtMillis: upcoming ? upcoming.opensAtMillis : null, nextSchedule: upcoming || null };
}

/** Two half-open intervals [a0,a1) and [b0,b1) overlap iff a0 < b1 && b0 < a1. */
function intervalsOverlap(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

module.exports = { ZONE, nyLocalToMillis, millisToNyLocal, formatNy, isScheduleOpen, evaluateStatus, intervalsOverlap };
