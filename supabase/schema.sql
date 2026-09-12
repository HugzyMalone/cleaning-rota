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
  archived    boolean not null default false
);

create table if not exists ticks (
  week_start  date not null,
  task_id     uuid not null references tasks(id) on delete cascade,
  done        boolean not null default true,
  by_name     text,
  done_at     timestamptz not null default now(),
  primary key (week_start, task_id)
);

create table if not exists swaps (
  week_start   date primary key,
  assignments  jsonb not null default '{}'::jsonb
);

create index if not exists ticks_week_idx on ticks (week_start);
create index if not exists tasks_room_idx on tasks (room_id);

-- ---------------------------------------------------------------------------
-- Access. No logins: the housemates open a link, so the anonymous role needs
-- read and write on these four tables. Nothing else in the project is exposed.
-- ---------------------------------------------------------------------------

alter table rooms enable row level security;
alter table tasks enable row level security;
alter table ticks enable row level security;
alter table swaps enable row level security;

do $$
declare t text;
begin
  foreach t in array array['rooms','tasks','ticks','swaps'] loop
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
alter table swaps replica identity full;

do $$
declare t text;
begin
  foreach t in array array['rooms','tasks','ticks','swaps'] loop
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

insert into tasks (room_id, label, sort_order)
select v.room_id, v.label, v.sort_order
from (values
  ('kitchen',  'Wipe countertops',       0),
  ('kitchen',  'Clean the hob',          1),
  ('kitchen',  'Clean the sink',         2),
  ('kitchen',  'Hoover the floor',       3),
  ('kitchen',  'Mop the floor',          4),
  ('bathroom', 'Clean the toilet',       0),
  ('bathroom', 'Clean the sink',         1),
  ('bathroom', 'Clean the bath',         2),
  ('bathroom', 'Hoover the floor',       3),
  ('bathroom', 'Mop the floor',          4),
  ('living',   'Hoover the floor',       0),
  ('living',   'Clean the coffee table', 1)
) as v(room_id, label, sort_order)
where not exists (select 1 from tasks);
