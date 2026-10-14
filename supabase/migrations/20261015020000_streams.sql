-- Resi web players: one or more per campus. The app reads each player's
-- public status straight from Resi, so only the embed id lives here.

create table public.streams (
  id          uuid primary key default gen_random_uuid(),
  campus_id   uuid not null references public.campuses (id) on delete cascade,
  name        text not null default 'Online' check (length(trim(name)) between 1 and 80),
  provider    text not null default 'resi' check (provider in ('resi')),
  embed_id    uuid not null,                       -- data-embed-id / ?id= from the Resi embed code
  embed_type  text not null default 'webchannel'
              check (embed_type in ('webchannel', 'event', 'schedule', 'library', 'playlist')),
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null,
  unique (campus_id, embed_id)
);

create index streams_campus_idx on public.streams (campus_id, sort_order);

create trigger streams_stamp before insert or update on public.streams
  for each row execute function public.stamp();

alter table public.streams enable row level security;

-- Anyone approved can watch; staff set the players up.
create policy "approved users read streams" on public.streams
  for select to authenticated using ((select public.has_role('volunteer')));
create policy "staff add streams" on public.streams
  for insert to authenticated with check ((select public.has_role('staff')));
create policy "staff edit streams" on public.streams
  for update to authenticated
  using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));
create policy "staff remove streams" on public.streams
  for delete to authenticated using ((select public.has_role('staff')));

grant select, insert, update, delete on public.streams to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.streams;
  end if;
end
$$;
