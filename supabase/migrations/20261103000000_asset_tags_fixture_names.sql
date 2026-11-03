-- =============================================================================
-- Asset numbers, fixture names, no stage numbers.
--
--   Asset #     One number per item across all of Upstate Church Production,
--               shown as UCP-000001 (up to UCP-999999). Never shared, never
--               reused: a deleted item's number isn't handed out again. It stays
--               with the item when it moves or its model is corrected.
--               (Before this it was 1…N per model, so 33 numbers were shared.)
--   Fixtures    A light has no name of its own: it goes by its model's name
--               ("Colorado Solo Batten"), and the asset # tells them apart. The
--               name follows the model when the model is picked or renamed.
--   Stage #     No longer handed out or shown. The stage_no column, the
--               per-model asset key and asset_counters are left in place for a
--               later cleanup (dropping them needs a confirmation).
-- =============================================================================

alter table public.devices disable trigger devices_activity;
alter table public.devices disable trigger devices_stamp;
alter table public.devices disable trigger devices_numbers;

-- Order: location, room (Worship Center first, Storage last), section, brand,
-- model, fixture ID, then the old number, so a room's gear runs in a row.
-- (Shifted up first so the per-model key never sees a clash mid-update.)
with ordered as (
  select d.id,
         row_number() over (
           order by c.sort_order, c.name,
                    coalesce(r.name ilike '%storage%', true),
                    coalesce(r.name ilike 'worship%', false) desc,
                    r.sort_order nulls last, r.name nulls last,
                    coalesce((select min(dp.sort_order) from public.departments dp where dp.slug = any (d.departments)), 99),
                    lower(coalesce(t.manufacturer, '')), lower(t.name),
                    d.fixture_id nulls last, d.asset_no nulls last, d.created_at, d.id) as n
    from public.devices d
    join public.campuses c on c.id = d.campus_id
    join public.device_types t on t.id = d.type_id
    left join public.rooms r on r.id = d.room_id
)
update public.devices d set asset_no = o.n + 100000
  from ordered o
 where o.id = d.id;
update public.devices set asset_no = asset_no - 100000 where asset_no > 100000;

-- Fixtures go by their model's name.
update public.devices d set name = t.name
  from public.device_types t
 where t.id = d.type_id
   and lower(trim(coalesce(t.category, ''))) = 'fixture'
   and d.name is distinct from t.name;

alter table public.devices enable trigger devices_activity;
alter table public.devices enable trigger devices_stamp;
alter table public.devices enable trigger devices_numbers;

alter table public.devices
  alter column asset_no set not null,
  add constraint devices_asset_no_max check (asset_no <= 999999),
  add constraint devices_asset_no_key unique (asset_no) deferrable initially immediate;

create sequence public.devices_asset_seq minvalue 1 maxvalue 999999 no cycle;
select setval('public.devices_asset_seq', (select max(asset_no) from public.devices));


-- ---------------------------------------------------------------------------
-- Numbering, before every insert and update of an item: asset #, and the
-- patch and fixture ID that belong to the old room's console after a move.
-- ---------------------------------------------------------------------------
create or replace function public.devices_numbers()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  extra   jsonb := nullif(current_setting('app.device_numbers', true), '')::jsonb;
  moved   boolean := tg_op = 'UPDATE' and (new.campus_id is distinct from old.campus_id or new.room_id is distinct from old.room_id);
  foot    int;
begin
  -- Numbers sent with save_device_full: only the ones the person changed.
  if jsonb_typeof(extra) = 'object' then
    perform set_config('app.device_numbers', '', true);   -- one item per save
    if extra ? 'asset_no'       then new.asset_no       := nullif(extra ->> 'asset_no', '')::int; end if;
    if extra ? 'fixture_id'     then new.fixture_id     := nullif(extra ->> 'fixture_id', '')::int; end if;
    if extra ? 'patch_universe' then new.patch_universe := nullif(extra ->> 'patch_universe', '')::int; end if;
    if extra ? 'patch_address'  then new.patch_address  := nullif(extra ->> 'patch_address', '')::int; end if;
    if extra ? 'dmx_channels'   then new.dmx_channels   := nullif(extra ->> 'dmx_channels', '')::int; end if;
  end if;

  -- Asset #: the next one nobody has had (skipping any typed in by hand).
  if new.asset_no is null then
    loop
      new.asset_no := nextval('public.devices_asset_seq');
      exit when not exists (select 1 from public.devices d where d.asset_no = new.asset_no and d.id <> new.id);
    end loop;
  end if;

  -- A patch and fixture ID belong to the old room's console.
  if moved then
    if new.fixture_id is not distinct from old.fixture_id then new.fixture_id := null; end if;
    if new.patch_universe is not distinct from old.patch_universe
       and new.patch_address is not distinct from old.patch_address then
      new.patch_universe := null;
      new.patch_address := null;
    end if;
  end if;

  -- A fixture can't run past the end of its universe.
  if new.patch_address is not null then
    select coalesce(new.dmx_channels, t.dmx_footprint, case when cardinality(t.dmx_modes) = 1 then t.dmx_modes[1] end, 1)
      into foot from public.device_types t where t.id = new.type_id;
    if new.patch_address + foot - 1 > 512 then
      raise exception 'Patched at %.% with % channels, it runs past address 512. Start it at %.% or lower, or on the next universe.',
        new.patch_universe, new.patch_address, foot, new.patch_universe, 513 - foot using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

-- The patch sheet saves many items at once: [{ id, fixture_id?, patch_universe?, … }].
-- Only the keys present change. Asset numbers can be swapped within one save.
create or replace function public.set_device_numbers(rows jsonb)
returns int
language plpgsql security invoker set search_path = ''
as $$
declare
  r jsonb;
  n int := 0;
begin
  if not public.has_role('staff') then
    raise exception 'Only staff can edit gear.' using errcode = '42501';
  end if;
  set constraints public.devices_asset_no_key, public.devices_type_asset_key deferred;
  for r in select * from jsonb_array_elements(coalesce(rows, '[]')) loop
    update public.devices d set
      asset_no       = case when r ? 'asset_no' and nullif(r ->> 'asset_no', '') is not null then (r ->> 'asset_no')::int else d.asset_no end,
      fixture_id     = case when r ? 'fixture_id'     then nullif(r ->> 'fixture_id', '')::int     else d.fixture_id end,
      patch_universe = case when r ? 'patch_universe' then nullif(r ->> 'patch_universe', '')::int else d.patch_universe end,
      patch_address  = case when r ? 'patch_address'  then nullif(r ->> 'patch_address', '')::int  else d.patch_address end,
      dmx_channels   = case when r ? 'dmx_channels'   then nullif(r ->> 'dmx_channels', '')::int   else d.dmx_channels end
    where d.id = (r ->> 'id')::uuid;
    if found then n := n + 1; end if;
  end loop;
  set constraints public.devices_asset_no_key, public.devices_type_asset_key immediate;   -- duplicates fail here, with the save
  return n;
end
$$;

-- ---------------------------------------------------------------------------
-- Fixture names follow the model.
-- ---------------------------------------------------------------------------
create or replace function public.devices_type_defaults()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  t record;
begin
  select dt.departments, dt.name, dt.category into t from public.device_types dt where dt.id = new.type_id;
  if cardinality(coalesce(new.departments, '{}')) = 0 then
    new.departments := t.departments;
  end if;
  -- A fixture has no name of its own; the asset # tells them apart.
  if nullif(trim(new.name), '') is null or lower(trim(coalesce(t.category, ''))) = 'fixture' then
    new.name := t.name;
  end if;
  return new;
end
$$;

-- Renaming a fixture model (or making a model a fixture) renames its items.
create function public.device_types_fixture_names()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if lower(trim(coalesce(new.category, ''))) = 'fixture' then
    update public.devices d set name = new.name where d.type_id = new.id and d.name is distinct from new.name;
  end if;
  return null;
end
$$;

create trigger device_types_fixture_names after insert or update of name, category on public.device_types
  for each row execute function public.device_types_fixture_names();
