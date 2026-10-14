-- =============================================================================
-- Device types
--
-- A device TYPE is the shared catalog entry for a product (a Hoglet 4, an
-- HDMI-to-SDI converter, a Cisco SG350-10). It isn't at any campus. It holds
-- what's true of every unit: maker, part number, category, tags, specs and
-- the port layout.
--
-- Each DEVICE (shown as a "model" in the app) is one physical unit at one
-- campus, and must have a type. It holds what's specific to that unit: name,
-- room, location, serial, firmware, IPs, logins, and what's plugged into each
-- of its type's ports.
--
-- Part A runs from Claude. Part B contains DROP / DELETE, which Supabase
-- requires a person to run (supabase/finish-device-types.sql is the same text).
-- =============================================================================


-- ============================ PART A =========================================

create table public.device_types (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) > 0),   -- "Hoglet 4"
  manufacturer  text,                                            -- "High End Systems"
  part_number   text,                                            -- maker's model / part number
  category      text,                                            -- Console, Converter, Switch…
  departments   text[] not null default '{}',
  description   text,
  specs         jsonb not null default '[]' check (jsonb_typeof(specs) = 'array'),  -- [{label, value}]
  manual_url    text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.profiles (id) on delete set null,
  updated_by    uuid references public.profiles (id) on delete set null
);

create unique index device_types_name_idx
  on public.device_types (lower(coalesce(manufacturer, '')), lower(name));

-- The port layout every unit of a type shares.
create table public.device_type_ports (
  id          uuid primary key default gen_random_uuid(),
  type_id     uuid not null references public.device_types (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),     -- "DMX 1", "HDMI In", "Ethernet"
  signal      text,                                              -- DMX, Ethernet, HDMI, SDI…
  connector   text,                                              -- XLR5, RJ45, BNC…
  direction   text not null default 'io' check (direction in ('in', 'out', 'io')),
  notes       text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (type_id, name)
);

create index device_type_ports_type_idx on public.device_type_ports (type_id);

-- Per unit: what's plugged into each of its type's ports.
create table public.device_ports (
  id                   uuid primary key default gen_random_uuid(),
  device_id            uuid not null references public.devices (id) on delete cascade,
  type_port_id         uuid not null references public.device_type_ports (id) on delete cascade,
  connected_to         text,                                    -- "Stage Pathport DMX 1", "Camera 3"
  connected_device_id  uuid references public.devices (id) on delete set null,          -- for linking later
  connected_port_id    uuid references public.device_type_ports (id) on delete set null,
  assignment           text,                                    -- "Universe 5", "Input 3", "Dante 1–8"
  settings             jsonb not null default '{}',             -- room for protocol, refresh rate…
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid references public.profiles (id) on delete set null,
  updated_by           uuid references public.profiles (id) on delete set null,
  unique (device_id, type_port_id)
);

create index device_ports_device_idx on public.device_ports (device_id);

-- Every unit has a type. (No units existed yet when this was added.)
alter table public.devices add column type_id uuid references public.device_types (id) on delete restrict;
alter table public.devices alter column type_id set not null;
create index devices_type_idx on public.devices (type_id);

-- A new unit takes its type's tags unless it was given its own.
-- (Named to run before the tag check.)
create function public.devices_type_defaults()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if cardinality(coalesce(new.departments, '{}')) = 0 then
    select t.departments into new.departments from public.device_types t where t.id = new.type_id;
  end if;
  if nullif(trim(new.name), '') is null then
    select t.name into new.name from public.device_types t where t.id = new.type_id;
  end if;
  return new;
end
$$;

create trigger devices_1_type_defaults before insert or update of type_id, departments, name on public.devices
  for each row execute function public.devices_type_defaults();

-- A port patch must use a port from that unit's own type.
create function public.device_ports_check()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if not exists (select 1
                   from public.devices d
                   join public.device_type_ports p on p.type_id = d.type_id
                  where d.id = new.device_id and p.id = new.type_port_id) then
    raise exception 'That port isn''t on this unit''s type.' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger device_types_departments before insert or update of departments on public.device_types
  for each row execute function public.normalize_departments('required');
create trigger device_types_stamp before insert or update on public.device_types
  for each row execute function public.stamp();
create trigger device_ports_check before insert or update on public.device_ports
  for each row execute function public.device_ports_check();
create trigger device_ports_stamp before insert or update on public.device_ports
  for each row execute function public.stamp();

-- History now also covers types and port patches.
create or replace function public.log_activity()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  o       jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n       jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  r       jsonb := coalesce(n, o);
  skip    text[] := array['id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'sort_order'];
  diff    jsonb := '{}';
  k       text;
  v_dev   uuid;
  v_camp  uuid;
  v_label text;
begin
  if tg_table_name in ('device_ips', 'device_credentials', 'device_ports') then
    skip := skip || array['device_id', 'campus_id', 'type_port_id'];
  end if;

  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(n) loop
      continue when k = any(skip);
      if (o -> k) is distinct from (n -> k) then
        diff := diff || jsonb_build_object(k,
          case when k = 'password' then '["hidden", "hidden"]'::jsonb
               else jsonb_build_array(o -> k, n -> k) end);
      end if;
    end loop;
    if diff = '{}' then
      return null;
    end if;
  else
    for k in select jsonb_object_keys(r) loop
      continue when k = any(skip) or r -> k in ('null'::jsonb, '[]'::jsonb, '{}'::jsonb);
      diff := diff || jsonb_build_object(k, case when k = 'password' then '"hidden"'::jsonb else r -> k end);
    end loop;
  end if;

  v_dev := case tg_table_name
             when 'devices' then (r ->> 'id')::uuid
             when 'device_ips' then (r ->> 'device_id')::uuid
             when 'device_credentials' then (r ->> 'device_id')::uuid
             when 'device_ports' then (r ->> 'device_id')::uuid
           end;

  v_camp := coalesce(
    (r ->> 'campus_id')::uuid,
    (select d.campus_id from public.devices d where d.id = v_dev)
  );

  v_label := case tg_table_name
               when 'devices' then r ->> 'name'
               when 'networks' then r ->> 'name'
               when 'device_types' then r ->> 'name'
               when 'device_ips' then coalesce(host((r ->> 'ip')::inet), r ->> 'label', 'IP')
               when 'device_credentials' then coalesce(nullif(r ->> 'label', ''), 'Login')
               when 'device_ports' then coalesce((select p.name from public.device_type_ports p
                                                   where p.id = (r ->> 'type_port_id')::uuid), 'Port')
             end;

  insert into public.activity (actor_id, action, entity, entity_id, device_id, campus_id, label, changes)
  values (
    (select p.id from public.profiles p where p.id = auth.uid()),
    case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    tg_table_name,
    (r ->> 'id')::uuid,
    v_dev,
    case when exists (select 1 from public.campuses c where c.id = v_camp) then v_camp end,
    v_label,
    diff
  );
  return null;
end
$$;

create trigger device_types_activity after insert or update or delete on public.device_types
  for each row execute function public.log_activity();
create trigger device_ports_activity after insert or update or delete on public.device_ports
  for each row execute function public.log_activity();

alter table public.device_types      enable row level security;
alter table public.device_type_ports enable row level security;
alter table public.device_ports      enable row level security;

create policy "staff manage device types" on public.device_types
  for all to authenticated
  using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));
create policy "staff manage type ports" on public.device_type_ports
  for all to authenticated
  using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));
create policy "staff manage unit ports" on public.device_ports
  for all to authenticated
  using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));

grant select, insert, update, delete on public.device_types, public.device_type_ports, public.device_ports to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.device_types, public.device_type_ports, public.device_ports;
  end if;
end
$$;


-- ============================ PART B =========================================
-- (needs a person: run supabase/finish-device-types.sql in the SQL Editor)

-- Maker, model and category now live on the type.
alter table public.devices drop column if exists manufacturer;
alter table public.devices drop column if exists model;
alter table public.devices drop column if exists category;

-- Saves a unit with its IPs, logins and port patches in one step.
create or replace function public.save_device(payload jsonb)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  d          jsonb := payload -> 'device';
  dev_id     uuid  := nullif(d ->> 'id', '')::uuid;
  item       jsonb;
  row_id     uuid;
  keep       uuid[];
  pos        int;
begin
  if not public.has_role('staff') then
    raise exception 'Only staff can edit gear.' using errcode = '42501';
  end if;

  if dev_id is null then
    insert into public.devices (type_id, campus_id, room_id, name, departments,
                                serial_number, firmware, location, status, notes)
    values (
      (d ->> 'type_id')::uuid,
      (d ->> 'campus_id')::uuid,
      nullif(d ->> 'room_id', '')::uuid,
      coalesce(trim(d ->> 'name'), ''),
      array(select jsonb_array_elements_text(coalesce(d -> 'departments', '[]'))),
      nullif(trim(d ->> 'serial_number'), ''),
      nullif(trim(d ->> 'firmware'), ''),
      nullif(trim(d ->> 'location'), ''),
      coalesce(nullif(d ->> 'status', ''), 'active'),
      nullif(trim(d ->> 'notes'), '')
    )
    returning id into dev_id;
  else
    update public.devices set
      type_id       = (d ->> 'type_id')::uuid,
      campus_id     = (d ->> 'campus_id')::uuid,
      room_id       = nullif(d ->> 'room_id', '')::uuid,
      name          = coalesce(trim(d ->> 'name'), ''),
      departments   = array(select jsonb_array_elements_text(coalesce(d -> 'departments', '[]'))),
      serial_number = nullif(trim(d ->> 'serial_number'), ''),
      firmware      = nullif(trim(d ->> 'firmware'), ''),
      location      = nullif(trim(d ->> 'location'), ''),
      status        = coalesce(nullif(d ->> 'status', ''), 'active'),
      notes         = nullif(trim(d ->> 'notes'), '')
    where id = dev_id;
    if not found then
      raise exception 'That unit was deleted by someone else.' using errcode = 'P0002';
    end if;
    -- If the type changed, patches on the old type's ports no longer apply.
    delete from public.device_ports dp
     where dp.device_id = dev_id
       and not exists (select 1 from public.device_type_ports p
                        where p.id = dp.type_port_id and p.type_id = (d ->> 'type_id')::uuid);
  end if;

  -- IPs
  keep := '{}';
  pos := 0;
  for item in select * from jsonb_array_elements(coalesce(payload -> 'ips', '[]')) loop
    row_id := nullif(item ->> 'id', '')::uuid;
    if row_id is not null and exists (select 1 from public.device_ips where id = row_id and device_id = dev_id) then
      update public.device_ips set
        network_id = nullif(item ->> 'network_id', '')::uuid,
        label      = nullif(trim(item ->> 'label'), ''),
        ip         = nullif(trim(item ->> 'ip'), '')::inet,
        gateway    = nullif(trim(item ->> 'gateway'), '')::inet,
        mac        = nullif(trim(item ->> 'mac'), '')::macaddr,
        hostname   = nullif(trim(item ->> 'hostname'), ''),
        mode       = coalesce(nullif(item ->> 'mode', ''), 'static'),
        notes      = nullif(trim(item ->> 'notes'), ''),
        sort_order = pos
      where id = row_id;
    else
      insert into public.device_ips (device_id, campus_id, network_id, label, ip, gateway, mac, hostname, mode, notes, sort_order)
      values (
        dev_id,
        (d ->> 'campus_id')::uuid,
        nullif(item ->> 'network_id', '')::uuid,
        nullif(trim(item ->> 'label'), ''),
        nullif(trim(item ->> 'ip'), '')::inet,
        nullif(trim(item ->> 'gateway'), '')::inet,
        nullif(trim(item ->> 'mac'), '')::macaddr,
        nullif(trim(item ->> 'hostname'), ''),
        coalesce(nullif(item ->> 'mode', ''), 'static'),
        nullif(trim(item ->> 'notes'), ''),
        pos
      )
      returning id into row_id;
    end if;
    keep := keep || row_id;
    pos := pos + 1;
  end loop;
  delete from public.device_ips where device_id = dev_id and not (id = any (keep));

  -- Logins: only touched when the editor loaded them.
  if payload ? 'credentials' then
    keep := '{}';
    pos := 0;
    for item in select * from jsonb_array_elements(coalesce(payload -> 'credentials', '[]')) loop
      row_id := nullif(item ->> 'id', '')::uuid;
      if row_id is not null and exists (select 1 from public.device_credentials where id = row_id and device_id = dev_id) then
        update public.device_credentials set
          label      = nullif(trim(item ->> 'label'), ''),
          username   = nullif(item ->> 'username', ''),
          password   = nullif(item ->> 'password', ''),
          notes      = nullif(trim(item ->> 'notes'), ''),
          sort_order = pos
        where id = row_id;
      else
        insert into public.device_credentials (device_id, label, username, password, notes, sort_order)
        values (
          dev_id,
          nullif(trim(item ->> 'label'), ''),
          nullif(item ->> 'username', ''),
          nullif(item ->> 'password', ''),
          nullif(trim(item ->> 'notes'), ''),
          pos
        )
        returning id into row_id;
      end if;
      keep := keep || row_id;
      pos := pos + 1;
    end loop;
    delete from public.device_credentials where device_id = dev_id and not (id = any (keep));
  end if;

  -- Port patches: only touched when the editor loaded them. Empty rows are cleared.
  if payload ? 'ports' then
    for item in select * from jsonb_array_elements(coalesce(payload -> 'ports', '[]')) loop
      if coalesce(nullif(trim(item ->> 'connected_to'), ''), nullif(trim(item ->> 'assignment'), ''),
                  nullif(trim(item ->> 'notes'), '')) is null then
        delete from public.device_ports
         where device_id = dev_id and type_port_id = (item ->> 'type_port_id')::uuid;
      else
        insert into public.device_ports (device_id, type_port_id, connected_to, assignment, notes)
        values (dev_id, (item ->> 'type_port_id')::uuid, nullif(trim(item ->> 'connected_to'), ''),
                nullif(trim(item ->> 'assignment'), ''), nullif(trim(item ->> 'notes'), ''))
        on conflict (device_id, type_port_id) do update set
          connected_to = excluded.connected_to,
          assignment   = excluded.assignment,
          notes        = excluded.notes;
      end if;
    end loop;
  end if;

  return dev_id;
end
$$;

-- Saves a type with its port layout in one step. Ports left out are removed,
-- along with what units had recorded on them.
create or replace function public.save_device_type(payload jsonb)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  t        jsonb := payload -> 'type';
  type_id_ uuid  := nullif(t ->> 'id', '')::uuid;
  item     jsonb;
  row_id   uuid;
  keep     uuid[] := '{}';
  pos      int := 0;
begin
  if not public.has_role('staff') then
    raise exception 'Only staff can edit gear.' using errcode = '42501';
  end if;

  if type_id_ is null then
    insert into public.device_types (name, manufacturer, part_number, category, departments, description, specs, manual_url, notes)
    values (
      trim(t ->> 'name'),
      nullif(trim(t ->> 'manufacturer'), ''),
      nullif(trim(t ->> 'part_number'), ''),
      nullif(trim(t ->> 'category'), ''),
      array(select jsonb_array_elements_text(coalesce(t -> 'departments', '[]'))),
      nullif(trim(t ->> 'description'), ''),
      coalesce(t -> 'specs', '[]'),
      nullif(trim(t ->> 'manual_url'), ''),
      nullif(trim(t ->> 'notes'), '')
    )
    returning id into type_id_;
  else
    update public.device_types set
      name         = trim(t ->> 'name'),
      manufacturer = nullif(trim(t ->> 'manufacturer'), ''),
      part_number  = nullif(trim(t ->> 'part_number'), ''),
      category     = nullif(trim(t ->> 'category'), ''),
      departments  = array(select jsonb_array_elements_text(coalesce(t -> 'departments', '[]'))),
      description  = nullif(trim(t ->> 'description'), ''),
      specs        = coalesce(t -> 'specs', '[]'),
      manual_url   = nullif(trim(t ->> 'manual_url'), ''),
      notes        = nullif(trim(t ->> 'notes'), '')
    where id = type_id_;
    if not found then
      raise exception 'That type was deleted by someone else.' using errcode = 'P0002';
    end if;
  end if;

  if payload ? 'ports' then
    -- Clear names first so ports can be renamed or swapped without tripping the unique name rule.
    update public.device_type_ports set name = id::text where type_id = type_id_;
    for item in select * from jsonb_array_elements(coalesce(payload -> 'ports', '[]')) loop
      row_id := nullif(item ->> 'id', '')::uuid;
      if row_id is not null and exists (select 1 from public.device_type_ports where id = row_id and type_id = type_id_) then
        update public.device_type_ports set
          name       = trim(item ->> 'name'),
          signal     = nullif(trim(item ->> 'signal'), ''),
          connector  = nullif(trim(item ->> 'connector'), ''),
          direction  = coalesce(nullif(item ->> 'direction', ''), 'io'),
          notes      = nullif(trim(item ->> 'notes'), ''),
          sort_order = pos
        where id = row_id;
      else
        insert into public.device_type_ports (type_id, name, signal, connector, direction, notes, sort_order)
        values (type_id_, trim(item ->> 'name'), nullif(trim(item ->> 'signal'), ''), nullif(trim(item ->> 'connector'), ''),
                coalesce(nullif(item ->> 'direction', ''), 'io'), nullif(trim(item ->> 'notes'), ''), pos)
        returning id into row_id;
      end if;
      keep := keep || row_id;
      pos := pos + 1;
    end loop;
    delete from public.device_type_ports where type_id = type_id_ and not (id = any (keep));
  end if;

  return type_id_;
end
$$;

revoke execute on function public.save_device_type(jsonb) from public, anon;
grant execute on function public.save_device_type(jsonb) to authenticated;
revoke all on table public.device_types, public.device_type_ports, public.device_ports from anon;
