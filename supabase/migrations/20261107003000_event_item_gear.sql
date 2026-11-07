-- Events › Live: what each person in an event's flow is on (Amy Bray → VOX 4), entered
-- per event, and the gear that is when it's logged in Gear (the mic, an IEM pack). Live
-- shows the label next to the name; it opens the gear only when device_ids has some.
-- Not read from Planning Center notes: entered here on purpose, one event at a time.

create table if not exists public.event_item_gear (
  plan_id text not null,                      -- Planning Center plan
  item_id text not null,                      -- Planning Center item in that plan
  label text not null,                        -- what the crew calls it: VOX 4
  device_ids uuid[] not null default '{}',    -- the gear it is, when it's in Gear
  updated_at timestamptz not null default now(),
  primary key (plan_id, item_id)
);
alter table public.event_item_gear enable row level security;
create policy "staff see event gear" on public.event_item_gear
  for select to authenticated using (public.has_role('staff'));
