-- =============================================================================
-- What an item is for.
--
--   devices.positions  the production positions it makes possible: CG, Director,
--                      Audio, Lighting… An item can serve more than one. Search
--                      or filter "CG" and you get the Mac minis, screens,
--                      keyboards, converters and stage displays behind CG.
--   devices.used_as    what this one is used as, within its kind: a Display
--                      used as a Stage display, a Computer monitor, a Confidence
--                      monitor, an LED wall.
-- Both are on the item, not the model: the same TV can be a stage display in one
-- room and a lobby screen in another. Filters stack: Position CG + Category
-- Display + Used as Stage display = every CG stage display.
-- =============================================================================

select set_config('app.actor', 'Claude', true);

-- Each position: 1–40 characters, no blanks; up to 12 on one item.
create or replace function public.valid_positions(a text[])
returns boolean
language sql immutable set search_path = ''
as $$
  select cardinality(a) <= 12
     and coalesce((select bool_and(x is not null and length(trim(x)) between 1 and 40) from unnest(a) x), true)
$$;

alter table public.devices
  add column positions text[] not null default '{}' constraint devices_positions_check check (public.valid_positions(positions)),
  add column used_as text constraint devices_used_as_check check (used_as is null or length(trim(used_as)) between 1 and 60);

-- "CG, cg , Audio" → {CG, Audio}: trimmed, blanks dropped, repeats (any case) once, in order.
create or replace function public.clean_positions(j jsonb)
returns text[]
language sql immutable set search_path = ''
as $$
  select coalesce(array_agg(v order by first), '{}')
    from (select (array_agg(trim(x) order by n))[1] v, min(n) first
            from jsonb_array_elements_text(coalesce(j, '[]')) with ordinality e(x, n)
           where trim(x) <> ''
           group by lower(trim(x))) s
$$;

-- The item editor's save: projection, the rigging position, positions and used-as
-- ride along after the main save. An app that hasn't reloaded doesn't send the
-- new ones, and the item keeps what it had.
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
  return dev_id;
end
$$;

-- Adding several at once: positions and used-as too.
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
    insert into public.devices (type_id, campus_id, room_id, name, departments, location, status, notes, projection, positions, used_as)
    values (
      (d ->> 'type_id')::uuid,
      (d ->> 'campus_id')::uuid,
      nullif(d ->> 'room_id', '')::uuid,
      coalesce(trim(n), ''),
      array(select jsonb_array_elements_text(coalesce(d -> 'departments', '[]'))),
      nullif(trim(d ->> 'location'), ''),
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
