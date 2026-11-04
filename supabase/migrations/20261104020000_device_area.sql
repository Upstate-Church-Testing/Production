-- Where in the room, in two steps:
--   devices.area      the part of the room: Front of house, Stage, Backstage, House…
--   devices.location  the spot inside it (shown as "Spot"): FOH rack, Backstage rack…
-- Both free text, matched without regard to capitals. Gear's "Area / spot" filter
-- groups spots under their area, and Items lists in blocks by room › area › spot.
-- (Operator position, devices.positions, is the job an item serves: CG, Audio…)

alter table public.devices
  add column if not exists area text constraint devices_area_check check (area is null or length(trim(area)) between 1 and 40);

-- The item editor's save: area rides along with projection, the rigging position,
-- positions and used-as. An app that hasn't reloaded doesn't send it, and the item
-- keeps what it had.
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
  roles  text[] := public.clean_positions(d -> 'positions');
  used   text := nullif(trim(d ->> 'used_as'), '');
  ar     text := nullif(trim(d ->> 'area'), '');
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
  if d ? 'positions' then
    update public.devices set positions = roles where id = dev_id and positions is distinct from roles;
  end if;
  if d ? 'used_as' then
    update public.devices set used_as = used where id = dev_id and used_as is distinct from used;
  end if;
  if d ? 'area' then
    update public.devices set area = ar where id = dev_id and area is distinct from ar;
  end if;
  return dev_id;
end
$$;

-- Adding several at once: area too.
create or replace function public.add_devices(payload jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  d      jsonb := payload -> 'device';
  n      text;
  added  int := 0;
begin
  if not public.has_role('staff') then
    raise exception 'Only staff can edit gear.' using errcode = '42501';
  end if;
  if jsonb_array_length(coalesce(payload -> 'names', '[]')) not between 1 and 500 then
    raise exception 'Add between 1 and 500 at a time.' using errcode = '22023';
  end if;
  for n in select jsonb_array_elements_text(payload -> 'names') loop
    insert into public.devices (type_id, campus_id, room_id, name, departments, location, area, status, notes, projection, positions, used_as)
    values (
      (d ->> 'type_id')::uuid,
      (d ->> 'campus_id')::uuid,
      nullif(d ->> 'room_id', '')::uuid,
      coalesce(trim(n), ''),
      array(select jsonb_array_elements_text(coalesce(d -> 'departments', '[]'))),
      nullif(trim(d ->> 'location'), ''),
      nullif(trim(d ->> 'area'), ''),
      coalesce(nullif(d ->> 'status', ''), 'active'),
      nullif(trim(d ->> 'notes'), ''),
      nullif(d ->> 'projection', ''),
      public.clean_positions(d -> 'positions'),
      nullif(trim(d ->> 'used_as'), '')
    );
    added := added + 1;
  end loop;
  return added;
end
$$;
