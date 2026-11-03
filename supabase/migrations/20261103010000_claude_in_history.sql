-- =============================================================================
-- Changes Claude makes show as "Claude" in history, not "Someone".
--
-- Claude edits the database directly, without signing in, so auth.uid() is
-- empty and history had no name to show. Claude now starts every SQL call with
--
--     select set_config('app.actor', 'Claude', true);
--
-- (local to that one call), and the history and "Added by / edited by" stamps
-- record that name. Nothing is guessed: a change with no signed-in person and
-- no marker still shows as "Someone".
--
--   activity.actor_name                  who made a change when it wasn't a signed-in person
--   devices / device_types
--     created_by_name, updated_by_name   the same, for the "Added by … · edited by …" line
--
-- Past history: every change recorded with no person (708, from Oct 14 to today)
-- was Claude's: the gear imports, photos, patch numbers and today's edits, all
-- made through Claude's database connection. Those are marked "Claude", and so
-- are the stamps of items and models whose adding or last edit was one of them.
-- =============================================================================

select set_config('app.actor', 'Claude', true);

alter table public.activity add column actor_name text check (actor_name is null or length(actor_name) between 1 and 60);
alter table public.devices
  add column created_by_name text check (created_by_name is null or length(created_by_name) between 1 and 60),
  add column updated_by_name text check (updated_by_name is null or length(updated_by_name) between 1 and 60);
alter table public.device_types
  add column created_by_name text check (created_by_name is null or length(created_by_name) between 1 and 60),
  add column updated_by_name text check (updated_by_name is null or length(updated_by_name) between 1 and 60);

-- The name behind a change that has no signed-in person: set by the caller
-- with set_config('app.actor', …, true), else null.
create or replace function public.actor_name()
returns text
language sql stable set search_path = ''
as $$
  select case when auth.uid() is null then nullif(trim(current_setting('app.actor', true)), '') end
$$;
revoke all on function public.actor_name() from public;
grant execute on function public.actor_name() to authenticated, service_role;

-- Stamps: a signed-in person, or Claude (who then replaces the last person's
-- "edited by"), or, with neither, whatever the row already said.
create or replace function public.stamp()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  who   uuid := auth.uid();
  bot   text := public.actor_name();
  named boolean := to_jsonb(new) ? 'updated_by_name';
begin
  if tg_op = 'INSERT' then
    if who is not null then
      new.created_by := who;
      if named then new := jsonb_populate_record(new, jsonb_build_object('created_by_name', null)); end if;
    elsif bot is not null then
      new.created_by := null;
      if named then new := jsonb_populate_record(new, jsonb_build_object('created_by_name', bot)); end if;
    end if;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    if named then new := jsonb_populate_record(new, jsonb_build_object('created_by_name', to_jsonb(old) -> 'created_by_name')); end if;
  end if;
  new.updated_at := now();
  if who is not null then
    new.updated_by := who;
    if named then new := jsonb_populate_record(new, jsonb_build_object('updated_by_name', null)); end if;
  elsif bot is not null then
    new.updated_by := null;
    if named then new := jsonb_populate_record(new, jsonb_build_object('updated_by_name', bot)); end if;
  end if;
  return new;
end
$$;

-- History: the same rule, and the name columns aren't changes worth listing.
create or replace function public.log_activity()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  o       jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n       jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  r       jsonb := coalesce(n, o);
  skip    text[] := array['id', 'created_at', 'created_by', 'created_by_name', 'updated_at', 'updated_by', 'updated_by_name', 'sort_order'];
  diff    jsonb := '{}';
  k       text;
  v_dev   uuid;
  v_camp  uuid;
  v_label text;
  v_actor uuid := (select p.id from public.profiles p where p.id = auth.uid());
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

  insert into public.activity (actor_id, actor_name, action, entity, entity_id, device_id, campus_id, label, changes)
  values (
    v_actor,
    case when v_actor is null then public.actor_name() end,
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


-- ---------------------------------------------------------------------------
-- Past history. Stamps and history triggers are off while the names go in, so
-- this doesn't count as an edit or bump anything's "edited" time.
-- ---------------------------------------------------------------------------
update public.activity set actor_name = 'Claude' where actor_id is null and actor_name is null;

alter table public.devices disable trigger devices_stamp;
alter table public.devices disable trigger devices_activity;
alter table public.device_types disable trigger device_types_stamp;
alter table public.device_types disable trigger device_types_activity;

-- Added by: the row's "created" entry in history.
update public.devices d set created_by = null, created_by_name = 'Claude'
 where exists (select 1 from public.activity a where a.entity = 'devices' and a.entity_id = d.id and a.action = 'created' and a.actor_name = 'Claude');
update public.device_types t set created_by = null, created_by_name = 'Claude'
 where exists (select 1 from public.activity a where a.entity = 'device_types' and a.entity_id = t.id and a.action = 'created' and a.actor_name = 'Claude');

-- Edited by: the row's latest entry in history.
update public.devices d set updated_by = null, updated_by_name = 'Claude'
 where (select a.actor_name from public.activity a where a.entity = 'devices' and a.entity_id = d.id order by a.at desc, a.id desc limit 1) = 'Claude';
update public.device_types t set updated_by = null, updated_by_name = 'Claude'
 where (select a.actor_name from public.activity a where a.entity = 'device_types' and a.entity_id = t.id order by a.at desc, a.id desc limit 1) = 'Claude';

alter table public.devices enable trigger devices_stamp;
alter table public.devices enable trigger devices_activity;
alter table public.device_types enable trigger device_types_stamp;
alter table public.device_types enable trigger device_types_activity;
