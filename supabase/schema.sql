-- ===========================================================================
-- Flat Cleaning Rota — database setup.
-- Paste the whole file into the Supabase SQL editor and hit Run. Once.
-- Safe to run again: it never wipes existing data.
-- ===========================================================================

create table if not exists rooms (
  id          text primary key,
  name        text not null,
  emoji       text not null default '',
  sort_order  int  not null default 0
);

create table if not exists tasks (
  id          uuid primary key default gen_random_uuid(),
  room_id     text not null references rooms(id) on delete cascade,
  label       text not null,
  sort_order  int  not null default 0,
  points      int  not null default 10,  -- effort weighting, used for scores
  archived    boolean not null default false
);

-- for databases created before points existed
alter table tasks add column if not exists points int not null default 10;
alter table tasks alter column points set default 10;

-- Scale the original 2/3/4-point tasks once; already scaled values stay put.
update tasks set points = greatest(10, points * 5) where points < 10;

create table if not exists ticks (
  week_start  date not null,
  task_id     uuid not null references tasks(id) on delete cascade,
  done        boolean not null default true,
  by_name     text,
  done_at     timestamptz not null default now(),
  primary key (week_start, task_id)
);

create table if not exists completions (
  id             uuid primary key default gen_random_uuid(),
  week_start     date not null,
  task_id        uuid not null references tasks(id) on delete cascade,
  by_name        text,
  done_at        timestamptz not null default now(),
  points_awarded int not null default 10
);

-- Bring existing weekly ticks into the new activity history exactly once.
insert into completions (id, week_start, task_id, by_name, done_at, points_awarded)
select md5('old-tick:' || t.week_start::text || ':' || t.task_id::text)::uuid,
       t.week_start, t.task_id, t.by_name, t.done_at, tasks.points
from ticks t join tasks on tasks.id = t.task_id
where t.done = true
on conflict (id) do nothing;

create table if not exists swaps (
  week_start   date primary key,
  assignments  jsonb not null default '{}'::jsonb
);

create index if not exists ticks_week_idx on ticks (week_start);
create index if not exists completions_week_idx on completions (week_start, done_at desc);
create index if not exists tasks_room_idx on tasks (room_id);

-- ---------------------------------------------------------------------------
-- Access. No logins: the housemates open a link, so the anonymous role needs
-- read and write on these four tables. Nothing else in the project is exposed.
-- ---------------------------------------------------------------------------

alter table rooms enable row level security;
alter table tasks enable row level security;
alter table ticks enable row level security;
alter table completions enable row level security;
alter table swaps enable row level security;

do $$
declare t text;
begin
  foreach t in array array['rooms','tasks','ticks','completions','swaps'] loop
    execute format('drop policy if exists housemates_all on %I', t);
    execute format(
      'create policy housemates_all on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime, so a tick on one phone shows up on the other two.
-- replica identity full makes deletes carry their old row to the clients.
-- ---------------------------------------------------------------------------

alter table rooms replica identity full;
alter table tasks replica identity full;
alter table ticks replica identity full;
alter table completions replica identity full;
alter table swaps replica identity full;

do $$
declare t text;
begin
  foreach t in array array['rooms','tasks','ticks','completions','swaps'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The rooms and their starting tasks. Everything below is editable in the app.
-- ---------------------------------------------------------------------------

insert into rooms (id, name, emoji, sort_order) values
  ('kitchen',  'Kitchen',     '🍳', 0),
  ('bathroom', 'Bathroom',    '🛁', 1),
  ('living',   'Living room', '🛋️', 2)
on conflict (id) do nothing;

-- points are weighted by effort, so the light room can't out-earn the heavy one
insert into tasks (room_id, label, sort_order, points)
select v.room_id, v.label, v.sort_order, v.points
from (values
  ('kitchen',  'Wipe countertops',       0, 10),
  ('kitchen',  'Clean the hob',          1, 15),
  ('kitchen',  'Clean the sink',         2, 10),
  ('kitchen',  'Hoover the floor',       3, 15),
  ('kitchen',  'Mop the floor',          4, 20),
  ('bathroom', 'Clean the toilet',       0, 15),
  ('bathroom', 'Clean the sink',         1, 10),
  ('bathroom', 'Clean the bath',         2, 20),
  ('bathroom', 'Hoover the floor',       3, 10),
  ('bathroom', 'Mop the floor',          4, 15),
  ('living',   'Hoover the floor',       0, 15),
  ('living',   'Clean the coffee table', 1, 10)
) as v(room_id, label, sort_order, points)
where not exists (select 1 from tasks);
