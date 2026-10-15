-- A Planning Center team can belong to more than one service type
-- (for example one team on both "Joy of Fellowship" and "Events").
alter table public.pco_teams add column service_type_ids text[] not null default '{}';
update public.pco_teams set service_type_ids = array[service_type_id] where service_type_ids = '{}';

alter policy "see shown teams on shared services" on public.pco_teams
  using ((shown or (select public.has_role('admin')))
         and exists (select 1 from public.pco_service_types st
                      where st.id = service_type_id or st.id = any(service_type_ids)));
