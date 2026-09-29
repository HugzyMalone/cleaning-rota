/* Points are earned for each completion. One helper bonus applies per room/week. */
export const DEFAULT_POINTS = 10;
export const HELP_BONUS_POINTS = 10;

export function pointsOf(task) {
  const p = Number(task?.points);
  return p >= 10 ? p : DEFAULT_POINTS;
}

export function pointsFor(completion, task) {
  const awarded = Number(completion.points_awarded);
  return awarded >= 10 ? awarded : pointsOf(task);
}

export function helperBonusesForWeek(ctx, week) {
  const bonuses = Object.fromEntries(ctx.people.map((person) => [person, 0]));
  const assigned = ctx.assignmentsFor(week);
  const taskRooms = new Map(ctx.tasks.map((task) => [task.id, task.room_id]));
  const helpers = new Set();
  for (const event of ctx.completions) {
    if (event.week_start !== week || !Object.hasOwn(bonuses, event.by_name)) continue;
    const room = taskRooms.get(event.task_id);
    if (room && assigned[room] && assigned[room] !== event.by_name) helpers.add(`${room}|${event.by_name}`);
  }
  for (const key of helpers) bonuses[key.slice(key.indexOf("|") + 1)] += HELP_BONUS_POINTS;
  return bonuses;
}

export function personTotals(ctx) {
  const byId = new Map(ctx.tasks.map((task) => [task.id, task]));
  const totals = Object.fromEntries(ctx.people.map((person) => [person, 0]));
  const weeks = new Set();
  for (const event of ctx.completions) {
    weeks.add(event.week_start);
    if (byId.has(event.task_id) && Object.hasOwn(totals, event.by_name)) {
      totals[event.by_name] += pointsFor(event, byId.get(event.task_id));
    }
  }
  for (const week of weeks) {
    const bonuses = helperBonusesForWeek(ctx, week);
    for (const person of ctx.people) totals[person] += bonuses[person];
  }
  return totals;
}

export function leader(ctx) {
  const totals = personTotals(ctx);
  let best = null;
  for (const [name, points] of Object.entries(totals)) {
    if (points > 0 && (!best || points > best.points)) best = { name, points };
  }
  return best;
}

export function isCleanWeek(ctx, week, person) {
  const assigned = ctx.assignmentsFor(week);
  const room = ctx.rooms.find((r) => assigned[r.id] === person);
  if (!room) return false;
  const tasks = ctx.tasksIn(room.id);
  const completed = new Set(ctx.completions.filter((e) => e.week_start === week).map((e) => e.task_id));
  return tasks.length > 0 && tasks.every((task) => completed.has(task.id));
}

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

export function weekPoints(ctx, week) {
  const byId = new Map(ctx.tasks.map((task) => [task.id, task]));
  const out = Object.fromEntries(ctx.people.map((person) => [person, 0]));
  for (const event of ctx.completions) {
    if (event.week_start === week && byId.has(event.task_id) && Object.hasOwn(out, event.by_name)) {
      out[event.by_name] += pointsFor(event, byId.get(event.task_id));
    }
  }
  const bonuses = helperBonusesForWeek(ctx, week);
  for (const person of ctx.people) out[person] += bonuses[person];
  return out;
}
