-- Survivor Board shared state.
--
-- One row per league holds that pool's entire entry as JSON. Two people, one
-- row per pool, realtime push keeps both devices in sync. Run this once in the
-- Supabase SQL editor.
--
-- Row ids come from scopeFor() in src/js/config.js: the college pool predates
-- the NFL one and keeps the plain 'shared' id, every other league is
-- 'shared-<league>'. Adding a pool means adding its id here, in the seed and
-- in each policy, or the app will read an empty entry and its saves will be
-- refused by RLS.

create table if not exists public.entries (
  id          text primary key,
  entry       jsonb not null default '{"picks":{},"swaps":{}}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Seed one row per league.
insert into public.entries (id) values ('shared'), ('shared-nfl')
on conflict (id) do nothing;

-- Realtime so an edit on one phone lands on the other.
alter publication supabase_realtime add table public.entries;

alter table public.entries enable row level security;

-- The anon key is public by necessity in a static site, so these policies are
-- what actually protect the rows. They allow read and write to the two league
-- rows and nothing else: no listing other rows, no inserting new ids. Insert
-- is allowed only for those same ids because the app saves with upsert, which
-- needs the insert path even when the row already exists.
--
-- Tighten it further by turning on Supabase Auth and adding
-- `and auth.uid() in (...)` once both people have accounts. Keeping the site
-- itself private is a hosting question, not a table one: see docs/DEPLOY.md.

drop policy if exists "read shared entry" on public.entries;
create policy "read shared entry"
  on public.entries for select
  using (id in ('shared', 'shared-nfl'));

drop policy if exists "insert shared entry" on public.entries;
create policy "insert shared entry"
  on public.entries for insert
  with check (id in ('shared', 'shared-nfl'));

drop policy if exists "update shared entry" on public.entries;
create policy "update shared entry"
  on public.entries for update
  using (id in ('shared', 'shared-nfl'))
  with check (id in ('shared', 'shared-nfl'));
