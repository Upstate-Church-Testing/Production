-- Software: what runs on each computer, and which version.
--
-- software            one row per title (ProPresenter, Companion, Desktop Video), with its
--                     maker and a logo (a file in icons/software/).
-- software_installs   a title on one item (a computer) at a version, with its build, the
--                     date that version was seen ("as of"), and notes.
--
-- A computer's operating system isn't here: it stays in devices.firmware ("macOS Tahoe
-- 26.1"), and Gear › Software reads it from there, so it's written in one place.
-- Staff only, like the gear itself. Changes are stamped and land in the item's history.

create table public.software (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  maker text check (maker is null or char_length(maker) <= 80),
  logo text check (logo is null or logo ~ '^[a-z0-9-]+\.(svg|png)$'),
  notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_by_name text,
  updated_by_name text
);
create unique index software_name_key on public.software (lower(btrim(name)));

create table public.software_installs (
  id uuid primary key default gen_random_uuid(),
  software_id uuid not null references public.software(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  version text not null check (char_length(btrim(version)) between 1 and 40),
  build text check (build is null or char_length(btrim(build)) between 1 and 60),
  seen_on date,
  notes text check (notes is null or char_length(notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_by_name text,
  updated_by_name text,
  unique (software_id, device_id)
);
create index software_installs_device on public.software_installs (device_id);

alter table public.software enable row level security;
alter table public.software_installs enable row level security;
create policy "staff manage software" on public.software for all to authenticated
  using ((select public.has_role('staff'::public.app_role))) with check ((select public.has_role('staff'::public.app_role)));
create policy "staff manage software installs" on public.software_installs for all to authenticated
  using ((select public.has_role('staff'::public.app_role))) with check ((select public.has_role('staff'::public.app_role)));

create trigger software_stamp before insert or update on public.software for each row execute function public.stamp();
create trigger software_installs_stamp before insert or update on public.software_installs for each row execute function public.stamp();
create trigger software_activity after insert or update or delete on public.software for each row execute function public.log_activity();
create trigger software_installs_activity after insert or update or delete on public.software_installs for each row execute function public.log_activity();

alter publication supabase_realtime add table public.software, public.software_installs;

-- History: a version change shows on the computer ("ProPresenter 22").
create or replace function public.log_activity()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
  if tg_table_name = 'software_installs' then
    skip := skip || array['device_id', 'software_id'];
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
             when 'software_installs' then (r ->> 'device_id')::uuid
           end;
  v_camp := coalesce((r ->> 'campus_id')::uuid, (select d.campus_id from public.devices d where d.id = v_dev));
  v_label := case tg_table_name
               when 'devices' then r ->> 'name'
               when 'networks' then r ->> 'name'
               when 'device_types' then r ->> 'name'
               when 'software' then r ->> 'name'
               when 'device_ips' then coalesce(host((r ->> 'ip')::inet), r ->> 'label', 'IP')
               when 'device_credentials' then coalesce(nullif(r ->> 'label', ''), 'Login')
               when 'device_ports' then coalesce((select p.name from public.device_type_ports p where p.id = (r ->> 'type_port_id')::uuid), 'Port')
               when 'software_installs' then coalesce((select s.name from public.software s where s.id = (r ->> 'software_id')::uuid), 'Software')
             end;
  insert into public.activity (actor_id, actor_name, action, entity, entity_id, device_id, campus_id, label, changes)
  values (v_actor, case when v_actor is null then public.actor_name() end,
    case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    tg_table_name, (r ->> 'id')::uuid, v_dev,
    case when exists (select 1 from public.campuses c where c.id = v_camp) then v_camp end,
    v_label, diff);
  return null;
end
$function$;
