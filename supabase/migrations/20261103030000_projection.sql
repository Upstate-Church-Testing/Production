-- =============================================================================
-- Projectors: front or rear projection.
--
--   devices.projection   'front' (the projector is on the audience's side of the
--                        screen) or 'rear' (behind it); empty until someone says.
-- It's a fact about the install, not the model, so it lives on the item. The app
-- asks for it on items whose model is a Projector.
-- =============================================================================

select set_config('app.actor', 'Claude', true);

alter table public.devices
  add column projection text check (projection is null or projection in ('front', 'rear'));

-- The item editor's save. Same as before, plus projection. An app that hasn't
-- reloaded since this change doesn't send it, and then the item keeps its value.
create or replace function public.save_device(payload jsonb)
returns uuid
language plpgsql
set search_path = ''
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
                                serial_number, firmware, location, status, notes, projection)
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
      nullif(trim(d ->> 'notes'), ''),
      nullif(d ->> 'projection', '')
    )
    returning id into dev_id;
  else
    update public.devices dv set
      type_id       = (d ->> 'type_id')::uuid,
      campus_id     = (d ->> 'campus_id')::uuid,
      room_id       = nullif(d ->> 'room_id', '')::uuid,
      name          = coalesce(trim(d ->> 'name'), ''),
      departments   = array(select jsonb_array_elements_text(coalesce(d -> 'departments', '[]'))),
      serial_number = nullif(trim(d ->> 'serial_number'), ''),
      firmware      = nullif(trim(d ->> 'firmware'), ''),
      location      = nullif(trim(d ->> 'location'), ''),
      status        = coalesce(nullif(d ->> 'status', ''), 'active'),
      notes         = nullif(trim(d ->> 'notes'), ''),
      projection    = case when d ? 'projection' then nullif(d ->> 'projection', '') else dv.projection end
    where dv.id = dev_id;
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

-- Adding several at once: projection too.
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
    insert into public.devices (type_id, campus_id, room_id, name, departments, location, status, notes, projection)
    values (
      (d ->> 'type_id')::uuid,
      (d ->> 'campus_id')::uuid,
      nullif(d ->> 'room_id', '')::uuid,
      coalesce(trim(n), ''),
      array(select jsonb_array_elements_text(coalesce(d -> 'departments', '[]'))),
      nullif(trim(d ->> 'location'), ''),
      coalesce(nullif(d ->> 'status', ''), 'active'),
      nullif(trim(d ->> 'notes'), ''),
      nullif(d ->> 'projection', '')
    );
    added := added + 1;
  end loop;
  return added;
end
$$;

-- What's known so far: North Auditorium's house left and right are rear, its
-- center is front; Mauldin's projector is front.
update public.devices d set projection = v.p
  from (values ('Simpsonville', 'North Auditorium', 'House left', 'rear'),
               ('Simpsonville', 'North Auditorium', 'House right', 'rear'),
               ('Simpsonville', 'North Auditorium', 'Center', 'front')) v(campus, room, spot, p),
       public.campuses c, public.rooms r, public.device_types t
 where c.short_name = v.campus and r.campus_id = c.id and r.name = v.room
   and d.campus_id = c.id and d.room_id = r.id and d.location = v.spot
   and t.id = d.type_id and t.category = 'Projector';
update public.devices d set projection = 'front'
  from public.campuses c, public.device_types t
 where c.short_name = 'Mauldin' and d.campus_id = c.id and t.id = d.type_id and t.category = 'Projector';
