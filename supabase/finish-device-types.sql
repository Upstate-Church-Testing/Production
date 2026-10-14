-- =============================================================================
-- Finish device types: run once in Supabase › SQL Editor.
-- Moves maker / model / category onto types and updates the two save functions.
-- Contains DROP and DELETE, so Supabase needs a person to run it.
-- No data is removed: no units existed when the columns were moved.
-- Safe to run more than once.
-- =============================================================================

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
