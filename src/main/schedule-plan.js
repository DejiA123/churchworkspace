'use strict';
/**
 * AUTO-SCHEDULE — pick the day and time for a batch of posts.
 *
 * Two rules, and they can disagree:
 *
 *   1. the operator's spacing (3, 6, 9 or 12 hours apart), and
 *   2. the hours anyone is actually looking (nobody sees a 04:00 post).
 *
 * Spacing wins on the ORDER and the rough pace; the posting windows win on the
 * exact hour. So a 3-hour spacing does not put a post at 03:00 — it slides that
 * one to the next window and carries on from there, which is what "3 hours
 * apart" means to a person and not what the arithmetic alone would produce.
 *
 * Pure and clock-injectable, so the behaviour at midnight, on a Sunday, or on
 * the last day of a month is a test rather than a hope.
 */

/*
 * When people actually watch, in local hours. Weighted for a church audience:
 * the morning commute, lunch, the after-work evening — and Sunday morning,
 * which is the single best slot a church has.
 */
const WINDOWS = [
  { hour: 9, label: 'morning' },
  { hour: 12, label: 'lunchtime' },
  { hour: 15, label: 'afternoon' },
  { hour: 18, label: 'early evening' },
  { hour: 20, label: 'evening' },
];
/** Sunday gets an extra early slot — the service-morning audience. */
const SUNDAY_EXTRA = { hour: 7, label: 'Sunday morning' };
const SPACINGS = [3, 6, 9, 12];

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const at = (day, hour) => { const x = startOfDay(day); x.setHours(hour, 0, 0, 0); return x; };

/** Every posting window on a given day, in order. */
function windowsFor(day) {
  const list = WINDOWS.slice();
  if (new Date(day).getDay() === 0) list.unshift(SUNDAY_EXTRA);
  return list.slice().sort((a, b) => a.hour - b.hour);
}

/**
 * The first posting window at or after `from`, searching forward day by day.
 * Never returns a time in the past.
 */
function nextWindow(from) {
  const start = new Date(from);
  for (let d = 0; d < 14; d++) {
    const day = new Date(start);
    day.setDate(day.getDate() + d);
    for (const w of windowsFor(day)) {
      const t = at(day, w.hour);
      if (t.getTime() >= start.getTime()) return { at: t, label: w.label };
    }
  }
  // Fourteen days without a slot is impossible, but never return nothing.
  const t = new Date(start); t.setHours(t.getHours() + 1, 0, 0, 0);
  return { at: t, label: 'next hour' };
}

/**
 * Plan `count` posts, `spacingHours` apart, starting no sooner than `from`
 * (default: an hour from now, so nothing fires the moment it is scheduled).
 *
 * Returns [{ at: Date, iso, label, dayLabel }] in order.
 */
function planSchedule({ count, spacingHours = 6, now = new Date(), from = null, leadMinutes = 60 } = {}) {
  const n = Math.max(0, Math.floor(count) || 0);
  if (!n) return [];
  const gap = SPACINGS.includes(Number(spacingHours)) ? Number(spacingHours) : 6;
  const earliest = from ? new Date(from) : new Date(new Date(now).getTime() + leadMinutes * 60000);

  const out = [];
  let cursor = earliest;
  for (let i = 0; i < n; i++) {
    const slot = nextWindow(cursor);
    out.push(slot);
    // The NEXT one is the spacing on from the slot we just used, then snapped to
    // a window again. Adding the gap to the cursor instead would let the posts
    // drift closer together every time a slot was pushed forward.
    cursor = new Date(slot.at.getTime() + gap * 3600000);
  }
  return out.map((s) => ({
    at: s.at,
    iso: s.at.toISOString(),
    label: s.label,
    dayLabel: s.at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
    timeLabel: s.at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  }));
}

/** A one-line description of what the plan will do, for the confirmation. */
function describePlan(plan, spacingHours) {
  if (!plan.length) return 'Nothing to schedule.';
  const first = plan[0], last = plan[plan.length - 1];
  return `${plan.length} post${plan.length > 1 ? 's' : ''}, about ${spacingHours}h apart, `
    + `from ${first.dayLabel} ${first.timeLabel} to ${last.dayLabel} ${last.timeLabel}.`;
}

module.exports = { planSchedule, nextWindow, windowsFor, describePlan, WINDOWS, SUNDAY_EXTRA, SPACINGS };
