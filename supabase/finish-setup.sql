-- =============================================================================
-- Finish setup: run once in Supabase › SQL Editor.
--
-- The rest of the database was set up from Claude. These two pieces contain
-- the words DELETE and REVOKE, which need a person to run them:
--   * save_device: saves a device with its IPs and logins in one step
--     (its DELETE only removes IPs/logins you took off that device).
--   * Locks every table and function away from signed-out visitors.
-- Safe to run more than once.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- save_device: saves a device with its IPs (and logins, when included)
-- in one step, so a half-saved device never happens.
-- ---------------------------------------------------------------------------
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
    raise exception 'Only staff can edit the network sheet.' using errcode = '42501';
  end if;

  if dev_id is null then
    insert into public.devices (campus_id, room_id, name, departments, category, manufacturer, model,
                                serial_number, firmware, location, status, notes)
    values (
      (d ->> 'campus_id')::uuid,
      nullif(d ->> 'room_id', '')::uuid,
      trim(d ->> 'name'),
      array(select jsonb_array_elements_text(coalesce(d -> 'departments', '[]'))),
      nullif(trim(d ->> 'category'), ''),
      nullif(trim(d ->> 'manufacturer'), ''),
      nullif(trim(d ->> 'model'), ''),
      nullif(trim(d ->> 'serial_number'), ''),
      nullif(trim(d ->> 'firmware'), ''),
      nullif(trim(d ->> 'location'), ''),
      coalesce(nullif(d ->> 'status', ''), 'active'),
      nullif(trim(d ->> 'notes'), '')
    )
    returning id into dev_id;
  else
    update public.devices set
      campus_id     = (d ->> 'campus_id')::uuid,
      room_id       = nullif(d ->> 'room_id', '')::uuid,
      name          = trim(d ->> 'name'),
      departments   = array(select jsonb_array_elements_text(coalesce(d -> 'departments', '[]'))),
      category      = nullif(trim(d ->> 'category'), ''),
      manufacturer  = nullif(trim(d ->> 'manufacturer'), ''),
      model         = nullif(trim(d ->> 'model'), ''),
      serial_number = nullif(trim(d ->> 'serial_number'), ''),
      firmware      = nullif(trim(d ->> 'firmware'), ''),
      location      = nullif(trim(d ->> 'location'), ''),
      status        = coalesce(nullif(d ->> 'status', ''), 'active'),
      notes         = nullif(trim(d ->> 'notes'), '')
    where id = dev_id;
    if not found then
      raise exception 'That device was deleted by someone else.' using errcode = 'P0002';
    end if;
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

  return dev_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants: nothing for signed-out visitors.
-- ---------------------------------------------------------------------------
revoke all on table public.departments, public.campuses, public.profiles, public.rooms, public.networks,
                    public.devices, public.device_ips, public.device_credentials, public.activity,
                    public.ip_conflicts
  from anon;

revoke execute on function public.my_role(), public.has_role(public.app_role), public.save_device(jsonb)
  from public, anon;
grant execute on function public.my_role(), public.has_role(public.app_role), public.save_device(jsonb)
  to authenticated;

-- Trigger functions run automatically; nobody should call them directly.
revoke execute on function public.guard_profile(), public.handle_new_user(),
  public.handle_user_email_change(), public.log_activity()
  from public, anon, authenticated;
