import { SUPABASE_URL, SUPABASE_ANON_KEY, PEOPLE, START_MONDAY } from "./config.js";
import { pointsOf, personTotals, leader, streak } from "./scoring.js";

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
  ["kitchen", "Wipe countertops", 2], ["kitchen", "Clean the hob", 3],
  ["kitchen", "Clean the sink", 2], ["kitchen", "Hoover the floor", 3],
  ["kitchen", "Mop the floor", 4],
  ["bathroom", "Clean the toilet", 3], ["bathroom", "Clean the sink", 2],
  ["bathroom", "Clean the bath", 4], ["bathroom", "Hoover the floor", 2],
  ["bathroom", "Mop the floor", 3],
  ["living", "Hoover the floor", 3], ["living", "Clean the coffee table", 2],
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
  ticks: {},            // "week|taskId" -> { by_name, done_at }
  swaps: {},            // "YYYY-MM-DD" -> { roomId: person }
  week: currentWeek(),
  me: localStorage.getItem("rota.me"),
  open: new Set(),      // expanded room ids
  editing: null,        // room id in edit mode
  editTask: null,       // { id, value } mid-rename
  adding: null,         // { roomId, value } mid-add
  mode: "…",            // "live" | "solo"
};

const tickKey = (week, taskId) => week + "|" + taskId;
const tasksIn = (roomId) => state.tasks.filter((t) => t.room_id === roomId && !t.archived);

function progress(roomId, week) {
  const list = tasksIn(roomId);
  const done = list.filter((t) => state.ticks[tickKey(week, t.id)]).length;
  return { done, total: list.length };
}

// What scoring.js needs to do its sums.
const ctx = {
  get rooms() { return state.rooms; },
  get tasks() { return state.tasks; },
  get ticks() { return state.ticks; },
  people: PEOPLE,
  tasksIn, tickKey, assignmentsFor, addWeeks, weekIndex,
};

/* =========================================================================
   Backends. Supabase when configured, otherwise this device only — so the
   page is never broken, just quieter.
   ========================================================================= */

function applyRows({ rooms, tasks, ticks, swaps }) {
  state.rooms = rooms.slice().sort((a, b) => a.sort_order - b.sort_order);
  state.tasks = tasks.slice().sort((a, b) => a.sort_order - b.sort_order);
  state.ticks = {};
  for (const t of ticks) state.ticks[tickKey(t.week_start, t.task_id)] = t;
  state.swaps = {};
  for (const s of swaps) state.swaps[s.week_start] = s.assignments;
}

async function supabaseBackend(onChange) {
  const { createClient } = await import(
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/+esm"
  );
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  async function fetchAll() {
    const [rooms, tasks, ticks, swaps] = await Promise.all([
      sb.from("rooms").select("*"),
      sb.from("tasks").select("*"),
      sb.from("ticks").select("*"),
      sb.from("swaps").select("*"),
    ]);
    for (const r of [rooms, tasks, ticks, swaps]) if (r.error) throw r.error;
    applyRows({
      rooms: rooms.data, tasks: tasks.data, ticks: ticks.data, swaps: swaps.data,
    });
  }

  await fetchAll();

  let pending;
  const refresh = () => {
    clearTimeout(pending);
    pending = setTimeout(() => fetchAll().then(onChange).catch(console.warn), 120);
  };

  const channel = sb.channel("rota");
  for (const table of ["rooms", "tasks", "ticks", "swaps"]) {
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
    async setTick(week, taskId, done, by) {
      if (done) {
        const { error } = await sb.from("ticks").upsert(
          { week_start: week, task_id: taskId, done: true, by_name: by, done_at: new Date().toISOString() },
          { onConflict: "week_start,task_id" },
        );
        if (error) throw error;
      } else {
        const { error } = await sb.from("ticks").delete()
          .eq("week_start", week).eq("task_id", taskId);
        if (error) throw error;
      }
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
      if (raw && raw.rooms) return raw;
    } catch { /* fall through to a fresh seed */ }
    return {
      rooms: DEFAULT_ROOMS,
      tasks: DEFAULT_TASKS.map(([room_id, label, points], i) => ({
        id: "seed-" + i, room_id, label, points, sort_order: i, archived: false,
      })),
      ticks: [], swaps: [],
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
    async setTick(week, taskId, done, by) {
      const data = read();   // the saved file is the truth; optimistic edits live only in state
      data.ticks = data.ticks.filter((t) => !(t.week_start === week && t.task_id === taskId));
      if (done) data.ticks.push({ week_start: week, task_id: taskId, done: true, by_name: by, done_at: new Date().toISOString() });
      write(data);
    },
    async addTask(roomId, label, sortOrder) {
      const row = { id: crypto.randomUUID(), room_id: roomId, label, points: 2, sort_order: sortOrder, archived: false };
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
    async deleteTask(id) {
      const data = read();
      data.tasks = data.tasks.filter((t) => t.id !== id);
      data.ticks = data.ticks.filter((t) => t.task_id !== id);
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

const RING_R = 18;
const RING_C = 2 * Math.PI * RING_R;

function roomIcon(roomId) {
  return document.getElementById("room-" + roomId) ? "room-" + roomId : "room-living";
}
function ringDash(done, total) {
  const frac = total ? done / total : 0;
  return `${(frac * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`;
}
function ring(done, total) {
  const frac = total ? done / total : 0;
  return `
    <div class="ring">
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <circle class="ring-track" cx="22" cy="22" r="${RING_R}" fill="none" stroke-width="3.5"/>
        <circle class="ring-fill" cx="22" cy="22" r="${RING_R}" fill="none" stroke-width="3.5"
                stroke-linecap="${frac ? "round" : "butt"}" stroke-dasharray="${ringDash(done, total)}"/>
      </svg>
      <span class="ring-text">${done}/${total}</span>
    </div>`;
}

function tickMeta(tick) {
  if (!tick) return "";
  const who = tick.by_name || "someone";
  const when = tick.done_at ? fmtDay.format(new Date(tick.done_at)) : "";
  return esc(who) + (when ? " · " + when : "");
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
            <button class="icon-btn danger" type="button" data-delete="${esc(task.id)}"
                    aria-label="Delete ${esc(task.label)}">✕</button>
          </div>`;
      }
      const tick = state.ticks[tickKey(state.week, task.id)];
      return `
        <button class="task ${tick ? "done" : ""}" type="button" data-task="${esc(task.id)}">
          <span class="box" aria-hidden="true"><svg><use href="#tick"/></svg></span>
          <span class="task-text">
            <span class="task-label">${esc(task.label)}</span>
            <span class="task-meta">${tickMeta(tick)}</span>
          </span>
          <span class="task-pts">${pointsOf(task)}</span>
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
        <button class="room-head" type="button" data-toggle="${esc(room.id)}" aria-expanded="${open}">
          <span class="tile" aria-hidden="true"><svg><use href="#${roomIcon(room.id)}"/></svg></span>
          <span class="room-meta">
            <span class="room-name">
              ${esc(room.name)}
              <span class="badge done" ${complete ? "" : "hidden"}>Done</span>
            </span>
            <span class="room-who">
              <span class="who-name" data-swap="${esc(room.id)}" role="button" tabindex="0">${esc(who[room.id] || "—")}</span>
              <span class="badge you" ${mine ? "" : "hidden"}>You</span>
              <span class="badge swapped" ${swapped ? "" : "hidden"}>Swapped</span>
            </span>
          </span>
          ${ring(done, total)}
          <span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9.5 5.5L16 12l-6.5 6.5"/></svg></span>
        </button>
        <div class="room-body"><div><div class="tasks-inner">
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
      <span class="${cls[r.id] || ""}"><svg><use href="#${roomIcon(r.id)}"/></svg>${esc(who[r.id] || "—")}</span>`).join("");

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
    ? "Synced with the flat"
    : "This device only — see README to turn on syncing";
}

function render() {
  renderHeader();
  renderPeople();
  renderStats();
  renderRooms();
  renderHistory();
  renderStatus();
}

/* =========================================================================
   Targeted repaints — ticking should animate, not rebuild the page
   ========================================================================= */

function paintTick(taskId, tick, justDone) {
  const row = document.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
  if (!row) return;
  row.classList.toggle("done", Boolean(tick));
  const meta = row.querySelector(".task-meta");
  if (meta) meta.textContent = tickMeta(tick);
  if (justDone) {
    row.classList.add("just-done");
    setTimeout(() => row.classList.remove("just-done"), 520);
  }
}

function paintRoom(roomId) {
  const card = document.querySelector(`.room[data-room="${CSS.escape(roomId)}"]`);
  if (!card) return;
  const { done, total } = progress(roomId, state.week);
  const complete = total > 0 && done === total;
  const wasComplete = card.classList.contains("complete");

  const fill = card.querySelector(".ring-fill");
  fill.setAttribute("stroke-dasharray", ringDash(done, total));
  fill.setAttribute("stroke-linecap", done ? "round" : "butt");

  const text = card.querySelector(".ring-text");
  text.textContent = `${done}/${total}`;
  text.classList.remove("bump");
  void text.offsetWidth;          // restart the animation
  text.classList.add("bump");

  card.classList.toggle("complete", complete);
  card.querySelector(".badge.done").hidden = !complete;

  if (complete && !wasComplete) celebrate(card);
  paintAllDone();
  renderStats();
}

function paintMine() {
  const who = assignmentsFor(state.week);
  for (const card of document.querySelectorAll(".room")) {
    const mine = Boolean(state.me) && who[card.dataset.room] === state.me;
    card.classList.toggle("mine", mine);
    card.querySelector(".badge.you").hidden = !mine;
  }
  paintAmbient();
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
  const key = tickKey(state.week, taskId);
  const wasDone = Boolean(state.ticks[key]);
  const by = state.me || "Someone";

  // Optimistic: the tick lands the instant a thumb hits it.
  if (wasDone) delete state.ticks[key];
  else state.ticks[key] = { task_id: taskId, by_name: by, done_at: new Date().toISOString() };

  const task = state.tasks.find((t) => t.id === taskId);
  paintTick(taskId, state.ticks[key], !wasDone);
  if (task) paintRoom(task.room_id);
  if (!wasDone) buzz(9);

  commit(() => backend.setTick(state.week, taskId, !wasDone, by));
}

function openSwapSheet(roomId) {
  const who = assignmentsFor(state.week);
  const room = state.rooms.find((r) => r.id === roomId);
  const current = who[roomId];
  const others = PEOPLE.filter((p) => p !== current);

  $("#sheet-title").textContent = "Who's doing the " + room.name.toLowerCase() + "?";
  $("#sheet-body").innerHTML =
    `<p class="sheet-hint">Swaps this week only — the rota carries on as normal afterwards.</p>` +
    others.map((person) => {
      const theirRoom = state.rooms.find((r) => who[r.id] === person);
      const swapBack = theirRoom
        ? ", " + esc(current === state.me ? "you take" : current + " takes") + " the " + esc(theirRoom.name.toLowerCase())
        : "";
      return `
        <button class="swap-opt" type="button" data-swap-to="${esc(person)}">
          <strong>${esc(person)}</strong>
          <span>takes the ${esc(room.name.toLowerCase())}${swapBack}</span>
        </button>`;
    }).join("") +
    (isSwapped(state.week) ? `<button class="swap-opt" type="button" data-swap-reset="1"><strong>Reset this week</strong><span>back to the normal rotation</span></button>` : "");

  $("#sheet").dataset.room = roomId;
  $("#sheet").hidden = false;
  $("#sheet-backdrop").hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheet-backdrop").hidden = true;
  document.body.style.overflow = "";
}

function applySwap(roomId, person) {
  const who = assignmentsFor(state.week);
  const displaced = who[roomId];
  const theirRoom = state.rooms.find((r) => who[r.id] === person);

  const next = { ...who, [roomId]: person };
  if (theirRoom) next[theirRoom.id] = displaced;

  const base = defaultAssignments(state.week, state.rooms);
  const changed = state.rooms.some((r) => next[r.id] !== base[r.id]);

  state.swaps[state.week] = next;
  if (!changed) delete state.swaps[state.week];
  closeSheet();
  render();

  commit(() => backend.setSwaps(state.week, changed ? next : null));
}

function resetSwap() {
  delete state.swaps[state.week];
  closeSheet();
  render();
  commit(() => backend.setSwaps(state.week, null));
}

function saveRename(id) {
  if (!state.editTask || state.editTask.id !== id) return;
  const label = state.editTask.value.trim();
  const task = state.tasks.find((t) => t.id === id);
  state.editTask = null;
  if (!task || !label || label === task.label) { render(); return; }
  task.label = label;
  render();
  commit(() => backend.renameTask(id, label));
}

function saveNewTask(roomId) {
  if (!state.adding || state.adding.roomId !== roomId) return;
  const label = state.adding.value.trim();
  if (!label) { state.adding = null; render(); return; }

  const siblings = tasksIn(roomId);
  const sortOrder = siblings.length ? Math.max(...siblings.map((t) => t.sort_order)) + 1 : 0;
  const temp = { id: "tmp-" + crypto.randomUUID(), room_id: roomId, label, points: 2, sort_order: sortOrder, archived: false };

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
  for (const key of Object.keys(state.ticks)) {
    if (key.endsWith("|" + id)) delete state.ticks[key];
  }
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
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-backdrop").addEventListener("click", closeSheet);

  $("#people-picker").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-person]");
    if (!btn) return;
    const person = btn.dataset.person;
    state.me = state.me === person ? null : person;
    if (state.me) localStorage.setItem("rota.me", state.me);
    else localStorage.removeItem("rota.me");
    for (const el of document.querySelectorAll("[data-person]")) {
      el.setAttribute("aria-pressed", String(el.dataset.person === state.me));
    }
    paintMine();
    renderStats();
  });

  $("#rooms").addEventListener("click", (e) => {
    const swap = e.target.closest("[data-swap]");
    if (swap) { e.stopPropagation(); openSwapSheet(swap.dataset.swap); return; }

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
      toggle.setAttribute("aria-expanded", String(state.open.has(id)));
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

  $("#sheet").addEventListener("click", (e) => {
    const to = e.target.closest("[data-swap-to]");
    if (to) { applySwap($("#sheet").dataset.room, to.dataset.swapTo); return; }
    if (e.target.closest("[data-swap-reset]")) resetSwap();
  });

  $("#history").addEventListener("click", (e) => {
    const row = e.target.closest("[data-goto]");
    if (row) goToWeek(row.dataset.goto);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSheet();
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
