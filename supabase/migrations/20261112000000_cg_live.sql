-- CG Live: what each campus's ProPresenter has on screen right now, reported by a small
-- listener on the CG computer (tools/cg-live). One row per campus, overwritten on change.
-- cg_agents: one per listener, with the key it sends (admins only; the cg-live function
-- reads it with the service role).
create table if not exists public.cg_agents (
  id          uuid primary key default gen_random_uuid(),
  campus_id   uuid not null references public.campuses (id) on delete cascade,
  name        text not null default 'CG',
  key         text not null unique,
  last_seen   timestamptz,
  created_at  timestamptz not null default now()
);
create table if not exists public.cg_live (
  campus_id         uuid primary key references public.campuses (id) on delete cascade,
  presentation      text,
  presentation_uuid text,
  slide_index       int,
  slide_count       int,
  slide_text        text,
  next_text         text,
  media_name        text,
  media_playing     boolean,
  cleared           boolean,
  raw               jsonb,
  seen_at           timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.cg_agents enable row level security;
alter table public.cg_live enable row level security;
create policy "staff see cg_live" on public.cg_live for select using ((select public.has_role('staff')));
create policy "admin see cg_agents" on public.cg_agents for select using ((select public.has_role('admin')));
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.cg_live;
  end if;
end $$;
-- The pilot: Mauldin's CG.
insert into public.cg_agents (campus_id, name, key)
select id, 'Mauldin CG', encode(gen_random_bytes(18), 'hex') from public.campuses where code = 'MAU'
on conflict do nothing;
