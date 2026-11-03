-- =============================================================================
-- Room groups: a room can sit inside another room at the same location, like
-- the offices and Production Storage inside "E-Wing Offices" at Simpsonville.
-- Most rooms have no group. In the Room filter a group is one entry that opens
-- to its rooms; picking the group shows everything in it.
--
--   rooms.group_id   the room this one is part of (one level: a group can't be
--                    inside another group, and it has to be at the same location)
-- =============================================================================

select set_config('app.actor', 'Claude', true);

alter table public.rooms
  add column group_id uuid references public.rooms(id) on delete set null,
  add constraint rooms_group_not_self check (group_id is null or group_id <> id);
create index rooms_group_id_idx on public.rooms (group_id) where group_id is not null;

create or replace function public.rooms_group_check()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  g public.rooms;
begin
  if new.group_id is null then
    return new;
  end if;
  select * into g from public.rooms where id = new.group_id;
  if g.campus_id is distinct from new.campus_id then
    raise exception 'A room can only be part of a group at the same location.' using errcode = '23514';
  end if;
  if g.group_id is not null then
    raise exception '% is already part of %, so it can''t hold rooms of its own.', g.name, (select r.name from public.rooms r where r.id = g.group_id) using errcode = '23514';
  end if;
  if exists (select 1 from public.rooms r where r.group_id = new.id) then
    raise exception '% has rooms in it, so it can''t be part of another group.', new.name using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger rooms_group_check before insert or update of group_id, campus_id on public.rooms
  for each row execute function public.rooms_group_check();

-- Simpsonville: E-Wing Offices holds Production Storage and Luken's office.
insert into public.rooms (campus_id, name, sort_order)
select c.id, 'E-Wing Offices', 6 from public.campuses c where c.short_name = 'Simpsonville'
on conflict (campus_id, name) do nothing;

update public.rooms r set group_id = g.id
  from public.rooms g join public.campuses c on c.id = g.campus_id
 where c.short_name = 'Simpsonville' and g.name = 'E-Wing Offices'
   and r.campus_id = g.campus_id and r.name = 'Production Storage';

insert into public.rooms (campus_id, name, sort_order, group_id)
select g.campus_id, 'Luken''s Office', 0, g.id
  from public.rooms g join public.campuses c on c.id = g.campus_id
 where c.short_name = 'Simpsonville' and g.name = 'E-Wing Offices'
on conflict (campus_id, name) do nothing;
