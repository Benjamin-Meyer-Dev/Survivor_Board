-- Survivor Board shared state.
--
-- One row per league holds that pool's entire entry as JSON. Two people, one
-- row per pool, realtime push keeps both devices in sync. Run this once in the
-- Supabase SQL editor. It is safe to run again: every statement checks before
-- it acts.
--
-- Row ids are the league ids from src/js/leagues.js, which are also the folder
-- names under data/. Adding a pool means adding its id to the seed and to each
-- policy below, or the app will read an empty entry and its saves will be
-- refused by RLS.

create table if not exists public.entries (
  id          text primary key,
  entry       jsonb not null default '{"picks":{},"swaps":{}}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Seed one row per league.
insert into public.entries (id) values ('cfb'), ('nfl')
on conflict (id) do nothing;

-- Realtime so an edit on one phone lands on the other. Guarded, because adding
-- a table that is already in the publication is an error, and one error aborts
-- the whole script on a re-run.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'entries'
  ) then
    alter publication supabase_realtime add table public.entries;
  end if;
end $$;

alter table public.entries enable row level security;

-- Table privileges. RLS decides which rows a role may touch, but only once the
-- role is allowed at the table at all, and that is a separate grant. Supabase
-- used to hand these out by default to every table in public; a project where
-- it did not, or where they were revoked, fails every request with
-- "permission denied for table entries" (SQLSTATE 42501). The app's reads
-- swallow that and show an empty board, and its saves surface it as
-- "Could not sync this change". The publishable key acts as `anon`;
-- `authenticated` is for the day Supabase Auth is turned on. No delete: the
-- app never removes a row, so nothing holding the public key can either.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update on public.entries to anon, authenticated;
grant all on public.entries to service_role;

-- The anon key is public by necessity in a static site, so these policies are
-- what actually protect the rows. They allow read and write to the two league
-- rows and nothing else: no listing other rows, no inserting new ids. Insert
-- is allowed only for those same ids because the app saves with upsert, which
-- needs the insert path even when the row already exists.
--
-- Tighten it further by turning on Supabase Auth and adding
-- `and auth.uid() in (...)` once both people have accounts. Keeping the site
-- itself private is a hosting question, not a table one: see docs/DEPLOY.md.

-- Policy names from earlier versions of this file, so a re-run replaces them.
drop policy if exists "read shared entry" on public.entries;
drop policy if exists "insert shared entry" on public.entries;
drop policy if exists "update shared entry" on public.entries;

drop policy if exists "read league entries" on public.entries;
create policy "read league entries"
  on public.entries for select
  using (id in ('cfb', 'nfl'));

drop policy if exists "insert league entries" on public.entries;
create policy "insert league entries"
  on public.entries for insert
  with check (id in ('cfb', 'nfl'));

drop policy if exists "update league entries" on public.entries;
create policy "update league entries"
  on public.entries for update
  using (id in ('cfb', 'nfl'))
  with check (id in ('cfb', 'nfl'));

-- Rows seeded by an earlier version of this file. The app no longer reads them
-- and nothing was ever saved to them, so a re-run clears them out.
delete from public.entries where id in ('shared', 'shared-nfl');
