-- Events: Planning Center services that are one-off events (Engage, a conference),
-- shown on their own page with a live view of where the service is.

-- Which services are events (an admin marks them in Settings › Planning Center).
alter table public.pco_service_types add column if not exists is_event boolean not null default false;

create or replace function public.pco_set_event(p_type text, p_on boolean)
returns void language plpgsql security definer set search_path to '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Only an admin can choose which services are events.' using errcode = '42501';
  end if;
  update public.pco_service_types set is_event = coalesce(p_on, false) where id = p_type;
end $$;
revoke all on function public.pco_set_event(text, boolean) from public, anon;
grant execute on function public.pco_set_event(text, boolean) to authenticated;

-- What Planning Center Live last said for a plan (its current item, who's driving, the
-- item times), read by the pco function at most every couple of seconds however many
-- screens are watching. Only the function reads and writes it.
create table if not exists public.pco_live_cache (
  plan_id text primary key,
  state jsonb not null default '{}'::jsonb,
  live_at timestamptz not null default 'epoch',  -- Live (current item) last read
  full_at timestamptz not null default 'epoch'   -- items, item times and plan times last read
);
alter table public.pco_live_cache enable row level security;
