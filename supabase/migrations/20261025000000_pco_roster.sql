-- =============================================================================
-- Which shared services make up Services › Roster. A service can be shared
-- (in the Services list and My schedule) without being on the roster grid:
-- Laurens and Union, and Simpsonville's Traditional, are left off it.
-- Set per service in Settings › Planning Center (admins). The sync never
-- touches it.
-- =============================================================================

alter table public.pco_service_types add column on_roster boolean not null default true;

create function public.pco_set_roster(p_type text, p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only an admin can choose what''s on the roster.' using errcode = '42501';
  end if;
  update public.pco_service_types set on_roster = coalesce(p_on, true) where id = p_type;
end
$$;
revoke execute on function public.pco_set_roster(text, boolean) from public, anon;
grant execute on function public.pco_set_roster(text, boolean) to authenticated;

-- Laurens, Union, and Simpsonville's Traditional service.
update public.pco_service_types set on_roster = false where id in ('1425669', '1582870', '131335');
