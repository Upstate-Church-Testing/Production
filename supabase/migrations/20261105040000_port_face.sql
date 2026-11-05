-- Which side of the unit each port is on (front, back, left, right, top or bottom), so a
-- model's port list says where to find each connector. Optional: blank means not recorded.
--
-- save_device_type keeps a port's side when the editor that saves it doesn't send one
-- (an older open copy of the app), and sets it when it does.

alter table public.device_type_ports
  add column face text check (face in ('front', 'back', 'left', 'right', 'top', 'bottom'));

create or replace function public.save_device_type(payload jsonb)
returns uuid
language plpgsql
set search_path to ''
as $function$
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
          face       = case when item ? 'face' then nullif(item ->> 'face', '') else face end,
          notes      = nullif(trim(item ->> 'notes'), ''),
          sort_order = pos
        where id = row_id;
      else
        insert into public.device_type_ports (type_id, name, signal, connector, direction, face, notes, sort_order)
        values (type_id_, trim(item ->> 'name'), nullif(trim(item ->> 'signal'), ''), nullif(trim(item ->> 'connector'), ''),
                coalesce(nullif(item ->> 'direction', ''), 'io'), nullif(item ->> 'face', ''), nullif(trim(item ->> 'notes'), ''), pos)
        returning id into row_id;
      end if;
      keep := keep || row_id;
      pos := pos + 1;
    end loop;
    delete from public.device_type_ports where type_id = type_id_ and not (id = any (keep));
  end if;

  return type_id_;
end
$function$;

revoke execute on function public.save_device_type(jsonb) from public, anon;
