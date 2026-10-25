-- =============================================================================
-- Live rosters. The sync runs every 30 seconds and re-reads only the plans
-- Planning Center changed (it bumps a plan's updated_at whenever anyone on it
-- is scheduled, removed, accepts or declines). When something changed it
-- touches pco_live, which open apps hear over realtime and reload.
-- Also: whether each scheduled person's invite email has gone out yet.
-- =============================================================================

alter table public.pco_plans add column pco_updated_at timestamptz;      -- Planning Center's updated_at when its roster was last read
alter table public.pco_plan_people add column invite_pending boolean not null default false; -- scheduled, invite email not sent yet

-- Background syncs don't show "Updating…"; one someone asked for does.
alter table public.pco_connection add column sync_by_user boolean not null default false;

create table public.pco_live (
  id          boolean primary key default true check (id),
  changed_at  timestamptz not null default now()
);
insert into public.pco_live default values;
alter table public.pco_live enable row level security;
create policy "signed in see when rosters changed" on public.pco_live for select to authenticated using (true);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.pco_live;
  end if;
end
$$;

create or replace function public.pco_status()
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
      'changed_at',      (select l.changed_at from public.pco_live l where l.id),
      'last_sync_error', case when public.has_role('staff') then c.last_sync_error end,
      'people_note',     case when public.has_role('staff') then c.people_note end,
      'syncing',         c.sync_by_user and c.sync_started_at is not null and c.sync_started_at > now() - interval '4 minutes')
    from public.pco_connection c)
  end
$$;

-- Every 30 seconds instead of every 15 minutes (each run is a handful of requests
-- unless something changed).
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'pco-sync'), schedule := '30 seconds');
