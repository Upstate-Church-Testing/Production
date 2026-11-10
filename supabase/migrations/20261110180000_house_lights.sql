-- Lighting › House lights: the house light level (percent) for each part of a service, per
-- room and service: Vintage, Modern (Sundays) or Midweek (Wednesdays). Which rooms are on the
-- sheet: rooms.house_lights (for now the Worship Centers where Sunday services happen, not
-- Laurens or Union). Removing a level deletes its row. Staff read and change it; stamped with
-- who changed it and when, and pushed live to open screens.
alter table public.rooms add column if not exists house_lights boolean not null default false;
update public.rooms r set house_lights = true
  from public.campuses c
 where c.id = r.campus_id and r.name ~* '^worship center$' and c.code not in ('LAU', 'UN');

create table if not exists public.house_light_levels (
  room_id uuid not null references public.rooms(id) on delete cascade,
  service text not null check (service in ('vintage', 'modern', 'midweek')),
  segment text not null check (segment in ('pre', 'worship', 'host', 'video', 'message')),
  level smallint not null check (level between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_by_name text,
  updated_by_name text,
  primary key (room_id, service, segment)
);
alter table public.house_light_levels enable row level security;
create policy "staff see house lights" on public.house_light_levels for select to authenticated using (public.has_role('staff'));
create policy "staff add house lights" on public.house_light_levels for insert to authenticated with check (public.has_role('staff'));
create policy "staff change house lights" on public.house_light_levels for update to authenticated using (public.has_role('staff')) with check (public.has_role('staff'));
create policy "staff remove house lights" on public.house_light_levels for delete to authenticated using (public.has_role('staff'));
create trigger house_light_levels_stamp before insert or update on public.house_light_levels for each row execute function public.stamp();
alter publication supabase_realtime add table public.house_light_levels;
