-- Types say whether their models connect to a network. Fixtures like an R3 Beam
-- don't, so they stay off the IP sheet (unless one is given an IP).
alter table public.device_types add column networked boolean not null default true;

-- Adds many models of one type at once, one per name, in a single step.
create function public.add_devices(payload jsonb)
returns int
language plpgsql security invoker set search_path = ''
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
    insert into public.devices (type_id, campus_id, room_id, name, departments, location, status, notes)
    values (
      (d ->> 'type_id')::uuid,
      (d ->> 'campus_id')::uuid,
      nullif(d ->> 'room_id', '')::uuid,
      coalesce(trim(n), ''),
      array(select jsonb_array_elements_text(coalesce(d -> 'departments', '[]'))),
      nullif(trim(d ->> 'location'), ''),
      coalesce(nullif(d ->> 'status', ''), 'active'),
      nullif(trim(d ->> 'notes'), '')
    );
    added := added + 1;
  end loop;
  return added;
end
$$;

grant execute on function public.add_devices(jsonb) to authenticated;
