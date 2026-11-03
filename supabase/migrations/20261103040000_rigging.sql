-- =============================================================================
-- Rigging: the hanging positions in a room (battens) and which lights are on them.
--
--   rig_positions        a position in one room at one location: FOH Batten,
--                        Midstage Batten Left… in the order they hang, front to back
--   devices.position_id  the position an item is mounted on (same room only).
--                        Moving the item to another room takes it off.
-- Lighting › Rigging shows one room at a time: each position with what's on it,
-- and what in the room isn't on a position yet.
-- =============================================================================

select set_config('app.actor', 'Claude', true);

create table public.rig_positions (
  id          uuid primary key default gen_random_uuid(),
  campus_id   uuid not null references public.campuses(id) on delete cascade,
  room_id     uuid not null references public.rooms(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 60),
  sort_order  int not null default 0,
  notes       text check (notes is null or length(notes) <= 2000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id) on delete set null,
  updated_by  uuid references public.profiles(id) on delete set null,
  unique (room_id, name)
);
create index rig_positions_room_idx on public.rig_positions (room_id, sort_order);

alter table public.rig_positions enable row level security;
create policy "approved users read rig positions" on public.rig_positions
  for select to authenticated using ((select public.has_role('volunteer')));
create policy "staff manage rig positions" on public.rig_positions
  for all to authenticated using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));

create trigger rig_positions_stamp before insert or update on public.rig_positions
  for each row execute function public.stamp();

-- A position's room has to be at its location.
create or replace function public.rig_positions_check()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not exists (select 1 from public.rooms r where r.id = new.room_id and r.campus_id = new.campus_id) then
    raise exception 'That room is at a different location.' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger rig_positions_check before insert or update of room_id, campus_id on public.rig_positions
  for each row execute function public.rig_positions_check();

alter publication supabase_realtime add table public.rig_positions;

-- Items: the position they hang on.
alter table public.devices add column position_id uuid references public.rig_positions(id) on delete set null;
create index devices_position_idx on public.devices (position_id) where position_id is not null;

create or replace function public.devices_position_check()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  -- Moving to another room takes it off its position (unless a new one came with the move).
  if tg_op = 'UPDATE' and (new.campus_id is distinct from old.campus_id or new.room_id is distinct from old.room_id)
     and new.position_id is not distinct from old.position_id then
    new.position_id := null;
  end if;
  if new.position_id is not null
     and not exists (select 1 from public.rig_positions p where p.id = new.position_id and p.room_id is not distinct from new.room_id) then
    raise exception 'That position is in a different room.' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger devices_position_check before insert or update of position_id, room_id, campus_id on public.devices
  for each row execute function public.devices_position_check();

-- The item editor's save: projection and position ride along after the main save.
create or replace function public.save_device_full(payload jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  dev_id uuid;
  d      jsonb := payload -> 'device';
  p      text := nullif(d ->> 'projection', '');
  pos    uuid := nullif(d ->> 'position_id', '')::uuid;
begin
  perform set_config('app.device_numbers', coalesce(payload -> 'numbers', '{}'::jsonb)::text, true);
  dev_id := public.save_device(payload);
  perform set_config('app.device_numbers', '', true);
  if d ? 'projection' then
    update public.devices set projection = p where id = dev_id and projection is distinct from p;
  end if;
  if d ? 'position_id' then
    update public.devices set position_id = pos where id = dev_id and position_id is distinct from pos;
  end if;
  return dev_id;
end
$$;

-- Harrison Bridge Worship Center: one FOH batten, five midstage (three center,
-- left, right) and three upstage (center, left, right).
insert into public.rig_positions (campus_id, room_id, name, sort_order)
select r.campus_id, r.id, v.name, v.n
  from public.rooms r join public.campuses c on c.id = r.campus_id,
       (values ('FOH Batten', 0), ('Midstage Batten Center 1', 1), ('Midstage Batten Center 2', 2), ('Midstage Batten Center 3', 3),
               ('Midstage Batten Left', 4), ('Midstage Batten Right', 5),
               ('Upstage Batten Center', 6), ('Upstage Batten Left', 7), ('Upstage Batten Right', 8)) v(name, n)
 where c.short_name = 'Harrison Bridge' and r.name = 'Worship Center';

-- All nine ColorSource Spots there hang on the FOH batten.
update public.devices d set position_id = p.id
  from public.rig_positions p, public.device_types t
 where p.room_id = d.room_id and p.name = 'FOH Batten'
   and t.id = d.type_id and t.manufacturer = 'ETC' and t.name = 'ColorSource Spot'
   and d.campus_id = (select id from public.campuses where short_name = 'Harrison Bridge');
