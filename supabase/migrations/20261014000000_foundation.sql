-- =============================================================================
-- Upstate Church Production — foundation
--
-- Who people are, what they're allowed to see, and the first module:
-- the network / IP sheet (campuses → rooms → networks → devices → IPs).
--
-- Design rules every future table follows:
--   * Everything production-related carries `departments text[]`
--     (audio / video / lighting, validated against public.departments).
--   * Access is by role: pending < volunteer < contractor < staff < admin.
--     Gear and network data is staff-only. Volunteers will later see things
--     like service flows and training, never the equipment database.
--   * Every edit is stamped (created_by / updated_by) and written to
--     public.activity so the team can see who changed what.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('pending', 'volunteer', 'contractor', 'staff', 'admin');


-- ---------------------------------------------------------------------------
-- Departments: the production tags every item carries
-- ---------------------------------------------------------------------------
create table public.departments (
  slug        text primary key check (slug ~ '^[a-z][a-z0-9_]*$'),
  name        text not null,
  color       text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order  int  not null default 0
);

insert into public.departments (slug, name, color, sort_order) values
  ('audio',    'Audio',    '#4DA3FF', 1),
  ('video',    'Video',    '#A78BFA', 2),
  ('lighting', 'Lighting', '#F5B544', 3);


-- ---------------------------------------------------------------------------
-- Campuses
-- ---------------------------------------------------------------------------
create table public.campuses (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  short_name     text not null,
  code           text unique check (code ~ '^[A-Z0-9]{2,6}$'),
  pco_campus_id  text unique,                 -- Planning Center campus id, for later syncing
  street         text,
  city           text,
  state          text,
  ip_scheme      cidr,                        -- the campus block IT assigned, e.g. 10.2.0.0/16
  sort_order     int  not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- Profiles: one per login
-- ---------------------------------------------------------------------------
create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text not null,
  full_name       text not null default '',
  role            public.app_role not null default 'pending',
  departments     text[] not null default '{}',     -- which production teams they're on
  home_campus_id  uuid references public.campuses (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- Role helpers (security definer so policies can read profiles without
-- tripping over profiles' own policies)
-- ---------------------------------------------------------------------------
create function public.my_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select p.role from public.profiles p where p.id = auth.uid()),
    'pending'::public.app_role
  )
$$;

create function public.has_role(min_role public.app_role)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.my_role() >= min_role
$$;


-- ---------------------------------------------------------------------------
-- New logins get a profile. The very first person becomes admin;
-- everyone after that waits for an admin to approve them.
-- ---------------------------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('public.handle_new_user'));
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(new.email, ''), '@', 1)),
    case when exists (select 1 from public.profiles where role = 'admin')
         then 'pending'::public.app_role
         else 'admin'::public.app_role end
  );
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.handle_user_email_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.profiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.handle_user_email_change();


-- ---------------------------------------------------------------------------
-- Shared triggers
-- ---------------------------------------------------------------------------

-- Cleans and validates the `departments` tag list on any table.
-- Pass 'required' as the trigger argument when at least one tag is mandatory.
create function public.normalize_departments()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  bad      text;
  allowed  text;
  required boolean := coalesce(tg_argv[0], '') = 'required';
begin
  select coalesce(array_agg(x.d order by dep.sort_order nulls last, x.d), '{}')
    into new.departments
    from (select distinct lower(trim(d)) as d
            from unnest(coalesce(new.departments, '{}')) as d
           where nullif(trim(d), '') is not null) x
    left join public.departments dep on dep.slug = x.d;

  select string_agg(t, ', ') into bad
    from unnest(new.departments) t
   where not exists (select 1 from public.departments where slug = t);

  if bad is not null then
    select string_agg(slug, ', ' order by sort_order) into allowed from public.departments;
    raise exception 'Unknown tag "%". Tags are: %.', bad, allowed using errcode = '23514';
  end if;

  if required and cardinality(new.departments) = 0 then
    raise exception 'Tag it audio, video or lighting (at least one).' using errcode = '23514';
  end if;

  return new;
end
$$;

-- Fills created_by / updated_by / updated_at.
create function public.stamp()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end
$$;


-- ---------------------------------------------------------------------------
-- Profile guard: only admins change roles, teams and emails;
-- the last admin can't be demoted.
-- ---------------------------------------------------------------------------
create function public.guard_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'A profile''s id can''t change.' using errcode = '42501';
  end if;

  -- auth.uid() is empty for server-side work (SQL editor, the auth service).
  if auth.uid() is not null and not public.has_role('admin') then
    if new.role is distinct from old.role
       or new.departments is distinct from old.departments
       or new.email is distinct from old.email then
      raise exception 'Only an admin can change roles, teams or email addresses.' using errcode = '42501';
    end if;
  end if;

  if old.role = 'admin' and new.role <> 'admin'
     and not exists (select 1 from public.profiles where role = 'admin' and id <> old.id) then
    raise exception 'There has to be at least one admin. Make someone else an admin first.' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end
$$;

create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.guard_profile();

create trigger profiles_departments
  before insert or update of departments on public.profiles
  for each row execute function public.normalize_departments();


-- ---------------------------------------------------------------------------
-- Rooms: worship center, north auditorium, kids, lobby…
-- ---------------------------------------------------------------------------
create table public.rooms (
  id          uuid primary key default gen_random_uuid(),
  campus_id   uuid not null references public.campuses (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  unique (campus_id, name)
);


-- ---------------------------------------------------------------------------
-- Networks: subnets / VLANs per campus (Control, House, Dante, Art-Net…)
-- ---------------------------------------------------------------------------
create table public.networks (
  id            uuid primary key default gen_random_uuid(),
  campus_id     uuid not null references public.campuses (id) on delete cascade,
  name          text not null check (length(trim(name)) > 0),
  purpose       text,
  vlan_id       int check (vlan_id between 1 and 4094),
  subnet        cidr,
  gateway       inet,
  departments   text[] not null default '{}',
  is_isolated   boolean not null default false,   -- its own switches, not on the church LAN
  notes         text,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.profiles (id) on delete set null,
  updated_by    uuid references public.profiles (id) on delete set null,
  unique (campus_id, name)
);


-- ---------------------------------------------------------------------------
-- Devices: every piece of gear. Today it powers the IP sheet; later it's the
-- whole equipment database (cables, TVs, mics…) with the same tags.
-- ---------------------------------------------------------------------------
create table public.devices (
  id             uuid primary key default gen_random_uuid(),
  campus_id      uuid not null references public.campuses (id) on delete restrict,
  room_id        uuid references public.rooms (id) on delete set null,
  name           text not null check (length(trim(name)) > 0),   -- "FOH Switch", "Camera 2"
  departments    text[] not null default '{}',
  category       text,                                            -- Switch, Console, Camera…
  manufacturer   text,
  model          text,                                            -- "Cisco SG350-10"
  serial_number  text,
  firmware       text,                                            -- software version
  location       text,                                            -- FOH rack, stage rack, catwalk
  status         text not null default 'active'
                 check (status in ('active', 'spare', 'repair', 'retired')),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references public.profiles (id) on delete set null,
  updated_by     uuid references public.profiles (id) on delete set null
);

create index devices_campus_idx      on public.devices (campus_id);
create index devices_room_idx        on public.devices (room_id);
create index devices_departments_idx on public.devices using gin (departments);


-- ---------------------------------------------------------------------------
-- Device IPs: a device can have several (control, Dante primary/secondary…)
-- ---------------------------------------------------------------------------
create table public.device_ips (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references public.devices (id) on delete cascade,
  campus_id   uuid not null references public.campuses (id) on delete cascade,  -- copied from the device
  network_id  uuid references public.networks (id) on delete set null,
  label       text,                         -- "Control", "Dante Primary", "NDI"
  ip          inet,                         -- address + mask, e.g. 10.101.10.102/24; empty = unknown
  gateway     inet,
  mac         macaddr,
  hostname    text,
  mode        text not null default 'static' check (mode in ('static', 'reserved', 'dhcp')),
  notes       text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null
);

create index device_ips_device_idx  on public.device_ips (device_id);
create index device_ips_network_idx on public.device_ips (network_id);
create index device_ips_campus_ip   on public.device_ips (campus_id, host(ip));


-- ---------------------------------------------------------------------------
-- Device logins: kept in their own table so access can be tightened later
-- without touching the sheet. Never loaded in bulk; fetched per device.
-- ---------------------------------------------------------------------------
create table public.device_credentials (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references public.devices (id) on delete cascade,
  label       text,                         -- "Web UI", "Admin"
  username    text,
  password    text,
  notes       text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null
);

create index device_credentials_device_idx on public.device_credentials (device_id);


-- ---------------------------------------------------------------------------
-- Consistency triggers
-- ---------------------------------------------------------------------------
create function public.devices_check()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.room_id is not null
     and not exists (select 1 from public.rooms r where r.id = new.room_id and r.campus_id = new.campus_id) then
    raise exception 'That room is at a different campus.' using errcode = '23514';
  end if;
  return new;
end
$$;

create function public.devices_after_move()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  update public.device_ips
     set campus_id = new.campus_id,
         network_id = case when exists (select 1 from public.networks n
                                         where n.id = device_ips.network_id and n.campus_id = new.campus_id)
                           then network_id end
   where device_id = new.id;
  return null;
end
$$;

create function public.device_ips_check()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  select d.campus_id into new.campus_id from public.devices d where d.id = new.device_id;
  if new.network_id is not null
     and not exists (select 1 from public.networks n where n.id = new.network_id and n.campus_id = new.campus_id) then
    raise exception 'That network is at a different campus.' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger devices_departments before insert or update of departments on public.devices
  for each row execute function public.normalize_departments('required');
create trigger devices_check before insert or update of room_id, campus_id on public.devices
  for each row execute function public.devices_check();
create trigger devices_stamp before insert or update on public.devices
  for each row execute function public.stamp();
create trigger devices_moved after update of campus_id on public.devices
  for each row when (old.campus_id is distinct from new.campus_id)
  execute function public.devices_after_move();

create trigger networks_departments before insert or update of departments on public.networks
  for each row execute function public.normalize_departments();
create trigger networks_stamp before insert or update on public.networks
  for each row execute function public.stamp();

create trigger device_ips_check before insert or update on public.device_ips
  for each row execute function public.device_ips_check();
create trigger device_ips_stamp before insert or update on public.device_ips
  for each row execute function public.stamp();

create trigger device_credentials_stamp before insert or update on public.device_credentials
  for each row execute function public.stamp();


-- ---------------------------------------------------------------------------
-- Activity: who changed what, kept even after a device is deleted.
-- Passwords are never copied in here.
-- ---------------------------------------------------------------------------
create table public.activity (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   uuid references public.profiles (id) on delete set null,
  action     text not null check (action in ('created', 'updated', 'deleted')),
  entity     text not null,                -- table name
  entity_id  uuid not null,
  device_id  uuid,                         -- groups a device's IP and login changes with it
  campus_id  uuid references public.campuses (id) on delete set null,
  label      text,
  changes    jsonb not null default '{}'
);

create index activity_at_idx     on public.activity (at desc);
create index activity_device_idx on public.activity (device_id, at desc);
create index activity_campus_idx on public.activity (campus_id, at desc);

create function public.log_activity()
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
  if tg_table_name in ('device_ips', 'device_credentials') then
    skip := skip || array['device_id', 'campus_id'];
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
      continue when k = any(skip) or r -> k = 'null'::jsonb or r -> k = '[]'::jsonb;
      diff := diff || jsonb_build_object(k, case when k = 'password' then '"hidden"'::jsonb else r -> k end);
    end loop;
  end if;

  v_dev := case tg_table_name
             when 'devices' then (r ->> 'id')::uuid
             when 'device_ips' then (r ->> 'device_id')::uuid
             when 'device_credentials' then (r ->> 'device_id')::uuid
           end;

  v_camp := coalesce(
    (r ->> 'campus_id')::uuid,
    (select d.campus_id from public.devices d where d.id = v_dev)
  );

  v_label := case tg_table_name
               when 'devices' then r ->> 'name'
               when 'networks' then r ->> 'name'
               when 'device_ips' then coalesce(host((r ->> 'ip')::inet), r ->> 'label', 'IP')
               when 'device_credentials' then coalesce(nullif(r ->> 'label', ''), 'Login')
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

create trigger devices_activity after insert or update or delete on public.devices
  for each row execute function public.log_activity();
create trigger device_ips_activity after insert or update or delete on public.device_ips
  for each row execute function public.log_activity();
create trigger device_credentials_activity after insert or update or delete on public.device_credentials
  for each row execute function public.log_activity();
create trigger networks_activity after insert or update or delete on public.networks
  for each row execute function public.log_activity();


-- ---------------------------------------------------------------------------
-- IP conflicts: the same address twice at one campus on the same network
-- (or where either side has no network set).
-- ---------------------------------------------------------------------------
create view public.ip_conflicts with (security_invoker = on) as
select a.id            as device_ip_id,
       a.device_id,
       a.campus_id,
       host(a.ip)      as ip,
       b.id            as other_device_ip_id,
       b.device_id     as other_device_id
  from public.device_ips a
  join public.device_ips b
    on b.campus_id = a.campus_id
   and b.id <> a.id
   and host(b.ip) = host(a.ip)
   and (a.network_id is null or b.network_id is null or a.network_id = b.network_id)
 where a.ip is not null;


-- ---------------------------------------------------------------------------
-- save_device: saves a device with its IPs (and logins, when included)
-- in one step, so a half-saved device never happens.
-- ---------------------------------------------------------------------------
create function public.save_device(payload jsonb)
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
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.departments        enable row level security;
alter table public.campuses           enable row level security;
alter table public.profiles           enable row level security;
alter table public.rooms              enable row level security;
alter table public.networks           enable row level security;
alter table public.devices            enable row level security;
alter table public.device_ips         enable row level security;
alter table public.device_credentials enable row level security;
alter table public.activity           enable row level security;

-- Reference data: anyone approved can read; admins change it.
create policy "approved users read departments" on public.departments
  for select to authenticated using ((select public.has_role('volunteer')));
create policy "admins manage departments" on public.departments
  for all to authenticated
  using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));

create policy "approved users read campuses" on public.campuses
  for select to authenticated using ((select public.has_role('volunteer')));
create policy "admins manage campuses" on public.campuses
  for all to authenticated
  using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));

create policy "approved users read rooms" on public.rooms
  for select to authenticated using ((select public.has_role('volunteer')));
create policy "staff manage rooms" on public.rooms
  for all to authenticated
  using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));

-- Profiles: you see yourself; staff see the team; admins manage roles.
create policy "read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "staff read the team" on public.profiles
  for select to authenticated using ((select public.has_role('staff')));
create policy "update own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "admins update profiles" on public.profiles
  for update to authenticated
  using ((select public.has_role('admin'))) with check ((select public.has_role('admin')));

-- Gear and network data: staff only.
create policy "staff manage networks" on public.networks
  for all to authenticated
  using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));
create policy "staff manage devices" on public.devices
  for all to authenticated
  using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));
create policy "staff manage device ips" on public.device_ips
  for all to authenticated
  using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));
create policy "staff manage device logins" on public.device_credentials
  for all to authenticated
  using ((select public.has_role('staff'))) with check ((select public.has_role('staff')));

-- History: staff read; only the trigger writes.
create policy "staff read activity" on public.activity
  for select to authenticated using ((select public.has_role('staff')));


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


-- ---------------------------------------------------------------------------
-- Live updates: edits show up on everyone's screen without a refresh.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime
      add table public.devices, public.device_ips, public.networks, public.rooms, public.profiles;
  end if;
end
$$;
