-- Planning Center: one church-wide connection that lives on the server.
--
-- Nobody connects their own Planning Center account. An admin pastes a
-- Planning Center personal access token once (Settings › Planning Center).
-- The `pco` edge function keeps the secret in Vault and copies services,
-- teams and rosters into the tables below every 15 minutes.
--
-- What each person sees is decided here, by their role in this app and by
-- which services an admin shares, never by their own Planning Center login:
--   access = 'everyone'  volunteers and up
--   access = 'staff'     staff and admins
--   access = 'hidden'    only admins (in Settings, to switch it on)
-- Within a shared service, only the teams an admin turns on (Broadcast, FOH…)
-- have their rosters copied and shown.

create extension if not exists pg_net;
create extension if not exists pg_cron;


-- ---------------------------------------------------------------------------
-- The connection. One row. The app can't read or change it (RLS on, no
-- policies); only the edge function, using the service role, can.
-- ---------------------------------------------------------------------------
create table public.pco_connection (
  id                boolean primary key default true check (id),
  app_id            text not null,
  secret_id         uuid not null,            -- vault.secrets row holding the token's secret
  cron_token        text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  org_name          text,
  time_zone         text not null default 'America/New_York',
  connected_as      text,                     -- the Planning Center person the token belongs to
  connected_by      uuid references public.profiles (id) on delete set null,
  connected_at      timestamptz not null default now(),
  weeks_ahead       int not null default 6 check (weeks_ahead between 1 and 26),
  sync_started_at   timestamptz,
  last_sync_at      timestamptz,
  last_full_sync_at timestamptz,
  last_sync_error   text,
  people_note       text                      -- why matching accounts to Planning Center people is off, if it is
);

alter table public.pco_connection enable row level security;


-- ---------------------------------------------------------------------------
-- What the sync copies in.
-- ---------------------------------------------------------------------------
create table public.pco_service_types (
  id               text primary key,          -- Planning Center's id
  name             text not null,
  path             text[] not null default '{}',   -- folders above it, top first
  campus_id        uuid references public.campuses (id) on delete set null,
  campus_set       boolean not null default false, -- an admin picked the location by hand
  access           text not null default 'hidden' check (access in ('hidden', 'staff', 'everyone')),
  access_set       boolean not null default false, -- an admin picked who sees it
  sequence         int,
  teams_synced_at  timestamptz,
  synced_at        timestamptz not null default now()
);

create table public.pco_teams (
  id               text primary key,
  service_type_id  text not null references public.pco_service_types (id) on delete cascade,
  name             text not null,
  positions        jsonb not null default '[]',    -- [{id, name, sequence}]
  shown            boolean not null default false,
  sequence         int,
  synced_at        timestamptz not null default now()
);
create index pco_teams_type_idx on public.pco_teams (service_type_id);

create table public.pco_plans (
  id               text primary key,
  service_type_id  text not null references public.pco_service_types (id) on delete cascade,
  title            text,
  series_title     text,
  dates            text,
  sort_date        timestamptz,
  times            jsonb not null default '[]',    -- [{name, kind: service|rehearsal|other, starts_at, ends_at}]
  needed           jsonb not null default '[]',    -- open spots on shown teams: [{team_id, position, quantity}]
  url              text,
  synced_at        timestamptz not null default now()
);
create index pco_plans_date_idx on public.pco_plans (sort_date);
create index pco_plans_type_idx on public.pco_plans (service_type_id);

-- Only people on shown teams are copied.
create table public.pco_plan_people (
  id         text primary key,
  plan_id    text not null references public.pco_plans (id) on delete cascade,
  team_id    text,
  person_id  text,
  name       text not null default '',
  position   text,
  status     text,           -- C confirmed, U not answered yet, D declined
  photo      text,
  synced_at  timestamptz not null default now()
);
create index pco_plan_people_plan_idx on public.pco_plan_people (plan_id);
create index pco_plan_people_person_idx on public.pco_plan_people (person_id);

-- Each login is matched to their Planning Center person by email, so the app
-- can show "you're on this Sunday".
alter table public.profiles
  add column pco_person_id  text,
  add column pco_checked_at timestamptz;


-- ---------------------------------------------------------------------------
-- Profiles: only an admin (or the server) can change who you are in
-- Planning Center. Same rules as before otherwise.
-- ---------------------------------------------------------------------------
create or replace function public.guard_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'A profile''s id can''t change.' using errcode = '42501';
  end if;

  -- auth.uid() is empty for server-side work (SQL editor, the auth service, edge functions).
  if auth.uid() is not null and not public.has_role('admin') then
    if new.role is distinct from old.role
       or new.departments is distinct from old.departments
       or new.email is distinct from old.email then
      raise exception 'Only an admin can change roles, teams or email addresses.' using errcode = '42501';
    end if;
    if new.pco_person_id is distinct from old.pco_person_id
       or new.pco_checked_at is distinct from old.pco_checked_at then
      raise exception 'Only an admin can change who you are in Planning Center.' using errcode = '42501';
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


-- ---------------------------------------------------------------------------
-- Who sees what
-- ---------------------------------------------------------------------------
create function public.pco_can_see(access text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case access
    when 'everyone' then public.has_role('volunteer')
    when 'staff'    then public.has_role('staff')
    else public.has_role('admin')
  end
$$;

create function public.my_pco_person_id()
returns text
language sql stable security definer set search_path = ''
as $$
  select p.pco_person_id from public.profiles p where p.id = auth.uid()
$$;

alter table public.pco_service_types enable row level security;
alter table public.pco_teams         enable row level security;
alter table public.pco_plans         enable row level security;
alter table public.pco_plan_people   enable row level security;

create policy "see shared services" on public.pco_service_types
  for select to authenticated using (public.pco_can_see(access));

create policy "see shown teams on shared services" on public.pco_teams
  for select to authenticated
  using ((shown or (select public.has_role('admin')))
         and exists (select 1 from public.pco_service_types st where st.id = service_type_id));

create policy "see plans of shared services" on public.pco_plans
  for select to authenticated
  using (exists (select 1 from public.pco_service_types st where st.id = service_type_id));

create policy "see rosters of shown teams" on public.pco_plan_people
  for select to authenticated
  using (exists (select 1 from public.pco_plans p where p.id = plan_id)
         and (exists (select 1 from public.pco_teams t where t.id = team_id and t.shown)
              or person_id = (select public.my_pco_person_id())));

grant select on public.pco_service_types, public.pco_teams, public.pco_plans, public.pco_plan_people to authenticated;
-- Changes from the app go through the admin-only functions below.


-- ---------------------------------------------------------------------------
-- For the app
-- ---------------------------------------------------------------------------

-- Connection status. Null when Planning Center isn't connected.
create function public.pco_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when not public.has_role('volunteer') then null else (
    select jsonb_build_object(
      'connected',       true,
      'org_name',        c.org_name,
      'time_zone',       c.time_zone,
      'connected_as',    case when public.has_role('staff') then c.connected_as end,
      'connected_at',    c.connected_at,
      'weeks_ahead',     c.weeks_ahead,
      'last_sync_at',    c.last_sync_at,
      'last_sync_error', case when public.has_role('staff') then c.last_sync_error end,
      'people_note',     case when public.has_role('staff') then c.people_note end,
      'syncing',         c.sync_started_at is not null and c.sync_started_at > now() - interval '4 minutes')
    from public.pco_connection c)
  end
$$;

create function public.pco_set_access(p_type text, p_access text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only an admin can choose who sees services.' using errcode = '42501';
  end if;
  if p_access not in ('hidden', 'staff', 'everyone') then
    raise exception 'Pick hidden, staff or everyone.' using errcode = '22023';
  end if;
  update public.pco_service_types set access = p_access, access_set = true where id = p_type;
end
$$;

create function public.pco_set_campus(p_type text, p_campus uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only an admin can change a service''s location.' using errcode = '42501';
  end if;
  update public.pco_service_types set campus_id = p_campus, campus_set = true where id = p_type;
end
$$;

-- Teams are switched on by name, so "Broadcast" is on for every service that has one.
create function public.pco_show_team(p_name text, p_shown boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only an admin can choose which teams show.' using errcode = '42501';
  end if;
  update public.pco_teams set shown = p_shown where lower(trim(name)) = lower(trim(p_name));
end
$$;

create function public.pco_set_weeks(p_weeks int)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only an admin can change this.' using errcode = '42501';
  end if;
  update public.pco_connection set weeks_ahead = greatest(1, least(26, p_weeks)) where id;
end
$$;

-- ---------------------------------------------------------------------------
-- For the server only (the edge function calls these with the service role)
-- ---------------------------------------------------------------------------
create function public.pco_is_server()
returns boolean
language sql stable set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
$$;

create function public.pco_save_connection(p jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  sid uuid;
begin
  if not public.pco_is_server() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  select v.id into sid from vault.secrets v where v.name = 'pco_secret_upstate_production';
  if sid is null then
    sid := vault.create_secret(p ->> 'secret', 'pco_secret_upstate_production',
                               'Planning Center personal access token (Upstate Production)');
  else
    perform vault.update_secret(sid, p ->> 'secret');
  end if;
  insert into public.pco_connection as c (id, app_id, secret_id, org_name, time_zone, connected_as, connected_by, connected_at)
  values (true, p ->> 'app_id', sid, p ->> 'org_name', coalesce(nullif(p ->> 'time_zone', ''), 'America/New_York'),
          p ->> 'connected_as', nullif(p ->> 'connected_by', '')::uuid, now())
  on conflict (id) do update set
    app_id = excluded.app_id, secret_id = excluded.secret_id, org_name = excluded.org_name,
    time_zone = excluded.time_zone, connected_as = excluded.connected_as, connected_by = excluded.connected_by,
    connected_at = now(), last_sync_error = null, sync_started_at = null;
end
$$;

-- Disconnecting: the secret is blanked here; the edge function then removes
-- the connection and the copied rosters. Which services and teams were
-- shared stays, so reconnecting picks up where it left off.
create function public.pco_forget_secret()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  sid uuid;
begin
  if not public.pco_is_server() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  select v.id into sid from vault.secrets v where v.name = 'pco_secret_upstate_production';
  if sid is not null then
    perform vault.update_secret(sid, '');
  end if;
end
$$;

create function public.pco_credentials()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  r jsonb;
begin
  if not public.pco_is_server() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  select jsonb_build_object(
           'app_id', c.app_id, 'secret', s.decrypted_secret, 'cron_token', c.cron_token,
           'weeks_ahead', c.weeks_ahead, 'time_zone', c.time_zone,
           'last_full_sync_at', c.last_full_sync_at, 'sync_started_at', c.sync_started_at)
    into r
    from public.pco_connection c
    left join vault.decrypted_secrets s on s.id = c.secret_id
   where c.id;
  return r;
end
$$;


-- ---------------------------------------------------------------------------
-- Keep it fresh: ask the edge function to sync every 15 minutes.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'pco-sync',
  '*/15 * * * *',
  $cron$
    select net.http_post(
      url := 'https://khmqzrxfidwhchmkgdfn.supabase.co/functions/v1/pco',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-pco-cron', c.cron_token),
      body := '{"action":"sync","source":"cron"}'::jsonb,
      timeout_milliseconds := 10000)
    from public.pco_connection c
    where c.id
  $cron$
);
