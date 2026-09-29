import { SUPABASE_URL, SUPABASE_ANON_KEY, PEOPLE, START_MONDAY } from "./config.js";
import { pointsOf, pointsFor, personTotals, leader, streak, HELP_BONUS_POINTS } from "./scoring.js?v=3";

/* =========================================================================
   Dates. Everything is a "YYYY-MM-DD" Monday string; maths happens in UTC
   so British Summer Time can never shunt a week by a day.
   ========================================================================= */

const DAY = 86400000;
const WEEK = 7 * DAY;

function parseISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function toISO(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function mondayOfToday() {
  const now = new Date();
  const utc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return toISO(utc - ((new Date(utc).getUTCDay() + 6) % 7) * DAY);
}
function addWeeks(iso, n) {
  return toISO(parseISO(iso) + n * WEEK);
}
function weekIndex(iso) {
  return Math.round((parseISO(iso) - parseISO(START_MONDAY)) / WEEK);
}
// The rota doesn't exist before it starts, so never show a week earlier.
function currentWeek() {
  const today = mondayOfToday();
  return parseISO(today) < parseISO(START_MONDAY) ? START_MONDAY : today;
}

const fmtLong = new Intl.DateTimeFormat("en-GB", {
  weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
});
const fmtShort = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", timeZone: "UTC",
});
const fmtDay = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });

function weekTitle(iso) {
  return fmtLong.format(parseISO(iso));
}
function weekRange(iso) {
  const start = parseISO(iso);
  return fmtShort.format(start) + " – " + fmtShort.format(start + 6 * DAY);
}

/* =========================================================================
   Rotation. Three people, three rooms, a three-week cycle: room i in week w
   belongs to person (i - w). The heavy kitchen therefore lands on each
   person exactly once every three weeks, which is what makes it fair.
   ========================================================================= */

function defaultAssignments(iso, rooms) {
  const w = weekIndex(iso);
  const n = PEOPLE.length;
  const out = {};
  rooms.forEach((room, i) => {
    out[room.id] = PEOPLE[(((i - w) % n) + n) % n];
  });
  return out;
}
function assignmentsFor(iso) {
  const base = defaultAssignments(iso, state.rooms);
  const override = state.swaps[iso];
  return override ? { ...base, ...override } : base;
}
function isSwapped(iso) {
  return Boolean(state.swaps[iso]);
}

/* =========================================================================
   State
   ========================================================================= */

const DEFAULT_ROOMS = [
  { id: "kitchen",  name: "Kitchen",     emoji: "🍳", sort_order: 0 },
  { id: "bathroom", name: "Bathroom",    emoji: "🛁", sort_order: 1 },
  { id: "living",   name: "Living room", emoji: "🛋️", sort_order: 2 },
];

// Points are weighted by effort, so a light room can't out-earn a heavy one.
const DEFAULT_TASKS = [
  ["kitchen", "Wipe countertops", 10], ["kitchen", "Clean the hob", 15],
  ["kitchen", "Clean the sink", 10], ["kitchen", "Hoover the floor", 15],
  ["kitchen", "Mop the floor", 20],
  ["bathroom", "Clean the toilet", 15], ["bathroom", "Clean the sink", 10],
  ["bathroom", "Clean the bath", 20], ["bathroom", "Hoover the floor", 10],
  ["bathroom", "Mop the floor", 15],
  ["living", "Hoover the floor", 15], ["living", "Clean the coffee table", 10],
];

const TINTS = {
  kitchen: "208, 130, 40",
  bathroom: "37, 145, 182",
  living: "87, 146, 63",
};
const NEUTRAL_TINT = "106, 86, 208";

const state = {
  rooms: [],
  tasks: [],
  completions: [],      // one record per time a person finished a task
  swaps: {},            // "YYYY-MM-DD" -> { roomId: person }
  week: currentWeek(),
  planOffset: 0,
  me: localStorage.getItem("rota.me"),
  open: new Set(),      // expanded room ids
  editing: null,        // room id in edit mode
  editTask: null,       // { id, value } mid-rename
  adding: null,         // { roomId, value } mid-add
  mode: "…",            // "live" | "solo"
};

const tasksIn = (roomId) => state.tasks.filter((t) => t.room_id === roomId && !t.archived);
const eventsForTask = (week, taskId) => state.completions.filter((e) => e.week_start === week && e.task_id === taskId);
const latestCompletion = (week, taskId) => eventsForTask(week, taskId).sort((a, b) => b.done_at.localeCompare(a.done_at))[0];

function progress(roomId, week) {
  const list = tasksIn(roomId);
  const done = list.filter((t) => eventsForTask(week, t.id).length).length;
  return { done, total: list.length };
}

// What scoring.js needs to do its sums.
const ctx = {
  get rooms() { return state.rooms; },
  get tasks() { return state.tasks; },
  get completions() { return state.completions; },
  people: PEOPLE,
  tasksIn, assignmentsFor, addWeeks, weekIndex,
};

/* =========================================================================
   Backends. Supabase when configured, otherwise this device only — so the
   page is never broken, just quieter.
   ========================================================================= */

function applyRows({ rooms, tasks, completions, swaps }) {
  state.rooms = rooms.slice().sort((a, b) => a.sort_order - b.sort_order);
  state.tasks = tasks.slice().sort((a, b) => a.sort_order - b.sort_order);
  state.completions = completions;
  state.swaps = {};
  for (const s of swaps) state.swaps[s.week_start] = s.assignments;
}

async function supabaseBackend(onChange) {
  const { createClient } = await import(
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm"
  );
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  async function fetchCompletions() {
    const all = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await sb.from("completions").select("*")
        .order("done_at", { ascending: false }).order("id", { ascending: false })
        .range(start, start + 999);
      if (error) throw error;
      all.push(...data);
      if (data.length < 1000) return all;
    }
  }

  async function fetchAll() {
    const [rooms, tasks, completions, swaps] = await Promise.all([
      sb.from("rooms").select("*"),
      sb.from("tasks").select("*"),
      fetchCompletions(),
      sb.from("swaps").select("*"),
    ]);
    for (const r of [rooms, tasks, swaps]) if (r.error) throw r.error;
    applyRows({
      rooms: rooms.data, tasks: tasks.data, completions, swaps: swaps.data,
    });
  }

  await fetchAll();

  let pending;
  const refresh = () => {
    clearTimeout(pending);
    pending = setTimeout(() => fetchAll().then(onChange).catch(console.warn), 120);
  };

  const channel = sb.channel("rota");
  for (const table of ["rooms", "tasks", "completions", "swaps"]) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, refresh);
  }
  channel.subscribe();

  // Phones suspend sockets in the background; catch up when we come back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });

  return {
    mode: "live",
    refresh: fetchAll,
    async addCompletion(event) {
      const { error } = await sb.from("completions").insert(event);
      if (error) throw error;
    },
    async removeCompletion(id) {
      const { error } = await sb.from("completions").delete().eq("id", id);
      if (error) throw error;
    },
    async addTask(roomId, label, sortOrder) {
      const { data, error } = await sb.from("tasks")
        .insert({ room_id: roomId, label, sort_order: sortOrder })
        .select().single();
      if (error) throw error;
      return data;
    },
    async renameTask(id, label) {
      const { error } = await sb.from("tasks").update({ label }).eq("id", id);
      if (error) throw error;
    },
    async setTaskPoints(id, points) {
      const { error } = await sb.from("tasks").update({ points }).eq("id", id);
      if (error) throw error;
    },
    async deleteTask(id) {
      const { error } = await sb.from("tasks").delete().eq("id", id);
      if (error) throw error;
    },
    async setSwaps(week, map) {
      if (map) {
        const { error } = await sb.from("swaps")
          .upsert({ week_start: week, assignments: map }, { onConflict: "week_start" });
        if (error) throw error;
      } else {
        const { error } = await sb.from("swaps").delete().eq("week_start", week);
        if (error) throw error;
      }
    },
  };
}

function localBackend(onChange) {
  const KEY = "rota.local";

  function read() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      if (raw && raw.rooms) {
        if (!raw.completions) {
          raw.tasks = raw.tasks.map((task) => ({ ...task, points: Math.max(10, Number(task.points || 2) * 5) }));
          raw.completions = (raw.ticks || []).map((tick) => ({
            id: crypto.randomUUID(), week_start: tick.week_start, task_id: tick.task_id,
            by_name: tick.by_name, done_at: tick.done_at,
            points_awarded: raw.tasks.find((task) => task.id === tick.task_id)?.points || 10,
          }));
          delete raw.ticks;
          localStorage.setItem(KEY, JSON.stringify(raw));
        }
        return raw;
      }
    } catch { /* fall through to a fresh seed */ }
    return {
      rooms: DEFAULT_ROOMS,
      tasks: DEFAULT_TASKS.map(([room_id, label, points], i) => ({
        id: "seed-" + i, room_id, label, points, sort_order: i, archived: false,
      })),
      completions: [], swaps: [],
    };
  }
  function write(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
    applyRows(data);
  }

  applyRows(read());

  window.addEventListener("storage", (e) => {
    if (e.key === KEY) { applyRows(read()); onChange(); }
  });

  return {
    mode: "solo",
    async refresh() { applyRows(read()); },
    async addCompletion(event) {
      const data = read();
      data.completions = [...(data.completions || []), event];
      write(data);
    },
    async removeCompletion(id) {
      const data = read();
      data.completions = (data.completions || []).filter((event) => event.id !== id);
      write(data);
    },
    async addTask(roomId, label, sortOrder) {
      const row = { id: crypto.randomUUID(), room_id: roomId, label, points: 10, sort_order: sortOrder, archived: false };
      const data = read();
      data.tasks = data.tasks.concat(row);
      write(data);
      return row;
    },
    async renameTask(id, label) {
      const data = read();
      data.tasks = data.tasks.map((t) => (t.id === id ? { ...t, label } : t));
      write(data);
    },
    async setTaskPoints(id, points) {
      const data = read();
      data.tasks = data.tasks.map((t) => (t.id === id ? { ...t, points } : t));
      write(data);
    },
    async deleteTask(id) {
      const data = read();
      data.tasks = data.tasks.filter((t) => t.id !== id);
      data.completions = (data.completions || []).filter((event) => event.task_id !== id);
      write(data);
    },
    async setSwaps(week, map) {
      const data = read();
      data.swaps = data.swaps.filter((s) => s.week_start !== week);
      if (map) data.swaps.push({ week_start: week, assignments: map });
      write(data);
    },
  };
}

/* =========================================================================
   Rendering
   ========================================================================= */

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function roomIcon(roomId) {
  return document.getElementById("room-" + roomId) ? "room-" + roomId : "room-living";
}
function roomArt(roomId) {
  return ["kitchen", "bathroom", "living"].includes(roomId)
    ? `<img src="./room-${roomId}.png" alt="" width="64" height="64">`
    : `<svg aria-hidden="true"><use href="#${roomIcon(roomId)}"/></svg>`;
}
function ring(done, total) {
  return `<span class="room-count"><strong>${done}/${total}</strong><small>tasks</small></span>`;
}

function tickMeta(tick, assigned) {
  if (!tick) return "";
  const who = tick.by_name;
  const when = tick.done_at ? fmtDay.format(new Date(tick.done_at)) : "";
  const credit = !who || !PEOPLE.includes(who) ? "Done"
    : assigned && who !== assigned
      ? `${who} did this for ${assigned === state.me ? "you" : assigned}`
      : `${who} did this`;
  return credit + (when ? " · " + when : "");
}

function helpSummary(roomId, week) {
  const assigned = assignmentsFor(week)[roomId];
  const helpers = {};
  for (const task of tasksIn(roomId)) {
    for (const event of eventsForTask(week, task.id)) {
      const name = event.by_name;
      if (name && PEOPLE.includes(name) && name !== assigned) helpers[name] = (helpers[name] || 0) + 1;
    }
  }
  const names = Object.keys(helpers);
  if (!names.length) return "";
  const total = Object.values(helpers).reduce((a, b) => a + b, 0);
  const who = names.join(names.length === 2 ? " and " : ", ");
  return `${who} helped ${assigned === state.me ? "you" : assigned} · ${total} task${total === 1 ? "" : "s"} · +${HELP_BONUS_POINTS} bonus${names.length > 1 ? " each" : ""}`;
}

function renderHeader() {
  $("#week-title").textContent = weekTitle(state.week);
  const delta = Math.round((parseISO(state.week) - parseISO(currentWeek())) / WEEK);
  const rel = delta === 0 ? "This week" : delta === 1 ? "Next week"
    : delta === -1 ? "Last week" : delta > 0 ? `In ${delta} weeks` : `${-delta} weeks ago`;
  $("#week-sub").textContent = rel + " · " + weekRange(state.week);
  $("#today-btn").hidden = delta === 0;
  $("#prev-week").disabled = weekIndex(state.week) <= 0;
}

function renderPlanner() {
  $("#plan-prev").disabled = state.planOffset === 0;
  $("#plan-weeks").innerHTML = Array.from({ length: 4 }, (_, i) => {
    const week = addWeeks(currentWeek(), state.planOffset + i);
    const who = assignmentsFor(week);
    const adjusted = isSwapped(week);
    return `<article class="plan-week ${week === currentWeek() ? "plan-current" : ""}">
      <div class="plan-week-head">
        <div><span class="plan-week-date">${esc(weekRange(week))}</span>
        ${week === currentWeek() ? '<span class="plan-now">This week</span>' : ""}</div>
        ${adjusted ? `<button type="button" class="plan-reset" data-plan-reset="${week}">Reset</button>` : ""}
      </div>
      <div class="plan-assignments">${state.rooms.map(room => `
        <label class="plan-assignment">
          <span>${esc(room.name)}</span>
          <select data-assign-room="${esc(room.id)}" data-assign-week="${week}"
            aria-label="${esc(room.name)} for week of ${esc(week)}">
            ${PEOPLE.map(person => `<option value="${esc(person)}" ${who[room.id] === person ? "selected" : ""}>${esc(person)}</option>`).join("")}
          </select>
        </label>`).join("")}</div>
    </article>`;
  }).join("");
}

function renderPeople() {
  $("#people-picker").innerHTML = PEOPLE.map((p) => `
    <button class="person" type="button" data-person="${esc(p)}"
            aria-pressed="${state.me === p}">${esc(p)}</button>`).join("");
}

function renderStats() {
  const chips = [];
  const top = leader(ctx);

  if (state.me) {
    const run = streak(ctx, state.me, state.week);
    if (run > 0) {
      chips.push(`<span class="chip streak"><span class="chip-mark">🔥</span>
        <b>${run}</b> week${run === 1 ? "" : "s"} clean</span>`);
    }
    const mine = personTotals(ctx)[state.me] || 0;
    chips.push(`<span class="chip"><span class="chip-mark">✦</span><b>${mine}</b> pts</span>`);
  }

  if (top) {
    chips.push(top.name === state.me
      ? `<span class="chip leader"><span class="chip-mark">🏆</span>You're top</span>`
      : `<span class="chip leader"><span class="chip-mark">🏆</span><b>${esc(top.name)}</b> leads</span>`);
  } else if (!state.me) {
    chips.push(`<span class="chip">Tap your name to track your streak</span>`);
  }

  $("#stats").innerHTML = chips.join("");
}

function renderRooms() {
  const who = assignmentsFor(state.week);
  const base = defaultAssignments(state.week, state.rooms);

  $("#rooms").innerHTML = state.rooms.map((room) => {
    const swapped = who[room.id] !== base[room.id];
    const list = tasksIn(room.id);
    const { done, total } = progress(room.id, state.week);
    const complete = total > 0 && done === total;
    const mine = state.me && who[room.id] === state.me;
    const helping = helpSummary(room.id, state.week);
    const open = state.open.has(room.id);
    const editing = state.editing === room.id;

    const rows = list.map((task) => {
      if (editing) {
        const value = state.editTask && state.editTask.id === task.id
          ? state.editTask.value : task.label;
        return `
          <div class="task-edit">
            <input type="text" data-rename="${esc(task.id)}" value="${esc(value)}"
                   aria-label="Task name" enterkeyhint="done">
            <label class="points-edit">
              <input type="number" data-points="${esc(task.id)}" value="${pointsOf(task)}"
                     min="10" max="100" inputmode="numeric" aria-label="Points for ${esc(task.label)}">
              <span>pts</span>
            </label>
            <button class="icon-btn danger" type="button" data-delete="${esc(task.id)}"
                    aria-label="Delete ${esc(task.label)}">✕</button>
          </div>`;
      }
      const count = eventsForTask(state.week, task.id).length;
      const tick = latestCompletion(state.week, task.id);
      return `
        <button class="task ${tick ? "done" : ""}" type="button" data-task="${esc(task.id)}"
          aria-label="${esc(task.label)}. ${count} time${count === 1 ? "" : "s"} this week. Tap to log another. ${pointsOf(task)} points">
          <span class="box" aria-hidden="true"><svg><use href="#tick"/></svg></span>
          <span class="task-text">
            <span class="task-label">${esc(task.label)}</span>
            <span class="task-meta">${esc(tickMeta(tick, who[room.id]))}${count > 1 ? ` · ${count} times` : ""}</span>
          </span>
          <span class="task-pts">+${pointsOf(task)}</span>
        </button>`;
    }).join("");

    const adding = state.adding && state.adding.roomId === room.id;
    const addRow = adding ? `
      <div class="task-edit">
        <input type="text" data-add="${esc(room.id)}" value="${esc(state.adding.value)}"
               placeholder="New task…" aria-label="New task" enterkeyhint="done">
        <button class="icon-btn" type="button" data-add-save="${esc(room.id)}" aria-label="Save task">✓</button>
      </div>` : "";

    return `
      <article class="room ${open ? "open" : ""} ${complete ? "complete" : ""} ${mine ? "mine" : ""}"
               data-room="${esc(room.id)}">
        <div class="room-head">
          <span class="tile" aria-hidden="true">${roomArt(room.id)}</span>
          <span class="room-meta">
            <span class="room-name">
              ${esc(room.name)}
              <span class="badge done" ${complete ? "" : "hidden"}>Done</span>
            </span>
            <label class="room-assignment">
              <span>Assigned to</span>
              <select data-assign-room="${esc(room.id)}" data-assign-week="${state.week}"
                aria-label="Who cleans the ${esc(room.name)} this week">
                ${PEOPLE.map(person => `<option value="${esc(person)}" ${who[room.id] === person ? "selected" : ""}>${esc(person)}</option>`).join("")}
              </select>
              <span class="badge you" ${mine ? "" : "hidden"}>You</span>
              <span class="badge swapped" ${swapped ? "" : "hidden"}>Changed</span>
            </label>
          </span>
          <button class="room-expand" type="button" data-toggle="${esc(room.id)}"
            aria-expanded="${open}" aria-label="${open ? "Hide" : "Show"} tasks for ${esc(room.name)}">
            ${ring(done, total)}
            <span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9.5 5.5L16 12l-6.5 6.5"/></svg></span>
          </button>
        </div>
        <p class="room-help" ${helping ? "" : "hidden"}>${esc(helping)}</p>
        <div class="room-body" ${open ? "" : "inert"}><div><div class="tasks-inner">
          ${rows || '<p class="empty">No tasks yet.</p>'}
          ${addRow}
          <div class="room-actions">
            <button class="text-btn ${editing ? "primary" : ""}" type="button" data-edit="${esc(room.id)}">
              ${editing ? "Done editing" : "Edit tasks"}
            </button>
            <button class="text-btn" type="button" data-add-new="${esc(room.id)}">+ Add task</button>
          </div>
        </div></div></div>
      </article>`;
  }).join("");

  paintAmbient();
  paintAllDone();
  restoreFocus();
}

/** Tint the page with whichever room is yours this week. */
function paintAmbient() {
  const who = assignmentsFor(state.week);
  const mine = state.me && state.rooms.find((r) => who[r.id] === state.me);
  document.documentElement.style.setProperty("--bg-tint", (mine && TINTS[mine.id]) || NEUTRAL_TINT);
}

function paintAllDone() {
  const every = state.rooms.length > 0 && state.rooms.every((r) => {
    const { done, total } = progress(r.id, state.week);
    return total > 0 && done === total;
  });
  $("#all-done").hidden = !every;
}

function restoreFocus() {
  let input = null;
  if (state.adding) input = document.querySelector(`[data-add="${CSS.escape(state.adding.roomId)}"]`);
  else if (state.editTask) input = document.querySelector(`[data-rename="${CSS.escape(state.editTask.id)}"]`);
  if (input && document.activeElement !== input) {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }
}

function renderHistory() {
  const rows = [];
  for (let i = 1; i <= 4; i++) {
    const week = addWeeks(state.week, -i);
    if (weekIndex(week) < 0) break;   // nothing before the rota started
    const base = defaultAssignments(week, state.rooms);
    const who = state.swaps[week] ? { ...base, ...state.swaps[week] } : base;

    let done = 0, total = 0;
    for (const room of state.rooms) {
      const p = progress(room.id, week);
      done += p.done; total += p.total;
    }
    const pct = total ? Math.round((done / total) * 100) : 0;
    const cls = { kitchen: "k", bathroom: "b", living: "l" };
    const summary = state.rooms.map((r) => `
      <span class="${cls[r.id] || ""}">${roomArt(r.id)}${esc(who[r.id] || "—")}</span>`).join("");

    rows.push(`
      <button class="hrow" type="button" data-goto="${week}">
        <span class="hrow-week">${fmtShort.format(parseISO(week))}</span>
        <span class="hrow-who">${summary}</span>
        <span class="hrow-pct ${pct === 100 ? "full" : ""}">${pct}%</span>
      </button>`);
  }
  $("#history").innerHTML = rows.join("");
  document.querySelector(".history").hidden = rows.length === 0;
}

function renderStatus() {
  const el = $("#sync-status");
  el.className = "sync " + state.mode;
  el.textContent = state.mode === "live"
    ? "Synced with the house"
    : "Saved on this device";
}

const fmtActivity = new Intl.DateTimeFormat("en-GB", {
  weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "Europe/London",
});
function activityPhrase(label) {
  if (!label) return "completed a task";
  return label.replace(/^(Wipe|Clean|Hoover|Mop)\b/, (verb) =>
    ({ Wipe: "wiped", Clean: "cleaned", Hoover: "hoovered", Mop: "mopped" })[verb])
    .replace(/^./, (first) => first.toLowerCase());
}

function renderActivity() {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const rooms = new Map(state.rooms.map((room) => [room.id, room]));
  const events = state.completions.filter((event) => event.week_start === state.week)
    .sort((a, b) => b.done_at.localeCompare(a.done_at));
  $("#activity").innerHTML = events.length ? events.map((event) => {
    const task = tasks.get(event.task_id);
    const room = rooms.get(task?.room_id);
    const name = PEOPLE.includes(event.by_name) ? event.by_name : "Someone";
    const points = pointsFor(event, task);
    const time = event.done_at ? fmtActivity.format(new Date(event.done_at)) : "";
    return `<li class="activity-row">
      <div class="activity-copy"><strong>${esc(name)}</strong> ${esc(activityPhrase(task?.label))}
        <span class="activity-detail">${esc(room?.name || "Room")} · ${esc(time)}</span></div>
      <b class="activity-points">+${points} pts</b>
      <button type="button" class="activity-undo" data-undo="${esc(event.id)}" aria-label="Undo ${esc(name)} doing ${esc(task?.label || "a task")}">Undo</button>
    </li>`;
  }).join("") : '<li class="activity-empty">No tasks logged this week yet.</li>';
}

function render() {
  renderHeader();
  renderPeople();
  renderStats();
  renderRooms();
  renderActivity();
  renderPlanner();
  renderHistory();
  renderStatus();
}

/* =========================================================================
   Celebration
   ========================================================================= */

const reduced = matchMedia("(prefers-reduced-motion: reduce)");

function buzz(ms) {
  if (navigator.vibrate && !reduced.matches) navigator.vibrate(ms);
}

function celebrate(card) {
  buzz([14, 40, 22]);
  if (reduced.matches) return;
  card.classList.remove("celebrate");
  void card.offsetWidth;
  card.classList.add("celebrate");

  const ringEl = card.querySelector(".ring");
  const box = ringEl.getBoundingClientRect();
  const styles = getComputedStyle(card);
  const colours = [
    styles.getPropertyValue("--accent").trim(),
    styles.getPropertyValue("--done").trim(),
    styles.getPropertyValue("--gold").trim(),
    styles.getPropertyValue("--you").trim(),
  ].filter(Boolean);

  confettiBurst(box.left + box.width / 2, box.top + box.height / 2, colours);
}

function confettiBurst(x, y, colours) {
  const layer = $("#confetti");
  for (let i = 0; i < 28; i++) {
    const bit = document.createElement("span");
    bit.className = "confetti-bit";
    bit.style.left = x + "px";
    bit.style.top = y + "px";
    bit.style.background = colours[i % colours.length];
    layer.appendChild(bit);

    const dx = (Math.random() - 0.5) * 320;
    const rise = 70 + Math.random() * 120;
    const fall = 260 + Math.random() * 220;
    const spin = (Math.random() - 0.5) * 900;

    bit.animate(
      [
        { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
        { transform: `translate(${dx * 0.45}px, ${-rise}px) rotate(${spin * 0.4}deg)`, opacity: 1, offset: 0.34 },
        { transform: `translate(${dx}px, ${fall}px) rotate(${spin}deg)`, opacity: 0 },
      ],
      { duration: 1000 + Math.random() * 600, easing: "cubic-bezier(.25,.6,.4,1)" },
    ).onfinish = () => bit.remove();
  }
}

/* =========================================================================
   Actions
   ========================================================================= */

let backend;

async function commit(fn) {
  try {
    await fn();
  } catch (err) {
    console.warn("Write failed, resyncing", err);
    try { await backend.refresh(); } catch { /* offline; keep what we have */ }
    render();
  }
}

function toggleTask(taskId) {
  if (!state.me) {
    $("#identity-hint").hidden = false;
    $("#people-picker").querySelector("button")?.focus();
    return;
  }
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const event = {
    id: crypto.randomUUID(), week_start: state.week, task_id: taskId,
    by_name: state.me, done_at: new Date().toISOString(), points_awarded: pointsOf(task),
  };
  state.completions.push(event);
  renderRooms();
  renderActivity();
  renderStats();
  renderHistory();
  buzz(9);
  commit(() => backend.addCompletion(event));
}

function undoCompletion(id) {
  const event = state.completions.find((item) => item.id === id);
  if (!event) return;
  state.completions = state.completions.filter((item) => item.id !== id);
  renderRooms();
  renderActivity();
  renderStats();
  renderHistory();
  commit(() => backend.removeCompletion(id));
}

function applySwap(roomId, person, week = state.week) {
  const who = assignmentsFor(week);
  if (who[roomId] === person) return;
  const displaced = who[roomId];
  const theirRoom = state.rooms.find((r) => who[r.id] === person);

  const next = { ...who, [roomId]: person };
  if (theirRoom) next[theirRoom.id] = displaced;

  const base = defaultAssignments(week, state.rooms);
  const changed = state.rooms.some((r) => next[r.id] !== base[r.id]);

  state.swaps[week] = next;
  if (!changed) delete state.swaps[week];
  render();

  commit(() => backend.setSwaps(week, changed ? next : null));
}

function resetSwap(week = state.week) {
  delete state.swaps[week];
  render();
  commit(() => backend.setSwaps(week, null));
}

function saveRename(id) {
  if (!state.editTask || state.editTask.id !== id) return;
  const label = state.editTask.value.trim();
  const task = state.tasks.find((t) => t.id === id);
  state.editTask = null;
  if (!task || !label || label === task.label) return;
  task.label = label;
  commit(() => backend.renameTask(id, label));
}

function saveTaskPoints(id, value) {
  const task = state.tasks.find((t) => t.id === id);
  const points = Number(value);
  if (!task || !Number.isInteger(points) || points < 10 || points > 100) {
    render();
    return;
  }
  if (points === pointsOf(task)) return;
  task.points = points;
  render();
  commit(() => backend.setTaskPoints(id, points));
}

function saveNewTask(roomId) {
  if (!state.adding || state.adding.roomId !== roomId) return;
  const label = state.adding.value.trim();
  if (!label) { state.adding = null; render(); return; }

  const siblings = tasksIn(roomId);
  const sortOrder = siblings.length ? Math.max(...siblings.map((t) => t.sort_order)) + 1 : 0;
  const temp = { id: "tmp-" + crypto.randomUUID(), room_id: roomId, label, points: 10, sort_order: sortOrder, archived: false };

  state.tasks.push(temp);
  state.adding = { roomId, value: "" };   // stay open for a quick second task
  render();

  commit(async () => {
    const row = await backend.addTask(roomId, label, sortOrder);
    if (row) Object.assign(temp, row);
    render();
  });
}

function deleteTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  if (!confirm("Delete “" + task.label + "” for everyone?")) return;
  state.tasks = state.tasks.filter((t) => t.id !== id);
  state.completions = state.completions.filter((event) => event.task_id !== id);
  render();
  commit(() => backend.deleteTask(id));
}

function goToWeek(iso) {
  state.week = iso;
  state.editing = null;
  state.editTask = null;
  state.adding = null;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* =========================================================================
   Wiring
   ========================================================================= */

function wire() {
  $("#prev-week").addEventListener("click", () => {
    if (weekIndex(state.week) > 0) goToWeek(addWeeks(state.week, -1));
  });
  $("#next-week").addEventListener("click", () => goToWeek(addWeeks(state.week, 1)));
  $("#today-btn").addEventListener("click", () => goToWeek(currentWeek()));
  $("#plan-prev").addEventListener("click", () => { state.planOffset = Math.max(0, state.planOffset - 4); renderPlanner(); });
  $("#plan-next").addEventListener("click", () => { state.planOffset += 4; renderPlanner(); });
  $("#plan-weeks").addEventListener("click", (e) => {
    const reset = e.target.closest("[data-plan-reset]");
    if (reset) { resetSwap(reset.dataset.planReset); return; }
  });
  document.addEventListener("change", (e) => {
    const picker = e.target.closest("[data-assign-room]");
    if (picker) applySwap(picker.dataset.assignRoom, picker.value, picker.dataset.assignWeek);
  });

  $("#people-picker").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-person]");
    if (!btn) return;
    const person = btn.dataset.person;
    state.me = state.me === person ? null : person;
    if (state.me) localStorage.setItem("rota.me", state.me);
    else localStorage.removeItem("rota.me");
    if (state.me) $("#identity-hint").hidden = true;
    for (const el of document.querySelectorAll("[data-person]")) {
      el.setAttribute("aria-pressed", String(el.dataset.person === state.me));
    }
    renderRooms();
    renderStats();
  });

  $("#rooms").addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      const id = toggle.dataset.toggle;
      const card = toggle.closest(".room");
      if (state.open.has(id)) {
        state.open.delete(id);
        if (state.editing === id) { state.editing = null; render(); return; }
      } else {
        state.open.add(id);
      }
      card.classList.toggle("open", state.open.has(id));
      card.querySelector(".room-body").inert = !state.open.has(id);
      toggle.setAttribute("aria-expanded", String(state.open.has(id)));
      toggle.setAttribute("aria-label", `${state.open.has(id) ? "Hide" : "Show"} tasks for ${card.querySelector(".room-name").firstChild.textContent.trim()}`);
      return;
    }

    const task = e.target.closest("[data-task]");
    if (task) { toggleTask(task.dataset.task); return; }

    const edit = e.target.closest("[data-edit]");
    if (edit) {
      const id = edit.dataset.edit;
      state.editing = state.editing === id ? null : id;
      state.editTask = null;
      state.adding = null;
      render();
      return;
    }

    const addNew = e.target.closest("[data-add-new]");
    if (addNew) {
      state.adding = { roomId: addNew.dataset.addNew, value: "" };
      render();
      return;
    }

    const addSave = e.target.closest("[data-add-save]");
    if (addSave) { saveNewTask(addSave.dataset.addSave); return; }

    const del = e.target.closest("[data-delete]");
    if (del) { deleteTask(del.dataset.delete); return; }
  });

  $("#rooms").addEventListener("input", (e) => {
    const rename = e.target.closest("[data-rename]");
    if (rename) { state.editTask = { id: rename.dataset.rename, value: rename.value }; return; }
    const add = e.target.closest("[data-add]");
    if (add) state.adding = { roomId: add.dataset.add, value: add.value };
  });

  $("#rooms").addEventListener("change", (e) => {
    const points = e.target.closest("[data-points]");
    if (points) saveTaskPoints(points.dataset.points, points.value);
  });

  $("#rooms").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const rename = e.target.closest("[data-rename]");
    if (rename) { e.preventDefault(); saveRename(rename.dataset.rename); return; }
    const add = e.target.closest("[data-add]");
    if (add) { e.preventDefault(); saveNewTask(add.dataset.add); }
  });

  $("#rooms").addEventListener("focusout", (e) => {
    const rename = e.target.closest("[data-rename]");
    if (rename) setTimeout(() => saveRename(rename.dataset.rename), 60);
  }, true);

  $("#history").addEventListener("click", (e) => {
    const row = e.target.closest("[data-goto]");
    if (row) goToWeek(row.dataset.goto);
  });

  $("#activity").addEventListener("click", (e) => {
    const undo = e.target.closest("[data-undo]");
    if (undo) undoCompletion(undo.dataset.undo);
  });

  const topbar = document.querySelector(".topbar");
  addEventListener("scroll", () => topbar.classList.toggle("scrolled", scrollY > 4), { passive: true });
}

/* =========================================================================
   Boot
   ========================================================================= */

async function boot() {
  wire();

  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      backend = await supabaseBackend(() => render());
    } catch (err) {
      console.warn("Supabase unreachable — falling back to this device only.", err);
    }
  }
  if (!backend) backend = localBackend(() => render());

  state.mode = backend.mode;
  render();
}

boot();
