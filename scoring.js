/* ===========================================================================
   The light game layer: points, clean weeks, streaks, who's ahead.
   Pure functions — everything is derived from the ticks, nothing is stored.
   `ctx` supplies the data and the few date helpers that live in app.js.
   =========================================================================== */

export const DEFAULT_POINTS = 2;

export function pointsOf(task) {
  const p = Number(task && task.points);
  return p > 0 ? p : DEFAULT_POINTS;
}

/** Points each person has banked, all time. Credit goes to whoever ticked. */
export function personTotals(ctx) {
  const byId = new Map(ctx.tasks.map((t) => [t.id, t]));
  const totals = {};
  for (const person of ctx.people) totals[person] = 0;
  for (const tick of Object.values(ctx.ticks)) {
    const task = byId.get(tick.task_id);
    if (task && tick.by_name in totals) totals[tick.by_name] += pointsOf(task);
  }
  return totals;
}

/** Whoever is ahead — null while everyone is still on nothing. */
export function leader(ctx) {
  const totals = personTotals(ctx);
  let best = null;
  for (const [name, points] of Object.entries(totals)) {
    if (points > 0 && (!best || points > best.points)) best = { name, points };
  }
  return best;
}

/** Did this person's room get finished that week? */
export function isCleanWeek(ctx, week, person) {
  const who = ctx.assignmentsFor(week);
  const room = ctx.rooms.find((r) => who[r.id] === person);
  if (!room) return false;
  const tasks = ctx.tasksIn(room.id);
  return tasks.length > 0 && tasks.every((t) => ctx.ticks[ctx.tickKey(week, t.id)]);
}

/**
 * Consecutive clean weeks. The week in progress counts when it's already
 * finished, and never breaks the streak while it's still under way —
 * a streak should only be lost by missing a week, not by it being Tuesday.
 */
export function streak(ctx, person, upToWeek) {
  let week = upToWeek;
  let run = 0;
  if (!isCleanWeek(ctx, week, person)) week = ctx.addWeeks(week, -1);
  while (ctx.weekIndex(week) >= 0 && isCleanWeek(ctx, week, person)) {
    run++;
    week = ctx.addWeeks(week, -1);
  }
  return run;
}

/** Points banked in one week, per person. */
export function weekPoints(ctx, week) {
  const byId = new Map(ctx.tasks.map((t) => [t.id, t]));
  const out = {};
  for (const person of ctx.people) out[person] = 0;
  for (const task of ctx.tasks) {
    const tick = ctx.ticks[ctx.tickKey(week, task.id)];
    if (tick && tick.by_name in out) out[tick.by_name] += pointsOf(byId.get(task.id));
  }
  return out;
}
