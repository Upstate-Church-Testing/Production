-- =============================================================================
-- Tally: no person's name in the app's settings. The Planning Center connection
-- no longer shows (or keeps) the name of whoever made the token.
-- =============================================================================

update public.pco_connection set connected_as = null where connected_as is not null;

create or replace function public.pco_status()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when not public.has_role('volunteer') then null else (
    select jsonb_build_object(
      'connected',       true,
      'org_name',        c.org_name,
      'time_zone',       c.time_zone,
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
